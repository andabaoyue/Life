/**
 * test/agent-trigger.test.js
 *
 * v1.0 D-6：提案触发源总开关门禁。
 *
 * 🔴 本轮的核心断言只有一个，但它决定整轮成不成立：
 *   **开关关闭时 shouldProposeFrom 一次都不能被调用。**
 *
 * 为什么必须断言「调用次数 = 0」而不是「结果 = false」：
 *   「跑了一遍判定、返回 false」与「压根没跑」在结果上完全一样，
 *   只断言结果的话，守卫被删了测试照样全绿 —— 这正是本仓栽过的
 *   「断言结果而非判据」的假反例同型（上一轮 m2/m5 两个变异体就这么溜过去）。
 *   所以这里用**注入 spy 数调用次数**：这是精确事实，无法被下游兜住。
 */

const { evaluateTrigger } = require('../src/agent-trigger');
const { DEFAULTS, sanitize } = require('../src/config');
const { shouldProposeFrom } = require('../src/agent-intent');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

/** spy：数调用次数。这是本文件的核心工具。 */
function spyIntent(ret) {
  const s = {
    calls: 0,
    args: [],
    fn: function (text) {
      s.calls++;
      s.args.push(text);
      return ret === undefined
        ? { shouldPropose: true, reason: 'SPY', capability: 'workspace.write', hint: 'x.md' }
        : ret;
    },
  };
  return s;
}

console.log('--- D-6 Agent 触发源总开关门禁 ---');

/* ================= 1. 默认必须关 ================= */
{
  check('❌ 反例1 DEFAULTS.agentTriggerEnabled 默认为 false',
    DEFAULTS.agentTriggerEnabled === false, String(DEFAULTS.agentTriggerEnabled));

  check('❌ 反例1b sanitize({}) 缺键时必须回落 false（不得因缺键而开启）',
    sanitize({}).agentTriggerEnabled === false);

  check('❌ 反例1c 字符串 "true" 不得开启开关（只认严格布尔 true）',
    sanitize({ agentTriggerEnabled: 'true' }).agentTriggerEnabled === false);

  check('❌ 反例1d 数字 1 不得开启开关',
    sanitize({ agentTriggerEnabled: 1 }).agentTriggerEnabled === false);

  check('❌ 反例1e 磁盘真值 true 能开启（否则用户根本没法打开）',
    sanitize({ agentTriggerEnabled: true }).agentTriggerEnabled === true);
}

/* ================= 2. 核心：关闭时判定函数一次都不跑 ================= */
{
  const spy = spyIntent();
  const r = evaluateTrigger('帮我把整理.md 存到桌面上', { config: {}, intent: spy.fn });
  check('❌ 反例2 开关关闭时判定函数调用次数为 0（不是「跑了返回 false」）',
    spy.calls === 0, 'calls=' + spy.calls);
  check('❌ 反例2b ran 标志必须为 false', r.ran === false);
  check('❌ 反例2c enabled 标志必须为 false', r.enabled === false);

  const spy2 = spyIntent();
  evaluateTrigger('帮我把整理.md 存到桌面上', { intent: spy2.fn });
  check('❌ 反例2d 完全漏传 config 时判定函数仍不跑',
    spy2.calls === 0, 'calls=' + spy2.calls);

  const garbage = [null, 0, 1, 'true', '', [], true];
  const loud = [];
  for (const g of garbage) {
    const sp = spyIntent();
    evaluateTrigger('帮我把整理.md 存到桌面上', { config: g, intent: sp.fn });
    if (sp.calls !== 0) loud.push(JSON.stringify(String(g)));
  }
  check('❌ 反例2e config 为 7 种非法/缺省值时判定函数都不跑',
    loud.length === 0, loud.join(' '));
}

/* ================= 3. 打开时才跑判定 ================= */
{
  const spy = spyIntent();
  const r = evaluateTrigger('帮我把整理.md 存到桌面上', { config: { agentTriggerEnabled: true }, intent: spy.fn });
  check('开关打开时判定函数被调用一次', spy.calls === 1, 'calls=' + spy.calls);
  check('开关打开时 ran 为 true', r.ran === true);
  check('开关打开时原样透传判定结果', r.decision && r.decision.reason === 'SPY');
  check('开关打开时把原文交给判定函数（不改写用户输入）',
    spy.args[0] === '帮我把整理.md 存到桌面上', spy.args[0]);
}

/* ================= 4. 她主动搭话时永不触发 ================= */
{
  const spy = spyIntent();
  const r = evaluateTrigger('随便什么', { config: { agentTriggerEnabled: true }, proactive: true, intent: spy.fn });
  check('❌ 反例5 她主动搭话时判定函数不跑（即使开关开着）',
    spy.calls === 0, 'calls=' + spy.calls);
  check('❌ 反例5b proactive 时 ran 为 false', r.ran === false);

  const spy2 = spyIntent();
  evaluateTrigger('x', { config: { agentTriggerEnabled: true }, proactive: 'true', intent: spy2.fn });
  check('❌ 反例5c proactive 为字符串 "true" 不算主动搭话（正常走判定）',
    spy2.calls === 1, 'calls=' + spy2.calls);
}

/* ================= 5. 判定函数抛错不得带崩对话 ================= */
{
  let calls = 0;
  const boom = function () { calls++; throw new Error('判定炸了'); };
  const r = evaluateTrigger('帮我整理 notes.md 到桌面', { config: { agentTriggerEnabled: true }, intent: boom });
  check('❌ 反例6 判定函数抛错被降级为不触发（不向上抛）',
    calls === 1 && r.ran === true && r.decision === null);
  check('❌ 反例6b 抛错时带上错误信息供上层记录',
    typeof r.error === 'string' && r.error.length > 0, String(r.error));
}

/* ================= 6. 与真实意图模块的集成 ================= */
{
  const text = '帮我把整理.md 存到桌面上';
  const direct = shouldProposeFrom(text);
  const on = evaluateTrigger(text, { config: { agentTriggerEnabled: true } });
  check('❌ 反例7 开关打开时结果与直接调用 agent-intent 完全一致',
    on.decision.shouldPropose === direct.shouldPropose
    && on.decision.reason === direct.reason,
    JSON.stringify(on.decision));

  const off = evaluateTrigger(text, { config: {} });
  check('❌ 反例7b 开关关闭时即便该触发也不触发（ran=false 且 decision=null）',
    off.ran === false && off.decision === null);

  const chatty = ['今天天气不错', '我有点困了', '你在吗'];
  const leaked = [];
  for (const c of chatty) {
    const d = shouldProposeFrom(c);
    if (d.shouldPropose) leaked.push(c);
  }
  check('❌ 反例8 闲聊类输入在真实意图模块下均不触发（闸门未放宽条件）',
    leaked.length === 0, leaked.join(' '));
}

console.log('');
console.log('总计 ' + pass + ' 项通过 / ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
