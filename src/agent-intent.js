/**
 * src/agent-intent.js
 *
 * v1.0 D-5：提案触发源判定（「只在用户明确要求时提案」）。
 *
 * ## 为什么单独一个文件
 *
 * 触发条件是本仓**最不该随手改**的东西之一：它决定「她会不会在用户没说话时
 * 主动弹确认框」。判错的后果不是 bug，是她的人格被改写 ——
 * persona.js:29 的红线（不虚构寂寞/ 不数着时间等你 / 装可怜不行）会被
 * 一个「她突然想整理你的文件」的主动行为从侧面破坏。
 *
 * 所以这里是**纯函数 + 零依赖 + 可单测**：改错了门禁会红，而人格链路一行没碰。
 *
 * ## 🔴 触发条件：必须同时满足四条，缺一不建案
 *
 *   1. **用户明确要求**—— 出现祈使/请求类动词（帮我/ 写一下 / 存到 / 整理…）。
 *   2. **提到具体目标** —— 带路径或文件名。缺目标就无法建案：
 *      执行器的 scope 白名单必须落在沙盒内，没有目标就没有合法 scope。
 *   3. **不是问句** —— 「你能帮我写吗」是询问，不是授权。
 *      真要授权时说「帮我写」，这个区分是本模块存在的理由之一。
 *   4. **目标看起来落在沙盒里** —— 提到桌面/LifeSandbox/沙盒 等词。
 *      这条最宽松也只是**提示**，真正的路径判定在主进程
 *      PermissionPolicy.authorize()（越界一律 AUTHORIZED_REJECTED）。
 *
 * ## 为什么不做「按概率/按心情」的触发
 *
 * 用户 2026-10-06 拍板：「默认零打扰是产品底线，不是省事。」
 * 一个偶尔自己冒出来的确认框，会让桌宠看起来像个后台常驻程序在催活，
 * 而不是一个有分寸的同伴。这条不是保守，是人格一致性的下限。
 *
 * 边界：本模块**不建案、不碰 IPC、不读文件**。它只回答「这句话该不该触发提案」，
 * 由主进程据此决定是否调 agent:propose-action。判定为 false 不是错误，是常态。
 *
 * ============================================================================
 * 🔴🔴 2026-10-06 D-6 审核实测发现的两个真实边界（读本模块前必看）
 * ============================================================================
 *
 * ## 缺陷一：真实中文（不打空格）目前一条都命中不了
 *
 * 实测（真实意图模块，非 spy）：
 *   「帮我把整理.md存到沙盒」     → MISS（NO_CONCRETE_TARGET）
 *   「整理.md存到沙盒」          → MISS
 *   「帮我把笔记.txt存到沙盒」    → MISS
 *   而带空格的「帮我把整理.md 存到沙盒」→ HIT
 *
 * 根因：FILENAME_RE 要求 token 句尾是扩展名（带 $ 锚定）。
 *   中文习惯不打空格，于是整句被当成一个 token，句尾是「沙盒」不是「.md」，
 *   永远匹配不上。
 *
 * ⚠️ 这条缺陷能藏住，是因为**门禁的正例本身就写错了形态**：
 *   27 项门禁里的正例全是「整理.md 存到桌面」这种带空格的写法，
 *   而真人打字不会加空格。
 *   这是本仓「门禁只测正例、缺陷藏在绿色里」纪律的一次新变体 ——
 *   2026-10-06 白天我修好了「分词把点当分隔符」那个 bug，
 *   却没发现**修完之后正例的形态本身就不真实**，等于把 bug 藏进了测试里。
 *
 *   修法方向（D-6a 单独一轮做，不在 D-6 顺手改）：
 *     FILENAME_RE 去掉句尾锚定，改为在 token 内搜索扩展名片段。
 *   但那会改动 27 项门禁的正例形态，必须配套变异测试，故单独排期。
 *
 *   在修好之前：本模块在真实使用中等于「永远不触发」。
 *   接线（brain.ask 旁路）与开关都已就位，但用户真说出来她时什么也不会发生 ——
 *   这不是配置问题，是判定逻辑的已知边界。
 *
 * ## 边界二：本模块只有写意图，没有任何读动作
 *
 * shouldProposeFrom 命中时固定产出 capability: 'workspace.write'，
 * 从不产出 workspace.read。也就是说「帮我整理」这类语义
 * （天然需要先读才知道要写什么）在 D-6 铺通后依然读不到任何文件。
 *
 * ⚠️ 别让下一个人以为读路径已经通了：沙盒里能读文件的是**执行器**
 *   （agent-executor.js 的 _readFile），但没有任何逻辑会自动去调用它 ——
 *   读能力是有的，**读意图**是没有的。
 */

const path = require('path');

/** 明确请求的动词。刻意要求用户自己说出来，缺省时一条都不匹配。 */
const REQUEST_VERBS = [
  '帮我', '帮忙', '替我', '给我写', '写一下', '写个',
  '存到', '保存到', '存一下', '保存', '归档',
  '整理', '归整', '收拾', '清理一下',
];

/** 目标提示词：出现其一即认为「提到了具体位置」。 */
const TARGET_HINTS = ['桌面', 'lifeandbox', '沙盒', '桌面上'];

/** 文件名/路径的粗判：带扩展名，或含路径分隔符。 */
const FILENAME_RE = /\.[a-z0-9]{1,8}$/i;
const HAS_SEP_RE = /[\\\/]/;

/**
 * 剥掉目标名前缀里的动词与连接词。
 *
 * 中文没有空格分词，「帮我把整理.md」整体就是一个 token，
 * basename 之后仍带「帮我把」—— 直接拿去拼路径会生成一个叫
 * 「帮我把整理.md」的文件，那是错的。
 *
 * 循环剥而不是一次替换：「帮我把整理」这类可能叠着「帮我」+「把」。
 */
function stripVerbPrefix(name, verb) {
  let out = String(name || '');
  for (const v of REQUEST_VERBS) {
    while (out.startsWith(v)) out = out.slice(v.length);
  }
  // 连接词与量词：把/ 的/ 一个/ 这个 …… 只剥**开头连续**的，不动中间。
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of ['把', '的', '到', '给', '一个', '这个', '一份', '一下']) {
      if (out.startsWith(w)) { out = out.slice(w.length); changed = true; }
    }
  }
  return out || String(name || '');
}

/**
 * 纯函数判定：这句话该不该触发一个 Agent 提案。
 *
 * @param {string} userText 用户这一轮说的话（原文）
 * @param {object} [opts]
 * @param {string} [opts.sandboxName] 沙盒目录名，用于识别用户是否提到它
 * @returns {{shouldPropose:boolean, reason:string, capability:string|null, hint:string|null}}
 */
function shouldProposeFrom(userText, opts = {}) {
  const sandboxName = String(opts.sandboxName || 'LifeSandbox');

  // 反例防线（漏传参数类）：任何非字符串/空串一律不触发。
  //   注意是**静默返回 false 而不是抛错** —— 这条判定每个聊天轮次都会跑，
  //   为「一句话没说清」抛异常会把整个对话链路打崩，代价完全不成比例。
  const text = typeof userText === 'string' ? userText.trim() : '';
  if (!text) return { shouldPropose: false, reason: 'EMPTY_INPUT', capability: null, hint: null };

  // 条件 3：问句不是授权。必须先于动词判定 —— 「你能帮我写吗」含「帮我」，
  //   若不先排掉问句，会把一句询问当成授权，正是最危险的误判方向。
  if (/[?？]/.test(text)) {
    return { shouldPropose: false, reason: 'IS_QUESTION', capability: null, hint: null };
  }

  // 条件 1：必须是明确的请求动词。
  const lower = text.toLowerCase();
  const verbHit = REQUEST_VERBS.find((v) => lower.includes(v));
  if (!verbHit) {
    return { shouldPropose: false, reason: 'NO_REQUEST_VERB', capability: null, hint: null };
  }

  // 条件 4：目标提示词。找不到就不提 —— 因为我们不知道用户指的是哪个文件。
  const hintHit = TARGET_HINTS.find((h) => lower.includes(h))
    || (lower.includes(sandboxName.toLowerCase()) ? sandboxName : null);
  if (!hintHit) {
    return { shouldPropose: false, reason: 'NO_TARGET_HINT', capability: null, hint: null };
  }

  // 条件 2：必须能提取出一个像样的目标（文件名或路径）。
  //
  // 🔴 2026-10-06 实测修正：分词**不能**把 '.' 当分隔符。
  //   初版写成 /[\s，。！？、,.!?]+/，结果「整理.md」被拆成 ['整理','md']，
  //   扩展名永远匹配不到 —— 于是**所有正例全部漏判**（实测 3 条正例 0 条通过）。
  //   这是本仓栽过的又一次「意外正确」的兄弟：门禁没覆盖正例，缺陷就藏住了。
  //   所以 '.' 保留在词内，只切真正是分隔符的空白与中文标点。
  const tokens = text.split(/[\s，。！？、]+/).filter(Boolean);
  const target = tokens.find((tk) => FILENAME_RE.test(tk) || HAS_SEP_RE.test(tk)) || null;
  if (!target) {
    return { shouldPropose: false, reason: 'NO_CONCRETE_TARGET', capability: null, hint: hintHit };
  }

  // ⚠️ 这里**只给能力建议，不给绝对路径**。
  //   路径的最终形态由主进程拼装并交给 PermissionPolicy.authorize() 判定；
  //   渲染端/判定层若自行拼绝对路径，那条白名单就等于被绕过了一层。
  return {
    shouldPropose: true,
    reason: 'EXPLICIT_REQUEST',
    capability: 'workspace.write',
    // ⚠️ basename 之后再剥掉前缀动词：中文没有空格分词，
    //   「帮我把整理.md」会整体成为一个 token，basename 出来仍带着「帮我把」。
    //   交给主进程拼路径时这个前缀会成为文件名的一部分，必须去掉。
    hint: stripVerbPrefix(path.basename(target), verbHit),
  };
}

module.exports = { shouldProposeFrom, REQUEST_VERBS, TARGET_HINTS };
