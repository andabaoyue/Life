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

const crypto = require('crypto');
const { SCHEMA_VERSION } = require('./experiment-types');
const { InternalRegulationManager } = require('./internal-regulation');
const { BehaviorScheduler } = require('./behavior-scheduler');
const { SubjectState } = require('./subject-state');
const { evaluateAttentionGate } = require('./attention-gate');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

function normalizeState(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const sorted = {};
  for (const k of Object.keys(obj).sort()) {
    if (!['updatedAt', 'timestamp', 'lastUpdated', 't'].includes(k)) {
      sorted[k] = obj[k];
    }
  }
  return sorted;
}

function canonicalizeEvent(item) {
  if (!item) return '';
  if (typeof item === 'function') {
    // 显式提取受控实验签名
    const explicitSignature = (typeof item.eventSignature === 'string' && item.eventSignature.trim())
      ? item.eventSignature.trim()
      : ((typeof item.signature === 'string' && item.signature.trim()) ? item.signature.trim() : null);

    // 代码体源码签名规范化
    const rawSource = typeof item.toString === 'function' ? item.toString().trim() : '';
    const isNative = !rawSource || rawSource.includes('[native code]');
    const sourceSignature = (!isNative && rawSource.length > 0)
      ? 'body:' + sha256(rawSource.replace(/\s+/g, ' '))
      : null;

    // 无法证明等价性的裸函数事件（如 native/bound 函数且无显式签名），直接标记不可审计
    if (!explicitSignature && !sourceSignature) {
      return canonicalStringify({
        type: 'unverifiable_function',
        name: item.name || 'anonymous',
        unverifiable: true,
        token: crypto.randomBytes(8).toString('hex')
      });
    }

    const eventName = (typeof item.eventName === 'string' && item.eventName.trim())
      ? item.eventName.trim()
      : (explicitSignature ? explicitSignature : (item.name || 'anonymous'));

    return canonicalStringify({
      type: 'function',
      name: eventName,
      signature: explicitSignature || sourceSignature
    });
  }
  if (typeof item === 'object') {
    const clean = {
      type: item.type || 'unknown'
    };
    if (item.activityKind !== undefined) clean.activityKind = item.activityKind;
    if (item.isAsleep !== undefined) clean.isAsleep = Boolean(item.isAsleep);
    if (item.windowNo !== undefined) clean.windowNo = item.windowNo;

    if (item.payload && typeof item.payload === 'object') {
      clean.payload = {};
      for (const k of Object.keys(item.payload).sort()) {
        if (!['t', 'timestamp', 'id', 'uuid', 'eventId', 'runId', '_id'].includes(k)) {
          clean.payload[k] = item.payload[k];
        }
      }
    }

    if (Array.isArray(item.evidenceList)) {
      clean.evidenceList = item.evidenceList.map(ev => ({
        trait: ev.trait,
        direction: ev.direction,
        strength: ev.strength,
        quote: ev.quote,
        sourceType: ev.sourceType,
        sourceWindow: ev.sourceWindow
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }

    return canonicalStringify(clean);
  }
  return String(item);
}

function canonicalizeConfig(cfg = {}) {
  const clean = {
    experimentMode: cfg.experimentMode || 'enabled',
    experimentModules: normalizeState(cfg.experimentModules || {})
  };
  return canonicalStringify(clean);
}

function canonicalizeProbe(probe = {}) {
  const clean = {
    category: probe.category || 'environmental_probe',
    salience: Number(probe.salience ?? 42),
    intensity: Number(probe.intensity ?? 45)
  };
  return canonicalStringify(clean);
}

/**
 * 运行标准两路路径依赖对照实验
 * 
 * 强制执行五大前置条件核验 (Preconditions Audit)：
 * 1. 初始状态严格相同 (Initial State Identity)
 * 2. 事件 Multiset 完全一致 (Event Set Multiset Identity)
 * 3. 实验配置一致 (Config Identity)
 * 4. 探测环境一致 (Probe Identity)
 * 5. 生成完整审计快照 (Preconditions Audit)
 *
 * @param {Object} options
 * @param {Array<Function|Object>} options.sequenceA 实验组 A 历史事件序列
 * @param {Array<Function|Object>} options.sequenceB 实验组 B 历史事件序列
 * @param {Object} [options.probeStimulus] 最终一致的环境探测刺激
 * @param {Object} [options.probeStimulusA] 探测刺激 A (若显式传入用于一致性校验)
 * @param {Object} [options.probeStimulusB] 探测刺激 B (若显式传入用于一致性校验)
 * @param {Object} [options.config={}] 实验配置 (支持 experimentModules)
 * @param {Object} [options.configA] 配置 A (若显式传入用于一致性校验)
 * @param {Object} [options.configB] 配置 B (若显式传入用于一致性校验)
 * @param {string} [options.userDataDirA] 隔离测试目录 A
 * @param {string} [options.userDataDirB] 隔离测试目录 B
 * @param {Object} [options.initialStateA] 显式初始状态 A
 * @param {Object} [options.initialStateB] 显式初始状态 B
 * @param {boolean} [options.throwOnError=false] 是否在前置条件不满足时抛出异常
 * @returns {Readonly<Object>}
 */
function runPathDependencyExperiment(options = {}) {
  const {
    sequenceA = [],
    sequenceB = [],
    probeStimulus,
    probeStimulusA,
    probeStimulusB,
    config = {},
    configA,
    configB,
    userDataDirA,
    userDataDirB,
    initialStateA,
    initialStateB,
    throwOnError = false
  } = options;

  const effectiveConfigA = configA || config || {};
  const effectiveConfigB = configB || config || {};

  const effectiveProbeA = probeStimulusA || probeStimulus || { category: 'environmental_probe', salience: 42, intensity: 45 };
  const effectiveProbeB = probeStimulusB || probeStimulus || { category: 'environmental_probe', salience: 42, intensity: 45 };

  // 1. 初始状态前置条件核验 (Initial State Identity)
  const initRegA = new InternalRegulationManager(userDataDirA || '', {
    enabled: effectiveConfigA.experimentModules?.internalRegulation !== false,
    experimentModules: effectiveConfigA.experimentModules
  });
  if (initialStateA?.internalRegulation) {
    Object.assign(initRegA, initialStateA.internalRegulation);
    if (typeof initialStateA.internalRegulation.arousal === 'number') {
      initRegA.salienceThreshold = initRegA._computeSalienceThreshold(initRegA.arousal);
    }
  }
  const initSubA = new SubjectState(userDataDirA || '', {
    experimentModules: effectiveConfigA.experimentModules
  });
  if (initialStateA?.subjectState) {
    if (initialStateA.subjectState.values) {
      initSubA.data.values = { ...initialStateA.subjectState.values };
    }
    if (initialStateA.subjectState.history) {
      initSubA.data.history = [...initialStateA.subjectState.history];
    }
  }

  const initRegB = new InternalRegulationManager(userDataDirB || '', {
    enabled: effectiveConfigB.experimentModules?.internalRegulation !== false,
    experimentModules: effectiveConfigB.experimentModules
  });
  if (initialStateB?.internalRegulation) {
    Object.assign(initRegB, initialStateB.internalRegulation);
    if (typeof initialStateB.internalRegulation.arousal === 'number') {
      initRegB.salienceThreshold = initRegB._computeSalienceThreshold(initRegB.arousal);
    }
  }
  const initSubB = new SubjectState(userDataDirB || '', {
    experimentModules: effectiveConfigB.experimentModules
  });
  if (initialStateB?.subjectState) {
    if (initialStateB.subjectState.values) {
      initSubB.data.values = { ...initialStateB.subjectState.values };
    }
    if (initialStateB.subjectState.history) {
      initSubB.data.history = [...initialStateB.subjectState.history];
    }
  }

  const snapshotA = {
    internalRegulation: normalizeState(initRegA.getState()),
    subjectState: {
      values: normalizeState(initSubA.values),
      history: Array.isArray(initSubA.data?.history) ? initSubA.data.history : []
    }
  };
  const snapshotB = {
    internalRegulation: normalizeState(initRegB.getState()),
    subjectState: {
      values: normalizeState(initSubB.values),
      history: Array.isArray(initSubB.data?.history) ? initSubB.data.history : []
    }
  };

  const initHashA = 'sha256:' + sha256(JSON.stringify(snapshotA));
  const initHashB = 'sha256:' + sha256(JSON.stringify(snapshotB));
  const initialStateEqual = (initHashA === initHashB);

  // 2. 事件 Multiset 完全一致核验 (Event Set Multiset Identity)
  const eventSetA = sequenceA.map(canonicalizeEvent).sort();
  const eventSetB = sequenceB.map(canonicalizeEvent).sort();
  const eventSetHashA = 'sha256:' + sha256(JSON.stringify(eventSetA));
  const eventSetHashB = 'sha256:' + sha256(JSON.stringify(eventSetB));
  const eventMultisetEqual = (eventSetHashA === eventSetHashB);

  // 3. 实验配置一致性核验 (Config Identity)
  const configHashA = 'sha256:' + sha256(canonicalizeConfig(effectiveConfigA));
  const configHashB = 'sha256:' + sha256(canonicalizeConfig(effectiveConfigB));
  const configEqual = (configHashA === configHashB);

  // 4. Probe Stimulus 一致性核验 (Probe Identity)
  const probeHashA = 'sha256:' + sha256(canonicalizeProbe(effectiveProbeA));
  const probeHashB = 'sha256:' + sha256(canonicalizeProbe(effectiveProbeB));
  const probeEqual = (probeHashA === probeHashB);

  // 综合前置条件判定
  let reason = null;
  const hasUnverifiableFunction = eventSetA.some(s => s.includes('"unverifiable_function"')) ||
                                  eventSetB.some(s => s.includes('"unverifiable_function"'));
  if (hasUnverifiableFunction) {
    reason = 'PATH_EXPERIMENT_UNVERIFIABLE_FUNCTION_EVENT';
  } else if (!initialStateEqual) {
    reason = 'PATH_EXPERIMENT_INITIAL_STATE_MISMATCH';
  } else if (!eventMultisetEqual) {
    reason = 'PATH_EXPERIMENT_EVENT_SET_MISMATCH';
  } else if (!configEqual) {
    reason = 'PATH_EXPERIMENT_CONFIG_MISMATCH';
  } else if (!probeEqual) {
    reason = 'PATH_EXPERIMENT_PROBE_MISMATCH';
  }

  const preconditions = {
    valid: Boolean(!reason),
    initialStateEqual,
    eventMultisetEqual,
    configEqual,
    probeEqual,
    initialStateHash: initHashA,
    eventSetHashA,
    eventSetHashB,
    configHash: configHashA,
    probeHash: probeHashA
  };
  if (!initialStateEqual) preconditions.initialStateHashB = initHashB;
  if (!configEqual) preconditions.configHashB = configHashB;
  if (!probeEqual) preconditions.probeHashB = probeHashB;

  if (!preconditions.valid) {
    preconditions.reason = reason;
    if (throwOnError) {
      throw new Error(reason);
    }
    return Object.freeze({
      valid: false,
      reason,
      pathDependencyEstablished: false,
      preconditions
    });
  }

  function executeTrajectory(sequence, dir, effectiveCfg, initialState, probe) {
    const reg = new InternalRegulationManager(dir || '', {
      enabled: effectiveCfg.experimentModules?.internalRegulation !== false,
      experimentModules: effectiveCfg.experimentModules
    });
    if (initialState?.internalRegulation) {
      Object.assign(reg, initialState.internalRegulation);
      if (typeof initialState.internalRegulation.arousal === 'number') {
        reg.salienceThreshold = reg._computeSalienceThreshold(reg.arousal);
      }
    }
    const scheduler = new BehaviorScheduler({ internalRegulation: reg });
    const subjectState = new SubjectState(dir || '', {
      experimentModules: effectiveCfg.experimentModules
    });
    if (initialState?.subjectState) {
      if (initialState.subjectState.values) {
        subjectState.data.values = { ...initialState.subjectState.values };
      }
      if (initialState.subjectState.history) {
        subjectState.data.history = [...initialState.subjectState.history];
      }
    }

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
            canalization: effectiveCfg.experimentModules?.biographicalCanalization !== false,
            experimentModules: effectiveCfg.experimentModules
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
      category: probe.category || 'general_stimulus',
      salience: probe.salience || 42,
      intensity: probe.intensity || 45,
      subjectAccessible: false
    };
    const attentionResult = evaluateAttentionGate(candidate, reg, {
      modules: effectiveCfg.experimentModules
    });

    return {
      internalRegulation: stateReg,
      behaviorDistribution: behaviorWeights,
      attentionResult,
      subjectState: stateValues
    };
  }

  const trajectoryA = executeTrajectory(sequenceA, userDataDirA, effectiveConfigA, initialStateA, effectiveProbeA);
  const trajectoryB = executeTrajectory(sequenceB, userDataDirB, effectiveConfigB, initialStateB, effectiveProbeB);

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
    valid: true,
    schemaVersion: SCHEMA_VERSION,
    preconditions,
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
  runPathDependencyExperiment,
  canonicalizeEvent,
  canonicalizeConfig,
  canonicalizeProbe
};
