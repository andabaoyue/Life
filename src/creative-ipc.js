/**
 * src/creative-ipc.js — Creative IPC 面（v0.9.9 Phase 3）
 *
 * 只做接线：输入验证、单 in-flight 门禁、统一错误边界、流式事件推送。
 *
 * 安全边界：
 *   - sender/frame/URL 校验由既有 ipc-guard 统一负责（全部 handler 经 guard.handle 注册，
 *     不自建第二套安全判断）；renderer 永远接触不到 fs / Store 实例 / Adapter 对象。
 *   - 出站数据只含业务字段（safeRecord / 受控消息），不含 credential、filesystem path、
 *     provider 内部配置、adapter 对象、raw error body。
 *   - 正文不做 trim、不做任何关键词过滤（「初澜」等词可以合法出现在创作正文里）。
 */

const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('./redact');
const { assertProjectId } = require('./creative/creative-store');
const { loadCreativeSkill, SKILL_NAME_PATTERN } = require('./creative/skill-loader');

const MAX_CONTENT_CHARS = 64 * 1024; // content 上限（字符数）
const MAX_CONTEXT_JSON = 8 * 1024;   // context 序列化上限
const MAX_CONTEXT_KEYS = 32;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ---------------- 输入验证（fail-closed） ---------------- */

function validateContent(content) {
  if (typeof content !== 'string') {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'content must be a string');
  }
  if (content.length === 0) {
    // 明确语义：空串拒绝；非空（含纯空格）按原文处理，绝不 trim
    throw codedError('CREATIVE_VALIDATION_ERROR', 'content must not be empty');
  }
  if (content.length > MAX_CONTENT_CHARS) {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'content exceeds ' + MAX_CONTENT_CHARS + ' chars');
  }
  return content;
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'context must be a plain object');
  }
  const proto = Object.getPrototypeOf(context);
  if (proto !== Object.prototype && proto !== null) {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'context must be a plain object');
  }
  const keys = Object.keys(context);
  if (keys.length > MAX_CONTEXT_KEYS) {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'context has too many keys');
  }
  for (const k of keys) {
    if (FORBIDDEN_KEYS.includes(k)) {
      throw codedError('CREATIVE_VALIDATION_ERROR', 'context has forbidden key');
    }
  }
  const json = JSON.stringify(context);
  if (typeof json !== 'string' || json.length > MAX_CONTEXT_JSON) {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'context too large');
  }
  // 仅允许纯 JSON 数据：round-trip 必须等价（函数 / undefined / 循环引用一律拒绝），
  // 且每个值必须是纯 JSON 类型（string/number/boolean/null/array/plain object）——
  // Date/Map/Set/类实例等 Node 对象即使能被 JSON 化也不得进入 Context
  let safe;
  try {
    safe = JSON.parse(json);
  } catch {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'context is not JSON-serializable');
  }
  if (JSON.stringify(safe) !== json) {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'context must contain plain JSON values only');
  }
  const plainValue = (v) => {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true;
    if (Array.isArray(v)) return v.every(plainValue);
    if (typeof v === 'object') {
      const p = Object.getPrototypeOf(v);
      return (p === Object.prototype || p === null) && Object.keys(v).every((k) => !FORBIDDEN_KEYS.includes(k) && plainValue(v[k]));
    }
    return false;
  };
  if (!plainValue(context)) {
    throw codedError('CREATIVE_VALIDATION_ERROR', 'context must contain plain JSON values only');
  }
  return safe; // 安全副本，杜绝原型/引用穿透
}

function validateSkillName(skillName) {
  const name = String(skillName == null ? '' : skillName);
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw codedError('CREATIVE_SKILL_NAME_INVALID', 'skill name invalid');
  }
  return name;
}

/* ---------------- 错误边界（不把 Node exception 直接冒泡给 renderer） ---------------- */

function safeMessage(message, dataRoot) {
  let msg = redactSecrets(String(message == null ? '' : message));
  if (dataRoot) msg = msg.split(String(dataRoot)).join('<data>');
  msg = msg.replace(/[A-Za-z]:\\[^\s'"<>]*/g, '<path>').replace(/\/(?:tmp|home|Users|var|mnt)[^\s'"<>]*/g, '<path>');
  return msg.slice(0, 200);
}

function safeError(err, fallbackCode, dataRoot) {
  const code = err && typeof err.code === 'string' && err.code.startsWith('CREATIVE_') ? err.code : fallbackCode;
  return { ok: false, code, error: safeMessage(err && err.message, dataRoot) };
}

function safeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    recordId: String(r.recordId == null ? '' : r.recordId),
    role: String(r.role == null ? '' : r.role),
    status: String(r.status == null ? '' : r.status),
    content: String(r.content == null ? '' : r.content),
    finishReason: String(r.finishReason == null ? '' : r.finishReason),
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null
  };
}

/**
 * 注册 Creative IPC。guard 为既有 ipc-guard（handle/on 已含 sender/frame/URL 校验）。
 * options: { getStore, getSession, getWebContents, skillsDir, dataRoot }
 */
function registerCreativeIpc(guard, options = {}) {
  if (!guard || typeof guard.handle !== 'function') throw new Error('IPC_GUARD_REQUIRED');
  const { getStore, getSession, getWebContents, skillsDir, dataRoot } = options;
  if (typeof getStore !== 'function' || typeof getSession !== 'function') {
    throw new Error('CREATIVE_STORE_SESSION_REQUIRED');
  }

  // 单 project 单 in-flight（§10 真实施加）：B 请求直接拒绝，绝不覆盖 A 的 pending
  const inFlight = new Map(); // projectId -> AbortController

  const emit = (channel, payload) => {
    const contents = typeof getWebContents === 'function' ? getWebContents() : null;
    if (contents && typeof contents.send === 'function') contents.send(channel, payload);
  };

  // §11: 任何读 history 的路径之前先执行 recoverPending（幂等，不重复提交）
  const recover = (projectId) => getStore().recoverPending(projectId);

  const projectIdOf = (raw, fallback) => assertProjectId(typeof raw === 'string' && raw ? raw : fallback);

  /* ---------------- Project ---------------- */

  guard.handle('creative:list-projects', async () => {
    try {
      const store = getStore();
      return { ok: true, projects: store.listProjects(), activeProject: store.getActiveProject() };
    } catch (e) { return safeError(e, 'CREATIVE_STORAGE_ERROR', dataRoot); }
  });

  guard.handle('creative:create-project', async (e, projectId) => {
    try {
      const id = assertProjectId(projectId); // Phase 2 边界，IPC 不得绕过
      return { ok: true, projectId: getStore().createProject(id).projectId };
    } catch (err) { return safeError(err, 'CREATIVE_VALIDATION_ERROR', dataRoot); }
  });

  guard.handle('creative:get-active-project', async () => {
    try { return { ok: true, activeProject: getStore().getActiveProject() }; }
    catch (e) { return safeError(e, 'CREATIVE_STORAGE_ERROR', dataRoot); }
  });

  guard.handle('creative:set-active-project', async (e, projectId) => {
    try {
      const id = assertProjectId(projectId);
      return { ok: true, activeProject: getStore().setActiveProject(id) };
    } catch (err) { return safeError(err, 'CREATIVE_VALIDATION_ERROR', dataRoot); }
  });

  guard.handle('creative:load-project', async (e, projectId) => {
    try {
      const store = getStore();
      const id = projectIdOf(projectId, store.getActiveProject());
      if (!store.projectExists(id)) return { ok: false, code: 'CREATIVE_PROJECT_NOT_FOUND', error: 'project not found' };
      recover(id);
      const proj = store.loadProject(id);
      return {
        ok: true,
        projectId: proj.projectId,
        context: proj.context,
        summary: proj.summary,
        history: proj.history.map(safeRecord)
      };
    } catch (err) { return safeError(err, 'CREATIVE_STORAGE_ERROR', dataRoot); }
  });

  /* ---------------- Context / Summary / History ---------------- */

  guard.handle('creative:update-context', async (e, projectId, context) => {
    try {
      const id = projectIdOf(projectId, getStore().getActiveProject());
      const safe = validateContext(context);
      return { ok: true, projectId: id, context: getStore().updateContext(id, safe) };
    } catch (err) { return safeError(err, 'CREATIVE_VALIDATION_ERROR', dataRoot); }
  });

  guard.handle('creative:summarize', async (e, projectId) => {
    try {
      const store = getStore();
      const id = projectIdOf(projectId, store.getActiveProject());
      if (!store.projectExists(id)) return { ok: false, code: 'CREATIVE_PROJECT_NOT_FOUND', error: 'project not found' };
      recover(id);
      const s = store.summarizeCreative(id);
      return { ok: true, projectId: id, summary: { summaryText: s.summaryText, messageCount: s.messageCount, sourceHistoryHash: s.sourceHistoryHash } };
    } catch (err) { return safeError(err, 'CREATIVE_STORAGE_ERROR', dataRoot); }
  });

  guard.handle('creative:get-history', async (e, projectId) => {
    try {
      const store = getStore();
      const id = projectIdOf(projectId, store.getActiveProject());
      if (!store.projectExists(id)) return { ok: false, code: 'CREATIVE_PROJECT_NOT_FOUND', error: 'project not found' };
      recover(id);
      return { ok: true, projectId: id, history: store.readHistory(id).map(safeRecord) };
    } catch (err) { return safeError(err, 'CREATIVE_STORAGE_ERROR', dataRoot); }
  });

  /* ---------------- Generation / Streaming / Abort ---------------- */

  guard.handle('creative:send', async (e, payload) => {
    try {
      const store = getStore();
      const p = payload && typeof payload === 'object' ? payload : {};
      const id = projectIdOf(p.projectId, store.getActiveProject());
      const content = validateContent(p.content); // 原文保留（不 trim、不过滤）
      if (!store.projectExists(id)) return { ok: false, code: 'CREATIVE_PROJECT_NOT_FOUND', error: 'project not found' };
      if (inFlight.has(id)) {
        return { ok: false, code: 'CREATIVE_GENERATION_IN_FLIGHT', error: 'generation already in flight for this project' };
      }
      recover(id);
      const ctrl = new AbortController();
      inFlight.set(id, ctrl);
      const session = getSession();
      (async () => {
        try {
          const record = await session.send({
            projectId: id,
            content,
            onDelta: (d) => emit('creative:delta', { projectId: id, text: String(d) }),
            signal: ctrl.signal
          });
          if (record.status === 'aborted') {
            emit('creative:aborted', { ok: true, projectId: id, record: safeRecord(record) });
          } else if (record.status === 'error') {
            emit('creative:error', {
              ok: false, projectId: id, code: 'CREATIVE_PROVIDER_ERROR',
              error: safeMessage(record.errorMessage, dataRoot), record: safeRecord(record)
            });
          } else {
            emit('creative:completed', { ok: true, projectId: id, record: safeRecord(record) });
          }
        } catch (err) {
          emit('creative:error', safeError(err, 'CREATIVE_PROVIDER_ERROR', dataRoot));
        } finally {
          inFlight.delete(id);
        }
      })();
      return { ok: true, projectId: id }; // 已受理；过程经 creative:delta/completed/error/aborted 事件推送
    } catch (err) { return safeError(err, 'CREATIVE_VALIDATION_ERROR', dataRoot); }
  });

  guard.handle('creative:abort', async (e, projectId) => {
    try {
      const id = projectIdOf(projectId, getStore().getActiveProject());
      const ctrl = inFlight.get(id);
      if (!ctrl) return { ok: false, code: 'CREATIVE_NO_GENERATION_IN_FLIGHT', error: 'no generation in flight' };
      ctrl.abort(); // 传递到 Session -> Adapter -> 既有 transport（不自建 abort 体系）
      return { ok: true, projectId: id };
    } catch (err) { return safeError(err, 'CREATIVE_VALIDATION_ERROR', dataRoot); }
  });

  /* ---------------- Skill ---------------- */

  guard.handle('creative:list-skills', async () => {
    try {
      if (!skillsDir) return { ok: true, skills: [] };
      let names = [];
      try {
        names = fs.readdirSync(skillsDir).filter((n) => SKILL_NAME_PATTERN.test(n)).sort();
      } catch { names = []; }
      return { ok: true, skills: names };
    } catch (e) { return safeError(e, 'CREATIVE_STORAGE_ERROR', dataRoot); }
  });

  guard.handle('creative:load-skill', async (e, skillName) => {
    try {
      const name = validateSkillName(skillName); // fail-closed，与 Skill Loader 同一边界
      const skill = loadCreativeSkill(name, { baseDir: skillsDir });
      return { ok: true, skill: skill ? { name: skill.name, text: skill.text } : null };
    } catch (err) { return safeError(err, 'CREATIVE_SKILL_NAME_INVALID', dataRoot); }
  });

  return { inFlight };
}

module.exports = {
  registerCreativeIpc,
  validateContent,
  validateContext,
  validateSkillName,
  safeRecord,
  safeError,
  MAX_CONTENT_CHARS
};
