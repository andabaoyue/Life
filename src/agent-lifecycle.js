/**
 * src/agent-lifecycle.js
 *
 * 初澜 v2.0-b（任务 A）：Ticket 生命周期管理器与持久化（%APPDATA%\Life\agent-tickets.json）。
 *
 * ⚠️ 设计偏离声明（刻意偏离原型 deepseek-ai/dsh-superagent-prototype）：
 *   原型里的 Ticket 状态机只有 `open -> ended` 两态，它把「暂停」表达为
 *   Assignment 结束 + waiting Report。但在 Life 桌面陪伴场景中，「等她开口 / 等用户回来」
 *   属于正常留白与挂起常态，而非一次执行任务失败或终结；因此本模块刻意扩展为三态可逆挂起机：
 *
 *     open ⇄ paused → ended
 *
 *   其中 `ended` 为终态（不可逆，禁止从 `ended` 回到 `open` 或 `paused`）。
 *
 * 四条硬纪律：
 *   1. 绝不写入 memory.history、绝不进 systemText()（不破坏前缀缓存、不存对话全文）。
 *   2. 仅通过尾部动态槽位注入摘要：最多 3 条 open/paused，单条严格 <= 80 字，空集返回空串（不留白标题）。
 *   3. 原子写：所有持久化一律复用 `src/atomic.js` 的 `writeJsonAtomic`，严禁手写 `fs.writeFileSync`。
 *   4. 损坏降级：文件缺失或 JSON / 结构损坏时不抛、不阻塞启动，降级为空白票据集。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic');

const TICKET_FILE_NAME = 'agent-tickets.json';
const TICKET_SCHEMA_VERSION = 1;
const TICKET_STATES = Object.freeze(['open', 'paused', 'ended']);
const TICKET_TITLE_MAX_CHARS = 60;
const TICKET_NOTE_MAX_CHARS = 200;
const TICKET_MAX_INJECT = 3;
const TICKET_LINE_MAX_CHARS = 80;
const CAPABILITY_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/** 状态转移表：open ⇄ paused → ended（ended 为终态，不可逆） */
const TICKET_TRANSITIONS = Object.freeze({
  open: new Set(['paused', 'ended']),
  paused: new Set(['open', 'ended']),
  ended: new Set(),
});

function sanitizeSingleLine(raw, maxChars) {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(/[\r\n\t\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

function normalizeCapability(cap) {
  if (cap === null || cap === undefined || cap === '') return null;
  if (typeof cap !== 'string') return null;
  const trimmed = cap.trim();
  if (!CAPABILITY_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeWindowNo(val, fallback = 1) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function normalizeTimestamp(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function cloneTicket(t) {
  return Object.freeze({
    id: t.id,
    title: t.title,
    state: t.state,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    windowNo: t.windowNo,
    capability: t.capability,
    note: t.note,
  });
}

function normalizeTicketRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
  const title = sanitizeSingleLine(raw.title, TICKET_TITLE_MAX_CHARS);
  const state = TICKET_STATES.includes(raw.state) ? raw.state : null;
  if (!id || !title || !state) return null;
  const createdAt = normalizeTimestamp(raw.createdAt, 0);
  const updatedAt = normalizeTimestamp(raw.updatedAt, createdAt);
  if (createdAt <= 0 || updatedAt <= 0) return null;
  const noteText = sanitizeSingleLine(raw.note, TICKET_NOTE_MAX_CHARS);
  return {
    id,
    title,
    state,
    createdAt,
    updatedAt,
    windowNo: normalizeWindowNo(raw.windowNo, 1),
    capability: normalizeCapability(raw.capability),
    note: noteText || null,
  };
}

/**
 * 格式化单条未完 Ticket 为动态尾部摘要行（严格单行且 <= 80 字）。
 * @param {object} ticket
 * @param {number} [maxChars=80]
 * @returns {string}
 */
function formatTicketLine(ticket, maxChars = TICKET_LINE_MAX_CHARS) {
  if (!ticket || (ticket.state !== 'open' && ticket.state !== 'paused')) return '';
  const limit = Number.isFinite(maxChars) && maxChars >= 16 ? Math.floor(maxChars) : TICKET_LINE_MAX_CHARS;
  const tag = ticket.state === 'paused' ? '暂停' : '进行中';
  const title = sanitizeSingleLine(ticket.title, TICKET_TITLE_MAX_CHARS);
  if (!title) return '';
  const note = sanitizeSingleLine(ticket.note, TICKET_NOTE_MAX_CHARS);
  const body = note ? `${title}：${note}` : title;
  const line = `- [${tag}] ${body}`;
  if (line.length <= limit) return line;
  return line.slice(0, limit - 1) + '…';
}

/**
 * 将未完 Ticket 列表渲染为 dynamicBody 末尾摘要块：
 *   - 只保留 open / paused；
 *   - 最多 3 条（按 updatedAt 倒序取最近更新）；
 *   - 空集严格返回 ''（绝不输出空白标题）。
 * @param {Array} tickets
 * @returns {string}
 */
function formatTicketsForPrompt(tickets) {
  if (!Array.isArray(tickets) || tickets.length === 0) return '';
  const active = tickets
    .filter((t) => t && (t.state === 'open' || t.state === 'paused'))
    .slice()
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, TICKET_MAX_INJECT);
  if (active.length === 0) return '';
  const lines = active.map((t) => formatTicketLine(t, TICKET_LINE_MAX_CHARS)).filter(Boolean);
  if (lines.length === 0) return '';
  return '【当前未完事项】（程序记录的挂起/进行中事项，仅供知晓）\n' + lines.join('\n');
}

class TicketStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir] 数据根目录（Electron 环境下为 app.getPath('userData')，即 %APPDATA%\Life）
   * @param {string} [opts.filePath] 显式文件路径覆盖（优先于 dir）
   * @param {object} [opts.fs] 可注入文件系统替身
   */
  constructor(opts = {}) {
    this.fs = opts.fs || fs;
    if (typeof opts.filePath === 'string' && opts.filePath.trim()) {
      this.filePath = path.resolve(opts.filePath);
      this.dir = path.dirname(this.filePath);
    } else if (typeof opts.dir === 'string' && opts.dir.trim()) {
      this.dir = path.resolve(opts.dir);
      this.filePath = path.join(this.dir, TICKET_FILE_NAME);
    } else {
      this.dir = null;
      this.filePath = null;
    }
    this.tickets = [];
    this.corrupted = false;
    this.load();
  }

  /**
   * 从磁盘加载票据。缺失或损坏一律静默降级为空白票据集，不抛异常、不阻塞启动。
   */
  load() {
    this.tickets = [];
    this.corrupted = false;
    if (!this.filePath) return;

    let text;
    try {
      text = this.fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      this.corrupted = true;
      console.warn('[TicketStore] 读取票据文件失败，降级为空白票据集:', err && err.message);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.corrupted = true;
      console.warn('[TicketStore] 票据 JSON 损坏，降级为空白票据集:', err && err.message);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.tickets)) {
      this.corrupted = true;
      console.warn('[TicketStore] 票据顶层结构异常，降级为空白票据集');
      return;
    }

    const loaded = [];
    const seenIds = new Set();
    for (const item of parsed.tickets) {
      const normalized = normalizeTicketRecord(item);
      if (!normalized || seenIds.has(normalized.id)) continue;
      seenIds.add(normalized.id);
      loaded.push(normalized);
    }
    this.tickets = loaded;
  }

  _persist() {
    if (!this.filePath) return;
    if (this.dir && typeof this.fs.mkdirSync === 'function') {
      this.fs.mkdirSync(this.dir, { recursive: true });
    }
    writeJsonAtomic(this.filePath, {
      schemaVersion: TICKET_SCHEMA_VERSION,
      updatedAt: Date.now(),
      tickets: this.tickets,
    });
  }

  createTicket(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const title = sanitizeSingleLine(input.title, TICKET_TITLE_MAX_CHARS);
    if (!title) {
      return { ok: false, code: 'TITLE_REQUIRED' };
    }
    const initState = input.state === undefined ? 'open' : input.state;
    if (initState !== 'open' && initState !== 'paused') {
      return { ok: false, code: 'INVALID_INITIAL_STATE', state: initState };
    }
    if (input.capability !== undefined && input.capability !== null && input.capability !== ''
        && normalizeCapability(input.capability) === null) {
      return { ok: false, code: 'INVALID_CAPABILITY' };
    }
    const now = normalizeTimestamp(input.now, Date.now());
    const id = `tkt-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const noteText = sanitizeSingleLine(input.note, TICKET_NOTE_MAX_CHARS);
    const ticket = {
      id,
      title,
      state: initState,
      createdAt: now,
      updatedAt: now,
      windowNo: normalizeWindowNo(input.windowNo, 1),
      capability: normalizeCapability(input.capability),
      note: noteText || null,
    };
    this.tickets.push(ticket);
    this._persist();
    return { ok: true, ticket: cloneTicket(ticket) };
  }

  transition(id, nextState, opts = {}) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) return { ok: false, code: 'TICKET_NOT_FOUND' };
    const idx = this.tickets.findIndex((t) => t.id === key);
    if (idx < 0) return { ok: false, code: 'TICKET_NOT_FOUND' };
    const current = this.tickets[idx];
    const allowedTargets = TICKET_TRANSITIONS[current.state];
    if (!TICKET_STATES.includes(nextState) || !allowedTargets || !allowedTargets.has(nextState)) {
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        from: current.state,
        to: nextState,
      };
    }

    const updatedAt = normalizeTimestamp(opts && opts.now, Date.now());
    const nextNote = (opts && opts.note !== undefined)
      ? (sanitizeSingleLine(opts.note, TICKET_NOTE_MAX_CHARS) || null)
      : current.note;
    const nextWindowNo = (opts && opts.windowNo !== undefined)
      ? normalizeWindowNo(opts.windowNo, current.windowNo)
      : current.windowNo;

    this.tickets[idx] = {
      ...current,
      state: nextState,
      updatedAt: Math.max(updatedAt, current.updatedAt),
      windowNo: nextWindowNo,
      note: nextNote,
    };
    this._persist();
    return { ok: true, ticket: cloneTicket(this.tickets[idx]) };
  }

  updateNote(id, note, opts = {}) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) return { ok: false, code: 'TICKET_NOT_FOUND' };
    const idx = this.tickets.findIndex((t) => t.id === key);
    if (idx < 0) return { ok: false, code: 'TICKET_NOT_FOUND' };
    const current = this.tickets[idx];
    if (current.state === 'ended') {
      return { ok: false, code: 'TICKET_ALREADY_ENDED' };
    }
    const updatedAt = normalizeTimestamp(opts && opts.now, Date.now());
    const cleanNote = sanitizeSingleLine(note, TICKET_NOTE_MAX_CHARS) || null;
    this.tickets[idx] = {
      ...current,
      updatedAt: Math.max(updatedAt, current.updatedAt),
      windowNo: (opts && opts.windowNo !== undefined)
        ? normalizeWindowNo(opts.windowNo, current.windowNo)
        : current.windowNo,
      note: cleanNote,
    };
    this._persist();
    return { ok: true, ticket: cloneTicket(this.tickets[idx]) };
  }

  get(id) {
    const key = typeof id === 'string' ? id.trim() : '';
    const found = this.tickets.find((t) => t.id === key);
    return found ? cloneTicket(found) : null;
  }

  list(filter = {}) {
    const allowedStates = Array.isArray(filter && filter.states)
      ? new Set(filter.states)
      : (typeof (filter && filter.state) === 'string' ? new Set([filter.state]) : null);
    return this.tickets
      .filter((t) => !allowedStates || allowedStates.has(t.state))
      .map(cloneTicket);
  }

  listActive() {
    return this.tickets
      .filter((t) => t.state === 'open' || t.state === 'paused')
      .slice()
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      .map(cloneTicket);
  }

  formatSummary() {
    return formatTicketsForPrompt(this.tickets);
  }
}

module.exports = {
  TicketStore,
  TICKET_FILE_NAME,
  TICKET_SCHEMA_VERSION,
  TICKET_STATES,
  TICKET_TRANSITIONS,
  TICKET_TITLE_MAX_CHARS,
  TICKET_NOTE_MAX_CHARS,
  TICKET_MAX_INJECT,
  TICKET_LINE_MAX_CHARS,
  formatTicketLine,
  formatTicketsForPrompt,
};
