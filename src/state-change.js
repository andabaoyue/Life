/**
 * State Change 与解释可追溯模块 (v0.9.4)
 * 
 * 核心设计边界：
 * 1. State Change（状态跃迁记录）：每次由 Reducer 触发的状态变动必须生成不可篡改的变更记录，
 *    记录包含 previousValue, delta, newValue, evidenceIds 与 Reducer 计算参数。
 * 2. 状态值全由确定性 Reducer 产生，LLM 严禁直接赋写 previousValue, delta 或 newValue。
 * 3. State Change Explanation（状态变更解释）：必须严格引用已存在的 State Change 与 Evidence。
 *    若解释声称的数值与真实 Reducer 计算结果不一致，则该解释被裁定为无效（INVALID），严禁影响状态。
 */

/**
 * 纯函数：正负对称的整数化规则 (v0.9.6 P0-10)
 * 严格满足：symmetricRound(-x) === -symmetricRound(x)
 * 消除传统 Math.round(+1.5)=2 与 Math.round(-1.5)=-1 的不对称方向偏差。
 */
function symmetricRound(x) {
  if (x === 0 || !Number.isFinite(x)) return 0;
  return Math.sign(x) * Math.round(Math.abs(x));
}

let stateChangeSeq = 0;

/**
 * 创建确定性状态跃迁记录
 */
function createStateChange(opts = {}) {
  stateChangeSeq++;
  const stateChangeId = opts.stateChangeId || opts.changeId || ('sc-' + String(stateChangeSeq).padStart(6, '0'));
  const previousValue = Number.isFinite(opts.previousValue) ? opts.previousValue : 0;
  const delta = Number.isFinite(opts.delta) ? opts.delta : 0;
  const newValue = Number.isFinite(opts.newValue) ? opts.newValue : (previousValue + delta);

  const baseStepWeight = opts.baseStepWeight ?? opts.stepWeight ?? 20;
  const plasticityMultiplier = typeof opts.plasticityMultiplier === 'number' ? opts.plasticityMultiplier : 1.0;
  const effectiveStepWeight = opts.effectiveStepWeight ?? Number((baseStepWeight * plasticityMultiplier).toFixed(6));

  return {
    stateChangeId,
    changeId: stateChangeId, // 别名支持
    windowNo: (typeof opts.windowNo === 'number' && !Number.isNaN(opts.windowNo)) ? opts.windowNo : (opts.windowNo === null ? null : 1),
    trait: String(opts.trait || '').trim(),
    previousValue,
    delta,
    newValue,
    evidenceIds: Array.isArray(opts.evidenceIds) ? [...opts.evidenceIds] : [],
    roundingMode: opts.roundingMode || 'symmetric',
    baseStepWeight,
    effectiveStepWeight,
    plasticityMultiplier,
    reducer: {
      stepWeight: effectiveStepWeight,
      baseStepWeight,
      effectiveStepWeight,
      plasticityMultiplier,
      maxDelta: opts.maxDelta ?? 50,
      roundingMode: opts.roundingMode || 'symmetric'
    },
    createdAt: opts.createdAt || Date.now()
  };
}

/**
 * 校验 StateChange 合法性
 */
function validateStateChange(sc) {
  if (!sc || typeof sc !== 'object') return { valid: false, reason: 'INVALID_OBJECT' };
  const id = sc.stateChangeId || sc.changeId;
  if (typeof id !== 'string' || !id.trim()) return { valid: false, reason: 'MISSING_STATE_CHANGE_ID' };
  if (typeof sc.trait !== 'string' || !sc.trait.trim()) return { valid: false, reason: 'MISSING_TRAIT' };
  if (!Number.isFinite(sc.previousValue) || sc.previousValue < -999 || sc.previousValue > 999) return { valid: false, reason: 'PREVIOUS_VALUE_OUT_OF_BOUNDS' };
  if (!Number.isFinite(sc.newValue) || sc.newValue < -999 || sc.newValue > 999) return { valid: false, reason: 'NEW_VALUE_OUT_OF_BOUNDS' };
  if (sc.newValue !== Math.max(-999, Math.min(999, sc.previousValue + sc.delta))) {
    return { valid: false, reason: 'VALUE_ARITHMETIC_MISMATCH' };
  }
  return { valid: true };
}

/**
 * 创建 State Change 解释材料对象
 */
function createStateChangeExplanation(stateChange, explanationData = {}) {
  if (!stateChange || (!stateChange.stateChangeId && !stateChange.changeId)) {
    return { valid: false, reason: 'MISSING_TARGET_STATE_CHANGE' };
  }

  const id = stateChange.stateChangeId || stateChange.changeId;
  const summary = String(explanationData.text || explanationData.summary || explanationData.content || '').trim();
  if (!summary) {
    return { valid: false, reason: 'EMPTY_EXPLANATION' };
  }

  // 1. 显式 claimedTrait 检验
  if (explanationData.claimedTrait !== undefined) {
    if (explanationData.claimedTrait !== stateChange.trait) {
      return { valid: false, reason: 'TRAIT_MISMATCH', stateChangeId: id };
    }
  }

  // 2. 显式 claimedDelta 检验
  if (explanationData.claimedDelta !== undefined) {
    if (explanationData.claimedDelta !== stateChange.delta) {
      return { valid: false, reason: 'DELTA_MISMATCH', stateChangeId: id };
    }
  }

  // 3. evidenceIds 归属真实性核验 (P0-06)
  if (Array.isArray(explanationData.evidenceIds) && stateChange.evidenceIds) {
    const scEvSet = new Set(stateChange.evidenceIds);
    for (const eid of explanationData.evidenceIds) {
      if (!scEvSet.has(eid)) {
        return {
          valid: false,
          reason: 'EVIDENCE_ID_MISMATCH',
          stateChangeId: id,
          explanation: { summary, invalid: true }
        };
      }
    }
  }

  // 3. 正则推断校验：如果文本中明示了数值变动
  const deltaClaimMatch = summary.match(/(?:增加|减少|变动|提升|降低|delta|变化)\s*([+-]?\d+)/i);
  if (deltaClaimMatch && explanationData.claimedDelta === undefined) {
    const parsedNum = parseInt(deltaClaimMatch[1], 10);
    const sign = summary.includes('减少') || summary.includes('降低') ? -Math.abs(parsedNum) : parsedNum;
    if (sign !== stateChange.delta) {
      return {
        valid: false,
        reason: 'DELTA_MISMATCH',
        stateChangeId: id,
        explanation: { summary, invalid: true }
      };
    }
  }

  const evidenceDetails = Array.isArray(explanationData.evidence)
    ? explanationData.evidence
    : [];

  return {
    valid: true,
    stateChangeId: id,
    explanation: {
      summary,
      claimedDelta: explanationData.claimedDelta !== undefined ? explanationData.claimedDelta : stateChange.delta,
      claimedTrait: explanationData.claimedTrait !== undefined ? explanationData.claimedTrait : stateChange.trait,
      evidence: evidenceDetails.map(ev => ({
        evidenceId: ev.evidenceId || null,
        reason: String(ev.reason || '').trim()
      }))
    },
    createdAt: Date.now()
  };
}

module.exports = {
  createStateChange,
  validateStateChange,
  createStateChangeExplanation,
  symmetricRound
};
