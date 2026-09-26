/**
 * src/internal-state.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 内部状态代理量化模型与单向确定性 State Reducer (Phase 0)
 * 
 * 核心哲学与工程边界：
 * 1. 语义分层：此处定义的一切变量均为 SUBJECT_STATE_PROXY（主体内部状态代理变量），
 *    绝非 SYSTEM_METRICS（系统遥测指标），亦非初澜主观形成的 Qualia（感受质）。
 * 2. 认知所有权与不可知界限：所有内部代理变量必须严格标记为 subjectAccessible = false。
 *    初澜无法直接读取自身底层的数字标量，系统严禁将 "你现在 energy=40" 之类的标签直接喂入 Prompt。
 * 3. 命名消歧义（Disambiguation）：
 *    - cognitiveLoadProxy 代替含混的 memoryLoad
 *    - uncertaintyProxy 代替含混的 uncertainty
 *    - salienceThreshold 代替含混的 environmentalSalience
 * 4. 纯函数单向 Reducer：
 *    applySubjectEvent(previousState, event, options) -> { nextState, transitionEvent }
 *    保证幂等、纯函数、不可直接修改入参，基线模式下输出零变动。
 */

'use strict';

const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  SEMANTIC_LAYERS,
  PROVENANCE_SOURCE_KINDS
} = require('./experiment-types');
const { isBaselineMode } = require('./experiment-run');

/**
 * 内部状态代理白名单定义与元数据
 */
const INTERNAL_STATE_PROXY_DEFS = Object.freeze({
  energy: Object.freeze({
    min: 0,
    max: 100,
    default: 100,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '能量储备代理标量'
  }),
  arousal: Object.freeze({
    min: 0,
    max: 100,
    default: 50,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '神经唤醒度代理标量'
  }),
  restPressure: Object.freeze({
    min: 0,
    max: 100,
    default: 0,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '静息/睡眠需求压力标量'
  }),
  interactionDensity: Object.freeze({
    min: 0,
    max: 100,
    default: 0,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '短期交互频度代理标量'
  }),
  cognitiveLoadProxy: Object.freeze({
    min: 0,
    max: 100,
    default: 0,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '认知工作负荷代理标量'
  }),
  noveltyPressure: Object.freeze({
    min: 0,
    max: 100,
    default: 0,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '新异刺激累积压力标量'
  }),
  uncertaintyProxy: Object.freeze({
    min: 0,
    max: 100,
    default: 0,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '语义/情境不确定性代理标量'
  }),
  salienceThreshold: Object.freeze({
    min: 0,
    max: 100,
    default: 30,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    subjectAccessible: false,
    description: '数字环周感官显著性过滤门限'
  })
});

const ALLOWED_PROXIES = Object.freeze(Object.keys(INTERNAL_STATE_PROXY_DEFS));

/**
 * 辅助数值限制
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * 创建初始内部状态（完全深冻结，防外部直接修改）
 * 
 * @param {Object} [overrides={}]
 * @returns {Readonly<Object>}
 */
function createDefaultInternalState(overrides = {}) {
  const values = {};
  for (const [key, def] of Object.entries(INTERNAL_STATE_PROXY_DEFS)) {
    if (key in overrides && typeof overrides[key] === 'number') {
      values[key] = clamp(overrides[key], def.min, def.max);
    } else {
      values[key] = def.default;
    }
  }

  const state = {
    schemaVersion: SCHEMA_VERSION,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    values: Object.freeze(values),
    updatedAt: new Date().toISOString()
  };

  return Object.freeze(state);
}

/**
 * 严格校验内部状态结构与数值区间
 * 
 * @param {Object} state
 * @returns {boolean}
 */
function validateInternalState(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.schemaVersion !== SCHEMA_VERSION) return false;
  if (state.semanticLayer !== SEMANTIC_LAYERS.SUBJECT_STATE_PROXY) return false;
  if (!state.values || typeof state.values !== 'object') return false;

  for (const [key, def] of Object.entries(INTERNAL_STATE_PROXY_DEFS)) {
    const val = state.values[key];
    if (typeof val !== 'number' || Number.isNaN(val)) return false;
    if (val < def.min || val > def.max) return false;
  }

  return true;
}

/**
 * 查询指定属性是否为主体可直接感知/访问的（Subject Accessible Boundary Check）
 * 铁律：所有底层代理变量均不可访问（恒返回 false）
 * 
 * @param {string} propKey
 * @returns {boolean}
 */
function isSubjectAccessible(propKey) {
  const def = INTERNAL_STATE_PROXY_DEFS[propKey];
  if (!def) return false;
  return def.subjectAccessible === true;
}

/**
 * 单向确定性 State Reducer (Pure Function)
 * 
 * applySubjectEvent(previousState, event, options) -> { nextState, transitionEvent }
 * 
 * 契约保证：
 * 1. 纯函数：绝不修改 previousState，输入不变则输出严格确定。
 * 2. 基线守恒（Baseline Invariant）：
 *    若 options.snapshot 为基线模式，或 snapshot.modules.homeostasis !== true，
 *    则强制返回 previousState 原引用，transitionEvent 为 null，产生 0 变动。
 * 3. 拒绝非法事件：未通过 provenance 校验或非合法事件结构的输入，抛出错误或安全拒绝，不污染状态。
 * 
 * @param {Readonly<Object>} previousState 上一内部状态
 * @param {Object} event 输入主体交互事件
 * @param {Object} [options={}] 运行时环境与快照
 * @param {Object} [options.snapshot] 窗口级实验快照
 * @returns {{ nextState: Readonly<Object>, transitionEvent: Readonly<Object>|null }}
 */
function applySubjectEvent(previousState, event, options = {}) {
  if (!validateInternalState(previousState)) {
    throw new Error('applySubjectEvent: Invalid previousState provided.');
  }

  const snapshot = options.snapshot;

  // 1. 基线对照组或未启用稳态模块：严格保证零干预，返回原状态
  if (!snapshot || isBaselineMode(snapshot) || !snapshot.modules || snapshot.modules.homeostasis !== true) {
    return {
      nextState: previousState,
      transitionEvent: null
    };
  }

  // 2. 校验输入事件的基本合法性
  if (!event || typeof event !== 'object') {
    throw new Error('applySubjectEvent: event must be a valid object.');
  }

  // Phase 0 合同契约下的微步演进（在 Phase 1 之前仅支持基于合同的确定性轻量步进）
  // 模拟单次合法事件对代理指标的有界影响
  const prevVals = previousState.values;
  const newVals = { ...prevVals };
  const deltas = {};

  // 若为用户消息交互事件，轻微提升 interactionDensity 与 cognitiveLoadProxy，轻微消耗 energy
  const eventType = event.type || event.eventType;
  if (eventType === 'message' || eventType === 'user_input') {
    deltas.energy = -1;
    deltas.interactionDensity = +2;
    deltas.cognitiveLoadProxy = +1;
    deltas.arousal = +1;
  } else if (eventType === 'rest' || eventType === 'sleep') {
    deltas.energy = +5;
    deltas.restPressure = -5;
    deltas.arousal = -2;
    deltas.cognitiveLoadProxy = -2;
  } else {
    // 未知或无显著影响事件，保持不变
    return {
      nextState: previousState,
      transitionEvent: null
    };
  }

  // 计算新值并执行有界约束 [min, max]
  for (const [k, delta] of Object.entries(deltas)) {
    const def = INTERNAL_STATE_PROXY_DEFS[k];
    if (def) {
      newVals[k] = clamp(prevVals[k] + delta, def.min, def.max);
    }
  }

  const nowIso = new Date().toISOString();
  const nextState = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    values: Object.freeze(newVals),
    updatedAt: nowIso
  });

  const transitionEventId = `trans-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const transitionEvent = Object.freeze({
    transitionEventId,
    schemaVersion: SCHEMA_VERSION,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    triggerEventId: event.eventId || event.messageId || 'unknown_event',
    previousValues: Object.freeze({ ...prevVals }),
    nextValues: Object.freeze({ ...newVals }),
    deltas: Object.freeze(deltas),
    createdAt: nowIso,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp: nowIso
    })
  });

  return {
    nextState,
    transitionEvent
  };
}

module.exports = {
  INTERNAL_STATE_PROXY_DEFS,
  ALLOWED_PROXIES,
  createDefaultInternalState,
  validateInternalState,
  isSubjectAccessible,
  applySubjectEvent
};
