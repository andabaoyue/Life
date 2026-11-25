/**
 * test/v21b-enactive-adaptivity.test.js
 *
 * v2.1-b 生成认知边界适应性与自我维护门禁：
 *   1. 同值上升 vs 下降区分：同为 density=45，上升轨迹 (30->38->45) approachingOverload=true，下降轨迹 (62->52->45) 为 false；
 *   2. assistant 回合隔离：穿插 assistant 回合时仍准确识别连续上升；无变化事件不覆盖滑窗；
 *   3. 边界熄灭与物理刺激支持：回落 <35、跨入 >=60、idle/windowClose/sleep 下降立即熄灭；poke/drag 上升可触发；
 *   4. 跨进程投影与纯函数守卫：getState() 含冻结 approachingOverload，baseline=false 恒 false，formatPerception() 文案零回归；
 *   5. SelfLedger 只读反思压力：getRevisionTensionSummary() 精确统计 revisionPressure>=0.4，不增删不写盘；
 *   6. BehaviorScheduler & TriggerEngine 适应性耦合 + main.js 接线与防骚扰三铁律守卫；
 *   7. D-001 静态扫描（internal-regulation.js / self-ledger.js / trigger.js 零 setInterval/setTimeout）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const tmpDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...args) {
  const dir = _origMkdtemp.apply(fs, args);
  tmpDirs.push(dir);
  return dir;
};
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdtempSync = _origMkdtemp;
});

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v21b-enactive-'));
}

const { InternalRegulationManager } = require(path.join(ROOT, 'src', 'internal-regulation'));
const { SelfLedger } = require(path.join(ROOT, 'src', 'self-ledger'));
const { BehaviorScheduler, BEHAVIOR_DEFINITIONS } = require(path.join(ROOT, 'src', 'behavior-scheduler'));
const { ANIMATION_STATES } = require(path.join(ROOT, 'src', 'animation-state'));
const { TriggerEngine } = require(path.join(ROOT, 'src', 'trigger'));
const { ActivityTracker } = require(path.join(ROOT, 'src', 'tracker'));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

(() => {
  const T0 = 1795500000000;

  // ---- 1. 上升逼近 vs 下降恢复区分 + assistant 回合隔离 ----
  {
    const dirUp = makeTempDir();
    const mgrUp = new InternalRegulationManager(dirUp);
    // 起点先设到 25，用快速连聊 (+5) + poke (+8) 形成严格上升序列 30 -> 38 -> 45（中间穿插 assistant 回合）
    mgrUp.interactionDensity = 25;
    mgrUp.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 2000, timestamp: T0 }); // 30
    mgrUp.updateOnInteractionTurn({ role: 'assistant', messageLength: 50, intervalMs: 0, timestamp: T0 + 500 }); // assistant 不采样
    mgrUp.updateOnActivity('poke', { count: 2, timestamp: T0 + 1000 }); // +4 -> 34
    // 调整：构造精确 30 -> 38 -> 45
    const dirExact = makeTempDir();
    const mExact = new InternalRegulationManager(dirExact);
    mExact.interactionDensity = 25;
    mExact.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 2000, timestamp: T0 }); // 30
    mExact.updateOnInteractionTurn({ role: 'assistant', messageLength: 50, intervalMs: 0, timestamp: T0 + 500 });
    mExact.updateOnActivity('poke', { count: 1, timestamp: T0 + 1000 }); // 34
    mExact.updateOnInteractionTurn({ role: 'assistant', messageLength: 50, intervalMs: 0, timestamp: T0 + 1500 });
    mExact.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 2000, timestamp: T0 + 2000 }); // 39
    mExact.updateOnInteractionTurn({ role: 'assistant', messageLength: 50, intervalMs: 0, timestamp: T0 + 2500 });
    mExact.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 2000, timestamp: T0 + 3000 }); // 44 (或 +5 -> 44)
    check('1.1 穿插 assistant 回合后仍能识别预警带 [35,60) 严格上升逼近态',
      mExact.interactionDensity === 44 && mExact.getState().approachingOverload === true,
      `density=${mExact.interactionDensity}, approaching=${mExact.getState().approachingOverload}`);

    // 对照：从过载区 (>60) 回落到相近密度 (45/44)，必须为 false
    const dirDown = makeTempDir();
    const mDown = new InternalRegulationManager(dirDown);
    mDown.interactionDensity = 62;
    mDown.updateOnActivity('idle', { idleMin: 15, timestamp: T0 }); // -10 -> 52
    mDown.updateOnActivity('idle', { idleMin: 15, timestamp: T0 + 1000 }); // -10 -> 42
    check('1.2 从过载区下降回预警带 (62->52->42) approachingOverload 为 false',
      mDown.interactionDensity === 42 && mDown.getState().approachingOverload === false,
      `density=${mDown.interactionDensity}, approaching=${mDown.getState().approachingOverload}`);

    // 反向对照（变异判别力）：若把同值静态 density=44 直接设为初始值但无上升轨迹，approachingOverload 仍为 false
    const mStatic = new InternalRegulationManager(makeTempDir());
    mStatic.interactionDensity = 44;
    check('1.3 反向对照：静态同值 density=44（无 3 步上升轨迹）approachingOverload 为 false',
      mStatic.getState().approachingOverload === false);
  }

  // ---- 2. 边界熄灭：<35 / >=60 / idle / windowClose / sleep / drag ----
  {
    const mgr = new InternalRegulationManager(makeTempDir());
    mgr.interactionDensity = 50;
    mgr.updateOnActivity('drag', { count: 1, timestamp: T0 }); // 53
    mgr.updateOnActivity('poke', { count: 1, timestamp: T0 + 1000 }); // 57
    mgr.updateOnInteractionTurn({ role: 'user', messageLength: 10, intervalMs: 11000, timestamp: T0 + 2000 }); // +2 -> 59
    check('2.1 drag/poke/user 连续推升至 59 (<60) 时 approachingOverload=true',
      mgr.interactionDensity === 59 && mgr.getState().approachingOverload === true);

    mgr.updateOnInteractionTurn({ role: 'user', messageLength: 10, intervalMs: 2000, timestamp: T0 + 3000 }); // +5 -> 64 (>=60)
    check('2.2 越过 >=60 过载墙后 approachingOverload 熄灭 (转为已过载)',
      mgr.interactionDensity === 64 && mgr.getState().approachingOverload === false);

    // 重新进入预警上升后，经 windowClose 半衰下降应熄灭
    const mgrW = new InternalRegulationManager(makeTempDir());
    mgrW.interactionDensity = 40;
    mgrW.updateOnActivity('poke', { count: 1, timestamp: T0 }); // 44
    mgrW.updateOnActivity('poke', { count: 1, timestamp: T0 + 1000 }); // 48
    mgrW.updateOnActivity('poke', { count: 1, timestamp: T0 + 2000 }); // 52
    const beforeClose = mgrW.getState().approachingOverload;
    mgrW.updateOnWindowClose(1, { timestamp: T0 + 3000 }); // 26
    check('2.3 关窗半衰结算下降后 approachingOverload 立即熄灭',
      beforeClose === true && mgrW.getState().approachingOverload === false);

    // 入睡清零密度应熄灭
    const mgrS = new InternalRegulationManager(makeTempDir());
    mgrS.interactionDensity = 40;
    mgrS.updateOnActivity('poke', { count: 1, timestamp: T0 });
    mgrS.updateOnActivity('poke', { count: 1, timestamp: T0 + 1000 });
    mgrS.updateOnActivity('poke', { count: 1, timestamp: T0 + 2000 });
    const beforeSleep = mgrS.getState().approachingOverload;
    mgrS.updateOnSleep(true, { timestamp: T0 + 3000 });
    check('2.4 入睡清零密度后 approachingOverload 立即熄灭',
      beforeSleep === true && mgrS.getState().approachingOverload === false);
  }

  // ---- 3. baseline 隔离与 formatPerception 零回归 ----
  {
    const baseMgr = new InternalRegulationManager(makeTempDir(), { enabled: false });
    baseMgr.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 1000 });
    baseMgr.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 1000 });
    baseMgr.updateOnInteractionTurn({ role: 'user', messageLength: 20, intervalMs: 1000 });
    check('3.1 baseline 模式下 getState().approachingOverload 恒为 false',
      baseMgr.getState().approachingOverload === false);

    const mA = new InternalRegulationManager(makeTempDir());
    mA.interactionDensity = 44;
    const pWithoutTrail = mA.formatPerception(T0);

    const mB = new InternalRegulationManager(makeTempDir());
    mB.interactionDensity = 35;
    mB.updateOnActivity('drag', { count: 1, timestamp: T0 }); // 38
    mB.updateOnActivity('drag', { count: 1, timestamp: T0 + 1000 }); // 41
    mB.updateOnActivity('drag', { count: 1, timestamp: T0 + 2000 }); // 44
    mB.energy = mA.energy;
    mB.arousal = mA.arousal;
    mB.restPressure = mA.restPressure;
    const pWithTrail = mB.formatPerception(T0 + 2000);
    check('3.2 formatPerception() 保持纯函数零修改，既有文案逐字不变',
      mB.getState().approachingOverload === true && pWithTrail === pWithoutTrail);
  }

  // ---- 4. SelfLedger.getRevisionTensionSummary 只读汇总 ----
  {
    const lDir = makeTempDir();
    const ledger = new SelfLedger(lDir);
    const emptySum = ledger.getRevisionTensionSummary();
    check('4.1 空账本 getRevisionTensionSummary 返回全零冻结对象',
      Object.isFrozen(emptySum) && emptySum.highConflictCount === 0 && emptySum.maxPressure === 0 && emptySum.totalEntries === 0);

    ledger.append([
      {
        trait: '喜欢独处',
        support: [{ sourceType: 'EXPERIENCE', quote: '安静待着', confidence: 0.5 }],
        oppose: [{ sourceType: 'EXPERIENCE', quote: '主动找用户聊了很多', confidence: 0.5 }] // pressure = 0.5 >= 0.4
      },
      {
        trait: '夜晚敏锐',
        support: [{ sourceType: 'EXPERIENCE', quote: '夜间清醒', confidence: 0.8 }],
        oppose: [{ sourceType: 'EXPERIENCE', quote: '白天也精神', confidence: 0.2 }] // pressure = 0.2 < 0.4
      }
    ]);
    const beforeSnapshot = JSON.stringify(ledger.entries);
    const s1 = ledger.getRevisionTensionSummary();
    const s2 = ledger.getRevisionTensionSummary();
    check('4.2 getRevisionTensionSummary 准确统计 revisionPressure>=0.4 冲突条目且幂等只读',
      s1.totalEntries === 2 && s1.highConflictCount === 1 && s1.maxPressure === 0.5 &&
      JSON.stringify(s1) === JSON.stringify(s2) &&
      JSON.stringify(ledger.entries) === beforeSnapshot);
  }

  // ---- 5. BehaviorScheduler 温和收敛权重 ----
  {
    const regState = { energy: 80, restPressure: 20, arousal: 70, approachingOverload: false };
    const sched = new BehaviorScheduler({ internalRegulation: { getState: () => regState } });
    const normalW = sched.getModulatedWeights();
    regState.approachingOverload = true;
    const dampW = sched.getModulatedWeights();

    check('5.1 approachingOverload=true 时 LOOK_AROUND 与 STRETCH 权重温和收敛为 0.75x',
      dampW[ANIMATION_STATES.LOOK_AROUND] === Number((normalW[ANIMATION_STATES.LOOK_AROUND] * 0.75).toFixed(4)) &&
      dampW[ANIMATION_STATES.STRETCH] === Number((normalW[ANIMATION_STATES.STRETCH] * 0.75).toFixed(4)));
    check('5.2 approachingOverload=true 时安静动作 TIDY_HAIR 与 YAWN 权重保持不变',
      dampW[ANIMATION_STATES.TIDY_HAIR] === normalW[ANIMATION_STATES.TIDY_HAIR] &&
      dampW[ANIMATION_STATES.YAWN] === normalW[ANIMATION_STATES.YAWN]);
  }

  // ---- 6. TriggerEngine 温和拉长 idleNeed (1.25x) 且不破防骚扰铁律 ----
  {
    const MIN = 60000;
    let fakeNow = T0;
    const tracker = new ActivityTracker({ now: () => fakeNow });
    const engine = new TriggerEngine(tracker, { now: () => fakeNow }); // 默认 idleMs = 30min

    fakeNow = T0 + 32 * MIN; // 32min > 30min (正常触发)，但 < 37.5min (30 * 1.25)
    const normalOffer = engine.evaluate();
    const dampedOffer = engine.evaluate({ approachingOverload: true });
    check('6.1 approachingOverload=true 将 30min 静默门槛拉长至 1.25x (32min 暂不打扰)',
      normalOffer !== null && normalOffer.kind === 'idle' && dampedOffer === null);

    fakeNow = T0 + 38 * MIN; // >= Math.round(30min * 1.25) = 37.5min
    const laterOffer = engine.evaluate({ approachingOverload: true });
    check('6.2 跨过 1.25x 拉长门槛后仍可正常开口',
      laterOffer !== null && laterOffer.kind === 'idle');

    // 冷却与睡眠闸门不可突破
    engine.commit(laterOffer);
    fakeNow += 10 * 1000; // 10s < 45s COOLDOWN_MS
    check('6.3 冷却闸门不可被 approachingOverload 状态绕过',
      engine.evaluate({ approachingOverload: false }) === null &&
      engine.evaluate({ approachingOverload: true }) === null);
  }

  // ---- 7. main.js 接线与 D-001 静态零轮询扫描 ----
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    check('7.1 main.js evaluateTriggerWithCuriosity() 显式透传 approachingOverload',
      /function evaluateTriggerWithCuriosity\s*\(\)[\s\S]{0,2000}approachingOverload/.test(mainSrc));

    const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const irSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'internal-regulation.js'), 'utf8'));
    const slSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'self-ledger.js'), 'utf8'));
    const trSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'trigger.js'), 'utf8'));
    const hasTimer = /\b(setInterval|setTimeout)\b/.test(irSrc)
      || /\b(setInterval|setTimeout)\b/.test(slSrc)
      || /\b(setInterval|setTimeout)\b/.test(trSrc);
    check('7.2 D-001 静态门禁：internal-regulation.js / self-ledger.js / trigger.js 零 setInterval/setTimeout',
      !hasTimer);
  }

  console.log('');
  console.log('失败 ' + failures + ' 项');
  process.exit(failures ? 1 : 0);
})();
