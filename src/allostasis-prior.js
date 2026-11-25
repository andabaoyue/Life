/**
 * src/allostasis-prior.js
 *
 * 《生物科学与数字生命的哲学范畴》
 * v2.1-a 预测性异稳态与关系节奏先验 (Predictive Allostasis & Relational Rhythm Prior)
 *
 * 核心原则：
 * 1. 纯本地、零 API、严禁任何后台定时器（严格遵守 D-001 关系时间模型）；
 * 2. 独立锚定真实用户输入时间戳 lastUserTurnAt，绝不复用会被 activity/proactive 刷新的指标；
 * 3. 先计算当次预测误差 gapSurprise，再将本次有效间隔入队（避免当次样本自偏）；
 * 4. 冷启动守卫（既有有效跨段间隔 < 3 条时不输出调节误差）；
 * 5. 对数空间稳健统计（中位数 + MAD），忽略时钟回拨并对 >30 天极端间隔做 Winsorize 截断。
 */

'use strict';

const MIN_RECONNECT_GAP_MS = 30 * 60 * 1000;          // 30 分钟：区分同段连续对话与跨段重连
const MAX_RECONNECT_GAP_MS = 30 * 24 * 3600 * 1000;   // 30 天：Winsorize 上界截断，防止单次超长离线压垮尺度
const MAX_RECENT_GAPS = 20;                           // 最近 20 次有效跨会话间隔有界环形缓冲
const MIN_SAMPLES_FOR_PRIOR = 3;                      // 冷启动最低既有样本门槛
const SURPRISE_MIN = -2;
const SURPRISE_MAX = 3;
const MAD_FLOOR = 0.5;                                // 对数空间离散度下限，防止节奏高度一致时除零

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * 纯函数：计算有限正数数组的中位数
 * @param {number[]} nums
 * @returns {number|null}
 */
function median(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 纯函数：清洗有效间隔序列（仅保留有限正数，且按 30 天上界截断并限制尾部 20 条）
 * @param {number[]} rawGaps
 * @returns {number[]}
 */
function sanitizeGaps(rawGaps) {
  if (!Array.isArray(rawGaps)) return [];
  const valid = [];
  for (const g of rawGaps) {
    const n = Number(g);
    if (Number.isFinite(n) && n >= MIN_RECONNECT_GAP_MS) {
      valid.push(Math.min(n, MAX_RECONNECT_GAP_MS));
    }
  }
  return valid.slice(-MAX_RECENT_GAPS);
}

/**
 * 纯函数：依据历史有效间隔序列计算关系节奏对数稳健统计量
 * @param {number[]} recentGapsMs
 * @returns {{ priorReady: boolean, sampleCount: number, typicalGapMs: number|null, madLn: number|null }}
 */
function computeAllostasisStats(recentGapsMs) {
  const gaps = sanitizeGaps(recentGapsMs);
  if (gaps.length < MIN_SAMPLES_FOR_PRIOR) {
    return {
      priorReady: false,
      sampleCount: gaps.length,
      typicalGapMs: null,
      madLn: null
    };
  }
  const lnGaps = gaps.map((g) => Math.log(g));
  const medLn = median(lnGaps);
  const typicalGapMs = Math.exp(medLn);
  const absDevs = lnGaps.map((x) => Math.abs(x - medLn));
  const madLn = median(absDevs);
  return {
    priorReady: true,
    sampleCount: gaps.length,
    typicalGapMs,
    madLn
  };
}

/**
 * 纯函数：基于历史先验评估本次跨段离开时长 awayMs 的预测误差 gapSurprise ∈ [-2, 3]
 * @param {number[]} recentGapsMs
 * @param {number} awayMs
 * @returns {{
 *   priorReady: boolean,
 *   gapSurprise: number,
 *   clampedAwayMs: number|null,
 *   sampleCount: number,
 *   typicalGapMs: number|null,
 *   madLn: number|null
 * }}
 */
function evaluateGapSurprise(recentGapsMs, awayMs) {
  const stats = computeAllostasisStats(recentGapsMs);
  if (!Number.isFinite(awayMs) || awayMs < MIN_RECONNECT_GAP_MS) {
    return {
      ...stats,
      gapSurprise: 0,
      clampedAwayMs: null
    };
  }
  const clampedAwayMs = Math.min(awayMs, MAX_RECONNECT_GAP_MS);
  if (!stats.priorReady || !Number.isFinite(stats.typicalGapMs) || stats.typicalGapMs <= 0) {
    return {
      ...stats,
      gapSurprise: 0,
      clampedAwayMs
    };
  }
  const scale = Math.max(MAD_FLOOR, Number.isFinite(stats.madLn) ? stats.madLn : 0);
  const rawSurprise = (Math.log(clampedAwayMs) - Math.log(stats.typicalGapMs)) / scale;
  const gapSurprise = Number(clamp(rawSurprise, SURPRISE_MIN, SURPRISE_MAX).toFixed(4));
  return {
    ...stats,
    gapSurprise,
    clampedAwayMs
  };
}

class AllostasisPrior {
  constructor(raw = null) {
    this.lastUserTurnAt = 0;
    this.recentGapsMs = [];
    this.lastSurprise = 0;
    if (raw && typeof raw === 'object') {
      this.fromJSON(raw);
    }
  }

  isReady() {
    return this.recentGapsMs.length >= MIN_SAMPLES_FOR_PRIOR;
  }

  /**
   * 仅在真实用户消息（!proactive）到达时调用：
   * - 首次记录只建立起点 lastUserTurnAt；
   * - 时钟回拨（awayMs <= 0）直接忽略，不污染历史与锚点；
   * - 间隔 < 30 分钟视为同段对话，仅刷新 lastUserTurnAt；
   * - 间隔 >= 30 分钟先用已有先验算 gapSurprise，再 Winsorize 入队。
   *
   * @param {number} [now=Date.now()]
   */
  recordUserTurn(now = Date.now()) {
    if (!Number.isFinite(now) || now <= 0) {
      return {
        reconnected: false,
        priorReady: this.isReady(),
        gapSurprise: 0,
        awayMs: null,
        invalidClock: true
      };
    }

    if (!Number.isFinite(this.lastUserTurnAt) || this.lastUserTurnAt <= 0) {
      this.lastUserTurnAt = now;
      return {
        reconnected: false,
        priorReady: this.isReady(),
        gapSurprise: 0,
        awayMs: null,
        coldStart: true
      };
    }

    const awayMs = now - this.lastUserTurnAt;
    if (!Number.isFinite(awayMs) || awayMs <= 0) {
      // 时钟回拨：不写入样本、不修改 lastSurprise、不倒退起点
      return {
        reconnected: false,
        priorReady: this.isReady(),
        gapSurprise: 0,
        awayMs: null,
        clockRollback: true
      };
    }

    this.lastUserTurnAt = now;

    if (awayMs < MIN_RECONNECT_GAP_MS) {
      return {
        reconnected: false,
        priorReady: this.isReady(),
        gapSurprise: 0,
        awayMs
      };
    }

    // 先算后入队：严格使用本次之前积累的 recentGapsMs 评估本次惊奇度
    const verdict = evaluateGapSurprise(this.recentGapsMs, awayMs);
    this.recentGapsMs.push(verdict.clampedAwayMs);
    if (this.recentGapsMs.length > MAX_RECENT_GAPS) {
      this.recentGapsMs = this.recentGapsMs.slice(-MAX_RECENT_GAPS);
    }
    this.lastSurprise = verdict.gapSurprise;

    return {
      reconnected: true,
      priorReady: verdict.priorReady,
      gapSurprise: verdict.gapSurprise,
      awayMs: verdict.clampedAwayMs,
      typicalGapMs: verdict.typicalGapMs,
      sampleCount: this.recentGapsMs.length
    };
  }

  /**
   * 只读摘要（供内部调节快照归档与观测，严禁直接进入 LLM Prompt）
   */
  getSummary() {
    const stats = computeAllostasisStats(this.recentGapsMs);
    return Object.freeze({
      priorReady: stats.priorReady,
      sampleCount: stats.sampleCount,
      typicalGapMs: stats.typicalGapMs !== null ? Math.round(stats.typicalGapMs) : null,
      lastSurprise: this.lastSurprise
    });
  }

  toJSON() {
    return {
      lastUserTurnAt: Number.isFinite(this.lastUserTurnAt) && this.lastUserTurnAt > 0 ? this.lastUserTurnAt : 0,
      recentGapsMs: this.recentGapsMs.slice(-MAX_RECENT_GAPS),
      lastSurprise: Number.isFinite(this.lastSurprise) ? this.lastSurprise : 0
    };
  }

  fromJSON(raw) {
    if (!raw || typeof raw !== 'object') return this;
    const t = Number(raw.lastUserTurnAt);
    this.lastUserTurnAt = Number.isFinite(t) && t > 0 ? t : 0;
    this.recentGapsMs = sanitizeGaps(raw.recentGapsMs);
    const s = Number(raw.lastSurprise);
    this.lastSurprise = Number.isFinite(s) ? clamp(s, SURPRISE_MIN, SURPRISE_MAX) : 0;
    return this;
  }
}

module.exports = {
  AllostasisPrior,
  MIN_RECONNECT_GAP_MS,
  MAX_RECONNECT_GAP_MS,
  MAX_RECENT_GAPS,
  MIN_SAMPLES_FOR_PRIOR,
  SURPRISE_MIN,
  SURPRISE_MAX,
  MAD_FLOOR,
  median,
  sanitizeGaps,
  computeAllostasisStats,
  evaluateGapSurprise
};
