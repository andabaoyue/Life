/**
 * 发布产物 ASAR 运行时闭包检查 (Runtime Closure Checker)
 *
 * ## 为什么必须有这个脚本
 *   npm test 与 test/ui_test.py 都在**工作树**里跑，验不到最终产物。
 *   2026-10 的独立审计实测过一次真实事故：electron-builder.yml 的 files 白名单
 *   列着不存在的 renderer.js，却漏掉 preload.js / pet.js / chat.html / chat.js
 *   与 6 个 ui-*.js —— 打出来的包里主进程在、渲染入口全缺：主窗拿不到
 *   contextBridge 暴露的 API、页面脚本 404、对话窗打不开，
 *   **而当时所有门禁（含 npm test）全绿**。
 *
 * ## 它检查什么（对真实 app.asar）
 *   1. 必需运行入口必须存在 —— 缺一即 FAIL；
 *   2. 源码专用目录与文档不得进包 —— test/ tools/ research/ dist/ *.md；
 *   3. 已淘汰的历史大图不得进包 —— character-archive-760x1000 / base_legacy_full。
 *
 * ## 用法
 *   node tools/asar-check.js                  # 自动在 dist 下查找 resources/app.asar
 *   node tools/asar-check.js <path/app.asar>  # 指定产物
 *   退出码：0 = 全过；1 = 存在 FAIL（CI 据此拦截）
 *
 * ⚠️ CI 上跑的是 --dir --linux 目录包：本脚本验的是**文件闭包**，与平台无关；
 *    它不验 Windows 安装包本身，别当成「打包验证」的替代。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 必需运行入口（与 main.js / index.html / chat.html 的真实加载链一致） ----------
   改这里之前先读 electron-builder.yml 的 files 段与两个 HTML 的 <script> 标签：
   这份清单是「产物里必须有的东西」，不是「仓库里有什么」。 */
const REQUIRED_FILES = [
  'main.js',          // 主进程入口（package.json main）
  'preload.js',       // 两个窗口共用的 contextBridge 桥
  'index.html',       // 主窗页面
  'chat.html',        // 独立对话窗页面
  'style.css',        // 样式与动画
  'pet.js',           // 桌宠渲染层
  'chat.js',          // 对话窗交互层
  'ui-i18n.js',
  'ui-chat-store.js',
  'ui-chat-render.js',
  'ui-provider-presets.js',
  'ui-outfit-complete.js',
  'ui-agent-confirm.js',
  'package.json'
];
const REQUIRED_DIRS = ['src', 'assets'];
/* 源码专用内容：进包就是打包泄漏（体积、或把研究材料/内测文档发给用户） */
const FORBIDDEN_PREFIXES = ['test/', 'tools/', 'research/', 'dist/'];
/* 已淘汰资产：v1.0 像素换代后不再被任何代码引用，不该出现在任何分发包里 */
const RETIRED_PATTERNS = [/character-archive-760x1000/, /base_legacy_full/];

let pass = 0, fail = 0;
function report(status, title, detail = '') {
  console.log((status === 'PASS' ? 'PASS  ' : 'FAIL  ') + '[' + title + ']' + (detail ? ' ' + detail : ''));
  if (status === 'PASS') pass++; else fail++;
}

/** 在 dist/ 下递归找首个 resources/app.asar */
function discoverAsar() {
  const distDir = path.join(ROOT, 'dist');
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

/** asar 清单在 Windows 用反斜杠且带前导分隔符，统一成 posix 相对路径 */
function normalizeList(list) {
  return list.map((p) => String(p).replace(/\\/g, '/').replace(/^\/+/, ''));
}

/** 零依赖原生读取 ASAR 包头文件清单（内置兜底，确保无 @electron/asar 时亦可秒级运行） */
function readAsarFileList(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const headerSize = sizeBuf.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 16);
    const header = JSON.parse(headerBuf.toString('utf8'));
    const files = [];
    function walk(node, curPath) {
      if (node && node.files) {
        for (const [name, child] of Object.entries(node.files)) {
          walk(child, curPath ? curPath + '/' + name : name);
        }
      } else {
        files.push(curPath);
      }
    }
    walk(header, '');
    return files;
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  console.log('====================================================');
  console.log('       Life 发布产物 ASAR 运行时闭包检查     ');
  console.log('====================================================\n');

  const argPath = process.argv[2];
  const asarPath = argPath ? path.resolve(argPath) : discoverAsar();
  if (!asarPath || !fs.existsSync(asarPath)) {
    report('FAIL', '产物定位', argPath
      ? '指定路径不存在: ' + argPath
      : 'dist/ 下找不到 resources/app.asar —— 请先构建：npx electron-builder --dir');
    return finish();
  }
  console.log('产物: ' + path.relative(ROOT, asarPath) + '\n');

  let entries;
  try {
    let asar = null;
    try { asar = require('@electron/asar'); } catch {}
    if (asar && typeof asar.listPackage === 'function') {
      entries = normalizeList(asar.listPackage(asarPath));
      report('PASS', '检查器依赖', '@electron/asar 已就绪');
    } else {
      entries = normalizeList(readAsarFileList(asarPath));
      report('PASS', '检查器依赖', '零依赖内置 ASAR 解析器就绪');
    }
  } catch (e) {
    report('FAIL', '产物解析', 'app.asar 无法解析: ' + e.message);
    return finish();
  }
  const set = new Set(entries);

  // 1. 必需运行入口
  const missing = REQUIRED_FILES.filter((f) => !set.has(f));
  if (missing.length) report('FAIL', '必需运行入口', '产物内缺失 ' + missing.length + ' 个: ' + missing.join(', '));
  else report('PASS', '必需运行入口', REQUIRED_FILES.length + ' 个入口全部在产物内');

  // 2. 必需目录非空（src/**、assets/** 在白名单里是通配，需确认真的打进去了）
  const emptyDirs = [];
  for (const d of REQUIRED_DIRS) {
    const n = entries.filter((p) => p.indexOf(d + '/') === 0).length;
    if (n === 0) emptyDirs.push(d);
    else report('PASS', '运行时目录 ' + d + '/', n + ' 个条目');
  }
  if (emptyDirs.length) report('FAIL', '运行时目录缺失', emptyDirs.join(', ') + ' 在产物内为空');

  // 3. 源码专用内容不得进包
  const leaked = entries.filter((p) => FORBIDDEN_PREFIXES.some((pre) => p.indexOf(pre) === 0) || p.endsWith('.md'));
  if (leaked.length) report('FAIL', '打包泄漏', leaked.length + ' 个源码/文档条目进包: ' + leaked.slice(0, 8).join(', ') + (leaked.length > 8 ? ' …' : ''));
  else report('PASS', '打包泄漏', 'test/ tools/ research/ dist/ 与 *.md 均未进包');

  // 4. 已淘汰资产不得进包
  const retired = entries.filter((p) => RETIRED_PATTERNS.some((re) => re.test(p)));
  if (retired.length) report('FAIL', '淘汰资产', retired.length + ' 个已淘汰条目仍进包: ' + retired.slice(0, 6).join(', ') + (retired.length > 6 ? ' …' : ''));
  else report('PASS', '淘汰资产', '760×1000 归档层与 base_legacy_full 均未进包');

  report('PASS', '产物规模', entries.length + ' 个条目');
  return finish();
}

function finish() {
  console.log('\n====================================================');
  console.log('检查完成: PASS ' + pass + ' 项, FAIL ' + fail + ' 项');
  console.log('====================================================');
  process.exit(fail ? 1 : 0);
}

main();
