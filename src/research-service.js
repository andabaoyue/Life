/**
 * src/research-service.js
 * 
 * 初澜数字生命实验：Research Service 实验观测协调与 Replay 任务管理器 (v0.9.5)
 * 
 * 核心设计边界：
 * 1. 严格只读观察层：默认 Snapshot Mode，手动 Refresh，绝不实现 Live Tail。
 * 2. 数据防写守门人：进入与退出对比 SHA-256 哈希，若发现数据发生变化立即抛出 RESEARCH_WRITE_VIOLATION。
 * 3. 异步 Replay 任务管道：带进度百分比 (0..100%)、阶段标识与主动 Cancel 能力，绝不阻塞 UI。
 * 4. Replay Fail-Stop 铁律：归档结构性损坏时立即冻结在最后有效记录，拒绝“跳过坏行继续推演”，标记 partial + uncertified。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ResearchIndex } = require('./research-index');
const { ResearchQuery } = require('./research-query');
const {
  exportStateTrajectory,
  exportStateChanges,
  exportEvidence,
  exportFullResearchBundle
} = require('./research-export');
const { SubjectState, DEFAULT_TRAITS, ALLOWED_TRAITS } = require('./subject-state');
const { normalizeArchiveRecord } = require('./experience-schema');
const { symmetricRound } = require('./state-change');
const { validateArchiveRecord, ArchiveIntegrityService } = require('./archive-integrity');

const REPLAY_CHUNK_SIZE = 500;

const NON_STATE_RECORD_TYPES = new Set([
  'recovery_event',
  'diagnostic',
  'replay_report',
  'internal_log',
  'audit_log'
]);

function calcFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return '';
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return '';
  }
}

class ResearchService {
  constructor(userDataDir, options = {}) {
    this.dir = userDataDir;
    this.archivePath = path.join(userDataDir, 'experiences.jsonl');
    this.statePath = path.join(userDataDir, 'subject-state.json');
    this.memoryPath = path.join(userDataDir, 'memory.json');

    this.index = new ResearchIndex(this.archivePath);
    this.query = new ResearchQuery(userDataDir, { index: this.index });

    this.snapshot = null;
    this.activeTasks = new Map();
    this.completedTaskMetadata = new Map();
    this.taskRetentionMs = Number.isFinite(options.taskRetentionMs)
      ? Math.max(0, options.taskRetentionMs) : 5 * 60 * 1000;
    this.refreshSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Snapshot 模式与防写完整性检查
  // ---------------------------------------------------------------------------
  computeIntegrityHashes() {
    return {
      archiveSha256: calcFileSha256(this.archivePath),
      stateSha256: calcFileSha256(this.statePath),
      timestamp: Date.now()
    };
  }

  verifyIntegrity(beforeHashes) {
    if (!beforeHashes) return true;
    const current = this.computeIntegrityHashes();
    if (beforeHashes.archiveSha256 && current.archiveSha256 !== beforeHashes.archiveSha256) {
      throw new Error('RESEARCH_WRITE_VIOLATION: experiences.jsonl checksum changed during research session');
    }
    if (beforeHashes.stateSha256 && current.stateSha256 !== beforeHashes.stateSha256) {
      throw new Error('RESEARCH_WRITE_VIOLATION: subject-state.json checksum changed during research session');
    }
    return true;
  }

  refreshSnapshot() {
    this.index.ensureIndex();
    const stArchive = fs.existsSync(this.archivePath) ? fs.statSync(this.archivePath) : null;
    const stState = fs.existsSync(this.statePath) ? fs.statSync(this.statePath) : null;

    this.snapshot = {
      snapshotTimestamp: Date.now(),
      archiveSize: stArchive ? stArchive.size : 0,
      archiveMtime: stArchive ? stArchive.mtimeMs : 0,
      stateVersion: stState ? stState.mtimeMs : 0,
      state: this.query.getSubjectState(),
      hashes: this.computeIntegrityHashes()
    };
    return this.snapshot;
  }

  getSnapshot() {
    if (!this.snapshot) {
      return this.refreshSnapshot();
    }
    return this.snapshot;
  }

  // ---------------------------------------------------------------------------
  // 异步 Replay 实验室任务 (P1-04)
  // ---------------------------------------------------------------------------
  startReplayTask(options = {}) {
    const taskId = 'replay-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const task = {
      taskId,
      status: 'running',
      stage: 'loading',
      currentWindow: 0,
      totalWindows: 0,
      percent: 0,
      cancelled: false,
      result: null,
      error: null,
      options
    };
    this.activeTasks.set(taskId, task);

    // 异步排期执行，不阻塞主调用
    setImmediate(() => {
      this._executeReplayTask(task);
    });

    return { taskId, status: 'running' };
  }

  getReplayTaskStatus(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      const retained = this.completedTaskMetadata.get(taskId);
      return retained ? { ...retained } : null;
    }
    return {
      taskId: task.taskId,
      status: task.status,
      stage: task.stage,
      currentWindow: task.currentWindow,
      totalWindows: task.totalWindows,
      percent: task.percent,
      cancelled: task.cancelled,
      result: task.result,
      error: task.error,
      completedAt: task.completedAt || null
    };
  }

  cleanupReplayTasks(options = {}) {
    const now = typeof options === 'number' ? options : (options.now || Date.now());
    const retentionMs = typeof options === 'object' && Number.isFinite(options.retentionMs)
      ? Math.max(0, options.retentionMs) : this.taskRetentionMs;
    let removed = 0;
    for (const [taskId, task] of this.activeTasks) {
      if (!['completed', 'cancelled', 'failed'].includes(task.status)) continue;
      const terminalAt = task.completedAt || task.finishedAt || now;
      if (now - terminalAt < retentionMs) continue;
      this.completedTaskMetadata.set(taskId, {
        taskId: task.taskId,
        status: task.status,
        stage: task.stage,
        currentWindow: task.currentWindow,
        totalWindows: task.totalWindows,
        percent: task.percent,
        cancelled: task.cancelled,
        result: task.result,
        error: task.error,
        completedAt: terminalAt
      });
      this.activeTasks.delete(taskId);
      removed++;
    }
    return removed;
  }

  cancelReplayTask(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) return false;
    if (task.status === 'running') {
      task.cancelled = true;
      task.status = 'cancelled';
      task.stage = 'cancelled';
      task.completedAt = Date.now();
      return true;
    }
    return false;
  }

  /**
   * 异步 Replay 执行核心：支持分步轮询、分块协作让出与 Fail-Stop 确定性熔断 (P1-01 & P1-04)
   */
  async _executeReplayTask(task) {
    if (task.cancelled) return;

    task.stage = 'loading';
    task.percent = 5;

    if (!fs.existsSync(this.archivePath)) {
      task.status = 'completed';
      task.stage = 'completed';
      task.percent = 100;
      task.result = {
        replayStatus: 'invalid',
        integrity: 'uncertified',
        reason: 'ARCHIVE_NOT_FOUND',
        windowStates: [],
        trajectory: [],
        stateChanges: [],
        finalState: { ...DEFAULT_TRAITS }
      };
      task.completedAt = Date.now();
      return;
    }

    try {
      const content = fs.readFileSync(this.archivePath, 'utf8');
      const lines = content.split('\n');

      task.stage = 'indexing';
      task.percent = 15;

      // 提取行与结构
      const lineEntries = [];
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw) continue;
        lineEntries.push({ lineNum: i + 1, text: raw });
      }

      // P1-5: 统计唯一逻辑窗口数，严格排除非状态审计/诊断记录，绝非原始 JSONL 行数
      const logicalWindows = new Set();
      for (const entry of lineEntries) {
        try {
          const parsed = JSON.parse(entry.text);
          const recType = parsed.recordType || parsed.type || (parsed.payload && parsed.payload.type) || '';
          if (NON_STATE_RECORD_TYPES.has(recType)) {
            continue;
          }
          const wNo = (typeof parsed.windowNo === 'number' && !isNaN(parsed.windowNo))
            ? parsed.windowNo
            : ((parsed.payload && typeof parsed.payload.windowNo === 'number' && !isNaN(parsed.payload.windowNo))
              ? parsed.payload.windowNo
              : (typeof parsed.window === 'number' && !isNaN(parsed.window) ? parsed.window : null));
          if (wNo !== null) {
            logicalWindows.add(wNo);
          } else {
            logicalWindows.add('unresolved');
          }
        } catch {
          // 语法损坏在下文 replay 循环中按 Fail-Stop 规则触发熔断
        }
      }

      task.totalWindows = logicalWindows.size;
      task.stage = 'replaying';

      const initialTraits = task.options.initialTraits || { ...DEFAULT_TRAITS };
      const currentValues = { ...initialTraits };
      const defaultStepWeight = task.options.stepWeight ?? 20;
      const defaultMaxDelta = task.options.maxDeltaPerWindow ?? 50;

      const windowStates = [];
      const allStateChanges = [];
      const acceptedEvidenceIds = new Set();
      const acceptedEvidenceFingerprints = new Set();

      let lastValidRecord = 0;
      let corruptDetected = false;
      let hasLegacyAdapter = false;
      let failureInfo = null;

      for (let i = 0; i < lineEntries.length; i++) {
        if (task.cancelled) {
          task.status = 'cancelled';
          task.stage = 'cancelled';
          task.completedAt = Date.now();
          return;
        }

        const entry = lineEntries[i];
        let parsed = null;

        // P1-04 Fail-Stop: 若遇到损坏行，立即停止，冻结在最后有效记录，绝不跳过计算后续行
        try {
          parsed = JSON.parse(entry.text);
        } catch (err) {
          corruptDetected = true;
          failureInfo = {
            line: entry.lineNum,
            reason: 'MALFORMED_JSON',
            error: err.message,
            snippet: entry.text.slice(0, 100)
          };
          console.warn(`[ResearchService] Fail-Stop 触发：第 ${entry.lineNum} 行 JSON 损坏，立即中止推演`);
          break;
        }

        const normalized = normalizeArchiveRecord(parsed);
        if (!normalized || typeof normalized !== 'object') {
          corruptDetected = true;
          failureInfo = {
            line: entry.lineNum,
            reason: 'INVALID_RECORD_STRUCTURE',
            snippet: entry.text.slice(0, 100)
          };
          break;
        }

        // P0-03 & P0-04: 执行严格 Archive Schema 强校验，未知或非法结构直接熔断
        const vResult = validateArchiveRecord(normalized);
        if (!vResult.valid) {
          corruptDetected = true;
          failureInfo = {
            line: entry.lineNum,
            reason: vResult.reason,
            snippet: entry.text.slice(0, 100)
          };
          console.warn(`[ResearchService] Fail-Stop 触发：第 ${entry.lineNum} 行记录 Schema 校验失败 (${vResult.reason})，立即中止推演`);
          break;
        }

        if (normalized.compatibilityAdapter === 'LegacySchemaAdapter' || normalized.sourceSchema) {
          hasLegacyAdapter = true;
        }

        const payload = normalized.payload || normalized;
        const recType = normalized.recordType || normalized.type || (payload && payload.type) || '';
        if (NON_STATE_RECORD_TYPES.has(recType)) {
          lastValidRecord = entry.lineNum;
          continue;
        }

        const wNo = (typeof normalized.windowNo === 'number' && !isNaN(normalized.windowNo))
          ? normalized.windowNo
          : ((payload && typeof payload.windowNo === 'number' && !isNaN(payload.windowNo)) ? payload.windowNo : null);

        // 窗口与时间过滤
        if (task.options.untilWindow && wNo !== null && wNo > task.options.untilWindow) {
          break;
        }
        if (task.options.windowRange) {
          const [fromW, toW] = task.options.windowRange;
          if (wNo !== null && wNo < fromW) continue;
          if (wNo !== null && wNo > toW) break;
        }

        // 提取证据与 Reducer 参数
        const evidence = Array.isArray(payload.verifiedEvidence)
          ? payload.verifiedEvidence
          : (Array.isArray(normalized.verifiedEvidence) ? normalized.verifiedEvidence : []);

        let stepWeight = defaultStepWeight;
        let maxDelta = defaultMaxDelta;
        const histChanges = Array.isArray(payload.stateChanges) ? payload.stateChanges : [];
        if (histChanges.length && histChanges[0].reducer && typeof histChanges[0].reducer.stepWeight === 'number') {
          stepWeight = histChanges[0].reducer.stepWeight;
          maxDelta = histChanges[0].reducer.maxDelta ?? defaultMaxDelta;
        }

        const rawDeltas = {};
        const traitEvMap = {};

        for (const ev of evidence) {
          if (!ev || !ev.trait || !ALLOWED_TRAITS.has(ev.trait)) continue;
          const msgId = String(ev.messageId || '').trim();
          const normQuote = String(ev.quote || '').trim().toLowerCase().replace(/\s+/g, ' ');
          const dir = Math.max(-1, Math.min(1, Number(ev.direction || 0)));
          const fp = ev.fingerprint || (msgId && normQuote ? `${msgId}:${normQuote}:${ev.trait}:${dir}` : null);

          if (ev.evidenceId && acceptedEvidenceIds.has(ev.evidenceId)) continue;
          if (fp && acceptedEvidenceFingerprints.has(fp)) continue;
          if (ev.evidenceId) acceptedEvidenceIds.add(ev.evidenceId);
          if (fp) acceptedEvidenceFingerprints.add(fp);

          if (!rawDeltas[ev.trait]) {
            rawDeltas[ev.trait] = 0;
            traitEvMap[ev.trait] = [];
          }
          rawDeltas[ev.trait] += dir * (ev.strength || 0) * stepWeight;
          if (ev.evidenceId) traitEvMap[ev.trait].push(ev.evidenceId);
        }

        const deltas = {};
        for (const [trait, sum] of Object.entries(rawDeltas)) {
          const clamped = Math.max(-maxDelta, Math.min(maxDelta, symmetricRound(sum)));
          if (clamped !== 0) {
            deltas[trait] = clamped;
            const curr = currentValues[trait] ?? 0;
            const next = Math.max(-999, Math.min(999, curr + clamped));
            currentValues[trait] = next;

            allStateChanges.push({
              stateChangeId: `sc-replay-${wNo ?? 'unresolved'}-${trait}`,
              windowNo: wNo,
              trait,
              previousValue: curr,
              delta: clamped,
              newValue: next,
              evidenceIds: traitEvMap[trait] || [],
              reducer: { stepWeight, maxDelta }
            });
          }
        }

        windowStates.push({
          windowNo: wNo,
          deltas,
          values: { ...currentValues },
          evidenceCount: evidence.length,
          timestamp: (typeof normalized.timestamp === 'number' && !isNaN(normalized.timestamp)) ? normalized.timestamp : null
        });

        lastValidRecord = entry.lineNum;
        task.currentWindow = wNo;
        task.percent = Math.min(95, Math.round(15 + ((i + 1) / lineEntries.length) * 80));

        // P1-01: 分块异步协作让出事件循环，避免阻塞 Electron 主线程与 UI
        if ((i + 1) % REPLAY_CHUNK_SIZE === 0 && i + 1 < lineEntries.length) {
          await new Promise(resolve => setImmediate(resolve));
          if (task.cancelled) {
            task.status = 'cancelled';
            task.stage = 'cancelled';
            task.completedAt = Date.now();
            return;
          }
        }
      }

      task.stage = 'verifying';
      task.percent = 98;

      const archiveReport = ArchiveIntegrityService.checkArchive(this.archivePath);
      let replayStatus = archiveReport.replayStatus || 'complete';
      let integrity = archiveReport.integrity || 'certified';

      if (corruptDetected) {
        replayStatus = 'partial';
        integrity = 'uncertified';
      } else if (hasLegacyAdapter || archiveReport.hasLegacyAdapter) {
        replayStatus = 'complete';
        integrity = 'uncertified';
      } else if (windowStates.length === 0) {
        replayStatus = 'complete';
        integrity = 'certified';
      }

      task.result = {
        replayStatus,
        integrity,
        lastValidRecord,
        failure: failureInfo,
        initialState: { ...initialTraits },
        finalState: { ...currentValues },
        finalValues: { ...currentValues },
        windowStates,
        trajectory: windowStates,
        stateChanges: allStateChanges,
        acceptedEvidenceCount: acceptedEvidenceIds.size
      };

      task.stage = 'completed';
      task.status = 'completed';
      task.percent = 100;
      task.completedAt = Date.now();
    } catch (e) {
      console.error('[ResearchService] Replay 异常:', e.message);
      task.status = 'failed';
      task.stage = 'failed';
      task.error = e.message;
      task.completedAt = Date.now();
    }
  }

  // ---------------------------------------------------------------------------
  // 导出接口包装
  // ---------------------------------------------------------------------------
  exportData(options = {}) {
    const { type = 'full', format = 'json', targetDir = null } = options;

    if (type === 'trajectory') {
      const items = this.query.getStateTrajectory(options);
      return exportStateTrajectory(items, format);
    }
    if (type === 'state_changes') {
      const items = this.query.getStateChanges({ limit: 10000 }).items;
      return exportStateChanges(items, format);
    }
    if (type === 'evidence') {
      const items = this.query.getEvidence({ limit: 10000 }).items;
      return exportEvidence(items, format);
    }
    // Full bundle
    return exportFullResearchBundle(this.query, { targetDir });
  }
}

module.exports = { ResearchService };
