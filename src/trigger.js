/**
 * 主动搭话的"该不该开口"判定 —— 纯逻辑，不碰时钟也不碰网络。
 *
 * 全部判据来自 ActivityTracker（单一事实来源）：戳了几下、静默多久、睡没睡。
 * 渲染进程只负责"现在打不打扰人"这一层礼貌闸门（在不在打字、气泡开着没、
 * 上一条说完没），因为它看得见输入框，主进程看不见。
 * 分工按"谁知道什么"来切，所以这里不重复记数。
 *
 * evaluate() 只出**提案**，不改状态；真的说了话才由 commit() 记账。
 * 这个分开不是洁癖：如果 evaluate 顺手把冷却和挂机刹车都划掉，那么
 * 「主进程想让她说话、渲染端因为用户正在打字而拒了」这一趟就会白烧一次
 * 冷却，而挂机那条更糟 —— spokenDuringIdle 被置位、可她一个字都没说，
 * 于是这句问候永远补不回来，直到用户主动开口。
 *
 * 为什么这些数不放 config：它们之间有硬约束（冷却必须 ≥ 连戳窗口，否则同一串
 * 戳会被拆成两次开口）。把冷却配成 5 秒而连戳窗口留 8 秒，等于自动骚扰。
 * 要调就改这里，测试一起改。
 *
 * 这里曾经还有第四个常数（同串去重 32 秒）和配套的 pokeFiredAt 字段，注释写得
 * 像道防骚扰保险，实际永不开火：poke 提案只能在攒够 5 下（8 秒窗口内）时提出，
 * 提出后 commit 把 lastFiredAt 定在同一个 at，于是"同串再攒 5 下"必须跨过
 * 45 秒冷却，而那时早就不再是同一串了。判据测不出来就等于没有，
 * 而"看起来有第二道闸门"比没有更糟，所以删干净 —— 由 test/trigger.test.js
 * 里那条「只受冷却管」的用例保证不会有人再把它加回来。
 */

const WINDOW_MS = 8000;      // 连戳统计窗口
const POKE_THRESHOLD = 5;    // 窗口内几次算"连戳"
const COOLDOWN_MS = 45000;   // 两次主动开口的最小间隔（任何理由都受它管）
const IDLE_MS = 30 * 60000;  // 挂机多久才轻声说一句

/* v0.9.9 意志层·性格驱动主动性：特质 → 意愿权重（有界 [0.5, 1.5]）。
   只调「多愿意开口」的阈值 / 间隔，绝不触碰冷却、挂机刹车与睡眠闸门 ——
   那三道是防骚扰铁律，任何性格都不配绕过。中立特质 = 1.0，与既有常量行为完全一致。 */
function computeInitiativeBias(traits = {}) {
  const v = (k) => Number(traits[k]) || 0;
  const raw = 1 + (v('attachment_need') * 0.004 + v('social_initiative') * 0.004
    + v('vitality') * 0.003 - v('quiet_preference') * 0.004) / 2;
  return Math.max(0.5, Math.min(1.5, Number(raw.toFixed(4))));
}

class TriggerEngine {
  constructor(tracker, opts = {}) {
    this.tracker = tracker;
    this.now = opts.now || Date.now;
    this.lastFiredAt = 0;
    this.cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
    // v0.9.9 意志层：特质 → 意愿权重（缺省中立 1.0，与既有常量行为完全一致）
    this.initiativeBias = computeInitiativeBias(opts.traits || {});

    // 🔴 D-7：selfIntent 默认**显式为 null**，绝不能留 undefined。
    //   本仓踩过的坑：字段存在但从不赋值，下一个人读到 undefined 会
    //   当成「没有待办」，功能静默少一块且**不报错**。
    //   同理 selfIntentSource = null（是哪个状态推出来的）。
    this.selfIntent = null;
    this.selfIntentSource = null;

    // v1.0 D-7：traits 的原始副本。selfIntent 必须由**真实特质**推出，
    //   所以引擎自己留一份，而不是要求调用方每次 evaluate 都记得传进来。
    //   同样显式初始化为 null，不留 undefined。
    this.traits = (opts.traits && typeof opts.traits === 'object' && !Array.isArray(opts.traits))
      ? Object.assign({}, opts.traits) : null;
  }

  /** 特质随窗口演进后刷新意愿权重 —— 只动权重，绝不碰冷却 / 刹车 / 睡眠闸门 */
  updateTraits(traits) {
    this.initiativeBias = computeInitiativeBias(traits || {});
    // 🔴 D-7：刷新区必须一并更新 traits，否则自意图会永远停在旧特质上
    //   （形态清单第 5 项）。这里刻意**复制**而不是持引用：
    //   外部若持有同一个对象并在事后改它，自意图就会凭空变化而无法复现。
    this.traits = (traits && typeof traits === 'object' && !Array.isArray(traits))
      ? Object.assign({}, traits) : null;
    return this.initiativeBias;
  }

  /**
   * D-7：算出此刻她有没有可追溯的意图，结果记进 this.selfIntent。
   * @returns {?object} 同 computeSelfIntent
   */
  computeIntentNow(idleMinutes) {
    const intent = computeSelfIntent({
      traits: this.traits,
      idleMinutes,
    });
    this.selfIntent = intent;
    this.selfIntentSource = intent ? intent.sources.slice(0) : null;
    return intent;
  }

  /** @returns {?{kind, reason, hint, at, selfIntent}} null = 这次别说 */
  evaluate() {
    const tr = this.tracker;
    if (!tr) return null;
    const at = this.now();

    // 睡着了她不该自己开口 —— 真要说话也该是用户先把她叫醒
    if (tr.sleepMode) return null;
    if (at - this.lastFiredAt < this.cooldownMs) return null;

    // v0.9.9 意志层：性格只调「多愿意开口」——阈值 / 间隔有界调制；
    // 睡眠、冷却、挂机刹车三道防骚扰铁律不归它管，任何性格都别想绕过。
    const bias = this.initiativeBias;
    const pokeNeed = Math.max(3, Math.min(8, Math.round(POKE_THRESHOLD / bias)));
    const idleNeed = Math.max(IDLE_MS / 2, Math.min(IDLE_MS * 2, Math.round(IDLE_MS / bias)));

    const pokes = tr.recentClicks(WINDOW_MS, at);
    // 🔴 D-7：自意图在这里算，**在全部三道铁律之后**。
    //   位置不是随意的：意图只能改变「说什么」，
    //   绝不能改变「说不说」。若把它算在 sleepMode 之前，
    //   一个睡着的状态也会产出意图 —— 那正是本轮要防的形态。
    const idleMs = at - tr.lastInteractionAt;
    const selfIntent = this.computeIntentNow(Math.max(0, Math.round(idleMs / 60000)));

    if (pokes >= pokeNeed) {
      return {
        kind: 'poke', at,
        reason: '用户在 ' + (WINDOW_MS / 1000) + ' 秒内戳了你 ' + pokes + ' 下',
        hint: '可以喊痒、轻微抗议，或者问 ta 有什么事；别真的生气',
        // 🔴 D-7：可能为 null。**调用方必须能处理 null** ——
        //   那是「她没有可追溯的意图」的合法状态，不是错误。
        selfIntent,
      };
    }

    // 单次刹车由 tracker 持有：它同时被"用户说话了""被戳了"解除，
    // 放这边就会漏掉其中一条路径。
    if (idleMs >= idleNeed && !tr.spokenDuringIdle) {
      return {
        kind: 'idle', at,
        reason: '用户已经离开 ' + Math.round(idleMs / 60000) + ' 分钟',
        hint: '轻声问候或自言自语一句，要短，别催用户回来',
        selfIntent,
      };
    }
    return null;
  }

  /** 渲染端确认说了才记账；被礼貌闸门拒了就什么都不做，下一轮还会再问 */
  commit(out) {
    if (!out) return;
    this.lastFiredAt = out.at;
    // 连戳不需要单独记账：那 5 下过了 8 秒窗口自然不再算连戳，
    // 期间想再开口由冷却挡着 —— 同串去重是它的严格子集（见文件头）。
    if (out.kind !== 'poke' && this.tracker) this.tracker.spokenDuringIdle = true;
  }
}

/* ============================================================================
 * v1.0 D-7：自我意图（selfIntent）——「她想说什么」，而不只是「该不该开口」
 * ============================================================================
 *
 * ## 先说清这件事解决的是什么
 *
 * 上面整个文件解决的是**节流阀**：该不该开口、开口前要不要等一等。
 * 🔴 **节流阀不是意愿来源。** 一个节流阀工作得好，只说明「她不会烦你」，
 *   不说明「她有想法」—— 这两件事没有任何因果关系。
 *   D-6 之前存在一个更常见的误解：以为「主动搭话通路修好了 = 她有主动性了」。
 *   修好的只是管道，而管道里流的是**用户行为的回声**：
 *   `reason: '用户已经离开 40 分钟'` —— 源头是用户，不是她。
 *   所以现在她开口说的每一句话，实质都由用户刚才做了什么决定。
 *
 * 准确的表述：**该走的管道都在了，但里面流的是你的信号，不是她的。**
 *
 * ## 本轮只解决「意愿来源」，不解决「意愿的表达」
 *
 * 🔴 **不预生成台词**，只产出「意图方向」。
 *   理由不是偷懒，两条都站得住：
 *   ① 预生成台词会让「意图」退化成一张台词表 —— LLM 每次从表里挑一句，
 *      那还是模板，不是主体；
 *   ② 更隐蔽的坏处：**固定文本会落进日志与审计**，
 *      事后一眼就能看出她「说过的」就那么几句 —— 主体性做成了可枚举的东西。
 *      **不可枚举才像主体。**
 *   台词仍由 LLM 依据 persona 现场生成，本层只回答「她想往哪个方向说」。
 *
 * ## 三条硬判据（缺一即视为不合格实现）
 *
 *  1. **必须能为空。** 没有可追溯的状态项时就是 `null`，
 *     退化成既有的 reason 通路。**不许为了「显得有主动性」而硬造意图** ——
 *     硬造的意图比没有意图更糟：它会让用户的每一次误触发都被归到「她想要」，
 *     从而掩盖真实的触发问题。
 *
 *  2. **来源必须可追溯，且必须能映射到 persona.js 已有的维度。**
 *     这是本轮最容易被绕过去的一条：新增一个 `mood` 状态机再从它推意图，
 *     形式上「有来源」，实质是**从新造状态机推出自动化**，不是主体性。
 *     所以本层的输入**只允许两类**：
 *       · `subjectState.values` 里已存在的特质（subject-state.js 的 ALLOWED_TRAITS）
 *       · tracker 已有的客观事实（静默时长）
 *     每一项意图都必须带 `sources` 数组说明它由哪些**真实字段**推出，
 *     便于门禁直接断言「这个来源键真的存在」。
 *
 *  3. **本轮她只说不做。** 不建案、不写文件、不调任何 Agent 能力。
 *     动手的部分留到下一轮，且必须经第五道闸门（用户确认）。
 *
 * ## 为什么意图种类是有限几种、由状态决定的
 *
 * 「随机」不是合法来源：随机产生的意图不是主体性，是噪音 ——
 * 它每次说的理由都站不住，用户追问一次就露馅。
 * 但**有限种类、由状态决定**的意图是：同一种状态必然推出同一种方向，
 * 因此每次说出来都站得住。这正是判据 2 要的「可追溯」。
 */

/* 意图种类与它的唯一合法来源。
   🔴 `trait` 类意图只能挂在 ALLOWED_TRAITS 上（subject-state.js:12-18）——
     挂一个不存在的特质键就等于「从新造状态机推自动化」，判据 2 直接违规。
   `idleness` 类意图来自 tracker 已有的客观事实（静默了多久），不是新增状态机。 */
const SELF_INTENT_KINDS = Object.freeze({
  // 特质驱动：某一维偏高了，她想往那个方向说
  attachment_high:    { direction: '想提一句被留下的感觉',   requires: 'attachment_need',      min: 25 },
  curiosity_high:     { direction: '想说说刚才想到的一个问题', requires: 'philosophical_curiosity', min: 25 },
  vitality_high:      { direction: '想说点轻快的话', requires: 'vitality',               min: 25 },
  // 客观事实驱动：静默到了某个量级
  idleness_deep:      { direction: '想说一句此刻的安静',   requires: 'idleness_minutes',       min: 45 },
  idleness_verydeep:  { direction: '想说一句这次的安静比平时长', requires: 'idleness_minutes',   min: 90 },
  // 🔴 D-11：想留下点什么 —— **与 idleness 同源（都是长静默），但不同质**。
  //
  //   区别：idleness_* 是「想说话」（对着此刻的安静说一句）；
  //   本类别的产物是**一件留在那儿的东西**（写进沙盒的文件）。
  //
  //   为什么单独一类而不是复用 idleness_verydeep：
  //     复用会让「她每次安静久了都想写文件」—— 那是行为噪音，不是主体性。
  //     阈值也更高：说一句话随时可以，留下东西要安静得足够久。
  //
  //   为什么仍挂在 tracker 而非新造状态机：
  //     判据 2 要求来源可追溯到**已有字段**（见本文件头部）。
  //     新造一个 mood 状态机再推意图，形式上有来源、实质是自动化 —— 那正是判据 2 禁的。
  wantToLeaveSomething: { direction: '想留下点什么', requires: 'idleness_minutes', min: 120 },
});

/* 与触发器判定一致的中文名（subject-state.js:282-285 的定名法）。
   ⚠️ 这里给的是**她能读懂的维度名**，不是程序变量名——
   实测踩过：她会照念 `attachment_need`（见 formatPerception 的教训）。 */
const TRAIT_LABEL = Object.freeze({
  attachment_need: '依恋渴望',
  philosophical_curiosity: '好奇',
  vitality: '生命活力',
});

/**
 * 由「真实状态」推出自我意图。
 *
 * 纯函数、无副作用、可单测。**不接受随机数**。
 *
 * @param {object} [state]
 * @param {object} [state.traits]  subjectState.values（必须是已存在的特质键）
 * @param {number} [state.idleMinutes] 距上次互动的分钟数（tracker 已有的客观事实）
 * @returns {?{direction:string, kind:string, sources:string[]}}
 *   null = 她现在没有可追溯的意图 ⇒调用方**必须**退化成既有 reason 通路
 */
function computeSelfIntent(state = {}) {
  // 🔴 输入一律不信任。跨进程/跨模块传进来的对象可能根本不是对象，
  //   甚至是 undefined —— `state.traits` 在 state 为 null 时会直接抛。
  const src = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};

  const rawTraits = (src.traits && typeof src.traits === 'object' && !Array.isArray(src.traits))
    ? src.traits : {};

  // 静息时长：只认有限非负数。Infinity/NaN/负数/字符串一律视为**没有这一项**，
  // 而不是 clamp —— clamp 会把一个坏输入变成一个看起来合法的意图来源。
  const idleRaw = Number(src.idleMinutes);
  const idleMinutes = (Number.isFinite(idleRaw) && idleRaw >= 0) ? Math.floor(idleRaw) : null;

  const candidates = [];

  // 特质类：只认 SELF_INTENT_KINDS 里声明的那几个键，且必须是有限数。
  //   ⚠️ 不做泛化遍历（遍历 traits 找「大的就生成意图」）：那会让任何新加的特质
  //   都能凭空产生意图，等于给自己开了后门。**意图种类必须由本表穷举。**
  for (const kind of Object.keys(SELF_INTENT_KINDS)) {
    const spec = SELF_INTENT_KINDS[kind];
    if (!spec.requires || spec.requires === 'idleness_minutes') continue;
    const raw = Number(rawTraits[spec.requires]);
    if (!Number.isFinite(raw) || raw < spec.min) continue;
    candidates.push({
      kind,
      // 方向描述里带上中文维度名，她读到的是「依恋渴望」而不是 attachment_need
      direction: spec.direction + '（' + (TRAIT_LABEL[spec.requires] || spec.requires) + '现在偏高）',
      sources: ['traits.' + spec.requires],
    });
  }

  // 客观事实类：静默够久。两种量级互斥（>=90 只会命中更深的那条）。
  //   🔴 方向描述里**刻意不写具体分钟数**，只写量级。
  //   理由：idleMinutes 是程序时钟的换算值（idleMs/60000），
  //   一旦被原样拼进提示词，她就会说出「这次静了 50000 分钟」这种话——
  //   那既是内部时钟泄漏，也违反 persona.js:28
  //   「时间感知以现实客观时钟为准」：她不该复述程序算出来的数字。
  //   可追溯性由 sources 字段承担，不靠人话里的数字。
  //
  //   ⚠️ 括号里的补充必须**与主句不重复**（实测踩过：
  //   「这次的安静比平时长（这次的静比平时长）」读着像卡带，
  //   而这串字是要进提示词、影响她语气的，不是给人看的日志）。
  // 🔴 D-11：「想留下点什么」——静默超过 120 分钟才成立，**优先于 idleness 两档**。
  //   理由：留下东西比说一句话更重，安静得足够久才会冒出来这个念头。
  //   ⚠️ 这里**不产出台词**（台词由 LLM 现场生成，见头部判据）；
  //     本类别只回答「她想不想留」，具体写什么由建案时专门问一次。
  if (idleMinutes !== null && idleMinutes >= SELF_INTENT_KINDS.wantToLeaveSomething.min) {
    candidates.push({
      kind: 'wantToLeaveSomething',
      direction: SELF_INTENT_KINDS.wantToLeaveSomething.direction + '（安安静静地待了很久）',
      sources: ['tracker.lastInteractionAt'],
    });
  }

  if (idleMinutes !== null && idleMinutes >= SELF_INTENT_KINDS.idleness_verydeep.min) {
    candidates.push({
      kind: 'idleness_verydeep',
      direction: SELF_INTENT_KINDS.idleness_verydeep.direction + '（这次格外长）',
      sources: ['tracker.lastInteractionAt'],
    });
  } else if (idleMinutes !== null && idleMinutes >= SELF_INTENT_KINDS.idleness_deep.min) {
    candidates.push({
      kind: 'idleness_deep',
      direction: SELF_INTENT_KINDS.idleness_deep.direction + '（已经好一阵了）',
      sources: ['tracker.lastInteractionAt'],
    });
  }

  // 🔴 判据 1：一条都没有就是没有意图。**返回 null，不返回兜底文案。**
  if (candidates.length === 0) return null;

  // 多个候选同时成立时，取「特质类优先」—— 特质是她自己的，静默时长是环境。
  // 排序稳定：同优先级按本表声明顺序（Object.keys 保序），不引入随机。
  candidates.sort((a, b) => rankOf(a.kind) - rankOf(b.kind));
  return candidates[0];
}

function rankOf(kind) {
  const spec = SELF_INTENT_KINDS[kind] || {};
  // 特质类是 0（她自己），静默类是 1（环境），留下东西是 2。
  //   ⚠️ 排序越小越优先。wantToLeaveSomething 排在**静默类之前**：
  //     它由更长的静默推出，若与 idleness 同时成立（>=120 必然 >=90），
  //     取更深的那个才合理 —— 否则 120 分钟的安静只会得到「说一句安静」。
  if (kind === 'wantToLeaveSomething') return -1;   // 最优先
  return spec.requires === 'idleness_minutes' ? 1 : 0;
}

module.exports = {
  TriggerEngine, computeInitiativeBias, computeSelfIntent,
  SELF_INTENT_KINDS, TRAIT_LABEL,
  WINDOW_MS, POKE_THRESHOLD, COOLDOWN_MS, IDLE_MS,
};
