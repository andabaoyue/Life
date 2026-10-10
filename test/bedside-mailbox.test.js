/**
 * 枕边留置门禁（10-07）。
 *
 * ## 这个 bug 的由来
 *   用户报：她睡着时发消息、再吵醒，她不会回那条消息。
 *   实测坐实（memory.json 真数据）：10-07 05:16:46 user「早」之后，
 *   history 里**没有任何 assistant**。全 history 197 条里只有 3 条
 *   「user 之后没有 assistant」，全是睡眠期留置。
 *   断链：brain.ask 的 sleepMode 分支 append 完就return（不调 LLM），
 *   而唤醒链（tracker.wakeUp → onWakeHook → _settleDreamOnWake）零次 brain.ask。
 *   ⇒ 留置的消息进了历史，但没有任何一环去读它、生成回答。
 *
 * ## 本门禁锁定的三条
 *   ① 留置必落盘且**带 bedside 标记**（不标，渲染层与上下文侧都无法区分它与普通发言）
 *   ② 请求里**不留悬空 user**（折叠成块附在当轮user 尾部，避免连续两条 user 的坏形状）
 *   ③ 折叠块必须**原文逐字 + 客观来源标注**，且**不含替她表态的话**
 *      ——「她在等你回复」是禁句，那会把塑造成盯着用户等的样子（撞 persona.js:29）。
 *
 * ## 刻意不做的事
 *   **不加「吵醒即回话」的硬触发**。用户拍板：「不进行设置，但消息一定要传达过去，
 *   我们不能束缚她。」所以这里只锁「送达」，不锁「她必须开口」——
 *   沉默是合法回答，任何要求她必须回话的判据都是错的。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');
const { ActivityTracker } = require('../src/tracker');
const { decideBubble, bubbleView } = require('../ui-chat-render');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const reqs = [];
let replySeq = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    const j = JSON.parse(body);
    reqs.push(j.messages);
    const reply = '嗯，我在。（第' + (++replySeq) + '次）';
    const usage = { prompt_tokens: 10, completion_tokens: 5,
                    prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 };
    if (!j.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const ch of reply) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\n\n');
    }
    if (j.stream_options && j.stream_options.include_usage === true) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// [tmp-hygiene] 包 mkdtempSync 记下新建目录，exit 时统一清理。
// 位置纪律：必须在 const fs = require('fs') **之后**、首次调用之前。
const _thDirs = [];
const _thOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _thOrigMkdtemp.apply(fs, a);
  _thDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _thDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _thOrigMkdtemp;
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bedside-gate-')); }

function lastUserContent(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return String(msgs[i].content || '');
  return '';
}

function hasConsecutiveUser(msgs) {
  let n = 0;
  for (let i = 1; i < msgs.length; i++) if (msgs[i].role === 'user' && msgs[i - 1].role === 'user') n++;
  return n;
}

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const cfg = {
    apiKey: 'test', model: 'mock', baseURL: base,
    windowTurns: 999, windowMaxTokens: 1e9, memoryCapTokens: 1e9,
    price: { peak: {}, valley: {} }
  };

  let tc = Date.now();
  const trk = new ActivityTracker({ now: () => tc });
  const brain = new Brain(tmpDir(), cfg);
  brain.bindTracker(trk);

  await brain.ask('晚安', () => {});
  check('前置：道晚安真的让她入睡', trk.sleepMode === true);

  const before = reqs.length;
  const res2 = await brain.ask('早', () => {});
  check('睡着时发消息不调 LLM（零请求）', reqs.length === before,
    '新增请求=' + (reqs.length - before));
  check('睡着时如实返回 slept 标记', res2 && res2.slept === true);
  check('睡着时返回留置的 messageId（供 UI 钉死）',
    Boolean(res2 && res2.messageId), 'id=' + (res2 && res2.messageId));

  /* ---- ① 留置落盘且带 bedside 标记 ---- */
  const bedEntry = brain.memory.history.filter(m => m.bedside === true);
  check('留置条目带 bedside 标记', bedEntry.length === 1, 'bedside 条数=' + bedEntry.length);
  check('留置条目原文逐字保留（不被改写）',
    bedEntry.length === 1 && bedEntry[0].content === '早',
    JSON.stringify(bedEntry.map(m => m.content)));
  check('留置条目仍是 user 发言（不被降级成 synthetic/note）',
    bedEntry.length === 1 && bedEntry[0].role === 'user' && !bedEntry[0].synthetic);

  /* ---- 唤醒：不加硬触发，但也不该把留置丢掉 ---- */
  tc += 60 * 60 * 1000;
  const beforeWake = reqs.length;
  trk.record('drag', tc, { distance: 200 });
  check('拖拽真的唤醒了她', trk.sleepMode === false);
  check('唤醒本身零 LLM 请求（不擅自替她决定开口）',
    reqs.length === beforeWake, '新增请求=' + (reqs.length - beforeWake));

  /* ---- ② 她下次开口时：留置必送达，且不留悬空 user ---- */
  await brain.ask('我回来了', () => {});
  const req2 = reqs[reqs.length - 1];
  const tail = lastUserContent(req2);

  check('🔴 留置一定出现在她眼前的上下文里', /早/.test(tail));
  check('🔴 留置带客观来源标注（她知道这是睡着时留的）', /睡着时留/.test(tail));
  check('🔴 请求里不再有连续两条 user（坏形状已消除）',
    hasConsecutiveUser(req2) === 0, '连续 user 处数=' + hasConsecutiveUser(req2));

  /* ---- ③ 标注不得替她表态 ---- */
  const FORBIDDEN = [/她在等/, /等你回/, /该轮到你/, /快回/, /为什么不回/];
  const bad = FORBIDDEN.filter(re => re.test(tail));
  check('🔴 标注不含「她在等你回话」这类替她表态的话',
    bad.length === 0, bad.length ? '命中=' + bad.map(String).join(',') : '');

  /* ---- ④ 留置被回应后不再重复折叠 ---- */
  await brain.ask('你醒了啊', () => {});
  const req3 = reqs[reqs.length - 1];
  const tail3 = lastUserContent(req3);
  check('留置已被接住后不再重复出现在后续请求里（防复读）',
    !/你在她睡着时留/.test(tail3), JSON.stringify(tail3.slice(0, 60)));

  /* ---- 渲染层：留置如实标注，不伪装成已回应 ---- */
  const d = decideBubble({ role: 'user', content: '早', bedside: true, t: 1 }, 'note');
  check('渲染层：留置仍是 user 气泡（不降级成 note冒充程序触发）',
    d.kind === 'user', 'kind=' + d.kind);
  check('渲染层：留置被标记出来供 UI 标注', d.bedside === true);
  const v = bubbleView({ role: 'user', content: '早', bedside: true, t: 1 }, 'note');
  check('渲染层：bubbleView 把 bedside 透给视图', v.bedside === true);
  const dNormal = decideBubble({ role: 'user', content: '早', t: 1 }, 'note');
  check('渲染层：普通 user 消息不带 bedside（别把标记当常态）',
    dNormal.bedside === undefined);

  /* ---- ⑤ 边界：无留置时不产生任何折叠噪声 ---- */
  let tc2 = Date.now();
  const trk2 = new ActivityTracker({ now: () => tc2 });
  const brain2 = new Brain(tmpDir(), cfg);
  brain2.bindTracker(trk2);
  await brain2.ask('你好', () => {});
  const cleanReq = reqs[reqs.length - 1];
  check('没有留置时不产生任何「睡着时留」噪声',
    !/睡着时留/.test(lastUserContent(cleanReq)),
    JSON.stringify(lastUserContent(cleanReq).slice(0, 60)));
  check('没有留置时请求形状正常（连续 user = 0）',
    hasConsecutiveUser(cleanReq) === 0);

  /* ---- ⑥ 多条留置合并成一块，且都保留 ---- */
  let tc3 = Date.now();
  const trk3 = new ActivityTracker({ now: () => tc3 });
  const brain3 = new Brain(tmpDir(), cfg);
  brain3.bindTracker(trk3);
  await brain3.ask('晚安', () => {});
  await brain3.ask('第一条', () => {});
  await brain3.ask('第二条', () => {});
  // 先摇醒：用户报的正是「吵醒之后」的场景。
  //⚠️ 不摇醒的话「我回来了」自己也会走留置分支（落盘 bed:true），
  //   那时它是留置不是当轮 —— 断言会误判。不是实现缺陷，是场景没搭对。
  tc3 += 60 * 60 * 1000;
  trk3.record('drag', tc3, { distance: 200 });
  await brain3.ask('我回来了', () => {});
  const multiReq = reqs[reqs.length - 1];
  const multiTail = lastUserContent(multiReq);
  if(0) console.log('DIAG 落盘=' + JSON.stringify(brain3.memory.history.map(m => ({ r: m.role, bed: m.bedside === true, c: String(m.content).slice(0, 10) }))));
  if(0) console.log('DIAG 当轮user=' + JSON.stringify(multiTail));
  check('多条留置都被送达（不只送第一条）',
    /第一条/.test(multiTail) && /第二条/.test(multiTail));
  check('多条留置合并且仍无连续 user', hasConsecutiveUser(multiReq) === 0);


  /* ============ v1.0 B 方案（2026-10）：唤醒时的枕边未接提示 ============
   * 锁四件事，且**只锁事实、绝不锁"她必须开口"**（与本门禁总铁律一致）：
   *   ① 有未接 → 恰好回调一次，且只给条数（不带正文）；
   *   ② 无未接 → 零回调（界面安静如常，不能被噪声刷屏）；
   *   ③ 留言已被 assistant 接住 → 不再算未接（防复读，与 memory 折叠同口径）；
   *   ④ 提示本身**不写 history、不调 LLM**（否则就是变相替她开口）。
   */
  {
    let tcW = Date.now();
    const trkW = new ActivityTracker({ now: () => tcW });
    const brainW = new Brain(tmpDir(), cfg);
    brainW.bindTracker(trkW);
    const wakes = [];
    brainW.onBedsideUnread = (info) => wakes.push(info);

    // ① 无未接时被唤醒 → 零回调
    trkW.enterSleepMode(tcW);
    tcW += 60 * 60 * 1000;
    trkW.record('drag', tcW, { distance: 200 });
    check('B方案①：无未接留言时唤醒 → 不产生任何提示回调', wakes.length === 0,
      'wakes=' + wakes.length);

    // ② 睡着时留一条，唤醒 → 恰好一次，且只带条数
    trkW.enterSleepMode(tcW);
    await brainW.ask('你在吗', () => {});     // 睡着 → 走留置分支（不调 LLM）
    const histBefore = brainW.memory.history.length;
    const reqsBefore = reqs.length;
    tcW += 60 * 60 * 1000;
    trkW.record('drag', tcW, { distance: 200 });
    check('B方案②：有未接留言时唤醒 → 回调一次', wakes.length === 1, 'wakes=' + wakes.length);
    check('B方案②：回调只带条数、不带正文（正文回查 history，不造第二份真相）',
      wakes.length === 1 && wakes[0].count === 1 && wakes[0].content === undefined,
      JSON.stringify(wakes[0] || null));
    check('B方案②：提示不改写 history（不冒充她开口、不伪造经历）',
      brainW.memory.history.length === histBefore,
      'before=' + histBefore + ' after=' + brainW.memory.history.length);
    check('B方案②：提示零 LLM 请求（她说不说仍归她）',
      reqs.length === reqsBefore, '新增请求=' + (reqs.length - reqsBefore));

    // ③ 她开口接住之后，再唤醒不再提示（防复读）
    await brainW.ask('我看到啦', () => {});
    const wakesBefore2 = wakes.length;
    trkW.enterSleepMode(tcW);
    tcW += 60 * 60 * 1000;
    trkW.record('drag', tcW, { distance: 200 });
    check('B方案③：留言已被接住后再唤醒 → 不再重复提示（防复读）',
      wakes.length === wakesBefore2, 'wakes=' + wakes.length + ' before=' + wakesBefore2);

    // ④ 未接线 onBedsideUnread 时不得抛异常（老路径/测试环境容错）
    let threw = false;
    try {
      const trkX = new ActivityTracker({ now: () => Date.now() });
      const brainX = new Brain(tmpDir(), cfg);
      brainX.bindTracker(trkX);
      trkX.enterSleepMode(Date.now());
      trkX.record('drag', Date.now() + 3600000, { distance: 200 });
    } catch (e) { threw = true; }
    check('B方案④：未接线提示回调时唤醒不抛异常（提示是附带品，绝不影响唤醒）', threw === false);

    // ⑤ M3：留置记账失败时如实报错（ok: false, note 提示留言未能留置，不崩溃）
    trkW.enterSleepMode(tcW);
    const origAppend = brainW.memory.append;
    brainW.memory.append = () => { throw new Error('DISK_FULL'); };
    let resFail = null;
    try {
      resFail = await brainW.ask('留置失败测试', () => {});
    } finally {
      brainW.memory.append = origAppend;
    }
    check('M3：留置记账抛错时如实返回 ok: false 且 note 提示留言未能留置',
      resFail && resFail.ok === false && resFail.note === '[初澜沉睡中，留言未能留置]');
    check('M3：记账抛错时 messageId 为 null 且 slept 标记保留',
      resFail && resFail.messageId === null && resFail.slept === true);
  }

  // 🔴 D-10 修的退出竞态（真凶不是 server.close 的时机，是 process.exit 本身）。
  //
  //   症状：**偶发**（实测 6 次崩 1~2 次）—— 22 项断言全 PASS、0 失败，
  //   但退出码是 -1073740791，stderr 里是
  //     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
  //   在 CI / 门禁里等于 FAIL，而报告里显示是绿的。
  //   这是本仓「全绿不等于通过」的又一种形态：**断言全绿但进程崩了**。
  //
  //   ⚠️ 第一版修法是「等 server.close 回调再 exit」，**实测不够** ——
  //     仍崩。因为进程里还活着两个 keep-alive Socket（客户端侧），
  //     `process.exit()` 在任何句柄处于 CLOSING 时强退都会撞上这个断言。
  //
  //   正确修法：**不用 process.exit()**，改用 process.exitCode + 让事件循环自然排空。
  //     · 本测试没有悬挂的定时器，server 关掉、socket 排空后循环会自己结束；
  //     · exitCode 照样把失败传给 CI，退出码语义不变；
  //     · 不再有「强退 vs 句柄关闭」的赛跑，断言不会被触发。
  server.close(() => {
    console.log('\n失败 ' + failures + ' 项');
    process.exitCode = failures ? 1 : 0;   // 交给自然退出，不 process.exit()
  });
}

main().catch(e => { console.error('门禁崩了：', e); server.close(); process.exit(1); });