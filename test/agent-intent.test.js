/**
 * test/agent-intent.test.js
 *
 * v1.0 D-5：提案触发源判定门禁。
 *
 * 🔴 为什么要单独测这个模块（2026-10-06 审核补记）：
 *   agent-intent.js 决定「她会不会在用户没要求时主动弹确认框」。
 *   判错的后果不是 bug，是 persona.js:29 那条红线
 *   （不虚构寂寞 / 不数着时间等你 / 装可怜不行）被从侧面破坏 ——
 *   一个「她突然想整理你的文件」的主动行为，比任何虚构都更伤人格一致性。
 *
 *   所以这个模块的门禁**必须锁死「什么时候不该触发」**，而不只是正例。
 *
 * 本文件覆盖的三类反例（门禁第一铁律）：
 *   ① 漏传参数：空串 / null / undefined / 数字 / 数组 / 对象 —— 一个都不能触发；
 *   ② 恶意变体：问句伪装成请求（「你能帮我写吗」含动词但是询问）；
 *   ③ 边界值：只有动词无目标 / 只有目标无动词 / 只有路径无位置提示。
 *
 * ⚠️ 一条实测踩过的坑（分词）：
 *   初版分词把 '.' 当分隔符，「整理.md」被拆成 ['整理','md']，
 *   扩展名永远匹配不到 —— **全部正例漏判**且门禁无感。
 *   本文件第 1 组正例就是为守住那条修好的分词逻辑而存在的。
 */

const { shouldProposeFrom } = require('../src/agent-intent');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

console.log('--- D-5 Agent 触发源门禁 ---');

/* ================= 1. 正例：明确要求时应触发 ================= */
{
  // 🔴 这组是守住「分词不再把 '.' 当分隔符」的防线。
  //   分词一坏，这三条会全部漏判 —— 而漏判恰好是最容易被忽略的失败方向。
  check('正例1 中文文件名+请求动词+桌面提示 → 触发',
    shouldProposeFrom('帮我把整理.md 存到桌面上').shouldPropose === true);

  check('正例2 英文文件名+空格分隔 → 触发',
    shouldProposeFrom('帮我写一下 notes.txt 放到桌面').shouldPropose === true);

  check('正例3 带完整路径 → 触发',
    shouldProposeFrom('帮我把 C:/x/notes.txt 存到桌面').shouldPropose === true);

  // hint 必须是**干净的 basename**，不能带着「帮我把」前缀 ——
  //   否则主进程会拼出一个叫「帮我把整理.md」的文件。
  const h1 = shouldProposeFrom('帮我把整理.md 存到桌面上').hint;
  check('正例4 hint 剥掉动词前缀（中文无空格分词，前缀会被吞进文件名）',
    h1 === '整理.md', h1);

  check('正例5 命中后 capability 固定为 workspace.write',
    shouldProposeFrom('帮我整理桌面的 readme.md').capability === 'workspace.write');

  check('正例6 reason 为 EXPLICIT_REQUEST',
    shouldProposeFrom('帮我整理桌面的 readme.md').reason === 'EXPLICIT_REQUEST');

  check('正例7 提到沙盒目录名本身也算位置提示',
    shouldProposeFrom('帮我保存 report.md 到 LifeSandbox').shouldPropose === true);
}

/* ================= 2. 反例：不该触发（零打扰是产品底线） ================= */
{
  // 🔴 反例1：非字符串/空值一个都不能触发。
  //   注意这里是**静默 false** 而不是抛错 —— 判定每轮都跑，
  //   抛异常会把整个对话链路打崩。
  const bad = [null, undefined, '', '   ', 123, 0, true, [], {}, NaN];
  const loud = [];
  for (const v of bad) {
    const r = shouldProposeFrom(v);
    if (r.shouldPropose !== false) loud.push(JSON.stringify(String(v)) + '=>true');
  }
  check('❌ 反例1 漏传参数/非字符串共 10 种输入全部不触发', loud.length === 0, loud.join(' '));

  // 🔴 反例1b（变异测试逼出来的）：**不能只断言「结果是false」**。
  //   变异 m5 删掉空输入守卫后测试仍全绿 —— 因为下游「无请求动词」守卫
  //   把空串/null 也挡住了。**结果没变不等于守卫被测到**。
  //   所以这里必须断言**守卫自己的判据**：reason 必须是 EMPTY_INPUT。
  //   （这是本仓栽过的第三种假反例根因：下游兜住了上游失效。）
  const emptyReasons = [];
  for (const v of [null, undefined, '', '   ', 123, NaN, [], {}]) {
    const r = shouldProposeFrom(v);
    if (r.reason !== 'EMPTY_INPUT') emptyReasons.push(JSON.stringify(String(v)) + '=>' + r.reason);
  }
  check('❌ 反例1b 空/非字符串必须由 EMPTY_INPUT 守卫拦下（不得被下游兜住）',
    emptyReasons.length === 0, emptyReasons.join(' '));

  // 🔴 反例2：问句不是授权。含「帮我」但仍是询问。
  //   这是最危险的误判方向 —— 把一句询问当成授权会直接引出确认卡片。
  check('❌ 反例2 问句含请求动词仍不触发（询问≠授权）',
    shouldProposeFrom('你能帮我写吗？').shouldPropose === false);

  check('❌ 反例2b 问句判定优先于动词判定（reason 必须是 IS_QUESTION）',
    shouldProposeFrom('帮我整理 notes.txt 到桌面吗？').reason === 'IS_QUESTION');

  check('❌ 反例3 纯闲聊不触发',
    shouldProposeFrom('今天天气不错').shouldPropose === false);

  // 🔴 反例3b（变异测试逼出来的）：必须断言**动词守卫的 reason**。
  //   变异 m2 删掉 `if (!verbHit)` 后测试仍全绿 —— 因为这些句子又缺
  //   「桌面/沙盒」提示，被下游 NO_TARGET_HINT 挡住了。
  //   结果一样是 false，**但守卫根本没被测到**，删了它照样绿。
  const verbReasons = [];
  for (const t of ['今天天气不错', '我有点困了', '你在吗', '外面下雨了吗', '她是谁']) {
    const r = shouldProposeFrom(t);
    if (r.reason !== 'NO_REQUEST_VERB') verbReasons.push(t + '=>' + r.reason);
  }
  check('❌ 反例3b 无请求动词必须由 NO_REQUEST_VERB 守卫拦下（不得被下游兜住）',
    verbReasons.length === 0, verbReasons.join(' '));

  check('❌ 反例3c 人格化表达不触发（触及 persona 红线：不得虚构主动意愿）',
    shouldProposeFrom('我有点困了').shouldPropose === false);

  check('❌ 反例3d「你在吗」这类呼唤不触发',
    shouldProposeFrom('你在吗').shouldPropose === false);

  // 🔴 反例4：只有动词、无目标 → 无法建案（没有 scope 就是非法提案）。
  check('❌ 反例4 只有请求动词无目标 → 不触发',
    shouldProposeFrom('帮我写个东西').shouldPropose === false);

  check('❌ 反例4b 理由必须是 NO_CONCRETE_TARGET（位置提示有但目标没提到）',
    shouldProposeFrom('帮我写到沙盒里').reason === 'NO_CONCRETE_TARGET');

  check('❌ 反例4c 提到位置但没有文件名 → 不触发',
    shouldProposeFrom('整理一下桌面').shouldPropose === false);

  // 🔴 反例5：只有目标、无位置提示 → 我们不知道用户指哪，仍不触发。
  check('❌ 反例5 有文件名但无位置提示 → 不触发',
    shouldProposeFrom('帮我写 note.txt').shouldPropose === false);

  check('❌ 反例5b 理由必须是 NO_TARGET_HINT',
    shouldProposeFrom('帮我写 note.txt').reason === 'NO_TARGET_HINT');

  check('❌ 反例6 无请求动词 → 不触发',
    shouldProposeFrom('notes.txt 在哪里').shouldPropose === false);
}

/* ================= 3. 返回值契约 ================= */
{
  // 🔴 反例7：hint 绝不能是绝对路径。
  //   判定层若自行拼绝对路径，scope 白名单就被绕过了一层——
  //   真正的路径拼接必须在主进程，且过 PermissionPolicy.authorize()。
  const r = shouldProposeFrom('帮我把整理.md 存到桌面上');
  const hasSep = r.hint.indexOf('/') >= 0 || r.hint.indexOf(String.fromCharCode(92)) >= 0;
  check('❌ 反例7 hint 不含路径分隔符（绝不自行拼绝对路径）', !hasSep, r.hint);

  // 🔴 反例8：不触发时 capability 必须为 null。
  //   若不触发却带着 capability，调用方若只看 capability 就可能误建案。
  const q = shouldProposeFrom('你能帮我写吗？');
  check('❌ 反例8 不触发时 capability 为 null', q.capability === null, String(q.capability));

  // 🔴 反例9：不触发时 hint 也应为 null，避免调用方拿到半成品数据。
  const t = shouldProposeFrom('今天天气不错');
  check('❌ 反例9 不触发时 hint 为 null', t.hint === null, String(t.hint));

  // 🔴 反例10：判定为 false 不是错误 —— 必须始终返回合法信封，绝不抛。
  let threw = false;
  try {
    shouldProposeFrom('随便一句话');
    shouldProposeFrom('？？？');
    shouldProposeFrom('');
  } catch (e) {
    threw = true;
  }
  check('❌ 反例10 任何输入都不抛异常（每轮都跑，抛错会打崩对话链路）', !threw);
}

/* ================= 4. 不变量：纯函数 ================= */
{
  // 🔴 反例11：纯函数 —— 同样输入永远同样输出。
  //   若有人为了「让触发更多」而引入随机/时间/上次结果，这里会红。
  const a = shouldProposeFrom('帮我整理桌面的 readme.md');
  const b = shouldProposeFrom('帮我整理桌面的 readme.md');
  check('❌ 反例11 纯函数：同输入两次判定完全一致',
    a.shouldPropose === b.shouldPropose && a.hint === b.hint && a.reason === b.reason);

  // 🔴 反例12：沙盒名可注入 —— 否则用户改了目录名这条就永远失配。
  const custom = shouldProposeFrom('帮我保存 x.md 到 MyBox', { sandboxName: 'MyBox' });
  check('❌ 反例12 沙盒目录名可注入（改目录名不至于永远失配）',
    custom.shouldPropose === true, custom.reason);
}

console.log('');
// ⚠️ 汇总行**不能**以 "PASS" 开头：docs.test.js 按 `^PASS` 计数项数，
//   汇总行会被算成第 28 项，与 README 登记的 27 不符 —— 实测踩到过。
console.log('总计 ' + pass + ' 项通过 / ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
