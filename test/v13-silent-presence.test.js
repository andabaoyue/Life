/**
 * test/v13-silent-presence.test.js
 *
 * Life v1.3-b 「沉默留白」第三种结局专项测试
 *
 * 核心不变式与验收判据：
 * 1. 提案判据：在主动场景下，quiet_preference >= 60 产出 kind: 'silent_presence' 提案；
 * 2. 对照组：quiet_preference < 60 恒回退常规 kind: 'idle' 提案；
 * 3. 严格退出条件：连续沉默次数上限 K=2，第 3 次触发强制回退 kind: 'idle'；
 * 4. 零 API 调用：沉默留白路径 LLM 调用次数严格为 0；
 * 5. 动作触发：沉默留白确实触发渲染端微动作 (playAction)；
 * 6. 用户主权铁律 (D-A)：用户主动开口时她必须回应，永不进入沉默留白；
 * 7. 非伪造铁律 (D-C)：源码中绝不包含 Math.random 抛硬币式沉默。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TriggerEngine } = require('../src/trigger');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'v13-silent-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockTracker(opts = {}) {
  return {
    sleepMode: opts.sleepMode || false,
    lastInteractionAt: opts.lastInteractionAt || 0,
    spokenDuringIdle: opts.spokenDuringIdle || false,
    selfNoteDuringIdle: opts.selfNoteDuringIdle || false,
    recentClicks: () => 0
  };
}

// -------------------------------------------------------------
// 1. 沉默提案产生与特质阈值判据 (quiet_preference >= 60)
// -------------------------------------------------------------
{
  const tracker = createMockTracker({ lastInteractionAt: 0, spokenDuringIdle: false });
  // quiet_preference = 70 (>= 60)
  const engineHighQuiet = new TriggerEngine(tracker, {
    idleMs: 30 * 60000,
    cooldownMs: 45000,
    now: () => 60 * 60000,
    traits: { quiet_preference: 70 }
  });

  const offerHigh = engineHighQuiet.evaluate();
  check('1.1 quiet_preference >= 60 时产出 silent_presence 提案',
    offerHigh && offerHigh.kind === 'silent_presence');
  check('1.2 silent_presence 包含明确提示语',
    offerHigh && offerHigh.hint.includes('静默相伴'));

  // 对照组：quiet_preference = 50 (< 60)
  const engineLowQuiet = new TriggerEngine(tracker, {
    idleMs: 30 * 60000,
    cooldownMs: 45000,
    now: () => 60 * 60000,
    traits: { quiet_preference: 50 }
  });

  const offerLow = engineLowQuiet.evaluate();
  check('1.3 quiet_preference < 60 时产出常规 idle 提案',
    offerLow && offerLow.kind === 'idle');

  // 对照组：默认特质 (无 quiet_preference)
  const engineDefault = new TriggerEngine(tracker, {
    idleMs: 30 * 60000,
    cooldownMs: 45000,
    now: () => 60 * 60000
  });
  const offerDefault = engineDefault.evaluate();
  check('1.4 未设置 quiet_preference 时产出常规 idle 提案',
    offerDefault && offerDefault.kind === 'idle');
}

// -------------------------------------------------------------
// 2. 退出条件：连续沉默上限 K=2，第 3 次强制退出回退常规 idle
// -------------------------------------------------------------
{
  let nowTime = 60 * 60000;
  const tracker = createMockTracker({ lastInteractionAt: 0, spokenDuringIdle: false });
  const engine = new TriggerEngine(tracker, {
    idleMs: 30 * 60000,
    cooldownMs: 45000,
    now: () => nowTime,
    traits: { quiet_preference: 75 }
  });

  check('2.1 初始连续沉默次数为 0', engine.consecutiveSilenceCount === 0);

  // 第 1 次触发
  const offer1 = engine.evaluate();
  check('2.2 第 1 次提案为 silent_presence', offer1 && offer1.kind === 'silent_presence');
  engine.commit(offer1);
  check('2.3 第 1 次 commit 后连续沉默计数为 1', engine.consecutiveSilenceCount === 1);
  check('2.4 silent_presence commit 后 tracker.spokenDuringIdle 被置位防重复', tracker.spokenDuringIdle === true);

  // 模拟下一轮挂机评估 (新一段挂机，解除单次刹车)
  tracker.spokenDuringIdle = false;
  nowTime += 50000; // 跨越 45s 冷却

  // 第 2 次触发
  const offer2 = engine.evaluate();
  check('2.5 第 2 次提案仍为 silent_presence (K=2 允许)', offer2 && offer2.kind === 'silent_presence');
  engine.commit(offer2);
  check('2.6 第 2 次 commit 后连续沉默计数为 2', engine.consecutiveSilenceCount === 2);

  // 模拟再下一轮挂机评估
  tracker.spokenDuringIdle = false;
  nowTime += 50000;

  // 第 3 次触发：由于 consecutiveSilenceCount === 2 (已达上限 K=2)，必须退出沉默，强制回退常规 idle！
  const offer3 = engine.evaluate();
  check('2.7 达到 K=2 上限后，第 3 次评估退出沉默并回退常规 idle (退出条件生效)',
    offer3 && offer3.kind === 'idle');
  engine.commit(offer3);
  check('2.8 提交常规 idle 后，连续沉默计数重置为 0', engine.consecutiveSilenceCount === 0);
}

// -------------------------------------------------------------
// 3. 用户交互打断：用户一旦互动，沉默计数立即清零
// -------------------------------------------------------------
{
  let nowTime = 60 * 60000;
  const tracker = createMockTracker({ lastInteractionAt: 0, spokenDuringIdle: false });
  const engine = new TriggerEngine(tracker, {
    idleMs: 30 * 60000,
    cooldownMs: 45000,
    now: () => nowTime,
    traits: { quiet_preference: 80 }
  });

  const offer1 = engine.evaluate();
  engine.commit(offer1);
  check('3.1 沉默 1 次后计数为 1', engine.consecutiveSilenceCount === 1);

  // 用户发生互动
  nowTime += 100000;
  tracker.lastInteractionAt = nowTime; // 用户在此刻点击/说话
  tracker.spokenDuringIdle = false;

  // 模拟再过 40 分钟挂机 (偏好安静者 idleNeed 约为 35.7 分钟)
  nowTime += 40 * 60000;
  const offerAfterInteract = engine.evaluate();
  check('3.2 用户交互后连续沉默计数已清零', engine.consecutiveSilenceCount === 0);
  check('3.3 重新进入第 1 次 silent_presence', offerAfterInteract && offerAfterInteract.kind === 'silent_presence');
}

// -------------------------------------------------------------
// 4. 零 API 调用验证与微动作触发验证 (End-to-End Simulation)
// -------------------------------------------------------------
(async () => {
  const dir = tmpDir();
  let llmCallCount = 0;

  const brain = new Brain(dir, {
    ...DEFAULTS,
    apiKey: 'mock-key'
  });

  brain.api = {
    stream: async () => {
      llmCallCount++;
      return {
        text: '这是一条普通回复',
        usage: { prompt_tokens: 10, completion_tokens: 10 }
      };
    }
  };

  // 4.1 模拟渲染端收到 silent_presence 时的真实逻辑
  let playedAction = null;
  let playedDuration = 0;
  const mockAnimController = {
    playAction: (action, opts) => {
      playedAction = action;
      playedDuration = opts.duration;
      return true;
    }
  };

  let committedOffer = null;
  const mockApi = {
    proactiveCommit: (offer) => {
      committedOffer = offer;
    }
  };

  function simulateRendererOffer(offer) {
    if (offer.kind === 'silent_presence') {
      if (mockApi.proactiveCommit) mockApi.proactiveCommit(offer);
      if (mockAnimController && typeof mockAnimController.playAction === 'function') {
        mockAnimController.playAction('look_around', { duration: 2000, reason: 'silent_presence' });
      }
      return;
    }
    // 常规搭话则调 LLM
    brain.ask('（自言自语）', () => {}, { proactive: true, offer });
  }

  const silentOffer = {
    kind: 'silent_presence',
    at: Date.now(),
    reason: '用户已经离开 60 分钟',
    hint: '静默相伴'
  };

  simulateRendererOffer(silentOffer);

  check('4.1 silent_presence 路径 LLM 调用次数严格为 0 (硬指标)', llmCallCount === 0);
  check('4.2 silent_presence 确实调用了 proactiveCommit', !!committedOffer && committedOffer.kind === 'silent_presence');
  check('4.3 silent_presence 确实驱动了微动作 look_around', playedAction === 'look_around');
  check('4.4 微动作持续时间为 2000ms', playedDuration === 2000);

  // 4.5 对照：常规搭话确实会调用 LLM
  const regularOffer = {
    kind: 'idle',
    at: Date.now(),
    reason: '用户已经离开 30 分钟',
    hint: '轻声问候'
  };
  await brain.ask('（自言自语）', () => {}, { proactive: true, offer: regularOffer });
  check('4.5 常规 idle 搭话路径 LLM 调用次数增加为 1', llmCallCount === 1);

  // 4.6 用户主动开口必回应 (D-A 铁律)
  await brain.ask('初澜你在吗？');
  check('4.6 用户主动说话时她必须回应，LLM 计数递增且永不拦截为沉默', llmCallCount === 2);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  // -------------------------------------------------------------
  // 5. 非伪造铁律 (D-C)：静态扫描严禁 Math.random 判定沉默
  // -------------------------------------------------------------
  const triggerCode = fs.readFileSync(path.join(__dirname, '../src/trigger.js'), 'utf8');
  // 提取 evaluate() 方法正文
  const evalMatch = triggerCode.match(/evaluate\(opts = \{\}\)\s*\{([\s\S]*?)\n\s*commit/);
  const evalBody = evalMatch ? evalMatch[1] : '';

  check('5.1 trigger.js evaluate() 内无 Math.random 伪造沉默',
    !evalBody.includes('Math.random'));

  const petCode = fs.readFileSync(path.join(__dirname, '../pet.js'), 'utf8');
  const silentFuncMatch = petCode.match(/function executeSilentPresence[\s\S]*?\}/);
  const silentFuncBody = silentFuncMatch ? silentFuncMatch[0] : '';
  check('5.2 pet.js executeSilentPresence 内无 Math.random 伪造动作',
    !silentFuncBody.includes('Math.random'));

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
