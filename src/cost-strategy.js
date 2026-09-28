/**
 * src/cost-strategy.js — Provider Cost Strategy（v0.9.8 P3-3）
 *
 * Pricing Truth 边界：
 *   provider returned usage = FACT；
 *   pricing table = COST MODEL。
 * 两者不混同：价格可变，pricingVersion 让旧记录知道当时依据哪套价格 ——
 * 绝不用当前价格重新解释历史研究记录。
 *
 * Cost Strategy 只计算成本，不负责 provider identity / runtime evidence /
 * usage truth / routing / credential。计算链：
 *   normalizeUsage(FACT) -> cacheStrategy.interpret(解释) -> 定价计算。
 */

const { getCacheStrategy } = require('./cache-strategy');

const DEFAULT_PRICING_VERSION = 'unversioned-legacy';

const DEEPSEEK_COST_STRATEGY = Object.freeze({
  strategyId: 'deepseek-cost-v1',
  providerId: 'deepseek',
  defaultPricingVersion: 'deepseek-price-v1',
  /**
   * @param {object|null|undefined} normalizedUsage normalizeUsage() 输出（不会被修改）
   * @param {{hit?: number, miss?: number, out?: number, pricingVersion?: string}} [pricingContext] 价格表（COST MODEL）
   * @returns {{cost: number|null, pricingVersion: string|null, breakdown: object|null, reason?: string}}
   */
  calculate(normalizedUsage, pricingContext = {}) {
    const usage = normalizedUsage && typeof normalizedUsage === 'object' ? normalizedUsage : null;
    const pricingVersion = (pricingContext && pricingContext.pricingVersion) || null;

    if (!usage || usage.usageSource === 'unavailable') {
      // 不伪造 0 成本 —— 无 provider usage 事实时成本也是未知
      return { cost: null, pricingVersion, breakdown: null, reason: 'USAGE_UNAVAILABLE' };
    }

    const cache = getCacheStrategy('deepseek').interpret(usage); // 解释层，不改 FACT
    const hit = cache.cacheHitTokens != null ? cache.cacheHitTokens : 0;
    const miss = cache.cacheMissTokens != null ? cache.cacheMissTokens : 0;
    const out = Number.isFinite(usage.completionTokens) ? usage.completionTokens : 0;
    const p = pricingContext || {};
    const hitPrice = p.hit || 0;
    const missPrice = p.miss || 0;
    const outPrice = p.out || 0;

    return {
      cost: (hit * hitPrice + miss * missPrice + out * outPrice) / 1e6,
      pricingVersion,
      breakdown: {
        cacheHitTokens: cache.cacheHitTokens,
        cacheMissTokens: cache.cacheMissTokens,
        completionTokens: usage.completionTokens,
        hitPrice,
        missPrice,
        outPrice
      }
    };
  }
});

function getCostStrategy(providerId) {
  if (String(providerId) === 'deepseek') return DEEPSEEK_COST_STRATEGY;
  return null; // fail-closed：未知 provider 无成本策略，不套用别的 provider 规则
}

module.exports = { getCostStrategy, DEEPSEEK_COST_STRATEGY, DEFAULT_PRICING_VERSION };
