const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  // Creative 创作空间已按路线图 §3/§4.6 拆除（2026-10）
  // 窗口
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  // 主进程发现窗口失焦时通知我们收尾拖拽（渲染进程的 blur 不一定触发）
  onDragCancel: (cb) => ipcRenderer.on('drag-cancel', () => cb()),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  pinState: () => ipcRenderer.invoke('pin-state'),
  resize: (f) => ipcRenderer.send('resize-pet', f),
  motionUiState: (state) => ipcRenderer.send('motion-ui-state', state),
  motionStatus: () => ipcRenderer.invoke('motion-status'),
  onMotionState: (cb) => ipcRenderer.on('motion-state', (e, s) => cb(s)),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', !!ignore),
  quit: () => ipcRenderer.send('quit-app'),

  // 对话
  // opts 只有主动搭话那一趟会带（{proactive, offer}）：主进程拿 offer 记账。
  // 老签名传两个参数会被 ipc 无声丢掉第二个，所以这里必须显式往下传。
  send: (text, opts) => ipcRenderer.invoke('chat-send', text, opts),
  onDelta: (cb) => ipcRenderer.on('chat-delta', (e, d) => cb(d)),
  // 本地活动上报（'click' / 'drag'）：判据都在主进程的 tracker 里算，
  // 渲染端只报"发生了什么"，不带自己那份时间戳账本。
  activity: (type, details) => ipcRenderer.send('activity', type, details),
  // 问一声"该不该开口"：返回提案或 null，不花钱也不改状态（保留向后兼容）
  proactiveCheck: () => ipcRenderer.invoke('proactive-check'),
  // 主进程事件驱动主动搭话推送
  onProactiveOffer: (cb) => ipcRenderer.on('proactive-offer', (e, o) => cb(o)),
  proactiveDeclined: (offer) => ipcRenderer.send('proactive-declined', offer),
  report: () => ipcRenderer.invoke('chat-report'),
  listMemory: () => ipcRenderer.invoke('memory-list'),
  chatHistory: () => ipcRenderer.invoke('chat-history'),
  // 🔴 v1.0 她说完了 → 对话窗重新对账（信号，不带内容）。
  //   为什么必须存在：对话窗的数据层只在页面加载时拉一次历史（chat.js 的 ChatStore.load()），
  //   此前只有「用户发消息」会刷新它。而她主动搭话、睡眠后醒来开口这两条路
  //   都发生在桌宠窗口，对话窗不知情 ⇒ 她说了但对话框里查无此话，
  //   退出重开才看得到（重开= 重新 load 一次）。
  //   ⚠️ 刻意不传文本：对话窗必须自己回查 memory.history（单一事实源），
  //   这里塞第二份真相将来必然对不上。
  onChatHistoryChanged: (cb) => ipcRenderer.on('chat-history-changed', (e, p) => cb(p)),
  chatWindowOpen: () => ipcRenderer.invoke('chat-window-open'),
  chatWindowClose: () => ipcRenderer.invoke('chat-window-close'),
  chatWindowToggle: () => ipcRenderer.invoke('chat-window-toggle'),
  chatWindowHome: () => ipcRenderer.invoke('chat-window-home'),
  chatBusy: (busy, state) => ipcRenderer.invoke('chat-busy', { busy: !!busy, state: state || null }),
  panelViewport: (open, w, h) => ipcRenderer.invoke('panel-viewport', open === true, { w: w || 0, h: h || 0 }),
  onChatBusy: (cb) => ipcRenderer.on('chat-busy', (e, p) => cb(p)),
  onChatHidden: (cb) => ipcRenderer.on('chat-window-hidden', () => cb()),
  onSleepState: (cb) => ipcRenderer.on('sleep-state', (e, p) => cb(p)),
  listSelfLedger: () => ipcRenderer.invoke('self-ledger-list'),
  selfTimezone: (clientTz) => ipcRenderer.invoke('self-timezone', clientTz || ''),
  lifeMechanisms: () => ipcRenderer.invoke('life-mechanisms'),
  dreamList: () => ipcRenderer.invoke('dream-list'),
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

  // Agent 治理 + 受控执行通道（D-1 建管道 / D-3 加确认 / D-4 加执行）。
  // 🔒 execute 存在，但它**不是万能钥匙**：主进程侧是三重默认关闭
  //   （killSwitch=true + allowed=[] + 无 scope 根），默认状态下必然被拒。
  //   且参数只有 proposalId 与 content —— 刻意不暴露 scope/target：
  //   路径永远取自主进程侧的提案，若让渲染端能传路径，scope 白名单形同虚设。
  //   渲染端能做的只是「提案」「对提案投票」「请求执行已确认的提案」。
  agent: {
    getStatus: () => ipcRenderer.invoke('agent:get-status'),
    getCapabilities: () => ipcRenderer.invoke('agent:get-capabilities'),
    propose: (payload) => ipcRenderer.invoke('agent:propose-action', payload),
    // 只登记用户决策，不代表执行 —— executed 恒为 false。
    confirm: (payload) => ipcRenderer.invoke('agent:confirm-action', payload),
    // D-4：执行。**参数只有 proposalId 与 content**——
    //   刻意不暴露 scope/target：路径永远取自主进程侧的提案，
    //   若让渲染端能传路径，scope 白名单就形同虚设。
    execute: (payload) => ipcRenderer.invoke('agent:execute', {
      proposalId: payload && payload.proposalId,
      content: payload && payload.content
    }),
    getAuditLog: (opts) => ipcRenderer.invoke('agent:get-audit-log', opts || {}),

    // D-10：主进程建案后通知渲染端「去取提案快照」。
    //   ⚠️ 信号里**只有 proposalId**，不含提案对象本身 ——
    //     渲染端必须自己回查 agent:get-pending-proposal（冻结快照）。
    //     若在这里把提案对象塞过来，D-3 顶替攻击那一族就重新打开了。
    getPendingProposal: (proposalId) => ipcRenderer.invoke('agent:get-pending-proposal', { proposalId }),
    onProposalAvailable: (cb) => ipcRenderer.on('agent-proposal-available', (e, p) => cb(p))
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
