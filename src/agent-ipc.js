/**
 * src/agent-ipc.js
 *
 * 初澜 Agent 执行能力：IPC 主进程通道白名单。
 *
 * 阶段演进（读本文件前先看清自己在哪一阶段，注释即规格）：
 *   - D-1：只铺管道，不接执行器。四条通道全是治理/查询性质，
 *           写通道与执行通道**在设计层就不存在**（没有注册入口）。
 *   - D-2/D-3：补齐事务层与用户显式确认闸门，仍**不含**执行通道。
 *   - D-4：挂载 agent:execute，通道名单扩到 6 条，闸门一根都不许松。
 *
 * 🔴 D-4 起「通道存在」≠「能力可用」。当前 main.js 是三重默认关闭：
 *   killSwitch=true + allowed=[] + 未配置 scope 根目录，
 *   即便渲染端摸到本文件也写不动用户文件。开启需显式三步，见 main.js。
 *   所以下面凡是写「执行」的地方，都不代表真的能落盘。
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
 * ⚠️ D-1~D-3 阶段明确不包含（各自留待后续阶段，现已全部落地）：
 *   - agent:execute          执行通道 —— D-1 时执行器仍是 AgentBridgeMock（execute() 必抛），
 *                            D-4 起换成 ControlledAgentExecutor，闸门判定全部下沉到agent-executor.js
 *   - workspace.write 落盘   D-1 时事务回滚未实现 → D-2 补齐单文件事务 + WAL
 *   - 逐次用户确认弹窗D-1 时 UI 未接 → D-3 补齐确认闸门（UI 卡片接线仍待后续）
 *
 * ipcGuard / ipcMain 对象均由调用方注入 —— 本模块不 require electron，可在纯 Node 测试。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget,
  createActionProposal, AuditLog, CAPABILITIES,
} = require('./agent-interfaces');
const { UserConfirmationGate } = require('./agent-confirmation');
const { ControlledAgentExecutor, ALLOWED_WRITE_EXTENSIONS, isMalformedWindowsPath } = require('./agent-executor');

/**
 * 允许注册的通道名单（白名单即设计约束，不多不少）。
 *
 * D-1 时这里只有 4 条治理/查询通道；D-3 加了 agent:confirm-action；
 * D-4 加了 agent:execute，共 6 条；
 * D-5 加了 agent:get-pending-proposal，共 7 条（安全取回提案真身的唯一途径）；
 * SEC-01 加了 agent:get-proposal-content，共 8 条（受保护的正文安全只读查看通道）。
 *
 * ⚠️ agent:confirm-action **只登记用户的「同意/拒绝」**，它不执行任何动作。
 * 用户点头≠ 可以动手，中间还隔着预算终态判定、TTL、以及事务层。
 * 真正动手的是 agent:execute，且它执行时会**重跑一遍全部闸门**——
 * 提案期通过不算数，授权会过期、预算会熔断、提案会被逐出。
 *
 * ⚠️ 写「不含 execute 通道」这类源码级断言时，别用裸 /execute/ 去grep 本名单——
 * agent:execute 本身就是通道名，会自己命中自己。先剥注释再匹配通道字面量。
 */
const AGENT_CHANNELS = Object.freeze([
  'agent:get-status',
  'agent:get-capabilities',
  'agent:get-pending-proposal',
  'agent:get-proposal-content',
  'agent:propose-action',
  'agent:confirm-action',
  'agent:execute',
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
 * @param {object} options  { registry, policy, budget, auditLog, confirmation, maxAuditItems,
 *                            intentMotiveProvider }
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

  // 🔴 SEC-01：内容快照私有存储（仅主进程持有，杜绝渲染端篡改与未授权写盘）。
  //   快照绑定 proposalId，存放真正用于写盘的可信内容字符串。
  //   上界与提案注册表对齐；TTL 10 分钟；单次写入上限 5 MiB。
  const contentSnapshotStore = options.contentSnapshotStore || ctx.contentSnapshotStore || new Map();
  const MAX_CONTENT_BYTES = 5 * 1024 * 1024; // 5 MiB
  const SNAPSHOT_TTL_MS = 10 * 60 * 1000;    // 10 分钟

  function pruneSnapshots() {
    const now = Date.now();
    for (const [id, snap] of contentSnapshotStore.entries()) {
      if (!proposalStore.has(id) || (now - snap.createdAt > SNAPSHOT_TTL_MS)) {
        contentSnapshotStore.delete(id);
      }
    }
  }

  // 🔴 D-9：动机来源求值器 —— **只能由主进程注入，渲染端永远传不进来**。
  //
  //   签名：`() => ({ sources, kind }) | null`
  //
  //   ## 为什么必须是「主进程注入的函数」而不是通道参数
  //   另两条思路实测都不成立：
  //     ① 从 raw（渲染端 payload）里读 intentSources
  //        ⇒ 渲染端自己声称「这是她想做的」，正是 D-3 顶替攻击那一族。
  //        本文件下面 evaluateProposal(raw) 的注释已经写明：
  //        「renderer 侧传来的 meta 是攻击面，不是事实」。
  //     ② 让执行器在执行期自己去读 trigger.selfIntent
  //        ⇒ **时机是错的**。selfIntent 是「此刻」的意图，
  //          而审计要回答的是「建案那一刻她为什么想做这件事」。
  //          提案从建案到执行可能隔着用户的确认时间（人是会犹豫的），
  //          期间意图早变了 ⇒ 审计会记下一个**看起来合法但答非所问**的动机，
  //          而且不报错。这比记 null 坏得多。
  //   所以：**在建案这一瞬间求值一次，冻结进提案对象**，之后只读不重算。
  //
  //   ⚠️ 拿不到就返回 null，如实记 null。绝不编一个来源。
  const intentMotiveProvider = typeof options.intentMotiveProvider === 'function'
    ? options.intentMotiveProvider
    : null;

  // 🔴 D-11：主进程侧暂存的内容（她为自己留下的那句话）。
  //   由调用方注入 `takeStashedContent(proposalId)` —— **取用即删**。
  //   不注入则退回「只认渲染端传的 content」，行为与 D-10 一致。
  const takeStashedContent = typeof options.takeStashedContent === 'function'
    ? options.takeStashedContent
    : null;

  // 🔴 D-13：执行成功后的回调。主进程用它把「她写了什么」登记进 memory 的自述队列，
  //   从而在**她下一次开口时**回到她的意识里（D-11 的洞：她写完就忘）。
  //   不注入则完全退回旧行为（不登记任何东西）。
  const onExecuted = typeof options.onExecuted === 'function'
    ? options.onExecuted
    : null;

  /**
   * 在建案瞬间求一次动机。**只此一处调用**，求值结果随即冻结进提案。
   * 任何异常都吞掉并返回 null：动机记录失败绝不能挡住建案本身。
   */
  function resolveIntentMotive() {
    if (!intentMotiveProvider) return null;
    try {
      return intentMotiveProvider();
    } catch {
      return null;
    }
  }

  // D-4：受控执行器。可注入替身（测试用），默认用**同一批治理实例**组装——
  //   刻意复用 policy / budget / confirmation / proposalStore这四个：
  //   执行器若自己另建一套，就等于给自己开了旁路闸门（提案查不到、
  //   确认记录查不到、预算各算各的）。它必须在同一张表上做判定。
  // ⚠️ 位置必须在 proposalStore 之后 —— 提前声明会TDZ 报错。
  const executor = options.executor || ctx.executor || new ControlledAgentExecutor({
    policy,
    budget,
    confirmation,
    auditLog,
    proposalStore,
    transactionManager: options.transactionManager || ctx.transactionManager || undefined,
    txnDir: options.txnDir || ctx.txnDir || undefined,
  });

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

    // 🔴 F5 & SEC-03：写扩展名白名单同源前置校验与 Windows 畸形文件名/保留名防御。建案期即拦截，不扣减用户动作预算。
    if (capability === 'workspace.write') {
      const ext = path.extname(raw.scope || '').toLowerCase();
      if (isMalformedWindowsPath(raw.scope) || !ALLOWED_WRITE_EXTENSIONS.has(ext)) {
        return { code: 'DISALLOWED_EXTENSION', ok: false, ext: ext || 'none' };
      }
    }

    // ③ 预算熔断：熔断为终态，触发后不放行任何动作。
    //
    // 🔴 D-12 修正（反重力复核裁定的架构缺陷）：**建案期只扣 actions，不扣 writes。**
    //
    //   原先这里写 `budget.consume(capability === 'workspace.write')` ——
    //   即「只要是写能力，建案时就吃掉一次写额度」。
    //   错在哪：
    //     · 提案**可能被用户拒绝、或超时放弃**，文件从头到尾没碰过磁盘，
    //       而写额度已被永久扣掉 —— 这违背 writes 存在的全部意义。
    //     · `writes`（默认 5）是「防不可逆落盘」的高危闸门，
    //       它该管的时刻是**真正写磁盘那一瞬间**，不是「有人提了个议」。
    //     · `actions`（默认 20）才是通用动作计数：建案/确认/执行各算一次，合法。
    //
    //   ⇒ 现在三阶段的扣减口径：
    //       建案  consume(false) → actions      （本处）
    //       确认  consume(false) → actions      （下方 confirm 通道）
    //       执行  consume(isWrite) → writes     （agent-executor.js，真正落盘处）
    //
    //   ⚠️ capability 变量仍要保留做日志/审计，别删。
    if (!budget.consume(false)) {
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
        sandboxRoots: policy && policy.scopeRoots && typeof policy.scopeRoots.get === 'function'
          ? [...(policy.scopeRoots.get('workspace.write') || [])]
          : [],
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

  // 3. 🔴 D-5：安全取回待确认提案的只读快照。
  //
  //## 为什么必须有这条通道（这不是便利功能，是安全缺口）
  //
  //   D-3 起确认卡片需要「提案对象」才能渲染，但 proposalStore 在主进程侧，
  //   渲染端**拿不到真身**。于是只剩两条路：
  //     (a) 把提案对象整个丢给渲染端 → 它就是可篡改的，顶替攻击入口重新打开；
  //     (b) 主进程侧把卡片需要的字段组装好再返回 —— 渲染端拿到的**不是提案**，
  //         只是一份「照着提案做的展示快照」，改它没有任何用处。
  //   选(b)。所以下面每一条字段都是**白名单挑选**，不是 {...proposal} 展开。
  //
  //## 🔴 三条不变式
  //
  //   1. **快照必须 Object.freeze**。冻结不是装饰：渲染端拿到的对象若可改，
  //      就能把 capability 从 workspace.read 改成 workspace.write 再去确认，
  //      而用户看到的是另一个能力 —— 与 id 顶替同型，只是换了个入口。
  //      （D-4 实测：Object.freeze 是这类防线里唯一真正生效的那个，
  //      非严格模式下对冻结对象赋值是**静默失败**，不会静默通过。）
  //   2. **绝不返回提案对象本身**，只返回挑出来的字段。
  //   3. **只认「还没被确认过」的提案**。已确认/已拒绝/已撤销的一律不返回：
  //      卡片再次弹出同一个提案 = 变相重放。
  //
  //## 只读快照不是权限判定
  //
  //   这条通道只解决「渲染什么」，**不解决「能不能执行」**。
  //   即便有人伪造快照，confirm 与 execute 仍会回proposalStore 核对真身。
  //   这里是第一层减少攻击面，不是唯一一道闸门。
  ipcGuard.handle('agent:get-pending-proposal', guard((event, raw) => {
    assertByHandler(event);
    // 跨进程输入不可信：只认一个 proposalId，其余字段一概不看。
    const id = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? String(raw.proposalId || '').trim()
      : '';
    if (!id) return fail('PROPOSAL_ID_REQUIRED');

    const tracked = proposalStore.get(id);
    if (!tracked) return fail('PROPOSAL_NOT_FOUND');

    // 不变式 3：已经产生过决策的提案不再展示。
    //   records 里没有才说明「还没投过票」；有则无论批还是拒都不该再弹。
    if (confirmation.lookup(id)) return fail('ALREADY_DECIDED');

    // 🔴 D-19：**已执行**的提案同样不该再展示。
    //
    //   上面那条只看 confirmation 的决策记录 —— 而**免确认路径（selfNote）
    //   从不产生决策记录**，所以只靠它挡不住「已写完的提案又被当成待确认」。
    //   （执行器成功时会 revoke(proposalId)，但对无记录的提案那是 NOT_CONFIRMED，
    //    等于没兜住。）
    //
    //   ⚠️ 这是纵深防御：主因（D-19 的错广播）已修，但「展示层不得展示已执行的提案」
    //     这条不变式本身就该独立成立，不该依赖上游「恰好没广播」。
    //   用 executor.consumed 查 —— 那是执行器真实的消费记录，不是推断。
    if (executor && executor.consumed && typeof executor.consumed.has === 'function'
      && executor.consumed.has(id)) {
      return fail('ALREADY_EXECUTED');
    }

    let isOverwrite = false;
    if (tracked.capability === 'workspace.write' && typeof tracked.scope === 'string' && tracked.scope) {
      try {
        const fsImpl = options.fs || fs;
        isOverwrite = fsImpl.existsSync(path.resolve(tracked.scope));
      } catch {
        isOverwrite = false;
      }
    }

    const meta = registry.metaOf(tracked.capability) || {};
    const snapshot = Object.freeze({
      id: tracked.id,
      capability: tracked.capability,
      scope: String(tracked.scope || ''),
      reason: String(tracked.reason || ''),
      status: String(tracked.status || ''),
      dangerLevel: meta.dangerLevel || 'unknown',
      requiresConfirm: meta.requiresConfirm !== false,
      // 🔴 UX-SEC-01：沙盒覆写风险标记（主进程权威检测，供确认卡片渲染展示）
      isOverwrite: Boolean(isOverwrite),
      // 🔴 SEC-01：展示层安全元数据白名单透出（杜绝未授权暴露完整正文）
      contentHash: tracked.contentHash || null,
      contentBytes: Number.isFinite(tracked.contentBytes) ? tracked.contentBytes : null,
      contentPreview: typeof tracked.contentPreview === 'string' ? tracked.contentPreview : null,
      isTruncated: Boolean(tracked.isTruncated),
    });
    return { ok: true, proposal: snapshot, budget: budget.state() };
  }));

  // 3b. 🔴 SEC-01：受保护的提案完整正文安全只读查看通道。
  //   用于在用户确认抽屉中按需拉取可信正文展示。
  //   四道安全拦截：
  //     ① 跨进程身份必须受信（assertByHandler）；
  //     ② 提案必须在 proposalStore 中且尚未决策（ALREADY_DECIDED / ALREADY_EXECUTED 拦截）；
  //     ③ 必须存在有效快照且未过期；
  //     ④ 纯只读，不消耗动作预算，不改动提案状态。
  ipcGuard.handle('agent:get-proposal-content', guard((event, raw) => {
    assertByHandler(event);
    const id = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? String(raw.proposalId || '').trim()
      : '';
    if (!id) return fail('PROPOSAL_ID_REQUIRED');

    const tracked = proposalStore.get(id);
    if (!tracked) return fail('PROPOSAL_NOT_FOUND');

    if (confirmation.lookup(id)) return fail('ALREADY_DECIDED');

    if (executor && executor.consumed && typeof executor.consumed.has === 'function'
      && executor.consumed.has(id)) {
      return fail('ALREADY_EXECUTED');
    }

    const snap = contentSnapshotStore.get(id);
    if (!snap) return fail('SNAPSHOT_NOT_FOUND');

    if (Date.now() - snap.createdAt > SNAPSHOT_TTL_MS) {
      contentSnapshotStore.delete(id);
      return fail('SNAPSHOT_EXPIRED');
    }

    return {
      ok: true,
      proposalId: id,
      content: snap.content,
      contentBytes: snap.contentBytes,
      contentHash: snap.contentHash,
    };
  }));

  // 4. 提案受理：过三道闸门后建案并记审计。**本通道不执行任何动作。**
  //
  // 🔴 D-10：函数体抽成 `proposeInternal`，**通道与主进程建案路径共用这一份**。
  //   为什么抽：主进程现在也要建案（读 _pendingAgentIntent），
  //   如果它自己再写一遍「形态校验 → 授权 → 预算 → createActionProposal → 进注册表」，
  //   就出现两套建案逻辑 —— 而注册表登记、逐出、授权作废这些**必须单点**，
  //   两套迟早漂移，且漂移的那一侧就是漏洞。
  //
  //   ⚠️ 抽出来之后通道只剩「身份校验 + 信封化」，`via: 'ipc'` 由调用方区分：
  //     通道传 'ipc'，主进程传 'main'。审计里能看出提案是谁发起的。
  function proposeInternal(raw, via, source, trustedContent) {
    const src = via === 'main' ? 'main' : 'ipc';
    // 🔴 D-17：来源由**主进程侧**决定，经独立参数传入（不读 raw）。
    //   通道来的（渲染端）永远只能是 'user'；只有主进程建案时才能给 'selfNote'。
    //   ⚠️ 这里不做白名单校验（createActionProposal 内已兜底），
    //     但**必须只认这两个值** —— 未知值一律按 'user' 传下去。
    const proposalSource = src === 'main' && source === 'selfNote' ? 'selfNote' : 'user';

    // 🔴 SEC-01 & F4：写能力权威内容快照强制绑定（P1 级安全防御 + 校验先于计费）
    //   所有 workspace.write 提案必须在建案时取得有效字符串正文。
    //   普通 IPC 提案必须提供 raw.content；selfNote 必须使用主进程可信的 trustedContent。
    //   正文缺失、类型错误、空字符串或超限时，直接拒绝建案，不扣减用户动作预算，不得创建提案或授权记录。
    let contentMeta = null;
    let candidate = null;
    if (raw && raw.capability === 'workspace.write') {
      candidate = (src === 'main' && proposalSource === 'selfNote')
        ? trustedContent
        : (raw && raw.content);

      if (typeof candidate !== 'string') {
        auditLog.append({
          channel: 'agent:propose-action',
          outcome: 'rejected',
          code: 'INVALID_PROPOSAL',
          detail: 'CONTENT_REQUIRED',
          capability: 'workspace.write',
          via: src,
        });
        return fail('INVALID_PROPOSAL', { detail: 'CONTENT_REQUIRED' });
      }
      if (candidate.length === 0) {
        auditLog.append({
          channel: 'agent:propose-action',
          outcome: 'rejected',
          code: 'INVALID_PROPOSAL',
          detail: 'CONTENT_EMPTY',
          capability: 'workspace.write',
          via: src,
        });
        return fail('INVALID_PROPOSAL', { detail: 'CONTENT_EMPTY' });
      }
      const byteLen = Buffer.byteLength(candidate, 'utf8');
      if (byteLen > MAX_CONTENT_BYTES) {
        auditLog.append({
          channel: 'agent:propose-action',
          outcome: 'rejected',
          code: 'PAYLOAD_TOO_LARGE',
          capability: 'workspace.write',
          via: src,
        });
        return fail('PAYLOAD_TOO_LARGE');
      }
      const hash = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex');
      contentMeta = {
        contentHash: hash,
        contentBytes: byteLen,
        contentPreview: candidate.slice(0, 300),
        isTruncated: candidate.length > 300,
      };
    }

    const evaluated = evaluateProposal(raw);
    if (!evaluated.ok) {
      // 拒绝也要留痕 —— 审计的价值一半在这里。
      auditLog.append({
        channel: 'agent:propose-action',
        outcome: 'rejected',
        code: evaluated.code,
        capability: String((raw && raw.capability) || '').slice(0, 64),
        reason: evaluated.reason || null,
        via: src,
      });
      if (evaluated.code === 'BUDGET_TRIPPED') {
        return fail('BUDGET_TRIPPED', { budget: evaluated.state });
      }
      if (evaluated.code === 'AUTHORIZED_REJECTED') {
        return fail('AUTHORIZED_REJECTED', { reason: evaluated.reason });
      }
      if (evaluated.code === 'DISALLOWED_EXTENSION') {
        return fail('DISALLOWED_EXTENSION', { ext: evaluated.ext });
      }
      return fail(evaluated.code);
    }

    let proposal;
    try {
      // 🔴 D-9：动机作为**独立第二参数**传入，刻意不进 raw。
      //   raw 是渲染端 payload，混进去就等于让她自报动机。
      // 🔴 D-17：来源作为**独立第三参数**传入，理由同上 ——
      //   渲染端能自报来源，就等于能给自己的提案免确认。
      // 🔴 SEC-01：内容元数据作为**独立第四参数**传入，由主进程权威生成。
      proposal = createActionProposal(raw, resolveIntentMotive(), proposalSource, contentMeta);
    } catch (err) {
      auditLog.append({
        channel: 'agent:propose-action',
        outcome: 'rejected',
        code: 'PROPOSAL_CONSTRUCTION_FAILED',
        capability: evaluated.capability,
        via: src,
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
      // 🔴 D-9：建案侧也记动机。理由：执行记录能查到动机，
      //   但「这个提案是怎么冒出来的」在 agent:propose-action 这条通道上更早，
      //   这里不记就得等执行后才看得到 —— 而提案可能被预算/确认拦下，永不执行。
      //   三字段恒存在（取自刚冻结的提案，不重新求值）。
      intentSources: proposal.intentSources,
      intentKind: proposal.intentKind,
      intentOrigin: proposal.intentOrigin,
      // 🔴 D-17：建案侧也记来源，便于事后核对「这条是她自发的还是用户要的」。
      //   ⚠️ 同时修掉一个 D-10 留下的笔误：这里原写死 `via: 'ipc'`，
      //      导致**主进程建案也被记成通道来的** —— src 才是真实来源。
      proposalSource: proposal.proposalSource,
      via: src,
    });

    // 建案通道：只建案，绝不执行。D-1 时这里刻意不接执行器，
    // 一旦有人误接会立刻炸而不是静默半执行；D-4 起执行器换成
    // ControlledAgentExecutor，但仍**必须**经agent:execute 通道由用户确认后驱动，
    // 本通道无论如何都不碰文件。
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
        contentSnapshotStore.delete(oldest.value);
        confirmation.revoke(oldest.value, 'PROPOSAL_EVICTED');
      }
    }
    proposalStore.set(proposal.id, proposal);
    if (candidate !== null && candidate !== undefined && contentMeta) {
      contentSnapshotStore.set(proposal.id, {
        content: candidate,
        contentHash: contentMeta.contentHash,
        contentBytes: contentMeta.contentBytes,
        contentPreview: contentMeta.contentPreview,
        isTruncated: contentMeta.isTruncated,
        createdAt: Date.now(),
        retryCount: 0,
      });
    }

    return { ok: true, proposal, executed: false, budget: budget.state() };
  }

  // 通道外壳：只做身份校验 + 信封化，业务体与主进程共用 proposeInternal。
  ipcGuard.handle('agent:propose-action', guard((event, raw) => {
    assertByHandler(event);
    return proposeInternal(raw, 'ipc');
  }));

  // 5. 用户显式确认（D-3 第四道闸门）
  // 🔴 本通道**只登记决策，绝不执行**。用户点了【授权】不代表可以动手——
  //    D-4 起真正落盘的是 agent:execute 通道，且它会重跑全部闸门（TTL/预算/提案存在性），
  //    一条授权不能被复用。这条边界不能松。
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
    pruneSnapshots();

    if (decision === 'rejected') {
      contentSnapshotStore.delete(proposalId);
    }

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

  // 6. 🔴 D-4：执行通道 —— 第一条**真正会动磁盘**的通道。
  //
  //与 D-1~D-3 的根本区别：前四条全是纯治理（查询/ 登记），不碰用户文件；
  // 本条会真的读写真实文件。因此它的每一行都必须假设「调用方在攻击」。
  //
  //本通道**只做一件事**：把 proposalId 交给受控执行器。
  // 闸门判定全部在 agent-executor.js 内部（那里才是闸门所在，本层不重复实现）——
  //   重复实现闸门是这类系统最常见的漏洞来源：两处判定迟早会漂移，
  //   然后攻击者挑那处漂移的走。本层只做身份校验 + 错误信封化。
  //
  //   content 只能从这一层传入（执行器内部不接受对象，只接受字符串），
  //   路径**永远取自提案**，绝不信调用方传的路径 —— 否则 scope 白名单形同虚设。
  // 🔴 D-17：把执行体抽成 `executeInternal`，**通道与主进程自动执行共用这一份**。
  //   为什么抽（与 D-10 抽 proposeInternal 同一理由）：
  //   自发愿望（selfNote）没有卡片可点 ⇒ 主进程要自己触发执行；
  //   若它另写一遍「取暂存内容 → 调执行器 → 触发 hook」，就出现两套执行路径，
  //   而**闸门判定、审计、hook 必须单点** —— 两套迟早漂移，漂移的那侧就是漏洞。
  //
  //   ⚠️ 通道外壳只多一件事：`assertByHandler(event)` 身份校验。
  //     主进程侧不需要它（调用方不是渲染端），但闸门 1~5 一个不少。
  function executeInternal(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('INVALID_INPUT');
    }

    const proposalId = String(raw.proposalId || '').trim();
    const trackedProposal = proposalStore.get(proposalId);
    const snap = contentSnapshotStore.get(proposalId);
    const isWrite = trackedProposal && trackedProposal.capability === 'workspace.write';

    if (isWrite) {
      if (!snap) {
        const allowed = confirmation && typeof confirmation.isExecutionAllowed === 'function'
          ? confirmation.isExecutionAllowed(proposalId)
          : null;
        if (allowed && allowed.allowed === false) {
          // 让下游执行器如实返回确切决策原因（如 REJECTED_BY_USER、NOT_CONFIRMED 等）
        } else {
          const code = (trackedProposal && trackedProposal.contentHash) ? 'SNAPSHOT_EXPIRED' : 'SNAPSHOT_MISSING';
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, code);
          }
          return fail(code);
        }
      } else {
        if (Date.now() - snap.createdAt > SNAPSHOT_TTL_MS) {
          contentSnapshotStore.delete(proposalId);
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, 'SNAPSHOT_EXPIRED');
          }
          return fail('SNAPSHOT_EXPIRED');
        }
        // 🔴 SEC-01：不可变权威快照强核验（四道硬校验）
        //   1. snapshot.content 是有效字符串
        //   2. 重算 SHA-256 必须与快照自身记录一致
        //   3. 快照哈希必须与不可变提案上冻结的 proposal.contentHash 一致
        //   4. 实际 UTF-8 字节数与 proposal.contentBytes 一致，且不超过 5 MiB
        if (typeof snap.content !== 'string') {
          contentSnapshotStore.delete(proposalId);
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, 'CONTENT_HASH_MISMATCH');
          }
          return fail('CONTENT_HASH_MISMATCH', { detail: 'SNAPSHOT_CONTENT_INVALID' });
        }
        const recomputedHash = crypto.createHash('sha256').update(snap.content, 'utf8').digest('hex');
        if (recomputedHash !== snap.contentHash) {
          contentSnapshotStore.delete(proposalId);
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, 'CONTENT_HASH_MISMATCH');
          }
          return fail('CONTENT_HASH_MISMATCH', { detail: 'SNAPSHOT_TAMPERED' });
        }
        if (trackedProposal && trackedProposal.contentHash && snap.contentHash !== trackedProposal.contentHash) {
          contentSnapshotStore.delete(proposalId);
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, 'CONTENT_HASH_MISMATCH');
          }
          return fail('CONTENT_HASH_MISMATCH', { detail: 'PROPOSAL_HASH_MISMATCH' });
        }
        const actualBytes = Buffer.byteLength(snap.content, 'utf8');
        if (trackedProposal && Number.isFinite(trackedProposal.contentBytes) && actualBytes !== trackedProposal.contentBytes) {
          contentSnapshotStore.delete(proposalId);
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, 'CONTENT_BYTES_MISMATCH');
          }
          return fail('CONTENT_BYTES_MISMATCH', { detail: 'PROPOSAL_BYTES_MISMATCH' });
        }
        if (actualBytes > MAX_CONTENT_BYTES) {
          contentSnapshotStore.delete(proposalId);
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, 'PAYLOAD_TOO_LARGE');
          }
          return fail('PAYLOAD_TOO_LARGE');
        }
      }
    }

    // 🔵 D-11 / 🔴 SEC-01: 若主进程注入了自发便签暂存取用器，优先取用暂存内容
    // （自发便签内容由主进程内部产出，不经渲染端中转，防篡改）。
    // 在 SEC-01 下，写入正文绝不允许回退使用 raw.content，必须且只能来自已核验的权威快照 snap.content。
    const stashed = typeof takeStashedContent === 'function'
      ? takeStashedContent(proposalId)
      : null;
    const effectiveContent = stashed !== null && stashed !== undefined
      ? (snap ? snap.content : undefined)
      : (isWrite ? (snap ? snap.content : undefined) : undefined);

    const result = executor.execute({
      proposalId: raw.proposalId,
      content: effectiveContent,
    });
    // 执行器已返回统一信封，这里只做形状归一：ok=false 时把 code 提升为 error，
    // 保持与其余五条通道 { ok, error } 的约定一致（渲染层只需认一种形状）。
    // 两个刻意的取舍：
    //   ① **不保留 code** —— 两条同义字段会让渲染端不知认哪个，
    //      日后有人只读 code 而另一处只读 error，就会出现「同一错误两种表现」。
    //   ② **保留 ok:false** —— 不能把 ok 一起丢掉：渲染层的 if (r.ok) 分支
    //      是全通道共用的，少了 ok 会被判成"成功但无字段"，比报错更危险。
    //      （实测踩过：归一化时 destructuring 掉了 ok，渲染端会走成功分支。）
    if (!result.ok) {
      if (snap) {
        snap.retryCount = (snap.retryCount || 0) + 1;
        // 🔴 SEC-01 重试状态机：只有明确可重试的 I/O 故障（EXECUTION_FAILED 且回滚成功），
        // 且重试次数恰为 1 时，才保留原始快照允许重试一次。
        // 若回滚失败、安全校验不符或已重试过，立即清理快照并撤销授权，严禁任何重试。
        const isRetryableIO = result.code === 'EXECUTION_FAILED' && !result.rollbackFailed;
        if (!isRetryableIO || snap.retryCount > 1) {
          contentSnapshotStore.delete(proposalId);
          if (confirmation && typeof confirmation.revoke === 'function') {
            confirmation.revoke(proposalId, snap.retryCount > 1 ? 'RETRY_EXHAUSTED' : (result.code || 'EXECUTION_FAILED'));
          }
        }
      }
      const { ok, code, ...rest } = result;
      return { ok: false, ...rest, error: code };
    }

    // 成功执行：清理快照与暂存
    contentSnapshotStore.delete(proposalId);
    if (typeof takeStashedContent === 'function') {
      takeStashedContent(proposalId);
    }

    // 🔴 D-13：执行成功后，把「她写了什么」交回调用方（主进程侧的 onExecuted hook）。
    //
    //   为什么必须在这里、而不是让渲染端回报：
    //     `effectiveContent` 是**主进程求得的**（D-11 的暂存内容，或本次调用的 raw.content），
    //     且 `takeStashedContent` 已把它从暂存表删除（read-and-delete）。
    //     若等渲染端回报，内容来源就变成不可信输入 —— 与她写下的东西由渲染端改写等价。
    //
    //   ⚠️ 三条纪律：
    //     1. **只在 ok===true 时触发**（决策 4：写失败不告诉她，也不入队）。
    //     2. **hook 异常一律吞掉** —— 它挂在执行成功之后，抛错会让用户以为写入失败。
    //     3. **不 await** —— hook 只是登记，不该拖住 IPC 返回。
    //
    //   注：proposal.scope 是主进程的绝对路径，fileName 只取 basename（由 memory 侧再兜一层）。
    //   ⚠️ 字段名以执行器的**实际返回**为准（写文件返回 { bytes, target }，
    //      target 已经是 basename；读文件返回的东西不同，故这里做形状守卫而不硬取）。
    if (typeof onExecuted === 'function') {
      try {
        const r = (result && result.result) || {};
        onExecuted({
          proposalId: String(raw.proposalId || ''),
          // 写文件路径：执行器已给 basename；读文件没有 target，则退回 null
          name: typeof r.target === 'string' ? r.target : null,
          bytes: typeof r.bytes === 'number' ? r.bytes : null,
          content: effectiveContent,
          // 🔴 D-24：提案来源随回执带出（执行器闸门内已认定，非渲染端自报），
          //   主进程据此只把「她自发写下的字」标为可铸自传的 selfNote。
          proposalSource: String((result && result.proposalSource) || ''),
        });
      } catch (e) { /* 旁路：登记失败绝不能影响执行结果本身 */ }
    }

    return result;
  }

  // 通道外壳：只做身份校验，执行体与主进程自动执行共用 executeInternal。
  ipcGuard.handle('agent:execute', guard((event, raw) => {
    assertByHandler(event);
    return executeInternal(raw);
  }));

  // 7. 审计读取（脱敏由 AuditLog 保证；此处只做条数上限，避免一次拉爆内存）
  ipcGuard.handle('agent:get-audit-log', guard((event, opts = {}) => {
    assertByHandler(event);
    const all = auditLog.list();
    const limit = Number.isFinite(opts && opts.limit) ? Math.max(1, Math.floor(opts.limit)) : maxAuditItems;
    // 默认只给**最近 limit 条**（最新在尾部）；tail:false 时从头取。
    const fromTail = !(opts && opts.tail === false);
    const slice = fromTail ? all.slice(-limit) : all.slice(0, limit);
    return { ok: true, total: all.length, returned: slice.length, events: slice };
  }));

  // 🔴 D-10：把**实例化的**判定函数交出去，而不是导出模块级的裸函数。
  //
  //   为什么不能直接 `module.exports.evaluateProposal = evaluateProposal`：
  //   它是个闭包，依赖本次注册时的 policy / budget 实例。
  //   导出它等于导出一个「没有绑定任何策略」的空壳 —— 调用方拿到的判定
  //   与真正生效的那套不是同一份，那就是**两套判定**，正是本仓最不吃的东西。
  //
  //   所以返回对象：注册成功时附带一个 `evaluateProposal`，
  //   调用方（main.js 的主进程建案路径）复用它，
  //   **绝不允许**在别处复刻这三步（形态校验 → 授权 → 预算）。
  //
  //   兼容性：旧调用方只判真假（`if (!registerAgentIpc(...))`），
  //   对象恒为 truthy，行为不变。
  return { ok: true, evaluateProposal, proposeInternal, executeInternal };
}

module.exports = { registerAgentIpc, AGENT_CHANNELS };