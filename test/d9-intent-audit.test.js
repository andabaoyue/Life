/**
 * test/d9-intent-audit.test.js — D-9「动机来源进审计」门禁
 *
 * ## 本轮要解决的问题（用户原话）
 *   「第一次主动动手，我希望是因为她……若是有一天她主动动手的动机变成她自己了，
 *    我们就成功了。」
 * 现状：她每次动手的动机**完全不可查**。执行审计只有
 *   { outcome, code, capability, proposalId }，
 *   翻 agent-audit.jsonl 只知道「她写了 note.md」，答不上「因为她想写，还是因为你说了」。
 *
 * ## 立规（本仓纪律）
 *   门禁必须含反例；反例本身必须做变异测试（删掉守卫必须 FAIL）。
 *
 * ## 反例清单（三类）
 *   恶意变体：D9-R1渲染端伪造动机（raw.intentSources 被采纳 ⇒ 一票否决项）
 *             D9-R2 渲染端伪造 intentOrigin（声称是自我动机）
 *             D9-R3 上游传垃圾形态动机（数组/字符串/null/带 origin 字段）
 *             D9-R4未登记的来源前缀（不能靠前缀泛化自动放行）
 *             D9-R5 traits 与 tracker 混合（有歧义必须拒绝分类）
 *   漏传参数：D9-R6 不注入求值器（provider为 null）
 *             D9-R7 不传第二参数（createActionProposal(input) 单参调用）
 *             D9-R8 求值器抛异常（不能连带把建案搞崩）
 *   边界值：  D9-R9 非数组 sources / 超长来源串截断 / 来源项数上界
 *             D9-R10 提案不存在（PROPOSAL_NOT_FOUND ⇒ 动机必须 null 而非编一个）
 *
 * ## 🔴 本门禁最关键的一条（D9-R1）
 *   动机**绝不能从渲染端 payload 进**。若它能被伪造，那「动机是否在迁移」
 *   这个验收标准就永远无法达成——审计里的 self_trait 可能全是渲染端写的。
 *   所以 D9-R1 不是普通反例，它是本轮成立与否的分界线。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createActionProposal, classifyIntentOrigin, normalizeIntentMotive,
  INTENT_ORIGIN_BY_SOURCE_PREFIX, INTENT_ORIGINS,
} = require('../src/agent-interfaces');
const { ControlledAgentExecutor } = require('../src/agent-executor');
const { registerAgentIpc, AGENT_CHANNELS } = require('../src/agent-ipc');
const { createIpcGuard } = require('../src/ipc-guard');
const { WriteTransactionManager } = require('../src/agent-transaction');

// 临时目录清理：包住 mkdtempSync 本身，新增调用点自动被覆盖。
const _d9Dirs = [];
const _d9OrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d9OrigMkdtemp.apply(fs, a);
  _d9Dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d9Dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d9OrigMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/**
 * 装一套完整 Agent 环境，返回能走 propose → confirm → execute 的句柄。
 * motive 是「主进程侧动机求值器」的返回值（null 表示取不到动机）。
 *
 * 🔴 用**真实的 createIpcGuard**（与 agent_ipc.test.js 同一手法），不自己造桩。
 *   踩过的坑：先前自造 `handle()` 桩少了 `assertTrustedRenderer`，
 *   结果每个通道都被判UNTRUSTED_RENDERER —— 报的是「替身不忠实」的错，
 *   不是被测对象的错。sender/senderFrame/URL 校验必须走真代码路径。
 */
function env(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-'));
  const sandbox = path.join(root, 'sandbox');
  fs.mkdirSync(sandbox);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd9data-'));

  const {
    CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
  } = require('../src/agent-interfaces');
  const { UserConfirmationGate } = require('../src/agent-confirmation');

  const registry = new CapabilityRegistry();
  const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read', 'workspace.write'] });
  policy.setScopeRoots('workspace.read', [sandbox]);
  policy.setScopeRoots('workspace.write', [sandbox]);
  const budget = new ExecutionBudget({});
  const auditLog = new AuditLog({ dir: dataDir });
  const confirmation = new UserConfirmationGate();
  const proposalStore = new Map();

  const handlers = new Map();
  const localUrl = 'file:///' + root.replace(/\\/g, '/') + '/index.html';
  const mainFrame = { url: localUrl };
  const webContents = { mainFrame, on() {}, setWindowOpenHandler() {} };
  const guard = createIpcGuard({
    ipcMain: {
      handle: (ch, fn) => { handlers.set(ch, fn); },
      on() {},
    },
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    appDir: root,
    getTrustedWebContents: () => [],
  });
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };

  const provider = Object.prototype.hasOwnProperty.call(opts, 'provider')
    ? opts.provider
    : () => ({ sources: ['traits.attachment_need'], kind: 'attachment_high' });

  registerAgentIpc(guard, { registry, policy, budget, auditLog, confirmation }, {
    proposalStore,
    transactionManager: new WriteTransactionManager({ dir: dataDir }),
    ...(provider === undefined ? {} : { intentMotiveProvider: provider }),
  });

  const execEvents = () => auditLog.list().filter((e) => e.channel === 'agent:execute');
  const proposeEvents = () => auditLog.list().filter((e) => e.channel === 'agent:propose-action');

  /** 走 propose 通道建案（raw 完全由「渲染端」视角构造）。 */
  function propose(raw) {
    const fn = handlers.get('agent:propose-action');
    if (!fn) throw new Error('通道未注册');
    const enriched = (raw && raw.capability === 'workspace.write' && raw.content === undefined)
      ? { content: 'd9测试写入正文', ...raw }
      : raw;
    return fn(trustedEvent, enriched);
  }

  function call(channel, arg) {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return fn(trustedEvent, arg);
  }

  /** 建案 → 确认 → 执行，返回执行信封。 */
  function proposeConfirmExecute(raw, content) {
    const enriched = (raw && raw.capability === 'workspace.write')
      ? { content: content || 'd9测试写入正文', ...raw }
      : raw;
    const r = propose(enriched);
    if (!r.ok) return { proposeRes: r, execRes: null };
    const id = r.proposal.id;
    call('agent:confirm-action', { proposalId: id, decision: 'approved' });
    const execRes = call('agent:execute', { proposalId: id });
    return { proposeRes: r, execRes };
  }

  return {
    root, sandbox, dataDir, policy, budget, auditLog, confirmation,
    proposalStore, guard, propose, call, proposeConfirmExecute,
    execEvents, proposeEvents,
  };
}

console.log('── D-9 动机来源进审计 ──\n');

/* ═══════════════ 一、分类判据本身（纯函数层） ═══════════════ */

// 正例：两类来源必须能分开——这是本轮唯一的目的。
check('D9-01 traits.* 归类为 self_trait（她自己的特质）',
  classifyIntentOrigin(['traits.attachment_need']) === 'self_trait');
check('D9-02 tracker.* 归类为 user_action（来自用户行为）',
  classifyIntentOrigin(['tracker.lastInteractionAt']) === 'user_action');
check('D9-03 两类必须不同（若相同则本轮目的落空）',
  classifyIntentOrigin(['traits.vitality']) !== classifyIntentOrigin(['tracker.lastInteractionAt']));

// D9-R4 恶意变体：未登记的前缀必须拒绝分类。
check('D9-R4a 未登记前缀 weather.pressure 判为 null（不做前缀泛化）',
  classifyIntentOrigin(['weather.pressure']) === null);
check('D9-R4b 未登记前缀即便形状很像也不放行',
  classifyIntentOrigin(['traitsy.attachment_need']) === null,
  'traitsy ≠ traits');
check('D9-R4c 只有精确登记的两类前缀可用',
  Object.keys(INTENT_ORIGIN_BY_SOURCE_PREFIX).length === 2
  && INTENT_ORIGIN_BY_SOURCE_PREFIX.traits === 'self_trait'
  && INTENT_ORIGIN_BY_SOURCE_PREFIX.tracker === 'user_action');
check('D9-R4d INTENT_ORIGINS 不含 unknown（不知道就说不知道）',
  !INTENT_ORIGINS.includes('unknown') && !INTENT_ORIGINS.includes('any'));

// D9-R5 恶意变体：混合来源有歧义。
check('D9-R5 traits 与 tracker 混合判为 null（有歧义不选边）',
  classifyIntentOrigin(['traits.vitality', 'tracker.lastInteractionAt']) === null);
check('D9-R5b 同前缀重复不构成歧义（仍是 self_trait）',
  classifyIntentOrigin(['traits.vitality', 'traits.attachment_need']) === 'self_trait');

// D9-R9 边界值：非数组与空数组。
check('D9-R9a 非数组（字符串）判为 null',
  classifyIntentOrigin('traits.attachment_need') === null);
check('D9-R9b 非数组（对象）判为 null',
  classifyIntentOrigin({ 0: 'traits.vitality' }) === null);
check('D9-R9c 空数组判为 null',
  classifyIntentOrigin([]) === null);
check('D9-R9d null / undefined 判为 null',
  classifyIntentOrigin(null) === null && classifyIntentOrigin(undefined) === null);
check('D9-R9e 空字符串来源判为 null',
  classifyIntentOrigin(['']) === null);
check('D9-R9f 非字符串项判为 null（不 String() 兜底）',
  classifyIntentOrigin([123]) === null);
// 🔴 D9-R9f2：变异测试实测的第二个覆盖缺失。
//   变异体M15「非字符串项用 String() 兜底」当时全绿，查明原因同样是**巧合**：
//   String(123)='123'、String(null)='null' 都不在白名单表里 ⇒ 恰好还是 null。
//   但若表里将来登记了某个纯数字前缀，兜底就会放行。所以把判据钉在归一化层。
check('D9-R9f2 非字符串项在归一化层就被剔掉（不靠下游表兜底）',
  (() => {
    const m = normalizeIntentMotive({ sources: [123, null, undefined, 'traits.vitality'] });
    return m.intentSources.length === 1 && m.intentSources[0] === 'traits.vitality';
  })(), '非字符串项必须被剔除而不是被转成字符串');
check('D9-R9f3 全是非字符串项 ⇒ sources 为 null（不是空数组）',
  normalizeIntentMotive({ sources: [123, null] }).intentSources === null);
// 无点号的字符串：split('.')[0] 得到整串，表里查不到⇒ null。
check('D9-R9g 带点与不带点都要走同一张表（无点串按整串查表）',
  // 'traits' 整串恰好在表里 ⇒ 判为 self_trait。这不是漏洞：
  // 表里登记的是前缀 key，查表方式统一；真正的防线是「表里没有的一律 null」。
  classifyIntentOrigin(['traits']) === 'self_trait'
  && classifyIntentOrigin(['tracker']) === 'user_action'
  && classifyIntentOrigin(['nonexistent']) === null);

/* ═══════════════ 二、归一化的截断与形状 ═══════════════ */

check('D9-10 normalize 对 null 返回三字段全 null',
  (() => { const m = normalizeIntentMotive(null);
    return m.intentSources === null && m.intentKind === null && m.intentOrigin === null; })());
check('D9-11 normalize 的三字段恒存在（形状恒定才能 grep）',
  Object.keys(normalizeIntentMotive({ sources: ['traits.vitality'] })).sort().join(',')
  === 'intentKind,intentOrigin,intentSources');
check('D9-R3a normalize 对数组输入返回全 null（不遍历数组取字段）',
  (() => { const m = normalizeIntentMotive(['traits.vitality']);
    return m.intentSources === null; })());
check('D9-R9h 超长来源串被截断到80 字符',
  normalizeIntentMotive({ sources: ['traits.' + 'x'.repeat(500)] }).intentSources[0].length === 80);
check('D9-R9i 来源项数上界为 8（防日志膨胀）',
  normalizeIntentMotive({ sources: Array.from({ length: 50 }, (_, i) => 'traits.t' + i) }).intentSources.length === 8);
check('D9-R9j 超长 kind 截断到 64',
  normalizeIntentMotive({ sources: ['traits.vitality'], kind: 'k'.repeat(200) }).intentKind.length === 64);
check('D9-R9k 非字符串 kind 归null',
  normalizeIntentMotive({ sources: ['traits.vitality'], kind: 123 }).intentKind === null);

// 🔴 关键：origin 一律由 sources 重算，不信调用方给的。
check('D9-12 上游给的 intentOrigin 被无视（按 sources 重算）',
  normalizeIntentMotive({ sources: ['tracker.lastInteractionAt'], intentOrigin: 'self_trait' }).intentOrigin
  === 'user_action');
check('D9-12b 上游硬说 self_trait 但来源是 tracker⇒ 记 user_action',
  normalizeIntentMotive({ sources: ['tracker.lastInteractionAt'], origin: 'self_trait', intentOrigin: 'self_trait' })
    .intentOrigin === 'user_action');

/* ═══════════════ 三、建案层：渲染端伪造动机（一票否决项） ═══════════════ */

// 🔴🔴 D9-R1：本轮成立与否的分界线。
//
// 🔴 写这条时踩过的坑，值得留档：**第一版让 provider 默认就返回
//   ['traits.attachment_need']，而伪造值恰好也是它** ⇒ 断言
//   `proposal.intentSources === null` 会FAIL，但把守卫整个删掉它**照样 PASS**
//   （因为 provider 真的返回了那个值）—— 那是**假反例**。
//   反例的判据必须与正例的取值**不同源**，否则测的是巧合不是守卫。
//   所以这里显式把 provider 设成 null：这样「拿到动机」的唯一途径就是伪造。
{
  const e = env({ provider: () => null });
  const r = e.propose({
    capability: 'workspace.write',
    scope: path.join(e.sandbox, 'note.md'),
    // 渲染端自称这是「她想做的」——必须被彻底无视
    intentSources: ['traits.attachment_need'],
    intentKind: 'attachment_high',
    intentOrigin: 'self_trait',
  });
  check('D9-R1a 渲染端伪造的 intentSources 不被采纳（provider 已置 null，唯一途径就是伪造）',
    r.ok && r.proposal.intentSources === null,
    '实际=' + JSON.stringify(r.proposal && r.proposal.intentSources));
  check('D9-R1b 渲染端伪造的 intentKind 不被采纳', r.ok && r.proposal.intentKind === null);
  check('D9-R1c 渲染端伪造的 intentOrigin 不被采纳', r.ok && r.proposal.intentOrigin === null);
  check('D9-R1d 伪造不能影响建案本身（该建仍建得出来）', r.ok === true);
  // 反向对照：provider 真的给值时字段才有值 ⇒ 证明上面不是「恒为 null 的死字段」
  const e2 = env();
  const r2 = e2.propose({ capability: 'workspace.write', scope: path.join(e2.sandbox, 'n.md') });
  check('D9-R1e 反向对照：provider 给值时字段确有值（防上一条是恒假断言）',
    r2.proposal.intentSources !== null && r2.proposal.intentOrigin === 'self_trait');
}

// 🔴🔴 D9-R1f：**这一条才是真正抓住 M2 的断言**（前两次都打错位置，记档）。
//
//   变异体M2「createActionProposal 第二参数改成 `intentMotive || input`」
//   连续两轮门禁**全绿**。两次误判的原因各不相同，都值得留档：
//     第一轮我以为「R1a 已经覆盖了」→ 但 R1a 断言的是 raw 的伪造值没被采纳，
//       而 M2 回落读的是 `input.sources`（不存在的键）⇒ 结果**恰好**也是 null。
//     第二轮我补了「键名不同」的断言 ⇒ 仍打错位置：那条测的是
//       normalizeIntentMotive 读的键名，**测不到 createActionProposal 的参数来源**。
//
//   ⇒ 教训：**断言必须精确指向守卫本身的判据**。
//     这里真正的不变式是「createActionProposal 的动机只来自第2 参数，
//     与 input 完全无关」，所以断言必须构造一个「input 里有合法 sources 键」的输入 ——
//     只有这样，M2 那条回落路径才真的会被走到。
check('D9-R1f createActionProposal 的动机与 input 完全无关（input 带合法 sources 键也不被采纳）',
  (() => {
    const p = createActionProposal(
      // 🔴 关键：这里故意让 input 带上**归一化真正认识的键名** sources/kind，
      //    这样「回落读 input」的变异体一定会被走到。
      { capability: 'workspace.read', scope: 'x', sources: ['traits.vitality'], kind: 'vitality_high' },
      null);
    return p.intentSources === null && p.intentKind === null;
  })(), '若这条变红，说明动机开始从 raw 读了');
check('D9-R1g 同上，但第二参数有值⇒ 必须取第二参数（证明不是恒null）',
  (() => {
    const p = createActionProposal(
      { capability: 'workspace.read', scope: 'x', sources: ['tracker.lastInteractionAt'], kind: 'idleness_deep' },
      { sources: ['traits.attachment_need'], kind: 'attachment_high' });
    return p.intentSources[0] === 'traits.attachment_need' && p.intentKind === 'attachment_high';
  })());
// 走真实通道的版本：raw 用**归一化认识的键名**伪造，这才是真实的攻击形态。
check('D9-R1h 经 propose 通道用 sources/kind 键名伪造也不被采纳',
  (() => {
    const e = env({ provider: () => null });
    const r = e.propose({
      capability: 'workspace.write', scope: path.join(e.sandbox, 'note.md'),
      sources: ['traits.attachment_need'], kind: 'attachment_high',   // ← 不是 intentSources
    });
    return r.ok && r.proposal.intentSources === null && r.proposal.intentKind === null;
  })(), '用正确的键名伪造同样必须被无视');

// D9-R2 恶意变体：只伪造 origin 一个字段（字段少，最容易漏防）。
{
  const e = env({ provider: () => null });
  const r = e.propose({
    capability: 'workspace.write',
    scope: path.join(e.sandbox, 'note.md'),
    intentOrigin: 'self_trait',
  });
  check('D9-R2 只伪造 intentOrigin 也不被采纳', r.ok && r.proposal.intentOrigin === null);
}

// D9-R2b 恶意变体：伪造一个**与真实值不同**的类别（真实是 self_trait，伪造 user_action）。
//   上一条只验「null 时不被采纳」，这条验「有值时也不能被顶替」。
{
  const e = env();
  const r = e.propose({
    capability: 'workspace.write',
    scope: path.join(e.sandbox, 'note.md'),
    intentOrigin: 'user_action',
    intentKind: 'idleness_deep',
  });
  check('D9-R2b 渲染端伪造的类别不能顶替主进程求出的类别',
    r.proposal.intentOrigin === 'self_trait' && r.proposal.intentKind === 'attachment_high',
    '实际=' + r.proposal.intentOrigin + '/' + r.proposal.intentKind);
}

// D9-R7 漏传参数：直接单参调用 createActionProposal。
{
  const p = createActionProposal({ capability: 'workspace.read', scope: 'x' });
  check('D9-R7 createActionProposal 单参调用 ⇒ 三字段为 null 而非 undefined',
    p.intentSources === null && p.intentKind === null && p.intentOrigin === null,
    '实际=' + JSON.stringify([p.intentSources, p.intentKind, p.intentOrigin]));
}

// 提案是冻结的：建案后改不动动机。
{
  const p = createActionProposal({ capability: 'workspace.read', scope: 'x' },
    { sources: ['traits.vitality'], kind: 'vitality_high' });
  check('D9-13 提案冻结后动机改不动（非严格模式赋值静默失败）',
    (() => { p.intentOrigin = 'forged'; return p.intentOrigin === 'self_trait'; })());
  check('D9-13b 提案是 Object.freeze 的', Object.isFrozen(p));
}

/* ═══════════════ 四、执行侧审计：动机真的进了agent:execute ═══════════════ */

{
  const e = env();
  const { execRes, proposeRes } = e.proposeConfirmExecute(
    { capability: 'workspace.write', scope: path.join(e.sandbox, 'note.md') },
    '她想写的东西');
  check('D9-14 执行成功（前置）', execRes && execRes.ok === true, JSON.stringify(execRes));

  const evs = e.execEvents();
  const done = evs.find((x) => x.outcome === 'executed');
  check('D9-15 executed 记录带 intentSources', !!done && Array.isArray(done.intentSources)
    && done.intentSources[0] === 'traits.attachment_need');
  check('D9-16 executed 记录带 intentKind', !!done && done.intentKind === 'attachment_high');
  check('D9-17 executed 记录带 intentOrigin=self_trait', !!done && done.intentOrigin === 'self_trait');
  check('D9-18 动机来源真的落盘到 agent-audit.jsonl',
    fs.readFileSync(path.join(e.dataDir, 'agent-audit.jsonl'), 'utf8').includes('intentSources'));
}

// 建案侧也要带动机（否则被预算/确认拦下的提案永远查不到动机）。
{
  const e = env();
  e.propose({ capability: 'workspace.write', scope: path.join(e.sandbox, 'note.md') });
  const acc = e.proposeEvents().find((x) => x.outcome === 'accepted');
  check('D9-19 propose-action accepted 记录带动机来源', !!acc && acc.intentOrigin === 'self_trait');
  check('D9-19b propose 记录的动机取自冻结提案（不二次求值）',
    !!acc && acc.intentSources && acc.intentSources[0] === 'traits.attachment_need');
}

// 🔴 形状恒定：拿不到动机时字段必须在，只是值为 null。
{
  const e = env({ provider: null });
  const { execRes } = e.proposeConfirmExecute(
    { capability: 'workspace.write', scope: path.join(e.sandbox, 'note.md') }, 'x');
  const done = e.execEvents().find((x) => x.outcome === 'executed');
  check('D9-20 无求值器时执行仍成功', execRes && execRes.ok === true);
  check('D9-20b 三个动机字段仍在但为 null（形状恒定）',
    !!done && 'intentSources' in done && done.intentSources === null
    && 'intentKind' in done && done.intentKind === null
    && 'intentOrigin' in done && done.intentOrigin === null);
}

// D9-R6 漏传参数：求值器返回 null（此刻她没有可追溯的意图）。
{
  const e = env({ provider: () => null });
  const { execRes } = e.proposeConfirmExecute(
    { capability: 'workspace.write', scope: path.join(e.sandbox, 'note.md') }, 'x');
  const done = e.execEvents().find((x) => x.outcome === 'executed');
  check('D9-R6 求值器返回 null ⇒ 如实记 null 而非编一个', execRes.ok && done.intentOrigin === null);
}

// D9-R8 求值器抛异常：不能连带把建案搞崩。
{
  const e = env({ provider: () => { throw new Error('boom'); } });
  const r = e.propose({ capability: 'workspace.write', scope: path.join(e.sandbox, 'note.md') });
  check('D9-R8 求值器抛异常时建案仍成功（动机降级为 null）',
    r.ok === true && r.proposal.intentOrigin === null);
}

// D9-R10 提案不存在：动机必须 null，不能编。
{
  const e = env();
  const r = e.call('agent:execute', { proposalId: 'p-does-not-exist-xyz', content: 'x' });
  const done = e.execEvents().find((x) => x.code === 'PROPOSAL_NOT_FOUND');
  check('D9-R10 提案不存在时执行被拒', r.ok === false && r.error === 'PROPOSAL_NOT_FOUND');
  check('D9-R10b 该记录带动机字段且为 null（不许编来源）',
    !!done && 'intentSources' in done && done.intentSources === null && done.intentOrigin === null);
}

// 🔴 每一条执行审计记录都必须带动机字段 —— 不许有「有的有、有的没有」。
{
  const e = env();
  // 触发多种结局：成功 / 未确认就执行 / 预算熔断 / 提案不存在
  e.proposeConfirmExecute({ capability: 'workspace.write', scope: path.join(e.sandbox, 'a.md') }, 'a');
  const p2 = e.propose({ capability: 'workspace.write', scope: path.join(e.sandbox, 'b.md') });
  e.call('agent:execute', { proposalId: p2.proposal.id, content: 'b' }); // 未确认
  e.call('agent:execute', { proposalId: 'p-nope', content: 'c' });
  const evs = e.execEvents();
  check('D9-21 三条执行记录都产生了（前置）', evs.length >= 3, '实际=' + evs.length);
  const missing = evs.filter((x) => !('intentSources' in x) || !('intentKind' in x) || !('intentOrigin' in x));
  check('D9-21b 每条执行记录都带全三个动机字段（分裂即红）', missing.length === 0,
    '缺字段的记录数=' + missing.length + ' codes=' + missing.map((x) => x.code).join(','));
}

// 拒绝路径也要带动机（rejected 同样要能查「她为什么想做」）。
{
  const e = env();
  const p = createActionProposal({ capability: 'workspace.write', scope: path.join(e.sandbox, 'x.md') },
    { sources: ['traits.attachment_need'], kind: 'attachment_high' });
  e.proposalStore.set(p.id, p);
  // 不确认就执行⇒ EXECUTION_NOT_ALLOWED
  const r = e.call('agent:execute', { proposalId: p.id, content: 'x' });
  const done = e.execEvents().find((x) => x.code === 'EXECUTION_NOT_ALLOWED');
  check('D9-22 未确认被拒时仍带动机（拒绝也须可查）',
    r.ok === false && !!done && done.intentOrigin === 'self_trait');
}

// 重放被拒时动机仍可查（提案对象还在注册表里）。
{
  const e = env();
  const { execRes } = e.proposeConfirmExecute(
    { capability: 'workspace.write', scope: path.join(e.sandbox, 'r.md') }, 'r');
  const id = execRes.proposalId;
  const again = e.call('agent:execute', { proposalId: id, content: 'r' });
  const done = e.execEvents().find((x) => x.code === 'ALREADY_EXECUTED');
  check('D9-23 重放被拒', again.ok === false && again.error === 'ALREADY_EXECUTED');
  check('D9-23b 重放记录仍带动机（提案还在表里，可查）',
    !!done && done.intentOrigin === 'self_trait');
}

/* ═══════════════ 五、动机冻结：建案那一刻的意图，不是执行那一刻 ═══════════════ */

{
  // 这是本轮**唯一的设计题**的判据：动机必须在建案瞬间冻结。
  // 若改成「执行期再求值」，用户在确认框前犹豫期间意图变了，
  // 审计会记下一个合法但答非所问的动机，且不报错。
  let current = { sources: ['traits.attachment_need'], kind: 'attachment_high' };
  let motiveEvals = 0;
  const e = env({ provider: () => { motiveEvals++; return current; } });

  const r = e.propose({ capability: 'workspace.write', scope: path.join(e.sandbox, 'f.md') });
  // 用户犹豫期间，她的状态变了
  current = { sources: ['tracker.lastInteractionAt'], kind: 'idleness_deep' };
  e.call('agent:confirm-action', { proposalId: r.proposal.id, decision: 'approved' });
  e.call('agent:execute', { proposalId: r.proposal.id, content: 'f' });

  const done = e.execEvents().find((x) => x.outcome === 'executed');
  check('D9-24 动机在建案瞬间求值且只求一次', motiveEvals === 1, '实际求值 ' + motiveEvals + ' 次');
  check('D9-24b 执行期不再求值（审计记的是建案那一刻的动机）',
    !!done && done.intentOrigin === 'self_trait', '实际=' + (done && done.intentOrigin));
}

/* ═══════════════ 六、main.js 接线形状 ═══════════════ */

{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('D9-25 main.js 注入了 intentMotiveProvider', /intentMotiveProvider\s*:/.test(src));
  check('D9-25b main.js 的求值器读的是 trigger.selfIntent（不是 _pendingAgentIntent）',
    /intentMotiveProvider[\s\S]{0,600}trigger\s*&&\s*trigger\.selfIntent/.test(src));
  // 🔴 本轮明确不接线_pendingingAgentIntent。
  check('D9-26 main.js 未接线 _pendingAgentIntent（本轮不做）',
    !/intentMotiveProvider[\s\S]{0,600}_pendingAgentIntent/.test(src));
  // 安全边界：main.js 注册 Agent 通道仍必须经 ipcGuard。
  check('D9-27 main.js 注册 Agent 通道仍经 ipcGuard（不得裸 ipcMain）',
    /registerAgentIpc\(ipcGuard,/.test(src) && !/ipcMain\.handle\(\s*['"]agent:/.test(src));
  // 本轮不得打开总开关。
  check('D9-28 agentTriggerEnabled 仍为默认关（本轮不开）',
    /agentTriggerEnabled\s*[:=]\s*false/.test(src) || !/agentTriggerEnabled\s*[:=]\s*true/.test(src));
}

console.log('\n' + (failures === 0 ? '全部通过' : ('失败 ' + failures + ' 项')));
process.exit(failures === 0 ? 0 : 1);
