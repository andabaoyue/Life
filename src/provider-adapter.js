/**
 * src/provider-adapter.js — Provider Adapter Contract（v0.9.8 P2-1/P2-3/P2-6）
 *
 * 三层边界（互不吞职责）：
 *   Provider Registry  →  选择哪个 adapter
 *   Provider Adapter   →  如何与这个 provider 通信
 *   Provider Policy    →  这个 provider + endpoint + credential 组合是否允许通信
 *
 * Adapter 不替代 provider-policy：所有真实网络请求继续通过 validateCredentialTarget() 既有安全门。
 * Adapter 也不是 runtime evidence 信任根：evidence mint authority 仍在 experiment-metadata
 * 内部接口中按受信 adapter 绑定，adapter 不得公开新的 mint API。
 *
 * Provider Type 是连接/能力类型，不是品牌：
 *   cloud-direct（官方云直连端点）/ openai-compatible（OpenAI 兼容线协议端点）/ local / custom
 * stable provider id（如 'deepseek'）由 Registry 管理，两者不混用。
 */

const { redactSecrets } = require('./redact');

const PROVIDER_TYPES = Object.freeze(['cloud-direct', 'openai-compatible', 'local', 'custom']);
const REQUIRED_ADAPTER_METHODS = Object.freeze(['complete', 'stream', 'validateConfig', 'capabilities', 'normalizeError', 'usage']);
const OPTIONAL_ADAPTER_METHODS = Object.freeze(['healthCheck']);

/** 连接/能力类型判定（不是品牌判定）。 */
function providerTypeFor(baseURL) {
  try {
    const u = new URL(String(baseURL));
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
    if (host === 'api.deepseek.com' || host === 'api.deepseek.com.cn') return 'cloud-direct';
    // 我们实现的远端线协议是 OpenAI-compatible；具体支持什么由 capabilities() 明确声明，
    // 绝不默认假设所有 openai-compatible 端点具备同样能力。
    return 'openai-compatible';
  } catch {
    return 'custom';
  }
}

/** 校验 adapter 实现了统一契约（不校验具体实现质量）。 */
function validateAdapterContract(adapter) {
  const missing = [];
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, missing: REQUIRED_ADAPTER_METHODS.slice() };
  }
  if (typeof adapter.providerId !== 'string' || !adapter.providerId.trim()) missing.push('providerId');
  for (const m of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[m] !== 'function') missing.push(m);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * capability fail-closed：未明确声明 true 的能力一律拒绝，调用前拦截、不发网络请求。
 */
function assertCapability(adapter, capability) {
  let caps = null;
  try { caps = adapter && typeof adapter.capabilities === 'function' ? adapter.capabilities() : null; } catch { caps = null; }
  if (!caps || caps[capability] !== true) {
    const err = new Error(`Unsupported capability: ${capability} (provider=${adapter && adapter.providerId})`);
    err.name = 'UnsupportedCapabilityError';
    err.retryable = false;
    err.errorType = 'unsupported_capability';
    err.requestStage = 'capability';
    throw err;
  }
}

/**
 * 统一错误形态（P1 raw body 边界继续成立）：
 * preserve status / provider / requestStage / retryable / errorType / retryState。
 * 已归一化的 ProviderError 原样保留；其余错误包成统一形态并过 redaction。
 */
function toUnifiedError(err, providerId) {
  if (err && err.name === 'ProviderError') return err;
  // 保持既有 API 行为兼容面：abort / timeout 语义原样透传，不重新包装
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return err;
  const e = new Error(redactSecrets(String((err && err.message) || err)));
  e.name = 'ProviderError';
  e.status = (err && err.status) ?? null;
  e.provider = providerId;
  e.requestStage = (err && err.requestStage) || 'unknown';
  e.retryable = Boolean(err && err.retryable);
  e.errorType = (err && err.errorType) || 'unknown_error';
  if (err && err.retryState) e.retryState = err.retryState;
  // 保持既有 API 兼容面：流中断的半截输出继续随错误上抛
  if (err && err.partial !== undefined) e.partial = err.partial;
  if (err) e.cause = err;
  return e;
}

module.exports = {
  PROVIDER_TYPES,
  REQUIRED_ADAPTER_METHODS,
  OPTIONAL_ADAPTER_METHODS,
  providerTypeFor,
  validateAdapterContract,
  assertCapability,
  toUnifiedError
};
