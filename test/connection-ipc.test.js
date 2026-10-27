/**
 * test/connection-ipc.test.js — Z3：IPC + UI + Test Connection
 *
 * 覆盖（Z3 测试清单）：
 *  1. IPC list   2. IPC get   3. create   4. update   5. delete   6. activate
 *  7. credential 只进不出   8. renderer secret isolation
 *  9. Test Connection verified   10. failed   11. unverified   12. healthCheck 未实现
 * 13. authProbe 只由用户主动 test 触发   14. IPC guard
 * 15/16. UI connection switching / 多 connection UI 状态同步（源码级接线断言）
 * 17. 同协议多 Key   18. protocol 分离   19. SEC-01 回归（全经 ipcGuard）
 *
 * fake electron + fetch 桩 + tmp 目录：无真实 API Key、无真实网络请求。
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// [tmp-hygiene] 临时目录清理（2026-10-06）。本文件此前 0 处清理，跑一次净留多个 %TEMP% 沙盒。
// 手法：包住 fs.mkdtempSync 本身，新增调用点会自动被覆盖。
// ⚠️ 位置纪律：本块必须晚于 require('fs')、早于首个 mkdtempSync 调用：
//   插在 fs 定义前 = ReferenceError；插在调用点后 = 包装白装（两者都实测过）。
//   也不能挪到文件末尾—— 这些测试在文件中部就 process.exit()。
const _tmpHygieneDirs = [];
const _tmpHygieneOrig = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _tmpHygieneOrig.apply(fs, a);
  _tmpHygieneDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _tmpHygieneDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _tmpHygieneOrig;
});

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-ipc-'));
const CFG = path.join(DIR, 'life-config.json');

// fake safeStorage（可逆假算法，绝不接触真实 keychain）
const fakeSS = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + s),
  decryptString: (b) => {
    const t = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
    return t.startsWith('ENC:') ? t.slice(4) : null;
  }
};

// fetch 桩：可编程响应 + 计数（authProbe 只在用户 test 时发生）
const fetchLog = [];
let fetchResponder = () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: {}, model: 'test-model' })
});
global.fetch = async (url, init) => {
  fetchLog.push({ url: String(url), init });
  return fetchResponder(url, init);
};

/* ---------- fake electron（同 main.test.js 形态） ---------- */
const handlers = new Map();
const sent = [];
const mainFrame = { url: require('url').pathToFileURL(path.join(ROOT, 'index.html')).href };
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (c, p) => sent.push([c, p]), on: () => {}, mainFrame, setWindowOpenHandler: () => {} },
  on: () => {}, loadFile: () => {},
  setPosition() {}, getPosition: () => [0, 0], getSize: () => [340, 480], setSize() {},
  setAlwaysOnTop() {}, isAlwaysOnTop: () => true
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return {
    app: { getPath: () => DIR, whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
    BrowserWindow: Object.assign(function () { return fakeWin; }, { allWindows: [] }),
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set('on:' + ch, fn) },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    shell: { openPath: () => {} },
    Menu: { setApplicationMenu: () => {} },
    safeStorage: fakeSS,
    session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  };
  return origLoad.apply(this, arguments);
};

// 捕获 main.js new 出来的 Brain（activate 换绑断言需要）
const brainMod = require(path.join(ROOT, 'src/brain.js'));
const RealBrain = brainMod.Brain;
let brainInstances = [];
class SpiedBrain extends RealBrain {
  constructor(...a) { super(...a); brainInstances.push(this); }
}
brainMod.Brain = SpiedBrain;
// 预置旧式单配置（含 legacy 明文 key）：迁移后应变 legacy-mapped default connection
fs.writeFileSync(CFG, JSON.stringify({
  apiKey: 'sk-legacy', baseURL: 'https://api.deepseek.com',
  provider: 'deepseek', credentialType: 'deepseek-api-key', model: 'deepseek-flash'
}));
require(path.join(ROOT, 'main.js'));

const connectionsMod = require(path.join(ROOT, 'src/connections.js'));
const secureCreds = require(path.join(ROOT, 'src/secure-credentials.js'));
const trustedEvent = () => ({ sender: fakeWin.webContents, senderFrame: fakeWin.webContents.mainFrame });
const invoke = async (ch, arg) => handlers.get(ch)(trustedEvent(), arg);

(async () => {
  await new Promise((r) => setImmediate(r));

  /* ---- 1/2/11：list / get / secret isolation ---- */
  const l0 = await invoke('connections:list');
  check('1 IPC list：启动迁移生成 default connection（旧单配置语义保留）',
    l0.ok === true && Array.isArray(l0.items) && l0.items.length === 1 &&
    l0.items[0].connectionId === 'conn-default' && l0.activeConnectionId === 'conn-default');

  const sweep = JSON.stringify(l0);
  check('8/11 renderer secret isolation：list/get 不含 secret / credentialRef / 文件路径',
    !sweep.includes('sk-legacy') && !sweep.includes('ENC:') && !sweep.includes('cred:') &&
    !sweep.includes('life-key') && l0.items[0].hasCredential === true && typeof l0.items[0].keyEncrypted === 'boolean');

  const g0 = await invoke('connections:get', { connectionId: 'conn-default' });
  const gBad = await invoke('connections:get', { connectionId: 'conn-nope' });
  check('2 IPC get：单条 DTO / 未知 id 拒绝',
    g0.ok === true && g0.connection.connectionId === 'conn-default' &&
    !JSON.stringify(g0).includes('cred:') && gBad.ok === false);

  /* ---- 3/4/5：create / update / delete ---- */
  const fetchBeforeCrud = fetchLog.length;
  const cr = await invoke('connections:create', {
    displayName: 'Custom A', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://a.example.com', model: 'model-a', credential: 'secret-A',
    credentialRef: 'cred:hack' // renderer 不得指定：必须被忽略/拒绝
  });
  check('3 create：credential 只进（返回体无 secret）、credentialRef 服务端生成',
    cr.ok === true && typeof cr.connectionId === 'string' && !JSON.stringify(cr).includes('secret-A'));
  const store = connectionsMod.loadStore(DIR).store;
  const connA = store.connections.find((c) => c.displayName === 'Custom A');
  check('3 renderer 传入的 credentialRef 未被采用（服务端生成独立 ref）',
    connA && connA.credentialRef !== 'cred:hack' && connA.credentialOwnership === 'exclusive');

  const crB = await invoke('connections:create', {
    displayName: 'Custom B', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://b.example.com', model: 'model-b', credential: 'secret-B'
  });
  check('17 同协议多 Key：两个 custom 连接各自独立凭据（hasCredential 均为真）',
    crB.ok === true &&
    (await invoke('connections:get', { connectionId: cr.connectionId })).connection.hasCredential === true &&
    (await invoke('connections:get', { connectionId: crB.connectionId })).connection.hasCredential === true);

  const up = await invoke('connections:update', { connectionId: cr.connectionId, patch: { displayName: 'Custom A2', activeModel: 'model-a2' } });
  const upBad = await invoke('connections:update', { connectionId: cr.connectionId, patch: { credentialRef: 'cred:evil' } });
  check('4 update：字段更新生效 / immutable 字段（credentialRef）拒绝',
    up.ok === true &&
    (await invoke('connections:get', { connectionId: cr.connectionId })).connection.displayName === 'Custom A2' &&
    (await invoke('connections:get', { connectionId: cr.connectionId })).connection.activeModel === 'model-a2' &&
    upBad.ok === false && upBad.error.includes('IMMUTABLE_FIELD'));

  /* ---- 18：protocol 分离 ---- */
  const badProto = await invoke('connections:create', {
    displayName: 'BadProto', providerId: 'custom', protocol: 'cloud-direct',
    baseURL: 'https://p.example.com', model: 'm'
  });
  const anthro = await invoke('connections:create', {
    displayName: 'Anthro', providerId: 'custom', protocol: 'anthropic-native',
    baseURL: 'https://api.anthropic.com', model: 'claude-x', credential: 'secret-x'
  });
  check('18 protocol 分离：部署类型（cloud-direct）不得写入 protocol；anthropic-native 可保存',
    badProto.ok === false && badProto.error.includes('PROTOCOL_NOT_SUPPORTED') && anthro.ok === true);

  /* ---- 6/9/13/17：activate + authProbe 纪律 ---- */
  fetchResponder = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"choices":[],"usage":{}}' });
  const brainBefore = brainInstances.length;
  const ac = await invoke('connections:activate', { connectionId: crB.connectionId });
  const newBrain = brainInstances[brainInstances.length - 1];
  check('6 activate：A→B hot-swap 成功（swapped:true、Brain/activeConnectionId 一致）',
    ac.ok === true && ac.swapped === true && ac.activeConnectionId === crB.connectionId &&
    brainInstances.length === brainBefore + 1 && newBrain.cfg.apiKey === 'secret-B');

  const acAgain = await invoke('connections:activate', { connectionId: crB.connectionId });
  check('9 activate 同连接：swapped:false（不重复换绑）',
    acAgain.ok === true && acAgain.swapped === false && brainInstances.length === brainBefore + 1);

  const acA = await invoke('connections:activate', { connectionId: cr.connectionId });
  check('17 跨连接换绑：切回 A 后解析 A 自己的 key（不串写）',
    acA.ok === true && brainInstances[brainInstances.length - 1].cfg.apiKey === 'secret-A' &&
    brainInstances[brainInstances.length - 1].cfg.model === 'model-a2');

  check('13 authProbe 只由用户主动 test 触发：list/create/update/activate 全程零 fetch',
    fetchLog.length === fetchBeforeCrud);

  /* ---- 9/10/11/12：Test Connection 三态 ---- */
  fetchResponder = () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: {}, model: 'test-model' })
  });
  const t9 = await invoke('connections:test', { connectionId: cr.connectionId });
  check('9 Test Connection verified：authProbe 成功 -> verified',
    t9.ok === true && t9.status === 'verified' && t9.phase === 'authProbe');

  fetchResponder = () => ({
    ok: false, status: 401, headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: 'bad key' } })
  });
  const t10 = await invoke('connections:test', { connectionId: cr.connectionId });
  check('10 Test Connection failed：401 -> failed/AUTH_REJECTED（明确验证失败）',
    t10.ok === true && t10.status === 'failed' && t10.reason === 'AUTH_REJECTED');

  const t11 = await invoke('connections:test', { connectionId: anthro.connectionId });
  check('11/12 Test Connection unverified：无 healthCheck 且协议不可安全探测 -> unverified（绝不判 failed）',
    t11.ok === true && t11.status === 'unverified' && t11.reason.startsWith('NO_PROBE_FOR_PROTOCOL') &&
    t11.status !== 'failed');

  // healthCheck 未实现的显式断言：generic adapter 无 healthCheck 方法，缺省不得判 failed
  const { createAdapter } = require(path.join(ROOT, 'src/provider-registry.js'));
  const genericAdapter = createAdapter('custom', { baseURL: 'https://x.example.com', model: 'm', apiKey: 'k' });
  check('12 healthCheck 未实现本身不判 failed（adapter 无 healthCheck 声明）',
    typeof genericAdapter.healthCheck !== 'function' && t11.status === 'unverified');

  // testState 快照已持久化（三态记录）
  const afterTest = connectionsMod.loadStore(DIR).store.connections.find((c) => c.connectionId === cr.connectionId);
  check('Test Connection 结果写入 testState 快照（仅快照，非 runtime fact）',
    afterTest.testState.status === 'failed' && afterTest.testState.phase === 'authProbe');

  /* ---- 5：delete 语义 ---- */
  const delA = await invoke('connections:delete', { connectionId: cr.connectionId, deleteCredential: true });
  const refA = connA.credentialRef;
  const refB = connectionsMod.loadStore(DIR).store.connections.find((c) => c.connectionId === crB.connectionId).credentialRef;
  check('5 delete：exclusive -> 联动删除其独占凭据（B 的凭据不受影响）',
    delA.ok === true && delA.credentialDeleted === true &&
    secureCreds.getCredential(refA, { dir: DIR, getSS: () => fakeSS }) === null &&
    secureCreds.getCredential(refB, { dir: DIR, getSS: () => fakeSS }) === 'secret-B');

  const delDefault = await invoke('connections:delete', { connectionId: 'conn-default', deleteCredential: true });
  check('5 delete：legacy-mapped -> 只删连接、legacy 凭据保留',
    delDefault.ok === true && delDefault.credentialDeleted === false &&
    delDefault.credentialNote === 'LEGACY_CREDENTIAL_KEPT');

  /* ---- 7：credential 只进不出（全通道扫描） ---- */
  const allSweep = JSON.stringify([
    await invoke('connections:list'),
    await invoke('connections:get', { connectionId: crB.connectionId }),
    await invoke('connections:create', { displayName: 'Sweep', providerId: 'custom', protocol: 'openai-compatible', baseURL: 'https://s.example.com', model: 'm', credential: 'secret-sweep' }),
    await invoke('connections:update', { connectionId: crB.connectionId, patch: { displayName: 'B2' } })
  ]);
  check('7 credential 只进不出：list/get/create/update 返回体零 secret / 零路径',
    !allSweep.includes('secret-sweep') && !allSweep.includes('secret-B') &&
    !allSweep.includes('cred:') && !allSweep.includes('life-key') && !allSweep.includes('ENC:'));

  /* ---- 14/19：IPC guard / SEC-01 ---- */
  const untrustedSender = { sender: {}, senderFrame: mainFrame };
  const untrustedFrame = { sender: fakeWin.webContents, senderFrame: { url: 'https://evil.example.com/x' } };
  let guardHit = 0;
  for (const ev of [untrustedSender, untrustedFrame]) {
    try { await handlers.get('connections:list')(ev); } catch (e) {
      if (e && e.code === 'UNTRUSTED_RENDERER') guardHit++;
    }
  }
  check('14 IPC guard：untrusted sender / remote frame 均被拒（UNTRUSTED_RENDERER）', guardHit === 2);

  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('19 SEC-01 回归：connections:* 全经 ipcGuard（main.js 无裸 ipcMain.handle/on）',
    !mainSrc.includes('ipcMain.handle(') && !mainSrc.includes('ipcMain.on(') &&
    (mainSrc.match(/ipcGuard\.handle\('connections:/g) || []).length === 7);

  /* ---- 15/16：UI 接线（源码级） ---- */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const pet = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
  check('15 UI：Provider Identity 与 Protocol 为两个独立字段（不合并为自动识别）',
    html.includes('Provider Identity') && html.includes('<label>Protocol</label>') &&
    html.indexOf('Provider Identity') !== html.indexOf('<label>Protocol</label>'));
  check('15 UI connection switching：测试/切换/删除按钮接线到 connections API',
    ['connTest', 'connActivate', 'connDelete'].every((id) => html.includes('id="' + id + '"')) &&
    pet.includes('api.connections.test') && pet.includes('api.connections.activate') &&
    pet.includes('api.connections.delete'));
  check('16 多 connection UI 状态同步：增删改/测试/切换后均刷新列表，secret 输入框清空不回填',
    (pet.match(/await refreshConnections\(\)/g) || []).length >= 4 &&
    pet.includes("connKey').value = ''"));

  console.log('\n' + (failures ? failures + ' 项失败' : 'connection-ipc tests passed: '));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
