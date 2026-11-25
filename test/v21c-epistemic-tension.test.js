/**
 * test/v21c-epistemic-tension.test.js
 *
 * v2.1-c 轻量认知张力调制 + v2.1-d 记忆再巩固观测埋点门禁：
 *   1. computeEpistemicTension 纯函数：零值/有界 [0,1]/baseline=true 强制 0/负向 surprise 不抬升张力；
 *   2. TriggerEngine 双向调制：SELF_NOTE_IDLE_MS [0.8x, 1.2x] (96~144min)，CURIOSITY_IDLE_MS [1.0x, 1.2x] (30~36min)；
 *   3. 防骚扰三铁律守卫：外层 idleNeed、COOLDOWN_MS、CURIOSITY_THROTTLE_MS、sleepMode 均不可被张力突破；
 *   4. lastWindowTension 关窗计算、写入 internal-regulation.json 持久化、冷启动恢复与 baseline 隔离；
 *   5. v2.1-d 再巩固观测埋点：FADING/DORMANT 跨窗唤醒写入 experiment-telemetry.jsonl（不入 agent-observations.jsonl），ACTIVE/proactive/baseline 严格隔离；
 *   6. main.js 统一入口接线（零扫盘）与 D-001 静态零轮询扫描。
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v21c-epistemic-'));
}

const { TriggerEngine, computeEpistemicTension } = require(path.join(ROOT, 'src', 'trigger'));
const { ActivityTracker } = require(path.join(ROOT, 'src', 'tracker'));
const { InternalRegulationManager } = require(path.join(ROOT, 'src', 'internal-regulation'));
const { Brain } = require(path.join(ROOT, 'src', 'brain'));
const { DEFAULTS } = require(path.join(ROOT, 'src', 'config'));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const MIN = 60000;
  const T0 = 1795600000000;

  // ---- 1. computeEpistemicTension 纯函数边界 ----
  {
    check('1.1 全零输入返回 0',
      computeEpistemicTension({ ledgerMaxPressure: 0, reunionSurprise: 0, lastWindowTension: 0 }) === 0);

    check('1.2 负向预测误差 (-2) 不贡献张力，正误差 (+3) 按上界贡献 0.30',
      computeEpistemicTension({ ledgerMaxPressure: 0, reunionSurprise: -2, lastWindowTension: 0 }) === 0 &&
      computeEpistemicTension({ ledgerMaxPressure: 0, reunionSurprise: 3, lastWindowTension: 0 }) === 0.3);

    check('1.3 超界高输入严格钳在 [0, 1]',
      computeEpistemicTension({ ledgerMaxPressure: 9, reunionSurprise: 99, lastWindowTension: 5 }) === 1);

    check('1.4 baseline=true 时无论输入多高恒返回 0',
      computeEpistemicTension({ baseline: true, ledgerMaxPressure: 1, reunionSurprise: 3, lastWindowTension: 1 }) === 0);
  }

  // ---- 2. TriggerEngine 有界双向调制 & 防骚扰三铁律 ----
  {
    let fakeNow = T0;
    const tracker = new ActivityTracker({ now: () => fakeNow });
    const engine = new TriggerEngine(tracker, { now: () => fakeNow });

    // 2.1 SELF_NOTE_IDLE_MS: 100min 时，无张力 (120min) 不出 wantToLeaveSomething，高张力 (0.8x = 96min) 产出 wantToLeaveSomething
    fakeNow = T0 + 100 * MIN;
    const offer100Normal = engine.evaluate({ epistemicTension: 0.5 });
    const offer100High = engine.evaluate({ epistemicTension: 1.0 });
    check('2.1 高张力 (1.0) 将自发便签门槛下调至 96min (100min 触发 wantToLeaveSomething)',
      offer100Normal && offer100Normal.kind === 'idle' && (!offer100Normal.selfIntent || offer100Normal.selfIntent.kind !== 'wantToLeaveSomething') &&
      offer100High && offer100High.selfIntent && offer100High.selfIntent.kind === 'wantToLeaveSomething');

    // 2.2 低张力 (0) 将自发便签门槛上调至 144min (125min 时普通行为已触发，但 tension=0 暂缓写便签)
    fakeNow = T0 + 125 * MIN;
    const offer125Neutral = engine.evaluate({});
    const offer125Calm = engine.evaluate({ epistemicTension: 0 });
    check('2.2 低张力 (0) 将自发便签门槛拉长至 144min (125min 仍安于陪伴，不出 wantToLeaveSomething)',
      offer125Neutral && offer125Neutral.selfIntent && offer125Neutral.selfIntent.kind === 'wantToLeaveSomething' &&
      offer125Calm && (!offer125Calm.selfIntent || offer125Calm.selfIntent.kind !== 'wantToLeaveSomething'));

    // 2.3 CURIOSITY_IDLE_MS: 高张力不突破外层 30min idleNeed (28min 不出)，低张力拉长至 36min (32min 不出 curiosityAsk, 36min 出)
    fakeNow = T0 + 28 * MIN;
    const cur28 = engine.evaluate({ epistemicTension: 1.0, curiosityPending: 1, curiosityQuestion: '为什么天空是蓝的？' });
    check('2.3 高张力 (1.0) 绝不突破外层 30min idleNeed (28min 返回 null)', cur28 === null);

    fakeNow = T0 + 32 * MIN;
    const cur32High = engine.evaluate({ epistemicTension: 1.0, curiosityPending: 1, curiosityQuestion: '为什么天空是蓝的？' });
    const cur32Calm = engine.evaluate({ epistemicTension: 0, curiosityPending: 1, curiosityQuestion: '为什么天空是蓝的？' });
    check('2.4 32min 静默：高张力允许 curiosityAsk，低张力 (0) 延后至 36min',
      cur32High && cur32High.selfIntent && cur32High.selfIntent.kind === 'curiosityAsk' &&
      cur32Calm && (!cur32Calm.selfIntent || cur32Calm.selfIntent.kind !== 'curiosityAsk'));

    fakeNow = T0 + 36 * MIN;
    const cur36Calm = engine.evaluate({ epistemicTension: 0, curiosityPending: 1, curiosityQuestion: '为什么天空是蓝的？' });
    check('2.5 跨过 36min 后低张力下 curiosityAsk 正常恢复',
      cur36Calm && cur36Calm.selfIntent && cur36Calm.selfIntent.kind === 'curiosityAsk');

    // 2.6 冷却、40min 好奇节流与睡眠铁律不可被高张力突破
    engine.commit(cur32High);
    fakeNow = T0 + 32 * MIN + 10 * 1000; // 10s < 45s COOLDOWN_MS
    check('2.6a 45s 冷却闸门在高张力下仍不可突破',
      engine.evaluate({ epistemicTension: 1.0, curiosityPending: 1, curiosityQuestion: 'q' }) === null);

    fakeNow = T0 + 50 * MIN; // > 45s cooldown, < 40min curiosity throttle (from 32min -> 18min elapsed)
    tracker.spokenDuringIdle = false;
    const blockedCur = engine.evaluate({ epistemicTension: 1.0, curiosityPending: 1, curiosityQuestion: 'q' });
    check('2.6b 40min 好奇节流在高张力下仍不可突破',
      blockedCur && (!blockedCur.selfIntent || blockedCur.selfIntent.kind !== 'curiosityAsk'));

    tracker.enterSleepMode(fakeNow);
    fakeNow += 200 * MIN;
    check('2.6c 睡眠闸门在高张力下仍不可突破',
      engine.evaluate({ epistemicTension: 1.0, curiosityPending: 1, curiosityQuestion: 'q' }) === null);

    // 2.7 undefined / null / '' 均必须绕过张力调制，严禁被 Number(null)===0 误伤为 1.2x 拉长
    let nowIso = T0;
    const trIso = new ActivityTracker({ now: () => nowIso });
    const engIso = new TriggerEngine(trIso, { now: () => nowIso });
    nowIso = T0 + 125 * MIN;
    const isoNoteUndef = engIso.evaluate({ epistemicTension: undefined });
    const isoNoteNull = engIso.evaluate({ epistemicTension: null });
    const isoNoteEmpty = engIso.evaluate({ epistemicTension: '' });
    const isoNoteZero = engIso.evaluate({ epistemicTension: 0 });
    nowIso = T0 + 31 * MIN;
    const isoCurUndef = engIso.evaluate({ epistemicTension: undefined, curiosityPending: 1, curiosityQuestion: 'q' });
    const isoCurNull = engIso.evaluate({ epistemicTension: null, curiosityPending: 1, curiosityQuestion: 'q' });
    const isoCurZero = engIso.evaluate({ epistemicTension: 0, curiosityPending: 1, curiosityQuestion: 'q' });
    check('2.7 undefined/null/空串严格绕过张力调制（125min 出自发便签、31min 出好奇问句，区别于 0 的 1.2x 拉长）',
      isoNoteUndef && isoNoteUndef.selfIntent && isoNoteUndef.selfIntent.kind === 'wantToLeaveSomething' &&
      isoNoteNull && isoNoteNull.selfIntent && isoNoteNull.selfIntent.kind === 'wantToLeaveSomething' &&
      isoNoteEmpty && isoNoteEmpty.selfIntent && isoNoteEmpty.selfIntent.kind === 'wantToLeaveSomething' &&
      isoNoteZero && (!isoNoteZero.selfIntent || isoNoteZero.selfIntent.kind !== 'wantToLeaveSomething') &&
      isoCurUndef && isoCurUndef.selfIntent && isoCurUndef.selfIntent.kind === 'curiosityAsk' &&
      isoCurNull && isoCurNull.selfIntent && isoCurNull.selfIntent.kind === 'curiosityAsk' &&
      isoCurZero && (!isoCurZero.selfIntent || isoCurZero.selfIntent.kind !== 'curiosityAsk'));
  }

  // ---- 3. lastWindowTension 持久化、Brain.closeWindow 写入与 baseline 隔离 ----
  {
    const irDir = makeTempDir();
    const mgr = new InternalRegulationManager(irDir);
    mgr.updateOnWindowClose(7, { lastWindowTension: 0.725 });
    const reloaded = new InternalRegulationManager(irDir);
    check('3.1 lastWindowTension 随 internal-regulation.json 跨重启完整恢复',
      reloaded.getLastWindowTension() === 0.725);

    const baseMgr = new InternalRegulationManager(irDir, { enabled: false });
    check('3.2 baseline (enabled=false) 不加载且 getLastWindowTension() 恒返回 0',
      baseMgr.getLastWindowTension() === 0);

    // Brain 关窗端到端写入非零 lastWindowTension
    const bDir = makeTempDir();
    const brain = new Brain(bDir, {
      ...DEFAULTS,
      apiKey: 'sk-mock-v21c',
      experimentMode: 'experimental',
      keepTailMessages: 0,
      experimentModules: {
        ...DEFAULTS.experimentModules,
        internalRegulation: true,
        sleepConsolidation: false
      }
    });
    brain.api.stream = async (_msgs, onDelta) => {
      onDelta('嗯，记下了。');
      return { text: '嗯，记下了。', observedModel: 'deepseek-flash', usage: { prompt_tokens: 40, completion_tokens: 8 } };
    };
    brain.api.complete = async (messages) => {
      const last = messages[messages.length - 1].content;
      if (last.includes('【对话】') || last.includes('小结')) {
        return {
          text: JSON.stringify({
            windowSynthesis: { stableUserFacts: ['测试张力'], subjectExperiences: ['情绪波动'] },
            segments: [{ range: '1-2', userGiven: ['测试'], chulanExperience: ['起伏'], stateEvidence: [] }]
          }),
          observedModel: 'deepseek-flash',
          usage: { prompt_tokens: 80, completion_tokens: 40 }
        };
      }
      return { text: '[]', observedModel: 'deepseek-flash', usage: { prompt_tokens: 20, completion_tokens: 5 } };
    };

    await brain.ask('第一句平稳对话', () => {});
    // 人为制造一段高 arousal 跳变历史，使本窗 arousalTrajectory 产生明显方差/跳峰
    brain.internalRegulation.history.push({
      timestamp: Date.now() - 1000,
      nextValues: { arousal: 20 }
    });
    brain.internalRegulation.arousal = 92;
    await brain.ask('第二句突然强烈情绪刺激！', () => {});

    await brain.closeWindow('turn_limit');
    const savedTension = brain.internalRegulation.getLastWindowTension();
    const reloadedAfterClose = new InternalRegulationManager(bDir);
    check('3.3 Brain.closeWindow 写入非零 lastWindowTension 并落盘可恢复',
      savedTension > 0 && reloadedAfterClose.getLastWindowTension() === savedTension,
      `lastWindowTension=${savedTension}`);
  }

  // ---- 4. v2.1-d 记忆再巩固观测埋点 ----
  {
    const bDir = makeTempDir();
    const brain = new Brain(bDir, {
      ...DEFAULTS,
      apiKey: 'sk-mock-v21d',
      experimentMode: 'experimental',
      experimentModules: {
        ...DEFAULTS.experimentModules,
        memoryDynamics: true,
        internalRegulation: true,
        sleepConsolidation: false
      }
    });
    brain.api.stream = async (_msgs, onDelta) => {
      onDelta('我想起来那件事了。');
      return { text: '我想起来那件事了。', observedModel: 'deepseek-flash', usage: { prompt_tokens: 30, completion_tokens: 6 } };
    };

    // 准备窗口 1（含特色关键词）与窗口 2（ACTIVE），推到窗口 8 让窗口 1 处于 DORMANT、窗口 2 处于 FADING/ACTIVE
    brain.memory.data.windows.push({ no: 1, text: '那天下着雪我们在海边钢琴馆听曲子' });
    brain.memory.data.windows.push({ no: 2, text: '昨天聊过天文台望远镜观测星云' });
    brain.memory.data.windows.push({ no: 8, text: '今天聊聊日常工作代码调试' });
    brain.memory.data.windowNo = 8;

    const em = brain.memory.engramManager;
    em.registerTrace({ traceId: 'tr-dormant-1', sourceWindowNo: 1, createdWindow: 1 });
    em.registerTrace({ traceId: 'tr-fading-2', sourceWindowNo: 2, createdWindow: 5 });
    em.registerTrace({ traceId: 'tr-active-8', sourceWindowNo: 8, createdWindow: 8 });
    // 手动标定三档，模拟跨窗衰减后的存量状态；屏蔽本窗非自愿回忆抢占候选
    brain.memory.data.lastInvoluntaryWindow = 8;
    em.getTrace('tr-dormant-1').tier = 'DORMANT';
    em.getTrace('tr-fading-2').tier = 'FADING';
    em.getTrace('tr-active-8').tier = 'ACTIVE';

    // 4.1 ACTIVE 印痕被唤醒不写 reconsolidation_candidate_observed
    await brain.ask('今天继续聊日常工作代码调试吧', () => {});
    const telAfterActive = fs.existsSync(brain.telemetryPath)
      ? fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    const activeHits = telAfterActive.filter(r => r.recordType === 'reconsolidation_candidate_observed');
    check('4.1 ACTIVE 印痕被唤醒不写 reconsolidation_candidate_observed', activeHits.length === 0);

    // 4.2 proactive=true 也不触发埋点
    await brain.ask('海边钢琴馆听曲子', () => {}, { proactive: true });
    const telAfterProactive = fs.existsSync(brain.telemetryPath)
      ? fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    check('4.2 proactive=true 不触发再巩固观测埋点',
      telAfterProactive.filter(r => r.recordType === 'reconsolidation_candidate_observed').length === 0);

    // 4.3 !proactive 命中 DORMANT 印痕时正确写入 telemetry（含完整 4 字段）且不写入 agent-observations.jsonl
    await brain.ask('你还记得海边钢琴馆听曲子吗', () => {});
    const telAfterDormant = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const reconRecords = telAfterDormant.filter(r => r.recordType === 'reconsolidation_candidate_observed');
    const obsPath = path.join(bDir, 'agent-observations.jsonl');
    check('4.3 DORMANT 跨窗唤醒写入 reconsolidation_candidate_observed（含完整四字段）且零污染 agent-observations.jsonl',
      reconRecords.length === 1 &&
      reconRecords[0].traceId === 'tr-dormant-1' &&
      reconRecords[0].sourceWindowNo === 1 &&
      reconRecords[0].reactivatedWindowNo === 8 &&
      reconRecords[0].prevTier === 'DORMANT' &&
      !fs.existsSync(obsPath),
      JSON.stringify(reconRecords[0] || null));

    // 4.4 FADING 印痕跨窗唤醒同样记录 prevTier === 'FADING'
    await brain.ask('还想起天文台望远镜观测星云', () => {});
    const telAfterFading = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const fadingRecs = telAfterFading.filter(r => r.recordType === 'reconsolidation_candidate_observed' && r.traceId === 'tr-fading-2');
    check('4.4 FADING 跨窗唤醒写入 prevTier="FADING" 观测记录',
      fadingRecs.length === 1 && fadingRecs[0].prevTier === 'FADING');

    // 4.5 baseline 模式隔离：即使手工挂入模拟 engramManager 也不写再巩固埋点
    const baseDir = makeTempDir();
    const baseBrain = new Brain(baseDir, {
      ...DEFAULTS,
      apiKey: 'sk-mock-v21d-base',
      experimentMode: 'baseline'
    });
    baseBrain.api.stream = async (_msgs, onDelta) => {
      onDelta('嗯。');
      return { text: '嗯。', observedModel: 'deepseek-flash', usage: { prompt_tokens: 20, completion_tokens: 4 } };
    };
    baseBrain.memory.engramManager = {
      getAllTraces: () => [{ traceId: 'tr-b', sourceWindowNo: 1, createdWindow: 1, lastRetrievedWindow: 1, tier: 'DORMANT' }],
      getDormantTraces: () => [],
      getFadingTraces: () => [],
      reactivate: () => ({ traceId: 'tr-b', sourceWindowNo: 1, createdWindow: 1, tier: 'DORMANT' }),
      exportSnapshot: () => ({})
    };
    baseBrain.memory.data.windows.push({ no: 1, text: '海边钢琴馆听曲子' });
    baseBrain.memory.data.windowNo = 8;
    await baseBrain.ask('海边钢琴馆听曲子', () => {});
    const baseTel = fs.existsSync(baseBrain.telemetryPath)
      ? fs.readFileSync(baseBrain.telemetryPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    check('4.5 baseline 模式下绝对不写 reconsolidation_candidate_observed',
      baseTel.filter(r => r.recordType === 'reconsolidation_candidate_observed').length === 0);
  }

  // ---- 5. main.js 接线与 D-001 静态扫描 ----
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const fnStart = mainSrc.indexOf('function evaluateTriggerWithCuriosity()');
    const fnEnd = fnStart >= 0 ? mainSrc.indexOf('\n}', fnStart) : -1;
    const fnBody = (fnStart >= 0 && fnEnd > fnStart) ? mainSrc.slice(fnStart, fnEnd + 2) : '';
    check('5.1 main.js evaluateTriggerWithCuriosity() 计算 epistemicTension 且绝不扫 experiences.jsonl',
      fnBody.length > 0 && /computeEpistemicTension/.test(fnBody) && !/experiences|readAll/.test(fnBody));

    check('5.1b main.js baseline 模式将 epistemicTension 置为 undefined 而非数值 0',
      /const\s+epistemicTension\s*=\s*isBaseline\s*\?\s*undefined/.test(fnBody));

    const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const trSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'trigger.js'), 'utf8'));
    const irSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'internal-regulation.js'), 'utf8'));
    check('5.2 D-001 静态门禁：trigger.js 与 internal-regulation.js 零 setInterval/setTimeout',
      !/\b(setInterval|setTimeout)\b/.test(trSrc) && !/\b(setInterval|setTimeout)\b/.test(irSrc));
  }

  console.log('');
  console.log('失败 ' + failures + ' 项');
  process.exit(failures ? 1 : 0);
})();
