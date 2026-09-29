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
const {
  buildGenerationContext,
  validateGenerationContext,
  getGenerationContext,
  isProviderRuntimeResponse
} = require('../src/experiment-metadata');
// v0.9.8 C-01: 测试以「provider adapter 仿真」身份经专用信任根铸造（公共 metadata API 无任何铸造途径）
const { createProviderRuntimeMintAuthority } = require('../src/provider-runtime-trust');
const markProviderRuntimeResponse = createProviderRuntimeMintAuthority('deepseek');
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

  // 1b. 普通 caller 构造伪造普通对象 providerResponse: { observedModel: 'fake' } -> 不能得到 provider_response
  const fakeObjCtx = buildGenerationContext({
    kind: 'dream',
    cfg: {
      model: 'configured-model',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek'
    },
    providerResponse: { observedModel: 'fake-provider-model' },
    modelVersion: 'v-test',
    promptHashes: { dream: 'sha256:test' },
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    generatedAt: 1000
  });

  check('伪造普通对象 providerResponse 无法冒充 provider_response (降级为 caller_or_config)',
    fakeObjCtx.observedModelSource === 'caller_or_config');
  check('伪造普通对象 providerResponse 其 provenanceStatus 为 caller_supplied_or_config',
    fakeObjCtx.provenanceStatus === 'caller_supplied_or_config');

  // 2. 有真实 runtime provider adapter 响应证据 -> 认证为 provider_response
  const trustedRes = markProviderRuntimeResponse({
    observedModel: 'observed-provider-model',
    text: 'dream narrative',
    usage: {}
  }, { adapter: 'deepseek' });

  const trustedCtx = buildGenerationContext({
    kind: 'dream',
    cfg: {
      model: 'configured-model',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek'
    },
    providerResponse: trustedRes,
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
  const emptyRes = markProviderRuntimeResponse({
    text: 'no observed model returned'
  }, { adapter: 'deepseek' });

  const emptyResCtx = buildGenerationContext({
    kind: 'dream',
    cfg: {
      model: 'configured-model',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek'
    },
    providerResponse: emptyRes,
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

  // 5. F-12 attestation 伪造路径: 复制真实 response 的 Symbol marker 到 fake object -> 绝不可信
  check('F-12 真实 runtime response 通过 attestation', isProviderRuntimeResponse(trustedRes) === true);
  const copiedSymbols = Object.getOwnPropertySymbols(trustedRes);
  const markerForged = { observedModel: 'forged-provider-model' };
  for (const sym of copiedSymbols) {
    try {
      Object.defineProperty(markerForged, sym, { value: trustedRes[sym], enumerable: false, configurable: true });
    } catch {}
  }
  check('F-12 fake object 携带复制 Symbol marker -> 不可信', isProviderRuntimeResponse(markerForged) === false);
  const forgedCtx = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'configured-model', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
    providerResponse: markerForged,
    promptHashes: { dream: 'sha256:test' },
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    generatedAt: 1000
  });
  check('F-12 复制 marker 伪造 providerResponse -> observedModelSource 降级 caller_or_config',
    forgedCtx.observedModelSource === 'caller_or_config');
  check('F-12 复制 marker 伪造时 provenanceStatus=caller_supplied_or_config',
    forgedCtx.provenanceStatus === 'caller_supplied_or_config');

  // 5b. DeepSeek complete()/stream() 返回路径仍经 markProviderRuntimeResponse 注册（源码级回归护栏）
  const deepseekSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'deepseek.js'), 'utf8');
  const markCalls = deepseekSrc.split('markProviderRuntimeResponse(').length - 1;
  check('F-12 deepseek complete()/stream() 均经 markProviderRuntimeResponse 注册 runtime response', markCalls >= 2);

  // 6. provenanceStatus 语义一致性: runtime 证据缺 promptHashes 时不得互相矛盾
  const runtimeNoHashes = markProviderRuntimeResponse({
    observedModel: 'observed-provider-model',
    text: 'dream'
  }, { adapter: 'deepseek' });
  const noHashCtx = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'configured-model', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
    providerResponse: runtimeNoHashes,
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    generatedAt: 1000
  });
  check('F-12p runtime 证据缺 promptHashes: observedModelSource 仍为 provider_response',
    noHashCtx.observedModelSource === 'provider_response');
  check('F-12p runtime 证据缺 promptHashes: provenanceStatus=runtime_observed_partial (不降格为 caller 声明)',
    noHashCtx.provenanceStatus === 'runtime_observed_partial');
  check('F-12p promptHashes 缺失时如实为空对象 (不补造完整 provenance)',
    noHashCtx.promptHashes && Object.keys(noHashCtx.promptHashes).length === 0);

  // 7. F-12a 铸造权限边界: 公共 metadata API 不含铸造能力
  const publicApi = require('../src/experiment-metadata');
  check('F-12a 公共 metadata API 不导出铸造函数 markProviderRuntimeResponse',
    typeof publicApi.markProviderRuntimeResponse === 'undefined');
  check('F-12a 公共 metadata API 无任何铸造途径（internal 通道已彻底移除）',
    publicApi.__internal === undefined && typeof publicApi.createProviderRuntimeMintAuthority === 'undefined');
  check('F-12a 铸造能力仅存在于专用信任根模块 provider-runtime-trust',
    typeof require('../src/provider-runtime-trust').createProviderRuntimeMintAuthority === 'function');
  check('F-12a fake object 无法经公共路径自行获得 runtime attestation',
    isProviderRuntimeResponse({ observedModel: 'fake' }) === false);
  check('F-12a deepseek 经信任根模块获取铸造权限且 complete()/stream() 均注册',
    deepseekSrc.includes("createProviderRuntimeMintAuthority('deepseek')") && markCalls >= 2);

  // 8. F-12b runtime evidence 与 provider/adapter 绑定
  check('F-12b trusted deepseek response + provider=deepseek -> provider_response',
    trustedCtx.observedModelSource === 'provider_response');
  const mintOtherAdapter = createProviderRuntimeMintAuthority('other-adapter');

  const crossA = markProviderRuntimeResponse({ observedModel: 'deepseek-model', text: 'x' });
  const crossCtxA = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'm', baseURL: 'https://api.openai.com/v1', provider: 'openai' },
    providerResponse: crossA,
    generatedAt: 1000
  });
  check('F-12b trusted deepseek response + 不同 provider -> 不冒充 provider_response (降级)',
    crossCtxA.observedModelSource !== 'provider_response');
  check('F-12b adapter/provider 不匹配时 provenanceStatus 亦不宣称 runtime 观测',
    crossCtxA.provenanceStatus === 'caller_supplied_or_config');

  const crossB = mintOtherAdapter({ observedModel: 'other-model', text: 'x' });
  const crossCtxB = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'm', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
    providerResponse: crossB,
    generatedAt: 1000
  });
  check('F-12b 其他 adapter 的 trusted response + provider=deepseek -> 降级 caller_or_config',
    crossCtxB.observedModelSource === 'caller_or_config');
  check('F-12b fake/untrusted object 仍然拒绝', isProviderRuntimeResponse({}) === false);

  // 9. B-01 / C-02 / G-01: endpoint↔provider 绑定、身份缺失旁路、usage 伪造链
  const b01res = markProviderRuntimeResponse({ observedModel: 'obs-model', text: 'x', usage: { completion_tokens: 1 } });
  const b01ctx = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'm', baseURL: 'http://127.0.0.1:5000', provider: 'deepseek' },
    providerResponse: b01res,
    generatedAt: 1000
  });
  check('B-01 provider=deepseek + 非官方 endpoint（本地 mock）-> 严格降级', b01ctx.observedModelSource !== 'provider_response');
  const b01ctx2 = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'm', baseURL: 'https://evil-thirdparty.example.com', provider: 'deepseek' },
    providerResponse: b01res,
    generatedAt: 1000
  });
  check('B-01 provider=deepseek + 第三方 endpoint -> 严格降级', b01ctx2.observedModelSource !== 'provider_response');

  const c02ctx = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'm' },
    providerResponse: b01res,
    generatedAt: 1000
  });
  check('C-02 provider 缺失（unavailable）-> 绑定 fail-closed 降级', c02ctx.observedModelSource !== 'provider_response');

  const g01fake = { observedModel: 'fake-model', text: 'x', usage: { completion_tokens: 9999 } };
  const g01ctx = buildGenerationContext({
    kind: 'dream',
    cfg: { model: 'm', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
    providerResponse: g01fake,
    generatedAt: 1000
  });
  check('G-01 fake usage 无法经伪造 response 升级为 provider truth（usage 伪造链断开）', g01ctx.observedModelSource === 'caller_or_config');
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
// F-13b: save() 失败时 before snapshot 完整 rollback（含两套 watermark）
// -----------------------------------------------------------------------------
{
  const dir = tmpDir();
  const manager = new InternalRegulationManager(dir, { enabled: true });
  manager.updateOnAttention(
    { status: 'ATTENDED', attended: true, salience: 40, eventId: 'rb-0' },
    { eventId: 'rb-0', timestamp: 1000 }
  );
  const s0 = manager.getState();
  const arousal0 = s0.arousal;
  const load0 = s0.cognitiveLoadProxy;
  const persisted0 = s0.watermark.persistedCount;

  // 注入 save 失败
  const realSave = manager.save.bind(manager);
  manager.save = () => false;
  const sFail = manager.updateOnAttention(
    { status: 'ATTENDED', attended: true, salience: 80, eventId: 'rb-fail' },
    { eventId: 'rb-fail', timestamp: 2000 }
  );
  check('F-13b save 失败后 getState() 正常返回', Boolean(sFail) && typeof sFail === 'object');
  check('F-13b save 失败时 arousal 完整 rollback', manager.getState().arousal === arousal0);
  check('F-13b save 失败时 cognitiveLoadProxy 完整 rollback', manager.getState().cognitiveLoadProxy === load0);
  check('F-13b save 失败时 persisted watermark 未消费该事件 (非 undefined/非误记)',
    manager.getState().watermark.persistedCount === persisted0);

  // 恢复 save，同一事件重新处理 -> 必须被正常消费（证明 rollback 后事件没被错误消费）
  manager.save = realSave;
  manager.updateOnAttention(
    { status: 'ATTENDED', attended: true, salience: 80, eventId: 'rb-fail' },
    { eventId: 'rb-fail', timestamp: 3000 }
  );
  check('F-13b rollback 后同一事件可被再次正常处理 (未被错误消费)', manager.getState().arousal > arousal0);
  check('F-13b 再次处理后事件才被正确消费 (+1 watermark)', manager.getState().watermark.persistedCount === persisted0 + 1);

  // 消费后重复处理仍幂等
  manager.updateOnAttention(
    { status: 'ATTENDED', attended: true, salience: 80, eventId: 'rb-fail' },
    { eventId: 'rb-fail', timestamp: 4000 }
  );
  check('F-13b 消费后的事件重复处理保持幂等 (watermark 不再增长)', manager.getState().watermark.persistedCount === persisted0 + 1);

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

  // F-16 五类时间输入分类：只有实际确定的时间输入才 deterministic
  const fixedTs = evaluateDreamGate({ timestamp: 100000, windowNo: 10, dreamHistory: [] });
  check('F-16 fixed timestamp -> deterministic=true (fixed_timestamp)',
    fixedTs.deterministic === true && fixedTs.timeInputKind === 'fixed_timestamp');

  const detClock = evaluateDreamGate({ clock: { now: () => 100000 }, windowNo: 10, dreamHistory: [] });
  check('F-16 deterministic clock -> deterministic=true (deterministic_clock)',
    detClock.deterministic === true && detClock.timeInputKind === 'deterministic_clock');

  const wallClock = evaluateDreamGate({ clock: { now: () => Date.now() }, windowNo: 10, dreamHistory: [] });
  check('F-16 Date.now clock -> deterministic=false (wall_clock)',
    wallClock.deterministic === false && wallClock.timeInputKind === 'wall_clock');

  const randomClock = evaluateDreamGate({ clock: { now: () => Math.random() * 1e13 }, windowNo: 10, dreamHistory: [] });
  check('F-16 random clock -> deterministic=false (random_clock)',
    randomClock.deterministic === false && randomClock.timeInputKind === 'random_clock');

  check('F-16 default clock -> deterministic=false (default_clock)',
    implicit.deterministic === false && implicit.timeInputKind === 'default_clock');
}

// -----------------------------------------------------------------------------
// F-15: Dream identity scope 细分与语义解耦 (A/B/C/D 完整矩阵)
// -----------------------------------------------------------------------------
(async () => {
  const dummyClient = (obsModel = 'observed-provider-model') => ({
    cfg: { model: 'configured-model', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
    complete: async () => markProviderRuntimeResponse({
      text: '一场安静的梦',
      ...(obsModel ? { observedModel: obsModel } : {})
    }, { adapter: 'test_mock_provider' })
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
  check('Case B options 指定: identityDeterministic=true (caller 固定 identity 可重复，与 identitySource 正交)',
    dreamB.payload.identityDeterministic === true);
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
  check('Case C context 指定: identityDeterministic=true (两维度独立表达)', dreamC.payload.identityDeterministic === true);
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

  // Case E: deterministic generator + wall-clock now -> 绝不宣称完整 identity 可复现 (F-15)
  const dreamE = await synthesizeDream(
    dummyClient(),
    basePrompt,
    baseContext,
    { clock: { now: () => Date.now() }, idGenerator: deterministicIdGen }
  );
  check('Case E 确定性生成器 + wall clock: identityDeterministic=false',
    dreamE.payload.identityDeterministic === false);
  check('Case E 确定性生成器 + wall clock: identitySource 仍如实标注 deterministic_generator',
    dreamE.payload.identitySource === 'deterministic_generator');

  // Case F: 默认运行时生成 (随机后缀 + 非确定时间) -> false
  const dreamF = await synthesizeDream(
    dummyClient(),
    basePrompt,
    baseContext,
    { clock: { now: () => Math.random() * 1e13 } }
  );
  check('Case F 默认运行时生成: identityDeterministic=false', dreamF.payload.identityDeterministic === false);
  check('Case F 默认运行时生成: identitySource=runtime_generated', dreamF.payload.identitySource === 'runtime_generated');

  // Case G: deterministic generator + deterministic clock -> 完整可复现成立
  const dreamG = await synthesizeDream(
    dummyClient(),
    basePrompt,
    baseContext,
    { clock: { now: () => 777 }, idGenerator: deterministicIdGen }
  );
  check('Case G 确定性生成器 + deterministic clock: identityDeterministic=true',
    dreamG.payload.identityDeterministic === true);

  // F-15d: runtime_unique 语义 —— 运行时生成 ≠ 跨运行全局唯一
  const dreamG2 = await synthesizeDream(
    dummyClient(),
    basePrompt,
    baseContext,
    { clock: { now: () => 777 }, idGenerator: deterministicIdGen }
  );
  check('F-15d deterministic generator 跨运行可复现产生相同 dreamId (非全局唯一)',
    dreamG2.payload.dreamId === dreamG.payload.dreamId);
  check('F-15d identityScopeSemantics 明示 runtime 生成不承诺跨运行全局唯一',
    dreamG.payload.identityScopeSemantics === 'runtime_generated_identity_not_globally_unique');
  check('F-15d caller_supplied 的 identityScopeSemantics 独立标注',
    dreamB.payload.identityScopeSemantics === 'caller_supplied_identity');

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
