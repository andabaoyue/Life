/**
 * src/connections.js — ConnectionStore / Connection 管理（0.9.8 Z1-A/B/C/E/F/G）
 *
 * 定位（v1.1 Frozen Spec）：
 *   connections.json = 事务性、可更新的连接配置状态（create/update/delete/set-active/migration/rollback）
 *   ——不是 append-only。prevHash / recordHash / archiveSeq / anchor 等 hash-chain 语义
 *   专属 experiences / provenance（experiences-archive.js），绝不进入本文件。
 *
 * 四轴分离（硬边界）：
 *   Provider Identity ≠ Protocol ≠ Connection ≠ Model
 *   - providerId：Provider Identity（deepseek / local / custom / 未来 claude…），不猜品牌；
 *   - protocol：线协议，仅 'openai-compatible' | 'anthropic-native'（future explicit protocols 显式追加）；
 *     禁止把 cloud-direct / local / custom 写入 Connection.protocol（那是 provider/deployment policy 语义）；
 *   - connectionId：业务稳定主键（≠ credentialRef）；
 *   - models[] / activeModel：Model，挂 Connection，手填 model ID。
 *
 * credentialRef（v1.1 §②）：
 *   - 'cred:<namespaceKey>'，安全层引用，secret 本体只在 secure 层；
 *   - createConnection 强制生成全新独占 ref，拒绝调用方传入（不实现共享凭据）；
 *   - credentialOwnership: 'exclusive'（本连接独占）| 'legacy-mapped'（迁移自旧 providerId namespace，零搬移）；
 *   - 删除：exclusive 可联动删凭据；legacy-mapped 只删 Connection、不动 legacy 文件；
 *   - 共享 ref（手改 store 出现）→ 删除时防御性跳过凭据删除，绝不误删他连接凭据。
 *
 * capabilitySnapshot（v1.1 §③）：
 *   仅 persisted UI/cache 快照，不是 runtime trust source。
 *   runtime capability 只来自 Provider Registry → Adapter → 显式声明（assertCapability fail-closed）；
 *   用户写 streaming:true 等不授予任何 runtime 能力。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic');
const { validateCredentialTarget } = require('./provider-policy');
const {
  parseCredentialRef,
  isLegacyProtectedRef,
  deleteCredential,
  getCredential
} = require('./secure-credentials');

const STORE_FILE = 'connections.json';
const STORE_SCHEMA_VERSION = 1;
// 协议枚举（冻结）：future explicit protocols 在此显式追加，未知一律拒绝、绝不猜测
const PROTOCOLS = Object.freeze(['openai-compatible', 'anthropic-native']);
const OWNERSHIP = Object.freeze(['exclusive', 'legacy-mapped']);
const TEST_STATUS = Object.freeze(['unverified', 'verified', 'failed']);
const DEFAULT_CONNECTION_ID = 'conn-default';

function storePath(dir) {
  return path.join(dir, STORE_FILE);
}

function newConnectionId() {
  return 'conn-' + crypto.randomBytes(6).toString('hex');
}

/** 全新独占 credentialRef：不复用、不派生自 connectionId（两者语义不同） */
function newCredentialRef() {
  return 'cred:' + crypto.randomBytes(8).toString('hex');
}

function normalizeCapabilitySnapshot(caps) {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return null;
  const out = {};
  for (const [k, v] of Object.entries(caps)) out[k] = v;
  return out;
}

function normalizeTestState(ts) {
  const t = ts && typeof ts === 'object' ? ts : {};
  const status = TEST_STATUS.includes(t.status) ? t.status : 'unverified';
  return {
    status,
    lastTestedAt: Number.isFinite(t.lastTestedAt) ? t.lastTestedAt : null,
    phase: typeof t.phase === 'string' && t.phase.trim() ? t.phase.trim() : null,
    reason: typeof t.reason === 'string' && t.reason.trim() ? t.reason.trim() : null
  };
}

function normalizeModels(models, activeModel) {
  const list = Array.isArray(models)
    ? [...new Set(models.map((m) => String(m == null ? '' : m).trim()).filter(Boolean))]
    : [];
  let active = String(activeModel == null ? '' : activeModel).trim();
  if (!active && list.length > 0) active = list[0];
  if (active && !list.includes(active)) list.push(active);
  return { models: list, activeModel: active };
}

/**
 * Connection 结构校验（v1.1 §A）。返回 { ok, errors[] }。
 * 未知 protocol → 拒绝（不猜测）；未知 provider → 允许保存（Custom 语义），但 policy 组合必须合法。
 */
function validateConnection(conn) {
  const errors = [];
  if (!conn || typeof conn !== 'object' || Array.isArray(conn)) {
    return { ok: false, errors: ['CONNECTION_MUST_BE_OBJECT'] };
  }
  if (typeof conn.connectionId !== 'string' || !conn.connectionId.trim()) errors.push('CONNECTION_ID_REQUIRED');
  if (typeof conn.displayName !== 'string' || !conn.displayName.trim()) errors.push('DISPLAY_NAME_REQUIRED');
  if (typeof conn.providerId !== 'string' || !conn.providerId.trim()) errors.push('PROVIDER_ID_REQUIRED');
  if (typeof conn.protocol !== 'string' || !PROTOCOLS.includes(conn.protocol)) errors.push('PROTOCOL_NOT_SUPPORTED');

  // credentialRef 形态 + ownership 一致性
  if (!parseCredentialRef(conn.credentialRef)) errors.push('CREDENTIAL_REF_INVALID');
  if (!OWNERSHIP.includes(conn.credentialOwnership)) errors.push('CREDENTIAL_OWNERSHIP_INVALID');

  // endpoint：URL 合法 + provider policy 组合校验（与 config.sanitize 同一门禁）
  const urlOk = typeof conn.baseURL === 'string' && /^https?:\/\//i.test(conn.baseURL.trim());
  if (!urlOk) {
    errors.push('BASEURL_INVALID');
  } else if (typeof conn.providerId === 'string' && conn.providerId.trim()) {
    const credentialType = conn.providerId.trim().toLowerCase() === 'deepseek' ? 'deepseek-api-key' : 'apiKey';
    const policy = validateCredentialTarget({
      provider: conn.providerId.trim(),
      baseURL: conn.baseURL.trim(),
      credentialType
    });
    if (!policy.ok) {
      errors.push('PROVIDER_POLICY_REJECTED: ' + policy.error);
    } else if (policy.provider !== conn.providerId.trim()) {
      // B-02：provider 身份以 endpoint 为准；申报与端点推导不一致 -> fail-closed
      errors.push('PROVIDER_IDENTITY_MISMATCH: ' + policy.provider);
    }
  }

  // Model
  if (!Array.isArray(conn.models)) errors.push('MODELS_MUST_BE_ARRAY');
  if (typeof conn.activeModel !== 'string' || !conn.activeModel.trim()) errors.push('ACTIVE_MODEL_REQUIRED');
  else if (Array.isArray(conn.models) && conn.models.length > 0 && !conn.models.includes(conn.activeModel)) {
    errors.push('ACTIVE_MODEL_NOT_IN_MODELS');
  }

  // capabilitySnapshot 仅快照（允许任意 plain object / null），绝不参与 runtime 判定
  if (conn.capabilitySnapshot !== null && conn.capabilitySnapshot !== undefined &&
      (typeof conn.capabilitySnapshot !== 'object' || Array.isArray(conn.capabilitySnapshot))) {
    errors.push('CAPABILITY_SNAPSHOT_MUST_BE_OBJECT_OR_NULL');
  }
  if (!conn.testState || typeof conn.testState !== 'object') errors.push('TEST_STATE_REQUIRED');

  return { ok: errors.length === 0, errors };
}

function validateStore(store) {
  const errors = [];
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    return { ok: false, errors: ['STORE_MUST_BE_OBJECT'] };
  }
  if (store.schemaVersion !== STORE_SCHEMA_VERSION) errors.push('STORE_SCHEMA_VERSION_MISMATCH');
  if (!Array.isArray(store.connections)) {
    errors.push('STORE_CONNECTIONS_MUST_BE_ARRAY');
    return { ok: false, errors };
  }
  const ids = new Set();
  const refs = new Set();
  for (const c of store.connections) {
    const v = validateConnection(c);
    if (!v.ok) { errors.push(...v.errors.map((e) => (c && c.connectionId ? c.connectionId + ': ' : '') + e)); continue; }
    if (ids.has(c.connectionId)) errors.push('DUPLICATE_CONNECTION_ID: ' + c.connectionId);
    ids.add(c.connectionId);
    // 共享凭据本轮不实现：同一 credentialRef 不得出现在多个 Connection（防手改 store 引入误删面）
    if (refs.has(c.credentialRef)) errors.push('SHARED_CREDENTIAL_REF_NOT_ALLOWED: ' + c.credentialRef);
    refs.add(c.credentialRef);
  }
  // active 指针：有连接时必须指向存在的 connection；全删空后允许空串（store 合法、无活动连接）
  if (typeof store.activeConnectionId !== 'string') {
    errors.push('ACTIVE_CONNECTION_ID_REQUIRED');
  } else if (ids.size > 0 && !ids.has(store.activeConnectionId)) {
    errors.push('ACTIVE_CONNECTION_ID_NOT_FOUND: ' + store.activeConnectionId);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 读取 store。
 * @returns {{ok: boolean, status: 'absent'|'invalid'|'ok', store: object|null, error?: string}}
 *   absent = 文件不存在（可安全迁移）；invalid = 文件存在但非法（fail-closed，不得覆盖）。
 */
function loadStore(dir) {
  const file = storePath(dir);
  if (!fs.existsSync(file)) return { ok: true, status: 'absent', store: null };
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = validateStore(store);
    if (!v.ok) return { ok: false, status: 'invalid', store: null, error: 'STORE_INVALID: ' + v.errors.join('; ') };
    return { ok: true, status: 'ok', store };
  } catch (e) {
    return { ok: false, status: 'invalid', store: null, error: 'STORE_PARSE_FAILED: ' + e.message };
  }
}

/**
 * 事务性保存（v1.1：写前快照 → 原子写 → 回读校验 → 失败回滚快照）。
 * 单文件原子写天然无半成品；回滚针对"写成但校验不过"的可误用状态。
 */
function saveStore(dir, store) {
  const file = storePath(dir);
  const v = validateStore(store);
  if (!v.ok) return { ok: false, error: 'STORE_INVALID: ' + v.errors.join('; ') };
  let prev = null;
  let hadPrev = false;
  try {
    if (fs.existsSync(file)) { prev = JSON.parse(fs.readFileSync(file, 'utf8')); hadPrev = true; }
  } catch { prev = null; hadPrev = false; }
  try {
    writeJsonAtomic(file, store);
  } catch (e) {
    return { ok: false, error: 'STORE_WRITE_FAILED: ' + e.message };
  }
  try {
    const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rv = validateStore(reread);
    if (!rv.ok) throw new Error('reread invalid: ' + rv.errors.join('; '));
  } catch (e) {
    try {
      if (hadPrev && prev) writeJsonAtomic(file, prev);
      else fs.unlinkSync(file);
    } catch { /* 回滚失败也要如实报错 */ }
    return { ok: false, error: 'STORE_VERIFY_FAILED: ' + e.message };
  }
  return { ok: true, store };
}

function buildConnection(input, { connectionId, credentialRef, credentialOwnership }) {
  const { models, activeModel } = normalizeModels(input.models, input.activeModel || input.model);
  return {
    connectionId,
    displayName: String(input.displayName == null ? '' : input.displayName).trim(),
    providerId: String(input.providerId == null ? '' : input.providerId).trim(),
    protocol: String(input.protocol == null ? '' : input.protocol).trim(),
    baseURL: String(input.baseURL == null ? '' : input.baseURL).trim(),
    credentialRef,
    credentialOwnership,
    models,
    activeModel,
    capabilitySnapshot: normalizeCapabilitySnapshot(input.capabilitySnapshot),
    testState: normalizeTestState(input.testState)
  };
}

/** 事务：创建连接（全新独占 credentialRef；拒绝调用方指定 ref/id） */
function createConnection(dir, input = {}) {
  if (input.credentialRef !== undefined) {
    return { ok: false, error: 'CREDENTIAL_REF_MUST_BE_SERVER_GENERATED' };
  }
  if (input.connectionId !== undefined) {
    return { ok: false, error: 'CONNECTION_ID_MUST_BE_SERVER_GENERATED' };
  }
  if (input.credentialOwnership !== undefined) {
    return { ok: false, error: 'CREDENTIAL_OWNERSHIP_MUST_BE_SERVER_GENERATED' };
  }
  const connection = buildConnection(input, {
    connectionId: newConnectionId(),
    credentialRef: newCredentialRef(),
    credentialOwnership: 'exclusive'
  });
  const v = validateConnection(connection);
  if (!v.ok) return { ok: false, error: 'CONNECTION_INVALID: ' + v.errors.join('; ') };

  const loaded = loadStore(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const store = loaded.store || { schemaVersion: STORE_SCHEMA_VERSION, activeConnectionId: connection.connectionId, connections: [] };
  store.connections.push(connection);
  if (!store.activeConnectionId || !store.connections.some((c) => c.connectionId === store.activeConnectionId)) {
    store.activeConnectionId = connection.connectionId;
  }
  const saved = saveStore(dir, store);
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, connection, store: saved.store };
}

/** 事务：更新连接（connectionId / credentialRef / credentialOwnership 不可变） */
function updateConnection(dir, connectionId, patch = {}) {
  for (const k of ['connectionId', 'credentialRef', 'credentialOwnership']) {
    if (patch[k] !== undefined && patch[k] !== null) {
      return { ok: false, error: 'IMMUTABLE_FIELD: ' + k };
    }
  }
  const loaded = loadStore(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!loaded.store) return { ok: false, error: 'STORE_ABSENT' };
  const idx = loaded.store.connections.findIndex((c) => c.connectionId === connectionId);
  if (idx < 0) return { ok: false, error: 'CONNECTION_NOT_FOUND: ' + connectionId };
  const current = loaded.store.connections[idx];
  const { models, activeModel } = normalizeModels(
    patch.models !== undefined ? patch.models : current.models,
    patch.activeModel !== undefined ? patch.activeModel : current.activeModel
  );
  const next = {
    ...current,
    displayName: patch.displayName !== undefined ? String(patch.displayName).trim() : current.displayName,
    providerId: patch.providerId !== undefined ? String(patch.providerId).trim() : current.providerId,
    protocol: patch.protocol !== undefined ? String(patch.protocol).trim() : current.protocol,
    baseURL: patch.baseURL !== undefined ? String(patch.baseURL).trim() : current.baseURL,
    models,
    activeModel,
    capabilitySnapshot: patch.capabilitySnapshot !== undefined
      ? normalizeCapabilitySnapshot(patch.capabilitySnapshot) : current.capabilitySnapshot,
    testState: patch.testState !== undefined ? normalizeTestState(patch.testState) : current.testState
  };
  const v = validateConnection(next);
  if (!v.ok) return { ok: false, error: 'CONNECTION_INVALID: ' + v.errors.join('; ') };
  loaded.store.connections[idx] = next;
  const saved = saveStore(dir, loaded.store);
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, connection: next, store: saved.store };
}

/**
 * 事务：删除连接（v1.1 §② 删除语义）。
 * - legacy-mapped：只删 Connection，绝不删 legacy 文件；
 * - exclusive：opts.deleteCredential !== false 时联动删凭据；
 * - 防御：同 ref 被其他连接引用（手改 store）→ 跳过凭据删除，绝不误删。
 */
function deleteConnection(dir, connectionId, opts = {}) {
  const loaded = loadStore(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!loaded.store) return { ok: false, error: 'STORE_ABSENT' };
  const idx = loaded.store.connections.findIndex((c) => c.connectionId === connectionId);
  if (idx < 0) return { ok: false, error: 'CONNECTION_NOT_FOUND: ' + connectionId };
  const target = loaded.store.connections[idx];
  const remaining = loaded.store.connections.filter((c) => c.connectionId !== connectionId);

  // 先原子更新 store，再动凭据（凭据删除失败不回滚连接删除，如实上报）
  const next = { ...loaded.store, connections: remaining };
  if (next.activeConnectionId === connectionId) {
    next.activeConnectionId = remaining.length > 0 ? remaining[0].connectionId : '';
  }
  const saved = saveStore(dir, next);
  if (!saved.ok) return { ok: false, error: saved.error };

  let credentialDeleted = false;
  let credentialNote = null;
  const wantDelete = opts.deleteCredential !== false;
  const sharedWithOthers = remaining.some((c) => c.credentialRef === target.credentialRef);
  if (!wantDelete) {
    credentialNote = 'CREDENTIAL_KEPT_BY_REQUEST';
  } else if (target.credentialOwnership === 'legacy-mapped' || isLegacyProtectedRef(target.credentialRef)) {
    credentialNote = 'LEGACY_CREDENTIAL_KEPT';
  } else if (sharedWithOthers) {
    credentialNote = 'CREDENTIAL_SHARED_REF_KEPT'; // 共享凭据本轮不实现：手改 store 的防御兜底
  } else if (typeof opts.getCredential === 'function' || typeof opts.deleteCredentialFn === 'function' || opts.getSS !== undefined || opts.dir !== undefined) {
    const del = deleteCredential(target.credentialRef, { dir, getSS: opts.getSS });
    credentialDeleted = del.deleted === true;
    credentialNote = del.ok ? null : (del.error || 'CREDENTIAL_DELETE_FAILED');
  } else {
    credentialNote = 'CREDENTIAL_DELETE_NO_CONTEXT';
  }
  return { ok: true, store: saved.store, credentialDeleted, credentialNote, connection: target };
}

/** 事务：设置活动连接 */
function setActiveConnection(dir, connectionId) {
  const loaded = loadStore(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!loaded.store) return { ok: false, error: 'STORE_ABSENT' };
  if (!loaded.store.connections.some((c) => c.connectionId === connectionId)) {
    return { ok: false, error: 'CONNECTION_NOT_FOUND: ' + connectionId };
  }
  loaded.store.activeConnectionId = connectionId;
  const saved = saveStore(dir, loaded.store);
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, activeConnectionId: connectionId, store: saved.store };
}

/** capabilitySnapshot 来源：Registry 声明的缓存副本（仅快照；未知 → 全 false 的"未声明"快照） */
function capabilitySnapshotFor(providerId) {
  const unset = {
    streaming: false, usage: false, systemMessage: false,
    vision: false, tools: false, jsonMode: false, modelDiscovery: false, healthCheck: false
  };
  try {
    const info = require('./provider-registry').getProviderInfo(providerId);
    return info && info.capabilities ? { ...unset, ...info.capabilities } : unset;
  } catch {
    return unset;
  }
}

/**
 * Legacy Migration（Z1-E，零 secret 文件搬移）：
 * 旧平铺 cfg（apiKey/baseURL/provider/credentialType/model/modelVersion）
 *   → conn-default（credentialRef = 'cred:<原 providerId>'，credentialOwnership='legacy-mapped'）。
 * - secret 文件只读不写：ref 层映射，不搬、不复制、不提前删除（DeepSeek life-key/gpt-girl-key 语义不变）；
 * - 幂等：store 已存在且合法 → 原样返回 migrated:false；
 * - fail-closed：store 存在但非法 → 报错不动任何文件；写入失败/回读失败 → store 缺失或回滚，旧 flat cfg 仍是唯一真源。
 *
 * @returns {{ok: boolean, migrated?: boolean, store?: object, error?: string}}
 */
function migrateLegacyConfig(dir, flatCfg = {}) {
  const loaded = loadStore(dir);
  if (loaded.status === 'invalid') {
    return { ok: false, error: 'STORE_INVALID_FAIL_CLOSED: ' + (loaded.error || '') };
  }
  if (loaded.status === 'ok') {
    return { ok: true, migrated: false, store: loaded.store }; // 幂等
  }

  const providerId = String(flatCfg.provider == null ? '' : flatCfg.provider).trim() || 'custom';
  const { models, activeModel } = normalizeModels(
    [flatCfg.model], flatCfg.model
  );
  const connection = buildConnection({
    displayName: '默认连接',
    providerId,
    protocol: 'openai-compatible', // 现有全部 provider 均走 OpenAI 线协议（deepseek.js / openai-transport.js）
    baseURL: flatCfg.baseURL,
    models,
    activeModel,
    capabilitySnapshot: capabilitySnapshotFor(providerId),
    testState: null
  }, {
    connectionId: DEFAULT_CONNECTION_ID,
    // 零搬移：ref 的 namespaceKey 就是原 providerId —— keyPath 解析与今日逐字节一致
    credentialRef: 'cred:' + providerId,
    credentialOwnership: 'legacy-mapped'
  });
  const v = validateConnection(connection);
  if (!v.ok) {
    return { ok: false, error: 'LEGACY_CFG_INVALID: ' + v.errors.join('; ') };
  }
  const store = {
    schemaVersion: STORE_SCHEMA_VERSION,
    activeConnectionId: DEFAULT_CONNECTION_ID,
    connections: [connection]
  };
  const saved = saveStore(dir, store);
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, migrated: true, store: saved.store };
}

/** Z2-A：credentialType 归属（与 config.sanitize 同规则：DeepSeek 官方 key 类型独立） */
function credentialTypeFor(providerId) {
  return String(providerId == null ? '' : providerId).trim().toLowerCase() === 'deepseek'
    ? 'deepseek-api-key' : 'apiKey';
}

/** Z2-A：取当前活动 Connection（store 层） */
function getActiveConnection(dir) {
  const loaded = loadStore(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!loaded.store) return { ok: false, error: 'STORE_ABSENT' };
  const conn = loaded.store.connections.find((c) => c.connectionId === loaded.store.activeConnectionId);
  if (!conn) return { ok: false, error: 'ACTIVE_CONNECTION_NOT_FOUND' };
  return { ok: true, connection: conn };
}

/**
 * Z2-A：Connection → 现有 runtime cfg（仅运行时字段）。
 * 硬边界（Z2-E Subject Isolation）：displayName / connectionId / capabilitySnapshot /
 * testState 等 Connection 元数据一律不进 cfg —— 它们绝不能成为 Subject identity /
 * persona / context fact。其余全局参数（窗口/memoryCap/price/modelVersion 实验标签等）
 * 由调用方从旧 cfg 平移，不在本函数职责内。
 *
 * @returns {{ok:true, cfg:{provider,baseURL,credentialType,model,apiKey}} | {ok:false, error}}
 */
function resolveRuntimeCfg(connection, opts = {}) {
  if (!connection || typeof connection !== 'object') return { ok: false, error: 'CONNECTION_REQUIRED' };
  const v = validateConnection(connection);
  if (!v.ok) return { ok: false, error: 'CONNECTION_INVALID: ' + v.errors.join('; ') };
  // Z2-B：credential 不可用 -> fail-closed 拒绝解析（未验证 ≠ 可用）。
  // Z3：fallbackSecret（legacy 明文降级）只对 legacy-mapped ref 生效 ——
  // 绝不能让全局 fallback 把 A 的 key 写进 B（凭据串用）。
  const apiKey = getCredential(connection.credentialRef, {
    dir: opts.dir,
    getSS: opts.getSS,
    fallbackSecret: connection.credentialOwnership === 'legacy-mapped'
      ? (typeof opts.fallbackSecret === 'string' ? opts.fallbackSecret : '')
      : ''
  });
  if (!apiKey) return { ok: false, error: 'CREDENTIAL_UNAVAILABLE' };
  return {
    ok: true,
    cfg: {
      provider: connection.providerId,
      baseURL: connection.baseURL,
      credentialType: credentialTypeFor(connection.providerId),
      model: connection.activeModel,
      apiKey
    }
  };
}

module.exports = {
  STORE_FILE,
  STORE_SCHEMA_VERSION,
  PROTOCOLS,
  OWNERSHIP,
  TEST_STATUS,
  DEFAULT_CONNECTION_ID,
  storePath,
  validateConnection,
  validateStore,
  loadStore,
  saveStore,
  createConnection,
  updateConnection,
  deleteConnection,
  setActiveConnection,
  migrateLegacyConfig,
  capabilitySnapshotFor,
  credentialTypeFor,
  getActiveConnection,
  resolveRuntimeCfg
};
