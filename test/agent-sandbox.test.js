/**
 * test/agent-sandbox.test.js
 *
 * v1.0 D-5：沙盒目录定位与创建门禁。
 *
 * 🔴 为什么要单独测这个模块（2026-10-06 审核补记）：
 *   D-5 起写权限**真正放开**了（此前是三重默认关闭，执行器动不了任何文件）。
 *   `agent-sandbox.js` 决定「能动哪些路径」，它若判错一次就是真实的越界写入，
 *   所以不能只靠 agent_ipc 的间接覆盖 —— 必须对这个模块单独锁死。
 *
 * 覆盖的三条边界，每条都对应一个真实风险：
 *   ① 空/非字符串 desktop 路径必须抛错，不能静默解析成 cwd
 *      （cwd 若是 D:\GAME\LIFE，整个仓库就变成可写沙盒）；
 *   ② mkdir 失败必须抛错，绝不静默降级（否则写权限会泄漏到沙盒之外）；
 *   ③ 同名**文件**存在时必须抛错（mkdirSync 遇同名文件不报错就返回，
 *      这是个真实的坑，不查statSync 会以为沙盒可用）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 2 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});
const { sandboxPathFor, ensureSandboxDir, SANDBOX_DIR_NAME, SANDBOX_NOTICE } =
  require('../src/agent-sandbox');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '' : '') + (extra ? '  ' + extra : '')); }
}

console.log('--- D-5 Agent 沙盒门禁 ---');

/* ---------- 1. 路径定位 ---------- */
{
  const p = sandboxPathFor('C:\\Users\\andab\\Desktop');
  check('桌面路径正确落到 Desktop/LifeSandbox 子目录',
    p === path.join('C:\\Users\\andab\\Desktop', 'LifeSandbox')
    || p.endsWith(path.join('Desktop', SANDBOX_DIR_NAME)), p);

  check('沙盒目录名固定为 LifeSandbox', SANDBOX_DIR_NAME === 'LifeSandbox', SANDBOX_DIR_NAME);

  // 🔴 反例1：空路径绝不能静默回落成 cwd。
  //   path.resolve('') === process.cwd()，若这里放过，沙盒就等于整个工作目录。
  let threw = false;
  let got = null;
  try { got = sandboxPathFor(''); } catch (e) { threw = true; }
  check('❌ 反例1 空 desktop 路径必须抛错（不得回落成 cwd=工作目录）',
    threw === true && got === null, 'threw=' + threw + ' got=' + got);

  let threw2 = false;
  try { sandboxPathFor(null); } catch (e) { threw2 = true; }
  check('❌ 反例2 null desktop 路径必须抛错', threw2 === true);

  // 反例3：非字符串（数字）不得被当成路径拼接。
  let threw3 = false;
  try { sandboxPathFor(123); } catch (e) { threw3 = true; }
  check('❌ 反例3 非字符串 desktop 路径必须抛错', threw3 === true);
}

/* ---------- 2. 创建目录 ---------- */
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-t1-'));
  const target = sandboxPathFor(base);

  const out = ensureSandboxDir(target);
  check('创建成功返回该目录绝对路径', out === target, out);
  check('目录确实已落盘且是目录',
    fs.existsSync(target) && fs.statSync(target).isDirectory());

  // 幂等：已存在再调一次不得抛错（每次启动 main.js 都会调）。
  let threw = false;
  try { ensureSandboxDir(target); } catch (e) { threw = true; }
  check('重复创建幂等不抛错（每次启动都会调用）', threw === false);
}

/* ---------- 3. 失败必须抛错，绝不静默降级 ---------- */
{
  // 🔴 反例4：mkdir 失败必须抛错。
  //   若这里被吞掉，policy 的 scopeRoots 拿到一个不存在的目录，
  //   后续要么写到别处（越界），要么每次执行都失败（用户以为 Agent 坏了）。
  const fakeFs = {
    mkdirSync() { const e = new Error('EPERM: denied'); e.code = 'EPERM'; throw e; },
    statSync() { return { isDirectory: () => true }; },
  };
  let threw = false; let code = null;
  try { ensureSandboxDir('/whatever/sandbox', fakeFs); } catch (e) { threw = true; code = e.code; }
  check('❌ 反例4 mkdir 失败必须抛错且带 SANDBOX_UNAVAILABLE（绝不静默降级）',
    threw === true && code === 'SANDBOX_UNAVAILABLE', 'threw=' + threw + ' code=' + code);

  // 反例5：空目录路径必须抛错。
  let threw5 = false;
  try { ensureSandboxDir(''); } catch (e) { threw5 = true; }
  check('❌ 反例5 空目录路径必须抛错', threw5 === true);

  // 🔴 反例6：同名**文件**存在时必须抛错。
  //   这是真实坑：fs.mkdirSync(path, {recursive:true}) 遇到同名普通文件时
  //   **不会抛错就返回**（只在非递归且路径是文件时才抛）。不 statSync 的话
  //   ensureSandboxDir 会以为沙盒已就绪，后续写入行为不可预期。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-t2-'));
  const asFile = path.join(base, SANDBOX_DIR_NAME);
  fs.writeFileSync(asFile, 'I am a file, not a directory', 'utf8');

  let threw6 = false; let code6 = null;
  try { ensureSandboxDir(asFile); } catch (e) { threw6 = true; code6 = e.code; }
  check('❌ 反例6 同名普通文件存在时必须抛错（mkdirSync 不报错是真实坑）',
    threw6 === true && code6 === 'SANDBOX_UNAVAILABLE',
    'threw=' + threw6 + ' code=' + code6 + ' 是不是文件=' + (fs.existsSync(asFile) && !fs.statSync(asFile).isDirectory()));
}

/* ---------- 4. 用户可见约定 ---------- */
{
  check('沙盒覆写约定文案存在且点明「可被 Agent 覆写」',
    typeof SANDBOX_NOTICE === 'string'
    && SANDBOX_NOTICE.includes('覆写')
    && SANDBOX_NOTICE.includes('重要文件'), SANDBOX_NOTICE);
}

console.log('--- D-5 Agent 沙盒门禁：'
  + pass + ' 通过 / ' + fail + ' 失败 ---');

process.exit(fail === 0 ? 0 : 1);