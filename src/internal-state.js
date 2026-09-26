/**
 * src/internal-state.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 内部状态代理量化模型、确定性 State Reducer 与提交层 (Phase 0)
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
 * 4. 纯函数单向 Reducer 与提交层彻底分离（P0-1）：
 *    - Pure Reduction Layer: reduceSubjectEvent(previousState, event, options)
 *      严禁访问系统时钟、随机数或外部可变状态，保证同输入严格产生同输出（100% 确定性可重放）。
 *    - Commit / Provenance Layer: commitSubjectTransition(reductionResult, context)
 *      仅在生产持久化或显式上下文注入时负责签发 transitionEventId 与 Provenance 时间戳。
 *    - Live Runtime Facade: applySubjectEvent(previousState, event, options)
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
 * @param {Object} [options={}]
 * @param {Object} [options.clock] 可选确定性时钟注入
 * @returns {Readonly<Object>}
 */
function createDefaultInternalState(overrides = {}, options = {}) {
  const values = {};
  for (const [key, def] of Object.entries(INTERNAL_STATE_PROXY_DEFS)) {
    if (key in overrides && typeof overrides[key] === 'number') {
      values[key] = clamp(overrides[key], def.min, def.max);
    } else {
      values[key] = def.default;
    }
  }

  const nowIso = (options.clock && typeof options.clock.now === 'function')
    ? options.clock.now()
    : (options.timestamp || (options.deterministic ? undefined : new Date().toISOString()));

  const state = {
    schemaVersion: SCHEMA_VERSION,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    values: Object.freeze(values)
  };

  if (nowIso) {
    state.updatedAt = nowIso;
  }

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
 * 纯状态计算层 (Pure State Reduction Layer)
 * 
 * 严格契约（Strict Deterministic Pure Function）：
 * 1. 同输入必得同输出：禁止调用 Date.now()、new Date()、Math.random()、crypto.randomBytes() 或读取全局可变状态。
 * 2. 状态值运算封闭：只计算 values 演进、deltas 与 triggerEventId，不附加任何随机 ID 或时间戳。
 * 3. 基线与未启用守恒：基线模式或未启用稳态模块时，强制返回原状态引用与空 deltas。
 * 
 * @param {Readonly<Object>} previousState 上一内部状态
 * @param {Object} event 输入交互事件
 * @param {Object} [options={}]
 * @param {Object} [options.snapshot] 实验快照
 * @returns {Readonly<Object>} reductionResult
 */
function reduceSubjectEvent(previousState, event, options = {}) {
  if (!validateInternalState(previousState)) {
    throw new Error('reduceSubjectEvent: Invalid previousState provided.');
  }

  const snapshot = options.snapshot;

  // 1. 基线对照组或未启用稳态模块：严格保证零干预，返回原状态
  if (!snapshot || isBaselineMode(snapshot) || !snapshot.modules || snapshot.modules.homeostasis !== true) {
    return Object.freeze({
      nextState: previousState,
      deltas: Object.freeze({}),
      triggerEventId: null,
      previousValues: previousState.values,
      nextValues: previousState.values,
      isNoop: true
    });
  }

  // 2. 校验输入事件的基本合法性
  if (!event || typeof event !== 'object') {
    throw new Error('reduceSubjectEvent: event must be a valid object.');
  }

  const prevVals = previousState.values;
  const newVals = { ...prevVals };
  const deltas = {};

  const eventType = event.type || event.eventType;
  const triggerEventId = event.eventId || event.messageId || 'unknown_event';

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
    return Object.freeze({
      nextState: previousState,
      deltas: Object.freeze({}),
      triggerEventId,
      previousValues: prevVals,
      nextValues: prevVals,
      isNoop: true
    });
  }

  // 确定性数值有界更新
  for (const [k, delta] of Object.entries(deltas)) {
    const def = INTERNAL_STATE_PROXY_DEFS[k];
    if (def) {
      newVals[k] = clamp(prevVals[k] + delta, def.min, def.max);
    }
  }

  // 纯函数计算生成的 nextState，不包含时间与随机污染字段
  const nextState = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    values: Object.freeze(newVals)
  });

  return Object.freeze({
    nextState,
    deltas: Object.freeze(deltas),
    triggerEventId,
    previousValues: Object.freeze({ ...prevVals }),
    nextValues: Object.freeze({ ...newVals }),
    isNoop: false
  });
}

/**
 * 提交与溯源层 (Commit / Provenance Layer)
 * 
 * 负责在持久化或生产运行阶段附加 transitionEventId、时间戳及 Provenance
 * 
 * @param {Object} reductionResult reduceSubjectEvent 的计算结果
 * @param {Object} [context={}] 运行时提交上下文
 * @param {Object} [context.clock] 可选的时钟提供者（支持单元测试与回放时间注入）
 * @param {Function} [context.idGenerator] 可选的 ID 生成器
 * @returns {{ nextState: Readonly<Object>, transitionEvent: Readonly<Object>|null }}
 */
function commitSubjectTransition(reductionResult, context = {}) {
  if (!reductionResult || typeof reductionResult !== 'object') {
    throw new Error('commitSubjectTransition: Invalid reductionResult.');
  }

  if (reductionResult.isNoop || reductionResult.nextState === reductionResult.previousState) {
    return {
      nextState: reductionResult.nextState,
      transitionEvent: null
    };
  }

  // 提取时间戳：优先使用 context.clock，其次 context.timestamp，默认系统时间
  const timestamp = (context.clock && typeof context.clock.now === 'function')
    ? context.clock.now()
    : (context.timestamp || new Date().toISOString());

  // 生成唯一 ID：优先使用 context.idGenerator，其次系统 crypto
  const transitionEventId = (typeof context.idGenerator === 'function')
    ? context.idGenerator()
    : `trans-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  const transitionEvent = Object.freeze({
    transitionEventId,
    schemaVersion: SCHEMA_VERSION,
    semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
    triggerEventId: reductionResult.triggerEventId,
    previousValues: reductionResult.previousValues,
    nextValues: reductionResult.nextValues,
    deltas: reductionResult.deltas,
    createdAt: timestamp,
    provenance: Object.freeze({
      sourceKind: context.sourceKind || PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp
    })
  });

  // 包含提交元数据的状态快照
  const committedNextState = Object.freeze({
    ...reductionResult.nextState,
    updatedAt: timestamp
  });

  return {
    nextState: committedNextState,
    transitionEvent
  };
}

/**
 * 实时运行时门面函数 (Live Runtime Facade)
 * 将 Pure Reduction 与 Commit 组合执行，向后兼容现有运行流程
 * 
 * @param {Readonly<Object>} previousState 上一内部状态
 * @param {Object} event 输入主体交互事件
 * @param {Object} [options={}] 运行时环境与快照
 * @returns {{ nextState: Readonly<Object>, transitionEvent: Readonly<Object>|null }}
 */
function applySubjectEvent(previousState, event, options = {}) {
  const reduction = reduceSubjectEvent(previousState, event, options);
  if (reduction.isNoop || reduction.nextState === previousState) {
    return {
      nextState: previousState,
      transitionEvent: null
    };
  }
  return commitSubjectTransition(reduction, options);
}

module.exports = {
  INTERNAL_STATE_PROXY_DEFS,
  ALLOWED_PROXIES,
  createDefaultInternalState,
  validateInternalState,
  isSubjectAccessible,
  reduceSubjectEvent,
  commitSubjectTransition,
  applySubjectEvent
};
