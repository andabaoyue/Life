/**
 * test/research-reproducibility-p1.test.js
 *
 * v0.9.8.1 P1 残余收口专项测试：
 * F-12 GenerationContext provider_response 运行时自证门禁与向后兼容
 * F-13 global attention watermark persistence
 * F-14 state-level Replay determinism contract
 * F-16 explicit Dream gate clock provenance
 * F-15 Dream identity provenance (runtime_unique vs caller_supplied vs deterministic)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildGenerationContext, validateGenerationContext, getGenerationContext } = require('../src/experiment-metadata');
const { InternalRegulationManager } = require('../src/internal-regulation');
const { evaluateDreamGate, synthesizeDream } = require('../src/dream-system');
const { SubjectState } = require('../src/subject-state');
const { ExperiencesArchive } = require('../src/experiences-archive');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'repro-p1-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -----------------------------------------------------------------------------
// F-12: GenerationContext 来源强度标注与自证门禁
// -----------------------------------------------------------------------------
{
  // 1. 普通 caller 自称 provider_response，但无可信 runtime response 证据 -> 降级为 caller_or_config
  const callerFake = buildGenerationContext({
    kind: 'dream',
    cfg: {
      model: 'configured-model',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek'
    },
    observedModel: 'caller-supplied-model',
    modelVersion: 'v-test',
    promptHashes: { dream: 'sha256:test' },
    provenance: { observedModelSource: 'provider_response' },
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    generatedAt: 1000
  });

  check('无 runtime provider 证据时拒绝自证升级，observedModelSource 降级为 caller_or_config',
    callerFake.observedModelSource === 'caller_or_config');
  check('无 runtime provider 证据时 provenanceStatus 降级为 caller_supplied_or_config',
    callerFake.provenanceStatus === 'caller_supplied_or_config');

  // 2. 有真实 runtime provider adapter 响应证据 -> 认证为 provider_response
  const trustedCtx = buildGenerationContext({
    kind: 'dream',
    cfg: {
      model: 'configured-model',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek'
    },
    providerResponse: { observedModel: 'observed-provider-model' },
    modelVersion: 'v-test',
    promptHashes: { dream: 'sha256:test' },
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    generatedAt: 1000
  });

  check('有 runtime provider 响应时 observedModelSource=provider_response',
    trustedCtx.observedModelSource === 'provider_response');
  check('有 runtime provider 响应时 provenanceStatus=runtime_observed_partial',
    trustedCtx.provenanceStatus === 'runtime_observed_partial');
  check('GenerationContext 显式 Git Commit 来源标记为 explicit',
    trustedCtx.gitCommitSource === 'explicit');
  check('GenerationContext provenance 标记通过结构验证',
    validateGenerationContext(trustedCtx).valid === true);

  // 3. response 不含 observedModel -> unavailable，严禁伪造
  const emptyResCtx = buildGenerationContext({
    kind: 'dream',
    cfg: {
      model: 'configured-model',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek'
    },
    providerResponse: { text: 'no observed model returned' },
    modelVersion: 'v-test',
    promptHashes: { dream: 'sha256:test' },
    generatedAt: 1000
  });
  check('provider 响应缺失 observedModel 时保持 unavailable',
    emptyResCtx.observedModel === 'unavailable');
  check('provider 响应缺失 observedModel 时 observedModelSource 保持 unavailable',
    emptyResCtx.observedModelSource === 'unavailable');

  // 4. 历史向后兼容：缺少新字段时不报错，不补造历史 provenance
  const legacyCtx = {
    metaSchemaVersion: 1,
    kind: 'summary',
    generatedAt: 1000,
    lifeVersion: '0.9.7',
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    provider: 'deepseek',
    modelName: 'deepseek-chat',
    modelVersion: 'unavailable',
    endpoint: 'https://api.deepseek.com',
    sampling: null,
    promptHashes: { summary: 'sha256:legacy' },
    experimentMode: 'baseline',
    generator: 'llm'
  };
  check('历史 GenerationContext 结构校验依然合法 (向后兼容)',
    validateGenerationContext(legacyCtx).valid === true);
  const parsedLegacy = getGenerationContext(legacyCtx);
  check('历史 GenerationContext observedModelSource 返回 unavailable (不补造)',
    parsedLegacy.observedModelSource === 'unavailable');
  check('历史 GenerationContext provenanceStatus 返回 unavailable (不补造)',
    parsedLegacy.provenanceStatus === 'unavailable');

  const bad = { ...trustedCtx, observedModelSource: 'provider_response_fake' };
  check('未知 observedModelSource 被拒绝', validateGenerationContext(bad).valid === false);
}

// -----------------------------------------------------------------------------
// F-13: watermark 超过 256 后仍保持全历史幂等，并跨重启持久化
// -----------------------------------------------------------------------------
{
  const dir = tmpDir();
  const manager = new InternalRegulationManager(dir, { enabled: true });

  for (let i = 0; i < 260; i++) {
    manager.updateOnAttention(
      { status: 'ATTENDED', attended: true, salience: 40, eventId: 'attn-' + i },
      { eventId: 'attn-' + i, timestamp: 1000 + i }
    );
  }

  const state = manager.getState();
  check('watermark 语义明确标记为 global', state.watermark && state.watermark.scope === 'global');
  check('运行时 watermark cache 仍受 256 容量约束', state.watermark.runtimeCacheCapacity === 256);
  check('持久 watermark 保留 260 个历史事件', state.watermark.persistedCount === 260);

  const reloaded = new InternalRegulationManager(dir, { enabled: true });
  const before = reloaded.getState().arousal;
  reloaded.updateOnAttention(
    { status: 'ATTENDED', attended: true, salience: 90, eventId: 'attn-0' },
    { eventId: 'attn-0', timestamp: 5000 }
  );
  check('重启后最早事件仍被识别为 duplicate', reloaded.getState().arousal === before);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// F-14: Replay 确定性边界是 state-level semantic equivalence
// -----------------------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.appendRecord('custom', 1, {
    verifiedEvidence: [
      { evidenceId: 'ev-rp-1', trait: 'quiet_preference', direction: 1, strength: 0.5 }
    ],
    stateChanges: [
      { stateChangeId: 'sc-rp-1', trait: 'quiet_preference', delta: 10, previousValue: 0, newValue: 10, reducer: { stepWeight: 20, maxDelta: 50 } }
    ]
  });

  const records = archive.readAll();
  const a = SubjectState.replay(records, { deterministicIds: true });
  const b = SubjectState.replay(records, { deterministicIds: true });

  check('Replay 暴露 state-level determinism contract', a.determinism && a.determinism.scope === 'state');
  check('Replay semantic fields 明确包含 finalState/windowStates', a.determinism &&
    a.determinism.semanticFields.includes('finalState') &&
    a.determinism.semanticFields.includes('windowStates'));
  check('两次 Replay 的 finalState 完全一致', JSON.stringify(a.finalState) === JSON.stringify(b.finalState));
  check('两次 Replay 的 windowStates 完全一致', JSON.stringify(a.windowStates) === JSON.stringify(b.windowStates));
  check('运行时 identity/time 字段被明确列为 non-semantic', a.determinism &&
    a.determinism.runtimeFields.includes('stateChangeId') &&
    a.determinism.runtimeFields.includes('createdAt'));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
// F-16: Dream 时间来源与显式时钟门禁
// -----------------------------------------------------------------------------
{
  const explicit = evaluateDreamGate({ now: 100000, windowNo: 10, dreamHistory: [] });
  const implicit = evaluateDreamGate({ windowNo: 10, dreamHistory: [] });

  check('显式注入 clock 时 Dream gate deterministic=true', explicit.deterministic === true);
  check('显式注入 clock 来源可审计', explicit.clockSource === 'explicit_now');
  check('未注入 clock 时如实标记 wall_clock', implicit.clockSource === 'wall_clock');
  check('未注入 clock 时不宣称 deterministic', implicit.deterministic === false);
}

// -----------------------------------------------------------------------------
// F-15: Dream identity scope 细分与语义解耦 (A/B/C/D 完整矩阵)
// -----------------------------------------------------------------------------
(async () => {
  const dummyClient = (obsModel = 'observed-provider-model') => ({
    cfg: { model: 'configured-model', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
    complete: async () => ({
      text: '一场安静的梦',
      ...(obsModel ? { observedModel: obsModel } : {})
    })
  });

  const basePrompt = [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }];
  const baseContext = { windowNo: 2, verifiedEvidence: [], sourceMessageIds: ['m-1'], dayResidues: [] };

  // Case A: 默认生成 dreamId
  const dreamA = await synthesizeDream(
    dummyClient(),
    basePrompt,
    baseContext,
    { now: 12345 }
  );
  check('Case A 默认生成: identityScope=runtime_unique', dreamA.payload.identityScope === 'runtime_unique');
  check('Case A 默认生成: identityDeterministic=false', dreamA.payload.identityDeterministic === false);
  check('Case A 默认生成: identitySource=runtime_generated', dreamA.payload.identitySource === 'runtime_generated');
  check('Case A 默认生成: dreamId 符合运行时前缀规范', dreamA.payload.dreamId.startsWith('dream-w2-'));

  // Case B: options.dreamId (caller-supplied)
  const dreamB = await synthesizeDream(
    dummyClient(),
    basePrompt,
    baseContext,
    { now: 12345, dreamId: 'dream-test-fixed' }
  );
  check('Case B options 指定: identityScope=caller_supplied', dreamB.payload.identityScope === 'caller_supplied');
  check('Case B options 指定: identityDeterministic=false', dreamB.payload.identityDeterministic === false);
  check('Case B options 指定: identitySource=caller_supplied', dreamB.payload.identitySource === 'caller_supplied');
  check('Case B options 指定: dreamId 等于调用者提供值', dreamB.payload.dreamId === 'dream-test-fixed');
  check('Case B Dream GenerationContext 如实标记 observedModel 来自 provider response',
    dreamB.generationContext && dreamB.generationContext.observedModelSource === 'provider_response');
  check('Case B Dream GenerationContext provenanceStatus 为 runtime_observed_partial',
    dreamB.generationContext && dreamB.generationContext.provenanceStatus === 'runtime_observed_partial');

  // Case C: context.dreamId (caller-supplied via context)
  const dreamC = await synthesizeDream(
    dummyClient(),
    basePrompt,
    { ...baseContext, dreamId: 'dream-context-supplied' },
    { now: 12345 }
  );
  check('Case C context 指定: identityScope=caller_supplied', dreamC.payload.identityScope === 'caller_supplied');
  check('Case C context 指定: identitySource=caller_supplied', dreamC.payload.identitySource === 'caller_supplied');
  check('Case C context 指定: dreamId 等于 context 提供值', dreamC.payload.dreamId === 'dream-context-supplied');

  // Case D: deterministic idGenerator (runtime-generated with deterministic flag)
  const deterministicIdGen = () => 'fixed-det-suffix-001';
  const dreamD = await synthesizeDream(
    dummyClient(),
    basePrompt,
    baseContext,
    { now: 12345, idGenerator: deterministicIdGen }
  );
  check('Case D 确定性生成器: identityScope=runtime_unique (非 caller_supplied)',
    dreamD.payload.identityScope === 'runtime_unique');
  check('Case D 确定性生成器: identityDeterministic=true',
    dreamD.payload.identityDeterministic === true);
  check('Case D 确定性生成器: identitySource=deterministic_generator',
    dreamD.payload.identitySource === 'deterministic_generator');
  check('Case D 确定性生成器: dreamId 包含确定性生成后缀',
    dreamD.payload.dreamId.includes('fixed-det-suffix-001'));

  // 跨 Case 语义一致性验证：reproducibilityScope 与 identityScope 解耦
  const allCases = [dreamA, dreamB, dreamC, dreamD];
  const allSemanticScopesConsistent = allCases.every(d =>
    Array.isArray(d.payload.reproducibilityScope.semantic) &&
    d.payload.reproducibilityScope.semantic.includes('narrative') &&
    d.payload.reproducibilityScope.semantic.includes('outputHash') &&
    d.payload.reproducibilityScope.runtimeIdentity.includes('dreamId') &&
    !d.payload.reproducibilityScope.semantic.includes('dreamId')
  );
  check('Dream 运行时 identity 与语义可复现核心解耦无矛盾', allSemanticScopesConsistent);

  // F-12 端到端验证：真实 provider response 不含 observedModel 时，绝不伪造
  const dreamNoObs = await synthesizeDream(
    dummyClient(null),
    basePrompt,
    baseContext,
    { now: 12345 }
  );
  check('端到端: provider 无 observedModel 时 generationContext.observedModel 为 unavailable',
    dreamNoObs.generationContext.observedModel === 'unavailable');
  check('端到端: provider 无 observedModel 时 observedModelSource 为 unavailable',
    dreamNoObs.generationContext.observedModelSource === 'unavailable');

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
