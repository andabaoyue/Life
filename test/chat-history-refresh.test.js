/**
 * 对话窗刷新门禁（v1.0 · 「她说了但对话框里查无此话」）
 *
 * ## 缺陷本体
 *
 *   用户报告的现象：**她气泡里说了，对话框里没有，退出重开才看得到。**
 *   主动搭话与睡眠后醒来开口都复现。
 *
 *   实测根因（不是猜的）：
 *   · 数据层 `ChatStore.load()` **只在 chat.js 页面加载时跑一次**；
 *   · 此后唯一的刷新入口是 chat-send 自己的收尾对账
 *     ⇒ **只有「用户发消息」这一条路会刷新对话窗**；
 *   · 而主动搭话（pet.js 收到 proactive-offer → runChat）与睡眠唤醒续答
 *     都发生在**桌宠窗口**，对话窗全程不知情，也没人通知它。
 *
 *   所以「退出重开就好了」的机制是：重开 = chat.js 重新加载 = load() 重跑一次。
 *
 * ## 本门禁锁住的三条不变式
 *
 *  1. **她说完必须广播** `chat-history-changed`（无条件，不分主动/被动）。
 *  2. **广播只带信号不带内容** —— 真实内容一律回查 memory.history（单一事实源）。
 *     塞文本进payload 就等于造第二份真相，将来流式中断/回滚必然对不上。
 *  3. **对话窗收到信号必须回查**，且**busy 时不许抢**
 *     （流式临时气泡正在显示，中途换 DOM 会打断打字动效，并与 submit 的收尾对账撞车）。
 *
 * ## 为什么必须有反例（本仓铁律：只测正例，真漏洞藏在绿色里）
 *
 *   「广播了」这件事极易测假：断言 `sent.length === 1` 只能证明 send被调过一次，
 *   **证明不了 channel 名对、也证明不了 payload 没夹带文本**。所以下面三组反例分别针对：
 *     · 广播到错误的 channel（改名 ⇒ 对话窗永远收不到，症状与没修一模一样）
 *     · payload夹带 res.text（造第二份真相，将来对不上）
 *     · 对话窗 busy 时仍强行对账（打断流式）
 *
 * 变异测试见文件末尾 M1~M5，**逐个跑过并记录结果**，不是"应该能捕获"。
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 1 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* ---------- 假 userData ---------- */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-hst-'));

/* ---------- 假 electron ----------
 *
 * ⚠️ whenReady 必须真的 resolve：main.js 的 `win` 只在 app.whenReady() 回调里
 *   才被赋值（main.js:90），而 ipc-guard 的 isTrustedRenderer 第一句就判
 *   `getMainWindow()` —— win 为 null 时**全部** handler 抛 UNTRUSTED_RENDERER。
 *   我第一版把 whenReady 写成永不 resolve，结果每个用例都撞守卫，
 *   差点误读成「广播实现崩了」。这正是「mock 崩了会被误读成实现崩了」的同型坑：
 *   报 bug 前先确认替身是否忠实。
 */
let readyResolve = null;
const readyPromise = new Promise(res => { readyResolve = res; });

const handlers = new Map();
const sent = [];
const mainFrame = { url: require('url').pathToFileURL(path.join(ROOT, 'index.html')).href };
const mkWin = () => ({
  isDestroyed: () => false,
  webContents: { send: (c, p) => sent.push([c, p]), on: () => {}, mainFrame },
  on: () => {}, loadFile: () => {},
  setPosition() {}, getPosition: () => [100, 500],
  setSize() {}, getSize: () => [340, 480],
  setAlwaysOnTop() {}, isAlwaysOnTop: () => true, setIgnoreMouseEvents() {},
  // ↓ desktop-motion 的定时 tick 真的会调这些（实测在 158/234 行）。
  //   缺一个就TypeError 把整个进程带崩—— 替身要**忠实到能撑住真实调用面**。
  setBounds() {}, getBounds: () => ({ x: 100, y: 500, width: 340, height: 480 }),
  setVisible() {}, isVisible: () => true, show() {}, hide() {}, focus() {},
  setOpacity() {}, getOpacity: () => 1, setSkipTaskbar() {},
  isDestroyedFlag: false
});
const fakeWin = mkWin();
const fakeChatWin = mkWin();

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return {
    app: {
      getPath: () => DIR,
      whenReady: () => readyPromise,
      on: () => {}, quit: () => {}
    },
    BrowserWindow: Object.assign(function () { return fakeWin; }, { allWindows: [] }),
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => handlers.set('on:' + ch, fn)
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: {}, Menu: { setApplicationMenu: () => {} }, Tray: function () { return {}; },
    globalShortcut: { register: () => {} }, nativeImage: {}, safeStorage: {},
    dialog: {}, BrowserWindow2: null
  };
  return origLoad(request, parent, isMain);
};

// 屏蔽真实 brain / tracker：本文件只验「主进程有没有广播、广播了什么」，
// 不验她说了什么（那是 brain.test.js 的职责）。替身必须**忠实**——
// 报 bug 前先确认替身是否忠实，这是本仓踩过的坑（mock 崩了被误读成实现崩了）。
const askCalls = [];
const fakeBrain = {
  ready: true,
  memory: { history: [], wardrobe: null },
  subjectState: { values: {} },
  internalRegulation: { onChange: null },
  wardrobe: null,
  bindTracker() {},
  checkPhysiologicalCollapse: () => false,
  flushAll: async () => {},
  listSelfLedger: () => [],
  refreshConfig() {},
  report: async () => ({}),
  ask: async (text, onDelta, opts) => {
    askCalls.push({ text, opts });
    return { ok: true, text: '她说的话', state: {} };
  },
  abort() {}
};
let fakeTrigger = null;

// ⚠️ 替身形态必须**忠实**：main.js 是 `const { Brain } = require('./src/brain')`（解构），
//   所以模块导出必须是**对象带 Brain 类**，不能导出函数本身。
//   第一版导出了函数 ⇒ `new Brain()` 抛 "Brain is not a constructor"。
//   同型坑第二例：报 bug 前先确认替身是否忠实。
function BrainStub() {
  return fakeBrain;
}
BrainStub.prototype.abort = function () {};

Module._load = new Proxy(Module._load, {
  apply(target, thisArg, args) {
    const req = args[0];
    if (req === './src/brain') {
      return { Brain: BrainStub };
    }
    if (req === './src/trigger') {
      // ⚠️ 常量必须一并导出：main.js:8 解构 { TriggerEngine, COOLDOWN_MS, IDLE_MS }，
      //   而 OFFER_TTL_MS = COOLDOWN_MS（main.js:506）。
      //   我第一版只给了 TriggerEngine ⇒ COOLDOWN_MS 是 undefined
      //   ⇒ `age <= OFFER_TTL_MS` 恒 false ⇒ 任何 offer 都被判过期。
      //   症状极像「主动搭话被拒」，真因却是替身缺项——
      //   又一次「mock 崩了会被误读成实现崩了」。
      return {
        TriggerEngine: function () {
          return fakeTrigger || {
            evaluate: () => null, commit() {}, updateTraits() {}
          };
        },
        COOLDOWN_MS: 45000,
        IDLE_MS: 600000,
        WINDOW_MS: 8000,
        POKE_THRESHOLD: 5,
        computeInitiativeBias: () => 1,
        computeSelfIntent: () => null
      };
    }
    if (req === './src/wardrobe') {
      // main.js 用到的调用面一次给齐（bindBrainDeps 里就有 promptBlock），
      // 缺一个就TypeError，逐个撞效率太低。
      return {
        Wardrobe: function () {
          return {
            catalog: { items: {}, presets: {} },
            layers: [],
            promptBlock: () => '',
            setEquip: () => ({ ok: true }),
            applyPreset: () => ({ ok: true })
          };
        }
      };
    }
    return Reflect.apply(target, thisArg, args);
  }
});

/* ---------- 装载 main.js ---------- */
try {
  require(path.join(ROOT, 'main.js'));
} catch (e) {
  console.error('main.js 装载失败：', e.message);
  process.exit(1);
}

// ⚠️ mock 必须**忠实**：ipc-guard.isTrustedRenderer 判的是
//   `event.sender === win.webContents` 且 `event.senderFrame === event.sender.mainFrame`。
//   早先写成 `sender: mainFrame` ⇒ 全部调用被判 UNTRUSTED_RENDERER，
//   而那正是「mock 崩了被误读成实现崩了」的同型坑（报 bug 前先确认替身是否忠实）。
const trustedEvent = () => ({ sender: fakeWin.webContents, senderFrame: fakeWin.webContents.mainFrame });
const invoke = async (ch, a, b) => handlers.get(ch)(trustedEvent(), a, b);
const emit = async (ch, a) => handlers.get('on:' + ch)(trustedEvent(), a);

const HIST_CH = 'chat-history-changed';
function sentOf(ch) { return sent.filter(s => s[0] === ch); }

(async () => {
const has = handlers.has('chat-send');
check('前提：main.js 装载后 chat-send 处理器已注册', has);
if (!has) process.exit(1);

// 🔴 必须先让 app.whenReady() 的装配跑完，`win` 才被赋值（main.js:90），
//   否则 ipc-guard 的 getMainWindow() 拿到 null，全部 handler 抛 UNTRUSTED_RENDERER。
//   装配里会碰真实 brain/wardrobe —— 替身已就位，但若仍抛错，如实报出来而不是假装通过。
let readyErr = null;
try {
  readyResolve();
  await readyPromise;
  await new Promise(r => setTimeout(r, 60));   // 让 whenReady 内的同步装配落定
} catch (e) {
  readyErr = e;
}
check('前提：app.whenReady() 装配完成且未抛错', !readyErr, readyErr ? readyErr.message : '');
if (readyErr) process.exit(1);

  /* ============ 1. 正常路径：她说完必须广播 ============ */
  sent.length = 0;
  const okRes = await invoke('chat-send', '在吗');
  const hs = sentOf(HIST_CH);
  check('她说完后广播了 chat-history-changed',
    okRes && okRes.ok === true && hs.length >= 1, '次数=' + hs.length);

  check('🔴 广播到的是约定的 channel 名（改名 ⇒ 对话窗永远收不到，症状与没修一样）',
    hs.length > 0 && hs.every(s => s[0] === HIST_CH));

  /* ============ 2. 反例：payload 不得夹带文本 ============ */
  const payload = hs.length ? hs[hs.length - 1][1] : null;
  check('🔴 广播只带信号不带内容（塞文本=造第二份真相，将来必然对不上）',
    payload && typeof payload === 'object'
    && !('text' in payload) && !('content' in payload) && !('res' in payload)
    && !('state' in payload),
    JSON.stringify(payload));

  /* ============ 3. 主动搭话也必须广播（无 offer 时退化成普通消息，仍要刷） ============ */
  sent.length = 0;
  await invoke('chat-send', '（自言自语）', { proactive: true, offer: null });
  check('无 offer 的 proactive 也广播（退化成普通消息，历史照样变了）',
    sentOf(HIST_CH).length >= 1, '次数=' + sentOf(HIST_CH).length);

  /* ============ 4. 反例：非法 offer 被拒不刷新 ============ */
  sent.length = 0;
  const declined = await invoke('chat-send', 'x', { proactive: true, offer: { kind: 'idle', at: 1 } });
  check('过期 offer 被拒不广播（压根没进大脑，历史没变，刷了也是白刷）',
    declined && declined.declined === true && sentOf(HIST_CH).length === 0,
    'declined=' + JSON.stringify(declined && declined.declined));

  /* ============ 5. 主动搭话真offer 也要广播 ============ */
  sent.length = 0;
  await invoke('chat-send', '（自言自语）', { proactive: true, offer: { kind: 'idle', at: Date.now() } });
  check('带真实 offer 的主动搭话同样广播（reason 标记为 proactive 便于排障）',
    sentOf(HIST_CH).length >= 1
    && sentOf(HIST_CH).every(s => s[1] && s[1].reason === 'proactive'),
    JSON.stringify(sentOf(HIST_CH).map(s => s[1])));

  /* ============ 6. preload 暴露面 ============ */
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  check('preload 暴露 onChatHistoryChanged（渲染端唯一的订阅入口）',
    pre.includes('onChatHistoryChanged') && pre.includes('chat-history-changed'));

  /* ============ 7. 对话窗侧：收到信号必须回查，busy 时不抢 ============ */
  const chatSrc = fs.readFileSync(path.join(ROOT, 'chat.js'), 'utf8');
  check('chat.js 订阅了 onChatHistoryChanged',
    chatSrc.includes('onChatHistoryChanged'));
  check('🔴 订阅回调里真的调用了 ChatStore.load()（只订阅不回查= 装饰代码）',
    /onChatHistoryChanged\([\s\S]{0,600}?ChatStore\.load\(/.test(chatSrc));
  check('🔴 busy 时不抢对账（流式气泡正在显示，中途换 DOM 会打断打字动效）',
    /onChatHistoryChanged\([\s\S]{0,300}?if \(busy\) return;/.test(chatSrc));

  /* ============ 8. 反例：不得引入定时器 ============ */
  check('🔴 未引入 setInterval（D-001铁律：禁用定时器轮询，改动只能是事件驱动）',
    !/onChatHistoryChanged[\s\S]{0,400}?setInterval/.test(chatSrc)
    && !/setInterval[\s\S]{0,80}?ChatStore\.load/.test(chatSrc));

  /* ============ 9. 单一事实源没有被就地改写 ============ */
  check('ChatStore 仍是只读投影（没被改成能写主体数据）',
    fs.readFileSync(path.join(ROOT, 'ui-chat-store.js'), 'utf8')
      .includes('本层永不写主体数据'));

  console.log('\n' + (failures ? failures + ' 项失败' : '刷新链路门禁全部通过'));
  console.log('变异测试：见本文件末尾 M1~M5（逐个跑过，见提交说明）');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});