const { app, BrowserWindow, ipcMain, screen, shell, Menu, Tray, globalShortcut, nativeImage, safeStorage, dialog } = require('electron');
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
// Creative Mode 旧实现已按路线图 §3/§4.6 裁定拆除（2026-10）：
// 「v0.9.9 不再继续建设 Creative Mode 独立框架」，实现保留在 Git 历史中作为架构实验记录。
// 0.9.8 Z3：Connection 管理（Provider Identity ≠ Protocol ≠ Connection ≠ Model）
const connectionsMod = require('./src/connections');
const secureCreds = require('./src/secure-credentials');
const { activateConnection } = require('./src/connection-switch');
const { runConnectionTest } = require('./src/connection-test');
const { createIpcGuard } = require('./src/ipc-guard');
// v1.0 D-1：Agent 执行能力 IPC 治理通道（纯只读+ 提案受理，执行器仍为 Mock）
const { registerAgentIpc } = require('./src/agent-ipc');
const { CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog } = require('./src/agent-interfaces');
// D-4：写事务管理器（D-2 实现，D-4 起才真正被Agent 执行器用到）。
const { WriteTransactionManager } = require('./src/agent-transaction');
// D-5：沙盒目录定位与确保（创建失败即拒，绝不静默降级）。
const { sandboxPathFor, ensureSandboxDir } = require('./src/agent-sandbox');
const { UserConfirmationGate } = require('./src/agent-confirmation');

/* brain 是会被重建的（config-set-key 换 key 时新造一个），所以每样依赖的注入
   都收在这一个函数里。以前只有 wardrobe 在这里绑，tracker 若另处再绑一次，
   就变成"重建的 brain 带着旧 tracker / 忘了带 tracker" —— 同一个对象两处出处，
   v0.7.0 那次穿着块顺序、v0.7.1 那次热重载重写都是这个形状。 */
function bindBrainDeps(brain) {
  if (!brain) return;
  brain.wardrobe = wardrobe || null;
  brain.bindTracker(tracker);
  // v0.9.9 意志层：启动 / 热替换时用当前特质校准主动性权重（缺省中立 1.0，既有行为零变化）
  //
  // 🔴 D-8a：这三句注释锁的是一个反直觉的事实 —— **这里刷不到 traits。**
  //   启动路径上 bindBrainDeps 跑在 `trigger = new TriggerEngine()` 之前，
  //   此刻模块级 trigger 仍是 null ⇒ 整句落空 ⇒ traits 长期为 null，
  //   于是 attachment_high / curiosity_high / vitality_high 三档意图从未运行过。
  //   （D-7 交付时宣称「她开口时带着自己想说的话」，实测 5 档只剩 2 档。）
  //
  //   为什么**不能**把这句删掉、只在启动处补：bindBrainDeps 同时是热替换的
  //   回调（main.js 的 config-set-key 与换连接都把它当 bindCandidate 传下去，
  //   由 brain-hot-swap / connection-switch 调用），而那两条路径上 trigger
  //   早已存在 —— **这句是热替换后唯一的 traits 刷新点**。删了它，
  //   换 key / 换连接后 traits 会永久停在旧 brain 的值上。
  //
  //   契约：**凡调 bindBrainDeps 且 trigger 已就绪，这句负责刷；
  //   启动路径的补刷在下面 trigger 赋值之后**（见 whenReady 内的显式调用）。
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
// 🔴 D-7：主动搭话的审计出口。
//   必须在**模块顶层**声明，不能直接用 app.whenReady() 里的 agentAuditLog：
//   那是个块级 const，而 proactive-declined 的处理器是模块顶层的闭包，
//   引用它会在事件触发时抛 TDZ 错（不是风格问题，是运行时崩溃）。
//   显式初始化为 null，不留 undefined —— 本仓踩过「字段在但从不赋值，
//   下一个人读到 undefined 以为没有待办」的坑。
/* ────────────────────────────────────────────────────────────────
 * 🔴 D-10：把「她的想法」变成提案 —— 十五轮以来第一次真的动手
 * ────────────────────────────────────────────────────────────────
 *
 * ## 三条硬约束（越界即打回）
 *
 *   1. **复用 evaluateProposal / proposeInternal，不许复刻。**
 *      registerAgentIpc 返回的是**已绑定本进程 policy/budget** 的实例。
 *      在这里重写「形态校验 → 授权 → 预算 → 建案 → 进注册表」= 两套判定。
 *      注册表登记、逐出、授权作废这些**必须单点**，漂移的那一侧就是漏洞。
 *
 *   2. **scope 只能在这里拼，渲染端不许参与。**
 *      意图只给出 `hint`（文件名），绝对路径由本函数拼。
 *      若让渲染端传路径，scope 白名单当场形同虚设（D-3 顶替攻击就是这一族）。
 *
 *   3. **失败静默降级，绝不砸掉她这一轮的回话。**
 *      这是第一次把 Agent 接进生产对话路径；任何异常都只能记日志，不能外抛。
 *
 * ## 用户拍板：沙盒内自由（方案 A'）
 *
 *   用户原话：「我想让她自由一点，毕竟，我们要赋予她生命。」
 *   经讨论，接受的是这个版本的「自由」——
 *     写什么内容 ✅ 完全自由 ｜ 什么时候提 ✅ 完全自由
 *     **文件名 ✅ 完全自由** ｜ 写到哪：沙盒内自由，外面不行
 *
 *   ⇒ **不对 hint 做任何白名单/重命名/净化**（除下面的安全边界）。
 *     她想叫「我的日记.md」还是「1234.txt」都随她。
 *
 * ⚠️ 为什么这个函数在**模块顶层**而不是 whenReady 里：
 *   调用它的是 chat-send 的 handler，那个 handler 在模块顶层注册（ipcGuard.handle）。
 *   若把本函数定义在 whenReady 块内，顶层闭包引用它会抛 ReferenceError ——
 *   实测踩过（"tryBuildProposalFromIntent is not defined"，4 项门禁红）。
 *   依赖通过模块级 agentBuildDeps 传入，理由见其声明处注释。
 */
function tryBuildProposalFromIntent() {
  // 🔴🔴 D-12：**本函数当前一律不建案** —— 通路 B 暂缓（用户拍板 + 反重力复核裁定）。
  //
  //   ## 这个函数原本要做什么
  //     处理「用户让她写某个文件」：判定命中 → 拼 scope → 建案 → 亮卡。
  //
  //   ## 为什么停掉
  //     这类意图**只有 scope（文件名），没有 content（要写什么）**。
  //     建出来会是一个**空内容的案**：用户点授权 → 执行器 CONTENT_EMPTY 拒写
  //     → 用户得到一张白弹的卡片和一句错误。
  //     **不留半截功能**比「先跑起来」重要 —— 半截功能会让人以为它通了。
  //
  //   ## 通路 B 的正解（留待后续，两条都不草率）
  //     · 内容来自**会话记忆提炼**（把最近聊的整理成档）
  //     · 内容来自**先读沙盒里那个文件再改写**（依赖尚未实现的 read 通路）
  //
  //   ## ⚠️ 与通路 A 的分工（别混）
  //     通路 A（wantToLeaveSomething）走 maybeAskForSelfNote 的**独立建案路径** ——
  //     它在建案前就用 askForSelfNote 拿到了她写的内容并暂存，
  //     所以那条路能建案、也能落盘，**不经过本函数**。
  //
  //   ## 恢复条件
  //     接上内容来源那天，把下面那个 return null 换成原来的建案逻辑即可
  //     （原始实现见 D-10 提交的 git 历史）。
  //     在那之前它只是**如实拒绝**，不是静默吞掉 —— 日志能看到判定命中过。
  try {
    const intent = brain && brain._pendingAgentIntent;
    if (intent && intent.shouldPropose === true) {
      console.log('[Agent] 通路 B 判定命中但暂无内容来源，按设计不建案:', String(intent.hint || '').slice(0, 60));
    }
    return null;
  } catch (err) {
    // 绝不外抛：它挂在 chat-send 的收尾上，崩了会砸掉她这一轮的回话。
    return null;
  }
}




let proactiveAuditLog = null;
// 🔴 D-10：主进程建案所需的两样东西，从 whenReady 的块级作用域提升到模块级。
//   原因：调用点 `chat-send` 的 handler 在**模块顶层**注册（ipcGuard.handle），
//   而 agentIpc / agentSandbox 是在 app.whenReady 里创建的块级 const ——
//   顶层闭包直接引用它们会抛 TDZ（本仓已踩过同型坑：agentAuditLog → proactiveAuditLog）。
//
//   ⚠️ 两者在 whenReady 里赋值完成之后才会被 chat-send 用到
//     （chat-send 只可能在窗口就绪、用户说话时触发），所以不存在"用了还没赋值"的窗口。
//     若为 null 则建案路径整体跳过 —— 静默降级，绝不抛。
let agentBuildDeps = null;

/* ────────────────────────────────────────────────────────────────
 * 🔴 D-11：她想留下点什么 —— 那个文件的内容从哪来
 * ────────────────────────────────────────────────────────────────
 *
 * ## 为什么需要这个函数
 *
 *   D-10 接通了「建案 → 卡片 → 执行」，但 content 一直没有来源。
 *   本函数补上它：**她为自己组织一句话**，那句话就是写进沙盒的内容。
 *
 * ## 与 tryBuildProposalFromIntent 的分工
 *
 *   那个负责「用户让她做某事」（来源是用户的输入）；
 *   这个负责「她自己想留下什么」（来源是她自己的状态）。
 *   两者最终都走同一条建案路径（proposeInternal），**不各写一份**。
 *
 * ## 三条硬性边界
 *
 *   1. **她的意图必须是 wantToLeaveSomething。**
 *      不是「安静久了想说话」—— 那是 idleness 两档，阈值低得多（45/90 分钟），
 *      它们**不触发本函数**。这条防止「她每次安静久了都写文件」。
 *   2. **她说「不」就不建案。** askForSelfNote 已判定，这里拿到 null 直接返回。
 *   3. **全程静默。** 旁路异常一律吞掉，不影响任何别的东西。
 *
 * ⚠️ 本函数**不 await**（调用方 void 起 promise）：她已经说完了，
 *   留下东西不该让用户多等一次 LLM 往返。
 */
function maybeAskForSelfNote() {
  try {
    const deps = agentBuildDeps;
    if (!deps || !deps.agentSandbox) return;
    const intent = brain && brain._pendingAgentIntent;
    // 边界①：只有「想留下点什么」才走这条路
    if (!intent || intent.kind !== 'wantToLeaveSomething') return;

    void (async () => {
      try {
        const note = await brain.askForSelfNote({ intentKind: intent.kind });
        // 边界②：她说不留 → note 为 null → 不建案。这是合法结果，不是失败。
        if (!note || !note.content) return;

        const rawHint = String(intent.hint == null ? '' : intent.hint).trim();
        if (!rawHint) return;
        if (path.isAbsolute(rawHint)) return;
        if (/[\\/]/.test(rawHint)) return;
        if (rawHint === '.' || rawHint === '..') return;
        if (/\.\./.test(rawHint)) return;
        if (rawHint.length > 200) return;

        const scope = path.join(deps.agentSandbox, rawHint);
        const evaluated = deps.agentIpc && typeof deps.agentIpc.evaluateProposal === 'function'
          ? deps.agentIpc.evaluateProposal({ capability: 'workspace.write', scope, reason: intent.reason })
          : { ok: false, code: 'EVALUATOR_UNAVAILABLE' };
        if (!evaluated || evaluated.ok !== true) return;

        const res = typeof deps.agentIpc.proposeInternal === 'function'
          ? deps.agentIpc.proposeInternal({ capability: 'workspace.write', scope, reason: intent.reason }, 'main')
          : null;
        if (res && res.ok && res.proposal) {
          // 内容由渲染端在授权后随 agent:execute 提交（见 preload 的 execute 参数）；
          //   这里把它暂存在提案旁，等用户点授权时由渲染端取用。
          //   ⚠️ 不塞进提案对象（D-9 定的：动机独立第二参数，同理内容也不进 raw）。
          pendingSelfNoteContent.set(res.proposal.id, note.content);
          deps.broadcastToWindows('agent-proposal-available', { proposalId: res.proposal.id });
        }
      } catch (err) {
        // 边界③：静默。
      }
    })();
  } catch (err) {
    // 连同步段都不许抛 —— 它挂在 chat-send 的收尾上。
  }
}

/** 提案 id → 她想留下的那句话。用户点授权后由 agent:execute 取用，**取完即删**。
 *
 *  ⚠️ 为什么取用即删：一条内容只应对应一次写入。
 *     留着重放时可能被反复写进文件 —— 内容是她的，不该被重复使用。 */
const pendingSelfNoteContent = new Map();

/** 供 agent-ipc 的 execute 通道取用（read-and-delete）。取不到返回 null。 */
function takeStashedContent(proposalId) {
  const id = String(proposalId || '');
  if (!id || !pendingSelfNoteContent.has(id)) return null;
  const v = pendingSelfNoteContent.get(id);
  pendingSelfNoteContent.delete(id);
  return v;
}

const motionUi = { bubble: false, talking: false, chatBusy: false, hidden: false };
let keyEncrypted = false;   // 面板要如实显示「已加密 / 明文降级」，不吹安全状态
let researchService = null;
let creativeStore = null;
let creativeSession = null;

// SEC-01: 所有 IPC 统一经 sender/frame/URL 三重校验（src/ipc-guard.js）；
// child frame / 外部 URL / 其他 webContents 一律拒绝，错误信息只有 UNTRUSTED_RENDERER。
const ipcGuard = createIpcGuard({ ipcMain, getMainWindow: () => win, appDir: __dirname,
  // v1.0 方案二：独立对话窗与主窗同为应用自建受信窗（其余一律 UNTRUSTED_RENDERER）
  getTrustedWebContents: () => [win, chatWin].filter(w => w && !w.isDestroyed()).map(w => w.webContents) });

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
  // v3.1 修复「显示深度休眠却在桌面漫步」：睡眠判定改为双源守卫。
  // tracker.sleepMode 只活在内存里，internalRegulation.isSleeping 才是跨重启持久的，
  // 冷启动或状态分裂时两边可能不一致 —— 任一为真都必须阻断行走，
  // 绝不允许她在自称沉睡时还在桌面上闲逛。
  const brainIsSleeping = !!(brain && brain.internalRegulation && brain.internalRegulation.isSleeping);
  const isSleeping = !!(tracker && tracker.sleepMode) || brainIsSleeping;
  // v2.0 睡相广播：睡眠态随既有闸门同步给各窗（零新定时器）
  broadcastToWindows('sleep-state', { sleeping: isSleeping });
  if (!motion) return;
  const blocked = dragging || motionUi.bubble || motionUi.talking
    || motionUi.chatBusy || motionUi.hidden || isSleeping
    || (chatWin && !chatWin.isDestroyed() && chatWin.isVisible());   // 对话窗在场 = 正在相处，闲逛退下
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
      if (win && !win.isDestroyed() && !dragging) setPinnedBounds(p.x, p.y);
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
  const tx = Math.round(x + dx), ty = Math.round(y + dy);
  setPinnedBounds(tx, ty);
  reconfigureMotion();
});

ipcGuard.on('motion-ui-state', (e, state = {}) => {
  for (const k of Object.keys(motionUi)) {
    if (typeof state[k] === 'boolean') motionUi[k] = state[k];
  }
  syncMotionBlock('ui-state');
});

ipcGuard.handle('motion-status', () => motion ? motion.snapshot() : null);

// P1-D: 透明区点击穿透 (forward: true 允许在渲染层动态捕获鼠标交互区)
ipcGuard.on('set-ignore-mouse-events', (e, ignore) => {
  if (win && !win.isDestroyed() && typeof win.setIgnoreMouseEvents === 'function') {
    win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  }
});

function togglePinState() {
  if (!win) return false;
  const on = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(on, 'screen-saver');
  return on;   // 返回新状态，菜单文案才能区分「已置顶/已取消置顶」
}
ipcGuard.handle('toggle-pin', () => togglePinState());

// v1.0 状态要准确：菜单文案跟随真实置顶态（不靠本地猜）
ipcGuard.handle('pin-state', () => ({
  ok: true,
  pinned: !!(win && !win.isDestroyed() && win.isAlwaysOnTop())
}));

function setSafeWindowSize(targetWin, w, h) {
  if (!targetWin || targetWin.isDestroyed()) return;
  if (typeof targetWin.setResizable === 'function') targetWin.setResizable(true);
  targetWin.setSize(w, h);
  if (typeof targetWin.setResizable === 'function') targetWin.setResizable(false);
  intendedSize = { w, h };   // 记住「本该的尺寸」，一切平移用它钉框
}

/* v1.0 漂移真凶处决（行车记录仪取证实锤）：Windows 125% DPI 下每次
   win.setPosition 都会被 DWM 物理舍入偷涨 1px —— 拖拽几百次 mousemove
   就把窗口撑大几百像素，她 left:50% 的中心点随之狂奔（「漂移」的真相）。
   一切平移统一走 setBounds 显式扣死宽高（反重力隔离实验：膨胀率归零），
   尺寸取「意图尺寸」而非硬编码，右键缩放级别原样保住。 */
let intendedSize = { w: layout.BASE_W, h: layout.BASE_H };
function setPinnedBounds(x, y) {
  if (!win || win.isDestroyed()) return;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: intendedSize.w, height: intendedSize.h });
}

function getWorkArea(x, y) {
  try {
    const display = (typeof screen.getDisplayNearestPoint === 'function')
      ? screen.getDisplayNearestPoint({ x, y })
      : screen.getPrimaryDisplay();
    return display.workArea || { x: 0, y: 0, ...display.workAreaSize };
  } catch {
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
}

// v1.0 像素换代：用户侧缩放已退役（渲染端零调用）；通道保留为窗体机械，
// 日后像素「原生 × 整数倍」缩放复用；行为测试见 main.test 边界族
ipcGuard.on('resize-pet', (e, factor) => {
  if (!win) return;
  const [w, h] = win.getSize();
  const next = layout.nextSize(w, Number(factor) || 1);
  if (next.w === w && next.h === h) return;   // 已经到边界，不用再动
  const [x, y] = win.getPosition();
  // 脚钉住：桌宠是 bottom 定位，只改尺寸会让她在放大时往屏幕底下陷。
  let targetY = layout.anchorBottom(y, h, next.h);
  // 屏幕工作区保护：防止窗口顶部顶出屏幕上沿，导致记录面板关闭按钮 (x) 被推出屏幕不可见
  const area = getWorkArea(x, y);
  if (targetY < area.y) targetY = area.y;
  win.setPosition(x, targetY);
  setSafeWindowSize(win, next.w, next.h);
  reconfigureMotion();
  syncMotionBlock('resize');
});

/* v1.0 方案二：chat-viewport 通道已退役 —— 对话迁独立窗（chat-window-*），
   主窗回归 340×480 纯粹态，扩容/顶边钳位等配套随之收档。 */

/* ---------- 独立对话窗（v1.0 方案二：真自由） ----------
她的窗回归 340×480 纯粹态；对话窗是独立系统窗口：全屏自由拖拽、跨显示器、
位置与大小记忆、hide() 只隐藏不销毁（重开秒回）。
出生位智能邻居：默认她右侧 20px，放不下自动翻转到左侧，再钳进工作区。 */
let tray = null;   // v1.0 系统托盘（模块级持有，防 GC 回收）
let chatWin = null;
let chatWinBounds = null;
let appQuitting = false;
const CHAT_WIN_W = 380, CHAT_WIN_H = 520;

function loadChatBounds() {
  try {
    const raw = require('fs').readFileSync(require('path').join(app.getPath('userData'), 'chat-window.json'), 'utf8');
    const b = JSON.parse(raw);
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch (e) { /* 无记忆 → 默认 */ }
  return null;
}
function saveChatBounds() {
  try {
    if (chatWin && !chatWin.isDestroyed()) {
      chatWinBounds = chatWin.getBounds();
      require('fs').writeFileSync(require('path').join(app.getPath('userData'), 'chat-window.json'), JSON.stringify(chatWinBounds));
    }
  } catch (e) { /* 记忆失败不致命 */ }
}
function chatBirthPosition() {
  const cw = (chatWinBounds && chatWinBounds.width) || CHAT_WIN_W;
  const ch = (chatWinBounds && chatWinBounds.height) || CHAT_WIN_H;
  const [px, py] = win.getPosition();
  const [pw, ph] = win.getSize();
  const area = getWorkArea(px, py);
  let x = px + pw + 20;
  if (x + cw > area.x + area.width - 8) x = px - cw - 20;   // 右边放不下 → 翻转到她左侧
  let y = py + Math.max(0, Math.round((ph - ch) / 2));
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - cw - 8));
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - ch - 8));
  return { x: Math.round(x), y: Math.round(y), width: cw, height: ch };
}
function createChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) return chatWin;
  chatWinBounds = loadChatBounds();
  const b = chatBirthPosition();
  chatWin = new BrowserWindow({
    title: '对话',
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: false, backgroundColor: '#10121b',
    alwaysOnTop: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  chatWin.loadFile('chat.html');
  ipcGuard.attachNavigationGuard(chatWin.webContents);
  chatWin.on('move', saveChatBounds);
  chatWin.on('resize', saveChatBounds);
  chatWin.on('close', (e) => {
    saveChatBounds();
    if (!appQuitting) {
      e.preventDefault();
      chatWin.hide();   // 只隐藏不销毁（重开秒回）
      broadcastToWindows('chat-window-hidden', {});
    }
  });
  return chatWin;
}
ipcGuard.handle('chat-window-open', () => {
  const w = createChatWindow();
  if (!w.isVisible()) w.show();
  w.focus();
  return { ok: true };
});
// v1.0 快捷呼出（中键双击 / Alt+Shift+C）：切换对话窗显示 —— 隐藏只收不销毁（安全退出链不受扰）
function showChatWindow() {
  const w = createChatWindow();
  if (!w.isVisible()) w.show();
  w.focus();
}
function toggleChatWindow() {
  const w = createChatWindow();
  if (w.isVisible()) {
    w.hide();
    broadcastToWindows('chat-window-hidden', {});
    return { ok: true, visible: false };
  }
  w.show();
  w.focus();
  return { ok: true, visible: true };
}
ipcGuard.handle('chat-window-toggle', () => toggleChatWindow());
function broadcastToWindows(channel, payload) {
  for (const w of [win, chatWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
ipcGuard.handle('chat-busy', (e, p = {}) => {
  // 双窗同步（方案二）：对话窗的对话生命周期广播给主窗 —— 她身边同步思考/表情/收气泡
  broadcastToWindows('chat-busy', { busy: !!p.busy, state: p.state || null });
  return { ok: true };
});
ipcGuard.handle('chat-window-home', () => {
  if (chatWin && !chatWin.isDestroyed()) chatWin.setBounds(chatBirthPosition());
  return { ok: true };
});
ipcGuard.handle('chat-window-close', () => {
  if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) chatWin.hide();
  broadcastToWindows('chat-window-hidden', {});   // 主窗收口 talking 态
  return { ok: true };
});

/* v1.0 设置面板扩容（用户拍板：面板太小、做大）：打开 440×680 / 关闭回 340×480。
   复用 layout.anchorBottom 钉住下边缘（她脚不离地）；缩放已解耦，扩窗不放大她（DWM 战红利）。 */
const PANEL_W = 440, PANEL_H = 680;   // 默认面板尺寸；可按面板类型传宽（记录 520）
ipcGuard.handle('panel-viewport', (e, open, opt = {}) => {
  if (typeof open !== 'boolean') return { ok: false, error: 'INVALID_OPEN' };
  if (!win || win.isDestroyed()) return { ok: false, error: 'NO_WINDOW' };
  // 不信渲染端：尺寸钳进合法区间（宽 340..640 / 高 400..760）；tw/th 避让下方 [w,h] 解构
  const tw = Math.min(640, Math.max(layout.BASE_W, Math.round(opt.w) || PANEL_W));
  const th = Math.min(760, Math.max(400, Math.round(opt.h) || PANEL_H));
  const target = open ? { w: tw, h: th } : { w: layout.BASE_W, h: layout.BASE_H };
  const [w, h] = win.getSize();
  if (w === target.w && h === target.h) return { ok: true, w, h, changed: false };
  const [x, y] = win.getPosition();
  let targetY = layout.anchorBottom(y, h, target.h);
  const area = getWorkArea(x, y);
  if (targetY < area.y) targetY = area.y;
  // v1.0 补 X 钳位：右缘扩宽不许溢出屏幕（用户实测：左半截被切走）
  let targetX = x;
  if (targetX + target.w > area.x + area.width - 8) targetX = area.x + area.width - target.w - 8;
  if (targetX < area.x + 8) targetX = area.x + 8;
  win.setPosition(targetX, targetY);
  setSafeWindowSize(win, target.w, target.h);
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
ipcGuard.on('activity', (e, type, details) => {
  if (tracker) tracker.record(type, undefined, details);
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
      broadcastToWindows('chat-delta', delta);   // 流式增量：她身边与对话窗都要听得见
    }, { proactive, proactiveHint: offer && offer.hint,
         // 🔴 D-7：把「她想往哪说」透传给 brain。
         //   ⚠️ 不做类型/内容校验：brain 那一侧有类型守卫
         //   （见 brain.js 的 selfIntent 三条边界），两处各做一遍判定迟早漂移。
         //   这里刻意**只传**，不加工 —— 加工过的东西会让人误以为主进程保证过。
         selfIntent: offer && offer.selfIntent });
    // 主动搭话真的说出口了才记账；被渲染端礼貌闸门拦下时压根不会走到这
    if (proactive && trigger) trigger.commit(offer);
    // 换装是在 brain 里执行的（提案→真实状态→结果写回历史），
    // 这里只在真的换上了时把新图层推给渲染端，
    // 保证屏幕上穿的、系统提示里说的、历史里记的三者是同一件事。
    if (res.wearChanged) pushWardrobe();
    // v0.9.9 意志层：关窗后特质可能演进，刷新主动性权重（只动权重，不动闸门）
    if (res.windowClosed && trigger && brain && brain.subjectState) trigger.updateTraits(brain.subjectState.values);
    // 🔴 v1.0 她说完了 → 通知对话窗重新对账。
    //
    //   ## 为什么必须在这里通知，而不是靠对话窗自己刷新
    //
    //   对话窗的数据层是 ChatStore.load()（ui-chat-store.js），它**只在页面加载时跑一次**
    //   （chat.js:122）。此后唯一的刷新入口是 chat-send 自己的收尾对账 ——
    //   也就是说**只有「用户发消息」这一条路会刷新对话窗**。
    //
    //   但她开口的路远不止那一条：
    //     · 主动搭话（pet.js 收到 proactive-offer → runChat）
    //     · 睡眠后醒来自己开口（tracker.wakeUp → brain 继续）
    //   这两条都发生在**桌宠窗口**，对话窗全程不知情。
    //   用户看到的现象就是：她气泡里说了，对话框里没有，
    //   **必须把软件退出重开才看得到**（重开 = chat.js:122 重跑一次 load）。
    //
    //   ⚠️ 刻意**无条件广播**，不区分是否 proactive：
    //     若只给主动搭话加唤醒那条另开分支，以后再新增「她自己决定说话」的路径
    //     一定会漏 —— 而漏了就是「她说了但对话框里查无此话」，
    //     那种 bug 最难被发现（数据在盘上，只是看不见）。
    //   一处广播覆盖全部路径，是这里能取的最简形态。
    //
    //   ⚠️ 只发信号，不把 res.text 塞过去：对话窗必须自己回查 memory.history
    //   （单一事实源，见 ui-chat-store.js 头注释）。这里塞文本等于造第二份真相，
    //   将来流式中断/改写/回滚都会对不上。
    broadcastToWindows('chat-history-changed', { reason: proactive ? 'proactive' : 'chat' });

    // 🔴 D-10：她说完之后，看这一轮有没有命中「提案意图」。
    //
    //   位置刻意在这里：**在她回话成功之后**。
    //   · 若判定没过（或被闸门拦），brain 里那个字段是 null，本调用直接返回；
    //   · 建案失败只记日志、绝不抛 —— 第一次把 Agent 接进生产对话路径，
    //     任何异常都不能砸掉她这一轮的回话（tryBuildProposalFromIntent 内部已包死）。
    //
    //   ⚠️ 本轮**不打开 agentTriggerEnabled**：它仍是默认关，
    //     所以真实运行时这条链大概率不会自己走通 —— 那是设计如此，
    //     用户拍板「先验证链路，再决定开不开」。
    tryBuildProposalFromIntent();

    // 🔴 D-11：如果她想留下点什么（静默 ≥120 分钟才会成立），追一次专门调用。
    //
    //   ⚠️ 三个刻意选择：
    //     1. **不 await**（`void` 起一个独立 promise）—— 她这句话已经说完了，
    //        留下东西是旁路，绝不能让用户多等一次 LLM 往返。
    //     2. **只在 wantToLeaveSomething 时跑**。这个意图的阈值（120 分钟）
    //        远高于 idleness 两档，所以绝大部分主动搭话根本不会走到这里。
    //     3. **失败静默**。她说不出、不想留、调用出错 —— 都是 null，不建案。
    //        「她说不想留」是**合法结果**，不是错误（见 brain.askForSelfNote 判据 1）。
    if (!proactive) maybeAskForSelfNote();

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

// 🔴 D-7：她说完（或被礼貌闸门拒了）之后的收尾。
//
// ## 这个通道是「拒绝后不追问」的落点
//
//   persona.js:29：「安静不等于孤独，主动搭话可以，装可怜不行。」
//   「不数着时间等你」意味着——用户没理她，她不能一直想问。
//   这条通道就是那句「没理」的落地：拒绝一次，按冷却退回去。
//   🔴 这比「她会主动开口」更重要，因为**这才是主体的证据**：
//   工具不会在意你拒绝它；主体会。
ipcGuard.on('proactive-declined', (e, offer) => {
  // 🔴 校验 offer：不能照单全收。
  //   之前是无参接收，谁发都重排计时器 —— 那意味着渲染端的一个 bug
  //   （或在 devtools 里手调）就能让她的主动搭话被无限加速：
  //   反复发 declined，每次都重排到 45 秒后，而真正出提案的那条路径
  //   还要再过冷却 —— 两套计时器打架，她会越说越勤。
  //
  //   ⚠️ 刻意**不记录拒绝次数**：本轮要锁的是「不接受追问」，
  //   而「拒绝几次之后她还会不会开口」是另一个量级的问题——
  //   把它做进本轮会把一个可调参数变成安全边界。
  //   现阶段：拒绝一次 = 退一个完整冷却，不升级、不重复。
  //
  //   offer 为 null 也是合法输入：渲染端可能连提案都没拿到
  //   （busy/streaming 时连闸门都没进，见 pet.js tryProactive），
  //   那同样属于「现在别说」，必须收干净，不能静默停摆调度。
  const hasOffer = !!offer && typeof offer === 'object' && !Array.isArray(offer);
  const wellFormed = hasOffer
    && (offer.kind === 'poke' || offer.kind === 'idle')
    && typeof offer.at === 'number' && Number.isFinite(offer.at)
    && validOffer(offer);

  if (!hasOffer) {
    // 🔴 拿不出提案就不知道自己在拒什么 ⇒ 按「最短退回」处理：
    //   不给加速留缝（想要更快只能靠真实开口，走commit 那条路）。
    scheduleProactiveCheck(COOLDOWN_MS);
    return;
  }
  if (!wellFormed) {
    // 提案存在但**过期或非法** —— 这是重放或伪造。
    //   过期的提案不该驱动任何重排决策，但要仍然收尾（否则调度停摆），
    //   且**必须记审计**：这是本仓D-4~D-6 一贯要求的，
    //   「拒绝也要留痕」的价值一半就在这里。
    console.warn('[Proactive] 收到非法或已过期的 declined 提案，已按最短冷却退回');
    // 🔴 审计可能为 null（whenReady 未完成时事件就来了）—— 必须判空，
    //   审计写不进去绝不能反过来挡住收尾。
    if (proactiveAuditLog) {
      try {
        proactiveAuditLog.append({
          channel: 'proactive-declined',
          outcome: 'rejected',
          code: 'INVALID_OR_EXPIRED_OFFER',
          capability: null,
          via: 'renderer',
        });
      } catch { /* 审计写不进去也不能挡住拒绝收尾 */ }
    }
    scheduleProactiveCheck(COOLDOWN_MS);
    return;
  }
  // 正常拒绝：退一个完整冷却。
  scheduleProactiveCheck(COOLDOWN_MS);
});

ipcGuard.handle('proactive-check', () => {
  // v2.0 排雷：睡着绝不梦游提案；生理断电先于一切提案逻辑（静默沉睡，零台词）
  // v3.1 双源守卫：tracker.sleepMode 在内存、isSleeping 跨重启持久，两边可能分裂，
  // 任一为真都算睡着 —— 宁可少提一次案，绝不让她自称沉睡时还主动搭话。
  if (brain && brain.checkPhysiologicalCollapse && brain.checkPhysiologicalCollapse()) return null;
  if (brain && brain.tracker && brain.tracker.sleepMode) return null;
  if (brain && brain.internalRegulation && brain.internalRegulation.isSleeping) return null;
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

// v1.0 时区真源（拍板 b）：birthTimezone 固化于 self-ledger；渲染层只读投影 + 平移入口
ipcGuard.handle('self-timezone', (e, clientTz = '') => {
  if (!brain || !brain.selfLedger) return { ok: false, error: 'NO_LEDGER' };
  const ledger = brain.selfLedger;
  if (!ledger.birthTimezone && ledger.adoptBirthTimezone) ledger.adoptBirthTimezone(clientTz);
  return { ok: true, birthTimezone: ledger.birthTimezone || null, birthAt: Number.isFinite(ledger.birthAt) ? ledger.birthAt : null };
});

// v1.0 梦境独立模块（只读）：梦境史开机从归档重建于内存，这里只做投影（不重读大档）；
// 会变得很多很多 —— 最新在前，预留分页钩子。
ipcGuard.handle('dream-list', () => {
  const all = (brain && brain.dreamHistory) || [];
  const dreams = all.map((d) => ({   // 升序：第一次、第二次、……
    dreamId: d && d.dreamId,
    windowNo: d && d.windowNo,
    generatedAt: d && d.generatedAt,
    epistemicStatus: d && d.epistemicStatus,
    text: (d && d.text) || (d && d.payload && (d.payload.content || d.payload.text)) || ''
  }));
  return { ok: true, total: all.length, dreams };
});

// v1.0 §4.7 只读视图数据口：词汇表 + 预期账本 + 生命看板（观察层只读，不写任何数据、不碰完整性哈希）
// 护栏：① 经历链只读尾锚计数（绝不 readAll 大档）② 守信率除零给 null（UI 出破折号）③ 单通道聚合下发
ipcGuard.handle('life-mechanisms', () => {
  const memData = (brain && brain.memory && brain.memory.data) || {};
  const lexicon = Array.isArray(memData.lexicon) ? memData.lexicon : [];
  const expectations = Array.isArray(memData.expectations) ? memData.expectations : [];
  const fulfilled = expectations.filter((x) => x && x.status === 'fulfilled').length;
  const broken = expectations.filter((x) => x && x.status === 'broken').length;
  const promiseFidelity = (fulfilled + broken) > 0 ? fulfilled / (fulfilled + broken) : null;   // 除零守卫
  const reusedWords = lexicon.filter((x) => x && Array.isArray(x.uses) && x.uses.length > 0).length;
  let archiveChain = 0;
  try {
    // 护栏 1：只读尾部锚点的小 JSON（append 时同步写 archiveSeq），不重读 experiences.jsonl
    const tail = brain && brain.experiencesArchive && brain.experiencesArchive._readTailAnchor
      ? brain.experiencesArchive._readTailAnchor() : null;
    const seq = tail && tail.anchor && tail.anchor.archiveSeq;
    archiveChain = Number.isFinite(seq) ? seq : 0;
  } catch (e) { archiveChain = 0; }
  let vitals = null, development = null, cognition = null;
  try {
    const reg = brain && brain.internalRegulation && brain.internalRegulation.getState();
    if (reg) vitals = {
      energy: reg.energy, restPressure: reg.restPressure,
      arousal: reg.arousal, isSleeping: !!reg.isSleeping
    };
  } catch (e) { /* 只读失败给 null，UI 显示破折号 */ }
  try {
    const canal = require('./src/canalization');
    const m = canal.getCanalizationMetrics(memData.windowNo || 1);
    development = { stage: m.stage, plasticity: m.plasticityMultiplier };
  } catch (e) { /* 同上 */ }
  try {
    const ledger = brain && brain.selfLedger;
    if (ledger && ledger.getEntryMetrics) {
      const TRAITS = ['quiet_preference', 'social_initiative', 'attachment_need', 'vitality', 'philosophical_curiosity'];
      const ms = TRAITS.map((t) => ledger.getEntryMetrics(t)).filter(Boolean);
      if (ms.length) {
        cognition = {
          confidence: ms.reduce((a, x) => a + (Number(x.confidence) || 0), 0) / ms.length,
          revisionPressure: ms.reduce((a, x) => a + (Number(x.revisionPressure) || 0), 0) / ms.length
        };
      }
    }
  } catch (e) { /* 同上 */ }
  return {
    ok: true, lexicon, expectations, vitals, development, cognition,
    relations: { promiseFidelity, fulfilled, broken, words: lexicon.length, reusedWords, archiveChain }
  };
});

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
    // 🔴 bedside 必须透出：她睡着时你留的消息在对话窗要显示成「留置」样式，
    //   而不是伪装成一条已被回应的普通发言。不给这个字段，渲染层就只能靠猜
    //   （比如「下一条不是 assistant ⇒ 这条没人接」），那是推断不是事实。
    bedside: m.bedside === true,
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

function persistCfg(next, opts = {}) {
  const r = secure.saveConfig(getSS, app.getPath('userData'), next,
    (disk) => save(app.getPath('userData'), next, disk),
    null, opts);
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
  const trimmed = String(key || '').trim();
  const next = { ...cfg, apiKey: trimmed };
  let persisted = null;
  const res = swapBrain({
    oldBrain: brain,
    oldCfg,
    nextCfg: next,
    createCandidate: (c) => new Brain(app.getPath('userData'), c),
    bindCandidate: bindBrainDeps,
    persistCfg: (c) => { persisted = persistCfg(c, { clearKey: !trimmed }); }
  });
  if (!res.ok) return { ok: false, error: res.error };

  // 切换主引用
  cfg = res.cfg;
  brain = res.brain;
  keyEncrypted = persisted.encrypted;

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
  // 🔴 D-8a：补刷启动时的 traits。
  //
  //   bindBrainDeps 里那句 updateTraits 在这一行**跑不到**（那时 trigger 还是 null），
  //   于是引擎的 this.traits 会一直停在 null，直到用户关窗才被 main.js 的关窗刷新救回来。
  //   代价是 D-7 的三档特质意图（attachment_high / curiosity_high / vitality_high）
  //   在整个不关窗的会话里**一次都不会触发**，她只剩 idleness 两档。
  //
  //   放在赋值之后是因为 updateTraits 需要一个已存在的引擎实例；
  //   这也正是 bindBrainDeps 不能承担此事的原因（它服务热替换，那边 trigger 已存在）。
  //
  //   ⚠️ 别把 traits 传进 TriggerEngine 的构造 opts 当替代方案：
  //   构造期拿到的特质与 brain 的 subjectState 绑定时机不同，
  //   且那样会让「谁负责刷 traits」变成隐式契约 —— 正是本 bug 的成因。
  if (brain && brain.subjectState) trigger.updateTraits(brain.subjectState.values);
  assetReport = checkAssets(__dirname, CATALOG);
  if (assetReport && (!assetReport.ok || assetReport.warnings.length)) {
    for (const w of assetReport.warnings) console.warn('[AssetCheck]', w);
  }
  researchService = new ResearchService(app.getPath('userData'));
  registerResearchIpc(ipcGuard, researchService, { dialog }); // SEC-01: research IPC 同样经 sender 校验
  // v1.0 D-1/D-3/D-4/D-5：Agent 通道（SEC-01 同样经 sender 校验）。
  // D-4 起挂 6 条，D-5 加了取提案快照那条，共 7 条：
  //   查询状态 / 能力元数据 / **取待确认提案快照** / 提案受理 / 用户决策登记 / **执行** / 读审计。
  //
  // 🔒 硬边界演进（读这段前先看清自己在哪一阶段）：
  //   - D-1~D-4：三重默认关闭 —— killSwitch:true + allowed:[] + 未配 scope 根目录，
  //     执行器虽在，动不了任何用户文件。开启需显式三步。
  //   - **D-5 起：三重变成两重**（用户拍板启用桌面沙盒），见下方 D-5 区块。
  //     即便如此，仍有一层没动：**提案必须经用户逐次确认**（D-3 第四道闸门），
  //     执行期还要重跑全部闸门 —— 沙盒只是「能动的范围」，不是「自动能动的许可」。
  //
  // 🔒 process.execute 与 network.request **不在执行器可执行白名单内**，
  //   即便日后误加进 policy.allowed 也会在执行器入口被硬拒（用户 D-4 拍板永久不开）。
  const agentRegistry = new CapabilityRegistry();
  // 🔓 D-5：沙盒启用（用户 2026-10-06 拍板 1A/2A/3A）。
  //   这是 D-4 以来**第一次**真的放开写权限，所以三重默认关闭变成两重：
  //   killSwitch=false + allowed 列入能力 + 配沙盒根目录。
  //
  //   为什么放桌面而不是 userData（拍板时确认过）：用户一眼看得见、能自己清理，
  //   出问题时能自己翻。一个「可被Agent 覆写」的目录本就该被看见。
  //   ⚠️ 沙盒内文件一律视为可被 Agent 覆写 —— 这是给用户的正式约定，
  //   不是内部实现细节。渲染层展示沙盒路径时必须一并展示（见 agent-sandbox.js SANDBOX_NOTICE）。
  //
  //   ⚠️ 仍然关着的：process.execute 与 network.request 不在 allowed 里，
  //   且执行器入口另有硬拒（用户 D-4 拍板永久不开）。
  const agentSandbox = ensureSandboxDir(sandboxPathFor(app.getPath('desktop')));
  const agentPolicy = new PermissionPolicy({
    killSwitch: false,
    allowed: ['workspace.read', 'workspace.write'],
  });
  // scopeRoots 只配沙盒根：**绝不配整个桌面或整个 userData** ——
  //   那样一旦有一条路径判错，越界写入的范围就是用户的全部文件。
  agentPolicy.setScopeRoots('workspace.read', [agentSandbox]);
  agentPolicy.setScopeRoots('workspace.write', [agentSandbox]);
  console.log('[Agent] 沙盒已启用:', agentSandbox);
  const agentBudget = new ExecutionBudget();
  const agentAuditLog = new AuditLog({ dir: app.getPath('userData') });
  // 🔴 D-7：把审计出口交给模块顶层那个引用 —— 主动搭话的处理器是顶层闭包，
  //   拿不到 whenReady 的块级变量（引用会抛 TDZ）。详见 proactiveAuditLog 的声明处注释。
  proactiveAuditLog = agentAuditLog;
  const agentConfirmation = new UserConfirmationGate();
  // D-2 的写事务管理器在此创建：WAL 与备份都落在 userData，不与用户文件混同。
  //   D-4 起执行器写盘走它，故崩溃恢复自愈从此刻起才真正有意义。
  const agentTxnDir = app.getPath('userData');
  const agentTxn = new WriteTransactionManager({ dir: agentTxnDir });
  try {
    const healed = agentTxn.recoverPendingTransactions();
    if (healed.recovered > 0) {
      console.log(`[AgentTxn] 启动自愈：还原 ${healed.recovered} 笔被强杀的写入，失败 ${healed.failed.length} 笔`);
    }
    if (healed.failed.length) {
      //还原失败必须让人看得见 —— 静默失败等于让用户以为文件是原样的
      for (const f of healed.failed) console.error('[AgentTxn] 还原失败:', f.target, f.error);
    }
  } catch (err) {
    console.error('[AgentTxn] 启动自愈异常:', err && err.message);
  }
  // 🔴 D-10：主进程建案路径（「插电源」）。
  //
  //   这是十五轮以来**第一次**让「她的想法」有可能真的变成动作。
  //   前面建的全是安全（五道闸门、白名单、默认关），而到今天为止
  //   `_pendingAgentIntent` 4 处写 0 处读、`agent-audit.jsonl` 从未存在过。
  //
  //   刻意放在 registerAgentIpc 之前定义、之后引用 —— 它要用到注册返回的
  //   那个**实例化绑定了 policy/budget 的 evaluateProposal**（见 agent-ipc.js 尾部注释）。
  //   **绝不允许在这里复刻「形态校验 → 授权 → 预算」这三步**：两套判定等于没有判定。
  const agentIpc = registerAgentIpc(ipcGuard, {
    registry: agentRegistry, policy: agentPolicy, budget: agentBudget,
    auditLog: agentAuditLog, confirmation: agentConfirmation,
  }, {
    transactionManager: agentTxn, txnDir: agentTxnDir,
    // 🔴 D-9：动机来源求值器 —— 「她为什么想做这件事」。
    //
    //   **只读 trigger.selfIntent，不接线 _pendingAgentIntent。** 本轮只让动机可查，
    //   绝不在这里触发任何提案：`agentTriggerEnabled` 仍是默认关的三重关闭之一，
    //   这个函数只在**渲染端已经主动调了 propose 通道之后**才被调用一次，
    //   即它只能给已经发生的建案「补一个动机说明」，不能凭空造出建案。
    //
    //   ⚠️ 别把它写成 `() => brain._pendingAgentIntent` 之类：
    //   那是「该不该动手」的判定，属于下一轮，且必须先经用户确认路径拼接方案。
    //   本轮它只回答「已发生的这次，动机是什么」——答不出就 null。
    intentMotiveProvider: () => {
      const it = trigger && trigger.selfIntent;
      if (!it || typeof it !== 'object' || !Array.isArray(it.sources) || !it.sources.length) return null;
      return { sources: it.sources, kind: typeof it.kind === 'string' ? it.kind : null };
    },
  });

  /* ────────────────────────────────────────────────────────────────
   * 🔴 D-10：把「她的想法」变成提案 —— 第一次真的动手
   * ────────────────────────────────────────────────────────────────
   *
   * ## 三条硬约束（越界即打回）
   *
   *   1. **复用 evaluateProposal，不许复刻。**
   *      那个函数是 registerAgentIpc 返回的、**已绑定本进程 policy/budget** 的实例。
   *      在这里重写「形态校验 → 授权 → 预算」= 两套判定迟早漂移，攻击者挑漂移的那条走。
   *
   *   2. **scope 只能在这里拼，渲染端不许参与。**
   *      意图只给出 `hint`（文件名），绝对路径由本函数拼。
   *      若让渲染端传路径，scope 白名单当场形同虚设（D-3 顶替攻击就是这一族）。
   *
   *   3. **失败静默降级，绝不砸掉她这一轮的回话。**
   *      这是第一次把 Agent 接进生产对话路径；任何异常都只能记日志，不能外抛。
   *
   * ## 用户拍板：沙盒内自由（方案 A'）
   *
   *   用户原话：「我想让她自由一点，毕竟，我们要赋予她生命。」
   *   经讨论，接受的是这个版本的「自由」——
   *     写什么内容 ✅ 完全自由 ｜ 什么时候提 ✅ 完全自由
   *     **文件名 ✅ 完全自由** ｜ 写到哪：沙盒内自由，外面不行
   *
   *   ⇒ **不对 hint 做任何白名单/重命名/净化**（除下面的安全边界）。
   *     她想叫「我的日记.md」还是「1234.txt」都随她。
   */
  // 🔴 D-10：把建案所需的三样交给模块顶层的 tryBuildProposalFromIntent。
  //   必须是**赋值**而不是局部 const —— 调用点（chat-send handler）在模块顶层，
  //   它读的是这个模块级变量。
  agentBuildDeps = { agentIpc, agentSandbox, broadcastToWindows, takeStashedContent };

  createWindow();

  // v1.0 系统托盘（合流批）：16x16 图标 + 双击呼出对话 + 右键菜单；退出严守安全退出链
  try {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'pet.png'))
      .resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    const rebuildTrayMenu = () => {
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开对话 (Alt+Shift+C)', click: () => showChatWindow() },
        { label: '窗口置顶 (Alt+Shift+P)', type: 'checkbox',
          checked: !!(win && !win.isDestroyed() && win.isAlwaysOnTop()),
          click: () => { togglePinState(); rebuildTrayMenu(); } },
        { type: 'separator' },
        // 安全退出守卫：只准 app.quit()（before-quit → flushAll 全量落盘），严禁 win.destroy()
        { label: '退出', click: () => app.quit() }
      ]));
    };
    tray.on('double-click', () => showChatWindow());
    rebuildTrayMenu();
  } catch (e) {
    console.warn('[Tray] 托盘初始化失败（不影响主功能）:', e.message);
  }

  // v1.0 全局快捷键（合流批）：Alt+Shift+C 对话窗切换 / Alt+Shift+P 置顶切换
  try {
    const okC = globalShortcut.register('Alt+Shift+C', () => toggleChatWindow());
    if (!okC) console.warn('[Shortcut] Alt+Shift+C 注册被系统或其它应用占用');
    const okP = globalShortcut.register('Alt+Shift+P', () => { togglePinState(); });
    if (!okP) console.warn('[Shortcut] Alt+Shift+P 注册被系统或其它应用占用');
  } catch (e) {
    console.warn('[Shortcut] 全局快捷键注册失败（不影响主功能）:', e.message);
  }
});

app.on('before-quit', () => {
  appQuitting = true;   // 对话窗 close 拦截放行，允许真销毁
  if (brain && typeof brain.flushAll === 'function') brain.flushAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();   // v1.0 全局快捷键彻底注销
});

app.on('window-all-closed', () => {
  if (brain && typeof brain.flushAll === 'function') brain.flushAll();
  app.quit();
});
