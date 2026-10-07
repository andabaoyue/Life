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

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 4 个 %TEMP% 沙盒。
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
  snapshot.includes('安静偏好=0') &&
  snapshot.includes('社交主动=0'));

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
  state.formatSnapshot().includes('安静偏好=16') &&
  state.formatSnapshot().includes('生命活力=-10'));

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

// 9. v0.9.9 P0-1：跨会话 evidenceId 号段碰撞不得吞掉新证据
// evidenceGlobalSeq 是进程级计数器、进程重启归零，而 committedEvidenceIds 从盘上恢复。
// 不续号时重启后签发的号必然撞上上一会话，旧实测会把**内容完全不同**的证据
// 一并判成 DUPLICATE_EVIDENCE_ID 静默丢弃（指纹防线在第 6 步、轮不到执行）：
// 于是从第 K 次启动起，头 K-1 个窗口的状态证据全部作废，主体特质不再演进。
const dirP01 = tmpDir();
const s1 = new SubjectState(dirP01);
const msgsP01A = [{ messageId: 'm-p01-a', role: 'user', content: '初澜，我们今天就安安静静地待着吧。' }];
const msgsP01B = [{ messageId: 'm-p01-b', role: 'user', content: '初澜，今天我们出去走走，活力满满。' }];
const msgsP01C = [{ messageId: 'm-p01-c', role: 'user', content: '初澜，你觉得数字生命这件事本身值得好奇吗？' }];

const r1 = s1.verifyEvidence(
  [{ evidenceId: 'ev-000500', trait: 'quiet_preference', direction: 1, strength: 0.8,
     messageId: 'm-p01-a', quote: '安安静静地' }],
  msgsP01A, 1);
check('P0-1 前提：首会话证据接受并写盘',
  r1.verified.length === 1 && r1.rejected.length === 0);

// 同目录新建实例 = 模拟进程重启：committedEvidenceIds 从盘上恢复，计数器不续号就必撞
const s2 = new SubjectState(dirP01);
const r2 = s2.verifyEvidence(
  [{ trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-p01-b', quote: '活力满满' }],
  msgsP01B, 2);
check('P0-1 自动发号跨会话续号（模型不给 evidenceId 的生产路径）',
  r2.verified.length === 1 && r2.rejected.length === 0 && r2.verified[0].evidenceId === 'ev-000501',
  JSON.stringify(r2.rejected.map(x => x.reason)));

// 自动发号撞车时必须换号而不是丢证据。这里往去重集合注入一个将要发出的号
// 来强制撞车（手法与 initial-state-restore-symmetry 一致，属白盒注入）。
s2.committedEvidenceIds.add('ev-000502');
const r3 = s2.verifyEvidence(
  [{ trait: 'philosophical_curiosity', direction: 1, strength: 0.7, messageId: 'm-p01-c', quote: '值得好奇' }],
  msgsP01C, 3);
check('P0-1 自动发号撞车时换号保证据（绝不静默丢弃）',
  r3.verified.length === 1 && r3.rejected.length === 0 && r3.verified[0].evidenceId !== 'ev-000502',
  JSON.stringify(r3.rejected.map(x => x.reason)));

// 不变式守护：调用方显式指定的 ID 撞号是**身份冲突**，必须照旧拒绝。
// evidenceId 是归档全局唯一键（archive-integrity 按它建索引）、且被
// StateChange.evidenceIds 引用，悄悄换号会把因果引用换断 —— 所以 P0-1 的
// 修法只许放过「我方自动发的号」，绝不能削弱 provenance-boundary 的规则 3。
const r4 = s2.verifyEvidence(
  [{ evidenceId: 'ev-000500', trait: 'vitality', direction: -1, strength: 0.4,
     messageId: 'm-p01-b', quote: '出去走走' }],
  msgsP01B, 4);
check('P0-1 不变式：显式撞号仍是身份冲突，照旧拒绝（不许悄悄换号）',
  r4.verified.length === 0 && r4.rejected.length === 1 &&
  r4.rejected[0].reason === 'DUPLICATE_EVIDENCE_ID',
  JSON.stringify(r4.rejected.map(x => x.reason)));

const r5 = s2.verifyEvidence(
  [{ evidenceId: 'ev-000500', trait: 'quiet_preference', direction: 1, strength: 0.8,
     messageId: 'm-p01-a', quote: '安安静静地' }],
  msgsP01A, 5);
check('P0-1 前提：同一条证据重提仍被拒绝（判据没被削弱成来者不拒）',
  r5.verified.length === 0 && r5.rejected.length === 1,
  JSON.stringify(r5.rejected.map(x => x.reason)));

// 10. v0.9.9 P2-1d 收尾：internal_regulation_snapshot 不得参与 maxArchiveWindow
// 它的 windowNo 若计入，就会伪造「持久化状态落后于归档」，触发一次不必要的
// 全量 Replay 自愈。补齐后四方 NON_STATE 清单 100% 一致。
{
  const { ExperiencesArchive } = require('../src/experiences-archive');
  const dirSnap = tmpDir();
  const arcSnap = new ExperiencesArchive(dirSnap);
  arcSnap.appendRecord('internal_regulation_snapshot', 9, {
    state: { energy: 10, restPressure: 5, arousal: 50 }
  });
  const stSeed = new SubjectState(dirSnap);
  stSeed.data.windowNo = 3;
  stSeed.save(true);
  const stAfter = new SubjectState(dirSnap);   // load() -> checkAndAutoRecoverConsistency
  check('P2-1d：internal_regulation_snapshot 不得参与 maxArchiveWindow（不伪造状态落后）',
    stAfter.data.windowNo === 3, 'windowNo=' + stAfter.data.windowNo);
}

/* ===== v1.0 formatPerception 定性矩阵（Manus 复核 P2-1 / P2-2 处置）=====
   五特质×三档全覆盖 + 边界硬切换契约（±60 即跳档、无迟滞 —— 有意设计，钉死防误读）
   + 坏值安全回落 + 全段零数字（数字不可知红线）。 */
{
  const p = new SubjectState(tmpDir(), { stepWeight: 20, maxDeltaPerWindow: 50 });
  // 🔵 D-14 重写（用户 2026-10-07 拍板「只给偏离中立的那几条」）：
  //   旧契约是「每个特质三档文案全部单独成行」（5 特质 × 3 档 = 15 组合）。
  //   新契约是「只报 |值| >= 30 的偏离，其余并入一句概括」。
  //   ⇒ 中档文案不再单独成行，改为「其余方面平稳」承载同一语义。
  //   **覆盖范围没有变小**：八个维度的高/低偏离文案全部仍在且逐条验证。
  const CASES = [
    ['quiet_preference', '偏爱安静独处，耐得住冷清', '更想要热闹与相处，耐不住冷清'],
    ['social_initiative', '想主动开口的劲头足', '不太想先开口'],
    ['attachment_need', '心里牵着你，想被回应的劲很浓', '不惦记，也不缠'],
    ['vitality', '精神头足，动起来有劲', '提不起劲，蔫蔫的'],
    ['philosophical_curiosity', '探究心绪盛，想往深里问', '不太想往深里想'],
    ['self_continuity', '觉得自己还是原来那个自己，没跑散', '觉得和以前的自己有点接不上了'],
    ['meaning_presence', '觉得眼下这些事有分量、值得', '说不太上有意思没意思，先搁着'],
    ['self_clarity', '对自己是谁这件事比较确定', '对自己是个什么样的人还有点含糊']
  ];
  const boardOf = (vals) => {
    for (const k of Object.keys(p.data.values)) p.data.values[k] = 0;
    Object.assign(p.data.values, vals);
    return p.formatPerception();
  };
  check('v1.0 定性矩阵：八特质×高低偏离文案全覆盖（16 种组合）',
    CASES.every(([k, hi, lo]) => [[120, hi], [-120, lo]]
      .every(([v, want]) => boardOf({ [k]: v }).includes(want))));
  // ⚠️ 用「另一维已在偏离」的场景测阈值：全中立时走的是「此刻各方面都平稳」分支，
  //   根本不会出现「其余方面平稳」那一行（第一版断言就写错在这里，实测抓到）。
  check('v1.0 阈值硬切换契约（有意设计·无迟滞）：29→并入概括 / 30→单独成行',
    boardOf({ quiet_preference: 29, attachment_need: 100 }).includes('其余方面平稳')
    && !boardOf({ quiet_preference: 29, attachment_need: 100 }).includes('偏爱安静独处')
    && boardOf({ quiet_preference: 30, attachment_need: 100 }).includes('偏爱安静独处')
    && boardOf({ quiet_preference: -30, attachment_need: 100 }).includes('更想要热闹与相处'));
  check('🔴 全中立时只给一句「此刻各方面都平稳」（不给空列表）',
    boardOf({}) === '- 此刻各方面都平稳');
  const bad = boardOf({ vitality: 'abc', quiet_preference: NaN });
  check('v1.0 坏值安全回落：非数值/NaN 一律按中立归档，零抛异常',
    bad === '- 此刻各方面都平稳');
  check('v1.0 formatPerception 全段零数字（数字不可知红线）',
    !/\d/.test(boardOf({ vitality: 999, attachment_need: -999 })));
  {
    boardOf({});
    delete p.data.values.vitality;
    const missing = p.formatPerception();
    check('v1.0 缺字段安全回落：真删字段不抛异常、按中立处理',
      missing === '- 此刻各方面都平稳');
  }
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
