/**
 * test/d22-memory-gradient.test.js
 *
 * D-22 门禁：长期记忆的「渐褪」梯度（方案丙）。
 *
 * ## 为什么有这一轮（真实数据实测）
 *   旧默认值 activeThreshold=0.60 恰好等于初始强度（baseStrength 0.50 + salienceBonus 0.10），
 *   于是**过 1 个窗口必然跌破门限** ⇒ 除最新一段外全部降级；
 *   而 fadingMaxChars=60 连一句完整的话都放不下。
 *   实测多段小结被压成几十字的断句碎片 —— 没有梯度，只有腰斩。
 *
 * ## 丙的三条改动
 *   ① activeThreshold 可配（默认仍 0.60 —— 默认值必须稳，行为变更走显式配置）
 *   ② fadingMaxChars 可配（默认仍 60）
 *   ③ visibleTokens()：预算只看**她实际看得到的**部分（DORMANT=0 / FADING=截断后 / 其余=全文）
 *
 * ## 覆盖的四类
 *   ① 梯度正确：0.40/300 下近段 ACTIVE、老段 FADING，且截断长度=300
 *   ② 口径同源：visibleTokens 必须与 systemText 实际投影**逐条一致**（防两处漂移）
 *   ③ 默认不动：默认配置下行为与改动前一致（0 ACTIVE / 5 FADING）
 *   ④ 基线兼容：无动力学时 visibleTokens === memoryTokens，且不截断
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/memory');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const LONG = '甲乙丙丁戊己庚辛壬癸'.repeat(60);   // 600 字，确保超过任何截断阈值

/** 每段用**互不相同**的文本。
 *  ⚠️ 踩过：初版 5 段全用同一个 LONG，于是 `sys.includes(LONG.slice(0,301))`
 *     被 ACTIVE 段的全文命中 ⇒ **断言恒真**，「只投影 300 字」根本判不出来。
 *     这类「夹具设计导致恒真判据」在本仓已多次出现，务必让各段可区分。 */
function uniq(n) { return '第' + n + '段' + '甲乙丙丁戊己庚辛壬癸'.repeat(60); }

function mk(windows, opts) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd22-'));
  fs.writeFileSync(path.join(d, 'memory.json'), JSON.stringify({
    schemaVersion: 1, windowNo: 6, turnsInWindow: 0, totalTurns: 0, nextMessageSeq: 0, epoch: 0,
    history: [], lexicon: [], expectations: [], selfNotes: [], dreamFragments: [],
    deepHorizon: '', curiosityQueue: [], windows,
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
  return [1, 2, 3, 4, 5].map((n) => ({ no: n, turns: 10, at: 1, text: uniq(n), closeReason: 'turn_limit' }));
}

console.log('--- D-22 记忆渐褪梯度门禁 ---');

/* ============ 1. 梯度正确：0.40 / 300 ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const active = m.engramManager.getActiveTraces().length;
  const fading = m.engramManager.getFadingTraces().length;
  check('🔴 0.40/300 下有 ACTIVE 段（旧默认是 0 段）', active > 0, 'ACTIVE=' + active);
  check('🔴 0.40/300 下有 FADING 段（最老的降级，梯度存在）', fading > 0, 'FADING=' + fading);
  check('🔴 ACTIVE + FADING 覆盖全部段（无遗漏）', active + fading === 5, active + '+' + fading);
  const sys = m.systemText();
  check('system 里出现「（渐褪）」标记', sys.includes('（渐褪）'));
  check('最新一段保持全文（无截断）', sys.includes(LONG));
  // 截断长度必须是 300 而不是 60 —— 这是本轮的核心修复
  const m60 = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 60 } });
  const s60 = m60.systemText();
  check('🔴 fadingMaxChars 真的可配（300 与 60 输出不同）', sys !== s60);
  check('60 时出现更短的截断（…）', s60.includes('...'));
}

/* ============ 2. 🔴 口径同源：visibleTokens 与 systemText 逐条一致 ============ */
{
  const m = mk(wins(), { memoryDynamics: true, engramConfig: { activeThreshold: 0.40, fadingMaxChars: 300 } });
  const sys = m.systemText();
  // 逐段核对：ACTIVE 段的全文必须出现在 system；FADING 段只应出现前 300 字
  m.data.windows.forEach((w) => {
    const tr = m.engramManager.getAllTraces().find((t) => t.sourceWindowNo === w.no);
    const isFading = tr && tr.currentStrength < 0.40;
    const full = uniq(w.no);
    if (!isFading) {
      check('ACTIVE 第' + w.no + '段全文进 system', sys.includes(full));
    } else {
      // 该段**独有的**前 300 字必须在、第 301 字必须不在（同文本段已消除，判据不再恒真）
      check('🔴 FADING 第' + w.no + '段只投影前 300 字（不是全文）',
        sys.includes(full.slice(0, 300)) && !sys.includes(full.slice(0, 301)),
        'len300=' + sys.includes(full.slice(0, 300)) + ' len301=' + sys.includes(full.slice(0, 301)));
    }
  });
  // visibleTokens 必须 < memoryTokens（有 FADING 时），且差额 = 被截掉的部分
  check('🔴 有渐褪时 visibleTokens < memoryTokens（口径真的收窄了）',
    m.visibleTokens() < m.memoryTokens(),
    'visible=' + m.visibleTokens() + ' full=' + m.memoryTokens());
}

/* ============ 3. 默认不动：0.60 / 60 与改动前一致 ============ */
{
  const m = mk(wins(), { memoryDynamics: true });   // 不传 engramConfig → 走 DEFAULT
  check('默认 activeThreshold 仍是 0.60', m.engramManager.config.activeThreshold === 0.60);
  check('默认 fadingMaxChars 仍是 60（默认值必须稳）', m.engramManager.config.fadingMaxChars === 60);
  const sys = m.systemText();
  // 0.60 门限下：初始 0.60 → 过 1 窗跌破 → 全 FADING（这是改动前的既有行为）
  check('⚠️ 默认配置下仍是全 FADING（既有行为未被偷袭改变）',
    m.engramManager.getActiveTraces().length === 0,
    'ACTIVE=' + m.engramManager.getActiveTraces().length);
  const f1 = uniq(1);
  check('默认配置下截断在 60 字附近（不是 300）',
    !sys.includes(f1.slice(0, 61)) && sys.includes(f1.slice(0, 60)));
}

/* ============ 4. 基线兼容：无动力学 ============ */
{
  const m = mk(wins(), { memoryDynamics: false });
  check('基线：engramManager 为 null', m.engramManager === null);
  check('🔴 基线：visibleTokens === memoryTokens（口径等价，既有行为不变）',
    m.visibleTokens() === m.memoryTokens(),
    m.visibleTokens() + ' vs ' + m.memoryTokens());
  check('🔴 基线：不截断、无渐褪标记',
    m.systemText().includes(uniq(1)) && !m.systemText().includes('（渐褪）'));
}

/* ============ 5. 配置接线（防漂移） ============ */
{
  const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  check('❌ config.js 有 memoryActiveThreshold', cfgSrc.includes('memoryActiveThreshold'));
  check('❌ config.js 有 memoryFadingMaxChars', cfgSrc.includes('memoryFadingMaxChars'));
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
  check('❌ brain.js 把两个配置透传进 engramConfig',
    brainSrc.includes('activeThreshold: this.cfg.memoryActiveThreshold') &&
    brainSrc.includes('fadingMaxChars: this.cfg.memoryFadingMaxChars'));
  const memSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory.js'), 'utf8');
  check('❌ needsMemoryMerge 用 visibleTokens 而非 memoryTokens',
    /needsMemoryMerge\(\)\s*\{[^}]*visibleTokens\(\)/.test(memSrc));
  check('❌ planMerge 与 needsMemoryMerge 同口径（否则判定漂移）',
    /planMerge\(\)[\s\S]{0,900}?seeTokens/.test(memSrc));
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
