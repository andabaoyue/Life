/**
 * test/agent-observe-mode.test.js
 *
 * 观察档（observe）门禁 —— 初澜 2.0 第 1 步。
 *
 * ## 这个套件要防的假绿（本仓实测踩过的坑，逐条对应）
 *   ① **测复刻版而非真实源码**：所以配置与分流判据一律 `require` 真模块，
 *      不在测试里重写一份 `getCapabilityMode`。
 *   ② **恒真断言**：每条断言都要能给出「什么情况下会 FAIL」的构造。
 *      例如「未登记回落 observe」必须同时给一个显式 auto 的对照，否则
 *      一个永远返回 observe 的坏实现也能全绿。
 *   ③ **接线断了但单测全绿**：所以有专门的「接线断言」段，
 *      直接读 main.js 源码确认三处调用真的存在（不是只有模块存在）。
 *
 * ## 覆盖范围
 *   A. config：三档读取、默认值、非法值回落、sanitize 白名单
 *   B. ObservationLog：完整正文、拒收空/超长、轮转（行数 + 时间）、坏行容错
 *   C. 隔离：观察记录绝不进 agent-audit.jsonl、绝不进 selfNotes
 *   D. 接线：main.js 真的调了 getCapabilityMode / observationLog
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
const _obsDirs = [];
const _obsOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _obsOrigMkdtemp.apply(fs, a);
  _obsDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _obsDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _obsOrigMkdtemp;
});

const cfgMod = require('../src/config');
const obsMod = require('../src/agent-observations');

const ROOT = path.join(__dirname, '..');

let failures = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* ══════════════════════════════════════════════════════════════════
 * A. config：三档读取与默认值
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- A. config 三档 ---');

{
  const g = cfgMod.getCapabilityMode;

  // A1 已有能力默认 auto（D-17 拍板过的免授权，不能被降级）
  check('A1 selfNote 默认 auto（D-17 免授权不被降级）', g({}, 'selfNote') === 'auto');
  check('A2 observerJournal 默认 auto', g({}, 'observerJournal') === 'auto');

  // A3 未登记的新能力回落 observe —— 同时给 auto 对照，防「永远返回 observe」的坏实现
  check('A3 未登记能力回落 observe', g({}, 'brandNewCapability') === 'observe');
  check('A4 对照：显式 auto 的未登记能力返回 auto',
    g({ agentCapabilityModes: { brandNewCapability: 'auto' } }, 'brandNewCapability') === 'auto');

  // A5 显式覆盖优先于出厂默认（否则「不能收权」那条就没法被用户主动行使）
  check('A5 显式 off 覆盖 selfNote 的 auto 默认',
    g({ agentCapabilityModes: { selfNote: 'off' } }, 'selfNote') === 'off');
  check('A6 显式 observe 覆盖 selfNote 的 auto 默认',
    g({ agentCapabilityModes: { selfNote: 'observe' } }, 'selfNote') === 'observe');

  // A7 非法值一律回落（不是静默接受）
  const bad = ['AUTO', 'true', '', null, 1, true, [], {}, 'Auto', ' observe'];
  let allFellBack = true;
  for (const v of bad) {
    if (g({ agentCapabilityModes: { x: v } }, 'x') !== 'observe') { allFellBack = false; break; }
  }
  check('A7 九种非法值全部回落 observe（含大小写/空白/非字符串）', allFellBack);

  // A8 防御：config 本身是垃圾
  check('A8 config=null 时 selfNote 仍 auto', g(null, 'selfNote') === 'auto');
  check('A9 config=null 时未登记仍 observe', g(null, 'nope') === 'observe');
  check('A10 agentCapabilityModes 是数组时按无配置处理',
    g({ agentCapabilityModes: ['auto'] }, 'x') === 'observe');

  // A11 sanitize 白名单：非法键值必须被丢弃，且出厂默认保留
  const longKey = 'a'.repeat(99);
  const s = cfgMod.sanitize({
    agentCapabilityModes: {
      selfNote: 'observe',
      bad: 'AUTO',
      evil: 1,
      [longKey]: 'auto',
      'has-dash': 'auto',
    },
  });
  check('A11 sanitize 保留合法值', s.agentCapabilityModes.selfNote === 'observe');
  check('A12 sanitize 丢弃非法值 AUTO', s.agentCapabilityModes.bad === undefined);
  check('A13 sanitize 丢弃非字符串值', s.agentCapabilityModes.evil === undefined);
  check('A14 sanitize 丢弃超长键名', s.agentCapabilityModes[longKey] === undefined);
  check('A15 sanitize 丢弃含连字符的键名', s.agentCapabilityModes['has-dash'] === undefined);
  check('A16 sanitize 后出厂默认仍在（observerJournal）', s.agentCapabilityModes.observerJournal === 'auto');
}

/* ══════════════════════════════════════════════════════════════════
 * B. ObservationLog：写入与轮转
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- B. ObservationLog ---');

{
  // B1 完整正文不截断
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
  const log = new obsMod.ObservationLog({ dir });
  const longText = '这是一段很长的正文。'.repeat(80);   // 约 800 字
  const r1 = log.append({ capability: 'selfNote', content: longText, scopeName: 'a.txt' });
  check('B1 完整正文写入成功', r1.ok === true && r1.persisted === true);
  const all1 = log.readAll();
  check('B2 正文逐字节未被截断', all1.length === 1 && all1[0].content === longText,
    'len=' + (all1[0] && all1[0].content.length));
  check('B3 contentBytes 按 UTF-8 字节算', all1[0].contentBytes === Buffer.byteLength(longText, 'utf8'));
  check('B4 元数据齐全（capability/scopeName/wouldHaveExecuted/reason）',
    all1[0].capability === 'selfNote' && all1[0].scopeName === 'a.txt'
    && all1[0].wouldHaveExecuted === true && all1[0].reason === 'observed');

  // B5 空正文拒收（观察档只记「她真的写出来了什么」）
  const r2 = log.append({ capability: 'selfNote', content: '   ' });
  check('B5 空白正文拒收', r2.ok === false && r2.reason === 'EMPTY_CONTENT');
  const r3 = log.append({ capability: 'selfNote' });
  check('B6 缺 content 字段拒收', r3.ok === false && r3.reason === 'EMPTY_CONTENT');

  // B7 超长拒收（不截断 —— 截断会让她的话变形）
  const tooLong = 'x'.repeat(obsMod.MAX_CONTENT_CHARS + 1);
  const r4 = log.append({ capability: 'selfNote', content: tooLong });
  check('B7 超过上限整条拒收而非截断', r4.ok === false && r4.reason === 'TOO_LONG');
  check('B8 拒收后文件里没有多出坏条目', log.readAll().length === 1);

  // B9 行数轮转
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
  const log2 = new obsMod.ObservationLog({ dir: dir2, maxLines: 5 });
  for (let i = 0; i < 12; i++) log2.append({ capability: 'selfNote', content: 'entry-' + i });
  const all2 = log2.readAll();
  check('B9 行数上限生效（12 条写入后只留 5 条）', all2.length === 5, 'got=' + all2.length);
  check('B10 轮转保留的是最新 5 条（不是最旧）',
    all2.length === 5 && all2[0].content === 'entry-7' && all2[4].content === 'entry-11',
    all2.length === 5 ? all2[0].content + '..' + all2[4].content : '');

  // B11 时间轮转：注入一条 200 天前的旧记录，应被淘汰
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
  const file3 = path.join(dir3, 'agent-observations.jsonl');
  const oldAt = Date.now() - 200 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file3, JSON.stringify({ at: oldAt, capability: 'old', content: '陈旧条目' }) + '\n', 'utf8');
  const log3 = new obsMod.ObservationLog({ dir: dir3 });
  log3.append({ capability: 'selfNote', content: '新条目' });
  const all3 = log3.readAll();
  check('B11 超过 90 天的旧条目被时间维度淘汰',
    all3.length === 1 && all3[0].content === '新条目', 'got=' + JSON.stringify(all3.map(x => x.content)));

  // B12 坏行容错：坏 JSON 不能让整份文件不可读
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
  const file4 = path.join(dir4, 'agent-observations.jsonl');
  fs.writeFileSync(file4,
    JSON.stringify({ at: Date.now(), capability: 'a', content: '好的' }) + '\n'
    + '{坏掉的 JSON\n'
    + JSON.stringify({ at: Date.now(), capability: 'b', content: '也是好的' }) + '\n',
    'utf8');
  const log4 = new obsMod.ObservationLog({ dir: dir4 });
  const all4 = log4.readAll();
  check('B12 坏 JSON 行被跳过，其余仍可读', all4.length === 2,
    'got=' + all4.length + ' -> ' + JSON.stringify(all4.map(x => x.capability)));

  // B13 无变化时不重写（防 mtime 扰动，与 tmp-hygiene 同款纪律）
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
  const log5 = new obsMod.ObservationLog({ dir: dir5, maxLines: 100 });
  log5.append({ capability: 'selfNote', content: 'x' });
  const file5 = path.join(dir5, 'agent-observations.jsonl');
  const mtime1 = fs.statSync(file5).mtimeMs;
  log5._rotateIfNeeded();   // 直接再跑一次轮转，内容无变化
  const mtime2 = fs.statSync(file5).mtimeMs;
  check('B13 内容无变化时轮转不重写文件（mtime 不变）', mtime1 === mtime2,
    mtime1 + ' vs ' + mtime2);
}

/* ══════════════════════════════════════════════════════════════════
 * C. 隔离：观察记录不污染审计与 selfNotes
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- C. 隔离 ---');

{
  // C1 观察记录器只写自己的文件，绝不碰 agent-audit.jsonl
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
  const auditPath = path.join(dir, 'agent-audit.jsonl');
  const obsPath = path.join(dir, 'agent-observations.jsonl');
  fs.writeFileSync(auditPath, JSON.stringify({ at: Date.now(), channel: 'sentinel' }) + '\n', 'utf8');
  const auditBefore = fs.readFileSync(auditPath, 'utf8');

  const log = new obsMod.ObservationLog({ dir });
  log.append({ capability: 'selfNote', content: '观察内容' });

  check('C1 观察记录写到自己的文件', fs.existsSync(obsPath));
  check('C2 agent-audit.jsonl 逐字节未变（安全审计与行为数据分离）',
    fs.readFileSync(auditPath, 'utf8') === auditBefore);

  // C3 观察记录里不含审计字段（防两类数据混形）
  const rec = log.readAll()[0];
  check('C3 观察记录不含审计专属字段（channel/outcome）',
    rec && rec.channel === undefined && rec.outcome === undefined);
  check('C4 观察记录用 reason=observed 与审计 outcome 区分', rec && rec.reason === 'observed');
}

/* ══════════════════════════════════════════════════════════════════
 * D. 接线断言（防「模块存在但没接」）
 * ══════════════════════════════════════════════════════════════════ */
console.log('--- D. 接线 ---');

{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  check('D1 main.js 引入了 getCapabilityMode', /getCapabilityMode/.test(mainSrc));
  check('D2 main.js 引入了 ObservationLog', /ObservationLog/.test(mainSrc));

  // 两条自发通路都必须各自读档位（不是只读一处）
  const selfNoteReads = (mainSrc.match(/getCapabilityMode\(\s*cfg\s*,\s*'selfNote'\s*\)/g) || []).length;
  const journalReads = (mainSrc.match(/getCapabilityMode\(\s*cfg\s*,\s*'observerJournal'\s*\)/g) || []).length;
  check('D3 selfNote 通路读了档位', selfNoteReads >= 1, 'count=' + selfNoteReads);
  check('D4 observerJournal 通路读了档位', journalReads >= 1, 'count=' + journalReads);

  // observe 分流必须真的调 observationLog.append
  const appends = (mainSrc.match(/observationLog\.append\(/g) || []).length;
  check('D5 两条通路都真的调用了 observationLog.append', appends >= 2, 'count=' + appends);

  // off 档必须在 askFor* 之前 return（零 LLM 开销）—— 判据是 return 语句在 askFor 之前
  const selfNoteFn = mainSrc.slice(mainSrc.indexOf('function maybeAskForSelfNote'));
  const offIdx = selfNoteFn.indexOf("if (mode === 'off') return;");
  const askIdx = selfNoteFn.indexOf('await brain.askForSelfNote');
  check('D6 off 拦截发生在 askForSelfNote 之前（零 LLM 开销）',
    offIdx >= 0 && askIdx >= 0 && offIdx < askIdx, 'off@' + offIdx + ' ask@' + askIdx);

  // observe 分流必须在 proposeInternal 之前
  const obsIdx = selfNoteFn.indexOf("if (mode === 'observe')");
  const proposeIdx = selfNoteFn.indexOf('deps.agentIpc.proposeInternal');
  check('D7 observe 分流发生在 proposeInternal 之前（不建案不写审计）',
    obsIdx >= 0 && proposeIdx >= 0 && obsIdx < proposeIdx, 'obs@' + obsIdx + ' propose@' + proposeIdx);

  // D10 🔴 接线断言：main.js 里的 ObservationLog **必须**指向自己的文件，不是审计文件。
  //
  //   为什么必须有这一条（变异测试逼出来的）：C 段的 C1/C2 用的是**测试自己 new 的**
  //   ObservationLog 实例，验的是模块行为，**不是 main.js 的接线**。
  //   实测把 main.js 里改成 `file: .../agent-audit.jsonl` 后，C 段**全绿**——
  //   那正是本仓反复禁止的「测的不是你的代码」。这条补上那个洞。
  const obsCtorLine = mainSrc.split('\n').find((l) => l.includes('new ObservationLog(')) || '';
  check('D10 main.js 的 ObservationLog 指向 agent-observations.jsonl（不是审计文件）',
    /new ObservationLog\(\s*\{\s*dir:/.test(obsCtorLine) && !/agent-audit/.test(obsCtorLine),
    'line=' + obsCtorLine.trim());

  // D11 红线：观察档绝不能调 memory.addSelfNote（观察期不回流给她）
  //
  //   🔴 判据必须**先剥注释**再匹配（本条第一版就栽在这）：
  //     函数体里我写了注释「✗ 不调 memory.addSelfNote」，直接字符串匹配会把
  //     这句注释当成「真的调了」⇒ 断言恒 FAIL。
  //     这正是本仓反复禁止的「用字符串匹配当判据」——判据要落在**代码**上。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // 行注释（避免误伤 https://）
  const fnStart = mainSrc.indexOf('function maybeAskForSelfNote');
  const fnEnd = mainSrc.indexOf('function maybeAskForObserverJournal');
  const selfNoteFnBody = fnStart >= 0 && fnEnd > fnStart
    ? stripComments(mainSrc.slice(fnStart, fnEnd)) : '';
  check('D11 selfNote 通路内零 memory.addSelfNote 调用（观察期不回流）',
    selfNoteFnBody.length > 0 && !/addSelfNote/.test(selfNoteFnBody),
    'bodyLen=' + selfNoteFnBody.length);

  // 红线：不得改动执行器闸门 / proposalSource 三态
  const execSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent-executor.js'), 'utf8');
  check('D12 执行器三态闸门仍在（SELF_NOTE_EXEMPT / OBSERVER_JOURNAL_EXEMPT）',
    /SELF_NOTE_EXEMPT/.test(execSrc) && /OBSERVER_JOURNAL_EXEMPT/.test(execSrc));
  check('D13 执行器未被本方案改动（PROPOSAL_SOURCES 三态仍只有三个）',
    /PROPOSAL_SOURCES\s*=\s*Object\.freeze\(\[\s*'user'\s*,\s*'selfNote'\s*,\s*'observerJournal'\s*\]\)/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'agent-interfaces.js'), 'utf8')));
}

/* ══════════════════════════════════════════════════════════════════
 * E 段：观察期满补注入（2026-11-04，缺口补齐）
 *
 * 背景：第 1 步做的 observe 三档是**半成品**——观察期拦下来的东西
 *   她那边毫无痕迹，而程序也不知道什么时候该补。本段钉住补齐部分。
 * ══════════════════════════════════════════════════════════════════ */
{
  const { Memory } = require(path.join(ROOT, 'src', 'memory'));
  const memDir = () => path.join(os.tmpdir(), 'obs-echo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const mkMem = () => new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });

  /* E1 加载归一：脏数据不得让 build 链炸 */
  {
    const dir1 = memDir();
    fs.mkdirSync(dir1, { recursive: true });
    const m = new Memory(dir1, { persona: 'test-persona', windowTurns: 10 });
    m.data.observeEpoch = 'not-an-object';
    m.data.observedNotes = 'not-an-array';
    m.save(true);
    const again = new Memory(dir1, { persona: 'test-persona', windowTurns: 10 });
    check('E1 observeEpoch 脏数据（字符串）载入后归一为对象',
      again.data.observeEpoch && typeof again.data.observeEpoch === 'object'
      && !Array.isArray(again.data.observeEpoch),
      'got=' + JSON.stringify(again.data.observeEpoch));
    check('E2 observedNotes 脏数据（字符串）载入后归一为数组',
      Array.isArray(again.data.observedNotes),
      'got=' + JSON.stringify(again.data.observedNotes));
  }

  /* E3 队列隔离：观察条目绝不挤进 selfNotes */
  {
    const m = mkMem();
    m.addSelfNote({ content: '这是真的要落盘的一条', source: 'selfNote' });
    const before = JSON.stringify(m.data.selfNotes);
    for (let i = 0; i < 25; i++) m.noteObserved('selfNote');
    check('E3 连续 25 条观察记录后 selfNotes 逐字节不变',
      JSON.stringify(m.data.selfNotes) === before);
    check('E4 observedNotes 上限 20（超出丢最旧）',
      m.data.observedNotes.length === 20, 'len=' + m.data.observedNotes.length);
  }

  /* E5 元数据不含正文（防实现时顺手把 content 塞进来） */
  {
    const m = mkMem();
    m.noteObserved('selfNote');
    const item = m.data.observedNotes[0];
    check('E5 observedNotes 每项只有 at/capability，不含 content',
      Object.keys(item).sort().join(',') === 'at,capability',
      'keys=' + Object.keys(item).join(','));
    check('E6 noteObserved 丢弃多余参数（即使传了 content 也不存）', (() => {
      const m2 = mkMem();
      // 模拟真实误用：调用方手上有 note.content，顺手当第二个参数传进来
      m2.noteObserved('selfNote', { content: '不该被存下来的正文' });
      m2.noteObserved({ capability: 'selfNote', content: '换个形态再传一次' });
      const bad = m2.data.observedNotes.filter((x) => 'content' in x || Object.keys(x).length !== 2);
      return bad.length === 0;
    })(), (() => {
      const m3 = mkMem();
      m3.noteObserved('selfNote', { content: 'x' });
      return 'keys=' + Object.keys(m3.data.observedNotes[0]).join(',');
    })());
  }

  /* E7/E8 期满补注入：只补一次 */
  {
    const m = mkMem();
    m.noteObserved('selfNote');
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'in');
    check('E7 进入观察期时 pendingEcho 为 false（观察期内不告知）',
      m.data.observeEpoch.selfNote.pendingEcho !== true);
    m.markObserveEpoch('selfNote', 'out');
    check('E8 离开观察期时置 pendingEcho', m.data.observeEpoch.selfNote.pendingEcho === true);

    const echo = m.takeObserveEcho();
    check('E9 补注入文本非空且含原因说明', echo.length > 0
      && /不是你失败/.test(echo) && /不能让你存下来|还没有开放/.test(echo));
    check('E10 补注入文本不含**无因的**「你失败了」',
      // ⚠️ 判据必须排除「不是你失败了」这个合法形态——
      //    第一版写成裸 /你失败了/，把「不是你失败了」也判红（误杀）。
      !/(?<!不是)你失败了/.test(echo),
      'echo=' + echo.slice(0, 40));
    check('E11 补注入文本不含文件名', !/note-/.test(echo) && !/\.txt/.test(echo));
    check('E12 补注入文本不含具体日期钟点', !/\d{4}-\d{2}-\d{2}/.test(echo) && !/\d{1,2}:\d{2}/.test(echo));
    check('E12b 措辞不重复：「念头」后面不再紧跟「想写点什么」',
      // 2026-11-04 审核抓到的硬伤：原文渲染成「有一点念头，想写点什么」——语义重复
      !/念头[^。]{0,6}想写点什么/.test(echo),
      'echo=' + echo.slice(0, 50));
    check('E13 消费即清：第二次 takeObserveEcho 返回空串', m.takeObserveEcho() === '');
  }

  /* E13b 0 条守卫：一条观察记录都没有时**绝不能凭空编一段经历**
   *   2026-11-04 审核抓到：无守卫时 total=0 仍输出「那段时间你有一点念头」。
   *   正常路径到不了（markObserveEpoch 已判），但脏档案可能带着
   *   pendingEcho=true 却没有条目 —— 这违背「数据不伪造」。 */
  {
    const m = mkMem();
    m.data.observeEpoch = { selfNote: { enteredAt: 1, leftAt: 2, pendingEcho: true } };
    m.data.observedNotes = [];
    check('E13b 0 条观察记录时不注入任何文本（不编造经历）',
      m.takeObserveEcho() === '');
  }

  /* E13c 计数失真：observedNotes 上限 20，超出丢最旧 —— 文案必须定性不报精确数 */
  {
    const m = mkMem();
    for (let i = 0; i < 30; i++) m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');
    const e = m.takeObserveEcho();
    check('E13c 30 条记录（队列只剩 20）时文案不报精确数字',
      e.length > 0 && !/\d+\s*次/.test(e),
      'len=' + e.length);
  }

  /* E14 没经历过观察期不得凭空产生补注入（老用户一启动不该看到一段） */
  {
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'out');   // 从没 'in' 过
    check('E14 没进入过观察期 ⇒ 不产生 pendingEcho',
      !m.data.observeEpoch.selfNote || m.data.observeEcho !== true);
    check('E15 没进入过观察期 ⇒ 取不到补注入文本', m.takeObserveEcho() === '');
  }

  /* E16 build() 兜底通道：synthetic 轮才消费，普通轮不消费 */
  {
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');

    // 普通用户消息（synthetic=false）⇒ 不消费
    m.append('user', '今天天气不错');
    const out1 = m.build();
    check('E16 用户主动聊天轮不触发兜底（pendingEcho 仍在）',
      m.data.observeEpoch.selfNote.pendingEcho === true);
    check('E17 用户主动聊天轮的 system 里没有补注入文本',
      !/不是你失败/.test(typeof out1 === 'string' ? out1 : JSON.stringify(out1)));

    // 对照：同一条改成 synthetic=true ⇒ 必须消费
    m.data.history[m.data.history.length - 1].synthetic = true;
    const out2 = m.build();
    check('E18 同一条消息只改 synthetic ⇒ 判定反转（证明判据真的生效）',
      m.data.observeEpoch.selfNote.pendingEcho === false,
      '这是对照断言：若两轮结果相同，说明判据恒真/恒假');
    check('E19 synthetic 轮的补注入进了尾部（能取到文本）',
      /不是你失败/.test(typeof out2 === 'string' ? out2 : JSON.stringify(out2)));
  }

  /* E20 顺序依赖：build 读的是**本轮**那条 user，不是上一条 */
  {
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');

    m.append('user', '普通消息');            // 第 1 条：不该触发
    m.build();
    check('E20a 第一轮（普通）未消费', m.data.observeEpoch.selfNote.pendingEcho === true);

    m.append('user', '[自主感知触发]：用户已经离开 30 分钟', { synthetic: true });  // 第 2 条：该触发
    m.build();
    check('E20b 第二轮（synthetic）消费了——证明读的是本轮而非上一条',
      m.data.observeEpoch.selfNote.pendingEcho === false);
  }

  /* E21 红线：补注入绝不进 system */
  {
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');
    m.append('user', '[自主感知触发]：用户已经离开 30 分钟', { synthetic: true });
    const built = m.build();
    /* ⚠️ 判据必须取**真正的那条系统消息**。
     *   第一版把整个返回值当字符串测（`typeof built === 'string' ? ... : ''`），
     *   而 `build()` 实际返回的是 `[{role:'system',...}, {role:'user',...}]` 数组
     *   ⇒ 取到空串 ⇒ 断言恒真（变异 M6 漏网时才发现）。
     */
    const msgs = Array.isArray(built) ? built : [];
    const sysMsg = msgs.find((x) => x && x.role === 'system');
    const sysText = sysMsg && typeof sysMsg.content === 'string' ? sysMsg.content : '';
    check('E21 补注入不进 system（护前缀缓存）',
      sysText.length > 0 && !/不是你失败/.test(sysText),
      'sysLen=' + sysText.length);
    // 反向对照：同一轮里补注入**必须真的出现**在非 system 部分，
    // 否则「不进 system」可能只是因为「压根没注入」（假绿）
    const userMsg = msgs.filter((x) => x && x.role === 'user').pop();
    const userText = userMsg && typeof userMsg.content === 'string' ? userMsg.content : '';
    check('E21b 同一轮补注入确实进了尾部（证明 E21 不是假绿）',
      /不是你失败/.test(userText));
  }

  /* E22 接线断言：main.js 的 observe 分支真的调了 noteObserved（替身计数，不搜字符串） */
  {
    const mainSrc2 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const code = strip(mainSrc2);
    const fnStart = code.indexOf('function maybeAskForSelfNote');
    const fnEnd = code.indexOf('\nfunction ', fnStart + 10);
    const body = fnStart >= 0 ? code.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 6000) : '';
    check('E22 observe 分支真的调了 memory.noteObserved（剥注释后匹配）',
      /noteObserved\(/.test(body), 'bodyLen=' + body.length);
    check('E23 记账只传 capability，没有把正文传进去',
      !/noteObserved\([^)]*content/.test(body));
  }

  /* ---------- F 段：启动兜底（2026-11-05 补） ----------
   *
   * ## 为什么需要这一段
   *   `markObserveEpoch('out')` 原本只有一个调用点（`maybeAskForSelfNote`），
   *   而那个函数要「挂机 120 分钟 + wantToLeaveSomething」才跑。
   *   ⇒ 切回 auto 后若不触发，`leftAt` 永远不写，补注入永远不来。
   *   2026-11-05 实测到了这个状态：配置 11:21 改回 auto，
   *   但进程 07:18 启动、`leftAt` 仍是 null。
   *
   * ## 这一段钉三条判据
   *   ① 从没观察过（无 enteredAt）⇒ 不补（否则老用户凭空收到「你曾想过」）
   *   ② 已经离开过（leftAt 有值）⇒ 不重复写（否则每次启动刷新时间）
   *   ③ 仍在 observe ⇒ 不提前结束
   *   外加：④ 真的该补时，pendingEcho 必须变 true（否则兜底等于没做）
   */
  {
    const { Memory } = require(path.join(ROOT, 'src', 'memory'));

    /* 模拟 main.js 启动兜底的那段逻辑（与源码同判据）。
     * ⚠️ 这里是**复刻**判据用于验证语义；真正的接线由 E24 的源码断言钉住。 */
    const startupFallback = (mem, modeOf) => {
      const epochs = (mem.data && mem.data.observeEpoch) || {};
      for (const cap of ['selfNote', 'observerJournal']) {
        const ep = epochs[cap];
        if (!ep || typeof ep !== 'object') continue;
        if (!Number.isFinite(ep.enteredAt)) continue;
        if (ep.leftAt !== null) continue;
        if (modeOf(cap) === 'observe') continue;
        mem.markObserveEpoch(cap, 'out');
      }
    };

    // F1 ① 从没观察过：不补
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      startupFallback(m, () => 'auto');
      check('F1 从没进入观察期（无 enteredAt）⇒ 不凭空补',
        !m.data.observeEpoch || !m.data.observeEpoch.selfNote,
        'got=' + JSON.stringify(m.data.observeEpoch));
    }

    /* F1b 🔴 对象存在但 enteredAt 缺失 —— 这才是 enteredAt 守卫的真实防线。
     *
     *   为什么单独测：
     *     F1 的构造是「observeEpoch 里根本没有 selfNote 这个键」，
     *     被更早的 `if (!ep || typeof ep !== 'object') continue` 挡住，
     *     **走不到 enteredAt 判据**。
     *
     *   而「对象存在、但 enteredAt 不是数字」是真实会出现的形态：
     *     旧版本数据 / 手改 memory.json / 迁移中间态。
     *
     *   ⚠️ **变异测试如实记录（M1 是等价变异体，不是测试漏了）**：
     *     把外层 `if (!Number.isFinite(ep.enteredAt)) continue;` 删掉，
     *     F1b **仍然 PASS** —— 因为 `markObserveEpoch(cap,'out')` 内部
     *     自己就有同一条守卫：`if (!Number.isFinite(base.enteredAt)) return;`
     *     （memory.js:1404 附近）。
     *     所以这条是**双层冗余守卫**，外层删掉内层兜底。
     *     ⇒ 保留外层是为了「不调用就没有副作用」（save(false) 也不该跑），
     *       而不是为了正确性；这一点写在这里，免得后来者以为测试无效。
     */
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.data.observeEpoch = { selfNote: { leftAt: null, pendingEcho: false } };   // 无 enteredAt
      m.data.observedNotes = [{ at: 1, capability: 'selfNote' }];
      startupFallback(m, () => 'auto');
      check('F1b 对象存在但 enteredAt 缺失 ⇒ 仍不补（不写半截账）',
        m.data.observeEpoch.selfNote.leftAt === null
        && m.data.observeEpoch.selfNote.pendingEcho === false,
        'got=' + JSON.stringify(m.data.observeEpoch.selfNote));
    }

    // F1c 对照：enteredAt 是数字时才该补（证明 F1b 不是恒真）
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.data.observeEpoch = { selfNote: { enteredAt: 1000, leftAt: null, pendingEcho: false } };
      m.data.observedNotes = [{ at: 1, capability: 'selfNote' }];
      startupFallback(m, () => 'auto');
      check('F1c 对照：enteredAt 是数字 ⇒ 会补',
        Number.isFinite(m.data.observeEpoch.selfNote.leftAt),
        'leftAt=' + m.data.observeEpoch.selfNote.leftAt);
    }

    // F2 ② 已经离开过：不重复写
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.data.observeEpoch = { selfNote: { enteredAt: 1000, leftAt: 2000, pendingEcho: true } };
      startupFallback(m, () => 'auto');
      check('F2 已离开过（leftAt 有值）⇒ 不重复写',
        m.data.observeEpoch.selfNote.leftAt === 2000,
        'leftAt=' + m.data.observeEpoch.selfNote.leftAt);
    }

    // F3 ③ 仍在 observe：不提前结束
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.data.observeEpoch = { selfNote: { enteredAt: 1000, leftAt: null, pendingEcho: false } };
      startupFallback(m, () => 'observe');
      check('F3 当前仍是 observe ⇒ 不提前结束观察期',
        m.data.observeEpoch.selfNote.leftAt === null,
        'leftAt=' + m.data.observeEpoch.selfNote.leftAt);
    }

    // F4 ④ 该补时真的补了：leftAt 有值 + pendingEcho 变 true
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.data.observeEpoch = { selfNote: { enteredAt: 1000, leftAt: null, pendingEcho: false } };
      m.data.observedNotes = [{ at: 1100, capability: 'selfNote' }];
      startupFallback(m, () => 'auto');
      const ep = m.data.observeEpoch.selfNote;
      check('F4 切回 auto 且曾观察过 ⇒ leftAt 被写入',
        Number.isFinite(ep.leftAt), 'leftAt=' + ep.leftAt);
      check('F5 且有观察记录 ⇒ pendingEcho 变 true（补注入才可能出现）',
        ep.pendingEcho === true, 'pendingEcho=' + ep.pendingEcho);
    }

    // F6 对照：有观察期但**没有**观察记录 ⇒ pendingEcho 不该是 true
    //   （她一次都没想过，补一句「你有过念头」就是编的）
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.data.observeEpoch = { selfNote: { enteredAt: 1000, leftAt: null, pendingEcho: false } };
      m.data.observedNotes = [];
      startupFallback(m, () => 'auto');
      check('F6 观察期内零记录 ⇒ pendingEcho 保持 false（不编「你有过念头」）',
        m.data.observeEpoch.selfNote.pendingEcho === false,
        'pendingEcho=' + m.data.observeEpoch.selfNote.pendingEcho);
    }

    // F7 脏数据不得让启动兜底抛（它在 whenReady 里，抛了会阻塞启动）
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.data.observeEpoch = 'garbage';
      let threw = false;
      try { startupFallback(m, () => 'auto'); } catch { threw = true; }
      check('F7 observeEpoch 是垃圾值时启动兜底不抛', !threw);
    }
  }

  /* E24 接线断言：main.js 真的在启动时做了兜底（源码级，剥注释后匹配） */
  {
    const mainSrc3 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const strip2 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const code3 = strip2(mainSrc3);
    check('E24 main.js 在启动时调了 markObserveEpoch(out)（兜底）',
      /markObserveEpoch\(cap,\s*'out'\)/.test(code3));
    check('E25 兜底判据含三条守卫（enteredAt / leftAt / mode）',
      /Number\.isFinite\(ep\.enteredAt\)/.test(code3)
      && /ep\.leftAt !== null/.test(code3)
      && /getCapabilityMode\(cfg,\s*cap\) === 'observe'/.test(code3));
  }

  /* ================= 🔴 2026-11-12 真机缺陷回归（OBS-1~5） ================= */
  {
    // OBS-1 幂等：已离开过，再调 out 不得重开
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');
    const firstLeftAt = m.data.observeEpoch.selfNote.leftAt - 5000;
    m.data.observeEpoch.selfNote.leftAt = firstLeftAt; // 拉开时差防同毫秒内假绿（M1 变异实测抓出）
    m.takeObserveEcho();
    m.markObserveEpoch('selfNote', 'out');     // 模拟下次写便签 main.js:440
    const after = m.data.observeEpoch.selfNote;
    check('OBS-1 已离开过再调 out 不得重开 pendingEcho、不得刷新 leftAt',
      after.pendingEcho === false && after.leftAt === firstLeftAt,
      'pendingEcho=' + after.pendingEcho + ' leftAtChanged=' + (after.leftAt !== firstLeftAt));
    check('OBS-1b 且不会再报一遍', m.takeObserveEcho() === '');
  }

  {
    // OBS-2 跨能力隔离
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('observerJournal', 'in');
    m.markObserveEpoch('observerJournal', 'out');
    check('OBS-2 observerJournal 自己没记录时 pendingEcho 必须为 false',
      m.data.observeEpoch.observerJournal.pendingEcho === false);
    check('OBS-2b 且取不到补注入', m.takeObserveEcho() === '');
  }

  {
    // OBS-3 消费隔离（反例：防「一次清全部」的过度修复）
    const m = mkMem();
    m.noteObserved('selfNote');
    m.noteObserved('observerJournal');
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');
    m.markObserveEpoch('observerJournal', 'in');
    m.markObserveEpoch('observerJournal', 'out');
    const a = m.takeObserveEcho();
    const b = m.takeObserveEcho();
    check('OBS-3 两条通路各该各报一次（消费 A 不得吞掉 B）',
      a.length > 0 && b.length > 0,
      'a=' + (a ? '有' : '空') + ' b=' + (b ? '有' : '空'));
    check('OBS-3b 两条都消费完后不再有', m.takeObserveEcho() === '');
  }

  {
    // OBS-4 从没 in 过
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'out');
    check('OBS-4 从没进过观察期 ⇒ 不产生 observeEpoch 条目',
      !m.data.observeEpoch.selfNote);
    check('OBS-4b 且取不到补注入', m.takeObserveEcho() === '');
  }

  {
    // OBS-5 🔴 旧账重放（D4）
    const m = mkMem();
    m.noteObserved('selfNote');
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');
    const first = m.takeObserveEcho();
    // 第 2 轮：重新进 observe，这轮 0 次想写
    m.markObserveEpoch('selfNote', 'in');
    m.markObserveEpoch('selfNote', 'out');
    const second = m.takeObserveEcho();
    check('OBS-5 第二次观察期 0 记录时不得翻上一轮的旧账',
      first.length > 0 && second === '',
      'first=' + (first ? '有' : '空') + ' second=' + (second ? '有' : '空'));
    check('OBS-5b 消费后该能力的 observedNotes 已被清空',
      m.data.observedNotes.filter((x) => x && x.capability === 'selfNote').length === 0,
      'left=' + JSON.stringify(m.data.observedNotes));
  }

  /* ---------- G 段：observerJournal 观察期记账（2026-11-05 A-1） ----------
   *
   * ## 为什么必须单独测这条
   *   审计报告 5.1 实测：`maybeAskForObserverJournal` 的 observe 分支
   *   **只写 agent-observations.jsonl，从不调 noteObserved / markObserveEpoch**。
   *   后果：`observeEpoch.observerJournal` 永远不存在 ⇒ 启动兜底
   *   `if (!Number.isFinite(ep.enteredAt)) continue;` 永远跳过它
   *   ⇒ `pendingEcho` 永远不产生 ⇒ 观察日记在 observe 档下写的东西**永远进不了补注入**。
   *
   * ## 为什么 G2 反例是关键
   *   只写 G1（"有记账能取到"）的话，改坏了也可能通过 ——
   *   因为同一个 Memory 上 selfNote 的记账也会让 `takeObserveEcho()` 返回非空。
   *   必须有一条「**不记账就取不到**」的反例，才能证明是 observerJournal 自己的账在起作用。
   */
  {
    const { Memory } = require(path.join(ROOT, 'src', 'memory'));

    // G1 有记账 ⇒ 能取到补注入
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.markObserveEpoch('observerJournal', 'in');
      m.noteObserved('observerJournal');
      m.markObserveEpoch('observerJournal', 'out');
      const echo = m.takeObserveEcho();
      check('G1 observerJournal 记了账 ⇒ 期满能取到补注入',
        typeof echo === 'string' && echo.includes('那段时间'),
        'echo=' + JSON.stringify(String(echo).slice(0, 40)));
    }

    // G2 反例：**只 markObserveEpoch、不 noteObserved** ⇒ 取不到
    //   （`pendingEcho` 的判据是 observedNotes.length > 0，见 memory.js:1411）
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.markObserveEpoch('observerJournal', 'in');
      m.markObserveEpoch('observerJournal', 'out');   // 故意不调 noteObserved
      check('G2 反例：没记观察计数 ⇒ 取不到补注入（不凭空编「你有过念头」）',
        m.takeObserveEcho() === '',
        'echo=' + JSON.stringify(m.takeObserveEcho()));
    }

    // G3 消费即清：取过一次后第二次必须为空
    {
      const m = new Memory(memDir(), { persona: 'test-persona', windowTurns: 10 });
      m.markObserveEpoch('observerJournal', 'in');
      m.noteObserved('observerJournal');
      m.markObserveEpoch('observerJournal', 'out');
      const first = m.takeObserveEcho();
      const second = m.takeObserveEcho();
      check('G3 observerJournal 的补注入也消费即清（只补一次）',
        first !== '' && second === '',
        'first=' + (first ? 'nonempty' : 'empty') + ' second=' + JSON.stringify(second));
    }

    /* G4/G5 接线断言：main.js 的 maybeAskForObserverJournal 体内
     *   必须真的调了这两个方法（源码级，剥注释后按函数体夹取）。
     *   ⚠️ 只断言「全文件里出现过」不够——selfNote 那两处也在同一个文件里。
     */
    {
      const mainSrc4 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
      const strip3 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const code4 = strip3(mainSrc4);
      const s = code4.indexOf('function maybeAskForObserverJournal');
      const e = code4.indexOf('\nfunction ', s + 10);
      const body = s >= 0 ? code4.slice(s, e > 0 ? e : s + 8000) : '';
      check('G4 maybeAskForObserverJournal 体内真的调了 markObserveEpoch(observerJournal)',
        /markObserveEpoch\(\s*'observerJournal'/.test(body), 'bodyLen=' + body.length);
      check('G5 maybeAskForObserverJournal 体内真的调了 noteObserved(observerJournal)',
        /noteObserved\(\s*'observerJournal'\s*\)/.test(body), 'bodyLen=' + body.length);
      // 反例：记账时不得把正文传进去
      check('G6 noteObserved 只传 capability，没有把 journal.content 传进去',
        !/noteObserved\(\s*[^)]*content/.test(body));
    }
  }
}

/* ══════════════════════════════════════════════════════════════════ */
console.log('\n' + (failures ? failures + ' 项失败' : '观察档全部通过'));
console.log('ASSERT total=' + total + ' passed=' + (total - failures) + ' failed=' + failures + ' skipped=0');
process.exit(failures ? 1 : 0);
