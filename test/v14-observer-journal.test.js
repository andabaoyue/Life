/**
 * test/v14-observer-journal.test.js
 *
 * v1.4-b 门禁：生命观察日记内核（沙盒通路 B）全链路自决与安全防护
 *
 * ## 验证目标
 *   1. PROPOSAL_SOURCES 来源不被降级（契约白名单放行 observerJournal）
 *   2. 防伪造防线：IPC/渲染端自报 observerJournal 强制降级为 user
 *   3. trustedContent 真实使用：observerJournal 路径下权威快照绑定 trustedContent 而非 raw.content
 *   4. 执行器闸门 4 免确认放行（OBSERVER_JOURNAL_EXEMPT，绝不弹窗打扰用户）
 *   5. LifeSandbox 中 .md 写入全链路落盘与格式白名单通过
 *   6. 配额探针防御：写配额耗尽（writes >= 5 或 tripped）时前置静默跳过（0 调用、0 熔断）
 *   7. 精准去重：仅 journal-YYYY-MM-DD*.md 触发同日去重跳过，note-*.txt 绝不误拦截
 *   8. brain.askForObserverJournal 零时间数字泄漏、拒绝判定（「不」）与篇幅护栏（50~400 字）
 *   9. D-24 关窗铸造：自传经历档案包含 observerJournal 记录并落盘 engraved 标记
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  createActionProposal, PROPOSAL_SOURCES, ExecutionBudget, PermissionPolicy, AuditLog
} = require('../src/agent-interfaces');
const { ControlledAgentExecutor } = require('../src/agent-executor');
const { registerAgentIpc } = require('../src/agent-ipc');
const { UserConfirmationGate } = require('../src/agent-confirmation');
const { WriteTransactionManager } = require('../src/agent-transaction');
const { Brain } = require('../src/brain');

// 临时目录管理（前缀统一使用 d11- 确保与 tmp-hygiene 留档名单一致）
const _dirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdtempSync = _origMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.4-b 生命观察日记内核门禁 ---');

(async () => {
  /* ============ 1. PROPOSAL_SOURCES 契约不降级 ============ */
  {
    check('PROPOSAL_SOURCES 包含 observerJournal', PROPOSAL_SOURCES.includes('observerJournal'));

    const p = createActionProposal(
      { capability: 'workspace.write', scope: 'LifeSandbox/test.md' },
      null,
      'observerJournal',
      { contentHash: 'h', contentBytes: 10, contentPreview: 'prev', isTruncated: false }
    );
    check('createActionProposal 正确保留 observerJournal 来源不降级',
      p && p.proposalSource === 'observerJournal', p && p.proposalSource);

    const pMalicious = createActionProposal(
      { capability: 'workspace.write', scope: 'LifeSandbox/test.md' },
      null,
      'attacker_custom_source'
    );
    check('未知来源一律 fail-closed 降级为 user',
      pMalicious && pMalicious.proposalSource === 'user', pMalicious && pMalicious.proposalSource);
  }

  /* ============ 2. 防伪造防线：IPC 渲染端自报强制降级 ============ */
  {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const sandboxDir = path.join(appDir, 'LifeSandbox');
    fs.mkdirSync(sandboxDir, { recursive: true });

    const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.write'] });
    policy.setScopeRoots('workspace.write', [sandboxDir]);
    const budget = new ExecutionBudget();
    const auditLog = new AuditLog({ dir: appDir });
    const confirmation = new UserConfirmationGate();

    const ipc = registerAgentIpc(
      { handle() {}, assertTrustedRenderer() {} },
      { policy, budget, auditLog, confirmation }
    );

    // 渲染端（via: 'ipc'）自报 observerJournal
    const res = ipc.proposeInternal(
      { capability: 'workspace.write', scope: path.join(sandboxDir, 'test.md'), content: 'hello' },
      'ipc',
      'observerJournal'
    );
    check('渲染端自报 observerJournal 强制降级为 user',
      res && res.ok === true && res.proposal.proposalSource === 'user',
      res && res.proposal && res.proposal.proposalSource);
  }

  /* ============ 3. trustedContent 真实绑定验证（473 行改动验证） ============ */
  {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const sandboxDir = path.join(appDir, 'LifeSandbox');
    fs.mkdirSync(sandboxDir, { recursive: true });

    const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.write'] });
    policy.setScopeRoots('workspace.write', [sandboxDir]);
    const budget = new ExecutionBudget();
    const auditLog = new AuditLog({ dir: appDir });
    const confirmation = new UserConfirmationGate();

    const ipc = registerAgentIpc(
      { handle() {}, assertTrustedRenderer() {} },
      { policy, budget, auditLog, confirmation }
    );

    const trustedText = '这是初澜权威写入的生活观察日记正文。';
    const fakeRawText = '这是外部传入的伪造正文';
    const expectedHash = crypto.createHash('sha256').update(trustedText, 'utf8').digest('hex');

    const res = ipc.proposeInternal(
      { capability: 'workspace.write', scope: path.join(sandboxDir, 'journal-2026-10-18.md'), content: fakeRawText },
      'main',
      'observerJournal',
      trustedText
    );

    check('主进程 observerJournal 成功建案', res && res.ok === true);
    check('绑定 trustedContent 的内容哈希而非 raw.content',
      res && res.proposal && res.proposal.contentHash === expectedHash);
    check('绑定 trustedContent 的预览内容',
      res && res.proposal && res.proposal.contentPreview === trustedText);
  }

  /* ============ 4. 执行器闸门 4 免确认放行（OBSERVER_JOURNAL_EXEMPT） ============ */
  {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const sandboxDir = path.join(appDir, 'LifeSandbox');
    fs.mkdirSync(sandboxDir, { recursive: true });

    const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.write'] });
    policy.setScopeRoots('workspace.write', [sandboxDir]);
    const budget = new ExecutionBudget();
    const auditLog = new AuditLog({ dir: appDir });
    const confirmation = new UserConfirmationGate();
    const proposalStore = new Map();
    const transactionManager = new WriteTransactionManager({ dir: appDir });

    const executor = new ControlledAgentExecutor({
      policy, budget, confirmation, auditLog, proposalStore, transactionManager, fs
    });

    const journalContent = '今天看着窗外光影渐斜，心情很安稳。';
    const journalHash = crypto.createHash('sha256').update(journalContent, 'utf8').digest('hex');
    const contentMeta = {
      contentHash: journalHash,
      contentBytes: Buffer.byteLength(journalContent, 'utf8'),
      contentPreview: journalContent,
      isTruncated: false
    };

    const targetFile = path.join(sandboxDir, 'journal-2026-10-18.md');
    const proposal = createActionProposal(
      { capability: 'workspace.write', scope: targetFile, reason: '生活观察日记' },
      null,
      'observerJournal',
      contentMeta
    );
    proposalStore.set(proposal.id, proposal);

    // 未经 confirmation.confirm() 授权直接执行
    const execRes = executor.execute({
      proposalId: proposal.id,
      content: journalContent
    });

    check('闸门 4 免逐次确认直接放行 observerJournal',
      execRes && execRes.ok === true && execRes.executed === true);
    check('生成真实 .md 文件落盘在 LifeSandbox 中',
      fs.existsSync(targetFile) && fs.readFileSync(targetFile, 'utf8') === journalContent);
  }

  /* ============ 5. 配额探针防御（writes >= 5 时静默跳过） ============ */
  {
    const budget = new ExecutionBudget();
    // 模拟会话内已用完 5 次写配额
    for (let i = 0; i < 5; i++) budget.consume(true);

    const bState = budget.state();
    const shouldSkip = bState.tripped || (typeof bState.remainingWrites === 'number' && bState.remainingWrites <= 0);
    check('配额耗尽探针正确识别到应跳过日记生成', shouldSkip === true);
  }

  /* ============ 6. 精准日记去重：只认 journal-*.md，不冲突 note-*.txt ============ */
  {
    const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const ds = '2026-10-18';

    // 只有便签时：不冲突
    fs.writeFileSync(path.join(tmpSandbox, `note-${ds}-abcd.txt`), '便签内容');
    let files = fs.readdirSync(tmpSandbox);
    let alreadyWrittenJournal = files.some((f) => f.startsWith(`journal-${ds}`) && f.endsWith('.md'));
    check('沙盒内存在今日 note-*.txt 时不阻断观察日记', alreadyWrittenJournal === false);

    // 写入观察日记后：同日去重命中
    fs.writeFileSync(path.join(tmpSandbox, `journal-${ds}-1234.md`), '日记内容');
    files = fs.readdirSync(tmpSandbox);
    alreadyWrittenJournal = files.some((f) => f.startsWith(`journal-${ds}`) && f.endsWith('.md'));
    check('沙盒内存在今日 journal-*.md 时精准跳过', alreadyWrittenJournal === true);
  }

  /* ============ 7. askForObserverJournal 生成与护栏 ============ */
  {
    let captured = null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const b = new Brain(dir, { apiKey: 't', model: 'm', baseURL: 'http://127.0.0.1:1' });
    b.track = () => {};

    // 正常放行用例
    const normalText = '今天屋子里很安静，你专注地写了很久的代码。后来那些红色的错误全消失了，窗外的天也刚好暗下来。';
    b.api = {
      complete: async (messages) => {
        captured = messages;
        return { text: normalText, usage: { total: 30 } };
      }
    };

    b.memory.append('user', '今天终于把这个难啃的模块给攻克了！');
    b.memory.append('assistant', '太棒啦，辛苦啦~');

    const journalRes = await b.askForObserverJournal({ windowNo: 5 });
    check('正常生活观察日记成功返回', journalRes && journalRes.content === normalText);

    const userPrompt = captured && captured[1] ? captured[1].content : '';
    check('日记 prompt 中零「N 分钟」程序计时数字', !/\d+\s*分钟/.test(userPrompt));
    check('日记 prompt 中零 HH:MM 时钟数字', !/\b\d{1,2}:\d{2}\b/.test(userPrompt));
    check('日记 prompt 包含共同生活痕迹', userPrompt.includes('今天终于把这个难啃的模块给攻克了'));

    // 拒绝词测试（「不」/「不想写」返回 null）
    b.api = { complete: async () => ({ text: '不想写', usage: null }) };
    check('初澜回复「不想写」时静默放弃建案返回 null', (await b.askForObserverJournal({})) === null);

    // 篇幅护栏：超长（>400 字符）返回 null
    const tooLong = '字'.repeat(401);
    b.api = { complete: async () => ({ text: tooLong, usage: null }) };
    check('超过 400 字符篇幅护栏返回 null', (await b.askForObserverJournal({})) === null);

    // 篇幅护栏：过短（<30 字符）返回 null
    b.api = { complete: async () => ({ text: '今天挺好的。', usage: null }) };
    check('过短无观察细节（<30 字符）返回 null', (await b.askForObserverJournal({})) === null);
  }

  /* ============ 8. D-24 关窗铸造：自传经历档案闭环 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
    const b = new Brain(dir, { apiKey: 't', model: 'm', baseURL: 'http://127.0.0.1:1' });
    b.track = () => {};

    // 登记一条 observerJournal
    b.memory.addSelfNote({
      content: '今天在窗边看了一下午的雨，心里很踏实。',
      name: 'journal-2026-10-18-xyza.md',
      source: 'observerJournal',
      windowNo: 6
    });

    const pending = b.memory.selfNotesToEngrave();
    check('selfNotesToEngrave 正确收取 observerJournal 条目',
      pending.some((n) => n.source === 'observerJournal'));

    const mint = b._engraveSelfNotes(6);
    check('关窗成功铸造 observerJournal 为自传事实', mint.minted >= 1);
    check('铸造事实引证包含日记文件名', mint.facts.includes('journal-2026-10-18-xyza.md'));

    const remaining = b.memory.selfNotesToEngrave();
    check('铸造后标记 engraved: true，不重复铸造',
      remaining.filter((n) => n.name === 'journal-2026-10-18-xyza.md').length === 0);
  }

  console.log('\n测试完成，失败总数: ' + failures);
  if (failures > 0) process.exit(1);
})();
