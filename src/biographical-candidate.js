/**
 * src/biographical-candidate.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 自传印痕候选状态机与防循环证明验证器 (Phase 0)
 * 
 * 核心哲学与工程边界：
 * 1. 自传传记空白（Biographical Tabula Rasa）：
 *    初澜的自我认知只能通过真实交互经历沉淀，系统严禁直接写入现成的人生故事。
 * 2. 防循环证明铁律（Anti-Circular Proof Invariant）：
 *    - 单次事件绝对无法直接结晶为不可逆的自传印痕（DefiningMoment）。
 *    - 严防“系统诱导循环证明”：系统提示词诱发的话语（SYSTEM_INDUCED），
 *      绝对不能作为初澜“自主引用（CITED_BY_SUBJECT）”该印痕的有效证据！
 * 3. 严格四阶候选状态机：
 *    PROPOSED -> REINFORCED -> CITED_BY_SUBJECT -> CRYSTALLIZED (或 DISCARDED)
 */

'use strict';

const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  CANDIDATE_STATUS,
  BEHAVIOR_ORIGIN,
  PROVENANCE_SOURCE_KINDS
} = require('./experiment-types');

/**
 * 创建初始自传候选记录（进入 PROPOSED 状态）
 * 
 * @param {Object} initialEvent
 * @param {Object} [options={}]
 * @returns {Readonly<Object>}
 */
function createBiographicalCandidate(initialEvent, options = {}) {
  if (!initialEvent || (!initialEvent.eventId && !initialEvent.messageId)) {
    throw new Error('createBiographicalCandidate: Valid initial event with eventId/messageId is required.');
  }

  const candidateId = `cand-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();
  const theme = String(options.theme || initialEvent.theme || 'unclassified_experience');
  const windowNo = typeof options.windowNo === 'number' ? options.windowNo : (initialEvent.windowNo || 1);

  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    candidateId,
    theme,
    status: CANDIDATE_STATUS.PROPOSED,
    initialWindowNo: windowNo,
    evidenceEvents: Object.freeze([{
      eventId: initialEvent.eventId || initialEvent.messageId,
      windowNo,
      timestamp: initialEvent.timestamp || nowIso,
      summary: String(initialEvent.summary || initialEvent.content || '')
    }]),
    citationEvents: Object.freeze([]),
    createdAt: nowIso,
    updatedAt: nowIso,
    provenance: Object.freeze({
      sourceKind: options.sourceKind || PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp: nowIso
    })
  };

  return Object.freeze(candidate);
}

/**
 * 推进候选状态至 REINFORCED（强化）
 * 条件：必须是不同于初始事件的独立后续事件
 * 
 * @param {Object} candidate
 * @param {Object} reinforcingEvent
 * @param {number} windowNo
 * @returns {Readonly<Object>}
 */
function reinforceCandidate(candidate, reinforcingEvent, windowNo = 1) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('reinforceCandidate: Invalid candidate.');
  }
  if (!reinforcingEvent || (!reinforcingEvent.eventId && !reinforcingEvent.messageId)) {
    throw new Error('reinforceCandidate: Valid reinforcingEvent is required.');
  }

  const refEventId = reinforcingEvent.eventId || reinforcingEvent.messageId;
  const initialEventId = candidate.evidenceEvents[0]?.eventId;

  if (refEventId === initialEventId) {
    throw new Error('Anti-circular violation: Cannot reinforce a candidate using the identical initial event.');
  }

  // 必须处于 PROPOSED 或已经是 REINFORCED
  if (candidate.status !== CANDIDATE_STATUS.PROPOSED && candidate.status !== CANDIDATE_STATUS.REINFORCED) {
    throw new Error(`Invalid status transition: Cannot reinforce candidate in state ${candidate.status}`);
  }

  const nowIso = new Date().toISOString();
  const newEvidences = [
    ...candidate.evidenceEvents,
    {
      eventId: refEventId,
      windowNo: typeof windowNo === 'number' ? windowNo : 1,
      timestamp: reinforcingEvent.timestamp || nowIso,
      summary: String(reinforcingEvent.summary || reinforcingEvent.content || '')
    }
  ];

  const updated = {
    ...candidate,
    status: CANDIDATE_STATUS.REINFORCED,
    evidenceEvents: Object.freeze(newEvidences),
    updatedAt: nowIso
  };

  return Object.freeze(updated);
}

/**
 * 推进候选状态至 CITED_BY_SUBJECT（被主体自主引用）
 * 
 * 核心防循环安全门禁：
 * 若行为起源被标记为 SYSTEM_INDUCED（由系统诱导），坚决拒绝转为 CITED_BY_SUBJECT！
 * 
 * @param {Object} candidate
 * @param {Object} citationEvent
 * @returns {Readonly<Object>}
 */
function citeCandidateBySubject(candidate, citationEvent) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('citeCandidateBySubject: Invalid candidate.');
  }
  if (!citationEvent || typeof citationEvent !== 'object') {
    throw new Error('citeCandidateBySubject: Valid citationEvent is required.');
  }

  // 1. 严格检查行为起源（防循环证明）
  const origin = citationEvent.behaviorOrigin;
  if (origin === BEHAVIOR_ORIGIN.SYSTEM_INDUCED) {
    throw new Error(
      'Anti-circular violation: System-induced behavior (SYSTEM_INDUCED) cannot be used as subject citation evidence.'
    );
  }
  if (origin !== BEHAVIOR_ORIGIN.SUBJECT_GENERATED) {
    throw new Error(
      `citeCandidateBySubject: Citation event must have origin "${BEHAVIOR_ORIGIN.SUBJECT_GENERATED}". Got "${origin}".`
    );
  }

  // 2. 状态检查：必须已达到 REINFORCED 阶段（严禁单次事件直接被引用跳级结晶）
  if (candidate.status !== CANDIDATE_STATUS.REINFORCED && candidate.status !== CANDIDATE_STATUS.CITED_BY_SUBJECT) {
    throw new Error(
      `Invalid status transition: Candidate must be in REINFORCED state before subject citation. Current status: ${candidate.status}`
    );
  }

  const citationEventId = citationEvent.eventId || citationEvent.messageId || `cite-${Date.now()}`;
  const nowIso = new Date().toISOString();

  const newCitations = [
    ...candidate.citationEvents,
    {
      eventId: citationEventId,
      windowNo: citationEvent.windowNo || candidate.initialWindowNo,
      behaviorOrigin: BEHAVIOR_ORIGIN.SUBJECT_GENERATED,
      quote: String(citationEvent.quote || citationEvent.content || ''),
      timestamp: citationEvent.timestamp || nowIso
    }
  ];

  const updated = {
    ...candidate,
    status: CANDIDATE_STATUS.CITED_BY_SUBJECT,
    citationEvents: Object.freeze(newCitations),
    updatedAt: nowIso
  };

  return Object.freeze(updated);
}

/**
 * 固化结晶为不可逆自传印痕（CRYSTALLIZED DefiningMoment）
 * 
 * 只有完整经历了 PROPOSED -> REINFORCED -> CITED_BY_SUBJECT 链条，
 * 且至少拥有 2 条独立事件证据与 1 条主体自主引用，方可通过结晶审计。
 * 
 * @param {Object} candidate
 * @returns {Readonly<Object>}
 */
function crystallizeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('crystallizeCandidate: Invalid candidate.');
  }

  // 1. 状态要求必须为 CITED_BY_SUBJECT
  if (candidate.status !== CANDIDATE_STATUS.CITED_BY_SUBJECT) {
    throw new Error(
      `Anti-circular violation: Cannot crystallize candidate in status "${candidate.status}". Must be "${CANDIDATE_STATUS.CITED_BY_SUBJECT}".`
    );
  }

  // 2. 证据数必须 >= 2（多源独立）
  if (!Array.isArray(candidate.evidenceEvents) || candidate.evidenceEvents.length < 2) {
    throw new Error('Anti-circular violation: Candidate must have at least 2 distinct evidence events to crystallize.');
  }

  // 3. 必须至少有 1 条真实的 SUBJECT_GENERATED 引用
  if (!Array.isArray(candidate.citationEvents) || candidate.citationEvents.length < 1) {
    throw new Error('Anti-circular violation: Candidate must have at least 1 subject citation to crystallize.');
  }

  // 4. 确认所有引用事件均无 SYSTEM_INDUCED
  const hasSystemInduced = candidate.citationEvents.some(c => c.behaviorOrigin === BEHAVIOR_ORIGIN.SYSTEM_INDUCED);
  if (hasSystemInduced) {
    throw new Error('Anti-circular violation: Tainted with SYSTEM_INDUCED citation event.');
  }

  const nowIso = new Date().toISOString();
  const crystallized = {
    ...candidate,
    status: CANDIDATE_STATUS.CRYSTALLIZED,
    crystallizedAt: nowIso,
    updatedAt: nowIso
  };

  return Object.freeze(crystallized);
}

module.exports = {
  createBiographicalCandidate,
  reinforceCandidate,
  citeCandidateBySubject,
  crystallizeCandidate
};
