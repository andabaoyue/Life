/**
 * src/local-probe.js — 本地端点零推理开销原生探活器（v2.2-c）
 *
 * 硬边界：
 * 1. D-001 零后台定时器：严禁 setInterval / setTimeout，仅在调用时按需单次探活（AbortSignal.timeout）。
 * 2. 严格回环 SSRF 守卫：仅允许 localhost / 127.0.0.1 / ::1 / [::1]，非回环地址直接返回 NON_LOCAL_HOST_REJECTED。
 * 3. 凭据隔离：探活请求不发送任何 Authorization / 云端 API Key，且 redirect: 'error' 阻断重定向跳出回环。
 * 4. 响应体硬上限：512KB，超时上限 4000ms，防异常本地端口 OOM 或挂起；异常不外抛。
 */
const { isLocalHost } = require('./provider-policy');
const { readBodyCapped } = require('./openai-transport');
const { redactSecrets } = require('./redact');

const MAX_PROBE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_TIMEOUT_MS = 4000;
const MIN_TIMEOUT_MS = 100;

function matchLocalModel(models, expectedModel) {
  if (!Array.isArray(models) || models.length === 0) return null;
  if (typeof expectedModel !== 'string' || !expectedModel.trim()) return null;
  const exp = expectedModel.trim().toLowerCase();
  const expBase = exp.replace(/:latest$/i, '');
  return models.some((m) => {
    const s = String(m || '').trim().toLowerCase();
    if (!s) return false;
    return s === exp || s.replace(/:latest$/i, '') === expBase;
  });
}

function classifyProbeError(err) {
  if (!err) return 'LOCAL_SERVER_UNREACHABLE';
  const name = String(err.name || '');
  const code = String(err.code || (err.cause && err.cause.code) || '');
  const msg = redactSecrets(String(err.message || ''));
  const causeMsg = redactSecrets(String((err.cause && err.cause.message) || ''));
  if (name === 'ResponseTooLargeError' || err.errorType === 'response_too_large') {
    return 'LOCAL_PROBE_RESPONSE_TOO_LARGE';
  }
  if (/redirect/i.test(msg) || /redirect/i.test(causeMsg) || /redirect/i.test(code)) {
    return 'LOCAL_PROBE_REDIRECT_BLOCKED';
  }
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    code === 'ABORT_ERR' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /timeout/i.test(msg)
  ) {
    return 'LOCAL_PROBE_TIMEOUT';
  }
  return 'LOCAL_SERVER_UNREACHABLE';
}

function makeProbeResult(partial = {}) {
  return {
    ok: Boolean(partial.ok),
    reachable: Boolean(partial.reachable),
    serverKind: partial.serverKind || 'unknown',
    models: Array.isArray(partial.models) ? partial.models : [],
    modelMatched: partial.modelMatched === undefined ? null : partial.modelMatched,
    reason: String(partial.reason || 'LOCAL_SERVER_UNREACHABLE')
  };
}

async function fetchCappedJson(url, timeoutMs, fetchImpl) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      ...(signal ? { signal } : {})
    });
  } catch (err) {
    return { fatalReason: classifyProbeError(err) };
  }

  let text = '';
  try {
    text = await readBodyCapped(res, MAX_PROBE_BYTES, { stage: 'local_probe' });
    if (Buffer.byteLength(text, 'utf8') > MAX_PROBE_BYTES) {
      return { fatalReason: 'LOCAL_PROBE_RESPONSE_TOO_LARGE' };
    }
  } catch (err) {
    return { fatalReason: classifyProbeError(err) };
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: res && typeof res.status === 'number' ? res.status : 0,
    ok: Boolean(res && res.ok),
    json
  };
}

/**
 * 仅针对回环本地端点执行零推理开销只读探活（Ollama /api/tags → OpenAI-local /models → /health）。
 * @param {string} baseURL
 * @param {{ timeoutMs?: number, expectedModel?: string, fetchImpl?: Function }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   reachable: boolean,
 *   serverKind: 'ollama' | 'openai-local' | 'unknown',
 *   models: string[],
 *   modelMatched: boolean | null,
 *   reason: string
 * }>}
 */
async function probeLocalEndpoint(baseURL, opts = {}) {
  const rawUrl = typeof baseURL === 'string' ? baseURL.trim() : '';
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return makeProbeResult({ reason: 'NON_LOCAL_HOST_REJECTED' });
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isLocalHost(u.hostname)) {
    return makeProbeResult({ reason: 'NON_LOCAL_HOST_REJECTED' });
  }

  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return makeProbeResult({ reason: 'LOCAL_SERVER_UNREACHABLE' });
  }

  const reqTimeout = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(reqTimeout)
    ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(reqTimeout)))
    : DEFAULT_TIMEOUT_MS;
  const expectedModel = typeof opts.expectedModel === 'string' ? opts.expectedModel.trim() : '';
  const normalizedBaseURL = rawUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');

  // Step 1: Ollama 原生 GET ${origin}/api/tags
  const tagsStep = await fetchCappedJson(`${u.origin}/api/tags`, timeoutMs, fetchImpl);
  if (tagsStep.fatalReason) {
    return makeProbeResult({ reason: tagsStep.fatalReason });
  }
  if (tagsStep.status === 200 && tagsStep.json && Array.isArray(tagsStep.json.models)) {
    const models = tagsStep.json.models
      .map((m) => (m && typeof m.name === 'string' ? m.name.trim() : ''))
      .filter(Boolean);
    const modelMatched = matchLocalModel(models, expectedModel);
    return makeProbeResult({
      ok: modelMatched !== false,
      reachable: true,
      serverKind: 'ollama',
      models,
      modelMatched,
      reason: modelMatched === false ? 'LOCAL_MODEL_NOT_FOUND' : 'OK'
    });
  }

  // Step 2: llama-server / 通用本地 OpenAI 端点 GET ${normalizedBaseURL}/models
  const modelsUrl = /\/models$/i.test(normalizedBaseURL)
    ? normalizedBaseURL
    : `${normalizedBaseURL}/models`;
  const modelsStep = await fetchCappedJson(modelsUrl, timeoutMs, fetchImpl);
  if (modelsStep.fatalReason) {
    return makeProbeResult({ reason: modelsStep.fatalReason });
  }
  if (modelsStep.status === 200 && modelsStep.json && Array.isArray(modelsStep.json.data)) {
    const models = modelsStep.json.data
      .map((m) => (m && typeof m.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean);
    const modelMatched = matchLocalModel(models, expectedModel);
    return makeProbeResult({
      ok: modelMatched !== false,
      reachable: true,
      serverKind: 'openai-local',
      models,
      modelMatched,
      reason: modelMatched === false ? 'LOCAL_MODEL_NOT_FOUND' : 'OK'
    });
  }

  // Step 3: 最小存活兜底 GET ${origin}/health
  const healthStep = await fetchCappedJson(`${u.origin}/health`, timeoutMs, fetchImpl);
  if (healthStep.fatalReason) {
    return makeProbeResult({ reason: healthStep.fatalReason });
  }
  if (healthStep.status === 200) {
    return makeProbeResult({
      ok: true,
      reachable: true,
      serverKind: 'openai-local',
      models: [],
      modelMatched: null,
      reason: 'OK'
    });
  }

  return makeProbeResult({ reason: 'LOCAL_PROBE_UNSUPPORTED_RESPONSE' });
}

module.exports = {
  probeLocalEndpoint,
  matchLocalModel,
  MAX_PROBE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS
};
