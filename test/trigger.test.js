/**
 * 主动搭话触发引擎测试。
 *
 * 这个文件存在的最大理由是一组时序：evaluate() 只出提案、不改状态，
 * 真的说出口才 commit()。如果哪天有人图省事把冷却写进 evaluate，
 * 「主进程想让她说话、渲染端因为用户正在打字而拒了」这一趟就会白烧一次冷却，
 * 而挂机那条更糟 —— spokenDuringIdle 被置位、她一个字都没说，
 * 这句问候就永远补不回来了。下面的「拒绝不记账」那组就是钉这个的。
 *
 * 时钟全部注入。这些判据全是毫秒级的时序比较，用真 setTimeout 测
 * 一次要等 45 秒，还会在慢机器上随机红。
 */
const { ActivityTracker } = require('../src/tracker');
const { TriggerEngine, WINDOW_MS, POKE_THRESHOLD, COOLDOWN_MS, IDLE_MS } =
  require('../src/trigger');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function harness(opts = {}) {
  let t = opts.start ?? 1000000;
  const tracker = new ActivityTracker({ ...opts, now: () => t });
  const eng = new TriggerEngine(tracker, { now: () => t, ...opts });
  return {
    tracker, eng,
    at: (ms) => { t += ms; return t; },
    poke: (n = 1, gap = 100) => { for (let i = 0; i < n; i++) { tracker.record('click'); t += gap; } },
    now: () => t
  };
}

/* ============ 1. 连戳：阈值边界 ============ */
let h = harness();
h.poke(POKE_THRESHOLD - 1);
check('少一下不开口（' + (POKE_THRESHOLD - 1) + ' 下 → null）', h.eng.evaluate() === null);
h.poke(1);
let out = h.eng.evaluate();
check('恰好 ' + POKE_THRESHOLD + ' 下就提案 poke', out && out.kind === 'poke', JSON.stringify(out));
check('提案里带着事实（理由与时刻），渲染端只是转述',
  out && new RegExp(POKE_THRESHOLD + ' 下').test(out.reason) && typeof out.at === 'number',
  JSON.stringify(out && out.reason));
check('提案附带说话提示（hint 不是给用户看的）', !!(out && out.hint));

/* 窗口外的连戳不算：8 秒是硬条件 */
h = harness();
h.poke(POKE_THRESHOLD, 3000);        // 每下隔 3 秒，共 12 秒 > 窗口
check('戳满 5 下但拉成 12 秒 → 不算连戳（窗口 ' + WINDOW_MS / 1000 + ' 秒）',
  h.eng.evaluate() === null, 'recent=' + h.tracker.recentClicks(WINDOW_MS, h.now()));

/* ============ 2. evaluate 不改状态（本文件的主戏） ============ */
h = harness();
h.poke(POKE_THRESHOLD);
const before = { cooldown: h.eng.lastFiredAt, state: JSON.stringify(h.eng),
                 idle: h.tracker.spokenDuringIdle, committed: h.tracker.lastCommittedSeq };
h.eng.evaluate(); h.eng.evaluate(); h.eng.evaluate();
check('反复 evaluate 不改冷却与挂机刹车（问三次不烧三次）',
  h.eng.lastFiredAt === before.cooldown && h.eng.pokeFiredAt === undefined
  && JSON.stringify(h.eng) === before.state
  && h.tracker.spokenDuringIdle === before.idle && h.tracker.lastCommittedSeq === before.committed);

/* 被拒的提案什么都不留下 */
h = harness();
h.poke(POKE_THRESHOLD);
const o = h.eng.evaluate();
check('先拿到底层：确实有提案可拒', !!o);
// 渲染端这次说"用户正在打字"，没有 commit
check('未 commit 时冷却仍是 0（下一轮还会再问）', h.eng.lastFiredAt === 0);
h.at(1000);                             // 仍在 8 秒窗口内
check('被拒 1 秒后仍然提案（拒一次不等于这串作废）',
  h.eng.evaluate() && h.eng.evaluate().kind === 'poke');
check('非空前提：上一句若拿不到提案，断言就是空转',
  !!h.eng.evaluate());

/* 挂机这条更要紧：被拒时绝不许置 spokenDuringIdle —— 置了她就永远错过这句问候 */
h = harness();
h.at(IDLE_MS);
const oi = h.eng.evaluate();
check('底层：挂机提案确实出来了', oi && oi.kind === 'idle', JSON.stringify(oi));
h.eng.evaluate(); h.eng.evaluate();     // 连着被拒三次
check('被拒三句之后刹车仍未拉上（这句问候还补得回来）',
  h.tracker.spokenDuringIdle === false);
h.eng.commit(h.eng.evaluate());
check('真的说了才拉刹车', h.tracker.spokenDuringIdle === true);

/* commit 之后才记账 */
h = harness();
h.poke(POKE_THRESHOLD);
const o2 = h.eng.evaluate();
h.eng.commit(o2);
h.at(1000);
check('commit 之后冷却生效（同一串不再连问）', h.eng.evaluate() === null);
check('commit 记的是提案里那个 at（不是 commit 的时刻）',
  h.eng.lastFiredAt === o2.at, JSON.stringify([h.eng.lastFiredAt, o2.at]));

/* ============ 3. 冷却：任何理由都受它管 ============
   冷却是**唯一**的"两次开口之间"闸门，所以这里直接摆 lastFiredAt 卡边界：
   用真实流程也能测，但要等 45 秒真时钟或把 IDLE_MS 也拖进来，
   那样测的就不是冷却而是挂机了。 */
h = harness();
h.at(IDLE_MS);                            // 先让 idle 这一路成立
h.eng.lastFiredAt = h.now() - (COOLDOWN_MS - 1);
check('冷却差 1ms 仍不开口', h.eng.evaluate() === null);
h.eng.lastFiredAt = h.now() - COOLDOWN_MS;
check('冷却刚好到点就放行（边界是「不小于」而不是「大于」）', !!h.eng.evaluate());

h = harness();
h.eng.lastFiredAt = h.now() - 1000;       // 刚开口过一句
h.poke(POKE_THRESHOLD);
check('刚说完 1 秒就被连戳 5 下也不再提（冷却管所有理由）', h.eng.evaluate() === null);

/* ============ 4. 连戳开口之后：只有冷却这一道闸门 ============ */
h = harness();
h.poke(POKE_THRESHOLD);
const oo = h.eng.evaluate();
h.eng.commit(oo);
h.at(1000);
h.poke(3);                              // 用户又戳了几下
check('刚说完 1 秒再被戳也不提（冷却挡着）', h.eng.evaluate() === null);
h.at(COOLDOWN_MS + 1);                  // 冷却刚好过
h.poke(POKE_THRESHOLD);
check('冷却一过、新一串 5 下就再抱怨一次（不该永久闭嘴）',
  h.eng.evaluate() && h.eng.evaluate().kind === 'poke',
  'at=' + h.now() + ' fired=' + h.eng.lastFiredAt);
check('引擎里没有第二个 poke 时间戳（冷却是唯一的"两次开口之间"闸门）',
  !('pokeFiredAt' in h.eng) && !('pokeAt' in h.eng),
  Object.keys(h.eng).join(','));

/* ============ 5. 挂机：单次刹车 ============ */
h = harness();
h.at(IDLE_MS);
const g1 = h.eng.evaluate();
h.eng.commit(g1);
h.at(IDLE_MS * 3);
check('挂机问候说过之后不再重复（spokenDuringIdle 刹住）', h.eng.evaluate() === null);
h.at(IDLE_MS);
h.tracker.record('click');              // 用户回来了（物理互动）
h.at(IDLE_MS * 3);
check('用户真的互动过之后刹车解除（下次离开还能问候）',
  h.eng.evaluate() && h.eng.evaluate().kind === 'idle');

h = harness();
h.at(IDLE_MS);
h.tracker.recordUserInput('在吗');        // 用户说话了
check('用户说话会解除挂机刹车', h.tracker.spokenDuringIdle === false);
check('说完话当下静默归零（不再立刻补一句问候）',
  h.eng.evaluate() === null, 'idleMin=' + h.tracker.snapshot().idleMin);
h.at(IDLE_MS);
check('又离开 30 分钟后仍会问候一次（解除刹车不等于永久闭嘴）',
  h.eng.evaluate() && h.eng.evaluate().kind === 'idle');

/* 连戳之后不永远压住挂机：冷却只有 45 秒，挂机阈值 30 分钟 */
h = harness();
h.poke(POKE_THRESHOLD);
const pk0 = h.eng.evaluate();
h.eng.commit(pk0);
h.at(IDLE_MS * 2);                        // 之后再没有任何互动
check('连戳开口后静默满 30 分钟会转为挂机问候',
  h.eng.evaluate() && h.eng.evaluate().kind === 'idle');

/* 差 1ms 不触发：边界钉住，别让人以后手滑把 IDLE_MS 改小 */
h = harness();
h.at(IDLE_MS - 1);
check('差 1ms 不到挂机阈值就不开口', h.eng.evaluate() === null);

/* ============ 6. 睡着了不许自己开口 ============ */
h = harness();
h.tracker.enterSleepMode();
h.at(IDLE_MS * 2);
check('晚安之后挂机到再久也不自言自语（省钱且合理）', h.eng.evaluate() === null);
h = harness();
h.tracker.enterSleepMode();
h.at(1000);
h.poke(POKE_THRESHOLD);
check('睡着时被戳 → tracker 已经把她叫醒，所以这时允许提案',
  h.tracker.sleepMode === false && h.eng.evaluate() && h.eng.evaluate().kind === 'poke');
h = harness();
h.tracker.enterSleepMode();
check('睡眠期间即使有提案候选也一律 null（先看 sleepMode）',
  h.tracker.sleepMode === true && h.eng.evaluate() === null);

/* ============ 7. 边界与降级 ============ */
check('没有 tracker 时 evaluate 返回 null 而不是崩',
  new TriggerEngine(null).evaluate() === null);
h = harness();
check('什么都没发生过时不开口', h.eng.evaluate() === null);
h.eng.commit(null);
check('commit(null) 是安全的空操作（渲染端传错不至于记歪）',
  h.eng.lastFiredAt === 0 && h.tracker.spokenDuringIdle === false);

/* commit 按 kind 分支：两条通道各自记账，别互相牵连 */
h = harness();
h.poke(POKE_THRESHOLD);
const pk = h.eng.evaluate();
h.eng.commit(pk);
check('poke 的 commit 不会顺手关掉挂机刹车', h.tracker.spokenDuringIdle === false);
h = harness();
h.at(IDLE_MS);
const idl = h.eng.evaluate();
h.eng.commit(idl);
check('idle 的 commit 只拉刹车并记冷却，不动 tracker 的水位线',
  h.tracker.spokenDuringIdle === true && h.eng.lastFiredAt === idl.at
  && h.tracker.lastCommittedSeq === 0);

/* ============================================================================
 * v1.0 D-7：自我意图（selfIntent）
 * ============================================================================
 *
 * 这个文件最大的理由不是「意图算得对」，而是**它必须能不算**。
 * 前十一轮建了五道闸门把误触发压到最低，代价是她一次也没自己做过什么；
 * D-7 若把「她总该有点想法」写成硬要求，就会用新的骚扰换回旧的安心。
 *
 * 所以下面四组断言的方向与前十轮相反：多数在断言**不该有**。
 *   ① 可追溯性：sources 必须指向真实存在的字段
 *   ② 可空性：没有依据时必须是 null，且不拼空标签
 *   ③ 不绕过铁律：意图绝不改变「说不说」，只改变「说什么方向」
 *   ④ 不预设台词：意图是方向，不是可枚举的台词表
 */

const {
  computeSelfIntent, SELF_INTENT_KINDS, TRAIT_LABEL,
} = require('../src/trigger');

/* ---- 1. 正例：四类意图各能算出来，且方向干净 ---- */
check('特质偏高 → 依恋类意图',
  (computeSelfIntent({ traits: { attachment_need: 40 }, idleMinutes: 0 }) || {}).kind === 'attachment_high');
check('特质偏高 → 好奇类意图',
  (computeSelfIntent({ traits: { philosophical_curiosity: 30 }, idleMinutes: 0 }) || {}).kind === 'curiosity_high');
check('特质偏高 → 活力类意图',
  (computeSelfIntent({ traits: { vitality: 30 }, idleMinutes: 0 }) || {}).kind === 'vitality_high');
check('静默够久 → 深静默意图（>=90 分钟那一档）',
  (computeSelfIntent({ traits: {}, idleMinutes: 100 }) || {}).kind === 'idleness_verydeep');
check('静默够久 → 浅静默意图（45~89 分钟）',
  (computeSelfIntent({ traits: {}, idleMinutes: 50 }) || {}).kind === 'idleness_deep');
check('两类静默互斥：90 分钟以上只命中更深那一档',
  computeSelfIntent({ traits: {}, idleMinutes: 100 }).kind !== 'idleness_deep');
check('特质与环境同时成立时特质优先（她自己的 > 环境的）',
  (computeSelfIntent({ traits: { attachment_need: 40 }, idleMinutes: 100 }) || {}).kind === 'attachment_high');

/* ---- 2. 🔴 反例：必须能为空（判据1）。没有依据就是没有，不许硬造 ---- */
const emptyCases = [
  ['没有任何状态', {}],
  ['特质全中立、刚互动过', { traits: {}, idleMinutes: 0 }],
  // 🔴 quiet_preference 高不产意图：它调的是「少开口」，方向反了，
  //   给它造意图等于把一道抑制闸门改成了驱动闸门。
  ['安静偏好极高（方向相反，不产意图）', { traits: { quiet_preference: 900 }, idleMinutes: 0 }],
  ['依恋没到阈值', { traits: { attachment_need: 10 }, idleMinutes: 0 }],
  ['静默不够久', { traits: {}, idleMinutes: 5 }],
];
for (const [name, input] of emptyCases) {
  check('❌ 反例·必须为空：无依据不硬造意图 → ' + name,
    computeSelfIntent(input) === null);
}

/* ---- 3. 🔴 反例：漏传参数与恶意变体（输入一律不可信） ---- */
const junkCases = [
  ['完全不传', undefined],
  ['传 null', null],
  ['传字符串', '帮我保存'],
  ['传数字', 123],
  ['传数组', []],
  ['traits 为 null', { traits: null }],
  ['traits 为数组', { traits: [] }],
  ['特质值为字符串', { traits: { attachment_need: 'abc' } }],
  ['特质值为 NaN', { traits: { attachment_need: NaN } }],
  ['特质值为 Infinity', { traits: { attachment_need: Infinity } }],
  ['特质值为 null', { traits: { attachment_need: null } }],
  ['静默时长的负值', { idleMinutes: -5 }],
  ['静默时长的 Infinity', { idleMinutes: Infinity }],
  ['静默时长的 NaN', { idleMinutes: NaN }],
  ['静默时长的字符串', { idleMinutes: '很久' }],
];
for (const [name, input] of junkCases) {
  check('❌ 反例·漏传/恶意变体：坏输入必须降级为 null（不崩不造） → ' + name,
    computeSelfIntent(input) === null);
}

/* ---- 4. 🔴 反例：来源不可追溯的一律不产意图（判据2） ---- */
// 这一组是本轮最关键的反例：新增一个 mood 状态机再从它推意图，
// 形式上「有来源」，实质是从新造状态机推出自动化 —— 那是自动化不是主体性。
check('❌ 反例·未知特质不产意图（mood 不是既有维度）',
  computeSelfIntent({ traits: { mood: 900 }, idleMinutes: 0 }) === null);
check('❌ 反例·多个未知特质也不产意图',
  computeSelfIntent({ traits: { unknown_trait: 999, other: 999 }, idleMinutes: 0 }) === null);
check('❌ 反例·social_initiative 不产意图（本表未声明该意图种类）',
  computeSelfIntent({ traits: { social_initiative: 900 }, idleMinutes: 0 }) === null);

/* ---- 5. 🔴 可追溯性：sources 必须指向真实字段 ---- */
// 断言精确指向判据本身：不是「有 sources」，而是「sources 里的键真的存在」。
const ALLOWED_TRAITS = new Set([
  'quiet_preference', 'social_initiative', 'attachment_need',
  'vitality', 'philosophical_curiosity',
]);
for (const kind of Object.keys(SELF_INTENT_KINDS)) {
  const spec = SELF_INTENT_KINDS[kind];
  const input = spec.requires === 'idleness_minutes'
    ? { traits: {}, idleMinutes: spec.min + 1 }
    : { traits: { [spec.requires]: spec.min + 1 }, idleMinutes: 0 };
  const got = computeSelfIntent(input);
  const ok = got && got.kind === kind && Array.isArray(got.sources) && got.sources.length > 0
    && got.sources.every((s) => {
      if (s === 'tracker.lastInteractionAt') return true;
      if (s.startsWith('traits.')) return ALLOWED_TRAITS.has(s.slice(7));
      return false;
    });
  check('可追溯性：' + kind + ' 的 sources 必须指向真实字段',
    ok, got ? JSON.stringify(got.sources) : 'null');
}
check('sources 一律非空（没有来源的意图等于没有依据）',
  Object.keys(SELF_INTENT_KINDS).every((kind) => {
    const spec = SELF_INTENT_KINDS[kind];
    const input = spec.requires === 'idleness_minutes'
      ? { traits: {}, idleMinutes: spec.min + 1 }
      : { traits: { [spec.requires]: spec.min + 1 }, idleMinutes: 0 };
    const got = computeSelfIntent(input);
    return got && got.sources && got.sources.length > 0;
  }));
check('维度名用中文定名而非程序变量名（她会照念 attachment_need）',
  TRAIT_LABEL.attachment_need === '依恋渴望' && TRAIT_LABEL.philosophical_curiosity === '好奇'
  && TRAIT_LABEL.vitality === '生命活力');
check('方向文案里没有程序时钟数字（不该复述 idleMinutes/60000）',
  //🔴 两条静默档位都要查。变异测试实测：只查「静得极久」那条路径时，
  //   把「已经好一阵了」改回带数字的文案**测不到** ——
  //   因为 idleMinutes=100000 只会命中 idleness_verydeep 分支。
  //   必须是 {45~89} 与 {>=90} 两条路径各查一次。
  [{ traits: {}, idleMinutes: 50 }, { traits: {}, idleMinutes: 100000 }].every((input) => {
    const got = computeSelfIntent(input);
    return got && !/\d/.test(got.direction);
  }));
check('🔴 浅静默档（45~89 分钟）方向同样不含数字',
  !/\d/.test((computeSelfIntent({ traits: {}, idleMinutes: 50 }) || { direction: '' }).direction));
check('🔴 深静默档（>=90 分钟）方向同样不含数字',
  !/\d/.test((computeSelfIntent({ traits: {}, idleMinutes: 100000 }) || { direction: '' }).direction));

/* ---- 6. 🔴 不预设台词：意图是方向，不是台词表 ---- */
// 变体相同的方向不许出现不同的文案集合 —— 若每个 kind 返回一句成品台词，
// 那么「不可枚举」这条就破了，主体性做成了可枚举的东西。
const kindCount = Object.keys(SELF_INTENT_KINDS).length;
// 🔵 D-11 修订：5 → 6。新增 `wantToLeaveSomething`（静默 ≥120 分钟，
//   产物是「留给自己的东西」而非「说一句话」—— 见 trigger.js 的 SELF_INTENT_KINDS）。
//   **断言的意图没变**：仍是「种类有限、由本表穷举」，只是数字 +1。
//   这条断言的价值正在于此 —— 它拦住了一次「顺手加意图」，逼我们显式登记。
check('意图种类是有限且由本表穷举的（' + kindCount + ' 种，不多不少）',
  kindCount === 6);
check('每种意图的 direction 是静态的（同样输入必得同样方向，非随机）',
  Object.keys(SELF_INTENT_KINDS).every((kind) => {
    const spec = SELF_INTENT_KINDS[kind];
    const input = spec.requires === 'idleness_minutes'
      ? { traits: {}, idleMinutes: spec.min + 5 }
      : { traits: { [spec.requires]: spec.min + 5 }, idleMinutes: 0 };
    const a = computeSelfIntent(input);
    const b = computeSelfIntent(input);
    return a && a.direction === b.direction;
  }));
check('方向文案长度都在合理范围（不是台词、不含换行堆砌）',
  Object.keys(SELF_INTENT_KINDS).every((kind) => {
    const spec = SELF_INTENT_KINDS[kind];
    const input = spec.requires === 'idleness_minutes'
      ? { traits: {}, idleMinutes: spec.min + 5 }
      : { traits: { [spec.requires]: spec.min + 5 }, idleMinutes: 0 };
    const d = computeSelfIntent(input).direction;
    return d.length > 4 && d.length < 60 && !/[\r\n]/.test(d);
  }));

/* ---- 7. 🔴 意图绝不绕过三道防骚扰铁律 ---- */
// 🔴 这是本轮最要紧的一条：意图只能改变「说什么」，
//   绝不能改变「说不说」。若它能唤醒睡着/冷却/挂机刹车，
//   主体性就退化成了骚扰开关。
//
// 🔴 变异测试实测教训（写这三条时踩的）：
//   最初这三条只断言 `evaluate() === null`。跑变异体「把意图计算挪到睡眠闸门前」
//   发现**全绿** —— 因为守卫在引擎字段（this.selfIntent）上，
//   而 offer 返回 null，断言压根碰不到守卫。
//   ⇒ 断言必须精确指向**守卫本身的判据**（this.selfIntent），
//     不能只断言「结果被拒」。这与本仓「断言必须精确指向守卫本身」同源。
(function () {
  const mk = (over) => Object.assign({
    sleepMode: false, lastInteractionAt: 0, spokenDuringIdle: false, recentClicks: () => 0,
  }, over);

  // 睡着她不开口 —— 即便依恋渴望拉满
  let e = new TriggerEngine(mk({ sleepMode: true }), {
    now: () => 50 * 60000, traits: { attachment_need: 999 },
  });
  const sleepOut = e.evaluate();
  check('🔴 意图不得绕过睡眠闸门：睡着+特质拉满仍不开口', sleepOut === null);
  // 🔴 精确指向守卫：睡着时**连意图都不该被算出来**（它会留在引擎字段上）
  check('🔴 睡着时不得留下任何自意图（守卫在引擎字段，不只在 offer 上）',
    e.selfIntent === null && e.selfIntentSource === null);

  // 冷却内她不开口
  e = new TriggerEngine(mk({ lastInteractionAt: -100 * 60000 }), {
    now: () => 0, traits: { attachment_need: 999 },
  });
  e.lastFiredAt = -1000;
  const cdOut = e.evaluate();
  check('🔴 意图不得绕过冷却：冷却内+特质拉满仍不开口', cdOut === null);
  check('🔴 冷却内不得留下任何自意图',
    e.selfIntent === null && e.selfIntentSource === null);

  // 挂机刹车不因意图而松
  e = new TriggerEngine(mk({ spokenDuringIdle: true, lastInteractionAt: -100 * 60000 }), {
    now: () => 0, traits: { attachment_need: 999 },
  });
  const brakeOut = e.evaluate();
  check('🔴 意图不得绕过挂机刹车：说过一次+特质拉满仍不开口', brakeOut === null);
  check('🔴 挂机刹车触发时不得留下任何自意图',
    e.selfIntent === null && e.selfIntentSource === null);

  //🔴 变异测试实测补的形态：冷却守卫必须在「**已经有自意图**」时同样生效。
  //   最初那三条断言都在「刚构造、还没算过意图」的形态上测，
  //   此时 selfIntent 还是 null ⇒ 一条「意图可覆盖冷却」的变异体全绿逃过。
  //   这与本仓假反例的第六种形态同源：**测试只覆盖了状态机的一条路径**。
  const cdWarm = new TriggerEngine(mk({ lastInteractionAt: -100 * 60000 }), {
    now: () => 0, traits: { attachment_need: 999 },
  });
  cdWarm.lastFiredAt = -1000;
  cdWarm.computeIntentNow(50);          // 先让意图算出来（引擎字段非null）
  check('前提：冷却内此刻确实已持有自意图', cdWarm.selfIntent !== null);
  check('🔴 已有自意图时冷却仍然生效（意图不得覆盖冷却闸门）',
    cdWarm.evaluate() === null);

  // 同理：挂机刹车在「已有自意图」时也必须生效
  const brakeWarm = new TriggerEngine(mk({
    spokenDuringIdle: true, lastInteractionAt: -100 * 60000,
  }), { now: () => 0, traits: { attachment_need: 999 } });
  brakeWarm.computeIntentNow(50);
  check('前提：挂机刹车态此刻确实已持有自意图', brakeWarm.selfIntent !== null);
  check('🔴 已有自意图时挂机刹车仍然生效（意图不得松刹车）',
    brakeWarm.evaluate() === null);
})();

/* ---- 8. 意图挂在 offer 上，且 null 是合法值 ---- */
(function () {
const mk = (over) => Object.assign({
    sleepMode: false, lastInteractionAt: 0, spokenDuringIdle: false, recentClicks: () => 0,
  }, over);

  // 「offer 带 selfIntent 字段（即使为 null）」：用挂机态但**未达静默意图阈值**来构造。
  //   at - lastInteractionAt 必须是 30~44 分钟（够出 idle 提案 = 60 分钟冷却前的常态，
  //   但 < 45 分钟的 idleness_deep 阈值 ⇒ 没有依据 ⇒ selfIntent 应为 null）。
  //   ⚠️ 我第一版写 50 分钟，那 ≥45 已命中 idleness_deep，方向写反；
  //   第二版用 0 静默，压根出不来提案（idleNeed=30 分钟）⇒ o 为 null 崩在断言上。
  //   这两次都是**在错误前提上写断言**，不是实现的问题。
  const at = 35 * 60000;   // 挂机 35 分钟：出 idle 提案，但够不到 45 分钟那档
  let e = new TriggerEngine(mk({}), { now: () => at, traits: {} });
  let o = e.evaluate();
  check('offer 带 selfIntent 字段（即使为 null）',
    !!o && ('selfIntent' in o));
  check('🔴 无依据时 selfIntent 为 null 而不是兜底文案',
    !!o && o.selfIntent === null);

  e = new TriggerEngine(mk({}), { now: () => at, traits: { attachment_need: 80 } });
  o = e.evaluate();
  check('有依据时 offer.selfIntent 非空', !!o && !!o.selfIntent);
  check('offer.selfIntent 与引擎字段一致（同一来源，不各算一遍）',
    !!o && o.selfIntent && o.selfIntent.kind === e.selfIntent.kind
    && JSON.stringify(o.selfIntent.sources) === JSON.stringify(e.selfIntentSource));

  const poke = new TriggerEngine(mk({ recentClicks: () => 9 }), {
    now: () => 60000, traits: { attachment_need: 80 },
  });
  // ⚠️ 必须**只调一次**：evaluate() 不改冷却，但第二次调用时
  //   recentClicks 的假身恒返回 9，没问题；真正的问题是连续调用会让
  //   断言读到的对象与第一次不是同一份（同仓踩过：「同一职责两处各做一遍」）。
  //   存下来复用。
  const pokeOut = poke.evaluate();
  check('poke 提案同样带 selfIntent（不只有 idle 有）',
    !!pokeOut && !!pokeOut.selfIntent);
})();

/* ---- 9. 🔴 构造函数初始化为 null，不留 undefined ---- */
// 本仓踩过的坑：字段在但从不赋值，下一个人读到 undefined 会当成
// 「没有待办」，功能静默少一块且不报错。
(function () {
  const eng = new TriggerEngine({
    sleepMode: false, lastInteractionAt: 0, spokenDuringIdle: false, recentClicks: () => 0,
  }, {});
  check('🔴 selfIntent 初始化为 null 而非 undefined', eng.selfIntent === null);
  check('🔴 selfIntentSource 初始化为 null 而非 undefined', eng.selfIntentSource === null);
  check('🔴 traits 初始化为 null 而非 undefined', eng.traits === null);
})();

/* ---- 10. 特质刷新区必须一并更新自意图 ---- */
// 形态清单第 5 项：只刷 bias 不刷 traits，自意图会永远停在旧特质上。
(function () {
  const mk = () => ({
    sleepMode: false, lastInteractionAt: 0, spokenDuringIdle: false, recentClicks: () => 0,
  });
  const at = 35 * 60000;
  // 用挂机 35 分钟（出idle 提案，但够不到 45 分钟那档⇒ 无依据）。
  //   ⚠️ 同一个坑踩了第三次：写 50 分钟会命中 idleness_deep（有依据），
  //   写 0静默压根出不来 idle 提案（idleNeed=30）⇒ o 为 null 直接崩在断言上。
  //   **凡是「断言无依据」，输入必须落在「出提案但未达意图阈值」这一段。**
  const eng = new TriggerEngine(mk(), { now: () => at, traits: {} });
  const beforeOffer = eng.evaluate();
  const before = beforeOffer.selfIntent;
  eng.updateTraits({ attachment_need: 80 });
  const after = eng.evaluate().selfIntent;
  check('刷新特质前：无依据 → null', !!beforeOffer && before === null);
  check('🔴 刷新特质后：自意图随之更新（不留在旧特质上）',
    !!after && after.kind === 'attachment_high');
  check('🔴 updateTraits 复制 traits 而非持引用（外部事后改它不会凭空改变自意图）',
    eng.traits !== null && typeof eng.traits === 'object');
  // 🔴 变异测试实测补的断言：光断言「非 null 且是 object」**两种实现都过**
  //   （持引用也满足），等于没锁。这里必须断言「不是同一个对象」。
  //   这是本仓假反例的又一形态：**断言写得太松，两种实现都通过**。
  (function () {
    const e2 = new TriggerEngine(mk(), { now: () => 35 * 60000, traits: {} });
    const src = { attachment_need: 80 };
    e2.updateTraits(src);
    const notSame = e2.traits !== src;
    src.attachment_need = 999;
    const unchanged = e2.traits.attachment_need === 80;
    check('🔴 引擎持有的 traits 与传入对象不是同一个引用',
      notSame, notSame ? '' : 'same ref');
    check('🔴 外部事后修改传入对象不影响引擎（否则自意图无法复现）',
      unchanged, 'attachment_need=' + e2.traits.attachment_need);
  })();
  eng.updateTraits(null);
  check('updateTraits(null) 后 traits 回落为 null 而非留旧值',
    eng.traits === null && eng.computeIntentNow(0) === null);
})();

/* ============================================================================
 * D-8a：traits 缺失时的行为契约（反例，不是正例）
 *
 * D-7 宣称「她开口时带着自己想说的话」，实测那三档特质意图一次都没运行过，
 * 根因是 main.js 启动时 bindBrainDeps 跑在 trigger 赋值之前 ⇒ traits 长期为 null。
 *
 * ⚠️ 修 bug 只修「数据没送到」，**不修「数据没送到时也不许编」**。
 * 下面两条把后者钉死 —— 这是本轮最容易犯的「好心错误」：
 * 有人为了「让她多点想法」给 null 兜一套默认特质，产出的意图却没有来源，
 * 而 D-7 判据②明写「来源必须可追溯」。宁可她没想法，也不要来路不明的念头。
 * ========================================================================== */
(function () {
  const { computeSelfIntent, SELF_INTENT_KINDS } = require('../src/trigger');
  const TRAIT_KINDS = Object.keys(SELF_INTENT_KINDS)
    .filter((k) => SELF_INTENT_KINDS[k].requires !== 'idleness_minutes');

  // ① traits 缺失时，静默档**仍要**产出 —— 这是现状的正确行为，修 bug 不该改它。
  const idleOnly = computeSelfIntent({ traits: null, idleMinutes: 50 });
  check('🔴 traits 缺失时静默档仍产出（静默是客观事实，不依赖特质）',
    !!idleOnly
      && idleOnly.kind === 'idleness_deep'
      && Array.isArray(idleOnly.sources)
      && idleOnly.sources.indexOf('tracker.lastInteractionAt') !== -1,
    JSON.stringify(idleOnly));

  // 🔴 ② traits 缺失时，特质档**一个都不许**产出（本轮最关键的反例）。
  //   判据必须精确指向「来源不可追溯」，不是笼统的「结果为 null」——
  //   静默档会合法地返回非 null，所以只能逐档检查 kinds。
  const noTraitLeak = TRAIT_KINDS.every((k) => {
    const r = computeSelfIntent({ traits: null, idleMinutes: 50 });
    return !r || r.kind !== k;
  });
  check('🔴 traits 缺失时不得凭空猜一个意图（宁可她没想法，不要来路不明的想法）',
    noTraitLeak, '检查了 ' + TRAIT_KINDS.length + ' 档：' + TRAIT_KINDS.join('/'));

  // ②的加强形态：给 null 兜一套「默认特质」必须立刻暴露。
  //   直接把「如果有人兜底」这件事算出来，证明这条断言不是恒真。
  const withFakeDefault = { attachment_need: 80, philosophical_curiosity: 0, vitality: 0 };
  const leaked = computeSelfIntent({ traits: withFakeDefault, idleMinutes: 50 });
  check('（对照）真给足特质时特质档确实会产出 —— 证明上一条不是恒真',
    !!leaked && leaked.kind === 'attachment_high'
      && leaked.sources.indexOf('traits.attachment_need') !== -1,
    JSON.stringify(leaked && leaked.sources));

  // ③ 引擎层同形态：构造后未刷新traits（= D-8a 修复前的真实启动状态）
  //   不得凭空长出特质意图。这是「不调」那一路，现有门禁从来没测过。
  const mkTracker = () => ({
    sleepMode: false, lastInteractionAt: 0, spokenDuringIdle: false, recentClicks: () => 0,
  });
  const unRefreshed = new TriggerEngine(mkTracker(), {
    now: () => 35 * 60000,
  }); // 🔴 注意：**不传 traits、不调 updateTraits** —— 复刻 main.js 修复前的启动路径
  check('🔴 构造后未刷新 traits（默认 null）不得等于「已刷过中立特质」',
    unRefreshed.traits === null,
    'traits=' + JSON.stringify(unRefreshed.traits));
  const unRefreshedIntent = unRefreshed.computeIntentNow(50);
  check('🔴 未刷新 traits 时不得产出任何特质档意图',
    !!unRefreshedIntent
      && TRAIT_KINDS.every((k) => unRefreshedIntent.kind !== k),
    JSON.stringify(unRefreshedIntent));
})();

console.log('\n' + (failures ? failures + ' 项失败' : 'trigger 层测试全部通过'));
process.exit(failures ? 1 : 0);
