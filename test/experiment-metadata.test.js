/**
 * test/experiment-metadata.test.js
 *
 * 《生物科学与数字生命的哲学范畴》
 * 实验条件元数据与生成产物绑定机制专项测试集 (P0-1 / P1-1)
 *
 * 测试点：
 * 1. hashPrompt 与 collectPromptHashes 确定性与正确性
 * 2. buildGenerationContext 字段契约、冷冻性与默认安全回落
 * 3. buildGenerationContext 支持 startId/endId 别名容错
 * 4. validateGenerationContext 强契约校验（合法通过、缺失/非对象拦截）
 * 5. getGenerationContext 从记录中提取元数据
 * 6. 历史真实性铁律（No Fabrication）：旧记录缺失元数据时返回 NOT_RECORDED，绝不虚构补填
 * 7. resolveGitCommit 确定性解析与安全降级
 * 8. DeepSeek 前缀缓存不变式：Memory 系统前缀 (systemText) 绝对不因 generationContext 改变而产生单字节差异
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/memory');

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 1 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});
const {
  META_SCHEMA_VERSION,
  buildGenerationContext,
  getGenerationContext,
  validateGenerationContext,
  hashPrompt,
  collectPromptHashes,
  resolveGitCommit
} = require('../src/experiment-metadata');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 1. hashPrompt 与 collectPromptHashes 确定性
{
  const h1 = hashPrompt('你好，初澜');
  const h2 = hashPrompt('你好，初澜');
  const h3 = hashPrompt('你好，初澜！');
  check('hashPrompt 相同输入哈希一致', h1 === h2 && h1.startsWith('sha256:'));
  check('hashPrompt 不同输入哈希相异', h1 !== h3);

  const hashes = collectPromptHashes({
    summary: '总结模板',
    growth: '成长模板',
    merge: '合并模板',
    persona: '人设模板',
    creativeSkill: null
  });
  check('collectPromptHashes 包含所有必需 Prompt 指纹',
    hashes.summary.startsWith('sha256:') &&
    hashes.growth.startsWith('sha256:') &&
    hashes.merge.startsWith('sha256:') &&
    hashes.persona.startsWith('sha256:') &&
    hashes.creativeSkill === 'not_enabled'
  );

  const hashesWithSkill = collectPromptHashes({
    persona: '人设模板',
    creativeSkill: 'DS 写作技能完整正文'
  });
  // v0.9.9: 旧 Creative Mode / DS Skill 已永久停用 —— 即使输入携带 creativeSkill 文本，
  // 也固定返回 'not_enabled'（不再读取、不再计算哈希；键保留维持 GenerationContext 形状）
  check('collectPromptHashes creativeSkill 固定 not_enabled（已永久停用，不再计算哈希）',
    hashesWithSkill.creativeSkill === 'not_enabled'
  );

  const hashesUnavailable = collectPromptHashes({ persona: '' });
  check('collectPromptHashes 缺失 persona 时标为 unavailable 而非虚假通过',
    hashesUnavailable.persona === 'unavailable'
  );
}

// 2. buildGenerationContext 字段契约、observedModel 与深度冷冻性
{
  const ctx = buildGenerationContext({
    kind: 'summary',
    cfg: {
      model: 'deepseek-chat',
      modelVersion: 'v3',
      baseURL: 'https://api.deepseek.com',
      experimentMode: 'experimental',
      experimentModules: { memoryDynamics: true }
    },
    observedModel: 'deepseek-chat-202409',
    promptHashes: { summary: hashPrompt('test') },
    sampling: { temperature: 0.2, maxTokens: 900 },
    sourceWindowNo: 1,
    sourceMessageRange: { firstMessageId: 'm-001', lastMessageId: 'm-020', messageCount: 20 },
    generator: 'llm'
  });

  check('buildGenerationContext 包含指定 schemaVersion', ctx.metaSchemaVersion === META_SCHEMA_VERSION);
  check('buildGenerationContext 包含生成类型', ctx.kind === 'summary');
  check('buildGenerationContext 模型与端点正确绑定', ctx.modelName === 'deepseek-chat' && ctx.endpoint === 'https://api.deepseek.com');
  check('buildGenerationContext observedModel 真实捕获', ctx.observedModel === 'deepseek-chat-202409');
  check('buildGenerationContext 采样参数绑定', ctx.sampling.temperature === 0.2 && ctx.sampling.maxTokens === 900);
  check('buildGenerationContext 来源消息范围绑定', ctx.sourceMessageRange.firstMessageId === 'm-001' && ctx.sourceMessageRange.messageCount === 20);
  check('buildGenerationContext 顶层对象冻结不可篡改', Object.isFrozen(ctx));
  check('buildGenerationContext 嵌套 sampling 对象深冻结', Object.isFrozen(ctx.sampling));
  check('buildGenerationContext 嵌套 promptHashes 对象深冻结', Object.isFrozen(ctx.promptHashes));
  check('buildGenerationContext 嵌套 sourceMessageRange 对象深冻结', Object.isFrozen(ctx.sourceMessageRange));
  check('buildGenerationContext 嵌套 modules 对象深冻结', Object.isFrozen(ctx.modules));

  let tamperFailed = false;
  try {
    ctx.sampling.temperature = 0.99;
  } catch {
    tamperFailed = true;
  }
  check('严格模式下试图篡改嵌套 sampling 抛出异常', tamperFailed || ctx.sampling.temperature === 0.2);
}

// 3. buildGenerationContext 支持 startId/endId 别名
{
  const ctx = buildGenerationContext({
    kind: 'growth',
    sourceMessageRange: { startId: 'm-010', endId: 'm-030', count: 21 }
  });
  check('buildGenerationContext 支持 startId/endId/count 别名',
    ctx.sourceMessageRange.firstMessageId === 'm-010' &&
    ctx.sourceMessageRange.lastMessageId === 'm-030' &&
    ctx.sourceMessageRange.messageCount === 21
  );
}

// 4. validateGenerationContext 强契约校验
{
  const validCtx = buildGenerationContext({ kind: 'merge' });
  const v1 = validateGenerationContext(validCtx);
  check('validateGenerationContext 合法对象校验通过', v1.valid === true && v1.present === true);

  const v2 = validateGenerationContext('not-an-object');
  check('validateGenerationContext 非法对象拦截', v2.valid === false && v2.reason === 'GENERATION_CONTEXT_MUST_BE_OBJECT');

  const v3 = validateGenerationContext({ kind: 'summary' }); // 缺失 metaSchemaVersion
  check('validateGenerationContext 缺失 schemaVersion 拦截', v3.valid === false && v3.reason === 'GENERATION_CONTEXT_MISSING_SCHEMA_VERSION');

  const v4 = validateGenerationContext(null); // 可选兼容：null/undefined 允许但 present: false
  check('validateGenerationContext 允许空值兼容旧记录', v4.valid === true && v4.present === false);

  const baseCtx = buildGenerationContext({ kind: 'summary' });
  const v5 = validateGenerationContext({
    ...baseCtx,
    sampling: 'invalid-string'
  });
  check('validateGenerationContext 拦截非法 sampling', v5.valid === false && v5.reason === 'GENERATION_CONTEXT_INVALID_SAMPLING');

  const v6 = validateGenerationContext({
    ...baseCtx,
    promptHashes: 'invalid-string'
  });
  check('validateGenerationContext 拦截非法 promptHashes', v6.valid === false && v6.reason === 'GENERATION_CONTEXT_INVALID_PROMPT_HASHES');
}

// 5. getGenerationContext 提取
{
  const dummyCtx = buildGenerationContext({ kind: 'dream' });
  const recordWithCtx = { recordType: 'subject_dream', payload: { generationContext: dummyCtx } };
  const res = getGenerationContext(recordWithCtx);
  check('getGenerationContext 成功从记录中提取', res.available === true && res.kind === 'dream');
}

// 6. 历史真实性铁律：旧记录缺失元数据时返回 NOT_RECORDED，绝不伪造
{
  const legacyRecord = { recordType: 'window_summary', payload: { rawSummaryText: '旧版小结' } };
  const res = getGenerationContext(legacyRecord);
  check('旧记录无元数据时返回 available: false', res.available === false);
  check('旧记录明确标注 NOT_RECORDED (不伪造当前环境)', res.reason === 'NOT_RECORDED');
}

// 7. resolveGitCommit 解析
{
  const commit = resolveGitCommit();
  check('resolveGitCommit 确定性返回字符串', typeof commit === 'string' && commit.length > 0);
  const explicit = resolveGitCommit('abc1234');
  check('resolveGitCommit 优先尊重显式传入', explicit === 'abc1234');
}

// 8. DeepSeek 前缀缓存不变式：systemText 绝对不因 generationContext 产生任何单字节差异
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-prefix-test-'));
  const mem1 = new Memory(tmpDir, { persona: '【初澜人设】你是初澜。' });
  const mem2 = new Memory(tmpDir, { persona: '【初澜人设】你是初澜。' });

  // 两个 memory 注入完全相同的小结文本，但 mem1 无 generationContext，mem2 有丰富的 generationContext
  const snap1 = { epoch: mem1.data.epoch, items: [{ role: 'user', content: 'hello' }] };
  const snap2 = {
    epoch: mem2.data.epoch,
    items: [{ role: 'user', content: 'hello' }],
    generationContext: buildGenerationContext({
      kind: 'summary',
      cfg: { model: 'test-model', experimentMode: 'experimental' }
    })
  };

  mem1.closeWindow('窗口 1 记忆：用户喜欢安静。', snap1);
  mem2.closeWindow('窗口 1 记忆：用户喜欢安静。', snap2);

  const sys1 = mem1.systemText();
  const sys2 = mem2.systemText();

  check('前缀缓存不变式：存在 generationContext 时 systemText 字节完全一致',
    sys1 === sys2,
    `sys1.length=${sys1.length}, sys2.length=${sys2.length}`
  );
  check('memory window 对象内部确实持久化了 generationContext',
    mem2.data.windows[0].generationContext && mem2.data.windows[0].generationContext.kind === 'summary'
  );
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\n全部通过');
}
