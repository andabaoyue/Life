/**
 * Provider / Endpoint / Credential 边界。
 * 该模块只负责解析/约束 Provider、Endpoint 与 Credential 的组合，不发送请求。
 */
const DEEPSEEK_HOSTS = new Set(['api.deepseek.com', 'api.deepseek.com.cn']);

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isLinkLocalHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (/^169\.254\.\d+\.\d+$/.test(h) || h.startsWith('169.254.')) return true;
  if (h.startsWith('::ffff:169.254.')) return true;
  if (/^(?:::(?:0+:){0,4}|(?:0+:){5})ffff:(?:169\.254\.\d+\.\d+|a9fe:[0-9a-f]{1,4})$/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h) || h.startsWith('fe80::')) return true;
  return false;
}

function providerFor(baseURL) {
  try {
    const u = new URL(baseURL);
    if (DEEPSEEK_HOSTS.has(u.hostname)) return 'deepseek';
    if (isLocalHost(u.hostname)) return 'local';
    return 'custom';
  } catch { return 'invalid'; }
}

function validateCredentialTarget({ provider, baseURL, credentialType = 'apiKey' } = {}) {
  let u;
  try {
    u = new URL(baseURL);
  } catch {
    return { ok: false, error: 'Endpoint URL 无效' };
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'Endpoint 仅支持 HTTPS 或 HTTP 协议' };
  }

  if (isLinkLocalHost(u.hostname)) {
    return { ok: false, error: '禁止访问链路本地地址 (169.254.0.0/16 / fe80::)' };
  }

  const isLocal = isLocalHost(u.hostname);
  const isDeepSeekOfficial = DEEPSEEK_HOSTS.has(u.hostname);

  // 安全传输协议检查：除 localhost/127.0.0.1 本地端点允许 HTTP 外，公网端点严禁明文 HTTP
  if (u.protocol === 'http:' && !isLocal) {
    return { ok: false, error: '公网 Endpoint 必须使用 HTTPS 加密传输，禁止明文 HTTP' };
  }
  if (isDeepSeekOfficial && u.protocol !== 'https:') {
    return { ok: false, error: 'DeepSeek 官方 Endpoint 必须使用 HTTPS' };
  }

  // 凭据与 Provider 边界隔离：
  // 1. 访问 DeepSeek 官方 endpoint 时，必须使用独立的 deepseek-api-key 凭据类型
  if (isDeepSeekOfficial && credentialType !== 'deepseek-api-key') {
    return { ok: false, error: 'DeepSeek endpoint 必须使用独立的 deepseek-api-key 凭据类型' };
  }

  // 2. 非 DeepSeek 官方域名（含自定义 Provider 与 localhost）严禁携带 DeepSeek 官方专属 Key
  if (!isDeepSeekOfficial && credentialType === 'deepseek-api-key') {
    return { ok: false, error: '非 DeepSeek 官方 Endpoint 不得使用 DeepSeek 专属 Key' };
  }

  // B-02: effectiveProvider 必须以实际 baseURL 解析结果为准 ——
  // 第三方端点不得被判定为 'deepseek'（Provider 身份冒用拦截）
  const effectiveProvider = isDeepSeekOfficial
    ? 'deepseek'
    : (isLocal ? 'local' : (provider && provider !== 'deepseek' ? provider : 'custom'));
  return { ok: true, provider: effectiveProvider, credentialType };
}

module.exports = { DEEPSEEK_HOSTS, providerFor, validateCredentialTarget, isLocalHost };
