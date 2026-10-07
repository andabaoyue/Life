/**
 * 自然动画系统 V1 —— 动画状态、优先级与仲裁规则
 *
 * 架构目标：
 * 1. 严格解耦“状态机逻辑”与“渲染表现”，为未来通用数字生命框架奠定基础；
 * 2. 建立正式的 Animation Priority / Interrupt Policy，避免未来动作增多时产生 Transform 争夺；
 * 3. 明确当前 V1 完成边界：当前 WALK 属于 Procedural Pose Dynamics（步态动力学参数生成），
 *    TURN 为未来扩展接口与朝向标记，非完整骨骼/差分步态动画。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AnimationState = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 核心动画状态
   */
  const ANIMATION_STATES = Object.freeze({
    IDLE: 'idle',           // 原地呼吸、微动、随机眨眼、发丝微摆
    WALK: 'walk',           // 行走步态动力学（速度/方向驱动参数）
    STOP: 'stop',           // 停止减速缓冲（约 150ms Motion Settle 缓冲）
    TURN: 'turn',           // 朝向/转身过渡接口（V1 状态与接口占位）
    POKE: 'poke',           // 局部姿态反馈（后仰、重心微变、受惊眼、平滑恢复）
    SLEEP: 'sleep',         // 睡眠（闭眼、极缓呼吸、禁用眨眼）
    WAKE: 'wake',           // 唤醒（睁眼过渡、苏醒动作）

    // 低成本自主微动作（由 BehaviorScheduler 调度）
    STRETCH: 'stretch',     // 伸懒腰 / 舒展
    LOOK_AROUND: 'look_around', // 张望
    TIDY_HAIR: 'tidy_hair', // 整理头发
    YAWN: 'yawn',           // 打哈欠
    THINK: 'think'          // 思考姿态
  });

  /**
   * 眼睛表达状态（独立表达层）
   */
  const EYE_STATES = Object.freeze({
    OPEN: 'eye_open',       // 睁眼（正常）
    HALF: 'eye_half',       // 半睁（眨眼中途 / 困倦）
    CLOSE: 'eye_close',     // 闭眼（完全闭合 / 睡眠）
    WIDE: 'eye_wide'        // 瞪大/惊讶（被戳 / 受到刺激）
  });

  /**
   * 动画优先级等级定义
   */
  const PRIORITY_LEVELS = Object.freeze({
    HIGH: 30,    // 高优先级：用户交互直接反馈（POKE）、重要生命周期（WAKE/SLEEP）
    MEDIUM: 20,  // 中优先级：位移与物理惯性（WALK、STOP、TURN）
    LOW: 10,     // 低优先级：自主微动（STRETCH、LOOK_AROUND、TIDY_HAIR、YAWN、THINK）
    BASE: 0      // 基础层：IDLE 常态站立
  });

  /**
   * 状态优先级映射
   */
  const ANIMATION_PRIORITY = Object.freeze({
    [ANIMATION_STATES.POKE]: PRIORITY_LEVELS.HIGH,
    [ANIMATION_STATES.WAKE]: PRIORITY_LEVELS.HIGH,
    [ANIMATION_STATES.SLEEP]: PRIORITY_LEVELS.HIGH,

    [ANIMATION_STATES.TURN]: PRIORITY_LEVELS.MEDIUM,
    [ANIMATION_STATES.STOP]: PRIORITY_LEVELS.MEDIUM,
    [ANIMATION_STATES.WALK]: PRIORITY_LEVELS.MEDIUM,

    [ANIMATION_STATES.STRETCH]: PRIORITY_LEVELS.LOW,
    [ANIMATION_STATES.LOOK_AROUND]: PRIORITY_LEVELS.LOW,
    [ANIMATION_STATES.TIDY_HAIR]: PRIORITY_LEVELS.LOW,
    [ANIMATION_STATES.YAWN]: PRIORITY_LEVELS.LOW,
    [ANIMATION_STATES.THINK]: PRIORITY_LEVELS.LOW,

    [ANIMATION_STATES.IDLE]: PRIORITY_LEVELS.BASE
  });

  /**
   * 合法状态转移表
   */
  const VALID_TRANSITIONS = Object.freeze({
    [ANIMATION_STATES.IDLE]: [
      ANIMATION_STATES.WALK,
      ANIMATION_STATES.POKE,
      ANIMATION_STATES.SLEEP,
      ANIMATION_STATES.STRETCH,
      ANIMATION_STATES.LOOK_AROUND,
      ANIMATION_STATES.TIDY_HAIR,
      ANIMATION_STATES.YAWN,
      ANIMATION_STATES.THINK,
      ANIMATION_STATES.TURN
    ],
    [ANIMATION_STATES.WALK]: [
      ANIMATION_STATES.STOP,
      ANIMATION_STATES.POKE,
      ANIMATION_STATES.TURN,
      ANIMATION_STATES.IDLE
    ],
    [ANIMATION_STATES.STOP]: [
      ANIMATION_STATES.IDLE,
      ANIMATION_STATES.WALK,
      ANIMATION_STATES.POKE
    ],
    [ANIMATION_STATES.TURN]: [
      ANIMATION_STATES.IDLE,
      ANIMATION_STATES.WALK,
      ANIMATION_STATES.POKE
    ],
    [ANIMATION_STATES.POKE]: [
      ANIMATION_STATES.IDLE,
      ANIMATION_STATES.WALK,
      ANIMATION_STATES.POKE // 支持在被戳时再次连戳
    ],
    [ANIMATION_STATES.SLEEP]: [
      ANIMATION_STATES.WAKE,
      ANIMATION_STATES.POKE // 睡梦中被戳会唤醒
    ],
    [ANIMATION_STATES.WAKE]: [
      ANIMATION_STATES.IDLE,
      ANIMATION_STATES.POKE
    ],
    [ANIMATION_STATES.STRETCH]: [ANIMATION_STATES.IDLE, ANIMATION_STATES.POKE],
    [ANIMATION_STATES.LOOK_AROUND]: [ANIMATION_STATES.IDLE, ANIMATION_STATES.POKE],
    [ANIMATION_STATES.TIDY_HAIR]: [ANIMATION_STATES.IDLE, ANIMATION_STATES.POKE],
    [ANIMATION_STATES.YAWN]: [ANIMATION_STATES.IDLE, ANIMATION_STATES.POKE],
    [ANIMATION_STATES.THINK]: [ANIMATION_STATES.IDLE, ANIMATION_STATES.POKE]
  });

  /**
   * 判断状态转换是否合法
   */
  function canTransition(fromState, toState) {
    if (fromState === toState) return true;
    const allowed = VALID_TRANSITIONS[fromState];
    return Array.isArray(allowed) && allowed.includes(toState);
  }

  /**
   * 判断新状态是否允许打断当前状态（Priority & Arbitration 仲裁判定）
   *
   * 规则：
   * 1. 高优先级必然可以打断低优先级状态（如 POKE 打断 STRETCH 或 WALK）；
   * 2. 低优先级绝对不可打断高优先级状态（如 STRETCH 不可打断 POKE 或 WALK）；
   * 3. 同级状态间转移必须符合 VALID_TRANSITIONS（如 WALK -> STOP）；
   * 4. 连戳（POKE -> POKE）允许同级打断并重置反应周期。
   */
  function canInterrupt(incomingState, currentState) {
    const incomingPriority = ANIMATION_PRIORITY[incomingState] ?? 0;
    const currentPriority = ANIMATION_PRIORITY[currentState] ?? 0;

    // 高优先级可以打断低优先级
    if (incomingPriority > currentPriority) {
      return true;
    }

    // 低优先级不可打断高优先级
    if (incomingPriority < currentPriority) {
      return false;
    }

    // 同级特殊规则：连戳允许自我重置
    if (incomingState === ANIMATION_STATES.POKE && currentState === ANIMATION_STATES.POKE) {
      return true;
    }

    // 其余同级转移看状态转移图
    return canTransition(currentState, incomingState);
  }

  return {
    ANIMATION_STATES,
    EYE_STATES,
    PRIORITY_LEVELS,
    ANIMATION_PRIORITY,
    VALID_TRANSITIONS,
    canTransition,
    canInterrupt
  };
});
