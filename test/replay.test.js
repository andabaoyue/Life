/**
 * test/replay.test.js
 * 
 * 初澜数字生命实验：Replay v2 纯离线确定性重放单元测试 (v0.9.4)
 * 
 * 检验点：
 * 1. 空归档安全重放：返回 DEFAULT_TRAITS 且不崩溃
 * 2. 单窗口归档重放：增量与终态正确推演
 * 3. 多窗口累积重放：跨窗口演化序列严格符合 Reducer 规则
 * 4. 边界截断检验：极值约束 [-999, 999] 在重放中严格生效
 * 5. 100 次完全确定性幂等检验：多次重放无任何状态随机漂移
 * 6. replayUntilWindow 局部切片重放
 * 7. replayUntilTimestamp 时间切片重放
 * 8. checkConsistency 状态一致性检测与漂移告警
 * 9. 跨版本归档混编兼容（v0.9.3 window_archive + v0.9.4 window_summary / evidence）
 */

const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 1. 空归档
const emptyReport = SubjectState.replay([]);
check('空归档重放处理 0 条记录', emptyReport.processedRecords === 0);
check('空归档重放返回默认初始状态',
  Object.keys(DEFAULT_TRAITS).every(k => emptyReport.finalState[k] === DEFAULT_TRAITS[k]));

// 2. 单窗口归档
const sampleRecords = [
  {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 1000000,
    payload: {
      verifiedEvidence: [
        { evidenceId: 'ev-001', trait: 'quiet_preference', direction: 1, strength: 1.0 },
        { evidenceId: 'ev-002', trait: 'attachment_need', direction: -1, strength: 0.5 }
      ],
      rejectedEvidence: [
        { evidenceId: 'ev-rej-001', reason: 'QUOTE_NOT_FOUND' }
      ]
    }
  }
];

const report1 = SubjectState.replay(sampleRecords, { stepWeight: 20, maxDeltaPerWindow: 50 });
check('单窗口重放成功推进窗口', report1.windowStates.length === 1 && report1.windowStates[0].windowNo === 1);
check('单窗口状态增量符合预期 (quiet_preference +20, attachment_need -10)',
  report1.finalState.quiet_preference === DEFAULT_TRAITS.quiet_preference + 20 &&
  report1.finalState.attachment_need === DEFAULT_TRAITS.attachment_need - 10);
check('正确统计拒绝证据数量', report1.rejectedRecords === 1);

// 3. 多窗口累积演化
const multiRecords = [
  ...sampleRecords,
  {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 2,
    timestamp: 2000000,
    payload: {
      verifiedEvidence: [
        { evidenceId: 'ev-003', trait: 'quiet_preference', direction: 1, strength: 1.0 }
      ],
      rejectedEvidence: []
    }
  },
  {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 3,
    timestamp: 3000000,
    payload: {
      verifiedEvidence: [
        { evidenceId: 'ev-004', trait: 'philosophical_curiosity', direction: 1, strength: 1.0 }
      ],
      rejectedEvidence: []
    }
  }
];

const reportMulti = SubjectState.replay(multiRecords, { stepWeight: 20, maxDeltaPerWindow: 50 });
check('多窗口累计重放包含 3 个窗口', reportMulti.windowStates.length === 3);
check('quiet_preference 经历两个窗口累积达到 +40',
  reportMulti.finalState.quiet_preference === DEFAULT_TRAITS.quiet_preference + 40);
check('philosophical_curiosity 在第 3 窗口发生跃迁 +20',
  reportMulti.finalState.philosophical_curiosity === DEFAULT_TRAITS.philosophical_curiosity + 20);

// 4. 边界截断 [-999, 999]
const extremeRecords = [];
for (let i = 1; i <= 30; i++) {
  extremeRecords.push({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: i,
    timestamp: i * 1000,
    payload: {
      verifiedEvidence: [
        { evidenceId: `ev-ext-${i}`, trait: 'vitality', direction: 1, strength: 2.5 } // 2.5 * 20 = 50 (max per window)
      ]
    }
  });
}
const reportExtreme = SubjectState.replay(extremeRecords, {
  initialTraits: { ...DEFAULT_TRAITS, vitality: 900 },
  stepWeight: 20,
  maxDeltaPerWindow: 50
});
check('状态上限严格截断于 999 绝不溢出', reportExtreme.finalState.vitality === 999);

// 5. 100 次完全确定性与无副作用检验
let allIdentical = true;
const baselineJson = JSON.stringify(reportMulti.finalState);
for (let i = 0; i < 100; i++) {
  const rerun = SubjectState.replay(multiRecords, { stepWeight: 20, maxDeltaPerWindow: 50 });
  if (JSON.stringify(rerun.finalState) !== baselineJson) {
    allIdentical = false;
    break;
  }
}
check('连续 100 次 Replay 运算完全确定无漂移', allIdentical === true);

// 6. replayUntilWindow 切片重放
const reportW2 = SubjectState.replayUntilWindow(multiRecords, 2, { stepWeight: 20, maxDeltaPerWindow: 50 });
check('replayUntilWindow(2) 仅重放到第 2 窗口', reportW2.windowStates.length === 2);
check('第 3 窗口的跃迁未被执行',
  reportW2.finalState.philosophical_curiosity === DEFAULT_TRAITS.philosophical_curiosity);

// 7. replayUntilTimestamp 切片重放
const reportTs = SubjectState.replayUntilTimestamp(multiRecords, 1500000, { stepWeight: 20, maxDeltaPerWindow: 50 });
check('replayUntilTimestamp(1500000) 仅包含时间戳 <= 1500000 的记录',
  reportTs.windowStates.length === 1 && reportTs.windowStates[0].windowNo === 1);

// 8. checkConsistency 校验器
const matchingPersisted = { values: { ...reportMulti.finalState } };
const matchRes = SubjectState.checkConsistency(matchingPersisted, reportMulti);
check('checkConsistency 一致状态核验通过', matchRes.match === true && matchRes.diffs.length === 0);

const driftedPersisted = {
  values: {
    ...reportMulti.finalState,
    quiet_preference: reportMulti.finalState.quiet_preference + 5 // 发生 5 点漂移
  }
};
const driftRes = SubjectState.checkConsistency(driftedPersisted, reportMulti);
check('checkConsistency 准确捕捉状态漂移',
  driftRes.match === false && driftRes.diffs.length === 1 && driftRes.diffs[0].trait === 'quiet_preference');

// 9. 跨版本混编兼容（v0.9.3 legacy window_archive + v0.9.4 window_summary）
const mixedRecords = [
  {
    type: 'window_archive', // v0.9.3 legacy
    windowNo: 1,
    createdAt: 500,
    verifiedEvidence: [
      { evidenceId: 'ev-legacy-1', trait: 'social_initiative', direction: 1, strength: 1.0 }
    ],
    rejectedEvidence: []
  },
  {
    schemaVersion: 1, // v0.9.4 standard
    recordType: 'window_summary',
    windowNo: 2,
    timestamp: 1500,
    payload: {
      verifiedEvidence: [
        { evidenceId: 'ev-new-2', trait: 'social_initiative', direction: 1, strength: 1.0 }
      ],
      rejectedEvidence: []
    }
  }
];
const reportMixed = SubjectState.replay(mixedRecords, { stepWeight: 20, maxDeltaPerWindow: 50 });
check('跨版本历史归档平滑统一重放',
  reportMixed.windowStates.length === 2 &&
  reportMixed.finalState.social_initiative === DEFAULT_TRAITS.social_initiative + 40);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
