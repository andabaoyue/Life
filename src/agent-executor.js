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
const crypto = require('crypto');
const { WriteTransactionManager } = require('./agent-transaction');
const { listSandboxTopLevel, isValidStructureScope } = require('./agent-sandbox');

/** 🔴 SEC-03：执行器底层写入文件扩展名硬白名单（小写匹配）。 */
const ALLOWED_WRITE_EXTENSIONS = Object.freeze(new Set(['.txt', '.md', '.json', '.log']));

/** 🔴 v2.0-s1：执行器只读扩展名独立白名单（绝不复用 ALLOWED_WRITE_EXTENSIONS，避免日后放开读范围连带放宽写范围）。 */
const ALLOWED_READ_EXTENSIONS = Object.freeze(new Set(['.txt', '.md', '.json', '.log', '.csv', '.tsv']));

/** 🔴 v2.0-s1：允许走 'readOnly' 免确认旁路的能力硬白名单（严禁写入/移动/删除进入）。 */
const READ_ONLY_EXEMPT_CAPABILITIES = Object.freeze(new Set(['workspace.read', 'workspace.list']));

/** 🔴 v2.0-s2：可逆沙盒结构能力免确认白名单（仅限 mkdir 建子目录；严禁 workspace.remove 进入）。 */
const REVERSIBLE_EXEMPT_CAPABILITIES = Object.freeze(new Set(['workspace.mkdir']));

/** v2.0-s2：沙盒结构操作集合。 */
const STRUCTURE_CAPABILITIES = Object.freeze(new Set(['workspace.mkdir', 'workspace.move', 'workspace.remove']));

/** v2.0-s2：单次结构操作目标数硬上限（防「一条命令清空沙盒」）。 */
const MAX_STRUCTURE_TARGETS = 5;

/** D-4 允许真正执行的能力白名单。process.execute 不在其中，且下方另有硬拒。 */
const EXECUTABLE_CAPABILITIES = Object.freeze([
  'workspace.read',
  'workspace.list',
  'workspace.write',
  'workspace.mkdir',
  'workspace.move',
  'workspace.remove',
]);

/** 单次读出的最大字节数（防把一个 2GB 文件读进内存）。 */
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** 默认单次写最大字节，与 WriteTransactionManager 的5MB 对齐（这里取更严的一侧）。 */
const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024;

/** 🔴 SEC-03：Windows 保留设备名正则（不区分大小写，支持 CON/PRN/AUX/NUL/COM1-9/LPT1-9）。 */
const WINDOWS_RESERVED_NAMES = Object.freeze(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i);

/**
 * 判定路径是否包含 Windows 畸形文件名、ADS 备用数据流冒号或保留设备名。
 * @param {string} p 目标路径
 * @returns {boolean} true 表示畸形/非法路径
 */
function isMalformedWindowsPath(p) {
  if (typeof p !== 'string' || !p) return false;
  // 去除 Windows 盘符前缀（如 C: 或 c:）后，不应含有冒号（防 NTFS ADS 及非法冒号，涵盖目录段冒号）
  const withoutDrive = p.replace(/^[A-Za-z]:/, '');
  if (withoutDrive.includes(':')) return true;
  // 分解各路径段，检查保留名、末尾点号与末尾空格（排除 . 与 .. 相对目录跳转）
  const segments = withoutDrive.split(/[\\/]/).filter(Boolean);
  for (const seg of segments) {
    if (seg !== '.' && seg !== '..' && (seg.endsWith('.') || seg.endsWith(' '))) return true;
    const stem = seg.split('.')[0];
    if (WINDOWS_RESERVED_NAMES.test(stem)) return true;
  }
  return false;
}

function fail(code, extra = {}) {
  return { ok: false, code, ...extra };
}

/**
 * 判定 targetPath 是否严格位于 rootPath 根目录内部（大小写语义对齐平台规范）。
 */
function isPathInsideRoot(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  const t = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const r = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
  const rel = path.relative(r, t);
  if (!rel) return true; // 路径恰为根目录本身
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 规范化 Windows 扩展长路径前缀（\\?\ 或 \\?\UNC\）
 */
function normalizePathPrefix(p) {
  if (typeof p !== 'string') return p;
  if (process.platform === 'win32') {
    if (p.startsWith('\\\\?\\UNC\\')) {
      return '\\\\' + p.slice(8);
    }
    if (p.startsWith('\\\\?\\')) {
      return p.slice(4);
    }
  }
  return p;
}

/**
 * 取得最佳 realpath 同步函数。
 * 🔴 F1 修复：Windows 下纯 JS 的 realpathSync 无法稳定穿透目录联接（junction），
 *   必须优先使用 fs.realpathSync.native (libuv 原生 GetFinalPathNameByHandleW)。
 *   同时兼顾测试替身 fs 显式覆盖 realpathSync 的情况。
 */
function getRealPathSyncFn(f) {
  const targetFs = f || fs;
  if (f && Object.prototype.hasOwnProperty.call(f, 'realpathSync') && !Object.prototype.hasOwnProperty.call(f.realpathSync, 'native')) {
    return (p) => normalizePathPrefix(f.realpathSync(p));
  }
  if (targetFs && targetFs.realpathSync && typeof targetFs.realpathSync.native === 'function') {
    return (p) => normalizePathPrefix(targetFs.realpathSync.native(p));
  }
  if (targetFs && typeof targetFs.realpathSync === 'function') {
    return (p) => normalizePathPrefix(targetFs.realpathSync(p));
  }
  if (typeof fs.realpathSync.native === 'function') {
    return (p) => normalizePathPrefix(fs.realpathSync.native(p));
  }
  return (p) => normalizePathPrefix(fs.realpathSync(p));
}

/**
 * 完整穿透解析真实物理路径（fail-closed 失败关闭）。
 *
 * SEC-02 规约：
 *   1. 使用 lstatSync 检查目标条目本身（区别符号链接条目与普通文件）。
 *   2. 若目标条目本身存在（无论是文件、目录还是符号链接条目）：
 *      - 若为符号链接：必须成功穿透解析出真实物理目标 realpathSync.native(target)。
 *        若为悬空链接（目标不存在/ENOENT）、循环链接（ELOOP）或权限异常，一律失败关闭（返回 null），
 *        绝不退回或当作普通新建文件处理！
 *      - 若非符号链接：调用 realpathSync 确保中间各级祖先目录的软链接/junction 也被穿透解析。
 *   3. 只有当目标条目本身确实不存在（lstatSync 抛出 ENOENT）时，才按新建文件规则逐级向上寻找真实已存在的祖先目录并拼回相对路径：
 *      - 向上遍历最多 8 层；
 *      - 祖先目录调用 realpathSync：若祖先也是坏软链接，失败关闭（返回 null）；
 *      - 顶到根目录仍全部不存在，失败关闭（返回 null）。
 *   4. 任何无法证明路径安全的异常或无法解析情况，一律返回 null（失败关闭）。
 *
 * @param {string} p 目标路径
 * @param {object} [fsImpl] fs 实例（支持注入）
 * @returns {?string} 成功解析的绝对物理路径；解析失败或不安全链接返回 null
 */
function resolveRealPath(p, fsImpl) {
  const f = fsImpl || fs;
  let target;
  try {
    target = path.resolve(p);
  } catch {
    return null;
  }

  const realpathFn = getRealPathSyncFn(f);

  // 1. 探测目标条目本身
  let targetEntryExists = false;
  if (typeof f.lstatSync === 'function') {
    try {
      f.lstatSync(target);
      targetEntryExists = true;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        // 权限不足 (EACCES/EPERM) 或其它 I/O 异常：无法证明安全，失败关闭
        return null;
      }
    }
  }

  // 目标条目本身已存在（普通文件/目录或符号链接条目）
  if (targetEntryExists) {
    try {
      return realpathFn(target);
    } catch {
      // 目标条目已存在，但 realpath 失败（悬空链接、循环链接、权限异常等）：
      // 绝不进入新建文件回溯逻辑，一律失败关闭！
      return null;
    }
  }

  // 2. 目标条目确实不存在（新建文件），逐级向上寻找真实存在的祖先目录
  let dir = path.dirname(target);
  let base = path.basename(target);
  for (let i = 0; i <= 8; i++) {
    try {
      const realDir = realpathFn(dir);
      return path.join(realDir, base);
    } catch (err) {
      // 若祖先本身是个坏符号链接，失败关闭
      if (typeof f.lstatSync === 'function') {
        try {
          const st = f.lstatSync(dir);
          if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
            return null;
          }
        } catch { /* 忽略，继续向上探查 */ }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // 顶到文件系统根仍不存在
      base = path.basename(dir) + (base ? path.sep + base : '');
      dir = parent;
    }
  }

  return null;
}

/* 🔵 2026-11-05 C-4：删除死导出 `realpathBestEffort`（审计 P3 #12）。
 *
 *   它只是 `resolveRealPath` 的一层包装：
 *     function realpathBestEffort(p, fsImpl) { return resolveRealPath(p, fsImpl); }
 *   生产代码 0 引用、测试 0 引用（全仓只有定义与 module.exports 两处）。
 *
 *   ⚠️ 本文件是红线文件，但这一项是**纯删除死代码**，不影响任何行为
 *      （改前改后跑全套件对比过，见提交说明）。
 *      保留一个没人用的包装层，只会让后来者以为它和 resolveRealPath 有区别。
 */

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
    this.resolveRealPath = deps.resolveRealPath || resolveRealPath;
    this.maxWallClockMs = Number.isFinite(deps.maxWallClockMs)
      ? deps.maxWallClockMs
      : ((this.budget && this.budget.limits && Number.isFinite(this.budget.limits.maxWallClockMs))
          ? this.budget.limits.maxWallClockMs
          : 10 * 60 * 1000);
    this.now = typeof deps.now === 'function' ? deps.now : null;
    //已消费提案的终态集合。执行成功后写入，重放时查。
    //用 Set 而非改proposal.status：提案对象是 Object.freeze 的，改不动。
    this.consumed = new Set();
  }

  /** 恢复上次进程的已消费提案（进程重启后重放防线不能归零）。 */
  loadConsumed(ids = []) {
    for (const id of ids) this.consumed.add(String(id));
    return this.consumed.size;
  }

  /**
   * v1.0 D-9：执行侧审计的统一出口。
   *
   * 🔴 **为什么动机必须在这里统一注入，而不是每个调用点各写一份**：
   *   本文件有 9 处 `_audit(...)` 调用点。若让每处自己从提案里取动机，
   *   漏一处就产生「有些记录有动机、有些没有」的分裂 ——
   *   而审计分裂比没有审计更坏：翻记录的人会以为「没动机那几条是另一类情况」。
   *   统一在出口注入 ⇒ **每条executed/rejected/failed 记录都必然带这三个字段**，
   *   拿不到时值恒为 null。**形状恒定是这里的核心不变式，不是顺手做的。**
   *
   * @param {object} entry 本次事件的字段
   * @param {?object} [proposal] 提案真身；拿不到（如 PROPOSAL_NOT_FOUND）时动机记 null
   */
  _audit(entry, proposal) {
    if (!this.auditLog || typeof this.auditLog.append !== 'function') return;
    // 🔴 动机只从**提案对象**读，而提案对象来自 proposalStore（主进程侧建案时冻结）。
    //   绝不从 execute 的 input 读 —— 那是渲染端传的，那是攻击面。
    //   提案不存在时如实记 null，不写 'unknown'，也不编一个来源。
    const motive = {
      intentSources: proposal && Array.isArray(proposal.intentSources) ? proposal.intentSources : null,
      intentKind: proposal && typeof proposal.intentKind === 'string' ? proposal.intentKind : null,
      intentOrigin: proposal && typeof proposal.intentOrigin === 'string' ? proposal.intentOrigin : null,
    };
    try {
      this.auditLog.append({ channel: 'agent:execute', ...motive, ...entry });
    } catch { /* 审计写不进去也不能挡住拒绝 */ }
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
      // 动机仍可查：提案对象还在注册表里（重放拦的是「再执行一次」，不是「查不到它」）。
      this._audit({ outcome: 'rejected', code: 'ALREADY_EXECUTED', proposalId: proposalId.slice(0, 120) }, proposal);
      return fail('ALREADY_EXECUTED');
    }

    // ── 提案端到端生命周期时限校验（P0-2：maxWallClockMs 语义为从建案到执行的生命周期上限，默认 10 分钟）
    if (!Number.isFinite(proposal.createdAt)) {
      if (this.confirmation && typeof this.confirmation.revoke === 'function') {
        this.confirmation.revoke(proposalId, 'PROPOSAL_INVALID_TIMESTAMP');
      }
      this._audit({
        outcome: 'rejected',
        code: 'PROPOSAL_INVALID_TIMESTAMP',
        capability: proposal.capability,
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      return fail('PROPOSAL_INVALID_TIMESTAMP', { reason: 'PROPOSAL_CREATED_AT_REQUIRED' });
    }
    const maxWallClock = (this.budget && this.budget.limits && Number.isFinite(this.budget.limits.maxWallClockMs))
      ? this.budget.limits.maxWallClockMs
      : (Number.isFinite(this.maxWallClockMs) ? this.maxWallClockMs : 10 * 60 * 1000);
    const now = (typeof this.now === 'function' ? this.now() : Date.now());
    if (maxWallClock > 0 && (now - proposal.createdAt > maxWallClock)) {
      if (this.confirmation && typeof this.confirmation.revoke === 'function') {
        this.confirmation.revoke(proposalId, 'PROPOSAL_EXPIRED');
      }
      this._audit({
        outcome: 'rejected',
        code: 'PROPOSAL_EXPIRED',
        capability: proposal.capability,
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      return fail('PROPOSAL_EXPIRED', { reason: 'PROPOSAL_WALL_CLOCK_EXCEEDED' });
    }

    // ── 不变式 3：process.execute 永久硬拒（在任何其它判定之前）
    if (proposal.capability === 'process.execute') {
      this._audit({
        outcome: 'rejected',
        code: 'PROCESS_EXECUTE_FORBIDDEN',
        capability: 'process.execute',
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      return fail('PROCESS_EXECUTE_FORBIDDEN');
    }
    if (!EXECUTABLE_CAPABILITIES.includes(proposal.capability)) {
      return fail('CAPABILITY_NOT_EXECUTABLE', { capability: String(proposal.capability || '').slice(0, 64) });
    }

    // ── 闸门 2：能力授权**在执行期重跑**（不复用提案期的 verdict，见不变式 1）
    const isStructure = STRUCTURE_CAPABILITIES.has(proposal.capability);
    let structureEntries = null;
    if (isStructure) {
      const extracted = this._extractStructureItems(proposal);
      if (!extracted.ok) {
        this._audit({
          outcome: 'rejected',
          code: extracted.code,
          capability: proposal.capability,
          detail: extracted.detail || null,
          proposalId: proposalId.slice(0, 120),
        }, proposal);
        return fail(extracted.code, extracted.extra || {});
      }
      structureEntries = extracted.items;
    }

    const verdict = this.policy.authorize(proposal.capability, proposal.scope);
    if (!verdict || verdict.allowed !== true) {
      this._audit({
        outcome: 'rejected',
        code: 'AUTHORIZED_REJECTED',
        capability: proposal.capability,
        reason: verdict && verdict.reason,
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      return fail('AUTHORIZED_REJECTED', { reason: verdict && verdict.reason });
    }

    const roots = (this.policy && typeof this.policy.getScopeRoots === 'function')
      ? this.policy.getScopeRoots(proposal.capability)
      : (verdict.matchedRoot ? [verdict.matchedRoot] : []);

    // ── 不变式 3：realpath 物理沙盒边界强制校验（SEC-02：无论 policy.followSymlink 为何，物理路径必须锁在沙盒内）
    const resolvedRealRoots = [];
    if (Array.isArray(roots) && roots.length > 0) {
      for (const root of roots) {
        let realRoot = null;
        try {
          realRoot = (this.resolveRealPath || resolveRealPath)(root, this.fs);
        } catch {
          realRoot = null;
        }
        if (realRoot) resolvedRealRoots.push(realRoot);
      }
    }

    const isInsideAnyRealRoot = (realPath) => {
      if (!realPath || resolvedRealRoots.length === 0) return null;
      for (const rr of resolvedRealRoots) {
        if (isPathInsideRoot(realPath, rr)) return rr;
      }
      return null;
    };

    let real = null;
    let resolvedStructure = null;
    let symlinkEscape = false;

    if (isStructure) {
      resolvedStructure = [];
      for (const entry of structureEntries) {
        const vSrc = this.policy.authorize(proposal.capability, entry.src);
        if (!vSrc || vSrc.allowed !== true) {
          this._audit({
            outcome: 'rejected',
            code: 'AUTHORIZED_REJECTED',
            capability: proposal.capability,
            reason: vSrc && vSrc.reason,
            proposalId: proposalId.slice(0, 120),
          }, proposal);
          return fail('AUTHORIZED_REJECTED', { reason: vSrc && vSrc.reason });
        }
        if (proposal.capability === 'workspace.move') {
          if (typeof entry.dst !== 'string' || !entry.dst.trim()) {
            this._audit({
              outcome: 'rejected',
              code: 'INVALID_PROPOSAL',
              capability: proposal.capability,
              reason: 'DST_REQUIRED',
              proposalId: proposalId.slice(0, 120),
            }, proposal);
            return fail('INVALID_PROPOSAL', { reason: 'DST_REQUIRED' });
          }
          const vDst = this.policy.authorize(proposal.capability, entry.dst);
          if (!vDst || vDst.allowed !== true) {
            this._audit({
              outcome: 'rejected',
              code: 'AUTHORIZED_REJECTED',
              capability: proposal.capability,
              reason: vDst && vDst.reason,
              proposalId: proposalId.slice(0, 120),
            }, proposal);
            return fail('AUTHORIZED_REJECTED', { reason: vDst && vDst.reason });
          }
        }
        if (isMalformedWindowsPath(entry.src) || !isValidStructureScope(entry.src, roots)
            || (proposal.capability === 'workspace.move' && (isMalformedWindowsPath(entry.dst) || !isValidStructureScope(entry.dst, roots)))) {
          this._audit({
            outcome: 'rejected',
            code: 'DISALLOWED_FILENAME',
            capability: proposal.capability,
            proposalId: proposalId.slice(0, 120),
          }, proposal);
          return fail('DISALLOWED_FILENAME');
        }

        // 🔴 P1-4：在 resolveRealPath 解引用之前先对原始路径执行 _lstatBest，
        // 阻止「沙盒内 symlink -> 沙盒内文件」绕过下游 isSymbolicLink 检查而误删/误移目标。
        try {
          const srcLstat = this._lstatBest(entry.src);
          if (srcLstat && typeof srcLstat.isSymbolicLink === 'function' && srcLstat.isSymbolicLink()) {
            symlinkEscape = true;
            break;
          }
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            symlinkEscape = true;
            break;
          }
        }
        const realSrc = (this.resolveRealPath || resolveRealPath)(entry.src, this.fs);
        const matchedSrcRoot = isInsideAnyRealRoot(realSrc);
        if (!realSrc || !matchedSrcRoot || !path.relative(matchedSrcRoot, realSrc)) {
          symlinkEscape = true;
          break;
        }
        let realDst = null;
        let matchedDstRoot = null;
        if (proposal.capability === 'workspace.move') {
          try {
            const dstLstat = this._lstatBest(entry.dst);
            if (dstLstat && typeof dstLstat.isSymbolicLink === 'function' && dstLstat.isSymbolicLink()) {
              symlinkEscape = true;
              break;
            }
          } catch (err) {
            if (err && err.code !== 'ENOENT') {
              symlinkEscape = true;
              break;
            }
          }
          realDst = (this.resolveRealPath || resolveRealPath)(entry.dst, this.fs);
          matchedDstRoot = isInsideAnyRealRoot(realDst);
          if (!realDst || !matchedDstRoot || !path.relative(matchedDstRoot, realDst)) {
            symlinkEscape = true;
            break;
          }
          if (isPathInsideRoot(realDst, realSrc)) {
            this._audit({
              outcome: 'rejected',
              code: 'INVALID_PROPOSAL',
              capability: proposal.capability,
              reason: 'SELF_CONTAINED_MOVE',
              proposalId: proposalId.slice(0, 120),
            }, proposal);
            return fail('INVALID_PROPOSAL', { reason: 'SELF_CONTAINED_MOVE' });
          }
        }
        resolvedStructure.push({
          src: realSrc,
          dst: realDst,
          srcRel: path.relative(matchedSrcRoot, realSrc).replace(/\\/g, '/'),
          dstRel: realDst && matchedDstRoot ? path.relative(matchedDstRoot, realDst).replace(/\\/g, '/') : null,
        });
      }
      real = resolvedStructure.length > 0 ? resolvedStructure[0].src : null;
    } else {
      real = (this.resolveRealPath || resolveRealPath)(proposal.scope, this.fs);
      if (!real || !isInsideAnyRealRoot(real)) {
        symlinkEscape = true;
      }
    }

    if (symlinkEscape) {
      if (this.confirmation && typeof this.confirmation.revoke === 'function') {
        this.confirmation.revoke(proposalId, 'SYMLINK_ESCAPE');
      }
      this._audit({
        outcome: 'rejected',
        code: 'SYMLINK_ESCAPE',
        capability: proposal.capability,
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      return fail('SYMLINK_ESCAPE');
    }

    // ── 闸门 3：预算预检（P1-1：只读预检不扣减，待闸门 4 与写前静态校验全过后再实际扣减）
    const isWrite = proposal.capability === 'workspace.write';
    const isList = proposal.capability === 'workspace.list';
    const isReadOnlyOp = proposal.capability === 'workspace.read' || isList;
    const budgetPrecheckOk = typeof this.budget.canConsume === 'function'
      ? this.budget.canConsume(isWrite, { free: isReadOnlyOp })
      : this.budget.consume(isWrite, Date.now(), { free: isReadOnlyOp });
    if (!budgetPrecheckOk) {
      this._audit({
        outcome: 'rejected',
        code: 'BUDGET_TRIPPED',
        capability: proposal.capability,
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      return fail('BUDGET_TRIPPED', { budget: this.budget.state() });
    }

    // ── 闸门 4：用户显式确认（D-3 第四道闸门，这里是**执行前**的最后一次复核）
    //
    // 🔴🔴 D-17（用户拍板 C1）：`proposalSource === 'selfNote'` 免逐次确认。
    //
    //   ## 为什么是这里、而不是在通道层放行
    //   D-4 不变式 1：**闸门判定一律在执行器内**。在通道层开旁路会让
    //   「判定」分裂成两处，迟早漂移，而漂移的那一侧就是漏洞。
    //
    //   ## 为什么自发愿望可以免确认（用户原话与理由）
    //   留便签的本质是「趁你不在时悄悄写下」。若要弹卡片等你授权，
    //   你回来才看到 —— 那就毁掉了自发留字本身。
    //
    //   ## 🔴 免确认 ≠ 无约束：以下四道**一个都没松**
    //     ① 闸门 1：能力白名单（只能 workspace.write，process.execute 仍硬拒）
    //     ② 闸门 2：scope 必须落在桌面 LifeSandbox 内（执行期重跑，不信提案期 verdict）
    //     ③ 闸门 3：预算（maxWritesPerSession 仍是 5）+ 格式白名单 + 长度上限
    //     ④ 第五道闸门：写事务（WAL + 原子写 + 崩溃自愈）
    //   ⇒ 她只能**在沙盒里**、**写白名单格式**、**有配额**地留字。
    //
    //   ## ⚠️ 来源是不可伪造的
    //   `proposalSource` 由 `createActionProposal` 的**独立第三参数**写入，
    //   渲染端在 payload 里塞同名字段一律被忽略（有门禁钉死）。
    //   通道来的提案永远是 'user' —— 只有主进程建案时才能给 'selfNote' 或 'observerJournal'。
    const isRemove = proposal && proposal.capability === 'workspace.remove';
    const isMove = proposal && proposal.capability === 'workspace.move';
    const isSelfNote = Boolean(
      proposal
      && proposal.proposalSource === 'selfNote'
      && !isRemove
      && !isMove
      && !isStructure
    );
    const isObserverJournal = Boolean(
      proposal
      && proposal.proposalSource === 'observerJournal'
      && !isRemove
      && !isMove
      && !isStructure
    );
    // 🔴 v2.0-s1 & s2：
    //   - 只读感官免确认严格绑定 !isWrite && !isRemove && !isMove 且能力限于 READ_ONLY_EXEMPT_CAPABILITIES
    //   - mkdir 可逆结构操作走同款 'readOnly' 免确认旁路（REVERSIBLE_EXEMPT_CAPABILITIES）
    //   - workspace.remove 不可逆：严禁进入任何免确认集合，即便 proposalSource === 'readOnly' 也必须走 confirmation.isExecutionAllowed
    const isReadOnlyExempt = Boolean(
      proposal
      && proposal.proposalSource === 'readOnly'
      && !isWrite
      && !isRemove
      && !isMove
      && (READ_ONLY_EXEMPT_CAPABILITIES.has(proposal.capability)
        || REVERSIBLE_EXEMPT_CAPABILITIES.has(proposal.capability))
    );
    const gate = isSelfNote
      ? { allowed: true, reason: 'SELF_NOTE_EXEMPT' }
      : (isObserverJournal
        ? { allowed: true, reason: 'OBSERVER_JOURNAL_EXEMPT' }
        : (isReadOnlyExempt
          ? { allowed: true, reason: 'READ_ONLY_EXEMPT' }
          : this.confirmation.isExecutionAllowed(proposalId)));
    if (!gate || gate.allowed !== true) {
      const reason = (gate && gate.reason) || 'NOT_CONFIRMED';
      this._audit({
        outcome: 'rejected',
        code: 'EXECUTION_NOT_ALLOWED',
        reason,
        capability: proposal.capability,
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      return fail('EXECUTION_NOT_ALLOWED', { reason });
    }

    // ── 第五道闸门：事务。先完成写前静态校验，再扣减预算，真正的写盘/结构变更从这里开始。
    let result;
    try {
      let writeSpec = null;
      if (isWrite) {
        writeSpec = this._validateWriteFile(proposal, input.content, real);
      }
      if (typeof this.budget.canConsume === 'function') {
        if (!this.budget.consume(isWrite, Date.now(), { free: isReadOnlyOp })) {
          this._audit({
            outcome: 'rejected',
            code: 'BUDGET_TRIPPED',
            capability: proposal.capability,
            proposalId: proposalId.slice(0, 120),
          }, proposal);
          return fail('BUDGET_TRIPPED', { budget: this.budget.state() });
        }
      }
      if (isWrite) {
        result = this._writeFile(proposal, input.content, real, writeSpec);
      } else if (isList) {
        result = this._listDir(proposal, real);
      } else if (proposal.capability === 'workspace.mkdir') {
        result = this._mkdirEntries(resolvedStructure);
      } else if (isMove) {
        result = this._moveEntries(resolvedStructure);
      } else if (isRemove) {
        result = this._removeEntries(resolvedStructure);
      } else {
        result = this._readFile(proposal, real);
      }
    } catch (err) {
      // 执行失败要记连续错误（防「一直失败一直重试」），并把授权作废：
      // 失败的提案不该能被原样再执行一次。
      if (this.budget && typeof this.budget.recordError === 'function') this.budget.recordError();
      const isSecurityViolation = err && (
        err.code === 'CONTENT_HASH_MISMATCH'
        || err.code === 'CONTENT_BYTES_MISMATCH'
        || err.code === 'CONTENT_HASH_REQUIRED'
        || err.code === 'DISALLOWED_EXTENSION'
        || err.code === 'HARDLINK_DETECTED'
        || err.code === 'SYMLINK_ESCAPE'
        || err.code === 'TOO_MANY_TARGETS'
        || err.code === 'DISALLOWED_FILENAME'
      );
      const isStructureValidationErr = err && (
        err.code === 'DST_ALREADY_EXISTS'
        || err.code === 'ALREADY_EXISTS_NOT_DIR'
        || err.code === 'NOT_FOUND'
        || err.code === 'INVALID_MOVE_SELF'
      );
      const isRollbackFailure = err && (err.code === 'ROLLBACK_HASH_MISMATCH' || err.code === 'BACKUP_MISSING' || /ROLLBACK/i.test(err.code || ''));
      const code = isSecurityViolation
        ? err.code
        : (isStructureValidationErr ? err.code : (isRollbackFailure ? 'ROLLBACK_FAILED' : 'EXECUTION_FAILED'));
      this._audit({
        outcome: 'failed',
        code,
        capability: proposal.capability,
        detail: String((err && err.message) || '').slice(0, 200),
        proposalId: proposalId.slice(0, 120),
      }, proposal);
      if ((isSecurityViolation || isRollbackFailure) && this.confirmation && typeof this.confirmation.revoke === 'function') {
        this.confirmation.revoke(proposalId, code);
      }
      return fail(code, {
        detail: String((err && err.message) || '').slice(0, 200),
        rollbackFailed: Boolean(isRollbackFailure),
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
    }, proposal);

    // 🔴 D-24：把提案来源随执行回执带出（proposalSource 由建案侧写入、渲染端不可伪造），
    //   供 onExecuted 判定「这是不是她自发写下的字」—— 只有自发便签有资格铸进她的自传。
    return { ok: true, executed: true, proposalId, result, budget: this.budget.state(), proposalSource: (proposal && proposal.proposalSource) || 'user' };
  }

  /**
   * 校验无扩展名文件是否为合法 UTF-8 纯文本（拒绝 NUL、非空白 C0 控制字节与非法 UTF-8 序列）。
   * 返回解码后的 UTF-8 字符串，或抛出 DISALLOWED_EXTENSION。
   */
  _probeAndDecodeExtensionlessText(raw) {
    if (Buffer.isBuffer(raw)) {
      const probeLen = Math.min(raw.length, 8192);
      for (let i = 0; i < probeLen; i++) {
        const b = raw[i];
        if (b === 0x00 || (b >= 0x01 && b <= 0x08) || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f)) {
          throw Object.assign(new Error('DISALLOWED_EXTENSION: binary content'), { code: 'DISALLOWED_EXTENSION' });
        }
      }
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        throw Object.assign(new Error('DISALLOWED_EXTENSION: invalid utf8'), { code: 'DISALLOWED_EXTENSION' });
      }
    }
    const text = String(raw || '');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text.slice(0, 8192))) {
      throw Object.assign(new Error('DISALLOWED_EXTENSION: binary content'), { code: 'DISALLOWED_EXTENSION' });
    }
    return text;
  }

  _listDir(proposal, resolvedPath) {
    const target = resolvedPath || path.resolve(proposal.scope);
    const stat = this.fs.statSync(target);
    if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) {
      throw new Error('NOT_A_DIRECTORY');
    }
    const items = listSandboxTopLevel(target, this.fs);
    return { count: items.length, items };
  }

  _readFile(proposal, resolvedPath) {
    const target = resolvedPath || path.resolve(proposal.scope);
    // 🔴 SEC-03 深度防御：拦截读路径中的 NTFS ADS 备用数据流冒号 (:) 与 Windows 畸形文件名/保留名
    if (isMalformedWindowsPath(proposal && proposal.scope) || isMalformedWindowsPath(target)) {
      throw Object.assign(new Error('MALFORMED_WINDOWS_FILENAME'), { code: 'DISALLOWED_EXTENSION' });
    }
    // 🔴 v2.0-s1：读扩展名独立白名单；无扩展名文件（如 README / LICENSE）走内容探测，非文本字节一律拒绝。
    const rawExt = path.extname(proposal && proposal.scope ? proposal.scope : '').toLowerCase();
    const targetExt = path.extname(target || '').toLowerCase();
    if (rawExt && !ALLOWED_READ_EXTENSIONS.has(rawExt)) {
      throw Object.assign(new Error(`DISALLOWED_EXTENSION: ${rawExt}`), { code: 'DISALLOWED_EXTENSION' });
    }
    if (targetExt && !ALLOWED_READ_EXTENSIONS.has(targetExt)) {
      throw Object.assign(new Error(`DISALLOWED_EXTENSION: ${targetExt}`), { code: 'DISALLOWED_EXTENSION' });
    }
    const stat = this.fs.statSync(target);
    if (!stat.isFile()) throw new Error('NOT_A_FILE');
    // 🔴 SEC-02 延伸防御（N3）：拦截多重硬链接文件读取（防硬链接穿透与跨边界泄漏）
    if (typeof stat.nlink === 'number' && stat.nlink > 1) {
      throw Object.assign(new Error('HARDLINK_DETECTED'), { code: 'HARDLINK_DETECTED' });
    }
    if (stat.size > this.maxReadBytes) {
      throw Object.assign(new Error('READ_TOO_LARGE'), { code: 'READ_TOO_LARGE' });
    }
    if (!targetExt) {
      const raw = this.fs.readFileSync(target);
      return { bytes: stat.size, content: this._probeAndDecodeExtensionlessText(raw) };
    }
    //只返回内容与元数据，**不回传绝对路径**——渲染端不需要知道沙盒绝对位置，
    // 少一个信息泄露面。真要给也应该只给 basename。
    return { bytes: stat.size, content: this.fs.readFileSync(target, 'utf8') };
  }

  _validateWriteFile(proposal, content, resolvedPath) {
    // 🔴 SEC-01：对正式写入路径强制要求有效的内容哈希和 UTF-8 字节数绑定；缺少绑定时失败关闭。
    if (!proposal || !proposal.contentHash || typeof proposal.contentHash !== 'string' || !Number.isFinite(proposal.contentBytes)) {
      throw Object.assign(new Error('CONTENT_HASH_REQUIRED'), { code: 'CONTENT_HASH_REQUIRED' });
    }

    // 🔴 SEC-03：执行器底层扩展名白名单强校验（.txt, .md, .json, .log）。
    //   大小写不敏感（.TXT / .Md 均放行）；无扩展名或非法扩展名（.exe, .bat, .sh 等）硬拒绝。
    const rawExt = path.extname(proposal.scope || '');
    const ext = rawExt.toLowerCase();
    const target = resolvedPath || path.resolve(proposal.scope);
    const targetExt = path.extname(target || '').toLowerCase();
    if (!ALLOWED_WRITE_EXTENSIONS.has(ext) || !ALLOWED_WRITE_EXTENSIONS.has(targetExt)) {
      throw Object.assign(new Error(`DISALLOWED_EXTENSION: ${ext || 'none'}`), { code: 'DISALLOWED_EXTENSION' });
    }

    // 🔴 SEC-03 深度防御：NTFS ADS 备用数据流冒号 (:)、Windows 保留设备名与末尾点号/空格畸形文件名拦截
    if (isMalformedWindowsPath(proposal && proposal.scope) || isMalformedWindowsPath(target)) {
      throw Object.assign(new Error('MALFORMED_WINDOWS_FILENAME'), { code: 'DISALLOWED_EXTENSION' });
    }

    // 🔴 SEC-02 延伸防御（N3 & Q1）：若目标已存在且为多重硬链接，拒绝覆写（防硬链接目标污染）；
    //   无法证明目标文件状态时一律失败关闭（除新建文件的 ENOENT 外均拒绝）。
    let existingStat = null;
    try {
      existingStat = this.fs.statSync(target);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        throw Object.assign(new Error('HARDLINK_UNVERIFIABLE'), { code: 'HARDLINK_DETECTED' });
      }
    }
    if (existingStat && typeof existingStat.nlink === 'number' && existingStat.nlink > 1) {
      throw Object.assign(new Error('HARDLINK_DETECTED'), { code: 'HARDLINK_DETECTED' });
    }

    // 🔴 content 只接受字符串。**不解析 JSON、不接受对象** ——
    //   若接受对象再序列化成 JSON，等于给了「用类型混淆绕过字符串校验」的面。
    if (typeof content !== 'string') {
      throw Object.assign(new Error('CONTENT_REQUIRED'), { code: 'CONTENT_REQUIRED' });
    }
    // 🔴 D-6 审核实测抓到的真漏洞：类型对了不代表语义对。
    //   空字符串是合法string，能通过上面那道校验，于是走完全链路——
    //   实测（2026-10-06）：execute({content:''}) → ok:true、落盘 0 字节文件、
    //   **且提案已被消费**，二次执行 ALREADY_EXECUTED，用户无从补救。
    //   危害不在「多一个空文件」，在于：用户点【授权】时看到的是
    //   「写入 note.md」，他并不知道自己要授权的其实是**一个空文件** ——
    //   这等于授权了一件他没看到的事。
    //   所以这里必须区分「类型合法」与「语义可授权」。
    if (content.length === 0) {
      throw Object.assign(new Error('CONTENT_EMPTY'), { code: 'CONTENT_EMPTY' });
    }
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > this.maxWriteBytes) {
      throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    // 🔴 SEC-01：权威哈希强绑定断言
    //   执行器必须对传入文本重新计算 SHA-256 并验证与提案完全一致。
    const actualHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    if (actualHash !== proposal.contentHash) {
      throw Object.assign(new Error('CONTENT_HASH_MISMATCH'), { code: 'CONTENT_HASH_MISMATCH' });
    }
    if (byteLength !== proposal.contentBytes) {
      throw Object.assign(new Error('CONTENT_BYTES_MISMATCH'), { code: 'CONTENT_BYTES_MISMATCH' });
    }
    return { target, byteLength };
  }

  _writeFile(proposal, content, resolvedPath, preValidated) {
    const spec = preValidated || this._validateWriteFile(proposal, content, resolvedPath);
    // 第五道闸门真正生效处：begin →写盘 → commit，任一步失败即 rollback。
    const tx = this.txn.begin({ target: spec.target, data: content });
    this.txn.commit(tx);
    return { bytes: spec.byteLength, target: path.basename(proposal.scope || spec.target) };
  }

  _extractStructureItems(proposal) {
    const cap = proposal && proposal.capability;
    if (Array.isArray(proposal && proposal.targets)) {
      if (proposal.targets.length === 0) {
        return { ok: false, code: 'INVALID_PROPOSAL', detail: 'EMPTY_TARGETS' };
      }
      if (proposal.targets.length > MAX_STRUCTURE_TARGETS) {
        return {
          ok: false,
          code: 'TOO_MANY_TARGETS',
          detail: `targets=${proposal.targets.length} > limit=${MAX_STRUCTURE_TARGETS}`,
          extra: { limit: MAX_STRUCTURE_TARGETS, count: proposal.targets.length },
        };
      }
      const items = [];
      for (const rawItem of proposal.targets) {
        if (cap === 'workspace.move') {
          const src = rawItem && typeof rawItem === 'object' ? String(rawItem.src || rawItem.scope || '') : '';
          const dst = rawItem && typeof rawItem === 'object' ? (rawItem.dst != null ? String(rawItem.dst) : (rawItem.destination != null ? String(rawItem.destination) : '')) : '';
          items.push({ src, dst });
        } else {
          const src = rawItem && typeof rawItem === 'object' ? String(rawItem.src || rawItem.scope || '') : String(rawItem || '');
          items.push({ src, dst: null });
        }
      }
      return { ok: true, items };
    }
    const singleSrc = String((proposal && proposal.scope) || '');
    const singleDst = proposal && proposal.dst != null
      ? String(proposal.dst)
      : (proposal && proposal.destination != null ? String(proposal.destination) : null);
    return { ok: true, items: [{ src: singleSrc, dst: singleDst }] };
  }

  _lstatBest(p) {
    if (typeof this.fs.lstatSync === 'function') return this.fs.lstatSync(p);
    return this.fs.statSync(p);
  }

  _mkdirEntries(resolvedItems) {
    const created = [];
    for (const item of resolvedItems || []) {
      let existing = null;
      try {
        existing = this._lstatBest(item.src);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      if (existing) {
        if (typeof existing.isSymbolicLink === 'function' && existing.isSymbolicLink()) {
          throw Object.assign(new Error('SYMLINK_ESCAPE'), { code: 'SYMLINK_ESCAPE' });
        }
        if (typeof existing.isDirectory !== 'function' || !existing.isDirectory()) {
          throw Object.assign(new Error('ALREADY_EXISTS_NOT_DIR'), { code: 'ALREADY_EXISTS_NOT_DIR' });
        }
      } else {
        this.fs.mkdirSync(item.src, { recursive: true });
      }
      created.push(item.srcRel);
    }
    return { createdCount: created.length, targets: created };
  }

  _moveEntries(resolvedItems) {
    const moved = [];
    for (const item of resolvedItems || []) {
      let srcStat;
      try {
        srcStat = this._lstatBest(item.src);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        }
        throw err;
      }
      if (!srcStat || (typeof srcStat.isSymbolicLink === 'function' && srcStat.isSymbolicLink())) {
        throw Object.assign(new Error('SYMLINK_ESCAPE'), { code: 'SYMLINK_ESCAPE' });
      }
      if (typeof srcStat.isFile === 'function' && srcStat.isFile()
          && typeof srcStat.nlink === 'number' && srcStat.nlink > 1) {
        throw Object.assign(new Error('HARDLINK_DETECTED'), { code: 'HARDLINK_DETECTED' });
      }
      let dstExists = false;
      try {
        this._lstatBest(item.dst);
        dstExists = true;
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      if (dstExists) {
        throw Object.assign(new Error('DST_ALREADY_EXISTS'), { code: 'DST_ALREADY_EXISTS' });
      }
      const normSrc = process.platform === 'win32' ? item.src.toLowerCase() : item.src;
      const normDst = process.platform === 'win32' ? item.dst.toLowerCase() : item.dst;
      const srcPrefix = normSrc.endsWith(path.sep) ? normSrc : normSrc + path.sep;
      if (normDst === normSrc || normDst.startsWith(srcPrefix)) {
        throw Object.assign(new Error('INVALID_MOVE_SELF'), { code: 'INVALID_MOVE_SELF' });
      }
      const parentDir = path.dirname(item.dst);
      this.fs.mkdirSync(parentDir, { recursive: true });
      this.fs.renameSync(item.src, item.dst);
      moved.push({ src: item.srcRel, dst: item.dstRel });
    }
    return { movedCount: moved.length, items: moved };
  }

  _collectRemovePlan(targetPath, plan) {
    let st;
    try {
      st = this._lstatBest(targetPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
      }
      throw err;
    }
    if (!st || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink())) {
      throw Object.assign(new Error('SYMLINK_ESCAPE'), { code: 'SYMLINK_ESCAPE' });
    }
    if (typeof st.isDirectory === 'function' && st.isDirectory()) {
      const ents = this.fs.readdirSync(targetPath, { withFileTypes: true });
      for (const ent of ents) {
        const name = typeof ent === 'string' ? ent : (ent && ent.name);
        if (!name) continue;
        if (ent && typeof ent.isSymbolicLink === 'function' && ent.isSymbolicLink()) {
          throw Object.assign(new Error('SYMLINK_ESCAPE'), { code: 'SYMLINK_ESCAPE' });
        }
        this._collectRemovePlan(path.join(targetPath, name), plan);
      }
      plan.push({ path: targetPath, isDir: true });
    } else {
      if (typeof st.nlink === 'number' && st.nlink > 1) {
        throw Object.assign(new Error('HARDLINK_DETECTED'), { code: 'HARDLINK_DETECTED' });
      }
      plan.push({ path: targetPath, isDir: false });
    }
    if (plan.length > MAX_STRUCTURE_TARGETS) {
      throw Object.assign(new Error(`TOO_MANY_TARGETS: ${plan.length} > ${MAX_STRUCTURE_TARGETS}`), { code: 'TOO_MANY_TARGETS' });
    }
  }

  _removeEntries(resolvedItems) {
    const plan = [];
    const removedNames = [];
    for (const item of resolvedItems || []) {
      this._collectRemovePlan(item.src, plan);
      removedNames.push(item.srcRel);
    }
    for (const node of plan) {
      if (node.isDir) {
        if (typeof this.fs.rmdirSync === 'function') this.fs.rmdirSync(node.path);
        else this.fs.rmSync(node.path, { recursive: false, force: false });
      } else {
        this.fs.unlinkSync(node.path);
      }
    }
    return { removedCount: plan.length, targets: removedNames };
  }
}

module.exports = {
  ControlledAgentExecutor,
  EXECUTABLE_CAPABILITIES,
  ALLOWED_WRITE_EXTENSIONS,
  ALLOWED_READ_EXTENSIONS,
  READ_ONLY_EXEMPT_CAPABILITIES,
  REVERSIBLE_EXEMPT_CAPABILITIES,
  STRUCTURE_CAPABILITIES,
  MAX_STRUCTURE_TARGETS,
  isMalformedWindowsPath,
  resolveRealPath,
  // 🔵 2026-11-05 C-4：realpathBestEffort 已删除（死导出，见上方注释）。
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
};
