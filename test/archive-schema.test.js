/**
 * test/archive-schema.test.js
 * 
 * 初澜数字生命实验：v0.9.5.1 Archive Record Schema 规范性与未知类型拦截专项测试
 * 
 * 核心验证：
 * 1. 最小通用字段约束 (schemaVersion, recordType, payload, timestamp, windowNo)
 * 2. 严格白名单机制：拒绝任何未知或自定 recordType (UNKNOWN_RECORD_TYPE)
 * 3. 类型专属 Schema 核验 (window_summary, event, observation, interpretation, evidence, state_change, recovery_event, diagnostic)
 */

const { validateArchiveRecord, VALID_RECORD_TYPES } = require('../src/archive-integrity');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- Test Suite: Archive Schema Validation ---');

// 1. 通用最小字段集核验
const badObj1 = validateArchiveRecord(null);
check('非对象输入拒绝 (INVALID_OBJECT)', !badObj1.valid && badObj1.reason === 'INVALID_OBJECT');

const badObj2 = validateArchiveRecord([1, 2, 3]);
check('数组输入拒绝 (INVALID_OBJECT)', !badObj2.valid && badObj2.reason === 'INVALID_OBJECT');

const badVersion = validateArchiveRecord({ recordType: 'window_summary', payload: {}, timestamp: 1000, windowNo: 1 });
check('缺少 schemaVersion 拒绝 (MISSING_OR_INVALID_SCHEMA_VERSION)', !badVersion.valid && badVersion.reason === 'MISSING_OR_INVALID_SCHEMA_VERSION');

const badType = validateArchiveRecord({ schemaVersion: 1, recordType: '', payload: {}, timestamp: 1000, windowNo: 1 });
check('缺少 recordType 拒绝 (MISSING_OR_INVALID_RECORD_TYPE)', !badType.valid && badType.reason === 'MISSING_OR_INVALID_RECORD_TYPE');

const badPayload = validateArchiveRecord({ schemaVersion: 1, recordType: 'window_summary', timestamp: 1000, windowNo: 1 });
check('缺少 payload 拒绝 (MISSING_OR_INVALID_PAYLOAD)', !badPayload.valid && badPayload.reason === 'MISSING_OR_INVALID_PAYLOAD');

const badTimestamp = validateArchiveRecord({ schemaVersion: 1, recordType: 'window_summary', payload: {}, timestamp: 0, windowNo: 1 });
check('非法 timestamp 拒绝 (MISSING_OR_INVALID_TIMESTAMP)', !badTimestamp.valid && badTimestamp.reason === 'MISSING_OR_INVALID_TIMESTAMP');

const badWindowNo = validateArchiveRecord({ schemaVersion: 1, recordType: 'window_summary', payload: {}, timestamp: 1000, windowNo: -1 });
check('非法 windowNo 拒绝 (MISSING_OR_INVALID_WINDOW_NO)', !badWindowNo.valid && badWindowNo.reason === 'MISSING_OR_INVALID_WINDOW_NO');

// 2. 未知 recordType 强拦截
const unknownType1 = validateArchiveRecord({ schemaVersion: 1, recordType: 'synthetic_message', payload: {}, timestamp: 1000, windowNo: 1 });
check('拦截未知类型 synthetic_message', !unknownType1.valid && unknownType1.reason.includes('UNKNOWN_RECORD_TYPE'));

const unknownType2 = validateArchiveRecord({ schemaVersion: 1, recordType: 'custom_user_telemetry', payload: {}, timestamp: 1000, windowNo: 1 });
check('拦截未知类型 custom_user_telemetry', !unknownType2.valid && unknownType2.reason.includes('UNKNOWN_RECORD_TYPE'));

// 3. window_summary 专属校验
const validSummary = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 100,
    messageCount: 200,
    events: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
});
check('合法 window_summary 记录校验通过', validSummary.valid === true);

const badSummaryEvents = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    events: 'not_an_array'
  }
});
check('window_summary 中 events 必须为数组', !badSummaryEvents.valid && badSummaryEvents.reason === 'EVENTS_MUST_BE_ARRAY');

// 4. event 专属校验
const validEvt = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    eventId: 'evt-000001',
    type: 'message',
    source: 'user'
  }
});
check('合法 event 归档记录校验通过', validEvt.valid === true);

const badEvtSource = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    eventId: 'evt-000002',
    type: 'message',
    source: 'unauthorized_hacker_source'
  }
});
check('event 归档记录非白名单 source 拒绝', !badEvtSource.valid && badEvtSource.reason.includes('EVENT_INVALID_SOURCE'));

// 5. observation 专属校验
const validObs = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'observation',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    observationId: 'obs-000001',
    eventIds: ['evt-000001'],
    content: '用户表示喜好'
  }
});
check('合法 observation 归档记录校验通过', validObs.valid === true);

const badObsNoEvents = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'observation',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    observationId: 'obs-000002',
    eventIds: [],
    content: '空悬观察'
  }
});
check('observation 归档记录缺少 eventIds 拒绝', !badObsNoEvents.valid && badObsNoEvents.reason === 'OBSERVATION_REQUIRES_EVENT_IDS');

// 6. interpretation 专属校验
const validInterp = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'interpretation',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    interpretationId: 'int-000001',
    observationIds: ['obs-000001'],
    content: '主观感受共鸣'
  }
});
check('合法 interpretation 归档记录校验通过', validInterp.valid === true);

// 7. evidence 专属校验
const validEv = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'evidence',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    evidenceId: 'ev-000001',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.8
  }
});
check('合法 evidence 归档记录校验通过', validEv.valid === true);

const badEvTrait = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'evidence',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    evidenceId: 'ev-000002',
    trait: 'fake_illegal_trait'
  }
});
check('evidence 归档记录非法 trait 拒绝', !badEvTrait.valid && badEvTrait.reason.includes('EVIDENCE_INVALID_TRAIT'));

// 8. state_change 专属校验
const validSc = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'state_change',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    stateChangeId: 'sc-000001',
    trait: 'vitality',
    delta: 20
  }
});
check('合法 state_change 归档记录校验通过', validSc.valid === true);

// 9. recovery_event 专属校验
const validRecEvt = validateArchiveRecord({
  schemaVersion: 1,
  recordType: 'recovery_event',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    action: 'state_rebuilt_from_replay',
    timestamp: 1000
  }
});
check('合法 recovery_event 归档记录校验通过', validRecEvt.valid === true);

/* ---- v0.9.9 P1-d (D2): self_ledger_evicted 必须标 MODEL_NARRATIVE ---- */
{
  const okEvicted = validateArchiveRecord({
    schemaVersion: 1, recordType: 'self_ledger_evicted', timestamp: 1000, windowNo: 1,
    payload: { evicted: [{ trait: 'quiet_preference' }], epistemicStatus: 'MODEL_NARRATIVE' }
  });
  check('P1-d：self_ledger_evicted 带 MODEL_NARRATIVE 且有 evicted 时通过', okEvicted.valid === true);
  const noEpistemic = validateArchiveRecord({
    schemaVersion: 1, recordType: 'self_ledger_evicted', timestamp: 1000, windowNo: 1,
    payload: { evicted: [{ trait: 'quiet_preference' }] }
  });
  check('P1-d：缺 epistemicStatus 的 self_ledger_evicted 必须被拒', !noEpistemic.valid);
  const selfCertified = validateArchiveRecord({
    schemaVersion: 1, recordType: 'self_ledger_evicted', timestamp: 1000, windowNo: 1,
    payload: { evicted: [{ trait: 'quiet_preference' }], epistemicStatus: 'CERTIFIED' }
  });
  check('P1-d：自称 CERTIFIED 的 self_ledger_evicted 必须被拒（模型产物不许冒充）', !selfCertified.valid);
  const noEvicted = validateArchiveRecord({
    schemaVersion: 1, recordType: 'self_ledger_evicted', timestamp: 1000, windowNo: 1,
    payload: { epistemicStatus: 'MODEL_NARRATIVE' }
  });
  check('P1-d：缺 evicted 列表的 self_ledger_evicted 必须被拒', !noEvicted.valid);
}

/* ---- v0.9.9 P2-1: subject_dream 认识论门禁（查值不查存在）---- */
{
  // 判据一律走 safeValidate：被测代码若抛异常，要报成 FAIL 而不是截断整个文件
  // （否则红态只看到第一条，无法核对失败清单是否完整）。
  const safeValidate = (r) => {
    try { return validateArchiveRecord(r); }
    catch (e) { return { valid: false, reason: 'THREW: ' + (e && e.message) }; }
  };

  // P2-1a: rec -> record，缺 dreamId 时应**返回拒绝**而不是抛 ReferenceError 逃逸
  const noDreamId = safeValidate({
    schemaVersion: 1, recordType: 'subject_dream', timestamp: 1000, windowNo: 1,
    payload: { epistemicStatus: 'DREAM_GENERATED_ARTIFACT' }
  });
  check('P2-1a：缺 dreamId 时返回 MISSING_DREAM_ID 而非抛异常',
    noDreamId.valid === false && noDreamId.reason === 'MISSING_DREAM_ID',
    'reason=' + noDreamId.reason);

  // P2-1b: 门禁必须查**值**。原实现只看真值，自称 SUBJECT_ACQUIRED（主体习得
  // 自传记忆）也能过 —— 那正是「梦境冒充亲历」。
  const impersonate = safeValidate({
    schemaVersion: 1, recordType: 'subject_dream', timestamp: 1000, windowNo: 1,
    payload: { dreamId: 'd-1', epistemicStatus: 'SUBJECT_ACQUIRED' }
  });
  check('P2-1b：梦境自称 SUBJECT_ACQUIRED（冒充亲历）必须被拒',
    impersonate.valid === false, JSON.stringify(impersonate));
  const selfCertDream = safeValidate({
    schemaVersion: 1, recordType: 'subject_dream', timestamp: 1000, windowNo: 1,
    payload: { dreamId: 'd-2', epistemicStatus: 'CERTIFIED' }
  });
  check('P2-1b：梦境自称 CERTIFIED 必须被拒', selfCertDream.valid === false, JSON.stringify(selfCertDream));
  // 反向守卫：真实梦境仍通过、缺标记仍被拒（收紧不得误伤）
  const realDream = safeValidate({
    schemaVersion: 1, recordType: 'subject_dream', timestamp: 1000, windowNo: 1,
    payload: { dreamId: 'd-3', epistemicStatus: 'DREAM_GENERATED_ARTIFACT' }
  });
  check('P2-1b 不变式：DREAM_GENERATED_ARTIFACT 仍通过（收紧不误伤真实梦境）',
    realDream.valid === true, JSON.stringify(realDream));
  const noEpistDream = safeValidate({
    schemaVersion: 1, recordType: 'subject_dream', timestamp: 1000, windowNo: 1,
    payload: { dreamId: 'd-4' }
  });
  check('P2-1b 不变式：缺 epistemicStatus 仍被拒',
    noEpistDream.valid === false && noEpistDream.reason === 'MISSING_EPISTEMIC_STATUS',
    'reason=' + noEpistDream.reason);
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
