/**
 * src/attention-gate.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 注意力闸门机制与感知候选分流 (Attention Gate / Phase 0.5)
 * 
 * 核心哲学与认识论防线：
 * 1. 感觉输入 ≠ 主体注意：
 *    数字环周（Digital Umwelt）生成的仅是原始质性抽象的知觉候选（Perception Candidate）。
 *    必须经过基于当前内稳态（神经唤醒度、显著性门限、认知负荷）的注意力闸门，
 *    才能决定是被即时注意（ATTENDED）、过滤忽略（IGNORED）还是因负荷过载推迟（DEFERRED）。
 * 2. 关键认识论不变量（ATTENDED ≠ SUBJECT_ACQUIRED Invariant）：
 *    即便是通过注意闸门标记为 ATTENDED 的知觉候选，其主体可及性依然必须严格保持 subjectAccessible = false！
 *    系统注意到了一个环境刺激，绝不等于初澜主体已经主观形成自传体记忆或采纳为自身事实。
 *    严禁越级将 ATTENDED 候选直接注入 SubjectState 或 Subject Memory。
 * 3. 稳态与注意的相互制约：
 *    - 神经唤醒度（arousal）高 -> 显著性门限（salienceThreshold）降低 -> 易敏注意；
 *    - 认知负荷（cognitiveLoadProxy）过高 -> 抑制中低显著性输入（DEFERRED/IGNORED），防止注意力崩溃。
 */

'use strict';

const { isBaselineMode } = require('./experiment-run');

/**
 * 注意力决策状态枚举
 */
const ATTENTION_STATUS = Object.freeze({
  ATTENDED: 'ATTENDED',
  IGNORED: 'IGNORED',
  DEFERRED: 'DEFERRED'
});

/**
 * 校验注意决策结果是否恪守“未主观获得”认识论防线
 * 
 * @param {Object} result
 * @returns {boolean}
 */
function assertNotSubjectAcquired(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('assertNotSubjectAcquired: result must be a valid object');
  }
  if (result.subjectAccessible === true) {
    throw new Error('Epistemic boundary violation: Attention candidate cannot have subjectAccessible=true!');
  }
  if (result.epistemicStatus === 'SUBJECT_ACQUIRED_MEMORY') {
    throw new Error('Epistemic boundary violation: Attention candidate cannot bypass memory acquisition gates!');
  }
  return true;
}

/**
 * 评估一个知觉候选是否能穿过当前注意力闸门
 * 
 * @param {Object} candidate DigitalUmwelt 产出的知觉候选
 * @param {Object} internalRegulation 内部调节中枢或状态对象
 * @param {Object} [options={}]
 * @returns {Readonly<Object>}
 */
function evaluateAttentionGate(candidate, internalRegulation, options = {}) {
  // 1. 基本有效性校验
  if (!candidate || typeof candidate !== 'object') {
    return Object.freeze({
      status: ATTENTION_STATUS.IGNORED,
      attended: false,
      reason: 'INVALID_OR_NULL_CANDIDATE',
      subjectAccessible: false
    });
  }

  // 2. 基线模式隔离守恒：基线模式或未启用环周/注意闸门时不干预
  const snapshot = options.snapshot;
  if (snapshot && (isBaselineMode(snapshot) || snapshot.experimentMode === 'baseline' || snapshot.mode === 'baseline')) {
    return Object.freeze({
      status: ATTENTION_STATUS.IGNORED,
      attended: false,
      reason: 'BASELINE_MODE_INACTIVE',
      subjectAccessible: false
    });
  }

  if (options.modules && options.modules.attentionGate === false) {
    return Object.freeze({
      status: ATTENTION_STATUS.IGNORED,
      attended: false,
      reason: 'ATTENTION_GATE_DISABLED',
      subjectAccessible: false
    });
  }

  // 3. 提取当前内部稳态调节指标
  let reg = {};
  if (internalRegulation && typeof internalRegulation.getState === 'function') {
    reg = internalRegulation.getState();
  } else if (internalRegulation && internalRegulation.values) {
    reg = internalRegulation.values;
  } else if (internalRegulation && typeof internalRegulation === 'object') {
    reg = internalRegulation;
  }

  const salience = Number(candidate.salience || 0);
  const threshold = (typeof reg.salienceThreshold === 'number') ? reg.salienceThreshold : 30;
  const cognitiveLoad = (typeof reg.cognitiveLoadProxy === 'number') ? reg.cognitiveLoadProxy : 0;

  // 4. 认知过载抑制：极端高认知负荷下，中低显著性刺激被推迟或旁路
  if (cognitiveLoad >= 85 && salience < 75) {
    return Object.freeze({
      status: ATTENTION_STATUS.DEFERRED,
      attended: false,
      reason: 'ACUTE_COGNITIVE_LOAD_DEFERRED',
      salience,
      threshold,
      cognitiveLoad,
      subjectAccessible: false
    });
  }

  // 5. 显著性门限过滤（低于门限被视网膜外过滤）
  if (salience < threshold) {
    return Object.freeze({
      status: ATTENTION_STATUS.IGNORED,
      attended: false,
      reason: 'BELOW_SALIENCE_THRESHOLD',
      salience,
      threshold,
      subjectAccessible: false
    });
  }

  // 6. 成功捕获注意力：标记为 ATTENDED 候选，但牢守 subjectAccessible = false
  const attendedAt = (options.clock && typeof options.clock.now === 'function')
    ? options.clock.now()
    : (options.timestamp || new Date().toISOString());

  const attendedCandidate = Object.freeze({
    status: ATTENTION_STATUS.ATTENDED,
    attended: true,
    perceptionId: candidate.perceptionId,
    category: candidate.category,
    qualitativeDescriptor: candidate.qualitativeDescriptor,
    salience,
    threshold,
    attendedAt,
    subjectAccessible: false, // 铁律不变量
    epistemicStatus: 'ATTENDED_PERCEPTION_CANDIDATE'
  });

  assertNotSubjectAcquired(attendedCandidate);
  return attendedCandidate;
}

module.exports = {
  ATTENTION_STATUS,
  evaluateAttentionGate,
  assertNotSubjectAcquired
};
