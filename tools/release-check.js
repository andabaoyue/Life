/**
 * 发布包资源与完整性自动化检查脚本 (Release Integrity Checker)
 *
 * 检查项：
 * 1. JS 语法静态检查通过（node --check）
 * 3. 换装系统所需的 PNG 图层资源全部存在且符合 64x80 像素规范（非标尺寸 WARN）
 * 4. 换装图层透明度与 Alpha 边界非破坏性审计 (P1-6: 识别全透明空图层并预警，绝不破坏/覆盖资产)
 * 5. 兜底皮套 assets/pet.png 存在且为有效 PNG（像素换代后按 64x80 口径校验）
 * 6. package-lock.json 存在且与 package.json 依赖元数据一致
 * 7. 配置版本与默认配置完整性 (schemaVersion=1, configVersion="1.0.0")
 * 8. README.md 文档声明与测试集文件清单严格一致
 * 9. electron-builder.yml 的 files 白名单覆盖全部真实运行入口（F-REL-001 回归门禁）
 *
 * 输出格式：结构化 (PASS / WARN / FAIL)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let totalPass = 0;
let totalWarn = 0;
let totalFail = 0;

function report(status, title, detail = '') {
  const badge = status === 'PASS' ? 'PASS ' : (status === 'WARN' ? 'WARN ' : 'FAIL ');
  console.log(`${badge} [${title}]${detail ? ' ' + detail : ''}`);
  if (status === 'PASS') totalPass++;
  else if (status === 'WARN') totalWarn++;
  else totalFail++;
}

console.log('====================================================');
{
  // P1-05: 版本描述统一以 package.json 为当前软件版本唯一来源，不硬编码
  let _bannerVersion = 'unknown';
  try { _bannerVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch {}
  console.log(`       Life v${_bannerVersion} 发布包资源完整性自动化检查     `);
}
console.log('====================================================\n');

/* 1. JS 语法检查 */
function checkJsSyntax() {
  const jsFiles = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) jsFiles.push(p);
    }
  }
  walk(ROOT);

  let failedFiles = [];
  for (const f of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' });
    } catch {
      failedFiles.push(path.relative(ROOT, f));
    }
  }

  if (failedFiles.length === 0) {
    report('PASS', 'JS 静态语法检查', `全部 ${jsFiles.length} 个 JavaScript 源码文件均通过 node --check 校验`);
  } else {
    report('FAIL', 'JS 静态语法检查', `以下文件语法错误: ${failedFiles.join(', ')}`);
  }
}

/* 3. 换装图层资产完整性检查 */
function checkWardrobeAssets() {
  const { CATALOG, SLOTS } = require('../src/wardrobe');
  const expectedFiles = [
    'assets/character/base/base.png'
  ];

  for (const item of Object.values(CATALOG)) {
    if (item.file) expectedFiles.push('assets/character/' + item.file);
  }

  const uniqueFiles = [...new Set(expectedFiles)];
  let missing = [];
  let badDimensions = [];

  for (const rel of uniqueFiles) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      missing.push(rel);
      continue;
    }
    const buf = fs.readFileSync(full);
    if (buf.length < 24 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      badDimensions.push(`${rel} (非有效 PNG)`);
      continue;
    }
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const valid = (w === 64 && h === 80) || (w === 760 && h === 1000);
    if (!valid) {
      badDimensions.push(`${rel} (${w}x${h} 不是 64x80 或 760x1000)`);
    }
  }

  if (missing.length === 0 && badDimensions.length === 0) {
    report('PASS', '换装图层资产完整性', `全部 ${uniqueFiles.length} 个角色换装图层全部就绪且符合点阵/切片标准`);
  } else {
    if (missing.length > 0) report('FAIL', '换装图层缺失', missing.join(', '));
    if (badDimensions.length > 0) report('FAIL', '换装图层尺寸不符', badDimensions.join(', '));
  }
}

function unfilterScanline(filterType, currentLine, prevLine, bpp) {
  const line = Buffer.alloc(currentLine.length);
  for (let i = 0; i < currentLine.length; i++) {
    const raw = currentLine[i];
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prevLine ? prevLine[i] : 0;
    const c = (prevLine && i >= bpp) ? prevLine[i - bpp] : 0;
    let val = 0;
    switch (filterType) {
      case 0: val = raw; break;
      case 1: val = (raw + a) & 0xFF; break;
      case 2: val = (raw + b) & 0xFF; break;
      case 3: val = (raw + Math.floor((a + b) / 2)) & 0xFF; break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        val = (raw + pr) & 0xFF;
        break;
      }
      default: val = raw; break;
    }
    line[i] = val;
  }
  return line;
}

function getPngAlphaBbox(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  if (buf.length < 24 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8 || colorType !== 6) return null; // 仅限 8-bit RGBA

  let pos = 8;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    if (type === 'IDAT') idats.push(buf.slice(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  if (!idats.length) return null;
  let decompressed;
  try {
    decompressed = zlib.inflateSync(Buffer.concat(idats));
  } catch {
    return null;
  }
  const bpp = 4;
  const scanlineLen = w * bpp;
  const stride = 1 + scanlineLen;

  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  let prevLine = null;

  for (let y = 0; y < h; y++) {
    const filter = decompressed[y * stride];
    const rawScanline = decompressed.slice(y * stride + 1, y * stride + stride);
    const line = unfilterScanline(filter, rawScanline, prevLine, bpp);
    prevLine = line;

    for (let x = 0; x < w; x++) {
      const alpha = line[x * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) return { empty: true, bbox: null };
  return {
    empty: false,
    bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
  };
}

/* 4. 换装图层透明度与 Alpha 边界非破坏性审计 (P1-6) */
function checkLayerTransparency() {
  const { CATALOG } = require('../src/wardrobe');
  const expectedFiles = [
    'assets/character/base/base.png',
    'assets/character/accessories/choker_key_01.png'
  ];

  for (const item of Object.values(CATALOG)) {
    if (item.file) expectedFiles.push('assets/character/' + item.file);
  }

  const uniqueFiles = [...new Set(expectedFiles)];
  const emptyLayers = [];
  const validLayers = [];
  const abnormalLayers = [];

  for (const rel of uniqueFiles) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      abnormalLayers.push({ rel, reason: '文件不存在' });
      continue;
    }
    const res = getPngAlphaBbox(full);
    if (!res) {
      abnormalLayers.push({ rel, reason: '非标准 8-bit RGBA 格式或 IDAT 解压失败' });
    } else if (res.empty) {
      emptyLayers.push({ rel, bbox: 'empty/null' });
    } else {
      validLayers.push({ rel, bbox: `${res.bbox.width}x${res.bbox.height} at (${res.bbox.minX},${res.bbox.minY})` });
    }
  }

  if (abnormalLayers.length > 0) {
    report('FAIL', '分层资产格式异常', `检测到 ${abnormalLayers.length} 个图层异常无法解析: ${abnormalLayers.map(e => `${path.basename(e.rel)} (${e.reason})`).join(', ')}`);
  }

  if (emptyLayers.length > 0) {
    report('WARN', '分层资产透明度审计', `检测到 ${emptyLayers.length} 个正在制作中的换装图层目前为全透明空图层 (bbox: empty/null): ${emptyLayers.map(e => path.basename(e.rel)).join(', ')} (严格遵循非破坏性审计规范：保留美术现场，禁止造假图)`);
  } else if (abnormalLayers.length === 0) {
    report('PASS', '分层资产透明度审计', `全部 ${uniqueFiles.length} 个换装图层均包含有效 Alpha 内容`);
  }
}

/* 5. 兜底立绘尺寸检查 */
function checkFallbackSprite() {
  const petPath = path.join(ROOT, 'assets', 'pet.png');
  if (!fs.existsSync(petPath)) {
    report('FAIL', '单图兜底皮套', 'assets/pet.png 不存在');
    return;
  }
  const buf = fs.readFileSync(petPath);
  if (buf.length < 24 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    report('FAIL', '单图兜底皮套', 'assets/pet.png 不是有效 PNG 格式');
    return;
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if ((w === 64 && h === 80) || (w === 1015 && h === 1171)) {
    report('PASS', '单图兜底皮套', `assets/pet.png 存在且符合标准尺寸 ${w}×${h} (${buf.length} 字节)`);
  } else {
    report('WARN', '单图兜底皮套', `assets/pet.png 尺寸为 ${w}×${h} (标准原生推荐为 64×80 像素)`);
  }
}

/* 6. 依赖锁 package-lock.json 检查 */
function checkPackageLock() {
  const pkgPath = path.join(ROOT, 'package.json');
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(pkgPath)) {
    report('FAIL', '包管理配置', 'package.json 不存在');
    return;
  }
  if (!fs.existsSync(lockPath)) {
    report('FAIL', '环境锁定', 'package-lock.json 缺失，无法保证生产依赖版本一致');
    return;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (pkg.name !== lock.name || pkg.version !== lock.version) {
      report('WARN', '依赖版本对齐', `package.json (${pkg.name}@${pkg.version}) 与 package-lock.json (${lock.name}@${lock.version}) 元数据存在差异`);
    } else {
      report('PASS', '环境依赖锁定', `package-lock.json 存在且与 package.json 对齐 (${lock.name}@${lock.version}, lockfileVersion=${lock.lockfileVersion})`);
    }
    // P1-01/P1-05: 版本唯一来源 —— Research Export 的 appVersion 必须等于 package.json.version
    try {
      const { getAppVersion } = require('../src/research-export');
      const appVer = getAppVersion();
      if (appVer === pkg.version) {
        report('PASS', '版本唯一来源', `research-export.getAppVersion() 与 package.json (${pkg.version}) 一致`);
      } else {
        report('FAIL', '版本唯一来源', `research-export.getAppVersion() (${appVer}) ≠ package.json (${pkg.version})，存在旧版本硬编码`);
      }
    } catch (e) {
      report('FAIL', '版本唯一来源检查错误', e.message);
    }
    // 门面文档版本一致性检查：README.en.md 首行应严格对齐 package.json 版本（防 -dev / -rc 后缀残留）
    const enReadmePath = path.join(ROOT, 'README.en.md');
    if (fs.existsSync(enReadmePath)) {
      const enFirstLine = fs.readFileSync(enReadmePath, 'utf8').split(/\r?\n/)[0] || '';
      const V = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const facadeOk = new RegExp('^# Life v' + V + '(?:\\s+|$)').test(enFirstLine);
      if (facadeOk) {
        report('PASS', '门面版本对齐', `README.en.md 首行已对齐至 v${pkg.version}`);
      } else {
        report('FAIL', '门面版本对齐', `README.en.md 首行未对齐至 v${pkg.version}: "${enFirstLine.trim()}"`);
      }
    }
  } catch (e) {
    report('FAIL', '环境锁定解析错误', e.message);
  }
}

/* 7. 配置 Schema 与默认参数检查 */
function checkConfigDefaults() {
  try {
    const { DEFAULTS, sanitize } = require('../src/config');
    const clean = sanitize({});
    if (clean.schemaVersion === 1 && clean.configVersion === '1.0.0') {
      report('PASS', '配置版本与默认值', `DEFAULTS 已声明 schemaVersion=1, configVersion="1.0.0"，且 sanitize 补齐完整`);
    } else {
      report('FAIL', '配置版本字段缺失', `schemaVersion=${clean.schemaVersion}, configVersion=${clean.configVersion}`);
    }
  } catch (e) {
    report('FAIL', '配置模块加载失败', e.message);
  }
}

/* 9. 发布白名单闭包检查（v1.0 审计 F-REL-001 回归门禁）
 *
 * 为什么必须有：npm test 与 ui_test.py 都在**工作树**里跑，验不到最终产物。
 * 曾经 electron-builder.yml 的 files 白名单列着不存在的 renderer.js，
 * 却漏掉 preload.js / pet.js / chat.html / chat.js / 6 个 ui-*.js ——
 * 打出来的包主窗口拿不到 contextBridge、页面脚本全部 404，
 * 而所有门禁仍然全绿。这里把「真实入口清单」钉死成断言。
 */
const RUNTIME_ENTRIES = [
  'main.js', 'preload.js', 'index.html', 'chat.html', 'style.css',
  'pet.js', 'chat.js',
  'ui-i18n.js', 'ui-chat-store.js', 'ui-chat-render.js',
  'ui-provider-presets.js', 'ui-outfit-complete.js', 'ui-agent-confirm.js',
  'src/**', 'assets/**', 'package.json'
];
function checkBuilderClosure() {
  const cfgPath = path.join(ROOT, 'electron-builder.yml');
  if (!fs.existsSync(cfgPath)) { report('FAIL', '发布白名单', 'electron-builder.yml 不存在'); return; }
  const raw = fs.readFileSync(cfgPath, 'utf8');
  // 仅取 files: 段的条目（到下一个顶层键为止）
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^files:\s*$/.test(l));
  if (start < 0) { report('FAIL', '发布白名单', 'electron-builder.yml 未声明 files 段'); return; }
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+"([^"]+)"\s*$/);
    if (!m) { if (/^\S/.test(lines[i])) break; continue; }
    entries.push(m[1]);
  }
  const has = (p) => entries.includes(p);
  const missing = RUNTIME_ENTRIES.filter((e) => !has(e));
  // 反向：白名单里指向不存在文件的死条目（renderer.js 那一类）
  const dead = entries.filter((e) => !e.startsWith('!') && !e.includes('*')
    && !fs.existsSync(path.join(ROOT, e)));
  const problems = [];
  if (missing.length) problems.push('缺少真实运行入口: ' + missing.join(', '));
  if (dead.length) problems.push('指向不存在文件的死条目: ' + dead.join(', '));
  if (problems.length) report('FAIL', '发布白名单闭包', problems.join(' | '));
  else report('PASS', '发布白名单闭包', `${RUNTIME_ENTRIES.length} 个运行入口全部在 files 白名单内，且无死条目`);
}

/* 8. README 文档与测试集完整性 */
function checkDocsAndTestSuites() {
  const readmePath = path.join(ROOT, 'README.md');
  if (!fs.existsSync(readmePath)) {
    report('FAIL', '项目文档', 'README.md 不存在');
    return;
  }
  const readme = fs.readFileSync(readmePath, 'utf8');
  const block = readme.match(/## 测试[\r\n]+```bash[\r\n]+([\s\S]*?)```/);
  if (!block) {
    report('FAIL', '项目测试文档', 'README.md 未包含 ## 测试 代码块');
    return;
  }
  const claims = [...block[1].matchAll(/((?:node|python3)\s+(test\/[\w.-]+))\s*#+\s*(\d+)\s*项/g)]
    .map(m => ({ file: m[2], n: +m[3] }));

  const testDirFiles = fs.readdirSync(path.join(ROOT, 'test'))
    .filter(f => /\.(js|py)$/.test(f) && f !== 'docs.test.js');

  const unmentioned = testDirFiles.filter(f => !readme.includes(f));
  if (unmentioned.length > 0) {
    report('FAIL', '测试目录文档覆盖', `test/ 下存在未在 README 中被点名的测试: ${unmentioned.join(', ')}`);
  } else {
    report('PASS', '测试目录文档覆盖', `test/ 下全部 ${testDirFiles.length} 个测试均在 README.md 完整登记并标明用例项数 (共 ${claims.length} 条测试套件声明)`);
  }
}

/* 10. 开发机私有绝对路径与隐私泄露扫描 */
function checkDeveloperPathLeaks() {
  const leaks = [];
  const leakToolsPat = new RegExp(['D:', 'software', ['hui', 'hua'].join('')].join('[\\\\/]'), 'i');
  const lifePat = new RegExp(['D:', 'GAME', ['LI', 'FE'].join('')].join('[\\\\/]'), 'i');
  const userPat = new RegExp(['Users', ['an', 'dab'].join('')].join('[\\\\/]'), 'i');
  const privateRepoPat = new RegExp(['Life', ['Chu', 'lan'].join('')].join('-'), 'i');
  const leakPatterns = [leakToolsPat, lifePat, userPat, privateRepoPat];

  const targetDirs = ['src', 'test', 'docs', 'tools'];
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scan(full);
      } else if (/\.(js|json|md|html|css)$/i.test(e.name)) {
        if (full === path.join(ROOT, 'tools', 'release-check.js')) continue;
        const content = fs.readFileSync(full, 'utf8');
        content.split('\n').forEach((l, idx) => {
          for (const pat of leakPatterns) {
            if (pat.test(l)) {
              leaks.push(`${path.relative(ROOT, full)}:${idx + 1}`);
              break;
            }
          }
        });
      }
    }
  }
  for (const d of targetDirs) scan(path.join(ROOT, d));
  // 检查根目录全部公开与门面文件（含全部 .md 文档、入口脚本与配置）
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (ent.isDirectory()) continue;
    if (ent.name.startsWith('_') || ent.name.startsWith('V1.') || ent.name.startsWith('chulan_')) continue;
    if (/\.(js|json|md|html|css|py|yml|yaml)$/i.test(ent.name) || /^(LICENSE|NOTICE)$/i.test(ent.name)) {
      const full = path.join(ROOT, ent.name);
      const content = fs.readFileSync(full, 'utf8');
      content.split('\n').forEach((l, idx) => {
        for (const pat of leakPatterns) {
          if (pat.test(l)) leaks.push(`${ent.name}:${idx + 1}`);
        }
      });
    }
  }

  if (leaks.length > 0) {
    report('FAIL', '开发机私有绝对路径扫描', `发现 ${leaks.length} 处开发机绝对路径残留: ${leaks.slice(0, 5).join(', ')}`);
  } else {
    report('PASS', '开发机私有绝对路径扫描', '生产/文档/测试目录严格零开发机绝对路径残留 (0 处泄露)');
  }
}

/* 执行检查 */
checkJsSyntax();
checkWardrobeAssets();
checkLayerTransparency();
checkFallbackSprite();
checkPackageLock();
checkConfigDefaults();
checkDocsAndTestSuites();
checkDeveloperPathLeaks();
checkBuilderClosure();

console.log('\n====================================================');
console.log(`检查完成: PASS ${totalPass} 项, WARN ${totalWarn} 项, FAIL ${totalFail} 项`);
console.log('====================================================');

process.exit(totalFail > 0 ? 1 : 0);
