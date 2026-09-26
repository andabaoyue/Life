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

// -------------------------------------------------------------
// 5. P0-2: Exactly-once / idempotent 恢复与关窗防重测试
// -------------------------------------------------------------
async function testIdempotentRecoveryAndArchive() {
  const dir = tmpDir('recovery-idempotent-');
  const archive = new ExperiencesArchive(dir);

  // 5.1 appendWindowArchive 重复调用防重
  const ok1 = archive.appendWindowArchive({ windowNo: 1, turns: 2, rawSummaryText: 'first' });
  check('首次 appendWindowArchive 成功', ok1 && archive.count() === 1);

  const ok2 = archive.appendWindowArchive({ windowNo: 1, turns: 2, rawSummaryText: 'duplicate' });
  check('重复调用 appendWindowArchive 返回 true (幂等成功)', ok2 === true);
  check('重复调用未产生重复的 window_archive 记录', archive.count() === 1);
  const recs = archive.getByWindow(1);
  check('窗口 1 归档记录严格仅有 1 条', recs.length === 1);

  // 5.2 模拟关窗提交失败后，重试关窗不会生成重复归档
  const brainDir = tmpDir('brain-retry-');
  const mockApi = {
    complete: async () => ({
      text: JSON.stringify({
        version: '1.0',
        windowSynthesis: { stableUserFacts: ['事实1'], subjectExperiences: ['体验1'], stateChangesSuggested: [] },
        interpretations: []
      }),
      usage: {}
    }),
    stream: async () => ({ text: 'ok', usage: {} })
  };

  const brain = new Brain(brainDir, {
    ...DEFAULTS,
    windowTurnLimit: 2,
    keepTailMessages: 2
  });
  brain.api = mockApi;
  brain.memory.append('user', '用户第一句');
  brain.memory.append('assistant', '初澜第一句');
  brain.memory.append('user', '用户第二句');
  brain.memory.append('assistant', '初澜第二句');

  // 模拟第一次 commit 失败（进入 recoveryPending）
  const origCommit = brain.subjectState.commit.bind(brain.subjectState);
  brain.subjectState.commit = () => {
    brain.subjectState.commit = origCommit; // 恢复
    return false;
  };

  const res1 = await brain.closeWindow();
  check('第一次 closeWindow 因 commit 失败返回 false', res1 === false);
  check('经历归档已记录窗口 1 window_archive', brain.experiencesArchive.hasWindowArchive(1));

  // 第二次调用 closeWindow 重试
  const res2 = await brain.closeWindow();
  check('第二次 closeWindow 重试成功', res2 === true);
  const allArchives = brain.experiencesArchive.readAll().filter(r => (r.recordType || r.type) === 'window_archive');
  check('经历归档中窗口 1 window_archive 严格仅有 1 条 (无重复记录)', allArchives.length === 1);
}

// -----------------------------------------------------------------------------
// 6. 故障注入专项四场景测试 (Fault Injection Cases A / B / C / D)
// -----------------------------------------------------------------------------
async function testFaultInjectionMatrix() {
  // Case A: Archive 成功, State commit 失败, 进程退出 -> 重启 -> Recovery -> Replay -> State 恢复 -> 窗口正常结束
  {
    const dirA = tmpDir('fault-a-');
    const brain1 = new Brain(dirA, { ...DEFAULTS, windowTurnLimit: 2, keepTailMessages: 2 });
    const firstMsg = brain1.memory.append('user', '初澜，喜欢安静一点的环境。');
    brain1.memory.append('assistant', '好的呢，我会安静陪伴。');
    brain1.memory.append('user', '初澜，请继续保持安静。');
    brain1.memory.append('assistant', '明白。');

    const mockApi = {
      complete: async () => ({
        text: JSON.stringify({
          windowSynthesis: {
            stableUserFacts: ['偏好安静'],
            subjectExperiences: ['安静陪伴'],
            stateChangesSuggested: [
              {
                trait: 'quiet_preference',
                direction: 1,
                strength: 1.0,
                messageId: firstMsg.messageId,
                quote: '喜欢安静一点的环境'
              }
            ]
          }
        }),
        usage: { total_tokens: 50 }
      })
    };
    brain1.api = mockApi;

    // 注入故障：commit 写入磁盘时失败并抛出异常
    brain1.subjectState.commit = () => false;
    const resA1 = await brain1.closeWindow();
    check('Case A.1: 关窗因 commit 失败返回 false', resA1 === false);
    check('Case A.2: Archive 已可靠落盘 window_archive #1', brain1.experiencesArchive.hasWindowArchive(1));

    // 模拟进程退出与冷重启：新建 Brain 实例
    const brainRestart = new Brain(dirA, { ...DEFAULTS, windowTurnLimit: 2, keepTailMessages: 2 });
    brainRestart.api = mockApi;

    // 检查重启后一致性检测：由于持久化状态落后于归档，自动触发恢复
    check('Case A.3: 重启后自动从归档 Replay 恢复状态至 Window #2', brainRestart.subjectState.currentWindowNo === 2);
    check('Case A.4: 恢复后特质计算正确演化 (+20)', brainRestart.subjectState.values.quiet_preference === 20);

    const archivesA = brainRestart.experiencesArchive.readAll().filter(r => (r.recordType || r.type) === 'window_archive');
    check('Case A.5: 重启恢复未重复制造 window_archive 记录', archivesA.length === 1);

    try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
  }

  // Case B: Archive 文件已有损坏或非法记录 -> 不会误认为成功 archive -> 允许写入合法 archive
  {
    const dirB = tmpDir('fault-b-');
    const archivePath = path.join(dirB, 'experiences.jsonl');
    fs.mkdirSync(dirB, { recursive: true });
    // 写入一条非法/损坏记录（缺少有效 payload）
    fs.writeFileSync(archivePath, JSON.stringify({ recordType: 'window_archive', windowNo: 1, payload: null }) + '\n', 'utf8');

    const archive = new ExperiencesArchive(dirB);
    check('Case B.1: 非法/损坏的 window_archive 记录不会被误判为成功归档', archive.hasWindowArchive(1) === false);

    // 允许合法归档写入覆盖异常状态
    const ok = archive.appendWindowArchive({
      windowNo: 1,
      turns: 10,
      events: [{ eventId: 'evt-001', type: 'message', source: 'user' }]
    });
    check('Case B.2: 合法归档顺利写入，不被旧坏记录永久阻塞', ok === true);
    check('Case B.3: 写入合法归档后 hasWindowArchive(1) 认证通过', archive.hasWindowArchive(1) === true);

    try { fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }

  // Case C: 同一个 closeWindow 连续调用两次 -> 只产生一个逻辑 archive
  {
    const dirC = tmpDir('fault-c-');
    const mockApi = {
      complete: async () => {
        await new Promise(r => setTimeout(r, 20));
        return {
          text: JSON.stringify({
            windowSynthesis: { stableUserFacts: ['活力'], subjectExperiences: [], stateChangesSuggested: [] }
          }),
          usage: { total_tokens: 40 }
        };
      }
    };
    const brainC = new Brain(dirC, { ...DEFAULTS, windowTurnLimit: 2, keepTailMessages: 2 });
    brainC.api = mockApi;
    brainC.memory.append('user', '今天很有活力！');
    brainC.memory.append('assistant', '太好啦！');
    brainC.memory.append('user', '继续保持！');
    brainC.memory.append('assistant', '冲呀！');

    // 连续两次触发 closeWindow
    const [p1, p2] = await Promise.all([brainC.closeWindow(), brainC.closeWindow()]);
    const archivesC = brainC.experiencesArchive.readAll().filter(r => (r.recordType || r.type) === 'window_archive');
    check('Case C.1: 连续调用 closeWindow 经历归档严格仅产生 1 条 window_archive', archivesC.length === 1);
    check('Case C.2: 窗口状态正常收敛', p1 === true || p2 === true);

    try { fs.rmSync(dirC, { recursive: true, force: true }); } catch {}
  }

  // Case D: Recovery 成功，然后再次 closeWindow -> 不重复产生 archive
  {
    const dirD = tmpDir('fault-d-');
    const mockApi = {
      complete: async () => ({
        text: JSON.stringify({
          windowSynthesis: { stableUserFacts: ['安静'], subjectExperiences: [], stateChangesSuggested: [] }
        }),
        usage: { total_tokens: 30 }
      })
    };
    const brainD = new Brain(dirD, { ...DEFAULTS, windowTurnLimit: 2, keepTailMessages: 2 });
    brainD.api = mockApi;
    brainD.memory.append('user', '保持安静。');
    brainD.memory.append('assistant', '收到。');
    brainD.memory.append('user', '继续保持。');
    brainD.memory.append('assistant', '好的。');

    // 第一次关窗 commit 拦截
    brainD.subjectState.commit = () => false;
    await brainD.closeWindow();

    // 触发 recovery
    brainD.subjectState.recoverFromPending(brainD.experiencesArchive, 'test');
    check('Case D.1: Recovery 顺利完成', brainD.subjectState.recoveryPending === false);

    // 恢复正常后再次 closeWindow
    brainD.subjectState.commit = () => true;
    const resD2 = await brainD.closeWindow();
    check('Case D.2: 再次 closeWindow 成功收尾', resD2 === true);

    const archivesD = brainD.experiencesArchive.readAll().filter(r => (r.recordType || r.type) === 'window_archive');
    check('Case D.3: 经历归档绝不重复产生 window_archive', archivesD.length === 1);

    try { fs.rmSync(dirD, { recursive: true, force: true }); } catch {}
  }
}

async function runAll() {
  await testSummaryFailurePreservesDialogue();
  testArchiveCorruptLineSkipping();
  testSubjectStateCorruptionBackup();
  testInFlightPostSnapshotIsolation();
  await testIdempotentRecoveryAndArchive();
  await testFaultInjectionMatrix();

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

runAll();
