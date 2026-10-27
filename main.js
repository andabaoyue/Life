const { app, BrowserWindow, ipcMain, screen, shell, Menu, Tray, globalShortcut, nativeImage, safeStorage, dialog, powerMonitor, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { load, save, tryLoad } = require('./src/config');
const { Brain } = require('./src/brain');
const { Wardrobe, CATALOG } = require('./src/wardrobe');
const { ActivityTracker } = require('./src/tracker');
const { TriggerEngine, COOLDOWN_MS, IDLE_MS } = require('./src/trigger');
const { DesktopMotion } = require('./src/desktop-motion');
const { PowerMonitorSource } = require('./src/power-monitor-source');
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
// 🔴 v1.7-a：isAppLocalUrl 与 ipcGuard 同源复用 —— 权限闸门与 IPC 闸门必须是
//   同一个「什么算本地页」的定义，否则两处判据漂移就是一整类绕过。
const { createIpcGuard, isAppLocalUrl, isChannelAllowedForPicker } = require('./src/ipc-guard');
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
  if (!powerMonitorSource) {
    powerMonitorSource = new PowerMonitorSource({ powerMonitor });
  }
  if (typeof brain.bindPowerMonitorSource === 'function') {
    brain.bindPowerMonitorSource(powerMonitorSource);
  }
  // v1.0 B 方案（用户拍板 2026-10）：她被唤醒时若枕边有未接留言，向两个窗口广播一条
  //   **客观提示**（不代拟、零 LLM）。界面收到后只在对话窗显示一行注记 —— 接不接归她。
  //   为什么回调挂这里：bindBrainDeps 是唯一注入口（启动 + 热替换都走它），
  //   挂两处就会重演「重建的 brain 带着旧回调」那类双出处问题。
  brain.onBedsideUnread = (info) => {
    try {
      broadcastToWindows('bedside-unread-on-wake', {
        count: Number(info && info.count) || 0,
        at: Number(info && info.at) || Date.now()
      });
    } catch (e) { /* 提示失败绝不影响唤醒 */ }
  };
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
let powerMonitorSource = null;
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
function maybeAskForSelfNote(selfIntent) {
  try {
    const deps = agentBuildDeps;
    if (!deps || !deps.agentSandbox) return;
    // 🔴 D-15 修断点 3（反重力复核发现）：原来读 brain._pendingAgentIntent，
    //   但 wantToLeaveSomething 存在 trigger.selfIntent 里，两者从未接线 ⇒ intent 恒 null。
    //   现在由调用方传入 trigger.selfIntent（自发愿望路径），不再依赖 evaluateTrigger。
    const intent = selfIntent || (brain && brain._pendingAgentIntent);
    if (!intent || intent.kind !== 'wantToLeaveSomething') return;    void (async () => {
      try {
        const note = await brain.askForSelfNote({ intentKind: intent.kind });
        // 边界②：她说不留 → note 为 null → 不建案。这是合法结果，不是失败。
        if (!note || !note.content) return;

        // 🔴 D-15 修断点 4（反重力复核发现）：自发愿望没有用户给的文件名，
        //   intent.hint 是 undefined ⇒ rawHint 为空 ⇒ 直接 return，永远不建案。
        //   现在：无文件名时生成默认名（日期 + 随机后缀防撞）。
        let rawHint = String(intent.hint == null ? '' : intent.hint).trim();
        if (!rawHint) {
          const d = new Date();
          const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          rawHint = 'note-' + ds + '-' + Math.random().toString(36).slice(2, 6) + '.txt';
        }
        if (path.isAbsolute(rawHint)) return;
        if (/[\\/]/.test(rawHint)) return;
        if (rawHint === '.' || rawHint === '..') return;
        if (/\.\./.test(rawHint)) return;
        if (rawHint.length > 200) return;
        if (rawHint.includes(':') || rawHint.endsWith('.') || rawHint.endsWith(' ') || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(rawHint.split('.')[0])) return;

        const scope = path.join(deps.agentSandbox, rawHint);

        // 🔴 D-17（用户拍板 C1）：自发愿望**盖 selfNote 戳** ⇒ 执行器闸门 4 免逐次确认。
        //   为什么：留便签的本质是「趁你不在时悄悄写下」；若要弹卡片等你回来才授权，
        //   那就毁掉了自发留字本身。
        //   ⚠️ 免确认 ≠ 无约束：沙盒范围/格式白名单/长度/预算/写事务**一个都没松**。
        const res = typeof deps.agentIpc.proposeInternal === 'function'
          ? deps.agentIpc.proposeInternal(
            { capability: 'workspace.write', scope, reason: intent.reason },
            'main',
            'selfNote',
            note.content
          )
          : null;
        if (res && res.ok && res.proposal) {
          // 内容暂存在提案旁，**随即自动执行**（没有卡片可点，主进程自己收尾）。
          //   ⚠️ 不塞进提案对象（D-9 定的：动机独立第二参数，同理内容也不进 raw）。
          pendingSelfNoteContent.set(res.proposal.id, note.content);

          const exec = typeof deps.agentIpc.executeInternal === 'function'
            ? deps.agentIpc.executeInternal({ proposalId: res.proposal.id })
            : null;
          if (exec && exec.ok) {
            console.log('[Agent] 她自己留下了一张纸条:', String(rawHint).slice(0, 60));
            // 🔴 D-19：**绝不广播 `agent-proposal-available`**。
            //
            //   实测事故：D-17 在这里广播了它，注释还写着「这不是确认卡片」。
            //   **那句话是错的** —— 事件名本身就决定了它的语义是「有提案等你决定」，
            //   渲染端 `pet.js` 的 onProposalAvailable 收到就无条件亮确认卡。
            //   于是自发便签写成后，用户仍被弹了一张多余的授权卡；
            //   用户点【授权】→ 执行器回 ALREADY_EXECUTED（白点）。
            //
            //   ⚠️ 语义铁律：**「已执行完」和「待你决定」是两件事，不能共用一个事件。**
            //     免确认的路径本来就不该有任何待决状态可广播。
            //   若将来确实要让 UI 知情（比如桌面上飘一句「我留了张纸条」），
            //   必须另起一个语义明确的事件名（如 `agent-selfnote-written`），
            //   绝不能复用 `-available`。
          } else {
            // 决策 4：写失败不告诉她，只记日志（审计里执行器已记了原因）。
            console.log('[Agent] 自发留条未落盘（按设计不告诉她）:', exec && exec.error);
          }
        }
      } catch (err) {
        // 边界③：静默。
      }
    })();
  } catch (err) {
    // 连同步段都不许抛 —— 它挂在 chat-send 的收尾上。
  }
}

/* ────────────────────────────────────────────────────────────────
 * 🔴 v1.4-b：生命观察日记（沙盒通路 B）—— 关窗时刻的自发生活沉淀
 * ────────────────────────────────────────────────────────────────
 *
 * ## 触发契机与四道防护
 *   1. 【单点触发】：严格仅在窗口轮转关窗时刻（res.windowClosed === true）触发，
 *      绝不在深睡苏醒（用户在场交互）时触发。
 *   2. 【配额探针】：检查 agentBudget 写配额与熔断状态，配额耗尽（remainingWrites <= 0 或 tripped）
 *      前置静默跳过，绝不建案触发报错或熔断。
 *   3. 【同日精准去重】：只检测沙盒内的 journal-YYYY-MM-DD*.md 文件，命中则跳过；
 *      绝不误伤或冲突 note-*.txt 自发便签。
 *   4. 【闸门 4 免确认】：proposalSource 为 'observerJournal'，自动执行落盘，绝不弹窗打扰用户。
 */
function maybeAskForObserverJournal(windowCloseRes) {
  try {
    const deps = agentBuildDeps;
    if (!deps || !deps.agentSandbox || !deps.agentIpc) return;
    if (!brain || typeof brain.askForObserverJournal !== 'function') return;

    // 防线 1：配额探针防御（writes 耗尽或已熔断时静默跳过）
    const budget = deps.agentBudget;
    if (budget && typeof budget.state === 'function') {
      const bState = budget.state();
      if (bState.tripped || (typeof bState.remainingWrites === 'number' && bState.remainingWrites <= 0)) {
        return;
      }
    }

    // 防线 2：精准同日去重（仅 journal-YYYY-MM-DD*.md，不冲突 note-*.txt）
    const d = new Date();
    const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    try {
      if (fs.existsSync(deps.agentSandbox)) {
        const files = fs.readdirSync(deps.agentSandbox);
        const hasJournalToday = files.some((f) => f.startsWith(`journal-${ds}`) && f.endsWith('.md'));
        if (hasJournalToday) return;
      }
    } catch (_) {
      return;
    }

    void (async () => {
      try {
        const journal = await brain.askForObserverJournal({
          windowNo: (brain.memory && brain.memory.data && brain.memory.data.windowNo) || 1,
          synthesis: windowCloseRes && windowCloseRes.summaryText
        });
        if (!journal || !journal.content) return;

        const filename = 'journal-' + ds + '-' + Math.random().toString(36).slice(2, 6) + '.md';
        const scope = path.join(deps.agentSandbox, filename);

        const res = typeof deps.agentIpc.proposeInternal === 'function'
          ? deps.agentIpc.proposeInternal(
            { capability: 'workspace.write', scope, reason: '生活观察日记' },
            'main',
            'observerJournal',
            journal.content
          )
          : null;

        if (res && res.ok && res.proposal) {
          pendingSelfNoteContent.set(res.proposal.id, journal.content);

          const exec = typeof deps.agentIpc.executeInternal === 'function'
            ? deps.agentIpc.executeInternal({ proposalId: res.proposal.id })
            : null;

          if (exec && exec.ok) {
            console.log('[Agent] 初澜写下了一篇生活观察日记:', filename);
          } else {
            console.log('[Agent] 观察日记未落盘:', exec && exec.error);
          }
        }
      } catch (err) {
        // 静默
      }
    })();
  } catch (err) {
    // 静默
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
// child frame / 外部 URL / 其他 webContents 一律拒绝；窗口通道不匹配则 UNAUTHORIZED_RENDERER_CHANNEL。
const ipcGuard = createIpcGuard({ ipcMain, getMainWindow: () => win, appDir: __dirname,
  // v1.0 方案二：独立对话窗与主窗同为应用自建受信窗（其余一律 UNTRUSTED_RENDERER）
  getTrustedWebContents: () => {
    const list = [win, chatWin];
    /* 🔴 v1.8-b（2026-10-21 修）：**框选窗也必须是受信窗口**。
     *
     *   第一版漏了它，后果是用户在框选窗里做的每一件事都被
     *   assertTrustedRenderer 挡成 UNTRUSTED_RENDERER：
     *     · 松手 → vision:capture 被拒 → 框一直留着、不提交
     *     · ESC  → vision:close-picker 被拒 → 关不掉
     *     · 右键 → 同一条通道，同样关不掉
     *   实测症状：「勾选了之后框就一直在那，ESC 也按不了，进程无法结束」。
     *
     *   ⚠️ 但**不能无条件给它全部权限**：它是加载在透明全屏窗里的页面，
     *   只该调 vision:capture / vision:stage / vision:close-picker / vision-notify 四条通道。
     *   所以除了加进信任白名单，还由 ipcGuard 对每条 handle/on 做窗口通道收窄。
     */
    try {
      const pickerMod = require('./src/vision-picker-window');
      const pw = pickerMod.getPickerWindow ? pickerMod.getPickerWindow() : null;
      if (pw && !pw.isDestroyed()) list.push(pw);
    } catch (e) { /* 模块异常不影响主链路的信任判定 */ }
    return list.filter(w => w && !w.isDestroyed()).map(w => w.webContents);
  },
  authorizeChannel: (event, channel) => assertChannelAllowedForPicker(event, channel)
});

/**
 * 🔴 v1.7-a：麦克风权限闸门（安全加固）。
 *
 * ## 为什么必须有
 *   本仓此前**没有任何** setPermissionRequestHandler（实测 grep 零命中），
 *   等于把"是否允许麦克风 / 通知 / 地理位置"交给了 Electron 的默认行为。
 *   默认行为随版本变化，且不是"默认拒绝"—— 那不是一个安全边界，是一个赌。
 *
 * ## 判据
 *   - **默认拒绝**：不在白名单里的 permission 一律 false；
 *   - **只放行 'media'**：`electron.d.ts:13508` 的枚举里只有 'media'，
 *     **没有 'microphone'**（后者仅出现在 `:14207` 的 askForMediaAccess，是 macOS 专用 API）。
 *     写成 `permission === 'microphone'` 会恒为 false，把麦克风请求一并拒掉。
 *   - **只放行本地页**：复用 ipc-guard 的 isAppLocalUrl，判据单一来源。
 *   - **wc 可能为 null**：setPermissionCheckHandler 的 webContents 参数允许为空
 *     （检测发生在请求之前），故两处都做了空值守卫。
 *
 * ## 为什么不做成会话级可配
 *   白名单是**安全常量**，不是功能开关。可配 = 可以被误配，
 *   而误配的后果（放行剪贴板读取 / 屏幕捕获）用户不会知道。
 *   要放宽必须改代码并过门禁，这是刻意的摩擦。
 *
 * @param {object} ses Electron session（生产传 defaultSession）
 * @returns {boolean} 是否成功安装（session 不可用时返回 false，由调用方决定是否告警）
 */
function installPermissionGate(ses) {
  if (!ses || typeof ses.setPermissionRequestHandler !== 'function') return false;
  const ALLOWED = new Set(['media']);   // 唯一放行的权限
  const localOnly = (wc) => {
    // 🔴 wc 可能为 null（check handler 的签名允许），必须先守卫再取 URL
    const url = wc && typeof wc.getURL === 'function' ? wc.getURL() : '';
    return isAppLocalUrl(url, __dirname);
  };

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    // 未知权限 / 非白名单：直接拒
    if (!ALLOWED.has(permission)) return callback(false);
    callback(localOnly(wc));
  });

  // check 发生在 request 之前，两者必须同口径，否则会出现"检查通过、请求被拒"的怪象
  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((wc, permission) => {
      if (!ALLOWED.has(permission)) return false;
      return localOnly(wc);
    });
  }

  return true;
}

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
  scheduleProactiveCheck(proactiveBaseMs());
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
      const { writeJsonAtomic } = require('./src/atomic');
      writeJsonAtomic(require('path').join(app.getPath('userData'), 'chat-window.json'), chatWinBounds);
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
  // 🔴 v1.8-a：物理互动也算「见到你」（真实触碰）。
  //   发消息那条在 chat-send 里另有一处 —— 两处都算在场，探窗与启动都不算。
  if (brain) brain.touchLastSeen();
  // 用户有了新交互，重置空闲检查闹钟
  scheduleProactiveCheck(proactiveBaseMs());
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
  /* 🔴 v1.8-a：这里**刻意不调 touchLastSeen()**。
   *
   *   原因（差点写成 bug）：chat-send → brain.chat() → memory.build() →
   *   takeReunionNote()。如果在这个入口先 touch，lastSeenAt 已经被刷成"现在"，
   *   build() 里算出的差值必然 ≈ 0 ⇒ **重逢永远不触发**。
   *
   *   正确职责划分：
   *     · takeReunionNote() 负责「判定 + 消费 + 刷新」三件事（它内部会 touch）；
   *     · chat-send 只负责把消息交下去，不碰时间戳。
   *
   *   那"用户发了消息但没走 build"（比如 brain 未 ready）算不算见到？
   *   不算 —— 那种情况下她根本没醒过来处理这一轮，不该计入在场。
   */
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
    // 🔴 D-25：好奇问题真的问出口了才打 asked 标记（同 commit 语义：说了才算）。
    //   对着 intent.question 精确匹配队列原话 —— 匹配不上就不标（不猜、不伪造）。
    if (proactive && offer && offer.selfIntent && offer.selfIntent.kind === 'curiosityAsk'
        && brain && brain.memory && typeof brain.memory.markCuriosityAsked === 'function') {
      brain.memory.markCuriosityAsked(offer.selfIntent.question);
    }
    // 换装是在 brain 里执行的（提案→真实状态→结果写回历史），
    // 这里只在真的换上了时把新图层推给渲染端，
    // 保证屏幕上穿的、系统提示里说的、历史里记的三者是同一件事。
    if (res.wearChanged) pushWardrobe();
    // v0.9.9 意志层：关窗后特质可能演进，刷新主动性权重（只动权重，不动闸门）
    if (res.windowClosed && trigger && brain && brain.subjectState) trigger.updateTraits(brain.subjectState.values);
    // 🔴 v1.4-b：关窗轮转时刻触发生活观察日记（沙盒通路 B）
    if (res.windowClosed) maybeAskForObserverJournal(res);
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
    // 🔴 D-15 修断点 2（反重力复核发现）：原来 if (!proactive)，
    //   把自发愿望完全排除在外（proactive=true 才是她主动开口）。
    //   现在：proactive 时传 trigger.selfIntent；用户发消息时传 _pendingAgentIntent。
    if (proactive) maybeAskForSelfNote(trigger && trigger.selfIntent);
    else maybeAskForSelfNote(brain && brain._pendingAgentIntent);

    return { ok: true, text: res.text, state: res.state,
             wears: res.wears, wearNote: res.wearNote,
             windowClosed: res.windowClosed, merged: res.merged,
             proactive };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    // 🔴 2026-10-19：失败必须留痕（见 auditChatFailure 头注释）。
    //   放在 AbortError 之后：用户主动取消是他们自己的意图，不是故障，不该进失败审计。
    auditChatFailure(err, { proactive, offer });
    // 同时推给对话窗（常驻注记行）—— 头顶气泡会收，审计用户不会翻，
    // 而主动搭话失败恰恰总发生在用户不在电脑前的时候。
    notifyChatFailureToWindows(err, { proactive, offer });
    // 认证失败要进退避：否则自愈重排会每 90 秒打一次注定 401 的请求。
    if (err && err.errorType === 'auth_failed') {
      authFailureUntil = Date.now() + AUTH_FAILURE_BACKOFF_MS;
    }
    // 认证失败要把 errorType 与 status 一并交给渲染端 —— 否则界面只能显示
    // 一句「出错了」，用户无法区分「Key 失效」与「网络抖动」，
    // 而这正是本次事故里 4 小时没被发现的原因。
    //
    // ⚠️ TimeoutError / AbortError 是**没有 errorType 的**（provider-adapter 刻意
    //   原样透传不重新包装），所以这里补一层按 name 的归类 —— 否则超时会被
    //   打成 'unknown_error'，渲染端那条 timeout 分支永远不会走到。
    return {
      ok: false,
      error: err.message,
      errorType: err.errorType || (err.name === 'TimeoutError' ? 'timeout' : 'unknown_error'),
      status: typeof err.status === 'number' ? err.status : null,
    };
  } finally {
    motionUi.chatBusy = false;
    syncMotionBlock('chat-done');
    scheduleProactiveCheck(proactiveBaseMs());
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
  if (!offer || (offer.kind !== 'poke' && offer.kind !== 'idle' && offer.kind !== 'silent_presence')) return false;
  if (typeof offer.at !== 'number' || !Number.isFinite(offer.at)) return false;
  const age = Date.now() - offer.at;
  return age >= 0 && age <= OFFER_TTL_MS;
}

/* 🔴 2026-10-19：主进程在等渲染端回执时**不持状态**（见 chat-send 的注释），
   而回执本身可能丢 —— 渲染端卡顿、系统进 Modern Standby 时 IPC 排队，
   渲染进程被回收也一样。丢一次回执，旧实现就再也不会自己醒来：
   实测 2026-10-19 整夜零开口，事后只能靠遥测与电源日志倒推。
   所以提案发出后必须自带一条自愈重排：等提案过期（TTL）之后再过一个冷却，
   重新评估一次。这一步纯本地（evaluate 不碰网络），绝不产生 API 调用。 */
const OFFER_RETRY_MS = OFFER_TTL_MS + COOLDOWN_MS;

/* brain 未就绪（冷启动没填 Key、或热替换进行中）时的短重试。
   旧实现在这条路上直接 return，调度器当场停摆；用户后来填好 Key 也不会自己回来。 */
const PROACTIVE_WAKE_RETRY_MS = 60000;

/* 🔴 2026-10-19：认证失败后的长退避。
 *
 *   为什么需要它：提案被拒（401）时**不会 commit**（commit 只在真的说出口时调用），
 *   所以 `spokenDuringIdle` 仍是 false、evaluate() 下一轮照样产出提案 ——
 *   于是 90 秒的自愈重排会变成「每 90 秒打一次注定 401 的请求」，一小时 40 次。
 *   虽然不烧 token（请求在鉴权就被拒），但那是无意义的网络与日志噪音，
 *   而且掩盖了真正该做的事：**让人去换 Key**。
 *
 *   所以：认证失败后把下一次评估推迟到 10 分钟。这不是防骚扰铁律的一部分，
 *   是「明知道对面关门了就别一直敲」—— 用户换完 Key 会被 config-set-key 那条显式重排立刻叫醒。 */
const AUTH_FAILURE_BACKOFF_MS = 10 * 60000;

/* 认证失败退避的到期时刻（0 = 无退避）。
 *
 *   ⚠️ 刻意只存在内存里：退避是「当前这把 Key 被拒了」的临时判断，
 *     换了 Key、重启了进程都该重新试。持久化它会让「用户换完 Key 却因为
 *     盘上还记着旧退避而继续沉默」—— 那正是本次事故里同一族的坑。 */
let authFailureUntil = 0;

/** 认证失败退避是否仍在生效。 */
function inAuthFailureBackoff() {
  return authFailureUntil > 0 && Date.now() < authFailureUntil;
}

/** 清掉退避（换 Key / 换连接成功时调用）。 */
function clearAuthFailureBackoff() {
  authFailureUntil = 0;
}

/** D-25：把好奇破冰的事实随评估带入 —— 待问计数与队首原话，**只取不加工**。
 *  队列的读口是 memory.nextCuriosity()（跳过已问的），与 asked 标记看的是同一条。
 *
 *  🔴 2026-10-19 收口：此前这段只存在于后台 tick，`proactive-check` IPC 直接调
 *     `trigger.evaluate()`（零参）⇒ 渲染端发起的那条路永远拿不到 curiosityAsk，
 *     同一个引擎在两条入口上给出不同答案。现在两条入口共用本函数。
 *  ⚠️ brain / memory 都可能为 null（启动早期、热替换窗口）：给 null 事实而不是抛。 */
function evaluateTriggerWithCuriosity() {
  if (!trigger) return null;
  const mem = brain && brain.memory ? brain.memory : null;
  const curQuestion = (mem && typeof mem.nextCuriosity === 'function')
    ? mem.nextCuriosity() : null;
  const curPending = (mem && mem.data && Array.isArray(mem.data.curiosityQueue))
    ? mem.data.curiosityQueue.filter((x) => x && x.asked !== true).length : 0;
  return trigger.evaluate({ curiosityPending: curPending, curiosityQuestion: curQuestion });
}

/** 提案派发留痕（2026-10-19）。为什么值得记：昨夜排查时 `proactive-declined` 有审计
 *  而 `proactive-offer` 没有 —— 于是「主进程到底有没有出过提案」只能靠 perception_attach
 *  遥测与 Windows 电源日志反推。补上之后三种形态一眼可分：
 *    offer 有、declined 无、chat 无 ⇒ 回执丢了；
 *    offer 有、declined 有        ⇒ 被礼貌闸门拒了（正常）；
 *    offer 有、chat 有、llm_call 无 ⇒ API 失败。
 *  ⚠️ 只记元数据（提案种类 / 意图种类），绝不记提案内容或用户数据。
 *  ⚠️ append 失败绝不能影响派发 —— 审计是证据，不是前置条件。 */
function auditProactiveDispatched(offer) {
  if (!proactiveAuditLog) return;
  try {
    proactiveAuditLog.append({
      channel: 'proactive-offer',
      outcome: 'dispatched',
      capability: null,
      via: 'main',
      offerKind: offer && offer.kind ? String(offer.kind) : null,
      selfIntentKind: (offer && offer.selfIntent && offer.selfIntent.kind)
        ? String(offer.selfIntent.kind) : null,
    });
  } catch { /* 审计写不进去也不能挡住派发 */ }
}

/** 对话失败留痕（2026-10-19）。
 *
 *  ## 为什么必须有这一条
 *
 *  实测事故：Key 在 10-18 深夜失效，之后 7 次主动搭话全部在 `brain.ask` 里被服务端
 *  401 拒掉。但从用户视角看只是「她一直不说话」—— 因为失败只落到一个 **6 秒就自动
 *  收起的气泡**上，人不在电脑前就等于没发生。
 *  而 `experiment-telemetry.jsonl` 又只在**成功**时才写 `llm_call`（见 brain.track），
 *  于是「失败」在磁盘上**没有任何痕迹**，只能靠 offer 有、llm_call 无来反推。
 *
 *  这条留痕的价值就在于把那个反推变成直读：
 *    offer 有 + chat-failed(auth_failed) ⇒ Key 失效，去换 Key；
 *    offer 有 + chat-failed(network_error) ⇒ 网络/端点问题，不是她的错；
 *    offer 有 + 什么都没有 ⇒ 回执丢了（见 OFFER_RETRY_MS 那条自愈重排）。
 *
 *  ⚠️ 只记元数据（错误类别 / HTTP 状态 / 是否主动搭话），**绝不记正文与凭据**。
 *     error message 本身可能带 provider 名与 URL，但不含 key（transport 层已 redact）。
 *  ⚠️ 审计失败绝不能把异常再抛回去 —— 它已经在 catch 里了。 */
function auditChatFailure(err, info) {
  if (!proactiveAuditLog) return;
  try {
    proactiveAuditLog.append({
      channel: 'chat-failed',
      outcome: 'failed',
      capability: null,
      via: 'main',
      proactive: !!(info && info.proactive),
      offerKind: (info && info.offer && info.offer.kind) ? String(info.offer.kind) : null,
      errorType: (err && err.errorType) ? String(err.errorType) : 'unknown_error',
      status: (err && typeof err.status === 'number') ? err.status : null,
      retryable: !!(err && err.retryable),
    });
  } catch { /* 审计写不进去也不能挡住错误上报 */ }
}

/** 把失败也送到对话窗（2026-10-19）。
 *
 *  ## 为什么审计还不够
 *
 *  审计落的是 `%APPDATA%\Life\agent-audit.jsonl` —— 那是**给我们排查用的**，
 *  用户不会去翻。而头顶气泡 15 秒就收，主动搭话又恰恰发生在用户不在电脑前的时候。
 *  于是「她每半小时试一次、每半小时被拒」这件事，用户仍然可能一整晚都不知道。
 *
 *  对话窗的注记行是**常驻**的（chat.js 的 chatNotice），关掉再开还在。
 *  所以这里把失败清单一并推过去 —— 只推错误类别，不推报错原文：
 *  用户需要知道的是「Key 失效，去换」，不是 `HTTP 401 [auth_failed] provider=…`。
 *
 *  ⚠️ 只推 auth_failed / network_error 两类。其余错误（解析失败、超长响应…）
 *     属于偶发，写进对话窗等于用噪音换可见性，得不偿失。
 *  ⚠️ 广播失败绝不能再抛：它已经在错误处理路径上了。 */
function notifyChatFailureToWindows(err, info) {
  const type = (err && err.errorType) || (err && err.name === 'TimeoutError' ? 'timeout' : 'unknown_error');
  if (type !== 'auth_failed' && type !== 'network_error' && type !== 'timeout') return;
  try {
    broadcastToWindows('chat-failed', {
      errorType: type,
      proactive: !!(info && info.proactive),
      status: (err && typeof err.status === 'number') ? err.status : null,
    });
  } catch { /* 广播失败不影响错误上报本身 */ }
}

function scheduleProactiveCheck(delayMs) {
  if (proactiveTimer) clearTimeout(proactiveTimer);
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    checkAndPushProactive();
  }, Math.max(100, delayMs));
  if (proactiveTimer.unref) proactiveTimer.unref();
}

/* 🔴 D-17：调度用的基准必须取**引擎的真实值**，不能用模块常量 IDLE_MS。
 *
 *   为什么：D-17 让 idleMs 可配（验证时调成 3 分钟），但 main.js 的调度
 *   仍在用 import 进来的 IDLE_MS（恒 30 分钟）⇒ **首次轮询要等 30 分钟**，
 *   配置改小完全不起作用。反重力复核指出了这条，属实。
 *
 *   ⚠️ 回落顺序：引擎值 → 常量。trigger 未就绪时用常量（启动早期）。
 */
function proactiveBaseMs() {
  const v = trigger && Number.isFinite(trigger.idleMs) && trigger.idleMs > 0
    ? trigger.idleMs : IDLE_MS;
  // 调度粒度上限：即使基准很大也要定期醒来处理分段事件（原逻辑就是 10 分钟）。
  return v;
}

function checkAndPushProactive() {
  // 🔴 2026-10-19 不变式：**每一次 tick 结束都必须已经安排好下一次 tick**。
  //   除了「用户互动主动重排」那一条路径之外，任何 return 之前都要有 scheduleProactiveCheck。
  //   旧实现在这里直接 return ⇒ 冷启动没填 Key 时调度器当场停摆，用户后来填好也不会自己回来。
  //   此处宁可 60 秒后空转一次（纯本地，零 API 成本），也不许停摆。
  if (!trigger || !brain || !brain.ready || !win || win.isDestroyed()) {
    scheduleProactiveCheck(PROACTIVE_WAKE_RETRY_MS);
    return;
  }

  // 🔴 2026-10-19：感知与内稳态**先走**，与「要不要开口」解耦。
  //
  //   为什么必须把它们挪到退避检查之前：退避挡的是「别再去撞一扇关着的门」，
  //   而 recordIdle 做的是**挂机计量**（内稳态静息回血 + environmental_silence 知觉）。
  //   两者没有任何关系 —— 早期版本把退避检查放在这一段之前，
  //   结果是 Key 失效的十分钟里她的生理恢复与知觉也一起断档，
  //   等于「门锁坏了的十分钟里，连心跳也停了」。这是本次自查抓到的副作用。
  const at = Date.now();
  const lastAct = tracker ? tracker.lastInteractionAt : at;
  const idleMs = at - lastAct;
  const idleMin = Math.floor(idleMs / 60000);

  // Phase 0.5: 桌面挂机事件直连 (带水位线防重复)
  if (tracker && idleMin >= 10) {
    tracker.recordIdle(idleMin, at);
  }

  // 🔴 2026-10-19：认证失败退避期内不再产出提案。
  //   为什么不靠 evaluate() 自己挡：引擎不知道 Key 已经失效，它会照常提案，
  //   于是 90 秒的自愈重排变成「每 90 秒打一次注定 401 的请求」。
  //   退避只是把节奏从 90 秒放到 10 分钟 —— 调度本身**没有停摆**（仍会重排），
  //   换 Key 走 config-set-key 的显式重排立刻解除（见 clearAuthFailureBackoff）。
  //   ⚠️ 位置必须在上面的 recordIdle 之后：只挡「开口」，不挡「感知与内稳态」。
  if (inAuthFailureBackoff()) {
    scheduleProactiveCheck(AUTH_FAILURE_BACKOFF_MS);
    return;
  }

  // 🔴 D-25：好奇破冰的事实随评估带入 —— 待问计数与队首原话，**只取不加工**。
  //   队列的读口是 memory.nextCuriosity()（跳过已问的），与 asked 标记看的是同一条。
  //   ⚠️ 2026-10-19 起组装逻辑收口到 evaluateTriggerWithCuriosity()，
  //     让后台 tick 与 proactive-check IPC 两条入口共用同一份事实（此前 IPC 漏传）。
  const offer = evaluateTriggerWithCuriosity();
  if (offer) {
    win.webContents.send('proactive-offer', offer);
    auditProactiveDispatched(offer);
    // 🔴 回执（proactive-commit / proactive-declined / chat-send 的 finally）会把它
    //   换更短的间隔；回执丢了就靠这一条自愈重排 —— 90 秒后重新评估。
    //   为什么不会变成骚扰：提案没真的说出口就不会 commit，重排只是再产出一份提案
    //   （纯本地 IPC）；真说了则 spokenDuringIdle 已置位，evaluate 直接返回 null。
    scheduleProactiveCheck(OFFER_RETRY_MS);
    return;
  }
  const idleRemaining = proactiveBaseMs() - idleMs;
  const nextDelay = idleRemaining > 0 ? idleRemaining : COOLDOWN_MS;
  // 挂机检查调度：步长不超过 10 分钟，确保 10、20 分钟阶段性挂机事件能被及时检测
  const checkDelay = Math.min(Math.max(COOLDOWN_MS, nextDelay), 10 * 60000);
  scheduleProactiveCheck(checkDelay);
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
    && (offer.kind === 'poke' || offer.kind === 'idle' || offer.kind === 'silent_presence')
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

// v1.3-b: 沉默留白直接记账通道 (零 LLM 调用，仅驱动微动作并提交 trigger 记账)
ipcGuard.on('proactive-commit', (e, offer) => {
  if (offer && validOffer(offer) && trigger) {
    trigger.commit(offer);
  }
  scheduleProactiveCheck(proactiveBaseMs());
});

ipcGuard.handle('proactive-check', () => {
  // v2.0 排雷：睡着绝不梦游提案；生理断电先于一切提案逻辑（静默沉睡，零台词）
  // v3.1 双源守卫：tracker.sleepMode 在内存、isSleeping 跨重启持久，两边可能分裂，
  // 任一为真都算睡着 —— 宁可少提一次案，绝不让她自称沉睡时还主动搭话。
  if (brain && brain.checkPhysiologicalCollapse && brain.checkPhysiologicalCollapse()) return null;
  if (brain && brain.tracker && brain.tracker.sleepMode) return null;
  if (brain && brain.internalRegulation && brain.internalRegulation.isSleeping) return null;
  // 🔴 D-25 收口（2026-10-19）：这里原来调 `trigger.evaluate()`（零参），
  //   于是渲染端这条入口永远拿不到 curiosityPending / curiosityQuestion ⇒
  //   同一个引擎在「后台 tick」与「渲染端来问」两条路上给出不同答案，
  //   好奇破冰只在后台那一半世界里存在。现在两条入口共用同一份事实。
  return evaluateTriggerWithCuriosity();
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
  /* 🔴 2026-10-27：`development` 字段**已停算**，恒为 null。
   *
   *   这里原来调用 `canal.getCanalizationMetrics()` 产出 { stage, plasticity }，
   *   但 `test/canalization.test.js` 的 P2-3c 守卫明确禁止生产代码引用该符号 ——
   *   理由是 DEVELOPMENTAL_STAGES 是**纯叙事标签、无机制消费方**，
   *   把它搬上观测面板等于"用 UI 给叙事镀上机制的可信度"。
   *   `src/observability.js:235-248` 早已就此裁定不上面板。
   *
   *   ⚠️ 该守卫此前**只扫 `src/`**（root/test 未扫），所以 root/main.js 的这次违规
   *   一直没被抓住。守卫已同步扩到根目录，此处删除是为了让它真的成立，
   *   不是绕过门禁。
   *
   *   字段本身暂时保留返回（值为 null），避免渲染层之外的消费方拿到 undefined。
   */
  try {
    const ledger = brain && brain.selfLedger;
    if (ledger && ledger.getEntryMetrics) {
      // 🔴 D-14 收口（2026-10）：认知聚合必须覆盖全部 8 维（含三个评价性自我关系维度），
      //   否则 cognition 指标只看旧 5 维、自我关系类条目被系统性漏统计。
      const TRAITS = ['quiet_preference', 'social_initiative', 'attachment_need', 'vitality', 'philosophical_curiosity', 'self_continuity', 'meaning_presence', 'self_clarity'];
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
    relations: { promiseFidelity, fulfilled, broken, words: lexicon.length, reusedWords, archiveChain },
    // 🔴 v1.7-b：声明式观测注册表。
    //   与上面六个旧字段**并行返回**，让渲染层可以分两批改、中途套件恒绿。
    //   旧字段待新渲染层验证通过后再删（不在本次改动里删）。
    //
    //   ⚠️ agentBudget / agentAuditLog 是 whenReady 里的**块级 const**，
    //   本 handler 在模块顶层注册，直接引用会抛 TDZ（本仓已踩过同型坑）。
    //   故走两个模块级入口：agentBuildDeps（持有 budget）与 proactiveAuditLog（同一个 AuditLog 实例）。
    obs: (() => {
      try {
        const { collectObservability } = require('./src/observability');
        return collectObservability({
          brain,
          agentBudget: agentBuildDeps ? agentBuildDeps.agentBudget : null,
          agentAuditLog: proactiveAuditLog
        });
      } catch (e) {
        // 观测失败绝不拖垮整个通道：如实返回空结构，UI 显示破折号
        return { ok: false, groups: {}, order: [], generatedAt: Date.now() };
      }
    })()
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
  if (brain) {
    brain.memory.wardrobe = wardrobe.promptBlock(brain.subjectState ? brain.subjectState.values : null);
    brain.pendingCacheBreakReason = 'wardrobe_change';
  }
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
    createCandidate: (c) => new Brain(app.getPath('userData'), c, { getSS }),
    bindCandidate: bindBrainDeps,
    persistCfg: (c) => { persisted = persistCfg(c, { clearKey: !trimmed }); }
  });
  if (!res.ok) return { ok: false, error: res.error };

  // 切换主引用
  cfg = res.cfg;
  brain = res.brain;
  keyEncrypted = persisted.encrypted;

  // 🔴 2026-10-19：填/换 Key 之后必须把主动搭话的调度叫醒。
  //   冷启动没 Key 时 tick 走的是「brain 未就绪，60 秒后重试」那条路，本来就会自愈；
  //   但热替换会换掉 brain 实例、且用户往往在填完 Key 后就不再碰窗口 ——
  //   不在这里重排，她得等到用户下一次互动才可能开口。这一行是「配置改了要生效」的落点。
  //
  //   ⚠️ 延迟取**冷却**而不是基准（proactiveBaseMs）：
  //     基准是 30 分钟，用它等于「刚填完 Key 她还要再等半小时才第一次评估」——
  //     而如果填 Key 前已经挂机很久（典型：装好软件先去填 Key），
  //     那一等就是白等。45 秒既让评估尽快发生，又不至于「刚点完确定她就开口」。
  //     说不说仍由 evaluate() 独立判定：静默不够久就返回 null 并照常重排。
  //
  //   🔴 换 Key 必须同时解除认证失败退避：否则用户刚填的新 Key 会被
  //     「上一把 Key 被拒」留下的退避挡住最多 10 分钟 —— 那正是同族的坑。
  clearAuthFailureBackoff();
  scheduleProactiveCheck(COOLDOWN_MS);

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
    createCandidate: (c) => new Brain(app.getPath('userData'), c, { getSS }),
    bindCandidate: bindBrainDeps,
    getSS,
    fallbackSecret: (cfg && cfg.apiKey) || ''
  });
  if (!r.ok) {
    return { ok: false, swapped: false, activeConnectionId: r.activeConnectionId, error: r.error };
  }
  cfg = r.cfg;
  brain = r.brain;
  // 🔴 2026-10-19：换连接同样是「换了一把 Key」，必须解除认证失败退避并叫醒调度。
  //   漏了它的表现与换 Key 那条一模一样：用户明明切到了能用的连接，她却因为
  //   上一把 Key 留下的 10 分钟退避继续沉默，而界面上没有任何提示。
  clearAuthFailureBackoff();
  scheduleProactiveCheck(COOLDOWN_MS);
  return { ok: true, activeConnectionId: r.activeConnectionId, swapped: true };
});

/* ============================================================
 * 🔴 v1.7-a：STT 语音识别 IPC（4 个通道）
 *
 * ## 为什么 STT 配置独立于 connections
 *   实测（2026-10-19 审计）：**DeepSeek 官方没有 STT 端点**
 *   （`deepseek.js` / `deepseek-adapter.js` grep `audio|transcri` 零命中，
 *   官方仅 `/v1/chat/completions` + `/v1/models`）。
 *   所以 STT 用**独立的 credentialRef**（`cred:stt_api_key`），
 *   与任何 `cred:conn_*` 天然隔离：删连接不会误删 STT Key，反之亦然。
 *
 * ## 安全边界（每条都有门禁断言）
 *   1. **transcribe 的入参里没有 endpoint / apiKey** ——
 *      端点与密钥只从主进程存储读，渲染层无法指定任意端点（防 SSRF、防 Key 外送）；
 *   2. **getConfig 绝不返回 secret** —— 只回 present/encrypted 与端点、模型、语言；
 *   3. **失败只透 errorType** —— safeDetail 只进审计日志，不透给渲染层。
 * ============================================================ */

/** STT 凭据的 credentialRef（独立 namespace，不与连接混用） */
const STT_CREDENTIAL_REF = 'cred:stt_api_key';

/**
 * STT 非机密配置的**独立文件名**。
 *
 * 🔴 为什么不用 `secure.saveConfig` / 主 `life-config.json`：
 *   那两个是**对话通道**的配置（含 provider/baseURL/apiKey 语义），
 *   把 STT 的 endpoint/model 塞进去会污染主配置的语义，甚至可能被
 *   `loadConfig` 当成对话凭据去解析。
 *   STT 是**完全独立的能力**，就配**完全独立的文件**：`stt-config.json`。
 *   它只含 endpoint / model / lang 三个非机密字段，**密钥永不进这个文件**。
 */
const STT_CFG_FILE = 'stt-config.json';

/** 读 STT 非机密配置。缺文件/坏 JSON 一律回落空值，**绝不抛**。 */
function readSttConfig() {
  const empty = { endpoint: '', model: '', lang: '' };
  try {
    const p = path.join(app.getPath('userData'), STT_CFG_FILE);
    if (!fs.existsSync(p)) return empty;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      lang: typeof raw.lang === 'string' ? raw.lang : ''
    };
  } catch (e) {
    return empty;
  }
}

/**
 * 写 STT 非机密配置（只写这三个字段，绝不碰密钥）。
 * 走 atomic 原子写：与仓库既有的“配置不静默半写”纪律一致。
 */
function writeSttConfig(patch) {
  const dir = app.getPath('userData');
  const cur = readSttConfig();
  const next = {
    endpoint: typeof patch.endpoint === 'string' ? patch.endpoint.trim() : cur.endpoint,
    model: typeof patch.model === 'string' ? patch.model.trim() : cur.model,
    lang: typeof patch.lang === 'string' ? patch.lang.trim() : cur.lang
  };
  try {
    const { writeFileAtomic } = require('./src/atomic');
    writeFileAtomic(path.join(dir, STT_CFG_FILE), JSON.stringify(next, null, 2) + '\n');
    return next;
  } catch (e) {
    return null;
  }
}

/** 读 STT 密钥（**只在主进程内使用**，绝不返回给渲染层） */
function readSttSecret() {
  try {
    return secureCreds.getCredential(STT_CREDENTIAL_REF, { dir: app.getPath('userData'), getSS });
  } catch (e) {
    return null;
  }
}

ipcGuard.handle('stt:get-config', () => {
  const c = readSttConfig();
  // 🔴 只回"有没有、加没加密"，绝不回 secret 本身
  let desc = { present: false, encrypted: false };
  try {
    desc = secureCreds.describeCredential(STT_CREDENTIAL_REF, { dir: app.getPath('userData'), getSS });
  } catch (e) { /* 读不到就是没有，不抛 */ }
  return {
    ok: true,
    endpoint: c.endpoint,
    model: c.model,
    lang: c.lang,
    hasKey: desc.present === true,
    encrypted: desc.encrypted === true
  };
});

ipcGuard.handle('stt:set-config', (e, opts = {}) => {
  const patch = {
    endpoint: typeof opts.endpoint === 'string' ? opts.endpoint : '',
    model: typeof opts.model === 'string' ? opts.model : '',
    lang: typeof opts.lang === 'string' ? opts.lang : ''
  };
  const saved = writeSttConfig(patch);
  if (!saved) return { ok: false, errorType: 'config_write_failed' };

  // credential 为空 = 不改密钥（用户只改端点/模型时不必重填）
  let encrypted = null;
  if (typeof opts.credential === 'string' && opts.credential.trim()) {
    const w = secureCreds.setCredential(STT_CREDENTIAL_REF, opts.credential.trim(), {
      dir: app.getPath('userData'), getSS
    });
    if (!w.ok) return { ok: false, error: 'CREDENTIAL_WRITE_FAILED: ' + (w.error || '') };
    encrypted = w.encrypted === true;
  }
  return { ok: true, config: saved, encrypted };
});

ipcGuard.handle('stt:clear-key', () => {
  try {
    const r = secureCreds.deleteCredential(STT_CREDENTIAL_REF, { dir: app.getPath('userData'), getSS });
    return { ok: true, deleted: r && r.deleted !== false };
  } catch (e) {
    return { ok: false, error: 'CREDENTIAL_DELETE_FAILED' };
  }
});

ipcGuard.handle('stt:transcribe', async (e, opts = {}) => {
  // 🔴 入参只有音频与语言：**没有 endpoint、没有 apiKey**。
  //   端点与密钥一律从主进程存储读 —— 渲染层无权指定请求发去哪。
  const c = readSttConfig();
  const secret = readSttSecret();
  if (!secret) return { ok: false, errorType: 'not_configured' };

  const audio = opts && opts.audio;
  // ArrayBuffer / Uint8Array / Buffer 都归一成 Buffer（IPC 传过来通常是 Uint8Array）
  let buf = null;
  try {
    if (audio instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(audio));
    else if (audio && typeof audio.length === 'number') buf = Buffer.from(audio);
  } catch (err) {
    buf = null;
  }
  if (!buf || !buf.length) return { ok: false, errorType: 'no_audio' };

  let sttMod;
  try {
    sttMod = require('./src/stt-transport');
  } catch (err) {
    return { ok: false, errorType: 'transport_unavailable' };
  }

  const r = await sttMod.transcribe({
    audio: buf,
    mimeType: typeof opts.mimeType === 'string' ? opts.mimeType : 'audio/webm',
    cfg: {
      endpoint: c.endpoint,
      apiKey: secret,
      model: c.model,
      lang: typeof opts.lang === 'string' && opts.lang ? opts.lang : c.lang
    }
  });

  if (r.ok) {
    // 只回文本与耗时；不回任何配置细节
    return { ok: true, text: r.text, elapsedMs: r.elapsedMs };
  }
  // 🔴 失败只透 errorType；safeDetail 不出去（它可能含端点片段）
  return { ok: false, errorType: r.errorType };
});

/**
 * 🔴 v1.7-a（2026-10-20）：STT 录音审计。
 *
 * 为什么加：真机反馈「说了话没识别」，但磁盘上**没有任何痕迹**，
 * 无法判断卡在采集、IPC、还是识别。这条通道只记元数据：
 * 阶段、录音时长、chunk 数、字节数、mime、错误类别。
 *
 * **绝不记**：音频内容、识别文本、密钥、完整端点。
 * 写入既有 agent 审计同目录的 stt-audit.jsonl（append-only）。
 */
ipcGuard.on('stt-audit', (e, payload = {}) => {
  try {
    const dir = app.getPath('userData');
    const line = {
      at: new Date().toISOString(),
      stage: typeof payload.stage === 'string' ? payload.stage.slice(0, 32) : null,
      elapsedMs: Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : null,
      chunksCount: Number.isFinite(payload.chunksCount) ? payload.chunksCount : null,
      bytes: Number.isFinite(payload.bytes) ? payload.bytes : null,
      mime: typeof payload.mime === 'string' ? payload.mime.slice(0, 60) : null,
      // 成功时只记文本长度，不记文本本身
      textLen: Number.isFinite(payload.textLen) ? payload.textLen : null,
      errorType: typeof payload.errorType === 'string' ? payload.errorType.slice(0, 40) : null,
      error: typeof payload.error === 'string' ? payload.error.slice(0, 120) : null
    };
    fs.appendFileSync(path.join(dir, 'stt-audit.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  } catch (err) {
    // 审计写失败绝不外抛：它挂在录音收尾上
  }
});

/* ============================================================
 * 🔴 v1.8-b：屏幕视觉探针（框选）
 *
 * ## 隐私铁律（先于一切实现，见 docs/v1.8-b-IMPLEMENTATION-ORDER.md §1）
 *   1. 只做**用户框选**，绝不做全屏 / 活动窗口
 *   2. 只在**用户显式唤起**时截，绝不后台定时截屏
 *      ⇒ 本段代码里**没有、也永远不许有** setInterval / setTimeout 驱动的截图
 *   3. 图**不落盘**：capturePage → data URL → 立刻返回，本段无任何 fs.write
 *   4. 审计只记尺寸/耗时/成败，**不记像素、不记 OCR 文本**
 * ============================================================ */

/** 视觉能力是否可用（按**当前模型名**判定，不按 provider 标称） */
ipcGuard.handle('vision:capability', () => {
  try {
    const model = (cfg && cfg.model) || '';
    const { modelSupportsVision } = require('./src/vision');
    return { ok: true, model, supported: modelSupportsVision(model) };
  } catch (e) {
    return { ok: false, supported: false, error: 'CAPABILITY_CHECK_FAILED' };
  }
});

/**
 * 截取主屏的指定区域（**只存在内存，绝不落盘**）。
 *
 * ## 2026-10-20 重做
 *   第一版用主窗的 capturePage + 窗口偏移换算，实测两个硬伤：
 *     ① 主窗只有 256×320，`inset:0` 的遮罩只能覆盖窗口，框不到屏幕别处；
 *     ② 主窗的 setIgnoreMouseEvents 把遮罩视为非交互区，鼠标直接穿透 ⇒ 拖不动。
 *   现改为：**框选在独立全屏窗里做**（src/vision-picker-window.js），
 *   它发来的矩形就是屏幕坐标，这里直接按屏幕坐标截主显示器。
 *
 * 入参只有矩形 { x, y, width, height }，**不接受任何路径 / URL**。
 * 这是隐私面：能传路径就能读任意文件，能传 URL 就能 SSRF。
 */
ipcGuard.handle('vision:capture', async (e, opts = {}) => {
  const started = Date.now();

  /* 🔴 2026-10-27：失败分支也必须留痕。
   *
   *   此前只有成功那条写 appendVisionAudit({ stage:'captured' })，
   *   而 bad_rect / no_screen_source / capture_failed / capture_threw
   *   四个失败分支全部直接 return —— 出问题时审计答不了"为什么失败"，
   *   只能看到"用户点了、没成功、没有下文"。
   *
   *   审计口径不变：只记 errorType 与耗时，**不记像素、不记矩形坐标**
   *   （坐标本身是屏幕内容线索，记下来等于记了一部分屏幕）。
   */
  const fail = (errorType) => {
    appendVisionAudit({
      at: new Date().toISOString(),
      stage: 'failed',
      elapsedMs: Date.now() - started,
      errorType
    });
    return { ok: false, errorType };
  };

  const visionMod = require('./src/vision');
  const display = screen.getPrimaryDisplay();
  const rect = visionMod.normalizeRect(opts.rect, {
    maxW: display.size.width,
    maxH: display.size.height
  });
  if (!rect) return fail('bad_rect');

  let dataUrl = null;
  let outW = rect.width;
  let outH = rect.height;
  try {
    /* 🔴 为什么用 desktopCapturer 而不是 webContents.capturePage：
     *
     *   `capturePage` 只能截**该窗口自己的内容**——
     *   框选窗虽然全屏，但它自己是透明的，截出来只有遮罩，看不到底下的屏幕。
     *   而且主窗只有 256×320，更不可能截到屏幕别处。
     *
     *   `desktopCapturer.getSources({ types:['screen'] })` 拿到的是**整块屏幕的像素**，
     *   再按用户框的矩形裁剪，这才是"看她选的那块屏幕"的正确实现。
     *
     * ⚠️ 隐私纪律不变：**只裁用户框的那一块**，全屏图用完立即丢弃，
     *   绝不落盘、绝不外传未裁剪的整屏。
     */
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height }
    });
    if (!sources || !sources.length) return fail('no_screen_source');

    // 选与框选窗同一块显示器（多屏时不至于截错）
    const target = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    const full = target.thumbnail;
    if (!full || (typeof full.isEmpty === 'function' && full.isEmpty())) {
      return fail('capture_failed');
    }

    const fullSize = full.getSize();
    // 缩略图尺寸 == 屏幕逻辑尺寸时，矩形可直接用；否则按比例换算
    const sx = fullSize.width / display.size.width;
    const sy = fullSize.height / display.size.height;
    const cropRect = {
      x: Math.max(0, Math.round(rect.x * sx)),
      y: Math.max(0, Math.round(rect.y * sy)),
      width: Math.max(1, Math.round(rect.width * sx)),
      height: Math.max(1, Math.round(rect.height * sy))
    };

    // 🔴 只裁框选那一块 —— 整屏像素在本函数结束时即弃
    const cropped = full.crop(cropRect);
    const croppedSize = cropped.getSize();

    const fitted = visionMod.fitCaptureSize(croppedSize.width, croppedSize.height);
    const finalImg = fitted.scaled
      ? cropped.resize({ width: fitted.width, height: fitted.height, quality: 'good' })
      : cropped;
    outW = fitted.width;
    outH = fitted.height;

    const png = finalImg.toPNG();
    dataUrl = 'data:image/png;base64,' + png.toString('base64');
  } catch (err) {
    return fail('capture_threw');
  }

  // 审计：只记尺寸与耗时，不记内容
  try {
    appendVisionAudit({
      at: new Date().toISOString(),
      stage: 'captured',
      width: outW,
      height: outH,
      elapsedMs: Date.now() - started
    });
  } catch (err) { /* 审计失败不影响主流程 */ }

  return { ok: true, dataUrl, width: outW, height: outH, elapsedMs: Date.now() - started };
});

/** 打开全屏框选窗（菜单点「看看这个…」时调用） */
/**
 * 🔴 通道级收窄：框选窗只该调实际使用的四条视觉通道。
 *
 * 为什么需要这一层：框选窗已加入 IPC 信任白名单（否则它连自己的截图都调不通），
 * 但它是**加载在透明全屏窗里的页面**，不该拿到主窗的全部能力
 * （比如它不该能 chat-send / connections:create / agent:execute）。
 *
 * 判据：调用者若是框选窗，只放行 capture / stage / close-picker / notify。
 * 本函数由 src/ipc-guard.js 的 handle 与 on 包装统一调用，不依赖单个 handler 自查。
 * @param {object} event IPC 事件
 * @param {string} channel
 * @returns {boolean} 是否放行
 */
const VISION_ONLY_CHANNELS = new Set([
  'vision:capture',
  'vision:stage',
  'vision:close-picker',
  'vision-notify'
]);
function assertChannelAllowedForPicker(event, channel) {
  let pw = null;
  try {
    const mod = require('./src/vision-picker-window');
    pw = mod.getPickerWindow ? mod.getPickerWindow() : null;
  } catch (e) { return true; }
  const pickerContents = pw && !pw.isDestroyed() ? pw.webContents : null;
  return isChannelAllowedForPicker(event, channel, pickerContents, VISION_ONLY_CHANNELS);
}

ipcGuard.handle('vision:open-picker', (e) => {
  // 🔴 框选窗自己不许再开一个框选窗（由统一通道守卫在进入 handler 前拒绝）
  try {
    const mod = require('./src/vision-picker-window');
    const r = mod.openVisionPicker({ ipcGuard });
    return { ok: true, reused: !!r.reused };
  } catch (err) {
    return { ok: false, errorType: 'picker_open_failed' };
  }
});

/** 关闭框选窗（用户点 ESC / 右键 / 完成时由渲染层调） */
ipcGuard.handle('vision:close-picker', () => {
  try {
    require('./src/vision-picker-window').closeVisionPicker();
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
});

/**
 * 框选结果的轻量通知（框选窗关掉后，主窗要能说一句"看到了"）。
 * 用单向广播，不阻塞框选窗的关闭流程。
 */
ipcGuard.on('vision-notify', (e, payload = {}) => {
  broadcastToWindows('vision-notify', {
    ok: payload.ok === true,
    errorType: typeof payload.errorType === 'string' ? payload.errorType.slice(0, 40) : null
  });
});

/**
 * 🔴 v1.8-b：把刚截的图**暂存**到 brain，等用户下一条消息时送出。
 *
 * 为什么要分开两步（截图 / 暂存）：
 *   用户框选完不会立刻说话（可能先看一眼确认），所以图先存着，
 *   等他真正发消息时再随那一轮送出去 —— 这才是"我看到你指的这块"的语义。
 *
 * 🔴 只存一张，后到覆盖先到；取过即清（brain.takeVisionPick）。
 */
ipcGuard.handle('vision:stage', (e, opts = {}) => {
  if (!brain) return { ok: false, errorType: 'no_brain' };
  if (typeof opts.dataUrl !== 'string' || !opts.dataUrl.startsWith('data:image/')) {
    return { ok: false, errorType: 'bad_image' };
  }
  const ok = brain.stageVisionPick({
    dataUrl: opts.dataUrl,
    width: Number.isFinite(opts.width) ? opts.width : 0,
    height: Number.isFinite(opts.height) ? opts.height : 0
  });
  return ok ? { ok: true } : { ok: false, errorType: 'stage_failed' };
});

/** 是否已暂存一张图（UI 用来显示"待发送"标记） */
ipcGuard.handle('vision:pending', () => {
  if (!brain) return { ok: false, pending: false };
  return { ok: true, pending: brain.hasVisionPick() };
});

/**
 * 🔴 v1.8-b（2026-10-21）：给对话窗的「待发送截图」预览数据。
 *
 * ## 为什么需要这个通道
 *   用户实测反馈：「截出来的图在对话框里找不到，也不会出现在输入框里，
 *   具有迷惑性」。截图存进 brain 后**界面零反馈** —— 他无法确认截到没有。
 *
 * ## 返回什么
 *   缩略图（data URL 缩小版）+ 尺寸。**只给预览用**，
 *   真正送模型的是 brain 里存的那张原图，两者互不影响。
 *
 * ## 隐私口径
 *   图本来就只存在内存；这里只是把它**回传给本应用自己的对话窗**做缩略预览，
 *   不落盘、不外传。用户点 × 时通过 vision:drop 彻底清掉。
 */
ipcGuard.handle('vision:peek', () => {
  if (!brain) return { ok: false, pending: false };
  const pick = typeof brain.peekVisionPick === 'function' ? brain.peekVisionPick() : null;
  if (!pick || !pick.dataUrl) return { ok: true, pending: false };
  return {
    ok: true,
    pending: true,
    // 缩略图与尺寸都给：尺寸是客观事实，缩略图让用户确认"就是这块"
    dataUrl: pick.dataUrl,
    width: pick.width,
    height: pick.height
  };
});

/**
 * 🔴 v1.8-b：丢弃待发送的截图（用户点 × 时调）。
 * 与「一次性消费」互补：takeVisionPick 是发出去后自动清，这个是用户主动放弃。
 */
ipcGuard.handle('vision:drop', () => {
  if (!brain) return { ok: false };
  brain.takeVisionPick();   // 取出即清（返回值丢弃）
  return { ok: true };
});

/**
 * 主窗当前位置（框选坐标换算用）。
 * 渲染层的框选拿到的是**视口坐标**，主进程截图要的是**屏幕坐标**，
 * 两者相差一个窗口位置。把这个值暴露出去让渲染层自己加，比在主进程猜更可靠。
 */
ipcGuard.handle('window-position', () => {
  if (!win || win.isDestroyed()) return { x: 0, y: 0 };
  const pos = win.getPosition ? win.getPosition() : [0, 0];
  return { x: pos[0] || 0, y: pos[1] || 0 };
});

/** 视觉审计（只记元数据；绝不记像素与 OCR 文本） */
function appendVisionAudit(entry) {
  try {
    const dir = app.getPath('userData');
    const line = {
      at: entry.at || new Date().toISOString(),
      stage: typeof entry.stage === 'string' ? entry.stage.slice(0, 32) : null,
      width: Number.isFinite(entry.width) ? entry.width : null,
      height: Number.isFinite(entry.height) ? entry.height : null,
      elapsedMs: Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : null,
      visionTokens: Number.isFinite(entry.visionTokens) ? entry.visionTokens : null,
      errorType: typeof entry.errorType === 'string' ? entry.errorType.slice(0, 40) : null
    };
    fs.appendFileSync(path.join(dir, 'vision-audit.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  } catch (err) { /* 审计写失败绝不外抛 */ }
}

app.whenReady().then(() => {
  console.log([
    '',
    '        . ~ ~ ~ ~ ~ .',
    '    . ~   . - - - .   ~ .',
    '   /   ~\'   . - .   \'~   \\     Life — Chulan · 2026',
    '  |   :    (  o  )    :   |    Copyright (c) andabaoyue',
    '   \\   ~.   \' - \'   .~   /',
    '    \' ~   \' - - - \'   ~ \'',
    '        \' ~ ~ ~ ~ ~ \'',
    ''
  ].join('\n'));
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
  brain = new Brain(app.getPath('userData'), cfg, { getSS });
  // 换装执行器 + 本地活动追踪器注入：模型给提案 -> wardrobe 落真实状态 ->
  // 结果写回历史；她被戳了几下 -> tracker 记账 -> 随当轮 user 消息如实告知。
  bindBrainDeps(brain);
  // 🔴 D-17：把「挂机基准 / 自发愿望阈值」从配置传进引擎（默认 30 / 120 分钟，行为不变）。
  //   联调验证时改 life-config.json 的两项即可整体调小 ——
  //   而 **trigger.js 里那道 `idleMs >= idleNeed` 铁律一字未动**。
  trigger = new TriggerEngine(tracker, {
    idleMs: cfg.agentIdleMinutes * 60000,
    selfNoteIdleMs: cfg.agentSelfNoteIdleMinutes * 60000,
  });
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

  /* 🔴 D-13：执行成功后，把她写的东西登记进她的记忆队列 —— 让她**下一次开口时读得到**。
   *
   * ## 补的是哪个洞
   *   反重力复核 D-10~D-12 时指出：她写进沙盒的字，程序从来不读，
   *   信息单向流出，像一套**脱机的遥测系统** ⇒ 她写完就忘。
   *
   * ## 为什么在这里（主进程），而不是渲染端回报
   *   `onExecuted` 由 agent-ipc 在**执行成功之后**调用，且带着主进程求得的 content
   *   （D-11 的暂存内容，`takeStashedContent` 已 read-and-delete）。
   *   若改成让渲染端回报，内容来源就成了不可信输入 ——
   *   等价于「她写下的东西可以由渲染端改写」。
   *
   * ## 三条纪律（与 agent-ipc 侧同源）
   *   1. 只在执行成功时触发（决策 4：失败不告诉她、也不入队）
   *   2. 异常一律吞掉 —— 它挂在执行成功之后，抛错会让用户以为写入失败
   *   3. 不 await —— 只是登记，不该拖住 IPC 返回
   *
   * ## 决策 1/2/3 的落点
   *   1 不进聊天气泡：本 hook 只喂 memory 队列，**不 broadcast、不碰任何 UI**。
   *   2 一次性：由 memory._drainSelfNotes() 出队保证。
   *   3 她说不写/写失败：压根不会走到这里（execute 未成功 ⇒ 不触发）。
   */
  const agentOnExecuted = (info) => {
    try {
      if (!brain || !brain.memory || typeof brain.memory.addSelfNote !== 'function') return;
      if (!info || typeof info.content !== 'string' || !info.content.trim()) return;
      // 🔴 D-24：来源戳一并登记（'selfNote' = 她自发写下的字，将来才可能铸进她的自传）
      const ok = brain.memory.addSelfNote({ content: info.content, name: info.name, source: info.proposalSource });
      if (ok) console.log('[Agent] 她写过的东西已登记，下次开口时她读得到:', String(info.name || '').slice(0, 60));
    } catch (err) {
      // 纪律②：登记失败绝不能影响执行结果本身。
      console.error('[Agent] 自述登记失败（不影响写入）:', err && err.message);
    }
  };

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
    onExecuted: agentOnExecuted,   // 🔴 D-13：她写过的东西回流进她的意识（见上方注释）
    // 🔴 D-18：把暂存内容的取用口注入给 agent-ipc。
    //
    //   漏了它的后果（实测抓到）：主进程自动执行时 `executeInternal` 取不到
    //   `takeStashedContent` ⇒ effectiveContent 为空 ⇒ 执行器抛 CONTENT_REQUIRED
    //   ⇒ **建案成功但永远落不了盘**。审计里只留一句 detail:"CONTENT_REQUIRED"。
    //
    //   ⚠️ 这条接线在 D-13 就该有：暂存表在 main.js、取用口在 agent-ipc，
    //      「谁把口子递过去」当时漏了。之前没暴露是因为**没有主进程自动执行路径**
    //      （用户点卡片时走通道，通道里另有 raw.content 兜底）。
    takeStashedContent,
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
  agentBuildDeps = { agentIpc, agentSandbox, broadcastToWindows, agentBudget, takeStashedContent };

  // 🔴 v1.7-a：权限闸门必须在**任何 BrowserWindow 创建之前**装好。
  //   装晚了的话，窗口已经发出的权限请求走的是默认行为 —— 那正是本闸门要消除的赌。
  //   失败不阻塞启动：她仍能正常对话，只是麦克风类请求会退回默认行为（并留一条日志）。
  if (!installPermissionGate(session.defaultSession)) {
    console.warn('[Security] 权限闸门安装失败：当前 Electron 版本的 session 不支持 handler');
  }

  createWindow();

  /* 🔴 2026-10-19：系统从 Modern Standby / 休眠回来后对齐主动搭话的调度。
   *
   *   为什么必须有这一条：挂起的整段时间里 setTimeout 不走表（进程被冻结），
   *   醒来后那个「旧的下一次」可能已经是一个多小时前就该响的约定 —— 而 Electron
   *   在 Windows Modern Standby 下不保证补发到点回调。实测 2026-10-19 一整夜：
   *   系统 22:30 进 Modern Standby，只在 02:35 / 03:29 / 05:09 / 05:39 / 06:10
   *   五次维护性唤醒的缝隙里动了一下，其余时间整条主动搭话链是静止的。
   *
   *   ⚠️ 醒来先隔一个冷却（45 秒）再复查，不立刻弹：刚睁眼就说话是最像「软件」的形态。
   *   ⚠️ powerMonitor 在部分环境（无头、测试桩）不存在或没有 .on —— 必须判空。 */
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    try {
      powerMonitor.on('resume', () => scheduleProactiveCheck(COOLDOWN_MS));
    } catch (e) { /* 电源事件不可用不影响任何既有功能 */ }
  }

  // v1.0 系统托盘：水波微澜专用图标（assets/tray.png / tray.ico）+ 双击呼出对话 + 右键菜单；退出严守安全退出链
  try {
    const trayIcoPath = path.join(__dirname, 'assets', 'tray.ico');
    const trayPngPath = path.join(__dirname, 'assets', 'tray.png');
    const iconFile = (process.platform === 'win32' && fs.existsSync(trayIcoPath))
      ? trayIcoPath
      : (fs.existsSync(trayPngPath) ? trayPngPath : path.join(__dirname, 'assets', 'pet.png'));
    const trayIcon = nativeImage.createFromPath(iconFile);
    tray = new Tray(trayIcon);
    tray.setToolTip('Life');
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
  if (powerMonitorSource && typeof powerMonitorSource.stop === 'function') powerMonitorSource.stop();
  if (brain && typeof brain.flushAll === 'function') brain.flushAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();   // v1.0 全局快捷键彻底注销
});

app.on('window-all-closed', () => {
  if (brain && typeof brain.flushAll === 'function') brain.flushAll();
  app.quit();
});
