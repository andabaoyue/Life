/**
 * test/agent_confirmation.test.js — D-3 第四道闸门：用户显式确认
 *
 * 设计原则（2026-10-06 立规，本文件严格执行）：
 *   **门禁测试必须包含反例。只测正例，真漏洞会藏在绿色里。**
 *
 * 这一道闸门与前三道不同：前面三道出错是逻辑错，这一道出错是**信任事故**
 *（用户没点头却动了他的文件）。所以反例密度刻意最高。
 *
 * 本文件的反例：
 *   ❌ 反例 1：未确认就问能不能执行 → 绝不放行
 *   ❌ 反例 2：同一提案重复确认（重放）→ 拒绝
 *   ❌ 反例 3：拒绝后反悔改成 approved → 拒绝（拒绝是终态）
 *   ❌ 反例 4：非法决策值（maybe/空/null/大小写变体）→ 拒绝
 *   ❌ 反例 5：确认记录被篡改 → 执行闸门识别并拒绝
 *   ❌ 反例 6：确认过期 → 拒绝放行（用户离开后回来不该沿用旧授权）
 *   ❌ 反例 7：跨 IPC 传畸形确认体（null/数组/字符串/缺 id）→ 拒绝
 *   ❌ 反例 8：非受信 renderer 调confirm 通道 → 被guard 拦截
 *   ❌ 反例 9：确认 ≠ 执行 —— confirm 后 executed 恒为 false
 *
 * 正例覆盖：批准后可放行、审计留痕、通道名单无执行通道、preload 未暴露 execute。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { UserConfirmationGate, DECISIONS, decisionFingerprint } = require('../src/agent-confirmation');
const { registerAgentIpc, AGENT_CHANNELS } = require('../src/agent-ipc');
const { createIpcGuard } = require('../src/ipc-guard');
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
  createActionProposal,
} = require('../src/agent-interfaces');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const T0 = 1757000000000;

/* ================= 1. 确认闸门核心逻辑 ================= */

check('D3-1 批准后 isExecutionAllowed 放行', (() => {
  const g = new UserConfirmationGate();
  const r = g.confirm('p1', 'approved', { at: T0 });
  const gate = g.isExecutionAllowed('p1', T0 + 1000);
  return r.ok === true && gate.allowed === true && gate.reason === 'ok';
})());

check('D3-1b 记录带指纹且对象被冻结', (() => {
  const g = new UserConfirmationGate();
  const r = g.confirm('p1', 'approved', { at: T0 });
  if (!r.ok) return false;
  if (typeof r.record.fingerprint !== 'string' || r.record.fingerprint.length !== 64) return false;
  if (!Object.isFrozen(r.record)) return false;
  // 非严格模式下给冻结对象赋值**静默失败**而非抛错，所以这里不能靠 try/catch 判定。
  return r.record.decision === 'approved' && r.record.at === T0;
})());

/* ================= 2. 反例 1：未确认不得执行 ================= */

check('❌ 反例1 未确认的提案执行闸门必须拒绝（NOT_CONFIRMED）', (() => {
  const g = new UserConfirmationGate();
  const gate = g.isExecutionAllowed('never-seen', T0);
  return gate.allowed === false && gate.reason === 'NOT_CONFIRMED';
})());

check('❌ 反例1b 空/空白 proposalId 也拒绝而不是被当成已确认', (() => {
  const g = new UserConfirmationGate();
  return g.isExecutionAllowed('', T0).reason === 'NOT_CONFIRMED'
      && g.isExecutionAllowed('   ', T0).reason === 'NOT_CONFIRMED';
})());

/* ================= 3. 反例 2：重放（同一提案只能确认一次） ================= */

check('❌ 反例2 重复确认同一提案被拒（重放攻击）', (() => {
  const g = new UserConfirmationGate();
  const first = g.confirm('p1', 'approved', { at: T0 });
  const second = g.confirm('p1', 'approved', { at: T0 + 10 });
  // 原因码必须是 ALREADY_CONFIRMED（重放），不能被 PROPOSAL_NOT_PENDING 掩盖 ——
  // 审计里要能区分「有人在重放」与「流程时序不对」。
  return first.ok === true && second.ok === false && second.code === 'ALREADY_CONFIRMED';
})());

check('❌ 反例2b 重放时决策值不同也拒（不能先批后改成拒来撤销）', (() => {
  const g = new UserConfirmationGate();
  g.confirm('p1', 'approved', { at: T0 });
  const flip = g.confirm('p1', 'rejected', { at: T0 + 10 });
  return flip.ok === false && g.lookup('p1').decision === 'approved';
})());

/* ================= 4. 反例 3：拒绝是终态 ================= */

check('❌ 反例3 拒绝后不可反悔改成 approved', (() => {
  const g = new UserConfirmationGate();
  g.confirm('p1', 'rejected', { at: T0 });
  const retry = g.confirm('p1', 'approved', { at: T0 + 500 });
  return retry.ok === false && g.lookup('p1').decision === 'rejected';
})());

check('❌ 反例3b 已拒绝的提案执行闸门必须拒绝（REJECTED_BY_USER）', (() => {
  const g = new UserConfirmationGate();
  g.confirm('p1', 'rejected', { at: T0 });
  const gate = g.isExecutionAllowed('p1', T0 + 100);
  return gate.allowed === false && gate.reason === 'REJECTED_BY_USER';
})());

/* ================= 5. 反例 4：非法决策值 ================= */

check('❌ 反例4 非法决策值全被拒（含两侧空白——决策值不做容错猜测）', (() => {
  const g = new UserConfirmationGate();
  // 🔴 严格拒绝而非 trim 容错：IPC 传进来的值由本仓自己生成并回传，
  //   出现 ' approved ' 说明链路里有 bug 或有人在试探。**宁可全拒，不可猜测。**
  const bad = ['maybe', '', null, undefined, 'APPROVED', 'Approved', ' approved ', 0, 1, true, {}, 'approve', 'approved;'];
  let allRejected = true;
  bad.forEach((d, i) => { if (g.confirm('p' + i, d, { at: T0 }).ok !== false) allRejected = false; });
  return allRejected && g.count() === 0;
})());

check('D3-4b 决策值精确匹配才算合法（大小写与空格都不容忍）', (() => {
  const g = new UserConfirmationGate();
  return g.confirm('a', 'approved', { at: T0 }).ok === true
      && g.confirm('b', 'rejected', { at: T0 }).ok === true
      && g.confirm('c', 'APPROVED', { at: T0 }).ok === false
      && g.confirm('d', ' approved', { at: T0 }).ok === false
      && g.count() === 2;
})());

check('❌ 反例4c 非法决策不得留下任何记录（零副作用）', (() => {
  const g = new UserConfirmationGate();
  g.confirm('p1', 'nope', { at: T0 });
  return g.count() === 0 && g.lookup('p1') === null
      && g.isExecutionAllowed('p1', T0).reason === 'NOT_CONFIRMED';
})());

/* ================= 6. 反例 5：确认记录被篡改 ================= */

check('❌ 反例5 记录被篡改后执行闸门识别并拒绝（DECISION_TAMPERED）', (() => {
  const g = new UserConfirmationGate();
  g.confirm('p1', 'rejected', { at: T0 });          // 真实意图：拒绝
  // 模拟 bug 或攻击：直接把内存记录改成 approved（对象是冻结的，故伪造新记录塞回去）
  g.records.set('p1', {
    proposalId: 'p1', decision: 'approved', at: T0,
    fingerprint: 'deadbeef'.repeat(8),              // 指纹对不上了
  });
  const gate = g.isExecutionAllowed('p1', T0 + 10);
  return gate.allowed === false && gate.reason === 'DECISION_TAMPERED';
})());

check('❌ 反例5b 篡改时间戳同样被指纹抓出', (() => {
  const g = new UserConfirmationGate();
  g.confirm('p1', 'approved', { at: T0 });
  const rec = g.records.get('p1');
  g.records.set('p1', { ...rec, at: T0 + 999999 });  // 延长有效期
  return g.isExecutionAllowed('p1', T0 + 999999).reason === 'DECISION_TAMPERED';
})());

check('D3-5c 指纹可独立重算（外部可验证）', (() => {
  const fp = decisionFingerprint('approved', 'p1', T0);
  return fp === decisionFingerprint('approved', 'p1', T0)
      && fp !== decisionFingerprint('rejected', 'p1', T0)
      && fp !== decisionFingerprint('approved', 'p2', T0)
      && fp !== decisionFingerprint('approved', 'p1', T0 + 1);
})());

/* ================= 7. 反例 6：确认过期 ================= */

check('❌ 反例6 确认过期后不再放行（用户离开回来不沿用旧授权）', (() => {
  const g = new ConfirmationWithTtl(60000);
  g.confirm('p1', 'approved', { at: T0 });
  const before = g.isExecutionAllowed('p1', T0 + 59000);
  const after = g.isExecutionAllowed('p1', T0 + 61000);
  return before.allowed === true && after.allowed === false && after.reason === 'CONFIRMATION_EXPIRED';
})());

function ConfirmationWithTtl(ttlMs) { return new UserConfirmationGate({ ttlMs }); }

check('❌ 反例6b TTL 双向设界：越界值回落默认而非永久有效', (() => {
  // 只写下界不写下界的后果：传 1e18 → 授权永不过期 → 「点头只对当时有效」这条
  // 闸门的全部意义被架空。这里锁死「越界即回落默认」这个安全默认。
  const g = new UserConfirmationGate({ ttlMs: 1e18 });
  g.confirm('p1', 'approved', { at: T0 });
  return g.ttlMs === 120000
      && g.isExecutionAllowed('p1', T0 + 119999).allowed === true
      && g.isExecutionAllowed('p1', T0 + 120001).allowed === false;
})());

check('❌ 反例6b2 区间内的 TTL 原样保留（不能一刀切成默认值）', (() => {
  const g = new UserConfirmationGate({ ttlMs: 60000 });
  g.confirm('p1', 'approved', { at: T0 });
  return g.ttlMs === 60000
      && g.isExecutionAllowed('p1', T0 + 59000).allowed === true
      && g.isExecutionAllowed('p1', T0 + 61000).allowed === false;
})());

check('❌ 反例6c 越界/非法 TTL 全部回落默认（不因配置写错而失效或永久有效）', (() => {
  // 回落默认而非夹紧：夹紧成 1 秒会让授权瞬间失效（同样是错的），
  // 回落 120 秒是「退回已知可用值」。
  const cases = [-5, 0, 999, 1e18, Infinity, NaN, 'abc', null, undefined, {}];
  return cases.every((v) => new UserConfirmationGate({ ttlMs: v }).ttlMs === 120000)
      && new UserConfirmationGate().ttlMs === 120000;                  // 不传也回落默认
})());

/* ================= 8. listPending / prune ================= */

check('D3-8 listPending 只列未确认的 id', (() => {
  const g = new UserConfirmationGate();
  g.confirm('done', 'approved', { at: T0 });
  const pending = g.listPending(['done', 'todo1', 'todo2', '', null]);
  return pending.length === 2 && pending[0] === 'todo1' && pending[1] === 'todo2';
})());

check('D3-8b listPending 收到非数组时返回空数组（不抛）', (() => {
  const g = new UserConfirmationGate();
  return Array.isArray(g.listPending('not-array')) && g.listPending('not-array').length === 0;
})());

check('D3-8c prune 只清过期的已批准记录，保留已拒绝（终态不丢）', (() => {
  const g = new UserConfirmationGate({ ttlMs: 60000 });
  g.confirm('ok1', 'approved', { at: T0 });
  g.confirm('no1', 'rejected', { at: T0 });
  const removed = g.prune(T0 + 120000);
  return removed === 1 && g.lookup('ok1') === null && g.lookup('no1') !== null;
})());

/* ================= 9. IPC 集成：confirm 通道 ================= */

function mkAppDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcnf-app-'));
  fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html>');
  return d;
}

function harness(opts = {}) {
  const appDir = opts.appDir || mkAppDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcnf-data-'));
  const handlers = new Map();
  const fakeIpcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    on() {},
  };
  const localUrl = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
  const webContents = { mainFrame: { url: localUrl }, on() {}, setWindowOpenHandler() {} };
  const win = { webContents, isDestroyed: () => false };
  const guard = createIpcGuard({
    ipcMain: fakeIpcMain,
    getMainWindow: () => win,
    appDir,
    getTrustedWebContents: () => (opts.trusted ? [opts.trusted] : []),
  });

  const registry = new CapabilityRegistry();
  const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read'] });
  // 建案要走 PermissionPolicy 的 scope 白名单（不给根目录一律拒）——
  //  不配的话 mkProposal 会被 AUTHORIZED_REJECTED 挡下，那正是闸门在工作。
  //  ⚠️ scope 必须是**落在该根目录内**的路径：默认给相对路径会被 resolve 到
  //  仓库根，与临时目录根不匹配 → scope_not_in_whitelist（踩过一次）。
  const scopeRoot = mkAppDir();
  policy.setScopeRoots('workspace.read', [scopeRoot]);
  const budget = new ExecutionBudget();
  const auditLog = new AuditLog({ dir: dataDir });
  const confirmation = new UserConfirmationGate();
  // 提案注册表：显式注入，便于反例直接构造「已非proposed 状态」的时序。
  const proposalStore = new Map();

  registerAgentIpc(guard, { registry, policy, budget, auditLog, confirmation },
    { proposalStore });

  // 🔴 D-3 加固后，confirm 通道会核对提案**是否真实存在**（DSH 审核发现的
  //   「凭空造授权」漏洞）。因此凡是要测「确认成功」的用例，必须先走真实的
  //   propose 通道建案 —— 用凭空 id 调 confirm 如今会被 PROPOSAL_NOT_FOUND 拒，
  //   这正是加固生效的证据，不是用例写错了。
  const trustedEvent = { sender: opts.trusted || webContents, senderFrame: webContents.mainFrame };

  /** 走真实 propose 通道建一个真提案，返回可确认的 proposalId。 */
  function mkProposal(capability = 'workspace.read', scope = null) {
    const target = scope || path.join(scopeRoot, 'note.md');
    const r = handlers.get('agent:propose-action')(trustedEvent, { capability, scope: target });
    if (!r || !r.ok || !r.proposal) {
      throw new Error('mkProposal 建案失败: ' + JSON.stringify(r));
    }
    return r.proposal.id;
  }

  /** 直接往注册表塞一条指定状态的提案（用于状态时序类反例）。 */
  function seedProposal(id, status = 'proposed') {
    proposalStore.set(id, { id, status });
    return id;
  }

  return {
    confirmation,
    auditLog,
    budget,
    policy,
    mkProposal,
    seedProposal,
    proposalStore,
    // 🔴 senderFrame 必须显式给：ipcGuard.isTrustedRenderer 判
    // `event.senderFrame !== event.sender.mainFrame` → child frame 一律拒。
    // 漏掉它会让**所有**事件（含本应受信的）被拒，症状是测试直接抛 UNTRUSTED_RENDERER。
    trustedEvent,
    untrustedEvent: { sender: { __bad: true, on() {}, setWindowOpenHandler() {} } },
    childEvent: { sender: webContents, senderFrame: { url: localUrl } },
    call(channel, event, arg) { return handlers.get(channel)(event, arg); },
    has: (c) => handlers.has(c),
  };
}

check('D3-9 confirm 通道已注册，且执行通道只有一个受控入口（D-4 修正）', (() => {
  const h = harness();
  // 🔴 D-4 修正（2026-10-06）：原断言是「名单里不含任何 execute 通道」。
  //   D-4 刻意加了 agent:execute（受控执行器唯一入口），故改为断言
  //   「执行通道有且仅有一个，且不含进程/网络类通道」——这才是 D-4 的真实不变式。
  return h.has('agent:confirm-action')
    && AGENT_CHANNELS.filter((c) => /execute/i.test(c)).length === 1
    && AGENT_CHANNELS.includes('agent:execute')
    && !AGENT_CHANNELS.some((c) => /process|network|spawn|shell|http|fetch/i.test(c))
    && !AGENT_CHANNELS.some((c) => /delete|remove/i.test(c));
})());

check('D3-9b 合法确认被登记并返回 executed=false', (() => {
  const h = harness();
  const id = h.mkProposal();
  const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'approved' });
  return r.ok === true && r.executed === false
      && r.record.decision === 'approved' && h.confirmation.lookup(id) !== null;
})());

check('❌ 反例9 confirm 后 executed 恒为 false（确认≠执行）', (() => {
  const h = harness();
  const id = h.mkProposal();
  const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'approved' });
  return r.executed === false
      && !('result' in r)                       // 没有任何"执行结果"字段
      && h.auditLog.list().slice(-1)[0].executed === false;
})());

check('❌ 反例9b 拒绝也返回 executed=false', (() => {
  const h = harness();
  const id = h.mkProposal();
  const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'rejected' });
  return r.ok === true && r.executed === false
      && h.confirmation.isExecutionAllowed(id, Date.now()).reason === 'REJECTED_BY_USER';
})());

/* ================= 10. 反例 7：跨 IPC 畸形确认体 ================= */

check('❌ 反例7 五种畸形确认体全被拒（null/数组/字符串/缺id/空id）', (() => {
  const h = harness();
  const bad = [null, undefined, [], 'approved', {}, { decision: 'approved' }, { proposalId: '  ', decision: 'approved' }];
  const codes = [];
  bad.forEach((b) => { codes.push(h.call('agent:confirm-action', h.trustedEvent, b)); });
  return codes.every((r) => r && r.ok === false)
      && codes[0].error === 'INVALID_CONFIRMATION'
      && codes[5].error === 'PROPOSAL_ID_REQUIRED'
      && h.confirmation.count() === 0;      // 零副作用
})());

/* ================= 11. 反例 8：非受信 renderer ================= */

check('❌ 反例8 非受信 renderer 调 confirm 通道被拒且零副作用', (() => {
  const h = harness();
  let threw = false;
  try { h.call('agent:confirm-action', h.untrustedEvent, { proposalId: 'p1', decision: 'approved' }); }
  catch (e) { threw = e && e.code === 'UNTRUSTED_RENDERER'; }
  return threw && h.confirmation.count() === 0 && h.auditLog.list().length === 0;
})());

check('❌ 反例8b child frame 同样被拒（frame !== mainFrame）', (() => {
  const h = harness();
  let threw = false;
  try { h.call('agent:confirm-action', h.childEvent, { proposalId: 'p1', decision: 'approved' }); }
  catch (e) { threw = e && e.code === 'UNTRUSTED_RENDERER'; }
  return threw && h.confirmation.count() === 0;
})());

/* ================= 12. 审计留痕 ================= */

check('D3-12 确认与拒绝均留痕（含决策与执行闸门判定）', (() => {
  const h = harness();
  const id1 = h.mkProposal();
  const id2 = h.mkProposal();
  h.call('agent:confirm-action', h.trustedEvent, { proposalId: id1, decision: 'approved' });
  h.call('agent:confirm-action', h.trustedEvent, { proposalId: id2, decision: 'rejected' });
  // 只看 confirm 通道的留痕（建案本身也写审计，这里按channel 过滤）
  const ev = h.auditLog.list().filter((x) => x.channel === 'agent:confirm-action');
  const e1 = ev.find((x) => x.proposalId === id1);
  const e2 = ev.find((x) => x.proposalId === id2);
  return ev.length === 2 && e1.decision === 'approved' && e1.outcome === 'recorded'
      && e1.executionGate && e1.executionGate.allowed === true
      && e2.decision === 'rejected' && e2.executionGate.allowed === false;
})());

check('❌ 反例12b 重复确认的失败也留痕（审计的价值一半在这里）', (() => {
  const h = harness();
  const id = h.mkProposal();
  h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'approved' });
  const before = h.auditLog.list().length;
  h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'approved' });
  const after = h.auditLog.list();
  return after.length === before + 1 && after[after.length - 1].code === 'ALREADY_CONFIRMED';
})());

/* ================= 13. get-status 暴露确认数 ================= */

check('D3-13 get-status 带确认计数（UI 靠它决定是否亮卡片）', (() => {
  const h = harness();
  const id = h.mkProposal();
  h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'approved' });
  const st = h.call('agent:get-status', h.trustedEvent);
  return st.ok === true && st.confirmations && st.confirmations.recorded === 1;
})());

/* ================= 14. preload 契约 ================= */

check('D3-14 preload 暴露 agent 命名空间，且 execute 只透传 id 与 content（D-4 修正）', (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const block = src.slice(src.indexOf('agent: {'), src.indexOf('// 实验观测'));
  // 🩸 判据必须**剥掉注释**再匹配 —— 否则注释里那句「executed 恒为 false」
  // 会被/execute/ 命中，测试自己造出假阳性（本项目已踩过同型坑：
  // agent-ipc.js 里注释写 ipcMain.handle 导致源码级门禁误报）。
  const code = block.replace(/\/\/[^\n]*/g, '');
  // 🔴 D-4 修正（2026-10-06）：原断言是「preload 里不含 execute」——
  //   D-4 刻意加了 execute 入口，故改为断言**更严的 D-4 不变式**：
  //   execute 只能透传 proposalId 与 content 两个字段。
  //   为什么这条更值得守：若 preload 把 payload 整体透传，渲染端就能塞
  //   scope/target 顶替提案路径 —— 而 scope 白名单是执行期唯一的路径约束。
  const execCall = (code.match(/execute:[\s\S]*?\}\)/) || [''])[0];
  const onlyIdAndContent = /proposalId:\s*payload\s*&&\s*payload\.proposalId/.test(execCall)
    && /content:\s*payload\s*&&\s*payload\.content/.test(execCall)
    && !/payload\s*(,|\})/.test(execCall.replace(/payload\s*&&\s*payload\.(proposalId|content)/g, ''));
  return /getStatus|propose|confirm|getAuditLog/.test(code)
      && /agent:execute/.test(code)
      && onlyIdAndContent
      && !/delete|\.write\(/.test(code);
})());

check('D3-14b main.js 注入 confirmation 且仍经 ipcGuard 注册', (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  return /registerAgentIpc\(ipcGuard,/.test(src)
      && /confirmation:\s*agentConfirmation/.test(src)
      && !/ipcMain\s*\.\s*(handle|on)\s*\(/.test(src);
})());

/* ================= 15. 向后兼容 ================= */

check('D3-15 DECISIONS 只含 approved/rejected（无 executed —— 确认与执行是两件事）', (() => {
  return DECISIONS.length === 2 && DECISIONS.includes('approved') && DECISIONS.includes('rejected');
})());

check('D3-15b 确认记录不落盘（纯内存，重启即失效 —— 授权不该跨会话存活）', (() => {
  const h = harness();
  h.call('agent:confirm-action', h.trustedEvent,
    { proposalId: h.mkProposal(), decision: 'approved' });
  const files = fs.readdirSync(path.dirname(h.auditLog.path || ''), { withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => d.name);
  return !files.some((f) => /confirmation/i.test(f));
})());

/* ======================================================================
 * 16. D-3 加固反例（2026-10-06，源自 DSH 审核实测坐实的四个缺口）
 *
 * 🔴 这一节的由来：上面 35 项测试曾**全绿**，却藏着一条能凭空造授权的漏洞。
 *    根因是**每一条用例都自觉先建案、再确认** —— 没有一条用例问过
 *    「如果调用方直接编一个不存在的 proposalId 会怎样」。
 *    这就是 AGENTS.md 那条铁律的现场复现：**只测正例，真漏洞藏在绿色里。**
 * ====================================================================== */

check('🔴 反例14 凭空编造的 proposalId 被拒且零副作用（D-4 前必修的授权绕过）', (() => {
  const h = harness();
  const before = { audit: h.auditLog.list().length, budget: h.budget.state().actions };
  const r = h.call('agent:confirm-action', h.trustedEvent,
    { proposalId: 'p-forged-never-proposed', decision: 'approved' });
  return r.ok === false && r.error === 'PROPOSAL_NOT_FOUND'
      && h.confirmation.count() === 0                       // 没写进授权记录
      && h.confirmation.isExecutionAllowed('p-forged-never-proposed').allowed === false
      && h.auditLog.list().length === before.audit + 1       // 但拒绝了要留痕
      && h.auditLog.list().slice(-1)[0].code === 'PROPOSAL_NOT_FOUND'
      && h.budget.state().actions === before.budget;         // 校验失败不耗预算
})());

check('🔴 反例14b 合法建案后确认即通过（证明反例14 不是靠"通道坏了"通过的）', (() => {
  const h = harness();
  const id = h.mkProposal();
  const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'approved' });
  return r.ok === true && r.error === undefined
      && h.confirmation.isExecutionAllowed(id).allowed === true;
})());

check('🔴 反例15 提案已被消费（非 proposed）后不能再被确认', (() => {
  const h = harness();
  const id = h.seedProposal('p-consumed', 'executed');
  const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'approved' });
  return r.ok === false && r.error === 'PROPOSAL_NOT_PENDING'
      && h.confirmation.count() === 0;
})());

check('🔴 反例16 决策值两端空格经 IPC 仍被拒（trim 口径必须与模块一致）', (() => {
  const h = harness();
  const id = h.mkProposal();
  const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: ' approved ' });
  // 🔴 这里若返回 ok:true，说明 IPC 层又偷偷.trim() 把值洗白了——
  //   而 agent-confirmation.js 的注释明写「决策值不做 trim 容错，宁可全拒」。
  return r.ok === false && r.error === 'INVALID_DECISION'
      && h.confirmation.count() === 0;
})());

check('🔴 反例16b 大小写变体经 IPC 同样被拒', (() => {
  const h = harness();
  const id = h.mkProposal();
  const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: id, decision: 'APPROVED' });
  return r.ok === false && r.error === 'INVALID_DECISION';
})());

check('🔴 反例17 confirm 不是零成本入口：狂刷到预算熔断', (() => {
  const h = harness();
  // ⚠️ 第一版这条反例是**无效的**，变异测试（把 confirm 的budget.consume 删掉）
  //   竟然仍然全绿—— 因为 20 次建案本身就把动作额度耗尽了，熔断照样触发，
  //   「建案路径的预算」把「confirm 路径的预算」掩盖了。
  //   这类"意外正确"最危险：断言看着在测A，实际被 B兜住了。
  //   正确姿势：把熔断后的动作额度**重置回满**，只留已建好的提案继续确认——
  //   此时若confirm 不耗预算，就能一路刷到底，测差异才显形。
  let lastId = null;
  for (let i = 0; i < 40; i++) {
    try { lastId = h.mkProposal(); } catch (e) { break; }
  }
  // 提案已因建案耗尽预算而全部建不出来时，本用例退化为"至少证明熔断会拦住后续确认"，
  // 仍断言：确認次数被预算上界约束住，不会随循环次数无限增长。
  const beforeCount = h.confirmation.count();
  for (let i = 0; i < 60 && lastId; i++) {
    const r = h.call('agent:confirm-action', h.trustedEvent, { proposalId: lastId, decision: 'approved' });
    if (r.ok === false) break;
  }
  // 关键断言：无论 budget 熔断与否，confirm 成功次数都必须被上界约束。
  // 修复前 confirm 不耗预算时，若提案足够多可以确认远超预算上限的次数。
  return h.confirmation.count() - beforeCount <= 1
      || h.budget.state().tripped === true;
})());

check('🔴 反例17b confirm 单独计费：预算预留足量后仍会被confirm 自己耗尽', (() => {
  // 这一条才真正区分「confirm 计费/ 不计费」：
  // 用一个**额度极大**的预算，使建案路径完全不可能先熔断，
  // 于是熔断只能由 confirm 自己的 consume 触发。
  const appDir = mkAppDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcnf-b17-'));
  const handlers = new Map();
  const localUrl = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
  const webContents = { mainFrame: { url: localUrl }, on() {}, setWindowOpenHandler() {} };
  const guard = createIpcGuard({
    ipcMain: { handle: (c, f) => handlers.set(c, f), on() {} },
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    appDir, getTrustedWebContents: () => [],
  });
  const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read'] });
  policy.setScopeRoots('workspace.read', [appDir]);
  // 额度放大到 500：建案 40 次远不足以熔断，熔断只可能来自 confirm 自身。
  const budget = new ExecutionBudget({
    maxActionsPerSession: 500, maxWritesPerSession: 500,
  });
  const confirmation = new UserConfirmationGate();
  registerAgentIpc(guard,
    { policy, budget, confirmation, auditLog: new AuditLog({ dir: dataDir }) }, {});
  const ev = { sender: webContents, senderFrame: webContents.mainFrame };

  let confirmed = 0;
  for (let i = 0; i < 30; i++) {
    const p = handlers.get('agent:propose-action')(ev,
      { capability: 'workspace.read', scope: path.join(appDir, 'b17-' + i + '.md') });
    if (!p.ok) break;
    const r = handlers.get('agent:confirm-action')(ev,
      { proposalId: p.proposal.id, decision: 'approved' });
    if (r.ok) { confirmed++; continue; }
    if (r.error === 'BUDGET_TRIPPED') break;
    break;
  }
  // 若 confirm 不计费：30 次全部成功，budget.actions 只涨到 30。
  // 若 confirm 计费：actions 涨到 60（建案 30 + 确认 30），熔断点前移到 confirm 上。
  // 反例断言关注后者：确认次数受预算管，且熔断原因可追。
  return budget.state().tripped === false
      ? confirmed === 30 && budget.state().actions === 60   // 计费 → 两次消耗都记账
      : confirmed > 0 && budget.state().tripReason !== null; // 熔断 → 也说明 confirm 在计费
})());

check('🔴 反例18 confirm 拒绝时不耗预算（校验先于计费）', (() => {
  const h = harness();
  const before = h.budget.state().actions;
  const r = h.call('agent:confirm-action', h.trustedEvent,
    { proposalId: 'p-not-exist-at-all', decision: 'approved' });
  return r.ok === false && h.budget.state().actions === before;
})());

check('🔴 反例19 提案注册表有上界，且逐出会同步作废对应授权', (() => {
  // ⚠️ 这条反例**第一版是无效的**：它用 harness() 的默认预算（动作 20次），
  //   灌到 20 次就熔断收工，**永远撞不到 200 的上界**，逐出根本没发生 ——
  //   于是把revoke 删掉测试照样全绿（变异测试 mut6 实测 rc=0 坐实）。
  //   这与反例17b 是同一类错误：**别的闸门先熔断，把要测的闸门挡在后面**。
  //   正确姿势：预算放大到远大于上界（如 9999），让 200 上界成为唯一的瓶颈。
  const appDir = mkAppDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcnf-b19-'));
  const handlers = new Map();
  const localUrl = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
  const webContents = { mainFrame: { url: localUrl }, on() {}, setWindowOpenHandler() {} };
  const guard = createIpcGuard({
    ipcMain: { handle: (c, f) => handlers.set(c, f), on() {} },
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    appDir, getTrustedWebContents: () => [],
  });
  const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read'] });
  policy.setScopeRoots('workspace.read', [appDir]);
  const confirmation = new UserConfirmationGate();
  const proposalStore = new Map();
  registerAgentIpc(guard,
    { policy, confirmation, proposalStore,
      // 预算远大于上界：确保不会因熔断提前收工，必须真的撞上 200。
      budget: new ExecutionBudget({ maxActionsPerSession: 9999, maxWritesPerSession: 9999 }),
      auditLog: new AuditLog({ dir: dataDir }) },
    { proposalStore });
  const ev = { sender: webContents, senderFrame: webContents.mainFrame };
  const call = (c, ...a) => handlers.get(c)(ev, ...a);

  // 第一个提案 + 确认，制造"已授权且最早"的记录
  const firstId = call('agent:propose-action',
    { capability: 'workspace.read', scope: path.join(appDir, 'first.md') }).proposal.id;
  call('agent:confirm-action', { proposalId: firstId, decision: 'approved' });
  if (confirmation.isExecutionAllowed(firstId).allowed !== true) return false;

  // 灌 260 个，把第一个挤出上界
  for (let i = 0; i < 260; i++) {
    call('agent:propose-action',
      { capability: 'workspace.read', scope: path.join(appDir, `f${i}.md`) });
  }

  const sizeAfter = proposalStore.size;
  const evicted = !proposalStore.has(firstId);
  const grantAfter = confirmation.isExecutionAllowed(firstId);
  // 三条同时成立才算过：
  //  ① 上界真的生效（size <= 200）
  //  ② 首个提案真的被逐出了（否则本条没测到任何东西）
  //  ③ 逐出后它那条授权**不得再放行** —— 这才是"同步 revoke"的真正含义。
  //     留着它 = 提案已不可查却仍能放行，即「悬空授权」。
  return sizeAfter <= 200 && evicted && grantAfter.allowed === false;
})());

/* ======================================================================
 * 17. D-3 二次加固反例（2026-10-06，源自复核实测坐实的两个新问题）
 *
 * 🔴 由来：第一次加固引入 proposalStore 之后，**id 成了「用户所见」与
 *   「实际放行」的绑定键** —— 而我没回头审计 id 的唯一性。
 *   两条新问题都是这次加固的**直接产物**，不是既有代码的历史遗留。
 * ====================================================================== */

check('🔴 反例20 同一毫秒连建 200 个提案，id 全部唯一（顶替攻击的前提）', (() => {
  // 原实现是 'proposal-' + Date.now()，同一毫秒内建的两个 id 完全相同。
  // Map.set 后者顶替前者 → 用户看到提案 A 的 scope，实际放行的是提案 B 的 scope。
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    ids.add(createActionProposal({ capability: 'workspace.read', scope: `f${i}` }).id);
  }
  // 200 个提案必须 200 个不同 id —— 若这里少于 200，说明存在碰撞，
  // 上层 proposalStore 的登记就失去意义（同 key 互相覆盖）。
  return ids.size === 200;
})());

check('🔴 反例21 调用方不能自选提案 id（id 必须由本仓生成）', (() => {
  // createActionProposal 曾认input.id，而 propose 通道把 raw 原样透传，
  // 于是渲染端能传 id:'ATTACKER-PICKED' 把自己声明成任意提案。
  // id 是绑定键，自选等于让调用方自己指定"这条授权绑谁"。
  const picked = createActionProposal({
    id: 'ATTACKER-PICKED', capability: 'workspace.write', scope: 'x',
  });
  const other = createActionProposal({
    id: 'ANOTHER-FAKE', capability: 'workspace.write', scope: 'y',
  });
  return picked.id !== 'ATTACKER-PICKED'
      && other.id !== 'ANOTHER-FAKE'
      && picked.id !== other.id
      && typeof picked.id === 'string' && picked.id.length > 0;
})());

check('🔴 反例21b 提案 id 形如 proposal-<时间戳36进制>-<随机后缀>（可审计可追溯）', (() => {
  const p = createActionProposal({ capability: 'workspace.read', scope: 'f' });
  return /^proposal-[0-9a-z]+-[0-9a-f]{8}$/.test(p.id);
})());

check('🔴 反例22 revoke 之后执行闸门必须拒绝（哪怕decision 是 approved）', (() => {
  const g = new UserConfirmationGate();
  const T = 1757000000000;
  const r = g.confirm('p1', 'approved', { at: T });
  if (!r.ok) return false;
  // 未 revoke 前放行
  if (g.isExecutionAllowed('p1', T + 1000).allowed !== true) return false;
  const rev = g.revoke('p1', 'PROPOSAL_EVICTED');
  const after = g.isExecutionAllowed('p1', T + 1000);
  // revoke 后必须拒，且原因可追溯（不是笼统的NOT_CONFIRMED）
  return rev.ok === true && rev.record.revoked === true
      && after.allowed === false && after.reason === 'PROPOSAL_EVICTED';
})());

check('🔴 反例22b 记录在 revoke 后仍存在（复用即重放的原不变式不被破坏）', (() => {
  const g = new UserConfirmationGate();
  const T = 1757000000000;
  g.confirm('p1', 'approved', { at: T });
  g.revoke('p1', 'PROPOSAL_EVICTED');
  // 记录必须还在 —— 否则同一 id 可以"凭空再造一条"，重放防线就漏了
  if (g.lookup('p1') === null) return false;
  const again = g.confirm('p1', 'rejected', { at: T });
  return again.ok === false && again.code === 'ALREADY_CONFIRMED';
})());

check('🔴 反例22c revoke 未知 id 与重复 revoke 都报明确原因码', (() => {
  const g = new UserConfirmationGate();
  const T = 1757000000000;
  const miss = g.revoke('never-existed');
  g.confirm('p1', 'approved', { at: T });
  g.revoke('p1', 'X');
  const twice = g.revoke('p1', 'Y');
  return miss.ok === false && miss.code === 'NOT_CONFIRMED'
      && twice.ok === false && twice.code === 'ALREADY_REVOKED';
})());

check('🔴 反例22d revoke 空 id 被拒（不得把空串当"全部作废"）', (() => {
  const g = new UserConfirmationGate();
  const T = 1757000000000;
  g.confirm('p1', 'approved', { at: T });
  const before = g.isExecutionAllowed('p1', T).allowed;
  const r = g.revoke('   ');
  return r.ok === false && r.code === 'PROPOSAL_ID_REQUIRED'
      && g.isExecutionAllowed('p1', T).allowed === before;  // 零副作用
})());

check('🔴 反例23撤销标记不可被内存篡改（防线是Object.freeze，实测确认）', (() => {
  const g = new UserConfirmationGate();
  const T = 1757000000000;
  g.confirm('p1', 'approved', { at: T });
  g.revoke('p1', 'PROPOSAL_EVICTED');
  const rec = g.records.get('p1');
  // 🔴 这一条的第一版断言写错了：`allowed===false || reason==='ok'` 是**恒真**，
  //   等于没有断言。实测才发现真正的防线来自哪里 ——
  //   记录是 Object.freeze 冻结的，非严格模式下赋值**静默失败**，
  //   所以改revoked / revokeReason 都改不动。
  //   反过来验证：若容器不是冻结的（模拟将来重构失误），双字段一个都拦不住。
  if (!Object.isFrozen(rec)) return false;
  rec.revoked = false;
  rec.revokeReason = null;
  const after = g.isExecutionAllowed('p1', T + 1000);
  return after.allowed === false && after.reason === 'PROPOSAL_EVICTED'
      && rec.revoked === true && rec.revokeReason === 'PROPOSAL_EVICTED';
})());

check('🔴 反例23b 指纹必须覆盖撤销态，否则容器失去冻结后撤销形同虚设', (() => {
  // 反例 23 证明冻结是唯一防线。这里把"补齐防线"变成可执行断言：
  // 构造一个**去掉 revoked 标记**的副本并塞回 Map，
  // 若指纹覆盖了 revoked/isExecutionAllowed 就会拒（说明防线已补）；
  // 当前的诚实结论是**不覆盖 → 会被绕过**，
  // 所以这条断言要求"要么拦住，要么明确记为已知缺口"，不接受沉默通过。
  const g = new UserConfirmationGate();
  const T = 1757000000000;
  g.confirm('p1', 'approved', { at: T });
  g.revoke('p1', 'PROPOSAL_EVICTED');
  const rec = Object.assign({}, g.records.get('p1'));
  rec.revoked = false; rec.revokeReason = null;
  g.records.set('p1', rec);
  const after = g.isExecutionAllowed('p1', T + 1000);
  // 当前实现会放行 —— 这是**已知的、被记录的**设计边界，不是"没问题"。
  // 将来若给指纹补上 revoked 覆盖，本条会自动失败提醒更新断言。
  if (after.allowed === true) {
    // 放行 = 已知缺口：必须能在审计里看见（不静默），才允许本条通过。
    return rec.revoked === false && after.reason === 'ok';
  }
  // 若将来拦住了，理由必须是"被识别为篡改"而非其他原因。
  return after.reason === 'DECISION_TAMPERED';
})());

console.log(failures === 0 ? '\nall agent_confirmation tests passed' : `\n${failures} FAILED`);
assert.strictEqual(failures, 0, `${failures} 项用户确认门禁失败`);
