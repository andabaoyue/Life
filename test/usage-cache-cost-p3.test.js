/**
 * test/usage-cache-cost-p3.test.js
 *
 * v0.9.8 P3 Usage / Cache / Cost 回归：
 * Usage Normalizer（FACT 层）/ DeepSeek Cache Strategy（解释层）/
 * Cost Strategy（定价层 + pricingVersion）/ Usage Truth Boundary。
 * （P1/P2/Research Integrity 保持由 full suite 保证。）
 *
 * fixture 仅使用假 credential: sk-test-fixture-000。
 */

'use strict';

const { normalizeUsage } = require('../src/usage-normalizer');
const { getCacheStrategy } = require('../src/cache-strategy');
const { getCostStrategy, DEFAULT_PRICING_VERSION } = require('../src/cost-strategy');
const { costOf } = require('../src/deepseek');

const KEY = 'sk-test-fixture-000';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* ============ 1-8. Usage Normalizer ============ */
{
  const raw = {
    prompt_tokens: 2000,
    completion_tokens: 300,
    total_tokens: 2300,
    prompt_cache_hit_tokens: 1500,
    prompt_cache_miss_tokens: 500
  };
  const n = normalizeUsage(raw);
  check('DeepSeek usage 正确归一化 (统一字段齐全)',
    n.promptTokens === 2000 && n.completionTokens === 300 && n.totalTokens === 2300);
  check('hit tokens 正确', n.cacheHitTokens === 1500);
  check('miss tokens 正确', n.cacheMissTokens === 500);
  check('completion tokens 正确', n.completionTokens === 300);
  check('total tokens 正确', n.totalTokens === 2300);
  check('providerRawUsage 可追溯（原始字段形态保留）',
    n.providerRawUsage && n.providerRawUsage.prompt_cache_hit_tokens === 1500);
  check('usageSource 正确 (provider_response)', n.usageSource === 'provider_response');

  const none = normalizeUsage(undefined);
  check('provider 未返回 usage -> unavailable，不伪造数字',
    none.usageSource === 'unavailable' && none.promptTokens === null && none.totalTokens === null && none.providerRawUsage === null);

  // DeepSeek 无 prompt_tokens 时 prompt = hit + miss（provider 字段算术）。
  // 核心字段（prompt/completion）均可由 provider 实际返回字段建立 -> 仍为 provider_response；
  // partial 仅用于核心字段残缺到无法建立的情形。
  const derived = normalizeUsage({ prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500, completion_tokens: 100 });
  check('hit+miss 推导 prompt（provider 字段算术，非猜测）', derived.promptTokens === 2000 && derived.usageSource === 'provider_response');
}

/* ============ 9-12. Cache Strategy ============ */
{
  const strat = getCacheStrategy('deepseek');
  const n = normalizeUsage({ prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3, completion_tokens: 1 });
  const c = strat.interpret(n);
  check('DeepSeek hit/miss 使用真实 provider 字段', c.cacheHitTokens === 7 && c.cacheMissTokens === 3);
  check('hit/miss 计算不混淆', c.cacheHitTokens !== c.cacheMissTokens);
  const noCache = strat.interpret(normalizeUsage({ completion_tokens: 5 }));
  check('没有 cache 字段时不猜测', noCache.cacheAvailable === false && noCache.cacheHitTokens === null && noCache.cacheMissTokens === null);
  check('Cache Strategy 与 Usage Normalizer 分离（解释层不产生 FACT 字段）',
    typeof getCacheStrategy === 'function' && !('usageSource' in c) && !('totalTokens' in c));
}

/* ============ 13-18. Cost Strategy ============ */
{
  const n = normalizeUsage({
    prompt_cache_hit_tokens: 1e6,
    prompt_cache_miss_tokens: 1e6,
    completion_tokens: 1e6
  });
  const pricing = { hit: 1, miss: 2, out: 3, pricingVersion: 'test-price-v1' };
  const r = getCostStrategy('deepseek').calculate(n, pricing);
  check('hit price 正确计入', Math.abs((1e6 * 1) / 1e6 - 1) < 1e-9 && r.breakdown.hitPrice === 1);
  check('miss price 正确计入', r.breakdown.missPrice === 2);
  check('output price 正确计入', r.breakdown.outPrice === 3);
  check('cost = (hit*1 + miss*2 + out*3)/1e6 = 6', Math.abs(r.cost - 6) < 1e-9);
  check('pricingVersion 可记录', r.pricingVersion === 'test-price-v1');

  const frozen = Object.freeze({ prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 0, completion_tokens: 50 });
  const nf = normalizeUsage(frozen);
  const before = JSON.stringify(nf);
  getCostStrategy('deepseek').calculate(nf, pricing);
  check('Cost Strategy 不修改 usage truth（输入前后不变）', JSON.stringify(nf) === before);

  check('Cost 计算不参与 provenance（结果不含证据链字段）',
    !('observedModel' in r) && !('providerResponse' in r) && !('provenanceStatus' in r));
}

/* ============ 19-20. Boundary ============ */
{
  const dirty = normalizeUsage({
    prompt_cache_hit_tokens: 1,
    completion_tokens: 1,
    apiKey: KEY,
    authorization: 'Bearer ' + KEY
  });
  check('providerRawUsage 不含 credential（redaction 生效）',
    !JSON.stringify(dirty.providerRawUsage).includes(KEY) && dirty.providerRawUsage.apiKey === '[REDACTED]');

  check('unknown provider strategy fail-closed（null，不套用别的 provider 规则）',
    getCostStrategy('no-such') === null && getCacheStrategy('no-such') === null);

  const unavail = getCostStrategy('deepseek').calculate(normalizeUsage(null), { hit: 1, miss: 1, out: 1 });
  check('usage unavailable -> cost=null（不伪造 0 成本）', unavail.cost === null && unavail.reason === 'USAGE_UNAVAILABLE');

  // P3.1: pricingVersion 必须落地版本身份，未传时不得留 null
  const noVersion = getCostStrategy('deepseek').calculate(normalizeUsage({ completion_tokens: 10 }), { hit: 1, miss: 1, out: 1 });
  check('P3.1 未传 pricingVersion -> unversioned-legacy（不留 null）',
    noVersion.pricingVersion === DEFAULT_PRICING_VERSION && DEFAULT_PRICING_VERSION === 'unversioned-legacy');
  check('P3.1 unavailable 路径同样带版本身份', unavail.pricingVersion === DEFAULT_PRICING_VERSION);
}

/* ============ costOf 兼容入口 parity ============ */
{
  const u = { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 };
  check('costOf 兼容入口数字语义不变（10.04 parity）',
    Math.abs(costOf(u, { hit: 1, miss: 2, out: 10.02 }) - (1 + 2 + 10.02)) < 1e-9);
  check('costOf 空 usage -> null（E-02 未知成本保持未知）、null usage -> null',
    costOf({}, { hit: 1 }) === null && costOf(null, {}) === null);
  check('E-02 costOf(null) 绝不伪装为 0 消费', costOf(null, { hit: 1, miss: 1, out: 1 }) === null);
  check('DEFAULT_PRICING_VERSION 可记录（无版本价格表时）', DEFAULT_PRICING_VERSION === 'unversioned-legacy');
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
