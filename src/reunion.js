/**
 * src/reunion.js — 重逢心境（v1.8-a）：主观时间感知
 *
 * ## 这一块解决什么
 *   她要知道「你离开了多久」。这是**跨重启、跨休眠**的事实，
 *   不是会话内的计时（`tracker.lastInteractionAt` 是内存值，重启即丢）。
 *
 * ## 🔴 核心纠偏：重逢是**关系事件**，不是进程事件
 *   桌宠的核心形态是后台常驻（关对话窗是 hide 不销毁），
 *   **绝大多数时候进程根本不重启**（上班 8 小时、出门半天，电脑一直挂着）。
 *   所以触发点必须是「你下次开口说话时回头检查」，
 *   **绝不能是「应用启动时」** —— 那样这个功能几乎永远不会触发。
 *
 * ## 🔴 冷启动守卫
 *   `lastSeenAt` 缺失 = 首次见面。此时**绝不注入任何事实行**，
 *   只把它初始化成当前时间。否则新用户第一句会听到「你离开了 20 年」。
 *
 * ## 纯函数边界
 *   本模块只负责「算」与「格式化」，不碰任何持久化。
 *   读写在 `brain.js`（它持有 stats 与 DeferredWriter）。
 */

/** 重逢阈值：6 小时硬下限（一个工作时段 / 一夜睡眠的量级） */
const REUNION_MIN_MS = 6 * 60 * 60 * 1000;

/** 一天、一小时、一分钟的毫秒数（避免魔法数字散落） */
const HOUR_MS = 60 * 60 * 1000;

/**
 * 把「离开时长」格式化成给她的客观事实行。
 *
 * ## 三级刻度（为什么分级）
 *   - 6–24 小时：小时刻度最敏感（出门一天回来，"8.5 小时"是准确的事实感）
 *   - 1–7 天：天 + 小时（跨数日，复合刻度更自然）
 *   - ≥ 7 天：只用天（"168 小时"听起来像倒计时报警，不像人类说话）
 *
 * ## 🔴 铁律：只陈述时长，绝不推断作息
 *   ✅【你离开了 8 小时】
 *   ❌【你睡了 8 小时】 —— 程序不知道你是睡觉、通宵还是出差
 *   ❌【我等了你 8 小时】 —— 撞 persona.js:29「不虚构寂寞/苦苦等待」
 *
 * @param {number} awayMs 离开的毫秒数（调用方保证 >= REUNION_MIN_MS）
 * @returns {string} 形如 `【你离开了 8.5 小时】`
 */
function formatReunionLine(awayMs) {
  const ms = Number.isFinite(awayMs) && awayMs > 0 ? awayMs : 0;
  const hours = ms / HOUR_MS;

  // 6h ≤ t < 24h：小时刻度，保留一位小数（整数不带 .0）
  if (hours < 24) {
    const h = Math.round(hours * 10) / 10;
    return '【你离开了 ' + h + ' 小时】';
  }

  // 统一按"整小时"截断后再拆天/时，避免 23.99h 因四舍五入变成 24h 的错位
  const totalHours = Math.floor(hours);
  const days = Math.floor(totalHours / 24);
  const remH = totalHours % 24;

  // t ≥ 7 天：只带天数。超长离线还带小时显得机械又失真
  if (days >= 7) return '【你离开了 ' + days + ' 天】';

  // 1d ≤ t < 7d：天 + 小时；小时为 0 时只说天数
  return remH > 0
    ? '【你离开了 ' + days + ' 天 ' + remH + ' 小时】'
    : '【你离开了 ' + days + ' 天】';
}

/**
 * 判断是否够得上「重逢」。
 * @param {number|null} lastSeenAt 上次见面时间戳；null = 首次见面
 * @param {number} now
 * @returns {{isReunion:boolean, awayMs:number|null, coldStart:boolean}}
 */
function evaluateReunion(lastSeenAt, now = Date.now()) {
  // 🔴 冷启动守卫必须放在最前：缺失时不能拿 0 去算差值
  if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) {
    return { isReunion: false, awayMs: null, coldStart: true };
  }
  const awayMs = now - lastSeenAt;
  // 时钟回拨（awayMs < 0）也按"没见过很久"处理：不注入，只刷新
  if (!Number.isFinite(awayMs) || awayMs < REUNION_MIN_MS) {
    return { isReunion: false, awayMs: awayMs > 0 ? awayMs : null, coldStart: false };
  }
  return { isReunion: true, awayMs, coldStart: false };
}

module.exports = {
  REUNION_MIN_MS,
  HOUR_MS,
  formatReunionLine,
  evaluateReunion
};
