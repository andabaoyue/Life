/**
 * src/agent-ipc.js
 *
 * 初澜 Agent 执行能力：D-1 阶段 IPC 主进程通道白名单。
 *
 * 本阶段定位：**只铺管道，不接执行器。**
 * 四条通道全部是治理/查询性质，写通道与执行通道在设计层就不存在
 * （不是靠运行时拦截，而是根本没有注册入口）。
 *
 * 核心安全边界（逐条对应 C 阶段五道闸门）：
 *   1. 所有 handler 必须经调用方注入的 ipcGuard 注册 —— 严防非受信渲染窗口
 *      假冒发送 Agent 指令（继承 SEC-01 规范）。
 *   2. 跨进程传入的能力名一律重走 PermissionPolicy.authorize()，不信任调用方
 *      自带的任何元数据（renderer 侧传来的 meta 是攻击面，不是事实）。
 *   3. 每个提案动作都消耗 ExecutionBudget 额度；熔断后一律拒绝。
 *   4. 提案创建走 createActionProposal()，非法输入直接拒，不进入状态机。
 *   5. 审计只记元数据，绝不记凭据/文件内容/隐私数据（由 AuditLog 内部保证）。
 *
 * ⚠️ D-1 明确不包含（留待 D-2/D-3）：
 *   - agent:execute          执行通道 —— 执行器仍为 AgentBridgeMock
 *   - workspace.write 落盘   事务回滚未实现
 *   - 逐次用户确认弹窗       UI 未接
 *
 * ipcGuard / ipcMain 对象均由调用方注入 —— 本模块不 require electron，可在纯 Node 测试。
 */

const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget,
  createActionProposal, AuditLog, CAPABILITIES,
} = require('./agent-interfaces');
const { UserConfirmationGate } = require('./agent-confirmation');

/**
 * D-3 起允许注册的通道名单（白名单即设计约束，不多不少）。
 *
 * ⚠️ 这里新增的 agent:confirm-action **只登记用户的「同意/拒绝」**，
 *它不执行任何动作。执行通道 agent:execute 依然不在名单里——
 * 用户点头 ≠ 可以动手，中间还隔着预算终态判定与事务层。
 */
const AGENT_CHANNELS = Object.freeze([
  'agent:get-status',
  'agent:get-capabilities',
  'agent:propose-action',
  'agent:confirm-action',
  'agent:get-audit-log',
]);

/** 统一错误信封：与 research-ipc 的 { ok, error } 形状对齐，渲染层好统一处理。 */
function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * 注册 Agent 治理通道。
 *
 * @param {object} ipcGuard  必填，须具备 handle()（通常是 createIpcGuard 的返回值）。
 *   注意形参与 research-ipc.js 一致，但**必须传 guard 而非裸 ipcMain**——
 *   SEC-01 门禁断言 main.js 里不得出现裸注册调用，故注册一律走 ipcGuard.handle。
 * @param {object} agentContext  必填，注入 agent-interfaces 的各实例。
 * @param {object} options  { registry, policy, budget, auditLog, confirmation, maxAuditItems }
 */
function registerAgentIpc(ipcGuard, agentContext, options = {}) {
  if (!ipcGuard || typeof ipcGuard.handle !== 'function') return false;
  const ctx = agentContext || {};

  // 实例可由外部注入（测试用替身），也可在此组装默认实例。
  const registry = options.registry || ctx.registry || new CapabilityRegistry();
  const policy = options.policy || ctx.policy || new PermissionPolicy();
  const budget = options.budget || ctx.budget || new ExecutionBudget();
  const auditLog = options.auditLog || ctx.auditLog || new AuditLog();
  // D-3：第四道闸门（用户显式确认）。可注入替身，默认新建一个。
  const confirmation = options.confirmation || ctx.confirmation || new UserConfirmationGate();
  const maxAuditItems = Number.isFinite(options.maxAuditItems)
    ? Math.max(1, Math.floor(options.maxAuditItems))
    : 100;

  //🔴 D-3 加固：提案注册表（修补"凭空造授权"的根因）。
  //   DSH 审核实测：`confirm('p-not-exist-XYZ','approved')` 曾能凭空写入一条 approved
  //   记录并让 isExecutionAllowed() 返回 true —— 因为提案建案后**从不保存**，
  //   confirm 无从判断"这个 id 到底存不存在"。D-4 一旦接执行器，渲染端提交
  //   任意伪造 id 就能换到"已授权"状态，本闸门最核心的不变式被绕过。
  //   正确修法是补上**提案的完整生命周期**，而不是在 confirm 里加字符串判断。
  //   可注入 options.proposalStore（测试用替身），默认新建。
  const proposalStore = options.proposalStore || ctx.proposalStore || new Map();
  // 提案注册表上界：propose 已受 ExecutionBudget 约束（默认 20 次/会话），
  //   这里只是防御 map 无限增长，不构成新的可用性限制。
  const MAX_TRACKED_PROPOSALS = 200;

  /**
   * 提案入口的公共前置：校验 → 授权 → 预算。
   * 三道闸门顺序刻意如此：先确认输入是不是合法提案（廉价，纯结构），
   * 再做能力授权（可能读磁盘白名单），最后才消耗预算。
   * 反过来会让恶意畸形输入先吃掉用户的动作配额。
   */
  function evaluateProposal(raw) {
    // ① 输入形态硬校验：跨进程传进来的一律视为不可信输入。
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { code: 'INVALID_PROPOSAL', ok: false };
    }
    const capability = String(raw.capability || '');
    if (!capability) return { code: 'CAPABILITY_REQUIRED', ok: false };

    // ② 能力授权：故意**不传 ctx.meta** —— 让 authorize 走 CAPABILITY_META 兜底，
    //    这样 renderer 无法通过伪造 meta 洗白 hardDenied 能力（如 network.request）。
    const verdict = policy.authorize(capability, raw.scope);
    if (!verdict.allowed) return { code: 'AUTHORIZED_REJECTED', ok: false, reason: verdict.reason, verdict };

    // ③ 预算熔断：熔断为终态，触发后不放行任何动作。
    const isWrite = capability === 'workspace.write';
    if (!budget.consume(isWrite)) {
      return { code: 'BUDGET_TRIPPED', ok: false, state: budget.state() };
    }
    return { code: 'OK', ok: true, capability, verdict };
  }

  /**
   * 通道 handler 的身份校验。
   *
   * ✅ D-1 重要发现：`ipcGuard.handle()` 会在调用我们 fn **之前**先
   * `assertTrustedRenderer`，失败即**抛出** UNTRUSTED_RENDERER（栈帧 ipc-guard.js:74）。
   * 这是本仓既定契约 —— `test/security-hardening-sec.test.js:60` 与
   * `test/connection-ipc.test.js:245` 都断言"抛出"，research:*通道同样如此。
   *
   * 因此**不能也不应**在本层把异常转成 { ok:false } 信封：那是重复校验，
   * 且会与既有测试的预期冲突。故此处只做一次冗余防御（当 guard 未提供
   * assertTrustedRenderer 时才生效，如测试替身），不改变既有契约。
   */
  function assertByHandler(event) {
    if (typeof ipcGuard.assertTrustedRenderer === 'function') {
      // 正常路径下这里根本不会被执行到（guard 已先抛/先放行）；
      // 保留仅为在 guard 缺少该方法时提供等价防护（纵深防御）。
      return;
    }
    const trusted = typeof ipcGuard.isTrustedRenderer === 'function'
      ? ipcGuard.isTrustedRenderer(event) : false;
    if (!trusted) throw Object.assign(new Error('UNTRUSTED_RENDERER'), { code: 'UNTRUSTED_RENDERER' });
  }

  function guard(fn) {
    return (event, ...args) => {
      try {
        return fn(event, ...args);
      } catch (err) {
        // 内部异常一律转信封，绝不让堆栈穿透 IPC 边界（会泄漏内部结构）。
        return fail('HANDLER_ERROR', { detail: String((err && err.message) || '').slice(0, 200) });
      }
    };
  }

  // 1. 预算与熔断状态查询
  ipcGuard.handle('agent:get-status', guard((event) => {
    assertByHandler(event);
    return {
      ok: true,
      budget: budget.state(),
      policy: {
        killSwitch: policy.killSwitch,
        grantedCapabilities: [...policy.allowed],
      },
      registeredCapabilities: registry.list(),
      auditCount: auditLog.list().length,
      // D-3：UI 靠这个数字决定要不要亮确认卡片。
      confirmations: { recorded: confirmation.count() },
    };
  }));

  // 2. 能力元数据查询（只读，返回副本防篡改由 registry.metaOf 内部保证）
  ipcGuard.handle('agent:get-capabilities', guard((event) => {
    assertByHandler(event);
    return {
      ok: true,
      capabilities: registry.list().map((name) => {
        const m = registry.metaOf(name) || {};
        return {
          name,
          dangerLevel: m.dangerLevel || 'unknown',
          requiresConfirm: m.requiresConfirm !== false,
          scopeKind: m.scopeKind || 'unknown',
          hardDenied: m.hardDenied === true,
          hardDenyReason: m.hardDenyReason || null,
        };
      }),
    };
  }));

  // 3. 提案受理：过三道闸门后建案并记审计。**本通道不执行任何动作。**
  ipcGuard.handle('agent:propose-action', guard((event, raw) => {
    assertByHandler(event);
    const evaluated = evaluateProposal(raw);
    if (!evaluated.ok) {
      // 拒绝也要留痕 —— 审计的价值一半在这里。
      auditLog.append({
        channel: 'agent:propose-action',
        outcome: 'rejected',
        code: evaluated.code,
        capability: String((raw && raw.capability) || '').slice(0, 64),
        reason: evaluated.reason || null,
        via: 'ipc',
      });
      if (evaluated.code === 'BUDGET_TRIPPED') {
        return fail('BUDGET_TRIPPED', { budget: evaluated.state });
      }
      if (evaluated.code === 'AUTHORIZED_REJECTED') {
        return fail('AUTHORIZED_REJECTED', { reason: evaluated.reason });
      }
      return fail(evaluated.code);
    }

    let proposal;
    try {
      proposal = createActionProposal(raw);
    } catch (err) {
      auditLog.append({
        channel: 'agent:propose-action',
        outcome: 'rejected',
        code: 'PROPOSAL_CONSTRUCTION_FAILED',
        capability: evaluated.capability,
        via: 'ipc',
      });
      return fail('INVALID_PROPOSAL', { detail: String(err && err.message || '').slice(0, 200) });
    }

    auditLog.append({
      channel: 'agent:propose-action',
      outcome: 'accepted',
      capability: proposal.capability,
      proposalId: proposal.id,
      scope: String(proposal.scope || '').slice(0, 300),
      status: proposal.status,
      matchedRoot: evaluated.verdict ? evaluated.verdict.matchedRoot : null,
      via: 'ipc',
    });

    // D-1：只建案，绝不执行。执行器是 AgentBridgeMock，其 execute() 会抛
    // '尚未连接真实执行器' —— 这是刻意的：一旦有人误接执行器会立刻炸，
    // 而不是静默半执行。
    // D-3 加固：建案即登记进提案注册表 —— confirm 通道要靠它做存在性校验。
    //   超上界时逐出**最早的**提案。
    //   🔴 逐出必须**同步作废该提案的授权**（2026-10-06 复核修正）：
    //   提案是「用户点头的内容」的唯一载体，一旦被移走，那条授权就再也
    //   无法被核对内容是否仍然成立 —— 而 isExecutionAllowed 只查 records 里的
    //   decision/指纹，**不查提案是否还在**。留着它= 拿着一个无法验证的授权
    //   去放行，这比"授权超时失效"更糟（超时至少是显式可解释的）。
    //   所以此处的选择是：**宁可让授权随提案一起消失，不留悬空授权。**
    if (proposalStore.size >= MAX_TRACKED_PROPOSALS) {
      const oldest = proposalStore.keys().next();
      if (!oldest.done) {
        proposalStore.delete(oldest.value);
        confirmation.revoke(oldest.value, 'PROPOSAL_EVICTED');
      }
    }
    proposalStore.set(proposal.id, proposal);

    return { ok: true, proposal, executed: false, budget: budget.state() };
  }));

  // 4. 用户显式确认（D-3 第四道闸门）
  //🔴 本通道**只登记决策，绝不执行**。用户点了【授权】不代表可以动手——
  //    执行器仍不存在（AgentBridgeMock.execute() 依旧抛），这条边界不能松。
  ipcGuard.handle('agent:confirm-action', guard((event, raw) => {
    assertByHandler(event);
    // 跨进程输入一律视为不可信：结构不符直接拒。
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('INVALID_CONFIRMATION');
    }
    const proposalId = String(raw.proposalId || '').trim();
    if (!proposalId) return fail('PROPOSAL_ID_REQUIRED');

    // 🔴 加固2（trim 口径统一）：这里原来写`.trim()`，把决策值**提前洗白**了——
    //   而 agent-confirmation.js 的注释明确写「决策值不做 trim 容错，出现
    //   ' approved ' 说明链路有bug 或有人在试探边界，宁可全拒」。
    //   实测：模块直调 " approved " 被拒，走 IPC 却ok:true —— 注释锁的不变式
    //   在真实调用路径上被本层"帮忙"破坏了。**跨进程输入一律原样下传。**
    //   （proposalId 是标识符，两端空白属无害噪声，仍需 trim。）
    const decision = raw.decision === null || raw.decision === undefined
      ? ''
      : String(raw.decision);

    // 🔴 加固1（提案存在性）：不查这一条，confirm 就能凭空造出授权记录。
    //   必须走提案注册表核对真实存在的提案，且取它的真实 status 下传——
    //   否则调用方可以传 meta.status='proposed' 把自己「声明」成待确认。
    const tracked = proposalStore.get(proposalId);
    if (!tracked) {
      auditLog.append({
        channel: 'agent:confirm-action',
        outcome: 'rejected',
        code: 'PROPOSAL_NOT_FOUND',
        proposalId: proposalId.slice(0, 120),
        via: 'ipc',
      });
      return fail('PROPOSAL_NOT_FOUND');
    }

    // 🔴 加固3（confirm 也计预算）：原先只有提案路径consume，confirm 是零成本入口——
      //   实测连发 500 次 confirm 后 usedActions 仍为 0、tripped=false，
      //   渲染端可以无成本刷爆授权记录。确认是**用户动作**，同样该受预算管。
    //   记为非写动作（写额度留给真正的文件写入）。
    if (!budget.consume(false)) {
      auditLog.append({
        channel: 'agent:confirm-action',
        outcome: 'rejected',
        code: 'BUDGET_TRIPPED',
        proposalId: proposalId.slice(0, 120),
        via: 'ipc',
      });
      return fail('BUDGET_TRIPPED', { budget: budget.state() });
    }

    // 顺带回收过期授权 —— prune 原为**零调用点**的死代码，
    //   records 只增不减（实测 502 条常驻）。挂在 confirm 上是自然触发点：
    //   用户产生确认动作时顺手清理，不需要额外定时器（D-001 禁轮询）。
    confirmation.prune();

    const result = confirmation.confirm(proposalId, decision, { status: tracked.status });
    if (!result.ok) {
      // 重复确认 / 拒绝后反悔 / 非法决策值 —— 全部留痕。
      auditLog.append({
        channel: 'agent:confirm-action',
        outcome: 'rejected',
        code: result.code,
        proposalId: proposalId.slice(0, 120),
        via: 'ipc',
      });
      return fail(result.code, result.status ? { status: result.status } : {});
    }

    auditLog.append({
      channel: 'agent:confirm-action',
      outcome: 'recorded',
      decision: result.record.decision,
      proposalId: proposalId.slice(0, 120),
      // 执行放行判定一并记下来：将来接执行器时，这里能看出「当时凭什么认为可执行」。
      executionGate: confirmation.isExecutionAllowed(proposalId, result.record.at),
      executed: false,
      via: 'ipc',
    });
    return { ok: true, record: result.record, executed: false, budget: budget.state() };
  }));

  // 5. 审计读取（脱敏由 AuditLog 保证；此处只做条数上限，避免一次拉爆内存）
  ipcGuard.handle('agent:get-audit-log', guard((event, opts = {}) => {
    assertByHandler(event);
    const all = auditLog.list();
    const limit = Number.isFinite(opts && opts.limit) ? Math.max(1, Math.floor(opts.limit)) : maxAuditItems;
    // 默认只给**最近 limit 条**（最新在尾部）；tail:false 时从头取。
    const fromTail = !(opts && opts.tail === false);
    const slice = fromTail ? all.slice(-limit) : all.slice(0, limit);
    return { ok: true, total: all.length, returned: slice.length, events: slice };
  }));

  return true;
}

module.exports = { registerAgentIpc, AGENT_CHANNELS };