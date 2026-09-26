/**
 * src/research-index.js
 * 
 * 初澜数字生命实验：Research Archive 内存字节偏移量索引 (v0.9.5 / P1-06)
 * 
 * 核心规范与设计原则：
 * 1. 纯内存只读索引，绝不向 experiences.jsonl 写入任何数据。
 * 2. 避免大文件重复全量扫描：一次单遍扫描建立 ID -> { byteOffset, length, windowNo } 映射。
 * 3. 支持 eventId, observationId, interpretationId, evidenceId, stateChangeId, messageId, windowNo 高速检索。
 * 4. 自动一致性检测：基于 file size 与 mtimeMs 判定过期，检测到文件变更自动废弃旧索引并全内存重建。
 * 5. 准确定位：利用 fs.readSync 在目标 byteOffset 处精准读取单条 JSONL 记录。
 */

const fs = require('fs');

function extractRecordWindowNo(record) {
  if (!record || typeof record !== 'object') return null;
  const p = record.payload || record;
  if (typeof record.windowNo === 'number' && !isNaN(record.windowNo)) return record.windowNo;
  if (typeof p.windowNo === 'number' && !isNaN(p.windowNo)) return p.windowNo;
  if (typeof record.window === 'number' && !isNaN(record.window)) return record.window;
  if (typeof p.window === 'number' && !isNaN(p.window)) return p.window;
  return null;
}

class ResearchIndex {
  constructor(archiveFilePath) {
    this.archivePath = archiveFilePath;
    this.fileStats = null;
    this.indexValid = false;
    this.rebuildCount = 0;

    // 内存索引结构
    this.lineEntries = [];           // 行条目清单
    this.eventIndex = new Map();      // eventId -> descriptor
    this.obsIndex = new Map();        // observationId -> descriptor
    this.interpIndex = new Map();     // interpretationId -> descriptor
    this.evidenceIndex = new Map();   // evidenceId -> descriptor
    this.stateChangeIndex = new Map();// stateChangeId -> descriptor
    this.messageIndex = new Map();    // messageId -> descriptor[]
    this.windowIndex = new Map();     // windowNo -> descriptor[]
    this.unknownWindowDescriptors = []; // windowNo === null -> descriptor[]
    this.allIdsIndex = new Map();     // generic id -> descriptor
  }

  /**
   * 检查索引与磁盘文件的有效性
   */
  checkValidity() {
    if (!this.indexValid || !this.fileStats) return false;
    if (!fs.existsSync(this.archivePath)) {
      return this.fileStats.size === 0;
    }
    try {
      const st = fs.statSync(this.archivePath);
      return st.size === this.fileStats.size && st.mtimeMs === this.fileStats.mtimeMs;
    } catch {
      return false;
    }
  }

  /**
   * 显式使索引失效
   */
  invalidate() {
    this.indexValid = false;
    this.fileStats = null;
    this.lineEntries = [];
    this.eventIndex.clear();
    this.obsIndex.clear();
    this.interpIndex.clear();
    this.evidenceIndex.clear();
    this.stateChangeIndex.clear();
    this.messageIndex.clear();
    this.windowIndex.clear();
    this.unknownWindowDescriptors = [];
    this.allIdsIndex.clear();
  }

  /**
   * 确保索引有效，如过期或未初始化则自动全量重建
   */
  ensureIndex() {
    if (this.checkValidity()) {
      return true;
    }
    return this.rebuild();
  }

  /**
   * 全内存重建索引 (只读扫描)
   */
  rebuild() {
    this.invalidate();
    this.rebuildCount++;

    if (!fs.existsSync(this.archivePath)) {
      this.fileStats = { size: 0, mtimeMs: 0 };
      this.indexValid = true;
      return true;
    }

    try {
      const st = fs.statSync(this.archivePath);
      const buf = fs.readFileSync(this.archivePath);
      let offset = 0;
      let lineNum = 0;

      while (offset < buf.length) {
        lineNum++;
        let nextNewline = buf.indexOf(0x0a, offset);
        let lineEnd = nextNewline === -1 ? buf.length : nextNewline;
        let lineLen = lineEnd - offset;

        // 处理 CRLF 中的 CR
        let effectiveLen = lineLen;
        if (effectiveLen > 0 && buf[offset + effectiveLen - 1] === 0x0d) {
          effectiveLen--;
        }

        const lineOffset = offset;
        offset = nextNewline === -1 ? buf.length : nextNewline + 1;

        if (effectiveLen <= 0) {
          continue;
        }

        const lineStr = buf.toString('utf8', lineOffset, lineOffset + effectiveLen).trim();
        if (!lineStr) continue;

        let parsed = null;
        let valid = false;
        try {
          parsed = JSON.parse(lineStr);
          valid = true;
        } catch {
          valid = false;
        }

        const entry = {
          lineNumber: lineNum,
          byteOffset: lineOffset,
          byteLength: effectiveLen,
          valid,
          recordType: null,
          windowNo: null,
          snippet: lineStr.slice(0, 100)
        };

        if (valid && parsed && typeof parsed === 'object') {
          const recType = parsed.recordType || parsed.type || (parsed.payload && parsed.payload.type) || 'unknown';
          const windowNo = extractRecordWindowNo(parsed);
          entry.recordType = recType;
          entry.windowNo = windowNo;

          const desc = {
            lineNumber: lineNum,
            byteOffset: lineOffset,
            byteLength: effectiveLen,
            recordType: recType,
            windowNo,
            payload: parsed.payload || parsed
          };

          // 记录至 window 映射：严格区分 knownWindowIndex 与 unknownWindowDescriptors (绝不把 null 映射为 1)
          if (windowNo === null) {
            this.unknownWindowDescriptors.push(desc);
          } else {
            if (!this.windowIndex.has(windowNo)) {
              this.windowIndex.set(windowNo, []);
            }
            this.windowIndex.get(windowNo).push(desc);
          }

          // 1. 递归提取并索引 Window Archive / Window Summary 内部复合单元
          this._indexRecordContent(parsed, desc);
        }

        this.lineEntries.push(entry);
      }

      this.fileStats = { size: st.size, mtimeMs: st.mtimeMs };
      this.indexValid = true;
      return true;
    } catch (e) {
      console.error('[ResearchIndex] 索引重建失败:', e.message);
      this.invalidate();
      return false;
    }
  }

  /**
   * 递归建立内部实体 ID 索引
   */
  _indexRecordContent(record, baseDesc) {
    const payload = record.payload || record;
    const windowNo = baseDesc.windowNo;

    // Helper: 绑定单一 ID
    const registerId = (id, map, extra = {}) => {
      if (!id || typeof id !== 'string') return;
      const cleanId = id.trim();
      if (!cleanId) return;
      const itemDesc = {
        id: cleanId,
        byteOffset: baseDesc.byteOffset,
        byteLength: baseDesc.byteLength,
        lineNumber: baseDesc.lineNumber,
        windowNo,
        recordType: baseDesc.recordType,
        ...extra
      };
      map.set(cleanId, itemDesc);
      this.allIdsIndex.set(cleanId, itemDesc);
    };

    // Helper: 绑定消息映射 (一消息可出现于多处)
    const registerMessage = (msgId, extra = {}) => {
      if (!msgId || typeof msgId !== 'string') return;
      const cleanId = msgId.trim();
      if (!cleanId) return;
      const itemDesc = {
        messageId: cleanId,
        byteOffset: baseDesc.byteOffset,
        byteLength: baseDesc.byteLength,
        lineNumber: baseDesc.lineNumber,
        windowNo,
        ...extra
      };
      if (!this.messageIndex.has(cleanId)) {
        this.messageIndex.set(cleanId, []);
      }
      this.messageIndex.get(cleanId).push(itemDesc);
      this.allIdsIndex.set(cleanId, itemDesc);
    };

    // 1. 直接顶层 ID 检查
    if (record.eventId || payload.eventId) registerId(record.eventId || payload.eventId, this.eventIndex, { type: 'event' });
    if (record.observationId || payload.observationId) registerId(record.observationId || payload.observationId, this.obsIndex, { type: 'observation' });
    if (record.interpretationId || payload.interpretationId) registerId(record.interpretationId || payload.interpretationId, this.interpIndex, { type: 'interpretation' });
    if (record.evidenceId || payload.evidenceId) registerId(record.evidenceId || payload.evidenceId, this.evidenceIndex, { type: 'evidence', status: payload.status });
    if (record.stateChangeId || payload.stateChangeId) registerId(record.stateChangeId || payload.stateChangeId, this.stateChangeIndex, { type: 'state_change' });
    if (record.changeId || payload.changeId) registerId(record.changeId || payload.changeId, this.stateChangeIndex, { type: 'state_change' });
    if (record.messageId || payload.messageId) registerMessage(record.messageId || payload.messageId);

    // 2. 复合 Window Archive / Window Summary 解析
    // 2.1 Events
    const events = Array.isArray(payload.events) ? payload.events : (Array.isArray(record.events) ? record.events : []);
    for (const evt of events) {
      if (evt && evt.eventId) {
        registerId(evt.eventId, this.eventIndex, { type: 'event', eventType: evt.type, source: evt.source });
        if (evt.messageId) registerMessage(evt.messageId, { eventId: evt.eventId });
      }
    }

    // 2.2 Observations
    const observations = Array.isArray(payload.observations) ? payload.observations : (Array.isArray(record.observations) ? record.observations : []);
    for (const obs of observations) {
      if (obs && obs.observationId) {
        registerId(obs.observationId, this.obsIndex, { type: 'observation', eventIds: obs.eventIds });
      }
    }

    // 2.3 Interpretations
    const interpretations = Array.isArray(payload.interpretations) ? payload.interpretations : (Array.isArray(record.interpretations) ? record.interpretations : []);
    for (const interp of interpretations) {
      if (interp && interp.interpretationId) {
        registerId(interp.interpretationId, this.interpIndex, { type: 'interpretation', observationIds: interp.observationIds });
      }
    }

    // 2.4 Verified Evidence
    const verified = Array.isArray(payload.verifiedEvidence) ? payload.verifiedEvidence : (Array.isArray(record.verifiedEvidence) ? record.verifiedEvidence : []);
    for (const ev of verified) {
      if (ev && ev.evidenceId) {
        registerId(ev.evidenceId, this.evidenceIndex, {
          type: 'evidence',
          status: 'verified',
          trait: ev.trait,
          direction: ev.direction,
          strength: ev.strength,
          messageId: ev.messageId
        });
        if (ev.messageId) registerMessage(ev.messageId, { evidenceId: ev.evidenceId });
      }
    }

    // 2.5 Rejected Evidence
    const rejected = Array.isArray(payload.rejectedEvidence) ? payload.rejectedEvidence : (Array.isArray(record.rejectedEvidence) ? record.rejectedEvidence : []);
    for (const ev of rejected) {
      if (ev && ev.evidenceId) {
        registerId(ev.evidenceId, this.evidenceIndex, {
          type: 'evidence',
          status: 'rejected',
          reason: ev.reason,
          trait: ev.trait,
          messageId: ev.messageId
        });
        if (ev.messageId) registerMessage(ev.messageId, { evidenceId: ev.evidenceId });
      }
    }

    // 2.6 StateChanges
    const stateChanges = Array.isArray(payload.stateChanges) ? payload.stateChanges : (Array.isArray(record.stateChanges) ? record.stateChanges : []);
    for (const sc of stateChanges) {
      const scId = sc.stateChangeId || sc.changeId;
      if (scId) {
        registerId(scId, this.stateChangeIndex, {
          type: 'state_change',
          trait: sc.trait,
          delta: sc.delta,
          evidenceIds: sc.evidenceIds
        });
      }
    }
  }

  /**
   * 精确从指定 byteOffset 与 byteLength 读取并解析 JSON 记录
   */
  readRecordAtOffset(byteOffset, byteLength) {
    if (!fs.existsSync(this.archivePath)) return null;
    let fd = null;
    try {
      fd = fs.openSync(this.archivePath, 'r');
      const buf = Buffer.alloc(byteLength);
      const bytesRead = fs.readSync(fd, buf, 0, byteLength, byteOffset);
      if (bytesRead < byteLength) {
        return null;
      }
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.error('[ResearchIndex] readRecordAtOffset error:', e.message);
      return null;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  /**
   * 按 ID 检索并读取目标归档记录
   */
  getRecordById(id) {
    this.ensureIndex();
    const desc = this.allIdsIndex.get(id);
    if (!desc) return null;
    return this.readRecordAtOffset(desc.byteOffset, desc.byteLength);
  }

  /**
   * 获取 ID 对应的偏移量描述符
   */
  getDescriptorById(id) {
    this.ensureIndex();
    return this.allIdsIndex.get(id) || null;
  }

  /**
   * 获取指定 Window 的所有记录条目
   * 严格禁止将 unknown window 映射到 key=1
   */
  getWindowDescriptors(windowNo) {
    this.ensureIndex();
    if (windowNo === null || windowNo === undefined) {
      return this.unknownWindowDescriptors;
    }
    return this.windowIndex.get(windowNo) || [];
  }

  /**
   * 获取所有被索引的统计数据
   */
  getStats() {
    this.ensureIndex();
    return {
      archivePath: this.archivePath,
      valid: this.indexValid,
      rebuildCount: this.rebuildCount,
      totalLines: this.lineEntries.length,
      eventCount: this.eventIndex.size,
      observationCount: this.obsIndex.size,
      interpretationCount: this.interpIndex.size,
      evidenceCount: this.evidenceIndex.size,
      stateChangeCount: this.stateChangeIndex.size,
      messageCount: this.messageIndex.size,
      windowCount: this.windowIndex.size,
      unknownWindowCount: this.unknownWindowDescriptors.length
    };
  }
}

module.exports = { ResearchIndex };
