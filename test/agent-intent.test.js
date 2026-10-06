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
  // 🔴 D-6a：这一组正例**必须是无空格的真人句子**。
  //
  //   旧版全部是「整理.md 存到桌面」这种带空格的写法 —— 而中文习惯不打空格。
  //   带空格写法能被旧的「按 token 找句尾扩展名」判据接住，
  //   于是**缺陷藏在绿色里**：实现早就烂了，27 项门禁全绿。
  //
  //   ⚠️ 下面每一条都必须保留**真实的口语形态**（含前后缀的句子）。
  //   一旦改回带空格或以文件名开头，这组就退化成「为实现补绿灯」。
  check('正例1 中文文件名+请求动词+桌面提示 → 触发',
    shouldProposeFrom('帮我把整理.md存到桌面上').shouldPropose === true);

  check('正例2 英文文件名+空格分隔 → 触发',
    shouldProposeFrom('帮我写一下notes.txt放到桌面').shouldPropose === true);

  //🔴 这条**保持原样**：完整路径本来就该命中，不是「无空格」要修的那类。
  check('正例3 带完整路径 → 触发',
    shouldProposeFrom('帮我把 C:/x/notes.txt 存到桌面').shouldPropose === true);

  // hint 必须是**干净的 basename**，不能带着「帮我把」前缀 ——
  //   否则主进程会拼出一个叫「帮我把整理.md」的文件。
  const h1 = shouldProposeFrom('帮我把整理.md存到桌面上').hint;
  check('正例4 hint 剥掉动词前缀（中文无空格分词，前缀会被吞进文件名）',
    h1 === '整理.md', h1);

  // 🔴 D-6a 待修 4/5/6/10/11 的**能力锚点集合**：
  //   正例主名可以合法含点、含连字符，也可以**本身就是动词**。
  //   这五条一旦被某轮收紧连带打死，说明改坏了。
  const anchors = [
    ['帮我把我的.报告.md存到桌面', '我的.报告.md'],
    ['帮我把v1.2.3-notes.md存到桌面', 'v1.2.3-notes.md'],
    ['帮我把report-final.md存到桌面', 'report-final.md'],
    ['帮我归档.md到桌面', '归档.md'],
    ['帮我把 a..b.md 存到沙盒', 'a..b.md'],
  ];
  for (const [input, expected] of anchors) {
    const got = shouldProposeFrom(input);
    check('❌ 锚点：合法中文/多段主名必须原样保留 → ' + input,
      got.shouldPropose === true && got.hint === expected,
      'hint=' + String(got.hint));
  }

  // 🔴 D-6a 待修 11：句子性前缀必须被剥掉。
  //   「顺便帮我把整理.md」若不去掉「顺便帮我把」，磁盘上会多出
  //   一个叫「顺便帮我把整理.md」的文件 —— 静默写错名字。
  const greedy = [
    ['顺便帮我把整理.md存到沙盒', '整理.md'],
    ['喂帮我把整理.md存到沙盒', '整理.md'],
    ['OK帮我把a.md存到沙盒', 'a.md'],
    ['今天帮我把a.md存到沙盒', 'a.md'],
    ['然后帮我把整理.md存到沙盒', '整理.md'],
    ['对了帮我把整理.md存到沙盒', '整理.md'],
    ['等等..帮我把整理.md存到沙盒', '整理.md'],
  ];
  for (const [input, expected] of greedy) {
    const got = shouldProposeFrom(input);
    check('❌ 锚点：句子性前缀必须剥掉（hint 不得是半句话） → ' + input,
      got.shouldPropose === true && got.hint === expected,
      'hint=' + String(got.hint));
  }

  // 🔴 D-6a 待修 11：**动词位于主名开头**的那一批。
  //   这组存在的唯一目的，是锁住「M2 是等价变异体」这个结论。
  //
  //   变异体M2 把 trimSentencePrefix 的 `i > 0` 改成 `i >= 0`，
  //   门禁曾报「漏网 59/59 全绿」。查证后确认它是**等价变异体**：
  //     · 动词在 index 0 时 slice(0) 返回原串 ⇒ trimSentencePrefix 无变化；
  //     · 真正需要剥开头动词时，stripVerbPrefix 那一级本来就负责。
  //   所以「测不出差异」是**正确**的，不是覆盖缺失。
  //
  // ⚠️ 但「等价」必须**留证据**，否则下次看到全绿又要重新怀疑一遍。
  //   这组断言就是证据：它们证明下游 stripVerbPrefix 确实兜住了开头那一级。
  const leadingVerb = [
    ['帮我把整理.md存到沙盒', '整理.md'],
    ['帮我归档.md到桌面', '归档.md'],
    ['帮我保存.txt到沙盒', '保存.txt'],
    ['帮我收拾.md到桌面', '收拾.md'],
    ['帮我归整.log到沙盒', '归整.log'],
    ['存到笔记.txt存到沙盒', '笔记.txt'],
  ];
  for (const [input, expected] of leadingVerb) {
    const got = shouldProposeFrom(input);
    check('❌ 锚点：动词在主名开头时由下游兜住（等价变异体的证据） → ' + input,
      got.shouldPropose === true && got.hint === expected,
      'hint=' + String(got.hint));
  }

  // 🔴 D-6a 待修 10：中文省略号/语气词**不得**被当成非法文件名。
  //   这是高频口语形态，被「段尾点」判据误伤过一次。
  const ellipsis = [
    '帮我把整理.md存到沙盒...',
    '帮我把笔记.txt存到沙盒..',
    '帮我把整理.md存到沙盒，等下..',
  ];
  for (const input of ellipsis) {
    check('❌ 锚点：中文省略号不得触发「非法点」判定 → ' + input,
      shouldProposeFrom(input).shouldPropose === true);
  }

  // 🔴 D-6a 变异测试逼出来的两条**不可省略**的锚点：
  //
  //   ① 省略号的**整句形态**（段尾是 `..` / `...`）——
  //      上面那组带空格，会走「段尾点」判据；
  //      这一组**不打空格**，整句是一个 token，段尾是省略号，
  //      走的是纯点段/段尾判据的另一条分支。
  //      实测变异体「纯点段一律拒」只影响这一组，带空格那组照样绿。
  //
  //   ② 裸点主名在**正则层被放宽后**仍必须被拒 ——
  //      变异体 M9 删掉 FILENAME_RE 的主名首字符限定后门禁全绿，
  //      查证后确认是**冗余**（isBadDotSegment 的「段首是点」挡住了）。
  //      ⚠️ 冗余不等于可以不测：这里断言的是「结果」，
  //      而变异体证明的是「两道防线都在生效」—— 两者都要有记录。
  const ellipsisNoSpace = [
    '帮我把整理.md存到沙盒..',
    '帮我把笔记.txt存到沙盒...',
  ];
  for (const input of ellipsisNoSpace) {
    check('❌ 锚点：无空格省略号（整句单token，段尾=省略号）→ ' + input,
      shouldProposeFrom(input).shouldPropose === true);
  }

  // ⚠️ 这三条断言在「裸点主名」上：它们的作用是证明冗余防线成立。
  //   变异体 M9（删正则主名首字符限定）后仍须全绿才算冗余被证实；
  //   若哪天 isBadDotSegment 的段首判据被删，这三条会先红。
  for (const input of ['帮我把 .md 存到沙盒', '帮我把 ..md 存到沙盒', '帮我把 .a.md 存到沙盒']) {
    const r = shouldProposeFrom(input);
    check('❌ 锚点：裸点主名双层防线（正则层 + 段首判据）→ ' + input,
      r.shouldPropose === false && r.reason === 'NO_CONCRETE_TARGET',
      'reason=' + String(r.reason));
  }

  check('正例5 命中后 capability 固定为 workspace.write',
    shouldProposeFrom('帮我整理桌面的readme.md').capability === 'workspace.write');

  check('正例6 reason 为 EXPLICIT_REQUEST',
    shouldProposeFrom('帮我整理桌面的readme.md').reason === 'EXPLICIT_REQUEST');

  check('正例7 提到沙盒目录名本身也算位置提示',
    shouldProposeFrom('帮我保存report.md到LifeSandbox').shouldPropose === true);
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
    shouldProposeFrom('帮我整理notes.txt到桌面吗？').reason === 'IS_QUESTION');

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

/* ================= 2b. 反例：非法文件名形态（点判据族，D-6a 待修 5~10）============
 *
 * 🔴 为什么这一整块是**新增**的：
 *   D-6a 前八轮修了七类「非法点」漏洞（裸扩展名、双扩展名、拼接后缀、
 *   段首点、目录穿越、中间点串、句尾点），但**27 项门禁里一条断言都没有**——
 *   那七类全靠人工跑node -e 验证，变异测试证明「删掉判据门禁照样全绿」。
 *   「实现改了、门禁没跟上」的直接后果，本仓已经栽过两轮。
 *
 *   这一块必须与实现**同步**落地，且每一条都要能作为变异体的捕获点。
 */
{
  // 🔴 反例13：裸点主名 —— Windows 本就不允许这种文件名。
  //   ⚠️ 这条与「正例锚点·归档.md」是一对：剥动词剥过头会产出裸扩展名，
  //   而放宽又会放进裸主名。两头都必须钉住。
  const bareDot = [
    '帮我把 .md 存到沙盒',
    '帮我把 ..md 存到沙盒',
    '帮我把 .a.md 存到沙盒',
    '帮我把 ..a.md 存到沙盒',
    '帮我把 ...a.md 存到沙盒',
  ];
  for (const input of bareDot) {
    check('❌ 反例13 裸点主名/裸扩展名不触发 → ' + input,
      shouldProposeFrom(input).shouldPropose === false);
  }

  // 🔴 反例14：目录穿越与点段 —— hint 不该给出一个让人误以为在沙盒内的名字。
  //   ⚠️ 这不是安全问题（下游 PermissionPolicy 走 resolve + 白名单前缀兜得住），
  //   是**语义丢失**：用户明说「上一级上一级」，hint 却是平级文件名。
  const dotSegment = [
    '帮我把 ../../secret.md 存到沙盒',
    '帮我把 ./notes.txt 存到沙盒',
    '帮我把 a/./b.txt 存到沙盒',
    '帮我把 x/y./z.txt 存到沙盒',
    '帮我把 x/y. 存到沙盒',
    '帮我把 x/y..存到沙盒',
  ];
  for (const input of dotSegment) {
    check('❌ 反例14 点段/穿越段不触发 → ' + input,
      shouldProposeFrom(input).shouldPropose === false);
  }

  // 🔴 反例15：白名单外与拼接后缀。
  //白名单收窄是用户拍板的安全边界：.js/.ts/.py 在**桌面**上双击即执行，
  //   沙盒隔离当场失效；.png/.jpg 她没有图像能力，写出来是空文件。
  const notInWhitelist = [
    '帮我把 script.py 存到沙盒',
    '帮我把 photo.png 存到沙盒',
    '帮我把 data.jsonl 存到沙盒',
    '帮我把 a.md.exe 存到沙盒',
    '帮我把 x.mdx 存到沙盒',
    '帮我把 a.md-bak 存到沙盒',
  ];
  for (const input of notInWhitelist) {
    check('❌ 反例15 白名单外/双扩展名/拼接后缀不触发 → ' + input,
      shouldProposeFrom(input).shouldPropose === false);
  }

  // 🔴 反例16：小数点与章节号 —— 白名单扩展名必须挡住所有非文件名的小数形态。
  //   ⚠️ 这批输入**天然带空格/标点**，所以它们过去一直「看起来被测到了」，
  //   实际上测的是分词而不是扩展名白名单。
  const decimals = [
    '帮我看下第3.5节的内容',
    '帮我看看 version 2.10的说明',
    '温度是23.5度',
    '帮我看下第1.2节讲了什么',
  ];
  for (const input of decimals) {
    check('❌ 反例16 小数点/章节号不触发 → ' + input,
      shouldProposeFrom(input).shouldPropose === false);
  }
}

/* ================= 3. 返回值契约 ================= */
{
  // 🔴 反例7：hint 绝不能是绝对路径。
  //   判定层若自行拼绝对路径，scope 白名单就被绕过了一层——
  //   真正的路径拼接必须在主进程，且过 PermissionPolicy.authorize()。
  const r = shouldProposeFrom('帮我把整理.md存到桌面上');
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
  const a = shouldProposeFrom('帮我整理桌面的readme.md');
  const b = shouldProposeFrom('帮我整理桌面的readme.md');
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
