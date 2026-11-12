/**
 * test/agent-history.test.js
 *
 * 动作史投影（第 2 步）门禁。
 *
 * ## 这个套件要防的假绿（本仓实测踩过的，逐条对应）
 *   ① **测复刻版而非真实源码**：所以投影与渲染一律 `require` 真模块，
 *      不在测试里重写一份算法。
 *   ② **用 `src.includes()` 当判据**：D-27 与 observe 两轮都栽过
 *      （把注释当成真调用）。所以接线断言用**替身计数**，不搜字符串。
 *   ③ **恒真断言**：每条都要能说出「什么情况下会 FAIL」。
 *      例如「剔除 proactive-offer」必须同时给一条「它会进来」的对照。
 *
 * ## 覆盖范围
 *   A. 投影算法：配对、聚合、来源过滤、噪音剔除、覆盖规则
 *   B. 渲染：三条纪律（不给聚合数字 / 不写绝对时间 / 不给判断指令）
 *   C. 边界：空数据、坏数据、超长、原型污染
 *   D. 接线：brain 真的调了投影（替身计数）+ 注入不进 memory.build()
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
const _histDirs = [];
const _histOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _histOrigMkdtemp.apply(fs, a);
  _histDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _histDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _histOrigMkdtemp;
});

const { projectOwnActions, renderHistory } = require('../src/agent-history');
const { AuditLog } = require('../src/agent-interfaces');
const { ObservationLog } = require('../src/agent-observations');

const ROOT = path.join(__dirname, '..');

let failures = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* 构造一条真实形态的审计记录。字段名与实测原文一致。 */
function propAction(id, source, extra = {}) {
  return {
    at: extra.at || 1000,
    channel: 'agent:propose-action',
    outcome: 'accepted',
    capability: 'workspace.write',
    proposalId: id,
    proposalSource: source,
    intentKind: extra.intentKind || 'wantToLeaveSomething',
    scope: extra.scope || ('C:\\Users\\x\\Desktop\\LifeSandbox\\' + id + '.txt'),
  };
}
function execRec(id, outcome, extra = {}) {
  const r = {
    at: extra.at || 2000,
    channel: 'agent:execute',
    outcome,
    capability: 'workspace.write',
    proposalId: id,
  };
  if (extra.code) r.code = extra.code;
  return r;
}

/* ══════════════════════════════════════════════════════════════════
 * A. 投影算法
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- A. 投影算法 ---');

{
  // A1 基本配对：propose-action 提供来源，execute 提供终局
  const recs = [
    propAction('p1', 'selfNote', { scope: 'C:\\a\\note-1.txt' }),
    execRec('p1', 'executed'),
  ];
  const h1 = projectOwnActions(recs, []);
  check('A1 单条链正确配对并识别为 written',
    h1.recent.length === 1 && h1.recent[0].kind === 'written' && h1.recent[0].name === 'note-1.txt');

  // A2 来源过滤：user 的不进她的动作史
  const h2 = projectOwnActions([
    propAction('p2', 'user'), execRec('p2', 'executed'),
  ], []);
  check('A2 proposalSource=user 被剔除', h2.recent.length === 0);

  // A3 对照：selfNote 的会进来（防「全部剔除」的坏实现也能过 A2）
  const h3 = projectOwnActions([
    propAction('p3', 'selfNote'), execRec('p3', 'executed'),
  ], []);
  check('A3 对照：proposalSource=selfNote 会进来', h3.recent.length === 1);

  // A4 observerJournal 也算她的动作
  const h4 = projectOwnActions([
    propAction('p4', 'observerJournal'), execRec('p4', 'executed'),
  ], []);
  check('A4 observerJournal 也算她的动作', h4.recent.length === 1);

  // A5 🔴 ALREADY_EXECUTED 是系统噪音，必须剔除
  const h5 = projectOwnActions([
    propAction('p5', 'selfNote'),
    execRec('p5', 'executed'),
    { at: 3000, channel: 'agent:confirm-action', outcome: 'recorded', decision: 'approved', proposalId: 'p5' },
    execRec('p5', 'rejected', { code: 'ALREADY_EXECUTED', at: 3001 }),
  ], []);
  check('A5 ALREADY_EXECUTED 不产生「又被拒了一次」',
    h5.recent.length === 1 && h5.recent[0].kind === 'written');

  // A6 🔴 覆盖规则：executed 优先于后续 rejected
  //    实测链就是 executed → rejected(ALREADY_EXECUTED)，按「最后一条覆盖」会错记成被拒
  const h6 = projectOwnActions([
    propAction('p6', 'selfNote'),
    execRec('p6', 'executed', { at: 2000 }),
    execRec('p6', 'rejected', { code: 'ALREADY_EXECUTED', at: 2001 }),
  ], []);
  check('A6 executed 不被后续 rejected 覆盖（按最后一条覆盖会记错）',
    h6.recent.length === 1 && h6.recent[0].kind === 'written');

  // A7 非噪音的 rejected 要保留（那是真的被拒）
  const h7 = projectOwnOwnActionsSafe([
    propAction('p7', 'selfNote'),
    execRec('p7', 'rejected', { code: 'USER_REJECTED' }),
  ]);
  check('A7 非噪音的 rejected 保留为 refused',
    h7.recent.length === 1 && h7.recent[0].kind === 'refused');

  /* A7b 🔴 只有 rejected、**没有 executed** 的链 —— 这是 `NOISE_REJECT_CODES`
   *   判据唯一真正生效的分支。
   *
   *   为什么单独测（变异测试逼出来的）：A5/A6 那两条链都带 executed，
   *   而「executed 优先」规则会先一步把 final 定成 executed，
   *   根本走不到 rejectCode 判定 ⇒ 把噪音判据删掉，A5/A6 **仍然全绿**（等价变异体）。
   *   真实数据里目前也没有「只有 rejected」的链（实测三条链都有 executed 或 failed），
   *   但**将来会发生**：用户点【拒绝】就是这条形态。
   */
  const hNoiseOnly = projectOwnActions([
    propAction('p7b', 'selfNote'),
    execRec('p7b', 'rejected', { code: 'ALREADY_EXECUTED' }),
  ], []);
  check('A7b 只有 rejected(ALREADY_EXECUTED) 的链被剔除（噪音判据的真实分支）',
    hNoiseOnly.recent.length === 0, 'got=' + hNoiseOnly.recent.length);

  const hRealRejectOnly = projectOwnActions([
    propAction('p7c', 'selfNote'),
    execRec('p7c', 'rejected', { code: 'USER_REJECTED' }),
  ], []);
  check('A7c 对照：只有 rejected(USER_REJECTED) 的链保留',
    hRealRejectOnly.recent.length === 1 && hRealRejectOnly.recent[0].kind === 'refused');

  // A8 failed 记为 failed
  const h8 = projectOwnActions([
    propAction('p8', 'selfNote'), execRec('p8', 'failed', { code: 'EXECUTION_FAILED' }),
  ], []);
  check('A8 failed 记为 failed', h8.recent.length === 1 && h8.recent[0].kind === 'failed');

  // A9 只有建案、没有终局 ⇒ proposed（她确实发起过）
  const h9 = projectOwnActions([propAction('p9', 'selfNote')], []);
  check('A9 无终局的链记为 proposed', h9.recent.length === 1 && h9.recent[0].kind === 'proposed');

  // A10 🔴 系统事件必须全部剔除，同时给对照证明它们真的在输入里
  const noise = [
    { at: 1, channel: 'proactive-offer', outcome: 'dispatched', offerKind: 'idle' },
    { at: 2, channel: 'chat-failed', outcome: 'failed', errorType: 'auth_failed' },
    { at: 3, channel: 'agent:confirm-action', outcome: 'recorded', decision: 'approved', proposalId: 'p10' },
    propAction('p10', 'selfNote'),
    execRec('p10', 'executed'),
  ];
  const h10 = projectOwnActions(noise, []);
  check('A10 三条系统事件全部被剔除，只剩她的 1 条',
    h10.recent.length === 1 && h10.recent[0].kind === 'written',
    'got=' + h10.recent.length);

  // A11 观察记录计入动作史，标为 observed
  const h11 = projectOwnActions([], [
    { at: 5000, capability: 'selfNote', intentKind: 'wantToLeaveSomething', content: '完整正文' },
  ]);
  check('A11 观察记录计入并标为 observed',
    h11.recent.length === 1 && h11.recent[0].kind === 'observed');
  check('A12 观察记录**不携带正文**（只留事实）',
    h11.recent[0] && h11.recent[0].content === undefined && h11.recent[0].contentChars === undefined);

  // A13 观察记录没有 at 的丢弃（无法排序）
  const h13 = projectOwnActions([], [{ capability: 'selfNote', content: 'x' }]);
  check('A13 缺时刻的观察记录被丢弃', h13.recent.length === 0);

  // A14 排序：按时间升序，最近的在后
  const h14 = projectOwnActions([
    propAction('pA', 'selfNote', { at: 3000 }), execRec('pA', 'executed', { at: 3000 }),
    propAction('pB', 'selfNote', { at: 1000 }), execRec('pB', 'executed', { at: 1000 }),
  ], []);
  check('A14 按时间升序（最近的在后）',
    h14.recent.length === 2 && h14.recent[0].at === 1000 && h14.recent[1].at === 3000);

  // A15 limit 截断只保留最近 N 条
  const many = [];
  for (let i = 0; i < 10; i++) {
    many.push(propAction('pL' + i, 'selfNote', { at: 1000 + i }));
    many.push(execRec('pL' + i, 'executed', { at: 1000 + i }));
  }
  const h15 = projectOwnActions(many, [], { limit: 3 });
  check('A15 limit 生效且保留最近 3 条',
    h15.recent.length === 3 && h15.truncated === true && h15.recent[2].at === 1009);
}

/* 小工具：某些断言用 try 包一层更清楚 */
function projectOwnOwnActionsSafe(recs) {
  return projectOwnActions(recs, []);
}

/* ══════════════════════════════════════════════════════════════════
 * B. 渲染的三条纪律
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- B. 渲染纪律 ---');

{
  const h = projectOwnActions([
    propAction('r1', 'selfNote', { scope: 'C:\\a\\note-a.txt', at: 1000 }),
    execRec('r1', 'executed', { at: 1000 }),
    propAction('r2', 'selfNote', { scope: 'C:\\a\\note-b.txt', at: 2000 }),
    execRec('r2', 'failed', { at: 2000 }),
  ], []);
  const text = renderHistory(h);

  // B1 只陈述事实
  check('B1 渲染出【你最近做过的事】标题', text.includes('【你最近做过的事】'));
  check('B2 写成与失败各自成行', text.includes('你写过 note-a.txt') && text.includes('没有写成'));

  // B3 🔴 纪律①：不给聚合数字（「写成 N 次 / 没落成 M 次」是指标化）
  check('B3 不含聚合数字（写成 N 次 / 合计 之类）',
    !/\d+\s*次/.test(text) && !/合计/.test(text) && !/总计/.test(text),
    'text=' + JSON.stringify(text.slice(0, 80)));

  // B4 🔴 纪律②：不写绝对时间
  check('B4 不含日期钟点',
    !/\d{4}-\d{1,2}-\d{1,2}/.test(text) && !/\d{1,2}:\d{2}/.test(text));

  // B5 🔴 纪律③：不给判断指令
  check('B5 不含「所以你应该」这类指令',
    !/你应该/.test(text) && !/建议你/.test(text) && !/下次/.test(text));

  // B6 不评价（不写「做得好」「失败了 3 次」）
  check('B6 不评价', !/做得不错/.test(text) && !/失败/.test(text.replace('没有写成', '')),
    'text=' + JSON.stringify(text));

  // B7 空历史渲染成空串（不是空标题）
  check('B7 空历史返回空串', renderHistory({ recent: [], truncated: false }) === '');
  check('B8 null 历史返回空串', renderHistory(null) === '');

  // B9 观察记录聚合成一句（不刷屏）
  const hObs = projectOwnActions([], [
    { at: 1, capability: 'selfNote' },
    { at: 2, capability: 'selfNote' },
    { at: 3, capability: 'selfNote' },
  ]);
  const obsText = renderHistory(hObs);
  const obsLines = obsText.split('\n').filter((l) => l.includes('没有开放落成文件'));
  check('B9 多条观察记录聚合成一行（不刷屏）', obsLines.length === 1, 'got=' + obsLines.length);

  // B10 绝对路径不进她的意识（只留 basename）
  check('B10 绝对路径不出现在渲染结果里',
    !text.includes('C:\\') && !text.includes('Users'), 'text=' + JSON.stringify(text));
}

/* ══════════════════════════════════════════════════════════════════
 * C. 边界与防御
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- C. 边界 ---');

{
  // C1 空数据不抛
  let threw = false;
  try { projectOwnActions([], []); } catch { threw = true; }
  check('C1 两个空数组不抛', !threw);
  check('C2 空数据返回空结构',
    projectOwnActions([], []).recent.length === 0);

  // C3 null / undefined / 非数组入参都不抛
  let threw2 = false;
  try {
    projectOwnActions(null, null);
    projectOwnActions(undefined, undefined);
    projectOwnActions('x', 'y');
    projectOwnActions({}, {});
  } catch { threw2 = true; }
  check('C3 四种非法入参都不抛', !threw2);

  // C4 数组里的垃圾元素被跳过（null / 字符串 / 缺字段）
  let threw3 = false;
  let h4;
  try {
    h4 = projectOwnActions([null, 'str', 42, {}, { channel: 'agent:execute' }, propAction('c4', 'selfNote')], []);
  } catch { threw3 = true; }
  check('C4 垃圾元素跳过且不抛', !threw3 && h4 && h4.recent.length === 1);

  // C5 原型污染防御：__proto__ 作 proposalId 不得污染 Object.prototype
  const before = Object.prototype.polluted;
  projectOwnActions([
    { at: 1, channel: 'agent:propose-action', outcome: 'accepted', proposalId: '__proto__', proposalSource: 'selfNote' },
  ], []);
  check('C5 __proto__ 作 proposalId 不污染原型', Object.prototype.polluted === before);

  // C6 超长 scope 被截断（防撑爆注入文本）
  const longName = 'a'.repeat(500) + '.txt';
  const h6 = projectOwnActions([
    propAction('c6', 'selfNote', { scope: 'C:\\x\\' + longName }), execRec('c6', 'executed'),
  ], []);
  check('C6 超长文件名被截断到 120 字以内',
    h6.recent[0] && h6.recent[0].name.length <= 120, 'len=' + (h6.recent[0] && h6.recent[0].name.length));

  // C7 execute 先于 propose-action 出现（乱序）也能正确配对
  const h7 = projectOwnActions([
    execRec('c7', 'executed', { at: 2000 }),
    propAction('c7', 'selfNote', { at: 1000 }),
  ], []);
  check('C7 乱序（execute 在前）仍能配对', h7.recent.length === 1 && h7.recent[0].kind === 'written');
}

/* ══════════════════════════════════════════════════════════════════
 * D. 接线（替身计数，不搜字符串）
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- D. 接线 ---');

{
  const { Brain } = require('../src/brain');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-test-'));

  // D1 brain 构造后真的有 auditLog / observationLog 两个只读句柄
  const brain = new Brain(dir, { apiKey: 't', model: 'm', baseURL: 'http://127.0.0.1:1' });
  check('D1 brain 自建 auditLog 句柄', brain.auditLog && typeof brain.auditLog.readAll === 'function');
  check('D2 brain 自建 observationLog 句柄', brain.observationLog && typeof brain.observationLog.readAll === 'function');

  // D3 🔴 替身计数：_buildActionHistoryText 真的读了两个 readAll
  let auditReads = 0;
  let obsReads = 0;
  const realAuditReadAll = brain.auditLog.readAll.bind(brain.auditLog);
  const realObsReadAll = brain.observationLog.readAll.bind(brain.observationLog);
  brain.auditLog.readAll = function () { auditReads++; return realAuditReadAll(); };
  brain.observationLog.readAll = function () { obsReads++; return realObsReadAll(); };

  const text = brain._buildActionHistoryText();
  check('D3 投影真的调了 auditLog.readAll()（替身计数）', auditReads === 1, 'count=' + auditReads);
  check('D4 投影真的调了 observationLog.readAll()（替身计数）', obsReads === 1, 'count=' + obsReads);
  check('D5 空审计时返回空串（不是空标题）', text === '', 'text=' + JSON.stringify(text));

  // D6 喂真实数据后能渲染出来
  fs.writeFileSync(
    path.join(dir, 'agent-audit.jsonl'),
    JSON.stringify(propAction('d6', 'selfNote', { scope: 'C:\\s\\note-d6.txt', at: 1000 })) + '\n'
    + JSON.stringify(execRec('d6', 'executed', { at: 1000 })) + '\n',
    'utf8'
  );
  const text2 = brain._buildActionHistoryText();
  check('D6 写入真实审计后能渲染出动作史', text2.includes('note-d6.txt'), 'text=' + JSON.stringify(text2));

  // D7 🔴 用 list() 会清零：证明本实现用的是 readAll 而不是 list
  //    做法：把内存 events 清空，readAll 仍能读到盘上的记录
  brain.auditLog.events.length = 0;
  const text3 = brain._buildActionHistoryText();
  check('D7 内存清空后仍读得到（证明用的是 readAll 不是 list）',
    text3.includes('note-d6.txt'), 'text=' + JSON.stringify(text3));

  // D8 🔴 独立调用隔离：动作史不得进 memory.build()
  const built = brain.memory.build({});
  const builtText = JSON.stringify(built);
  check('D8 动作史不进 memory.build() 的产出', !builtText.includes('【你最近做过的事】'));
  check('D9 memory.build() 不含 d6 的文件名', !builtText.includes('note-d6.txt'));

  // D10 两个 askForSelf* 都挂了投影（源码级：两处调用，且都不在 build 链上）
  const brainSrc = fs.readFileSync(path.join(ROOT, 'src', 'brain.js'), 'utf8');
  const callCount = (brainSrc.match(/this\._buildActionHistoryText\(\)/g) || []).length;
  check('D10 两处 askForSelf* 都调了投影', callCount >= 2, 'count=' + callCount);

  // D11 memory.js 里零引用动作史（防有人日后顺手塞进 build）
  const memSrc = fs.readFileSync(path.join(ROOT, 'src', 'memory.js'), 'utf8');
  check('D11 memory.js 零引用 agent-history（注入不进 build 链路）',
    !/agent-history/.test(memSrc) && !/projectOwnActions/.test(memSrc));
}

/* ══════════════════════════════════════════════════════════════════ */
console.log('\n' + (failures ? failures + ' 项失败' : '动作史投影全部通过'));
console.log('ASSERT total=' + total + ' passed=' + (total - failures) + ' failed=' + failures + ' skipped=0');
process.exit(failures ? 1 : 0);
