/**
 * src/vision.js — 屏幕视觉探针的纯逻辑（v1.8-b）
 *
 * ## 这一块解决什么
 *   让她能"看"用户指定的屏幕区域。用户框选一块 → 截图 → 送多模态模型 → 她真的看到了。
 *
 * ## 隐私铁律（先于一切实现，见 docs/v1.8-b-IMPLEMENTATION-ORDER.md §1）
 *   1. 只做**用户框选**，绝不做全屏 / 活动窗口；
 *   2. 只在**用户显式唤起**时截，绝不后台定时截屏；
 *   3. 图**不落盘、不进历史、不进经历、不进导出**；
 *   4. 默认关闭；
 *   5. 审计**只记尺寸/耗时/成败**，不记像素与 OCR 文本；
 *   6. 无 vision 能力时**显式失败**，绝不假装"她看过了"。
 *
 * ## 本模块的边界
 *   只做纯计算（能力判定、矩形校验、消息附加、事实行生成）。
 *   截图与 IPC 在 main.js（它才拿得到真实窗口）。
 */

/** 框选矩形的最小边长（低于此判为误触，不截图） */
const MIN_RECT_SIDE = 16;

/** 单次截图的短边上限（控 token 成本）。
 *  ⚠️ 2026-10-27 订正：此处原写「实测一次看图约 550 token」，那是**按 prompt_tokens
 *  总量与该轮纯文本基线推算**出来的，不是 provider 报的数 —— provider 的 usage 里
 *  没有 image token 字段（`src/usage-normalizer.js` 只映射 prompt/completion/cache_hit/cache_miss，
 *  全仓 grep `image_tokens` / `imageTokens` 零命中写入点）。写具体数字就是伪精确，
 *  详见 `docs/PENDING-TASKS.md` §6.5。此处只保留"贵一个量级"的量级判断。 */
const MAX_CAPTURE_SIDE = 1024;

/**
 * 该模型是否支持图片输入。
 *
 * ## 依据（2026-10-20 实测 + 官方文档）
 *   - `deepseek-flash`：支持（JPEG/PNG/GIF/WebP，格式按文件内容判定）
 *   - `deepseek-v4-pro`：**不支持**，发图返回 400
 *
 * ## 🔴 宁可保守
 *   无法识别的模型名一律返回 false。
 *   **宁可少看图，也绝不假装看过** —— 后者会让她说出图里没有的东西。
 *
 * @param {string} modelId
 * @returns {boolean}
 */
function modelSupportsVision(modelId) {
  const m = String(modelId || '').trim().toLowerCase();
  if (!m) return false;

  // 明确不支持的：v4-pro 系、v3 系、r1 系（纯文本）
  if (m.includes('v4-pro') || m.includes('v3') || /\br1\b/.test(m)) return false;

  // 明确支持的：flash 系（官方文档确认 deepseek-flash 有 vision）
  if (m.includes('flash')) return true;

  // 其他一律保守拒绝（不猜）
  return false;
}

/**
 * 校验并归一化框选矩形。
 *
 * 只接受 { x, y, width, height } 四个整数，其余一律拒。
 * **不接受路径、URL、任意对象** —— 那是 SSRF 与任意读文件的面。
 *
 * @param {object} raw
 * @param {{maxW?:number, maxH?:number}} [bounds]
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function normalizeRect(raw, bounds = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const nums = ['x', 'y', 'width', 'height'].map((k) => Number(raw[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;

  let [x, y, width, height] = nums.map((n) => Math.round(n));

  // 负宽高视为方向拖拽，归一成正的
  if (width < 0) { x += width; width = -width; }
  if (height < 0) { y += height; height = -height; }

  if (width < MIN_RECT_SIDE || height < MIN_RECT_SIDE) return null;

  // 越界裁剪（不报错，裁到可用范围内 —— 用户拖到屏幕外是常见操作）
  const maxW = Number.isFinite(bounds.maxW) ? bounds.maxW : Infinity;
  const maxH = Number.isFinite(bounds.maxH) ? bounds.maxH : Infinity;
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  if (x + width > maxW) width = maxW - x;
  if (y + height > maxH) height = maxH - y;

  if (width < MIN_RECT_SIDE || height < MIN_RECT_SIDE) return null;

  return { x, y, width, height };
}

/**
 * 计算缩放到「短边不超过 maxSide」后的尺寸（保持比例）。
 *
 * @param {number} w
 * @param {number} h
 * @param {number} [maxSide]
 * @returns {{width:number, height:number, scaled:boolean}}
 */
function fitCaptureSize(w, h, maxSide = MAX_CAPTURE_SIDE) {
  const width = Math.max(1, Math.round(Number(w) || 1));
  const height = Math.max(1, Math.round(Number(h) || 1));
  const short = Math.min(width, height);
  if (short <= maxSide) return { width, height, scaled: false };

  const ratio = maxSide / short;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true
  };
}

/**
 * 把图片附加到本轮最后一条 user 消息（**不可变**，不改原数组）。
 *
 * ## 为什么改 content 数组而不是新增一条消息
 *   OpenAI 兼容协议里，图片必须与文本同属一条 user 消息的 content 数组。
 *   新增一条 user 会破坏「history 只追加成对消息」的结构。
 *
 * ## 🔴 只影响本次请求
 *   返回的是新数组，`memory.history` 里的那条仍然是纯字符串。
 *   图片**绝不进历史**（铁律 3）。
 *
 * @param {Array} messages memory.build() 的产出
 * @param {string} dataUrl 形如 `data:image/png;base64,xxx`
 * @returns {Array} 新数组
 */
function attachImageToLastUser(messages, dataUrl) {
  if (!Array.isArray(messages) || !dataUrl) return messages;
  const out = messages.slice();

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m || m.role !== 'user') continue;

    // 已经是数组形态（重复附加）→ 不再叠第二张
    if (Array.isArray(m.content)) return out;

    const text = String(m.content || '');
    out[i] = {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    };
    return out;
  }
  // 没有 user 消息就原样返回（宁可不送图，也不凭空造消息）
  return messages;
}

/**
 * 生成挂到当轮尾部的客观事实行。
 *
 * 🔴 只陈述"看到了一块多大区域"，**绝不描述内容** ——
 *   描述内容是模型的事，程序代述就是编造。
 *
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function formatVisionNote(w, h) {
  const width = Math.max(0, Math.round(Number(w) || 0));
  const height = Math.max(0, Math.round(Number(h) || 0));
  if (!width || !height) return '【你看到了一块屏幕区域】';
  return '【你看到了一块 ' + width + '×' + height + ' 的屏幕区域】';
}

module.exports = {
  MIN_RECT_SIDE,
  MAX_CAPTURE_SIDE,
  modelSupportsVision,
  normalizeRect,
  fitCaptureSize,
  attachImageToLastUser,
  formatVisionNote
};
