/**
 * test/research-window-defaults.test.js
 * 
 * 初澜数字生命实验：Window 默认值与 Window 0 边界无损保留专项测试 (P0-11)
 * 
 * 核心验证：
 * 1. 记录缺失 windowNo 时，查询结果绝不隐式补填为 1 (保持 windowNo: null)
 * 2. windowNo = 0 时，绝对不触发 0 || 1 假值降级 (严格保持 windowNo: 0)
 * 3. getWindowDetail(0) 必须能精确查到 Window 0，不能被当作 falsy 回退到 Window 1 或 null
 * 4. getWindowRounds(0) 必须能获取 Window 0 的轮次数据
 * 5. search() 搜索结果必须准确保留 windowNo: 0 与 windowNo: null，绝不默认补填为 1
 * 6. getStateTrajectory() 演化轨迹严格保留 windowNo: 0 与 windowNo: null
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchQuery } = require('../src/research-query');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'win-defaults-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Elimination of Window Defaults and Zero Retention (P0-11) ---');

const dir = tmpDir();
const archivePath = path.join(dir, 'experiences.jsonl');
const statePath = path.join(dir, 'subject-state.json');

// 准备测试数据：
// 记录 1: 无 windowNo，包含 turns: 7, messageCount: 14
const recNoWindow = {
  recordType: 'window_summary',
  canonicalSchema: 'v1',
  timestamp: 1000,
  payload: {
    turns: 7,
    messageCount: 14,
    events: [
      { eventId: 'ev-no-win', type: 'message', source: 'user', content: 'test unassigned message' }
    ],
    observations: [],
    interpretations: [],
    segments: [],
    verifiedEvidence: [
      { evidenceId: 'evi-no-win', trait: 'quiet_preference', delta: 2, quote: 'unassigned quote' }
    ],
    rejectedEvidence: [],
    stateChanges: [
      { stateChangeId: 'sc-no-win', trait: 'quiet_preference', delta: 2, previousValue: 0, newValue: 2 }
    ]
  }
};

// 记录 2: windowNo: 0，包含 turns: 5, messageCount: 10
const recWindowZero = {
  recordType: 'window_summary',
  canonicalSchema: 'v1',
  timestamp: 2000,
  windowNo: 0,
  payload: {
    turns: 5,
    messageCount: 10,
    events: [
      { eventId: 'ev-win-0', type: 'message', source: 'user', content: 'window zero event', roundNo: 1 }
    ],
    observations: [],
    interpretations: [],
    segments: [],
    verifiedEvidence: [
      { evidenceId: 'evi-win-0', trait: 'vitality', delta: 3, quote: 'zero quote' }
    ],
    rejectedEvidence: [],
    stateChanges: [
      { stateChangeId: 'sc-win-0', windowNo: 0, trait: 'vitality', delta: 3, previousValue: 0, newValue: 3 }
    ]
  }
};

// 记录 3: windowNo: 1，正常窗口 1
const recWindowOne = {
  recordType: 'window_summary',
  canonicalSchema: 'v1',
  timestamp: 3000,
  windowNo: 1,
  payload: {
    turns: 20,
    messageCount: 40,
    events: [
      { eventId: 'ev-win-1', type: 'message', source: 'user', content: 'window one event', roundNo: 1 }
    ],
    observations: [],
    interpretations: [],
    segments: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};

fs.writeFileSync(archivePath, [
  JSON.stringify(recNoWindow),
  JSON.stringify(recWindowZero),
  JSON.stringify(recWindowOne)
].join('\n') + '\n', 'utf8');

fs.writeFileSync(statePath, JSON.stringify({
  version: 1,
  currentState: { quiet_preference: 2, vitality: 3, social_initiative: 0, attachment_need: 0, philosophical_curiosity: 0 },
  history: []
}), 'utf8');

const query = new ResearchQuery(dir);

// -----------------------------------------------------------------------------
// 1. getWindows() 测试：缺失 windowNo 绝不补填为 1，windowNo = 0 严格保留为 0
// -----------------------------------------------------------------------------
const windowsRes = query.getWindows();
const items = windowsRes.items;

const nullWin = items.find(w => w.windowNo === null);
check('1.1: 存在 windowNo 为 null 的未分配窗口', !!nullWin);
check('1.2: 未分配窗口 turns 精确为 7', nullWin && nullWin.turns === 7);
check('1.3: 未分配窗口 messageCount 精确为 14', nullWin && nullWin.messageCount === 14);
check('1.4: 未分配窗口状态标记为 UNRESOLVED', nullWin && nullWin.status === 'UNRESOLVED');

const zeroWin = items.find(w => w.windowNo === 0);
check('2.1: 存在 windowNo 为 0 的独立窗口 (未被 0 || 1 降级)', !!zeroWin);
check('2.2: Window 0 的 turns 精确为 5', zeroWin && zeroWin.turns === 5);
check('2.3: Window 0 的 messageCount 精确为 10', zeroWin && zeroWin.messageCount === 10);
check('2.4: Window 0 的 windowNo 严格等于 0', zeroWin && zeroWin.windowNo === 0);

const oneWin = items.find(w => w.windowNo === 1);
check('2.5: Window 1 存在且未与 Window 0 混淆', !!oneWin);
check('2.6: Window 1 的 turns 精确为 20 (非 7 或 5)', oneWin && oneWin.turns === 20);

// -----------------------------------------------------------------------------
// 2. getWindowDetail(0) 测试：精确检索 Window 0，绝不回退
// -----------------------------------------------------------------------------
const detailZero = query.getWindowDetail(0);
check('3.1: getWindowDetail(0) 成功返回 Window 0 详情', !!detailZero);
check('3.2: getWindowDetail(0) 的 windowNo 严格为 0', detailZero && detailZero.windowNo === 0);
check('3.3: getWindowDetail(0) 的 turns 准确为 5', detailZero && detailZero.turns === 5);
check('3.4: getWindowDetail(0) 的 messageCount 准确为 10', detailZero && detailZero.messageCount === 10);
check('3.5: getWindowDetail(0) 正确包含 ev-win-0 事件', detailZero && detailZero.events && detailZero.events.some(e => e.eventId === 'ev-win-0'));

// -----------------------------------------------------------------------------
// 3. getWindowDetail(null) 测试：检索未分配记录
// -----------------------------------------------------------------------------
const detailNull = query.getWindowDetail(null);
check('3.6: getWindowDetail(null) 成功返回未分配窗口详情', !!detailNull);
check('3.7: getWindowDetail(null) 的 windowNo 为 null', detailNull && detailNull.windowNo === null);
check('3.8: getWindowDetail(null) 包含 ev-no-win 事件', detailNull && detailNull.events && detailNull.events.some(e => e.eventId === 'ev-no-win'));

// -----------------------------------------------------------------------------
// 4. getWindowRounds(0) 测试：成功检索 Window 0 轮次
// -----------------------------------------------------------------------------
const roundsZero = query.getWindowRounds(0);
check('4.1: getWindowRounds(0) 成功返回轮次数组', Array.isArray(roundsZero) && roundsZero.length > 0);
const r1Zero = roundsZero.find(r => r.roundNo === 1);
check('4.2: Window 0 的第 1 轮正确包含 window zero event 消息', r1Zero && ((r1Zero.userMessage && r1Zero.userMessage.content === 'window zero event') || (r1Zero.assistantMessage && r1Zero.assistantMessage.content === 'window zero event')));

// -----------------------------------------------------------------------------
// 5. search() 检索结果保留 windowNo: 0 与 windowNo: null (P0-11)
// -----------------------------------------------------------------------------
const searchZero = query.search('window zero event');
check('5.1: 搜索 Window 0 内容命中事件', searchZero.items && searchZero.items.length > 0);
const zeroSearchItem = searchZero.items.find(it => it.id === 'ev-win-0');
check('5.2: 搜索命中项精确保留 windowNo === 0', zeroSearchItem && zeroSearchItem.windowNo === 0);
check('5.3: 搜索命中项绝对未被隐式补填为 1', zeroSearchItem && zeroSearchItem.windowNo !== 1);

const searchNoWin = query.search('test unassigned message');
check('5.4: 搜索未分配内容命中事件', searchNoWin.items && searchNoWin.items.length > 0);
const noWinSearchItem = searchNoWin.items.find(it => it.id === 'ev-no-win');
check('5.5: 搜索未分配命中项精确保留 windowNo === null', noWinSearchItem && noWinSearchItem.windowNo === null);

// -----------------------------------------------------------------------------
// 6. getStateTrajectory() 演化轨迹严格保留 windowNo: 0 与 null
// -----------------------------------------------------------------------------
const trajectory = query.getStateTrajectory();
const scZero = trajectory.find(sc => sc.stateChangeId === 'sc-win-0');
check('6.1: 轨迹中 sc-win-0 的 windowNo 严格保留为 0', scZero && scZero.windowNo === 0);
const scNull = trajectory.find(sc => sc.stateChangeId === 'sc-no-win');
check('6.2: 轨迹中 sc-no-win 的 windowNo 严格保留为 null', scNull && scNull.windowNo === null);

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
