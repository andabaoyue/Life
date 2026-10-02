/**
 * 渲染层文案与时间基座（v1.0 · UX-05 前置约束落地）
 *
 * 两个单一改点（UX-05 / 笔 6 已收尾）：
 *   UI_LOCALE —— 界面语言（setLocale 切换；'en' 键集与 zh-CN 100% 对称，测试机械死守）
 *   时区 —— 创世锁定（getTimezone）：她已活过创世，本地时区就是她的物理坐标系；
 *           首次锚定写入 localStorage('genesisTimezone')，此后只读，机器时区再变也不改。
 *
 * 纯前端模块：不经 require('electron')、不进 src/、不碰主体系统（边界铁律）。
 * 浏览器经 <script> 引入获得全局 t / formatDisplayTime；Node 经 require 可测（下方守卫）。
 */
let UI_LOCALE = 'zh-CN';

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
    'archive.ledger': '成长记录',
    'panel.i18nTitle': '国际化与物理时空',
    'panel.language': '界面语言',
    'panel.timezone': '创世时区',
    'panel.tzLocked': '创世已锚定，不可修改'
  },
  // UX-05（笔 6）：en 表键集必须与 zh-CN 100% 一致（测试机械死守）
  'en': {
    'chat.title': 'Chat',
    'chat.placeholder': 'Say something…',
    'chat.empty': '(no conversation yet)',
    'chat.windowBreak': '— current window below —',
    'chat.sendFailed': "(this one didn't go through, try again)",
    'card.dragHint': 'drag me somewhere comfy',
    'archive.title': 'Life Archive',
    'archive.windows': 'Window Summaries',
    'archive.ledger': 'Growth Ledger',
    'panel.i18nTitle': 'Language & Space-Time',
    'panel.language': 'Language',
    'panel.timezone': 'Genesis Timezone',
    'panel.tzLocked': 'Anchored at genesis, not editable'
  }
};

/** 文案取值：未命中时回退 fallback，再退原键 —— 界面永不出现 undefined */
function t(key, fallback) {
  const v = I18N[UI_LOCALE] && I18N[UI_LOCALE][key];
  return v !== undefined ? v : (fallback !== undefined ? fallback : key);
}

/* ---------- 时区创世锁定（UX-05 / 笔 6） ----------
   她已活过创世（2026-10-01 16:48:39，UTC+8）——本地时区就是她的物理坐标系。
   首次锚定写入 localStorage('genesisTimezone')，此后一律只读：机器时区再变也不改。
   非法/未识别时区安全回退机器本地；无 localStorage（Node）时仅按机器时区解析。 */
const TZ_LOCK_KEY = 'genesisTimezone';
function _tzStorage() {
  try { return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null; } catch (e) { return null; }
}
function _machineTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
}
function _tzValid(z) {
  if (!z || typeof z !== 'string') return false;
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch (e) { return false; }
}
/** 创世时区（只读）：首次锚定后永不更改 */
function getTimezone() {
  const st = _tzStorage();
  let z = null;
  if (st) { try { z = st.getItem(TZ_LOCK_KEY); } catch (e) { z = null; } }
  if (_tzValid(z)) return z;                       // 已锚定：只认它
  const mz = _machineTimezone();
  const locked = _tzValid(mz) ? mz : null;         // 机器时区非法 → null = 系统本地兜底
  if (st && locked) { try { st.setItem(TZ_LOCK_KEY, locked); } catch (e) {} }
  return locked;
}
function _tzOffsetLabel(z) {
  try {
    const s = new Date().toLocaleString('en-US', { timeZone: z, timeZoneName: 'shortOffset' });
    const m = s.match(/GMT([+-]\d{1,2}(?::\d{2})?)/);
    return m ? m[1] : '+0';
  } catch (e) { return ''; }
}
/** 展示标签：Asia/Shanghai (UTC+8) */
function getTimezoneLabel() {
  const z = getTimezone();
  return z ? (z + ' (UTC' + _tzOffsetLabel(z) + ')') : ('UTC' + _tzOffsetLabel(undefined));
}
/** 锁定状态（创世已发生 → 永远只读） */
function getTimezoneStatus() {
  return { timezone: getTimezone(), locked: true, label: getTimezoneLabel() };
}
/** 语言切换（t() 调用方零改动） */
function setLocale(loc) {
  if (I18N[loc]) UI_LOCALE = loc;
  return UI_LOCALE;
}

/** 时间显示单点：一切界面时间只准走这里（时区由 getTimezone() 创世锁定提供） */
function formatDisplayTime(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Intl.DateTimeFormat(UI_LOCALE, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: getTimezone() || undefined
    }).format(new Date(ts));
  } catch (e) {
    return '';
  }
}

// 双环境守卫：Node 测试可 require；浏览器侧 module 不存在，全局照常生效（同 behavior-scheduler 先例）
if (typeof module === 'object' && module.exports) {
  module.exports = { I18N, t, setLocale, getTimezone, getTimezoneLabel, getTimezoneStatus, formatDisplayTime, UI_LOCALE };
}
