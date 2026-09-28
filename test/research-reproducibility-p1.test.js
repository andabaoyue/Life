/**
 * test/research-reproducibility-p1.test.js
 *
 * v0.9.8 第二轮研究严谨性优化专项：
 * F-12 GenerationContext provenance calibration
 * F-13 global attention watermark persistence
 * F-14 state-level Replay determinism contract
 * F-16 explicit Dream gate clock provenance
 * F-15 runtime-unique Dream identity scope
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildGenerationContext, validateGenerationContext } = require('../src/experiment-metadata');
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
// F-12: GenerationContext 来源强度标注
// -----------------------------------------------------------------------------
{
  const ctx = buildGenerationContext({
    kind: 'dream',
    cfg: {
      model: 'configured-model',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek'
    },
    observedModel: 'observed-provider-model',
    modelVersion: 'v-test',
    promptHashes: { dream: 'sha256:test' },
    provenance: { observedModelSource: 'provider_response' },
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    generatedAt: 1000
  });

  check('GenerationContext 标记 observedModelSource=provider_response', ctx.observedModelSource === 'provider_response');
  check('GenerationContext 标记 provenanceStatus=runtime_observed_partial', ctx.provenanceStatus === 'runtime_observed_partial');
  check('GenerationContext 显式 Git Commit 来源标记为 explicit', ctx.gitCommitSource === 'explicit');
  check('GenerationContext provenance 标记通过结构验证', validateGenerationContext(ctx).valid === true);

  const bad = { ...ctx, observedModelSource: 'provider_response_fake' };
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
// F-16 / F-15: Dream 时间来源与 runtime identity 语义
// -----------------------------------------------------------------------------
{
  const explicit = evaluateDreamGate({ now: 100000, windowNo: 10, dreamHistory: [] });
  const implicit = evaluateDreamGate({ windowNo: 10, dreamHistory: [] });

  check('显式注入 clock 时 Dream gate deterministic=true', explicit.deterministic === true);
  check('显式注入 clock 来源可审计', explicit.clockSource === 'explicit_now');
  check('未注入 clock 时如实标记 wall_clock', implicit.clockSource === 'wall_clock');
  check('未注入 clock 时不宣称 deterministic', implicit.deterministic === false);
}

(async () => {
  const dream = await synthesizeDream(
    {
      cfg: { model: 'configured-model', baseURL: 'https://api.deepseek.com', provider: 'deepseek' },
      complete: async () => ({ text: '一场安静的梦', observedModel: 'observed-provider-model' })
    },
    [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
    {
      windowNo: 2,
      verifiedEvidence: [],
      sourceMessageIds: ['m-1'],
      dayResidues: []
    },
    {
      now: 12345,
      dreamId: 'dream-test-fixed',
      cfg: { model: 'configured-model', baseURL: 'https://api.deepseek.com', provider: 'deepseek' }
    }
  );

  check('Dream artifact 明确标记 runtime_unique identity scope', dream &&
    dream.payload.identityScope === 'runtime_unique');
  check('Dream GenerationContext 如实标记 observedModel 来自 provider response', dream &&
    dream.generationContext &&
    dream.generationContext.observedModelSource === 'provider_response');
  check('Dream GenerationContext provenanceStatus 为 runtime_observed_partial', dream &&
    dream.generationContext &&
    dream.generationContext.provenanceStatus === 'runtime_observed_partial');

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
