/**
 * src/redact.js — 统一敏感信息清理层（v0.9.8 P1-1）
 *
 * 只覆盖 Life 当前已知安全边界（API key / Authorization / Bearer / cookie /
 * credential-like key=value 形态 / 平台 token 形态），不做"万能 secret detector"。
 *
 * v0.9.8 A-01 局限声明（严正）：裸随机串 / 无形态自定义 secret **无法可靠识别** ——
 * 例如纯词 'SECRET_MID' 混在普通文本中，模式匹配无法与正常内容区分。
 * 高熵启发式有误伤面（会吞掉哈希/ID 等合法内容），明确不做。
 * 正则替换在代码赋值（如 `const apiKey = getKey();`）或特殊 JSON 语法（如 `{"token": null}`）下存在格式退化边界，属已知代价。
 * 因此本层是「已知形态的确定性清理」，不是「secret 不可能泄漏」的密码学证明；
 * 新形态 secret 应挂到敏感键名下或使用标准 token 前缀，才会被本层覆盖。
 * 供 deepseek.js（错误归一化）与 brain.js（日志出口）复用。
 *
 * 约束：
 * - 字符串输入返回安全字符串；object 输入保持普通字段结构（仅清理字符串值与敏感键名）；
 * - 任何输入下绝不抛异常（redaction 自身失败时退化为 '[REDACTED]'）。
 */

const SECRET_STRING_PATTERNS = [
  // Bearer / Basic token（Authorization header 值，使用 scheme 动态回调，保留原认证类型事实）
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi,
  // 常见 API key 形态（sk-... / 深度长串）
  /\bsk-[A-Za-z0-9_-]{4,}/g,
  // key=value / key: value 形态（含可选引号包裹键名，支持 JSON 格式；支持 pwd 键名）
  /(["']?)\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|pwd|authorization|cookie|credential)\b\1(\s*[:=]\s*)(["']?)[^\s"',;)&]+\4/gi,
  // v0.9.8 A-01: 典型平台 token 形态
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,   // GitHub PAT (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bAKIA[A-Z0-9]{16}\b/g,           // AWS Access Key ID
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g  // Slack token
];

const SECRET_HEADER_KEYS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token'
]);

// v0.9.8 A-01: 对象敏感键名识别 —— 后缀模糊匹配（大小写不敏感），
// 覆盖复合键名（dbPassword / sessionToken / clientSecret / privateKey / my_api_key / user_pwd 等）。
// 显式表保留 header 类与 passwd/pwd 等无共同后缀的形态。
const SECRET_KEY_SUFFIXES = ['secret', 'password', 'token', 'key', 'credential', 'passwd', 'pwd'];

function isSecretKey(key) {
  const k = String(key).toLowerCase();
  if (SECRET_HEADER_KEYS.has(k)) return true;
  return SECRET_KEY_SUFFIXES.some((s) => k.endsWith(s));
}

function redactString(text) {
  let out = String(text);
  try {
    out = out.replace(SECRET_STRING_PATTERNS[0], (_m, scheme) => `${scheme} [REDACTED]`);
    out = out.replace(SECRET_STRING_PATTERNS[1], '[REDACTED]');
    out = out.replace(SECRET_STRING_PATTERNS[2], (_m, q1, key, sep, q2) => `${q1}${key}${q1}${sep}${q2}[REDACTED]${q2}`);
    // A-01: 其余形态（平台 token 等）统一替换
    for (let i = 3; i < SECRET_STRING_PATTERNS.length; i++) {
      out = out.replace(SECRET_STRING_PATTERNS[i], '[REDACTED]');
    }
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
        if (isSecretKey(k)) {
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
