const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  // 窗口
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  // 主进程发现窗口失焦时通知我们收尾拖拽（渲染进程的 blur 不一定触发）
  onDragCancel: (cb) => ipcRenderer.on('drag-cancel', () => cb()),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  resize: (f) => ipcRenderer.send('resize-pet', f),
  motionUiState: (state) => ipcRenderer.send('motion-ui-state', state),
  motionStatus: () => ipcRenderer.invoke('motion-status'),
  onMotionState: (cb) => ipcRenderer.on('motion-state', (e, s) => cb(s)),
  quit: () => ipcRenderer.send('quit-app'),

  // 对话
  // opts 只有主动搭话那一趟会带（{proactive, offer}）：主进程拿 offer 记账。
  // 老签名传两个参数会被 ipc 无声丢掉第二个，所以这里必须显式往下传。
  send: (text, opts) => ipcRenderer.invoke('chat-send', text, opts),
  onDelta: (cb) => ipcRenderer.on('chat-delta', (e, d) => cb(d)),
  // 本地活动上报（'click' / 'drag'）：判据都在主进程的 tracker 里算，
  // 渲染端只报"发生了什么"，不带自己那份时间戳账本。
  activity: (type) => ipcRenderer.send('activity', type),
  // 问一声"该不该开口"：返回提案或 null，不花钱也不改状态（保留向后兼容）
  proactiveCheck: () => ipcRenderer.invoke('proactive-check'),
  // 主进程事件驱动主动搭话推送
  onProactiveOffer: (cb) => ipcRenderer.on('proactive-offer', (e, o) => cb(o)),
  proactiveDeclined: (offer) => ipcRenderer.send('proactive-declined', offer),
  report: () => ipcRenderer.invoke('chat-report'),
  clearMemory: () => ipcRenderer.invoke('memory-clear'),
  listMemory: () => ipcRenderer.invoke('memory-list'),
  listSelfLedger: () => ipcRenderer.invoke('self-ledger-list'),
  resetSelfLedger: () => ipcRenderer.invoke('self-ledger-reset'),
  deleteMemory: (i) => ipcRenderer.invoke('memory-delete', i),

  // 资源检查
  onAssetWarning: (cb) => ipcRenderer.on('asset-warning', (e, report) => cb(report)),
  assetCheck: () => ipcRenderer.invoke('asset-check'),

  // 换装
  wardrobeState: () => ipcRenderer.invoke('wardrobe-state'),
  wardrobeSet: (slot, itemId) => ipcRenderer.invoke('wardrobe-set', { slot, itemId }),
  wardrobePreset: (id) => ipcRenderer.invoke('wardrobe-preset', id),
  onWardrobe: (cb) => ipcRenderer.on('wardrobe-changed', (e, l) => cb(l)),

  // 配置
  getConfig: () => ipcRenderer.invoke('config-get'),
  setKey: (k) => ipcRenderer.invoke('config-set-key', k),
  openConfig: () => ipcRenderer.invoke('config-open'),
  // 创作 Skill 是临时模式，不进入长期记忆；只改变 system 提示词。
  creativeModeGet: () => ipcRenderer.invoke('creative-mode-get'),
  creativeModeSet: (enabled) => ipcRenderer.invoke('creative-mode-set', !!enabled),

  // 实验观测与可复盘工具链 (v0.9.5)
  research: {
    getState: () => ipcRenderer.invoke('research:get-state'),
    getWindows: (opts) => ipcRenderer.invoke('research:get-windows', opts),
    getWindow: (opts) => ipcRenderer.invoke('research:get-window', opts),
    getWindowRounds: (opts) => ipcRenderer.invoke('research:get-window-rounds', opts),
    getEvents: (opts) => ipcRenderer.invoke('research:get-events', opts),
    getObservations: (opts) => ipcRenderer.invoke('research:get-observations', opts),
    getInterpretations: (opts) => ipcRenderer.invoke('research:get-interpretations', opts),
    getEvidence: (opts) => ipcRenderer.invoke('research:get-evidence', opts),
    getStateChanges: (opts) => ipcRenderer.invoke('research:get-state-changes', opts),
    getProvenance: (opts) => ipcRenderer.invoke('research:get-provenance', opts),
    getEOI: (opts) => ipcRenderer.invoke('research:get-eoi', opts),
    search: (opts) => ipcRenderer.invoke('research:search', opts),
    replayStart: (opts) => ipcRenderer.invoke('research:replay:start', opts),
    replayStatus: (taskId) => ipcRenderer.invoke('research:replay:status', taskId),
    replayCancel: (taskId) => ipcRenderer.invoke('research:replay:cancel', taskId),
    exportData: (opts) => ipcRenderer.invoke('research:export', opts),
    refresh: () => ipcRenderer.invoke('research:refresh'),
    getHashes: () => ipcRenderer.invoke('research:get-hashes'),
    verifyIntegrity: (beforeHashes) => ipcRenderer.invoke('research:verify-integrity', { beforeHashes })
  }
});
