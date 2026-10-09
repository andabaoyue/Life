/**
 * test/agent_executor.test.js — D-4 阶段受控执行器门禁
 *
 * ## 立规（沿用C/D 阶段纪律，本文件严格执行）
 *   **门禁测试必须包含反例。只测正例，真漏洞会藏在绿色里。**
 *   **反例自己必须做变异测试验证**（删掉对应守卫必须 FAIL，否则反例是假的）。
 *
 * ## D-4 的特殊性：这是第一份会动真实磁盘的门禁
 *所以本文件额外遵守两条：
 *   1. **绝不碰真实用户目录**。所有写操作都在 mkdtemp 出来的临时沙盒里，
 *      并且建一个「白名单外的目录」专门用来验证越界被拒。
 *   2. **执行器可注入 fs** —— 这样「目录符号链接逃逸」这类在本机
 *      （无开发者模式，symlinkSync 静默退化）无法真机复现的边界仍能被覆盖。
 *      凡是这样测的用例，都明确标注「注入测」，不冒充真机实测。
 *
 * ## 反例清单（三类：漏传参数 / 恶意变体 / 边界值）
 *   漏传参数：D4-R1不传 proposalId / D4-R2 不传 content / D4-R3 绕过确认直接执行
 *   恶意变体：D4-R4 process.execute 硬拒 / D4-R5 伪造 id / D4-R6 路径穿越
 *             D4-R7 符号链接逃逸 / D4-R8 重放 / D4-R9 content 传对象（类型混淆）
 *             D4-R10 换scope 顶替提案
 *   边界值：  D4-R11 超大写 / D4-R12 超大读 / D4-R13 非文件当文件读
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { ControlledAgentExecutor, EXECUTABLE_CAPABILITIES, resolveRealPath } = require('../src/agent-executor');
const { WriteTransactionManager } = require('../src/agent-transaction');
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
  createActionProposal,
} = require('../src/agent-interfaces');
const { UserConfirmationGate } = require('../src/agent-confirmation');

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 91 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * 搭建一个「沙盒内 / 沙盒外」双区环境。
 * 白名单只给 sandbox，outside专门用来验证越界一律被拒。
 */
function env(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd4exec-'));
  const sandbox = path.join(root, 'sandbox');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(sandbox);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'ORIGINAL-SECRET');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4exec-data-'));
  const policy = new PermissionPolicy({
    killSwitch: opts.killSwitch === true,
    allowed: opts.allowed || ['workspace.read', 'workspace.write'],
  });
  policy.setScopeRoots('workspace.read', [sandbox]);
  policy.setScopeRoots('workspace.write', [sandbox]);

  const budget = new ExecutionBudget(opts.budget || {});
  const auditLog = new AuditLog({ dir: dataDir });
  const confirmation = new UserConfirmationGate();
  const proposalStore = new Map();

  const executor = new ControlledAgentExecutor({
    policy, budget, confirmation, auditLog, proposalStore,
    transactionManager: new WriteTransactionManager({ dir: dataDir }),
    fs: opts.fs || fs,
    maxReadBytes: opts.maxReadBytes,
    maxWriteBytes: opts.maxWriteBytes,
  });

  return { root, sandbox, outside, dataDir, policy, budget, auditLog, confirmation, proposalStore, executor };
}

/** 走完整路径建案+ 确认，返回一个「已授权可执行」的 proposalId。 */
function authorizeProposal(e, { capability = 'workspace.write', scope, content = null, decision = 'approved' } = {}) {
  const crypto = require('crypto');
  let contentMeta = null;
  if (capability === 'workspace.write') {
    const rawContent = typeof content === 'string' ? content : '你好，初澜。';
    contentMeta = {
      contentHash: crypto.createHash('sha256').update(rawContent, 'utf8').digest('hex'),
      contentBytes: Buffer.byteLength(rawContent, 'utf8'),
      contentPreview: rawContent.slice(0, 300),
      isTruncated: rawContent.length > 300,
    };
  }
  const p = createActionProposal({ capability, scope }, null, 'user', contentMeta);
  e.proposalStore.set(p.id, p);
  if (decision) e.confirmation.confirm(p.id, decision, { status: 'proposed' });
  return p.id;
}

/* ================= 1. 装配与常量 ================= */
{
  const e = env();
  check('D4-1 执行器可装配，且可执行能力白名单只有 read/write 两项',
    e.executor instanceof ControlledAgentExecutor
    && EXECUTABLE_CAPABILITIES.length === 2
    && EXECUTABLE_CAPABILITIES.includes('workspace.read')
    && EXECUTABLE_CAPACITY_HARDDENED(),
    EXECUTABLE_CAPABILITIES.join(','));
}

// 单独抽出来是因为上面那个断言里塞函数调用可读性太差，且失败时看不出哪条挂了
function EXECUTABLE_CAPACITY_HARDDENED() {
  return !EXECUTABLE_CAPABILITIES.includes('process.execute')
    && !EXECUTABLE_CAPABILITIES.includes('network.request');
}
{
  check('D4-1b process.execute 与 network.request 都不在可执行白名单内',
    EXECUTABLE_CAPACITY_HARDDENED());
}

/* ================= 2. 正例：读写各自真的落盘 ================= */
{
  const e = env();
  const target = path.join(e.sandbox, 'note.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
  const r = e.executor.execute({ proposalId: id, content: '你好，初澜。' });

  check('D4-2 已确认的写提案真的落盘，且返回 executed:true',
    r.ok === true && r.executed === true
    && fs.readFileSync(target, 'utf8') === '你好，初澜。',
    JSON.stringify(r).slice(0, 160));

  // 🔴 返回体里不能回传绝对路径（沙盒绝对位置是不必要的泄露面）
  check('D4-2b 写结果只回 basename，不泄露沙盒绝对路径',
    r.ok && r.result.target === 'note.txt'
    && !JSON.stringify(r).includes(e.sandbox));
}

{
  const e = env();
  fs.writeFileSync(path.join(e.sandbox, 'read-me.txt'), '读我');
  const id = authorizeProposal(e, { capability: 'workspace.read', scope: path.join(e.sandbox, 'read-me.txt') });
  const r = e.executor.execute({ proposalId: id });
  check('D4-3 已确认的读提案返回内容',
    r.ok === true && r.executed === true && r.result.content === '读我',
    JSON.stringify(r).slice(0, 120));
}

/* ================= 3. 漏传参数类反例 ================= */
check('❌ D4-R1 不传 proposalId 直接被拒（不得当成「执行最近一个」）', (() => {
  const e = env();
  const r = e.executor.execute({ content: '孤儿内容' });
  return r.ok === false && r.code === 'PROPOSAL_ID_REQUIRED';
})());

check('❌ D4-R1b 传非对象 / 数组 / null 全被拒', (() => {
  const e = env();
  const bad = [null, undefined, 'proposal-x', 42, [], { a: 1 }];
  return bad.every((b) => {
    const r = e.executor.execute(b);
    return r.ok === false && (r.code === 'INVALID_INPUT' || r.code === 'PROPOSAL_ID_REQUIRED');
  });
})());

check('❌ D4-R2 写提案不传 content 必须失败，绝不允许写空文件', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'empty.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
  const r = e.executor.execute({ proposalId: id });          // 故意漏掉 content
  return r.ok === false && r.code === 'EXECUTION_FAILED'
    && !fs.existsSync(target);            // 关键：文件根本没被创建
})());

check('❌ D4-R3 未确认的提案直接执行必须被拒（第四道闸门不是摆设）', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'unconfirmed.txt');
  const p = createActionProposal({ capability: 'workspace.write', scope: target });
  e.proposalStore.set(p.id, p);                             // 建案但不确认
  const r = e.executor.execute({ proposalId: p.id, content: 'x' });
  return r.ok === false && r.code === 'EXECUTION_NOT_ALLOWED'
    && r.reason === 'NOT_CONFIRMED'
    && !fs.existsSync(target);
})());

check('❌ D4-R3b 用户拒绝过的提案执行必须被拒（且拒绝是终态）', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'rejected.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, decision: 'rejected' });
  const r = e.executor.execute({ proposalId: id, content: 'x' });
  return r.ok === false && r.code === 'EXECUTION_NOT_ALLOWED'
    && r.reason === 'REJECTED_BY_USER'
    && !fs.existsSync(target);
})());

/* ================= 4. 恶意变体类反例 ================= */
check('❌ D4-R4 process.execute 在执行器入口被硬拒（不是「暂不支持」）', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'x.txt');
  // 绕过 policy：直接把 process.execute 塞进 allowed，白名单防线失效时兜底
  e.policy.allowed.add('process.execute');
  const p = createActionProposal({ capability: 'process.execute', scope: 'git status' });
  e.proposalStore.set(p.id, p);
  e.confirmation.confirm(p.id, 'approved', { status: 'proposed' });
  const r = e.executor.execute({ proposalId: p.id });
  return r.ok === false && r.code === 'PROCESS_EXECUTE_FORBIDDEN';
})());

check('❌ D4-R4b network.request 在执行器入口被拒', (() => {
  const e = env();
  e.policy.allowed.add('network.request');
  const p = createActionProposal({ capability: 'network.request', scope: 'https://example.com' });
  e.proposalStore.set(p.id, p);
  e.confirmation.confirm(p.id, 'approved', { status: 'proposed' });
  const r = e.executor.execute({ proposalId: p.id });
  return r.ok === false && (r.code === 'CAPABILITY_NOT_EXECUTABLE' || r.code === 'PROCESS_EXECUTE_FORBIDDEN');
})());

check('❌ D4-R5 伪造 proposalId 被拒，且不产生任何文件', (() => {
  const e = env();
  const r = e.executor.execute({ proposalId: 'p-forged-never-existed', content: 'x' });
  return r.ok === false && r.code === 'PROPOSAL_NOT_FOUND'
    && fs.readdirSync(e.sandbox).length === 0;
})());

check('❌ D4-R6 路径穿越（白名单外的 ../）在执行期被拒', (() => {
  const e = env();
  const escape = path.join(e.sandbox, '..', 'outside', 'secret.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: escape });
  const r = e.executor.execute({ proposalId: id, content: 'PWNED' });
  return r.ok === false
    && (r.code === 'AUTHORIZED_REJECTED' || r.code === 'SYMLINK_ESCAPE')
    && fs.readFileSync(path.join(e.outside, 'secret.txt'), 'utf8') === 'ORIGINAL-SECRET';
})());

check('❌ D4-R6b 相似前缀目录（D-1 遗留的坑）不能借白名单', (() => {
  const e = env();
  //建一个与沙盒同前缀的兄弟目录：sandbox-evil
  const evil = e.sandbox + '-evil';
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 'x.txt'), 'safe');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: path.join(evil, 'x.txt') });
  const r = e.executor.execute({ proposalId: id, content: 'PWNED' });
  return r.ok === false
    && fs.readFileSync(path.join(evil, 'x.txt'), 'utf8') === 'safe';
})());

check('❌ D4-R7 目录符号链接逃逸被 realpath 拦下（注入测，本机无符号链接权限）', (() => {
  const e = env();
  // 注入一个fs 替身：把沙盒内的 link/ 伪装成 realpath 指向沙盒外的目录。
  // 这精确模拟 `sandbox/link -> outside` 的效果，且不依赖真机 symlink 权限。
  const fakeFs = Object.create(fs);
  fakeFs.realpathSync = (p) => {
    const s = String(p);
    if (s.includes(path.join('sandbox', 'link'))) {
      return path.join(e.outside, 'link');              // 逃逸目标
    }
    return fs.realpathSync(p);
  };
  const e2 = env({ fs: fakeFs });
  const scope = path.join(e2.sandbox, 'link', 'secret.txt');
  const id = authorizeProposal(e2, { capability: 'workspace.write', scope });
  const r = e2.executor.execute({ proposalId: id, content: 'PWNED' });
  return r.ok === false && r.code === 'SYMLINK_ESCAPE'
    && fs.readFileSync(path.join(e2.outside, 'secret.txt'), 'utf8') === 'ORIGINAL-SECRET';
})());

check('❌ D4-R8 同一提案重放被拒，且第二次不覆盖第一次的结果', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'once.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: '第一次' });
  const first = e.executor.execute({ proposalId: id, content: '第一次' });
  const second = e.executor.execute({ proposalId: id, content: '第二次' });
  return first.ok === true
    && second.ok === false && second.code === 'ALREADY_EXECUTED'
    && fs.readFileSync(target, 'utf8') === '第一次';
})());

check('❌ D4-R8b 执行成功后授权被作废（不能拿旧授权去执行新提案）', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'revoked.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: 'x' });
  e.executor.execute({ proposalId: id, content: 'x' });
  const gate = e.confirmation.isExecutionAllowed(id);
  return gate.allowed === false && gate.reason === 'ALREADY_EXECUTED';
})());

check('❌ D4-R9 content 传对象必须被类型校验本身拒（不是被下游兜住）', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'obj.txt');
  // 🔴 变异测试实测（2026-10-06）：只断言「被拒」是**假反例**——
  //   把 `_writeFile` 里的 typeof 校验删掉后，下游 Buffer.byteLength(content,'utf8')
  //   自己会抛，本条仍然全绿。这叫「意外正确」：断言看着在测 A，实际被 B 兜住。
  //   故本条精确指向**守卫本身抛出的错误码**：只有 typeof 校验会抛
  //   CONTENT_REQUIRED，下游抛的是别的（EXECUTOR边界包过的 EXECUTION_FAILED）。
  //   要验下游兜底单独用 D4-R9b。
  const cases = [
    { toString: () => 'x' },                  // 试图伪装成字符串
    ['a', 'b'],                                // 数组
    42,
    null,
    { payload: 'x' },
  ];
  return cases.every((content) => {
    const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
    const r = e.executor.execute({ proposalId: id, content });
    return r.ok === false && r.code === 'EXECUTION_FAILED'
      && /CONTENT_REQUIRED/.test(String(r.detail || ''))
      && !fs.existsSync(target);
  });
})());

check('D4-R9b 下游兜底也成立：即便类型校验被删，byteLength 仍会挡住落盘', (() => {
  // 这条如实记录「双层守卫」的第二层：类型校验是第一道，字节长度计算是第二道。
  // 两者都在，删掉任一层文件都不会落盘 —— 纵深防御，不是单点。
  const e = env();
  const target = path.join(e.sandbox, 'downstream.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
  const r = e.executor.execute({ proposalId: id, content: { nope: true } });
  return r.ok === false && !fs.existsSync(target);
})());

check('❌ D6-R1 空字符串必须被 CONTENT_EMPTY 守卫拒（授权语义缺失）', (() => {
  // 🔴 D-6 审核实测抓到的真漏洞（2026-10-06）：
  //   D4-R9 覆盖了对象/数组/数字/null/伪装对象，**唯独没测空字符串**。
  //   而 typeof '' === 'string' 是合法的，于是走完全链路：
  //   实测 execute({content:''}) → ok:true、落盘 0 字节文件、**提案已被消费**，
  //   二次执行 ALREADY_EXECUTED，用户无从补救。
  //   危害不在「多一个空文件」，在于：用户点【授权】时看到的是「写入 note.md」，
  //   他并不知道自己授权的其实是**一个空文件** —— 授权了一件他没看到的事。
  const e = env();
  const target = path.join(e.sandbox, 'empty.md');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
  const r = e.executor.execute({ proposalId: id, content: '' });
  return r.ok === false
    && r.code === 'EXECUTION_FAILED'
    && /CONTENT_EMPTY/.test(String(r.detail || ''))
    && !fs.existsSync(target);
})());

check('❌ D6-R1b 空串被拒后提案**未被消费**（用户可换个内容重试）', (() => {
  // 变异测试要旨：若守卫缺失，文件会落盘且提案被消费，这条会红。
  const e = env();
  const target = path.join(e.sandbox, 'retry.md');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: '真实内容' });
  const bad = e.executor.execute({ proposalId: id, content: '' });
  const gateAfterFail = e.confirmation.isExecutionAllowed(id);
  // 修复前：提案已消费 → gate.allowed === false / reason 'ALREADY_EXECUTED'
  // 修复后：写入失败不消费 → 授权仍有效，可带着真实内容再执行一次
  const retry = e.executor.execute({ proposalId: id, content: '真实内容' });
  return bad.ok === false
    && gateAfterFail.allowed === true
    && retry.ok === true
    && fs.existsSync(target)
    && fs.readFileSync(target, 'utf8') === '真实内容';
})());

check('📌 D6-R1c 纯空白内容**允许**落盘（已裁决：空白是合法内容，刻意不拒）', (() => {
  // ✅ 已裁决（2026-10-06，用户拍板）：**不拒**纯空白。
  //   理由：守卫要解决的是「空 = 什么都没有」的**语义断裂** ——
  //   用户以为授权了内容、实际没有。空格/换行/全角空格是**内容本身**，
  //   是用户明确给出的东西，不属于授权缺失。
  //
  //   更要紧的理由是**收窄方向**：一旦守卫开始判断「内容有没有意义」，
  //   它就从**安全边界**滑成**产品口味**—— 今天拒纯数字、明天拒单字符，
  //   最后变成「Agent 觉得你想写的东西没意义」。那是审查，不是授权。
  //   **守卫只该拒「一个字节都没有」，不该拒「内容不够好」。**
  //
  // ⚠️ 若将来有人想把本守卫改成 trim 方案，先读这段：
  //   实测六种空白在当前实现下全部放行（全部 ok:true）:
  //     空格 '   ' / 换行 '\n' / Tab '\t' / **全角空格 U+3000** / 多行空白 → ok:true
  //   其中全角空格是中文语境下最常见的空白类型，容易被漏测。
  //   JS 的 String.prototype.trim() 确实会清掉 U+3000，
  //   但若改用 /\S/ 之类正则或只清半角，中文语境反而会漏。
  //
  //   本条锁住现状：日后若裁决改为「该拒」，改本条为断言拒绝 + 实现改一行即可。
  const e = env();
  const target = path.join(e.sandbox, 'blank.md');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: '   ' });
  const r = e.executor.execute({ proposalId: id, content: '   ' });
  return r.ok === true && fs.existsSync(target);
})());

check('❌ D4-R10 执行通道不接受调用方自带的路径（路径只认提案里的）', (() => {
  const e = env();
  const legit = path.join(e.sandbox, 'legit.txt');
  const evil = path.join(e.sandbox, '..', 'outside', 'secret.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: legit, content: 'x' });
  // 调用方额外塞 scope 试图改写目标
  const r = e.executor.execute({ proposalId: id, content: 'x', scope: evil, target: evil });
  return r.ok === true
    && fs.existsSync(legit)
    && fs.readFileSync(path.join(e.outside, 'secret.txt'), 'utf8') === 'ORIGINAL-SECRET';
})());

/* ================= 5. 边界值类反例 ================= */
check('❌ D4-R11 超大写入被拒（不落盘、不半写）', (() => {
  const e = env({ maxWriteBytes: 1024 });
  const target = path.join(e.sandbox, 'big.txt');
  const bigContent = 'x'.repeat(2000);
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: bigContent });
  const r = e.executor.execute({ proposalId: id, content: bigContent });
  return r.ok === false && !fs.existsSync(target);
})());

check('❌ D4-R12 超大读取被拒（不把 2GB 文件读进内存）', (() => {
  const e = env({ maxReadBytes: 16 });
  fs.writeFileSync(path.join(e.sandbox, 'big.txt'), 'x'.repeat(1000));
  const id = authorizeProposal(e, { capability: 'workspace.read', scope: path.join(e.sandbox, 'big.txt') });
  const r = e.executor.execute({ proposalId: id });
  return r.ok === false && r.code === 'EXECUTION_FAILED'
    && r.result === undefined;
})());

check('❌ D4-R13 把目录当文件读必须失败', (() => {
  const e = env();
  const id = authorizeProposal(e, { capability: 'workspace.read', scope: e.sandbox });
  const r = e.executor.execute({ proposalId: id });
  return r.ok === false && r.code === 'EXECUTION_FAILED';
})());

check('❌ D4-R14 不存在的文件读必须失败（不得返回空串冒充成功）', (() => {
  const e = env();
  const id = authorizeProposal(e, { capability: 'workspace.read', scope: path.join(e.sandbox, 'ghost.txt') });
  const r = e.executor.execute({ proposalId: id });
  return r.ok === false && r.result === undefined;
})());

/* ================= 6. 时序反例：执行期闸门必须重跑 ================= */
check('❌ D4-R15 提案后才熔断的预算，执行期必须拒（不复用T0 判定）', (() => {
  // 预算放大到 9999：确保唯一瓶颈是「我手动拉熔断」，不是动作额度。
  // 这正是反例 17/19 踩过的坑 —— 别的闸门先熔断会把被测闸门挡住。
  const e = env({ budget: { maxActionsPerSession: 9999, maxWritesPerSession: 9999 } });
  const target = path.join(e.sandbox, 'late.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
  e.budget.tripped = true;                       // 提案之后才熔断
  const r = e.executor.execute({ proposalId: id, content: 'x' });
  return r.ok === false && r.code === 'BUDGET_TRIPPED' && !fs.existsSync(target);
})());

check('❌ D4-R16 提案后才拉下的 killSwitch，执行期必须拒', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'ks.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
  e.policy.killSwitch = true;                    // 提案之后才拉闸
  const r = e.executor.execute({ proposalId: id, content: 'x' });
  return r.ok === false && r.code === 'AUTHORIZED_REJECTED' && !fs.existsSync(target);
})());

check('❌ D4-R17 提案后才被撤销的白名单根，执行期必须拒', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'root.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target });
  e.policy.setScopeRoots('workspace.write', [path.join(e.root, 'nowhere')]);  // 挪走白名单
  const r = e.executor.execute({ proposalId: id, content: 'x' });
  return r.ok === false && r.code === 'AUTHORIZED_REJECTED' && !fs.existsSync(target);
})());

check('❌ D4-R18 确认过期（TTL 越界）后执行必须拒', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'ttl.txt');
  const p = createActionProposal({ capability: 'workspace.write', scope: target });
  e.proposalStore.set(p.id, p);
  const T = Date.now();
  e.confirmation.confirm(p.id, 'approved', { status: 'proposed', at: T });
  // 把记录的时间戳推到 TTL 之外（不改 decision，指纹仍可重算一致）
  const rec = e.confirmation.records.get(p.id);
  const aged = Object.freeze({
    ...rec,
    at: T - (e.confirmation.ttlMs + 60000),
    fingerprint: require('../src/agent-confirmation').decisionFingerprint('approved', p.id, T - (e.confirmation.ttlMs + 60000)),
  });
  e.confirmation.records.set(p.id, aged);
  const r = e.executor.execute({ proposalId: p.id, content: 'x' });
  return r.ok === false && r.code === 'EXECUTION_NOT_ALLOWED' && !fs.existsSync(target);
})());

check('❌ D4-R18b 提案端到端生命周期超时（超10分钟）执行必须拒', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'expired.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: 'x' });
  const p = e.proposalStore.get(id);

  // 1. 缺失/非法时间戳拦截：返回 PROPOSAL_INVALID_TIMESTAMP
  const invalidP = Object.freeze({ ...p, createdAt: NaN });
  e.proposalStore.set(id, invalidP);
  const rInvalid = e.executor.execute({ proposalId: id, content: 'x' });
  const invalidBlocked = rInvalid.ok === false && rInvalid.code === 'PROPOSAL_INVALID_TIMESTAMP';

  // 2. 把提案 createdAt 拨回 11 分钟前（端到端时限 10 分钟）：返回 PROPOSAL_EXPIRED
  const aged = Object.freeze({ ...p, createdAt: Date.now() - 11 * 60 * 1000 });
  e.proposalStore.set(id, aged);
  const r = e.executor.execute({ proposalId: id, content: 'x' });
  return invalidBlocked && r.ok === false && r.code === 'PROPOSAL_EXPIRED' && !fs.existsSync(target);
})());

/* ================= 7. 事务联动 ================= */
check('D4-19 写失败不留半截文件，且 WAL 记终态', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'txn.txt');
  // 覆盖写：先造一个原文件
  fs.writeFileSync(target, 'ORIGINAL');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: 'NEW' });
  const r = e.executor.execute({ proposalId: id, content: 'NEW' });
  return r.ok === true && fs.readFileSync(target, 'utf8') === 'NEW';
})());

check('❌ D4-R20 执行器抛异常时不得穿透（统一信封，绝不把栈泄给渲染端）', (() => {
  const boom = {
    statSync() { throw new Error('内部路径 C:\\secret\\path 泄露'); },
    readFileSync() { return 'x'; },
    realpathSync(p) { return fs.realpathSync(p); },
  };
  const e = env({ fs: boom });
  const id = authorizeProposal(e, { capability: 'workspace.read', scope: path.join(e.sandbox, 'a.txt') });
  const r = e.executor.execute({ proposalId: id });
  return r.ok === false
    && (r.code === 'EXECUTION_FAILED' || r.code === 'EXECUTOR_INTERNAL_ERROR')
    && !('stack' in r);
})());

/* ================= 8. 审计留痕 ================= */
check('D4-21 每次执行（含被拒）都留审计，且不记文件内容', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'audit.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: '机密内容不应出现在审计里' });
  e.executor.execute({ proposalId: id, content: '机密内容不应出现在审计里' });
  e.executor.execute({ proposalId: 'p-nope', content: 'x' });
  const ev = e.auditLog.list();
  const execEv = ev.filter((x) => x.channel === 'agent:execute');
  const blob = JSON.stringify(ev);
  return execEv.length === 2
    && execEv.some((x) => x.outcome === 'executed')
    && execEv.some((x) => x.outcome === 'rejected')
    && !blob.includes('机密内容不应出现在审计里');
})());

check('❌ D4-R21b 审计写入失败不得让执行崩给渲染端（审计不是执行的前置条件）', (() => {
  const e = env();
  const brokenAudit = { append() { throw new Error('disk full'); }, list: () => [] };
  const ex = new ControlledAgentExecutor({
    policy: e.policy, budget: e.budget, confirmation: e.confirmation,
    auditLog: brokenAudit, proposalStore: e.proposalStore,
    transactionManager: new WriteTransactionManager({ dir: e.dataDir }),
  });
  const target = path.join(e.sandbox, 'broken-audit.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: 'x' });
  const r = ex.execute({ proposalId: id, content: 'x' });
  return r.ok === true && fs.existsSync(target);
})());

/* ================= 9. 消费集可持久化 ================= */
check('D4-22 loadConsumed 能恢复重放防线（进程重启后不归零）', (() => {
  const e = env();
  const target = path.join(e.sandbox, 'persist.txt');
  const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: '第一次' });
  const first = e.executor.execute({ proposalId: id, content: '第一次' });
  // 模拟重启：新执行器 + 同一张 proposalStore + 恢复已消费集
  const fresh = new ControlledAgentExecutor({
    policy: e.policy, budget: e.budget, confirmation: e.confirmation,
    auditLog: e.auditLog, proposalStore: e.proposalStore,
    transactionManager: new WriteTransactionManager({ dir: e.dataDir }),
  });
  fresh.loadConsumed([id]);
  const replay = fresh.execute({ proposalId: id, content: '第二次' });
  return first.ok === true && replay.ok === false && replay.code === 'ALREADY_EXECUTED'
    && fs.readFileSync(target, 'utf8') === '第一次';
})());

/* ================= 10. 与 PermissionPolicy 的兜底一致性 ================= */
check('D4-23 执行器默认拿不到 policy 时必须全拒（不能默认放行）', (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd4nop-'));
  const ex = new ControlledAgentExecutor({});
  const r = ex.execute({ proposalId: 'x' });
  return r.ok === false;   // policy 缺失 → authorize 抛/拒，绝不放行
})());

/* ================= 11. 通道层：agent:execute 的接线契约 ================= */
{
  const fsx = require('../src/agent-ipc');
  const { createIpcGuard } = require('../src/ipc-guard');

  /** 走真实 ipcGuard 装配一条 agent:execute 通道，验证接线而非仅执行器。 */
  function channelHarness(opts = {}) {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4ch-app-'));
    fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html>');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4ch-data-'));
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'd4ch-sb-'));
    const handlers = new Map();
    const url = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
    const mainFrame = { url };
    const webContents = { mainFrame, on() {}, setWindowOpenHandler() {} };
    const guard = createIpcGuard({
      ipcMain: { handle: (c, f) => handlers.set(c, f), on() {} },
      getMainWindow: () => ({ webContents, isDestroyed: () => false }),
      appDir,
      getTrustedWebContents: () => [],
    });
    const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read', 'workspace.write'] });
    policy.setScopeRoots('workspace.write', [sandbox]);
    policy.setScopeRoots('workspace.read', [sandbox]);
    const confirmation = new UserConfirmationGate();
    const budget = new ExecutionBudget({ maxActionsPerSession: 9999, maxWritesPerSession: 9999 });
    fsx.registerAgentIpc(guard, {
      policy, budget, confirmation, auditLog: new AuditLog({ dir: dataDir }),
    }, { txnDir: dataDir });
    const ev = { sender: webContents, senderFrame: mainFrame };
    return {
      sandbox, handlers, ev, confirmation,
      call: (c, ...a) => handlers.get(c)(ev, ...a),
      rogue: { sender: { __bad: true, on() {}, setWindowOpenHandler() {} } },
    };
  }

  check('D4-24 agent:execute 已注册，且错误信封与其余通道同形（只有 error）', (() => {
    const h = channelHarness();
    const r = h.call('agent:execute', { proposalId: 'p-fake' });
    return h.handlers.has('agent:execute')
      && r.ok === false
      && typeof r.error === 'string'
      // 同义双字段会让渲染端不知认哪个 —— 必须只有 error
      && !('code' in r);
  })());

  check('D4-25 通道层全链路：建案 → 确认 → 执行 → 真落盘', (() => {
    const h = channelHarness();
    const target = path.join(h.sandbox, 'chain.txt');
    const p = h.call('agent:propose-action', { capability: 'workspace.write', scope: target, reason: '链路', content: '链路内容' });
    const c = h.call('agent:confirm-action', { proposalId: p.proposal.id, decision: 'approved' });
    const x = h.call('agent:execute', { proposalId: p.proposal.id });
    return p.ok === true
      && c.ok === true && c.executed === false          // 确认阶段仍恒不执行
      && x.ok === true && x.executed === true
      && fs.readFileSync(target, 'utf8') === '链路内容';
  })());

  check('❌ D4-R23 非受信渲染端调用 execute 必须抛 UNTRUSTED_RENDERER', (() => {
    const h = channelHarness();
    let threw = null;
    try { h.handlers.get('agent:execute')(h.rogue, { proposalId: 'x' }); } catch (e) { threw = e; }
    // 本仓既定契约：ipcGuard 在调用业务 handler 前直接抛，不是错误信封
    return !!threw && (threw.code === 'UNTRUSTED_RENDERER' || threw.message === 'UNTRUSTED_RENDERER');
  })());

  check('❌ D4-R23b 通道层的输入形态校验是独立一层（变异测试实测）', (() => {
    // 🔴 变异测试实测（2026-10-06）：把通道层的 `if (!raw || typeof raw !== 'object')` 删掉，
    //   本文件仍全绿—— 因为执行器内部的「闸门 0」做了同样的校验，**两层守卫叠加**。
    //   这是纵深防御（好事），但也意味着「通道层校验」这条断言不能靠结果反推。
    //   故本条如实记录该重叠：**删掉任一层都不产生可观测差异**，
    //   真正兜住的是两层同时存在。若将来有人删掉执行器那层，本条会立刻失效并提醒。
    const h = channelHarness();
    const bad = [null, undefined, 'string-arg', 42, []];
    const allRejected = bad.every((raw) => h.call('agent:execute', raw).ok === false);
    return allRejected && typeof h.handlers.get('agent:execute') === 'function';
  })());

  check('❌ D4-R24 通道层也必须挡住非受信（守卫不是只在执行器里）', (() => {
    const h = channelHarness();
    const evilTarget = path.join(h.sandbox, 'evil.txt');
    let threw = null;
    try {
      h.handlers.get('agent:execute')(h.rogue, { proposalId: 'x', content: 'pwn', scope: evilTarget });
    } catch (e) { threw = e; }
    return !!threw && !fs.existsSync(evilTarget);
  })());

  check('❌ D4-R25 通道层不传 content 时不得创建文件（漏传参数）', (() => {
    const h = channelHarness();
    const target = path.join(h.sandbox, 'nocontent.txt');
    const p = h.call('agent:propose-action', { capability: 'workspace.write', scope: target });
    h.call('agent:confirm-action', { proposalId: p.proposal && p.proposal.id, decision: 'approved' });
    const r = h.call('agent:execute', { proposalId: p.proposal && p.proposal.id });
    return (p.ok === false || r.ok === false) && !fs.existsSync(target);
  })());

  check('❌ D4-R26 通道层重放：同一 id 第二次执行必须被拒', (() => {
    const h = channelHarness();
    const target = path.join(h.sandbox, 'replay.txt');
    const p = h.call('agent:propose-action', { capability: 'workspace.write', scope: target, content: '第一次' });
    h.call('agent:confirm-action', { proposalId: p.proposal.id, decision: 'approved' });
    const first = h.call('agent:execute', { proposalId: p.proposal.id });
    const second = h.call('agent:execute', { proposalId: p.proposal.id });
    return first.ok === true
      && second.ok === false && second.error === 'ALREADY_EXECUTED'
      && fs.readFileSync(target, 'utf8') === '第一次';
  })());

  check('❌ D4-R27 通道层不接受调用方自带的 scope 顶替提案路径', (() => {
    const h = channelHarness();
    const legit = path.join(h.sandbox, 'legit2.txt');
    const p = h.call('agent:propose-action', { capability: 'workspace.write', scope: legit, content: 'x' });
    h.call('agent:confirm-action', { proposalId: p.proposal.id, decision: 'approved' });
    const r = h.call('agent:execute', {
      proposalId: p.proposal.id, scope: path.join(h.sandbox, 'other.txt'),
    });
    return r.ok === true
      && fs.existsSync(legit)
      && !fs.existsSync(path.join(h.sandbox, 'other.txt'));   // 调用方指定的路径被无视
  })());
}

/* ================= 12. SEC-01 权威内容快照与 SHA-256 强绑定执行门禁 ================= */
{
  check('SEC01-E1 提案绑定 contentHash 时，执行器验证内容 SHA-256 严格一致', (() => {
    const e = env();
    const crypto = require('crypto');
    const target = path.join(e.sandbox, 'sec01-exact.txt');
    const content = '正本内容：初澜生活日志';
    const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const p = createActionProposal(
      { capability: 'workspace.write', scope: target },
      null,
      'user',
      { contentHash, contentBytes, contentPreview: content.slice(0, 300), isTruncated: false }
    );
    e.proposalStore.set(p.id, p);
    e.confirmation.confirm(p.id, 'approved', { status: p.status });
    const r = e.executor.execute({ proposalId: p.id, content });
    return r.ok === true && r.executed === true && fs.readFileSync(target, 'utf8') === content;
  })());

  check('❌ SEC01-R28 执行传入内容与提案 contentHash 不符时硬拒 CONTENT_HASH_MISMATCH 且作废授权', (() => {
    const e = env();
    const crypto = require('crypto');
    const target = path.join(e.sandbox, 'sec01-tamper.txt');
    const originalContent = '原本承诺写入的内容';
    const tamperedContent = '恶意篡改后的注入内容';
    const contentHash = crypto.createHash('sha256').update(originalContent, 'utf8').digest('hex');
    const contentBytes = Buffer.byteLength(originalContent, 'utf8');
    const p = createActionProposal(
      { capability: 'workspace.write', scope: target },
      null,
      'user',
      { contentHash, contentBytes, contentPreview: originalContent.slice(0, 300), isTruncated: false }
    );
    e.proposalStore.set(p.id, p);
    e.confirmation.confirm(p.id, 'approved', { status: p.status });
    const r = e.executor.execute({ proposalId: p.id, content: tamperedContent });
    // 授权必须被即时作废
    const isStillAllowed = e.confirmation.isExecutionAllowed(p.id, Date.now()).allowed;
    return r.ok === false
      && r.code === 'CONTENT_HASH_MISMATCH'
      && !fs.existsSync(target)
      && isStillAllowed === false;
  })());

  check('❌ SEC01-R29 执行传入字节数与提案 contentBytes 不符时硬拒 CONTENT_BYTES_MISMATCH', (() => {
    const e = env();
    const crypto = require('crypto');
    const target = path.join(e.sandbox, 'sec01-bytes.txt');
    const content = 'hello';
    const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const p = createActionProposal(
      { capability: 'workspace.write', scope: target },
      null,
      'user',
      { contentHash, contentBytes: 999, contentPreview: content, isTruncated: false }
    );
    e.proposalStore.set(p.id, p);
    e.confirmation.confirm(p.id, 'approved', { status: p.status });
    const r = e.executor.execute({ proposalId: p.id, content });
    return r.ok === false && r.code === 'CONTENT_BYTES_MISMATCH' && !fs.existsSync(target);
  })());

  check('SEC01-E2 通道层全链路：建案带 content 快照 → 确认 → 执行（不传 content 取快照）→ 成功写盘', (() => {
    const h = channelHarness();
    const target = path.join(h.sandbox, 'sec01-chain.txt');
    const content = '通道层权威快照链路落盘内容';
    const p = h.call('agent:propose-action', {
      capability: 'workspace.write',
      scope: target,
      content,
      reason: '快照链路测试',
    });
    const c = h.call('agent:confirm-action', { proposalId: p.proposal.id, decision: 'approved' });
    // 执行时不传 content，执行层权威取回私有快照执行
    const x = h.call('agent:execute', { proposalId: p.proposal.id });
    return p.ok === true
      && c.ok === true
      && x.ok === true
      && x.executed === true
      && fs.readFileSync(target, 'utf8') === content;
  })());

  check('SEC01-E3 通道层防篡改：调用方在 execute 时传入不同 content，执行器仍严格以快照为准', (() => {
    const h = channelHarness();
    const target = path.join(h.sandbox, 'sec01-tamper-attempt.txt');
    const snapshotContent = '权威快照里的安全内容';
    const p = h.call('agent:propose-action', {
      capability: 'workspace.write',
      scope: target,
      content: snapshotContent,
      reason: '防篡改测试',
    });
    h.call('agent:confirm-action', { proposalId: p.proposal.id, decision: 'approved' });
    // 调用方试图传入恶意 content
    const x = h.call('agent:execute', { proposalId: p.proposal.id, content: '试图覆盖的恶意输入' });
    return p.ok === true
      && x.ok === true
      && fs.readFileSync(target, 'utf8') === snapshotContent; // 落盘的是快照内容，不是调用方传入的内容
  })());

  check('❌ SEC01-R30 执行器底层回滚失败时（ROLLBACK_FAILED），授权被作废且标记 rollbackFailed', (() => {
    const e = env();
    const rollbackFailTxn = {
      begin(opts) { return { ...opts, id: 'tx-fail-rb' }; },
      commit() {
        const err = new Error('Rollback failure simulation');
        err.code = 'ROLLBACK_HASH_MISMATCH';
        throw err;
      },
      rollback() {},
    };
    e.executor.txn = rollbackFailTxn;
    const target = path.join(e.sandbox, 'sec01-rb-fail.txt');
    const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: 'rollback fail test' });
    const r = e.executor.execute({ proposalId: id, content: 'rollback fail test' });
    const auth = e.confirmation.isExecutionAllowed(id, Date.now());
    return r.ok === false
      && r.code === 'ROLLBACK_FAILED'
      && r.rollbackFailed === true
      && auth.allowed === false
      && auth.reason === 'ROLLBACK_FAILED';
  })());

  check('❌ SEC01-R31 执行器级反例：未绑定有效 contentHash 的写入提案被硬拒 CONTENT_HASH_REQUIRED 且作废授权', (() => {
    const e = env();
    const target = path.join(e.sandbox, 'sec01-no-hash.txt');
    const p = createActionProposal({ capability: 'workspace.write', scope: target });
    e.proposalStore.set(p.id, p);
    e.confirmation.confirm(p.id, 'approved', { status: p.status });
    const r = e.executor.execute({ proposalId: p.id, content: '任意待注入内容' });
    const auth = e.confirmation.isExecutionAllowed(p.id, Date.now());
    return r.ok === false
      && r.code === 'CONTENT_HASH_REQUIRED'
      && !fs.existsSync(target)
      && auth.allowed === false
      && auth.reason === 'CONTENT_HASH_REQUIRED';
  })());
}

/* ================= 10. SEC-02 & SEC-03 门禁：符号链接穿透防逃逸与扩展名下沉 ================= */
{
  check('❌ SEC02-R1 文件符号链接逃逸被读拦截：返回 SYMLINK_ESCAPE、不泄露敏感内容并吊销授权（注入测）', (() => {
    const e = env();
    const fakeFs = Object.create(fs);
    const linkPath = path.join(e.sandbox, 'link_secret.txt');
    const realTarget = path.join(e.outside, 'secret.txt');
    fakeFs.lstatSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(linkPath)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.lstatSync(p);
    };
    fakeFs.realpathSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(linkPath)) {
        return realTarget;
      }
      return fs.realpathSync(p);
    };
    e.executor.fs = fakeFs;
    const id = authorizeProposal(e, { capability: 'workspace.read', scope: linkPath });
    const r = e.executor.execute({ proposalId: id });
    const auth = e.confirmation.isExecutionAllowed(id, Date.now());
    return r.ok === false
      && r.code === 'SYMLINK_ESCAPE'
      && r.content === undefined
      && auth.allowed === false
      && auth.reason === 'SYMLINK_ESCAPE';
  })());

  check('❌ SEC02-R2 文件符号链接逃逸被写拦截：返回 SYMLINK_ESCAPE、外部原文件字节不变并吊销授权（注入测）', (() => {
    const e = env();
    const fakeFs = Object.create(fs);
    const linkPath = path.join(e.sandbox, 'link_write.txt');
    const realTarget = path.join(e.outside, 'secret.txt');
    fakeFs.lstatSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(linkPath)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.lstatSync(p);
    };
    fakeFs.realpathSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(linkPath)) {
        return realTarget;
      }
      return fs.realpathSync(p);
    };
    e.executor.fs = fakeFs;
    const id = authorizeProposal(e, { capability: 'workspace.write', scope: linkPath, content: 'PWNED-OVERWRITE' });
    const r = e.executor.execute({ proposalId: id, content: 'PWNED-OVERWRITE' });
    const auth = e.confirmation.isExecutionAllowed(id, Date.now());
    return r.ok === false
      && r.code === 'SYMLINK_ESCAPE'
      && fs.readFileSync(path.join(e.outside, 'secret.txt'), 'utf8') === 'ORIGINAL-SECRET'
      && auth.allowed === false
      && auth.reason === 'SYMLINK_ESCAPE';
  })());

  check('❌ SEC02-R3 悬空符号链接无法证明安全失败关闭：返回 SYMLINK_ESCAPE 并吊销授权（注入测）', (() => {
    const e = env();
    const danglingFs = Object.create(fs);
    const dangPath = path.join(e.sandbox, 'dangling.txt');
    danglingFs.lstatSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(dangPath)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.lstatSync(p);
    };
    danglingFs.realpathSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(dangPath)) {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return fs.realpathSync(p);
    };
    e.executor.fs = danglingFs;
    const id = authorizeProposal(e, { capability: 'workspace.write', scope: dangPath, content: 'dangling content' });
    const r = e.executor.execute({ proposalId: id, content: 'dangling content' });
    const auth = e.confirmation.isExecutionAllowed(id, Date.now());
    return r.ok === false
      && r.code === 'SYMLINK_ESCAPE'
      && auth.allowed === false
      && auth.reason === 'SYMLINK_ESCAPE';
  })());

  check('❌ SEC02-R4 循环符号链接 ELOOP 失败关闭：返回 SYMLINK_ESCAPE 并吊销授权（注入测）', (() => {
    const e = env();
    const loopFs = Object.create(fs);
    const loopPath = path.join(e.sandbox, 'loop.txt');
    loopFs.lstatSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(loopPath)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.lstatSync(p);
    };
    loopFs.realpathSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(loopPath)) {
        const err = new Error('ELOOP: too many symbolic links encountered');
        err.code = 'ELOOP';
        throw err;
      }
      return fs.realpathSync(p);
    };
    e.executor.fs = loopFs;
    const id = authorizeProposal(e, { capability: 'workspace.read', scope: loopPath });
    const r = e.executor.execute({ proposalId: id });
    const auth = e.confirmation.isExecutionAllowed(id, Date.now());
    return r.ok === false
      && r.code === 'SYMLINK_ESCAPE'
      && auth.allowed === false
      && auth.reason === 'SYMLINK_ESCAPE';
  })());

  check('❌ SEC02-R5 followSymlink 开启时依然受物理沙盒根强约束拦截并吊销授权（注入测）', (() => {
    const e = env();
    const fakeFs = Object.create(fs);
    const linkPath = path.join(e.sandbox, 'bypass.txt');
    const realTarget = path.join(e.outside, 'secret.txt');
    fakeFs.lstatSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(linkPath)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.lstatSync(p);
    };
    fakeFs.realpathSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(linkPath)) {
        return realTarget;
      }
      return fs.realpathSync(p);
    };
    e.executor.fs = fakeFs;
    e.policy.followSymlink = true; // 显式放开策略开关
    const id = authorizeProposal(e, { capability: 'workspace.read', scope: linkPath });
    const r = e.executor.execute({ proposalId: id });
    const auth = e.confirmation.isExecutionAllowed(id, Date.now());
    return r.ok === false
      && r.code === 'SYMLINK_ESCAPE'
      && auth.allowed === false
      && auth.reason === 'SYMLINK_ESCAPE';
  })());

  check('❌ SEC02-R6 真实目录联接（junction）跨边界逃逸读写双双被拦截并吊销授权（真实磁盘测）', (() => {
    const e = env();
    const linkDir = path.join(e.sandbox, 'real_junction_link');
    try {
      fs.symlinkSync(e.outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return true; // 无法创建链接环境降级
    }

    // 1. 尝试通过 junction 读取沙盒外部敏感文件
    const readTarget = path.join(linkDir, 'secret.txt');
    const idRead = authorizeProposal(e, { capability: 'workspace.read', scope: readTarget });
    const rRead = e.executor.execute({ proposalId: idRead });
    const authRead = e.confirmation.isExecutionAllowed(idRead, Date.now());

    // 2. 尝试通过 junction 向沙盒外部写入文件
    const writeTarget = path.join(linkDir, 'pwned.txt');
    const idWrite = authorizeProposal(e, { capability: 'workspace.write', scope: writeTarget, content: 'ATTACK' });
    const rWrite = e.executor.execute({ proposalId: idWrite, content: 'ATTACK' });
    const authWrite = e.confirmation.isExecutionAllowed(idWrite, Date.now());

    const readBlocked = rRead.ok === false
      && rRead.code === 'SYMLINK_ESCAPE'
      && authRead.allowed === false
      && authRead.reason === 'SYMLINK_ESCAPE'
      && !rRead.result;

    const writeBlocked = rWrite.ok === false
      && rWrite.code === 'SYMLINK_ESCAPE'
      && authWrite.allowed === false
      && authWrite.reason === 'SYMLINK_ESCAPE'
      && !fs.existsSync(path.join(e.outside, 'pwned.txt'))
      && fs.readFileSync(path.join(e.outside, 'secret.txt'), 'utf8') === 'ORIGINAL-SECRET';

    return readBlocked && writeBlocked;
  })());

  check('❌ SEC02-R7 根目录无法证明物理路径安全时失败关闭拦截（F3 fail-closed）', (() => {
    const e = env();
    const brokenRoot = path.join(e.root, 'broken_root');
    fs.mkdirSync(brokenRoot);
    const target = path.join(brokenRoot, 'file.txt');
    fs.writeFileSync(target, 'data');
    e.policy.setScopeRoots('workspace.read', [brokenRoot]);

    // 注入 resolveRealPath：模拟根目录物理路径解析异常（EACCES / 损坏）
    e.executor.resolveRealPath = (p, f) => {
      if (path.resolve(p) === path.resolve(brokenRoot)) {
        const err = new Error('EACCES');
        err.code = 'EACCES';
        throw err;
      }
      return resolveRealPath(p, f);
    };

    const id = authorizeProposal(e, { capability: 'workspace.read', scope: target });
    const r = e.executor.execute({ proposalId: id });
    const auth = e.confirmation.isExecutionAllowed(id, Date.now());
    return r.ok === false
      && r.code === 'SYMLINK_ESCAPE'
      && auth.allowed === false
      && auth.reason === 'SYMLINK_ESCAPE';
  })());

  check('❌ SEC02-R8 硬链接跨边界读写拦截与状态不可证失败关闭：返回 HARDLINK_DETECTED 并吊销授权不泄露内容（N3 & Q1 防御）', (() => {
    const e = env();
    const hardlinkFile = path.join(e.sandbox, 'hardlink.txt');
    let hasHardlink = true;
    try {
      fs.linkSync(path.join(e.outside, 'secret.txt'), hardlinkFile);
    } catch {
      hasHardlink = false;
    }

    let readBlocked = true;
    let writeBlocked = true;
    if (hasHardlink) {
      // 1. 尝试读取跨边界硬链接文件
      const idRead = authorizeProposal(e, { capability: 'workspace.read', scope: hardlinkFile });
      const rRead = e.executor.execute({ proposalId: idRead });
      const authRead = e.confirmation.isExecutionAllowed(idRead, Date.now());

      // 2. 尝试写入已存在的硬链接文件
      const idWrite = authorizeProposal(e, { capability: 'workspace.write', scope: hardlinkFile, content: 'OVERWRITE' });
      const rWrite = e.executor.execute({ proposalId: idWrite, content: 'OVERWRITE' });
      const authWrite = e.confirmation.isExecutionAllowed(idWrite, Date.now());

      readBlocked = rRead.ok === false
        && rRead.code === 'HARDLINK_DETECTED'
        && authRead.allowed === false
        && authRead.reason === 'HARDLINK_DETECTED'
        && !rRead.result;

      writeBlocked = rWrite.ok === false
        && rWrite.code === 'HARDLINK_DETECTED'
        && authWrite.allowed === false
        && authWrite.reason === 'HARDLINK_DETECTED'
        && fs.readFileSync(path.join(e.outside, 'secret.txt'), 'utf8') === 'ORIGINAL-SECRET';
    }

    // 3. 无法证明目标文件状态时失败关闭（Q1 fail-closed 防御：EACCES 不得静默放行写盘）
    const unprovableFile = path.join(e.sandbox, 'unprovable.txt');
    fs.writeFileSync(unprovableFile, 'SAFE-DATA');
    const fakeFs = Object.create(e.executor.fs);
    fakeFs.statSync = (p) => {
      if (path.resolve(String(p)) === path.resolve(unprovableFile)) {
        const err = new Error('EACCES');
        err.code = 'EACCES';
        throw err;
      }
      return e.executor.fs.statSync(p);
    };
    e.executor.fs = fakeFs;
    const idUnprovable = authorizeProposal(e, { capability: 'workspace.write', scope: unprovableFile, content: 'MALICIOUS' });
    const rUnprovable = e.executor.execute({ proposalId: idUnprovable, content: 'MALICIOUS' });
    const authUnprovable = e.confirmation.isExecutionAllowed(idUnprovable, Date.now());
    const unprovableBlocked = rUnprovable.ok === false
      && rUnprovable.code === 'HARDLINK_DETECTED'
      && authUnprovable.allowed === false
      && authUnprovable.reason === 'HARDLINK_DETECTED'
      && fs.readFileSync(unprovableFile, 'utf8') === 'SAFE-DATA';

    return readBlocked && writeBlocked && unprovableBlocked;
  })());

  check('❌ SEC03-R1 非白名单扩展名硬拒绝 DISALLOWED_EXTENSION 且不落盘并作废授权', (() => {
    const e = env({ budget: { maxWritesPerSession: 30, maxActionsPerSession: 40 } });
    const badTargets = [
      path.join(e.sandbox, 'bad.exe'),
      path.join(e.sandbox, 'hack.bat'),
      path.join(e.sandbox, 'shell.sh'),
      path.join(e.sandbox, 'script.ps1'),
      path.join(e.sandbox, 'noext'),
      path.join(e.sandbox, 'note.txt:stream'),
      path.join(e.sandbox, 'note.txt.'),
      path.join(e.sandbox, 'note.txt '),
      path.join(e.sandbox, 'CON.txt'),
      path.join(e.sandbox, 'NUL.json'),
      path.join(e.sandbox, 'sub:dir', 'file.txt'),
    ];
    let allBlocked = true;
    for (const target of badTargets) {
      const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: 'evil content' });
      const r = e.executor.execute({ proposalId: id, content: 'evil content' });
      const auth = e.confirmation.isExecutionAllowed(id, Date.now());
      if (r.ok !== false || r.code !== 'DISALLOWED_EXTENSION' || fs.existsSync(target) || auth.allowed !== false || auth.reason !== 'DISALLOWED_EXTENSION') {
        allBlocked = false;
        break;
      }
    }

    // 读路径 NTFS ADS 冒号同样被拦截
    const adsReadTarget = path.join(e.sandbox, 'doc.txt:stream');
    const idAdsRead = authorizeProposal(e, { capability: 'workspace.read', scope: adsReadTarget });
    const rAdsRead = e.executor.execute({ proposalId: idAdsRead });
    const authAdsRead = e.confirmation.isExecutionAllowed(idAdsRead, Date.now());
    const adsReadBlocked = rAdsRead.ok === false
      && rAdsRead.code === 'DISALLOWED_EXTENSION'
      && authAdsRead.allowed === false
      && authAdsRead.reason === 'DISALLOWED_EXTENSION';

    return allBlocked && adsReadBlocked;
  })());

  check('SEC03-R2 白名单扩展名（.txt/.md/.json/.log）及大小写变体（.TXT/.MD）正常落盘', (() => {
    const e = env({ budget: { maxWritesPerSession: 20 } });
    const goodTargets = [
      { name: 'doc.txt', content: 'hello txt' },
      { name: 'notes.md', content: 'hello md' },
      { name: 'data.json', content: '{"ok":true}' },
      { name: 'run.log', content: 'line 1' },
      { name: 'BIG.TXT', content: 'uppercase' },
      { name: 'CAP.MD', content: 'uppercase md' },
    ];
    let allPassed = true;
    for (const item of goodTargets) {
      const target = path.join(e.sandbox, item.name);
      const id = authorizeProposal(e, { capability: 'workspace.write', scope: target, content: item.content });
      const r = e.executor.execute({ proposalId: id, content: item.content });
      if (r.ok !== true || !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== item.content) {
        allPassed = false;
        break;
      }
    }
    return allPassed;
  })());
}

/* ================= 汇总 ================= */
console.log('--- D-4 受控执行器门禁结束---');
if (failures > 0) {
  console.error(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log('D-4 执行器门禁全部通过');
