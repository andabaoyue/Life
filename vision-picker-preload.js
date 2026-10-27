/**
 * 框选窗专用 preload：只暴露 vision-picker.js 实际需要的四条 IPC。
 * 主窗与对话窗继续使用 preload.js，权限不会继承到透明全屏窗口。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  vision: {
    capture: (opts) => ipcRenderer.invoke('vision:capture', opts),
    stage: (opts) => ipcRenderer.invoke('vision:stage', opts),
    closePicker: () => ipcRenderer.invoke('vision:close-picker')
  },
  visionNotify: (payload) => ipcRenderer.send('vision-notify', payload)
});
