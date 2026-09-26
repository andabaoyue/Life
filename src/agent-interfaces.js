/**
 * Agent 预留层（v0.9.1）：只有抽象和 Mock，不连接 Codex、Shell、文件系统或进程。
 * 人格只能提出 ActionProposal；未来执行前必须经过权限策略和用户确认。
 */
const CAPABILITIES = Object.freeze(['workspace.read', 'workspace.write', 'process.execute', 'network.request']);

class CapabilityRegistry {
  constructor() { this.names = new Set(CAPABILITIES); }
  has(name) { return this.names.has(String(name)); }
  list() { return [...this.names]; }
}

class PermissionPolicy {
  constructor(opts = {}) {
    this.killSwitch = opts.killSwitch !== false;
    this.allowed = new Set(opts.allowed || []);
  }
  can(capability, scope) {
    if (this.killSwitch) return false;
    return this.allowed.has(String(capability)) && !!scope;
  }
  setKillSwitch(on) { this.killSwitch = !!on; }
}

function createActionProposal(input = {}) {
  return Object.freeze({
    id: String(input.id || 'proposal-' + Date.now()),
    capability: String(input.capability || ''),
    scope: String(input.scope || ''),
    reason: String(input.reason || '').slice(0, 500),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    requiresUserConfirmation: input.requiresUserConfirmation !== false,
    status: 'proposed'
  });
}

class AuditLog {
  constructor() { this.events = []; }
  append(event = {}) {
    this.events.push(Object.freeze({ at: Date.now(), ...event }));
    return this.events[this.events.length - 1];
  }
  list() { return this.events.slice(); }
}

class AgentBridgeMock {
  async propose(input) { return createActionProposal(input); }
  async execute() { throw new Error('AgentBridge 尚未连接真实执行器'); }
}

module.exports = { CAPABILITIES, CapabilityRegistry, PermissionPolicy,
  createActionProposal, AuditLog, AgentBridgeMock };
