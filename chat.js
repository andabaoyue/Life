/**
 * 对话窗本体（v1.0 方案二 · 笔 2）—— 只做聊天：气泡流 + 输入 + 流式 + 权威对账。
 *
 * 铁律：
 * 1. 数据层单一事实源：ChatStore（chat-history 好投影），本层永不写主体数据；
 * 2. 流式临时态只是显示，回合结束 ChatStore.load() 对账（她脑子里的历史说了算）；
 * 3. synthetic 走 SYNTHETIC_RENDER 契约，绝不冒充用户发言；
 * 4. 文案一律 t()（i18n 双表）；时间一律 formatDisplayTime（缺 t 不伪造）。
 * 复用纯层三件套（ui-i18n / ui-chat-store / ui-chat-render），遮蔽与决策零复制。
 */

/* ---------- 渲染环境装配（排爆补章） ----------
   preload 注入的是 window.deskpet；遮蔽词表必须显式注入（独立页面没人替我们做）。 */
const api = window.deskpet || null;

function syncMarkContext(ids) {
  const known = new Set(ids || []);
  setMarkContext({
    STATES: ['idle', 'happy', 'curious', 'thinking', 'sleepy', 'embarrassed', 'annoyed', 'sad'],
    knownWear: known,
    wearCandidates: [...known].map(id => 'wear:' + String(id).toLowerCase())
  });
}
syncMarkContext([]);
if (api && api.wardrobeState) {
  const loadWear = () => api.wardrobeState().then((st) => {
    const cat = st && st.catalog;
    if (!cat) return;
    const ids = Object.keys(cat.items || {}).flatMap(s => (cat.items[s] || []).map(i => i.id))
      .concat(Object.keys(cat.presets || {}))
      .concat((cat.slots || []).filter(s => !s.required).map(s => 'off_' + String(s.id).toLowerCase()));
    syncMarkContext(ids);
  }).catch(() => {});
  loadWear();
  if (api.onWardrobe) api.onWardrobe(loadWear);
}

const chatList = document.getElementById('chatList');
const chatTitle = document.getElementById('chatTitle');
const chatClose = document.getElementById('chatClose');
const chatDragWin = document.getElementById('chatDragWin');
const chatHint = document.getElementById('chatHint');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const micBtn = document.getElementById('micBtn');   // v1.7-a：语音输入
// v1.8-b：待发送截图的预览条（用户实测"看不到图、以为没截到"）
const visionBar = document.getElementById('visionBar');
const visionThumb = document.getElementById('visionThumb');
const visionMeta = document.getElementById('visionMeta');
const visionDrop = document.getElementById('visionDrop');

let streamNode = null;
let streamText = '';
let chatError = null;
let chatNotice = null;   // v2.0 客观物理事实行（信箱留置等），第三人称、不代拟
let busy = false;

function applyTexts() {
  if (chatTitle) chatTitle.textContent = t('chat.title');
  if (chatClose) chatClose.title = t('chat.closeTitle');   // 关闭按钮提示也走双表（HTML 里的中文只是默认值）
  if (chatHint) chatHint.textContent = t('panel.closeHint');   // 只留关闭提示（「拖到舒服的位置」是卡片时代措辞，已随卡片退役）
  if (input) input.placeholder = t('chat.placeholder');
  if (sendBtn) sendBtn.title = t('chat.send', '发送');
}
applyTexts();

function buildBubble(v, extraCls) {
  const row = document.createElement('div');
  row.className = 'b-row ' + v.cls + (v.bridge ? ' b-bridged' : '') + (extraCls ? ' ' + extraCls : '');
  if (v.avatar) {
    const av = document.createElement('div');
    av.className = 'b-av';
    av.textContent = v.avatar;
    row.appendChild(av);
  }
  const col = document.createElement('div');
  col.className = 'b-col';
  const txt = document.createElement('div');
  txt.className = 'b-text';
  txt.textContent = v.text;          // textContent 渲染，防注入
  col.appendChild(txt);
  // 🔴 枕边留置标注（10-07）：她睡着时你发的消息，如实标出「当时她没接」。
  //   只陈述事实，不写「她在等你回复」这类替她表态的话（撞 persona.js:29）。
  if (v.bedside) {
    const bd = document.createElement('div');
    bd.className = 'b-ts b-bedside-note';
    bd.textContent = t('chat.bedsideNote', '（她睡着时留的，当时没有回应）');
    col.appendChild(bd);
  }
  if (v.ts !== null && v.ts !== undefined) {
    const ts = document.createElement('div');
    ts.className = 'b-ts';
    ts.textContent = formatDisplayTime(v.ts);
    col.appendChild(ts);   // v1.0：时间贴在消息框正下方、右对齐（不出框）
  }
  row.appendChild(col);
  return row;
}

function renderChat() {
  if (!chatList) return;
  const stick = shouldStickToBottom(chatList.scrollTop, chatList.scrollHeight, chatList.clientHeight);
  chatList.innerHTML = '';
  let prev = null;
  for (const m of ChatStore.messages) {
    const v = bubbleView(m, SYNTHETIC_RENDER);
    if (v.kind === 'skip') { prev = m; continue; }
    if (dividerNeeded(prev, m)) {
      const dv = document.createElement('div');
      dv.className = 'win-divider';
      dv.textContent = t('chat.windowBreak');
      chatList.appendChild(dv);
    }
    chatList.appendChild(buildBubble(v));
    prev = m;
  }
  if (chatError) {
    const ev = document.createElement('div');
    ev.className = 'b-row b-note b-error';
    const et = document.createElement('div');
    et.className = 'b-text';
    et.textContent = chatError;
    ev.appendChild(et);
    chatList.appendChild(ev);
  }
  if (chatNotice) {
    const nv = document.createElement('div');
    nv.className = 'b-row b-note b-notice';
    const nt = document.createElement('div');
    nt.className = 'b-text';
    nt.textContent = chatNotice;
    nv.appendChild(nt);
    chatList.appendChild(nv);
  }
  if (stick) chatList.scrollTop = chatList.scrollHeight;
}

ChatStore.onChange(() => renderChat());
ChatStore.load();

/* 🔴 v1.0 她说完了 → 重新对账。
 *
 *   ## 这个监听解决的是什么
 *
 *   她开口的路有三条，而本窗只在第一条路上会自己刷新：
 *   ① 用户发消息 → submit() 的 finally 里 await ChatStore.load()
 *   ② 主动搭话 → pet.js 收到 proactive-offer 后runChat（**桌宠窗口**）
 *   ③ 睡眠后醒来自己开口（**桌宠窗口**）
 *
 *   ②③ 发生在桌宠窗口，本窗全程不知情 —— 用户看到的现象是
 *   「她气泡里说了，对话框里没有，退出重开才看得到」。
 *   主进程在她说完后会广播 chat-history-changed，本窗收到即回查历史。
 *
 *   ## 三条必须守住的边界
 *
 *   1. **不在 busy（正在流式/正在提交）时对账。**
 *      那一刻本窗正在显示流式临时气泡，中途换掉 DOM 会把打字动效打断、
 *      也会和 submit() 的收尾对账撞车两次。等submit 自己收尾即可。
 *   2. **不碰用户正在输入的内容。**
 *      load() 只改 messages 并 emit，**不动 input.value**，
 *      用户打到一半的字不会被清掉（这是当初复用来不及重写的既有行为，不是新引入的）。
 *   3. **信号不带内容，只当"去查"的提示。**
 *      真实内容一律回查 memory.history（单一事实源，见 ui-chat-store.js 头注释）。
 *      这里绝不拿payload 里的文本直接渲染 —— 那样就造了第二份真相。
 */
if (api && api.onChatHistoryChanged) {
  api.onChatHistoryChanged(() => {
    // 边界①：她正在说话/用户正在提交 ⇒ 交给 submit() 的收尾对账，别抢。
    if (busy) return;
    // 边界③：这里只取"该去查了"这个事实，payload 的 reason 仅用于日志/调试。
    ChatStore.load();
  });
}

/* v1.0 B 方案（用户拍板 2026-10）：她被唤醒且枕边有未接留言 → 在对话窗留一行**客观注记**。
 *
 *   ## 为什么需要它
 *   实测事故（2026-10-08 19:19）：她在睡 → 用户留了消息（bedside，不调 LLM）→ 15 秒后
 *   被拖拽唤醒 → 整条唤醒链零次回话。用户看到的现象是「她醒了却装死，必须我再发一句
 *   她才提起刚才的事」，体感极像丢消息。留言其实**已经稳稳躺在 history 里**
 *   （她下次开口时上下文自会带上，见 memory._bedsideNote）—— 缺的只是「她醒了」这个
 *   事实的可见性。
 *
 *   ## 边界（与 bedside 原设计一字不差）
 *   · payload **只有条数**，没有正文：内容回查 history（单一事实源），不造第二份真相；
 *   · 这里**不代拟她说任何话**、不写 history、不调 LLM —— 只呈现事实；
 *   · 「接不接、怎么接」仍归她，所以文案是第三人称客观陈述，不催不劝。*/
if (api && api.onBedsideUnreadOnWake) {
  api.onBedsideUnreadOnWake((p) => {
    const n = Number(p && p.count) || 0;
    if (n <= 0) return;               // 没有未接 → 界面安静如常（默认路径）
    chatNotice = t('chat.bedsideUnreadOnWake');
    renderChat();
  });
}

/* 🔴 2026-10-19：她主动开口但失败了 → 在对话窗留一行**常驻客观注记**。
 *
 *   ## 为什么必须有这一条
 *   事故：Key 于 10-18 深夜失效，此后 7 次主动搭话全被 401 拒掉。头顶气泡 15 秒就收，
 *   而主动搭话恰恰发生在她独自待着、用户不在电脑前的时候 —— 于是「她一直在试、
 *   一直在被拒」这件事，用户一整晚都不知道。审计写了，但那是给我们排查用的，
 *   用户不会去翻 agent-audit.jsonl。
 *
 *   ## 边界
 *   · 只陈述**事实**：她试着开口，没成功；原因类别是什么。不代拟她的话、不写 history；
 *   · payload 只有 errorType / proactive，**没有报错原文**（不该把 HTTP 细节糊到用户脸上）；
 *   · 用 chatNotice（客观事实行）而不是 chatError（错误行）：
 *     这不是用户的操作失败，是她那一趟没成 —— 语气该是对事实的陈述。 */
if (api && api.onChatFailed) {
  api.onChatFailed((p) => {
    const type = (p && p.errorType) || '';
    if (type === 'auth_failed') {
      chatNotice = t('chat.proactiveAuthFailed',
        '（她想开口，但 API Key 被服务端拒绝了 —— 到设置里重新填一次）');
    } else {
      chatNotice = t('chat.proactiveNetworkFailed',
        '（她想开口，但当时连不上服务端）');
    }
    renderChat();
  });
}

// 流式：临时气泡逐字上屏（遮蔽走 stripState），智能贴底不打断回看
if (api && api.onDelta) {
  api.onDelta((d) => {
    if (!streamNode) return;
    streamText += d;
    const el = streamNode.querySelector('.b-text');
    if (el) el.textContent = stripState(streamText, true);
    if (chatList && shouldStickToBottom(chatList.scrollTop, chatList.scrollHeight, chatList.clientHeight, 80)) {
      chatList.scrollTop = chatList.scrollHeight;
    }
  });
}

async function submit() {
  const text = input.value.trim();
  if (!text || busy || !api) return;
  busy = true;
  input.value = '';
  input.style.height = '';   // v1.0 发送后复位输入框高度
  chatError = null;
  chatNotice = null;
  const pend = buildBubble({ kind: 'user', text, bridge: false, cls: 'b-user', avatar: '你', ts: null }, 'b-pending');
  chatList.appendChild(pend);
  streamNode = buildBubble({ kind: 'assistant', text: '', bridge: false, cls: 'b-ai', avatar: '初', ts: null }, 'b-streaming');
  chatList.appendChild(streamNode);
  streamText = '';
  chatList.scrollTop = chatList.scrollHeight;
  sendBtn.disabled = true;
  if (api.chatBusy) api.chatBusy(true);   // 双窗同步：她身边进入思考态
  let res = null;
  try {
    res = await api.send(text);
    if (res && res.slept) {
      chatNotice = res.note || t('chat.bedsideSleeping', '[初澜沉睡中，消息已留置在侧]');   // 客观物理事实，不是她的话
    } else if (res && res.ok) {
      // v1.0 客观汇报迁移（记录面板退役）：换装/窗口小结如实以客观事实行呈现，绝不写进她的话
      const notes = [];
      if (res.wears && res.wears.length) notes.push(t('chat.wearPrefix', '[换装] ') + (res.wearNote || t('chat.wearUnexecuted', '未执行')));
      if (res.windowClosed) notes.push(res.merged ? t('chat.windowFullMerged', '窗口已满，小结并合并了记忆') : t('chat.windowFullSummary', '满一轮窗口，已生成小结'));
      if (notes.length) chatNotice = notes.join(' · ');
    } else if (!res || res.declined || !res.ok) {
      // 🔴 2026-10-19：认证失败要说清「去干什么」，不能只丢一句原始报错。
      //   对话窗的错误行是**常驻**的（不像头顶气泡 6 秒就收），所以这里是
      //   Key 失效时用户真正能看见的那一处 —— 事故当天就是因为两处都不可靠才拖了四小时。
      chatError = res && res.errorType === 'auth_failed'
        ? t('chat.authFailedNotice', '（这条没送出去：API Key 被服务端拒绝，请到设置里重新填）')
        : t('chat.sendFailed') + (res && res.error ? '：' + res.error : '');
    }
  } catch (e) {
    chatError = t('chat.sendFailed') + '：' + e.message;
  } finally {
    streamNode = null;
    streamText = '';
    busy = false;
    sendBtn.disabled = false;
    if (api.chatBusy) api.chatBusy(false, res && res.ok ? res.state : null);   // 收尾：她切表情、气泡 6 秒收
    // 🔴 v1.8-b：这一轮已经把待发图消费掉了（brain.takeVisionPick），
    //    预览条要跟着收起 —— 否则用户会以为"图还在"，下一条又带一次。
    syncVisionBar();
    await ChatStore.load();   // 权威对账（真实 messageId / t 钉死 DOM）
  }
}

sendBtn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    if (e.shiftKey) return;   // Shift+Enter：换行，放行 textarea 原生处理
    e.preventDefault();
    submit();
  }
});
// v1.0 输入手感：自动伸缩（上限 100px，超出内部滚动）
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
});

/* ============================================================
 * v1.7-a：语音输入（STT）
 *
 * ## 🔴 三条铁律（每条都有门禁断言，改这里前先读）
 *   1. **识别结果只写进 `#input`，绝不自动发送** ——
 *      语音识别必错（尤其专有名词、中英混说）。自动发送 = 程序替用户说话，
 *      会污染 `memory.history` 里「用户真实说了什么」这条事实链。
 *      所以本段里**不出现** `submit(` / `api.send(`。
 *   2. **失败静默** —— 只在 `#chatHint` 写一行客观提示，
 *      **不弹 Modal、不 alert、不清空用户已输入的内容**。
 *   3. **绝不覆盖用户已打的字** —— 输入框非空时**追加**，不替换。
 *
 * ## 状态机
 *   disabled（未配置）→ idle → recording → transcribing → idle
 *
 * ## 中断规则
 *   · 失焦 / 窗口隐藏 → 立即停止并丢弃（不送识别）
 *   · 超过 60 秒 → 自动停止（防误按白烧配额）
 *   · 音频短于 0.3 秒 → 视为误触，不发请求
 * ============================================================ */

const MIC_LOST_FOCUS_DISCARD = true;   // 失焦丢弃：半句话不算数
const MIC_MAX_MS = 60 * 1000;          // 录音上限 60 秒
const MIC_MIN_MS = 300;                // 低于此判为误触

let micState = 'disabled';   // disabled | idle | recording | transcribing
let mediaRecorder = null;
let mediaStream = null;
let micChunks = [];
let micStartedAt = 0;
let micTimer = null;

/** 按状态刷新按钮外观与可点性。不碰输入框内容。 */
function renderMicState() {
  if (!micBtn) return;
  micBtn.classList.remove('mic-recording', 'mic-busy');
  if (micState === 'disabled') {
    micBtn.disabled = true;
    micBtn.textContent = '🎤';
    micBtn.title = t('stt.notConfigured', '未配置语音识别服务');
    micBtn.setAttribute('aria-label', t('stt.notConfigured', '未配置语音识别服务'));
  } else if (micState === 'idle') {
    micBtn.disabled = false;
    micBtn.textContent = '🎤';
    // 点击模式：文案说"点一下开始"，不再说"按住"
    micBtn.title = t('stt.clickToStart', '点击开始录音');
    micBtn.setAttribute('aria-label', t('stt.clickToStart', '点击开始录音'));
  } else if (micState === 'recording') {
    micBtn.disabled = false;
    micBtn.classList.add('mic-recording');
    micBtn.textContent = '⏹';
    micBtn.title = t('stt.clickToStop', '点击结束并识别（ESC 取消）');
    micBtn.setAttribute('aria-label', t('stt.clickToStop', '点击结束并识别（ESC 取消）'));
  } else if (micState === 'transcribing') {
    // 识别中不可点：防重入（连点会产生多个并发请求）
    micBtn.disabled = true;
    micBtn.classList.add('mic-busy');
    micBtn.textContent = '…';
    micBtn.title = t('stt.listening', '识别中…');
    micBtn.setAttribute('aria-label', t('stt.listening', '识别中…'));
  }
}

/** 只在输入框附近写一行客观提示，绝不清空输入框、绝不弹窗。 */
function micHint(text) {
  if (chatHint) chatHint.textContent = text || '';
}

/* ============================================================
 * 🔴 v1.8-b：待发送截图的预览条（2026-10-21）
 *
 * ## 用户实测反馈
 *   「那张图在截出来之后，对话框里找不到，也不会出现在输入框里，具有迷惑性」
 *
 * ## 根因
 *   截图确实存进了 brain（`_visionPick`），下一轮消息会带上它 —— **功能是通的**。
 *   但对话窗**零反馈**：既没有缩略图、也没有任何"图已附上"的提示。
 *   用户看不到 ⇒ 只能以为没截到 ⇒ 反复重试。
 *
 * ## 这条 UI 解决三个具体疑问
 *   ① 截到了没有？      → 缩略图直接给他看
 *   ② 多大一块？        → 显示 W×H（客观事实）
 *   ③ 不想要了怎么办？  → 点 × 丢弃（走 vision:drop）
 *
 * ⚠️ 只用于**预览**：真正送模型的是 brain 里那张原图，
 *    缩略图与原图互不影响，也不会额外消耗 token。
 * ============================================================ */

/** 刷新预览条：有图就显示，没图就收起。 */
async function syncVisionBar() {
  if (!visionBar) return;
  if (!api || !api.vision || typeof api.vision.peek !== 'function') return;

  let r = null;
  try { r = await api.vision.peek(); } catch (e) { r = null; }

  if (!r || !r.ok || !r.pending || !r.dataUrl) {
    visionBar.classList.add('hidden');
    if (visionThumb) visionThumb.removeAttribute('src');
    return;
  }

  if (visionThumb) visionThumb.src = r.dataUrl;
  if (visionMeta) {
    /* 🔴 只说客观事实：尺寸 + 一句"下一条会带上它" + 成本量级。
     *
     * 2026-10-27（PENDING-TASKS 6.3）：补上成本提示。
     * ⚠️ 只提"贵一个量级"，**不写具体 token 数** —— provider 的 usage 里
     *   没有 image token 字段（实测 usage-normalizer 只映射 prompt/completion/
     *   cache_hit/cache_miss），任何具体数字都是推算值，写出来就是伪精确。
     *   提示拼在同一行，不新增 DOM 节点，避免挤压预览条宽度。
     */
    visionMeta.textContent = t('vision.pendingMeta', '待发送：{w}×{h} · 下一条消息会带上这块', {
      w: r.width || '?', h: r.height || '?'
    }) + ' · ' + t('vision.costHint', '看图比纯文本贵一个量级');
  }
  visionBar.classList.remove('hidden');
}

/** 点 × 丢弃这张待发图（发出去前反悔的唯一出口） */
async function dropVisionPick() {
  if (!api || !api.vision || typeof api.vision.drop !== 'function') return;
  try { await api.vision.drop(); } catch (e) { /* 丢不掉也不影响主流程 */ }
  await syncVisionBar();
}

if (visionDrop) visionDrop.addEventListener('click', dropVisionPick);

// 窗口获得焦点时刷新（用户在别的窗口截完图切回来）
window.addEventListener('focus', () => { syncVisionBar(); });

// 初次装载刷新一次
syncVisionBar();

/** 查询配置并据此决定按钮亮不亮。配置变更后也会被再次调用。 */
async function syncMicState() {
  if (!api || !api.stt || typeof api.stt.getConfig !== 'function') {
    micState = 'disabled';
    renderMicState();
    return;
  }
  let cfg = null;
  try { cfg = await api.stt.getConfig(); } catch (e) { cfg = null; }
  // 只有「有 Key + 有端点 + 有模型」才算可用的完整配置
  const ready = !!(cfg && cfg.ok && cfg.hasKey
    && String(cfg.endpoint || '').trim() && String(cfg.model || '').trim());
  // 正在录音/识别时不打断当前流程
  if (micState === 'recording' || micState === 'transcribing') return;
  micState = ready ? 'idle' : 'disabled';
  renderMicState();
}

/** 把识别文本并入输入框：**非空则追加**，绝不覆盖。 */
function mergeRecognizedText(text) {
  const add = String(text || '').trim();
  if (!add) return;
  const cur = input ? String(input.value || '') : '';
  // 用户打了半句 → 追加（中间补一个空格，避免两段粘连）
  input.value = cur ? (/\s$/.test(cur) ? cur + add : cur + ' ' + add) : add;
  // 触发既有自动伸缩
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (typeof input.focus === 'function') input.focus();
}

/** 收尾：停流、清计时器、释放资源。停流是必须的，否则麦克风指示灯不灭。 */
function stopMicTracks() {
  if (micTimer) { clearTimeout(micTimer); micTimer = null; }
  if (mediaStream) {
    try { mediaStream.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* 释放失败不掀桌 */ }
    mediaStream = null;
  }
  mediaRecorder = null;
  micChunks = [];
}

/** 开始录音。失败一律静默降级成一行提示。 */
async function startRecording() {
  if (micState !== 'idle') return;
  micHint('');
  let stream = null;
  try {
    // 只要音频；不请求视频 —— 最小权限
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // 权限被拒 / 无设备：都走静默提示，不弹窗
    const name = e && e.name;
    micHint(name === 'NotAllowedError'
      ? t('stt.denied', '麦克风权限被拒绝')
      : t('stt.noDevice', '没有找到麦克风'));
    return;
  }

  let rec = null;
  try {
    rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  } catch (e) {
    // 个别平台不支持 webm，退回默认格式
    try { rec = new MediaRecorder(stream); } catch (e2) {
      stopMicTracks();
      micHint(t('stt.failed', '识别失败'));
      return;
    }
  }

  mediaStream = stream;
  mediaRecorder = rec;
  micChunks = [];
  micStartedAt = Date.now();

  rec.ondataavailable = (ev) => { if (ev && ev.data && ev.data.size) micChunks.push(ev.data); };
  rec.onstop = () => { finishRecording(); };   // 真正的识别在 onstop 里做

  try {
    // 🔴 必须传 timeslice：不传时 ondataavailable 只在 stop() 时触发一次，
    //   任何"提前停止"路径（鼠标移出、失焦、异常）都可能拿到空 chunks。
    //   传 250ms 后按片累积，stop 时一定已有数据。
    rec.start(250);
  } catch (e) {
    stopMicTracks();
    micState = 'idle';
    renderMicState();
    micHint(t('stt.failed', '识别失败'));
    return;
  }

  micState = 'recording';
  renderMicState();

  // 上限自动停止：防用户忘记松开导致配额空耗
  micTimer = setTimeout(() => { stopRecording(); }, MIC_MAX_MS);
}

/** 停止录音（用户主动 / 超时 / 失焦）。 */
function stopRecording(discard) {
  if (micState !== 'recording') return;
  const elapsed = Date.now() - micStartedAt;

  if (discard) {
    // 失焦丢弃：不送识别，直接把流关掉
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.onstop = null; } catch (e) {}
    stopMicTracks();
    micState = 'idle';
    renderMicState();
    return;
  }

  // 太短 = 误触，不发请求（也省一次配额）
  if (elapsed < MIC_MIN_MS) {
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.onstop = null; } catch (e) {}
    stopMicTracks();
    micState = 'idle';
    renderMicState();
    micHint(t('stt.noSpeech', '没听清'));
    return;
  }

  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch (e) {
    stopMicTracks();
    micState = 'idle';
    renderMicState();
  }
}

/**
 * 录音结束 → 送识别 → 只写输入框。
 *
 * 🔴 2026-10-20 增加审计留痕：真机反馈「说了话没识别」，
 *   但磁盘上找不到任何痕迹，无法判断卡在哪一环。
 *   现在每次录音都向主进程报一条 STT 审计（只记元数据：时长、字节数、
 *   mime、成功/失败类别），**不记音频内容、不记识别文本**。
 *   这样排查时有据可查，又不侵犯内容隐私。
 */
async function finishRecording() {
  const chunks = micChunks.slice();
  const mime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  const chunksCount = chunks.length;
  const elapsedMs = micStartedAt ? (Date.now() - micStartedAt) : 0;
  stopMicTracks();

  if (!chunks.length) {
    micState = 'idle';
    renderMicState();
    micHint(t('stt.noSpeech', '没听清'));
    auditStt({ stage: 'no_chunks', elapsedMs, chunksCount, mime });
    return;
  }

  micState = 'transcribing';
  renderMicState();

  let buf = null;
  try {
    const blob = new Blob(chunks, { type: mime });
    buf = await blob.arrayBuffer();
  } catch (e) { buf = null; }

  if (!buf || !buf.byteLength) {
    micState = 'idle';
    renderMicState();
    micHint(t('stt.noSpeech', '没听清'));
    auditStt({ stage: 'empty_blob', elapsedMs, chunksCount, mime, bytes: buf ? buf.byteLength : 0 });
    return;
  }

  let res = null;
  try {
    // 🔴 入参只有音频与语言：端点和密钥都由主进程持有
    res = await api.stt.transcribe({ audio: buf, mimeType: mime });
  } catch (e) {
    res = null;
    auditStt({ stage: 'ipc_throw', elapsedMs, chunksCount, mime, bytes: buf.byteLength, error: String(e && e.message || e).slice(0, 120) });
  }

  micState = 'idle';
  renderMicState();

  if (res && res.ok && typeof res.text === 'string' && res.text.trim()) {
    // 🔴 只写进输入框 —— 绝不 submit()、绝不 api.send()
    mergeRecognizedText(res.text);
    micHint('');
    auditStt({ stage: 'ok', elapsedMs, chunksCount, mime, bytes: buf.byteLength, textLen: res.text.length });
  } else {
    const et = res && res.errorType;
    auditStt({ stage: 'failed', elapsedMs, chunksCount, mime, bytes: buf.byteLength, errorType: et || 'null_result' });
    if (et === 'not_configured') micHint(t('stt.notConfigured', '未配置语音识别服务'));
    else if (et === 'no_audio' || et === 'empty_result' || et === 'unsupported_audio') {
      micHint(t('stt.noSpeech', '没听清'));
    } else micHint(t('stt.failed', '识别失败'));
  }
}

/**
 * 上报一条 STT 审计（失败不影响主流程）。
 * 只记元数据，绝不带音频字节与识别文本。
 * @param {object} payload
 */
function auditStt(payload) {
  try {
    if (api && typeof api.sttAudit === 'function') api.sttAudit(payload);
  } catch (e) { /* 审计失败不能影响录音主流程 */ }
}

/* ---- 事件绑定 ---- */

if (micBtn) {
  /* 交互方式：**点击开始 / 再点结束**（v1.7-a 二次修订，用户要求）。
   *
   * ## 为什么不沿用「按住说话」
   *   按住模式要求手一直停在按钮上，真机实测很容易误触：
   *   手一抖划出按钮就被截断（旧代码还挂着 mouseleave，更糟）。
   *   点击切换让手可以离开，说话时不用一直绷着，对鼠标/触控板都更友好。
   *
   * ## 铁律未变
   *   识别结果仍然只写进 #input、绝不自动发送（见 finishRecording）。
   *   再点一次是「结束并识别」，不是「取消」——
   *   取消由 ESC / 失焦 / 超时负责，避免用户误以为点第二下会丢弃。 */
  micBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (micState === 'idle') startRecording();
    else if (micState === 'recording') stopRecording(false);
    // transcribing 态按钮已 disabled，点不到
  });
  // 键盘可达性：空格/回车等同点击
  micBtn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (micState === 'idle') startRecording();
      else if (micState === 'recording') stopRecording(false);
    }
  });
}

/* 🔴 ESC 取消录音（唯一明确的"取消"入口）。
   为什么需要：点击模式没有"松手"这个天然结束动作，
   用户中途反悔必须有个不产生识别请求的出口。 */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && micState === 'recording') {
    stopRecording(true);              // true = 丢弃，不送识别
    micHint('');
  }
});

// 失焦 / 窗口隐藏：丢弃当前录音（半句话不算数）
window.addEventListener('blur', () => {
  if (MIC_LOST_FOCUS_DISCARD) stopRecording(true);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && MIC_LOST_FOCUS_DISCARD) stopRecording(true);
});

// 配置变更后回到对话窗 → 立刻同步按钮（否则用户配完 Key 还得重开窗口）
window.addEventListener('focus', () => { syncMicState(); });

// 首次装载时同步一次（窗口可能带着旧配置打开）
syncMicState();

// 关闭语义（拍板）：× / ESC / 右键 —— 只隐藏不销毁（主进程拦截 close 落 hide）
if (chatClose) chatClose.addEventListener('click', () => api && api.chatWindowClose && api.chatWindowClose());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && api && api.chatWindowClose) api.chatWindowClose();
});
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (api && api.chatWindowClose) api.chatWindowClose();
});
// 双击标题栏回她身边（智能出生位）
if (chatDragWin) chatDragWin.addEventListener('dblclick', () => api && api.chatWindowHome && api.chatWindowHome());
const chatHead = document.getElementById('chatHead');
if (chatHead) chatHead.addEventListener('dblclick', () => api && api.chatWindowHome && api.chatWindowHome());
