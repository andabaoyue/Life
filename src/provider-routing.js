/**
 * src/provider-routing.js — Routing Contract 与 Fallback 策略（v0.9.8 P4-0/P4-2）
 *
 * 【Staged 预留阶段】本模块已实现并有回归覆盖，但暂未接进主干生产编排
 * （brain.js 主链路当前无真实 fallback 流量经此流转）——INT-01：实现 ≠ 运行时。
 *
 * Routing Contract 元数据：
 *   selectedProvider   —— 最终采用输出的 provider
 *   fallbackProvider   —— 配置的备选 provider（可空）
 *   attemptedProviders —— 完整尝试轨迹（原始 provider 失败事实必须保留，fallback 不覆盖）
 *   fallbackReason     —— 触发 fallback 的原因（可空）
 *
 * Fallback 必须受 capability / cost / privacy / budget policy 约束，全部 fail-closed：
 * 任一约束不可证明满足就不允许 fallback。已向调用方 yield 输出后禁止静默从头重生成。
 */

function createRoutingPlan({ selectedProvider, fallbackProvider = null, policy = {} } = {}) {
  if (typeof selectedProvider !== 'string' || !selectedProvider.trim()) throw new Error('SELECTED_PROVIDER_REQUIRED');
  return {
    selectedProvider: selectedProvider.trim(),
    fallbackProvider: (typeof fallbackProvider === 'string' && fallbackProvider.trim()) ? fallbackProvider.trim() : null,
    attemptedProviders: [],
    fallbackReason: null,
    policy: {
      requiredCapability: policy.requiredCapability || null,
      costLimitPerCall: Number.isFinite(policy.costLimitPerCall) ? policy.costLimitPerCall : null,
      privacy: policy.privacy || null, // 如 'no-third-party'
      budgetRemaining: Number.isFinite(policy.budgetRemaining) ? policy.budgetRemaining : null
    }
  };
}

/** 记录一次 Attempt 轨迹（失败事实原样保留）。 */
function recordAttempt(plan, attempt) {
  plan.attemptedProviders.push({
    attemptId: attempt.attemptId,
    providerId: attempt.providerId,
    kind: attempt.kind,
    outcome: attempt.outcome,
    error: attempt.error ? { ...attempt.error } : null,
    outputYielded: Boolean(attempt.outputYielded)
  });
  return plan;
}

/**
 * Fallback 准许判定（fail-closed）：输出 { ok, reason }。
 * 约束链：已 yield 输出 / 备选存在 / capability / cost / privacy / budget。
 */
function evaluateFallbackPolicy(plan, {
  outputYielded = false,
  fallbackCapabilities = null,
  fallbackIsThirdParty = false,
  estimatedCost = null
} = {}) {
  if (outputYielded) return { ok: false, reason: 'OUTPUT_ALREADY_YIELDED' };
  if (!plan.fallbackProvider) return { ok: false, reason: 'NO_FALLBACK_CONFIGURED' };

  // E-01: 成本未知（null / NaN / 未提供）时严格 fail-closed ——
  // 绝不把未知成本当 0 放行（对齐严格成本门禁）
  if (!Number.isFinite(estimatedCost)) return { ok: false, reason: 'UNKNOWN_COST' };

  const req = plan.policy.requiredCapability;
  if (req) {
    if (!fallbackCapabilities || fallbackCapabilities[req] !== true) {
      return { ok: false, reason: 'FALLBACK_CAPABILITY_MISSING' };
    }
  }
  if (plan.policy.costLimitPerCall !== null) {
    if (!Number.isFinite(estimatedCost) || estimatedCost > plan.policy.costLimitPerCall) {
      return { ok: false, reason: 'FALLBACK_COST_EXCEEDED' };
    }
  }
  if (plan.policy.privacy === 'no-third-party' && fallbackIsThirdParty) {
    return { ok: false, reason: 'FALLBACK_PRIVACY_BLOCKED' };
  }
  if (plan.policy.budgetRemaining !== null) {
    const need = Number.isFinite(estimatedCost) ? estimatedCost : 0;
    if (need > plan.policy.budgetRemaining) {
      return { ok: false, reason: 'FALLBACK_BUDGET_EXHAUSTED' };
    }
  }
  return { ok: true, reason: null };
}

/**
 * 提交 fallback：登记 fallbackReason 与新 Attempt；原 provider 失败轨迹保持不动。
 */
function commitFallback(plan, { reason = 'PROVIDER_FAILURE', fallbackAttempt = null } = {}) {
  if (!plan.fallbackProvider) throw new Error('NO_FALLBACK_CONFIGURED');
  plan.fallbackReason = reason;
  if (fallbackAttempt) recordAttempt(plan, fallbackAttempt);
  return plan;
}

module.exports = {
  createRoutingPlan,
  recordAttempt,
  evaluateFallbackPolicy,
  commitFallback
};
