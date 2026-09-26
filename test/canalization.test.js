/**
 * test/canalization.test.js
 * 
 * Life v0.9.7 沃丁顿发育景观与经历依赖塑性衰减专项测试
 * 
 * 检验点：
 * 1. 塑性乘子单调递减：W=0 时为 1.0，随 W 增长 strictly 递减
 * 2. 模块禁用 / Baseline 模式下塑性乘子严格恒为 1.0 (基线零干预不变量)
 * 3. 发展阶段枚举正确映射 (JUVENILE -> DEVELOPMENTAL -> STABILIZED)
 * 4. StateChange 完整记录 baseStepWeight、effectiveStepWeight、plasticityMultiplier
 * 5. 相同 Evidence 在 Window 1 与 Window 30 下产生不同 effectiveStepWeight 与阻尼效果
 * 6. 确定性 Replay 严格还原历史落盘发育参数，达到 100% 确定性重现
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  computePlasticityMultiplier,
  computeEffectiveStepWeight,
  getDevelopmentalStage,
  getCanalizationMetrics,
  DEVELOPMENTAL_STAGES,
  DEFAULT_CANALIZATION_GAMMA
} = require('../src/canalization');
const { SubjectState } = require('../src/subject-state');
const { createStateChange } = require('../src/state-change');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'canalization-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. 塑性乘子代数计算与单调衰减
// -------------------------------------------------------------
{
  check('默认 gamma 为 0.25', DEFAULT_CANALIZATION_GAMMA === 0.25);

  const m0 = computePlasticityMultiplier(0);
  check('W=0 时塑性乘子严格为 1.0', m0 === 1.0);

  const m1 = computePlasticityMultiplier(1);
  const m5 = computePlasticityMultiplier(5);
  const m10 = computePlasticityMultiplier(10);
  const m30 = computePlasticityMultiplier(30);
  const m100 = computePlasticityMultiplier(100);

  check('m1 < m0', m1 < m0, `m0=${m0}, m1=${m1}`);
  check('m5 < m1', m5 < m1, `m1=${m1}, m5=${m5}`);
  check('m10 < m5', m10 < m5, `m5=${m5}, m10=${m10}`);
  check('m30 < m10', m30 < m10, `m10=${m10}, m30=${m30}`);
  check('m100 < m30', m100 < m30, `m30=${m30}, m100=${m100}`);

  check('禁用状态下塑性乘子恒为 1.0', computePlasticityMultiplier(50, { enabled: false }) === 1.0);

  // 步长衰减计算
  const eff0 = computeEffectiveStepWeight(20, 0);
  const eff30 = computeEffectiveStepWeight(20, 30);
  check('W=0 有效步长等于 20', eff0 === 20);
  check('W=30 有效步长显著衰减低于 15', eff30 < 15, `eff30=${eff30}`);
}

// -------------------------------------------------------------
// 2. 发育阶段划分映射
// -------------------------------------------------------------
{
  check('Window 1 为幼态期 JUVENILE', getDevelopmentalStage(1) === DEVELOPMENTAL_STAGES.JUVENILE);
  check('Window 5 为幼态期 JUVENILE', getDevelopmentalStage(5) === DEVELOPMENTAL_STAGES.JUVENILE);
  check('Window 6 进入发育期 DEVELOPMENTAL', getDevelopmentalStage(6) === DEVELOPMENTAL_STAGES.DEVELOPMENTAL);
  check('Window 30 仍为发育期 DEVELOPMENTAL', getDevelopmentalStage(30) === DEVELOPMENTAL_STAGES.DEVELOPMENTAL);
  check('Window 31 进入稳定个体化期 STABILIZED', getDevelopmentalStage(31) === DEVELOPMENTAL_STAGES.STABILIZED);
  check('Window 100 为稳定个体化期 STABILIZED', getDevelopmentalStage(100) === DEVELOPMENTAL_STAGES.STABILIZED);

  const metrics = getCanalizationMetrics(10, 20);
  check('metrics 包含完备发育参数结构', metrics.stage === DEVELOPMENTAL_STAGES.DEVELOPMENTAL && metrics.effectiveStepWeight > 0);
}

// -------------------------------------------------------------
// 3. StateChange 记录与 SubjectState Reducer 集成
// -------------------------------------------------------------
{
  const sc = createStateChange({
    windowNo: 15,
    trait: 'warmth',
    previousValue: 50,
    delta: 10,
    baseStepWeight: 20,
    effectiveStepWeight: 12.5,
    plasticityMultiplier: 0.625
  });

  check('StateChange 包含 baseStepWeight', sc.baseStepWeight === 20);
  check('StateChange 包含 effectiveStepWeight', sc.effectiveStepWeight === 12.5);
  check('StateChange 包含 plasticityMultiplier', sc.plasticityMultiplier === 0.625);
  check('reducer 嵌套对象保留 plasticityMultiplier', sc.reducer.plasticityMultiplier === 0.625);
}

// -------------------------------------------------------------
// 4. SubjectState.reduce 在幼态 vs 成熟期对比与基线零干预
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const state = new SubjectState(dir);

  // 4.1 基线对照组（canalization: false）：Window 1 与 Window 30 步长严格一致
  const ev1 = [{ evidenceId: 'ev-b1', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-1', quote: 'test' }];
  const ev2 = [{ evidenceId: 'ev-b2', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-2', quote: 'test' }];

  state.reduce(ev1, 1, { canalization: false, stepWeight: 20 });
  state.reduce(ev2, 30, { canalization: false, stepWeight: 20 });
  check('基线模式下无论 Window 多少，effectiveStepWeight 严格等于 baseStepWeight',
    state.data.stateChanges[0].effectiveStepWeight === 20 &&
    state.data.stateChanges[1].effectiveStepWeight === 20
  );

  // 4.2 实验组（canalization: true）：Window 1 塑性为 1.0，Window 30 塑性显著降低
  const ev3 = [{ evidenceId: 'ev-exp1', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-3', quote: 'test' }];
  const ev4 = [{ evidenceId: 'ev-exp2', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-4', quote: 'test' }];

  state.reduce(ev3, 1, { canalization: true, stepWeight: 20 });
  const expChangeW1 = state.data.stateChanges[state.data.stateChanges.length - 1];

  state.reduce(ev4, 30, { canalization: true, stepWeight: 20 });
  const expChangeW30 = state.data.stateChanges[state.data.stateChanges.length - 1];

  check('实验组 Window 1 塑性乘子为 1.0', expChangeW1.plasticityMultiplier === 1.0);
  check('实验组 Window 30 塑性乘子严格小于 1.0', expChangeW30.plasticityMultiplier < 1.0, `actual: ${expChangeW30.plasticityMultiplier}`);
  check('实验组 Window 30 有效步长显著小于 Window 1', expChangeW30.effectiveStepWeight < expChangeW1.effectiveStepWeight);

  // 4.3 离线 Replay 验证：Replay 使用历史记录参数，不重新猜测
  const mockArchiveRecords = [
    {
      recordType: 'window_summary',
      archiveSeq: 1,
      windowNo: 30,
      payload: {
        windowNo: 30,
        verifiedEvidence: ev4,
        stateChanges: [expChangeW30]
      }
    }
  ];

  const replayResult = SubjectState.replay(mockArchiveRecords);
  check('Replay 成功推演', replayResult && replayResult.replayStatus === 'complete');
  check('Replay 提取的历史 StateChange 保持原有 effectiveStepWeight',
    replayResult.stateChanges[0].effectiveStepWeight === expChangeW30.effectiveStepWeight
  );

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
