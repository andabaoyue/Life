/**
 * DeepSeek 客户端（OpenAI 兼容接口）
 *
 * 用 Node 内置 fetch，不引第三方 SDK —— 少一个依赖，打包体积小。
 *
 * 缓存命中的判定来自返回的 usage：
 *   prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * 我们逐次累加，用来算真实命中率。
 */

// v0.9.8 C-01: 铸造权限经专用信任根模块获取，并在铸造器上绑定受信 adapter='deepseek'。
// 该能力不属于公共 metadata API；complete()/stream() 的真实 response 均经此铸造器注册。
const { createProviderRuntimeMintAuthority } = require('./provider-runtime-trust');

function isPeakHour(now = new Date()) {
  // DeepSeek 峰谷：工作日 09:00-12:00、14:00-18:00 为高峰；周六周日全天低谷；
  // 中国法定节假日全天、以及因调休补班的周末也按低谷（2026-09-19 官方补充说明）。
  const t = toBeijing(now);
  const md = keyOf(t);
  if (HOLIDAYS.has(md)) return false;        // 法定节假日全天低谷
  if (MAKEUP_WORKDAYS.has(md)) return false; // 调休补班的周末仍按周末（低谷）
  const day = t.getUTCDay();                 // 注意：一律用 UTC* 读那个"平移后的瞬间"
  if (day === 0 || day === 6) return false;
  const h = t.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/* 节假日 / 调休表：依据《国务院办公厅关于 2026 年部分节假日安排的通知》
   （国办发明电〔2025〕7号），每年换一次，手动维护。
   刻意不放进 config —— config 是"用户能改的价格"，这是"外部事实"，
   混在一起以后没人知道该去哪补 2027 年的表。
   表过期时的偏差方向是安全的：节假日会被当成普通工作日（多估成本），
   不会把高峰算成低谷（少估），所以宁可旧也不要没有。 */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',                            // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',              // 春节 9 天
  '2026-04-04', '2026-04-05', '2026-04-06',                            // 清明（含周六日，无需调休）
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',// 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21',                            // 端午（含周六日，无需调休）
  '2026-09-25', '2026-09-26', '2026-09-27',                            // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07'                             // 国庆 7 天
]);
/* 调休补班日 —— 通知里全部落在周六/周日（1/4、2/14、2/28、5/9、9/20、10/10）。
   周末本来就已经全天低谷，所以这张表**目前是冗余的**，留着有两个用处：
     1. 把"调休补班仍按周末"这条规则写进代码，而不是靠人记得 DeepSeek 的补充说明；
     2. 万一哪天补班排到了工作日（现行规则下不会，但表是给人读的），逻辑仍然对。
   注意别把不该来的日期写进来：清明、端午不需要调休，把 4/7、6/18 这种普通
   工作日误标成补班日，会把高峰算成低谷 —— 那是往"少估花费"的方向错。 */
const MAKEUP_WORKDAYS = new Set([
  '2026-01-04', '2026-02-14', '2026-02-28',
  '2026-05-09', '2026-09-20', '2026-10-10'
]);

/**
 * 换算成北京时间的"瞬间"，一律用 getUTC* 读它。
 *
 * 北京固定 UTC+8、无夏令时，所以加 8 小时后读 UTC 字段就是北京的年月日时分，
 * 与宿主机器在哪个时区、有没有 DST 完全无关。
 *
 * 旧写法 `new Date(t + (getTimezoneOffset()+480)*60000)` 再读 getHours() 有个陷阱：
 * getTimezoneOffset() 取的是**那个瞬间**的偏移，而偏移本身会随夏令时变。
 * 实测扫描 2026 全年 8760 个小时点：
 *   - 宿主在 Asia/Shanghai（国内机器几乎都是）：偏移恒为 -480，两者抵消，
 *     旧写法**一个点都没错** —— 所以这不是"国内用户一直在算错价"。
 *   - 宿主在有夏令时的时区：只有夏令时起止那一两天错一小时，全年 25 个点。
 *     而这 25 个点全落在北京 2:00–8:00 这类本来就低谷的时段，
 *     **没有一个是把高峰算成低谷或反之**，所以对 2026 的计费判断实际影响为 0。
 * 改成现在这样不是为了修一个正在发生的错，而是让"对不对"不再依赖
 * 表里恰好没有落在边界上的小时 —— 换年份、改时段阈值都不用重新推一遍。
 */
function toBeijing(now) {
  return new Date(now.getTime() + 8 * 3600000);
}
function keyOf(t) {
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0')
    + '-' + String(t.getUTCDate()).padStart(2, '0');
}

function costOf(usage, price) {
  // v0.9.8 P3-3/E-02: 真正计算逻辑在 DeepSeek Cost Strategy
  //（normalizeUsage(FACT) -> cache 解释层 -> 定价）。
  // E-02 真值边界：未知成本返回 null —— 绝不把未知伪装为 0 消费，调用方显式处理未知状态。
  const { normalizeUsage } = require('./usage-normalizer');
  const { getCostStrategy } = require('./cost-strategy');
  const r = getCostStrategy('deepseek').calculate(normalizeUsage(usage), price || {});
  return r.cost;
}

const { redactSecrets } = require('./redact');
// v0.9.8 P5-B1: 通用 HTTP/retry/budget/错误归一化已提取至 openai-transport.js
//（DeepSeek 与 Generic OpenAI-compatible adapter 共用；DeepSeek 行为保持兼容）
const {
  makeProviderError,
  requestChatCompletion,
  readBodyCapped,
  makeResponseTooLargeError,
  MAX_RESPONSE_BYTES,
  MAX_STREAM_TEXT_CHARS,
  MAX_SSE_BUFFER_BYTES
} = require('./openai-transport'); // SEC-03: 与 Generic 共用同一套响应大小硬上限

class DeepSeek {
  constructor(cfg) {
    // SEC-06: 铸造器绑定真实 runtime identity（this，实现 Provider Adapter 契约的实例），不再凭 string 领取
    this._markProviderRuntimeResponse = createProviderRuntimeMintAuthority('deepseek', this);
    this.cfg = cfg;
  }

  /** P5-B1: 传输层委托 —— policy 门禁 / budget guard / retry / 错误归一化均在 openai-transport。
   *  品牌语义（deepseek-api-key credential 类型）留在本 DeepSeek 模块内，不进共享层。 */
  async raw(body, signal) {
    const { providerFor } = require('./provider-policy');
    const provider = this.cfg.provider || providerFor(this.cfg.baseURL);
    return requestChatCompletion({
      cfg: this.cfg,
      body,
      signal,
      provider,
      credentialType: this.cfg.credentialType || (provider === 'deepseek' ? 'deepseek-api-key' : 'apiKey')
    });
  }

  /** 非流式，用于生成摘要 */
  async complete(messages, opts = {}) {
    const callerSignal = opts.signal;
    const ctrl = new AbortController();
    const forwardAbort = () => ctrl.abort(callerSignal && callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) forwardAbort();
      else callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }

    // P1-2: requestTimeoutMs 覆盖整个请求与响应解析生命周期
    const requestTimeoutMs = Number.isFinite(this.cfg.requestTimeoutMs)
      ? this.cfg.requestTimeoutMs : 60000;
    let requestTimer = null;
    if (requestTimeoutMs > 0) {
      requestTimer = setTimeout(() => {
        const err = new Error('request timeout');
        err.name = 'TimeoutError';
        ctrl.abort(err);
      }, requestTimeoutMs);
    }

    try {
      const res = await this.raw({
        model: this.cfg.model,
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 400
      }, ctrl.signal);
      let j;
      try {
        // SEC-03: 流式有界读取 —— JSON.parse 前即限制原始 body；超限 fail-closed 不触发 retry
        j = await readBodyCapped(res, MAX_RESPONSE_BYTES, { stage: 'response' })
          .then((text) => JSON.parse(text));
      } catch (parseErr) {
        if (parseErr && parseErr.name === 'ResponseTooLargeError') {
          ctrl.abort(parseErr); // 超限立即 abort 当前连接
          throw parseErr;
        }
        // P1-2: JSON 解析错误信息可能内嵌 raw body 片段 —— 归一化为 response_parse 错误，禁止片段传播
        throw makeProviderError({
          status: 200,
          provider: this.cfg.provider || 'deepseek',
          requestStage: 'response_parse',
          errorType: 'response_parse_error',
          retryable: false,
          safeDetail: '',
          retryState: { attempts: res.attempts || 1 },
          cause: parseErr
        });
      }
      return this._markProviderRuntimeResponse({
        text: (j.choices?.[0]?.message?.content || '').trim(),
        usage: j.usage || {},
        observedModel: (typeof j.model === 'string' && j.model.trim()) ? j.model.trim() : null,
        attempts: res.attempts || 1
      }, { adapter: 'deepseek' });
    } catch (err) {
      if (err.message === 'request timeout') {
        err.name = 'TimeoutError';
      }
      throw err;
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * 流式对话。onDelta 每收到一段文字就回调，用于气泡逐字显示。
   * 返回完整文本 + usage。
   */
  async stream(messages, onDelta, opts = {}) {
    const callerSignal = opts.signal;
    const ctrl = new AbortController();
    const forwardAbort = () => ctrl.abort(callerSignal && callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) forwardAbort();
      else callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }

    // P1-2: requestTimeoutMs 覆盖整个请求与流式生命周期
    const requestTimeoutMs = Number.isFinite(this.cfg.requestTimeoutMs)
      ? this.cfg.requestTimeoutMs : 60000;
    let requestTimer = null;
    if (requestTimeoutMs > 0) {
      requestTimer = setTimeout(() => {
        const err = new Error('request timeout');
        err.name = 'TimeoutError';
        ctrl.abort(err);
      }, requestTimeoutMs);
    }

    let reader = null;
    let streamError = null;
    let full = '';
    let usage = {};
    let observedModel = null;

    try {
      const res = await this.raw({
        model: this.cfg.model,
        messages,
        stream: true,
        // OpenAI 协议流式默认不返回 usage，必须显式开启；
        // 漏了这行，真实 API 下 usage 恒为空，命中率/计费全是 0
        stream_options: { include_usage: true },
        // v3.1 修复「回话腰斩」：deepseek-flash 服务端默认开启思维链，
        // 推理内容以 reasoning_content 流式返回而我们只读 delta.content 会把它全丢掉。
        // 结果推理吃掉的 token 照样计入 completion_tokens，一旦顶到 max_tokens，
        // 留给台词的正文配额就被挤光 —— 实测 out=600（恰好顶满默认上限）却只吐出 17 个字。
        // 显式关闭思维链，token 全部用于台词（关闭后 temperature 的灵动效果也随之恢复）。
        thinking: { type: 'disabled' },
        temperature: opts.temperature ?? 1.0,
        // 600 对日常对话偏紧：一句完整回复常在 300~600 token 之间，
        // 偶遇长回复就会被无声切掉半截。放宽到 1200 留足余量。
        max_tokens: opts.maxTokens ?? 1200
      }, ctrl.signal);

      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      // 一行 SSE -> 文本增量/usage。抽出来是因为循环之外还要补处理最后一段。
      const consume = (line) => {
        const s = line.trim();
        if (!s.startsWith('data:')) return;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') return;
        let j;
        try { j = JSON.parse(payload); } catch { return; }
        if (typeof j.model === 'string' && j.model.trim()) {
          observedModel = j.model.trim();
        }
        // OpenAI 兼容服务在流内报错时 HTTP 仍是 200，错误只出现在某一条 data 里
        // （余额耗尽、限速、内容审核拦截）。不接住的话它会连同半截回复一起被
        // 当成"成功"，最后只报一句"返回空内容"，真实原因永久丢失。
        if (j.error) {
          const e = j.error;
          // P1-2: provider 错误文本同样过 redaction，防 secret 随错误消息外泄
          const why = redactSecrets(e.message || e.msg || JSON.stringify(e));
          streamError = new Error(why + (e.type || e.code ? '（' + (e.type || e.code) + '）' : ''));
          return;
        }
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          // SEC-03: 累计文本上限 —— 追加前检查，不得先无界 full += d；走 streamError 出口保留 partial 语义
          if (full.length + d.length > MAX_STREAM_TEXT_CHARS) {
            const tooLarge = makeResponseTooLargeError(MAX_STREAM_TEXT_CHARS, 'stream');
            ctrl.abort(tooLarge);
            streamError = tooLarge;
            return;
          }
          full += d; onDelta && onDelta(d);
        }
      };

      // P1-2: streamIdleTimeoutMs 仅约束连续 chunk 之间的等待空闲时间
      const streamIdleTimeoutMs = Number.isFinite(this.cfg.streamIdleTimeoutMs)
        ? this.cfg.streamIdleTimeoutMs : 20000;

      while (true) {
        if (ctrl.signal.aborted) {
          const abortReason = ctrl.signal.reason;
          const err = abortReason instanceof Error ? abortReason : new Error(abortReason || 'aborted');
          err.name = err.message === 'request timeout' ? 'TimeoutError' : 'AbortError';
          throw err;
        }

        let idleTimer = null;
        let onAbortHandler = null;

        try {
          const readPromise = reader.read();

          const idlePromise = new Promise((_, reject) => {
            idleTimer = setTimeout(() => {
              const err = new Error('stream idle timeout');
              err.name = 'TimeoutError';
              reject(err);
            }, streamIdleTimeoutMs);
          });

          const abortPromise = new Promise((_, reject) => {
            onAbortHandler = () => {
              const abortReason = ctrl.signal.reason;
              const err = abortReason instanceof Error ? abortReason : new Error(abortReason || 'aborted');
              err.name = err.message === 'request timeout' ? 'TimeoutError' : 'AbortError';
              reject(err);
            };
            ctrl.signal.addEventListener('abort', onAbortHandler, { once: true });
          });

          const { done, value } = await Promise.race([readPromise, idlePromise, abortPromise]);

          if (idleTimer) clearTimeout(idleTimer);
          if (onAbortHandler) ctrl.signal.removeEventListener('abort', onAbortHandler);

          if (done) break;
          buf += dec.decode(value, { stream: true });
          // SEC-03: 未解析 SSE buffer 按 UTF-8 byte 硬上限（不换行的恶意流不得无限累积）
          if (Buffer.byteLength(buf, 'utf8') > MAX_SSE_BUFFER_BYTES) {
            const tooLarge = makeResponseTooLargeError(MAX_SSE_BUFFER_BYTES, 'stream');
            ctrl.abort(tooLarge);
            throw tooLarge;
          }

          // SSE 按行解析，行尾可能是 \n 或 \r\n；没有换行的尾巴留在 buf 里等下一块
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) consume(line);
          if (streamError) break;      // 已经报错就不用再读下去了（也避免挂到连接超时）
        } catch (readErr) {
          if (idleTimer) clearTimeout(idleTimer);
          if (onAbortHandler) ctrl.signal.removeEventListener('abort', onAbortHandler);
          try { await reader.cancel(); } catch { /* 释放挂起的响应流 */ }
          if (readErr.message === 'stream idle timeout' || readErr.message === 'request timeout') {
            readErr.name = 'TimeoutError';
          }
          readErr.partial = full;
          throw readErr;
        }
      }

      if (streamError) {
        // break 只是不再消费，连接本身还开着：实测（服务端发完 error 帧后故意不关，
        // 客户端进程单独数 net.Socket 句柄）每报错一次就挂住一条，连发 6 次 → Δ6，
        // 不随 GC 归零；补 cancel() 后 Δ-1（连接回 keep-alive 池，不累积）。
        // 桌宠是常驻小进程，报错往往是连续的（余额耗尽时每轮都报），
        // 攒下来就是越用越多的挂起连接。cancel() 显式把流读完并释放。
        try { await reader.cancel(); } catch { /* 已经关了就不用管 */ }
      }

      // 收尾必须 flush：多字节字符可能卡在 decoder 里，
      // 最后一段也没有换行触发循环内处理。真实 DeepSeek 的 usage 包就在
      // [DONE] 之前 —— 服务端少发一个换行，命中率/计费就会静默归零。
      if (!streamError) {
        buf += dec.decode();         // 无参调用吐出 decoder 里剩余的字节
        // SEC-03: flush 路径同样受 byte 上限约束
        if (Buffer.byteLength(buf, 'utf8') > MAX_SSE_BUFFER_BYTES) {
          const tooLarge = makeResponseTooLargeError(MAX_SSE_BUFFER_BYTES, 'stream');
          ctrl.abort(tooLarge);
          throw tooLarge;
        }
        if (buf) consume(buf);
      }
      if (streamError) {
        // 把已经收到的半截回复一起带出去：调用方可以决定是丢弃还是保留，
        // 也让用户看得见"说到一半断的"，而不是以为什么都没发生。
        streamError.partial = full;
        throw streamError;
      }
      return this._markProviderRuntimeResponse({ text: full, usage, observedModel, attempts: res.attempts || 1 }, { adapter: 'deepseek' });
    } catch (outerErr) {
      if (reader) {
        try { await reader.cancel(); } catch {}
      }
      if (outerErr.message === 'request timeout') {
        outerErr.name = 'TimeoutError';
      }
      if (outerErr.partial === undefined) {
        outerErr.partial = full;
      }
      throw outerErr;
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
    }
  }
}

module.exports = { DeepSeek, isPeakHour, costOf };
