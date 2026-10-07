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

let streamNode = null;
let streamText = '';
let chatError = null;
let chatNotice = null;   // v2.0 客观物理事实行（信箱留置等），第三人称、不代拟
let busy = false;

function applyTexts() {
  if (chatTitle) chatTitle.textContent = t('chat.title');
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
      chatNotice = res.note || '[初澜沉睡中，消息已留置在侧]';   // 客观物理事实，不是她的话
    } else if (res && res.ok) {
      // v1.0 客观汇报迁移（记录面板退役）：换装/窗口小结如实以客观事实行呈现，绝不写进她的话
      const notes = [];
      if (res.wears && res.wears.length) notes.push('[换装] ' + (res.wearNote || '未执行'));
      if (res.windowClosed) notes.push(res.merged ? '窗口已满，小结并合并了记忆' : '满一轮窗口，已生成小结');
      if (notes.length) chatNotice = notes.join(' · ');
    } else if (!res || res.declined || !res.ok) {
      chatError = t('chat.sendFailed') + (res && res.error ? '：' + res.error : '');
    }
  } catch (e) {
    chatError = t('chat.sendFailed') + '：' + e.message;
  } finally {
    streamNode = null;
    streamText = '';
    busy = false;
    sendBtn.disabled = false;
    if (api.chatBusy) api.chatBusy(false, res && res.ok ? res.state : null);   // 收尾：她切表情、气泡 6 秒收
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
