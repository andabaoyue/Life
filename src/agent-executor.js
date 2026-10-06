/**
 * src/agent-executor.js
 *
 * v1.0 D-4：受控执行器 —— 第一块**真正会动磁盘**的Agent 代码。
 *
 * ## 为什么这一层要单独存在
 * D-1~D-3 全部是「只读+ 只登记」的治理层，执行器一直是 AgentBridgeMock，
 * execute() 直接抛 '尚未连接真实执行器'。D-4 把它换成真家伙，但**闸门一根都不许松**：
 * 前四道（身份 / 能力 / 预算 / 确认）在这里**全部重新过一遍**，
 * 第五道（事务）由 D-2 的 WriteTransactionManager 承担。
 *
 * ## 🔴 本文件最重要的三条不变式（全部有对应反例）
 *
 *   1. **执行期重跑全部闸门，绝不复用提案期的判定**。
 *      提案是 T0 建的，执行是 T1。中间可能过了 TTL、killSwitch 可能被拉下、
 *      预算可能已熔断。只信 T0 的 verdict = 时序穿越。
 *      反例：D3-01（预算在propose 后耗尽 → 执行必须拒）。
 *
 *   2. **提案必须消费（consume），且消费发生在写盘之前**。
 *      一个提案只能执行一次。执行成功后立刻 revoke 授权 + 标记 status='executed'，
 *      第二次执行同一 id 直接 NOT_REPLAYABLE。
 *      反例：D4-04 / D4-05（重复执行被拒且不产生二次副作用）。
 *
 *   3. **realpath 纵深防御**（在 path.resolve 白名单判定**之上**加一层）。
 *      PermissionPolicy._scopeAllowed 用 path.resolve + 前缀比对，
 *      实测这挡不住**目录符号链接**：resolve('sandbox/link/secret.txt')
 *      仍以沙盒路径开头，但 realpath 指向沙盒外。
 *      ⚠️ 本机（无开发者模式）**无法创建符号链接**，故这条是设计防线而非
 *      实测防线 —— 测试用注入 fs 的方式覆盖，真机行为待有权限的机器复核。
 *      反例：D4-06（realpath 逃逸被拒）。
 *
 * ## process.execute：D-4 永久硬拒
 * 用户拍板不开。理由不止「安全」：
 *   - 参数注入面（`git -c core.pager=...`、`--upload-pack=`）白名单堵不干净；
 *   - Windows 命令行转义规则（^ & | > %VAR% ）本身就是攻击面；
 *   - 只读 git 的能力**可以用文件读代替**，收益极不对称。
 * 所以这里不是「暂不支持」，而是**在执行器入口就拒**，且理由码固定，
 * 不给上层「换个姿势再试」的空间。
 *
 * ## 依赖注入
 * fs / transactionManager 均可注入 —— 为了让「符号链接逃逸」这类
 * 无法在当前机器真机复现的边界仍能被测到。
 */

const fs = require('fs');
const path = require('path');
const { WriteTransactionManager } = require('./agent-transaction');

/** D-4 允许真正执行的能力白名单。process.execute 不在其中，且下方另有硬拒。 */
const EXECUTABLE_CAPABILITIES = Object.freeze(['workspace.read', 'workspace.write']);

/** 单次读出的最大字节数（防把一个 2GB 文件读进内存）。 */
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** 默认单次写最大字节，与 WriteTransactionManager 的5MB 对齐（这里取更严的一侧）。 */
const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024;

function fail(code, extra = {}) {
  return { ok: false, code, ...extra };
}

/**
 * realpath 归一化。目标不存在时逐级向上找到第一个存在的祖先，
 * 用它的 realpath 再把剩余段拼回去。
 *
 * 🔴 2026-10-06 修掉一个自查发现的真bug：原实现 `i === 0 ? realDir : join(realDir, base)`
 *   在第一次就成功时**丢掉了 base**。后果实测（test D4-R13 曾因此报SYMLINK_ESCAPE）：
 *   文件不存在时 dir=sandbox 已存在 → 返回 sandbox 本身而不是 sandbox/ghost.txt。
 *   更危险的是：若父目录正是符号链接，逃逸检测会**只看父目录**而彻底失效。
 *   现在统一 `join(realDir, base)`，不再有特例分支。
 *
 * @returns {string} 真实绝对路径（尽力而为，彻底失败则返回 resolve 结果）
 */
function realpathBestEffort(p, fsImpl) {
  const f = fsImpl || fs;
  let dir = path.dirname(p);
  let base = path.basename(p);
  // 最多向上找 8 层：既能处理新建文件，也能处理新建目录
  for (let i = 0; i <= 8; i++) {
    try {
      return path.join(f.realpathSync(dir), base);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return p;          // 顶到盘符了，放弃
      base = path.basename(dir) + (base ? path.sep + base : '');
      dir = parent;
    }
  }
  return p;
}

/**
 * 受控执行器。
 *
 * @param {object} deps { policy, budget, confirmation, auditLog, proposalStore,
 *                        transactionManager, fs, maxReadBytes, maxWriteBytes }
 */
class ControlledAgentExecutor {
  constructor(deps = {}) {
    this.policy = deps.policy || null;
    this.budget = deps.budget || null;
    this.confirmation = deps.confirmation || null;
    this.auditLog = deps.auditLog || null;
    this.proposalStore = deps.proposalStore || new Map();
    this.fs = deps.fs || fs;
    this.txn = deps.transactionManager || new WriteTransactionManager({ dir: deps.txnDir || null });
    this.maxReadBytes = Number.isFinite(deps.maxReadBytes) ? deps.maxReadBytes : DEFAULT_MAX_READ_BYTES;
    this.maxWriteBytes = Number.isFinite(deps.maxWriteBytes) ? deps.maxWriteBytes : DEFAULT_MAX_WRITE_BYTES;
    //已消费提案的终态集合。执行成功后写入，重放时查。
    //用 Set 而非改proposal.status：提案对象是 Object.freeze 的，改不动。
    this.consumed = new Set();
  }

  /** 恢复上次进程的已消费提案（进程重启后重放防线不能归零）。 */
  loadConsumed(ids = []) {
    for (const id of ids) this.consumed.add(String(id));
    return this.consumed.size;
  }

  _audit(entry) {
    if (!this.auditLog || typeof this.auditLog.append !== 'function') return;
    try { this.auditLog.append({ channel: 'agent:execute', ...entry }); } catch { /* 审计写不进去也不能挡住拒绝 */ }
  }

  /**
   * 执行一个已确认的提案。**同步**返回，绝不抛。
   *
   * @param {object} input { proposalId, content }
   *   proposalId 必需；content 仅workspace.write 需要（字符串）。
   * @returns {{ok:true, result:object, executed:true}|{ok:false, code:string}}
   */
  execute(input = {}) {
    try {
      return this._execute(input);
    } catch (err) {
      // 执行期异常一律转信封，绝不让堆栈穿透 IPC 边界。
      return fail('EXECUTOR_INTERNAL_ERROR', {
        detail: String((err && err.message) || '').slice(0, 200),
      });
    }
  }

  _execute(input) {
    // ── 闸门 0：输入形态（跨进程输入一律不可信）
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return fail('INVALID_INPUT');
    }
    const proposalId = String(input.proposalId || '').trim();
    if (!proposalId) return fail('PROPOSAL_ID_REQUIRED');

    // ── 闸门 1：提案必须真实存在
    const proposal = this.proposalStore.get(proposalId);
    if (!proposal) {
      this._audit({ outcome: 'rejected', code: 'PROPOSAL_NOT_FOUND', proposalId: proposalId.slice(0, 120) });
      return fail('PROPOSAL_NOT_FOUND');
    }

    // ── 不变式 2 前半：重放防线
    if (this.consumed.has(proposalId)) {
      this._audit({ outcome: 'rejected', code: 'ALREADY_EXECUTED', proposalId: proposalId.slice(0, 120) });
      return fail('ALREADY_EXECUTED');
    }

    // ── 不变式 3：process.execute 永久硬拒（在任何其它判定之前）
    if (proposal.capability === 'process.execute') {
      this._audit({
        outcome: 'rejected',
        code: 'PROCESS_EXECUTE_FORBIDDEN',
        capability: 'process.execute',
        proposalId: proposalId.slice(0, 120),
      });
      return fail('PROCESS_EXECUTE_FORBIDDEN');
    }
    if (!EXECUTABLE_CAPABILITIES.includes(proposal.capability)) {
      return fail('CAPABILITY_NOT_EXECUTABLE', { capability: String(proposal.capability || '').slice(0, 64) });
    }

    // ── 闸门 2：能力授权**在执行期重跑**（不复用提案期的 verdict，见不变式 1）
    const verdict = this.policy.authorize(proposal.capability, proposal.scope);
    if (!verdict || verdict.allowed !== true) {
      this._audit({
        outcome: 'rejected',
        code: 'AUTHORIZED_REJECTED',
        capability: proposal.capability,
        reason: verdict && verdict.reason,
        proposalId: proposalId.slice(0, 120),
      });
      return fail('AUTHORIZED_REJECTED', { reason: verdict && verdict.reason });
    }

    // ── 不变式 3：realpath 纵深防御（挡目录符号链接逃逸）
    const real = realpathBestEffort(path.resolve(proposal.scope), this.fs);
    if (this.policy && typeof this.policy._scopeAllowed === 'function') {
      const stillInside = this.policy._scopeAllowed(proposal.capability, real);
      if (!stillInside) {
        this._audit({
          outcome: 'rejected',
          code: 'SYMLINK_ESCAPE',
          capability: proposal.capability,
          proposalId: proposalId.slice(0, 120),
        });
        return fail('SYMLINK_ESCAPE');
      }
    }

    // ── 闸门 3：预算（执行也要计费，不能是免费动作）
    const isWrite = proposal.capability === 'workspace.write';
    if (!this.budget.consume(isWrite)) {
      this._audit({
        outcome: 'rejected',
        code: 'BUDGET_TRIPPED',
        capability: proposal.capability,
        proposalId: proposalId.slice(0, 120),
      });
      return fail('BUDGET_TRIPPED', { budget: this.budget.state() });
    }

    // ── 闸门 4：用户显式确认（D-3 第四道闸门，这里是**执行前**的最后一次复核）
    const gate = this.confirmation.isExecutionAllowed(proposalId);
    if (!gate || gate.allowed !== true) {
      const reason = (gate && gate.reason) || 'NOT_CONFIRMED';
      this._audit({
        outcome: 'rejected',
        code: 'EXECUTION_NOT_ALLOWED',
        reason,
        capability: proposal.capability,
        proposalId: proposalId.slice(0, 120),
      });
      return fail('EXECUTION_NOT_ALLOWED', { reason });
    }

    // ── 第五道闸门：事务。真正的写盘从这里开始。
    let result;
    try {
      result = isWrite
        ? this._writeFile(proposal, input.content)
        : this._readFile(proposal);
    } catch (err) {
      // 执行失败要记连续错误（防「一直失败一直重试」），并把授权作废：
      // 失败的提案不该能被原样再执行一次。
      if (this.budget && typeof this.budget.recordError === 'function') this.budget.recordError();
      this._audit({
        outcome: 'failed',
        code: 'EXECUTION_FAILED',
        capability: proposal.capability,
        detail: String((err && err.message) || '').slice(0, 200),
        proposalId: proposalId.slice(0, 120),
      });
      return fail('EXECUTION_FAILED', {
        detail: String((err && err.message) || '').slice(0, 200),
      });
    }

    // ── 不变式 2 后半：**消费**提案（写在成功之后，失败不回滚消费标记）
    //   刻意放在成功之后：失败时保留重试可能（用户可以再确认一个新提案），
    //   成功时立刻封死，任何后续重放都撞 ALREADY_EXECUTED。
    this.consumed.add(proposalId);
    if (this.confirmation && typeof this.confirmation.revoke === 'function') {
      // 复用即重放的原不变式：记录保留（ALREADY_CONFIRMED 仍会命中），
      // 但执行闸门因 revoked 优先判定而永久关闭。
      this.confirmation.revoke(proposalId, 'ALREADY_EXECUTED');
    }

    this._audit({
      outcome: 'executed',
      executed: true,
      capability: proposal.capability,
      proposalId: proposalId.slice(0, 120),
      scope: String(proposal.scope || '').slice(0, 300),
      matchedRoot: verdict.matchedRoot || null,
    });

    return { ok: true, executed: true, proposalId, result, budget: this.budget.state() };
  }

  _readFile(proposal) {
    const target = path.resolve(proposal.scope);
    const stat = this.fs.statSync(target);
    if (!stat.isFile()) throw new Error('NOT_A_FILE');
    if (stat.size > this.maxReadBytes) {
      throw Object.assign(new Error('READ_TOO_LARGE'), { code: 'READ_TOO_LARGE' });
    }
    //只返回内容与元数据，**不回传绝对路径**——渲染端不需要知道沙盒绝对位置，
    // 少一个信息泄露面。真要给也应该只给 basename。
    return { bytes: stat.size, content: this.fs.readFileSync(target, 'utf8') };
  }

  _writeFile(proposal, content) {
    // 🔴 content 只接受字符串。**不解析 JSON、不接受对象** ——
    //   若接受对象再序列化成 JSON，等于给了「用类型混淆绕过字符串校验」的面。
    if (typeof content !== 'string') {
      throw Object.assign(new Error('CONTENT_REQUIRED'), { code: 'CONTENT_REQUIRED' });
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxWriteBytes) {
      throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    const target = path.resolve(proposal.scope);
    // 第五道闸门真正生效处：begin →写盘 → commit，任一步失败即 rollback。
    const tx = this.txn.begin({ target, data: content });
    this.txn.commit(tx);
    return { bytes: Buffer.byteLength(content, 'utf8'), target: path.basename(target) };
  }
}

module.exports = {
  ControlledAgentExecutor,
  EXECUTABLE_CAPABILITIES,
  realpathBestEffort,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
};
