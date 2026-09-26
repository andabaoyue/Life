/**
 * 初澜数字生命实验：经验与事实三层分离规范模型 (v0.9.4)
 * 
 * 核心哲学与工程边界：
 * 1. Event（真实事件）：实际发生、系统可精确溯源的物理/交互事实，不受主观解释反向修改。
 * 2. Observation（观察结果）：对一个或多个 Event 的直接模式检测，不掺杂主观动机推断。
 * 3. Interpretation（主体解释）：初澜基于 Observation 形成的主观感知、反思与关系理解，具不确定性，可被后续经验修正，不得覆盖客观 Event。
 * 4. Experience（可追踪经历单元）：复合结构，包含 events, observations, interpretations 与 evidence。
 */

const SCHEMA_VERSION = 1;

let eventSeq = 0;
let obsSeq = 0;
let intSeq = 0;
let expSeq = 0;
let evSeq = 0;

// P0-03: 严格定义 Event 真实来源边界
const ALLOWED_EVENT_TYPES = new Set([
  'message',
  'user_input',
  'desktop_motion',
  'activity_tracker',
  'lifecycle'
]);

// P1-02: 严格正向 Event Source 白名单
const ALLOWED_EVENT_SOURCES = new Set([
  'user',
  'assistant',
  'activity-tracker',
  'desktop-motion',
  'lifecycle'
]);

const PROHIBITED_EVENT_SOURCES = new Set([
  'system',
  'system_prompt',
  'summary_sys',
  'merge_sys',
  'internal_prompt',
  'llm_raw_request',
  'llm_raw_response',
  'memory_compression',
  'internal_debug',
  'replay_log',
  'recovery_log',
  'synthetic_message',
  'internal_test'
]);

/**
 * 判定一条运行时消息或项是否具备转化为客观 Event 的主体交互资格 (P0-03)
 */
function isEligibleSubjectEvent(item) {
  if (!item || typeof item !== 'object') return false;
  if (!item.messageId) return false;
  // 严格禁止 Synthetic 消息与 Bridge 桥接消息成为当前窗口新发生的主体 Event
  if (item.synthetic === true) return false;
  if (item.bridge === true) return false;
  // 仅限真实用户与初澜回复
  if (item.role !== 'user' && item.role !== 'assistant') return false;

  const src = String(item.source || item.role || '').toLowerCase();
  if (PROHIBITED_EVENT_SOURCES.has(src)) return false;

  // 内部 Prompt 与调试排查
  const content = String(item.content || '');
  if (content.startsWith('【对话】') || (content.startsWith('[自主感知触发]') && item.synthetic)) return false;

  return true;
}

/**
 * 创建 Event 真实事件
 */
function createEvent(opts = {}) {
  eventSeq++;
  const eventId = opts.eventId || ('evt-' + String(eventSeq).padStart(6, '0'));
  return {
    eventId,
    type: opts.type || 'message',
    timestamp: opts.timestamp || Date.now(),
    windowNo: (typeof opts.windowNo === 'number' && !isNaN(opts.windowNo)) ? opts.windowNo : 1,
    messageId: opts.messageId || null,
    source: opts.source || 'user',
    payload: opts.payload || {}
  };
}

/**
 * 校验 Event 合法性 (P0-03 & P1-02: 正向白名单与严格边界核验)
 */
function validateEvent(evt) {
  if (!evt || typeof evt !== 'object') return { valid: false, reason: 'INVALID_OBJECT' };
  if (typeof evt.eventId !== 'string' || !evt.eventId.trim()) return { valid: false, reason: 'MISSING_EVENT_ID' };
  if (typeof evt.type !== 'string' || !evt.type.trim()) return { valid: false, reason: 'MISSING_TYPE' };

  const cleanType = evt.type.trim();
  if (!ALLOWED_EVENT_TYPES.has(cleanType)) {
    return { valid: false, reason: 'EVENT_TYPE_NOT_ALLOWED' };
  }

  // 来源黑名单与正向白名单检查 (P1-02)
  const src = String(evt.source || '').toLowerCase().trim();
  if (!src) {
    return { valid: false, reason: 'INVALID_EVENT_SOURCE' };
  }
  if (PROHIBITED_EVENT_SOURCES.has(src)) {
    return { valid: false, reason: 'PROHIBITED_EVENT_SOURCE: ' + src };
  }
  if (!ALLOWED_EVENT_SOURCES.has(src)) {
    return { valid: false, reason: 'INVALID_EVENT_SOURCE (EVENT_INVALID_SOURCE): ' + src };
  }

  // 检查 payload 或顶层是否夹带禁止标记 (Synthetic / Generated / Bridge / System)
  if (evt.synthetic === true || (evt.payload && evt.payload.synthetic === true)) {
    return { valid: false, reason: 'SYNTHETIC_EVENT_PROHIBITED' };
  }
  if (evt.generated === true || (evt.payload && evt.payload.generated === true)) {
    return { valid: false, reason: 'GENERATED_EVENT_PROHIBITED' };
  }
  if (evt.bridge === true || (evt.payload && evt.payload.bridge === true)) {
    return { valid: false, reason: 'BRIDGE_EVENT_PROHIBITED' };
  }

  return { valid: true };
}

/**
 * 创建 Observation 观察
 */
function createObservation(opts = {}) {
  obsSeq++;
  const observationId = opts.observationId || ('obs-' + String(obsSeq).padStart(6, '0'));
  const eventIds = Array.isArray(opts.eventIds) ? [...opts.eventIds] : [];
  const confidence = typeof opts.confidence === 'number'
    ? Math.max(0, Math.min(1, opts.confidence))
    : 1.0;

  return {
    observationId,
    eventIds,
    type: opts.type || 'interaction_pattern',
    content: String(opts.content || '').trim(),
    confidence,
    source: opts.source || 'activity-tracker'
  };
}

/**
 * 校验 Observation 合法性
 */
function validateObservation(obs, availableEventIds = null) {
  if (!obs || typeof obs !== 'object') return { valid: false, reason: 'INVALID_OBJECT' };
  if (typeof obs.observationId !== 'string' || !obs.observationId.trim()) return { valid: false, reason: 'MISSING_OBSERVATION_ID' };
  if (!Array.isArray(obs.eventIds) || obs.eventIds.length === 0) return { valid: false, reason: 'OBSERVATION_REQUIRES_EVENTS' };
  if (typeof obs.content !== 'string' || !obs.content.trim()) return { valid: false, reason: 'EMPTY_CONTENT' };

  let idSet = null;
  if (availableEventIds instanceof Set) idSet = availableEventIds;
  else if (Array.isArray(availableEventIds)) idSet = new Set(availableEventIds);
  else if (availableEventIds instanceof Map) idSet = new Set(availableEventIds.keys());

  if (idSet) {
    for (const eid of obs.eventIds) {
      if (!idSet.has(eid)) {
        return { valid: false, reason: `REFERENCED_EVENT_NOT_FOUND: ${eid}`, eventId: eid };
      }
    }
  }
  return { valid: true };
}

/**
 * 创建 Interpretation 主体解释
 */
function createInterpretation(opts = {}) {
  intSeq++;
  const interpretationId = opts.interpretationId || ('int-' + String(intSeq).padStart(6, '0'));
  const observationIds = Array.isArray(opts.observationIds) ? [...opts.observationIds] : [];
  const confidence = typeof opts.confidence === 'number'
    ? Math.max(0, Math.min(1, opts.confidence))
    : 0.5;

  return {
    interpretationId,
    observationIds,
    content: String(opts.content || '').trim(),
    confidence,
    perspective: 'chulan',
    timestamp: opts.timestamp || Date.now()
  };
}

/**
 * 校验 Interpretation 合法性
 */
function validateInterpretation(interp, availableObservationIds = null) {
  if (!interp || typeof interp !== 'object') return { valid: false, reason: 'INVALID_OBJECT' };
  if (typeof interp.interpretationId !== 'string' || !interp.interpretationId.trim()) return { valid: false, reason: 'MISSING_INTERPRETATION_ID' };
  if (!Array.isArray(interp.observationIds) || interp.observationIds.length === 0) return { valid: false, reason: 'INTERPRETATION_REQUIRES_OBSERVATIONS' };
  if (typeof interp.content !== 'string' || !interp.content.trim()) return { valid: false, reason: 'EMPTY_CONTENT' };

  let idSet = null;
  if (availableObservationIds instanceof Set) idSet = availableObservationIds;
  else if (Array.isArray(availableObservationIds)) idSet = new Set(availableObservationIds);
  else if (availableObservationIds instanceof Map) idSet = new Set(availableObservationIds.keys());

  if (idSet) {
    for (const oid of interp.observationIds) {
      if (!idSet.has(oid)) {
        return { valid: false, reason: `REFERENCED_OBSERVATION_NOT_FOUND: ${oid}`, observationId: oid };
      }
    }
  }
  return { valid: true };
}

/**
 * 创建 Experience 复合经历单元
 */
function createExperience(opts = {}) {
  expSeq++;
  const experienceId = opts.experienceId || ('exp-' + String(expSeq).padStart(6, '0'));
  return {
    experienceId,
    windowNo: (typeof opts.windowNo === 'number' && !isNaN(opts.windowNo)) ? opts.windowNo : 1,
    events: Array.isArray(opts.events) ? opts.events : [],
    observations: Array.isArray(opts.observations) ? opts.observations : [],
    interpretations: Array.isArray(opts.interpretations) ? opts.interpretations : [],
    evidence: Array.isArray(opts.evidence) ? opts.evidence : [],
    createdAt: opts.createdAt || Date.now(),
    schemaVersion: SCHEMA_VERSION
  };
}

/**
 * 标准 JSONL Archive 记录封装器
 */
function wrapArchiveRecord(recordType, windowNo, payload = {}) {
  const resolvedWindowNo = (typeof windowNo === 'number' && !isNaN(windowNo))
    ? windowNo
    : (windowNo === null ? null : (windowNo !== undefined ? windowNo : null));
  return {
    schemaVersion: SCHEMA_VERSION,
    recordType,
    timestamp: Date.now(),
    windowNo: resolvedWindowNo,
    payload
  };
}

/**
 * 向后兼容解析器：将旧版 v0.9.3 window_archive 记录平滑转换为标准化结构 (P0-09)
 */
function normalizeArchiveRecord(rawRecord) {
  if (!rawRecord || typeof rawRecord !== 'object') return null;

  const legacyTimestamp = (typeof rawRecord.timestamp === 'number' && !isNaN(rawRecord.timestamp))
    ? rawRecord.timestamp
    : ((typeof rawRecord.createdAt === 'number' && !isNaN(rawRecord.createdAt)) ? rawRecord.createdAt : null);

  const legacyWindowNo = (typeof rawRecord.windowNo === 'number' && !isNaN(rawRecord.windowNo))
    ? rawRecord.windowNo
    : ((rawRecord.payload && typeof rawRecord.payload.windowNo === 'number' && !isNaN(rawRecord.payload.windowNo))
      ? rawRecord.payload.windowNo
      : null);

  // v0.9.4+ 历史或过渡记录结构 (缺少 schemaVersion 必须经过 LegacySchemaAdapter)
  if (rawRecord.recordType && rawRecord.payload) {
    if (!rawRecord.schemaVersion) {
      const copy = { ...rawRecord };
      delete copy.schemaVersion;
      return {
        ...copy,
        sourceSchema: 'legacy-v0.9.4',
        canonicalSchema: 'v1',
        schemaOrigin: 'legacy-adapted',
        compatibilityAdapter: 'LegacySchemaAdapter',
        legacyStatus: 'LEGACY_COMPATIBLE',
        timestamp: legacyTimestamp,
        windowNo: legacyWindowNo
      };
    }
    return rawRecord;
  }

  // v0.9.3 既有遗留格式兼容 (明确附着 LegacyAdapter 标记，绝不冒充原生认证)
  if (rawRecord.type === 'window_archive') {
    return {
      recordType: 'window_summary',
      sourceSchema: 'legacy-v0.9.3',
      canonicalSchema: 'v1',
      schemaOrigin: 'legacy-adapted',
      compatibilityAdapter: 'LegacySchemaAdapter',
      legacyStatus: 'LEGACY_COMPATIBLE',
      timestamp: legacyTimestamp,
      windowNo: legacyWindowNo,
      payload: {
        turns: typeof rawRecord.turns === 'number' ? rawRecord.turns : null,
        messageCount: typeof rawRecord.messageCount === 'number' ? rawRecord.messageCount : null,
        events: Array.isArray(rawRecord.events) ? rawRecord.events : [],
        observations: Array.isArray(rawRecord.observations) ? rawRecord.observations : [],
        interpretations: Array.isArray(rawRecord.interpretations) ? rawRecord.interpretations : [],
        segments: Array.isArray(rawRecord.segments) ? rawRecord.segments : [],
        windowSynthesis: rawRecord.windowSynthesis && typeof rawRecord.windowSynthesis === 'object' ? rawRecord.windowSynthesis : {},
        stateEvidence: Array.isArray(rawRecord.stateEvidence) ? rawRecord.stateEvidence : [],
        verifiedEvidence: Array.isArray(rawRecord.verifiedEvidence) ? rawRecord.verifiedEvidence : [],
        rejectedEvidence: Array.isArray(rawRecord.rejectedEvidence) ? rawRecord.rejectedEvidence : [],
        stateChanges: Array.isArray(rawRecord.stateChanges) ? rawRecord.stateChanges : [],
        explanations: Array.isArray(rawRecord.explanations) ? rawRecord.explanations : [],
        rawSummaryText: typeof rawRecord.rawSummaryText === 'string' ? rawRecord.rawSummaryText : ''
      }
    };
  }

  // 无法识别旧格式的任意残留记录：统一标记为 legacy-unknown，绝不猜测版本
  return {
    recordType: rawRecord.recordType || rawRecord.type || 'legacy_unknown',
    sourceSchema: 'legacy-unknown',
    canonicalSchema: 'v1',
    schemaOrigin: 'legacy-adapted',
    compatibilityAdapter: 'LegacySchemaAdapter',
    legacyStatus: 'LEGACY_UNKNOWN',
    timestamp: legacyTimestamp,
    windowNo: legacyWindowNo,
    payload: rawRecord.payload && typeof rawRecord.payload === 'object' ? rawRecord.payload : { ...rawRecord }
  };
}

module.exports = {
  SCHEMA_VERSION,
  ALLOWED_EVENT_TYPES,
  ALLOWED_EVENT_SOURCES,
  PROHIBITED_EVENT_SOURCES,
  isEligibleSubjectEvent,
  createEvent,
  validateEvent,
  createObservation,
  validateObservation,
  createInterpretation,
  validateInterpretation,
  createExperience,
  wrapArchiveRecord,
  normalizeArchiveRecord
};
