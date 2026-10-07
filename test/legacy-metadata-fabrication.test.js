/**
 * test/legacy-metadata-fabrication.test.js
 * 
 * 初澜数字生命实验：Legacy 数据元数据严禁伪造测试 (P0-10 & P0-12)
 * 
 * 核心验证：
 * Test A: 缺失 schemaVersion 时严禁程序补为原生 schemaVersion = 1
 * Test B: 缺失 timestamp 时严禁程序补为 Date.now()
 * Test C: 缺失 windowNo 时严禁程序默认补为 1
 * Test D: 缺失 roundNo 时严禁程序推断或补为 1
 * Test E: 缺失 messageId 时严禁伪造 UNKNOWN_MESSAGE
 * Test F: 缺失 eventId 时严禁由数组下标伪造
 * Test G: 端到端全链路检查 (Normalizer -> Integrity -> ResearchQuery -> ResearchService -> Export)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeArchiveRecord } = require('../src/experience-schema');
const { ArchiveIntegrityService, INTEGRITY_STATUS } = require('../src/archive-integrity');
const { SubjectState } = require('../src/subject-state');
const { ResearchQuery } = require('../src/research-query');
const { ResearchService } = require('../src/research-service');
const { exportFullResearchBundle, exportStateChanges } = require('../src/research-export');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'legacy-fab-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Legacy Metadata Fabrication Prevention (P0-10 & P0-12) ---');

// =============================================================================
// Test A: 缺失 schemaVersion 时严禁程序补为原生 schemaVersion = 1
// =============================================================================
const legacyWithoutSchema = {
  type: 'window_archive',
  windowNo: 2,
  createdAt: 1672531199000,
  turns: 20
};
const normA = normalizeArchiveRecord(legacyWithoutSchema);
check('Test A.1: 遗留记录标准化后 schemaVersion 严禁为 1', normA.schemaVersion === undefined || normA.schemaVersion === null);
check('Test A.2: 遗留记录标记 canonicalSchema 为 v1', normA.canonicalSchema === 'v1');
check('Test A.3: 遗留记录标记 schemaOrigin 为 legacy-adapted', normA.schemaOrigin === 'legacy-adapted');
check('Test A.4: 遗留记录标记 compatibilityAdapter 为 LegacySchemaAdapter', normA.compatibilityAdapter === 'LegacySchemaAdapter');

// =============================================================================
// Test B: 缺失 timestamp 时严禁程序补为 Date.now()
// =============================================================================
const legacyWithoutTs = {
  type: 'window_archive',
  windowNo: 1,
  turns: 15
};
const beforeNow = Date.now();
const normB = normalizeArchiveRecord(legacyWithoutTs);
const afterNow = Date.now();
check('Test B.1: 遗留记录缺失 timestamp 时保持为 null', normB.timestamp === null);
check('Test B.2: 遗留记录严禁被赋值为当前系统时间 Date.now()', normB.timestamp < beforeNow || normB.timestamp > afterNow || normB.timestamp === null);

// =============================================================================
// Test C: 缺失 windowNo 时严禁程序默认补为 1
// =============================================================================
const legacyWithoutWindow = {
  type: 'window_archive',
  createdAt: 1000,
  turns: 10
};
const normC = normalizeArchiveRecord(legacyWithoutWindow);
check('Test C.1: 遗留记录缺失 windowNo 时标准化保持为 null', normC.windowNo === null);
check('Test C.2: 遗留记录绝对不默认补填 windowNo = 1', normC.windowNo !== 1);

// =============================================================================
// Test D: 缺失 roundNo 时严禁程序推断或补为 1
// =============================================================================
const testDirD = tmpDir('round-fab-');
const archiveD = path.join(testDirD, 'experiences.jsonl');
const recD = {
  recordType: 'window_summary',
  canonicalSchema: 'v1',
  schemaOrigin: 'legacy-adapted',
  compatibilityAdapter: 'LegacySchemaAdapter',
  timestamp: 1000,
  windowNo: null,
  payload: {
    turns: null,
    messageCount: null,
    events: [
      { eventId: 'e-1', type: 'message', source: 'user', content: 'hello missing round' }
    ],
    observations: [],
    interpretations: [],
    segments: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};
fs.writeFileSync(archiveD, JSON.stringify(recD) + '\n', 'utf8');
const queryD = new ResearchQuery(testDirD);
const roundsD = queryD.getWindowRounds(null);
const unassignedRound = roundsD.find(r => r.roundNo === null);
check('Test D.1: 缺失 roundNo 的记录被归入 roundNo 为 null 的未分配组', !!unassignedRound);
check('Test D.2: 缺失 roundNo 的记录绝对不被强制塞入 Round 1', !roundsD.some(r => r.roundNo === 1 && r.messages && r.messages.some(m => m.content === 'hello missing round')));
check('Test D.3: 未分配轮次状态明确标为 UNRESOLVED', unassignedRound && unassignedRound.status === 'UNRESOLVED');

// =============================================================================
// Test E: 缺失 messageId 时严禁伪造 UNKNOWN_MESSAGE
// =============================================================================
const recE = {
  recordType: 'window_summary',
  canonicalSchema: 'v1',
  schemaOrigin: 'legacy-adapted',
  compatibilityAdapter: 'LegacySchemaAdapter',
  timestamp: 2000,
  windowNo: 1,
  payload: {
    turns: 10,
    messageCount: 5,
    events: [
      { eventId: 'e-no-msg', type: 'message', source: 'user', content: 'test message content' }
    ],
    observations: [],
    interpretations: [],
    segments: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};
const normE = normalizeArchiveRecord(recE);
const evtE = normE.payload.events[0];
check('Test E.1: 事件缺少 messageId 时保留 null 或 undefined', evtE.messageId === null || evtE.messageId === undefined);
check('Test E.2: 事件绝对不产生伪造的 UNKNOWN_MESSAGE 字符串', evtE.messageId !== 'UNKNOWN_MESSAGE');

// =============================================================================
// Test F: 缺失 eventId 时严禁由数组下标伪造
// =============================================================================
const legacyEvts = {
  type: 'window_archive',
  windowNo: 1,
  createdAt: 3000,
  events: [
    { type: 'user_action', source: 'user', content: 'click' },
    { type: 'user_action', source: 'user', content: 'drag' }
  ]
};
const normF = normalizeArchiveRecord(legacyEvts);
const firstEvt = normF.payload.events[0];
const secondEvt = normF.payload.events[1];
check('Test F.1: 遗留事件缺失 eventId 时第一项不被编造为 event-0 或 ev-0', firstEvt.eventId !== 'event-0' && firstEvt.eventId !== 'ev-0');
check('Test F.2: 遗留事件缺失 eventId 时第二项不被编造为 event-1 或 ev-1', secondEvt.eventId !== 'event-1' && secondEvt.eventId !== 'ev-1');
check('Test F.3: 缺失 eventId 真实保持为 null 或 undefined', firstEvt.eventId === null || firstEvt.eventId === undefined);

// =============================================================================
// Test G: 端到端全链路检查 (Normalizer -> Integrity -> ResearchQuery -> ResearchService -> Export)
// =============================================================================
const pipelineDir = tmpDir('pipeline-fab-');
const pipelineArchive = path.join(pipelineDir, 'experiences.jsonl');
const pipelineState = path.join(pipelineDir, 'subject-state.json');

const rawLegacyPipeline = {
  type: 'window_archive',
  turns: 7,
  events: [
    { source: 'user', content: 'pipeline content' }
  ],
  verifiedEvidence: [
    { trait: 'philosophical_curiosity', delta: 5 }
  ],
  stateChanges: [
    { trait: 'philosophical_curiosity', previousValue: 0, delta: 5, newValue: 5 }
  ]
};

fs.writeFileSync(pipelineArchive, JSON.stringify(rawLegacyPipeline) + '\n', 'utf8');
fs.writeFileSync(pipelineState, JSON.stringify({
  version: 1,
  currentState: { philosophical_curiosity: 5, quiet_preference: 0, social_initiative: 0, attachment_need: 0, vitality: 0 },
  history: []
}), 'utf8');

// 1. Normalizer 检查
const normPipe = normalizeArchiveRecord(rawLegacyPipeline);
check('Test G.1: Pipeline 归档标准化保持 windowNo 为 null', normPipe.windowNo === null);
check('Test G.2: Pipeline 归档标准化保持 timestamp 为 null', normPipe.timestamp === null);
check('Test G.3: Pipeline 归档标准化绝无 schemaVersion = 1', normPipe.schemaVersion !== 1);

// 2. Integrity 检查
const reportPipe = ArchiveIntegrityService.checkArchive(pipelineArchive);
check('Test G.4: ArchiveIntegrity 准确识别 hasLegacyAdapter = true', reportPipe.hasLegacyAdapter === true);
check('Test G.5: 遗留数据归档判定为 UNCERTIFIED (严禁 CERTIFIED)', reportPipe.integrity === INTEGRITY_STATUS.UNCERTIFIED);
check('Test G.6: 诊断日志记录无虚构报错', reportPipe.diagnostics.length === 0 || reportPipe.diagnostics[0].error !== 'CORRUPT_RECORD');

// 3. ResearchQuery 检查
const queryPipe = new ResearchQuery(pipelineDir);
const windowsPipe = queryPipe.getWindows().items;
const nullWindow = windowsPipe.find(w => w.windowNo === null);
check('Test G.7: ResearchQuery.getWindows 包含 windowNo 为 null 的未分配窗口', !!nullWindow);
check('Test G.8: 未分配窗口概况绝不伪造为 windowNo = 1', !windowsPipe.some(w => w.windowNo === 1));
check('Test G.9: 未分配窗口如实保留 turns = 7', nullWindow && nullWindow.turns === 7);
check('Test G.10: 未分配窗口未记录 messageCount 时保持 null', nullWindow && nullWindow.messageCount === null);

// 4. SubjectState Replay & ResearchService 检查
const replayRecords = queryPipe._readArchiveRecords();
const replayResult = SubjectState.replay(replayRecords);
check('Test G.11: SubjectState 确定性复盘平滑执行且计算出最终特质', typeof replayResult.finalState.philosophical_curiosity === 'number');
const servicePipe = new ResearchService(pipelineDir);
const taskInfo = servicePipe.startReplayTask();
check('Test G.12: ResearchService 异步 Replay 任务成功启动', taskInfo.status === 'running');

// 5. ResearchExport 检查
const bundle = exportFullResearchBundle(queryPipe);
check('Test G.13: Export Bundle 导出成功并包含 8 项实验数据文件', Object.keys(bundle.files).length === 8);
const scCsv = exportStateChanges(queryPipe.getStateChanges().items, 'csv');
check('Test G.14: Export CSV 导出中未标明 windowNo 记录输出为空字符串 (绝无虚构 1)', !scCsv.includes(',1,philosophical_curiosity,'));

try {
  fs.rmSync(testDirD, { recursive: true, force: true });
  fs.rmSync(pipelineDir, { recursive: true, force: true });
} catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
