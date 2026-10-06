/**
 * 文档一致性测试：README「测试」一节写的项数必须等于实际跑出来的项数。
 *
 * 为什么单独一个测试：v0.5 出现过正文写死的项数明显落后于实际的情况。
 * 靠人记得改数字一定会再犯，所以让测试去数。
 * 顺带检查 README 提到的文件真实存在（改了名忘了改文档也算不一致）。
 *
 * 本文件自己**不**在 README 的测试块里标项数 —— 它会跑其它测试文件，
 * 标了就会被自己回收进清单里跑成递归。
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
let skipped = 0;
const skipList = [];
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
/* SKIP ≠ PASS：环境限制导致本环境无法验证，既不记失败也不冒充通过，
   结尾必须单独汇总，避免「0 FAIL」被误读成「全绿」。 */
function skip(name, reason) {
  console.log('SKIP  ' + name + '  ' + reason);
  skipped++;
  skipList.push(name + ' —— ' + reason);
}

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/* 1. 从 README 的 ```bash 测试块里抓「文件 -> 声称项数」 */
const block = readme.match(/## 测试[\r\n]+```bash[\r\n]+([\s\S]*?)```/);
check('README 有「测试」代码块', !!block);
if (!block) { console.log('\n无法继续'); process.exit(1); }

const claims = [...block[1].matchAll(
  /((?:node|python3)\s+(test\/[\w.-]+))\s*#+\s*(\d+)\s*项/g)]
  .map(m => ({ cmd: m[1].trim(), file: m[2], n: +m[3] }));
check('README 为每个测试文件标了项数', claims.length >= 3, '抓到 ' + claims.length + ' 条');

/* 2. 实际跑一遍，数 PASS */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function startServer(port) {
  const srv = spawn(process.platform === 'win32' ? 'python' : 'python3',
    ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore', detached: false });
  const deadline = Date.now() + 15000;
  const probe = () => new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
  return (async () => {
    while (Date.now() < deadline) {
      if (await probe()) return srv;
      await new Promise(r => setTimeout(r, 200));
    }
    srv.kill();
    throw new Error('静态服务器起不来');
  })();
}

/**
 * 跑一个测试文件并收集它的输出。
 *
 * v1.0修「沙箱假阴性」：原先用 execFileSync（同步版），在部分沙箱环境下
 * spawnSync 会被拦成EBUSY，于是 91 个套件全被报成 FAIL —— 但那不是测试失败，
 * 是环境压根没让跑。真失败与跑不了必须分清，否则门禁会给出虚假安全感。
 *
 * 现在优先用**异步 spawn**（沙箱一般只拦同步 spawn，实测异步可用，能拿到真结果）；
 * 异步不可用时降级 spawnSync；两者都不可用则抛 SPAWN_UNSUPPORTED，
 * 由调用方显式报SKIP，而不是伪装成 91 条 FAIL。
 */
function runViaSpawn(file, env) {
  return (async () => {
    let child;
    try {
      const cmd = await cmdFor(file);
      child = spawn(cmd, [file], {
        cwd: ROOT,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(env || {}) }
      });
    } catch (e) {
      if (e && e.spawnUnsupported) throw e;
      throw makeSpawnUnsupported(e);
    }
    return await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('error', (e) => {
        if (isSpawnUnsupported(e)) reject(makeSpawnUnsupported(e));
        else resolve({ out, code: -1, spawnError: e });
      });
      child.on('close', (code) => resolve({ out, code }));
    });
  })();
}

function isSpawnUnsupported(e) {
  const c = e && e.code;
  return c === 'EBUSY' || c === 'EPERM' || c === 'EACCES' || c === 'ENOSYS';
}

/** .py 走python 解释器，其余走当前 node —— 与旧实现保持一致，别把 py 喂给 node。
 *
 *  v1.0：python 解释器**不再写死 `python`** —— 本机 `python`（托管 3.13.12）里没装
 *  playwright，而 ui_test.py 硬依赖它，直接跑必然 ModuleNotFoundError。
 *  探测顺序：DESKPET_PY 显式指定 → 已知的带playwright 的 venv → 退回 PATH 里的 python。
 *  找不到能跑 playwright 的解释器时返回 null，由调用方报 SKIP（环境限制），
 *  而不是硬跑出一个假 FAIL。 */
function resolvePython() {
  const candidates = [];
  if (process.env.DESPET_PY) candidates.push(process.env.DESPET_PY);
  candidates.push(
    path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default',
      'Scripts', process.platform === 'win32' ? 'python.exe' : 'python'));
  candidates.push(process.platform === 'win32' ? 'python' : 'python3');
  // 顺序探测，第一个能 import playwright 的即采用
  return candidates.reduce((chain, c) => chain.then(async (found) => {
    if (found) return found;
    if (!c) return null;
    return (await hasPlaywright(c)) ? c : null;
  }), Promise.resolve(null));
}

function hasPlaywright(pythonCmd) {
  // 注意：这里**不能**用 execFileSync —— 同步 spawn 在部分沙箱下会被拦成 EBUSY，
  // 那会让「探测」本身假失败（进而误判成没有可用解释器）。
  // 用异步 spawn 探测，语义与 runViaSpawn 一致。
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pythonCmd, ['-c', 'import playwright'], { stdio: 'ignore' });
    } catch (e) {
      resolve(false);
      return;
    }
    let done = false;
    const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
    child.on('error', () => fin(false));
    child.on('close', (code) => fin(code === 0));
    setTimeout(() => { try { child.kill(); } catch (e) {} fin(false); }, 30000).unref?.();
  });
}

let PYTHON_CMD = null;   // 首次用到 .py 时才探测，避免无谓开销
async function cmdFor(file) {
  if (file.endsWith('.py')) {
    if (PYTHON_CMD === null) PYTHON_CMD = (await resolvePython()) || '';
    return PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');
  }
  return process.execPath;
}

function makeSpawnUnsupported(e) {
  const err = new Error('SPAWN_UNSUPPORTED: ' + String((e && e.code) || e));
  err.spawnUnsupported = true;
  return err;
}

async function runViaSpawnSync(file, env) {
  const { spawnSync } = require('child_process');
  const cmd = await cmdFor(file);
  const r = spawnSync(cmd, [file], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(env || {}) }
  });
  if (r.error) {
    if (isSpawnUnsupported(r.error)) throw makeSpawnUnsupported(r.error);
    const e = new Error(String(r.error.message || r.error));
    e.spawnError = r.error;
    throw e;
  }
  return { out: String(r.stdout || '') + String(r.stderr || ''), code: r.status };
}

async function runOne(file, env) {
  try {
    return await runViaSpawn(file, env);
  } catch (e) {
    if (!e.spawnUnsupported) throw e;
    // 异步 spawn 也不可用 → 降级同步；同步再不可用就把 SPAWN_UNSUPPORTED 抛给调用方
    const r = await runViaSpawnSync(file, env);
    if (r.code !== 0) {
      const e = new Error('子进程非零退出: ' + r.code);
      e.nonzeroExit = true;
      e.out = r.out;
      throw e;
    }
    return r;
  }
}

function countPass(out) {
  return {
    pass: (out.match(/^PASS/gm) || []).length,
    fail: (out.match(/^FAIL/gm) || []).length,
  };
}

(async () => {
  // ui_test.py 需要静态服务器；在这里替它起一个，用 DESKPET_URL 告诉它地址。
  // 手工跑时它仍默认用 127.0.0.1:8000，不依赖本文件。
  const needsServer = claims.some(c => c.file.endsWith('.py'));
  let srv = null, url = null;
  if (needsServer) {
    try {
      const port = await freePort();
      srv = await startServer(port);
      url = 'http://127.0.0.1:' + port;
      check('能为 ui_test 起一个临时静态服务器', true, url);
    } catch (e) {
      check('能为 ui_test 起一个临时静态服务器', false, e.message);
    }
  }

  for (const c of claims) {
    const self = path.join(ROOT, c.file) === __filename;
    if (self) {
      check('README 没把 docs.test.js 标项数（否则会递归跑自己）', false);
      continue;
    }
    let out = '';
    let runError = null;
    try {
      const r = await runOne(c.file, c.file.endsWith('.py') && url
        ? { DESKPET_URL: url } : null);
      out = r.out;
      if (r.code !== 0) {
        // 子进程真的跑完了但非零退出 —— 这是真失败，交给下面的项数/FAIL 判定
        runError = new Error('子进程非零退出: ' + r.code);
      }
    } catch (e) {
      runError = e;
      out = String((e && e.out) || e.stdout || '');
      // 沙箱禁止 spawn —— 跑不了就是跑不了，不算测试失败，明确报 SKIP
      if (e && e.spawnUnsupported) {
        skip(c.file, '环境禁止子进程 spawn（' + String(e.message).replace(/^SPAWN_UNSUPPORTED: /, '') + '），无法在本环境验证');
        continue;
      }
      // 依赖缺失（典型是 ui_test.py 缺 playwright）也是环境问题，不是测试失败
      if (/ModuleNotFoundError|No module named/i.test(out)) {
        skip(c.file, '缺少 Python 依赖（' + (out.match(/No module named ['"]?[\w.]+/i) || ['?'])[0] + '），无法在本环境验证');
        continue;
      }
      if (!out.trim()) {
        check(c.file + ' 能跑通', false, String((e && e.message) || e).slice(0, 120));
        continue;
      }
    }
    const r = countPass(out);
    check(c.file + ' 全绿（0 项 FAIL）', r.fail === 0 && !runError, runError ? '子进程非零退出: ' + String(runError.message || runError).slice(0, 100) : ('FAIL=' + r.fail));
    check(c.file + ' 项数与 README 一致', r.pass === c.n,
      'README 写 ' + c.n + '，实际 ' + r.pass);
  }

  /* 3. README 点名的文件都存在（运行期产物除外） */
  // 这些写在 userData 里，仓库里本来就没有；README 提它们是说明存储位置。
  const RUNTIME = new Set(['life-config.json', 'life-key', 'gpt-girl-config.json', 'gpt-girl-key', 'wardrobe.json', 'self-ledger.json', 'experiences.jsonl', 'subject-state.json', 'stats.json', 'memory.json']);
  const walk = (dir, acc) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc); else acc.add(path.relative(ROOT, p));
    }
    return acc;
  };
  const allFiles = walk(ROOT, new Set());
  const mentioned = new Set();
  for (const m of readme.matchAll(/`((?:src|test|tools|assets)\/[\w./-]*\.(?:js|py|css|html|json|png))`/g)) {
    mentioned.add(m[1]);                                   // 带路径的按路径查
  }
  for (const m of readme.matchAll(/`([\w-]+\.(?:js|py|html|css|json|md))`/g)) {
    if (!RUNTIME.has(m[1]) && ![...allFiles].some(f => path.basename(f) === m[1])) {
      mentioned.add(m[1]);                                 // 裸文件名：项目里任何位置有就算数
    }
  }
  const missing = [...mentioned].filter(f => !fs.existsSync(path.join(ROOT, f)));
  check('README 点名的文件都真实存在', missing.length === 0, missing.join(', '));

  /* 4. 测试目录里的文件都得在 README 出现过 —— 不然等于没写文档 */
  const listed = fs.readdirSync(path.join(ROOT, 'test'))
    .filter(f => /\.(js|py)$/.test(f) && f !== path.basename(__filename))
    .filter(f => !readme.includes(f));
  check('test/ 下每个测试都在 README 里被点名', listed.length === 0, listed.join(', '));

  if (srv) srv.kill();
  if (skipped) {
    console.log('\n---- 跳过明细（环境限制，非测试失败）----');
    skipList.forEach(s => console.log('  ' + s));
  }
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过')
    + (skipped ? '（另有 ' + skipped + ' 项因环境限制跳过，未验证）' : ''));
  process.exit(failures ? 1 : 0);
})();
