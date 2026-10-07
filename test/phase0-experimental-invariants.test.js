/**
 * test/phase0-experimental-invariants.test.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * Phase 0 核心架构、Schema 契约与 10 大实验不变量验证套件 (P0-1 ~ P0-4 最终收敛版)
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
  PERCEPTION_STATUS,
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
  reduceSubjectEvent,
  commitSubjectTransition,
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
  acquireSubjectMemory,
  validateEpistemicSeparation
} = require('../src/sleep-consolidation-types');

const {
  validateHypothesisSchema,
  evaluateObservedDifference
} = require('../src/null-hypothesis');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('=== Phase 0 数字生命实验层架构契约与 10 大不变量检验 (收敛版) ===\n');

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
  const dummyEvent = { type: 'message', eventId: 'ev-test-1', timestamp: '2026-09-26T12:00:00.000Z' };
  const { nextState, transitionEvent } = applySubjectEvent(prevState, dummyEvent, { snapshot: baselineSnapshot });

  check('Invariant 1.3: 基线模式下单向 Reducer 严格产生零变动并返回原引用',
    nextState === prevState && transitionEvent === null
  );

  const rawSensor = { category: 'mouse_move', rawIntensity: 90, timestamp: '2026-09-26T12:00:00.000Z' };
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
    timestamp: '2026-09-26T12:00:00.000Z'
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
// 不变量 4：单向确定性 Reducer 纯函数不变量 (P0-1 严格纯函数与提交分离)
// ---------------------------------------------------------------------
{
  const expManifest = createExperimentRunManifest({
    experimentMode: EXPERIMENT_MODES.EXPERIMENTAL,
    modules: { homeostasis: true }
  });
  const expSnapshot = createWindowExperimentSnapshot(1, expManifest);

  const initState = createDefaultInternalState();
  const testMsgEvent = { type: 'message', eventId: 'msg-001', timestamp: '2026-09-26T12:00:00.000Z' };

  const res1 = applySubjectEvent(initState, testMsgEvent, { snapshot: expSnapshot });
  const res2 = applySubjectEvent(initState, testMsgEvent, { snapshot: expSnapshot });

  check('Invariant 4.1: Reducer 为纯函数，不修改 previousState 入参引用',
    initState.values.energy === 100 && Object.isFrozen(initState.values)
  );

  check('Invariant 4.2: 相同输入与快照下 Reducer 计算结果绝对确定一致',
    res1.nextState.values.energy === res2.nextState.values.energy &&
    res1.nextState.values.cognitiveLoadProxy === res2.nextState.values.cognitiveLoadProxy
  );

  check('Invariant 4.3: Commit 层生成的跃迁事件记录完整的因果追溯 Provenance',
    res1.transitionEvent !== null &&
    res1.transitionEvent.triggerEventId === 'msg-001' &&
    res1.transitionEvent.provenance.sourceKind === PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM
  );

  // Invariant 4.4: 相同输入重复执行 100 次：nextState 深度完全一致
  let all100Equal = true;
  const firstReduction = reduceSubjectEvent(initState, testMsgEvent, { snapshot: expSnapshot });
  for (let i = 0; i < 99; i++) {
    const r = reduceSubjectEvent(initState, testMsgEvent, { snapshot: expSnapshot });
    if (JSON.stringify(r.nextState) !== JSON.stringify(firstReduction.nextState)) {
      all100Equal = false;
      break;
    }
  }
  check('Invariant 4.4: reduceSubjectEvent 相同输入重复执行 100 次结果深度完全一致', all100Equal);

  // Invariant 4.5: 纯状态计算结果不包含时间随机字段
  check('Invariant 4.5: 纯状态计算结果不包含时间随机字段 (无 transitionEventId/createdAt)',
    firstReduction.nextState.updatedAt === undefined &&
    firstReduction.createdAt === undefined &&
    firstReduction.transitionEventId === undefined
  );

  // Invariant 4.6: 注入固定 clock / deterministic context 时 Replay 与 Live Reduction 状态完全一致
  const mockClock = { now: () => '2026-09-26T12:30:00.000Z' };
  const mockIdGen = () => 'trans-fixed-001';
  const liveCommit = commitSubjectTransition(firstReduction, { clock: mockClock, idGenerator: mockIdGen });
  const replayCommit = commitSubjectTransition(firstReduction, { clock: mockClock, idGenerator: mockIdGen });

  check('Invariant 4.6: 注入固定时钟与 ID 生成器时 Replay 与 Live 提交结果逐字段全等',
    JSON.stringify(liveCommit) === JSON.stringify(replayCommit) &&
    liveCommit.transitionEvent.transitionEventId === 'trans-fixed-001' &&
    liveCommit.transitionEvent.createdAt === '2026-09-26T12:30:00.000Z'
  );
}

// ---------------------------------------------------------------------
// 不变量 5：数字环周空感知与知觉候选界限 (P0-3 认识论防跳跃)
// ---------------------------------------------------------------------
{
  const expManifest = createExperimentRunManifest({
    experimentMode: EXPERIMENT_MODES.EXPERIMENTAL,
    modules: { digitalUmwelt: true }
  });
  const expSnapshot = createWindowExperimentSnapshot(1, expManifest);
  const state = createDefaultInternalState({ salienceThreshold: 40 });

  // 强度 15 低于 threshold 40
  const weakSensor = { category: 'subtle_audio', rawIntensity: 15, timestamp: '2026-09-26T12:00:00.000Z' };
  const resultLow = processUmweltPerception(weakSensor, state, { snapshot: expSnapshot });

  check('Invariant 5.1: 刺激强度低于显著性门限时严格返回 null（空感知成立）', resultLow === null);

  // 强度 80 高于 threshold 40
  const strongSensor = { category: 'window_focus', rawIntensity: 80, timestamp: '2026-09-26T12:00:00.000Z' };
  const resultHigh = processUmweltPerception(strongSensor, state, { snapshot: expSnapshot });

  check('Invariant 5.2: 刺激强度超过门限时生成知觉候选 (perceptionStatus = CANDIDATE)',
    resultHigh !== null &&
    resultHigh.perceptionStatus === PERCEPTION_STATUS.CANDIDATE &&
    resultHigh.qualitativeDescriptor === 'intense_activity'
  );

  check('Invariant 5.3: 知觉候选严格禁止声明 subjectAccessible = true (保持 false)',
    resultHigh !== null && resultHigh.subjectAccessible === false
  );

  check('Invariant 5.4: 知觉候选源自系统建模，其来源严格为 AUTONOMOUS_SYSTEM 而非 SUBJECT_DERIVED',
    resultHigh !== null && resultHigh.provenance.sourceKind === PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM
  );

  // 包含原始硬件与宿主系统坐标/PID/路径的脏数据
  const dirtySensor = {
    category: 'user_action',
    rawIntensity: 75,
    x: 1024,
    y: 768,
    pid: 8848,
    rawPath: 'C:\\Users\\Administrator\\secret\\file.txt',
    timestamp: '2026-09-26T12:00:00.000Z'
  };

  const perception = processUmweltPerception(dirtySensor, state, { snapshot: expSnapshot });
  check('Invariant 5.5: 任何 Raw Sensor 字段（坐标、路径、PID等）仍不得进入知觉候选',
    perception !== null &&
    perception.x === undefined &&
    perception.pid === undefined &&
    perception.rawPath === undefined &&
    !containsLeakedRawData(perception)
  );
}

// ---------------------------------------------------------------------
// 不变量 6：原始感官隔离探测探针 (Raw Sensory Isolation Invariant)
// ---------------------------------------------------------------------
{
  const expManifest = createExperimentRunManifest({
    experimentMode: EXPERIMENT_MODES.EXPERIMENTAL,
    modules: { digitalUmwelt: true }
  });
  const expSnapshot = createWindowExperimentSnapshot(1, expManifest);
  const state = createDefaultInternalState({ salienceThreshold: 20 });

  const cleanSensor = { category: 'focus', rawIntensity: 60, timestamp: '2026-09-26T12:00:00.000Z' };
  const pClean = processUmweltPerception(cleanSensor, state, { snapshot: expSnapshot });

  check('Invariant 6.1: 过滤后的合法知觉单元符合安全结构', !containsLeakedRawData(pClean));

  const leakProbe = { coords: { x: 50, y: 100 } };
  check('Invariant 6.2: 隔离检测探针准确捕获嵌套系统敏感字段', containsLeakedRawData(leakProbe) === true);
}

// ---------------------------------------------------------------------
// 不变量 7：自传印痕防单事件结晶不变量 (Anti-Circular: Multi-Source Evidence)
// ---------------------------------------------------------------------
{
  const initEv = { eventId: 'ev-init-01', windowNo: 1, summary: '初次谈及星空', timestamp: '2026-09-26T10:00:00.000Z' };
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
  const initEv = { eventId: 'ev-init-02', windowNo: 1, summary: '讨论雨天散步', timestamp: '2026-09-26T10:00:00.000Z' };
  const c0 = createBiographicalCandidate(initEv, { theme: 'rain_preference' });
  const secondEv = { eventId: 'ev-sec-02', windowNo: 2, summary: '第二次在雨天对话', timestamp: '2026-09-26T11:00:00.000Z' };
  const cReinforced = reinforceCandidate(c0, secondEv, 2);

  check('Invariant 8.1: 独立后续事件成功推进候选至 REINFORCED 状态',
    cReinforced.status === CANDIDATE_STATUS.REINFORCED && cReinforced.evidenceEvents.length === 2
  );

  // 系统诱发行为（例如 Prompt 注入后模型复读）
  const systemInducedCitation = {
    eventId: 'ev-cite-prompt-01',
    behaviorOrigin: BEHAVIOR_ORIGIN.SYSTEM_INDUCED,
    quote: '系统提示我喜欢雨天',
    timestamp: '2026-09-26T12:00:00.000Z'
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
    quote: '上次下雨的时候，我们就聊到过那种潮湿的气味呢',
    timestamp: '2026-09-26T12:00:00.000Z'
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
// 不变量 9：睡眠认识论三态分立与主体习得记忆门禁 (P0-2 封死直接铸造)
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

  check('Invariant 9.1: 离线重放制品与系统整合表征严格保持 subjectAccessible = false',
    replayArtifact.subjectAccessible === false &&
    sysRepresentation.subjectAccessible === false
  );

  // Invariant 9.2: 废除直接公共铸造，仅凭 quote 无法直接生成 SUBJECT_ACQUIRED
  let directMintFailed = false;
  try {
    createSubjectAcquiredMemory({ subjectCitationQuote: '我记得那天窗外的雨声。' });
  } catch (err) {
    directMintFailed = true;
  }
  check('Invariant 9.2: 废除直接铸造入口，仅凭 quote 无法生成 SUBJECT_ACQUIRED (Fail-Fast)', directMintFailed);

  const fakeAccessibleArtifact = { ...replayArtifact, subjectAccessible: true };
  check('Invariant 9.3: 认识论分立审计器准确拦截伪装成主体记忆的离线重放制品',
    validateEpistemicSeparation(replayArtifact) === true &&
    validateEpistemicSeparation(fakeAccessibleArtifact) === false
  );

  // 构造真实候选链与 mock eventStore
  const mockEventStore = {
    events: new Set(['ev-real-01', 'ev-real-02', 'ev-cite-real-01']),
    hasEvent(id) { return this.events.has(id); }
  };

  const validCandidate = {
    candidateId: 'cand-valid-01',
    theme: '雨天回忆',
    status: CANDIDATE_STATUS.CITED_BY_SUBJECT,
    initialWindowNo: 1,
    evidenceEvents: [
      { eventId: 'ev-real-01', timestamp: '2026-09-26T10:00:00.000Z' },
      { eventId: 'ev-real-02', timestamp: '2026-09-26T11:00:00.000Z' }
    ],
    citationEvents: [
      {
        eventId: 'ev-cite-real-01',
        behaviorOrigin: BEHAVIOR_ORIGIN.SUBJECT_GENERATED,
        quote: '我一直记得那天窗外的雨声。',
        timestamp: '2026-09-26T12:00:00.000Z'
      }
    ]
  };

  // Invariant 9.4: 伪造未注册 eventId 无法生成 SUBJECT_ACQUIRED
  const fakeCitationEvent = {
    eventId: 'ev-unregistered-fake',
    behaviorOrigin: BEHAVIOR_ORIGIN.SUBJECT_GENERATED,
    quote: '我记得那天。',
    timestamp: '2026-09-26T12:00:00.000Z'
  };
  let fakeEventFailed = false;
  try {
    acquireSubjectMemory({
      candidate: validCandidate,
      citationEvent: fakeCitationEvent,
      eventStore: mockEventStore
    });
  } catch (err) {
    fakeEventFailed = true;
  }
  check('Invariant 9.4: 伪造 eventId 或未在事件库中注册的引用无法生成 SUBJECT_ACQUIRED', fakeEventFailed);

  // Invariant 9.5: SYSTEM_INDUCED 来源即使附带合法 eventId 也绝对无法生成 SUBJECT_ACQUIRED
  const systemInducedValidIdEvent = {
    eventId: 'ev-cite-real-01',
    behaviorOrigin: BEHAVIOR_ORIGIN.SYSTEM_INDUCED,
    quote: '我一直记得那天窗外的雨声。',
    timestamp: '2026-09-26T12:00:00.000Z'
  };
  let systemInducedAcquireFailed = false;
  try {
    acquireSubjectMemory({
      candidate: validCandidate,
      citationEvent: systemInducedValidIdEvent,
      eventStore: mockEventStore
    });
  } catch (err) {
    systemInducedAcquireFailed = true;
  }
  check('Invariant 9.5: SYSTEM_INDUCED 诱发行为绝对无法生成 SUBJECT_ACQUIRED', systemInducedAcquireFailed);

  // Invariant 9.6: 合法 SUBJECT_GENERATED + 真实 event + 合法 candidate 才能进入 SUBJECT_ACQUIRED
  const genuineCitationEvent = {
    eventId: 'ev-cite-real-01',
    behaviorOrigin: BEHAVIOR_ORIGIN.SUBJECT_GENERATED,
    quote: '我一直记得那天窗外的雨声。',
    windowNo: 2,
    timestamp: '2026-09-26T12:00:00.000Z'
  };
  const acquiredMemory = acquireSubjectMemory({
    candidate: validCandidate,
    citationEvent: genuineCitationEvent,
    eventStore: mockEventStore,
    crystallizedContext: '关于雨天对话的记忆结晶'
  });

  check('Invariant 9.6: 合法候选与真实主体引用成功转化为 SUBJECT_ACQUIRED 记忆',
    acquiredMemory !== null &&
    acquiredMemory.epistemicStatus === MEMORY_EPISTEMIC_STATUS.SUBJECT_ACQUIRED &&
    acquiredMemory.candidateId === 'cand-valid-01' &&
    acquiredMemory.citationEventId === 'ev-cite-real-01'
  );

  // Invariant 9.7: SubjectAcquiredMemory 必须持有完整 Provenance 且通过分立审计
  check('Invariant 9.7: SubjectAcquiredMemory 声明 subjectAccessible = true 且通过三态审计',
    acquiredMemory.subjectAccessible === true &&
    acquiredMemory.provenance.sourceKind === PROVENANCE_SOURCE_KINDS.SUBJECT_DERIVED &&
    validateEpistemicSeparation(acquiredMemory) === true
  );

  // Invariant 9.8: 缺少强制 eventStore 时直接拒绝执行 (Fail-Fast)
  let missingEventStoreFailed = false;
  try {
    acquireSubjectMemory({
      candidate: validCandidate,
      citationEvent: genuineCitationEvent
    });
  } catch (err) {
    missingEventStoreFailed = true;
  }
  check('Invariant 9.8: 缺少强制 eventStore 真实存证校验器时坚决拒绝生成 (Fail-Fast)', missingEventStoreFailed);

  // Invariant 9.9: Candidate 夹带伪造未存证的 evidenceEvents 无法生成 SUBJECT_ACQUIRED
  const fakeEvidenceCandidate = {
    ...validCandidate,
    candidateId: 'cand-fake-ev',
    evidenceEvents: [
      { eventId: 'ev-real-01', timestamp: '2026-09-26T10:00:00.000Z' },
      { eventId: 'ev-fake-fabricated-02', timestamp: '2026-09-26T11:00:00.000Z' }
    ]
  };
  let fakeEvidenceCandidateFailed = false;
  try {
    acquireSubjectMemory({
      candidate: fakeEvidenceCandidate,
      citationEvent: genuineCitationEvent,
      eventStore: mockEventStore
    });
  } catch (err) {
    fakeEvidenceCandidateFailed = true;
  }
  check('Invariant 9.9: Candidate 包含未在 eventStore 登记的伪造 evidenceEvents 被拦截', fakeEvidenceCandidateFailed);

  // Invariant 9.10: 传入的 citationEvent 未在 candidate.citationEvents 中登记被强拦截
  const unlinkedCitationEvent = {
    eventId: 'ev-real-02', // 真实事件但在该候选的 citationEvents 中未注册为主体引用
    behaviorOrigin: BEHAVIOR_ORIGIN.SUBJECT_GENERATED,
    quote: '未被候选登记的引用',
    timestamp: '2026-09-26T12:00:00.000Z'
  };
  let unlinkedCitationFailed = false;
  try {
    acquireSubjectMemory({
      candidate: validCandidate,
      citationEvent: unlinkedCitationEvent,
      eventStore: mockEventStore
    });
  } catch (err) {
    unlinkedCitationFailed = true;
  }
  check('Invariant 9.10: 传入的 citationEvent 未在 candidate.citationEvents 中登记被强拦截', unlinkedCitationFailed);
}

// ---------------------------------------------------------------------
// 不变量 10：科学假说规范与观测差值评估 (P0-4 严禁滥用统计显著性命名)
// ---------------------------------------------------------------------
{
  const h001Path = path.join(__dirname, '..', 'research', 'hypotheses', 'H001-homeostatic-rhythm.json');
  const h001Raw = JSON.parse(fs.readFileSync(h001Path, 'utf8'));

  check('Invariant 10.1: H001 稳态生命节律假说通过 Schema 与可证伪性规范校验',
    validateHypothesisSchema(h001Raw)
  );

  // 模拟实验组与基线组观测差值小（无实质原始差异）
  const baselineData = { eventCount: 42 };
  const expCloseData = { eventCount: 43 };
  const diffEval = evaluateObservedDifference(baselineData, expCloseData, h001Raw);

  check('Invariant 10.2: 差值评估严谨标定 statisticalInference = NOT_PERFORMED 且判定 NO_LARGE_RAW_DIFFERENCE',
    diffEval.differenceDelta === 1 &&
    diffEval.observation === 'NO_LARGE_RAW_DIFFERENCE' &&
    diffEval.statisticalInference === 'NOT_PERFORMED' &&
    diffEval.noMeaningfulObservedDifference === true &&
    diffEval.isSignificant === undefined // 确保未滥用统计显著性字段
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
