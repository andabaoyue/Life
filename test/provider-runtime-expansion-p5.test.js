/**
 * test/provider-runtime-expansion-p5.test.js
 *
 * v0.9.8 P5 Provider Runtime Expansion 回归（覆盖 P5-E 28 项判据）。
 * fixture 仅使用假 credential: sk-test-fixture-000 / sk-deepseek-000 / sk-generic-000。
 *
 * 标注口径：本文件证明 implemented+tested；production-wired 状态见提交报告。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAdapter, getProviderInfo, listProviders, registerProvider } = require('../src/provider-registry');
const { createDeepSeekAdapter } = require('../src/adapters/deepseek-adapter');
const { createOpenAICompatibleAdapter } = require('../src/adapters/openai-compatible-adapter');
const { validateAdapterContract, assertCapability } = require('../src/provider-adapter');
const {
  normalizeBaseURL,
  resolveChatCompletionsURL
} = require('../src/openai-transport');
const { createSSEParser } = require('../src/sse-parser');
const { normalizeUsage } = require('../src/usage-normalizer');
const { getCacheStrategy } = require('../src/cache-strategy');
const { getCostStrategy } = require('../src/cost-strategy');
const { validateCredentialTarget } = require('../src/provider-policy');
const secure = require('../src/secure');
const { swapBrain } = require('../src/brain-hot-swap');
const { isProviderRuntimeResponse } = require('../src/provider-runtime-trust');

const KEY = 'sk-test-fixture-000';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'p5-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const realFetch = globalThis.fetch;
function mockFetch(handler) {
  let calls = 0;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    calls++;
    urls.push(String(url));
    return handler(url, init, calls);
  };
  return { get calls() { return calls; }, get urls() { return urls; } };
}
function httpRes(status, bodyText, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => lower[String(h).toLowerCase()] ?? null },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText)
  };
}
function okRes(payload) { return httpRes(200, JSON.stringify(payload)); }
function hangRes(init) {
  return new Promise((_, reject) => {
    if (init && init.signal) {
      const s = init.signal;
      if (s.aborted) { reject(s.reason instanceof Error ? s.reason : new Error('aborted')); return; }
      s.addEventListener('abort', () => reject(s.reason instanceof Error ? s.reason : new Error('aborted')), { once: true });
    }
  });
}
function sseRes(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200, headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: enc.encode(chunks[i++]) };
        },
        cancel: async () => { i = chunks.length; }
      })
    }
  };
}

(async () => {
  /* ===== 1/12/13/14. Registry dispatch / Brain dispatch / unknown fail-closed / duplicate ===== */
  {
    check('Registry dispatch: deepseek -> DeepSeek Adapter', createAdapter('deepseek', { baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' }).providerId === 'deepseek');
    check('Registry dispatch: generic -> OpenAI-compatible Adapter', createAdapter('generic', { baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm' }).providerId === 'generic');

    const { Brain } = require('../src/brain');
    const b1 = new Brain(tmpDir(), { apiKey: KEY, model: 'm', baseURL: 'https://api.deepseek.com', provider: 'deepseek' });
    check('Brain 动态 dispatch（cfg.provider=deepseek）', b1.api && b1.api.providerId === 'deepseek');
    const b2 = new Brain(tmpDir(), { apiKey: KEY, model: 'm', baseURL: 'http://127.0.0.1:11434/v1', provider: 'generic' });
    check('Brain 动态 dispatch（cfg.provider=generic 进同一调用链）', b2.api && b2.api.providerId === 'generic');

    let unknownErr = null;
    try { new Brain(tmpDir(), { apiKey: KEY, model: 'm', baseURL: 'https://x.example.com', provider: 'no-such-provider' }); } catch (e) { unknownErr = e; }
    check('unknown provider fail-closed（Brain 构造即拒绝）', unknownErr && unknownErr.name === 'UnknownProviderError');

    let dup = null;
    try { registerProvider({ providerId: 'deepseek', adapterFactory: () => createDeepSeekAdapter({}) }); } catch (e) { dup = e; }
    check('Registry duplicate 保护（显式拒绝静默覆盖）', dup && /ALREADY_REGISTERED/.test(dup.message));

    // invalid ≠ 合法 Provider ≠ 允许联网：仅为兼容旧构造语义，网络调用在门禁处 fail-closed（0 fetch）
    const inv = createAdapter('invalid', { apiKey: KEY, model: 'm' });
    check('invalid 仅用于兼容旧构造（可构造 adapter）', inv && inv.providerId === 'invalid');
    const mi = mockFetch(async () => okRes({}));
    let invErr = null;
    try { await inv.complete([{ role: 'user', content: 'x' }]); } catch (e) { invErr = e; }
    check('invalid ≠ 允许联网（门禁拦截、0 请求）', invErr && mi.calls === 0 &&
      (invErr.name === 'InvalidBaseUrlError' || invErr.errorType === 'policy_violation'));
    globalThis.fetch = realFetch;
  }

  /* ===== 2/3. DeepSeek 兼容 + Generic contract ===== */
  {
    const g = createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm' }, { providerId: 'generic' });
    check('Generic adapter 实现完整 contract', validateAdapterContract(g).ok === true);
    const d = createDeepSeekAdapter({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' });
    check('DeepSeek adapter compatibility（contract 保持）', validateAdapterContract(d).ok === true);

    mockFetch(async () => okRes({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, model: 'm' }));
    const res = await g.complete([{ role: 'user', content: 'x' }]);
    check('Generic complete() 可调用（统一形状）', res && res.text === 'hi' && res.usage && res.attempts >= 1);
    globalThis.fetch = realFetch;
  }

  /* ===== 4/5/6. URL 标准化 / /v1 保留 / 尾斜杠 ===== */
  {
    check('B-2 https://host -> https://host/chat/completions', resolveChatCompletionsURL('https://host') === 'https://host/chat/completions');
    check('B-2 /v1 path 保留', resolveChatCompletionsURL('https://host/v1') === 'https://host/v1/chat/completions');
    check('B-2 尾斜杠标准化', resolveChatCompletionsURL('https://host/v1/') === 'https://host/v1/chat/completions');
    check('B-2 绝不产生 //chat/completions', !resolveChatCompletionsURL('https://host///').includes('//chat'));
    check('B-2 trim + 合法性校验', normalizeBaseURL('  https://host/v1  ') === 'https://host/v1' && (() => { try { normalizeBaseURL('not a url'); return false; } catch { return true; } })());

    const m = mockFetch(async () => okRes({ choices: [{ message: { content: 'ok' } }], usage: {}, model: 'm' }));
    await createOpenAICompatibleAdapter({ baseURL: 'https://host/v1/', apiKey: KEY, model: 'm' }, { providerId: 'generic' }).complete([{ role: 'user', content: 'x' }]);
    check('Generic 请求 URL 走 resolver（/v1/ 归一）', m.urls[0] === 'https://host/v1/chat/completions');
    globalThis.fetch = realFetch;
  }

  /* ===== 7-11. SSE framing ===== */
  {
    const events = [];
    const p = createSSEParser({ onEvent: (e) => events.push(e) });
    // 7: JSON 被 chunk 截断
    p.feed('data: {"cho');
    p.feed('ices":[1]}\n\n');
    // 8: 换行被 chunk 截断
    p.feed('data: {"x":2}\n');
    p.feed('\n');
    // 10: comment / keep-alive + 空 event
    p.feed(': ping\n\n');
    p.feed('\n\n');
    // 9: [DONE]
    p.feed('data: [DONE]\n\n');
    p.flush();
    check('SSE split JSON：半截 JSON 不提前 parse，边界后解析成功',
      events.length >= 3 && events[0].json && events[0].json.cho === undefined && Array.isArray(events[0].json.choices));
    check('SSE split newline：跨 chunk 换行正确切分', events[1] && events[1].json && events[1].json.x === 2);
    check('SSE comment/keep-alive 与空 event 被跳过', events.every(e => !e.malformed) && events.length === 3);
    check('SSE [DONE] 识别', events[2] && events[2].done === true);

    // 11: malformed fail-safe
    const ev2 = [];
    const p2 = createSSEParser({ onEvent: (e) => ev2.push(e) });
    p2.feed('data: {broken json\n\n');
    p2.flush();
    check('SSE malformed fail-safe（不抛、如实上报）', ev2.length === 1 && ev2[0].malformed === true);
  }

  /* ===== 15. generic capability fail-closed ===== */
  {
    const g = createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm' }, { providerId: 'generic' });
    g.capabilities = () => ({ streaming: false });
    const m = mockFetch(async () => sseRes([]));
    let err = null;
    try { await g.stream([{ role: 'user', content: 'x' }]); } catch (e) { err = e; }
    check('generic capability fail-closed（不发网络请求）', err && err.name === 'UnsupportedCapabilityError' && m.calls === 0);
    globalThis.fetch = realFetch;
  }

  /* ===== 16-19. Strategy 键控（协议兼容 ≠ 语义相同） ===== */
  {
    const ds = getCacheStrategy('deepseek');
    const interp = ds.interpret(normalizeUsage({ prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3, completion_tokens: 1 }, 'deepseek'));
    check('DeepSeek cache strategy 语义不变', interp.cacheHitTokens === 7 && interp.cacheMissTokens === 3);
    check('generic 不继承 DeepSeek cache 语义', getCacheStrategy('generic') === null);
    check('generic 不继承 DeepSeek pricing', getCostStrategy('generic') === null);
    const un = normalizeUsage({ prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500, completion_tokens: 100 }, 'generic');
    check('generic usage 不套 DeepSeek 推导（prompt 不由 hit+miss 合成）', un.promptTokens === null && un.providerRawUsage.prompt_cache_hit_tokens === 1500);
    const unknownCost = getCostStrategy('deepseek').calculate(normalizeUsage(null, 'deepseek'), {});
    check('unknown cost => null（不伪造）', unknownCost.cost === null);
  }

  /* ===== 20. credential namespace isolation ===== */
  {
    const dir = tmpDir('p5-cred-');
    const fakeSS = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s).toString('base64'),
      decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf8').slice(4)
    };
    const getSS = () => fakeSS;
    const diskState = {};
    const writeDiskFor = (d) => (c) => { diskState[d] = { ...c }; fs.writeFileSync(path.join(dir, d === 'deepseek' ? 'life-config.json' : 'life-config.json'), '{}'); };
    // 保存两个 provider 的 key
    secure.saveConfig(getSS, dir, { provider: 'deepseek', apiKey: 'sk-deepseek-000', model: 'm' }, () => {});
    secure.saveConfig(getSS, dir, { provider: 'generic', apiKey: 'sk-generic-000', model: 'm' }, () => {});
    const dp = secure.keyPath(dir, 'deepseek');
    const gp = secure.keyPath(dir, 'generic');
    check('credential namespace：deepseek key ≠ generic key（文件隔离）', dp !== gp && fs.existsSync(dp) && fs.existsSync(gp));
    const dKey = secure.decryptKey(getSS, dir, 'deepseek');
    const gKey = secure.decryptKey(getSS, dir, 'generic');
    check('切换 Provider 不读到另一 Provider 的 key', dKey === 'sk-deepseek-000' && gKey === 'sk-generic-000');
    check('namespace 文件不泄漏明文 key', !fs.readFileSync(dp, 'utf8').includes('sk-deepseek-000') && !fs.readFileSync(gp, 'utf8').includes('sk-generic-000'));

    // A→B→A 切换回读：切到 B 再切回 A，A 的原 credential 仍在
    secure.saveConfig(getSS, dir, { provider: 'generic', apiKey: 'sk-generic-000', model: 'm' }, () => {});
    secure.saveConfig(getSS, dir, { provider: 'deepseek', apiKey: 'sk-deepseek-000', model: 'm' }, () => {});
    check('A→B→A 切换回读：A 原 credential 仍在、B 未串',
      secure.decryptKey(getSS, dir, 'deepseek') === 'sk-deepseek-000' && secure.decryptKey(getSS, dir, 'generic') === 'sk-generic-000');

    // legacy gpt-girl-key 不得跨 namespace 泄漏/复制到 generic
    //（模拟真实旧安装：只有 gpt-girl-key、没有 life-key）
    try { fs.unlinkSync(path.join(dir, 'life-key')); } catch {}
    fs.writeFileSync(path.join(dir, 'gpt-girl-key'), fakeSS.encryptString('sk-legacy-deepseek-1'));
    check('legacy key 只归 deepseek namespace：generic 读不到 legacy key',
      secure.decryptKey(getSS, dir, 'deepseek') === 'sk-legacy-deepseek-1' && secure.decryptKey(getSS, dir, 'generic') === 'sk-generic-000');
    check('legacy 迁移不复制到 generic namespace',
      secure.keyPath(dir, 'generic') === secure.primaryKeyPath(dir, 'generic') && fs.existsSync(path.join(dir, 'life-key'))); // 迁移只发生在 deepseek 主文件
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ===== 21. 第三方端点 + DeepSeek credential 拒绝 ===== */
  {
    const r = validateCredentialTarget({ provider: 'deepseek', baseURL: 'https://evil.example.com', credentialType: 'deepseek-api-key' });
    check('third-party endpoint + DeepSeek credential -> 拒绝', r.ok === false);
  }

  /* ===== 22-24. timeout / abort / retry / post-yield ===== */
  {
    const g = () => createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm', requestTimeoutMs: 30 }, { providerId: 'generic' });
    const m1 = mockFetch(async (u, init) => hangRes(init));
    let e1 = null;
    try { await g().complete([{ role: 'user', content: 'x' }]); } catch (e) { e1 = e; }
    check('generic timeout -> TimeoutError', e1 && e1.name === 'TimeoutError');
    globalThis.fetch = realFetch;

    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('aborted')), 10);
    const m2 = mockFetch(async (u, init) => hangRes(init));
    let e2 = null;
    try { await g().complete([{ role: 'user', content: 'x' }], { signal: ac.signal }); } catch (e) { e2 = e; }
    check('generic abort -> AbortError 语义保持', e2 && e2.name !== 'TimeoutError');
    globalThis.fetch = realFetch;

    const m3 = mockFetch(async (u, i, n) => n === 1
      ? httpRes(500, JSON.stringify({ error: { message: 'hiccup' } }))
      : okRes({ choices: [{ message: { content: 'ok' } }], usage: {}, model: 'm' }));
    const r3 = await createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 }, { providerId: 'generic' }).complete([{ role: 'user', content: 'x' }]);
    check('generic retry boundary（500 transient 重试）', r3.text === 'ok' && m3.calls === 2);
    globalThis.fetch = realFetch;

    const m4 = mockFetch(async () => httpRes(400, JSON.stringify({ error: { message: 'bad' } })));
    let e4 = null;
    try { await createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 }, { providerId: 'generic' }).complete([{ role: 'user', content: 'x' }]); } catch (e) { e4 = e; }
    check('generic retry boundary（400 不重试）', e4 && m4.calls === 1);
    globalThis.fetch = realFetch;

    const m5 = mockFetch(async () => sseRes([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"error":{"message":"mid boom"}}\n\n'
    ]));
    let e5 = null;
    try { await createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm' }, { providerId: 'generic' }).stream([{ role: 'user', content: 'x' }]); } catch (e) { e5 = e; }
    check('generic stream post-yield 不重启（1 次请求、partial 保留）', e5 && m5.calls === 1 && e5.partial === '你好');
    globalThis.fetch = realFetch;
  }

  /* ===== 25. runtime evidence adapter binding ===== */
  {
    const d = createDeepSeekAdapter({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' });
    mockFetch(async () => okRes({ choices: [{ message: { content: 'x' } }], usage: {}, model: 'obs' }));
    const dRes = await d.complete([{ role: 'user', content: 'x' }]);
    check('DeepSeek 产出仍经受信 adapter mint（binding 保持）', isProviderRuntimeResponse(dRes) === true);
    globalThis.fetch = realFetch;

    const g = createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm' }, { providerId: 'generic' });
    mockFetch(async () => okRes({ choices: [{ message: { content: 'x' } }], usage: {}, model: 'obs' }));
    const gRes = await g.complete([{ role: 'user', content: 'x' }]);
    check('Generic 产出绝不冒充 runtime evidence（无 mint）', isProviderRuntimeResponse(gRes) === false);
    globalThis.fetch = realFetch;
  }

  /* ===== 26-28. Brain candidate 失败清理 / hot-swap 回滚 / 旧 Brain 可用 ===== */
  {
    const calls = [];
    const oldBrain = {
      flushed: false, shut: false,
      flushAll() { this.flushed = true; },
      shutdown() { this.shut = true; }
    };
    let candidateCleaned = false;
    const candidate = {
      cleaned: false,
      shutdown() { this.cleaned = true; candidateCleaned = true; }
    };
    const res = swapBrain({
      oldBrain,
      oldCfg: { provider: 'deepseek', apiKey: 'sk-old' },
      nextCfg: { provider: 'generic', apiKey: 'sk-new' },
      createCandidate: () => candidate,
      bindCandidate: () => { throw new Error('bind failed'); },
      persistCfg: (c) => calls.push(c)
    });
    check('candidate 初始化失败 -> candidate 被清理（shutdown 复用）', res.ok === false && res.candidateDisposed === true && candidateCleaned);
    check('hot-swap rollback：配置回滚到旧状态', res.rolledBack === true && calls.length === 2 && calls[1].apiKey === 'sk-old');
    check('旧 Brain 仍可工作（未被 shutdown、无残留）', oldBrain.shut === false && oldBrain.flushed === false);

    // 成功路径回归：切换引用、旧 Brain 正常关闭
    const okCalls = [];
    const fresh = { shut: false, flushAll() {}, shutdown() { this.shut = true; } };
    const res2 = swapBrain({
      oldBrain,
      oldCfg: { provider: 'deepseek' },
      nextCfg: { provider: 'generic' },
      createCandidate: () => fresh,
      bindCandidate: () => {},
      persistCfg: (c) => okCalls.push(c)
    });
    check('hot-swap 成功路径：candidate 采纳、旧 Brain 关闭', res2.ok === true && res2.brain === fresh && oldBrain.shut === true);
  }

  /* ===== P5-B-01: Generic complete 全生命周期 timeout ===== */
  {
    const mk = () => createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm', requestTimeoutMs: 30 }, { providerId: 'generic' });

    // 1. 无 caller signal + fetch hang -> TimeoutError
    const m1 = mockFetch(async (u, init) => hangRes(init));
    let e1 = null;
    try { await mk().complete([{ role: 'user', content: 'x' }]); } catch (e) { e1 = e; }
    check('P5-B-01 无 caller signal + fetch hang -> TimeoutError', e1 && e1.name === 'TimeoutError' && m1.calls === 1);
    globalThis.fetch = realFetch;

    // 2. caller signal 未 abort + response body 解析阶段永久挂起 -> TimeoutError
    //（SEC-03 后 complete 走有界 body 读取，解析挂起等价场景为 body 读取永不 settle）
    const m2 = mockFetch(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: () => new Promise(() => {}), // 永久挂起的 body 读取
      json: () => new Promise(() => {})
    }));
    let e2 = null;
    const ac2 = new AbortController();
    try { await mk().complete([{ role: 'user', content: 'x' }], { signal: ac2.signal }); } catch (e) { e2 = e; }
    check('P5-B-01 fetch 已返回 + json hang -> TimeoutError（caller signal 不使 timeout 失效）', e2 && e2.name === 'TimeoutError' && m2.calls === 1);
    globalThis.fetch = realFetch;

    // 3. caller signal 主动 abort -> AbortError
    const m3 = mockFetch(async (u, init) => hangRes(init));
    const ac3 = new AbortController();
    setTimeout(() => ac3.abort(), 10);
    let e3 = null;
    try { await mk().complete([{ role: 'user', content: 'x' }], { signal: ac3.signal }); } catch (e) { e3 = e; }
    check('P5-B-01 caller signal 主动 abort -> AbortError', e3 && e3.name === 'AbortError');
    globalThis.fetch = realFetch;

    // 4. 正常 response -> success
    const m4 = mockFetch(async () => okRes({ choices: [{ message: { content: 'fine' } }], usage: {}, model: 'm' }));
    const r4 = await mk().complete([{ role: 'user', content: 'x' }]);
    check('P5-B-01 正常 response -> 正常返回', r4 && r4.text === 'fine');
    globalThis.fetch = realFetch;
  }

  /* ===== P5-C-01: credential namespace 碰撞防护（真实走 save/decrypt/keyPath） ===== */
  {
    const dir = tmpDir('p5-ns-');
    const fakeSS = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s).toString('base64'),
      decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf8').slice(4)
    };
    const getSS = () => fakeSS;

    // 1. a/b 与 a_b 不得同名
    secure.saveConfig(getSS, dir, { provider: 'a/b', apiKey: 'sk-ab-000', model: 'm' }, () => {});
    secure.saveConfig(getSS, dir, { provider: 'a_b', apiKey: 'sk-underscore-000', model: 'm' }, () => {});
    check('P5-C-01 a/b ≠ a_b（keyPath/primaryKeyPath 均不同）',
      secure.keyPath(dir, 'a/b') !== secure.keyPath(dir, 'a_b') &&
      secure.primaryKeyPath(dir, 'a/b') !== secure.primaryKeyPath(dir, 'a_b'));
    check('P5-C-01 a/b 与 a_b 各自读到自己的 credential',
      secure.decryptKey(getSS, dir, 'a/b') === 'sk-ab-000' && secure.decryptKey(getSS, dir, 'a_b') === 'sk-underscore-000');

    // 2. >64 字符、仅 64 字符之后不同 -> 仍然不同
    const longPrefix = 'q'.repeat(64);
    const pid1 = longPrefix + '-ONE';
    const pid2 = longPrefix + '-TWO';
    secure.saveConfig(getSS, dir, { provider: pid1, apiKey: 'sk-one-000', model: 'm' }, () => {});
    secure.saveConfig(getSS, dir, { provider: pid2, apiKey: 'sk-two-000', model: 'm' }, () => {});
    check('P5-C-01 64 字符截断碰撞场景仍然不同（hash 取自完整 providerId）',
      secure.primaryKeyPath(dir, pid1) !== secure.primaryKeyPath(dir, pid2) &&
      secure.decryptKey(getSS, dir, pid1) === 'sk-one-000' && secure.decryptKey(getSS, dir, pid2) === 'sk-two-000');

    // 3. A → B -> A 回读
    secure.saveConfig(getSS, dir, { provider: 'a/b', apiKey: 'sk-ab-000', model: 'm' }, () => {});
    check('P5-C-01 A→B→A 回读保持', secure.decryptKey(getSS, dir, 'a_b') === 'sk-underscore-000' && secure.decryptKey(getSS, dir, 'a/b') === 'sk-ab-000');

    // 4/5. DeepSeek legacy 只属 DeepSeek；新 Provider 读不到 legacy
    fs.writeFileSync(path.join(dir, 'gpt-girl-key'), fakeSS.encryptString('sk-legacy-ds-9'));
    check('P5-C-01 DeepSeek legacy 只属于 DeepSeek',
      secure.decryptKey(getSS, dir, 'deepseek') === 'sk-legacy-ds-9');
    check('P5-C-01 新 Provider 不得读取 DeepSeek legacy',
      secure.decryptKey(getSS, dir, 'a/b') === 'sk-ab-000' && secure.keyPath(dir, 'a/b') !== path.join(dir, 'gpt-girl-key'));

    // 6. v0 首版命名迁移：旧文件被读取并迁到新路径，不静默覆盖
    const v0Path = path.join(dir, 'life-key--' + secure.legacyV0Namespace('migrated'));
    fs.writeFileSync(v0Path, fakeSS.encryptString('sk-v0-000'));
    check('P5-C-01 v0 旧命名 credential 被迁移读取（不丢失）',
      secure.decryptKey(getSS, dir, 'migrated') === 'sk-v0-000' &&
      fs.existsSync(secure.primaryKeyPath(dir, 'migrated')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ===== P5-A: Brain 成本记账走 provider-keyed Cost Strategy ===== */
  {
    const { Brain } = require('../src/brain');
    const usageFat = { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 };
    const price = { hit: 1, miss: 2, out: 3 };

    // 1. DeepSeek 成本 parity（peak=valley 同价，结果确定 = (1+2+3)=6）
    const bd = new Brain(tmpDir(), { apiKey: KEY, model: 'm', baseURL: 'https://api.deepseek.com', provider: 'deepseek', price: { peak: price, valley: price } });
    bd.track(usageFat);
    check('P5-A DeepSeek 成本 parity（strategy 计价 = 旧 costOf 结果）',
      Math.abs(bd.stats.cost - 6) < 1e-9 && Math.abs(bd.stats.history[0].cost - 6) < 1e-9);

    // 2/3/4. Generic 无 pricing -> cost:null；不进 DeepSeek costOf；未知成本不累加
    const bg = new Brain(tmpDir(), { apiKey: KEY, model: 'm', baseURL: 'https://llm.example.com', provider: 'generic', price: { peak: price, valley: price } });
    bg.track(usageFat);
    check('P5-A Generic 无 pricing -> cost:null（绝不进 DeepSeek costOf）',
      bg.stats.history[0].cost === null && bg.stats.cost === 0);
    check('P5-A 未知成本不累加 stats.cost', bg.stats.cost === 0);

    // 5. summary bucket 未知成本保持 null semantics（token 计数照常）
    bg.track(usageFat, true, 'summary');
    const last = bg.stats.history[bg.stats.history.length - 1];
    check('P5-A summary/merge/growth 未知成本仍保持 null semantics',
      last.cost === null && bg.stats.summaryCalls === 1 && bg.stats.summaryPromptTokens > 0);
  }

  /* ===== P5-B-01 补充矩阵：不合作 fetch 与 backoff 期 timeout ===== */
  {
    // 1. fetch 永久 pending 且完全忽略 AbortSignal -> complete 仍必须有界返回
    const mk = () => createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm', requestTimeoutMs: 30 }, { providerId: 'generic' });
    const m1 = mockFetch(async () => new Promise(() => {})); // 永不 settle、无视 signal
    let e1 = null;
    try { await mk().complete([{ role: 'user', content: 'x' }]); } catch (e) { e1 = e; }
    check('P5-B-01 fetch 永久 pending + 忽略 AbortSignal -> TimeoutError（lifecycle 有界返回）',
      e1 && e1.name === 'TimeoutError' && m1.calls === 1);
    globalThis.fetch = realFetch;

    // 7. retry/backoff 期间 lifecycle timeout 仍生效
    const m7 = mockFetch(async () => httpRes(500, JSON.stringify({ error: { message: 'hiccup' } })));
    let e7 = null;
    const t0 = Date.now();
    try {
      await createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: KEY, model: 'm', requestTimeoutMs: 50, retryBaseDelayMs: 60000, maxRetries: 3 }, { providerId: 'generic' })
        .complete([{ role: 'user', content: 'x' }]);
    } catch (e) { e7 = e; }
    check('P5-B-01 retry/backoff 期间 timeout 仍生效（及时返回、不再发第二次请求）',
      e7 && e7.name === 'TimeoutError' && m7.calls === 1 && Date.now() - t0 < 5000);
    globalThis.fetch = realFetch;
  }

  /* ===== P5-C-01 补充矩阵：v0 历史碰撞归属不可证明 -> fail-closed ===== */
  {
    const dir = tmpDir('p5-ambig-');
    const fakeSS = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s).toString('base64'),
      decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf8').slice(4)
    };
    const getSS = () => fakeSS;

    // Case A: 'a/b' 与 'a_b' 映射同一 v0 路径（两个均为系统已知 provider）-> 双双 fail-closed
    registerProvider({ providerId: 'a/b', adapterFactory: () => createDeepSeekAdapter({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' }), override: true });
    registerProvider({ providerId: 'a_b', adapterFactory: () => createDeepSeekAdapter({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' }), override: true });
    const v0Ambig = path.join(dir, 'life-key--' + secure.legacyV0Namespace('a/b'));
    fs.writeFileSync(v0Ambig, fakeSS.encryptString('sk-ambiguous-000'));
    check('P5-C-01 Case A: v0 碰撞双方 decryptKey 均 fail-closed（返回 null）',
      secure.decryptKey(getSS, dir, 'a/b') === null && secure.decryptKey(getSS, dir, 'a_b') === null);
    check('P5-C-01 Case A: 不迁移、不覆盖任何新 namespace',
      !fs.existsSync(secure.primaryKeyPath(dir, 'a/b')) && !fs.existsSync(secure.primaryKeyPath(dir, 'a_b')));
    check('P5-C-01 Case A: keyPath 不回落歧义 v0（只指向新 namespace）',
      secure.keyPath(dir, 'a/b') === secure.primaryKeyPath(dir, 'a/b') && secure.keyPath(dir, 'a_b') === secure.primaryKeyPath(dir, 'a_b'));

    // Case E: 已有新 namespace + ambiguous legacy -> ambiguous 不得覆盖已有新 credential
    secure.saveConfig(getSS, dir, { provider: 'a/b', apiKey: 'sk-new-v1-000', model: 'm' }, () => {});
    check('P5-C-01 Case E: ambiguous legacy 不覆盖已有新 credential',
      secure.decryptKey(getSS, dir, 'a/b') === 'sk-new-v1-000');

    // Case B: 非碰撞 v0 provider 归属唯一 -> 正常迁移（补充显式 foo 场景）
    registerProvider({ providerId: 'foo', adapterFactory: () => createDeepSeekAdapter({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' }), override: true });
    fs.writeFileSync(path.join(dir, 'life-key--' + secure.legacyV0Namespace('foo')), fakeSS.encryptString('sk-foo-000'));
    check('P5-C-01 Case B: 非碰撞 v0 provider 正常迁移',
      secure.decryptKey(getSS, dir, 'foo') === 'sk-foo-000' && fs.existsSync(secure.primaryKeyPath(dir, 'foo')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  globalThis.fetch = realFetch;
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
