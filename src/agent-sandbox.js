/**
 * src/agent-sandbox.js
 *
 * v1.0 D-5：沙盒目录定位与启用。
 *
 * ## 这个模块解决什么
 *
 * D-4 把受控执行器接上了，但main.js 维持**三重默认关闭**（killSwitch=true、
 * allowed=[]、未配 scope 根），所以执行器虽在，实际动不了任何用户文件。
 * D-5 起按用户拍板放开一条路：**桌面 LifeSandbox/ 子目录**。
 *
 * ## 🔴 用户拍板时的附带条件（必须写在代码里，不能只写在文档里）
 *
 * 拍板原文：「请在注释和 README 里写明**沙盒内文件一律视为可被 Agent 覆写**。
 * 用户可能自己往里丢东西，没有这条约定就等于默认授权了。」
 *
 * 所以本模块的 SANDBOX_NOTICE 是给用户看的正式约定，不是内部实现细节。
 * 渲染层展示沙盒路径时应一并展示，避免用户往里丢重要文件后被静默覆写。
 *
 * ## 为什么不用 userData（拍板时的取舍）
 *
 * 桌面目录「用户一眼看得见」是刻意的：出问题能自己翻、能自己清理。
 * 代价是它会出现在用户桌面上、可能被云同步/备份扫到 —— 对一个
 * 「可被Agent 覆写」的目录来说，这些反而是应该被看见的行为，不是风险。
 *
 * ## 边界
 *
 * 本模块**只负责定位与确保目录存在**，不碰 PermissionPolicy 的判定逻辑。
 * 「路径落在沙盒内」这件事仍由 PermissionPolicy.setScopeRoots + authorize 负责，
 * 这里只是把那个根目录准备好。两处职责不能混：混了就等于白名单自己判自己。
 */

const fs = require('fs');
const path = require('path');

/** 沙盒子目录名。放在桌面下，用户看得见、也便于自行清理。 */
const SANDBOX_DIR_NAME = 'LifeSandbox';

/**
 * 沙盒内的文件约定。会随路径一并展示给用户。
 * 措辞是「用户能据此行动」的规格，不是给实现者看的注释。
 */
const SANDBOX_NOTICE = '沙盒内文件一律视为可被 Agent 覆写，请勿放入重要文件。';

/**
 * 定位沙盒绝对路径（**不创建**，纯路径计算，可单测）。
 *
 * @param {string} desktopPath app.getPath('desktop')
 * @returns {string} 沙盒绝对路径
 */
function sandboxPathFor(desktopPath) {
  // 🔴 2026-10-06 审核修掉的真漏洞（变异测试反例3逼出来的）：
  //   原实现先 `String(desktopPath || '')` **再**查 typeof，
  //   于是 `sandboxPathFor(123)` 会把数字转成 '123' 拼进路径，
  //   `path.resolve('123')` 解析成 **当前工作目录**下的 '123'。
  //   实测曾产出 `<project-root>\123\LifeSandbox` ——
  //   也就是说「桌面路径异常」时会静默把工作目录当成沙盒根。
  //   （`[]` 因为空数组 falsy 被挡住，纯属侥幸。）
  //   正确顺序：**先查类型再取值**，非字符串一律拒。
  if (typeof desktopPath !== 'string' || !desktopPath.trim()) {
    throw new Error('DESKTOP_PATH_UNAVAILABLE');
  }
  return path.join(path.resolve(desktopPath.trim()), SANDBOX_DIR_NAME);
}

/**
 * 确保沙盒目录存在。创建失败**一律抛错，绝不静默继续**。
 *
 * 🔴 为什么不能静默失败：沙盒建不出来却继续往下走，最终要么写到别处
 * （写权限泄漏到桌面之外），要么每次执行都在同一个 mkdir 上报错 ——
 * 后者会让用户以为「Agent 坏了」，前者是真的越界。宁可当场拒。
 *
 * @param {string} dir 沙盒绝对路径
 * @param {object} [fsImpl] 注入用（测试）
 * @returns {string} dir
 */
function ensureSandboxDir(dir, fsImpl) {
  const f = fsImpl || fs;
  const target = String(dir || '');
  if (!target) throw new Error('SANDBOX_PATH_REQUIRED');
  try {
    f.mkdirSync(target, { recursive: true });
  } catch (err) {
    // 不吞异常：调用方需要知道「沙盒不可用」这个事实并拒绝执行。
    throw Object.assign(new Error('SANDBOX_UNAVAILABLE: ' + String((err && err.message) || '')), {
      code: 'SANDBOX_UNAVAILABLE',
    });
  }
  // 建完必须确认它真的是目录：mkdirSync 遇到同名**文件**时不会报错就返回。
  let st = null;
  try {
    st = f.statSync(target);
  } catch {
    throw Object.assign(new Error('SANDBOX_UNAVAILABLE: stat failed'), { code: 'SANDBOX_UNAVAILABLE' });
  }
  if (!st || !st.isDirectory()) {
    throw Object.assign(new Error('SANDBOX_UNAVAILABLE: not a directory'), { code: 'SANDBOX_UNAVAILABLE' });
  }
  return target;
}

/**
 * 非递归列举沙盒顶层普通文件（供只读感官与 workspace.list 共用）。
 * 只返回 basename / 字节数 / 修改时间戳（毫秒），绝不返回绝对路径，跳过子目录与符号链接。
 *
 * @param {string} dir 沙盒根目录
 * @param {object} [fsImpl] 注入用（测试）
 * @returns {Array<{ name: string, bytes: number, mtime: number }>}
 */
function listSandboxTopLevel(dir, fsImpl) {
  const f = fsImpl || fs;
  const root = String(dir || '');
  if (!root) return [];
  let entries;
  try {
    entries = f.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const items = [];
  for (const ent of entries) {
    const name = typeof ent === 'string' ? ent : (ent && ent.name);
    if (!name || typeof name !== 'string') continue;
    if (ent && typeof ent.isSymbolicLink === 'function' && ent.isSymbolicLink()) continue;
    let st = null;
    try {
      st = typeof f.lstatSync === 'function'
        ? f.lstatSync(path.join(root, name))
        : f.statSync(path.join(root, name));
    } catch {
      continue;
    }
    if (!st || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink())) continue;
    if (typeof st.isFile !== 'function' || !st.isFile()) continue;
    const mtime = Number.isFinite(st.mtimeMs)
      ? Math.round(st.mtimeMs)
      : (st.mtime instanceof Date ? st.mtime.getTime() : 0);
    items.push({ name, bytes: Number(st.size) || 0, mtime });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

const WINDOWS_RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const ILLEGAL_STRUCTURE_CHARS_RE = /[*?<>|"\u0000-\u001f]/;

/**
 * 校验沙盒内部相对路径/文件名合法性（复用并扩展 buildReadSandboxScope 纪律）：
 * 禁绝对路径、禁盘符与 ADS 冒号、禁 `..` / `.` 段、禁 Windows 保留名与末尾点/空格、禁通配符与隐藏点前缀。
 *
 * @param {string} rawHint 用户或提案给定的相对路径
 * @param {{ allowSubdir?: boolean }} [opts]
 * @returns {?{ segments: string[], relativePath: string }}
 */
function validateSandboxRelativePath(rawHint, opts = {}) {
  if (typeof rawHint !== 'string') return null;
  const h = rawHint.trim();
  if (!h || h.length > 200) return null;
  if (path.isAbsolute(h)) return null;
  if (/^[a-zA-Z]:/.test(h) || /^\\\\/.test(h) || h.includes(':')) return null;
  if (ILLEGAL_STRUCTURE_CHARS_RE.test(h)) return null;
  if (h === '.' || h === '..' || /\.\./.test(h)) return null;
  const allowSubdir = opts.allowSubdir !== false;
  if (!allowSubdir && /[\\/]/.test(h)) return null;
  const rawSegments = h.split(/[\\/]+/).filter(Boolean);
  if (rawSegments.length === 0) return null;
  for (const seg of rawSegments) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (seg.charAt(0) === '.') return null;
    if (seg.endsWith('.') || seg.endsWith(' ')) return null;
    if (WINDOWS_RESERVED_NAME_RE.test(seg.split('.')[0])) return null;
  }
  return {
    segments: rawSegments,
    relativePath: rawSegments.join('/'),
  };
}

/**
 * 构造沙盒结构操作（mkdir / move / remove）的目标作用域，严禁返回沙盒根目录本身或逃逸路径。
 * @param {string} rawHint
 * @param {string} sandboxDir
 * @returns {?{ scope: string, name: string }}
 */
function buildStructureSandboxScope(rawHint, sandboxDir) {
  if (typeof sandboxDir !== 'string' || !sandboxDir.trim()) return null;
  const parsed = validateSandboxRelativePath(rawHint, { allowSubdir: true });
  if (!parsed) return null;
  const root = path.resolve(sandboxDir);
  const resolved = path.join(root, ...parsed.segments);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { scope: resolved, name: parsed.relativePath };
}

/**
 * 校验结构操作绝对/候选 scope 是否含非法文件名、.. 穿越、盘符冒号、保留名或企图直接操作沙盒根目录本身。
 * @param {string} scopePath
 * @param {string[]} roots
 * @returns {boolean} true 表示合法；false 表示非法或越界
 */
function isValidStructureScope(scopePath, roots) {
  if (typeof scopePath !== 'string' || !scopePath.trim()) return false;
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const raw = scopePath.trim();
  const withoutDrive = raw.replace(/^[A-Za-z]:/, '');
  if (withoutDrive.includes(':') || ILLEGAL_STRUCTURE_CHARS_RE.test(withoutDrive)) return false;
  if (raw.split(/[\\/]/).some((s) => s === '.' || s === '..')) return false;
  let resolved;
  try {
    resolved = path.resolve(raw);
  } catch {
    return false;
  }
  for (const r of roots) {
    if (!r) continue;
    const rootResolved = path.resolve(String(r));
    const normT = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const normR = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
    const prefix = normR.endsWith(path.sep) ? normR : normR + path.sep;
    if (normT === normR) return false; // 严禁直接操作沙盒根目录本身
    if (normT.startsWith(prefix)) {
      const rel = path.relative(rootResolved, resolved);
      if (validateSandboxRelativePath(rel, { allowSubdir: true })) return true;
    }
  }
  return false;
}

/**
 * v2.0-s2：chat-send 前置只读感官调度（接入 getCapabilityMode 观察档三档）。
 * - off：直接跳过（零记账、零读取）
 * - observe：记录 markObserveEpoch('workspace.read','in') + memory.noteObserved('workspace.read') + observationLog，
 *            不建案、不执行 _readFile、不写入 Brain 槽位 / dynamicBody
 * - auto：写 markObserveEpoch('workspace.read','out')，走 'readOnly' 免确认提案执行并写入一次性读取槽位
 */
function runPreChatSandboxRead(opts = {}) {
  const {
    text,
    proactive = false,
    cfg = {},
    brain,
    agentIpc,
    sandboxDir,
    observationLog,
    evaluateTrigger,
    buildReadScope,
    getCapabilityMode,
  } = opts;
  if (proactive || !sandboxDir || !agentIpc || !brain || typeof brain.setPendingSandboxRead !== 'function') {
    return { executed: false, reason: 'PRECONDITION_SKIP' };
  }
  if (typeof evaluateTrigger !== 'function' || typeof buildReadScope !== 'function' || typeof getCapabilityMode !== 'function') {
    return { executed: false, reason: 'DEPS_MISSING' };
  }

  const readMode = getCapabilityMode(cfg, 'workspace.read');
  if (readMode === 'off') {
    return { executed: false, mode: 'off', reason: 'CAPABILITY_OFF' };
  }

  const preVerdict = evaluateTrigger(text, { config: cfg, proactive: false });
  if (!preVerdict || !preVerdict.ran || !preVerdict.decision
      || !preVerdict.decision.shouldPropose || preVerdict.decision.capability !== 'workspace.read') {
    return { executed: false, mode: readMode, reason: 'NO_READ_INTENT' };
  }

  const builtRead = buildReadScope(preVerdict.decision.hint, sandboxDir);
  if (!builtRead) {
    return { executed: false, mode: readMode, reason: 'INVALID_SCOPE' };
  }

  if (readMode === 'observe') {
    try {
      if (brain.memory) {
        if (typeof brain.memory.markObserveEpoch === 'function') {
          brain.memory.markObserveEpoch('workspace.read', 'in');
        }
        if (typeof brain.memory.noteObserved === 'function') {
          brain.memory.noteObserved('workspace.read');
        }
      }
      if (observationLog && typeof observationLog.append === 'function') {
        observationLog.append({
          capability: 'workspace.read',
          intentKind: 'workspace.read',
          proposalSource: 'readOnly',
          scopeName: builtRead.name,
          content: `请求读取沙盒文件: ${builtRead.name}`,
        });
      }
    } catch { /* 观察记账异常绝不阻断对话 */ }
    return { executed: false, observed: true, mode: 'observe', name: builtRead.name };
  }

  if (readMode !== 'auto') {
    return { executed: false, mode: readMode, reason: 'UNKNOWN_MODE' };
  }

  try {
    if (brain.memory && typeof brain.memory.markObserveEpoch === 'function') {
      brain.memory.markObserveEpoch('workspace.read', 'out');
    }
  } catch { /* 记账失败不阻断合法读取 */ }

  const readProp = agentIpc.proposeInternal({
    capability: 'workspace.read',
    scope: builtRead.scope,
    reason: '按用户请求读取沙盒文件',
  }, 'main', 'readOnly');
  if (!readProp || !readProp.ok || !readProp.proposal) {
    return { executed: false, mode: 'auto', reason: (readProp && readProp.error) || 'PROPOSE_FAILED' };
  }

  const readExec = agentIpc.executeInternal({ proposalId: readProp.proposal.id });
  if (readExec && readExec.ok && readExec.result && typeof readExec.result.content === 'string') {
    brain.setPendingSandboxRead({
      name: builtRead.name,
      bytes: readExec.result.bytes,
      content: readExec.result.content,
    });
    return { executed: true, mode: 'auto', name: builtRead.name, bytes: readExec.result.bytes };
  }
  return { executed: false, mode: 'auto', reason: (readExec && readExec.error) || 'EXECUTE_FAILED' };
}

module.exports = {
  SANDBOX_DIR_NAME,
  SANDBOX_NOTICE,
  sandboxPathFor,
  ensureSandboxDir,
  listSandboxTopLevel,
  validateSandboxRelativePath,
  buildStructureSandboxScope,
  isValidStructureScope,
  runPreChatSandboxRead,
};
