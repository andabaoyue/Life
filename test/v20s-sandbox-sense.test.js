/**
 * test/v20s-sandbox-sense.test.js — v2.0-s1（s1-a：沙盒感官接线）门禁测试
 *
 * 覆盖：
 *   1. 非递归顶层清单 listSandboxTopLevel & workspace.list 执行器/预算隔离
 *   2. 读白名单 ALLOWED_READ_EXTENSIONS 与写白名单完全隔离 + 无扩展名纯文本/二进制探测
 *   3. 'readOnly' 双保险旁路（仅限 !isWrite 且 READ_ONLY_EXEMPT_CAPABILITIES）
 *   4. 读意图识别 shouldProposeFrom（正例、tsv、无扩展名、冲突写优先、问句/非法后缀反例）
 *   5. Brain 一次性消费即删槽位（2000 字截断、不入 selfNotes、不入 systemText、sleep 清理）
 *   6. main.js chat-send 外层只读前置接线 & onExecuted 隔离写回调
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  CAPABILITIES, CAPABILITY_META, PROPOSAL_SOURCES,
  PermissionPolicy, ExecutionBudget, AuditLog, createActionProposal,
} = require('../src/agent-interfaces');
const { UserConfirmationGate } = require('../src/agent-confirmation');
const { WriteTransactionManager } = require('../src/agent-transaction');
const {
  ControlledAgentExecutor,
  EXECUTABLE_CAPABILITIES,
  ALLOWED_WRITE_EXTENSIONS,
  ALLOWED_READ_EXTENSIONS,
  READ_ONLY_EXEMPT_CAPABILITIES,
} = require('../src/agent-executor');
const { registerAgentIpc } = require('../src/agent-ipc');
const { listSandboxTopLevel } = require('../src/agent-sandbox');
const { shouldProposeFrom } = require('../src/agent-intent');
const { evaluateTrigger } = require('../src/agent-trigger');
const { Brain } = require('../src/brain');
const { Memory } = require('../src/memory');
const { PERSONA } = require('../src/persona');

const ROOT = path.resolve(__dirname, '..');
const _tmpDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _tmpDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  fs.mkdtempSync = _origMkdtemp;
});

let pass = 0;
let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (extra ? '  ' + extra : ''));
  } else {
    failures++;
    console.log('FAIL  ' + name + (extra ? '  ' + extra : ''));
  }
}

function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s-sense-'));
  const sandbox = path.join(base, 'LifeSandbox');
  const outside = path.join(base, 'outside');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET', 'utf8');

  const policy = new PermissionPolicy({
    killSwitch: false,
    allowed: ['workspace.read', 'workspace.list', 'workspace.write'],
  });
  policy.setScopeRoots('workspace.read', [sandbox]);
  policy.setScopeRoots('workspace.list', [sandbox]);
  policy.setScopeRoots('workspace.write', [sandbox]);

  const budget = new ExecutionBudget();
  const auditLog = new AuditLog({ dir: dataDir });
  const confirmation = new UserConfirmationGate();
  const proposalStore = new Map();
  const contentSnapshotStore = new Map();
  const executor = new ControlledAgentExecutor({
    policy, budget, confirmation, auditLog, proposalStore,
    transactionManager: new WriteTransactionManager({ dir: dataDir }),
  });

  const executedNotes = [];
  const handlers = new Map();
  const ipcGuard = { handle: (ch, fn) => handlers.set(ch, fn) };
  const ipc = registerAgentIpc(
    ipcGuard,
    { policy, budget, confirmation, auditLog, proposalStore, contentSnapshotStore },
    { executor, onExecuted: (info) => { executedNotes.push(info); } },
  );

  return {
    base, sandbox, outside, dataDir, policy, budget, auditLog,
    confirmation, proposalStore, executor, ipc, executedNotes,
  };
}

(async () => {
  console.log('=== v2.0-s1 (s1-a) 沙盒感官门禁 ===');

  /* ============ 1. 能力注册与独立白名单隔离 ============ */
  check('1.1 CAPABILITIES 与 CAPABILITY_META 包含 workspace.list 且冻结',
    CAPABILITIES.includes('workspace.list')
    && Object.isFrozen(CAPABILITY_META['workspace.list'])
    && CAPABILITY_META['workspace.list'].requiresConfirm === false
    && EXECUTABLE_CAPABILITIES.includes('workspace.list'));

  check('1.2 读扩展名白名单与写白名单严格独立（.tsv 可读但绝不可写）',
    ALLOWED_READ_EXTENSIONS.has('.tsv')
    && !ALLOWED_WRITE_EXTENSIONS.has('.tsv')
    && ALLOWED_READ_EXTENSIONS !== ALLOWED_WRITE_EXTENSIONS
    && PROPOSAL_SOURCES.includes('readOnly'));

  /* ============ 2. 顶层清单非递归、去绝对路径、不烧预算 ============ */
  {
    const e = makeEnv();
    check('2.1 空沙盒顶层清单为 [] 且零预算消耗',
      listSandboxTopLevel(e.sandbox).length === 0 && e.budget.state().actions === 0);

    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(e.sandbox, `f${i}.txt`), `body-${i}`, 'utf8');
    }
    fs.mkdirSync(path.join(e.sandbox, 'nested'));
    fs.writeFileSync(path.join(e.sandbox, 'nested', 'inner.txt'), 'hidden', 'utf8');

    const listed = listSandboxTopLevel(e.sandbox);
    const hasAbsPath = listed.some((x) => JSON.stringify(x).includes(e.sandbox) || /[\\/]/.test(x.name));
    check('2.2 listSandboxTopLevel 非递归仅列顶层文件、无子目录与绝对路径、仍零预算消耗',
      listed.length === 7
      && !listed.some((x) => x.name === 'nested' || x.name === 'inner.txt')
      && !hasAbsPath
      && e.budget.state().actions === 0);

    const listProp = e.ipc.proposeInternal({ capability: 'workspace.list', scope: e.sandbox, reason: '看目录' }, 'main', 'readOnly');
    const listExec = e.ipc.executeInternal({ proposalId: listProp.proposal.id });
    check('2.3 workspace.list 走 readOnly 免确认执行成功且结果无绝对路径',
      listExec.ok === true
      && listExec.result.count === 7
      && !JSON.stringify(listExec.result).includes(e.sandbox));
  }

  /* ============ 3. 只读扩展名白名单 + 无扩展名内容探测 + readOnly 双保险 ============ */
  {
    const e = makeEnv();
    fs.writeFileSync(path.join(e.sandbox, 'data.tsv'), 'col1\tcol2\n1\t2\n', 'utf8');
    fs.writeFileSync(path.join(e.sandbox, 'README'), 'Hello Chulan\n这是无扩展名说明文本。', 'utf8');
    fs.writeFileSync(path.join(e.sandbox, 'bad.exe'), 'MZ-pretend', 'utf8');
    fs.writeFileSync(path.join(e.sandbox, 'BINBLOB'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]));

    // .tsv 读取成功
    const pTsv = e.ipc.proposeInternal({ capability: 'workspace.read', scope: path.join(e.sandbox, 'data.tsv'), reason: 'r' }, 'main', 'readOnly');
    const rTsv = e.ipc.executeInternal({ proposalId: pTsv.proposal.id });
    check('3.1 允许读扩展名 .tsv 走 readOnly 读取成功',
      rTsv.ok === true && rTsv.result.content.includes('col1\tcol2'));

    // 无扩展名纯文本探测放行
    const pReadme = e.ipc.proposeInternal({ capability: 'workspace.read', scope: path.join(e.sandbox, 'README'), reason: 'r' }, 'main', 'readOnly');
    const rReadme = e.ipc.executeInternal({ proposalId: pReadme.proposal.id });
    check('3.2 无扩展名纯 UTF-8 文本 README 探测通过',
      rReadme.ok === true && rReadme.result.content.includes('Hello Chulan'));

    // .exe 被 DISALLOWED_EXTENSION 拒
    const pExe = e.ipc.proposeInternal({ capability: 'workspace.read', scope: path.join(e.sandbox, 'bad.exe'), reason: 'r' }, 'main', 'readOnly');
    const rExe = e.ipc.executeInternal({ proposalId: pExe.proposal.id });
    check('3.3 非法扩展名 .exe 被执行器拒绝 DISALLOWED_EXTENSION',
      rExe.ok === false && rExe.error === 'DISALLOWED_EXTENSION');

    // 无扩展名二进制被探测拒绝
    const pBin = e.ipc.proposeInternal({ capability: 'workspace.read', scope: path.join(e.sandbox, 'BINBLOB'), reason: 'r' }, 'main', 'readOnly');
    const rBin = e.ipc.executeInternal({ proposalId: pBin.proposal.id });
    check('3.4 无扩展名二进制文件被内容探测拒绝 DISALLOWED_EXTENSION',
      rBin.ok === false && rBin.error === 'DISALLOWED_EXTENSION');

    // readOnly 双保险反例 1：ipc 侧对写能力一律降回 'user'
    const wProp = e.ipc.proposeInternal({
      capability: 'workspace.write',
      scope: path.join(e.sandbox, 'hack.md'),
      reason: 'w',
      content: 'try bypass',
    }, 'main', 'readOnly');
    check('3.5 双保险①：写提案传 readOnly 在 proposeInternal 被强制降级为 user',
      wProp.ok === true && wProp.proposal.proposalSource === 'user');

    // readOnly 双保险反例 2：即使手动强塞 proposalSource:'readOnly' 的写提案，Gate 4 也硬拒
    const forgedId = 'forged-write-readonly';
    const rawText = 'forged write';
    const forgedProp = createActionProposal({
      proposalId: forgedId,
      capability: 'workspace.write',
      scope: path.join(e.sandbox, 'forged.md'),
      reason: 'forged',
    }, null, 'readOnly', {
      contentHash: crypto.createHash('sha256').update(rawText, 'utf8').digest('hex'),
      contentBytes: Buffer.byteLength(rawText, 'utf8'),
      contentPreview: rawText,
    });
    e.proposalStore.set(forgedId, forgedProp);
    const rForged = e.executor.execute({ proposalId: forgedId, content: rawText });
    check('3.6 双保险②：手造 readOnly 写提案在执行器 Gate 4 仍被 EXECUTION_NOT_ALLOWED 拦下',
      rForged.ok === false && rForged.code === 'EXECUTION_NOT_ALLOWED');

    // 写 .tsv 依然被建案与执行器写白名单双重拒绝
    const wtProp = e.ipc.proposeInternal({
      capability: 'workspace.write',
      scope: path.join(e.sandbox, 'out.tsv'),
      reason: 'w',
    }, 'main', 'selfNote', 'a\tb');
    check('3.7 写白名单未被连带放宽：写 .tsv 仍被 DISALLOWED_EXTENSION 拒绝',
      wtProp.ok === false && wtProp.error === 'DISALLOWED_EXTENSION');

    // 3.8 只读感官 (workspace.list + workspace.read) 全程零消耗 actions（含不存在文件 ENOENT），连续 30+ 次后写额度仍完好；
    //     而一旦 budget 已被其它动作熔断，只读感官也必须立即被 BUDGET_TRIPPED 拦住。
    const eRead = makeEnv();
    fs.writeFileSync(path.join(eRead.sandbox, 'notes.txt'), 'quota-check', 'utf8');
    const bActionsBefore = eRead.budget.state().actions;
    for (let i = 0; i < 15; i++) {
      const lp = eRead.ipc.proposeInternal({ capability: 'workspace.list', scope: eRead.sandbox, reason: 'list' }, 'main', 'readOnly');
      const le = lp && lp.ok ? eRead.ipc.executeInternal({ proposalId: lp.proposal.id }) : null;
      const rp = eRead.ipc.proposeInternal({ capability: 'workspace.read', scope: path.join(eRead.sandbox, 'notes.txt'), reason: 'read' }, 'main', 'readOnly');
      const re = rp && rp.ok ? eRead.ipc.executeInternal({ proposalId: rp.proposal.id }) : null;
      if (!le || !le.ok || !re || !re.ok) {
        throw new Error(`3.8 read/list failed at iter=${i}: le=${JSON.stringify(le)} re=${JSON.stringify(re)}`);
      }
    }
    const missingP = eRead.ipc.proposeInternal({ capability: 'workspace.read', scope: path.join(eRead.sandbox, 'missing-target.txt'), reason: 'read' }, 'main', 'readOnly');
    const missingE = missingP && missingP.ok ? eRead.ipc.executeInternal({ proposalId: missingP.proposal.id }) : null;
    const bStateAfterReads = eRead.budget.state();
    const noteAfterReads = eRead.ipc.proposeInternal({
      capability: 'workspace.write',
      scope: path.join(eRead.sandbox, 'after-reads.txt'),
      reason: 'selfNote',
    }, 'main', 'selfNote', '读完之后依然能写');
    const noteExec = noteAfterReads && noteAfterReads.ok
      ? eRead.ipc.executeInternal({ proposalId: noteAfterReads.proposal.id })
      : null;

    // 熔断后必须立即拦住只读感官（建案期与执行期均不得放行）
    eRead.budget.tripped = true;
    const trippedList = eRead.ipc.proposeInternal({ capability: 'workspace.list', scope: eRead.sandbox, reason: 'list' }, 'main', 'readOnly');
    eRead.budget.tripped = false;
    check('3.8 只读感官 read/list 零消耗 actions（连续 30+ 次不挤占写额度），且熔断态仍被拦截',
      bActionsBefore === 0
      && missingP && missingP.ok === true && missingE && missingE.ok === false
      && bStateAfterReads.actions === 0
      && bStateAfterReads.tripped === false
      && noteAfterReads && noteAfterReads.ok === true && noteExec && noteExec.ok === true
      && trippedList && trippedList.ok === false && trippedList.error === 'BUDGET_TRIPPED');
  }

  /* ============ 4. 读意图识别 shouldProposeFrom & 外层无副作用 ============ */
  {
    const d1 = shouldProposeFrom('帮我读一下沙盒里的 data.tsv');
    const d2 = shouldProposeFrom('打开桌面沙盒里的 README');
    const d3 = shouldProposeFrom('看看 LifeSandbox 里的 notes.txt');
    const dQ = shouldProposeFrom('能帮我看看沙盒里的 notes.txt 吗？');
    const dBad = shouldProposeFrom('帮我读一下沙盒里的 payload.exe');
    const dConflict = shouldProposeFrom('帮我读一下沙盒里的 a.txt 再整理保存到桌面');

    check('4.1 读意图精准提取 .tsv 与无扩展名 README 且不影响现有写优先级',
      d1.shouldPropose && d1.capability === 'workspace.read' && d1.hint === 'data.tsv'
      && d2.shouldPropose && d2.capability === 'workspace.read' && d2.hint === 'README'
      && d3.shouldPropose && d3.capability === 'workspace.read' && d3.hint === 'notes.txt');

    check('4.2 问句拒触发、非法后缀拒触发、读写冲突时写优先',
      dQ.shouldPropose === false && dQ.reason === 'IS_QUESTION'
      && dBad.shouldPropose === false && dBad.reason === 'NO_CONCRETE_TARGET'
      && dConflict.shouldPropose === true && dConflict.capability === 'workspace.write');

    const vPure = evaluateTrigger('普通聊天不提文件', { config: { agentTriggerEnabled: true }, proactive: false });
    check('4.3 evaluateTrigger 纯无副作用判定命中开关且未触及 Brain 状态',
      vPure.ran === true && vPure.decision.shouldPropose === false);

    // 4.4 无扩展名白名单与误命中隔离：README / LICENSE 命中，PDF / ChatGPT / JSON / config 必须拒为 NO_CONCRETE_TARGET
    const dLic = shouldProposeFrom('打开桌面沙盒里的 LICENSE');
    const noisePhrases = [
      '看一下沙盒里那个 PDF',
      '看看沙盒里的 ChatGPT 记录',
      '你看一下沙盒里那些 JSON 怎么样了',
      '打开沙盒里的 config',
    ];
    const noiseResults = noisePhrases.map((s) => shouldProposeFrom(s));
    check('4.4 EXTENSIONLESS_READ_ALLOWLIST 仅放行白名单常见文本名并拒绝 PDF/ChatGPT/JSON/config 误命中',
      dLic.shouldPropose === true && dLic.capability === 'workspace.read' && dLic.hint === 'LICENSE'
      && noiseResults.every((r) => r.shouldPropose === false && r.reason === 'NO_CONCRETE_TARGET'));
  }

  /* ============ 5. Brain 一次性消费即删、2000 字截断、prefix 不变、selfNotes 隔离 ============ */
  {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s-sense-'));
    const capturedPayloads = [];
    const brain = new Brain(userDir, {
      apiKey: 'test-key',
      model: 'deepseek-chat',
      agentTriggerEnabled: true,
    });
    brain.api = {
      async stream(messages) {
        capturedPayloads.push(messages);
        return { text: '收到。', usage: {} };
      },
    };

    const sysBefore = brain.memory.systemText();
    const longContent = '甲'.repeat(2500);

    // 第 1 轮：带空沙盒清单 + 2500 字读结果
    await brain.ask('帮我读一下沙盒里的 README', () => {}, {
      sandboxList: [],
      sandboxRead: { name: 'README', bytes: Buffer.byteLength(longContent, 'utf8'), content: longContent },
    });

    const p1 = capturedPayloads[0];
    const lastUser1 = p1[p1.length - 1].content;
    check('5.1 首轮注入包含空沙盒提示 + 只读感官正文 + 2000 字显式截断提示',
      lastUser1.includes('当前为空')
      && lastUser1.includes('沙盒只读感官')
      && lastUser1.includes('README')
      && lastUser1.includes('〔已截断，原文 2500 字〕')
      && !lastUser1.includes('甲'.repeat(2005)));

    check('5.2 读取结果绝不流入 selfNotes 且零改动 systemText 前缀',
      brain.memory.data.selfNotes.length === 0
      && brain.memory.systemText() === sysBefore);

    // 第 2 轮：无 sandboxRead，断言上一轮结果已消费即删、绝不复读，且清单展示上限 5 个
    const sevenFiles = Array.from({ length: 7 }, (_, i) => ({ name: `note-${i + 1}.txt`, bytes: 10 + i, mtime: i }));
    await brain.ask('今天天气不错', () => {}, { sandboxList: sevenFiles });
    const p2 = capturedPayloads[1];
    const lastUser2 = p2[p2.length - 1].content;
    check('5.3 次轮只读感官槽位已清空不复读；非空沙盒清单最多展示 5 个文件名并标注总数',
      !lastUser2.includes('沙盒只读感官')
      && lastUser2.includes('note-1.txt') && lastUser2.includes('note-5.txt')
      && !lastUser2.includes('note-6.txt')
      && lastUser2.includes('共 7 个文件'));

    // sleepMode 拦截也清空待消费读槽位
    brain.tracker = {
      sleepMode: true,
      recordUserInput: () => false,
      snapshot: () => null,
      commit: () => {},
    };
    brain.setPendingSandboxRead({ name: 'leftover.txt', bytes: 3, content: 'abc' });
    await brain.ask('晚安消息', () => {}, {});
    check('5.4 睡眠拦截分支也会清空 _pendingSandboxRead，防醒后错轮泄露',
      brain.takeSandboxReadNote() === '');
  }

  /* ============ 6. main.js & persona.js 接线不变量 ============ */
  {
    const mainSrc = ['main.js', 'src/main-agent-ipc.js']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    check('6.1 main.js 含 buildReadSandboxScope、agentPolicy 放行 workspace.list、agentOnExecuted 屏蔽 readOnly',
      /function buildReadSandboxScope\(/.test(mainSrc)
      && /setScopeRoots\('workspace\.list'/.test(mainSrc)
      && /info\.proposalSource === 'readOnly'/.test(mainSrc)
      && /sandboxList = listSandboxTopLevel\(activeSandboxDir\)/.test(mainSrc));

    check('6.2 persona.js 声明沙盒感官边界且不含旧「看不见里面」矛盾文案',
      !/看不见里面/.test(PERSONA) && /沙盒之外/.test(PERSONA) && /顶层目前有哪些文件/.test(PERSONA));
  }

  console.log(`\nv20s-sandbox-sense: PASS=${pass}, FAIL=${failures}`);
  if (failures > 0) process.exit(1);
})();
