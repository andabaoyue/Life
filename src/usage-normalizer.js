/**
 * src/usage-normalizer.js — 统一 Usage 内部模型（v0.9.8 P3-1）
 *
 * FACT 层：只把 provider-specific usage 字段映射为统一字段。
 * 不负责：price / cost / routing / retry / cache policy（各归其层）。
 *
 * Usage Truth Boundary：
 *   provider_response usage ≠ caller supplied usage。
 *   provider 未返回 usage 时不猜数字 —— 字段为 null、usageSource='unavailable'，
 *   绝不用默认值伪装 provider fact。
 */

const { redactSecrets } = require('./redact');

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

/**
 * @param {object|null|undefined} rawUsage provider 原始 usage（provider_response 事实）
 * @param {string} [providerId] P5-A2：strategy 选择以 providerId 为键。
 *   DeepSeek 推导语义（prompt=hit+miss / total=sum）只属于 DeepSeek；
 *   其他 provider 只记录真实返回字段，绝不套用 DeepSeek 语义。
 * @returns {{
 *   promptTokens: number|null, completionTokens: number|null, totalTokens: number|null,
 *   cacheHitTokens: number|null, cacheMissTokens: number|null,
 *   providerRawUsage: object|null, usageSource: 'provider_response'|'partial'|'unavailable'
 * }}
 */
function normalizeUsage(rawUsage, providerId = 'deepseek') {
  const pid = String(providerId || 'deepseek');
  const empty = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cacheHitTokens: null,
    cacheMissTokens: null,
    providerRawUsage: null,
    usageSource: 'unavailable'
  };
  if (!rawUsage || typeof rawUsage !== 'object') return empty;

  // 可追溯副本：保留原始字段形态，但经 redaction（绝不含 credential 类内容）
  let providerRawUsage;
  try {
    providerRawUsage = redactSecrets({ ...rawUsage });
  } catch {
    providerRawUsage = null;
  }

  const cacheHitTokens = numOrNull(rawUsage.prompt_cache_hit_tokens);
  const cacheMissTokens = numOrNull(rawUsage.prompt_cache_miss_tokens);
  const completionTokens = numOrNull(rawUsage.completion_tokens);

  let promptTokens = numOrNull(rawUsage.prompt_tokens);
  if (promptTokens === null && pid === 'deepseek' && cacheHitTokens !== null && cacheMissTokens !== null) {
    // DeepSeek 语义：prompt tokens = cache hit + cache miss（provider 实际字段的算术，不是猜测）
    promptTokens = cacheHitTokens + cacheMissTokens;
  }

  let totalTokens = numOrNull(rawUsage.total_tokens);
  if (totalTokens === null && pid === 'deepseek' && promptTokens !== null && completionTokens !== null) {
    totalTokens = promptTokens + completionTokens;
  }

  const core = [promptTokens, completionTokens];
  let usageSource = 'unavailable';
  if (core[0] !== null && core[1] !== null) usageSource = 'provider_response';
  else if (core[0] !== null || core[1] !== null || cacheHitTokens !== null || cacheMissTokens !== null) usageSource = 'partial';

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    providerRawUsage,
    usageSource
  };
}

module.exports = { normalizeUsage };
