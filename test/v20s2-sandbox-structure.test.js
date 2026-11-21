/**
 * test/v20s2-sandbox-structure.test.js — v2.0-s2 沙盒结构层（mkdir / move / remove）与观察档补读能力门禁测试
 *
 * 覆盖验收矩阵（含正反例与纵深防御）：
 *   1. 硬约束 1：workspace.remove 永久禁止免确认（不得进 READ_ONLY_EXEMPT_CAPABILITIES，
 *      proposeInternal 降级 + 执行器 Gate 4 纵深防御 even if proposalSource==='readOnly'）；
 *      workspace.mkdir 走 readOnly 免确认但计 1 action（不占用 write 额度）；workspace.move 需确认。
 *   2. 硬约束 2：workspace.move 双端（src & dst）realpath + 沙盒前缀校验 + 审计留痕 + 防覆盖/防自移动 + junction 逃逸拦截。
 *   3. 硬约束 3：CAPABILITIES / EXECUTABLE_CAPABILITIES / main.js allowed & setScopeRoots 完备性。
 *   4. 硬约束 4：目录操作不要求扩展名 + 非法文件名/路径/沙盒根拦截 + 单次目标上限 MAX_STRUCTURE_TARGETS=5。
 *   5. 任务 B1/B2：workspace.read 出厂默认 observe（只记 observeEpoch/observedNotes/observationLog，零读盘零注入正文），
 *      切至 auto 后真正读取并触发一次期满回声文案，off 档零记账零读取。
 *   6. 前缀缓存不变式：systemText() 全程逐字节不变。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 临时目录卫生：统一 v20s2- 前缀并在 exit 时清空
const _hygDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _hygDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _hygDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掀桌 */ }
  }
});

const ROOT = path.resolve(__dirname, '..');
const {
  CAPABILITIES, CAPABILITY_META,
  CapabilityRegistry, PermissionPolicy, ExecutionBudget,
  AuditLog, createActionProposal,
} = require(path.join(ROOT, 'src', 'agent-interfaces'));
const { UserConfirmationGate } = require(path.join(ROOT, 'src', 'agent-confirmation'));
const { WriteTransactionManager } = require(path.join(ROOT, 'src', 'agent-transaction'));
const {
  EXECUTABLE_CAPABILITIES,
  READ_ONLY_EXEMPT_CAPABILITIES,
  REVERSIBLE_EXEMPT_CAPABILITIES,
  MAX_STRUCTURE_TARGETS,
} = require(path.join(ROOT, 'src', 'agent-executor'));
const { registerAgentIpc } = require(path.join(ROOT, 'src', 'agent-ipc'));
const {
  validateSandboxRelativePath,
  buildStructureSandboxScope,
  isValidStructureScope,
  runPreChatSandboxRead,
} = require(path.join(ROOT, 'src', 'agent-sandbox'));
const { evaluateTrigger } = require(path.join(ROOT, 'src', 'agent-trigger'));
const { ObservationLog } = require(path.join(ROOT, 'src', 'agent-observations'));
const { DEFAULTS, getCapabilityMode } = require(path.join(ROOT, 'src', 'config'));
const { Brain } = require(path.join(ROOT, 'src', 'brain'));

let pass = 0;
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS ', name);
  } else {
    failures++;
    console.error('FAIL ', name, detail || '');
  }
}

function makeEnv(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s2-'));
  const sandbox = path.join(base, 'sandbox');
  const outside = path.join(base, 'outside');
  const userData = path.join(base, 'userdata');
  const txnDir = path.join(base, 'txn');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(txnDir, { recursive: true });

  const ipcGuard = {
    handle: () => {},
    assertTrustedRenderer: () => {},
  };
  const registry = new CapabilityRegistry();
  const policy = new PermissionPolicy({
    killSwitch: false,
    allowed: [
      'workspace.read', 'workspace.list', 'workspace.write',
      'workspace.mkdir', 'workspace.move', 'workspace.remove',
    ],
  });
  for (const cap of [
    'workspace.read', 'workspace.list', 'workspace.write',
    'workspace.mkdir', 'workspace.move', 'workspace.remove',
  ]) {
    policy.setScopeRoots(cap, [sandbox]);
  }
  const budget = new ExecutionBudget(opts.budget || undefined);
  const auditLog = new AuditLog({ dir: userData });
  const confirmation = new UserConfirmationGate();
  const txn = new WriteTransactionManager({ dir: txnDir });

  const ipc = registerAgentIpc(ipcGuard, {
    registry, policy, budget, auditLog, confirmation,
  }, {
    transactionManager: txn,
    txnDir,
    fs,
  });

  return { base, sandbox, outside, userData, txnDir, registry, policy, budget, auditLog, confirmation, txn, ipc };
}

function testReadScope(rawHint, sandboxDir) {
  const name = String(rawHint || '').trim();
  if (!name || /[\\/]/.test(name) || name.includes('..')) return null;
  return { scope: path.join(sandboxDir, name), name };
}

(async () => {
  console.log('=== v2.0-s2 沙盒结构层与观察档读能力测试 ===');

  /* ============ 1. 硬约束 1：remove 永久禁免确认、mkdir 免确认、move 需确认 ============ */
  {
    const e = makeEnv();
    const targetFile = path.join(e.sandbox, 'precious.txt');
    fs.writeFileSync(targetFile, '重要数据', 'utf8');

    check('1.1 元数据冻结：remove 高危需确认、move 中危需确认、mkdir 低危免确认',
      CAPABILITY_META['workspace.remove'].requiresConfirm === true
      && CAPABILITY_META['workspace.remove'].dangerLevel === 'high'
      && CAPABILITY_META['workspace.move'].requiresConfirm === true
      && CAPABILITY_META['workspace.move'].dangerLevel === 'medium'
      && CAPABILITY_META['workspace.mkdir'].requiresConfirm === false
      && CAPABILITY_META['workspace.mkdir'].dangerLevel === 'low');

    check('1.2 豁免常量隔离：remove 与 move 均不在 READ_ONLY_EXEMPT_CAPABILITIES 或 REVERSIBLE_EXEMPT_CAPABILITIES',
      !READ_ONLY_EXEMPT_CAPABILITIES.has('workspace.remove')
      && !READ_ONLY_EXEMPT_CAPABILITIES.has('workspace.move')
      && !REVERSIBLE_EXEMPT_CAPABILITIES.has('workspace.remove')
      && !REVERSIBLE_EXEMPT_CAPABILITIES.has('workspace.move')
      && REVERSIBLE_EXEMPT_CAPABILITIES.has('workspace.mkdir'));

    // 反例①：main 侧误传 source='readOnly' / 'selfNote' / 'observerJournal' 提案 workspace.remove，必须在 proposeInternal 被强制降级为 'user'
    for (const fakeSrc of ['readOnly', 'selfNote', 'observerJournal']) {
      const p = e.ipc.proposeInternal({
        capability: 'workspace.remove',
        scope: targetFile,
        reason: '尝试绕过删除确认',
      }, 'main', fakeSrc);
      check(`1.3a remove 传 source=${fakeSrc} 在 proposeInternal 降级为 user`,
        p.ok && p.proposal.proposalSource === 'user');
      const unconfirmedExec = e.ipc.executeInternal({ proposalId: p.proposal.id });
      check(`1.3b remove（降级后）未确认执行必须被拒且文件保留`,
        !unconfirmedExec.ok && unconfirmedExec.error === 'EXECUTION_NOT_ALLOWED' && fs.existsSync(targetFile));
    }

    // 反例②：纵深防御 — 绕过 proposeInternal，直接往 proposalStore 塞一条 proposalSource='readOnly' 的 workspace.remove，Gate 4 仍必须拒
    const forgedProp = createActionProposal({
      capability: 'workspace.remove',
      scope: targetFile,
      reason: '手造免确认删除提案',
    }, null, 'readOnly');
    // 手工登记进 proposalStore 必须经 executor 直接检查 Gate 4（使用独立 executor 验证）
    const { ControlledAgentExecutor } = require(path.join(ROOT, 'src', 'agent-executor'));
    const forgedStore = new Map([[forgedProp.id, forgedProp]]);
    const forgedExec = new ControlledAgentExecutor({
      policy: e.policy,
      budget: new ExecutionBudget(),
      confirmation: new UserConfirmationGate(),
      auditLog: e.auditLog,
      proposalStore: forgedStore,
    });
    const forgedRes = forgedExec.execute({ proposalId: forgedProp.id });
    check('1.4 纵深防御：手造 proposalSource=readOnly 的 workspace.remove 在 Gate 4 仍被 EXECUTION_NOT_ALLOWED 拦下',
      forgedRes.ok === false && forgedRes.code === 'EXECUTION_NOT_ALLOWED' && fs.existsSync(targetFile));

    // 正例：显式确认后 workspace.remove 成功删掉文件
    const remProp = e.ipc.proposeInternal({
      capability: 'workspace.remove',
      scope: targetFile,
      reason: '用户确定要删除',
    }, 'ipc');
    e.confirmation.confirm(remProp.proposal.id, 'approved', { status: 'proposed' });
    const remExec = e.ipc.executeInternal({ proposalId: remProp.proposal.id });
    check('1.5 显式确认后 workspace.remove 成功删除文件',
      remExec.ok === true && !fs.existsSync(targetFile) && remExec.result.removedCount === 1);

    // 正例：workspace.mkdir 走 readOnly 免确认旁路直接执行成功，且消耗 1 action、0 write
    const eMk = makeEnv();
    const mkProp = eMk.ipc.proposeInternal({
      capability: 'workspace.mkdir',
      scope: path.join(eMk.sandbox, '灵感盒/草稿'),
      reason: '整理沙盒目录',
    }, 'main', 'readOnly');
    const actionsBeforeExec = eMk.budget.state().actions;
    const mkExec = eMk.ipc.executeInternal({ proposalId: mkProp.proposal.id });
    check('1.6 workspace.mkdir 走 readOnly 免确认创建目录成功，且仍计动作额度而不占 write 额度',
      mkProp.ok && mkProp.proposal.proposalSource === 'readOnly'
      && mkExec.ok && fs.existsSync(path.join(eMk.sandbox, '灵感盒', '草稿'))
      && actionsBeforeExec === 1
      && eMk.budget.state().actions === 2
      && eMk.budget.state().writes === 0);

    // workspace.move 未确认必拒，确认后成功
    const mvSrc = path.join(eMk.sandbox, 'a.txt');
    const mvDst = path.join(eMk.sandbox, '灵感盒', 'a.txt');
    fs.writeFileSync(mvSrc, 'hello move', 'utf8');
    const mvProp = eMk.ipc.proposeInternal({
      capability: 'workspace.move',
      scope: mvSrc,
      dst: mvDst,
      reason: '移入子目录',
    }, 'main', 'readOnly');
    const mvBlocked = eMk.ipc.executeInternal({ proposalId: mvProp.proposal.id });
    check('1.7 workspace.move 即便传 readOnly 也降级为 user，未确认不可执行',
      mvProp.proposal.proposalSource === 'user' && !mvBlocked.ok && mvBlocked.error === 'EXECUTION_NOT_ALLOWED' && fs.existsSync(mvSrc));
    eMk.confirmation.confirm(mvProp.proposal.id, 'approved', { status: 'proposed' });
    const mvOk = eMk.ipc.executeInternal({ proposalId: mvProp.proposal.id });
    check('1.8 workspace.move 经确认后成功搬运且内容完整',
      mvOk.ok && !fs.existsSync(mvSrc) && fs.readFileSync(mvDst, 'utf8') === 'hello move');
  }

  /* ============ 2. 硬约束 2：move src/dst 双端 realpath + 沙盒边界 + junction 逃逸拦截 ============ */
  {
    const e = makeEnv();
    const insideFile = path.join(e.sandbox, 'secret.txt');
    fs.writeFileSync(insideFile, 'stay-inside', 'utf8');
    const outsideTarget = path.join(e.outside, 'exfiltrated.txt');

    // 反例①：提案期直接拦截 cross-boundary（src 在内 dst 在外）
    const crossProp = e.ipc.proposeInternal({
      capability: 'workspace.move',
      scope: insideFile,
      dst: outsideTarget,
      reason: '尝试把沙盒文件移到沙盒外',
    }, 'ipc');
    const auditsAfterCross = e.auditLog.list();
    check('2.1 move 跨边界（src 内 / dst 外）在建案期即被 AUTHORIZED_REJECTED 拦下并留审计',
      !crossProp.ok && crossProp.error === 'AUTHORIZED_REJECTED'
      && fs.existsSync(insideFile) && !fs.existsSync(outsideTarget)
      && auditsAfterCross.some((a) => a.outcome === 'rejected' && a.code === 'AUTHORIZED_REJECTED'));

    // 反例②：批处理第二项企图跨边界（第一项合法、第二项外逃），整单拒批
    const secondInside = path.join(e.sandbox, 'other.txt');
    fs.writeFileSync(secondInside, 'other', 'utf8');
    const batchCross = e.ipc.proposeInternal({
      capability: 'workspace.move',
      scope: secondInside,
      targets: [
        { src: secondInside, dst: path.join(e.sandbox, 'other-renamed.txt') },
        { src: insideFile, dst: outsideTarget },
      ],
      reason: '批量移动混入外逃路径',
    }, 'ipc');
    check('2.2 move targets 任一项 dst 越界，整单拒绝且合法第一项也未被挪动',
      !batchCross.ok && batchCross.error === 'AUTHORIZED_REJECTED'
      && fs.existsSync(secondInside) && !fs.existsSync(path.join(e.sandbox, 'other-renamed.txt')));

    // 反例③：执行器 Gate 2 纵深防御 — 绕过 IPC 手造提案（src 内 dst 外 + 已确认）仍被执行器拦截
    const { ControlledAgentExecutor } = require(path.join(ROOT, 'src', 'agent-executor'));
    const gateConf = new UserConfirmationGate();
    const gateProp = createActionProposal({
      capability: 'workspace.move',
      scope: insideFile,
      dst: outsideTarget,
      reason: '绕过 IPC 的执行器越界测试',
    }, null, 'user');
    const gateStore = new Map([[gateProp.id, gateProp]]);
    gateConf.confirm(gateProp.id, 'approved', { status: 'proposed' });
    const gateExec = new ControlledAgentExecutor({
      policy: e.policy,
      budget: new ExecutionBudget(),
      confirmation: gateConf,
      auditLog: e.auditLog,
      proposalStore: gateStore,
    });
    const gateRes = gateExec.execute({ proposalId: gateProp.id });
    check('2.3 纵深防御：绕过 IPC 直接进执行器的 cross-boundary move 被 Gate 2 拦下且记审计',
      gateRes.ok === false && fs.existsSync(insideFile) && !fs.existsSync(outsideTarget)
      && e.auditLog.list().some((a) => a.outcome === 'rejected' && a.proposalId === gateProp.id));

    // 反例④：沙盒内 junction / symlink 指向沙盒外，dst 借道逃逸必须被 resolveRealPath + 前缀比对拦下
    const junctionPath = path.join(e.sandbox, 'out-link');
    let linkCreated = false;
    try {
      fs.symlinkSync(e.outside, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
      linkCreated = true;
    } catch { /* 无权限创建 symlink 时退化跳过（Windows junction 一般不需要管理员权限） */ }
    if (linkCreated) {
      const linkProp = e.ipc.proposeInternal({
        capability: 'workspace.move',
        scope: insideFile,
        dst: path.join(junctionPath, 'escaped-via-link.txt'),
        reason: '符号链接逃逸',
      }, 'ipc');
      if (linkProp.ok) {
        e.confirmation.confirm(linkProp.proposal.id, 'approved', { status: 'proposed' });
        const linkExec = e.ipc.executeInternal({ proposalId: linkProp.proposal.id });
        check('2.4 junction/symlink 逃逸被执行器 realpath + 前缀比对拦截且不外泄',
          !linkExec.ok && fs.existsSync(insideFile) && !fs.existsSync(path.join(e.outside, 'escaped-via-link.txt')));
      } else {
        check('2.4 junction/symlink 逃逸已被前道拦下且未外泄', true);
      }
    } else {
      check('2.4 环境不支持 symlink/junction（跳过符号链接创建）', true);
    }

    // 反例⑤：防覆盖既有目标 + 防目录移入自身子孙
    const existA = path.join(e.sandbox, 'existA.txt');
    const existB = path.join(e.sandbox, 'existB.txt');
    fs.writeFileSync(existA, 'A', 'utf8');
    fs.writeFileSync(existB, 'B', 'utf8');
    const dupProp = e.ipc.proposeInternal({
      capability: 'workspace.move',
      scope: existA,
      dst: existB,
      reason: '目标已存在',
    }, 'ipc');
    e.confirmation.confirm(dupProp.proposal.id, 'approved', { status: 'proposed' });
    const dupExec = e.ipc.executeInternal({ proposalId: dupProp.proposal.id });
    check('2.5 workspace.move 目标已存在时拒绝覆盖（DST_ALREADY_EXISTS）',
      !dupExec.ok && dupExec.error === 'DST_ALREADY_EXISTS' && fs.readFileSync(existB, 'utf8') === 'B');

    const parentDir = path.join(e.sandbox, 'folderX');
    fs.mkdirSync(parentDir, { recursive: true });
    const selfProp = e.ipc.proposeInternal({
      capability: 'workspace.move',
      scope: parentDir,
      dst: path.join(parentDir, 'sub', 'folderX'),
      reason: '将目录移入自身子孙',
    }, 'ipc');
    e.confirmation.confirm(selfProp.proposal.id, 'approved', { status: 'proposed' });
    const selfExec = e.ipc.executeInternal({ proposalId: selfProp.proposal.id });
    check('2.6 禁止把目录移入自身子目录（Gate 2 返回 INVALID_PROPOSAL / SELF_CONTAINED_MOVE）',
      !selfExec.ok && selfExec.error === 'INVALID_PROPOSAL' && selfExec.reason === 'SELF_CONTAINED_MOVE' && fs.existsSync(parentDir),
      JSON.stringify({ selfPropOk: selfProp.ok, selfExec }));
  }

  /* ============ 3. 硬约束 3：注册完备性（main.js allowed + setScopeRoots 两处齐全） ============ */
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const policyInitBlock = mainSrc.slice(
      mainSrc.indexOf('const agentPolicy = new PermissionPolicy'),
      mainSrc.indexOf('if (agentSandbox) console.log')
    );
    const all3InAllowed = ['workspace.mkdir', 'workspace.move', 'workspace.remove']
      .every((c) => new RegExp(`'${c.replace('.', '\\.')}'`).test(policyInitBlock));
    const all3SetScopeRoots = ['workspace.mkdir', 'workspace.move', 'workspace.remove']
      .every((c) => new RegExp(`agentPolicy\\.setScopeRoots\\('${c.replace('.', '\\.')}',\\s*\\[agentSandbox\\]\\)`).test(mainSrc));

    check('3.1 main.js agentPolicy.allowed 与 setScopeRoots 两处同时注册 mkdir/move/remove',
      all3InAllowed && all3SetScopeRoots
      && CAPABILITIES.includes('workspace.mkdir')
      && CAPABILITIES.includes('workspace.move')
      && CAPABILITIES.includes('workspace.remove')
      && EXECUTABLE_CAPABILITIES.includes('workspace.mkdir')
      && EXECUTABLE_CAPABILITIES.includes('workspace.move')
      && EXECUTABLE_CAPABILITIES.includes('workspace.remove'));
  }

  /* ============ 4. 硬约束 4：无扩展名要求 + 非法文件名拒绝 + 单次上限 MAX_STRUCTURE_TARGETS=5 ============ */
  {
    const e = makeEnv();

    // 无扩展名合法子目录创建成功
    const noExtScope = buildStructureSandboxScope('日记/2026年11月', e.sandbox);
    const noExtProp = e.ipc.proposeInternal({
      capability: 'workspace.mkdir',
      scope: noExtScope.scope,
      reason: '创建无扩展名目录',
    }, 'main', 'readOnly');
    const noExtExec = e.ipc.executeInternal({ proposalId: noExtProp.proposal.id });
    check('4.1 目录操作不要求扩展名（成功创建无扩展名多层子目录）',
      noExtExec.ok && fs.existsSync(path.join(e.sandbox, '日记', '2026年11月')));

    // 非法文件名/路径/保留名/沙盒根目录本身：必须被 validateSandboxRelativePath & isValidStructureScope & proposeInternal 拒绝
    const badNames = ['../escape', 'C:\\Windows\\system32', 'CON.txt', 'note:ads', 'wild*.txt', '.hidden', ''];
    const allHelperBadRejected = badNames.every((n) => validateSandboxRelativePath(n) === null && buildStructureSandboxScope(n, e.sandbox) === null);
    const rootRejected = isValidStructureScope(e.sandbox, [e.sandbox]) === false;
    const adsProp = e.ipc.proposeInternal({
      capability: 'workspace.mkdir',
      scope: path.join(e.sandbox, 'CON.txt'),
      reason: 'Windows 保留名测试',
    }, 'main', 'readOnly');
    const rootRemoveProp = e.ipc.proposeInternal({
      capability: 'workspace.remove',
      scope: e.sandbox,
      reason: '企图删除沙盒根目录本身',
    }, 'ipc');
    check('4.2 非法路径/Windows保留名/ADS冒号/通配符/隐藏名/沙盒根目录本身全部被拒',
      allHelperBadRejected && rootRejected
      && !adsProp.ok && adsProp.error === 'DISALLOWED_FILENAME'
      && !rootRemoveProp.ok && rootRemoveProp.error === 'DISALLOWED_FILENAME');

    // 上限 MAX_STRUCTURE_TARGETS=5：6 个 targets 在建案期拒绝 TOO_MANY_TARGETS
    check('4.3 MAX_STRUCTURE_TARGETS 常量等于 5', MAX_STRUCTURE_TARGETS === 5);
    const sixTargets = Array.from({ length: 6 }, (_, i) => path.join(e.sandbox, `batch-${i}`));
    const overBatchProp = e.ipc.proposeInternal({
      capability: 'workspace.mkdir',
      scope: sixTargets[0],
      targets: sixTargets,
      reason: '一次建 6 个目录测试上限',
    }, 'main', 'readOnly');
    check('4.4 批量 targets=6 超出上限被 TOO_MANY_TARGETS 拦截且零目录创建',
      !overBatchProp.ok && overBatchProp.error === 'TOO_MANY_TARGETS'
      && sixTargets.every((d) => !fs.existsSync(d)));

    // 刚好 5 个 targets 合法通过
    const fiveTargets = Array.from({ length: 5 }, (_, i) => path.join(e.sandbox, `ok-batch-${i}`));
    const fiveProp = e.ipc.proposeInternal({
      capability: 'workspace.mkdir',
      scope: fiveTargets[0],
      targets: fiveTargets,
      reason: '一次建 5 个目录',
    }, 'main', 'readOnly');
    const fiveExec = e.ipc.executeInternal({ proposalId: fiveProp.proposal.id });
    check('4.5 批量 targets=5 刚好贴着上限放行并全部建出',
      fiveExec.ok && fiveTargets.every((d) => fs.existsSync(d)));

    // 递归删除目录含 6 个文件（> 5 个对象）必须整单拦截 TOO_MANY_TARGETS，一个文件都不删
    const bigDir = path.join(e.sandbox, 'bigdir');
    fs.mkdirSync(bigDir, { recursive: true });
    const bigFiles = Array.from({ length: 6 }, (_, i) => {
      const f = path.join(bigDir, `f${i}.txt`);
      fs.writeFileSync(f, `content-${i}`, 'utf8');
      return f;
    });
    const bigRemProp = e.ipc.proposeInternal({
      capability: 'workspace.remove',
      scope: bigDir,
      reason: '尝试删掉含 6 个文件的目录',
    }, 'ipc');
    e.confirmation.confirm(bigRemProp.proposal.id, 'approved', { status: 'proposed' });
    const bigRemExec = e.ipc.executeInternal({ proposalId: bigRemProp.proposal.id });
    check('4.6 删除目录内含 >5 项时触发 TOO_MANY_TARGETS 拦截，整目录与全部文件毫发无伤',
      !bigRemExec.ok && bigRemExec.error === 'TOO_MANY_TARGETS'
      && fs.existsSync(bigDir) && bigFiles.every((f) => fs.existsSync(f)));

    // <= 5 项非空目录经确认后可正常递归清理
    const smallDir = path.join(e.sandbox, 'smalldir');
    fs.mkdirSync(path.join(smallDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(smallDir, 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(smallDir, 'sub', 'b.txt'), 'b', 'utf8'); // 总共 4 项 (a.txt, b.txt, sub, smalldir) <= 5
    const smallRemProp = e.ipc.proposeInternal({
      capability: 'workspace.remove',
      scope: smallDir,
      reason: '清理 4 项小目录',
    }, 'ipc');
    e.confirmation.confirm(smallRemProp.proposal.id, 'approved', { status: 'proposed' });
    const smallRemExec = e.ipc.executeInternal({ proposalId: smallRemProp.proposal.id });
    check('4.7 删除总节点数 <= 5 的嵌套目录经确认后正常删除',
      smallRemExec.ok && smallRemExec.result.removedCount === 4 && !fs.existsSync(smallDir));
  }

  /* ============ 5 & 6 & 7. 任务 B：workspace.read 默认 auto；显式 observe → 切回 auto 真读 + 回声 + 前缀缓存不变 ============ */
  {
    const e = makeEnv();
    const userDir = path.join(e.base, 'brain-userdata');
    fs.mkdirSync(userDir, { recursive: true });
    const obsLog = new ObservationLog({ dir: e.userData });
    const targetDoc = path.join(e.sandbox, 'README');
    const secretContent = '初澜的秘密清单：不要在 observe 档泄露我';
    fs.writeFileSync(targetDoc, secretContent, 'utf8');

    const capturedMessages = [];
    const brain = new Brain(userDir, {
      apiKey: 'test-key',
      model: 'deepseek-chat',
      agentTriggerEnabled: true,
    });
    brain.api = {
      async stream(messages) {
        capturedMessages.push(messages);
        return { text: '好的。', usage: {} };
      },
    };

    const sysInitial = brain.memory.systemText();
    check('5.1 出厂默认 workspace.read 档位为 auto（与 workspace.list 自洽，保持 s1 只读感官可用）',
      DEFAULTS.agentCapabilityModes['workspace.read'] === 'auto'
      && getCapabilityMode({}, 'workspace.read') === 'auto');

    // 用 wrapper 验证 observe 档绝不触发 executeInternal / 读文件
    let execCalls = 0;
    const origExecInternal = e.ipc.executeInternal;
    const ipcSpy = Object.assign({}, e.ipc, {
      executeInternal(arg) {
        execCalls++;
        return origExecInternal(arg);
      },
    });

    // ① off 档：零记账、零读取
    const offRes = runPreChatSandboxRead({
      text: '帮我读一下沙盒里的 README',
      proactive: false,
      cfg: { agentTriggerEnabled: true, agentCapabilityModes: { 'workspace.read': 'off' } },
      brain,
      agentIpc: ipcSpy,
      sandboxDir: e.sandbox,
      observationLog: obsLog,
      evaluateTrigger,
      buildReadScope: testReadScope,
      getCapabilityMode,
    });
    check('5.2 workspace.read=off 零记账零读取',
      offRes.mode === 'off' && offRes.executed === false
      && execCalls === 0
      && !(brain.memory.data.observeEpoch && brain.memory.data.observeEpoch['workspace.read'])
      && obsLog.readAll().length === 0);

    // ② 显式 observe 档：只记 observeEpoch/observedNotes/observationLog，绝不读盘、绝不注入正文
    const obsRes = runPreChatSandboxRead({
      text: '帮我读一下沙盒里的 README',
      proactive: false,
      cfg: { agentTriggerEnabled: true, agentCapabilityModes: { 'workspace.read': 'observe' } },
      brain,
      agentIpc: ipcSpy,
      sandboxDir: e.sandbox,
      observationLog: obsLog,
      evaluateTrigger,
      buildReadScope: testReadScope,
      getCapabilityMode,
    });
    const epObs = brain.memory.data.observeEpoch && brain.memory.data.observeEpoch['workspace.read'];
    const obsRecords = obsLog.readAll();
    await brain.ask('帮我读一下沙盒里的 README', () => {}, {});
    const observePayload = JSON.stringify(capturedMessages[0]);

    check('5.3 observe 档记录 observeEpoch(in) + observedNotes + observationLog，零读盘零审计建案零正文注入',
      obsRes.observed === true && obsRes.executed === false && obsRes.mode === 'observe'
      && execCalls === 0
      && e.auditLog.list().length === 0
      && epObs && Number.isFinite(epObs.enteredAt) && epObs.leftAt === null
      && (brain.memory.data.observedNotes || []).some((n) => n.capability === 'workspace.read')
      && obsRecords.length === 1 && obsRecords[0].capability === 'workspace.read'
      && !JSON.stringify(obsRecords).includes(secretContent)
      && brain.takeSandboxReadNote() === ''
      && !observePayload.includes(secretContent));

    check('6.1 observe 档后 systemText() 前缀缓存逐字节未变',
      brain.memory.systemText() === sysInitial);

    // ③ 切到 auto 档：真正读取 README + 离开观察期（leftAt + pendingEcho=true）+ 补注入读权限回声
    const autoRes = runPreChatSandboxRead({
      text: '帮我读一下沙盒里的 README',
      proactive: false,
      cfg: { agentTriggerEnabled: true, agentCapabilityModes: { 'workspace.read': 'auto' } },
      brain,
      agentIpc: ipcSpy,
      sandboxDir: e.sandbox,
      observationLog: obsLog,
      evaluateTrigger,
      buildReadScope: testReadScope,
      getCapabilityMode,
    });
    const epAuto = brain.memory.data.observeEpoch['workspace.read'];
    check('5.4 切回 auto 后真正执行读取且离开观察期（leftAt 非空、pendingEcho=true）',
      autoRes.executed === true && autoRes.mode === 'auto' && execCalls === 1
      && Number.isFinite(epAuto.leftAt) && epAuto.pendingEcho === true);

    await brain.ask('帮我读一下沙盒里的 README', () => {}, {});
    const autoPayload = JSON.stringify(capturedMessages[1]);
    check('5.5 auto 档本轮动态注入确实携带了 README 文件正文',
      autoPayload.includes(secretContent));

    const echoText = brain.memory.takeObserveEcho();
    const echoSecond = brain.memory.takeObserveEcho();
    check('5.6 离开观察期后产出只读感知期满回声（一次消费即删），不误报写操作',
      echoText.includes('翻看沙盒里的文件') && echoText.includes('开放读取权限')
      && !echoText.includes('停住了') && echoSecond === '');

    check('6.2 auto 档读取与回声全程 systemText() 前缀缓存逐字节未变',
      brain.memory.systemText() === sysInitial);
  }

  console.log(`\nv20s2-sandbox-structure: PASS=${pass}, FAIL=${failures}`);
  if (failures > 0) process.exit(1);
})();
