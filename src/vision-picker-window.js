/**
 * v1.8-b 框选改造（重做版，2026-10-20）
 *
 * ## 为什么推翻第一版
 *   第一版把遮罩画在**主窗**里（main.js 的 win，尺寸 256×320）。
 *   用户实测：「点了一下直接出了一个小方块，然后不可操作」。
 *
 *   两个硬伤：
 *     1. **遮罩只有 256×320** —— 主窗就那么大，`inset:0` 只能覆盖窗口，
 *        根本框不到屏幕上的其他区域。"看屏幕"名不副实；
 *     2. **鼠标穿透把它废了** —— pet.js 的 updateMouseIgnore 只把
 *        `#pet / #menu / #bubble / .panel / #chatStream` 视为可交互，
 *        遮罩不在白名单里 ⇒ setIgnoreMouseEvents(true) ⇒ 拖拽事件压根收不到。
 *
 *   结论：**框选必须在一个真正的全屏窗口里做**，不能寄生在主窗。
 *
 * ## 新架构
 *   点菜单 → 主进程开一个全屏透明置顶窗 → 它加载 vision-picker.html
 *   → 用户拖框 → 该窗自己调 vision:capture（传屏幕坐标，无需换算）
 *   → 完成后该窗自关，图暂存到 brain。
 *
 *   全屏窗的好处：
 *     - 坐标就是屏幕坐标，**不需要算窗口偏移**（第一版的错位隐患消失）；
 *     - 不受主窗的鼠标穿透逻辑影响；
 *     - 关闭即销毁，零常驻开销。
 */

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

/** 当前框选窗（同一时刻只允许一个） */
let pickerWin = null;

/**
 * 已隐藏、可复用的框选窗实例。
 *
 * 🔴 为什么不 destroy：见 closeVisionPicker 的注释 —— 实测 destroy 会把进程卡死。
 *   代价是一个隐藏窗口常驻内存（几十 MB），换来"用户永远不会被遮罩困住"。
 */
let hiddenPicker = null;

/**
 * 打开框选窗。
 * @param {object} deps { ipcGuard, onPicked } 由 main.js 注入
 */
function openVisionPicker(deps = {}) {
  // 已经开着 → 聚焦
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.focus();
    return { ok: true, reused: true };
  }

  /* 🔴 复用已隐藏的实例（不新建）。
   *
   *   为什么复用而不是每次 new BrowserWindow：
   *     ① 避免反复创建/销毁窗口的开销与泄漏；
   *     ② destroy 实测会卡死进程（见 closeVisionPicker 注释），所以根本不用它。
   *   复用时必须 reload：上次的选框 DOM 状态要清干净，否则会看到上次残留的框。
   */
  if (hiddenPicker && !hiddenPicker.isDestroyed()) {
    pickerWin = hiddenPicker;
    hiddenPicker = null;
    // 重新定位到当前光标所在显示器（用户可能换了屏）
    try {
      const d2 = screen.getCursorScreenPoint
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : screen.getPrimaryDisplay();
      pickerWin.setBounds({ x: d2.bounds.x, y: d2.bounds.y, width: d2.bounds.width, height: d2.bounds.height });
    } catch (e) { /* 尺寸设置失败不影响可用性 */ }
    pickerWin.show();
    try { pickerWin.reload(); } catch (e) { /* reload 失败也还能用旧页面 */ }
    pickerWin.focus();
    return { ok: true, reused: true };
  }

  const display = screen.getCursorScreenPoint
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getPrimaryDisplay();
  const bounds = display.bounds;

  pickerWin = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // 🔴 全屏框选窗不抢焦点的话，键盘 ESC 收不到；
    //   抢了焦点又会让用户觉得"桌面被占了" —— 折中：show 但 focusable=true，
    //   取消由 ESC 或点击右键完成。
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'vision-picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 整窗置顶（覆盖任务栏之上）
  try { pickerWin.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { /* 老版本不支持 level */ }
  try { pickerWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}

  pickerWin.loadFile(path.join(__dirname, '..', 'vision-picker.html'));
  if (deps.ipcGuard && typeof deps.ipcGuard.attachNavigationGuard === 'function') {
    deps.ipcGuard.attachNavigationGuard(pickerWin.webContents);
  }

  /* 🔴 2026-10-21 兜底（这一天踩过的坑）：
   *
   *   第一版把「取消」完全交给渲染层的 IPC（vision:close-picker）。
   *   但框选窗当时**不在 IPC 信任白名单里**，于是 close-picker 被拒，
   *   用户实测「ESC 按不了、框一直留着、进程无法结束」——**整个屏幕被占死**。
   *
   *   教训：**关闭一个全屏遮罩窗的能力，绝不能依赖它自己页面的 IPC**。
   *   只要 IPC、渲染进程、或页面脚本任一环节出问题，用户就被困住。
   *
   *   所以在**主进程侧**直接挂键盘钩子：
   *     · ESC → 立即关窗（不经过渲染层，不需要 IPC，不加任何校验）
   *     · 这是最后一道逃生门，永远有效。
   */
  pickerWin.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      closeVisionPicker();
    }
  });

  // 失焦**不**自动关：实测风险太大 —— 用户开始拖框的瞬间，某些窗口管理器
  // 会短暂触发 blur，那会在拖到一半时把遮罩关掉，比不关更让人抓狂。
  // 关闭能力全部由上面那条主进程 ESC 钩子 + 渲染层完成/取消两条路径负责。

  // 内部 close 复用同一个安全实现（绝不直接 destroy，见下方 closeVisionPicker 的注释）
  const close = () => closeVisionPicker();

  pickerWin.on('closed', () => { pickerWin = null; });

  return { ok: true, reused: false, close };
}

/**
 * 关闭框选窗（外部调用：ESC / 完成 / 取消 / 异常兜底）。
 *
 * ## 🔴 2026-10-21 两次踩坑，最终方案：**只隐藏，不销毁**
 *
 * ### 坑 1：IPC 不通
 *   框选窗原先不在 `getTrustedWebContents` 里，它发的每个 IPC 都被判
 *   UNTRUSTED_RENDERER ⇒ 拖框不提交、ESC 关不掉。已修（见 main.js）。
 *
 * ### 坑 2：destroy() 把进程卡死
 *   修完 IPC 后仍然卡：`w.destroy()` 会在渲染进程正派发事件时
 *   **双向等待**，实测进程直接失去响应，日志停在 destroy 前后。
 *   试过 `setImmediate` 和 `setTimeout(0)` 延后销毁 —— **都还是卡**。
 *
 * ### 定案
 *   1. **`hide()` + 清状态**，立刻让用户脱困（实测 9ms 返回，同步不阻塞）；
 *   2. **不销毁窗口**，留着复用 —— 下次点「看看这个」直接 show 并重载页面。
 *
 *   代价：一个隐藏的 BrowserWindow 常驻内存（约几十 MB）。
 *   **这个代价可以接受** —— 用户的屏幕被占死是更严重的问题。
 *   将来若要回收，应在 `before-quit` 时统一销毁，而不是在交互路径上 destruct。
 */
function closeVisionPicker() {
  const w = pickerWin;
  if (!w || w.isDestroyed()) { pickerWin = null; return; }

  // 先让遮罩消失（同步、不阻塞）—— 用户立刻脱困
  try { w.hide(); } catch (e) { /* 已隐藏也无妨 */ }

  // 状态复位：让 isVisionPickerOpen() 立刻返回 false
  pickerWin = null;

  // 保留窗口实例供复用（不 destroy —— 见上面坑 2）
  try { hiddenPicker = w; } catch (e) { /* 忽略 */ }
}

/** 当前是否开着 */
function isVisionPickerOpen() {
  return !!(pickerWin && !pickerWin.isDestroyed());
}

/**
 * 取当前框选窗实例（供 IPC 信任白名单使用）。
 *
 * 🔴 为什么必须暴露：`getTrustedWebContents` 要把框选窗的 webContents
 *   算进受信集合，否则它在窗内发起的每个 IPC 都会被判 UNTRUSTED_RENDERER ——
 *   实测后果是「拖框后不提交、ESC 关不掉、进程无法结束」。
 *
 * @returns {BrowserWindow|null}
 */
function getPickerWindow() {
  return (pickerWin && !pickerWin.isDestroyed()) ? pickerWin : null;
}

module.exports = { openVisionPicker, closeVisionPicker, isVisionPickerOpen, getPickerWindow };
