/**
 * src/memory-dynamics.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 零 API 成本记忆衰减与突触修剪动力学模型 (v0.9.7)
 * 
 * 核心哲学与工程边界：
 * 1. 档案不可篡改性（Archive Immutability）：遗忘绝非物理删除历史！
 *    experiences.jsonl 与底层 Evidence 永远完整保留。
 *    被衰减和修剪的仅是记忆条目的“当前可及性（Accessibility）”与 Prompt 上下文进入优先级。
 * 2. 纯本地代数运算（Zero API Cost）：
 *    基于改进型艾宾浩斯幂律方程在本地计算，严禁调用 LLM 评估“是否遗忘”。
 * 3. 缓存保护与关系时间（Relational Temporality）：
 *    动力学衰减严格且仅在窗口关闭（Window Close）边界执行一次，
 *    绝不在每条消息或对话期间随意变动记忆文本，杜绝制造额外的前缀缓存破坏。
 * 4. 三级活跃度分级与重新激活（Engram Tiers & Reactivation）：
 *    - ACTIVE: 活跃态（正常进入 Prompt Memory）
 *    - FADING: 衰退态（低优先级/概括印象）
 *    - DORMANT: 休眠态（移出活跃 Prompt 预算；遇到相关强刺激可唤醒复活）
 */

'use strict';

const { ENGRAM_TIERS } = require('./experiment-types');

const DEFAULT_DYNAMICS_CONFIG = Object.freeze({
  beta: 0.15,               // 召回增强系数
  lambda: 0.10,             // 跨窗口衰减基数
  alpha: 1.15,              // 幂律衰减指数
  activeThreshold: 0.60,    // ACTIVE 状态门限
  dormantThreshold: 0.35,   // DORMANT 状态门限
  dormantWindowGap: 5,      // 进入休眠所需的未召回窗口跨度
  baseStrength: 0.50        // 基础记忆强度初始值
});

/**
 * 确定性代数计算：初始记忆强度 S0 ∈ [0, 1]
 */
function calculateInitialStrength(opts = {}, config = DEFAULT_DYNAMICS_CONFIG) {
  const base = config.baseStrength ?? 0.50;
  const salience = Math.min(0.3, Math.max(0, Number(opts.salienceBonus || 0)));
  const evidence = Math.min(0.2, Math.max(0, Number(opts.evidenceBonus || 0)));

  const s0 = base + salience + evidence;
  return Math.min(1.0, Math.max(0.1, Number(s0.toFixed(4))));
}

/**
 * 改进型艾宾浩斯幂律衰减公式：S(W)
 * S(W) = clamp(S0 * (1 + β * ln(1 + retrievalCount)) / (1 + λ * ΔW)^α, 0, 1)
 */
function computeEngramDecay(trace, currentWindow, config = DEFAULT_DYNAMICS_CONFIG) {
  if (!trace || typeof trace !== 'object') return null;

  const s0 = trace.initialStrength ?? 0.5;
  const created = trace.createdWindow ?? 1;
  const current = Math.max(created, currentWindow ?? created);
  const deltaW = Math.max(0, current - created);
  const retrievals = Math.max(0, trace.retrievalCount || 0);

  const beta = config.beta ?? DEFAULT_DYNAMICS_CONFIG.beta;
  const lambda = config.lambda ?? DEFAULT_DYNAMICS_CONFIG.lambda;
  const alpha = config.alpha ?? DEFAULT_DYNAMICS_CONFIG.alpha;

  const numerator = s0 * (1 + beta * Math.log(1 + retrievals));
  const denominator = Math.pow(1 + lambda * deltaW, alpha);
  const rawStrength = numerator / denominator;
  const currentStrength = Math.min(1.0, Math.max(0.0, Number(rawStrength.toFixed(4))));

  const actThresh = config.activeThreshold ?? DEFAULT_DYNAMICS_CONFIG.activeThreshold;
  const dormThresh = config.dormantThreshold ?? DEFAULT_DYNAMICS_CONFIG.dormantThreshold;
  const dormGap = config.dormantWindowGap ?? DEFAULT_DYNAMICS_CONFIG.dormantWindowGap;

  const lastRetrieved = trace.lastRetrievedWindow ?? created;
  const gap = current - lastRetrieved;

  let tier = ENGRAM_TIERS.FADING;
  if (currentStrength >= actThresh) {
    tier = ENGRAM_TIERS.ACTIVE;
  } else if (currentStrength < dormThresh && gap >= dormGap) {
    tier = ENGRAM_TIERS.DORMANT;
  } else {
    tier = ENGRAM_TIERS.FADING;
  }

  return {
    traceId: trace.traceId,
    sourceWindowNo: trace.sourceWindowNo,
    createdWindow: trace.createdWindow,
    initialStrength: s0,
    currentStrength,
    lastRetrievedWindow: lastRetrieved,
    retrievalCount: retrievals,
    tier
  };
}

/**
 * 记忆痕迹管理器 (Engram Trace Manager)
 */
class EngramTraceManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_DYNAMICS_CONFIG, ...config };
    this.traces = new Map(); // traceId -> EngramTrace
  }

  /**
   * 注册一条新的记忆印痕
   */
  registerTrace(opts = {}) {
    const traceId = opts.traceId || `tr-w${opts.createdWindow || 1}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const createdWindow = opts.createdWindow || opts.sourceWindowNo || 1;
    const initialStrength = calculateInitialStrength(opts, this.config);

    const trace = {
      traceId,
      sourceWindowNo: opts.sourceWindowNo || createdWindow,
      createdWindow,
      initialStrength,
      currentStrength: initialStrength,
      lastRetrievedWindow: createdWindow,
      retrievalCount: 0,
      tier: initialStrength >= this.config.activeThreshold ? ENGRAM_TIERS.ACTIVE : ENGRAM_TIERS.FADING,
      contentRef: opts.contentRef || null
    };

    this.traces.set(traceId, trace);
    return trace;
  }

  getTrace(traceId) {
    return this.traces.get(traceId) || null;
  }

  getAllTraces() {
    return Array.from(this.traces.values());
  }

  /**
   * 在 Window Close 边界统一执行衰减
   */
  decayAll(currentWindow) {
    const changedTraces = [];
    const tierCounts = { ACTIVE: 0, FADING: 0, DORMANT: 0 };

    for (const [id, trace] of this.traces.entries()) {
      const prevTier = trace.tier;
      const updated = computeEngramDecay(trace, currentWindow, this.config);
      this.traces.set(id, { ...trace, ...updated });

      tierCounts[updated.tier] = (tierCounts[updated.tier] || 0) + 1;
      if (prevTier !== updated.tier) {
        changedTraces.push({
          traceId: id,
          fromTier: prevTier,
          toTier: updated.tier,
          strength: updated.currentStrength
        });
      }
    }

    return {
      windowNo: currentWindow,
      totalTraces: this.traces.size,
      tierCounts,
      changedTraces,
      parameterSnapshot: { ...this.config }
    };
  }

  /**
   * 重新激活一条记忆印痕 (Reactivation)
   */
  reactivate(traceId, currentWindow) {
    const trace = this.traces.get(traceId);
    if (!trace) return null;

    trace.retrievalCount = (trace.retrievalCount || 0) + 1;
    trace.lastRetrievedWindow = currentWindow;

    const updated = computeEngramDecay(trace, currentWindow, this.config);
    const result = { ...trace, ...updated };
    this.traces.set(traceId, result);
    return result;
  }

  /**
   * 过滤活跃态记忆（用于构建 Prompt Context）
   */
  getActiveTraces() {
    return Array.from(this.traces.values()).filter(t => t.tier === ENGRAM_TIERS.ACTIVE);
  }

  getFadingTraces() {
    return Array.from(this.traces.values()).filter(t => t.tier === ENGRAM_TIERS.FADING);
  }

  getDormantTraces() {
    return Array.from(this.traces.values()).filter(t => t.tier === ENGRAM_TIERS.DORMANT);
  }

  /**
   * 导出快照（用于落盘至 experiences.jsonl 的 memory_dynamics_snapshot 记录）
   */
  exportSnapshot(currentWindow) {
    return {
      windowNo: currentWindow,
      totalTraces: this.traces.size,
      traces: Array.from(this.traces.values()),
      config: { ...this.config },
      exportedAt: Date.now()
    };
  }

  /**
   * 从快照恢复（用于 Replay 或冷启动）
   */
  restoreFromSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.traces)) return false;
    this.traces.clear();
    for (const t of snapshot.traces) {
      if (t && t.traceId) {
        this.traces.set(t.traceId, { ...t });
      }
    }
    if (snapshot.config) {
      this.config = { ...DEFAULT_DYNAMICS_CONFIG, ...snapshot.config };
    }
    return true;
  }
}

module.exports = {
  DEFAULT_DYNAMICS_CONFIG,
  calculateInitialStrength,
  computeEngramDecay,
  EngramTraceManager
};
