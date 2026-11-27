/**
 * test/v22c-local-slm-probe.test.js
 *
 * v2.2-c 门禁：本地 SLM 原生探活与离线轻陪伴双过程容灾隔离
 *
 * 覆盖：
 *  1. probeLocalEndpoint：Ollama /api/tags、llama-server /v1/models、/health 回落、:latest 匹配与缺失告警
 *  2. SSRF 与安全硬边界：非回环拒绝、512KB 响应截断、HTTP 重定向阻断、超时、连接拒绝、零云端凭据外带
 *  3. 免 Key 本地连接闭环：resolveRuntimeCfg / validateConfig / connection-test Phase 2（零推理探测）
 *  4. FallbackAdapter 双过程路由：isSecondaryLocal / isPrimaryDegraded / allowLocalFallback=false 阻断 complete 放行 stream
 *  5. 端到端 Brain：降级尾部诚实事实行注入（systemText 前缀逐字节恒等、history 无污染）、关窗/合并/成长/梦境安全延后与 unlock 开关
 *  6. IPC connections:probe-local 经 ipcGuard 收口、preload 暴露、D-001 零定时器静态扫描
 */
const Module = require('module');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// [tmp-hygiene] 包住 fs.mkdtempSync 本身并于 exit 时统一清退
const _tmpHygieneDirs = [];
const _tmpHygieneOrig = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _tmpHygieneOrig.apply(fs, a);
  _tmpHygieneDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _tmpHygieneDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdtempSync = _tmpHygieneOrig;
});

const ROOT = path.join(__dirname, '..');
const { probeLocalEndpoint, MAX_PROBE_BYTES } = require('../src/local-probe');
const { createOpenAICompatibleAdapter } = require('../src/adapters/openai-compatible-adapter');
const { createConnection, resolveRuntimeCfg, loadStore } = require('../src/connections');
const { runConnectionTest } = require('../src/connection-test');
const { createFallbackAdapter } = require('../src/fallback-adapter');
const { createCircuitBreaker } = require('../src/circuit-breaker');
const { DEFAULTS, sanitize } = require('../src/config');
const { Brain } = require('../src/brain');
const { synthesizeDream } = require('../src/dream-system');
const { createIpcGuard } = require('../src/ipc-guard');
const { createConnectionsController } = require('../src/main-connections-ipc');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ srv, port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(srv) {
  return new Promise((resolve) => {
    if (!srv) { resolve(); return; }
    srv.close(() => resolve());
  });
}

function makeMockAdapter(providerId, baseURL, handlers = {}) {
  let completeCalls = 0;
  let streamCalls = 0;
  return {
    providerId,
    providerType: 'openai-compatible',
    cfg: { baseURL, apiKey: providerId === 'local' ? '' : 'sk-cloud-test', model: 'test-model' },
    get completeCalls() { return completeCalls; },
    get streamCalls() { return streamCalls; },
    validateConfig() { return { ok: true, problems: [] }; },
    capabilities() { return { streaming: true, usage: true }; },
    normalizeError(e) { return e; },
    usage() { return { prompt_tokens: 5, completion_tokens: 5 }; },
    async complete(msgs, opts) {
      completeCalls++;
      if (handlers.onComplete) return await handlers.onComplete(msgs, opts);
      return { text: 'ok-' + providerId, usage: { prompt_tokens: 5, completion_tokens: 5 }, observedModel: 'test-model' };
    },
    async stream(msgs, onDelta, opts) {
      streamCalls++;
      if (handlers.onStream) return await handlers.onStream(msgs, onDelta, opts);
      if (typeof onDelta === 'function') onDelta('local-hi');
      return { text: 'local-hi', usage: { prompt_tokens: 5, completion_tokens: 5 }, observedModel: 'test-model' };
    }
  };
}

(async () => {
  /* ============ 1. Ollama /api/tags & OpenAI-local /models /health 原生探活 ============ */
  {
    const seenHeaders = [];
    const { srv, origin } = await startServer((req, res) => {
      seenHeaders.push({ url: req.url, auth: req.headers.authorization || null });
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:latest' }, { name: 'llama3.2:3b' }] }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    try {
      const rMatch = await probeLocalEndpoint(`${origin}/v1`, { expectedModel: 'qwen2.5' });
      const rMiss = await probeLocalEndpoint(`${origin}/v1`, { expectedModel: 'missing-7b' });
      check('1a Ollama /api/tags 原生探活成功且去 :latest 匹配模型并零凭据头',
        rMatch.ok === true && rMatch.reachable === true && rMatch.serverKind === 'ollama' &&
        rMatch.modelMatched === true && rMatch.models.includes('qwen2.5:latest') &&
        seenHeaders.length === 2 && seenHeaders.every((h) => h.auth === null));
      check('1b Ollama 在线但指定模型缺失返回 LOCAL_MODEL_NOT_FOUND',
        rMiss.ok === false && rMiss.reachable === true && rMiss.modelMatched === false &&
        rMiss.reason === 'LOCAL_MODEL_NOT_FOUND' && rMiss.models.length === 2);
    } finally {
      await closeServer(srv);
    }
  }

  {
    // llama-server /v1/models 回落
    const { srv, origin } = await startServer((req, res) => {
      if (req.url === '/api/tags') { res.writeHead(404); res.end('no'); return; }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gemma-3-4b-it' }] }));
        return;
      }
      res.writeHead(404); res.end('no');
    });
    try {
      const r = await probeLocalEndpoint(`${origin}/v1/`, { expectedModel: 'gemma-3-4b-it' });
      check('1c llama-server /v1/models 回落探活成功',
        r.ok === true && r.reachable === true && r.serverKind === 'openai-local' &&
        r.modelMatched === true && r.models[0] === 'gemma-3-4b-it');
    } finally {
      await closeServer(srv);
    }
  }

  {
    // /health 最小存活兜底
    const { srv, origin } = await startServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      res.writeHead(404); res.end('no');
    });
    try {
      const r = await probeLocalEndpoint(`${origin}/v1`, { expectedModel: 'any-model' });
      check('1d /health 兜底探活返回 reachable=true 且 modelMatched=null（诚实未知）',
        r.ok === true && r.reachable === true && r.serverKind === 'openai-local' &&
        Array.isArray(r.models) && r.models.length === 0 && r.modelMatched === null);
    } finally {
      await closeServer(srv);
    }
  }

  /* ============ 2. SSRF 守卫、512KB 上限、重定向阻断、超时与不可达 ============ */
  {
    let stubCalls = 0;
    const stubFetch = async () => { stubCalls++; throw new Error('should not fetch'); };
    const targets = [
      'https://api.deepseek.com/v1',
      'http://192.168.1.10:11434/v1',
      'http://169.254.169.254/latest/meta-data',
      'https://example.com/v1',
      'ftp://localhost:11434/v1',
      'not-a-valid-url'
    ];
    const results = await Promise.all(targets.map((u) => probeLocalEndpoint(u, { fetchImpl: stubFetch })));
    check('2a 非回环/非法地址全部在发请求前被 SSRF 守卫拦截（0 fetch）',
      stubCalls === 0 && results.every((r) => r.ok === false && r.reachable === false && r.reason === 'NON_LOCAL_HOST_REJECTED'));
  }

  {
    // 512KB 超限拦截
    const oversized = JSON.stringify({ models: [{ name: 'x'.repeat(MAX_PROBE_BYTES + 2048) }] });
    const { srv, origin } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(oversized);
    });
    try {
      const r = await probeLocalEndpoint(`${origin}/v1`);
      check('2b 响应体超过 512KB 硬上限触发 LOCAL_PROBE_RESPONSE_TOO_LARGE',
        r.ok === false && r.reachable === false && r.reason === 'LOCAL_PROBE_RESPONSE_TOO_LARGE');
    } finally {
      await closeServer(srv);
    }
  }

  {
    // HTTP 重定向阻断
    const { srv, origin } = await startServer((req, res) => {
      res.writeHead(302, { Location: 'https://evil.example.com/steal' });
      res.end();
    });
    try {
      const r = await probeLocalEndpoint(`${origin}/v1`);
      check('2c 本地端点返回 302 重定向被 redirect:error 拦截（LOCAL_PROBE_REDIRECT_BLOCKED）',
        r.ok === false && r.reachable === false && r.reason === 'LOCAL_PROBE_REDIRECT_BLOCKED');
    } finally {
      await closeServer(srv);
    }
  }

  {
    // 超时与端口未监听
    let openTimer = null;
    const { srv, port, origin } = await startServer((req, res) => {
      openTimer = setTimeout(() => { try { res.end('{}'); } catch {} }, 1000);
    });
    try {
      const rTimeout = await probeLocalEndpoint(`${origin}/v1`, { timeoutMs: 120 });
      check('2d 探活超时归一化为 LOCAL_PROBE_TIMEOUT（不抛异常）',
        rTimeout.ok === false && rTimeout.reachable === false && rTimeout.reason === 'LOCAL_PROBE_TIMEOUT');
    } finally {
      if (openTimer) clearTimeout(openTimer);
      await closeServer(srv);
    }
    const rClosed = await probeLocalEndpoint(`http://127.0.0.1:${port}/v1`, { timeoutMs: 400 });
    check('2e 端口未监听归一化为 LOCAL_SERVER_UNREACHABLE',
      rClosed.ok === false && rClosed.reachable === false && rClosed.reason === 'LOCAL_SERVER_UNREACHABLE');
  }

  /* ============ 3. 免 Key 本地连接 + runConnectionTest Phase 2（零推理开销） ============ */
  {
    let chatCompletionsHits = 0;
    const { srv, origin } = await startServer((req, res) => {
      if (req.url.includes('/chat/completions')) chatCompletionsHits++;
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }));
        return;
      }
      res.writeHead(404); res.end();
    });
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v22c-local-'));
      const cLocal = createConnection(tmpDir, {
        displayName: 'Ollama Local',
        providerId: 'local',
        protocol: 'openai-compatible',
        baseURL: `${origin}/v1`,
        model: 'qwen2.5:7b'
      });
      const resolvedLocal = resolveRuntimeCfg(cLocal.connection, { dir: tmpDir });
      const localAdapter = createOpenAICompatibleAdapter(resolvedLocal.cfg, { providerId: 'local' });

      const cCloud = createConnection(tmpDir, {
        displayName: 'Cloud No Key',
        providerId: 'custom',
        protocol: 'openai-compatible',
        baseURL: 'https://llm.example.com/v1',
        model: 'gpt-x'
      });
      const resolvedCloud = resolveRuntimeCfg(cCloud.connection, { dir: tmpDir });
      const cloudAdapter = createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com/v1', model: 'gpt-x' }, { providerId: 'custom' });

      const testOk = await runConnectionTest(tmpDir, cLocal.connection.connectionId);
      const localAdapterMiss = createOpenAICompatibleAdapter(
        { ...resolvedLocal.cfg, model: 'not-pulled' },
        { providerId: 'local' }
      );
      const missHealth = await localAdapterMiss.healthCheck();

      check('3a local 连接免 Key 可通过 resolveRuntimeCfg 与 validateConfig（custom 仍 fail-closed）',
        cLocal.ok && resolvedLocal.ok && resolvedLocal.cfg.apiKey === '' &&
        localAdapter.validateConfig().ok === true &&
        resolvedCloud.ok === false && resolvedCloud.error === 'CREDENTIAL_UNAVAILABLE' &&
        cloudAdapter.validateConfig().ok === false &&
        typeof cloudAdapter.healthCheck !== 'function');
      check('3b runConnectionTest Phase 2 走 healthCheck 零推理通过且透传 models',
        testOk.ok === true && testOk.status === 'verified' && testOk.phase === 'healthCheck' &&
        testOk.serverKind === 'ollama' && Array.isArray(testOk.models) &&
        testOk.models.includes('qwen2.5:7b') && chatCompletionsHits === 0);
      check('3c local healthCheck 模型缺失诚实报错 LOCAL_MODEL_NOT_FOUND',
        missHealth.ok === false && missHealth.reason === 'LOCAL_MODEL_NOT_FOUND');
    } finally {
      await closeServer(srv);
    }
  }

  /* ============ 4. Config 与 FallbackAdapter 双过程 System 1 / System 2 边界 ============ */
  {
    check('4a DEFAULTS 与 sanitize() 正确处理 deferCloseWindowOnLocalFallback（默认 true）',
      DEFAULTS.deferCloseWindowOnLocalFallback === true &&
      sanitize({}).deferCloseWindowOnLocalFallback === true &&
      sanitize({ deferCloseWindowOnLocalFallback: false }).deferCloseWindowOnLocalFallback === false &&
      sanitize({ deferCloseWindowOnLocalFallback: 'yes' }).deferCloseWindowOnLocalFallback === true);

    // 4b 非本地云端备用：allowLocalFallback=false 不改变既有云端回落行为
    const cloudPrimary = makeMockAdapter('deepseek', 'https://api.deepseek.com', {
      onComplete: async () => { const e = new Error('503'); e.retryable = true; throw e; }
    });
    const cloudSecondary = makeMockAdapter('custom', 'https://backup.example.com/v1');
    const cloudFallback = createFallbackAdapter({
      primary: cloudPrimary,
      secondary: cloudSecondary,
      breaker: createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 })
    });
    const cloudRes = await cloudFallback.complete([{ role: 'user', content: 'hi' }], { allowLocalFallback: false });
    check('4b 非本地云端备用行为 100% 不变（isSecondaryLocal=false，allowLocalFallback=false 仍正常回落）',
      cloudFallback.isSecondaryLocal === false && cloudRes.text === 'ok-custom' && cloudSecondary.completeCalls === 1);

    // 4c 本地备用：allowLocalFallback=false 阻断 complete（含已熔断状态），stream 放行并标 usedLocalFallback
    const localPrimary = makeMockAdapter('deepseek', 'https://api.deepseek.com', {
      onComplete: async () => { const e = new Error('503'); e.retryable = true; throw e; },
      onStream: async () => { const e = new Error('503'); e.retryable = true; throw e; }
    });
    const localSecondary = makeMockAdapter('local', 'http://127.0.0.1:11434/v1');
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60000 });
    const fbEvents = [];
    const localFallback = createFallbackAdapter({
      primary: localPrimary,
      secondary: localSecondary,
      breaker,
      onFallback: (ev) => fbEvents.push(ev)
    });
    let deferred1 = null;
    try {
      await localFallback.complete([{ role: 'user', content: 'close' }], { allowLocalFallback: false });
    } catch (e) { deferred1 = e; }
    let deferred2 = null;
    try {
      await localFallback.complete([{ role: 'user', content: 'close-again' }], { allowLocalFallback: false });
    } catch (e) { deferred2 = e; }
    const streamRes = await localFallback.stream([{ role: 'user', content: 'chat' }], () => {});
    check('4c 本地备用 complete(allowLocalFallback=false) 抛出 LOCAL_FALLBACK_DEFERRED 且备用零调用',
      localFallback.isSecondaryLocal === true &&
      localFallback.isPrimaryDegraded() === true &&
      deferred1 && deferred1.code === 'LOCAL_FALLBACK_DEFERRED' && deferred1.deferredByLocalGuard === true &&
      deferred2 && deferred2.code === 'LOCAL_FALLBACK_DEFERRED' &&
      localSecondary.completeCalls === 0 && breaker.getState().consecutiveFailures === 1);
    check('4d 本地备用 stream() 放行浅层陪伴并标明 usedLocalFallback=true',
      streamRes && streamRes.text === 'local-hi' && streamRes.usedLocalFallback === true &&
      localSecondary.streamCalls === 1 && fbEvents.some((e) => e.usedLocalFallback === true));
  }

  /* ============ 5. 端到端 Brain：诚实离线陪伴 + 关窗/成长/合并/梦境防污染护栏 ============ */
  {
    const localRequests = [];
    const { srv, origin } = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.includes('/chat/completions')) {
          const parsed = JSON.parse(body || '{}');
          localRequests.push({
            url: req.url,
            auth: req.headers.authorization || null,
            body: parsed
          });
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '我在呢[state:idle]' } }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  segments: [{ range: '1-2', userGiven: ['测试'], chulanExperience: ['离线对话'], stateEvidence: [], uncertainties: [] }],
                  windowSynthesis: { stableUserFacts: ['测试'], subjectExperiences: ['离线陪伴'], stateChangesSuggested: [], unresolved: [], coinages: [], expectations: [], expectationOutcomes: [] }
                })
              }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
            model: 'qwen2.5:7b'
          }));
          return;
        }
        res.writeHead(404); res.end();
      });
    });

    try {
      const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v22c-local-'));
      const cLocal = createConnection(brainDir, {
        displayName: 'Local Fallback',
        providerId: 'local',
        protocol: 'openai-compatible',
        baseURL: `${origin}/v1`,
        model: 'qwen2.5:7b'
      });

      const cfg = {
        apiKey: 'sk-cloud-primary-key',
        baseURL: 'https://api.deepseek.com',
        provider: 'deepseek',
        credentialType: 'deepseek-api-key',
        model: 'deepseek-flash',
        fallbackConnectionId: cLocal.connection.connectionId,
        fallbackFailureThreshold: 1,
        fallbackCooldownMs: 60000,
        windowTurns: 2,
        deferCloseWindowOnLocalFallback: true,
        experimentMode: 'baseline'
      };
      fs.writeFileSync(path.join(brainDir, 'life-config.json'), JSON.stringify({
        baseURL: cfg.baseURL,
        provider: cfg.provider,
        credentialType: cfg.credentialType,
        model: cfg.model,
        fallbackConnectionId: cfg.fallbackConnectionId,
        fallbackFailureThreshold: cfg.fallbackFailureThreshold,
        fallbackCooldownMs: cfg.fallbackCooldownMs,
        windowTurns: cfg.windowTurns,
        deferCloseWindowOnLocalFallback: true,
        experimentMode: 'baseline'
      }));

      const brain = new Brain(brainDir, cfg);
      const baseSystemText = brain.memory.systemText();

      // 让主端点流式失败一次以打开熔断器（threshold=1）
      brain.api.primary.stream = async () => {
        const err = new Error('503 Cloud Down');
        err.status = 503;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      };
      brain.api.primary.complete = async () => {
        const err = new Error('503 Cloud Down');
        err.status = 503;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      };

      // 第 1 轮：主失败 1 次 → 熔断开并回落本地流式（isPrimaryDegraded 在流失败瞬间由 breaker 置 open）
      const r1 = await brain.ask('第一句问候', () => {});
      // 第 2 轮：熔断已 open → ask() 启动即知 degraded，注入尾部离线事实行并达 windowTurns=2，触发关窗但应被本地守卫安全延后
      const r2 = await brain.ask('第二句离线陪伴', () => {});

      const lastAskReq = localRequests[1] && localRequests[1].body;
      const sentMsgs = (lastAskReq && lastAskReq.messages) || [];
      const sentSystem = sentMsgs.find((m) => m.role === 'system');
      const sentLastUser = sentMsgs[sentMsgs.length - 1];
      const historyHasOfflineLine = (brain.memory.data.history || []).some(
        (m) => m && typeof m.content === 'string' && m.content.includes('当前云端链路暂不可用')
      );

      check('5a Brain.ask 降级本地后 systemText 逐字节恒等且 history 零污染',
        r1 && r1.text === '我在呢' &&
        r2 && r2.text === '我在呢' &&
        sentSystem && sentSystem.content === baseSystemText &&
        brain.memory.systemText() === baseSystemText &&
        !historyHasOfflineLine);
      check('5b Brain.ask 降级当轮 dynamicBody 尾部注入诚实离线事实行且无 Authorization 头',
        sentLastUser && sentLastUser.role === 'user' &&
        typeof sentLastUser.content === 'string' &&
        sentLastUser.content.includes('【系统环境事实】当前云端链路暂不可用') &&
        localRequests.every((r) => r.auth === null));

      const reqsAfterAsk = localRequests.length;
      const closeDeferred = await brain.closeWindow();
      // 强制构造 merge 计划以验证 mergeMemory 同样受本地兜底守卫拦截
      brain.memory.data.windows.push(
        { no: 1, text: '早段甲这是一段较长的记忆' },
        { no: 2, text: '早段乙这是另一段较长的记忆' },
        { no: 3, text: '早段丙这是第三段较长的记忆' }
      );
      brain.memory.memoryCap = 1;
      const mergeDeferred = await brain.mergeMemory();
      const growthDeferred = await brain.growSelf('用户：hi', '摘要', 1);
      const dreamDeferred = await synthesizeDream(
        brain.api,
        [{ role: 'system', content: 'dream' }, { role: 'user', content: 'residue' }],
        { windowNo: 1 },
        { allowLocalFallback: false }
      );

      check('5c deferCloseWindowOnLocalFallback=true 时关窗/合并/成长/梦境全部安全延后且本地服务器 0 调用、不记失败',
        localRequests.length === reqsAfterAsk &&
        closeDeferred === false &&
        mergeDeferred === false &&
        growthDeferred === 0 &&
        dreamDeferred === null &&
        brain.stats.windowCloseFailures === 0 &&
        brain.memory.data.turnsInWindow === 2 &&
        brain.windowCloseRetryAfterTurn > 2);

      // 高配本机显式放行：deferCloseWindowOnLocalFallback = false
      brain.cfg.deferCloseWindowOnLocalFallback = false;
      fs.writeFileSync(path.join(brainDir, 'life-config.json'), JSON.stringify({
        ...JSON.parse(fs.readFileSync(path.join(brainDir, 'life-config.json'), 'utf8')),
        deferCloseWindowOnLocalFallback: false
      }));
      const closeAllowed = await brain.closeWindow();
      check('5d 显式配置 deferCloseWindowOnLocalFallback=false 时允许本地完成关窗总结',
        closeAllowed === true && localRequests.length > reqsAfterAsk);
    } finally {
      await closeServer(srv);
    }
  }

  /* ============ 6. IPC connections:probe-local、preload 暴露与 D-001 静态守卫 ============ */
  {
    const { srv, origin } = await startServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }] }));
        return;
      }
      res.writeHead(404); res.end();
    });
    try {
      const mainFrame = { url: require('url').pathToFileURL(path.join(ROOT, 'index.html')).href };
      const fakeWc = { mainFrame, setWindowOpenHandler: () => {} };
      const handlers = new Map();
      const ipcMainStub = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
      const ipcGuard = createIpcGuard({
        ipcMain: ipcMainStub,
        getMainWindow: () => ({ isDestroyed: () => false, webContents: fakeWc }),
        appDir: ROOT
      });
      const tmpIpcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v22c-local-'));
      const ctrl = createConnectionsController({
        app: { getPath: () => tmpIpcDir },
        getSS: () => null,
        getCfg: () => ({}),
        setCfg: () => {},
        getBrain: () => null,
        setBrain: () => {},
        persistCfg: () => {},
        bindBrainDeps: () => {},
        clearAuthFailureBackoff: () => {},
        scheduleProactiveCheck: () => {},
        COOLDOWN_MS: 0
      });
      ctrl.registerConnectionsIpc(ipcGuard);

      const probeHandler = handlers.get('connections:probe-local');
      const trustedEv = { sender: fakeWc, senderFrame: mainFrame };
      const resLocal = await probeHandler(trustedEv, { baseURL: `${origin}/v1`, model: 'qwen2.5:3b' });
      const resRemote = await probeHandler(trustedEv, { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
      const resNull = await probeHandler(trustedEv, null);
      let rejectedUntrusted = false;
      try {
        await probeHandler({ sender: {}, senderFrame: mainFrame }, { baseURL: origin });
      } catch (e) {
        rejectedUntrusted = Boolean(e && e.code === 'UNTRUSTED_RENDERER');
      }

      check('6a connections:probe-local 经 ipcGuard 收口：可信回环通过、远端/null 拒测、非受信拦截',
        resLocal.ok === true && resLocal.models.includes('qwen2.5:3b') &&
        resRemote.ok === false && resRemote.reason === 'NON_LOCAL_HOST_REJECTED' &&
        resNull.ok === false && resNull.reason === 'NON_LOCAL_HOST_REJECTED' &&
        rejectedUntrusted === true);
    } finally {
      await closeServer(srv);
    }

    const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const probeSrc = fs.readFileSync(path.join(ROOT, 'src/local-probe.js'), 'utf8');
    const strippedProbe = probeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const requires = [...strippedProbe.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    const localModulesOk = requires.every((r) => r.startsWith('./') || r.startsWith('../') || Module.builtinModules.includes(r));

    check('6b preload.js 暴露 connections.probeLocal 且严守零 apiKey 扫描线',
      preloadSrc.includes('probeLocal') && preloadSrc.includes('connections:probe-local') && !/apiKey/.test(preloadSrc));
    check('6c D-001 零定时器与零外部依赖静态扫描：local-probe.js 无 setInterval/setTimeout/innerHTML',
      !/\bsetInterval\s*\(/.test(strippedProbe) &&
      !/\bsetTimeout\s*\(/.test(strippedProbe) &&
      !/\binnerHTML\b/.test(strippedProbe) &&
      localModulesOk);
  }

  console.log('\n' + (failures ? failures + ' 项失败' : 'v22c-local-slm-probe tests passed'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
