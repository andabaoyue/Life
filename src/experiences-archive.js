const fs = require('fs');
const path = require('path');
const { wrapArchiveRecord, normalizeArchiveRecord } = require('./experience-schema');
const { validateArchiveRecord, computeCanonicalRecordHash } = require('./archive-integrity');

/**
 * Append-Only 原始实验底座：experiences.jsonl (v0.9.6)
 * 
 * 核心哲学与工程原则：
 * 1. 只追加，永不静默修改，永不覆盖。
 * 2. 永不因 Token 超限或条目上限（maxEntries）被裁剪或删除。
 * 3. 完整保存 5x20 分段经历、Window Synthesis、用户给予、初澜经历与 Provenance 证据。
 * 4. 严谨因果链：每一条记录具备单调递增 archiveSeq 与 SHA-256 防篡改哈希链（prevHash -> recordHash）。
 * 5. 严格持久化：每次 append 同步执行 fsync，保障落盘语义。
 */
class ExperiencesArchive {
  constructor(userDataDir, opts = {}) {
    this.dir = userDataDir;
    this.path = path.join(userDataDir, 'experiences.jsonl');
    this.opts = opts;
  }

  /**
   * 获取最近一条已编序的归档记录 (用于衔接 hash chain 与递增 archiveSeq)
   */
  getLastSequencedRecord() {
    const records = this.readAll();
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r && typeof r.archiveSeq === 'number' && !Number.isNaN(r.archiveSeq) && r.recordHash) {
        return r;
      }
    }
    return null;
  }

  /**
   * 追加一条归档记录（JSON 行）。具备 fsync 持久化保障与因果哈希链。
   */
  append(record) {
    if (!record || typeof record !== 'object') return false;

    const last = this.getLastSequencedRecord();
    const defaultSeq = last ? last.archiveSeq + 1 : 1;
    const defaultRecordId = `rec-${String(defaultSeq).padStart(6, '0')}`;
    const defaultPrevHash = last ? last.recordHash : 'GENESIS';

    const entry = {
      ...record,
      schemaVersion: record.schemaVersion || 1,
      recordType: record.recordType || record.type || 'window_summary',
      recordId: record.recordId || defaultRecordId,
      archiveSeq: typeof record.archiveSeq === 'number' ? record.archiveSeq : defaultSeq,
      timestamp: (typeof record.timestamp === 'number' && !isNaN(record.timestamp))
        ? record.timestamp
        : ((typeof record.createdAt === 'number' && !isNaN(record.createdAt)) ? record.createdAt : Date.now()),
      windowNo: (typeof record.windowNo === 'number' && !isNaN(record.windowNo))
        ? record.windowNo
        : (record.windowNo === null ? null : (record.payload && typeof record.payload.windowNo === 'number' ? record.payload.windowNo : null)),
      payload: record.payload !== undefined ? record.payload : {},
      prevHash: record.prevHash !== undefined ? record.prevHash : defaultPrevHash
    };

    if (!entry.createdAt) entry.createdAt = entry.timestamp;
    if (!entry.recordHash) {
      entry.recordHash = computeCanonicalRecordHash(entry);
    }

    const line = JSON.stringify(entry) + '\n';
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      const fd = fs.openSync(this.path, 'a');
      try {
        fs.writeSync(fd, line, null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (e) {
      console.error('[ExperiencesArchive] append failed:', e.message);
      return false;
    }
  }

  /**
   * 追加标准封装记录 (v0.9.6 Canonical 规范)
   */
  appendRecord(recordType, windowNo, payload = {}, extra = {}) {
    const last = this.getLastSequencedRecord();
    const archiveSeq = typeof extra.archiveSeq === 'number' ? extra.archiveSeq : (last ? last.archiveSeq + 1 : 1);
    const recordId = extra.recordId || `rec-${String(archiveSeq).padStart(6, '0')}`;
    const prevHash = extra.prevHash || (last ? last.recordHash : 'GENESIS');

    const wrapped = wrapArchiveRecord(recordType, windowNo, payload, {
      archiveSeq,
      recordId,
      prevHash,
      timestamp: extra.timestamp
    });
    wrapped.recordHash = computeCanonicalRecordHash(wrapped);
    // 兼容根据 type 或 recordType 检索旧记录的用例
    if (recordType === 'window_summary' || recordType === 'window_archive') {
      wrapped.type = 'window_archive';
    }
    return this.append(wrapped);
  }

  /**
   * 检查指定窗口是否已存在可靠完成的 window_summary / window_archive 记录
   */
  hasWindowArchive(windowNo) {
    if (typeof windowNo !== 'number' || Number.isNaN(windowNo)) return false;
    const records = this.readAll();
    return records.some(r => {
      const type = r.recordType || r.type;
      if (type !== 'window_archive' && type !== 'window_summary') return false;
      const wNo = (typeof r.windowNo === 'number' && !Number.isNaN(r.windowNo))
        ? r.windowNo
        : (r.payload && typeof r.payload.windowNo === 'number' && !Number.isNaN(r.payload.windowNo) ? r.payload.windowNo : null);
      if (wNo !== windowNo) return false;

      // 若声明了 recordType 但 payload 为 null 或非对象，属于半截/损坏记录，不能作为有效完成态
      if (r.recordType && (!r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload))) {
        return false;
      }

      // 验证是否为可靠完成的有效归档
      const norm = normalizeArchiveRecord(r);
      if (!norm) return false;
      const vResult = validateArchiveRecord(norm, { allowLegacy: true });
      if (!vResult.valid) return false;

      // 完成态检查：必须具备实际归档内容（events, windowSynthesis 或 rawSummaryText）
      const p = norm.payload || norm;
      const hasContent = (Array.isArray(p.events) && p.events.length > 0) ||
                         (p.windowSynthesis && typeof p.windowSynthesis === 'object' && Object.keys(p.windowSynthesis).length > 0) ||
                         (typeof p.rawSummaryText === 'string' && p.rawSummaryText.trim().length > 0);
      return Boolean(hasContent);
    });
  }

  /**
   * 归档一个完整窗口的结构化经历与小结 (v0.9.6 Canonical Schema v1)
   */
  appendWindowArchive(data, opts = {}) {
    if (!data || typeof data !== 'object') return false;
    const windowNo = (typeof data.windowNo === 'number' && !Number.isNaN(data.windowNo))
      ? data.windowNo
      : (data.windowNo === null ? null : (data.windowNo !== undefined ? data.windowNo : null));

    if (windowNo !== null && !opts.allowDuplicate && this.hasWindowArchive(windowNo)) {
      console.warn(`[ExperiencesArchive] 窗口 #${windowNo} 已存在 window_summary 记录，跳过重复写入以保证 Exactly-Once 语义`);
      return true;
    }

    const payload = {
      archiveId: typeof data.archiveId === 'string' && data.archiveId ? data.archiveId : (`arch-w${windowNo}-${Date.now()}`),
      windowId: typeof data.windowId === 'string' && data.windowId ? data.windowId : (`win-${windowNo}`),
      windowNo,
      targetTurnCount: typeof data.targetTurnCount === 'number' ? data.targetTurnCount : 100,
      actualTurnCount: (typeof data.actualTurnCount === 'number' && !isNaN(data.actualTurnCount)) ? data.actualTurnCount : ((typeof data.turns === 'number' && !isNaN(data.turns)) ? data.turns : 0),
      closeReason: data.closeReason || 'turn_limit',
      turns: (typeof data.turns === 'number' && !isNaN(data.turns)) ? data.turns : 0,
      messageCount: (typeof data.messageCount === 'number' && !isNaN(data.messageCount)) ? data.messageCount : 0,
      events: Array.isArray(data.events) ? data.events : [],
      observations: Array.isArray(data.observations) ? data.observations : [],
      interpretations: Array.isArray(data.interpretations) ? data.interpretations : [],
      segments: Array.isArray(data.segments) ? data.segments : [],
      windowSynthesis: (data.windowSynthesis && typeof data.windowSynthesis === 'object') ? data.windowSynthesis : {},
      stateEvidence: Array.isArray(data.stateEvidence) ? data.stateEvidence : [],
      verifiedEvidence: Array.isArray(data.verifiedEvidence) ? data.verifiedEvidence : [],
      rejectedEvidence: Array.isArray(data.rejectedEvidence) ? data.rejectedEvidence : [],
      stateChanges: Array.isArray(data.stateChanges) ? data.stateChanges : [],
      explanations: Array.isArray(data.explanations) ? data.explanations : [],
      rawSummaryText: typeof data.rawSummaryText === 'string' ? data.rawSummaryText : ''
    };

    return this.appendRecord('window_summary', windowNo, payload);
  }

  /**
   * 追加 Current Self 投影变更记录 (v0.9.6 P0-12)
   */
  appendSelfProjection(data = {}) {
    const windowNo = typeof data.windowNo === 'number' ? data.windowNo : null;
    const payload = {
      projectionVersion: data.projectionVersion || '1.0',
      sourceExperienceRecords: Array.isArray(data.sourceExperienceRecords) ? data.sourceExperienceRecords : [],
      sourceStateChanges: Array.isArray(data.sourceStateChanges) ? data.sourceStateChanges : [],
      entriesAdded: typeof data.entriesAdded === 'number' ? data.entriesAdded : 0,
      result: data.result || {},
      timestamp: Date.now()
    };
    return this.appendRecord('self_projection', windowNo, payload);
  }

  /**
   * 读取全部归档记录（容错跳过损坏行）
   */
  readAll() {
    const res = this.readAllWithDiagnostics();
    return res.records;
  }

  /**
   * 带诊断信息的全量读取（用于健康检查、故障排查与审计）
   */
  readAllWithDiagnostics() {
    if (!fs.existsSync(this.path)) {
      return {
        records: [],
        diagnostics: {
          totalLines: 0,
          validCount: 0,
          skippedCount: 0,
          errors: []
        }
      };
    }
    try {
      const content = fs.readFileSync(this.path, 'utf8');
      const lines = content.split('\n');
      const records = [];
      const errors = [];
      let totalNonEmpty = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        totalNonEmpty++;
        try {
          const parsed = JSON.parse(line);
          records.push(parsed);
        } catch (err) {
          errors.push({
            lineNumber: i + 1,
            snippet: line.slice(0, 120),
            error: err.message
          });
        }
      }

      return {
        records,
        diagnostics: {
          totalLines: totalNonEmpty,
          validCount: records.length,
          skippedCount: errors.length,
          errors
        }
      };
    } catch (e) {
      return {
        records: [],
        diagnostics: {
          totalLines: 0,
          validCount: 0,
          skippedCount: 0,
          errors: [{ lineNumber: 0, snippet: '', error: e.message }]
        }
      };
    }
  }

  /**
   * 获取指定窗口的所有归档记录
   */
  getByWindow(windowNo) {
    return this.readAll().filter(r => r.windowNo === windowNo);
  }

  /**
   * 归档记录总行数
   */
  count() {
    return this.readAll().length;
  }

  /**
   * 清空（仅用于隔离测试或极端调试）
   */
  clear() {
    try {
      if (fs.existsSync(this.path)) {
        fs.unlinkSync(this.path);
      }
      return true;
    } catch {
      return false;
    }
  }

  flush() {
    // 同步 appendFileSync 写入已保障持久性
  }
}

module.exports = { ExperiencesArchive };
