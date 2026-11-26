/**
 * 产物与源码一致性检查（Artifact Freshness）
 *
 * ## 为什么需要这个模块
 *
 * 2026-10-19 实测事故：`v1.6.0` 的三个安装包构建于 10-18 21:02，而调度自愈与失败可见性
 * 两批修复是 10-19 白天才落的。代码修了、测试全绿、`release-check` 也全绿 ——
 * **因为没有任何门禁看得到产物**。
 *
 * 根因是结构性的：`dist/` 在 `.gitignore` 里，所以：
 *   · 干净克隆里根本没有 dist/，任何「产物检查」都必须能在它缺席时放行；
 *   · 而一旦 dist/ 存在且陈旧，所有工作树级门禁都发现不了 ——
 *     它们看的是源码，用户装的是 asar。
 *
 * 这一条把「产物里那份 main.js 是不是仓库里这份」变成可判定的：
 * 逐文件 SHA-256 比对。它**只报 WARN 不报 FAIL**，因为：
 *   · 干净克隆 / 刚 clone 未构建 → 无产物，本就该放行；
 *   · 「源码比产物新」是发布前的正常中间态，不该让日常 `npm test` 变红，
 *     但**必须在发布检查里被看见**。
 *
 * ## 为什么独立成模块而不是塞进 release-check.js
 *
 * `release-check.js` 是脚本（require 即执行、不导出任何东西），塞进去就只能靠
 * 源码字符串断言来测 —— 那测的是「有没有写这行」，不是「判据对不对」。
 * 这里的判据要能拿合成输入逐条钉住：产物缺文件、产物旧、产物一致，三种方向都要验。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 参与比对的文件：与 `electron-builder.yml` 的 files 白名单里、
 * 存在于仓库根目录的那批运行入口同源。
 *
 * ⚠️ **刻意排除 package.json**：electron-builder 会给产物造一份「发布用 manifest」，
 *    剔掉 `scripts` / `devDependencies`。它进包后**必然**与仓库里那份不同字节，
 *    拿它做哈希比对等于给一条永真的噪声断言。版本一致性由另一条检查负责
 *    （`版本唯一来源` / 门面版本对齐），这里只管代码。
 */
const RUNTIME_SOURCES = Object.freeze([
  'main.js',
  'preload.js',
  'index.html',
  'chat.html',
  'style.css',
  'pet.js',
  'chat.js',
  'ui-i18n.js',
  'ui-chat-store.js',
  'ui-chat-render.js',
  'ui-provider-presets.js',
  'ui-outfit-complete.js',
  'ui-agent-confirm.js',
  'vision-picker-preload.js',
  'vision-picker.html',
  'vision-picker.js'
]);

const RUNTIME_DIRS = Object.freeze(['src']);

/** 递归收集运行目录（如 src/）下的 .js 相对 POSIX 路径，用于补充 RUNTIME_SOURCES 新鲜度比对。 */
function collectRuntimeDirFiles(root, dirs = RUNTIME_DIRS) {
  const collected = [];
  for (const dirRel of (Array.isArray(dirs) ? dirs : [])) {
    const startDir = path.join(root, dirRel);
    if (!fs.existsSync(startDir)) continue;
    const stack = [startDir];
    while (stack.length) {
      const cur = stack.shift();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile() && ent.name.endsWith('.js')) {
          collected.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    }
  }
  return collected.sort();
}

/** 递归扫描运行目录（src 下所有 .js）的最新 mtimeMs，便于识别「改动 src 忘重打 asar」。 */
function getLatestRuntimeDirMtimeMs(root, dirs = RUNTIME_DIRS) {
  let latestMtimeMs = 0;
  let latestFile = null;
  let fileCount = 0;
  for (const rel of collectRuntimeDirFiles(root, dirs)) {
    try {
      const st = fs.statSync(path.join(root, rel));
      fileCount++;
      if (st.mtimeMs > latestMtimeMs) {
        latestMtimeMs = st.mtimeMs;
        latestFile = rel;
      }
    } catch {}
  }
  return { latestMtimeMs, latestFile, fileCount };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 从 app.asar 里取出一个根级文件的字节内容。
 *
 * 为什么自己解析而不 require('@electron/asar')：本仓 `tools/` 的既定风格是零依赖
 * （见 public-export.js 的 globToRe 注释）。而且这条检查要在**干净克隆**里也能跑，
 * 不该因为 devDependency 没装就静默失效 —— 「检查器崩掉」与「检查不设防」一样危险。
 *
 * ## ⚠️ 位置计算（实测踩过，别再改错）
 *
 * ASAR 的文件内容是**紧接着头部**的，但头部**有 padding**：JSON 之后补到 4 字节对齐。
 * 第一版按 `16 + headerSize + offset` 算，实测比官方读数早 3 字节 ——
 * 于是每个文件都被判成 DIFF（误报 13 处），而真相是它们完全一致。
 *
 * 正确基准是 `8 + u32@4`：ASAR 包头是
 *   [0..4)   固定为 4（pickle 长度字段自身的长度）
 *   [4..8)   头部 pickle 的 payload 长度（含 padding）
 *   [8..)    JSON 头部（实际 JSON 比它短几字节的 padding）
 * 所以文件内容的绝对起点 = 8 + u32@4。用 ceil4(16 + u32@12) 也能得到同一个数，
 * 这里取前者，因为它直接就是格式定义，不依赖「padding 一定补到 4 的倍数」这个推论。
 *
 * @param {string} asarPath
 * @param {string} name 根级文件名（如 'main.js'）
 * @returns {?Buffer} 取不到返回 null（不存在 / 解析失败都算取不到）
 */
function readAsarEntry(asarPath, name) {
  let fd = null;
  try {
    fd = fs.openSync(asarPath, 'r');
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const pickleLen = sizeBuf.readUInt32LE(4);       // 头部 pickle payload 长度（含 padding）
    const headerJsonLen = sizeBuf.readUInt32LE(12);  // 纯 JSON 的长度
    const headerBuf = Buffer.alloc(headerJsonLen);
    fs.readSync(fd, headerBuf, 0, headerJsonLen, 16);
    const header = JSON.parse(headerBuf.toString('utf8'));

    // P1-17：支持嵌套路径（如 'src/brain.js'）逐级在 ASAR header.files 中寻址
    const parts = String(name || '').replace(/\\/g, '/').split('/').filter(Boolean);
    let node = header;
    for (const seg of parts) {
      node = (node && node.files) ? node.files[seg] : null;
      if (!node) break;
    }
    if (!node || node.files || node.link) return null;   // 目录 / 符号链接都不算
    const offset = Number(node.offset);
    const size = Number(node.size);
    if (!Number.isFinite(offset) || !Number.isFinite(size)) return null;

    const payloadBase = 8 + pickleLen;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, payloadBase + offset);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * 读产物内 package.json 的版本号。
 *
 * ## 为什么新鲜度判定必须先看版本
 *
 * 实测（公开库工作树）：那里躺着一份 **v1.0.0 时代**的 `dist/`，而源码已经是 1.6.x。
 * 若只比字节，它会稳定地报「11 个文件全都旧了」—— 技术上没错，但那是**不同版本**的
 * 产物，不是「忘记重新打包」。两者的处置完全不同：
 *   · 同版本但字节不同 ⇒ 改完代码忘了构建（本门禁要抓的正是这个）；
 *   · 跨版本           ⇒ 这是历史残留，根本不该参与比对。
 *
 * 所以：产物版本 ≠ 工作树版本时，调用方应判定「不适用」，而不是报陈旧。
 *
 * @returns {?string} 取不到（无该文件 / 解析失败）返回 null
 */
function readArtifactVersion(asarPath) {
  const buf = readAsarEntry(asarPath, 'package.json');
  if (!buf) return null;
  try {
    const pj = JSON.parse(buf.toString('utf8'));
    return (pj && typeof pj.version === 'string' && pj.version.trim()) ? pj.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 比对产物与工作树。
 *
 * @param {object} opts
 * @param {string} opts.root 工作树根目录
 * @param {(name: string) => ?Buffer} opts.readPacked 从产物里取文件的函数（测试可注入）
 * @param {string[]} [opts.files] 参与比对的文件（默认 RUNTIME_SOURCES）
 * @returns {{checked:number, stale:string[], missing:string[]}}
 *   stale = 产物里那份与工作树字节不一致；missing = 产物里根本没有这个文件
 */
function compareArtifact({ root, readPacked, files, runtimeDirs } = {}) {
  if (typeof readPacked !== 'function') throw new Error('readPacked is required');
  const explicitFiles = Array.isArray(files) && files.length ? files : null;
  const list = explicitFiles
    ? explicitFiles
    : [...RUNTIME_SOURCES, ...collectRuntimeDirFiles(root, runtimeDirs || RUNTIME_DIRS)];
  const stale = [];
  const missing = [];
  let checked = 0;
  for (const name of list) {
    let srcBuf = null;
    try { srcBuf = fs.readFileSync(path.join(root, name)); } catch { continue; }   // 仓库里都没有，不归这条管
    const packed = readPacked(name);
    if (!packed) { missing.push(name); continue; }
    checked++;
    if (sha256(packed) !== sha256(srcBuf)) stale.push(name);
  }
  return { checked, stale, missing };
}

/**
 * 在 dist/ 下递归找首个 resources/app.asar。
 * 找不到返回 null（未构建 / 已清理都属正常路径，调用方据此放行）。
 */
function discoverAsar(root) {
  const distDir = path.join(root, 'dist');
  if (!fs.existsSync(distDir)) return null;
  const stack = [distDir];
  while (stack.length) {
    const dir = stack.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === 'app.asar' && path.basename(dir) === 'resources') return full;
    }
  }
  return null;
}

module.exports = {
  RUNTIME_SOURCES,
  RUNTIME_DIRS,
  collectRuntimeDirFiles,
  getLatestRuntimeDirMtimeMs,
  sha256,
  readAsarEntry,
  readArtifactVersion,
  compareArtifact,
  discoverAsar
};

if (require.main === module) {
  const strict = process.argv.includes('--strict');
  const root = path.resolve(__dirname, '..');
  const asarPath = discoverAsar(root);
  if (!asarPath) {
    if (strict) {
      console.error('FAIL: 未找到 dist/app.asar (--strict)');
      process.exit(1);
    }
    console.log('SKIP: 未找到 dist/app.asar');
    process.exit(0);
  }
  let srcVer = null;
  try { srcVer = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch {}
  const packedVer = readArtifactVersion(asarPath);
  if (!packedVer || !srcVer || packedVer !== srcVer) {
    const msg = `产物版本(${packedVer || 'unknown'}) != 源码版本(${srcVer || 'unknown'})`;
    if (strict) {
      console.error('FAIL (--strict): ' + msg);
      process.exit(1);
    }
    console.log('SKIP: ' + msg);
    process.exit(0);
  }
  const res = compareArtifact({ root, readPacked: (name) => readAsarEntry(asarPath, name) });
  if (res.missing.length || res.stale.length || (strict && res.checked === 0)) {
    console.error(`FAIL: checked=${res.checked} missing=${JSON.stringify(res.missing)} stale=${JSON.stringify(res.stale)}`);
    process.exit(1);
  }
  console.log(`PASS: artifact-freshness checked=${res.checked} stale=0 missing=0`);
}
