/**
 * src/fallback-adapter.js — Provider 容灾自动回落与熔断包装（v1.5-a）
 *
 * 职责：
 * 1. 包装 Primary 与 Secondary Adapter，透明接线既有 CircuitBreaker；
 * 2. 单次调用最多回落一次（maxFallbacksPerCall = 1，绝不跨端点无限循环）；
 * 3. 复用 transport 错误分类的 err.retryable === true 作为唯一回落判据；
 * 4. 显式排除用户主动取消（AbortError / signal.aborted），取消按钮绝不换端点重发；
 * 5. §8.2 流式防重播硬屏障：emitted > 0（已上屏）坚决阻断回落，杜绝半句残影拼接错乱；
 * 6. 未配置备用端点时（secondary === null），退化为纯熔断快速失败保护。
 */

const { createCircuitBreaker } = require('./circuit-breaker');

/**
 * 回落判据（单一真源）
 *
 * @param {Error|object} err 错误对象
 * @param {AbortSignal} [signal] 请求控制信号
 * @returns {boolean} 是否应当触发回落
 */
function shouldFallback(err, signal) {
  if (!err) return false;
  // ① 用户主动取消：绝不回落（防取消按钮演变成切端点重发）
  if (err.name === 'AbortError') return false;
  if (signal && signal.aborted) return false;
  // ② 复用 transport 层的归一化分类，不维护第二套状态码白名单
  return err.retryable === true;
}

/**
 * 构造 Provider Fallback Adapter 包装层
 *
 * @param {object} params
 * @param {object} params.primary 主 adapter
 * @param {object|null} [params.secondary] 备用 adapter（null = 未配置）
 * @param {object} [params.breaker] CircuitBreaker 实例
 * @param {(info: object) => void} [params.onFallback] 遥测回调
 * @param {number} [params.maxFallbacksPerCall=1] 单次请求最大回落次数（固定为 1）
 * @returns {object} 符合 REQUIRED_ADAPTER_METHODS 的 Adapter 实例
 */
function createFallbackAdapter({
  primary,
  secondary = null,
  breaker = null,
  onFallback = null,
  maxFallbacksPerCall = 1
} = {}) {
  if (!primary) {
    throw new Error('PRIMARY_ADAPTER_REQUIRED');
  }

  const activeBreaker = breaker || createCircuitBreaker();
  let lastUsage = null;

  async function doFallbackComplete(cause, msgs, opts) {
    try {
      const r = await secondary.complete(msgs, opts);
      if (r && r.usage) lastUsage = r.usage;
      if (typeof onFallback === 'function') {
        onFallback({
          reason: cause ? (cause.errorType || 'server_error') : 'breaker_open',
          primaryFailed: Boolean(cause),
          at: Date.now()
        });
      }
      return r;
    } catch (fallbackErr) {
      const e = new Error('PRIMARY_AND_FALLBACK_FAILED');
      e.code = 'PRIMARY_AND_FALLBACK_FAILED';
      e.primaryError = cause || null;
      e.fallbackError = fallbackErr;
      throw e;
    }
  }

  async function doFallbackStream(cause, msgs, onDelta, opts) {
    try {
      const r = await secondary.stream(msgs, onDelta, opts);
      if (r && r.usage) lastUsage = r.usage;
      if (typeof onFallback === 'function') {
        onFallback({
          reason: cause ? (cause.errorType || 'server_error') : 'breaker_open',
          primaryFailed: Boolean(cause),
          at: Date.now()
        });
      }
      return r;
    } catch (fallbackErr) {
      const e = new Error('PRIMARY_AND_FALLBACK_FAILED');
      e.code = 'PRIMARY_AND_FALLBACK_FAILED';
      e.primaryError = cause || null;
      e.fallbackError = fallbackErr;
      throw e;
    }
  }

  const adapter = {
    get providerId() { return primary.providerId; },
    get providerType() { return primary.providerType; },
    get cfg() { return primary.cfg; },
    get primary() { return primary; },
    get secondary() { return secondary; },
    get breaker() { return activeBreaker; },

    validateConfig() {
      return typeof primary.validateConfig === 'function'
        ? primary.validateConfig()
        : { ok: true, problems: [] };
    },

    capabilities() {
      return typeof primary.capabilities === 'function'
        ? primary.capabilities()
        : {};
    },

    normalizeError(err) {
      return typeof primary.normalizeError === 'function'
        ? primary.normalizeError(err)
        : err;
    },

    usage() {
      return lastUsage !== null
        ? lastUsage
        : (typeof primary.usage === 'function' ? primary.usage() : null);
    },

    async complete(msgs, opts = {}) {
      // 未配置备用：退化为纯熔断保护（快速失败，不改变既有单端点行为）
      if (!secondary) {
        if (!activeBreaker.allowAttempt()) {
          const err = new Error('CIRCUIT_BREAKER_OPEN');
          err.code = 'CIRCUIT_BREAKER_OPEN';
          throw err;
        }
        try {
          const r = await primary.complete(msgs, opts);
          activeBreaker.recordSuccess();
          if (r && r.usage) lastUsage = r.usage;
          return r;
        } catch (e) {
          if (shouldFallback(e, opts && opts.signal)) {
            activeBreaker.recordFailure();
          }
          throw e;
        }
      }

      // 主端点处于放行或半开探测状态
      if (activeBreaker.allowAttempt()) {
        try {
          const r = await primary.complete(msgs, opts);
          activeBreaker.recordSuccess();
          if (r && r.usage) lastUsage = r.usage;
          return r;
        } catch (err) {
          if (!shouldFallback(err, opts && opts.signal)) {
            throw err;
          }
          activeBreaker.recordFailure();
          return await doFallbackComplete(err, msgs, opts);
        }
      }

      // 主端点熔断中（open）：直接走备用端点
      return await doFallbackComplete(null, msgs, opts);
    },

    async stream(msgs, onDelta, opts = {}) {
      let emitted = 0;
      const countingDelta = (d) => {
        emitted++;
        if (typeof onDelta === 'function') onDelta(d);
      };

      // 未配置备用：退化为纯熔断保护
      if (!secondary) {
        if (!activeBreaker.allowAttempt()) {
          const err = new Error('CIRCUIT_BREAKER_OPEN');
          err.code = 'CIRCUIT_BREAKER_OPEN';
          throw err;
        }
        try {
          const r = await primary.stream(msgs, countingDelta, opts);
          activeBreaker.recordSuccess();
          if (r && r.usage) lastUsage = r.usage;
          return r;
        } catch (e) {
          if (shouldFallback(e, opts && opts.signal)) {
            activeBreaker.recordFailure();
          }
          throw e;
        }
      }

      // 主端点处于放行或半开探测状态
      if (activeBreaker.allowAttempt()) {
        try {
          const r = await primary.stream(msgs, countingDelta, opts);
          activeBreaker.recordSuccess();
          if (r && r.usage) lastUsage = r.usage;
          return r;
        } catch (err) {
          if (shouldFallback(err, opts && opts.signal)) {
            activeBreaker.recordFailure();
          }
          // §8.2 核心守则：
          // 若已吐出至少一个 chunk（emitted > 0），已在用户屏幕渲染，
          // 坚决阻断回落并如实抛错，杜绝气泡发生首尾重复拼接错乱。
          if (emitted > 0) {
            throw err;
          }
          if (!shouldFallback(err, opts && opts.signal)) {
            throw err;
          }
          return await doFallbackStream(err, msgs, onDelta, opts);
        }
      }

      // 主端点熔断中（open）：直接走备用端点
      return await doFallbackStream(null, msgs, onDelta, opts);
    }
  };

  return adapter;
}

module.exports = {
  createFallbackAdapter,
  shouldFallback
};
