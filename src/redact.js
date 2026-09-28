/**
 * src/redact.js — 统一敏感信息清理层（v0.9.8 P1-1）
 *
 * 只覆盖 Life 当前已知安全边界（API key / Authorization / Bearer / cookie /
 * credential-like key=value 形态），不做"万能 secret detector"。
 * 供 deepseek.js（错误归一化）与 brain.js（日志出口）复用。
 *
 * 约束：
 * - 字符串输入返回安全字符串；object 输入保持普通字段结构（仅清理字符串值与敏感键名）；
 * - 任何输入下绝不抛异常（redaction 自身失败时退化为 '[REDACTED]'）。
 */

const SECRET_STRING_PATTERNS = [
  // Bearer token（Authorization header 值）
  /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi,
  // 常见 API key 形态（sk-... / 深度长串）
  /\bsk-[A-Za-z0-9_-]{4,}/g,
  // key=value / key: value 形态（api_key / apiKey / token / secret / password / passwd / authorization / cookie）
  /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|cookie|credential)\b(\s*[:=]\s*)(["']?)[^\s"',;)&]+\3/gi
];

const SECRET_HEADER_KEYS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token'
]);

function redactString(text) {
  let out = String(text);
  try {
    out = out.replace(SECRET_STRING_PATTERNS[0], 'Bearer [REDACTED]');
    out = out.replace(SECRET_STRING_PATTERNS[1], '[REDACTED]');
    out = out.replace(SECRET_STRING_PATTERNS[2], (_m, key, sep, quote) => `${key}${sep}${quote}[REDACTED]${quote}`);
  } catch {
    return '[REDACTED]';
  }
  return out;
}

/**
 * 统一入口：字符串 -> 安全字符串；object/array -> 保持结构的清理副本；其余原样返回。
 */
function redactSecrets(value) {
  try {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map((v) => redactSecrets(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (SECRET_HEADER_KEYS.has(k.toLowerCase())) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = redactSecrets(v);
        }
      }
      return out;
    }
    return value;
  } catch {
    return '[REDACTED]';
  }
}

module.exports = { redactSecrets };
