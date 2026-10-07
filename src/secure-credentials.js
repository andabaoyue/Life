/**
 * src/secure-credentials.js — credentialRef → Secure credential layer 最小 wrapper（0.9.8 Z1-D）
 *
 * 职责边界（v1.1 Frozen Spec §C）：
 *   Connection(credentialRef) → 本 wrapper → secure.js 现有 namespace/key-file 机制
 *
 * - connectionId ≠ credentialRef：本层只认 credentialRef（'cred:<namespaceKey>'），
 *   <namespaceKey> 直接作为 secure.js 各函数的 namespace 键（其形参名仍叫 providerId，语义已是 namespace 键）。
 * - secret 本体只由 secure 层管理；本 wrapper 不缓存、不记录、不输出 secret。
 * - 不重写 secure.js：credentialNamespace / legacyV0Namespace / legacyV0Claimants /
 *   keyPath / primaryKeyPath / encryptKey / decryptKey / dropKeyFile 全部原样复用。
 *
 * 明文降级（与全局"加密不可用时如实降级、桌宠必须还能跑"策略一致，见 secure.js 头部注释）：
 *   encryptKey 返回 false 时写入带格式前缀的明文文件（0600），并如实返回 encrypted:false；
 *   前缀保证与密文文件绝不混淆（decryptKey 对明文文件返回 null，本层再按前缀识别）。
 *
 * legacy 保护（v1.1 §②）：'cred:deepseek' 直指 life-key / gpt-girl-key 既有 legacy 文件，
 *   删除必须显式 allowLegacy，防止迁移/误操作毁掉用户既有凭据。
 */
const fs = require('fs');
const secure = require('./secure');
const { writeFileAtomic } = require('./atomic');

const SENSITIVE_FILE_MODE = 0o600;
const CREDENTIAL_REF_PREFIX = 'cred:';
const PLAINTEXT_PREFIX = 'plain:v1:';

/** credentialRef → { ref, key }；key 即 secure namespace 键。非法返回 null。 */
function parseCredentialRef(credentialRef) {
  const ref = String(credentialRef == null ? '' : credentialRef).trim();
  if (!ref.startsWith(CREDENTIAL_REF_PREFIX)) return null;
  const key = ref.slice(CREDENTIAL_REF_PREFIX.length).trim();
  if (!key) return null;
  return { ref, key };
}

/** 是否指向 deepseek legacy 命名空间（life-key / gpt-girl-key）——删除需显式 allowLegacy */
function isLegacyProtectedRef(credentialRef) {
  const p = parseCredentialRef(credentialRef);
  return !!p && secure.credentialNamespace(p.key) === 'deepseek';
}

/**
 * 读取 secret。
 * 解析顺序：secure 密文解密 → 本层明文降级文件（带前缀）→ 调用方显式提供的 fallbackSecret
 *（legacy 明文降级存在于 config.json 的场景由调用方传入，wrapper 不自行读 config）。
 * @returns {string|null}
 */
function getCredential(credentialRef, opts = {}) {
  const p = parseCredentialRef(credentialRef);
  if (!p || !opts.dir) return null;
  const viaSecure = secure.decryptKey(opts.getSS, opts.dir, p.key);
  if (viaSecure) return viaSecure;
  try {
    const raw = fs.readFileSync(secure.keyPath(opts.dir, p.key), 'utf8');
    if (typeof raw === 'string' && raw.startsWith(PLAINTEXT_PREFIX)) {
      return raw.slice(PLAINTEXT_PREFIX.length);
    }
  } catch { /* 无文件/不可读：继续走 fallback */ }
  const fb = typeof opts.fallbackSecret === 'string' ? opts.fallbackSecret : '';
  return fb || null;
}

/**
 * 写入 secret（新 namespace 或覆盖本 ref 独占槽位）。
 * @returns {{ok: boolean, encrypted: boolean, error?: string}}
 */
function setCredential(credentialRef, secret, opts = {}) {
  const p = parseCredentialRef(credentialRef);
  if (!p || !opts.dir) return { ok: false, encrypted: false, error: 'INVALID_CREDENTIAL_REF' };
  const key = String(secret == null ? '' : secret);
  if (!key) return { ok: false, encrypted: false, error: 'EMPTY_SECRET' };
  // 加密可用 -> 密文（复用 secure.encryptKey 的原子写 / 0600 语义）
  if (secure.encryptKey(opts.getSS, opts.dir, key, p.key)) {
    return { ok: true, encrypted: true };
  }
  // 明文降级：带格式前缀 + 0600，绝不静默冒充已加密
  try {
    writeFileAtomic(secure.primaryKeyPath(opts.dir, p.key), PLAINTEXT_PREFIX + key, { mode: SENSITIVE_FILE_MODE });
    return { ok: true, encrypted: false };
  } catch (e) {
    return { ok: false, encrypted: false, error: 'CREDENTIAL_WRITE_FAILED: ' + e.message };
  }
}

/** 是否已持有可用凭据（含显式 fallbackSecret 场景） */
function hasCredential(credentialRef, opts = {}) {
  return getCredential(credentialRef, opts) !== null;
}

/**
 * Z3：凭据存储形态描述（只回 present/encrypted 布尔，内容/路径永不出本函数）。
 * legacy 明文降级（config.json）场景由调用方显式提供 fallbackSecret，且仅对
 * legacy-mapped ref 提供（调用方负责限制，防 A 的 key 被误判为 B 的凭据）。
 */
function describeCredential(credentialRef, opts = {}) {
  const p = parseCredentialRef(credentialRef);
  if (!p || !opts.dir) return { present: false, encrypted: false };
  try {
    const kp = secure.keyPath(opts.dir, p.key);
    if (fs.existsSync(kp)) {
      const raw = fs.readFileSync(kp);
      const head = raw.slice(0, Buffer.byteLength(PLAINTEXT_PREFIX)).toString('utf8');
      return { present: true, encrypted: head !== PLAINTEXT_PREFIX };
    }
  } catch { /* 读不到按无凭据处理 */ }
  const fb = typeof opts.fallbackSecret === 'string' && opts.fallbackSecret !== '';
  return { present: fb, encrypted: false };
}

/**
 * 删除凭据。
 * legacy 保护：'cred:deepseek'（life-key/gpt-girl-key）默认拒绝删除，需 opts.allowLegacy === true。
 * @returns {{ok: boolean, deleted: boolean, error?: string}}
 */
function deleteCredential(credentialRef, opts = {}) {
  const p = parseCredentialRef(credentialRef);
  if (!p || !opts.dir) return { ok: false, deleted: false, error: 'INVALID_CREDENTIAL_REF' };
  if (isLegacyProtectedRef(credentialRef) && opts.allowLegacy !== true) {
    return { ok: false, deleted: false, error: 'LEGACY_CREDENTIAL_REFUSED' };
  }
  secure.dropKeyFile(opts.dir, p.key);
  const stillThere = (() => {
    try { return fs.existsSync(secure.keyPath(opts.dir, p.key)); } catch { return false; }
  })();
  return { ok: true, deleted: !stillThere, error: stillThere ? 'CREDENTIAL_FILE_REMAINS' : undefined };
}

/**
 * 迁移凭据到新 ref（复制 → 回读一致 → 保留旧文件，不过早删除）。
 * 注意：Legacy Migration 主路径是"零 secret 文件搬移"（ref 层映射），
 * 本函数仅在未来确需重挂 namespace 时使用。
 * @returns {{ok: boolean, encrypted?: boolean, legacyKept?: boolean, error?: string}}
 */
function migrateCredential(fromRef, toRef, opts = {}) {
  const src = getCredential(fromRef, opts);
  if (!src) return { ok: false, error: 'SOURCE_CREDENTIAL_MISSING' };
  const w = setCredential(toRef, src, opts);
  if (!w.ok) return { ok: false, error: 'TARGET_WRITE_FAILED: ' + (w.error || '') };
  const reread = getCredential(toRef, { dir: opts.dir, getSS: opts.getSS }); // 不给 fallback：必须真回读
  if (reread !== src) return { ok: false, error: 'MIGRATE_VERIFY_FAILED' };
  return { ok: true, encrypted: w.encrypted, legacyKept: true };
}

module.exports = {
  CREDENTIAL_REF_PREFIX,
  PLAINTEXT_PREFIX,
  parseCredentialRef,
  isLegacyProtectedRef,
  getCredential,
  setCredential,
  hasCredential,
  describeCredential,
  deleteCredential,
  migrateCredential
};
