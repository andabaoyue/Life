/**
 * src/stt-transport.js — 语音转文字（STT）传输层（v1.7-a 第 3 步）
 *
 * ## 定位
 *   **纯净的 OpenAI Whisper 兼容客户端**：不绑定任何厂商。
 *   主流供应商（OpenAI / Groq / 硅基流动 / 本地 fast-whisper）在语音转写上
 *   几乎都遵循同一个 `/v1/audio/transcriptions` + multipart 规范，
 *   所以传输层只需要接受标准端点与表单字段，厂商差异交给配置。
 *
 * ## 为什么 STT 必须与对话凭据物理隔离
 *   🔴 实测（2026-10-19 审计）：**DeepSeek 官方没有 STT 端点**
 *   （`src/deepseek.js` / `src/adapters/deepseek-adapter.js` grep `audio|transcri` 零命中；
 *   官方仅 `/v1/chat/completions` + `/v1/models`）。
 *   因此 STT 用**独立的 endpoint + apiKey**，绝不复用对话连接的 Key。
 *   本模块的入参里**不出现任何 connections 对象**，门禁对此有断言。
 *
 * ## 三条硬约束
 *   1. **绝不抛**：所有失败都归成 `{ ok:false, errorType }`，调用方不需要 try/catch。
 *   2. **音频绝不落盘**：buffer 只在内存里转成 Blob 送走，本模块不写任何文件。
 *   3. **不记内容**：错误信息里绝不带音频字节、识别文本、完整 Key。
 *
 * ## 为什么复用 provider-policy 的协议判据
 *   `validateCredentialTarget` 已经定义了「什么端点可以收凭据」：
 *   公网必须 HTTPS，localhost/127.0.0.1 允许明文。STT 沿用同一判据，
 *   避免出现「对话端点有校验、STT 端点裸奔」的第二套安全模型。
 */

const path = require('path');

/** 单次上传的最大音频字节数。超过直接拒，不截断（截断会让识别结果变形）。 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;   // 25MB，与 OpenAI Whisper 上限对齐

/** 默认超时。识别是短任务，超过这个时间基本可以判定链路异常。 */
const DEFAULT_TIMEOUT_MS = 30 * 1000;

/** 支持的语言码白名单（用户已定：先中英两版） */
const SUPPORTED_LANGS = Object.freeze(['zh', 'en']);

/** 常见的音频 MIME 与文件扩展名映射（multipart 的 filename 影响部分服务端解析） */
const MIME_EXT = Object.freeze({
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/flac': 'flac'
});

/**
 * 把任意失败归成统一形状。**绝不抛**。
 * @param {string} errorType
 * @param {string} [detail] 允许进日志的安全细节（不含音频/文本/密钥）
 */
function fail(errorType, detail) {
  return {
    ok: false,
    errorType,
    // safeDetail 只用于审计日志；渲染层只按 errorType 取 i18n 文案
    safeDetail: typeof detail === 'string' ? detail.slice(0, 200) : null
  };
}

/**
 * 校验配置。任何一项不合格都返回具体原因，**不猜、不补默认端点**。
 *
 * @param {object} cfg { endpoint, apiKey, model, lang }
 * @returns {{ok:true, cfg:object} | {ok:false, errorType:string, detail?:string}}
 */
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, errorType: 'not_configured' };

  const endpoint = typeof cfg.endpoint === 'string' ? cfg.endpoint.trim() : '';
  if (!endpoint) return { ok: false, errorType: 'not_configured' };

  // 协议与主机判据复用既有安全模型（公网必须 HTTPS，本地允许明文）
  let u;
  try {
    u = new URL(endpoint);
  } catch (e) {
    return { ok: false, errorType: 'bad_endpoint', detail: 'URL 解析失败' };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, errorType: 'bad_endpoint', detail: '协议必须是 http(s)' };
  }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol === 'http:' && !isLocal) {
    // 与 provider-policy 同口径：公网明文 HTTP 一律拒
    return { ok: false, errorType: 'insecure_endpoint', detail: '公网端点必须使用 HTTPS' };
  }

  const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (!apiKey) return { ok: false, errorType: 'not_configured', detail: '缺少 STT 密钥' };

  const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : '';
  if (!model) return { ok: false, errorType: 'not_configured', detail: '缺少模型名' };

  const lang = typeof cfg.lang === 'string' ? cfg.lang.trim().toLowerCase() : '';
  if (lang && !SUPPORTED_LANGS.includes(lang)) {
    return { ok: false, errorType: 'bad_lang', detail: '仅支持 zh / en' };
  }

  return { ok: true, cfg: { endpoint, apiKey, model, lang: lang || '' } };
}

/**
 * 把 HTTP 状态码映射成稳定分类。
 * 与 `openai-transport.classifyProviderHttpError` 保持同一套词汇，
 * 便于上层用同一份 i18n 文案。
 *
 * @param {number} status
 * @returns {string} errorType
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 413) return 'audio_too_large';
  if (status === 415) return 'unsupported_audio';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'request_rejected';
  return 'http_error';
}

/**
 * 从响应体里尽量取到识别文本。
 *
 * 为什么容错这么宽：各家在 `response_format=json` 下都返回 `{ text }`，
 * 但本地 whisper.cpp 有时直接返回纯文本。两种都接受，
 * **但空文本一律视为失败** —— 空串不是"识别出了空"，是"没识别出来"。
 *
 * @param {string} raw 响应原文
 * @param {string} contentType
 * @returns {string|null}
 */
function extractText(raw, contentType) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // JSON 形态：{"text":"..."}
  if (/json/i.test(contentType || '') || trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      if (j && typeof j.text === 'string' && j.text.trim()) return j.text.trim();
      return null;
    } catch (e) {
      // 声明是 JSON 但解析不了 → 退回纯文本处理（个别服务端会骗 content-type）
    }
  }
  return trimmed;
}

/**
 * 执行一次语音识别。
 *
 * @param {object} input
 * @param {Buffer|Uint8Array} input.audio  音频字节（**只在内存**，本函数不落盘）
 * @param {string} input.mimeType  audio/webm 等
 * @param {object} input.cfg       { endpoint, apiKey, model, lang }
 * @param {Function} [input.fetchImpl] 测试注入用（默认全局 fetch）
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{ok:true, text:string, elapsedMs:number, model:string} | {ok:false, errorType:string, safeDetail?:string}>}
 *          **永不 reject**
 */
async function transcribe(input) {
  const started = Date.now();
  const req = input || {};

  /* ---- 1. 配置校验 ---- */
  const v = validateConfig(req.cfg);
  if (!v.ok) return fail(v.errorType, v.detail);
  const cfg = v.cfg;

  /* ---- 2. 音频校验（不做任何"修复"）---- */
  const buf = req.audio;
  if (!buf || (typeof buf.length !== 'number')) return fail('no_audio');
  if (buf.length === 0) return fail('no_audio');
  if (buf.length > MAX_AUDIO_BYTES) return fail('audio_too_large', 'len=' + buf.length);

  const rawMime = typeof req.mimeType === 'string' && req.mimeType.trim()
    ? req.mimeType.trim().toLowerCase() : 'audio/webm';
  /* 🔴 2026-10-20 真机 bug：浏览器给的 MIME 带参数。
   *
   *   MediaRecorder 实际返回的是 `audio/webm;codecs=opus`，不是 `audio/webm`。
   *   原实现直接拿整串去查 MIME_EXT，查不到 ⇒ 判成 unsupported_audio，
   *   于是「录了 4.8 秒 / 72KB 音频」被自己拒掉，用户看到的是"什么都没识别出来"。
   *
   *   修法：**剥掉分号参数再查表**。`;codecs=opus` 只是编码提示，
   *   不改变容器格式（webm 就是 webm），Blob 的 MIME 仍然带原串，
   *   这样服务端也能拿到完整的类型信息。
   */
  const baseMime = rawMime.split(';')[0].trim();
  const ext = MIME_EXT[baseMime];
  if (!ext) return fail('unsupported_audio', 'mime=' + rawMime.slice(0, 40));
  const mime = rawMime;   // 发给服务端时保留完整类型（含 codecs）

  /* ---- 3. 组 multipart（Node 24 原生 FormData + Blob，零新增依赖）---- */
  let form;
  try {
    form = new FormData();
    // ⚠️ 用 Uint8Array 包一层：某些运行时对 Buffer 直接进 Blob 的行为不一致
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    form.append('file', new Blob([bytes], { type: mime }), 'audio.' + ext);
    form.append('model', cfg.model);
    form.append('response_format', 'json');
    // 语言只在显式指定时传：不传让服务端自动判定，比传错语言更好
    if (cfg.lang) form.append('language', cfg.lang);
  } catch (e) {
    return fail('build_request_failed', String(e && e.message || e).slice(0, 120));
  }

  /* ---- 4. 发起请求（带超时；不跟随不安全重定向由 fetch 默认处理）---- */
  const fetchImpl = typeof req.fetchImpl === 'function' ? req.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return fail('fetch_unavailable');

  const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
    ? req.timeoutMs : DEFAULT_TIMEOUT_MS;

  let res;
  try {
    res = await fetchImpl(cfg.endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.apiKey },
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    const name = e && e.name;
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout');
    // 网络层失败：只记错误名，绝不把可能含 URL/凭据的消息带出去
    return fail('network', name || 'network');
  }

  /* ---- 5. 读响应 ---- */
  let raw = '';
  try {
    raw = await res.text();
  } catch (e) {
    return fail('read_failed');
  }

  if (!res.ok) {
    // 服务端错误体可能很长，只留前 200 字；它不含我们的音频或 Key
    return fail(classifyStatus(res.status), 'HTTP ' + res.status);
  }

  /* ---- 6. 取文本 ---- */
  const text = extractText(raw, res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('content-type') : '');
  if (!text) return fail('empty_result');

  return {
    ok: true,
    text,
    elapsedMs: Date.now() - started,
    model: cfg.model
  };
}

module.exports = {
  transcribe,
  validateConfig,
  classifyStatus,
  extractText,
  MAX_AUDIO_BYTES,
  DEFAULT_TIMEOUT_MS,
  SUPPORTED_LANGS,
  MIME_EXT
};
