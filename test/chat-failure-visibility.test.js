/**
 * 失败可见性回归（2026-10-19）。
 *
 * ## 为什么需要这个文件
 *
 * 实测事故：Key 在 10-18 深夜被服务端判为 invalid，此后 7 次主动搭话全部
 * 在 `brain.ask` 里被 401 拒掉。但磁盘上**没有任何失败痕迹**：
 *   · `experiment-telemetry.jsonl` 的 `llm_call` 只在**成功**时写（brain.track）；
 *   · 失败只落到一个 6 秒自动收起的气泡上，人不在电脑前就等于没发生。
 * 结果：用户以为「她不想说话」，实际上她每半小时都在试、每半小时都被拒。
 *
 * 本文件钉三件事，缺一即回到事故形态：
 *   ① 失败**必须留痕**（agent-audit.jsonl 的 chat-failed）；
 *   ② 认证失败必须**指明下一步**（不能只丢原始 HTTP 报错）；
 *   ③ 认证失败必须**退避**，但不能把调度器退化成停摆。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(ROOT, 'chat.js'), 'utf8');
const i18n = require(path.join(ROOT, 'ui-i18n.js'));

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

/* ============================================================
 * 一、主进程：失败留痕 + 错误类别透传
 * ============================================================ */

/** 抽出 auditChatFailure 单跑，断言「只记元数据、不记正文」。 */
function makeAuditHarness() {
  const a = mainSrc.indexOf('function auditChatFailure(');
  const b = mainSrc.indexOf('function scheduleProactiveCheck(');
  if (a < 0 || b < 0 || b <= a) throw new Error('找不到 auditChatFailure 段');
  const body = mainSrc.slice(a, b);
  const written = [];
  const factory = new Function('proactiveAuditLog', body + '; return auditChatFailure;');
  const fn = factory({ append: (r) => written.push(r) });
  return { fn, written };
}

/* ① 认证失败被记成 auth_failed，且带 proactive / offerKind / status。 */
{
  const { fn, written } = makeAuditHarness();
  const err = Object.assign(new Error('HTTP 401 [auth_failed] provider=deepseek stage=request'), {
    errorType: 'auth_failed', status: 401, retryable: false,
  });
  fn(err, { proactive: true, offer: { kind: 'idle' } });
  const r = written[0] || {};
  check('① 认证失败写一条 chat-failed（带 errorType / status / proactive / offerKind）',
    r.channel === 'chat-failed' && r.outcome === 'failed'
    && r.errorType === 'auth_failed' && r.status === 401 && r.proactive === true
    && r.offerKind === 'idle',
    JSON.stringify(r));
}

/* ② 留痕只记元数据 —— 绝不能把报错原文（可能含 URL/服务商细节）整段抄进审计。 */
{
  const { fn, written } = makeAuditHarness();
  const err = Object.assign(new Error('secret-ish body: user said 我好累'), {
    errorType: 'network_error', status: null,
  });
  fn(err, { proactive: false, offer: null });
  const dumped = JSON.stringify(written[0] || {});
  check('② 审计只记元数据：不含报错正文、不含用户内容',
    dumped.indexOf('我好累') < 0 && dumped.indexOf('secret-ish') < 0,
    dumped);
}

/* ③ 没有审计出口时静默返回，绝不抛（审计是证据，不是前置条件）。 */
{
  const a = mainSrc.indexOf('function auditChatFailure(');
  const b = mainSrc.indexOf('function scheduleProactiveCheck(');
  const factory = new Function('proactiveAuditLog', mainSrc.slice(a, b) + '; return auditChatFailure;');
  let threw = false;
  try { factory(null)(new Error('x'), { proactive: true, offer: { kind: 'idle' } }); } catch (e) { threw = true; }
  check('③ 审计出口为 null 时静默跳过，不影响错误上报', !threw);
}

/* ③b 接线断言：函数写对了但**没被调用**等于没写。
 *
 *   🔴 这条是变异测试逼出来的：把 chat-send catch 里那句 auditChatFailure 删掉，
 *     ①②③ 依然全绿 —— 因为它们测的是**抽出来的函数本身**，不是它在错误路径上
 *     被调用了。这正是本仓记过的「函数对、接线断」形态（D-15 那次一样：
 *     断言只看函数存在，没看调用点）。 */
check('③b 接线：chat-send 的 catch 里真的调了 auditChatFailure（不是只有函数存在）',
  /catch \(err\)[\s\S]{0,600}?auditChatFailure\(err, \{ proactive, offer \}\)/.test(mainSrc));

/* ④ catch 分支必须把 errorType / status 交给渲染端（界面要靠它分类）。 */
check('④ chat-send 的 catch 把 errorType 与 status 一并返回给渲染端',
  /catch \(err\)[\s\S]{0,1200}?errorType: err\.errorType[\s\S]{0,200}?status:/.test(mainSrc));

/* ④b TimeoutError 没有 errorType（provider-adapter 刻意透传不重包），
      必须按 name 归类成 'timeout'，否则渲染端那条分支永远走不到。 */
check('④b 超时按 name 归类成 timeout（TimeoutError 本身不带 errorType）',
  /errorType: err\.errorType \|\| \(err\.name === 'TimeoutError' \? 'timeout' : 'unknown_error'\)/.test(mainSrc));

/* ⑤ 认证失败进退避，换 Key / 换连接都必须解除。 */
check('⑤ 认证失败写入退避（否则每 90 秒打一次注定 401 的请求）',
  /err\.errorType === 'auth_failed'[\s\S]{0,120}?authFailureUntil = Date\.now\(\) \+ AUTH_FAILURE_BACKOFF_MS/.test(mainSrc));
check('⑤b 填/换 Key 成功后解除退避并重排',
  /ipcGuard\.handle\('config-set-key'[\s\S]{0,2000}?clearAuthFailureBackoff\(\);[\s\S]{0,80}?scheduleProactiveCheck\(COOLDOWN_MS\)/.test(mainSrc));
check('⑤c 切换连接成功后同样解除退避并重排（漏了它同样会继续沉默）',
  /ipcGuard\.handle\('connections:activate'[\s\S]{0,2000}?clearAuthFailureBackoff\(\);[\s\S]{0,80}?scheduleProactiveCheck\(COOLDOWN_MS\)/.test(mainSrc));

/* ⑥ 退避期不是停摆：仍要重排，只是间隔拉长。 */
check('⑥ 退避期内仍然重排（把节奏放慢，不是把调度停掉）',
  /if \(inAuthFailureBackoff\(\)\) \{[\s\S]{0,160}?scheduleProactiveCheck\(AUTH_FAILURE_BACKOFF_MS\);[\s\S]{0,40}?return;/.test(mainSrc));
check('⑥b 退避只存内存、不落盘（换 Key / 重启都该重新试）',
  !/authFailureUntil[^\n]*save/i.test(mainSrc));

/* ⑥c 🔴 退避不能连「感知与内稳态」一起挡住。
 *
 *   自查发现的副作用：早期版本把 `if (inAuthFailureBackoff()) return;` 写在
 *   `tracker.recordIdle(...)` **之前** ⇒ Key 失效的十分钟里，挂机计量、
 *   内稳态静息回血、environmental_silence 知觉全部断档。
 *   那不是「别撞关着的门」，那是「门锁坏了连心跳也停」。
 *   所以顺序必须是：recordIdle → 退避检查 → evaluate。 */
{
  const tickBody = mainSrc.slice(
    mainSrc.indexOf('function checkAndPushProactive('),
    mainSrc.indexOf('// 🔴 D-7：她说完（或被礼貌闸门拒了）之后的收尾'));
  const iRecordIdle = tickBody.indexOf('tracker.recordIdle(');
  const iBackoff = tickBody.indexOf('if (inAuthFailureBackoff())');
  const iEvaluate = tickBody.indexOf('evaluateTriggerWithCuriosity()');
  check('⑥c 顺序：recordIdle 在退避检查之前，退避在 evaluate 之前（感知不被退避连坐）',
    iRecordIdle >= 0 && iBackoff >= 0 && iEvaluate >= 0
    && iRecordIdle < iBackoff && iBackoff < iEvaluate,
    'recordIdle@' + iRecordIdle + ' backoff@' + iBackoff + ' evaluate@' + iEvaluate);
}

/* ⑥d 主动搭话失败必须推到对话窗（头顶气泡会收、审计用户不会翻）。 */
check('⑥d 失败同时广播给对话窗（常驻注记行，不是只写审计）',
  /notifyChatFailureToWindows\(err, \{ proactive, offer \}\)/.test(mainSrc));
check('⑥e 广播只带错误类别，不带报错原文（用户要知道「怎么办」，不是 HTTP 细节）',
  /broadcastToWindows\('chat-failed', \{[\s\S]{0,220}?\}\)/.test(mainSrc)
  && !/broadcastToWindows\('chat-failed', \{[\s\S]{0,220}?error: err\.message/.test(mainSrc));
check('⑥f 只有 auth_failed / network_error / timeout 三类才打扰对话窗（其余偶发错误不兑成噪音）',
  /type !== 'auth_failed' && type !== 'network_error' && type !== 'timeout'/.test(mainSrc));
check('⑥g preload 暴露了 onChatFailed（否则对话窗收不到这条）',
  fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').includes('onChatFailed'));
check('⑥h 对话窗用 chatNotice（客观事实行）而非 chatError —— 这是她那一趟没成，不是用户操作失败',
  /api\.onChatFailed\(\(p\) => \{[\s\S]{0,400}?chatNotice = t\('chat\.proactiveAuthFailed'/.test(chatSrc));

/* ============================================================
 * 二、渲染端：失败要说人话
 * ============================================================ */

/* ⑦ pet.js 有三个分支的文案，且认证失败延长显示（6 秒太短，人不在就看不见）。 */
check('⑦ 头顶气泡按 errorType 分流（认证 / 网络 / 其余）',
  petSrc.includes("type === 'auth_failed'") && petSrc.includes("type === 'network_error'"));
check('⑦b 认证失败气泡延长到 15 秒（默认 6 秒，人不在电脑前就等于没提示）',
  /finish\(errorBubbleText\(res\), isAuthFailure\(res\) \? 15000 : 6000\)/.test(petSrc));
check('⑦c 渲染端不猜 HTTP 状态码（只认主进程给的 errorType）',
  !/res\.status === 40[13]/.test(petSrc) && !/status === 401/.test(petSrc));

/* ⑧ 对话窗的错误行是常驻的，Key 失效时必须在那里也指路。 */
check('⑧ 对话窗对 auth_failed 给出「去设置重填」的指引（而不是原始报错）',
  /res\.errorType === 'auth_failed'[\s\S]{0,120}?chat\.authFailedNotice/.test(chatSrc));

/* ⑨ 三条新文案中英双语都在，且 en 表零中文残留（ui-i18n.test.js 的机械门禁同源）。 */
{
  const zh = i18n.I18N['zh-CN'];
  const en = i18n.I18N['en'];
  const keys = ['chat.authFailedBubble', 'chat.networkFailedBubble', 'chat.authFailedNotice',
    'chat.proactiveAuthFailed', 'chat.proactiveNetworkFailed'];
  check('⑨ 五条新文案中英双语齐备',
    keys.every((k) => typeof zh[k] === 'string' && typeof en[k] === 'string'),
    keys.filter((k) => !zh[k] || !en[k]).join(', '));
  check('⑨b en 版零中文残留', keys.every((k) => !/[\u4e00-\u9fa5]/.test(en[k])),
    keys.map((k) => en[k]).join(' | '));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
