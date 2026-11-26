const pet = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const menu = document.getElementById('menu');
// v1.0 记录退役：#log / #logBody 元素已随面板拔除
const panel = document.getElementById('panel');
const researchPanel = document.getElementById('researchPanel');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const figure = document.getElementById('figure');
const layerBox = document.getElementById('layers');
const spriteImg = document.getElementById('sprite');
const shadowBox = document.getElementById('shadow');

// 注意：不能叫 window.pet —— 页面上有 <div id="pet">，
// 浏览器会把带 id 的元素自动挂成全局变量，两者会撞车。
const api = window.deskpet || null;
let stageUi = null, wardrobeUi = null, settingsUi = null, researchUi = null;

/* ---------------- 自然动画系统 V1 ----------------
   用户交互 / ActivityTracker / Trigger
           ↓
   BehaviorScheduler（自主行为微动作调度）
           ↓
   AnimationController（初澜姿态动力学与状态机）
           ↓
   DomAnimationRenderer（DOM / CSS Transform 渲染适配器）
           ↓
   DOM 层 (#figure, #layers, #shadow, .layer)
*/
let animRenderer = null;
let animController = null;
let behaviorScheduler = null;

if (typeof DomAnimationRenderer !== 'undefined' && typeof AnimationController !== 'undefined') {
  animRenderer = new DomAnimationRenderer({
    petElement: pet,
    figureElement: figure,
    layersElement: layerBox,
    spriteElement: spriteImg,
    shadowElement: shadowBox
  });

  animController = new AnimationController({
    renderer: animRenderer
  });
  animController.start();

  if (typeof BehaviorScheduler !== 'undefined') {
    behaviorScheduler = new BehaviorScheduler({
      profile: 'production', // 生产环境配置（3分钟静默，2~5分钟冷却）
      controller: animController,
      politeCheck: () => {
        if (typeof streaming !== 'undefined' && streaming) return false;
        if (typeof busy !== 'undefined' && busy) return false;
        if (bubble && !bubble.classList.contains('hidden')) return false;
        // v1.0 演进：输入条退役后，「用户正在打字」由「对话窗正在对话」接棒（chatBusy 闸）
        if (typeof remoteStreaming !== 'undefined' && remoteStreaming) return false;
        if (stageUi && stageUi.isDragging()) return false;
        return true;
      }
    });

    // Phase 0.5 (P0-1): 接通主进程权威 InternalRegulation 状态同步通道，绝不复制第二具身体
    if (typeof api !== 'undefined' && api) {
      let currentSyncedState = null;
      const regulationProvider = {
        getState: () => currentSyncedState
      };
      if (typeof api.getInternalRegulation === 'function') {
        api.getInternalRegulation().then(state => {
          if (state) currentSyncedState = state;
        }).catch(() => {});
      }
      if (typeof api.onInternalRegulation === 'function') {
        api.onInternalRegulation(state => {
          if (state) currentSyncedState = state;
        });
      }
      behaviorScheduler.setInternalRegulation(regulationProvider);
    }

    behaviorScheduler.start();
  }

  if (typeof window !== 'undefined') {
    window.__animController = animController;
    window.__animDebug = () => animController ? animController.getDebugSnapshot() : null;
  }
}

function syncMotionPriority() {
  if (!api || !api.motionUiState) return;
  api.motionUiState({
    bubble: !bubble.classList.contains('hidden'),
    talking: document.body.classList.contains('talking'),
    chatBusy: busy,
    hidden: typeof anyOverlayOpen === 'function' ? anyOverlayOpen() : false   // v1.0 记录退役：showlog 让位机制随面板拔除
  });
}

const FALLBACK = [
  '今天也要一起变得更好哦~',
  '累了就休息一下，我陪你。',
  '喝口水吧，别一直盯着屏幕~'
];

/* ---------------- 气泡 ---------------- */
let bubbleTimer = null, streaming = false, remoteStreaming = false;
let lastText = '';        // 最近一次上屏的文本，用于收尾去掉光标

// 模型被要求在末尾附 [state:xx]（换装提案 [wear:id] 排在它前面）。
// 上屏前把它们（含流式期间没吐完的前缀）剪掉。
// 规则：完整标记（容忍冒号后空格、句末标点尾巴）；半截前缀（流式瞬态）。
/* 尾部标记遮蔽：[state:xx] 与 [wear:id]。
   与后端 parseState/parseWear 同一条铁律——未知值不剥离，
   宁可屏幕上多一个怪标记，也不能把正文掏空。
   合法的 wear id 集合来自衣柜 catalog（启动时注入），
   保证渲染端藏起来的和后端剥掉的永远是同一批。 */
function render(text, withCursor = streaming) {
  lastText = text;
  const shown = stripState(text, streaming || remoteStreaming);
  bubble.textContent = '';
  // 正文必须装进一个真实的子元素：#bubble 用 flex + justify-content:flex-end
  // 把溢出裁在顶部，靠的是"有一个可对齐的盒子"。
  // 直接塞裸文本节点的话它会变成匿名 flex item，对齐行为不保证。
  const body = document.createElement('span');
  body.className = 'bubble-text';
  body.textContent = shown;
  // 光标必须放进 body 里：#bubble 现在是纵向 flex，
  // 当成兄弟节点插会被挤到下一行独占一格。
  if (withCursor) {
    const c = document.createElement('span');
    c.className = 'cursor';
    c.style.display = 'inline-block';
    body.appendChild(c);
  }
  bubble.appendChild(body);
  bubble.classList.remove('hidden');
  syncMotionPriority();
  fitBubble();
}

/**
 * 气泡可用高度 = 窗口高 - 立绘已经占掉的高 - 底部输入区 - 一点余量。
 * 之所以要在 JS 里量而不是写死：立绘宽度会随缩放变（#pet 120~420px），
 * 而 CSS 里的像素高度是内容撑出来的，只有实测才知道头顶还剩多少。
 *
 * 关键是「无条件写入」：以前只在 room > 40 时才写，结果窗口缩小到量不出
 * 空间时，属性还留着上一次（更大窗口）算出的值，气泡照样顶出窗口上沿。
 * 现在永远写，只夹一个下限 —— 宁可只露一行字（完整内容在记录面板里，
 * 一个字都不丢），也不能让已经量出来的剩余空间被忽略。
 */
function fitBubble() {
  const h = figure.offsetHeight || 0;
  const petBottom = parseFloat(getComputedStyle(pet).bottom) || 0;
  const room = window.innerHeight - petBottom - h - BUBBLE_SAFE;
  document.documentElement.style.setProperty('--bubble-max',
    Math.max(BUBBLE_MIN, Math.round(room)) + 'px');
}
const BUBBLE_SAFE = 46;   // 输入框那一行的高度余量
const BUBBLE_MIN = 48;    // 一行字 + 上下 padding：再小就不是气泡而是黑块了

/* 立绘宽度 = 窗口宽 × 这个比例，对应 style.css 里 #pet 的初始 210px
   （窗口初始 340 宽）。为什么由窗口反推而不是各长各的：
   Electron 下"放大/缩小"同时做两件事 —— api.resize() 改窗口、grow() 改立绘，
   两边夹取范围不同（窗口 200~760，立绘 120~420）。实测连按放大到第 5 次起
   窗口还在长（685→760）、立绘已经卡在 420，比例从 0.617 掉到 0.553，
   表现就是"人变小了、气泡框变大"，缩放越狠越明显。
   现在窗口是唯一出处：resize 事件里按窗口宽重算立绘宽，grow() 只在
   没有 bridge 的预览模式里当手动挡。
   预览模式的小代价：手动放大后再扭浏览器窗口，手动尺寸会被按比例覆盖 ——
   预览页是测试用的，不是用户界面，这个方向比"两个尺寸各长各的"清楚。 */
const PET_RATIO = 210 / 340;
/* v1.0 像素换代·缩放退役（用户拍板）：体型固定、无缩放档 ——
   立绘宽度恒为 PET_BASE_W；窗口只随面板家族扩收（panel-viewport 收口复位基准），
   永不因体型而动。像素画铁律：日后显示一律走「原生 × 整数倍」。 */
const PET_BASE_W = 64;   // v1.0 像素换代：64 原生 1:1（极致精致小巧的掌心桌宠体型，点阵绝对清晰，守住像素整数倍铁律）
/* 面板互斥（v1.0 用户实测）：任一满幅面板在场时先收掉其余 —— 不叠层、深底不叠染她 */
function closeOtherOverlays(keepId) {
  if (keepId !== 'wardrobe') {
    const wd = document.getElementById('wardrobe');
    if (wd && !wd.classList.contains('hidden')) toggleWardrobe(false);
  }

  if (keepId !== 'research' && researchPanel && !researchPanel.classList.contains('hidden')) closeResearchPanel();
  if (keepId !== 'panel' && panel && !panel.classList.contains('hidden')) closePanel();
}

function anyOverlayOpen() {
  const wd = document.getElementById('wardrobe');   // 衣橱（v1.0 独立面板）
  // D-5：把 Agent 确认卡片纳入。
  //
  // ⚠️ 理由必须写对，否则会误导后人（DSH 初稿写成"模态层不许拖动"，是错的）：
  //   这里**不是拖拽拦截**，是**鼠标穿透**开关。anyOverlayOpen() 为真时，
  //   updateMouseIgnore() 走的是 setIgnoreMouseEvents(false) —— 关掉穿透，
  //   好让浮层上的东西能被点到。
  //   若不纳入 agentConfirm，卡片亮起时透明区仍在穿透，
  //   用户就**点不到【授权】/【拒绝】两个按钮** —— 那道闸门等于废了。
  //
  //   而桌宠的拖拽能力**不该被一张卡片夺走**：startWindowDrag()（本文件下方）
  //   只判 e.button，不查 anyOverlayOpen()，所以卡片亮起时照常能拖。
  const ac = document.getElementById('agentConfirm');
  return (panel && !panel.classList.contains('hidden'))
      || (wd && !wd.classList.contains('hidden'))
      || (researchPanel && !researchPanel.classList.contains('hidden'))
      || (ac && !ac.classList.contains('hidden'));
}

/* ---------------- Agent 用户确认卡片（v1.0 D-3 第四道闸门） ----------------
   接线原则（与 ui-agent-confirm.js 的边界一致）：
     · 卡片默认 hidden，**只有真的拿到提案才show()** —— 凭空出现的确认框
       会被用户当系统弹窗闭眼点【授权】，那道闸门就白设了。
     · 渲染层只做「把用户点击如实上报」，不执行任何动作。
       confirm通道的executed 恒为 false，主进程那边还有确认闸门独立判定。
     · 提案被拒时**不弹卡片** —— 主进程已经拒了，再问用户是噪声。*/

/* 🔴 D-27 复核修订（D-1 并发）：**待决卡片队列**。
 *   拟稿是并行的异步调用，两轮对话可以各触发一次，广播完成顺序不定；
 *   而确认卡是**单容器**（`ui-agent-confirm.js` 的 `show()` 语义就是覆盖）。
 *   没有队列的话，后到的卡片会把前一张直接盖掉 —— 前一条提案在主进程
 *   `proposalStore` 里还活着（TTL 10 分钟），但用户在界面上再也看不到它。
 *
 *   ⚠️ 为什么队列放在这里而不是 `ui-agent-confirm.js`：
 *     那个模块的契约是「**渲染一张卡**」，`show()` 覆盖是它的既定语义，
 *     既有门禁（`test/ui-agent-confirm.test.js`）也按这个契约写。
 *     把排序职责塞进渲染层会同时破坏那个契约和那批断言。
 *     **排序是应用层的事** —— pet.js 这里才是决定「先给用户看哪一张」的地方。
 *
 *   🔴 顺序要求（别挪到 agentConfirmCard 之后）：
 *     决策回调里会调 `drainCardsNextTick()`。函数声明虽会提升，
 *     但 `pendingCards` / `pendingCardIds` 是 `const`，处于 TDZ ——
 *     若把它们放在回调之后，第一次点按钮就会 ReferenceError。
 */
const MAX_PENDING_CARDS = 8;
const pendingCards = [];
/** 去重集合：**既含队列里的等待项，也含正在回查/正在展示的那一条**。
 *  🔴 复核 D-1 修订：原来这个集合只装等待项，而「正在展示」那一条在
 *     `show()` 成功后才由 `agentConfirmCard.isVisible()` 体现。
 *     中间那段**回查快照的 await 窗口**里，`isVisible()` 仍是 false ——
 *     第二条信号于是也走「直接展示」，两条 `show()` 互相覆盖。
 *     实测：50ms 延迟下 A/B 两条信号同时到，`shown = ["A","B"]`，
 *     A 的卡片被 B 顶掉且再也回不来（A 已不在队列里）。
 *  ⇒ 现在的判据：**集合里有没有这个 id**，而不是「卡片可不可见」。
 *     id 在进入处理流程时加入，展示结束/决策完成后移除。 */
const pendingCardIds = new Set();
/** 正在展示的那一条（用于 drain 时判断"该不该再亮一张"）。 */
let activeCardId = null;

/* 🔴 D-27：用户点完一张卡，接上下一条。
 *   挂点选在**决策回调的末尾**（`agentConfirmCard` 的 onDecision），
 *   而不是去改 `ui-agent-confirm.js` —— 那个模块不该知道"队列"存在。
 *
 *   ⚠️ 为什么必须延迟一拍：`ui-agent-confirm` 的点击处理器是
 *     `try { await onDecision(...) } finally { hide() }`，
 *     回调返回时卡片**还没**隐藏。若在回调里直接 drain，
 *     `isVisible()` 仍为 true，下一条会被再次塞回队列。
 *     用 setTimeout(0) 排到宏任务，此时 hide() 已跑完。
 *   ⚠️ 这**不是轮询**（D-001 禁的是连续定时器）：每次决策只排一次，不循环。 */
function drainCardsNextTick() {
  try {
    setTimeout(() => { void drainPendingCards(); }, 0);
  } catch (_) { /* 静默 */ }
}

const agentConfirmCard = (typeof window.AgentConfirm !== 'undefined' && window.AgentConfirm)
  ? window.AgentConfirm.bind(
    document.getElementById('agentConfirm'),
    async (decision, proposalId) => {
      // 🔴 复核 D-1 修订：整段包进 try/finally。
      //   原来 confirm 不可用或抛错时**提前 return**，而卡片随后仍会被
      //   `ui-agent-confirm` 的 finally 隐藏 —— 于是队列再也没人接，
      //   后面所有待决提案静默滞留（既不消失也不出现）。
      //   drain 必须在 finally 里安排，与「这一张成没成」无关。
      try {
        if (!api || !api.agent || typeof api.agent.confirm !== 'function') return;
        try {
          await api.agent.confirm({ proposalId, decision });
        } catch (e) {
          // 上报失败就静默收起卡片：留着半张卡比不弹更糟，
          // 而审计里主进程已记了「确认未送达」。
          return;
        }

        // 🔴 D-12 修：**确认之后必须真的执行** —— 否则用户点了【授权】什么都不会发生。
        //
        //   实测（反重力复核）：`api.agent.execute` 全仓调用点为 0。
        //   confirm 通道的注释写得很明白「只登记决策，绝不执行」——
        //   但**没有任何地方负责接着执行**，于是卡片点了授权、沙盒里永远没有文件。
        //
        //   ⚠️ 三条边界：
        //     1. **只有 approved 才执行。** rejected 是终态，不该落盘。
        //     2. **不传 content。** 主进程若为该提案暂存了内容（D-11 她为自己写的话），
        //        由主进程侧取用；渲染端传的话反而可能覆盖她的原话。
        //        普通通路（用户让她写）的 content 也应由主进程决定 ——
        //        渲染端能自造内容 = 她能写的东西由渲染端决定，那是条不该开的口子。
        //     3. **失败静默**。执行结果主进程有审计；渲染端出错不该影响别的东西。
        if (decision === 'approved' && typeof api.agent.execute === 'function') {
          try {
            await api.agent.execute({ proposalId });
          } catch (e) {
            // 静默：审计里主进程已记录拒绝原因。
          }
        }
      } finally {
        // 🔴 D-27：这一张决策完了（**无论成没成**）—— 接上队列里的下一条。
        //   释放占位 + 延一拍 drain（`ui-agent-confirm` 的 hide() 在本回调返回后才执行）。
        releaseActiveCard(proposalId);
        drainCardsNextTick();
      }
    },
    (k, f) => (typeof t === 'function' ? t(k, f) : f),
    {
      onFetchContent: (proposalId) => (api && api.agent && typeof api.agent.getProposalContent === 'function'
        ? api.agent.getProposalContent(proposalId)
        : null)
    }
  )
  : null;

/** 有Agent 提案时亮卡片。proposal 为空则收起（不会误亮）。
 *  🔵 接线状态（2026-10-30 D-27 复核更新，原文已过时）：
 *    **本函数现在真的有调用点** —— `showProposalById()`（本文件下方）会调用它，
 *    链路是：主进程广播 `agent-proposal-pending` → `onProposalSignal`
 *    → 回查冻结快照 → `showProposalById` → 本函数。
 *    ⚠️ 原文写的「全仓零调用点 / 确认卡片永远不会出现」是 D-4 时期的事实，
 *      已经随着 D-27 接通通路 B 而失效。留着会让后来者以为卡片还没接上。
 *  接线时必须一并处理的两条（**仍然成立**）：
 *    ① anyOverlayOpen() 未把 agentConfirm 算进去 —— 卡片亮起时
 *       面板视窗不会被正确扩收，可能与其他浮层打架
 *       （实测：`anyOverlayOpen()` 里已把 agentConfirm 纳入，见本文件上方）；
 *    ② 提案来源必须是主进程的真实提案对象（proposalStore 里那一份），
 *       绝不能让渲染端自己编一个 —— 那正是 id 顶替攻击的入口
 *       （已落实：只收 proposalId，快照一律回查主进程）。
 */
async function showAgentProposal(proposal) {
  if (!agentConfirmCard) return false;
  try {
    const st = (api && api.agent) ? await api.agent.getStatus() : null;
    const vmCaps = (api && api.agent) ? await api.agent.getCapabilities() : null;
    // 危险等级取自主进程的能力元数据 —— 渲染层不自己判断危险度。
    const name = proposal && proposal.capability;
    const meta = (vmCaps && Array.isArray(vmCaps.capabilities))
      ? vmCaps.capabilities.find((c) => c && c.name === name) : null;
    return agentConfirmCard.show(proposal, {
      t: (k, f) => (typeof t === 'function' ? t(k, f) : f),
      budget: (st && st.budget) || null,
      dangerLevel: (meta && meta.dangerLevel) || 'unknown',
    });
  } catch (e) {
    return false;
  }
}
/* 🔴 D-10 / D-27：主进程建案后亮确认卡 —— showAgentProposal 从「零调用点」到真正接线。
 *
 *   链路：主进程 [形态校验 → 授权 → 预算 → 建案] → 广播 agent-proposal-pending
 *         → 本处收到 → 回查冻结快照 → showAgentProposal(快照)
 *
 *   ⚠️ 三条边界：
 *     1. **只收 proposalId，不收提案对象**。快照必须回查主进程（D-5 定的安全设计）——
 *        渲染端拿到的永远是 Object.freeze 的只读快照，篡改它没有用处。
 *     2. **取不到就不亮卡**。过期/已决策/不存在一律静默 ——
 *        凭空弹一张确认框比不弹更糟（用户会闭眼点授权，那道闸门就白设了）。
 *     3. **异常静默**。这是她说话之后触发的旁路，绝不能反向影响对话。
 *
 * 🔴 D-27：抽成具名函数，**两个事件共用这一份**。
 *   为什么不复用 `agent-proposal-available` 那个名字：D-19 判定它语义歧义
 *   （「已执行完」与「待你决定」共用过它，导致自发便签写成后仍弹多余授权卡）。
 *   新链路用语义明确的 `agent-proposal-pending`；旧名字保留监听只为兼容，
 *   主进程侧**零发送点**，所以它现在是一条死通道，不会带来任何多余卡片。
 *
 *   🔵 队列定义与 drainCardsNextTick 已上移到 `agentConfirmCard` 之前
 *      （原因见那里的「顺序要求」注释）；此处只留事件处理。 */

/** 展示一张卡；成功返回 true。
 *  🔴 复核 D-1：本函数**会先把 id 记进 `pendingCardIds` 占位**，成功才转入 active。
 *     这样「回查快照的 await 窗口」也被锁住 —— 那正是竞态发生的地方。 */
async function showProposalById(id) {
  // 占位（若调用方已经占过则保留）
  pendingCardIds.add(id);
  try {
    const snap = await api.agent.getPendingProposal(id);
    if (!snap || snap.ok !== true || !snap.proposal) {
      // 取不到（已决策/过期/不存在）：**无条件还回占位**
      //   ⚠️ 不能只还"本次新加的"：drain 取出来的那一条占位是
      //     onProposalSignal 加的（wasTracked 为 true），只还自己加的会泄漏 ——
      //     那个 id 永久留在集合里，等于把队列名额吃掉一格。
      pendingCardIds.delete(id);
      return false;
    }
    const ok = await showAgentProposal(snap.proposal);
    if (ok) {
      activeCardId = id;      // 成功展示：由 active 持有，决策后由 releaseActiveCard 释放
    } else {
      pendingCardIds.delete(id);
    }
    return ok;
  } catch (e) {
    pendingCardIds.delete(id);
    return false;
  }
}

/** 队列里取下一条并展示（跳过已失效的）。
 *  🔴 复核 D-1：**不再在展示前就把 id 从集合删掉** —— 那会让它重新变成
 *     "可见的"候选，进而被第三条信号重复处理。改为展示成功才由 active 接管。
 *     ⚠️ 另外：`activeCardId` 仍在展示时不 drain（避免把当前这张顶掉）。 */
async function drainPendingCards() {
  if (agentConfirmCard && agentConfirmCard.isVisible()) return false;
  while (pendingCards.length > 0) {
    const next = pendingCards.shift();
    // ⚠️ 保留 id 在集合里（占位），由 showProposalById 的 active 逻辑接管
    if (await showProposalById(next)) return true;
  }
  return false;
}

/** 用户完成一张卡的决策后：解除占位，准备接下一张。 */
function releaseActiveCard(proposalId) {
  const id = proposalId || activeCardId;
  if (id) pendingCardIds.delete(id);
  if (activeCardId === id) activeCardId = null;
}

async function onProposalSignal(payload) {
  let id = null;
  try {
    id = payload && payload.proposalId;
    if (!id) return;
    // 边界 1：去重（集合含**等待项 + 正在回查/展示**的那一条）
    if (pendingCardIds.has(id)) return;

    // 🔴 复核 D-1 关键一步：**先占位，再 await**。
    //   若等 showProposalById 内部去占位，那么在它进入 await 的**同一拍之前**
    //   第二条信号可能已经跑到这里读过 has(id) —— 两条都判定"没有"，
    //   于是都去 show，后者覆盖前者（实测：A/B 同时到达时 shown=["A","B"]）。
    //   占位必须在**本函数同步段内**完成，判据才不会被 await 撕开。
    pendingCardIds.add(id);

    // 🔴 复核 D-1 修正：busy 的判据**不能只看 activeCardId/isVisible()** ——
    //   两者都只在"已经展示出来"之后才为真，而 A 在 `await getPendingProposal`
    //   的那段窗口里两个都是 false。于是 B 也判"空闲"→ 两条都 show → 覆盖。
    //   ⭐ 真正可靠的判据：**占位集合里除自己之外还有没有别人**。
    //     占位是在同步段加、在展示成功（转 active）或失败（归还）时才变，
    //     所以它不会被 await 撕开。
    const someoneElseInFlight = pendingCardIds.size > 1
      || activeCardId !== null
      || (agentConfirmCard && agentConfirmCard.isVisible());

    if (!someoneElseInFlight) {
      if (await showProposalById(id)) return;
      // 亮不出来（已失效）：继续尝试队列里已有的，避免队列被卡死
      await drainPendingCards();
      return;
    }
    // 边界 2：上界
    if (pendingCardIds.size >= MAX_PENDING_CARDS) {
      const dropped = pendingCards.shift();
      if (dropped) {
        pendingCardIds.delete(dropped);
        console.warn('[Agent] 待决卡片队列已满，丢弃最早的一条:', String(dropped).slice(0, 40));
      }
    }
    pendingCards.push(id);
  } catch (e) {
    // 边界③：静默。亮卡失败不该影响任何别的东西。
    pendingCardIds.delete(id);
  }
}

/* 🔴 D-27：用户点完一张卡，接上下一条。
 *   挂点选在**决策回调的末尾**（`agentConfirmCard` 的 onDecision），
 *   而不是去改 `ui-agent-confirm.js` —— 那个模块不该知道"队列"存在。
 *
 *   ⚠️ 为什么必须延迟一拍：`ui-agent-confirm` 的点击处理器是
 *     `try { await onDecision(...) } finally { hide() }`，
 *     回调返回时卡片**还没**隐藏。若在回调里直接 drain，
 *     `isVisible()` 仍为 true，下一条会被再次塞回队列。
 *     用 setTimeout(0) 排到宏任务，此时 hide() 已跑完。
 *   ⚠️ 这**不是轮询**（D-001 禁的是连续定时器）：每次决策只排一次，不循环。 */
if (api && api.agent && typeof api.agent.onProposalPending === 'function') {
  api.agent.onProposalPending(onProposalSignal);
}
if (api && api.agent && typeof api.agent.onProposalAvailable === 'function') {
  api.agent.onProposalAvailable(onProposalSignal);
}

/* v1.0 缩放退役：零漂移账目随缩放一起退役（没有缩放档就没有欠账）。
   面板扩收仍走 panel-viewport，收口由主进程复位基准（main:360 实锤）。 */
/* 面板视窗家族化（v1.0）：设置/记录/实验任一在场 → 窗体扩到 440×680（满幅盖住她）；
   全部收口 → 回基准并按缩放档校正（零漂移契约的统一收口）。 */
function syncPanelViewport() {
  if (!api || !api.panelViewport) return;
  const open = anyOverlayOpen();
  // 按面板定宽（用户拍板）：设置/衣橱 560、记录 520、基础 440×680（最宽者胜）
  const wdEl = document.getElementById('wardrobe');
  let w = 440;

  if ((wdEl && !wdEl.classList.contains('hidden'))
      || (panel && !panel.classList.contains('hidden'))) w = 560;
  // v1.0 拓宽（用户拍板）：个体观测 620 —— 六分区一行横排 + 内容区宽敞
  if (researchPanel && !researchPanel.classList.contains('hidden')) w = 620;
  // v1.0 缩放退役：收口不再手动 resize —— panel-viewport(open=false) 自带基准复位
  api.panelViewport(open, w, 680);
}
/* v1.0 像素换代：zoomPet 退役（缩放档取消，体型永远 PET_BASE_W） */

// ---------- 拆分模块装配：Stage / Wardrobe / Settings / Research ----------
const STATES = (window.LifeUiPetStage && window.LifeUiPetStage.STATES)
  || ['idle', 'happy', 'curious', 'thinking', 'sleepy', 'embarrassed', 'annoyed', 'sad'];
setMarkContext({ STATES, knownWear: new Set(), wearCandidates: [] });
let busy = false;
let acc = '';
let liveNode = null;

function setState(s) { if (stageUi) stageUi.setState(s); }
function blink() { if (stageUi) stageUi.blink(); }
function relayout() { if (stageUi) stageUi.relayout(); }
const DRAG_IDLE_MS = (window.LifeUiPetStage && window.LifeUiPetStage.DRAG_IDLE_MS) || 2500;
if (typeof window !== 'undefined') {
  Object.defineProperties(window, {
    dragging: { get: () => !!(stageUi && stageUi.isDragging()), configurable: true },
    dragWatch: { get: () => (stageUi ? stageUi.getDragWatch() : null), configurable: true },
    moved: { get: () => (stageUi ? stageUi.getMoved() : 0), configurable: true }
  });
}
function applyLayers(layers) { if (stageUi) stageUi.applyLayers(layers); }
function updateSpriteAnim(state) { if (stageUi) stageUi.updateSpriteAnim(state); }
function setKnownWear(ids) { if (wardrobeUi) wardrobeUi.setKnownWear(ids); }
function wearIdsFrom(cat) { return wardrobeUi ? wardrobeUi.wearIdsFrom(cat) : []; }
function refreshWardrobe() { if (wardrobeUi) return wardrobeUi.refreshWardrobe(); }
function toggleWardrobe(on) { if (wardrobeUi) wardrobeUi.toggleWardrobe(on); }
function openPanel() { if (settingsUi) settingsUi.openPanel(); }
function closePanel() { if (settingsUi) settingsUi.closePanel(); }
function refreshStats() { if (settingsUi) return settingsUi.refreshStats(); }
function renderTimezonePanel() { if (settingsUi) settingsUi.renderTimezonePanel(); }
function openResearchPanel() { if (researchUi) return researchUi.openResearchPanel(); }
function closeResearchPanel() { if (researchUi) return researchUi.closeResearchPanel(); }

function say(text, ms = 3600) {
  if (streaming || remoteStreaming) return;
  clearTimeout(bubbleTimer);
  render(text);
  bubbleTimer = setTimeout(hideBubble, ms);
}

function hideBubble() {
  if (streaming || remoteStreaming) return;
  bubble.classList.add('hidden');
  syncMotionPriority();
  // 气泡收起 = 这一轮表现结束，状态必须回落 idle。
  // 否则 data-state 会一直挂着，单次动画（happy/annoyed）播完后
  // 桌宠就定格在最后一帧不再呼吸了。
  setState('idle');
}

function show(t) {
  render(t);
  // v1.0 记录退役：liveLog 更新随之拔除（话归对话历史，不归账本）
}

// 只注册一次。写在 submit 里会导致每发一条就多挂一个监听，
// 之后每次 delta 被回调 N 遍，文字重复叠加。
if (api) {
  api.onDelta((d) => {
    acc += d;
    if (streaming || remoteStreaming) show(acc);   // 双轨：对话窗说话时她身边同步吐字
  });
}

/* ---------- 双窗同步（v1.0 方案二）：对话窗的对话生命周期 → 她身边的反应 ---------- */
if (api && api.onChatBusy) {
  api.onChatBusy((p) => {
    if (p && p.busy) {
      clearTimeout(bubbleTimer);
      acc = '';
      remoteStreaming = true;
      setState('thinking');
    } else {
      remoteStreaming = false;
      if (bubble && !bubble.classList.contains('hidden')) {
        render(acc, false);
      }
      if (p && p.state) setState(p.state);
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(hideBubble, 6000);
    }
  });
}
if (api && api.onChatHidden) api.onChatHidden(() => setTalking(false));
// v2.0 睡相：她睡着时呼吸放缓（纯物理表现，零台词）
if (api && api.onSleepState) api.onSleepState((p) => {
  const sleeping = !!(p && p.sleeping);
  document.body.classList.toggle('sleeping', sleeping);
  if (animController && typeof animController.setSleeping === 'function') {
    animController.setSleeping(sleeping, 'ipc_sleep_state');
  }
});




/**
 * 发一条并走完整个上屏生命周期。用户主动说话和主动搭话**共用这一条路**，
 * 差别只有两处：
 *   - 记录面板里不写「你：…」（没人说过这句话，写了就是伪造记录）；
 *   - 换成一行系统说明，让她为什么开口是可查的。
 * 之所以不另写一套 proactive 的渲染分支：两套收尾逻辑早晚会像 v0.7.0 那次
 * 穿着块顺序一样，一套改了一套没改（比如忘了 streaming=false 或光标不清）。
 */
async function runChat(text, opts) {
  const proactive = !!(opts && opts.proactive);
  // 防御：掐掉上一句遗留的 6 秒收起定时器。
  // 现有 streaming 守卫 + 各分支的 clearTimeout 已覆盖已知路径，
  // 这行保证以后新增分支也不会被旧定时器误关气泡。
  clearTimeout(bubbleTimer);

  busy = true;
  syncMotionPriority();
  if (sendBtn) sendBtn.disabled = true;
  pet.classList.add('thinking');
  setState('thinking');
  streaming = true;
  acc = '';
  render('');


  try {
    if (!api) {                              // 浏览器预览：假回复，验证逐字渲染
      const demo = t('chat.demoBubble', '（预览模式）我还没接上 API，正式运行时这里会逐字回复你~');
      for (let i = 1; i <= demo.length; i++) {
        await new Promise(r => setTimeout(r, 40));
        show(demo.slice(0, i));
      }
      // v1.0 记录退役：预览演示不再写账本
      // 预览分支也要走完收尾生命周期，否则永远卡在 thinking 急促呼吸、
      // 气泡也不会定时收起 —— 收尾逻辑与真实分支保持同构。
      setState('idle');
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(hideBubble, 6000);
    } else {
      const res = await api.send(text, proactive ? { proactive, offer: opts.offer } : undefined);
      if (res.declined) {
        // 提案在主进程那边已经过期，这轮当没发生过：
        // 不上屏、不进记录面板 —— 写一行"她主动开口"却是她没说的话，就是伪造。
        // 连那条空的「初澜：」记录节点也要摘掉，否则"当没发生过"只是嘴上说说。
        if (liveNode) liveNode.remove();
        // streaming 必须先落回 false：hideBubble 在流式期间会直接 return，
        // 不改的话她就顶着一只空气泡卡在 thinking 动画里 —— 气泡收不掉，
        // 而且 politeToSpeak 从此永远返回 false（"上一条还没说完"），
        // 等于一次过期提案把她往后所有主动搭话都堵死。
        streaming = false;
        hideBubble();
      } else if (res.ok) {
        streaming = false;
        setState(res.state);
        show(res.text);
        // v1.0 记录退役：窗口小结/换装的客观汇报迁往对话窗客观事实行（chat.js chatNotice），
        // 如实口径不变：程序真换了才算换了，失败也要让用户看见。
        clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(hideBubble, 6000);
      } else if (res.needKey) {
        finish(t('chat.needKeyBubble', '(还没填 API Key，右键 → 设置 / 用量)'));
        openPanel();
      } else if (res.aborted) {
        finish(t('chat.abortedBubble', '(已取消)'));
      } else {
        // 🔴 2026-10-19：按错误类别给不同的话，别再一律「出错了：{error}」。
        //
        //   事故背景：Key 失效后 7 次主动搭话全被 401 拒掉，而界面只闪一句
        //   「出错了：HTTP 401 [auth_failed] …」6 秒就收 —— 人不在电脑前就等于没提示。
        //   现在：认证失败给**指路**的话（去设置重填 Key），网络类给可读的原因，
        //   其余保持原样（不替用户下结论）。
        finish(errorBubbleText(res), isAuthFailure(res) ? 15000 : 6000);
      }
    }
  } catch (e) {
    finish(t('chat.exceptionBubble', '(异常：{error})', { error: e.message }));
  } finally {
    streaming = false;
    busy = false;
    // 再渲染一次，把闪烁光标去掉（此时 streaming 已为 false）
    if (lastText) render(lastText);
    liveNode = null;
    if (sendBtn) sendBtn.disabled = false;
    pet.classList.remove('thinking');
    syncMotionPriority();
  }

  function finish(t, ms = 6000) {
    // 报错/取消也要退出 thinking，不然会一直卡在思考动画
    setState('idle');
    show(t);
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(hideBubble, ms);
  }
}

/** 认证失败判定（2026-10-19）：只认主进程给的 errorType，渲染端不猜状态码。 */
function isAuthFailure(res) {
  return !!res && res.errorType === 'auth_failed';
}

/** 失败要说人话（2026-10-19）。
 *
 *  ## 为什么需要这层映射而不是直接把 err.message 丢上屏
 *
 *  实测事故：Key 失效，transport 抛的是
 *  `HTTP 401 [auth_failed] provider=deepseek stage=request …`。
 *  这句话对开发者够用，对用户是噪音 —— 它没说「你该去干什么」。
 *  更要紧的是：**六秒后气泡自动收起**，用户离开一趟就再也不知道发生过什么。
 *
 *  所以：
 *    · 认证失败（401/403）⇒ 明确指路「去设置重填 Key」，并**延长显示**；
 *    · 网络类（network_error / timeout）⇒ 说清是连不上，不是她的问题；
 *    · 其余 ⇒ 保持原来的「出错了：{error}」，绝不替用户下结论。
 *
 *  ⚠️ 判定只认主进程给的 errorType（单一事实源），不在渲染端猜 HTTP 状态码。
 *  ⚠️ 这里不写任何审计 —— 审计在主进程（auditChatFailure），渲染端没有那个出口。 */
function errorBubbleText(res) {
  const type = (res && res.errorType) || '';
  const msg = (res && res.error) || '';
  if (type === 'auth_failed') {
    return t('chat.authFailedBubble',
      '(Key 失效了：服务端拒绝了这次请求。右键 → 设置 → 重新填 Key)');
  }
  if (type === 'network_error' || type === 'timeout') {
    return t('chat.networkFailedBubble', '(连不上服务端：{error})', { error: msg });
  }
  return t('chat.errorBubble', '(出错了：{error})', { error: msg });
}

// v1.0 方案二：主窗输入条已退役 —— 对话统一在独立对话窗（chat.html）进行

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (researchPanel && !researchPanel.classList.contains('hidden')) { closeResearchPanel(); return; }
    const wdEl = document.getElementById('wardrobe');
    if (wdEl && !wdEl.classList.contains('hidden')) { toggleWardrobe(false); return; }

    if (panel && !panel.classList.contains('hidden')) { closePanel(); return; }
    if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    if (document.body.classList.contains('talking')) { setTalking(false); return; }
  }
});

function setTalking(on) {
  document.body.classList.toggle('talking', on);
  // v1.0 方案二：对话已迁独立窗（chat.html）；此处只管主窗 talking 态语义
  syncMotionPriority();
  // v1.0 方案二：输入条已退役（input 恒 null）——守卫，别让开关对话抛异常
  if (on) setTimeout(() => { if (input) input.focus(); }, 30);
  else if (input) input.blur();
}

/* ---------------- 右键菜单 ----------------
   夹紧必须按菜单**实测高度**算，不能写死常数：
   原来写 innerHeight - 220，而实测菜单高 272px（8 项），
   差了 52px —— 底部几项（缩小/退出）跑到窗口外面，
   透明窗口不显示也点不到，看起来就像菜单少了两项。
   同理 left 那个 130 也是猜的。 */
pet.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  updateMenuI18n();
  menu.classList.remove('hidden');           // 先显示，才量得到尺寸

  const clampMenuToViewport = () => {
    updatePinLabel();   // 菜单每次现身都同步「固定/取消」真实状态
    const rect = menu.getBoundingClientRect();
    const top = Math.max(0, Math.min(e.clientY, window.innerHeight - rect.height));
    const left = Math.max(0, Math.min(e.clientX, window.innerWidth - rect.width));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
  };

  // 首次布局后按真实尺寸夹紧。
  clampMenuToViewport();

  // 字体/布局完成后尺寸可能再次变化（Linux headless CI 已观测到这一类
  // line-height 波动），再校正一次，避免“测量时 284px、最终 304px”导致
  // 菜单底部越界。这里不写死菜单高度。
  requestAnimationFrame(clampMenuToViewport);
});

window.addEventListener('mousedown', (e) => {
  if (!menu.contains(e.target)) menu.classList.add('hidden');
});

menu.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  menu.classList.add('hidden');
  if (!act) return;
  if (act === 'quit') return api && api.quit();
  if (act === 'talk') { setTalking(true); if (api && api.chatWindowOpen) api.chatWindowOpen(); return; }   // v1.0 方案二：对话入独立窗
  
if (act === 'wardrobe') return toggleWardrobe();   // v1.0：衣橱自设置独立，入菜单
  if (act === 'panel') return (panel && !panel.classList.contains('hidden')) ? closePanel() : openPanel();   // v1.0 toggle：再点即收
  if (act === 'research') return (researchPanel && !researchPanel.classList.contains('hidden')) ? closeResearchPanel() : openResearchPanel();   // v1.0 toggle：再点即收
  // 🔴 v1.8-b：屏幕视觉探针入口。
  //   ⚠️ 2026-10-20 重做：第一版把遮罩画在主窗里，用户实测「直接出了个小方块、
  //      然后不可操作」——主窗只有 256×320，且鼠标穿透把拖拽废了。
  //      现改为**开一个独立全屏窗**来框选（src/vision-picker-window.js）。
  if (act === 'vision') {
    if (api && api.vision && typeof api.vision.openPicker === 'function') {
      api.vision.openPicker();
    }
    return;
  }
  if (act === 'pin') {
    if (!api) return say(t('say.pinPreview', '预览模式没有窗口可固定'));
    api.togglePin().then((on) => {
      updatePinLabel();   // 拨完立刻同步文案
      say(on ? t('say.pinOn', '好啦，一直浮在最前面~') : t('say.pinOff', '取消置顶了，会被别的窗口盖住哦'));
    });
    return;
  }
  if (act === 'outline') {
    document.body.classList.toggle('outline');
    localStorage.setItem('outline', document.body.classList.contains('outline') ? '1' : '0');
    return;
  }
  // Electron 下只改窗口，立绘宽由 resize 监听按窗口宽重算（单一出处）；
  // 预览模式没有窗口可改，才由 grow() 自己管。
  // 两边都做的老写法会让窗口和立绘各自夹取，放大到顶时比例脱钩。
// v1.0 用户反馈：放大/缩小菜单项退役 —— 缩放交给滚轮（她身上滚动即可）
});

function updateMenuI18n() {
  const menuActs = {
    talk: 'menu.talk',
    wardrobe: 'menu.wardrobe',
    panel: 'menu.panel',
    research: 'menu.research',
    outline: 'menu.outline',
    quit: 'menu.quit'
  };
  for (const [act, key] of Object.entries(menuActs)) {
    const el = document.querySelector(`#menu [data-act="${act}"]`);
    if (el) el.textContent = t(key);
  }
  updatePinLabel();
}

function updatePinLabel() {
  const el = document.getElementById('menuPin');
  if (!el || !api || !api.pinState) return;
  api.pinState().then((p) => {
    el.textContent = t(p && p.pinned ? 'menu.unpin' : 'menu.pin');
  }).catch(() => {});
}

stageUi = window.LifeUiPetStage.initStage({
  pet, bubble, figure, layerBox, spriteImg, api,
  getAnimController: () => animController,
  getAnimRenderer: () => animRenderer,
  syncMotionPriority, anyOverlayOpen, fitBubble,
  getRenderState: () => ({ lastText }),
  renderBubble: (text, withCursor) => render(text, withCursor),
  noteUserAct, notePokeAndMaybeAsk, setTalking
});
stageUi.applyPetSize();
stageUi.bindPanelDrag(panel);

wardrobeUi = window.LifeUiWardrobe.initWardrobe({
  api, t, say, setMarkContext, STATES,
  closeOtherOverlays, syncMotionPriority, syncPanelViewport,
  completeOutfit, planOutfit,
  bindPanelDrag: (el) => stageUi.bindPanelDrag(el)
});

settingsUi = window.LifeUiSettings.initSettings({
  panel, api, t, setLocale, getTimezone, formatDisplayTime,
  getPreset, detectProviderByKey,
  say, closeOtherOverlays, syncMotionPriority, syncPanelViewport,
  updateMenuI18n,
  getRefreshWardrobe: () => refreshWardrobe
});

researchUi = window.LifeUiResearch.initResearch({
  researchPanel, api, t, formatDisplayTime,
  closeOtherOverlays, syncMotionPriority, syncPanelViewport,
  refreshLifeMechanisms: () => settingsUi.refreshLifeMechanisms(),
  refreshDreams: () => settingsUi.refreshDreams()
});

/* ---------------- 启动 ---------------- */
if (localStorage.getItem('outline') === '1') document.body.classList.add('outline');
if (!api) document.body.classList.add('preview');

if (api && api.onMotionState) {
  api.onMotionState((s) => {
    document.body.dataset.motionState = s && s.state ? s.state : 'idle';
    document.body.dataset.motionLabel = s && s.label ? s.label : '静止';
    updateSpriteAnim(s && s.state ? s.state : 'idle');
    if (animController) {
      const isMoving = s && (s.state === 'walking');
      animController.setMotion({
        isMoving,
        speed: s && s.speed ? s.speed : 2,
        direction: s && s.direction ? s.direction : 1,
        motionState: s && s.state ? s.state : 'idle'
      });
    }
  });
}

(async () => {
  let hasKey = true;
  if (api) {
    const g = await api.getConfig();
    hasKey = g.hasKey;
    // v1.0 时区真源同步（拍板 b）：self-ledger 权威，localStorage 只作同步缓存
    if (api.selfTimezone) {
      try {
        const tzRes = await api.selfTimezone(localStorage.getItem('genesisTimezone')
          || (Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || '');
        if (tzRes && tzRes.ok && tzRes.birthTimezone) {
          try { localStorage.setItem('genesisTimezone', tzRes.birthTimezone); } catch (e) { /* 存不下不致命 */ }
          if (settingsUi) settingsUi.setCompassBirthAt(tzRes.birthAt);
          renderTimezonePanel();
        }
      } catch (e) { /* 同步失败不影响启动 */ }
    }
    // 启动就拉一次衣柜：图层上屏 + 合法 wear id 注入（决定哪些标记会被遮蔽），
    // 不能等用户第一次打开面板才生效。
    try {
      const st = await api.wardrobeState();
      if (st && st.catalog) {
        setKnownWear(wearIdsFrom(st.catalog));
        applyLayers(st.layers);
      }
    } catch { /* 降级：单图皮套 */ }
  } else hasKey = false;

  if (hasKey) say(t('chulan.greeting', '嗨，我是初澜~'), 4200);
  else say(t('chulan.noKeyHint', '先右键 → 设置，填上 API Key 哦'), 6000);
})();

/* ---------------- 主动搭话 ----------------
   原则：她在陪着你，不是软件在骚扰你。三件事各管一头，别混：
     该不该说 —— 主进程判（它看得见静默时长、连戳次数、睡没睡）：
                  api.proactiveCheck() 拿回一份"提案"或 null；
     能不能说 —— 这里判（只有渲染端看得见输入框、气泡、上一条说完没）；
     何时来问 —— 这里定节奏：45 秒一个滴答，连戳到数再插队问一次。

   顺序是「先问该不该、再判能不能」。看着像反了，其实是定的：
   连戳提案要求"刚互动过也允许开口"（被戳本身就是互动，90 秒静默闸
   会把连戳这条整个饿死 —— 这是第一版真实踩到的坑），所以闸门规则要
   拿到提案的 kind 才知道用哪套。proactiveCheck 是本地 IPC，不花钱；
   真正花钱的 API 调用在两关都过了之后才发。

   预览模式（没有 api）退回原来的本地随机一句话：没接 key 就别烧钱。 */
let lastAuto = '';             // 上次本地文案，不重复
let lastUserAct = Date.now();  // 最近一次用户互动（发消息/点击/拖动）

function noteUserAct() {
  lastUserAct = Date.now();
  if (behaviorScheduler) behaviorScheduler.noteActivity();
}

/** 现在能不能开口。poke 放宽 90 秒静默闸 —— 见上面注释里的坑。 */
function politeToSpeak(kind) {
  if (streaming || busy || remoteStreaming) return false;   // 对话窗正在对话 = 用户正投入，不开口
  if (!bubble.classList.contains('hidden')) return false;
  // 用户正在输入：不打断
  if (input && (document.activeElement === input || input.value.trim())) return false;   // v1.0 方案二：输入条已退役（input 恒 null，守卫）
  if (kind === 'poke') return true;   // 被戳本身就是"现在方便"的意思
  // 刚互动过 90 秒内保持安静（idle 问候才需要这条）
  return Date.now() - lastUserAct >= 90000;
}

async function tryProactive() {
  if (!api || !api.proactiveCheck) return;
  if (busy || streaming || remoteStreaming) {
    // 🔴 D-7：闸门进不去也要回执。之前这里直接 return，
    //   主进程以为什么都没发生，下一轮立刻又问同一份提案——
    //   「她一直想说话但用户没理」于是变成无休止的轮询。
    //   ⚠️ 这一段不消耗冷却（冷却只由 commit() 记，见 main.js），
    //   但**必须重排下一次检查**，否则调度就此停摆。
    if (api.proactiveDeclined) api.proactiveDeclined(null);
    return;
  }
  let offer = null;
  try { offer = await api.proactiveCheck(); } catch { return; }
  if (!offer) return;   // 主进程说「现在别说」：正常态，不是拒绝，不回执
  if (!politeToSpeak(offer.kind)) {
    // 🔴 D-7：礼貌闸门拒了必须**回执**。
    //   这是「拒绝后不追问」的落点：她说了 ta 没说，主进程就该把这一轮
    //   收干净、按冷却退回去，而不是下一轮再端出同一份提案。
    //   ⚠️ 回执**不记账**：冷却与挂机刹车只由 commit() 在真的说出口时才动
    //   （见 main.js 与 trigger.js 的 evaluate/commit 分离注释）。
    //   记在这里会白烧一次冷却，而挂机那条更糟 ——
    //   spokenDuringIdle 被置位可她一个字都没说，那句问候永远补不回来。
    if (api.proactiveDeclined) api.proactiveDeclined(offer);
    return;
  }
  // v1.3-b: silent_presence 沉默留白第三种结局：零 LLM 调用，仅以微动作表达同在
  if (offer.kind === 'silent_presence') {
    executeSilentPresence(offer);
    return;
  }
  // 带 offer 发请求：主进程用它记账，且只有真的说出口才记（见 main.js）
  await runChat('（自言自语）', { proactive: true, offer });
}

/** 触发沉默留白微动作并向主进程记账 (v1.3-b) */
function executeSilentPresence(offer) {
  if (api && api.proactiveCommit) api.proactiveCommit(offer);
  if (animController && typeof animController.playAction === 'function') {
    animController.playAction('look_around', { duration: 2000, reason: 'silent_presence' });
  } else {
    setState('idle');
  }
}

/* 连戳的**调度计数**在渲染端：主进程看不到"现在是第几下"，
   它只在被问的时候用 tracker 的真账判定够不够格。这里数少了不触发、
   数多了主进程说不够 —— 判据始终只有一处（src/tracker.js），
   渲染端这份只是"什么时候值得去问一声"的闹钟。 */
const pokeStamps = [];
function notePokeAndMaybeAsk() {
  if (api && api.activity) api.activity('click');
  if (!api) return;
  const now = Date.now();
  pokeStamps.push(now);
  while (pokeStamps.length && now - pokeStamps[0] > 8000) pokeStamps.shift();
  // 只在**恰好跨过门槛**时插队问一次，戳第 6、7、8 下不再重复问
  if (pokeStamps.length === 5) tryProactive();
}

if (api && api.onAssetWarning) {
  api.onAssetWarning((report) => {
    if (!report.hasFallback && !report.hasLayers) {
      say(t('say.assetNotReady', '立绘资源未就绪，请按 ASSET-GENERATION-GUIDE.md 生成立绘放入 assets/'), 10000);
    }
  });
}

if (api && api.onProactiveOffer) {
  api.onProactiveOffer(async (offer) => {
    if (!offer) return;
    if (busy || streaming || remoteStreaming || !politeToSpeak(offer.kind)) {
      if (api.proactiveDeclined) api.proactiveDeclined(offer);
      return;
    }
    // v1.3-b: silent_presence 沉默留白第三种结局：零 LLM 调用
    if (offer.kind === 'silent_presence') {
      executeSilentPresence(offer);
      return;
    }
    await runChat('（自言自语）', { proactive: true, offer });
  });
}

// 预览模式（没有 api）退回原来的本地随机一句话
if (!api) {
  setInterval(() => {
    if (!politeToSpeak('idle')) return;
    if (Math.random() < 0.25) {
      const pool = [
        t('chulan.idle1', FALLBACK[0]),
        t('chulan.idle2', FALLBACK[1]),
        t('chulan.idle3', FALLBACK[2])
      ];
      let line = pool[Math.floor(Math.random() * pool.length)];
      if (line === lastAuto) line = pool[(pool.indexOf(line) + 1) % pool.length];
      lastAuto = line;
      say(line);
    }
  }, 45000);
}

// 页面卸载时注销主循环与计时器，杜绝后台泄漏
window.addEventListener('beforeunload', () => {
  if (researchUi) researchUi.stopReplayPolling();
  if (stageUi) stageUi.disposeStage();
  if (behaviorScheduler) behaviorScheduler.destroy();
  if (animController) animController.destroy();
});

/* 🔴 v1.8-b：框选窗关掉后的回执。
 *   框选在**独立全屏窗**里发生（主窗只有 256x320，框不到屏幕），
 *   主窗只负责说一句结果 —— 成功或失败都给客观反馈，不弹窗、不打断对话。 */
if (api && typeof api.onVisionNotify === 'function') {
  api.onVisionNotify((p) => {
    try {
      if (p && p.ok) say(t('vision.staged', '看到了。你说吧。'));
      else say(t('vision.failed', '没截到'));
    } catch (e) { /* 提示失败不影响主流程 */ }
  });
}

