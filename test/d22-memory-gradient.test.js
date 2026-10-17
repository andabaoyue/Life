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

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
const _d22Dirs = [];
const _d22OrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d22OrigMkdtemp.apply(fs, a);
  _d22Dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d22Dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d22OrigMkdtemp;
});

const { Memory, estimateTokens, truncateFadingText } = require('../src/memory');

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

/* ============ 6. v1.2.x 句界优雅截断与三同源锁定 ============ */
{
  check('v1.2.x: truncateFadingText 纯函数导出正常', typeof truncateFadingText === 'function');

  // 1. 无标点严格回退断言（DSH 审查条件 1：严格 === 恒等）
  const noPunct60 = '甲乙丙丁戊己庚辛壬癸'.repeat(10);
  check('v1.2.x: 无标点文本 cap=60 严格回退 slice(0, 60) + "..."',
    truncateFadingText(noPunct60, 60) === noPunct60.slice(0, 60) + '...');
  const noPunct300 = '甲乙丙丁戊己庚辛壬癸'.repeat(40);
  check('v1.2.x: 无标点文本 cap=300 严格回退 slice(0, 300) + "..."',
    truncateFadingText(noPunct300, 300) === noPunct300.slice(0, 300) + '...');

  // 2. 短文本不变式
  const shortText = '短文本未超过 cap';
  check('v1.2.x: 短文本 <= cap 原样返回不追加省略号',
    truncateFadingText(shortText, 60) === shortText);

  // 3. 有标点句界截断（DSH 审查条件 2：标点截断在终结符处，且截断体 <= cap，总长 <= cap + 3）
  const punct60 = '初澜今天在窗边看雨，雨丝很细很轻，打湿了屋檐。她想起了一首很久以前听过的老歌，旋律非常温柔；窗外的风渐渐大了起来，树叶沙沙作响。';
  const res60 = truncateFadingText(punct60, 60);
  check('v1.2.x: 有标点 cap=60 在句界处优雅截断且 <= 63 字',
    res60.endsWith('；...') && res60.length <= 63 && res60.slice(0, -3).length <= 60);

  const pChunk = '初澜在书房整理笔记。窗外是一整片冰蓝色的晨光，微风吹拂着窗纱！';
  const punct300 = pChunk.repeat(7) + '最后一段日记写于午后，阳光正好，初澜泡了一杯红茶，心情格外宁静。' + '后续超长文字'.repeat(20);
  const res300 = truncateFadingText(punct300, 300);
  check('v1.2.x: 有标点 cap=300 在句界处优雅截断且 <= 303 字',
    res300.endsWith('。...') && res300.length <= 303 && res300.slice(0, -3).length <= 300);

  // 4. 版本号与浮点数小数点防御（DSH 审查条件 2：不得误伤 v1.2 / 3.14）
  const verText = '初澜正在评估系统版本 v1.2 以及圆周率近似值 3.1415926 的计算精度。所有记录均保持完整并继续推进。';
  const resVer = truncateFadingText(verText, 35);
  check('v1.2.x: 版本号/浮点数的小数点不被误当句界截断',
    resVer === verText.slice(0, 35) + '...' && !resVer.endsWith('v1....') && !resVer.endsWith('3....'));

  // 5. 三同源点强断言锁定（DSH 审查条件 3：visibleTokens、systemText、planMerge 逐字/逐 token 一致）
  const punctWins = [
    { no: 1, turns: 10, at: 1, text: punct60, closeReason: 'turn_limit' },
    { no: 2, turns: 10, at: 2, text: '第二段较短。', closeReason: 'turn_limit' }
  ];
  const mPunct = mk(punctWins, { memoryDynamics: true, engramConfig: { activeThreshold: 0.99, fadingMaxChars: 60 } });
  const sysPunct = mPunct.systemText();
  const expectedTruncated = truncateFadingText(punct60, 60);
  check('v1.2.x: 三同源点 1&2 锁定：systemText 实际投影与 truncateFadingText 完全一致',
    sysPunct.includes(expectedTruncated));

  const fadingNos = new Set(mPunct.engramManager.getFadingTraces().map((t) => t.sourceWindowNo));
  let expectedSumTokens = 0;
  for (const w of mPunct.data.windows) {
    const full = String(w.text || '');
    if (fadingNos.has(w.no) && full.length > 60) {
      expectedSumTokens += estimateTokens(truncateFadingText(full, 60));
    } else {
      expectedSumTokens += estimateTokens(full);
    }
  }
  check('v1.2.x: 三同源点 1&3 锁定：visibleTokens 与 estimateTokens(truncateFadingText) 精确一致',
    mPunct.visibleTokens() === expectedSumTokens,
    mPunct.visibleTokens() + ' vs ' + expectedSumTokens);

  // 🔴 判别力补齐（DSH 审计）：旧的「planMerge 单条预算口径」两条恒真 ——
  //   两边是**同一次调用**的结果（expectedTruncated 就是 truncateFadingText(punct60,60)），
  //   根本没触及 planMerge 的 seeTokens。改为真的调 planMerge() 并核对切分点。
  //   夹具设计同理：必须让「三处同源」任一处漂移都会改变可观测输出，否则断言无判别力。
  const tokensTrunc = estimateTokens(truncateFadingText(punct60, 60));
  const tokensFull  = estimateTokens(punct60);
  check('v1.2.x: 截断确实改变了 token 记账（判别力前提）', tokensTrunc !== tokensFull,
    tokensTrunc + ' vs ' + tokensFull);

  // planMerge 真调用：预算压到「只装得下一段」时，切分点必须与 seeTokens 口径一致
  const mMerge = mk(punctWins, {
    memoryDynamics: true,
    engramConfig: { activeThreshold: 0.99, fadingMaxChars: 60 },
    memoryCapTokens: 1,
  });
  const plan = mMerge.planMerge();
  const fadingSet = new Set(mMerge.engramManager.getFadingTraces().map((t) => t.sourceWindowNo));
  // 切分点之前（更旧的）应全是 FADING 段；若 planMerge 误用全原文口径，切分点会偏
  const expectedSee = punctWins.reduce((sum, w) => {
    const full = String(w.text || '');
    return sum + (fadingSet.has(w.no) && full.length > 60
      ? estimateTokens(truncateFadingText(full, 60)) : estimateTokens(full));
  }, 0);
  // 切分点必须真的动了：两段夹具、预算只够一段 ⇒ 旧的那一段（FADING）应被划入 old
  const planSplit = plan && Array.isArray(plan.old) ? plan.old.length : -1;
  check('v1.2.x: planMerge 真调用 —— 超预算时切分点落在 FADING 段之后的边界上',
    planSplit === 1 && Array.isArray(plan.keep) && plan.keep.length === 1
      && plan.old[0].no === 1 && plan.keep[0].no === 2,
    'old=' + planSplit + ' keepNo=' + (plan && plan.keep && plan.keep[0] && plan.keep[0].no) + ' expectedSee=' + expectedSee);

  // 🔴 系数判别力（DSH 变异测试实证的盲区）：原夹具 punct60 的三个标点在 22/45/63，
  //   0.6 => minBound=36、0.75 => minBound=45，**两种取值都恰好命中位置 45 的「；」**，
  //   所以把 0.6 改成 0.75 时 35 项全绿 —— 系数变异零捕获。
  //   本夹具把唯一句号放在 [0.6*cap, 0.75*cap) 区间内（cap=60 时的 36~44），
  //   0.6 会截在句号后、0.75 找不到句界而回退成 60 字裸截 —— 两者结果必然不同。
  // 🔴 系数三角判别（DSH 变异测试实证）：单一夹具无法同时钉住 0.5 / 0.6 / 0.75，
  //   因为 cap=60 时三条下限分别是 30 / 36 / 45，只有把标点分别放进相邻两条下限之间，
  //   才能让任意一个系数漂移都被捕获。两个夹具缺一不可。
  {
    const cap = 60;
    // 夹具 A：句号落在 [0.5·cap, 0.6·cap) = [30,36) ⇒ 钉住「下限不得低于 0.6」
    const posA = 32;
    const discA = '甲'.repeat(posA) + '。' + '乙'.repeat(cap + 20);
    const outA = truncateFadingText(discA, cap);
    check('v1.2.x: 🔴 系数下限判别（0.50 变体）—— 句号@32 属于 [0.5,0.6)·cap 带，0.60 下应回退裸截',
      outA === discA.slice(0, cap) + '...',
      'len=' + outA.replace(/\.\.\.$/, '').length + '（60=正确回退 / 33=被 0.50 误判为句界）');

    // 夹具 B：句号落在 [0.6·cap, 0.75·cap) = [36,45) ⇒ 钉住「下限不得高于 0.6」
    const posB = 40;
    const discB = '甲'.repeat(posB) + '。' + '乙'.repeat(cap + 20);
    const outB = truncateFadingText(discB, cap);
    check('v1.2.x: 🔴 系数上限判别（0.75 变体）—— 句号@40 属于 [0.6,0.75)·cap 带，0.60 下应在句界截断',
      outB === discB.slice(0, posB + 1) + '...',
      'len=' + outB.replace(/\.\.\.$/, '').length + '（41=正确句界 / 60=被 0.75 漏掉）');
  }

  // 🔴 trimEnd 判别力（DSH 变异测试实证）：中文句号/换行是「本位标点」，slice 后本就不含空白，
  //   删掉 trimEnd 也是 no-op ⇒ 原夹具零捕获。真正让 trimEnd 生效的是**英文句界**：
  //   正则 (?:\. ) 匹配「点+空格」共 2 字符，cutPos 落在空格之后，
  //   若后面还有连续空格，slice 就会把空白带进截断体末尾。
  {
    const t = '甲'.repeat(50) + '.   ' + '乙'.repeat(40);
    const out = truncateFadingText(t, 60);
    const body = out.replace(/\.\.\.$/, '');
    check('v1.2.x: 🔴 trimEnd 判别力 —— 英文句界后的连续空白必须被裁掉（删 trimEnd 必 FAIL）',
      !/\s$/.test(body) && body === '甲'.repeat(50) + '.',
      JSON.stringify(body.slice(-6)) + ' 长=' + body.length + '（51=已裁剪 / 53=未裁剪）');
  }
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;

