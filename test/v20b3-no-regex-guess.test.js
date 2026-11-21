/**
 * test/v20b3-no-regex-guess.test.js — v2.0-b3 拆除关键词猜测 & 零猜测提案转单门禁
 *
 * 覆盖 v2.0-b3 施工单（含 §〇.1 源码复核修订）：
 *   1. 静态门禁 scanNoRegexGuess()：禁止「读取 assistant 回复文本 → 正则匹配 → 建单/流转」模式，含变异/判别力自检。
 *   2. 拆除确认：evaluateSubjectReplyTicketIntent / recordSubject* / resolveByExecution / maybeSyncSubjectTurnTickets 已移除，CRUD 完好。
 *   3. 行为反例：Brain 回复含「我这就去写」「这回不急着写」不产生任何 Ticket。
 *   4. 零猜测客观生产者全矩阵：仅「user + workspace.write + 未确认 + 未消费 + 超时 >10m」才转 Ticket 且同会话去重。
 *   5. 关窗接线与不变式：systemText() 逐字节不变、Ticket 不入 memory.history、persona.js 不知情。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const tmpDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...args) {
  const dir = _origMkdtemp.apply(fs, args);
  tmpDirs.push(dir);
  return dir;
};
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不抛 */ }
  }
  fs.mkdtempSync = _origMkdtemp;
});

const { Brain } = require(path.join(ROOT, 'src', 'brain'));
const lifecycle = require(path.join(ROOT, 'src', 'agent-lifecycle'));
const { TicketStore } = lifecycle;
const { registerAgentIpc } = require(path.join(ROOT, 'src', 'agent-ipc'));
const { createIpcGuard } = require(path.join(ROOT, 'src', 'ipc-guard'));
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
} = require(path.join(ROOT, 'src', 'agent-interfaces'));
const { UserConfirmationGate } = require(path.join(ROOT, 'src', 'agent-confirmation'));
const { ControlledAgentExecutor } = require(path.join(ROOT, 'src', 'agent-executor'));
const { createAgentRouter } = require(path.join(ROOT, 'src', 'agent-router'));

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

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * §4.3 静态门禁扫描器（三条任一命中即报违规）：
 *   1. 对 memory.data.history[...].content 做正则匹配后调用 record* / create* / transition*
 *   2. 函数名含 evaluateSubject*Intent / classify*Reply
 *   3. 函数接受入参 assistantText / replyText / utterance 且函数体内含中文正则字面量
 */
function scanNoRegexGuess(rawSrc) {
  const code = stripComments(rawSrc);
  const violations = [];

  if (/history\[[^\]]+\]\.content[\s\S]{0,600}(?:\.(?:test|exec|match)\(|\/[^/\n]+\/[\s\S]{0,200}\.(?:test|exec))[\s\S]{0,600}\b(?:record\w*|createTicket|transition)\s*\(/.test(code)) {
    violations.push('RULE_1_HISTORY_REGEX_TO_ACTION');
  }
  if (/\b(?:function\s+(?:evaluateSubject[A-Za-z0-9_]*Intent|classify[A-Za-z0-9_]*Reply)|(?:evaluateSubject[A-Za-z0-9_]*Intent|classify[A-Za-z0-9_]*Reply)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>))/.test(code)) {
    violations.push('RULE_2_FORBIDDEN_INTENT_CLASSIFIER_NAME');
  }
  const fnHeaderRe = /(?:function\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)|(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>)\s*\{/g;
  let m;
  while ((m = fnHeaderRe.exec(code)) !== null) {
    const params = m[1] || m[2] || '';
    const startIdx = m.index + m[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (endIdx < code.length && depth > 0 && (endIdx - startIdx) < 6000) {
      const ch = code[endIdx++];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = code.slice(startIdx, endIdx);
    if (/\b(?:assistantText|replyText|utterance)\b/.test(params)
        && /\/[^/\n]*[\u4e00-\u9fa5][^/\n]*\/[gimsuy]*/.test(body)) {
      violations.push('RULE_3_UTTERANCE_PARAM_WITH_ZH_REGEX');
    }
  }
  return violations;
}

function buildIpcTestHarness() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b3-'));
  const sbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b3-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b3-'));
  const localUrl = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
  const mainFrame = { url: localUrl };
  const webContents = { mainFrame, on() {}, setWindowOpenHandler() {} };
  const win = { webContents, isDestroyed: () => false };
  const channels = new Map();
  const ipcGuard = createIpcGuard({
    ipcMain: {
      handle(ch, fn) { channels.set(ch, fn); },
      on() {},
    },
    getMainWindow: () => win,
    appDir,
    getTrustedWebContents: () => [],
  });
  const registry = new CapabilityRegistry();
  const policy = new PermissionPolicy({
    killSwitch: false,
    allowed: ['workspace.read', 'workspace.list', 'workspace.write'],
  });
  policy.setScopeRoots('workspace.read', [sbDir]);
  policy.setScopeRoots('workspace.list', [sbDir]);
  policy.setScopeRoots('workspace.write', [sbDir]);

  const budget = new ExecutionBudget();
  const confirmation = new UserConfirmationGate();
  const auditLog = new AuditLog({ dir: dataDir });
  const proposalStore = new Map();
  const executor = new ControlledAgentExecutor({
    policy,
    budget,
    confirmation,
    auditLog,
    proposalStore,
    txnDir: dataDir,
  });

  const agentIpc = registerAgentIpc(ipcGuard, {
    registry,
    policy,
    budget,
    confirmation,
    auditLog,
  }, {
    proposalStore,
    executor,
    txnDir: dataDir,
  });

  return { sbDir, dataDir, policy, budget, confirmation, proposalStore, executor, agentIpc };
}

(async function run() {
  console.log('--- v2.0-b3 拆除关键词猜测与零猜测提案转单门禁 ---');

  /* ============ 1. 静态门禁与判别力自检 ============ */
  const lifecycleSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent-lifecycle.js'), 'utf8');
  const routerSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent-router.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  const vLifecycle = scanNoRegexGuess(lifecycleSrc);
  const vRouter = scanNoRegexGuess(routerSrc);
  const vMain = scanNoRegexGuess(mainSrc);
  check('T1.1 静态门禁：agent-lifecycle / agent-router / main.js 均无自然语言正则建单模式',
    vLifecycle.length === 0 && vRouter.length === 0 && vMain.length === 0,
    JSON.stringify({ vLifecycle, vRouter, vMain }));

  // 判别力自检：把被拆除的违规写法与 history 正则写法喂进去，必须全部检出
  const mutantSample = `
    function evaluateSubjectReplyTicketIntent(assistantText) {
      if (/(?:我这就去写|先不写)/.test(assistantText)) return { kind: 'defer' };
      return null;
    }
    function sneak(memory, store) {
      const t = memory.data.history[last].content;
      if (/去写/.test(t)) store.createTicket({ title: 'x' });
    }
  `;
  const mutantViolations = scanNoRegexGuess(mutantSample);
  check('T1.2 判别力自检：注入被删函数名/中文正则/history正则均触发门禁 FAIL（防空转）',
    mutantViolations.includes('RULE_1_HISTORY_REGEX_TO_ACTION')
    && mutantViolations.includes('RULE_2_FORBIDDEN_INTENT_CLASSIFIER_NAME')
    && mutantViolations.includes('RULE_3_UTTERANCE_PARAM_WITH_ZH_REGEX'),
    JSON.stringify(mutantViolations));

  /* ============ 2. 拆除确认 & TicketStore 存储能力完整 ============ */
  const protoNames = Object.getOwnPropertyNames(TicketStore.prototype);
  check('T2.1 拆除确认：evaluateSubjectReplyTicketIntent / recordSubject* / resolveByExecution / maybeSyncSubjectTurnTickets 已彻底删除',
    lifecycle.evaluateSubjectReplyTicketIntent === undefined
    && !protoNames.includes('recordSubjectDeferral')
    && !protoNames.includes('recordSubjectActive')
    && !protoNames.includes('resolveByExecution')
    && !protoNames.includes('_findActiveSubjectTicket')
    && !stripComments(lifecycleSrc).includes('evaluateSubjectReplyTicketIntent')
    && !stripComments(mainSrc).includes('maybeSyncSubjectTurnTickets')
    && !stripComments(routerSrc).includes('maybeSyncSubjectTurnTickets'));

  const crudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b3-'));
  const crudStore = new TicketStore({ dir: crudDir });
  const c1 = crudStore.createTicket({ title: '测试事项', capability: 'workspace.write', windowNo: 7 });
  const t1 = c1.ok ? crudStore.transition(c1.ticket.id, 'paused', { note: '先搁着', windowNo: 7 }) : null;
  const n1 = t1 && t1.ok ? crudStore.updateNote(c1.ticket.id, '补注', { windowNo: 7 }) : null;
  const e1 = n1 && n1.ok ? crudStore.transition(c1.ticket.id, 'ended', { windowNo: 7 }) : null;
  check('T2.2 存储层未受损：TicketStore CRUD 与三态机全部可用',
    c1.ok && t1.ok && t1.ticket.state === 'paused' && n1.ok && n1.ticket.note === '补注' && e1.ok && e1.ticket.state === 'ended'
    && crudStore.list().length === 1);

  /* ============ 3. 行为反例：回复含原短语不再建任何 Ticket ============ */
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b3-'));
  const brain = new Brain(brainDir, { apiKey: 'test-key', model: 'deepseek-chat' });
  const replies = [
    '我这就去写，等下写完搁进沙盒给你看。[state:idle]',
    '这回不急着写，还搁在手里，先把它说清楚。[state:thinking]',
  ];
  let replyIdx = 0;
  brain.api = {
    async stream() {
      const text = replies[replyIdx++] || '嗯。[state:idle]';
      return { text, usage: {} };
    },
  };
  const router = createAgentRouter();
  await brain.ask('第一轮', () => {}, {});
  router.handleEvent({ kind: 'turn_chat' }, { agentSandbox: os.tmpdir(), handlers: {} });
  await brain.ask('第二轮', () => {}, {});
  router.handleEvent({ kind: 'turn_chat' }, { agentSandbox: os.tmpdir(), handlers: {} });

  check('T3.1 ❌ 关键反例：回复含「我这就去写」「这回不急着写」均不产生任何 Ticket',
    brain.ticketStore.list().length === 0);

  /* ============ 4. 唯一零猜测生产者：全矩阵验证 ============ */
  const h = buildIpcTestHarness();
  const baseNow = Date.now();
  const past20m = baseNow - 20 * 60 * 1000;
  const past5m = baseNow - 5 * 60 * 1000;

  // 4.1 空 proposalStore → 空数组
  const emptyDrain = h.agentIpc.drainExpiredPendingWriteProposals(baseNow);

  // 4.2 放入 6 种提案（用测试注入的 createdAt 检查 TTL，其余全部走真实 proposeInternal / confirm / executeInternal）
  const pExpiredPending = h.agentIpc.proposeInternal({
    capability: 'workspace.write',
    scope: path.join(h.sbDir, '待整理笔记.md'),
    reason: '按你的要求整理',
    content: '# 待整理笔记\n正文内容。',
    createdAt: past20m,
  }, 'main');

  const pFreshPending = h.agentIpc.proposeInternal({
    capability: 'workspace.write',
    scope: path.join(h.sbDir, '刚拟好的草稿.md'),
    reason: '未超时',
    content: 'fresh content',
    createdAt: past5m,
  }, 'main');

  const pExpiredSelfNote = h.agentIpc.proposeInternal({
    capability: 'workspace.write',
    scope: path.join(h.sbDir, 'note-self.txt'),
    reason: '自留',
    createdAt: past20m,
  }, 'main', 'selfNote', '自留内容');

  fs.writeFileSync(path.join(h.sbDir, 'old-read.txt'), 'hello', 'utf8');
  const pExpiredRead = h.agentIpc.proposeInternal({
    capability: 'workspace.read',
    scope: path.join(h.sbDir, 'old-read.txt'),
    reason: '读取',
    createdAt: past20m,
  }, 'main', 'readOnly');

  const pExpiredDenied = h.agentIpc.proposeInternal({
    capability: 'workspace.write',
    scope: path.join(h.sbDir, '用户拒绝的.md'),
    reason: '测试拒绝',
    content: 'denied content',
    createdAt: past20m,
  }, 'main');
  const cDeny = h.confirmation.confirm(pExpiredDenied.proposal.id, 'rejected', { status: 'proposed' });
  if (!cDeny || !cDeny.ok) throw new Error('expected confirm rejected ok');

  const pExpiredApproved = h.agentIpc.proposeInternal({
    capability: 'workspace.write',
    scope: path.join(h.sbDir, '用户批准但待执行.md'),
    reason: '测试批准',
    content: 'approved content',
    createdAt: past20m,
  }, 'main');
  const cApprove = h.confirmation.confirm(pExpiredApproved.proposal.id, 'approved', { status: 'proposed' });
  if (!cApprove || !cApprove.ok) throw new Error('expected confirm approved ok');

  const pExpiredConsumed = h.agentIpc.proposeInternal({
    capability: 'workspace.write',
    scope: path.join(h.sbDir, '已执行的.md'),
    reason: '测试已消费',
    content: 'consumed content',
    createdAt: past20m,
  }, 'main');
  // 直接标记为已消费，模拟 10 分钟内曾执行完毕但 proposal.status 仍冻结为 'proposed'
  h.executor.consumed.add(pExpiredConsumed.proposal.id);

  // 验证 freeze 不变式：已消费与已拒绝/已批准提案 status 仍为 'proposed'（证明必须查 confirmation.lookup + consumed）
  const stillProposed = pExpiredConsumed.proposal.status === 'proposed'
    && pExpiredDenied.proposal.status === 'proposed'
    && pExpiredApproved.proposal.status === 'proposed';

  const drained1 = h.agentIpc.drainExpiredPendingWriteProposals(baseNow);
  const drained2 = h.agentIpc.drainExpiredPendingWriteProposals(baseNow + 1000);

  check('T4.1 空池返回空数组，不造垃圾',
    Array.isArray(emptyDrain) && emptyDrain.length === 0);

  check('T4.2 冻结陷阱证实：consumed/denied/approved 提案的 proposal.status 仍为 proposed',
    stillProposed);

  check('T4.3 仅超时未决的 user+workspace.write 被检出（1/7），fresh/selfNote/read/denied/approved/consumed 全部排除，且标题取 basename',
    drained1.length === 1
    && drained1[0].id === pExpiredPending.proposal.id
    && drained1[0].name === '待整理笔记.md',
    JSON.stringify(drained1));

  check('T4.4 同会话去重：连续第二次调用不重复建单',
    Array.isArray(drained2) && drained2.length === 0);

  /* ============ 5. 关窗接线 + 三条不变式 ============ */
  const sysBefore = brain.memory.systemText();
  const winBlockIdx = mainSrc.indexOf("routeAgentEvent({ kind: 'window_closed'");
  const winBlockSlice = winBlockIdx >= 0 ? mainSrc.slice(winBlockIdx, winBlockIdx + 260) : '';
  check('T5.1 源码接线：main.js 关窗时调用 syncExpiredProposalsToTickets()，且内部调用 drainExpiredPendingWriteProposals',
    winBlockSlice.includes('syncExpiredProposalsToTickets()')
    && mainSrc.includes('function syncExpiredProposalsToTickets')
    && mainSrc.includes('drainExpiredPendingWriteProposals')
    && mainSrc.includes('有一份没落的稿子，搁在那儿'));

  // 把 T4.3 产出的客观提案建入 Ticket 并验证 systemText / memory.history 不变式
  const tProd = brain.ticketStore.createTicket({
    title: drained1[0].name,
    state: 'paused',
    capability: 'workspace.write',
    note: '有一份没落的稿子，搁在那儿',
    windowNo: 6,
  });
  brain.memory.append('user', '继续聊');
  const builtMsgs = brain.memory.build();
  const builtTail = builtMsgs[builtMsgs.length - 1].content;
  const histStr = JSON.stringify(brain.memory.data.history);
  const personaSrc = fs.readFileSync(path.join(ROOT, 'src', 'persona.js'), 'utf8');

  check('T5.2 不变式：零猜测 Ticket 进入尾部注入，systemText() 逐字节不变、不入 history、persona 不提 Ticket',
    tProd.ok && tProd.ticket.title === '待整理笔记.md'
    && !/(?:超时未决|提案)/.test(tProd.ticket.note || '')
    && brain.memory.systemText() === sysBefore
    && builtMsgs[0].content === sysBefore
    && builtTail.includes('待整理笔记.md')
    && !histStr.includes('待整理笔记.md')
    && !/Ticket|未完事项/.test(personaSrc));

  console.log(`\nv20b3-no-regex-guess: PASS=${pass}, FAIL=${failures}`);
  if (failures > 0) process.exit(1);
})();
