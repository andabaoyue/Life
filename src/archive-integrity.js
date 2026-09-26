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
const { ALLOWED_TRAITS } = require('./subject-state');
const { validateEvent, ALLOWED_EVENT_TYPES, ALLOWED_EVENT_SOURCES } = require('./experience-schema');

const SCHEMA_VERSION = 1;

// 合法归档记录类型白名单 (P0-03)
const VALID_RECORD_TYPES = new Set([
  'window_summary',
  'window_archive',
  'recovery_event',
  'diagnostic',
  'event',
  'observation',
  'interpretation',
  'evidence',
  'evidence_rejected',
  'state_change'
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

  const ts = record.timestamp || record.createdAt;
  if (!options.allowLegacy || !isLegacy) {
    if (typeof ts !== 'number' || ts <= 0 || isNaN(ts)) {
      return { valid: false, reason: 'MISSING_OR_INVALID_TIMESTAMP' };
    }

    const wNo = record.windowNo;
    if (typeof wNo !== 'number' || wNo < 0 || isNaN(wNo)) {
      return { valid: false, reason: 'MISSING_OR_INVALID_WINDOW_NO' };
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
      if (typeof payload.delta !== 'number' || isNaN(payload.delta)) {
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

    case 'diagnostic': {
      // 容许诊断记录任意结构化 payload
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

    if (corruptLines > 0) {
      integrity = validCount > 0 ? INTEGRITY_STATUS.PARTIAL : INTEGRITY_STATUS.CORRUPTED;
      replayStatus = REPLAY_STATUS.PARTIAL;
    } else if (invalidCount > 0) {
      integrity = INTEGRITY_STATUS.UNCERTIFIED;
      replayStatus = REPLAY_STATUS.PARTIAL;
    } else if (hasLegacyAdapter) {
      // P0-09: 遗留兼容记录平滑加载，但绝不自动赋予 CERTIFIED
      integrity = INTEGRITY_STATUS.UNCERTIFIED;
      replayStatus = REPLAY_STATUS.COMPLETE;
    } else if (totalLines === 0) {
      integrity = INTEGRITY_STATUS.CERTIFIED;
      replayStatus = REPLAY_STATUS.COMPLETE;
    }

    return {
      integrity,
      replayStatus,
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
    if (!archivePath || !fs.existsSync(archivePath)) {
      return {
        integrity: INTEGRITY_STATUS.INVALID,
        replayStatus: REPLAY_STATUS.INVALID,
        validCount: 0,
        invalidCount: 0,
        corruptLines: 0,
        skippedCount: 0,
        totalLines: 0,
        hasLegacyAdapter: false,
        diagnostics: [{ lineNumber: 0, error: 'ARCHIVE_FILE_NOT_FOUND', path: archivePath }],
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

      return ArchiveIntegrityService.checkRecords(parsedRecords, {
        corruptLines,
        diagnostics: { skippedCount: corruptLines, errors: diagnostics },
        totalLines
      });
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

module.exports = {
  SCHEMA_VERSION,
  VALID_RECORD_TYPES,
  INTEGRITY_STATUS,
  REPLAY_STATUS,
  validateArchiveRecord,
  ArchiveIntegrityService
};
