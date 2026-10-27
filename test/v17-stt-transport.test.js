/**
 * test/v17-stt-transport.test.js
 *
 * v1.7-a 第 3 步门禁：**STT 传输层**（OpenAI Whisper 兼容）。
 *
 * ## 为什么 STT 必须独立于对话链路
 *   🔴 实测（2026-10-19 审计）：**DeepSeek 官方没有 STT 端点**。
 *   `src/deepseek.js` / `src/adapters/deepseek-adapter.js` grep `audio|transcri` 零命中，
 *   官方仅 `/v1/chat/completions` + `/v1/models`。
 *   所以 STT 用**独立的 endpoint + apiKey**，绝不复用对话连接的 Key ——
 *   否则用户会以为"填了对话 Key 就能说话"，然后在 401/404 上困惑。
 *
 * ## 三条硬约束（各有独立断言）
 *   1. **绝不抛**：任何失败都归成 `{ ok:false, errorType }`；
 *   2. **音频绝不落盘**：本模块不写任何文件（断言：临时目录无新增）；
 *   3. **不记内容**：错误里不带音频字节 / 识别文本 / 完整 Key。
 *
 * ## 为什么不真的发网络请求
 *   传输层的可测部分是**组装与裁决**：multipart 字段、状态码映射、文本提取、超时分类。
 *   这些用注入的 `fetchImpl` 全部可覆盖，且能在 CI 里跑（无外网、无密钥）。
 *   真实端点连通性属于"实机验证"，不是门禁能替代的 —— 本文件不假装测了它。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const stt = require('../src/stt-transport');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.7-a STT 传输层门禁 ---');

const GOOD_CFG = {
  endpoint: 'https://api.example.com/v1/audio/transcriptions',
  apiKey: 'test-key-not-real',
  model: 'whisper-1',
  lang: 'zh'
};
const AUDIO = Buffer.from('fake-audio-bytes-for-test');

/** 造一个可控的假响应 */
function fakeRes({ ok = true, status = 200, body = '{"text":"你好"}', contentType = 'application/json' } = {}) {
  return {
    ok, status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body
  };
}

/** 造一个记录请求的假 fetch */
function fakeFetch(resOrThrow) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (resOrThrow instanceof Error) throw resOrThrow;
    if (typeof resOrThrow === 'function') return resOrThrow(url, opts);
    return resOrThrow;
  };
  fn.calls = calls;
  return fn;
}

(async () => {

/* ============ 1. 配置校验：不猜、不补默认 ============ */

check('缺 endpoint → not_configured',
  stt.validateConfig({ apiKey: 'k', model: 'm' }).errorType === 'not_configured');
check('缺 apiKey → not_configured',
  stt.validateConfig({ endpoint: GOOD_CFG.endpoint, model: 'm' }).errorType === 'not_configured');
check('缺 model → not_configured',
  stt.validateConfig({ endpoint: GOOD_CFG.endpoint, apiKey: 'k' }).errorType === 'not_configured');
check('空对象 → not_configured', stt.validateConfig({}).errorType === 'not_configured');
check('null → not_configured', stt.validateConfig(null).errorType === 'not_configured');

check('🔴 公网明文 HTTP 一律拒（与 provider-policy 同口径）',
  stt.validateConfig({ endpoint: 'http://api.example.com/x', apiKey: 'k', model: 'm' }).errorType === 'insecure_endpoint');
check('🔴 localhost 允许明文 HTTP（兼容本地 whisper.cpp）',
  stt.validateConfig({ endpoint: 'http://localhost:8000/v1/audio/transcriptions', apiKey: 'k', model: 'm' }).ok === true);
check('🔴 127.0.0.1 允许明文 HTTP',
  stt.validateConfig({ endpoint: 'http://127.0.0.1:8000/x', apiKey: 'k', model: 'm' }).ok === true);
check('非法 URL → bad_endpoint',
  stt.validateConfig({ endpoint: 'not-a-url', apiKey: 'k', model: 'm' }).errorType === 'bad_endpoint');
check('非 http 协议 → bad_endpoint',
  stt.validateConfig({ endpoint: 'ftp://x.com/a', apiKey: 'k', model: 'm' }).errorType === 'bad_endpoint');
check('🔴 语言白名单：只接受 zh / en',
  stt.validateConfig({ ...GOOD_CFG, lang: 'ja' }).errorType === 'bad_lang');
check('语言缺省合法（空 lang 是允许的，交给服务端判定）',
  stt.validateConfig({ ...GOOD_CFG, lang: '' }).ok === true);

/* ============ 2. 音频校验 ============ */

let r = await stt.transcribe({ audio: null, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes()) });
check('无音频 → no_audio', r.ok === false && r.errorType === 'no_audio');

r = await stt.transcribe({ audio: Buffer.alloc(0), mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes()) });
check('空音频 → no_audio（0 字节不是"静音"，是没录到）', r.ok === false && r.errorType === 'no_audio');

const huge = Buffer.alloc(stt.MAX_AUDIO_BYTES + 1);
r = await stt.transcribe({ audio: huge, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes()) });
check('🔴 超限音频 → audio_too_large（不截断，截断会让识别变形）',
  r.ok === false && r.errorType === 'audio_too_large');

r = await stt.transcribe({ audio: AUDIO, mimeType: 'video/mp4', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes()) });
check('不支持的 MIME → unsupported_audio', r.ok === false && r.errorType === 'unsupported_audio');

/**
 * 🔴 MIME 参数必须被剥掉再查表（2026-10-20 真机 bug）。
 *
 * 实测事故：MediaRecorder 返回的是 `audio/webm;codecs=opus`，不是 `audio/webm`。
 * 原实现拿整串查 MIME_EXT ⇒ undefined ⇒ 判成 unsupported_audio，
 * 于是「录了 4.8 秒 / 72KB 音频」被自己拒掉，用户看到的是"什么都没识别出来"。
 * 审计日志留下了铁证：{stage:"failed", errorType:"unsupported_audio",
 *                      mime:"audio/webm;codecs=opus", bytes:72907}
 */
for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus',
  'audio/webm; codecs=opus; foo=bar']) {
  const rr = await stt.transcribe({ audio: AUDIO, mimeType: m, cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes()) });
  check('🔴 带 codecs 参数的 MIME 必须被接受: ' + m,
    rr.ok === true && rr.text === '你好', JSON.stringify(rr));
}

// 反向对照：剥参数不能把真·不支持的类型放进来
{
  const rr = await stt.transcribe({ audio: AUDIO, mimeType: 'video/mp4;codecs=h264', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes()) });
  check('🔴 剥参数后仍拒 video/*（不能放宽成"什么都接受"）',
    rr.ok === false && rr.errorType === 'unsupported_audio');
}

/* ============ 3. multipart 组装 ============ */

let f = fakeFetch(fakeRes());
r = await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: f });
check('正常请求返回 ok', r.ok === true && r.text === '你好');
check('🔴 请求打到配置的 endpoint', f.calls.length === 1 && f.calls[0].url === GOOD_CFG.endpoint);
check('🔴 用 POST', f.calls[0].opts.method === 'POST');
check('🔴 Authorization 是 Bearer + 独立 STT Key', f.calls[0].opts.headers.Authorization === 'Bearer ' + GOOD_CFG.apiKey);
check('🔴 body 是 FormData（multipart）', f.calls[0].opts.body instanceof FormData);

// 检查 multipart 字段（Node 的 FormData 支持 get）
const fd = f.calls[0].opts.body;
check('🔴 表单含 file 字段', fd.get('file') !== null);
check('🔴 表单 model 与配置一致', fd.get('model') === 'whisper-1');
check('🔴 表单 response_format=json', fd.get('response_format') === 'json');
check('🔴 表单 language=zh', fd.get('language') === 'zh');

// 不传 lang 时不能出现 language 字段（否则服务端会按固定语言识别，失去自动判定）
f = fakeFetch(fakeRes());
await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: { ...GOOD_CFG, lang: '' }, fetchImpl: f });
check('🔴 未指定语言时不传 language 字段（交给服务端判定）', f.calls[0].opts.body.get('language') === null);

// MIME → 扩展名映射：filename 影响部分服务端解析
for (const [mime, ext] of Object.entries(stt.MIME_EXT)) {
  f = fakeFetch(fakeRes());
  const rr = await stt.transcribe({ audio: AUDIO, mimeType: mime, cfg: GOOD_CFG, fetchImpl: f });
  const file = f.calls.length ? f.calls[0].opts.body.get('file') : null;
  check('MIME ' + mime + ' → 文件扩展名 .' + ext,
    rr.ok === true && file && file.name === 'audio.' + ext, file && file.name);
}

/* ============ 4. 状态码分类 ============ */

const STATUS_CASES = [
  [401, 'auth_failed'], [403, 'auth_failed'], [413, 'audio_too_large'],
  [415, 'unsupported_audio'], [429, 'rate_limited'], [500, 'server_error'],
  [502, 'server_error'], [400, 'request_rejected'], [404, 'request_rejected']
];
const statusBad = [];
for (const [status, expect] of STATUS_CASES) {
  const rr = await stt.transcribe({
    audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes({ ok: false, status }))
  });
  if (!rr.ok && rr.errorType !== expect) statusBad.push(status + '→' + rr.errorType);
  if (rr.ok) statusBad.push(status + '→ok??');
}
check('🔴 状态码映射全部正确', statusBad.length === 0, statusBad.join(','));

/* ============ 5. 网络异常与超时 ============ */

const timeoutErr = new Error('timed out');
timeoutErr.name = 'TimeoutError';
r = await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(timeoutErr) });
check('🔴 TimeoutError → timeout', r.ok === false && r.errorType === 'timeout');

const abortErr = new Error('aborted');
abortErr.name = 'AbortError';
r = await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(abortErr) });
check('🔴 AbortError → timeout（同归为中途中止）', r.ok === false && r.errorType === 'timeout');

const netErr = new Error('ECONNREFUSED');
netErr.name = 'TypeError';
r = await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(netErr) });
check('🔴 网络失败 → network', r.ok === false && r.errorType === 'network');

/**
 * 🔴 超时必须真的接上 AbortSignal（不是裸 fetch）。
 *
 * ⚠️ 首版这条断言是**假绿**：它写成一个未 await 的 Promise，
 * check() 收到的是 Promise 对象（恒真），而且断言在进程退出前根本没跑完。
 * 变异 3（把 signal 改成 undefined）因此**抓不到**。
 * 现在显式 await 后再判 —— 这条教训写在这里，防止有人"顺手简化"回 Promise 形态。
 */
{
  const ff = fakeFetch(fakeRes());
  await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: ff });
  const sig = ff.calls.length ? ff.calls[0].opts.signal : null;
  check('🔴 传了 AbortSignal（真接了超时，不是裸 fetch）',
    sig instanceof AbortSignal, 'signal=' + (sig && sig.constructor && sig.constructor.name));
}

/* ============ 6. 文本提取的宽容与严格 ============ */

check('JSON 形态提取 text', stt.extractText('{"text":"abc"}', 'application/json') === 'abc');
check('JSON 里 text 为空 → null（空串不是结果）', stt.extractText('{"text":"   "}', 'application/json') === null);
check('🔴 纯文本响应也接受（本地 whisper.cpp 会直接返回文本）',
  stt.extractText('hello world', 'text/plain') === 'hello world');
check('声明 JSON 但实际是纯文本 → 退回纯文本', stt.extractText('not json at all', 'application/json') === 'not json at all');
check('空响应体 → null', stt.extractText('', 'application/json') === null);

r = await stt.transcribe({
  audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes({ body: '{"text":""}' }))
});
check('🔴 服务端返回空文本 → empty_result（不伪造"识别成功"）',
  r.ok === false && r.errorType === 'empty_result');

r = await stt.transcribe({
  audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes({ body: '  ' }))
});
check('🔴 服务端返回空白 → empty_result', r.ok === false && r.errorType === 'empty_result');

/* ============ 7. 🔴 绝不抛 ============ */

const THROWERS = [
  ['fetch 抛错', fakeFetch(new Error('boom'))],
  ['fetch 返回坏对象', async () => ({ ok: true, text: () => { throw new Error('x'); } })],
  ['fetch 返回 null', async () => null],
  ['fetch 非函数', 'not-a-function']
];
const threw = [];
for (const [label, impl] of THROWERS) {
  try {
    const rr = await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: impl });
    if (rr.ok !== false) threw.push(label + ' 未判失败');
  } catch (e) {
    threw.push(label + ' 抛了: ' + (e && e.message));
  }
}
check('🔴 任何异常输入都不抛（全部归为 ok:false）', threw.length === 0, threw.join(','));

/* ============ 8. 🔴 密钥与音频不泄露 ============ */

const SECRET_KEY = 'sk-super-secret-stt-key-abcdef123456';
const SECRET_AUDIO = Buffer.from('AUDIO-CONTENT-MUST-NOT-LEAK');
let leakBad = [];

const leakRes = await stt.transcribe({
  audio: SECRET_AUDIO, mimeType: 'audio/webm',
  cfg: { ...GOOD_CFG, apiKey: SECRET_KEY },
  fetchImpl: fakeFetch(fakeRes({ ok: false, status: 401, body: 'unauthorized' }))
});
const leakStr = JSON.stringify(leakRes);
if (leakStr.includes(SECRET_KEY)) leakBad.push('返回值含完整 Key');
if (leakStr.includes('AUDIO-CONTENT-MUST-NOT-LEAK')) leakBad.push('返回值含音频内容');

check('🔴 失败结果里不含密钥、不含音频内容', leakBad.length === 0, leakBad.join(','));

// 成功结果也不该带密钥
const okRes = await stt.transcribe({
  audio: SECRET_AUDIO, mimeType: 'audio/webm',
  cfg: { ...GOOD_CFG, apiKey: SECRET_KEY }, fetchImpl: fakeFetch(fakeRes())
});
check('🔴 成功结果里不含密钥', !JSON.stringify(okRes).includes(SECRET_KEY));

/* ============ 9. 🔴 音频绝不落盘 ============ */

/**
 * ⚠️ 判据校正（2026-10-20 实测踩坑）：
 *
 * 旧判据是「跑完 STT 后临时目录不得出现任何新条目」。这在**单套件跑**时成立，
 * 但在全量套件里**必然假红** —— 同期还有别的套件在 mkdtemp
 * （实测撞到 `bedside-gate-*`，来自 bedside-mailbox.test.js）。
 * 别人的测试目录不是 STT 写的，把账算到它头上，守卫就变成了噪音。
 *
 * 正确判据：**只看 STT 可能写的那一类东西** —— 音频文件与已知临时前缀。
 * 这样既能抓住"真的落盘了"，又不会误伤并发套件。
 */
const before = new Set(fs.readdirSync(os.tmpdir()));
await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes()) });
await stt.transcribe({ audio: AUDIO, mimeType: 'audio/webm', cfg: GOOD_CFG, fetchImpl: fakeFetch(fakeRes({ ok: false, status: 500 })) });
const after = fs.readdirSync(os.tmpdir());
const added = after.filter((x) => !before.has(x));

// 只关心"像 STT 产物"的条目：音频扩展名，或本模块可能用的临时前缀
const AUDIO_RE = /\.(webm|wav|ogg|mp3|m4a|flac|opus)$/i;
const STT_PREFIX_RE = /^(stt|audio|voice)[-_]/i;
const sttArtifacts = added.filter((x) => AUDIO_RE.test(x) || STT_PREFIX_RE.test(x));

check('🔴 STT 全程不落任何音频文件到临时目录', sttArtifacts.length === 0,
  '新增条目=' + JSON.stringify(added) + ' 疑似 STT 产物=' + JSON.stringify(sttArtifacts));

// 诊断信息：若临时目录有新条目，如实记录（但不判失败）——避免下次再被误导
if (added.length) {
  console.log('     （临时目录本次新增 ' + added.length + ' 项，均非 STT 产物：' + added.slice(0, 5).join(', ') + '）');
}

/* ============ 10. 源码断言：与对话凭据物理隔离 ============ */

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'stt-transport.js'), 'utf8');
const srcNoComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

check('🔴 传输层不 require connections（不与对话凭据耦合）',
  !srcNoComment.includes("require('./connections')") && !srcNoComment.includes('require("./connections")'));
check('🔴 传输层不 require 对话 transport / adapter',
  !srcNoComment.includes('openai-transport') && !srcNoComment.includes('deepseek'));
check('🔴 传输层不写文件（无 fs.write / writeFileSync / createWriteStream）',
  !/fs\.write|writeFileSync|createWriteStream/.test(srcNoComment));
/**
 * 🔴 零新增依赖：只允许 Node 内置模块。
 *
 * ⚠️ 首版这条断言写错过：它用「不出现 require(...)」当判据，
 * 结果 `require('path')` 被误判成"新增依赖"而报红 ——
 * **判据本身写错了，不是代码有问题**（这正是变异测试反过来的用法：
 * 断言先自己假红一次，才知道它到底在测什么）。
 *
 * 正确判据：提取所有 require 的模块名，逐个查是否在白名单（Node 内置）里。
 */
const REQUIRED_MODULES = [...srcNoComment.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
const NODE_BUILTINS = new Set(['path', 'fs', 'os', 'url', 'crypto', 'util', 'stream',
  'events', 'http', 'https', 'zlib', 'buffer', 'string_decoder', 'timers', 'process']);
const thirdParty = REQUIRED_MODULES.filter((m) => !NODE_BUILTINS.has(m) && !m.startsWith('./') && !m.startsWith('node:'));
check('🔴 传输层零新增第三方依赖（只用 Node 内置）',
  thirdParty.length === 0, '实得: ' + JSON.stringify(REQUIRED_MODULES) + ' 第三方: ' + JSON.stringify(thirdParty));

// 且必须真的用 FormData/Blob（不是自己拼 multipart 界，那等于重写一套易错的实现）
check('🔴 真的使用原生 FormData', srcNoComment.includes('new FormData()'));
check('🔴 真的使用原生 Blob', srcNoComment.includes('new Blob('));

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);

})();
