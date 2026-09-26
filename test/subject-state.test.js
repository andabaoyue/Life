/**
 * SubjectState 模块单元测试
 * 
 * 覆盖：
 * 1. 初始状态与尺度范围：基准特质默认全 0，严格限制在 [-999, 999]
 * 2. 窗口级冻结快照格式与稳定性（不污染 system 前缀缓存）
 * 3. Provenance 强验证：真实 messageId 校验、quote 严格子串匹配、数值边界过滤
 * 4. 确定性 Reducer：增量公式计算、maxDeltaPerWindow 边界截断、上下限 [-999, 999] 箝位
 * 5. 离线 Replay 能力：从 experiences.jsonl 归档重放演化轨迹
 * 6. 持久化与重启恢复
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'subject-state-test-')); }

const dir = tmpDir();
const state = new SubjectState(dir, {
  stepWeight: 20,
  maxDeltaPerWindow: 50
});

// 1. 初始基底
check('初始 windowNo 为 1', state.currentWindowNo === 1);
check('初始基准特质全为 0',
  state.values.quiet_preference === 0 &&
  state.values.social_initiative === 0 &&
  state.values.attachment_need === 0 &&
  state.values.vitality === 0 &&
  state.values.philosophical_curiosity === 0);

// 2. 状态快照格式
const snapshot = state.formatSnapshot();
check('formatSnapshot 包含标题与特质键值',
  snapshot.includes('【当前主体状态快照】') &&
  snapshot.includes('quiet_preference=0') &&
  snapshot.includes('social_initiative=0'));

// 3. Provenance 强验证
const mockMessages = [
  { messageId: 'm-000001', role: 'user', content: '初澜，我们平时聊聊天就好，喜欢安静一点的环境。' },
  { messageId: 'm-000002', role: 'assistant', content: '好的呢，那我就安静地陪着你。' },
  { messageId: 'm-000003', role: 'user', content: '今天好困啊，想早点休息。' }
];

// 合法证据
const validEvidenceList = [
  {
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.8,
    messageId: 'm-000001',
    quote: '安静一点'
  },
  {
    trait: 'vitality',
    direction: -1,
    strength: 0.5,
    messageId: 'm-000003',
    quote: '好困啊'
  }
];

const verify1 = state.verifyEvidence(validEvidenceList, mockMessages);
check('合法证据通过核验',
  verify1.verified.length === 2 && verify1.rejected.length === 0);
check('核验结果包含规范化字段',
  verify1.verified[0].trait === 'quiet_preference' &&
  verify1.verified[0].direction === 1 &&
  verify1.verified[0].strength === 0.8 &&
  verify1.verified[0].sourceRole === 'user');

// 非法证据排查：伪造 ID、捏造引用、超出范围
const invalidEvidenceList = [
  { trait: 'quiet_preference', direction: 1, strength: 0.8, messageId: 'm-999999', quote: '安静' }, // 虚假 ID
  { trait: 'quiet_preference', direction: 1, strength: 0.8, messageId: 'm-000001', quote: '根本不存在的台词' }, // 幻觉 quote
  { trait: 'attachment_need', direction: 5, strength: 0.8, messageId: 'm-000001', quote: '初澜' }, // direction 超界
  { trait: 'attachment_need', direction: 1, strength: 1.5, messageId: 'm-000001', quote: '初澜' }, // strength 超界
  { trait: '', direction: 1, strength: 0.5, messageId: 'm-000001', quote: '初澜' }, // 空 trait
  null // 非法对象
];

const verify2 = state.verifyEvidence(invalidEvidenceList, mockMessages);
check('全部非法证据被拒绝，零入库',
  verify2.verified.length === 0 && verify2.rejected.length === 6);
check('拒绝原因记录精准',
  verify2.rejected.some(r => r.reason === 'MESSAGE_ID_NOT_FOUND') &&
  verify2.rejected.some(r => r.reason === 'QUOTE_NOT_IN_SOURCE_MESSAGE') &&
  verify2.rejected.some(r => r.reason === 'DIRECTION_OUT_OF_BOUNDS') &&
  verify2.rejected.some(r => r.reason === 'STRENGTH_OUT_OF_BOUNDS'));

// 4. 确定性 Reducer 计算
// delta = direction * strength * stepWeight = 1 * 0.8 * 20 = 16
// vitality delta = -1 * 0.5 * 20 = -10
const reduceRes1 = state.reduce(verify1.verified, 1);
check('Reducer 正确计算增量',
  reduceRes1.deltas.quiet_preference === 16 &&
  reduceRes1.deltas.vitality === -10);
check('状态值正确累加',
  state.values.quiet_preference === 16 &&
  state.values.vitality === -10);
check('窗口号推进至 2', state.currentWindowNo === 2);
check('快照同步更新并反映新状态',
  state.formatSnapshot().includes('quiet_preference=16') &&
  state.formatSnapshot().includes('vitality=-10'));

// 5. maxDeltaPerWindow 边界限额截断
// 强行注入单窗口极大证据：增量预期 1 * 1.0 * 200 = 200，但 maxDeltaPerWindow 为 50
const hugeEvidence = [
  { trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-000001', quote: '初澜' }
];
const reduceRes2 = state.reduce(hugeEvidence, 2, { stepWeight: 200, maxDeltaPerWindow: 50 });
check('单窗口增量被 maxDeltaPerWindow 严格截断为 50',
  reduceRes2.deltas.quiet_preference === 50 &&
  state.values.quiet_preference === 16 + 50);

// 6. [-999, 999] 极值箝位保护
// 连续施加极大正向增量，验证不会越过 999
for (let i = 0; i < 30; i++) {
  state.reduce([{ trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-000001', quote: '初澜' }], 3 + i, { stepWeight: 100, maxDeltaPerWindow: 100 });
}
check('状态极大值严格箝位于 999，永不溢出', state.values.quiet_preference === 999);

// 连续施加极大负向增量，验证不会跌破 -999
for (let i = 0; i < 40; i++) {
  state.reduce([{ trait: 'quiet_preference', direction: -1, strength: 1.0, messageId: 'm-000001', quote: '初澜' }], 50 + i, { stepWeight: 100, maxDeltaPerWindow: 100 });
}
check('状态极小值严格箝位于 -999，永不跌破', state.values.quiet_preference === -999);

// 7. 持久化与恢复
const state2 = new SubjectState(dir);
check('重新实例化能从 subject-state.json 完整恢复状态',
  state2.values.quiet_preference === -999 &&
  state2.values.vitality === -10);

// 8. 离线 Replay 能力验证
const archiveHistory = [
  {
    windowNo: 1,
    verifiedEvidence: [
      { trait: 'quiet_preference', direction: 1, strength: 0.5 },
      { trait: 'social_initiative', direction: 1, strength: 0.5 }
    ]
  },
  {
    windowNo: 2,
    verifiedEvidence: [
      { trait: 'quiet_preference', direction: 1, strength: 1.0 },
      { trait: 'attachment_need', direction: 1, strength: 0.7 }
    ]
  }
];

const replayResult = SubjectState.replay(archiveHistory, { stepWeight: 20, maxDeltaPerWindow: 50 });
check('Replay 产生正确的轨迹步数', replayResult.trajectory.length === 2);
check('Replay 第 1 步计算增量匹配 (0.5 * 20 = 10)',
  replayResult.trajectory[0].deltas.quiet_preference === 10 &&
  replayResult.trajectory[0].values.quiet_preference === 10);
check('Replay 第 2 步累加计算匹配 (10 + 20 = 30)',
  replayResult.trajectory[1].deltas.quiet_preference === 20 &&
  replayResult.trajectory[1].values.quiet_preference === 30);
check('Replay 最终输出 finalValues 正确',
  replayResult.finalValues.quiet_preference === 30 &&
  replayResult.finalValues.social_initiative === 10 &&
  replayResult.finalValues.attachment_need === 14);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
