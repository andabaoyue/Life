const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { DeferredWriter } = require('./deferred-writer');
const { migrate } = require('./migration');
const { checkMessageReference, checkQuoteInMessage, PRIOR_SOURCE_TYPES } = require('./experience-schema');

/**
 * 初澜生命档案：原始成长证据（本地持久化）与 Current Self（运行投影）分离。
 * 原始档案不直接全部进入主聊天；Current Self 只作为当前 user 尾部的有限上下文。
 */
const SCHEMA_VERSION = 2;
const SOURCE_TYPES = new Set([
  // 核心实验规范（Section XIII 七大标准认知来源）
  'INNATE', 'USER', 'OBSERVATION', 'EXPERIENCE', 'SELF_INFERRED', 'MODEL_PRIOR', 'RUNTIME',
  // 兼容旧版标识
  'SELF_STATEMENT', 'USER_INFLUENCE', 'PROGRAM_OBSERVATION', 'MODEL_INTERPRETATION'
]);
const MAX_TEXT = 240;

function cleanText(value, max = MAX_TEXT) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function sourceType(value) {
  const v = String(value || '').toUpperCase();
  return SOURCE_TYPES.has(v) ? v : 'MODEL_INTERPRETATION';
}
function evidence(raw, fallbackAt, fallbackWindow) {
  if (typeof raw === 'string') {
    return { sourceType: 'MODEL_INTERPRETATION', window: fallbackWindow, messageIds: [], quote: cleanText(raw), at: fallbackAt, confidence: 0.5, verification: 'UNVERIFIED' };
  }
  const x = raw || {};
  return {
    sourceType: sourceType(x.sourceType),
    window: Number.isInteger(x.window) ? x.window : fallbackWindow,
    messageIds: Array.isArray(x.messageIds)
      ? x.messageIds.filter(id => Number.isInteger(id) || (typeof id === 'string' && id.trim())).slice(0, 20)
      : [],
    quote: cleanText(x.quote || x.text),
    at: Number.isFinite(x.at) ? x.at : fallbackAt,
    confidence: Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : 0.5,
    verification: x.verification === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED'
  };
}
function normalizeEvidenceList(raw, at, window) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map(x => evidence(x, at, window)).filter(x => x.quote || x.sourceType === 'PROGRAM_OBSERVATION').slice(0, 4);
}

/**
 * 成长证据事实核验（复用 experience-schema 的 provenance 核心原语，
 * 与 SubjectState.verifyEvidence 同一套判据，不另立第二套规则）。
 *
 * 核验内容：
 *   1. messageIds 非空且每个 ID 在消息池中真实存在（MISSING_MESSAGE_ID / MESSAGE_ID_NOT_FOUND）
 *   2. 引用消息属于目标窗口（MESSAGE_WINDOW_MISMATCH）
 *   3. synthetic / bridge / 非法角色消息不得作为成长证据（SYNTHETIC_/BRIDGE_MESSAGE_NOT_ELIGIBLE / INVALID_MESSAGE_ROLE）
 *   4. quote 必须是某条引用消息的字面子串（MISSING_QUOTE / QUOTE_NOT_IN_SOURCE_MESSAGE）
 *   5. quote 所属消息确实属于目标窗口（第 2 步保证）
 *
 * @returns {{ok: true, evidence: Object} | {ok: false, reason: string}}
 */
function verifyGrowthEvidence(rawEvidence, msgMap, targetWindowNo) {
  const x = rawEvidence && typeof rawEvidence === 'object' ? rawEvidence : null;
  if (!x) return { ok: false, reason: 'INVALID_OBJECT' };
  const st = x.sourceType ? String(x.sourceType).trim().toUpperCase() : null;
  const ids = Array.isArray(x.messageIds)
    ? x.messageIds.filter(id => Number.isInteger(id) || (typeof id === 'string' && id.trim()))
    : [];

  if (st && PRIOR_SOURCE_TYPES.has(st) && ids.length > 0) {
    return { ok: false, reason: 'PRIOR_SOURCE_CANNOT_HAVE_MESSAGE_ID' };
  }

  if (!ids.length) return { ok: false, reason: 'MISSING_MESSAGE_ID' };
  const windowNo = Number.isInteger(targetWindowNo) ? targetWindowNo : null;
  const referenced = [];
  for (const rawId of ids) {
    const ref = checkMessageReference(String(rawId), msgMap, windowNo, { sourceType: st });
    if (!ref.ok) return { ok: false, reason: ref.reason };
    referenced.push(ref.message);
  }
  const quote = typeof x.quote === 'string' ? x.quote.trim() : '';
  if (!quote) return { ok: false, reason: 'MISSING_QUOTE' };
  let quoteOk = false;
  for (const msg of referenced) {
    const q = checkQuoteInMessage(quote, msg);
    if (q.ok) { quoteOk = true; break; }
  }
  if (!quoteOk) return { ok: false, reason: 'QUOTE_NOT_IN_SOURCE_MESSAGE' };
  const verifiedWindow = (typeof referenced[0].windowNo === 'number' && !Number.isNaN(referenced[0].windowNo))
    ? referenced[0].windowNo
    : (windowNo != null ? windowNo : (Number.isInteger(x.window) ? x.window : 0));
  return {
    ok: true,
    evidence: {
      sourceType: sourceType(x.sourceType),
      window: verifiedWindow,
      messageIds: ids.map(id => (Number.isInteger(id) ? id : String(id).trim())).slice(0, 20),
      quote: quote.slice(0, MAX_TEXT),
      at: Number.isFinite(x.at) ? x.at : 0,
      confidence: Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : 0.5,
      verification: 'VERIFIED'
    }
  };
}
/**
 * 计算假说反思/证伪压力与有效置信度 (Decision D-005 & Phase 0.5)
 * 核心原则：反向证据积累产生折扣压力，但历史支持证据永不物理删除。
 */
function calculateRevisionPressure(entry) {
  if (!entry) return { revisionPressure: 0, confidence: 0.5, counterEvidenceRatio: 0, supportWeight: 0, opposeWeight: 0 };
  const supportList = Array.isArray(entry.support) ? entry.support : [];
  const opposeList = Array.isArray(entry.oppose) ? entry.oppose : [];
  if (!supportList.length && !opposeList.length) {
    return { revisionPressure: 0, confidence: 0.5, counterEvidenceRatio: 0, supportWeight: 0, opposeWeight: 0 };
  }
  let supportWeight = 0;
  for (const s of supportList) supportWeight += (typeof s.confidence === 'number' ? s.confidence : 0.5);
  let opposeWeight = 0;
  for (const o of opposeList) opposeWeight += (typeof o.confidence === 'number' ? o.confidence : 0.5);
  const totalWeight = supportWeight + opposeWeight;
  const counterEvidenceRatio = totalWeight > 0 ? (opposeWeight / totalWeight) : 0;
  const revisionPressure = Number(counterEvidenceRatio.toFixed(4));
  // 基础置信度由支持证据权重决定，但受到反向证据比例的强阻尼折损，有界 [0.05, 1.0]
  const baseConfidence = totalWeight > 0 ? (supportWeight / totalWeight) : 0.5;
  const confidence = Number(Math.max(0.05, Math.min(1.0, baseConfidence * (1.0 - revisionPressure * 0.6))).toFixed(4));
  return {
    revisionPressure,
    confidence,
    counterEvidenceRatio,
    supportWeight: Number(supportWeight.toFixed(4)),
    opposeWeight: Number(opposeWeight.toFixed(4))
  };
}

function normalizeEntry(raw = {}, index = 0) {
  const at = Number.isFinite(raw.at) ? raw.at : Date.now();
  const window = Number.isInteger(raw.window) ? raw.window : 0;
  const support = normalizeEvidenceList(raw.support, at, window);
  const oppose = normalizeEvidenceList(raw.oppose, at, window);
  const trait = cleanText(raw.trait);
  const fallbackEvidence = cleanText(raw.evidence);
  if (!trait || (!support.length && !oppose.length && !fallbackEvidence)) return null;
  if (fallbackEvidence && !support.length && !oppose.length)
    support.push(evidence(fallbackEvidence, at, window));
  
  const entry = {
    id: cleanText(raw.id) || `growth-${at}-${index}`,
    at, window, trait, support, oppose,
    evidence: fallbackEvidence
  };
  if (raw.generation && typeof raw.generation === 'object') {
    entry.generation = { ...raw.generation };
  }
  const metrics = calculateRevisionPressure(entry);
  entry.revisionPressure = metrics.revisionPressure;
  entry.confidence = metrics.confidence;
  return entry;
}

class SelfLedger {
  constructor(dir, opts = {}) {
    this.path = path.join(dir, opts.filename || 'self-ledger.json');
    this.backupPath = this.path + '.bak';
    this.maxEntries = opts.maxEntries || 200;
    this.currentSelfTokenBudget = opts.currentSelfTokenBudget || 3000;
    this.entries = [];
    this.birthAt = null;
    this.status = { ok: true, recovered: false, error: null };
    this._preserveBackupPending = false;
    this.writer = new DeferredWriter(() => this._writeActual(), { delayMs: 3000 });
    this.load();
  }

  _writeActual() {
    if (!this._preserveBackupPending && fs.existsSync(this.path)) {
      try { fs.copyFileSync(this.path, this.backupPath); } catch { /* 原子写仍优先 */ }
    }
    this._preserveBackupPending = false;
    writeJsonAtomic(this.path, { version: SCHEMA_VERSION, birthAt: this.birthAt, entries: this.entries });
  }

  loadFile(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw) throw new Error('生命档案为空');
    const { data } = migrate(raw, SCHEMA_VERSION, {
      1: (d) => {
        if (Array.isArray(d)) return { version: 1, birthAt: null, entries: d };
        return d;
      },
      2: (d) => {
        return {
          version: 2,
          birthAt: Number.isFinite(d && d.birthAt) ? d.birthAt : null,
          entries: Array.isArray(d && d.entries) ? d.entries : (Array.isArray(d) ? d : [])
        };
      }
    }, { versionKey: 'version' });
    const list = Array.isArray(data) ? data : data && data.entries;
    if (!Array.isArray(list)) throw new Error('生命档案 entries 不是数组');
    this.birthAt = Number.isFinite(data && data.birthAt) ? data.birthAt : this.birthAt;
    return list.map(normalizeEntry).filter(Boolean);
  }

  load() {
    try {
      this.entries = this.loadFile(this.path);
      this.status = { ok: true, recovered: false, error: null };
      return;
    } catch (e) {
      // 不把损坏档案静默成空白人生；优先从上一份备份恢复。
      try {
        this.entries = this.loadFile(this.backupPath);
        this.status = { ok: true, recovered: true, error: e.message };
        this.save(true, true);
        return;
      } catch (backupError) {
        this.entries = [];
        if (e.code === 'ENOENT' && backupError.code === 'ENOENT') {
          this.status = { ok: true, recovered: false, error: null };
        } else {
          this.status = { ok: false, recovered: false, error: e.message + '; backup: ' + backupError.message };
        }
      }
    }
  }

  setBirthAt(at) {
    if (!this.status.ok) return this.birthAt || at;
    if (!this.birthAt) { this.birthAt = at; this.save(false, true); }
    return this.birthAt;
  }

  save(preserveBackup = false, immediate = false) {
    if (preserveBackup) this._preserveBackupPending = true;
    this.writer.markDirty();
    if (immediate) {
      this.flush();
    }
  }

  flush() {
    this.writer.flush();
  }

  /**
   * 追加成长条目。
   * meta.generation  — 绑定生成元数据（随条目持久化，绝不入 prompt）
   * meta.verify      — 事实核验上下文 { msgMap, windowNo }。
   *                    提供时，每个 support/oppose 证据都必须通过 provenance 原语核验，
   *                    非法证据被剥离，meta.rejected 收集拒绝原因；
   *                    无合法证据的条目被整条拒绝，绝不伪造。
   * meta.rejected    — 接收被拒绝条目/证据原因的可选数组
   */
  append(entries, meta = {}) {
    const at = Number.isFinite(meta.at) ? meta.at : Date.now();
    const window = Number.isInteger(meta.window) ? meta.window : 0;
    const rawList = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    const rejected = Array.isArray(meta.rejected) ? meta.rejected : [];

    const prepared = [];
    for (const x of rawList) {
      if (!meta.verify) {
        prepared.push({ ...x, at: (x && x.at) || at, window: (x && x.window !== undefined) ? x.window : window });
        continue;
      }
      const verifyWindow = Number.isInteger(meta.verify.windowNo) ? meta.verify.windowNo : window;
      const clean = { ...x, at: (x && x.at) || at, window: verifyWindow, support: [], oppose: [], evidence: '' };
      for (const [channel, list] of [['support', x && x.support], ['oppose', x && x.oppose]]) {
        const src = Array.isArray(list) ? list : (list ? [list] : []);
        for (const ev of src.slice(0, 4)) {
          const res = verifyGrowthEvidence(ev, meta.verify.msgMap, verifyWindow);
          if (res.ok) clean[channel].push(res.evidence);
          else rejected.push({ entry: cleanText(x && x.trait), channel, reason: res.reason, evidence: ev });
        }
      }
      if (!clean.support.length && !clean.oppose.length) {
        rejected.push({ entry: cleanText(x && x.trait), channel: 'entry', reason: 'NO_VERIFIABLE_EVIDENCE', evidence: null });
        continue;
      }
      prepared.push(clean);
    }

    const added = prepared
      .map((x, i) => {
        const entry = normalizeEntry(x, i);
        if (entry && meta.generation && typeof meta.generation === 'object') {
          entry.generation = { ...meta.generation };
        }
        return entry;
      })
      .filter(Boolean);
    if (!added.length) return 0;
    this.entries.push(...added);
    if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries);
    this.save(false, true);
    return added.length;
  }

  reset(at = Date.now()) {
    this.entries = [];
    this.birthAt = at;
    this.status = { ok: true, recovered: false, error: null };
    this.save(false, true);
    return this.birthAt;
  }

  recordOpposingEvidence(traitOrId, rawOpposingEvidence, meta = {}) {
    const at = Number.isFinite(meta.at) ? meta.at : Date.now();
    const window = Number.isInteger(meta.window) ? meta.window : 0;
    const cleanKey = cleanText(traitOrId);
    let target = this.entries.find(e => e.id === cleanKey || e.trait === cleanKey);
    if (!target) {
      target = normalizeEntry({
        trait: cleanKey,
        at,
        window,
        oppose: [rawOpposingEvidence]
      });
      if (target) {
        this.entries.push(target);
        if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries);
        this.save(false, true);
        return { created: true, entry: target, metrics: calculateRevisionPressure(target) };
      }
      return { created: false, error: 'INVALID_ENTRY' };
    }

    const normList = normalizeEvidenceList(rawOpposingEvidence, at, window);
    if (!normList.length) return { updated: false, reason: 'NO_VALID_EVIDENCE' };

    for (const ev of normList) {
      target.oppose.push(ev);
    }
    if (target.oppose.length > 10) {
      target.oppose = target.oppose.slice(-10);
    }
    const metrics = calculateRevisionPressure(target);
    target.revisionPressure = metrics.revisionPressure;
    target.confidence = metrics.confidence;
    this.save(false, true);
    return { updated: true, entry: target, metrics };
  }

  getEntryMetrics(traitOrId) {
    const cleanKey = cleanText(traitOrId);
    const target = this.entries.find(e => e.id === cleanKey || e.trait === cleanKey);
    if (!target) return null;
    return calculateRevisionPressure(target);
  }

  /** Current Self 是解释性投影，不是真相；优先保留最近证据，但带出反向证据与反思压力。 */
  currentSelfText() {
    if (!this.entries.length) return '';
    const budgetChars = this.currentSelfTokenBudget * 2;
    const chosen = [];
    let size = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const support = e.support.map(x => `${x.sourceType}: ${x.quote}`).filter(Boolean).join('；');
      const oppose = e.oppose.map(x => `${x.sourceType}: ${x.quote}`).filter(Boolean).join('；');
      const metrics = calculateRevisionPressure(e);
      let line = `- 倾向：${e.trait}。支持：${support || '无'}。反向：${oppose || '无'}`;
      if (metrics.revisionPressure >= 0.25) {
        line += `（反思压力: ${(metrics.revisionPressure * 100).toFixed(0)}%）`;
      }
      if (size + line.length > budgetChars && chosen.length) break;
      chosen.unshift(line); size += line.length;
    }
    return '【当前自我投影】（出生后的有限解释，不是不可推翻的真相）\n'
      + chosen.join('\n') + '\n如果新经历与它矛盾，应保留矛盾并重新理解，不要假装过去不存在。';
  }

  estimatedRawChars() {
    return JSON.stringify({ version: SCHEMA_VERSION, birthAt: this.birthAt, entries: this.entries }).length;
  }
  list() { return this.entries.map((e, i) => ({ index: i, ...e })); }
}

module.exports = { SelfLedger, normalizeEntry, calculateRevisionPressure, verifyGrowthEvidence, SOURCE_TYPES, SCHEMA_VERSION };
