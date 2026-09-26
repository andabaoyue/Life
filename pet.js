const pet = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const menu = document.getElementById('menu');
const log = document.getElementById('log');
const logBody = document.getElementById('logBody');
const panel = document.getElementById('panel');
const researchPanel = document.getElementById('researchPanel');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const creativeToggle = document.getElementById('creativeToggle');
const creativeState = document.getElementById('creativeState');
const figure = document.getElementById('figure');
const layerBox = document.getElementById('layers');
const spriteImg = document.getElementById('sprite');
const shadowBox = document.getElementById('shadow');

// 注意：不能叫 window.pet —— 页面上有 <div id="pet">，
// 浏览器会把带 id 的元素自动挂成全局变量，两者会撞车。
const api = window.deskpet || null;

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
        if (input && (document.activeElement === input || input.value.trim())) return false;
        if (typeof dragging !== 'undefined' && dragging) return false;
        return true;
      }
    });
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
    hidden: document.body.classList.contains('showlog')
      || !panel.classList.contains('hidden')
      || (researchPanel && !researchPanel.classList.contains('hidden'))
  });
}

const FALLBACK = [
  '今天也要一起变得更好哦~',
  '累了就休息一下，我陪你。',
  '喝口水吧，别一直盯着屏幕~'
];

/* ---------------- 气泡 ---------------- */
let bubbleTimer = null, streaming = false;
let lastText = '';        // 最近一次上屏的文本，用于收尾去掉光标

// 模型被要求在末尾附 [state:xx]（换装提案 [wear:id] 排在它前面）。
// 上屏前把它们（含流式期间没吐完的前缀）剪掉。
// 规则：完整标记（容忍冒号后空格、句末标点尾巴）；半截前缀（流式瞬态）。
/* 尾部标记遮蔽：[state:xx] 与 [wear:id]。
   与后端 parseState/parseWear 同一条铁律——未知值不剥离，
   宁可屏幕上多一个怪标记，也不能把正文掏空。
   合法的 wear id 集合来自衣柜 catalog（启动时注入），
   保证渲染端藏起来的和后端剥掉的永远是同一批。 */
let knownWear = new Set();

function setKnownWear(ids) {
  knownWear = new Set(ids || []);
  // 半截标记要不要藏，判据是"它还有没有可能长成一个合法标记"，
  // 所以这里预生成候选串，逐帧比对前缀。
  wearCandidates = [...knownWear].map(id => 'wear:' + String(id).toLowerCase());
}
let wearCandidates = [];

/* 面板与启动共用同一份「合法 id」，避免两边各写一遍写歪 */
function wearIdsFrom(cat) {
  const itemIds = Object.keys(cat.items).flatMap(s => cat.items[s].map(i => i.id));
  const presetIds = Object.keys(cat.presets);
  const offIds = (cat.slots || [])
    .filter(s => !s.required)
    .map(s => 'off_' + String(s.id).toLowerCase());
  return itemIds.concat(presetIds, offIds);
}

const MARK_RE = {
  state: /^\s*(?:state)\s*[:：]\s*([a-z]+)\s*$/iu,
  wear: /^\s*(?:wear)\s*[:：]\s*([a-z0-9_]+)\s*$/iu
};

function stripState(t, partial = streaming) {
  /* 剥尾部标记要**整体迭代**，不是"先剥完整标记一轮、再藏半截一次"就完事：
     把末尾的半截藏起来之后，露出来的新尾巴可能又是一条完整的可剥标记。
     "[wear:gothic_black_01][s" 就是这一类：瞬态判据把 '[s' 藏掉，尾巴变成
     "[wear:gothic_black_01]"，本该继续剥 —— 单轮写法的结果是整条 wear
     标记重新出现在屏幕上，实测吐到 [state: 那段时泄漏 11 帧。
     每轮要么变短要么停住，所以不会死循环。 */
  for (;;) {
    const before = t;
    // 循环剥尾部：模型可能先提案（可多条）再收尾 state
    for (;;) {
      // 内容不允许跨 ']'，否则 "[wear:a][state:b]" 会被当成一整个标记，
      // 里面的 ']' 让两个子正则都匹配不上，结果一个都剥不掉。
      const m = t.match(/\[([^\]]*)\]([\s\p{P}~]*)$/iu);
      if (!m) break;
      const recognized =
        (MARK_RE.state.test(m[1]) && STATES.includes((m[1].match(MARK_RE.state)[1] || '').toLowerCase()))
        || (MARK_RE.wear.test(m[1]) && knownWear.has((m[1].match(MARK_RE.wear)[1] || '').toLowerCase()));
      if (!recognized) break;   // 未知值：原样留在正文，和后端行为一致
      const next = t.slice(0, m.index);
      // 后端 parseState/parseWear 有「掏空保护」（clean || text）：
      // 整条消息只剩标记时不剥空。这里不跟着停，前后端就会一个显示空、
      // 一个显示标记 —— 两边必须剥同一批。
      if (!next.trim()) break;
      t = next;
    }
    /* 流式瞬态：最后一个 [ 之后没有闭合的 ]。要不要藏起来，判据是
       "它还有没有可能长成一条后端会剥掉的标记"：
         state → 'state:' + 已知状态词的前缀
         wear  → 'wear:' + 衣柜里真实 itemId 的前缀（启动时注入 knownWear）
       刻意不是把字符集放宽成 [a-z0-9_]*：那样连 [wear:maid_dress_01 这种
       后端根本不认的幻觉 id 也会被整条藏起来（实测 14 帧，直到流结束再凭空
       长回来），按衣柜前缀只藏"确实还可能长成合法标记"的那几帧。
       决定性差别其实不在判据而在结构：单轮写法换掉字符集仍漏 11 帧（见函数头）。

       **只在还在吐字的时候藏**（partial 默认跟着 streaming）。这是上面那条
       "两边剥同一批"的推论，v0.7.1 第一版漏了：判据用的是"还可能长成合法
       标记"，可流一旦结束它就再也长不成了 —— 这时还藏，屏幕上没有、历史里
       有，正是我拿来否掉放宽字符集的那个理由。真实成因不稀有：max_tokens
       截断、用户点停止，都会让回复正好停在半截标记上。实测衣柜里的真 id
       silver_wavy_01 被截断成 "[wear:silver_wavy_" 时，收尾那一帧整条被吞掉。 */
    if (!partial) return t;
    const i = t.lastIndexOf('[');
    if (i >= 0 && t.indexOf(']', i) < 0 && transientMarker(t.slice(i + 1))) {
      t = t.slice(0, i);
    }
    if (t === before) return t;   // 这一整轮什么都没剥掉 → 收尾
  }
}

/* 半截标记判定。忽略空白是沿袭旧写法的宽容（词中间的空格后端本来也不认，
   所以这里多藏只可能藏一帧，闭合后仍按原样出现，前后端最终一致）。 */
function transientMarker(tail) {
  // 全角冒号归一 + 去空白：旧写法用 [:：] 和 \s* 容错，这里保持同样宽容
  const s = tail.toLowerCase().replace(/[：]/g, ':').replace(/\s+/g, '');
  if (!s) return true;                      // 光一个 '['：模型刚起头
  for (const w of ['state', 'wear']) {
    if (w.startsWith(s)) return true;       // 's' / 'wea' / 'stat'
    if (!s.startsWith(w + ':')) continue;
    const val = s.slice(w.length + 1);
    if (w === 'state') return val === '' || STATES.some(v => v.startsWith(val));
    return wearCandidates.some(c => c.startsWith(s));   // 含 'wear:' 本身
  }
  return false;
}

function render(text, withCursor = streaming) {
  lastText = text;
  const shown = stripState(text);
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
window.addEventListener('resize', () => {
  pet.style.width = Math.round(window.innerWidth * PET_RATIO) + 'px';
  relayout();
});

/* ---------------- 状态机 ----------------
   状态与文字分离：state 只挂到 body 的 data-state 上，
   CSS 按属性播动画。解析失败一律 idle，动画缺失也只是不动，不会崩。 */
const STATES = ['idle', 'happy', 'curious', 'thinking', 'sleepy',
                'embarrassed', 'annoyed', 'sad'];

/* 表情之间切换的"衔接"：上一次状态动画跑到峰值时切走，姿态会被硬拉到新动画的
   0% —— 实测 tilt 峰值（3°）切到 idle 一帧内跳 3.0°，bounce 顶点切 curious
   纵向跳 9.97px。CSS 层面修不掉（两个 animation 的输出没法 transition），
   差分表情图我们又没有素材。所以这里做的是 Gemini 那段代码**想做而做错的**
   那件事：用一次瞬时微动遮掩跳变，而不是换图片。
   三条约束都是量出来的，不是审美偏好：
   - 微动只能挂 #sprite / #layers（立绘内容），不能挂 #figure —— 那会把
     状态动画整个顶掉，实测倾角跳 2.23°，比原来的毛病更糟（见 style.css 里
     blink 那段注释）。
   - 判据直接读 body 的 data-state，不另存一份 lastState：两处记录同一个事实
     迟早会各说各话（测试里就有绕过 setState 直接改属性的地方）。
     同一个值重复 setState 不触发微动 —— hideBubble 和 finish 都会调
     setState('idle')，守住这条才不会每收一次气泡就抖一下。
   - 时长 .18s 与眨眼同级：短到不喧宾夺主，长到盖住那一帧跳变。
   启动时先把 data-state 摆成 idle（不触发微动）：否则第一次 setState('idle')
   会被当成"切换"，她一上屏就莫名其妙压扁一下。 */
document.body.dataset.state = 'idle';
let stateSwitchTimer = null;

function setState(s) {
  const next = STATES.includes(s) ? s : 'idle';
  if (document.body.dataset.state === next) return;
  document.body.dataset.state = next;
  if (animController) animController.setDialogueState(next);
  pet.classList.add('state-switch');
  clearTimeout(stateSwitchTimer);
  stateSwitchTimer = setTimeout(() => pet.classList.remove('state-switch'), 180);
}

/* ---------------- 换装：分层渲染 ----------------
   图层顺序只由数据层的 layers() 决定（z 排序），这里不写任何服装逻辑。
   所有图层共用 760x1000 画布锚点，绝对定位等比叠加即可对齐。

   降级是硬要求：character/ 资源缺失、图片加载失败、衣柜没初始化 ——
   任何一种都退回单张 assets/pet.png，桌宠不能变成空白。 */
let layerSrcs = [];          // 当前生效的图层，面板重绘时要复用

function showFallbackSprite() {
  figure.classList.remove('layered');
  layerBox.replaceChildren();
  if (animRenderer) animRenderer.refreshLayers();
}

function applyLayers(layers) {
  layerSrcs = layers || [];
  if (!layerSrcs.length) return showFallbackSprite();

  const srcs = ['assets/character/base/base.png', ...layerSrcs.map(l => l.src)];
  const imgs = srcs.map(src => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res();
    im.onerror = () => rej(new Error(src));
    im.src = src;
  }));

  Promise.all(imgs).then(() => {
    layerBox.replaceChildren();
    srcs.forEach((src, i) => {
      const im = document.createElement('img');
      im.src = src;
      im.draggable = false;
      im.alt = '';
      im.className = i === 0 ? 'layer base' : 'layer';
      if (i === 0) {
        im.dataset.slot = 'base';
      } else {
        im.style.zIndex = String(layerSrcs[i - 1].z);
        im.dataset.slot = layerSrcs[i - 1].slot || 'unknown';
      }
      layerBox.appendChild(im);
    });
    if (animRenderer) animRenderer.refreshLayers();
    figure.classList.add('layered');
    relayout();
  }).catch(() => {
    // 有一张图缺了就整套回退 —— 半张脸没头发比穿旧衣服难看多了
    showFallbackSprite();
    relayout();
  });
}

/* 立绘高度变了就必须重算这两件事：
   1. --bubble-max —— 它按 figure.offsetHeight 推，而兜底单图（1015x1171）
      和图层画布（760x1000）宽高比不同：同一 210px 宽下高度 242 -> 276，
      实测差 34px，而且**不 resize 就永远不自己纠正** —— Electron 窗口
      启动后根本不发 resize，所以是启动即中、一直错到下次手动缩放。
   2. 气泡内容 —— 上限变小后得重新裁一次，否则已经上屏的长回复还是老高度。
   加载失败走 catch 也一样要算：高度往回缩是同一个方向的问题。

   偏差方向的实测说明（别把它说成"气泡被裁掉"）：夹取后的上限偏大 34px，
   表现是气泡多吃掉 BUBBLE_SAFE(46) 里的那 34px —— 实测 340x480 时
   气泡顶边从 38 变成 4，仍没出上沿。也就是说这个缺陷在**当前可达尺寸
   区间内还不至于把字裁掉**，但离裁掉只剩 12px 余量：以后调小 BUBBLE_SAFE、
   或者立绘与图层的高度差再大一点，它立刻变成真裁剪。修它的理由是
   "算出来的数必须是当前真实值"，不是"现在已经在漏字"。

   但这里**绝不能**顺手把气泡拉起来。render() 的第一件事就是
   bubble.classList.remove('hidden')，所以旧写法「只要有 lastText 就重渲染」
   等于每回 relayout 都把已经收起的气泡复活 —— 实测三件事：
     1) 收起后调 relayout()，气泡重新可见（B1 False → B3 True）；
     2) 复活时没有任何待触发的收起定时器（bubbleTimer 早就跑过了），
        所以它就**永远挂在屏幕上**（等 9 秒仍可见）；
     3) politeToSpeak('idle') 从此恒为 false —— 主动搭话全被堵死。
   触发路径不稀有：窗口 resize、图层加载完成、加载失败降级都走 relayout。
   所以判据必须是"气泡此刻是开着的"而不是"有没有历史文本"：
   开着的时候确实要重排一次（上面第 2 条），关着就当没这回事。 */
function relayout() {
  fitBubble();
  if (lastText && !bubble.classList.contains('hidden')) render(lastText);
}

if (api && api.onWardrobe) {
  api.onWardrobe((layers) => applyLayers(layers));
}

/* ---------------- 衣柜面板 ----------------
   全部 textContent 写入；条目名来自数据层，但依然按不可信文本对待。 */
async function refreshWardrobe() {
  const presetBox = document.getElementById('wdPresets');
  const slotBox = document.getElementById('wdSlots');
  presetBox.textContent = '';
  slotBox.textContent = '';
  if (!api) {
    slotBox.textContent = '预览模式，衣柜不可用';
    return;
  }
  let st;
  try { st = await api.wardrobeState(); } catch { st = null; }
  const cat = st && st.catalog;
  if (!cat) { slotBox.textContent = '衣柜未初始化'; return; }

  setKnownWear(wearIdsFrom(cat));

  for (const [pid, pname] of Object.entries(cat.presets)) {
    const b = document.createElement('button');
    b.textContent = pname;
    b.className = 'wd-preset' + (cat.preset === pid ? ' on' : '');
    b.addEventListener('click', async () => {
      const r = await api.wardrobePreset(pid);
      if (!r.ok) say('这套我换不上：' + r.error);
      refreshWardrobe();
    });
    presetBox.appendChild(b);
  }

  for (const slot of cat.slots) {
    const items = cat.items[slot.id] || [];
    if (!items.length) continue;
    const row = document.createElement('div');
    row.className = 'wd-row';
    const label = document.createElement('span');
    label.className = 'wd-slot';
    label.textContent = slot.name;
    row.appendChild(label);

    const cur = cat.equip[slot.id];
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.name;
      b.className = 'wd-item' + (cur === it.id ? ' on' : '');
      b.title = it.id;
      b.addEventListener('click', async () => {
        const r = await api.wardrobeSet(slot.id, it.id);
        if (!r.ok) say('这件穿不上：' + r.error);
        refreshWardrobe();
      });
      row.appendChild(b);
    }
    // 身份槽不提供「脱下」。判据用槽位上声明的 required，不再看商品的 locked：
    // 以后发型槽出第二款，仍然可以在两款之间换，只是不能脱空 ——
    // 用 items.every(locked) 反推的话，第二款忘标 locked 就会冒出脱下按钮。
    if (!slot.required) {
      const off = document.createElement('button');
      off.textContent = '脱下';
      off.className = 'wd-off' + (cur ? '' : ' on');
      off.addEventListener('click', async () => {
        const r = await api.wardrobeSet(slot.id, null);
        if (!r.ok) say('这件脱不掉：' + r.error);
        refreshWardrobe();
      });
      row.appendChild(off);
    }
    slotBox.appendChild(row);
  }
}

function say(text, ms = 3600) {
  if (streaming) return;
  clearTimeout(bubbleTimer);
  render(text);
  bubbleTimer = setTimeout(hideBubble, ms);
}

function hideBubble() {
  if (streaming) return;
  bubble.classList.add('hidden');
  syncMotionPriority();
  // 气泡收起 = 这一轮表现结束，状态必须回落 idle。
  // 否则 data-state 会一直挂着，单次动画（happy/annoyed）播完后
  // 桌宠就定格在最后一帧不再呼吸了。
  setState('idle');
}

/* ---------------- 记录 ---------------- */
function scrollLog() { logBody.scrollTop = logBody.scrollHeight; }

function addLog(kind, text) {
  const d = document.createElement('div');
  d.className = kind;
  d.textContent = text;
  logBody.appendChild(d);
  scrollLog();
  return d;
}

function toggleLog(on) {
  const showIt = on ?? log.classList.contains('hidden');
  log.classList.toggle('hidden', !showIt);
  // 记录面板会盖住气泡，两者内容重复，打开时就让位
  document.body.classList.toggle('showlog', showIt);
  syncMotionPriority();
  if (showIt) scrollLog();
}

/* ---------------- 对话 ---------------- */
let busy = false;
let acc = '';
let liveNode = null;      // 流式期间正在写入的那条记录

function show(t) {
  render(t);
  if (liveNode) {
    liveNode.textContent = '初澜：' + stripState(t);
    scrollLog();
  }
}

// 只注册一次。写在 submit 里会导致每发一条就多挂一个监听，
// 之后每次 delta 被回调 N 遍，文字重复叠加。
if (api) {
  api.onDelta((d) => {
    acc += d;
    if (streaming) show(acc);
  });
}

async function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  noteUserAct();
  await runChat(text, {});
}

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
  if (!proactive) input.value = '';
  busy = true;
  syncMotionPriority();
  sendBtn.disabled = true;
  pet.classList.add('thinking');
  setState('thinking');
  streaming = true;
  acc = '';
  if (!proactive) addLog('u', '你：' + text);
  liveNode = addLog('a', '初澜：');
  render('');

  try {
    if (!api) {                              // 浏览器预览：假回复，验证逐字渲染
      const demo = '（预览模式）我还没接上 API，正式运行时这里会逐字回复你~';
      for (let i = 1; i <= demo.length; i++) {
        await new Promise(r => setTimeout(r, 40));
        show(demo.slice(0, i));
      }
      liveNode.textContent = '初澜：' + demo;
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
        if (res.windowClosed) addLog('sys', res.merged ? '· 窗口已满，小结并合并了记忆' : '· 满一轮窗口，已生成小结');
        // 换装结果如实上报：程序真换了才算换了，失败也要让用户看见。
        // wears 是数组 —— 一条回复里连发多个提案时全部如实列出来。
        if (res.wears && res.wears.length)
          addLog('sys', (res.wearNote ? '· [换装] ' + res.wearNote : '· [换装] 未执行'));
        clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(hideBubble, 6000);
      } else if (res.needKey) {
        finish('(还没填 API Key，右键 → 设置 / 用量)');
        openPanel();
      } else if (res.aborted) {
        finish('(已取消)');
      } else {
        finish('(出错了：' + res.error + ')');
      }
    }
  } catch (e) {
    finish('(异常：' + e.message + ')');
  } finally {
    streaming = false;
    busy = false;
    // 再渲染一次，把闪烁光标去掉（此时 streaming 已为 false）
    if (lastText) render(lastText);
    liveNode = null;
    sendBtn.disabled = false;
    pet.classList.remove('thinking');
    syncMotionPriority();
  }

  function finish(t) {
    // 报错/取消也要退出 thinking，不然会一直卡在思考动画
    setState('idle');
    show(t);
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(hideBubble, 6000);
  }
}

sendBtn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
  if (e.key === 'Escape') setTalking(false);
});

function setTalking(on) {
  document.body.classList.toggle('talking', on);
  syncMotionPriority();
  if (on) setTimeout(() => input.focus(), 30);
  else input.blur();
}

/* ---------------- 拖动 ----------------
   透明无边框窗口的老 bug：手在窗口外松开时，渲染进程收不到 mouseup，
   dragging 永远为 true —— 桌宠就一直粘在鼠标上，甩都甩不掉。

   先说清楚为什么没用 Gemini 建议的两条：
   - setPointerCapture：它捕获的是**同一个 DOM 元素内**的指针，而这里丢事件
     的原因是光标离开了这个操作系统窗口（拖窗时窗口跟着走，边界处会有几帧
     落在窗外）。窗口之外的输入事件由别的程序拿到，Electron 不会替我们送进
     来，所以捕获得再正确也收不到那个 pointerup。
   - 给看门狗加 `moved > 6` 门槛（"只有真拖过才判脱手"）：方向对了一半，
     门槛装错了地方。实测（探针 S1）按下后抖 3px 再把手移出窗外松开，它的
     判据永远不触发 —— dragging 停在 true，松手后窗口还跟着鼠标跑。
     而它想救的"按住不动想停一下再拖"，卡住的也不是判据，是 700ms 这个值。
   真正的判据在事件自己身上：mousemove 带 buttons，按下是 1，窗外松手后光标
   只要再进窗口动一下，来的就是 buttons=0（实测 Q 组：按下 1 / 松手后 0，
   松手后事件照样送达 window）。这比任何计时器都快且零误判 —— 手还按着就
   永远不可能是 0。于是分工变成：
     1. mouseup（正常路径，绝大多数情况走这里）
     2. mousemove 且 buttons===0 —— 窗外松手后光标再进窗口，立刻收尾
     3. 窗口失焦 / 主进程 win.on('blur') 转发 drag-cancel
     4. 看门狗 —— 只兜最后一种：松手后鼠标再也没动过、也没有焦点变化。
        有了第 2 条，这个值可以从 700 放宽到 2500：按住停一下再拖（实测旧值
        700 会把这一下手势掐死，之后再挪窗口纹丝不动）不再被误判，而"永远
        粘着"的最坏情况也没变长多少 —— 正常情况下第 2 条早就接住了。 */
let dragging = false, lastX = 0, lastY = 0, moved = 0;
let dragWatch = null, lastMoveAt = 0;
const DRAG_IDLE_MS = 2500;

function endDrag() {
  if (!dragging) return;
  dragging = false;
  clearInterval(dragWatch);
  dragWatch = null;
  pet.classList.remove('dragging');
  syncMotionPriority();
  api && api.dragEnd();
  // 只报真的挪过的拖拽：失焦/看门狗兜底也会走到这里，没位移就不算一次互动，
  // 否则窗一失焦就给她凭空记一笔"被拖了一下"。
  if (api && api.activity && moved > 6) api.activity('drag');
}

pet.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  noteUserAct();   // 拖拽起手即算互动；click 里 moved>6 会提前 return，靠不到它
  dragging = true; moved = 0;
  lastX = e.screenX; lastY = e.screenY;
  lastMoveAt = Date.now();
  pet.classList.add('dragging');
  syncMotionPriority();
  api && api.dragStart();
  clearInterval(dragWatch);
  // 看门狗：拖拽中一旦 DRAG_IDLE_MS 没有任何 mousemove，就当作手已经在窗外松开了。
  // 这个值是个折中，两头都别踩：
  //   太短（一开始写 250ms）→ 用户慢慢挪、中途停一下就脱手，手感像坏了；
  //   太长 → "粘着不放"这个原始 bug 的体感时间跟着变长。
  // 700ms 比一次自然的停顿长，又足够让用户觉得"松了就该放开"。
  dragWatch = setInterval(() => {
    if (Date.now() - lastMoveAt > DRAG_IDLE_MS) endDrag();
  }, 250);
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  /* 手指已经松开的最快判据：buttons === 0。
     窗外松手时渲染进程收不到 mouseup，但**只要鼠标之后动过一下**，
     这个 mousemove 会带着 buttons=0 进来（实测按下=1 / 松手后=0，
     且松手后事件照样送达 window），所以立刻收尾，不用干等看门狗。
     看门狗退回它该待的位置：只兜"松手后再也没动过鼠标"这一种。 */
  if (e.buttons === 0) { endDrag(); return; }
  const dx = e.screenX - lastX, dy = e.screenY - lastY;
  lastX = e.screenX; lastY = e.screenY;
  moved += Math.abs(dx) + Math.abs(dy);
  if (dx || dy) lastMoveAt = Date.now();   // 有位移 = 手还按着
  if (api) api.dragMove(dx, dy);
  else {
    pet.style.left = (pet.offsetLeft + dx) + 'px';
    pet.style.bottom = (parseFloat(getComputedStyle(pet).bottom) - dy) + 'px';
  }
});

window.addEventListener('mouseup', endDrag);
// 失焦两个来源都接下来：浏览器自己的 blur，和主进程 win.on('blur') 转发的
window.addEventListener('blur', endDrag);
if (api && api.onDragCancel) api.onDragCancel(endDrag);

pet.addEventListener('click', () => {
  if (moved > 6) return;
  noteUserAct();
  if (animController) {
    animController.poke();
  } else {
    blink();
  }
  // 连戳的闹钟在这里敲：主进程拿 tracker 的真账判定够不够格
  notePokeAndMaybeAsk();
  if (!document.body.classList.contains('talking') && !api) setTalking(true);
});

function blink() {
  pet.classList.add('blink');
  setTimeout(() => pet.classList.remove('blink'), 200);
}

/* ---------------- 面板 ---------------- */
function openPanel() {
  panel.classList.remove('hidden');
  syncMotionPriority();
  refreshStats();
  refreshCreativeMode();
  refreshMem();
  refreshWardrobe();
}

async function refreshCreativeMode() {
  if (!creativeToggle || !creativeState) return;
  if (!api || !api.creativeModeGet) {
    creativeToggle.disabled = true;
    creativeState.textContent = '预览模式不可用';
    return;
  }
  try {
    const r = await api.creativeModeGet();
    const on = !!r.enabled;
    creativeToggle.textContent = on ? '关闭创作 Skill' : '载入创作 Skill';
    creativeToggle.classList.toggle('on', on);
    creativeState.textContent = on ? '成人向虚构创作模式已启用' : '日常聊天模式';
  } catch { creativeState.textContent = '读取模式失败'; }
}

/* 长期记忆可视化。文本一律用 textContent 写入 ——
   记忆内容来自模型输出，拼 innerHTML 等于自找 XSS。 */
async function refreshMem() {
  const box = document.getElementById('memList');
  box.textContent = '';
  if (!api) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '预览模式，无记忆数据';
    box.appendChild(p);
    return;
  }
  let list = [];
  try { list = await api.listMemory(); } catch { list = []; }
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '还没有长期记忆（聊满一轮窗口后会生成小结）';
    box.appendChild(p);
    return;
  }
  list.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'mem';

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m.label;

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = m.text;

    const del = document.createElement('button');
    del.textContent = '忘掉';
    del.title = '删除这条记忆';
    del.addEventListener('click', async () => {
      await api.deleteMemory(m.idx);
      refreshMem();
      refreshStats();
      say('好，这条我不记得了。');
    });

    row.append(tag, txt, del);
    box.appendChild(row);
  });
}

async function refreshStats() {
  const el = document.getElementById('stats');
  if (!api) { el.textContent = '预览模式，无数据'; return; }
  const r = await api.report();
  const g = await api.getConfig();
  if (!r) { el.textContent = '—'; return; }
  const low = r.requests > 3 && r.rate < 90;

  // 使用安全 DOM API 构建统计数据，彻底杜绝 innerHTML 注入风险
  el.textContent = '';

  const b = (text) => {
    const bElem = document.createElement('b');
    bElem.textContent = String(text);
    return bElem;
  };
  const span = (text, cls, id) => {
    const spanElem = document.createElement('span');
    spanElem.textContent = String(text);
    if (cls) spanElem.className = cls;
    if (id) spanElem.id = id;
    return spanElem;
  };
  const br = () => document.createElement('br');

  // 第 1 行：请求次数与模型
  el.append('请求 ', b(r.requests), ' 次　模型 ', span(r.model, '', 'stModel'));
  if (r.peak) {
    el.append(' ', span('(高峰价)', 'warn'));
  }
  el.appendChild(br());

  // 第 2 行：累计命中率
  el.append('累计命中率 ', b(r.rate + '%'));
  if (low) {
    el.append(' ', span('(偏低)', 'warn'));
  }
  el.appendChild(br());

  // 第 3 行：上一次统计
  el.append('上一次 ', b(r.lastRate + '%'), '　命中 ' + r.hit + ' / 未命中 ' + r.miss + ' tok');
  el.appendChild(br());

  // 第 4 行：输出与开销
  el.append('输出 ' + r.out + ' tok　花费 ', b('¥' + r.cost));
  el.appendChild(br());

  // 第 5 行：窗口与轮数
  el.append(
    '对话窗口 第' + r.windowNo + ' 段　',
    b(r.windowTurns + '/' + r.windowTarget),
    ' 轮　~' + r.historyTokens + ' tok　上下文 ~' + r.contextTokens + ' tok'
  );
  el.appendChild(br());

  // 第 6 行：记忆小结与合并
  el.append(
    '记忆 ' + r.segments + ' 条小结　',
    b(r.memoryTokens + '/' + r.memoryCap),
    ' tok　小结 ' + r.compressions + ' 次　合并 ' + r.merges + ' 次'
  );

  document.getElementById('keyState').textContent =
    g.hasKey
      ? (g.keyEncrypted ? '已配置 Key（磁盘上为加密存储）'
                        : '已配置 Key（注意：本机不支持加密，Key 仍是明文存储）')
      : '未配置 Key — 填一下才能对话';
  if (creativeToggle && g.writingMode !== undefined) {
    const on = !!g.writingMode;
    creativeToggle.textContent = on ? '关闭创作 Skill' : '载入创作 Skill';
    creativeToggle.classList.toggle('on', on);
    creativeState.textContent = on ? '成人向虚构创作模式已启用' : '日常聊天模式';
  }
}

document.getElementById('logClose').addEventListener('click', () => toggleLog(false));

document.getElementById('keySave').addEventListener('click', async () => {
  const v = document.getElementById('keyInput').value.trim();
  if (!v) return;
  if (api) {
    const r = await api.setKey(v);
    if (r && r.ok === false) return say('保存 Key 失败：' + r.error);
    document.getElementById('keyInput').value = '';
  }
  refreshStats();   // 存储状态（加密/明文）由它按主进程返回值刷新，别在这里下结论
  say('好啦，现在能跟我说话了~');
});

if (creativeToggle) creativeToggle.addEventListener('click', async () => {
  if (!api || !api.creativeModeGet || !api.creativeModeSet) return;
  try {
    const cur = await api.creativeModeGet();
    const r = await api.creativeModeSet(!cur.enabled);
    if (!r.ok) return say('创作模式切换失败：' + r.error);
    refreshCreativeMode();
    say(r.enabled ? '创作 Skill 已载入，只影响当前 system，不写入长期记忆。' : '已回到日常聊天模式。');
  } catch (e) { say('创作模式切换失败：' + e.message); }
});

document.getElementById('openCfg').addEventListener('click', () => api && api.openConfig());

document.getElementById('clearMem').addEventListener('click', async () => {
  if (api) {
    await api.clearMemory();
    logBody.replaceChildren();
    // 面板上眼前的一切必须同步刷新，不能后端清了、列表还挂着旧记忆
    refreshMem();
    refreshStats();
  }
  say('我们重新认识一次吧。');
});

document.getElementById('resetSelf').addEventListener('click', async () => {
  if (!api || !api.resetSelfLedger) return;
  const ok = window.confirm('这会删除初澜出生以来的成长档案，并把她视为一次新的出生。确定继续吗？');
  if (!ok) return;
  const res = await api.resetSelfLedger();
  if (!res || !res.ok) return say('成长档案重置失败：' + ((res && res.error) || '未知错误'));
  refreshStats();
  say('好，我们从现在重新认识。');
});

document.getElementById('closePanel').addEventListener('click', () => {
  panel.classList.add('hidden');
  syncMotionPriority();
});

/* ---------------- 实验观测与可复盘工具面板 (v0.9.5) ---------------- */
let currentResearchHashes = null;
let activeReplayPollingTimer = null;
let currentSelectedTrait = null;
let currentSelectedWindowNo = 1;
let currentSelectedSegIndex = 1;

async function openResearchPanel() {
  if (!researchPanel) return;
  researchPanel.classList.remove('hidden');
  syncMotionPriority();

  // 1. 获取并记录初始哈希 (SHA-256 完整性门禁)
  if (api && api.research && api.research.getHashes) {
    try {
      currentResearchHashes = await api.research.getHashes();
      const hEl = document.getElementById('rFooterHashes');
      if (hEl && currentResearchHashes) {
        hEl.textContent = 'Archive SHA: ' + (currentResearchHashes.archiveSha256 ? currentResearchHashes.archiveSha256.slice(0, 8) : 'none')
          + ' | State SHA: ' + (currentResearchHashes.stateSha256 ? currentResearchHashes.stateSha256.slice(0, 8) : 'none');
      }
    } catch (e) {
      console.warn('[Research] 读取哈希失败:', e.message);
    }
  }

  await loadResearchData();
}

async function closeResearchPanel() {
  if (!researchPanel) return;
  if (activeReplayPollingTimer) {
    clearInterval(activeReplayPollingTimer);
    activeReplayPollingTimer = null;
  }

  // 2. 退出时核验哈希 (Read-Only 强约束，确保观测前后零修改)
  if (api && api.research && api.research.verifyIntegrity && currentResearchHashes) {
    try {
      const chk = await api.research.verifyIntegrity(currentResearchHashes);
      if (!chk.ok) {
        console.error('[Research] 违规写操作检测:', chk.error);
        alert('警告：检测到实验数据发生变更！\n' + chk.error);
      }
    } catch (e) {
      console.error('[Research] 完整性校验异常:', e.message);
    }
  }

  researchPanel.classList.add('hidden');
  syncMotionPriority();
}

async function loadResearchData() {
  const statusEl = document.getElementById('rFooterStatus');
  if (statusEl) statusEl.textContent = 'Snapshot: 正在加载数据...';

  if (!api || !api.research) {
    if (statusEl) statusEl.textContent = 'Snapshot: 预览模式 (降级演示)';
    renderStateDemo();
    return;
  }

  try {
    const snap = await api.research.refresh();
    if (statusEl) {
      const d = snap && snap.snapshotTimestamp ? new Date(snap.snapshotTimestamp).toLocaleTimeString() : '';
      statusEl.textContent = `Snapshot: ${d} | 观察层只读受控`;
    }
    const state = (snap && snap.state) || (await api.research.getState());
    renderSubjectStateTab(state);
    await loadWindowsTab();
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Snapshot 加载失败: ' + err.message;
  }
}

function renderSubjectStateTab(state) {
  const container = document.getElementById('rTraitsList');
  if (!container) return;
  container.textContent = '';

  const traits = (state && state.traits) || {};
  const traitNames = [
    'quiet_preference',
    'social_initiative',
    'attachment_need',
    'vitality',
    'philosophical_curiosity'
  ];

  for (const tName of traitNames) {
    const info = traits[tName] || { current: 0, previous: 0, latestDelta: 0 };
    const card = document.createElement('div');
    card.className = 'r-trait-card' + (currentSelectedTrait === tName ? ' selected' : '');
    card.dataset.trait = tName;

    const titleEl = document.createElement('div');
    titleEl.className = 'r-trait-name';
    titleEl.textContent = tName;

    const valEl = document.createElement('div');
    valEl.className = 'r-trait-val';
    valEl.textContent = String(info.current ?? 0);

    const metaEl = document.createElement('div');
    metaEl.className = 'r-trait-meta';
    const delta = info.latestDelta ?? 0;
    const deltaStr = delta > 0 ? `+${delta}` : String(delta);
    const deltaCls = delta > 0 ? 'r-delta-pos' : (delta < 0 ? 'r-delta-neg' : 'r-delta-zero');

    metaEl.append(
      '前值: ' + (info.previous ?? 0) + ' | 增量: ',
      (() => { const s = document.createElement('span'); s.className = deltaCls; s.textContent = deltaStr; return s; })()
    );

    card.append(titleEl, valEl, metaEl);
    card.addEventListener('click', () => {
      document.querySelectorAll('.r-trait-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      currentSelectedTrait = tName;
      loadTraitHistory(tName);
    });

    container.appendChild(card);
  }

  if (!currentSelectedTrait) {
    currentSelectedTrait = traitNames[0];
  }
  loadTraitHistory(currentSelectedTrait);
}

async function loadTraitHistory(trait) {
  const box = document.getElementById('rTraitHistory');
  if (!box) return;
  box.textContent = '';

  if (!api || !api.research) {
    box.textContent = `[${trait}] 预览历史：Window #1: 0 → +15 (Δ+15)`;
    return;
  }

  try {
    const res = await api.research.getStateChanges({ trait, limit: 100 });
    const items = (res && res.items) || [];
    if (!items.length) {
      box.textContent = `特质 [${trait}] 暂无状态跃迁历史`;
      return;
    }

    for (const sc of items) {
      const row = document.createElement('div');
      row.className = 'r-table-row';

      const left = document.createElement('span');
      left.textContent = `Window #${sc.windowNo || 1} | ${sc.previousValue ?? 0} → ${sc.newValue ?? 0}`;

      const right = document.createElement('span');
      const d = sc.delta ?? 0;
      right.className = d > 0 ? 'r-delta-pos' : (d < 0 ? 'r-delta-neg' : 'r-delta-zero');
      right.textContent = (d > 0 ? `+${d}` : String(d)) + ` (${sc.stateChangeId || ''})`;

      row.append(left, right);
      row.style.cursor = 'pointer';
      row.title = '点击跳转至溯源';
      row.addEventListener('click', () => {
        switchResearchTab('provenance');
        const scInput = document.getElementById('rScInput');
        if (scInput) scInput.value = sc.stateChangeId || sc.changeId || '';
        runTraceProvenance(sc.stateChangeId || sc.changeId);
      });

      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = '加载历史失败: ' + e.message;
  }
}

async function loadWindowsTab() {
  const sel = document.getElementById('rWindowSelect');
  if (!sel) return;
  sel.textContent = '';

  if (!api || !api.research) {
    const opt = document.createElement('option');
    opt.value = '1';
    opt.textContent = 'Window #1';
    sel.appendChild(opt);
    renderWindowDetailDemo(1);
    return;
  }

  try {
    const res = await api.research.getWindows({ limit: 100 });
    const windows = (res && res.items) || [];
    if (!windows.length) {
      const opt = document.createElement('option');
      opt.value = '1';
      opt.textContent = 'Window #1 (初始)';
      sel.appendChild(opt);
    } else {
      for (const w of windows) {
        const opt = document.createElement('option');
        opt.value = String(w.windowNo);
        const turnStr = (w.turns !== null && w.turns !== undefined) ? `${w.turns} 轮` : '轮次未知';
        const msgStr = (w.messageCount !== null && w.messageCount !== undefined) ? `${w.messageCount} 条` : '条数未知';
        opt.textContent = `Window #${w.windowNo} (${turnStr} / ${msgStr})`;
        sel.appendChild(opt);
      }
    }
    currentSelectedWindowNo = Number(sel.value || 1);
    await loadWindowDetail(currentSelectedWindowNo);
  } catch (e) {
    console.warn('[Research] 加载窗口列表失败:', e.message);
  }
}

async function loadWindowDetail(windowNo) {
  const card = document.getElementById('rWindowSummaryCard');
  if (!card) return;
  card.textContent = '正在读取窗口数据...';

  if (!api || !api.research) {
    renderWindowDetailDemo(windowNo);
    return;
  }

  try {
    const detail = await api.research.getWindow({ windowNo });
    if (!detail) {
      card.textContent = `Window #${windowNo} 尚无经历归档数据`;
      return;
    }

    card.textContent = '';
    const b = (t) => { const el = document.createElement('b'); el.textContent = String(t); return el; };
    const br = () => document.createElement('br');

    const turnsDisplay = (detail.turns !== null && detail.turns !== undefined) ? detail.turns : '未知';
    const msgCountDisplay = (detail.messageCount !== null && detail.messageCount !== undefined) ? detail.messageCount : '未知';

    card.append(
      '窗口 No: ', b(detail.windowNo), ' | 轮次: ', b(turnsDisplay),
      ' | 消息总计: ', b(msgCountDisplay),
      br(),
      'Events: ', b(detail.events ? detail.events.length : 0),
      ' | Observations: ', b(detail.observations ? detail.observations.length : 0),
      ' | Interpretations: ', b(detail.interpretations ? detail.interpretations.length : 0),
      br(),
      '接受证据: ', b(detail.verifiedEvidence ? detail.verifiedEvidence.length : 0),
      ' | 拒绝证据: ', b(detail.rejectedEvidence ? detail.rejectedEvidence.length : 0),
      ' | 状态变动: ', b(detail.stateChanges ? detail.stateChanges.length : 0)
    );

    const ib = document.getElementById('rWindowIntegrityBadge');
    if (ib) {
      ib.textContent = detail.archiveIntegrity || 'CERTIFIED';
      ib.className = 'r-badge ' + (detail.archiveIntegrity === 'CERTIFIED' ? 'badge-certified' : 'badge-uncertified');
    }
    const rb = document.getElementById('rWindowReplayBadge');
    if (rb) {
      rb.textContent = detail.replayStatus || 'COMPLETE';
      rb.className = 'r-badge ' + (detail.replayStatus === 'COMPLETE' ? 'badge-certified' : 'badge-uncertified');
    }

    await loadRounds(windowNo, currentSelectedSegIndex);
  } catch (e) {
    card.textContent = '读取窗口详情失败: ' + e.message;
  }
}

async function loadRounds(windowNo, segmentIndex) {
  const box = document.getElementById('rRoundsList');
  if (!box) return;
  box.textContent = '';

  if (!api || !api.research) {
    renderRoundsDemo(segmentIndex);
    return;
  }

  try {
    const rounds = await api.research.getWindowRounds({ windowNo, segmentIndex });
    if (!Array.isArray(rounds) || !rounds.length) {
      box.textContent = `分段 ${segmentIndex} 暂无消息轮次`;
      return;
    }

    for (const rd of rounds) {
      const item = document.createElement('div');
      item.className = 'r-round-item';

      const head = document.createElement('div');
      head.style.display = 'flex';
      head.style.justifyContent = 'space-between';
      head.style.alignItems = 'center';
      head.style.marginBottom = '2px';

      const tag = document.createElement('span');
      let badgeClass = 'badge-active';
      const status = String(rd.status || rd.tag || '').toUpperCase();
      if (rd.bridge === true || status === 'BRIDGE') badgeClass = 'badge-bridge';
      else if (status === 'RECORDED') badgeClass = 'badge-recorded';
      else if (status === 'NOT_RECORDED') badgeClass = 'badge-not-recorded';
      else if (status === 'UNRESOLVED') badgeClass = 'badge-unresolved';
      else if (status === 'CORRUPTED') badgeClass = 'badge-corrupted';
      else if (status === 'MISSING') badgeClass = 'badge-missing';
      else if (status === 'ACTIVE') badgeClass = 'badge-active';

      tag.className = 'r-badge ' + badgeClass;
      tag.textContent = rd.tag || rd.status || (rd.bridge ? 'BRIDGE' : (rd.bridge === false ? 'ACTIVE' : 'UNRESOLVED'));

      const rTitle = document.createElement('span');
      rTitle.style.color = '#8ea1cb';
      rTitle.textContent = typeof rd.roundNo === 'number' ? `第 ${rd.roundNo} 轮` : `[未确定轮次]`;

      head.append(rTitle, tag);

      const statusDesc = rd.status === 'NOT_RECORDED' ? '未记录交互'
        : (rd.status === 'UNRESOLVED' ? '无法确定：证据不完整'
        : (rd.status === 'CORRUPTED' ? '记录损坏'
        : (rd.status === 'MISSING' ? '记录缺失' : (rd.status || '未记录交互'))));

      const uMsg = document.createElement('div');
      uMsg.style.color = '#8fd0a8';
      if (rd.userMessage && rd.userMessage.content != null) {
        const uId = rd.userMessage.messageId ? `[${rd.userMessage.messageId}] ` : '';
        uMsg.textContent = `${uId}用户: ${rd.userMessage.content}`;
      } else {
        uMsg.style.color = '#7f8c8d';
        uMsg.textContent = `用户: [${statusDesc}]`;
      }

      const aMsg = document.createElement('div');
      aMsg.style.color = '#cfe0ff';
      if (rd.assistantMessage && rd.assistantMessage.content != null) {
        const aId = rd.assistantMessage.messageId ? `[${rd.assistantMessage.messageId}] ` : '';
        aMsg.textContent = `${aId}初澜: ${rd.assistantMessage.content}`;
      } else {
        aMsg.style.color = '#7f8c8d';
        aMsg.textContent = `初澜: [${statusDesc}]`;
      }

      item.append(head, uMsg, aMsg);
      box.appendChild(item);
    }
  } catch (e) {
    box.textContent = '加载轮次失败: ' + e.message;
  }
}

async function runTraceProvenance(stateChangeId) {
  const box = document.getElementById('rProvResult');
  if (!box) return;
  box.textContent = '正在反查溯源链...';

  if (!stateChangeId) {
    box.textContent = '请输入或选择 StateChange ID';
    return;
  }

  if (!api || !api.research) {
    box.textContent = `[演示] ${stateChangeId} -> EV-000001 (quiet_preference +1) -> M-000101 -> “今天看了一本关于数字生命的书”`;
    return;
  }

  try {
    const res = await api.research.getProvenance(stateChangeId);
    if (!res || !res.found) {
      box.textContent = `未找到状态跃迁记录: ${stateChangeId}`;
      return;
    }

    box.textContent = '';
    const sc = res.stateChange;
    const title = document.createElement('div');
    title.style.color = '#70a1ff';
    title.style.fontWeight = 'bold';
    title.textContent = `StateChange [${sc.stateChangeId}] | Window #${sc.windowNo} | 特质: ${sc.trait} (${sc.previousValue} → ${sc.newValue}, Δ${sc.delta})`;
    box.appendChild(title);

    if (!res.chain || !res.chain.length) {
      const emptyTip = document.createElement('div');
      emptyTip.style.color = '#7d8aa8';
      emptyTip.textContent = '  └─ 无关联的 Evidence 记录';
      box.appendChild(emptyTip);
      return;
    }

    for (const c of res.chain) {
      const evNode = document.createElement('div');
      evNode.style.margin = '4px 0 2px 10px';
      evNode.style.color = '#a4b6df';

      const evBadge = document.createElement('span');
      evBadge.className = 'r-badge ' + (c.status === 'verified' ? 'badge-accepted' : 'badge-rejected');
      evBadge.textContent = c.status ? c.status.toUpperCase() : 'VERIFIED';

      evNode.append(
        '  ├─ Evidence: ', evBadge, ` [${c.evidenceId}] (方向: ${c.direction > 0 ? '+1' : '-1'}, 强度: ${c.strength})`
      );

      const msgNode = document.createElement('div');
      msgNode.style.margin = '2px 0 4px 24px';
      msgNode.style.color = '#d0daf2';
      msgNode.append(
        `  └─ Message: [${c.messageId}] (${c.messageRole}) 原文: “${c.messageContent}”\n`,
        (() => {
          const q = document.createElement('span');
          q.style.color = '#8fe0a8';
          q.textContent = `     引用摘录: “${c.quote}” (完全匹配核验证实)`;
          return q;
        })()
      );

      box.append(evNode, msgNode);
    }
  } catch (e) {
    box.textContent = '溯源失败: ' + e.message;
  }
}

async function runTraceEOI(id) {
  const box = document.getElementById('rEoiResult');
  if (!box) return;
  box.textContent = '正在追溯 EOI 三层事实...';

  if (!id) {
    box.textContent = '请输入 Event/Observation/Interpretation ID';
    return;
  }

  if (!api || !api.research) {
    box.textContent = `[演示] ${id} 包含完整的 Interpretation -> Observation -> Event -> Message 链接`;
    return;
  }

  try {
    const res = await api.research.getEOI(id);
    if (!res || res.found === false) {
      box.textContent = `未检索到实体: ${id}`;
      return;
    }

    box.textContent = '';
    const root = document.createElement('div');
    root.style.fontWeight = 'bold';
    root.style.color = '#f0e6ff';
    root.textContent = `EOI 根节点 [${res.type}]: ${id}`;
    box.appendChild(root);

    if (res.observations) {
      for (const o of res.observations) {
        const obsEl = document.createElement('div');
        obsEl.style.marginLeft = '10px';
        obsEl.style.color = '#82cbff';
        obsEl.textContent = `  ├─ Observation [${o.observationId}]: ${o.content} (置信度: ${o.confidence})`;
        box.appendChild(obsEl);
      }
    }

    if (res.events) {
      for (const e of res.events) {
        const evtEl = document.createElement('div');
        evtEl.style.marginLeft = '20px';
        evtEl.style.color = '#8fe0a8';
        evtEl.textContent = `  └─ Event [${e.eventId}] (type: ${e.type}, msg: ${e.messageId}): ${e.payload ? (e.payload.content || '') : ''}`;
        box.appendChild(evtEl);
      }
    }
  } catch (e) {
    box.textContent = 'EOI 追溯失败: ' + e.message;
  }
}

async function loadRejectedEvidence() {
  const box = document.getElementById('rRejectedList');
  if (!box) return;
  box.textContent = '正在读取被拒绝证据...';

  if (!api || !api.research) {
    box.textContent = '预览模式：暂无被拒证据';
    return;
  }

  try {
    const res = await api.research.getEvidence({ status: 'rejected', limit: 100 });
    const items = (res && res.items) || [];
    if (!items.length) {
      box.textContent = '暂无被拒绝证据记录 (所有模型提案证据均合法证实或未有非法请求)';
      return;
    }

    box.textContent = '';
    for (const ev of items) {
      const row = document.createElement('div');
      row.className = 'r-table-row';

      const left = document.createElement('span');
      left.textContent = `[${ev.evidenceId}] Trait: ${ev.trait || 'UNKNOWN'} | 消息: ${ev.messageId || 'N/A'}`;

      const right = document.createElement('span');
      right.className = 'r-badge badge-rejected';
      right.textContent = ev.reason || 'REJECTED';

      row.append(left, right);
      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = '读取被拒证据失败: ' + e.message;
  }
}

function switchResearchTab(tabName) {
  document.querySelectorAll('.r-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.rtab === tabName);
  });
  document.querySelectorAll('.r-pane').forEach(p => p.classList.add('hidden'));

  const paneMap = {
    state: document.getElementById('rPaneState'),
    windows: document.getElementById('rPaneWindows'),
    provenance: document.getElementById('rPaneProvenance'),
    replay: document.getElementById('rPaneReplay'),
    export: document.getElementById('rPaneExport')
  };

  if (paneMap[tabName]) paneMap[tabName].classList.remove('hidden');
}

async function startReplay(opts = {}) {
  if (!api || !api.research) {
    alert('预览模式不支持真实 Replay 推演');
    return;
  }
  const fill = document.getElementById('rProgressBarFill');
  const stageEl = document.getElementById('rProgressStage');
  const pctEl = document.getElementById('rProgressPercent');
  const cancelBtn = document.getElementById('rReplayCancelBtn');
  const card = document.getElementById('rReplayResultCard');

  if (cancelBtn) cancelBtn.disabled = false;
  if (fill) fill.style.width = '0%';
  if (card) card.textContent = '正在启动 Replay 任务...';

  try {
    const startRes = await api.research.replayStart(opts);
    const taskId = startRes && startRes.taskId;
    if (!taskId) {
      if (card) card.textContent = '启动 Replay 失败';
      return;
    }

    if (activeReplayPollingTimer) clearInterval(activeReplayPollingTimer);
    activeReplayPollingTimer = setInterval(async () => {
      const st = await api.research.replayStatus(taskId);
      if (!st) return;
      if (fill) fill.style.width = (st.percent || 0) + '%';
      if (pctEl) pctEl.textContent = (st.percent || 0) + '%';
      if (stageEl) stageEl.textContent = `${st.stage} (${st.currentWindow}/${st.totalWindows} Windows)`;

      if (st.status === 'completed' || st.status === 'cancelled' || st.status === 'failed') {
        clearInterval(activeReplayPollingTimer);
        activeReplayPollingTimer = null;
        if (cancelBtn) cancelBtn.disabled = true;

        if (st.status === 'cancelled') {
          if (card) card.textContent = 'Replay 已由用户取消。';
          return;
        }
        if (st.status === 'failed') {
          if (card) card.textContent = 'Replay 异常失败: ' + st.error;
          return;
        }

        const res = st.result || {};
        card.textContent = '';
        const b = (t) => { const el = document.createElement('b'); el.textContent = String(t); return el; };
        const br = () => document.createElement('br');

        card.append(
          '推演结果: ', b(res.replayStatus ? res.replayStatus.toUpperCase() : 'COMPLETE'),
          ' | 完整性认证: ', b(res.integrity ? res.integrity.toUpperCase() : 'CERTIFIED'),
          br(),
          '状态跃迁总计: ', b(res.stateChanges ? res.stateChanges.length : 0), ' 次',
          ' | 接受证据: ', b(res.acceptedEvidenceCount || 0), ' 条',
          br()
        );

        if (res.failure) {
          const failSpan = document.createElement('div');
          failSpan.style.color = '#ff6b81';
          failSpan.style.marginTop = '4px';
          failSpan.textContent = `Fail-Stop 熔断: 第 ${res.failure.line} 行数据损坏 (${res.failure.reason})，推演已冻结在第 ${res.lastValidRecord} 行`;
          card.appendChild(failSpan);
        } else {
          const okSpan = document.createElement('div');
          okSpan.style.color = '#2ecc71';
          okSpan.style.marginTop = '4px';
          okSpan.textContent = 'Replay 推演与当前主体状态完全一致 (Certified)';
          card.appendChild(okSpan);
        }
      }
    }, 150);

    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        await api.research.replayCancel(taskId);
      };
    }
  } catch (err) {
    if (card) card.textContent = 'Replay 异常: ' + err.message;
    if (cancelBtn) cancelBtn.disabled = true;
  }
}

function renderStateDemo() {
  renderSubjectStateTab({
    traits: {
      quiet_preference: { current: 347, previous: 320, latestDelta: 27 },
      social_initiative: { current: 118, previous: 110, latestDelta: 8 },
      attachment_need: { current: 205, previous: 205, latestDelta: 0 },
      vitality: { current: 421, previous: 400, latestDelta: 21 },
      philosophical_curiosity: { current: 286, previous: 270, latestDelta: 16 }
    }
  });
}

function renderWindowDetailDemo(wNo) {
  const card = document.getElementById('rWindowSummaryCard');
  if (card) {
    card.textContent = `[演示] Window #${wNo} | 100 轮 | 200 条消息 | 5 分段 | 状态完整认证`;
  }
  renderRoundsDemo(1);
}

function renderRoundsDemo(segIdx) {
  const box = document.getElementById('rRoundsList');
  if (!box) return;
  box.textContent = '';
  for (let r = (segIdx - 1) * 20 + 1; r <= segIdx * 20; r++) {
    const item = document.createElement('div');
    item.className = 'r-round-item';
    item.textContent = `第 ${r} 轮 (UNRESOLVED): [演示环境未连接后端]`;
    box.appendChild(item);
  }
}

// 绑定 Research 面板内事件监听器
document.getElementById('rCloseBtn')?.addEventListener('click', closeResearchPanel);
document.getElementById('rRefreshBtn')?.addEventListener('click', loadResearchData);

document.querySelectorAll('.r-tab').forEach(btn => {
  btn.addEventListener('click', () => switchResearchTab(btn.dataset.rtab));
});

document.querySelectorAll('.r-seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.r-seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSelectedSegIndex = Number(btn.dataset.seg || 1);
    loadRounds(currentSelectedWindowNo, currentSelectedSegIndex);
  });
});

document.getElementById('rWindowSelect')?.addEventListener('change', (e) => {
  currentSelectedWindowNo = Number(e.target.value || 1);
  loadWindowDetail(currentSelectedWindowNo);
});

document.querySelectorAll('.r-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.r-subtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const sub = btn.dataset.subtab;
    const provPane = document.getElementById('rSubPaneProv');
    const eoiPane = document.getElementById('rSubPaneEoi');
    const rejPane = document.getElementById('rSubPaneRejected');
    if (provPane) provPane.classList.toggle('hidden', sub !== 'prov');
    if (eoiPane) eoiPane.classList.toggle('hidden', sub !== 'eoi');
    if (rejPane) rejPane.classList.toggle('hidden', sub !== 'rejected');
    if (sub === 'rejected') loadRejectedEvidence();
  });
});

document.getElementById('rTraceBtn')?.addEventListener('click', () => {
  const v = document.getElementById('rScInput')?.value?.trim();
  runTraceProvenance(v);
});

document.getElementById('rTraceEoiBtn')?.addEventListener('click', () => {
  const v = document.getElementById('rEoiInput')?.value?.trim();
  runTraceEOI(v);
});

document.getElementById('rReplayAllBtn')?.addEventListener('click', () => startReplay({}));
document.getElementById('rReplayUntilBtn')?.addEventListener('click', () => {
  const w = Number(document.getElementById('rReplayUntilWin')?.value);
  if (w > 0) startReplay({ untilWindow: w });
  else alert('请输入有效的目标窗口号');
});

// 绑定导出事件
async function handleExport(opts) {
  const out = document.getElementById('rExportOutput');
  if (!out) return;
  out.value = '正在生成导出数据...';
  if (!api || !api.research) {
    out.value = JSON.stringify({ note: '预览模式模拟导出', opts }, null, 2);
    return;
  }
  try {
    const res = await api.research.exportData(opts);
    if (typeof res === 'string') {
      out.value = res;
    } else {
      out.value = JSON.stringify(res, null, 2);
    }
  } catch (err) {
    out.value = '导出失败: ' + err.message;
  }
}

document.getElementById('rExpTrajJson')?.addEventListener('click', () => handleExport({ type: 'trajectory', format: 'json' }));
document.getElementById('rExpTrajCsv')?.addEventListener('click', () => handleExport({ type: 'trajectory', format: 'csv' }));
document.getElementById('rExpScCsv')?.addEventListener('click', () => handleExport({ type: 'state_changes', format: 'csv' }));
document.getElementById('rExpEvCsv')?.addEventListener('click', () => handleExport({ type: 'evidence', format: 'csv' }));
document.getElementById('rExpFullBundle')?.addEventListener('click', () => handleExport({ type: 'full', format: 'json' }));

/* ---------------- 右键菜单 ----------------
   夹紧必须按菜单**实测高度**算，不能写死常数：
   原来写 innerHeight - 220，而实测菜单高 272px（8 项），
   差了 52px —— 底部几项（缩小/退出）跑到窗口外面，
   透明窗口不显示也点不到，看起来就像菜单少了两项。
   同理 left 那个 130 也是猜的。 */
pet.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  menu.classList.remove('hidden');           // 先显示，才量得到尺寸
  const mh = menu.offsetHeight || 0, mw = menu.offsetWidth || 0;
  // 贴边时也别超出：上下左右各留 0，量不出来时退回旧行为至少不会 NaN
  const top = Math.max(0, Math.min(e.clientY, window.innerHeight - mh));
  const left = Math.max(0, Math.min(e.clientX, window.innerWidth - mw));
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
});

window.addEventListener('mousedown', (e) => {
  if (!menu.contains(e.target)) menu.classList.add('hidden');
});

menu.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  menu.classList.add('hidden');
  if (!act) return;
  if (act === 'quit') return api && api.quit();
  if (act === 'talk') return setTalking(!document.body.classList.contains('talking'));
  if (act === 'log') return toggleLog();
  if (act === 'panel') return openPanel();
  if (act === 'research') return openResearchPanel();
  if (act === 'pin') {
    if (!api) return say('预览模式没有窗口可固定');
    api.togglePin().then((on) => say(on ? '好啦，一直浮在最前面~' : '取消置顶了，会被别的窗口盖住哦'));
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
  if (act === 'bigger') { api ? api.resize(1.15) : grow(1.15); return; }
  if (act === 'smaller') { api ? api.resize(1 / 1.15) : grow(1 / 1.15); return; }
});

function grow(f) {
  pet.style.width = Math.min(420, Math.max(120, parseFloat(getComputedStyle(pet).width) * f)) + 'px';
}

/* ---------------- 启动 ---------------- */
if (localStorage.getItem('outline') === '1') document.body.classList.add('outline');
if (!api) document.body.classList.add('preview');

if (api && api.onMotionState) {
  api.onMotionState((s) => {
    document.body.dataset.motionState = s && s.state ? s.state : 'idle';
    document.body.dataset.motionLabel = s && s.label ? s.label : '静止';
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

  if (hasKey) say('嗨，我是初澜~', 4200);
  else say('先右键 → 设置，填上 API Key 哦', 6000);
})();

// 随机眨眼（若 animController 已接管则由其动力学自主调度，否则降级使用旧计时器）
if (!animController) {
  setInterval(() => { if (!document.hidden && Math.random() < 0.4) blink(); }, 4000);
}

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
  if (streaming || busy) return false;
  if (!bubble.classList.contains('hidden')) return false;
  // 用户正在输入：不打断
  if (document.activeElement === input || input.value.trim()) return false;
  if (kind === 'poke') return true;   // 被戳本身就是"现在方便"的意思
  // 刚互动过 90 秒内保持安静（idle 问候才需要这条）
  return Date.now() - lastUserAct >= 90000;
}

async function tryProactive() {
  if (!api || !api.proactiveCheck) return;
  if (busy || streaming) return;          // 先别看：连闸门都进不去，省一次 IPC
  let offer = null;
  try { offer = await api.proactiveCheck(); } catch { return; }
  if (!offer) return;
  if (!politeToSpeak(offer.kind)) return;  // 拿着提案拒了：不记冷却，下轮照问
  // 带 offer 发请求：主进程用它记账，且只有真的说出口才记（见 main.js）
  await runChat('（自言自语）', { proactive: true, offer });
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
      say('立绘资源未就绪，请按 ASSET-GENERATION-GUIDE.md 生成立绘放入 assets/', 10000);
    }
  });
}

if (api && api.onProactiveOffer) {
  api.onProactiveOffer(async (offer) => {
    if (!offer) return;
    if (busy || streaming || !politeToSpeak(offer.kind)) {
      if (api.proactiveDeclined) api.proactiveDeclined(offer);
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
      let line = FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
      if (line === lastAuto) line = FALLBACK[(FALLBACK.indexOf(line) + 1) % FALLBACK.length];
      lastAuto = line;
      say(line);
    }
  }, 45000);
}

// 页面卸载时注销主循环与计时器，杜绝后台泄漏
window.addEventListener('beforeunload', () => {
  if (behaviorScheduler) behaviorScheduler.destroy();
  if (animController) animController.destroy();
});
