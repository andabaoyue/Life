/**
 * src/sse-parser.js — 原生 fetch SSE framing 解析器（v0.9.8 P5-B3）
 *
 * 不假设「一个 fetch chunk = 一个 SSE event」：
 *   incoming chunk → 追加 buffer → 按 SSE event boundary 切分 → 解析完整 data 行 → JSON parse。
 *
 * 边界保证：只有凑齐完整 event（空行分隔）后才 parse 其 data —— 绝不在半截 JSON 上 parse。
 * 支持：JSON/换行/event 被 chunk 截断、空 event、comment/keep-alive（':' 行）、[DONE]、EOF flush。
 * 畸形 JSON（完整 event 内仍非法）以 { malformed: true } 上报，调用方 fail-safe 处理，不抛。
 */

function findEventBoundary(buf) {
  let best = null;
  for (const sep of ['\r\n\r\n', '\n\n', '\r\r']) {
    const i = buf.indexOf(sep);
    if (i >= 0 && (best === null || i < best.index || (i === best.index && sep.length > best.length))) {
      best = { index: i, length: sep.length };
    }
  }
  return best;
}

function parseEvent(rawEvent) {
  const lines = rawEvent.split(/\r\n|\n|\r/);
  const dataLines = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment / keep-alive
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    // event/id/retry 等其他字段：OpenAI 兼容流只消费 data，忽略
  }
  if (dataLines.length === 0) return null; // 空 event
  const data = dataLines.join('\n');
  if (data.trim() === '[DONE]') return { done: true };
  try {
    return { json: JSON.parse(data) };
  } catch {
    return { malformed: true, raw: data };
  }
}

/**
 * @param {{onEvent: (ev: {json?: object, done?: boolean, malformed?: boolean, raw?: string}) => void}} opts
 * @returns {{feed(chunk: string|Uint8Array): void, flush(): void}}
 */
function createSSEParser({ onEvent } = {}) {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      for (;;) {
        const b = findEventBoundary(buffer);
        if (!b) break;
        const rawEvent = buffer.slice(0, b.index);
        buffer = buffer.slice(b.index + b.length);
        const ev = parseEvent(rawEvent);
        if (ev && onEvent) onEvent(ev);
      }
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest.trim()) {
        const ev = parseEvent(rest);
        if (ev && onEvent) onEvent(ev);
      }
    }
  };
}

module.exports = { createSSEParser };
