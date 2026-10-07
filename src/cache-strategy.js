/**
 * src/cache-strategy.js — Provider Cache Strategy（v0.9.8 P3-2）
 *
 * 职责分离：
 *   Usage Normalizer —— 告诉系统「命中了多少 token」（FACT）；
 *   Cache Strategy   —— 告诉系统「这些 token 在该 provider 的成本规则里如何解释」（解释层）。
 *
 * DeepSeek 策略只按 provider 实际返回的 token 字段（prompt_cache_hit_tokens /
 * prompt_cache_miss_tokens）计算；hit > 0 不等于「整个 prompt 命中」，绝不聚合猜测。
 * 未来 provider B 使用 strategy B —— 不把 DeepSeek 逻辑复制成全局规则。
 * 未知 provider -> 返回 null（fail-closed，不得套用别的 provider 规则）。
 */

const DEEPSEEK_CACHE_STRATEGY = Object.freeze({
  strategyId: 'deepseek-cache-v1',
  providerId: 'deepseek',
  /**
   * @param {object|null|undefined} normalizedUsage normalizeUsage() 的输出（FACT）
   * @returns {{cacheHitTokens: number|null, cacheMissTokens: number|null, cacheAvailable: boolean, note: string}}
   */
  interpret(normalizedUsage) {
    const u = normalizedUsage || {};
    const hit = Number.isFinite(u.cacheHitTokens) ? u.cacheHitTokens : null;
    const miss = Number.isFinite(u.cacheMissTokens) ? u.cacheMissTokens : null;
    return {
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      cacheAvailable: hit !== null || miss !== null,
      note: 'DeepSeek 按 prompt_cache_hit_tokens/prompt_cache_miss_tokens 实际字段计算；hit>0 不等于整个 prompt 命中'
    };
  }
});

const STRATEGIES = new Map([['deepseek', DEEPSEEK_CACHE_STRATEGY]]);

function getCacheStrategy(providerId) {
  return STRATEGIES.get(String(providerId)) || null;
}

module.exports = { getCacheStrategy, DEEPSEEK_CACHE_STRATEGY };
