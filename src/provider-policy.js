/**
 * Provider / Endpoint / Credential 边界（v0.9.1）。
 * 当前仍只支持 DeepSeek；该模块不发送请求，只用于阻止凭据边界继续模糊。
 */
const DEEPSEEK_HOSTS = new Set(['api.deepseek.com', 'api.deepseek.com.cn']);

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
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

  // 2. 公网非 DeepSeek 自定义 Provider 严禁携带 DeepSeek 官方专属 Key（防凭据向第三方泄露）
  if (!isDeepSeekOfficial && !isLocal && credentialType === 'deepseek-api-key') {
    return { ok: false, error: '自定义 Provider 不得复用 DeepSeek Key' };
  }

  // B-02: effectiveProvider 必须以实际 baseURL 解析结果为准 ——
  // 第三方端点不得被判定为 'deepseek'（Provider 身份冒用拦截）
  const effectiveProvider = isDeepSeekOfficial
    ? 'deepseek'
    : (isLocal ? 'local' : (provider && provider !== 'deepseek' ? provider : 'custom'));
  return { ok: true, provider: effectiveProvider, credentialType };
}

module.exports = { DEEPSEEK_HOSTS, providerFor, validateCredentialTarget, isLocalHost };
