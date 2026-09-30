/**
 * src/connection-test.js — Test Connection（0.9.8 Z3-B）
 *
 * Test Connection ≠ healthCheck：
 *   healthCheck 是 adapter 的可选能力（provider-adapter.js OPTIONAL）。
 *   本模块只在用户显式调用时运行（禁止启动/后台/activate 自动 authProbe）：
 *
 *   validateConfig → provider-specific healthCheck（若 adapter 声明）
 *                  → 最小 authenticated request（无 healthCheck 且 protocol 支持安全最小探测时）
 *
 * 三态语义（严格）：
 *   verified   = 实际完成了足够的远端验证（healthCheck 通过或 authProbe 成功）
 *   failed     = 明确验证失败（401/403/auth 拒绝、4xx 拒绝、网络拒绝、healthCheck 失败）
 *   unverified = 证据不足（healthCheck 未实现且无法探测、探测超时/不确定、adapter 不可用）
 *   「healthCheck 未实现」本身绝不判 failed、绝不伪造成功。
 */
const { loadStore, validateConnection, resolveRuntimeCfg } = require('./connections');
const { createAdapter, getProviderInfo } = require('./provider-registry');

// 支持"安全最小认证探测"的协议（OpenAI-compatible：单次极小 max_tokens 的 chat 请求）
const PROBE_PROTOCOLS = new Set(['openai-compatible']);
const PROBE_TIMEOUT_MS = 8000;

/** 探测错误 → 三态分类：只有一锤定音的结论才判 verified/failed，其余 unverified */
function classifyTestError(err) {
  if (!err) return { status: 'unverified', reason: 'PROBE_INCONCLUSIVE' };
  const name = String(err.name || '');
  const type = String(err.errorType || '');
  const status = err.status;
  const code = err.code || (err.cause && err.cause.code);
  if (type === 'auth_failed' || status === 401 || status === 403) return { status: 'failed', reason: 'AUTH_REJECTED' };
  if (status === 400 || status === 404 || type === 'request_rejected') return { status: 'failed', reason: 'REQUEST_REJECTED' };
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || type === 'network_error') {
    return { status: 'failed', reason: 'NETWORK_REFUSED' };
  }
  if (name === 'TimeoutError') return { status: 'unverified', reason: 'PROBE_TIMEOUT' };
  return { status: 'unverified', reason: 'PROBE_INCONCLUSIVE' };
}

/**
 * @returns {Promise<{ok: boolean, status?: 'verified'|'failed'|'unverified',
 *                    phase?: string, reason?: string, error?: string}>}
 */
async function runConnectionTest(dir, connectionId, opts = {}) {
  const loaded = loadStore(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!loaded.store) return { ok: false, error: 'STORE_ABSENT' };
  const conn = loaded.store.connections.find((c) => c.connectionId === connectionId);
  if (!conn) return { ok: false, error: 'CONNECTION_NOT_FOUND: ' + connectionId };

  // ---- Phase 1: validateConfig（结构 + endpoint/credential policy + adapter 配置完整性）----
  const v = validateConnection(conn);
  if (!v.ok) return { ok: true, status: 'failed', phase: 'validateConfig', reason: v.errors.join('; ') };
  const resolved = resolveRuntimeCfg(conn, {
    dir, getSS: opts.getSS,
    fallbackSecret: conn.credentialOwnership === 'legacy-mapped' ? (opts.fallbackSecret || '') : ''
  });
  if (!resolved.ok) return { ok: true, status: 'failed', phase: 'validateConfig', reason: resolved.error };

  // adapter 只认 Registry 显式登记；未登记 -> 无法远端验证（unverified，不伪造结论）
  if (!getProviderInfo(conn.providerId)) {
    return { ok: true, status: 'unverified', phase: 'validateConfig', reason: 'ADAPTER_NOT_REGISTERED: ' + conn.providerId };
  }
  let adapter;
  try {
    const cfg = { ...resolved.cfg, requestTimeoutMs: PROBE_TIMEOUT_MS, streamIdleTimeoutMs: PROBE_TIMEOUT_MS };
    adapter = createAdapter(conn.providerId, cfg);
    const vc = adapter.validateConfig();
    if (!vc.ok) return { ok: true, status: 'failed', phase: 'validateConfig', reason: vc.problems.join('; ') };
  } catch (e) {
    return { ok: true, status: 'unverified', phase: 'validateConfig', reason: 'ADAPTER_UNAVAILABLE: ' + e.message };
  }

  // ---- Phase 2: provider-specific healthCheck（仅当 adapter 显式声明）----
  if (typeof adapter.healthCheck === 'function') {
    try {
      const h = await adapter.healthCheck();
      if (h && h.ok !== false) return { ok: true, status: 'verified', phase: 'healthCheck' };
      return { ok: true, status: 'failed', phase: 'healthCheck', reason: 'HEALTHCHECK_FAILED' };
    } catch (e) {
      return { ok: true, status: 'failed', phase: 'healthCheck', reason: 'HEALTHCHECK_FAILED: ' + e.message };
    }
  }
  // healthCheck 未实现 ≠ failed：继续按协议决定是否可安全探测

  // ---- Phase 3: 最小 authenticated request（仅用户显式触发本函数时才会发生）----
  if (!PROBE_PROTOCOLS.has(conn.protocol)) {
    return { ok: true, status: 'unverified', phase: 'validateConfig', reason: 'NO_PROBE_FOR_PROTOCOL: ' + conn.protocol };
  }
  try {
    await adapter.complete([{ role: 'user', content: 'ping' }], { maxTokens: 1, temperature: 0 });
    return { ok: true, status: 'verified', phase: 'authProbe' };
  } catch (e) {
    const c = classifyTestError(e);
    return { ok: true, status: c.status, phase: 'authProbe', reason: c.reason };
  }
}

module.exports = { runConnectionTest, classifyTestError, PROBE_PROTOCOLS };
