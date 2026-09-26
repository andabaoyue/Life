/**
 * 自然动画系统 V1 —— BehaviorScheduler 自主行为调度器单元测试
 *
 * 测试覆盖：
 * 1. 静默门槛保护（未达到 idleMinMs 绝对不触发）
 * 2. 状态门槛保护（非 IDLE 状态，例如 POKE/WALK 时不触发）
 * 3. 礼貌闸门保护（用户在输入、气泡开启中不打扰）
 * 4. 冷却机制测试（单次微动触发后，在 cooldown 内不再重复触发）
 * 5. 用户交互刷新水位（noteActivity 推迟下次触发）
 * 6. 行为只走 Controller 接口（playAction 统一受控）
 * 7. 销毁与资源自净（destroy 后无定时器残留）
 */

const assert = require('assert');
const { ANIMATION_STATES } = require('../src/animation-state');
const AnimationController = require('../src/animation-controller');
const BehaviorScheduler = require('../src/behavior-scheduler');
const { NullAnimationRenderer } = require('../src/render-adapter');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + '  ' + e.message);
  }
}

let mockTime = 500000;
const mockNow = () => mockTime;

/* ---------- 1. 静默门槛保护 ---------- */
(() => {
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
  const scheduler = new BehaviorScheduler({
    controller,
    now: mockNow,
    idleMinMs: 15000,
    cooldownMinMs: 20000,
    cooldownMaxMs: 30000
  });

  check('初始时刻未满 15 秒静默不调度任何动作', () => {
    mockTime = 500000;
    const res = scheduler.evaluate(mockTime);
    assert.strictEqual(res, null);
    assert.strictEqual(controller.state, ANIMATION_STATES.IDLE);
  });

  check('静默满 14.9 秒仍不触发', () => {
    mockTime = 514999;
    const res = scheduler.evaluate(mockTime);
    assert.strictEqual(res, null);
  });

  check('静默刚好满 15 秒成功触发自主微动并进入动作状态', () => {
    mockTime = 515000;
    const res = scheduler.evaluate(mockTime);
    assert(res !== null);
    assert(['stretch', 'look_around', 'tidy_hair', 'yawn'].includes(res.name));
    assert.strictEqual(controller.state, res.name);
  });

  scheduler.destroy();
  controller.destroy();
})();

/* ---------- 2. 冷却保护（防抖防刷） ---------- */
(() => {
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
  const scheduler = new BehaviorScheduler({
    controller,
    now: mockNow,
    idleMinMs: 10000,
    cooldownMinMs: 20000,
    cooldownMaxMs: 25000,
    rng: () => 0
  });

  mockTime = 600000;
  mockTime += 10000; // 满 10 秒
  const firstAction = scheduler.evaluate(mockTime);
  assert(firstAction !== null);

  // 让 Controller 中的微动作播放完毕回到 IDLE：
  // 必须根据实际抽中的动作时长前进，避免固定时间对长动作（如 yawn 2200ms）造成 flaky
  mockTime += firstAction.duration;
  controller.tick(mockTime);
  assert.strictEqual(controller.state, ANIMATION_STATES.IDLE);

  check('微动结束后仍在冷却期内（未满 20 秒）不会二次触发', () => {
    mockTime += 5000; // 离上次触发仅 7 秒
    const res = scheduler.evaluate(mockTime);
    assert.strictEqual(res, null);
    assert.strictEqual(controller.state, ANIMATION_STATES.IDLE);
  });

  check('冷却时间过后再允许触发下一次自主微动', () => {
    mockTime += 22000; // 离上次触发超过 27 秒
    const secondAction = scheduler.evaluate(mockTime);
    assert(secondAction !== null);
    assert.strictEqual(controller.state, secondAction.name);
  });

  scheduler.destroy();
  controller.destroy();
})();

/* ---------- 3. 状态门槛保护（非 IDLE 状态禁止自主微动） ---------- */
(() => {
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
  const scheduler = new BehaviorScheduler({
    controller,
    now: mockNow,
    idleMinMs: 5000
  });

  mockTime = 700000;
  mockTime += 10000;

  check('处于 WALK 状态时拒绝调度自主微动', () => {
    controller.setMotion({ isMoving: true });
    assert.strictEqual(controller.state, ANIMATION_STATES.WALK);
    const res = scheduler.evaluate(mockTime);
    assert.strictEqual(res, null);
    assert.strictEqual(controller.state, ANIMATION_STATES.WALK);
  });

  check('处于 POKE 状态时拒绝调度自主微动', () => {
    controller.poke();
    assert.strictEqual(controller.state, ANIMATION_STATES.POKE);
    const res = scheduler.evaluate(mockTime);
    assert.strictEqual(res, null);
    assert.strictEqual(controller.state, ANIMATION_STATES.POKE);
  });

  scheduler.destroy();
  controller.destroy();
})();

/* ---------- 4. 礼貌闸门保护（politeCheck） ---------- */
(() => {
  let isPolite = false;
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
  const scheduler = new BehaviorScheduler({
    controller,
    now: mockNow,
    idleMinMs: 5000,
    politeCheck: () => isPolite
  });

  mockTime = 800000;
  mockTime += 10000;

  check('politeCheck 为 false 时不打扰用户', () => {
    isPolite = false;
    const res = scheduler.evaluate(mockTime);
    assert.strictEqual(res, null);
    assert.strictEqual(controller.state, ANIMATION_STATES.IDLE);
  });

  check('politeCheck 为 true 时放行自主微动', () => {
    isPolite = true;
    const res = scheduler.evaluate(mockTime);
    assert(res !== null);
    assert.strictEqual(controller.state, res.name);
  });

  scheduler.destroy();
  controller.destroy();
})();

/* ---------- 5. 用户交互刷新水位（noteActivity） ---------- */
(() => {
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
  const scheduler = new BehaviorScheduler({
    controller,
    now: mockNow,
    idleMinMs: 10000
  });

  mockTime = 900000;
  mockTime += 9000; // 已经过了 9 秒

  check('用户此时交互，noteActivity 重置静默计时', () => {
    scheduler.noteActivity(mockTime);
    // 再过 2 秒（总共 11 秒，但离上次交互仅 2 秒）
    mockTime += 2000;
    const res = scheduler.evaluate(mockTime);
    assert.strictEqual(res, null);
  });

  check('重新静默满 10 秒后才触发', () => {
    mockTime += 9000; // 离上次交互满 11 秒
    const res = scheduler.evaluate(mockTime);
    assert(res !== null);
  });

  scheduler.destroy();
  controller.destroy();
})();

/* ---------- 6. 销毁与资源自净 ---------- */
(() => {
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
  const scheduler = new BehaviorScheduler({ controller, now: mockNow });

  scheduler.start();
  check('start() 启动内部定时器', () => {
    assert(scheduler._timer !== null);
  });

  scheduler.destroy();
  check('destroy() 清理定时器并设置 _destroyed 为 true', () => {
    assert.strictEqual(scheduler._timer, null);
    assert.strictEqual(scheduler._destroyed, true);
  });

  check('destroy() 后拒绝调度', () => {
    const res = scheduler.evaluate(mockTime + 50000);
    assert.strictEqual(res, null);
  });

  controller.destroy();
})();

/* ---------- 7. Development vs Production 配置 Profile 测试 ---------- */
(() => {
  const { SCHEDULER_PROFILES } = require('../src/behavior-scheduler');
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });

  check('SCHEDULER_PROFILES 具备完整的开发与生产预设', () => {
    assert.strictEqual(SCHEDULER_PROFILES.development.idleMinMs, 15000);
    assert.strictEqual(SCHEDULER_PROFILES.production.idleMinMs, 180000);
    assert.strictEqual(SCHEDULER_PROFILES.production.cooldownMinMs, 120000);
  });

  check('Production 模式在 60 秒静默时不触发，满 180 秒才触发', () => {
    mockTime = 1000000;
    const prodScheduler = new BehaviorScheduler({
      profile: 'production',
      controller,
      now: mockNow
    });

    // 过了 60 秒（1 分钟）
    mockTime += 60000;
    assert.strictEqual(prodScheduler.evaluate(mockTime), null);

    // 过了 179 秒
    mockTime = 1000000 + 179000;
    assert.strictEqual(prodScheduler.evaluate(mockTime), null);

    // 满 180 秒（3 分钟）
    mockTime = 1000000 + 180000;
    const res = prodScheduler.evaluate(mockTime);
    assert(res !== null);
    prodScheduler.destroy();
  });

  controller.destroy();
})();

/* ---------- 8. 与 ActivityTracker 权威时间联动测试 ---------- */
(() => {
  const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
  const mockTracker = {
    lastInteractionAt: 1200000
  };

  const scheduler = new BehaviorScheduler({
    controller,
    now: mockNow,
    tracker: mockTracker,
    idleMinMs: 15000
  });

  check('getLastActivityAt() 优先读取 ActivityTracker 的权威时间', () => {
    assert.strictEqual(scheduler.getLastActivityAt(), 1200000);
    mockTracker.lastInteractionAt = 1205000;
    assert.strictEqual(scheduler.getLastActivityAt(), 1205000);
  });

  check('Tracker 记录了近期活动时，Scheduler 自动推迟微动作调度', () => {
    mockTime = 1205000 + 10000; // 仅过了 10 秒
    assert.strictEqual(scheduler.evaluate(mockTime), null);

    mockTime = 1205000 + 16000; // 离 Tracker 互动满 16 秒
    assert(scheduler.evaluate(mockTime) !== null);
  });

  scheduler.destroy();
  controller.destroy();
})();

/* ---------- 9. 标准化 BehaviorDefinition 完整性测试 ---------- */
(() => {
  const { BEHAVIOR_DEFINITIONS } = require('../src/behavior-scheduler');
  check('行为定义池包含完整契约字段（id, duration, priority, allowedStates）', () => {
    const list = Object.values(BEHAVIOR_DEFINITIONS);
    assert(list.length >= 4);
    for (const b of list) {
      assert(typeof b.id === 'string');
      assert(Number.isFinite(b.duration) && b.duration > 0);
      assert(typeof b.priority === 'string');
      assert(Array.isArray(b.allowedStates) && b.allowedStates.includes(ANIMATION_STATES.IDLE));
      assert.strictEqual(b.completionTarget, ANIMATION_STATES.IDLE);
    }
  });
})();

/* ---------- 10. 确定性多时长动作覆盖测试 (P1-01) ---------- */
(() => {
  const { BEHAVIOR_DEFINITIONS } = require('../src/behavior-scheduler');
  for (const item of Object.values(BEHAVIOR_DEFINITIONS)) {
    check(`确定性测试行为 ${item.id} (时长 ${item.duration}ms) 的完整生命周期`, () => {
      mockTime = 1500000;
      const controller = new AnimationController({ now: mockNow, renderer: new NullAnimationRenderer() });
      const scheduler = new BehaviorScheduler({
        controller,
        now: mockNow,
        idleMinMs: 1000,
        cooldownMinMs: 5000,
        pickBehavior: () => item
      });

      mockTime += 1000; // 满 1 秒静默
      const action = scheduler.evaluate(mockTime);
      assert.strictEqual(action.id, item.id);
      assert.strictEqual(controller.state, item.id);

      // 前进一步（仅走一半时长）：此时动作应仍在播放
      mockTime += Math.floor(item.duration / 2);
      controller.tick(mockTime);
      assert.strictEqual(controller.state, item.id);

      // 走完全部时长：此时必须准时回落到 IDLE
      mockTime += (item.duration - Math.floor(item.duration / 2));
      controller.tick(mockTime);
      assert.strictEqual(controller.state, ANIMATION_STATES.IDLE);

      scheduler.destroy();
      controller.destroy();
    });
  }
})();

console.log('\n' + (failures ? failures + ' 项失败' : 'BehaviorScheduler 测试全部通过'));
process.exit(failures ? 1 : 0);

