/**
 * test/lifecycle-wiring.test.js
 * 
 * Life Phase 0.5 生产运行时生命动力学闭环收口测试 (Runtime Closure Matrix)
 * 
 * 核心验证矩阵 (Tests A ~ G):
 * - Test A: Behavior Runtime Wiring (Brain.internalRegulation === BehaviorScheduler.internalRegulation 且状态改变影响权重)
 * - Test B: Physical Event Runtime Wiring (click/drag/idle/sleep/wake 经 ActivityTracker 实时直连驱动内态，无需等聊天)
 * - Test C: Digital Umwelt Runtime Wiring (真实活动 -> Perception Candidate -> Attention Gate -> subjectAccessible === false)
 * - Test D: Config Wiring (统一 experimentModules 配置生效与各模块实际联动)
 * - Test E: Baseline Identity (baseline 模式全旁路，行为与状态 100% 保持原生不变)
 * - Test F: Ablation (单模块消融隔离与因果归因清晰)
 * - Test G: Cold Restart (运行 -> 产生状态 -> 关闭 -> 重启 -> 历史事实优先于默认值恢复连续性)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Brain } = require('../src/brain');
const { SubjectState } = require('../src/subject-state');
const { InternalRegulationManager } = require('../src/internal-regulation');
const { BehaviorScheduler } = require('../src/behavior-scheduler');
const { ANIMATION_STATES } = require('../src/animation-state');
const { ActivityTracker } = require('../src/tracker');
const { ArchiveIntegrityService } = require('../src/archive-integrity');
const { ExperiencesArchive } = require('../src/experiences-archive');
const { sanitize } = require('../src/config');
const { runPathDependencyExperiment } = require('../src/path-dependency');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function makeTempDir() {
  const d = path.join(os.tmpdir(), 'life-wiring-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

console.log('=== Life Phase 0.5 生产运行时生命动力学闭环收口测试 ===\n');

// =========================================================================
// Test A: Behavior Runtime Wiring (P0-1)
// 验证 Brain.internalRegulation === BehaviorScheduler.internalRegulation 且状态改变后权重改变
// =========================================================================
console.log('--- Test A: Behavior Runtime Wiring ---');
const dirA = makeTempDir();
const cfgA = {
  experimentMode: 'experimental',
  experimentModules: {
    internalRegulation: true,
    biographicalCanalization: true
  }
};
const brainA = new Brain(dirA, cfgA);
const schedulerA = new BehaviorScheduler();

// 执行权威绑定
brainA.bindBehaviorScheduler(schedulerA);

check('Brain.internalRegulation 与 BehaviorScheduler.internalRegulation 引用同一实例',
  brainA.internalRegulation === schedulerA.internalRegulation && brainA.internalRegulation !== null);

const initialWeightsA = schedulerA.getModulatedWeights();

// 驱动内部稳态发生变化（提高疲劳压力与唤醒度，降低体能）
brainA.internalRegulation.restPressure = 80;
brainA.internalRegulation.energy = 30;
brainA.internalRegulation.arousal = 85;

const modulatedWeightsA = schedulerA.getModulatedWeights();

check('疲劳压力提高后打哈欠 (yawn) 权重显著放大',
  modulatedWeightsA[ANIMATION_STATES.YAWN] > initialWeightsA[ANIMATION_STATES.YAWN],
  `initial=${initialWeightsA[ANIMATION_STATES.YAWN]}, modulated=${modulatedWeightsA[ANIMATION_STATES.YAWN]}`);

check('体能降低后伸懒腰 (stretch) 权重显著放大',
  modulatedWeightsA[ANIMATION_STATES.STRETCH] > initialWeightsA[ANIMATION_STATES.STRETCH],
  `initial=${initialWeightsA[ANIMATION_STATES.STRETCH]}, modulated=${modulatedWeightsA[ANIMATION_STATES.STRETCH]}`);

check('神经唤醒度提高后四处张望 (look_around) 权重显著放大',
  modulatedWeightsA[ANIMATION_STATES.LOOK_AROUND] > initialWeightsA[ANIMATION_STATES.LOOK_AROUND],
  `initial=${initialWeightsA[ANIMATION_STATES.LOOK_AROUND]}, modulated=${modulatedWeightsA[ANIMATION_STATES.LOOK_AROUND]}`);


// =========================================================================
// Test B: Physical Event Runtime Wiring (P0-3)
// 验证 click / drag / idle / sleep / wake 经 ActivityTracker 实时直连驱动内态，无需等聊天
// =========================================================================
console.log('\n--- Test B: Physical Event Runtime Wiring ---');
const dirB = makeTempDir();
const brainB = new Brain(dirB, cfgA);
const trackerB = new ActivityTracker();

// 绑定 tracker 进 brain
brainB.bindTracker(trackerB);

check('tracker 成功直连 brain.internalRegulation 权威实例',
  trackerB.internalRegulation === brainB.internalRegulation);

const stateInitB = brainB.internalRegulation.getState();

// 1. 模拟戳一下
trackerB.record('click');
const stateAfterClickB = brainB.internalRegulation.getState();
check('点击/戳戳事件实时触发 internalRegulation 更新且提升唤醒度',
  stateAfterClickB.arousal > stateInitB.arousal && stateAfterClickB.updatedAt >= stateInitB.updatedAt,
  `arousal: ${stateInitB.arousal} -> ${stateAfterClickB.arousal}`);

// 2. 模拟拖动
trackerB.record('drag');
const stateAfterDragB = brainB.internalRegulation.getState();
check('拖动事件实时触发 internalRegulation 更新并消耗体能',
  stateAfterDragB.energy < stateAfterClickB.energy,
  `energy: ${stateAfterClickB.energy} -> ${stateAfterDragB.energy}`);

// 3. 模拟长时间挂机静默 (25 分钟)
trackerB.recordIdle(25);
const stateAfterIdleB = brainB.internalRegulation.getState();
check('静默挂机事件实时沉降唤醒度并累积微量睡意',
  stateAfterIdleB.arousal < stateAfterDragB.arousal && stateAfterIdleB.restPressure > stateAfterDragB.restPressure,
  `arousal: ${stateAfterDragB.arousal} -> ${stateAfterIdleB.arousal}, restPressure: ${stateAfterDragB.restPressure} -> ${stateAfterIdleB.restPressure}`);

// 4. 模拟入睡
trackerB.enterSleepMode();
const stateAfterSleepB = brainB.internalRegulation.getState();
check('入睡事件实时重置疲劳压力并大幅降低唤醒度',
  stateAfterSleepB.restPressure === 0 && stateAfterSleepB.arousal <= 30,
  `restPressure=${stateAfterSleepB.restPressure}, arousal=${stateAfterSleepB.arousal}`);

// 5. 模拟唤醒
trackerB.wakeUp();
const stateAfterWakeB = brainB.internalRegulation.getState();
check('唤醒事件实时更新唤醒状态',
  stateAfterWakeB.arousal >= 45,
  `arousal=${stateAfterWakeB.arousal}`);


// =========================================================================
// Test C: Digital Umwelt Runtime Wiring (P0-2)
// 验证真实活动事件 -> Perception Candidate -> Attention Gate -> subjectAccessible === false
// =========================================================================
console.log('\n--- Test C: Digital Umwelt Runtime Wiring ---');
const dirC = makeTempDir();
const cfgC = {
  experimentMode: 'experimental',
  experimentModules: {
    digitalUmwelt: true,
    attentionGate: true,
    internalRegulation: true
  }
};
const brainC = new Brain(dirC, cfgC);
const trackerC = new ActivityTracker();
brainC.bindTracker(trackerC);

// 真实物理点击触发完整的环周感知候选与注意闸门流水线
trackerC.record('click');

check('环境感知流水线生成并缓存最近感知候选记录',
  brainC.recentPerceptions.length > 0);

const latestPerception = brainC.recentPerceptions[brainC.recentPerceptions.length - 1];

check('知觉候选单元生成且格式规范',
  latestPerception.candidate && typeof latestPerception.candidate.perceptionId === 'string' &&
  latestPerception.candidate.category === 'tactile_poke');

check('知觉候选严格恪守认识论不变量: subjectAccessible === false',
  latestPerception.candidate.subjectAccessible === false);

check('注意力闸门评估结果结构有效且包含决策状态',
  latestPerception.gateResult && typeof latestPerception.gateResult.status === 'string');

check('注意力闸门结果严格恪守认识论不变量: subjectAccessible === false (ATTENDED ≠ SUBJECT_ACQUIRED)',
  latestPerception.gateResult.subjectAccessible === false);


// =========================================================================
// Test D: Config Wiring (P0-4)
// 验证 experimentModules 统一配置生效与各模块实际联动
// =========================================================================
console.log('\n--- Test D: Config Wiring ---');
const cleanSanitized = sanitize({
  experimentMode: 'experimental',
  experimentModules: {
    internalRegulation: true,
    attentionGate: true,
    biographicalCanalization: true,
    digitalUmwelt: true,
    memoryDynamics: true,
    sleepConsolidation: true
  }
});

check('sanitize 正确解析 experimentMode 为 experimental', cleanSanitized.experimentMode === 'experimental');
check('sanitize 正确解析并保留全部 7 个生命动力学模块配置',
  cleanSanitized.experimentModules.internalRegulation === true &&
  cleanSanitized.experimentModules.attentionGate === true &&
  cleanSanitized.experimentModules.biographicalCanalization === true &&
  cleanSanitized.experimentModules.digitalUmwelt === true &&
  cleanSanitized.experimentModules.memoryDynamics === true &&
  cleanSanitized.experimentModules.sleepConsolidation === true);

const brainD = new Brain(makeTempDir(), cleanSanitized);
check('Brain 将 experimentModules 正确注入 InternalRegulationManager', brainD.internalRegulation.enabled === true);
check('Brain 将 experimentModules 正确注入 SubjectState', brainD.subjectState.opts.experimentModules.biographicalCanalization === true);
check('Brain 将 experimentModules 正确注入 Memory', brainD.memory.opts.experimentModules.memoryDynamics === true);


// =========================================================================
// Test E: Baseline Identity
// 验证 baseline 模式全旁路，行为与状态 100% 保持原生不变
// =========================================================================
console.log('\n--- Test E: Baseline Identity ---');
const baselineSanitized = sanitize({
  experimentMode: 'baseline',
  experimentModules: {
    internalRegulation: true,
    biographicalCanalization: true,
    digitalUmwelt: true
  }
});

check('baseline 模式下强制将所有实验模块置为 false (Baseline Isolation Invariant)',
  baselineSanitized.experimentMode === 'baseline' &&
  baselineSanitized.experimentModules.internalRegulation === false &&
  baselineSanitized.experimentModules.biographicalCanalization === false &&
  baselineSanitized.experimentModules.digitalUmwelt === false);

const dirE = makeTempDir();
const brainE = new Brain(dirE, baselineSanitized);

check('baseline 模式下 InternalRegulation 处于禁用状态', brainE.internalRegulation.enabled === false);

const initRegE = brainE.internalRegulation.getState();
brainE.internalRegulation.updateOnInteractionTurn({ role: 'user', messageLength: 150 });
brainE.internalRegulation.updateOnActivity('poke', { count: 5 });
const afterRegE = brainE.internalRegulation.getState();

check('baseline 模式下交互与活动不改变调节标量 (零副作用)',
  initRegE.energy === afterRegE.energy && initRegE.arousal === afterRegE.arousal && initRegE.restPressure === afterRegE.restPressure);

const umweltResultE = brainE.processEnvironmentalPerception({
  category: 'tactile_poke',
  rawIntensity: 80
});
check('baseline 模式下环境知觉管道旁路返回 null', umweltResultE === null);


// =========================================================================
// Test F: Ablation
// 针对性只关闭 Internal Regulation，其它模块保持开启，验证可因果归因分化
// =========================================================================
console.log('\n--- Test F: Ablation ---');
const ablationSanitized = sanitize({
  experimentMode: 'ablation',
  experimentModules: {
    internalRegulation: false,
    biographicalCanalization: true,
    digitalUmwelt: true,
    attentionGate: true
  }
});

check('ablation 模式正确识别模块关闭差异',
  ablationSanitized.experimentModules.internalRegulation === false &&
  ablationSanitized.experimentModules.biographicalCanalization === true);

const brainF = new Brain(makeTempDir(), ablationSanitized);
const schedulerF = new BehaviorScheduler();
brainF.bindBehaviorScheduler(schedulerF);

// 在消融模式下，由于 internalRegulation 禁用，行为权重始终保持静态初始值
const weightsF1 = schedulerF.getModulatedWeights();
brainF.internalRegulation.updateOnActivity('poke', { count: 10 });
const weightsF2 = schedulerF.getModulatedWeights();

check('消融 internalRegulation 后，外部刺激无法使 BehaviorScheduler 产生权重倾斜 (归因明确)',
  weightsF1[ANIMATION_STATES.LOOK_AROUND] === weightsF2[ANIMATION_STATES.LOOK_AROUND]);


// =========================================================================
// Test G: Cold Restart
// 运行 -> 产生状态 -> 关闭 -> 重启 -> 读取状态，历史事实优先于默认值恢复连续性
// =========================================================================
console.log('\n--- Test G: Cold Restart ---');
const dirG = makeTempDir();
const cfgG = {
  experimentMode: 'experimental',
  experimentModules: {
    internalRegulation: true,
    biographicalCanalization: true
  }
};

// 阶段 1: 首次启动运行并形成特定历史状态
const brainG1 = new Brain(dirG, cfgG);
brainG1.internalRegulation.energy = 62;
brainG1.internalRegulation.restPressure = 38;
brainG1.internalRegulation.arousal = 68;
brainG1.internalRegulation.salienceThreshold = brainG1.internalRegulation._computeSalienceThreshold(68);
brainG1.internalRegulation.save();

// 归档一条快照至 experiences.jsonl
const snapRecordG = brainG1.internalRegulation.createSnapshotRecord(1);
brainG1.experiencesArchive.append(snapRecordG);

brainG1.shutdown();

// 阶段 2: 模拟系统重启 (Cold Restart)
const brainG2 = new Brain(dirG, cfgG);

check('重启后成功加载磁盘持久化的 internal-regulation.json',
  brainG2.internalRegulation.energy === 62 &&
  brainG2.internalRegulation.restPressure === 38 &&
  brainG2.internalRegulation.arousal === 68);

// 阶段 3: 模拟 internal-regulation.json 意外损坏或丢失时从经历归档自愈
fs.unlinkSync(brainG2.internalRegulation.path);
check('模拟删除 internal-regulation.json', !fs.existsSync(brainG2.internalRegulation.path));

const brainG3 = new Brain(dirG, cfgG);
check('冷启动自愈：当状态文件缺失时成功从 experiences.jsonl 归档快照恢复真实历史',
  brainG3.internalRegulation.energy === 62 &&
  brainG3.internalRegulation.restPressure === 38 &&
  brainG3.internalRegulation.arousal === 68);

check('离线重放：InternalRegulationManager.replay 能够从归档准确重建状态时间线',
  (() => {
    const replayReport = InternalRegulationManager.replay(brainG3.experiencesArchive.readAll());
    return replayReport.replayStatus === 'complete' &&
           replayReport.totalSnapshots === 1 &&
           replayReport.finalState.energy === 62;
  })());


// =========================================================================
// Test H: Path Dependency Formal Experiment Interface (Section XII)
// 验证 A -> B -> C vs C -> B -> A 在完全相同配置与初始条件下产生明确的轨迹分化
// =========================================================================
console.log('\n--- Test H: Path Dependency Formal Experiment Interface ---');
const stimulusA = ({ reg }) => {
  for (let i = 0; i < 10; i++) reg.updateOnInteractionTurn({ role: 'user', messageLength: 200 });
};
const stimulusB = ({ reg }) => {
  reg.updateOnSleep(true);
  reg.updateOnSleep(false);
};
const stimulusC = ({ reg }) => {
  reg.updateOnInteractionTurn({ role: 'user', messageLength: 10, intervalMs: 300000 });
};

const pathDepResult = runPathDependencyExperiment({
  sequenceA: [stimulusA, stimulusB, stimulusC],
  sequenceB: [stimulusC, stimulusB, stimulusA],
  probeStimulus: { category: 'touch', salience: 45, intensity: 50 },
  config: { experimentModules: { internalRegulation: true, biographicalCanalization: true } }
});

check('标准路径依赖实验接口成功判定路径分化成立 (pathDependencyEstablished === true)',
  pathDepResult.pathDependencyEstablished === true);
check('两路轨迹终态能量产生显著不对称性 (Trajectory A energy > Trajectory B energy)',
  pathDepResult.trajectoryA.internalRegulation.energy > pathDepResult.trajectoryB.internalRegulation.energy);
check('两路轨迹终态疲劳压力产生显著不对称性 (Trajectory A restPressure < Trajectory B restPressure)',
  pathDepResult.trajectoryA.internalRegulation.restPressure < pathDepResult.trajectoryB.internalRegulation.restPressure);
check('两路轨迹自主微动作抽取概率产生明确分化',
  pathDepResult.divergence.behaviorDistribution[ANIMATION_STATES.LOOK_AROUND] !== 0);


// =========================================================================
// 总结输出
// =========================================================================
console.log('\n' + '='.repeat(50));
console.log(failures ? `❌ 存在 ${failures} 项失败` : '✅ 全部生产运行时生命动力学闭环测试 PASS！');
process.exit(failures ? 1 : 0);
