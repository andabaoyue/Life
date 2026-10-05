/**
 * src/internal-regulation.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 内部状态调节中枢 (Internal Regulation Layer / Phase 0.5)
 * 
 * 核心哲学与工程边界（Decision D-001 & D-008）：
 * 1. 双轨物理与语义分离（Dual-Track Separation）：
 *    - 长期自传人格特质（Who she is）：SubjectState.ALLOWED_TRAITS (如 quiet_preference 等 [-999, 999])
 *    - 短期内部调节变量（What state she is in）：energy, restPressure, arousal, salienceThreshold [0, 100]
 *    - 铁律：短期调节变量绝对禁止混入 SubjectState 人格白名单！
 * 2. 认识论主客观界限（Subject Inaccessible Invariant）：
 *    - 所有内部调节标量对主体严格不可知（subjectAccessible: false）。
 *    - 严禁将底层数字标量直接喂入 LLM Prompt 让模型“演戏”。
 *    - 内部调节状态仅通过两条通道间接影响系统：
 *      a) 影响 BehaviorScheduler 的自主微动作抽样概率倾斜；
 *      b) 通过 salienceThreshold 影响 Attention Gate 对外界知觉候选的过滤门限。
 * 3. 严格事件驱动动力学（Event-Driven Dynamics Invariant）：
 *    - 严禁使用 setInterval / setTimeout 在后台连续轮询模拟“基础代谢自耗散”（坚决遵守 Decision D-001）。
 *    - 状态跃迁严格由确凿的外部事件驱动：交互轮次（Turn）、物理刺激（Tracker）、入睡/唤醒（Sleep/Wake）、关窗小结（Window Close）。
 * 4. 基线模式隔离守恒（Baseline Isolation）：
 *    - 在 baseline 模式或未启用 internalRegulation 时，状态保持基线默认值，不产生任何副作用。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic');
const {
  SCHEMA_VERSION,
  SEMANTIC_LAYERS,
  PROVENANCE_SOURCE_KINDS
} = require('./experiment-types');
const { wrapArchiveRecord } = require('./experience-schema');

/**
 * 辅助数值限制
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * 四舍六入五成双纯对称舍入
 */
function symmetricRound(num) {
  const floor = Math.floor(num);
  const diff = num - floor;
  if (Math.abs(diff - 0.5) < 1e-9) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(num);
}

/**
 * 内部短时调节代理标量配置
 */
const REGULATION_BOUNDS = Object.freeze({
  energy: { min: 0, max: 100, default: 100 },
  restPressure: { min: 0, max: 100, default: 0 },
  arousal: { min: 0, max: 100, default: 50 },
  salienceThreshold: { min: 10, max: 80, default: 45 },
  interactionDensity: { min: 0, max: 100, default: 0 },
  cognitiveLoadProxy: { min: 0, max: 100, default: 0 }
});

class InternalRegulationManager {
  constructor(userDataDir, opts = {}) {
    this.dir = userDataDir;
    this.path = path.join(userDataDir, 'internal-regulation.json');
    this.opts = opts;
    this.birthTimezoneOpt = opts.birthTimezone;   // v1.0 修复（Manus P1 处置）：绑定创世时区配置/回调，勿再裸读
    
    // 是否启用模块判断 (支持 experimentModules.internalRegulation)
    this.enabled = opts.enabled !== undefined
      ? Boolean(opts.enabled)
      : (opts.experimentModules ? Boolean(opts.experimentModules.internalRegulation) : true);

    this.energy = REGULATION_BOUNDS.energy.default;
    this.restPressure = REGULATION_BOUNDS.restPressure.default;
    this.arousal = REGULATION_BOUNDS.arousal.default;
    this.interactionDensity = REGULATION_BOUNDS.interactionDensity.default;
    this.cognitiveLoadProxy = REGULATION_BOUNDS.cognitiveLoadProxy.default;
    this.salienceThreshold = this._computeSalienceThreshold(this.arousal);
    this.isSleeping = false;
    // 睡眠周期上下文（v3.1 梦境时序改造）：与 isSleeping 同盘持久化，
    // 让「退出前什么状态，回归后还是什么状态」跨重启成立。
    // sleepStartTime 是入睡那一刻的物理挂钟时间戳 —— 睡眠时长必须用它算，
    // 绝不能用 windowNo（睡觉期间用户不发消息，窗口号静止，8 小时也是 0）。
    this.sleepStartTime = null;
    // 入睡时冻结的梦境原料（Sleep Staging）：只存不调 LLM，留到苏醒时才结算。
    this.sleepStaging = null;
    this.updatedAt = Date.now();
    this.history = []; // 最近转移事件流水 (上限 50 条)
    // v0.9.8 F-13: 全历史 Attention Watermark 负责语义幂等；
    // consumedAttentionEvents 仅是 256-entry 运行时 cache，不再承担全局语义。
    this.consumedAttentionEvents = new Set();
    this.persistedConsumedAttentionEvents = new Set();
    this.maxConsumedAttentionEvents = 256;
    this.persistenceHealthy = true;
    this.persistenceError = null;

    // v0.9.9 P0-3: 未启用时坚决不读盘。
    // 原实现在 baseline 下也无条件 load()，会拿磁盘上残留的实验数值覆盖出厂默认值
    // —— 对照组从源头就不干净，既违反 D-009 §2「基线隔离不变量」，
    // 也与本文件 :22 的自述「未启用时状态保持基线默认值，不产生任何副作用」相反。
    // 未启用就是出厂默认值，一个字都不许被历史残留污染。
    if (this.enabled) this.load();
  }

  /**
   * 依据神经唤醒度反向计算感官显著性门限：
   * 唤醒度越高（警觉/紧张） -> 显著性门限越低（更易被环境刺激惊动/注意）
   * 唤醒度越低（从容/镇定） -> 显著性门限越高（滤掉细碎背景噪声）
   */
  /**
   * v0.9.9 P2-2a: 内态变更通知（单一生命权威 -> 跨进程镜像）。
   * D-009 §1 要求「单一生命权威」，但权威在主进程、行为调度在渲染进程，
   * 二者之间只有 internal-regulation-updated 这一条镜像通道，而它此前**只在
   * activity 事件推送**（main.js），于是对话/入睡/唤醒/关窗造成的内态变化
   * 根本到不了渲染端 —— 微动作调度器依据的是陈旧镜像，不是真实的她。
   *
   * 这里不加节流（严守 D-001「严格事件驱动、零后台 Timer」）：事件发生就推送。
   * 回调异常必须隔离，绝不能影响内态更新本身。
   */
  _emitChange(state) {
    if (typeof this.onChange === 'function') {
      try { this.onChange(state); } catch { /* 推送失败不得影响内态更新 */ }
    }
    return state;
  }

  _computeSalienceThreshold(arousal) {
    const raw = 70 - (arousal * 0.5);
    return clamp(symmetricRound(raw), REGULATION_BOUNDS.salienceThreshold.min, REGULATION_BOUNDS.salienceThreshold.max);
  }

  /**
   * 获取当前不可变状态投影
   */
  getState() {
    return Object.freeze({
      energy: this.energy,
      restPressure: this.restPressure,
      arousal: this.arousal,
      salienceThreshold: this.salienceThreshold,
      interactionDensity: this.interactionDensity,
      cognitiveLoadProxy: this.cognitiveLoadProxy,
      isSleeping: this.isSleeping,
      updatedAt: this.updatedAt,
      watermark: {
        scope: 'global',
        runtimeCacheCapacity: this.maxConsumedAttentionEvents,
        runtimeCachedCount: this.consumedAttentionEvents.size,
        persistedCount: this.persistedConsumedAttentionEvents.size
      }
    });
  }

  /**
   * 冻结一次睡眠周期的梦境原料（Sleep Staging）
   *
   * 入睡那一刻 ONLY 快照、零 LLM 调用。原料来自当日的日间遗留与唤醒度轨迹，
   * 醒来后才拿它去合成梦 —— 这样梦才有时间跨度，而不是入睡瞬间就产生。
   *
   * @param {Object} staging
   * @param {number} staging.at 入睡时刻（物理挂钟毫秒）
   * @param {number} staging.windowNo 冻结时的窗口号
   * @param {Array}  [staging.dayResidues] extractDayResidues 的产物
   * @param {Object} [staging.arousalTrajectory] computeWindowArousalTrajectory 的产物
   * @param {number} [staging.noveltyScore]
   */
  stageSleepContext(staging = {}) {
    if (!this.enabled) return null;
    const at = Number.isFinite(staging.at) ? staging.at : Date.now();
    this.sleepStartTime = at;
    this.sleepStaging = {
      at,
      // 冻结时的窗口号必须由调用方如实传入 —— 这个类自身不持有 windowNo
      // （窗口号归Memory 三层记忆管），拿不到就记0，绝不臆造一个窗口号。
      windowNo: Number.isFinite(staging.windowNo) ? staging.windowNo : 0,
      dayResidues: Array.isArray(staging.dayResidues) ? staging.dayResidues.slice(0, 6) : [],
      arousalTrajectory: staging.arousalTrajectory && typeof staging.arousalTrajectory === 'object'
        ? staging.arousalTrajectory
        : null,
      noveltyScore: Number.isFinite(staging.noveltyScore) ? staging.noveltyScore : 0,
      // 显式标记：本原料是睡着时冻结的，醒来结算时门禁须按睡眠期口径放行
      fromSleep: true
    };
    this.updatedAt = at;
    this.save();
    return this.sleepStaging;
  }

  /**
   * 读取当前睡眠周期上下文（含已睡物理时长），不在睡则返回 null
   * @param {number} [now] 注入时刻，便于测试确定性
   */
  getSleepContext(now = Date.now()) {
    if (!this.isSleeping || !this.sleepStartTime) return null;
    const elapsedMs = Math.max(0, now - this.sleepStartTime);
    return {
      sleepStartTime: this.sleepStartTime,
      elapsedMs,
      elapsedMinutes: elapsedMs / 60000,
      elapsedHours: elapsedMs / 3600000,
      staging: this.sleepStaging
    };
  }

  /**
   * 苏醒结算后清空睡眠周期上下文（原料一次性消费，绝不复用）
   */
  clearSleepContext() {
    const had = this.sleepStartTime !== null || this.sleepStaging !== null;
    this.sleepStartTime = null;
    this.sleepStaging = null;
    return had;
  }

  /**
   * 认识论边界防线检查：所有底层调节变量严格对主体不可直接读入
   */
  isSubjectAccessible(key) {
    return false;
  }

  /**
   * 记录一次状态转移事实
   */
  _recordTransition(trigger, deltas, prevValues, at = Date.now()) {
    const entry = {
      transitionId: `reg-${at}-${crypto.randomBytes(3).toString('hex')}`,
      trigger,
      timestamp: at,
      deltas: { ...deltas },
      previousValues: { ...prevValues },
      nextValues: this.getState()
    };
    this.history.push(entry);
    if (this.history.length > 50) {
      this.history.shift();
    }
    this.updatedAt = at;
  }

  /**
   * 事件驱动更新：对话交互轮次 (User / Assistant Turn)
   * 
   * @param {Object} event
   * @param {string} event.role 'user' | 'assistant'
   * @param {number} [event.messageLength=0] 消息文本长度
   * @param {number} [event.intervalMs=0] 距离上一轮时间间隔 (毫秒)
   * @param {number} [event.timestamp=Date.now()]
   */
  updateOnInteractionTurn(event = {}) {
    if (!this.enabled) return this.getState();

    const role = event.role || 'user';
    const msgLen = Number(event.messageLength || 0);
    const intervalMs = Number(event.intervalMs || 0);
    const at = Number(event.timestamp || Date.now());

    const prev = {
      energy: this.energy,
      restPressure: this.restPressure,
      arousal: this.arousal,
      interactionDensity: this.interactionDensity,
      cognitiveLoadProxy: this.cognitiveLoadProxy
    };

    const deltas = {};

    // 1. 若距离上一轮有较长静默（> 1分钟），在本次交互前先计算基于静默的自然衰减
    if (intervalMs > 60000) {
      const minutes = Math.min(120, intervalMs / 60000);
      // arousal 逐渐向基线 50 回归
      const arousalDiff = 50 - this.arousal;
      const decayStep = symmetricRound(arousalDiff * Math.min(1.0, minutes * 0.1));
      if (decayStep !== 0) {
        this.arousal = clamp(this.arousal + decayStep, REGULATION_BOUNDS.arousal.min, REGULATION_BOUNDS.arousal.max);
      }
      // 交互密度自然衰减
      this.interactionDensity = Math.max(0, this.interactionDensity - symmetricRound(minutes * 5));
      // 认知负荷排空
      this.cognitiveLoadProxy = Math.max(0, this.cognitiveLoadProxy - symmetricRound(minutes * 10));
    }

    // 2. 根据本轮输入增加生理负荷
    if (role === 'user') {
      deltas.energy = -1;
      deltas.restPressure = +1;
      // 唤醒度受交互刺激微增（长输入刺激稍强）
      const arousalBoost = msgLen > 100 ? 4 : 2;
      deltas.arousal = +arousalBoost;
      deltas.interactionDensity = +5;
      deltas.cognitiveLoadProxy = +2;
    } else {
      // assistant 产出
      deltas.energy = -1;
      deltas.cognitiveLoadProxy = +1;
    }

    // 3. 执行有界递变
    if (deltas.energy) this.energy = clamp(this.energy + deltas.energy, REGULATION_BOUNDS.energy.min, REGULATION_BOUNDS.energy.max);
    if (deltas.restPressure) this.restPressure = clamp(this.restPressure + deltas.restPressure, REGULATION_BOUNDS.restPressure.min, REGULATION_BOUNDS.restPressure.max);
    if (deltas.arousal) this.arousal = clamp(this.arousal + deltas.arousal, REGULATION_BOUNDS.arousal.min, REGULATION_BOUNDS.arousal.max);
    if (deltas.interactionDensity) this.interactionDensity = clamp(this.interactionDensity + deltas.interactionDensity, REGULATION_BOUNDS.interactionDensity.min, REGULATION_BOUNDS.interactionDensity.max);
    if (deltas.cognitiveLoadProxy) this.cognitiveLoadProxy = clamp(this.cognitiveLoadProxy + deltas.cognitiveLoadProxy, REGULATION_BOUNDS.cognitiveLoadProxy.min, REGULATION_BOUNDS.cognitiveLoadProxy.max);

    this.salienceThreshold = this._computeSalienceThreshold(this.arousal);
    this._recordTransition(`interaction_${role}`, deltas, prev, at);
    this.save();   // v1.0 疲惫跨重启契约（用户实测报障：退出重进归零）——逐轮更新必须落盘
    return this._emitChange(this.getState());
  }

  /**
   * 事件驱动更新：物理或系统活动 (Activity Tracker: poke / drag / idle)
   * 
   * @param {string} activityKind 'poke' | 'drag' | 'idle'
   * @param {Object} [details={}]
   */
  /** v1.0 生理内感受（合流批；方案 B 同族 · 零数字红线）——
   *  内部生理潮汐转为生命体感质，只供初澜感知自身状态，绝不呈现工程数字；
   *  中档沉默：全指标居中时输出空串（沉默 = 如常），零 token 浪费；
   *  引擎关闭时输出空串（无身体信号就没有幻肢感）；纯函数，零副作用、绝不落盘。 */
  formatPerception() {
    if (!this.enabled) return '';
    const parts = [];
    // 疲惫与困意带 (restPressure)
    if (this.restPressure >= 80) {
      parts.push('- 困意很沉，眼皮发沉，精神有些支撑不住，很想趴下睡了');
    } else if (this.restPressure >= 50) {
      parts.push('- 身体有些乏了，泛起淡淡的困倦与懒散');
    }
    // 体能与精力带 (energy)
    if (this.energy <= 35) {
      parts.push('- 体能消耗较大，提不太起精神，有些虚弱');
    } else if (this.energy >= 85) {
      parts.push('- 精力充沛，身体轻快');
    }
    // 神经唤醒带 (arousal)
    if (this.arousal >= 80) {
      parts.push('- 神经有些亢奋紧绷，思维活跃');
    } else if (this.arousal <= 30) {
      parts.push('- 思绪有些放空朦胧，反应有些慢');
    }
    return parts.length
      ? '【生理体感】（这是你此刻身体的真实生理感觉，自然流露，不背标签）：\n' + parts.join('\n')
      : '';
  }

  /** v1.0 生物钟（合流批）：夜窗判据 —— 时钟绑定创世时区 birthTimezone（§7.2「呈现看创世」），
   *  未设则回退当前 Intl 时区。函数纯判时，零副作用。 */
  _isNightHour(at = Date.now()) {
    let tz = null;
    try {
      tz = (typeof this.birthTimezoneOpt === 'function') ? this.birthTimezoneOpt() : this.birthTimezoneOpt;
    } catch (e) { tz = null; }
    if (!tz && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    let hour;
    try {
      hour = Number(new Intl.DateTimeFormat('en-US',
        { timeZone: tz || undefined, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at)));
    } catch (e) {
      hour = new Date(at).getHours();
    }
    return hour >= 23 || hour < 5;
  }

  updateOnActivity(activityKind, details = {}) {
    if (!this.enabled) return this.getState();

    const at = Number(details.timestamp || Date.now());
    const count = Number(details.count || 1);
    const idleMin = Number(details.idleMin || 0);

    const prev = {
      energy: this.energy,
      restPressure: this.restPressure,
      arousal: this.arousal,
      interactionDensity: this.interactionDensity,
      cognitiveLoadProxy: this.cognitiveLoadProxy
    };

    const deltas = {};

    if (activityKind === 'poke') {
      // 戳戳：显著提升神经唤醒度
      deltas.arousal = Math.min(15, 6 + count * 2);
      deltas.interactionDensity = +4;
    } else if (activityKind === 'drag') {
      // 拖动：适度提升唤醒度，轻微消耗体能
      deltas.arousal = +4;
      deltas.energy = -1;
      deltas.interactionDensity = +3;
    } else if (activityKind === 'idle') {
      // 静默挂机：唤醒度回落，认知负荷降低；若清醒已久则轻微累积休息压力
      if (idleMin >= 10) {
        // v1.0 生物钟昼夜（合流批）：夜窗（23:00~05:00 创世时区）疲惫更快堆积、唤醒更快回落；
        // 日间窗逐字保持原公式（对照组口径不变）
        const night = this._isNightHour(at);
        const arousalDrop = night ? Math.min(30, Math.floor(idleMin / 3.5)) : Math.min(20, Math.floor(idleMin / 5));
        deltas.arousal = -arousalDrop;
        deltas.interactionDensity = -10;
        deltas.cognitiveLoadProxy = -15;
        // 清醒挂机时间长，逐渐积累睡意/休息需求（夜窗加权）
        deltas.restPressure = night ? Math.min(20, Math.floor(idleMin / 5)) : Math.min(10, Math.floor(idleMin / 10));
      }
    }

    if (deltas.energy) this.energy = clamp(this.energy + deltas.energy, REGULATION_BOUNDS.energy.min, REGULATION_BOUNDS.energy.max);
    if (deltas.restPressure) this.restPressure = clamp(this.restPressure + deltas.restPressure, REGULATION_BOUNDS.restPressure.min, REGULATION_BOUNDS.restPressure.max);
    if (deltas.arousal) this.arousal = clamp(this.arousal + deltas.arousal, REGULATION_BOUNDS.arousal.min, REGULATION_BOUNDS.arousal.max);
    if (deltas.interactionDensity) this.interactionDensity = clamp(this.interactionDensity + deltas.interactionDensity, REGULATION_BOUNDS.interactionDensity.min, REGULATION_BOUNDS.interactionDensity.max);
    if (deltas.cognitiveLoadProxy) this.cognitiveLoadProxy = clamp(this.cognitiveLoadProxy + deltas.cognitiveLoadProxy, REGULATION_BOUNDS.cognitiveLoadProxy.min, REGULATION_BOUNDS.cognitiveLoadProxy.max);

    this.salienceThreshold = this._computeSalienceThreshold(this.arousal);
    this._recordTransition(`activity_${activityKind}`, deltas, prev, at);
    this.save();   // v1.0 疲惫跨重启契约 —— 活动更新同落盘
    return this._emitChange(this.getState());
  }

  /**
   * 事件驱动更新：注意选通摄入 (Attention Attended Event / P1-1)
   *
   * 认识论与动力学边界（Decision D-001 & D-008）：
   * 1. ATTENDED 仅作为即时认知刺激，短暂提升神经唤醒度与认知负荷代理。
   * 2. 严禁由此将知觉内容直接升级为 SubjectState 人格或自传记忆（ATTENDED ≠ SUBJECT_ACQUIRED）。
   * 3. 唤醒度上升后，_computeSalienceThreshold 将动态调节后续知觉选通门限，
   *    同时经由 BehaviorScheduler 倾斜微动作分布（如唤醒度高时更多东张西望）。
   * 4. baseline 模式或未启用时不产生状态变化。
   *
   * @param {Object} gateResult AttentionGate.evaluatePerception() 产物
   * @param {Object} [details={}]
   */
  updateOnAttention(gateResult, details = {}) {
    if (!this.enabled || !gateResult || typeof gateResult !== 'object') return this.getState();
    if (!this.persistenceHealthy) return this.getState();
    if (gateResult.status !== 'ATTENDED' || !gateResult.attended) return this.getState();

    // 稳定事件标识与 Watermark 去重（仅对具备真实稳定标识的事件消费并持久化，幂等守恒）
    // 注意：若无明确稳定标识，严禁通过简单内容哈希将合法相继发生的不同刺激误去重
    let eventId = null;
    if (details && typeof details === 'object' && ('eventId' in details || 'perceptionId' in details)) {
      if (typeof details.eventId === 'string' && details.eventId.trim()) {
        eventId = details.eventId.trim();
      } else if (typeof details.perceptionId === 'string' && details.perceptionId.trim()) {
        eventId = details.perceptionId.trim();
      }
    } else {
      if (typeof details?.watermarkId === 'string' && details.watermarkId.trim()) {
        eventId = details.watermarkId.trim();
      } else if (typeof gateResult.eventId === 'string' && gateResult.eventId.trim()) {
        eventId = gateResult.eventId.trim();
      } else if (typeof gateResult.perceptionId === 'string' && gateResult.perceptionId.trim()) {
        eventId = gateResult.perceptionId.trim();
      }
    }

    // v0.9.8.1 F-13: before snapshot 必须在任何 mutation（含两套 watermark 消费）之前完整保存，
    // 包括 consumedAttentionEvents 与 persistedConsumedAttentionEvents；
    // save 失败时必须完整恢复（严禁恢复成 undefined / 严禁回滚后事件仍被视为已消费）。
    const before = {
      arousal: this.arousal,
      cognitiveLoadProxy: this.cognitiveLoadProxy,
      salienceThreshold: this.salienceThreshold,
      updatedAt: this.updatedAt,
      history: this.history.slice(),
      consumedAttentionEvents: new Set(this.consumedAttentionEvents),
      persistedConsumedAttentionEvents: new Set(this.persistedConsumedAttentionEvents)
    };

    if (eventId) {
      if (this.persistedConsumedAttentionEvents.has(eventId)) {
        return this._emitChange(this.getState());
      }
      this.persistedConsumedAttentionEvents.add(eventId);
      this.consumedAttentionEvents.add(eventId);
      if (this.consumedAttentionEvents.size > this.maxConsumedAttentionEvents) {
        const first = this.consumedAttentionEvents.values().next().value;
        this.consumedAttentionEvents.delete(first);
      }
    }
    const at = Number(details.timestamp || Date.now());
    const salience = Number(gateResult.salience || 40);
    const prev = {
      energy: this.energy,
      restPressure: this.restPressure,
      arousal: this.arousal,
      interactionDensity: this.interactionDensity,
      cognitiveLoadProxy: this.cognitiveLoadProxy
    };

    const deltas = {};
    // 依据显著性温和微调唤醒度（+1 ~ +8）
    const arousalBump = Math.max(1, Math.min(8, Math.round(salience * 0.1)));
    deltas.arousal = arousalBump;
    deltas.cognitiveLoadProxy = +1;

    this.arousal = clamp(this.arousal + deltas.arousal, REGULATION_BOUNDS.arousal.min, REGULATION_BOUNDS.arousal.max);
    this.cognitiveLoadProxy = clamp(this.cognitiveLoadProxy + deltas.cognitiveLoadProxy, REGULATION_BOUNDS.cognitiveLoadProxy.min, REGULATION_BOUNDS.cognitiveLoadProxy.max);

    this.salienceThreshold = this._computeSalienceThreshold(this.arousal);
    this._recordTransition('attention_attended', deltas, prev, at);
    if (!this.save()) {
      this.arousal = before.arousal;
      this.cognitiveLoadProxy = before.cognitiveLoadProxy;
      this.salienceThreshold = before.salienceThreshold;
      this.updatedAt = before.updatedAt;
      this.history = before.history;
      this.consumedAttentionEvents = before.consumedAttentionEvents;
      this.persistedConsumedAttentionEvents = before.persistedConsumedAttentionEvents;
      return this._emitChange(this.getState());
    }
    return this._emitChange(this.getState());
  }

  /**
   * 事件驱动更新：入睡与唤醒 (Sleep / Wake Consolidation)
   * 
   * @param {boolean} isSleeping true 表示入睡，false 表示唤醒
   * @param {Object} [details={}]
   */
  updateOnSleep(isSleeping, details = {}) {
    if (!this.enabled) return this.getState();

    const boolSleep = Boolean(isSleeping);
    if (this.isSleeping === boolSleep) {
      return this._emitChange(this.getState()); // 幂等保护：状态已处于目标睡眠/清醒状态，防止同一入睡/唤醒事件重复计量
    }
    this.isSleeping = boolSleep;

    const at = Number(details.timestamp || Date.now());
    const prev = {
      energy: this.energy,
      restPressure: this.restPressure,
      arousal: this.arousal,
      interactionDensity: this.interactionDensity,
      cognitiveLoadProxy: this.cognitiveLoadProxy
    };

    const deltas = {};

    if (isSleeping) {
      // 入睡：恢复能量、大幅释放休息压力、唤醒度沉降
      deltas.energy = +35;
      deltas.restPressure = -60;
      // 睡眠期唤醒度处于低位
      const targetArousal = 25;
      deltas.arousal = targetArousal - this.arousal;
      this.interactionDensity = 0;
      this.cognitiveLoadProxy = 0;
    } else {
      // 唤醒：状态重置到清醒基线
      deltas.energy = +15;
      deltas.restPressure = -20;
      deltas.arousal = 50 - this.arousal;
      this.cognitiveLoadProxy = 0;
    }

    if (deltas.energy) this.energy = clamp(this.energy + deltas.energy, REGULATION_BOUNDS.energy.min, REGULATION_BOUNDS.energy.max);
    if (deltas.restPressure) this.restPressure = clamp(this.restPressure + deltas.restPressure, REGULATION_BOUNDS.restPressure.min, REGULATION_BOUNDS.restPressure.max);
    if (deltas.arousal) this.arousal = clamp(this.arousal + deltas.arousal, REGULATION_BOUNDS.arousal.min, REGULATION_BOUNDS.arousal.max);

    this.salienceThreshold = this._computeSalienceThreshold(this.arousal);
    this._recordTransition(isSleeping ? 'enter_sleep' : 'wake_up', deltas, prev, at);

    // v3.1 梦境时序改造：入睡时刻落盘（供物理时长门禁跨重启计算），
    // 唤醒时刻只清空原料、绝不重置起始时间 —— 与 tracker.enterSleepMode 的幂等守卫同源。
    if (isSleeping) {
      this.sleepStartTime = at;
    } else {
      this.sleepStartTime = null;
      this.sleepStaging = null;
    }

    this.save();
    return this._emitChange(this.getState());
  }

  /**
   * 事件驱动更新：窗口关闭与整合 (Window Close Event)
   * 
   * @param {number} windowNo
   * @param {Object} [details={}]
   */
  updateOnWindowClose(windowNo, details = {}) {
    if (!this.enabled) return this.getState();

    const at = Number(details.timestamp || Date.now());
    const prev = { ...this.getState() };

    // 关窗期认知负荷排空，短期交互密度半衰结算
    this.cognitiveLoadProxy = 0;
    this.interactionDensity = Math.floor(this.interactionDensity * 0.5);
    this.salienceThreshold = this._computeSalienceThreshold(this.arousal);

    this._recordTransition(`window_close_${windowNo}`, {}, prev, at);
    this.save();
    return this._emitChange(this.getState());
  }

  /**
   * 构造标准化归档快照记录 (Canonical Archive Record: internal_regulation_snapshot)
   * 
   * @param {number} windowNo
   * @param {Object} [extra={}]
   */
  createSnapshotRecord(windowNo, extra = {}) {
    const state = this.getState();
    const payload = {
      state,
      salienceThreshold: this.salienceThreshold,
      recentTransitionsCount: this.history.length,
      timestamp: Date.now(),
      ...extra
    };

    return wrapArchiveRecord('internal_regulation_snapshot', windowNo, payload, {
      timestamp: payload.timestamp
    });
  }

  /**
   * 从本地文件加载
   */
  load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        if (raw && typeof raw === 'object' && raw.values) {
          const v = raw.values;
          if (typeof v.energy === 'number') this.energy = clamp(v.energy, REGULATION_BOUNDS.energy.min, REGULATION_BOUNDS.energy.max);
          if (typeof v.restPressure === 'number') this.restPressure = clamp(v.restPressure, REGULATION_BOUNDS.restPressure.min, REGULATION_BOUNDS.restPressure.max);
          if (typeof v.arousal === 'number') this.arousal = clamp(v.arousal, REGULATION_BOUNDS.arousal.min, REGULATION_BOUNDS.arousal.max);
          if (typeof v.interactionDensity === 'number') this.interactionDensity = clamp(v.interactionDensity, REGULATION_BOUNDS.interactionDensity.min, REGULATION_BOUNDS.interactionDensity.max);
          if (typeof v.cognitiveLoadProxy === 'number') this.cognitiveLoadProxy = clamp(v.cognitiveLoadProxy, REGULATION_BOUNDS.cognitiveLoadProxy.min, REGULATION_BOUNDS.cognitiveLoadProxy.max);
          this.salienceThreshold = this._computeSalienceThreshold(this.arousal);
          if (typeof raw.isSleeping === 'boolean') this.isSleeping = raw.isSleeping;
          else if (raw.values && typeof raw.values.isSleeping === 'boolean') this.isSleeping = raw.values.isSleeping;
          // 睡眠周期上下文跨重启恢复：起始时刻与冻结原料一起回来，
          // 于是「退出前什么状态，回归后还是什么状态」在梦境门禁上也成立。
          if (typeof raw.sleepStartTime === 'number' && Number.isFinite(raw.sleepStartTime)) {
            this.sleepStartTime = raw.sleepStartTime;
          }
          if (raw.sleepStaging && typeof raw.sleepStaging === 'object') {
            const s = raw.sleepStaging;
            this.sleepStaging = {
              at: Number.isFinite(s.at) ? s.at : Date.now(),
              windowNo: Number.isFinite(s.windowNo) ? s.windowNo : 0,
              dayResidues: Array.isArray(s.dayResidues) ? s.dayResidues.slice(0, 6) : [],
              arousalTrajectory: (s.arousalTrajectory && typeof s.arousalTrajectory === 'object') ? s.arousalTrajectory : null,
              noveltyScore: Number.isFinite(s.noveltyScore) ? s.noveltyScore : 0,
              fromSleep: true
            };
          }
          // 清醒态却带着入睡时刻 = 状态自相矛盾（磁盘残留/外部改写），
          // 宁可丢掉这个陈旧时刻，也绝不让她一睁眼就显示"睡了 8 小时"。
          if (!this.isSleeping) {
            this.sleepStartTime = null;
            this.sleepStaging = null;
          } else if (!this.sleepStartTime) {
            // v3.1 自愈：睡着却没有任何入睡时刻（典型的跨版本残留 —— 旧版只写
            // isSleeping、不写 sleepStartTime）。这种态若不纠正，会永久卡死：
            // getSleepContext 因缺时刻恒返回 null → 惰性苏醒分支永远进不去 →
            // 唤醒永远不发生 → isSleeping 永远为 true，而 tracker 已在内存里醒着，
            // 于是「她显示深度休眠，却在桌面上漫步」且此状态永不自愈。
            // 判定为孤立僵尸态，直接纠正为清醒（此刻她确实醒着，否则早被用户叫醒了）。
            this.isSleeping = false;
            this.sleepStaging = null;
            this.persistenceHealthy = true;
            this.persistenceError = 'ORPHAN_SLEEP_STATE_SELF_HEALED';
            console.warn('[InternalRegulation]检测到孤立睡眠态（isSleeping=true 但无入睡时刻），已自动纠正为清醒');
          }
          this.updatedAt = raw.updatedAt || Date.now();
          if (Array.isArray(raw.history)) this.history = raw.history.slice(-50);
          if (Array.isArray(raw.persistedConsumedAttentionEvents)) {
            this.persistedConsumedAttentionEvents = new Set(
              raw.persistedConsumedAttentionEvents.filter(v => typeof v === 'string' && v.trim())
            );
          } else if (Array.isArray(raw.consumedAttentionEvents)) {
            // v0.9.8 migration: older bounded ledgers seed the new global ledger.
            this.persistedConsumedAttentionEvents = new Set(
              raw.consumedAttentionEvents.filter(v => typeof v === 'string' && v.trim())
            );
          }
          this.consumedAttentionEvents = new Set(
            Array.from(this.persistedConsumedAttentionEvents).slice(-this.maxConsumedAttentionEvents)
          );
          return true;
        }
        this.persistenceHealthy = false;
        this.persistenceError = 'INVALID_PERSISTED_STATE_SHAPE';
        return false;
      }
    } catch (e) {
      this.persistenceHealthy = false;
      this.persistenceError = e.message;
      console.warn('[InternalRegulation] 加载失败，进入 fail-closed:', e.message);
    }
    return false;
  }

  /**
   * 原子持久化写盘
   */
  save() {
    if (!this.dir) return false;
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      const data = {
        schemaVersion: SCHEMA_VERSION,
        semanticLayer: SEMANTIC_LAYERS.SUBJECT_STATE_PROXY,
        updatedAt: this.updatedAt,
        isSleeping: this.isSleeping,
        // 睡眠周期上下文：与 isSleeping 同盘原子落盘，重启后梦境时长门禁不失忆
        sleepStartTime: this.sleepStartTime,
        sleepStaging: this.sleepStaging,
        values: {
          energy: this.energy,
          restPressure: this.restPressure,
          arousal: this.arousal,
          salienceThreshold: this.salienceThreshold,
          interactionDensity: this.interactionDensity,
          cognitiveLoadProxy: this.cognitiveLoadProxy
        },
        persistedConsumedAttentionEvents: Array.from(this.persistedConsumedAttentionEvents),
        consumedAttentionEvents: Array.from(this.consumedAttentionEvents).slice(-this.maxConsumedAttentionEvents),
        history: this.history
      };
      writeJsonAtomic(this.path, data);
      return true;
    } catch (e) {
      console.error('[InternalRegulation] 写盘失败:', e.message);
      return false;
    }
  }

  /**
   * 离线归档重放能力 (Replay Invariant / Section XIV & Phase 0.5)
   * 依据 ExperiencesArchive 中的历史快照直接重建内部调节状态轨迹，绝不发起任何外部 LLM 请求。
   *
   * @param {Array<Object>} archiveRecords
   * @param {Object} [options={}]
   * @returns {Object}
   */
  static replay(archiveRecords = [], options = {}) {
    if (!Array.isArray(archiveRecords)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        totalSnapshots: 0,
        windowStates: [],
        finalState: null,
        replayStatus: 'invalid'
      };
    }

    const snapshots = archiveRecords.filter(r => {
      if (!r || typeof r !== 'object') return false;
      const type = r.recordType || r.type;
      return type === 'internal_regulation_snapshot' && r.payload && r.payload.state;
    });

    snapshots.sort((a, b) => {
      const wA = typeof a.windowNo === 'number' ? a.windowNo : (a.payload?.windowNo || 0);
      const wB = typeof b.windowNo === 'number' ? b.windowNo : (b.payload?.windowNo || 0);
      if (wA !== wB) return wA - wB;
      const tA = a.timestamp || a.payload?.timestamp || 0;
      const tB = b.timestamp || b.payload?.timestamp || 0;
      return tA - tB;
    });

    const windowStates = snapshots.map(s => {
      const state = s.payload.state;
      const windowNo = typeof s.windowNo === 'number' ? s.windowNo : (s.payload?.windowNo || 0);
      return {
        windowNo,
        timestamp: s.payload.timestamp || s.timestamp,
        state: Object.freeze({ ...state }),
        salienceThreshold: typeof s.payload.salienceThreshold === 'number' ? s.payload.salienceThreshold : state.salienceThreshold,
        recentTransitionsCount: s.payload.recentTransitionsCount || 0
      };
    });

    const finalState = windowStates.length > 0 ? windowStates[windowStates.length - 1].state : null;

    return {
      schemaVersion: SCHEMA_VERSION,
      totalSnapshots: windowStates.length,
      windowStates,
      finalState,
      replayStatus: windowStates.length > 0 ? 'complete' : 'empty'
    };
  }
}

module.exports = {
  InternalRegulationManager,
  REGULATION_BOUNDS,
  clamp,
  symmetricRound
};
