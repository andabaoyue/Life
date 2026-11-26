const fs = require('fs');
const path = require('path');
const { isChannelAllowedForPicker } = require('./ipc-guard');

const VISION_ONLY_CHANNELS = new Set([
  'vision:capture',
  'vision:stage',
  'vision:close-picker',
  'vision-notify'
]);

let _pickerWindowProvider = null;

/**
 * 在主进程启动装配期注入框选窗读取器，避免每次 IPC 校验动态 require('./vision-picker-window')。
 */
function bindPickerWindowProvider(fn) {
  _pickerWindowProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 框选窗通道级收窄（fail-closed）：异常返回 false，仅放行四条视觉通道。
 */
function assertChannelAllowedForPicker(event, channel) {
  if (typeof _pickerWindowProvider !== 'function') return true;
  let pw = null;
  try {
    pw = _pickerWindowProvider();
  } catch (e) { return false; }
  const pickerContents = pw && !pw.isDestroyed() ? pw.webContents : null;
  return isChannelAllowedForPicker(event, channel, pickerContents, VISION_ONLY_CHANNELS);
}

/** 视觉审计（只记元数据；绝不记像素与 OCR 文本） */
function appendVisionAudit(app, entry) {
  try {
    const dir = app.getPath('userData');
    const line = {
      at: entry.at || new Date().toISOString(),
      stage: typeof entry.stage === 'string' ? entry.stage.slice(0, 32) : null,
      width: Number.isFinite(entry.width) ? entry.width : null,
      height: Number.isFinite(entry.height) ? entry.height : null,
      elapsedMs: Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : null,
      visionTokens: Number.isFinite(entry.visionTokens) ? entry.visionTokens : null,
      errorType: typeof entry.errorType === 'string' ? entry.errorType.slice(0, 40) : null
    };
    fs.appendFileSync(path.join(dir, 'vision-audit.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  } catch (err) { /* 审计写失败绝不外抛 */ }
}

/**
 * 屏幕框选视觉探针 IPC 注册器。
 * 全部通道经注入的 ipcGuard 注册，不直接调 ipcMain。
 */
function registerVisionIpc(ipcGuard, ctx) {
  const { app, screen, desktopCapturer, getCfg, getBrain, broadcastToWindows } = ctx;

  ipcGuard.handle('vision:capability', () => {
    try {
      const cfg = getCfg();
      const model = (cfg && cfg.model) || '';
      const { modelSupportsVision } = require('./vision');
      return { ok: true, model, supported: modelSupportsVision(model) };
    } catch (e) {
      return { ok: false, supported: false, error: 'CAPABILITY_CHECK_FAILED' };
    }
  });

  ipcGuard.handle('vision:capture', async (e, opts = {}) => {
    const started = Date.now();

    const fail = (errorType) => {
      appendVisionAudit(app, {
        at: new Date().toISOString(),
        stage: 'failed',
        elapsedMs: Date.now() - started,
        errorType
      });
      return { ok: false, errorType };
    };

    const visionMod = require('./vision');
    const visionPicker = require('./vision-picker-window');
    const pw = typeof visionPicker.getPickerWindow === 'function' ? visionPicker.getPickerWindow() : null;
    if (!pw || (typeof pw.isDestroyed === 'function' && pw.isDestroyed()) || !e || e.sender !== pw.webContents) {
      return fail('picker_not_active');
    }
    const rawOpts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    const displayId = (rawOpts.displayId !== undefined && rawOpts.displayId !== null)
      ? rawOpts.displayId
      : (typeof visionPicker.getPickerDisplayId === 'function' ? visionPicker.getPickerDisplayId() : null);
    const allDisplays = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [];
    const display = visionMod.resolveCaptureDisplay(allDisplays, screen.getPrimaryDisplay(), displayId);
    if (!display || !display.size) return fail('no_screen_source');
    const rect = visionMod.normalizeRect(rawOpts.rect, {
      maxW: display.size.width,
      maxH: display.size.height
    });
    if (!rect) return fail('bad_rect');

    let dataUrl = null;
    let outW = rect.width;
    let outH = rect.height;
    try {
      const capturer = desktopCapturer || require('electron').desktopCapturer;
      const sources = await capturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height }
      });
      if (!sources || !sources.length) return fail('no_screen_source');

      const target = visionMod.pickCaptureSource(sources, display);
      if (!target) return fail('display_mismatch');
      const full = target.thumbnail;
      if (!full || (typeof full.isEmpty === 'function' && full.isEmpty())) {
        return fail('capture_failed');
      }

      const fullSize = full.getSize();
      const sx = fullSize.width / display.size.width;
      const sy = fullSize.height / display.size.height;
      const rawX = Math.max(0, Math.round(rect.x * sx));
      const rawY = Math.max(0, Math.round(rect.y * sy));
      const clampedX = fullSize.width > 0 ? Math.min(rawX, fullSize.width - 1) : 0;
      const clampedY = fullSize.height > 0 ? Math.min(rawY, fullSize.height - 1) : 0;
      const cropRect = {
        x: clampedX,
        y: clampedY,
        width: Math.max(1, Math.min(Math.round(rect.width * sx), Math.max(1, fullSize.width - clampedX))),
        height: Math.max(1, Math.min(Math.round(rect.height * sy), Math.max(1, fullSize.height - clampedY)))
      };

      const cropped = full.crop(cropRect);
      const croppedSize = cropped.getSize();

      const fitted = visionMod.fitCaptureSize(croppedSize.width, croppedSize.height);
      const finalImg = fitted.scaled
        ? cropped.resize({ width: fitted.width, height: fitted.height, quality: 'good' })
        : cropped;
      outW = fitted.width;
      outH = fitted.height;

      const png = finalImg.toPNG();
      dataUrl = 'data:image/png;base64,' + png.toString('base64');
    } catch (err) {
      return fail('capture_threw');
    }

    try {
      appendVisionAudit(app, {
        at: new Date().toISOString(),
        stage: 'captured',
        width: outW,
        height: outH,
        elapsedMs: Date.now() - started
      });
    } catch (err) { /* 审计失败不影响主流程 */ }

    return { ok: true, dataUrl, width: outW, height: outH, elapsedMs: Date.now() - started };
  });

  ipcGuard.handle('vision:open-picker', () => {
    try {
      const mod = require('./vision-picker-window');
      const r = mod.openVisionPicker({ ipcGuard });
      return { ok: true, reused: !!r.reused };
    } catch (err) {
      return { ok: false, errorType: 'picker_open_failed' };
    }
  });

  ipcGuard.handle('vision:close-picker', () => {
    try {
      require('./vision-picker-window').closeVisionPicker();
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  });

  ipcGuard.on('vision-notify', (e, payload = {}) => {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    broadcastToWindows('vision-notify', {
      ok: p.ok === true,
      errorType: typeof p.errorType === 'string' ? p.errorType.slice(0, 40) : null
    });
  });

  ipcGuard.handle('vision:stage', (e, opts = {}) => {
    const safeOpts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    const brain = getBrain();
    if (!brain) return { ok: false, errorType: 'no_brain' };
    const visionMod = require('./vision');
    if (typeof safeOpts.dataUrl !== 'string' || !visionMod.validateStageDataUrl(safeOpts.dataUrl)) {
      const overSize = typeof safeOpts.dataUrl === 'string' && safeOpts.dataUrl.length > visionMod.MAX_STAGE_DATA_URL_CHARS;
      return { ok: false, errorType: overSize ? 'payload_too_large' : 'bad_image' };
    }
    const MAX_STAGE_DIM = 16384;
    if (!Number.isInteger(safeOpts.width) || safeOpts.width <= 0 || safeOpts.width > MAX_STAGE_DIM
        || !Number.isInteger(safeOpts.height) || safeOpts.height <= 0 || safeOpts.height > MAX_STAGE_DIM) {
      return { ok: false, errorType: 'bad_dimensions' };
    }
    const ok = brain.stageVisionPick({
      dataUrl: safeOpts.dataUrl,
      width: safeOpts.width,
      height: safeOpts.height
    });
    return ok ? { ok: true } : { ok: false, errorType: 'stage_failed' };
  });

  ipcGuard.handle('vision:pending', () => {
    const brain = getBrain();
    if (!brain) return { ok: false, pending: false };
    return { ok: true, pending: brain.hasVisionPick() };
  });

  ipcGuard.handle('vision:peek', () => {
    const brain = getBrain();
    if (!brain) return { ok: false, pending: false };
    const pick = typeof brain.peekVisionPick === 'function' ? brain.peekVisionPick() : null;
    if (!pick || !pick.dataUrl) return { ok: true, pending: false };
    return {
      ok: true,
      pending: true,
      dataUrl: pick.dataUrl,
      width: pick.width,
      height: pick.height
    };
  });

  ipcGuard.handle('vision:drop', () => {
    const brain = getBrain();
    if (!brain) return { ok: false };
    brain.takeVisionPick();
    return { ok: true };
  });
}

module.exports = {
  VISION_ONLY_CHANNELS,
  bindPickerWindowProvider,
  assertChannelAllowedForPicker,
  appendVisionAudit,
  registerVisionIpc
};
