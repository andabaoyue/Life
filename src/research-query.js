/**
 * src/research-query.js
 * 
 * 初澜数字生命实验：Research Query 只读查询与溯源追踪引擎 (v0.9.5 / P1-01, P1-02, P1-03)
 * 
 * 核心规范与设计原则：
 * 1. 严格只读，绝不修改 experiences.jsonl, subject-state.json 或 memory.json。
 * 2. 分页支持：所有列表查询默认支持 offset 与 limit，禁止一次性把数万条记录直接塞给 Renderer。
 * 3. 完整实现四大观测支柱：
 *    - P1-01: Subject State 面板数据 (5 特质, [-999, 999], current vs previous, latest delta, 演化轨迹)
 *    - P1-02: 100 轮 Window Explorer (5x20 分段, Bridge 与 Active 强隔离)
 *    - P1-03: Provenance 溯源 (StateChange -> Evidence -> Message -> Quote)
 *    - EOI 事实三层追溯 (Interpretation -> Observation -> Event -> Message)
 * 4. 版本兼容：无缝向下兼容 v0.9.3 与 v0.9.4 归档记录，缺失字段如实标记 Legacy/Unknown。
 */

const fs = require('fs');
const path = require('path');
const { ALLOWED_TRAITS, DEFAULT_TRAITS } = require('./subject-state');
const { normalizeArchiveRecord } = require('./experience-schema');
const { ArchiveIntegrityService } = require('./archive-integrity');

const NON_STATE_RECORD_TYPES = new Set([
  'recovery_event',
  'diagnostic',
  'replay_report',
  'internal_log',
  'audit_log'
]);

function getRecordWindowNo(rec) {
  if (!rec) return null;
  const p = rec.payload || rec;
  if (typeof rec.windowNo === 'number' && !isNaN(rec.windowNo)) return rec.windowNo;
  if (typeof p.windowNo === 'number' && !isNaN(p.windowNo)) return p.windowNo;
  if (typeof rec.window === 'number' && !isNaN(rec.window)) return rec.window;
  if (typeof p.window === 'number' && !isNaN(p.window)) return p.window;
  return null;
}

class ResearchQuery {
  constructor(userDataDir, options = {}) {
    this.dir = userDataDir;
    this.archivePath = path.join(userDataDir, 'experiences.jsonl');
    this.statePath = path.join(userDataDir, 'subject-state.json');
    this.memoryPath = path.join(userDataDir, 'memory.json');
    this.index = options.index || null;
    this._lastQueryMode = 'FULL_SCAN';
    this._integrityCache = null;
  }

  setIndex(index) {
    this.index = index;
  }

  invalidateCache() {
    this._integrityCache = null;
  }

  // ---------------------------------------------------------------------------
  // 辅助方法：完整性快照缓存 (H-04 性能优化)
  // 避免在 Window 循环或高频查询中对同一无变化的归档文件重复执行 O(N) 全量哈希与格式校验
  // ---------------------------------------------------------------------------
  _getIntegritySnapshot() {
    if (!fs.existsSync(this.archivePath)) {
      return ArchiveIntegrityService.checkArchive(this.archivePath);
    }

    try {
      const stat = fs.statSync(this.archivePath);
      const cacheKey = `${stat.size}-${stat.mtimeMs}`;
      if (this._integrityCache && this._integrityCache.key === cacheKey) {
        return this._integrityCache.report;
      }

      const report = ArchiveIntegrityService.checkArchive(this.archivePath);
      this._integrityCache = {
        key: cacheKey,
        report
      };
      return report;
    } catch {
      return ArchiveIntegrityService.checkArchive(this.archivePath);
    }
  }

  // ---------------------------------------------------------------------------
  // 辅助方法：读取归档记录 (P1-03: 优先经由 Index 检索)
  // ---------------------------------------------------------------------------
  _readArchiveRecords() {
    if (this.index && this.index.ensureIndex()) {
      this._lastQueryMode = 'INDEX';
      const records = [];
      for (const entry of this.index.lineEntries) {
        if (entry.valid) {
          const rec = this.index.readRecordAtOffset(entry.byteOffset, entry.byteLength);
          if (rec) {
            const norm = normalizeArchiveRecord(rec);
            if (norm) records.push(norm);
          }
        }
      }
      return records;
    }

    this._lastQueryMode = 'FULL_SCAN';
    if (!fs.existsSync(this.archivePath)) return [];
    try {
      const content = fs.readFileSync(this.archivePath, 'utf8');
      const lines = content.split('\n');
      const records = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const norm = normalizeArchiveRecord(parsed);
          if (norm) records.push(norm);
        } catch {
          // 容错忽略已损坏行（损坏信息在 diagnostics/replay 中报告）
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  _readSubjectState() {
    if (!fs.existsSync(this.statePath)) {
      return {
        values: { ...DEFAULT_TRAITS },
        windowNo: 1,
        history: [],
        stateChanges: [],
        recoveryStatus: 'NORMAL'
      };
    }
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return {
        values: { ...DEFAULT_TRAITS },
        windowNo: 1,
        history: [],
        stateChanges: [],
        recoveryStatus: 'CORRUPTED'
      };
    }
  }

  // ---------------------------------------------------------------------------
  // P1-01: Subject State 面板数据查询
  // ---------------------------------------------------------------------------
  getSubjectState() {
    const stateData = this._readSubjectState();
    const currentValues = { ...DEFAULT_TRAITS, ...(stateData.values || {}) };
    const history = Array.isArray(stateData.history) ? stateData.history : [];
    const stateChanges = Array.isArray(stateData.stateChanges) ? stateData.stateChanges : [];

    // 从 history 与 stateChanges 计算前一状态与最新增量
    const previousValues = { ...currentValues };
    const latestDeltas = {};
    const latestStateChanges = {};

    for (const trait of ALLOWED_TRAITS) {
      latestDeltas[trait] = 0;
      latestStateChanges[trait] = null;
    }

    // 逆序查找各 trait 最新的变更记录
    for (let i = stateChanges.length - 1; i >= 0; i--) {
      const sc = stateChanges[i];
      if (sc && sc.trait && latestStateChanges[sc.trait] === null) {
        latestStateChanges[sc.trait] = sc.stateChangeId || sc.changeId;
        latestDeltas[sc.trait] = sc.delta || 0;
        previousValues[sc.trait] = sc.previousValue ?? (currentValues[sc.trait] - (sc.delta || 0));
      }
    }

    const traitsDetail = {};
    for (const trait of ALLOWED_TRAITS) {
      traitsDetail[trait] = {
        trait,
        current: currentValues[trait] ?? 0,
        previous: previousValues[trait] ?? (currentValues[trait] ?? 0),
        latestDelta: latestDeltas[trait] ?? 0,
        windowNo: (typeof stateData.windowNo === 'number' && !isNaN(stateData.windowNo)) ? stateData.windowNo : 1,
        stateChangeId: latestStateChanges[trait] || null,
        range: [-999, 999]
      };
    }

    return {
      windowNo: (typeof stateData.windowNo === 'number' && !isNaN(stateData.windowNo)) ? stateData.windowNo : 1,
      recoveryStatus: stateData.recoveryStatus || 'NORMAL',
      updatedAt: stateData.updatedAt || null,
      values: currentValues,
      traits: traitsDetail,
      historyCount: history.length,
      stateChangesCount: stateChanges.length
    };
  }

  /**
   * 获取特质演化轨迹数据
   */
  getStateTrajectory(options = {}) {
    const { trait = null, fromWindow = null, toWindow = null } = options;
    const stateData = this._readSubjectState();
    const stateChanges = Array.isArray(stateData.stateChanges) ? stateData.stateChanges : [];
    const records = this._readArchiveRecords();

    // 联合 stateChanges 与 archive 记录提取全部历史演化步骤
    const allChanges = [];
    const seenScIds = new Set();

    for (const sc of stateChanges) {
      const id = sc.stateChangeId || sc.changeId;
      if (id && !seenScIds.has(id)) {
        seenScIds.add(id);
        allChanges.push(sc);
      }
    }

    for (const rec of records) {
      const p = rec.payload || rec;
      const changes = Array.isArray(p.stateChanges) ? p.stateChanges : [];
      for (const sc of changes) {
        const id = sc.stateChangeId || sc.changeId;
        if (id && !seenScIds.has(id)) {
          seenScIds.add(id);
          allChanges.push(sc);
        }
      }
    }

    // 按 windowNo 升序排列
    allChanges.sort((a, b) => (a.windowNo || 0) - (b.windowNo || 0));

    let filtered = allChanges;
    if (trait) {
      filtered = filtered.filter(sc => sc.trait === trait);
    }
    if (fromWindow !== null) {
      filtered = filtered.filter(sc => (sc.windowNo || 0) >= fromWindow);
    }
    if (toWindow !== null) {
      filtered = filtered.filter(sc => (sc.windowNo || 0) <= toWindow);
    }

function getRecordWindowNo(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.windowNo === 'number' && !isNaN(r.windowNo)) return r.windowNo;
  if (r.payload && typeof r.payload.windowNo === 'number' && !isNaN(r.payload.windowNo)) return r.payload.windowNo;
  return null;
}

    return filtered.map(sc => ({
      stateChangeId: sc.stateChangeId || sc.changeId,
      windowNo: (typeof sc.windowNo === 'number' && !isNaN(sc.windowNo)) ? sc.windowNo : null,
      trait: sc.trait,
      previousValue: sc.previousValue ?? 0,
      delta: sc.delta ?? 0,
      newValue: sc.newValue ?? 0,
      evidenceIds: Array.isArray(sc.evidenceIds) ? sc.evidenceIds : [],
      createdAt: sc.createdAt || null
    }));
  }

  // ---------------------------------------------------------------------------
  // P1-02: 100 轮 Window Explorer
  // ---------------------------------------------------------------------------
  getWindowSummaries(options = {}) {
    return this.getWindows(options);
  }

  getWindows(options = {}) {
    const { offset = 0, limit = 50 } = options;
    const records = this._readArchiveRecords();
    const windowMap = new Map();

    for (const rec of records) {
      const recType = rec.recordType || rec.type || (rec.payload && rec.payload.type) || '';
      if (NON_STATE_RECORD_TYPES.has(recType)) {
        continue;
      }
      const wNo = getRecordWindowNo(rec);
      if (!windowMap.has(wNo)) {
        windowMap.set(wNo, {
          windowNo: wNo,
          records: []
        });
      }
      windowMap.get(wNo).records.push(rec);
    }

    // H-04 性能优化：在窗口循环前只执行一次完整性快照扫描，避免 O(Window × Archive) 重复全量 I/O
    const integrityReport = this._getIntegritySnapshot();
    const defaultArchiveIntegrity = integrityReport.integrity ? integrityReport.integrity.toUpperCase() : 'CERTIFIED';
    const defaultReplayStatus = integrityReport.replayStatus ? integrityReport.replayStatus.toUpperCase() : 'COMPLETE';

    // 汇总各窗口概况
    const summaries = [];
    for (const [wNo, wData] of windowMap.entries()) {
      let turns = null;
      let messageCount = null;
      let eventCount = 0;
      let observationCount = 0;
      let interpretationCount = 0;
      let acceptedEvidenceCount = 0;
      let rejectedEvidenceCount = 0;
      let stateChangesCount = 0;
      let startTime = Infinity;
      let endTime = -Infinity;
      let recordedSegmentsCount = 0;

      for (const r of wData.records) {
        const p = r.payload || r;
        const ts = (typeof r.timestamp === 'number' && !isNaN(r.timestamp))
          ? r.timestamp
          : ((typeof p.createdAt === 'number' && !isNaN(p.createdAt)) ? p.createdAt : null);
        if (ts !== null) {
          if (ts < startTime) startTime = ts;
          if (ts > endTime) endTime = ts;
        }

        if (typeof p.turns === 'number') {
          turns = turns === null ? p.turns : Math.max(turns, p.turns);
        }
        if (typeof p.messageCount === 'number') {
          messageCount = messageCount === null ? p.messageCount : Math.max(messageCount, p.messageCount);
        }
        if (Array.isArray(p.segments)) {
          recordedSegmentsCount = Math.max(recordedSegmentsCount, p.segments.length);
        }
        if (Array.isArray(p.events)) eventCount += p.events.length;
        if (Array.isArray(p.observations)) observationCount += p.observations.length;
        if (Array.isArray(p.interpretations)) interpretationCount += p.interpretations.length;
        if (Array.isArray(p.verifiedEvidence)) acceptedEvidenceCount += p.verifiedEvidence.length;
        if (Array.isArray(p.rejectedEvidence)) rejectedEvidenceCount += p.rejectedEvidence.length;
        if (Array.isArray(p.stateChanges)) stateChangesCount += p.stateChanges.length;
      }

      let archiveIntegrity = defaultArchiveIntegrity;
      let replayStatus = defaultReplayStatus;
      if (wNo === null) {
        archiveIntegrity = 'UNCERTIFIED';
        replayStatus = 'UNRESOLVED';
      }

      summaries.push({
        windowNo: wNo,
        status: wNo === null ? 'UNRESOLVED' : ((turns !== null && turns >= 100) ? 'COMPLETED' : 'IN_PROGRESS'),
        turns: turns !== null ? turns : null,
        messageCount: messageCount !== null ? messageCount : null,
        segmentCount: recordedSegmentsCount,
        startTime: startTime === Infinity ? null : startTime,
        endTime: endTime === -Infinity ? null : endTime,
        eventCount,
        observationCount,
        interpretationCount,
        acceptedEvidenceCount,
        rejectedEvidenceCount,
        stateChangesCount,
        archiveIntegrity,
        replayStatus
      });
    }

    summaries.sort((a, b) => {
      if (a.windowNo === null && b.windowNo === null) return 0;
      if (a.windowNo === null) return 1;
      if (b.windowNo === null) return -1;
      return a.windowNo - b.windowNo;
    });
    const total = summaries.length;
    const items = summaries.slice(offset, offset + limit);

    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      total,
      offset,
      limit,
      items
    };
  }

  /**
   * 获取指定 Window 详细报告 (P0-01: 绝对消除占位与伪造事实)
   */
  getWindowDetail(windowNo) {
    let records = [];
    if (this.index && this.index.ensureIndex()) {
      this._lastQueryMode = 'INDEX';
      const descs = this.index.getWindowDescriptors(windowNo) || [];
      for (const d of descs) {
        const rec = this.index.readRecordAtOffset(d.byteOffset, d.byteLength);
        if (rec) {
          const norm = normalizeArchiveRecord(rec);
          if (norm) records.push(norm);
        }
      }
    } else {
      this._lastQueryMode = 'FULL_SCAN';
      records = this._readArchiveRecords().filter(r => getRecordWindowNo(r) === windowNo);
    }

    if (!records.length) {
      return null;
    }

    let summaryPayload = null;
    const events = [];
    const observations = [];
    const interpretations = [];
    const verifiedEvidence = [];
    const rejectedEvidence = [];
    const stateChanges = [];
    const explanations = [];
    let segments = [];
    let windowSynthesis = {};

    for (const r of records) {
      const p = r.payload || r;
      if (r.recordType === 'window_summary' || r.type === 'window_archive') {
        summaryPayload = p;
        if (Array.isArray(p.segments)) segments = p.segments;
        if (p.windowSynthesis) windowSynthesis = p.windowSynthesis;
      }
      if (Array.isArray(p.events)) events.push(...p.events);
      if (Array.isArray(p.observations)) observations.push(...p.observations);
      if (Array.isArray(p.interpretations)) interpretations.push(...p.interpretations);
      if (Array.isArray(p.verifiedEvidence)) verifiedEvidence.push(...p.verifiedEvidence);
      if (Array.isArray(p.rejectedEvidence)) rejectedEvidence.push(...p.rejectedEvidence);
      if (Array.isArray(p.stateChanges)) stateChanges.push(...p.stateChanges);
      if (Array.isArray(p.explanations)) explanations.push(...p.explanations);
    }

    // P0-01: 绝对禁止伪造不存在的 segments 事实
    // 若归档记录中无 segments，如实返回空数组，不得由程序臆造假段落

    const integrityReport = this._getIntegritySnapshot();
    let archiveIntegrity = integrityReport.integrity ? integrityReport.integrity.toUpperCase() : 'CERTIFIED';
    let replayStatus = integrityReport.replayStatus ? integrityReport.replayStatus.toUpperCase() : 'COMPLETE';
    if (windowNo === null) {
      archiveIntegrity = 'UNCERTIFIED';
      replayStatus = 'UNRESOLVED';
    }

    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      windowNo,
      summaryPayload,
      turns: (summaryPayload && typeof summaryPayload.turns === 'number') ? summaryPayload.turns : null,
      messageCount: (summaryPayload && typeof summaryPayload.messageCount === 'number') ? summaryPayload.messageCount : null,
      segmentCount: segments.length,
      segments,
      windowSynthesis,
      events,
      observations,
      interpretations,
      verifiedEvidence,
      rejectedEvidence,
      stateChanges,
      explanations,
      archiveIntegrity,
      replayStatus
    };
  }

  /**
   * 获取指定 Window 的真实轮次详情 (P0-01 & P0-02: 绝不伪造 messageId 或对话内容)
   */
  getWindowRounds(windowNo, segmentIndex = null) {
    const detail = this.getWindowDetail(windowNo);
    const integrityReport = this._getIntegritySnapshot();
    const isCertified = (integrityReport.integrity === 'certified');

    const rounds = [];
    const roundMap = new Map();
    const unresolvedEvents = [];

    if (detail && Array.isArray(detail.events)) {
      for (const e of detail.events) {
        if (!e) continue;
        const p = e.payload || {};
        let rNo = null;

        if (typeof p.roundNo === 'number' && p.roundNo > 0) {
          rNo = p.roundNo;
        } else if (typeof e.roundNo === 'number' && e.roundNo > 0) {
          rNo = e.roundNo;
        } else if (typeof p.round === 'number' && p.round > 0) {
          rNo = p.round;
        } else if (typeof e.round === 'number' && e.round > 0) {
          rNo = e.round;
        } else if (typeof p.turnNo === 'number' && p.turnNo > 0) {
          rNo = p.turnNo;
        } else if (typeof e.turnNo === 'number' && e.turnNo > 0) {
          rNo = e.turnNo;
        }

        const role = p.role || (e.source === 'assistant' ? 'assistant' : 'user');
        const content = p.content != null ? p.content : (typeof e.content === 'string' ? e.content : null);

        let bridge = null;
        if (e.bridge === true || p.bridge === true) {
          const prov = p.provenance || e.provenance;
          const isProven = prov && typeof prov === 'object' && (prov.sourceEventId || prov.sourceMessageId || prov.windowNo);
          if (isProven) {
            bridge = true;
          } else {
            bridge = null;
          }
        } else if (e.bridge === false || p.bridge === false) {
          bridge = false;
        }

        const msgObj = {
          messageId: e.messageId || null,
          role,
          timestamp: e.timestamp || null,
          content,
          bridge
        };

        if (rNo === null) {
          unresolvedEvents.push({
            roundNo: null,
            segmentIndex: null,
            status: 'UNRESOLVED',
            bridge,
            tag: 'UNRESOLVED',
            userMessage: role === 'user' ? msgObj : null,
            assistantMessage: role === 'assistant' ? msgObj : null
          });
          continue;
        }

        if (!roundMap.has(rNo)) {
          roundMap.set(rNo, { userMessage: null, assistantMessage: null });
        }
        const item = roundMap.get(rNo);

        if (role === 'user') {
          item.userMessage = msgObj;
        } else {
          item.assistantMessage = msgObj;
        }
      }
    }

    const maxRecordedRound = roundMap.size > 0 ? Math.max(...roundMap.keys()) : 0;
    const targetTurns = (detail && typeof detail.turns === 'number') ? detail.turns : maxRecordedRound;
    const startRound = segmentIndex !== null ? (Number(segmentIndex) - 1) * 20 + 1 : 1;
    const endRound = segmentIndex !== null ? Number(segmentIndex) * 20 : Math.max(targetTurns, maxRecordedRound);

    for (let r = startRound; r <= endRound; r++) {
      const segIdx = Math.floor((r - 1) / 20) + 1;
      const recData = roundMap.get(r);

      if (recData && (recData.userMessage || recData.assistantMessage)) {
        const uMsg = recData.userMessage;
        const aMsg = recData.assistantMessage;

        let bridge = null;
        if ((uMsg && uMsg.bridge === true) || (aMsg && aMsg.bridge === true)) {
          bridge = true;
        } else if ((uMsg && uMsg.bridge === false) || (aMsg && aMsg.bridge === false)) {
          bridge = false;
        }

        const tag = bridge === true ? 'BRIDGE' : (bridge === false ? 'ACTIVE' : 'RECORDED');

        rounds.push({
          roundNo: r,
          segmentIndex: segIdx,
          status: 'RECORDED',
          bridge,
          tag,
          userMessage: uMsg,
          assistantMessage: aMsg
        });
      } else {
        const status = isCertified ? 'NOT_RECORDED' : 'UNRESOLVED';
        rounds.push({
          roundNo: r,
          segmentIndex: segIdx,
          status,
          bridge: null,
          tag: status,
          userMessage: null,
          assistantMessage: null
        });
      }
    }

    if (segmentIndex === null && unresolvedEvents.length > 0) {
      rounds.push(...unresolvedEvents);
    }
    rounds.unresolved = unresolvedEvents;

    rounds.queryMode = this._lastQueryMode || 'FULL_SCAN';
    return rounds;
  }

  // ---------------------------------------------------------------------------
  // P1-03: Provenance 归因与反查溯源
  // ---------------------------------------------------------------------------
  traceProvenance(stateChangeId) {
    if (!stateChangeId) return null;
    const stateData = this._readSubjectState();
    const records = this._readArchiveRecords();

    // 1. 查找目标 StateChange
    let targetSc = null;
    for (const sc of (stateData.stateChanges || [])) {
      if ((sc.stateChangeId || sc.changeId) === stateChangeId) {
        targetSc = sc;
        break;
      }
    }
    if (!targetSc) {
      for (const rec of records) {
        const p = rec.payload || rec;
        for (const sc of (p.stateChanges || [])) {
          if ((sc.stateChangeId || sc.changeId) === stateChangeId) {
            targetSc = sc;
            break;
          }
        }
        if (targetSc) break;
      }
    }

    if (!targetSc) {
      return { found: false, reason: 'STATE_CHANGE_NOT_FOUND', stateChangeId };
    }

    // 2. 收集 Evidence
    const evidenceList = [];
    const evIdSet = new Set(targetSc.evidenceIds || []);

    for (const rec of records) {
      const p = rec.payload || rec;
      for (const ev of (p.verifiedEvidence || [])) {
        if (ev && ev.evidenceId && evIdSet.has(ev.evidenceId)) {
          evidenceList.push({ ...ev, status: 'verified' });
        }
      }
      for (const ev of (p.rejectedEvidence || [])) {
        if (ev && ev.evidenceId && evIdSet.has(ev.evidenceId)) {
          evidenceList.push({ ...ev, status: 'rejected' });
        }
      }
    }

    // 3. 收集关联 Message 与 Event
    const chain = [];
    const eventMap = new Map();
    for (const rec of records) {
      const p = rec.payload || rec;
      for (const e of (p.events || [])) {
        if (e && e.messageId) eventMap.set(e.messageId, e);
      }
    }

    for (const ev of evidenceList) {
      const relEvt = ev.messageId ? eventMap.get(ev.messageId) : null;
      chain.push({
        evidenceId: ev.evidenceId,
        trait: ev.trait,
        direction: ev.direction,
        strength: ev.strength,
        status: ev.status,
        fingerprint: ev.fingerprint || null,
        messageId: ev.messageId || null,
        quote: ev.quote != null ? ev.quote : null,
        messageContent: (relEvt && relEvt.payload && relEvt.payload.content !== undefined)
          ? relEvt.payload.content
          : (ev.quote != null ? ev.quote : null),
        messageRole: (relEvt && relEvt.source) || (relEvt && relEvt.payload && relEvt.payload.role) || null,
        timestamp: (relEvt && relEvt.timestamp) || null
      });
    }

    return {
      found: true,
      stateChange: {
        stateChangeId: targetSc.stateChangeId || targetSc.changeId,
        windowNo: typeof targetSc.windowNo === 'number' ? targetSc.windowNo : null,
        trait: targetSc.trait,
        previousValue: targetSc.previousValue,
        delta: targetSc.delta,
        newValue: targetSc.newValue,
        evidenceIds: targetSc.evidenceIds || [],
        reducer: targetSc.reducer || null,
        createdAt: targetSc.createdAt || null
      },
      chain
    };
  }

  // ---------------------------------------------------------------------------
  // EOI 事实三层追溯 (Interpretation -> Observation -> Event -> Message)
  // ---------------------------------------------------------------------------
  traceEOI(id) {
    if (!id || typeof id !== 'string') return null;
    const cleanId = id.trim();
    const records = this._readArchiveRecords();

    // 收集所有三层记录
    const eventsMap = new Map();
    const obsMap = new Map();
    const interpMap = new Map();

    for (const rec of records) {
      const p = rec.payload || rec;
      for (const e of (p.events || [])) if (e && e.eventId) eventsMap.set(e.eventId, e);
      for (const o of (p.observations || [])) if (o && o.observationId) obsMap.set(o.observationId, o);
      for (const i of (p.interpretations || [])) if (i && i.interpretationId) interpMap.set(i.interpretationId, i);
    }

    // 1. 若目标是 Interpretation
    if (interpMap.has(cleanId)) {
      const interp = interpMap.get(cleanId);
      const observations = (interp.observationIds || []).map(oid => obsMap.get(oid)).filter(Boolean);
      const events = [];
      for (const obs of observations) {
        for (const eid of (obs.eventIds || [])) {
          const e = eventsMap.get(eid);
          if (e) events.push(e);
        }
      }
      return {
        type: 'interpretation',
        root: interp,
        observations,
        events,
        messages: events.map(e => ({ messageId: e.messageId, source: e.source, payload: e.payload }))
      };
    }

    // 2. 若目标是 Observation
    if (obsMap.has(cleanId)) {
      const obs = obsMap.get(cleanId);
      const events = (obs.eventIds || []).map(eid => eventsMap.get(eid)).filter(Boolean);
      const parentInterpretations = [];
      for (const interp of interpMap.values()) {
        if (Array.isArray(interp.observationIds) && interp.observationIds.includes(cleanId)) {
          parentInterpretations.push(interp);
        }
      }
      return {
        type: 'observation',
        root: obs,
        parentInterpretations,
        events,
        messages: events.map(e => ({ messageId: e.messageId, source: e.source, payload: e.payload }))
      };
    }

    // 3. 若目标是 Event
    if (eventsMap.has(cleanId)) {
      const evt = eventsMap.get(cleanId);
      const parentObservations = [];
      for (const obs of obsMap.values()) {
        if (Array.isArray(obs.eventIds) && obs.eventIds.includes(cleanId)) {
          parentObservations.push(obs);
        }
      }
      return {
        type: 'event',
        root: evt,
        parentObservations,
        message: { messageId: evt.messageId, source: evt.source, payload: evt.payload }
      };
    }

    return { found: false, id: cleanId };
  }

  // ---------------------------------------------------------------------------
  // 分页列表查询方法
  // ---------------------------------------------------------------------------
  getEvents(options = {}) {
    const { windowNo = null, type = null, source = null, offset = 0, limit = 50 } = options;
    const records = this._readArchiveRecords();
    let events = [];

    for (const rec of records) {
      const p = rec.payload || rec;
      const wNo = getRecordWindowNo(rec);
      if (windowNo !== null && wNo !== windowNo) continue;
      for (const e of (p.events || [])) {
        events.push({ ...e, windowNo: wNo });
      }
    }

    if (type) events = events.filter(e => e.type === type);
    if (source) events = events.filter(e => e.source === source);

    events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      total: events.length,
      offset,
      limit,
      items: events.slice(offset, offset + limit)
    };
  }

  getObservations(options = {}) {
    const { windowNo = null, source = null, offset = 0, limit = 50 } = options;
    const records = this._readArchiveRecords();
    let items = [];

    for (const rec of records) {
      const p = rec.payload || rec;
      const wNo = getRecordWindowNo(rec);
      if (windowNo !== null && wNo !== windowNo) continue;
      for (const o of (p.observations || [])) {
        items.push({ ...o, windowNo: wNo });
      }
    }

    if (source) items = items.filter(o => o.source === source);
    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      total: items.length,
      offset,
      limit,
      items: items.slice(offset, offset + limit)
    };
  }

  getInterpretations(options = {}) {
    const { windowNo = null, perspective = null, offset = 0, limit = 50 } = options;
    const records = this._readArchiveRecords();
    let items = [];

    for (const rec of records) {
      const p = rec.payload || rec;
      const wNo = getRecordWindowNo(rec);
      if (windowNo !== null && wNo !== windowNo) continue;
      for (const i of (p.interpretations || [])) {
        items.push({ ...i, windowNo: wNo });
      }
    }

    if (perspective) items = items.filter(i => i.perspective === perspective);
    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      total: items.length,
      offset,
      limit,
      items: items.slice(offset, offset + limit)
    };
  }

  getEvidence(options = {}) {
    const { windowNo = null, status = null, trait = null, offset = 0, limit = 50 } = options;
    const records = this._readArchiveRecords();
    let items = [];

    for (const rec of records) {
      const p = rec.payload || rec;
      const wNo = getRecordWindowNo(rec);
      if (windowNo !== null && wNo !== windowNo) continue;
      for (const ev of (p.verifiedEvidence || [])) {
        items.push({ ...ev, windowNo: wNo, status: 'verified' });
      }
      for (const ev of (p.rejectedEvidence || [])) {
        items.push({ ...ev, windowNo: wNo, status: 'rejected' });
      }
    }

    if (status) items = items.filter(ev => ev.status === status);
    if (trait) items = items.filter(ev => ev.trait === trait);

    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      total: items.length,
      offset,
      limit,
      items: items.slice(offset, offset + limit)
    };
  }

  getStateChanges(options = {}) {
    const { windowNo = null, trait = null, offset = 0, limit = 50 } = options;
    const stateData = this._readSubjectState();
    let items = Array.isArray(stateData.stateChanges) ? [...stateData.stateChanges] : [];

    if (windowNo !== null) items = items.filter(sc => sc.windowNo === windowNo);
    if (trait) items = items.filter(sc => sc.trait === trait);

    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      total: items.length,
      offset,
      limit,
      items: items.slice(offset, offset + limit)
    };
  }

  search(options = {}) {
    if (typeof options === 'string') {
      options = { query: options };
    }
    const { query = '', type = null, offset = 0, limit = 50 } = options;
    const q = String(query).trim().toLowerCase();
    const results = [];

    if (!q) {
      return { queryMode: this._lastQueryMode || 'FULL_SCAN', total: 0, offset, limit, items: [] };
    }

    const records = this._readArchiveRecords();
    for (const rec of records) {
      const p = rec.payload || rec;
      const wNo = getRecordWindowNo(rec);

      // 搜 Event
      if (!type || type === 'event') {
        for (const e of (p.events || [])) {
          const ep = e.payload || {};
          const c = typeof e.content === 'string' ? e.content : (typeof ep.content === 'string' ? ep.content : '');
          if ((e.eventId && e.eventId.toLowerCase().includes(q)) ||
              (e.messageId && e.messageId.toLowerCase().includes(q)) ||
              (c && c.toLowerCase().includes(q))) {
            results.push({ type: 'event', id: e.eventId, windowNo: wNo, record: e });
          }
        }
      }

      // 搜 Evidence
      if (!type || type === 'evidence') {
        for (const ev of (p.verifiedEvidence || [])) {
          if ((ev.evidenceId && ev.evidenceId.toLowerCase().includes(q)) ||
              (ev.trait && ev.trait.toLowerCase().includes(q)) ||
              (ev.quote && ev.quote.toLowerCase().includes(q))) {
            results.push({ type: 'evidence', id: ev.evidenceId, status: 'verified', windowNo: wNo, record: ev });
          }
        }
        for (const ev of (p.rejectedEvidence || [])) {
          if ((ev.evidenceId && ev.evidenceId.toLowerCase().includes(q)) ||
              (ev.reason && ev.reason.toLowerCase().includes(q)) ||
              (ev.trait && ev.trait.toLowerCase().includes(q))) {
            results.push({ type: 'evidence', id: ev.evidenceId, status: 'rejected', windowNo: wNo, record: ev });
          }
        }
      }

      // 搜 StateChanges
      if (!type || type === 'state_change') {
        for (const sc of (p.stateChanges || [])) {
          const scId = sc.stateChangeId || sc.changeId;
          if ((scId && scId.toLowerCase().includes(q)) ||
              (sc.trait && sc.trait.toLowerCase().includes(q))) {
            results.push({ type: 'state_change', id: scId, windowNo: wNo, record: sc });
          }
        }
      }
    }

    return {
      queryMode: this._lastQueryMode || 'FULL_SCAN',
      total: results.length,
      offset,
      limit,
      items: results.slice(offset, offset + limit)
    };
  }
}

module.exports = { ResearchQuery };
