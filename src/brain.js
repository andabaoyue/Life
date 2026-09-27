const fs = require('fs');
const path = require('path');
const { Memory } = require('./memory');
const { DeepSeek, isPeakHour, costOf } = require('./deepseek');
const { PERSONA } = require('./persona');
const { CREATIVE_SKILL } = require('./creative-skill');
const { CATALOG, PRESETS, SLOTS } = require('./wardrobe');
const { writeJsonAtomic } = require('./atomic');
const { tryLoad, sanitize, DEFAULTS } = require('./config');
const { SelfLedger } = require('./self-ledger');
const { DeferredWriter } = require('./deferred-writer');
const { ExperiencesArchive } = require('./experiences-archive');
const { SubjectState } = require('./subject-state');
const { createEvent, validateEvent, isEligibleSubjectEvent, createObservation, validateObservation, createInterpretation, validateInterpretation, validateWindowSummary } = require('./experience-schema');
const { createStateChangeExplanation } = require('./state-change');
const { InternalRegulationManager } = require('./internal-regulation');
const { createExperimentRunManifest, createWindowExperimentSnapshot } = require('./experiment-run');
const { buildGenerationContext, collectPromptHashes } = require('./experiment-metadata');

const SUMMARY_SYS =
  '你是对话记忆整理助手。请对当前窗口的对话进行「5×20 分段归档 + 窗口综合（Window Synthesis）」结构化总结。'
  + '必须严格区分「用户给予（userGiven）」与「初澜经历（chulanExperience）」，绝不允许混同：\n'
  + '1. 【用户给予】只记用户明确告诉、要求记住、明确表达、纠正或双方约定的事实（姓名、职业、偏好、目标、约定）。冲突以新为准。\n'
  + '2. 【初澜经历】只记初澜在互动中观察到的规律、做出的选择、形成的行为趋势、对关系的连续理解与内部反思。不记程序触发理由、寒暄或无根据猜测。\n'
  + '3. 【状态证据（stateEvidence）】提取支持主体状态变化的证据，trait 可选 quiet_preference、social_initiative、attachment_need、vitality、philosophical_curiosity，'
  + 'direction 为 [-1, 1] 方向，strength 为 [0, 1] 强度，messageId 必须严格引用对话中程序签发的真实 ID（如 m-000001），quote 必须逐字摘自该条消息原文。\n'
  + '请只输出如下合法 JSON 对象（不要 Markdown 代码块包裹）：\n'
  + '{"segments":[{"range":"1-20","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"21-40","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"41-60","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"61-80","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"81-100","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]}],'
  + '"windowSynthesis":{"stableUserFacts":[],"subjectExperiences":[],"stateChangesSuggested":[],"unresolved":[]}}';

const MERGE_SYS =
  '你是长期记忆合并助手。下面给出若干条按时间顺序排列的记忆片段，'
  + '把它们合并成一条连贯的早期记忆，要求：'
  + '同一事实以最新的为准，用户纠正过的结论必须覆盖旧版本；'
  + '保留所有具体的人名、称呼、数字、偏好、项目和约定，不得改写具体信息；'
  + '去掉重复条目；控制在 250 字以内；只输出正文。';

const GROWTH_SYS =
  '你是数字主体的经历筛选器。只从给定对话中提取可能改变初澜是谁的长期成长证据，'
  + '例如明确形成的偏好、价值取向、边界、愿望、反思或关系理解；不要记录点击、拖拽、时间、'
  + '一次性情绪、模型猜测、用户普通事实或没有证据的意识宣称。'
  + '只输出 JSON 数组，每项格式为 {"trait":"简短倾向","support":[{"sourceType":"USER|EXPERIENCE|SELF_INFERRED|OBSERVATION|MODEL_PRIOR","window":0,"messageIds":[],"quote":"短证据摘录","confidence":0.0}],"oppose":[]}。'
  + '没有足够证据就输出 []。support 与 oppose 都要保留，不能用最新值覆盖矛盾经历。';

function systemPersona(cfg) {
  return cfg.writingMode ? PERSONA + '\n\n' + CREATIVE_SKILL : PERSONA;
}

/* ---------- 状态标记 ----------
   persona 要求模型在末尾附 [state:xx]。解析失败就按 idle 处理并原样保留文本，
   绝不能因为格式跑偏把回复弄丢或弄崩。 */
const STATES = ['idle', 'happy', 'curious', 'thinking', 'sleepy',
                'embarrassed', 'annoyed', 'sad'];
// 句末标点是模型的habit（"好呀~[state:happy]。"），必须容错，
// 否则标记既触发不了表情，又会作为正文永久留在历史里污染前缀。
const STATE_RE = /\[\s*state\s*[:：]\s*([a-z]+)\s*\][\s\p{P}~]*$/iu;

function parseState(text) {
  const m = text.match(STATE_RE);
  if (!m) return { text, state: 'idle' };
  const s = m[1].toLowerCase();
  // 未知状态词不剥离：宁可屏幕上多一个怪标记，也不能把正文掏空。
  // 之前 [state:dance] 会被剥成空文本，触发"返回空内容"，一条好回复白白报废。
  if (!STATES.includes(s)) return { text, state: 'idle' };
  const clean = text.slice(0, m.index).trimEnd();
  return { text: clean || text, state: s };
}

/* ---------- 换装提案标记 ----------
   模型可以输出 [wear:itemId]，但这只是「提案」——
   衣服是不是真穿上了，由 main 里的 wardrobe 决定并把结果带回来。
   未知 id 不剥离（同 state 的教训：不能把正文掏空），
   也绝不允许「说了 [wear:x] 就当换好了」。 */
const WEAR_RE = /\[\s*wear\s*[:：]\s*([a-z0-9_]+)\s*\][\s\p{P}~]*$/iu;

function parseWear(text) {
  const m = text.match(WEAR_RE);
  if (!m) return { text, wear: null };
  const key = m[1].toLowerCase();
  const offSlot = key.startsWith('off_') ? key.slice(4) : null;
  const canOff = offSlot && SLOTS.some(s => s.id.toLowerCase() === offSlot && !s.required);
  // 只认衣柜里真实存在的条目/预设，或真实的非必选槽位脱下指令；幻觉 id 原样留在正文里，
  // applyProposal 会如实返回失败，屏幕上也不会出现幽灵标记被吃掉的情况。
  if (!CATALOG[key] && !PRESETS[key] && !canOff) return { text, wear: null };
  const clean = text.slice(0, m.index).trimEnd();
  return { text: clean || text, wear: key };
}

/**
 * 调度：对话 -> 记录 usage -> 到窗口边界就小结 -> 记忆超预算就合并。
 *
 * 缓存策略的核心是「把破坏集中到同一刻」：
 *   窗口内 system 完全不变，前缀只追加 -> 基本全命中；
 *   窗口关闭时 system 必然要变（多了条小结），这一轮请求一定未命中；
 *   既然这一刻已经破了，记忆合并就搭在同一个时刻一起做，
 *   否则分两次做要破两次缓存。
 */
class Brain {
  constructor(userDataDir, cfg) {
    this.dir = userDataDir;
    this.cfg = cfg || {};
    const sanitizedExp = sanitize({
      experimentMode: this.cfg.experimentMode,
      experimentModules: this.cfg.experimentModules
    });
    this.cfg.experimentMode = sanitizedExp.experimentMode;
    this.cfg.experimentModules = sanitizedExp.experimentModules;
    const { validateCredentialTarget, providerFor } = require('./provider-policy');
    const pTarget = this.cfg.provider || providerFor(this.cfg.baseURL);
    const cType = this.cfg.credentialType || (pTarget === 'deepseek' ? 'deepseek-api-key' : 'apiKey');
    const policyCheck = validateCredentialTarget({ provider: pTarget, baseURL: this.cfg.baseURL, credentialType: cType });
    if (!policyCheck.ok) {
      console.warn(`[Brain] Provider Policy 检查未通过: ${policyCheck.error}`);
    }
    this.api = new DeepSeek(this.cfg);
    this.persona = PERSONA;

    // Phase 0.5: 历史优先恢复顺序 (Archive -> SubjectState -> Memory Dynamics -> Internal Regulation -> Self Projection)
    this.experiencesArchive = new ExperiencesArchive(userDataDir);
    this.memory = new Memory(userDataDir, {
      persona: systemPersona(this.cfg),
      windowTurns: this.cfg.windowTurns,
      windowMaxTokens: this.cfg.windowMaxTokens,
      keepTailMessages: this.cfg.keepTailMessages,
      memoryCapTokens: this.cfg.memoryCapTokens,
      experimentModules: this.cfg.experimentModules,
      memoryDynamics: this.cfg.experimentModules?.memoryDynamics
    });

    const currentWinNo = (this.memory.data && typeof this.memory.data.windowNo === 'number')
      ? this.memory.data.windowNo : 1;

    // Phase 0 / Phase 0.5: 实验 Run 生命周期 Manifest 与当前窗口不可变快照
    this.runManifest = createExperimentRunManifest({
      experimentMode: this.cfg.experimentMode,
      modules: this.cfg.experimentModules,
      windowNo: currentWinNo
    });
    this.currentWindowSnapshot = createWindowExperimentSnapshot(currentWinNo, this.runManifest);

    // 确保内部模块以当前窗口冻结的配置生效
    this.cfg.experimentMode = this.currentWindowSnapshot.experimentMode;
    this.cfg.experimentModules = this.currentWindowSnapshot.modules;

    this.subjectState = new SubjectState(userDataDir, {
      stepWeight: this.cfg.subjectStateStepWeight,
      maxDeltaPerWindow: this.cfg.subjectStateMaxDelta,
      experimentModules: this.currentWindowSnapshot.modules
    });
    this.memory.opts.experimentModules = this.currentWindowSnapshot.modules;
    this.memory.memoryDynamicsEnabled = Boolean(this.currentWindowSnapshot.modules?.memoryDynamics);

    this.dreamHistory = [];
    this._restoreDreamHistory();
    this._restoreEngramSnapshotFromArchive();
    this.internalRegulation = new InternalRegulationManager(userDataDir, {
      enabled: Boolean(this.currentWindowSnapshot.modules?.internalRegulation),
      experimentModules: this.currentWindowSnapshot.modules
    });
    this._restoreInternalRegulationFromArchive();

    this.selfLedger = new SelfLedger(userDataDir, {
      maxEntries: this.cfg.selfLedgerMaxEntries,
      currentSelfTokenBudget: this.cfg.currentSelfTokenBudget
    });
    this.birthAt = this.selfLedger.setBirthAt(Date.now());

    this.statsPath = path.join(userDataDir, 'stats.json');
    this.statsWriter = new DeferredWriter(() => writeJsonAtomic(this.statsPath, this.stats), { delayMs: 3000 });
    this.stats = this.loadStats();
    this.ctrl = null;
    this.pendingUser = false;
    this.boundary = false;   // 关窗/合并进行中，防重入
    this.generationId = 1;
    this.shutdownRequested = false;

    // 换装执行器（main 注入）。
    this.wardrobe = null;
    // 本地活动追踪器与行为调度器（main 注入或构造传入）
    this.tracker = null;
    this.behaviorScheduler = (cfg && cfg.behaviorScheduler) ? cfg.behaviorScheduler : null;
    if (this.behaviorScheduler && this.internalRegulation) {
      this.behaviorScheduler.setInternalRegulation(this.internalRegulation);
    }
    if (cfg && cfg.tracker) {
      this.bindTracker(cfg.tracker);
    }

    // Phase 0.5: 环境知觉与注意力流水线缓冲区 (bounded <= 50)
    this.recentPerceptions = [];

    // 实验遥测与缓存破坏归因底座 (v0.9.6 P0-14 & P0-15)
    this.telemetryPath = path.join(userDataDir, 'experiment-telemetry.jsonl');
    this.telemetrySeq = 0;
    this.pendingCacheBreakReason = null;
  }

  bindBehaviorScheduler(scheduler) {
    this.behaviorScheduler = scheduler || null;
    if (this.behaviorScheduler && this.internalRegulation) {
      this.behaviorScheduler.setInternalRegulation(this.internalRegulation);
    }
  }

  setBehaviorScheduler(scheduler) {
    this.bindBehaviorScheduler(scheduler);
  }

  bindTracker(tracker) {
    this.tracker = tracker || null;
    if (this.tracker && this.internalRegulation) {
      this.tracker.setInternalRegulation(this.internalRegulation);
    }
    if (this.tracker && typeof this.processEnvironmentalPerception === 'function') {
      this.tracker.setPerceptionPipeline((raw) => this.processEnvironmentalPerception(raw));
    }
  }

  /**
   * 判定指定实验模块在当前窗口快照中是否激活
   * 
   * @param {string} moduleName
   * @returns {boolean}
   */
  isExperimentModuleActive(moduleName) {
    if (this.currentWindowSnapshot && this.currentWindowSnapshot.modules) {
      return Boolean(this.currentWindowSnapshot.modules[moduleName]);
    }
    return Boolean(this.cfg.experimentModules?.[moduleName]);
  }

  /**
   * 数字环周环境感知与注意力闸门真实生产流水线 (Phase 0.5: P0-2 & DigitalUmwelt -> AttentionGate)
   * 
   * 认识论不变量（Epistemic Invariant）：
   * 1. subjectAccessible: false 绝对守恒。
   * 2. ATTENDED ≠ SUBJECT_ACQUIRED 绝对守恒。
   * 3. 绝不越级直接篡改 SubjectState 或 Subject Memory。
   * 
   * @param {Object} rawSensorData
   * @returns {Object|null}
   */
  processEnvironmentalPerception(rawSensorData) {
    if (!this.isExperimentModuleActive('digitalUmwelt')) return null;
    const { filterRawTelemetry, processUmweltPerception } = require('./digital-umwelt');
    const { evaluateAttentionGate, assertNotSubjectAcquired } = require('./attention-gate');

    const filtered = filterRawTelemetry(rawSensorData);
    if (!filtered) return null;

    const internalState = {
      values: this.internalRegulation ? this.internalRegulation.getState() : {}
    };
    const snapshot = this.currentWindowSnapshot || {
      experimentMode: this.cfg.experimentMode,
      modules: this.cfg.experimentModules
    };

    const candidate = processUmweltPerception(rawSensorData, internalState, { snapshot });
    if (!candidate) return null;

    let gateResult = null;
    if (this.isExperimentModuleActive('attentionGate')) {
      gateResult = evaluateAttentionGate(candidate, this.internalRegulation, {
        snapshot,
        modules: snapshot.modules
      });
    } else {
      gateResult = Object.freeze({
        status: 'ATTENDED',
        attended: true,
        reason: 'ATTENTION_GATE_DISABLED',
        subjectAccessible: false
      });
    }

    assertNotSubjectAcquired(gateResult);

    const record = {
      candidate,
      gateResult,
      timestamp: Date.now()
    };
    this.recentPerceptions.push(record);
    if (this.recentPerceptions.length > 50) {
      this.recentPerceptions.shift();
    }

    // P1-1: Attention 瞬时非人格化下游调节信号闭环 (ATTENDED ≠ SUBJECT_ACQUIRED)
    if (gateResult && gateResult.status === 'ATTENDED' && this.internalRegulation && typeof this.internalRegulation.updateOnAttention === 'function') {
      this.internalRegulation.updateOnAttention(gateResult, { timestamp: record.timestamp });
    }

    return record;
  }

  /**
   * 从归档底座冷启动恢复历史梦境记录 (保证跨重启后窗口间隔与24h频次门禁不失效)
   */
  _restoreDreamHistory() {
    this.dreamHistory = [];
    if (!this.experiencesArchive) return;
    try {
      const records = this.experiencesArchive.readAll();
      for (const r of records) {
        if (!r) continue;
        const type = r.recordType || r.type;
        if (type === 'subject_dream') {
          const p = (r.payload && typeof r.payload === 'object') ? r.payload : {};
          this.dreamHistory.push({
            dreamId: p.dreamId || r.dreamId || r.recordId,
            windowNo: (typeof r.windowNo === 'number') ? r.windowNo : (typeof p.windowNo === 'number' ? p.windowNo : 0),
            timestamp: typeof r.timestamp === 'number' ? r.timestamp : (typeof p.generatedAt === 'number' ? p.generatedAt : (r.createdAt || 0)),
            generatedAt: typeof p.generatedAt === 'number' ? p.generatedAt : (typeof r.timestamp === 'number' ? r.timestamp : 0),
            epistemicStatus: p.epistemicStatus || r.epistemicStatus
          });
        }
      }
    } catch (e) {
      console.warn('[Brain] 恢复历史梦境记录失败:', e.message);
    }
  }

  /**
   * 从经历归档冷启动恢复最新的记忆动力学快照 (若 memory.json 缺损或初次启动)
   */
  _restoreEngramSnapshotFromArchive() {
    if (!this.memory || !this.memory.engramManager || !this.experiencesArchive) return;
    if (this.memory.engramManager.traces.size > 0) return;
    try {
      const records = this.experiencesArchive.readAll();
      let latestSnapshot = null;
      for (const r of records) {
        if (!r) continue;
        const type = r.recordType || r.type;
        if (type === 'memory_dynamics_snapshot' && r.payload && r.payload.snapshot) {
          latestSnapshot = r.payload.snapshot;
        }
      }
      if (latestSnapshot) {
        this.memory.engramManager.restoreFromSnapshot(latestSnapshot);
      }
    } catch (e) {
      console.warn('[Brain] 从经历归档恢复记忆动力学快照失败:', e.message);
    }
  }

  _restoreInternalRegulationFromArchive() {
    if (!this.internalRegulation || !this.experiencesArchive) return;
    try {
      if (fs.existsSync(this.internalRegulation.path)) return;
      const records = this.experiencesArchive.readAll();
      let latestPayload = null;
      for (const r of records) {
        if (!r) continue;
        const type = r.recordType || r.type;
        if (type === 'internal_regulation_snapshot' && r.payload && r.payload.state) {
          latestPayload = r.payload;
        }
      }
      if (latestPayload && latestPayload.state) {
        const s = latestPayload.state;
        if (typeof s.energy === 'number') this.internalRegulation.energy = s.energy;
        if (typeof s.restPressure === 'number') this.internalRegulation.restPressure = s.restPressure;
        if (typeof s.arousal === 'number') this.internalRegulation.arousal = s.arousal;
        if (typeof s.interactionDensity === 'number') this.internalRegulation.interactionDensity = s.interactionDensity;
        if (typeof s.cognitiveLoadProxy === 'number') this.internalRegulation.cognitiveLoadProxy = s.cognitiveLoadProxy;
        this.internalRegulation.salienceThreshold = this.internalRegulation._computeSalienceThreshold(this.internalRegulation.arousal);
        this.internalRegulation.updatedAt = s.updatedAt || Date.now();
        this.internalRegulation.save();
      }
    } catch (e) {
      console.warn('[Brain] 从经历归档恢复内部调节快照失败:', e.message);
    }
  }

  setWardrobe(nameOrBlock) {
    if (this.wardrobe && typeof this.wardrobe.applyProposal === 'function') {
      const wearChanged = this.wardrobe.applyProposal(nameOrBlock);
      if (wearChanged) {
        this.memory.wardrobe = this.wardrobe.promptBlock();
        this.pendingCacheBreakReason = 'wardrobe_change';
      }
      return wearChanged;
    }
    if (typeof nameOrBlock === 'string') {
      this.memory.wardrobe = nameOrBlock;
      this.pendingCacheBreakReason = 'wardrobe_change';
      return true;
    }
    return false;
  }

  deleteWindow(i) {
    const res = this.memory ? this.memory.deleteWindow(i) : false;
    this.pendingCacheBreakReason = 'manual_memory_delete';
    return res;
  }

  recordCacheBreak(reason) {
    this.pendingCacheBreakReason = reason || 'unknown';
  }

  appendTelemetry(data = {}) {
    if (!this.dir) return null;
    try {
      this.telemetrySeq = (this.telemetrySeq || 0) + 1;
      const rec = {
        telemetrySeq: this.telemetrySeq,
        timestamp: data.timestamp || Date.now(),
        windowNo: (typeof data.windowNo === 'number' && !Number.isNaN(data.windowNo)) ? data.windowNo : (this.memory ? this.memory.data.windowNo : 1),
        requestType: data.requestType || 'chat',
        promptTokens: typeof data.promptTokens === 'number' ? data.promptTokens : 0,
        promptCacheHitTokens: typeof data.promptCacheHitTokens === 'number' ? data.promptCacheHitTokens : 0,
        promptCacheMissTokens: typeof data.promptCacheMissTokens === 'number' ? data.promptCacheMissTokens : 0,
        completionTokens: typeof data.completionTokens === 'number' ? data.completionTokens : 0,
        cacheHitRate: typeof data.cacheHitRate === 'number' ? data.cacheHitRate : 0,
        cacheBreakReason: data.cacheBreakReason || null
      };
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      fs.appendFileSync(this.telemetryPath, JSON.stringify(rec) + '\n', 'utf8');
      return rec;
    } catch (e) {
      console.error('[Brain] appendTelemetry failed:', e.message);
      return null;
    }
  }

  /**
   * 热重载配置（v0.7，配合 config.js 每次都真读盘）。
   *
   * 为什么放在 ask 开头而不是搞 fs.watch：一轮对话本来就要发一次请求，
   * 多一次几百字节的 stat + 读盘看不见，而"改了配置文件要重启"是文档里
   * 明明白白引导用户去改配置的反面。
   *
   * 三条规矩：
   *   1. 用 Object.assign 就地改，**不换对象引用**。this.api 和 main 的 cfg
   *      持有的是同一个对象，换引用就等于让 DeepSeek 客户端继续用旧 model。
   *   2. apiKey 不参与：盘上那份按设计不含明文 key（或只有降级明文），
   *      key 由 main 在启动时经 secure.js 解出来。这里覆盖它会把 key 抹成空。
   *   3. 读不到（文件正被编辑器写坏）就整份保持现状，绝不退到 DEFAULTS ——
   *      否则"改配置改出个语法错误"会让窗口参数当场跳回出厂值。
   */
  refreshConfig() {
    const next = tryLoad(this.dir);
    if (!next) return false;
    const apiKey = this.cfg.apiKey;
    const oldPersona = this.memory ? this.memory.persona : null;
    const oldWritingMode = this.cfg ? this.cfg.writingMode : null;

    // Phase 0 / 0.5: 窗口级实验快照冻结不变量。
    // 当前窗口活跃期间，禁止外部热重载篡改当前窗口的 experimentMode 与 experimentModules。
    const frozenMode = this.currentWindowSnapshot ? this.currentWindowSnapshot.experimentMode : this.cfg.experimentMode;
    const frozenModules = this.currentWindowSnapshot ? this.currentWindowSnapshot.modules : this.cfg.experimentModules;

    Object.assign(this.cfg, next, { apiKey });
    this.cfg.experimentMode = frozenMode;
    this.cfg.experimentModules = frozenModules;

    // 1. Memory 的窗口与上下文参数
    const m = this.memory;
    m.windowTurns = this.cfg.windowTurns;
    m.windowMaxTokens = this.cfg.windowMaxTokens;
    m.keepTail = this.cfg.keepTailMessages;
    m.memoryCap = this.cfg.memoryCapTokens;
    m.persona = systemPersona(this.cfg);

    if (oldPersona !== null && oldPersona !== m.persona) {
      this.pendingCacheBreakReason = (oldWritingMode !== this.cfg.writingMode)
        ? 'writing_mode_change'
        : 'config_prompt_change';
    }

    // 2. SelfLedger 档案参数同步（P1-02）
    if (this.selfLedger) {
      if (typeof this.cfg.selfLedgerMaxEntries === 'number') {
        this.selfLedger.maxEntries = this.cfg.selfLedgerMaxEntries;
      }
      if (typeof this.cfg.currentSelfTokenBudget === 'number') {
        this.selfLedger.currentSelfTokenBudget = this.cfg.currentSelfTokenBudget;
      }
    }

    // 3. DeepSeek API 运行时参数同步（超时时间、模型名等）
    if (this.api && this.api.cfg) {
      this.api.cfg.requestTimeoutMs = this.cfg.requestTimeoutMs;
      this.api.cfg.streamIdleTimeoutMs = this.cfg.streamIdleTimeoutMs;
      this.api.cfg.model = this.cfg.model;
      this.api.cfg.baseURL = this.cfg.baseURL;
      this.api.cfg.provider = this.cfg.provider;
      this.api.cfg.credentialType = this.cfg.credentialType;
    }

    return true;
  }

  loadStats() {
    // 老版本的 stats.json 可能缺字段，用默认值兜一层再合并，
    // 否则 undefined++ 会变 NaN，面板上一串 NaN。
    const base = { requests: 0, hit: 0, miss: 0, out: 0, cost: 0,
                   compressions: 0, merges: 0, summaryCalls: 0, growthCalls: 0,
                   lastHitRate: 0, history: [] };
    try { return { ...base, ...JSON.parse(fs.readFileSync(this.statsPath, 'utf8')) }; }
    catch { return base; }
  }
  saveStats(immediate = false) {
    this.statsWriter.markDirty();
    if (immediate) {
      this.statsWriter.flush();
    }
  }

  flushAll() {
    if (this.memory && typeof this.memory.flush === 'function') this.memory.flush();
    if (this.selfLedger && typeof this.selfLedger.flush === 'function') this.selfLedger.flush();
    if (this.subjectState && typeof this.subjectState.flush === 'function') this.subjectState.flush();
    if (this.experiencesArchive && typeof this.experiencesArchive.flush === 'function') this.experiencesArchive.flush();
    if (this.statsWriter && typeof this.statsWriter.flush === 'function') this.statsWriter.flush();
  }

  get ready() { return !!this.cfg.apiKey; }

  shutdown() {
    this.shutdownRequested = true;
    this.generationId++;
    this.abort();
    this.flushAll();
  }

  currentSelfContext() {
    if (!this.cfg.currentSelfTokenBudget) return '';
    const ageHours = Math.max(0, Date.now() - this.birthAt) / 3600000;
    const projection = this.selfLedger.currentSelfText();
    const stateSnapshot = this.subjectState ? this.subjectState.formatSnapshot() : '';
    return '【出生与程序年龄】\n- 出生时刻：' + new Date(this.birthAt).toISOString()
      + '\n- 程序运行意义上的年龄：约 ' + ageHours.toFixed(1) + ' 小时'
      + (projection ? '\n' + projection : '')
      + (stateSnapshot ? '\n' + stateSnapshot : '');
  }

  /**
   * 打断当前请求。
   * 同步回滚，不能等 ask() 的 catch —— main 是 abort() 之后立刻 ask(新消息)，
   * 异步回滚会误删刚追加的新消息。
   */
  abort() {
    if (!this.ctrl) return;
    const c = this.ctrl;
    this.ctrl = null;
    if (this.pendingUser) {
      this.memory.rollback(1);
      this.pendingUser = false;
    }
    c.abort();
  }

  /**
   * 一次对话。onDelta(text) 用于逐字上屏（原始流，含状态标记，前端自行遮蔽）。
   * 返回 { text, state, usage, windowClosed, merged }
   *
   * opts.proactive = true 时是「她主动搭话」：触发理由会作为 synthetic user
   * 进入 history，确保下一轮完整复用 DeepSeek 的 user/assistant 前缀缓存单元；
   * synthetic 不计入用户轮数，也不会在关窗小结中被当成用户事实。
   */
  async ask(userText, onDelta, opts = {}) {
    if (this.shutdownRequested) throw new Error('Brain 已停止');
    const proactive = !!opts.proactive;
    // 每轮开头热读一次配置（改文件不必重启）。
    // 对缓存无害：model 变了不影响 system 文本，窗口参数也不进 prompt。
    this.refreshConfig();
    if (!this.ready) throw new Error('还没填 API Key');

    /* ---- 本地活动：意图判定 + 环境快照 ----
       顺序要紧：recordUserInput 要在快照之前，否则"静默多久"算的是这一句之前。 */
    const tr = this.tracker;
    let sleepIntent = false, snap = null;
    if (tr && !proactive) sleepIntent = tr.recordUserInput(userText);
    if (tr) snap = tr.snapshot();

    // Phase 0.5: 内部调节中枢更新 (用户交互与物理刺激事件驱动)
    if (this.internalRegulation && !proactive) {
      const now = Date.now();
      const intervalMs = this._lastInteractionAt ? (now - this._lastInteractionAt) : 0;
      this._lastInteractionAt = now;
      this.internalRegulation.updateOnInteractionTurn({
        role: 'user',
        messageLength: userText ? userText.length : 0,
        intervalMs,
        timestamp: now
      });
      if (snap) {
        const trackerDirectlyWired = Boolean(tr && tr.internalRegulation === this.internalRegulation);
        if (!trackerDirectlyWired) {
          if (snap.clicks > 0) this.internalRegulation.updateOnActivity('poke', { count: snap.clicks, timestamp: now });
          if (snap.drags > 0) this.internalRegulation.updateOnActivity('drag', { count: snap.drags, timestamp: now });
          if (snap.idleMin > 10) this.internalRegulation.updateOnActivity('idle', { idleMin: snap.idleMin, timestamp: now });
        }
      }
    }

    // v0.9.7: 关联线索触发休眠记忆重新激活 (Contextual Reactivation)
    if (this.memory && this.memory.engramManager && !proactive) {
      this.memory.reactivateByContext(userText, this.memory.data.windowNo);
    }

    const envText = snap ? snap.promptText : '';
    const currentSelf = this.currentSelfContext();
    const shouldAttach = proactive || (snap && (
      snap.justWokenUp || snap.idleMin >= 15 || snap.clicks > 0 || snap.drags > 0));
    /* 瞬时上下文（当前自我投影与程序年龄 + 环境感知快照）绝不写入永久历史 memory.history：
       持久化历史 = 稳定事实；当前环境与自我投影 = 瞬时上下文。
       如果每轮写入历史，会导致历史中堆叠大量过期的自我账本副本，造成严重的 Token 膨胀并破坏长期记忆。
       正确数据流：memory.history 仅保存纯净用户输入（主动搭话记录纯净触发理由），
       在构建发给 DeepSeek 的请求时，动态附加在当前 user 消息末尾。 */
    const dynamicContext = [currentSelf, shouldAttach ? envText : ''].filter(Boolean).join('\n\n');
    const proactivePayload = proactive
      ? '[自主感知触发]：' + userText
        + (opts.proactiveHint ? '\n[内部语气提示]：' + String(opts.proactiveHint) : '')
      : '';
    const historyText = proactive ? proactivePayload : userText;

    if (proactive) {
      // 主动搭话以 synthetic 纯净消息进入 history，让后续轮次复用「主动触发 + 模型回复」前缀。
      // synthetic=true 在关窗小结时以“程序触发”标注，不会被当成用户事实。
      this.memory.append('user', historyText,
        { synthetic: true, source: 'proactive' });
    } else {
      this.memory.append('user', historyText);
    }
    this.pendingUser = true;

    // 动态将瞬时上下文注入到本轮 API 请求的最后一条 user 消息副本中，不污染 this.memory.data.history
    const messages = this.memory.build(dynamicContext);

    const ctrl = new AbortController();
    this.ctrl = ctrl;

    let text, usage;
    try {
      const r = await this.api.stream(messages, onDelta, {
        signal: ctrl.signal
      });
      text = r.text; usage = r.usage;
    } catch (err) {
      // 只有「还是本次请求」时才回滚，避免被后来的请求抢跑
      if (this.ctrl === ctrl && this.pendingUser) {
        this.memory.rollback(1);
        this.pendingUser = false;
      }
      // 置空同样要带守卫：abort() 后 main 会同步发起新请求（ctrl 已是新的），
      // 本次的 AbortError 稍后才进 catch，无条件置空会抹掉新请求的 controller，
      // 导致下一次 abort() 失效、两路流并发上屏。
      if (this.ctrl === ctrl) this.ctrl = null;
      // 遥测刻意**不**回滚：没 commit 就等于没消费，这些事件下次如实补报。
      throw err;
    }

    if (this.ctrl === ctrl) this.ctrl = null;
    this.pendingUser = false;

    if (!text) {
      // 主动搭话没追加过，也就没什么可回滚 —— 少一个「 rollback 删错人」的分支
      if (!proactive) this.memory.rollback(1);
      throw new Error('返回空内容');
    }

    // 请求真的走完了才消费这批遥测（commit 内含 lastConversationAt 更新）
    if (tr && snap) tr.commit(snap.throughSeq);

    // 状态/换装标记只驱动表情与衣柜，不进历史 ——
    // 存进 history 会让后续前缀带上这些噪音，模型也容易学着乱加。
    // 交替剥到不动为止：模型可能连发多条 [wear:] 提案再收尾 [state:]，
    // 顺序没有保证。每轮都要求文本变短，最多 8 层，绝不可能死循环。
    // 与前端 stripState 的循环行为一致，两边藏的是同一批标记。
    let clean = text, state = 'idle';
    const wears = [];
    // 循环没有次数上限，靠「每轮文本必须变短」保证终止 ——
    // 这里刻意不写 for(i<8)：前端 stripState 也是不设上限的同一套规则，
    // 一旦模型连发超过 8 条提案，后端只剥 8 条、前端全剥，
    // 屏幕上和写进历史的就不是同一批标记了（那是比不剥更糟的错）。
    for (;;) {
      const a = parseState(clean);
      const w = parseWear(a.text);
      // 剥离是从尾部往头部走的，所以第一个剥到的非 idle 状态才是模型放在
      // 末尾收尾的那一个 —— 它才是结论。之前无条件覆盖会让正文里更靠前的
      // 那个赢：模型引用「比如 [state:happy] 这种标记」时，被采用的竟是举例。
      // 已知取舍：结尾真是 [state:idle] 而前面出现过别的状态时，仍会取前面那个
      // —— parseState 分不清「没带标记」和「标记就是 idle」，
      // 为这种少见情况再多带一个标志位不值得。
      if (state === 'idle' && a.state !== 'idle') state = a.state;
      // 连发多条换装提案是合法的，必须逐条收集，不能只留一个。
      // 刻意不去重：模型真写了两遍，历史里就该看到两条如实结果，
      // 悄悄合并成一条又是「程序替模型说话」。
      if (w.wear) wears.unshift(w.wear);
      if (w.text === clean) break;   // 这一轮一个标记都没剥掉 → 收尾
      clean = w.text;
    }

    // 语言状态 ≠ 程序状态：模型说了 [wear:x] 不算换上，
    // 逐条真实执行，每条的结果写回历史，下一轮它看到的是事实而不是想象。
    // 顺序执行意味着后面的提案能看到前面的结果：
    // [wear:连衣裙][wear:上装] 第二条会被互斥规则拒掉，这也是如实上报的一部分。
    const wearNotes = [];
    let wearChanged = false;
    if (wears.length && this.wardrobe) {
      for (const id of wears) {
        const r = this.wardrobe.applyProposal(id);
        if (r.ok && r.changed) wearChanged = true;
        wearNotes.push(r.ok
          ? (r.changed ? '已实际换上 ' + id : '本来就已经穿着 ' + id)
          : id + ' 未生效：' + r.error);
      }
      // 穿着块只在真有事发生时重建一次，不必每条提案都算一遍
      if (wearChanged) {
        this.memory.wardrobe = this.wardrobe.promptBlock();
        this.pendingCacheBreakReason = 'wardrobe_change';
      }
    }
    const wearNote = wearNotes.join('；') || null;
    this.memory.append('assistant', (clean || text)
      + (wearNote ? '\n[系统] 换装执行结果：' + wearNote : ''));
    this.track(usage);

    // Phase 0.5: 内部调节中枢更新 (模型回复产出负荷)
    if (this.internalRegulation) {
      this.internalRegulation.updateOnInteractionTurn({
        role: 'assistant',
        messageLength: (clean || text) ? (clean || text).length : 0,
        timestamp: Date.now()
      });
    }

    /* ---- 入睡联动（幂等）----
       两个入口都算数：用户明说道晚安，或她自己打出 [state:sleepy]。
       enterSleepMode 内部带守卫，重复触发不会把 sleepStartTime 刷成"刚睡"。 */
    // sleepy 只是模型表达的当下情绪，不等于用户说了晚安。
    if (sleepIntent) {
      const sleepAt = Date.now();
      if (tr) {
        tr.enterSleepMode(sleepAt);
        // 若 tracker 未绑定当前 internalRegulation，才由此处兜底更新
        if (this.internalRegulation && tr.internalRegulation !== this.internalRegulation) {
          this.internalRegulation.updateOnSleep(true, { timestamp: sleepAt });
        }
      } else if (this.internalRegulation) {
        this.internalRegulation.updateOnSleep(true, { timestamp: sleepAt });
      }
    }

    // 边界处理放在回答之后：本轮的 user+assistant 已经进了缓存
    let windowClosed = false, merged = false;
    if (this.memory.needsWindowReset() && !this.boundary) {
      // 小结要在飞一两秒，期间用户可能又聊满一个窗口。
      // 不做重入保护的话，两个快照的删除区间会互相重叠，可能吃掉尾部桥接。
      this.boundary = true;
      try {
        windowClosed = await this.closeWindow();
        // 搭在同一个时刻做，省一次缓存破坏
        if (windowClosed && this.memory.needsMemoryMerge()) {
          merged = await this.mergeMemory();
        }
      } finally {
        this.boundary = false;
      }
    }
    // 返回 wears 数组而不是单个 wear：一条回复里连发多个提案是合法的，
    // 只回一个名字就等于告诉上层"只发生过一件事"，那是撒谎。
    return { text: clean || text, state, wears, wearNote, wearChanged,
             usage, windowClosed, merged };
  }

  /** 生成本窗口小结并归档 */
  async closeWindow(opts = {}) {
    if (this._closingWindow) {
      return this._closingWindowPromise || false;
    }
    this._closingWindow = true;
    this._closingWindowPromise = this._closeWindowInternal(opts).finally(() => {
      this._closingWindow = false;
      this._closingWindowPromise = null;
    });
    return this._closingWindowPromise;
  }

  async _closeWindowInternal(opts = {}) {
    // P0-01: 若检测到 SubjectState 处于 recovery_pending 状态，先执行 Replay 自动恢复
    if (this.subjectState && this.subjectState.recoveryPending) {
      console.warn('[Brain] 检测到 subjectState 处于 recovery_pending 状态，正在执行 Replay 自动恢复...');
      const recovered = this.subjectState.recoverFromPending(this.experiencesArchive, 'state_commit_failed');
      if (!recovered) {
        console.error('[Brain] 状态恢复未完成，禁止推进当前窗口');
        return false;
      }
    }

    // 先拍快照再调 API：小结要等一两秒，这期间用户可能又发消息进来，
    const closeReason = (opts && opts.closeReason) || (this.memory.data.turnsInWindow >= this.memory.windowTurns ? 'turn_limit' : (this.memory.needsWindowReset() ? 'token_limit' : 'turn_limit'));
    const snap = this.memory.windowSnapshot({ closeReason });
    if (!snap.items.length) return false;

    // P0-2: 若当前窗口已在 Archive 中成功归档且 SubjectState 已恢复/前进，直接推进 Memory 关窗完成幂等收尾
    if (this.experiencesArchive && this.experiencesArchive.hasWindowArchive &&
        this.experiencesArchive.hasWindowArchive(snap.windowNo) &&
        (!this.subjectState || this.subjectState.currentWindowNo > snap.windowNo)) {
      console.warn(`[Brain] 窗口 #${snap.windowNo} 已经归档且状态已前进，直接推进 Memory 关窗完成幂等收尾`);
      const existing = this.experiencesArchive.getByWindow(snap.windowNo).find(r => r.recordType === 'window_summary' || r.recordType === 'window_archive' || r.type === 'window_archive');
      const p = (existing && existing.payload) || existing || {};
      const summaryText = p.rawSummaryText || (p.windowSynthesis && p.windowSynthesis.stableUserFacts && p.windowSynthesis.stableUserFacts.join('\n')) || '窗口小结已归档';
      const done = this.memory.closeWindow(summaryText, snap);
      if (done) {
        this.stats.compressions++;
        this.saveStats(true);
        this.currentWindowSnapshot = createWindowExperimentSnapshot(this.memory.data.windowNo, this.runManifest);
      }
      return done;
    }

    // 仅总结当前窗口的真实消息（排除上一窗口残留的 bridge 桥接消息）
    const activeItems = snap.activeItems || snap.items;

    // 建立 messageId 索引映射，用于 Provenance 证据强验证
    const msgMap = new Map();
    for (const m of activeItems) {
      if (m && m.messageId) msgMap.set(m.messageId, m);
    }

    /* 提炼材料要先剥掉环境块（见 memory.cleanContentForSummary）。
       只动**送给小结的文本**，历史本身不改 —— 改写已经发生过的事，
       等于偷偷改用户的记录，那是比留脏数据更糟的做法。 */
    const dialogue = activeItems.map(m => {
      const speaker = m.synthetic ? '程序触发（不是用户原话）' : (m.role === 'user' ? '用户' : '初澜');
      const idPrefix = m.messageId ? `[${m.messageId}] ` : '';
      const roundPrefix = m.roundNo ? `[第${m.roundNo}轮] ` : '';
      return `${idPrefix}${roundPrefix}${speaker}：` + this.memory.cleanContentForSummary(m.content);
    }).join('\n');

    try {
      const { text, usage, observedModel } = await this.api.complete(
        [{ role: 'system', content: SUMMARY_SYS },
         { role: 'user', content: '【对话】\n' + dialogue }],
        { maxTokens: 900, temperature: 0.2 }
      );
      this.track(usage, true, 'summary');
      if (this.shutdownRequested) return false;
      if (!text) return false;

      const summaryPromptHashes = collectPromptHashes({
        summary: SUMMARY_SYS,
        persona: PERSONA,
        creativeSkill: this.cfg.writingMode ? CREATIVE_SKILL : null,
        growth: GROWTH_SYS,
        merge: MERGE_SYS
      });

      const sourceMessageRange = {
        firstMessageId: activeItems[0] ? activeItems[0].messageId : null,
        lastMessageId: activeItems[activeItems.length - 1] ? activeItems[activeItems.length - 1].messageId : null,
        messageCount: activeItems.length
      };

      const summaryGenerationContext = buildGenerationContext({
        kind: 'summary',
        cfg: this.cfg,
        promptHashes: summaryPromptHashes,
        sampling: { maxTokens: 900, temperature: 0.2 },
        sourceWindowNo: snap.windowNo,
        sourceMessageRange,
        observedModel,
        generator: 'llm'
      });

      // 尝试解析 5×20 + Window Synthesis 结构化 JSON
      let structured = null;
      try {
        const rawJson = String(text || '').trim()
          .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(rawJson);
        if (parsed && typeof parsed === 'object') {
          structured = parsed;
          const vSummary = validateWindowSummary(structured, {
            closeReason: snap.closeReason,
            actualTurnCount: snap.actualTurnCount,
            targetTurnCount: snap.targetTurnCount
          });
          if (!vSummary.valid) {
            console.error('[Brain] Summary 数据契约校验失败 (Fail-Stop):', vSummary.reason);
            return false;
          }
        }
      } catch (parseErr) {
        // 模型或测试 mock 返回纯文本小结时优雅降级
      }

      let summaryTextForMemory = text;
      let verifiedEvidence = [];
      let rejectedEvidence = [];

      // P0-01 & P0-03: 程序仅为当前窗口的真实交互消息签发 Event (严格排除 System Prompt、Bridge 桥接、Synthetic 与内部调试)
      const events = [];
      const eventIdsSet = new Set();
      for (const m of activeItems) {
        if (!isEligibleSubjectEvent(m)) {
          continue;
        }

        const evt = createEvent({
          eventId: 'evt-' + m.messageId.replace(/^m-/, ''),
          type: 'message',
          timestamp: m.t || Date.now(),
          windowNo: snap.windowNo,
          messageId: m.messageId,
          source: m.role || 'user',
          payload: {
            content: m.content || '',
            roundNo: m.roundNo
          }
        });
        const vEvt = validateEvent(evt);
        if (vEvt.valid) {
          events.push(evt);
          eventIdsSet.add(evt.eventId);
        } else {
          console.warn('[Brain] 消息被判定为非主体事件，已过滤:', m.messageId, vEvt.reason);
        }
      }

      let observations = [];
      let interpretations = [];
      let allEvidence = [];
      let syn = {};
      let segments = [];

      if (structured) {
        syn = structured.windowSynthesis || {};
        segments = structured.segments || [];

        const userFacts = Array.isArray(syn.stableUserFacts) && syn.stableUserFacts.length > 0
          ? '用户事实：' + syn.stableUserFacts.join('；')
          : '';
        const chulanExps = Array.isArray(syn.subjectExperiences) && syn.subjectExperiences.length > 0
          ? '初澜经历：' + syn.subjectExperiences.join('；')
          : '';
        const conciseParts = [userFacts, chulanExps].filter(Boolean);
        if (conciseParts.length > 0) {
          summaryTextForMemory = conciseParts.join('\n');
        }

        // P0-02: 收集与核验 Observation (必须基于真实存在的 Event)
        if (Array.isArray(structured.observations) && structured.observations.length > 0) {
          for (const obs of structured.observations) {
            const v = validateObservation(obs, eventIdsSet);
            if (v.valid) {
              observations.push(obs);
            } else {
              console.warn('[Brain] 拒绝未经验证的 Observation (引用的 Event 不存在):', obs.observationId, v.reason);
            }
          }
        } else if (Array.isArray(segments)) {
          // 程序从 segments 中提炼 Observation，自动绑定底层真实 Events
          for (const seg of segments) {
            if (Array.isArray(seg.chulanExperience) && seg.chulanExperience.length > 0) {
              const relEvts = events.slice(0, Math.min(events.length, 20)).map(e => e.eventId);
              if (relEvts.length > 0) {
                observations.push(createObservation({
                  eventIds: relEvts,
                  type: 'interaction_segment',
                  content: seg.chulanExperience.join('；'),
                  confidence: 0.9,
                  source: 'segment_analysis'
                }));
              }
            }
          }
        }

        // 程序保底 Observation
        if (observations.length === 0 && events.length > 0) {
          observations.push(createObservation({
            eventIds: events.slice(0, 5).map(e => e.eventId),
            type: 'window_dialogue_flow',
            content: '本窗口交互流分析',
            confidence: 1.0,
            source: 'dialogue_stream'
          }));
        }

        const validObsIds = new Set(observations.map(o => o.observationId));

        // P0-02: 收集与核验 Interpretation (必须基于真实存在的 Observation)
        if (Array.isArray(structured.interpretations) && structured.interpretations.length > 0) {
          for (const interp of structured.interpretations) {
            const v = validateInterpretation(interp, validObsIds);
            if (v.valid) {
              interpretations.push(interp);
            } else {
              console.warn('[Brain] 拒绝未经验证的 Interpretation (引用的 Observation 不存在):', interp.interpretationId, v.reason);
            }
          }
        } else if (syn.subjectExperiences && syn.subjectExperiences.length > 0 && observations.length > 0) {
          interpretations.push(createInterpretation({
            observationIds: [observations[0].observationId],
            content: syn.subjectExperiences.join('；'),
            confidence: 0.8,
            perspective: 'chulan'
          }));
        }

        // 收集所有状态证据
        if (Array.isArray(segments)) {
          for (const seg of segments) {
            if (Array.isArray(seg.stateEvidence)) {
              allEvidence.push(...seg.stateEvidence);
            }
          }
        }
        if (Array.isArray(syn.stateChangesSuggested)) {
          allEvidence.push(...syn.stateChangesSuggested);
        }
      } else {
        // 纯文本降级分支
        if (events.length > 0) {
          const obs = createObservation({
            eventIds: events.slice(0, 5).map(e => e.eventId),
            type: 'plain_text_stream',
            content: '纯文本交互记录',
            confidence: 1.0,
            source: 'dialogue_stream'
          });
          observations.push(obs);
          interpretations.push(createInterpretation({
            observationIds: [obs.observationId],
            content: '对日常对话的持续感知',
            confidence: 0.5,
            perspective: 'chulan'
          }));
        }
        syn = { stableUserFacts: [text], subjectExperiences: [] };
      }

      // 执行严格 Provenance、Trait 白名单与防重核验
      let stateChanges = [];
      let explanations = [];
      let stateStaging = null;

      if (this.subjectState) {
        // P0-08: 两阶段提交——在验证与 Reducer 前创建完整暂存快照，若 Archive 失败则连同已登记指纹一并回滚
        stateStaging = this.subjectState.createStagingSnapshot();
        const verifyResult = this.subjectState.verifyEvidence(allEvidence, msgMap, snap.windowNo, { stageOnly: true });
        verifiedEvidence = verifyResult.verified;
        rejectedEvidence = verifyResult.rejected;

        const reduceResult = this.subjectState.reduce(verifiedEvidence, snap.windowNo, {
          stageOnly: true,
          canalization: this.isExperimentModuleActive('biographicalCanalization'),
          experimentModules: this.currentWindowSnapshot ? this.currentWindowSnapshot.modules : this.cfg.experimentModules
        });
        if (reduceResult && Array.isArray(reduceResult.stateChanges)) {
          stateChanges = reduceResult.stateChanges;
        }

        // P0-05 & P0-06: 为每个 StateChange 构造并核验证实解释
        for (const sc of stateChanges) {
          const rawExpl = syn.stateExplanations && syn.stateExplanations[sc.trait];
          let explInput;
          if (rawExpl && typeof rawExpl === 'object') {
            explInput = {
              claimedDelta: rawExpl.claimedDelta,
              claimedTrait: rawExpl.claimedTrait || sc.trait,
              text: rawExpl.text || rawExpl.summary || `特质 [${sc.trait}] 变动`,
              evidenceIds: rawExpl.evidenceIds || sc.evidenceIds
            };
          } else if (typeof rawExpl === 'string') {
            explInput = {
              text: rawExpl,
              claimedTrait: sc.trait,
              evidenceIds: sc.evidenceIds
            };
          } else {
            const explText = (syn.subjectExperiences && syn.subjectExperiences[0])
              || `特质 [${sc.trait}] 在第 ${snap.windowNo} 窗口增量 ${sc.delta > 0 ? '+' : ''}${sc.delta}`;
            explInput = {
              claimedDelta: sc.delta,
              claimedTrait: sc.trait,
              text: explText,
              evidenceIds: sc.evidenceIds
            };
          }
          const explanationObj = createStateChangeExplanation(sc, explInput);
          explanations.push(explanationObj);
        }
      }

      // P0-08 / P0-2: 先写入 Archive (experiences.jsonl)
      let archiveSuccess = false;
      if (this.experiencesArchive) {
        if (this.experiencesArchive.hasWindowArchive && this.experiencesArchive.hasWindowArchive(snap.windowNo)) {
          console.warn(`[Brain] 窗口 #${snap.windowNo} 经历已在 Archive 中，跳过重复写入`);
          archiveSuccess = true;
        } else {
          archiveSuccess = this.experiencesArchive.appendWindowArchive({
            windowNo: snap.windowNo,
            targetTurnCount: snap.targetTurnCount || 100,
            actualTurnCount: snap.actualTurnCount ?? snap.snapshotTurnCount,
            closeReason: snap.closeReason || 'turn_limit',
            turns: snap.actualTurnCount ?? snap.snapshotTurnCount,
            messageCount: activeItems.length,
            events,
            observations,
            interpretations,
            segments,
            windowSynthesis: syn,
            stateEvidence: allEvidence,
            verifiedEvidence,
            rejectedEvidence,
            stateChanges,
            explanations,
            rawSummaryText: text,
            generationContext: summaryGenerationContext,
            sourceMessageRange
          });
        }
      } else {
        archiveSuccess = true;
      }

      // P0-08: 失败保护：若 Archive 写入失败，绝不提交 Subject State，不删除原始消息，中止关窗
      if (!archiveSuccess) {
        console.error('[Brain] Archive 写入失败，回滚状态暂存并中止本次关窗 (保障数据一致性)');
        if (this.subjectState && stateStaging) {
          this.subjectState.rollbackStage(stateStaging);
        }
        return false;
      }

      // Archive 确认写入成功后，正式提交 Subject State 持久化 (P0-01)
      let stateCommitSuccess = true;
      if (this.subjectState) {
        stateCommitSuccess = this.subjectState.commit();
      }

      if (!stateCommitSuccess) {
        console.error('[Brain] Archive 写入成功但 Subject State commit 失败！进入 recovery_pending 状态，中止本次关窗');
        if (this.subjectState) {
          this.subjectState.recoveryPending = true;
          this.subjectState.recoveryPendingReason = 'state_commit_failed';
        }
        if (this.experiencesArchive) {
          this.experiencesArchive.appendRecord('recovery_event', snap.windowNo, {
            action: 'state_commit_failed',
            timestamp: Date.now(),
            windowNo: snap.windowNo,
            reason: 'state_commit_failed',
            recoveryPending: true
          });
        }
        // 禁止继续推进当前 Window，保留 Archive 与原始 Message，返回 false
        return false;
      }

      snap.generationContext = summaryGenerationContext;
      const done = this.memory.closeWindow(summaryTextForMemory, snap);
      if (done) {
        this.stats.compressions++;
        this.saveStats(true);
        this.pendingCacheBreakReason = 'window_boundary';

        // P0-12: 记录自我投影 (Current Self Projection) 进入因果链
        if ((this.cfg.recordSelfProjection || (opts && opts.recordSelfProjection)) &&
            this.experiencesArchive && typeof this.experiencesArchive.appendSelfProjection === 'function') {
          this.experiencesArchive.appendSelfProjection({
            windowNo: snap.windowNo,
            sourceExperienceRecords: [`win-${snap.windowNo}`],
            sourceStateChanges: stateChanges ? stateChanges.map(sc => sc.stateChangeId || sc.changeId).filter(Boolean) : [],
            projectionVersion: '1.0',
            entriesAdded: 0,
            result: {
              currentSelfText: this.selfLedger ? this.selfLedger.currentSelfText() : '',
              totalEntries: this.selfLedger ? this.selfLedger.entries.length : 0
            },
            generationContext: summaryGenerationContext
          });
        }

        // v0.9.7: 记忆痕迹动力学快照归档 (Memory Dynamics Snapshot)
        if (this.memory.engramManager && this.experiencesArchive) {
          try {
            this.experiencesArchive.append({
              recordType: 'memory_dynamics_snapshot',
              windowNo: snap.windowNo,
              payload: {
                windowNo: snap.windowNo,
                report: this.memory.lastDecayReport || null,
                snapshot: this.memory.engramManager.exportSnapshot(snap.windowNo)
              }
            });
          } catch (e) {
            console.error('[Brain] memory_dynamics_snapshot 归档失败:', e.message);
          }
        }

        // Phase 0.5: 内部调节中枢快照归档 (Internal Regulation Snapshot)
        if (this.internalRegulation && this.isExperimentModuleActive('internalRegulation')) {
          try {
            this.internalRegulation.updateOnWindowClose(snap.windowNo, {
              turnsRecorded: snap.actualTurnCount
            });
            if (this.experiencesArchive) {
              const regSnapshot = this.internalRegulation.createSnapshotRecord(snap.windowNo);
              this.experiencesArchive.append(regSnapshot);
            }
          } catch (e) {
            console.error('[Brain] internal_regulation_snapshot 归档失败:', e.message);
          }
        }

        // v0.9.7: 成本门禁式梦境系统 (Cost-Gated Dream Consolidation)
        const dreamEnabled = this.isExperimentModuleActive('sleepConsolidation');
        if (dreamEnabled && this.experiencesArchive) {
          try {
            const { computeWindowArousalTrajectory, evaluateDreamGate, extractDayResidues, buildDreamSynthesisPrompt, synthesizeDream } = require('./dream-system');
            
            // 真实唤醒度轨迹计算 (基于本窗口真实消息节奏与情绪证据)
            const arousalTrajectory = computeWindowArousalTrajectory(snap.activeItems || [], verifiedEvidence || [], segments || []);

            // 新异度计算 (基于窗口综合提取的新事实/新经历数量)
            const newFactCount = (Array.isArray(syn.stableUserFacts) ? syn.stableUserFacts.length : 0) +
                                 (Array.isArray(syn.subjectExperiences) ? syn.subjectExperiences.length : 0);
            const noveltyScore = Number(Math.min(1.0, newFactCount * 0.25).toFixed(2));
            const now = (snap && typeof snap.at === 'number') ? snap.at : Date.now();

            const gateResult = evaluateDreamGate({
              windowNo: snap.windowNo,
              arousalTrajectory,
              noveltyScore,
              stateHistory: this.subjectState ? this.subjectState.data.history : [],
              verifiedEvidence: verifiedEvidence || [],
              dreamHistory: this.dreamHistory || [],
              now
            });

            if (gateResult && gateResult.allowDream) {
              const residues = extractDayResidues(snap.activeItems || [], verifiedEvidence || []);
              const dreamPrompt = buildDreamSynthesisPrompt(residues, snap.windowNo);
              const dreamRecord = await synthesizeDream(this.api, dreamPrompt, {
                windowNo: snap.windowNo,
                sourceEventIds: (verifiedEvidence || []).map(e => e.evidenceId).filter(Boolean),
                dayResidues: residues,
                gateMetrics: gateResult.metrics,
                gateThresholds: gateResult.thresholds
              }, {
                ...(this.cfg.dreamConfig || {}),
                now
              });

              if (dreamRecord) {
                if (!Array.isArray(this.dreamHistory)) this.dreamHistory = [];
                this.dreamHistory.push(dreamRecord);
                this.experiencesArchive.append(dreamRecord);
                if (dreamRecord.usage) {
                  this.track(dreamRecord.usage, true, 'dream');
                }
              }
            }
          } catch (err) {
            console.error('[Brain] Dream consolidation failed (Fail-Safe):', err.message);
          }
        }

        if (this.cfg.selfGrowthEnabled === true)
          await this.growSelf(dialogue, summaryTextForMemory, snap.windowNo, {
            msgMap,
            sourceMessageRange
          });

        if (done) {
          // 窗口轮转成功：读取盘上可能更新的最新实验配置，并铸造新窗口的不可变实验快照
          const diskCfg = tryLoad(this.dir);
          const nextExp = diskCfg ? sanitize({
            experimentMode: diskCfg.experimentMode,
            experimentModules: diskCfg.experimentModules
          }) : {
            experimentMode: this.currentWindowSnapshot.experimentMode,
            experimentModules: this.currentWindowSnapshot.modules
          };

          this.runManifest = createExperimentRunManifest({
            experimentMode: nextExp.experimentMode,
            modules: nextExp.experimentModules,
            windowNo: this.memory.data.windowNo
          });
          this.currentWindowSnapshot = createWindowExperimentSnapshot(this.memory.data.windowNo, this.runManifest);
          this.cfg.experimentMode = this.currentWindowSnapshot.experimentMode;
          this.cfg.experimentModules = this.currentWindowSnapshot.modules;

          if (this.internalRegulation) {
            this.internalRegulation.enabled = Boolean(this.currentWindowSnapshot.modules?.internalRegulation);
          }
          if (this.memory) {
            this.memory.memoryDynamicsEnabled = Boolean(this.currentWindowSnapshot.modules?.memoryDynamics);
          }
        }
      }
      return done;
    } catch (e) {
      // 小结失败就不动历史，下个周期再试；宁可窗口超长也不能丢对话
      console.error('window summary failed:', e.message);
      return false;
    }
  }

  /** 记忆超预算：把较旧的片段合并成一条早期记忆 */
  async mergeMemory() {
    const plan = this.memory.planMerge();
    if (!plan) return false;

    const body = plan.old.map(w =>
      (w.early ? '【早期】' : '【第' + w.no + '段】') + w.text).join('\n');

    try {
      const { text, usage, observedModel } = await this.api.complete(
        [{ role: 'system', content: MERGE_SYS },
         { role: 'user', content: body }],
        { maxTokens: 400, temperature: 0.2 }
      );
      this.track(usage, true, 'merge');
      if (this.shutdownRequested) return false;
      if (!text) return false;

      const mergeGenCtx = buildGenerationContext({
        kind: 'merge',
        cfg: this.cfg,
        promptHashes: collectPromptHashes({
          merge: MERGE_SYS,
          summary: SUMMARY_SYS,
          persona: PERSONA,
          creativeSkill: this.cfg.writingMode ? CREATIVE_SKILL : null,
          growth: GROWTH_SYS
        }),
        sampling: { maxTokens: 400, temperature: 0.2 },
        observedModel,
        generator: 'llm'
      });

      this.memory.applyMerge(text, plan.keep, { generationContext: mergeGenCtx });
      this.pendingCacheBreakReason = 'memory_merge';
      this.stats.merges++;
      this.saveStats(true);
      return true;
    } catch (e) {
      console.error('memory merge failed:', e.message);
      return false;
    }
  }

  /** 低频主体成长检查点：只在窗口小结成功后调用一次。 */
  async growSelf(dialogue, summary, window, opts = {}) {
    try {
      if (this.shutdownRequested) return 0;
      const { text, usage, observedModel } = await this.api.complete(
        [{ role: 'system', content: GROWTH_SYS },
         { role: 'user', content: '【窗口小结】\n' + summary + '\n【窗口对话】\n' + dialogue }],
        { maxTokens: 420, temperature: 0.15 }
      );
      this.track(usage, true, 'growth');
      if (this.shutdownRequested) return 0;
      this.stats.growthCalls = (this.stats.growthCalls || 0) + 1;
      const raw = String(text || '').trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      const growthPromptHashes = collectPromptHashes({
        growth: GROWTH_SYS,
        summary: SUMMARY_SYS,
        persona: PERSONA,
        creativeSkill: this.cfg.writingMode ? CREATIVE_SKILL : null,
        merge: MERGE_SYS
      });

      const growthGenCtx = buildGenerationContext({
        kind: 'growth',
        cfg: this.cfg,
        promptHashes: growthPromptHashes,
        sampling: { maxTokens: 420, temperature: 0.15 },
        sourceWindowNo: window,
        sourceMessageRange: opts.sourceMessageRange || null,
        observedModel,
        generator: 'llm'
      });

      const rejected = [];
      const appendMeta = {
        window,
        generation: growthGenCtx,
        rejected
      };
      if (opts.msgMap) {
        appendMeta.verify = {
          msgMap: opts.msgMap,
          windowNo: window
        };
      }

      const added = this.selfLedger.append(JSON.parse(raw), appendMeta);
      if (added > 0 && this.experiencesArchive && typeof this.experiencesArchive.appendSelfProjection === 'function') {
        this.experiencesArchive.appendSelfProjection({
          windowNo: window,
          sourceExperienceRecords: [`win-${window}`],
          sourceStateChanges: [],
          projectionVersion: '1.0',
          entriesAdded: added,
          result: {
            currentSelfText: this.selfLedger.currentSelfText(),
            totalEntries: this.selfLedger.entries.length
          },
          generationContext: growthGenCtx,
          rejectedEvidence: rejected
        });
      }
      this.saveStats();
      return added;
    } catch (e) {
      // 成长提炼失败不能影响已经成功归档的对话窗口；下一个窗口继续尝试。
      // 非 JSON 的兼容模型响应属于“本轮没有形成可验证成长记录”，不刷屏；
      // 网络/文件等真正异常仍保留日志，便于定位。
      if (!(e instanceof SyntaxError))
        console.error('self growth checkpoint failed:', e.message);
      return 0;
    }
  }

  /**
   * summary=true 时只累计花费，不计入命中率。
   * 小结/合并是另一套前缀，混进主线会让命中率的数字失真。
   */
  track(usage, summary = false, bucket = summary ? 'summary' : 'chat') {
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens || 0;
    const out = usage.completion_tokens || 0;
    const price = isPeakHour() ? this.cfg.price.peak : this.cfg.price.valley;
    const c = costOf(usage, price);
    const hitRateRatio = (hit + miss) ? hit / (hit + miss) : 0;

    let breakReason = null;
    if (bucket === 'chat') {
      if (miss > 0) {
        breakReason = this.pendingCacheBreakReason || (hit === 0 ? 'unknown' : null);
        this.pendingCacheBreakReason = null;
      }
    }

    this.appendTelemetry({
      timestamp: Date.now(),
      windowNo: this.memory ? this.memory.data.windowNo : 1,
      requestType: bucket,
      promptTokens: usage.prompt_tokens || hit + miss,
      promptCacheHitTokens: hit,
      promptCacheMissTokens: miss,
      completionTokens: out,
      cacheHitRate: +(hitRateRatio.toFixed(4)),
      cacheBreakReason: breakReason
    });

    this.stats.history.push({
      t: Date.now(), hit, miss, out, cost: +c.toFixed(6),
      rate: (hit + miss) ? +(hit / (hit + miss) * 100).toFixed(1) : 0,
      kind: bucket,
      prompt: usage.prompt_tokens || hit + miss
    });
    if (this.stats.history.length > 300) this.stats.history.shift();

    this.stats.cost += c;
    if (summary) {
      this.stats.summaryCalls = (this.stats.summaryCalls || 0) + 1;
      this.stats[bucket + 'PromptTokens'] = (this.stats[bucket + 'PromptTokens'] || 0)
        + (usage.prompt_tokens || hit + miss);
      this.stats[bucket + 'OutputTokens'] = (this.stats[bucket + 'OutputTokens'] || 0) + out;
      this.stats[bucket + 'Cost'] = (this.stats[bucket + 'Cost'] || 0) + c;
    } else {
      this.stats.requests++;
      this.stats.hit += hit;
      this.stats.miss += miss;
      this.stats.out += out;
      this.stats.lastHitRate = (hit + miss) ? hit / (hit + miss) : 0;
    }
    this.saveStats();
  }

  report() {
    const tot = this.stats.hit + this.stats.miss;
    const m = this.memory;
    return {
      requests: this.stats.requests,
      hit: this.stats.hit,
      miss: this.stats.miss,
      out: this.stats.out,
      rate: tot ? +(this.stats.hit / tot * 100).toFixed(1) : 0,
      lastRate: +(this.stats.lastHitRate * 100).toFixed(1),
      cost: +this.stats.cost.toFixed(4),
      compressions: this.stats.compressions,
      merges: this.stats.merges || 0,
      growthCalls: this.stats.growthCalls || 0,
      growthPromptTokens: this.stats.growthPromptTokens || 0,
      growthOutputTokens: this.stats.growthOutputTokens || 0,
      growthCost: +(this.stats.growthCost || 0).toFixed(4),
      summaryCost: +(this.stats.summaryCost || 0).toFixed(4),
      mergeCost: +(this.stats.mergeCost || 0).toFixed(4),
      peak: isPeakHour(),
      model: this.cfg.model,

      // 记忆状态
      windowTurns: m.data.turnsInWindow,
      windowTarget: m.windowTurns,
      windowNo: m.data.windowNo,
      totalTurns: m.data.totalTurns,
      historyLen: m.history.length,
      historyTokens: m.historyTokens(),
      segments: m.windows.length,
      memoryTokens: m.memoryTokens(),
      memoryCap: m.memoryCap,
      contextTokens: m.contextTokens(),
      selfLedgerEntries: this.selfLedger.entries.length,
      rawLedgerChars: this.selfLedger.estimatedRawChars(),
      currentSelfTokens: Math.ceil(this.selfLedger.currentSelfText().length / 2),
      birthAt: this.birthAt,
      archiveStatus: this.selfLedger.status,
      subjectState: this.subjectState ? this.subjectState.values : null,
      archiveEntries: this.experiencesArchive ? this.experiencesArchive.count() : 0,
      bridgeCount: m.history.filter(x => x.bridge).length
    };
  }

  clearMemory() { this.memory.reset(); }

  listSelfLedger() { return this.selfLedger.list(); }
}

module.exports = { Brain, parseState, parseWear, STATES };
