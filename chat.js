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
