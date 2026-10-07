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
 * ## 已修（2026-10-06 D-6a 收尾）：真实中文（不打空格）现在能命中了
 *
 * ⚠️ **本节原先写的是「修好前一条都命中不了」的缺陷描述，现已过时，改为阶段说明。**
 *   留着「已知缺陷」的旧描述比不写更糟 —— 下一个人会以为模块还是坏的。
 *
 * 当时的实测（已不成立）：
 *   「帮我把整理.md存到沙盒」 → 当时 MISS（NO_CONCRETE_TARGET），现 HIT hint='整理.md'
 *
 * 根因（当时）：FILENAME_RE 要求 token 句尾是扩展名（带 $ 锚定），
 *   而中文习惯不打空格，整句被当成一个 token，句尾是「沙盒」不是「.md」。
 *
 * 这条缺陷能藏住，是因为**门禁的正例本身就写错了形态** ——
 *   27 项门禁里的正例全是「整理.md 存到桌面」这种带空格的写法。
 *   这是本仓「门禁只测正例、缺陷藏在绿色里」纪律的一次新变体：
 *   2026-10-06 白天修好了「分词把点当分隔符」那个 bug，
 *   却没发现**修完之后正例的形态本身就不真实**，等于把 bug 藏进了测试里。
 *
 * D-6a 的修法（已落地）：改为在**整句**里提取白名单扩展名的「主名.扩展名」片段，
 *   并把 27 项门禁的正例全部重写成无空格的真人句子（现为 74 项）。
 *
 * ## 🔴 仍然存在的边界：intent 只是「听懂」，D-7 才是「开口」
 *
 * 本模块只回答「这句话该不该建案」。**接线尚未完成**：
 *   `Brain.ask()` 里的 `this._pendingAgentIntent` **零处读取**
 *   ⇒ 不建案、不弹确认卡片 ⇒ **她仍不会主动开口**。
 *
 * ⚠️ 所以现在**不要以为功能可用了**：总开关 `agentTriggerEnabled` 默认 false，
 *   沙盒写权限虽已开启，但没有任何代码把意图转成提案。
 *   气泡提示与卡片拉起留到 D-7（缺真实 `content` 来源）。
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

/**
 * 🔴 D-6a 修法：文件名判据从「句尾有扩展名」换成「**白名单扩展名**」。
 *
 * 为什么原来会漏判：旧正则是 /\.[a-z0-9]{1,8}$/i —— 带 $ 锚定，
 *   要求 token **句尾**是扩展名。而中文习惯不打空格，
 *   「帮我把整理.md存到沙盒」整句被当成一个 token，句尾是「沙盒」不是「.md」，
 *   于是 6 句真人中文 0 命中（实测）。缺陷藏在门禁里，是因为
 *   当时 27 项正例全是「整理.md 存到桌面」这种**带空格**的写法。
 *
 * 为什么不是简单去掉 $ 锚定：那样任何「某处有个 .xxx」都算命中，
 *   实测「帮我看下第3.5节的内容」「version 2.10的说明」「温度是23.5度」
 *   全部误伤 —— 而**误触发比漏触发危险得多**：她没被要求却想动手，
 *   弹出的确认框打断用户，且 persona.js:29 的红线被从侧面破坏。
 *   根因不是「提取」，是**缺扩展名白名单**。
 *
 * 三段各自的作用（缺一不可，各有独立变异体）：
 *   前置 [\w\u4e00-\u9fa5]      → 挡「帮我把 .md 存到沙盒」这种无主名的裸扩展名
 *   白名单 md|txt|json|csv|log   → 挡 3.5 / 1.2 / 2.10 / 23.5 全部小数点
 *   负向 (?![a-z0-9]|\.[a-z0-9]) → 挡 a.md.exe（双扩展名）与 x.mdx（拼接后缀）
 *
 * ⚠️ 负向断言**必须合并两个分支**：只写 (?![a-z0-9]) 挡不住 a.md.exe
 *   （.md 之后是 '.'，不是字母数字）；只写 (?!\.[a-z0-9]) 挡不住 x.mdx。
 *   这是 2026-10-06 实测出来的，两条单用各有一个洞。
 *
 * 白名单收窄是有意的（用户拍板）：「她能写什么」应匹配「她现在真能做什么」。
 *   不收 js/ts/py —— 沙盒在**桌面**，而 Windows 上 .py/.js/.html 双击即执行，
 *   沙盒的隔离意义当场蒸发；不收 png/jpg —— 她没有图像生成能力，写出来只会是空文件。
 */
const FILENAME_RE = /([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*[\w\u4e00-\u9fa5]|\w)\.(md|txt|json|csv|log)(?![a-z0-9._-]|\.[a-z0-9])/i;
const HAS_SEP_RE = /[\\\/]/;

/**
 * 🔴 D-6a 待修 10：单个路径段是否含「非法的点」。
 *
 *## 为什么要拆成独立函数
 *
 *   D-6a 待修 7/8/9 把「段首是点 / 段尾是点 / 点串接中文」合并进了
 *   `rawTokens.some(...)` 的内联回调里。后果是**无法对子判据做变异测试** ——
 *   只能整块删，删了就知道「三道判据整体有没有被测到」，不知道「每一道各自有没有贡献」。
 *
 *   D-6a 待修 5 那次已经栽过：合并后跑变异「整块删」，27 项全绿，
 *   结论「已覆盖」其实是假的。**合并是省事，拆分才是可测。**
 *
 * ## 🔴 本函数真正的判据：**ASCII 边界**，不是「点数」也不是「有无分隔符」
 *
 *   待修 9 那版问「段尾是不是点」，在中文无空格场景下把**省略号**当成非法尾点：
 *     帮我把整理.md存到沙盒...   → segs = ["帮我把整理.md存到沙盒..."]
 *                              段尾是 `.`，于是整句被拒
 *   这是**高频能力被低频场景换掉**：省略号是中文口语默认习惯，
 *   而待修 9 要挡的 `x/y.`（尾点文件名）Windows 根本不允许用户创建。
 *
 *   真正的分界线是「**尾点前面那个字符是什么**」：
 *     「帮我把整理.md存到沙盒...」尾点前是「盒」—— **中文** ⇒ 句末标点，放行
 *     「帮我把 x/y. 存到沙盒」尾点前是「y」—— **ASCII** ⇒ 文件名的一部分，拒
 *   同一条规则同时放过省略号、挡住尾点文件名，**不需要按点数分支**。
 *
 *   ⚠️ 「按点数分支」（≥2 个点当省略号）是错的：`notes.txt..` 前面是 `txt`（ASCII），
 *     它不是省略号，是用户真要写一个非法名。ASCII 边界不会误判它。
 *
 * ## ⚠️ 关于「纯点段」（`.` / `..` / `...`）必须单独处理
 *
 *   段首是点会拒掉它，但**无分隔符时** `..` 是省略号而不是目录：
 *     帮我把 a.md 存到沙盒 ..   → token是 `..`，整句是一个词，不含分隔符
 *   所以纯点段按「有无分隔符」分流：带分隔符 ⇒ 路径段（`..` 是上级目录）⇒ 拒；
 *   不带分隔符 ⇒ 独立成词的省略号 ⇒ 放行。
 *   ⚠️ 单独成词的单点 `.` 一律拒（那是「当前目录」，Windows 语义明确）。
 *
 * ##⚠️ 最后一条判据（中文字符紧跟点串）**只在带分隔符时生效**
 *
 *   「等等..帮我把整理.md存到沙盒」整句无分隔符，那里的 `..` 是口语停顿，不是路径段。
 *   带分隔符时（「x/y..存到沙盒」段是 `y..存到沙盒`）才是「段尾非法点」。
 *
 * ## ⚠️ 有意放行的两类（不是漏，是设计决定）
 *
 *   `x/y..z` / `a...b`：点串在段**中间**且两侧都是 ASCII ——
 *   Windows 合法（`y..z` 是正常文件名），且 hint 会原样保留 basename，不存在语义偏移。
 *   `a.md存到沙盒.`：单点结尾但前面是中文 ⇒ 句末标点。
 *
 * @param {string} tk 单个 token（已按空格与中文标点切分）
 * @returns {boolean} true = 该段含非法点，应整句不触发
 */
function isBadDotSegment(tk) {
  const str = String(tk || '');
  if (!str.length) return false;
  const tkHasSep = HAS_SEP_RE.test(str);
  const segs = str.split(/[\\\/]+/).filter(Boolean);
  for (const seg of segs) {
    if (!seg.length) continue;

    // ① 纯点段：单独成词时可能是省略号，带分隔符时一定是路径段。
    if (/^\.+$/.test(seg)) {
      if (seg.length === 1) return true;   // 单点「.」= 当前目录，语义明确，恒拒
      if (tkHasSep) return true;           // `x/..` `x/./y` —— 上级目录
      continue;                            // 独立成词的 `..` = 省略号，放行
    }

    // ② 段首是点：裸点主名（`.a.md` / `..a.md`）与隐藏文件（`.git`）都非法。
    //   D-6a 待修 8 的 `charAt(1) !== '.'` 例外已删（它把 `..a` 整族放过了）。
    if (seg.charAt(0) === '.') return true;

    // ③ 段尾是点：**看尾点前面那个字符的ASCII 边界**。
    //   ASCII ⇒ 文件名的一部分（`x/y.` `notes.txt..`）→ 拒
    //   中文/不存在 ⇒ 句末标点（`…存到沙盒...` `…存到沙盒.`）→ 放行
    if (seg.charAt(seg.length - 1) === '.') {
      const tail = /(\.+)$/.exec(seg)[1];
      const prev = seg.charAt(seg.length - tail.length - 1);
      if (prev !== '' && prev.charCodeAt(0) < 0x80) return true;
      continue;
    }

    // ④ 段内点串紧跟中文：只在**带分隔符**时才算路径段的非法尾点。
    //   判据精确到「至少两个连续点」——用「点后接任意中文」会误伤 `我的.报告.md`。
    if (tkHasSep && /\.\.+[^\x00-\x7f]/.test(seg)) return true;
  }
  return false;
}

/**
 * 🔴 D-6a：从整句提取「主名.扩展名」片段。
 *
 * 为什么不能只靠分词：中文不打空格时整句是一个 token，靠 token 找必然落空
 *   （这是 D-6a 修的那个缺陷）。所以改为**在整句里直接匹配**。
 *
 * 为什么要截尾：直接用 FILENAME_RE.exec(text) 拿到的是 match[0]，
 *   在「帮我把整理.md存到沙盒」上会得到「整理.md存到沙盒」——
 *   因为负向断言只保证扩展名**之后**不是字母数字，
 *   而中文汉字不在 [a-z0-9] 里，所以后面的汉字被一并吞进来。
 *   hint 必须是干净的文件名（既有门禁 :49钉的就是这个），故显式截断。
 *
 * 截断依据：主名从匹配起点取，扩展名取捕获组，**只拼这两段**，
 *   不把中间/尾部的任何东西带进来。
 */
function extractTarget(text) {
  const m = FILENAME_RE.exec(String(text || ''));
  if (!m) return null;
  // 🔴 D-6a 待修 2：**不能用 indexOf 找扩展名的位置**。
  //   原写法 `m[0].indexOf('.' + m[1])` 找的是「该扩展名字符串首次出现」，
  //   而不是「本次匹配的那个点」。主名里本身带点时会撞上更早的点：
  //     '我的.报告.md'      → indexOf('.md') 命中主名里的点 → 截成 '报告.md'
  //     'v1.2.3-notes.md'  → 截成 'notes.md'
  //     'report-final.md'   → 截成 'final.md'
  //   后果是**静默写错文件名** —— 用户说 v1.2.3-notes，磁盘上多出 notes.md，
  //   而用户不会立刻发现。
  //
  // 正确做法：用**捕获组**。正则把主名与扩展名分开捕获，
  //   命中长度 = 主名 + '.' + 扩展名，直接按这个长度切，不猜位置。
  const name = m[1];
  const ext = m[2];
  if (!name || !ext) return null;
  const full = name + '.' + ext;
  // m[0] 可能比 full 长（后面还跟着中文），故按 full 长度截取。
  // 同时要求 m[0] 以 full 开头 —— 否则说明匹配结构与预期不符，宁可放弃。
  if (m[0].toLowerCase().indexOf(full.toLowerCase()) !== 0) return null;
  return full;
}

/** 连接词与量词：只剥**开头连续**的，不动中间。 */
const CONNECTIVES = ['把', '的', '到', '给', '一个', '这个', '一份', '一下'];

/**
 * 🔴 D-6a 待修 11：句子性前缀（多字请求动词）—— **贪婪主名**的真正修法。
 *
 * ## 问题：hint 被吞成半句话（实测，影响面比点判据大得多）
 *
 *   「顺便帮我把整理.md存到沙盒」→ hint = "顺便帮我把整理.md"
 *   「喂帮我把整理.md存到沙盒」  → hint = "喂帮我把整理.md"
 *   「今天帮我把a.md存到沙盒」   → hint = "今天帮我把a.md"
 *
 *   用户说的是「整理.md」，磁盘上会多出一个叫「顺便帮我把整理.md」的文件。
 *   与待修 1/5/6 同类（静默写错名字），但**影响面大得多** ——
 *   前面所有测试的输入都恰好以文件名或动词开头，所以从没暴露。
 *
 * ## 为什么正则层修不了
 *
 *   合法主名 `我的.报告` / `v1.2.3-notes` / `report-final` 与贪婪主名
 *   `顺便帮我把整理` / `今天帮我把a` **在字符层面同形**（都是词字符+点/连字符+词字符）。
 *   收紧 FILENAME_RE 的主名字符集会**连带打死那三条已修好的能力**。
 *   ⚠️ 所以这里**不动正则**，改在剥前缀这一层解决。
 *
 * ## 判据：主名里出现「多字请求动词」⇒ 主名是句子碎片，不完整
 *
 *   区别只有一处：**动词前面还有字**。
 *     「顺便**帮我**把整理」→ 动词在主名内部，前面有「顺便」⇒ 是句子
 *     「帮我把整理」      → 动词在主名开头，前面没东西 ⇒ stripVerbPrefix 会剥掉
 *     「归档.md」        → 动词**等于**整个主名，剥了就成裸扩展名 ⇒ 待修 1 已处理
 *
 * ## ⚠️⚠️ 为什么必须另立一张表，**不能**复用 REQUEST_VERBS
 *
 *   REQUEST_VERBS 里的「保存 / 整理 / 归档 / 收拾 / 归整 / 写个 / 写一下」
 *   **本身就是常用中文文件名**（待修 1 已坐实：`帮我归档.md` 期望 hint=`归档.md`）。
 *   若把它们当切分点，`归档.md` / `保存.txt` / `整理.md` 会被自己切碎 ——
 *   我实测过，四条合法名全部误伤。
 *
 *   所以这张表只收**不可能独立成为文件名**的多字动词。
 *   ⚠️ 这两张表的关系是**互斥**：REQUEST_VERBS 管「开头剥」，
 *   STRONG_VERBS 管「内部探测」，**用一张必然出错**。
 */
const STRONG_VERBS = ['帮我', '帮忙', '替我', '给我写', '存到', '保存到', '存一下', '清理一下'];

/**
 * 剥掉主名里的**句子性前缀**：从第一个多字动词处重新开始。
 *
 * ⚠️ 只在 index > 0 处切（动词前面还有东西时才切）。
 *   动词在主名开头时**不动** —— 那由 stripVerbPrefix() 负责，它还有
 *   「剥出裸扩展名就回退」的保护，这条没有。
 *
 * @param {string} name 主名（不含扩展名）
 * @returns {string} 剥掉句子性前缀后的主名
 */
function trimSentencePrefix(name) {
  const original = String(name || '');
  if (!original) return original;
  let out = original;
  // 循环上限：病态输入（如「帮我帮我帮我…」）下必须收敛。
  const MAX_ROUNDS = STRONG_VERBS.length;
  for (let rounds = 0; rounds < MAX_ROUNDS; rounds++) {
    // 找位置最靠前的那个动词 —— 多个命中时取第一个，那才是句子的真正起点。
    let at = -1;
    for (const v of STRONG_VERBS) {
      const i = out.indexOf(v);
      if (i > 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) break;
    out = out.slice(at);
  }
  return out || original;
}

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
  const original = String(name || '');
  // 🔴 D-6a 待修 1：剥动词必须收敛，否则会把合法中文文件名剥成裸扩展名。
  //
  //   REQUEST_VERBS 里有「归档 / 保存 / 收拾 / 归整 / 写一下 / 存到」这些词，
  //   它们**本身就是常用中文文件名**。原实现是无限循环剥，于是：
  //     帮我归档.md到桌面 → 剥掉「归档」→ 剩下「.md」（实测确认）
  //   这是一条**后门**：正则层刚挡住「帮我把 .md 存到沙盒」这种裸扩展名，
  //   转头它从剥离层又进来了。
  //
  //   两条防线（缺一不可）：
  //     ① 剥完若以点开头（裸扩展名，不是合法文件名）→ 回退到不剥的版本；
  //     ② 剥完若为空 → 同样回退。
  //   另外加一个**上限**，避免病态输入下循环不收敛。
  //
  // ⚠️ 不要用「给动词表瘦身」来解—— 那是把「她听不懂哪些中文文件名」
  //   变成「她听不懂得更少」，方向反了。问题不是动词表太大，是剥得太狠。
  //逐段剥离，但**每剥一段都检查是否剥坏**：
  //   一旦剥出来的是裸扩展名（以点开头）或空串，就**只回退这一段**。
  //   为什么不是「剥坏了整个回退」：那样「帮我归档.md」会连「帮我」一起留下，
  //   得到「帮我归档.md」而不是期望的「归档.md」—— 动词确实该剥，
  //   只是最后一刀把主名剥没了。
  const MAX_STRIP_ROUNDS = 8;
  let out = original;
  for (let rounds = 0; rounds < MAX_STRIP_ROUNDS; rounds++) {
    let cut = null;
    for (const v of REQUEST_VERBS) {
      if (out.startsWith(v)) { cut = v; break; }
    }
    if (!cut) {
      for (const w of CONNECTIVES) {
        if (out.startsWith(w)) { cut = w; break; }
      }
    }
    if (!cut) break;
    const next = out.slice(cut.length);
    // 剥坏了（空串 / 裸扩展名）→ 停在**这一段之前**，不继续剥也不回退全部。
    if (!next || next.charAt(0) === '.') break;
    out = next;
  }
  return out || original;
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
  // 🔴 D-6a：改为**从整句直接提取**，不再依赖分词。
  //旧写法是按 token 找（`tokens.find(...)`），而中文不打空格时整句
  //   就是一个 token，句尾是「沙盒」不是「.md」，于是 6 句真人中文 0 命中。
  //   分词在这里帮不上忙 —— 它恰恰是缺陷的成因，不是解法。
  //
  // 两条判据并存：
  //   ① extractTarget：从整句提取白名单扩展名的「主名.扩展名」片段（新增路径）；
  //   ② HAS_SEP_RE：带路径分隔符的完整路径（保留原有路径判据，完整路径本就该命中）。
  const extracted = extractTarget(text);
  const tokens = text.split(/[\s，。！？、]+/).filter(Boolean);
  //🔴 D-6a 待修 4/6：pathLike 这条**也要过「主名不得以点开头」的关**。
  //
  //   正则层已经挡住了 `..md` / `...md` / `.a.md`，但带分隔符的路径
  //   走的是这条独立判据，它不经过 FILENAME_RE，于是绕过了那道防线：
  //     ../../secret.md  → 走 pathLike → basename 取到 'secret.md'
  //   用户明说了「上一级上一级」，hint 却变成一个平级文件名 ——
  //   **语义被静默吃掉了**。
  //
  //   这不是安全问题（下游 PermissionPolicy._scopeAllowed 走 path.resolve
  //   + 白名单前缀比对，兜得住），但 hint 已经不是用户说的那个东西，
  //   而静默偏离不允许。
  //
  //   判据：basename 之后若以点开头（`.a` / `..md` / `...md`），一律不算路径。
  const pathLike = tokens.find((tk) => {
    if (!HAS_SEP_RE.test(tk)) return false;
    //🔴 段级排除：任一段是 '..' 就不算目标。
    //   '../../secret.md' 的 basename 是 'secret.md'（不以点开头），
    //   所以只查 basename 挡不住 —— 必须**逐段**看。
    //   用户明说「上一级上一级」，而沙盒是**单一目录**，
    //   带 .. 的路径必然落在沙盒之外（下游 PermissionPolicy 会拒），
    //   但 hint 不该给出一个让人误以为在沙盒内的名字。
    const segs = tk.split(/[\\\/]+/).filter(Boolean);
    if (segs.some((s) => s === '..')) return false;
    const base = path.basename(tk);
    return !!base && base.charAt(0) !== '.';
  }) || null;
  // 🔴 D-6a 待修 4/6 的**整句级兜底**：句中出现「上级目录」或「裸点主名」时，
  //   **整句不触发**，而不是让 extracted 抓其中的 basename 顶上。
  //
  //   为什么必须整句拒：pathLike 被判否后若还回落 extracted，
  //   '..' 的语义会**绕一圈回来**—— 用户明说「上一级上一级」，
  //   hint 却给出一个平级文件名，那正是「静默改写用户意图」。
  //   宁漏勿误在这里 = 宁少写，不要写错名字。
  const rawTokens = text.split(/[\s，。！？、]+/).filter(Boolean);
  // 🔴 D-6a 待修 7：段级排除必须是「**任一段以点开头**」，不能只查 '..'。
  //
  //   原写法 `s === '..'` 漏掉了 './' 与 '.../'（实测）：
  //     帮我把 ./notes.txt 存到沙盒→ hint=notes.txt   「当前目录」被吃掉
  //     帮我把 a/./b.txt 存到沙盒  → hint=b.txt
  //   严重度低于 '..'（不越界），但同类：静默改写用户意图。
  //
  // ⚠️ **别伤 a..b.md** —— 主名**中间**的点合法（能力优先）。
  //   所以判据是「**段**以点开头」，而不是「整串含点」。
  // 🔴 D-6a 待修 7/8/9 **合并为一条**：任一路径段的**首字符或尾字符**是点，
  //   整句不触发。
  //
  //   为什么合并（三轮各自的实测结论）：
  //     · 待修 7（`./` `.../`）：判据是「**段首**是点」。
  //     · 待修 8（`..a.md`）：仍问段首 —— D-6a 那版带 `charAt(1)!=='.'` 例外，
  //       把双点+字母整族放过了，例外已删。
  //     · 待修 9（`x/y.` `x/y..`）：判据问的是「**段尾**是点」——
  //       前六轮全在文件名上打转，没人问过「路径里的段本身非法」怎么办。
  //   三者同族：**静默改写用户意图**，所以合成一条判据，不再分开维护。
  //
  //   ⚠️ 覆盖是**分层**的，别误判：extracted 那侧由 FILENAME_RE 管住
  //   （实测 `y.` 直接说 → MISS），漏的只有 pathLike 那侧（`x/y.` → HIT）。
  //
  //   ⚠️ 防误伤：判据是「**首或尾**」，不是「含点」——
  //   `a..b.md` 段首 a、段尾 d ⇒ 正确放行（主名**中间**的点合法，能力优先）。
  //
  //   ⚠️ 与正则的关系：这**不是纵深防御**，是**冗余** ——
  //   两者看同一字符串的同一位置，只是本判据不依赖 RE 的行为。判据不同 ≠ 层数不同。
  //
  // 🔴 D-6a 待修 10：判据本体在 isBadDotSegment()（上方有完整判据推导与取舍说明）。
  //   待修 9 那版「段尾见点就拒」把**中文省略号**当非法文件名：
  //     帮我把整理.md存到沙盒...  → 段尾是「...」⇒ 整句被拒
  //   代价是高频口语能力被一个 Windows 根本不允许创建的尾点文件名换掉。
  //   新版判据的核心是**尾点前面那个字符的 ASCII 边界**，不是点数。
  const hasBadDotSegment = rawTokens.some((tk) => isBadDotSegment(tk));
  if (hasBadDotSegment) {
    return { shouldPropose: false, reason: 'NO_CONCRETE_TARGET', capability: null, hint: hintHit };
  }

  // ⚠️ 关于「裸点主名」的防线构成（D-6a 修订，勿照旧注释理解）：
  //   这里有**一道**判据（上面hasBareDotName），它**不是**与正则互斥的。
  //   D-6a 曾加过一版判据（「basename 经 RE 替换后是否以点开头」），
  //   变异测试坐实那版是**死代码**：FILENAME_RE 的主名首字符已排除 '.'，
  //   凡是能通过该正则的主名必然不以点开头 ⇒ 那个条件恒假 ⇒ 删掉。
  //   现版改为直接看**原串最后一个段的首字符**，不依赖 RE 行为，故是真正独立的判据。
  //   两版不可混淆：**旧版恒假，新版有效**。

  // 完整路径优先于提取式：带分隔符的 token 是用户明说的路径形态，
  // 比「在整句里扫到一个文件名片段」更可信。
  const target = pathLike || extracted;
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
    //🔴 D-6a：两条来源要**分别处理**，不能一律过 basename。
    //   extracted 已经是干净的「主名.扩展名」，再过 path.basename 会被 Windows
    //   的分隔符规则切错（实测「整理.md存到沙盒」→ 切成「理.md」，主名丢首字）。
    //   pathLike 才是真路径，才需要 basename 取末段。
    //
    // 之后都剥前缀动词：中文没有空格分词，「帮我把整理.md」整体是候选，
    //   不剥的话交给主进程拼路径会生成「帮我把整理.md」这种文件名。
    hint: stripVerbPrefix(
      // 🔴 D-6a 待修 11：**两级剥除，顺序不能换**。
      //   第一级 trimSentencePrefix：剥掉「顺便帮我把整理」里的**句子性前缀**
      //     （多字请求动词出现在主名内部 ⇒ 主名是句子碎片，不完整）。
      //   第二级 stripVerbPrefix：剥掉**开头**的动词与连接词
      //     （「帮我把」→「整理」，且带「剥出裸扩展名就回退」的保护）。
      //
      //   ⚠️ 为什么必须先 trim 再 strip：stripVerbPrefix 只认 startsWith，
      //     遇到「顺便帮我把整理」这种**动词不在开头**的输入会完全失效
      //     —— 用户说的是「整理.md」，hint 却是「顺便帮我把整理.md」，
      //     磁盘上会多出一个叫「顺便帮我把整理.md」的文件。
      //   ⚠️ 为什么不能反过来：先 strip 对同一输入同样无效（开头不是动词），
      //     而且顺序若换，`我的.报告.md` 这类合法名会被剥坏。
      trimSentencePrefix(extracted !== null ? extracted : path.basename(pathLike)),
      verbHit
    ),
  };
}

module.exports = { shouldProposeFrom, REQUEST_VERBS, TARGET_HINTS };
