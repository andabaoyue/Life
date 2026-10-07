/**
 * test/security-hardening-sec.test.js — SEC-01 ~ SEC-07 安全收口回归
 *
 * 覆盖：IPC sender/frame/URL 校验 + navigation 限制（SEC-01）、CSP（SEC-02）、
 * generic provider 响应大小硬上限（SEC-03）、replay task 生命周期 cleanup（SEC-04）、
 * 敏感文件权限（SEC-05）、mint authority 收口（SEC-06）、CI pin + audit（SEC-07）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const KEY = 'sk-tes...-000';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function run() {
/* ================= SEC-01: IPC sender / frame / URL 校验 + navigation ================= */
{
  const { createIpcGuard, isAppLocalUrl } = require('../src/ipc-guard');

  // appDir 用 posix 风格混搭验证跨平台归一化
  const appDir = path.resolve('C:/fake-app');
  const localUrl = 'file:///' + appDir.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '$1') + '/index.html';
  const mainFrame = { url: localUrl };
  const webContents = {
    mainFrame,
    _navHandlers: {},
    on(ev, fn) { this._navHandlers[ev] = fn; },
    setWindowOpenHandler(fn) { this._windowOpen = fn; }
  };
  const win = { isDestroyed: () => false, webContents };
  const registered = {};
  const fakeIpcMain = {
    handle(channel, fn) { registered['handle:' + channel] = fn; },
    on(channel, fn) { registered['on:' + channel] = fn; }
  };
  const guard = createIpcGuard({ ipcMain: fakeIpcMain, getMainWindow: () => win, appDir });

  let called = 0;
  guard.handle('demo', () => { called++; return 'ok'; });
  guard.on('demo-on', () => { called++; });

  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  check('SEC-01 trusted main-frame IPC 正常通过',
    registered['handle:demo'](trustedEvent) === 'ok' && called === 1);

  let err1 = null;
  try { registered['handle:demo']({ sender: {}, senderFrame: mainFrame }); } catch (e) { err1 = e; }
  check('SEC-01 untrusted sender 被拒绝（UNTRUSTED_RENDERER）',
    err1 && err1.message === 'UNTRUSTED_RENDERER' && called === 1);

  let err2 = null;
  try {
    registered['handle:demo']({ sender: webContents, senderFrame: { url: localUrl } }); // child frame
  } catch (e) { err2 = e; }
  check('SEC-01 child frame / 非 main-frame 被拒绝',
    err2 && err2.message === 'UNTRUSTED_RENDERER');

  let err3 = null;
  try {
    registered['handle:demo']({ sender: webContents, senderFrame: { url: 'https://evil.example.com/x' } });
  } catch (e) { err3 = e; }
  check('SEC-01 remote URL frame 被拒绝', err3 && err3.message === 'UNTRUSTED_RENDERER');

  registered['on:demo-on']({ sender: {}, senderFrame: mainFrame });
  check('SEC-01 untrusted on() 消息被静默丢弃（不触发 handler）', called === 1);

  check('SEC-01 isAppLocalUrl: 本地页面允许 / 外部与空值拒绝',
    isAppLocalUrl(localUrl, appDir) === true &&
    isAppLocalUrl('https://example.com/', appDir) === false &&
    isAppLocalUrl('about:blank', appDir) === false &&
    isAppLocalUrl('file:///C:/other-app/index.html', appDir) === false);

  // navigation / new window 守卫
  guard.attachNavigationGuard(webContents);
  let prevented = 0;
  webContents._navHandlers['will-navigate']({ preventDefault: () => prevented++ }, 'https://evil.example.com');
  webContents._navHandlers['will-redirect']({ preventDefault: () => prevented++ }, 'https://evil.example.com');
  webContents._navHandlers['will-navigate']({ preventDefault: () => prevented++ }, localUrl);
  check('SEC-01 非 app URL navigation/redirect 被阻止、本地页面放行', prevented === 2);
  check('SEC-01 window.open / 新窗口被拒绝',
    webContents._windowOpen && webContents._windowOpen({}).action === 'deny');

  // 源码级：main.js 无任何绕过 guard 的直接注册
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('SEC-01 main.js 全部 IPC 经 ipcGuard（无直接 ipcMain.handle/on）',
    !/ipcMain\.(handle|on)\(/.test(mainSrc) &&
    mainSrc.includes('registerResearchIpc(ipcGuard,') &&
    mainSrc.includes('ipcGuard.attachNavigationGuard(win.webContents)'));
}

/* ================= SEC-02: Renderer CSP ================= */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  const csp = m ? m[1] : '';
  check('SEC-02 CSP meta 存在且含基线指令',
    csp.includes("default-src 'self'") && csp.includes("script-src 'self'") &&
    csp.includes("object-src 'none'") && csp.includes("base-uri 'none'") &&
    csp.includes("frame-ancestors 'none'"));
  const scriptSrc = (csp.match(/script-src ([^;]+)/) || [])[1] || '';
  check('SEC-02 script-src 无 unsafe-inline / 远程 / 通配 / data:',
    scriptSrc.trim() === "'self'");
  const scriptTags = html.match(/<script\b[^>]*>/g) || [];
  check('SEC-02 无内联 script（全部 src 外部加载）',
    scriptTags.every((t) => /src="/.test(t)) && !/<script>(?!\s*<)/.test(html));
}

/* ================= SEC-03: 响应大小硬上限 ================= */
{
  const { createOpenAICompatibleAdapter } = require('../src/adapters/openai-compatible-adapter');
  const { readBodyCapped, MAX_ERROR_BODY_BYTES, requestChatCompletion } = require('../src/openai-transport');
  const { createSSEParser } = require('../src/sse-parser');
  const realFetch = globalThis.fetch;

  function mockFetch(handler) {
    let calls = 0;
    globalThis.fetch = async (url, init) => { calls++; return handler(url, init, calls); };
    return { get calls() { return calls; } };
  }
  function streamRes(status, chunks, headers = {}) {
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
    const enc = new TextEncoder();
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => lower[String(h).toLowerCase()] ?? null },
      body: new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
          controller.close();
        }
      }),
      text: async () => chunks.map((c) => (typeof c === 'string' ? c : new TextDecoder().decode(c))).join('')
    };
  }
  const mk = (extra) => createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm', requestTimeoutMs: 5000, maxRetries: 3, retryBaseDelayMs: 1, ...extra }, { providerId: 'generic' });

  // 1. complete response 超限
  const bigChunk = new Uint8Array(6 * 1024 * 1024).fill(65); // 6MB x2 = 12MB > 10MB
  let initSig = null;
  const m1 = mockFetch((u, init) => { initSig = init.signal; return streamRes(200, [bigChunk, bigChunk], { 'content-type': 'application/json' }); });
  let e1 = null;
  try { await mk().complete([{ role: 'user', content: 'x' }]); } catch (e) { e1 = e; }
  // 项目统一错误归一化后 name=ProviderError，判别字段为 errorType='response_too_large'（fail-closed、非重试）
  check('SEC-03 complete response 超限 -> response_too_large（fail-closed）',
    e1 && e1.errorType === 'response_too_large' && e1.retryable === false);
  check('SEC-03 超限后 abort 生效（fetch signal 已 aborted）', !!(initSig && initSig.aborted));
  check('SEC-03 超限不触发无意义 retry（仅 1 次请求）', m1.calls === 1);
  globalThis.fetch = realFetch;

  // 2. error body 超限 -> 有界截断，不掩盖原 HTTP 错误
  const hugeErrBody = 'E'.repeat(2 * 1024 * 1024); // 2MB
  const m2 = mockFetch(() => streamRes(400, [hugeErrBody]));
  let e2 = null;
  try { await mk().complete([{ role: 'user', content: 'x' }]); } catch (e) { e2 = e; }
  check('SEC-03 error body 超限 -> 有界读取（不吞 2MB、保留 HTTP 错误）',
    e2 && e2.name === 'ProviderError' && m2.calls === 1 &&
    String(e2.message).length < 20000 && String(e2.safeDetail || '').length < 20000);
  check('SEC-03 readBodyCapped truncate 模式有界返回', (async () => {
    const r = await readBodyCapped(streamRes(200, [hugeErrBody]), MAX_ERROR_BODY_BYTES, { truncate: true });
    return r.length <= MAX_ERROR_BODY_BYTES;
  })());
  globalThis.fetch = realFetch;

  // 3. stream 累计文本超限
  const bigDelta = JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(60 * 1024) } }] });
  const sseChunk = 'data: ' + bigDelta + '\n\n';
  const m3 = mockFetch(() => streamRes(200, Array(10).fill(sseChunk))); // 600K chars > 500K
  let e3 = null;
  try {
    await mk().stream([{ role: 'user', content: 'x' }], () => {});
  } catch (e) { e3 = e; }
  check('SEC-03 stream 累计文本超限 -> response_too_large（fail-closed）',
    e3 && e3.errorType === 'response_too_large' && e3.retryable === false && m3.calls === 1);
  globalThis.fetch = realFetch;

  // 4. SSE buffer 超限（parser 单元）
  let e4 = null;
  try {
    const parser = createSSEParser({ onEvent: () => {}, maxBufferBytes: 1024 });
    parser.feed('data: {"never-ending'); // 无 event boundary，buffer 无界增长场景
    parser.feed('x'.repeat(4096));
  } catch (e) { e4 = e; }
  check('SEC-03 SSE buffer 超限 -> ResponseTooLargeError', e4 && e4.name === 'ResponseTooLargeError');

  // 5/6. 正常大小 response 行为完全不变
  const m5 = mockFetch(() => streamRes(200, [JSON.stringify({ choices: [{ message: { content: 'fine' } }], usage: {}, model: 'm' })], { 'content-type': 'application/json' }));
  const r5 = await mk().complete([{ role: 'user', content: 'x' }]);
  const m6 = mockFetch(() => streamRes(200, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']));
  let got = '';
  const r6 = await mk().stream([{ role: 'user', content: 'x' }], (d) => { got += d; });
  check('SEC-03 正常大小 complete 行为不变', r5 && r5.text === 'fine' && m5.calls === 1);
  check('SEC-03 正常大小 stream 行为不变', got === 'ok' && r6 && r6.text === 'ok');
  globalThis.fetch = realFetch;

  /* ---- SEC-03 DeepSeek production path（Brain→Registry→DeepSeekAdapter→DeepSeek 真实链） ---- */
  {
    const { DeepSeek } = require('../src/deepseek');
    const dsCfg = { baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', requestTimeoutMs: 5000, maxRetries: 3, retryBaseDelayMs: 1 };

    // A. DeepSeek complete response > 10MB
    let dsSig = null;
    const md1 = mockFetch((u, init) => { dsSig = init.signal; return streamRes(200, [bigChunk, bigChunk], { 'content-type': 'application/json' }); });
    let de1 = null;
    try { await new DeepSeek(dsCfg).complete([{ role: 'user', content: 'x' }]); } catch (e) { de1 = e; }
    check('SEC-03-DP DeepSeek complete >10MB -> response_too_large（retryable=false）',
      de1 && de1.errorType === 'response_too_large' && de1.retryable === false);
    check('SEC-03-DP DeepSeek complete 超限 abort 连接且仅 1 次请求',
      !!(dsSig && dsSig.aborted) && md1.calls === 1);
    globalThis.fetch = realFetch;

    // B. DeepSeek stream 累计文本 > 500K（partial 语义保留）
    const dsBigDelta = JSON.stringify({ choices: [{ delta: { content: 'y'.repeat(60 * 1024) } }] });
    const dsSse = 'data: ' + dsBigDelta + '\n\n';
    let dsSig2 = null;
    const md2 = mockFetch((u, init) => { dsSig2 = init.signal; return streamRes(200, Array(10).fill(dsSse)); });
    let de2 = null;
    const dsChunks = [];
    try {
      await new DeepSeek(dsCfg).stream([{ role: 'user', content: 'x' }], (d) => dsChunks.push(d));
    } catch (e) { de2 = e; }
    check('SEC-03-DP DeepSeek stream 累计 >500K -> response_too_large（partial 不丢）',
      de2 && de2.errorType === 'response_too_large' && de2.retryable === false &&
      typeof de2.partial === 'string' && de2.partial.length > 0 && de2.partial.length <= 500 * 1024 &&
      de2.partial === dsChunks.join(''));
    check('SEC-03-DP DeepSeek stream 超限不 retry 且终止连接',
      md2.calls === 1 && !!(dsSig2 && dsSig2.aborted));
    globalThis.fetch = realFetch;

    // C. DeepSeek stream 未终结 SSE buffer > 1MB（byte 级上限）
    let dsSig3 = null;
    const md3 = mockFetch((u, init) => {
      dsSig3 = init.signal;
      return streamRes(200, ['data: {"never-ending', new Uint8Array(1024 * 1024 + 2048).fill(120)]);
    });
    let de3 = null;
    try { await new DeepSeek(dsCfg).stream([{ role: 'user', content: 'x' }], () => {}); } catch (e) { de3 = e; }
    check('SEC-03-DP DeepSeek stream 未终结 buffer >1MB -> response_too_large fail-closed',
      de3 && de3.errorType === 'response_too_large' && de3.retryable === false &&
      md3.calls === 1 && !!(dsSig3 && dsSig3.aborted));
    globalThis.fetch = realFetch;

    // D. 正常 DeepSeek complete / stream 行为完全不变
    const md4 = mockFetch(() => streamRes(200,
      [JSON.stringify({ choices: [{ message: { content: 'deep-fine' } }], usage: { prompt_tokens: 1 }, model: 'deepseek-chat' })],
      { 'content-type': 'application/json' }));
    const rd1 = await new DeepSeek(dsCfg).complete([{ role: 'user', content: 'x' }]);
    const md5 = mockFetch(() => streamRes(200, [
      'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":2}}\n\n',
      'data: [DONE]\n\n'
    ]));
    let dgot = '';
    const rd2 = await new DeepSeek(dsCfg).stream([{ role: 'user', content: 'x' }], (d) => { dgot += d; });
    check('SEC-03-DP 正常 DeepSeek complete/stream 行为完全不变（含 usage/observedModel）',
      rd1 && rd1.text === 'deep-fine' && rd1.usage && rd1.usage.prompt_tokens === 1 && rd1.observedModel === 'deepseek-chat' &&
      md4.calls === 1 && dgot === 'ok' && rd2 && rd2.text === 'ok' &&
      rd2.usage && rd2.usage.prompt_tokens === 2 && rd2.observedModel === 'deepseek-chat' && md5.calls === 1);
    globalThis.fetch = realFetch;
  }
}

/* ================= SEC-04: replay task 生命周期 ================= */
{
  const { ResearchService } = require('../src/research-service');
  const dir = tmpDir('sec04-');
  const svc = new ResearchService(dir, { taskRetentionMs: 40 });

  const t1 = svc.startReplayTask({});
  const t2 = svc.startReplayTask({});
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await wait(30); // 完成但仍在 retention 窗口内
    const s1 = svc.getReplayTaskStatus(t1.taskId);
    const s2 = svc.getReplayTaskStatus(t2.taskId);
    check('SEC-04 task 完成后 retention 窗口内仍可查询（含 result）',
      s1 && s1.status === 'completed' && s1.result !== undefined && s2 && s2.status === 'completed');

  await wait(250); // 超过 retention：自动 cleanup（未手动调用）
    const r1 = svc.getReplayTaskStatus(t1.taskId);
    const r2 = svc.getReplayTaskStatus(t2.taskId);
    const meta1 = svc.completedTaskMetadata.get(t1.taskId);
    check('SEC-04 超过 retention 后自动 cleanup（无需手动触发）',
      !svc.activeTasks.has(t1.taskId) && !svc.activeTasks.has(t2.taskId) && !!meta1);
    check('SEC-04 cleanup 后不再持有完整结果（result/windowStates/trajectory/stateChanges 已释放）',
      meta1 && meta1.result === undefined && meta1.windowStates === undefined &&
      meta1.trajectory === undefined && meta1.stateChanges === undefined && meta1.resultReleased === true);
    check('SEC-04 多 task 并行不互相破坏（状态查询 API 仍可用）',
      r1 && r1.taskId === t1.taskId && r2 && r2.taskId === t2.taskId);

    // 正在运行的 task 不被错误清理
    svc.activeTasks.set('manual-running', { taskId: 'manual-running', status: 'running', result: { windowStates: [1, 2, 3] } });
    svc.cleanupReplayTasks({ now: Date.now() + 999999, retentionMs: 0 });
    check('SEC-04 正在运行的 task 不被清理',
      svc.activeTasks.has('manual-running') && !svc.completedTaskMetadata.has('manual-running'));
    svc.activeTasks.delete('manual-running');

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= SEC-05 / 06 / 07 ================= */
{
  /* ---- SEC-05: 敏感文件权限 ---- */
  {
    const { writeFileAtomic, writeJsonAtomic } = require('../src/atomic');
    const secure = require('../src/secure');
    const dir = tmpDir('sec05-');
    const f1 = path.join(dir, 'life-key--x');
    writeFileAtomic(f1, 'cipher', { mode: 0o600 });
    const f2 = path.join(dir, 'life-config.json');
    writeJsonAtomic(f2, { a: 1 }, { mode: 0o600 });
    const unix = process.platform !== 'win32';
    check('SEC-05 sensitive file 创建后具有 restrictive mode（Unix）；Windows 容忍',
      unix
        ? ((fs.statSync(f1).mode & 0o777) === 0o600 && (fs.statSync(f2).mode & 0o777) === 0o600)
        : (fs.existsSync(f1) && fs.existsSync(f2)));

    const fakeSS = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s).toString('base64'),
      decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf8').slice(4)
    };
    secure.saveConfig(() => fakeSS, dir, { provider: 'deepseek', apiKey: KEY, model: 'm' }, () => {});
    const kp = secure.primaryKeyPath(dir, 'deepseek');
    const cp = secure.primaryCfgPath(dir);
    check('SEC-05 key/config 实际落盘路径收紧权限（Unix）；Windows 容忍',
      unix
        ? ((fs.statSync(kp).mode & 0o777) === 0o600 && (fs.statSync(cp).mode & 0o777) === 0o600)
        : (fs.existsSync(kp) && fs.existsSync(cp)));

    // legacy credential 路径不遗漏：迁移写入同样带 mode
    fs.writeFileSync(path.join(dir, 'gpt-girl-key'), fakeSS.encryptString('sk-legacy-9'));
    secure.decryptKey(() => fakeSS, dir, 'deepseek');
    const legacyMigrated = fs.existsSync(kp);
    check('SEC-05 legacy credential 迁移写入不遗漏（mode 由 writeFileAtomic 统一携带）',
      legacyMigrated && (!unix || (fs.statSync(kp).mode & 0o777) === 0o600));

    // rollback 行为不变：writeFileAtomic 原语测试
    const f3 = path.join(dir, 'roll');
    writeFileAtomic(f3, 'v1', { mode: 0o600 });
    writeFileAtomic(f3, 'v2', { mode: 0o600 });
    check('SEC-05 原有 atomic write / 覆盖行为不变', fs.readFileSync(f3, 'utf8') === 'v2');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---- SEC-06: mint authority 收口 ---- */
  {
    const { createProviderRuntimeMintAuthority, isProviderRuntimeResponse, providerRuntimeAdapterMatches, isLegalRuntimeIdentity } = require('../src/provider-runtime-trust');
    const { DeepSeek } = require('../src/deepseek');

    // 无合法 capability：仅凭 provider string 不能取得 authority
    const denied1 = createProviderRuntimeMintAuthority('deepseek');
    const r1 = denied1({ observedModel: 'fake', text: 'x' });
    check('SEC-06 无合法 capability 时不能 mint（fail-closed）',
      isProviderRuntimeResponse(r1) === false && providerRuntimeAdapterMatches(r1, 'deepseek') === false);

    const denied2 = createProviderRuntimeMintAuthority('deepseek', 'deepseek'); // 任意 provider string
    const denied3 = createProviderRuntimeMintAuthority('other-adapter', null);
    check('SEC-06 任意 provider string / null 不能直接伪造 authority',
      isProviderRuntimeResponse(denied2({ observedModel: 'x' })) === false &&
      isProviderRuntimeResponse(denied3({ observedModel: 'x' })) === false);

    // 合法 runtime（真实 DeepSeek adapter 实例）attestation 仍然通过
    const realAdapter = new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' });
    const minter = createProviderRuntimeMintAuthority('deepseek', realAdapter);
    const r2 = minter({ observedModel: 'deepseek-chat', text: 'x' });
    check('SEC-06 合法 runtime attestation 仍然通过',
      isProviderRuntimeResponse(r2) === true && providerRuntimeAdapterMatches(r2, 'deepseek') === true);
    check('SEC-06 isLegalRuntimeIdentity 契约判定正确',
      isLegalRuntimeIdentity(realAdapter) === true && isLegalRuntimeIdentity('deepseek') === false &&
      isLegalRuntimeIdentity({}) === false);

    // deepseek 生产接线：complete() 返回对象仍带 attestation
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: {}, model: 'deepseek-chat' }),
      json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: {}, model: 'deepseek-chat' })
    });
  const out = await realAdapter.complete([{ role: 'user', content: 'x' }]);
  check('SEC-06 deepseek complete() 生产路径 attestation 完整', isProviderRuntimeResponse(out) === true);
  globalThis.fetch = realFetch;
}

/* ---- SEC-07: CI pin + audit ---- */
{
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const usesLines = ci.split('\n').filter((l) => l.includes('uses:'));
  check('SEC-07 actions 全部 pin 到 commit SHA（无 mutable major tag）',
    usesLines.length >= 3 && usesLines.every((l) => /uses:\s*actions\/[a-z-]+@[0-9a-f]{40}\s*#\s*v\d/.test(l)));
  check('SEC-07 npm audit --audit-level=high 已接入', ci.includes('npm audit --audit-level=high'));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
}

}

run().catch((e) => { console.error('FAIL  测试异常 ' + (e && e.stack || e)); process.exit(1); });
