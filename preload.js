const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  // Creative 创作空间（v0.9.9 Phase 3）：只暴露业务方法，不暴露 Node/Store/Adapter 对象
  creative: {
    listProjects: () => ipcRenderer.invoke('creative:list-projects'),
    createProject: (projectId) => ipcRenderer.invoke('creative:create-project', projectId),
    getActiveProject: () => ipcRenderer.invoke('creative:get-active-project'),
    setActiveProject: (projectId) => ipcRenderer.invoke('creative:set-active-project', projectId),
    loadProject: (projectId) => ipcRenderer.invoke('creative:load-project', projectId),
    updateContext: (projectId, context) => ipcRenderer.invoke('creative:update-context', projectId, context),
    summarize: (projectId) => ipcRenderer.invoke('creative:summarize', projectId),
    getHistory: (projectId) => ipcRenderer.invoke('creative:get-history', projectId),
    send: (projectId, content) => ipcRenderer.invoke('creative:send', { projectId, content }),
    abort: (projectId) => ipcRenderer.invoke('creative:abort', projectId),
    listSkills: () => ipcRenderer.invoke('creative:list-skills'),
    loadSkill: (skillName) => ipcRenderer.invoke('creative:load-skill', skillName),
    onDelta: (cb) => ipcRenderer.on('creative:delta', (e, p) => cb(p)),
    onCompleted: (cb) => ipcRenderer.on('creative:completed', (e, p) => cb(p)),
    onError: (cb) => ipcRenderer.on('creative:error', (e, p) => cb(p)),
    onAborted: (cb) => ipcRenderer.on('creative:aborted', (e, p) => cb(p))
  },
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
  listMemory: () => ipcRenderer.invoke('memory-list'),
  chatHistory: () => ipcRenderer.invoke('chat-history'),
  listSelfLedger: () => ipcRenderer.invoke('self-ledger-list'),
  resetSelfLedger: (confirm) => ipcRenderer.invoke('self-ledger-reset', { confirm: confirm === true }),
  // Phase 0.5: 内部调节状态查询与事件监听
  getInternalRegulation: () => ipcRenderer.invoke('internal-regulation-get'),
  onInternalRegulation: (cb) => ipcRenderer.on('internal-regulation-updated', (e, s) => cb(s)),

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

  // 0.9.8 Z3：Connection 管理（credential 只进不出 —— API Key 可传入，绝无回读）
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    get: (connectionId) => ipcRenderer.invoke('connections:get', { connectionId }),
    create: (data) => ipcRenderer.invoke('connections:create', data),
    update: (connectionId, patch, credential) => ipcRenderer.invoke('connections:update', { connectionId, patch, credential }),
    delete: (connectionId, deleteCredential) => ipcRenderer.invoke('connections:delete', { connectionId, deleteCredential }),
    test: (connectionId) => ipcRenderer.invoke('connections:test', { connectionId }),
    activate: (connectionId) => ipcRenderer.invoke('connections:activate', { connectionId })
  },

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
