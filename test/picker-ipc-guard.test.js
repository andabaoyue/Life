/**
 * 框选窗 IPC 权限策略单测（纯 Node，无 Electron 运行时依赖）。
 * 验证 picker 最小通道白名单，并验证 ipcGuard 对 invoke/send 两类通道统一执行策略。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createIpcGuard, isChannelAllowedForPicker } = require('../src/ipc-guard');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED = new Set([
  'vision:capture',
  'vision:stage',
  'vision:close-picker',
  'vision-notify'
]);
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
let failures = 0;
let assertions = 0;

function check(name, condition) {
  assertions++;
  console.log((condition ? 'PASS  ' : 'FAIL  ') + name);
  if (!condition) failures++;
}

const pickerSender = {};
const matrix = [
  ['vision:capture', true],
  ['vision:stage', true],
  ['vision:close-picker', true],
  ['vision-notify', true],
  ['vision:pending', false],
  ['vision:capability', false],
  ['vision:open-picker', false],
  ['config-set-key', false],
  ['connections:delete', false],
  ['chat-send', false],
  ['agent:execute', false]
];

check('picker 判定表精确允许四通道并拒绝其余通道',
  matrix.every(([channel, expected]) => isChannelAllowedForPicker(
    { sender: pickerSender }, channel, pickerSender, ALLOWED) === expected));
check('主窗和对话窗不受 picker 白名单限制',
  isChannelAllowedForPicker({ sender: {} }, 'agent:execute', pickerSender, ALLOWED)
  && isChannelAllowedForPicker({ sender: {} }, 'connections:delete', pickerSender, ALLOWED));
check('当前没有 picker 时不改变常规窗口授权',
  isChannelAllowedForPicker({ sender: {} }, 'agent:execute', null, ALLOWED));
check('picker 已活动但 IPC 事件缺少 sender 时拒绝',
  isChannelAllowedForPicker(null, 'vision:capture', pickerSender, ALLOWED) === false);

const handlers = new Map();
const listeners = new Map();
const mainContents = { mainFrame: { url: pathToFileURL(path.join(ROOT, 'index.html')).href } };
const chatContents = { mainFrame: { url: pathToFileURL(path.join(ROOT, 'chat.html')).href } };
const pickerContents = { mainFrame: { url: pathToFileURL(path.join(ROOT, 'vision-picker.html')).href } };
const guard = createIpcGuard({
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn)
  },
  getMainWindow: () => ({ webContents: mainContents }),
  getTrustedWebContents: () => [chatContents, pickerContents],
  appDir: ROOT,
  authorizeChannel: (event, channel) => isChannelAllowedForPicker(
    event, channel, pickerContents, ALLOWED)
});
const eventFor = (sender) => ({ sender, senderFrame: sender.mainFrame });
let protectedHandlerCalls = 0;
let notifyCalls = 0;
let blockedSendCalls = 0;
guard.handle('vision:capture', () => 'capture-ok');
guard.handle('agent:execute', () => { protectedHandlerCalls++; return 'executed'; });
guard.on('vision-notify', () => { notifyCalls++; });
guard.on('connections:delete', () => { blockedSendCalls++; });

check('ipcGuard.handle 允许 picker 使用视觉通道',
  handlers.get('vision:capture')(eventFor(pickerContents)) === 'capture-ok');

let deniedInvokeCode = '';
try {
  handlers.get('agent:execute')(eventFor(pickerContents));
} catch (err) {
  deniedInvokeCode = err.code;
}
check('ipcGuard.handle 在业务 handler 前拒绝越权调用',
  deniedInvokeCode === 'UNAUTHORIZED_RENDERER_CHANNEL' && protectedHandlerCalls === 0);
check('ipcGuard.handle 保留主窗既有权限',
  handlers.get('agent:execute')(eventFor(mainContents)) === 'executed' && protectedHandlerCalls === 1);

listeners.get('vision-notify')(eventFor(pickerContents));
listeners.get('connections:delete')(eventFor(pickerContents));
check('ipcGuard.on 放行回执并静默丢弃越权单向消息',
  notifyCalls === 1 && blockedSendCalls === 0);

const pickerPreload = fs.readFileSync(path.join(ROOT, 'vision-picker-preload.js'), 'utf8');
const pickerChannels = [...pickerPreload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)]
  .map((m) => m[1]);
const pickerWindow = fs.readFileSync(path.join(ROOT, 'src', 'vision-picker-window.js'), 'utf8');
const builder = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
const asar = fs.readFileSync(path.join(ROOT, 'tools', 'asar-check.js'), 'utf8');
const release = fs.readFileSync(path.join(ROOT, 'tools', 'release-check.js'), 'utf8');
const publicExport = fs.readFileSync(path.join(ROOT, 'tools', 'public-export.js'), 'utf8');
check('隔离 preload 已接入窗口，并进入全部发布闭包清单',
  pickerChannels.length === 4
  && [...ALLOWED].every((channel) => pickerChannels.includes(channel))
  && pickerWindow.includes('vision-picker-preload.js')
  && builder.includes('vision-picker-preload.js')
  && asar.includes('vision-picker-preload.js')
  && release.includes('vision-picker-preload.js')
  && publicExport.includes('vision-picker-preload.js'));

const configuredPolicy = /const VISION_ONLY_CHANNELS = new Set\(\[([\s\S]*?)\]\);/.exec(mainSrc);
const configuredChannels = configuredPolicy
  ? [...configuredPolicy[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];
check('主进程将精确四通道策略挂到 ipcGuard 全局入口',
  mainSrc.includes('authorizeChannel: (event, channel) => assertChannelAllowedForPicker(event, channel)')
  && configuredChannels.length === ALLOWED.size
  && [...ALLOWED].every((channel) => configuredChannels.includes(channel)));

console.log(`ASSERT total=${assertions} passed=${assertions - failures} failed=${failures}`);
console.log(failures ? `${failures} 项失败` : '全部通过');
process.exit(failures ? 1 : 0);
