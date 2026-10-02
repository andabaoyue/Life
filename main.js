const { app, BrowserWindow, ipcMain, screen, shell, Menu, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { load, save, tryLoad } = require('./src/config');
const { Brain } = require('./src/brain');
const { Wardrobe, CATALOG } = require('./src/wardrobe');
const { ActivityTracker } = require('./src/tracker');
const { TriggerEngine, COOLDOWN_MS, IDLE_MS } = require('./src/trigger');
const { DesktopMotion } = require('./src/desktop-motion');
const { checkAssets } = require('./src/asset-check');
const secure = require('./src/secure');
const layout = require('./src/layout');
const { ResearchService } = require('./src/research-service');
const { registerResearchIpc } = require('./src/research-ipc');
// v0.9.9 Phase 3: Creative Core 接入 IPC（独立创作空间，与 Subject 数据零互通）
const { createCreativeStore } = require('./src/creative/creative-store');
const { createCreativeSession } = require('./src/creative/creative-session');
const { registerCreativeIpc } = require('./src/creative-ipc');
// 0.9.8 Z3：Connection 管理（Provider Identity ≠ Protocol ≠ Connection ≠ Model）
const connectionsMod = require('./src/connections');
const secureCreds = require('./src/secure-credentials');
const { activateConnection } = require('./src/connection-switch');
const { runConnectionTest } = require('./src/connection-test');
const { createIpcGuard } = require('./src/ipc-guard');

/* brain 是会被重建的（config-set-key 换 key 时新造一个），所以每样依赖的注入
   都收在这一个函数里。以前只有 wardrobe 在这里绑，tracker 若另处再绑一次，
   就变成"重建的 brain 带着旧 tracker / 忘了带 tracker" —— 同一个对象两处出处，
   v0.7.0 那次穿着块顺序、v0.7.1 那次热重载重写都是这个形状。 */
function bindBrainDeps(brain) {
  if (!brain) return;
  brain.wardrobe = wardrobe || null;
  brain.bindTracker(tracker);
  // v0.9.9 意志层：启动 / 热替换时用当前特质校准主动性权重（缺省中立 1.0，既有行为零变化）
  if (trigger) trigger.updateTraits(brain.subjectState ? brain.subjectState.values : null);
  if (wardrobe) brain.memory.wardrobe = wardrobe.promptBlock(brain.subjectState ? brain.subjectState.values : null);
  // v0.9.9 P2-2a: 方案 A —— 内态变更经 onChange 接到镜像推送。
  // 这是「单一生命权威 -> 跨进程镜像」的唯一接线点，不要在别处再推一份。
  if (brain.internalRegulation) brain.internalRegulation.onChange = pushRegulationState;
}

let win = null;
let brain = null;
let cfg = null;
let wardrobe = null;
let tracker = null;
let trigger = null;
let motion = null;
let assetReport = null;
let proactiveTimer = null;
const motionUi = { bubble: false, talking: false, chatBusy: false, hidden: false };
let keyEncrypted = false;   // 面板要如实显示「已加密 / 明文降级」，不吹安全状态
let researchService = null;
let creativeStore = null;
let creativeSession = null;

// SEC-01: 所有 IPC 统一经 sender/frame/URL 三重校验（src/ipc-guard.js）；
// child frame / 外部 URL / 其他 webContents 一律拒绝，错误信息只有 UNTRUSTED_RENDERER。
const ipcGuard = createIpcGuard({ ipcMain, getMainWindow: () => win, appDir: __dirname });

app.name = 'Life';

// 同一个 userData 目录只允许一个实例，避免 memory/stats 的丢失更新。
const singleInstance = typeof app.requestSingleInstanceLock === 'function'
  ? app.requestSingleInstanceLock() : true;
if (!singleInstance) app.quit();
else app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); }
});

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const W = layout.BASE_W, H = layout.BASE_H;

  win = new BrowserWindow({
    title: 'Life',
    width: W, height: H,
    x: sw - W - 30, y: sh - H - 20,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  win.loadFile('index.html');
  ipcGuard.attachNavigationGuard(win.webContents); // SEC-01: will-navigate/will-redirect 限本地、拒绝新窗口
  setupMotion();
  // 拖到一半焦点丢了（在别的程序上松手），渲染进程收不到 mouseup ——
  // 主进程知道失焦，主动通知它收尾，否则桌宠会一直粘着鼠标。
  win.on('blur', () => {
    if (dragging && win && !win.isDestroyed()) win.webContents.send('drag-cancel');
  });
  win.webContents.on('did-finish-load', () => {
    if (assetReport && (!assetReport.ok || assetReport.warnings.length > 0)) {
      win.webContents.send('asset-warning', assetReport);
    }
  });
  scheduleProactiveCheck(IDLE_MS);
}

function syncMotionBlock(reason = 'user-priority') {
  if (!motion) return;
  const blocked = dragging || motionUi.bubble || motionUi.talking
    || motionUi.chatBusy || motionUi.hidden || !!(tracker && tracker.sleepMode);
  motion.setBlocked(blocked, reason);
}

// v0.9.9 P2-2a: 内态镜像推送的唯一出口。
// 此前只有 activity 事件推送它，于是对话/入睡/唤醒/关窗造成的内态变化
// 到不了渲染端 —— BehaviorScheduler 只能依据陈旧镜像做微动作倾斜（见 D-009 §1）。
function pushRegulationState() {
  if (win && !win.isDestroyed() && brain && brain.internalRegulation) {
    win.webContents.send('internal-regulation-updated', brain.internalRegulation.getState());
  }
}

function setupMotion() {
  if (!win || !cfg) return;
  const display = screen.getPrimaryDisplay();
  const area = display.workArea || { x: 0, y: 0, ...display.workAreaSize };
  const [width, height] = win.getSize();
  const [x, y] = win.getPosition();
  motion = new DesktopMotion({
    enabled: cfg.motionEnabled,
    speed: cfg.motionSpeed,
    tickMs: cfg.motionTickMs,
    margin: cfg.motionMargin,
    onState: (s) => {
      if (tracker) tracker.setMotionState(s.state, s.label);
      if (win && !win.isDestroyed()) win.webContents.send('motion-state', s);
    },
    onMove: (p) => {
      if (win && !win.isDestroyed() && !dragging) win.setPosition(Math.round(p.x), Math.round(p.y));
    }
  });
  motion.configure({ x: area.x, y: area.y, width: area.width, height: area.height },
    { width, height }, { x, y });
  syncMotionBlock('startup');
}

function reconfigureMotion() {
  if (!motion || !win || win.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const area = display.workArea || { x: 0, y: 0, ...display.workAreaSize };
  const [width, height] = win.getSize();
  const [x, y] = win.getPosition();
  motion.configure({ x: area.x, y: area.y, width: area.width, height: area.height },
    { width, height }, { x, y });
}

/* ---------- 拖动 ---------- */
let dragging = false;
ipcGuard.on('drag-start', () => { dragging = true; syncMotionBlock('drag'); });
ipcGuard.on('drag-end', () => { dragging = false; syncMotionBlock('drag-end'); });
ipcGuard.on('drag-move', (e, { dx, dy }) => {
  if (!dragging || !win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
  reconfigureMotion();
});

ipcGuard.on('motion-ui-state', (e, state = {}) => {
  for (const k of Object.keys(motionUi)) {
    if (typeof state[k] === 'boolean') motionUi[k] = state[k];
  }
  syncMotionBlock('ui-state');
});

ipcGuard.handle('motion-status', () => motion ? motion.snapshot() : null);

ipcGuard.handle('toggle-pin', () => {
  if (!win) return false;
  const on = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(on, 'screen-saver');
  return on;   // 返回新状态，菜单文案才能区分「已置顶/已取消置顶」
});

ipcGuard.on('resize-pet', (e, factor) => {
  if (!win) return;
  const [w, h] = win.getSize();
  const next = layout.nextSize(w, Number(factor) || 1);
  if (next.w === w && next.h === h) return;   // 已经到边界，不用再动
  const [x, y] = win.getPosition();
  // 脚钉住：桌宠是 bottom 定位，只改尺寸会让她在放大时往屏幕底下陷。
  win.setPosition(x, layout.anchorBottom(y, h, next.h));
  win.setSize(next.w, next.h);
  reconfigureMotion();
  syncMotionBlock('resize');
});

/* v1.0 笔 3b-a：对话流视窗扩容通道（拍板：展开 380×720 / 收起回基准 340×480）。
   复用 layout.anchorBottom 钉住下边缘（她脚踩屏幕，绝不因长高而下陷）；
   尺寸常量放窗口层、不动 src/layout.js —— 边界铁律：src/ 一行不改。 */
const CHAT_W = 380, CHAT_H = 720;
ipcGuard.handle('chat-viewport', (e, open) => {
  if (typeof open !== 'boolean') return { ok: false, error: 'INVALID_OPEN' };
  if (!win || win.isDestroyed()) return { ok: false, error: 'NO_WINDOW' };
  const target = open ? { w: CHAT_W, h: CHAT_H } : { w: layout.BASE_W, h: layout.BASE_H };
  const [w, h] = win.getSize();
  if (w === target.w && h === target.h) return { ok: true, w, h, changed: false };
  const [x, y] = win.getPosition();
  win.setPosition(x, layout.anchorBottom(y, h, target.h));
  win.setSize(target.w, target.h);
  reconfigureMotion();
  syncMotionBlock('resize');
  return { ok: true, w: target.w, h: target.h, changed: true };
});

ipcGuard.on('quit-app', () => {
  if (brain && typeof brain.flushAll === 'function') brain.flushAll();
  app.quit();
});

/* ---------- 本地活动（被戳 / 被拖） ----------
   计数放在主进程：这里同时是 brain 和 tracker 的所在地，环境块要在发请求前
   取快照。渲染端只知道"我这儿点了一下"，把它自己那套时间戳再算一遍就是
   第二个事实来源 —— 于是又回到"一个改了一个没改"那个老形状。
   用 .on 不用 .handle：这是纯上报，没有返回值，省一次 promise 往返。 */
ipcGuard.on('activity', (e, type) => {
  if (tracker) tracker.record(type);
  // 用户有了新交互，重置空闲检查闹钟
  scheduleProactiveCheck(IDLE_MS);
  // v0.9.9 P2-2a: 收敛到唯一出口（内态变更由 onChange 自动推送，这里保留一次
  // 兜底推送，确保旧路径行为逐字不变）
  pushRegulationState();
});

/* ---------- 对话 ---------- */
// 并发保护：上一条没回完就发新消息时，先掐断上一条
ipcGuard.handle('chat-send', async (e, text, opts) => {
  if (!brain || !brain.ready) {
    return { ok: false, needKey: true };
  }
  // 主动搭话：渲染端把 proactive-check 给的那份提案原样带回来。
  // 走"发出去再带回来"而不是主进程存一份 pendingOffer，是为了消灭
  // 「提案发了却没回复、主进程还留着它」这种陈旧状态 —— 那会让下一次
  // 开口拿着上一次的 at 去记冷却。没有 offer 的 proactive 一律当普通消息。
  const offer = (opts && opts.proactive && opts.offer) || null;
  const proactive = !!offer;
  if (proactive && !validOffer(offer)) return { ok: false, declined: true };
  motionUi.chatBusy = true;
  syncMotionBlock('chat');
  brain.abort();
  try {
    const res = await brain.ask(offer ? offer.reason : text, (delta) => {
      if (win && !win.isDestroyed()) win.webContents.send('chat-delta', delta);
    }, { proactive, proactiveHint: offer && offer.hint });
    // 主动搭话真的说出口了才记账；被渲染端礼貌闸门拦下时压根不会走到这
    if (proactive && trigger) trigger.commit(offer);
    // 换装是在 brain 里执行的（提案→真实状态→结果写回历史），
    // 这里只在真的换上了时把新图层推给渲染端，
    // 保证屏幕上穿的、系统提示里说的、历史里记的三者是同一件事。
    if (res.wearChanged) pushWardrobe();
    // v0.9.9 意志层：关窗后特质可能演进，刷新主动性权重（只动权重，不动闸门）
    if (res.windowClosed && trigger && brain && brain.subjectState) trigger.updateTraits(brain.subjectState.values);
    return { ok: true, text: res.text, state: res.state,
             wears: res.wears, wearNote: res.wearNote,
             windowClosed: res.windowClosed, merged: res.merged,
             proactive };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: err.message };
  } finally {
    motionUi.chatBusy = false;
    syncMotionBlock('chat-done');
    scheduleProactiveCheck(IDLE_MS);
  }
});

/* ---------- 主动搭话 ----------
   主进程判"该不该说"（它看得见静默、睡眠、连戳），渲染端判"现在能不能说"
   （它看得见输入框和气泡）。所以这里只出提案，不直接发请求：
   用户在打字时烧掉一次真 API 调用，既花钱又是打扰。 */
// 提案有效期 = 冷却长度。超过就拒：那已经是"上一次想说的话"了，
// 拿它去记冷却会把时间线记歪。
const OFFER_TTL_MS = COOLDOWN_MS;
function validOffer(offer) {
  if (!offer || (offer.kind !== 'poke' && offer.kind !== 'idle')) return false;
  if (typeof offer.at !== 'number' || !Number.isFinite(offer.at)) return false;
  const age = Date.now() - offer.at;
  return age >= 0 && age <= OFFER_TTL_MS;
}

function scheduleProactiveCheck(delayMs) {
  if (proactiveTimer) clearTimeout(proactiveTimer);
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    checkAndPushProactive();
  }, Math.max(100, delayMs));
  if (proactiveTimer.unref) proactiveTimer.unref();
}

function checkAndPushProactive() {
  if (!trigger || !brain || !brain.ready || !win || win.isDestroyed()) return;

  const at = Date.now();
  const lastAct = tracker ? tracker.lastInteractionAt : at;
  const idleMs = at - lastAct;
  const idleMin = Math.floor(idleMs / 60000);

  // Phase 0.5: 桌面挂机事件直连 (带水位线防重复)
  if (tracker && idleMin >= 10) {
    tracker.recordIdle(idleMin, at);
  }

  const offer = trigger.evaluate();
  if (offer) {
    win.webContents.send('proactive-offer', offer);
  } else {
    const idleRemaining = IDLE_MS - idleMs;
    const nextDelay = idleRemaining > 0 ? idleRemaining : COOLDOWN_MS;
    // 挂机检查调度：步长不超过 10 分钟，确保 10、20 分钟阶段性挂机事件能被及时检测
    const checkDelay = Math.min(Math.max(COOLDOWN_MS, nextDelay), 10 * 60000);
    scheduleProactiveCheck(checkDelay);
  }
}

ipcGuard.on('proactive-declined', () => {
  scheduleProactiveCheck(COOLDOWN_MS);
});

ipcGuard.handle('proactive-check', () => {
  if (!trigger || !brain || !brain.ready) return null;
  return trigger.evaluate();
});

ipcGuard.handle('chat-report', () => {
  // 面板上那些数字（model / 窗口参数）和 config-get 同一个盲区，一起补
  syncCfgFromDisk();
  return brain ? brain.report() : null;
});

// v0.9.9 F-099-01 / D-005: memory-clear / memory-delete 裸通道已拔除 ——
// 窗口摘要属受保护历史，记忆面板只读；重新诞生只走带二次确认的 self-ledger-reset。
ipcGuard.handle('memory-list', () => (brain ? brain.memory.listMemory() : []));

// v1.0 笔 2：气泡流数据层只读通道 —— 单一事实源是 memory.history（她眼里的真实对话史）。
// synthetic 显式保留：主动搭话的程序触发不得伪装成用户发言；t 缺失即 null，绝不伪造时间。
ipcGuard.handle('chat-history', () => {
  if (!brain || !brain.memory) return [];
  return (brain.memory.history || []).map(m => ({
    role: m.role,
    content: m.content,
    messageId: m.messageId,
    windowNo: m.windowNo,
    bridge: Boolean(m.bridge),
    synthetic: Boolean(m.synthetic),
    t: Number.isFinite(m.t) ? m.t : null
  }));
});

// 自我成长记录只读展示；删除/覆盖留到 schema 和审计策略明确后再开放。
ipcGuard.handle('self-ledger-list', () => (brain ? brain.listSelfLedger() : []));

ipcGuard.handle('self-ledger-reset', (e, opts) => {
  // N-08: reset 不可逆清空成长档案并重置出生点 —— 必须显式确认。
  // 未确认请求一律拒绝；确认由调用方明示（UI 的 window.confirm 之后带 confirm: true），
  // 裸调用/误触拿不到 reset。SEC-01 的 ipcGuard sender/frame/URL 防护不变。
  if (!opts || opts.confirm !== true) {
    return { ok: false, error: 'REQUIRES_EXPLICIT_CONFIRMATION' };
  }
  if (!brain) return { ok: false, error: '程序尚未初始化' };
  brain.selfLedger.reset();
  brain.birthAt = brain.selfLedger.birthAt;
  return { ok: true, birthAt: brain.birthAt };
});

// Phase 0.5: 内部调节中枢权威状态只读查询通道
ipcGuard.handle('internal-regulation-get', () => (brain && brain.internalRegulation ? brain.internalRegulation.getState() : null));

/* ---------- 换装 ----------
   服装只是外观层：这里没有任何路径会碰 persona 里的人格设定，
   穿什么衣服都不会改变她是谁。
   但 system 末尾的「当前穿着」块必须跟着真实状态走 ——
   否则模型被问到穿了什么时只能凭想象回答，那就是编造。 */
/* 只有状态真的变了才推：被拒的搭配不推、重复点同一件不推，
   否则屏幕会白闪一次，模型那边也会以为刚换过衣服。 */
function pushWardrobe(r) {
  if (r && !(r.ok && r.changed)) return;
  if (!win || win.isDestroyed() || !wardrobe) return;
  if (brain) brain.memory.wardrobe = wardrobe.promptBlock(brain.subjectState ? brain.subjectState.values : null);
  win.webContents.send('wardrobe-changed', wardrobe.layers());
}

ipcGuard.handle('wardrobe-state', () =>
  wardrobe ? { catalog: wardrobe.catalog(), layers: wardrobe.layers() }
           : { catalog: null, layers: [] });

ipcGuard.handle('wardrobe-set', (e, { slot, itemId }) => {
  if (!wardrobe) return { ok: false, error: '换装系统未初始化' };
  const r = wardrobe.setEquip(String(slot || ''), itemId === undefined ? null : itemId);
  pushWardrobe(r);
  return r;
});

ipcGuard.handle('wardrobe-preset', (e, id) => {
  if (!wardrobe) return { ok: false, error: '换装系统未初始化' };
  const r = wardrobe.applyPreset(id);
  pushWardrobe(r);
  return r;
});

/* ---------- 配置 ----------
   apiKey 不再明文落盘：走 src/secure.js（Electron safeStorage）。
   内存里的 cfg.apiKey 仍是明文（要拿去发请求），磁盘上只有密文文件。 */
const getSS = () => safeStorage || null;

function persistCfg(next) {
  const r = secure.saveConfig(getSS, app.getPath('userData'), next,
    (disk) => save(app.getPath('userData'), next, disk));
  keyEncrypted = r.encrypted;
  return r;
}

/* 面板打开前先从盘上同步一次。
   brain.ask() 每轮开头已经会 refreshConfig()，但那是唯一的挂点：
   用户在编辑器里改了 model 或价格，接着右键打开「设置 / 用量」，
   下面 config-get / chat-report 读的是内存里那份 —— 于是不发消息就看不到
   自己刚改的东西，看起来像"热重载没生效"。代价是一次几百字节的同步读。
   热重载的**做法只有一处**（Brain.refreshConfig）：这里不重写一遍，
   否则"怎么同步"就有两个出处，早晚会像 v0.7.0 那次穿着块顺序一样，
   一个改了一个没改。brain.cfg 与这里的 cfg 始终是同一个对象
   （config-set-key 重建 brain 时传的就是这个 cfg），所以直接借它用。 */
function syncCfgFromDisk() {
  if (brain) { brain.refreshConfig(); return; }
  const next = tryLoad(app.getPath('userData'));
  if (!next) return;
  const { apiKey } = cfg;
  Object.assign(cfg, next, { apiKey });
}

ipcGuard.handle('config-get', () => {
  syncCfgFromDisk();
  return {
  hasKey: !!cfg.apiKey,
  keyEncrypted,
  baseURL: cfg.baseURL,
  model: cfg.model,
  windowTurns: cfg.windowTurns,
  windowMaxTokens: cfg.windowMaxTokens,
  keepTailMessages: cfg.keepTailMessages,
  memoryCapTokens: cfg.memoryCapTokens,
  selfGrowthEnabled: cfg.selfGrowthEnabled !== false,
  selfLedgerMaxEntries: cfg.selfLedgerMaxEntries,
  currentSelfTokenBudget: cfg.currentSelfTokenBudget,
  birthAt: brain && brain.birthAt,
  archiveStatus: brain && brain.selfLedger && brain.selfLedger.status,
  requestTimeoutMs: cfg.requestTimeoutMs,
  streamIdleTimeoutMs: cfg.streamIdleTimeoutMs,
  motionEnabled: cfg.motionEnabled,
  motionSpeed: cfg.motionSpeed,
  motionTickMs: cfg.motionTickMs,
  motionMargin: cfg.motionMargin
  };
});

ipcGuard.handle('config-set-key', (e, key) => {
  // P5-D: 热替换编排收敛到 brain-hot-swap.js ——
  // candidate 任一步失败 -> cleanup + 配置回滚 + 旧 Brain 继续服务，绝不留半初始化 Brain
  const { swapBrain } = require('./src/brain-hot-swap');
  const oldCfg = cfg;
  const next = { ...cfg, apiKey: String(key || '').trim() };
  let persisted = null;
  const res = swapBrain({
    oldBrain: brain,
    oldCfg,
    nextCfg: next,
    createCandidate: (c) => new Brain(app.getPath('userData'), c),
    bindCandidate: bindBrainDeps,
    persistCfg: (c) => { persisted = persistCfg(c); }
  });
  if (!res.ok) return { ok: false, error: res.error };

  // 切换主引用
  cfg = res.cfg;
  brain = res.brain;
  keyEncrypted = persisted.encrypted;
  // v0.9.9 Phase 3: Creative session 重绑新 provider cfg（已开始的 generation 持旧引用继续，不受影响）
  if (creativeStore) creativeSession = createCreativeSession({ store: creativeStore, cfg });

  return { ok: true, hasKey: !!cfg.apiKey, keyEncrypted: persisted.encrypted };
});

ipcGuard.handle('config-open', () => {
  const p = secure.cfgPath(app.getPath('userData'));
  if (!fs.existsSync(p)) {
    // 交给唯一那个写盘口生成，别在这里手抄一份：
    // 加密可用时它写出的文件本来就不含 key，降级时才含明文。
    // 若在此处硬写「去掉 key」的文件，降级用户下次启动就没 key 了。
    persistCfg(cfg);
  }
  shell.openPath(p);
  return p;
});

ipcGuard.handle('asset-check', () => assetReport || checkAssets(__dirname, CATALOG));

/* ---------- Connection 管理（0.9.8 Z3）----------
   安全硬边界：credential 只进不出 —— list/get 只回 hasCredential/keyEncrypted，
   绝不返回 API Key / 解密结果 / 密文内容 / 文件路径 / namespace 解析结果。
   renderer 不得指定 credentialRef（服务端生成）；删除语义：exclusive 联动删凭据、
   legacy-mapped 只删连接（connections.js 已强制）。全部经 ipcGuard（SEC-01）。 */
function connectionDto(c) {
  const desc = secureCreds.describeCredential(c.credentialRef, {
    dir: app.getPath('userData'),
    getSS,
    // legacy 明文降级只对 legacy-mapped ref 生效（防 A 的 key 被误判为 B 的凭据）
    fallbackSecret: c.credentialOwnership === 'legacy-mapped' ? (cfg && cfg.apiKey) || '' : ''
  });
  return {
    connectionId: c.connectionId,
    displayName: c.displayName,
    providerId: c.providerId,
    protocol: c.protocol,
    baseURL: c.baseURL,
    models: c.models,
    activeModel: c.activeModel,
    capabilitySnapshot: c.capabilitySnapshot,
    testState: c.testState,
    hasCredential: desc.present,
    keyEncrypted: desc.encrypted
  };
}

// Z1-E：store 不存在时用旧平铺 cfg 幂等迁移（启动期 eager + 懒入口兜底；失败仍以旧 flat 为真源）
function ensureConnectionStore() {
  try {
    const dir = app.getPath('userData');
    if (connectionsMod.loadStore(dir).status === 'absent') {
      connectionsMod.migrateLegacyConfig(dir, cfg || {});
    }
  } catch { /* fail-closed：迁移失败不影响旧配置路径 */ }
}

ipcGuard.handle('connections:list', () => {
  ensureConnectionStore();
  const st = connectionsMod.loadStore(app.getPath('userData'));
  if (!st.ok) return { ok: false, error: st.error };
  if (!st.store) return { ok: true, activeConnectionId: null, items: [] };
  return {
    ok: true,
    activeConnectionId: st.store.activeConnectionId,
    items: st.store.connections.map(connectionDto)
  };
});

ipcGuard.handle('connections:get', (e, opts) => {
  ensureConnectionStore();
  const st = connectionsMod.loadStore(app.getPath('userData'));
  if (!st.ok) return { ok: false, error: st.error };
  const c = st.store && st.store.connections.find((x) => x.connectionId === (opts && opts.connectionId));
  return c ? { ok: true, connection: connectionDto(c) } : { ok: false, error: 'CONNECTION_NOT_FOUND' };
});

ipcGuard.handle('connections:create', (e, opts = {}) => {
  ensureConnectionStore();
  // 白名单字段：credentialRef/connectionId/credentialOwnership 不接受 renderer 输入（服务端生成）
  const r = connectionsMod.createConnection(app.getPath('userData'), {
    displayName: opts.displayName,
    providerId: opts.providerId,
    protocol: opts.protocol,
    baseURL: opts.baseURL,
    model: opts.model
  });
  if (!r.ok) return r;
  if (typeof opts.credential === 'string' && opts.credential) {
    const w = secureCreds.setCredential(r.connection.credentialRef, opts.credential, { dir: app.getPath('userData'), getSS });
    if (!w.ok) {
      connectionsMod.deleteConnection(app.getPath('userData'), r.connection.connectionId, { deleteCredential: true, getSS });
      return { ok: false, error: 'CREDENTIAL_WRITE_FAILED: ' + (w.error || '') };
    }
  }
  return { ok: true, connectionId: r.connection.connectionId };
});

ipcGuard.handle('connections:update', (e, opts = {}) => {
  const { connectionId, patch = {}, credential } = opts;
  // immutable 字段（credentialRef/connectionId/credentialOwnership）在模块层拒绝
  const r = connectionsMod.updateConnection(app.getPath('userData'), connectionId, patch || {});
  if (!r.ok) return r;
  if (typeof credential === 'string' && credential) {
    const w = secureCreds.setCredential(r.connection.credentialRef, credential, { dir: app.getPath('userData'), getSS });
    if (!w.ok) return { ok: false, error: 'CREDENTIAL_WRITE_FAILED: ' + (w.error || '') };
  }
  return { ok: true };
});

ipcGuard.handle('connections:delete', (e, opts = {}) => {
  const r = connectionsMod.deleteConnection(app.getPath('userData'), opts.connectionId, {
    deleteCredential: opts.deleteCredential !== false,
    getSS
  });
  if (!r.ok) return r;
  return { ok: true, credentialDeleted: r.credentialDeleted, credentialNote: r.credentialNote };
});

ipcGuard.handle('connections:test', async (e, opts = {}) => {
  // 用户显式调用即代表点击 Test Connection：validateConfig -> healthCheck(若声明) -> authProbe(必要时)
  const dir = app.getPath('userData');
  const r = await runConnectionTest(dir, opts.connectionId, { getSS, fallbackSecret: (cfg && cfg.apiKey) || '' });
  if (r.ok) {
    try {
      connectionsMod.updateConnection(dir, opts.connectionId, {
        testState: { status: r.status, phase: r.phase, reason: r.reason || null, lastTestedAt: Date.now() }
      });
    } catch { /* 快照持久化失败不影响测试结果返回 */ }
  }
  return r;
});

ipcGuard.handle('connections:activate', (e, opts = {}) => {
  const dir = app.getPath('userData');
  const st = connectionsMod.loadStore(dir);
  if (!st.ok) return { ok: false, swapped: false, error: st.error };
  if (!st.store) return { ok: false, swapped: false, error: 'STORE_ABSENT' };
  const targetId = opts && opts.connectionId;
  if (st.store.activeConnectionId === targetId && brain) {
    return { ok: true, activeConnectionId: targetId, swapped: false };
  }
  const r = activateConnection({
    dir,
    targetConnectionId: targetId,
    oldBrain: brain,
    oldCfg: cfg,
    persistFlat: (c) => { persistCfg(c); },
    createCandidate: (c) => new Brain(app.getPath('userData'), c),
    bindCandidate: bindBrainDeps,
    getSS,
    fallbackSecret: (cfg && cfg.apiKey) || ''
  });
  if (!r.ok) {
    return { ok: false, swapped: false, activeConnectionId: r.activeConnectionId, error: r.error };
  }
  cfg = r.cfg;
  brain = r.brain;
  return { ok: true, activeConnectionId: r.activeConnectionId, swapped: true };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const r = secure.loadConfig(getSS, app.getPath('userData'),
    () => load(app.getPath('userData')));
  cfg = r.cfg;
  keyEncrypted = r.encrypted;
  ensureConnectionStore(); // Z1-E：旧单配置 -> default connection（幂等，失败不阻塞）
  // 环境变量只注入当前进程，不自动持久化，避免临时 Key 变成磁盘凭据。
  if (!cfg.apiKey && process.env.DEEPSEEK_API_KEY) {
    cfg = { ...cfg, apiKey: process.env.DEEPSEEK_API_KEY };
  }
  // 顺序要紧：先造 tracker/wardrobe 再造 brain，bind 才拿得到东西往里注。
  // （反过来也不报错，只会静默注进去两个 null —— 那正是最难查的那种。）
  tracker = new ActivityTracker();
  wardrobe = new Wardrobe(app.getPath('userData'));
  brain = new Brain(app.getPath('userData'), cfg);
  // 换装执行器 + 本地活动追踪器注入：模型给提案 -> wardrobe 落真实状态 ->
  // 结果写回历史；她被戳了几下 -> tracker 记账 -> 随当轮 user 消息如实告知。
  bindBrainDeps(brain);
  trigger = new TriggerEngine(tracker);
  assetReport = checkAssets(__dirname, CATALOG);
  if (assetReport && (!assetReport.ok || assetReport.warnings.length)) {
    for (const w of assetReport.warnings) console.warn('[AssetCheck]', w);
  }
  researchService = new ResearchService(app.getPath('userData'));
  registerResearchIpc(ipcGuard, researchService, { dialog }); // SEC-01: research IPC 同样经 sender 校验

  // v0.9.9 Phase 3: Creative 创作空间（store + session + IPC，全部经既有 ipc-guard sender 校验）
  creativeStore = createCreativeStore(app.getPath('userData'));
  creativeSession = createCreativeSession({ store: creativeStore, cfg });
  registerCreativeIpc(ipcGuard, {
    getStore: () => creativeStore,
    getSession: () => creativeSession,
    getWebContents: () => (win && !win.isDestroyed() ? win.webContents : null),
    skillsDir: path.join(app.getPath('userData'), 'creative', 'skills'),
    dataRoot: app.getPath('userData')
  });
  createWindow();
});

app.on('before-quit', () => {
  if (brain && typeof brain.flushAll === 'function') brain.flushAll();
});

app.on('window-all-closed', () => {
  if (brain && typeof brain.flushAll === 'function') brain.flushAll();
  app.quit();
});
