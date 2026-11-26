const fs = require('fs');
const { isPeakHour } = require('./deepseek');
const { getCostStrategy } = require('./cost-strategy');
const { normalizeUsage } = require('./usage-normalizer');
const { writeJsonAtomic } = require('./atomic');
const { DeferredWriter } = require('./deferred-writer');
const { redactSecrets } = require('./redact');

/**
 * 从 Brain 抽离的遥测、缓存破坏归因与统计账本模块。
 * 保持 stats / telemetryPath / telemetrySeq / pendingCacheBreakReason 字段仍在 brain 实例上，
 * 兼容外部测试与热替换钩子直接读取。
 */
class TelemetryTracker {
  constructor(brain) {
    this.brain = brain;
  }

  createStatsWriter() {
    const b = this.brain;
    return new DeferredWriter(() => writeJsonAtomic(b.statsPath, b.stats), { delayMs: 3000 });
  }

  restoreTelemetrySequence() {
    const b = this.brain;
    if (!b.telemetryPath || !fs.existsSync(b.telemetryPath)) return 0;
    let maxSeq = 0;
    try {
      for (const line of fs.readFileSync(b.telemetryPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record && Number.isInteger(record.telemetrySeq) && record.telemetrySeq > 0) {
            maxSeq = Math.max(maxSeq, record.telemetrySeq);
          }
        } catch {
          // 跳过受损的尾部行
        }
      }
    } catch {
      return 0;
    }
    return maxSeq;
  }

  recordCacheBreak(reason) {
    this.brain.pendingCacheBreakReason = reason || 'unknown';
  }

  appendTelemetry(data = {}) {
    const b = this.brain;
    if (!b.dir) return null;
    try {
      b.telemetrySeq = (b.telemetrySeq || 0) + 1;
      const rec = {
        telemetrySeq: b.telemetrySeq,
        timestamp: data.timestamp || Date.now(),
        windowNo: (typeof data.windowNo === 'number' && !Number.isNaN(data.windowNo))
          ? data.windowNo
          : (b.memory ? b.memory.data.windowNo : 1),
        recordType: data.recordType || 'llm_call',
        requestType: data.requestType || (data.recordType ? null : 'chat'),
        promptTokens: typeof data.promptTokens === 'number' ? data.promptTokens : 0,
        promptCacheHitTokens: typeof data.promptCacheHitTokens === 'number' ? data.promptCacheHitTokens : 0,
        promptCacheMissTokens: typeof data.promptCacheMissTokens === 'number' ? data.promptCacheMissTokens : 0,
        completionTokens: typeof data.completionTokens === 'number' ? data.completionTokens : 0,
        cacheHitRate: typeof data.cacheHitRate === 'number' ? data.cacheHitRate : 0,
        cacheBreakReason: data.cacheBreakReason || null
      };
      if (data.recordType === 'perception_attach') {
        rec.category = data.category || null;
        rec.salience = typeof data.salience === 'number' ? data.salience : null;
        if (data.perceptionId) rec.perceptionId = data.perceptionId;
        if (typeof data.turnNo === 'number') rec.turnNo = data.turnNo;
      }
      if (data.recordType === 'provider_fallback') {
        rec.reason = data.reason || null;
        rec.primaryFailed = Boolean(data.primaryFailed);
        rec.primaryConnectionId = data.primaryConnectionId || null;
        rec.fallbackConnectionId = data.fallbackConnectionId || null;
      }
      if (data.recordType === 'reconsolidation_candidate_observed') {
        rec.traceId = data.traceId || null;
        rec.sourceWindowNo = Number.isFinite(data.sourceWindowNo) ? data.sourceWindowNo : null;
        rec.reactivatedWindowNo = Number.isFinite(data.reactivatedWindowNo) ? data.reactivatedWindowNo : null;
        rec.prevTier = data.prevTier || null;
      }
      if (!fs.existsSync(b.dir)) {
        fs.mkdirSync(b.dir, { recursive: true });
      }
      fs.appendFileSync(b.telemetryPath, JSON.stringify(rec) + '\n', 'utf8');
      return rec;
    } catch (e) {
      console.error('[Brain] appendTelemetry failed:', redactSecrets(e.message));
      return null;
    }
  }

  loadStats() {
    // 老版本的 stats.json 可能缺字段，用默认值兜一层再合并，
    // 否则 undefined++ 会变 NaN，面板上一串 NaN。
    const base = {
      requests: 0, hit: 0, miss: 0, out: 0, cost: 0,
      compressions: 0, merges: 0, summaryCalls: 0, growthCalls: 0,
      // v0.9.9 观测补盲：关窗失败率 / 带病归档占比 / 补关发生率（长期健康度指标）
      windowCloseFailures: 0, summaryUncertified: 0, delayedCloses: 0, truncatedCalls: 0,
      lastHitRate: 0, history: []
    };
    try { return { ...base, ...JSON.parse(fs.readFileSync(this.brain.statsPath, 'utf8')) }; }
    catch { return base; }
  }

  saveStats(immediate = false) {
    this.brain.statsWriter.markDirty();
    if (immediate) {
      this.brain.statsWriter.flush();
    }
  }

  /**
   * summary=true 时只累计花费，不计入命中率。
   * 小结/合并是另一套前缀，混进主线会让命中率的数字失真。
   */
  track(usage, summary = false, bucket = summary ? 'summary' : 'chat') {
    const b = this.brain;
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens || 0;
    const out = usage.completion_tokens || 0;
    // P5-A: 成本统计由当前 providerId 的 Cost Strategy 决定（不再由 DeepSeek concrete costOf 记账）。
    const providerIdForCost = b.cfg.provider || require('./provider-policy').providerFor(b.cfg.baseURL);
    const costStrategy = getCostStrategy(providerIdForCost);
    let c = null;
    if (costStrategy) {
      const peakValleyPrice = (b.cfg.price && (isPeakHour() ? b.cfg.price.peak : b.cfg.price.valley)) || {};
      const pricingContext = {
        ...peakValleyPrice,
        pricingVersion: (b.cfg.price && b.cfg.price.pricingVersion) || undefined
      };
      c = costStrategy.calculate(normalizeUsage(usage, providerIdForCost), pricingContext).cost;
    }
    // E-02: 未知成本（null）不得伪装为 0 —— 不累加、history 显式记 null
    const costKnown = c !== null;
    const hitRateRatio = (hit + miss) ? hit / (hit + miss) : 0;

    let breakReason = null;
    if (miss > 0) {
      if (bucket === 'chat') {
        breakReason = b.pendingCacheBreakReason || (hit === 0 ? 'unknown' : null);
        b.pendingCacheBreakReason = null;
      } else {
        // v0.9.9: 小结/合并/成长/梦境各是独立提示词家族，不消费 chat 的缓存破坏归因
        breakReason = hit === 0 ? 'unknown' : null;
      }
    }

    this.appendTelemetry({
      timestamp: Date.now(),
      windowNo: b.memory ? b.memory.data.windowNo : 1,
      requestType: bucket,
      promptTokens: usage.prompt_tokens || hit + miss,
      promptCacheHitTokens: hit,
      promptCacheMissTokens: miss,
      completionTokens: out,
      cacheHitRate: +(hitRateRatio.toFixed(4)),
      cacheBreakReason: breakReason
    });

    b.stats.history.push({
      t: Date.now(), hit, miss, out, cost: costKnown ? +c.toFixed(6) : null,
      rate: (hit + miss) ? +(hit / (hit + miss) * 100).toFixed(1) : 0,
      kind: bucket,
      prompt: usage.prompt_tokens || hit + miss
    });
    if (b.stats.history.length > 300) b.stats.history.shift();

    if (costKnown) b.stats.cost += c;
    if (summary) {
      // v0.9.9: 计数按桶如实分账 —— summaryCalls 只数「summary」小结调用
      if (bucket === 'summary') {
        b.stats.summaryCalls = (b.stats.summaryCalls || 0) + 1;
      }
      b.stats[bucket + 'PromptTokens'] = (b.stats[bucket + 'PromptTokens'] || 0)
        + (usage.prompt_tokens || hit + miss);
      b.stats[bucket + 'OutputTokens'] = (b.stats[bucket + 'OutputTokens'] || 0) + out;
      if (costKnown) b.stats[bucket + 'Cost'] = (b.stats[bucket + 'Cost'] || 0) + c;
    } else {
      b.stats.requests++;
      b.stats.hit += hit;
      b.stats.miss += miss;
      b.stats.out += out;
      b.stats.lastHitRate = (hit + miss) ? hit / (hit + miss) : 0;
    }
    this.saveStats();
  }

  report() {
    const b = this.brain;
    const tot = b.stats.hit + b.stats.miss;
    const m = b.memory;
    return {
      requests: b.stats.requests,
      hit: b.stats.hit,
      miss: b.stats.miss,
      out: b.stats.out,
      rate: tot ? +(b.stats.hit / tot * 100).toFixed(1) : 0,
      lastRate: +(b.stats.lastHitRate * 100).toFixed(1),
      cost: +b.stats.cost.toFixed(4),
      compressions: b.stats.compressions,
      merges: b.stats.merges || 0,
      growthCalls: b.stats.growthCalls || 0,
      growthPromptTokens: b.stats.growthPromptTokens || 0,
      growthOutputTokens: b.stats.growthOutputTokens || 0,
      growthCost: +(b.stats.growthCost || 0).toFixed(4),
      summaryCost: +(b.stats.summaryCost || 0).toFixed(4),
      mergeCost: +(b.stats.mergeCost || 0).toFixed(4),
      peak: isPeakHour(),
      model: b.cfg.model,

      // 记忆状态
      windowTurns: m.data.turnsInWindow,
      windowTarget: m.windowTurns,
      windowNo: m.data.windowNo,
      totalTurns: m.data.totalTurns,
      historyLen: m.history.length,
      historyTokens: m.historyTokens(),
      segments: m.windows.length,
      memoryTokens: m.memoryTokens(),
      memoryCap: m.memoryCap,
      contextTokens: m.contextTokens(),
      selfLedgerEntries: b.selfLedger.entries.length,
      rawLedgerChars: b.selfLedger.estimatedRawChars(),
      currentSelfTokens: Math.ceil(b.selfLedger.currentSelfText().length / 2),
      birthAt: b.birthAt,
      archiveStatus: b.selfLedger.status,
      subjectState: b.subjectState ? b.subjectState.values : null,
      archiveEntries: b.experiencesArchive ? b.experiencesArchive.count() : 0,
      bridgeCount: m.history.filter(x => x.bridge).length,
      // v0.9.9 P0-2（C 半）：主链锁死导致经历溢写到 sidecar 的告警，供上层/人工检查
      archiveSpilloverCount: Array.isArray(b.archiveSpillovers) ? b.archiveSpillovers.length : 0,
      archiveSpilloverLast: (Array.isArray(b.archiveSpillovers) && b.archiveSpillovers.length)
        ? b.archiveSpillovers[b.archiveSpillovers.length - 1]
        : null
    };
  }
}

module.exports = { TelemetryTracker };
