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
  }

  /** 特质随窗口演进后刷新意愿权重 —— 只动权重，绝不碰冷却 / 刹车 / 睡眠闸门 */
  updateTraits(traits) {
    this.initiativeBias = computeInitiativeBias(traits || {});
    return this.initiativeBias;
  }

  /** @returns {?{kind, reason, hint, at}} null = 这次别说 */
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
    if (pokes >= pokeNeed) {
      return {
        kind: 'poke', at,
        reason: '用户在 ' + (WINDOW_MS / 1000) + ' 秒内戳了你 ' + pokes + ' 下',
        hint: '可以喊痒、轻微抗议，或者问 ta 有什么事；别真的生气'
      };
    }

    const idleMs = at - tr.lastInteractionAt;
    // 单次刹车由 tracker 持有：它同时被"用户说话了""被戳了"解除，
    // 放这边就会漏掉其中一条路径。
    if (idleMs >= idleNeed && !tr.spokenDuringIdle) {
      return {
        kind: 'idle', at,
        reason: '用户已经离开 ' + Math.round(idleMs / 60000) + ' 分钟',
        hint: '轻声问候或自言自语一句，要短，别催用户回来'
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

module.exports = { TriggerEngine, computeInitiativeBias, WINDOW_MS, POKE_THRESHOLD, COOLDOWN_MS, IDLE_MS };
