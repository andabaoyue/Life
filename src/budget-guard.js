/**
 * src/budget-guard.js — 最基础的请求前资源保护边界（v0.9.8 P1-4）
 *
 * 只做一件事：发送请求前判断本次最坏资源消耗是否超过 configured budget，超限 fail-closed。
 * 它不是最终 Cost Truth（Cost Strategy 属 P3），不做计价、不做账单。
 */

const HARD_MAX_ATTEMPTS_FACTOR = 4; // worst-case attempts = maxRetries+1 的宽松上界保护

/**
 * @param {object} p
 * @param {number} [p.maxTokens]           本次请求的 max_tokens
 * @param {number} [p.attempt]             当前 attempt（0 起）
 * @param {number} [p.maxRetries]          最大 retry 次数
 * @param {number} [p.budgetMaxOutputTokens] configured budget（未配置 = 不设限）
 * @returns {{ok: boolean, reason?: string, worstCase?: number, budgetMaxOutputTokens?: number}}
 */
function assertBudget({ maxTokens = 0, attempt = 0, maxRetries = 0, budgetMaxOutputTokens } = {}) {
  if (!Number.isFinite(budgetMaxOutputTokens) || budgetMaxOutputTokens <= 0) {
    return { ok: true, reason: 'NO_BUDGET_CONFIGURED' };
  }
  const per = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
  const retries = Number.isFinite(maxRetries) && maxRetries > 0 ? Math.floor(maxRetries) : 0;
  const worstCase = per * (retries + 1);
  const committed = per * (Math.floor(Math.max(0, attempt)) + 1);
  if (worstCase > budgetMaxOutputTokens || committed > budgetMaxOutputTokens || retries + 1 > HARD_MAX_ATTEMPTS_FACTOR) {
    return { ok: false, reason: 'BUDGET_EXCEEDED', worstCase, budgetMaxOutputTokens };
  }
  return { ok: true, worstCase };
}

module.exports = { assertBudget };
