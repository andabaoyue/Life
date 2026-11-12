/**
 * test/d20-self-note-persist.test.js
 *
 * D-20 门禁：她写过的东西**活过重启**。
 *
 * ## 为什么有这一轮（真实事故）
 *   她写下第一张便签 → 进内存队列 → 之后**从未再开口**
 *   → `_drainSelfNotes()` 从未执行 → 进程退出 ⇒ **那条记忆永久丢失**。
 *   桌面文件还在，但她对它的认知归零。
 *
 *   更根本的一层：`save()` 只序列化 `this.data`，而 `selfNotes` 当时挂在
 *   `this` 上（`this.data` **外面**）—— **即使调了 save() 也存不进去**。
 *
 * ## 三条铁律（违反即打回）
 *   1. 绝不进 system、绝不改写 history —— 破坏前缀缓存（命中率会掉）
 *   2. 绝不伪装成 assistant 消息 —— 那是伪造她说过的话（persona.js:26）
 *   3. 标注不催她回应 —— 撞 persona.js:29「装可怜不行」
 *
 * ## 覆盖的三类反例
 *   ① 漏传参数：空内容 / 非字符串 —— 一律拒收且不抛、不落盘
 *   ② 恶意变体：超长 / 灌爆 / 绝对路径泄漏 —— 不许进她的意识
 *   ③ 边界值：上限口径（含已注入）/ 旧档案无字段 / 脏数据
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
const _d20Dirs = [];
const _d20OrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d20OrigMkdtemp.apply(fs, a);
  _d20Dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d20Dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d20OrigMkdtemp;
});

const { Memory } = require('../src/memory');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'd20-')); }
function freshMem(dir) { return new Memory(dir || freshDir(), { persona: 'P' }); }
function withHistory(m, text) {
  m.data.history = [{ role: 'user', content: text || '我回来了', messageId: 'm1' }];
  return m.build('');
}
const flat = (msgs) => msgs.map((x) => String(x.content)).join('\n');

console.log('--- D-20 自述持久化门禁 ---');

/* ============ 1. 🔴 核心：写下即落盘（不等防抖） ============ */
{
  const dir = freshDir();
  const m = freshMem(dir);
  m.addSelfNote({ content: '她写的第一句', name: 'a.txt' });
  // 不 flush、不等 3 秒 —— 直接读磁盘。这是本轮的核心：必须已经在盘上。
  const raw = fs.readFileSync(path.join(dir, 'memory.json'), 'utf8');
  check('🔴 写下即落盘（不等 3 秒防抖）', raw.includes('她写的第一句'));
  const saved = JSON.parse(raw).selfNotes;
  check('落盘结构含 drained 标记', Array.isArray(saved) && saved[0].drained === false);
  check('落盘结构含 at', typeof saved[0].at === 'number' && saved[0].at > 0);
}

/* ============ 2. 🔴 核心：活过重启 ============ */
{
  const dir = freshDir();
  const m1 = freshMem(dir);
  m1.addSelfNote({ content: '跨重启的一句', name: 'b.txt' });
  // 模拟进程退出后重新拉起（新实例，从磁盘 load）
  const m2 = freshMem(dir);
  check('🔴 重启后内容仍在（本轮修的就是这个）',
    m2.data.selfNotes.length === 1 && m2.data.selfNotes[0].content === '跨重启的一句');
  check('🔴 重启后仍是待注入状态', m2.pendingSelfNotes().length === 1);
}

/* ============ 3. 一次性语义不变，只是实现从「删」变「标记」 ============ */
{
  const dir = freshDir();
  const m = freshMem(dir);
  m.addSelfNote({ content: '只该出现一次' });
  const first = flat(withHistory(m));
  const second = flat(withHistory(m));
  check('🔴 第一次注入', first.includes('只该出现一次'));
  check('🔴 第二次不再注入（一次性语义未变）', !second.includes('只该出现一次'));
  check('🔴 内容**没有**被删（旧版是物理清空）', m.data.selfNotes.length === 1);
  check('🔴 drained 已置 true', m.data.selfNotes[0].drained === true);
  check('待注入项归零', m.pendingSelfNotes().length === 0);
}

/* ============ 4. 🔴 铁律：history 一个字节不动 ============ */
{
  const m = freshMem();
  m.addSelfNote({ content: '安静里没有需要填满的东西。' });
  // ⚠️ 快照必须拍在 history **赋值之后、build 之前**。
  //   第一版拍在 withHistory 之前（那时 history 还是空数组），
  //   于是断言比较的是「空 vs 有一条」—— 看起来像实现改了 history，实际是断言写错。
  m.data.history = [{ role: 'user', content: '我回来了', messageId: 'm1' }];
  const before = JSON.stringify(m.data.history);
  const msgs = m.build('');
  const after = JSON.stringify(m.data.history);
  check('🔴 history 字节完全未变', before === after, before + ' vs ' + after);
  check('🔴 history 里不含注入文本', !after.includes('你之前写下过'));
  check('history 条数未增加', m.data.history.length === 1);
  check('注入只出现在本次请求的 msgs 里', flat(msgs).includes('你之前写下过'));
  // 反向对照：注入确实发生了，否则上面是空断言
  check('🔴 反向对照：注入确实存在', flat(msgs).includes('安静里没有需要填满的东西'));
}

/* ============ 5. 反例①：坏值拒收且**不落盘** ============ */
{
  const dir = freshDir();
  const m = freshMem(dir);
  m.addSelfNote({ content: '先写一条正常的' });
  const cases = [
    ['空对象', {}], ['空串', { content: '' }], ['纯空白', { content: '   \n  ' }],
    ['null', { content: null }], ['数字', { content: 123 }], ['数组', { content: [1] }],
    ['对象', { content: { a: 1 } }], ['undefined 入参', undefined], ['null 入参', null],
  ];
  let threw = false, accepted = [];
  cases.forEach(([label, input]) => {
    try { if (m.addSelfNote(input) === true) accepted.push(label); } catch (e) { threw = true; }
  });
  check('❌ 反例：坏值一律拒收', accepted.length === 0, accepted.join('/'));
  check('❌ 反例：坏值不抛异常', !threw);
  check('❌ 反例：坏值不污染已落盘数据', m.data.selfNotes.length === 1);
}

/* ============ 6. 反例②：超长 / 灌爆 / 路径泄漏 ============ */
{
  const m = freshMem();
  check('❌ 反例：超 600 字符整条拒收（不截断）',
    m.addSelfNote({ content: 'a'.repeat(601) }) === false);
  check('❌ 边界：恰好 600 字符放行', m.addSelfNote({ content: 'a'.repeat(600) }) === true);

  const m2 = freshMem();
  for (let i = 0; i < 20; i++) m2.addSelfNote({ content: 'note-' + i });
  check('❌ 反例：上限口径**含已注入的**（<= 8）', m2.data.selfNotes.length <= 8,
    'len=' + m2.data.selfNotes.length);
  check('❌ 反例：超上限丢最旧（保留最近的）',
    m2.data.selfNotes[m2.data.selfNotes.length - 1].content === 'note-19');

  const m3 = freshMem();
  m3.addSelfNote({ content: 'x', name: 'C:/Users/example/Desktop/LifeSandbox/note.md' });
  check('🔴 绝对路径不许进她的意识（只留 basename）',
    m3.data.selfNotes[0].name === 'note.md', m3.data.selfNotes[0].name);
  const out = flat(withHistory(m3));
  check('🔴 注入文本里不含盘符/绝对路径', !/[A-Za-z]:[\\/]/.test(out), out.slice(0, 80));
}

/* ============ 7. 反例③：旧档案 / 脏数据兼容 ============ */
{
  const dir = freshDir();
  // 旧档案（D-19 之前）完全没有 selfNotes 字段
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({
    schemaVersion: 1, history: [], windows: [], windowNo: 6, turnsInWindow: 0, totalTurns: 0,
  }));
  let m = null, threw = false;
  try { m = new Memory(dir, { persona: 'P' }); } catch (e) { threw = true; }
  check('旧档案（无 selfNotes 字段）加载不抛', !threw && m !== null);
  check('旧档案 selfNotes 归一为空数组', Array.isArray(m.data.selfNotes) && m.data.selfNotes.length === 0);
  check('旧档案上 addSelfNote 仍可用', m.addSelfNote({ content: '新的一条' }) === true);

  // 脏数据：非数组 / 缺 content / 缺 drained
  const dir2 = freshDir();
  fs.writeFileSync(path.join(dir2, 'memory.json'), JSON.stringify({
    schemaVersion: 1, history: [], windows: [], windowNo: 6, turnsInWindow: 0, totalTurns: 0,
    selfNotes: [null, 42, { name: 'no-content.txt' }, { content: '有内容但缺 drained', name: '/x/y.md' }],
  }));
  let m2 = null, threw2 = false;
  try { m2 = new Memory(dir2, { persona: 'P' }); } catch (e) { threw2 = true; }
  check('❌ 脏数据 selfNotes 不导致 load 失败', !threw2 && m2 !== null);
  check('❌ 脏数据被归一：剔除无 content 的条目，只留合法那条',
    m2.data.selfNotes.length === 1 && m2.data.selfNotes[0].content === '有内容但缺 drained',
    'len=' + m2.data.selfNotes.length);
  check('❌ 缺 drained 视为 false（宁可注入一次，也不静默吞掉）',
    m2.pendingSelfNotes().length === 1);
  check('❌ 脏数据里的绝对路径同样被剥成 basename',
    m2.data.selfNotes[0].name === 'y.md', m2.data.selfNotes[0].name);
}

/* ============ 8. 防漂移：接线仍在 ============ */
{
  const memSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory.js'), 'utf8');
  check('❌ addSelfNote 里确实调了 save(true)（立即落盘）',
    /this\.save\(true\);/.test(memSrc));
  // ⚠️ 必须**剔掉注释行**再查：文件里有两处注释在讲历史原因
  //   （「原设计把队列放在 this 上（this.selfNotes = []）」），
  //   直接对整个源码用正则会被它们误伤 —— 那不是代码，是解释。
  const memCode = memSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('❌ selfNotes 挂在 this.data 内（否则 save 存不到它）',
    !/this\.selfNotes\s*=/.test(memCode));
  check('❌ _drainSelfNotes 用 drained 过滤，不是物理清空',
    memSrc.includes('n.drained !== true') && !/this\.data\.selfNotes\.length = 0/.test(memSrc));

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('❌ main.js 的 onExecuted hook 仍登记自述', mainSrc.includes('addSelfNote'));
}

/* ============ 8. B-1（2026-11-05）：addSelfNote 内容幂等 ============
 *
 * 背景（审计 P2 #8）：同一条内容连调两次 → 两次都返回 true，队列里两条。
 * 正常路径不会重复（onExecuted 只在执行成功时 fire 一次），但没有任何断言挡着。
 *
 * ⚠️ B-2 是 B-1 的反例，缺一不可：
 *    只写 B-1 的话，「把所有重复都拒掉」也能通过 ——
 *    而那会让她永远写不了同一句话第二次，是过度修复。
 */
{
  const NOTE = '同一条内容';

  // B1-1 同内容未消费前不重复入队
  {
    const m = freshMem();
    const a = m.addSelfNote({ content: NOTE, name: 'a.txt', source: 'selfNote' });
    const b = m.addSelfNote({ content: NOTE, name: 'a.txt', source: 'selfNote' });
    check('B1-1 同内容未消费前不重复入队（第二次返回 false）',
      a === true && b === false && m.data.selfNotes.length === 1,
      `a=${a} b=${b} len=${m.data.selfNotes.length}`);
  }

  // B1-2 🔴 反例：已 drain 的同内容必须能重新登记
  {
    const m = freshMem();
    m.addSelfNote({ content: NOTE, name: 'a.txt', source: 'selfNote' });
    // 模拟「已被注入过」——她读过了
    m.data.selfNotes[0].drained = true;
    const again = m.addSelfNote({ content: NOTE, name: 'a.txt', source: 'selfNote' });
    check('🔴 B1-2 已 drain 的同内容可以重新登记（否则她永远写不了同一句话第二次）',
      again === true && m.data.selfNotes.length === 2,
      `again=${again} len=${m.data.selfNotes.length}`);
  }

  // B1-3 不同内容不受影响（防判据写成恒真）
  {
    const m = freshMem();
    const a = m.addSelfNote({ content: '第一条', name: 'a.txt', source: 'selfNote' });
    const b = m.addSelfNote({ content: '第二条', name: 'b.txt', source: 'selfNote' });
    check('B1-3 不同内容各自入队（防判据恒真）',
      a === true && b === true && m.data.selfNotes.length === 2,
      `len=${m.data.selfNotes.length}`);
  }

  // B1-4 队列满时重复项不该白挤掉一条真实条目
  //   （判重必须在淘汰之前 —— 这是实现顺序的断言）
  {
    const m = freshMem();
    for (let i = 0; i < 8; i++) {
      m.addSelfNote({ content: '填充' + i, name: 'f' + i + '.txt', source: 'selfNote' });
    }
    const lenBefore = m.data.selfNotes.length;
    const firstContent = m.data.selfNotes[0].content;
    // 重复最后一条（未 drain）
    const dup = m.addSelfNote({ content: '填充7', name: 'f7.txt', source: 'selfNote' });
    check('B1-4 队列满时重复项被拒且不挤掉最旧的真实条目',
      dup === false && m.data.selfNotes.length === lenBefore
      && m.data.selfNotes[0].content === firstContent,
      `dup=${dup} len=${m.data.selfNotes.length} first=${m.data.selfNotes[0].content}`);
  }
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
