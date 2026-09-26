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
    this.updatedAt = Date.now();
    this.history = []; // 最近转移事件流水 (上限 50 条)

    this.load();
  }

  /**
   * 依据神经唤醒度反向计算感官显著性门限：
   * 唤醒度越高（警觉/紧张） -> 显著性门限越低（更易被环境刺激惊动/注意）
   * 唤醒度越低（从容/镇定） -> 显著性门限越高（滤掉细碎背景噪声）
   */
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
      updatedAt: this.updatedAt
    });
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
    return this.getState();
  }

  /**
   * 事件驱动更新：物理或系统活动 (Activity Tracker: poke / drag / idle)
   * 
   * @param {string} activityKind 'poke' | 'drag' | 'idle'
   * @param {Object} [details={}]
   */
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
        const arousalDrop = Math.min(20, Math.floor(idleMin / 5));
        deltas.arousal = -arousalDrop;
        deltas.interactionDensity = -10;
        deltas.cognitiveLoadProxy = -15;
        // 清醒挂机时间长，逐渐积累睡意/休息需求
        deltas.restPressure = Math.min(10, Math.floor(idleMin / 10));
      }
    }

    if (deltas.energy) this.energy = clamp(this.energy + deltas.energy, REGULATION_BOUNDS.energy.min, REGULATION_BOUNDS.energy.max);
    if (deltas.restPressure) this.restPressure = clamp(this.restPressure + deltas.restPressure, REGULATION_BOUNDS.restPressure.min, REGULATION_BOUNDS.restPressure.max);
    if (deltas.arousal) this.arousal = clamp(this.arousal + deltas.arousal, REGULATION_BOUNDS.arousal.min, REGULATION_BOUNDS.arousal.max);
    if (deltas.interactionDensity) this.interactionDensity = clamp(this.interactionDensity + deltas.interactionDensity, REGULATION_BOUNDS.interactionDensity.min, REGULATION_BOUNDS.interactionDensity.max);
    if (deltas.cognitiveLoadProxy) this.cognitiveLoadProxy = clamp(this.cognitiveLoadProxy + deltas.cognitiveLoadProxy, REGULATION_BOUNDS.cognitiveLoadProxy.min, REGULATION_BOUNDS.cognitiveLoadProxy.max);

    this.salienceThreshold = this._computeSalienceThreshold(this.arousal);
    this._recordTransition(`activity_${activityKind}`, deltas, prev, at);
    return this.getState();
  }

  /**
   * 事件驱动更新：入睡与唤醒 (Sleep / Wake Consolidation)
   * 
   * @param {boolean} isSleeping true 表示入睡，false 表示唤醒
   * @param {Object} [details={}]
   */
  updateOnSleep(isSleeping, details = {}) {
    if (!this.enabled) return this.getState();

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
    this.save();
    return this.getState();
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
    return this.getState();
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
          this.updatedAt = raw.updatedAt || Date.now();
          if (Array.isArray(raw.history)) this.history = raw.history.slice(-50);
          return true;
        }
      }
    } catch (e) {
      console.warn('[InternalRegulation] 加载失败，回退默认值:', e.message);
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
        values: {
          energy: this.energy,
          restPressure: this.restPressure,
          arousal: this.arousal,
          salienceThreshold: this.salienceThreshold,
          interactionDensity: this.interactionDensity,
          cognitiveLoadProxy: this.cognitiveLoadProxy
        },
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
