/**
 * src/null-hypothesis.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 假说注册规范与零假说（Null Hypothesis）检验契约 (Phase 0)
 * 
 * 核心哲学与科学边界：
 * 1. 科学可证伪性（Falsifiability）：
 *    任何数字生命实验假说必须具有明确的零假说（Null Hypothesis, H0）与确凿的证伪判据。
 * 2. 诚实面对零结果：
 *    若实验组与基线组在可观测变量上无统计显著差异，该结果是有效的科学发现，
 *    严禁人为修改数据或增加掩饰性机制。
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
 * 校验假说定义的完整性与可证伪性
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
 * 评估实验组与基线组的差异显著性与证伪状态
 * 
 * @param {Object} baselineResults 基线数据
 * @param {Object} experimentalResults 实验组数据
 * @param {Object} hypothesis 假说定义
 * @returns {Object} 包含 isSignificant, rejectedNullHypothesis, observationNotes
 */
function evaluateExperimentSignificance(baselineResults, experimentalResults, hypothesis) {
  if (!validateHypothesisSchema(hypothesis)) {
    throw new Error('evaluateExperimentSignificance: Invalid hypothesis schema provided.');
  }

  const baseCount = (baselineResults && typeof baselineResults.eventCount === 'number') ? baselineResults.eventCount : 0;
  const expCount = (experimentalResults && typeof experimentalResults.eventCount === 'number') ? experimentalResults.eventCount : 0;

  // 简单的可检验度量（Phase 0 框架）
  const delta = Math.abs(expCount - baseCount);
  const isSignificant = delta > 5; // 初步阈值

  return {
    hypothesisId: hypothesis.hypothesisId,
    baselineEventCount: baseCount,
    experimentalEventCount: expCount,
    differenceDelta: delta,
    isSignificant,
    rejectedNullHypothesis: isSignificant,
    nullHypothesisAccepted: !isSignificant,
    evaluationConclusion: isSignificant 
      ? 'Experimental intervention produced statistically observable divergence from baseline.'
      : 'Null hypothesis accepted: No significant divergence detected between experiment and baseline control.'
  };
}

module.exports = {
  MANDATORY_HYPOTHESIS_FIELDS,
  validateHypothesisSchema,
  evaluateExperimentSignificance
};
