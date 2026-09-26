/**
 * Provider / Endpoint / Credential 边界（v0.9.1）。
 * 当前仍只支持 DeepSeek；该模块不发送请求，只用于阻止凭据边界继续模糊。
 */
const DEEPSEEK_HOSTS = new Set(['api.deepseek.com', 'api.deepseek.com.cn']);

function providerFor(baseURL) {
  try {
    const u = new URL(baseURL);
    if (DEEPSEEK_HOSTS.has(u.hostname)) return 'deepseek';
    return 'custom';
  } catch { return 'invalid'; }
}

function validateCredentialTarget({ provider, baseURL, credentialType = 'apiKey' } = {}) {
  const actual = provider || providerFor(baseURL);
  if (actual === 'deepseek' && credentialType !== 'deepseek-api-key')
    return { ok: false, error: 'DeepSeek endpoint 必须使用独立的 deepseek-api-key 凭据类型' };
  if (actual === 'custom' && credentialType === 'deepseek-api-key')
    return { ok: false, error: '自定义 Provider 不得复用 DeepSeek Key' };
  if (actual === 'invalid') return { ok: false, error: 'Endpoint URL 无效' };
  return { ok: true, provider: actual, credentialType };
}

module.exports = { DEEPSEEK_HOSTS, providerFor, validateCredentialTarget };
