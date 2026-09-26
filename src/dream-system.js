/**
 * src/dream-system.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 成本门禁式梦境系统与脱机记忆重放整合引擎 (v0.9.7)
 * 
 * 核心设计准则：
 * 1. 成本门禁原则（Cost-Gated Dream Consolidation）：
 *    梦境绝非每个窗口关闭必调的例行公事！普通窗口只做 5×20 小结并关闭。
 *    仅在发生高情绪方差（Arousal 剧烈震荡）或认知冲突（同一 Trait 证据剧烈撕裂/新实体碰撞）时，
 *    且通过窗口间隔与 24h 频次硬顶成本门禁后，才允许爆发单次 Dream API 调用。
 * 2. 纯本地两道门禁（Pure Local Gate）：
 *    第一道认知门禁与第二道成本门禁 100% 由本地纯代数算法判定，0 API 消耗。
 * 3. 容灾与主链路隔离（Non-blocking Fail-Safe）：
 *    Dream API 失败或超时，绝不阻塞 Window Summary、SubjectState 提交或 Memory 正常关窗。
 * 4. 认识论防线（Epistemic Boundary）：
 *    梦境产物以 recordType: "subject_dream" 附带 epistemicStatus: "DREAM_GENERATED_ARTIFACT" 归档，
 *    严禁直接输入 SubjectState Reducer，严禁直接造成状态向量跃迁。
 * 5. 弗洛伊德精神分析结构设计（Freudian Framework）：
 *    以《梦的解析》中的日间遗留（Day Residues）、凝缩（Condensation）与移位（Displacement）
 *    作为象征性梦境生成结构，仅作为艺术与认知建模框架，不假称人类脑科学定理。
 */

'use strict';

const crypto = require('crypto');
const { MEMORY_EPISTEMIC_STATUS } = require('./experiment-types');

const DEFAULT_DREAM_CONFIG = Object.freeze({
  // 第一道：本地认知门禁阈值
  emotionalVarianceThreshold: 15.0,  // Arousal 轨迹方差门槛
  arousalSpikeThreshold: 25.0,       // 单次 Arousal 突变幅度门槛
  noveltyThreshold: 0.8,             // 新异度门槛 (0.0 ~ 1.0)
  cognitiveConflictThreshold: 0.75,  // 认知方向冲突门槛 (同一特质正负撕裂)

  // 第二道：成本与频次门禁
  minimumDreamIntervalWindows: 3,    // 梦境最少间隔窗口数
  maximumDreamCallsPer24h: 2,        // 24小时内最多允许梦境调用次数
  dreamMaxTokens: 350,               // 梦境生成最大 Token 预算
  dreamTemperature: 0.7              // 梦境联想生成适度发散温度
});

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * 依据当前窗口内的真实交互事件与证据计算 Arousal 轨迹 (0 API 调用，纯本地确定性算法)
 * 划分为 5 个连续分段观察点，结合消息密度、交互频次与证据情绪极性与强度映射神经唤醒度。
 */
function computeWindowArousalTrajectory(activeItems = [], verifiedEvidence = [], segments = []) {
  const segmentCount = 5;
  const trajectory = [];
  const items = Array.isArray(activeItems) ? activeItems : [];
  const evidences = Array.isArray(verifiedEvidence) ? verifiedEvidence : [];

  const chunkSize = Math.max(1, Math.ceil(items.length / segmentCount));

  for (let sIdx = 0; sIdx < segmentCount; sIdx++) {
    let segmentArousal = 50; // 基准唤醒度 50
    const chunk = items.slice(sIdx * chunkSize, (sIdx + 1) * chunkSize);
    const chunkMsgIds = new Set(chunk.map(m => m.messageId).filter(Boolean));

    // 1. 消息间隔与时间密度影响 (短时间内连续密集互动增加唤醒度)
    if (chunk.length >= 2) {
      let rapidInteractions = 0;
      for (let i = 1; i < chunk.length; i++) {
        const tDiff = (chunk[i].t || 0) - (chunk[i - 1].t || 0);
        if (tDiff > 0 && tDiff < 10000) {
          rapidInteractions++;
        }
      }
      segmentArousal += Math.min(15, rapidInteractions * 3);
    }

    // 2. 属于该分段的证据情绪影响
    const chunkEvidences = evidences.filter(e => chunkMsgIds.has(e.messageId));
    for (const ev of chunkEvidences) {
      const str = typeof ev.strength === 'number' ? ev.strength : 0.5;
      const dir = typeof ev.direction === 'number' ? ev.direction : 1;
      if (ev.trait === 'vitality' || ev.trait === 'attachment_need' || ev.trait === 'social_initiative') {
        segmentArousal += Math.round(dir * str * 20);
      } else if (ev.trait === 'quiet_preference' && dir > 0) {
        segmentArousal -= Math.round(str * 15);
      }
    }

    trajectory.push(Math.max(10, Math.min(95, segmentArousal)));
  }

  return trajectory;
}

/**
 * 纯函数：第一道与第二道梦境门禁综合评估 (0 API 调用)
 */
function evaluateDreamGate(opts = {}) {
  const cfg = { ...DEFAULT_DREAM_CONFIG, ...(opts.config || {}) };
  const windowNo = opts.windowNo || 1;
  const verifiedEvidence = Array.isArray(opts.verifiedEvidence) ? opts.verifiedEvidence : [];
  const dreamHistory = Array.isArray(opts.dreamHistory) ? opts.dreamHistory : [];

  // 1. 条件 A：情绪 / Arousal 波动计算 (优先使用真实注入的 arousalTrajectory，兼容 stateHistory)
  let arousalValues = [];
  if (Array.isArray(opts.arousalTrajectory) && opts.arousalTrajectory.length > 0) {
    arousalValues = opts.arousalTrajectory.map(v => typeof v === 'number' ? v : 50);
  } else if (Array.isArray(opts.stateHistory) && opts.stateHistory.length > 0) {
    arousalValues = opts.stateHistory.map(s => {
      if (!s) return 50;
      if (typeof s.arousal === 'number') return s.arousal;
      if (s.deltas && typeof s.deltas === 'object') {
        const vit = typeof s.deltas.vitality === 'number' ? s.deltas.vitality : 0;
        const sumDeltas = Object.values(s.deltas).reduce((sum, d) => sum + Math.abs(d || 0), 0);
        return Math.max(0, Math.min(100, Math.round(50 + vit + (sumDeltas * 0.5))));
      }
      if (s.values && typeof s.values.vitality === 'number') {
        return Math.max(0, Math.min(100, Math.round(50 + s.values.vitality / 20)));
      }
      return 50;
    });
  } else {
    arousalValues = [50];
  }

  let arousalVariance = 0;
  let maxArousalSpike = 0;

  if (arousalValues.length >= 2) {
    const mean = arousalValues.reduce((a, b) => a + b, 0) / arousalValues.length;
    arousalVariance = arousalValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arousalValues.length;
    for (let i = 1; i < arousalValues.length; i++) {
      const spike = Math.abs(arousalValues[i] - arousalValues[i - 1]);
      if (spike > maxArousalSpike) maxArousalSpike = spike;
    }
  }

  // 2. 条件 B：认知冲突计算 (同一 Trait 同时存在正向与负向较强证据)
  let cognitiveConflictScore = 0;
  const traitDirs = {};
  for (const ev of verifiedEvidence) {
    if (!ev || !ev.trait) continue;
    if (!traitDirs[ev.trait]) traitDirs[ev.trait] = { pos: 0, neg: 0 };
    if (ev.direction > 0) traitDirs[ev.trait].pos += (ev.strength || 1);
    if (ev.direction < 0) traitDirs[ev.trait].neg += (ev.strength || 1);
  }
  for (const [trait, counts] of Object.entries(traitDirs)) {
    if (counts.pos >= 0.5 && counts.neg >= 0.5) {
      cognitiveConflictScore += Math.min(counts.pos, counts.neg);
    }
  }

  // 新异性评估 (如有显式传入的 noveltyScore)
  const noveltyScore = Number(opts.noveltyScore || 0);

  // 第一道认知门禁综合判定
  const conditionEmotional = arousalVariance >= cfg.emotionalVarianceThreshold || maxArousalSpike >= cfg.arousalSpikeThreshold;
  const conditionConflict = cognitiveConflictScore >= cfg.cognitiveConflictThreshold;
  const conditionNovelty = noveltyScore >= cfg.noveltyThreshold;
  const eligible = conditionEmotional || conditionConflict || conditionNovelty;

  // 3. 第二道成本门禁判定
  let costGatePassed = true;
  let costGateReason = 'PASSED';

  // 窗口间隔约束
  const lastDreamWindow = opts.lastDreamWindow ?? (dreamHistory.length > 0 ? dreamHistory[dreamHistory.length - 1].windowNo : null);
  if (lastDreamWindow !== null && (windowNo - lastDreamWindow) < cfg.minimumDreamIntervalWindows) {
    costGatePassed = false;
    costGateReason = `INTERVAL_TOO_SHORT (current: ${windowNo}, last: ${lastDreamWindow}, minGap: ${cfg.minimumDreamIntervalWindows})`;
  }

  // 24小时频次硬顶约束 (显式时间注入，绝不隐式依赖系统时刻漂移)
  const now = typeof opts.now === 'number' ? opts.now : (typeof opts.timestamp === 'number' ? opts.timestamp : Date.now());
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const recentDreamCount = dreamHistory.filter(d => (d.generatedAt || d.timestamp || 0) >= oneDayAgo).length;
  if (recentDreamCount >= cfg.maximumDreamCallsPer24h) {
    costGatePassed = false;
    costGateReason = `DAILY_RATE_LIMIT_EXCEEDED (recent24h: ${recentDreamCount}, max: ${cfg.maximumDreamCallsPer24h})`;
  }

  const allowDream = Boolean(eligible && costGatePassed);

  return {
    eligible,
    costGatePassed,
    allowDream,
    reason: !eligible ? 'INSUFFICIENT_TENSION' : (costGatePassed ? 'TENSION_THRESHOLD_MET' : costGateReason),
    metrics: {
      arousalVariance: Number(arousalVariance.toFixed(4)),
      maxArousalSpike: Number(maxArousalSpike.toFixed(4)),
      cognitiveConflictScore: Number(cognitiveConflictScore.toFixed(4)),
      noveltyScore: Number(noveltyScore.toFixed(4))
    },
    thresholds: {
      emotionalVarianceThreshold: cfg.emotionalVarianceThreshold,
      arousalSpikeThreshold: cfg.arousalSpikeThreshold,
      cognitiveConflictThreshold: cfg.cognitiveConflictThreshold,
      noveltyThreshold: cfg.noveltyThreshold,
      minimumDreamIntervalWindows: cfg.minimumDreamIntervalWindows,
      maximumDreamCallsPer24h: cfg.maximumDreamCallsPer24h
    }
  };
}

/**
 * 提取日间遗留 (Day Residues)：提炼用于梦境合成的高张力关键碎片（绝非完整100轮对话）
 */
function extractDayResidues(activeItems = [], verifiedEvidence = []) {
  const residues = [];

  // 从证据引文中提取高强度认知碎片
  for (const ev of verifiedEvidence.slice(0, 5)) {
    if (ev && ev.quote) {
      residues.push({
        sourceType: 'evidence_quote',
        trait: ev.trait,
        text: String(ev.quote).slice(0, 100)
      });
    }
  }

  // 从最后几条活跃对话中提取尾部残余
  const tailMessages = activeItems.slice(-4);
  for (const m of tailMessages) {
    if (m && m.content && !m.bridge) {
      residues.push({
        sourceType: 'tail_conversation',
        role: m.role,
        text: String(m.content).slice(0, 120)
      });
    }
  }

  return residues.slice(0, 6);
}

/**
 * 构建符合弗洛伊德《梦的解析》架构的梦境合成提示词
 */
function buildDreamSynthesisPrompt(residues, windowNo) {
  const residueList = residues.map((r, i) => `${i + 1}. [${r.sourceType}] ${r.text}`).join('\n');

  const system = `你现在是初澜（Chulan）的潜意识梦境合成引擎。
根据弗洛伊德《梦的解析》模型，梦境是脱机处理未解张力的象征性加工机制，具有三大特征：
1. 日间遗留（Day Residues）：梦境材料来源于日间未被完全消化的经验碎片。
2. 凝缩（Condensation）：将两个看似无关的经验实体或情境熔接为一个独特的梦境意象。
3. 移位（Displacement）：将强烈的情感张力置换转移到一个微小或无关的客观符号上。

【硬性约束】：
- 输出一段 100~200 字的第一人称朦胧意象梦境叙述（以初澜的主观梦感呈现）。
- 必须包含超现实隐喻与象征性熔接，禁止机械罗列日间事实。
- 绝不输出任何 JSON、解释说明或分析评述，只输出梦境正文。`;

  const user = `【窗口 #${windowNo} 收集到的日间遗留残余】：
${residueList || '（平静而散落的日常微澜）'}

请以此为潜意识基质，生成初澜的一段凝缩与移位象征梦境。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/**
 * 梦境合成生成执行器
 */
async function synthesizeDream(apiClient, promptMessages, context = {}, options = {}) {
  const cfg = { ...DEFAULT_DREAM_CONFIG, ...options };
  const windowNo = context.windowNo || 1;
  const promptText = JSON.stringify(promptMessages);
  const promptHash = sha256(promptText);

  try {
    const res = await apiClient.complete(promptMessages, {
      maxTokens: cfg.dreamMaxTokens,
      temperature: cfg.dreamTemperature
    });

    const content = String(res.text || '').trim();
    if (!content) return null;

    const now = typeof options.now === 'number' ? options.now : Date.now();
    const dreamId = `dream-w${windowNo}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const outputHash = sha256(content);

    const dreamPayload = {
      dreamId,
      windowNo,
      epistemicStatus: MEMORY_EPISTEMIC_STATUS.DREAM_GENERATED_ARTIFACT,
      promptHash,
      outputHash,
      prompt: {
        system: promptMessages[0] ? promptMessages[0].content : '',
        user: promptMessages[1] ? promptMessages[1].content : ''
      },
      dayResidues: context.dayResidues || [],
      narrative: content,
      content,
      sourceEventIds: context.sourceEventIds || [],
      gateMetrics: context.gateMetrics || {},
      gateThresholds: context.gateThresholds || {},
      dreamModel: apiClient.cfg ? apiClient.cfg.model : (options.model || 'deepseek-chat'),
      provider: 'deepseek',
      generatedAt: now,
      metadata: {
        model: apiClient.cfg ? apiClient.cfg.model : (options.model || 'deepseek-chat'),
        temperature: cfg.dreamTemperature,
        synthesizedAt: new Date(now).toISOString()
      }
    };

    return {
      recordType: 'subject_dream',
      dreamId,
      windowNo,
      timestamp: now,
      epistemicStatus: MEMORY_EPISTEMIC_STATUS.DREAM_GENERATED_ARTIFACT,
      payload: dreamPayload,
      usage: res.usage || null,
      content,
      narrative: content,
      promptHash,
      outputHash,
      sourceEventIds: context.sourceEventIds || [],
      dayResidues: context.dayResidues || [],
      gateMetrics: context.gateMetrics || {},
      gateThresholds: context.gateThresholds || {},
      generatedAt: now
    };
  } catch (err) {
    console.error(`[DreamSystem] 窗口 #${windowNo} 梦境合成调用失败 (Fail-Safe 保障):`, err.message);
    return null;
  }
}

module.exports = {
  DEFAULT_DREAM_CONFIG,
  sha256,
  computeWindowArousalTrajectory,
  evaluateDreamGate,
  extractDayResidues,
  buildDreamSynthesisPrompt,
  synthesizeDream
};
