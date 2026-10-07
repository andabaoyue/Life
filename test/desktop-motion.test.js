const assert = require('assert');
const { DesktopMotion, MOTION_STATES } = require('../src/desktop-motion');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  ' + e.message); }
}
let now = 0;
const states = [], moves = [];
const m = new DesktopMotion({ now: () => now, speed: 10, edgePauseMs: 100, climbMs: 200,
  onState: s => states.push(s), onMove: p => moves.push(p) });
m.configure({ x: 100, y: 20, width: 800, height: 600 }, { width: 100, height: 100 }, { x: 300, y: 500 });
m.setBlocked(false);
check('start 进入底部漫步', () => { assert.strictEqual(m.start(), true); assert.strictEqual(m.state, MOTION_STATES.WALKING); });
const x0 = m.position.x;
check('漫步改变窗口横坐标', () => { m.tick(); assert.strictEqual(m.position.x, x0 - 10); });
check('漫步保持工作区底部锚点', () => assert.strictEqual(m.position.y, m.bottomY()));
m.setBlocked(true, 'chat');
const stoppedAt = m.position.x;
now += 1000;
check('聊天闸门停止运动', () => { m.tick(); assert.strictEqual(m.state, MOTION_STATES.IDLE); });
check('停止后坐标不继续变化', () => assert.strictEqual(m.position.x, stoppedAt));
m.setBlocked(false); m.direction = -1; m.position.x = m.leftBound() + 1; now += 1; m.tick();
check('到达左边缘进入悬挂态', () => { assert.strictEqual(m.state, MOTION_STATES.WALL_HANGING); assert.strictEqual(m.edge, 'left'); });
now += 101; m.tick();
check('左边缘悬挂结束后反向', () => { assert.strictEqual(m.state, MOTION_STATES.WALKING); assert.strictEqual(m.direction, 1); });
m.setObstacles([{ x: 400, y: 300, width: 100, height: 200 }]);
m.position.x = 400; m.position.y = m.bottomY(); now += 1; m.tick();
check('障碍物触发图标攀爬态', () => assert.strictEqual(m.state, MOTION_STATES.ICON_CLIMBING));
check('攀爬移动到障碍物上方', () => assert.strictEqual(m.position.y, 200));
now += 401; m.tick();
check('攀爬结束回到底部漫步', () => { assert.strictEqual(m.state, MOTION_STATES.WALKING); assert.strictEqual(m.position.y, m.bottomY()); });
check('状态回调和位移回调均有记录', () => { assert(states.some(s => s.state === 'wall_hanging')); assert(moves.length > 0); });
check('SUSPENDED 状态与标签存在', () => {
  assert.strictEqual(MOTION_STATES.SUSPENDED, 'suspended');
  const { STATE_LABELS } = require('../src/desktop-motion');
  assert.strictEqual(typeof STATE_LABELS.suspended, 'string');
});
check('suspend 与 resume 状态切换', () => {
  m.suspend('user-test');
  assert.strictEqual(m.state, MOTION_STATES.SUSPENDED);
  m.resume();
  assert.strictEqual(m.state, MOTION_STATES.WALKING);
});
check('setBlocked(true) 挂起为 IDLE，setBlocked(false) 恢复为 WALKING', () => {
  m.setBlocked(true, 'block-test');
  assert.strictEqual(m.state, MOTION_STATES.IDLE);
  assert.strictEqual(m.blocked, true);
  m.setBlocked(false);
  assert.strictEqual(m.state, MOTION_STATES.WALKING);
  assert.strictEqual(m.blocked, false);
});
console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
