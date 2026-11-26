/**
 * src/memory-expectations.js — 预期与承诺时间矢量子存储（从 src/memory.js 拆出）
 *
 * 维护 data.expectations 的引证入库（FIFO 上限 10）与跨窗结算状态流转（fulfilled/broken/moot）。
 */

function addExpectation(mem, entry = {}, opts = {}) {
  const kind = String(entry.kind || '');
  if (!['external', 'pledge'].includes(kind)) return { ok: false, error: 'INVALID_KIND' };
  const source = String(entry.source || '');
  if (!['user', 'chulan'].includes(source)) return { ok: false, error: 'INVALID_SOURCE' };
  const text = String(entry.text || entry.content || '').trim();
  if (!text) return { ok: false, error: 'EMPTY_TEXT' };
  const messageId = String(entry.messageId || '');
  if (!mem._resolveMessage(messageId, opts)) return { ok: false, error: 'UNRESOLVED_MESSAGE_ID' };
  const list = Array.isArray(mem.data.expectations) ? mem.data.expectations : (mem.data.expectations = []);
  const n = list.reduce((a, x) => Math.max(a, Number(String((x && x.id) || '').replace(/\D/g, '')) || 0), 0) + 1;
  const rec = {
    id: 'exp-' + String(n).padStart(6, '0'),
    kind, text, source, messageId,
    windowNo: Number.isFinite(entry.windowNo) ? entry.windowNo : mem.data.windowNo,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
    dueHint: entry.dueHint == null ? null : String(entry.dueHint),
    status: 'open',
    outcome: null
  };
  list.push(rec);
  if (list.length > 10) list.splice(0, list.length - 10);
  mem.save();
  return { ok: true, entry: rec };
}

function resolveExpectation(mem, id, outcome = {}, opts = {}) {
  const list = Array.isArray(mem.data.expectations) ? mem.data.expectations : [];
  const hit = list.find((x) => x && x.id === id);
  if (!hit) return { ok: false, error: 'NOT_FOUND' };
  if (hit.status !== 'open') return { ok: false, error: 'ALREADY_RESOLVED' };
  const status = String(outcome.status || '');
  if (!['fulfilled', 'broken', 'moot'].includes(status)) return { ok: false, error: 'INVALID_STATUS' };
  const messageId = outcome.messageId == null ? null : String(outcome.messageId);
  if (status !== 'moot' && !mem._resolveMessage(messageId || '', opts)) return { ok: false, error: 'UNRESOLVED_MESSAGE_ID' };
  const resolvedWindowNo = Number.isFinite(outcome.windowNo)
    ? outcome.windowNo
    : (Number.isFinite(opts.windowNo) ? opts.windowNo : mem.data.windowNo);
  hit.status = status;
  hit.outcome = {
    at: Number.isFinite(outcome.at) ? outcome.at : null,
    messageId,
    note: String(outcome.note || ''),
    resolvedWindowNo
  };
  mem.save();
  return { ok: true, entry: hit };
}

module.exports = {
  addExpectation,
  resolveExpectation,
};
