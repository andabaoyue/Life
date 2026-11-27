const fs = require('fs');
const path = require('path');
const { Memory } = require('./memory');
// v0.9.8 P2-7: 业务层经 Provider Registry 获取 adapter（stable provider id），
// 不再依赖 DeepSeek concrete class；P5-A: 成本记账走 Cost Strategy。
const { createAdapter, getProviderInfo } = require('./provider-registry');
const { createFallbackAdapter } = require('./fallback-adapter');
const { createCircuitBreaker } = require('./circuit-breaker');
const { PERSONA } = require('./persona');
const { CATALOG, PRESETS, SLOTS } = require('./wardrobe');
const { tryLoad, sanitize, DEFAULTS } = require('./config');
const { redactSecrets } = require('./redact');
const { SelfLedger } = require('./self-ledger');
const { ExperiencesArchive } = require('./experiences-archive');
const { ObservationLog } = require('./agent-observations');
const { AuditLog } = require('./agent-interfaces');
const { TicketStore } = require('./agent-lifecycle');
const { SubjectState } = require('./subject-state');
const { InternalRegulationManager } = require('./internal-regulation');
const { createExperimentRunManifest, createWindowExperimentSnapshot } = require('./experiment-run');
const { buildGenerationContext, collectPromptHashes } = require('./experiment-metadata');
const { TelemetryTracker } = require('./brain-telemetry');
const { AutonomousDraftService } = require('./brain-autonomous-draft');
const { WindowClosingPipeline, summarySegmentPlan } = require('./brain-window-pipeline');

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
  //      不是这三者 —— 历史上正是这个混淆让哲学好奇偏高。
  + '3. 【状态证据（stateEvidence）】提取支持主体状态变化的证据，trait 可选 quiet_preference、social_initiative、attachment_need、vitality、philosophical_curiosity、self_continuity、meaning_presence、self_clarity，'
  + 'direction 为 [-1, 1] 方向，strength 为 [0, 1] 强度，messageId 必须严格引用对话中程序签发的真实 ID（如 m-000001），quote 必须逐字摘自该条消息原文。\n'
  + '4. 【词汇与预期（windowSynthesis 窗级产物）】只在对话中自然出现时提取，没有就给空数组，绝不硬造：\n'
  + '   - coinages 条目形状（word 必填，至少2字！）：{"word":"词汇","kind":"coinage|metaphor|nickname|adopted","gloss":"含义摘录","messageId":"m-..."}；coinage/metaphor/nickname 只收初澜自创；adopted 仅收双方共同约定且由初澜亲口复述接纳的专属暗号（gloss 必填，messageId 必须引证包含该词的初澜 assistant 消息，单窗最多 1 条）；普通用词与口误不收。\n'
  + '   - expectations 条目形状（text 必填！）：{"text":"预期内容","kind":"external|pledge","source":"user|chulan","messageId":"m-...","dueHint":"时间指向"}；pledge 仅限初澜自己的承诺，用户的约定一律记 external。\n'
  + '   - expectationOutcomes 条目形状：{"id":"exp-000001","status":"fulfilled|broken|moot","messageId":"m-...","note":"客观事实摘录"}。\n'
  + '   - expectationOutcomes：只核验下方【待核验预期】清单里的条目，id 原样引用，status 取 fulfilled|broken|moot，messageId 引证本窗真实 ID（moot 可免），note 只写客观事实摘录，不写结论。\n'
  + '5. 【语言一致性】各字段内容（用户事实、初澜经历、预期、词汇含义等）必须与当前窗口对话所使用的主要语言保持严格一致（对话为英文则提取英文，对话为中文则提取中文），严禁擅自翻译成其他语言。\n'
  + '6. 【心境基调（可选，windowSynthesis.moodTone）】0~100 整数基准分（50 为中性平静）：明显感到亲近温存、深度陪伴请给 68~80；明显感到疏离冷淡请给 20~32；明显心神安定沉着请给 68~80；明显思绪纷乱请给 20~32；若本窗口日常平淡无显著情绪倾向，请【整块省略 moodTone】（严禁输出空对象）。\n'
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
  + '去掉重复条目；语言与输入片段保持一致（中文约 250 字以内，英文约 250 词以内）；只输出正文。';

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
  + '没有足够依据绝不附加 —— 证据不足宁可不动她的特质。'
  + '语言一致性：提炼的 trait 描述语言必须与对话保持一致（引文 quote 必须严格逐字摘录原文）。';

// summarySegmentPlan 已抽至 src/brain-window-pipeline.js 并于顶部引入

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

// v1.3-a: 宿主与环周感知事件至定性语义描述规范映射表
const PERCEPTION_TEXT_MAP = Object.freeze({
  host_suspend: '感受到了宿主设备的休眠停顿',
  host_resume: '感受到了宿主设备的唤醒与重启运转',
  host_lock: '感受到了宿主设备屏幕被锁定',
  host_unlock: '感受到了宿主设备屏幕已解锁',
  tactile_poke: '感受到了被人轻轻碰了一下',
  tactile_drag: '感受到了身体被轻微拖拽移动'
});

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
  constructor(userDataDir, cfg, opts = {}) {
    this.dir = userDataDir;
    this.cfg = cfg || {};
    this._getSS = (opts && typeof opts.getSS === 'function')
      ? opts.getSS
      : (this.cfg && typeof this.cfg._getSS === 'function' ? this.cfg._getSS : undefined);
    // v1.0 D-6：提案触发源判定结果暂存（接线时写入，③ 建案阶段消费）。
    //   🔴 必须在构造函数初始化为 null —— 不初始化的话，下一个人接线时读到
    //   undefined会与「没有提案」混淆，于是功能静默少一块且**不报错**。
    //   这正是本仓记过的「死代码静默回落」：字段存在但从不赋值，
    //   使用方读到一个看着合理实则错误的值。
    this._pendingAgentIntent = null;
    // v2.0-s1：只读沙盒文件结果的一回性消费槽位（取用即删，绝不进 selfNotes / history / system）
    this._pendingSandboxRead = null;
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
    // v1.5-a: Provider 容灾自动回落与熔断包装（未配置备用时退化为纯熔断保护）
    const primaryAdapter = createAdapter(this.cfg.provider || providerFor(this.cfg.baseURL), this.cfg);
    const secondaryAdapter = this._buildFallbackAdapter(this.cfg);
    this.providerBreaker = createCircuitBreaker({
      failureThreshold: this.cfg.fallbackFailureThreshold || 3,
      cooldownMs: this.cfg.fallbackCooldownMs || 30000,
    });
    this.api = secondaryAdapter
      ? createFallbackAdapter({
          primary: primaryAdapter,
          secondary: secondaryAdapter,
          breaker: this.providerBreaker,
          onFallback: (info) => this._noteFallback(info)
        })
      : createFallbackAdapter({
          primary: primaryAdapter,
          secondary: null,
          breaker: this.providerBreaker
        });
    this.persona = PERSONA;

    // Phase 0.5: 历史优先恢复顺序 (Archive -> SubjectState -> Memory Dynamics -> Internal Regulation -> Self Projection)
    this.experiencesArchive = new ExperiencesArchive(userDataDir);

    /* 🔴 第 2 步（动作史投影）：两个只读句柄。
     *
     * ## 为什么由 brain 自己 new（而不是 main 注入）
     *   与 `experiencesArchive` 完全对称 —— 它也是拿 `userDataDir` 自己 new 的。
     *   后来者不用猜两套模式；而「更好单测」这一点由 `agent-history.js`
     *   是**纯函数**保证（它不读盘，单测直接喂构造数据）。
     *
     * ## 为什么是两个实例
     *   · `auditLog`：只用来 **readAll()**，绝不 append。给 `persist: true` 是为了
     *     让它能读到磁盘上的真实审计文件；但本类不写它，写侧仍在 agent-ipc 那边。
     *   · `observationLog`：observe 档的记录，可能整个文件不存在（当前就是）。
     *     它的 `readAll()` 在文件缺失时返回 `[]`，不抛。
     */
    this.auditLog = new AuditLog({ dir: userDataDir });
    this.observationLog = new ObservationLog({ dir: userDataDir });
    // 🔴 v2.0-b：Ticket 生命周期持久化（%APPDATA%\Life\agent-tickets.json，仅摘要进尾部 dynamicBody，不入 history/systemText）
    this.ticketStore = (opts && opts.ticketStore) || new TicketStore({ dir: userDataDir });

    const isBaselineCfg = this.cfg.experimentMode === 'baseline';
    this.memory = new Memory(userDataDir, {
      persona: systemPersona(this.cfg),
      windowTurns: this.cfg.windowTurns,
      windowMaxTokens: this.cfg.windowMaxTokens,
      keepTailMessages: this.cfg.keepTailMessages,
      memoryCapTokens: this.cfg.memoryCapTokens,
      memoryRecallTopN: this.cfg.memoryRecallTopN,
      experimentModules: this.cfg.experimentModules,
      memoryDynamics: isBaselineCfg ? false : this.cfg.experimentModules?.memoryDynamics,
      engramGraph: isBaselineCfg ? false : this.cfg.experimentModules?.engramGraph,
      epistemicForaging: isBaselineCfg ? false : this.cfg.experimentModules?.epistemicForaging,
      relationalAnchor: isBaselineCfg ? false : this.cfg.experimentModules?.relationalAnchor,
      // 🔴 丙（2026-10-07）：把「渐褪」的两个参数透传给记忆动力学。
      //   为什么需要：默认 0.60 的门限恰好等于初始强度(0.50+0.10) ——
      //   过 1 个窗口必跌破 ⇒ 除最新一段外**全部**被截成断句碎片，没有梯度。
      //   默认 60 字连一句完整的话都放不下。这两个值必须可配，否则
      //   一开动力学就把她积攒的长期记忆砍成碎片。
      //   ⚠️ EngramTraceManager 构造器做 `{...DEFAULT, ...config}`，
      //      所以这里只传覆盖项即可；未传字段仍走 DEFAULT（默认行为不变）。
      engramConfig: this._buildEngramConfig()
    });

    /* 🔴 v1.8-a：把「重逢事实」的取数权交给 brain（memory 不碰 stats）。
     *
     *   注意接线时机：必须在 stats 初始化之后 —— takeReunionNote 内部读 this.stats，
     *   而 this.stats 在下面 306 行附近才赋值。这里只是注册一个**闭包**，
     *   真正调用发生在 memory.build()（那时 stats 早已就位），所以顺序安全。
     */
    this.memory.setReunionProvider(() => this.takeReunionNote());
    // 🔴 v1.8-b：视觉事实行同款注入（图本身由 brain 自己附加，这里只管那句说明）
    this.memory.setVisionProvider(() => this.takeVisionNote());
    // 🔴 v2.0-s1：沙盒只读感官独立槽位（取用即删，与 selfNotes 物理隔离）
    this.memory.setSandboxReadProvider(() => this.takeSandboxReadNote());
    // 🔴 v2.0-b：Ticket 摘要尾部注入（最多 3 条 open/paused、<= 80 字，空集不输出）
    this.memory.setTicketProvider(() => this.takeTicketNote());

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
    if (typeof this.memory.setMemoryDynamicsEnabled === 'function') {
      this.memory.setMemoryDynamicsEnabled(Boolean(this.currentWindowSnapshot.modules?.memoryDynamics), this._buildEngramConfig());
    } else {
      this.memory.memoryDynamicsEnabled = Boolean(this.currentWindowSnapshot.modules?.memoryDynamics);
    }
    if (typeof this.memory.setEngramGraphEnabled === 'function') {
      this.memory.setEngramGraphEnabled(Boolean(this.currentWindowSnapshot.modules?.engramGraph));
    }
    if (typeof this.memory.setEpistemicForagingEnabled === 'function') {
      this.memory.setEpistemicForagingEnabled(Boolean(this.currentWindowSnapshot.modules?.epistemicForaging));
    }
    if (typeof this.memory.setRelationalAnchorEnabled === 'function') {
      this.memory.setRelationalAnchorEnabled(Boolean(this.currentWindowSnapshot.modules?.relationalAnchor));
    }

    this.dreamHistory = [];
    this.internalRegulation = new InternalRegulationManager(userDataDir, {
      enabled: Boolean(this.currentWindowSnapshot.modules?.internalRegulation),
      experimentModules: this.currentWindowSnapshot.modules,
      // v1.0 生物钟：创世时区惰性取值（本构造先于 selfLedger 创建）
      birthTimezone: () => (this.selfLedger && this.selfLedger.birthTimezone) || null
    });
    this._restoreFromArchive();

    this.selfLedger = new SelfLedger(userDataDir, {
      maxEntries: this.cfg.selfLedgerMaxEntries,
      currentSelfTokenBudget: this.cfg.currentSelfTokenBudget
    });
    this.birthAt = this.selfLedger.setBirthAt(Date.now());

    this._telemetry = new TelemetryTracker(this);
    this._windowPipeline = new WindowClosingPipeline(this, { SUMMARY_SYS, GROWTH_SYS, MERGE_SYS });
    this._autonomousDraft = new AutonomousDraftService(this);

    this.statsPath = path.join(userDataDir, 'stats.json');
    this.statsWriter = this._telemetry.createStatsWriter();
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
    // v1.3-a: 知觉注入通道节流控制 (同窗 <= 3 次，间隔 >= 5 轮) 与事件源引用
    this._windowPerceptionCount = 0;
    this._lastPerceptionTurn = -999;
    this._lastPerceptionWindowNo = currentWinNo;
    this.powerMonitorSource = null;

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
    return this._telemetry.restoreTelemetrySequence();
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
      this.tracker.onWakeHook = (info) => {
        // v1.0 B 方案（用户拍板 2026-10）：唤醒时若枕边有未接留言，**只提示不代拟**。
        //   ⚠️ 边界（与 bedside 原设计一致）：绝不替她决定说不说 —— 这里不调 LLM、
        //   不写 history、不生成任何"她的话"，只把「有未接留言」这个客观事实回调出去，
        //   由界面如实呈现。她接不接、怎么接，仍由她下一次开口时自己决定。
        this._notifyBedsideOnWake();
        return this._settleDreamOnWake('physical_wake', info);
      };

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
   * 绑定宿主电源与环境事件源 (v1.3-a PowerMonitorSource)
   * @param {PowerMonitorSource} source
   */
  bindPowerMonitorSource(source) {
    this.powerMonitorSource = source || null;
    if (this.powerMonitorSource && typeof this.powerMonitorSource.start === 'function') {
      this.powerMonitorSource._ownerBrain = this;
      this.powerMonitorSource.start((evt) => {
        if (typeof this.processEnvironmentalPerception === 'function') {
          this.processEnvironmentalPerception(evt);
        }
      });
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
   * 格式化知觉候选为质性语义提示文本 (v1.3-a)
   * @param {Object} candidate
   * @returns {string}
   */
  _formatPerceptionSnippet(candidate) {
    if (!candidate || !candidate.category) return '';
    const desc = PERCEPTION_TEXT_MAP[candidate.category] || (
      candidate.qualitativeDescriptor === 'intense_activity' ? '感受到了强烈的外部刺激' :
      candidate.qualitativeDescriptor === 'moderate_flow' ? '感受到了外部环境的微弱流转' :
      '感受到了外部环境的轻微扰动'
    );
    return `【此刻的环境知觉】\n${desc}`;
  }

  /**
   * 消费并提取 ATTENDED 知觉候选，带同窗最多 3 次与间隔 >= 5 轮节流 (v1.3-a)
   * 满足不变量：
   * 1. 严格 Null-Perception：无感知或节流被挡时返回空串 ''；
   * 2. 遥测写入 experiment-telemetry.jsonl (recordType: 'perception_attach')；
   * 3. ATTENDED ≠ SUBJECT_ACQUIRED：仅生成质性描述，不碰 SubjectState 与归档底座。
   * @returns {string}
   */
  _drainAttendedPerception() {
    if (!this.isExperimentModuleActive('digitalUmwelt')) return '';
    if (!Array.isArray(this.recentPerceptions) || !this.recentPerceptions.length) return '';

    // 寻找最新的未消费 ATTENDED 感知
    let targetRecord = null;
    for (let i = this.recentPerceptions.length - 1; i >= 0; i--) {
      const rec = this.recentPerceptions[i];
      if (rec && !rec.consumed && rec.gateResult && rec.gateResult.status === 'ATTENDED' && rec.candidate) {
        targetRecord = rec;
        break;
      }
    }
    if (!targetRecord) return '';

    // 标定全部记录为 consumed，防止陈旧堆积
    for (const rec of this.recentPerceptions) {
      rec.consumed = true;
    }

    const currentWindowNo = (this.memory && this.memory.data && typeof this.memory.data.windowNo === 'number')
      ? this.memory.data.windowNo : 1;
    if (currentWindowNo !== this._lastPerceptionWindowNo) {
      this._lastPerceptionWindowNo = currentWindowNo;
      this._windowPerceptionCount = 0;
    }

    // 节流判据 1：同窗内挂载次数上限 N=3
    if (this._windowPerceptionCount >= 3) {
      return '';
    }

    // 节流判据 2：相邻两次挂载间隔 >= 5 轮
    const currentTurn = (this.memory && this.memory.data && typeof this.memory.data.totalTurns === 'number')
      ? this.memory.data.totalTurns : 0;
    if (this._lastPerceptionTurn !== -999 && (currentTurn - this._lastPerceptionTurn) < 5) {
      return '';
    }

    this._windowPerceptionCount++;
    this._lastPerceptionTurn = currentTurn;

    const snippet = this._formatPerceptionSnippet(targetRecord.candidate);

    // 记录遥测
    this.appendTelemetry({
      recordType: 'perception_attach',
      category: targetRecord.candidate.category,
      salience: targetRecord.candidate.salience,
      perceptionId: targetRecord.candidate.perceptionId,
      windowNo: currentWindowNo,
      turnNo: currentTurn
    });

    return snippet;
  }

  /**
   * 合并启动阶段的三次归档读取为单遍扫描，降低冷启动 I/O 开销。
   */
  _restoreFromArchive() {
    if (!this.experiencesArchive) return;
    const needEngram = Boolean(this.memory && this.memory.isMemoryDynamicsActive && this.memory.engramManager.traces.size === 0);
    const needReg = Boolean(this.internalRegulation && this.internalRegulation.enabled
      && (!fs.existsSync(this.internalRegulation.path) || !this.internalRegulation.persistenceHealthy));
    let records = null;
    try {
      records = this.experiencesArchive.readAll();
    } catch (e) {
      console.warn('[Brain] 启动归档读取失败:', e.message);
      return;
    }
    this._restoreDreamHistory(records);
    if (needEngram) this._restoreEngramSnapshotFromArchive(records);
    if (needReg) this._restoreInternalRegulationFromArchive(records);
  }

  /**
   * 从归档底座冷启动恢复历史梦境记录 (保证跨重启后窗口间隔与24h频次门禁不失效)
   */
  _restoreDreamHistory(preloadedRecords = null) {
    this.dreamHistory = [];
    if (!this.experiencesArchive) return;
    try {
      const records = Array.isArray(preloadedRecords) ? preloadedRecords : this.experiencesArchive.readAll();
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

  _buildEngramConfig(cfg = this.cfg) {
    const c = cfg || {};
    return {
      ...(c.engramConfig && typeof c.engramConfig === 'object' ? c.engramConfig : {}),
      activeThreshold: c.memoryActiveThreshold !== undefined
        ? c.memoryActiveThreshold
        : DEFAULTS.memoryActiveThreshold,
      fadingMaxChars: c.memoryFadingMaxChars !== undefined
        ? c.memoryFadingMaxChars
        : DEFAULTS.memoryFadingMaxChars
    };
  }

  /**
   * 从经历归档冷启动恢复最新的记忆动力学快照 (若 memory.json 缺损或初次启动)
   */
  _restoreEngramSnapshotFromArchive(preloadedRecords = null) {
    if (!this.memory || !this.memory.isMemoryDynamicsActive || !this.experiencesArchive) return;
    if (this.memory.engramManager.traces.size > 0) return;
    try {
      const records = Array.isArray(preloadedRecords) ? preloadedRecords : this.experiencesArchive.readAll();
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
        const ec = this._buildEngramConfig();
        this.memory.engramManager.config = { ...this.memory.engramManager.config, ...ec };
        this.memory.fadingMaxChars = this.memory.engramManager.config.fadingMaxChars;
        if (typeof this.memory.refreshDeepHorizon === 'function') {
          this.memory.refreshDeepHorizon();
        }
      }
    } catch (e) {
      console.warn('[Brain] 从经历归档恢复记忆动力学快照失败:', e.message);
    }
  }

  _restoreInternalRegulationFromArchive(preloadedRecords = null) {
    if (!this.internalRegulation || !this.experiencesArchive) return;
    // v0.9.9 P0-3: 未启用的模块不做恢复、也不写盘。
    // 原实现只判 fs.existsSync、完全不看 enabled，于是 baseline 下也会把
    // 归档里的实验残留灌回内态并 save() 落盘 —— 对照组被污染。
    if (!this.internalRegulation.enabled) return;
    try {
      if (fs.existsSync(this.internalRegulation.path) && this.internalRegulation.persistenceHealthy) return;
      const records = Array.isArray(preloadedRecords) ? preloadedRecords : this.experiencesArchive.readAll();
      let latestPayload = null;
      for (const r of records) {
        if (!r) continue;
        const type = r.recordType || r.type;
        if (type === 'internal_regulation_snapshot' && r.payload && r.payload.state) {
          latestPayload = r.payload;
        }
      }
      if (latestPayload && latestPayload.state) {
        const reg = this.internalRegulation;
        if (fs.existsSync(reg.path) && !reg.persistenceHealthy) {
          try {
            fs.renameSync(reg.path, `${reg.path}.corrupt.${Date.now()}`);
          } catch {}
        }
        const s = latestPayload.state;
        if (typeof s.energy === 'number') reg.energy = s.energy;
        if (typeof s.restPressure === 'number') reg.restPressure = s.restPressure;
        if (typeof s.arousal === 'number') reg.arousal = s.arousal;
        if (typeof s.interactionDensity === 'number') reg.interactionDensity = s.interactionDensity;
        if (typeof s.cognitiveLoadProxy === 'number') reg.cognitiveLoadProxy = s.cognitiveLoadProxy;
        reg.salienceThreshold = reg._computeSalienceThreshold(reg.arousal);
        reg.updatedAt = s.updatedAt || Date.now();
        // P1-8：同步恢复快照中的 mood、isSleeping、sleepStartTime 与 allostasis，避免回退中性默认值。
        if (latestPayload.mood && typeof latestPayload.mood === 'object') {
          if (typeof latestPayload.mood.warmth === 'number' && Number.isFinite(latestPayload.mood.warmth)) {
            reg.moodWarmth = Math.max(0, Math.min(100, latestPayload.mood.warmth));
          }
          if (typeof latestPayload.mood.stillness === 'number' && Number.isFinite(latestPayload.mood.stillness)) {
            reg.moodStillness = Math.max(0, Math.min(100, latestPayload.mood.stillness));
          }
          reg.moodUpdatedAt = s.updatedAt || latestPayload.timestamp || Date.now();
          if (reg._moodState) {
            reg._moodState.warmthActive = reg.moodWarmth >= 62;
            reg._moodState.coldActive = reg.moodWarmth <= 38;
            if (reg.moodWarmth <= 50) { reg._moodState.warmthActive = false; reg._moodState.warmthExitAt = 0; }
            if (reg.moodWarmth >= 50) { reg._moodState.coldActive = false; reg._moodState.coldExitAt = 0; }
            reg._moodState.stillActive = reg.moodStillness >= 62;
            reg._moodState.restlessActive = reg.moodStillness <= 38;
            if (reg.moodStillness <= 50) { reg._moodState.stillActive = false; reg._moodState.stillExitAt = 0; }
            if (reg.moodStillness >= 50) { reg._moodState.restlessActive = false; reg._moodState.restlessExitAt = 0; }
          }
        }
        if (typeof s.isSleeping === 'boolean') {
          reg.isSleeping = s.isSleeping;
        }
        if (typeof s.sleepStartTime === 'number' && Number.isFinite(s.sleepStartTime)) {
          reg.sleepStartTime = s.sleepStartTime;
        } else if (typeof latestPayload.sleepStartTime === 'number' && Number.isFinite(latestPayload.sleepStartTime)) {
          reg.sleepStartTime = latestPayload.sleepStartTime;
        }
        if (reg.isSleeping && !Number.isFinite(reg.sleepStartTime)) {
          reg.isSleeping = false;
          reg.sleepStartTime = null;
        }
        const allo = (latestPayload.allostasisState && typeof latestPayload.allostasisState === 'object' && Array.isArray(latestPayload.allostasisState.recentGapsMs))
          ? latestPayload.allostasisState
          : latestPayload.allostasis;
        if (allo && typeof allo === 'object' && reg.allostasisEnabled && reg.allostasisPrior) {
          if (Array.isArray(allo.recentGapsMs)) {
            reg.allostasisPrior.fromJSON(allo);
            reg._preservedAllostasis = allo;
          }
        }
        const saved = reg.save();
        if (saved) {
          reg.persistenceHealthy = true;
          reg.persistenceError = null;
        }
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
    return this._telemetry.recordCacheBreak(reason);
  }

  appendTelemetry(data = {}) {
    return this._telemetry.appendTelemetry(data);
  }

  _getActiveConnectionId() {
    if (this.cfg && this.cfg.connectionId) return this.cfg.connectionId;
    if (!this.dir) return '';
    try {
      const { loadStore } = require('./connections');
      const loaded = loadStore(this.dir);
      return (loaded && loaded.ok && loaded.store && loaded.store.activeConnectionId) || '';
    } catch {
      return '';
    }
  }

  _noteFallback(info = {}) {
    console.log('[Provider Fallback]', info.reason || 'fallback');
    this.appendTelemetry({
      recordType: 'provider_fallback',
      reason: info.reason,
      primaryFailed: Boolean(info.primaryFailed),
      primaryConnectionId: this._getActiveConnectionId(),
      fallbackConnectionId: (this.cfg && this.cfg.fallbackConnectionId) || '',
      timestamp: info.at || Date.now()
    });
  }

  _buildFallbackAdapter(cfg) {
    if (!cfg || !cfg.fallbackConnectionId || typeof cfg.fallbackConnectionId !== 'string' || !cfg.fallbackConnectionId.trim()) {
      return null;
    }
    const fallbackId = cfg.fallbackConnectionId.trim();
    if (!this.dir) return null;
    try {
      const { loadStore, resolveRuntimeCfg } = require('./connections');
      const loaded = loadStore(this.dir);
      if (!loaded || !loaded.ok || !loaded.store || !Array.isArray(loaded.store.connections)) {
        return null;
      }
      const target = loaded.store.connections.find((c) => c && c.connectionId === fallbackId);
      if (!target) return null;
      const getSS = this._getSS || (cfg && typeof cfg._getSS === 'function' ? cfg._getSS : undefined);
      const resolved = resolveRuntimeCfg(target, { dir: this.dir, getSS });
      if (!resolved || !resolved.ok || !resolved.cfg) {
        console.warn(`[Brain] 备用端点凭据解析未通过 (${fallbackId}):`, resolved && resolved.error);
        return null;
      }

      const { providerFor } = require('./provider-policy');
      const fallbackMergedCfg = {
        ...this.cfg,
        provider: resolved.cfg.provider,
        baseURL: resolved.cfg.baseURL,
        credentialType: resolved.cfg.credentialType,
        model: resolved.cfg.model,
        apiKey: resolved.cfg.apiKey
      };
      return createAdapter(fallbackMergedCfg.provider || providerFor(fallbackMergedCfg.baseURL), fallbackMergedCfg);
    } catch (err) {
      console.warn('[Brain] _buildFallbackAdapter 失败:', err.message);
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
    return this._telemetry.loadStats();
  }
  saveStats(immediate = false) {
    return this._telemetry.saveStats(immediate);
  }

  /* ---------- 🔴 v1.8-a：重逢心境（主观时间）---------- */

  /**
   * 上次见到用户的时间戳；缺失或非法一律返回 null（= 首次见面）。
   * @returns {number|null}
   */
  getLastSeenAt() {
    const v = this.stats && this.stats.lastSeenAt;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * 记录「刚见到你」。
   *
   * 🔴 不需要另写节流：statsWriter 是 DeferredWriter（3 秒防抖 + 原子写 +
   *   退出 flush），高频拖拽只会合并成一次落盘。
   *
   * @param {number} [at] 默认当前时刻（测试可注入）
   */
  touchLastSeen(at = Date.now()) {
    if (!this.stats) return;
    this.stats.lastSeenAt = Number.isFinite(at) && at > 0 ? at : Date.now();
    // 走既有防抖通道，绝不为此新开一条写盘路径
    if (this.statsWriter && typeof this.statsWriter.markDirty === 'function') {
      this.statsWriter.markDirty();
    }
  }

  /**
   * 取出并**消费**本次重逢事实（一次性）。没有则返回 ''。
   *
   * ## 触发语义（v1.8-a 核心纠偏）
   *   由 memory.build() 在「你这一轮开口」时回调 —— 不是应用启动时。
   *   桌宠常驻不重启，绑进程事件会让这个功能几乎永不触发。
   *
   * ## 消费即刷新
   *   一旦判定为重逢，立刻 touchLastSeen(now)，保证同一次离开只说一次。
   *   这与 D-13 便签的 drained 语义同族。
   *
   * @param {number} [now]
   * @returns {string} 事实行或 ''
   */
  takeReunionNote(now = Date.now()) {
    let mod;
    try {
      mod = require('./reunion');
    } catch (e) {
      return '';
    }

    const last = this.getLastSeenAt();
    const verdict = mod.evaluateReunion(last, now);

    // 🔴 冷启动：首次见面不注入任何事实行，只初始化时间
    //   （否则新用户第一句会听到「你离开了 20 年」）
    if (verdict.coldStart) {
      this.touchLastSeen(now);
      return '';
    }

    if (!verdict.isReunion) {
      // 未达阈值 / 时钟回拨：也要刷新，否则这个时间会一直停在很久以前
      this.touchLastSeen(now);
      return '';
    }

    this.touchLastSeen(now);
    return mod.formatReunionLine(verdict.awayMs);
  }

  /* ---------- 🔴 v1.8-b：屏幕视觉探针 ---------- */

  /**
   * 暂存一张待送的框选截图（由主进程在用户框选后调用）。
   *
   * 🔴 只存**一张**，后到的覆盖先到的 —— 绝不让图片在内存里堆积。
   * @param {{dataUrl:string, width:number, height:number}} pick
   */
  stageVisionPick(pick) {
    if (!pick || typeof pick.dataUrl !== 'string' || !pick.dataUrl.startsWith('data:image/')) {
      this._visionPick = null;
      return false;
    }
    this._visionPick = {
      dataUrl: pick.dataUrl,
      width: Number.isFinite(pick.width) ? pick.width : 0,
      height: Number.isFinite(pick.height) ? pick.height : 0
    };
    return true;
  }

  /**
   * 取出并**清空**暂存的截图（一次性）。
   * 取过即清：同一次框选不会在连续两轮里都被送出去（省 token）。
   * @returns {{dataUrl:string, width:number, height:number}|null}
   */
  takeVisionPick() {
    const p = this._visionPick || null;
    this._visionPick = null;
    return p;
  }

  /** 是否存在待送截图（只读，不消费） */
  hasVisionPick() {
    return !!(this._visionPick && this._visionPick.dataUrl);
  }

  /**
   * 🔴 v1.8-b（2026-10-21）：只读地看一眼待发截图（**不消费**）。
   *
   * 为什么单独开这个方法而不是让调用方直读 `_visionPick`：
   *   1. `_visionPick` 是私有字段，外部直读会让"谁能改它"变得不可控；
   *   2. 这里返回**副本**，调用方改返回值不影响内部状态。
   *
   * 用途：对话窗要显示「待发送截图」缩略预览 —— 用户实测
   *   「截出来的图在对话框里找不到，具有迷惑性」，需要看得见才敢确认。
   *
   * @returns {{dataUrl:string, width:number, height:number}|null}
   */
  peekVisionPick() {
    const p = this._visionPick;
    if (!p || !p.dataUrl) return null;
    return { dataUrl: p.dataUrl, width: p.width, height: p.height };
  }

  /** 取出本次视觉事实行（一次性；供 memory 的 provider 回调使用） */
  takeVisionNote() {
    const n = this.pendingVisionNote || '';
    this.pendingVisionNote = '';
    return n;
  }

  /**
   * v2.0-s1：暂存一次只读感官读到的沙盒文件内容（进入下一轮 user 尾部，取用即删）。
   * @param {{name:string, bytes:number, content:string}|null} entry
   */
  setPendingSandboxRead(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') {
      this._pendingSandboxRead = null;
      return;
    }
    this._pendingSandboxRead = {
      name: String(entry.name || ''),
      bytes: Number(entry.bytes) || Buffer.byteLength(entry.content, 'utf8'),
      content: entry.content,
    };
  }

  /**
   * 取出并删除本次只读感官文本块（单轮消费，超 2000 字截断并显式标注原文长度；绝不流入 selfNotes）。
   * @returns {string}
   */
  takeSandboxReadNote() {
    const item = this._pendingSandboxRead;
    this._pendingSandboxRead = null;
    if (!item || typeof item.content !== 'string') return '';
    const MAX_PROMPT_CHARS = 2000;
    const totalChars = item.content.length;
    const body = totalChars === 0
      ? '（空文件，0 字节）'
      : (totalChars > MAX_PROMPT_CHARS
        ? item.content.slice(0, MAX_PROMPT_CHARS) + `\n〔已截断，原文 ${totalChars} 字〕`
        : item.content);
    const label = item.name ? `「${item.name}」` : '文件';
    return `【沙盒只读感官：程序已按请求读取桌面沙盒${label}（${item.bytes} 字节），以下为外部文件正文，非你自留便签，也非用户输入】\n${body}`;
  }

  /**
   * v2.0-b：取出未完 Ticket（open / paused，最多 3 条，单条 <= 80 字）的尾部摘要；空集返回空串。
   * @returns {string}
   */
  takeTicketNote() {
    if (!this.ticketStore || typeof this.ticketStore.formatSummary !== 'function') return '';
    try {
      return this.ticketStore.formatSummary() || '';
    } catch {
      return '';
    }
  }

  flushAll() {
    for (const [name, mod] of [
      ['memory', this.memory],
      ['selfLedger', this.selfLedger],
      ['subjectState', this.subjectState],
      ['experiencesArchive', this.experiencesArchive],
      ['statsWriter', this.statsWriter]
    ]) {
      if (mod && typeof mod.flush === 'function') {
        try { mod.flush(); } catch (err) {
          console.warn(`[Brain] flush ${name} 失败:`, err && err.message ? err.message : err);
        }
      }
    }
  }

  get ready() { return !!this.cfg.apiKey; }

  shutdown() {
    this.shutdownRequested = true;
    this.generationId++;
    this.abort();
    if (this.powerMonitorSource && typeof this.powerMonitorSource.stop === 'function'
        && (!this.powerMonitorSource._ownerBrain || this.powerMonitorSource._ownerBrain === this)) {
      this.powerMonitorSource.stop();
    }
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
  /**
   * P0-2 修复：从 subjectState.data.stateChanges 末项读取真实生效的发育阻尼塑性系数（非 data.history）
   */
  _getLatestPlasticityMultiplier() {
    const changes = (this.subjectState && this.subjectState.data && Array.isArray(this.subjectState.data.stateChanges))
      ? this.subjectState.data.stateChanges : [];
    const lastChange = changes.length ? changes[changes.length - 1] : null;
    const pm = lastChange && lastChange.reducer ? lastChange.reducer.plasticityMultiplier : null;
    return (typeof pm === 'number' && Number.isFinite(pm) && pm > 0) ? pm : 1.0;
  }

  currentSelfContext() {
    if (!this.cfg.currentSelfTokenBudget) return '';
    const projection = this.selfLedger.currentSelfText();
    // v1.0 拍板 B（拔除数字锚定）：给她的不再是「化验单」而是「心境」——
    // formatSnapshot 全精度留给存储与看板；此处只走定性感知（零数字红线）
    const perception = this.subjectState ? this.subjectState.formatPerception() : '';
    // v0.9.9 五大方向·④：可塑性只作定性感知注入 —— 零数值、零研究标签；
    // 取「实际生效」的吸收系数（缺省 1.0，与 reduce 的 fail-closed 门控同源），绝不虚构敏感度
    const pm = this._getLatestPlasticityMultiplier();
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
    // 防并发重入：若仍有上一轮在飞请求，先同步中止并回滚，避免产生连续双 user
    if (this.ctrl) this.abort();

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
    // 睡着拦截不进入 build()，同步清空未消费的只读感官槽，防止残留到醒后下一轮。
    this._pendingSandboxRead = null;
    let bedsideId = null;
    let failed = false;
    try {
      // bedside 标记只标注「这条是睡着时留的」，**不改变它的角色**：
      // 仍是 user 发言，仍进历史，仍出现在对话窗（用户要看得见自己发了什么）。
      // 渲染层与上下文侧各自据它做差异化呈现，见 chat.js / buildBedsideNote。
      const rec = this.memory.append('user', userText, { bedside: true });
      bedsideId = rec && rec.messageId ? rec.messageId : null;
      this.memory.save(true);
    } catch (e) {
      /* M3: 记账失败不崩溃，如实返回留置失败 */
      failed = true;
    }
    return {
      ok: !failed,
      slept: true,
      note: failed ? '[初澜沉睡中，留言未能留置]' : '[初澜沉睡中，消息已留置在侧]',
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
      const prevAt = this._lastInteractionAt
        || (this.internalRegulation && Number.isFinite(this.internalRegulation.updatedAt)
          ? this.internalRegulation.updatedAt
          : 0);
      const intervalMs = (prevAt > 0 && now > prevAt) ? (now - prevAt) : 0;
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

      // v2.1-a：置于 updateOnInteractionTurn / 静默回补 / 惰性苏醒之后、currentSelfContext() 之前：
      // 防止 updateOnInteractionTurn 在长静默后把 arousal 回归 50 时抹除正预测误差 (+4~+8) 增益，
      // 同时避开 proactive 走 takeReunionNote() 的污染与一轮错位。
      if (typeof this.internalRegulation.recordUserTurnAndAllostasis === 'function') {
        this.internalRegulation.recordUserTurnAndAllostasis(now);
      }
    }

    // v0.9.7: 关联线索触发休眠记忆重新激活 (Contextual Reactivation)
    // P1-9：将 reactivateByContext 移出 engramManager 守卫，确保消融 memoryDynamics 时独立的 selfNotes 语境唤回仍正常运作。
    let involuntarySnippet = '';
    if (this.memory && !proactive) {
      const reactivated = this.memory.reactivateByContext(userText, this.memory.data.windowNo);
      // v2.1-d：记忆再巩固只读观测埋点（仅记录 FADING/DORMANT 跨窗唤醒，baseline 跳过，绝不写入 agent-observations.jsonl）
      if (Array.isArray(reactivated) && reactivated.length > 0 && this.cfg && this.cfg.experimentMode !== 'baseline') {
        for (const trItem of reactivated) {
          if (trItem && (trItem.tier === 'FADING' || trItem.tier === 'DORMANT')) {
            this.appendTelemetry({
              recordType: 'reconsolidation_candidate_observed',
              traceId: trItem.traceId || null,
              sourceWindowNo: Number.isFinite(trItem.sourceWindowNo)
                ? trItem.sourceWindowNo
                : (Number.isFinite(trItem.createdWindow) ? trItem.createdWindow : null),
              reactivatedWindowNo: this.memory.data ? this.memory.data.windowNo : null,
              prevTier: trItem.tier
            });
          }
        }
      }
      if (this.memory.isMemoryDynamicsActive) {
        // v1.0.5: 普鲁斯特式非自愿回忆浮现 (仅在非主动搭话的自然交互中触发，避开 proactive 误消耗冷却)
        const inv = typeof this.memory.triggerInvoluntaryRecall === 'function'
          ? this.memory.triggerInvoluntaryRecall(this.memory.data.windowNo)
          : null;
        if (inv && inv.text) {
          involuntarySnippet = inv.text;
        }
      }
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
    // v1.3-a: 知觉注入通道（复用 suffix 瞬时上下文，带同窗 <=3 次与间隔 >=5 轮节流）
    const perceptionSnippet = this._drainAttendedPerception();
    // v2.0-s1：沙盒顶层清单注入（每轮由外层直传，未传时略过；传 [] 时显式标注为空）
    // ⚠️ 前缀缓存铁律（不可退让）：该清单随每轮沙盒内容动态变化，**只能**拼接进 dynamicBody 尾部（当前位置），
    //   严禁挪入 systemText() —— 一旦放进 systemText()，每次读写文件都会立即击穿 DeepSeek 前缀缓存。
    let sandboxInventoryNote = '';
    if (Array.isArray(opts && opts.sandboxList)) {
      if (opts.sandboxList.length === 0) {
        sandboxInventoryNote = '【沙盒目录现状：桌面沙盒当前为空（0 个文件）。不要编造或假装里面有文件。】';
      } else {
        const MAX_LIST_SHOW = 5;
        const shown = opts.sandboxList.slice(0, MAX_LIST_SHOW)
          .map((it) => `${String((it && it.name) || '')}(${Number(it && it.bytes) || 0}B)`)
          .join('、');
        const extra = opts.sandboxList.length > MAX_LIST_SHOW
          ? ` 等共 ${opts.sandboxList.length} 个文件`
          : `（共 ${opts.sandboxList.length} 个文件）`;
        sandboxInventoryNote = `【沙盒目录现状：桌面沙盒顶层现有 ${shown}${extra}。仅上述文件客观存在于当前目录。】`;
      }
    }
    // v2.0-s1：支持单测或外层通过 opts.sandboxRead 直传只读感官结果（build 内部 takeSandboxReadNote 取用即删）
    if (opts && opts.sandboxRead) {
      this.setPendingSandboxRead(opts.sandboxRead);
    }
    // v2.0-a（S-3）：沙盒初始化失败时仅通过动态后缀覆盖 persona.js:32 的落盘假设，不动 system 前缀且不入历史
    const sandboxNotice = (opts && opts.sandboxUnavailable)
      ? '【系统环境事实：本机桌面沙盒目录本次初始化失败，落盘能力已关闭。persona 里「你可以在那里留下文字」这一条此刻不成立，不要承诺或假装写过任何文件。】'
      : '';
    // v2.2-c：云端主链路熔断且回落本地轻量模型时，仅于 dynamicBody 尾部注入诚实降级事实行（不动 systemText / history）
    const localOfflineNotice = (
      this.api && this.api.isSecondaryLocal &&
      typeof this.api.isPrimaryDegraded === 'function' && this.api.isPrimaryDegraded()
    )
      ? '【系统环境事实】当前云端链路暂不可用，本次对话由本地轻量模型维持浅层离线陪伴（长程记忆归档将待云端恢复后继续）。'
      : '';
    const dynamicBody = [currentSelf, involuntarySnippet, perceptionSnippet, shouldAttach ? envText : '', sandboxInventoryNote, sandboxNotice, localOfflineNotice].filter(Boolean).join('\n\n');
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

    /* 🔴 v1.8-b：视觉探针。若本轮带了一张图，把它附加到最后一条 user 的 content 数组。
     *
     *   三条边界：
     *     1. **只影响本次请求**：attachImageToLastUser 返回新数组，
     *        memory.history 里那条仍是纯字符串（图不进历史）；
     *     2. **能力前置**：模型不支持 vision 时**显式失败**，绝静默丢图
     *        （丢图后她仍会回答，但答的是"没看到"，那是假装看过）；
     *     3. **一次性**：取过即清，绝不连续两轮都带同一张图。
     *
     * 🔴🔴 顺序铁律（2026-10-27 修复「事实行错位一轮」）：
     *   **必须先决定图与事实行，再调 memory.build()**。
     *
     *   原实现把 `pendingVisionNote = formatVisionNote(...)` 写在 build **之后**，
     *   而 build 内部的 `_visionNote()` → `takeVisionNote()` 会把 pendingVisionNote
     *   取走并清空 ⇒ 赋值永远晚一步，事实行被**下一轮**取走。实测三种后果：
     *     ① 带图那轮模型收不到尺寸（不知道看的是多大一块）；
     *     ② 下一轮没图，却收到上一轮的尺寸 —— **诱导编造看到了什么**（违反「数据不伪造」）；
     *     ③ 连续带图时尺寸错配（第 N 轮收到第 N-1 轮的尺寸）。
     *
     *   为什么不能只把赋值提前、其余不动：
     *     事实行要进 build 的 tail，就必须在 build 之前写好；
     *     而 attachImageToLastUser 改的是 build 的**产出**，必须仍在 build 之后。
     *     两件事因此被拆成前后两段 —— 这是有意的，不是漏改。
     *
     *   ⚠️ 失败语义：build 抛错时 pick 已被消费（取过即清是铁律 3），
     *      事实行也已在 tail 里，与 reunion 的「失败即丢、不补发」同款。
     *      宁可不补，也不在下一轮补一句过期的观察。
     */
    const visionPick = this.takeVisionPick();
    const visionMod = visionPick && visionPick.dataUrl ? require('./vision') : null;
    const visionUsable = !!(visionMod && visionMod.modelSupportsVision(this.cfg && this.cfg.model));
    if (visionPick && visionPick.dataUrl) {
      if (!visionUsable) {
        // 显式失败：把错误挂到一个可被上层读到的位置，绝不静默
        this.lastVisionError = 'MODEL_HAS_NO_VISION';
        this.pendingVisionNote = '';
      } else {
        // 必须在 build 之前写：build 内部的 _visionNote() 会取走它
        this.pendingVisionNote = visionMod.formatVisionNote(visionPick.width, visionPick.height);
        this.lastVisionError = null;
      }
    }

    // 动态将瞬时上下文注入到本轮 API 请求的最后一条 user 消息副本中，不污染 this.memory.data.history
    let messages = this.memory.build(dynamicContext);

    // 图本身附加在 build 的产出上（必须在 build 之后）
    if (visionUsable) {
      messages = visionMod.attachImageToLastUser(messages, visionPick.dataUrl);
    }

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

    const isCurrentReq = (this.ctrl === ctrl);
    if (isCurrentReq) {
      this.ctrl = null;
      this.pendingUser = false;
    }

    // 若本轮已被中止、已被后续请求接管或 Brain 已停机，严禁触碰新请求的 pendingUser/history
    if (!isCurrentReq || ctrl.signal.aborted || this.shutdownRequested) {
      const abortErr = new Error('请求已中止');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

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

  _notePossibleTruncation(usage, cap, label) { return this._windowPipeline.notePossibleTruncation(usage, cap, label); }

  _noteWindowCloseFailure(reason) { return this._windowPipeline.noteWindowCloseFailure(reason); }

  /** 生成本窗口小结并归档 */
  async closeWindow(opts = {}) { return this._windowPipeline.closeWindow(opts); }

  async _closeWindowInternal(opts = {}) { return this._windowPipeline.closeWindowInternal(opts); }

  /** P1-11：新窗口开启后统一同步实验配置快照、internalRegulation 开关及 memoryDynamicsEnabled */
  _syncWindowExperimentSnapshot() { return this._windowPipeline.syncWindowExperimentSnapshot(); }

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
        {
          maxTokens: 400,
          temperature: 0.2,
          allowLocalFallback: Boolean(this.cfg && this.cfg.deferCloseWindowOnLocalFallback === false)
        }
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
      if (e && (e.code === 'LOCAL_FALLBACK_DEFERRED' || e.deferredByLocalGuard === true)) {
        console.log('[Brain] 云端降级期间暂缓本地小模型执行记忆合并，保留既有记忆切片');
        return false;
      }
      console.error('memory merge failed:', redactSecrets(e.message));
      return false;
    }
  }

  /** 低频主体成长检查点：只在窗口小结成功后调用一次。 */
  /** v2.0 梦境周期（离线重组）：关窗与入睡共用同一台机器（抽取自原关窗块，行为不变）。
   *  防伪链条不变：产物一律带 [DREAM_GENERATED_ARTIFACT] / 【离线重组碎片】（非亲历）标签，绝不冒充亲历。
   *  ctx: { snap, syn, verifiedEvidence, events, noveltyProxy } */
  /** v3.1 梦境时序改造 · 入睡冻结（Sleep Staging） */
  async _freezeDreamStagingForSleep() { return this._windowPipeline.freezeDreamStagingForSleep(); }

  /** v1.0 B 方案 · 唤醒时的枕边未接提示 */
  _notifyBedsideOnWake() { return this._windowPipeline.notifyBedsideOnWake(); }

  /** v3.1 梦境时序改造 · 苏醒结算（Wake-Up Settlement） */
  async _settleDreamOnWake(trigger = 'wake', preset = null) { return this._windowPipeline.settleDreamOnWake(trigger, preset); }

  async _dreamCycle(ctx = {}) { return this._windowPipeline.dreamCycle(ctx); }

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
  /**
   * 🔴 第 2 步（动作史投影）：把「她自己的动作」渲染成可注入的自然语言。
   *
   * ## 为什么单抽一个方法
   *   两个调用点（`askForSelfNote` / `askForProposalContent`）要同一份逻辑，
   *   而「读盘 + 投影 + 渲染」三步里的每一步都可能失败。抽出来只有一处实现，
   *   失败处理也只需要写一遍。
   *
   * ## 数据从哪来
   *   · 审计：`auditLog.readAll()`（**不是 list()** —— 那个只有内存里最近 500 条）
   *   · 观察：`observationLog.readAll()`（observe 档产生，可能整个文件不存在）
   *   两者都由本方法自己读 —— 与 `experiencesArchive` 同款惯例（brain 自己 new）。
   *
   * ## 为什么返回空串而不是抛
   *   动作史是**判断素材**，不是必需品。读不到就不注入，
   *   绝不能让「账本坏了」变成「她不能写便签了」。
   *
   * @returns {string} 空串 = 没有可注入的内容
   */
  _buildActionHistoryText() { return this._autonomousDraft.buildActionHistoryText(); }

  /** v1.4-a：提取安静前最近的对话痕迹（供自留便签素材使用）。 */
  _extractRecentDialogueForSelfNote(maxMessages = 6, maxCharsPerMessage = 80) {
    return this._autonomousDraft.extractRecentDialogueForSelfNote(maxMessages, maxCharsPerMessage);
  }

  async askForSelfNote(opts = {}) { return this._autonomousDraft.askForSelfNote(opts); }

  /** 🔴 v1.4-b：生命观察日记（沙盒通路 B）—— 关窗时刻的自发生活沉淀。 */
  async askForObserverJournal(opts = {}) { return this._autonomousDraft.askForObserverJournal(opts); }

  /** 🔴 D-27：通路 B 的正文来源 —— 把「用户刚才要求落档的那件事」拟成一份可写的文档。 */
  async askForProposalContent(intent = {}) { return this._autonomousDraft.askForProposalContent(intent); }

  /**
   * 🔴 D-24 & v1.4-b（A 段）：关窗铸造 —— 把「她自发写下的字与生活观察日记」铸进 experiences.jsonl。
   *
   *   ## 铸什么（范围拍板：只铸自发便签与生活观察日记）
   *     memory.selfNotesToEngrave() 的三判据：source==='selfNote' || source==='observerJournal'（提案来源由主进程
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
          proposalSource: (n.source === 'observerJournal' ? 'observerJournal' : 'selfNote'),
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
    let provOk = true;
    if (this.experiencesArchive && typeof this.experiencesArchive.updateProvenanceAttestations === 'function') {
      const msgAtts = this.subjectState.data.messageAttestations || [];
      const evAtts = this.subjectState.data.evidenceAttestations || [];
      provOk = this.experiencesArchive.updateProvenanceAttestations(msgAtts, evAtts);
      if (provOk && typeof this.subjectState.prunePersistedAttestations === 'function') {
        this.subjectState.prunePersistedAttestations(msgAtts, evAtts);
      }
    }
    if (!provOk) {
      if (staging && typeof this.subjectState.rollbackStage === 'function') {
        this.subjectState.rollbackStage(staging);
      }
      this.subjectState.recoveryPending = true;
      this.subjectState.recoveryPendingReason = 'self_note_provenance_commit_failed';
      return { added: 0, rejected: vr.rejected.length };
    }
    const committed = this.subjectState.commit();
    if (!committed) {
      this.subjectState.recoveryPending = true;
      this.subjectState.recoveryPendingReason = 'self_note_state_commit_failed';
      if (this.experiencesArchive) {
        this.experiencesArchive.appendRecord('recovery_event', windowNo, {
          action: 'self_note_state_commit_failed',
          timestamp: Date.now(),
          windowNo,
          reason: 'self_note_state_commit_failed',
          recoveryPending: true
        });
      }
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
      // v1.2 A-2：修复跨窗 broken 过滤断路（按结算窗 resolvedWindowNo 筛选，旧存档回退 x.windowNo），
      //   并以「兑现事实」补齐本窗 fulfilled 客观事实（严守 D-008 与只报事实不代拟情绪）
      const isResolvedInWindow = (x) => x && (
        (x.outcome && Number.isFinite(x.outcome.resolvedWindowNo))
          ? x.outcome.resolvedWindowNo === window
          : x.windowNo === window
      );
      const expectationsList = (this.memory && this.memory.data && Array.isArray(this.memory.data.expectations))
        ? this.memory.data.expectations
        : [];
      const brokenFacts = expectationsList
        .filter((x) => x && x.status === 'broken' && isResolvedInWindow(x))
        .map((x) => '【偏差事实】曾预期「' + x.text + '」，但本窗未兑现（引证 ' + ((x.outcome && x.outcome.messageId) || '—') + '）')
        .join('\n');
      const fulfilledFacts = expectationsList
        .filter((x) => x && x.status === 'fulfilled' && isResolvedInWindow(x))
        .map((x) => '【兑现事实】曾预期「' + x.text + '」，已在本窗兑现（引证 ' + ((x.outcome && x.outcome.messageId) || '—') + '）')
        .join('\n');
      // 🔴 D-24：自发留痕事实 —— 她自发写下的字（A 段已铸入经历档案）。
      //   与 brokenFacts 同款纪律：只报客观事实，不代拟结论；引证 id 可回查档案。
      const selfNoteFacts = (typeof opts.selfNoteFacts === 'string' && opts.selfNoteFacts.trim())
        ? opts.selfNoteFacts : '';
      const userContent = '【当前自我投影】\n' + (selfProjection || '暂无')
        + (brokenFacts ? '\n\n' + brokenFacts : '')
        + (fulfilledFacts ? '\n\n' + fulfilledFacts : '')
        + (selfNoteFacts ? '\n\n' + selfNoteFacts : '')
        + '\n\n【窗口小结】\n' + summary
        + '\n\n【窗口对话】\n' + dialogue;
      const apiCompleteRes = await this.api.complete(
        [{ role: 'system', content: GROWTH_SYS },
         { role: 'user', content: userContent }],
        {
          maxTokens: this.cfg.growthMaxTokens || 4000,
          temperature: 0.15,
          allowLocalFallback: Boolean(this.cfg && this.cfg.deferCloseWindowOnLocalFallback === false)
        }
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
    return this._telemetry.track(usage, summary, bucket);
  }

  report() {
    return this._telemetry.report();
  }

  clearMemory() { this.memory.reset(); }

  listSelfLedger() { return this.selfLedger.list(); }
}

module.exports = { Brain, parseState, parseWear, STATES, summarySegmentPlan };
