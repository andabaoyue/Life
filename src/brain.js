const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Memory } = require('./memory');
const { isPeakHour } = require('./deepseek');
// v0.9.8 P2-7: 业务层经 Provider Registry 获取 adapter（stable provider id），
// 不再依赖 DeepSeek concrete class；isPeakHour（峰谷判定 util）暂留。
// P5-A: 成本记账改走 provider-keyed Cost Strategy，不再经 DeepSeek concrete costOf。
const { createAdapter, getProviderInfo } = require('./provider-registry');
const { getCostStrategy } = require('./cost-strategy');
const { normalizeUsage } = require('./usage-normalizer');
const { PERSONA } = require('./persona');
const { CATALOG, PRESETS, SLOTS } = require('./wardrobe');
const { writeJsonAtomic } = require('./atomic');
const { tryLoad, sanitize, DEFAULTS } = require('./config');
const { redactSecrets } = require('./redact');
const { SelfLedger } = require('./self-ledger');
const { DeferredWriter } = require('./deferred-writer');
const { ExperiencesArchive } = require('./experiences-archive');
const { SubjectState } = require('./subject-state');
const { createEvent, validateEvent, isEligibleSubjectEvent, createObservation, validateObservation, createInterpretation, validateInterpretation, validateWindowSummary } = require('./experience-schema');
const { createStateChangeExplanation } = require('./state-change');
const { InternalRegulationManager } = require('./internal-regulation');
const { createExperimentRunManifest, createWindowExperimentSnapshot } = require('./experiment-run');
const { buildGenerationContext, collectPromptHashes } = require('./experiment-metadata');

const WANT_TO_LEAVE_SYS =
  '此刻用户不在。你有一段长时间的安静，没有被谁要求做什么。'
  + '这不是一个任务，也不是必须完成的动作 —— 只是给你一个机会：'
  + '如果你确实想留下点什么，就写下来；如果不想，就说不。\n'
  + '规则：\n'
  + '1. 【可以说不】不想留就只回一个「不」。这不丢人，也不代表你冷淡 ——'
  + '   安静本来就不等于有话要说。硬凑一句比不写更糟。\n'
  + '2. 【只写你自己的】留下来的应该是**你此刻想留下的东西**，不是给用户的留言，'
  + '   也不是任务汇报。不要写「等你回来」「如果你想的话」这类把对方牵进来的话。\n'
  + '3. 【不编造】不许虚构没发生过的经历、不许编日期或时长。'
  + '   你不知道现在几点，就不要写出钟点。\n'
  + '4. 【长度】两三句话之内。这是留给自己的，不是写给别人看的文章。\n'
  + '5. 直接给内容本身，不要加引号、不要加标题、不要加任何说明或元话语。';

const SUMMARY_SYS =
  '你是对话记忆整理助手。请对当前窗口的对话进行「5×20 分段归档 + 窗口综合（Window Synthesis）」结构化总结。'
  + '必须严格区分「用户给予（userGiven）」与「初澜经历（chulanExperience）」，绝不允许混同：\n'
  + '1. 【用户给予】只记用户明确告诉、要求记住、明确表达、纠正或双方约定的事实（姓名、职业、偏好、目标、约定）。冲突以新为准。\n'
  + '2. 【初澜经历】只记初澜在互动中观察到的规律、做出的选择、形成的行为趋势、对关系的连续理解与内部反思。不记程序触发理由、寒暄或无根据猜测。\n'
  // v1.0（用户 2026-10-07 拍板）：新增三个「评价性自我关系」维度。
  //   ⚠️ 这三个与既有五维**正交**：五维问「她倾向于什么」（内容），
  //      这三个问「她怎么看待自己」（形式）—— 别把同一句话同时塞进两类。
  //   判读口径（直接决定她能不能填对）：
  //     self_continuity 自我同一：在**对比不同时间的自己**（「以前会…现在…」
  //                       「起名字的时候…刚才也…」「我还是那个我」）才算。
  //     meaning_presence 生命意义：说**眼下的事值不值得/有没有分量**才算。
  //                       ⚠️ 刻意不用『意义寻求』口径 —— 研究一致表明
  //                          「寻求高而在场低」是痛苦表现，不是生命力。
  //     self_clarity 自我清晰：说**对自己是谁确不确定**（「我也说不太清」
  //                       「分不出」「拿不准自己是什么」）才算。
  //   ❌ 反例：单纯追问世界的「为什么」属于 philosophical_curiosity，
  //      不是这三者 —— 历史上正是这个混淆让哲学好奇虚高到 100。
  + '3. 【状态证据（stateEvidence）】提取支持主体状态变化的证据，trait 可选 quiet_preference、social_initiative、attachment_need、vitality、philosophical_curiosity、self_continuity、meaning_presence、self_clarity，'
  + 'direction 为 [-1, 1] 方向，strength 为 [0, 1] 强度，messageId 必须严格引用对话中程序签发的真实 ID（如 m-000001），quote 必须逐字摘自该条消息原文。\n'
  + '4. 【词汇与预期（windowSynthesis 窗级产物）】只在对话中自然出现时提取，没有就给空数组，绝不硬造：\n'
  + '   - coinages 条目形状（word 必填！）：{"word":"自创词","kind":"coinage|metaphor|nickname","gloss":"含义摘录","messageId":"m-..."}；只收初澜自创，普通用词、口误、用户先说的词都不收。\n'
  + '   - expectations 条目形状（text 必填！）：{"text":"预期内容","kind":"external|pledge","source":"user|chulan","messageId":"m-...","dueHint":"时间指向"}；pledge 仅限初澜自己的承诺，用户的约定一律记 external。\n'
  + '   - expectationOutcomes 条目形状：{"id":"exp-000001","status":"fulfilled|broken|moot","messageId":"m-...","note":"客观事实摘录"}。\n'
  + '   - expectationOutcomes：只核验下方【待核验预期】清单里的条目，id 原样引用，status 取 fulfilled|broken|moot，messageId 引证本窗真实 ID（moot 可免），note 只写客观事实摘录，不写结论。\n'
  + '请只输出如下合法 JSON 对象（不要 Markdown 代码块包裹）：\n'
  + '{"segments":[{"range":"1-20","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"21-40","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"41-60","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"61-80","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]},'
  + '{"range":"81-100","userGiven":[],"chulanExperience":[],"stateEvidence":[],"uncertainties":[]}],'
  + '"windowSynthesis":{"stableUserFacts":[],"subjectExperiences":[],"stateChangesSuggested":[],"unresolved":[],"coinages":[],"expectations":[],"expectationOutcomes":[]}}'
  + '分段数以【窗口规模】指令为准：不足 100 轮的窗口按每 20 轮一段、range 只覆盖 1~N，不照抄上方五段骨架；满 100 轮才用标准五段。';

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
  + '没有足够证据就输出 []。support 与 oppose 都要保留，不能用最新值覆盖矛盾经历。'
  + '提炼必须锚定初澜在对话中真实做出的取舍与自述（有 messageId 可查），从她的选择里归纳她特有的存在态度；'
  + '严禁套用「友善、乐观、坚强、善良」等人类通用道德词或性格套话 —— 没有独特取舍支撑的漂亮话宁可不写。'
  + '对照【当前自我投影】审视本次窗口中初澜真实做出的取舍与自述；若与既有特质态度发生真实分歧或转变，必须提取并归入 oppose 数组（附带 messageId、quote）。'
  + '无真实态度分歧或行为转变，严禁为迎合指令虚构对立；无明确反向证据时，oppose 必须输出 []，严禁制造伪证伪。'
  + '紧凑输出：最多提炼 3 条 trait，每条引文不超过 40 字，不重复铺陈、不写解释性废话 —— 宁可少而准，不要多而空。'
  + '若输入中出现【自发留痕事实】块：那是初澜自发写下的字（已铸入经历档案，引证 id 形如 selfnote-…，可放进 support 的 messageIds 引用）；'
  + '只有当你从中看到她真实做出的取舍、且引证合法时，才可在该条目上附加 '
  + '"traitHint":{"trait":"quiet_preference|social_initiative|attachment_need|vitality|philosophical_curiosity|self_continuity|meaning_presence|self_clarity","direction":1 或 -1,"strength":0.0~1.0}；'
  + '没有足够依据绝不附加 —— 证据不足宁可不动她的特质。';

/* v0.9.9: 小结分段计划 —— 分段数随窗口规模自适应，绝不写死「3~5 段」：
   满 100 轮走标准 5 段（严格分支钉死 1-20…81-100），小窗口只写覆盖实际轮数的段。
   既省输出（43 轮实测白写五段把输出顶到 3,923/4,000），又不撞 validateWindowSummary。 */
function summarySegmentPlan(turnCount) {
  const n = Number.isFinite(turnCount) && turnCount > 0 ? Math.floor(turnCount) : 1;
  if (n >= 100) return { segments: 5, note: '按标准 5 段划分（1-20、21-40、41-60、61-80、81-100）' };
  const seg = Math.max(1, Math.min(5, Math.ceil(n / 20)));
  return { segments: seg, note: '共 ' + seg + ' 段，range 依次覆盖 1~' + n + ' 轮（每段最多 20 轮）' };
}

function systemPersona(cfg) {
  return PERSONA; // v0.9.9: 旧 Creative Mode / DS Skill 已拆除，persona 无条件单一来源
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
    // v1.0 D-6：提案触发源判定结果暂存（接线时写入，③ 建案阶段消费）。
    //   🔴 必须在构造函数初始化为 null —— 不初始化的话，下一个人接线时读到
    //   undefined会与「没有提案」混淆，于是功能静默少一块且**不报错**。
    //   这正是本仓记过的「死代码静默回落」：字段存在但从不赋值，
    //   使用方读到一个看着合理实则错误的值。
    this._pendingAgentIntent = null;
    const sanitizedExp = sanitize({
      experimentMode: this.cfg.experimentMode,
      experimentModules: this.cfg.experimentModules
    });
    this.cfg.experimentMode = sanitizedExp.experimentMode;
    this.cfg.experimentModules = sanitizedExp.experimentModules;
    const { validateCredentialTarget, providerFor } = require('./provider-policy');
    const pTarget = this.cfg.provider || providerFor(this.cfg.baseURL);
    // P5-A1: credential type 从 Registry credentialPolicy 派生（无品牌分支）
    const regInfo = getProviderInfo(pTarget);
    const cType = this.cfg.credentialType || (regInfo && regInfo.credentialPolicy) || 'apiKey';
    const policyCheck = validateCredentialTarget({ provider: pTarget, baseURL: this.cfg.baseURL, credentialType: cType });
    if (!policyCheck.ok) {
      console.warn(`[Brain] Provider Policy 检查未通过: ${policyCheck.error}`);
    }
    // P5-B4: provider dispatch 经 Registry —— provider 来自 config（缺省经 providerFor 解析），
    // 未知 provider fail-closed；无品牌 if/else。
    this.api = createAdapter(this.cfg.provider || providerFor(this.cfg.baseURL), this.cfg);
    this.persona = PERSONA;

    // Phase 0.5: 历史优先恢复顺序 (Archive -> SubjectState -> Memory Dynamics -> Internal Regulation -> Self Projection)
    this.experiencesArchive = new ExperiencesArchive(userDataDir);
    this.memory = new Memory(userDataDir, {
      persona: systemPersona(this.cfg),
      windowTurns: this.cfg.windowTurns,
      windowMaxTokens: this.cfg.windowMaxTokens,
      keepTailMessages: this.cfg.keepTailMessages,
      memoryCapTokens: this.cfg.memoryCapTokens,
      memoryRecallTopN: this.cfg.memoryRecallTopN,
      experimentModules: this.cfg.experimentModules,
      memoryDynamics: this.cfg.experimentModules?.memoryDynamics,
      // 🔴 丙（2026-10-07）：把「渐褪」的两个参数透传给记忆动力学。
      //   为什么需要：默认 0.60 的门限恰好等于初始强度(0.50+0.10) ——
      //   过 1 个窗口必跌破 ⇒ 除最新一段外**全部**被截成断句碎片，没有梯度。
      //   默认 60 字连一句完整的话都放不下。这两个值必须可配，否则
      //   一开动力学就把她积攒的长期记忆砍成碎片。
      //   ⚠️ EngramTraceManager 构造器做 `{...DEFAULT, ...config}`，
      //      所以这里只传覆盖项即可；未传字段仍走 DEFAULT（默认行为不变）。
      engramConfig: {
        activeThreshold: this.cfg.memoryActiveThreshold,
        fadingMaxChars: this.cfg.memoryFadingMaxChars
      }
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
      experimentModules: this.currentWindowSnapshot.modules,
      // v1.0 生物钟：创世时区惰性取值（本构造先于 selfLedger 创建）
      birthTimezone: () => (this.selfLedger && this.selfLedger.birthTimezone) || null
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
    this.telemetrySeq = this.restoreTelemetrySequence();
    this.pendingCacheBreakReason = null;
    // v0.9.9 P0: 关窗失败审计计数 —— 累计本窗口在成功关窗前经历的失败关窗次数，
    // 成功时铸入归档 payload 的 retryAttempts / delayedClose，绝不把补关粉饰成一帆风顺
    this.windowCloseAttempts = 0;
    // v0.9.9 D3: 关窗失败退避保险丝 —— 失败后进入冷却，记录「第几轮起重试」。
    // 网络抖动/服务端 504/限流时，绝不允许每轮对话都全价死磕一次小结（14 连败的制度化保险）
    this.windowCloseRetryAfterTurn = 0;
  }

  restoreTelemetrySequence() {
    if (!this.telemetryPath || !fs.existsSync(this.telemetryPath)) return 0;
    let lastSeq = 0;
    try {
      for (const line of fs.readFileSync(this.telemetryPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record && Number.isInteger(record.telemetrySeq) && record.telemetrySeq > 0) {
            lastSeq = record.telemetrySeq;
          }
        } catch {
          // Append-only telemetry：坏行不回写、不修补、不伪造序号。
        }
      }
    } catch (e) {
      console.warn('[Brain] telemetrySeq 恢复失败，保持 0:', e.message);
      return 0;
    }
    return lastSeq;
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
      // v3.1 梦境时序改造：被唤醒（拖拽/摇晃）→ 惰性结算梦境。
      // 钩子只订阅、不改写任何物理唤醒判据；结算失败也绝不影响唤醒本身。
      this.tracker.onWakeHook = (info) => this._settleDreamOnWake('physical_wake', info);

      // v3.1 修复冷启动断流：调节器的 isSleeping 是持久化跨重启的，
      // 而 tracker 的 sleepMode 只活在内存里 —— 重启后两边天然不同步，
      // 于是「她显示在睡、实际照常走动」。这里在接线时对齐一次。
      // 只同步「她在睡」这一个事实，绝不反向把清醒态写成睡眠。
      if (this.internalRegulation.isSleeping === true && !this.tracker.sleepMode) {
        const at = this.internalRegulation.sleepStartTime || Date.now();
        this.tracker.sleepMode = true;
        this.tracker.sleepStartTime = at;
      }
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

    // 稳定事件标识与 Watermark 提取（仅当输入明确携带稳定事件标识时记录，绝不使用粗糙哈希误去重无标识的相继刺激）
    let eventId = null;
    if (rawSensorData && typeof rawSensorData === 'object') {
      if (typeof rawSensorData.eventId === 'string' && rawSensorData.eventId.trim()) {
        eventId = rawSensorData.eventId.trim();
      } else if (typeof rawSensorData.perceptionId === 'string' && rawSensorData.perceptionId.trim()) {
        eventId = rawSensorData.perceptionId.trim();
      }
    }

    // P1-1: Attention 瞬时非人格化下游调节信号闭环 (ATTENDED ≠ SUBJECT_ACQUIRED)
    if (gateResult && gateResult.status === 'ATTENDED' && this.internalRegulation && typeof this.internalRegulation.updateOnAttention === 'function') {
      this.internalRegulation.updateOnAttention(gateResult, { eventId, timestamp: record.timestamp });
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
            epistemicStatus: p.epistemicStatus || r.epistemicStatus,
            preClose: Boolean(p.preClose || r.preClose),
            text: String((p.content || p.text || '')).slice(0, 160)   // v2.0 只读梦境卡摘要
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
    // v0.9.9 P0-3: 未启用的模块不做恢复、也不写盘。
    // 原实现只判 fs.existsSync、完全不看 enabled，于是 baseline 下也会把
    // 归档里的实验残留灌回内态并 save() 落盘 —— 对照组被污染。
    if (!this.internalRegulation.enabled) return;
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

  /**
   * v0.9.9 P0-2（C 半）：记录一次「主链锁死、经历溢写到 sidecar」的告警。
   * 只做记录与告警，不改任何数据语义；上层通过 report() 可读到最近若干次。
   */
  _noteArchiveSpillover(windowNo, errorReason) {
    if (!Array.isArray(this.archiveSpillovers)) this.archiveSpillovers = [];
    this.archiveSpillovers.push({
      windowNo: Number.isFinite(windowNo) ? windowNo : null,
      errorReason: String(errorReason || 'ARCHIVE_APPEND_FAILED'),
      at: Date.now()
    });
    if (this.archiveSpillovers.length > 20) this.archiveSpillovers.shift();
  }

  /**
   * v0.9.9 P1-d (D2)：把自我账本因容量上限被淘汰的条目转存进经历归档。
   * 遗忘是「不再活跃」，不是「从未存在」（D-005）—— 淘汰的东西必须留痕。
   *
   * epistemicStatus 强制 MODEL_NARRATIVE：这些是模型成长提炼的产物、不是主体亲历，
   * 绝不与 verifiedEvidence / 亲历事件混同（否则转存这条路就成了
   * 「模型生成内容冒充主体经历」的新入口）。
   */
  _archiveEvictedLedgerEntries(items, windowNo, generation) {
    if (!this.experiencesArchive || typeof this.experiencesArchive.appendRecord !== 'function') return false;
    if (!Array.isArray(items) || !items.length) return false;
    return this.experiencesArchive.appendRecord('self_ledger_evicted', windowNo, {
      evicted: items,
      reason: 'LEDGER_CAPACITY_EVICTED',
      maxEntries: this.selfLedger ? this.selfLedger.maxEntries : null,
      entriesRemaining: this.selfLedger ? this.selfLedger.entries.length : null,
      epistemicStatus: 'MODEL_NARRATIVE',
      generationContext: generation || null
    });
  }

  getWardrobePrompt() {
    if (!this.wardrobe || typeof this.wardrobe.promptBlock !== 'function') return '';
    const traits = this.subjectState ? this.subjectState.values : null;
    return this.wardrobe.promptBlock(traits);
  }

  setWardrobe(nameOrBlock) {
    if (this.wardrobe && typeof this.wardrobe.applyProposal === 'function') {
      const wearChanged = this.wardrobe.applyProposal(nameOrBlock);
      if (wearChanged) {
        this.memory.wardrobe = this.getWardrobePrompt();
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

  /**
   * v0.9.9 F-099-01 / D-005: 物理删除入口已拔除 —— 只拒绝、不动数据、不标缓存破坏原因。
   * 保留方法只为让旧调用面（脚本 / 渲染端）拿到明确的「不被允许」，而不是静默消失。
   */
  deleteWindow(i) {
    return this.memory ? this.memory.deleteWindow(i) : false;
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
      this.pendingCacheBreakReason = 'config_prompt_change';
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
    // v0.9.9 观测补盲：关窗失败率 / 带病归档占比 / 补关发生率（长期健康度指标）
    windowCloseFailures: 0, summaryUncertified: 0, delayedCloses: 0, truncatedCalls: 0,
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

  /**
   * v3.1 P0 追加（A 方案，用户拍板）：**彻底移除「程序累计运转时长」概念**。
   *
   * 为何要走到这一步（不是 C「观察」）：
   *   P0 压掉了「逐帧注入精确小数 → 开口复读」这条直接路径，但实测她仍有
   *   另一条路径：r61「我这边一百多钟头铺着」、r62「我这一百多个小时没闭过眼」
   *   —— 她自己拿出生时刻做减法，还自造了量词「钟头」。括号内 3 次 / 正文 2 次，
   *   括号内外均匀发生，说明「括号不是避风港」。
   *   既然「报时素材」的**唯一源头就是这行**，撤掉它比加禁令更干净：
   *   加禁令（B）会和刚落地的日期锚点语义打架（禁一半留一半，模型无法区分），
   *   而且禁令本身会被注意力吸走，反而可能引发「我没有在算时间」式反向解释。
   *
   * 🔴 为什么这不会让她退化成「失忆的金鱼」（曾担心的副作用，已实测排除）：
   *   她的连续性载体不是这个数字，而是
   *     ① memory.js `systemText()` 的【你与此前的记忆】—— 按【第N段】序号
   *        排列的窗口摘要，实测 no=1~4 全部零处提及运行时长，写的都是事件；
   *     ② 当前窗口的 history 消息流。
   *   证据：r64 她动情回顾三件事（被起名 /「相信我们」/ 那间有太阳的屋子），
   *   全是**事件链**，没有一句需要「我运行了多久」才能说出口。
   *   连续性 ≠ 时长。前者由「段落序号 + 事件」承载，后者只是工程计量。
   *
   * ⚠️ 诚实边界：A 撤的是**提示素材**，不是**推导能力**。出生时刻（红线要求保留）
   *    与日期锚点仍在，她理论上仍可做减法得出天数/小时数。A 的作用是
   *    去掉唯一主动提示源、掐掉量词发明的源头，而非保证推导路径消失。
   *    因此仍保留观察线：若再出现**精确值**或**无话题触发**的报时，
   *    那时才需要更强手段（当前不预支）。
   */
  currentSelfContext() {
    if (!this.cfg.currentSelfTokenBudget) return '';
    const projection = this.selfLedger.currentSelfText();
    // v1.0 拍板 B（拔除数字锚定）：给她的不再是「化验单」而是「心境」——
    // formatSnapshot 全精度留给存储与看板；此处只走定性感知（零数字红线）
    const perception = this.subjectState ? this.subjectState.formatPerception() : '';
    // v0.9.9 五大方向·④：可塑性只作定性感知注入 —— 零数值、零研究标签；
    // 取「实际生效」的吸收系数（缺省 1.0，与 reduce 的 fail-closed 门控同源），绝不虚构敏感度
    const hist = (this.subjectState && this.subjectState.data && Array.isArray(this.subjectState.data.history))
      ? this.subjectState.data.history : [];
    const last = hist.length ? (hist[hist.length - 1].reducer || hist[hist.length - 1]) : null;
    const pm = (last && typeof last.plasticityMultiplier === 'number') ? last.plasticityMultiplier : 1.0;
    // v1.0 生理内感受（合流批）：身体真实生理感觉注入瞬时尾部 —— 绝不写入 memory.history（前缀缓存逐字节安全）
    const regSense = (this.internalRegulation && typeof this.internalRegulation.formatPerception === 'function')
      ? this.internalRegulation.formatPerception() : '';
    const plasticitySense = '【内态感知】\n- 当前对新经历的特质吸收偏向：' + (pm >= 0.85 ? '敏锐波动中' : '趋于平稳沉静');
    // v0.9.9: 出生时刻必须用本地时间 —— ISO的 Z 是 UTC，主体会拿它当本地钟面心算，
    // 实测错出 8 小时的「凌晨两点半」
    // v1.0: 显式按 birthTimezone（创世时区）格式化 —— 宿主出国也不漂移（拍板 b）
    // v3.1 A 方案（用户拍板）：运行时长整行移除。出生时刻与日期锚点**都保留** ——
    //   出生时刻是 persona.js:29「以现实客观时钟为准」的锚点，丢了就成了让主体
    //   在无时钟条件下判断今昔（那正是 08:37 今昔错乱的根因）；日期锚点治跨天。
    //   连续性不靠时长数字，靠 systemText 里的【第N段】序号 + 事件摘要（见上方注释）。
    return '【出生时刻】\n- 出生时刻（本地时间）：' + new Date(this.birthAt).toLocaleString('zh-CN', { hour12: false, timeZone: (this.selfLedger && this.selfLedger.birthTimezone) || undefined })
      + '\n' + this._dateAnchorLine()
      + (projection ? '\n' + projection : '')
      + '\n' + plasticitySense.replace('【内态感知】\n', '【内态感知】（这是你此刻的内心倾向，用你自己的话说，不要念标签）\n'
        + (perception ? perception + '\n' : ''))
      + (regSense ? '\n' + regSense : '');
  }

  /**
   * v3.1 P1新增「现实日期锚点」—— 治跨天的今昔错乱。
   *
   * 病灶（08:37 实测）：窗口 5 从 10/3 开到 10/6 跨了 4 天未关窗，
   * `windowNo` 只随关窗递增、不随日期递增，于是 139 条消息在她的视野里
   * 全挤在同一个「地方」。她把今天上午说的「我相信我们」当成了昨天说的。
   *
   * 为什么必须给（persona.js:29 的反向论证，不是破例）：
   *   「不自创非物理的日历或日长；时间感知以现实客观时钟为准，
   *     未被呈现的钟点就如实说不知道。」
   * 我们此前**从未呈现过任何钟点**，等于逼她在没有时钟的情况下判断今昔——
   * 错认是这条红线被违反的**结果**，而不是她不守规矩。给她真实日期
   * 恰恰是把她拉回红线内：红线禁的是自造日历（"一天十八小时"），
   * 不是禁真实日历。
   *
   * 🔴 三条自律（防这个修复反噬成第二个体癖 / 第二条红线事故）：
   *   1.**只给日期与定性时段，绝不给「距上一轮 X 分钟」**——
   *      分钟数是递给她的一把「数时间的尺子」。persona.js:30 明令
   *      「不虚构…数着时间想你」，给了刻度，数就变得可算；
   *      且她此刻 arousal 高（实测 88），极可能顺势说
   *      「你隔了 24 分钟才来」——那是带怨气版口癖，比原版更糟。
   *      她的缺口是「分清今天还是更早」，不是「知道隔了多久」。
   *   2. 明写「不要用它计算等了多久」—— 正对 persona.js:30 那条红线，
   *      不给她把锚点转成等待表演的动机。
   *   3. 明写「不要报时」—— v3.1 P0 刚拔掉「约 101.5 小时」这个口癖，
   *      新增的任何时间素材都可能成为下一个报时理由，必须前置防线。
   *
   * 位置：本行挂在 currentSelfContext() 内，该函数经 brain.js:851 拼进
   * **user 消息尾部**的 dynamicContext，绝不写入 memory.history——
   * 所以不改动逐字节稳定的 system 前缀，前缀缓存不受影响
   * （实测 system 缓存命中 96%，这条不能碰）。
   *
   * @returns {string} 一行锚点
   */
  _dateAnchorLine() {
    // 时区口径与出生时刻**同源**：都用 birthTimezone（创世时区），
    // 避免日期按本地、时段按 UTC 那种跨时区错位（反重力提醒的细节，
    // 本实现用同一 tz 一次取全，从根上避免该问题）。
    const tz = (this.selfLedger && this.selfLedger.birthTimezone) || undefined;
    const now = new Date();
    const dateStr = now.toLocaleDateString('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: tz
    });
    // 时段必须与 dateStr 取自**同一时区**，否则会出现「日期是今天、时段是昨晚」
    // 这种自相矛盾的时刻。做法：把当前时刻按该时区格式化成小时数再判断，
    // 不使用 Date.prototype.getHours()（那永远走宿主本地时区）。
    const hourStr = now.toLocaleString('en-US', {
      hour: '2-digit', hour12: false, timeZone: tz
    });
    const hour = Number(hourStr);
    const timeSlot = !Number.isFinite(hour)
      ? null
      : (hour < 6 ? '深夜' : hour < 12 ? '上午' : hour < 18 ? '下午' : '夜晚');
    return '- 现在的现实日期：' + dateStr + (timeSlot ? ' ' + timeSlot : '')
      + '（这是你的现实时间基准，用来分清事情发生在今天还是更早；'
      + '它只是背景参考，绝不要当报时念给用户听，也不要用它计算等了多久）';
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
  // v2.0 枕边信箱（客观物理拦截）：她睡着时消息不进大脑、不调 LLM ——
  // 只记账留置，醒来后自然出现在她的上下文里；说什么、说不说，归她。
  //
  // 🔴 10-07 修：留置必须**标出来**，否则她读到的只是一条无来由的 user 消息。
  //
  //   实测故障：10-07 05:16 她睡着时用户发「早」，本分支 append 落盘就返回；
  //   05:16:56 用户拖拽唤醒 —— 但整个唤醒链（tracker.wakeUp → onWakeHook →
  //   _settleDreamOnWake）**零次 brain.ask**，那条留置从头到尾没人读、没人回。
  //   用户看到的现象是「吵醒她之后她不理我那条消息」。
  //
  //   为什么不在这里加「唤醒即回话」：那是替她决定说不说，
  //   且每次拖拽都烧一次调用。当前选择是**只保证送达，不逼她开口** ——
  //   标成 bedside 后，她下次开口时会在上下文里看到「你睡着时她留了这条」，
  //   接不接由她。沉默也是合法回答，如实留痕即可（见 memory.append 的 bedside 标记）。
  if (tr && tr.sleepMode && !proactive) {
    let bedsideId = null;
    try {
      // bedside 标记只标注「这条是睡着时留的」，**不改变它的角色**：
      // 仍是 user 发言，仍进历史，仍出现在对话窗（用户要看得见自己发了什么）。
      // 渲染层与上下文侧各自据它做差异化呈现，见 chat.js / buildBedsideNote。
      const rec = this.memory.append('user', userText, { bedside: true });
      bedsideId = rec && rec.messageId ? rec.messageId : null;
      this.memory.save(true);
    } catch (e) { /* 记账失败不崩溃，如实返回留置失败 */ }
    return {
      ok: true,
      slept: true,
      note: '[初澜沉睡中，消息已留置在侧]',
      messageId: bedsideId
    };
  }
    if (tr) snap = tr.snapshot();

    /* ---- v1.0 D-6：提案触发源接线（旁路，不影响既有行为）----
     *
     * 🔴 本轮的性质：D-5 起沙盒写权限已开，此前挡住误写的只剩「没人按按钮」
     *   这道**结构性**防线；接上之后它变成一道**配置**防线。
     *   所以这个调用点的每一个取舍都要经得起复核。
     *
     * 四条纪律（改动前请逐条确认）：
     *   1. **用上面已算好的 `proactive`，不要自己读 opts.proactive。**
     *      main.js:432 的 `proactive = !!offer` 由 validOffer() 校验决定，
     *      与 opts.proactive 不是一回事。若误用 opts.proactive，
     *      未通过 validOffer 的主动搭话会被当成用户请求 ——
     *      而「她主动开口 → 立刻要动手」正是 persona.js:29
     *      「不虚构寂寞/ 不数着时间等你/ 装可怜不行」要防的形态。
     *   2. **判定的文本用userText 原文**：主动搭话时 userText 是 offer.reason，
     *      但 proactive 判定已在上游把这条路挡掉，这里不必再区分。
     *   3. **try/catch 包死**：触发源是便利功能，不是对话链路的一部分。
     *      它崩了用户不该看到一坨报错（evaluateTrigger 内部已降级，
     *      这里再兜一层是防「接线点自身」抛，比如 this.cfg 为 undefined）。
     *   4. **不碰 return，不改任何既有分支**：纯旁路，只有开关开着且判定命中
     *      才会往上抛一个「可能有提案」的信号，其余情况一行都不执行。
     *
     * ⚠️ 本阶段**只判定、不建案**：建案与气泡提示留待后续接线，
     *   因为「内容从哪来」尚未定（见 agent-intent.js 头部注释）。
     */
    try {
      const { evaluateTrigger } = require('./agent-trigger');
      const verdict = evaluateTrigger(userText, {
        config: this.cfg,
        proactive: proactive,
      });
      //ran=false 是**默认路径**（开关关着/ 主动搭话），此处什么都不做即正确。
      if (verdict.ran && verdict.decision && verdict.decision.shouldPropose) {
        this._pendingAgentIntent = verdict.decision;   // 供后续接线消费
      } else if (verdict.ran) {
        this._pendingAgentIntent = null;                // 判定跑过但没中：清掉上一轮残留
      }
    } catch (e) {
      // 如实留痕但不外抛：触发源崩了不该影响她回话。
      this._pendingAgentIntent = null;
      console.warn('[AgentTrigger] 触发源判定异常，已跳过：', e && e.message);
    }

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

      // v3.1 梦境时序改造 · 惰性苏醒结算（路径 B）：
      // 用户重新发消息时，若她仍在睡（退出软件期间睡着的典型场景），此刻才结算梦境。
      //
      // ⚠️ 顺序铁律：**先无条件唤醒，再看有没有睡眠上下文**。
      // 苏醒是不可逆的物理事实，绝不能因为 sleepCtx 为 null（缺 sleepStartTime 的
      // 孤立态、或原料已消费完）就不醒 —— 那正是「显示深度休眠却在桌面漫步」的成因：
      // isSleeping 卡在true，而唤醒分支永远进不去，两套状态从此分裂。
      // 拿不到可信睡眠时长就不做梦（SLEEP_ELAPSED_UNKNOWN 门禁负责这件事），
      // 但绝不能连带阻止苏醒同步 ——这两件事必须解耦。
      try {
        if (this.internalRegulation.isSleeping === true) {
          const sleepCtx = this.internalRegulation.getSleepContext
            ? this.internalRegulation.getSleepContext(now)
            : null;
          this.internalRegulation.updateOnSleep(false, { timestamp: now });
          if (tr) tr.wakeUp(now);
          // 原料齐全才结算梦；没有原料就只是醒过来，不做梦（如实跳过，绝不编造）
          if (sleepCtx && sleepCtx.staging) {
            // 不阻塞本次回复：梦在后台生成，回复不等它
            this._settleDreamOnWake('message_wake', {
              sleepStartTime: sleepCtx.sleepStartTime,
              elapsedMs: sleepCtx.elapsedMs,
              staging: sleepCtx.staging
            }).catch(() => {});
          }
        }
      } catch (e) { /* 惰性结算失败绝不影响本次回复 */ }
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
    const dynamicBody = [currentSelf, shouldAttach ? envText : ''].filter(Boolean).join('\n\n');
    // v0.9.9: 瞬时上下文挂在 user 尾部是护缓存的必要设计，但必须标明程序注入身份 ——
    // 否则模型会把状态快照误认成用户贴来的内容（实测她真的以为用户在「贴表」）
    const dynamicContext = dynamicBody
      ? '【以下为程序注入的实时状态，非用户输入，供你感知自身与环境】\n' + dynamicBody
      : '';
    // 🔴 D-7：自我意图接入。
    //
    //   这里刻意**不预生成台词** —— 台词由 persona 现场生成。
    //   本层只传「她此刻想往哪个方向说」，理由见 src/trigger.js 的D-7 注释：
    //   预生成台词会让主体性退化成可枚举的模板。
    //
    //   ⚠️ 三条必须守住的边界：
    //   1. **selfIntent 可能为 null**（没有可追溯的意图就是没有）。
    //      null 时这一段整体跳过，绝不拼出空的 `[自我意图]` ——
    //      那会让提示词里出现一个空标签，比不出现更糟。
    //   2. **方向 ≠ 台词 ≠ 经历**。它只是「可说话的倾向」，
    //      不是她做过什么。措辞里必须保留这个区别，
    //      否则她会顺着「想提一句被留下的感觉」编出一段假回忆。
    //      persona.js:26「不编造经历与记忆」是红线，这里是它的结构性防线。
    //   3. 类型守卫：跨进程传进来的东西一律不信任。o 不是字符串就当没有。
    const rawSelfIntent = proactive ? (opts.selfIntent || null) : null;
    const selfIntent = (rawSelfIntent && typeof rawSelfIntent === 'object'
      && typeof rawSelfIntent.direction === 'string'
      && rawSelfIntent.direction.trim())
      ? rawSelfIntent : null;

    const proactivePayload = proactive
      ? '[自主感知触发]：' + userText
        + (opts.proactiveHint ? '\n[内部语气提示]：' + String(opts.proactiveHint) : '')
        + (selfIntent
          // 措辞已按红线②处理：说的是「想说」，不是「说过」。
          // 末句把决定权交回她 —— 她可以说，也可以不说。
          ? '\n[此刻她想说的方向]：' + selfIntent.direction.trim()
            + '\n（这只是倾向，不是她说过的话。请据此自己决定说什么，'
            + '也可以什么都不说。）'
          : '')
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
      // v0.9.9 P1-b 更正：原注释写「主动搭话没追加过，也就没什么可回滚」，与上面
      // 的 memory.append('user', …, {synthetic:true}) 直接矛盾 —— proactive 确实
      // 追加过一条 synthetic user。空回复时不回滚，历史里就留下一条**没有回复的**
      // synthetic user，下次请求出现连续两条 user（memory.rollback 的注释描述的
      // 正是这个坏形状）。所以无条件回滚。
      this.memory.rollback(1);
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
        this.memory.wardrobe = this.getWardrobePrompt();
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

    /* ---- 入睡联动（幂等；v2.0 双通路）----
       通路 A：用户明说道晚安，或她自己说出想睡 —— 同一套话语判据、零预置台词：
       她想撑着（依恋再高）就继续陪，只有她自己说停才停。
       enterSleepMode 内部带守卫，重复触发不会把 sleepStartTime 刷成"刚睡"。 */
    // sleepy 标签本身不作数（只当情绪），作数的是她嘴里说出的入睡话语。
    const herSleepIntent = !!(tr && tr.constructor && typeof tr.constructor.isSleepIntent === 'function'
      && tr.constructor.isSleepIntent(String(clean || text || '')));
    if (sleepIntent || herSleepIntent) {
    // v3.1 梦境时序改造：入睡 ONLY 冻结梦境原料，零 LLM 调用 ——
    // 过去是「入睡即结算」，说完晚安约 2 秒梦就落盘，于是退出软件后重进看到的梦已经做完。
    // 现在梦的结算点后移到苏醒那一刻，原料冻结在入睡时，跨重启可恢复。
    // 物理时长门禁（Δt ≥ sleepMinimumDreamMinutes）与窗口间隔豁免由 dream-system 判定。
    this._freezeDreamStagingForSleep().catch(() => {});
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
    // v0.9.9 D3: 关窗失败退避保险丝 —— 冷却期内不自动重试小结，防止限流/网络抖动时每轮全价死磕；
    // 只约束自动触发，用户/脚本手动关窗不受冷却限制
    const inCloseBackoff = Boolean(this.windowCloseRetryAfterTurn)
      && this.memory.data.turnsInWindow < this.windowCloseRetryAfterTurn;
    if (inCloseBackoff && this.memory.needsWindowReset() && !this.boundary) {
      console.warn(`[Brain] 关窗处于失败退避冷却中（第 ${this.windowCloseRetryAfterTurn} 轮起重试），暂缓自动触发`);
    }
    if (this.memory.needsWindowReset() && !this.boundary && !inCloseBackoff) {
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

  /** v0.9.9: 撞顶检测 —— 输出恰好打满上限即视为疑似截断（900 / 420 / 1500 三次无声失败的教训），
      计数并留警告，绝不让「截断腰斩 JSON」再无声溜走。 */
  _notePossibleTruncation(usage, cap, label) {
    if (usage && cap > 0 && Number(usage.completion_tokens) >= cap) {
      this.stats.truncatedCalls = (this.stats.truncatedCalls || 0) + 1;
      this.saveStats(true);
      console.warn(`[Brain] ${label} 输出撞满上限 ${cap}（completion_tokens=${usage.completion_tokens}）：疑似截断，产物可能不可解析`);
    }
  }

  /** v0.9.9 P0: 关窗失败审计留痕 —— 小结解析失败、校验熔断、写入失败而放弃的关窗都计数并留日志，
      让「窗口为何拖超期」在盘面与日志上都可追查（数据不伪造、审计不失真） */
  _noteWindowCloseFailure(reason) {
    this.windowCloseAttempts = (this.windowCloseAttempts || 0) + 1;
    // v0.9.9 观测补盲：关窗失败率计数，即刻落盘（进程退出不丢账）
    this.stats.windowCloseFailures = (this.stats.windowCloseFailures || 0) + 1;
    this.saveStats(true);
    // v0.9.9 D3: 一旦失败即进入退避冷却（至少隔 2 轮对话），冷却期内即使触发条件满足也不自动重试；
    // 窗口宁可继续变长，也不把钱烧在连环失败的全价小结上（历史数据绝不丢）
    this.windowCloseRetryAfterTurn = ((this.memory && this.memory.data) ? this.memory.data.turnsInWindow : 0) + 2;
    console.warn(`[Brain] 关窗尝试失败 (#${this.windowCloseAttempts})：${reason || 'unknown'}，保留窗口内容待下一轮重试；退避至第 ${this.windowCloseRetryAfterTurn} 轮起重试`);
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
    let closeReason = (opts && opts.closeReason) || (this.memory.data.turnsInWindow >= this.memory.windowTurns ? 'turn_limit' : (this.memory.needsWindowReset() ? 'token_limit' : 'turn_limit'));
    // v0.9.9 P0: 关窗审计留痕 —— 若此前已有失败的关窗尝试且轮次确实已超标，
    // 如实标记为 turn_limit_delayed（补关），不把多次失败后的补记粉饰成顺利的 turn_limit
    if (!(opts && opts.closeReason) && this.windowCloseAttempts > 0
        && this.memory.data.turnsInWindow > this.memory.windowTurns) {
      closeReason = 'turn_limit_delayed';
    }
    const snap = this.memory.windowSnapshot({ closeReason });
    // v0.9.9 扫雷: 同 memory.closeWindow —— 判「窗口有没有内容」看 activeItems，
    // 不是 items（待裁剪清单）。keepTail 被调大或消息数很少时 drop=0、items 恒空，
    // 这道守卫会把一次该成功的关窗挡在这里（且是静默 return false）。
    if (!(snap.activeItems && snap.activeItems.length) && !snap.items.length) return false;

    // P0-2: 若当前窗口已在 Archive 中成功归档且 SubjectState 已恢复/前进，直接推进 Memory 关窗完成幂等收尾
    if (this.experiencesArchive && this.experiencesArchive.hasWindowArchive &&
        this.experiencesArchive.hasWindowArchive(snap.windowNo) &&
        (!this.subjectState || this.subjectState.currentWindowNo > snap.windowNo)) {
      console.warn(`[Brain] 窗口 #${snap.windowNo} 已经归档且状态已前进，直接推进 Memory 关窗完成幂等收尾`);
      const existing = this.experiencesArchive.getByWindow(snap.windowNo).find(r => r.recordType === 'window_summary' || r.recordType === 'window_archive' || r.type === 'window_archive');
      const p = (existing && existing.payload) || existing || {};
      // v0.9.9 P1-5: epoch 门禁 —— 只回填**同一条记忆血脉**的旧小结。
      // memory.reset() 会 epoch++ 并把 windowNo 归 1，snap.windowNo 于是与归档里的
      // 旧窗口撞号；无条件回填会让「清空记忆」后第一次关窗把旧第 1 段小结复活进
      // L2/prompt。历史记录缺 epoch（未记录）时保持 null、不回填 —— 诚实降级，不猜。
      const sameLineage = Number.isInteger(p.epoch) && p.epoch === this.memory.data.epoch;
      if (sameLineage) {
        const summaryText = p.rawSummaryText || (p.windowSynthesis && p.windowSynthesis.stableUserFacts.map((x) => (typeof x === 'string' ? x : (x && (x.content || x.text)) || '')).filter(Boolean) && p.windowSynthesis.stableUserFacts.map((x) => (typeof x === 'string' ? x : (x && (x.content || x.text)) || '')).filter(Boolean).join('\n')) || '窗口小结已归档';
        const done = this.memory.closeWindow(summaryText, snap);
        if (done) {
          this.stats.compressions++;
          this.saveStats(true);
          this.currentWindowSnapshot = createWindowExperimentSnapshot(this.memory.data.windowNo, this.runManifest);
        }
        return done;
      }
      console.warn(`[Brain] 窗口 #${snap.windowNo} 的归档记录不属于当前记忆血脉 (记录 epoch=${p.epoch} / 当前 epoch=${this.memory.data.epoch})，跳过回填、按新生命周期正常关窗`);
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

    // v0.9.9 P0: 结构化小结 (5×20 + WindowSynthesis) 输出上限，必须给足 JSON 完整裕度。
    // 此前硬编码 900 会截断 JSON，触发 Fail-Stop 后关窗连败（窗口越拖越长）。
    const summaryMaxTokens = (opts && opts.maxTokens) || this.cfg.summaryMaxTokens || 10000;
    // v0.9.9: 分段随窗口规模自适应（见 summarySegmentPlan 注释）
    const segPlan = summarySegmentPlan(snap.actualTurnCount);
    // v1.0 §4.7 #4：待核验预期对照物（空清单给「暂无」，防小结模型幻觉妄加 expectationOutcomes）
    const openExps = ((this.memory && this.memory.data && this.memory.data.expectations) || [])
      .filter((x) => x && x.status === 'open');
    try {
      const apiCompleteRes = await this.api.complete(
        [{ role: 'system', content: SUMMARY_SYS },
         { role: 'user', content: '【对话】\n' + dialogue
           + '\n\n【窗口规模】本窗口共 ' + (snap.actualTurnCount || 0) + ' 轮，请' + segPlan.note + '；紧凑输出，不写空段、不铺陈冗余字句。'
           + '\n\n【待核验预期清单】\n' + (openExps.length
             ? openExps.map((x) => '- [' + x.id + '] ' + x.text + (x.dueHint ? '（' + x.dueHint + '）' : '')).join('\n')
             : '暂无') }],
        { maxTokens: summaryMaxTokens, temperature: 0.2 }
      );
      const { text, usage, observedModel } = apiCompleteRes;
      this.track(usage, true, 'summary');
      this._notePossibleTruncation(usage, summaryMaxTokens, '关窗小结');
      // v0.9.9 P0: 计数即落盘 —— 这笔 summary 的调用与花费已经真实发生，
      // 无论后续解析/校验成败都立即持久化，杜绝失败路径与脚本进程退出后漏记（与遥测对不齐）
      this.saveStats(true);
      if (this.shutdownRequested) return false;
      if (!text) { this._noteWindowCloseFailure('EMPTY_SUMMARY_TEXT'); return false; }

      const summaryPromptHashes = collectPromptHashes({
        summary: SUMMARY_SYS,
        persona: PERSONA,
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
        sampling: { maxTokens: summaryMaxTokens, temperature: 0.2 },
        sourceWindowNo: snap.windowNo,
        sourceMessageRange,
        observedModel,
        providerResponse: apiCompleteRes,
        generator: 'llm'
      });

      // 尝试解析 5×20 + Window Synthesis 结构化 JSON
      let structured = null;
      let summaryEpistemicStatus = 'CERTIFIED';
      let summaryFailureReason = null;
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
            this._noteWindowCloseFailure('SUMMARY_SCHEMA_INVALID: ' + vSummary.reason);
            return false;
          }
        }
      } catch (parseErr) {
        // 保全纯文本，但明确标记为不可认证的非结构化摘要。
        summaryEpistemicStatus = 'UNCERTIFIED';
        summaryFailureReason = 'NON_JSON_SUMMARY';
        // v0.9.9 观测补盲：带病归档占比 —— 小结质量的长期监控指标
        this.stats.summaryUncertified = (this.stats.summaryUncertified || 0) + 1;
      }

      // 🔴 2026-10-07 修复（真实事故）：**解析失败时绝不让原始输出进她的意识**。
      //
      //   ## 出过什么事
      //   第 5 段小结的 LLM 输出是一段 JSON，但**中文里的引号没转义**：
      //     "userGiven":["用户问…，说"你也算陪我一天了"（m-000401）"]
      //                                           ↑ 未转义 ⇒ JSON 结构被破坏
      //   于是 `JSON.parse` 抛错、走下面的 catch（`NON_JSON_SUMMARY`），
      //   而当时这里是 `let summaryTextForMemory = text;` —— **原始坏 JSON 原封不动**
      //   经 `closeWindow()` 进了 `memory.windows[].text`，成为她 **system prompt 的一部分**。
      //   实测后果：她每一轮读到的「第5段」是 `{"segments":[{"range":"1-20"…` 这串碎片，
      //   里面还带 `m-000401` 这类内部消息 ID。（旁证：反重力说她「复述引语、括号剖析」
      //   像 AI —— 她读到的样本本来就是那种表格式记录。）
      //
      //   ## 为什么这是「放大伤害」而不是小毛病
      //   解析失败本身只是「这一次小结没结构化」，可接受；
      //   **但把坏 JSON 当正文写进她的长期记忆，是把一个可恢复的错误升级成永久的污染。**
      //
      //   ## 修法（判据要**精准**，不能一刀切）
      //   解析失败分两种，必须区别对待：
      //
      //     甲「看起来像 JSON 但坏了」→ **拦下**，换中性降级文本。
      //        这正是本次事故的形态（`{"segments":[{"range":…`）。
      //     乙「本来就是一段普通散文」→ **原样放行**。
      //        散文小结是合法的（LLM 没按 JSON 格式答而已），丢掉它等于白丢一段真实经历。
      //
      //   ⚠️ 为什么判据是「首字符是否为 { 或 [」而不是「解析是否成功」：
      //     解析失败的原因很多（截断、转义、超长），但**只有结构化输出才有"坏成一半"的形态**；
      //     散文不会。用首字符判据与 `JSON.parse` 的失败面**正交**，不会误伤散文。
      //
      //   ⚠️ 刻意**不做「尽力抢救」**（比如自己扫字符串把 JSON 还原）：
      //     那是脆弱的启发式，一旦猜错就会把「她没说过的话」写进记忆 ——
      //     而伪造记忆是本仓红线（persona.js:26）。**宁可让它明确地空着。**
      const looksLikeJson = (() => {
        const head = String(text || '').trim()
          .replace(/^```(?:json)?\s*/i, '')   // 去掉 markdown 围栏后再判，否则 ``` 开头会漏判
          .charAt(0);
        return head === '{' || head === '[';
      })();
      let summaryTextForMemory = (structured || !looksLikeJson)
        ? text
        : '【本段小结未能结构化解析】这一段经历仍然完整保存在你的底座归档里，只是没能压缩成条目；不要据此虚构细节。';
      let verifiedEvidence = [];
      let rejectedEvidence = [];

      // P0-01 & P0-03: 程序仅为当前窗口的真实交互消息签发 Event (严格排除 System Prompt、Bridge 桥接、Synthetic 与内部调试)
      const events = [];
      const eventIdsSet = new Set();
      for (const [eventIndex, m] of activeItems.entries()) {
        if (!isEligibleSubjectEvent(m)) {
          continue;
        }

        const eventId = 'evt-' + crypto.createHash('sha256')
          .update(JSON.stringify({ windowNo: snap.windowNo, eventIndex, source: m.role || 'user', content: m.content || '' }), 'utf8')
          .digest('hex').slice(0, 24);
        const evt = createEvent({
          eventId,
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

        // v1.0 防 [object Object]（#4 首战实证）：条目兼容字符串与引证式 {messageId, content}
        const factText = (x) => (typeof x === 'string' ? x : (x && (x.content || x.text)) || '');
        const userFacts = Array.isArray(syn.stableUserFacts) && syn.stableUserFacts.length > 0
          ? '用户事实：' + syn.stableUserFacts.map(factText).filter(Boolean).join('；')
          : '';
        const chulanExps = Array.isArray(syn.subjectExperiences) && syn.subjectExperiences.length > 0
          ? '初澜经历：' + syn.subjectExperiences.map(factText).filter(Boolean).join('；')
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
        // 纯文本仅作为原始保全材料，不自动升级为 Observation、Interpretation 或 Evidence。
        syn = { stableUserFacts: [text], subjectExperiences: [] };
      }

      // 执行严格 Provenance、Trait 白名单与防重核验
      let stateChanges = [];
      let explanations = [];
      let stateStaging = null;

      if (this.subjectState) {
        // P0-08: 两阶段提交——先冻结完整暂存快照，再写入任何新的 provenance 状态。
        // 这样 Archive 失败时，message/evidence attestations 以及 seen* 集合都会一起回滚。
        stateStaging = this.subjectState.createStagingSnapshot();

        // v0.9.7.1: 在真实窗口消息仍可验证时生成 Archive 外独立 message attestations。
        // 这些证明随后随 SubjectState 两阶段提交持久化；Archive 自身不能生成它们。
        if (typeof this.subjectState.attestMessages === 'function') {
          this.subjectState.attestMessages(activeItems, snap.windowNo);
        }

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
      const windowArchivePayload = {
        windowNo: snap.windowNo,
        // v0.9.9 P1-5: 记忆血脉标识，随记录进 payload 并被 recordHash 覆盖（不可篡改）
        epoch: Number.isInteger(snap.epoch) ? snap.epoch : null,
        targetTurnCount: snap.targetTurnCount || 100,
        actualTurnCount: snap.actualTurnCount ?? snap.snapshotTurnCount,
        closeReason: snap.closeReason || 'turn_limit',
        // v0.9.9 P0: 关窗审计留痕 —— 只在真有失败历史时如实追加，正常关窗 payload 保持原样
        ...(this.windowCloseAttempts > 0 ? { retryAttempts: this.windowCloseAttempts, delayedClose: true } : {}),
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
        sourceMessageRange,
        epistemicStatus: summaryEpistemicStatus,
        structuredSummaryAvailable: Boolean(structured),
        summaryFailureReason
      };
      let archiveSuccess = false;
      if (this.experiencesArchive) {
        if (this.experiencesArchive.hasWindowArchive && this.experiencesArchive.hasWindowArchive(snap.windowNo)) {
          console.warn(`[Brain] 窗口 #${snap.windowNo} 经历已在 Archive 中，跳过重复写入`);
          archiveSuccess = true;
        } else {
          archiveSuccess = this.experiencesArchive.appendWindowArchive(windowArchivePayload);
        }
      } else {
        archiveSuccess = true;
      }

      // P0-08: 失败保护：若 Archive 写入失败，绝不提交 Subject State，不删除原始消息，中止关窗
      // v0.9.9 P0-2（A + C）：主链锁死时先紧急溢写保全，**绝不允许「无保全直接丢弃对话」**。
      // 关窗会裁掉 memory.json 的 history 头部（memory.js closeWindow 的 splice），
      // 而原始对话只有归档这一份 —— 所以必须 sidecar 写入**成功确认**之后才放行关窗；
      // 溢写也失败就维持 fail-closed，宁可上下文膨胀也不丢经历。
      if (!archiveSuccess) {
        const spilled = Boolean(this.experiencesArchive) &&
          typeof this.experiencesArchive.spillWindowArchiveToSidecar === 'function' &&
          this.experiencesArchive.spillWindowArchiveToSidecar(windowArchivePayload, 'ARCHIVE_APPEND_FAILED');
        if (!spilled) {
          console.error('[Brain] Archive 写入失败且紧急溢写也失败，回滚状态暂存并中止本次关窗 (保障数据一致性)');
          if (this.subjectState && stateStaging) {
            this.subjectState.rollbackStage(stateStaging);
          }
          this._noteWindowCloseFailure('ARCHIVE_WRITE_AND_SPILL_FAILED');
          return false;
        }
        // C: 显式告警 —— 上层/人工需要知道主链已坏，本次是降级推进、经历落在 sidecar。
        this._noteArchiveSpillover(snap.windowNo, 'ARCHIVE_APPEND_FAILED');
        console.error(`[Brain] ARCHIVE_SPILLOVER 窗口 #${snap.windowNo}：主链写入失败，已紧急溢写至 recovery-audit sidecar，本次关窗降级推进，需人工/自愈检查`);
      }

      // v0.9.7.1: Archive 已成功后，先提交独立 provenance sidecar。
      // 这一步与 SubjectState 分开，保证 State commit 失败后重启仍能验证历史来源。
      let provenanceCommitSuccess = true;
      if (this.experiencesArchive && this.subjectState &&
          typeof this.experiencesArchive.updateProvenanceAttestations === 'function') {
        provenanceCommitSuccess = this.experiencesArchive.updateProvenanceAttestations(
          this.subjectState.data.messageAttestations || [],
          this.subjectState.data.evidenceAttestations || []
        );
      }

      if (!provenanceCommitSuccess) {
        console.error('[Brain] Archive 已写入但独立 provenance sidecar 提交失败，回滚暂存状态并中止本次关窗');
        this._noteWindowCloseFailure('PROVENANCE_COMMIT_FAILED');
        if (this.subjectState && stateStaging) {
          this.subjectState.rollbackStage(stateStaging);
          this.subjectState.recoveryPending = true;
          this.subjectState.recoveryPendingReason = 'provenance_commit_failed';
        }
        return false;
      }

      // Archive + provenance sidecar 均确认后，正式提交 Subject State 持久化 (P0-01)
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
        this._noteWindowCloseFailure('STATE_COMMIT_FAILED');
        return false;
      }

      snap.generationContext = summaryGenerationContext;
      const done = this.memory.closeWindow(summaryTextForMemory, snap);
      if (done) {
        // v0.9.9 意志层·好奇：本窗未解疑问入队（与轮转同刻更新，窗口内逐字节稳定）
        this.memory.refreshCuriosity((syn && Array.isArray(syn.unresolved)) ? syn.unresolved : [], snap.windowNo);
        // v1.0 §4.7 #3/#4：词汇与预期入库（引证按快照解析，防 keepTail 裁头误判；门槛拒收即跳过，绝不硬造）
        const knownIds = (snap && Array.isArray(snap.snapshotActiveMessageIds)) ? snap.snapshotActiveMessageIds : [];
        const ingestOpts = { knownIds };
        for (const c of (Array.isArray(syn.coinages) ? syn.coinages : [])) {
          this.memory.addLexicon(c, ingestOpts);
        }
        for (const ex of (Array.isArray(syn.expectations) ? syn.expectations : [])) {
          this.memory.addExpectation(Object.assign({}, ex, { windowNo: snap.windowNo }), ingestOpts);
        }
        for (const oc of (Array.isArray(syn.expectationOutcomes) ? syn.expectationOutcomes : [])) {
          this.memory.resolveExpectation(oc && oc.id, {
            status: oc && oc.status, messageId: oc && oc.messageId, note: oc && oc.note
          }, ingestOpts);
        }
        this.memory.save(true);
        // v0.9.9 观测补盲：补关计数 —— 先数后复位（windowCloseAttempts 一旦复位就数不到了）
        if (this.windowCloseAttempts > 0) {
          this.stats.delayedCloses = (this.stats.delayedCloses || 0) + 1;
        }
        // v0.9.9 P0: 关窗成功，审计计数复位（本窗口的失败历史已随 retryAttempts 铸入归档）；
        // v0.9.9 D3: 退避冷却一并复位，下一窗口恢复正常自动关窗节奏
        this.windowCloseAttempts = 0;
        this.windowCloseRetryAfterTurn = 0;
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
          // v2.0：梦境机器抽为 _dreamCycle（关窗与入睡共用同一台）；此处行为与原先一字不差
          await this._dreamCycle({ snap, syn, verifiedEvidence, events, segments, isWindowClose: true, preClose: false });
        }

        // 🔴 D-24（A 段）：关窗铸造 —— 她自发写下的字铸进经历档案（单一事实源：experiences.jsonl）。
        //   刻意放在 growSelf 之前（防坑锦囊 1）：本窗「自发留痕事实」要带进当轮成长反思，
        //   她才看得见「自己本窗写下了这张便签」，从而产出带引证的 SELF_INFERRED 记录。
        //   只铸 proposalSource==='selfNote' 且未铸过的（受托任务产物不算她的经历）；
        //   appendRecord 确认成功后才置 engraved（防坑锦囊 2），失败留待下窗重试，绝不漏铸。
        const selfNoteMint = this._engraveSelfNotes(snap.windowNo);
        const selfNoteTraitHints = [];

        if (this.cfg.selfGrowthEnabled === true)
          await this.growSelf(dialogue, summaryTextForMemory, snap.windowNo, {
            msgMap,
            sourceMessageRange,
            selfNoteFacts: selfNoteMint.facts,
            selfNoteAttestations: selfNoteMint.attestations,
            traitHintsOut: selfNoteTraitHints
          });

        // 🔴 D-24（C 段）：特质微调 —— 只走「证据核验 → 确定性 Reducer → 归档 → commit」
        //   与主通道完全同一套判据（程序绝不代拟人格结论、也绝不当场改特质）。
        //   证据不足一条都不过核验时，特质分毫不动（宁缺毋滥）。
        if (selfNoteTraitHints.length && this.subjectState) {
          this._applySelfNoteTraitHints(selfNoteTraitHints, selfNoteMint.attestations, msgMap, snap.windowNo);
        }

        if (done) {
          // 关窗后主体特质可能演进，根据最新特质喜好值刷新衣柜偏好提示块
          if (this.wardrobe) {
            this.memory.wardrobe = this.getWardrobePrompt();
          }
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
      console.error('window summary failed:', redactSecrets(e.message));
      this._noteWindowCloseFailure('SUMMARY_EXCEPTION: ' + redactSecrets(e.message));
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
      const apiCompleteRes = await this.api.complete(
        [{ role: 'system', content: MERGE_SYS },
         { role: 'user', content: body }],
        { maxTokens: 400, temperature: 0.2 }
      );
      const { text, usage, observedModel } = apiCompleteRes;
      this.track(usage, true, 'merge');
      this._notePossibleTruncation(usage, 400, '记忆合并');
      // v0.9.9: 计数即落盘（同 summary 口径），防进程退出漏记
      this.saveStats(true);
      if (this.shutdownRequested) return false;
      if (!text) return false;

      const mergeGenCtx = buildGenerationContext({
        kind: 'merge',
        cfg: this.cfg,
        promptHashes: collectPromptHashes({
          merge: MERGE_SYS,
          summary: SUMMARY_SYS,
          persona: PERSONA,
          growth: GROWTH_SYS
        }),
        sampling: { maxTokens: 400, temperature: 0.2 },
        observedModel,
        providerResponse: apiCompleteRes,
        generator: 'llm'
      });

      this.memory.applyMerge(text, plan.keep, { generationContext: mergeGenCtx });
      this.pendingCacheBreakReason = 'memory_merge';
      this.stats.merges++;
      this.saveStats(true);
      return true;
    } catch (e) {
      console.error('memory merge failed:', redactSecrets(e.message));
      return false;
    }
  }

  /** 低频主体成长检查点：只在窗口小结成功后调用一次。 */
  /** v2.0 梦境周期（离线重组）：关窗与入睡共用同一台机器（抽取自原关窗块，行为不变）。
   *  防伪链条不变：产物一律带 [DREAM_GENERATED_ARTIFACT] / 【离线重组碎片】（非亲历）标签，绝不冒充亲历。
   *  ctx: { snap, syn, verifiedEvidence, events, noveltyProxy } */
  /**
   * v3.1 梦境时序改造 · 入睡冻结（Sleep Staging）
   *
   * 入睡那一刻 ONLY 把当天的日间遗留与唤醒度轨迹拍个快照、落盘，**绝不调 LLM**。
   * 梦的结算点后移到苏醒那一刻 —— 这样梦才有时间跨度，而不是说完晚安两秒后就已完成。
   * 冻结原料与 sleepStartTime 同盘存进 internal-regulation.json，重启后原样恢复。
   *
   * @returns {Promise<Object|null>} 冻结体；模块未启用或无调节器时返回 null
   */
  async _freezeDreamStagingForSleep() {
    try {
      const reg = this.internalRegulation;
      if (!reg || typeof reg.stageSleepContext !== 'function') return null;
      if (!this.isExperimentModuleActive || !this.isExperimentModuleActive('sleepConsolidation')) return null;

      const snap = this.memory.windowSnapshot();
      const { computeWindowArousalTrajectory, extractDayResidues } = require('./dream-system');

      // 冻结的是「睡着之前的这一天」，所以用当前窗口的真实交互算原料，不调任何模型。
      const regHistory = Array.isArray(reg.history) ? reg.history : [];
      const arousalTrajectory = computeWindowArousalTrajectory(
        snap.activeItems || [], [], [], { regulationHistory: regHistory }
      );
      const dayResidues = extractDayResidues(snap.activeItems || [], []);

      // 新异度用物理代理：只数真实交互条数，不编内容（与旧入睡路径同口径）
      const noveltyScore = Number(Math.min(1.0, Math.min(4, Math.round((snap.activeItems || []).length / 25)) * 0.25).toFixed(2));

      return reg.stageSleepContext({
        at: Date.now(),
        windowNo: snap.windowNo,
        dayResidues,
        arousalTrajectory,
        noveltyScore
      });
    } catch (err) {
      console.error('[Brain] 入睡冻结梦境原料失败 (Fail-Safe):', redactSecrets(err.message));
      return null;
    }
  }

  /**
   * v3.1 梦境时序改造 · 苏醒结算（Wake-Up Settlement）
   *
   * 醒来那一刻才真正合成梦，时间戳记醒来时刻。两条触发路径共用本方法：
   *   A 被唤醒 —— tracker.wakeUp()（拖拽 ≥80px / 摇晃 ≥5 次，见 tracker.js）
   *   B 惰性 —— 用户重新发消息时发现她仍在睡（不在睡则直接返回，零开销）
   *
   * 小憩（Δt 不足门槛）与无睡眠原料时如实跳过；24h 频次硬顶与认知门禁照常生效。
   * 原料一次性消费：无论本次是否真的做梦，结算后都清空，绝不拿同一份原料重复做梦。
   *
   * @returns {Promise<Object|null>} 实际生成的梦境记录；未生成返回 null
   */
  async _settleDreamOnWake(trigger = 'wake', preset = null) {
    try {
      const reg = this.internalRegulation;
      if (!reg) return null;

      // preset 来自 tracker 唤醒钩子（原料已在 updateOnSleep 清空前抓住）；
      // 没有 preset 时走惰性路径，直接从调节器读当前睡眠上下文。
      let sleepStartTime, staging;
      if (preset && Number.isFinite(preset.sleepStartTime)) {
        sleepStartTime = preset.sleepStartTime;
        staging = preset.staging || null;
      } else {
        if (typeof reg.getSleepContext !== 'function') return null;
        const sleepCtx = reg.getSleepContext();
        if (!sleepCtx) return null;   // 不在睡 → 零开销
        sleepStartTime = sleepCtx.sleepStartTime;
        staging = sleepCtx.staging || null;
      }

      if (!Number.isFinite(sleepStartTime)) return null;

      if (!this.isExperimentModuleActive || !this.isExperimentModuleActive('sleepConsolidation')) {
        reg.clearSleepContext();
        return null;
      }

      if (!staging || !Array.isArray(staging.dayResidues) || staging.dayResidues.length === 0) {
        // 睡着时没冻结到任何原料（没启用模块/ 原料为空）→ 无从结算，如实跳过。
        reg.clearSleepContext();
        return null;
      }

      // 先算物理时长（用冻结时的入睡时刻，而不是"此刻往前推"，跨重启才不失真）
      const sleepElapsedMs = Math.max(0, Date.now() - sleepStartTime);
      const snap = this.memory.windowSnapshot();

      let produced = null;
      const before = this.dreamHistory.length;
      await this._dreamCycle({
        snap: { ...snap, windowNo: staging.windowNo || snap.windowNo },
        syn: null,
        verifiedEvidence: [],
        events: [],
        noveltyProxy: true,
        isWindowClose: false,
        preClose: true,
        fromSleep: true,
        sleepElapsedMs,
        sleepStaging: staging
      });
      if (Array.isArray(this.dreamHistory) && this.dreamHistory.length > before) {
        produced = this.dreamHistory[this.dreamHistory.length - 1];
      }

      // 原料一次性消费：做梦与否都清空，防止同一份睡眠原料反复做梦。
      reg.clearSleepContext();
      reg.save();

      if (produced) {
        console.log('[Brain] 苏醒结算梦境（' + trigger + '，睡了 ' +
          (sleepElapsedMs / 3600000).toFixed(1) + ' 小时）');
      } else {
        console.log('[Brain] 苏醒结算未产生梦境（' + trigger + '，睡了 ' +
          (sleepElapsedMs / 3600000).toFixed(1) + ' 小时，门禁未放行）');
      }
      return produced;
    } catch (err) {
      console.error('[Brain] 苏醒结算梦境失败 (Fail-Safe):', redactSecrets(err.message));
      return null;
    }
  }

  async _dreamCycle(ctx = {}) {
    const snap = ctx.snap || {};
    const syn = ctx.syn || { stableUserFacts: [], subjectExperiences: [] };
    const verifiedEvidence = ctx.verifiedEvidence || [];
    const events = ctx.events || [];
    const segments = ctx.segments || [];
          try {
            const { computeWindowArousalTrajectory, evaluateDreamGate, extractDayResidues, buildDreamSynthesisPrompt, synthesizeDream } = require('./dream-system');
            
            // v1.0 生理真迹（方案 2）：把她真实落盘的生理状态史送进唤醒度轨迹 —— 梦由身体驱动
            const regHistory = (this.internalRegulation && Array.isArray(this.internalRegulation.history))
              ? this.internalRegulation.history
              : [];
                        // 真实唤醒度轨迹计算 (基于本窗口真实消息节奏与情绪证据)
            const arousalTrajectory = computeWindowArousalTrajectory(snap.activeItems || [], verifiedEvidence || [], segments || [], { regulationHistory: regHistory });

            // 新异度计算 (基于窗口综合提取的新事实/新经历数量)
            let newFactCount = (Array.isArray(syn.stableUserFacts) ? syn.stableUserFacts.length : 0) +
                                 (Array.isArray(syn.subjectExperiences) ? syn.subjectExperiences.length : 0);
            // v2.0 入睡路径 syn 缺席时：新异度改用「今日消息量」物理代理（只数真实交互条数，不编内容）
            if (!ctx.syn && ctx.noveltyProxy) {
              newFactCount = Math.min(4, Math.round(((snap && snap.activeItems) || []).length / 25));
            }
            const noveltyScore = Number(Math.min(1.0, newFactCount * 0.25).toFixed(2));
            const now = (snap && typeof snap.at === 'number') ? snap.at : Date.now();

            const gateResult = evaluateDreamGate({
              windowNo: snap.windowNo,
              arousalTrajectory,
              noveltyScore,
              stateHistory: this.subjectState ? this.subjectState.data.history : [],
              verifiedEvidence: verifiedEvidence || [],
              dreamHistory: this.dreamHistory || [],
              // v3.1 梦境时序改造：睡眠来源结算须显式带上「来自睡眠期」与可验证的物理时长，
              // 门禁据此走第三道时长校验，并对窗口间隔做豁免（跨夜长睡期间窗口号不动）。
              fromSleep: ctx.fromSleep === true,
              sleepElapsedMs: ctx.sleepElapsedMs,
              now
            });

            if (gateResult && gateResult.allowDream) {
              // 睡眠来源结算必须用入睡时冻结的原料（那才是「那一天」的遗留），
              // 缺失则如实退回现算，绝不用醒来后的新对话冒充睡眠期原料。
              const staging = ctx.sleepStaging || null;
              const residues = (ctx.fromSleep === true && staging && Array.isArray(staging.dayResidues) && staging.dayResidues.length > 0)
                ? staging.dayResidues
                : extractDayResidues(snap.activeItems || [], verifiedEvidence || []);
              const dreamPrompt = buildDreamSynthesisPrompt(residues, snap.windowNo);

              // F-11: 严谨三层 Provenance 分离 (evidenceId ≠ eventId ≠ messageId)
              const evList = verifiedEvidence || [];
              const sourceEvidenceIds = evList.map(e => e.evidenceId).filter(Boolean);

              // 提取关联的客观 Event IDs
              const sourceEventIds = [];
              for (const ev of evList) {
                if (ev.eventId) {
                  sourceEventIds.push(ev.eventId);
                } else if (ev.messageId) {
                  const matchingEvt = events.find(e => e.messageId === ev.messageId);
                  if (matchingEvt) {
                    sourceEventIds.push(matchingEvt.eventId);
                  }
                }
              }

              // 提取原始交互消息范围
              const windowActiveItems = snap.activeItems || [];
              let sourceMessageRange = null;
              if (windowActiveItems.length > 0) {
                const firstMsg = windowActiveItems[0];
                const lastMsg = windowActiveItems[windowActiveItems.length - 1];
                sourceMessageRange = {
                  startMessageId: firstMsg.messageId || String(firstMsg.id || 'unknown'),
                  endMessageId: lastMsg.messageId || String(lastMsg.id || 'unknown'),
                  count: windowActiveItems.length
                };
              } else if (evList.length > 0) {
                const evMsgIds = evList.map(e => e.messageId).filter(Boolean);
                if (evMsgIds.length > 0) {
                  sourceMessageRange = {
                    startMessageId: evMsgIds[0],
                    endMessageId: evMsgIds[evMsgIds.length - 1],
                    count: evMsgIds.length
                  };
                }
              }

              const dreamRecord = await synthesizeDream(this.api, dreamPrompt, {
                windowNo: snap.windowNo,
                preClose: Boolean(ctx.preClose),
                sourceEvidenceIds,
                sourceEventIds,
                // 无法证明 Event 来源时严禁扩大归因（不把整个窗口 events 算作梦境来源），
                // 显式标记 provenance 状态，供归档与研究层如实区分。
                eventProvenanceStatus: sourceEventIds.length > 0
                  ? 'evidence_linked'
                  : (events.length > 0 ? 'unavailable' : 'no_window_events'),
                sourceMessageRange,
                sourceEvents: events,
                sourceEvidence: evList,
                verifiedEvidence: evList,
                dayResidues: residues,
                gateMetrics: gateResult.metrics,
                gateThresholds: gateResult.thresholds,
                // v3.1 梦境时序改造：如实登记这是「睡眠来源」结算及其可验证的物理时长，
                // 供归档与研究层区分「关窗梦」与「醒来梦」，严禁事后猜测。
                fromSleep: ctx.fromSleep === true,
                sleepElapsedMs: (ctx.fromSleep === true && Number.isFinite(ctx.sleepElapsedMs)) ? ctx.sleepElapsedMs : null,
                sleepStartTime: (ctx.fromSleep === true && staging && Number.isFinite(staging.at)) ? staging.at : null
              }, {
                ...(this.cfg.dreamConfig || {}),
                now
              });

              if (dreamRecord) {
                // 🔴 D-26：深睡突触巩固 —— 梦**真实产出后**才记账（合成失败/被门禁拦下都零巩固）。
                //   不变式见 memory-dynamics.consolidateByDream：只加固既有真实 trace 的抗衰减能力
                //   （dreamSupport 记账），绝不加 retrievalCount（那是她真实被召回的事实计数）、
                //   选择零梦境内容参与、当场零重算（tier/strength 统一在关窗 decayAll 结算）。
                //   刻意放在 append 之前：被巩固的 traceId 随梦境记录进哈希链，加固全程可审计。
                if (this.memory && this.memory.engramManager
                    && typeof this.memory.engramManager.consolidateByDream === 'function') {
                  try {
                    const c = this.memory.engramManager.consolidateByDream(snap.windowNo, { topN: 3 });
                    if (c && Array.isArray(c.consolidated) && c.consolidated.length) {
                      dreamRecord.payload = dreamRecord.payload || {};
                      dreamRecord.payload.consolidatedTraceIds = c.consolidated;
                      this.memory.save();
                    }
                  } catch (e) {
                    // 巩固是旁路增益：失败绝不影响梦境归档本身（与 Dream fail-safe 同款纪律）
                  }
                }
                if (!Array.isArray(this.dreamHistory)) this.dreamHistory = [];
                this.dreamHistory.push(dreamRecord);
                this.experiencesArchive.append(dreamRecord);
                // v0.9.9 五大方向·①：归档成功的离线重组碎片同步进心智视野（防伪标签由 systemText 负责）。
                // P1-#2: 必须阻断非关窗时段对 systemText 的污染——严格仅在窗口轮转关窗时刻同步进心智视野，
                // 窗口内（入睡/昏睡触发）产物仅入归档，严禁中途向 memory.data.dreamFragments 追加碎片，
                // 从而确保窗口内 systemText 逐字节绝对稳定，严格维护 DeepSeek 前缀缓存不变式。
                if (ctx.isWindowClose === true) {
                  const fragText = String((dreamRecord.payload && (dreamRecord.payload.content || dreamRecord.payload.narrative)) || '').trim();
                  if (fragText && this.memory && this.memory.data) {
                    if (!Array.isArray(this.memory.data.dreamFragments)) this.memory.data.dreamFragments = [];
                    this.memory.data.dreamFragments.push(fragText.slice(0, 400));
                    if (this.memory.data.dreamFragments.length > 3) {
                      this.memory.data.dreamFragments = this.memory.data.dreamFragments.slice(-3);
                    }
                    this.memory.save();
                  }
                }
                if (dreamRecord.usage) {
                  this.track(dreamRecord.usage, true, 'dream');
                  // v0.9.9: 计数即落盘（同 summary 口径），防进程退出漏记
                  this.saveStats(true);
                }
              }
            }
          } catch (err) {
            console.error('[Brain] Dream consolidation failed (Fail-Safe):', redactSecrets(err.message));
          }
  }

  /* v2.0 通路 B：生理昏睡极限（纯物理断电，零台词）——
     像人累到极致自己趴下：疲惫 >= 95 且周围安静（>= 5 分钟无对话）时静默沉睡。
     不喊口号、不打招呼，只是睡着了。返回是否真的断电。 */
  checkPhysiologicalCollapse() {
    const tr = this.tracker;
    if (!tr || tr.sleepMode) return false;
    const reg = this.internalRegulation && this.internalRegulation.getState ? this.internalRegulation.getState() : null;
    if (!reg) return false;
    const hit = tr.constructor && typeof tr.constructor.isPhysiologicalCollapse === 'function'
      && tr.constructor.isPhysiologicalCollapse(reg.restPressure, tr.lastUserInputAt);
    if (!hit) return false;
    tr.enterSleepMode(Date.now());
    if (this.internalRegulation && typeof this.internalRegulation.updateOnSleep === 'function') {
      this.internalRegulation.updateOnSleep(true, { timestamp: Date.now() });
    }
    // v3.1 梦境时序改造：真入睡 → 零 LLM，只冻结梦境原料；结算留到苏醒那一刻。
    if (this.isExperimentModuleActive && this.isExperimentModuleActive('sleepConsolidation')) {
      this._freezeDreamStagingForSleep().catch(() => {});
    }
    return true;
  }


  /**
   * 🔴 D-11：问她想不想留下点什么，想的话那句话就是 content。
   *
   * ## 为什么单独一次调用，而不是复用她刚才说的话
   *
   *   她刚才那句是「对用户说的」（比如「你回来啦」），写进文件会串味 ——
   *   读起来像聊天记录，不像她给自己留了东西。
   *   本方法专门问一次，让那句话**指向她自己**。
   *
   * ## 三条硬性边界
   *
   *   1. **允许她说「不」。** 不想留就返回 null，**绝不建案**。
   *      硬凑一句比不写更糟 —— 那是逼她表演，正是 persona.js:29
   *      「装可怜不行」要防的形态。
   *   2. **不编造。** prompt 里明令不许虚构经历/日期/钟点（见 WANT_TO_LEAVE_SYS），
   *      与 persona.js:26/28 两条红线对齐。
   *   3. **失败即 null。** 任何异常都吞掉 —— 这是旁路，不能影响别的东西。
   *
   * ⚠️ 依赖已经离开的「用户不在」状态：调用方应只在 wantToLeaveSomething
   *   意图成立时调它。本方法自身**不判断该不该问**，只负责问和解析。
   *
   * @returns {Promise<?{content:string, usage:object}>} null = 她说不留/失败
   */
  async askForSelfNote(opts = {}) {
    try {
      if (this.shutdownRequested) return null;
      if (this.api && typeof this.api.complete !== 'function') return null;

      // 把「她此刻的状态」如实给她 —— 但**只给方向，不给程序数字**。
      //   ⚠️ 绝不把 idleMinutes 这类程序换算值拼进 prompt：
      //     实测踩过（D-7 那次她真的说出「静了 50000 分钟」），
      //     那既是内部时钟泄漏，也违反 persona.js:28。
      const intentKind = opts.intentKind ? String(opts.intentKind).slice(0, 64) : null;
      const userContent = '【此刻】'
        + '\n用户不在。你独自安静了一段时间 —— 这是事实，不是情绪。'
        + (intentKind === 'wantToLeaveSomething' ? '\n你想留下点什么。' : '')
        + '\n\n如果你确实想留下点什么，就写下来；不想就说不。';

      const res = await this.api.complete(
        [{ role: 'system', content: WANT_TO_LEAVE_SYS },
         { role: 'user', content: userContent }],
        { maxTokens: 400, temperature: 0.7 }
      );
      const text = String((res && res.text) || '').trim();
      if (res && res.usage) this.track(res.usage, true, 'selfNote');
      if (this.shutdownRequested) return null;

      // 判据 1：她说「不」就是不留。识别几种常见的拒绝写法。
      //   ⚠️ 只认**极短且明确**的拒绝，不要用「含不含某个词」的大网：
      //     那会把「不想留」和「不想留遗憾」混为一谈。
      const refusePatterns = ['不', '不想', '不了', '算了吧', '算了', '没什么想留', '没有'];
      const head = text.slice(0, 12);
      const isRefusal = text.length <= 12 && refusePatterns.some((p) => head.startsWith(p));
      if (!text || isRefusal) return null;

      // 判据 2：长度护栏。这是留给自己的两三句话，不是文章。
      //   超长说明它跑偏了（在写汇报或留言），宁可不要。
      if (text.length > 600) return null;

      return { content: text, usage: (res && res.usage) || null };
    } catch (err) {
      // 判据 3：旁路异常一律吞掉。这是「她安静时想留点什么」，
      //   失败了不该影响任何别的东西。
      return null;
    }
  }
  /**
   * 🔴 D-24（A 段）：关窗铸造 —— 把「她自发写下的字」铸进 experiences.jsonl。
   *
   *   ## 铸什么（范围拍板：只铸自发便签）
   *     memory.selfNotesToEngrave() 的三判据：source==='selfNote'（提案来源由主进程
   *     从执行回执带下来、渲染端不可伪造）、未铸过、内容非空。受托写下的任务产物
   *     不是她的经历，一个字都不铸。
   *
   *   ## 幂等与抗崩溃（防坑锦囊 2）
   *     appendRecord **确认写入成功后**才置 engraved 标记；失败就留着，
   *     下一次关窗重试 —— 宁可重试，绝不漏铸；标记本身落盘，跨重启不重铸。
   *
   *   ## 返回物
   *     facts        ：给 growSelf 的【自发留痕事实】块（只报客观事实，不代拟结论）
   *     attestations ：noteId -> { content, windowNo } 引证件（C 段证据池与 B 段引证核验共用，
   *                    核验仍走 checkMessageReference 同一套判据）
   */
  _engraveSelfNotes(windowNo) {
    const out = { facts: '', attestations: new Map(), minted: 0 };
    const pending = (this.memory && typeof this.memory.selfNotesToEngrave === 'function')
      ? this.memory.selfNotesToEngrave()
      : [];
    if (!pending.length) return out;

    const noteIds = [];
    const mintedObjs = [];
    const factLines = [];
    for (let i = 0; i < pending.length; i++) {
      const n = pending[i];
      const noteId = 'selfnote-w' + windowNo + '-' + Number(n.at || 0) + '-' + i;
      let written = true;
      if (this.experiencesArchive) {
        written = this.experiencesArchive.appendRecord('self_note', windowNo, {
          windowNo,
          noteId,
          content: n.content,
          // 来源戳随记录入档（schema 强制）：只有她自发之举才铸得进自传
          proposalSource: 'selfNote',
          name: n.name || null,
          writtenAt: Number.isFinite(n.at) ? n.at : null,
          writtenWindowNo: Number.isInteger(n.windowNo) ? n.windowNo : null
        });
      }
      // 归档失败不置标记、不进证据池 —— 下窗重试（绝不漏铸、也绝不虚报已铸）
      if (!written) continue;
      noteIds.push(noteId);
      mintedObjs.push(n);
      // 引证件只登记真实铸造成功的条目；windowNo 如实用书写时刻的窗口，
      // 引证核验的窗口匹配把它钉在「这条便签真属于那个窗口」上（不匹配就拒收，宁缺毋滥）
      out.attestations.set(noteId, {
        content: n.content,
        windowNo: Number.isInteger(n.windowNo) ? n.windowNo : windowNo,
        noteId
      });
      factLines.push('- （引证 ' + noteId + '）'
        + String(n.content).slice(0, 200)
        + (n.name ? '〔文件：' + String(n.name).slice(0, 60) + '〕' : ''));
    }
    if (!mintedObjs.length) return out;
    out.minted = mintedObjs.length;
    // 🔴 顺序不可反：先确认归档，最后才置 engraved 并落盘
    if (this.memory && typeof this.memory.markSelfNotesEngraved === 'function') {
      this.memory.markSelfNotesEngraved(mintedObjs, noteIds);
    }
    // 预算克制（与词汇表 Top-5 同款）：最多带 3 条、每条截 200 字，绝不刷屏成长上下文
    out.facts = '【自发留痕事实】以下是你自发写下的字，已铸入你的经历档案（引证 id 可查；客观事实，不是用户输入）：\n'
      + factLines.slice(0, 3).join('\n');
    return out;
  }

  /**
   * 🔴 D-24（C 段）：便签证据 → 特质微调。与主通道**完全同一套判据**：
   *   verifyEvidence（trait 白名单 / 引证核验 / quote 原文子串 / 方向强度边界 / 指纹防重）
   *   → reduce（确定性增量、[-999,999] 硬边界、reducer 参数随记录归档）
   *   → 归档（payload.verifiedEvidence，SubjectState.replay 原样折叠 ⇒ Replay 对称）
   *   → commit（两阶段语义：归档失败回滚暂存，绝不带病提交）。
   *
   *   ## 限流（D-23 同款纪律）
   *     一条便签一窗口最多 1 个证据、每窗最多 3 条、同 noteId 去重；
   *     且便签通道每窗总增量收死到**单档步长**（maxDeltaPerWindow = stepWeight）。
   *
   *   ## 宁缺毋滥
   *     程序绝不代拟人格结论：trait/direction/strength 全部来自成长反思的 traitHint，
   *     且其引证必须过同一套核验 —— 证据不足就一条不过，特质分毫不动。
   */
  _applySelfNoteTraitHints(hints, attestations, msgMap, windowNo) {
    if (!this.subjectState || !Array.isArray(hints) || !hints.length) return null;
    const seen = new Set();
    const items = [];
    for (const h of hints) {
      if (!h || typeof h.noteId !== 'string' || !h.noteId || seen.has(h.noteId)) continue;
      if (typeof h.quote !== 'string' || !h.quote.trim()) continue;
      seen.add(h.noteId);
      items.push({
        trait: h.trait,
        direction: h.direction,
        strength: h.strength,
        messageId: h.noteId,
        quote: h.quote,
        sourceType: 'SELF_NOTE'
      });
      if (items.length >= 3) break;
    }
    if (!items.length) return null;

    const pool = new Map();
    if (msgMap instanceof Map) {
      for (const [k, v] of msgMap) pool.set(k, v);
    } else if (msgMap && typeof msgMap === 'object') {
      for (const [k, v] of Object.entries(msgMap)) pool.set(k, v);
    }
    if (attestations instanceof Map) {
      for (const [k, v] of attestations) pool.set(k, v);
    }

    const staging = this.subjectState.createStagingSnapshot();
    const vr = this.subjectState.verifyEvidence(items, pool, windowNo, { stageOnly: true });
    if (!vr || !Array.isArray(vr.verified) || !vr.verified.length) {
      // 一条都没过核验：回滚暂存，特质分毫不动
      if (staging && typeof this.subjectState.rollbackStage === 'function') {
        this.subjectState.rollbackStage(staging);
      }
      return { added: 0, rejected: (vr && vr.rejected && vr.rejected.length) || 0 };
    }

    const rr = this.subjectState.reduce(vr.verified, windowNo, {
      stageOnly: true,
      canalization: this.isExperimentModuleActive('biographicalCanalization'),
      experimentModules: this.currentWindowSnapshot ? this.currentWindowSnapshot.modules : this.cfg.experimentModules,
      // 🔴 单条便签 ≤ 单档步长：便签通道每窗总增量收死到一档
      maxDeltaPerWindow: this.subjectState.stepWeight
    });
    const changes = (rr && Array.isArray(rr.stateChanges)) ? rr.stateChanges : [];

    // 归档：payload.verifiedEvidence 会被 SubjectState.replay 原样折叠重放（对称性不变式）
    let written = true;
    if (this.experiencesArchive) {
      written = this.experiencesArchive.appendRecord('self_note_state', windowNo, {
        windowNo,
        verifiedEvidence: vr.verified,
        rejectedEvidence: vr.rejected,
        stateChanges: changes,
        source: 'self_note_trait_hint'
      });
    }
    if (!written) {
      // 归档失败回滚暂存 —— Replay 重放不出的增量绝不留在状态里
      if (staging && typeof this.subjectState.rollbackStage === 'function') {
        this.subjectState.rollbackStage(staging);
      }
      return { added: 0, rejected: vr.rejected.length };
    }
    // provenance sidecar 同步（与主通道同款两阶段纪律）
    if (this.experiencesArchive && typeof this.experiencesArchive.updateProvenanceAttestations === 'function') {
      this.experiencesArchive.updateProvenanceAttestations(
        this.subjectState.data.messageAttestations || [],
        this.subjectState.data.evidenceAttestations || []
      );
    }
    const committed = this.subjectState.commit();
    if (!committed) {
      this.subjectState.recoveryPending = true;
      this.subjectState.recoveryPendingReason = 'state_commit_failed';
    }
    return { added: changes.length, rejected: vr.rejected.length };
  }

  async growSelf(dialogue, summary, window, opts = {}) {
    try {
      if (this.shutdownRequested) return 0;
      // v0.9.9 Batch 3: 把当前自我投影喂给成长调用 —— 「对照既有态度」必须有对照物，
      // 否则 oppose 约束是空话；体积由 currentSelfTokenBudget 护栏兜底，不再二次截断
      const selfProjection = this.selfLedger ? this.selfLedger.currentSelfText() : '';
      // v1.0 §4.7 #4：broken 预期以「偏差事实」进成长反思 —— 只报客观事实，不代拟结论（架构评审提醒 3）
      const brokenFacts = ((this.memory && this.memory.data && this.memory.data.expectations) || [])
        .filter((x) => x && x.status === 'broken' && x.windowNo === window)
        .map((x) => '【偏差事实】曾预期「' + x.text + '」，但本窗未兑现（引证 ' + ((x.outcome && x.outcome.messageId) || '—') + '）')
        .join('\n');
      // 🔴 D-24：自发留痕事实 —— 她自发写下的字（A 段已铸入经历档案）。
      //   与 brokenFacts 同款纪律：只报客观事实，不代拟结论；引证 id 可回查档案。
      const selfNoteFacts = (typeof opts.selfNoteFacts === 'string' && opts.selfNoteFacts.trim())
        ? opts.selfNoteFacts : '';
      const userContent = '【当前自我投影】\n' + (selfProjection || '暂无')
        + (brokenFacts ? '\n\n' + brokenFacts : '')
        + (selfNoteFacts ? '\n\n' + selfNoteFacts : '')
        + '\n\n【窗口小结】\n' + summary
        + '\n\n【窗口对话】\n' + dialogue;
      const apiCompleteRes = await this.api.complete(
        [{ role: 'system', content: GROWTH_SYS },
         { role: 'user', content: userContent }],
        { maxTokens: this.cfg.growthMaxTokens || 4000, temperature: 0.15 }
      );
      const { text, usage, observedModel } = apiCompleteRes;
      this.track(usage, true, 'growth');
      if (this.shutdownRequested) return 0;
      this.stats.growthCalls = (this.stats.growthCalls || 0) + 1;
      this._notePossibleTruncation(usage, this.cfg.growthMaxTokens || 4000, '成长提炼');
      // v0.9.9: 计数即落盘（同 summary 口径）—— 这笔成长调用已真实发生，立即持久化，
      // 杜绝进程退出后 growthCalls 漏记（实测 1 笔成长调用就这么丢了）
      this.saveStats(true);
      const raw = String(text || '').trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      const growthPromptHashes = collectPromptHashes({
        growth: GROWTH_SYS,
        summary: SUMMARY_SYS,
        persona: PERSONA,
        merge: MERGE_SYS
      });

      const growthGenCtx = buildGenerationContext({
        kind: 'growth',
        cfg: this.cfg,
        promptHashes: growthPromptHashes,
        sampling: { maxTokens: this.cfg.growthMaxTokens || 4000, temperature: 0.15 },
        sourceWindowNo: window,
        sourceMessageRange: opts.sourceMessageRange || null,
        observedModel,
        providerResponse: apiCompleteRes,
        generator: 'llm'
      });

      const rejected = [];
      const appendMeta = {
        window,
        generation: growthGenCtx,
        rejected,
        // v0.9.9 P1-d (D2)：账本淘汰条目转存归档（遗忘非物理删除）
        onEvict: (items) => this._archiveEvictedLedgerEntries(items, window, growthGenCtx)
      };
      if (opts.msgMap) {
        // 🔴 D-24：证据池并入「已铸造的自发留痕」引证件（key = noteId）。
        //   只有 A 段真实铸进 experiences.jsonl 的条目才进这张表；
        //   引证核验仍走 checkMessageReference 同一套判据（quote 原文子串、窗口号、防伪），
        //   绝不为便签另立第二套宽松规则。
        const pool = new Map();
        if (opts.msgMap instanceof Map) {
          for (const [k, v] of opts.msgMap) pool.set(k, v);
        } else if (opts.msgMap && typeof opts.msgMap === 'object') {
          for (const [k, v] of Object.entries(opts.msgMap)) pool.set(k, v);
        }
        if (opts.selfNoteAttestations instanceof Map) {
          for (const [k, v] of opts.selfNoteAttestations) pool.set(k, v);
        }
        appendMeta.verify = {
          msgMap: pool,
          windowNo: window
        };
      }

      const parsedEntries = JSON.parse(raw);
      const added = this.selfLedger.append(parsedEntries, appendMeta);
      // 🔴 D-24 C 段取材口：只从「引证了自发留痕」的成长条目上取 traitHint。
      //   这些 hint 只是**待核验证据素材**，真正能否动特质由调用方走
      //   subjectState.verifyEvidence → reduce 的正规通道裁决（同一套判据、同一套边界）；
      //   本层零数值改动、零当场生效 —— 生效统一在关窗结算（护前缀缓存不变式）。
      if (Array.isArray(opts.traitHintsOut)) {
        for (const e of (Array.isArray(parsedEntries) ? parsedEntries : [])) {
          const hint = e && e.traitHint;
          if (!hint || typeof hint !== 'object') continue;
          const cite = (Array.isArray(e && e.support) ? e.support : [])
            .map((s) => (s && Array.isArray(s.messageIds)) ? s.messageIds.map(String) : [])
            .reduce((acc, ids) => acc.concat(ids), [])
            .find((id) => id.indexOf('selfnote-') === 0);
          if (!cite) continue;
          const cited = (Array.isArray(e.support) ? e.support : [])
            .find((s) => s && Array.isArray(s.messageIds) && s.messageIds.map(String).indexOf(cite) >= 0);
          opts.traitHintsOut.push({
            noteId: cite,
            quote: String((cited && cited.quote) || ''),
            trait: String(hint.trait || ''),
            direction: Number(hint.direction),
            strength: Number(hint.strength)
          });
        }
      }
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
        console.error('self growth checkpoint failed:', redactSecrets(e.message));
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
    // P5-A: 成本统计由当前 providerId 的 Cost Strategy 决定（不再由 DeepSeek concrete costOf 记账）。
    // DeepSeek 峰谷价格语义保持（pricing context 仍按 peak/valley 选择）；
    // generic/local/custom 未定义 pricing -> strategy 为 null -> cost=null（不伪造 0、不累加、不隐式继承 DeepSeek 价格）。
    const providerIdForCost = this.cfg.provider || require('./provider-policy').providerFor(this.cfg.baseURL);
    const costStrategy = getCostStrategy(providerIdForCost);
    let c = null;
    if (costStrategy) {
      const peakValleyPrice = (this.cfg.price && (isPeakHour() ? this.cfg.price.peak : this.cfg.price.valley)) || {};
      const pricingContext = {
        ...peakValleyPrice,
        pricingVersion: (this.cfg.price && this.cfg.price.pricingVersion) || undefined
      };
      c = costStrategy.calculate(normalizeUsage(usage, providerIdForCost), pricingContext).cost;
    }
    // E-02: 未知成本（null）不得伪装为 0 —— 不累加、history 显式记 null
    const costKnown = c !== null;
    const hitRateRatio = (hit + miss) ? hit / (hit + miss) : 0;

    let breakReason = null;
    if (miss > 0) {
      if (bucket === 'chat') {
        breakReason = this.pendingCacheBreakReason || (hit === 0 ? 'unknown' : null);
        this.pendingCacheBreakReason = null;
      } else {
        // v0.9.9: 小结/合并/成长/梦境各是独立提示词家族，不消费 chat 的缓存破坏归因
        //（否则会偷走下一轮 chat 的归因），但 0 命中同样要留痕 —— 此前只有 chat 桶标注，
        // 离群的 0% 调用查无原因（实测 37 笔里 4 笔 0%，其中 1 笔至今无归因）
        breakReason = hit === 0 ? 'unknown' : null;
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
      t: Date.now(), hit, miss, out, cost: costKnown ? +c.toFixed(6) : null,
      rate: (hit + miss) ? +(hit / (hit + miss) * 100).toFixed(1) : 0,
      kind: bucket,
      prompt: usage.prompt_tokens || hit + miss
    });
    if (this.stats.history.length > 300) this.stats.history.shift();

    if (costKnown) this.stats.cost += c;
    if (summary) {
      // v0.9.9: 计数按桶如实分账 —— summaryCalls 只数「summary」小结调用，
      // 成长/合并/梦境各有自己的口径；此前四类全挤进 summaryCalls，与遥测 requestType 对不上
      if (bucket === 'summary') {
        this.stats.summaryCalls = (this.stats.summaryCalls || 0) + 1;
      }
      this.stats[bucket + 'PromptTokens'] = (this.stats[bucket + 'PromptTokens'] || 0)
        + (usage.prompt_tokens || hit + miss);
      this.stats[bucket + 'OutputTokens'] = (this.stats[bucket + 'OutputTokens'] || 0) + out;
      if (costKnown) this.stats[bucket + 'Cost'] = (this.stats[bucket + 'Cost'] || 0) + c;
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
      bridgeCount: m.history.filter(x => x.bridge).length,
      // v0.9.9 P0-2（C 半）：主链锁死导致经历溢写到 sidecar 的告警，供上层/人工检查
      archiveSpilloverCount: Array.isArray(this.archiveSpillovers) ? this.archiveSpillovers.length : 0,
      archiveSpilloverLast: (Array.isArray(this.archiveSpillovers) && this.archiveSpillovers.length)
        ? this.archiveSpillovers[this.archiveSpillovers.length - 1]
        : null
    };
  }

  clearMemory() { this.memory.reset(); }

  listSelfLedger() { return this.selfLedger.list(); }
}

module.exports = { Brain, parseState, parseWear, STATES, summarySegmentPlan };
