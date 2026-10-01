const fs = require('fs');
const path = require('path');
const { wrapArchiveRecord, normalizeArchiveRecord } = require('./experience-schema');
const { validateArchiveRecord, computeCanonicalRecordHash, isLegacyAdaptedRecord, findModernChainFieldDefects } = require('./archive-integrity');

/**
 * Append-Only 原始实验底座：experiences.jsonl (v0.9.7.1)
 * 
 * 核心哲学与工程原则：
 * 1. 只追加，永不静默修改，永不覆盖。
 * 2. 永不因 Token 超限或条目上限（maxEntries）被裁剪或删除。
 * 3. 完整保存 5x20 分段经历、Window Synthesis、用户给予、初澜经历与 Provenance 证据。
 * 4. 严谨因果链：每一条记录具备单调递增 archiveSeq 与 SHA-256 防篡改哈希链（prevHash -> recordHash）。
 * 5. 严格持久化：每次 append 同步执行 fsync，保障落盘语义。
 * 6. 并发边界：本类是单写者 API，不提供跨进程 file lock；正式调用方必须在
 *    Electron single-instance/单 writer 生命周期内串行调用 append。
 */
class ExperiencesArchive {
  constructor(userDataDir, opts = {}) {
    this.dir = userDataDir;
    this.path = path.join(userDataDir, 'experiences.jsonl');
    this.opts = opts;
  }

  /** 校验整个物理链尾；坏尾不能被跳过后继续追加。 */
  _getValidatedAppendState() {
    const { records, diagnostics } = this.readAllWithDiagnostics();
    if (diagnostics.skippedCount > 0) {
      return { valid: false, reason: 'ARCHIVE_TAIL_SYNTAX_CORRUPTED' };
    }
    const hasSequenced = records.some(r => r && (r.archiveSeq !== undefined || r.recordHash !== undefined));
    if (!hasSequenced && records.length > 0) {
      // 旧版本可能只有 recordType/payload，没有链字段。保留其可读性，
      // 但新链从 1 开始，后续一旦进入现代链则不允许再混写旧尾部。
      for (const record of records) {
        const normalized = normalizeArchiveRecord(record) || record;
        // P0-01: 只有明确 Legacy 适配记录才允许缺链字段；
        // 现代记录缺链字段 → fail closed，不续写、不静默补全。
        if (!isLegacyAdaptedRecord(normalized) && findModernChainFieldDefects(normalized).length > 0) {
          return { valid: false, reason: 'ARCHIVE_MODERN_RECORD_MISSING_CHAIN_FIELDS' };
        }
        const validation = validateArchiveRecord(normalized, { allowLegacy: true });
        if (!validation.valid) return { valid: false, reason: `ARCHIVE_LEGACY_PREFIX_INVALID:${validation.reason}` };
      }
      return { valid: true, last: null, legacyPrefix: true };
    }
    // P0-01: 现代记录缺链字段（无论是否混排）→ fail closed
    for (const record of records) {
      const normalized = normalizeArchiveRecord(record) || record;
      if (!isLegacyAdaptedRecord(normalized) && findModernChainFieldDefects(normalized).length > 0) {
        return { valid: false, reason: 'ARCHIVE_MODERN_RECORD_MISSING_CHAIN_FIELDS' };
      }
    }
    if (records.some(r => r.archiveSeq === undefined || r.recordHash === undefined)) {
      return { valid: false, reason: 'ARCHIVE_TAIL_MIXED_LEGACY_AND_CHAINED' };
    }
    let previous = null;
    for (const record of records) {
      const validation = validateArchiveRecord(record, { allowLegacy: true });
      if (!validation.valid) {
        return { valid: false, reason: `ARCHIVE_TAIL_SCHEMA_INVALID:${validation.reason}` };
      }
      if (!Number.isFinite(record.archiveSeq) || !Number.isInteger(record.archiveSeq) || record.archiveSeq < 1) {
        return { valid: false, reason: 'ARCHIVE_TAIL_SEQUENCE_INVALID' };
      }
      if (typeof record.recordHash !== 'string' || !record.recordHash) {
        return { valid: false, reason: 'ARCHIVE_TAIL_HASH_MISSING' };
      }
      if (record.recordHash !== computeCanonicalRecordHash(record)) {
        return { valid: false, reason: 'ARCHIVE_TAIL_HASH_MISMATCH' };
      }
      const expectedSeq = previous ? previous.archiveSeq + 1 : 1;
      const expectedPrevHash = previous ? previous.recordHash : 'GENESIS';
      if (record.archiveSeq !== expectedSeq) {
        return { valid: false, reason: 'ARCHIVE_TAIL_SEQUENCE_BROKEN' };
      }
      if (record.prevHash !== expectedPrevHash) {
        return { valid: false, reason: 'ARCHIVE_TAIL_PREV_HASH_BROKEN' };
      }
      previous = record;
    }
    // P0-02: Tail Anchor 校验——现代链尾必须与链外锚点一致，否则 fail-closed 不续写
    if (previous) {
      const anchorState = this._readTailAnchor();
      if (!anchorState.present) return { valid: false, reason: 'ARCHIVE_ANCHOR_MISSING' };
      if (anchorState.corrupt) return { valid: false, reason: 'ARCHIVE_ANCHOR_CORRUPTED' };
      const a = anchorState.anchor;
      if (!a || a.archiveSeq !== previous.archiveSeq || a.recordHash !== previous.recordHash || a.recordId !== previous.recordId) {
        return { valid: false, reason: 'ARCHIVE_ANCHOR_MISMATCH' };
      }

      // v0.9.7.1 P0-02: 若存在 Genesis Anchor，头部也必须与原始首记录一致。
      // 缺失旧版 Genesis Anchor 时允许继续追加，但该归档保持 UNCERTIFIED，
      // 绝不把当前首记录重新声明成“原始首记录”。
      const firstSequenced = records.find(r => Number.isInteger(r.archiveSeq) && r.archiveSeq >= 1);
      if (a.genesis && firstSequenced &&
          (a.genesis.archiveSeq !== firstSequenced.archiveSeq ||
           a.genesis.recordId !== firstSequenced.recordId ||
           a.genesis.recordHash !== firstSequenced.recordHash)) {
        return { valid: false, reason: 'ARCHIVE_GENESIS_ANCHOR_MISMATCH' };
      }
    }
    return { valid: true, last: previous };
  }

  /** P0-02: 读取链外尾部锚点 (experiences.jsonl.anchor.json) */
  _readTailAnchor() {
    const anchorPath = this.path + '.anchor.json';
    if (!fs.existsSync(anchorPath)) return { present: false, anchor: null, corrupt: false };
    try {
      return { present: true, anchor: JSON.parse(fs.readFileSync(anchorPath, 'utf8')), corrupt: false };
    } catch {
      return { present: true, anchor: null, corrupt: true };
    }
  }

  /**
   * P0-02: 更新链外尾部锚点（先写临时文件并 fsync，再原子 rename）。
   * v0.9.7.1：同一锚点首次创建时同时固定 Genesis；后续更新只移动 Tail。
   * anchor 不参与 record hash chain，避免循环依赖。
   */
  _updateTailAnchor(entry) {
    const anchorPath = this.path + '.anchor.json';
    let existing = null;
    if (fs.existsSync(anchorPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
        if (parsed && typeof parsed === 'object') existing = parsed;
      } catch {}
    }

    const anchor = {
      ...(existing || {}),
      schemaVersion: 1,
      archiveSeq: entry.archiveSeq,
      recordId: entry.recordId,
      recordHash: entry.recordHash,
      updatedAt: Date.now()
    };

    // 只有真正从 archiveSeq=1 开始建立链时才写 Genesis Anchor。
    // 对已有旧归档，绝不把当前“看见的第一条”重新伪装成原始 Genesis。
    if (!anchor.genesis && entry.archiveSeq === 1) {
      anchor.genesis = {
        schemaVersion: 1,
        archiveSeq: entry.archiveSeq,
        recordId: entry.recordId,
        recordHash: entry.recordHash,
        recordedAt: Date.now()
      };
    }

    try {
      const tmpPath = anchorPath + '.tmp';
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(anchor), null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, anchorPath);
      return true;
    } catch (e) {
      console.error('[ExperiencesArchive] tail anchor 更新失败:', e.message);
      return false;
    }
  }

  getLastSequencedRecord() {
    const state = this._getValidatedAppendState();
    return state.valid ? (state.last || null) : null;
  }

  /**
   * 追加一条归档记录（JSON 行）。具备 fsync 持久化保障与因果哈希链。
   * 严格 Schema 与防篡改哈希写门禁（F-10 / User Constraint #3）：
   * 1. 显式传入 archiveSeq 若不等于预期序号直接拒绝；
   * 2. 显式传入 prevHash 若不等于上一条 recordHash 直接拒绝；
   * 3. 显式传入 recordHash 若与 Canonical 计算哈希不一致直接拒绝；
   * 4. 必须先通过 validateArchiveRecord() 校验，绝不向磁盘写入坏记录。
   */
  append(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;

    const appendState = this._getValidatedAppendState();
    if (!appendState.valid) {
      console.error(`[ExperiencesArchive] append rejected: existing archive tail is not trustworthy (${appendState.reason})`);
      return false;
    }
    const last = appendState.last || null;
    const defaultSeq = last ? last.archiveSeq + 1 : 1;
    const defaultRecordId = `rec-${String(defaultSeq).padStart(6, '0')}`;
    const defaultPrevHash = last ? last.recordHash : 'GENESIS';

    // 1. 序列号守门：若调用方显式传入 archiveSeq，必须与根据已有链计算出的下一个合法序号完全一致
    if (record.archiveSeq !== undefined && record.archiveSeq !== null) {
      if (record.archiveSeq !== defaultSeq) {
        console.error(`[ExperiencesArchive] append rejected: invalid or forged archiveSeq (expected ${defaultSeq}, got ${record.archiveSeq})`);
        return false;
      }
    }

    // 2. 前驱哈希守门：若调用方显式传入 prevHash，必须与上一条记录的 recordHash 完全一致
    if (record.prevHash !== undefined && record.prevHash !== null) {
      if (record.prevHash !== defaultPrevHash) {
        console.error(`[ExperiencesArchive] append rejected: invalid or forged prevHash (expected ${defaultPrevHash}, got ${record.prevHash})`);
        return false;
      }
    }

    const entry = {
      ...record,
      schemaVersion: record.schemaVersion || 1,
      recordType: record.recordType || record.type || 'window_summary',
      recordId: record.recordId || defaultRecordId,
      archiveSeq: defaultSeq,
      timestamp: Number.isFinite(record.timestamp)
        ? record.timestamp
        : (Number.isFinite(record.createdAt) ? record.createdAt : Date.now()),
      windowNo: Number.isFinite(record.windowNo)
        ? record.windowNo
        : (record.windowNo === null ? null : (record.payload && Number.isFinite(record.payload.windowNo) ? record.payload.windowNo : null)),
      payload: (record.payload !== undefined && record.payload !== null && typeof record.payload === 'object' && !Array.isArray(record.payload))
        ? record.payload
        : (record.payload !== undefined ? record.payload : {}),
      prevHash: defaultPrevHash
    };

    if (!entry.createdAt) entry.createdAt = entry.timestamp;

    // 3. 当前记录哈希守门：若调用方显式传入 recordHash，必须与重新计算的 Canonical 哈希完全一致
    const computedHash = computeCanonicalRecordHash(entry);
    if (record.recordHash !== undefined && record.recordHash !== null) {
      if (record.recordHash !== computedHash) {
        console.error(`[ExperiencesArchive] append rejected: recordHash mismatch (expected ${computedHash}, got ${record.recordHash})`);
        return false;
      }
    }
    entry.recordHash = computedHash;

    // 4. Schema 强校验：必须在写盘前通过 validateArchiveRecord()，严禁“先写盘后报错”污染实验底座
    const validation = validateArchiveRecord(entry, { allowLegacy: true });
    if (!validation.valid) {
      console.error(`[ExperiencesArchive] append rejected: schema validation failed (${validation.reason})`);
      return false;
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
      // P0-02: 归档写入成功后更新链外 Tail Anchor 并 fsync。
      // anchor 更新失败绝不伪装成完整成功：不反向覆盖 archive，
      // 由 checkArchive 判定 ANCHOR_STALE/UNCOMMITTED_TAIL 进入 UNCERTIFIED/recovery 状态。
      if (!this._updateTailAnchor(entry)) {
        console.error('[ExperiencesArchive] append: archive 已落盘但 tail anchor 更新失败，进入 UNCERTIFIED/recovery 状态（绝不伪装成功）');
        return false;
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
    const written = this.append(wrapped);
    if (!written && recordType === 'recovery_event') {
      // 主链损坏时禁止续写；恢复事实仍需可审计，因此写入隔离侧车。
      return this.appendRecoveryAudit(wrapped);
    }
    return written;
  }

  appendRecoveryAudit(record) {
    const auditPath = this.path + '.recovery-audit.jsonl';
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const fd = fs.openSync(auditPath, 'a');
      try { fs.writeSync(fd, JSON.stringify({ ...record, recoveryAudit: true }) + '\n', null, 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      console.error('[ExperiencesArchive] recovery audit sidecar write failed:', e.message);
      return false;
    }
  }

  /**
   * v0.9.9 P0-2（A 半）：主链锁死时的紧急溢写保全。
   *
   * 场景：experiences.jsonl 追加失败（坏尾 / 锚点失配 / 链断裂等）后主链进入
   * fail-closed、再也写不进去。而关窗会裁掉 memory.json 的 history 头部
   * （memory.js closeWindow 里的 splice），原始对话**只在归档这一份** ——
   * 此时若直接放行关窗，就是「无保全直接丢弃对话」，既违反 D-005，
   * 也违反「宁可少写一次，不可写坏一次」。
   *
   * 所以先把本窗口小结完整溢写到 recovery-audit sidecar（A），由调用方确认
   * 写入成功后才放行关窗（C）；溢写也失败就必须维持 fail-closed。
   *
   * 认识论位置：溢写记录刻意**不伪造**链字段（archiveSeq / prevHash / recordHash
   * 一概不编）。主链此刻不可信，编一个序号出来等于把「没进链」伪装成「进了链」。
   * 记录显式带 sidecar_spillover 与 errorReason，完整性服务据此判 uncertified ——
   * 这正是它该有的位置：数据保全住了，但绝不冒充已认证的经历。
   */
  spillWindowArchiveToSidecar(payload, errorReason) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const record = {
      schemaVersion: 1,
      recordType: 'window_summary',
      recordId: `spill-w${Number(payload.windowNo) || 0}-${Date.now().toString(36)}`,
      timestamp: Date.now(),
      windowNo: Number.isFinite(payload.windowNo) ? payload.windowNo : null,
      payload,
      sidecar_spillover: true,
      errorReason: String(errorReason || 'ARCHIVE_APPEND_FAILED')
    };
    return this.appendRecoveryAudit(record);
  }

  /**
   * v0.9.7.1: 持久化 Archive 外的 provenance attestations。
   * 这不是第二套事实数据库，只保存写时 verifier 产生的 ID/hash 证明材料，
   * 用于在 State commit 失败/重启后仍能验证 Archive 中的引用来源。
   */
  updateProvenanceAttestations(messageAttestations = [], evidenceAttestations = []) {
    const provenancePath = this.path + '.provenance.json';
    const normalizeList = value => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : [];
    let existing = { schemaVersion: 1, messageAttestations: [], evidenceAttestations: [] };

    if (fs.existsSync(provenancePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
        if (parsed && typeof parsed === 'object') existing = parsed;
      } catch {
        return false;
      }
    }

    const mergeByKey = (oldList, newList, keyFn) => {
      const map = new Map();
      for (const item of normalizeList(oldList)) map.set(keyFn(item), item);
      for (const item of normalizeList(newList)) map.set(keyFn(item), item);
      return Array.from(map.values());
    };

    const next = {
      schemaVersion: 1,
      messageAttestations: mergeByKey(
        existing.messageAttestations,
        messageAttestations,
        a => [a.messageId, a.sourceContentHash, a.windowNo].join('|')
      ),
      evidenceAttestations: mergeByKey(
        existing.evidenceAttestations,
        evidenceAttestations,
        a => [a.evidenceId, a.fingerprint].join('|')
      ),
      updatedAt: Date.now()
    };

    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const tmpPath = provenancePath + '.tmp';
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(next), null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, provenancePath);
      return true;
    } catch (e) {
      try { fs.unlinkSync(provenancePath + '.tmp'); } catch {}
      console.error('[ExperiencesArchive] provenance sidecar update failed:', e.message);
      return false;
    }
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
      rawSummaryText: typeof data.rawSummaryText === 'string' ? data.rawSummaryText : '',
      // v0.9.7.1: missing epistemic status is unknown, never an automatic certification.
      epistemicStatus: data.epistemicStatus || 'UNKNOWN',
      structuredSummaryAvailable: data.structuredSummaryAvailable !== false,
      summaryFailureReason: data.summaryFailureReason || null
    };
    if (data.generationContext && typeof data.generationContext === 'object') {
      payload.generationContext = data.generationContext;
    }
    if (data.sourceMessageRange && typeof data.sourceMessageRange === 'object') {
      payload.sourceMessageRange = data.sourceMessageRange;
    }

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
    if (data.generationContext && typeof data.generationContext === 'object') {
      payload.generationContext = data.generationContext;
    }
    if (Array.isArray(data.rejectedEvidence)) {
      payload.rejectedEvidence = data.rejectedEvidence;
    }
    return this.appendRecord('self_projection', windowNo, payload);
  }

  /**
   * 读取全部归档记录（容错跳过损坏行）
   */
  readAll() {
    const res = this.readAllWithDiagnostics();
    const auditPath = this.path + '.recovery-audit.jsonl';
    if (fs.existsSync(auditPath)) {
      try {
        for (const line of fs.readFileSync(auditPath, 'utf8').split('\n')) {
          if (line.trim()) res.records.push(JSON.parse(line));
        }
      } catch {}
    }
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
