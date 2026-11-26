const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');

const PANEL_W = 440;
const PANEL_H = 680;
const CHAT_WIN_W = 380;
const CHAT_WIN_H = 520;

/**
 * 窗口位置、拖拽、置顶、对话独立窗与主窗尺寸视口 IPC 管理器。
 * 所有 IPC 统一经由调用方注入的 ipcGuard 注册，不直接接触 ipcMain。
 */
function createWindowManager(ctx) {
  const { app, BrowserWindow, screen, layout, ipcGuard, motionUi, getWin, getBrain, getMotion, isAppQuitting, syncMotionBlock, reconfigureMotion } = ctx;

  let dragging = false;
  let intendedSize = { w: layout.BASE_W, h: layout.BASE_H };
  let chatWin = null;
  let chatWinBounds = null;
  let _chatBoundsSaveTimer = null;

  function togglePinState() {
    const win = getWin();
    if (!win || win.isDestroyed()) return false;
    const on = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(on, 'screen-saver');
    return on;
  }

  function setSafeWindowSize(targetWin, w, h) {
    if (!targetWin || targetWin.isDestroyed()) return;
    if (typeof targetWin.setResizable === 'function') targetWin.setResizable(true);
    targetWin.setSize(w, h);
    if (typeof targetWin.setResizable === 'function') targetWin.setResizable(false);
    intendedSize = { w, h };
  }

  function setPinnedBounds(x, y) {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: intendedSize.w, height: intendedSize.h });
  }

  function getWorkArea(x, y) {
    try {
      const display = (typeof screen.getDisplayNearestPoint === 'function')
        ? screen.getDisplayNearestPoint({ x, y })
        : screen.getPrimaryDisplay();
      return display.workArea || { x: 0, y: 0, ...display.workAreaSize };
    } catch {
      return { x: 0, y: 0, width: 1920, height: 1080 };
    }
  }

  function loadChatBounds() {
    try {
      const raw = fs.readFileSync(path.join(app.getPath('userData'), 'chat-window.json'), 'utf8');
      const b = JSON.parse(raw);
      if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
    } catch (e) { /* 无记忆 → 默认 */ }
    return null;
  }

  function saveChatBoundsImmediate() {
    if (_chatBoundsSaveTimer) {
      clearTimeout(_chatBoundsSaveTimer);
      _chatBoundsSaveTimer = null;
    }
    try {
      if (chatWin && !chatWin.isDestroyed()) {
        chatWinBounds = chatWin.getBounds();
        writeJsonAtomic(path.join(app.getPath('userData'), 'chat-window.json'), chatWinBounds);
      }
    } catch (e) { /* 记忆失败不致命 */ }
  }

  function saveChatBounds() {
    try {
      if (chatWin && !chatWin.isDestroyed()) {
        chatWinBounds = chatWin.getBounds();
      }
    } catch {}
    if (_chatBoundsSaveTimer) clearTimeout(_chatBoundsSaveTimer);
    _chatBoundsSaveTimer = setTimeout(() => {
      _chatBoundsSaveTimer = null;
      saveChatBoundsImmediate();
    }, 250);
  }

  function chatBirthPosition() {
    const win = getWin();
    const cw = (chatWinBounds && chatWinBounds.width) || CHAT_WIN_W;
    const ch = (chatWinBounds && chatWinBounds.height) || CHAT_WIN_H;
    if (!win || win.isDestroyed()) {
      const area = getWorkArea(0, 0);
      return { x: Math.round(area.x + 8), y: Math.round(area.y + 8), width: cw, height: ch };
    }
    const [px, py] = win.getPosition();
    const [pw, ph] = win.getSize();
    const area = getWorkArea(px, py);
    let x = px + pw + 20;
    if (x + cw > area.x + area.width - 8) x = px - cw - 20;
    let y = py + Math.max(0, Math.round((ph - ch) / 2));
    x = Math.max(area.x + 8, Math.min(x, area.x + area.width - cw - 8));
    y = Math.max(area.y + 8, Math.min(y, area.y + area.height - ch - 8));
    return { x: Math.round(x), y: Math.round(y), width: cw, height: ch };
  }

  function broadcastToWindows(channel, payload) {
    for (const w of [getWin(), chatWin]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  function createChatWindow() {
    if (chatWin && !chatWin.isDestroyed()) return chatWin;
    chatWinBounds = loadChatBounds();
    const b = chatBirthPosition();
    chatWin = new BrowserWindow({
      title: '对话',
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, transparent: false, backgroundColor: '#10121b',
      alwaysOnTop: true, show: false,
      webPreferences: {
        preload: path.join(ctx.appDir, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
      }
    });
    chatWin.loadFile('chat.html');
    ipcGuard.attachNavigationGuard(chatWin.webContents);
    chatWin.on('move', saveChatBounds);
    chatWin.on('resize', saveChatBounds);
    chatWin.on('close', (e) => {
      saveChatBoundsImmediate();
      if (!isAppQuitting()) {
        e.preventDefault();
        chatWin.hide();
        broadcastToWindows('chat-window-hidden', {});
        syncMotionBlock('chat-hide');
      }
    });
    chatWin.on('show', () => syncMotionBlock('chat-open'));
    chatWin.on('hide', () => syncMotionBlock('chat-hide'));
    chatWin.on('closed', () => {
      if (_chatBoundsSaveTimer) {
        clearTimeout(_chatBoundsSaveTimer);
        _chatBoundsSaveTimer = null;
      }
      chatWin = null;
      syncMotionBlock('chat-closed');
    });
    return chatWin;
  }

  function showChatWindow() {
    const w = createChatWindow();
    if (!w.isVisible()) w.show();
    w.focus();
  }

  function toggleChatWindow() {
    const w = createChatWindow();
    if (w.isVisible()) {
      w.hide();
      broadcastToWindows('chat-window-hidden', {});
      return { ok: true, visible: false };
    }
    w.show();
    w.focus();
    return { ok: true, visible: true };
  }

  function registerMainWindowIpc() {
    const safeObj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    ipcGuard.on('drag-start', () => { dragging = true; syncMotionBlock('drag'); });
    ipcGuard.on('drag-end', () => { dragging = false; syncMotionBlock('drag-end'); });
    ipcGuard.on('drag-move', (e, payload) => {
      const p = safeObj(payload);
      if (!Number.isFinite(p.dx) || !Number.isFinite(p.dy)) return;
      const win = getWin();
      if (!dragging || !win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const tx = Math.round(x + p.dx), ty = Math.round(y + p.dy);
      setPinnedBounds(tx, ty);
      reconfigureMotion();
    });

    ipcGuard.on('motion-ui-state', (e, state = {}) => {
      const safeState = safeObj(state);
      for (const k of Object.keys(motionUi)) {
        if (typeof safeState[k] === 'boolean') motionUi[k] = safeState[k];
      }
      syncMotionBlock('ui-state');
    });

    ipcGuard.handle('motion-status', () => {
      const m = getMotion();
      return m ? m.snapshot() : null;
    });

    ipcGuard.on('set-ignore-mouse-events', (e, ignore) => {
      const win = getWin();
      if (win && !win.isDestroyed() && typeof win.setIgnoreMouseEvents === 'function') {
        win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
      }
    });

    ipcGuard.handle('toggle-pin', () => togglePinState());

    ipcGuard.handle('pin-state', () => {
      const win = getWin();
      return { ok: true, pinned: !!(win && !win.isDestroyed() && win.isAlwaysOnTop()) };
    });

    ipcGuard.on('resize-pet', (e, factor) => {
      const win = getWin();
      if (!win || win.isDestroyed()) return;
      const [w, h] = win.getSize();
      const next = layout.nextSize(w, Number(factor) || 1);
      if (next.w === w && next.h === h) return;
      const [x, y] = win.getPosition();
      let targetY = layout.anchorBottom(y, h, next.h);
      const area = getWorkArea(x, y);
      if (targetY < area.y) targetY = area.y;
      win.setPosition(x, targetY);
      setSafeWindowSize(win, next.w, next.h);
      reconfigureMotion();
      syncMotionBlock('resize');
    });

    ipcGuard.handle('chat-window-open', () => {
      const w = createChatWindow();
      if (!w.isVisible()) w.show();
      w.focus();
      return { ok: true };
    });

    ipcGuard.handle('chat-window-toggle', () => toggleChatWindow());

    ipcGuard.handle('chat-busy', (e, p = {}) => {
      const safeP = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
      broadcastToWindows('chat-busy', { busy: !!safeP.busy, state: safeP.state || null });
      return { ok: true };
    });

    ipcGuard.handle('chat-window-home', () => {
      if (chatWin && !chatWin.isDestroyed()) chatWin.setBounds(chatBirthPosition());
      return { ok: true };
    });

    ipcGuard.handle('chat-window-close', () => {
      if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) chatWin.hide();
      broadcastToWindows('chat-window-hidden', {});
      return { ok: true };
    });

    ipcGuard.handle('panel-viewport', (e, open, opt = {}) => {
      const safeOpt = (opt && typeof opt === 'object' && !Array.isArray(opt)) ? opt : {};
      const win = getWin();
      if (typeof open !== 'boolean') return { ok: false, error: 'INVALID_OPEN' };
      if (!win || win.isDestroyed()) return { ok: false, error: 'NO_WINDOW' };
      const tw = Math.min(640, Math.max(layout.BASE_W, Math.round(safeOpt.w) || PANEL_W));
      const th = Math.min(760, Math.max(400, Math.round(safeOpt.h) || PANEL_H));
      const target = open ? { w: tw, h: th } : { w: layout.BASE_W, h: layout.BASE_H };
      const [w, h] = win.getSize();
      if (w === target.w && h === target.h) return { ok: true, w, h, changed: false };
      const [x, y] = win.getPosition();
      let targetY = layout.anchorBottom(y, h, target.h);
      const area = getWorkArea(x, y);
      if (targetY < area.y) targetY = area.y;
      let targetX = x;
      if (targetX + target.w > area.x + area.width - 8) targetX = area.x + area.width - target.w - 8;
      if (targetX < area.x + 8) targetX = area.x + 8;
      win.setPosition(targetX, targetY);
      setSafeWindowSize(win, target.w, target.h);
      reconfigureMotion();
      syncMotionBlock('resize');
      return { ok: true, w: target.w, h: target.h, changed: true };
    });

    ipcGuard.on('quit-app', () => {
      const brain = getBrain();
      if (brain && typeof brain.flushAll === 'function') brain.flushAll();
      app.quit();
    });

    ipcGuard.handle('window-position', () => {
      const win = getWin();
      if (!win || win.isDestroyed()) return { x: 0, y: 0 };
      const pos = win.getPosition ? win.getPosition() : [0, 0];
      return { x: pos[0] || 0, y: pos[1] || 0 };
    });
  }

  return {
    registerMainWindowIpc,
    togglePinState,
    setSafeWindowSize,
    setPinnedBounds,
    getWorkArea,
    loadChatBounds,
    saveChatBoundsImmediate,
    saveChatBounds,
    chatBirthPosition,
    createChatWindow,
    showChatWindow,
    toggleChatWindow,
    broadcastToWindows,
    isDragging: () => dragging,
    getChatWin: () => chatWin,
    isChatVisible: () => !!(chatWin && !chatWin.isDestroyed() && chatWin.isVisible()),
  };
}

module.exports = { createWindowManager };
