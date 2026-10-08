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
try {
  const savedLocale = (typeof localStorage !== 'undefined' && localStorage && localStorage.getItem('uiLocale'));
  if (savedLocale === 'en' || savedLocale === 'zh-CN') UI_LOCALE = savedLocale;
} catch (e) {}

const I18N = {
  'zh-CN': {
    'chat.title': '对话',
    'chat.placeholder': '说点什么…',
    'chat.empty': '（还没有对话）',
    'chat.windowBreak': '—— 以下为当前窗口 ——',
    'chat.sendFailed': '（这条没送出去，稍后再试）',
    'chat.closeTitle': '关闭 (ESC)',
    'card.dragHint': '拖到舒服的位置',
    'archive.title': '生命档案',
    'archive.windows': '窗口小结',
    'archive.ledger': '成长记录',
    'panel.i18nTitle': '国际化与物理时空',
    'panel.language': '界面语言',
    'panel.timezone': '创世时区',
    'panel.tzLocked': '创世已锚定，不可修改',
    'tz.compass': '时空罗盘',
    'tz.birth': '创世时刻',
    'tz.zone': '创世时区',
    'tz.uptime': '陪伴时长',
    'tz.sync': '时空同步',
    'tz.synced': '与宿主时空完全同步',
    'tz.travelA': '宿主位于',
    'tz.travelC': '时差',
    'tz.travelD': '她那边现在',
    'tz.hours': '小时',
    'preset.section': '服务商预设',
    'preset.deepseek': 'DEEPSEEK',
    'preset.mimo': 'MIMO',
    'preset.mimoTokenPlan': 'MIMO (TOKEN PLAN)',
    'preset.gpt': 'GPT',
    'preset.claude': 'CLAUDE',
    'preset.gemini': 'GEMINI',
    'preset.glm': 'GLM',
    'preset.kimi': 'KIMI',
    'preset.qwen': 'QWEN',
    'preset.doubao': 'DOUBAO',
    'preset.siliconflow': 'SILICONFLOW',
    'preset.groq': 'GROQ',
    'preset.mistral': 'MISTRAL',
    'preset.openrouter': 'OPENROUTER',
    'preset.ernie': 'ERNIE',
    'preset.spark': 'SPARK',
    'preset.local': 'LOCAL',
    'preset.custom': 'CUSTOM',
    'detect.suggest': '检测到可能的服务商，点击套用：',
    'detect.apply': '一键套用',
    'detect.reason.tp': '检测到小米 Token Plan 订阅套餐凭据前缀',
    'detect.reason.mimo': '检测到小米 MiMo 专属凭据前缀',
    'detect.reason.sk': '检测到标准 sk- 前缀（建议 DeepSeek 官方或兼容服务）',
    'wardrobe.suggestPrefix': '建议补齐成套：',
    'wardrobe.applyComplete': '一键成套',
    'wardrobe.completeFailed': '补齐未完成：',
    'wardrobe.completeSuccess': '已自动补齐成套搭配，穿戴完毕~',
    'sec.conn': '连接',
    'sec.wardrobe': '衣橱',
    'sec.dreams': '梦境',
    'wd.now': '现在穿着',
    'sec.memory': '记忆',
    'sec.timezone': '时区',
    'sec.danger': '危险区',
    'sec.dangerHint': '以下操作不可逆，请确认后再动手',
    'danger.armAgain': '再次点击确认执行',
    'danger.cooling': '保险解除中',
    'panel.closeHint': '按 ESC 或右键空白处即可关闭',
    'conn.delete': '删除当前连接',
    'menu.pin': '固定在最前',
    'menu.unpin': '取消置顶',
    'chat.send': '发送',
    'chat.bedsideNote': '（她睡着时留的，当时没有回应）',
    'tz.about': '约',
    'agent.cap.read': '读取文件',
    'agent.cap.write': '写入文件',
    'agent.cap.exec': '执行命令',
    'agent.cap.net': '网络请求（已封禁）',
    'agent.danger.low': '低风险',
    'agent.danger.medium': '中风险',
    'agent.danger.high': '高风险',
    'agent.danger.unknown': '未定级',
    'agent.action.approve': '授权',
    'agent.action.reject': '拒绝',
    'agent.reason.empty': '（未说明理由）',
    'agent.budget.tripped': '执行预算已耗尽，无法执行任何动作',
    'agent.budget.remaining': '剩余可用动作：',
    'agent.warn.highRisk': '这是高风险操作，请确认你要改动的确实是这个目标。',
    'agent.label.scope': '目标',
    'agent.label.reason': '理由',
    'agent.label.budget': '预算',
    'menu.talk': '对话',
    'menu.wardrobe': '衣橱',
    'menu.panel': '设置',
    'menu.research': '个体观测',
    'menu.outline': '切换描边',
    'menu.quit': '退出',
    'panel.title': '设置',
    'conn.quick': '快速连接',
    'conn.advanced': '高级',
    'conn.list': '连接列表',
    'conn.name': '连接名称',
    'conn.namePlaceholder': '给它起个名（比如：家用 / 公司）',
    'conn.keyPlaceholder': '仅写入，不回显',
    'conn.modelPlaceholder': '手填 model ID',
    'conn.anthropicNative': 'Anthropic-native（未实现）',
    'conn.new': '新建',
    'conn.save': '保存',
    'conn.test': '测试连接',
    'conn.activate': '设为当前',
    'conn.openCfg': '打开配置文件',
    'conn.keyState.none': '未配置 Key — 填一下才能对话',
    'conn.keyState.enc': '已配置 Key（磁盘上为加密存储）',
    'conn.keyState.plain': '已配置 Key（注意：本机不支持加密，Key 仍是明文存储）',
    'sec.stats': '用量',
    'stats.requests': '请求',
    'stats.model': '模型',
    'stats.peak': '(高峰价)',
    'stats.rate': '累计命中率',
    'stats.low': '(偏低)',
    'stats.last': '上一次',
    'stats.hit': '命中',
    'stats.miss': '未命中',
    'stats.output': '输出',
    'stats.cost': '花费',
    'stats.window': '对话窗口 第',
    'stats.windowSeg': ' 段',
    'stats.turns': '轮',
    'stats.context': '上下文',
    'stats.memSummary': '记忆',
    'stats.memSummariesCount': '条小结',
    'stats.compressions': '小结',
    'stats.merges': '合并',
    'stats.times': '次',
    'stats.preview': '预览模式，无数据',
    'mem.title': '我的记忆',
    'mem.window': '窗口',
    'mem.her': '她的经历',
    'mem.you': '关于你',
    'mem.other': '记忆',
    'mem.empty': '还没有长期记忆（聊满一轮窗口后会生成小结）',
    'mem.preview': '预览模式，无记忆数据',
    'wd.off': '脱下',
    'wd.hint': '换装只换外观，不影响性格和说话方式',
    'wd.preview': '预览模式，衣柜不可用',
    'wd.notInit': '衣柜未初始化',
    'danger.resetSelf': '重置成长档案',
    'research.title': '实验观测与复盘工具',
    'research.refresh': '刷新快照',
    'research.tab.state': '主体状态',
    'research.tab.dreams': '梦境',
    'research.tab.provenance': '归因与 EOI',
    'research.tab.replay': 'Replay 实验室',
    'research.tab.windows': 'Window 浏览器',
    'research.tab.export': '数据导出',
    'research.footer.status': 'Snapshot: 就绪 | 观察层只读受控',
    'research.footer.hashes': 'SHA-256: 校验中',
  },
  // UX-05（笔 6）：en 表键集必须与 zh-CN 100% 一致（测试机械死守）
  'en': {
    'chat.title': 'Chat',
    'chat.placeholder': 'Say something…',
    'chat.empty': '(no conversation yet)',
    'chat.windowBreak': '— current window below —',
    'chat.sendFailed': "(this one didn't go through, try again)",
    'chat.closeTitle': 'Close (ESC)',
    'card.dragHint': 'drag me somewhere comfy',
    'archive.title': 'Life Archive',
    'archive.windows': 'Window Summaries',
    'archive.ledger': 'Growth Ledger',
    'panel.i18nTitle': 'Language & Space-Time',
    'panel.language': 'Language',
    'panel.timezone': 'Genesis Timezone',
    'panel.tzLocked': 'Anchored at genesis, not editable',
    'tz.compass': 'Space-Time Compass',
    'tz.birth': 'Genesis Moment',
    'tz.zone': 'Genesis Timezone',
    'tz.uptime': 'Time Together',
    'tz.sync': 'Sync Status',
    'tz.synced': 'In sync with host',
    'tz.travelA': 'Host at',
    'tz.travelC': 'Time diff',
    'tz.travelD': 'Her local time',
    'tz.hours': 'h',
    'preset.section': 'Provider Preset',
    'preset.deepseek': 'DEEPSEEK',
    'preset.mimo': 'MIMO',
    'preset.mimoTokenPlan': 'Xiaomi MiMo (Token Plan)',
    'preset.gpt': 'GPT',
    'preset.claude': 'CLAUDE',
    'preset.gemini': 'GEMINI',
    'preset.glm': 'GLM',
    'preset.kimi': 'KIMI',
    'preset.qwen': 'QWEN',
    'preset.doubao': 'DOUBAO',
    'preset.siliconflow': 'SILICONFLOW',
    'preset.groq': 'GROQ',
    'preset.mistral': 'MISTRAL',
    'preset.openrouter': 'OPENROUTER',
    'preset.ernie': 'ERNIE',
    'preset.spark': 'SPARK',
    'preset.local': 'LOCAL',
    'preset.custom': 'CUSTOM',
    'detect.suggest': 'Suggested provider detected, click to apply:',
    'detect.apply': 'Apply',
    'detect.reason.tp': 'Xiaomi Token Plan subscription credential prefix detected',
    'detect.reason.mimo': 'Xiaomi MiMo credential prefix detected',
    'detect.reason.sk': 'Standard sk- prefix detected (DeepSeek official or compatible)',
    'wardrobe.suggestPrefix': 'Complete the look: ',
    'wardrobe.applyComplete': 'Complete Outfit',
    'wardrobe.completeFailed': 'Completion failed: ',
    'wardrobe.completeSuccess': 'Outfit completed and applied~',
    'sec.conn': 'Connections',
    'sec.wardrobe': 'Wardrobe',
    'sec.dreams': 'Dreams',
    'wd.now': 'Wearing now',
    'sec.memory': 'Memory',
    'sec.timezone': 'Timezone',
    'sec.danger': 'Danger Zone',
    'sec.dangerHint': 'These actions are irreversible. Please confirm before proceeding.',
    'danger.armAgain': 'Click again to confirm',
    'danger.cooling': 'Unlocking',
    'panel.closeHint': 'Press ESC or right-click anywhere to close',
    'conn.delete': 'Delete Connection',
    'menu.pin': 'Pin on Top',
    'menu.unpin': 'Unpin',
    'chat.send': 'Send',
    'chat.bedsideNote': '(Left while she was asleep; not answered at the time)',
    'tz.about': '~',
    'agent.cap.read': 'Read File',
    'agent.cap.write': 'Write File',
    'agent.cap.exec': 'Execute Command',
    'agent.cap.net': 'Network Request (Blocked)',
    'agent.danger.low': 'Low Risk',
    'agent.danger.medium': 'Medium Risk',
    'agent.danger.high': 'High Risk',
    'agent.danger.unknown': 'Unrated',
    'agent.action.approve': 'Approve',
    'agent.action.reject': 'Reject',
    'agent.reason.empty': '(No reason provided)',
    'agent.budget.tripped': 'Execution budget exhausted; actions halted.',
    'agent.budget.remaining': 'Remaining actions: ',
    'agent.warn.highRisk': 'High-risk operation. Please ensure this is the intended target.',
    'agent.label.scope': 'Target',
    'agent.label.reason': 'Reason',
    'agent.label.budget': 'Budget',
    'menu.talk': 'Chat',
    'menu.wardrobe': 'Wardrobe',
    'menu.panel': 'Settings',
    'menu.research': 'Observation',
    'menu.outline': 'Toggle Outline',
    'menu.quit': 'Quit',
    'panel.title': 'Settings',
    'conn.quick': 'Quick Connect',
    'conn.advanced': 'Advanced',
    'conn.list': 'Connection List',
    'conn.name': 'Connection Name',
    'conn.namePlaceholder': 'Give it a name (e.g., Home / Work)',
    'conn.keyPlaceholder': 'Write-only, never echoed',
    'conn.modelPlaceholder': 'Enter model ID',
    'conn.anthropicNative': 'Anthropic-native (Unimplemented)',
    'conn.new': 'New',
    'conn.save': 'Save',
    'conn.test': 'Test',
    'conn.activate': 'Set Active',
    'conn.openCfg': 'Open Config File',
    'conn.keyState.none': 'No Key configured — enter one to start chatting',
    'conn.keyState.enc': 'Key configured (encrypted on disk)',
    'conn.keyState.plain': 'Key configured (Note: plain-text storage, encryption unsupported)',
    'sec.stats': 'Usage',
    'stats.requests': 'Requests',
    'stats.model': 'Model',
    'stats.peak': '(Peak)',
    'stats.rate': 'Hit Rate',
    'stats.low': '(Low)',
    'stats.last': 'Last',
    'stats.hit': 'Hit',
    'stats.miss': 'Miss',
    'stats.output': 'Output',
    'stats.cost': 'Cost',
    'stats.window': 'Window #',
    'stats.windowSeg': '',
    'stats.turns': 'turns',
    'stats.context': 'Context',
    'stats.memSummary': 'Memory',
    'stats.memSummariesCount': 'summaries',
    'stats.compressions': 'Compressions',
    'stats.merges': 'Merges',
    'stats.times': 'times',
    'stats.preview': 'Preview mode, no data',
    'mem.title': 'My Memories',
    'mem.window': 'Window',
    'mem.her': 'Her Experiences',
    'mem.you': 'About You',
    'mem.other': 'Memories',
    'mem.empty': 'No long-term memories yet (summaries are generated after a full window)',
    'mem.preview': 'Preview mode, no memory data',
    'wd.off': 'Take off',
    'wd.hint': 'Outfits only change appearance, not personality or tone',
    'wd.preview': 'Preview mode, wardrobe unavailable',
    'wd.notInit': 'Wardrobe not initialized',
    'danger.resetSelf': 'Reset Growth Archive',
    'research.title': 'Observation & Replay Tools',
    'research.refresh': 'Refresh Snapshot',
    'research.tab.state': 'Entity State',
    'research.tab.dreams': 'Dreams',
    'research.tab.provenance': 'Attribution & EOI',
    'research.tab.replay': 'Replay Lab',
    'research.tab.windows': 'Window Browser',
    'research.tab.export': 'Export Data',
    'research.footer.status': 'Snapshot: Ready | Read-only controlled',
    'research.footer.hashes': 'SHA-256: Verifying',
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
  if (I18N[loc]) {
    UI_LOCALE = loc;
    try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem('uiLocale', loc); } catch (e) {}
  }
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
