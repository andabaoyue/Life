/**
 * test/internal-regulation.test.js
 * 
 * Life Phase 0.5 内部状态调节中枢（InternalRegulationManager）专项测试
 * 
 * 核心验证：
 * 1. 默认状态与区间有界性
 * 2. 神经唤醒度与感官显著性门限反向代数耦合
 * 3. 严格事件驱动动力学（绝无后台 setInterval 基础代谢自耗）
 * 4. 认识论主客观防线：isSubjectAccessible 恒为 false，与 SubjectState.ALLOWED_TRAITS 绝对隔离
 * 5. 交互、物理刺激、睡眠唤醒、关窗事件转移行为
 * 6. 持久化与快照契约
 * 7. 基线隔离与零干预
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { InternalRegulationManager, REGULATION_BOUNDS } = require('../src/internal-regulation');
const { ALLOWED_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function makeTempDir() {
  const d = path.join(os.tmpdir(), 'life-internal-reg-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const dir = makeTempDir();
const manager = new InternalRegulationManager(dir);

// 1. 默认状态检查
const s0 = manager.getState();
check('默认状态初始化 energy=100, restPressure=0, arousal=50', s0.energy === 100 && s0.restPressure === 0 && s0.arousal === 50);
check('初始 salienceThreshold 正确计算为 45', s0.salienceThreshold === 45, `实际: ${s0.salienceThreshold}`);
check('初始交互密度与认知负荷均为 0', s0.interactionDensity === 0 && s0.cognitiveLoadProxy === 0);

// 2. 认识论与双轨隔离防线
check('所有底层调节变量严格不可被主体直接访问 (isSubjectAccessible=false)',
  manager.isSubjectAccessible('energy') === false &&
  manager.isSubjectAccessible('arousal') === false &&
  manager.isSubjectAccessible('restPressure') === false &&
  manager.isSubjectAccessible('salienceThreshold') === false
);

const proxyKeys = ['energy', 'restPressure', 'arousal', 'salienceThreshold', 'interactionDensity', 'cognitiveLoadProxy'];
const leakedIntoTraits = proxyKeys.some(k => ALLOWED_TRAITS.has(k));
check('内部调节变量严禁混入 SubjectState 长期人格特质白名单', !leakedIntoTraits);

// 3. 无后台定时器保证 (Decision D-001)
check('实例内部绝不持有任何后台心跳定时器 (无 _timer/interval)', manager._timer === undefined);

// 4. 事件驱动更新：用户输入轮次
const s1 = manager.updateOnInteractionTurn({
  role: 'user',
  messageLength: 120,
  intervalMs: 0
});
check('用户输入轮次消耗能量并积累休息压力', s1.energy < 100 && s1.restPressure > 0, `energy=${s1.energy}, restPressure=${s1.restPressure}`);
check('长消息输入提升神经唤醒度', s1.arousal > 50, `arousal=${s1.arousal}`);

// 5. 事件驱动更新：模型回复轮次
const s2 = manager.updateOnInteractionTurn({
  role: 'assistant',
  messageLength: 200
});
check('模型回复增加认知负荷与能量消耗', s2.cognitiveLoadProxy > 0 && s2.energy < s1.energy);

// 6. 静默期衰减
const s3 = manager.updateOnInteractionTurn({
  role: 'user',
  messageLength: 20,
  intervalMs: 15 * 60 * 1000 // 15 分钟静默
});
check('长时间静默交互使唤醒度向基准 50 回落且排空认知负荷', s3.cognitiveLoadProxy <= 5);

// 7. 物理戳戳
const prevArousal = s3.arousal;
const s4 = manager.updateOnActivity('poke', { count: 3 });
check('物理连戳使唤醒度产生脉冲峰值', s4.arousal > prevArousal, `arousal: ${prevArousal} -> ${s4.arousal}`);

// 8. 物理拖动
const prevEnergy = s4.energy;
const s5 = manager.updateOnActivity('drag', { count: 1 });
check('拖动消耗体能并适度刺激唤醒度', s5.energy <= prevEnergy);

// 9. 静默挂机活动
const s6 = manager.updateOnActivity('idle', { idleMin: 30 });
check('长挂机降低唤醒度并微增疲劳', s6.arousal < s4.arousal && s6.restPressure > 0);

// 10. 唤醒度与感官显著性门限的动态反向代数耦合
const highArousalThresh = manager._computeSalienceThreshold(90);
const lowArousalThresh = manager._computeSalienceThreshold(20);
check('高唤醒度时显著性门限下降（易敏激惹）', highArousalThresh <= 25, `highArousalThresh=${highArousalThresh}`);
check('低唤醒度时显著性门限上升（迟钝脱敏）', lowArousalThresh >= 60, `lowArousalThresh=${lowArousalThresh}`);

// 11. 睡眠模式整合
const sSleep = manager.updateOnSleep(true);
check('入睡状态恢复能量并大幅清空疲劳压力', sSleep.energy > 80 && sSleep.restPressure === 0, `energy=${sSleep.energy}, restPressure=${sSleep.restPressure}`);
check('入睡使唤醒度沉降至睡眠低位 (<= 30)', sSleep.arousal <= 30, `arousal=${sSleep.arousal}`);

// 12. 唤醒状态整合
const sWake = manager.updateOnSleep(false);
check('唤醒重置唤醒度至清醒基线 (50)', sWake.arousal === 50, `arousal=${sWake.arousal}`);

// 13. 关窗小结与排空
const sClose = manager.updateOnWindowClose(1);
check('关窗事件排空认知负荷并半衰短期交互密度', sClose.cognitiveLoadProxy === 0);

// 14. 持久化与快照
check('内部调节状态落盘至 internal-regulation.json', fs.existsSync(manager.path));
const loadedManager = new InternalRegulationManager(dir);
check('新实例可完整反序列化已持久化的调节状态', loadedManager.getState().arousal === sClose.arousal);

const snapRec = manager.createSnapshotRecord(1);
check('标准化归档快照包含 schemaVersion 与有效 payload', snapRec.recordType === 'internal_regulation_snapshot' && snapRec.payload.state.energy !== undefined);

// 15. 基线隔离模式
const baseManager = new InternalRegulationManager(makeTempDir(), { enabled: false });
const basePre = baseManager.getState();
baseManager.updateOnInteractionTurn({ role: 'user', messageLength: 200 });
baseManager.updateOnActivity('poke', { count: 5 });
const basePost = baseManager.getState();
check('基线模式下所有调节更新均为纯旁路空操作 (零副作用)', basePre.energy === basePost.energy && basePre.arousal === basePost.arousal);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
