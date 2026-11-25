/**
 * test/v21a-allostasis-prior.test.js
 *
 * v2.1-a 预测性异稳态与关系节奏先验门禁：
 *   1. 纯数学边界：冷启动 (<3 样本零干预)、<30min 同段不入队、时钟回拨忽略、30天 Winsorize、先算后入队、20条环形上界；
 *   2. 高低频关系分化：同一 12h 离开对高频关系 (2h) 与低频关系 (72h) 产生符号相反的 gapSurprise；
 *   3. 内稳态耦合：正误差 (+4~+8 arousal 并间接降 salienceThreshold)、负误差先调 _decayMood 再加 moodWarmth (+2~+4)、onChange 推送与快照持久化；
 *   4. Brain 端到端与核心不变量：proactive=true 不污染先验、同轮 currentSelfContext() 零错位即时生效、systemText() 逐字节不变、reunion.js 零改动；
 *   5. 配置与消融隔离：sanitize() 默认 true / 显式 false / baseline 强制 false、消融态保留盘面历史且不激活运行态；
 *   6. D-001 静态零轮询扫描与双轨隔离。
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v21a-allostasis-'));
}

const {
  AllostasisPrior,
  MIN_RECONNECT_GAP_MS,
  MAX_RECONNECT_GAP_MS,
  MAX_RECENT_GAPS,
  evaluateGapSurprise
} = require(path.join(ROOT, 'src', 'allostasis-prior'));
const { InternalRegulationManager } = require(path.join(ROOT, 'src', 'internal-regulation'));
const { Brain } = require(path.join(ROOT, 'src', 'brain'));
const { DEFAULTS, sanitize } = require(path.join(ROOT, 'src', 'config'));
const { ALLOWED_TRAITS } = require(path.join(ROOT, 'src', 'subject-state'));
const reunion = require(path.join(ROOT, 'src', 'reunion'));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const H = 3600 * 1000;
  const MIN = 60 * 1000;
  const D = 24 * H;
  const T0 = 1795000000000;

  // ---- 1. 纯数学模型与冷启动 / 边界守卫 ----
  {
    const prior = new AllostasisPrior();
    const r0 = prior.recordUserTurn(T0);
    check('1.1 首次用户消息只建立起点 lastUserTurnAt，不触发重连',
      r0.coldStart === true && r0.reconnected === false && r0.gapSurprise === 0 && prior.lastUserTurnAt === T0);

    // 同段 < 30min 对话不入队
    const rIntra = prior.recordUserTurn(T0 + 20 * MIN);
    check('1.2 同段 <30min 对话不计入跨段样本，仅推进起点',
      rIntra.reconnected === false && prior.recentGapsMs.length === 0 && prior.lastUserTurnAt === T0 + 20 * MIN);

    // 时钟回拨忽略
    const rRollback = prior.recordUserTurn(T0 + 5 * MIN);
    check('1.3 时钟回拨 (awayMs <= 0) 直接忽略，不倒退起点也不写入样本',
      rRollback.clockRollback === true && prior.lastUserTurnAt === T0 + 20 * MIN && prior.recentGapsMs.length === 0);

    // 2 个跨段样本仍处于冷启动 (<3)
    const tAnchor = T0 + 20 * MIN;
    const r1 = prior.recordUserTurn(tAnchor + 2 * H);
    const r2 = prior.recordUserTurn(tAnchor + 4 * H);
    check('1.4 累计 2 条样本 (<3) 仍处于冷启动守卫，gapSurprise 恒为 0',
      r1.reconnected === true && r1.priorReady === false && r1.gapSurprise === 0 &&
      r2.reconnected === true && r2.priorReady === false && r2.gapSurprise === 0 &&
      prior.recentGapsMs.length === 2);

    // 第 3 条样本自身也处于 priorReady=false，但入队后使 priorReady 变为 true
    const r3 = prior.recordUserTurn(tAnchor + 6 * H);
    check('1.5 第 3 条入队前 priorReady=false、入队后 isReady()=true',
      r3.priorReady === false && r3.gapSurprise === 0 && prior.isReady() === true && prior.recentGapsMs.length === 3);

    // 第 4 次：先算后入队验证（面对 24h 离开，先用 [2h,2h,2h] 算出强正误差，再把 24h 入队）
    const r4 = prior.recordUserTurn(tAnchor + 6 * H + 24 * H);
    check('1.6 第 4 次跨段重连激活先验且先算后入队产生强正误差 (>=1.2)',
      r4.priorReady === true && r4.gapSurprise >= 1.2 && prior.recentGapsMs.length === 4,
      `gapSurprise=${r4.gapSurprise}`);
  }

  // ---- 2. Winsorize 30 天截断与 20 条有界队列 ----
  {
    const prior = new AllostasisPrior();
    prior.recordUserTurn(T0);
    let cursor = T0;
    for (let i = 0; i < 24; i++) {
      cursor += 2 * H;
      prior.recordUserTurn(cursor);
    }
    check('2.1 环形缓冲严格有界 <= 20 条', prior.recentGapsMs.length === MAX_RECENT_GAPS);

    prior.recordUserTurn(cursor + 60 * D);
    const lastGap = prior.recentGapsMs[prior.recentGapsMs.length - 1];
    check('2.2 超 30 天极端间隔按 30 天 Winsorize 截断入队',
      lastGap === MAX_RECONNECT_GAP_MS,
      `lastGap=${lastGap}`);
  }

  // ---- 3. 高低频关系面对同一 12 小时离开的分化 ----
  {
    const highFreq = evaluateGapSurprise([2 * H, 2 * H, 2 * H, 2 * H], 12 * H);
    const lowFreq = evaluateGapSurprise([72 * H, 72 * H, 72 * H, 72 * H], 12 * H);
    check('3.1 高频关系 (2h) 面对 12h 离开产生显著正预测误差 (>=1.2)',
      highFreq.priorReady === true && highFreq.gapSurprise >= 1.2,
      `highFreq=${highFreq.gapSurprise}`);
    check('3.2 低频关系 (72h) 面对同一 12h 离开产生显著负预测误差 (<=-1.0)',
      lowFreq.priorReady === true && lowFreq.gapSurprise <= -1.0,
      `lowFreq=${lowFreq.gapSurprise}`);
  }

  // ---- 4. InternalRegulationManager 耦合、心境先衰减与持久化 ----
  {
    const dir = makeTempDir();
    const mgr = new InternalRegulationManager(dir);
    let pushes = 0;
    mgr.onChange = () => { pushes++; };

    const baseArousal = mgr.arousal;
    const baseThresh = mgr.salienceThreshold;
    mgr.updateOnReunionSurprise(2.5, T0);
    check('4.1 正预测误差抬升 arousal (+4~+8) 并通过 _computeSalienceThreshold 间接降门限',
      mgr.arousal >= baseArousal + 4 && mgr.arousal <= baseArousal + 8 &&
      mgr.salienceThreshold === mgr._computeSalienceThreshold(mgr.arousal) &&
      mgr.salienceThreshold < baseThresh && pushes === 1,
      `arousal:${baseArousal}->${mgr.arousal}, thresh:${baseThresh}->${mgr.salienceThreshold}`);

    // 验证负误差调节 moodWarmth 前必须先调 _decayMood(at)
    const tDecayBase = T0 + 48 * H;
    mgr.moodWarmth = 90;
    mgr.moodUpdatedAt = T0; // 距 tDecayBase 恰好 1 个半衰期 (48h)，90 应先衰到 70 再 +2~+4 = 72~74
    mgr.updateOnReunionSurprise(-1.8, tDecayBase);
    check('4.2 负预测误差调节 moodWarmth 前先执行 48h 半衰期衰减再温和抬升 (+2~+4)',
      mgr.moodWarmth >= 72 && mgr.moodWarmth <= 74,
      `moodWarmth=${mgr.moodWarmth}`);

    // 持久化与快照
    mgr.allostasisPrior.lastUserTurnAt = tDecayBase;
    mgr.allostasisPrior.recentGapsMs = [2 * H, 2 * H, 2 * H];
    mgr.save();
    const reloaded = new InternalRegulationManager(dir);
    const summary = reloaded.getAllostasisSummary();
    check('4.3 allostasis 状态随 internal-regulation.json 跨重启完整恢复',
      summary.priorReady === true && summary.sampleCount === 3 &&
      reloaded.allostasisPrior.lastUserTurnAt === tDecayBase &&
      summary.typicalGapMs === 2 * H);

    const snapRec = reloaded.createSnapshotRecord(7);
    check('4.4 关窗归档快照携带只读 allostasis 摘要',
      snapRec.payload.allostasis && snapRec.payload.allostasis.priorReady === true &&
      snapRec.payload.allostasis.sampleCount === 3);

    check('4.5 认识论边界：isSubjectAccessible=false 且不入 SubjectState.ALLOWED_TRAITS',
      reloaded.isSubjectAccessible('gapSurprise') === false &&
      !ALLOWED_TRAITS.has('gapSurprise') && !ALLOWED_TRAITS.has('typicalGapMs'));

    // 4.6 关窗结算自然清零 lastSurprise，避免跨窗无限滞留，同时完整保留历史样本与锚点
    const wcDir = makeTempDir();
    const wcMgr = new InternalRegulationManager(wcDir, { enabled: true });
    wcMgr.allostasisPrior.lastUserTurnAt = T0;
    wcMgr.allostasisPrior.recentGapsMs = [2 * H, 2 * H, 2 * H];
    const wcVerdict = wcMgr.recordUserTurnAndAllostasis(T0 + 24 * H);
    const hadSurprise = wcVerdict.gapSurprise >= 1.2 && wcMgr.allostasisPrior.lastSurprise >= 1.2;
    wcMgr.updateOnWindowClose(8, {});
    const wcReloaded = new InternalRegulationManager(wcDir, { enabled: true });
    check('4.6 关窗结算将 allostasisPrior.lastSurprise 归零并保留 recentGapsMs 与 lastUserTurnAt',
      hadSurprise &&
      wcMgr.allostasisPrior.lastSurprise === 0 &&
      wcMgr.allostasisPrior.recentGapsMs.length === 4 &&
      wcMgr.allostasisPrior.lastUserTurnAt === T0 + 24 * H &&
      wcReloaded.getAllostasisSummary().lastSurprise === 0 &&
      wcReloaded.allostasisPrior.recentGapsMs.length === 4);
  }

  // ---- 5. Config 白名单、baseline 与单模块消融隔离 ----
  {
    const defCfg = sanitize({});
    check('5.1 sanitize({}).experimentModules.allostasisPrior === true',
      defCfg.experimentModules.allostasisPrior === true);
    check('5.2 显式 allostasisPrior=false 被 sanitize 严格保留',
      sanitize({ experimentModules: { allostasisPrior: false } }).experimentModules.allostasisPrior === false);
    check('5.3 baseline 模式下强制关闭 allostasisPrior',
      sanitize({ experimentMode: 'baseline', experimentModules: { allostasisPrior: true } }).experimentModules.allostasisPrior === false);

    // 消融隔离：磁盘已有 allostasis，关掉 allostasisPrior 后不加载、不更新、且不覆盖磁盘残留
    const ablDir = makeTempDir();
    const seed = new InternalRegulationManager(ablDir, { enabled: true });
    seed.allostasisPrior.lastUserTurnAt = T0;
    seed.allostasisPrior.recentGapsMs = [2 * H, 2 * H, 2 * H];
    seed.save();

    const ablated = new InternalRegulationManager(ablDir, {
      enabled: true,
      experimentModules: { internalRegulation: true, allostasisPrior: false }
    });
    const rAbl = ablated.recordUserTurnAndAllostasis(T0 + 24 * H);
    ablated.updateOnReunionSurprise(2.5, T0 + 24 * H);
    check('5.4 allostasisPrior=false 消融时完全旁路且不污染内态',
      rAbl.disabled === true && ablated.getAllostasisSummary().priorReady === false && ablated.arousal === 50);

    const diskAfterAbl = JSON.parse(fs.readFileSync(ablated.path, 'utf8'));
    check('5.5 消融态 save() 保留磁盘原有 allostasis 历史不被抹除',
      diskAfterAbl.allostasis && Array.isArray(diskAfterAbl.allostasis.recentGapsMs) &&
      diskAfterAbl.allostasis.recentGapsMs.length === 3);

    const baseOnly = new InternalRegulationManager(ablDir, { enabled: false });
    check('5.6 baseline (enabled=false) 不加载磁盘 allostasis 残留',
      baseOnly.getAllostasisSummary().priorReady === false && baseOnly.allostasisPrior.lastUserTurnAt === 0);

    const ablBrainDir = makeTempDir();
    const ablBrain = new Brain(ablBrainDir, {
      ...DEFAULTS,
      apiKey: 'sk-mock-v21a-abl',
      experimentMode: 'ablation',
      experimentModules: {
        ...DEFAULTS.experimentModules,
        internalRegulation: true,
        allostasisPrior: false,
        sleepConsolidation: false
      }
    });
    check('5.7 Brain 经 runManifest 与窗口快照透传 allostasisPrior=false 消融开关',
      ablBrain.currentWindowSnapshot.modules.allostasisPrior === false &&
      ablBrain.internalRegulation.allostasisEnabled === false);

    // 5.8 运行中或跨窗从 allostasisPrior=false 切回 true 时回灌 _preservedAllostasis，save() 不清空历史样本
    const toggleDir = makeTempDir();
    const seedToggle = new InternalRegulationManager(toggleDir, {
      enabled: true,
      experimentModules: { internalRegulation: true, allostasisPrior: true }
    });
    seedToggle.allostasisPrior.lastUserTurnAt = T0 + 6 * H;
    seedToggle.allostasisPrior.recentGapsMs = [2 * H, 2 * H, 2 * H];
    seedToggle.save();

    const toggledMgr = new InternalRegulationManager(toggleDir, {
      enabled: true,
      experimentModules: { internalRegulation: true, allostasisPrior: false }
    });
    const turnedOn = toggledMgr.setAllostasisEnabled(true);
    toggledMgr.save();
    const afterToggleReload = new InternalRegulationManager(toggleDir, {
      enabled: true,
      experimentModules: { internalRegulation: true, allostasisPrior: true }
    });
    check('5.8 运行中切回 allostasisPrior=true 完整回灌 _preservedAllostasis 且 save() 不清空 3 条历史样本',
      turnedOn === true &&
      toggledMgr.allostasisPrior.recentGapsMs.length === 3 &&
      toggledMgr.allostasisPrior.lastUserTurnAt === T0 + 6 * H &&
      afterToggleReload.getAllostasisSummary().priorReady === true &&
      afterToggleReload.allostasisPrior.recentGapsMs.length === 3 &&
      afterToggleReload.allostasisPrior.lastUserTurnAt === T0 + 6 * H);
  }

  // ---- 6. Brain 端到端：proactive 防污染 + 同轮零错位 + systemText 不变 + reunion 零改动 ----
  {
    const bDir = makeTempDir();
    const brain = new Brain(bDir, {
      ...DEFAULTS,
      apiKey: 'sk-mock-v21a',
      experimentMode: 'experimental',
      experimentModules: {
        ...DEFAULTS.experimentModules,
        internalRegulation: true,
        allostasisPrior: true,
        memoryDynamics: true,
        sleepConsolidation: false
      }
    });

    let capturedRequests = [];
    brain.api.stream = async (messages, onDelta) => {
      capturedRequests.push(JSON.parse(JSON.stringify(messages)));
      onDelta('嗯，我听见了。');
      return { text: '嗯，我听见了。', observedModel: 'deepseek-flash', usage: { prompt_tokens: 40, completion_tokens: 8 } };
    };

    const sysBefore = brain.memory.systemText();

    // 预置 3 个 2h 样本，并把 lastUserTurnAt 设在 24 小时前，arousal=74
    const nowWall = Date.now();
    brain.internalRegulation.allostasisPrior.lastUserTurnAt = nowWall - 24 * H;
    brain.internalRegulation.allostasisPrior.recentGapsMs = [2 * H, 2 * H, 2 * H];
    brain.internalRegulation.arousal = 74;
    brain.internalRegulation.save();

    // 6.1 proactive: true 绝不能触发 recordUserTurnAndAllostasis，也不能刷新 lastUserTurnAt
    await brain.ask('用户已经离开 40 分钟', () => {}, { proactive: true });
    check('6.1 proactive=true 主动搭话不污染 lastUserTurnAt 与 recentGapsMs',
      brain.internalRegulation.allostasisPrior.recentGapsMs.length === 3 &&
      brain.internalRegulation.allostasisPrior.lastUserTurnAt === nowWall - 24 * H &&
      brain.internalRegulation.arousal === 74);

    // 6.2 真实用户开口 (!proactive)：同轮 currentSelfContext() 即刻反映 arousal 抬升 (>=80 -> 神经亢奋体感)
    capturedRequests = [];
    await brain.ask('我回来了，刚才忙了一天', () => {});
    const reqMsgs = capturedRequests[0] || [];
    const lastUserMsg = reqMsgs[reqMsgs.length - 1];
    const lastUserText = lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
    check('6.2 同轮无错位：正预测误差 (+4~+8) 在当轮 currentSelfContext() 即可感知',
      brain.internalRegulation.arousal >= 80 &&
      lastUserText.includes('神经有些亢奋紧绷'),
      `arousal=${brain.internalRegulation.arousal}`);

    // 6.2b 真实长静默回归防线：当 updatedAt 也在 24h 前（intervalMs=24h）时，
    // updateOnInteractionTurn 会先把旧 arousal 回归到 50 再 +2，
    // recordUserTurnAndAllostasis 必须在它之后运行，否则 +4~+8 增益会被回归 50 抹除！
    const realDir = makeTempDir();
    const realBrain = new Brain(realDir, {
      ...DEFAULTS,
      apiKey: 'sk-mock-v21a-real',
      experimentMode: 'experimental',
      experimentModules: {
        ...DEFAULTS.experimentModules,
        internalRegulation: true,
        allostasisPrior: true,
        sleepConsolidation: false
      }
    });
    realBrain.api.stream = async (_messages, onDelta) => {
      onDelta('嗯。');
      return { text: '嗯。', observedModel: 'deepseek-flash', usage: { prompt_tokens: 30, completion_tokens: 5 } };
    };
    const tReal = Date.now();
    realBrain.internalRegulation.allostasisPrior.lastUserTurnAt = tReal - 24 * H;
    realBrain.internalRegulation.allostasisPrior.recentGapsMs = [2 * H, 2 * H, 2 * H];
    realBrain.internalRegulation.updatedAt = tReal - 24 * H;
    realBrain.internalRegulation.arousal = 70;
    await realBrain.ask('我回来了', () => {});
    check('6.2b 真实 24h 间隔下 updateOnInteractionTurn 回归 50 不抹除先验正误差增益 (50 + 2 + 4..8 >= 56)',
      realBrain.internalRegulation.arousal >= 56 && realBrain.internalRegulation.arousal <= 60,
      `arousal=${realBrain.internalRegulation.arousal}`);

    // 反向对照（变异判别力）：若样本 <3 处于冷启动，同条件 arousal=74 仅加轮次 +2 -> 76 < 80，不触发亢奋体感
    const ctrlDir = makeTempDir();
    const ctrlBrain = new Brain(ctrlDir, {
      ...DEFAULTS,
      apiKey: 'sk-mock-v21a-ctrl',
      experimentMode: 'experimental',
      experimentModules: {
        ...DEFAULTS.experimentModules,
        internalRegulation: true,
        allostasisPrior: true,
        sleepConsolidation: false
      }
    });
    let ctrlReqs = [];
    ctrlBrain.api.stream = async (messages, onDelta) => {
      ctrlReqs.push(JSON.parse(JSON.stringify(messages)));
      onDelta('嗯。');
      return { text: '嗯。', observedModel: 'deepseek-flash', usage: { prompt_tokens: 30, completion_tokens: 5 } };
    };
    ctrlBrain.internalRegulation.allostasisPrior.lastUserTurnAt = Date.now() - 24 * H;
    ctrlBrain.internalRegulation.allostasisPrior.recentGapsMs = [2 * H, 2 * H]; // 只有 2 条，冷启动
    ctrlBrain.internalRegulation.arousal = 74;
    await ctrlBrain.ask('我回来了，刚才忙了一天', () => {});
    const ctrlLastText = ctrlReqs[0][ctrlReqs[0].length - 1].content;
    check('6.3 反向对照：冷启动 (<3) 时同条件 arousal=74 不触发先验跃迁 (76 < 80)',
      ctrlBrain.internalRegulation.arousal === 76 && !ctrlLastText.includes('神经有些亢奋紧绷'));

    // 6.4 systemText() 前缀缓存逐字节不变
    const sysAfter = brain.memory.systemText();
    check('6.4 systemText() 前缀缓存逐字节零污染', sysBefore === sysAfter);

    // 6.5 src/reunion.js 契约零改动
    check('6.5 src/reunion.js 6h 阈值与客观时长文案完全不变',
      reunion.REUNION_MIN_MS === 6 * H && reunion.formatReunionLine(12 * H) === '【你离开了 12 小时】');
  }

  // ---- 7. D-001 静态零轮询扫描 ----
  {
    const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const alloSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'allostasis-prior.js'), 'utf8'));
    const irSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'internal-regulation.js'), 'utf8'));
    const hasTimer = /\b(setInterval|setTimeout)\b/.test(alloSrc) || /\b(setInterval|setTimeout)\b/.test(irSrc);
    check('7.1 D-001 静态门禁：allostasis-prior.js 与 internal-regulation.js 零 setInterval/setTimeout',
      !hasTimer);
  }

  console.log('');
  console.log('失败 ' + failures + ' 项');
  process.exit(failures ? 1 : 0);
})();
