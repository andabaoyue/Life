/**
 * src/power-monitor-source.js
 *
 * Life v1.3 宿主电源与环境事件源 (PowerMonitorSource)
 *
 * 核心机制与工程防线：
 * 1. 宿主物理事件抽象：
 *    监听 Electron powerMonitor 的系统级状态变化（suspend/resume/lock-screen/unlock-screen），
 *    转换为数字环周（Digital Umwelt）的定性感知刺激输入（category + rawIntensity）。
 * 2. 依赖注入与测试解耦：
 *    支持构造时注入 mock powerMonitor 实例；在纯 Node 单测环境中零崩溃、零硬依赖。
 * 3. 订阅生命周期对称性：
 *    提供对称的 start() 与 stop() 接口，严格管理事件监听器，避免在热重载或重连时内存泄漏。
 */

'use strict';

// 事件到感知刺激的规范映射表
const POWER_EVENT_MAP = Object.freeze({
  'suspend': { category: 'host_suspend', rawIntensity: 70 },
  'resume': { category: 'host_resume', rawIntensity: 60 },
  'lock-screen': { category: 'host_lock', rawIntensity: 55 },
  'unlock-screen': { category: 'host_unlock', rawIntensity: 65 }
});

class PowerMonitorSource {
  /**
   * @param {Object} [opts={}]
   * @param {Object} [opts.powerMonitor] 显式注入的 powerMonitor 实例（测试或生产），未传则尝试自动加载
   */
  constructor(opts = {}) {
    if (opts.powerMonitor !== undefined) {
      this._pm = opts.powerMonitor;
    } else {
      try {
        const electron = require('electron');
        this._pm = electron && electron.powerMonitor ? electron.powerMonitor : null;
      } catch (_) {
        this._pm = null;
      }
    }
    this._listeners = new Map();
    this._active = false;
  }

  get isAvailable() {
    return this._pm !== null && typeof this._pm.on === 'function';
  }

  get isActive() {
    return this._active;
  }

  /**
   * 启动电源与屏幕事件监听
   * @param {Function} onEvent 事件回调 (stimulus: { category, rawIntensity, timestamp, eventName }) => void
   */
  start(onEvent) {
    if (this._active) {
      this.stop();
    }
    if (!this.isAvailable || typeof onEvent !== 'function') {
      return false;
    }

    for (const [eventName, mapping] of Object.entries(POWER_EVENT_MAP)) {
      const listener = () => {
        try {
          onEvent({
            category: mapping.category,
            rawIntensity: mapping.rawIntensity,
            timestamp: Date.now(),
            eventName
          });
        } catch (err) {
          console.warn(`[PowerMonitorSource] 事件分发异常 (${eventName}):`, err && err.message);
        }
      };

      this._pm.on(eventName, listener);
      this._listeners.set(eventName, listener);
    }

    this._active = true;
    return true;
  }

  /**
   * 停止监听并注销全部事件，保持对称与纯净
   */
  stop() {
    if (!this._pm || !this._listeners.size) {
      this._active = false;
      return;
    }

    for (const [eventName, listener] of this._listeners.entries()) {
      try {
        if (typeof this._pm.removeListener === 'function') {
          this._pm.removeListener(eventName, listener);
        } else if (typeof this._pm.off === 'function') {
          this._pm.off(eventName, listener);
        }
      } catch (_) {}
    }

    this._listeners.clear();
    this._active = false;
  }
}

module.exports = {
  POWER_EVENT_MAP,
  PowerMonitorSource
};
