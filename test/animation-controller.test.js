/**
 * 自然动画系统 V1 —— AnimationController 核心单元测试
 *
 * 测试覆盖：
 * 1. IDLE 状态进入与基础微动（呼吸、眨眼、发丝摆动）
 * 2. WALK 状态进入、步态循环与 STOP 缓冲退出
 * 3. POKE 状态进入、身体后仰、重心变化、受惊眼睛、驻留与平滑恢复
 * 4. 状态切换不重复启动多个动画循环（幂等与并发保护）
 * 5. 单次微动作结束后能够正确回到目标状态
 * 6. Window Motion 与 Character Animation 深度解耦验证
 * 7. Renderer 异常隔离保护（渲染器报错不导致 Controller 崩溃）
 * 8. 眨眼系统各表情分支（正常、被戳瞪大、睡眠闭眼）
 * 9. 项目关闭与 destroy 资源自净（零定时器与动画帧泄漏）
 */

const assert = require('assert');
const { ANIMATION_STATES, EYE_STATES } = require('../src/animation-state');
const AnimationController = require('../src/animation-controller');
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

// 模拟时钟
let currentTime = 100000;
const mockNow = () => currentTime;

/* ---------- 1. IDLE 状态进入与呼吸/发丝微动 ---------- */
(() => {
  const renderer = new NullAnimationRenderer();
  const c = new AnimationController({
    now: mockNow,
    renderer,
    breatheCycleMs: 3200
  });

  check('初始状态为 IDLE', () => {
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);
  });

  check('IDLE 产生低频平滑呼吸起伏参数（scaleY 在 1.0 ~ 1.012 范围）', () => {
    const scales = [];
    for (let i = 0; i < 8; i++) {
      const f = c.tick(100000 + i * 400);
      assert(f.body.scaleY >= 1.0 && f.body.scaleY <= 1.012);
      assert(Number.isFinite(f.body.translateY));
      scales.push(f.body.scaleY);
    }
    const maxScale = Math.max(...scales);
    const minScale = Math.min(...scales);
    assert(maxScale > minScale, `maxScale (${maxScale}) should be > minScale (${minScale})`);
  });

  check('发丝与服装产生微幅独立摆动（绝对角度 <= 1.5°）', () => {
    currentTime += 800;
    const f3 = c.tick(currentTime);
    assert(Math.abs(f3.hair.rotate) <= 1.5);
    assert(Math.abs(f3.clothes.rotate) <= 1.5);
    assert.strictEqual(f3.hair.origin, '50% 18%');
    assert.strictEqual(f3.clothes.origin, '50% 45%');
  });

  c.destroy();
})();

/* ---------- 2. WALK 状态进入、步态循环与 STOP 缓冲 ---------- */
(() => {
  const renderer = new NullAnimationRenderer();
  const c = new AnimationController({
    now: mockNow,
    renderer,
    stopDurationMs: 150
  });

  check('setMotion(isMoving=true) 触发 WALK 状态进入', () => {
    c.setMotion({ isMoving: true, speed: 2.5, direction: 1 });
    assert.strictEqual(c.state, ANIMATION_STATES.WALK);
    assert.strictEqual(c.motion.direction, 1);
  });

  check('WALK 产生步态垂直起伏与摆动', () => {
    currentTime += 100;
    const frame = c.tick(currentTime);
    assert.strictEqual(frame.state, ANIMATION_STATES.WALK);
    assert(frame.body.translateY <= 0); // 步态弹跳
    assert(['left', 'center', 'right'].includes(frame.motion.gait));
  });

  check('setMotion(isMoving=false) 先进入 STOP 缓冲态', () => {
    c.setMotion({ isMoving: false });
    assert.strictEqual(c.state, ANIMATION_STATES.STOP);
  });

  check('STOP 缓冲 150ms 后平滑归于 IDLE', () => {
    currentTime += 75;
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.STOP);

    currentTime += 100; // 累计超过 150ms
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);
  });

  c.destroy();
})();

/* ---------- 3. POKE 状态进入、后仰、受惊眼、驻留与平滑恢复 ---------- */
(() => {
  const renderer = new NullAnimationRenderer();
  const c = new AnimationController({
    now: mockNow,
    renderer,
    pokeDurationMs: 600
  });

  check('poke() 立即进入 POKE 状态且眼神切换为 WIDE', () => {
    c.poke();
    assert.strictEqual(c.state, ANIMATION_STATES.POKE);
    assert.strictEqual(c.eyeState, EYE_STATES.WIDE);
  });

  check('Poke 前期（0~120ms）身体迅速后仰（旋转约 -3°）与重心下沉后移', () => {
    currentTime += 100;
    const frame = c.tick(currentTime);
    assert(frame.body.rotate < -2.0, `rotate=${frame.body.rotate}`);
    assert(frame.body.translateX < 0, `translateX=${frame.body.translateX}`);
    assert(frame.body.translateY > 0, `translateY=${frame.body.translateY}`);
  });

  check('Poke 中期（120~390ms）保持后仰驻留', () => {
    currentTime += 150; // 累计 250ms
    const frame = c.tick(currentTime);
    assert(frame.body.rotate < -2.5, `rotate=${frame.body.rotate}`);
  });

  check('Poke 后期（390~600ms）平滑恢复并在结束时回到 IDLE', () => {
    currentTime += 250; // 累计 500ms
    const fRecovering = c.tick(currentTime);
    assert(fRecovering.body.rotate > -2.0, `rotate=${fRecovering.body.rotate}`);

    currentTime += 150; // 累计 650ms (超过 600ms)
    const fDone = c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);
    assert.strictEqual(fDone.state, ANIMATION_STATES.IDLE);
    assert.strictEqual(c.eyeState, EYE_STATES.OPEN);
  });

  c.destroy();
})();

/* ---------- 4. 状态切换不重复启动多个循环（幂等性） ---------- */
(() => {
  let timerCount = 0;
  const c = new AnimationController({
    now: mockNow,
    raf: (fn) => { timerCount++; return timerCount; },
    caf: () => { timerCount--; }
  });

  check('重复调用 start() 不会泄漏多个动画主循环', () => {
    c.start();
    const count1 = timerCount;
    c.start();
    c.start();
    assert.strictEqual(timerCount, count1);
  });

  check('连续多次 poke() 保持在 POKE 状态且不创建额外循环', () => {
    c.poke();
    c.poke();
    c.poke();
    assert.strictEqual(c.state, ANIMATION_STATES.POKE);
  });

  c.destroy();
  check('destroy() 彻底清理所有循环定时器', () => {
    assert.strictEqual(c._running, false);
    assert.strictEqual(timerCount, 0);
  });
})();

/* ---------- 5. 单次微动作完成后正确回到目标状态 ---------- */
(() => {
  const c = new AnimationController({ now: mockNow });
  check('playAction(STRETCH, 1000) 播放后回到 IDLE', () => {
    const ok = c.playAction(ANIMATION_STATES.STRETCH, { duration: 1000 });
    assert.strictEqual(ok, true);
    assert.strictEqual(c.state, ANIMATION_STATES.STRETCH);

    currentTime += 500;
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.STRETCH);

    currentTime += 600; // 超过 1000ms
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);
  });
  c.destroy();
})();

/* ---------- 6. Window Motion 与 Character Animation 解耦 ---------- */
(() => {
  const c = new AnimationController({ now: mockNow });

  check('窗口静止时初澜依然可以进行原地自主动作（伸懒腰/张望）', () => {
    assert.strictEqual(c.motion.isMoving, false);
    const ok = c.playAction(ANIMATION_STATES.LOOK_AROUND, { duration: 1500 });
    assert.strictEqual(ok, true);
    assert.strictEqual(c.state, ANIMATION_STATES.LOOK_AROUND);
  });

  check('窗口移动中初澜被戳，POKE 优先打断行走，恢复后回归 WALK', () => {
    currentTime += 2000;
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);

    // 窗口开始移动
    c.setMotion({ isMoving: true, speed: 2, direction: -1 });
    assert.strictEqual(c.state, ANIMATION_STATES.WALK);

    // 被戳
    c.poke();
    assert.strictEqual(c.state, ANIMATION_STATES.POKE);

    // 600ms 后 Poke 完成
    currentTime += 700;
    c.tick(currentTime);
    // 因为窗口仍在移动，所以正确回到 WALK 而非死板停住
    assert.strictEqual(c.state, ANIMATION_STATES.WALK);
  });

  c.destroy();
})();

/* ---------- 7. Renderer 异常隔离保护 ---------- */
(() => {
  const renderer = new NullAnimationRenderer();
  renderer.throwOnRender = true; // 模拟 DOM 异常

  const c = new AnimationController({ now: mockNow, renderer });

  check('渲染器抛错不会导致 Controller 崩溃或状态机中断', () => {
    let threw = false;
    try {
      c.tick(currentTime);
      c.poke();
      c.tick(currentTime + 100);
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
    assert.strictEqual(c.state, ANIMATION_STATES.POKE);
  });

  c.destroy();
})();

/* ---------- 8. 眨眼系统表情分支与随机抖动 ---------- */
(() => {
  const c = new AnimationController({
    now: mockNow,
    blinkMinMs: 3000,
    blinkMaxMs: 4000,
    blinkDurationMs: 150
  });

  check('SLEEP 状态闭眼且不眨眼', () => {
    c.transitionTo(ANIMATION_STATES.SLEEP, { force: true });
    c.tick(currentTime);
    assert.strictEqual(c.eyeState, EYE_STATES.CLOSE);
    assert.strictEqual(c.isBlinking, false);
  });

  check('从 SLEEP 唤醒后回到 IDLE 重新启动眨眼', () => {
    c.transitionTo(ANIMATION_STATES.WAKE, { force: true });
    assert.strictEqual(c.eyeState, EYE_STATES.HALF);
    c.transitionTo(ANIMATION_STATES.IDLE, { force: true });
    assert.strictEqual(c.eyeState, EYE_STATES.OPEN);
  });

  check('IDLE 状态下时间到达 nextBlinkTime 时触发眨眼循环', () => {
    currentTime = c.nextBlinkTime + 10;
    c.tick(currentTime);
    assert.strictEqual(c.isBlinking, true);

    // 眨眼中途经过 HALF / CLOSE
    currentTime += 60;
    const fMid = c.tick(currentTime);
    assert([EYE_STATES.HALF, EYE_STATES.CLOSE].includes(fMid.eyes.state));

    // 眨眼结束回到 OPEN
    currentTime += 120;
    const fEnd = c.tick(currentTime);
    assert.strictEqual(fEnd.eyes.state, EYE_STATES.OPEN);
    assert.strictEqual(c.isBlinking, false);
  });

  c.destroy();
})();

/* ---------- 9. 项目关闭与 destroy 资源自净 ---------- */
(() => {
  const renderer = new NullAnimationRenderer();
  const c = new AnimationController({ now: mockNow, renderer });
  c.start();

  check('destroy() 标记 destroyed 为 true 并停止主循环', () => {
    c.destroy();
    assert.strictEqual(c._destroyed, true);
    assert.strictEqual(c._running, false);
    assert.strictEqual(renderer.destroyed, true);
  });

  check('destroy() 后拒绝所有新的状态转换和 tick', () => {
    const res = c.transitionTo(ANIMATION_STATES.WALK);
    assert.strictEqual(res, false);
    const tickRes = c.tick(currentTime);
    assert.strictEqual(tickRes, null);
  });
})();

/* ---------- 10. Animation Priority & Arbitration 仲裁测试 ---------- */
(() => {
  const c = new AnimationController({ now: mockNow });

  check('低优先级动作（STRETCH）不能打断中优先级行走（WALK）', () => {
    c.setMotion({ isMoving: true, speed: 2 });
    assert.strictEqual(c.state, ANIMATION_STATES.WALK);
    const ok = c.playAction(ANIMATION_STATES.STRETCH, { duration: 1000 });
    assert.strictEqual(ok, false);
    assert.strictEqual(c.state, ANIMATION_STATES.WALK);
  });

  check('高优先级交互（POKE）成功打断 WALK 与 STRETCH', () => {
    c.poke();
    assert.strictEqual(c.state, ANIMATION_STATES.POKE);
    // POKE 期间低优先级微动作被坚决拒绝
    const ok = c.playAction(ANIMATION_STATES.YAWN);
    assert.strictEqual(ok, false);
    assert.strictEqual(c.state, ANIMATION_STATES.POKE);
  });

  check('POKE 结束后根据物理位移自适应恢复至 WALK（Resume Policy）', () => {
    currentTime += 700;
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.WALK);
  });

  check('位移停止时 POKE 结束后正确归于 IDLE', () => {
    c.setMotion({ isMoving: false }); // 触发 STOP
    currentTime += 200;
    c.tick(currentTime); // 回到 IDLE
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);

    c.poke();
    assert.strictEqual(c.state, ANIMATION_STATES.POKE);
    currentTime += 700;
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);
  });

  c.destroy();
})();

/* ---------- 11. FrameData 纯度测试 (Purity & Serialization) ---------- */
(() => {
  const c = new AnimationController({ now: mockNow });
  check('FrameData 为 100% 纯数据结构，完全可 JSON 序列化且不含任何 DOM 引用', () => {
    const frame = c.tick(currentTime);
    assert(frame !== null && typeof frame === 'object');

    // 必须能够无异常 JSON 序列化
    const jsonStr = JSON.stringify(frame);
    assert(typeof jsonStr === 'string' && jsonStr.length > 50);

    // 递归校验无函数、无 DOM 对象、无循环引用
    function assertPure(obj, path = '') {
      for (const [k, v] of Object.entries(obj)) {
        assert(typeof v !== 'function', `Found function at ${path}.${k}`);
        if (v && typeof v === 'object') {
          assert(!v.nodeType, `Found DOM Node at ${path}.${k}`);
          assert(!v.tagName, `Found HTMLElement at ${path}.${k}`);
          assertPure(v, `${path}.${k}`);
        }
      }
    }
    assertPure(frame, 'frame');

    // 核心契约字段完整性
    assert(frame.state);
    assert(Number.isFinite(frame.priority));
    assert(Number.isFinite(frame.time));
    assert(frame.body && Number.isFinite(frame.body.scaleY));
    assert(frame.hair && frame.hair.origin);
    assert(frame.clothes && frame.clothes.origin);
    assert(frame.eyes && frame.eyes.state);
    assert(frame.motion && Number.isFinite(frame.motion.speed));
    assert(frame.shadow && Number.isFinite(frame.shadow.scaleX));
  });
  c.destroy();
})();

/* ---------- 12. Debug Snapshot 调试接口测试 ---------- */
(() => {
  const c = new AnimationController({ now: mockNow, debug: true });
  check('getDebugSnapshot() 返回清晰可追踪的状态机调试字典', () => {
    c.setMotion({ isMoving: true, speed: 3, direction: -1 });
    const snap = c.getDebugSnapshot();
    assert.strictEqual(snap.currentState, ANIMATION_STATES.WALK);
    assert.strictEqual(snap.animationPriority, 20);
    assert.strictEqual(snap.motion.speed, 3);
    assert.strictEqual(snap.motion.direction, -1);
    assert.strictEqual(snap.running, false);
    assert.strictEqual(snap.destroyed, false);
  });
  c.destroy();
})();

/* ---------- 13. TURN 转向接口契约测试 ---------- */
(() => {
  const c = new AnimationController({ now: mockNow });
  check('turn() 接口支持方向切换并进入 TURN 状态', () => {
    c.motion.direction = 1;
    const ok = c.turn(-1);
    assert.strictEqual(ok, true);
    assert.strictEqual(c.state, ANIMATION_STATES.TURN);
    assert.strictEqual(c.motion.direction, -1);

    currentTime += 200; // 超过 turnDurationMs (180ms)
    c.tick(currentTime);
    assert.strictEqual(c.state, ANIMATION_STATES.IDLE);
  });
  c.destroy();
})();

console.log('\n' + (failures ? failures + ' 项失败' : 'AnimationController 测试全部通过'));
process.exit(failures ? 1 : 0);

