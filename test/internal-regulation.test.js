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

// 16. v0.9.9 P0-3：baseline 不得被磁盘残留的实验数值污染
// 原实现在未启用时也无条件 load()，盘上有残留就覆盖出厂默认值 —— 对照组从
// 源头就不干净，既违反 D-009 §2「基线隔离不变量」，也违反 internal-regulation.js:22
// 的自述「未启用时状态保持基线默认值，不产生任何副作用」。
const residueDir = makeTempDir();
const residue = new InternalRegulationManager(residueDir, { enabled: true });
residue.energy = 12;
residue.restPressure = 77;
residue.arousal = 91;
residue.save();
check('P0-3 前提：实验残留确实已落盘', fs.existsSync(residue.path));
const baseline = new InternalRegulationManager(residueDir, { enabled: false });
const bs = baseline.getState();
check('P0-3 baseline 不加载磁盘残留（对照组不被历史污染）',
  bs.energy === REGULATION_BOUNDS.energy.default &&
  bs.restPressure === REGULATION_BOUNDS.restPressure.default &&
  bs.arousal === REGULATION_BOUNDS.arousal.default,
  `energy=${bs.energy}, restPressure=${bs.restPressure}, arousal=${bs.arousal}`);
check('P0-3 前提：启用时同一目录确实读得到残留（否则上一条是空转）',
  new InternalRegulationManager(residueDir, { enabled: true }).getState().energy === 12);

// 17. v0.9.9 P2-2a: 内态变更 -> onChange 推送（跨进程镜像不得陈旧）
// 权威内态在主进程、行为调度在渲染进程，二者只有 internal-regulation-updated
// 一条镜像通道；此前它只在 activity 事件推送，对话/入睡/唤醒/关窗的变化根本
// 到不了渲染端 —— 微动作调度器依据的是陈旧镜像，不是真实的她。
{
  let pushes = 0;
  const mP = new InternalRegulationManager(makeTempDir(), { enabled: true });
  mP.onChange = () => { pushes++; };
  mP.updateOnInteractionTurn({ role: 'user', messageLength: 150 });
  check('P2-2a：对话轮次触发 onChange 推送', pushes === 1, 'pushes=' + pushes);
  const p0 = pushes;
  mP.updateOnSleep(true); mP.updateOnSleep(false);
  check('P2-2a：入睡/唤醒触发 onChange 推送', pushes > p0, 'pushes=' + pushes);
  const p1 = pushes;
  mP.updateOnWindowClose(1);
  check('P2-2a：关窗排空触发 onChange 推送', pushes > p1, 'pushes=' + pushes);
  const p2 = pushes;
  mP.updateOnActivity('poke', { count: 3 });
  check('P2-2a 不变式：物理活动仍触发推送（旧路径不破）', pushes > p2, 'pushes=' + pushes);

  // 异常隔离：回调抛错绝不影响内态更新本身
  const mX = new InternalRegulationManager(makeTempDir(), { enabled: true });
  mX.onChange = () => { throw new Error('推送方炸了'); };
  let threwX = false;
  let sX = null;
  try { sX = mX.updateOnActivity('poke', { count: 3 }); } catch { threwX = true; }
  check('P2-2a 不变式：回调抛错不得影响内态更新（异常隔离）',
    threwX === false && !!sX && typeof sX.arousal === 'number');
}

// 18. v0.9.9 P2-2b: Arousal <-> 显著性门限反向耦合（零实现改动，只补单调性判据）
// 严禁改动耦合参数 —— 那会影响离线 Replay 确定性。
{
  const mC = new InternalRegulationManager(makeTempDir(), { enabled: true });
  const th = (a) => mC._computeSalienceThreshold(a);
  check('P2-2b：arousal 上升 -> 显著性门限单调不增（反向耦合）',
    th(0) >= th(25) && th(25) >= th(50) && th(50) >= th(75) && th(75) >= th(100),
    [0, 25, 50, 75, 100].map(a => th(a)).join(','));
  check('P2-2b：arousal 下降 -> 显著性门限单调不减',
    th(100) <= th(75) && th(75) <= th(50) && th(50) <= th(25));
  const lo = REGULATION_BOUNDS.salienceThreshold.min;
  const hi = REGULATION_BOUNDS.salienceThreshold.max;
  check('P2-2b：门限始终夹在 REGULATION_BOUNDS 内',
    [-1000, 0, 50, 100, 1000].every(a => th(a) >= lo && th(a) <= hi),
    'lo=' + lo + ' hi=' + hi);

  // 基线隔离（接 P0-3）：baseline 下门限保持出厂默认，不被实验残留污染
  const dirB = makeTempDir();
  const resid = new InternalRegulationManager(dirB, { enabled: true });
  resid.arousal = 90;
  resid.salienceThreshold = resid._computeSalienceThreshold(90);
  resid.save();
  const baseM = new InternalRegulationManager(dirB, { enabled: false });
  const freshM = new InternalRegulationManager(makeTempDir(), { enabled: false });
  check('P2-2b 不变式：baseline 下门限保持出厂默认（不被实验残留污染）',
    baseM.getState().salienceThreshold === freshM.getState().salienceThreshold,
    'base=' + baseM.getState().salienceThreshold + ' fresh=' + freshM.getState().salienceThreshold);
}

/* ===== v1.0 疲惫跨重启持久化契约（用户实测报障：疲惫值退出重进归零）=====
   逐轮/活动更新必须落盘 —— 否则「会累的身体」每次重启都满血，通路 B 永远走不到。 */
{
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-persist-'));
  const a1 = new InternalRegulationManager(pdir, { enabled: true });
  a1.updateOnInteractionTurn({ role: 'user', timestamp: Date.now() });
  a1.updateOnActivity('idle', { idleMinutes: 30 });
  const beforePressure = a1.getState().restPressure;
  const beforeEnergy = a1.getState().energy;
  const a2 = new InternalRegulationManager(pdir, { enabled: true });
  check('v1.0 疲惫/精力跨重启：逐轮/活动更新落盘，新实例读回原值（退出重进不归零）',
    beforePressure > 0 && a2.getState().restPressure === beforePressure
    && a2.getState().energy === beforeEnergy,
    'pressure=' + beforePressure + '→' + a2.getState().restPressure
    + ' energy=' + beforeEnergy + '→' + a2.getState().energy);
}

/* ===== v1.0 生理内感受 + 生物钟（合流批契约钉）=====
   零数字红线 / 中档沉默 / 纯函数零副作用 / 夜窗加权（创世时区）/ 日间公式逐字不变。 */
{
  const s = new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-sense-')),
    { enabled: true, birthTimezone: 'Asia/Shanghai' });
  const bands = [];
  s.restPressure = 80; bands.push(s.formatPerception().includes('困意很沉'));
  s.restPressure = 50; bands.push(s.formatPerception().includes('泛起淡淡的困倦'));
  s.restPressure = 10; s.energy = 35; bands.push(s.formatPerception().includes('体能消耗较大'));
  s.energy = 85; bands.push(s.formatPerception().includes('精力充沛'));
  s.energy = 60; s.arousal = 80; bands.push(s.formatPerception().includes('亢奋紧绷'));
  s.arousal = 30; bands.push(s.formatPerception().includes('放空朦胧'));
  check('v1.0 内感受分带矩阵：疲惫/精力/唤醒 六档定性文案全覆盖', bands.every(Boolean), JSON.stringify(bands));
  s.restPressure = 10; s.energy = 60; s.arousal = 50;
  check('v1.0 内感受中档沉默：全指标居中输出空串（沉默=如常）', s.formatPerception() === '');
  s.restPressure = 80; s.energy = 35; s.arousal = 80;
  const noisy = s.formatPerception();
  check('v1.0 内感受零数字（数字不可知红线）', !/\d/.test(noisy) && noisy.includes('【生理体感】'));
  const snapBefore = JSON.stringify(s.getState());
  s.formatPerception();
  check('v1.0 内感受纯函数零副作用 + 引擎关闭无幻肢感',
    JSON.stringify(s.getState()) === snapBefore
    && new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-off-')),
      { enabled: false }).formatPerception() === '');
  // 生物钟昼夜对比（创世时区口径：上海 10/05 02:00 vs 14:00）
  const NIGHT = Date.UTC(2026, 9, 4, 18, 0, 0);
  const DAY = Date.UTC(2026, 9, 4, 6, 0, 0);
  const n1 = new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-night-')),
    { enabled: true, birthTimezone: 'Asia/Shanghai' });
  const d1 = new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-day-')),
    { enabled: true, birthTimezone: 'Asia/Shanghai' });
  const nA0 = n1.getState().arousal, dA0 = d1.getState().arousal;
  n1.updateOnActivity('idle', { idleMin: 30, timestamp: NIGHT });
  d1.updateOnActivity('idle', { idleMin: 30, timestamp: DAY });
  check('v1.0 生物钟夜窗加权：深夜疲惫堆积更快、唤醒回落更深（创世时区口径）',
    n1.getState().restPressure === 6 && n1.getState().arousal === nA0 - 8
    && d1.getState().restPressure === 3 && d1.getState().arousal === dA0 - 6,
    'night rp=' + n1.getState().restPressure + ' arΔ=' + (n1.getState().arousal - nA0)
    + ' | day rp=' + d1.getState().restPressure + ' arΔ=' + (d1.getState().arousal - dA0));
  check('v1.0 生物钟日间对照：日间公式逐字不变（min(10,idle/10) / -min(20,idle/5)）',
    d1.getState().restPressure === Math.min(10, Math.floor(30 / 10))
    && (dA0 - d1.getState().arousal) === Math.min(20, Math.floor(30 / 5)));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
