/**
 * 主进程层测试：IPC 处理函数的行为。
 *
 * 为什么单独一个文件：main.js 里那些 handler 是渲染端唯一的入口，
 * 但 src/ 下面的单元测试碰不到它们 —— 于是"brain 那边对、main 传出去就错"
 * 这一整类缺陷没有任何护栏。本文件用假的 electron 模块把 main.js 装进
 * Node 里跑（同 brain 测试的路子：Module._load 拦截 require('electron')）。
 *
 * 重点覆盖 v0.7.1 修的配置读取盲区：热重载以前只挂在 brain.ask() 上，
 * 用户改完配置文件、不发消息直接开面板，看到的是旧值 —— 看起来像热重载
 * 根本没生效。以及"同步时绝不能把内存里的 apiKey 抹掉"（加密用户的盘上
 * 本来就没有 key 字段，一灌就空，表现是开一次设置面板她就再也不会说话）。
 *
 * 注意：main.js 一个进程只能 require 一次（模块级状态 + 注册 IPC），
 * 所以本文件所有断言必须在同一个假 electron 环境里顺序跑完。
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* ---------- 假的 userData 目录 ---------- */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-main-'));
const CFG = path.join(DIR, 'life-config.json');

/* ---------- 假的 electron ---------- */
const handlers = new Map();
const sent = [];
let pos = [100, 500], size = [340, 480], blurCb = null;
// SEC-01: handler 现经 sender/frame/URL 校验 —— 测试以受信主 frame 事件调用（fixture 补合规形态）
const mainFrame = { url: require('url').pathToFileURL(path.join(ROOT, 'index.html')).href };
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (c, p) => sent.push([c, p]), on: () => {}, mainFrame },
  // blur 要被 main.js 注册进来，探针才知道"窗口失焦"这条兜底路径通不通
  on: (ev, cb) => { if (ev === 'blur') blurCb = cb; },
  loadFile: () => {},
  setPosition(x, y) { pos = [x, y]; },
  getPosition: () => pos,
  getSize: () => size,
  setSize(w, h) { size = [w, h]; },
  setAlwaysOnTop() {}, isAlwaysOnTop: () => true,
  setIgnoreMouseEvents() {}
};
const origLoad = Module._load;
let liveEngine = null;// 🔴 D-8a：抓住 main.js 自己 new 出来的 TriggerEngine 实例
const RealTriggerMod = require(path.join(ROOT, 'src/trigger.js'));
Module._load = function (request) {
  if (request === 'electron') return {
    app: { getPath: () => DIR, whenReady: () => Promise.resolve(),
           on: () => {}, quit: () => {} },
    BrowserWindow: Object.assign(function () { return fakeWin; }, { allWindows: [] }),
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn),
               on: (ch, fn) => handlers.set('on:' + ch, fn) },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: { openPath: () => {} },
    Menu: { setApplicationMenu: () => {} },
    // safeStorage 缺失 = 加密不可用，走明文降级那条已测过的路
    safeStorage: null
  };
  // 🔴 D-8a：main.js 的启动顺序（bindBrainDeps → new TriggerEngine）
  //   在本进程里无法从外部观测 —— trigger 是模块级变量，不导出。
  //   办法是包一层构造器，把真实例存下来，让断言能直接读它的 traits。
  if (request === './src/trigger') {
    const wrapped = Object.assign({}, RealTriggerMod, {
      TriggerEngine: function (...a) {
        const inst = new RealTriggerMod.TriggerEngine(...a);
        liveEngine = inst;
        return inst;
      },
    });
    return wrapped;
  }
  return origLoad.apply(this, arguments);
};

// 抓住 main.js 自己 new 出来的 Brain，才能看它内部的 cfg / memory
const brainMod = require(path.join(ROOT, 'src/brain.js'));
const RealBrain = brainMod.Brain;
let brain = null;
class SpiedBrain extends RealBrain {
  constructor(...a) {
    if (SpiedBrain.failNext) {
      SpiedBrain.failNext = false;
      throw new Error('simulated Brain constructor crash');
    }
    super(...a);
    brain = this;
  }
}
SpiedBrain.failNext = false;
brainMod.Brain = SpiedBrain;
require(path.join(ROOT, 'main.js'));

const trustedEvent = () => ({ sender: fakeWin.webContents, senderFrame: fakeWin.webContents.mainFrame });
const invoke = async (ch, arg, arg2) => handlers.get(ch)(trustedEvent(), arg, arg2);
const emit = async (ch, arg) => handlers.get('on:' + ch)(trustedEvent(), arg);
const writeCfg = (o) => fs.writeFileSync(CFG, JSON.stringify(o, null, 2));
const readCfg = () => fs.readFileSync(CFG, 'utf8');

(async () => {
  /* main.js 的初始化全在 app.whenReady().then() 里（cfg / brain / wardrobe /
     createWindow），那是个微任务。断言必须在它跑完之后开始，否则第 1 节会看到
     "wardrobe 还没建、blur 还没注册"这种假失败。 */
  await new Promise(r => setImmediate(r));

  /* ============ 1. IPC 注册面：别开出旁路 ============ */
  check('注册了对话/配置/衣柜三组通道，且无 memory-delete / memory-clear 旁路（D-005）',
    ['chat-send', 'chat-report', 'config-get', 'config-set-key', 'config-open',
     'wardrobe-state', 'wardrobe-set', 'wardrobe-preset', 'memory-list',
     'chat-history', 'chat-busy', 'chat-window-open', 'chat-window-close', 'chat-window-toggle', 'chat-window-home', 'panel-viewport', 'self-timezone', 'life-mechanisms', 'dream-list', 'toggle-pin', 'pin-state']
      .every(c => handlers.has(c))
    && !handlers.has('memory-delete') && !handlers.has('memory-clear'));
  check('没有残留 wardrobe-apply（AI 换装只能走 chat-send 提案）',
    !handlers.has('wardrobe-apply'));
  check('注册了 drag-start / drag-move / drag-end',
    ['on:drag-start', 'on:drag-move', 'on:drag-end'].every(c => handlers.has(c)));
  check('main 注册了窗口 blur 兜底（丢 mouseup 的第二层）',
    typeof blurCb === 'function');

  /* ============ 2. 换装 IPC：状态查询与推送必须一致 ============ */
  const st0 = await invoke('wardrobe-state');
  check('wardrobe-state 同时给出 catalog 与图层',
    !!st0.catalog && Array.isArray(st0.layers) && st0.layers.length === 7,
    'layers=' + st0.layers.length);
  sent.length = 0;
  const rp = await invoke('wardrobe-preset', 'gothic');
  check('预设切换成功并推送新图层',
    rp.ok === true && sent.length === 1 && sent[0][0] === 'wardrobe-changed',
    JSON.stringify(sent.map(s => s[0])));
  check('推送的图层数与查询结果一致（屏幕和状态不会两个说法）',
    sent[0][1].length === 5 && (await invoke('wardrobe-state')).layers.length === 5,
    'push=' + sent[0][1].length);
  sent.length = 0;
  const rj = await invoke('wardrobe-set', { slot: 'top', itemId: 'gray_tee_01' });
  check('穿着连衣裙时穿上装被拒，且如实带回原因',
    rj.ok === false && /连衣裙不能和上装\/下装同时穿/.test(rj.error), rj.error);
  check('被拒不推送（屏幕不白闪，模型也不会以为刚换过）', sent.length === 0);
  check('发型槽支持自由脱下（解除锁定）',
    (await invoke('wardrobe-set', { slot: 'hair', itemId: null })).ok === true);
  check('未知槽位 / 未知预设被拒且不崩',
    (await invoke('wardrobe-set', { slot: 'nonsense', itemId: 'gray_tee_01' })).ok === false
    && (await invoke('wardrobe-preset', 'ghost')).ok === false);
  check('main 把穿着块同步给 brain（模型答穿着时看的是真实状态）',
    brain.memory.wardrobe.includes('【当前穿着】')
    && brain.memory.wardrobe.includes('哥特黑连衣裙'));

  /* ============ 3. 缩放：常量比例 + 下边缘钉住 ============ */
  const layout = require(path.join(ROOT, 'src/layout.js'));
  size = [layout.BASE_W, layout.BASE_H]; pos = [100, 500];   // v1.0 像素换代：起始锚新基准（256x320）
  const bottom0 = pos[1] + size[1];
  for (let i = 0; i < 6; i++) await emit('resize-pet', 1.1);
  check('放大 6 次后宽高比仍等于设计比例（旧写法逐次累积舍入误差）',
    Math.abs(size[1] / size[0] - layout.ASPECT) < 0.01, size.join('x'));
  for (let i = 0; i < 6; i++) await emit('resize-pet', 1 / 1.1);
  check('来回缩放能精确收回基准尺寸（v1.0 像素换代）', size[0] === layout.BASE_W && size[1] === layout.BASE_H, size.join('x'));
  check('每次缩放钉住下边缘（脚不陷进屏幕底）',
    Math.abs((pos[1] + size[1]) - bottom0) <= 1, bottom0 + ' -> ' + (pos[1] + size[1]));
  for (let i = 0; i < 30; i++) await emit('resize-pet', 2);
  check('连按放大停在 MAX_W 且重复调用不再挪窗口',
    size[0] === layout.MAX_W, 'w=' + size[0]);
  const atMax = size.join('x');
  await emit('resize-pet', 2);
  check('边界外重复调用尺寸一字不变', size.join('x') === atMax, size.join('x'));
  await emit('resize-pet', NaN);
  check('factor 传 NaN 不会把窗口弄成 NaN 尺寸',
    Number.isInteger(size[0]) && Number.isInteger(size[1]), size.join('x'));

  /* ============ 4. 拖拽兜底：blur 只在拖拽中才通知 ============ */
  sent.length = 0;
  if (blurCb) blurCb();
  check('未拖拽时 blur 不乱发 drag-cancel', sent.length === 0);
  await emit('drag-start', {});
  sent.length = 0;
  if (blurCb) blurCb();
  check('拖拽中 blur 会通知渲染端收尾',
    sent.length === 1 && sent[0][0] === 'drag-cancel', JSON.stringify(sent.map(s => s[0])));
  await emit('drag-end', {});
  sent.length = 0;
  if (blurCb) blurCb();
  check('drag-end 之后 blur 不再发', sent.length === 0);

  /* ============ 5. chat-send 契约：错误与 wears 如实上报 ============ */
  brain.cfg.apiKey = 'sk-test-key';
  const streamErr = new Error('Insufficient Balance（insufficient_credit）');
  streamErr.partial = '今天天气';
  brain.api.stream = async () => { throw streamErr; };
  const re = await invoke('chat-send', '随便说点');
  check('流内报错时 main 返回真实原因而不是"返回空内容"',
    re.ok === false && /Insufficient Balance/.test(re.error || ''), JSON.stringify(re));
  const raw2 = '换外套[wear:white_tech_jacket_01][wear:gray_tee_01][state:happy]';
  brain.api.stream = async (m, onDelta) => { onDelta(raw2); return { text: raw2, usage: {} }; };
  fs.rmSync(path.join(DIR, 'wardrobe.json'), { force: true });
  const { Wardrobe } = require(path.join(ROOT, 'src/wardrobe.js'));
  const wd2 = new Wardrobe(DIR);
  brain.wardrobe = wd2;
  brain.memory.wardrobe = wd2.promptBlock();
  const r2 = await invoke('chat-send', '叠穿');
  check('一条回复里连发两条提案，数组按原顺序贯穿到 IPC',
    r2.ok === true && JSON.stringify(r2.wears)
      === JSON.stringify(['white_tech_jacket_01', 'gray_tee_01']),
    JSON.stringify(r2.wears));
  check('两条执行结果逐条如实（不是笼统一句"换装成功"）',
    r2.wearNote === '本来就已经穿着 white_tech_jacket_01；已实际换上 gray_tee_01',
    JSON.stringify(r2.wearNote));
  check('衣柜真按第二条改了 top', wd2.equip.top === 'gray_tee_01');
  check('IPC 出口不带残留标记', !/\[wear:|\[state:/.test(r2.text), JSON.stringify(r2.text));

  /* ⚠️ 这一节必须留在**任何 config-set-key / 换连接之前**。
     实测踩过：断言写在文件末尾时，main.test.js:217 那次热替换会重建 brain
     并调 bindBrainDeps（那时 trigger 已就绪）⇒ 它顺手把 traits 刷上了。
     于是删掉修复代码后 93/0 仍然全绿 —— 断言看着在测启动路径，
     实际被更晚发生的另一条路径代刷了。这是「假反例」的新形态：
     **不是别的闸门先熔断，而是别的测试先把状态改了。** */
  /* ============ D-8a：启动时序（修 D-7「特质意图从未运行」） ============
   *
   * 这条是本轮的核心断言。前两条（trigger.test.js）只描述引擎行为，
   * 只有这条锁住「生产路径上 traits 确实被刷过了」。
   *
   * 缺陷形态：bindBrainDeps 跑在 `new TriggerEngine` 之前，那句
   * `if (trigger) updateTraits(...)` 直接落空 ⇒ 引擎 traits 长期为 null
   * ⇒ 5 档自意图只剩 idleness 两档，attachment/curiosity/vitality 从未触发。
   * 而用户不关窗就永远等不到那次关窗刷新 —— 所以它在真实运行里是静默的。
   *
   * ⚠️ 写这条时踩过的坑，别再踩：
   *   ① 断言「traits 非 null」不够 —— null 会被别人补上，得同时验证**内容**；
   *   ② 断言必须指向**引擎实例自己的 traits**，不是源码里有没有那句调用
   *      （源码 grep 类断言会被人「照抄一份到别处」骗过去，本仓已吃过亏）。
   */
  const eng = liveEngine;
  const { computeSelfIntent, SELF_INTENT_KINDS } = RealTriggerMod;
  const traitKinds = Object.keys(SELF_INTENT_KINDS)
    // 🔵 D-25：只列**特质档**（来源是 traits.*）—— 静默档与好奇档各有来源类别，
    //   不归本探针管（好奇档的探针在 d25 门禁里，走 curiosityPending 输入）。
    .filter((k) => SELF_INTENT_KINDS[k].requires !== 'idleness_minutes'
      && SELF_INTENT_KINDS[k].requires !== 'curiosity_pending');
  check('🔴 D-8a 主进程确实构造出了 TriggerEngine 实例（否则下面几条是空断言）',
    eng instanceof RealTriggerMod.TriggerEngine,
    eng ? '' : 'liveEngine=null —— 拦截失效，本节全部断言失去意义');

  // ③-1 启动后 traits 不得为 null（这条就是锁住本 bug 的那条）
  check('🔴 D-8a 启动后引擎 traits 非 null（修复前此处为 null）',
    !!eng && eng.traits !== null,
    'traits=' + JSON.stringify(eng && eng.traits));

  // ③-2 内容必须与brain 的真实特质一致，不能是「随便给了个非 null」
  const liveTraits = (brain && brain.subjectState) ? brain.subjectState.values : null;
  check('🔴 D-8a 引擎 traits 与 brain.subjectState.values 逐键一致（非空壳对象）',
    !!eng && !!liveTraits
      && Object.keys(liveTraits).length > 0
      && Object.keys(liveTraits).every((k) => eng.traits[k] === liveTraits[k]),
    'engine=' + JSON.stringify(eng && eng.traits) + ' brain=' + JSON.stringify(liveTraits));

  // ③-3 关键推论：引擎拿到的 traits 必须是**可用的输入**。
  //   断言形态说明：若启动时传错了对象（传{}、传 .data 而非 .values、
  //   或被谁清零），下面这圈会逐档失败。
  //   ⚠️ 这里刻意**不写** `reachable || 全档偏低` 这种带「或」的判据 ——
  //   全档偏低那条分支会让断言在什么都没发生时也通过（恒真式，本仓踩过多次）。
  //   正确做法：把每个特质键**抬到阈值以上**，要求它必然产出对应档。
  const traitInputUsable = !!eng && !!eng.traits && traitKinds.every((k) => {
    const spec = SELF_INTENT_KINDS[k];
    const boosted = Object.assign({}, eng.traits, { [spec.requires]: spec.min + 10 });
    const r = computeSelfIntent({ traits: boosted, idleMinutes: 0 });
    return !!r && r.kind === k
      && Array.isArray(r.sources) && r.sources.indexOf('traits.' + spec.requires) !== -1;
  });
  check('🔴 D-8a 引擎 traits 是可用的输入（逐档抬过阈值后必然产出该档意图）',
    traitInputUsable,
    'traits=' + JSON.stringify(eng && eng.traits) + '试了' + traitKinds.length + ' 档');

  /* ============ 6. 配置热重载盲区（本文件的主戏） ============ */
  const k0 = await invoke('config-set-key', 'sk-keepme-123');
  check('面板填 key 成功，加密不可用时如实标表明文降级',
    k0.ok === true && k0.hasKey === true && k0.keyEncrypted === false, JSON.stringify(k0));

  /* 🔴 D-8a：**热替换路径的 traits 刷新点**。
   *
   * 上一节那条断言必须放在热替换之前，否则会被这次调用「代刷」而失去意义
   * （实测踩过：删掉修复代码后仍 93/0 全绿）。反过来，**这一条必须放在热替换之后**：
   * 它守的是另一条路径 —— config-set-key 会重建 Brain 并经 brain-hot-swap 调
   * bindBrainDeps，那是「让新 brain 的特质灌进引擎」的唯一途径。
   *
   * ⚠️ 别为了消除 bindBrainDeps 里那句 `if (trigger)` 的空跑而把它删掉：
   *   启动路径可以在 new TriggerEngine 之后显式补刷，**热替换路径不能** ——
   *   删了这条会红，而且真实后果是换 key 后 traits 永久停在旧 brain 的值上。
   */
  // ⚠️ 这里**不能**自己调 config-set-key 来制造热替换：
  //   本节后续几条测试（盘上塞 key、盘上无 key 字段）依赖特定的内存 key 状态，
  //   实测多加一次 config-set-key 会把它们带崩（2 条变红）——
  //   为验证一条断言去污染别人的状态，等于用假信号换真结论。
  //   正解：热替换路径的验证放在独立 harness 里做，见 test/d8a-hotswap-probe.js。
  const afterSwapTraits = (brain && brain.subjectState) ? brain.subjectState.values : null;
  check('🔴 D-8a 热替换路径的 traits 刷新点仍在（源码级：bindBrainDeps 里那句必须存在）',
    /if \(trigger\) trigger\.updateTraits\(brain\.subjectState \? brain\.subjectState\.values : null\);/
      .test(require('fs').readFileSync(require('path').join(ROOT, 'main.js'), 'utf8')),
    'bindBrainDeps 内的刷新句缺失 ⇒ 热替换后 traits 会停在旧 brain 的值上');
  const c0 = await invoke('config-get');
  check('config-get 初始能读到 model', typeof c0.model === 'string' && !!c0.model,
    JSON.stringify(c0.model));

  const disk = JSON.parse(readCfg());
  disk.model = 'deepseek-chat-v99';
  disk.windowTurns = 7;
  writeCfg(disk);
  const c1 = await invoke('config-get');        // 只开面板，一条都没发
  check('改完配置文件、不发消息直接开设置面板就能看到新 model',
    c1.model === 'deepseek-chat-v99', JSON.stringify(c1.model));
  check('面板里的窗口轮数也是盘上那份', c1.windowTurns === 7, JSON.stringify(c1.windowTurns));

  // chat-report 单独判：上面那次 config-get 已经把内存同步好了，
  // 直接再调它当然对 —— 那测的是"前一个 handler 顺手修过"，不是它自己。
  brain.cfg.model = 'deepseek-flash';
  const rep = await invoke('chat-report');
  check('用量面板自己也会读盘（不是靠 config-get 顺手修好的）',
    rep && rep.model === 'deepseek-chat-v99', JSON.stringify(rep && rep.model));
  brain.cfg.model = 'deepseek-flash';
  check('设置面板同样自己读盘（两个 handler 各自独立成立）',
    (await invoke('config-get')).model === 'deepseek-chat-v99');

  /* apiKey 不参与热重载：盘上塞个别的进来，内存那份必须纹丝不动 */
  const tampered = JSON.parse(readCfg());
  tampered.apiKey = 'sk-FROM-DISK-SHOULD-BE-IGNORED';
  writeCfg(tampered);
  const cT = await invoke('config-get');
  check('盘上被塞进别的 apiKey 时内存里那份不被覆盖',
    brain.cfg.apiKey === 'sk-keepme-123' && cT.hasKey === true,
    JSON.stringify([brain.cfg.apiKey, cT.hasKey]));
  check('其它字段照常跟随磁盘（不是把同步整个关掉）',
    cT.model === 'deepseek-chat-v99', JSON.stringify(cT.model));

  /* 加密用户的常态：盘上根本没有 apiKey 字段，DEFAULTS 里那个空串会被合进来 */
  const noKey = JSON.parse(readCfg());
  delete noKey.apiKey;
  writeCfg(noKey);
  const cN = await invoke('config-get');
  check('盘上没有 apiKey 字段时内存 key 不被抹成空',
    brain.cfg.apiKey === 'sk-keepme-123' && cN.hasKey === true,
    JSON.stringify([brain.cfg.apiKey, cN.hasKey]));
  check('前提复核：那份盘上文件确实不含 apiKey 字段',
    !('apiKey' in JSON.parse(readCfg())));

  /* 同步要真生效到发送路径，不能只是面板数字好看 */
  check('DeepSeek 客户端与 main 共用同一个 cfg 对象（换引用就白同步）',
    brain.api.cfg === brain.cfg);
  let sentModel = null;
  brain.api.stream = async (m, onDelta) => {
    sentModel = brain.cfg.model;
    onDelta('好[state:happy]'); return { text: '好[state:happy]', usage: {} };
  };
  await invoke('chat-send', '说一句');
  check('下一轮请求确实带着新 model 出去', sentModel === 'deepseek-chat-v99',
    JSON.stringify(sentModel));

  /* 坏文件：保持现状，绝不退成出厂值 */
  fs.writeFileSync(CFG, '{坏的 json');
  const c3 = await invoke('config-get');
  check('配置文件被写坏时面板保持现状（不退成默认值）',
    c3.model === 'deepseek-chat-v99' && c3.windowTurns === 7,
    JSON.stringify([c3.model, c3.windowTurns]));
  check('坏文件不会把 apiKey 弄丢', (await invoke('config-get')).hasKey === true);
  check('坏文件也不会把 Memory 的窗口参数冲回出厂值',
    brain.memory.windowTurns === 7, JSON.stringify(brain.memory.windowTurns));
  const back = JSON.parse(JSON.stringify(disk));
  back.model = 'deepseek-pro-again';
  writeCfg(back);
  check('修好文件后面板恢复跟随磁盘',
    (await invoke('config-get')).model === 'deepseek-pro-again');

  /* config-set-key 会重建 Brain：穿着块不能跟着丢 */
  const k2 = await invoke('config-set-key', 'sk-new-456');
  check('改 key 后面板报 hasKey=true', k2.hasKey === true);
  check('重建的 brain 仍绑着衣柜（穿着块不丢）',
    !!brain.wardrobe && brain.memory.wardrobe.includes('【当前穿着】'),
    JSON.stringify((brain.memory.wardrobe || '').slice(0, 12)));
  const c6 = await invoke('config-get');
  check('重建 brain 之后 key 状态与 model 同时正确',
    c6.hasKey === true && c6.model === 'deepseek-pro-again',
    JSON.stringify([c6.hasKey, c6.model]));

  /* P0-02 回滚测试：新 Brain 初始化失败时，旧 Brain 不被 shutdown，旧配置被恢复 */
  const beforeBrain = brain;
  SpiedBrain.failNext = true;
  const failRes = await invoke('config-set-key', 'sk-will-fail-789');
  check('新 Brain 初始化失败时如实返回 ok:false', failRes.ok === false);
  check('新 Brain 初始化失败时旧 Brain 未被 shutdown', beforeBrain.shutdownRequested === false);
  check('新 Brain 初始化失败时主引用仍为旧 Brain', brain === beforeBrain);
  check('旧 Brain 仍可正常回答请求', typeof beforeBrain.ask === 'function');

  /* 回滚后再次正常换 key，验证旧 Brain 被正常 shutdown，新 Brain 接管 */
  const k3 = await invoke('config-set-key', 'sk-success-999');
  check('回滚后仍能正常换 key', k3.ok === true && k3.hasKey === true);
  check('新 Brain 初始化成功后旧 Brain 真正被 shutdown', beforeBrain.shutdownRequested === true);
  check('新 Brain 正在工作且 apiKey 正确', brain !== beforeBrain && brain.cfg.apiKey === 'sk-success-999');

  /* config-open 不该手写一份配置（加密/降级两种落盘内容由 secure 决定） */
  fs.rmSync(CFG, { force: true });
  const opened = await invoke('config-open');
  check('config-open 会把缺失的配置文件补出来',
    typeof opened === 'string' && fs.existsSync(opened), opened);
  check('补出来的文件里带着当前 model（交给唯一那个写盘口）',
    JSON.parse(readCfg()).model === 'deepseek-pro-again');

  /* ============ 7. 本地活动 + 主动搭话（v0.8 新增的两个入口） ============
     这两条通道的设计要点全在"记账时机"上：主进程只出提案，渲染端把提案
     原样带回来才算说过。所以这里必须验三件事：
       a. 渲染端上报的活动真的落到 brain 用的那个 tracker 上（不是第二个实例）；
       b. 过期/伪造的提案被拒，而且**不消耗**冷却（下一轮照问）；
       c. config-set-key 重建 brain 时 tracker 跟着搬过去（否则换装还活着、
          环境感知静默死掉 —— 同一个对象两处出处的老形状）。 */
  check('注册了 activity 上报与 proactive-check 两个通道',
    handlers.has('on:activity') && handlers.has('proactive-check'));
  const tr0 = brain.tracker;
  check('brain 注入到了 tracker（没注入时整条环境感知静默隐身）', !!tr0);
  let snapIdle = tr0.snapshot().clicks;
  await emit('activity', 'click');
  await emit('activity', 'click');
  /* 这条同时证明两件事：activity handler 写的是 brain 读的那个对象，
     且上报真的进了遥测流水 —— 分成两条断言就看不出错在哪一头。 */
  check('两次 activity 上报后，brain 那份 tracker 的待汇报戳数 +2',
    tr0.snapshot().clicks === snapIdle + 2,
    'clicks=' + tr0.snapshot().clicks + ' base=' + snapIdle);
  const evLen = tr0.events.length;
  await emit('activity', 'telepathy');
  check('乱填的活动类型不记账也不崩',
    tr0.events.length === evLen, 'len=' + tr0.events.length);

  /* 沙箱里发不到真 baseURL（config-set-key 之后 api 是新建的，上一节的桩随之失效），
     这一节只验 IPC 行为，所以把两条出口都桩成本地成功。网络层与失败回滚由
     test/brain.test.js 覆盖，重复测它只会把"卡在网络超时"变成随机红。 */
  const stubApi = (b, reply) => {
    b.api.stream = async (m, onDelta) => { onDelta(reply); return { text: reply, usage: {} }; };
    b.api.complete = async () => { throw new Error('no network in tests'); };
  };
  stubApi(brain, '谁呀？[state:curious]');

  // 没 key 时不许提案：不花钱，但会让她在"其实没法说话"时开口
  const keepKey = brain.cfg.apiKey;
  brain.cfg.apiKey = '';
  check('未就绪时 proactive-check 直接 null', (await invoke('proactive-check')) === null);
  brain.cfg.apiKey = keepKey;

  // 攒够连戳（用真上报这条路径，顺带证明上报→判定是通的）
  for (let i = 0; i < 5; i++) await emit('activity', 'click');
  const offer = await invoke('proactive-check');
  check('连戳攒够后主进程提出 poke 提案（理由里带真实下数）',
    offer && offer.kind === 'poke' && /戳了你 \d+ 下/.test(offer.reason),
    JSON.stringify(offer));
  check('提案是纯 JSON（要过 contextBridge 的结构化克隆）',
    JSON.stringify(offer) === JSON.stringify(JSON.parse(JSON.stringify(offer))));

  // 过期提案：拒，且不记账
  const stale = JSON.parse(JSON.stringify(offer));
  stale.at = Date.now() - 10 * 60 * 1000;
  const rd = await invoke('chat-send', '（自言自语）', { proactive: true, offer: stale });
  check('过期提案被拒且标 declined（不是报错也不是成功）',
    rd.ok === false && rd.declined === true && !rd.error, JSON.stringify(rd));
  const histLen = brain.memory.history.length;
  check('被拒的这一轮一个字都没进历史（连"她主动开口"的证据都不留）',
    brain.memory.history.length === histLen, 'len=' + brain.memory.history.length);
  check('前提复核：上面那句不是空转（历史此刻确实非空）',
    histLen > 0, 'len=' + histLen);
  const offer2 = await invoke('proactive-check');
  check('被拒没有白烧冷却：下一轮照样提案（这轮当没发生过）',
    offer2 && offer2.kind === 'poke', JSON.stringify(offer2));

  // 伪造 kind：渲染端被攻陷也塞不出别的触发理由
  const forged = JSON.parse(JSON.stringify(offer));
  forged.kind = 'whatever';
  check('未知 kind 的提案同样被拒',
    (await invoke('chat-send', '（自言自语）', { proactive: true, offer: forged })).declined === true);
  const badAt = JSON.parse(JSON.stringify(offer));
  badAt.at = '123';
  check('at 不是数字时拒收（NaN 会把冷却记成 0，从此永远不冷却）',
    (await invoke('chat-send', '（自言自语）', { proactive: true, offer: badAt })).declined === true);

  // 真走一趟：说出口才记账
  const preUser = brain.memory.history.filter(m => m.role === 'user').length;
  const rPro = await invoke('chat-send', '（自言自语）', { proactive: true, offer });
  check('合法提案这一轮真的说了（proactive 标记带回给渲染端）',
    rPro.ok === true && rPro.proactive === true, JSON.stringify(rPro));
  check('主动搭话以 synthetic user 进入缓存链，但不冒充用户事实',
    brain.memory.history.filter(m => m.role === 'user').length === preUser + 1
    && brain.memory.history[brain.memory.history.length - 2].synthetic === true,
    'users=' + brain.memory.history.filter(m => m.role === 'user').length);
  check('主动搭话回复与 synthetic user 一起进历史',
    brain.memory.history.length === histLen + 2
    && brain.memory.history[brain.memory.history.length - 1].role === 'assistant');
  const offer3 = await invoke('proactive-check');
  check('开口之后进入冷却（同一串不连问两次）', offer3 === null, JSON.stringify(offer3));

  // 没有 offer 的 proactive 一律当普通消息：不能让她凭空气记账
  const rn = await invoke('chat-send', '普通一句话', { proactive: true });
  check('proactive=true 但不带 offer 时按普通消息处理',
    rn.ok === true && rn.proactive === false, JSON.stringify(rn));
  check('普通消息照旧写进 user 历史',
    brain.memory.history.filter(m => m.role === 'user').length === preUser + 2);

  /* 换 key 会重建 Brain：环境感知必须跟着搬过去 */
  const before2 = brain.tracker;
  await invoke('config-set-key', 'sk-rebuild-789');
  check('重建的 brain 仍带着同一个 tracker（不静默降级成没有）',
    !!brain.tracker && brain.tracker === before2);
  check('重建的 brain 也仍带着衣柜（这条 v0.7.1 就red过，别再犯）',
    !!brain.wardrobe && brain.memory.wardrobe.includes('【当前穿着】'));
  stubApi(brain, '嗯~');
  await emit('activity', 'click');
  await emit('activity', 'click');
  check('重建后的 brain 上报照样进同一个 tracker（这条通道没断）',
    tr0.snapshot().clicks >= 2, 'clicks=' + tr0.snapshot().clicks);
  /* 冷却是主进程那份 trigger 持有的，重建 brain 不影响它 ——
     所以这里必须是 null：如果哪天有人把 trigger 也一起重建，
     这条会红，而那正好是"开口后马上又开口"那个 bug 的形状。 */
  check('开口之后仍在冷却（重建 brain 也不会绕过冷却）',
    (await invoke('proactive-check')) === null);

  /* ============ N-03: 明文降级下的 apiKey 落盘不被配置保存擦除 + writingMode 兼容淘汰 ============ */
  await invoke('config-set-key', 'sk-cre...epme');
  await invoke('config-set-key', 'sk-cre...epme');   // 第二次配置保存（真实 persistCfg 路径）
  check('N-03 明文降级（safeStorage=null）下重复保存配置后盘上 apiKey 保留',
    JSON.parse(readCfg()).apiKey === 'sk-cre...epme',
    'apiKey=' + JSON.parse(readCfg()).apiKey);
  check('N-03 旧 writingMode 字段不再写回盘（兼容淘汰）',
    JSON.parse(readCfg()).writingMode === undefined);
  const secureMod = require(path.join(ROOT, 'src/secure.js'));
  const reread = secureMod.loadConfig(() => null, DIR, () => JSON.parse(readCfg()));
  check('N-03 重启路径重新读取仍能得到原 apiKey',
    reread.cfg.apiKey === 'sk-cre...epme' && reread.encrypted === false,
    'apiKey=' + reread.cfg.apiKey);
  // 旧 life-config.json 携带 writingMode：静默忽略、不打回默认值、保存不写回
  writeCfg({ ...JSON.parse(readCfg()), writingMode: true, windowTurns: 7 });
  const legacyRead = secureMod.loadConfig(() => null, DIR, () => JSON.parse(readCfg()));
  check('N-03 旧配置 writingMode 被静默忽略且其余字段正常读取（不打回默认值）',
    legacyRead.cfg.writingMode === undefined && legacyRead.cfg.windowTurns === 7);
  await invoke('config-set-key', 'sk-cre...epme'); // 再次保存
  check('N-03 保存后 writingMode 不回写（旧字段自然淘汰）',
    JSON.parse(readCfg()).writingMode === undefined);

  /* ============ N-08: self-ledger-reset 必须显式确认 ============ */
  const birthBefore = brain.birthAt;
  const noConfirm = await invoke('self-ledger-reset');
  check('N-08 未确认的 reset 请求被拒绝',
    !!noConfirm && noConfirm.ok === false && noConfirm.error === 'REQUIRES_EXPLICIT_CONFIRMATION');
  const falseConfirm = await invoke('self-ledger-reset', { confirm: false });
  check('N-08 confirm 非 true 一律拒绝', !!falseConfirm && falseConfirm.ok === false);
  check('N-08 被拒请求不改变出生点/档案', brain.birthAt === birthBefore);
  const confirmed = await invoke('self-ledger-reset', { confirm: true });
  check('N-08 显式确认后 reset 生效',
    confirmed.ok === true && confirmed.birthAt === brain.birthAt);

  check('本层跑完没有残留临时文件',
    fs.readdirSync(DIR).filter(x => x.includes('.tmp-')).length === 0);
  fs.rmSync(DIR, { recursive: true, force: true });
  /* ============ 双窗同步（v1.0 方案二） ============ */
  const busyRes = await invoke('chat-busy', { busy: true, state: 'happy' });
  check('chat-busy 双窗广播通道受控（对话生命周期同步）',
    busyRes && busyRes.ok === true);

  /* ============ chat-history 投影白名单（v1.0 笔 2） ============ */
  const chList = await invoke('chat-history');
  // 🔴 10-07 由 7 字段扩为 8 字段：新增 bedside。
  //   **不是把白名单放宽**，而是补一个必须外露的字段 ——
  //   她睡着时你留的消息（枕边留置）在对话窗要显示成「当时她没回应」，
  //   渲染层拿不到这个标记就只能靠猜（「下一条不是 assistant ⇒ 这条没人接」），
  //   那是推断不是事实。所以 main.js 主动透出 bedside=true。
  //   白名单本身继续守着：其余字段一律不许混进来（time是t，不是别的时间戳）。
  check('chat-history 返回非空数组且投影恰为 8 字段白名单（多一字段即红）',
    Array.isArray(chList) && chList.length > 0
    && chList.every(m => Object.keys(m).sort().join(',') === 'bedside,bridge,content,messageId,role,synthetic,t,windowNo'));

  console.log('\n' + (failures ? failures + ' 项失败' : 'main 层测试全部通过'));
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
