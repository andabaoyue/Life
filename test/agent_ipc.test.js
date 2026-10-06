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
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
} = require('../src/agent-interfaces');

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
    trustedEvent, untrustedEvent, childEvent, call, registered: ok };
}

console.log('--- D-1 Agent IPC 治理通道门禁 ---');

/* ================= 1. 装配与通道白名单 ================= */
{
  const h = harness();
  check('D1-1 注册成功且只注册 4 条治理通道',
    h.registered === true &&
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
  check('❌ 反例5 通道名单恰为 7 条且不含任何进程/网络通道（D-5 修订硬约束）',
    names.length === 7
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
      'capability,dangerLevel,id,reason,requiresConfirm,scope,status',
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
  check('D1-10c 无 agentContext 时用默认实例装配不抛异常',
    typeof registerAgentIpc({ handle() {} }, {}) === 'boolean');
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

console.log(failures === 0 ? '\nall agent_ipc tests passed' : `\n${failures} FAILED`);
assert.strictEqual(failures, 0, `${failures} 项 Agent IPC 门禁失败`);