/**
 * src/sleep-consolidation-types.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 睡眠记忆认识论三态分立与主体习得记忆证据门禁契约 (Phase 0)
 * 
 * 核心哲学与工程边界：
 * 1. 认识论三态绝不混淆：
 *    - SleepReplayArtifact：离线重放制品（机器重计算产物，非初澜梦境，subjectAccessible = false）
 *    - SystemConsolidatedRepresentation：系统整合表征（外部归纳暂存，未获主体接纳，subjectAccessible = false）
 *    - SubjectAcquiredMemory：主体习得记忆（清醒期经主体主动唤醒并融入经验，subjectAccessible = true）
 * 2. 睡眠三态伪装铁律（Epistemic Separation Invariant）：
 *    系统离线重放和整合产物绝对不能伪装成主体自发回忆直接注入到对白认知层。
 * 3. 彻底封死直接铸造与伪造链路径（P0-2: Watertight Evidence-Gated Subject Memory）：
 *    - 废除直接铸造入口，严禁仅凭一句话或系统提示生成 SubjectAcquiredMemory。
 *    - acquireSubjectMemory 实施全证据链强制验真：
 *      a) 必须提供真实事件存储/校验器（eventStore 强制非空）
 *      b) candidate 必须持有真实注册的 >=2 条 evidenceEvents，且全部能在 eventStore 中真实溯源
 *      c) candidate.citationEvents 必须真实包含该引用事件，且标记为 SUBJECT_GENERATED
 *      d) citationEvent 必须在 eventStore 中真实存在，quote 必须与 candidate 记录严格一致
 *      e) 严格排除任何 SYSTEM_INDUCED 诱发记录与伪造 ID
 */

'use strict';

const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  MEMORY_EPISTEMIC_STATUS,
  PROVENANCE_SOURCE_KINDS,
  CANDIDATE_STATUS,
  BEHAVIOR_ORIGIN
} = require('./experiment-types');

/**
 * 辅助事件存在性校验
 */
function isEventInStore(store, eventId) {
  if (!store || !eventId) return false;
  if (typeof store.hasEvent === 'function') return store.hasEvent(eventId);
  if (typeof store.has === 'function') return store.has(eventId);
  if (typeof store.getEvent === 'function') return Boolean(store.getEvent(eventId));
  return false;
}

/**
 * 创建睡眠重放制品（机器计算中间件）
 * 
 * @param {Object} options
 * @returns {Readonly<Object>}
 */
function createSleepReplayArtifact(options = {}) {
  const artifactId = `sra-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();

  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    artifactId,
    epistemicStatus: MEMORY_EPISTEMIC_STATUS.SLEEP_REPLAY_ARTIFACT,
    sourceEventIds: Object.freeze(Array.isArray(options.sourceEventIds) ? [...options.sourceEventIds] : []),
    replaySequenceLength: typeof options.replaySequenceLength === 'number' ? options.replaySequenceLength : 0,
    metrics: Object.freeze({
      compressionRatio: typeof options.compressionRatio === 'number' ? options.compressionRatio : 1.0,
      replayIterations: typeof options.replayIterations === 'number' ? options.replayIterations : 1
    }),
    subjectAccessible: false, // 严格主体不可见
    createdAt: nowIso,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp: nowIso
    })
  };

  return Object.freeze(artifact);
}

/**
 * 创建系统整合表征（外部知识库/缓冲区暂存）
 * 
 * @param {Object} options
 * @returns {Readonly<Object>}
 */
function createSystemConsolidatedRepresentation(options = {}) {
  const representationId = `scr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();

  const representation = {
    schemaVersion: SCHEMA_VERSION,
    representationId,
    epistemicStatus: MEMORY_EPISTEMIC_STATUS.SYSTEM_CONSOLIDATED,
    clusterTopic: String(options.clusterTopic || 'unlabeled_cluster'),
    salienceScore: typeof options.salienceScore === 'number' ? options.salienceScore : 0,
    abstractSummary: String(options.abstractSummary || ''),
    sourceArtifactId: options.sourceArtifactId || null,
    subjectAccessible: false, // 严格主体不可见
    createdAt: nowIso,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp: nowIso
    })
  };

  return Object.freeze(representation);
}

/**
 * 内部受控构造器：仅供 acquireSubjectMemory 经由全链路严格审查后调用
 * 
 * @private
 */
function _createSubjectAcquiredMemoryValidated(params) {
  const memoryId = `sam-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();

  const memory = {
    schemaVersion: SCHEMA_VERSION,
    memoryId,
    candidateId: params.candidateId,
    citationEventId: params.citationEventId,
    windowNo: params.windowNo,
    epistemicStatus: MEMORY_EPISTEMIC_STATUS.SUBJECT_ACQUIRED,
    topic: params.topic,
    subjectCitationQuote: params.subjectCitationQuote,
    crystallizedContext: params.crystallizedContext || '',
    subjectAccessible: true, // 经检验为主体自主习得自传认知
    acquiredAt: nowIso,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.SUBJECT_DERIVED,
      timestamp: nowIso
    })
  };

  return Object.freeze(memory);
}

/**
 * 废弃并封死直接公共铸造入口（P0-2）
 * 任何人企图不经候选证据链直接调用时强制抛出异常
 */
function createSubjectAcquiredMemory() {
  throw new Error(
    'Direct minting of SubjectAcquiredMemory is strictly prohibited. ' +
    'Subject memory must be evidence-gated through acquireSubjectMemory({ candidate, citationEvent, eventStore, ... }).'
  );
}

/**
 * 经由证据链严格采纳生成主体习得自传记忆 (Acquire Subject Memory)
 * 
 * 强制门禁审查规则（全可信链）：
 * 1. eventStore 必须显式提供，严防无存证伪造
 * 2. candidate 存在且状态为 CITED_BY_SUBJECT 或 CRYSTALLIZED
 * 3. candidate 至少拥有 2 条独立经历事件支撑 (evidenceEvents.length >= 2)，且全部在 eventStore 中真实存在
 * 4. candidate.citationEvents 必须真实包含传入的 citationEvent，且其 behaviorOrigin 必须为 SUBJECT_GENERATED
 * 5. citationEvent 必须在 eventStore 中真实存在
 * 6. citationEvent 与 candidate.citationEvents 的 quote 必须完全一致
 * 7. 严格拦截任何 SYSTEM_INDUCED 诱发行为
 * 8. 时序约束：引用发生时间不得早于原始经历时间
 * 9. 若注入了 experimentSnapshot，核验 experimentRunId 一致性
 * 
 * @param {Object} params
 * @param {Object} params.candidate
 * @param {Object} params.citationEvent
 * @param {Object} params.eventStore 强制必传真实事件库/校验器
 * @param {Object} [params.experimentSnapshot]
 * @param {string} [params.crystallizedContext]
 * @returns {Readonly<Object>} SubjectAcquiredMemory
 */
function acquireSubjectMemory(params = {}) {
  if (!params || typeof params !== 'object') {
    throw new Error('acquireSubjectMemory: Valid params object is required.');
  }

  const { candidate, citationEvent, experimentSnapshot, eventStore, crystallizedContext } = params;

  // 1. 强制要求 eventStore 存证校验器，封锁无背书伪造
  if (!eventStore || typeof eventStore !== 'object') {
    throw new Error('acquireSubjectMemory: Mandatory eventStore is required to verify real historical events.');
  }

  // 2. Candidate 存在性与状态校验
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('acquireSubjectMemory: Valid candidate object is required.');
  }
  if (!candidate.candidateId) {
    throw new Error('acquireSubjectMemory: candidate must have a candidateId.');
  }
  if (candidate.status !== CANDIDATE_STATUS.CITED_BY_SUBJECT && candidate.status !== CANDIDATE_STATUS.CRYSTALLIZED) {
    throw new Error(
      `Anti-circular violation: Candidate must be in CITED_BY_SUBJECT or CRYSTALLIZED status. Current: "${candidate.status}"`
    );
  }

  // 3. Candidate 支撑证据必须 >= 2，且每一条必须在 eventStore 中可证实
  if (!Array.isArray(candidate.evidenceEvents) || candidate.evidenceEvents.length < 2) {
    throw new Error('Anti-circular violation: Candidate must have at least 2 distinct evidence events.');
  }
  for (const ev of candidate.evidenceEvents) {
    const evId = ev && (ev.eventId || ev.messageId);
    if (!evId || !isEventInStore(eventStore, evId)) {
      throw new Error(`Anti-circular violation: Candidate evidence event "${evId}" does not exist in eventStore.`);
    }
  }

  // 4. CitationEvent 存在性与来源合法性
  if (!citationEvent || typeof citationEvent !== 'object') {
    throw new Error('acquireSubjectMemory: Valid citationEvent object is required.');
  }
  const citationEventId = citationEvent.eventId || citationEvent.messageId;
  if (!citationEventId || typeof citationEventId !== 'string') {
    throw new Error('acquireSubjectMemory: citationEvent must have a valid string eventId or messageId.');
  }

  // 5. 严格防系统诱导行为（SYSTEM_INDUCED 铁网拦截）
  if (citationEvent.behaviorOrigin === BEHAVIOR_ORIGIN.SYSTEM_INDUCED) {
    throw new Error('Anti-circular violation: SYSTEM_INDUCED citation cannot form SubjectAcquiredMemory.');
  }
  if (citationEvent.behaviorOrigin !== BEHAVIOR_ORIGIN.SUBJECT_GENERATED) {
    throw new Error(
      `acquireSubjectMemory: Citation event must have behaviorOrigin "${BEHAVIOR_ORIGIN.SUBJECT_GENERATED}". Got "${citationEvent.behaviorOrigin}".`
    );
  }

  // 6. 核验 citationEvent 在 candidate.citationEvents 自身的真实注册记录（防跨候选冒充）
  if (!Array.isArray(candidate.citationEvents) || candidate.citationEvents.length < 1) {
    throw new Error('Anti-circular violation: Candidate has no registered citationEvents.');
  }
  const matchedCitation = candidate.citationEvents.find(
    c => c && (c.eventId === citationEventId || c.messageId === citationEventId)
  );
  if (!matchedCitation) {
    throw new Error(
      `Anti-circular violation: citationEvent "${citationEventId}" is not registered in candidate.citationEvents.`
    );
  }
  if (matchedCitation.behaviorOrigin !== BEHAVIOR_ORIGIN.SUBJECT_GENERATED) {
    throw new Error('Anti-circular violation: Registered citation in candidate is not SUBJECT_GENERATED.');
  }

  // 7. 文本一致性校验
  const candQuote = String(matchedCitation.quote || matchedCitation.content || '').trim().toLowerCase();
  const evQuote = String(citationEvent.quote || citationEvent.content || '').trim().toLowerCase();
  if (!candQuote || candQuote !== evQuote) {
    throw new Error('Anti-circular violation: Citation quote does not match candidate citation record.');
  }

  // 8. 真实事件库核验：citationEventId 必须在 eventStore 中真实存在
  if (!isEventInStore(eventStore, citationEventId)) {
    throw new Error(`Anti-circular violation: Citation event "${citationEventId}" not found in eventStore.`);
  }

  // 9. 时序递进检查
  const initialTimestamp = candidate.evidenceEvents[0]?.timestamp;
  if (initialTimestamp && citationEvent.timestamp) {
    const tInit = new Date(initialTimestamp).getTime();
    const tCite = new Date(citationEvent.timestamp).getTime();
    if (!Number.isNaN(tInit) && !Number.isNaN(tCite) && tCite < tInit) {
      throw new Error('Anti-circular violation: Citation event timestamp precedes initial evidence timestamp.');
    }
  }

  // 10. 实验 Run 一致性检查（若快照提供了 experimentRunId）
  if (experimentSnapshot && experimentSnapshot.experimentRunId) {
    if (candidate.experimentRunId && candidate.experimentRunId !== experimentSnapshot.experimentRunId) {
      throw new Error('Cross-run contamination: Candidate belongs to different experimentRunId.');
    }
  }

  const windowNo = (typeof citationEvent.windowNo === 'number' && citationEvent.windowNo >= 0)
    ? citationEvent.windowNo
    : (candidate.initialWindowNo || 1);

  return _createSubjectAcquiredMemoryValidated({
    candidateId: candidate.candidateId,
    citationEventId,
    windowNo,
    topic: candidate.theme || 'unlabeled_theme',
    subjectCitationQuote: citationEvent.quote || citationEvent.content,
    crystallizedContext: crystallizedContext || ''
  });
}

/**
 * 校验认知三态隔离完整性
 * 
 * 保证非 SUBJECT_ACQUIRED 对象绝对没有被赋予 subjectAccessible = true
 * 且 SUBJECT_ACQUIRED 对象必须持有完整的溯源与候选标识
 * 
 * @param {Object} item
 * @returns {boolean}
 */
function validateEpistemicSeparation(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.schemaVersion !== SCHEMA_VERSION) return false;

  const status = item.epistemicStatus;
  if (!Object.values(MEMORY_EPISTEMIC_STATUS).includes(status)) return false;

  if (status === MEMORY_EPISTEMIC_STATUS.SLEEP_REPLAY_ARTIFACT || status === MEMORY_EPISTEMIC_STATUS.SYSTEM_CONSOLIDATED) {
    if (item.subjectAccessible !== false) {
      return false; // 违规泄露给主体
    }
  }

  if (status === MEMORY_EPISTEMIC_STATUS.SUBJECT_ACQUIRED) {
    if (item.subjectAccessible !== true) {
      return false;
    }
    if (!item.subjectCitationQuote || typeof item.subjectCitationQuote !== 'string') {
      return false;
    }
    if (!item.candidateId || !item.citationEventId) {
      return false;
    }
    if (!item.provenance || item.provenance.sourceKind !== PROVENANCE_SOURCE_KINDS.SUBJECT_DERIVED) {
      return false;
    }
  }

  return true;
}

module.exports = {
  createSleepReplayArtifact,
  createSystemConsolidatedRepresentation,
  createSubjectAcquiredMemory,
  acquireSubjectMemory,
  validateEpistemicSeparation
};
