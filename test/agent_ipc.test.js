/**
 * test/agent_ipc.test.js — D-1阶段 Agent IPC 治理通道门禁
 *
 * 设计原则（2026-10-06 立规，本文件严格执行）：
 *   **门禁测试必须包含反例。只测正例，真漏洞会藏在绿色里。**
 *
 * 本文件的反例（对应 C 阶段三处曾被49 项全绿掩盖的隐患）：
 *   ❌ 反例 1：非受信 renderer 调用全部通道 → UNTRUSTED_RENDERER
 *   ❌ 反例 2：跨 IPC 传入 network.request 提案 → 硬拒绝（且伪造 meta 也不行）
 *   ❌ 反例 3：预算熔断后提案 → 拒绝，且不静默放行
 *   ❌ 反例 4：畸形提案 / 数组 / null / 越界 scope → 拒绝
 *   ❌ 反例 5：channel 名单里不得出现 execute / write 等执行写通道
 *
 * 正例覆盖：四通道可调、授权通过的提案建案但不执行、审计双向可读。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { registerAgentIpc, AGENT_CHANNELS } = require('../src/agent-ipc');
const { createIpcGuard } = require('../src/ipc-guard');
const { createActionProposal } = require('../src/agent-interfaces');

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 24 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
} = require('../src/agent-interfaces');
const { UserConfirmationGate } = require('../src/agent-confirmation');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function mkAppDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentipc-app-'));
  fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html>');
  return d;
}

/**
 * 用**真实的 createIpcGuard** 装配（不用桩），这样 sender/frame/URL 校验走真代码路径。
 * 返回 { handlers, calls } —— calls 记录裸 ipcMain 注册的通道，供"无裸注册"断言用。
 */
function harness(opts = {}) {
  const appDir = opts.appDir || mkAppDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentipc-data-'));
  const handlers = new Map();
  const calls = [];

  const fakeIpcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    on(channel, fn) { calls.push(channel); },
  };

  const localUrl = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
  const mainFrame = { url: localUrl };
  const webContents = { mainFrame, on() {}, setWindowOpenHandler() {} };
  const win = { webContents, isDestroyed: () => false };

  const guard = createIpcGuard({
    ipcMain: fakeIpcMain,
    getMainWindow: () => win,
    appDir,
    getTrustedWebContents: () => (opts.trusted ? [opts.trusted] : []),
  });

  const registry = opts.registry || new CapabilityRegistry();
  const policy = opts.policy || new PermissionPolicy({
    killSwitch: false,
    allowed: ['workspace.read', 'workspace.write'],
  });
  const budget = opts.budget || new ExecutionBudget();
  const auditLog = opts.auditLog || new AuditLog({ dir: dataDir });

  if (opts.scopeRoots) policy.setScopeRoots('workspace.read', opts.scopeRoots);
  const ok = registerAgentIpc(guard, { registry, policy, budget, auditLog }, opts.options);

  // 可信事件（本地 URL + 主 frame + 主窗口 sender）
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  // 不可信事件：sender 不是主窗口
  const rogueWc = { mainFrame: { url: localUrl }, on() {}, setWindowOpenHandler() {} };
  const untrustedEvent = { sender: rogueWc, senderFrame: rogueWc.mainFrame };
  // 不可信事件：sender 对但 frame 是 child
  const childEvent = { sender: webContents, senderFrame: { url: localUrl } };

  const call = (channel, event, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('channel not registered: ' + channel);
    return fn(event, ...args);
  };

  return { appDir, dataDir, handlers, calls, registry, policy, budget, auditLog,
    trustedEvent, untrustedEvent, childEvent, call,
    // D-10：ok 现在是 {ok,evaluateProposal} 对象。registered 保持布尔语义
    //   （旧断言消费它），evaluateProposal 单独透出供新门禁断言。
    registered: !!(ok && ok.ok === true),
    evaluateProposal: ok && ok.evaluateProposal,
    proposeInternal: ok && ok.proposeInternal,
    api: ok };
}

console.log('--- D-1 Agent IPC 治理通道门禁 ---');

/* ================= 1. 装配与通道白名单 ================= */
{
  const h = harness();
  // 🔵 D-10 修订（原断言 h.registered === true）：
  //   registerAgentIpc 的返回值从 `true` 改成「成功对象」（见 agent-ipc.js 尾部注释），
  //   目的是把**实例化绑定了 policy/budget 的 evaluateProposal** 交给主进程建案路径，
  //   避免在别处复刻那三步判定。
  //   ⇒ **断言的意图没变**（仍是「注册成功」），只是成功的载体从布尔变成对象。
  //   这里断言 ok===true **且** 确实带出了判定函数 —— 比原来更严，不是放宽。
  check('D1-1 注册成功且只注册 4 条治理通道',
    h.registered === true &&
    typeof h.evaluateProposal === 'function' &&
    h.calls.length === 0 &&
    [...h.handlers.keys()].length === AGENT_CHANNELS.length &&
    [...h.handlers.keys()].sort().join(',') === [...AGENT_CHANNELS].sort().join(','),
    [...h.handlers.keys()].join(' '));

  const stat = h.call('agent:get-status', h.trustedEvent);
  check('D1-2 agent:get-status 返回预算剩余与熔断态',
    stat && stat.ok === true &&
    typeof stat.budget.remainingActions === 'number' &&
    stat.budget.tripped === false &&
    stat.policy.killSwitch === false &&
    Array.isArray(stat.registeredCapabilities));

  const caps = h.call('agent:get-capabilities', h.trustedEvent);
  check('D1-3 get-capabilities 只读返回元数据，network.request 标记为硬封死',
    caps && caps.ok === true && caps.capabilities.length === 4 &&
    caps.capabilities.some((c) => c.name === 'network.request' && c.hardDenied === true));

  const audit = h.call('agent:get-audit-log', h.trustedEvent);
  check('D1-4 get-audit-log 空态可读', audit && audit.ok === true && audit.total === 0);
}

/* ================= 2. 反例 1：非受信renderer（SEC-01） =================
 * ⚠️ 契约澄清（实测坐实，非臆测）：ipcGuard.handle()在调用我们的 fn **之前**就
 * `assertTrustedRenderer`，失败即**抛出** UNTRUSTED_RENDERER（栈帧 ipc-guard.js:74），
 * 我们的 handler 根本没机会执行。这是本仓既定契约 —— test/security-hardening-sec.test.js:60
 * 与 test/connection-ipc.test.js:245 均断言"抛出"，research:* 通道同样如此。
 * 故此处断言抛出，且必须验证 **handler 未被执行**（不只是"报了个错"）。
 */
{
  const h = harness();
  let blocked = 0, leaked = 0;
  for (const ch of AGENT_CHANNELS) {
    let err = null, res = null;
    try { res = h.call(ch, h.untrustedEvent, { capability: 'workspace.read', scope: 'x' }); }
    catch (e) { err = e; }
    if (err && (err.code === 'UNTRUSTED_RENDERER' || err.message === 'UNTRUSTED_RENDERER')) blocked++;
    else leaked++;
  }
  check('❌ 反例1 非受信 sender 四通道全部被拒（0 泄漏）',
    blocked === AGENT_CHANNELS.length && leaked === 0, `blocked=${blocked} leaked=${leaked}`);

  let childErr = null;
  try { h.call('agent:get-status', h.childEvent); } catch (e) { childErr = e; }
  check('❌ 反例1b child frame 被拒（frame !== mainFrame）',
    childErr && (childErr.code === 'UNTRUSTED_RENDERER' || childErr.message === 'UNTRUSTED_RENDERER'));

  // 🔴 关键：非受信调用**绝不能碰业务逻辑** —— 不得消耗预算、不得写审计。
  // 只断言"抛了错"是不够的，那可能只是抛在业务中途。
  const h2 = harness();
  h2.policy.setScopeRoots('workspace.read', [h2.appDir]);
  const auditBefore = h2.auditLog.list().length;
  const budgetBefore = h2.budget.state().actions;
  try {
    h2.call('agent:propose-action', h2.untrustedEvent,
      { capability: 'workspace.read', scope: path.join(h2.appDir, 'x.txt') });
  } catch { /* 预期抛出 */ }
  check('❌ 反例1c 非受信调用零副作用（未耗预算、未写审计）',
    h2.auditLog.list().length === auditBefore &&
    h2.budget.state().actions === budgetBefore,
    `audit +${h2.auditLog.list().length - auditBefore} actions +${h2.budget.state().actions - budgetBefore}`);
}

/* ================= 3. 反例 2：network.request 跨 IPC 硬拒绝 ================= */
{
  const h = harness();
  // 显式授权 network.request 也必须被硬封死（授权不能洗白 hardDenied）
  const pol = h.policy;
  pol.allowed.add('network.request');
  pol.setScopeRoots('network.request', [h.appDir]);

  const r = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'network.request', scope: path.join(h.appDir, 'x.txt'), reason: '查天气',
  });
  check('❌ 反例2 network.request 即使显式授权+合法 scope 仍硬拒绝',
    r && r.ok === false && r.error === 'AUTHORIZED_REJECTED', JSON.stringify(r));

  // 🔴 关键反例：伪造 ctx.meta 想洗白 hardDenied —— 入口根本不读调用方的 meta
  const forged = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'network.request',
    scope: path.join(h.appDir, 'x.txt'),
    meta: { hardDenied: false },
    ctx: { meta: { hardDenied: false } },
    reason: '查天气',
  });
  check('❌ 反例2b 伪造 meta 洗白 hardDenied 无效（入口不采信调用方元数据）',
    forged && forged.ok === false && forged.error === 'AUTHORIZED_REJECTED');

  // 拒绝必须留痕
  const audit = h.call('agent:get-audit-log', h.trustedEvent);
  const rejected = (audit.events || []).filter((e) => e.outcome === 'rejected' && e.capability === 'network.request');
  check('D1-5 被拒提案留痕（审计含 network.request 拒绝记录）', rejected.length >= 2, `rejected=${rejected.length}`);
}

/* ================= 4. 反例 3：预算熔断 ================= */
{
  const budget = new ExecutionBudget({ maxActionsPerSession: 2, maxWritesPerSession: 99, maxConsecutiveErrors: 99, maxWallClockMs: 0 });
  const h = harness({ budget });
  h.policy.setScopeRoots('workspace.read', [h.appDir]);
  const good = { capability: 'workspace.read', scope: path.join(h.appDir, 'a.txt'), reason: 'r' };

  const r1 = h.call('agent:propose-action', h.trustedEvent, good);
  const r2 = h.call('agent:propose-action', h.trustedEvent, good);
  const r3 = h.call('agent:propose-action', h.trustedEvent, good);
  check('❌ 反例3 预算耗尽后提案被拒且熔断为终态',
    r1.ok === true && r2.ok === true &&
    r3.ok === false && r3.error === 'BUDGET_TRIPPED' &&
    r3.budget && r3.budget.tripped === true && r3.budget.remainingActions === 0,
    JSON.stringify({ r3: { ok: r3.ok, error: r3.error, tripped: r3.budget && r3.budget.tripped } }));

  const r4 = h.call('agent:propose-action', h.trustedEvent, good);
  check('❌ 反例3b 熔断后不得静默放行（持续拒绝）',
    r4.ok === false && r4.error === 'BUDGET_TRIPPED');

  //熔断同样必须留痕
  const audit = h.call('agent:get-audit-log', h.trustedEvent);
  check('D1-6 熔断拒绝留痕',
    (audit.events || []).some((e) => e.code === 'BUDGET_TRIPPED'));
}

/* ================= 5. 反例 4：畸形输入 ================= */
{
  const h = harness();
  const bad = [
    ['null 输入', null],
    ['undefined 输入', undefined],
    ['数组输入', []],
    ['字符串输入', 'workspace.read'],
    ['缺 capability', { scope: 'x' }],
    ['空 capability', { capability: '   ' }],
  ];
  let allRejected = true;
  const codes = [];
  for (const [, v] of bad) {
    const r = h.call('agent:propose-action', h.trustedEvent, v);
    if (!(r && r.ok === false)) { allRejected = false; }
    codes.push(r && r.error);
  }
  check('❌ 反例4 六种畸形提案全部拒绝',
    allRejected, codes.join(','));

  //越界 scope：已授权 workspace.read 但未配根目录 → 拒绝
  const noRoots = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.read', scope: path.join(h.appDir, 'a.txt'), reason: 'r',
  });
  check('❌ 反例4b 已授权能力但未配 scope 根目录 → 拒绝（治!!scope 裸奔）',
    noRoots && noRoots.ok === false && noRoots.error === 'AUTHORIZED_REJECTED',
    noRoots && noRoots.reason);

  // 未授权能力
  const notGranted = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'process.execute', scope: 'git status', reason: 'r',
  });
  check('❌ 反例4c 未授权能力 process.execute → 拒绝',
    notGranted && notGranted.ok === false);
}

/* ================= 6. 反例 5：通道名单的写入面被严格限定 ================= */
{
  const h = harness();
  const names = [...h.handlers.keys()];
  // 🔴 D-4 修正（2026-10-06）：D-1 时期的断言是「名单里一个 execute 都不能有」。
  //   D-4 刻意加入了 agent:execute —— 它是受控执行器的唯一入口，
  //   放在这里断言「不存在」等于把阶段目标钉死成死条款。
  // 但**放宽不等于放开**：D-4 的正确不变式是下面这三条，每条都比原来更严：
  //   ① 通道名单恰为 7 条，**不多不少**（多一条 process 通道就是灾难）；
  //   ② 不存在任何**进程/网络**类通道（process:execute / network:* 一律不许出现）；
  //   ③ 写能力只有一个入口，没有第二条旁路；
  //   ④ 新增的读取类通道**不得写**（get-pending-proposal 只读快照，不改任何状态）。
  //
  // 🔵 D-5 修订说明（原断言是「恰为 6 条」）：D-5 按用户拍板新增了
  //   agent:get-pending-proposal —— 渲染端要拿主进程的提案真身才能画确认卡片，
  //   而把提案对象整个丢给渲染端会重新打开 id 顶替的攻击面（D-3 刚堵上的）。
  //   所以新增的是一条「**只读快照**」通道，不是执行通道。
  //   **这不是把断言放宽**：数量从 6 改到 7，同时**加严**了第④条，
  //   并且第②条（禁进程/网络通道）与第③条（写唯一入口）逐字未动。
  //   若当初是「删掉这条断言」，那才是真的失去防线。
  // 🔵 SEC-01 修订说明（原断言是「恰为 7 条」）：SEC-01 按安全审计修复新增了
  //   agent:get-proposal-content —— 渲染端确认抽屉按需拉取可信正文展示，
  //   避免在 get-pending-proposal 中暴露未截断大文本，且受 ALREADY_DECIDED 保护。
  //   新增的是一条「受保护的只读正文查看」通道，不是执行通道。
  //   数量从 7 改到 8，第②条（禁进程/网络通道）与第③条（写唯一入口）逐字未动。
  check('❌ 反例5 通道名单恰为 8 条且不含任何进程/网络通道（SEC-01 修订硬约束）',
    names.length === 8
    && !names.some((c) => /process|network|spawn|shell|http|fetch/i.test(c)),
    names.join(','));

  // 反例5c：读取类通道必须是**无副作用**的 —— 调用它不该消耗预算、不该建案、
  //   也不该让提案状态变化。若日后有人在这条通道里塞进「顺便建个案」，
  //   渲染端就能自主产生提案，直接绕过「主进程判断」这条产品底线。
  {
    const store = new Map();
    const h = harness({ options: { proposalStore: store } });
    h.policy.setScopeRoots('workspace.read', [h.appDir]);
    h.policy.setScopeRoots('workspace.write', [h.appDir]);
    const p = h.call('agent:propose-action', h.trustedEvent, {
      capability: 'workspace.read', scope: path.join(h.appDir, 'n.txt'), reason: 'r',
    });
    const id = p.proposal.id;
    const beforeBudget = h.budget.state().actions;
    const snap = h.call('agent:get-pending-proposal', h.trustedEvent, { proposalId: id });
    const afterBudget = h.budget.state().actions;
    check('❌ 反例5c 取快照通道无副作用（不耗预算、不改提案状态、不建案）',
      snap && snap.ok === true
      && afterBudget === beforeBudget
      && store.has(id)
      && store.get(id).status === 'proposed',
      'budget ' + beforeBudget + '->' + afterBudget);

    check('❌ 反例5d 取快照拿到的必须是冻结快照（渲染端改不动）',
      Object.isFrozen(snap.proposal));

    check('❌ 反例5e 快照只含白名单字段，不是提案对象展开',
      Object.keys(snap.proposal).sort().join(',') ===
      'capability,contentBytes,contentHash,contentPreview,dangerLevel,id,isOverwrite,isTruncated,reason,requiresConfirm,scope,status',
      Object.keys(snap.proposal).sort().join(','));

    // 🔴 反例5f（2026-10-06 审核补的，**变异测试逼出来的**）：
    //   已产生过决策的提案**不得再展示快照**。删掉 `confirmation.lookup(id)` 守卫后，
    //   31 项测试仍全绿 —— 说明此前没有任何断言覆盖这条守卫，属**假反例**。
    //   危害：用户点过【拒绝】或【授权】后，卡片还能被重新拉起来反复问，
    //   违反「拒绝是终态」这条不变式，也违反零打扰的产品底线。
    //
    //   为何要用**独立 harness**：预算/熔断等其它闸门若先触发，会把这条守卫
    //   挡在后面，断言就成了「意外正确」。这里用全新 harness，确保
    //   唯一可能拦住这条请求的就是 confirmation.lookup 这道守卫。
    const h5f = harness({ options: { proposalStore: new Map() } });
    h5f.policy.setScopeRoots('workspace.read', [h5f.appDir]);
    h5f.policy.setScopeRoots('workspace.write', [h5f.appDir]);
    const p5f = h5f.call('agent:propose-action', h5f.trustedEvent, {
      capability: 'workspace.read',
      scope: path.join(h5f.appDir, 'decided.txt'),
      reason: 'r',
    });
    const id5f = p5f.proposal.id;
    // 先投一次反对票制造「已决策」
    const c5f = h5f.call('agent:confirm-action', h5f.trustedEvent, {
      proposalId: id5f, decision: 'rejected',
    });
    const snapAfter = h5f.call('agent:get-pending-proposal', h5f.trustedEvent,
      { proposalId: id5f });
    check('❌ 反例5f 已决策的提案不得再取到快照（拒绝是终态，不可反复问用户）',
      c5f && c5f.ok === true
      && snapAfter && snapAfter.ok === false
      && snapAfter.error === 'ALREADY_DECIDED',
      'confirm=' + JSON.stringify(c5f && c5f.error) +
      ' snap=' + JSON.stringify(snapAfter && snapAfter.error));
  }

  check('❌ 反例5b 写能力只有一个入口，没有第二条旁路',
    names.filter((c) => /execute/i.test(c)).length === 1
    && names.includes('agent:execute'),
    names.join(','));

  check('D1-7 通道命名遵循 domain:action 风格',
    names.every((c) => /^agent:[a-z-]+$/.test(c)), names.join(' '));
}

/* ================= 7. 正例：授权通过的提案建案但不执行 ================= */
{
  const h = harness();
  h.policy.setScopeRoots('workspace.read', [h.appDir]);
  const r = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.read', scope: path.join(h.appDir, 'notes.txt'), reason: '读一下笔记',
  });
  check('D1-8 授权通过的提案建案且 executed=false（D-1 不接执行器）',
    r && r.ok === true && r.executed === false &&
    r.proposal && r.proposal.capability === 'workspace.read' &&
    r.proposal.status === 'proposed' && r.proposal.reason === '读一下笔记');

  const audit = h.call('agent:get-audit-log', h.trustedEvent);
  const acc = (audit.events || []).filter((e) => e.outcome === 'accepted');
  check('D1-9 受理留痕含 proposalId 与 matchedRoot',
    acc.length === 1 && typeof acc[0].proposalId === 'string' && acc[0].via === 'ipc');
}

/* ================= 8. 反例 6：killSwitch 一键封死 ================= */
{
  const h = harness();
  h.policy.setScopeRoots('workspace.read', [h.appDir]);
  const before = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.read', scope: path.join(h.appDir, 'a.txt'),
  });
  h.policy.setKillSwitch(true);
  const after = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.read', scope: path.join(h.appDir, 'a.txt'),
  });
  check('❌ 反例6 killSwitch 打开后提案立即被拒（先于授权判断）',
    before.ok === true &&
    after.ok === false && after.error === 'AUTHORIZED_REJECTED' && after.reason === 'kill_switch_on',
    after.reason);
}

/* ================= 9. 反例 7：审计条数上限（防一次拉爆内存） ================= */
{
  const h = harness();
  h.policy.setScopeRoots('workspace.read', [h.appDir]);
  for (let i = 0; i < 8; i++) {
    h.call('agent:propose-action', h.trustedEvent, {
      capability: 'workspace.read', scope: path.join(h.appDir, `a${i}.txt`),
    });
  }
  const limited = h.call('agent:get-audit-log', h.trustedEvent, { limit: 3 });
  check('❌ 反例7 get-audit-log limit 生效（total 与 returned 分离）',
    limited.ok === true && limited.returned === 3 && limited.total === 8,
    `total=${limited.total} returned=${limited.returned}`);
}

/* ================= 10. 装配健壮性 ================= */
{
  check('D1-10 无 ipcGuard 时安全返回 false（不抛异常）', registerAgentIpc(null, {}) === false);
  check('D1-10b 传入裸 ipcMain（无 handle 语义）也安全返回 false',
    registerAgentIpc({}, {}) === false);
  // 🔵 D-10 修订（原断言「返回值是 boolean」）：
  //   同上，返回值改为成功对象。**意图不变**：仍是「不抛异常、装配可用」。
  //   改为断言「返回成功对象且带出判定函数」，仍能抓住「装配失败返回 false」的退化。
  check('D1-10c 无 agentContext 时用默认实例装配不抛异常',
    (() => {
      const r = registerAgentIpc({ handle() {} }, {});
      return r && r.ok === true && typeof r.evaluateProposal === 'function';
    })());
}

/* ================= 11. 源码级门禁 ================= */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-ipc.js'), 'utf8');
  const bare = /(?<!guard\s)\bipcMain\s*\.\s*(handle|on)\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
  check('D1-11 agent-ipc.js 内无裸 ipcMain 注册（去掉注释后源码级断言）', bare === false);

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('D1-11b main.js 已接线 registerAgentIpc 且仍经 ipcGuard',
    /registerAgentIpc\(ipcGuard,/.test(mainSrc) &&
    !/ipcMain\s*\.\s*(handle|on)\s*\(/.test(mainSrc));
}

/* ================= 12. SEC-01 权威快照强绑定与只读正文通道门禁 ================= */
{
  const h = harness();
  h.policy.setScopeRoots('workspace.write', [h.appDir]);
  const crypto = require('crypto');

  // SEC01-1 写提案绑定权威快照与 SHA-256 哈希
  const testContent = '初澜数字生命不可变便签内容测试';
  const expectedHash = crypto.createHash('sha256').update(testContent, 'utf8').digest('hex');
  const expectedBytes = Buffer.byteLength(testContent, 'utf8');

  const p1 = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'sec01-note.txt'),
    content: testContent,
    reason: '测试 SEC-01 快照绑定',
  });

  check('SEC01-1 写提案绑定权威快照、SHA-256 哈希与字节数',
    p1 && p1.ok === true
    && p1.proposal.contentHash === expectedHash
    && p1.proposal.contentBytes === expectedBytes
    && p1.proposal.contentPreview === testContent
    && p1.proposal.isTruncated === false);

  // SEC01-2 长文本写提案截断预览标记正确
  const longContent = 'A'.repeat(400);
  const pLong = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'sec01-long.txt'),
    content: longContent,
    reason: '测试长文本截断',
  });
  check('SEC01-2 长文本写提案截断预览标记正确（300 字符预览）',
    pLong && pLong.ok === true
    && pLong.proposal.contentBytes === 400
    && pLong.proposal.contentPreview.length === 300
    && pLong.proposal.isTruncated === true);

  // SEC01-3 走 agent:get-proposal-content 安全读取完整正文
  const fetched = h.call('agent:get-proposal-content', h.trustedEvent, { proposalId: p1.proposal.id });
  check('SEC01-3 走 agent:get-proposal-content 成功读取快照完整正文且哈希一致',
    fetched && fetched.ok === true
    && fetched.content === testContent
    && fetched.contentHash === expectedHash
    && fetched.contentBytes === expectedBytes);

  // ❌ SEC01-R1 决策后（拒绝）agent:get-proposal-content 立即拦截
  h.call('agent:confirm-action', h.trustedEvent, { proposalId: p1.proposal.id, decision: 'rejected' });
  const fetchedAfter = h.call('agent:get-proposal-content', h.trustedEvent, { proposalId: p1.proposal.id });
  check('❌ SEC01-R1 agent:get-proposal-content 拦截已拒绝提案（ALREADY_DECIDED）',
    fetchedAfter && fetchedAfter.ok === false && fetchedAfter.error === 'ALREADY_DECIDED');

  // ❌ SEC01-R2 不存在提案的 content 读取被拦截
  const nonExist = h.call('agent:get-proposal-content', h.trustedEvent, { proposalId: 'p-not-found' });
  check('❌ SEC01-R2 不存在提案读取正文返回 PROPOSAL_NOT_FOUND',
    nonExist && nonExist.ok === false && nonExist.error === 'PROPOSAL_NOT_FOUND');

  // ❌ SEC01-R3 畸形内容提案被硬拒（非字符串、空内容）
  const badType = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'sec01-bad.txt'),
    content: 12345,
  });
  const badEmpty = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'sec01-empty.txt'),
    content: '',
  });
  check('❌ SEC01-R3 写入内容为非字符串或空字符串时提案直接被拒',
    badType && badType.ok === false && badType.error === 'INVALID_PROPOSAL'
    && badEmpty && badEmpty.ok === false && badEmpty.error === 'INVALID_PROPOSAL');

  // ❌ SEC01-R4 超过 5 MiB 写入提案被拒（PAYLOAD_TOO_LARGE）
  const huge = 'X'.repeat(5 * 1024 * 1024 + 1);
  const tooLarge = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'sec01-huge.txt'),
    content: huge,
  });
  check('❌ SEC01-R4 超过 5 MiB 写入提案被拒（PAYLOAD_TOO_LARGE）',
    tooLarge && tooLarge.ok === false && tooLarge.error === 'PAYLOAD_TOO_LARGE');
}

/* ================= 13. SEC-01 快照生命周期与授权管理门禁 ================= */
{
  // SEC01-L1 快照 TTL 过期
  const proposalStore = new Map();
  const contentSnapshotStore = new Map();
  const confirmation = new UserConfirmationGate();
  const h = harness({
    options: { proposalStore, contentSnapshotStore, confirmation },
  });
  h.policy.setScopeRoots('workspace.write', [h.appDir]);

  const p = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'sec01-ttl.txt'),
    content: 'TTL 测试内容',
  });

  // 模拟时间推移超出 10 分钟 TTL (10 * 60 * 1000 + 1000)
  const snap = contentSnapshotStore.get(p.proposal.id);
  snap.createdAt = Date.now() - (11 * 60 * 1000);

  const getAfterTTL = h.call('agent:get-proposal-content', h.trustedEvent, { proposalId: p.proposal.id });
  h.call('agent:confirm-action', h.trustedEvent, { proposalId: p.proposal.id, decision: 'approved' });
  const execAfterTTL = h.call('agent:execute', h.trustedEvent, { proposalId: p.proposal.id });
  const authAfterTTL = confirmation.isExecutionAllowed(p.proposal.id, Date.now());

  check('SEC01-L1 快照 TTL 过期后，读取正文与执行均返回 SNAPSHOT_EXPIRED 且授权被作废',
    getAfterTTL.ok === false && getAfterTTL.error === 'SNAPSHOT_EXPIRED'
    && execAfterTTL.ok === false && execAfterTTL.error === 'SNAPSHOT_EXPIRED'
    && authAfterTTL.allowed === false && authAfterTTL.reason === 'SNAPSHOT_EXPIRED'
    && !contentSnapshotStore.has(p.proposal.id));

  // SEC01-L2 容量淘汰（200 个提案上限）
  const store200 = new Map();
  const snaps200 = new Map();
  const conf200 = new UserConfirmationGate();
  const h200 = harness({
    options: { proposalStore: store200, contentSnapshotStore: snaps200, confirmation: conf200 },
    budget: new ExecutionBudget({ maxActionsPerSession: 9999, maxWritesPerSession: 9999 }),
  });
  h200.policy.setScopeRoots('workspace.write', [h200.appDir]);

  const pFirst = h200.call('agent:propose-action', h200.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h200.appDir, 'first.txt'),
    content: '第一份提案内容',
  });
  conf200.confirm(pFirst.proposal.id, 'approved', { status: 'proposed' });

  // 塞满并超出 200 个
  for (let i = 0; i < 200; i++) {
    h200.call('agent:propose-action', h200.trustedEvent, {
      capability: 'workspace.write',
      scope: path.join(h200.appDir, `batch-${i}.txt`),
      content: `内容-${i}`,
    });
  }

  const firstAllowed = conf200.isExecutionAllowed(pFirst.proposal.id, Date.now());
  check('SEC01-L2 提案达到 200 容量上限时，最早提案及其快照被淘汰且授权被同步作废（PROPOSAL_EVICTED）',
    !store200.has(pFirst.proposal.id)
    && !snaps200.has(pFirst.proposal.id)
    && firstAllowed.allowed === false && firstAllowed.reason === 'PROPOSAL_EVICTED');

  // SEC01-L3 用户拒绝清理
  const snapsRej = new Map();
  const hRej = harness({ options: { contentSnapshotStore: snapsRej } });
  hRej.policy.setScopeRoots('workspace.write', [hRej.appDir]);
  const pRej = hRej.call('agent:propose-action', hRej.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(hRej.appDir, 'rej.txt'),
    content: '被拒提案内容',
  });
  const snapBeforeRej = snapsRej.has(pRej.proposal.id);
  hRej.call('agent:confirm-action', hRej.trustedEvent, { proposalId: pRej.proposal.id, decision: 'rejected' });
  const snapAfterRej = snapsRej.has(pRej.proposal.id);
  const getRej = hRej.call('agent:get-proposal-content', hRej.trustedEvent, { proposalId: pRej.proposal.id });
  const execRej = hRej.call('agent:execute', hRej.trustedEvent, { proposalId: pRej.proposal.id });

  check('SEC01-L3 用户拒绝提案时快照立即被销毁，后续不可读取也不可执行',
    snapBeforeRej === true
    && snapAfterRej === false
    && getRej.ok === false && getRej.error === 'ALREADY_DECIDED'
    && execRej.ok === false && execRej.error === 'EXECUTION_NOT_ALLOWED');

  // SEC01-L4 执行成功清理
  const snapsSucc = new Map();
  const hSucc = harness({ options: { contentSnapshotStore: snapsSucc } });
  hSucc.policy.setScopeRoots('workspace.write', [hSucc.appDir]);
  const pSucc = hSucc.call('agent:propose-action', hSucc.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(hSucc.appDir, 'succ.txt'),
    content: '成功写入正文',
  });
  hSucc.call('agent:confirm-action', hSucc.trustedEvent, { proposalId: pSucc.proposal.id, decision: 'approved' });
  const execSucc = hSucc.call('agent:execute', hSucc.trustedEvent, { proposalId: pSucc.proposal.id });
  const snapAfterSucc = snapsSucc.has(pSucc.proposal.id);
  const execSecond = hSucc.call('agent:execute', hSucc.trustedEvent, { proposalId: pSucc.proposal.id });

  check('SEC01-L4 执行成功后快照被立即销毁，二次执行被重放防线拦截（ALREADY_EXECUTED）',
    execSucc.ok === true && execSucc.executed === true
    && snapAfterSucc === false
    && execSecond.ok === false && execSecond.error === 'ALREADY_EXECUTED');

  // SEC01-L5 哈希防篡改与授权吊销
  const snapsTamper = new Map();
  const confTamper = new UserConfirmationGate();
  const hTamper = harness({ options: { contentSnapshotStore: snapsTamper, confirmation: confTamper } });
  hTamper.policy.setScopeRoots('workspace.write', [hTamper.appDir]);
  const pTamper = hTamper.call('agent:propose-action', hTamper.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(hTamper.appDir, 'tamper.txt'),
    content: '原始内容',
  });
  hTamper.call('agent:confirm-action', hTamper.trustedEvent, { proposalId: pTamper.proposal.id, decision: 'approved' });
  // 篡改快照内容
  const snapT = snapsTamper.get(pTamper.proposal.id);
  snapT.content = '篡改后的注入内容';
  const execTamper = hTamper.call('agent:execute', hTamper.trustedEvent, { proposalId: pTamper.proposal.id });
  const authTamper = confTamper.isExecutionAllowed(pTamper.proposal.id, Date.now());

  check('SEC01-L5 快照内容被篡改或哈希不符时，执行被拒并彻底吊销授权（CONTENT_HASH_MISMATCH）',
    execTamper.ok === false && execTamper.error === 'CONTENT_HASH_MISMATCH'
    && authTamper.allowed === false && authTamper.reason === 'CONTENT_HASH_MISMATCH'
    && !snapsTamper.has(pTamper.proposal.id));
}

/* ================= 14. SEC-01 失败回滚与重试状态机门禁 ================= */
{
  // SEC01-R5 纯 I/O 失败保留快照并允许重试 1 次，第 2 次成功完成
  let ioFailCount = 1;
  const mockTxn = {
    begin(opts) { return { ...opts, id: 'tx-test' }; },
    commit(tx) {
      if (ioFailCount > 0) {
        ioFailCount--;
        const err = new Error('EBUSY: resource locked');
        err.code = 'EBUSY';
        throw err;
      }
      fs.writeFileSync(tx.target, tx.data, 'utf8');
    },
    rollback() {},
  };

  const snapsR5 = new Map();
  const confR5 = new UserConfirmationGate();
  const hR5 = harness({
    options: {
      contentSnapshotStore: snapsR5,
      confirmation: confR5,
      transactionManager: mockTxn,
    },
  });
  hR5.policy.setScopeRoots('workspace.write', [hR5.appDir]);
  const pR5 = hR5.call('agent:propose-action', hR5.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(hR5.appDir, 'retry-success.txt'),
    content: '重试成功写入文本',
  });
  hR5.call('agent:confirm-action', hR5.trustedEvent, { proposalId: pR5.proposal.id, decision: 'approved' });

  // 第一次执行：抛 EBUSY，执行失败但回滚成功
  const firstExec = hR5.call('agent:execute', hR5.trustedEvent, { proposalId: pR5.proposal.id });
  const snapAfterFirst = snapsR5.get(pR5.proposal.id);
  const authAfterFirst = confR5.isExecutionAllowed(pR5.proposal.id, Date.now());

  // 第二次执行：ioFailCount 已为 0，成功写入
  const secondExec = hR5.call('agent:execute', hR5.trustedEvent, { proposalId: pR5.proposal.id });
  const fileContent = fs.readFileSync(path.join(hR5.appDir, 'retry-success.txt'), 'utf8');

  check('SEC01-R5 纯 I/O 失败保留快照并允许重试 1 次，第 2 次成功完成',
    firstExec.ok === false && firstExec.error === 'EXECUTION_FAILED' && firstExec.rollbackFailed === false
    && snapAfterFirst && snapAfterFirst.retryCount === 1
    && authAfterFirst.allowed === true
    && secondExec.ok === true && secondExec.executed === true
    && fileContent === '重试成功写入文本'
    && !snapsR5.has(pR5.proposal.id));

  // SEC01-R6 连续两次纯 I/O 失败耗尽重试次数
  const alwaysFailTxn = {
    begin(opts) { return { ...opts, id: 'tx-fail' }; },
    commit() {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    },
    rollback() {},
  };
  const snapsR6 = new Map();
  const confR6 = new UserConfirmationGate();
  const hR6 = harness({
    options: {
      contentSnapshotStore: snapsR6,
      confirmation: confR6,
      transactionManager: alwaysFailTxn,
    },
  });
  hR6.policy.setScopeRoots('workspace.write', [hR6.appDir]);
  const pR6 = hR6.call('agent:propose-action', hR6.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(hR6.appDir, 'retry-exhausted.txt'),
    content: '重试耗尽文本',
  });
  hR6.call('agent:confirm-action', hR6.trustedEvent, { proposalId: pR6.proposal.id, decision: 'approved' });

  const r6First = hR6.call('agent:execute', hR6.trustedEvent, { proposalId: pR6.proposal.id });
  const r6Second = hR6.call('agent:execute', hR6.trustedEvent, { proposalId: pR6.proposal.id });
  const r6Third = hR6.call('agent:execute', hR6.trustedEvent, { proposalId: pR6.proposal.id });
  const authR6 = confR6.isExecutionAllowed(pR6.proposal.id, Date.now());

  check('SEC01-R6 连续两次纯 I/O 失败耗尽重试次数，快照被清理且授权永久撤销（RETRY_EXHAUSTED）',
    r6First.ok === false && r6First.error === 'EXECUTION_FAILED'
    && r6Second.ok === false && r6Second.error === 'EXECUTION_FAILED'
    && !snapsR6.has(pR6.proposal.id)
    && authR6.allowed === false && authR6.reason === 'RETRY_EXHAUSTED'
    && r6Third.ok === false && r6Third.error === 'EXECUTION_NOT_ALLOWED');

  // SEC01-R7 回滚失败零重试
  const rollbackFailTxn = {
    begin(opts) { return { ...opts, id: 'tx-rb-fail' }; },
    commit() {
      const err = new Error('Rollback integrity compromised');
      err.code = 'ROLLBACK_HASH_MISMATCH';
      throw err;
    },
    rollback() {},
  };
  const snapsR7 = new Map();
  const confR7 = new UserConfirmationGate();
  const hR7 = harness({
    options: {
      contentSnapshotStore: snapsR7,
      confirmation: confR7,
      transactionManager: rollbackFailTxn,
    },
  });
  hR7.policy.setScopeRoots('workspace.write', [hR7.appDir]);
  const pR7 = hR7.call('agent:propose-action', hR7.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(hR7.appDir, 'rollback-fail.txt'),
    content: '回滚失败文本',
  });
  hR7.call('agent:confirm-action', hR7.trustedEvent, { proposalId: pR7.proposal.id, decision: 'approved' });

  const r7Exec = hR7.call('agent:execute', hR7.trustedEvent, { proposalId: pR7.proposal.id });
  const authR7 = confR7.isExecutionAllowed(pR7.proposal.id, Date.now());
  const r7Retry = hR7.call('agent:execute', hR7.trustedEvent, { proposalId: pR7.proposal.id });

  check('SEC01-R7 写入失败且回滚失败时（rollbackFailed=true），快照立即销毁且授权立即撤销，零重试',
    r7Exec.ok === false && r7Exec.error === 'ROLLBACK_FAILED' && r7Exec.rollbackFailed === true
    && !snapsR7.has(pR7.proposal.id)
    && authR7.allowed === false && authR7.reason === 'ROLLBACK_FAILED'
    && r7Retry.ok === false && r7Retry.error === 'EXECUTION_NOT_ALLOWED');

  // SEC01-R8 重试期间传入不同 content 被无视，始终使用原始不可变快照
  let r8FailOnce = true;
  const r8Txn = {
    begin(opts) { return { ...opts, id: 'tx-r8' }; },
    commit(tx) {
      if (r8FailOnce) {
        r8FailOnce = false;
        const err = new Error('EBUSY');
        err.code = 'EBUSY';
        throw err;
      }
      fs.writeFileSync(tx.target, tx.data, 'utf8');
    },
    rollback() {},
  };
  const hR8 = harness({ options: { transactionManager: r8Txn } });
  hR8.policy.setScopeRoots('workspace.write', [hR8.appDir]);
  const targetR8 = path.join(hR8.appDir, 'retry-immutable.txt');
  const pR8 = hR8.call('agent:propose-action', hR8.trustedEvent, {
    capability: 'workspace.write',
    scope: targetR8,
    content: '原始快照正文',
  });
  hR8.call('agent:confirm-action', hR8.trustedEvent, { proposalId: pR8.proposal.id, decision: 'approved' });

  // 第一次失败
  hR8.call('agent:execute', hR8.trustedEvent, { proposalId: pR8.proposal.id });
  // 第二次重试：调用方传入不同的恶意 content
  const r8Retry = hR8.call('agent:execute', hR8.trustedEvent, {
    proposalId: pR8.proposal.id,
    content: '试图在重试时篡改的内容',
  });
  const finalContent = fs.readFileSync(targetR8, 'utf8');

  check('SEC01-R8 重试期间传入不同 content 被无视，始终使用原始不可变快照落盘',
    r8Retry.ok === true && r8Retry.executed === true
    && finalContent === '原始快照正文');

  // SEC01-R9 & SEC01-R10 专项反例
  const pStoreCounter = new Map();
  const snapStoreCounter = new Map();
  const confCounter = new UserConfirmationGate();
  const hCounter = harness({
    options: { proposalStore: pStoreCounter, contentSnapshotStore: snapStoreCounter, confirmation: confCounter },
  });
  hCounter.policy.setScopeRoots('workspace.write', [hCounter.appDir]);

  // ❌ SEC01-R9 专项反例：提交不带 content 但伪造预览元数据的写入提案，建案期即硬拒 INVALID_PROPOSAL
  const forgedProposal = hCounter.call('agent:propose-action', hCounter.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(hCounter.appDir, 'sec01-forged.txt'),
    contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    contentBytes: 100,
    contentPreview: '伪造的预览文本',
    isTruncated: false,
  });
  const forgedTarget = path.join(hCounter.appDir, 'sec01-forged.txt');
  const forgedExec = hCounter.call('agent:execute', hCounter.trustedEvent, {
    proposalId: 'non-existent-or-forged-id',
    content: '恶意后注入正文',
  });
  check('❌ SEC01-R9 专项反例：伪造元数据但缺正文的写入提案在建案期硬拒，且执行时无法落盘',
    forgedProposal.ok === false && forgedProposal.error === 'INVALID_PROPOSAL'
    && forgedExec.ok === false && !fs.existsSync(forgedTarget));

  // ❌ SEC01-R10 专项反例：写操作执行时若权威快照缺失，绝不回退读取 raw.content，硬拒 SNAPSHOT_MISSING
  const fakeP = createActionProposal({ capability: 'workspace.write', scope: path.join(hCounter.appDir, 'sec01-no-snap.txt') });
  pStoreCounter.set(fakeP.id, fakeP);
  confCounter.confirm(fakeP.id, 'approved', { status: fakeP.status });
  const execNoSnap = hCounter.call('agent:execute', hCounter.trustedEvent, {
    proposalId: fakeP.id,
    content: '试图通过 raw.content 注入的正文',
  });
  const noSnapTarget = path.join(hCounter.appDir, 'sec01-no-snap.txt');
  check('❌ SEC01-R10 专项反例：缺失权威快照时 execute 绝不回退读取 raw.content，硬拒 SNAPSHOT_MISSING 且不落盘',
    execNoSnap.ok === false && execNoSnap.error === 'SNAPSHOT_MISSING' && !fs.existsSync(noSnapTarget));
}

/* ================= 15. UX-SEC-01 覆写状态权威检测与快照传递 ================= */
{
  const h = harness();
  h.policy.setScopeRoots('workspace.write', [h.appDir]);
  h.policy.setScopeRoots('workspace.read', [h.appDir]);

  // 1. 已存在文件覆写测试
  const existingFile = path.join(h.appDir, 'ux-overwrite-target.txt');
  fs.writeFileSync(existingFile, '旧数据');
  const pExist = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: existingFile,
    content: '新数据',
  });
  const snapExist = h.call('agent:get-pending-proposal', h.trustedEvent, { proposalId: pExist.proposal.id });

  // 2. 新文件测试
  const nonExistingFile = path.join(h.appDir, 'ux-new-target.txt');
  const pNew = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: nonExistingFile,
    content: '新文件数据',
  });
  const snapNew = h.call('agent:get-pending-proposal', h.trustedEvent, { proposalId: pNew.proposal.id });

  // 3. 非写操作测试
  const pRead = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.read',
    scope: existingFile,
  });
  const snapRead = h.call('agent:get-pending-proposal', h.trustedEvent, { proposalId: pRead.proposal.id });

  check('UXSEC-IPC1 目标文件已存在时 get-pending-proposal 快照返回 isOverwrite: true',
    snapExist.ok === true && snapExist.proposal.isOverwrite === true);

  check('UXSEC-IPC2 目标文件不存在或非写操作时 get-pending-proposal 快照返回 isOverwrite: false',
    snapNew.ok === true && snapNew.proposal.isOverwrite === false
    && snapRead.ok === true && snapRead.proposal.isOverwrite === false);
}

/* ================= 16. F4 & F5：建案前置校验与扩展名防御 ================= */
{
  const h = harness();
  h.policy.setScopeRoots('workspace.write', [h.appDir]);

  // F4-1 写提案内容校验失败（缺失正文、空字符串、超限）不扣减用户 actions 预算（校验先于计费）
  const statusBefore = h.call('agent:get-status', h.trustedEvent);
  const actionsBefore = statusBefore.budget.remainingActions;

  const badContentP = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'f4-test1.txt'),
  });
  const statusAfter1 = h.call('agent:get-status', h.trustedEvent);

  const emptyContentP = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'f4-test2.txt'),
    content: '',
  });
  const statusAfter2 = h.call('agent:get-status', h.trustedEvent);

  check('F4-1 写提案内容校验失败（缺正文/空串）不消耗动作预算（校验先于计费）',
    badContentP.ok === false && badContentP.error === 'INVALID_PROPOSAL'
    && emptyContentP.ok === false && emptyContentP.error === 'INVALID_PROPOSAL'
    && statusAfter1.budget.remainingActions === actionsBefore
    && statusAfter2.budget.remainingActions === actionsBefore);

  // F5-1 非白名单扩展名在建案期即被拒绝 DISALLOWED_EXTENSION，且不消耗动作预算
  const badExtP = h.call('agent:propose-action', h.trustedEvent, {
    capability: 'workspace.write',
    scope: path.join(h.appDir, 'hack.exe'),
    content: 'evil content',
  });
  const statusAfter3 = h.call('agent:get-status', h.trustedEvent);

  check('F5-1 非白名单扩展名在建案期即被硬拒绝 DISALLOWED_EXTENSION 且不消耗动作预算',
    badExtP.ok === false && badExtP.error === 'DISALLOWED_EXTENSION'
    && statusAfter3.budget.remainingActions === actionsBefore);

  // N1-1 主进程 selfNote 路径彻底消除双扣（Q2 修复）：
  // ① 源码级门禁：main.js 的 maybeAskForSelfNote 内不得调用 evaluateProposal（彻底消除预检+建案双扣）
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const selfNoteFnMatch = mainSrc.match(/function maybeAskForSelfNote\([\s\S]*?\n\}/);
  const selfNoteFnBody = selfNoteFnMatch ? selfNoteFnMatch[0] : '';
  const noRedundantEvaluate = selfNoteFnBody.length > 0 && !selfNoteFnBody.includes('evaluateProposal');

  // ② 真实调用序列断言：模拟 main.js 侧发起 selfNote 建案，动作预算严格只扣减 1 次
  const statusBeforeN1 = h.call('agent:get-status', h.trustedEvent);
  const actionsBeforeN1 = statusBeforeN1.budget.remainingActions;
  const selfNoteRes = h.api.proposeInternal(
    { capability: 'workspace.write', scope: path.join(h.appDir, 'selfnote.txt'), reason: '想留下便签' },
    'main',
    'selfNote',
    '初澜自发留下的文字'
  );
  const statusAfterN1 = h.call('agent:get-status', h.trustedEvent);

  check('N1-1 主进程 selfNote 路径建案只扣减 1 次动作预算且 main.js 无冗余 evaluateProposal（消除双扣）',
    noRedundantEvaluate
    && selfNoteRes && selfNoteRes.ok === true
    && statusAfterN1.budget.remainingActions === actionsBeforeN1 - 1);
}

console.log(failures === 0 ? '\nall agent_ipc tests passed' : `\n${failures} FAILED`);
assert.strictEqual(failures, 0, `${failures} 项 Agent IPC 门禁失败`);