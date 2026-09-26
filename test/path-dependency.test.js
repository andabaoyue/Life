/**
 * test/path-dependency.test.js
 * 
 * Life Phase 0.5 路径依赖性与发育轨迹不可交换性专项测试 (Path Dependency & History Matters)
 * 
 * 核心验证：
 * 1. 稳态动力学路径依赖性：
 *    - 顺序 1 (高压交互 A -> 入睡休息 B -> 轻度互动 C)
 *    - 顺序 2 (轻度互动 C -> 入睡休息 B -> 高压交互 A)
 *    - 尽管输入刺激总量完全相同，终态 energy, restPressure, arousal 具有严格可测的不对称性 (A->B->C ≠ C->B->A)
 *    - 行为调度倾向发生分化 (Sequence 2 疲劳与哈欠倾向显著高于 Sequence 1)
 * 2. 沃丁顿发育景观路径依赖性：
 *    - 幼态期 (Window 1) 证据冲击产生大幅状态跃迁
 *    - 成熟期 (Window 10) 相同强度证据受到渠道化深沟阻尼，步长显著收窄
 * 3. 自传体账本假说证伪压力与历史保存 (Decision D-005):
 *    - 反向证据累积提升 revisionPressure 并折损 confidence
 *    - 原始支持证据绝对不被物理抹除
 * 4. 基线模式隔离不变量 (Baseline Invariant)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { InternalRegulationManager } = require('../src/internal-regulation');
const { BehaviorScheduler } = require('../src/behavior-scheduler');
const { SubjectState } = require('../src/subject-state');
const { SelfLedger, calculateRevisionPressure } = require('../src/self-ledger');
const { ANIMATION_STATES } = require('../src/animation-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function makeTempDir() {
  const d = path.join(os.tmpdir(), 'life-path-dep-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ==========================================
// 1. 内稳态动力学路径依赖性 (A->B->C vs C->B->A)
// ==========================================
const dir1 = makeTempDir();
const dir2 = makeTempDir();

const reg1 = new InternalRegulationManager(dir1);
const reg2 = new InternalRegulationManager(dir2);

// 定义三种标准化刺激段：
// A: 高强度高密集度长对话 (连续 15 轮长输入)
function applyStimulusA(manager) {
  for (let i = 0; i < 15; i++) {
    manager.updateOnInteractionTurn({ role: 'user', messageLength: 200, intervalMs: 1000 });
    manager.updateOnInteractionTurn({ role: 'assistant', messageLength: 150 });
  }
}

// B: 深度睡眠恢复
function applyStimulusB(manager) {
  manager.updateOnSleep(true);
  manager.updateOnSleep(false);
}

// C: 轻度低频日常问候 (2 轮短文本，间隔长)
function applyStimulusC(manager) {
  manager.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 10 * 60 * 1000 });
  manager.updateOnInteractionTurn({ role: 'assistant', messageLength: 30 });
  manager.updateOnInteractionTurn({ role: 'user', messageLength: 15, intervalMs: 5 * 60 * 1000 });
  manager.updateOnInteractionTurn({ role: 'assistant', messageLength: 20 });
}

// 运行 Sequence 1: A -> B -> C
applyStimulusA(reg1);
applyStimulusB(reg1);
applyStimulusC(reg1);
const term1 = reg1.getState();

// 运行 Sequence 2: C -> B -> A
applyStimulusC(reg2);
applyStimulusB(reg2);
applyStimulusA(reg2);
const term2 = reg2.getState();

check('刺激总量相同时终态能量产生显著不对称性 (Sequence 1 energy > Sequence 2 energy)',
  term1.energy > term2.energy,
  `Seq1(A->B->C)=${term1.energy}, Seq2(C->B->A)=${term2.energy}`
);

check('刺激总量相同时终态疲劳压力产生显著不对称性 (Sequence 1 restPressure < Sequence 2 restPressure)',
  term1.restPressure < term2.restPressure,
  `Seq1=${term1.restPressure}, Seq2=${term2.restPressure}`
);

check('刺激总量相同时终态唤醒度具备严格路径依赖性 (Sequence 1 arousal < Sequence 2 arousal)',
  term1.arousal < term2.arousal,
  `Seq1=${term1.arousal}, Seq2=${term2.arousal}`
);

// 行为选择倾向在不同路径下的分化
const sched1 = new BehaviorScheduler();
sched1.setInternalRegulation(reg1);
const w1 = sched1.getModulatedWeights();

const sched2 = new BehaviorScheduler();
sched2.setInternalRegulation(reg2);
const w2 = sched2.getModulatedWeights();

check('路径依赖传导至行为倾向：Sequence 2 的打哈欠权重显著高于 Sequence 1',
  w2[ANIMATION_STATES.YAWN] > w1[ANIMATION_STATES.YAWN],
  `w1[yawn]=${w1[ANIMATION_STATES.YAWN]}, w2[yawn]=${w2[ANIMATION_STATES.YAWN]}`
);

// ==========================================
// 2. 沃丁顿发育景观路径依赖性 (Early vs Late)
// ==========================================
const subDirEarly = makeTempDir();
const subDirLate = makeTempDir();

const stateEarly = new SubjectState(subDirEarly, {
  stepWeight: 20,
  maxDeltaPerWindow: 50,
  experimentModules: { biographicalCanalization: true }
});

const stateLate = new SubjectState(subDirLate, {
  stepWeight: 20,
  maxDeltaPerWindow: 50,
  experimentModules: { biographicalCanalization: true }
});

const evidenceItem = [{
  evidenceId: 'ev-path-001',
  messageId: 'm-000001',
  quote: '偏好安静',
  trait: 'quiet_preference',
  direction: 1,
  strength: 1
}];

// Window 1 幼态期演进
const redEarly = stateEarly.reduce(evidenceItem, 1, {
  stageOnly: true,
  canalization: true
});

// Window 10 沉淀期演进
const redLate = stateLate.reduce(evidenceItem, 10, {
  stageOnly: true,
  canalization: true
});

const scEarly = redEarly.stateChanges[0];
const scLate = redLate.stateChanges[0];

check('幼态期塑性显著高于成熟期 (plasticityMultiplier: Early > Late)',
  scEarly.plasticityMultiplier > scLate.plasticityMultiplier,
  `Early=${scEarly.plasticityMultiplier}, Late=${scLate.plasticityMultiplier}`
);

check('同一证据在早期产生的状态增量 delta 显著大于后期',
  scEarly.delta >= scLate.delta && scEarly.effectiveStepWeight > scLate.effectiveStepWeight,
  `EarlyDelta=${scEarly.delta} (weight=${scEarly.effectiveStepWeight}), LateDelta=${scLate.delta} (weight=${scLate.effectiveStepWeight})`
);

// ==========================================
// 3. 自传体账本假说证伪压力与历史无损保存 (Decision D-005)
// ==========================================
const ledgerDir = makeTempDir();
const ledger = new SelfLedger(ledgerDir);

// 登记初始正向支持条目
ledger.append({
  trait: '喜欢喝热可可',
  support: [{
    sourceType: 'USER',
    quote: '初澜说喜欢热可可',
    confidence: 0.9
  }]
});

const initMetrics = ledger.getEntryMetrics('喜欢喝热可可');
check('初始支持证据条目具备高置信度且无反思压力',
  initMetrics.confidence > 0.8 && initMetrics.revisionPressure === 0,
  `conf=${initMetrics.confidence}, pressure=${initMetrics.revisionPressure}`
);

// 注入反向证据（在后续窗口中记录不爱喝可可的事实）
const recRes = ledger.recordOpposingEvidence('喜欢喝热可可', {
  sourceType: 'EXPERIENCE',
  quote: '今天尝了一口觉得太甜不爱喝了',
  confidence: 0.9
});

check('追加反向证据成功应用证伪压力', recRes.updated === true);
const postMetrics = ledger.getEntryMetrics('喜欢喝热可可');

check('反向证据积累导致反思压力上升 (revisionPressure > 0)', postMetrics.revisionPressure > 0.3, `pressure=${postMetrics.revisionPressure}`);
check('反向证据累积导致有效置信度显著折扣衰减 (confidence < init)', postMetrics.confidence < initMetrics.confidence, `init=${initMetrics.confidence}, post=${postMetrics.confidence}`);

// 铁律检查 (Decision D-005): 原始支持证据绝对不被物理抹除
const entry = ledger.entries.find(e => e.trait === '喜欢喝热可可');
check('反思修正过程中原始支持证据 100% 物理留存 (Decision D-005: 遗忘不删除历史)',
  entry.support.length === 1 && entry.support[0].quote === '初澜说喜欢热可可' && entry.oppose.length === 1
);

// CurrentSelf 渲染包含反思提示
const currentSelf = ledger.currentSelfText();
check('CurrentSelf 有限投影如实呈现反思压力标记',
  currentSelf.includes('喜欢喝热可可') && currentSelf.includes('反思压力')
);

// ==========================================
// 4. 基线模式守恒隔离 (Baseline Invariance)
// ==========================================
const baseDir = makeTempDir();
const baseReg = new InternalRegulationManager(baseDir, { enabled: false });
const baseS0 = baseReg.getState();
applyStimulusA(baseReg);
applyStimulusC(baseReg);
const baseS1 = baseReg.getState();

check('基线隔离模式下无论施加何种输入序列，内部状态恒定保持基线不变',
  baseS0.energy === baseS1.energy && baseS0.restPressure === baseS1.restPressure && baseS0.arousal === baseS1.arousal
);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
