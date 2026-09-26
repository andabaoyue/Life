/**
 * 自然动画系统 V1 —— 自主行为调度器 (BehaviorScheduler)
 *
 * 架构定位：
 * ActivityTracker (事实记录)
 *         ↓
 * TriggerEngine (主动意图/言语触发闸门)
 *         ↓
 * BehaviorScheduler (在允许的情况下选择一个低成本自主微动作提案)
 *         ↓
 * AnimationController (执行具体视觉动作)
 *
 * 核心原则：
 * 1. 明确角色：BehaviorScheduler 是动画系统内部的自主动作调度器，负责从标准化行为池中选出动作提案；
 * 2. 严禁越级直接操纵 DOM 或篡改 AnimationController 的动力学参数；
 * 3. 统一与 ActivityTracker 的职责关系：支持注入 tracker 读取权威的 lastInteractionAt，避免各处各算一套；
 * 4. 消除硬编码阈值，提供正式的 Development / Production 配置配置化策略：
 *    - Development: idleThreshold = 15s, cooldown = 20~40s (适合快速测试)
 *    - Production: idleThreshold = 180s (3分钟), cooldown = 120~300s (适合正式日常伴随)
 * 5. 严格遵守“礼貌闸门 (Polite Gate)”：聊天中、输入中、气泡展开、位移中、高优先级动作中绝对不打扰。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const { ANIMATION_STATES, ANIMATION_PRIORITY } = require('./animation-state');
    const exports = factory(ANIMATION_STATES, ANIMATION_PRIORITY);
    module.exports = exports.BehaviorScheduler;
    module.exports.BehaviorScheduler = exports.BehaviorScheduler;
    module.exports.BEHAVIOR_DEFINITIONS = exports.BEHAVIOR_DEFINITIONS;
    module.exports.SCHEDULER_PROFILES = exports.SCHEDULER_PROFILES;
  } else {
    const exports = factory(
      root.AnimationState.ANIMATION_STATES,
      root.AnimationState.ANIMATION_PRIORITY
    );
    root.BehaviorScheduler = exports.BehaviorScheduler;
    root.BEHAVIOR_DEFINITIONS = exports.BEHAVIOR_DEFINITIONS;
    root.SCHEDULER_PROFILES = exports.SCHEDULER_PROFILES;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ANIMATION_STATES, ANIMATION_PRIORITY) {
  'use strict';

  /**
   * 标准化行为定义字典 (Behavior Definitions)
   */
  const BEHAVIOR_DEFINITIONS = Object.freeze({
    [ANIMATION_STATES.STRETCH]: {
      id: ANIMATION_STATES.STRETCH,
      name: ANIMATION_STATES.STRETCH,
      label: '伸懒腰',
      duration: 1600,
      weight: 1.0,
      priority: 'low',
      allowedStates: [ANIMATION_STATES.IDLE],
      completionTarget: ANIMATION_STATES.IDLE
    },
    [ANIMATION_STATES.LOOK_AROUND]: {
      id: ANIMATION_STATES.LOOK_AROUND,
      name: ANIMATION_STATES.LOOK_AROUND,
      label: '张望',
      duration: 2000,
      weight: 1.2,
      priority: 'low',
      allowedStates: [ANIMATION_STATES.IDLE],
      completionTarget: ANIMATION_STATES.IDLE
    },
    [ANIMATION_STATES.TIDY_HAIR]: {
      id: ANIMATION_STATES.TIDY_HAIR,
      name: ANIMATION_STATES.TIDY_HAIR,
      label: '整理头发',
      duration: 1400,
      weight: 1.0,
      priority: 'low',
      allowedStates: [ANIMATION_STATES.IDLE],
      completionTarget: ANIMATION_STATES.IDLE
    },
    [ANIMATION_STATES.YAWN]: {
      id: ANIMATION_STATES.YAWN,
      name: ANIMATION_STATES.YAWN,
      label: '打哈欠',
      duration: 2200,
      weight: 0.6,
      priority: 'low',
      allowedStates: [ANIMATION_STATES.IDLE],
      completionTarget: ANIMATION_STATES.IDLE
    }
  });

  /**
   * 运行环境配置 Profile 预设
   */
  const SCHEDULER_PROFILES = Object.freeze({
    development: {
      idleMinMs: 15000,         // 15 秒（适合研发、单测与快速验证）
      cooldownMinMs: 20000,     // 20 秒
      cooldownMaxMs: 40000,     // 40 秒
      checkIntervalMs: 2000
    },
    production: {
      idleMinMs: 180000,        // 3 分钟（正式日常静默阈值）
      cooldownMinMs: 120000,    // 2 分钟最小冷却
      cooldownMaxMs: 300000,    // 5 分钟最大冷却
      checkIntervalMs: 5000
    }
  });

  class BehaviorScheduler {
    constructor(opts = {}) {
      this.controller = opts.controller;
      this.now = opts.now || Date.now;

      // 接入已有的 ActivityTracker 引用（若有）
      this.tracker = opts.tracker || null;

      // 配置 Profile 处理（支持 development / production 模式）
      const profileName = opts.profile || (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production' ? 'production' : 'development');
      const profileDefaults = SCHEDULER_PROFILES[profileName] || SCHEDULER_PROFILES.development;

      this.profile = profileName;
      this.idleMinMs = Number.isFinite(opts.idleMinMs) ? opts.idleMinMs : profileDefaults.idleMinMs;
      this.cooldownMinMs = Number.isFinite(opts.cooldownMinMs) ? opts.cooldownMinMs : profileDefaults.cooldownMinMs;
      this.cooldownMaxMs = Number.isFinite(opts.cooldownMaxMs) ? opts.cooldownMaxMs : profileDefaults.cooldownMaxMs;
      this.checkIntervalMs = Number.isFinite(opts.checkIntervalMs) ? opts.checkIntervalMs : profileDefaults.checkIntervalMs;

      // 礼貌检查回调（气泡未显、用户未在输入、未处于流式传输中、未在拖拽中）
      this.politeCheck = opts.politeCheck || (() => true);

      // 行为池加载（支持自定义注入行为定义列表）
      this.behaviorPool = Array.isArray(opts.behaviorPool)
        ? opts.behaviorPool
        : Object.values(BEHAVIOR_DEFINITIONS);

      // 可控随机数生成器与自定义行为选择器注入（消除测试随机性与 flakiness）
      this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
      this.pickBehavior = typeof opts.pickBehavior === 'function' ? opts.pickBehavior : null;

      // 状态记录
      this.lastActivityAt = this.now();
      this.lastActionAt = 0;
      this.nextAllowedAt = this.now() + this.idleMinMs;

      this._timer = null;
      this._destroyed = false;
      this.enabled = opts.enabled !== false;
    }

    /**
     * 获取最新用户活动时刻（优先从绑定的 ActivityTracker 获取权威记录，否则回退本地记录）
     */
    getLastActivityAt() {
      if (this.tracker && typeof this.tracker.lastInteractionAt === 'number') {
        return Math.max(this.lastActivityAt, this.tracker.lastInteractionAt);
      }
      return this.lastActivityAt;
    }

    /**
     * 记录用户交互（键盘输入、点击、拖动等）
     */
    noteActivity(at = this.now()) {
      this.lastActivityAt = at;
      // 重置下次允许触发时刻
      this.nextAllowedAt = Math.max(this.nextAllowedAt, at + this.idleMinMs);
    }

    /**
     * 加权抽取下一个自主微动作定义
     */
    _pickBehavior() {
      if (typeof this.pickBehavior === 'function') {
        const custom = this.pickBehavior(this.behaviorPool);
        if (custom) return custom;
      }
      const totalWeight = this.behaviorPool.reduce((sum, a) => sum + (a.weight || 1), 0);
      let r = this.rng() * totalWeight;
      for (const item of this.behaviorPool) {
        const w = item.weight || 1;
        if (r <= w) return item;
        r -= w;
      }
      return this.behaviorPool[0];
    }

    /**
     * 周期性评估与调度触发
     */
    evaluate(at = this.now()) {
      if (!this.enabled || this._destroyed || !this.controller) return null;

      // 1. 只有当前处于 IDLE 状态才允许插入自主微动作
      if (this.controller.state !== ANIMATION_STATES.IDLE) {
        return null;
      }

      // 2. 检查空闲静默时间与冷却门槛
      const lastActive = this.getLastActivityAt();
      if (at < this.nextAllowedAt || (at - lastActive) < this.idleMinMs) {
        return null;
      }

      // 3. 礼貌检查（气泡显示中、输入中、拖动中则不打扰）
      if (!this.politeCheck()) {
        return null;
      }

      // 4. 从行为池抽取微动作并提交 Controller 执行
      const chosen = this._pickBehavior();
      const success = this.controller.playAction(chosen.id, {
        duration: chosen.duration,
        reason: `scheduler_${chosen.id}`
      });

      if (success) {
        this.lastActionAt = at;
        // 规划下次冷却
        const jitter = this.rng() * Math.max(0, this.cooldownMaxMs - this.cooldownMinMs);
        this.nextAllowedAt = at + this.cooldownMinMs + jitter;
        return chosen;
      }

      return null;
    }

    /**
     * 启动检查循环
     */
    start() {
      if (this._timer || this._destroyed) return;
      this._timer = setInterval(() => {
        this.evaluate(this.now());
      }, this.checkIntervalMs);
      if (this._timer && this._timer.unref) this._timer.unref();
    }

    /**
     * 暂停检查循环
     */
    stop() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    /**
     * 销毁调度器
     */
    destroy() {
      this._destroyed = true;
      this.stop();
    }
  }

  return {
    BehaviorScheduler,
    BEHAVIOR_DEFINITIONS,
    SCHEDULER_PROFILES
  };
});
