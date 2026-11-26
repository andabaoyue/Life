const crypto = require('crypto');
const { PERSONA } = require('./persona');
const { tryLoad, sanitize } = require('./config');
const { redactSecrets } = require('./redact');
const { createEvent, validateEvent, isEligibleSubjectEvent, createObservation, validateObservation, createInterpretation, validateInterpretation, validateWindowSummary } = require('./experience-schema');
const { createStateChangeExplanation } = require('./state-change');
const { createExperimentRunManifest, createWindowExperimentSnapshot } = require('./experiment-run');
const { buildGenerationContext, collectPromptHashes } = require('./experiment-metadata');

/* v0.9.9: 小结分段计划 —— 分段数随窗口规模自适应，绝不写死「3~5 段」：
   满 100 轮走标准 5 段（严格分支钉死 1-20…81-100），小窗口只写覆盖实际轮数的段。
   既省输出（43 轮实测白写五段把输出顶到 3,923/4,000），又不撞 validateWindowSummary。 */
function summarySegmentPlan(turnCount) {
  const n = Number.isFinite(turnCount) && turnCount > 0 ? Math.floor(turnCount) : 1;
  if (n >= 100) return { segments: 5, note: '按标准 5 段划分（1-20、21-40、41-60、61-80、81-100）' };
  const seg = Math.max(1, Math.min(5, Math.ceil(n / 20)));
  return { segments: seg, note: '共 ' + seg + ' 段，range 依次覆盖 1~' + n + ' 轮（每段最多 20 轮）' };
}

/**
 * 窗口关闭与睡眠梦境流水线（从 Brain 抽离的领域服务）。
 * 涵盖：关窗重入防护、幂等收尾、5x20 总结与 Provenance 核验、
 * 两阶段 Archive + Provenance + SubjectState 提交、入睡冻结/苏醒结算与梦境循环。
 */
class WindowClosingPipeline {
  constructor(brain, prompts = {}) {
    this.brain = brain;
    this.prompts = prompts;
  }

  notePossibleTruncation(usage, cap, label) {
    const b = this.brain;
    if (usage && cap > 0 && Number(usage.completion_tokens) >= cap) {
      b.stats.truncatedCalls = (b.stats.truncatedCalls || 0) + 1;
      b.saveStats(true);
      console.warn(`[Brain] ${label} 输出撞满上限 ${cap}（completion_tokens=${usage.completion_tokens}）：疑似截断，产物可能不可解析`);
    }
  }

  noteWindowCloseFailure(reason) {
    const b = this.brain;
    b.windowCloseAttempts = (b.windowCloseAttempts || 0) + 1;
    // v0.9.9 观测补盲：关窗失败率计数，即刻落盘（进程退出不丢账）
    b.stats.windowCloseFailures = (b.stats.windowCloseFailures || 0) + 1;
    b.saveStats(true);
    // v0.9.9 D3: 一旦失败即进入退避冷却（至少隔 2 轮对话）
    b.windowCloseRetryAfterTurn = ((b.memory && b.memory.data) ? b.memory.data.turnsInWindow : 0) + 2;
    console.warn(`[Brain] 关窗尝试失败 (#${b.windowCloseAttempts})：${reason || 'unknown'}，保留窗口内容待下一轮重试；退避至第 ${b.windowCloseRetryAfterTurn} 轮起重试`);
  }

  async closeWindow(opts = {}) {
    const b = this.brain;
    if (b._closingWindow) {
      return b._closingWindowPromise || false;
    }
    b._closingWindow = true;
    b._closingWindowPromise = b._closeWindowInternal(opts).finally(() => {
      b._closingWindow = false;
      b._closingWindowPromise = null;
    });
    return b._closingWindowPromise;
  }

  async closeWindowInternal(opts = {}) {
    const b = this.brain;
    const { SUMMARY_SYS, GROWTH_SYS, MERGE_SYS } = this.prompts;

    // P0-01: 若检测到 SubjectState 处于 recovery_pending 状态，先执行 Replay 自动恢复
    if (b.subjectState && b.subjectState.recoveryPending) {
      console.warn('[Brain] 检测到 subjectState 处于 recovery_pending 状态，正在执行 Replay 自动恢复...');
      const recovered = b.subjectState.recoverFromPending(b.experiencesArchive, 'state_commit_failed');
      if (!recovered) {
        console.error('[Brain] 状态恢复未完成，禁止推进当前窗口');
        return false;
      }
    }

    // 先拍快照再调 API：小结要等一两秒，这期间用户可能又发消息进来
    let closeReason = (opts && opts.closeReason) || (b.memory.data.turnsInWindow >= b.memory.windowTurns ? 'turn_limit' : (b.memory.needsWindowReset() ? 'token_limit' : 'turn_limit'));
    if (!(opts && opts.closeReason) && b.windowCloseAttempts > 0
        && b.memory.data.turnsInWindow > b.memory.windowTurns) {
      closeReason = 'turn_limit_delayed';
    }
    const snap = b.memory.windowSnapshot({ closeReason });
    if (!(snap.activeItems && snap.activeItems.length) && !snap.items.length) return false;

    // P0-2: 若当前窗口已在 Archive 中成功归档且 SubjectState 已恢复/前进，直接推进 Memory 关窗完成幂等收尾
    if (b.experiencesArchive && b.experiencesArchive.hasWindowArchive &&
        b.experiencesArchive.hasWindowArchive(snap.windowNo, snap.epoch) &&
        (!b.subjectState || b.subjectState.currentWindowNo > snap.windowNo)) {
      console.warn(`[Brain] 窗口 #${snap.windowNo} 已经归档且状态已前进，直接推进 Memory 关窗完成幂等收尾`);
      const existing = b.experiencesArchive.getByWindow(snap.windowNo).find(r => r.recordType === 'window_summary' || r.recordType === 'window_archive' || r.type === 'window_archive');
      const p = (existing && existing.payload) || existing || {};
      const sameLineage = Number.isInteger(p.epoch) && p.epoch === b.memory.data.epoch;
      if (sameLineage) {
        const stableFacts = (p.windowSynthesis && Array.isArray(p.windowSynthesis.stableUserFacts))
          ? p.windowSynthesis.stableUserFacts
              .map((x) => (typeof x === 'string' ? x : (x && (x.content || x.text)) || ''))
              .filter(Boolean)
          : [];
        const summaryText = p.rawSummaryText || (stableFacts.length ? stableFacts.join('\n') : '') || '窗口小结已归档';
        const done = b.memory.closeWindow(summaryText, snap);
        if (done) {
          if (typeof b.memory.flushPendingDreamFragments === 'function') {
            b.memory.flushPendingDreamFragments();
            b.memory.save(true);
          }
          if (b.internalRegulation && b.isExperimentModuleActive('internalRegulation')) {
            try {
              b.internalRegulation.updateOnWindowClose(snap.windowNo, {
                turnsRecorded: snap.actualTurnCount,
                moodTone: p.windowSynthesis && p.windowSynthesis.moodTone
              });
            } catch {}
          }
          b.stats.compressions++;
          b.saveStats(true);
          b._syncWindowExperimentSnapshot();
        }
        return done;
      }
      console.warn(`[Brain] 窗口 #${snap.windowNo} 的归档记录不属于当前记忆血脉 (记录 epoch=${p.epoch} / 当前 epoch=${b.memory.data.epoch})，跳过回填、按新生命周期正常关窗`);
    }

    // 仅总结当前窗口的真实消息（排除上一窗口残留的 bridge 桥接消息）
    const activeItems = snap.activeItems || snap.items;

    // 建立 messageId 索引映射，用于 Provenance 证据强验证
    const msgMap = new Map();
    for (const m of activeItems) {
      if (m && m.messageId) msgMap.set(m.messageId, m);
    }

    const dialogue = activeItems.map(m => {
      const speaker = m.synthetic ? '程序触发（不是用户原话）' : (m.role === 'user' ? '用户' : '初澜');
      const idPrefix = m.messageId ? `[${m.messageId}] ` : '';
      const roundPrefix = m.roundNo ? `[第${m.roundNo}轮] ` : '';
      return `${idPrefix}${roundPrefix}${speaker}：` + b.memory.cleanContentForSummary(m.content);
    }).join('\n');

    const summaryMaxTokens = (opts && opts.maxTokens) || b.cfg.summaryMaxTokens || 10000;
    const segPlan = summarySegmentPlan(snap.actualTurnCount);
    const openExps = ((b.memory && b.memory.data && b.memory.data.expectations) || [])
      .filter((x) => x && x.status === 'open');
    try {
      const apiCompleteRes = await b.api.complete(
        [{ role: 'system', content: SUMMARY_SYS },
         { role: 'user', content: '【对话】\n' + dialogue
           + '\n\n【窗口规模】本窗口共 ' + (snap.actualTurnCount || 0) + ' 轮，请' + segPlan.note + '；紧凑输出，不写空段、不铺陈冗余字句。'
           + '\n\n【待核验预期清单】\n' + (openExps.length
             ? openExps.map((x) => '- [' + x.id + '] ' + x.text + (x.dueHint ? '（' + x.dueHint + '）' : '')).join('\n')
             : '暂无') }],
        { maxTokens: summaryMaxTokens, temperature: 0.2 }
      );
      const { text, usage, observedModel } = apiCompleteRes;
      b.track(usage, true, 'summary');
      b._notePossibleTruncation(usage, summaryMaxTokens, '关窗小结');
      b.saveStats(true);
      if (b.shutdownRequested) return false;
      if (!text) { b._noteWindowCloseFailure('EMPTY_SUMMARY_TEXT'); return false; }

      const summaryPromptHashes = collectPromptHashes({
        summary: SUMMARY_SYS,
        persona: PERSONA,
        growth: GROWTH_SYS,
        merge: MERGE_SYS
      });

      const sourceMessageRange = {
        firstMessageId: activeItems[0] ? activeItems[0].messageId : null,
        lastMessageId: activeItems[activeItems.length - 1] ? activeItems[activeItems.length - 1].messageId : null,
        messageCount: activeItems.length
      };

      const summaryGenerationContext = buildGenerationContext({
        kind: 'summary',
        cfg: b.cfg,
        promptHashes: summaryPromptHashes,
        sampling: { maxTokens: summaryMaxTokens, temperature: 0.2 },
        sourceWindowNo: snap.windowNo,
        sourceMessageRange,
        observedModel,
        providerResponse: apiCompleteRes,
        generator: 'llm'
      });

      let structured = null;
      let summaryEpistemicStatus = 'CERTIFIED';
      let summaryFailureReason = null;
      try {
        const rawJson = String(text || '').trim()
          .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(rawJson);
        if (parsed && typeof parsed === 'object') {
          structured = parsed;
          const vSummary = validateWindowSummary(structured, {
            closeReason: snap.closeReason,
            actualTurnCount: snap.actualTurnCount,
            targetTurnCount: snap.targetTurnCount
          });
          if (!vSummary.valid) {
            console.error('[Brain] Summary 数据契约校验失败 (Fail-Stop):', vSummary.reason);
            b._noteWindowCloseFailure('SUMMARY_SCHEMA_INVALID: ' + vSummary.reason);
            return false;
          }
        }
      } catch (parseErr) {
        summaryEpistemicStatus = 'UNCERTIFIED';
        summaryFailureReason = 'NON_JSON_SUMMARY';
        b.stats.summaryUncertified = (b.stats.summaryUncertified || 0) + 1;
      }

      const looksLikeJson = (() => {
        const head = String(text || '').trim()
          .replace(/^```(?:json)?\s*/i, '')
          .charAt(0);
        return head === '{' || head === '[';
      })();
      let summaryTextForMemory = (structured || !looksLikeJson)
        ? text
        : '【本段小结未能结构化解析】这一段经历仍然完整保存在你的底座归档里，只是没能压缩成条目；不要据此虚构细节。';
      let verifiedEvidence = [];
      let rejectedEvidence = [];

      // P0-01 & P0-03: 程序仅为当前窗口的真实交互消息签发 Event
      const events = [];
      const eventIdsSet = new Set();
      for (const [eventIndex, m] of activeItems.entries()) {
        if (!isEligibleSubjectEvent(m)) {
          continue;
        }

        const eventId = 'evt-' + crypto.createHash('sha256')
          .update(JSON.stringify({ windowNo: snap.windowNo, eventIndex, source: m.role || 'user', content: m.content || '' }), 'utf8')
          .digest('hex').slice(0, 24);
        const evt = createEvent({
          eventId,
          type: 'message',
          timestamp: m.t || Date.now(),
          windowNo: snap.windowNo,
          messageId: m.messageId,
          source: m.role || 'user',
          payload: {
            content: m.content || '',
            roundNo: m.roundNo
          }
        });
        const vEvt = validateEvent(evt);
        if (vEvt.valid) {
          events.push(evt);
          eventIdsSet.add(evt.eventId);
        } else {
          console.warn('[Brain] 消息被判定为非主体事件，已过滤:', m.messageId, vEvt.reason);
        }
      }

      let observations = [];
      let interpretations = [];
      let allEvidence = [];
      let syn = {};
      let segments = [];

      if (structured) {
        syn = structured.windowSynthesis || {};
        segments = structured.segments || [];

        const factText = (x) => (typeof x === 'string' ? x : (x && (x.content || x.text)) || '');
        const userFacts = Array.isArray(syn.stableUserFacts) && syn.stableUserFacts.length > 0
          ? '用户事实：' + syn.stableUserFacts.map(factText).filter(Boolean).join('；')
          : '';
        const chulanExps = Array.isArray(syn.subjectExperiences) && syn.subjectExperiences.length > 0
          ? '初澜经历：' + syn.subjectExperiences.map(factText).filter(Boolean).join('；')
          : '';
        const conciseParts = [userFacts, chulanExps].filter(Boolean);
        if (conciseParts.length > 0) {
          summaryTextForMemory = conciseParts.join('\n');
        }

        // P0-02: 收集与核验 Observation
        if (Array.isArray(structured.observations) && structured.observations.length > 0) {
          for (const obs of structured.observations) {
            const v = validateObservation(obs, eventIdsSet);
            if (v.valid) {
              observations.push(obs);
            } else {
              console.warn('[Brain] 拒绝未经验证的 Observation (引用的 Event 不存在):', obs.observationId, v.reason);
            }
          }
        } else if (Array.isArray(segments)) {
          for (const seg of segments) {
            if (Array.isArray(seg.chulanExperience) && seg.chulanExperience.length > 0) {
              const relEvts = events.slice(0, Math.min(events.length, 20)).map(e => e.eventId);
              if (relEvts.length > 0) {
                observations.push(createObservation({
                  eventIds: relEvts,
                  type: 'interaction_segment',
                  content: seg.chulanExperience.join('；'),
                  confidence: 0.9,
                  source: 'segment_analysis'
                }));
              }
            }
          }
        }

        if (observations.length === 0 && events.length > 0) {
          observations.push(createObservation({
            eventIds: events.slice(0, 5).map(e => e.eventId),
            type: 'window_dialogue_flow',
            content: '本窗口交互流分析',
            confidence: 1.0,
            source: 'dialogue_stream'
          }));
        }

        const validObsIds = new Set(observations.map(o => o.observationId));

        if (Array.isArray(structured.interpretations) && structured.interpretations.length > 0) {
          for (const interp of structured.interpretations) {
            const v = validateInterpretation(interp, validObsIds);
            if (v.valid) {
              interpretations.push(interp);
            } else {
              console.warn('[Brain] 拒绝未经验证的 Interpretation (引用的 Observation 不存在):', interp.interpretationId, v.reason);
            }
          }
        } else if (syn.subjectExperiences && syn.subjectExperiences.length > 0 && observations.length > 0) {
          interpretations.push(createInterpretation({
            observationIds: [observations[0].observationId],
            content: syn.subjectExperiences.join('；'),
            confidence: 0.8,
            perspective: 'chulan'
          }));
        }

        if (Array.isArray(segments)) {
          for (const seg of segments) {
            if (Array.isArray(seg.stateEvidence)) {
              allEvidence.push(...seg.stateEvidence);
            }
          }
        }
        if (Array.isArray(syn.stateChangesSuggested)) {
          allEvidence.push(...syn.stateChangesSuggested);
        }
      } else {
        syn = { stableUserFacts: [text], subjectExperiences: [] };
      }

      // 执行严格 Provenance、Trait 白名单与防重核验
      let stateChanges = [];
      let explanations = [];
      let stateStaging = null;

      if (b.subjectState) {
        stateStaging = b.subjectState.createStagingSnapshot();

        if (typeof b.subjectState.attestMessages === 'function') {
          b.subjectState.attestMessages(activeItems, snap.windowNo);
        }

        const verifyResult = b.subjectState.verifyEvidence(allEvidence, msgMap, snap.windowNo, { stageOnly: true });
        verifiedEvidence = verifyResult.verified;
        rejectedEvidence = verifyResult.rejected;

        const reduceResult = b.subjectState.reduce(verifiedEvidence, snap.windowNo, {
          stageOnly: true,
          canalization: b.isExperimentModuleActive('biographicalCanalization'),
          experimentModules: b.currentWindowSnapshot ? b.currentWindowSnapshot.modules : b.cfg.experimentModules
        });
        if (reduceResult && Array.isArray(reduceResult.stateChanges)) {
          stateChanges = reduceResult.stateChanges;
        }

        for (const sc of stateChanges) {
          const rawExpl = syn.stateExplanations && syn.stateExplanations[sc.trait];
          let explInput;
          if (rawExpl && typeof rawExpl === 'object') {
            explInput = {
              claimedDelta: rawExpl.claimedDelta,
              claimedTrait: rawExpl.claimedTrait || sc.trait,
              text: rawExpl.text || rawExpl.summary || `特质 [${sc.trait}] 变动`,
              evidenceIds: rawExpl.evidenceIds || sc.evidenceIds
            };
          } else if (typeof rawExpl === 'string') {
            explInput = {
              text: rawExpl,
              claimedTrait: sc.trait,
              evidenceIds: sc.evidenceIds
            };
          } else {
            const explText = (syn.subjectExperiences && syn.subjectExperiences[0])
              || `特质 [${sc.trait}] 在第 ${snap.windowNo} 窗口增量 ${sc.delta > 0 ? '+' : ''}${sc.delta}`;
            explInput = {
              claimedDelta: sc.delta,
              claimedTrait: sc.trait,
              text: explText,
              evidenceIds: sc.evidenceIds
            };
          }
          const explanationObj = createStateChangeExplanation(sc, explInput);
          explanations.push(explanationObj);
        }
      }

      // P0-08 / P0-2: 先写入 Archive (experiences.jsonl)
      const windowArchivePayload = {
        windowNo: snap.windowNo,
        epoch: Number.isInteger(snap.epoch) ? snap.epoch : null,
        targetTurnCount: snap.targetTurnCount || 100,
        actualTurnCount: snap.actualTurnCount ?? snap.snapshotTurnCount,
        closeReason: snap.closeReason || 'turn_limit',
        ...(b.windowCloseAttempts > 0 ? { retryAttempts: b.windowCloseAttempts, delayedClose: true } : {}),
        turns: snap.actualTurnCount ?? snap.snapshotTurnCount,
        messageCount: activeItems.length,
        events,
        observations,
        interpretations,
        segments,
        windowSynthesis: syn,
        stateEvidence: allEvidence,
        verifiedEvidence,
        rejectedEvidence,
        stateChanges,
        explanations,
        rawSummaryText: text,
        generationContext: summaryGenerationContext,
        sourceMessageRange,
        epistemicStatus: summaryEpistemicStatus,
        structuredSummaryAvailable: Boolean(structured),
        summaryFailureReason
      };
      let archiveSuccess = false;
      if (b.experiencesArchive) {
        if (b.experiencesArchive.hasWindowArchive && b.experiencesArchive.hasWindowArchive(snap.windowNo, snap.epoch)) {
          console.warn(`[Brain] 窗口 #${snap.windowNo} 经历已在 Archive 中，跳过重复写入`);
          archiveSuccess = true;
        } else {
          archiveSuccess = b.experiencesArchive.appendWindowArchive(windowArchivePayload);
        }
      } else {
        archiveSuccess = true;
      }

      if (!archiveSuccess) {
        const spilled = Boolean(b.experiencesArchive) &&
          typeof b.experiencesArchive.spillWindowArchiveToSidecar === 'function' &&
          b.experiencesArchive.spillWindowArchiveToSidecar(windowArchivePayload, 'ARCHIVE_APPEND_FAILED');
        if (!spilled) {
          console.error('[Brain] Archive 写入失败且紧急溢写也失败，回滚状态暂存并中止本次关窗 (保障数据一致性)');
          if (b.subjectState && stateStaging) {
            b.subjectState.rollbackStage(stateStaging);
          }
          b._noteWindowCloseFailure('ARCHIVE_WRITE_AND_SPILL_FAILED');
          return false;
        }
        b._noteArchiveSpillover(snap.windowNo, 'ARCHIVE_APPEND_FAILED');
        console.error(`[Brain] ARCHIVE_SPILLOVER 窗口 #${snap.windowNo}：主链写入失败，已紧急溢写至 recovery-audit sidecar，本次关窗降级推进，需人工/自愈检查`);
      }

      // v0.9.7.1: Archive 已成功后，先提交独立 provenance sidecar
      let provenanceCommitSuccess = true;
      if (b.experiencesArchive && b.subjectState &&
          typeof b.experiencesArchive.updateProvenanceAttestations === 'function') {
        const msgAtts = b.subjectState.data.messageAttestations || [];
        const evAtts = b.subjectState.data.evidenceAttestations || [];
        provenanceCommitSuccess = b.experiencesArchive.updateProvenanceAttestations(msgAtts, evAtts);
        if (provenanceCommitSuccess && typeof b.subjectState.prunePersistedAttestations === 'function') {
          b.subjectState.prunePersistedAttestations(msgAtts, evAtts);
        }
      }

      if (!provenanceCommitSuccess) {
        console.error('[Brain] Archive 已写入但独立 provenance sidecar 提交失败，回滚暂存状态并中止本次关窗');
        b._noteWindowCloseFailure('PROVENANCE_COMMIT_FAILED');
        if (b.subjectState && stateStaging) {
          b.subjectState.rollbackStage(stateStaging);
          b.subjectState.recoveryPending = true;
          b.subjectState.recoveryPendingReason = 'provenance_commit_failed';
        }
        return false;
      }

      // Archive + provenance sidecar 均确认后，正式提交 Subject State 持久化 (P0-01)
      let stateCommitSuccess = true;
      if (b.subjectState) {
        stateCommitSuccess = b.subjectState.commit();
      }

      if (!stateCommitSuccess) {
        console.error('[Brain] Archive 写入成功但 Subject State commit 失败！进入 recovery_pending 状态，中止本次关窗');
        if (b.subjectState) {
          b.subjectState.recoveryPending = true;
          b.subjectState.recoveryPendingReason = 'state_commit_failed';
        }
        if (b.experiencesArchive) {
          b.experiencesArchive.appendRecord('recovery_event', snap.windowNo, {
            action: 'state_commit_failed',
            timestamp: Date.now(),
            windowNo: snap.windowNo,
            reason: 'state_commit_failed',
            recoveryPending: true
          });
        }
        b._noteWindowCloseFailure('STATE_COMMIT_FAILED');
        return false;
      }

      snap.generationContext = summaryGenerationContext;
      const done = b.memory.closeWindow(summaryTextForMemory, snap);
      if (done) {
        if (typeof b.memory.flushPendingDreamFragments === 'function') {
          b.memory.flushPendingDreamFragments();
        }
        b.memory.refreshCuriosity((syn && Array.isArray(syn.unresolved)) ? syn.unresolved : [], snap.windowNo);
        const knownIds = (snap && Array.isArray(snap.snapshotActiveMessageIds)) ? snap.snapshotActiveMessageIds : [];
        const ingestOpts = { knownIds, messages: (snap && Array.isArray(snap.activeItems)) ? snap.activeItems : [] };
        for (const c of (Array.isArray(syn.coinages) ? syn.coinages : [])) {
          b.memory.addLexicon(Object.assign({}, c, { windowNo: snap.windowNo }), ingestOpts);
        }
        for (const ex of (Array.isArray(syn.expectations) ? syn.expectations : [])) {
          b.memory.addExpectation(Object.assign({}, ex, { windowNo: snap.windowNo }), ingestOpts);
        }
        for (const oc of (Array.isArray(syn.expectationOutcomes) ? syn.expectationOutcomes : [])) {
          b.memory.resolveExpectation(oc && oc.id, {
            status: oc && oc.status, messageId: oc && oc.messageId, note: oc && oc.note, windowNo: snap.windowNo
          }, ingestOpts);
        }
        b.memory.save(true);
        if (b.windowCloseAttempts > 0) {
          b.stats.delayedCloses = (b.stats.delayedCloses || 0) + 1;
        }
        b.windowCloseAttempts = 0;
        b.windowCloseRetryAfterTurn = 0;
        b.stats.compressions++;
        b.saveStats(true);
        b.pendingCacheBreakReason = 'window_boundary';

        if ((b.cfg.recordSelfProjection || (opts && opts.recordSelfProjection)) &&
            b.experiencesArchive && typeof b.experiencesArchive.appendSelfProjection === 'function') {
          b.experiencesArchive.appendSelfProjection({
            windowNo: snap.windowNo,
            sourceExperienceRecords: [`win-${snap.windowNo}`],
            sourceStateChanges: stateChanges ? stateChanges.map(sc => sc.stateChangeId || sc.changeId).filter(Boolean) : [],
            projectionVersion: '1.0',
            entriesAdded: 0,
            result: {
              currentSelfText: b.selfLedger ? b.selfLedger.currentSelfText() : '',
              totalEntries: b.selfLedger ? b.selfLedger.entries.length : 0
            },
            generationContext: summaryGenerationContext
          });
        }

        if (b.memory.isMemoryDynamicsActive && b.experiencesArchive) {
          try {
            b.experiencesArchive.append({
              recordType: 'memory_dynamics_snapshot',
              windowNo: snap.windowNo,
              payload: {
                windowNo: snap.windowNo,
                report: b.memory.lastDecayReport || null,
                snapshot: b.memory.engramManager.exportSnapshot(snap.windowNo)
              }
            });
          } catch (e) {
            console.error('[Brain] memory_dynamics_snapshot 归档失败:', e.message);
          }
        }

        if (b.internalRegulation && b.isExperimentModuleActive('internalRegulation')) {
          try {
            let lastWindowTension = 0;
            try {
              const { computeWindowArousalTrajectory, evaluateDreamGate } = require('./dream-system');
              const regHistory = Array.isArray(b.internalRegulation.history) ? b.internalRegulation.history : [];
              const traj = computeWindowArousalTrajectory(
                snap.activeItems || [], verifiedEvidence || [], segments || [], { regulationHistory: regHistory }
              );
              const gateMetrics = evaluateDreamGate({
                windowNo: snap.windowNo,
                arousalTrajectory: traj,
                verifiedEvidence: verifiedEvidence || [],
                dreamHistory: b.dreamHistory || []
              }).metrics || {};
              const varNorm = Math.min(1, (Number(gateMetrics.arousalVariance) || 0) / 30);
              const spikeNorm = Math.min(1, (Number(gateMetrics.maxArousalSpike) || 0) / 30);
              const conflictNorm = Math.min(1, (Number(gateMetrics.cognitiveConflictScore) || 0) / 1.5);
              lastWindowTension = Math.max(0, Math.min(1, Math.max(varNorm, spikeNorm) * 0.6 + conflictNorm * 0.4));
            } catch { /* 张力计算失败降级为 0，绝不阻塞关窗 */ }

            const snapshotExtra = (
              b.internalRegulation.allostasisEnabled &&
              typeof b.internalRegulation.getAllostasisSummary === 'function'
            ) ? {
              allostasis: b.internalRegulation.getAllostasisSummary(),
              allostasisState: (b.internalRegulation.allostasisPrior && typeof b.internalRegulation.allostasisPrior.toJSON === 'function')
                ? b.internalRegulation.allostasisPrior.toJSON()
                : null
            } : {};

            b.internalRegulation.updateOnWindowClose(snap.windowNo, {
              turnsRecorded: snap.actualTurnCount,
              moodTone: syn.moodTone,
              lastWindowTension
            });
            if (b.experiencesArchive) {
              const regSnapshot = b.internalRegulation.createSnapshotRecord(snap.windowNo, snapshotExtra);
              b.experiencesArchive.append(regSnapshot);
            }
          } catch (e) {
            console.error('[Brain] internal_regulation_snapshot 归档失败:', e.message);
          }
        }

        const dreamEnabled = b.isExperimentModuleActive('sleepConsolidation');
        if (dreamEnabled && b.experiencesArchive) {
          await b._dreamCycle({ snap, syn, verifiedEvidence, events, segments, isWindowClose: true, preClose: false });
        }
        if (b.shutdownRequested) return done;

        const selfNoteMint = b._engraveSelfNotes(snap.windowNo);
        const selfNoteTraitHints = [];

        if (b.cfg.selfGrowthEnabled === true)
          await b.growSelf(dialogue, summaryTextForMemory, snap.windowNo, {
            msgMap,
            sourceMessageRange,
            selfNoteFacts: selfNoteMint.facts,
            selfNoteAttestations: selfNoteMint.attestations,
            traitHintsOut: selfNoteTraitHints
          });

        if (selfNoteTraitHints.length && b.subjectState) {
          b._applySelfNoteTraitHints(selfNoteTraitHints, selfNoteMint.attestations, msgMap, snap.windowNo);
        }

        if (done) {
          if (b.wardrobe) {
            b.memory.wardrobe = b.getWardrobePrompt();
          }
          b._syncWindowExperimentSnapshot();
        }
      }
      return done;
    } catch (e) {
      console.error('window summary failed:', redactSecrets(e.message));
      b._noteWindowCloseFailure('SUMMARY_EXCEPTION: ' + redactSecrets(e.message));
      return false;
    }
  }

  syncWindowExperimentSnapshot() {
    const b = this.brain;
    const diskCfg = tryLoad(b.dir);
    const nextExp = diskCfg ? sanitize({
      experimentMode: diskCfg.experimentMode,
      experimentModules: diskCfg.experimentModules
    }) : {
      experimentMode: b.currentWindowSnapshot.experimentMode,
      experimentModules: b.currentWindowSnapshot.modules
    };

    b.runManifest = createExperimentRunManifest({
      experimentMode: nextExp.experimentMode,
      modules: nextExp.experimentModules,
      windowNo: b.memory.data.windowNo
    });
    b.currentWindowSnapshot = createWindowExperimentSnapshot(b.memory.data.windowNo, b.runManifest);
    b.cfg.experimentMode = b.currentWindowSnapshot.experimentMode;
    b.cfg.experimentModules = b.currentWindowSnapshot.modules;

    if (b.internalRegulation) {
      const mods = b.currentWindowSnapshot.modules || {};
      const wasEnabled = Boolean(b.internalRegulation.enabled);
      const nextEnabled = Boolean(mods.internalRegulation);
      b.internalRegulation.enabled = nextEnabled;
      if (!wasEnabled && nextEnabled && typeof b.internalRegulation.load === 'function') {
        b.internalRegulation.load();
      }
      const nextAllostasis = Object.prototype.hasOwnProperty.call(mods, 'allostasisPrior')
        ? Boolean(mods.allostasisPrior)
        : true;
      if (typeof b.internalRegulation.setAllostasisEnabled === 'function') {
        b.internalRegulation.setAllostasisEnabled(nextAllostasis);
      } else {
        b.internalRegulation.allostasisEnabled = b.internalRegulation.enabled && nextAllostasis;
      }
      if (!b.internalRegulation.enabled) {
        b.internalRegulation._recentLoadTrail = [];
        b.internalRegulation.approachingOverload = false;
      }
    }
    if (b.memory) {
      const nextDynamics = Boolean(b.currentWindowSnapshot.modules?.memoryDynamics);
      if (typeof b.memory.setMemoryDynamicsEnabled === 'function') {
        const ec = typeof b._buildEngramConfig === 'function' ? b._buildEngramConfig() : b.cfg.engramConfig;
        b.memory.setMemoryDynamicsEnabled(nextDynamics, ec);
      } else {
        b.memory.memoryDynamicsEnabled = nextDynamics;
      }
      if (nextDynamics && b.memory.engramManager && b.memory.engramManager.traces.size === 0) {
        b._restoreEngramSnapshotFromArchive();
      }
    }
  }

  async freezeDreamStagingForSleep() {
    const b = this.brain;
    try {
      const reg = b.internalRegulation;
      if (!reg || typeof reg.stageSleepContext !== 'function') return null;
      if (!b.isExperimentModuleActive || !b.isExperimentModuleActive('sleepConsolidation')) return null;

      const snap = b.memory.windowSnapshot();
      const { computeWindowArousalTrajectory, extractDayResidues } = require('./dream-system');

      const regHistory = Array.isArray(reg.history) ? reg.history : [];
      const arousalTrajectory = computeWindowArousalTrajectory(
        snap.activeItems || [], [], [], { regulationHistory: regHistory }
      );
      const unaskedCuriosities = (b.memory && Array.isArray(b.memory.data.curiosityQueue))
        ? b.memory.data.curiosityQueue.filter(x => x && x.asked !== true) : [];
      const dayResidues = extractDayResidues(snap.activeItems || [], [], unaskedCuriosities);

      const noveltyScore = Number(Math.min(1.0, Math.min(4, Math.round((snap.activeItems || []).length / 25)) * 0.25).toFixed(2));

      return reg.stageSleepContext({
        at: Date.now(),
        windowNo: snap.windowNo,
        dayResidues,
        arousalTrajectory,
        noveltyScore
      });
    } catch (err) {
      console.error('[Brain] 入睡冻结梦境原料失败 (Fail-Safe):', redactSecrets(err.message));
      return null;
    }
  }

  notifyBedsideOnWake() {
    const b = this.brain;
    try {
      if (typeof b.onBedsideUnread !== 'function') return;
      const mem = b.memory;
      if (!mem || !mem.data || !Array.isArray(mem.data.history)) return;
      const history = mem.data.history;
      let tailStart = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] && history[i].role === 'assistant') { tailStart = i + 1; break; }
      }
      const pending = history.filter((m, i) => i >= tailStart && m && m.bedside === true);
      if (pending.length === 0) return;
      b.onBedsideUnread({
        count: pending.length,
        at: Date.now()
      });
    } catch (e) { /* 提示失败绝不影响唤醒 */ }
  }

  async settleDreamOnWake(trigger = 'wake', preset = null) {
    const b = this.brain;
    if (b._settlingDreamOnWake || b.shutdownRequested) return null;
    b._settlingDreamOnWake = true;
    try {
      const reg = b.internalRegulation;
      if (!reg) return null;

      let sleepStartTime, staging;
      if (preset && Number.isFinite(preset.sleepStartTime)) {
        sleepStartTime = preset.sleepStartTime;
        staging = preset.staging || null;
      } else {
        if (typeof reg.getSleepContext !== 'function') return null;
        const sleepCtx = reg.getSleepContext();
        if (!sleepCtx) return null;
        sleepStartTime = sleepCtx.sleepStartTime;
        staging = sleepCtx.staging || null;
      }

      if (!Number.isFinite(sleepStartTime)) return null;

      if (!b.isExperimentModuleActive || !b.isExperimentModuleActive('sleepConsolidation')) {
        reg.clearSleepContext();
        return null;
      }

      if (!staging || !Array.isArray(staging.dayResidues) || staging.dayResidues.length === 0) {
        reg.clearSleepContext();
        return null;
      }

      const sleepElapsedMs = Math.max(0, Date.now() - sleepStartTime);
      const snap = b.memory.windowSnapshot();

      let produced = null;
      const before = b.dreamHistory.length;
      await b._dreamCycle({
        snap: { ...snap, windowNo: staging.windowNo || snap.windowNo },
        syn: null,
        verifiedEvidence: [],
        events: [],
        noveltyProxy: true,
        isWindowClose: false,
        preClose: true,
        fromSleep: true,
        sleepStartTime,
        sleepElapsedMs,
        sleepStaging: staging
      });
      if (Array.isArray(b.dreamHistory) && b.dreamHistory.length > before) {
        produced = b.dreamHistory[b.dreamHistory.length - 1];
      }

      if (b.shutdownRequested) return null;

      const stillSameSleep = (!reg.isSleeping) || (reg.sleepStartTime === sleepStartTime);
      if (stillSameSleep) {
        reg.clearSleepContext();
        reg.save();
      }

      if (produced) {
        console.log('[Brain] 苏醒结算梦境（' + trigger + '，睡了 ' +
          (sleepElapsedMs / 3600000).toFixed(1) + ' 小时）');
      } else {
        console.log('[Brain] 苏醒结算未产生梦境（' + trigger + '，睡了 ' +
          (sleepElapsedMs / 3600000).toFixed(1) + ' 小时，门禁未放行）');
      }
      return produced;
    } catch (err) {
      console.error('[Brain] 苏醒结算梦境失败 (Fail-Safe):', redactSecrets(err.message));
      return null;
    } finally {
      b._settlingDreamOnWake = false;
    }
  }

  async dreamCycle(ctx = {}) {
    const b = this.brain;
    const snap = ctx.snap || {};
    const syn = ctx.syn || { stableUserFacts: [], subjectExperiences: [] };
    const verifiedEvidence = ctx.verifiedEvidence || [];
    const events = ctx.events || [];
    const segments = ctx.segments || [];
    try {
      const { computeWindowArousalTrajectory, evaluateDreamGate, extractDayResidues, buildDreamSynthesisPrompt, synthesizeDream } = require('./dream-system');

      const staging = ctx.sleepStaging || null;
      const regHistory = (b.internalRegulation && Array.isArray(b.internalRegulation.history))
        ? b.internalRegulation.history
        : [];
      const hasFrozenTrajectory = ctx.fromSleep === true && staging && staging.arousalTrajectory && typeof staging.arousalTrajectory === 'object';
      const arousalTrajectory = hasFrozenTrajectory
        ? staging.arousalTrajectory
        : computeWindowArousalTrajectory(snap.activeItems || [], verifiedEvidence || [], segments || [], { regulationHistory: regHistory });

      let noveltyScore;
      if (ctx.fromSleep === true && staging && typeof staging.noveltyScore === 'number' && Number.isFinite(staging.noveltyScore)) {
        noveltyScore = Number(Math.max(0, Math.min(1, staging.noveltyScore)).toFixed(2));
      } else {
        let newFactCount = (Array.isArray(syn.stableUserFacts) ? syn.stableUserFacts.length : 0) +
                             (Array.isArray(syn.subjectExperiences) ? syn.subjectExperiences.length : 0);
        if (!ctx.syn && ctx.noveltyProxy) {
          newFactCount = Math.min(4, Math.round(((snap && snap.activeItems) || []).length / 25));
        }
        noveltyScore = Number(Math.min(1.0, newFactCount * 0.25).toFixed(2));
      }
      const now = (snap && typeof snap.at === 'number') ? snap.at : Date.now();

      const gateResult = evaluateDreamGate({
        windowNo: snap.windowNo,
        arousalTrajectory,
        noveltyScore,
        stateHistory: b.subjectState ? b.subjectState.data.history : [],
        verifiedEvidence: verifiedEvidence || [],
        dreamHistory: b.dreamHistory || [],
        fromSleep: ctx.fromSleep === true,
        sleepElapsedMs: ctx.sleepElapsedMs,
        now
      });

      if (gateResult && gateResult.allowDream) {
        const unaskedCuriosities = (b.memory && Array.isArray(b.memory.data.curiosityQueue))
          ? b.memory.data.curiosityQueue.filter(x => x && x.asked !== true) : [];
        const residues = (ctx.fromSleep === true && staging && Array.isArray(staging.dayResidues) && staging.dayResidues.length > 0)
          ? staging.dayResidues
          : extractDayResidues(snap.activeItems || [], verifiedEvidence || [], unaskedCuriosities);
        const dreamPrompt = buildDreamSynthesisPrompt(residues, snap.windowNo);

        const evList = verifiedEvidence || [];
        const sourceEvidenceIds = evList.map(e => e.evidenceId).filter(Boolean);

        const sourceEventIds = [];
        for (const ev of evList) {
          if (ev.eventId) {
            sourceEventIds.push(ev.eventId);
          } else if (ev.messageId) {
            const matchingEvt = events.find(e => e.messageId === ev.messageId);
            if (matchingEvt) {
              sourceEventIds.push(matchingEvt.eventId);
            }
          }
        }

        const windowActiveItems = snap.activeItems || [];
        let sourceMessageRange = null;
        if (windowActiveItems.length > 0) {
          const firstMsg = windowActiveItems[0];
          const lastMsg = windowActiveItems[windowActiveItems.length - 1];
          sourceMessageRange = {
            startMessageId: firstMsg.messageId || String(firstMsg.id || 'unknown'),
            endMessageId: lastMsg.messageId || String(lastMsg.id || 'unknown'),
            count: windowActiveItems.length
          };
        } else if (evList.length > 0) {
          const evMsgIds = evList.map(e => e.messageId).filter(Boolean);
          if (evMsgIds.length > 0) {
            sourceMessageRange = {
              startMessageId: evMsgIds[0],
              endMessageId: evMsgIds[evMsgIds.length - 1],
              count: evMsgIds.length
            };
          }
        }

        const dreamStartGen = b.generationId;
        const dreamRecord = await synthesizeDream(b.api, dreamPrompt, {
          windowNo: snap.windowNo,
          preClose: Boolean(ctx.preClose),
          sourceEvidenceIds,
          sourceEventIds,
          eventProvenanceStatus: sourceEventIds.length > 0
            ? 'evidence_linked'
            : (events.length > 0 ? 'unavailable' : 'no_window_events'),
          sourceMessageRange,
          sourceEvents: events,
          sourceEvidence: evList,
          verifiedEvidence: evList,
          dayResidues: residues,
          gateMetrics: gateResult.metrics,
          gateThresholds: gateResult.thresholds,
          fromSleep: ctx.fromSleep === true,
          sleepElapsedMs: (ctx.fromSleep === true && Number.isFinite(ctx.sleepElapsedMs)) ? ctx.sleepElapsedMs : null,
          sleepStartTime: (ctx.fromSleep === true && Number.isFinite(ctx.sleepStartTime))
            ? ctx.sleepStartTime
            : ((ctx.fromSleep === true && staging && Number.isFinite(staging.at)) ? staging.at : null)
        }, {
          ...(b.cfg.dreamConfig || {}),
          now
        });

        if (b.shutdownRequested || b.generationId !== dreamStartGen) {
          return;
        }
        if (dreamRecord) {
          if (b.memory && b.memory.isMemoryDynamicsActive
              && typeof b.memory.engramManager.consolidateByDream === 'function') {
            try {
              const c = b.memory.engramManager.consolidateByDream(snap.windowNo, { topN: 3 });
              if (c && Array.isArray(c.consolidated) && c.consolidated.length) {
                dreamRecord.payload = dreamRecord.payload || {};
                dreamRecord.payload.consolidatedTraceIds = c.consolidated;
                b.memory.save(true);
              }
            } catch (e) {
              // 巩固是旁路增益：失败绝不影响梦境归档本身
            }
          }
          if (b.memory && typeof b.memory.markCuriosityIncubated === 'function') {
            const incubatedTexts = residues
              .filter(r => r && r.sourceType === 'unresolved_curiosity')
              .map(r => r.text);
            if (incubatedTexts.length) {
              b.memory.markCuriosityIncubated(incubatedTexts, snap.windowNo);
            }
          }
          if (!Array.isArray(b.dreamHistory)) b.dreamHistory = [];
          b.dreamHistory.push(dreamRecord);
          b.experiencesArchive.append(dreamRecord);
          const fragText = String((dreamRecord.payload && (dreamRecord.payload.content || dreamRecord.payload.narrative)) || '').trim();
          if (fragText && b.memory && b.memory.data) {
            if (ctx.isWindowClose === true) {
              if (!Array.isArray(b.memory.data.dreamFragments)) b.memory.data.dreamFragments = [];
              b.memory.data.dreamFragments.push(fragText.slice(0, 400));
              if (b.memory.data.dreamFragments.length > 3) {
                b.memory.data.dreamFragments = b.memory.data.dreamFragments.slice(-3);
              }
            } else {
              if (!Array.isArray(b.memory.data.pendingDreamFragments)) b.memory.data.pendingDreamFragments = [];
              b.memory.data.pendingDreamFragments.push(fragText.slice(0, 400));
              if (b.memory.data.pendingDreamFragments.length > 3) {
                b.memory.data.pendingDreamFragments = b.memory.data.pendingDreamFragments.slice(-3);
              }
            }
            b.memory.save(true);
          }
          if (dreamRecord.usage) {
            b.track(dreamRecord.usage, true, 'dream');
            b.saveStats(true);
          }
        }
      }
    } catch (err) {
      console.error('[Brain] Dream consolidation failed (Fail-Safe):', redactSecrets(err.message));
    }
  }
}

module.exports = { WindowClosingPipeline, summarySegmentPlan };
