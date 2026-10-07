/**
 * 延迟写入器（DeferredWriter）
 *
 * 核心机制：脏标记（dirty flag） + 防抖（debounce）。
 * 适用场景：高频状态变更（如位置、记忆、状态统计）避免每次变更都同步刷盘阻塞事件循环，
 * 积攒多次变更后合并为一次原子写，并在进程退出或关键时机支持同步 flush() 强刷。
 */

class DeferredWriter {
  /**
   * @param {() => void} writeFn 实际的同步写盘函数（例如调用 writeJsonAtomic）
   * @param {object} [opts] 配置项
   * @param {number} [opts.delayMs=3000] 防抖延迟毫秒数，默认 3000
   */
  constructor(writeFn, opts = {}) {
    if (typeof writeFn !== 'function') {
      throw new TypeError('writeFn 必须是一个函数');
    }
    const delay = (opts && typeof opts.delayMs === 'number' && opts.delayMs >= 0)
      ? opts.delayMs
      : 3000;

    this._writeFn = writeFn;
    this._delayMs = delay;
    this._dirty = false;
    this._timer = null;
  }

  /**
   * 是否有未落盘的脏数据
   * @returns {boolean}
   */
  get isDirty() {
    return this._dirty;
  }

  /**
   * 标记数据为脏。
   * 如果当前没有待执行的定时器，则启动防抖定时器。
   * 定时器使用 unref()，避免阻止 Node.js 进程退出。
   */
  markDirty() {
    this._dirty = true;
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        if (!this._dirty) {
          return;
        }
        this._dirty = false;
        try {
          this._writeFn();
        } catch (err) {
          this._dirty = true;
          console.error('[DeferredWriter] 延迟写入失败:', err);
        }
      }, this._delayMs);

      if (this._timer && typeof this._timer.unref === 'function') {
        this._timer.unref();
      }
    }
  }

  /**
   * 同步强制写盘。
   * 清除未决的定时器；若处于脏状态则立即写入。
   * 若写入抛出异常，恢复脏标记并重新抛出异常（由调用方处理）。
   */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) {
      return;
    }
    this._dirty = false;
    try {
      this._writeFn();
    } catch (err) {
      this._dirty = true;
      throw err;
    }
  }
}

module.exports = { DeferredWriter };
