/**
 * test/v15-provider-fallback.test.js
 *
 * v1.5-a 门禁：Provider 容灾自动回落与熔断接线（Circuit Breaker & Fallback Adapter）
 *
 * ## 12 项断言矩阵（参见 docs/v1.5-a-IMPLEMENTATION-ORDER.md §6.1）
 *   1. 主端点正常 → 备用零调用
 *   2. 主端点 retryable 错误 → 回落一次并成功
 *   3. 主端点 3 次失败后第 4 次直接走备用（熔断中跳过主端点）
 *   4. 4xx（retryable: false）→ 不回落，直接抛错
 *   5. AbortError → 不回落（用户取消防重发）
 *   6. 两端都失败 → PRIMARY_AND_FALLBACK_FAILED，且调用次数 = 2（不循环）
 *   7. 未配置备用 → 退化为纯熔断，allowAttempt() 为 false 时快速失败
 *   8. 回落写遥测，且遥测不含 apiKey
 *   9. shouldFallback 单独导出的行为矩阵
 *   10. 流式已吐字后不回落（§8.2 emitted > 0 硬屏障）
 *   11. hot-swap 后新 Brain breaker 为 closed（§8.3 实例状态隔离）
 *   12. 流式未吐字时允许回落（emitted === 0 无缝切备用）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createFallbackAdapter, shouldFallback } = require('../src/fallback-adapter');
const { createCircuitBreaker } = require('../src/circuit-breaker');
const { Brain } = require('../src/brain');

// 临时目录管理（前缀统一使用 d11- 确保与 tmp-hygiene 留档名单一致）
const _dirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdtempSync = _origMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function makeMockAdapter({
  providerId = 'mock-primary',
  onComplete = null,
  onStream = null,
  apiKey = 'sk-mock-key-secret-12345'
} = {}) {
  let completeCalls = 0;
  let streamCalls = 0;
  return {
    providerId,
    providerType: 'openai-compatible',
    cfg: { baseURL: 'https://mock.test', apiKey, model: 'mock-model' },
    get completeCalls() { return completeCalls; },
    get streamCalls() { return streamCalls; },
    validateConfig() { return { ok: true, problems: [] }; },
    capabilities() { return { streaming: true, usage: true }; },
    normalizeError(err) { return err; },
    usage() { return { prompt_tokens: 10, completion_tokens: 5 }; },
    async complete(msgs, opts) {
      completeCalls++;
      if (onComplete) return await onComplete(msgs, opts);
      return { text: 'ok from ' + providerId, usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
    async stream(msgs, onDelta, opts) {
      streamCalls++;
      if (onStream) return await onStream(msgs, onDelta, opts);
      if (typeof onDelta === 'function') {
        onDelta('hello from ');
        onDelta(providerId);
      }
      return { text: 'hello from ' + providerId, usage: { prompt_tokens: 10, completion_tokens: 5 } };
    }
  };
}

console.log('--- v1.5-a Provider 容灾自动回落门禁 ---');

(async () => {
  /* ============ 1. 主端点正常 → 备用零调用 ============ */
  {
    const primary = makeMockAdapter({ providerId: 'primary' });
    const secondary = makeMockAdapter({ providerId: 'secondary' });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary, breaker });

    const res = await adapter.complete([{ role: 'user', content: 'hi' }]);
    check('1. 主端点正常 → 返回主端点结果', res.text === 'ok from primary');
    check('1. 主端点正常 → 备用零调用', primary.completeCalls === 1 && secondary.completeCalls === 0);
  }

  /* ============ 2. 主端点 retryable 错误 → 回落一次并成功 ============ */
  {
    let fallbackNotified = null;
    const primary = makeMockAdapter({
      providerId: 'primary',
      onComplete: async () => {
        const err = new Error('500 Server Error');
        err.status = 500;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      }
    });
    const secondary = makeMockAdapter({ providerId: 'secondary' });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({
      primary,
      secondary,
      breaker,
      onFallback: (info) => { fallbackNotified = info; }
    });

    const res = await adapter.complete([{ role: 'user', content: 'hi' }]);
    check('2. 主端点 retryable 错误 → 回落一次并成功', res.text === 'ok from secondary');
    check('2. 主端点 retryable 错误 → 调用计数正确', primary.completeCalls === 1 && secondary.completeCalls === 1);
    check('2. 回落回调被触发且原因正确', fallbackNotified && fallbackNotified.reason === 'server_error' && fallbackNotified.primaryFailed === true);
  }

  /* ============ 3. 主端点 3 次失败后第 4 次直接走备用 ============ */
  {
    const primary = makeMockAdapter({
      providerId: 'primary',
      onComplete: async () => {
        const err = new Error('503 Service Unavailable');
        err.status = 503;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      }
    });
    const secondary = makeMockAdapter({ providerId: 'secondary' });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary, breaker });

    // 前 3 次触发失败
    await adapter.complete([{ role: 'user', content: '1' }]);
    await adapter.complete([{ role: 'user', content: '2' }]);
    await adapter.complete([{ role: 'user', content: '3' }]);
    check('3. 前 3 次均回落成功', secondary.completeCalls === 3 && primary.completeCalls === 3);
    check('3. 熔断器状态已进入 open', breaker.getState().state === 'open');

    // 第 4 次调用：此时 breaker open，应当跳过主端点直接调用备用
    const res4 = await adapter.complete([{ role: 'user', content: '4' }]);
    check('3. 第 4 次直接走备用成功', res4.text === 'ok from secondary');
    check('3. 主端点未被调用（保持 3 次失败），备用调用递增至 4', primary.completeCalls === 3 && secondary.completeCalls === 4);
  }

  /* ============ 4. 4xx（retryable: false）→ 不回落，直接抛错且不计入熔断 ============ */
  {
    const primary = makeMockAdapter({
      providerId: 'primary',
      onComplete: async () => {
        const err = new Error('401 Unauthorized');
        err.status = 401;
        err.errorType = 'auth_failed';
        err.retryable = false;
        throw err;
      }
    });
    const secondary = makeMockAdapter({ providerId: 'secondary' });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary, breaker });

    let thrown = null;
    for (let i = 0; i < 4; i++) {
      try {
        await adapter.complete([{ role: 'user', content: 'test 401' }]);
      } catch (e) {
        thrown = e;
      }
    }
    check('4. 401 错误直接抛出', thrown && thrown.status === 401);
    check('4. 401 不触发回落（备用调用数为 0）', secondary.completeCalls === 0);
    check('4. 401 等 client 错误不计入熔断，连续 4 次后 breaker 仍保持 closed',
      breaker.getState().state === 'closed' && breaker.getState().consecutiveFailures === 0);
  }

  /* ============ 4b. 无备用端点（secondary === null）时 401 同样不计入熔断 ============
   *
   * 🔴 为什么单独一条（DSH 审查发现）：4 号断言走的是 secondary 存在的那条分支，
   *    而 fallback-adapter.js 里「无备用」与「有备用」是**两条独立的 catch 块**
   *    （recordFailure 共 4 个调用点：无备用 complete/stream + 有备用 complete/stream）。
   *    只测有备用那条，等于另外三条零覆盖 —— 改坏无备用分支时 4 号断言依然全绿。
   *    ⚠️ 判别力已用变异验证：把该分支的 recordFailure 改成无条件调用，本断言必 FAIL。
   */
  {
    const primary = makeMockAdapter({
      providerId: 'primary',
      onComplete: async () => {
        const err = new Error('401 Unauthorized');
        err.status = 401;
        err.errorType = 'auth_failed';
        err.retryable = false;
        throw err;
      }
    });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    // 刻意不传 secondary —— 走「未配置备用 → 纯熔断保护」那条独立分支
    const adapter = createFallbackAdapter({ primary, secondary: null, breaker });

    let thrown = null;
    for (let i = 0; i < 5; i++) {
      try {
        await adapter.complete([{ role: 'user', content: 'test 401 no-fallback' }]);
      } catch (e) {
        thrown = e;
      }
    }
    check('4b. 无备用时 401 仍如实抛出（不被熔断吞成 CIRCUIT_BREAKER_OPEN）',
      thrown && thrown.status === 401);
    check('4b. 无备用时 401 不计入熔断，连续 5 次后 breaker 仍保持 closed 且计数为 0',
      breaker.getState().state === 'closed' && breaker.getState().consecutiveFailures === 0,
      'state=' + breaker.getState().state + ' failures=' + breaker.getState().consecutiveFailures);
    check('4b. 无备用时 401 未触发熔断快速失败（主端点真实被调用 5 次）',
      primary.completeCalls === 5, 'calls=' + primary.completeCalls);
  }

  /* ============ 5. AbortError → 不回落 ============ */
  {
    const primary = makeMockAdapter({
      providerId: 'primary',
      onComplete: async () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        err.retryable = true; // 即使被某些中间件误标为 true，也坚决排除
        throw err;
      }
    });
    const secondary = makeMockAdapter({ providerId: 'secondary' });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary, breaker });

    let thrown = null;
    try {
      await adapter.complete([{ role: 'user', content: 'test abort' }]);
    } catch (e) {
      thrown = e;
    }
    check('5. AbortError 直接抛出', thrown && thrown.name === 'AbortError');
    check('5. AbortError 不触发回落（备用调用数为 0）', primary.completeCalls === 1 && secondary.completeCalls === 0);
  }

  /* ============ 6. 两端都失败 → PRIMARY_AND_FALLBACK_FAILED，总调用次数 = 2 ============ */
  {
    const primary = makeMockAdapter({
      providerId: 'primary',
      onComplete: async () => {
        const err = new Error('500 Primary Down');
        err.status = 500;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      }
    });
    const secondary = makeMockAdapter({
      providerId: 'secondary',
      onComplete: async () => {
        const err = new Error('502 Secondary Down');
        err.status = 502;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      }
    });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary, breaker });

    let thrown = null;
    try {
      await adapter.complete([{ role: 'user', content: 'both fail' }]);
    } catch (e) {
      thrown = e;
    }
    check('6. 两端均失败抛出 PRIMARY_AND_FALLBACK_FAILED', thrown && thrown.code === 'PRIMARY_AND_FALLBACK_FAILED');
    check('6. 复合错误携带两端因果错误', thrown && thrown.primaryError && thrown.fallbackError);
    check('6. 主备端点各被调用恰好 1 次（总次数 = 2，无无限递归循环）', primary.completeCalls === 1 && secondary.completeCalls === 1);
  }

  /* ============ 7. 未配置备用 → 退化为纯熔断，快速失败 ============ */
  {
    const primary = makeMockAdapter({
      providerId: 'primary',
      onComplete: async () => {
        const err = new Error('500 Fail');
        err.status = 500;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      }
    });
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary: null, breaker });

    // 失败 2 次进入熔断
    try { await adapter.complete([{ role: 'user', content: '1' }]); } catch (_) {}
    try { await adapter.complete([{ role: 'user', content: '2' }]); } catch (_) {}
    check('7. 无备用时连续失败达到阈值，熔断器进入 open', breaker.getState().state === 'open');

    let thrown = null;
    try {
      await adapter.complete([{ role: 'user', content: '3' }]);
    } catch (e) {
      thrown = e;
    }
    check('7. 熔断中快速失败抛出 CIRCUIT_BREAKER_OPEN', thrown && thrown.code === 'CIRCUIT_BREAKER_OPEN');
    check('7. 主端点未被执行第 3 次网络调用', primary.completeCalls === 2);
  }

  /* ============ 8. 回落写遥测，且遥测不含 apiKey ============ */
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const secretKey = 'sk-super-secret-key-99999';
    const cfg = {
      apiKey: secretKey,
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek',
      model: 'deepseek-flash',
      fallbackConnectionId: 'conn-backup-01'
    };
    const brain = new Brain(tmpDir, cfg);

    // 模拟一次回落通知触发
    brain._noteFallback({
      reason: 'server_error',
      primaryFailed: true,
      at: Date.now()
    });

    const telemFile = path.join(tmpDir, 'experiment-telemetry.jsonl');
    check('8. 遥测文件已创建', fs.existsSync(telemFile));
    const content = fs.readFileSync(telemFile, 'utf8');
    const lines = content.trim().split('\n').map((l) => JSON.parse(l));
    const fallbackRec = lines.find((r) => r.recordType === 'provider_fallback');
    check('8. 存在 provider_fallback 遥测记录', !!fallbackRec);
    check('8. 遥测记录字段准确', fallbackRec && fallbackRec.reason === 'server_error' && fallbackRec.fallbackConnectionId === 'conn-backup-01');
    check('8. 遥测内容严格不含明文 apiKey 秘钥', !content.includes(secretKey));
  }

  /* ============ 9. shouldFallback 单独导出的行为矩阵 ============ */
  {
    check('9. shouldFallback(null) === false', shouldFallback(null) === false);
    check('9. shouldFallback(undefined) === false', shouldFallback(undefined) === false);
    check('9. shouldFallback({ retryable: true }) === true', shouldFallback({ retryable: true }) === true);
    check('9. shouldFallback({ retryable: false }) === false', shouldFallback({ retryable: false }) === false);
    check('9. shouldFallback({ retryable: true, name: "AbortError" }) === false',
      shouldFallback({ retryable: true, name: 'AbortError' }) === false);
    check('9. shouldFallback({ retryable: true }, { aborted: true }) === false',
      shouldFallback({ retryable: true }, { aborted: true }) === false);
    check('9. shouldFallback({ retryable: true }, { aborted: false }) === true',
      shouldFallback({ retryable: true }, { aborted: false }) === true);
    check('9. shouldFallback(new Error("generic")) === false',
      shouldFallback(new Error('generic')) === false);
  }

  /* ============ 10. 流式已吐字后不回落（§8.2 emitted > 0 硬屏障） ============ */
  {
    let primaryDeltas = [];
    const primary = makeMockAdapter({
      providerId: 'primary',
      onStream: async (msgs, onDelta) => {
        onDelta('今天天气真');
        primaryDeltas.push('今天天气真');
        const err = new Error('Connection reset by peer mid-stream');
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      }
    });
    const secondary = makeMockAdapter({ providerId: 'secondary' });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary, breaker });

    let collectedDeltas = [];
    let thrown = null;
    try {
      await adapter.stream(
        [{ role: 'user', content: 'hi' }],
        (d) => collectedDeltas.push(d)
      );
    } catch (e) {
      thrown = e;
    }

    check('10. 流式已吐字后抛出原始错误，坚决不回落', thrown && thrown.message.includes('Connection reset'));
    check('10. 备用端点流式调用数为 0（杜绝首尾拼接重播）', secondary.streamCalls === 0);
    check('10. 上屏仅收到主端点截断前的字，无备用端点二次推流', collectedDeltas.join('') === '今天天气真');
  }

  /* ============ 11. hot-swap 后新 Brain breaker 为 closed（§8.3 实例状态隔离） ============ */
  {
    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const brain1 = new Brain(tmpDir1, { baseURL: 'https://api.deepseek.com', apiKey: 'sk-1' });

    // 让 brain1 的 breaker 连续失败至 open
    brain1.providerBreaker.recordFailure();
    brain1.providerBreaker.recordFailure();
    brain1.providerBreaker.recordFailure();
    check('11. 旧 Brain breaker 处于 open', brain1.providerBreaker.getState().state === 'open');

    // 模拟 candidate hot-swap 新建 Brain 实例
    const brain2 = new Brain(tmpDir2, { baseURL: 'https://api.deepseek.com', apiKey: 'sk-2' });
    check('11. 新 Brain breaker 独立且初始为 closed', brain2.providerBreaker.getState().state === 'closed');
    check('11. 新 Brain 失败计数归零', brain2.providerBreaker.getState().consecutiveFailures === 0);
    check('11. 两实例 breaker 引用独立', brain1.providerBreaker !== brain2.providerBreaker);
  }

  /* ============ 12. 流式未吐字时发生 retryable 错误 → 允许回落到备用流式 ============ */
  {
    const primary = makeMockAdapter({
      providerId: 'primary',
      onStream: async () => {
        // 未吐出任何 chunk 直接网络挂掉
        const err = new Error('504 Gateway Timeout before response');
        err.status = 504;
        err.errorType = 'server_error';
        err.retryable = true;
        throw err;
      }
    });
    const secondary = makeMockAdapter({ providerId: 'secondary' });
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30000 });
    const adapter = createFallbackAdapter({ primary, secondary, breaker });

    let collectedDeltas = [];
    const res = await adapter.stream(
      [{ role: 'user', content: 'hi' }],
      (d) => collectedDeltas.push(d)
    );

    check('12. 未吐字前回落成功，收到备用流式结果', res && res.text === 'hello from secondary');
    check('12. 主备端点流式调用各为 1', primary.streamCalls === 1 && secondary.streamCalls === 1);
    check('12. onDelta 完整接收备用端点 chunk', collectedDeltas.join('') === 'hello from secondary');
  }

  /* ============ 13. _buildFallbackAdapter 真实加密凭据与端到端回落 ============ */
  {
    const { createConnection } = require('../src/connections');
    const { setCredential } = require('../src/secure-credentials');

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const fakeSS = {
      isEncryptionAvailable: () => true,
      encryptString: (str) => Buffer.from('fake-enc:' + str),
      decryptString: (buf) => {
        const s = buf.toString('utf8');
        if (s.startsWith('fake-enc:')) return s.slice(9);
        throw new Error('decrypt failed');
      }
    };
    const getSS = () => fakeSS;

    // 建立一个备用连接到 connections.json
    const connRes = createConnection(testDir, {
      displayName: 'Secondary Provider',
      providerId: 'generic',
      protocol: 'openai-compatible',
      baseURL: 'https://backup.example.com/v1',
      models: ['gpt-4o', 'backup-model'],
      activeModel: 'backup-model'
    });
    check('13. 备用连接创建成功', connRes && connRes.ok);
    const backupConnId = connRes.connection.connectionId;
    const backupSecret = 'sk-backup-secret-key-88888';

    // 以真实加密密文落盘
    const credRes = setCredential(connRes.connection.credentialRef, backupSecret, { dir: testDir, getSS });
    check('13. 密文凭据落盘成功', credRes && credRes.ok && credRes.encrypted);

    // 情况 A：无 getSS 时，无法解密 DPAPI 密文，_buildFallbackAdapter 静默返回 null
    const brainNoSS = new Brain(testDir, {
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-primary-test',
      fallbackConnectionId: backupConnId
    });
    check('13. 无 getSS 时无法解密密文凭据，secondary 为 null', brainNoSS.api.secondary === null);

    // 情况 B：传入 getSS 时，成功解密密文凭据并构造出 secondary adapter
    const brainWithSS = new Brain(testDir, {
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-primary-test',
      fallbackConnectionId: backupConnId,
      _getSS: getSS
    });
    check('13. 传入 getSS 时成功解析密文凭据并组装 secondary', brainWithSS.api.secondary !== null);
    check('13. secondary apiKey 与模型配置正确',
      brainWithSS.api.secondary.cfg.apiKey === backupSecret &&
      brainWithSS.api.secondary.cfg.model === 'backup-model' &&
      brainWithSS.api.secondary.cfg.baseURL === 'https://backup.example.com/v1');

    // 情况 C：全链路端到端回落测试
    brainWithSS.api.primary.complete = async () => {
      const err = new Error('500 Primary Server Error');
      err.status = 500;
      err.errorType = 'server_error';
      err.retryable = true;
      throw err;
    };
    brainWithSS.api.secondary.complete = async () => {
      return { text: 'fallback succeeded from decrypted secondary', usage: { prompt_tokens: 5, completion_tokens: 5 } };
    };

    const resp = await brainWithSS.api.complete([{ role: 'user', content: 'test e2e fallback' }]);
    check('13. 主端点失败后端到端自动回落至解密成功的备用端点',
      resp && resp.text === 'fallback succeeded from decrypted secondary');
  }

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
