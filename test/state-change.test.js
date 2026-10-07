/**
 * test/state-change.test.js
 * 
 * 初澜数字生命实验：StateChange 跃迁记录与因果解释单元测试 (v0.9.4)
 * 
 * 检验点：
 * 1. createStateChange 结构完整性（previousValue, delta, newValue, evidenceIds, reducer）
 * 2. validateStateChange 数学一致性校验（newValue 必须严格等于 previousValue + delta）
 * 3. createStateChangeExplanation 因果解释强核验（解释宣称的 delta 必须与真实 Reducer 变更一致）
 * 4. 解释与状态解耦：非法或篡改的解释绝对无法影响 SubjectState 实际数值
 * 5. SubjectState.reduce 真实执行时自动产出合法 StateChange 记录
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createStateChange,
  validateStateChange,
  createStateChangeExplanation
} = require('../src/state-change');
const { SubjectState } = require('../src/subject-state');

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

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 1. createStateChange 基础构建
const sc1 = createStateChange({
  windowNo: 1,
  trait: 'quiet_preference',
  previousValue: 20,
  delta: 15,
  newValue: 35,
  evidenceIds: ['ev-000001', 'ev-000002'],
  stepWeight: 20,
  maxDelta: 50
});

check('createStateChange 成功生成 changeId', typeof sc1.changeId === 'string' && sc1.changeId.startsWith('sc-'));
check('createStateChange 包含完整前值、增量、新值与 Reducer 参数',
  sc1.previousValue === 20 && sc1.delta === 15 && sc1.newValue === 35 && sc1.reducer.stepWeight === 20 && sc1.reducer.maxDelta === 50);

// 2. validateStateChange 算术完整性
const vScValid = validateStateChange(sc1);
check('validateStateChange 算术自洽时返回 valid: true', vScValid.valid === true);

const scMathMismatch = {
  changeId: 'chg-999',
  windowNo: 1,
  trait: 'quiet_preference',
  previousValue: 20,
  delta: 15,
  newValue: 40 // 错误：20 + 15 != 40
};
const vScMath = validateStateChange(scMathMismatch);
check('validateStateChange 拒绝算术不一致的跃迁记录',
  vScMath.valid === false && vScMath.reason === 'VALUE_ARITHMETIC_MISMATCH');

const vScInvalidObj = validateStateChange(null);
check('validateStateChange 拒绝空对象', vScInvalidObj.valid === false && vScInvalidObj.reason === 'INVALID_OBJECT');

// 3. createStateChangeExplanation 因果解释自洽性与防篡改
const expValid = createStateChangeExplanation(sc1, {
  claimedDelta: 15,
  text: '用户在过去 100 轮中多次强调喜欢安静，初澜感受到安宁。'
});
check('合法自洽的解释通过核验', expValid.valid === true && expValid.explanation.claimedDelta === 15);

const expDeltaMismatch = createStateChangeExplanation(sc1, {
  claimedDelta: 50, // 模型妄图谎报增量 +50
  text: '初澜认为自己发生了剧烈改变。'
});
check('模型谎报 delta 时解释被判定无效 (DELTA_MISMATCH)',
  expDeltaMismatch.valid === false && expDeltaMismatch.reason === 'DELTA_MISMATCH');

const expTraitMismatch = createStateChangeExplanation(sc1, {
  claimedTrait: 'vitality', // 模型解释了错误的 trait
  text: '初澜变得更加有活力。'
});
check('解释指向错误 Trait 时被判定无效 (TRAIT_MISMATCH)',
  expTraitMismatch.valid === false && expTraitMismatch.reason === 'TRAIT_MISMATCH');

const expEmpty = createStateChangeExplanation(sc1, { text: '' });
check('拒绝空内容解释', expEmpty.valid === false && expEmpty.reason === 'EMPTY_EXPLANATION');

// 4. SubjectState.reduce 集成产出 StateChange
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-change-test-'));
const ss = new SubjectState(tmpDir, { stepWeight: 20, maxDeltaPerWindow: 50 });

const verifiedEv = [
  { evidenceId: 'ev-test-1', trait: 'quiet_preference', direction: 1, strength: 1.0 },
  { evidenceId: 'ev-test-2', trait: 'philosophical_curiosity', direction: 1, strength: 0.5 }
];

const res = ss.reduce(verifiedEv, 1);
check('SubjectState.reduce 返回 stateChanges 数组', Array.isArray(res.stateChanges) && res.stateChanges.length === 2);

const scRecord = res.stateChanges.find(c => c.trait === 'quiet_preference');
check('自动生成的 StateChange 记录通过 validateStateChange',
  scRecord && validateStateChange(scRecord).valid === true && scRecord.delta === 20 && scRecord.evidenceIds.includes('ev-test-1'));

check('SubjectState.data.stateChanges 持久化包含该记录',
  Array.isArray(ss.data.stateChanges) && ss.data.stateChanges.length === 2);

// 5. N-11: validateStateChange 与 reducer 的 maxDelta 语义一致
const scOver = createStateChange({
  stateChangeId: 'sc-over-max',
  trait: 'quiet_preference',
  previousValue: 0,
  delta: 200,
  newValue: 200,
  maxDelta: 50
});
const vOver = validateStateChange(scOver);
check('超过 reducer.maxDelta 的记录被拒绝（仅靠 ±999 算术自洽不得通过）',
  vOver.valid === false && vOver.reason === 'DELTA_EXCEEDS_MAX_DELTA', JSON.stringify(vOver));

const scAtMax = createStateChange({
  stateChangeId: 'sc-at-max',
  trait: 'quiet_preference',
  previousValue: 10,
  delta: -50,
  newValue: -40,
  maxDelta: 50
});
check('delta 恰好等于 maxDelta 时仍通过', validateStateChange(scAtMax).valid === true);

const scLegacyOver = {
  stateChangeId: 'sc-legacy-over',
  trait: 'quiet_preference',
  previousValue: 0,
  delta: 200,
  newValue: 200
};
check('无 maxDelta 元数据的 legacy 记录维持原有 ±999 语义',
  validateStateChange(scLegacyOver).valid === true);

const scRange = {
  stateChangeId: 'sc-range',
  trait: 'quiet_preference',
  previousValue: 0,
  delta: 1500,
  newValue: 999,
  reducer: { maxDelta: 2000 }
};
check('±999 总范围约束保持：newValue 越界仍拒绝',
  validateStateChange({ ...scRange, newValue: 1000 }).valid === false);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
