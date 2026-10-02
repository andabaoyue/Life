/**
 * 渲染层文案与时间基座（v1.0 · UX-05 前置约束落地）
 *
 * 两个单一改点：
 *   UI_LOCALE   —— 界面语言（双语化时加 'en' 表即可，t() 不改调用方）
 *   UI_TIMEZONE —— 时区；现为 null = 跟随机器本地，UX-05「时区创世锁定」届时只写这一处
 *
 * 纯前端模块：不经 require('electron')、不进 src/、不碰主体系统（边界铁律）。
 * 浏览器经 <script> 引入获得全局 t / formatDisplayTime；Node 经 require 可测（下方守卫）。
 */
const UI_LOCALE = 'zh-CN';
const UI_TIMEZONE = null;   // null = 机器本地；UX-05 锁定时写入 IANA 时区名（如 'Asia/Shanghai'）

const I18N = {
  'zh-CN': {
    'chat.title': '对话',
    'chat.placeholder': '说点什么…',
    'chat.empty': '（还没有对话）',
    'chat.windowBreak': '—— 以下为当前窗口 ——',
    'chat.sendFailed': '（这条没送出去，稍后再试）',
    'card.dragHint': '拖到舒服的位置',
    'archive.title': '生命档案',
    'archive.windows': '窗口小结',
    'archive.ledger': '成长记录'
    // 第一战役用到的键在此生长；双语化时补 'en' 表（键集必须与 zh-CN 完全一致，测试钉住）
  }
};

/** 文案取值：未命中时回退 fallback，再退原键 —— 界面永不出现 undefined */
function t(key, fallback) {
  const v = I18N[UI_LOCALE] && I18N[UI_LOCALE][key];
  return v !== undefined ? v : (fallback !== undefined ? fallback : key);
}

/** 时间显示单点：一切界面时间只准走这里（UX-05 时区锚定届时只改 UI_TIMEZONE） */
function formatDisplayTime(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Intl.DateTimeFormat(UI_LOCALE, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: UI_TIMEZONE || undefined
    }).format(new Date(ts));
  } catch (e) {
    return '';
  }
}

// 双环境守卫：Node 测试可 require；浏览器侧 module 不存在，全局照常生效（同 behavior-scheduler 先例）
if (typeof module === 'object' && module.exports) {
  module.exports = { I18N, t, formatDisplayTime, UI_LOCALE, UI_TIMEZONE };
}
