const assert = require('assert');
const { CapabilityRegistry, PermissionPolicy, createActionProposal, AuditLog, AgentBridgeMock } = require('../src/agent-interfaces');
let pass = 0;
function check(name, value) { assert.ok(value, name); pass++; console.log('PASS', name); }
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
  console.log('agent interface tests passed:', pass);
})().catch(e => { console.error(e); process.exit(1); });
