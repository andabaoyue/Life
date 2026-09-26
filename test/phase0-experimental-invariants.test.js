/**
 * test/phase0-experimental-invariants.test.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * Phase 0 核心架构、Schema 契约与 10 大实验不变量验证套件
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  SCHEMA_VERSION,
  EXPERIMENT_CONFIG_VERSION,
  RESEARCH_FORMAT_VERSION,
  EXPERIMENT_MODES,
  PROVENANCE_SOURCE_KINDS,
  SEMANTIC_LAYERS,
  CANDIDATE_STATUS,
  BEHAVIOR_ORIGIN,
  MEMORY_EPISTEMIC_STATUS,
  DEFAULT_EXPERIMENT_MODULES
} = require('../src/experiment-types');

const {
  createExperimentRunManifest,
  createWindowExperimentSnapshot,
  validateExperimentSnapshot,
  isBaselineMode
} = require('../src/experiment-run');

const {
  INTERNAL_STATE_PROXY_DEFS,
  ALLOWED_PROXIES,
  createDefaultInternalState,
  validateInternalState,
  isSubjectAccessible,
  applySubjectEvent
} = require('../src/internal-state');

const {
  BLOCKED_RAW_KEYS,
  containsLeakedRawData,
  filterRawTelemetry,
  evaluateSalience,
  processUmweltPerception
} = require('../src/digital-umwelt');

const {
  createBiographicalCandidate,
  reinforceCandidate,
  citeCandidateBySubject,
  crystallizeCandidate
} = require('../src/biographical-candidate');

const {
  createSleepReplayArtifact,
  createSystemConsolidatedRepresentation,
  createSubjectAcquiredMemory,
  validateEpistemicSeparation
} = require('../src/sleep-consolidation-types');

const {
  validateHypothesisSchema,
  evaluateExperimentSignificance
} = require('../src/null-hypothesis');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('=== Phase 0 数字生命实验层架构契约与 10 大不变量检验 ===\n');

// ---------------------------------------------------------------------
// 不变量 1：基线零干预不变量 (Baseline Non-Interference Invariant)
// ---------------------------------------------------------------------
{
  const baselineManifest = createExperimentRunManifest({
    experimentMode: EXPERIMENT_MODES.BASELINE,
    modules: { homeostasis: true, digitalUmwelt: true } // 恶意企图在基线开启模块
  });

  check('Invariant 1.1: 基线模式强制将所有实验模块置为 false',
    baselineManifest.modules.homeostasis === false &&
    baselineManifest.modules.digitalUmwelt === false &&
    baselineManifest.modules.sleepConsolidation === false &&
    baselineManifest.modules.biographicalCanalization === false
  );

  const baselineSnapshot = createWindowExperimentSnapshot(1, baselineManifest);
  check('Invariant 1.2: 窗口实验快照继承基线状态且通过完整性检验',
    validateExperimentSnapshot(baselineSnapshot) && isBaselineMode(baselineSnapshot)
  );

  const prevState = createDefaultInternalState();
  const dummyEvent = { type: 'message', eventId: 'ev-test-1', timestamp: new Date().toISOString() };
  const { nextState, transitionEvent } = applySubjectEvent(prevState, dummyEvent, { snapshot: baselineSnapshot });

  check('Invariant 1.3: 基线模式下单向 Reducer 严格产生零变动并返回原引用',
    nextState === prevState && transitionEvent === null
  );

  const rawSensor = { category: 'mouse_move', rawIntensity: 90, timestamp: new Date().toISOString() };
  const perception = processUmweltPerception(rawSensor, prevState, { snapshot: baselineSnapshot });
  check('Invariant 1.4: 基线模式下数字环周强制输出 null，不产生任何感官干预',
    perception === null
  );
}

// ---------------------------------------------------------------------
// 不变量 2：语义分层隔离不变量 (Semantic Layer Separation Invariant)
// ---------------------------------------------------------------------
{
  const allProxiesMatchLayer = ALLOWED_PROXIES.every(
    key => INTERNAL_STATE_PROXY_DEFS[key].semanticLayer === SEMANTIC_LAYERS.SUBJECT_STATE_PROXY
  );
  check('Invariant 2.1: 内部状态代理定义均属于 SUBJECT_STATE_PROXY 语义分层', allProxiesMatchLayer);

  const rawSysMetrics = {
    semanticLayer: SEMANTIC_LAYERS.SYSTEM_METRICS,
    cpuUsage: 95.5,
    memoryRss: 1048576,
    timestamp: new Date().toISOString()
  };
  const filteredSys = filterRawTelemetry(rawSysMetrics);
  check('Invariant 2.2: 纯 SYSTEM_METRICS 未经抽象直接进入感知漏斗被拦截为 null', filteredSys === null);
}

// ---------------------------------------------------------------------
// 不变量 3：代理变量 vs 感受质界限不变量 (Proxy vs Qualia Boundary Invariant)
// ---------------------------------------------------------------------
{
  const allNotAccessible = ALLOWED_PROXIES.every(key => isSubjectAccessible(key) === false);
  check('Invariant 3.1: 所有内部代理标量均为 subjectAccessible = false', allNotAccessible);

  const defaultState = createDefaultInternalState();
  check('Invariant 3.2: 初始内部状态默认值严格在定义区间内且对象深冻结',
    validateInternalState(defaultState) && Object.isFrozen(defaultState) && Object.isFrozen(defaultState.values)
  );
}

// ---------------------------------------------------------------------
// 不变量 4：单向确定性 Reducer 纯函数不变量 (Single-Directional Reducer Invariant)
// ---------------------------------------------------------------------
{
  const expManifest = createExperimentRunManifest({
    experimentMode: EXPERIMENT_MODES.EXPERIMENTAL,
    modules: { homeostasis: true }
  });
  const expSnapshot = createWindowExperimentSnapshot(1, expManifest);

  const initState = createDefaultInternalState();
  const testMsgEvent = { type: 'message', eventId: 'msg-001', timestamp: new Date().toISOString() };

  const res1 = applySubjectEvent(initState, testMsgEvent, { snapshot: expSnapshot });
  const res2 = applySubjectEvent(initState, testMsgEvent, { snapshot: expSnapshot });

  check('Invariant 4.1: Reducer 为纯函数，不修改 previousState 入参引用',
    initState.values.energy === 100 && Object.isFrozen(initState.values)
  );

  check('Invariant 4.2: 相同输入与快照下 Reducer 计算结果绝对确定一致',
    res1.nextState.values.energy === res2.nextState.values.energy &&
    res1.nextState.values.cognitiveLoadProxy === res2.nextState.values.cognitiveLoadProxy
  );

  check('Invariant 4.3: Reducer 生成的跃迁事件记录完整的因果追溯 Provenance',
    res1.transitionEvent !== null &&
    res1.transitionEvent.triggerEventId === 'msg-001' &&
    res1.transitionEvent.provenance.sourceKind === PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM
  );
}

// ---------------------------------------------------------------------
// 不变量 5：数字环周空感知成立不变量 (Null-Perception Invariant)
// ---------------------------------------------------------------------
{
  const expManifest = createExperimentRunManifest({
    experimentMode: EXPERIMENT_MODES.EXPERIMENTAL,
    modules: { digitalUmwelt: true }
  });
  const expSnapshot = createWindowExperimentSnapshot(1, expManifest);
  const state = createDefaultInternalState({ salienceThreshold: 40 });

  // 强度 15 低于 threshold 40
  const weakSensor = { category: 'subtle_audio', rawIntensity: 15, timestamp: new Date().toISOString() };
  const resultLow = processUmweltPerception(weakSensor, state, { snapshot: expSnapshot });

  check('Invariant 5.1: 刺激强度低于显著性门限时严格返回 null（空感知成立）', resultLow === null);

  // 强度 80 高于 threshold 40
  const strongSensor = { category: 'window_focus', rawIntensity: 80, timestamp: new Date().toISOString() };
  const resultHigh = processUmweltPerception(strongSensor, state, { snapshot: expSnapshot });

  check('Invariant 5.2: 刺激强度超过门限时生成主体可感知的质性感知单元',
    resultHigh !== null &&
    resultHigh.subjectAccessible === true &&
    resultHigh.qualitativeDescriptor === 'intense_activity'
  );
}

// ---------------------------------------------------------------------
// 不变量 6：原始感官隔离不变量 (Raw Sensory Isolation Invariant)
// ---------------------------------------------------------------------
{
  const expManifest = createExperimentRunManifest({
    experimentMode: EXPERIMENT_MODES.EXPERIMENTAL,
    modules: { digitalUmwelt: true }
  });
  const expSnapshot = createWindowExperimentSnapshot(1, expManifest);
  const state = createDefaultInternalState({ salienceThreshold: 20 });

  // 包含原始硬件与宿主系统坐标/PID/路径的脏数据
  const dirtySensor = {
    category: 'user_action',
    rawIntensity: 75,
    x: 1024,
    y: 768,
    pid: 8848,
    rawPath: 'C:\\Users\\Administrator\\secret\\file.txt',
    timestamp: new Date().toISOString()
  };

  const perception = processUmweltPerception(dirtySensor, state, { snapshot: expSnapshot });
  check('Invariant 6.1: 原始坐标与系统路径在成型感知中被彻底过滤隔离',
    perception !== null &&
    perception.x === undefined &&
    perception.pid === undefined &&
    perception.rawPath === undefined &&
    !containsLeakedRawData(perception)
  );

  const leakProbe = { coords: { x: 50, y: 100 } };
  check('Invariant 6.2: 隔离检测探针准确捕获嵌套系统敏感字段', containsLeakedRawData(leakProbe) === true);
}

// ---------------------------------------------------------------------
// 不变量 7：自传印痕防单事件结晶不变量 (Anti-Circular: Multi-Source Evidence)
// ---------------------------------------------------------------------
{
  const initEv = { eventId: 'ev-init-01', windowNo: 1, summary: '初次谈及星空' };
  const candidate = createBiographicalCandidate(initEv, { theme: 'astronomy_interest' });

  check('Invariant 7.1: 新建自传候选初始状态为 PROPOSED 且包含初始事实源',
    candidate.status === CANDIDATE_STATUS.PROPOSED &&
    candidate.evidenceEvents.length === 1 &&
    candidate.evidenceEvents[0].eventId === 'ev-init-01'
  );

  let singleEventCrystallizeFailed = false;
  try {
    crystallizeCandidate(candidate);
  } catch (err) {
    singleEventCrystallizeFailed = true;
  }
  check('Invariant 7.2: 单次事件候选绝对无法直接跨阶段结晶 (Fail-Fast)', singleEventCrystallizeFailed);

  let duplicateReinforceFailed = false;
  try {
    reinforceCandidate(candidate, initEv, 1);
  } catch (err) {
    duplicateReinforceFailed = true;
  }
  check('Invariant 7.3: 使用同一初始事件强化被判定为循环引用并拒绝', duplicateReinforceFailed);
}

// ---------------------------------------------------------------------
// 不变量 8：防提示词诱导循环证明不变量 (Anti-Circular: Origin Validation)
// ---------------------------------------------------------------------
{
  const initEv = { eventId: 'ev-init-02', windowNo: 1, summary: '讨论雨天散步' };
  const c0 = createBiographicalCandidate(initEv, { theme: 'rain_preference' });
  const secondEv = { eventId: 'ev-sec-02', windowNo: 2, summary: '第二次在雨天对话' };
  const cReinforced = reinforceCandidate(c0, secondEv, 2);

  check('Invariant 8.1: 独立后续事件成功推进候选至 REINFORCED 状态',
    cReinforced.status === CANDIDATE_STATUS.REINFORCED && cReinforced.evidenceEvents.length === 2
  );

  // 系统诱发行为（例如 Prompt 注入后模型复读）
  const systemInducedCitation = {
    eventId: 'ev-cite-prompt-01',
    behaviorOrigin: BEHAVIOR_ORIGIN.SYSTEM_INDUCED,
    quote: '系统提示我喜欢雨天'
  };

  let systemInducedRejected = false;
  try {
    citeCandidateBySubject(cReinforced, systemInducedCitation);
  } catch (err) {
    systemInducedRejected = true;
  }
  check('Invariant 8.2: 系统诱导行为 (SYSTEM_INDUCED) 严禁作为主体自主引用证词', systemInducedRejected);

  // 主体自发交互生成引用
  const subjectGeneratedCitation = {
    eventId: 'ev-cite-user-01',
    behaviorOrigin: BEHAVIOR_ORIGIN.SUBJECT_GENERATED,
    quote: '上次下雨的时候，我们就聊到过那种潮湿的气味呢'
  };
  const cCited = citeCandidateBySubject(cReinforced, subjectGeneratedCitation);

  check('Invariant 8.3: 主体自主生成引用 (SUBJECT_GENERATED) 成功转入 CITED_BY_SUBJECT',
    cCited.status === CANDIDATE_STATUS.CITED_BY_SUBJECT && cCited.citationEvents.length === 1
  );

  const crystallized = crystallizeCandidate(cCited);
  check('Invariant 8.4: 经历完整双源强化与主体自主引用后合法结晶为不可逆 DefiningMoment',
    crystallized.status === CANDIDATE_STATUS.CRYSTALLIZED && typeof crystallized.crystallizedAt === 'string'
  );
}

// ---------------------------------------------------------------------
// 不变量 9：睡眠认识论三态分立不变量 (Epistemic Separation Invariant)
// ---------------------------------------------------------------------
{
  const replayArtifact = createSleepReplayArtifact({
    sourceEventIds: ['ev-1', 'ev-2'],
    compressionRatio: 0.45
  });

  const sysRepresentation = createSystemConsolidatedRepresentation({
    clusterTopic: 'conversation_cadence',
    abstractSummary: '对话频次聚类中间表征'
  });

  const subjectMemory = createSubjectAcquiredMemory({
    topic: '雨天记忆',
    subjectCitationQuote: '我记得那天窗外的雨声。'
  });

  check('Invariant 9.1: 离线重放制品与系统整合表征严格保持 subjectAccessible = false',
    replayArtifact.subjectAccessible === false &&
    sysRepresentation.subjectAccessible === false
  );

  check('Invariant 9.2: 仅主体习得自传记忆具备 subjectAccessible = true',
    subjectMemory.subjectAccessible === true &&
    subjectMemory.epistemicStatus === MEMORY_EPISTEMIC_STATUS.SUBJECT_ACQUIRED
  );

  const fakeAccessibleArtifact = { ...replayArtifact, subjectAccessible: true };
  check('Invariant 9.3: 认识论分立审计器准确拦截伪装成主体记忆的离线重放制品',
    validateEpistemicSeparation(replayArtifact) === true &&
    validateEpistemicSeparation(fakeAccessibleArtifact) === false
  );
}

// ---------------------------------------------------------------------
// 不变量 10：科学假说规范与零假说成立检验 (Falsifiability & Null Hypothesis)
// ---------------------------------------------------------------------
{
  const h001Path = path.join(__dirname, '..', 'research', 'hypotheses', 'H001-homeostatic-rhythm.json');
  const h001Raw = JSON.parse(fs.readFileSync(h001Path, 'utf8'));

  check('Invariant 10.1: H001 稳态生命节律假说通过 Schema 与可证伪性规范校验',
    validateHypothesisSchema(h001Raw)
  );

  // 模拟实验组与基线组无显著差异（零假说成立）
  const baselineData = { eventCount: 42 };
  const expNoDivergenceData = { eventCount: 43 };
  const h0Eval = evaluateExperimentSignificance(baselineData, expNoDivergenceData, h001Raw);

  check('Invariant 10.2: 实验组无统计显著分歧时客观接受零假说 (Null Hypothesis Accepted)',
    h0Eval.nullHypothesisAccepted === true && h0Eval.isSignificant === false
  );

  // 模拟非法假说定义（缺失零假说 H0 描述）
  const invalidHyp = { ...h001Raw, nullHypothesis: '' };
  check('Invariant 10.3: 缺少明确零假说的未严谨假说定义被门禁拦截',
    validateHypothesisSchema(invalidHyp) === false
  );
}

console.log(`\nPhase 0 测试运行完成，失败项数: ${failures}`);
if (failures > 0) {
  process.exit(1);
}
