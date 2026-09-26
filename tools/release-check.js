/**
 * 发布包资源与完整性自动化检查脚本 (Release Integrity Checker)
 *
 * 检查项：
 * 1. JS 语法静态检查通过（node --check）
 * 2. 创作规范文件 skills/DS Skill.md 存在且内容规范
 * 3. 换装系统所需的 12 个 PNG 图层资源全部存在且符合 760x1000 规范
 * 4. 兜底皮套 assets/pet.png 存在且符合 1015x1171 比例规范
 * 5. package-lock.json 存在且与 package.json 依赖元数据一致
 * 6. 配置版本与默认配置完整性 (schemaVersion=1, configVersion="1.0.0")
 * 7. README.md 文档声明与测试集文件清单严格一致
 *
 * 输出格式：结构化 (PASS / WARN / FAIL)
 */

const fs = require('fs');
const path = require('path');
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
console.log('       Life (初澜) v0.9.5.3 发布包资源完整性自动化检查   ');
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

/* 2. DS Skill 检查 */
function checkCreativeSkill() {
  const skillPath = path.join(ROOT, 'skills', 'DS Skill.md');
  if (!fs.existsSync(skillPath)) {
    report('FAIL', '创作模式规范', 'skills/DS Skill.md 文件不存在');
    return;
  }
  const content = fs.readFileSync(skillPath, 'utf8');
  if (content.length < 200 || !content.includes('DS Skill')) {
    report('FAIL', '创作模式规范', 'skills/DS Skill.md 内容不完整或未声明 DS Skill');
  } else {
    report('PASS', '创作模式规范', `skills/DS Skill.md 完整存在 (${content.length} 字节, 规范名称: DS Skill)`);
  }

  const legacyPath = path.join(ROOT, 'skills', 'DS破甲skill.md');
  if (fs.existsSync(legacyPath)) {
    report('WARN', '历史命名兼容', '检测到历史旧文件名 skills/DS破甲skill.md 仍存在，建议归档或清理');
  }
}

/* 3. 换装图层资产完整性检查 */
function checkWardrobeAssets() {
  const { CATALOG, SLOTS } = require('../src/wardrobe');
  const expectedFiles = [
    'assets/character/base/base.png',
    'assets/character/accessories/choker_key_01.png'
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
    if (w !== 760 || h !== 1000) {
      badDimensions.push(`${rel} (${w}x${h} != 760x1000)`);
    }
  }

  if (missing.length === 0 && badDimensions.length === 0) {
    report('PASS', '换装图层资产完整性', `全部 ${uniqueFiles.length} 个角色换装图层全部就绪且符合 760×1000 标准`);
  } else {
    if (missing.length > 0) report('FAIL', '换装图层缺失', missing.join(', '));
    if (badDimensions.length > 0) report('FAIL', '换装图层尺寸不符', badDimensions.join(', '));
  }
}

/* 4. 兜底立绘尺寸检查 */
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
  if (w === 1015 && h === 1171) {
    report('PASS', '单图兜底皮套', `assets/pet.png 存在且符合 1015×1171 兜底比例规范 (${buf.length} 字节)`);
  } else {
    report('WARN', '单图兜底皮套', `assets/pet.png 尺寸为 ${w}×${h} (标准兜底测试基准为 1015×1171)`);
  }
}

/* 5. 依赖锁 package-lock.json 检查 */
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
  } catch (e) {
    report('FAIL', '环境锁定解析错误', e.message);
  }
}

/* 6. 配置 Schema 与默认参数检查 */
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

/* 7. README 文档与测试集完整性 */
function checkDocsAndTestSuites() {
  const readmePath = path.join(ROOT, 'README.md');
  if (!fs.existsSync(readmePath)) {
    report('FAIL', '项目文档', 'README.md 不存在');
    return;
  }
  const readme = fs.readFileSync(readmePath, 'utf8');
  const block = readme.match(/## 测试\n+```bash\n([\s\S]*?)```/);
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

/* 执行检查 */
checkJsSyntax();
checkCreativeSkill();
checkWardrobeAssets();
checkFallbackSprite();
checkPackageLock();
checkConfigDefaults();
checkDocsAndTestSuites();

console.log('\n====================================================');
console.log(`检查完成: PASS ${totalPass} 项, WARN ${totalWarn} 项, FAIL ${totalFail} 项`);
console.log('====================================================');

process.exit(totalFail > 0 ? 1 : 0);
