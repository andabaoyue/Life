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
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/* 1. 从 README 的 ```bash 测试块里抓「文件 -> 声称项数」 */
const block = readme.match(/## 测试\n+```bash\n([\s\S]*?)```/);
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

async function runOne(file, env) {
  const isPy = file.endsWith('.py');
  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  return execFileSync(isPy ? pyCmd : process.execPath,
    [file],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(env || {}) } });
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
    try {
      out = await runOne(c.file, c.file.endsWith('.py') && url
        ? { DESKPET_URL: url } : null);
    } catch (e) {
      out = String((e && e.stdout) || '');
      if (!out.trim()) {
        check(c.file + ' 能跑通', false, String((e && e.message) || e).slice(0, 120));
        continue;
      }
    }
    const r = countPass(out);
    check(c.file + ' 全绿（0 项 FAIL）', r.fail === 0, 'FAIL=' + r.fail);
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
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
