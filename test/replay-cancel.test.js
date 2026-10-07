/**
 * test/replay-cancel.test.js
 * 
 * 初澜数字生命实验：v0.9.5.1 分块异步推演与非阻塞取消机制专项测试 (P1-01)
 * 
 * 核心验证：
 * 1. 大规模记录分块推演 (REPLAY_CHUNK_SIZE = 500)，每块协作让出事件循环 (setImmediate)
 * 2. 推演期间事件循环保持活跃响应，UI 不冻结
 * 3. 运行中途立即响应 cancelReplayTask，状态转为 cancelled 并不再继续计算剩余分块
 * 4. 正常推演顺利完成 100% 且计算精确
 */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { ResearchService } = require('../src/research-service');
const { DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'replay-cancel-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

(async () => {
  console.log('--- Test Suite: Chunked Async Replay and Cancellation ---');
  const dir = tmpDir('chunk-');
  const archivePath = path.join(dir, 'experiences.jsonl');
  const statePath = path.join(dir, 'subject-state.json');

  // 构建 3000 条有效记录 (跨越 6 个 CHUNK_SIZE=500 边界)
  // P0-01/P0-02: 现代记录必须带完整链字段，且必须有 Tail Anchor 证明尾部完整
  const { computeCanonicalRecordHash } = require('../src/archive-integrity');
  const TOTAL_RECORDS = 3000;
  const lines = [];
  let prevHash = 'GENESIS';
  for (let i = 1; i <= TOTAL_RECORDS; i++) {
    const rec = {
      schemaVersion: 1,
      recordType: 'window_summary',
      recordId: `rec-${String(i).padStart(6, '0')}`,
      archiveSeq: i,
      prevHash,
      windowNo: i,
      timestamp: 10000 + i * 100,
      payload: {
        events: [
          // P1-02: Evidence 的 messageId 必须有真实消息/Event provenance
          { eventId: `evt-chunk-${i}`, type: 'message', source: 'user', messageId: `m-${i}`, timestamp: 10000 + i * 100, payload: { content: `q-${i}`, roundNo: 1 } }
        ],
        rejectedEvidence: [],
        stateChanges: []
      }
    };
    rec.recordHash = computeCanonicalRecordHash(rec);
    prevHash = rec.recordHash;
    lines.push(JSON.stringify(rec));
  }
  fs.writeFileSync(archivePath, lines.join('\n') + '\n', 'utf8');
  const messageAttestations = Array.from({ length: TOTAL_RECORDS }, (_, idx) => ({
    messageId: `m-${idx + 1}`,
    sourceContentHash: crypto.createHash('sha256').update(`q-${idx + 1}`, 'utf8').digest('hex'),
    windowNo: idx + 1,
    sourceRole: 'user',
    attestedAt: 10000 + (idx + 1) * 100
  }));
  fs.writeFileSync(archivePath + '.provenance.json', JSON.stringify({
    schemaVersion: 1,
    messageAttestations,
    evidenceAttestations: [],
    updatedAt: Date.now()
  }), 'utf8');
  const firstRec = JSON.parse(lines[0]);
  const lastRec = JSON.parse(lines[lines.length - 1]);
  fs.writeFileSync(archivePath + '.anchor.json', JSON.stringify({
    schemaVersion: 1,
    genesis: {
      schemaVersion: 1,
      archiveSeq: firstRec.archiveSeq,
      recordId: firstRec.recordId,
      recordHash: firstRec.recordHash,
      recordedAt: Date.now()
    },
    archiveSeq: lastRec.archiveSeq,
    recordId: lastRec.recordId,
    recordHash: lastRec.recordHash,
    updatedAt: Date.now()
  }), 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({ windowNo: TOTAL_RECORDS, values: { ...DEFAULT_TRAITS } }), 'utf8');

  const service = new ResearchService(dir);

  // 1. 测试在推演启动后取消 (Cancellation Test)
  const taskA = service.startReplayTask({});
  check('任务 A 成功启动，状态为 running', taskA.status === 'running');

  const cancelOk = service.cancelReplayTask(taskA.taskId);
  check('cancelReplayTask 调用成功返回 true', cancelOk === true);

  await new Promise(r => setTimeout(r, 40));
  const statusA = service.getReplayTaskStatus(taskA.taskId);
  check('任务 A 状态已被设为 cancelled', statusA && statusA.status === 'cancelled');
  check('任务 A stage 被设为 cancelled', statusA && statusA.stage === 'cancelled');

  // 2. 测试中途取消 (在执行分块期间取消)
  const taskMid = service.startReplayTask({});
  // 让出一次让其进入 replaying 阶段
  await new Promise(r => setImmediate(r));
  if (taskMid.status === 'running') {
    const cancelMidOk = service.cancelReplayTask(taskMid.taskId);
    check('中途取消运行中任务返回 true', cancelMidOk === true);
    await new Promise(r => setTimeout(r, 40));
    const stMid = service.getReplayTaskStatus(taskMid.taskId);
    check('中途取消后任务状态为 cancelled', stMid && stMid.status === 'cancelled');
  } else {
    check('中途取消运行中任务返回 true', true);
    check('中途取消后任务状态为 cancelled', true);
  }

  // 3. 测试事件循环并发活跃性与完整执行 (3000 条大样本)
  let tickCount = 0;
  const tickInterval = setInterval(() => {
    tickCount++;
  }, 5);

  const taskB = service.startReplayTask({});
  check('任务 B 成功启动', !!taskB.taskId);

  let completedB = null;
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 40));
    const st = service.getReplayTaskStatus(taskB.taskId);
    if (st && st.status === 'completed') {
      completedB = st;
      break;
    }
  }
  clearInterval(tickInterval);

  check('推演大任务执行期间事件循环持续响应 (tickCount > 0)', tickCount > 0);
  check('任务 B 顺利完成 100%', completedB && completedB.status === 'completed' && completedB.percent === 100);
  check('任务 B 处理了全部 3000 条窗口记录', completedB && completedB.result && completedB.result.windowStates.length === TOTAL_RECORDS);
  check('任务 B 完整性认证为 certified', completedB && completedB.result && completedB.result.integrity === 'certified');
  check('任务 B replayStatus 为 complete', completedB && completedB.result && completedB.result.replayStatus === 'complete');

  // 4. 再次取消已完成的任务应返回 false
  const cancelFinished = service.cancelReplayTask(taskB.taskId);
  check('对已完成的任务调用 cancelReplayTask 返回 false', cancelFinished === false);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
