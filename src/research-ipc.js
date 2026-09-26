/**
 * src/research-ipc.js
 * 
 * 初澜数字生命实验：Research IPC 只读主进程通道白名单 (v0.9.5 / §24)
 * 
 * 核心安全边界：
 * 1. 严格只读！只挂载查询、复盘任务与导出通道。
 * 2. 严禁暴露任何写通道（set-state / update-event / delete-evidence / edit-archive 等）。
 * 3. 渲染进程绝无对底层实验数据库的直接修改能力。
 */

const path = require('path');

function registerResearchIpc(ipcMain, researchService, options = {}) {
  if (!ipcMain || !researchService) return;
  const dialog = options.dialog || null;

  // 1. 主体状态查询
  ipcMain.handle('research:get-state', () => {
    return researchService.query.getSubjectState();
  });

  // 2. Window 概况与详情查询
  ipcMain.handle('research:get-windows', (e, opts) => {
    return researchService.query.getWindows(opts || {});
  });

  ipcMain.handle('research:get-window', (e, opts) => {
    let wNo = null;
    if (typeof opts === 'number') {
      wNo = opts;
    } else if (opts && opts.windowNo !== undefined) {
      wNo = opts.windowNo;
    } else if (opts === null) {
      wNo = null;
    } else {
      wNo = (opts && opts.windowNo) ?? 1;
    }
    return researchService.query.getWindowDetail(wNo);
  });

  ipcMain.handle('research:get-window-rounds', (e, opts) => {
    const wNo = (opts && opts.windowNo) || 1;
    const segIdx = (opts && opts.segmentIndex) !== undefined ? opts.segmentIndex : null;
    return researchService.query.getWindowRounds(wNo, segIdx);
  });

  // 3. 事实三层 EOI 查询
  ipcMain.handle('research:get-events', (e, opts) => {
    return researchService.query.getEvents(opts || {});
  });

  ipcMain.handle('research:get-observations', (e, opts) => {
    return researchService.query.getObservations(opts || {});
  });

  ipcMain.handle('research:get-interpretations', (e, opts) => {
    return researchService.query.getInterpretations(opts || {});
  });

  // 4. Evidence 与因果查询
  ipcMain.handle('research:get-evidence', (e, opts) => {
    return researchService.query.getEvidence(opts || {});
  });

  // 5. StateChanges 查询
  ipcMain.handle('research:get-state-changes', (e, opts) => {
    return researchService.query.getStateChanges(opts || {});
  });

  // 6. Provenance 溯源反查
  ipcMain.handle('research:get-provenance', (e, opts) => {
    const scId = typeof opts === 'string' ? opts : (opts && opts.stateChangeId);
    return researchService.query.traceProvenance(scId);
  });

  // 7. EOI 追溯
  ipcMain.handle('research:get-eoi', (e, opts) => {
    const id = typeof opts === 'string' ? opts : (opts && opts.id);
    return researchService.query.traceEOI(id);
  });

  // 8. 关键词综合搜索
  ipcMain.handle('research:search', (e, opts) => {
    return researchService.query.search(opts || {});
  });

  // 9. 异步 Replay 实验室任务控制
  ipcMain.handle('research:replay:start', (e, opts) => {
    return researchService.startReplayTask(opts || {});
  });

  ipcMain.handle('research:replay:status', (e, opts) => {
    const taskId = typeof opts === 'string' ? opts : (opts && opts.taskId);
    return researchService.getReplayTaskStatus(taskId);
  });

  ipcMain.handle('research:replay:cancel', (e, opts) => {
    const taskId = typeof opts === 'string' ? opts : (opts && opts.taskId);
    return { ok: researchService.cancelReplayTask(taskId) };
  });

  // 10. 轨迹与数据包导出 (H-03 安全防护)
  ipcMain.handle('research:export', async (e, opts = {}) => {
    const rawOpts = opts || {};
    // 安全防护 (H-03): 严格禁止渲染进程直接传入任意目标路径，防止任意目录写入
    if (rawOpts.targetDir !== undefined || rawOpts.targetPath !== undefined || rawOpts.destPath !== undefined || rawOpts.destination !== undefined) {
      return { ok: false, error: 'RENDERER_TARGET_DIR_PROHIBITED' };
    }

    const { type = 'full', format = 'json', saveToDisk = false } = rawOpts;

    // 如果指定保存到磁盘，必须由主进程受信任逻辑控制，或通过主进程原生 dialog 由用户主动选择
    if (saveToDisk) {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') {
        return { ok: false, error: 'DIALOG_UNAVAILABLE' };
      }
      const dialogResult = await dialog.showOpenDialog({
        title: '选择导出目录',
        properties: ['openDirectory', 'createDirectory']
      });
      if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
        return { ok: false, cancelled: true, error: 'EXPORT_CANCELLED' };
      }
      const trustedTargetDir = dialogResult.filePaths[0];
      try {
        const result = researchService.exportData({
          type,
          format,
          targetDir: trustedTargetDir
        });
        return { ok: true, targetDir: trustedTargetDir, result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // 默认内存导出：返回导出结果（字符串或 JSON 结构）
    return researchService.exportData({ type, format });
  });

  // 11. 快照手动刷新
  ipcMain.handle('research:refresh', () => {
    return researchService.refreshSnapshot();
  });

  // 12. 只读完整性哈希核验
  ipcMain.handle('research:verify-integrity', (e, opts) => {
    try {
      const ok = researchService.verifyIntegrity(opts && opts.beforeHashes);
      return { ok, error: null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 13. 获取当前数据哈希
  ipcMain.handle('research:get-hashes', () => {
    return researchService.computeIntegrityHashes();
  });
}

module.exports = { registerResearchIpc };
