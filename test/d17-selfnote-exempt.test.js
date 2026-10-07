/**
 * test/d17-selfnote-exempt.test.js
 *
 * D-17 门禁：自发愿望免确认（C1）+ 来源不可伪造 + 阈值可配。
 *
 * ## 用户拍板 C1 的理由（原话）
 *   「留便签的本质是趁你不在时悄悄写下。如果留便签还要弹卡片等授权，
 *     那用户都回到电脑前了，她才跑出来问『我能不能留个条』。」
 *
 * ## 🔴 本轮唯一的真安全面：来源戳不可伪造
 *   `proposalSource` 走 createActionProposal 的**独立第三参数**，
 *   绝不在 input（渲染端 payload）里读。若可自报来源，
 *   渲染端塞一个 selfNote 就能拆掉第五道闸门 —— D-3 顶替攻击那一族。
 *
 * ## 覆盖的三类反例
 *   ① 漏传参数：无提案 / 空 id / 非法来源值 —— 一律按 user（fail-closed）
 *   ② 恶意变体：渲染端 payload 塞 selfNote / 非法来源串 / 通道层伪造
 *   ③ 边界值：阈值可配的上下界、selfNote 与 user 两条路的对照
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerAgentIpc } = require('../src/agent-ipc');
const { PermissionPolicy, ExecutionBudget, CapabilityRegistry, createActionProposal } = require('../src/agent-interfaces');
const { UserConfirmationGate } = require('../src/agent-confirmation');
const { WriteTransactionManager } = require('../src/agent-transaction');
const { TriggerEngine, computeSelfIntent, SELF_INTENT_KINDS } = require('../src/trigger');
const { ActivityTracker } = require('../src/tracker');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function harness() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'd17-sb-'));
  const txnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd17-txn-'));
  const pol = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.write'] });
  pol.setScopeRoots('workspace.write', [sb]);
  const conf = new UserConfirmationGate();
  const handlers = {};
  const guard = { handle: (c, f) => { handlers[c] = f; }, assertTrustedRenderer() {}, isTrustedRenderer: () => true };
  const executed = [];
  const api = registerAgentIpc(guard,
    { registry: new CapabilityRegistry(), policy: pol, budget: new ExecutionBudget(), auditLog: { list: () => [], append: () => {} }, confirmation: conf },
    { transactionManager: new WriteTransactionManager({ dir: txnDir }), txnDir,
      onExecuted: (x) => executed.push(x) });
  return { sb, api, conf, handlers, executed };
}

console.log('--- D-17 自发愿望免确认门禁 ---');

/* ============ 1. 🔴 来源戳不可伪造（本轮唯一真安全面） ============ */
{
  check('默认来源 = user（缺省即需确认，fail-closed）',
    createActionProposal({ capability: 'workspace.write', scope: '/x' }).proposalSource === 'user');
  check('主进程显式第三参数可给 selfNote',
    createActionProposal({ capability: 'workspace.write', scope: '/x' }, null, 'selfNote').proposalSource === 'selfNote');
  check('🔴 渲染端在 payload 里塞 proposalSource 一律无效（仍是 user）',
    createActionProposal({ capability: 'workspace.write', scope: '/x', proposalSource: 'selfNote' }).proposalSource === 'user');
  check('🔴 非法来源值回落 user（白名单外一律拒）',
    createActionProposal({ capability: 'workspace.write', scope: '/x' }, null, 'hacked').proposalSource === 'user');
  check('🔴 大小写/空白变体不构成绕过',
    createActionProposal({ capability: 'workspace.write', scope: '/x' }, null, ' SelfNote ').proposalSource === 'user');
  check('非字符串来源回落 user',
    createActionProposal({ capability: 'workspace.write', scope: '/x' }, null, { toString: () => 'selfNote' }).proposalSource === 'user');
}

/* ============ 2. 通道层永远给不出 selfNote ============ */
{
  const h = harness();
  // 模拟渲染端经 propose 通道提交，payload 里带伪造来源
  const p = h.api.proposeInternal(
    { capability: 'workspace.write', scope: path.join(h.sb, 'fake.txt'), reason: 'x', proposalSource: 'selfNote' },
    'ipc');
  check('🔴 通道来的提案来源必须是 user', p.proposal && p.proposal.proposalSource === 'user',
    p.proposal && p.proposal.proposalSource);
  const ex = h.api.executeInternal({ proposalId: p.proposal.id, content: 'x' });
  check('🔴 通道伪造 selfNote 仍须确认（未确认被拒）',
    ex && ex.ok === false && ex.error === 'EXECUTION_NOT_ALLOWED', ex && ex.error);
}

/* ============ 3. selfNote 免确认真的能落盘 ============ */
{
  const h = harness();
  const p = h.api.proposeInternal(
    { capability: 'workspace.write', scope: path.join(h.sb, 'note.txt'), reason: '想留点什么' },
    'main', 'selfNote');
  check('主进程可盖 selfNote 戳', p.proposal.proposalSource === 'selfNote');
  const ex = h.api.executeInternal({ proposalId: p.proposal.id, content: '我想留一句话' });
  check('🔴 selfNote 免确认执行成功（无需任何 confirm 调用）', ex && ex.ok === true, ex && ex.error);
  check('🔴 文件真的落盘', fs.readdirSync(h.sb).includes('note.txt'));
  check('内容正确', fs.readFileSync(path.join(h.sb, 'note.txt'), 'utf8') === '我想留一句话');
  check('onExecuted hook 被触发（D-13 记忆回流的前提）', h.executed.length === 1);
}

/* ============ 4. 对照：user 来源必须仍要确认 ============ */
{
  const h = harness();
  const p = h.api.proposeInternal(
    { capability: 'workspace.write', scope: path.join(h.sb, 'user.md'), reason: '帮我写' }, 'main');
  check('主进程默认来源 = user', p.proposal.proposalSource === 'user');
  const ex = h.api.executeInternal({ proposalId: p.proposal.id, content: 'x' });
  check('🔴 user 来源未确认被拒（D-3 第五道闸门未松动）',
    ex && ex.ok === false && ex.error === 'EXECUTION_NOT_ALLOWED');
  check('🔴 user 来源未确认时沙盒必须为空', fs.readdirSync(h.sb).length === 0);
}

/* ============ 5. 免确认不含安全豁免（四道硬约束仍在） ============ */
{
  const h = harness();
  // 沙盒外的路径：即便盖了 selfNote，闸门 2（scope）也必须拒
  const outside = path.join(os.tmpdir(), 'd17-outside.txt');
  const p = h.api.proposeInternal(
    { capability: 'workspace.write', scope: outside, reason: 'x' }, 'main', 'selfNote');
  check('🔴 沙盒外路径：建案即被 scope 闸门拒（selfNote 不豁免范围）',
    p && p.ok === false, p && p.error);
  // hardDenied 能力：process.execute 即便 selfNote 也拒
  const p2 = h.api.proposeInternal(
    { capability: 'process.execute', scope: 'x', reason: 'x' }, 'main', 'selfNote');
  check('🔴 process.execute 即便 selfNote 也被拒（永久硬拒不受影响）',
    p2 && p2.ok === false, p2 && p2.error);
}

/* ============ 6. 阈值可配（验证模式） ============ */
{
  check('默认阈值不变：wantToLeaveSomething 仍是 120 分钟',
    SELF_INTENT_KINDS.wantToLeaveSomething.min === 120);
  check('computeSelfIntent 默认仍按 120 分钟（99 分钟不触发）',
    !computeSelfIntent({ traits: {}, idleMinutes: 99 }) ||
    computeSelfIntent({ traits: {}, idleMinutes: 99 }).kind !== 'wantToLeaveSomething');
  check('可传 selfNoteMinMinutes 覆盖（3 分钟即触发）',
    (computeSelfIntent({ traits: {}, idleMinutes: 3, selfNoteMinMinutes: 3 }) || {}).kind === 'wantToLeaveSomething');
  check('非法覆盖值回落表内默认（0 / NaN 都不生效）',
    !computeSelfIntent({ traits: {}, idleMinutes: 3, selfNoteMinMinutes: 0 }) ||
    computeSelfIntent({ traits: {}, idleMinutes: 3, selfNoteMinMinutes: 0 }).kind !== 'wantToLeaveSomething');

  // 引擎级：idleMs 可配，默认不变
  let t = 1000000;
  const tr = new ActivityTracker({ now: () => t });
  const engFast = new TriggerEngine(tr, { now: () => t, idleMs: 3 * 60000, selfNoteIdleMs: 3 * 60000 });
  t += 3 * 60000;
  const o = engFast.evaluate();
  check('🔴 验证模式：3 分钟即可触发自发愿望（铁律结构未改，只调基准）',
    o && o.selfIntent && o.selfIntent.kind === 'wantToLeaveSomething',
    o ? ('kind=' + o.kind + ' self=' + (o.selfIntent && o.selfIntent.kind)) : 'null');

  let t2 = 2000000;
  const tr2 = new ActivityTracker({ now: () => t2 });
  const engDefault = new TriggerEngine(tr2, { now: () => t2 });
  t2 += 3 * 60000;
  check('🔴 默认模式：3 分钟不触发（生产行为未变）', engDefault.evaluate() === null);
}

/* ============ 7. 防漂移：接线仍在 ============ */
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('❌ main.js 建案时传了 selfNote 戳', mainSrc.includes("'selfNote'"));
  check('❌ main.js 建案后自动执行（免卡片）', mainSrc.includes('executeInternal'));
  check('❌ main.js 把配置的阈值传进 TriggerEngine',
    mainSrc.includes('selfNoteIdleMs: cfg.agentSelfNoteIdleMinutes * 60000'));
  // 🔴 D-17 补充（反重力复核指出）：调度必须用**引擎的真实基准**，
  //   不能用模块常量 IDLE_MS —— 否则配置改小完全不起作用（首次轮询仍等 30 分钟）。
  //   这是「配置改了但不生效」这类**静默失败**的典型形态。
  check('🔴 main.js 调度用引擎基准而非模块常量（否则配置改了不生效）',
    mainSrc.includes('function proactiveBaseMs()') &&
    mainSrc.includes('? trigger.idleMs : IDLE_MS') &&
    !mainSrc.includes('scheduleProactiveCheck(IDLE_MS)'));

  // 🔴 行为断言（字符串断言抓不住这个变异体 —— 实测踩过）：
  //   变异体把守卫换成 `true` 后语法仍合法、字符串仍在，只有行为变了。
  //   所以这里**真的抽出函数并跑一遍**，用「trigger 未就绪 / idleMs 非法」两种输入验证回落。
  //
  //   ⚠️ 抽取方式：**用 Function 原型直接求值**，不自己写正则截取函数体。
  //     实测踩过：正则 `\{[\s\S]*?\n\}` 会漏掉行尾的 `}`，
  //     构造出的函数体少一个闭括号 ⇒ `make(...) is not a function`。
  //     那类失败看起来像「实现坏了」，实际是 harness 坏了。
  {
    let fallbackOk = false;
    try {
      const IDLE = 30 * 60000;
      // 把整段函数定义交给 Function 求值，拿到真函数（不截取、不替换）。
      const fnDef = mainSrc.slice(
        mainSrc.indexOf('function proactiveBaseMs()'),
        mainSrc.indexOf('function checkAndPushProactive()')
      );
      const factory = new Function('trigger', 'IDLE_MS', fnDef + '; return proactiveBaseMs;');
      const f1 = factory(null, IDLE);
      const f2 = factory({ idleMs: NaN }, IDLE);
      const f3 = factory({ idleMs: 0 }, IDLE);
      const f4 = factory({ idleMs: -1 }, IDLE);
      const f5 = factory({ idleMs: 3 * 60000 }, IDLE);
      fallbackOk = f1() === IDLE && f2() === IDLE && f3() === IDLE && f4() === IDLE
        && f5() === 3 * 60000;
    } catch (e) {
      fallbackOk = false;
    }
    check('🔴 行为：trigger 未就绪 / idleMs 非法时回落常量（防 NaN 延迟）',
      fallbackOk);
  }

  const execSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-executor.js'), 'utf8');
  check('❌ 免确认判定在执行器内（不在通道层另开旁路）',
    execSrc.includes("proposal.proposalSource === 'selfNote'"));
  check('❌ 免确认只跳过闸门 4，前置闸门顺序未变',
    execSrc.indexOf('PROCESS_EXECUTE_FORBIDDEN') < execSrc.indexOf("proposal.proposalSource === 'selfNote'"));
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
