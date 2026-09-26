const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { DeferredWriter } = require('./deferred-writer');
const { migrate } = require('./migration');

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
    return { sourceType: 'MODEL_INTERPRETATION', window: fallbackWindow, messageIds: [], quote: cleanText(raw), at: fallbackAt, confidence: 0.5 };
  }
  const x = raw || {};
  return {
    sourceType: sourceType(x.sourceType),
    window: Number.isInteger(x.window) ? x.window : fallbackWindow,
    messageIds: Array.isArray(x.messageIds) ? x.messageIds.filter(Number.isInteger).slice(0, 20) : [],
    quote: cleanText(x.quote || x.text),
    at: Number.isFinite(x.at) ? x.at : fallbackAt,
    confidence: Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : 0.5
  };
}
function normalizeEvidenceList(raw, at, window) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map(x => evidence(x, at, window)).filter(x => x.quote || x.sourceType === 'PROGRAM_OBSERVATION').slice(0, 4);
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

  append(entries, meta = {}) {
    const at = Number.isFinite(meta.at) ? meta.at : Date.now();
    const window = Number.isInteger(meta.window) ? meta.window : 0;
    const added = (Array.isArray(entries) ? entries : [entries])
      .map((x, i) => normalizeEntry({ ...x, at: x && x.at || at,
        window: x && x.window !== undefined ? x.window : window }, i))
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

module.exports = { SelfLedger, normalizeEntry, calculateRevisionPressure, SOURCE_TYPES, SCHEMA_VERSION };
