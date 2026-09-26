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

console.log('\n' + (failures ? failures + ' 项失败' : 'trigger 层测试全部通过'));
process.exit(failures ? 1 : 0);
