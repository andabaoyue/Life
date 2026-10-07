/**
 * test/d25-curiosity-probe.test.js
 *
 * D-25 门禁：好奇破冰 —— 她会在安静时主动问出自己的未解疑问。
 *
 * ## 这一轮补的是哪块（§4.7「两段式」第二段，用户拍板开工）
 *   轻版已落地：curiosityQueue 进视野、回复中自然带问。
 *   本层补主动的那一半：闲置 30 分钟 + 队列有真问题 ⇒ 主动开口发问。
 *
 * ## 两条拍板（2026-10）
 *   ① 出队时机 = **关窗**：开口只打 asked 标记，队列增删统一落关窗 ——
 *      【尚未解开的疑问】长在 systemText 里，队列一变就破前缀缓存；
 *   ② 频率 = 闲置 30 分钟 + 独立节流 40 分钟（外加 45s 冷却 / 挂机刹车 / 睡眠闸门）。
 *
 * ## 五条红线（对应 D-24 同族纪律）
 *   1. 前缀缓存不变式：asked 标记对注入文本零影响，出队只在关窗（逐字节断言）
 *   2. 数据不伪造：队列空不产意图；匹配不上原话绝不猜着标记
 *   3. 不预设台词：问题文本 = 她的原话引证，问法由她现场组织
 *   4. 三闸门不可绕过：睡眠 / 冷却 / 挂机刹车对 curiosityAsk 一视同仁
 *   5. 判据③种类穷举：curiosityAsk 显式登记在 SELF_INTENT_KINDS，不走泛化遍历
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TriggerEngine, computeSelfIntent, SELF_INTENT_KINDS,
  CURIOSITY_THROTTLE_MS,
} = require('../src/trigger');
const { Memory } = require('../src/memory');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
// 不清理的话单次跑净留 N 个沙盒目录（%TEMP% 累积投诉的根因，见 tmp-hygiene.test.js 头注释）。
const _hygDirs = [];
const _hygOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _hygOrigMkdtemp.apply(fs, a);
  _hygDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _hygDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掀桌 */ }
  }
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'd25-')); }
function freshMem(dir) { return new Memory(dir || freshDir(), { persona: 'P' }); }

// 可控假时钟 + 假 tracker（trigger 是纯逻辑：时钟与事实全部由调用方供）
function fakeEnv(over = {}) {
  let now = over.at || 1_000_000;
  const tracker = {
    sleepMode: over.sleepMode === true,
    lastInteractionAt: now - (over.idleMs || 0),
    spokenDuringIdle: over.spokenDuringIdle === true,
    selfNoteDuringIdle: false,
    recentClicks: () => 0,
  };
  const engine = new TriggerEngine(tracker, {
    now: () => now,
    idleMs: 30 * 60000,
    cooldownMs: 45000,
    curiosityIdleMs: 30 * 60000,
    curiosityThrottleMs: 40 * 60000,
  });
  return { engine, tracker, tick: (ms) => { now += ms; } };
}

console.log('--- D-25 好奇破冰门禁 ---');

/* ============ 1. 种类穷举表登记（判据③） ============ */
{
  check('🔴 curiosityAsk 显式登记在意图种类穷举表', SELF_INTENT_KINDS.curiosityAsk != null);
  check('来源声明是 memory.curiosityQueue 的计数（非特质、非新状态机）',
    SELF_INTENT_KINDS.curiosityAsk.requires === 'curiosity_pending', 'requires=' + SELF_INTENT_KINDS.curiosityAsk.requires);
  check('静默阈值默认 30 分钟（拍板②）', SELF_INTENT_KINDS.curiosityAsk.min === 30, 'min=' + SELF_INTENT_KINDS.curiosityAsk.min);
}

/* ============ 2. 纯函数：产出与边界 ============ */
{
  const base = { idleMinutes: 30, curiosityPending: 1, curiosityQuestion: '雨停了吗' };
  const it = computeSelfIntent(base);
  check('队列非空 + 闲置 30 分钟 ⇒ 产出 curiosityAsk', it && it.kind === 'curiosityAsk', 'kind=' + (it && it.kind));
  check('🔴 sources 可追溯到 memory.curiosityQueue', it && it.sources && it.sources[0] === 'memory.curiosityQueue');
  check('question 字段 = 队首原话（不是代拟问法）', it && it.question === '雨停了吗', 'q=' + (it && it.question));
  check('方向带她的原话引证', it && it.direction.includes('雨停了吗'));
  check('❌ 队列空 ⇒ 不产意图（宁缺毋滥）', computeSelfIntent({ idleMinutes: 30, curiosityPending: 0 }) === null);
  check('❌ 闲置 29 分钟 ⇒ 不产（阈值下边界）', computeSelfIntent({ idleMinutes: 29, curiosityPending: 1, curiosityQuestion: 'x' }) === null);
  check('闲置恰好 30 分钟 ⇒ 产（阈值上边界）',
    (computeSelfIntent({ idleMinutes: 30, curiosityPending: 1, curiosityQuestion: 'x' }) || {}).kind === 'curiosityAsk');
  const blocked = computeSelfIntent({ idleMinutes: 60, curiosityPending: 1, curiosityQuestion: 'x', curiosityBlocked: true });
  check('❌ curiosityBlocked（40 分钟节流内）⇒ 好奇类整类不产',
    blocked === null || blocked.kind !== 'curiosityAsk', 'kind=' + (blocked && blocked.kind));
  check('被节流时不硬造替代意图，可退化给 idleness 档',
    blocked && blocked.kind === 'idleness_deep');
  check('curiosityMinMinutes 覆盖生效（联调用）',
    (computeSelfIntent({ idleMinutes: 5, curiosityPending: 1, curiosityQuestion: 'x', curiosityMinMinutes: 5 }) || {}).kind === 'curiosityAsk');
  const wts = computeSelfIntent({ idleMinutes: 130, curiosityPending: 1, curiosityQuestion: 'x' });
  check('wantToLeaveSomething（120min）优先于 curiosityAsk', wts && wts.kind === 'wantToLeaveSomething', 'kind=' + (wts && wts.kind));
  check('❌ curiosityPending 坏输入（负数）不产', computeSelfIntent({ idleMinutes: 30, curiosityPending: -1 }) === null);
  check('❌ curiosityPending 坏输入（NaN）不产', computeSelfIntent({ idleMinutes: 30, curiosityPending: NaN }) === null);
  check('❌ curiosityPending 坏输入（非数字串）不产', computeSelfIntent({ idleMinutes: 30, curiosityPending: 'abc' }) === null);
  // 数字串按既有口径强转（与 idleMinutes / traits 同款），不是新规则
  check('数字串输入与数字等价（沿用既有 Number 强转口径）',
    (computeSelfIntent({ idleMinutes: 30, curiosityPending: '2', curiosityQuestion: 'x' }) || {}).kind === 'curiosityAsk');
  const noQ = computeSelfIntent({ idleMinutes: 30, curiosityPending: 2, curiosityQuestion: '   ' });
  check('无队首原话时退化为「挑一个」方向 + question 空串',
    noQ && noQ.question === '' && noQ.direction.includes('挑'), 'd=' + (noQ && noQ.direction));
  const numeric = computeSelfIntent({ idleMinutes: 37, curiosityPending: 1, curiosityQuestion: '雨停了吗' });
  check('🔴 方向不泄漏程序时钟数字（M4 变异对应）', numeric && !numeric.direction.includes('37'), 'd=' + (numeric && numeric.direction));
}

/* ============ 3. 引擎：三闸门 + 双节流 ============ */
{
  const facts = { curiosityPending: 1, curiosityQuestion: '雨停了吗' };
  {
    const e = fakeEnv({ sleepMode: true, idleMs: 60 * 60000 });
    check('❌ 睡着不出（curiosityAsk 不绕睡眠闸门）', e.engine.evaluate(facts) === null);
  }
  {
    const e = fakeEnv({ idleMs: 60 * 60000 });
    const out = e.engine.evaluate(facts);
    check('30 分钟闲置 + 队列 ⇒ evaluate 真的出提案', out && out.kind === 'idle', 'kind=' + (out && out.kind));
    check('提案上带着 curiosityAsk 意图', out && out.selfIntent && out.selfIntent.kind === 'curiosityAsk');
    e.engine.commit(out);
    check('❌ commit 后 40 分钟节流内不再出（M1 变异对应）',
      e.engine.evaluate(facts) === null || (e.engine.evaluate(facts).selfIntent || {}).kind !== 'curiosityAsk');
    // 模拟「用户来了又走」—— spokenDuringIdle 只被真实互动解除（D-16 铁律），
    // 测试要验的是节流解除，不能顺手绕过这道刹车。
    e.tick(41 * 60000);
    e.tracker.spokenDuringIdle = false;
    e.tracker.lastInteractionAt = e.engine.now() - 60 * 60000;
    const out2 = e.engine.evaluate(facts);
    check('40 分钟节流解除后可再问', out2 && out2.selfIntent && out2.selfIntent.kind === 'curiosityAsk');
  }
  {
    const e = fakeEnv({ idleMs: 60 * 60000 });
    const out = e.engine.evaluate(facts);
    // 不 commit（被渲染端礼貌闸门拒了）⇒ 节流不记账，下次还问
    const again = e.engine.evaluate(facts);
    check('未开口不记节流（被拒一次下次还问，同 commit 语义）',
      again && again.selfIntent && again.selfIntent.kind === 'curiosityAsk');
    e.engine.commit(out);
    check('开口即吃 spokenDuringIdle 刹车 —— 一次离开只问一个',
      e.tracker.spokenDuringIdle === true && e.engine.evaluate(facts) === null);
  }
  {
    const e = fakeEnv({ idleMs: 60 * 60000 });
    e.engine.lastFiredAt = e.engine.now() - 10000;   // 10 秒前说过
    check('❌ 45 秒冷却内不出（curiosityAsk 不绕冷却）', e.engine.evaluate(facts) === null);
  }
  {
    const e = fakeEnv({ idleMs: 5 * 60000 });
    check('❌ 闲置不足 30 分钟不出（引擎侧阈值同源）',
      e.engine.evaluate({ curiosityPending: 1, curiosityQuestion: 'x' }) === null);
    check('默认节流常量是 40 分钟（拍板②）', CURIOSITY_THROTTLE_MS === 40 * 60000);
  }
}

/* ============ 4. 🔴 护缓存红线：标记不动注入、出队只在关窗 ============ */
{
  const dir = freshDir();
  const m = freshMem(dir);
  m.data.curiosityQueue = [
    { q: '雨停了吗', windowNo: 1 },
    { q: '那个词是什么意思', windowNo: 1 },
  ];
  const sysBefore = JSON.stringify(m.build(''));
  const marked = m.markCuriosityAsked('雨停了吗');
  const sysAfter = JSON.stringify(m.build(''));
  check('asked 标记成功（对着队首原话精确匹配）', marked === true);
  check('🔴 标记前后注入文本逐字节相等（前缀缓存不变式）', sysBefore === sysAfter);
  check('🔴 标记只标不删（条目仍在队列里）', m.data.curiosityQueue.length === 2);
  check('标记幂等', m.markCuriosityAsked('雨停了吗') === true && m.data.curiosityQueue[0].asked === true);
  check('❌ 匹配不上原话绝不猜着标记（不伪造）', m.markCuriosityAsked('她根本没问过的问题') === false);
  check('nextCuriosity 跳过已问的，返回下一个', m.nextCuriosity() === '那个词是什么意思');
  const sysMid = JSON.stringify(m.build(''));
  check('🔴 未关窗前注入文本依旧逐字节稳定', sysBefore === sysMid);

  // 关窗出队 —— 唯一的出队点
  m.refreshCuriosity(['新冒出来的问题'], 2);
  const sysAfterClose = JSON.stringify(m.build(''));
  check('🔴 关窗时刻才出队已问的（唯一出队点）',
    m.data.curiosityQueue.length === 2
    && !m.data.curiosityQueue.some((x) => x.q === '雨停了吗')
    && m.data.curiosityQueue.some((x) => x.q === '那个词是什么意思'));
  check('关窗后新 unresolved 灌入且上限仍 ≤5', m.data.curiosityQueue.some((x) => x.q === '新冒出来的问题'));
  check('出队后注入文本才允许变化', sysAfterClose !== sysBefore);
  check('出队的条目是被问过的那个（未问的绝不误删）', !m.data.curiosityQueue.some((x) => x.q === '雨停了吗'));

  // 跨重启持久（关窗路径上 brain 会 save(true)，这里如实模拟落盘）
  m.save(true);
  const m2 = new Memory(dir, { persona: 'P' });
  check('🔴 跨重启后队列内容未丢（未问的还在）', m2.data.curiosityQueue.some((x) => x.q === '那个词是什么意思'));
  check('跨重启后已问的确实已出队（不是碰巧丢字段）',
    !m2.data.curiosityQueue.some((x) => x.q === '雨停了吗'));
}

/* ============ 5. 记账对账：markCuriosityAsked 与 intent.question 看的是同一条 ============ */
{
  const e = fakeEnv({ idleMs: 60 * 60000 });
  const dir = freshDir();
  const m = freshMem(dir);
  m.data.curiosityQueue = [{ q: '雨停了吗', windowNo: 1 }];
  const out = e.engine.evaluate({ curiosityPending: 1, curiosityQuestion: m.nextCuriosity() });
  check('意图里的 question 与 memory 队首逐字一致（对账键同源）',
    out && out.selfIntent && out.selfIntent.question === m.nextCuriosity());
  const okMark = m.markCuriosityAsked(out.selfIntent.question);
  check('出口按 intent.question 打标成功（链路闭环）', okMark === true && m.nextCuriosity() === null);
}

console.log(failures === 0 ? '全部通过' : ('失败 ' + failures + ' 项'));
process.exitCode = failures === 0 ? 0 : 1;
