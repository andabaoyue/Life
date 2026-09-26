const fs = require('fs');
const path = require('path');
const { wrapArchiveRecord } = require('./experience-schema');

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
    const entry = {
      ...record,
      createdAt: record.createdAt || Date.now()
    };
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
   * 归档一个完整窗口的结构化经历与小结
   */
  appendWindowArchive(data) {
    return this.append({
      type: 'window_archive',
      summaryVersion: '1.0',
      windowNo: data.windowNo,
      turns: data.turns || 0,
      messageCount: data.messageCount || 0,
      events: data.events || [],
      observations: data.observations || [],
      interpretations: data.interpretations || [],
      segments: data.segments || [],
      windowSynthesis: data.windowSynthesis || {},
      stateEvidence: data.stateEvidence || [],
      verifiedEvidence: data.verifiedEvidence || [],
      rejectedEvidence: data.rejectedEvidence || [],
      stateChanges: data.stateChanges || [],
      explanations: data.explanations || [],
      rawSummaryText: data.rawSummaryText || ''
    });
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
