/**
 * test/provider-routing-p4.test.js
 *
 * v0.9.8 P4 回归：
 * P4-0 Routing Contract 元数据 / P4-1 Generation Attempt·Result 语义 /
 * P4-2 Fallback 策略约束与失败事实保留 / P4-3 Circuit Breaker 状态机与真值隔离。
 * （P1/P2/P3/Research Integrity 保持由 full suite 保证。）
 */

'use strict';

const {
  createAttempt,
  markOutputYielded,
  markAttemptSuccess,
  markAttemptFailure,
  createGenerationResult
} = require('../src/generation-attempt');
const {
  createRoutingPlan,
  recordAttempt,
  evaluateFallbackPolicy,
  commitFallback
} = require('../src/provider-routing');
const { createCircuitBreaker } = require('../src/circuit-breaker');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* ============ P4-0: Routing Contract 元数据 ============ */
{
  const plan = createRoutingPlan({ selectedProvider: 'deepseek', fallbackProvider: 'local-llm' });
  check('Routing Contract 四字段齐全',
    'selectedProvider' in plan && 'fallbackProvider' in plan && 'attemptedProviders' in plan && 'fallbackReason' in plan);
  check('selectedProvider / fallbackProvider 正确登记', plan.selectedProvider === 'deepseek' && plan.fallbackProvider === 'local-llm');
  check('初始 fallbackReason 为 null', plan.fallbackReason === null);
  check('无 fallback 配置时 fallbackProvider 为 null', createRoutingPlan({ selectedProvider: 'a' }).fallbackProvider === null);
}

/* ============ P4-1: Generation Attempt / Result ============ */
{
  // 一次 provider 调用 = 一个 Attempt
  const a1 = createAttempt({ attemptId: 'att-1', providerId: 'deepseek', semanticKey: 'sem-1' });
  check('一次 provider 调用 = 一个 Attempt', a1.outcome === 'pending' && a1.providerId === 'deepseek');

  // Retry ≠ 新语义生成：调用内部 retry 只记 retryState，不产生新 Attempt
  markAttemptSuccess(a1, { output: 'ok', retryState: { attempts: 2, maxRetries: 2 } });
  check('Retry ≠ 新语义生成（retryState 记在同 Attempt 内）', a1.retryState && a1.retryState.attempts === 2 && a1.kind === 'initial');

  // Fallback = 新 Attempt
  const a2 = createAttempt({ attemptId: 'att-2', providerId: 'local-llm', kind: 'fallback', semanticKey: 'sem-1' });
  check('Fallback = 新 Attempt（kind=fallback）', a2.kind === 'fallback' && a2.attemptId !== a1.attemptId);

  // Result：最终采用输出 + 完整轨迹
  markAttemptFailure(a2, { errorType: 'server_error', status: 502, message: 'boom' });
  const plan = createRoutingPlan({ selectedProvider: 'deepseek', fallbackProvider: 'local-llm' });
  recordAttempt(plan, a1); recordAttempt(plan, a2);
  const r = createGenerationResult({ semanticKey: 'sem-1', attempts: [a1, a2], adoptedAttemptId: 'att-1', routing: plan });
  check('最终采用输出 = Result（adoptedAttemptId 指向成功 Attempt）', r.output === 'ok' && r.selectedProvider === 'deepseek');
  check('Result 保留全部 Attempt（失败事实不丢）', r.attempts.length === 2 && r.attempts.find(x => x.attemptId === 'att-2').error.status === 502);

  // fail-closed：adopt 非 success / 不存在 -> 拒绝构造
  let e1 = null;
  try { createGenerationResult({ attempts: [a2], adoptedAttemptId: 'att-2' }); } catch (e) { e1 = e; }
  check('adopt 失败 Attempt -> 拒绝构造 Result', e1 && e1.message === 'ADOPTED_ATTEMPT_NOT_SUCCESSFUL');
  let e2 = null;
  try { createGenerationResult({ attempts: [a1], adoptedAttemptId: 'nope' }); } catch (e) { e2 = e; }
  check('adopt 不存在的 Attempt -> 拒绝', e2 && e2.message === 'ADOPTED_ATTEMPT_NOT_FOUND');

  // attempt 失败消息过 redaction（无 credential 落轨迹）
  const a3 = createAttempt({ attemptId: 'att-3', providerId: 'deepseek' });
  markAttemptFailure(a3, { errorType: 'auth_failed', message: 'bad key sk-test-fixture-000' });
  check('Attempt 失败轨迹不含 credential（redaction）', !JSON.stringify(a3.error).includes('sk-test-fixture-000'));
}

/* ============ P4-2: Fallback 约束与失败事实保留 ============ */
{
  const plan = createRoutingPlan({
    selectedProvider: 'deepseek',
    fallbackProvider: 'local-llm',
    policy: { requiredCapability: 'streaming', costLimitPerCall: 1.0, privacy: 'no-third-party', budgetRemaining: 5.0 }
  });

  // 原 provider 失败事实必须保留，fallback 不覆盖
  const failA = createAttempt({ attemptId: 'f-1', providerId: 'deepseek' });
  markAttemptFailure(failA, { errorType: 'rate_limited', status: 429, retryable: true, message: 'rate limited' });
  recordAttempt(plan, failA);
  const fbA = createAttempt({ attemptId: 'f-2', providerId: 'local-llm', kind: 'fallback' });
  markAttemptSuccess(fbA, { output: 'recovered' });
  commitFallback(plan, { reason: 'PROVIDER_FAILURE:rate_limited', fallbackAttempt: fbA });
  check('fallback 后原 provider 失败事实仍在 attemptedProviders', plan.attemptedProviders[0].error && plan.attemptedProviders[0].error.status === 429);
  check('fallbackReason 如实记录', plan.fallbackReason === 'PROVIDER_FAILURE:rate_limited');
  const res = createGenerationResult({ semanticKey: 's', attempts: [failA, fbA], adoptedAttemptId: 'f-2', routing: plan });
  check('fallback 采用输出进 Result 且轨迹完整（不覆盖原 provenance）',
    res.output === 'recovered' && res.attempts.length === 2 && res.routing.attemptedProviders.length === 2);

  // 约束链 fail-closed
  check('已 yield 输出 -> 禁止静默 fallback/重生成', evaluateFallbackPolicy(plan, { outputYielded: true, fallbackCapabilities: { streaming: true }, estimatedCost: 0 }).ok === false);
  const noFb = createRoutingPlan({ selectedProvider: 'a' });
  check('无 fallback 配置 -> 不允许', evaluateFallbackPolicy(noFb, {}).ok === false);
  check('capability 缺失 -> 不允许', evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: false }, estimatedCost: 0 }).ok === false);
  check('cost 超限 -> 不允许', evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: true }, estimatedCost: 2.0 }).ok === false);
  check('privacy 约束 -> 第三方 fallback 不允许', evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: true }, estimatedCost: 0, fallbackIsThirdParty: true }).ok === false);
  check('budget 不足 -> 不允许', evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: true }, estimatedCost: 99 }).ok === false);
  check('全部约束满足 -> 允许 fallback', evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: true }, estimatedCost: 0.5 }).ok === true);

  // E-01: 成本未知 fail-closed
  const eNull = evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: true }, estimatedCost: null });
  check('E-01 成本未知（null）-> UNKNOWN_COST fail-closed', eNull.ok === false && eNull.reason === 'UNKNOWN_COST');
  const eNaN = evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: true }, estimatedCost: NaN });
  const eMissing = evaluateFallbackPolicy(plan, { fallbackCapabilities: { streaming: true } });
  check('E-01 成本未知（NaN/未提供）-> 同样拦截', eNaN.ok === false && eMissing.ok === false && eMissing.reason === 'UNKNOWN_COST');
}

/* ============ P4-3: Circuit Breaker ============ */
{
  let t = 1000;
  const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
  check('初始 closed 放行', cb.allowAttempt() === true && cb.getState().state === 'closed');

  cb.recordFailure();
  check('连续失败 1 次未达阈值仍 closed', cb.getState().state === 'closed');
  cb.recordFailure();
  check('连续失败达阈值 -> open', cb.getState().state === 'open');
  check('open 状态 cooldown 内拒绝尝试', cb.allowAttempt() === false);

  cb.recordSuccess(); // 等价于一次成功（此处用于验证计数重置语义不应在 open 期发生——探测后再测）
  cb.recordFailure(); cb.recordFailure();
  check('失败计数重置后重新走向 open（连续失败计数语义）', cb.getState().state === 'open');

  t += 1000; // cooldown 到期
  check('cooldown 到期 -> half-open 放行一次探测', cb.allowAttempt() === true && cb.getState().state === 'half-open');
  check('half-open 只允许一个探测', cb.allowAttempt() === false);
  cb.recordFailure();
  check('探测失败 -> 回 open（重新 cooldown）', cb.getState().state === 'open' && cb.allowAttempt() === false);

  t += 1000;
  check('再次 cooldown 到期 -> half-open', cb.allowAttempt() === true && cb.getState().state === 'half-open');
  cb.recordSuccess();
  check('探测成功 -> 回 closed', cb.getState().state === 'closed' && cb.getState().consecutiveFailures === 0);

  // 熔断只控制尝试准许，不参与 provenance 真值判定
  const s = cb.getState();
  const provKeys = ['observedModel', 'provenanceStatus', 'usageSource', 'runtimeEvidence', 'identitySource', 'attempts', 'semanticKey'];
  check('breaker 状态不含 provenance 字段（真值隔离）', provKeys.every(k => !(k in s)));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
