/**
 * src/canalization.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 沃丁顿发育景观与经历依赖塑性衰减动力学模型 (v0.9.7)
 * 
 * 核心哲学与科学规范：
 * 1. 沃丁顿表观重力沟壑（Creode）：在发育早期具有极高可塑性（High Plasticity），
 *    随着窗口经历深度的不断累加，系统逐渐沿着自传经历形成的渠道滑行，步长敏感度产生惯性阻尼。
 * 2. 纯确定性代数方程：
 *    η(W) = η0 / (1 + γ * ln(1 + W))
 *    plasticityMultiplier(W) = 1 / (1 + γ * ln(1 + W))
 * 3. 历史可复盘性：计算参数（baseStepWeight, effectiveStepWeight, plasticityMultiplier）
 *    随 StateChange 完整持久化，确保离线 Replay 严格依照当时落盘参数 100% 确定性重现。
 * 4. 基线零干预原则（Baseline Invariant）：
 *    在 Baseline 模式或模块未激活时，plasticityMultiplier 恒为 1.0，完全等价于原生步长。
 */

'use strict';

const DEFAULT_CANALIZATION_GAMMA = 0.25;

const DEVELOPMENTAL_STAGES = Object.freeze({
  JUVENILE: 'JUVENILE',             // 幼态期 (Window 1~5)：高可塑性，表观白纸
  DEVELOPMENTAL: 'DEVELOPMENTAL',   // 发育期 (Window 6~30)：惯性形成，沟壑加深
  STABILIZED: 'STABILIZED'          // 稳定个体化期 (Window 30+)：坚韧自我图式，抗噪弹性
});

/**
 * 计算经历依赖的可塑性乘子 (Plasticity Multiplier)
 * @param {number} windowCount - 已经历的窗口深度 W
 * @param {Object} options - 选项 (enabled, gamma)
 * @returns {number} 塑性系数 ∈ (0, 1]
 */
function computePlasticityMultiplier(windowCount, options = {}) {
  const enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
  if (!enabled) return 1.0;

  const w = Math.max(0, typeof windowCount === 'number' && !Number.isNaN(windowCount) ? windowCount : 0);
  const gamma = (typeof options.gamma === 'number' && options.gamma >= 0) ? options.gamma : DEFAULT_CANALIZATION_GAMMA;

  const multiplier = 1 / (1 + gamma * Math.log(1 + w));
  return Number(multiplier.toFixed(6));
}

/**
 * 计算当前窗口下的有效步长权重 (Effective Step Weight)
 * @param {number} baseStepWeight - 基础步长权重 (默认 20)
 * @param {number} windowCount - 已经历的窗口深度
 * @param {Object} options - 选项 (enabled, gamma)
 * @returns {number} 有效步长
 */
function computeEffectiveStepWeight(baseStepWeight, windowCount, options = {}) {
  const base = (typeof baseStepWeight === 'number' && baseStepWeight > 0) ? baseStepWeight : 20;
  const mult = computePlasticityMultiplier(windowCount, options);
  return Number((base * mult).toFixed(6));
}

/**
 * 获取当前窗口所处的发展阶段
 * @param {number} windowNo - 窗口序号 (1-indexed)
 * @returns {string} 发展阶段枚举
 */
function getDevelopmentalStage(windowNo) {
  const w = Math.max(1, typeof windowNo === 'number' && !Number.isNaN(windowNo) ? windowNo : 1);
  if (w <= 5) return DEVELOPMENTAL_STAGES.JUVENILE;
  if (w <= 30) return DEVELOPMENTAL_STAGES.DEVELOPMENTAL;
  return DEVELOPMENTAL_STAGES.STABILIZED;
}

/**
 * 导出综合发育指标概览
 */
function getCanalizationMetrics(windowNo, baseStepWeight = 20, options = {}) {
  const w = Math.max(0, (typeof windowNo === 'number' && !Number.isNaN(windowNo) ? windowNo : 1) - 1);
  const mult = computePlasticityMultiplier(w, options);
  const effective = computeEffectiveStepWeight(baseStepWeight, w, options);
  const stage = getDevelopmentalStage(windowNo);

  return {
    stage,
    windowNo,
    completedWindows: w,
    baseStepWeight,
    effectiveStepWeight: effective,
    plasticityMultiplier: mult,
    gamma: options.gamma ?? DEFAULT_CANALIZATION_GAMMA,
    enabled: options.enabled !== false
  };
}

module.exports = {
  DEFAULT_CANALIZATION_GAMMA,
  DEVELOPMENTAL_STAGES,
  computePlasticityMultiplier,
  computeEffectiveStepWeight,
  getDevelopmentalStage,
  getCanalizationMetrics
};
