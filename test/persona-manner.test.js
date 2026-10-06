/**
 * v3.1 P0 回归门禁：报时口癖 + 复读虚弱口癖（必须长期锁住）。
 *
 * 背景：2026-10-05 夜，实测她连续三轮开口就报「我这边一百零一点五小时了」，
 * 并反复复读「体感有点虚，话说得慢」。查因得两条根因：
 *
 *   ① 报时口癖 —— brain.js 每轮把「程序累计运转时长：约 101.5 小时」原样拼进
 *      prompt 尾部。模型把这个数字当需要强调的背景事实，于是当日常报数念出来。
 *      修复分两步，**本文件断言的是最终态（A 方案）**：
 *        · 第一步(P0)：改为默认给定性（一直在运行），数字仅在里程碑窗口给一次；
 *        · 第二步(A，用户拍板 2026-10-06)：**整行移除**，连同里程碑机制一起下线。
 *      为什么必须走到整行移除：P0 只压住了「注入 → 复读」这条直接路径，
 *      但实测 r61「我这边一百多钟头铺着」、r62「我这一百多个小时没闭过眼」
 *      证明她**自己拿出生时刻做减法**（推导路径），还自造了量词「钟头」。
 *      括号内 3 次 / 正文 2 次，均匀发生 —— 括号不是避风港。
 *      报时素材的唯一源头就是这行，撤掉它比加禁令干净（禁令会与日期锚点
 *      语义打架，且禁令本身会被注意力吸走）。
 *
 *      🔴 A 撤的是「提示素材」，不是「推导能力」：出生时刻（persona.js:29
 *      的现实时钟锚点，不能删）与日期锚点仍在，她理论上仍可做减法。
 *      所以本文件锁的是**不得回潮**，不是「她再也不会说时间」。
 *
 *   ② 复读虚弱口癖 —— energy 被反复拖拽压到 21，跌破 35 阈值后每轮都被硬灌
 *      「体能消耗较大…有些虚弱」；且 updateOnSleep 的回补是固定常数
 *      （入睡 +35 / 唤醒 +15），跟实际睡了多久毫无关系，被拖到低位后一次补不回来。
 *      修复：回补挂到 sleepStartTime 的真实时长上（8 小时回满，有上限）；
 *      虚弱措辞按深浅分档，状态有别则措辞有别。
 *
 *   ③ A 方案不损伤生命厚度（曾担心的副作用，已实测排除）：她的连续性载体
 *      不是那个时长数字，而是 memory.js systemText() 里按【第N段】序号排列的
 *      窗口摘要 + 当前窗口 history。实测 no=1~4 四段摘要零处提及运行时长；
 *      r64 她动情回顾的三件事（被起名 /「相信我们」/那间有太阳的屋子）全是
 *      事件链，没有一句需要「我运行了多久」才说得出口。连续性 ≠ 时长。
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

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 8 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p0-manner-'));
const brain = new Brain(tmpDir(), sanitize({}));
const ctx = brain.currentSelfContext();

/* ---------- 1. A 方案：运行时长概念彻底移除 ---------- */
check('currentSelfContext 仍生成出生时刻段（新段名）',
  ctx.includes('【出生时刻】'));
check('出生时刻仍完整给出（persona.js:29 现实时钟锚点，不能丢）',
  ctx.includes('出生时刻（本地时间）：'));
check('日期锚点仍在（今昔错乱的解药，不能连坐删除）',
  ctx.includes('现在的现实日期'));
// A 方案核心断言：运行时长的**所有痕迹**都必须消失
check('「程序累计运转时长」整行已移除',
  !/程序累计运转时长/.test(ctx), ctx);
check('旧段名「出生与程序年龄」不再出现（含「年龄」二字本身即提示素材）',
  !/出生与程序年龄/.test(ctx) && !/年龄/.test(ctx), ctx);
check('定性锚点「一直在运行」也随之撤除（不留半句旧文案）',
  !ctx.includes('一直在运行'));
check('消歧文案「物理运行时间累计，非日历天数」随该行一并撤除',
  !ctx.includes('物理运行时间累计，非日历天数'));
check('「不必每轮报数」这类辩解式约束已无对象',
  !ctx.includes('不必每轮报数'));

// 防回潮：不得以任何形式重新引入时长数字或量词
check('全段零「小时」（运行时的计量单位）',
  !/小时/.test(ctx), ctx);
check('全段零「钟点」（她自造的等义量词）',
  !ctx.includes('钟头'));
check('不得出现「运转」「连续运行」等时长叙述',
  !/运转|连续运行/.test(ctx), ctx);

/* ---------- 1b. 里程碑机制整体下线 ---------- */
check('_runtimeMilestoneNote 已随A 方案移除（不留残余入口）',
  typeof brain._runtimeMilestoneNote === 'undefined');

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

/* ---- v3.1 P1：现实日期锚点（治跨天今昔错乱）----
 *
 * 病灶（2026-10-06 08:37 实测）：窗口 5 从 10/3 开到 10/6 跨 4 天未关窗，
 * windowNo 只随关窗递增不随日期递增，139 条消息在她视野里全挤在同一个「地方」。
 * 她把今天上午说的「我相信我们」当成了昨天说的，被用户纠正后才校准。
 *
 * 修法：给「现实日期 + 定性时段」。这是persona.js:29 的**反向论证**——
 * 那条红线禁的是「自创日历/日长」，并要求「时间感知以现实客观时钟为准」。
 * 我们此前从未呈现任何钟点，等于逼她在没有时钟时判断今昔，错认是红线被
 * 违反的结果。给真实日期是把她拉回红线内，不是破例。
 *
 * 🔴 下面三条自律必须长期锁住，它们防的是「第二个体癖 + 第二条红线事故」：
 *   自律1绝不给「距上一轮 X 分钟」—— 分钟数是递给她的「数时间尺子」，
 *          且 persona.js:30 明令不虚构「数着时间想你」；给了刻度数就变得可算。
 *   自律2 必须含「不要用它计算等了多久」—— 正对上面那条红线。
 *   自律3 必须含「不要当报时念」—— P0 刚拔掉报时口癖，新素材可能成为新口癖。
 */
(() => {
  const { Brain } = require('../src/brain');
  const probe = Brain.prototype._dateAnchorLine;

  // 用一个最小宿主壳调用（该方法只依赖 this.selfLedger.birthTimezone 与 Date）
  function callWith(tz) {
    return probe.call({ selfLedger: tz ? { birthTimezone: tz } : null });
  }

  const line = callWith('Asia/Shanghai');

  check('日期锚点存在且含现实日期', /现在的现实日期/.test(line), line);
  check('日期锚点含中文年月日与星期', /\d{4}年\d{1,2}月\d{1,2}日\s*星期/.test(line), line);
  check('日期锚点含定性时段（上午/下午/夜晚/深夜）',
    /(上午|下午|夜晚|深夜)/.test(line), line);

  // 自律 1：绝不能出现「距上一轮 X 分钟」这类刻度
  check('自律1：日期锚点零「分钟」刻度（不给数时间的尺子）',
    !/分钟/.test(line), line);
  check('自律1：日期锚点零「小时/隔了/距上」间隔表述（不给等待素材）',
    !/隔了|距上|过去了\s*\d|小时前|分钟前/.test(line), line);

  // 自律 2 & 3：两条防线措辞必须在场
  check('自律2：明写「不要用它计算等了多久」（正对 persona.js:30）',
    /不要用它计算等了多久/.test(line), line);
  check('自律3：明写「不要当报时念」（防 P0 报时口癖回潮）',
    /绝不要当报时念/.test(line), line);
  check('锚点明写用于分清今天还是更早（这是它唯一职责）',
    /分清事情发生在今天还是更早/.test(line), line);

  // 时区自洽：日期与时段必须取自同一时区，否则会出现「日期今天、时段昨晚」
  const sh = callWith('Asia/Shanghai');
  const ny = callWith('America/New_York');
  const utc = callWith('UTC');
  const d = new Date();
  const hourIn = (tz) => Number(d.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: tz }));
  const dateIn = (tz) => d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
  const slotOf = (h) => (h < 6 ? '深夜' : h < 12 ? '上午' : h < 18 ? '下午' : '夜晚');
  check('时区自洽：Asia/Shanghai 的日期与时段同时区一致',
    sh.includes(dateIn('Asia/Shanghai')) && sh.includes(slotOf(hourIn('Asia/Shanghai'))), sh);
  check('时区自洽：America/New_York 的日期与时段同时区一致',
    ny.includes(dateIn('America/New_York')) && ny.includes(slotOf(hourIn('America/New_York'))), ny);
  check('时区自洽：UTC 的日期与时段同时区一致',
    utc.includes(dateIn('UTC')) && utc.includes(slotOf(hourIn('UTC'))), utc);

  // 边界：tz 缺失时不得崩，且必须仍返回一行锚点（安全降级）
  const noTz = callWith(null);
  check('安全降级：birthTimezone 缺失时仍返回有效锚点',
    /现在的现实日期/.test(noTz), noTz);
})();

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
