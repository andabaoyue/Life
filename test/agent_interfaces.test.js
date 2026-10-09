const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget,
  createActionProposal, AuditLog, AgentBridgeMock,
  CAPABILITIES, CAPABILITY_META, PROPOSAL_STATES, looksLikePath,
} = require('../src/agent-interfaces');

let pass = 0;
function check(name, value) { assert.ok(value, name); pass++; console.log('PASS', name); }

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
// 不清理单次跑净留沙盒目录（%TEMP% 累积投诉的根因，见 tmp-hygiene.test.js 头注释）。
const _hygDirs = [];
const _hygOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _hygOrigMkdtemp.apply(fs, a);
  _hygDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _hygDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掀桌 */ }
  }
});

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), tag)); }

/* ===== v0.9.1 原有契约（必须保持向后兼容）===== */
(async () => {
  const registry = new CapabilityRegistry();
  check('能力名有明确白名单', registry.has('workspace.read') && !registry.has('shell.exec'));
  const policy = new PermissionPolicy();
  check('权限默认 deny', policy.can('workspace.read', 'workspace') === false);
  policy.setKillSwitch(false);
  check('没有显式授权仍拒绝', policy.can('workspace.read', 'workspace') === false);
  const proposal = createActionProposal({ capability: 'workspace.read', scope: 'workspace', reason: '查看项目' });
  check('行动提案默认需要用户确认', proposal.status === 'proposed' && proposal.requiresUserConfirmation);
  const audit = new AuditLog();
  audit.append({ proposalId: proposal.id, result: 'proposed' });
  check('审计日志只追加', audit.list().length === 1 && audit.list()[0].proposalId === proposal.id);
  let rejected = false;
  try { await new AgentBridgeMock().execute(); } catch (e) { rejected = /尚未连接/.test(e.message); }
  check('Mock 不执行真实动作', rejected);

  /* ===== ① CapabilityRegistry：运行时可注册 + 能力元数据 ===== */
  check('C1 能力元数据可查（dangerLevel/requiresConfirm/scopeKind）', (() => {
    const m = registry.metaOf('workspace.write');
    return m && m.dangerLevel === 'high' && m.requiresConfirm === true && m.scopeKind === 'path';
  })());
  check('C1 register() 可运行时新增能力（原实现只有 has/list）', (() => {
    const r = new CapabilityRegistry();
    const ok = r.register('clipboard.read', { dangerLevel: 'low', requiresConfirm: true, scopeKind: 'none' });
    return ok === true && r.has('clipboard.read') && r.metaOf('clipboard.read').dangerLevel === 'low';
  })());
  check('C1 metaOf 返回副本，外部改它不污染内部状态', (() => {
    const r = new CapabilityRegistry();
    const m = r.metaOf('workspace.read');
    m.dangerLevel = 'forbidden';
    return r.metaOf('workspace.read').dangerLevel === 'low';
  })());
  check('C1 非法能力名被拒', new CapabilityRegistry().register('', {}) === false);

  /* ===== ② PermissionPolicy：scope 路径白名单（治!!scope 裸奔）===== */
  const root = tmpDir('agent-root-');
  const inside = path.join(root, 'notes.txt');
  const outside = path.join(os.tmpdir(), 'agent-outside-evil.txt');

  const mkPolicy = (roots) => {
    const p = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read', 'workspace.write'] });
    if (roots) p.setScopeRoots('workspace.read', roots);
    return p;
  };

  check('C2 🔴 未配置根目录时一律拒绝（旧实现传任意非空字符串即放行）', (() => {
    const p = mkPolicy(null);
    return p.authorize('workspace.read', 'C:\\Users\\example').allowed === false
      && p.authorize('workspace.read', '*').reason === 'scope_not_in_whitelist';
  })());
  check('C2 🔴 scope="*" 在配置了根目录后也不得放行', (() => {
    const p = mkPolicy([root]);
    return p.authorize('workspace.read', '*').allowed === false;
  })());
  check('C2 白名单内路径放行且返回 matchedRoot（审计可追溯）', (() => {
    const p = mkPolicy([root]);
    const r = p.authorize('workspace.read', inside);
    return r.allowed === true && r.reason === 'ok' && r.matchedRoot === path.resolve(root);
  })());
  check('C2 🔴 白名单外路径拒绝', mkPolicy([root]).authorize('workspace.read', outside).allowed === false);
  check('C2 🔴 ../ 路径穿越被 path.resolve 归一化后拦下', (() => {
    const p = mkPolicy([root]);
    // 构造一个先向上再向下的穿越路径，resolve 后应落在 root 之外
    const escape = path.join(root, '..', path.basename(root) + '-other', 'x.txt');
    return p.authorize('workspace.read', escape).allowed === false;
  })());
  check('C2 前缀相似目录不得误配（D:\\repo-other 不算 D:\\repo 内）', (() => {
    const p = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read'] });
    p.setScopeRoots('workspace.read', [path.join(root, 'repo')]);
    const sibling = path.join(root, 'repo-other', 'x.txt');
    return p.authorize('workspace.read', sibling).allowed === false;
  })());
  check('C2 followSymlink 默认关闭（符号链接不得绕过白名单）', (() => {
    const p = mkPolicy([root]);
    return p.followSymlink === false;
  })());
  check('C2 根目录本身可访问（边界不算越界）', (() => {
    const p = mkPolicy([root]);
    return p.authorize('workspace.read', root).allowed === true;
  })());
  check('C2 空/非字符串 scope 一律拒绝', (() => {
    const p = mkPolicy([root]);
    return p.authorize('workspace.read', '').allowed === false
      && p.authorize('workspace.read', null).allowed === false
      && p.authorize('workspace.read', undefined).allowed === false;
  })());
  check('C2 未授权能力即使 scope 合法也拒绝', (() => {
    const p = new PermissionPolicy({ killSwitch: false, allowed: [] });
    p.setScopeRoots('workspace.read', [root]);
    return p.authorize('workspace.read', inside).reason === 'capability_not_granted';
  })());
  check('C2 killSwitch 开启时最优先拒绝', (() => {
    const p = mkPolicy([root]);
    p.setKillSwitch(true);
    return p.authorize('workspace.read', inside).reason === 'kill_switch_on';
  })());
  check('C2 authorize 返回判定明细而非布尔（审计要记为什么拒绝）', (() => {
    const p = mkPolicy([root]);
    const d = p.authorize('workspace.read', outside);
    return typeof d === 'object' && 'allowed' in d && 'reason' in d && typeof d.reason === 'string';
  })());

  /* ===== ② 附：network.request C 阶段硬封死 ===== */
  check('C2 🔴 network.request 元数据标记 hardDenied 且带理由', (() => {
    const m = registry.metaOf('network.request');
    return m && m.hardDenied === true && m.dangerLevel === 'forbidden' && typeof m.hardDenyReason === 'string';
  })());
  check('C2 🔴 network.request 即使显式授权+合法 scope 仍被拒', (() => {
    const p = new PermissionPolicy({ killSwitch: false, allowed: ['network.request'] });
    p.setScopeRoots('network.request', [root]);
    const r = p.authorize('network.request', inside, { meta: registry.metaOf('network.request') });
    return r.allowed === false && /网络|反表演/.test(r.reason);
  })());
  check('C2 🔴 network.request 默认就是 forbidden 档，不可被悄悄放行', (() => {
    const r = new CapabilityRegistry();
    return r.isHardDenied('network.request') === true && r.isHardDenied('workspace.read') === false;
  })());
  check('C2 process.execute 不接受路径冒充（scopeKind=command 走独立校验）', (() => {
    const p = new PermissionPolicy({ killSwitch: false, allowed: ['process.execute'] });
    const m = CAPABILITY_META['process.execute'];
    const withPath = p.authorize('process.execute', inside, { meta: m });
    const withCmd = p.authorize('process.execute', 'git status', { meta: m });
    return withPath.allowed === false && withCmd.allowed === true;
  })());

  /* ===== ③ ExecutionBudget执行预算熔断 ===== */
  check('C3 默认上限：动作20/写5/连续错误3/墙钟10min', (() => {
    const b = new ExecutionBudget();
    const l = b.limits;
    return l.maxActionsPerSession === 20 && l.maxWritesPerSession === 5
      && l.maxConsecutiveErrors === 3 && l.maxWallClockMs === 10 * 60 * 1000;
  })());
  check('C3 动作数达上限即熔断，且给出用户可见原因', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 3, maxWritesPerSession: 99, maxConsecutiveErrors: 99, maxWallClockMs: 0 });
    b.consume(); b.consume(); b.consume();
    const fourth = b.consume();
    const s = b.state();
    return fourth === false && s.tripped === true && s.tripReason === 'max_actions_exceeded';
  })());
  check('C3 🔴 写动作走更严的独立上限（写不可逆）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 99, maxWritesPerSession: 2, maxConsecutiveErrors: 99, maxWallClockMs: 0 });
    b.consume(true); b.consume(false);
    const second = b.consume(true);      // 第2 次写：恰好用满额度，应放行
    const third = b.consume(true);       // 第 3 次写：超额，应熔断
    return second === true && third === false
      && b.state().tripReason === 'max_writes_exceeded' && b.state().writes === 2;
  })());
  check('C3 写额度用满触发熔断后全局停摆（熔断是终态，不只是拦写）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 99, maxWritesPerSession: 1, maxConsecutiveErrors: 99, maxWallClockMs: 0 });
    b.consume(true);
    b.consume(true);                     // 超额 → 熔断
    return b.state().tripped === true
      && b.consume(false) === false      //熔断后连读动作也不放行（防绕过写闸）
      && b.consume(true) === false;
  })());
  check('C3 连续失败达上限熔断（防死循环打转）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 99, maxWritesPerSession: 99, maxConsecutiveErrors: 3, maxWallClockMs: 0 });
    b.recordError(); b.recordError();
    const third = b.recordError();
    return third === false && b.state().tripped === true && b.state().tripReason === 'max_consecutive_errors';
  })());
  check('C3 成功动作重置连续错误计数（偶发失败不误熔断）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 99, maxWritesPerSession: 99, maxConsecutiveErrors: 3, maxWallClockMs: 0 });
    b.recordError(); b.recordError();
    b.consume();                // 成功一次
    const after = b.state().consecutiveErrors;
    return after === 0 && b.consume() === true;
  })());
  check('C3 会话墙钟不因常驻时间熔断（由单次提案时限承载）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 99, maxWritesPerSession: 99, maxConsecutiveErrors: 99, maxWallClockMs: 600000 });
    b.startedAt = Date.now() - 11 * 60 * 1000;
    const ok = b.consume(false);
    return ok === true && b.state().tripped === false;
  })());
  check('C3 熔断后不得再放行（不得静默重试）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 1, maxWritesPerSession: 99, maxConsecutiveErrors: 99, maxWallClockMs: 0 });
    b.consume();
    b.consume();                     // 熔断
    return b.consume() === false && b.consume() === false && b.state().remainingActions === 0;
  })());
  check('C3 reset() 可清空熔断状态（新一轮会话）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 1, maxWritesPerSession: 99, maxConsecutiveErrors: 99, maxWallClockMs: 0 });
    b.consume(); b.consume();
    b.reset();
    return b.state().tripped === false && b.consume() === true;
  })());
  check('C3 state() 暴露剩余配额（供UI 显示）', (() => {
    const b = new ExecutionBudget({ maxActionsPerSession: 5, maxWritesPerSession: 2, maxConsecutiveErrors: 3, maxWallClockMs: 0 });
    b.consume(false); b.consume(true);
    const s = b.state();
    return s.remainingActions === 3 && s.remainingWrites === 1 && s.actions === 2 && s.writes === 1;
  })());

  /* ===== ④ AuditLog 落盘（append-only）===== */
  check('C4 审计落盘后可从磁盘回读（重启不丢）', (() => {
    const dir = tmpDir('agent-audit-');
    const a = new AuditLog({ dir });
    const r = a.append({ proposalId: 'p1', capability: 'workspace.read', scope: inside, decision: 'allowed' });
    const all = a.readAll();
    return r.persisted === true && all.length === 1 && all[0].proposalId === 'p1';
  })());
  check('C4 append-only：多条追加不覆盖前条', (() => {
    const dir = tmpDir('agent-audit-');
    const a = new AuditLog({ dir });
    a.append({ proposalId: 'p1' });
    a.append({ proposalId: 'p2' });
    a.append({ proposalId: 'p3' });
    const all = a.readAll();
    return all.length === 3 && all.map((e) => e.proposalId).join(',') === 'p1,p2,p3';
  })());
  check('C4 🔴 凭据类字段绝不落盘（纵深防御）', (() => {
    const dir = tmpDir('agent-audit-');
    const a = new AuditLog({ dir });
    a.append({ proposalId: 'p1', apiKey: 'sk-SECRET', token: 'SECRET', password: 'x', capability: 'workspace.read' });
    const raw = fs.readFileSync(path.join(dir, 'agent-audit.jsonl'), 'utf8');
    return !/SECRET/.test(raw) && !/apiKey/.test(raw) && !/password/.test(raw);
  })());
  check('C4 超长字段被截断（防审计文件膨胀）', (() => {
    const dir = tmpDir('agent-audit-');
    const a = new AuditLog({ dir });
    a.append({ proposalId: 'p1', note: 'x'.repeat(2000) });
    const all = a.readAll();
    return all[0].note.length <= 500;
  })());
  check('C4 内存上限生效（events 不无限增长）', (() => {
    const a = new AuditLog({ maxMemory: 10 });
    for (let i = 0; i < 25; i++) a.append({ i });
    return a.list().length === 10;
  })());
  check('C4 无 dir 时退化为纯内存且不报错（向后兼容）', (() => {
    const a = new AuditLog();
    const r = a.append({ proposalId: 'p1' });
    return r.persisted === null && a.list().length === 1 && a.readAll().length === 0;
  })());

  /* ===== 提案状态机 ===== */
  check('提案状态机：合法状态可构造', (() => {
    const p = createActionProposal({ capability: 'workspace.read', scope: inside, status: 'approved' });
    return p.status === 'approved';
  })());
  check('提案状态机：非法状态被拒（防状态被随手写坏）', (() => {
    let threw = false;
    try { createActionProposal({ capability: 'workspace.read', scope: inside, status: 'whatever' }); }
    catch { threw = true; }
    return threw === true && PROPOSAL_STATES.includes('rolled_back');
  })());
  check('提案可携带预算会话 id（与熔断账本对齐）', (() => {
    const p = createActionProposal({ capability: 'workspace.read', scope: inside, budgetSessionId: 'sess-1' });
    return p.budgetSessionId === 'sess-1';
  })());
  check('提案对象仍是冻结的（不可事后篡改）', (() => {
    const p = createActionProposal({ capability: 'workspace.read', scope: inside });
    try { p.status = 'executed'; } catch { /* 严格模式下抛错也算通过 */ }
    return p.status === 'proposed';
  })());

  /* ===== 端到端：五道闸门串起来 ===== */
  check('E2E 白名单内只读动作走完全链路（提案→授权→预算→审计）', (() => {
    const dir = tmpDir('agent-e2e-');
    const reg = new CapabilityRegistry();
    const pol = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read'] });
    pol.setScopeRoots('workspace.read', [root]);
    const bud = new ExecutionBudget();
    const aud = new AuditLog({ dir });
    const prop = createActionProposal({ capability: 'workspace.read', scope: inside, budgetSessionId: 's1' });
    const verdict = pol.authorize(prop.capability, prop.scope, { meta: reg.metaOf(prop.capability) });
    aud.append({ proposalId: prop.id, decision: verdict.allowed, reason: verdict.reason, matchedRoot: verdict.matchedRoot });
    const spent = bud.consume(false);
    return verdict.allowed === true && spent === true
      && aud.readAll().length === 1 && aud.readAll()[0].matchedRoot === path.resolve(root);
  })());
  check('E2E 🔴 network.request 在完整链路下被拒且留痕', (() => {
    const dir = tmpDir('agent-e2e-deny-');
    const reg = new CapabilityRegistry();
    const pol = new PermissionPolicy({ killSwitch: false, allowed: ['network.request'] });
    pol.setScopeRoots('network.request', [root]);
    const bud = new ExecutionBudget();
    const aud = new AuditLog({ dir });
    const prop = createActionProposal({ capability: 'network.request', scope: 'https://example.com' });
    const verdict = pol.authorize(prop.capability, prop.scope, { meta: reg.metaOf(prop.capability) });
    aud.append({ proposalId: prop.id, decision: verdict.allowed, reason: verdict.reason });
    return verdict.allowed === false
      && aud.readAll()[0].decision === false
      && /反表演/.test(aud.readAll()[0].reason);
  })());
  check('E2E 预算熔断后拒绝继续执行，并留下熔断原因', (() => {
    const dir = tmpDir('agent-e2e-budget-');
    const aud = new AuditLog({ dir });
    const bud = new ExecutionBudget({ maxActionsPerSession: 2, maxWritesPerSession: 99, maxConsecutiveErrors: 99, maxWallClockMs: 0 });
    bud.consume(); bud.consume();
    const third = bud.consume();
    aud.append({ stage: 'budget', allowed: third, tripReason: bud.state().tripReason });
    return third === false && aud.readAll()[0].tripReason === 'max_actions_exceeded';
  })());

  /* ===== C 阶段加固回归：三处实测坐实的隐患（2026-10-06）===== */

  // 🔴 隐患1：looksLikePath 原先对「整条命令行」做路径判定，导致带路径参数的合法命令被误杀。
  check('加固1 🔴 带路径参数的合法命令不得被误判为路径', (() => {
    const reg = new CapabilityRegistry();
    const pol = new PermissionPolicy({ killSwitch: false, allowed: ['process.execute'] });
    const m = reg.metaOf('process.execute');
    // 原实现下这三条全部 allowed:false（reason=command_expected_not_path）→ 命令白名单形同虚设
    return pol.authorize('process.execute', 'git diff docs/agent/report.md', { meta: m }).allowed === true
      && pol.authorize('process.execute', 'node tools/release-check.js', { meta: m }).allowed === true
      && pol.authorize('process.execute', 'cat test/readme.txt', { meta: m }).allowed === true;
  })());
  check('加固1 命令名本身是路径时仍须拒绝（别把口子开太大）', (() => {
    const reg = new CapabilityRegistry();
    const pol = new PermissionPolicy({ killSwitch: false, allowed: ['process.execute'] });
    const m = reg.metaOf('process.execute');
    return pol.authorize('process.execute', 'C:\\Windows\\System32\\cmd.exe', { meta: m }).allowed === false
      && pol.authorize('process.execute', '/usr/bin/git status', { meta: m }).allowed === false;
  })());
  check('加固1 looksLikePath 只看命令名，参数不参与判定', (() => {
    return looksLikePath('git diff a/b.md') === false        // 命令名 git → 放行
      && looksLikePath('git status') === false
      && looksLikePath('cmd.exe') === false                  // 可执行文件名不是路径
      && looksLikePath('C:\\tools\\x.exe') === true         // 命令名是盘符路径 → 拦
      && looksLikePath('notes.txt') === true;              // 命令名自己像文件名 → 拦
  })());

  // 🔴 隐患2：authorize 不传 ctx.meta 时曾整个跳过硬拒绝检查 → network 硬封死被绕过。
  check('加固2 🔴 network.request 不传 ctx.meta 也必须硬拒（原漏洞：allowed:true）', (() => {
    const p = new PermissionPolicy({ killSwitch: false, allowed: ['network.request'] });
    p.setScopeRoots('network.request', ['C:\\safe']);
    const r = p.authorize('network.request', 'C:\\safe\\file');   // 故意不传 ctx
    return r.allowed === false && /反表演/.test(r.reason);
  })());
  check('加固2 can() 透传默认元数据（修前 can(git status) 恒为 false）', (() => {
    const q = new PermissionPolicy({ killSwitch: false, allowed: ['process.execute'] });
    return q.can('process.execute', 'git status') === true;
  })());
  check('加固2 显式 ctx.meta 仍优先于默认矩阵（便于测试注入）', (() => {
    const p = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read'] });
    p.setScopeRoots('workspace.read', [root]);
    const fake = { dangerLevel: 'low', requiresConfirm: true, scopeKind: 'path' };
    return p.authorize('workspace.read', inside, { meta: fake }).allowed === true;
  })());

  // 🔴 隐患3：register() 可把 hardDenied 洗白 → 给「把 network 放回来」留了后门。
  check('加固3 🔴 register() 不得覆盖 hardDenied 能力（原可洗白 network）', (() => {
    const r = new CapabilityRegistry();
    const ok = r.register('network.request', { hardDenied: false, dangerLevel: 'low' });
    return ok === false                        // 注册被拒
      && r.isHardDenied('network.request') === true
      && r.metaOf('network.request').dangerLevel === 'forbidden';   // 元数据未被改坏
  })());
  check('加固3 非硬封死能力仍可正常注册（守卫不误伤）', (() => {
    const r = new CapabilityRegistry();
    return r.register('clipboard.read', { dangerLevel: 'low', scopeKind: 'none' }) === true
      && r.register('process.execute', { dangerLevel: 'critical', scopeKind: 'command' }) === true;
  })());

  fs.rmSync(root, { recursive: true, force: true });
  console.log('agent interface tests passed:', pass);
})().catch((e) => { console.error(e); process.exit(1); });