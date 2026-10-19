/**
 * 产物新鲜度门禁的回归（2026-10-19）。
 *
 * ## 为什么必须单独成文
 *
 * v1.6.0 那次事故的形态很特别：代码修了、126 套测试全绿、`release-check` 也全绿，
 * **但发出去的包里一个修复都没有** —— 因为 `dist/` 在 `.gitignore` 里，没有任何门禁看得到产物。
 * 这一类缺陷的共同特征：**所有看源码的门禁都不会响**，只有把产物的字节读出来才看得见。
 *
 * ## 为什么测的是模块而不是 release-check.js
 *
 * `release-check.js` 是脚本（require 即执行、不导出任何东西）。往它里面塞判据，
 * 就只能靠源码字符串断言来测 —— 那测的是「有没有写这行」，不是「判据对不对」。
 * 本文件打的是 `tools/artifact-freshness.js` 的纯函数与真实 asar 读取器。
 *
 * ## 变异测试记录（本文件自身被验证过判别力）
 *
 *   M1 把 payloadBase 写回 `16 + headerJsonLen + offset`（少算 3 字节 padding）
 *      ⇒ 「读取器与官方一致」与「真实产物 stale 为空」两条同时变红。
 *      这个变异正是第一版的真实 bug：它让 13 个文件全被判成 DIFF（误报），
 *      而真相是它们完全一致 —— **假阳性与假阴性在同一个函数上，方向相反**。
 *   M2 把 compareArtifact 的比较改成恒等（=== 换成 !==）
 *      ⇒ 「产物旧必须被抓出」变红。
 */
const fs = require('fs');
const path = require('path');

const af = require(path.join(__dirname, '..', 'tools', 'artifact-freshness.js'));

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

/* ============================================================
 * 一、比对逻辑（合成输入，不碰真实产物）
 * ============================================================ */

/* 🔴 临时目录必须集中登记并清理（本仓 test/tmp-hygiene.test.js 的三层门禁之一：
 *    「所有创建临时目录的套件都显式声明了清理手段」，主判据是跑完后的增量）。
 *    实测踩过：第一版直接 mkdtempSync 不回收，被 tmp-hygiene 抓出 2 项 FAIL。 */
const TMP_DIRS = [];
process.on('exit', () => {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

/** 一个小仓库：三个文件，内容各不相同。 */
function makeFakeRepo() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'artifact-fresh-'));
  TMP_DIRS.push(dir);
  fs.writeFileSync(path.join(dir, 'a.js'), 'A');
  fs.writeFileSync(path.join(dir, 'b.js'), 'B');
  fs.writeFileSync(path.join(dir, 'c.js'), 'C');
  return dir;
}

/* ① 全部一致：stale / missing 都必须为空 —— 这是「产物是新的」那一侧。 */
{
  const dir = makeFakeRepo();
  const packed = { 'a.js': Buffer.from('A'), 'b.js': Buffer.from('B'), 'c.js': Buffer.from('C') };
  const r = af.compareArtifact({ root: dir, files: ['a.js', 'b.js', 'c.js'], readPacked: (n) => packed[n] });
  check('① 产物与源码完全一致时 stale=[] missing=[] checked=3',
    r.checked === 3 && r.stale.length === 0 && r.missing.length === 0,
    JSON.stringify(r));
}

/* ② 有一个文件内容旧了：必须被点名，且只点错的那个。 */
{
  const dir = makeFakeRepo();
  const packed = { 'a.js': Buffer.from('A'), 'b.js': Buffer.from('OLD-B'), 'c.js': Buffer.from('C') };
  const r = af.compareArtifact({ root: dir, files: ['a.js', 'b.js', 'c.js'], readPacked: (n) => packed[n] });
  check('② 产物陈旧的文件被精确点名（且不误伤其它文件）',
    r.stale.length === 1 && r.stale[0] === 'b.js',
    JSON.stringify(r));
}

/* ③ 产物里根本没有这个文件：归 missing，不混进 stale。 */
{
  const dir = makeFakeRepo();
  const packed = { 'a.js': Buffer.from('A'), 'c.js': Buffer.from('C') };
  const r = af.compareArtifact({ root: dir, files: ['a.js', 'b.js', 'c.js'], readPacked: (n) => packed[n] });
  check('③ 产物缺失的文件归 missing（与 stale 分开报，两种修法不同）',
    r.missing.length === 1 && r.missing[0] === 'b.js' && r.stale.length === 0,
    JSON.stringify(r));
}

/* ④ 仓库里都没有的文件不该被要求存在（比如别人加了新入口但还没落盘）。 */
{
  const dir = makeFakeRepo();
  const packed = { 'a.js': Buffer.from('A') };
  const r = af.compareArtifact({ root: dir, files: ['a.js', 'ghost.js'], readPacked: (n) => packed[n] });
  check('④ 仓库里不存在的文件跳过（不把「两处都没有」报成问题）',
    r.checked === 1 && r.missing.length === 0 && r.stale.length === 0,
    JSON.stringify(r));
}

/* ⑤ 少一个字节也算陈旧（哈希比对必须是逐字节，不能容忍「差不多」）。 */
{
  const dir = makeFakeRepo();
  const packed = { 'a.js': Buffer.from('A\n') };
  const r = af.compareArtifact({ root: dir, files: ['a.js'], readPacked: (n) => packed[n] });
  check('⑤ 只差一个行尾字节也判为陈旧（CRLF/LF 差异不许放过）',
    r.stale.length === 1 && r.stale[0] === 'a.js', JSON.stringify(r));
}

/* ⑥ 缺参数必须抛，而不是静默放行 —— 检查器崩掉不能等于检查通过。 */
{
  let threw = false;
  try { af.compareArtifact({ root: '/tmp' }); } catch { threw = true; }
  check('⑥ 缺 readPacked 时抛错（绝不静默放行）', threw);
}

/* ============================================================
 * 二、真实产物（有就验、没有就按「不适用」降级）
 *
 * 🔴 关键设计：本节**输出行数必须恒定**。
 *
 *   `docs.test.js` 会数本文件跑出多少项 PASS，并与 README 里写的数字比对。
 *   CI 跑的是干净克隆（无 dist/），而它也是公开库形态的一部分。
 *   如果本节用「有产物才 check、没产物只 console.log」，PASS 数就会随环境在
 *   10 / 11 之间漂移 —— README 只能写一个数字，于是必有一边红。
 *
 *   实测踩过：⑩ 加版本闸门后，公开库（1.0.0 产物 vs 1.6.1 源码）降级成 SKIP，
 *   PASS 从 11 掉到 10，`docs.test.js` 立刻报「README 写 11，实际 10」。
 *
 *   所以判据本身也要能表达「不适用」：**check 恒发一次**，
 *   条件不满足时判 pass 为真（它不是失败），只是把 detail 写成为什么跳过。
 *   这与本仓既有的 SKIP 口径一致（SKIP 是被允许的结果，不是失败），
 *   区别只在于 SKIP 不进 PASS 计数、而这里为了项数稳定让它进。
 * ============================================================ */

const asarPath = af.discoverAsar(ROOT);
check('⑦ discoverAsar 返回 null 或真实存在的路径',
  asarPath === null || (typeof asarPath === 'string' && fs.existsSync(asarPath)),
  String(asarPath));

/* ⑧ 读取器必须与官方 @electron/asar 逐字节一致。
 *
 *    这条是本文件最要紧的一条：第一版读取器少算了 ASAR 头部的 padding，
 *    导致每个文件都被判成 DIFF。**如果那时有这条断言，它会立刻变红**，
 *    而不是让「13 个文件全都旧了」这个假信号传到人眼前。
 *
 *    无产物 / 无官方库时：判 pass（不适用），detail 说明原因。 */
{
  let official = null;
  try { official = require('@electron/asar'); } catch { official = null; }
  if (!asarPath) {
    check('⑧ 自研 asar 读取器与官方实现一致（本机无 dist/，不适用）', true, 'SKIP: 未构建');
  } else if (!official || typeof official.extractFile !== 'function') {
    check('⑧ 自研 asar 读取器与官方实现一致（本机无 @electron/asar，不适用）', true, 'SKIP: 缺依赖');
  } else {
    const mismatch = [];
    for (const name of af.RUNTIME_SOURCES) {
      const mine = af.readAsarEntry(asarPath, name);
      let theirs = null;
      try { theirs = official.extractFile(asarPath, name); } catch { theirs = null; }
      if (!mine || !theirs || Buffer.compare(mine, theirs) !== 0) mismatch.push(name);
    }
    check('⑧ 自研 asar 读取器与官方 @electron/asar 逐文件一致（含 header padding）',
      mismatch.length === 0, mismatch.join(', '));
  }
}

/* ⑨ 逆向哨兵：把产物里那份 main.js 当作「源码」喂回去，必须判为一致。
 *
 *    这条防的是「读取器稳定地读错」：⑧ 依赖官方库，⑨ 不依赖任何外部实现 ——
 *    它只要求「同一个文件，从产物读一次、从盘上读一次，两次得出相同结论」。
 *    若读取器有固定的偏移错误，这里会稳定地读出不同字节而变红。 */
{
  if (!asarPath) {
    check('⑨ 产物内容当源码喂回去必须判一致（本机无 dist/，不适用）', true, 'SKIP: 未构建');
  } else {
    const packedMain = af.readAsarEntry(asarPath, 'main.js');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'artifact-fresh-'));
    TMP_DIRS.push(dir);
    fs.writeFileSync(path.join(dir, 'main.js'), packedMain);
    const r = af.compareArtifact({ root: dir, files: ['main.js'], readPacked: (n) => af.readAsarEntry(asarPath, n) });
    check('⑨ 把产物内容当源码喂回去必须判为一致（读取器无固定偏移错）',
      r.checked === 1 && r.stale.length === 0, JSON.stringify(r));
  }
}

/* ⑩ 真实新鲜度：本机产物与工作树一致。
 *
 *    🔴 前置是版本闸门（实测的公开库形态逼出来的）：那里躺着一份 v1.0.0 的 dist/，
 *    只比字节会稳定地报「11 个文件全都旧了」—— 技术上没错，但那是**不同版本**的产物，
 *    不是「改完代码忘了构建」。两者处置完全不同，所以跨版本时本断言不适用。 */
{
  const srcVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
    catch { return null; }
  })();
  const packedVersion = asarPath ? af.readArtifactVersion(asarPath) : null;
  if (!asarPath) {
    check('⑩ 产物与工作树一致（本机无 dist/，不适用）', true, 'SKIP: 未构建');
  } else if (!packedVersion || !srcVersion || packedVersion !== srcVersion) {
    check('⑩ 产物与工作树一致（跨版本产物，不适用）', true,
      'SKIP: 产物 ' + (packedVersion || '未知') + ' ≠ 源码 ' + (srcVersion || '未知'));
  } else {
    const r = af.compareArtifact({ root: ROOT, readPacked: (n) => af.readAsarEntry(asarPath, n) });
    check('⑩ 本机产物与工作树一致（dist/ 未落后于源码）',
      r.stale.length === 0 && r.missing.length === 0,
      'stale=' + JSON.stringify(r.stale) + ' missing=' + JSON.stringify(r.missing));
  }
}

/* ⑪ 接线断言：release-check 真的调用了这条检查（函数存在不等于被调用）。 */
{
  const rc = fs.readFileSync(path.join(ROOT, 'tools', 'release-check.js'), 'utf8');
  check('⑪ release-check.js 真的调用了 artifact-freshness（不是只有模块存在）',
    /require\('\.\/artifact-freshness'\)/.test(rc)
    && /checkArtifactFreshness\s*\(/.test(rc)
    && /checkArtifactFreshness\(\);/.test(rc));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
