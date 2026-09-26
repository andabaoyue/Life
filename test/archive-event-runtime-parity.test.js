/**
 * test/archive-event-runtime-parity.test.js
 * 
 * Life v0.9.5.3 H-01 回归测试：Archive Event Validation 必须与 Runtime Event Validator 对齐
 * 
 * 核心不变量：
 * Runtime Validator (validateEvent) 不允许的 Event，Archive Validator (validateArchiveRecord) 绝不能认证为实验事实。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateEvent, createEvent } = require('../src/experience-schema');
const { validateArchiveRecord, ArchiveIntegrityService, INTEGRITY_STATUS } = require('../src/archive-integrity');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'parity-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Archive Event Runtime Parity (H-01) ---');

// =============================================================================
// Test A: window_summary.payload.events[] 存在 FORGED_TYPE
// =============================================================================
const forgedEvent = {
  eventId: 'evt-forged-01',
  type: 'FORGED_TYPE',
  source: 'user',
  payload: { content: 'forged' }
};

const vRuntimeForged = validateEvent(forgedEvent);
check('Test A: Runtime validateEvent 拒绝 FORGED_TYPE', vRuntimeForged.valid === false && vRuntimeForged.reason === 'EVENT_TYPE_NOT_ALLOWED');

const summaryWithForgedEvent = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 1,
    events: [forgedEvent]
  }
};

const vArchiveForged = validateArchiveRecord(summaryWithForgedEvent);
check('Test A: Archive validateArchiveRecord 拒绝包含 FORGED_TYPE 的归档记录', vArchiveForged.valid === false);
check('Test A: Archive 拒绝理由包含 EVENT_TYPE_NOT_ALLOWED', vArchiveForged.reason && vArchiveForged.reason.includes('EVENT_TYPE_NOT_ALLOWED'));

const dirA = tmpDir('parity-a-');
const archiveA = path.join(dirA, 'experiences.jsonl');
fs.writeFileSync(archiveA, JSON.stringify(summaryWithForgedEvent) + '\n', 'utf8');
const reportA = ArchiveIntegrityService.checkArchive(archiveA);
check('Test A: 包含 FORGED_TYPE 嵌套事件的归档被标记为 UNCERTIFIED/INVALID', reportA.integrity !== INTEGRITY_STATUS.CERTIFIED && reportA.integrity === INTEGRITY_STATUS.UNCERTIFIED);
try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}

// =============================================================================
// Test B: 嵌套 Event 缺失 source
// =============================================================================
const missingSourceEvent = {
  eventId: 'evt-nosrc-01',
  type: 'message',
  payload: { content: 'no source' }
};

const vRuntimeNoSrc = validateEvent(missingSourceEvent);
check('Test B: Runtime validateEvent 拒绝缺少 source 的事件', vRuntimeNoSrc.valid === false && vRuntimeNoSrc.reason.includes('INVALID_EVENT_SOURCE'));

const summaryWithMissingSource = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 1,
    events: [missingSourceEvent]
  }
};

const vArchiveNoSrc = validateArchiveRecord(summaryWithMissingSource);
check('Test B: Archive validateArchiveRecord 拒绝包含缺失 source 事件的记录', vArchiveNoSrc.valid === false);
check('Test B: Archive 明确报错 INVALID_EVENT_SOURCE', vArchiveNoSrc.reason && vArchiveNoSrc.reason.includes('INVALID_EVENT_SOURCE'));

// =============================================================================
// Test C: 嵌套 Event 使用未知 source
// =============================================================================
const unknownSourceEvent = {
  eventId: 'evt-unksrc-01',
  type: 'message',
  source: 'unknown_agent_sensor',
  payload: { content: 'unknown source' }
};

const vRuntimeUnkSrc = validateEvent(unknownSourceEvent);
check('Test C: Runtime validateEvent 拒绝未知 source', vRuntimeUnkSrc.valid === false && vRuntimeUnkSrc.reason.includes('INVALID_EVENT_SOURCE'));

const summaryWithUnknownSource = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 1,
    events: [unknownSourceEvent]
  }
};

const vArchiveUnkSrc = validateArchiveRecord(summaryWithUnknownSource);
check('Test C: Archive validateArchiveRecord 拒绝包含未知 source 事件的记录', vArchiveUnkSrc.valid === false && vArchiveUnkSrc.reason.includes('INVALID_EVENT_SOURCE'));

// =============================================================================
// Test D: 嵌套 Event synthetic / generated 标记
// =============================================================================
const syntheticEvent = {
  eventId: 'evt-syn-01',
  type: 'message',
  source: 'user',
  synthetic: true,
  payload: { content: 'synthetic' }
};

const generatedEvent = {
  eventId: 'evt-gen-01',
  type: 'message',
  source: 'user',
  generated: true,
  payload: { content: 'generated' }
};

check('Test D: Runtime validateEvent 拒绝 synthetic 事件', validateEvent(syntheticEvent).valid === false && validateEvent(syntheticEvent).reason === 'SYNTHETIC_EVENT_PROHIBITED');
check('Test D: Runtime validateEvent 拒绝 generated 事件', validateEvent(generatedEvent).valid === false && validateEvent(generatedEvent).reason === 'GENERATED_EVENT_PROHIBITED');

const summarySynthetic = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: { turns: 1, events: [syntheticEvent] }
};
const summaryGenerated = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: { turns: 1, events: [generatedEvent] }
};

check('Test D: Archive 拒绝嵌套 synthetic 事件', validateArchiveRecord(summarySynthetic).valid === false && validateArchiveRecord(summarySynthetic).reason === 'SYNTHETIC_EVENT_PROHIBITED');
check('Test D: Archive 拒绝嵌套 generated 事件', validateArchiveRecord(summaryGenerated).valid === false && validateArchiveRecord(summaryGenerated).reason === 'GENERATED_EVENT_PROHIBITED');

const dirD = tmpDir('parity-d-');
const archiveD = path.join(dirD, 'experiences.jsonl');
fs.writeFileSync(archiveD, JSON.stringify(summarySynthetic) + '\n' + JSON.stringify(summaryGenerated) + '\n', 'utf8');
const reportD = ArchiveIntegrityService.checkArchive(archiveD);
check('Test D: 包含 synthetic/generated 事件的归档判定为 UNCERTIFIED (绝不得 CERTIFIED)', reportD.integrity === INTEGRITY_STATUS.UNCERTIFIED);
try { fs.rmSync(dirD, { recursive: true, force: true }); } catch {}

// =============================================================================
// Test E: 合法 Event 与合法归档记录
// =============================================================================
const validEvent = {
  eventId: 'evt-valid-01',
  type: 'message',
  source: 'user',
  payload: { content: 'hello world', roundNo: 1 }
};

const vRuntimeValid = validateEvent(validEvent);
check('Test E: Runtime validateEvent 认证合法事件', vRuntimeValid.valid === true);

const summaryValid = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 1,
    events: [validEvent]
  }
};

const vArchiveValid = validateArchiveRecord(summaryValid);
check('Test E: Archive validateArchiveRecord 认证合法事件归档', vArchiveValid.valid === true);

const dirE = tmpDir('parity-e-');
const archiveE = path.join(dirE, 'experiences.jsonl');
fs.writeFileSync(archiveE, JSON.stringify(summaryValid) + '\n', 'utf8');
const reportE = ArchiveIntegrityService.checkArchive(archiveE);
check('Test E: 纯合法事件归档正常获得 CERTIFIED 认证', reportE.integrity === INTEGRITY_STATUS.CERTIFIED);
try { fs.rmSync(dirE, { recursive: true, force: true }); } catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
