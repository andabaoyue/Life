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
const POKE_OVERLOAD_THRESHOLD = 10; // v1.0.7 窗口内重度连戳阈值（10下×4=40，对齐 interactionDensity>=40 过载体感）
const COOLDOWN_MS = 45000;   // 两次主动开口的最小间隔（任何理由都受它管）

// 🔴 D-25：好奇破冰（§4.7「两段式」第二段，用户拍板 2026-10 开工）。
//   静默阈值 30 分钟 + 独立节流 40 分钟（用户拍板的黄金平衡点）。
//   节流是引擎内唯一的时序状态（lastCuriosityAt），由 commit() 记账 —— 渲染端确认说了才算数。
const CURIOSITY_IDLE_MS = 30 * 60000;
const CURIOSITY_THROTTLE_MS = 40 * 60000;
const IDLE_MS = 30 * 60000;  // 挂机多久才轻声说一句

/** 🔴 D-17：自发愿望（wantToLeaveSomething）的静默阈值，默认 120 分钟。
 *   抽成常量是为了让它与 IDLE_MS 一样**可被构造参数覆盖**（联调验证用）。
 *   ⚠️ 生产默认值不变：120 分钟。 */
const SELF_NOTE_IDLE_MS = 120 * 60000;

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
    // 🔴 D-17：idleMs 可配（验证用）。默认仍是 IDLE_MS，**行为一字不变**。
    //   为什么要可配：联调自发愿望时 120 分钟太长，而**不能去动 evaluate() 里
    //   那道 `idleMs >= idleNeed` 门槛** —— 那行是防骚扰铁律的外层，
    //   在那里开旁路等于给铁律留一个永久的洞。
    //   把整个基准调小是等价且干净的：铁律结构原样，只是「多久算久」变短。
    //   ⚠️ 副作用（验证期间可接受）：普通挂机问候也一并变频繁。
    this.idleMs = Number.isFinite(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : IDLE_MS;
    // 同理：自发愿望的静默阈值也做成可配（默认 120 分钟不变）。
    this.selfNoteIdleMs = Number.isFinite(opts.selfNoteIdleMs) && opts.selfNoteIdleMs > 0
      ? opts.selfNoteIdleMs : SELF_NOTE_IDLE_MS;
    // 🔴 D-25：好奇破冰的静默阈值与独立节流同样可配（默认 30 / 40 分钟，行为一字不变）。
    //   lastCuriosityAt 显式初始化为 0，不留 undefined（同 selfIntent 三字段的教训）。
    this.curiosityIdleMs = Number.isFinite(opts.curiosityIdleMs) && opts.curiosityIdleMs > 0
      ? opts.curiosityIdleMs : CURIOSITY_IDLE_MS;
    this.curiosityThrottleMs = Number.isFinite(opts.curiosityThrottleMs) && opts.curiosityThrottleMs > 0
      ? opts.curiosityThrottleMs : CURIOSITY_THROTTLE_MS;
    this.lastCuriosityAt = 0;
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

    // v1.3-b: 连续沉默留白计数器 (上限 K=2 退出条件)
    this.consecutiveSilenceCount = 0;
  }

  /** 重置连续沉默留白计数 (v1.3-b) */
  resetSilence() {
    this.consecutiveSilenceCount = 0;
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
  computeIntentNow(idleMinutes, curiosity = {}) {
    const intent = computeSelfIntent({
      traits: this.traits,
      idleMinutes,
      // 🔴 D-17：把可配阈值透传下去（默认 120，验证时可调小）
      selfNoteMinMinutes: Math.round(this.selfNoteIdleMs / 60000),
      // 🔴 D-25：好奇破冰的三项事实全部由调用方供（引擎不碰时钟、不碰磁盘）：
      //   pending = 待问计数、question = 队首原话、blocked = 40 分钟节流位。
      curiosityPending: curiosity && curiosity.pending,
      curiosityQuestion: curiosity && curiosity.question,
      curiosityMinMinutes: Math.round(this.curiosityIdleMs / 60000),
      curiosityBlocked: !!(curiosity && curiosity.blocked === true),
    });
    this.selfIntent = intent;
    this.selfIntentSource = intent ? intent.sources.slice(0) : null;
    return intent;
  }

  /**
   * @param {object} [opts] 🔴 D-25：好奇破冰事实（curiosityPending / curiosityQuestion）。
   *   由调用方在评估时刻取自 memory.curiosityQueue —— 引擎自己不读任何持久化。
   * @returns {?{kind, reason, hint, at, selfIntent}} null = 这次别说
   */
  evaluate(opts = {}) {
    const tr = this.tracker;
    if (!tr) return null;
    const at = this.now();

    // 睡着了她不该自己开口 —— 真要说话也该是用户先把她叫醒
    if (tr.sleepMode) return null;
    if (at - this.lastFiredAt < this.cooldownMs) return null;

    // v1.3-b: 若期间发生了用户交互，重置连续沉默计数
    if (tr && typeof tr.lastInteractionAt === 'number' && tr.lastInteractionAt > this.lastFiredAt) {
      this.consecutiveSilenceCount = 0;
    }

    // v0.9.9 意志层：性格只调「多愿意开口」——阈值 / 间隔有界调制；
    // 睡眠、冷却、挂机刹车三道防骚扰铁律不归它管，任何性格都别想绕过。
    const bias = this.initiativeBias;
    const pokeNeed = Math.max(3, Math.min(8, Math.round(POKE_THRESHOLD / bias)));
    // 🔴 D-17：基准换成本实例的 this.idleMs（默认 IDLE_MS，验证时可调小）。
    //   **铁律结构一字未改**：仍是 max(基准/2, min(基准*2, 基准/bias))。
    const base = this.idleMs;
    const idleNeed = Math.max(base / 2, Math.min(base * 2, Math.round(base / bias)));

    const pokes = tr.recentClicks(WINDOW_MS, at);
    // 🔴 D-7：自意图在这里算，**在全部三道铁律之后**。
    //   位置不是随意的：意图只能改变「说什么」，
    //   绝不能改变「说不说」。若把它算在 sleepMode 之前，
    //   一个睡着的状态也会产出意图 —— 那正是本轮要防的形态。
    const idleMs = at - tr.lastInteractionAt;
    const selfIntent = this.computeIntentNow(Math.max(0, Math.round(idleMs / 60000)), {
      pending: opts.curiosityPending,
      question: opts.curiosityQuestion,
      // 🔴 D-25：40 分钟独立节流 —— 问过之后四十分钟内不再问下一个。
      //   与「一次离开只写一张纸条」（selfNoteDuringIdle）同族的克制，但按时序而非单次。
      //   ⚠️ lastCuriosityAt === 0 表示「从未问过」，必须显式放行 ——
      //   否则小时间戳下 (at - 0) 会落进节流窗口，把「从没问过」误判成「刚问过」（首轮实测踩到）。
      blocked: this.lastCuriosityAt > 0 && (at - this.lastCuriosityAt) < this.curiosityThrottleMs,
    });

    if (pokes >= pokeNeed) {
      // v1.0.7 社交过载与独处边界：方向为 × bias，下界刻意封底在 10 下。
      // ⚠️ 刻意取舍（Trade-off）：高安静者按 10×0.5=5 数学上本该更早过载，但封底 10 下牺牲了低端性格差异
      // （喜静与中立过载线同为 10 下），换取与 formatPerception() 的 interactionDensity>=40（10×4=40）同步，
      // 避免「hint 已报过载退避、生理体感却无输出」的嘴身脱节；喜静差异由 pokeNeed=8 将轻抗议缓冲压窄为 8~9 下体现。
      const overloadNeed = Math.max(10, Math.min(15, Math.round(POKE_OVERLOAD_THRESHOLD * bias)));
      return {
        kind: 'poke', at,
        reason: '用户在 ' + (WINDOW_MS / 1000) + ' 秒内戳了你 ' + pokes + ' 下',
        hint: pokes >= overloadNeed
          ? '被连续密集戳弄得有些心神散乱；请委婉但明确地表达想一个人安静待会儿、请 ta 先别戳了，不必顺从迎合'
          : '可以喊痒、轻微抗议，或者问 ta 有什么事；别真的生气',
        // 🔴 D-7：可能为 null。**调用方必须能处理 null** ——
        //   那是「她没有可追溯的意图」的合法状态，不是错误。
        selfIntent,
      };
    }

    // 单次刹车由 tracker 持有：它同时被"用户说话了""被戳了"解除，
    // 放这边就会漏掉其中一条路径。
    // 🔴 D-16 修 D-15 的两处致命回归（反重力复核发现，已实测复现）：
    //
    //   ① **变量名手误**：D-15 把 spokenDuringIdle 误写成 spokenWhenIdle，
    //      而 tracker 里根本没有后者 ⇒ tr.spokenWhenIdle 恒 undefined
    //      ⇒ !undefined 恒 true ⇒ **挂机单次刹车彻底失效**，
    //      实测 60min / 90min 都会继续开口（撞 persona.js:29 防骚扰铁律）。
    //   ② **只设 spokenDuringIdle 挡不住重复建案**（反重力建议的修法不够）：
    //      120 分钟后 selfIntent 恒为 wantToLeaveSomething，
    //      光锁 spokenDuringIdle 时 isSelfNote 仍为 true ⇒ 每 45 秒冷却一过
    //      就再建一案。实测 15 分钟触发 20 次。
    //
    //   ⇒ 正解：**用独立的单次刹车 selfNoteDuringIdle**。
    //      它由 commit() 置位、由用户互动/醒来解除（与 spokenDuringIdle 同时机）。
    //      语义是「这一次漫长离开里，她已经留过东西了」。
    //      **一次离开只写一张纸条** —— 这才是该有的克制。
    const isSelfNote = selfIntent && selfIntent.kind === 'wantToLeaveSomething';
    const selfNoteBlocked = isSelfNote && tr.selfNoteDuringIdle === true;
    if (idleMs >= idleNeed && !selfNoteBlocked && (!tr.spokenDuringIdle || isSelfNote)) {
      // v1.3-b: 沉默留白第三种结局 (D-A / D-C / Q2 / Q3)
      // 仅作用于主动场景 (非 isSelfNote)，且基于已有长期特质 quiet_preference >= 60
      // 严禁随机，且带有严格退出条件：连续沉默上限 K=2，达到则必须回退常规 idle 搭话
      const quietPref = Number(this.traits && this.traits.quiet_preference) || 0;
      if (!isSelfNote && quietPref >= 60 && this.consecutiveSilenceCount < 2) {
        return {
          kind: 'silent_presence', at,
          reason: '用户已经离开 ' + Math.round(idleMs / 60000) + ' 分钟（偏好安静陪伴）',
          hint: '静默相伴，不出声，仅微动作同在',
          selfIntent,
        };
      }
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
    // v1.3-b: 连续沉默留白计数与退出重置
    if (out.kind === 'silent_presence') {
      this.consecutiveSilenceCount++;
    } else {
      this.consecutiveSilenceCount = 0;
    }
    // 连戳不需要单独记账：那 5 下过了 8 秒窗口自然不再算连戳，
    // 期间想再开口由冷却挡着 —— 同串去重是它的严格子集（见文件头）。
    // 🔴 D-16：两条刹车分开记。
    //   spokenDuringIdle  —— 防「反复说话骚扰」（原有铁律，一个字不许松）。
    //   selfNoteDuringIdle —— 防「反复建案」（D-15 引入 wantToLeaveSomething 后的新需要）。
    //   ⚠️ 不能合并：合并会让 30 分钟那声问候把 120 分钟的愿望锁死（D-15 断点 1）。
    const isSelfNote = out.selfIntent && out.selfIntent.kind === 'wantToLeaveSomething';
    const isCuriosity = out.selfIntent && out.selfIntent.kind === 'curiosityAsk';
    if (this.tracker) {
      if (isSelfNote) this.tracker.selfNoteDuringIdle = true;
      // D-25：好奇提问是**开口**（不是留纸条）⇒ 照吃 spokenDuringIdle 刹车，一视同仁
      // v1.3-b: silent_presence 亦置位 spokenDuringIdle，表示本轮挂机已产生留白陪伴，防止每 45 秒重复触发微动作
      else if (out.kind !== 'poke') this.tracker.spokenDuringIdle = true;
    }
    // 🔴 D-25：好奇破冰独立节流记账 —— 只有真的说出口才记（被礼貌闸门拒了不记，下次还问）
    if (isCuriosity) this.lastCuriosityAt = out.at;
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
  // 🔴 D-25：好奇破冰 —— 她想问一个自己没解开的问题（§4.7「两段式」第二段，用户拍板开工）。
  //
  //   requires 是 memory.curiosityQueue 的**真实待问计数**（她的未解疑问来自关窗小结的
  //   unresolved，有窗口可溯）—— 不是特质、不是新造状态机，判据 2 依旧成立。
  //   min 是静默阈值（分钟，用户拍板 30）；40 分钟独立节流在引擎侧（curiosityBlocked）。
  //
  //   ⚠️ 不预设台词：具体问题就是队列里的**她自己的原话**，只随方向带出引证；
  //     程序不代写一个字的问法。
  curiosityAsk: { direction: '想问一个自己没解开的问题', requires: 'curiosity_pending', min: 30 },
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
 * @param {number} [state.selfNoteMinMinutes] 🔴 D-17：自发愿望的静默阈值（分钟）。
 *   缺省 = SELF_INTENT_KINDS.wantToLeaveSomething.min（120）。**仅供联调验证覆盖**。
 *   为什么做成入参而不是改表里的 min：表是「意图种类穷举」的声明处，
 *   改它会让生产默认值也变 —— 而入参只在调用方显式传时才生效。
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
    // 非特质来源（静默时长 / 好奇队列）各有专门分支，这里只走特质类
    if (!spec.requires || spec.requires === 'idleness_minutes' || spec.requires === 'curiosity_pending') continue;
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
  const selfNoteMin = (Number.isFinite(Number(src.selfNoteMinMinutes)) && Number(src.selfNoteMinMinutes) > 0)
    ? Number(src.selfNoteMinMinutes) : SELF_INTENT_KINDS.wantToLeaveSomething.min;
  if (idleMinutes !== null && idleMinutes >= selfNoteMin) {
    candidates.push({
      kind: 'wantToLeaveSomething',
      direction: SELF_INTENT_KINDS.wantToLeaveSomething.direction + '（安安静静地待了很久）',
      sources: ['tracker.lastInteractionAt'],
    });
  }

  // 🔴 D-25：好奇破冰 —— 她想问一个自己没解开的问题。
  //   来源 memory.curiosityQueue（未解疑问由关窗小结 unresolved 真实产出，窗口可溯）。
  //
  //   ## 问题文本为什么不搬运台词
  //   【尚未解开的疑问】本来就在她的视野里（memory.build 的注入块）——
  //   这里只把「问哪一个」钉死为 **FIFO 队首**（放最久的那个），asked 标记也对着它，
  //   两边看的是同一条，才不会「问了 A 却把 B 标成已问」。
  //   方向里带的是她自己的原话引证，不是程序代拟的问法。
  //
  //   ## 节流位（curiosityBlocked）在这里消费而不是在引擎里判
  //   本函数是纯函数：谁该被节流由调用方按 at 算好传进来（同 idleMinutes 的哲学），
  //   被节流时**整类不产**，退化给下一个候选（或没有意图）—— 不硬造替代意图。
  const curiosityPending = (Number.isFinite(Number(src.curiosityPending)) && Number(src.curiosityPending) > 0)
    ? Math.floor(Number(src.curiosityPending)) : 0;
  const curiosityMin = (Number.isFinite(Number(src.curiosityMinMinutes)) && Number(src.curiosityMinMinutes) > 0)
    ? Number(src.curiosityMinMinutes) : SELF_INTENT_KINDS.curiosityAsk.min;
  const curiosityQ = (typeof src.curiosityQuestion === 'string' && src.curiosityQuestion.trim())
    ? src.curiosityQuestion.trim().slice(0, 120) : '';
  if (src.curiosityBlocked !== true && curiosityPending > 0
      && idleMinutes !== null && idleMinutes >= curiosityMin) {
    candidates.push({
      kind: 'curiosityAsk',
      // 方向里的原话只带前 30 字（引证用途；全句在 systemText 的疑问块里本来就有）
      direction: SELF_INTENT_KINDS.curiosityAsk.direction
        + (curiosityQ ? '（就是这个：「' + curiosityQ.slice(0, 30) + '」）' : '（就在你那些没解开的问题里挑）'),
      sources: ['memory.curiosityQueue'],
      // 队首原话 —— asked 标记的对账键（main.js 出口记账用），不是台词
      question: curiosityQ,
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
  //   🔴 D-25：curiosityAsk（requires 非 idleness_minutes）落在 0 档 ——
  //     未解疑问是**她自己的**挂念，不是环境量；但仍让位于 wantToLeaveSomething（-1）：
  //     留下东西比问一句更重，静默 120 分钟的那次取更重的。
  if (kind === 'wantToLeaveSomething') return -1;   // 最优先
  return spec.requires === 'idleness_minutes' ? 1 : 0;
}

module.exports = {
  TriggerEngine, computeInitiativeBias, computeSelfIntent,
  SELF_INTENT_KINDS, TRAIT_LABEL,
  WINDOW_MS, POKE_THRESHOLD, POKE_OVERLOAD_THRESHOLD, COOLDOWN_MS, IDLE_MS,
  CURIOSITY_IDLE_MS, CURIOSITY_THROTTLE_MS,
};
