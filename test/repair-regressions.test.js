'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPathDependencyExperiment } = require('../src/path-dependency');
const { synthesizeDream } = require('../src/dream-system');
const { InternalRegulationManager } = require('../src/internal-regulation');

const evt = { type: 'activity', activityKind: 'poke', payload: { count: 1 } };
const base = { sequenceA: [evt], sequenceB: [evt] };
const changedState = runPathDependencyExperiment({
  ...base,
  initialStateA: { subjectState: { stateChanges: [{ stateChangeId: 'sc-1', trait: 'vitality', delta: 1 }] } },
  initialStateB: { subjectState: { stateChanges: [] } }
});
assert.strictEqual(changedState.reason, 'PATH_EXPERIMENT_INITIAL_STATE_MISMATCH');
assert.strictEqual(changedState.preconditions.initialStateEqual, false);
console.log('PASS  完整 SubjectState 初始快照差异被拦截');
const captured = 7;
function closureEvent(ctx) { return captured + (ctx ? 0 : 1); }
const closureRejected = runPathDependencyExperiment({ sequenceA: [closureEvent], sequenceB: [closureEvent] });
assert.strictEqual(closureRejected.reason, 'PATH_EXPERIMENT_UNVERIFIABLE_FUNCTION_EVENT');
console.log('PASS  不同 closure 环境的函数事件不作静态等价证明');

function rejectsDifferent(a, b) {
  const r = runPathDependencyExperiment({ ...base, initialStateA: a, initialStateB: b });
  return r.valid === false && r.reason === 'PATH_EXPERIMENT_INITIAL_STATE_MISMATCH';
}
assert.ok(rejectsDifferent(
  { internalRegulation: { consumedAttentionEvents: ['e1'] } },
  { internalRegulation: { consumedAttentionEvents: ['e2'] } }
));
console.log('PASS  watermark 差异被拦截');
assert.ok(rejectsDifferent(
  { subjectState: { seenFingerprints: ['fp-1'] } },
  { subjectState: { seenFingerprints: ['fp-2'] } }
));
console.log('PASS  seenFingerprints 差异被拦截');
assert.ok(rejectsDifferent(
  { subjectState: { windowNo: 1 } },
  { subjectState: { windowNo: 2 } }
));
console.log('PASS  windowNo 差异被拦截');
assert.ok(rejectsDifferent(
  { subjectState: { recoveryStatus: 'NORMAL' } },
  { subjectState: { recoveryStatus: 'RECOVERY_UNCERTIFIED' } }
));
console.log('PASS  recoveryStatus 差异被拦截');
const reordered = runPathDependencyExperiment({
  ...base,
  initialStateA: { internalRegulation: { consumedAttentionEvents: ['e1', 'e2'] } },
  initialStateB: { internalRegulation: { consumedAttentionEvents: ['e2', 'e1'] } }
});
assert.strictEqual(reordered.preconditions.initialStateEqual, true);
console.log('PASS  相同 Set 内容不同插入顺序保持等价');
const timestampOnly = runPathDependencyExperiment({
  ...base,
  initialStateA: { subjectState: { updatedAt: 100 } },
  initialStateB: { subjectState: { updatedAt: 200 } }
});
assert.strictEqual(timestampOnly.preconditions.initialStateEqual, true);
console.log('PASS  非语义 timestamp metadata 不改变等价性');
const diskA = fs.mkdtempSync(path.join(os.tmpdir(), 'life-state-a-'));
const diskB = fs.mkdtempSync(path.join(os.tmpdir(), 'life-state-b-'));
const persisted = arousal => ({ values: { energy: 100, restPressure: 0, arousal, interactionDensity: 0, cognitiveLoadProxy: 0 }, history: [], consumedAttentionEvents: [] });
fs.writeFileSync(path.join(diskA, 'internal-regulation.json'), JSON.stringify(persisted(50)));
fs.writeFileSync(path.join(diskB, 'internal-regulation.json'), JSON.stringify(persisted(60)));
const diskRestore = runPathDependencyExperiment({ ...base, userDataDirA: diskA, userDataDirB: diskB });
assert.strictEqual(diskRestore.preconditions.initialStateEqual, false);
console.log('PASS  真实 userDataDir restore 状态差异被拦截');
fs.rmSync(diskA, { recursive: true, force: true });
fs.rmSync(diskB, { recursive: true, force: true });

(async () => {
  let calls = 0;
  const result = await synthesizeDream({ complete: async () => { calls++; return { text: '梦' }; } }, [], {
    windowNo: 1,
    sourceEventIds: ['evt-forged'],
    sourceEvents: [{ eventId: 'evt-real' }]
  }, { now: 1, idGenerator: () => 'x' });
  assert.strictEqual(result, null);
  assert.strictEqual(calls, 0);
  console.log('PASS  Dream forged event provenance 被拒绝且不调用模型');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-watermark-corrupt-'));
  const statePath = path.join(dir, 'internal-regulation.json');
  fs.writeFileSync(statePath, '{not-json', 'utf8');
  const manager = new InternalRegulationManager(dir, { enabled: true });
  const before = manager.arousal;
  manager.updateOnAttention({ status: 'ATTENDED', attended: true, salience: 80 }, { eventId: 'e1' });
  assert.strictEqual(manager.persistenceHealthy, false);
  assert.strictEqual(manager.arousal, before);
  console.log('PASS  损坏 watermark 文件进入 fail-closed');
  console.log('PASS  watermark fail-closed 不发生内存漂移');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('repair regressions passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
