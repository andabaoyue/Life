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
const { ActivityTracker } = require('../src/tracker');
const { ALLOWED_TRAITS } = require('../src/subject-state');

// [D-8a] 临时目录清理：见下方 [tmp-hygiene] 插桩块。
// 原先此处有一份只包 mkdtempSync 的 _d8a 包装器，已删——它抓不到手工 join+mkdir 的 makeTempDir，
// 2026-10-06 实测仍净留 2000+ 个。**这不是冗余，是覆盖缺失。**

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// [tmp-hygiene] 本文件的 makeTempDir 走 path.join+mkdirSync 手工建目录，
// 不经过 fs.mkdtempSync —— 只包mkdtempSync 的包装器**抓不到它**。
// 2026-10-06 实测：本文件单次跑净留 2000+ 个 %TEMP% 沙盒（前缀 life-internal-reg-test-）。
// 两手一起做：① 包 mkdirSync 记下新建目录；② makeTempDir 改用 mkdtempSync。
// 只做①不够：包 mkdirSync 会连带登记大量非临时目录；只做②不够：绕过包装器就漏。
const _thDirs = [];
const _thOrigMkdtemp = fs.mkdtempSync;
const _thOrigMkdir = fs.mkdirSync;
fs.mkdtempSync = function (...a) {
  const d = _thOrigMkdtemp.apply(fs, a);
  _thDirs.push(d);
  return d;
};
fs.mkdirSync = function (p, ...a) {
  const r = _thOrigMkdir.call(fs, p, ...a);
  try {
    const abs = require('path').resolve(String(p));
    const tmp = require('path').resolve(require('os').tmpdir());
    if (abs.startsWith(tmp + require('path').sep) && _thMkdirHit(abs)) _thDirs.push(abs);
  } catch (_) {}
  return r;
};
// 只登记落在 %TEMP% 顶层的目录，避免把仓库内建目录也删了
function _thMkdirHit(abs) {
  const rel = abs.slice(require('path').resolve(require('os').tmpdir()).length + 1);
  return rel.length > 0 && !rel.includes(require('path').sep);
}
process.on('exit', () => {
  for (const d of _thDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _thOrigMkdtemp;
  fs.mkdirSync = _thOrigMkdir;
});
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'life-internal-reg-test-'));
  /* replaced-by-tmp-hygiene: 原为手工 join+mkdir，同名唯一 */
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
  // v3.1 P1（基线体感 · 治「常态无身」）：断言意图从「中档返回空串」改为
  //「中档必须给基线体感」。原断言锁的正是被修掉的病灶 —— 常态无身让她对自己的
  // 身体零知觉，呈现为「非虚弱即麻木」两个极端。沉默≠如常，如常也该有知觉。
  const baseline = s.formatPerception();
  check('v3.1 P1 内感受基线体感：全指标居中不再返回空串（治常态无身）',
    baseline !== '' && baseline.includes('身体安稳'), JSON.stringify(baseline).slice(0, 90));
  check('v3.1 P1 基线体感零数字（数字不可知红线）', !/\d/.test(baseline));
  check('v3.1 P1 基线体感不含寂寞/等待类表达（persona.js:29 红线后门自查）',
    !/寂寞|孤独|等你|盼|数着/.test(baseline), baseline.split('\n')[1] || '');
  // 措辞不随指标变动 —— 一旦分档就会变成第二个「复读虚弱」的温床。
  // 取样必须落在「全带落空」的区间内：energy 落在 (35,85)、
  // restPressure<50、arousal 落在 (30,80) 才进得了基线分支。
  s.restPressure = 10; s.energy = 70; s.arousal = 45;
  const b2 = s.formatPerception();
  s.restPressure = 40; s.energy = 45; s.arousal = 40;
  const b3 = s.formatPerception();
  check('v3.1 P1 基线体感措辞恒定（不分档，防第二个复读源）',
    b2.includes('身体安稳') && b3.includes('身体安稳')
    && b2.split('\n')[1] === baseline.split('\n')[1]
    && b3.split('\n')[1] === baseline.split('\n')[1],
    [b2.split('\n')[1], b3.split('\n')[1]].join(' || '));
  // 任何带命中时基线不参与表达（不与真实体感争夺）
  s.restPressure = 10; s.energy = 35; s.arousal = 50;
  const withBand = s.formatPerception();
  check('v3.1 P1 有带命中时不叠加基线体感（避免双份表达）',
    !withBand.includes('身体安稳') && withBand.includes('体能消耗较大'));
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
  // ⚠️ v3.1 P1 静息回血改动后，本组断言的**语义已变**，原因逐条说明：
  //原契约「日间静置 30 分钟 → restPressure = min(10, 30/10) = 3」锁的是
  //   「清醒挂机时间越长越困」这个单向语义。它正是 v3.1 要治的病根之一：
  //   实测挂机一整天 → restPressure 涨到满值 100，她自述「困意很沉…很想趴下」，
  //   而此时 energy 补满也救不了 —— 呈现为「体能不虚但困得撑不住」。
  // 现改为两档语义（见 internal-regulation.js QUIET_RECOVERY）：
  //   短时静止（<30 分钟）→ 保留原累积公式（逐字不变）；
  //   真的歇够（>=30 分钟）→ 困意**停止累积**（日间），夜窗仍按原公式加权
  //   （夜里本就该困，这是生物钟的合理部分，不在本次治疗范围内）。
  const NIGHT = Date.UTC(2026, 9, 4, 18, 0, 0);
  const DAY = Date.UTC(2026, 9, 4, 6, 0, 0);
  const n1 = new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-night-')),
    { enabled: true, birthTimezone: 'Asia/Shanghai' });
  const d1 = new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-day-')),
    { enabled: true, birthTimezone: 'Asia/Shanghai' });
  const nA0 = n1.getState().arousal, dA0 = d1.getState().arousal;
  n1.updateOnActivity('idle', { idleMin: 30, timestamp: NIGHT });
  d1.updateOnActivity('idle', { idleMin: 30, timestamp: DAY });
  check('v1.0 生物钟夜窗加权：夜窗仍累积困意（夜里本就该困），唤醒回落更深（创世时区口径）',
    n1.getState().restPressure === 6 && n1.getState().arousal === nA0 - 8
    && d1.getState().arousal === dA0 - 6,
    'night rp=' + n1.getState().restPressure + ' arΔ=' + (n1.getState().arousal - nA0)
    + ' | day rp=' + d1.getState().restPressure + ' arΔ=' + (d1.getState().arousal - dA0));
  // 覆盖 Brain 生产接线：惰性函数回调时区（Manus P1 连带钉）
  const fnManager = new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-fn-')),
    { enabled: true, birthTimezone: () => 'Asia/Shanghai' });
  check('v1.0 创世时区支持惰性函数回调（Brain 生产接线覆盖）',
    fnManager._isNightHour(NIGHT) === true && fnManager._isNightHour(DAY) === false);
  check('v3.1 日间真歇够（>=30分）后困意停止累积（原契约 min(10,idle/10) 仅对<30分钟生效）',
    d1.getState().restPressure === 0
    && (dA0 - d1.getState().arousal) === Math.min(20, Math.floor(30 / 5)));
  // 短时静止的日间累积公式逐字不变（未被v3.1 改动触碰）
  const dShort = new InternalRegulationManager(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-dshort-')),
    { enabled: true, birthTimezone: 'Asia/Shanghai' });
  dShort.updateOnActivity('idle', { idleMin: 25, timestamp: DAY });
  check('v3.1 短时静止（<30分）日间困意累积公式逐字不变（min(10,idle/10)）',
    dShort.getState().restPressure === Math.min(10, Math.floor(25 / 10)));
}

/* ===== v3.1 P1 静息回血：治「不睡觉就注定虚弱」=====
 * 病灶实测（2026-10-06）：energy 与 restPressure 双单向。
 *   交互每轮 -1（user/assistant 各一次）；idle 分支**根本没设 deltas.energy**；
 *   restPressure 单调只涨不消。一天（8h 聊天 + 16h 挂机）→ energy 20、restPressure 100。
 * 解法：清醒静息分两档回血（微回血/ 静息回血），清醒静息时困意自愈，
 *      清醒上限 85%，最深的那 15% 只留给深度睡眠。 */
(function quietRecovery() {
  const DAYT = Date.UTC(2026, 9, 4, 6, 0, 0);  // 14:00 Asia/Shanghai（日窗）
  const NIGHTT = Date.UTC(2026, 9, 4, 18, 0, 0); // 02:00 Asia/Shanghai（夜窗）
  const mk = (tag, e, rp) => {
    const m = new InternalRegulationManager(
      fs.mkdtempSync(path.join(os.tmpdir(), tag)), { enabled: true, birthTimezone: 'Asia/Shanghai' });
    if (e !== undefined) m.energy = e;
    if (rp !== undefined) m.restPressure = rp;
    return m;
  };

  check('v3.1 静息回血·微档：静止 10~29 分钟缓慢回血（缓一口，不是长睡等价）',(() => {
    const a = mk('qr-m10-', 40, 0); a.updateOnActivity('idle', { idleMin: 10, timestamp: DAYT });
    const b = mk('qr-m29-', 40, 0); b.updateOnActivity('idle', { idleMin: 29, timestamp: DAYT });
    const c = mk('qr-m0-', 40, 0); c.updateOnActivity('idle', { idleMin: 5, timestamp: DAYT });
    return c.getState().energy === 40            // v1.0.2: 不足 10 分钟（如 5 分钟）不回血
      && a.getState().energy > 40 && a.getState().energy <= 45
      && b.getState().energy > a.getState().energy
      && b.getState().energy < 75;                 // 微档不得触到清醒上限
  })());
  check('v3.1 静息回血·静息档：>=30 分钟回血显著快于微档', (() => {
    const m30 = mk('qr-r30-', 40, 0); m30.updateOnActivity('idle', { idleMin: 30, timestamp: DAYT });
    const m29 = mk('qr-r29-', 40, 0); m29.updateOnActivity('idle', { idleMin: 29, timestamp: DAYT });
    return m30.getState().energy > m29.getState().energy
      && m30.getState().energy - 40 > (m29.getState().energy - 40) * 2;
  })());
  check('v3.1 清醒静息上限 75%：静息再久也不越过（最后 25% 留给深度睡眠）', (() => {
    const m = mk('qr-cap-', 10, 0);
    for (let i = 0; i < 12; i++) m.updateOnActivity('idle', { idleMin: 30, timestamp: DAYT + i * 30 * 60000 });
    return m.getState().energy === 75;
  })());
  check('v3.1 困意自愈：清醒静置会把高困意降下来，但留floor 15（保住「该睡了」的信号）', (() => {
    const m = mk('qr-rp-', 50, 90);
    m.updateOnActivity('idle', { idleMin: 120, timestamp: DAYT });
    return m.getState().restPressure < 90 && m.getState().restPressure === 15;
  })());
  check('v3.1 夜窗困意自愈打折 0.3（夜里本来就该困，不该被静息清掉）', (() => {
    const n = mk('qr-n-', 50, 90); n.updateOnActivity('idle', { idleMin: 60, timestamp: NIGHTT });
    const d = mk('qr-d-', 50, 90); d.updateOnActivity('idle', { idleMin: 60, timestamp: DAYT });
    return n.getState().restPressure > d.getState().restPressure
      && n.getState().restPressure < 90;
  })());
  check('v3.1 睡眠互斥：睡着时静息**完全不得**回血（否则与入睡预充/8h结算双重叠加）', (() => {
    const m = mk('qr-sleep-', 60, 0);
    m.updateOnSleep(true, { timestamp: DAYT });
    const afterFall = m.getState().energy;
    m.updateOnActivity('idle', { idleMin: 120, timestamp: DAYT + 3600000 });
    return afterFall === 70                       // 100 上限下60 + 10 预充 = 70
      && m.getState().energy === afterFall;       // 静息 2 小时也一点没加
  })());
  check('v3.1 深度睡眠仍是唯一到 100 的路（静息封 75，深睡 8h 到满）', (() => {
    const m = mk('qr-deep-', 50, 0);
    for (let i = 0; i < 10; i++) m.updateOnActivity('idle', { idleMin: 60, timestamp: DAYT + i * 3600000 });
    const afterQuiet = m.getState().energy;
    m.updateOnSleep(true, { timestamp: DAYT + 10 * 3600000 });
    m.updateOnSleep(false, { timestamp: DAYT + 18 * 3600000 });   // 睡满 8 小时
    return afterQuiet === 75 && m.getState().energy === 100;
  })());
  // v3.1 P1 补漏：idle 的两个 else 分支曾缺 isSleeping 守卫，夜窗会凭空加困意。
  // 实测病灶：入睡（restPressure 被 -60 压到 0）后，夜窗 idle 35 分钟 → 0→7；
  //白天同条件 7→7，证明这是**夜窗专属**漏洞（白天走 `? : 0` 不加）。
  // 修复取定点守卫而非整段 early return —— 后者会掐掉清醒态的 arousal 回落（L488-493）。
  check('v3.1 睡眠期夜窗 idle 不得凭空加困意（else 分支定点守卫回归）', (() => {
    const m = mk('qr-nightleak-', 60, 0);
    m.updateOnSleep(true, { timestamp: NIGHTT });
    const asleep = m.getState().restPressure;                // 入睡 -60 后应为 0
    m.updateOnActivity('idle', { idleMin: 35, timestamp: NIGHTT + 3600000 });
    const afterNightIdle = m.getState().restPressure;
    // 对照组：白天同一条件本来就不加（: 0 分支），守住"夜窗是唯一漏口"这个诊断
    const d = mk('qr-nightleak-day-', 60, 0);
    d.updateOnSleep(true, { timestamp: DAYT });
    d.updateOnActivity('idle', { idleMin: 35, timestamp: DAYT + 3600000 });
    return asleep === 0
      && afterNightIdle === 0// 夜窗静息 35 分钟，一点困意都不许加
      && d.getState().restPressure === 0;       // 白天对照同样保持 0
  })());
  check('v3.1 定点守卫不误伤：清醒静息仍照常累积/自愈困意（arousal 回落不受影响）', (() => {
    const n = mk('qr-guard-', 50, 90);
    n.updateOnActivity('idle', { idleMin: 35, timestamp: NIGHTT });   // 夜窗清醒 → 应消散而非加
    const nAwake = mk('qr-guard-a-', 50, 10);
    nAwake.arousal = 90;
    nAwake.updateOnActivity('idle', { idleMin: 35, timestamp: DAYT });
    return n.getState().restPressure < 90      // 夜窗清醒静息：困意自愈（守卫生效路径仍通）
      && nAwake.getState().arousal < 90;       // 清醒高唤醒静息：arousal 仍回落（未误伤）
  })());
  check('v3.1 一日实况回归：8h 聊天 + 16h 挂机后不再「体能亏得厉害」', (() => {
    const m = mk('qr-day-', 100, 0);
    for (let h = 0; h < 8; h++) {
      for (let i = 0; i < 5; i++) {
        m.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 60000, timestamp: DAYT });
        m.updateOnInteractionTurn({ role: 'assistant', messageLength: 300, intervalMs: 1000, timestamp: DAYT });
      }
    }
    const spent = m.getState().energy;
    for (let h = 0; h < 16; h++) m.updateOnActivity('idle', { idleMin: 60, timestamp: DAYT + h * 3600000 });
    const rested = m.getState().energy;
    m.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 8 * 3600000, timestamp: DAYT });
    const morning = m.getState().energy;
    const sense = m.formatPerception();
    return spent < 40                              // 聊天确实耗电
      && rested === 75                             // 挂机能回满到清醒上限
      && morning >= 70                            // 次日早上是安泰的（v1.0.2: 清醒封 75 下 morning >= 70）
      && !/体能亏得厉害/.test(sense)               // 不再自我描述为空壳
      && !/困意很沉/.test(sense);                  // 也不再困到撑不住
  })());
  check('v3.1 静息回血不越权：idle 只动生理标量，不碰 isSleeping / 睡眠时刻 / 落盘结构', (() => {
    const m = mk('qr-pure-', 50, 30);
    m.updateOnSleep(true, { timestamp: DAYT });          // 先入睡
    m.updateOnSleep(false, { timestamp: DAYT + 8 * 3600000 });
    const beforeSleepStart = m.sleepStartTime;
    m.updateOnActivity('idle', { idleMin: 40, timestamp: DAYT + 9 * 3600000 });
    const st = m.getState();
    return m.energy > 50
      && m.isSleeping === false                        // 静息不得改睡眠状态
      && m.sleepStartTime === beforeSleepStart         // 不得改睡眠时刻
      && typeof st.energy === 'number'
      && !('history' in st)&& !('transitions' in st);   // 观测出口保持纯快照
  })());

  // v1.0.2：阶梯上报（6×10 分钟）须与单次上报（60 分钟）近似等价 —— 防"按累计静默重复计量"暴冲。
  // 容差说明：夜窗 arousal 用 floor(idle/3.5)，而 3.5 不整除 60，
  //   故 6 步与单次的 floor 累积天然差约 5（日间 /5 整除 60，Δ=0）。
  //   cognitiveLoadProxy / interactionDensity 是「每次静默扣一次」的事件语义，
  //   本就不与时长等价，故不纳入断言。
  check('v1.0.2 阶梯上报与单次上报等价（防累计静默暴冲）', (() => {
    const single = mk('eq-s-', 30, 80);
    single.arousal = 70;
    single.updateOnActivity('idle', { idleMin: 60, timestamp: DAYT });

    const ladder = mk('eq-l-', 30, 80);
    ladder.arousal = 70;
    const tr = new ActivityTracker({ now: () => Date.now() });
    tr.setInternalRegulation(ladder);
    for (let k = 10; k <= 60; k += 10) tr.recordIdle(k, DAYT + k * 60000);

    const a = single.getState(), b = ladder.getState();
    return Math.abs(a.energy - b.energy) <= 2
      && Math.abs(a.restPressure - b.restPressure) <= 2
      && Math.abs(a.arousal - b.arousal) <= 6;
  })());

  // v1.0.3：心境系统动力学与契约规范 (Mood Kinetics)
  check('v1.0.3 默认心境初始化 warmth=50, stillness=50 且不进入 getState()', (() => {
    const m = mk('md-init-', 100, 0);
    const md = m.getMood();
    const st = m.getState();
    return md.warmth === 50 && md.stillness === 50
      && !('moodWarmth' in st) && !('moodStillness' in st)
      && !('mood' in st);
  })());

  check('v1.0.3 物理时间 48h 半衰期连续衰减向基准 50', (() => {
    const m = mk('md-decay-', 100, 0);
    m.moodWarmth = 70; // Δ = +20
    m.moodUpdatedAt = DAYT;
    const m24 = m.getMood(DAYT + 24 * 3600000); // 24h: 50 + 20 * 2^(-0.5) ≈ 64.1
    const m48 = m.getMood(DAYT + 48 * 3600000); // 48h: 50 + 20 * 0.5 = 60
    const m96 = m.getMood(DAYT + 96 * 3600000); // 96h: 50 + 20 * 0.25 = 55
    const mBack = m.getMood(DAYT); // 纯函数验证：回看过去时刻，时钟绝未被推进，应仍为 70
    return m24.warmth === 64
      && m48.warmth === 60
      && m96.warmth === 55
      && mBack.warmth === 70
      && m.moodWarmth === 70
      && m.moodUpdatedAt === DAYT;
  })());

  check('v1.0.3 关窗平淡时省略 moodTone 走自然顺延（不硬跳到 50）', (() => {
    const m = mk('md-omit-', 100, 0);
    m.moodWarmth = 70;
    m.moodUpdatedAt = DAYT;
    // 24 小时后关窗，LLM 省略 moodTone (传入 undefined/null)
    m.updateMoodOnWindowClose(null, DAYT + 24 * 3600000);
    const md = m.getMood(DAYT + 24 * 3600000);
    return md.warmth === 64; // 顺延衰减至 64，绝非被强行置为 50
  })());

  check('v1.0.3 关窗显式注入受单窗最大步长 SlewMax=20 平滑限幅', (() => {
    const m = mk('md-slew-', 100, 0);
    m.moodWarmth = 50;
    m.moodUpdatedAt = DAYT;
    // 单窗要求跃迁至 85 (Δ = +35)，受 SlewMax=20 限制应步进至 70
    m.updateMoodOnWindowClose({ warmth: 85 }, DAYT);
    const md1 = m.getMood(DAYT);
    // 次窗继续注入 85，步进至 85
    m.updateMoodOnWindowClose({ warmth: 85 }, DAYT + 1000);
    const md2 = m.getMood(DAYT + 1000);
    return md1.warmth === 70 && md2.warmth === 85;
  })());

  check('v1.0.3 感知滞回与退出延时保护（进入 62，退出 53 且具备缝隙保护）', (() => {
    const m = mk('md-hyst-', 100, 0);
    m.moodWarmth = 62;
    m.moodUpdatedAt = DAYT;
    const txt1 = m.formatPerception(DAYT);
    const hasWarm1 = /心绪温热/.test(txt1);

    // 衰减至 54 (介于 53 与 62 之间)，滞回死区保持显现
    m.moodWarmth = 54;
    m.moodUpdatedAt = DAYT;
    const txt2 = m.formatPerception(DAYT);
    const hasWarm2 = /心绪温热/.test(txt2);

    // 刚跌破 53 (如 52)，触发 12h 观察期保护，立即仍不中断
    m.moodWarmth = 52;
    m.moodUpdatedAt = DAYT;
    const txt3 = m.formatPerception(DAYT);
    const hasWarm3 = /心绪温热/.test(txt3);

    // 观察期过后 (13 小时)，确认持续低位，平滑熄灭
    m.moodWarmth = 52;
    m.moodUpdatedAt = DAYT;
    const txt4 = m.formatPerception(DAYT + 13 * 3600000);
    const hasWarm4 = /心绪温热/.test(txt4);

    // 纯函数零副作用验证：调用 formatPerception 绝不写回 moodWarmth 或推进 moodUpdatedAt
    const pureCheck = (m.moodWarmth === 52) && (m.moodUpdatedAt === DAYT);

    return hasWarm1 === true && hasWarm2 === true && hasWarm3 === true && hasWarm4 === false && pureCheck;
  })());

  check('v1.0.3 睡眠期间仅依物理时间流逝自然沉淀（无多余 40% 离散打折）', (() => {
    const m = mk('md-sleep-', 100, 0);
    m.moodWarmth = 70;
    m.moodUpdatedAt = DAYT;
    m.updateOnSleep(true, { timestamp: DAYT });
    m.updateOnSleep(false, { timestamp: DAYT + 8 * 3600000 });
    const md = m.getMood(DAYT + 8 * 3600000);
    // 8h 后自然耗散为 50 + 20 * 2^(-8/48) ≈ 68 (保留率 92.6%)
    return md.warmth === 68;
  })());

  check('v1.0.3 磁盘与归档解耦恢复：save/load 独立读写 data.mood，replay 挂载 finalMood', (() => {
    const m = mk('md-rec-', 100, 0);
    m.moodWarmth = 75;
    m.moodStillness = 65;
    m._moodState.warmthActive = true;
    m.save();

    const m2 = new InternalRegulationManager(m.dir, { enabled: true, birthTimezone: 'Asia/Shanghai' });
    const mdLoaded = m2.getMood();
    const moodStateLoaded = m2._moodState && m2._moodState.warmthActive === true;

    const snap = m.createSnapshotRecord(1);
    const hasMoodInPayload = snap.payload && snap.payload.mood && snap.payload.mood.warmth === 75;

    const rep = InternalRegulationManager.replay([snap]);
    const finalStatePure = rep.finalState && rep.finalState.energy === 100 && !('moodWarmth' in rep.finalState);
    const finalMoodCorrect = rep.finalMood && rep.finalMood.warmth === 75 && rep.finalMood.stillness === 65;

    return mdLoaded.warmth === 75 && mdLoaded.stillness === 65
      && moodStateLoaded
      && hasMoodInPayload
      && finalStatePure
      && finalMoodCorrect;
  })());

  check('v1.0.4 体能亏虚与心神安定带内嵌着装自决体感（防双份表达并继承滞回保护）', (() => {
    const m = mk('md-wear-', 20, 0);
    const lowEnergySense = m.formatPerception();
    const hasLowEnergyWear = lowEnergySense.includes('只想穿最轻便宽松的衣服，抗拒繁重层叠');

    m.energy = 60;
    m.moodStillness = 65;
    m.moodUpdatedAt = DAYT;
    const stillSense = m.formatPerception(DAYT);
    const hasStillWear = stillSense.includes('偏爱素雅清爽、毫无束缚的自如着装');

    return hasLowEnergyWear === true && hasStillWear === true;
  })());

  check('v1.0.7 社交密度与独处渴求带：40/60 分档定性输出（对齐连戳 10/15 下）且恪守零数字红线', (() => {
    const m = mk('ir-sense-', 60, 0);
    // 1) 常态（如实机最高 33 < 40）不触发过载体感，保持基线
    m.interactionDensity = 39;
    const sLow = m.formatPerception(DAYT);
    const lowClean = sLow.includes('身体安稳') && !sLow.includes('节奏有些密') && !sLow.includes('过载散乱');

    // 2) 中档（>= 40，对应连戳 10 下 10×4=40）：慢下来、安静待会儿
    m.interactionDensity = 40;
    const sMid = m.formatPerception(DAYT);
    const midHit = sMid.includes('互动与触碰节奏有些密') && sMid.includes('自己安静待一会儿') && !sMid.includes('身体安稳') && !/\d/.test(sMid);

    // 3) 重档（>= 60，对应连戳 15 下 15×4=60）：心神过载散乱，委婉表达退避与独处权
    m.interactionDensity = 60;
    const sHigh = m.formatPerception(DAYT);
    const highHit = sHigh.includes('过于密集') && sHigh.includes('心神有些过载散乱') && sHigh.includes('不必无条件迎合') && !/\d/.test(sHigh);

    return lowClean && midHit && highHit;
  })());

  check('v1.0.7 社交过载体感随静默挂机自然消退（事件驱动恢复，零残留）', (() => {
    const m = mk('ir-sense-', 60, 0);
    // 模拟连续戳击 12 下（12×4 = 48 >= 40）进入中档过载体感
    for (let i = 0; i < 12; i++) {
      m.updateOnActivity('poke', { count: 1, timestamp: DAYT + i * 200 });
    }
    const overloaded = m.getState().interactionDensity === 48 && m.formatPerception(DAYT).includes('自己安静待一会儿');
    // 静默挂机两次（每次 -10）后跌回 28 < 40，过载体感自然消退
    m.updateOnActivity('idle', { idleMin: 10, stepMin: 10, timestamp: DAYT + 10 * 60000 });
    m.updateOnActivity('idle', { idleMin: 20, stepMin: 10, timestamp: DAYT + 20 * 60000 });
    const recovered = m.getState().interactionDensity === 28 && !m.formatPerception(DAYT + 20 * 60000).includes('自己安静待一会儿');
    return overloaded && recovered;
  })());
})();

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
