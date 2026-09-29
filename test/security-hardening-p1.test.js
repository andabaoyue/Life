/**
 * test/security-hardening-p1.test.js
 *
 * v0.9.8 P1 Security Hardening 回归：
 * Credential 泄漏面 / Secret Redaction / Provider Error 归一化 /
 * Retry（分类/cap/退避/Retry-After）/ Budget Guard / Endpoint Policy / Timeout-Abort 边界。
 *
 * 全部 fixture 只使用假 key: sk-test-fixture-000，绝不使用任何真实 credential。
 */

'use strict';

const { redactSecrets } = require('../src/redact');
const { assertBudget } = require('../src/budget-guard');
const { DeepSeek } = require('../src/deepseek');
const { buildGenerationContext } = require('../src/experiment-metadata');
// v0.9.8 C-01: 测试以「provider adapter 仿真」身份经专用信任根铸造（公共 metadata API 无任何铸造途径）
const { createProviderRuntimeMintAuthority } = require('../src/provider-runtime-trust');

const KEY = 'sk-test-fixture-000';
// SEC-06: 铸造器绑定「实现 Provider Adapter 契约的 runtime identity 对象」，不再凭 provider string 领取
const mintDeepseek = createProviderRuntimeMintAuthority('deepseek', { complete() {}, stream() {}, normalizeError() {} });

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* ---- fetch mock 基础设施 ---- */
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
function okRes(payload) {
  return httpRes(200, JSON.stringify(payload));
}
function hangRes(init) {
  return new Promise((_, reject) => {
    if (init && init.signal) {
      const s = init.signal;
      if (s.aborted) { reject(s.reason instanceof Error ? s.reason : new Error('aborted')); return; }
      s.addEventListener('abort', () => {
        reject(s.reason instanceof Error ? s.reason : new Error('aborted'));
      }, { once: true });
    }
  });
}
function sseRes(frames) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= frames.length) return { done: true, value: undefined };
          const frame = frames[i++];
          if (frame instanceof Error) throw frame;
          return { done: false, value: enc.encode(frame) };
        },
        cancel: async () => { i = frames.length; }
      })
    }
  };
}

(async () => {
  /* ================= 1. Credential 泄漏面 ================= */
  {
    // fake key 不进入 error message（provider 错误体回显 key 也必须被清理）
    const m = mockFetch(async () => httpRes(400, JSON.stringify({ error: { message: 'bad key ' + KEY } })));
    let err = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' })
        .complete([{ role: 'user', content: 'hi' }]);
    } catch (e) { err = e; }
    check('fake key 不进入 error message', err && !String(err.message).includes(KEY));
    check('错误归一化保留 status 与 errorType', err && err.status === 400 && err.errorType === 'request_rejected' && err.name === 'ProviderError');
    check('400 标记 non-retryable', err && err.retryable === false);
    globalThis.fetch = realFetch;

    // fake key 不进入 log / diagnostics（message / 序列化字段面）
    const diagSurface = JSON.stringify(err, Object.getOwnPropertyNames(err));
    check('fake key 不进入 diagnostics 序列化面', !diagSurface.includes(KEY));
    check('redactSecrets 清理 log 形态字符串', !redactSecrets('request with key=' + KEY + ' failed').includes(KEY));

    // fake key 不进入 archive / snapshot / generation context
    const ctx = buildGenerationContext({
      kind: 'dream',
      cfg: { model: 'configured-model', baseURL: 'https://api.deepseek.com', provider: 'deepseek', apiKey: KEY },
      providerResponse: mintDeepseek({ observedModel: 'observed-model', text: 'x' }),
      promptHashes: { dream: 'sha256:x' },
      generatedAt: 1000
    });
    check('fake key 不进入 GenerationContext (研究/归档记录)', !JSON.stringify(ctx).includes(KEY));
  }

  /* ================= 2. Secret Redaction ================= */
  {
    check('Bearer token 被 redact', redactSecrets('Authorization: Bearer abc123def456') === 'Authorization: Bearer [REDACTED]' || !redactSecrets('Authorization: Bearer abc123def456').includes('abc123def456'));
    check('cookie/credential 形态被 redact', !redactSecrets('Cookie: session=abcdef123456; token=tok-999999').includes('abcdef123456'));
    const obj = redactSecrets({ headers: { Authorization: 'Bearer zzz8888' }, model: 'm', nested: { api_key: 'sk-abc-123456' } });
    check('object 输入保持普通字段结构', obj.model === 'm' && obj.headers && obj.nested);
    check('object 敏感键名/键值被清理', obj.headers.Authorization === '[REDACTED]' && obj.nested.api_key === '[REDACTED]');
    check('redactSecrets 对任意输入不抛异常', (() => {
      try {
        redactSecrets(undefined); redactSecrets(123); redactSecrets({ a: { b: [KEY] } }); redactSecrets(Symbol ? 'x' : 'x');
        return true;
      } catch { return false; }
    })());
  }

  /* ================= 3. Retry 分类与边界 ================= */
  {
    // HTTP 500/502/503/504 可 retry（第 2 次成功）
    for (const status of [500, 502, 503, 504]) {
      const m = mockFetch(async (u, i, n) => n === 1
        ? httpRes(status, JSON.stringify({ error: { message: 'server hiccup' } }))
        : okRes({ choices: [{ message: { content: 'ok' } }], usage: {}, model: 'm' }));
      let res = null;
      try {
        res = await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 })
          .complete([{ role: 'user', content: 'hi' }]);
      } catch {}
      check(`HTTP ${status} transient -> retry 后成功`, res && res.text === 'ok' && m.calls === 2);
      globalThis.fetch = realFetch;
    }

    // 429 + Retry-After 正确处理（尊重 Retry-After 后重试成功）
    {
      const m = mockFetch(async (u, i, n) => n === 1
        ? httpRes(429, JSON.stringify({ error: { message: 'rate limited' } }), { 'retry-after': '0' })
        : okRes({ choices: [{ message: { content: 'ok429' } }], usage: {}, model: 'm' }));
      const res = await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 })
        .complete([{ role: 'user', content: 'hi' }]);
      check('429 + Retry-After -> 重试成功且次数可追踪', res && res.text === 'ok429' && res.attempts === 2 && m.calls === 2);
      globalThis.fetch = realFetch;
    }

    // Retry-After 过长 -> 不重试（fail-fast），retryState 记录 Retry-After
    {
      const m = mockFetch(async () => httpRes(429, JSON.stringify({ error: { message: 'slow down' } }), { 'retry-after': '3600' }));
      let err = null;
      try {
        await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 })
          .complete([{ role: 'user', content: 'hi' }]);
      } catch (e) { err = e; }
      check('429 + 超长 Retry-After -> 不重试', err && m.calls === 1 && err.errorType === 'rate_limited');
      check('Retry-After 进入 retryState 诊断面', err && err.retryState && err.retryState.retryAfterMs === 3600000);
      globalThis.fetch = realFetch;
    }

    // 400 / 401 / 403 不 retry
    for (const status of [400, 401, 403]) {
      const m = mockFetch(async () => httpRes(status, JSON.stringify({ error: { message: 'nope ' + KEY } })));
      let err = null;
      try {
        await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 })
          .complete([{ role: 'user', content: 'hi' }]);
      } catch (e) { err = e; }
      check(`HTTP ${status} non-retryable -> 仅 1 次请求`, err && m.calls === 1);
      globalThis.fetch = realFetch;
    }

    // retry 次数 hard cap（配置 maxRetries=10 仍被压到 3 → 共 4 次尝试）
    {
      const m = mockFetch(async () => httpRes(500, JSON.stringify({ error: { message: 'down' } })));
      let err = null;
      try {
        await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', maxRetries: 10, retryBaseDelayMs: 0 })
          .complete([{ role: 'user', content: 'hi' }]);
      } catch (e) { err = e; }
      check('retry 次数有 hard cap (≤3 retries)', err && m.calls === 4);
      check('retry 次数进入 retryState 诊断面', err && err.retryState && err.retryState.attempts === 4 && err.retryState.maxRetries === 3);
      globalThis.fetch = realFetch;
    }
  }

  /* ================= 4. Budget Guard ================= */
  {
    // 超预算 -> 完全不发 fetch
    const m = mockFetch(async () => okRes({ choices: [{ message: { content: 'x' } }], usage: {}, model: 'm' }));
    let err = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', budgetMaxOutputTokens: 100 })
        .complete([{ role: 'user', content: 'hi' }], { maxTokens: 400 });
    } catch (e) { err = e; }
    check('budget 超限 fail-closed，完全不发 fetch', err && err.name === 'BudgetExceededError' && m.calls === 0);
    globalThis.fetch = realFetch;

    // retry 不得绕过预算（最坏情况含 retry 即超限 -> 0 次请求）
    const m2 = mockFetch(async () => okRes({ choices: [{ message: { content: 'x' } }], usage: {}, model: 'm' }));
    let err2 = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', maxRetries: 2, budgetMaxOutputTokens: 250 })
        .complete([{ role: 'user', content: 'hi' }], { maxTokens: 100 });
    } catch (e) { err2 = e; }
    check('retry 不会绕过预算限制 (worst-case 含 retry)', err2 && err2.name === 'BudgetExceededError' && m2.calls === 0);
    globalThis.fetch = realFetch;

    // assertBudget 单元：未配置预算不设限；配置后按 worst-case 拦截
    check('budget 未配置 -> 不设限', assertBudget({ maxTokens: 900 }).ok === true);
    check('budget worst-case 判定', assertBudget({ maxTokens: 100, attempt: 0, maxRetries: 2, budgetMaxOutputTokens: 250 }).ok === false &&
      assertBudget({ maxTokens: 100, attempt: 0, maxRetries: 2, budgetMaxOutputTokens: 400 }).ok === true);
  }

  /* ================= 5. Endpoint Policy ================= */
  {
    // endpoint policy failure -> 不 retry、不发请求
    const m = mockFetch(async () => okRes({}));
    let err = null;
    try {
      await new DeepSeek({ baseURL: 'http://evil.example.com', apiKey: KEY, model: 'm', credentialType: 'deepseek-api-key' })
        .complete([{ role: 'user', content: 'hi' }]);
    } catch (e) { err = e; }
    check('endpoint policy failure -> 不进入 retry 且不发请求', err && m.calls === 0 && err.errorType === 'policy_violation');
    check('policy 错误标记 non-retryable', err && err.retryable === false);
    globalThis.fetch = realFetch;
  }

  /* ================= 6. Streaming Retry 边界 ================= */
  {
    // pre-yield transient -> 允许 retry（请求建立阶段）
    const m = mockFetch(async (u, i, n) => n === 1
      ? httpRes(503, JSON.stringify({ error: { message: 'starting' } }))
      : sseRes(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']));
    let out = null;
    try {
      out = await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 })
        .stream([{ role: 'user', content: 'hi' }]);
    } catch {}
    check('stream pre-yield transient -> retry 后成功', out && out.text === 'hi' && m.calls === 2);
    globalThis.fetch = realFetch;

    // 已交付生成内容后失败 -> 绝不从头重试
    const m2 = mockFetch(async () => sseRes([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"error":{"message":"mid-stream boom"}}\n\n'
    ]));
    let err = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', retryBaseDelayMs: 0 })
        .stream([{ role: 'user', content: 'hi' }]);
    } catch (e) { err = e; }
    check('stream 已交付内容后失败 -> 不重复启动整条生成 (仅 1 次请求)', err && m2.calls === 1);
    check('stream 中断保留已交付 partial', err && err.partial === '你好');
    globalThis.fetch = realFetch;

    // in-band 流错误消息中的 secret 被 redact
    const m3 = mockFetch(async () => sseRes(['data: {"error":{"message":"bad key ' + KEY + '"}}\n\n']));
    let err3 = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' })
        .stream([{ role: 'user', content: 'hi' }]);
    } catch (e) { err3 = e; }
    check('in-band 流错误消息中的 fake key 被 redact', err3 && !String(err3.message).includes(KEY));
    globalThis.fetch = realFetch;
  }

  /* ================= 7. Timeout / Abort 既有语义保持 ================= */
  {
    // request timeout -> TimeoutError
    const m = mockFetch(async (u, init) => hangRes(init));
    let err = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', requestTimeoutMs: 30 })
        .complete([{ role: 'user', content: 'hi' }]);
    } catch (e) { err = e; }
    check('request timeout -> TimeoutError（既有语义不变）', err && err.name === 'TimeoutError');
    globalThis.fetch = realFetch;

    // caller abort -> AbortError
    const m2 = mockFetch(async (u, init) => hangRes(init));
    const ac = new AbortController();
    let err2 = null;
    setTimeout(() => ac.abort(new Error('aborted')), 10);
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' })
        .complete([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    } catch (e) { err2 = e; }
    check('caller abort -> AbortError（既有语义不变）', err2 && err2.name !== 'TimeoutError');
    globalThis.fetch = realFetch;
  }

  /* ================= 8. P1.1 残余面收口 ================= */
  {
    // A: 对象形式 credential 的敏感键名识别
    const r = redactSecrets({
      apiKey: 'custom-secret', token: 'tok-x', secret: 's-x',
      password: 'pw-x', credential: 'c-x', accessToken: 'at-x', model: 'm'
    });
    check('P1.1-A {apiKey:"custom-secret"} -> [REDACTED]', r.apiKey === '[REDACTED]');
    check('P1.1-A token/secret/password/credential/accessToken -> [REDACTED]',
      r.token === '[REDACTED]' && r.secret === '[REDACTED]' && r.password === '[REDACTED]' &&
      r.credential === '[REDACTED]' && r.accessToken === '[REDACTED]');
    check('P1.1-A 普通非敏感字段不改变', r.model === 'm');
    const nested = redactSecrets({ a: [{ api_key: 'k1-keep-out', keep: 'v' }], b: { deep: { passwd: 'pw-keep-out' } } });
    check('P1.1-A 嵌套 object/array 继续递归', nested.a[0].api_key === '[REDACTED]' && nested.a[0].keep === 'v' && nested.b.deep.passwd === '[REDACTED]');
    check('P1.1-A 敏感值不出现在序列化结果',
      !JSON.stringify(nested).includes('k1-keep-out') && !JSON.stringify(r).includes('custom-secret'));
    check('P1.1-A 敏感键名大小写不敏感', redactSecrets({ ApiKey: 'x', ACCESS_TOKEN: 'y' }).ApiKey === '[REDACTED]' &&
      redactSecrets({ ACCESS_TOKEN: 'y' }).ACCESS_TOKEN === '[REDACTED]');
  }

  {
    // B: 非 JSON provider body —— 绝不 raw body fallback
    const rawBody = 'oops raw body leaked ' + KEY + ' end';
    const m = mockFetch(async () => httpRes(500, rawBody));
    let err = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm', maxRetries: 0 })
        .complete([{ role: 'user', content: 'hi' }]);
    } catch (e) { err = e; }
    check('P1.1-B 非 JSON body -> ProviderError (status=500, server_error)', err && err.name === 'ProviderError' && err.status === 500 && err.errorType === 'server_error');
    check('P1.1-B 非 JSON body -> retryState 正常', err && err.retryState && err.retryState.attempts === 1 && err.retryState.maxRetries === 0);
    check('P1.1-B error.message 不含 fake secret', err && !String(err.message).includes(KEY));
    check('P1.1-B 不产生 raw body fallback', err && !String(err.message).includes('oops raw body'));
    globalThis.fetch = realFetch;
  }

  {
    // C: JSON 结构化 detail 保留 + redact + 120 字符上限
    const m = mockFetch(async () => httpRes(400, JSON.stringify({ error: { message: 'safe provider message' } })));
    let err = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' })
        .complete([{ role: 'user', content: 'hi' }]);
    } catch (e) { err = e; }
    check('P1.1-B JSON 结构化 message 保留为 safeDetail', err && String(err.message).includes('safe provider message'));
    globalThis.fetch = realFetch;

    const m2 = mockFetch(async () => httpRes(400, JSON.stringify({ error: { message: 'key=' + KEY + ' ' + 'L'.repeat(500) } })));
    let err2 = null;
    try {
      await new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: KEY, model: 'm' })
        .complete([{ role: 'user', content: 'hi' }]);
    } catch (e) { err2 = e; }
    check('P1.1-B JSON detail 仍过 redact', err2 && !String(err2.message).includes(KEY));
    check('P1.1-B safeDetail 120 字符上限成立', err2 && !String(err2.message).includes('L'.repeat(200)));
    globalThis.fetch = realFetch;
  }

  {
    // A-01: 复合对象键后缀匹配 + 典型平台 token 形态
    const r = redactSecrets({ dbPassword: 'pw1', sessionToken: 'tok1', clientSecret: 'sec1', privateKey: 'pk1', my_api_key: 'k1', keep: 'v' });
    check('A-01 复合对象键（*password/*token/*secret/*key）后缀匹配脱敏',
      r.dbPassword === '[REDACTED]' && r.sessionToken === '[REDACTED]' && r.clientSecret === '[REDACTED]' &&
      r.privateKey === '[REDACTED]' && r.my_api_key === '[REDACTED]');
    check('A-01 非敏感键不受后缀匹配影响', r.keep === 'v');
    const gh = 'ghp_' + 'a'.repeat(20);
    const aws = 'AKIA' + 'B'.repeat(16);
    check('A-01 GitHub PAT 形态脱敏', !redactSecrets('leak ' + gh + ' end').includes(gh));
    check('A-01 AWS Access Key 形态脱敏', !redactSecrets('leak ' + aws + ' end').includes(aws));
  }

  globalThis.fetch = realFetch;
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
