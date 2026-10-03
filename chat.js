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
let busy = false;

function applyTexts() {
  if (chatTitle) chatTitle.textContent = t('chat.title');
  if (input) input.placeholder = t('chat.placeholder');
  if (chatHint) chatHint.textContent = t('panel.closeHint') + ' · ' + t('card.dragHint');
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
  if (v.ts !== null && v.ts !== undefined) {
    const ts = document.createElement('div');
    ts.className = 'b-ts';
    ts.textContent = formatDisplayTime(v.ts);
    col.appendChild(ts);
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
  if (stick) chatList.scrollTop = chatList.scrollHeight;
}

ChatStore.onChange(() => renderChat());
ChatStore.load();

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
  chatError = null;
  const pend = buildBubble({ kind: 'user', text, bridge: false, cls: 'b-user', avatar: '你', ts: null }, 'b-pending');
  chatList.appendChild(pend);
  streamNode = buildBubble({ kind: 'assistant', text: '', bridge: false, cls: 'b-ai', avatar: '初', ts: null }, 'b-streaming');
  chatList.appendChild(streamNode);
  streamText = '';
  chatList.scrollTop = chatList.scrollHeight;
  sendBtn.disabled = true;
  try {
    const res = await api.send(text);
    if (!res || res.declined || !res.ok) {
      chatError = t('chat.sendFailed') + (res && res.error ? '：' + res.error : '');
    }
  } catch (e) {
    chatError = t('chat.sendFailed') + '：' + e.message;
  } finally {
    streamNode = null;
    streamText = '';
    busy = false;
    sendBtn.disabled = false;
    await ChatStore.load();   // 权威对账（真实 messageId / t 钉死 DOM）
  }
}

sendBtn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
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
