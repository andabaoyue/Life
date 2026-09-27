const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { DeferredWriter } = require('./deferred-writer');
const { createStateChange, validateStateChange, symmetricRound } = require('./state-change');
const { normalizeArchiveRecord, checkMessageReference, checkQuoteInMessage } = require('./experience-schema');

const SCHEMA_VERSION = 1;

// 严格 Trait 白名单（唯一可信来源，严禁随意编造或非法扩展）
const ALLOWED_TRAITS = new Set([
  'quiet_preference',
  'social_initiative',
  'attachment_need',
  'vitality',
  'philosophical_curiosity'
]);

// 默认基准特质，初澜初始数值全为 0（代表中立未偏置，绝非空无），尺度严格限制在 [-999, 999]
const DEFAULT_TRAITS = {
  quiet_preference: 0,
  social_initiative: 0,
  attachment_need: 0,
  vitality: 0,
  philosophical_curiosity: 0
};

let evidenceGlobalSeq = 0;

/**
 * 辅助数值限制函数
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * 辅助规范化 quote 摘录文本 (P0-02: 移除多余空白并统一下划线大小写)
 */
function normalizeQuote(quote) {
  return String(quote || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * SubjectState：初澜主体状态量化模型与确定性 Reducer (v0.9.4-R1)
 * 
 * 核心规范：
 * 1. 主体状态值统一采用 [-999, 999]，特质严格限制在 ALLOWED_TRAITS 白名单内。
 * 2. 证据强度采用 [0, 1]，证据方向采用 [-1, +1]。
 * 3. 确定性 Reducer 计算：新状态 = 旧状态 + 证据增量，单窗口最大变动受 maxDeltaPerWindow 约束。
 * 4. LLM 绝对无法直接篡改状态最终值，仅能提交附带真实 messageId 与 quote 摘录的证据。
 * 5. Provenance 验证：程序核验 messageId 真实存在、quote 真实出现在消息原文中。未通过者记录拒绝原因并归档。
 * 6. Evidence 防重：同一 (messageId, quote, trait, direction) 严防无论 strength 如何变化均拒绝重复入库。
 * 7. 两阶段提交机制：先由 Reducer 执行并暂存，经 Archive 确认成功落盘后再提交持久化。
 * 8. 损坏自愈与恢复待决 (recovery_pending)：若 Archive 成功但 State 提交失败，自动标记 recovery_pending 并通过离线 Replay 闭环自愈。
 * 9. Replay v2：使用历史 Reducer 参数推演，对有损 Archive 标明 uncertified 非认证状态。
 */
class SubjectState {
  constructor(userDataDir, opts = {}) {
    this.dir = userDataDir;
    this.path = path.join(userDataDir, 'subject-state.json');
    this.opts = opts;
    this.stepWeight = opts.stepWeight ?? 20;               // 基础步长权重
    this.maxDeltaPerWindow = opts.maxDeltaPerWindow ?? 50; // 单窗口最大变动限额
    this.writer = new DeferredWriter(() => writeJsonAtomic(this.path, this.data), { delayMs: 1000 });
    this.recoveryPending = false;
    this.recoveryPendingReason = null;
    this.recoveryStatus = 'NORMAL';
    this.committedFingerprints = new Set();
    this.committedEvidenceIds = new Set();
    this.data = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(),
      windowNo: 1,
      values: { ...DEFAULT_TRAITS },
      history: [],
      stateChanges: [],
      seenFingerprints: [],
      seenEvidenceIds: [],
      recoveryStatus: 'NORMAL'
    };
    this.frozenSnapshot = '';
    this.load();
    this.updateSnapshot();
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        let raw;
        let corruptDetected = false;
        try {
          raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        } catch (parseErr) {
          corruptDetected = true;
          console.warn('[SubjectState] 检测到损坏的 subject-state.json，正在备份并尝试从经历归档重建:', parseErr.message);
          const corruptBackup = this.path + '.corrupt.' + Date.now();
          try { fs.copyFileSync(this.path, corruptBackup); } catch {}
          raw = null;
        }

        if (raw && typeof raw === 'object' && raw.values) {
          this.data = {
            schemaVersion: SCHEMA_VERSION,
            updatedAt: raw.updatedAt || Date.now(),
            windowNo: (typeof raw.windowNo === 'number' && !isNaN(raw.windowNo)) ? raw.windowNo : 1,
            values: { ...DEFAULT_TRAITS, ...raw.values },
            history: Array.isArray(raw.history) ? raw.history : [],
            stateChanges: Array.isArray(raw.stateChanges) ? raw.stateChanges : [],
            seenFingerprints: Array.isArray(raw.seenFingerprints)
              ? raw.seenFingerprints
              : (Array.isArray(raw.acceptedEvidenceFingerprints) ? raw.acceptedEvidenceFingerprints : []),
            seenEvidenceIds: Array.isArray(raw.seenEvidenceIds)
              ? raw.seenEvidenceIds
              : (Array.isArray(raw.acceptedEvidenceIds) ? raw.acceptedEvidenceIds : []),
            recoveryStatus: raw.recoveryStatus || 'NORMAL'
          };
          for (const k of Object.keys(this.data.values)) {
            this.data.values[k] = clamp(Math.round(this.data.values[k]), -999, 999);
          }
          this.committedFingerprints = new Set(this.data.seenFingerprints);
          this.committedEvidenceIds = new Set(this.data.seenEvidenceIds);
          this.recoveryStatus = this.data.recoveryStatus || 'NORMAL';

          // P0-01: 检查是否存在未决的 Archive 记录导致 Persisted State 落后于 Archive (Recovery Pending)
          this.checkAndAutoRecoverConsistency();
        } else if (corruptDetected) {
          // P0-09: 文件损坏时，优先从 experiences.jsonl 执行离线 Replay 重建
          this.rebuildFromArchiveOrFallback();
        }
      } else {
        // subject-state.json 尚不存在时，检查是否存在已落盘的经历归档以自愈（如首次关窗 Archive 落盘后进程崩溃）
        this.checkAndAutoRecoverConsistency();
      }
    } catch {
      // 异常恢复
    }
  }

  /**
   * P0-09: 从 experiences.jsonl 离线 Replay 重建受损状态，记录 recovery_event
   */
  rebuildFromArchiveOrFallback() {
    const archivePath = path.join(this.dir, 'experiences.jsonl');
    if (fs.existsSync(archivePath)) {
      try {
        const { ExperiencesArchive } = require('./experiences-archive');
        const archive = new ExperiencesArchive(this.dir);
        const { records, diagnostics } = archive.readAllWithDiagnostics();
        if (records && records.length > 0) {
          console.log(`[SubjectState] 正在从 experiences.jsonl (${records.length} 条记录) 重建损坏的 Subject State...`);
          const replayReport = SubjectState.replay(records, { diagnostics, archivePath });
          const newWindowNo = (typeof replayReport.nextWindowNo === 'number' && !Number.isNaN(replayReport.nextWindowNo))
            ? replayReport.nextWindowNo
            : (Math.max(0, ...replayReport.windowStates.map(w => (typeof w.windowNo === 'number' && !Number.isNaN(w.windowNo)) ? w.windowNo : 0)) + 1);

          this.committedEvidenceIds = new Set(replayReport.acceptedEvidenceIds || []);
          this.committedFingerprints = new Set(replayReport.acceptedEvidenceFingerprints || []);
          const isCertified = replayReport.integrity === 'certified' && replayReport.replayStatus === 'complete';
          this.recoveryStatus = isCertified ? 'NORMAL' : 'RECOVERY_UNCERTIFIED';
          this.recoveryPending = !isCertified;
          this.recoveryPendingReason = isCertified ? null : 'archive_uncertified';

          this.data = {
            schemaVersion: SCHEMA_VERSION,
            updatedAt: Date.now(),
            windowNo: newWindowNo,
            values: { ...DEFAULT_TRAITS, ...replayReport.finalState },
            history: replayReport.windowStates.map(w => ({
              windowNo: w.windowNo,
              at: w.timestamp || Date.now(),
              deltas: w.deltas,
              evidenceCount: w.evidenceCount
            })),
            stateChanges: replayReport.stateChanges || [],
            seenFingerprints: Array.from(this.committedFingerprints),
            seenEvidenceIds: Array.from(this.committedEvidenceIds),
            recoveryStatus: this.recoveryStatus
          };
          this.updateSnapshot();
          this.save(true);

          archive.appendRecord('recovery_event', newWindowNo, {
            action: isCertified ? 'state_rebuilt_from_replay' : 'recovery_uncertified',
            timestamp: Date.now(),
            reason: 'state_file_corrupted',
            restoredWindowNo: newWindowNo,
            recordsUsed: records.length,
            diagnostics,
            integrity: replayReport.integrity
          });
          console.log(`[SubjectState] 状态重建成功 (恢复至 Window #${newWindowNo}, 状态: ${this.recoveryStatus})，已记录 recovery_event`);
          return isCertified;
        }
      } catch (err) {
        console.error('[SubjectState] 从归档重建状态失败:', err.message);
      }
    }

    // 无法重建时安全回退至 DEFAULT_TRAITS
    this.recoveryStatus = 'RECOVERY_FAILED';
    this.data = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(),
      windowNo: 1,
      values: { ...DEFAULT_TRAITS },
      history: [],
      stateChanges: [],
      seenFingerprints: [],
      seenEvidenceIds: [],
      recoveryStatus: 'RECOVERY_FAILED'
    };
    this.committedFingerprints = new Set();
    this.committedEvidenceIds = new Set();
    this.updateSnapshot();
    this.save(true);
    try {
      const { ExperiencesArchive } = require('./experiences-archive');
      const archive = new ExperiencesArchive(this.dir);
      archive.appendRecord('recovery_event', 1, {
        action: 'state_reset_to_default',
        timestamp: Date.now(),
        reason: 'state_file_corrupted_no_archive'
      });
    } catch {}
    return false;
  }

  save(immediate = false) {
    this.writer.markDirty();
    if (immediate) {
      this.writer.flush();
    }
  }

  flush() {
    this.writer.flush();
  }

  get values() {
    return { ...this.data.values };
  }

  get currentWindowNo() {
    return this.data.windowNo;
  }

  get stateChanges() {
    return Array.isArray(this.data.stateChanges) ? [...this.data.stateChanges] : [];
  }

  /**
   * 生成窗口内冻结的快照文本
   */
  updateSnapshot() {
    const lines = Object.entries(this.data.values)
      .map(([k, v]) => `${k}=${v}`);
    this.frozenSnapshot = '【当前主体状态快照】\n' + lines.join('\n');
    return this.frozenSnapshot;
  }

  formatSnapshot() {
    if (!this.frozenSnapshot) {
      this.updateSnapshot();
    }
    return this.frozenSnapshot;
  }

  /**
   * 创建暂存快照（用于两阶段提交与回滚）
   */
  createStagingSnapshot() {
    return {
      data: JSON.parse(JSON.stringify(this.data)),
      committedFingerprints: Array.from(this.committedFingerprints),
      committedEvidenceIds: Array.from(this.committedEvidenceIds)
    };
  }

  /**
   * 回滚暂存状态（若 Archive 写入失败时调用）
   */
  rollbackStage(stagedSnapshot) {
    if (stagedSnapshot) {
      if (stagedSnapshot.data) {
        this.data = JSON.parse(JSON.stringify(stagedSnapshot.data));
        this.committedFingerprints = new Set(stagedSnapshot.committedFingerprints || []);
        this.committedEvidenceIds = new Set(stagedSnapshot.committedEvidenceIds || []);
      } else {
        this.data = JSON.parse(JSON.stringify(stagedSnapshot));
        this.committedFingerprints = new Set(this.data.seenFingerprints || []);
        this.committedEvidenceIds = new Set(this.data.seenEvidenceIds || []);
      }
      this.updateSnapshot();
    }
  }

  /**
   * 提交持久化（Archive 成功写入后调用）(P0-01)
   */
  commit() {
    this.updateSnapshot();
    try {
      this.save(true);
      this.recoveryPending = false;
      this.recoveryPendingReason = null;
      this.recoveryStatus = 'NORMAL';
      this.data.recoveryStatus = 'NORMAL';
      return true;
    } catch (err) {
      this.recoveryPending = true;
      this.recoveryPendingReason = 'state_commit_failed';
      this.recoveryStatus = 'RECOVERY_PENDING';
      this.data.recoveryStatus = 'RECOVERY_PENDING';
      console.error('[SubjectState] commit 写入磁盘失败，进入 recovery_pending 状态:', err.message);
      return false;
    }
  }

  /**
   * P0-01 & P0-03: 从 recovery_pending 状态中执行离线 Replay 恢复
   * 
   * 恢复规则：
   * - COMPLETE + CERTIFIED: 允许自动恢复，清除 recovery_pending，标记 NORMAL，记录 state_rebuilt_from_replay
   * - PARTIAL + UNCERTIFIED: 归档存在坏行/缺失，不得声明完整恢复，保持 recovery_pending，标记 RECOVERY_UNCERTIFIED，记录 recovery_uncertified
   * - INVALID: 归档为空或不可读，拒绝恢复，标记 RECOVERY_FAILED，不覆盖已有有效状态
   */
  recoverFromPending(archiveInstance = null, reason = 'state_commit_failed') {
    let archive = archiveInstance;
    if (!archive) {
      const { ExperiencesArchive } = require('./experiences-archive');
      archive = new ExperiencesArchive(this.dir);
    }

    const { records, diagnostics } = archive.readAllWithDiagnostics();
    if (!records || records.length === 0) {
      this.recoveryStatus = 'RECOVERY_FAILED';
      this.data.recoveryStatus = 'RECOVERY_FAILED';
      return false;
    }

    const replayReport = SubjectState.replay(records, { diagnostics, archivePath: archive.path });
    if (!replayReport || replayReport.replayStatus === 'invalid') {
      this.recoveryStatus = 'RECOVERY_FAILED';
      this.data.recoveryStatus = 'RECOVERY_FAILED';
      return false;
    }

    const beforeValues = { ...this.data.values };
    const afterValues = { ...replayReport.finalState };

    const diffs = [];
    for (const [k, v] of Object.entries(afterValues)) {
      if (beforeValues[k] !== v) {
        diffs.push({ trait: k, before: beforeValues[k], after: v });
      }
    }

    const newWindowNo = (typeof replayReport.nextWindowNo === 'number' && !Number.isNaN(replayReport.nextWindowNo))
      ? replayReport.nextWindowNo
      : (Math.max(0, ...replayReport.windowStates.map(w => (typeof w.windowNo === 'number' && !Number.isNaN(w.windowNo)) ? w.windowNo : 0)) + 1);
    const isCertified = replayReport.integrity === 'certified' && replayReport.replayStatus === 'complete';

    if (isCertified) {
      this.data.values = { ...DEFAULT_TRAITS, ...afterValues };
      this.data.windowNo = newWindowNo;
      this.data.updatedAt = Date.now();
      this.data.history = replayReport.windowStates.map(w => ({
        windowNo: w.windowNo,
        at: w.timestamp || Date.now(),
        deltas: w.deltas,
        evidenceCount: w.evidenceCount
      }));
      this.data.stateChanges = replayReport.stateChanges || [];
      this.committedEvidenceIds = new Set(replayReport.acceptedEvidenceIds || []);
      this.committedFingerprints = new Set(replayReport.acceptedEvidenceFingerprints || []);
      this.data.seenEvidenceIds = Array.from(this.committedEvidenceIds);
      this.data.seenFingerprints = Array.from(this.committedFingerprints);
      this.recoveryPending = false;
      this.recoveryPendingReason = null;
      this.recoveryStatus = 'NORMAL';
      this.data.recoveryStatus = 'NORMAL';
      this.updateSnapshot();

      try {
        this.save(true);
      } catch (saveErr) {
        console.error('[SubjectState] recovery: 写盘依然失败:', saveErr.message);
        this.recoveryPending = true;
        this.recoveryStatus = 'RECOVERY_PENDING';
        this.data.recoveryStatus = 'RECOVERY_PENDING';
        return false;
      }

      archive.appendRecord('recovery_event', newWindowNo, {
        action: 'state_rebuilt_from_replay',
        reason,
        timestamp: Date.now(),
        restoredWindowNo: newWindowNo,
        recordsUsed: records.length,
        beforeValues,
        afterValues,
        diffs,
        diagnostics,
        integrity: 'certified'
      });

      console.log(`[SubjectState] recovery 成功：已从 Replay 重建状态至 Window #${newWindowNo}，已写入 recovery_event`);
      return true;
    } else {
      // PARTIAL + UNCERTIFIED: 不得伪装成完整恢复
      this.recoveryPending = true;
      this.recoveryPendingReason = 'archive_uncertified';
      this.recoveryStatus = 'RECOVERY_UNCERTIFIED';
      this.data.recoveryStatus = 'RECOVERY_UNCERTIFIED';
      this.updateSnapshot();
      try {
        this.save(true);
      } catch {}

      archive.appendRecord('recovery_event', newWindowNo, {
        action: 'recovery_uncertified',
        reason: 'archive_corrupt_or_partial',
        timestamp: Date.now(),
        restoredWindowNo: newWindowNo,
        recordsUsed: records.length,
        diagnostics,
        integrity: 'uncertified',
        replayStatus: replayReport.replayStatus
      });

      console.warn(`[SubjectState] recovery 未认证：经历归档存在损坏行或不完整，保持 recovery_pending 并标记 RECOVERY_UNCERTIFIED`);
      return false;
    }
  }

  /**
   * P0-01: 启动与初始化时的一致性自检与自愈
   */
  checkAndAutoRecoverConsistency() {
    const archivePath = path.join(this.dir, 'experiences.jsonl');
    if (!fs.existsSync(archivePath)) return;
    try {
      const { ExperiencesArchive } = require('./experiences-archive');
      const archive = new ExperiencesArchive(this.dir);
      const { records } = archive.readAllWithDiagnostics();
      if (!records || records.length === 0) return;

      const hasPendingRecovery = records.some(r =>
        (r.recordType === 'recovery_event' || r.type === 'recovery_event') &&
        (r.payload?.recoveryPending === true || r.recoveryPending === true)
      );

      const NON_STATE = new Set([
        'recovery_event',
        'diagnostic',
        'replay_report',
        'internal_log',
        'audit_log',
        'self_projection',
        'subject_dream',
        'memory_dynamics_snapshot'
      ]);
      let maxArchiveWindow = 0;
      for (const r of records) {
        const recType = r.recordType || r.type;
        if (NON_STATE.has(recType)) continue;
        const wNo = (typeof r.windowNo === 'number' && !Number.isNaN(r.windowNo))
          ? r.windowNo
          : ((r.payload && typeof r.payload.windowNo === 'number' && !Number.isNaN(r.payload.windowNo))
            ? r.payload.windowNo
            : null);
        if (wNo !== null && wNo > maxArchiveWindow) maxArchiveWindow = wNo;
      }

      if (hasPendingRecovery || (maxArchiveWindow >= this.data.windowNo && maxArchiveWindow > 0)) {
        console.warn(`[SubjectState] 检测到持久化状态 (Window #${this.data.windowNo}) 落后于归档 (Window #${maxArchiveWindow})，触发一致性恢复...`);
        this.recoveryPending = true;
        this.recoverFromPending(archive, 'state_commit_failed');
      }
    } catch (err) {
      console.error('[SubjectState] checkAndAutoRecoverConsistency 异常:', err.message);
    }
  }

  /**
   * Provenance 强验证：由程序发 ID，由程序验 ID (v0.9.4-R1 强化版)
   * 
   * 检验项：
   * 1. Trait 严格白名单核验 (ALLOWED_TRAITS)
   * 2. messageId 必须是非空字符串且真实存在于窗口消息列表中；
   * 3. quote 摘录必须非空且严格作为子串出现在对应的原始消息 content 中；
   * 4. direction 必须在 [-1, +1]，strength 必须在 [0, 1]；
   * 5. Evidence 防重：同一 evidenceId 拒绝重复提交 (DUPLICATE_EVIDENCE_ID)；
   * 6. 指纹防重：同一 trait+direction+strength+messageId+quote 拒绝重复入库 (DUPLICATE_EVIDENCE_FINGERPRINT)。
   */
  verifyEvidence(evidenceList, messages, windowNo = null, opts = {}) {
    if (!Array.isArray(evidenceList) || evidenceList.length === 0) {
      return { verified: [], rejected: [] };
    }

    let msgMap;
    if (messages instanceof Map) {
      msgMap = messages;
    } else if (Array.isArray(messages)) {
      msgMap = new Map();
      for (const m of messages) {
        if (m && m.messageId) msgMap.set(m.messageId, m);
      }
    } else if (messages && typeof messages === 'object') {
      msgMap = new Map();
      for (const [k, v] of Object.entries(messages)) {
        if (v) msgMap.set(k, v);
      }
    } else {
      msgMap = new Map();
    }

    const verified = [];
    const rejected = [];
    const seenEvidenceIds = new Set();
    const seenFingerprints = new Set();

    for (const item of evidenceList) {
      evidenceGlobalSeq++;
      const evidenceId = (item && item.evidenceId) || ('ev-' + String(evidenceGlobalSeq).padStart(6, '0'));

      if (!item || typeof item !== 'object') {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'INVALID_OBJECT',
          windowNo,
          item,
          createdAt: Date.now()
        });
        continue;
      }

      const { trait, direction, strength, messageId, quote } = item;

      // 1. Trait 白名单强校验 (P0-03)
      if (typeof trait !== 'string' || !trait.trim()) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'INVALID_TRAIT',
          windowNo,
          messageId: String(messageId || ''),
          quote: String(quote || ''),
          createdAt: Date.now()
        });
        continue;
      }
      const cleanTrait = trait.trim().toLowerCase();
      if (!ALLOWED_TRAITS.has(cleanTrait)) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'TRAIT_NOT_IN_WHITELIST',
          windowNo,
          trait,
          messageId: String(messageId || ''),
          quote: String(quote || ''),
          createdAt: Date.now()
        });
        continue;
      }

      // 2. evidenceId 唯一性校验 (P0-01 联合四层校验：本调用 seenEvidenceIds + 持久化 committedEvidenceIds)
      if (seenEvidenceIds.has(evidenceId) || this.committedEvidenceIds.has(evidenceId)) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'DUPLICATE_EVIDENCE_ID',
          windowNo,
          trait: cleanTrait,
          messageId: String(messageId || ''),
          createdAt: Date.now()
        });
        continue;
      }

      // 3. messageId 检查（P0-2: 复用 experience-schema.checkMessageReference 单一事实来源）
      // 3.1 目标窗口匹配强核验 (v0.9.6 P0-07)
      const targetWindowNo = (typeof windowNo === 'number' && !Number.isNaN(windowNo))
        ? windowNo
        : ((opts && typeof opts.windowNo === 'number' && !Number.isNaN(opts.windowNo)) ? opts.windowNo : null);
      const refCheck = checkMessageReference(messageId, msgMap, targetWindowNo);
      if (!refCheck.ok) {
        const rej = {
          evidenceId,
          status: 'rejected',
          reason: refCheck.reason,
          windowNo: refCheck.reason === 'MESSAGE_WINDOW_MISMATCH' ? targetWindowNo : windowNo,
          trait: cleanTrait,
          messageId: String((refCheck.messageId || messageId) || ''),
          quote: String(quote || ''),
          createdAt: Date.now()
        };
        if (refCheck.reason === 'MESSAGE_WINDOW_MISMATCH') rej.messageWindowNo = refCheck.messageWindowNo;
        if (refCheck.reason === 'INVALID_MESSAGE_ROLE') rej.role = refCheck.role;
        rejected.push(rej);
        continue;
      }
      const sourceMsg = refCheck.message;

      // 4. quote 摘录检验（P0-2: 复用 checkQuoteInMessage；严格要求原文子串匹配）
      const quoteCheck = checkQuoteInMessage(quote, sourceMsg);
      if (!quoteCheck.ok) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: quoteCheck.reason,
          windowNo,
          trait: cleanTrait,
          messageId: String((refCheck.messageId || messageId) || ''),
          ...(quoteCheck.reason === 'QUOTE_NOT_IN_SOURCE_MESSAGE' ? { quote: String(quote || '').trim() } : {}),
          createdAt: Date.now()
        });
        continue;
      }

      // 5. 数值方向与强度校验
      const numDir = Number(direction);
      const numStr = Number(strength);
      if (!Number.isFinite(numDir) || numDir < -1 || numDir > 1) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'DIRECTION_OUT_OF_BOUNDS',
          windowNo,
          trait: cleanTrait,
          messageId: messageId.trim(),
          direction: numDir,
          createdAt: Date.now()
        });
        continue;
      }
      if (!Number.isFinite(numStr) || numStr < 0 || numStr > 1) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'STRENGTH_OUT_OF_BOUNDS',
          windowNo,
          trait: cleanTrait,
          messageId: messageId.trim(),
          strength: numStr,
          createdAt: Date.now()
        });
        continue;
      }

      // 6. Evidence Fingerprint 防重复提交校验 (P0-01: 移除 strength，联合四层校验：当前批次 + 持久化 fingerprints)
      const cleanDir = clamp(numDir, -1, 1);
      const cleanStr = clamp(numStr, 0, 1);
      const cleanMsgId = messageId.trim();
      const normQuote = normalizeQuote(quote);
      const fingerprint = `${cleanMsgId}:${normQuote}:${cleanTrait}:${cleanDir}`;
      if (seenFingerprints.has(fingerprint) || this.committedFingerprints.has(fingerprint)) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'DUPLICATE_EVIDENCE_FINGERPRINT',
          windowNo,
          trait: cleanTrait,
          messageId: cleanMsgId,
          quote: quote.trim(),
          fingerprint,
          createdAt: Date.now()
        });
        continue;
      }

      seenEvidenceIds.add(evidenceId);
      seenFingerprints.add(fingerprint);
      this.committedEvidenceIds.add(evidenceId);
      this.committedFingerprints.add(fingerprint);
      this.data.seenEvidenceIds = Array.from(this.committedEvidenceIds);
      this.data.seenFingerprints = Array.from(this.committedFingerprints);

      verified.push({
        evidenceId,
        status: 'verified',
        fingerprint,
        trait: cleanTrait,
        direction: cleanDir,
        strength: cleanStr,
        messageId: cleanMsgId,
        quote: quote.trim(),
        sourceRole: sourceMsg.role || 'unknown',
        windowNo,
        createdAt: Date.now()
      });
    }

    if (!opts.stageOnly && verified.length > 0) {
      this.save(true);
    }

    return { verified, rejected };
  }

  /**
   * 确定性状态 Reducer：新状态 = 旧状态 + clamp(∑(direction * strength * effectiveStepWeight), -maxDelta, maxDelta)
   */
  reduce(verifiedEvidence, windowNo, opts = {}) {
    const baseStepWeight = opts.baseStepWeight ?? opts.stepWeight ?? this.stepWeight;
    const maxDelta = opts.maxDeltaPerWindow ?? this.maxDeltaPerWindow;
    const targetWindowNo = windowNo ?? this.data.windowNo;

    // v0.9.7: 沃丁顿发育景观与经历依赖塑性衰减 (Canalization)
    const { computePlasticityMultiplier } = require('./canalization');
    const canalizationEnabled = opts.canalization !== undefined
      ? Boolean(opts.canalization)
      : (opts.experimentModules
          ? Boolean(opts.experimentModules.biographicalCanalization)
          : (this.opts?.experimentModules ? Boolean(this.opts.experimentModules.biographicalCanalization) : false));

    const windowDepth = Math.max(0, (typeof targetWindowNo === 'number' && !Number.isNaN(targetWindowNo) ? targetWindowNo : 1) - 1);
    const plasticityMultiplier = canalizationEnabled
      ? computePlasticityMultiplier(windowDepth, { gamma: opts.gamma, enabled: true })
      : (typeof opts.plasticityMultiplier === 'number' ? opts.plasticityMultiplier : 1.0);
    const effectiveStepWeight = opts.effectiveStepWeight ?? Number((baseStepWeight * plasticityMultiplier).toFixed(6));

    // 确保接受的 verifiedEvidence 均已记入 committed 集合并持久化 (P0-01)
    for (const ev of verifiedEvidence) {
      if (ev && ev.evidenceId) this.committedEvidenceIds.add(ev.evidenceId);
      if (ev && ev.fingerprint) {
        this.committedFingerprints.add(ev.fingerprint);
      } else if (ev && ev.messageId && ev.quote && ev.trait) {
        const fp = `${ev.messageId.trim()}:${normalizeQuote(ev.quote)}:${ev.trait.trim().toLowerCase()}:${clamp(Number(ev.direction || 0), -1, 1)}`;
        this.committedFingerprints.add(fp);
      }
    }
    this.data.seenEvidenceIds = Array.from(this.committedEvidenceIds);
    this.data.seenFingerprints = Array.from(this.committedFingerprints);

    const rawDeltas = {};
    const traitEvidenceMap = {};

    for (const ev of verifiedEvidence) {
      if (!ev || !ev.trait || !ALLOWED_TRAITS.has(ev.trait)) continue;
      if (!rawDeltas[ev.trait]) {
        rawDeltas[ev.trait] = 0;
        traitEvidenceMap[ev.trait] = [];
      }
      rawDeltas[ev.trait] += ev.direction * ev.strength * effectiveStepWeight;
      if (ev.evidenceId) {
        traitEvidenceMap[ev.trait].push(ev.evidenceId);
      }
    }

    const appliedDeltas = {};
    const newChanges = [];

    for (const [trait, sum] of Object.entries(rawDeltas)) {
      const clampedDelta = clamp(symmetricRound(sum), -maxDelta, maxDelta);
      if (clampedDelta !== 0) {
        appliedDeltas[trait] = clampedDelta;
        const currentVal = this.data.values[trait] ?? 0;
        const nextVal = clamp(currentVal + clampedDelta, -999, 999);
        this.data.values[trait] = nextVal;

        const sc = createStateChange({
          windowNo: targetWindowNo,
          trait,
          previousValue: currentVal,
          delta: clampedDelta,
          newValue: nextVal,
          evidenceIds: traitEvidenceMap[trait] || [],
          baseStepWeight,
          effectiveStepWeight,
          plasticityMultiplier,
          stepWeight: effectiveStepWeight,
          maxDelta
        });
        newChanges.push(sc);
      }
    }

    const record = {
      windowNo: targetWindowNo,
      at: Date.now(),
      deltas: appliedDeltas,
      evidenceCount: verifiedEvidence.length
    };

    this.data.history.push(record);
    if (this.data.history.length > 500) {
      this.data.history.shift();
    }

    if (!Array.isArray(this.data.stateChanges)) {
      this.data.stateChanges = [];
    }
    this.data.stateChanges.push(...newChanges);
    if (this.data.stateChanges.length > 500) {
      this.data.stateChanges.splice(0, this.data.stateChanges.length - 500);
    }

    this.data.windowNo = targetWindowNo + 1;
    this.data.updatedAt = Date.now();
    this.updateSnapshot();

    if (!opts.stageOnly) {
      this.save(true);
    }

    return {
      windowNo: this.data.windowNo,
      deltas: appliedDeltas,
      values: this.values,
      stateChanges: newChanges
    };
  }

  /**
   * 离线 Replay v2 能力 (v0.9.4-R2 增强版)：
   * 1. 100% 离线确定性演化，绝不调用 LLM、绝不读取外部提示词。
   * 2. P0-07: 优先使用历史记录中落盘的 Reducer 参数（stepWeight / maxDelta），而非硬编码全局参数。
   * 3. P0-02: 排除 recovery_event / diagnostic / replay_report / internal_log 等非状态审计记录，
   *    nextWindowNo 严格按 max(actualWindowNo) + 1 计算。
   * 4. P0-01: 离线重放时同步构建并去重 acceptedEvidenceIds 与 acceptedEvidenceFingerprints。
   * 5. P0-03: 区分 complete / partial / invalid 与 certified / uncertified。
   */
  static replay(archiveRecords, options = {}) {
    const initialTraits = options.initialTraits || { ...DEFAULT_TRAITS };
    const defaultStepWeight = options.stepWeight ?? 20;
    const defaultMaxDelta = options.maxDeltaPerWindow ?? 50;
    const targetUntilWindow = options.untilWindow ?? null;
    const targetUntilTimestamp = options.untilTimestamp ?? null;

    if (!Array.isArray(archiveRecords)) {
      return {
        replayStatus: 'invalid',
        integrity: 'uncertified',
        corruptRecords: 0,
        initialState: { ...initialTraits },
        windowStates: [],
        trajectory: [],
        stateChanges: [],
        finalState: { ...initialTraits },
        finalValues: { ...initialTraits },
        latestWindowNo: 0,
        nextWindowNo: 1,
        acceptedEvidenceIds: [],
        acceptedEvidenceFingerprints: [],
        processedRecords: 0,
        rejectedRecords: 0,
        warnings: []
      };
    }

    const currentValues = { ...initialTraits };
    const windowStates = [];
    const allStateChanges = [];
    const warnings = [];
    const acceptedEvidenceIds = new Set();
    const acceptedEvidenceFingerprints = new Set();
    const actualWindowNos = [];
    let processedRecords = 0;
    let rejectedRecords = 0;

    // P0-3: 统一完整性权威可信源——调用 ArchiveIntegrityService (或直接使用外部传入的权威完整性报告)
    let integrityReport = options.integrityReport;
    if (!integrityReport) {
      const { ArchiveIntegrityService } = require('./archive-integrity');
      if (options.archivePath && fs.existsSync(options.archivePath)) {
        integrityReport = ArchiveIntegrityService.checkArchive(options.archivePath);
      } else {
        integrityReport = ArchiveIntegrityService.checkRecords(archiveRecords, options);
      }
    }

    const isCertified = integrityReport && integrityReport.integrity === 'certified';
    const integrity = isCertified ? 'certified' : 'uncertified';
    const replayStatus = (integrityReport && integrityReport.replayStatus) || (options.corruptRecords > 0 ? 'partial' : 'complete');
    const corruptCount = (integrityReport && integrityReport.corruptLines) ?? (options.corruptRecords ?? (options.diagnostics ? options.diagnostics.skippedCount : 0));

    const NON_STATE_RECORD_TYPES = new Set([
      'recovery_event',
      'diagnostic',
      'replay_report',
      'internal_log',
      'audit_log',
      'self_projection',
      'subject_dream',
      'memory_dynamics_snapshot'
    ]);

    // 标准化并按 archiveSeq（优先）或时间戳升序排序 (v0.9.6 P0-05)
    const normalized = [];
    let hasArchiveSeq = false;
    for (const r of archiveRecords) {
      const norm = normalizeArchiveRecord(r);
      if (norm) {
        if (typeof norm.archiveSeq === 'number' && !Number.isNaN(norm.archiveSeq)) {
          hasArchiveSeq = true;
        }
        normalized.push(norm);
      }
    }
    const ordering = hasArchiveSeq ? 'archive_seq' : 'legacy';
    if (hasArchiveSeq) {
      normalized.sort((a, b) => {
        const seqA = typeof a.archiveSeq === 'number' ? a.archiveSeq : Infinity;
        const seqB = typeof b.archiveSeq === 'number' ? b.archiveSeq : Infinity;
        if (seqA !== seqB) return seqA - seqB;
        return (a.timestamp || 0) - (b.timestamp || 0);
      });
    } else {
      normalized.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    for (const record of normalized) {
      const recType = record.recordType || record.type || (record.payload && record.payload.type) || '';
      // P0-02: 审计与诊断记录不得计入 Window State 聚合
      if (NON_STATE_RECORD_TYPES.has(recType)) {
        continue;
      }

      const wNo = (typeof record.windowNo === 'number' && !Number.isNaN(record.windowNo))
        ? record.windowNo
        : (record.windowNo === null ? null : (record.payload && typeof record.payload.windowNo === 'number' && !Number.isNaN(record.payload.windowNo) ? record.payload.windowNo : null));
      const ts = record.timestamp || 0;

      // 窗口与时间过滤闸门
      if (targetUntilWindow !== null && wNo !== null && wNo > targetUntilWindow) continue;
      if (targetUntilTimestamp !== null && ts > targetUntilTimestamp) continue;

      let evidence = [];
      let rej = [];

      // 提取证据列表（兼容不同历史记录类型）
      if (record.payload && Array.isArray(record.payload.verifiedEvidence)) {
        evidence = record.payload.verifiedEvidence;
        rej = Array.isArray(record.payload.rejectedEvidence) ? record.payload.rejectedEvidence : [];
      } else if (Array.isArray(record.verifiedEvidence)) {
        evidence = record.verifiedEvidence;
        rej = Array.isArray(record.rejectedEvidence) ? record.rejectedEvidence : [];
      } else if (record.recordType === 'evidence' && record.payload) {
        if (record.payload.status === 'verified') evidence = [record.payload];
        else if (record.payload.status === 'rejected') rej = [record.payload];
      } else if (record.recordType === 'evidence_rejected' && record.payload) {
        rej = [record.payload];
      }

      // P0-07 & v0.9.7: 提取本窗口历史 Reducer 参数 (含发育阻尼塑性参数)
      let stepWeight = options.forceReducerParams ? defaultStepWeight : null;
      let maxDelta = options.forceReducerParams ? defaultMaxDelta : null;
      let baseStepWeight = defaultStepWeight;
      let plasticityMultiplier = 1.0;

      if (stepWeight === null) {
        const histChanges = (record.payload && Array.isArray(record.payload.stateChanges))
          ? record.payload.stateChanges
          : (Array.isArray(record.stateChanges) ? record.stateChanges : []);
        const firstChange = histChanges[0] || {};
        const histReducer = (firstChange && firstChange.reducer)
          || (record.payload && record.payload.reducer)
          || record.reducer;

        if (histReducer && typeof histReducer.stepWeight === 'number') {
          stepWeight = histReducer.stepWeight;
          maxDelta = histReducer.maxDelta ?? defaultMaxDelta;
          baseStepWeight = histReducer.baseStepWeight ?? firstChange.baseStepWeight ?? defaultStepWeight;
          plasticityMultiplier = histReducer.plasticityMultiplier ?? firstChange.plasticityMultiplier ?? 1.0;
        } else {
          stepWeight = defaultStepWeight;
          maxDelta = defaultMaxDelta;
          warnings.push({
            windowNo: wNo,
            code: 'legacy_reducer_parameters',
            message: `Window #${wNo} missing historical reducer parameters, fallback to legacy defaults (stepWeight=${stepWeight}, maxDelta=${maxDelta})`
          });
        }
      }

      processedRecords++;
      rejectedRecords += rej.length;
      if (typeof wNo === 'number' && !Number.isNaN(wNo)) {
        actualWindowNos.push(wNo);
      }

      const rawDeltas = {};
      const traitEvidenceMap = {};
      for (const ev of evidence) {
        const trait = ev.trait;
        if (!trait || !ALLOWED_TRAITS.has(trait)) continue;

        const cleanMsgId = String(ev.messageId || '').trim();
        const normQuote = normalizeQuote(ev.quote || '');
        const cleanDir = clamp(Number(ev.direction || 0), -1, 1);
        const fp = ev.fingerprint || (cleanMsgId && normQuote ? `${cleanMsgId}:${normQuote}:${trait.trim().toLowerCase()}:${cleanDir}` : null);

        // P0-01: Replay 过程防重并收集已接受证据标识
        if (ev.evidenceId && acceptedEvidenceIds.has(ev.evidenceId)) continue;
        if (fp && acceptedEvidenceFingerprints.has(fp)) continue;
        if (ev.evidenceId) acceptedEvidenceIds.add(ev.evidenceId);
        if (fp) acceptedEvidenceFingerprints.add(fp);

        if (!rawDeltas[trait]) {
          rawDeltas[trait] = 0;
          traitEvidenceMap[trait] = [];
        }
        rawDeltas[trait] += (ev.direction || 0) * (ev.strength || 0) * stepWeight;
        if (ev.evidenceId) traitEvidenceMap[trait].push(ev.evidenceId);
      }

      const deltas = {};
      const stepChanges = [];
      for (const [trait, sum] of Object.entries(rawDeltas)) {
        const clampedDelta = clamp(symmetricRound(sum), -maxDelta, maxDelta);
        if (clampedDelta !== 0) {
          deltas[trait] = clampedDelta;
          const curr = currentValues[trait] ?? 0;
          const next = clamp(curr + clampedDelta, -999, 999);
          currentValues[trait] = next;

          stepChanges.push(createStateChange({
            windowNo: wNo,
            trait,
            previousValue: curr,
            delta: clampedDelta,
            newValue: next,
            evidenceIds: traitEvidenceMap[trait] || [],
            baseStepWeight,
            effectiveStepWeight: stepWeight,
            plasticityMultiplier,
            stepWeight,
            maxDelta
          }));
        }
      }

      windowStates.push({
        windowNo: wNo,
        deltas,
        values: { ...currentValues },
        evidenceCount: evidence.length,
        timestamp: ts
      });
      allStateChanges.push(...stepChanges);
    }

    const latestWindowNo = actualWindowNos.length > 0 ? Math.max(...actualWindowNos) : 0;
    const nextWindowNo = latestWindowNo + 1;

    return {
      replayStatus,
      integrity,
      archiveIntegrity: (integrityReport && integrityReport.integrity) || integrity,
      syntax_integrity: (integrityReport && integrityReport.syntax_integrity) || (corruptCount > 0 ? 'corrupted' : 'valid'),
      sequence_integrity: (integrityReport && integrityReport.sequence_integrity) || (hasArchiveSeq ? 'monotonic' : 'legacy'),
      hash_integrity: (integrityReport && integrityReport.hash_integrity) || (hasArchiveSeq ? 'verified' : 'legacy'),
      ordering,
      orderingIntegrity: ordering,
      hasLegacyAdapter: !!(integrityReport && integrityReport.hasLegacyAdapter),
      corruptRecords: corruptCount,
      initialState: { ...initialTraits },
      windowStates,
      trajectory: windowStates,
      stateChanges: allStateChanges,
      finalState: { ...currentValues },
      finalValues: { ...currentValues },
      latestWindowNo,
      nextWindowNo,
      acceptedEvidenceIds: Array.from(acceptedEvidenceIds),
      acceptedEvidenceFingerprints: Array.from(acceptedEvidenceFingerprints),
      processedRecords,
      rejectedRecords,
      warnings
    };
  }

  /**
   * 重放指定窗口
   */
  static replayWindow(archiveRecords, windowNo, options = {}) {
    return SubjectState.replay(archiveRecords, {
      ...options,
      untilWindow: windowNo
    });
  }

  /**
   * 重放直到指定窗口
   */
  static replayUntilWindow(archiveRecords, windowNo, options = {}) {
    return SubjectState.replay(archiveRecords, {
      ...options,
      untilWindow: windowNo
    });
  }

  /**
   * 重放直到指定时间戳
   */
  static replayUntilTimestamp(archiveRecords, timestamp, options = {}) {
    return SubjectState.replay(archiveRecords, {
      ...options,
      untilTimestamp: timestamp
    });
  }

  /**
   * 状态一致性校验：核对当前磁盘持久化 State 与 Replay 离线推演值 (P1-04)
   */
  static checkConsistency(persistedState, replayReport) {
    const pValues = (persistedState && persistedState.values) ? persistedState.values : {};
    const rValues = (replayReport && replayReport.finalState) ? replayReport.finalState : {};
    const diffs = [];

    const allKeys = new Set([...Object.keys(pValues), ...Object.keys(rValues)]);
    for (const k of allKeys) {
      const pVal = pValues[k] ?? 0;
      const rVal = rValues[k] ?? 0;
      if (pVal !== rVal) {
        diffs.push({ trait: k, persisted: pVal, replayed: rVal });
      }
    }

    const pWindowNo = persistedState ? (persistedState.windowNo ?? persistedState.currentWindowNo ?? (persistedState.data && persistedState.data.windowNo)) : undefined;
    const windowNoMatch = (pWindowNo !== undefined && replayReport && replayReport.nextWindowNo !== undefined)
      ? pWindowNo === replayReport.nextWindowNo
      : true;

    const pEvIds = persistedState ? (persistedState.seenEvidenceIds || (persistedState.data && persistedState.data.seenEvidenceIds) || (persistedState.committedEvidenceIds ? Array.from(persistedState.committedEvidenceIds) : undefined)) : undefined;
    const acceptedEvidenceMatch = (Array.isArray(pEvIds) && replayReport && Array.isArray(replayReport.acceptedEvidenceIds))
      ? (pEvIds.length === replayReport.acceptedEvidenceIds.length && replayReport.acceptedEvidenceIds.every(id => pEvIds.includes(id)))
      : true;

    const pChanges = persistedState ? (persistedState.stateChanges || (persistedState.data && persistedState.data.stateChanges)) : undefined;
    const stateChangesMatch = (Array.isArray(pChanges) && replayReport && Array.isArray(replayReport.stateChanges))
      ? pChanges.length === replayReport.stateChanges.length
      : true;

    const match = diffs.length === 0 && windowNoMatch && acceptedEvidenceMatch && stateChangesMatch;
    const isCertified = replayReport ? replayReport.integrity !== 'uncertified' : true;

    return {
      match,
      windowNoMatch,
      acceptedEvidenceMatch,
      stateChangesMatch,
      certified: match && isCertified,
      status: (match && isCertified) ? 'PASS' : (match && !isCertified ? 'NOT_CERTIFIED' : 'MISMATCH'),
      integrity: replayReport ? replayReport.integrity : 'certified',
      replayStatus: replayReport ? replayReport.replayStatus : 'complete',
      diffs
    };
  }
}

module.exports = { SubjectState, DEFAULT_TRAITS, ALLOWED_TRAITS, normalizeQuote };
