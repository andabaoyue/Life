/* test/life-will-layer.test.js
 * 「意志层」补全门禁（Phase 1）：
 * 1A 好奇驱动提问（轻版）——未解疑问 FIFO 队列进心智视野，只在关窗成功后更新、反骚扰闩在块内；
 * 1B 性格驱动主动性——initiativeBias 有界权重只调意愿阈值，冷却 / 刹车 / 睡眠闸门不可绕过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { Memory } = require('../src/memory');

/* ---------- 1A: 好奇驱动提问（轻版） ---------- */
const mkMem = () => {
  const m = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'will-mem-')), { windowTurns: 999 });
  m.persona = '人格文本';
  m.wardrobe = '【当前穿着】\n- 外套：落肩白色外套';
  return m;
};
const wm = mkMem();
check('1A 疑问队列 FIFO 上限 5 且顺序保持', (() => {
  for (let i = 1; i <= 7; i++) wm.refreshCuriosity(['疑问' + i], i);
  const q = wm.data.curiosityQueue;
  return q.length === 5 && q[0].q === '疑问3' && q[4].q === '疑问7' && q[4].windowNo === 7;
})());
const sysQ = wm.systemText();
check('1A 疑问块含反骚扰闩（一次最多一个、绝不连环审问）',
  sysQ.includes('【尚未解开的疑问】') && sysQ.includes('一次最多一个') && sysQ.includes('绝不连环审问'));
check('1A 无疑问时零注入（向下兼容）', !mkMem().systemText().includes('【尚未解开的疑问】'));

/* ---------- 1B: 性格驱动主动性 ---------- */
const { TriggerEngine, computeInitiativeBias } = require('../src/trigger');
check('1B initiativeBias 中立为 1.0、方向正确、有界', (() => {
  const n = computeInitiativeBias({});
  const hi = computeInitiativeBias({ attachment_need: 300, social_initiative: 300 });
  const lo = computeInitiativeBias({ quiet_preference: 300 });
  return n === 1 && hi > 1 && hi <= 1.5 && lo < 1 && lo >= 0.5;
})());
const mkTracker = (clicks, idleMs) => ({
  sleepMode: false,
  spokenDuringIdle: false,
  lastInteractionAt: 1000000 - idleMs,
  recentClicks: () => clicks
});
check('1B 高依恋降低意愿阈值（4 戳即应答），默认仍 5 戳', (() => {
  const t1 = new TriggerEngine(mkTracker(4, 0), { now: () => 1000000, traits: { attachment_need: 300 } });
  const t2 = new TriggerEngine(mkTracker(4, 0), { now: () => 1000000, traits: {} });
  return t1.evaluate() !== null && t2.evaluate() === null;
})());
check('1B 冷却铁律不可绕过（最大 bias 也受冷却管）', (() => {
  const t = new TriggerEngine(mkTracker(50, 0), { now: () => 1000000, traits: { attachment_need: 999 } });
  t.lastFiredAt = 999000;
  return t.evaluate() === null;
})());
check('1B 默认参数与既有常量完全一致（5 戳 / 30 分钟）', (() => {
  const t = new TriggerEngine(mkTracker(0, 29 * 60000), { now: () => 1000000 });
  const t2 = new TriggerEngine(mkTracker(0, 31 * 60000), { now: () => 1000000 });
  const r1 = t.evaluate();
  const r2 = t2.evaluate();
  return r1 === null && r2 !== null && r2.kind === 'idle';
})());

(async () => {
  const { Brain } = require('../src/brain');
  const mkWillBrain = () => {
    const bb = new Brain(fs.mkdtempSync(path.join(os.tmpdir(), 'will-brain-')), {
      apiKey: 'sk-test', model: 'mock', windowTurns: 2, windowMaxTokens: 1e9,
      keepTailMessages: 6, memoryCapTokens: 1e9, selfGrowthEnabled: false,
      summaryMaxTokens: 10000, price: { peak: {}, valley: {} }
    });
    bb.memory.append('user', '一', { messageId: 'm-000001', roundNo: 1 });
    bb.memory.append('assistant', '二', { messageId: 'm-000002', roundNo: 1 });
    bb.memory.append('user', '三', { messageId: 'm-000003', roundNo: 2 });
    bb.memory.append('assistant', '四', { messageId: 'm-000004', roundNo: 2 });
    return bb;
  };
  const mkSummary = (unresolved) => JSON.stringify({
    segments: [{ range: '1-2', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] }],
    windowSynthesis: { stableUserFacts: [], subjectExperiences: [], stateChangesSuggested: [], unresolved }
  });

  // 失败关窗不污染队列：契约违规 Fail-Stop → 队列保持为空
  const wFail = mkWillBrain();
  wFail.api = { complete: async () => ({ text: JSON.stringify({ segments: 'x' }), usage: {} }) };
  await wFail.closeWindow();
  check('1A 疑问只在关窗成功后入队（失败关窗不污染队列）', wFail.memory.data.curiosityQueue.length === 0);

  // 成功关窗带 unresolved → 入队（带 windowNo 引证）
  const wOk = mkWillBrain();
  wOk.api = { complete: async () => ({ text: mkSummary(['雨停了吗', '那个约定后来怎样']), usage: {} }) };
  const done = await wOk.closeWindow();
  const q2 = wOk.memory.data.curiosityQueue;
  check('1A 关窗成功后未解疑问入队（含引证）且渲染进视野',
    done === true && q2.length === 2 && q2[0].q === '雨停了吗' && q2[0].windowNo === 1
    && wOk.memory.systemText().includes('雨停了吗'));

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
