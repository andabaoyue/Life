/**
 * 桌面自主运动状态机。
 *
 * 这里只负责几何和状态，不直接依赖 Electron，便于测试和未来接入不同平台。
 * 实际桌面图标的位置不能由 Electron 的 screen API 跨平台读取，因此 icon
 * 障碍物采用可选注入：没有 provider 时安全降级为底部漫步 + 贴边攀爬。
 *
 * v0.9.2 改为按需运行：IDLE/SUSPENDED 时不启动高频循环，只有 WALKING 时才
 * 持续 tick。边缘暂停和攀爬用一次性 setTimeout 代替持续空转。
 * 外部不再维护 setInterval —— 调 resume()/suspend() 即可。
 */

const MOTION_STATES = Object.freeze({
  IDLE: 'idle',
  WALKING: 'walking',
  WALL_HANGING: 'wall_hanging',
  ICON_CLIMBING: 'icon_climbing',
  SUSPENDED: 'suspended'
});

const STATE_LABELS = Object.freeze({
  idle: '静止',
  walking: '正在屏幕底部闲逛',
  wall_hanging: '正挂在屏幕边缘窗框上',
  icon_climbing: '正趴在桌面图标上看着你',
  suspended: '暂停运动'
});

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

class DesktopMotion {
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.tickMs = Number.isFinite(opts.tickMs) ? Math.max(30, opts.tickMs) : 50;
    this.speed = Number.isFinite(opts.speed) ? Math.max(1, opts.speed) : 2;
    this.margin = Number.isFinite(opts.margin) ? Math.max(0, opts.margin) : 20;
    this.edgePauseMs = Number.isFinite(opts.edgePauseMs) ? Math.max(0, opts.edgePauseMs) : 1800;
    this.climbMs = Number.isFinite(opts.climbMs) ? Math.max(400, opts.climbMs) : 3200;
    this.state = MOTION_STATES.IDLE;
    this.direction = -1;
    this.edge = null;
    this.edgeUntil = 0;
    this.climbUntil = 0;
    this.enabled = opts.enabled !== false;
    this.blocked = true;
    this.position = null;
    this.workArea = null;
    this.windowSize = null;
    this.obstacles = [];
    this.ignoreObstacle = null;
    this.ignoreObstacleUntil = 0;
    this.onState = opts.onState || (() => {});
    this.onMove = opts.onMove || (() => {});

    /* ---------- 内部定时器管理 ---------- */
    this._tickTimer = null;   // setInterval for WALKING tick
    this._waitTimer = null;   // setTimeout for edge-pause / icon-climb wait
    // 测试模式：外部注入 now 函数时禁用真实定时器，由测试手动驱动 tick
    this._useRealTimers = !opts.now;
    // v0.9.2: setTimeout/setInterval 引用，便于测试注入
    this._setTimeout = opts._setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    this._clearTimeout = opts._clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);
    this._setInterval = opts._setInterval || (typeof setInterval !== 'undefined' ? setInterval : null);
    this._clearInterval = opts._clearInterval || (typeof clearInterval !== 'undefined' ? clearInterval : null);
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    if (!this.enabled) this.stop('disabled');
  }

  /**
   * 设置外部阻塞状态。blocked=true 时挂起运动循环，false 时尝试恢复。
   * 这是外部控制 Motion 的唯一入口 —— 主进程不再需要每 50ms 来问一次。
   */
  setBlocked(blocked, reason = 'ui') {
    this.blocked = blocked === true;
    if (this.blocked) {
      this._stopLoop();
      this.stop(reason);
    } else {
      // 阻塞解除后尝试恢复运动
      this.resume();
    }
  }

  setObstacles(obstacles) {
    this.obstacles = Array.isArray(obstacles) ? obstacles.filter(o =>
      o && Number.isFinite(o.x) && Number.isFinite(o.y)
      && Number.isFinite(o.width) && Number.isFinite(o.height)
      && o.width > 0 && o.height > 0) : [];
  }

  configure(workArea, windowSize, position) {
    this.workArea = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
    this.windowSize = { width: windowSize.width, height: windowSize.height };
    this.position = { x: position.x, y: position.y };
    this.position.x = clamp(this.position.x, this.leftBound(), this.rightBound());
    this.position.y = this.bottomY();
  }

  leftBound() { return this.workArea ? this.workArea.x : 0; }
  rightBound() {
    return this.workArea && this.windowSize
      ? this.workArea.x + this.workArea.width - this.windowSize.width : 0;
  }
  bottomY() {
    return this.workArea && this.windowSize
      ? this.workArea.y + this.workArea.height - this.windowSize.height - this.margin : 0;
  }

  /**
   * 尝试从 IDLE 进入 WALKING。成功时启动 tick 循环。
   * 返回 false 表示条件不满足（blocked / disabled / 缺少位置信息）。
   */
  start() {
    if (!this.enabled || this.blocked || !this.position || !this.workArea) return false;
    if (this.state === MOTION_STATES.IDLE || this.state === MOTION_STATES.SUSPENDED) {
      this.transition(MOTION_STATES.WALKING);
      this._startLoop();
    }
    return true;
  }

  stop(reason = 'stopped') {
    this._stopLoop();
    this.edge = null;
    this.edgeUntil = 0;
    this.climbUntil = 0;
    if (this.state !== MOTION_STATES.IDLE) this.transition(MOTION_STATES.IDLE, reason);
  }

  /**
   * 恢复运动：外部阻塞解除后由 setBlocked(false) 调用。
   * 只有 enabled && !blocked 且有位置信息时才真正启动。
   */
  resume() {
    if (!this.enabled || this.blocked || !this.position || !this.workArea) return;
    if (this.state === MOTION_STATES.IDLE || this.state === MOTION_STATES.SUSPENDED) {
      this.start();
    }
  }

  /**
   * 挂起运动循环。不改变状态机状态（那由 stop 管），只清理定时器。
   */
  suspend(reason = 'suspended') {
    this._stopLoop();
    if (this.state !== MOTION_STATES.IDLE && this.state !== MOTION_STATES.SUSPENDED) {
      this.transition(MOTION_STATES.SUSPENDED, reason);
    }
  }

  transition(next, reason) {
    if (this.state === next) return;
    this.state = next;
    this.onState({
      state: next,
      label: STATE_LABELS[next],
      reason,
      direction: this.direction,
      speed: this.speed
    });
  }

  tryIconClimb() {
    if (!this.position || !this.obstacles.length) return false;
    const x = this.position.x, y = this.position.y;
    const hit = this.obstacles.find(o =>
      (o !== this.ignoreObstacle || this.now() >= this.ignoreObstacleUntil)
      && x + (this.windowSize?.width || 0) > o.x && x < o.x + o.width
      && Math.abs(y - (o.y + o.height)) <= Math.max(8, this.speed + 2));
    if (!hit) return false;
    this.edge = 'icon';
    this.climbUntil = this.now() + this.climbMs;
    this.position.y = Math.max(this.workArea.y, hit.y - (this.windowSize?.height || 0));
    this.transition(MOTION_STATES.ICON_CLIMBING, 'icon-obstacle');
    this.onMove({ ...this.position });
    // 攀爬时停止 tick 循环，用一次性 setTimeout 等待攀爬结束
    this._stopLoop();
    this._scheduleWait(this.climbMs, () => this._onClimbDone());
    return true;
  }

  /** 攀爬等待结束 */
  _onClimbDone() {
    if (this.state !== MOTION_STATES.ICON_CLIMBING) return;
    if (this.blocked || !this.enabled) { this.stop('blocked-during-climb'); return; }
    this.edge = null;
    this.position.y = this.bottomY();
    this.ignoreObstacle = this.obstacles.find(o => o.x <= this.position.x + this.windowSize.width
      && o.x + o.width >= this.position.x);
    this.ignoreObstacleUntil = this.now() + this.climbMs;
    this.transition(MOTION_STATES.WALKING, 'icon-climb-finished');
    this.onMove({ ...this.position });
    this._startLoop();
  }

  /** 边缘暂停等待结束 */
  _onEdgePauseDone() {
    if (this.state !== MOTION_STATES.WALL_HANGING) return;
    if (this.blocked || !this.enabled) { this.stop('blocked-during-edge'); return; }
    this.direction = this.edge === 'left' ? 1 : -1;
    this.edge = null;
    this.position.y = this.bottomY();
    this.transition(MOTION_STATES.WALKING, 'edge-pause-finished');
    this._startLoop();
  }

  tick() {
    if (!this.enabled || this.blocked || !this.position || !this.workArea) return this.snapshot();
    const now = this.now();
    if (this.state === MOTION_STATES.IDLE || this.state === MOTION_STATES.SUSPENDED) this.start();

    // 攀爬和边缘暂停在 v0.9.2 中由 setTimeout 驱动，但保留 tick 中的检查
    // 以兼容测试（测试注入 now 函数手动驱动 tick，不使用真实 setTimeout）
    if (this.state === MOTION_STATES.ICON_CLIMBING) {
      if (now < this.climbUntil) return this.snapshot();
      this.edge = null;
      this.position.y = this.bottomY();
      this.ignoreObstacle = this.obstacles.find(o => o.x <= this.position.x + this.windowSize.width
        && o.x + o.width >= this.position.x);
      this.ignoreObstacleUntil = now + this.climbMs;
      this.transition(MOTION_STATES.WALKING, 'icon-climb-finished');
      this.onMove({ ...this.position });
      return this.snapshot();
    }

    if (this.state === MOTION_STATES.WALL_HANGING) {
      if (now < this.edgeUntil) return this.snapshot();
      this.direction = this.edge === 'left' ? 1 : -1;
      this.edge = null;
      this.position.y = this.bottomY();
      this.transition(MOTION_STATES.WALKING, 'edge-pause-finished');
    }

    if (this.state !== MOTION_STATES.WALKING) return this.snapshot();
    this.position.x += this.direction * this.speed;
    this.position.y = this.bottomY();
    if (this.tryIconClimb()) return this.snapshot();

    if (this.position.x <= this.leftBound()) {
      this.position.x = this.leftBound();
      this.edge = 'left';
      this.edgeUntil = now + this.edgePauseMs;
      this.transition(MOTION_STATES.WALL_HANGING, 'left-edge');
      // 边缘暂停时停止 tick 循环，用 setTimeout 等待
      this._stopLoop();
      this._scheduleWait(this.edgePauseMs, () => this._onEdgePauseDone());
    } else if (this.position.x >= this.rightBound()) {
      this.position.x = this.rightBound();
      this.edge = 'right';
      this.edgeUntil = now + this.edgePauseMs;
      this.transition(MOTION_STATES.WALL_HANGING, 'right-edge');
      this._stopLoop();
      this._scheduleWait(this.edgePauseMs, () => this._onEdgePauseDone());
    }
    this.onMove({ ...this.position });
    return this.snapshot();
  }

  snapshot() {
    return {
      state: this.state,
      label: STATE_LABELS[this.state],
      x: this.position ? this.position.x : null,
      y: this.position ? this.position.y : null,
      direction: this.direction,
      edge: this.edge,
      enabled: this.enabled,
      blocked: this.blocked
    };
  }

  /* ---------- 内部定时器管理 ---------- */

  /** 启动 tick 循环（仅 WALKING 时需要） */
  _startLoop() {
    if (this._tickTimer || !this._useRealTimers) return;
    this._tickTimer = this._setInterval(() => this.tick(), this.tickMs);
    if (this._tickTimer && this._tickTimer.unref) this._tickTimer.unref();
  }

  /** 停止 tick 循环和所有等待定时器 */
  _stopLoop() {
    if (this._tickTimer) {
      this._clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._waitTimer) {
      this._clearTimeout(this._waitTimer);
      this._waitTimer = null;
    }
  }

  /** 调度一次性等待（边缘暂停 / 攀爬） */
  _scheduleWait(delayMs, callback) {
    if (!this._useRealTimers) return;  // 测试模式下由外部 tick 驱动
    if (this._waitTimer) {
      this._clearTimeout(this._waitTimer);
      this._waitTimer = null;
    }
    this._waitTimer = this._setTimeout(() => {
      this._waitTimer = null;
      callback();
    }, delayMs);
    if (this._waitTimer && this._waitTimer.unref) this._waitTimer.unref();
  }
}

module.exports = { DesktopMotion, MOTION_STATES, STATE_LABELS, clamp };

if (require.main === module) {
  // 仅供人工快速试跑，不参与应用启动。
  const m = new DesktopMotion({ enabled: true });
  m.configure({ x: 0, y: 0, width: 1920, height: 1080 }, { width: 340, height: 480 }, { x: 100, y: 580 });
  console.log(m.snapshot());
}
