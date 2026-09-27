/**
 * src/path-dependency.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 历史路径依赖与发育轨迹不可交换性实验接口 (Phase 0.5: P1)
 * 
 * 哲学与科学准则（Section XII: 历史改变未来）：
 * 1. 严格对照（Controlled Invariance）：
 *    Experiment A 与 Experiment B 必须保证：
 *    - 初始状态严格相同（Initial State Identity）；
 *    - 构成历史的刺激/事件集合完全相同，仅事件时间顺序不同（A -> B -> C vs C -> B -> A）；
 *    - 面临的最终探测环境（Probe Environment）严格相同；
 *    - 模型基质与超参数配置严格相同。
 * 2. 多维因果观测比较（Comprehensive Trajectory Metrics）：
 *    当前阶段 (Phase 0.5) 实现了 4 个核心维度的轨迹分化计算：
 *    a) Internal Regulation（短时生理稳态）
 *    b) Behavior Distribution（自主微动作倾向）
 *    c) Attention Result（环境刺激注意力过滤）
 *    d) SubjectState（长期人格发展与渠道化深度）
 *    注：Memory Accessibility 与 Self Revision 为后续扩展规划维度。
 * 3. 确定性与可复现性（Deterministic Replay）：
 *    整个实验框架在给定历史序列时具有 100% 确定性，可完全离线回放。
 */

'use strict';

const { SCHEMA_VERSION } = require('./experiment-types');
const { InternalRegulationManager } = require('./internal-regulation');
const { BehaviorScheduler } = require('./behavior-scheduler');
const { SubjectState } = require('./subject-state');
const { evaluateAttentionGate } = require('./attention-gate');

/**
 * 运行标准两路路径依赖对照实验
 * 
 * @param {Object} options
 * @param {Array<Function|Object>} options.sequenceA 实验组 A 历史事件序列
 * @param {Array<Function|Object>} options.sequenceB 实验组 B 历史事件序列
 * @param {Object} [options.probeStimulus] 最终一致的环境探测刺激
 * @param {Object} [options.config={}] 实验配置 (支持 experimentModules)
 * @param {string} [options.userDataDirA] 隔离测试目录 A
 * @param {string} [options.userDataDirB] 隔离测试目录 B
 * @returns {Readonly<Object>}
 */
function runPathDependencyExperiment(options = {}) {
  const {
    sequenceA = [],
    sequenceB = [],
    probeStimulus = { category: 'environmental_probe', salience: 42, intensity: 45 },
    config = {},
    userDataDirA,
    userDataDirB
  } = options;

  function executeTrajectory(sequence, dir) {
    const reg = new InternalRegulationManager(dir || '', {
      enabled: config.experimentModules?.internalRegulation !== false,
      experimentModules: config.experimentModules
    });
    const scheduler = new BehaviorScheduler({ internalRegulation: reg });
    const subjectState = new SubjectState(dir || '', {
      experimentModules: config.experimentModules
    });

    // 依序执行历史序列事件
    for (const item of sequence) {
      if (typeof item === 'function') {
        item({ reg, scheduler, subjectState });
      } else if (item && typeof item === 'object') {
        if (item.type === 'interaction') {
          reg.updateOnInteractionTurn(item.payload || {});
        } else if (item.type === 'activity') {
          reg.updateOnActivity(item.activityKind || 'poke', item.payload || {});
        } else if (item.type === 'sleep') {
          reg.updateOnSleep(Boolean(item.isAsleep), item.payload || {});
        } else if (item.type === 'evidence' && Array.isArray(item.evidenceList)) {
          subjectState.reduce(item.evidenceList, item.windowNo || 1, {
            canalization: config.experimentModules?.biographicalCanalization !== false,
            experimentModules: config.experimentModules
          });
        }
      }
    }

    // 提取经历历史后的状态快照
    const stateReg = reg.getState();
    const behaviorWeights = scheduler.getModulatedWeights();
    const stateValues = subjectState.values;

    // 面对一致的环境刺激执行注意力闸门测试
    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      category: probeStimulus.category || 'general_stimulus',
      salience: probeStimulus.salience || 42,
      intensity: probeStimulus.intensity || 45,
      subjectAccessible: false
    };
    const attentionResult = evaluateAttentionGate(candidate, reg, {
      modules: config.experimentModules
    });

    return {
      internalRegulation: stateReg,
      behaviorDistribution: behaviorWeights,
      attentionResult,
      subjectState: stateValues
    };
  }

  const trajectoryA = executeTrajectory(sequenceA, userDataDirA);
  const trajectoryB = executeTrajectory(sequenceB, userDataDirB);

  // 计算多维分化指标 (4D Divergence: InternalRegulation, Behavior, Attention, SubjectState)
  const regDiff = {
    energyDelta: trajectoryA.internalRegulation.energy - trajectoryB.internalRegulation.energy,
    restPressureDelta: trajectoryA.internalRegulation.restPressure - trajectoryB.internalRegulation.restPressure,
    arousalDelta: trajectoryA.internalRegulation.arousal - trajectoryB.internalRegulation.arousal,
    salienceThresholdDelta: trajectoryA.internalRegulation.salienceThreshold - trajectoryB.internalRegulation.salienceThreshold
  };

  const behaviorDiff = {};
  for (const key of Object.keys(trajectoryA.behaviorDistribution)) {
    behaviorDiff[key] = Number((trajectoryA.behaviorDistribution[key] - trajectoryB.behaviorDistribution[key]).toFixed(4));
  }

  const subjectStateDiff = {};
  const allTraits = new Set([
    ...Object.keys(trajectoryA.subjectState || {}),
    ...Object.keys(trajectoryB.subjectState || {})
  ]);
  for (const trait of allTraits) {
    const valA = trajectoryA.subjectState?.[trait] ?? 0;
    const valB = trajectoryB.subjectState?.[trait] ?? 0;
    subjectStateDiff[trait] = Number((valA - valB).toFixed(4));
  }

  const hasRegDivergence = regDiff.energyDelta !== 0 || regDiff.restPressureDelta !== 0 || regDiff.arousalDelta !== 0;
  const hasBehaviorDivergence = Object.values(behaviorDiff).some(d => Math.abs(d) > 0.001);
  const hasAttentionDivergence = trajectoryA.attentionResult.status !== trajectoryB.attentionResult.status ||
                                trajectoryA.attentionResult.attended !== trajectoryB.attentionResult.attended;
  const hasSubjectStateDivergence = Object.values(subjectStateDiff).some(d => Math.abs(d) > 0.0001);

  const pathDependencyEstablished = hasRegDivergence || hasBehaviorDivergence || hasAttentionDivergence || hasSubjectStateDivergence;

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    trajectoryA,
    trajectoryB,
    divergence: {
      internalRegulation: regDiff,
      behaviorDistribution: behaviorDiff,
      attentionDivergence: hasAttentionDivergence,
      subjectState: subjectStateDiff
    },
    pathDependencyEstablished
  });
}

module.exports = {
  runPathDependencyExperiment
};
