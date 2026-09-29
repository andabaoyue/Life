/**
 * src/provider-runtime-trust.js — Provider Runtime Attestation 信任根（v0.9.8 C-01）
 *
 * runtime evidence 铸造权限的唯一居所。受信 provider adapter（如 deepseek.js）
 * 在模块加载期经此获取「绑定 adapter 身份」的铸造器；experiment-metadata 只持有
 * 验证端，其公共 API 不再导出任何铸造途径（__internal 已彻底移除）。
 *
 * 诚实边界：同进程模块边界不是密码学安全边界 —— 本模块收敛的是公共 API 面与
 * 伪造路径（caller/config 不可达），不宣称对同进程恶意代码的密码学防护。
 */

const crypto = require('crypto');

const PROVIDER_RUNTIME_MARKER = Symbol('life.provider.runtime.marker');
const providerRuntimeRegistry = new WeakSet(); // 唯一信任根：对象身份
const providerRuntimeAdapters = new WeakMap(); // attestation 绑定的受信 adapter

/**
 * 创建某个 provider adapter 专属的 runtime evidence 铸造器（受信接线专用）。
 */
function createProviderRuntimeMintAuthority(adapter) {
  const boundAdapter = String(adapter || 'provider_adapter');
  return function mintProviderRuntimeResponse(response, opts = {}) {
    if (!response || typeof response !== 'object') {
      return response;
    }
    const token = opts.token || crypto.randomBytes(16).toString('hex');
    const marker = Object.freeze({
      markerType: 'provider_runtime_evidence',
      adapter: boundAdapter,
      token,
      timestamp: Number.isFinite(opts.now) ? opts.now : Date.now()
    });
    try {
      Object.defineProperty(response, PROVIDER_RUNTIME_MARKER, {
        value: marker,
        enumerable: false,
        configurable: false,
        writable: false
      });
    } catch {}
    providerRuntimeRegistry.add(response);
    providerRuntimeAdapters.set(response, boundAdapter);
    return response;
  };
}

/** WeakSet 对象身份是唯一信任根；可复制的 Symbol marker 不构成信任依据。 */
function isProviderRuntimeResponse(response) {
  if (!response || typeof response !== 'object') return false;
  return providerRuntimeRegistry.has(response);
}

/**
 * runtime evidence 与具体 provider/adapter 绑定校验。
 * C-02: provider 身份缺失（null / 'unavailable'）时严格 fail-closed 返回 false，
 * 杜绝身份缺失时的跨 adapter 渗透。
 */
function providerRuntimeAdapterMatches(response, provider) {
  const attested = providerRuntimeAdapters.get(response);
  if (!attested) return false;
  if (!provider || String(provider).trim().toLowerCase() === 'unavailable') return false;
  return attested.trim().toLowerCase() === String(provider).trim().toLowerCase();
}

module.exports = {
  createProviderRuntimeMintAuthority,
  isProviderRuntimeResponse,
  providerRuntimeAdapterMatches
};
