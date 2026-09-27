/**
 * src/experiment-metadata.js
 *
 * 《生物科学与数字生命的哲学范畴》
 * 实验条件元数据与生成产物绑定机制 (P0-1 / P1-1)
 *
 * 核心科学与工程准则：
 * 1. 实验条件绑定（Generation Context Binding）：
 *    将“生成产物 ↔ 实验条件”记录在归档与账本中，回答：
 *    “该小结/成长条目/经历是在什么模型、什么 Prompt 模板指纹、什么采样条件下生成的？”
 * 2. 缓存纯净与前缀保护（Prefix Cache Purity）：
 *    元数据仅写入实验记录（experiences.jsonl / self-ledger / window metadata），
 *    绝不拼入 system prompt、persona、wardrobe 或 stable memory block，
 *    确保 DeepSeek KV 稳定前缀缓存完全不受动态元数据变化的影响。
 * 3. 历史不可篡改与真实性（No Fabrication）：
 *    旧数据缺失元数据时，显式标记为 unavailable / NOT_RECORDED，
 *    严禁用当前模型/配置信息伪造填补历史缺失数据。
 * 4. 纯代数计算与确定性（Pure Computation）：
 *    零 API 成本、无网络、无外部状态突变。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const { providerFor } = require('./provider-policy');

const META_SCHEMA_VERSION = 1;
const UNAVAILABLE = 'unavailable';
const NOT_RECORDED = 'NOT_RECORDED';

/**
 * 确定性解析当前 Git Commit SHA。
 * 优先级：显式入参 > 环境变量 LIFE_GIT_COMMIT > .git/HEAD 本地解析 > 'unknown'
 */
function resolveGitCommit(explicitCommit) {
  if (typeof explicitCommit === 'string' && explicitCommit.trim()) {
    return explicitCommit.trim().slice(0, 40);
  }
  if (process.env.LIFE_GIT_COMMIT && typeof process.env.LIFE_GIT_COMMIT === 'string') {
    return process.env.LIFE_GIT_COMMIT.trim().slice(0, 40);
  }
  try {
    const gitDir = path.join(__dirname, '..', '.git');
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) return 'unknown';
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refSubPath = head.slice(5).trim();
      const refPath = path.join(gitDir, refSubPath);
      if (fs.existsSync(refPath)) {
        return fs.readFileSync(refPath, 'utf8').trim().slice(0, 40);
      }
      const packedRefsPath = path.join(gitDir, 'packed-refs');
      if (fs.existsSync(packedRefsPath)) {
        const lines = fs.readFileSync(packedRefsPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('^') && trimmed.endsWith(refSubPath)) {
            const parts = trimmed.split(' ');
            if (parts.length >= 2) return parts[0].slice(0, 40);
          }
        }
      }
    } else if (head.length >= 7) {
      return head.slice(0, 40);
    }
  } catch (err) {
    // 容错降级
  }
  return 'unknown';
}

/**
 * 递归深冻结对象，确保所有嵌套字段不可篡改
 */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * 计算 Prompt 模板文本的确定性 SHA-256 哈希指纹。
 * 格式：sha256:<64位十六进制>
 */
function hashPrompt(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/**
 * 收集当前生效的核心 Prompt 模板指纹集合。
 * texts: { summary, growth, merge, persona, creativeSkill }
 */
function collectPromptHashes(texts = {}) {
  const personaText = typeof texts.persona === 'string' ? texts.persona.trim() : '';
  const hashes = {
    summary: hashPrompt(texts.summary || ''),
    growth: hashPrompt(texts.growth || ''),
    merge: hashPrompt(texts.merge || ''),
    persona: personaText.length > 0 ? hashPrompt(personaText) : UNAVAILABLE,
    creativeSkill: (texts.creativeSkill && typeof texts.creativeSkill === 'string' && texts.creativeSkill.trim())
      ? hashPrompt(texts.creativeSkill.trim())
      : 'not_enabled'
  };
  if (texts.dream && typeof texts.dream === 'string' && texts.dream.trim()) {
    const d = texts.dream.trim();
    hashes.dream = d.startsWith('sha256:') ? d : hashPrompt(d);
  }
  return hashes;
}

/**
 * 构造标准 GenerationContext 对象（生成产物实验条件元数据）。
 *
 * @param {Object} opts
 * @param {string} opts.kind 生成类型 ('summary' | 'growth' | 'merge' | 'dream' | 'self_projection_compute' 等)
 * @param {Object} [opts.cfg] 运行配置 (model, baseURL, provider, experimentMode, experimentModules 等)
 * @param {Object} [opts.promptHashes] Prompt 哈希集合
 * @param {Object} [opts.sampling] 采样参数 { temperature, maxTokens }
 * @param {number} [opts.sourceWindowNo] 来源窗口号
 * @param {Object} [opts.sourceMessageRange] 来源消息范围 { firstMessageId, lastMessageId, messageCount }
 * @param {string} [opts.gitCommit] 显式 Git Commit
 * @param {string} [opts.lifeVersion] 显式版本号
 * @param {number} [opts.generatedAt] 生成时间戳
 * @returns {Readonly<Object>}
 */
function buildGenerationContext(opts = {}) {
  const cfg = opts.cfg || {};
  let provider = UNAVAILABLE;
  if (typeof cfg.provider === 'string' && cfg.provider.trim()) {
    provider = cfg.provider.trim();
  } else if (cfg.baseURL) {
    provider = providerFor(cfg.baseURL) || UNAVAILABLE;
  }

  const sampling = (opts.sampling && typeof opts.sampling === 'object')
    ? {
        temperature: Number.isFinite(opts.sampling.temperature) ? opts.sampling.temperature : null,
        maxTokens: Number.isFinite(opts.sampling.maxTokens) ? opts.sampling.maxTokens : null
      }
    : null;

  const range = (opts.sourceMessageRange && typeof opts.sourceMessageRange === 'object')
    ? {
        firstMessageId: opts.sourceMessageRange.firstMessageId != null
          ? String(opts.sourceMessageRange.firstMessageId)
          : (opts.sourceMessageRange.startId != null ? String(opts.sourceMessageRange.startId) : UNAVAILABLE),
        lastMessageId: opts.sourceMessageRange.lastMessageId != null
          ? String(opts.sourceMessageRange.lastMessageId)
          : (opts.sourceMessageRange.endId != null ? String(opts.sourceMessageRange.endId) : UNAVAILABLE),
        messageCount: Number.isInteger(opts.sourceMessageRange.messageCount)
          ? opts.sourceMessageRange.messageCount
          : (Number.isInteger(opts.sourceMessageRange.count) ? opts.sourceMessageRange.count : null)
      }
    : null;

  const observedModel = (typeof opts.observedModel === 'string' && opts.observedModel.trim())
    ? opts.observedModel.trim()
    : ((cfg && typeof cfg.observedModel === 'string' && cfg.observedModel.trim()) ? cfg.observedModel.trim() : UNAVAILABLE);
  const modelVersion = (typeof opts.modelVersion === 'string' && opts.modelVersion.trim())
    ? opts.modelVersion.trim()
    : ((cfg && typeof cfg.modelVersion === 'string' && cfg.modelVersion.trim()) ? cfg.modelVersion.trim() : UNAVAILABLE);

  const ctx = {
    metaSchemaVersion: META_SCHEMA_VERSION,
    kind: String(opts.kind || 'unknown'),
    generatedAt: Number.isFinite(opts.generatedAt) ? opts.generatedAt : Date.now(),
    lifeVersion: String(opts.lifeVersion || (pkg && pkg.version) || UNAVAILABLE),
    gitCommit: String(opts.gitCommit || resolveGitCommit()),
    provider: String(provider || UNAVAILABLE),
    modelName: String(cfg.model || UNAVAILABLE),
    modelVersion: String(modelVersion || UNAVAILABLE),
    observedModel: String(observedModel || UNAVAILABLE),
    endpoint: String(cfg.baseURL || UNAVAILABLE),
    sampling,
    promptHashes: (opts.promptHashes && typeof opts.promptHashes === 'object')
      ? { ...opts.promptHashes }
      : {},
    experimentMode: String(cfg.experimentMode || 'baseline'),
    modules: (opts.modules && typeof opts.modules === 'object')
      ? { ...opts.modules }
      : ((cfg.experimentModules && typeof cfg.experimentModules === 'object') ? { ...cfg.experimentModules } : null),
    sourceWindowNo: Number.isInteger(opts.sourceWindowNo) ? opts.sourceWindowNo : null,
    sourceMessageRange: range,
    generator: String(opts.generator || 'pure-computation-or-llm')
  };

  return deepFreeze(ctx);
}

/**
 * 从归档记录或对象中提取 GenerationContext。
 * 若无元数据（旧数据），严格返回 available: false 与 reason: NOT_RECORDED，
 * 绝不用当前环境信息伪造历史信息。
 */
function getGenerationContext(recordOrPayload) {
  const p = (recordOrPayload && recordOrPayload.payload) ? recordOrPayload.payload : recordOrPayload;
  const ctx = p && p.generationContext;
  if (ctx && typeof ctx === 'object' && typeof ctx.metaSchemaVersion === 'number') {
    return { available: true, ...ctx };
  }
  return {
    available: false,
    metaSchemaVersion: null,
    kind: UNAVAILABLE,
    generatedAt: null,
    lifeVersion: UNAVAILABLE,
    gitCommit: UNAVAILABLE,
    provider: UNAVAILABLE,
    modelName: UNAVAILABLE,
    modelVersion: UNAVAILABLE,
    observedModel: UNAVAILABLE,
    endpoint: UNAVAILABLE,
    sampling: null,
    promptHashes: null,
    experimentMode: UNAVAILABLE,
    modules: null,
    sourceWindowNo: null,
    sourceMessageRange: null,
    generator: UNAVAILABLE,
    reason: NOT_RECORDED
  };
}

/**
 * 校验 generationContext 结构的有效性（供 ArchiveIntegrity 等服务使用）。
 * 遵循强契约校验规范：
 * - 空值（null/undefined）视为缺失但合法（兼容旧数据）
 * - 顶层字段与嵌套类型均需满足强契约
 */
function validateGenerationContext(ctx) {
  if (ctx === undefined || ctx === null) return { valid: true, present: false };
  if (typeof ctx !== 'object' || Array.isArray(ctx)) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_MUST_BE_OBJECT' };
  }
  if (typeof ctx.metaSchemaVersion !== 'number' || ctx.metaSchemaVersion < 1) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_MISSING_SCHEMA_VERSION' };
  }
  if (typeof ctx.kind !== 'string' || !ctx.kind.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_KIND' };
  }
  if (typeof ctx.generatedAt !== 'number' || !Number.isFinite(ctx.generatedAt) || ctx.generatedAt <= 0) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_GENERATED_AT' };
  }
  if (typeof ctx.lifeVersion !== 'string' || !ctx.lifeVersion.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_LIFE_VERSION' };
  }
  if (typeof ctx.gitCommit !== 'string' || !ctx.gitCommit.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_GIT_COMMIT' };
  }
  if (typeof ctx.provider !== 'string' || !ctx.provider.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_PROVIDER' };
  }
  if (typeof ctx.modelName !== 'string' || !ctx.modelName.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_MODEL_NAME' };
  }
  if (typeof ctx.modelVersion !== 'string' || !ctx.modelVersion.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_MODEL_VERSION' };
  }
  if (ctx.observedModel !== undefined && typeof ctx.observedModel !== 'string') {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_OBSERVED_MODEL' };
  }
  if (typeof ctx.endpoint !== 'string' || !ctx.endpoint.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_ENDPOINT' };
  }
  if (ctx.sampling !== null && ctx.sampling !== undefined) {
    if (typeof ctx.sampling !== 'object' || Array.isArray(ctx.sampling)) {
      return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SAMPLING' };
    }
    if (ctx.sampling.temperature !== null && ctx.sampling.temperature !== undefined && typeof ctx.sampling.temperature !== 'number') {
      return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SAMPLING_TEMPERATURE' };
    }
    if (ctx.sampling.maxTokens !== null && ctx.sampling.maxTokens !== undefined && !Number.isInteger(ctx.sampling.maxTokens)) {
      return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SAMPLING_MAX_TOKENS' };
    }
  }
  if (!ctx.promptHashes || typeof ctx.promptHashes !== 'object' || Array.isArray(ctx.promptHashes)) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_PROMPT_HASHES' };
  }
  for (const [k, v] of Object.entries(ctx.promptHashes)) {
    if (typeof v !== 'string' || !v.trim()) {
      return { valid: false, present: true, reason: `GENERATION_CONTEXT_INVALID_PROMPT_HASH_${k.toUpperCase()}` };
    }
  }
  if (typeof ctx.experimentMode !== 'string' || !ctx.experimentMode.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_EXPERIMENT_MODE' };
  }
  if (ctx.modules !== null && ctx.modules !== undefined && (typeof ctx.modules !== 'object' || Array.isArray(ctx.modules))) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_MODULES' };
  }
  if (ctx.sourceWindowNo !== null && ctx.sourceWindowNo !== undefined && !Number.isInteger(ctx.sourceWindowNo)) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SOURCE_WINDOW_NO' };
  }
  if (ctx.sourceMessageRange !== null && ctx.sourceMessageRange !== undefined) {
    if (typeof ctx.sourceMessageRange !== 'object' || Array.isArray(ctx.sourceMessageRange)) {
      return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SOURCE_MESSAGE_RANGE' };
    }
    const r = ctx.sourceMessageRange;
    if (r.firstMessageId !== null && r.firstMessageId !== undefined && typeof r.firstMessageId !== 'string') {
      return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SOURCE_MESSAGE_FIRST_ID' };
    }
    if (r.lastMessageId !== null && r.lastMessageId !== undefined && typeof r.lastMessageId !== 'string') {
      return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SOURCE_MESSAGE_LAST_ID' };
    }
    if (r.messageCount !== null && r.messageCount !== undefined && !Number.isInteger(r.messageCount)) {
      return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_SOURCE_MESSAGE_COUNT' };
    }
  }
  if (typeof ctx.generator !== 'string' || !ctx.generator.trim()) {
    return { valid: false, present: true, reason: 'GENERATION_CONTEXT_INVALID_GENERATOR' };
  }
  return { valid: true, present: true };
}

module.exports = {
  META_SCHEMA_VERSION,
  UNAVAILABLE,
  NOT_RECORDED,
  deepFreeze,
  resolveGitCommit,
  hashPrompt,
  collectPromptHashes,
  buildGenerationContext,
  getGenerationContext,
  validateGenerationContext
};
