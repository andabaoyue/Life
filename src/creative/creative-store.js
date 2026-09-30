/**
 * src/creative/creative-store.js — Creative Multi-Project Store（v0.9.9 Phase 2）
 *
 * 目录布局（不平铺 userData 根目录）：
 *   userData/creative/
 *     ├── active-project.json        （原子写）
 *     └── projects/<projectId>/
 *           ├── project.json
 *           ├── history.jsonl        （append-only，整行 JSON + fsync）
 *           ├── history.pending.json （生成事务 pending）
 *           ├── context.json         （显式项目状态）
 *           └── summary.json         （History 压缩产物）
 *
 * 数据正交约束（不可逆）：
 *   Summary = History compression（只读 History、只写 Summary）
 *   Context = Explicit project state（只经显式 updateContext 写入）
 *   三者是并行数据源，加载不产生任何隐式覆盖；Summary 服务绝不调用 updateContext。
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../atomic');
const { sourceHistoryHash } = require('./creative-hash');

// projectId 路径安全边界：受限字符集（无路径分隔符 / 无点号 / 无控制字符），
// 结构上不可能出现 ../、..\\、绝对路径、空串逃逸。
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL_STATUS = ['completed', 'aborted', 'error'];

function assertProjectId(projectId) {
  const id = String(projectId == null ? '' : projectId);
  if (!PROJECT_ID_PATTERN.test(id)) {
    const err = new Error('CREATIVE_PROJECT_ID_INVALID');
    err.code = 'CREATIVE_PROJECT_ID_INVALID';
    throw err;
  }
  return id;
}

function createCreativeStore(userDataDir) {
  const root = path.join(String(userDataDir == null ? '' : userDataDir), 'creative');
  const projectsDir = path.join(root, 'projects');
  const activeFile = path.join(root, 'active-project.json');

  const dirOf = (projectId) => path.join(projectsDir, assertProjectId(projectId));
  const projectMetaPath = (id) => path.join(dirOf(id), 'project.json');
  const historyPath = (id) => path.join(dirOf(id), 'history.jsonl');
  const pendingPath = (id) => path.join(dirOf(id), 'history.pending.json');
  const contextPath = (id) => path.join(dirOf(id), 'context.json');
  const summaryPath = (id) => path.join(dirOf(id), 'summary.json');

  function readJsonSafe(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
  }

  /* ---------------- project 生命周期 ---------------- */

  function createProject(projectId = 'default') {
    const id = assertProjectId(projectId);
    fs.mkdirSync(dirOf(id), { recursive: true });
    if (!fs.existsSync(projectMetaPath(id))) {
      writeJsonAtomic(projectMetaPath(id), { projectId: id, createdAt: Date.now() });
    }
    return { projectId: id };
  }

  function projectExists(projectId) {
    try { return fs.existsSync(projectMetaPath(assertProjectId(projectId))); } catch { return false; }
  }

  function listProjects() {
    try {
      return fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && PROJECT_ID_PATTERN.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch { return []; }
  }

  function setActiveProject(projectId) {
    const id = assertProjectId(projectId);
    if (!projectExists(id)) {
      const err = new Error('CREATIVE_PROJECT_NOT_FOUND');
      err.code = 'CREATIVE_PROJECT_NOT_FOUND';
      throw err;
    }
    writeJsonAtomic(activeFile, { activeProjectId: id }); // 原子写
    return id;
  }

  function getActiveProject() {
    const j = readJsonSafe(activeFile, null);
    const id = j && typeof j.activeProjectId === 'string' ? j.activeProjectId : 'default';
    return PROJECT_ID_PATTERN.test(id) ? id : 'default';
  }

  /* ---------------- history：append-only + pending 事务 ---------------- */

  function readHistory(projectId) {
    const p = historyPath(projectId);
    if (!fs.existsSync(p)) return [];
    const out = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      out.push(JSON.parse(s)); // 严格：写入侧保证整行 JSON；非法行必须先经 recoverPending 修复
    }
    return out;
  }

  function appendHistory(projectId, record) {
    const p = historyPath(projectId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n'); // 整行 JSON 单次写入
      fs.fsyncSync(fd);                                // 落盘后才算提交
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  function recordExists(projectId, recordId) {
    return readHistory(projectId).some((r) => r && r.recordId === recordId);
  }

  /** 生成开始：pending 状态恒为 streaming（非终态，只属于事务） */
  function beginPending(projectId, pending) {
    assertProjectId(projectId);
    writeJsonAtomic(pendingPath(projectId), { ...pending, status: 'streaming' });
    return pending;
  }

  /**
   * 两阶段提交：先以终态覆写 pending（崩溃于此后可按终态恢复），
   * 再 append history + fsync，最后删除 pending。
   */
  function completePending(projectId, record) {
    assertProjectId(projectId);
    const terminal = TERMINAL_STATUS.includes(record && record.status) ? record.status : 'error';
    const finalRecord = { ...record, status: terminal };
    writeJsonAtomic(pendingPath(projectId), finalRecord);
    appendHistory(projectId, finalRecord);
    try { fs.unlinkSync(pendingPath(projectId)); } catch {}
    return finalRecord;
  }

  /** 修复 crash 撕裂的半行：尾行不可解析则截掉（恢复后不允许残留半行 JSON） */
  function repairTornTail(projectId) {
    const p = historyPath(projectId);
    if (!fs.existsSync(p)) return false;
    const text = fs.readFileSync(p, 'utf8');
    if (!text) return false;
    const lines = text.split('\n');
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim() === '') last--;
    if (last < 0) return false;
    try {
      JSON.parse(lines[last].trim());
      return false;
    } catch {}
    fs.writeFileSync(p, lines.slice(0, last).join('\n') ? lines.slice(0, last).join('\n') + '\n' : '');
    return true;
  }

  /**
   * 启动恢复：
   *   pending 不存在                 -> 无操作
   *   pending 不可解析 / 无 recordId -> 丢弃（不得阻塞启动）
   *   history 已有相同 recordId      -> 只清 pending
   *   否则                           -> 按 pending 终态安全提交；
   *      pending.status 仍是 streaming（崩溃于生成中）-> 安全落为 error 终态，
   *      content 保留已真实收到的 partial，并标记 recoveredFromPending。
   */
  function recoverPending(projectId) {
    const id = assertProjectId(projectId);
    repairTornTail(id);
    const pp = pendingPath(id);
    if (!fs.existsSync(pp)) return { recovered: false, action: 'none' };
    let pending = null;
    try { pending = JSON.parse(fs.readFileSync(pp, 'utf8')); } catch {}
    if (!pending || typeof pending.recordId !== 'string' || !pending.recordId) {
      try { fs.unlinkSync(pp); } catch {}
      return { recovered: false, action: 'dropped_invalid_pending' };
    }
    if (recordExists(id, pending.recordId)) {
      try { fs.unlinkSync(pp); } catch {}
      return { recovered: true, action: 'cleared_pending_record_already_committed', recordId: pending.recordId };
    }
    const terminal = TERMINAL_STATUS.includes(pending.status) ? pending.status : 'error';
    const record = {
      recordId: pending.recordId,
      projectId: typeof pending.projectId === 'string' ? pending.projectId : id,
      role: typeof pending.role === 'string' ? pending.role : 'assistant',
      status: terminal,
      content: String(pending.content == null ? '' : pending.content),
      finishReason: pending.finishReason || (terminal === 'completed' ? 'stop' : terminal === 'aborted' ? 'abort' : 'error'),
      createdAt: Number.isFinite(pending.createdAt) ? pending.createdAt : Date.now(),
      recoveredFromPending: true
    };
    appendHistory(id, record);
    try { fs.unlinkSync(pp); } catch {}
    return { recovered: true, action: 'committed_from_pending', recordId: record.recordId, record };
  }

  /* ---------------- context / summary：正交数据源 ---------------- */

  /** 显式项目状态更新：只允许显式用户操作 / 明确 Skill 操作触发；独立写 context.json */
  function updateContext(projectId, context) {
    const id = assertProjectId(projectId);
    fs.mkdirSync(dirOf(id), { recursive: true });
    writeJsonAtomic(contextPath(id), { ...(context && typeof context === 'object' ? context : {}) });
    return readJsonSafe(contextPath(id), {});
  }

  function readContext(projectId) {
    return readJsonSafe(contextPath(assertProjectId(projectId)), {});
  }

  /**
   * Summary = History compression。
   * 只读 History、只写 Summary —— 禁止自动修改/清空 Context、禁止生成 project settings、
   * 禁止反向调用 updateContext。
   */
  function summarizeCreative(projectId, opts = {}) {
    const id = assertProjectId(projectId);
    fs.mkdirSync(dirOf(id), { recursive: true });
    const history = readHistory(id);
    const summarize = typeof opts.summarizer === 'function' ? opts.summarizer : defaultSummarizer;
    const summary = {
      summaryText: String(summarize(history) || ''),
      messageCount: history.length,
      sourceHistoryHash: sourceHistoryHash(history.map((r) => ({ role: r.role, content: r.content }))),
      updatedAt: Date.now()
    };
    writeJsonAtomic(summaryPath(id), summary);
    return summary;
  }

  function readSummary(projectId) {
    return readJsonSafe(summaryPath(assertProjectId(projectId)), null);
  }

  /** 三者并行数据源直接返回，无任何优先级/覆盖规则 */
  function loadProject(projectId = 'default') {
    const id = assertProjectId(projectId);
    if (!projectExists(id)) return null;
    return {
      projectId: id,
      context: readContext(id),
      summary: readSummary(id),
      history: readHistory(id)
    };
  }

  return {
    root,
    createProject,
    projectExists,
    listProjects,
    setActiveProject,
    getActiveProject,
    readHistory,
    appendHistory,
    beginPending,
    completePending,
    recoverPending,
    repairTornTail,
    updateContext,
    readContext,
    summarizeCreative,
    readSummary,
    loadProject
  };
}

/** 默认压缩器：确定性（无时钟、无随机），仅依赖 History 内容 */
function defaultSummarizer(history) {
  return (Array.isArray(history) ? history : [])
    .map((r) => String(r.role) + ': ' + String(r.content == null ? '' : r.content).slice(0, 120))
    .join('\n');
}

module.exports = {
  createCreativeStore,
  assertProjectId,
  PROJECT_ID_PATTERN,
  defaultSummarizer
};
