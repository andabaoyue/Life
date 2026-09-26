const fs = require('fs');
const path = require('path');
const { wrapArchiveRecord, normalizeArchiveRecord } = require('./experience-schema');
const { validateArchiveRecord } = require('./archive-integrity');

/**
 * Append-Only 原始实验底座：experiences.jsonl
 * 
 * 核心哲学与工程原则：
 * 1. 只追加，永不静默修改，永不覆盖。
 * 2. 永不因 Token 超限或条目上限（maxEntries）被裁剪或删除。
 * 3. 完整保存 5x20 分段经历、Window Synthesis、用户给予、初澜经历与 Provenance 证据。
 * 4. 与模型 Prompt 消费层解耦：Prompt 记忆可以分层压缩，但原始底座永久留存以备实验 Replay 与离线分析。
 */
class ExperiencesArchive {
  constructor(userDataDir, opts = {}) {
    this.dir = userDataDir;
    this.path = path.join(userDataDir, 'experiences.jsonl');
    this.opts = opts;
  }

  /**
   * 追加一条归档记录（JSON 行）。
   */
  append(record) {
    if (!record || typeof record !== 'object') return false;
    const entry = { ...record };
    if (!entry.timestamp && !entry.createdAt) {
      entry.createdAt = Date.now();
    }
    const line = JSON.stringify(entry) + '\n';
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      fs.appendFileSync(this.path, line, 'utf8');
      return true;
    } catch (e) {
      console.error('[ExperiencesArchive] append failed:', e.message);
      return false;
    }
  }

  /**
   * 追加标准封装记录 (v0.9.4 EOI 规范)
   */
  appendRecord(recordType, windowNo, payload = {}) {
    const wrapped = wrapArchiveRecord(recordType, windowNo, payload);
    return this.append(wrapped);
  }

  /**
   * 检查指定窗口是否已存在可靠完成的 window_archive 记录 (支持 Canonical v1 与 Legacy)
   * 严格区分「可靠完成归档」与「存在异常/损坏/伪造记录」。
   * 坏记录或非法记录绝不能永久阻塞合法归档写入。
   */
  hasWindowArchive(windowNo) {
    if (typeof windowNo !== 'number' || Number.isNaN(windowNo)) return false;
    const records = this.readAll();
    return records.some(r => {
      const type = r.recordType || r.type;
      if (type !== 'window_archive') return false;
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
   * 归档一个完整窗口的结构化经历与小结 (P0-1: 生产环境直接使用 Canonical Schema v1)
   * P0-2: Exactly-Once 幂等保证，防止同一 windowNo 被重复归档
   */
  appendWindowArchive(data, opts = {}) {
    if (!data || typeof data !== 'object') return false;
    const windowNo = (typeof data.windowNo === 'number' && !Number.isNaN(data.windowNo))
      ? data.windowNo
      : (data.windowNo === null ? null : (data.windowNo !== undefined ? data.windowNo : null));

    if (windowNo !== null && !opts.allowDuplicate && this.hasWindowArchive(windowNo)) {
      console.warn(`[ExperiencesArchive] 窗口 #${windowNo} 已存在 window_archive 记录，跳过重复写入以保证 Exactly-Once 语义`);
      return true;
    }

    const payload = {
      archiveId: typeof data.archiveId === 'string' && data.archiveId ? data.archiveId : (`arch-w${windowNo}-${Date.now()}`),
      windowId: typeof data.windowId === 'string' && data.windowId ? data.windowId : (`win-${windowNo}`),
      windowNo,
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

    return this.appendRecord('window_archive', windowNo, payload);
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
