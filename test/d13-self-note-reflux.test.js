/**
 * test/d13-self-note-reflux.test.js
 *
 * D-13 门禁：她写过的东西，回到她自己身上。
 *
 * ## 这一轮补的洞（反重力复核 D-10~D-12 时指出）
 *
 *   > **她写下的东西，她自己读不到。** 信息单向流出，像一套脱机的遥测系统。
 *
 *   现状：她的意识 = system + 历史 + 当轮尾部；沙盒文件不在这三层里的任何一层
 *   ⇒ 她写完就忘。本轮让她的字在**下一次开口时**出现在尾巴上。
 *
 * ## 三条铁律（违反即打回）
 *   1. 绝不进 system、绝不改写历史 —— 否则破坏前缀缓存（实测 95%+ 命中率会掉）
 *   2. 绝不伪装成 assistant 消息 —— 那是伪造她说过的话（persona.js:26）
 *   3. 标注不能催她回应 —— 撞 persona.js:29「装可怜不行」
 *
 * ## 覆盖的三类反例
 *   ① 漏传参数：空内容 / 非字符串 / 缺字段 —— 一律拒收且不抛
 *   ② 恶意变体：超长内容 / 队列灌爆 / 绝对路径泄漏 —— 不许进她的意识
 *   ③ 边界值：恰好上限 / 恰好超限 / 一次性出队
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/memory');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function freshMem() {
  return new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'd13-')), { persona: 'P' });
}
function withHistory(m, text) {
  m.data.history = [{ role: 'user', content: text || '我回来了', messageId: 'm1' }];
  return m.build('');
}

console.log('--- D-13 自述回流门禁 ---');

/* ============ 1. 正常通路：登记 → 挂到当轮尾部 ============ */
{
  const m = freshMem();
  check('登记成功', m.addSelfNote({ content: '今天很安静', name: '我的日记.md' }) === true);
  const out = withHistory(m);
  const last = out[out.length - 1];
  check('🔴 挂在当轮消息的 content 尾部（不是新增一条消息）', out.length === 2);
  check('🔴 用的是 user 角色（不许伪装成 assistant）', last.role === 'user');
  check('正文包含她写的话（逐字，不截断不改写）', last.content.includes('今天很安静'));
  check('🔴 标注含客观来源说明（「不是用户输入」）', last.content.includes('不是用户输入'));
  check('🔴 标注用第二人称「你之前写下过」（那是她自己的东西）',
    last.content.includes('你之前写下过'));
  check('文件名进了标注', last.content.includes('我的日记.md'));
}

/* ============ 2. 🔴 铁律 1：绝不进 system、绝不改写历史 ============ */
{
  const m = freshMem();
  m.addSelfNote({ content: '秘密的话', name: 'a.md' });
  // ⚠️ 正确顺序：先建好历史 → 取快照 → 再调 build → 比对。
  //   第一版把快照取在 build 之后，等于拿同一时刻的两次读取比对 ⇒ **恒真断言**（假反例形态②，
  //   实测自查抓到；本仓记录里已有同型坑）。
  const beforeSystem = m.systemText();
  m.data.history = [{ role: 'user', content: '我回来了', messageId: 'm1' }];
  const snapshotBefore = JSON.stringify(m.data.history);
  const out = m.build('');   // ← 这一步就是注入点
  check('🔴 铁律1-A：systemText 不受影响（不进 system）',
    m.systemText() === beforeSystem && !m.systemText().includes('秘密的话'));
  check('🔴 铁律1-B：history 逐字节未被改写（前缀缓存靠这个）',
    JSON.stringify(m.data.history) === snapshotBefore,
    'diff=' + (JSON.stringify(m.data.history) === snapshotBefore ? 'none' : 'CHANGED'));
  check('🔴 铁律1-C：注入后 history 里没有出现该文本',
    !JSON.stringify(m.data.history).includes('秘密的话'));
  check('🔴 铁律1-D：build 返回的 system 消息不含该文本',
    !String(out[0].content).includes('秘密的话'));
  check('🔴 铁律1-E 反向对照：注入真的发生了（防「什么都不注入」的假绿）',
    out.some((x) => String(x.content).includes('秘密的话')));
}
/* ============ 3. 🔴 铁律 2：绝不伪装成 assistant ============ */
{
  const m = freshMem();
  m.addSelfNote({ content: '她的话', name: 'a.md' });
  const out = withHistory(m);
  const asAssistant = out.filter((x) => x.role === 'assistant');
  check('🔴 铁律2：build 输出里没有任何 assistant 消息携带该文本',
    !asAssistant.some((x) => String(x.content).includes('她的话')));
  check('🔴 铁律2 反向对照：确实有内容被注入（防「恒不注入」的假绿）',
    out.some((x) => String(x.content).includes('她的话')));
}

/* ============ 4. 🔴 铁律 3：标注不催她回应 ============ */
{
  const m = freshMem();
  m.addSelfNote({ content: 'x', name: 'a.md' });
  const txt = withHistory(m).map((x) => String(x.content)).join('\n');
  const FORBIDDEN = ['等你回复', '该你说话', '要不要说说', '回复一下', '你应该', '你留下的痕迹'];
  const hit = FORBIDDEN.filter((w) => txt.includes(w));
  check('🔴 铁律3：标注不含任何催她回应的措辞', hit.length === 0, hit.join('/'));
  check('🔴 铁律3 反向对照：标注确实存在（否则上面是空断言）',
    txt.includes('你之前写下过'));
}

/* ============ 5. 决策 2：一次性（出队） ============ */
{
  const m = freshMem();
  m.addSelfNote({ content: '只该出现一次', name: 'a.md' });
  const first = withHistory(m).map((x) => String(x.content)).join('\n');
  const second = withHistory(m).map((x) => String(x.content)).join('\n');
  check('🔴 第一次出现', first.includes('只该出现一次'));
  check('🔴 第二次不再出现（一次性出队）', !second.includes('只该出现一次'));
  // 🔴 D-20 修订：旧断言是 `m.selfNotes.length === 0`（物理清空）。
  //   现在改成 drained 标记 —— **意图完全一致**：不再有待注入项。
  //   而内容仍然留在 data.selfNotes 里（落盘、可查），只是标记为已注入。
  check('出队后无待注入项（drained 标记生效）', m.pendingSelfNotes().length === 0,
    'pending=' + m.pendingSelfNotes().length);
  check('🔴 D-20：内容仍留在 data.selfNotes 里（不再物理删除）',
    Array.isArray(m.data.selfNotes) && m.data.selfNotes.length === 1
    && m.data.selfNotes[0].drained === true,
    'len=' + (m.data.selfNotes || []).length);
}

/* ============ 6. 反例①：漏传 / 坏值一律拒收且不抛 ============ */
{
  const m = freshMem();
  const cases = [
    ['空对象', {}], ['空串', { content: '' }], ['纯空白', { content: '   \n  ' }],
    ['null', { content: null }], ['数字', { content: 123 }], ['数组', { content: [1] }],
    ['对象', { content: { a: 1 } }], ['undefined 入参', undefined], ['null 入参', null],
  ];
  let threw = false, accepted = [];
  cases.forEach(([label, input]) => {
    try {
      const r = m.addSelfNote(input);
      if (r === true) accepted.push(label);
    } catch (e) { threw = true; }
  });
  check('❌ 反例：坏值一律拒收（返回 false）', accepted.length === 0, accepted.join('/'));
  check('❌ 反例：坏值不抛异常', !threw);
  check('❌ 反例：坏值后队列仍为空', m.data.selfNotes.length === 0);
}

/* ============ 7. 反例②：超长 / 灌爆 / 路径泄漏 ============ */
{
  const m = freshMem();
  check('❌ 反例：超过 600 字符整条拒收（不截断——截断会让她的话变形）',
    m.addSelfNote({ content: 'a'.repeat(601) }) === false);
  check('❌ 边界：恰好 600 字符放行',
    m.addSelfNote({ content: 'a'.repeat(600) }) === true);

  // 队列上界：灌爆后仍不超上限
  const m2 = freshMem();
  for (let i = 0; i < 20; i++) m2.addSelfNote({ content: 'note-' + i });
  // 🔴 D-20：上限口径 = **含已注入的**（与 SELF_NOTE_MAX_QUEUE 语义一致）。
  check('❌ 反例：队列有上界（含已注入的，不会无限增长）', m2.data.selfNotes.length <= 8,
    'len=' + m2.data.selfNotes.length);
  check('❌ 反例：超上界时丢最旧的（保留最近的）',
    m2.data.selfNotes[m2.data.selfNotes.length - 1].content === 'note-19');
}

/* ============ 8. 🔴 路径泄漏：绝对路径不许进她的意识 ============ */
{
  const m = freshMem();
  m.addSelfNote({ content: 'x', name: 'C:/workspace/LifeSandbox/note.md' });
  check('🔴 只保留 basename（完整绝对路径不进她的意识）',
    m.data.selfNotes[0].name === 'note.md', m.data.selfNotes[0].name);
  const m2 = freshMem();
  m2.addSelfNote({ content: 'x', name: 'C:\\Users\\developer\\note.md' });
  check('🔴 反斜杠路径同样只留 basename', m2.data.selfNotes[0].name === 'note.md', m2.data.selfNotes[0].name);
  const out = withHistory(m).map((x) => String(x.content)).join('\n');
  check('🔴 注入文本里不含任何盘符/绝对路径',
    !/[A-Za-z]:[\\/]/.test(out), out.slice(0, 80));
}

/* ============ 9. 防漂移：接线必须仍在 ============ */
{
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-ipc.js'), 'utf8');
  check('❌ agent-ipc 仍注入 onExecuted', ipcSrc.includes('const onExecuted = typeof options.onExecuted'));
  check('❌ onExecuted 只在 ok 之后触发（失败不入队）',
    ipcSrc.indexOf('if (!result.ok)') < ipcSrc.indexOf('if (typeof onExecuted === \'function\')'));
  check('❌ onExecuted 异常被吞掉（不许影响执行结果）',
    ipcSrc.includes('旁路：登记失败绝不能影响执行结果本身'));

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('❌ main.js 提供 agentOnExecuted hook', mainSrc.includes('const agentOnExecuted = (info) =>'));
  check('❌ main.js 把 hook 注入 registerAgentIpc', mainSrc.includes('onExecuted: agentOnExecuted'));
  check('🔴 决策1：hook 里不许有任何 broadcast / UI 调用',
    !/agentOnExecuted[\s\S]{0,1200}?broadcastToWindows/.test(mainSrc));
  check('❌ main.js hook 只在内容非空时登记',
    mainSrc.includes("typeof info.content !== 'string' || !info.content.trim()"));
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
