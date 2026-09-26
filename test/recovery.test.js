/**
 * test/recovery.test.js
 * 
 * 初澜数字生命实验：故障注入与数据容灾恢复单元测试 (v0.9.4)
 * 
 * 检验点：
 * 1. 关窗小结 API 失败故障注入：网络超时/报错时绝不丢失对话历史（Zero Dialog Loss）
 * 2. 经历归档坏行注入：experiences.jsonl 中间夹杂截断或损坏行时，安全跳过坏行并诊断上报
 * 3. 主体状态文件损坏注入：subject-state.json 损坏时自动保留现场备份并安全重置基底
 * 4. 异步关窗期间并发注入：拍摄快照后、关窗完成前的新进消息不被快照抹除或串门
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');
const { Memory } = require('../src/memory');
const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');
const { ExperiencesArchive } = require('../src/experiences-archive');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'recovery-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. 关窗小结 API 故障注入：绝不丢弃原始对话
// -------------------------------------------------------------
async function testSummaryFailurePreservesDialogue() {
  const dir = tmpDir('summary-fail-');
  const mockApi = {
    complete: async () => {
      throw new Error('NETWORK_TIMEOUT: DeepSeek API simulated down');
    },
    stream: async () => ({ text: 'ok', usage: {} })
  };

  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurnLimit: 2,
    keepTailMessages: 2
  });
  brain.api = mockApi;

  brain.memory.append('user', '消息一：你好初澜');
  brain.memory.append('assistant', '消息二：你好阿哲');
  brain.memory.append('user', '消息三：外面天气怎么样');
  brain.memory.append('assistant', '消息四：好像在下雨呢');

  const historyLenBefore = brain.memory.history.length;
  check('注入前历史消息共 4 条', historyLenBefore === 4);

  // 触发关窗（模拟 API 报错）
  const closeRes = await brain.closeWindow();
  check('关窗 API 失败返回 false', closeRes === false);
  check('关窗失败后历史消息依然完整（无静默删除或裁剪）', brain.memory.history.length === 4);
  check('关窗失败后第 1 条消息未丢失', brain.memory.history[0].content === '消息一：你好初澜');
  check('关窗失败后第 4 条消息未丢失', brain.memory.history[3].content === '消息四：好像在下雨呢');
}

// -------------------------------------------------------------
// 2. experiences.jsonl 坏行容灾与诊断读取
// -------------------------------------------------------------
function testArchiveCorruptLineSkipping() {
  const dir = tmpDir('archive-corrupt-');
  const archivePath = path.join(dir, 'experiences.jsonl');

  const validRecord1 = JSON.stringify({ schemaVersion: 1, recordType: 'window_summary', windowNo: 1, payload: { note: 'line 1' } });
  const corruptLine1 = '{"schemaVersion": 1, "recordType": "incomplete... [TRUNCATED';
  const validRecord2 = JSON.stringify({ schemaVersion: 1, recordType: 'window_summary', windowNo: 2, payload: { note: 'line 3' } });
  const corruptLine2 = 'NOT_JSON_AT_ALL_#!@$%^&*';
  const validRecord3 = JSON.stringify({ schemaVersion: 1, recordType: 'window_summary', windowNo: 3, payload: { note: 'line 5' } });

  fs.writeFileSync(archivePath, [validRecord1, corruptLine1, validRecord2, corruptLine2, validRecord3].join('\n') + '\n', 'utf8');

  const archive = new ExperiencesArchive(dir);
  const records = archive.readAll();
  check('readAll 自动过滤损坏行并保留全部 3 条有效记录', records.length === 3);
  check('有效记录内容准确无误', records[0].payload.note === 'line 1' && records[2].payload.note === 'line 5');

  const diag = archive.readAllWithDiagnostics();
  check('readAllWithDiagnostics 准确报告跳过的损坏行数 (2 行)', diag.diagnostics.skippedCount === 2);
  check('诊断日志包含准确的行号',
    diag.diagnostics.errors.some(e => e.lineNumber === 2) &&
    diag.diagnostics.errors.some(e => e.lineNumber === 4));
}

// -------------------------------------------------------------
// 3. subject-state.json 损坏现场备份与安全回滚
// -------------------------------------------------------------
function testSubjectStateCorruptionBackup() {
  const dir = tmpDir('state-corrupt-');
  const statePath = path.join(dir, 'subject-state.json');

  // 模拟断电或进程强杀导致的半写入坏文件
  fs.writeFileSync(statePath, '{"schemaVersion": 1, "values": { "quiet_preference": 80, "social_initi', 'utf8');

  const ss = new SubjectState(dir);
  check('损坏文件加载时安全回退至 DEFAULT_TRAITS 初始基线',
    ss.values.quiet_preference === DEFAULT_TRAITS.quiet_preference);

  // 检查是否生成了 .corrupt. 现场备份
  const files = fs.readdirSync(dir);
  const backupFile = files.find(f => f.startsWith('subject-state.json.corrupt.'));
  check('损坏现场被安全备份至 .corrupt.<timestamp> 文件', !!backupFile);
  if (backupFile) {
    const backupContent = fs.readFileSync(path.join(dir, backupFile), 'utf8');
    check('备份文件完整保留了受损前的数据现场', backupContent.includes('quiet_preference'));
  }
}

// -------------------------------------------------------------
// 4. 异步关窗期间并发新消息不被抹除
// -------------------------------------------------------------
function testInFlightPostSnapshotIsolation() {
  const dir = tmpDir('inflight-');
  const mem = new Memory(dir, { windowTurnLimit: 2, keepTailMessages: 2 });

  // 填入本窗口前 2 轮对话
  mem.append('user', 'u1');
  mem.append('assistant', 'a1');
  mem.append('user', 'u2');
  mem.append('assistant', 'a2');

  // 1. 拍摄快照
  const snap = mem.windowSnapshot();
  check('快照 activeItems 包含当前窗口全部 4 条消息且 drop 为 2', snap.activeItems.length === 4 && snap.drop === 2 && snap.len === 4);

  // 2. 模拟在异步 API 调用过程中，用户又发送了新消息
  mem.append('user', 'u-inflight-3');
  mem.append('assistant', 'a-inflight-3');
  check('并发注入后总消息数变为 6 条', mem.history.length === 6);

  // 3. 异步 API 调用完毕，执行 closeWindow
  mem.closeWindow('窗口 1 小结', snap);

  // 期望：快照前部被清除，保留尾巴 2 条 bridge 消息 + 并发涌入的 2 条新消息 = 4 条
  check('closeWindow 后并发消息未被误删', mem.history.length === 4);
  const inFlightUser = mem.history.find(m => m.content === 'u-inflight-3');
  const inFlightAssistant = mem.history.find(m => m.content === 'a-inflight-3');
  check('并发注入的 user 消息完好留存且标记为 active (bridge: false)', inFlightUser && inFlightUser.bridge === false);
  check('并发注入的 assistant 消息完好留存', inFlightAssistant && inFlightAssistant.bridge === false);
}

async function runAll() {
  await testSummaryFailurePreservesDialogue();
  testArchiveCorruptLineSkipping();
  testSubjectStateCorruptionBackup();
  testInFlightPostSnapshotIsolation();

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

runAll();
