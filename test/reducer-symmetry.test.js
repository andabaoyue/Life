/**
 * test/reducer-symmetry.test.js
 * 
 * Life v0.9.6 实验基线强化测试集 5：状态 Reducer 对称四舍五入与数值守恒专项测试
 * 
 * 检验点：
 * 1. symmetricRound(x) 纯数学对称性：对任意 x，满足 symmetricRound(-x) === -symmetricRound(x)
 * 2. 彻底消除 JavaScript 原生 Math.round(-1.5) === -1 的负数截断漂移缺陷
 * 3. 正负对称证据增量完全互为相反数，代数和恒为 0（无系统性单向漂移）
 * 4. createStateChange 与 StateChange.reducer 包含 roundingMode: 'symmetric' 显式声明
 * 5. SubjectState.prototype.reduce 与 SubjectState.replay 确定性双向一致
 */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { symmetricRound, createStateChange } = require('../src/state-change');
const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'reducer-symmetry-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. symmetricRound(x) 纯函数对称性验证
// -------------------------------------------------------------
{
  check('0 的对称性', symmetricRound(0) === 0 && symmetricRound(-0) === 0);
  check('1.5 舍入为 2', symmetricRound(1.5) === 2);
  check('-1.5 对称舍入为 -2 (消除了 Math.round 的 -1 漂移)', symmetricRound(-1.5) === -2);
  check('2.5 与 -2.5 对称', symmetricRound(2.5) === 3 && symmetricRound(-2.5) === -3);
  check('0.5 与 -0.5 对称', symmetricRound(0.5) === 1 && symmetricRound(-0.5) === -1);
  check('1.4 与 -1.4 对称', symmetricRound(1.4) === 1 && symmetricRound(-1.4) === -1);
  check('1.6 与 -1.6 对称', symmetricRound(1.6) === 2 && symmetricRound(-1.6) === -2);

  // 浮点密集抽样对称性核验
  let symmetricAllPass = true;
  for (let val = 0.05; val <= 20.0; val += 0.05) {
    if (symmetricRound(-val) !== -symmetricRound(val)) {
      symmetricAllPass = false;
      break;
    }
  }
  check('400 组密集浮点抽样 symmetricRound(-x) === -symmetricRound(x) 全部成立', symmetricAllPass);
}

// -------------------------------------------------------------
// 2. createStateChange 与 Reducer 契约声明
// -------------------------------------------------------------
{
  const sc = createStateChange({
    trait: 'quiet_preference',
    delta: 15,
    sourceEvidenceIds: ['ev-01'],
    sourceObservations: ['obs-01'],
    sourceEvents: ['evt-01'],
    sourceMessages: ['m-01'],
    confidence: 0.9,
    roundingMode: 'symmetric'
  });

  check('StateChange 包含 roundingMode: symmetric', sc.roundingMode === 'symmetric');
  check('StateChange 包含 reducer.roundingMode: symmetric', sc.reducer && sc.reducer.roundingMode === 'symmetric');
}

// -------------------------------------------------------------
// 3. 正负对称状态增量代数和恒为 0
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const state = new SubjectState(dir, { stepWeight: 10 });

  // 构造一对严格正负对称的证据（例如 direction: +1 与 -1，strength 均为 0.45）
  // 1 * 0.45 * 10 = 4.5 -> 对称舍入为 +5
  // -1 * 0.45 * 10 = -4.5 -> 对称舍入为 -5
  // 若使用 Math.round，-4.5 会变成 -4，导致 (+5 - 4) = +1 的正向系统漂移！
  const posEvidence = [
    { trait: 'quiet_preference', direction: 1, strength: 0.45, evidenceId: 'ev-pos-1' }
  ];
  const negEvidence = [
    { trait: 'quiet_preference', direction: -1, strength: 0.45, evidenceId: 'ev-neg-1' }
  ];

  const posRes = state.reduce(posEvidence, 1, { stepWeight: 10 });
  const negRes = state.reduce(negEvidence, 1, { stepWeight: 10 });

  check('正向增量为 +5', posRes.deltas.quiet_preference === 5);
  check('负向增量为 -5', negRes.deltas.quiet_preference === -5);
  check('正负增量严格互为相反数且代数和为 0 (零漂移)', posRes.deltas.quiet_preference + negRes.deltas.quiet_preference === 0);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 4. SubjectState reduce 与 replay 结果完全一致
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const state = new SubjectState(dir, { stepWeight: 15 });

  const evidenceWindow1 = [
    { trait: 'philosophical_curiosity', direction: 1, strength: 0.7, evidenceId: 'ev-w1-1' },
    { trait: 'attachment_need', direction: -1, strength: 0.3, evidenceId: 'ev-w1-2' }
  ];

  const evidenceWindow2 = [
    { trait: 'philosophical_curiosity', direction: -1, strength: 0.7, evidenceId: 'ev-w2-1', messageId: 'm-w2-1', quote: '数字生命', fingerprint: 'm-w2-1:数字生命:philosophical_curiosity:-1' },
    { trait: 'attachment_need', direction: 1, strength: 0.3, evidenceId: 'ev-w2-2', messageId: 'm-w2-1', quote: '数字生命', fingerprint: 'm-w2-1:数字生命:attachment_need:1' }
  ];

  const w1Res = state.reduce(evidenceWindow1, 1, { stepWeight: 15 });
  const w2Res = state.reduce(evidenceWindow2, 2, { stepWeight: 15 });

  // 1 * 0.7 * 15 = 10.5 -> 11; -1 * 0.7 * 15 = -10.5 -> -11
  check('Window 1 philosophical_curiosity 增量为 11', w1Res.deltas.philosophical_curiosity === 11);
  check('Window 2 philosophical_curiosity 增量为 -11', w2Res.deltas.philosophical_curiosity === -11);
  check('两窗口累计后 philosophical_curiosity 净变化为 0', w1Res.deltas.philosophical_curiosity + w2Res.deltas.philosophical_curiosity === 0);

  // 利用 ExperiencesArchive 生成具备标准 Canonical Schema 与完整哈希链的归档记录
  const { ExperiencesArchive } = require('../src/experiences-archive');
  const archive = new ExperiencesArchive(dir);
  archive.appendWindowArchive({
    windowNo: 1,
    turns: 100,
    events: [{ eventId: 'evt-w1-1', type: 'message', source: 'user', messageId: 'm-w1-1', payload: { content: '数字生命', roundNo: 1 } }],
    stateChanges: [{ reducer: { stepWeight: 15, maxDelta: 50 } }],
    verifiedEvidence: evidenceWindow1
  });
  archive.appendWindowArchive({
    windowNo: 2,
    turns: 100,
    events: [{ eventId: 'evt-w2-1', type: 'message', source: 'user', messageId: 'm-w2-1', payload: { content: '数字生命', roundNo: 2 } }],
    stateChanges: [{ reducer: { stepWeight: 15, maxDelta: 50 } }],
    verifiedEvidence: evidenceWindow2
  });
  const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  archive.updateProvenanceAttestations([
    { messageId: 'm-w1-1', sourceContentHash: hash('数字生命'), windowNo: 1, sourceRole: 'user', attestedAt: 1100 },
    { messageId: 'm-w2-1', sourceContentHash: hash('数字生命'), windowNo: 2, sourceRole: 'user', attestedAt: 1200 }
  ], [
    ...evidenceWindow1.map(ev => ({ evidenceId: ev.evidenceId, fingerprint: ev.fingerprint, messageId: ev.messageId, quoteHash: hash(ev.quote), windowNo: 1 })),
    ...evidenceWindow2.map(ev => ({ evidenceId: ev.evidenceId, fingerprint: ev.fingerprint, messageId: ev.messageId, quoteHash: hash(ev.quote), windowNo: 2 }))
  ]);

  const mockArchiveRecords = archive.readAll();

  const replayResult = SubjectState.replay(mockArchiveRecords, { archivePath: archive.path });
  check('Replay 成功执行且状态完整', replayResult.replayStatus === 'complete');
  check('Replay 最终状态 philosophical_curiosity 与初始一致 (净变化 0)', replayResult.finalState.philosophical_curiosity === DEFAULT_TRAITS.philosophical_curiosity);
  check('Replay 最终状态 attachment_need 与初始一致 (净变化 0)', replayResult.finalState.attachment_need === DEFAULT_TRAITS.attachment_need);
  check('Replay 与连续运行状态演化完全一致',
    replayResult.windowStates[0].deltas.philosophical_curiosity === w1Res.deltas.philosophical_curiosity &&
    replayResult.windowStates[1].deltas.philosophical_curiosity === w2Res.deltas.philosophical_curiosity);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// P0-03: StateChange 深度语义一致性（数量一致 ≠ 因果一致）
// -------------------------------------------------------------
{
  const { canonicalizeStateChange } = require('../src/subject-state');
  const mkSc = (over = {}) => Object.assign({
    stateChangeId: 'sc-000001',
    changeId: 'sc-000001',
    windowNo: 1,
    trait: 'quiet_preference',
    previousValue: 0,
    delta: 20,
    newValue: 20,
    evidenceIds: ['ev-1'],
    roundingMode: 'symmetric',
    baseStepWeight: 20,
    effectiveStepWeight: 20,
    plasticityMultiplier: 1,
    reducer: { stepWeight: 20, baseStepWeight: 20, effectiveStepWeight: 20, plasticityMultiplier: 1, maxDelta: 50, roundingMode: 'symmetric' },
    createdAt: 1000
  }, over);

  const baseValues = { quiet_preference: 20 };
  const mkReport = (stateChanges, integrity = 'certified') => ({
    finalState: { ...baseValues },
    nextWindowNo: 2,
    acceptedEvidenceIds: ['ev-1'],
    stateChanges,
    integrity,
    replayStatus: 'complete'
  });
  const mkPersisted = (stateChanges) => ({
    values: { ...baseValues },
    windowNo: 2,
    seenEvidenceIds: ['ev-1'],
    stateChanges
  });
  const run = (pSc, rSc, integrity) => SubjectState.checkConsistency(mkPersisted(pSc), mkReport(rSc, integrity));

  const c1 = run([mkSc()], [mkSc()]);
  check('P0-03 完全相同 -> PASS (match & certified)', c1.match === true && c1.stateChangesMatch === true && c1.certified === true && c1.status === 'PASS');

  const c2 = run([mkSc()], [mkSc({ stateChangeId: 'sc-replay-9', changeId: 'sc-replay-9', createdAt: 9999 })]);
  check('P0-03 仅 stateChangeId/createdAt 不同 -> PASS（Replay 可用新确定性 ID）', c2.match === true && c2.certified === true);

  const c3 = run([mkSc()], [mkSc({ delta: 21 })]);
  check('P0-03 仅 delta 不同 -> MISMATCH', c3.match === false && c3.stateChangesMatch === false && c3.stateChangeDiffs.length > 0);

  const c4 = run([mkSc()], [mkSc({ previousValue: -1 })]);
  check('P0-03 仅 previousValue 不同 -> MISMATCH', c4.match === false && c4.stateChangesMatch === false);

  const c5 = run([mkSc()], [mkSc({ newValue: 21 })]);
  check('P0-03 仅 newValue 不同 -> MISMATCH', c5.match === false && c5.stateChangesMatch === false);

  const c6 = run([mkSc()], [mkSc({ evidenceIds: ['ev-2'] })]);
  check('P0-03 仅 evidenceIds 不同 -> MISMATCH', c6.match === false && c6.stateChangesMatch === false);

  const c7 = run([mkSc()], [mkSc({ reducer: { stepWeight: 15, baseStepWeight: 20, effectiveStepWeight: 20, plasticityMultiplier: 1, maxDelta: 50, roundingMode: 'symmetric' } })]);
  check('P0-03 仅 reducer 参数不同 -> MISMATCH', c7.match === false && c7.stateChangesMatch === false);

  const scA = mkSc({ stateChangeId: 'sc-a', trait: 'quiet_preference', evidenceIds: ['ev-1'] });
  const scB = mkSc({ stateChangeId: 'sc-b', trait: 'vitality', evidenceIds: ['ev-2'] });
  const c8 = run([scA, scB], [scB, scA]);
  check('P0-03 顺序不同 -> MISMATCH（StateChange 顺序属于因果轨迹）', c8.match === false && c8.stateChangesMatch === false);

  const c9 = run([mkSc()], [mkSc()], 'uncertified');
  check('P0-03 match=true 但 replay integrity=uncertified -> certified=false (NOT_CERTIFIED)',
    c9.match === true && c9.certified === false && c9.status === 'NOT_CERTIFIED');
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
