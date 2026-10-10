/**
 * 原子写测试 —— 断电/进程被杀时不能把记忆写坏。
 *
 * 关注三件事：
 *   1. 内容正确（含中文、含 Buffer 二进制）
 *   2. 不留下临时文件
 *   3. 写失败时旧内容必须还在（这才是用它的唯一理由）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, writeJsonAtomic, _internals: _i } = require('../src/atomic');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-atomic-'));
const f = (n) => path.join(dir, n);
const leftOver = () => fs.readdirSync(dir).filter(x => x.includes('.tmp-'));

/* 1. 基本读写 */
writeFileAtomic(f('a.txt'), Buffer.from('hello'));
check('普通写入内容正确', fs.readFileSync(f('a.txt'), 'utf8') === 'hello');
check('写入后目录里没有残留临时文件', leftOver().length === 0, leftOver().join(','));

/* 2. 覆盖已存在文件（Windows 上 rename 不覆盖的话这里就红） */
writeFileAtomic(f('a.txt'), Buffer.from('world'));
check('可覆盖已存在文件', fs.readFileSync(f('a.txt'), 'utf8') === 'world');

/* 3. 中文与多字节必须逐字节正确 */
const zh = JSON.stringify({ 记忆: '用户叫小明，住在杭州' });
writeFileAtomic(f('b.json'), Buffer.from(zh, 'utf8'));
check('中文内容无损', fs.readFileSync(f('b.json'), 'utf8') === zh);

/* 4. 二进制（safeStorage 密文就是 Buffer，不能被转成字符串） */
const bin = Buffer.from([0, 1, 2, 0xff, 0xfe, 128, 0]);
writeFileAtomic(f('k'), bin);
check('二进制按字节写入且长度一致',
  Buffer.compare(fs.readFileSync(f('k')), bin) === 0 && fs.statSync(f('k')).size === bin.length);

/* 5. 空内容也要真的清空（memory 清空后就是这种） */
writeFileAtomic(f('k'), Buffer.alloc(0));
check('空 Buffer 写入得到零字节文件', fs.statSync(f('k')).size === 0);

/* 6. JSON helper */
writeJsonAtomic(f('c.json'), { n: 1, s: '银白发尾' });
check('writeJsonAtomic 产出可解析且格式化过的 JSON',
  JSON.parse(fs.readFileSync(f('c.json'), 'utf8')).s === '银白发尾'
  && fs.readFileSync(f('c.json'), 'utf8').includes('\n  "n"'));

/* 7. 写中途失败：旧内容必须还在，临时文件必须被清掉 */
const target = f('d.json');
writeJsonAtomic(target, { v: 'old' });
const realWrite = fs.writeFileSync;
fs.writeFileSync = () => { throw new Error('模拟磁盘写失败'); };
let threw = false;
try { writeJsonAtomic(target, { v: 'new' }); } catch { threw = true; }
fs.writeFileSync = realWrite;
check('写入失败时抛出而不是静默', threw);
check('写入失败后旧文件内容完好', fs.readFileSync(target, 'utf8').includes('old'));
check('写入失败时临时文件已清理', leftOver().length === 0, leftOver().join(','));

/* 8. 失败之后模块没有坏状态，仍能正常写 */
try {
  writeJsonAtomic(f('e.json'), { ok: true });
  check('失败后仍能正常写入', JSON.parse(fs.readFileSync(f('e.json'), 'utf8')).ok === true);
} catch (e) {
  check('失败后仍能正常写入', false, e.message);
}

/* 9. Windows 瞬态 EPERM：rename 失败几次后必须自己重试成功
   （杀毒/索引器短暂持有句柄是最常见的偶发写失败，不该丢整份记忆） */
{
  const tgt = f('win.json');
  writeJsonAtomic(tgt, { v: 'old' });
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (a, b) => {
    calls++;
    if (calls <= 2) { const e = new Error('模拟占用'); e.code = 'EPERM'; throw e; }
    return realRename(a, b);
  };
  let ok = true, err = '';
  try { writeJsonAtomic(tgt, { v: 'new' }); } catch (e) { ok = false; err = e.message; }
  fs.renameSync = realRename;
  check('rename 遇瞬态 EPERM 会自动重试到成功',
    ok && JSON.parse(fs.readFileSync(tgt, 'utf8')).v === 'new', err);
  check('重试次数有限（不会无限打转）', calls === 3, 'calls=' + calls);
  check('重试成功后不留临时文件', leftOver().length === 0, leftOver().join(','));
}

/* 10. 权限类硬错误重试无用，必须照原样抛出 —— 吞掉它才是更难查的 bug */
{
  const tgt = f('hard.json');
  writeJsonAtomic(tgt, { v: 'old' });
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => { calls++; const e = new Error('只读目录'); e.code = 'EROFS'; throw e; };
  let code = '';
  try { writeJsonAtomic(tgt, { v: 'new' }); } catch (e) { code = e.code; }
  fs.renameSync = realRename;
  check('非瞬态错误不重试且原样抛出', code === 'EROFS' && calls === 1, 'code=' + code + ' calls=' + calls);
  check('非瞬态错误后旧内容仍在', fs.readFileSync(tgt, 'utf8').includes('old'));
  check('非瞬态错误也清掉了临时文件', leftOver().length === 0, leftOver().join(','));
}

/* 11. 临时文件名带随机后缀：交叠写入不会撞同一个 tmp */
{
  const a1 = _i.tmpNameFor(f('x.json')), a2 = _i.tmpNameFor(f('x.json'));
  check('连续两次生成的临时名不同', a1 !== a2);
  check('临时名与目标同目录（跨目录 rename 不是原子的）',
    path.dirname(a1) === path.dirname(f('x.json')));
  check('临时名是隐藏文件且以 .tmp- 结尾模式',
    path.basename(a1).startsWith('.x.json.tmp-'), path.basename(a1));
}

/* 12. 生产源码静态审计：main.js 的 saveChatBounds 必须使用 writeJsonAtomic 写入 chat-window.json */
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const chatSaveUsesAtomic = mainSrc.includes('writeJsonAtomic') &&
    /saveChatBounds[\s\S]*?writeJsonAtomic/.test(mainSrc) &&
    !/saveChatBounds[\s\S]*?fs\.writeFileSync/.test(mainSrc);
  check('main.js saveChatBounds 使用 writeJsonAtomic 确保原子写', chatSaveUsesAtomic);
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录交给系统 */ }
process.exit(failures ? 1 : 0);
