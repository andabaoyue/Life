/**
 * test/provider-adapter-p2.test.js
 *
 * v0.9.8 P2 Provider Adapter Architecture 回归：
 * Contract 完整性 / DeepSeek Adapter 行为保持 / Registry 边界 /
 * capability fail-closed / provider-policy 不可绕过 / runtime evidence binding /
 * P1 retry/timeout/abort/stream 边界保持 / Provider Type。
 *
 * fixture 仅使用假 key: sk-test-fixture-000。
 * (既有 DeepSeek 与 Research Integrity 套件的全绿由 full suite 保证。)
 */

'use strict';

const {
  PROVIDER_TYPES,
  providerTypeFor,
  validateAdapterContract,
  assertCapability,
  toUnifiedError
} = require('../src/provider-adapter');
const { createDeepSeekAdapter } = require('../src/adapters/deepseek-adapter');
const { createAdapter, getProviderInfo, listProviders, registerProvider } = require('../src/provider-registry');
const {
  buildGenerationContext,
  isProviderRuntimeResponse,
  __internal
} = require('../src/experiment-metadata');

const KEY = 'sk-test-fixture-000';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const realFetch = globalThis.fetch;
function mockFetch(handler) {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    return handler(url, init, calls);
  };
  return { get calls() { return calls; } };
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
function sseRes(frames) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200, headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= frames.length) return { done: true, value: undefined };
          return { done: false, value: enc.encode(frames[i++]) };
        },
        cancel: async () => { i = frames.length; }
      })
    }
  };
}

const baseCfg = () => ({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 });

(async () => {
  /* ============ 1-2. Contract 完整性（不品牌专属） ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    const contract = validateAdapterContract(adapter);
    check('DeepSeek Adapter 实现完整 contract', contract.ok === true && contract.missing.length === 0);
    check('六项必需方法齐备 (healthCheck 可选)',
      ['complete', 'stream', 'validateConfig', 'capabilities', 'normalizeError', 'usage'].every(m => typeof adapter[m] === 'function'));
    const fakeGeneric = {
      providerId: 'generic-x',
      complete() {}, stream() {}, validateConfig() {}, capabilities() {}, normalizeError() {}, usage() {}
    };
    check('非 DeepSeek 的假 adapter 亦可通过 contract（契约不品牌专属）', validateAdapterContract(fakeGeneric).ok === true);
  }

  /* ============ 3-4. complete()/stream() 可调用 ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    const m = mockFetch(async () => okRes({
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 7, completion_tokens: 3 },
      model: 'deepseek-chat'
    }));
    const res = await adapter.complete([{ role: 'user', content: 'hi' }]);
    check('complete() 可调用并返回统一形状', res && res.text === 'hello' && res.observedModel === 'deepseek-chat');
    globalThis.fetch = realFetch;

    const m2 = mockFetch(async () => sseRes(['data: {"choices":[{"delta":{"content":"你好"}}]}\n\n', 'data: [DONE]\n\n']));
    const out = await adapter.stream([{ role: 'user', content: 'hi' }]);
    check('stream() 可调用并返回完整文本', out && out.text === '你好');
    globalThis.fetch = realFetch;
  }

  /* ============ 5-6. validateConfig ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    check('validateConfig() 合法配置 -> ok', adapter.validateConfig().ok === true);
    const bad = createDeepSeekAdapter({ baseURL: 'https://api.deepseek.com', model: 'm' });
    const r = bad.validateConfig();
    check('validateConfig() 缺 apiKey -> ok:false 且不泄漏值', r.ok === false && r.problems.includes('apiKey missing') && !JSON.stringify(r).includes('undefined'));
  }

  /* ============ 7. capabilities 声明 ============ */
  {
    const caps = createDeepSeekAdapter(baseCfg()).capabilities();
    check('capabilities() 正确声明已实现能力', caps.streaming === true && caps.usage === true && caps.systemMessage === true);
    check('capabilities() 未实现能力不虚报', caps.vision === false && caps.tools === false && caps.jsonMode === false);
  }

  /* ============ 8. capability fail-closed ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    adapter.capabilities = () => ({ streaming: false });
    const m = mockFetch(async () => sseRes([]));
    let err = null;
    try { await adapter.stream([{ role: 'user', content: 'hi' }]); } catch (e) { err = e; }
    check('unsupported capability -> stream() fail-closed 且不发网络请求',
      err && err.name === 'UnsupportedCapabilityError' && m.calls === 0);
    globalThis.fetch = realFetch;
    let thrown = null;
    try { assertCapability({ providerId: 'x', capabilities: () => ({ vision: false }) }, 'vision'); } catch (e) { thrown = e; }
    check('vision 未声明 -> 调用前拒绝', thrown && thrown.errorType === 'unsupported_capability');
  }

  /* ============ 9-10. normalizeError 统一形态与 raw body 边界 ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    const m = mockFetch(async () => httpRes(401, JSON.stringify({ error: { message: 'bad key ' + KEY } })));
    let err = null;
    try { await adapter.complete([{ role: 'user', content: 'hi' }]); } catch (e) { err = e; }
    check('normalizeError 保持统一错误字段', err && err.name === 'ProviderError' && err.status === 401 &&
      err.provider === 'deepseek' && err.requestStage === 'request' && err.retryable === false &&
      err.errorType === 'auth_failed' && err.retryState);
    check('normalizeError 保持 P1 raw body 边界 (无 secret)', err && !String(err.message).includes(KEY));
    globalThis.fetch = realFetch;
    const wrapped = toUnifiedError(new Error('plain boom'), 'deepseek');
    check('toUnifiedError 包装普通错误为统一形态', wrapped.name === 'ProviderError' && wrapped.errorType === 'unknown_error');
  }

  /* ============ 11. usage() ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    mockFetch(async () => okRes({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 7, completion_tokens: 3 },
      model: 'm'
    }));
    await adapter.complete([{ role: 'user', content: 'hi' }]);
    const u = adapter.usage();
    check('usage() 能取得当前 DeepSeek usage', u && u.prompt_cache_hit_tokens === 5 && u.completion_tokens === 3);
    globalThis.fetch = realFetch;
  }

  /* ============ 12-14. Registry ============ */
  {
    const adapter = createAdapter('deepseek', baseCfg());
    check('Registry 通过 stable provider id 创建 DeepSeek Adapter', adapter && adapter.providerId === 'deepseek');
    check('Registry 元数据可查 (display 仅 UI 非 research truth)',
      getProviderInfo('deepseek') && getProviderInfo('deepseek').display.name === 'DeepSeek' && listProviders().includes('deepseek'));
    registerProvider({ providerId: 'fixture-x', adapterFactory: () => createDeepSeekAdapter(baseCfg()), display: { name: 'X' }, apiKey: KEY });
    check('Registry 不持有 secret（传入亦不保存）', !JSON.stringify(getProviderInfo('fixture-x')).includes(KEY));
    check('Registry 不是 runtime evidence 信任根 (无 mint API)',
      typeof require('../src/provider-registry').markProviderRuntimeResponse === 'undefined');
    let thrown = null;
    try { createAdapter('no-such-provider', baseCfg()); } catch (e) { thrown = e; }
    check('未知 provider id -> UnknownProviderError', thrown && thrown.name === 'UnknownProviderError');
    globalThis.fetch = realFetch;
  }

  /* ============ 15-16. Provider Policy 不可绕过 ============ */
  {
    const adapter = createDeepSeekAdapter({ baseURL: 'http://evil.example.com', apiKey: KEY, model: 'm', credentialType: 'deepseek-api-key' });
    const m = mockFetch(async () => okRes({}));
    let err = null;
    try { await adapter.complete([{ role: 'user', content: 'hi' }]); } catch (e) { err = e; }
    check('Adapter 不能绕过 Provider Policy（公网 HTTP -> 拦截、0 请求）', err && m.calls === 0 && err.errorType === 'policy_violation');
    globalThis.fetch = realFetch;

    const adapter2 = createDeepSeekAdapter({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', credentialType: 'apiKey' });
    const m2 = mockFetch(async () => okRes({}));
    let err2 = null;
    try { await adapter2.complete([{ role: 'user', content: 'hi' }]); } catch (e) { err2 = e; }
    check('endpoint/credential mismatch 仍 fail-closed（0 请求）', err2 && m2.calls === 0);
    globalThis.fetch = realFetch;
  }

  /* ============ 17-19. Research Integrity 保持 ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    mockFetch(async () => okRes({ choices: [{ message: { content: 'x' } }], usage: {}, model: 'observed-model' }));
    const res = await adapter.complete([{ role: 'user', content: 'hi' }]);
    check('runtime evidence 仍绑定 trusted adapter (mint 未外泄)', isProviderRuntimeResponse(res) === true);
    globalThis.fetch = realFetch;

    const ctxOk = buildGenerationContext({
      kind: 'dream',
      cfg: { model: 'm', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
      providerResponse: res,
      generatedAt: 1000
    });
    check('adapter 产出 + provider=deepseek -> provider_response 通过', ctxOk.observedModelSource === 'provider_response');

    const ctxMismatch = buildGenerationContext({
      kind: 'dream',
      cfg: { model: 'm', baseURL: 'https://api.openai.com/v1', provider: 'openai' },
      providerResponse: res,
      generatedAt: 1000
    });
    check('adapter/provider mismatch 仍 fail-closed（不冒充 provider_response）', ctxMismatch.observedModelSource !== 'provider_response');

    const ctxFake = buildGenerationContext({
      kind: 'dream',
      cfg: { model: 'm', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
      providerResponse: { observedModel: 'fake-model' },
      generatedAt: 1000
    });
    check('caller-supplied metadata 不能升级 runtime evidence', ctxFake.observedModelSource === 'caller_or_config');
  }

  /* ============ 20-23. P1 行为保持 ============ */
  {
    const adapter = createDeepSeekAdapter(baseCfg());
    const m = mockFetch(async (u, init) => hangRes(init));
    let err = null;
    try {
      await createDeepSeekAdapter({ ...baseCfg(), requestTimeoutMs: 30 }).complete([{ role: 'user', content: 'hi' }]);
    } catch (e) { err = e; }
    check('timeout 行为保持（TimeoutError 原语义不被包装）', err && err.name === 'TimeoutError');
    globalThis.fetch = realFetch;

    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('aborted')), 10);
    let err2 = null;
    try {
      await createDeepSeekAdapter(baseCfg()).complete([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    } catch (e) { err2 = e; }
    check('abort 行为保持（AbortError 原语义不被包装）', err2 && err2.name !== 'TimeoutError');
    globalThis.fetch = realFetch;

    const m3 = mockFetch(async (u, i, n) => n === 1
      ? httpRes(500, JSON.stringify({ error: { message: 'hiccup' } }))
      : okRes({ choices: [{ message: { content: 'ok' } }], usage: {}, model: 'm' }));
    const res3 = await createDeepSeekAdapter(baseCfg()).complete([{ role: 'user', content: 'hi' }]);
    check('P1 retry 行为保持（500 -> 重试成功）', res3 && res3.text === 'ok' && m3.calls === 2 && res3.attempts === 2);
    globalThis.fetch = realFetch;

    const m4 = mockFetch(async () => sseRes([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"error":{"message":"mid boom"}}\n\n'
    ]));
    let err4 = null;
    try { await createDeepSeekAdapter(baseCfg()).stream([{ role: 'user', content: 'hi' }]); } catch (e) { err4 = e; }
    check('stream post-yield failure 不重启生成（1 次请求、partial 保留）', err4 && m4.calls === 1 && err4.partial === '你好');
    globalThis.fetch = realFetch;
  }

  /* ============ 24-28. Provider Type（连接/能力类型 ≠ 品牌） ============ */
  {
    check('deepseek 官方端点 -> cloud-direct', providerTypeFor('https://api.deepseek.com/v1') === 'cloud-direct');
    check('local 端点 -> local', providerTypeFor('http://127.0.0.1:8080/v1') === 'local');
    check('第三方 https 端点 -> openai-compatible', providerTypeFor('https://llm.example.com/v1') === 'openai-compatible');
    check('无效 URL -> custom', providerTypeFor('not a url') === 'custom');
    check('PROVIDER_TYPES 四值齐全', PROVIDER_TYPES.includes('cloud-direct') && PROVIDER_TYPES.includes('openai-compatible') &&
      PROVIDER_TYPES.includes('local') && PROVIDER_TYPES.includes('custom'));
  }

  globalThis.fetch = realFetch;
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
