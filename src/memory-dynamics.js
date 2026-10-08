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
  // 🔴 D-26 深睡突触巩固：γ = 每笔巩固的留存支持系数；cap = 累计封顶。
  //   数值刻意又小又低 —— 巩固是「减缓遗忘」，不是「刻骨铭心」；调参只动这两个常量。
  dreamSupportGamma: 0.05,
  dreamSupportCap: 3,
  dormantWindowGap: 5,      // 进入休眠所需的未召回窗口跨度
  baseStrength: 0.50,       // 基础记忆强度初始值
  // 🔴 丙（2026-10-07）：FADING 段的截断字数。
  //
  //   ## 为什么默认仍是 60（不在这里改）
  //     本常量是**所有调用方共享的默认值**；真实生效值走 `config` 覆盖
  //     （构造器 `{...DEFAULT, ...config}`），由 brain.js 从用户配置传入。
  //     在这里改会让「没传配置」的调用方（含既有单测）行为突变 ——
  //     默认值必须稳，行为变更走显式配置。
  //
  //   ## 为什么要有这个键
  //     实测（真实数据）：5 段小结全被截成 63 字，其中一段原文 5168 字。
  //     60 字连一句完整的话都放不下，读起来是**断句碎片**而不是「渐褪」。
  //     300 字 ≈ 5~6 条核心事实，才是一次真正的「印象速写」。
  fadingMaxChars: 60
});

/**
 * 面板 B 徽章：愿望结果三态（V3.1 §2.3 新增维度）
 * 取值域与 memory.js resolveExpectation() 的白名单**逐字对齐**，
 * 严禁在此自造新词——那会让 UI 显示出一个数据库里根本不存在的状态。
 */
const EXPECTATION_OUTCOMES = Object.freeze({
  FULFILLED: 'fulfilled',   // 已实现
  BROKEN: 'broken',         // 已破灭
  MOOT: 'moot'              // 已作废
});

/**
 * 面板 B 徽章：瞬时事件一态（V3.1 §2.3）
 * 与前两个维度正交——它不是"当前处于什么状态"，而是"刚刚发生了什么"。
 */
const REACTIVATION_EVENT = Object.freeze('REACTIVATED');

/**
 * 徽章分类（纯函数，零副作用）
 *
 * V3.1 §2.3：6+1 徽章是**三个正交维度**，不是一列六个互斥标签。
 * 把它们混成一列是 V3.0 的原始错误 —— 强度与结果本就可以同时成立
 * （一条 ACTIVE 且 fulfilled 的记忆完全正常），一列标签表达不了。
 *
 * @param {object} input
 * @param {string} [input.tier]             记忆强度态（ACTIVE / FADING / DORMANT）
 * @param {string} [input.outcome]          愿望结果态（fulfilled / broken / moot）
 * @param {boolean}[input.justReactivated]  是否刚刚被唤醒（本窗口内 reactivate 过）
 * @returns {{strength: ?string, outcome: ?string, event: ?string, badges: string[]}}
 */
function classifyBadges(input = {}) {
  const strength = ENGRAM_TIERS[String(input.tier || '')] || null;
  // 注意：EXPECTATION_OUTCOMES 的「键」是 FULFILLED/BROKEN/MOOT，「值」才是
  // fulfilled/broken/moot —— 而 data.expectations[].status 存的是**值**。
  // 所以这里必须拿值去比，不能拿键去 hasOwnProperty（那是本次实测踩到的真坑）。
  const rawOutcome = String(input.outcome || '');
  const outcome = Object.values(EXPECTATION_OUTCOMES).includes(rawOutcome) ? rawOutcome : null;
  const event = input.justReactivated === true ? REACTIVATION_EVENT : null;

  const badges = [];
  if (strength) badges.push(strength);
  if (outcome) badges.push(outcome);
  if (event) badges.push(event);
  return { strength, outcome, event, badges };
}

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

  // 🔴 D-26：dreamSupport 是**留存支持项**（夜间巩固带来的抗衰减能力）。
  //   ⚠️ 与 retrievalCount 严格分离：retrievalCount = 她真实被召回的次数（事实，伪造即污染）；
  //   dreamSupport = 离线巩固的记账，只减缓遗忘，**绝不冒充召回**。
  //   两项都有界（cap 先截断、外层 clamp 仍在）。
  const gamma = config.dreamSupportGamma ?? DEFAULT_DYNAMICS_CONFIG.dreamSupportGamma;
  const supportCap = config.dreamSupportCap ?? DEFAULT_DYNAMICS_CONFIG.dreamSupportCap;
  const support = Math.min(supportCap, Math.max(0, Number(trace.dreamSupport) || 0));
  const numerator = s0 * (1 + beta * Math.log(1 + retrievals)) * (1 + gamma * support);
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
      // 🔴 D-26：夜间巩固记账（有界）+ 同窗去重水位。旧快照无此字段 ⇒ 视为 0 / 未巩固。
      dreamSupport: 0,
      lastConsolidatedWindow: null,
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
   * 🔴 D-26：深睡突触巩固（Dream Consolidation）—— 梦真实发生时，对本窗真实活跃的
   *   记忆印痕做**有界的抗衰减加固**。
   *
   *   ## 不变式（用户拍板：只强化抗衰减能力，绝不借梦境伪造记忆事实）
   *   1. 只动**既有真实 trace** 的记账字段 dreamSupport —— 不新建、不删除（D-005）、
   *      不动 contentRef 与内容本体；
   *   2. **绝不加 retrievalCount** —— 那是「她真实被召回过」的事实计数，梦里重放不是召回，
   *      加了就是伪造她的经历（对应 dream-system 的 DREAM_GENERATED_ARTIFACT 不冒充亲历）；
   *   3. **只记账不结算**：当场零重算 strength / tier（同 reactivate 的护缓存铁律），
   *      效果统一在关窗 decayAll() 显现；
   *   4. **选择零梦境内容参与**：候选 = 本窗真实活跃（retrievalCount > 0 或本窗新建），
   *      按 (retrievalCount, currentStrength, traceId) 确定性排序取 Top-N —— 梦不能「挑」记忆，
   *      选择判据全部是真实数据；
   *   5. 同窗去重（一条印痕一窗最多 +1，水位 lastConsolidatedWindow）+ 累计封顶（dreamSupportCap）。
   *
   * @param {number} currentWindow 当前窗口号
   * @param {{topN?: number}} [opts]
   * @returns {{consolidated: string[], skipped: number}} 巩固了哪些 traceId（可审计）
   */
  consolidateByDream(currentWindow, opts = {}) {
    const topN = Math.max(1, Math.min(5, Number(opts && opts.topN) || 3));
    const cap = this.config.dreamSupportCap ?? DEFAULT_DYNAMICS_CONFIG.dreamSupportCap;
    const win = Number.isFinite(currentWindow) ? currentWindow : 1;
    const candidates = this.getAllTraces()
      .filter((t) => t && ((Number(t.retrievalCount) || 0) > 0 || t.createdWindow === win))
      .filter((t) => (Number(t.dreamSupport) || 0) < cap)
      .filter((t) => t.lastConsolidatedWindow !== win)   // 同窗去重（D-23 同款）
      .sort((a, b) => (Number(b.retrievalCount) || 0) - (Number(a.retrievalCount) || 0)
        || (Number(b.currentStrength) || 0) - (Number(a.currentStrength) || 0)
        || String(a.traceId).localeCompare(String(b.traceId)));
    const picked = candidates.slice(0, topN);
    for (const t of picked) {
      this.traces.set(t.traceId, {
        ...t,
        dreamSupport: Math.min(cap, (Number(t.dreamSupport) || 0) + 1),
        lastConsolidatedWindow: win
      });
    }
    return {
      consolidated: picked.map((t) => t.traceId),
      skipped: Math.max(0, candidates.length - picked.length)
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

    // 🔴 D-23：只记账，**不重算 tier**（护前缀缓存铁律）。
    //
    //   原实现在这里调 computeEngramDecay 并写回 tier —— 那会在**对话中途**
    //   改变 systemText（FADING→ACTIVE 跳变 = prompt 突变 = 破缓存）。
    //   实测（真实数据）：跳变那一轮 systemText 出现变化，前缀缓存全失。
    //
    //   现在：retrievalCount / lastRetrievedWindow 是**账本**，不进 prompt；
    //   tier 的变化统一在关窗 decayAll() 时结算（那时 system 本来就要刷新）。
    //   ⚠️ 这与 tierForDisplay 的注释一致：「tierForPrompt = trace.tier，
    //      只在关窗 decayAll() 时写定，进 Prompt 永不变化（护前缀缓存）」。
    const result = { ...trace };
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
   * 面板 B 专用：实时重算某条印痕的当前态，**零写盘、零改内存**。
   *
   * 双读路径（本轮新增，V3.1 §3）：
   *   - tierForPrompt  = trace.tier，只在关窗 decayAll() 时写定，进 Prompt 永不变化（护前缀缓存）
   *   - tierForDisplay = 本方法，纯算不落盘，只给人看
   *
   * 之所以敢这么做：computeEngramDecay() 是**纯函数**（只读 trace 不写回），
   * 破缓存的是"改变进 Prompt 的文本"，不是"重算一个数给人看"。
   *
   * @param {string} traceId
   * @param {number} currentWindow 观察时刻的窗口号（不传则用 trace.createdWindow）
   * @returns {object|null} { traceId, tierForDisplay, currentStrength, ... }；traceId 不存在返回 null
   */
  tierForDisplay(traceId, currentWindow) {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    const w = Number.isFinite(currentWindow) ? currentWindow : trace.createdWindow;
    const computed = computeEngramDecay(trace, w, this.config);
    if (!computed) return null;
    return {
      ...computed,
      // 面板 A 的定值一并带出，便于 UI 同屏对照「她以为的」与「实际的」
      tierForPrompt: trace.tier,
      // 两者不一致 = 记忆已跨过一个关窗边界但 decayAll 尚未执行（正常只在关窗前的那段窗口内出现）
      driftedFromPrompt: computed.tier !== trace.tier
    };
  }

  /**
   * 面板 B 专用：批量实时重算全部印痕的当前态，**零写盘、零改内存**。
   * 与 tierForDisplay 同源，区别只是省掉逐条 Map 查找。
   */
  tiersForDisplay(currentWindow) {
    const out = [];
    for (const [id, trace] of this.traces.entries()) {
      const computed = computeEngramDecay(trace, currentWindow, this.config);
      if (!computed) continue;
      out.push({
        ...computed,
        tierForPrompt: trace.tier,
        driftedFromPrompt: computed.tier !== trace.tier
      });
    }
    return out;
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
  EXPECTATION_OUTCOMES,
  REACTIVATION_EVENT,
  calculateInitialStrength,
  classifyBadges,
  computeEngramDecay,
  EngramTraceManager
};
