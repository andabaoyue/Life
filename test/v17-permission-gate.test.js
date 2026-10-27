/**
 * test/v17-permission-gate.test.js
 *
 * v1.7-a 门禁：**麦克风权限闸门**（安全加固）。
 *
 * ## 为什么必须单独立项
 *   本仓此前**没有任何** `setPermissionRequestHandler`（v1.7-a 实测 grep 零命中），
 *   等于把"是否允许麦克风 / 通知 / 地理位置 / USB"交给了 Electron 的默认行为。
 *   默认行为随版本变化，且**不是默认拒绝** —— 那不是一个安全边界，是一个赌。
 *
 * ## 这条闸门的三个判据
 *   1. **白名单只含 'media'**（`electron.d.ts:13508` 的枚举里只有它，
 *      **没有 'microphone'** —— 后者仅是 `:14207` 的 macOS 专用 API 参数）；
 *   2. **只放行本地页**（复用 `ipc-guard.isAppLocalUrl`，判据单一来源）；
 *   3. **默认拒绝**：白名单外的权限一律 false。
 *
 * ## 为什么用"假 session"测而不是起真 Electron
 *   闸门是**纯函数式接线**：它只依赖 `session` 的三个方法签名。
 *   用假 session 捕获注册进来的两个 handler，就能**直接调用**它们验证行为 ——
 *   比拉起真窗口快、稳、且能在 CI 里跑（CI 无 GUI）。
 *   真实链路另由"源码时序断言"（第 9 条）兜住。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const ipcGuardSrc = fs.readFileSync(path.join(ROOT, 'src', 'ipc-guard.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.7-a 麦克风权限闸门门禁 ---');

/* ============ 0. 从 main.js 里取出 installPermissionGate 并执行 ============ */
// 用 Function 构造器沙箱执行：只给它 electron/ipc-guard 的桩，不真启动 Electron。
const gateSrc = (() => {
  const m = mainSrc.match(/function installPermissionGate\(ses\) \{[\s\S]*?\n\}/);
  return m ? m[0] : '';
})();

check('🔴 main.js 里存在 installPermissionGate 函数', gateSrc.length > 0);

// 用与 main.js 同签名的最小桩把闸门装进"假 session"
function makeFakeSession() {
  const reg = { request: null, check: null };
  return {
    reg,
    session: {
      setPermissionRequestHandler(fn) { reg.request = fn; },
      setPermissionCheckHandler(fn) { reg.check = fn; }
    }
  };
}

// 假的 webContents：可控 URL；null 用于空值守卫测试
const wcAt = (url) => ({ getURL: () => url });

// 构造出真正的 installPermissionGate（注入 isAppLocalUrl 的实现）
const makeGate = (() => {
  if (!gateSrc) return null;
  const { isAppLocalUrl } = require('../src/ipc-guard');
  try {
    // eslint-disable-next-line no-new-func
    return new Function('isAppLocalUrl', '__dirname', gateSrc + '; return installPermissionGate;')(isAppLocalUrl, ROOT);
  } catch (e) {
    return null;
  }
})();

check('🔴 installPermissionGate 可被独立实例化（用真实 isAppLocalUrl）', typeof makeGate === 'function');

/* ============ 1. 正向对照：'media' + 本地页 必须放行 ============ */
// 这一条防「全拒」假绿：如果闸门写得过严（比如判错枚举），
// 下面所有"一律拒"的断言都会恒真，门禁看起来全绿其实功能已废。
const f1 = makeFakeSession();
const ok1 = makeGate ? makeGate(f1.session) : false;
check('闸门安装返回 true', ok1 === true);

const localUrl = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
let allowLocal = null;
if (f1.reg.request) {
  f1.reg.request(wcAt(localUrl), 'media', (v) => { allowLocal = v; });
}
check('🔴 正向对照：media + 本地页 → 放行（防"全拒"假绿）', allowLocal === true,
  'allow=' + allowLocal + ' url=' + localUrl);

let checkLocal = null;
if (f1.reg.check) checkLocal = f1.reg.check(wcAt(localUrl), 'media');
check('🔴 正向对照：check handler 对 media + 本地页也放行', checkLocal === true);

/* ============ 2. 白名单外权限一律拒 ============ */
const DENIED = ['geolocation', 'notifications', 'midi', 'midiSysex', 'usb', 'serial',
  'hid', 'clipboard-read', 'display-capture', 'openExternal', 'mediaKeySystem', 'unknown'];
const deniedBad = [];
for (const perm of DENIED) {
  const f = makeFakeSession();
  makeGate(f.session);
  let got = null;
  f.reg.request(wcAt(localUrl), perm, (v) => { got = v; });
  if (got !== false) deniedBad.push(perm + '=' + got);
  // check handler 同口径
  if (f.reg.check && f.reg.check(wcAt(localUrl), perm) !== false) deniedBad.push(perm + '(check)');
}
check('🔴 白名单外权限全部拒绝（含 display-capture）', deniedBad.length === 0, deniedBad.join(','));

/* ============ 3. 外部 URL 必须拒 ============ */
const badUrls = [
  'https://evil.example/index.html',
  'http://127.0.0.1:8080/index.html',
  'file:///C:/Windows/System32/x.html',       // 目录外 file://
  'file:///' + path.join(ROOT, '..', 'outside.html').replace(/\\/g, '/'),  // 父目录
  '', '   ', null, undefined, 12345, {}        // 脏输入
];
const urlBad = [];
for (const u of badUrls) {
  const f = makeFakeSession();
  makeGate(f.session);
  let got = null;
  f.reg.request(wcAt(u), 'media', (v) => { got = v; });
  if (got !== false) urlBad.push(String(u) + '=' + got);
}
check('🔴 非本地页 / 脏 URL 下的 media 一律拒', urlBad.length === 0, urlBad.join(','));

/* ============ 4. wc 为空必须不抛、且拒 ============ */
let nullThrew = false;
let nullAllow = null;
try {
  const f = makeFakeSession();
  makeGate(f.session);
  f.reg.request(null, 'media', (v) => { nullAllow = v; });
} catch (e) { nullThrew = true; }
check('🔴 wc=null 时 request handler 不抛', !nullThrew);
check('🔴 wc=null 时一律拒', nullAllow === false, 'allow=' + nullAllow);

let nullCheckThrew = false;
let nullCheckVal = null;
try {
  const f = makeFakeSession();
  makeGate(f.session);
  nullCheckVal = f.reg.check ? f.reg.check(null, 'media') : null;
} catch (e) { nullCheckThrew = true; }
check('🔴 wc=null 时 check handler 不抛且拒绝', !nullCheckThrew && nullCheckVal === false,
  'val=' + nullCheckVal);

/* ============ 5. 'microphone' 不是合法枚举，必须拒 ============ */
// 🔴 这是本门禁最有价值的一条：electron.d.ts:13508 的 permission 枚举里**没有** 'microphone'。
//   如果有人"好心"加了 `permission === 'microphone'` 分支以为能修麦克风，
//   实际是把一个永不出现的值当白名单，而真正的 'media' 仍被正确放行 —— 看起来无害。
//   但它会让后来者以为"枚举里有 microphone"，进而在别处写错判据。
//   正确做法是：**只认 'media'，永不出现 'microphone' 分支**。
const f5 = makeFakeSession();
makeGate(f5.session);
let micVal = null;
f5.reg.request(wcAt(localUrl), 'microphone', (v) => { micVal = v; });
check('🔴 microphone（非枚举值）被拒，不得被当成白名单', micVal === false, 'val=' + micVal);

/* ============ 6. 源码断言：白名单常量只有 'media' ============ */
const allowedSet = gateSrc.match(/const ALLOWED = new Set\(\[([^\]]*)\]\)/);
check('🔴 源码里 ALLOWED 集合的声明存在', !!allowedSet);
if (allowedSet) {
  const items = allowedSet[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  check('🔴 ALLOWED 只含 media 一项（放宽必须过门禁）',
    items.length === 1 && items[0] === 'media', JSON.stringify(items));
}
check('🔴 源码里不出现 microphone 作为权限判据',
  !/permission\s*===\s*['"]microphone['"]/.test(gateSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')));

/* ============ 7. 源码断言：复用 isAppLocalUrl，不另写本地页判定 ============ */
const gateNoComment = gateSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('🔴 闸门复用 isAppLocalUrl（判据单一来源）', gateNoComment.includes('isAppLocalUrl('));
check('🔴 闸门内没有第二份本地页判定（不出现 path.resolve / startsWith 之类）',
  !gateNoComment.includes('startsWith') && !gateNoComment.includes('path.resolve'));
check('🔴 ipc-guard 确实导出了 isAppLocalUrl', /module\.exports\s*=\s*\{[^}]*isAppLocalUrl/.test(ipcGuardSrc));

/* ============ 8. 源码断言：闸门安装在 createWindow() 之前 ============ */
// 🔴 时序是本闸门的关键：装晚了，窗口已经发出的权限请求走的是默认行为。
const gateCallIdx = mainSrc.indexOf('installPermissionGate(session.defaultSession)');
const createWinIdx = mainSrc.indexOf('\n  createWindow();');
check('🔴 installPermissionGate 的调用点存在', gateCallIdx > 0);
check('🔴 闸门安装在 createWindow() 之前（时序防回归）',
  gateCallIdx > 0 && createWinIdx > 0 && gateCallIdx < createWinIdx,
  'gate=' + gateCallIdx + ' create=' + createWinIdx);

// 必须装在 defaultSession（主窗与对话窗共用同一 session，单点收口）
check('🔴 闸门装在 session.defaultSession', mainSrc.includes('installPermissionGate(session.defaultSession)'));

/* ============ 9. main.js 真的从 electron 导入了 session ============ */
const electronImport = mainSrc.match(/const \{([^}]+)\} = require\('electron'\)/);
check('🔴 main.js 从 electron 导入了 session',
  !!electronImport && /\bsession\b/.test(electronImport[1]));

// 且必须真的解构了 isAppLocalUrl（否则闸门里那次调用会 ReferenceError）
check('🔴 main.js 从 ipc-guard 导入了 isAppLocalUrl',
  /const\s*\{[^}]*isAppLocalUrl[^}]*\}\s*=\s*require\('\.\/src\/ipc-guard'\)/.test(mainSrc));

/* ============ 10. 安装失败不阻塞启动（只告警） ============ */
check('🔴 闸门安装失败时只告警、不 throw（不阻塞启动）',
  /if \(!installPermissionGate\(session\.defaultSession\)\) \{[\s\S]{0,200}console\.warn/.test(mainSrc));

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
