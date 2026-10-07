/**
 * src/agent-trigger.js
 *
 * v1.0 D-6：提案触发源总开关。
 *
 * ## 为什么不直接把开关写进 brain.ask()
 *
 * 本轮接线的性质必须先说清楚：D-5 之后**沙盒写权限已经开了**，
 * 而触发源此前是零调用点。所以当前挡住误写的只剩「没人按按钮」这一道 ——
 * **接线那一刻，这道门就没了**。
 *
 * 因此这个开关不是「一个配置项」，是**接线前的最后一道闸门**，
 * 必须能被单独测试。写进 ask() 里就没法做本轮的核心断言：
 * 「开关关闭时 shouldProposeFrom 根本不跑」——
 * 那需要能替换判定函数来数调用次数。
 *
 * 所以形态是：**一个纯函数 + 依赖注入**。
 * 上层（brain.ask）只调用本模块，本模块决定要不要调判定函数。
 *
 * ## 🔴 本轮最重要的一条：关闭时判定函数根本不跑
 *
 * 不是「跑一遍判定为 false」，是**一次都不调用**。理由三条：
 *   1. 省算力：判定每轮都跑，白跑就是白跑；
 *   2. 少一条出错路径：判定逻辑出 bug 时，关闭态不该受它影响；
 *   3. 可验证：调用次数 0 是一个**精确的事实**，
 *      而「结果为 false」可以和「判定跑了但返回 false」混为一谈 ——
 *      这正是本仓栽过的「断言结果而非判据」的假反例同型。
 *
 * ## ⚠️ 本模块不碰 persona.js
 *
 * 触发条件在 agent-intent.js（27 项门禁锁死），人格红线在 persona.js:29。
 * 本模块只在两者之间加一道「要不要跑」的闸门，**不放宽任何判定条件**。
 */

/**
 * 总开关判定：**要不要跑意图判定**。
 *
 * 纯函数、无副作用、可单测。deps 注入是为了让「调用次数」可断言。
 *
 * @param {string} userText 用户这一轮说的话
 * @param {object} [opts]
 * @param {object} [opts.config] life-config.json 解析后的配置
 * @param {function} [opts.intent] 意图判定函数（默认 agent-intent.shouldProposeFrom）
 * @param {boolean} [opts.proactive] 是否是她主动搭话（主动搭话一律不触发）
 * @returns {{ran:boolean, enabled:boolean, decision:object|null}}
 *   ran=false 表示**判定函数没被调用** —— 这是本模块最关键的事实。
 */
function evaluateTrigger(userText, opts = {}) {
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};

  // 1. 开关判定：只认**严格 true**，其余一律视为关。
  //   为什么不用 `!== false`（与 motionEnabled 一致）：那会让「键缺失」
  //   被当成 true —— 而本开关缺失时必须安全。键缺失 = false。
  const enabled = config.agentTriggerEnabled === true;

  // 2. 她主动搭话时永不触发。这是人格层的要求：
  //   「她主动开口」与「她主动要求动手」是两件完全不同的事，
  //   后者会立刻变成一次确认卡片 —— 那正是 persona.js:29
  //   「不虚构寂寞 / 不数着时间等你 / 装可怜不行」要防的形态。
  if (opts.proactive === true) {
    return { ran: false, enabled: enabled, decision: null };
  }

  // 3. 🔴 核心：关闭时**直接返回，一次都不调判定函数**。
  if (!enabled) {
    return { ran: false, enabled: false, decision: null };
  }

  // 4. 开关开着才跑判定。依赖注入在这里生效。
  const intent = opts.intent || require('./agent-intent').shouldProposeFrom;
  let decision = null;
  try {
    decision = intent(userText);
  } catch (err) {
    // 判定函数抛错**不能带崩对话** —— 它是便利功能，不是对话链路的一部分。
    // 如实降级为「不触发」，错误信息留给上层记录，而不是变成用户看到的一坨报错。
    return {
      ran: true,
      enabled: true,
      decision: null,
      error: String((err && err.message) || '').slice(0, 200),
    };
  }
  return { ran: true, enabled: true, decision: decision };
}

module.exports = { evaluateTrigger };
