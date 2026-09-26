/**
 * src/sleep-consolidation-types.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 睡眠记忆认识论三态分立契约与数据结构规范 (Phase 0)
 * 
 * 核心哲学与工程边界：
 * 1. 认识论三态绝不混淆：
 *    - SleepReplayArtifact：离线重放制品（机器重计算产物，非初澜梦境，subjectAccessible = false）
 *    - SystemConsolidatedRepresentation：系统整合表征（外部归纳暂存，未获主体接纳，subjectAccessible = false）
 *    - SubjectAcquiredMemory：主体习得记忆（清醒期经主体主动唤醒并融入经验，subjectAccessible = true）
 * 2. 睡眠三态伪装铁律（Epistemic Separation Invariant）：
 *    系统离线重放和整合产物绝对不能伪装成主体自发回忆直接注入到对白认知层。
 */

'use strict';

const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  MEMORY_EPISTEMIC_STATUS,
  PROVENANCE_SOURCE_KINDS
} = require('./experiment-types');

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
 * 创建主体习得自传记忆
 * 
 * 必须在清醒期由初澜主体在交互中自发引用、确认并融入自我连续性
 * 
 * @param {Object} options
 * @returns {Readonly<Object>}
 */
function createSubjectAcquiredMemory(options = {}) {
  if (!options.subjectCitationQuote) {
    throw new Error('createSubjectAcquiredMemory: Subject citation quote is mandatory.');
  }

  const memoryId = `sam-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();

  const memory = {
    schemaVersion: SCHEMA_VERSION,
    memoryId,
    epistemicStatus: MEMORY_EPISTEMIC_STATUS.SUBJECT_ACQUIRED,
    topic: String(options.topic || ''),
    subjectCitationQuote: String(options.subjectCitationQuote),
    crystallizedContext: String(options.crystallizedContext || ''),
    subjectAccessible: true, // 主体自主掌握
    acquiredAt: nowIso,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.SUBJECT_DERIVED,
      timestamp: nowIso
    })
  };

  return Object.freeze(memory);
}

/**
 * 校验认知三态隔离完整性
 * 
 * 保证非 SUBJECT_ACQUIRED 对象绝对没有被赋予 subjectAccessible = true
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
    if (!item.subjectCitationQuote) {
      return false;
    }
  }

  return true;
}

module.exports = {
  createSleepReplayArtifact,
  createSystemConsolidatedRepresentation,
  createSubjectAcquiredMemory,
  validateEpistemicSeparation
};
