/**
 * src/openai-transport.js — OpenAI-compatible 线协议通用传输层（v0.9.8 P5-B1/B2）
 *
 * 从 deepseek.js 提取真正通用的能力：endpoint 解析、HTTP retry、预算门禁、
 * 错误归一化。DeepSeek 与 Generic adapter 共用本层（deepseek.raw() 委托至此，
 * 行为保持兼容）；provider-specific 的 mint / usage / cache / cost 语义不在本层。
 *
 * B-2 baseURL 标准化硬约束：只允许 trim / URL 合法性校验 / 去除结尾 '/'。
 * 绝不删除有意义 path（/v1 保留）；绝不产生 '//chat/completions'。
 */

const { redactSecrets } = require('./redact');

/* ---- endpoint resolver（B-2） ---- */
function normalizeBaseURL(baseURL) {
  const s = String(baseURL == null ? '' : baseURL).trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    const err = new Error('INVALID_BASE_URL');
    err.name = 'InvalidBaseUrlError';
    throw err;
  }
  if (!/^https?:$/.test(u.protocol)) {
    const err = new Error('INVALID_BASE_URL_PROTOCOL');
    err.name = 'InvalidBaseUrlError';
    throw err;
  }
  return s.replace(/\/+$/, ''); // 仅去尾部斜杠，path（/v1 等）原样保留
}

function resolveChatCompletionsURL(baseURL) {
  return normalizeBaseURL(baseURL) + '/chat/completions';
}

/* ---- Provider HTTP Error 归一化（P1-2 语义原样保留） ---- */
function classifyProviderHttpError(status) {
  if (status === 429) return { errorType: 'rate_limited', retryable: true };
  if (status === 500 || status === 502 || status === 503 || status === 504) return { errorType: 'server_error', retryable: true };
  if (status === 401 || status === 403) return { errorType: 'auth_failed', retryable: false };
  if (status === 400 || status === 404) return { errorType: 'request_rejected', retryable: false };
  return { errorType: 'http_error', retryable: false };
}

function extractSafeDetail(text) {
  // 只允许读取可解析 JSON 的结构化 error.message / error.msg / 顶层 message
  //（redacted + 120 字符上限）；非合法 JSON 的 body 一律不作为 detail（P1.1-B）。
  try {
    const raw = String(text || '');
    let detail = '';
    try {
      const j = JSON.parse(raw);
      detail = (j && j.error && (j.error.message || j.error.msg)) || (j && typeof j.message === 'string' ? j.message : '');
    } catch {
      return '';
    }
    return redactSecrets(String(detail)).slice(0, 120);
  } catch { return ''; }
}

function makeProviderError({ status, provider, requestStage, errorType, retryable, safeDetail, retryState, cause }) {
  const err = new Error(
    `HTTP ${status === null || status === undefined ? 'n/a' : status} [${errorType}] provider=${provider} stage=${requestStage}` +
    (safeDetail ? ' ' + safeDetail : '')
  );
  err.name = 'ProviderError';
  err.status = status === undefined ? null : status;
  err.provider = provider;
  err.requestStage = requestStage;
  err.retryable = Boolean(retryable);
  err.errorType = errorType;
  if (retryState) err.retryState = retryState;
  if (cause) err.cause = cause;
  return err;
}

function parseRetryAfter(value) {
  if (value === null || value === undefined || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(String(value));
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function sleepMaybeAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (!ms || ms <= 0) { resolve(); return; }
    const cleanup = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const reason = signal && signal.reason;
      const err = reason instanceof Error ? reason : new Error(reason || 'aborted');
      err.name = err.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
      reject(err);
    };
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * OpenAI-compatible chat/completions 请求（含 P1 全部安全边界）：
 * provider-policy 门禁 → budget guard → retry（分类/hard cap/退避上限/Retry-After）。
 * 返回 fetch Response（成功时带 res.attempts）。
 */
async function requestChatCompletion({ cfg, body, signal, provider, credentialType: credentialTypeArg }) {
  const { providerFor, validateCredentialTarget } = require('./provider-policy');
  const { assertBudget } = require('./budget-guard');
  const providerId = provider || cfg.provider || providerFor(cfg.baseURL);
  // credentialType 由调用方/配置明确给出；共享层不做任何品牌分支
  const credentialType = credentialTypeArg || cfg.credentialType || 'apiKey';
  const policy = validateCredentialTarget({ provider: providerId, baseURL: cfg.baseURL, credentialType });
  if (!policy.ok) {
    // policy 失败属 non-retryable，且绝不发请求
    const err = new Error(`[Provider] Provider Policy 违规拦截: ${policy.error}`);
    err.name = 'PolicyError';
    err.retryable = false;
    err.errorType = 'policy_violation';
    err.requestStage = 'policy';
    throw err;
  }

  const url = resolveChatCompletionsURL(cfg.baseURL);
  const requestTimeoutMs = Number.isFinite(cfg.requestTimeoutMs) ? cfg.requestTimeoutMs : 60000;
  // retry 硬上限 + 指数退避 + 退避上限 + Retry-After；绝不无限 retry
  const HARD_MAX_RETRIES = 3;
  const configuredRetries = Number.isFinite(cfg.maxRetries) ? Math.max(0, Math.floor(cfg.maxRetries)) : 2;
  const maxRetries = Math.min(configuredRetries, HARD_MAX_RETRIES);
  const retryBaseDelayMs = Number.isFinite(cfg.retryBaseDelayMs) && cfg.retryBaseDelayMs >= 0 ? cfg.retryBaseDelayMs : 500;
  const RETRY_DELAY_CAP_MS = 5000;
  const MAX_RETRY_AFTER_MS = 30000;

  let attempt = 0;
  for (;;) {
    // Budget Guard —— 发送前按最坏资源消耗 fail-closed，绝不发请求；retry 不得绕过预算
    const budget = assertBudget({
      maxTokens: body && body.max_tokens,
      attempt,
      maxRetries,
      budgetMaxOutputTokens: cfg.budgetMaxOutputTokens
    });
    if (!budget.ok) {
      const err = new Error(`[Provider] Budget Guard 拦截: ${budget.reason} worstCase=${budget.worstCase} budget=${budget.budgetMaxOutputTokens}`);
      err.name = 'BudgetExceededError';
      err.retryable = false;
      err.errorType = 'budget_exceeded';
      err.requestStage = 'budget';
      throw err;
    }

    let res;
    // 如果上层未传递 signal，内部兜底建立超时保护控制器
    const fallbackCtrl = signal ? null : new AbortController();
    const timer = fallbackCtrl
      ? setTimeout(() => {
          const err = new Error('request timeout');
          err.name = 'TimeoutError';
          fallbackCtrl.abort(err);
        }, requestTimeoutMs)
      : null;

    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify(body),
        signal: signal || fallbackCtrl.signal
      });
    } catch (netErr) {
      // Abort/Timeout 保持原语义上抛（non-retryable）；其余网络错误按明确暂态处理
      if (netErr && (netErr.name === 'AbortError' || netErr.name === 'TimeoutError')) {
        netErr.retryState = { attempts: attempt + 1, maxRetries };
        throw netErr;
      }
      const canRetry = attempt < maxRetries && !(signal && signal.aborted);
      if (!canRetry) {
        throw makeProviderError({
          status: null,
          provider: providerId,
          requestStage: 'request',
          errorType: 'network_error',
          retryable: true,
          safeDetail: redactSecrets(String((netErr && netErr.message) || netErr)),
          retryState: { attempts: attempt + 1, maxRetries },
          cause: netErr
        });
      }
      const delayMs = Math.min(retryBaseDelayMs * Math.pow(2, attempt), RETRY_DELAY_CAP_MS);
      attempt++;
      await sleepMaybeAbort(delayMs, signal);
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const cls = classifyProviderHttpError(res.status);
      const retryAfterMs = parseRetryAfter(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null);
      const safeDetail = extractSafeDetail(text);
      const retryAfterTooLong = retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS;
      const canRetry = cls.retryable && attempt < maxRetries && !retryAfterTooLong && !(signal && signal.aborted);
      if (canRetry) {
        const expDelay = Math.min(retryBaseDelayMs * Math.pow(2, attempt), RETRY_DELAY_CAP_MS);
        const delayMs = retryAfterMs !== null ? Math.min(retryAfterMs, RETRY_DELAY_CAP_MS) : expDelay;
        attempt++;
        await sleepMaybeAbort(delayMs, signal);
        continue;
      }
      throw makeProviderError({
        status: res.status,
        provider: providerId,
        requestStage: 'request',
        errorType: cls.errorType,
        retryable: cls.retryable,
        safeDetail,
        retryState: { attempts: attempt + 1, maxRetries, retryAfterMs }
      });
    }
    res.attempts = attempt + 1;
    return res;
  }
}

module.exports = {
  normalizeBaseURL,
  resolveChatCompletionsURL,
  classifyProviderHttpError,
  extractSafeDetail,
  makeProviderError,
  parseRetryAfter,
  sleepMaybeAbort,
  requestChatCompletion
};
