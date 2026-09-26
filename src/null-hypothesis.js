/**
 * src/null-hypothesis.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 假说注册规范、零假说检验契约与观测差值评估 (Phase 0)
 * 
 * 核心哲学与科学边界：
 * 1. 科学可证伪性（Falsifiability）：
 *    任何数字生命实验假说必须具有明确的零假说（Null Hypothesis, H0）与确凿的证伪判据。
 * 2. 严谨的科学语标（P0-4: No False Statistical Significance）：
 *    Phase 0 仅建立基础观测指标与原始差值（Observed Difference / Effect Delta）的数据格式规范，
 *    严禁在未执行正式假设检验（样本量、检验统计量、p值、置信区间）前宣称“统计显著性（Statistical Significance）”。
 *    返回结构明确标定 statisticalInference: 'NOT_PERFORMED'。
 */

'use strict';

const { SCHEMA_VERSION } = require('./experiment-types');

const MANDATORY_HYPOTHESIS_FIELDS = [
  'schemaVersion',
  'hypothesisId',
  'title',
  'formalHypothesis',
  'nullHypothesis',
  'falsificationCriteria',
  'independentVariables',
  'dependentVariables',
  'baselineControlRequirements'
];

/**
 * 校验假说定义的完整性与可证伪性规范
 * 
 * @param {Object} hyp
 * @returns {boolean}
 */
function validateHypothesisSchema(hyp) {
  if (!hyp || typeof hyp !== 'object') return false;
  if (hyp.schemaVersion !== SCHEMA_VERSION) return false;

  for (const field of MANDATORY_HYPOTHESIS_FIELDS) {
    if (!(field in hyp)) return false;
    if (typeof hyp[field] === 'string' && hyp[field].trim().length === 0) return false;
    if (Array.isArray(hyp[field]) && hyp[field].length === 0) return false;
  }

  // 必须明确定义零假说内容
  if (typeof hyp.nullHypothesis !== 'string' || hyp.nullHypothesis.length < 10) {
    return false;
  }

  return true;
}

/**
 * 评估实验组与基线组的观测差值 (Evaluate Observed Difference)
 * 
 * Phase 0 规范：仅计算原始测量差值，不推断统计显著性
 * 
 * @param {Object} baselineResults 基线数据
 * @param {Object} experimentalResults 实验组数据
 * @param {Object} hypothesis 假说定义
 * @returns {Object} 包含 differenceDelta, observation, statisticalInference, noMeaningfulObservedDifference
 */
function evaluateObservedDifference(baselineResults, experimentalResults, hypothesis) {
  if (!validateHypothesisSchema(hypothesis)) {
    throw new Error('evaluateObservedDifference: Invalid hypothesis schema provided.');
  }

  const baseCount = (baselineResults && typeof baselineResults.eventCount === 'number') ? baselineResults.eventCount : 0;
  const expCount = (experimentalResults && typeof experimentalResults.eventCount === 'number') ? experimentalResults.eventCount : 0;

  const delta = Math.abs(expCount - baseCount);
  const rawThreshold = 5;
  const hasRawDivergence = delta > rawThreshold;

  return {
    hypothesisId: hypothesis.hypothesisId,
    baselineValue: baseCount,
    experimentalValue: expCount,
    differenceDelta: delta,
    observation: hasRawDivergence ? 'OBSERVED_RAW_DIFFERENCE' : 'NO_LARGE_RAW_DIFFERENCE',
    // 明确声明：Phase 0 不执行正式推断统计
    statisticalInference: 'NOT_PERFORMED',
    noMeaningfulObservedDifference: !hasRawDivergence,
    note: 'Phase 0 metric schema only; formal hypothesis testing with p-value and confidence intervals is conducted in Phase 1+ research analysis.'
  };
}

// 别名支持
const evaluateEffectDelta = evaluateObservedDifference;

module.exports = {
  MANDATORY_HYPOTHESIS_FIELDS,
  validateHypothesisSchema,
  evaluateObservedDifference,
  evaluateEffectDelta
};
