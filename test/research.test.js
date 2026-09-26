/**
 * test/research.test.js
 * 
 * 初澜数字生命实验：v0.9.5 实验观测与可复盘工具链专项测试集
 * 
 * 核心覆盖规范：
 * Test A: Research Archive Offset Index (P1-06)
 *   - 索引构建、多维 ID 映射 (eventId, obsId, intId, evId, scId, msgId, windowNo)
 *   - 基于 byteOffset 与 length 的精准局部读取
 *   - 文件变更检测与自动重新构建，底层 Archive 永不被篡改
 * Test B: 异步 Replay 实验室 (P1-04)
 *   - 异步任务管道与百分比进度推进 (0% -> 100%)
 *   - 主动任务取消 (cancelReplayTask)，状态为 cancelled 且不留脏数据
 * Test C: Replay Fail-Stop 确定性熔断 (P1-04)
 *   - 坏行立即停机，绝不跳过坏行继续计算后续行
 *   - 状态冻结在 lastValidRecord，标记 partial 与 uncertified
 * Test D: Evidence Cardinality Contract 关系契约 (P1-03)
 *   - 1 StateChange -> N Evidence (evidenceIds: [])
 *   - 1 Evidence -> 严格绑定 1 个 Trait
 *   - 同一 Message -> 多条合法 Evidence 分别影响不同特质
 * Test E: Snapshot Mode 快照模式与手动刷新 (P1-07)
 *   - 默认快照固定视图，后台写数据不自动干扰当前页面
 *   - 手动触发 refresh 获得最新数据视图
 * Test F: 纯只读数据完整性门禁 (SHA-256 Checksum)
 *   - 观测前后 experiences.jsonl 与 subject-state.json 哈希完全一致
 *   - 发生意外写变动时严格抛出 RESEARCH_WRITE_VIOLATION
 * Test G: 轨迹与全量研究包导出格式 (P1-05)
 *   - Trajectory CSV / StateChange CSV / Evidence CSV 字段规范
 *   - Full Research Bundle 完整包含 metadata.json (v0.9.5) 与各层数据
 * Test H: IPC 白名单与历史版本兼容性
 *   - 严禁挂载任何写操作通道
 *   - 遗留旧格式平滑降级兼容
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ResearchIndex } = require('../src/research-index');
const { ResearchQuery } = require('../src/research-query');
const {
  exportStateTrajectory,
  exportStateChanges,
  exportEvidence,
  exportFullResearchBundle
} = require('../src/research-export');
const { ResearchService } = require('../src/research-service');
const { registerResearchIpc } = require('../src/research-ipc');
const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');
const { ExperiencesArchive } = require('../src/experiences-archive');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'research-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -----------------------------------------------------------------------------
// Test A: Research Archive Offset Index (P1-06)
// -----------------------------------------------------------------------------
function testA_Index() {
  console.log('\n--- Test A: Research Archive Offset Index ---');
  const dir = tmpDir('idx-');
  const archivePath = path.join(dir, 'experiences.jsonl');

  const rec1 = {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 1000,
    payload: {
      turns: 100,
      messageCount: 200,
      events: [
        { eventId: 'evt-000101', type: 'message', messageId: 'm-000101', source: 'user' },
        { eventId: 'evt-000102', type: 'message', messageId: 'm-000102', source: 'assistant' }
      ],
      observations: [
        { observationId: 'obs-000101', eventIds: ['evt-000101'], content: '用户表达偏好' }
      ],
      interpretations: [
        { interpretationId: 'int-000101', observationIds: ['obs-000101'], content: '初澜感受到共鸣' }
      ],
      verifiedEvidence: [
        { evidenceId: 'ev-000101', trait: 'quiet_preference', direction: 1, strength: 0.8, messageId: 'm-000101', quote: '数字生命' }
      ],
      rejectedEvidence: [
        { evidenceId: 'ev-000102', trait: 'vitality', reason: 'MISSING_QUOTE', messageId: 'm-000101' }
      ],
      stateChanges: [
        { stateChangeId: 'sc-000101', trait: 'quiet_preference', previousValue: 0, delta: 16, newValue: 16, evidenceIds: ['ev-000101'] }
      ]
    }
  };

  const rec2 = {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 2,
    timestamp: 2000,
    payload: {
      turns: 100,
      messageCount: 200,
      events: [
        { eventId: 'evt-000201', type: 'message', messageId: 'm-000201', source: 'user' }
      ],
      observations: [],
      interpretations: [],
      verifiedEvidence: [
        { evidenceId: 'ev-000201', trait: 'vitality', direction: 1, strength: 1.0, messageId: 'm-000201', quote: '你好' }
      ],
      rejectedEvidence: [],
      stateChanges: [
        { stateChangeId: 'sc-000201', trait: 'vitality', previousValue: 0, delta: 20, newValue: 20, evidenceIds: ['ev-000201'] }
      ]
    }
  };

  fs.writeFileSync(archivePath, JSON.stringify(rec1) + '\n' + JSON.stringify(rec2) + '\n', 'utf8');

  const index = new ResearchIndex(archivePath);
  check('初始索引未标记为 valid', !index.indexValid);

  index.ensureIndex();
  check('建立索引后状态为 valid', index.indexValid);
  check('总有效行数索引正确 (2 行)', index.lineEntries.length === 2);

  // 检查多维 ID 映射
  const descEvt = index.getDescriptorById('evt-000101');
  check('能够通过 eventId 定位描述符', !!descEvt && descEvt.windowNo === 1);

  const descObs = index.getDescriptorById('obs-000101');
  check('能够通过 observationId 定位描述符', !!descObs && descObs.windowNo === 1);

  const descInt = index.getDescriptorById('int-000101');
  check('能够通过 interpretationId 定位描述符', !!descInt && descInt.windowNo === 1);

  const descEv = index.getDescriptorById('ev-000101');
  check('能够通过 evidenceId 定位描述符', !!descEv && descEv.trait === 'quiet_preference');

  const descSc = index.getDescriptorById('sc-000101');
  check('能够通过 stateChangeId 定位描述符', !!descSc && descSc.trait === 'quiet_preference');

  const descMsg = index.messageIndex.get('m-000101');
  check('能够通过 messageId 定位描述符', Array.isArray(descMsg) && descMsg.length > 0);

  // 测试精准局部读取
  const directRec = index.readRecordAtOffset(descEvt.byteOffset, descEvt.byteLength);
  check('基于 byteOffset 精准读取的 JSON 内容正确', !!directRec && directRec.windowNo === 1);

  const recBySc = index.getRecordById('sc-000201');
  check('通过 getRecordById 直接获取所在记录', !!recBySc && recBySc.windowNo === 2);

  // 文件变更检测与自动重建
  const oldRebuildCount = index.rebuildCount;
  check('文件未变动时 checkValidity 返回 true', index.checkValidity());

  // 追加一行，模拟后台增长
  const rec3 = { schemaVersion: 1, recordType: 'window_summary', windowNo: 3, timestamp: 3000, payload: { turns: 100 } };
  fs.appendFileSync(archivePath, JSON.stringify(rec3) + '\n', 'utf8');

  check('文件修改后 checkValidity 返回 false', !index.checkValidity());
  index.ensureIndex();
  check('重新 ensureIndex 触发了全量重建', index.rebuildCount > oldRebuildCount);
  check('重建后行数增加至 3 行', index.lineEntries.length === 3);

  // 保证底层归档没有被索引修改
  const readContent = fs.readFileSync(archivePath, 'utf8');
  check('索引行为绝不修改原始归档文件', readContent.split('\n').filter(Boolean).length === 3);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Test B: 异步 Replay 实验室 (P1-04)
// -----------------------------------------------------------------------------
async function testB_AsyncReplay() {
  console.log('\n--- Test B: 异步 Replay 实验室 ---');
  const dir = tmpDir('replay-');
  const archivePath = path.join(dir, 'experiences.jsonl');

  const lines = [];
  for (let w = 1; w <= 5; w++) {
    lines.push(JSON.stringify({
      schemaVersion: 1,
      recordType: 'window_summary',
      windowNo: w,
      timestamp: w * 1000,
      payload: {
        verifiedEvidence: [
          { evidenceId: `ev-${w}`, trait: 'quiet_preference', direction: 1, strength: 0.5, messageId: `m-${w}`, quote: `q-${w}` }
        ],
        rejectedEvidence: [],
        stateChanges: [
          { stateChangeId: `sc-${w}`, trait: 'quiet_preference', delta: 10, previousValue: (w - 1) * 10, newValue: w * 10, reducer: { stepWeight: 20, maxDelta: 50 } }
        ]
      }
    }));
  }
  fs.writeFileSync(archivePath, lines.join('\n') + '\n', 'utf8');

  const service = new ResearchService(dir);

  // 1. 正常执行异步 Replay 任务
  const startRes = service.startReplayTask({});
  check('Replay 启动返回有效的 taskId', !!startRes.taskId);
  check('启动初始状态为 running', startRes.status === 'running');

  // 等待异步推进完成
  let completedTask = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 50));
    const st = service.getReplayTaskStatus(startRes.taskId);
    if (st && st.status === 'completed') {
      completedTask = st;
      break;
    }
  }

  check('异步 Replay 任务顺利执行完成', !!completedTask && completedTask.status === 'completed');
  check('进度百分比达到 100%', completedTask && completedTask.percent === 100);
  check('推演终态 quiet_preference 正确演化 (+50)', completedTask && completedTask.result && completedTask.result.finalState.quiet_preference === 50);
  check('归档完整性被认证为 CERTIFIED', completedTask && completedTask.result && completedTask.result.integrity === 'certified');
  check('Replay 状态为 COMPLETE', completedTask && completedTask.result && completedTask.result.replayStatus === 'complete');

  // 2. 取消 Replay 任务测试
  const cancelStart = service.startReplayTask({});
  const cancelled = service.cancelReplayTask(cancelStart.taskId);
  check('成功调用 cancelReplayTask', cancelled === true);

  const cancelledSt = service.getReplayTaskStatus(cancelStart.taskId);
  check('已取消任务状态被标为 cancelled', cancelledSt && cancelledSt.status === 'cancelled');

  // 确保数据文件完好未变
  const currentArchive = fs.readFileSync(archivePath, 'utf8');
  check('Replay 与取消操作未修改 experiences.jsonl', currentArchive.split('\n').filter(Boolean).length === 5);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Test C: Replay Fail-Stop 确定性熔断 (P1-04)
// -----------------------------------------------------------------------------
async function testC_FailStop() {
  console.log('\n--- Test C: Replay Fail-Stop 确定性熔断 ---');
  const dir = tmpDir('failstop-');
  const archivePath = path.join(dir, 'experiences.jsonl');

  const line1 = JSON.stringify({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 1000,
    payload: {
      verifiedEvidence: [{ evidenceId: 'ev-01', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-1', quote: 'q1' }],
      rejectedEvidence: []
    }
  });

  // 第 2 行损坏：非有效 JSON
  const line2 = '{"schemaVersion":1, "recordType":"window_summary", MALFORMED_JSON_HERE...';

  // 第 3 行完好
  const line3 = JSON.stringify({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 3,
    timestamp: 3000,
    payload: {
      verifiedEvidence: [{ evidenceId: 'ev-03', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-3', quote: 'q3' }],
      rejectedEvidence: []
    }
  });

  fs.writeFileSync(archivePath, line1 + '\n' + line2 + '\n' + line3 + '\n', 'utf8');

  const service = new ResearchService(dir);
  const startRes = service.startReplayTask({});

  let resultTask = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 50));
    const st = service.getReplayTaskStatus(startRes.taskId);
    if (st && st.status === 'completed') {
      resultTask = st;
      break;
    }
  }

  check('检测到坏行时 Replay 顺利收尾', !!resultTask);
  const res = (resultTask && resultTask.result) || {};

  check('Fail-Stop 机制启动：状态标记为 partial', res.replayStatus === 'partial');
  check('完整性标记为 uncertified', res.integrity === 'uncertified');
  check('最后有效记录冻结在第 1 行 (lastValidRecord=1)', res.lastValidRecord === 1);
  check('准确捕获第 2 行的损坏信息 (failure.line=2)', res.failure && res.failure.line === 2);
  check('失败原因明确记录为 MALFORMED_JSON', res.failure && res.failure.reason === 'MALFORMED_JSON');
  check('未跳过坏行继续计算第 3 行 (状态只累加了第 1 行 +20，而非 +40)', res.finalState && res.finalState.quiet_preference === 20);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Test D: Evidence Cardinality Contract 关系契约 (P1-03)
// -----------------------------------------------------------------------------
function testD_Cardinality() {
  console.log('\n--- Test D: Evidence Cardinality Contract ---');
  const dir = tmpDir('cardinality-');
  const state = new SubjectState(dir, { stepWeight: 20, maxDeltaPerWindow: 50 });

  // 契约 1: 同一 Message 可以衍生多条分别针对不同 Trait 的 Evidence
  const mockMsg = {
    messageId: 'm-dual-001',
    role: 'user',
    content: '我想安静地看看书，同时也对哲学世界感到好奇。'
  };
  const msgMap = new Map([[mockMsg.messageId, mockMsg]]);

  const evidenceList = [
    {
      evidenceId: 'ev-quiet-01',
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.8,
      messageId: mockMsg.messageId,
      quote: '安静'
    },
    {
      evidenceId: 'ev-philo-01',
      trait: 'philosophical_curiosity',
      direction: 1,
      strength: 0.8,
      messageId: mockMsg.messageId,
      quote: '哲学'
    }
  ];

  const verifyRes = state.verifyEvidence(evidenceList, msgMap, 1);
  check('同一 Message 生成的多条不同 Trait 证据均被接受', verifyRes.verified.length === 2);
  check('接受的两条 Evidence 分属不同 Trait', verifyRes.verified[0].trait !== verifyRes.verified[1].trait);

  // 契约 2: 1 条 Evidence 严格对应 1 个 Trait
  for (const ev of verifyRes.verified) {
    check(`Evidence [${ev.evidenceId}] 只且必须绑定一个 Trait`, typeof ev.trait === 'string' && ev.trait.length > 0);
  }

  // 契约 3: 1 条 StateChange 允许聚合多条 Evidence (evidenceIds: string[])
  const multiEvForSameTrait = [
    {
      evidenceId: 'ev-quiet-02',
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: mockMsg.messageId,
      quote: '安静'
    }
  ];
  // 注入已验证证据，执行 Reducer
  const reduceRes = state.reduce([verifyRes.verified[0], multiEvForSameTrait[0]], 1);
  check('产生状态跃迁', reduceRes.stateChanges.length > 0);

  const quietSc = reduceRes.stateChanges.find(sc => sc.trait === 'quiet_preference');
  check('1 个 StateChange 包含多个 Evidence 引用', !!quietSc && Array.isArray(quietSc.evidenceIds) && quietSc.evidenceIds.length === 2);
  check('StateChange 关联的 Evidence ID 与输入完全一致', quietSc.evidenceIds.includes('ev-quiet-01') && quietSc.evidenceIds.includes('ev-quiet-02'));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Test E: Snapshot Mode 快照模式与手动刷新 (P1-07)
// -----------------------------------------------------------------------------
function testE_Snapshot() {
  console.log('\n--- Test E: Snapshot Mode 快照模式与手动刷新 ---');
  const dir = tmpDir('snapshot-');
  const archivePath = path.join(dir, 'experiences.jsonl');
  const statePath = path.join(dir, 'subject-state.json');

  const initialRec = {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 1000,
    payload: {
      verifiedEvidence: [{ evidenceId: 'ev-01', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-1', quote: 'q' }],
      stateChanges: [{ stateChangeId: 'sc-01', trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20 }]
    }
  };
  fs.writeFileSync(archivePath, JSON.stringify(initialRec) + '\n', 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({ windowNo: 2, values: { ...DEFAULT_TRAITS, quiet_preference: 20 }, stateChanges: [] }), 'utf8');

  const service = new ResearchService(dir);

  // 1. 初次读取快照
  const snap1 = service.getSnapshot();
  check('快照成功创建且记录了时间戳', !!snap1 && !!snap1.snapshotTimestamp);
  check('快照内主体状态 quiet_preference 正确反映为 20', snap1.state.values.quiet_preference === 20);

  // 2. 后台发生数据写入（模拟对话产生新状态）
  fs.writeFileSync(statePath, JSON.stringify({ windowNo: 3, values: { ...DEFAULT_TRAITS, quiet_preference: 45 }, stateChanges: [] }), 'utf8');

  // 3. 在未调用 refresh 时，Snapshot 保持固定
  const snapStill = service.snapshot;
  check('后台更新后，未刷新前现有快照数据保持不变 (仍为 20)', snapStill.state.values.quiet_preference === 20);

  // 4. 手动调用 refreshSnapshot 后，拉取新数据
  const snapRefreshed = service.refreshSnapshot();
  check('手动触发 refresh 后，快照状态更新为最新值 45', snapRefreshed.state.values.quiet_preference === 45);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Test F: 纯只读数据完整性门禁 (SHA-256 Checksum)
// -----------------------------------------------------------------------------
async function testF_ReadOnlyIntegrity() {
  console.log('\n--- Test F: 纯只读数据完整性门禁 ---');
  const dir = tmpDir('readonly-');
  const archivePath = path.join(dir, 'experiences.jsonl');
  const statePath = path.join(dir, 'subject-state.json');

  const rec = {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 1000,
    payload: {
      turns: 100,
      events: [{ eventId: 'evt-01', messageId: 'm-01', source: 'user' }],
      observations: [{ observationId: 'obs-01', eventIds: ['evt-01'], content: '观察内容' }],
      interpretations: [{ interpretationId: 'int-01', observationIds: ['obs-01'], content: '解释内容' }],
      verifiedEvidence: [{ evidenceId: 'ev-01', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-01', quote: 'q' }],
      rejectedEvidence: [],
      stateChanges: [{ stateChangeId: 'sc-01', trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20, evidenceIds: ['ev-01'] }]
    }
  };
  fs.writeFileSync(archivePath, JSON.stringify(rec) + '\n', 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({ windowNo: 2, values: { ...DEFAULT_TRAITS, quiet_preference: 20 }, stateChanges: [] }), 'utf8');

  const service = new ResearchService(dir);

  // 1. 进入观测模式，记录初始 SHA-256
  const hashesBefore = service.computeIntegrityHashes();
  check('成功计算 archive SHA-256 哈希', typeof hashesBefore.archiveSha256 === 'string' && hashesBefore.archiveSha256.length === 64);
  check('成功计算 state SHA-256 哈希', typeof hashesBefore.stateSha256 === 'string' && hashesBefore.stateSha256.length === 64);

  // 2. 执行所有观测、查询、复盘与导出操作
  service.query.getSubjectState();
  service.query.getWindows();
  service.query.getWindowDetail(1);
  service.query.getWindowRounds(1, 1);
  service.query.getEvents();
  service.query.getObservations();
  service.query.getInterpretations();
  service.query.getEvidence();
  service.query.getStateChanges();
  service.query.traceProvenance('sc-01');
  service.query.traceEOI('int-01');
  service.query.search({ query: 'quiet' });
  service.exportData({ type: 'trajectory', format: 'csv' });
  service.exportData({ type: 'full' });

  // 启动并等待一个 Replay 任务
  const rep = service.startReplayTask({});
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 40));
    const st = service.getReplayTaskStatus(rep.taskId);
    if (st && st.status === 'completed') break;
  }

  // 3. 校验观测后哈希与初始哈希完全一致
  const hashesAfter = service.computeIntegrityHashes();
  check('Research 操作后 archive SHA-256 绝对一致 (Before == After)', hashesBefore.archiveSha256 === hashesAfter.archiveSha256);
  check('Research 操作后 state SHA-256 绝对一致 (Before == After)', hashesBefore.stateSha256 === hashesAfter.stateSha256);

  const verifyOk = service.verifyIntegrity(hashesBefore);
  check('verifyIntegrity 校验通过', verifyOk === true);

  // 4. 模拟篡改触发安全报警
  fs.appendFileSync(archivePath, '{"taint":true}\n', 'utf8');
  let threwViolation = false;
  try {
    service.verifyIntegrity(hashesBefore);
  } catch (err) {
    threwViolation = err.message.includes('RESEARCH_WRITE_VIOLATION');
  }
  check('检测到篡改时严格抛出 RESEARCH_WRITE_VIOLATION 异常', threwViolation === true);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Test G: 轨迹与全量研究包导出格式 (P1-05)
// -----------------------------------------------------------------------------
function testG_Export() {
  console.log('\n--- Test G: 轨迹与全量研究包导出格式 ---');
  const dir = tmpDir('export-');
  const query = new ResearchQuery(dir);

  const mockTrajectory = [
    { windowNo: 1, trait: 'quiet_preference', previousValue: 0, delta: 12, newValue: 12 },
    { windowNo: 2, trait: 'quiet_preference', previousValue: 12, delta: 6, newValue: 18 }
  ];

  const trajCsv = exportStateTrajectory(mockTrajectory, 'csv');
  check('Trajectory CSV 包含标准表头', trajCsv.startsWith('window,trait,previous,delta,newValue'));
  check('Trajectory CSV 包含数据行', trajCsv.includes('1,quiet_preference,0,12,12'));

  const mockChanges = [
    { stateChangeId: 'sc-01', windowNo: 1, trait: 'quiet_preference', previousValue: 0, delta: 12, newValue: 12, evidenceIds: ['ev-01', 'ev-02'], createdAt: 1000 }
  ];
  const scCsv = exportStateChanges(mockChanges, 'csv');
  check('StateChanges CSV 包含标准表头', scCsv.startsWith('stateChangeId,windowNo,trait,previousValue,delta,newValue,evidenceIds,timestamp'));
  check('StateChanges CSV 证据列表正确用分号聚合', scCsv.includes('ev-01;ev-02'));

  const mockEvidence = [
    { evidenceId: 'ev-01', messageId: 'm-01', quote: '你好, 初澜', trait: 'quiet_preference', direction: 1, strength: 0.8, status: 'verified', reason: '', fingerprint: 'fp-01' }
  ];
  const evCsv = exportEvidence(mockEvidence, 'csv');
  check('Evidence CSV 包含标准表头', evCsv.startsWith('evidenceId,messageId,quote,trait,direction,strength,status,reason,fingerprint'));
  check('Evidence CSV 包含正确转义的逗号摘录', evCsv.includes('"你好, 初澜"'));

  // 全量实验研究包导出测试
  const exportTargetDir = path.join(dir, 'bundle_out');
  const bundleResult = exportFullResearchBundle(query, { targetDir: exportTargetDir });

  check('Full Bundle 包含 metadata.json', !!bundleResult.files['metadata.json']);
  check('Full Bundle 包含 state.json', !!bundleResult.files['state.json']);
  check('Full Bundle 包含 events.json', !!bundleResult.files['events.json']);
  check('Full Bundle 包含 observations.json', !!bundleResult.files['observations.json']);
  check('Full Bundle 包含 interpretations.json', !!bundleResult.files['interpretations.json']);
  check('Full Bundle 包含 evidence.json', !!bundleResult.files['evidence.json']);
  check('Full Bundle 包含 state-changes.json', !!bundleResult.files['state-changes.json']);

  const meta = JSON.parse(bundleResult.files['metadata.json']);
  check('metadata.json 标明 appVersion=0.9.5.2', meta.appVersion === '0.9.5.2');
  check('metadata.json 包含 exportTimestamp', typeof meta.exportTimestamp === 'number');

  check('导出目录中成功落地真实文件', fs.existsSync(path.join(exportTargetDir, 'metadata.json')));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Test H: IPC 白名单与历史兼容性
// -----------------------------------------------------------------------------
function testH_IpcAndCompat() {
  console.log('\n--- Test H: IPC 白名单与历史兼容性 ---');
  const dir = tmpDir('ipc-');
  const service = new ResearchService(dir);

  const registeredHandlers = new Map();
  const fakeIpcMain = {
    handle: (ch, fn) => registeredHandlers.set(ch, fn)
  };

  registerResearchIpc(fakeIpcMain, service);

  const requiredReadChannels = [
    'research:get-state',
    'research:get-windows',
    'research:get-window',
    'research:get-window-rounds',
    'research:get-events',
    'research:get-observations',
    'research:get-interpretations',
    'research:get-evidence',
    'research:get-state-changes',
    'research:get-provenance',
    'research:get-eoi',
    'research:search',
    'research:replay:start',
    'research:replay:status',
    'research:replay:cancel',
    'research:export',
    'research:refresh',
    'research:verify-integrity',
    'research:get-hashes'
  ];

  check('所有只读观察通道均已成功挂载', requiredReadChannels.every(ch => registeredHandlers.has(ch)));

  const prohibitedWriteChannels = [
    'research:set-state',
    'research:update-event',
    'research:update-evidence',
    'research:delete-event',
    'research:delete-evidence',
    'research:edit-archive',
    'research:rewrite-state'
  ];
  check('白名单控制严格：任何写通道均未被暴露', prohibitedWriteChannels.every(ch => !registeredHandlers.has(ch)));

  // 历史版本兼容性：v0.9.3 格式归档平滑读取
  const v93Archive = path.join(dir, 'experiences.jsonl');
  const legacyRec = {
    type: 'window_archive',
    windowNo: 1,
    createdAt: 1000,
    turns: 50,
    events: [{ eventId: 'evt-leg-01', messageId: 'm-leg-01' }],
    verifiedEvidence: [{ evidenceId: 'ev-leg-01', trait: 'quiet_preference', direction: 1, strength: 0.5 }]
  };
  fs.writeFileSync(v93Archive, JSON.stringify(legacyRec) + '\n', 'utf8');

  const q = new ResearchQuery(dir);
  const evRes = q.getEvidence();
  check('旧版 v0.9.3 window_archive 记录平滑兼容并正常提取证据', evRes.items.length === 1 && evRes.items[0].evidenceId === 'ev-leg-01');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// 执行测试集
// -----------------------------------------------------------------------------
(async () => {
  testA_Index();
  await testB_AsyncReplay();
  await testC_FailStop();
  testD_Cardinality();
  testE_Snapshot();
  await testF_ReadOnlyIntegrity();
  testG_Export();
  testH_IpcAndCompat();

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
