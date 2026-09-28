/**
 * src/adapters/deepseek-adapter.js — DeepSeek Provider Adapter（v0.9.8 P2-2）
 *
 * 第一个标准 Provider Adapter：把现有 DeepSeek client 轻量包在统一契约后面，
 * 不复制任何网络实现。DeepSeek 既有业务行为（retry/budget/timeout/错误归一化/
 * stream 语义/mint authority）全部由内部 client 保持。
 *
 * Research Integrity 红线：
 * - 本 adapter 不公开、不暴露任何 evidence mint API（mint authority 仍在
 *   experiment-metadata 内部接口按受信 adapter='deepseek' 绑定）；
 * - adapter 不生成与 provider 不匹配的 runtime attestation（binding 由
 *   buildGenerationContext 校验，adapter/provider 不匹配时 fail-closed 降级）；
 * - caller/config metadata 无法经 adapter 升级为 provider runtime fact。
 */

const { DeepSeek } = require('../deepseek');
const {
  validateAdapterContract,
  providerTypeFor,
  assertCapability,
  toUnifiedError
} = require('../provider-adapter');

function createDeepSeekAdapter(cfg = {}) {
  const client = new DeepSeek(cfg); // 轻包装：复用现有实现
  let lastUsage = null;

  const adapter = {
    providerId: 'deepseek',

    /** 连接/能力类型（由端点分类决定，不是品牌） */
    get providerType() { return providerTypeFor(client.cfg && client.cfg.baseURL); },

    /** 透传运行时配置（Brain/Dream 既有访问面），不含任何新增 secret 暴露 */
    get cfg() { return client.cfg; },

    /** adapter 自身配置完整性检查（不替代 provider-policy 的组合准许判定） */
    validateConfig() {
      const problems = [];
      if (!client.cfg || typeof client.cfg.baseURL !== 'string' || !client.cfg.baseURL.trim()) problems.push('baseURL missing');
      if (!client.cfg || typeof client.cfg.model !== 'string' || !client.cfg.model.trim()) problems.push('model missing');
      // 只检查存在性，不读值、不留值
      if (!client.cfg || typeof client.cfg.apiKey !== 'string' || !client.cfg.apiKey.trim()) problems.push('apiKey missing');
      return { ok: problems.length === 0, problems };
    },

    /** 只声明真实实现的能力；vision/tools/jsonMode 未实现 -> false（绝不虚报） */
    capabilities() {
      return {
        streaming: true,
        usage: true,
        systemMessage: true,
        vision: false,
        tools: false,
        jsonMode: false
      };
    },

    async complete(messages, opts = {}) {
      try {
        const res = await client.complete(messages, opts);
        lastUsage = res && res.usage ? res.usage : lastUsage;
        return res;
      } catch (e) {
        throw toUnifiedError(e, 'deepseek');
      }
    },

    async stream(messages, onDelta, opts = {}) {
      // capability fail-closed：未声明支持则调用前拒绝、不发网络请求
      assertCapability(adapter, 'streaming');
      try {
        const res = await client.stream(messages, onDelta, opts);
        lastUsage = res && res.usage ? res.usage : lastUsage;
        return res;
      } catch (e) {
        throw toUnifiedError(e, 'deepseek');
      }
    },

    /** provider-specific error -> 统一错误形态（P1 raw body 边界保持） */
    normalizeError(err) {
      return toUnifiedError(err, 'deepseek');
    },

    /** 统一取得 provider usage（本轮只建立接口；P3 Usage Normalizer 另行） */
    usage() {
      return lastUsage;
    }
    // healthCheck 为可选契约项，本轮不实现
  };

  const contract = validateAdapterContract(adapter);
  if (!contract.ok) {
    throw new Error('DeepSeek adapter contract incomplete: ' + contract.missing.join(','));
  }
  return adapter;
}

module.exports = { createDeepSeekAdapter };
