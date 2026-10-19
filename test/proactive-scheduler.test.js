/**
 * 主动搭话调度的自愈性回归（2026-10-19）。
 *
 * ## 为什么必须单独成文
 *
 * 2026-10-19 实测事故：她整夜零开口。事后靠 experiment-telemetry.jsonl 里
 * 「有 perception_attach、没有 llm_call」与 Windows 电源日志才倒推出来，
 * 根因不是防骚扰铁律，而是 **调度器在一条 return 路径上漏了重排**：
 *
 *   `checkAndPushProactive()` 里 `if (offer) { send(...) }` 这一支只派发提案，
 *   不安排下一次 tick —— 全仓只有 6 处 scheduleProactiveCheck，这一支不在其中。
 *   于是整条主动搭话链的存续**完全押在渲染端的回执上**：
 *   回执（proactive-commit / proactive-declined / chat-send 的 finally）一丢，
 *   或者系统进 Modern Standby 把 IPC 与定时器一起冻住，调度就永久停摆，
 *   直到用户下一次互动才被重新叫醒。
 *
 * 这类缺陷有个共同形态：**它不报错、不抛异常、不影响任何单条消息**，
 * 只是让一条通路从此不再发生。所以断言只能打在「有没有安排下一次」上，
 * 而这件事在 main.js 里没有被导出 —— 只能把函数抽出来真的跑一遍。
 *
 * ## 为什么不并进 test/main.test.js
 *
 * main.test.js 已经 95 项，且它跑的是**完整假 electron 环境**（模块级状态、
 * IPC 注册顺序都敏感）。本节只需要一个能记账的 scheduleProactiveCheck 桩，
 * 挤进去会为了测调度而污染别人的状态 —— 那是用假信号换真结论。
 * 抽取手法与 test/d17-selfnote-exempt.test.js 同源（new Function 直接求值，
 * 不用正则截取函数体：正则少一个闭括号会让 harness 崩掉，看起来像实现坏了）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

/* ============================================================
 * 一、把实现抽出来（不截取、不替换，整段交给 Function 求值）
 * ============================================================ */

/** 调度用到的常量与两个私有 helper（D-25 收口 + 派发留痕）。 */
function headSource() {
  const a = mainSrc.indexOf('const OFFER_RETRY_MS');
  const b = mainSrc.indexOf('function scheduleProactiveCheck');
  if (a < 0 || b < 0 || b <= a) throw new Error('找不到调度常量/helper 段');
  return mainSrc.slice(a, b);
}

/** checkAndPushProactive 本体：从函数头切到下一条注释锚点。 */
function tickSource() {
  const a = mainSrc.indexOf('function checkAndPushProactive(');
  const b = mainSrc.indexOf('// 🔴 D-7：她说完（或被礼貌闸门拒了）之后的收尾');
  if (a < 0 || b < 0 || b <= a) throw new Error('找不到 checkAndPushProactive 段');
  return mainSrc.slice(a, b);
}

const COOLDOWN = 45000;   // 与 src/trigger.js 的 COOLDOWN_MS 同值，抽出来当参数传入

/**
 * 造一台可观测的 harness。
 * @param {object} world { trigger, brain, win, tracker }
 * @returns {{calls:number[], lastDelay:?number, sent:any[], audit:any[], tick:Function, evalCuriosity:Function}}
 */
function makeHarness(world) {
  const calls = [];       // 每次重排的延迟，按顺序记
  const sent = [];        // 真的派发出去的提案
  const audit = [];       // 审计调用记录
  const body = headSource() + '\n' + tickSource()
    + '\n; return { checkAndPushProactive, evaluateTriggerWithCuriosity, auditProactiveDispatched };';
  const factory = new Function(
    'trigger', 'brain', 'win', 'tracker', 'proactiveBaseMs', 'scheduleProactiveCheck',
    'proactiveAuditLog', 'COOLDOWN_MS', 'OFFER_TTL_MS',
    body);
  const api = factory(
    world.trigger, world.brain, world.win, world.tracker,
    () => 30 * 60000,                       // proactiveBaseMs：固定 30 分钟基准
    (d) => calls.push(d),                   // scheduleProactiveCheck：只记账，不真起定时器
    world.auditLog === undefined
      ? { append: (r) => audit.push(r) }
      : world.auditLog,
    COOLDOWN,
    COOLDOWN);
  return { calls, sent, audit, tick: api.checkAndPushProactive, evalCuriosity: api.evaluateTriggerWithCuriosity };
}

/** 一个「已就绪」的世界：brain.ready、窗口活着、静默 45 分钟。 */
function readyWorld(over) {
  const o = over || {};
  const windowSent = o.sent || [];
  return Object.assign({
    trigger: {
      evaluate: o.evaluate || (() => null),
      idleMs: 30 * 60000,
    },
    brain: { ready: true, memory: o.memory === undefined ? null : o.memory },
    win: {
      isDestroyed: () => false,
      webContents: { send: (c, p) => windowSent.push([c, p]) },
    },
    tracker: {
      lastInteractionAt: Date.now() - 45 * 60000,
      recordIdle: () => {},
    },
    sent: windowSent,
  }, o);
}

/* ============================================================
 * 二、行为断言：每一条 return 路径都必须安排下一次
 * ============================================================ */

/* ① brain 未就绪（冷启动没填 Key）：旧实现直接 return，调度器当场停摆。 */
{
  const h = makeHarness(readyWorld({ brain: { ready: false, memory: null } }));
  h.tick();
  check('① brain 未就绪时仍然安排了下一次（旧实现在这里永久停摆）',
    h.calls.length === 1 && h.calls[0] === 60000,
    'calls=' + JSON.stringify(h.calls));
}

/* ② 窗口已销毁：同上，且绝不能往已销毁的 webContents 上 send。 */
{
  const world = readyWorld();
  world.win = { isDestroyed: () => true, webContents: { send: () => { throw new Error('不该 send'); } } };
  const h = makeHarness(world);
  let threw = false;
  try { h.tick(); } catch (e) { threw = true; }
  check('② 窗口已销毁时仍然安排下一次，且不往死窗口派发',
    !threw && h.calls.length === 1 && h.calls[0] === 60000,
    'threw=' + threw + ' calls=' + JSON.stringify(h.calls));
}

/* ③ trigger 还没建（启动早期）：同样不许停摆。 */
{
  const h = makeHarness(readyWorld({ trigger: null }));
  h.tick();
  check('③ trigger 未就绪时仍然安排了下一次',
    h.calls.length === 1 && h.calls[0] === 60000,
    'calls=' + JSON.stringify(h.calls));
}

/* ④ 派发了提案：必须安排一次自愈重排（90 秒 = TTL + 冷却）。 */
{
  const sent = [];
  const offer = { kind: 'idle', at: Date.now(), reason: '用户已经离开 45 分钟' };
  const h = makeHarness(readyWorld({ sent, evaluate: () => offer }));
  h.tick();
  check('④ 派发提案后安排了自愈重排（90 秒 = 提案 TTL + 冷却）',
    h.calls.length === 1 && h.calls[0] === 90000,
    'calls=' + JSON.stringify(h.calls));
  check('④b 提案真的派发到了渲染端（且只派发一次）',
    sent.length === 1 && sent[0][0] === 'proactive-offer',
    'sent=' + JSON.stringify(sent.map((s) => s[0])));
}

/* ⑤ 派发成功的同一次 tick 里，绝不重复派发（防同拍连发）。 */
{
  const sent = [];
  let evalCount = 0;
  const h = makeHarness(readyWorld({
    sent,
    evaluate: () => { evalCount++; return { kind: 'idle', at: Date.now() }; },
  }));
  h.tick();
  check('⑤ 一次 tick 只评估一次、只派发一次（不因重排而当场重入）',
    evalCount === 1 && sent.length === 1,
    'eval=' + evalCount + ' sent=' + sent.length);
}

/* ⑥ 无提案：照旧按既有口径安排（不小于冷却、不大于 10 分钟）。 */
{
  const h = makeHarness(readyWorld({ evaluate: () => null }));
  h.tick();
  check('⑥ 无提案时安排在 [冷却, 10 分钟] 之间（既有口径不变）',
    h.calls.length === 1 && h.calls[0] >= COOLDOWN && h.calls[0] <= 10 * 60000,
    'calls=' + JSON.stringify(h.calls));
}

/* ⑦ 派发留痕：审计拿到的是元数据，不含提案正文。 */
{
  const sent = [];
  const offer = {
    kind: 'idle', at: Date.now(), reason: '用户已经离开 45 分钟',
    hint: '轻声问候一句', selfIntent: { kind: 'curiosityAsk', direction: '想问一个自己没解开的问题' },
  };
  const h = makeHarness(readyWorld({ sent, evaluate: () => offer }));
  h.tick();
  const rec = h.audit[0] || {};
  const dumped = JSON.stringify(rec);
  check('⑦ 派发时写了审计留痕，且只记种类不记正文',
    rec.channel === 'proactive-offer' && rec.outcome === 'dispatched'
    && rec.offerKind === 'idle' && rec.selfIntentKind === 'curiosityAsk'
    && dumped.indexOf('用户已经离开') < 0 && dumped.indexOf('轻声问候') < 0,
    dumped);
}

/* ⑧ 审计写失败绝不能挡住派发（审计是证据，不是前置条件）。 */
{
  const sent = [];
  const h = makeHarness(readyWorld({
    sent,
    evaluate: () => ({ kind: 'idle', at: Date.now() }),
    auditLog: { append: () => { throw new Error('disk full'); } },
  }));
  let threw = false;
  try { h.tick(); } catch (e) { threw = true; }
  check('⑧ 审计抛异常时提案照常派发、调度照常重排（绝不静默停摆）',
    !threw && sent.length === 1 && h.calls.length === 1,
    'threw=' + threw + ' sent=' + sent.length + ' calls=' + h.calls.length);
}

/* ============================================================
 * 三、D-25 收口：两条入口必须共用同一份好奇事实
 * ============================================================ */

/* ⑨ 行为：evaluateTriggerWithCuriosity 真的把待问计数与队首原话交给引擎。 */
{
  let seen = null;
  const memory = {
    data: { curiosityQueue: [{ q: 'a', asked: false }, { q: 'b', asked: true }, { q: 'c' }] },
    nextCuriosity: () => ({ q: 'a' }),
  };
  const h = makeHarness(readyWorld({
    memory,
    evaluate: (facts) => { seen = facts; return null; },
  }));
  h.evalCuriosity();
  check('⑨ 评估时把 curiosityPending（跳过已问）与队首原话传给引擎',
    seen && seen.curiosityPending === 2 && seen.curiosityQuestion && seen.curiosityQuestion.q === 'a',
    JSON.stringify(seen));
}

/* ⑩ 行为：memory 缺席（启动早期）时给 null 事实，不抛。 */
{
  let seen = 'unset';
  const h = makeHarness(readyWorld({
    memory: null,
    evaluate: (facts) => { seen = facts; return null; },
  }));
  let threw = false;
  try { h.evalCuriosity(); } catch (e) { threw = true; }
  check('⑩ memory 缺席时降级成空事实而不是抛（启动早期可达）',
    !threw && seen && seen.curiosityPending === 0 && seen.curiosityQuestion === null,
    'threw=' + threw + ' facts=' + JSON.stringify(seen));
}

/* ============================================================
 * 四、接线断言（这类修复一旦被「顺手改回去」必须变红）
 * ============================================================ */

const tickSrc = tickSource();
{
  const scheduleHits = (tickSrc.match(/scheduleProactiveCheck\(/g) || []).length;
  check('⑪ checkAndPushProactive 内重排点 ≥ 3（未就绪 / 已派发 / 无提案三条出口）',
    scheduleHits >= 3, 'hits=' + scheduleHits);
}
check('⑫ proactive-check IPC 走收口后的评估函数（否则 D-25 只剩后台半边）',
  /ipcGuard\.handle\('proactive-check'[\s\S]{0,1500}?return evaluateTriggerWithCuriosity\(\)/
    .test(mainSrc)
  && !/ipcGuard\.handle\('proactive-check'[\s\S]{0,1500}?return trigger\.evaluate\(\)/
    .test(mainSrc));
check('⑬ 派发提案时写了审计（proactive-offer 留痕）',
  /win\.webContents\.send\('proactive-offer'[\s\S]{0,200}?auditProactiveDispatched\(offer\)/.test(mainSrc));
check('⑭ 填/换 Key 成功后重新叫醒调度（否则填完 Key 她仍不开口）',
  /ipcGuard\.handle\('config-set-key'[\s\S]{0,1200}?scheduleProactiveCheck\(proactiveBaseMs\(\)\)/
    .test(mainSrc));
check('⑮ 系统 resume 后对齐调度，且先等一个冷却才复查（刚醒就说话最像软件）',
  /powerMonitor\.on\('resume',\s*\(\)\s*=>\s*scheduleProactiveCheck\(COOLDOWN_MS\)\)/.test(mainSrc));
check('⑯ 派发后的自愈重排常量等于「提案 TTL + 冷却」（不是随手拍的数）',
  /const OFFER_RETRY_MS = OFFER_TTL_MS \+ COOLDOWN_MS;/.test(mainSrc));

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
