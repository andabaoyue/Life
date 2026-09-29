/**
 * src/ipc-guard.js — IPC Sender 验证 + Navigation / New Window 限制（SEC-01）
 *
 * 所有 ipcMain handler 统一经此校验 renderer 身份：
 *   1. event.sender 必须是当前主窗口的 webContents
 *   2. event.senderFrame 必须是主 frame（child frame 一律拒绝）
 *   3. frame.url 必须是本应用自己的本地页面（file: 且位于 app 目录内）
 *   4. 不接受任意 remote URL / 其他 frame / 其他窗口
 *
 * 同时提供 navigation 守卫：非本地页面 will-navigate / will-redirect 一律
 * preventDefault，setWindowOpenHandler 默认拒绝新窗口。
 *
 * 错误消息只有 'UNTRUSTED_RENDERER' / 'UNTRUSTED_NAVIGATION'，不泄漏敏感信息。
 *
 * ipcMain / 主窗口对象均由调用方注入 —— 本模块不 require electron，可在纯 Node 测试。
 */

const path = require('path');

function isAppLocalUrl(url, appDir) {
  if (typeof url !== 'string' || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false; // 不接受任意 remote URL
  let filePath;
  try {
    filePath = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  // Windows file URL 形如 /C:/... —— 归一化后必须落在 app 目录内
  if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
  const resolved = path.resolve(filePath);
  const root = path.resolve(appDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function createIpcGuard({ ipcMain, getMainWindow, appDir }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new Error('IPC_GUARD_REQUIRES_IPC_MAIN');
  }
  const root = path.resolve(appDir || '.');

  function isTrustedRenderer(event) {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    const contents = win.webContents;
    if (!event || !event.sender || event.sender !== contents) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame) return false; // child frame 一律拒绝
    return isAppLocalUrl(frame.url, root);
  }

  function assertTrustedRenderer(event) {
    if (!isTrustedRenderer(event)) {
      const err = new Error('UNTRUSTED_RENDERER');
      err.code = 'UNTRUSTED_RENDERER';
      throw err;
    }
    return true;
  }

  /** ipcMain.handle 包装：校验失败则 handler 以 UNTRUSTED_RENDERER reject */
  function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedRenderer(event);
      return fn(event, ...args);
    });
  }

  /** ipcMain.on 包装：校验失败静默丢弃（单向消息无返回通道） */
  function on(channel, fn) {
    ipcMain.on(channel, (event, ...args) => {
      try {
        assertTrustedRenderer(event);
      } catch {
        return;
      }
      fn(event, ...args);
    });
  }

  /** Navigation / New Window 守卫：挂到主窗口 webContents */
  function attachNavigationGuard(contents) {
    if (!contents || typeof contents.on !== 'function') return false;
    const restrict = (e, url) => {
      if (!isAppLocalUrl(url, root)) {
        e.preventDefault(); // 非本地页面一律阻止
      }
    };
    contents.on('will-navigate', restrict);
    contents.on('will-redirect', restrict);
    if (typeof contents.setWindowOpenHandler === 'function') {
      contents.setWindowOpenHandler(() => ({ action: 'deny' })); // 默认拒绝新窗口
    }
    return true;
  }

  return { assertTrustedRenderer, isTrustedRenderer, handle, on, attachNavigationGuard };
}

module.exports = { createIpcGuard, isAppLocalUrl };
