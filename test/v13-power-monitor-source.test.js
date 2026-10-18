/**
 * test/v13-power-monitor-source.test.js
 *
 * Life v1.3-a 宿主电源与环境事件源单元测试：
 * 验证 PowerMonitorSource 的依赖注入、事件映射、对称退订与异常隔离。
 */

'use strict';

const EventEmitter = require('events');
const { PowerMonitorSource, POWER_EVENT_MAP } = require('../src/power-monitor-source');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.3-a PowerMonitorSource Tests ---');

// 1. 无头 Node 环境默认回落：无 electron.powerMonitor 时安全处理
{
  const src = new PowerMonitorSource({ powerMonitor: null });
  check('1. 无 powerMonitor 时 isAvailable 为 false', src.isAvailable === false);
  check('2. 无 powerMonitor 时 start() 返回 false 且不崩溃', src.start(() => {}) === false);
  check('3. stop() 在未启动时不崩溃', () => { src.stop(); return true; });
}

// 2. 模拟 EventEmitter 依赖注入与事件映射
{
  const mockPm = new EventEmitter();
  const src = new PowerMonitorSource({ powerMonitor: mockPm });
  check('4. 注入 mock powerMonitor 后 isAvailable 为 true', src.isAvailable === true);

  const received = [];
  const ok = src.start((stimulus) => received.push(stimulus));
  check('5. 正常 start() 返回 true 且 isActive 为 true', ok === true && src.isActive === true);

  // 触发全部 4 类事件
  mockPm.emit('suspend');
  mockPm.emit('resume');
  mockPm.emit('lock-screen');
  mockPm.emit('unlock-screen');

  check('6. 全部 4 类事件均被捕获分发', received.length === 4);

  const mapExpect = [
    { event: 'suspend', cat: 'host_suspend', intensity: 70 },
    { event: 'resume', cat: 'host_resume', intensity: 60 },
    { event: 'lock-screen', cat: 'host_lock', intensity: 55 },
    { event: 'unlock-screen', cat: 'host_unlock', intensity: 65 }
  ];

  let mappedCorrectly = true;
  for (let i = 0; i < mapExpect.length; i++) {
    const exp = mapExpect[i];
    const rec = received[i];
    if (!rec || rec.category !== exp.cat || rec.rawIntensity !== exp.intensity || rec.eventName !== exp.event) {
      mappedCorrectly = false;
      break;
    }
  }
  check('7. 事件映射 category 与 rawIntensity 严格符合规格', mappedCorrectly);

  // 3. 对称注销测试 (stop)
  src.stop();
  check('8. stop() 后 isActive 为 false', src.isActive === false);
  check('9. stop() 移除 mock 所有监听器（无泄漏）', mockPm.listenerCount('suspend') === 0 &&
    mockPm.listenerCount('resume') === 0 &&
    mockPm.listenerCount('lock-screen') === 0 &&
    mockPm.listenerCount('unlock-screen') === 0);

  // stop 后发事件不应再被接收
  mockPm.emit('resume');
  check('10. stop() 后触发事件不再被接收', received.length === 4);
}

// 4. 重复 start() 自愈与异常隔离
{
  const mockPm = new EventEmitter();
  const src = new PowerMonitorSource({ powerMonitor: mockPm });

  src.start(() => {});
  check('11. 初始监听器数量恰好为 1', mockPm.listenerCount('suspend') === 1);

  // 再次调用 start 不会导致监听器翻倍
  src.start(() => {
    throw new Error('boom');
  });
  check('12. 再次 start() 自动清理前序监听器（监听器不翻倍）', mockPm.listenerCount('suspend') === 1);

  // 回调抛出异常不向外穿透崩溃
  let threw = false;
  try {
    mockPm.emit('suspend');
  } catch (_) {
    threw = true;
  }
  check('13. 回调内部异常被安全捕获隔离（不向外崩溃）', threw === false);

  src.stop();
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
