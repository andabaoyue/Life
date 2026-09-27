/**
 * src/archive-integrity.js
 * 
 * 初澜数字生命实验：Archive 归档 Schema 强校验与统一完整性服务 (v0.9.5.1)
 * 
 * 核心哲学与工程准则：
 * 1. 宁可显示“未记录 / 无法认证 / 数据损坏”，也绝不生成、推断、补全、伪造不存在的实验记录。
 * 2. 严格 Schema 门禁：所有写入 experiences.jsonl 的记录必须具备 schemaVersion, recordType, payload 及合法元数据。
 * 3. 拒绝未知类型：非白名单 recordType 一律拒绝，严防任意非实验记录污染实验底座。
 * 4. 单一可信源：统一判定 CERTIFIED / UNCERTIFIED / PARTIAL / CORRUPTED / INVALID，供 Replay, Query, Explorer 共享。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ALLOWED_TRAITS } = require('./subject-state');
const { validateEvent, ALLOWED_EVENT_TYPES, ALLOWED_EVENT_SOURCES } = require('./experience-schema');
const { validateGenerationContext } = require('./experiment-metadata');

const SCHEMA_VERSION = 1;

/**
 * 计算 Canonical Archive Record 哈希 (v0.9.6 P0-06)
 * 使用严格字段顺序确保序列化确定性。
 */
function computeCanonicalRecordHash(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const canonicalObj = {
    archiveSeq: typeof rec.archiveSeq === 'number' ? rec.archiveSeq : null,
    recordId: rec.recordId || null,
    recordType: rec.recordType || rec.type || null,
    windowNo: Number.isFinite(rec.windowNo) ? rec.windowNo : (rec.windowNo === null ? null : null),
    timestamp: Number.isFinite(rec.timestamp) ? rec.timestamp : null,
    payload: rec.payload !== undefined ? rec.payload : {},
    prevHash: rec.prevHash || null
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalObj), 'utf8').digest('hex');
}

// 合法归档记录类型白名单 (P0-03 & v0.9.6 P0-12 & v0.9.7 & Phase 0.5)
const VALID_RECORD_TYPES = new Set([
  'window_summary',
  'window_archive',
  'recovery_event',
  'diagnostic',
  'custom',
  'event',
  'observation',
  'interpretation',
  'evidence',
  'evidence_rejected',
  'state_change',
  'self_projection',
  'subject_dream',
  'memory_dynamics_snapshot',
  'internal_regulation_snapshot'
]);

// 完整性状态枚举
const INTEGRITY_STATUS = {
  CERTIFIED: 'certified',
  UNCERTIFIED: 'uncertified',
  PARTIAL: 'partial',
  CORRUPTED: 'corrupted',
  INVALID: 'invalid',
  LEGACY_COMPATIBLE: 'legacy_compatible'
};

const REPLAY_STATUS = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  FAILED: 'failed',
  INVALID: 'invalid'
};

/**
 * P0-01: 判定归档记录是否为明确的 Legacy 适配记录。
 * 只有经 LegacySchemaAdapter 明确标记的旧数据才允许缺少 Canonical 链字段。
 */
function isLegacyAdaptedRecord(record) {
  return !!record && (record.compatibilityAdapter === 'LegacySchemaAdapter'
    || record.schemaOrigin === 'legacy-adapted'
    || !!record.sourceSchema);
}

/**
 * P0-01: Modern Canonical Record 必须强制具备完整链字段集：
 * schemaVersion, recordId, archiveSeq, prevHash, recordHash, recordType, payload, timestamp。
 * 任一缺失都不允许认证为 CERTIFIED（缺链字段 ≠ Legacy）。
 * @returns {string[]} 缺失字段名列表（空数组 = 完整）
 */
function findModernChainFieldDefects(record) {
  if (!record || typeof record !== 'object') return ['record'];
  if (isLegacyAdaptedRecord(record)) return [];
  const missing = [];
  if (typeof record.schemaVersion !== 'number' || record.schemaVersion < 1) missing.push('schemaVersion');
  if (typeof record.recordId !== 'string' || !record.recordId.trim()) missing.push('recordId');
  if (!Number.isInteger(record.archiveSeq) || record.archiveSeq < 1) missing.push('archiveSeq');
  if (typeof record.prevHash !== 'string' || !record.prevHash.trim()) missing.push('prevHash');
  if (typeof record.recordHash !== 'string' || !record.recordHash.trim()) missing.push('recordHash');
  if (typeof record.recordType !== 'string' || !record.recordType.trim()) missing.push('recordType');
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) missing.push('payload');
  const ts = record.timestamp ?? record.createdAt;
  if (!Number.isFinite(ts) || ts <= 0) missing.push('timestamp');
  return missing;
}

/**
 * P1-02: Archive 层深度引用一致性校验（绝不因 ID 长得像真的就认证，也绝不补造引用目标）。
 * 校验关系：
 *   Observation.eventIds      → 必须存在对应 Event
 *   Interpretation.observationIds → 必须存在对应 Observation
 *   StateChange.evidenceIds   → 必须存在于 verified Evidence 集合
 *   Evidence.messageId        → 必须能找到对应真实消息/Event provenance
 * 状态区分（绝不混同，绝不伪造补全）：
 *   NOT_RECORDED: 引用目标在归档中不存在（引用悬空）
 *   UNRESOLVED:   引用存在但来源无法证明（如 Evidence.messageId 无对应消息/事件溯源）
 *   INVALID:      引用字段结构非法（空串/非字符串）
 * @returns {{ status: string, defects: Array }}
 */
function validateRecordRelationships(records) {
  const eventIds = new Set();
  const messageIds = new Set();
  const observationIds = new Set();
  const verifiedEvidenceIds = new Set();

  const addEvent = (evt) => {
    if (!evt || typeof evt !== 'object') return;
    const id = evt.eventId || (evt.payload && evt.payload.eventId);
    if (typeof id === 'string' && id.trim()) eventIds.add(id);
    const mid = evt.messageId || (evt.payload && evt.payload.messageId);
    if (typeof mid === 'string' && mid.trim()) messageIds.add(mid);
  };
  const addObservation = (o) => {
    if (!o || typeof o !== 'object') return;
    const id = o.observationId || (o.payload && o.payload.observationId);
    if (typeof id === 'string' && id.trim()) observationIds.add(id);
  };
  const addEvidence = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const id = ev.evidenceId || (ev.payload && ev.payload.evidenceId);
    if (typeof id === 'string' && id.trim()) verifiedEvidenceIds.add(id);
  };

  // 1. 建立全归档实体索引（跨记录、跨窗口）
  for (const rec of records) {
    const p = (rec && rec.payload) || {};
    if (rec.recordType === 'event') addEvent(p);
    if (Array.isArray(p.events)) p.events.forEach(addEvent);
    if (rec.recordType === 'observation') addObservation(p);
    if (Array.isArray(p.observations)) p.observations.forEach(addObservation);
    if (rec.recordType === 'evidence') addEvidence(p);
    if (Array.isArray(p.verifiedEvidence)) p.verifiedEvidence.forEach(addEvidence);
  }

  const defects = [];
  const checkIdList = (ids, targetSet, relation, recordRef) => {
    if (ids === undefined || ids === null) return;
    if (!Array.isArray(ids)) {
      defects.push({ status: 'INVALID', relation, recordRef, detail: 'REFERENCE_LIST_NOT_ARRAY' });
      return;
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) {
        defects.push({ status: 'INVALID', relation, recordRef, reference: id, detail: 'REFERENCE_ID_MALFORMED' });
      } else if (!targetSet.has(id)) {
        defects.push({ status: 'NOT_RECORDED', relation, recordRef, reference: id, detail: 'REFERENCE_TARGET_NOT_FOUND' });
      }
    }
  };

  // 2. 逐记录关系核验
  for (const rec of records) {
    const p = (rec && rec.payload) || {};
    const recordRef = rec.recordId || rec.archiveSeq || null;

    if (rec.recordType === 'observation') {
      checkIdList(p.eventIds, eventIds, 'observation->event', recordRef);
    }
    if (Array.isArray(p.observations)) {
      for (const o of p.observations) {
        if (o && typeof o === 'object') checkIdList(o.eventIds, eventIds, 'observation->event', recordRef);
      }
    }

    if (rec.recordType === 'interpretation') {
      checkIdList(p.observationIds, observationIds, 'interpretation->observation', recordRef);
    }
    if (Array.isArray(p.interpretations)) {
      for (const it of p.interpretations) {
        if (it && typeof it === 'object') checkIdList(it.observationIds, observationIds, 'interpretation->observation', recordRef);
      }
    }

    const checkStateChangeRefs = (sc) => {
      if (sc && typeof sc === 'object') checkIdList(sc.evidenceIds, verifiedEvidenceIds, 'state_change->evidence', recordRef);
    };
    if (rec.recordType === 'state_change') checkStateChangeRefs(p);
    if (Array.isArray(p.stateChanges)) p.stateChanges.forEach(checkStateChangeRefs);

    const checkEvidenceProvenance = (ev, ref) => {
      if (!ev || typeof ev !== 'object') return;
      const mid = ev.messageId;
      if (mid === undefined || mid === null) return;
      if (typeof mid !== 'string' || !mid.trim()) {
        defects.push({ status: 'INVALID', relation: 'evidence->message', recordRef: ref, reference: mid, detail: 'MESSAGE_ID_MALFORMED' });
      } else if (!messageIds.has(mid)) {
        defects.push({ status: 'UNRESOLVED', relation: 'evidence->message', recordRef: ref, reference: mid, detail: 'MESSAGE_PROVENANCE_UNRESOLVED' });
      }
    };
    if (rec.recordType === 'evidence') checkEvidenceProvenance(p, recordRef);
    if (Array.isArray(p.verifiedEvidence)) {
      for (const ev of p.verifiedEvidence) checkEvidenceProvenance(ev, recordRef);
    }
  }

  let status = 'verified';
  if (defects.some(d => d.status === 'INVALID')) status = 'invalid';
  else if (defects.some(d => d.status === 'NOT_RECORDED')) status = 'not_recorded';
  else if (defects.some(d => d.status === 'UNRESOLVED')) status = 'unresolved';
  return { status, defects };
}

/**
 * 严格校验单条归档记录 (P0-03 & P0-04)
 * @param {Object} record - 待校验记录
 * @returns {{ valid: boolean, reason?: string, details?: any }}
 */
function validateArchiveRecord(record, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, reason: 'INVALID_OBJECT' };
  }

  const isLegacy = record.compatibilityAdapter === 'LegacySchemaAdapter' || record.schemaOrigin === 'legacy-adapted';

  // 1. 公共最小字段集核验
  if (!options.allowLegacy || !isLegacy) {
    if (typeof record.schemaVersion !== 'number' || record.schemaVersion < 1) {
      return { valid: false, reason: 'MISSING_OR_INVALID_SCHEMA_VERSION' };
    }
  }

  if (typeof record.recordType !== 'string' || !record.recordType.trim()) {
    return { valid: false, reason: 'MISSING_OR_INVALID_RECORD_TYPE' };
  }

  const recType = record.recordType.trim();
  if (!VALID_RECORD_TYPES.has(recType)) {
    return { valid: false, reason: 'UNKNOWN_RECORD_TYPE: ' + recType, recordType: recType };
  }

  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    return { valid: false, reason: 'MISSING_OR_INVALID_PAYLOAD' };
  }

  const ts = record.timestamp ?? record.createdAt;
  if (!options.allowLegacy || !isLegacy) {
    if (!Number.isFinite(ts) || ts <= 0) {
      return { valid: false, reason: 'MISSING_OR_INVALID_TIMESTAMP' };
    }

    const wNo = record.windowNo;
    const requiresWindowNo = (recType === 'window_summary' || recType === 'window_archive');
    if (requiresWindowNo) {
      if (!Number.isFinite(wNo) || wNo < 0) {
        return { valid: false, reason: 'MISSING_OR_INVALID_WINDOW_NO' };
      }
    } else {
      if (wNo !== null && (!Number.isFinite(wNo) || wNo < 0)) {
        return { valid: false, reason: 'MISSING_OR_INVALID_WINDOW_NO' };
      }
    }
  }

  const payload = record.payload;

  // P0-05: 严格禁止 Synthetic / Generated 事件或虚构数据进入认证
  if (record.synthetic === true || payload.synthetic === true) {
    return { valid: false, reason: 'SYNTHETIC_EVENT_PROHIBITED' };
  }
  if (record.generated === true || payload.generated === true) {
    return { valid: false, reason: 'GENERATED_EVENT_PROHIBITED' };
  }

  // 1.1 实验生成条件元数据契约核验 (若存在则强校验，缺失则历史兼容允许)
  const targetGenCtx = payload.generationContext !== undefined ? payload.generationContext : record.generationContext;
  if (targetGenCtx !== undefined && targetGenCtx !== null) {
    const vGen = validateGenerationContext(targetGenCtx);
    if (!vGen.valid) {
      return { valid: false, reason: 'INVALID_GENERATION_CONTEXT: ' + vGen.reason, details: vGen };
    }
  }

  // 2. 类型专属 Schema 核验
  switch (recType) {
    case 'window_summary':
    case 'window_archive': {
      if (payload.turns !== undefined && payload.turns !== null && (typeof payload.turns !== 'number' || payload.turns < 0)) {
        return { valid: false, reason: 'INVALID_TURNS_IN_WINDOW_SUMMARY' };
      }
      if (payload.messageCount !== undefined && payload.messageCount !== null && (typeof payload.messageCount !== 'number' || payload.messageCount < 0)) {
        return { valid: false, reason: 'INVALID_MESSAGE_COUNT_IN_WINDOW_SUMMARY' };
      }
      if (payload.events !== undefined) {
        if (!Array.isArray(payload.events)) {
          return { valid: false, reason: 'EVENTS_MUST_BE_ARRAY' };
        }
        for (const evt of payload.events) {
          if (!evt || typeof evt !== 'object') {
            return { valid: false, reason: 'INVALID_EVENT_IN_SUMMARY' };
          }
          const ep = evt.payload || evt;
          if (evt.bridge === true || ep.bridge === true) {
            const prov = evt.provenance || ep.provenance;
            if (!prov || typeof prov !== 'object' || (!prov.sourceEventId && !prov.sourceMessageId && !prov.windowNo)) {
              return { valid: false, reason: 'BRIDGE_EVENT_UNPROVEN' };
            }
          }
          const normEvt = {
            eventId: evt.eventId || ep.eventId,
            type: evt.type || ep.type,
            source: evt.source || ep.source,
            messageId: evt.messageId || ep.messageId || null,
            synthetic: evt.synthetic === true || ep.synthetic === true,
            generated: evt.generated === true || ep.generated === true,
            bridge: (evt.bridge === true || ep.bridge === true) && !(evt.provenance || ep.provenance),
            provenance: evt.provenance || ep.provenance || null,
            payload: evt.payload || {}
          };
          const vEvt = validateEvent(normEvt);
          if (!vEvt.valid) {
            return { valid: false, reason: vEvt.reason, eventValidation: vEvt };
          }
        }
      }
      if (payload.verifiedEvidence !== undefined && !Array.isArray(payload.verifiedEvidence)) {
        return { valid: false, reason: 'VERIFIED_EVIDENCE_MUST_BE_ARRAY' };
      }
      if (payload.rejectedEvidence !== undefined && !Array.isArray(payload.rejectedEvidence)) {
        return { valid: false, reason: 'REJECTED_EVIDENCE_MUST_BE_ARRAY' };
      }
      if (payload.stateChanges !== undefined && !Array.isArray(payload.stateChanges)) {
        return { valid: false, reason: 'STATE_CHANGES_MUST_BE_ARRAY' };
      }
      break;
    }

    case 'event': {
      const ep = payload;
      if (record.bridge === true || ep.bridge === true) {
        const prov = record.provenance || ep.provenance;
        if (!prov || typeof prov !== 'object' || (!prov.sourceEventId && !prov.sourceMessageId && !prov.windowNo)) {
          return { valid: false, reason: 'BRIDGE_EVENT_UNPROVEN' };
        }
      }
      const normEvt = {
        eventId: ep.eventId || record.eventId,
        type: ep.type || record.type,
        source: ep.source || record.source,
        messageId: ep.messageId || record.messageId || null,
        synthetic: record.synthetic === true || ep.synthetic === true,
        generated: record.generated === true || ep.generated === true,
        bridge: (record.bridge === true || ep.bridge === true) && !(record.provenance || ep.provenance),
        provenance: record.provenance || ep.provenance || null,
        payload: ep.payload || ep
      };
      const vEvt = validateEvent(normEvt);
      if (!vEvt.valid) {
        return { valid: false, reason: vEvt.reason, eventValidation: vEvt };
      }
      break;
    }

    case 'observation': {
      if (typeof payload.observationId !== 'string' || !payload.observationId.trim()) {
        return { valid: false, reason: 'OBSERVATION_MISSING_ID' };
      }
      if (!Array.isArray(payload.eventIds) || payload.eventIds.length === 0) {
        return { valid: false, reason: 'OBSERVATION_REQUIRES_EVENT_IDS' };
      }
      if (typeof payload.content !== 'string' || !payload.content.trim()) {
        return { valid: false, reason: 'OBSERVATION_REQUIRES_CONTENT' };
      }
      break;
    }

    case 'interpretation': {
      if (typeof payload.interpretationId !== 'string' || !payload.interpretationId.trim()) {
        return { valid: false, reason: 'INTERPRETATION_MISSING_ID' };
      }
      if (!Array.isArray(payload.observationIds) || payload.observationIds.length === 0) {
        return { valid: false, reason: 'INTERPRETATION_REQUIRES_OBSERVATION_IDS' };
      }
      if (typeof payload.content !== 'string' || !payload.content.trim()) {
        return { valid: false, reason: 'INTERPRETATION_REQUIRES_CONTENT' };
      }
      break;
    }

    case 'evidence':
    case 'evidence_rejected': {
      if (typeof payload.evidenceId !== 'string' || !payload.evidenceId.trim()) {
        return { valid: false, reason: 'EVIDENCE_MISSING_ID' };
      }
      if (typeof payload.trait !== 'string' || !ALLOWED_TRAITS.has(payload.trait.trim())) {
        return { valid: false, reason: 'EVIDENCE_INVALID_TRAIT: ' + payload.trait };
      }
      break;
    }

    case 'state_change': {
      const scId = payload.stateChangeId || payload.changeId;
      if (typeof scId !== 'string' || !scId.trim()) {
        return { valid: false, reason: 'STATE_CHANGE_MISSING_ID' };
      }
      if (typeof payload.trait !== 'string' || !ALLOWED_TRAITS.has(payload.trait.trim())) {
        return { valid: false, reason: 'STATE_CHANGE_INVALID_TRAIT: ' + payload.trait };
      }
      if (!Number.isFinite(payload.delta)) {
        return { valid: false, reason: 'STATE_CHANGE_INVALID_DELTA' };
      }
      break;
    }

    case 'recovery_event': {
      const action = payload.action || payload.reason;
      if (typeof action !== 'string' || !action.trim()) {
        return { valid: false, reason: 'RECOVERY_EVENT_MISSING_ACTION' };
      }
      break;
    }

    case 'custom':
    case 'diagnostic': {
      // 容许诊断记录与自定义测试记录任意结构化 payload
      break;
    }

    case 'self_projection': {
      if (!payload || typeof payload !== 'object') {
        return { valid: false, reason: 'INVALID_SELF_PROJECTION_PAYLOAD' };
      }
      break;
    }

    case 'subject_dream': {
      if (!payload || typeof payload !== 'object') {
        return { valid: false, reason: 'INVALID_DREAM_PAYLOAD' };
      }
      const dreamId = payload.dreamId || rec.dreamId || rec.recordId;
      if (typeof dreamId !== 'string' || !dreamId.trim()) {
        return { valid: false, reason: 'MISSING_DREAM_ID' };
      }
      const epistemicStatus = payload.epistemicStatus || rec.epistemicStatus;
      if (!epistemicStatus) {
        return { valid: false, reason: 'MISSING_EPISTEMIC_STATUS' };
      }
      break;
    }

    case 'memory_dynamics_snapshot': {
      if (!payload || typeof payload !== 'object') {
        return { valid: false, reason: 'INVALID_MEMORY_DYNAMICS_PAYLOAD' };
      }
      break;
    }

    case 'internal_regulation_snapshot': {
      if (!payload || typeof payload !== 'object') {
        return { valid: false, reason: 'INVALID_INTERNAL_REGULATION_PAYLOAD' };
      }
      break;
    }

    default:
      return { valid: false, reason: 'UNHANDLED_RECORD_TYPE: ' + recType };
  }

  return { valid: true };
}

/**
 * 统一归档完整性分析服务 (P0-05)
 * 作为 Replay、ResearchQuery、Explorer UI 的唯一可信源。
 */
class ArchiveIntegrityService {
  /**
   * 评估内存中的归档记录数组的完整性与认证状态 (P0-3: 统一完整性权威源)
   * @param {Array} records - 归档记录列表
   * @param {Object} options - 选项 (diagnostics, corruptLines, totalLines, allowLegacy)
   * @returns {Object} 完整性报告
   */
  static checkRecords(records, options = {}) {
    if (!Array.isArray(records)) {
      return {
        integrity: INTEGRITY_STATUS.INVALID,
        replayStatus: REPLAY_STATUS.INVALID,
        validCount: 0,
        invalidCount: 0,
        corruptLines: 0,
        skippedCount: 0,
        totalLines: 0,
        hasLegacyAdapter: false,
        diagnostics: [{ lineNumber: 0, error: 'INVALID_RECORDS_ARRAY' }],
        records: []
      };
    }

    const corruptLines = options.corruptLines ?? (options.corruptRecords ?? (options.diagnostics ? (options.diagnostics.skippedCount || 0) : 0));
    let validCount = 0;
    let invalidCount = 0;
    let hasLegacyAdapter = false;
    const diagnostics = (options.diagnostics && Array.isArray(options.diagnostics.errors))
      ? [...options.diagnostics.errors]
      : [];
    const validRecords = [];

    const { normalizeArchiveRecord } = require('./experience-schema');

    for (let i = 0; i < records.length; i++) {
      const parsed = records[i];
      if (!parsed || typeof parsed !== 'object') {
        invalidCount++;
        diagnostics.push({
          lineNumber: i + 1,
          error: 'INVALID_OBJECT',
          snippet: String(parsed).slice(0, 100)
        });
        continue;
      }

      const norm = normalizeArchiveRecord(parsed);
      if (!norm) {
        invalidCount++;
        diagnostics.push({
          lineNumber: i + 1,
          error: 'NORMALIZATION_FAILED',
          snippet: JSON.stringify(parsed).slice(0, 100)
        });
        continue;
      }

      if (norm.compatibilityAdapter === 'LegacySchemaAdapter' || norm.sourceSchema) {
        hasLegacyAdapter = true;
        if (norm.legacyStatus === 'LEGACY_UNKNOWN') {
          invalidCount++;
          diagnostics.push({
            lineNumber: i + 1,
            error: 'LEGACY_UNKNOWN_SCHEMA',
            snippet: JSON.stringify(parsed).slice(0, 100)
          });
          continue;
        }
        const vResult = validateArchiveRecord(norm, { allowLegacy: true });
        if (!vResult.valid) {
          invalidCount++;
          diagnostics.push({
            lineNumber: i + 1,
            error: vResult.reason,
            snippet: JSON.stringify(parsed).slice(0, 100)
          });
        } else {
          validCount++;
          validRecords.push(norm);
        }
        continue;
      }

      const vResult = validateArchiveRecord(norm);
      if (!vResult.valid) {
        invalidCount++;
        diagnostics.push({
          lineNumber: i + 1,
          error: vResult.reason,
          snippet: JSON.stringify(parsed).slice(0, 100)
        });
      } else {
        validCount++;
        validRecords.push(norm);
      }
    }

    const totalLines = options.totalLines ?? (records.length + corruptLines);
    let integrity = INTEGRITY_STATUS.CERTIFIED;
    let replayStatus = REPLAY_STATUS.COMPLETE;

    // P0-01: Modern Canonical Record 缺链字段不允许认证（缺链字段 ≠ Legacy）
    const modernChainDefects = [];
    for (let i = 0; i < validRecords.length; i++) {
      const missing = findModernChainFieldDefects(validRecords[i]);
      if (missing.length > 0) {
        modernChainDefects.push({ lineNumber: i + 1, recordId: validRecords[i].recordId || null, missing });
        diagnostics.push({
          lineNumber: i + 1,
          error: `MODERN_RECORD_MISSING_CHAIN_FIELDS: ${missing.join(', ')}`,
          recordId: validRecords[i].recordId || null
        });
      }
    }
    const modern_chain_integrity = modernChainDefects.length > 0 ? 'missing_fields' : (validRecords.length > 0 ? 'verified' : 'not_applicable');

    // P1-02: 深度引用一致性（引用目标不存在/无法证明 → 绝不认证，也绝不补造）
    const relationships = validateRecordRelationships(validRecords);
    const relationship_integrity = relationships.status;

    let syntax_integrity = corruptLines > 0 ? (validCount > 0 ? 'partial' : 'corrupted') : 'valid';
    let sequence_integrity = 'legacy';
    let hash_integrity = 'legacy';

    const sequenced = validRecords.filter(r => typeof r.archiveSeq === 'number' && !Number.isNaN(r.archiveSeq));
    if (sequenced.length === validRecords.length && validRecords.length > 0) {
      let seqOk = true;
      for (let j = 0; j < sequenced.length; j++) {
        const expectedSeq = sequenced[0].archiveSeq + j;
        if (sequenced[j].archiveSeq !== expectedSeq) {
          seqOk = false;
          diagnostics.push({
            lineNumber: j + 1,
            error: `SEQUENCE_MISMATCH: expected archiveSeq ${expectedSeq}, got ${sequenced[j].archiveSeq}`
          });
          break;
        }
      }
      sequence_integrity = seqOk ? 'monotonic' : 'invalid';
    } else if (sequenced.length > 0 && sequenced.length < validRecords.length) {
      sequence_integrity = 'partial_unsequenced';
    }

    const hashed = validRecords.filter(r => typeof r.recordHash === 'string' && r.recordHash);
    if (hashed.length === validRecords.length && validRecords.length > 0) {
      let hashOk = true;
      for (let j = 0; j < hashed.length; j++) {
        const rec = hashed[j];
        const expectedHash = computeCanonicalRecordHash(rec);
        if (rec.recordHash !== expectedHash) {
          hashOk = false;
          diagnostics.push({
            lineNumber: j + 1,
            error: `RECORD_HASH_MISMATCH: recordId ${rec.recordId || j}`
          });
          break;
        }
        if (j === 0) {
          if (rec.prevHash && rec.prevHash !== 'GENESIS' && rec.archiveSeq === 1) {
            hashOk = false;
            diagnostics.push({
              lineNumber: 1,
              error: `GENESIS_HASH_MISMATCH: expected GENESIS, got ${rec.prevHash}`
            });
            break;
          }
        } else {
          const prevRec = hashed[j - 1];
          if (rec.prevHash !== prevRec.recordHash) {
            hashOk = false;
            diagnostics.push({
              lineNumber: j + 1,
              error: `PREV_HASH_CHAIN_BROKEN: at record ${rec.recordId || j}, expected ${prevRec.recordHash}, got ${rec.prevHash}`
            });
            break;
          }
        }
      }
      hash_integrity = hashOk ? 'verified' : 'mismatch';
    }

    if (hash_integrity === 'mismatch' || sequence_integrity === 'invalid' || relationship_integrity === 'invalid') {
      integrity = INTEGRITY_STATUS.INVALID;
      replayStatus = REPLAY_STATUS.INVALID;
    } else if (modernChainDefects.length > 0) {
      // P0-01: 现代记录缺链字段 → 绝不 CERTIFIED
      integrity = INTEGRITY_STATUS.UNCERTIFIED;
      replayStatus = REPLAY_STATUS.PARTIAL;
    } else if (corruptLines > 0) {
      integrity = validCount > 0 ? INTEGRITY_STATUS.PARTIAL : INTEGRITY_STATUS.CORRUPTED;
      replayStatus = REPLAY_STATUS.PARTIAL;
    } else if (invalidCount > 0) {
      integrity = INTEGRITY_STATUS.UNCERTIFIED;
      replayStatus = REPLAY_STATUS.PARTIAL;
    } else if (hasLegacyAdapter) {
      // P0-09: 遗留兼容记录平滑加载，但绝不自动赋予 CERTIFIED
      integrity = INTEGRITY_STATUS.UNCERTIFIED;
      replayStatus = REPLAY_STATUS.COMPLETE;
    } else if (relationship_integrity !== 'verified') {
      // P1-02: 引用悬空 (NOT_RECORDED) / 来源无法证明 (UNRESOLVED) → 绝不 CERTIFIED
      integrity = INTEGRITY_STATUS.UNCERTIFIED;
      replayStatus = REPLAY_STATUS.PARTIAL;
    } else if (totalLines === 0) {
      integrity = INTEGRITY_STATUS.CERTIFIED;
      replayStatus = REPLAY_STATUS.COMPLETE;
    }

    return {
      integrity,
      replayStatus,
      syntax_integrity,
      sequence_integrity,
      hash_integrity,
      modern_chain_integrity,
      relationship_integrity,
      relationshipDefects: relationships.defects,
      validCount,
      invalidCount,
      corruptLines,
      skippedCount: corruptLines + invalidCount,
      totalLines,
      hasLegacyAdapter,
      diagnostics,
      records: validRecords
    };
  }

  /**
   * 评估指定 experiences.jsonl 文件的完整性与认证状态
   * @param {string} archivePath - experiences.jsonl 绝对路径
   * @returns {Object} 完整性报告
   */
  static checkArchive(archivePath) {
    let targetFile = archivePath;
    if (targetFile && fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
      targetFile = path.join(targetFile, 'experiences.jsonl');
    }
    if (!targetFile || !fs.existsSync(targetFile)) {
      return {
        integrity: INTEGRITY_STATUS.INVALID,
        replayStatus: REPLAY_STATUS.INVALID,
        validCount: 0,
        invalidCount: 0,
        corruptLines: 0,
        skippedCount: 0,
        totalLines: 0,
        hasLegacyAdapter: false,
        diagnostics: [{ lineNumber: 0, error: 'ARCHIVE_FILE_NOT_FOUND', path: targetFile }],
        records: []
      };
    }

    try {
      const content = fs.readFileSync(archivePath, 'utf8');
      const rawLines = content.split('\n');

      let totalLines = 0;
      let corruptLines = 0;
      const diagnostics = [];
      const parsedRecords = [];

      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i].trim();
        if (!line) continue;
        totalLines++;

        try {
          const parsed = JSON.parse(line);
          parsedRecords.push(parsed);
        } catch (err) {
          corruptLines++;
          diagnostics.push({
            lineNumber: i + 1,
            error: 'JSON_PARSE_ERROR',
            message: err.message,
            snippet: line.slice(0, 100)
          });
        }
      }

      const report = ArchiveIntegrityService.checkRecords(parsedRecords, {
        corruptLines,
        diagnostics: { skippedCount: corruptLines, errors: diagnostics },
        totalLines
      });
      // P0-02: Tail Anchor 校验（链外锚点证明当前尾部是最近一次已确认的可信尾部）
      return ArchiveIntegrityService._applyTailAnchorCheck(report, targetFile, parsedRecords);
    } catch (e) {
      return {
        integrity: INTEGRITY_STATUS.INVALID,
        replayStatus: REPLAY_STATUS.FAILED,
        validCount: 0,
        invalidCount: 0,
        corruptLines: 1,
        skippedCount: 1,
        totalLines: 0,
        hasLegacyAdapter: false,
        diagnostics: [{ lineNumber: 0, error: 'IO_ERROR', message: e.message }],
        records: []
      };
    }
  }
}

/**
 * P0-02: Tail Anchor 校验（链外锚点，不参与 record hash chain，避免循环依赖）。
 * anchor 存于 experiences.jsonl.anchor.json，证明当前 archive 尾部未被“合法截断”。
 * 状态：
 *   verified      锚点与实际链尾一致
 *   not_recorded  无锚点（空归档可读；有现代链尾则绝不能 CERTIFIED）
 *   tail_truncated 实际尾部早于锚点（尾部被截断）→ INVALID fail-closed
 *   anchor_stale  实际尾部晚于锚点（未提交尾部 / 锚点更新失败）→ UNCERTIFIED fail-closed
 *   tampered      锚点与链尾 recordId/recordHash 不一致（锚点或尾部被篡改）→ INVALID
 *   invalid       锚点文件损坏 / 结构非法 → INVALID
 */
ArchiveIntegrityService._applyTailAnchorCheck = function (report, archiveFilePath, parsedRecords) {
  const anchorPath = archiveFilePath + '.anchor.json';
  const chained = (parsedRecords || [])
    .filter(r => r && typeof r === 'object' && Number.isFinite(r.archiveSeq) && typeof r.recordHash === 'string' && r.recordHash)
    .sort((a, b) => a.archiveSeq - b.archiveSeq);
  const actualTail = chained.length > 0 ? chained[chained.length - 1] : null;

  let anchorPresent = false;
  let anchor = null;
  let anchorCorrupt = false;
  if (fs.existsSync(anchorPath)) {
    anchorPresent = true;
    try {
      anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
    } catch {
      anchorCorrupt = true;
    }
  }

  const result = Object.assign({}, report, { tail_anchor: 'verified', anchor_diagnostics: [] });
  const shapeOk = !!anchor && typeof anchor === 'object'
    && Number.isInteger(anchor.archiveSeq) && anchor.archiveSeq >= 1
    && typeof anchor.recordId === 'string' && anchor.recordId.trim()
    && typeof anchor.recordHash === 'string' && anchor.recordHash.trim();

  if (!actualTail) {
    if (anchorPresent) {
      // 锚点声称存在链尾但归档中无任何链记录：尾部被截断或锚点伪造
      result.tail_anchor = (anchorCorrupt || !shapeOk) ? 'invalid' : 'tail_truncated';
      result.anchor_diagnostics.push({ error: 'TAIL_ANCHOR_WITHOUT_CHAINED_TAIL' });
      result.integrity = INTEGRITY_STATUS.INVALID;
      result.replayStatus = REPLAY_STATUS.INVALID;
    } else {
      result.tail_anchor = 'not_recorded';
    }
    return result;
  }

  if (!anchorPresent) {
    // 现代链尾存在但无链外锚点：无法证明尾部完整，绝不 CERTIFIED
    result.tail_anchor = 'not_recorded';
    result.anchor_diagnostics.push({ error: 'TAIL_ANCHOR_NOT_RECORDED' });
    if (result.integrity === INTEGRITY_STATUS.CERTIFIED) {
      result.integrity = INTEGRITY_STATUS.UNCERTIFIED;
      result.replayStatus = REPLAY_STATUS.PARTIAL;
    }
    return result;
  }

  if (anchorCorrupt || !shapeOk) {
    result.tail_anchor = 'invalid';
    result.anchor_diagnostics.push({ error: 'TAIL_ANCHOR_CORRUPTED' });
    result.integrity = INTEGRITY_STATUS.INVALID;
    result.replayStatus = REPLAY_STATUS.INVALID;
    return result;
  }

  if (anchor.archiveSeq > actualTail.archiveSeq) {
    result.tail_anchor = 'tail_truncated';
    result.anchor_diagnostics.push({ error: `TAIL_TRUNCATED: anchor archiveSeq ${anchor.archiveSeq} > actual tail ${actualTail.archiveSeq}` });
    result.integrity = INTEGRITY_STATUS.INVALID;
    result.replayStatus = REPLAY_STATUS.INVALID;
    return result;
  }

  if (anchor.archiveSeq < actualTail.archiveSeq) {
    result.tail_anchor = 'anchor_stale';
    result.anchor_diagnostics.push({ error: `ANCHOR_STALE: anchor archiveSeq ${anchor.archiveSeq} < actual tail ${actualTail.archiveSeq}` });
    if (result.integrity === INTEGRITY_STATUS.CERTIFIED) {
      result.integrity = INTEGRITY_STATUS.UNCERTIFIED;
      result.replayStatus = REPLAY_STATUS.PARTIAL;
    }
    return result;
  }

  if (anchor.recordHash !== actualTail.recordHash || anchor.recordId !== actualTail.recordId) {
    result.tail_anchor = 'tampered';
    result.anchor_diagnostics.push({ error: 'TAIL_ANCHOR_MISMATCH: anchor 与实际链尾 recordId/recordHash 不一致' });
    result.integrity = INTEGRITY_STATUS.INVALID;
    result.replayStatus = REPLAY_STATUS.INVALID;
    return result;
  }

  result.tail_anchor = 'verified';
  return result;
};

module.exports = {
  SCHEMA_VERSION,
  VALID_RECORD_TYPES,
  INTEGRITY_STATUS,
  REPLAY_STATUS,
  validateArchiveRecord,
  ArchiveIntegrityService,
  computeCanonicalRecordHash,
  isLegacyAdaptedRecord,
  findModernChainFieldDefects,
  validateRecordRelationships
};
