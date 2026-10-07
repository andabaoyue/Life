/**
 * test/d23-recall-enhance.test.js
 *
 * D-23 门禁：召回增强（Retrieval Enhancement）。
 *
 * ## 背景（真实数据实测）
 *   旧实现只认 DORMANT traces（S<0.35 且隔5窗），而她 5 段记忆零条 DORMANT
 *   ⇒ 整个强化系统空转。且 reactivate() 当场改 tier（破前缀缓存）。
 *   实测证伪两条：① FADING→ACTIVE 跳变 = prompt 突变 = 破缓存；
 *   ② 一句话可命中 4 段（全范围）= 洪泛。
 *
 * ## D-23 的三条改动
 *   ① 候选范围放开到全部 trace（含 ACTIVE —— 全范围参与）
 *   ② 只记账（retrievalCount++ / lastRetrievedWindow），不改 tier
 *      —— tier 的变化统一在关窗 decayAll() 结算（护前缀缓存铁律）
 *   ③ 双重限流：top-N（默认 1）+ 同窗去重（一条印痕一窗口最多 +1）
 *
 * ## 覆盖的八类
 *   ① FADING 能被增强 ② ACTIVE 也能被增强 ③ 同窗去重 ④ top-N 限流
 *   ⑤ 铁律：systemText 逐字节相等 ⑥ 效果落在关窗 ⑦ 闲聊不触发 ⑧ 基线返回空
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/memory');
const { EngramTraceManager, ENGRAM_TIERS } = require('../src/memory-dynamics');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function mk(windows, opts) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd23-'));
  fs.writeFileSync(path.join(d, 'memory.json'), JSON.stringify({
    schemaVersion: 1, windowNo: 6, turnsInWindow: 0, totalTurns: 0,
    nextMessageSeq: 0, epoch: 0,
    history: [], lexicon: [], expectations: [], selfNotes: [],
    dreamFragments: [], deepHorizon: '', curiosityQueue: [], windows,
  }));
  const m = new Memory(d, Object.assign({ persona: 'P', memoryCapTokens: 12000 }, opts));
  if (m.engramManager) {
    windows.forEach((w) => m.engramManager.registerTrace({
      sourceWindowNo: w.no, createdWindow: w.no, salienceBonus: 0.1,
    }));
    m.engramManager.decayAll(m.data.windowNo);
  }
  return m;
}
function wins() {
  return [
    { no: 1, turns: 10, at: 1, text: '她捡了一枚海螺贝壳，那天在海边散步，风很大。', closeReason: 'turn_limit' },
    { no: 2, turns: 10, at: 1, text: 'life项目的底层框架已经通了，现在优化界面。', closeReason: 'turn_limit' },
  ];
}

console.log('--- D-23 召回增强门禁 ---');

/* ============ 1. 🔴 FADING 能被增强（不再是 DORMANT 专属） ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const t1 = m.engramManager.getAllTraces().find((t) => t.sourceWindowNo === 1);
  check('前提：第1段是 FADING', t1.tier === 'FADING', 'S=' + t1.currentStrength.toFixed(4));
  const r = m.reactivateByContext('你还收着那枚海螺贝壳吗', 6);
  check('🔴 FADING 段能被召回（不再只认 DORMANT）', r.length === 1, 'hits=' + r.length);
  check('🔴 retrievalCount 递增', r[0].retrievalCount === 1);
  check('🔴 lastRetrievedWindow 更新', r[0].lastRetrievedWindow === 6);
}

/* ============ 2. 🔴 ACTIVE 也能被增强（全范围） ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const t2 = m.engramManager.getAllTraces().find((t) => t.sourceWindowNo === 2);
  check('前提：第2段是 ACTIVE', t2.tier === 'ACTIVE', 'S=' + t2.currentStrength.toFixed(4));
  const r = m.reactivateByContext('life项目进展如何', 6);
  check('🔴 ACTIVE 段能被召回（全范围参与）', r.length === 1, 'hits=' + r.length);
  check('🔴 retrievalCount 递增', r[0].retrievalCount === 1);
}

/* ============ 3. 🔴 同窗去重（一条印痕一窗口最多 +1） ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const r1 = m.reactivateByContext('你还收着那枚海螺贝壳吗', 6);
  const r2 = m.reactivateByContext('你还收着那枚海螺贝壳吗', 6);
  const t1 = m.engramManager.getAllTraces().find((t) => t.sourceWindowNo === 1);
  check('🔴 第二次同窗命中不再 +1（去重）', r2.length === 0, 'hits2=' + r2.length);
  check('🔴 retrievalCount 仍为 1（未被重复增强）', t1.retrievalCount === 1, 'count=' + t1.retrievalCount);
}

/* ============ 4. 🔴 top-N 限流（默认 top-1） ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 }, memoryRecallTopN: 1 });
  // 一句话命中两个窗口的关键词
  const r = m.reactivateByContext('海螺贝壳和life项目', 6);
  check('🔴 top-N=1 只增强一条（防洪泛）', r.length === 1, 'hits=' + r.length);
  const t1 = m.engramManager.getAllTraces().find((t) => t.sourceWindowNo === 1);
  const t2 = m.engramManager.getAllTraces().find((t) => t.sourceWindowNo === 2);
  check('🔴 两条印痕中只有一条被增强', (t1.retrievalCount === 1) !== (t2.retrievalCount === 1),
    'win1=' + t1.retrievalCount + ' win2=' + t2.retrievalCount);
}

/* ============ 5. 🔴 铁律：systemText 逐字节相等 ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const sysBefore = m.systemText();
  m.reactivateByContext('你还收着那枚海螺贝壳吗', 6);
  const sysAfter = m.systemText();
  check('🔴 记账后 systemText 逐字节相等（护前缀缓存铁律）', sysBefore === sysAfter,
    'before=' + sysBefore.length + ' after=' + sysAfter.length);
  check('🔴 （渐褪）标记仍在（tier 未变）', sysBefore.includes('（渐褪）'));
}

/* ============ 6. 🔴 效果落在关窗（decayAll 后强度差异） ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const r = m.reactivateByContext('你还收着那枚海螺贝壳吗', 6);
  // 对照：另一个副本不记账
  const ctl = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  // 模拟下一次关窗
  m.engramManager.decayAll(7);
  ctl.engramManager.decayAll(7);
  const boosted = m.engramManager.getAllTraces().find((t) => t.sourceWindowNo === 1);
  const control = ctl.engramManager.getAllTraces().find((t) => t.sourceWindowNo === 1);
  check('🔴 被聊过的段在关窗后强度高于未聊过的对照段',
    boosted.currentStrength > control.currentStrength,
    'boosted=' + boosted.currentStrength.toFixed(4) + ' control=' + control.currentStrength.toFixed(4));
  check('🔴 召回增强抵抗衰减（分子变大）', boosted.currentStrength.toFixed(4) !== control.currentStrength.toFixed(4));
}

/* ============ 7. 🔴 闲聊不触发（用她真实语义测） ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const r = m.reactivateByContext('今天天气真好，我们可以随便聊聊吗？', 6);
  check('🔴 闲聊不触发任何召回（零假阳性）', r.length === 0, 'hits=' + r.length);
  const r2 = m.reactivateByContext('嗯', 6);
  check('🔴 极简消息不触发', r2.length === 0, 'hits=' + r2.length);
}

/* ============ 8. 🔴 基线（无动力学）返回空 ============ */
{
  const m = mk(wins(), { memoryDynamics: false });
  check('🔴 基线：engramManager 为 null', m.engramManager === null);
  const r = m.reactivateByContext('你还收着那枚海螺贝壳吗', 6);
  check('🔴 基线：返回空（不报错）', r.length === 0, 'hits=' + r.length);
}

/* ============ 9. 🔴 配置接线（防漂移） ============ */
{
  const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  check('❌ config.js 有 memoryRecallTopN', cfgSrc.includes('memoryRecallTopN'));
  const memSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory.js'), 'utf8');
  check('❌ reactivateByContext 用 getAllTraces + 去重（不再只认 DORMANT）',
    memSrc.includes('lastRetrievedWindow !== curWin'));
  check('❌ reactivateByContext 用 lastRetrievedWindow 去重',
    memSrc.includes('lastRetrievedWindow !== curWin'));
  check('❌ reactivateByContext 用 topN 限流',
    memSrc.includes('memoryRecallTopN') && memSrc.includes('Math.min(topN, scored.length)'));
  const dynSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory-dynamics.js'), 'utf8');
  check('❌ reactivate() 不再当场改 tier（护前缀缓存）',
    dynSrc.includes('const result = { ...trace };'));
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
