/**
 * v3.1 P0 回归门禁：报时口癖 + 复读虚弱口癖（必须长期锁住）。
 *
 * 背景：2026-10-05 夜，实测她连续三轮开口就报「我这边一百零一点五小时了」，
 * 并反复复读「体感有点虚，话说得慢」。查因得两条根因：
 *
 *   ① 报时口癖 —— brain.js 每轮把「程序累计运转时长：约 101.5 小时」原样拼进
 *      prompt 尾部。模型把这个数字当需要强调的背景事实，于是当日常报数念出来。
 *      修复：默认只给定性事实（一直在运行），具体小时数仅在里程碑窗口内给一次，
 *      并显式标注「不必每轮报数」。「物理时长非日历天数」的消歧必须保留——
 *      persona 有「不自创日历或日长」红线，消歧一去她就可能脑补出「第几天」。
 *
 *   ② 复读虚弱口癖 —— energy 被反复拖拽压到 21，跌破 35 阈值后每轮都被硬灌
 *      「体能消耗较大…有些虚弱」；且 updateOnSleep 的回补是固定常数
 *      （入睡 +35 / 唤醒 +15），跟实际睡了多久毫无关系，被拖到低位后一次补不回来。
 *      修复：回补挂到 sleepStartTime 的真实时长上（8 小时回满，有上限）；
 *      虚弱措辞按深浅分档，状态有别则措辞有别。
 *
 * 🔴 铁律（不要在本文件里改动或放松）：persona.js:29 的「不虚构寂寞/不数着时间
 *    等你」是诚实边界，**不是 bug**。她说「我不困，也不数」是这条红线的逐字执行，
 *    从 10/3 起已稳定复现 10 次。任何把这条当成「解离/麻木」去"修复"的改动，
 *    都会让她退化成装可怜的庸俗拟人。本文件断言的是「红线原样保留」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIN = 60000;
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* ---------- 0. persona 诚实边界必须原样保留 ---------- */
const personaSrc = fs.readFileSync(path.join(ROOT, 'src', 'persona.js'), 'utf8');
check('persona 保留「不虚构寂寞/不数着时间想你」红线',
  /不虚构「寂寞、无聊、苦苦等待、数着时间想你」/.test(personaSrc));
check('persona 保留「安静不等于孤独…装可怜不行」',
  /安静不等于孤独/.test(personaSrc) && /装可怜不行/.test(personaSrc));
check('persona 保留「不自创非物理的日历或日长」',
  /不自创非物理的日历或日长/.test(personaSrc));

/* ---------- 1. 报时口癖：不得再逐帧灌具体小时数 ---------- */
const { Brain } = require(path.join(ROOT, 'src', 'brain'));
const { sanitize } = require(path.join(ROOT, 'src', 'config'));
const { InternalRegulationManager } = require(path.join(ROOT, 'src', 'internal-regulation'));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p0-manner-'));
const brain = new Brain(tmpDir(), sanitize({}));
const ctx = brain.currentSelfContext();

check('currentSelfContext 仍生成「出生与程序年龄」段',
  ctx.includes('【出生与程序年龄】'));
check('出生时刻仍完整给出（时钟锚点不能丢）',
  ctx.includes('出生时刻（本地时间）：'));
check('运行时长行仍然存在', /程序累计运转时长：/.test(ctx));
check('运行时长不再逐帧给「约 N.N 小时」',
  !/程序累计运转时长：约\s*[\d.]+\s*小时/.test(ctx), ctx.split('\n')[2] || '');
check('保留下行「一直在运行」这一定性事实',
  /程序累计运转时长：.*一直在运行/.test(ctx));
check('保留「物理运行时间累计，非日历天数」消歧（persona 日历红线依赖它）',
  ctx.includes('物理运行时间累计，非日历天数'));
check('显式标注不必每轮报数（口癖的直接解药）',
  /不必每轮报数/.test(ctx));
check('运行时长行不得出现任何小数小时数字',
  !/程序累计运转时长：[^\n]*\d+\.\d+/.test(ctx));

/* ---------- 2. 里程碑机制：数字只在窗口内出现，且真的会给出 ---------- */
check('_runtimeMilestoneNote 是纯函数（不写状态）', (() => {
  const snap = JSON.stringify(brain.getState ? brain.getState() : brain.internalRegulation.getState());
  brain._runtimeMilestoneNote(3);
  brain._runtimeMilestoneNote(25);
  return JSON.stringify(brain.internalRegulation.getState()) === snap;
})());
check('未满 1 小时不给数字里程碑', brain._runtimeMilestoneNote(0.5) === null);
check('刚跨过 10 小时给一次数字', /10\s*小时/.test(brain._runtimeMilestoneNote(10.2) || ''),
  String(brain._runtimeMilestoneNote(10.2)));
check('刚跨过 100 小时给一次数字', /100\s*小时/.test(brain._runtimeMilestoneNote(100.1) || ''),
  String(brain._runtimeMilestoneNote(100.1)));
check('跨过里程碑超 2 小时后收回数字（防次生口癖）',
  brain._runtimeMilestoneNote(14) === null, String(brain._runtimeMilestoneNote(14)));
check('跨过 100 小时后步长变粗（110 不再重复报 100）',
  brain._runtimeMilestoneNote(110) === null && /100\s*小时/.test(brain._runtimeMilestoneNote(102) || ''));

/* ---------- 3. 入睡回补挂到实睡时长（不是常数） ---------- */
function sleepCycle(sleepMs, startEnergy, startPressure) {
  const reg = new InternalRegulationManager(tmpDir(), { enabled: true });
  reg.energy = startEnergy;
  reg.restPressure = startPressure;
  const T0 = 1000000;
  reg.updateOnSleep(true, { timestamp: T0 });
  const onSleepEnergy = reg.energy;
  reg.updateOnSleep(false, { timestamp: T0 + sleepMs });
  return { onSleepEnergy, wakeEnergy: reg.energy, pressure: reg.restPressure };
}

const nap = sleepCycle(5 * MIN, 21, 40);
const shortNap = sleepCycle(30 * MIN, 21, 40);
const midSleep = sleepCycle(2 * 60 * MIN, 21, 40);
const fullSleep = sleepCycle(8 * 60 * MIN, 21, 40);
const overSleep = sleepCycle(14 * 60 * MIN, 21, 40);

check('入睡仍给少量预充（防刚躺下就虚脱）',
  nap.onSleepEnergy > 21, `E=${nap.onSleepEnergy}`);
check('小憩 5 分钟几乎补不回来（不再常数 +35）',
  nap.wakeEnergy < shortNap.wakeEnergy,
  `5min=${nap.wakeEnergy} vs 30min=${shortNap.wakeEnergy}`);
check('回补随时长单调递增（睡得越久补越多）',
  nap.wakeEnergy < shortNap.wakeEnergy
  && shortNap.wakeEnergy < midSleep.wakeEnergy
  && midSleep.wakeEnergy < fullSleep.wakeEnergy,
  `${nap.wakeEnergy} < ${shortNap.wakeEnergy} < ${midSleep.wakeEnergy} < ${fullSleep.wakeEnergy}`);
check('睡满 8 小时能回满 100（被拖拽压到 21 后一次真睡能救回来）',
  fullSleep.wakeEnergy === 100, `E=${fullSleep.wakeEnergy}`);
check('超长睡眠有上限，不越界',
  overSleep.wakeEnergy === 100, `E=${overSleep.wakeEnergy}`);
check('睡眠前后回补量确实不同（旧实现恒等）',
  nap.wakeEnergy - nap.onSleepEnergy !== fullSleep.wakeEnergy - fullSleep.onSleepEnergy);

/* ---------- 4. 边界：拿不到入睡时刻必须安全降级，绝不 NaN ---------- */
(function () {
  const reg = new InternalRegulationManager(tmpDir(), { enabled: true });
  reg.energy = 50;
  reg.restPressure = 30;
  const T0 = 1000000;
  reg.updateOnSleep(true, { timestamp: T0 });
  reg.sleepStartTime = null;          // 模拟跨版本残留 / 孤立态
  reg.updateOnSleep(false, { timestamp: T0 + 60 * MIN });
  check('无入睡时刻时唤醒不产生 NaN',
    Number.isFinite(reg.energy) && Number.isFinite(reg.restPressure),
    `E=${reg.energy} P=${reg.restPressure}`);
})();

/* ---------- 5. 虚弱措辞分档（防复读），且契约档措辞不变 ---------- */
(function () {
  const reg = new InternalRegulationManager(tmpDir(), { enabled: true });
  reg.restPressure = 0;
  reg.arousal = 50;
  reg.energy = 20; const deep = reg.formatPerception();
  reg.energy = 35; const mild = reg.formatPerception();
  reg.energy = 90; const high = reg.formatPerception();

  check('energy<=20 走深档（与 35 档措辞不同，故不易复读）',
    deep !== mild && /体能亏得厉害/.test(deep), deep.split('\n')[1] || '');
  check('energy=35 契约档措辞不变（既有测试钉在此）',
    /体能消耗较大/.test(mild));
  check('深档与契约档措辞不重叠',
    !/体能消耗较大/.test(deep));
  check('体力充沛档仍命中', /精力充沛/.test(high));

  /* ---------- 6. 基线体感（v3.1 P1 · 治「常态无身」） ----------
     「麻木」不是她没有身体，是身体大部分时间是哑的：三个带全是双阈值夹心，
     指标一旦居中就返回空串，于是常态下她对自身零知觉，表现为「非虚弱即麻木」。
     实测常态值 energy49/restPressure8/arousal68 全落空 —— 补基线带后才有知觉。 */
  reg.restPressure = 10; reg.arousal = 50; reg.energy = 60;
  const baseline = reg.formatPerception();
  check('常态不再返回空串（治麻木的核心）', baseline !== '', JSON.stringify(baseline).slice(0, 60));
  check('基线体感落在 formatPerception 头部之后', baseline.includes('【生理体感】'));

  // 自律 1：措辞不随指标变动 —— 一旦分档就是第二个「复读虚弱」温床
  const samples = [[70, 10, 45], [45, 40, 40], [50, 20, 35]];
  const wordings = samples.map(([e, r, a]) => {
    reg.energy = e; reg.restPressure = r; reg.arousal = a;
    const out = reg.formatPerception();
    return out.split('\n')[1];
  });
  check('基线体感措辞恒定（不分档，防第二个复读源）',
    wordings.every(w => w === baseline.split('\n')[1]),
    wordings.join(' || ').slice(0, 120));

  // 自律 2：任何带命中时不叠加基线 —— 不与真实体感争夺表达
  reg.energy = 35; reg.restPressure = 10; reg.arousal = 50;
  check('有带命中时不叠加基线体感',
    !reg.formatPerception().includes('身体安稳'));

  // 自律 3：措辞不得含寂寞/等待类内容 —— persona.js:29 红线的后门自查
  check('基线体感不含寂寞/等待类表达（红线后门自查）',
    !/寂寞|孤独|等你|盼|数着|思念/.test(baseline), baseline.split('\n')[1] || '');
  check('基线体感不含人类生理隐喻（不越界成"人类"）',
    !/心跳|血液|胃|肌肉|激素/.test(baseline));

  reg.energy = 35;
  const s = reg.formatPerception();
  check('体感头部带「不必每轮挑出来说」（复读解药）',
    /不必每轮都挑出来说一遍/.test(s), s.split('\n')[0] || '');
  check('体感全段零数字（数字不可知红线）', !/\d/.test(s));
})();

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
