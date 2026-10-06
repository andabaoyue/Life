/**
 * Agent 预留层（v0.9.1）：只有抽象和 Mock，不连接 Codex、Shell、文件系统或进程。
 * 人格只能提出 ActionProposal；未来执行前必须经过权限策略和用户确认。
 *
 * v1.0 C 阶段（架构设计见 docs/agent/初澜Agent执行能力_架构设计_B阶段.md）：
 * 四项加固全部落地，但**执行器依旧不接**——本阶段只把安全基座打牢。
 *   ① CapabilityRegistry 加 register() 与能力元数据（原来只有 has/list，无法运行时扩展）；
 *   ② PermissionPolicy 把 `!!scope`（传任意非空字符串即放行）换成路径白名单硬约束；
 *   ③ 新增 ExecutionBudget 执行预算熔断（三份既有文档都没提，但死循环比不能执行更危险）；
 *   ④ AuditLog 由内存数组改为 append-only 落盘（重启即丢等于安全机制失效）。
 *
 * 🔴 C 阶段硬裁定：`network.request` **彻底封死**。理由不是保守，是她无法验证网络真伪 ——
 *   请求失败或返回脏数据时她会转述，直接违反 persona.js 的反表演铁律。且网络是唯一
 *   无法用本地沙盒约束的外部输入源：文件系统至少有路径白名单，网络只能靠域名白名单，
 *   而域名白名单挡不住响应内容被污染。若将来必须开，前置条件见 B 阶段文档 §2.4。
 */
const path = require('path');
const crypto = require('crypto');

/**
 * 提案 id 生成器。
 *
 * 🔴 为什么不能只用 Date.now()（2026-10-06 加固时实测坐实的漏洞）：
 *   原实现是 `'proposal-' + Date.now()`，**同一毫秒内建的两个提案 id 完全相同**。
 *   在 D-3 加固引入 proposalStore 之后，这直接变成一个信任事故：
 *   Map.set 后者会**顶替**前者，于是「用户卡片上看到的提案 A」与
 *   「按A 的 id 实际放行的提案 B」可以是两个不同scope ——用户点头的东西
 *   和真正动的东西不是一回事，这正是这道闸门存在的全部意义被推翻。
 *   （实测：a.id === b.id 为 true，store 里只剩 b，scope 被悄悄换掉。）
 *
 * 为什么用 randomUUID 而不是「时间戳 + 计数器」：进程重启后计数器归零，
 *   而 proposalStore 是纯内存、**跨会话不持久** —— 但测试与将来的持久化
 *   场景都可能让两个进程在相近时间戳内建案。随机源不依赖任何进程内状态，
 *   是唯一不靠运气就能保证。
 */
function newProposalId() {
  return `proposal-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

const CAPABILITIES = Object.freeze(['workspace.read', 'workspace.write', 'process.execute', 'network.request']);

/**
 * 判断一个字符串是否**明显是文件路径**而非命令。
 * 用于 process.execute 的前置拦截：路径混进命令作用域是最典型的形态错误，
 * 而放它过去等于让调用方的命令白名单比对着一个路径去比对，校验形同虚设。
 *
 * 🔴 v1.0 C 阶段修正（实测坐实的缺陷）：本函数原先对**整条命令行**做路径判定，
 *   于是带路径参数的合法命令被误杀 —— `git diff docs/agent/report.md`、
 *   `node tools/release-check.js`、`cat test/readme.txt` 全部被判为路径而遭拒。
 *   根因是把「命令 + 参数」当成一个整体切分了。
 *
 * 正确口径：**只有命令名（首个 token）有可能是路径，参数不是**。
 *   `git diff a/b.md` 的命令名是 `git`（不是路径）→ 放行；
 *   `C:\tools\x.exe` 的命令名是盘符路径 → 拒绝。
 * 参数里的路径交由调用方的 args 数组白名单逐条比对，本层不越权判定。
 *
 * @param {string} s 命令作用域字符串
 * @param {object} [opts]
 * @param {string} [opts.firstToken] 已切分好的命令名（调用方已按 shell 规则切分时传入更准）
 */
function looksLikePath(s, opts = {}) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return false;
  // 命令名：优先用调用方切分好的，否则按空白切第一个 token。
  const cmd = String(opts.firstToken != null ? opts.firstToken : (v.split(/\s+/)[0] || '')).trim();
  if (!cmd) return false;
  if (/^[a-zA-Z]:[\\/]/.test(cmd)) return true;            // C:\ 或 C:/
  if (/^\\\\/.test(cmd)) return true;                       // UNC \\server\share
  if (cmd === '.' || cmd === '..' || cmd.startsWith('../') || cmd.startsWith('..\\')) return true;
  // 带路径分隔符的命令名：末段若是可执行文件（.exe/.cmd/.bat/无扩展名的 git/node）则是命令，否则是路径
  if (/[\\/]/.test(cmd)) {
    const last = cmd.split(/[\\/]/).pop() || '';
    if (/\.(exe|com|cmd|bat|ps1|sh)$/i.test(last)) return false;   // 形如 foo/bar.exe
    return true;
  }
  // 不含分隔符的命令名：仅当它自己像文件名（带非可执行扩展名，如 notes.txt）时才算路径
  return /\.[a-zA-Z0-9]{1,8}$/.test(cmd) && !/\.(exe|com|cmd|bat|ps1|sh|py|js|rb|pl)$/i.test(cmd);
}

/**
 * 能力矩阵：把「哪些能力开放、需要什么确认、作用域规则是什么」从代码里搬到配置。
 * dangerLevel 用于策略层分级；requiresConfirm 决定是否强制走用户确认闸门。
 */
const CAPABILITY_META = Object.freeze({
  'workspace.read': Object.freeze({
    dangerLevel: 'low',
    requiresConfirm: true,
    scopeKind: 'path',
  }),
  'workspace.write': Object.freeze({
    dangerLevel: 'high',
    requiresConfirm: true,
    scopeKind: 'path',
    transactional: true,   // 写操作必须可回滚，见B 阶段文档 §3.6
  }),
  'process.execute': Object.freeze({
    dangerLevel: 'critical',
    requiresConfirm: true,
    scopeKind: 'command',
  }),
  'network.request': Object.freeze({
    dangerLevel: 'forbidden',
    requiresConfirm: false,
    scopeKind: 'none',
    hardDenied: true,
    hardDenyReason: 'C 阶段硬裁定：人格无法验证网络真伪，联网即触发 persona.js 反表演红线',
  }),
});

class CapabilityRegistry {
  constructor(opts = {}) {
    this.names = new Set(CAPABILITIES);
    // v1.0 C 阶段：能力集合改配置驱动，新增 register() 使运行时可扩展（原实现只有 has/list）。
    this.meta = new Map();
    for (const name of CAPABILITIES) {
      this.meta.set(name, Object.assign({}, CAPABILITY_META[name] || { dangerLevel: 'unknown', requiresConfirm: true, scopeKind: 'unknown' }));
    }
    for (const [name, m] of Object.entries(opts.capabilities || {})) {
      this.register(name, m);
    }
  }
  has(name) { return this.names.has(String(name)); }
  list() { return [...this.names]; }
  /** 取能力元数据（副本，防外部篡改内部状态）。 */
  metaOf(name) {
    const m = this.meta.get(String(name));
    return m ? Object.assign({}, m) : null;
  }
  /** 运行时注册新能力。返回 false 表示能力名非法。 */
  register(name, meta = {}) {
    const key = String(name || '').trim();
    if (!key) return false;
    // 🔴 v1.0 C 阶段加固：硬封死的能力**拒绝覆盖**。
    // 原实现只把 hardDenied 记在 meta 上，register() 可直接把它洗白
    // （实测 register('network.request',{hardDenied:false}) 后 isHardDenied 变false），
    // 那等于给「把 network 偷偷放回来」留了一条后门。注释写了原则，实现必须有同一道关。
    if (this.isHardDenied(key)) return false;
    this.names.add(key);
    this.meta.set(key, Object.assign({
      dangerLevel: 'high',
      requiresConfirm: true,
      scopeKind: 'unknown',
    }, meta));
    return true;
  }
  /** 硬封死的能力永远拒绝注册覆盖 —— 防止把network 偷偷放回来。 */
  isHardDenied(name) {
    const m = this.meta.get(String(name));
    return Boolean(m && m.hardDenied);
  }
}

class PermissionPolicy {
  constructor(opts = {}) {
    this.killSwitch = opts.killSwitch !== false;
    this.allowed = new Set(opts.allowed || []);
    // v1.0 C 阶段：作用域从「任意非空字符串」升级为「必须落在显式配置的根目录白名单内」。
    // 原实现 `!!scope` 意味着 scope="*" 或 "C:\\Users\\andab" 全部放行 —— 等于没有约束。
    this.scopeRoots = new Map();   // capability -> roots[]
    for (const [cap, roots] of Object.entries(opts.scopeRoots || {})) {
      this.scopeRoots.set(String(cap), (Array.isArray(roots) ? roots : [roots]).map(String));
    }
    this.followSymlink = opts.followSymlink === true;   // 默认 false：符号链接可指向白名单外
  }

  /** 配置某能力的作用域根目录白名单（归一化为绝对路径）。 */
  setScopeRoots(capability, roots) {
    const cap = String(capability);
    const arr = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((r) => path.resolve(String(r)));
    this.scopeRoots.set(cap, arr);
    return arr;
  }

  /**
   * 判定作用域是否落在白名单根目录内。
   * 三条硬规则（B 阶段文档 §2.2）：
   *   1. path.resolve 归一化后再比对，防 `..` 穿越；
   *   2. 大小写不敏感（Windows 语义）；
   *   3. followSymlink 默认关闭 —— 否则符号链接可指向白名单外，白名单形同虚设。
   */
  _scopeAllowed(capability, scope) {
    const roots = this.scopeRoots.get(String(capability));
    if (!roots || roots.length === 0) return false;      // 未配置根目录 = 不得使用
    if (typeof scope !== 'string' || !scope.trim()) return false;
    let resolved;
    try {
      resolved = path.resolve(scope);
    } catch {
      return false;
    }
    if (this.followSymlink) return true;                 // 显式放开（调用方自负风险）
    const target = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    return roots.some((root) => {
      const r = process.platform === 'win32' ? root.toLowerCase() : root;
      // 必须严格等于根目录本身，或位于根目录之下 —— 避免 "D:\\repo-other" 误配"D:\\repo"
      return target === r || target.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
    });
  }

  /**
   * v1.0 C 阶段：主判定入口，返回**判定明细**而非布尔值。
   * 理由：审计日志必须记录「为什么拒绝」，布尔值无法追溯（原实现只有布尔）。
   */
  authorize(capability, scope, ctx = {}) {
    const cap = String(capability);
    const deny = (reason) => ({ allowed: false, capability: cap, reason, matchedRoot: null });
    if (this.killSwitch) return deny('kill_switch_on');
    if (!this.allowed.has(cap)) return deny('capability_not_granted');
    // 🔴 v1.0 C 阶段加固：**必须兜底 CAPABILITY_META**。
    // 原实现 `ctx.meta || null` —— 调用方不传 meta 时，硬拒绝检查被整个跳过：
    // 实测 `authorize('network.request','C:\\safe\\file')` 返回 allowed:true，
    // 即network 的 C 阶段硬封死可被「不传 meta」绕过。安全红线绝不能依赖调用方自觉。
    // 传 ctx.meta 的显式覆盖仍然优先（便于测试注入），但缺省一律回落到全局矩阵。
    const meta = ctx.meta || CAPABILITY_META[cap] || null;
    if (meta && meta.hardDenied) return deny(meta.hardDenyReason || 'capability_hard_denied');
    if (meta && meta.scopeKind === 'command') {
      // process.execute 不接受路径作用域：必须由调用方走命令白名单校验，
      // 绝不允许用任意字符串冒充已校验（这正是原 !!scope 的漏洞形态）。
      //
      // 🔴 v1.0 C 阶段加固：原实现只判「非空字符串」，导致一个**文件路径**也能通过
      //   （实测 `C:\...\notes.txt` 与 `git status` 同样 allowed:true）—— 等于没校验。
      //   现在要求显式声明它是一条**命令**（含可执行文件名或已知命令前缀），
      //   且**永不在此处解析 shell**：命令白名单校验由调用方（未来主进程侧）用
      //   args 数组逐条比对完成，本层只负责「拒绝明显不是命令的东西」。
      if (typeof scope !== 'string' || !scope.trim()) return deny('command_scope_required');
      if (looksLikePath(scope)) return deny('command_expected_not_path');
      return { allowed: true, capability: cap, reason: 'ok', matchedRoot: null };
    }
    if (!this._scopeAllowed(cap, scope)) return deny('scope_not_in_whitelist');
    let matchedRoot = null;
    const resolved = path.resolve(String(scope));
    for (const root of this.scopeRoots.get(cap) || []) {
      const r = process.platform === 'win32' ? root.toLowerCase() : root;
      const t = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) { matchedRoot = root; break; }
    }
    return { allowed: true, capability: cap, reason: 'ok', matchedRoot };
  }

  /**
   * 兼容旧契约：布尔版can()。
   * 🔴 注意这是**有意的行为变更** —— 现在返回 false 的场景比原来严格得多
   * （未配置根目录一律拒绝）。保留它只为不让既有调用方崩，勿当宽松通道使用。
   */
  can(capability, scope) {
    return this.authorize(capability, scope).allowed;
  }

  setKillSwitch(on) { this.killSwitch = !!on; }
}

/**
 * ③ ExecutionBudget 执行预算熔断
 *
 * 🔴 这是三份既有文档（V0.9.2 审计、V3.1 §4.3、SOFTWARE-PURPOSES）**全都漏掉的一块**。
 * V0.9.2 审计第 493行列了三项缺失：沙箱 / 回滚 / 审计 —— 但没人提预算。
 * 理由：一个能无限循环的 Agent 比一个不能执行的 Agent 危险得多。
 *   「她不能执行」= 风险为零；「她能执行但会死循环」= 反复写盘、烧token、可能误操作。
 *
 * 四个上限（初值可调，但**不允许全部取消**——至少保留 maxConsecutiveErrors）：
 *   maxActionsPerSession    单会话动作总数硬顶
 *   maxWritesPerSession     写动作单独更严（写不可逆）
 *   maxConsecutiveErrors    连续失败 N 次自动熔断（防死循环打转）
 *   maxWallClockMs          单次提案端到端时限
 *
 * 熔断后必须给出**用户可见状态**（tripped + reason），且**不得静默重试**。
 */
const DEFAULT_BUDGET = Object.freeze({
  maxActionsPerSession: 20,
  maxWritesPerSession: 5,
  maxConsecutiveErrors: 3,
  maxWallClockMs: 10 * 60 * 1000,
});

class ExecutionBudget {
  constructor(opts = {}) {
    const cfg = Object.assign({}, DEFAULT_BUDGET, opts || {});
    this.limits = Object.freeze(cfg);
    this.reset();
  }

  reset() {
    this.actions = 0;
    this.writes = 0;
    this.consecutiveErrors = 0;
    this.tripped = false;
    this.tripReason = null;
    this.startedAt = Date.now();
    return this;
  }

  get remainingActions() {
    return Math.max(0, this.limits.maxActionsPerSession - this.actions);
  }

  /** 熔断状态（用户可见，不得吞掉）。 */
  state() {
    return {
      actions: this.actions,
      writes: this.writes,
      consecutiveErrors: this.consecutiveErrors,
      remainingActions: this.remainingActions,
      remainingWrites: Math.max(0, this.limits.maxWritesPerSession - this.writes),
      limits: Object.assign({}, this.limits),
      tripped: this.tripped,
      tripReason: this.tripReason,
    };
  }

  _trip(reason) {
    if (!this.tripped) { this.tripped = true; this.tripReason = reason; }
    return false;
  }

  /**
   * 申请一次动作配额。返回 { allowed, reason }。
   * @param {boolean} isWrite 是否写动作（写动作走更严的独立上限）
   * @returns {boolean} true=放行；false=已熔断，调用方**必须停止**且不得重试
   */
  consume(isWrite = false, now = Date.now()) {
    if (this.tripped) return false;
    if (this.limits.maxWallClockMs > 0 && (now - this.startedAt) > this.limits.maxWallClockMs) {
      return this._trip('wall_clock_exceeded');
    }
    if (this.actions + 1 > this.limits.maxActionsPerSession) {
      return this._trip('max_actions_exceeded');
    }
    if (isWrite && this.writes + 1 > this.limits.maxWritesPerSession) {
      return this._trip('max_writes_exceeded');
    }
    this.actions += 1;
    if (isWrite) this.writes += 1;
    // 成功动作重置连续错误计数
    this.consecutiveErrors = 0;
    return true;
  }

  /** 记录一次失败。连续失败达上限即熔断（防「一直失败一直重试」的死循环）。 */
  recordError() {
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= this.limits.maxConsecutiveErrors) {
      return this._trip('max_consecutive_errors');
    }
    return true;
  }
}

/**
 * ④ AuditLog：append-only 落盘。
 *
 * v1.0 C 阶段前是 `this.events = []` 纯内存 —— **进程重启即丢，等于安全机制失效**。
 * 现改为写入 `agent-audit.jsonl`（append-only，与 experiences.jsonl 同构）。
 *
 * 🔴 隐私铁律：**绝不记录凭据、命令原文中的密钥、文件内容、用户隐私数据**。
 *   只记元数据：谁(confirmedBy)、要做什么(capability)、在哪个范围(scope)、判定与理由。
 */
/* ──────────────────────────────────────────────────────────────────
 * D-9：动机来源的分类（可追溯性的最后一跳）
 * ──────────────────────────────────────────────────────────────────
 *
 * ## 要解决的问题
 * 审计里只能看到「她写了 note.md」，答不上「因为她想写，还是因为你说了」。
 * 而 selfIntent.sources 形如 'traits.attachment_need' / 'tracker.lastInteractionAt'，
 * 那是**路径**，不是**类别** —— 用户翻审计时不会去推断前缀。
 *
 * ## 为什么用穷举表，不做前缀泛化
 * 与 SELF_INTENT_KINDS 同一纪律：合法来源前缀由本表白名单，
 * 新增一类来源必须先在这里登记，**不能靠「凡是带点的都算」自动放行**。
 * 泛化前缀 = 任何新加的状态字段都能自动获得「有动机」的标签，
 * 等于给「凭空造动机」开了后门。
 */
const INTENT_ORIGIN_BY_SOURCE_PREFIX = Object.freeze({
  // 她自己的特质（依恋渴望 / 好奇 / 活力…）
  traits: 'self_trait',
  // 用户行为派生（静默了多久、上次互动在什么时候）
  tracker: 'user_action',
});

/** 合法的动机来源类别。null 表示「不知道」——不是 'unknown'。 */
const INTENT_ORIGINS = Object.freeze(['self_trait', 'user_action']);

/**
 * 把 selfIntent.sources 归类成**一个**可读的来源类别。
 *
 * 🔴 拿不到、或判不出来，一律返回 null，**绝不返回 'unknown'、也不编一个**。
 *   理由：'unknown' 长得像「我知道但没记全」，而 null 的意思是「确实没有」。
 *   前者会让人以为动机存在只是查不到 —— 那就正好毁掉本轮唯一的目的
 *   （区分「来自她的特质」与「来自用户行为」）。
 *
 * 三条判据（各有一条独立反例，缺一不可）：
 *   ① 非数组 / 空数组 → null（没有来源，就是没有动机）
 *   ② 任何一项前缀不在表里 → null（**不认识就不分类**，不猜）
 *   ③ traits 与 tracker 混合 → null（有歧义，说不清是哪一类）
 *      ⚠️ 这条不是洁癖：混起来意味着「她既想写又因为你不理她」，
 *         硬选一个就是在替她表态。当前 computeSelfIntent 只产单元素，
 *         这条是给未来加多来源时留的诚实出口。
 *
 * @param {*} sources selfIntent.sources（不信任任何形态）
 * @returns {?('self_trait'|'user_action')}
 */
function classifyIntentOrigin(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const origins = new Set();
  for (const raw of sources) {
    if (typeof raw !== 'string' || !raw.length) return null;
    const prefix = raw.split('.')[0];
    const mapped = INTENT_ORIGIN_BY_SOURCE_PREFIX[prefix];
    if (!mapped) return null;                    // 判据 ②：不认识就不分类
    origins.add(mapped);
  }
  if (origins.size !== 1) return null;           // 判据 ③：有歧义就说不出
  return origins.values().next().value;
}

/**
 * 提案状态机（B 阶段文档 §3.4提及）：原实现 status 硬编码 'proposed'，无法表达生命周期。
 * 合法流转：proposed → approved/rejected → executing → executed/failed/rolled_back/expired
 */
const PROPOSAL_STATES = Object.freeze([
  'proposed', 'approved', 'rejected', 'executing',
  'executed', 'failed', 'rolled_back', 'expired',
]);

/**
 * 🔴 D-9：把「动机」归一成一个可冻结的字段组。
 *
 * 这个函数存在的意义是**把不可信输入挡在提案之外**：
 * 执行期与审计期拿到的都只是冻结后的字符串/数组，
 * 渲染端在 build 之后无论如何都改不动（提案是 Object.freeze 的）。
 *
 * @param {*} motive 主进程侧求得的动机（可以是 null / undefined / 任何垃圾形态）
 * @returns {{intentSources:?string[], intentKind:?string, intentOrigin:?string}}
 *   三个字段**恒存在**，拿不到就是 null —— 形状恒定才能被 grep 与断言。
 */
function normalizeIntentMotive(motive) {
  const empty = { intentSources: null, intentKind: null, intentOrigin: null };
  if (!motive || typeof motive !== 'object' || Array.isArray(motive)) return empty;

  // sources 只收有限长的非空字符串，逐项截断防日志膨胀。
  let sources = null;
  if (Array.isArray(motive.sources)) {
    const kept = motive.sources
      .filter((s) => typeof s === 'string' && s.length > 0)
      .slice(0, 8)
      .map((s) => s.slice(0, 80));
    if (kept.length) sources = kept;
  }

  const kind = (typeof motive.kind === 'string' && motive.kind.length)
    ? motive.kind.slice(0, 64) : null;

  // 🔴 origin **不取调用方给的**，一律由 sources 重新分类。
  //   否则就成了「渲染端/上游声称这是自我动机」，正是本轮要防的顶替。
  return {
    intentSources: sources,
    intentKind: kind,
    intentOrigin: classifyIntentOrigin(sources),
  };
}

/**
 * @param {object} input  **来自渲染端的不可信输入**，只取下面那 8 个白名单字段。
 * @param {*} [intentMotive] 🔴 D-9 动机来源，**必须由主进程侧独立求值后传入**。
 *   刻意做成**第二个参数**而不是 input 的一个字段 —— 若放进 input，
 *   `agent:propose-action` 把 raw 透传进来就等于让渲染端自报动机，
 *   那正是 D-3 顶替攻击那一族。本函数**只从 input 读白名单字段**，
 *   `input.intentSources` / `input.intentKind` / `input.intentOrigin` 一律被忽略。
 * @returns 冻结的提案对象
 */
function createActionProposal(input = {}, intentMotive = null) {
  const status = String(input.status || 'proposed');
  if (!PROPOSAL_STATES.includes(status)) {
    throw new Error(`非法提案状态: ${status}（合法值见 PROPOSAL_STATES）`);
  }
  const motive = normalizeIntentMotive(intentMotive);
  return Object.freeze({
    //🔴 id 必须**由本函数生成，绝不接受调用方指定**（2026-10-06 实测漏洞）。
    //   原实现是 `String(input.id || 'proposal-' + Date.now())`，两个后果：
    //     ① 调用方可自选 id —— propose 通道把 raw 原样透传进来，
    //        渲染端能传 `id:'ATTACKER-PICKED'` 把自己声明成任意提案（实测被采纳）；
    //② 同一毫秒建案id 天然相同 —— 见 newProposalId() 注释里的顶替攻击。
    //   id 是「用户所见」与「实际放行」的绑定键，自选等于让调用方自己指定绑谁。
    id: newProposalId(),
    capability: String(input.capability || ''),
    scope: String(input.scope || ''),
    reason: String(input.reason || '').slice(0, 500),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    requiresUserConfirmation: input.requiresUserConfirmation !== false,
    status,
    // v1.0 C 阶段：预算熔断是硬约束，提案得知道自己在哪个预算会话下出生。
    budgetSessionId: String(input.budgetSessionId || ''),
    // 🔴 D-9 动机来源：**三个字段恒存在**（拿不到时值为 null），形状恒定才能被 grep。
    //   语义：她为什么想做这件事 —— 由哪条状态推出来的。
    //   ⚠️ 本轮（动机来源进审计）只让它们**可查**，不接线 _pendingAgentIntent，
    //     所以真实运行时这里几乎恒为 null。这是如实记录，不是功能没做完。
    intentSources: motive.intentSources,
    intentKind: motive.intentKind,
    intentOrigin: motive.intentOrigin,
  });
}

class AgentBridgeMock {
  async propose(input) { return createActionProposal(input); }
  async execute() { throw new Error('AgentBridge 尚未连接真实执行器'); }
}

/**
 * ④ AuditLog：append-only 落盘。
 *
 * v1.0 C 阶段前是 `this.events = []` 纯内存 —— **进程重启即丢，等于安全机制失效**。
 * 现改为写入 `agent-audit.jsonl`（append-only，与 experiences.jsonl 同构）。
 *
 * 🔴 隐私铁律：**绝不记录凭据、命令原文中的密钥、文件内容、用户隐私数据**。
 *   只记元数据：谁(confirmedBy)、要做什么(capability)、在哪个范围(scope)、判定与理由。
 */
class AuditLog {
  constructor(opts = {}) {
    this.events = [];
    this.dir = opts.dir || null;
    this.file = opts.file || (this.dir ? path.join(this.dir, 'agent-audit.jsonl') : null);
    this.persist = Boolean(this.file) && opts.persist !== false;
    this.maxMemory = Number.isFinite(opts.maxMemory) ? opts.maxMemory : 500;
  }

  /**
   * 追加一条审计。落盘失败**不静默吞掉** —— 审计写不进去等于没审计，
   * 故返回落盘状态供调用方决定是否中止。
   */
  append(event = {}) {
    const record = Object.freeze({ at: Date.now(), ...event });
    this.events.push(record);
    if (this.events.length > this.maxMemory) this.events.shift();
    let persisted = null;
    if (this.persist) persisted = this._appendToDisk(record);
    return Object.assign({}, record, { persisted });
  }

  _appendToDisk(record) {
    try {
      const fs = require('fs');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 只落元数据：剔除任何形似凭据的键值（纵深防御，正常调用方本就不该传这些）。
      const safe = {};
      for (const [k, v] of Object.entries(record)) {
        if (/key|token|secret|password|credential|cookie/i.test(k)) continue;
        if (typeof v === 'string' && v.length > 500) safe[k] = v.slice(0, 500);
        else safe[k] = v;
      }
      fs.appendFileSync(this.file, JSON.stringify(safe) + '\n', 'utf8');
      return true;
    } catch {
      return false;   // 调用方可据此中止；但绝不能因此跳过审计本身
    }
  }

  list() { return this.events.slice(); }

  /** 从磁盘回读（append-only 语义：只追加不回改）。 */
  readAll() {
    if (!this.persist) return [];
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.file)) return [];
      return fs.readFileSync(this.file, 'utf8')
        .split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

module.exports = { CAPABILITIES, CAPABILITY_META, PROPOSAL_STATES, DEFAULT_BUDGET, looksLikePath,
  CapabilityRegistry, PermissionPolicy, ExecutionBudget,
  createActionProposal, AuditLog, AgentBridgeMock,
  // D-9：动机来源的分类与归一。导出是为了让门禁能**直接测判据本身**，
  // 而不是只能通过「建案 → 看字段」间接观察（那测不到 classify 的边界）。
  classifyIntentOrigin, normalizeIntentMotive,
  INTENT_ORIGIN_BY_SOURCE_PREFIX, INTENT_ORIGINS };
