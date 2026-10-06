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

/** D-1 阶段唯一允许注册的通道名单（白名单即设计约束，不多不少）。 */
const AGENT_CHANNELS = Object.freeze([
  'agent:get-status',
  'agent:get-capabilities',
  'agent:propose-action',
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
 * @param {object} options  { registry, policy, budget, auditLog, maxAuditItems }
 */
function registerAgentIpc(ipcGuard, agentContext, options = {}) {
  if (!ipcGuard || typeof ipcGuard.handle !== 'function') return false;
  const ctx = agentContext || {};

  // 实例可由外部注入（测试用替身），也可在此组装默认实例。
  const registry = options.registry || ctx.registry || new CapabilityRegistry();
  const policy = options.policy || ctx.policy || new PermissionPolicy();
  const budget = options.budget || ctx.budget || new ExecutionBudget();
  const auditLog = options.auditLog || ctx.auditLog || new AuditLog();
  const maxAuditItems = Number.isFinite(options.maxAuditItems)
    ? Math.max(1, Math.floor(options.maxAuditItems))
    : 100;

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
    return { ok: true, proposal, executed: false, budget: budget.state() };
  }));

  // 4. 审计读取（脱敏由 AuditLog 保证；此处只做条数上限，避免一次拉爆内存）
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