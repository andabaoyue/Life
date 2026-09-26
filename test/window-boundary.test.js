/**
 * test/window-boundary.test.js
 * 
 * Life v0.9.6 实验基线强化测试集 1：窗口边界与关闭原因专项测试
 * 
 * 检验点：
 * 1. 窗口满 100 轮正常关窗（closeReason: 'turn_limit'）
 * 2. token 超限提前关窗（closeReason: 'token_limit'）
 * 3. 快照 turn 计数冻结（生成小结期间并发消息不导致计数漂移）
 * 4. bridge 消息隔离（不计入新窗口轮数）
 * 5. closeReason 准确记录于 Memory 与 ExperiencesArchive
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/memory');
const { ExperiencesArchive } = require('../src/experiences-archive');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'window-boundary-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. 标准 100 轮正常关窗与快照指标
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const mem = new Memory(dir, 'test-persona');
  mem.windowTurns = 100;

  for (let i = 1; i <= 100; i++) {
    mem.append('user', `用户发言第${i}轮`);
    mem.append('assistant', `初澜回复第${i}轮`);
  }

  check('100 轮填充后 turnsInWindow 正确达到 100', mem.data.turnsInWindow === 100);
  check('needsWindowReset() 触发判定成立', mem.needsWindowReset() === true);

  const snap = mem.windowSnapshot({ closeReason: 'turn_limit' });
  check('快照冻结 closeReason 为 turn_limit', snap.closeReason === 'turn_limit');
  check('快照冻结 snapshotTurnCount 为 100', snap.snapshotTurnCount === 100);
  check('快照冻结 actualTurnCount 为 100', snap.actualTurnCount === 100);
  check('快照冻结 targetTurnCount 为 100', snap.targetTurnCount === 100);
  check('快照包含当前窗口活跃消息 200 条', snap.snapshotActiveMessageIds.length === 200);

  const ok = mem.closeWindow('第 1 窗口标准小结', snap);
  check('closeWindow 推进成功', ok === true);
  check('新窗口 windowNo 推进至 2', mem.data.windowNo === 2);
  check('新窗口 turnsInWindow 重置为 0', mem.data.turnsInWindow === 0);
  check('最近归档小结 closeReason 记录为 turn_limit', mem.data.windows[0].closeReason === 'turn_limit');
  check('最近归档小结 turnsRecorded 严格为 100', mem.data.windows[0].turns === 100);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 2. Token 超限提前关窗 (token_limit)
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const mem = new Memory(dir, 'test-persona');
  mem.windowTurns = 100;
  mem.memoryCap = 1000; // 较小的 token 预算

  // 写入 63 轮
  for (let i = 1; i <= 63; i++) {
    mem.append('user', `第${i}轮探讨关于时间与知觉的深层哲学问题，提供长文本细节以消耗上下文预算。`);
    mem.append('assistant', `初澜第${i}轮回应，记录详细的反思与记忆。`);
  }

  check('63 轮未达 100 轮轮数限制', mem.data.turnsInWindow === 63);

  const snap = mem.windowSnapshot({ closeReason: 'token_limit' });
  check('token_limit 提前关窗快照标记 closeReason 为 token_limit', snap.closeReason === 'token_limit');
  check('token_limit 快照冻结 actualTurnCount 为 63', snap.actualTurnCount === 63);
  check('token_limit 快照 targetTurnCount 仍为 100', snap.targetTurnCount === 100);

  mem.closeWindow('第 1 窗口提前小结', snap);
  check('提前关窗后 windows 记录 closeReason 为 token_limit', mem.data.windows[0].closeReason === 'token_limit');
  check('提前关窗后 turnsRecorded 严格为 63', mem.data.windows[0].turns === 63);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 3. 快照 turn 计数冻结（并发注入消息防漂移）
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const mem = new Memory(dir, 'test-persona');
  mem.windowTurns = 100;

  for (let i = 1; i <= 100; i++) {
    mem.append('user', `轮次${i}`);
    mem.append('assistant', `回复${i}`);
  }

  // 1. 拍下快照（冻结为 100 轮）
  const snap = mem.windowSnapshot({ closeReason: 'turn_limit' });
  check('快照冻结 snapshotTurnCount 为 100', snap.snapshotTurnCount === 100);

  // 2. 模拟小结 API 生成期间，用户并发发送新消息进历史
  mem.append('user', '生成小结期间进来的并发消息1');
  mem.append('assistant', '并发消息回复1');
  check('并发注入后内存中 live turnsInWindow 增长至 101', mem.data.turnsInWindow === 101);

  // 3. 闭窗落盘
  mem.closeWindow('小结', snap);
  check('关窗归档的 turnsRecorded 严格保留快照值 100 (无漂移)', mem.data.windows[0].turns === 100);
  check('关窗归档的 actualTurnCount 严格保留快照值 100', mem.data.windows[0].actualTurnCount === 100);
  check('并发消息未被误当做已归档', mem.data.turnsInWindow === 1);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 4. Bridge 消息隔离（不计入新窗口轮数）
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const mem = new Memory(dir, { persona: 'test-persona', windowTurns: 5, keepTailMessages: 2 });

  for (let i = 1; i <= 5; i++) {
    mem.append('user', `对话${i}`);
    mem.append('assistant', `回答${i}`);
  }

  const snap = mem.windowSnapshot({ closeReason: 'turn_limit' });
  mem.closeWindow('小结', snap);

  // 默认保留 tail 2 条作为 bridge
  const bridgeMessages = mem.history.filter(m => m.bridge === true);
  check('上一窗口结尾保留 2 条 bridge 消息', bridgeMessages.length === 2);
  check('bridge 消息存在但新窗口 turnsInWindow 严格为 0', mem.data.turnsInWindow === 0);

  // 新发一条真实对话
  mem.append('user', '新窗口的第一句话');
  check('加入新消息后 turnsInWindow 仅递增为 1', mem.data.turnsInWindow === 1);

  // 再次拍摄快照
  const nextSnap = mem.windowSnapshot({ closeReason: 'manual' });
  check('nextSnap 活跃消息列表不包含 bridge 消息', !nextSnap.snapshotActiveMessageIds.includes(bridgeMessages[0].messageId));
  check('nextSnap snapshotTurnCount 严格为 1', nextSnap.snapshotTurnCount === 1);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 5. ExperiencesArchive 正确持久化 closeReason 与 Turn 指标
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const ok = archive.appendWindowArchive({
    windowNo: 1,
    closeReason: 'token_limit',
    targetTurnCount: 100,
    actualTurnCount: 42,
    turns: 42,
    messageCount: 84,
    segments: [
      {
        range: '1-42',
        userGiven: ['用户探索边界'],
        chulanExperience: ['初澜记录不完整窗口'],
        stateEvidence: [],
        uncertainties: []
      }
    ],
    windowSynthesis: {
      stableUserFacts: ['用户探索边界'],
      subjectExperiences: ['初澜记录不完整窗口'],
      stateChangesSuggested: []
    }
  });

  check('Archive 成功写入 token_limit 归档', ok === true);
  const recs = archive.getByWindow(1);
  check('检索出窗口 1 归档记录', recs.length === 1);
  const payload = recs[0].payload || recs[0];
  check('Archive payload 保留 closeReason 为 token_limit', payload.closeReason === 'token_limit');
  check('Archive payload 保留 actualTurnCount 为 42', payload.actualTurnCount === 42);
  check('Archive payload 保留 targetTurnCount 为 100', payload.targetTurnCount === 100);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
