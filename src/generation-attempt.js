/**
 * src/generation-attempt.js — Generation Attempt / Result（v0.9.8 P4-1）
 *
 * 语义边界：
 * - 一次 provider 调用 = 一个 Attempt；
 * - Retry（调用内部的重试）≠ 新语义生成 —— 不产生新 Attempt，只记 attempt.retryState；
 * - Fallback = 新 Attempt（kind='fallback'）；
 * - 最终采用输出 = Result，必须保留全部 Attempt（含原始 provider 失败事实）。
 *
 * 本模块不接触 provenance / runtime evidence —— evidence 真值仍由
 * experiment-metadata 体系判定；Attempt 只做调用轨迹的事实记录。
 */

const { redactSecrets } = require('./redact');

function createAttempt({ attemptId, providerId, kind = 'initial', semanticKey = null, startedAt = null } = {}) {
  if (typeof attemptId !== 'string' || !attemptId.trim()) throw new Error('ATTEMPT_ID_REQUIRED');
  if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('PROVIDER_ID_REQUIRED');
  if (kind !== 'initial' && kind !== 'fallback') throw new Error('INVALID_ATTEMPT_KIND: ' + kind);
  return {
    attemptId: attemptId.trim(),
    providerId: providerId.trim(),
    kind,
    semanticKey,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    finishedAt: null,
    outcome: 'pending', // pending | success | failure
    retryState: null,   // 调用内部 retry 轨迹（≠ 新 Attempt）
    error: null,
    output: null,
    usage: null,
    observedModel: null,
    outputYielded: false
  };
}

/** 流式已向调用方交付生成内容（此后禁止静默从头重生成 / 禁止 silent fallback）。 */
function markOutputYielded(attempt) {
  attempt.outputYielded = true;
  return attempt;
}

function markAttemptSuccess(attempt, { output = null, usage = null, observedModel = null, retryState = null, finishedAt = null } = {}) {
  attempt.outcome = 'success';
  attempt.output = output;
  attempt.usage = usage || null;
  attempt.observedModel = observedModel || null;
  if (retryState) attempt.retryState = retryState;
  attempt.finishedAt = Number.isFinite(finishedAt) ? finishedAt : attempt.finishedAt;
  return attempt;
}

function markAttemptFailure(attempt, { errorType = 'unknown_error', status = null, retryable = false, retryState = null, message = null, finishedAt = null } = {}) {
  attempt.outcome = 'failure';
  attempt.error = {
    errorType,
    status,
    retryable: Boolean(retryable),
    retryState: retryState || null,
    message: message === null ? null : redactSecrets(String(message)) // 永不落 raw secret
  };
  if (retryState) attempt.retryState = retryState;
  attempt.finishedAt = Number.isFinite(finishedAt) ? finishedAt : attempt.finishedAt;
  return attempt;
}

/**
 * Result：最终采用输出 + 完整 Attempt 轨迹。
 * fail-closed：adoptedAttemptId 必须指向 success 的 Attempt，否则拒绝构造。
 */
function createGenerationResult({ semanticKey = null, attempts, adoptedAttemptId, routing = null } = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) throw new Error('ATTEMPTS_REQUIRED');
  const adopted = attempts.find(a => a && a.attemptId === adoptedAttemptId);
  if (!adopted) throw new Error('ADOPTED_ATTEMPT_NOT_FOUND');
  if (adopted.outcome !== 'success') throw new Error('ADOPTED_ATTEMPT_NOT_SUCCESSFUL');
  return {
    semanticKey,
    adoptedAttemptId,
    selectedProvider: adopted.providerId,
    output: adopted.output,
    usage: adopted.usage,
    observedModel: adopted.observedModel,
    attempts, // 完整轨迹（失败事实保留，fallback 不覆盖原 provenance）
    routing: routing || null
  };
}

module.exports = {
  createAttempt,
  markOutputYielded,
  markAttemptSuccess,
  markAttemptFailure,
  createGenerationResult
};
