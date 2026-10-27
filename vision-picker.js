/**
 * vision-picker.js — 全屏框选页的交互（v1.8-b 重做版）
 *
 * ## 与前版的区别
 *   前版寄生在主窗（256×320），只能框到窗口内，且被鼠标穿透废掉。
 *   本页运行在**独立的全屏透明窗**里：
 *     - 坐标就是屏幕坐标，**不需要算窗口偏移**；
 *     - 不受主窗 setIgnoreMouseEvents 影响。
 *
 * ## 隐私口径
 *   本页**不主动截图**。只有用户拖出一个 ≥16×16 的矩形后才调一次 capture。
 *   一次框选 = 一次截图，没有定时器、没有自动重截。
 */
(function () {
  const api = window.deskpet || null;
  const box = document.getElementById('selBox');
  const sizeTip = document.getElementById('sizeTip');
  const hint = document.getElementById('hint');

  const MIN_SIDE = 16;   // 与主进程 MIN_RECT_SIDE 同口径

  let startX = 0, startY = 0, drawing = false;

  function showBox(x, y, w, h) {
    box.style.display = 'block';
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  }

  /**
   * 收尾：关掉本窗。
   *
   * 🔴 2026-10-21 教训：第一版**只**走主进程 IPC（vision:close-picker），
   *   而框选窗当时不在信任白名单 ⇒ 调用被拒 ⇒ 用户被全屏遮罩困住，
   *   ESC 也关不掉，只能强杀进程。
   *
   *   现在三层兜底（任意一层生效即可脱困）：
   *     ① 主进程的 before-input-event ESC 钩子（最硬，不依赖渲染层）
   *     ② 这里的 closePicker IPC
   *     ③ window.close() —— 即使 IPC 全挂，浏览器原生关闭仍有效
   */
  function finish() {
    let viaIpc = false;
    try {
      if (api && api.vision && typeof api.vision.closePicker === 'function') {
        api.vision.closePicker();
        viaIpc = true;
      }
    } catch (e) { viaIpc = false; }

    // 无论 IPC 是否成功，都再补一次原生关闭：
    // 主进程 destroy 后本行是空操作；若 IPC 失败，它就是唯一的逃生门。
    if (!viaIpc) {
      try { window.close(); } catch (e) { /* 最后手段，失败也不再抛 */ }
    }
  }

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drawing = true;
    startX = e.clientX;
    startY = e.clientY;
    hint.style.display = 'none';
    showBox(startX, startY, 0, 0);
  });

  document.addEventListener('mousemove', (e) => {
    if (!drawing) return;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    showBox(x, y, w, h);

    sizeTip.style.display = 'block';
    sizeTip.textContent = w + ' × ' + h;
  });

  document.addEventListener('mouseup', async (e) => {
    if (!drawing || e.button !== 0) return;
    drawing = false;

    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    if (w < MIN_SIDE || h < MIN_SIDE) {
      // 太小 = 误触：直接关掉，不截图（与主进程同口径，省一次调用）
      finish();
      return;
    }

    // 🔴 本窗就是全屏，clientX/Y 即屏幕坐标 —— 不需要加窗口偏移
    const res = api && api.vision
      ? await api.vision.capture({ rect: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) } })
      : null;

    if (res && res.ok) {
      const staged = await api.vision.stage({
        dataUrl: res.dataUrl, width: res.width, height: res.height
      });
      // 🔴 成功也要回执：否则主窗不知道"图已经存好了"，用户看不出有没有生效
      if (api && typeof api.visionNotify === 'function') {
        api.visionNotify({
          ok: !!(staged && staged.ok),
          errorType: staged && staged.ok ? null : 'stage_failed'
        });
      }
    } else {
      // 失败也要让用户知道，但只一行客观事实，不弹窗
      if (api && typeof api.visionNotify === 'function') {
        api.visionNotify({ ok: false, errorType: (res && res.errorType) || 'capture_failed' });
      }
    }

    finish();
  });

  // ESC / 右键 = 取消（不截图）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish();
  });
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    finish();
  });
})();
