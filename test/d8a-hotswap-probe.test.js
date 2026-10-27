/**
 * D-8a：热替换路径的 traits 刷新 —— 独立 harness。
 *
 * ## 为什么必须独立，不能塞进 main.test.js
 *
 * 想验「热替换后 traits 随新 brain 刷新」，最直接的做法是在 main.test.js 里
 * 调一次 config-set-key。实测**行不通**：本节后续几条测试依赖特定的内存 key 状态
 * （盘上塞进别的 apiKey / 盘上没有 apiKey 字段），多加一次 config-set-key 会把
 * 它们带崩（实测 2 条变红）。
 *
 * ⇒为验证一条断言去污染别人的状态，等于**用假信号换真结论**。
 * 所以这里另起一个进程：自己的假 electron、自己的临时 userData 目录。
 *
 * ## 为什么不能用源码 grep 了事
 *
 * main.test.js 里那条源码级断言能被绕过：有人把那句复制到别处、
 * 或者写个长得一样的字符串，`/if \(trigger\) trigger\.updateTraits\(...\)/`照样匹配。
 * 源码级断言只能当第二层。**本文件走真调用**。
 *
 * ## 本轮实测坐实的事（别重跑，别改判据）
 *
 * 1. DSH 任务提示词倾向的**方案 (a)**（把刷新句从 bindBrainDeps 删掉、
 *    只在 new TriggerEngine 之后补刷）**会造成回归**：
 *    bindBrainDeps 同时是 config-set-key / 换连接的 bindCandidate 回调
 *    （brain-hot-swap.js:51、connection-switch.js:89 真的调它），
 *    那条路径上 trigger 早已存在，那句是唯一的刷新点。
 *    实测删掉后：本文件两条 FAIL（启动断言仍过 —— 启动确实没问题，
 *    但热替换后 traits 停在旧值）。
 *
 * 2. **假反例的新形态**：断言写在 main.test.js 末尾时被代刷成恒真 ——
 *    前面那次 config-set-key 会重建 brain 并调 bindBrainDeps，顺手把 traits 刷上，
 *    于是「删掉修复代码」后仍 93/0 全绿。**不是别的闸门先熔断，
 *    而是更晚发生的另一条路径先把状态改了。**
 *
 * 3. **另一处恒真**：只比「引擎 traits == 新 brain traits」也不够——
 *    新 Brain 从磁盘加载，特质与旧 Brain 一模一样，刷没刷都相等。
 *    正解是先给旧 brain 预置明显不同的特质值，再让热替换发生。
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-d8a-'));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// ---- 假 electron：只需要 main.js 启动路径不炸 ----
const handlers = new Map();
let liveEngine = null;
let liveBrain = null;

const RealTrigger = require(path.join(ROOT, 'src/trigger.js'));
const brainMod = require(path.join(ROOT, 'src/brain.js'));
const RealBrain = brainMod.Brain;

// 主进程的 BrowserWindow 用 fake：方法集必须**覆盖 main.js createWindow + setupMotion
// 实际用到的每一个**。缺一个就在启动路径上抛（实测踩过：先缺 loadFile，再缺 getSize）。
// 这是本仓「mock 崩了会被误读成实现崩了」那条纪律的又一例 —— 报 bug 前先看替身忠实度。
//
// 🔴 senderFrame 的 url 也不是随便填的：ipc-guard 的 isAppLocalUrl 要求
//   file:协议**且位于应用目录内**，且 frame 必须 === event.sender.mainFrame。
//   填错会抛 UNTRUSTED_RENDERER —— 那是替身不忠实，**不是实现有 bug**，
//   两者别混（同一个坑本仓已踩 4+ 次）。
const realIndexUrl = require('url').pathToFileURL(path.join(ROOT, 'index.html')).href;
const fakeWin = {
  webContents: {
    send() {}, on() {}, setWindowOpenHandler() {},
    mainFrame: { url: realIndexUrl },
  },
  on() {}, show() {}, focus() {},
  isDestroyed: () => false, isVisible: () => true,
  isMinimized: () => false, isFocused: () => true,
  getSize: () => [256, 320],
  getPosition: () => [0, 0],
  getBounds: () => ({ x: 0, y: 0, width: 256, height: 320 }),
  setBounds() {}, setSize() {}, setPosition() {},
  setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {},
  setIgnoreMouseEvents() {}, loadFile() {},
  center() {},
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return {
    app: { getPath: () => DIR, whenReady: () => Promise.resolve(),
           on: () => {}, quit: () => {} },
    BrowserWindow: Object.assign(function () { return fakeWin; }, { allWindows: [] }),
    ipcMain: { handle: (c, f) => handlers.set(c, f), on: (c, f) => handlers.set('on:' + c, f) },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: { openPath: () => {} },
    Menu: { setApplicationMenu: () => {} },
    safeStorage: null,
    session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
  };
  // 抓住 main.js 自己 new 出来的引擎实例
  if (request === './src/trigger') {
    return Object.assign({}, RealTrigger, {
      TriggerEngine: function (...a) {
        const inst = new RealTrigger.TriggerEngine(...a);
        liveEngine = inst;
        return inst;
      },
    });
  }
  return origLoad.apply(this, arguments);
};

// 抓住 main.js 自己 new 出来的 Brain
class SpiedBrain extends RealBrain {
  constructor(...a) { super(...a); liveBrain = this; }
}
brainMod.Brain = SpiedBrain;

const trustedEvent = () => ({ sender: fakeWin.webContents, senderFrame: fakeWin.webContents.mainFrame });
const invoke = async (ch, a) => handlers.get(ch)(trustedEvent(), a);

// 🔴 残留防护：main.js 会在 DIR 下建 LifeSandbox / connections.json 等目录。
// 本仓 10-06 明确清理过一轮 %TEMP% 残留（用户抱怨过 tmp 目录），测试自己不许再留垃圾。
//
// ⚠️ 这里**刻意只用 try/finally，不用 process.on('exit')**：
//   实测加`process.on('exit', ...)` 会和末尾的 process.exit(0) 竞争，
//   出现「断言 6/0 全绿但 RC=1」——而且它与之前那次未归因的偶发 RC=1
//   **极可能是同一个形状**（这解释了为何连跑 5 次稳定、换个顺序就复现）。
//   ⇒ 结论：本仓测试的清理一律走 try/finally，别碰 process 生命周期事件。
const _cleanup = () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {} };

require(path.join(ROOT, 'main.js'));

(async () => {
  await new Promise((r) => setImmediate(r));

  /* ---- 第一层：启动路径 ---- */
  check('前置：拦截生效，抓到了引擎实例',
    liveEngine instanceof RealTrigger.TriggerEngine);
  check('前置：拦截生效，抓到了 Brain 实例', !!liveBrain);

  const bootTraits = liveEngine ? liveEngine.traits : null;
  check('启动后 traits 非 null（D-8a 修的那个 bug；修复前此处为 null）',
    bootTraits !== null, 'traits=' + JSON.stringify(bootTraits));

  /* ---- 第二层：热替换路径（本文件的核心） ----
   * 手法：给**旧** brain 预置明显不同的特质**并落盘**，再触发 config-set-key。
   * 新 Brain 是从磁盘加载的（SubjectState 构造即读盘），
   * 所以只有真的刷了，引擎才会跟着变。
   *
   * 🔴 第一版恒真的教训（实测踩过）：光改内存里的 values 不行 ——
   *   实测那样跑完 6/0 全绿，预置的 61/62 压根没到新 Brain（它读的是盘上初值 0）。
   *   必须 `subjectState.flush()` 把预置值落盘，新 Brain 才读得到。
   *   写入前要先备份盘上初值，测完还原，避免污染真实 userData。
   *
   * ⚠️ 另：不给特质设不同值就是恒真 —— 新旧 Brain 特质相同时，刷没刷都相等。
   */
  const PROBE_A = 61;
  const PROBE_B = 62;
  let traitsFile = null;
  let traitsBackup = null;
  try {
    traitsFile = path.join(DIR, 'subject-state.json');
    if (fs.existsSync(traitsFile)) traitsBackup = fs.readFileSync(traitsFile);
  } catch (_) {}
  if (liveBrain && liveBrain.subjectState) {
    // 🔴 坑一：subjectState.values 是 **getter，返回 {...this.data.values} 的副本**
    //   （src/subject-state.js:263）。往它上面赋值等于改临时对象，
    //   实测那样跑，新 Brain 读到的仍是盘上初值 0 ⇒ 前置断言变红、核心断言恒真。
    //   正确做法：改 this.data.values，再走 save(true) 落盘。
    //   🔴 坑二：文件在 userDataDir/subject-state.json，**不在 Life/ 子目录下**。
    const ss = liveBrain.subjectState;
    if (ss.data && ss.data.values) {
      ss.data.values.attachment_need = PROBE_A;
      ss.data.values.vitality = PROBE_B;
    }
    if (typeof ss.save === 'function') ss.save(true);
    else if (typeof ss.flush === 'function') ss.flush();
  }
  const beforeHotSwap = liveEngine ? JSON.stringify(liveEngine.traits) : '(null)';

  const kres = await invoke('config-set-key', 'sk-d8a-hotswap-probe');
  check('热替换成功', !!kres && kres.ok === true, JSON.stringify(kres));

  const freshBrain = liveBrain;
  const freshTraits = freshBrain && freshBrain.subjectState ? freshBrain.subjectState.values : null;
  const engTraits = liveEngine ? liveEngine.traits : null;

  // 前置：确认新 Brain 真的读到了预置值 —— 否则下面的比对没有意义
  check('前置：新 Brain 从盘上读到了预置特质（值确实变了，不是恒真）',
    !!freshTraits && freshTraits.attachment_need === PROBE_A
      && freshTraits.vitality === PROBE_B,
    'newBrain=' + JSON.stringify(freshTraits) + ' 期望 attachment_need=' + PROBE_A);

  check('🔴 热替换后引擎 traits 与**新** brain 逐键一致（非停留在旧值）',
    !!engTraits && !!freshTraits
      && Object.keys(freshTraits).every((k) => engTraits[k] === freshTraits[k]),
    '热替换前=' + beforeHotSwap + ' engine=' + JSON.stringify(engTraits)
      + ' newBrain=' + JSON.stringify(freshTraits));

  if (traitsFile && traitsBackup) {
    try { fs.writeFileSync(traitsFile, traitsBackup); } catch (_) {}
  }

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' 项失败' : 'D-8a 热替换 harness 全部通过'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness 自身异常：', e);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});