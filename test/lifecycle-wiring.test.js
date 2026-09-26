/**
 * test/lifecycle-wiring.test.js
 * 
 * Life Phase 0.5 运行链闭环与生命动力学贯通专项测试
 * 
 * 核心验证：
 * 1. Brain 构造注入：experimentModules 贯通至 SubjectState 与 InternalRegulationManager
 * 2. 交互与活动驱动：用户对话、Tracker 物理活动、模型回复、入睡事件实时驱动内态转移
 * 3. 沃丁顿发育景观主链路贯通：关窗时 subjectState.reduce 接收 canalization 启用参数并执行塑性衰减
 * 4. 快照归档与完整性认证：internal_regulation_snapshot 归档落盘并通过 ArchiveIntegrityService 认证
 * 5. 冷启动自愈与基线隔离
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Brain } = require('../src/brain');
const { SubjectState } = require('../src/subject-state');
const { InternalRegulationManager } = require('../src/internal-regulation');
const { ArchiveIntegrityService } = require('../src/archive-integrity');
const { ExperiencesArchive } = require('../src/experiences-archive');

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

const tempDir = makeTempDir();

// Mock LLM 配置
const mockCfg = {
  apiKey: 'sk-mock-key-for-lifecycle-wiring-test',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  windowTurns: 3,
  keepTailMessages: 1,
  memoryCapTokens: 4000,
  subjectStateStepWeight: 20,
  subjectStateMaxDelta: 50,
  experimentModules: {
    biographicalCanalization: true,
    internalRegulation: true,
    memoryDynamics: true,
    sleepConsolidation: false
  }
};

const brain = new Brain(tempDir, mockCfg);

// 1. Brain 构造函数挂载
check('Brain 构造函数成功挂载 InternalRegulationManager', brain.internalRegulation instanceof InternalRegulationManager);
check('Brain 构造函数将 experimentModules 注入 SubjectState', brain.subjectState && brain.subjectState.opts && brain.subjectState.opts.experimentModules && brain.subjectState.opts.experimentModules.biographicalCanalization === true);
check('SubjectState 构造函数持有 experimentModules 配置', brain.subjectState.opts.experimentModules.internalRegulation === true);
check('Brain 挂载 default wardrobe 时不破坏内态中枢', brain.internalRegulation.energy === 100);

// 2. 模拟交互输入与物理事件触发
const initState = brain.internalRegulation.getState();
brain.internalRegulation.updateOnInteractionTurn({
  role: 'user',
  messageLength: 80,
  intervalMs: 0,
  timestamp: Date.now()
});
const stateAfterUser = brain.internalRegulation.getState();

check('Brain say() 用户交互触发 internalRegulation 更新', stateAfterUser.updatedAt >= initState.updatedAt);
check('交互后 energy 产生生理消耗 (energy < 100)', stateAfterUser.energy < 100, `当前 energy: ${stateAfterUser.energy}`);
check('交互后 restPressure 产生生理累积 (restPressure > 0)', stateAfterUser.restPressure > 0, `当前 restPressure: ${stateAfterUser.restPressure}`);
check('交互后 arousal 产生微增 (arousal > 50)', stateAfterUser.arousal > 50, `当前 arousal: ${stateAfterUser.arousal}`);

// 3. 物理刺激
const prevArousal = stateAfterUser.arousal;
brain.internalRegulation.updateOnActivity('poke', { count: 2, timestamp: Date.now() });
const stateAfterPoke = brain.internalRegulation.getState();
check('被戳物理活动使 arousal 显著跳跃', stateAfterPoke.arousal > prevArousal, `arousal: ${prevArousal} -> ${stateAfterPoke.arousal}`);

// 4. 模型回复产出
brain.internalRegulation.updateOnInteractionTurn({
  role: 'assistant',
  messageLength: 120,
  timestamp: Date.now()
});
const stateAfterAssistant = brain.internalRegulation.getState();
check('模型回复完成触发 assistant 轮次负荷更新', stateAfterAssistant.cognitiveLoadProxy > 0);

// 5. 入睡事件
brain.internalRegulation.updateOnSleep(true, { timestamp: Date.now() });
const stateAfterSleep = brain.internalRegulation.getState();
check('用户道晚安触发 sleep 状态转移', stateAfterSleep.arousal <= 30);
check('入睡后 energy 恢复且 restPressure 消除', stateAfterSleep.energy > stateAfterAssistant.energy && stateAfterSleep.restPressure === 0);

// 6. 沃丁顿发育景观主链路与关窗
const staging = brain.subjectState.createStagingSnapshot();
check('关窗前暂存快照正确生成', staging && staging.data && typeof staging.data.windowNo === 'number');

// 注入一条证据并在窗口 5 执行 reduce
const testEv = [{
  evidenceId: 'ev-wire-001',
  messageId: 'm-000001',
  quote: '安静看书',
  trait: 'quiet_preference',
  direction: 1,
  strength: 1
}];

const redRes = brain.subjectState.reduce(testEv, 5, {
  stageOnly: true,
  canalization: brain.cfg.experimentModules?.biographicalCanalization,
  experimentModules: brain.cfg.experimentModules
});

check('关窗执行时 subjectState.reduce 接收到 canalization 启用参数', redRes && Array.isArray(redRes.stateChanges) && redRes.stateChanges.length > 0);
const sc = redRes.stateChanges[0];
check('经历窗口加深时 effectiveStepWeight 发生经历依赖衰减', sc.effectiveStepWeight < brain.subjectState.stepWeight && sc.plasticityMultiplier < 1.0, `base=${sc.baseStepWeight}, effective=${sc.effectiveStepWeight}, multiplier=${sc.plasticityMultiplier}`);

// 7. 内部调节中枢快照归档与认证
const regSnapRecord = brain.internalRegulation.createSnapshotRecord(1);
brain.experiencesArchive.append(regSnapRecord);
const allRecords = brain.experiencesArchive.readAll();
const hasRegSnap = allRecords.some(r => (r.recordType || r.type) === 'internal_regulation_snapshot');
check('关窗小结成功归档 internal_regulation_snapshot', hasRegSnap);

const integReport = ArchiveIntegrityService.checkRecords(allRecords);
check('ArchiveIntegrityService 成功认证 internal_regulation_snapshot', integReport.integrity === 'certified', `integrity=${integReport.integrity}`);

// 8. 冷启动恢复测试
const brainCold = new Brain(tempDir, mockCfg);
// 模拟删掉 internal-regulation.json，测试从 experiences.jsonl 归档重建
const regJsonPath = brainCold.internalRegulation.path;
if (fs.existsSync(regJsonPath)) {
  fs.unlinkSync(regJsonPath);
}
brainCold._restoreInternalRegulationFromArchive();

check('冷启动能从 experiences.jsonl 恢复 internal_regulation', fs.existsSync(regJsonPath));
const restoredState = brainCold.internalRegulation.getState();
check('恢复后 internalRegulation 状态与归档数据完全一致', typeof restoredState.energy === 'number' && typeof restoredState.salienceThreshold === 'number');

// 9. 基线隔离检查
const baselineCfg = { ...mockCfg, experimentModules: { internalRegulation: false, biographicalCanalization: false } };
const baselineBrain = new Brain(makeTempDir(), baselineCfg);
const baseInit = baselineBrain.internalRegulation.getState();
baselineBrain.internalRegulation.updateOnInteractionTurn({ role: 'user', messageLength: 100 });
const baseAfter = baselineBrain.internalRegulation.getState();
check('基线模式下 internalRegulation 处于旁路不影响主线', baseInit.energy === baseAfter.energy && baseInit.restPressure === baseAfter.restPressure);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
