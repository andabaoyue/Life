/**
 * 自然动画系统 V1 —— 动画核心控制器 (AnimationController)
 *
 * 架构目标：
 * 1. 负责“初澜本人怎么动”的唯一权威仲裁者与动力学计算核心；
 * 2. 状态机与仲裁机制（Animation Priority & Arbitration）：
 *    - HIGH: POKE, WAKE, SLEEP (高优先级交互与核心生命周期)
 *    - MEDIUM: WALK, STOP, TURN (位移与物理缓冲)
 *    - LOW: STRETCH, LOOK_AROUND, TIDY_HAIR, YAWN, THINK (自主微动作)
 *    - BASE: IDLE (常态微动)
 *    - 仲裁规则：高优先级必然打断低优先级，低优先级不可越级篡夺 Transform；
 *    - 动态恢复（Resume Policy）：被戳等中断动作结束后，根据窗口移动状态自适应恢复至 WALK 或 IDLE。
 * 3. 动力学参数生成（Procedural Pose Dynamics & Weight-shift Simulation）：
 *    - 呼吸起伏 (Breathing, 3.2s 正弦周期)
 *    - 眨眼系统 (Blinking, eye_open -> half -> close -> open, 3~6s 随机抖动)
 *    - 发饰与衣物自然微摆 (Hair / Clothes Sway, 独立锚点、差分相位)
 *    - 局部戳击姿态反馈 (Poke Pose Reaction, 身体后仰 -3.2°，重心下沉后移，受惊眼神，300ms 驻留与平滑恢复)
 *    - 行走动力学参数 (Walk Dynamics, 垂直起伏、步伐节拍、速度调制与 Stop 减速缓冲)
 * 4. 彻底解耦与 FrameData 纯度保证：每帧仅输出纯数据对象（无 DOM、无 HTMLElement、无函数）；
 * 5. 调试能力：提供 getDebugSnapshot() 供开发调试与排障；
 * 6. 资源自净：提供 start/stop/destroy，严禁在关闭或销毁后残留 timer 或 animation loop。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const { ANIMATION_STATES, EYE_STATES, ANIMATION_PRIORITY, canTransition, canInterrupt } = require('./animation-state');
    const { NullAnimationRenderer } = require('./render-adapter');
    module.exports = factory(ANIMATION_STATES, EYE_STATES, ANIMATION_PRIORITY, canTransition, canInterrupt, NullAnimationRenderer);
  } else {
    root.AnimationController = factory(
      root.AnimationState.ANIMATION_STATES,
      root.AnimationState.EYE_STATES,
      root.AnimationState.ANIMATION_PRIORITY,
      root.AnimationState.canTransition,
      root.AnimationState.canInterrupt,
      root.NullAnimationRenderer
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  ANIMATION_STATES,
  EYE_STATES,
  ANIMATION_PRIORITY,
  canTransition,
  canInterrupt,
  NullAnimationRenderer
) {
  'use strict';

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function easeOutCubic(t) {
    const f = t - 1;
    return f * f * f + 1;
  }

  function easeInOutSine(t) {
    return -(Math.cos(Math.PI * t) - 1) / 2;
  }

  class AnimationController {
    constructor(opts = {}) {
      this.now = opts.now || (typeof performance !== 'undefined' && performance.now
        ? () => performance.now()
        : Date.now);

      // 渲染适配器（若未提供则降级为无头渲染器）
      this.renderer = opts.renderer || new NullAnimationRenderer();

      // 时间常数配置
      this.breatheCycleMs = opts.breatheCycleMs || 3200;
      this.blinkMinMs = opts.blinkMinMs || 3000;
      this.blinkMaxMs = opts.blinkMaxMs || 6000;
      this.blinkDurationMs = opts.blinkDurationMs || 140;
      this.pokeDurationMs = opts.pokeDurationMs || 600;
      this.stopDurationMs = opts.stopDurationMs || 150;
      this.turnDurationMs = opts.turnDurationMs || 180;

      // 调试开关
      this.debug = !!opts.debug;

      // 回调钩子
      this.onStateChange = opts.onStateChange || (() => {});
      this.onEvent = opts.onEvent || (() => {});

      // 状态机核心属性
      this.state = ANIMATION_STATES.IDLE;
      this.previousState = ANIMATION_STATES.IDLE;
      this.stateStartTime = this.now();
      this.stateDurationMs = 0; // 0 表示无限循环（如 IDLE/WALK），非 0 表示单次动作
      this.stateFallback = ANIMATION_STATES.IDLE;
      this.lastTransitionReason = 'initial';

      // 行走动力学 / 窗口位移状态（由 desktop-motion 解耦驱动）
      this.motion = {
        isMoving: false,
        speed: 2,
        direction: 1, // 1: 右, -1: 左
        walkPhase: 0,
        gait: 'center' // 'left' | 'center' | 'right'
      };

      // 眨眼状态机
      this.eyeState = EYE_STATES.OPEN;
      this.blinkProgress = 0; // 0.0 ~ 1.0
      this.isBlinking = false;
      this.blinkStartTime = 0;
      this.nextBlinkTime = this.now() + this._randomBlinkInterval();

      // 外部对话情绪状态（happy, sleepy, curious, annoyed 等）
      this.dialogueState = 'idle';

      // 循环调度句柄
      this._rafId = null;
      this._timerId = null;
      this._running = false;
      this._destroyed = false;
      this._lastTickTime = this.now();

      // 计时器注入支持（便于单测与模拟时钟，使用箭头函数绑定接收者避免 Illegal invocation）
      this._raf = opts.raf || (typeof requestAnimationFrame !== 'undefined' ? (cb) => requestAnimationFrame(cb) : null);
      this._caf = opts.caf || (typeof cancelAnimationFrame !== 'undefined' ? (id) => cancelAnimationFrame(id) : null);
    }

    /* ---------------- 状态机与仲裁系统 (Priority & Arbitration) ---------------- */

    /**
     * 获取当前状态的优先级数值
     */
    getCurrentPriority() {
      return ANIMATION_PRIORITY[this.state] ?? 0;
    }

    /**
     * 请求状态转换（带优先级仲裁与中断检查）
     *
     * @param {string} nextState 目标状态
     * @param {Object} [opts]
     * @param {number} [opts.duration] 状态持续时间（毫秒），完成后自动切回 fallbackState
     * @param {string} [opts.fallbackState] 单次动作完成后的目标状态
     * @param {boolean} [opts.force] 是否强制转换（跳过仲裁校验）
     * @param {string} [opts.reason] 转换原因说明
     * @returns {boolean} 是否转换成功
     */
    transitionTo(nextState, opts = {}) {
      if (this._destroyed) return false;
      // 同态保护（除 POKE 允许连戳重置外）
      if (this.state === nextState && nextState !== ANIMATION_STATES.POKE && !opts.force) {
        return false;
      }

      const incomingPriority = ANIMATION_PRIORITY[nextState] ?? 0;
      const currentPriority = this.getCurrentPriority();

      // 仲裁规则 1：低优先级绝不可打断高优先级动作
      if (!opts.force && incomingPriority < currentPriority) {
        if (this.debug && typeof console !== 'undefined' && console.log) {
          console.log(`[AnimDebug] Rejected transition to ${nextState} (priority ${incomingPriority}) from ${this.state} (priority ${currentPriority})`);
        }
        return false;
      }

      // 仲裁规则 2：必须符合状态中断规则或转移表
      if (!opts.force && !canInterrupt(nextState, this.state)) {
        return false;
      }

      const prev = this.state;
      this.previousState = prev;
      this.state = nextState;
      const at = this.now();
      this.stateStartTime = at;
      this.stateDurationMs = opts.duration || 0;
      this.lastTransitionReason = opts.reason || 'unspecified';

      // 动态自适应恢复目标 (Resume Policy)：
      // 若未显式指定 fallbackState，则根据当前物理位移状态自适应切回 WALK 或 IDLE
      this.stateFallback = opts.fallbackState || (this.motion.isMoving ? ANIMATION_STATES.WALK : ANIMATION_STATES.IDLE);

      // 针对特定状态的特殊表达层初始化
      if (nextState === ANIMATION_STATES.SLEEP) {
        this.eyeState = EYE_STATES.CLOSE;
        this.isBlinking = false;
      } else if (nextState === ANIMATION_STATES.POKE) {
        this.eyeState = EYE_STATES.WIDE;
        this.isBlinking = false;
      } else if (nextState === ANIMATION_STATES.WAKE) {
        this.eyeState = EYE_STATES.HALF;
      } else if (nextState === ANIMATION_STATES.IDLE || nextState === ANIMATION_STATES.WALK) {
        this.eyeState = EYE_STATES.OPEN;
        this.isBlinking = false;
        this.nextBlinkTime = at + this._randomBlinkInterval();
      }

      if (this.debug && typeof console !== 'undefined' && console.log) {
        console.log(`[AnimDebug] Transition: ${prev} -> ${nextState} (priority: ${incomingPriority}, reason: ${this.lastTransitionReason})`);
      }

      this.onStateChange(nextState, prev, opts.reason);
      this.onEvent('state_changed', { from: prev, to: nextState, priority: incomingPriority, reason: this.lastTransitionReason });
      return true;
    }

    /**
     * 触发局部戳击姿态反馈（POKE，HIGH PRIORITY）
     * 具有高优先级抢占权，能打断 IDLE / WALK / 自主微动作
     */
    poke() {
      if (this._destroyed) return;
      const targetFallback = this.motion.isMoving ? ANIMATION_STATES.WALK : ANIMATION_STATES.IDLE;
      this.transitionTo(ANIMATION_STATES.POKE, {
        duration: this.pokeDurationMs,
        fallbackState: targetFallback,
        reason: 'user_poke'
      });
      this.onEvent('poke_started', { at: this.now() });
    }

    /**
     * 接收 desktop-motion 传入的位移速度与方向
     * 支持 setMotion(speed, direction) 与 setMotion({ isMoving, speed, direction, motionState })
     */
    setMotion(arg1, arg2) {
      if (this._destroyed) return;

      let isMoving = false;
      let speed = this.motion.speed;
      let direction = this.motion.direction;

      if (typeof arg1 === 'object' && arg1 !== null) {
        isMoving = !!arg1.isMoving;
        if (Number.isFinite(arg1.speed)) speed = Math.max(0, arg1.speed);
        if (arg1.direction === 1 || arg1.direction === -1) direction = arg1.direction;
      } else {
        // 支持重载：setMotion(speed, direction)
        speed = Number.isFinite(arg1) ? Math.max(0, arg1) : 0;
        isMoving = speed > 0;
        if (arg2 === 1 || arg2 === -1) direction = arg2;
      }

      const wasMoving = this.motion.isMoving;
      this.motion.isMoving = isMoving;
      this.motion.speed = speed;
      this.motion.direction = direction;

      // 如果当前正处于高优先级状态（POKE / SLEEP），保留运动向量并在 fallback 中等待恢复
      if (this.state === ANIMATION_STATES.POKE || this.state === ANIMATION_STATES.SLEEP) {
        this.stateFallback = isMoving ? ANIMATION_STATES.WALK : ANIMATION_STATES.IDLE;
        return;
      }

      if (isMoving && !wasMoving) {
        // 窗口起步位移 -> 进入步态动力学
        this.transitionTo(ANIMATION_STATES.WALK, { reason: 'motion_start' });
      } else if (!isMoving && wasMoving && this.state === ANIMATION_STATES.WALK) {
        // 窗口位移停止 -> 进入 150ms 减速缓冲 (Motion Settle Buffer)，再恢复 IDLE
        this.transitionTo(ANIMATION_STATES.STOP, {
          duration: this.stopDurationMs,
          fallbackState: ANIMATION_STATES.IDLE,
          reason: 'motion_stop'
        });
      }
    }

    /**
     * 转身翻转接口（Turn Transition 预留接口）
     * 为下一阶段提供接口契约
     */
    turn(direction) {
      if (this._destroyed) return false;
      if (direction !== 1 && direction !== -1) return false;
      if (direction === this.motion.direction) return true;

      this.motion.direction = direction;
      return this.transitionTo(ANIMATION_STATES.TURN, {
        duration: this.turnDurationMs,
        fallbackState: this.motion.isMoving ? ANIMATION_STATES.WALK : ANIMATION_STATES.IDLE,
        reason: 'turn_direction'
      });
    }

    /**
     * 调度自主微动作（由 BehaviorScheduler 调用，LOW PRIORITY）
     */
    playAction(actionName, opts = {}) {
      if (this._destroyed) return false;
      if (this.state !== ANIMATION_STATES.IDLE) return false;

      const duration = opts.duration || 1600;
      return this.transitionTo(actionName, {
        duration,
        fallbackState: ANIMATION_STATES.IDLE,
        reason: opts.reason || 'autonomous_behavior'
      });
    }

    /**
     * 关联主聊天情绪状态
     */
    setDialogueState(state) {
      this.dialogueState = state || 'idle';
      if (state === 'sleepy' && this.state === ANIMATION_STATES.IDLE) {
        // 困倦状态下放慢眨眼
        this.blinkMinMs = 4500;
        this.blinkMaxMs = 8000;
      } else {
        this.blinkMinMs = 3000;
        this.blinkMaxMs = 6000;
      }
    }

    /**
     * 设置调试模式
     */
    setDebug(enabled) {
      this.debug = !!enabled;
    }

    /**
     * 获取调试快照数据（供排障与日志输出）
     */
    getDebugSnapshot() {
      const now = this.now();
      return {
        currentState: this.state,
        previousState: this.previousState,
        stateElapsed: now - this.stateStartTime,
        stateDurationMs: this.stateDurationMs,
        animationPriority: this.getCurrentPriority(),
        lastTransitionReason: this.lastTransitionReason,
        motion: {
          isMoving: this.motion.isMoving,
          speed: this.motion.speed,
          direction: this.motion.direction,
          walkPhase: this.motion.walkPhase,
          gait: this.motion.gait
        },
        eyes: {
          state: this.eyeState,
          openness: this.eyeState === EYE_STATES.CLOSE ? 0 : (this.eyeState === EYE_STATES.HALF ? 0.45 : (this.eyeState === EYE_STATES.WIDE ? 1.15 : 1.0)),
          isBlinking: this.isBlinking
        },
        dialogueState: this.dialogueState,
        running: this._running,
        destroyed: this._destroyed
      };
    }

    /* ---------------- 动力学与每帧计算 ---------------- */

    _randomBlinkInterval() {
      return this.blinkMinMs + Math.random() * (this.blinkMaxMs - this.blinkMinMs);
    }

    /**
     * 更新眨眼生命周期
     */
    _updateBlink(now) {
      if (this.state === ANIMATION_STATES.SLEEP) {
        this.eyeState = EYE_STATES.CLOSE;
        this.isBlinking = false;
        return;
      }

      if (this.state === ANIMATION_STATES.POKE) {
        this.eyeState = EYE_STATES.WIDE;
        this.isBlinking = false;
        return;
      }

      if (!this.isBlinking) {
        if (now >= this.nextBlinkTime) {
          this.isBlinking = true;
          this.blinkStartTime = now;
        }
      }

      if (this.isBlinking) {
        const elapsed = now - this.blinkStartTime;
        const progress = clamp(elapsed / this.blinkDurationMs, 0, 1);
        this.blinkProgress = progress;

        // 眨眼阶段：0.0~0.25 (开->半) -> 0.25~0.6 (半->闭) -> 0.6~0.85 (闭->半) -> 0.85~1.0 (开)
        if (progress < 0.25) {
          this.eyeState = EYE_STATES.HALF;
        } else if (progress < 0.6) {
          this.eyeState = EYE_STATES.CLOSE;
        } else if (progress < 0.85) {
          this.eyeState = EYE_STATES.HALF;
        } else {
          this.eyeState = EYE_STATES.OPEN;
        }

        if (progress >= 1) {
          this.isBlinking = false;
          this.eyeState = EYE_STATES.OPEN;
          this.nextBlinkTime = now + this._randomBlinkInterval();
          this.onEvent('blink_completed', { at: now });
        }
      }
    }

    /**
     * 核心动力学计算：生成当前时刻的纯数据 FrameData
     */
    computeFrame(now) {
      const stateElapsed = now - this.stateStartTime;
      const deltaMs = Math.max(1, now - this._lastTickTime);
      this._lastTickTime = now;

      // 1. 检查单次动作是否播放完成
      let progress = 0;
      if (this.stateDurationMs > 0) {
        progress = clamp(stateElapsed / this.stateDurationMs, 0, 1);
        if (stateElapsed >= this.stateDurationMs) {
          const finishedState = this.state;
          const targetFallback = this.stateFallback || ANIMATION_STATES.IDLE;
          this.state = targetFallback;
          this.previousState = finishedState;
          this.stateStartTime = now;
          this.stateDurationMs = 0;
          progress = 1.0;

          if (targetFallback === ANIMATION_STATES.IDLE || targetFallback === ANIMATION_STATES.WALK) {
            this.eyeState = EYE_STATES.OPEN;
            this.isBlinking = false;
            this.nextBlinkTime = now + this._randomBlinkInterval();
          }

          this.onEvent('action_completed', { action: finishedState });
          this.onStateChange(targetFallback, finishedState, 'action_finished');
        }
      }

      // 2. 更新眨眼
      this._updateBlink(now);

      // 3. 基础呼吸起伏动力学（低频平滑正弦，周期 ~3.2s）
      let cycleMs = this.breatheCycleMs;
      if (this.state === ANIMATION_STATES.SLEEP) cycleMs = 4600;
      else if (this.dialogueState === 'thinking') cycleMs = 1800;

      const breathePhase = ((now % cycleMs) / cycleMs) * Math.PI * 2;
      const breatheSin = Math.sin(breathePhase);
      const breatheNorm = breatheSin * 0.5 + 0.5; // 0.0 ~ 1.0

      // 身体呼吸参数：scaleY 1.0 -> 1.011，微幅高度浮动 0 -> -2.0px
      let bodyScaleY = 1.0 + 0.011 * breatheNorm;
      let bodyScaleX = 1.0 - 0.003 * breatheNorm;
      let bodyTranslateY = -2.0 * breatheNorm;
      let bodyTranslateX = 0;
      let bodyRotate = 0;

      // 4. 头发与服装独立摆动（消除同频机械感：不同周期 + 错位相位）
      // 头发周期略长于呼吸（1.2x，3840ms）
      const hairCycle = cycleMs * 1.2;
      const hairPhase = ((now % hairCycle) / hairCycle) * Math.PI * 2 + 0.2;
      let hairRotate = 0.65 * Math.sin(hairPhase);

      // 服装周期（1.1x，3520ms，相位偏移 0.5rad）
      const clothesCycle = cycleMs * 1.1;
      const clothesPhase = ((now % clothesCycle) / clothesCycle) * Math.PI * 2 + 0.5;
      let clothesRotate = 0.45 * Math.sin(clothesPhase);
      let clothesScaleY = 1.0 + 0.008 * (Math.sin(breathePhase - 0.3) * 0.5 + 0.5);

      // 5. 状态专属动力学调制
      switch (this.state) {
        case ANIMATION_STATES.POKE: {
          // Poke 局部姿态反馈三段式：后仰起动 -> 阻尼驻留 -> 平滑恢复
          const p = clamp(stateElapsed / this.pokeDurationMs, 0, 1);
          if (p <= 0.2) {
            // 0 ~ 120ms: 迅速后仰（-3.2°），重心后移并下沉
            const t = p / 0.2;
            const factor = easeOutCubic(t);
            bodyRotate = -3.2 * factor;
            bodyTranslateX = -2.5 * factor;
            bodyTranslateY = 1.8 * factor;
          } else if (p <= 0.65) {
            // 120ms ~ 390ms: 驻留并伴随微小阻尼微震
            const t = (p - 0.2) / 0.45;
            const shake = Math.sin(t * Math.PI * 4) * Math.exp(-t * 3);
            bodyRotate = -3.2 + shake * 0.5;
            bodyTranslateX = -2.5 + shake * 0.3;
            bodyTranslateY = 1.5;
          } else {
            // 390ms ~ 600ms: 平滑缓出回正
            const t = (p - 0.65) / 0.35;
            const factor = 1 - easeInOutSine(t);
            bodyRotate = -3.2 * factor;
            bodyTranslateX = -2.5 * factor;
            bodyTranslateY = 1.5 * factor - 2.0 * breatheNorm * (1 - factor);
          }
          break;
        }

        case ANIMATION_STATES.WALK: {
          // 行走动力学步态循环（Walk Dynamics）
          const stepFreq = 2.2 * Math.max(0.5, this.motion.speed / 2);
          const deltaSec = deltaMs / 1000;
          this.motion.walkPhase = (this.motion.walkPhase + deltaSec * stepFreq * Math.PI * 2) % (Math.PI * 2);

          const walkSin = Math.sin(this.motion.walkPhase);
          // 步态重心微幅沉浮（由交替迈步点阵帧主导腿部动效，躯干保持平稳贴地，消除僵硬上下颠簸）
          bodyTranslateY = -0.5 * Math.abs(walkSin);
          // 左右微幅摇摆
          bodyRotate = 1.0 * walkSin * this.motion.direction;

          // 步态相位分类
          if (walkSin > 0.3) this.motion.gait = 'left';
          else if (walkSin < -0.3) this.motion.gait = 'right';
          else this.motion.gait = 'center';

          // 发丝随步伐动态增幅
          hairRotate += 1.2 * walkSin;
          break;
        }

        case ANIMATION_STATES.STOP: {
          // 停止减速缓冲（Motion Settle Buffer，150ms 动量衰减）
          const p = clamp(stateElapsed / this.stopDurationMs, 0, 1);
          const factor = 1 - easeOutCubic(p);
          bodyTranslateY = -2.8 * factor;
          bodyRotate = 1.2 * factor * this.motion.direction;
          break;
        }

        case ANIMATION_STATES.TURN: {
          // 转身接口占位动力学（V1 姿态微倾）
          const p = clamp(stateElapsed / (this.stateDurationMs || 180), 0, 1);
          const factor = Math.sin(p * Math.PI);
          bodyRotate = 1.5 * factor * -this.motion.direction;
          break;
        }

        case ANIMATION_STATES.STRETCH: {
          // 舒展 / 伸懒腰微动：纵向微拉伸 1.025，微仰身
          const p = clamp(stateElapsed / (this.stateDurationMs || 1600), 0, 1);
          const sinP = Math.sin(p * Math.PI);
          bodyScaleY += 0.02 * sinP;
          bodyTranslateY -= 3.0 * sinP;
          bodyRotate = 0.5 * sinP;
          break;
        }

        case ANIMATION_STATES.LOOK_AROUND: {
          // 张望微动：向两侧微转并回正
          const p = clamp(stateElapsed / (this.stateDurationMs || 2000), 0, 1);
          const angle = Math.sin(p * Math.PI * 2) * 2.2;
          bodyRotate = angle;
          bodyTranslateX = angle * 0.8;
          break;
        }

        case ANIMATION_STATES.TIDY_HAIR: {
          // 整理头发微动：头微侧，发丝微摆波动
          const p = clamp(stateElapsed / (this.stateDurationMs || 1400), 0, 1);
          const sinP = Math.sin(p * Math.PI);
          bodyRotate = -1.5 * sinP;
          hairRotate += 2.0 * Math.sin(p * Math.PI * 3);
          break;
        }

        case ANIMATION_STATES.YAWN: {
          // 打哈欠微动
          const p = clamp(stateElapsed / (this.stateDurationMs || 2200), 0, 1);
          const sinP = Math.sin(p * Math.PI);
          bodyTranslateY -= 1.5 * sinP;
          bodyRotate = -1.0 * sinP;
          break;
        }

        case ANIMATION_STATES.SLEEP: {
          // 睡眠姿态：微沉、极缓呼吸
          bodyTranslateY += 1.5;
          bodyScaleY = 1.0 + 0.006 * breatheNorm;
          bodyRotate = -0.5;
          break;
        }

        case ANIMATION_STATES.WAKE: {
          // 唤醒过渡
          const p = clamp(stateElapsed / 800, 0, 1);
          bodyTranslateY = 1.5 * (1 - p);
          break;
        }
      }

      // 6. 眼睛开合度数值化（0.0: 闭合, 0.45: 半睁, 1.0: 正常睁眼, 1.15: 瞪大）
      let eyeOpenness = 1.0;
      if (this.eyeState === EYE_STATES.CLOSE) eyeOpenness = 0.0;
      else if (this.eyeState === EYE_STATES.HALF) eyeOpenness = 0.45;
      else if (this.eyeState === EYE_STATES.WIDE) eyeOpenness = 1.15;

      // 7. 投影随身体离地高度的相应微变
      const shadowScale = clamp(1.0 - (-bodyTranslateY / 40), 0.75, 1.05);
      const shadowOpacity = clamp(0.48 - (-bodyTranslateY / 60), 0.25, 0.55);

      // 返回 100% 纯数据结构 FrameData，杜绝携带任何 DOM/渲染环境引用
      return {
        state: this.state,
        priority: this.getCurrentPriority(),
        time: now,
        deltaMs,
        progress,
        body: {
          scaleX: bodyScaleX,
          scaleY: bodyScaleY,
          translateX: bodyTranslateX,
          translateY: bodyTranslateY,
          rotate: bodyRotate
        },
        hair: {
          rotate: hairRotate,
          origin: '50% 18%'
        },
        clothes: {
          rotate: clothesRotate,
          scaleY: clothesScaleY,
          origin: '50% 45%'
        },
        eyes: {
          state: this.eyeState,
          openness: eyeOpenness,
          isBlinking: this.isBlinking
        },
        motion: {
          isMoving: this.motion.isMoving,
          speed: this.motion.speed,
          direction: this.motion.direction,
          walkPhase: this.motion.walkPhase,
          gait: this.motion.gait
        },
        shadow: {
          scaleX: shadowScale,
          opacity: shadowOpacity
        }
      };
    }

    /**
     * 单步执行一帧
     */
    tick(time = this.now()) {
      if (this._destroyed) return null;
      const frameData = this.computeFrame(time);
      if (this.renderer && typeof this.renderer.render === 'function') {
        try {
          this.renderer.render(frameData);
        } catch (err) {
          // 隔离渲染层异常，保护 Controller 逻辑
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[AnimationController] Renderer render error:', err);
          }
        }
      }
      return frameData;
    }

    /* ---------------- 动画生命周期循环 ---------------- */

    /**
     * 启动动画主循环
     */
    start() {
      if (this._running || this._destroyed) return;
      this._running = true;
      this._lastTickTime = this.now();

      const loop = () => {
        if (!this._running || this._destroyed) return;
        this.tick(this.now());
        if (this._raf) {
          this._rafId = this._raf(loop);
        } else {
          this._timerId = setTimeout(loop, 16);
        }
      };

      if (this._raf) {
        this._rafId = this._raf(loop);
      } else {
        this._timerId = setTimeout(loop, 16);
      }
    }

    /**
     * 暂停动画主循环
     */
    stop() {
      this._running = false;
      if (this._rafId && this._caf) {
        this._caf(this._rafId);
        this._rafId = null;
      }
      if (this._timerId) {
        clearTimeout(this._timerId);
        this._timerId = null;
      }
    }

    /**
     * 销毁控制器并释放所有资源
     */
    destroy() {
      if (this._destroyed) return;
      this.stop();
      this._destroyed = true;
      if (this.renderer && typeof this.renderer.destroy === 'function') {
        this.renderer.destroy();
      }
    }
  }

  return AnimationController;
});
