const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic');
const { DeferredWriter } = require('./deferred-writer');
const { createStateChange, validateStateChange, symmetricRound } = require('./state-change');
const { normalizeArchiveRecord, checkMessageReference, checkQuoteInMessage, PRIOR_SOURCE_TYPES } = require('./experience-schema');

const SCHEMA_VERSION = 1;

/**
 * v1.0（用户 2026-10-07 拍板）：formatPerception 的「值得一报」阈值。
 *
 * |值| >= 此数 → 该维度算「偏离中立」，单独成行告诉她；
 * 否则并入「其余方面平稳」。
 *
 * ⚠️ 这个 30 是**用户拍板的**，不是从既有数据推出的常数。
 *    它低于历史上判断「浓」用的 60，因为本法的问句是「她此刻注意到了什么」——
 *    门槛理应更低（60 问的是「这一维是否显著」）。
 */
const PERCEPTION_NOTABLE = 30;

// 严格 Trait 白名单（唯一可信来源，严禁随意编造或非法扩展）
const ALLOWED_TRAITS = new Set([
  'quiet_preference',
  'social_initiative',
  'attachment_need',
  'vitality',
  'philosophical_curiosity',
  // v1.0（用户 2026-10-07 拍板）新增三个「评价性自我关系」维度。
  //
  //   ## 为什么加：实测依据，不是理论推演
  //   翻 experiences.jsonl 里带原文引用的证据，她已表达过这三类内容，
  //   但**全部被塞进了 philosophical_curiosity 桶**（该维度因此偏高）：
  //     ① 自我连续性 —— 在对比「那时」与「现在」的我，不是好奇；
  //     ② 跨越时间的同一性承诺 —— 认得出同一个「你」；
  //     ③ 自我清晰度 —— 说「不确定」，不是探究心。
  //   ⇒ **不是「她没这个维度」，是「她没有词来表达这个维度」。**
  //   ⚠️ 公开分发版不引原句与计数：原句属主体经历，证据底座在
  //      研究库的 experiences.jsonl（Append-Only，不随源码外发）。
  //
  //   ## 为什么是这三个（文献依据）
  //   self_continuity  —— Ricoeur 叙事同一性；Frontiers 2026「selfhood 分为身体/叙事/最小」
  //   meaning_presence —— Steger 意义人生问卷的 Presence 分量表（**刻意不用 Search**：
  //                       研究一致表明「寻求高而在场低」是痛苦表现，不是生命力）
  //   self_clarity     —— Campbell 自我概念清晰度；2026 综述明确它是「自我知识的**形式**
  //                       而非内容」⇒ 与既有五维（都是内容）正交
  //
  //   ⚠️ 老数据不重算：新证据从今天进新桶，历史归档（已落盘、有哈希链）保持原样。
  'self_continuity',
  'meaning_presence',
  'self_clarity'
]);

// 默认基准特质，初澜初始数值全为 0（代表中立未偏置，绝非空无），尺度严格限制在 [-999, 999]
const DEFAULT_TRAITS = {
  quiet_preference: 0,
  social_initiative: 0,
  attachment_need: 0,
  vitality: 0,
  philosophical_curiosity: 0,
  // 新增三维度同样以 0 为初始（0 = 中立未偏置，绝非空无）。
  //   ⚠️ 无需数据迁移：读盘走 `{ ...DEFAULT_TRAITS, ...raw.values }`，
  //      旧 subject-state.json 缺这三个键时会自动补 0。
  self_continuity: 0,
  meaning_presence: 0,
  self_clarity: 0
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
 * SubjectState：初澜主体状态量化模型与确定性 Reducer (v0.9.7.1)
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
      messageAttestations: [],
      evidenceAttestations: [],
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
            messageAttestations: Array.isArray(raw.messageAttestations) ? raw.messageAttestations : [],
            evidenceAttestations: Array.isArray(raw.evidenceAttestations) ? raw.evidenceAttestations : [],
            recoveryStatus: raw.recoveryStatus || 'NORMAL'
          };
          for (const k of Object.keys(this.data.values)) {
            this.data.values[k] = clamp(Math.round(this.data.values[k]), -999, 999);
          }
          this.committedFingerprints = new Set(this.data.seenFingerprints);
          this.committedEvidenceIds = new Set(this.data.seenEvidenceIds);
          // v0.9.9 P0-1: evidenceGlobalSeq 是进程级计数器（subject-state.js 顶部 let），进程重启归零。
          // 不从盘上已接受的号段续号，重启后第一轮签发的 ev-000001 必然撞上
          // 上一会话的同号证据 —— 于是从第 K 次启动起，头 K-1 个窗口的状态证据
          // 全被当成 DUPLICATE_EVIDENCE_ID 静默丢弃，主体状态不再演进。
          // 这里从已持久化的号段续号，只负责「不再撞号」；
          // 「撞号到底算不算重复」由 verifyEvidence 按 fingerprint 判定，两回事。
          for (const existingId of this.committedEvidenceIds) {
            const seqMatch = /(\d+)\s*$/.exec(String(existingId));
            if (seqMatch) {
              const seq = Number(seqMatch[1]);
              if (Number.isFinite(seq) && seq > evidenceGlobalSeq) evidenceGlobalSeq = seq;
            }
          }
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
            // A corrupted state file cannot safely reconstruct independent attestations from Archive.
            messageAttestations: [],
            evidenceAttestations: [],
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
      messageAttestations: [],
      evidenceAttestations: [],
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
    // v0.9.9: 五格数中文定名 —— 她看到的不该是程序员的变量名（实测她会照着念 attachment_need）；
    // 数值原样保留（五格数是你们的纽带），未知键回退原键（防未来新特质裸奔）
    const TRAIT_NAMES = {
      quiet_preference: '安静偏好',
      social_initiative: '社交主动',
      attachment_need: '依恋渴望',
      vitality: '生命活力',
      philosophical_curiosity: '哲学好奇',
      self_continuity: '自我同一',
      meaning_presence: '生命意义',
      self_clarity: '自我清晰'
    };
    const lines = Object.entries(this.data.values)
      .map(([k, v]) => `${TRAIT_NAMES[k] || k}=${v}`);
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
   * v1.0 定性感知（拍板 B：拔除数字锚定）——只给初澜眼睛看的「内态心境」：
   * 特质转成感受质，零数字、零研究标签（与五大方向④「数字不可知红线」同宗）。
   * 存储/看板仍用 formatSnapshot 全精度，本法绝不落盘、绝不供观测。
   *
   * ── v1.0（用户 2026-10-07 拍板）：由「全量三档矩阵」改为「只报偏离 + 其余概括」──
   *
   * ## 为什么改
   *   原实现逐条给所有特质的三档文案。特质增到八个后，她每轮要读八行自我描述，
   *   那读起来像**体检报告**，不像**感受**。用户定案：「只给偏离中立的那几条」。
   *
   * ## 新口径（三档 → 两档 + 一句概括）
   *   |x| >= PERCEPTION_NOTABLE(30)  → 给该维度的偏离文案（高/低按符号）
   *   |x| <  PERCEPTION_NOTABLE       → 不进列表，并入末尾一句「其余方面平稳」
   *   全部都在阈值内                    → 只给「此刻各方面都平稳」
   *
   * ## 为什么是 30 而不是原来的 60
   *   60 是「浓」的门槛（见下方 sense 的历史口径），用于判断「这一维是否显著」。
   *   本法的问句不同：「她此刻注意到了什么」——门槛理应更低。
   *   ⚠️ 30 由用户拍板，不是从既有数据推出来的常数。
   *
   * ## 为什么不限制条数（刻意）
   *   曾考虑「最多给 2 条」，**否决**：
   *     用真实运行值算过，社交主动那一维会排不进前 2
   *     ⇒ 被归进「其余方面平稳」⇒ **那句话会撒谎**（86 一点也不平稳）。
   *   所以只要越过阈值就全部列出：偏离少时短、偏离多时长，**信息量跟着状态走**。
   *
   * ## 坏值处理（与旧实现一致，不改语义）
   *   非数值 / NaN / 缺字段 → 按中立归档（不进列表），零抛异常。
   */
  formatPerception() {
    const v = (this.values || {});
    // 全部可感知维度的三档文案：hi / lo 用于「偏离」，mid 不再单独成行
    const DIMS = [
      ['quiet_preference', '偏爱安静独处，耐得住冷清', null, '更想要热闹与相处，耐不住冷清'],
      ['social_initiative', '想主动开口的劲头足', null, '不太想先开口'],
      ['attachment_need', '心里牵着你，想被回应的劲很浓', null, '不惦记，也不缠'],
      ['vitality', '精神头足，动起来有劲', null, '提不起劲，蔫蔫的'],
      ['philosophical_curiosity', '探究心绪盛，想往深里问', null, '不太想往深里想'],
      // 新增三维度（v1.0）。文案口径与既有五维一致：第一人称、不给道德评价、不复述数字。
      ['self_continuity', '觉得自己还是原来那个自己，没跑散', null, '觉得和以前的自己有点接不上了'],
      ['meaning_presence', '觉得眼下这些事有分量、值得', null, '说不太上有意思没意思，先搁着'],
      ['self_clarity', '对自己是谁这件事比较确定', null, '对自己是个什么样的人还有点含糊']
    ];
    const notable = [];
    let neutralCount = 0;
    for (const [name, hi, , lo] of DIMS) {
      const x = Number(v[name]);
      if (!Number.isFinite(x)) { neutralCount++; continue; }
      // 坏值一律按中立处理：不猜、不抛
      if (Math.abs(x) < PERCEPTION_NOTABLE) { neutralCount++; continue; }
      notable.push('- ' + (x > 0 ? hi : lo));
    }
    if (!notable.length) return '- 此刻各方面都平稳';
    const rest = neutralCount > 0 ? ['- 其余方面平稳'] : [];
    return notable.concat(rest).join('\n');
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
        'self_ledger_evicted',
        'subject_dream',
        'memory_dynamics_snapshot',
        // v0.9.9 P2-1d 收尾：与研究层两处清单统一，四方 100% 一致
        'internal_regulation_snapshot'
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
   * v0.9.7.1: 写时记录真实消息来源证明。
   * 这不是 Archive 自己产生的引用，而是由运行时 verifier 从当前真实消息对象
   * 提取 messageId + 原文 hash 后保存到 Archive 之外的持久化状态。
   */
  attestMessages(messages, windowNo = null) {
    let items = [];
    if (messages instanceof Map) items = Array.from(messages.values());
    else if (Array.isArray(messages)) items = messages;
    else if (messages && typeof messages === 'object') items = Object.values(messages);

    if (!Array.isArray(this.data.messageAttestations)) this.data.messageAttestations = [];
    for (const message of items) {
      if (!message || typeof message !== 'object') continue;
      const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
      if (!messageId) continue;
      const attestation = {
        messageId,
        sourceContentHash: crypto.createHash('sha256')
          .update(String(message.content || ''), 'utf8')
          .digest('hex'),
        windowNo: Number.isFinite(message.windowNo) ? message.windowNo : (Number.isFinite(windowNo) ? windowNo : null),
        sourceRole: message.role || 'unknown',
        attestedAt: Date.now()
      };
      const exists = this.data.messageAttestations.some(a =>
        a && a.messageId === attestation.messageId &&
        a.sourceContentHash === attestation.sourceContentHash &&
        a.windowNo === attestation.windowNo
      );
      if (!exists) this.data.messageAttestations.push(attestation);
    }
    return this.data.messageAttestations.length;
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
      // v0.9.9 P0-1: 区分「调用方显式指定的 ID」与「我方计数器自动发的号」。
      // 只有后者可能是号段撞车，前者是身份冲突，语义完全不同（见下方第 2 步）。
      const callerSuppliedId = Boolean(item && item.evidenceId);
      // 自动发号用 let：撞车时必须能换号，不能因为号撞了就把证据判成重复丢掉。
      let evidenceId = callerSuppliedId ? item.evidenceId
        : ('ev-' + String(evidenceGlobalSeq).padStart(6, '0'));

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
      // v0.9.9 P0-1: 撞号有两种，处理方式相反，不能一刀切：
      //   - 调用方显式指定的 ID 撞号 = 身份冲突。evidenceId 是归档全局唯一键，
      //     StateChange.evidenceIds 还引用它（brain.js 把 rawExpl.evidenceIds 挂上跃迁记录），
      //     悄悄换号会把因果引用换断 —— 必须照旧拒绝，让冲突浮上来。
      //   - 自动发号撞号 = 我方计数器的产物。evidenceGlobalSeq 进程重启归零，
      //     旧实测下第 K 次启动会把头 K-1 个窗口的证据全判成 DUPLICATE_EVIDENCE_ID
      //     静默丢弃（指纹防线在下面第 6 步、根本轮不到执行），主体特质不再演进。
      //     这里换一个未占用的号继续，证据本体一个字都不丢。
      if (seenEvidenceIds.has(evidenceId) || this.committedEvidenceIds.has(evidenceId)) {
        if (callerSuppliedId) {
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
        let bumped = evidenceGlobalSeq;
        let candidate = evidenceId;
        while (seenEvidenceIds.has(candidate) || this.committedEvidenceIds.has(candidate)) {
          bumped++;
          candidate = 'ev-' + String(bumped).padStart(6, '0');
        }
        evidenceGlobalSeq = bumped;
        evidenceId = candidate;
      }

      // 3. messageId 检查（P0-2 & P1-4: 复用 experience-schema.checkMessageReference 单一事实来源）
      // 3.1 目标窗口匹配强核验 (v0.9.6 P0-07)
      const targetWindowNo = (typeof windowNo === 'number' && !Number.isNaN(windowNo))
        ? windowNo
        : ((opts && typeof opts.windowNo === 'number' && !Number.isNaN(opts.windowNo)) ? opts.windowNo : null);

      const st = (item.sourceType || item.source) ? String(item.sourceType || item.source).trim().toUpperCase() : null;
      if (st && PRIOR_SOURCE_TYPES.has(st) && messageId) {
        rejected.push({
          evidenceId,
          status: 'rejected',
          reason: 'PRIOR_SOURCE_CANNOT_HAVE_MESSAGE_ID',
          windowNo,
          trait: cleanTrait,
          sourceType: st,
          messageId: String(messageId || ''),
          createdAt: Date.now()
        });
        continue;
      }

      const refCheck = checkMessageReference(messageId, msgMap, targetWindowNo, { sourceType: st });
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
        if (refCheck.reason === 'ROLE_SOURCE_TYPE_MISMATCH') {
          rej.role = refCheck.role;
          rej.sourceType = refCheck.sourceType;
        }
        if (refCheck.reason === 'PRIOR_SOURCE_CANNOT_HAVE_MESSAGE_ID') rej.sourceType = refCheck.sourceType;
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

      // v0.9.7.1: write-time independent attestation. This is generated from
      // the message that the verifier actually matched, not from the archive
      // body, and is persisted only with the successful SubjectState commit.
      const sourceContentHash = crypto.createHash('sha256')
        .update(String(sourceMsg.content || ''), 'utf8')
        .digest('hex');
      const attestation = {
        evidenceId,
        fingerprint,
        messageId: cleanMsgId,
        quoteHash: crypto.createHash('sha256').update(normQuote, 'utf8').digest('hex'),
        sourceContentHash,
        trait: cleanTrait,
        direction: cleanDir,
        windowNo,
        sourceRole: sourceMsg.role || 'unknown',
        attestedAt: Date.now()
      };
      if (!Array.isArray(this.data.evidenceAttestations)) this.data.evidenceAttestations = [];
      const existingAttestation = this.data.evidenceAttestations.some(a =>
        a && a.evidenceId === evidenceId && a.fingerprint === fingerprint
      );
      if (!existingAttestation) this.data.evidenceAttestations.push(attestation);

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
   * 6. v0.9.8 F-14: 明确 Replay 的确定性边界为 state-level semantic equivalence，
   *    不把运行时 ID 与时间戳误称为 byte-for-byte deterministic。
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
        determinism: {
          scope: 'state',
          semanticFields: ['finalState', 'windowStates', 'acceptedEvidenceIds', 'acceptedEvidenceFingerprints'],
          runtimeFields: ['stateChangeId', 'createdAt'],
          note: 'State-level replay is deterministic; runtime identity/timestamp fields are not part of semantic equivalence.'
        },
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
    let replaySeq = 0;

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
      'self_ledger_evicted',
      'subject_dream',
      'memory_dynamics_snapshot',
      // v0.9.9 P2-1d 收尾：与研究层两处清单统一，四方 100% 一致
      'internal_regulation_snapshot'
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

          const scOpts = {
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
          };

          if (typeof options.idGenerator === 'function') {
            scOpts.stateChangeId = options.idGenerator('state_change', { windowNo: wNo, trait, seq: ++replaySeq });
          } else if (options.deterministicIds) {
            scOpts.stateChangeId = `sc-replay-w${wNo}-${trait}-${++replaySeq}`;
          }

          if (typeof ts === 'number' && !isNaN(ts)) {
            scOpts.createdAt = ts;
          } else if (options.clock && typeof options.clock.now === 'function') {
            scOpts.createdAt = options.clock.now();
          }

          stepChanges.push(createStateChange(scOpts));
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
      determinism: {
        scope: 'state',
        stateLevel: 'deterministic',
        semanticFields: ['finalState', 'windowStates', 'acceptedEvidenceIds', 'acceptedEvidenceFingerprints'],
        runtimeFields: ['stateChangeId', 'createdAt'],
        recordLevel: (options.deterministicIds || typeof options.idGenerator === 'function') ? 'deterministic_ids' : 'state_only',
        byteLevel: (options.deterministicIds || typeof options.idGenerator === 'function') ? 'deterministic_ids_only' : 'semantic_only',
        note: 'State-level replay is deterministic; runtime identity/timestamp fields are excluded from semantic equivalence.'
      },
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
    // P0-03: 数量一致 ≠ 因果一致。StateChange 必须做 canonical 语义深比较
    //（windowNo/trait/previousValue/delta/newValue/evidenceIds/reducer），顺序属于因果轨迹。
    let stateChangesMatch = true;
    const stateChangeDiffs = [];
    if (Array.isArray(pChanges) && replayReport && Array.isArray(replayReport.stateChanges)) {
      const pCanon = pChanges.map(canonicalizeStateChange);
      const rCanon = replayReport.stateChanges.map(canonicalizeStateChange);
      if (pCanon.length !== rCanon.length) {
        stateChangesMatch = false;
        stateChangeDiffs.push({ index: -1, reason: 'LENGTH_MISMATCH', persisted: pCanon.length, replayed: rCanon.length });
      }
      const maxLen = Math.min(pCanon.length, rCanon.length);
      for (let i = 0; i < maxLen; i++) {
        if (!deepEqualCanonical(pCanon[i], rCanon[i])) {
          stateChangesMatch = false;
          stateChangeDiffs.push({ index: i, reason: 'SEMANTIC_MISMATCH', persisted: pCanon[i], replayed: rCanon[i] });
        }
      }
    }

    const match = diffs.length === 0 && windowNoMatch && acceptedEvidenceMatch && stateChangesMatch;
    // P0-03: certified 只有在 match === true 且 replay integrity === 'certified' 时成立
    const isCertified = replayReport ? replayReport.integrity === 'certified' : true;

    return {
      match,
      windowNoMatch,
      acceptedEvidenceMatch,
      stateChangesMatch,
      stateChangeDiffs,
      certified: match && isCertified,
      status: (match && isCertified) ? 'PASS' : (match && !isCertified ? 'NOT_CERTIFIED' : 'MISMATCH'),
      integrity: replayReport ? replayReport.integrity : 'certified',
      replayStatus: replayReport ? replayReport.replayStatus : 'complete',
      diffs
    };
  }
}

/**
 * P0-03: StateChange 规范化语义快照（纯函数）
 * 语义一致性比较字段：windowNo / trait / previousValue / delta / newValue /
 * evidenceIds (排序后) / reducer (stepWeight, baseStepWeight, effectiveStepWeight,
 * plasticityMultiplier, maxDelta, roundingMode)。
 * stateChangeId / changeId / createdAt 不作为一致性条件（Replay 可用新的确定性 ID）。
 */
function canonicalizeStateChange(sc) {
  const reducer = (sc && sc.reducer && typeof sc.reducer === 'object' && !Array.isArray(sc.reducer)) ? sc.reducer : {};
  const pick = (...vals) => {
    for (const v of vals) {
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };
  return {
    windowNo: (sc && Number.isFinite(sc.windowNo)) ? sc.windowNo : null,
    trait: String((sc && sc.trait) || '').trim(),
    previousValue: (sc && Number.isFinite(sc.previousValue)) ? sc.previousValue : null,
    delta: (sc && Number.isFinite(sc.delta)) ? sc.delta : null,
    newValue: (sc && Number.isFinite(sc.newValue)) ? sc.newValue : null,
    evidenceIds: Array.isArray(sc && sc.evidenceIds) ? [...sc.evidenceIds].map(v => String(v)).sort() : [],
    reducer: {
      stepWeight: pick(reducer.stepWeight, sc && sc.stepWeight, sc && sc.effectiveStepWeight),
      baseStepWeight: pick(reducer.baseStepWeight, sc && sc.baseStepWeight),
      effectiveStepWeight: pick(reducer.effectiveStepWeight, sc && sc.effectiveStepWeight),
      plasticityMultiplier: pick(reducer.plasticityMultiplier, sc && sc.plasticityMultiplier),
      maxDelta: pick(reducer.maxDelta),
      roundingMode: pick(reducer.roundingMode, sc && sc.roundingMode)
    }
  };
}

/** 结构深度相等（canonical 形态间的确定性比较） */
function deepEqualCanonical(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualCanonical(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every(k => deepEqualCanonical(a[k], b[k]));
  }
  return false;
}

module.exports = { SubjectState, DEFAULT_TRAITS, ALLOWED_TRAITS, normalizeQuote, canonicalizeStateChange };
