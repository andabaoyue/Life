/**
 * 本地活动追踪器 —— 她在桌面上真实经历的事（被戳、被拖、道过晚安）。
 *
 * 为什么要这个文件：persona 有一条硬边界「绝不假装做过任何事」。
 * 可她原本看不到自己的物理处境：用户戳她 20 下再问"我刚才戳了几下"，
 * 她只能猜 —— 猜就是编造。这里把真实计数攒出来，作为**当轮 user 消息末尾**
 * 的附加块交给模型（绝不进 system，见下），她就能如实回答。
 *
 * 三条设计约束，都是被测出来的，不是审美：
 *
 * 1) **双轨解耦**。"连戳检测"和"如实汇报"要的数据天生冲突：前者只关心
 *    8 秒内，必须快速老化；后者要求"发生过就必须说"，一条都没消费完
 *    就不能丢。混在一个数组里，老化会吞掉待汇报的事件（用户 1 分钟前
 *    戳的 3 下，模型永远不知道）。所以 clickTimes 与 events 分开活。
 *
 * 2) **水位线增量消费**。snapshot() 报"上次汇报之后发生了什么"，
 *    commit(throughSeq) 才划掉。没 commit（请求失败/被打断）就还不掉，
 *    下次如实补上 —— 因此本文件**没有 rollback()**：未提交 = 本来就没消费，
 *    不需要回滚。写一个空 rollback 出来只会让人以为它有语义。
 *
 * 3) **时间可注入**（构造传 now()）。日期算术没有别的可靠测法；
 *    用 setTimeout 真等的测试既慢又会在 CI 上随机红。
 */

class ActivityTracker {
  constructor(opts = {}) {
    this.now = opts.now || Date.now;

    /* ---- 轨 1：物理连戳（快速老化，只服务 8 秒窗口判定） ---- */
    this.clickTimes = [];
    this.pokeWindowMs = opts.pokeWindowMs || 8000;
    this.clickTtlMs = opts.clickTtlMs || 15000;   // 比窗口长一点：别让边界抖动改变判定

    /* ---- 轨 2：遥测流水（按水位线消费，绝不因时间老化而丢） ---- */
    this.seq = 0;
    this.events = [];               // [{ id, type, t }]
    this.lastCommittedSeq = 0;
    this.eventCap = opts.eventCap || 200;
    this.eventKeep = opts.eventKeep || 150;

    /* motionState 由主进程 DesktopMotion 的真实状态更新；idle 不写入环境块，
       只有确实在走动、贴边或图标攀爬时才向模型报告。 */
    /* 容量截断会不会说谎：会。挤掉的都是没消费的事件，于是"被戳 N 次"
       变成下限。宁可把这句写成"至少 N 次"，也不能让她理直气壮地报个错数 ——
       persona 那条「绝不假装做过任何事」同样管到数字。 */
    this.countIsLowerBound = false;

    /* ---- 睡眠 ---- */
    this.sleepMode = false;
    this.sleepStartTime = null;
    this.justWokenUp = false;
    this.wokenUpAt = null;
    this.wokenDurationHours = 0;
    this.wakeupTtlMs = opts.wakeupTtlMs ?? 10 * 60 * 1000;
    // v3.1 梦境时序改造：被唤醒时由Brain 注入的结算钩子（惰性、不阻塞物理判据）。
    // 唤醒本身仍是纯物理事实；梦的结算只是搭这条既有通路顺带发生的事。
    this.onWakeHook = typeof opts.onWake === 'function' ? opts.onWake : null;
    this.motionState = 'idle';
    this.motionLabel = '静止';

    /* ---- 活跃计时：三条都算，自主活动不算 ---- */
    const now = this.now();
    this.lastUserInputAt = now;
    this.lastPhysicalAt = now;
    this.lastConversationAt = now;
    this.spokenDuringIdle = false;
    // 🔴 D-16：自发愿望（wantToLeaveSomething）的**独立**单次刹车。
    //   为什么不能复用 spokenDuringIdle：那个在 30 分钟问候后就置位了，
    //   复用它会让 120 分钟的愿望被一起锁死 —— 那正是 D-15 撞的第一个断点。
    //   为什么也不能只靠 spokenDuringIdle（反重力建议的修法）：120 分钟后
    //   selfIntent 恒为 wantToLeaveSomething，光锁 spokenDuringIdle 挡不住
    //   每 45 秒冷却一过就重复建案。**必须有独立标志。**
    this.selfNoteDuringIdle = false;
    this.lastReportedIdleMin = 0;

    /* ---- Phase 0.5: 内部稳态调节中枢与环境知觉流水线接线 ---- */
    this.internalRegulation = opts.internalRegulation || null;
    this.perceptionPipeline = typeof opts.perceptionPipeline === 'function' ? opts.perceptionPipeline : null;
  }

  setInternalRegulation(provider) {
    this.internalRegulation = provider || null;
  }

  setPerceptionPipeline(pipeline) {
    this.perceptionPipeline = typeof pipeline === 'function' ? pipeline : null;
  }

  /** 用户主动输入。返回"这句是不是晚安"——是晚安就不叫醒她。 */
  recordUserInput(text, at = this.now()) {
    this.lastUserInputAt = at;
    this.spokenDuringIdle = false;
    this.selfNoteDuringIdle = false;   // D-16：用户回来了，这次离开的「已留过」作废
    this.lastReportedIdleMin = 0;
    const intent = ActivityTracker.isSleepIntent(String(text || ''));
    // v2.0 枕边信箱：睡着时消息不再吵醒 —— 只留置（信箱在 brain 层），醒来由她自己决定怎么接
    return intent;
  }

  /**
   * 「晚安」的判据。两个方向都会痛：
   *   漏判 → 用户说晚安了她还在追问，体感是听不懂人话；
   *   误判 → 一句「你困了吗」把她按睡着，等于擅自结束对话。
   * 所以带疑问语气的一律不算。刻意不用 ML/关键词包打分：那没法解释。
   *
   * 🔴 2026-10 修（实测事故）：本判据对**她自己说的话**也生效（brain.ask 的
   *   herSleepIntent 分支），于是「引用/否定」会被误判成入睡意图 ——
   *   真实案例：她回「你再说一声晚安我就应一声，说十声我也站得住——反正我不用睡」，
   *   命中「晚安」+「睡」，回复完成第 7 毫秒就被 enterSleepMode 按回被窝。
   *   语用学上，**引用对方的话**（你说晚安我就…）与**否定**（我不用睡）都不是
   *   「我要睡了」这个言语行为。故补两道防线：否定式与转述式。
   *   ⚠️ 刻意保守：只在出现明确否定/转述标记时放行，不误伤
   *   「我先睡了」「晚安，我躺了」这类真正的入睡宣告（test/tracker.test.js 正反例钉住）。
   */
  static isSleepIntent(text) {
    const t = String(text || '');
    if (/(吗|么|呢|[?？])/.test(t)) return false;
    if (!/(晚安|睡了|先睡|去睡|睡觉|躺了|下线了|先不聊)/.test(t)) return false;
    // 防线① 否定式：明确说「不睡 / 不用睡 / 没睡 / 不困 / 睡不着」→ 不是入睡意图
    if (/(不用|不必|不会|不想|不能|没|不)\s*睡|不困|还没困|睡不着|醒着呢|我刚醒|才刚醒/.test(t)) return false;
    // 防线② 转述/假设式：在**引述对方**或讨论「说晚安」这件事本身 → 不是入睡意图
    //   （「你说晚安我就应一声」「再说一声晚安」「要是你说了晚安」「晚安是什么意思」）
    if (/(你说|你再说|你要是|如果你说|只要你|听到.*晚安|一声晚安|说晚安|晚安是|什么叫晚安|定义)/.test(t)) return false;
    return true;
  }

  /** v2.0 通路 B：生理昏睡极限（纯物理断电，零台词）——
      像人累到极致自己趴下：疲惫 >= 95 且周围安静（>= 5 分钟无对话）时自然沉睡。
      不喊口号、不打招呼，只是睡着了。 */
  static isPhysiologicalCollapse(restPressure, lastUserInputAt, at = Date.now()) {
    if (!(Number(restPressure) >= 95)) return false;
    const last = Number(lastUserInputAt) || 0;
    return (at - last) >= 5 * 60 * 1000;
  }

  /** 记录一次物理事件。type: 'click' | 'drag' */
  record(type, at = this.now(), details = {}) {   // v1.0 安放容错：details.distance 为拖拽位移（缺省按大位移算）
    if (type !== 'click' && type !== 'drag') return this.seq;

    /* 只有真人的触碰才算活跃：以后加自主动作（走动、自检）时也绝不能顺手刷新
       lastPhysicalAt —— 那样 30 分钟挂机判定永远不成立，
       她会在你不在的时候自言自语烧钱。 */
    this.events.push({ id: ++this.seq, type, t: at });

    if (type === 'click') {
      this.clickTimes.push(at);
      this.clickTimes = this.clickTimes.filter(t => (at - t) <= this.clickTtlMs);
    }
    this.lastPhysicalAt = at;
    this.spokenDuringIdle = false;
    this.selfNoteDuringIdle = false;   // D-16：物理互动也算「她回来了」
    this.lastReportedIdleMin = 0;
    // v2.0 摇晃式唤醒（纯物理扰动，零台词）：轻碰 1~4 不醒，短时连击 5 下才摇醒。醒来不冒任何话。
    // v1.0 睡相安放容错（物理尺度判据，无时间窗）：小位移挪动 = 整理桌面/挪位安放，不惊醒；
    // 大位移（>= 80px）或缺省位移 = 大幅拽拉/剧烈摇晃，如常唤醒（fail-safe）。
    if (this.sleepMode) {
      if (type === 'drag') {
        const dist = (details && typeof details.distance === 'number') ? details.distance : Infinity;
        if (dist >= 80) this.wakeUp(at);
      } else {
        const shakes = this.clickTimes.filter((t) => (at - t) <= 3000).length;
        if (shakes >= 5) this.wakeUp(at);
      }
    }

    // Phase 0.5 (P0-3): 真实物理事件直接驱动 InternalRegulationManager，无需等待下一次聊天请求
    if (this.internalRegulation && typeof this.internalRegulation.updateOnActivity === 'function') {
      const kind = type === 'click' ? 'poke' : 'drag';
      this.internalRegulation.updateOnActivity(kind, { count: 1, timestamp: at });
    }

    // Phase 0.5 (P0-2): 环境感知候选流水线直连
    if (typeof this.perceptionPipeline === 'function') {
      this.perceptionPipeline({
        category: type === 'click' ? 'tactile_poke' : 'tactile_drag',
        rawIntensity: type === 'click' ? 75 : 60,
        timestamp: at
      });
    }

    // 只删「已提交且已过 1 分钟」的：未消费的绝不因时间丢
    const expire = at - 60000;
    this.events = this.events.filter(e => e.id > this.lastCommittedSeq || e.t > expire);
    // 长时间不对话时防止无界增长。截断掉的是最新的还是最旧的要看清：
    // 这里留最新一批，被挤掉的有可能还没消费 —— 那"被戳 N 次"就成了下限。
    // 如实标出来，让她说"你好久没理我了"时不会报一个假装精确的错数。
    if (this.events.length > this.eventCap) {
      const dropped = this.events.slice(0, this.events.length - this.eventKeep);
      if (dropped.some(e => e.id > this.lastCommittedSeq)) this.countIsLowerBound = true;
      this.events = this.events.slice(-this.eventKeep);
    }
    return this.seq;
  }

  /** 8 秒滑动窗口内的连戳次数（专供触发判定，与遥测消费互不干扰） */
  recentClicks(windowMs = this.pokeWindowMs, at = this.now()) {
    return this.clickTimes.filter(t => (at - t) <= windowMs).length;
  }

  /** 自主运动由主进程真实状态机更新；不刷新用户活动时间。 */
  setMotionState(state, label) {
    this.motionState = String(state || 'idle');
    this.motionLabel = String(label || '静止');
  }

  get lastInteractionAt() {
    return Math.max(this.lastUserInputAt, this.lastPhysicalAt, this.lastConversationAt);
  }

  /**
   * 生成「当前环境感知」附加块。
   *
   * 位置要紧：**只能进当轮 user 消息末尾，绝不进 system**。
   * 这一串里有静默分钟数，每轮都变 —— 塞进 system 就是每次请求都破一次
   * 前缀缓存（v0.7.1 那条穿着块顺序的教训，同一个物理量）。
   * 放在新追加的 user 消息尾部，历史是只追加的，之前所有字节仍然逐字命中。
   */
  snapshot(at = this.now()) {
    const throughSeq = this.seq;
    const since = this.events.filter(e => e.id > this.lastCommittedSeq && e.id <= throughSeq);
    const clicks = since.filter(e => e.type === 'click').length;
    const drags = since.filter(e => e.type === 'drag').length;
    const idleMin = Math.max(0, Math.round((at - this.lastInteractionAt) / 60000));

    // 唤醒标记过期（TTL 熔断）：唤醒上下文只在"紧接着的那几句"里有意义
    if (this.justWokenUp && (at - this.wokenUpAt > this.wakeupTtlMs)) {
      this.justWokenUp = false;
      this.wokenUpAt = null;
    }

    const lines = ['【当前环境感知】（这是程序里的真实记录，回答相关问题以它为准；自然带过，不要逐条复述）'];
    if (this.justWokenUp) {
      lines.push('- 状态：刚被叫醒，之前已经睡了约 ' + this.wokenDurationHours + ' 小时');
    } else if (this.sleepMode && this.sleepStartTime) {
      lines.push('- 状态：晚安中（已睡约 ' + ((at - this.sleepStartTime) / 3600000).toFixed(1) + ' 小时）');
    } else {
      if (this.motionState !== 'idle') lines.push('- 状态：' + this.motionLabel);
      lines.push('- 距上次有互动的静默：约 ' + idleMin + ' 分钟');
      if (clicks || drags) {
        // 被容量挤掉过未上报的事件时，计数只敢说下限（见 countIsLowerBound）。
        // 0 不加"至少"：零次本来就没得报，写成"至少 0 次"是废话还会误导。
        const n = (v) => (this.countIsLowerBound && v > 0 ? '至少 ' + v : String(v));
        lines.push('- 自上次对话以来的物理互动：被戳 ' + n(clicks) + ' 次，被拖动 '
          + n(drags) + ' 次');
      }
    }
    return {
      throughSeq, idleMin, clicks, drags,
      justWokenUp: this.justWokenUp,
      motionState: this.motionState,
      motionLabel: this.motionLabel,
      lowerBound: this.countIsLowerBound,
      promptText: lines.join('\n')
    };
  }

  /** 只在请求真的走完之后调用 —— 失败/被打断时不提交，事件留着下次如实补报 */
  commit(throughSeq, at = this.now()) {
    this.lastCommittedSeq = Math.max(this.lastCommittedSeq, throughSeq);
    this.lastConversationAt = at;
    this.justWokenUp = false;
    this.wokenUpAt = null;
    this.lastReportedIdleMin = 0;
    // 那批已经报过了（哪怕是"至少"），被挤掉的事件也追不回来。
    // 从这一刻起的计数是数组里真实存在的条数，所以恢复成精确口径。
    this.countIsLowerBound = false;
  }

  /** 幂等：已在睡就绝不重置起始时间 —— 否则「晚安」连说三遍，她永远是刚睡着 */
  enterSleepMode(at = this.now()) {
    if (this.sleepMode) return false;
    this.sleepMode = true;
    this.sleepStartTime = at;
    this.spokenDuringIdle = true;
    this.selfNoteDuringIdle = true;    // D-16：睡着期间不该产愿望，与 spokenDuringIdle 同口径
    this.justWokenUp = false;
    this.wokenUpAt = null;

    // Phase 0.5 (P0-3): 入睡实时事件直连
    if (this.internalRegulation && typeof this.internalRegulation.updateOnSleep === 'function') {
      this.internalRegulation.updateOnSleep(true, { timestamp: at });
    }
    return true;
  }

  wakeUp(at = this.now()) {
    if (!this.sleepMode) return false;
    this.wokenDurationHours = this.sleepStartTime
      ? +((at - this.sleepStartTime) / 3600000).toFixed(1) : 0;
    this.sleepMode = false;
    this.sleepStartTime = null;
    this.justWokenUp = true;
    this.wokenUpAt = at;
    this.spokenDuringIdle = false;
    this.selfNoteDuringIdle = false;   // D-16：醒来是一次新的在场
  

    // v3.1 梦境时序改造：被唤醒 → 搭这条通路顺带结算梦境。
    // 顺序很关键：先抓睡眠上下文（此刻原料还在），再让 updateOnSleep(false) 清空它，
    // 最后用抓到的快照去结算。失败绝不影响唤醒本身（唤醒是物理事实，梦只是附带产物）。
    const sleepCtx = (this.onWakeHook && this.internalRegulation && typeof this.internalRegulation.getSleepContext === 'function')
      ? this.internalRegulation.getSleepContext(at)
      : null;

    // Phase 0.5 (P0-3): 唤醒实时事件直连
    if (this.internalRegulation && typeof this.internalRegulation.updateOnSleep === 'function') {
      this.internalRegulation.updateOnSleep(false, { timestamp: at });
    }

    if (this.onWakeHook) {
      try {
        const r = this.onWakeHook({
          at,
          durationHours: this.wokenDurationHours,
          sleepStartTime: sleepCtx ? sleepCtx.sleepStartTime : null,
          elapsedMs: sleepCtx ? sleepCtx.elapsedMs : null,
          staging: sleepCtx ? sleepCtx.staging : null
        });
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (e) { /* 结算失败不影响唤醒 */ }
    }
    return true;
  }

  /**
   * 记录静默挂机事件 (Phase 0.5: P0-3 & 生产防重复计量水位线)
   * 仅在长时间静默触发时进行事件驱动更新，绝无轮询 setInterval 代谢
   */
  recordIdle(idleMin, at = this.now()) {
    if (this.sleepMode) return;

    const min = Number.isFinite(idleMin) ? Math.floor(idleMin) : Math.max(0, Math.floor((at - this.lastInteractionAt) / 60000));
    if (min < 10) return;

    // 水位线阈值防重复计量：
    // 首次达到 10 分钟或每跨越 10 分钟阶梯（min - lastReportedIdleMin >= 10）时触发一次
    if (this.lastReportedIdleMin > 0 && (min - this.lastReportedIdleMin < 10)) {
      return;
    }

    // 🔴 修复挂机重复累乘：在更新水位线前捕获本次跨越的步长（首次上报取满值，之后取梯级差）
    const stepMin = this.lastReportedIdleMin > 0 ? (min - this.lastReportedIdleMin) : min;
    this.lastReportedIdleMin = Math.floor(min / 10) * 10;

    if (this.internalRegulation && typeof this.internalRegulation.updateOnActivity === 'function') {
      this.internalRegulation.updateOnActivity('idle', { idleMin: min, stepMin, timestamp: at });
    }
    if (typeof this.perceptionPipeline === 'function') {
      this.perceptionPipeline({
        category: 'environmental_silence',
        rawIntensity: Math.min(100, min * 3),
        timestamp: at
      });
    }
  }
}

module.exports = { ActivityTracker };
