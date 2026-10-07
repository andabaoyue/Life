/**
 * test/archive-event-strictness.test.js
 * 
 * 初澜数字生命实验：v0.9.5.2 Archive Event 严格验证、来源正向白名单与坏账防御专项测试
 * 覆盖规范：Test D, Test E, Test F, Test G, Test H
 * 
 * 核心验证：
 * 1. Test D: 未知 Event Source (如 unknown_source) 拒绝 (INVALID_EVENT_SOURCE)
 * 2. Test E: 缺 Source (无 source 字段) 拒绝 (INVALID_EVENT_SOURCE)
 * 3. Test F: Synthetic / Generated 标记事件坚决拒绝 (SYNTHETIC_EVENT_PROHIBITED)，归档判定为 UNCERTIFIED
 * 4. Test G: 缺乏 Provenance 真实溯源证明的 Bridge 记录拒绝 (BRIDGE_EVENT_UNPROVEN)，降级为 UNRESOLVED
 * 5. Test H: 坏账存在时 (1,2好, 3坏, 4好) 绝对不得 CERTIFIED (Replay=partial, Integrity=uncertified)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateArchiveRecord, ArchiveIntegrityService, INTEGRITY_STATUS, REPLAY_STATUS } = require('../src/archive-integrity');
const { ResearchService } = require('../src/research-service');
const { ResearchQuery } = require('../src/research-query');
const { DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'event-strict-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Archive Event Strictness (Tests D, E, F, G, H) ---');

// =============================================================================
// Test D: 未知 Event Source 拦截
// =============================================================================
const badSourceRecord = {
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    eventId: 'evt-d-01',
    type: 'message',
    source: 'unknown_source'
  }
};
const resD = validateArchiveRecord(badSourceRecord);
check('Test D: 未知 Event Source 拦截校验失败', resD.valid === false);
check('Test D: 明确报错原因包含 INVALID_EVENT_SOURCE', resD.reason && resD.reason.includes('INVALID_EVENT_SOURCE'));

// =============================================================================
// Test E: 缺 Source 拦截
// =============================================================================
const missingSourceRecord = {
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    eventId: 'evt-e-01',
    type: 'message'
  }
};
const resE = validateArchiveRecord(missingSourceRecord);
check('Test E: 缺失 Source 字段拦截校验失败', resE.valid === false);
check('Test E: 明确报错原因为 INVALID_EVENT_SOURCE (绝不跳过)', resE.reason === 'INVALID_EVENT_SOURCE');

// =============================================================================
// Test F: Synthetic / Generated 事件拦截
// =============================================================================
const synTopRecord = {
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 1,
  timestamp: 1000,
  synthetic: true,
  payload: {
    eventId: 'evt-f-01',
    type: 'message',
    source: 'user'
  }
};
const resFTop = validateArchiveRecord(synTopRecord);
check('Test F: 顶层 synthetic=true 记录被拒绝', resFTop.valid === false && resFTop.reason === 'SYNTHETIC_EVENT_PROHIBITED');

const synPayloadRecord = {
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    eventId: 'evt-f-02',
    type: 'message',
    source: 'user',
    synthetic: true
  }
};
const resFPayload = validateArchiveRecord(synPayloadRecord);
check('Test F: payload 中 synthetic=true 记录被拒绝', resFPayload.valid === false && resFPayload.reason === 'SYNTHETIC_EVENT_PROHIBITED');

const genRecord = {
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    eventId: 'evt-f-03',
    type: 'message',
    source: 'user',
    generated: true
  }
};
const resFGen = validateArchiveRecord(genRecord);
check('Test F: generated=true 虚构事件被拒绝', resFGen.valid === false && resFGen.reason === 'GENERATED_EVENT_PROHIBITED');

// 验证包含 Synthetic 记录的文件无法获得 CERTIFIED 认证
const dirF = tmpDir('syn-archive-');
const archiveF = path.join(dirF, 'experiences.jsonl');
fs.writeFileSync(archiveF, JSON.stringify(synPayloadRecord) + '\n', 'utf8');
const reportF = ArchiveIntegrityService.checkArchive(archiveF);
check('Test F: 包含 Synthetic 事件的归档无法被 CERTIFIED', reportF.integrity !== INTEGRITY_STATUS.CERTIFIED);
check('Test F: 包含 Synthetic 事件标记为 uncertified', reportF.integrity === INTEGRITY_STATUS.UNCERTIFIED);

// =============================================================================
// Test G: Bridge 无 Provenance 拦截与降级
// =============================================================================
const unprovenBridgeRecord = {
  schemaVersion: 1,
  recordType: 'event',
  windowNo: 2,
  timestamp: 2000,
  bridge: true,
  payload: {
    eventId: 'evt-g-01',
    type: 'message',
    source: 'assistant',
    content: '我是桥接回复，但我没有来源记录'
  }
};
const resG = validateArchiveRecord(unprovenBridgeRecord);
check('Test G: 缺乏 provenance 的 bridge 事件底层校验拒绝', resG.valid === false && resG.reason === 'BRIDGE_EVENT_UNPROVEN');

// 验证在 ResearchQuery 轮次呈现中，无 provenance 的 bridge 绝不标注为真实 BRIDGE
const dirG = tmpDir('bridge-archive-');
const archiveG = path.join(dirG, 'experiences.jsonl');
const stateG = path.join(dirG, 'subject-state.json');
const summaryG = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 1,
    events: [
      {
        eventId: 'evt-g-02',
        type: 'message',
        source: 'assistant',
        bridge: true, // 无 provenance
        payload: { content: '悬空桥接消息', roundNo: 1 }
      }
    ]
  }
};
fs.writeFileSync(archiveG, JSON.stringify(summaryG) + '\n', 'utf8');
fs.writeFileSync(stateG, JSON.stringify({ windowNo: 1, values: { ...DEFAULT_TRAITS } }), 'utf8');
const queryG = new ResearchQuery(dirG);
const roundsG = queryG.getWindowRounds(1);
check('Test G: 无 provenance 的 bridge 在轮次中 bridge 被重置为 null (绝不误认)', roundsG[0].bridge === null);
check('Test G: 轮次 tag 绝不标为 BRIDGE', roundsG[0].tag !== 'BRIDGE');

// =============================================================================
// Test H: 坏账归档绝不得 CERTIFIED (1 好, 2 好, 3 坏, 4 好)
// =============================================================================
(async () => {
  const dirH = tmpDir('corrupted-archive-');
  const archiveH = path.join(dirH, 'experiences.jsonl');
  const stateH = path.join(dirH, 'subject-state.json');

  const rec1 = JSON.stringify({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 1000,
    payload: {
      turns: 1,
      verifiedEvidence: [{ evidenceId: 'ev-h-01', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-1', quote: 'q' }],
      rejectedEvidence: [],
      stateChanges: [{ stateChangeId: 'sc-h-01', trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20 }]
    }
  });

  const rec2 = JSON.stringify({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 2,
    timestamp: 2000,
    payload: {
      turns: 1,
      verifiedEvidence: [{ evidenceId: 'ev-h-02', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-2', quote: 'q' }],
      rejectedEvidence: [],
      stateChanges: [{ stateChangeId: 'sc-h-02', trait: 'quiet_preference', delta: 20, previousValue: 20, newValue: 40 }]
    }
  });

  // 第 3 行损坏：损坏的 JSON 字符
  const rec3 = 'CORRUPTED_LINE_JSON_FATAL_ERROR_HERE';

  const rec4 = JSON.stringify({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 4,
    timestamp: 4000,
    payload: {
      turns: 1,
      verifiedEvidence: [{ evidenceId: 'ev-h-04', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-4', quote: 'q' }],
      rejectedEvidence: [],
      stateChanges: [{ stateChangeId: 'sc-h-04', trait: 'quiet_preference', delta: 20, previousValue: 40, newValue: 60 }]
    }
  });

  fs.writeFileSync(archiveH, [rec1, rec2, rec3, rec4].join('\n') + '\n', 'utf8');
  fs.writeFileSync(stateH, JSON.stringify({ windowNo: 4, values: { ...DEFAULT_TRAITS } }), 'utf8');

  // 1. Archive 完整性检查
  const reportH = ArchiveIntegrityService.checkArchive(archiveH);
  check('Test H: 捕获到 1 行损坏行 (corruptLines=1)', reportH.corruptLines === 1);
  check('Test H: 归档完整性绝不得为 certified', reportH.integrity !== INTEGRITY_STATUS.CERTIFIED);
  check('Test H: Replay 判定状态为 partial', reportH.replayStatus === REPLAY_STATUS.PARTIAL);

  // 2. Replay 任务推演
  const serviceH = new ResearchService(dirH);
  const repTask = serviceH.startReplayTask({});
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 40));
    const st = serviceH.getReplayTaskStatus(repTask.taskId);
    if (st && st.status === 'completed') break;
  }
  const replayResult = serviceH.getReplayTaskStatus(repTask.taskId).result;
  check('Test H: Replay 结果 replayStatus 标记为 partial', replayResult.replayStatus === 'partial');
  check('Test H: Replay 结果完整性绝不得为 certified', replayResult.integrity !== 'certified');
  check('Test H: Replay 结果完整性标记为 uncertified', replayResult.integrity === 'uncertified');

  // 3. Research Explorer 视角
  const queryH = new ResearchQuery(dirH);
  const detailH = queryH.getWindowDetail(1);
  check('Test H: Research 视角完整性绝不得为 CERTIFIED', detailH.archiveIntegrity !== 'CERTIFIED');
  check('Test H: Research 视角 replayStatus 为 PARTIAL', detailH.replayStatus === 'PARTIAL');

  try {
    fs.rmSync(dirF, { recursive: true, force: true });
    fs.rmSync(dirG, { recursive: true, force: true });
    fs.rmSync(dirH, { recursive: true, force: true });
  } catch {}

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
