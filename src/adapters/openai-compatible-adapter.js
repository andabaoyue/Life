/**
 * src/adapters/openai-compatible-adapter.js — Generic OpenAI-compatible Adapter（v0.9.8 P5-B1）
 *
 * 统一 Contract 实现（complete/stream/validateConfig/capabilities/normalizeError/usage）。
 * 红线：
 * - 不做 runtime evidence mint（不进入 attestation 信任根，产出不得冒充 provider_response evidence）；
 * - 不绕过 provider-policy / budget-guard / timeout / abort / retry（均走 openai-transport）；
 * - caller metadata 不升级为 provider truth。
 * 不复制 deepseek.js：HTTP/retry/错误归一化用 openai-transport，SSE 用 sse-parser。
 *
 * 【implemented+tested；production-wired：经 Registry 可被 Brain dispatch 使用，
 * 但本轮未接真实第三方服务（架构验证用途）】
 */

const {
  resolveChatCompletionsURL,
  makeProviderError,
  requestChatCompletion
} = require('../openai-transport');
const { createSSEParser } = require('../sse-parser');
const {
  validateAdapterContract,
  providerTypeFor,
  assertCapability,
  toUnifiedError
} = require('../provider-adapter');
const { normalizeUsage } = require('../usage-normalizer');
const { redactSecrets } = require('../redact');

function createOpenAICompatibleAdapter(cfg = {}, opts = {}) {
  const providerId = String(opts.providerId || cfg.provider || 'generic');
  let lastUsage = null;
  let lastNormalizedUsage = null;

  const adapter = {
    providerId,

    get providerType() { return providerTypeFor(cfg && cfg.baseURL); },

    get cfg() { return cfg; },

    /** adapter 自身配置完整性检查（不替代 provider-policy 组合准许判定）；B-2: baseURL 必须可解析 */
    validateConfig() {
      const problems = [];
      try {
        resolveChatCompletionsURL(cfg && cfg.baseURL);
      } catch {
        problems.push('baseURL invalid');
      }
      if (!cfg || typeof cfg.model !== 'string' || !cfg.model.trim()) problems.push('model missing');
      if (!cfg || typeof cfg.apiKey !== 'string' || !cfg.apiKey.trim()) problems.push('apiKey missing');
      return { ok: problems.length === 0, problems };
    },

    /** 只声明真实实现的能力；vision/tools/jsonMode 未实现 -> false（绝不虚报） */
    capabilities() {
      return {
        streaming: true,
        usage: true,
        systemMessage: true,
        vision: false,
        tools: false,
        jsonMode: false
      };
    },

    async complete(messages, callOpts = {}) {
      // P5-B-01: requestTimeoutMs 覆盖完整生命周期（fetch + response 解析）——
      // caller signal 转发到生命周期 controller；timeout 不因 caller signal 存在而失效；
      // transport 仍负责网络 retry / policy / budget；TimeoutError / AbortError 语义保持。
      const callerSignal = callOpts.signal;
      const ctrl = new AbortController();
      const forwardAbort = () => {
        const reason = callerSignal && callerSignal.reason;
        ctrl.abort(reason instanceof Error ? reason : Object.assign(new Error(reason || 'aborted'), { name: 'AbortError' }));
      };
      if (callerSignal) {
        if (callerSignal.aborted) forwardAbort();
        else callerSignal.addEventListener('abort', forwardAbort, { once: true });
      }
      const requestTimeoutMs = Number.isFinite(cfg.requestTimeoutMs) ? cfg.requestTimeoutMs : 60000;
      let timeoutTimer = null;
      const lifecycleTimeout = requestTimeoutMs > 0
        ? new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => {
              const err = new Error('request timeout');
              err.name = 'TimeoutError';
              ctrl.abort(err);   // 终止底层连接
              reject(err);       // response 解析挂起时同样 fail-fast
            }, requestTimeoutMs);
          })
        : null;
      // 若 fetch/网络阶段先失败，此 promise 可能无人消费 —— 挂 no-op catch 防未处理拒绝
      if (lifecycleTimeout) lifecycleTimeout.catch(() => {});

      try {
        const res = await requestChatCompletion({
          cfg,
          provider: providerId,
          body: {
            model: cfg.model,
            messages,
            stream: false,
            temperature: callOpts.temperature ?? 0.3,
            max_tokens: callOpts.maxTokens ?? 400
          },
          signal: ctrl.signal
        });
        let j;
        try {
          j = lifecycleTimeout ? await Promise.race([res.json(), lifecycleTimeout]) : await res.json();
        } catch (parseErr) {
          if (parseErr && parseErr.name === 'TimeoutError') throw parseErr;
          throw makeProviderError({
            status: 200,
            provider: providerId,
            requestStage: 'response_parse',
            errorType: 'response_parse_error',
            retryable: false,
            safeDetail: '',
            retryState: { attempts: res.attempts || 1 },
            cause: parseErr
          });
        }
        const usage = j.usage || null;
        lastUsage = usage;
        lastNormalizedUsage = normalizeUsage(usage, providerId);
        return {
          text: (j.choices?.[0]?.message?.content || '').trim(),
          usage,
          observedModel: (typeof j.model === 'string' && j.model.trim()) ? j.model.trim() : null,
          attempts: res.attempts || 1
        };
      } catch (e) {
        throw toUnifiedError(e, providerId);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
      }
    },

    /**
     * 流式：请求建立阶段（pre-yield）经 transport 可 retry；
     * 一旦 onDelta 交付过内容，后续失败只带 partial 上抛，绝不从头重启（P1 stream 边界）。
     * SSE 按 sse-parser 真 framing 解析，任意 chunk 边界安全。
     */
    async stream(messages, onDelta, callOpts = {}) {
      assertCapability(adapter, 'streaming');
      const callerSignal = callOpts.signal;
      const ctrl = new AbortController();
      const forwardAbort = () => ctrl.abort(callerSignal && callerSignal.reason);
      if (callerSignal) {
        if (callerSignal.aborted) forwardAbort();
        else callerSignal.addEventListener('abort', forwardAbort, { once: true });
      }
      const requestTimeoutMs = Number.isFinite(cfg.requestTimeoutMs) ? cfg.requestTimeoutMs : 60000;
      let requestTimer = null;
      if (requestTimeoutMs > 0) {
        requestTimer = setTimeout(() => {
          const err = new Error('request timeout');
          err.name = 'TimeoutError';
          ctrl.abort(err);
        }, requestTimeoutMs);
      }

      let full = '';
      let usage = null;
      let observedModel = null;
      let streamError = null;
      let yielded = false;

      try {
        const res = await requestChatCompletion({
          cfg,
          provider: providerId,
          body: {
            model: cfg.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            temperature: callOpts.temperature ?? 1.0,
            max_tokens: callOpts.maxTokens ?? 600
          },
          signal: ctrl.signal
        });

        const parser = createSSEParser({
          onEvent: (ev) => {
            if (streamError || ev.done) return;
            if (ev.malformed) {
              streamError = new Error('malformed SSE data');
              streamError.name = 'ProviderError';
              streamError.errorType = 'malformed_stream_data';
              streamError.requestStage = 'stream';
              streamError.retryable = false;
              return;
            }
            const j = ev.json || {};
            if (j.error) {
              const e = j.error;
              const why = redactSecrets(e.message || e.msg || JSON.stringify(e));
              streamError = new Error(why + (e.type || e.code ? '（' + (e.type || e.code) + '）' : ''));
              return;
            }
            if (typeof j.model === 'string' && j.model.trim()) observedModel = j.model.trim();
            if (j.usage) usage = j.usage;
            const d = j.choices?.[0]?.delta?.content;
            if (d) {
              full += d;
              yielded = true;
              if (onDelta) onDelta(d);
            }
          }
        });

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            if (ctrl.signal.aborted) {
              const reason = ctrl.signal.reason;
              const err = reason instanceof Error ? reason : new Error(reason || 'aborted');
              err.name = err.message === 'request timeout' ? 'TimeoutError' : 'AbortError';
              throw err;
            }
            const { done, value } = await reader.read();
            if (done) break;
            parser.feed(dec.decode(value, { stream: true }));
            if (streamError) {
              // 已报错就不再读（也避免挂到连接超时）；post-yield 绝不重启
              try { await reader.cancel(); } catch {}
              break;
            }
          }
        } finally {
          if (streamError) {
            try { await reader.cancel(); } catch {}
          }
        }
        parser.flush();

        if (streamError) {
          streamError.partial = full;
          streamError.outputYielded = yielded;
          throw streamError;
        }
        lastUsage = usage;
        lastNormalizedUsage = normalizeUsage(usage, providerId);
        return { text: full, usage, observedModel, attempts: res.attempts || 1 };
      } catch (e) {
        if (e && e.partial === undefined) e.partial = full;
        if (e && e.outputYielded === undefined) e.outputYielded = yielded;
        throw toUnifiedError(e, providerId);
      } finally {
        if (requestTimer) clearTimeout(requestTimer);
        if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
      }
    },

    normalizeError(err) {
      return toUnifiedError(err, providerId);
    },

    /** provider raw usage（P3 Usage Normalizer 负责统一字段；本层不伪造） */
    usage() {
      return lastUsage;
    },

    /** P5-A2: 以 providerId 为键的 usage 归一化（不套用 DeepSeek 推导语义） */
    normalizedUsage() {
      return lastNormalizedUsage;
    }
    // healthCheck 为可选契约项，本轮不实现
  };

  const contract = validateAdapterContract(adapter);
  if (!contract.ok) {
    throw new Error('OpenAI-compatible adapter contract incomplete: ' + contract.missing.join(','));
  }
  return adapter;
}

module.exports = { createOpenAICompatibleAdapter };
