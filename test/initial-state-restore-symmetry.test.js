'use strict';
// Initial State Restore Symmetry 回归测试
// 覆盖：canonicalizeExperimentState() 认证的 SubjectState 字段
// 必须与 executeTrajectory() 实际执行对象恢复结果完全一致（audit state = execute state）。
const assert = require('node:assert');
const path = require('path');
const { runPathDependencyExperiment } = require(path.join(__dirname, '..', 'src', 'path-dependency'));

const cfg = { experimentMode: 'enabled', experimentModules: { internalRegulation: true } };

// 函数事件：观测执行对象真实状态并写回 values 供断言（无闭包捕获，签名=body hash）
const obsFn = function (ctx) {
  const s = ctx.subjectState;
  const beforeCount = (s.data.stateChanges || []).length;
  const seenBefore = Array.from(s.committedFingerprints || []).sort().join('|');
  const seenEvBefore = Array.from(s.committedEvidenceIds || []).sort().join('|');
  s.data.values.obs_windowNo = s.data.windowNo;
  s.data.values.obs_seenFp = seenBefore;
  s.data.values.obs_seenEv = seenEvBefore;
  s.data.values.obs_scBefore = beforeCount;
  s.data.values.obs_recoveryFlag = (s.data.recoveryStatus === 'RECOVERY_PENDING' && s.recoveryPending && s.recoveryPendingReason === 'R-provided') ? 1 : 0;
  s.data.values.obs_schemaFlag = (s.data.schemaVersion === 99 && s.data.updatedAt === 123456) ? 1 : 0;
  s.data.values.obs_runtimeRecovery = s.recoveryStatus;
  s.data.values.obs_snapFlag = s.formatSnapshot().indexOf('social_willingness=42') >= 0 ? 1 : 0;
  const dup = s.verifyEvidence([{ evidenceId: 'ev-dup', trait: 'quiet_preference', direction: 1, strength: 1 }], [], 1);
  s.data.values.obs_dupRejected = dup.rejected.length > 0 && dup.rejected[0].reason === 'DUPLICATE_EVIDENCE_ID' ? 1 : 0;
  s.reduce([{ evidenceId: 'ev-run-1', trait: 'quiet_preference', direction: 1, strength: 1 }], undefined, { canalization: false });
  const sc = s.data.stateChanges || [];
  s.data.values.obs_scWindowNo = sc.length > beforeCount ? sc[beforeCount].windowNo : 0;
  s.data.values.obs_delta = s.data.values.quiet_preference;
};

// 严格对称场景观测：同时读取 runtime recoveryStatus / data.recoveryStatus / formatSnapshot / data.windowNo / values
const obsFn2 = function (ctx) {
  const s = ctx.subjectState;
  const snap = s.formatSnapshot();
  const vals = s.values;
  s.data.values.obs2_runtimeRecovery = s.recoveryStatus;
  s.data.values.obs2_dataRecovery = s.data.recoveryStatus;
  s.data.values.obs2_windowNo = s.data.windowNo;
  s.data.values.obs2_trait = vals.social_willingness;
  s.data.values.obs2_snapFlag = snap.indexOf('social_willingness=42') >= 0 ? 1 : 0;
};

function fullInit() {
  return {
    subjectState: {
      values: { quiet_preference: 0, social_willingness: 42 },
      history: [{ windowNo: 1, tag: 'h-provided' }],
      stateChanges: [{ id: 'sc-provided' }],
      seenFingerprints: ['fp-provided'],
      seenEvidenceIds: ['ev-provided', 'ev-dup'],
      recoveryStatus: 'RECOVERY_PENDING',
      recoveryPending: true,
      recoveryPendingReason: 'R-provided',
      stepWeight: 7,
      maxDeltaPerWindow: 50,
      windowNo: 5,
      schemaVersion: 99,
      updatedAt: 123456
    }
  };
}

// ---------- 单字段反例：A/B 只差一个字段 → initialStateEqual=false ----------
const mismatchCases = [
  ['windowNo', { windowNo: 3 }, { windowNo: 4 }],
  ['seenFingerprints', { seenFingerprints: ['fp-a'] }, { seenFingerprints: ['fp-b'] }],
  ['seenEvidenceIds', { seenEvidenceIds: ['ev-a'] }, { seenEvidenceIds: ['ev-b'] }],
  ['stateChanges', { stateChanges: [{ id: 1 }] }, { stateChanges: [{ id: 2 }] }],
  ['recoveryStatus', { recoveryStatus: 'NORMAL' }, { recoveryStatus: 'RECOVERY_PENDING' }],
  ['recoveryPending', { recoveryPending: false }, { recoveryPending: true }],
  ['recoveryPendingReason', { recoveryPendingReason: 'ra' }, { recoveryPendingReason: 'rb' }]
];

for (const [name, a, b] of mismatchCases) {
  const r = runPathDependencyExperiment({
    sequenceA: [], sequenceB: [], config: cfg,
    initialStateA: { subjectState: a }, initialStateB: { subjectState: b },
    clock: { now: () => 1000 }
  });
  assert.strictEqual(r.preconditions.initialStateEqual, false, `${name} 差异必须被 initial state identity 检出`);
  console.log(`PASS: ${name} 单字段差异 -> initialStateEqual=false`);
}

// ---------- 相同完整初始状态：执行对象必须恢复成认证状态 ----------
const r2 = runPathDependencyExperiment({
  sequenceA: [obsFn], sequenceB: [obsFn], config: cfg,
  initialStateA: fullInit(), initialStateB: fullInit(),
  clock: { now: () => 1000 }
});
assert.strictEqual(r2.valid, true, `实验应有效: ${r2.reason || ''}`);
assert.strictEqual(r2.preconditions.initialStateEqual, true);
const obs = r2.trajectoryA.subjectState;

// item 2/10: windowNo 注入值真正到达执行对象
assert.strictEqual(obs.obs_windowNo, 5, 'execute 侧 data.windowNo 必须等于注入值 5');
console.log('PASS: windowNo 注入值恢复到执行对象 (data.windowNo=5)');

// item 4: committedFingerprints 与认证状态一致（运行时去重集合，非 data 镜像）
assert.strictEqual(obs.obs_seenFp, 'fp-provided', 'committedFingerprints 必须恢复注入集合');
console.log('PASS: committedFingerprints 恢复注入集合');

// item 6: committedEvidenceIds 与认证状态一致
assert.strictEqual(obs.obs_seenEv, 'ev-dup|ev-provided', 'committedEvidenceIds 必须恢复注入集合');
console.log('PASS: committedEvidenceIds 恢复注入集合');

// item 7: stateChanges 侧恢复一致（audit 认证 [sc-provided]，执行侧应同样存在）
assert.strictEqual(obs.obs_scBefore, 1, 'stateChanges 必须恢复注入数组');
console.log('PASS: stateChanges 恢复注入数组');

// item 7: recoveryStatus / recoveryPending / recoveryPendingReason + schemaVersion / updatedAt
assert.strictEqual(obs.obs_recoveryFlag, 1, 'recovery 三字段必须恢复注入值');
assert.strictEqual(obs.obs_schemaFlag, 1, 'schemaVersion/updatedAt 必须恢复注入值');
console.log('PASS: recoveryStatus/recoveryPending/recoveryPendingReason 恢复注入值');
console.log('PASS: schemaVersion/updatedAt 恢复注入值');

// item 8: 初始 committedEvidenceIds 已含 ev-dup → 执行期不得重新接受
assert.strictEqual(obs.obs_dupRejected, 1, '注入集合内的 evidenceId 必须被 verifyEvidence 去重拒绝');
console.log('PASS: evidence 去重生效（注入的 ev-dup 被拒绝）');

// item 9: 非默认 windowNo + 非默认 stepWeight → reduce 实际使用注入值
assert.strictEqual(obs.obs_scWindowNo, 5, 'reduce 的 targetWindowNo 必须使用注入 windowNo');
assert.strictEqual(obs.obs_delta, 7, 'reduce 的 delta 必须由注入 stepWeight=7 决定');
console.log('PASS: canalization 场景 reduce 使用注入 windowNo=5 与 stepWeight=7');

// item 10: 旧版本反例（audit=A / execute=B）不再出现：
// 认证状态含全部注入字段，执行对象同轮观测值与之一一相符（上方断言合计成立）
assert.strictEqual(r2.preconditions.initialStateEqual, true, '认证阶段应认证注入状态');
assert.strictEqual(typeof obs.obs_windowNo, 'number', '执行对象可观测状态已对齐认证状态');
console.log('PASS: 旧反例不再出现（audit 认证状态 == execute 执行状态）');

// ---------- 收口 A：runtime recoveryStatus 与 data.recoveryStatus 对称恢复 ----------
assert.strictEqual(obs.obs_runtimeRecovery, 'RECOVERY_PENDING', 'runtime recoveryStatus 必须与认证初始状态一致');
console.log('PASS: runtime recoveryStatus 与 data.recoveryStatus 对称恢复');

// ---------- 收口 B：恢复后 frozenSnapshot 已刷新，formatSnapshot 可见注入初始值 ----------
assert.strictEqual(obs.obs_snapFlag, 1, 'formatSnapshot 必须反映注入初始值而非 constructor 默认旧状态');
console.log('PASS: formatSnapshot 反映注入初始值（frozenSnapshot 已刷新）');

// ---------- 严格对称场景：A/B 相同 initialState，五处 runtime 观测全部与认证状态一致 ----------
const strictInit = () => ({
  subjectState: {
    values: { social_willingness: 42 },
    windowNo: 5,
    recoveryStatus: 'RECOVERY_PENDING',
    recoveryPending: true,
    recoveryPendingReason: 'R-provided'
  }
});
const r3 = runPathDependencyExperiment({
  sequenceA: [obsFn2], sequenceB: [obsFn2], config: cfg,
  initialStateA: strictInit(), initialStateB: strictInit(),
  clock: { now: () => 1000 }
});
assert.strictEqual(r3.valid, true, `严格对称实验应有效: ${r3.reason || ''}`);
assert.strictEqual(r3.preconditions.initialStateEqual, true);
const o2 = r3.trajectoryA.subjectState;
assert.strictEqual(o2.obs2_runtimeRecovery, 'RECOVERY_PENDING', '严格对称: runtime recoveryStatus 必须与认证一致');
assert.strictEqual(o2.obs2_dataRecovery, 'RECOVERY_PENDING', '严格对称: data.recoveryStatus 必须与认证一致');
console.log('PASS: 严格对称 recoveryStatus（runtime+data）与认证一致');
assert.strictEqual(o2.obs2_windowNo, 5, '严格对称: data.windowNo 必须与认证一致');
assert.strictEqual(o2.obs2_trait, 42, '严格对称: values 注入 trait 必须与认证一致');
console.log('PASS: 严格对称 data.windowNo 与 values 与认证一致');
assert.strictEqual(o2.obs2_snapFlag, 1, '严格对称: formatSnapshot 必须含注入初始值');
console.log('PASS: 严格对称 formatSnapshot 含注入初始值');

console.log('all initial-state-restore-symmetry tests passed');
