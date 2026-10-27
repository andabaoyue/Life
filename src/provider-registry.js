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
  // 🔴 2026-10-20 更正：此前的 `vision: false` 是**过期信息**。
  //   实测（真实 Key + deepseek-flash）：带 image_url 的请求返回 200，
  //   发 1×1 红色 PNG 问颜色，回复「粉色」，prompt_tokens 223（纯文本仅几十）。
  //   官方文档确认 deepseek-flash 支持 JPEG/PNG/GIF/WebP。
  //
  //   ⚠️ 但**不是所有 DeepSeek 模型都支持**：deepseek-v4-pro 仍为纯文本（发图 400）。
  //   所以这里标 true 只表示"该 provider 存在支持 vision 的模型"，
  //   具体能不能用图片，必须再经 `modelSupportsVision(cfg.model)` 逐模型判定。
  capabilities: { streaming: true, usage: true, systemMessage: true, vision: true, tools: false, jsonMode: false },
  credentialPolicy: 'deepseek-api-key',
  display: { name: 'DeepSeek', note: 'UI display metadata only — not research truth' }
});

// v0.9.8 P5-A1: generic OpenAI-compatible 注册项（架构验证用，不接真实第三方服务）。
// 硬性事实边界：协议兼容 ≠ Provider 语义相同 ≠ Cache 规则相同 ≠ 价格相同 ——
// 故 generic/local/custom 的 pricingPolicy/cachePolicy 明确为 null（绝不继承 DeepSeek 语义）。
const { createOpenAICompatibleAdapter } = require('./adapters/openai-compatible-adapter');
// 'invalid' = providerFor() 的端点解析失败分类（如无 baseURL 的 headless/测试构造）——
// 注册它以保持既有 Brain 构造语义（网络调用仍在 policy/transport 门禁处 fail-closed）；
// 真正未知的 provider id 依旧拒绝（UnknownProviderError）。
for (const genericId of ['generic', 'local', 'custom', 'invalid']) {
  registerProvider({
    providerId: genericId,
    providerType: genericId === 'local' ? 'local' : (genericId === 'custom' || genericId === 'invalid' ? 'custom' : 'openai-compatible'),
    adapterFactory: (cfg) => createOpenAICompatibleAdapter(cfg, { providerId: genericId }),
    capabilities: { streaming: true, usage: true, systemMessage: true, vision: false, tools: false, jsonMode: false },
    credentialPolicy: 'apiKey',
    display: { name: genericId, note: 'UI display metadata only — not research truth' },
    pricingPolicy: null,
    cachePolicy: null
  });
}

module.exports = { registerProvider, createAdapter, getProviderInfo, listProviders, PROVIDER_TYPES };
