/**
 * src/provider-registry.js — 最小 Provider Registry（v0.9.8 P2-3/P2-4/P2-5）
 *
 * 职责：provider id → adapter factory → adapter instance。
 * 仅登记：stable provider id / provider type / adapter factory / capabilities 声明 /
 * credential policy 引用 / display metadata（可预留 pricing/cache policy 扩展点，P3 才实现）。
 *
 * 红线：
 * - 不保存 secret / API key / Authorization（factory 在创建时才收到 cfg）；
 * - 不是 runtime evidence 信任根（mint authority 在 experiment-metadata 内部接口）；
 * - display metadata 只服务 UI，不可作为 research truth。
 */

const { PROVIDER_TYPES } = require('./provider-adapter');
const { createDeepSeekAdapter } = require('./adapters/deepseek-adapter');

const ENTRIES = new Map();

function registerProvider(entry) {
  const {
    providerId,
    providerType,
    adapterFactory,
    capabilities = null,
    credentialPolicy = null,
    display = null,
    pricingPolicy = null, // P3 扩展点，本轮仅占位
    cachePolicy = null,   // P3 扩展点，本轮仅占位
    override = false      // F-01: 重复 ID 必须显式 override，禁止静默覆盖
  } = entry || {};
  if (typeof providerId !== 'string' || !providerId.trim()) {
    throw new Error('PROVIDER_ID_REQUIRED');
  }
  if (typeof adapterFactory !== 'function') {
    throw new Error('ADAPTER_FACTORY_REQUIRED');
  }
  if (providerType && !PROVIDER_TYPES.includes(providerType)) {
    throw new Error('UNKNOWN_PROVIDER_TYPE: ' + providerType);
  }
  // F-01: 重复 providerId 静默覆盖会悄悄换掉既有 adapter factory —— 显式拦截
  if (ENTRIES.has(providerId.trim()) && !override) {
    throw new Error('PROVIDER_ID_ALREADY_REGISTERED: ' + providerId.trim());
  }
  ENTRIES.set(providerId.trim(), Object.freeze({
    providerId: providerId.trim(),
    providerType: providerType || 'custom',
    adapterFactory, // 不是可枚举数据，不会进入 JSON 序列化面
    capabilities: capabilities ? Object.freeze({ ...capabilities }) : null,
    credentialPolicy: credentialPolicy || null,
    display: display ? Object.freeze({ ...display }) : null,
    pricingPolicy: pricingPolicy || null,
    cachePolicy: cachePolicy || null
  }));
}

function createAdapter(providerId, cfg) {
  const info = ENTRIES.get(String(providerId));
  if (!info) {
    const err = new Error('UNKNOWN_PROVIDER: ' + providerId);
    err.name = 'UnknownProviderError';
    throw err;
  }
  return info.adapterFactory(cfg);
}

function getProviderInfo(providerId) {
  return ENTRIES.get(String(providerId)) || null;
}

function listProviders() {
  return [...ENTRIES.keys()];
}

// 预注册 DeepSeek（stable provider id；其 adapter 为 OpenAI-compatible 线协议实现，
// 亦服务 local/custom 端点。后续新 provider 各自注册自己的 adapter factory）。
registerProvider({
  providerId: 'deepseek',
  providerType: 'cloud-direct',
  adapterFactory: createDeepSeekAdapter,
  capabilities: { streaming: true, usage: true, systemMessage: true, vision: false, tools: false, jsonMode: false },
  credentialPolicy: 'deepseek-api-key',
  display: { name: 'DeepSeek', note: 'UI display metadata only — not research truth' }
});

module.exports = { registerProvider, createAdapter, getProviderInfo, listProviders, PROVIDER_TYPES };
