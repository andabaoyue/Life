/**
 * test/d10-wiring.test.js
 *
 * D-10 门禁：主进程建案路径（「插电源」）。
 *
 * ## 为什么单独一个文件
 *
 * 这是十五轮以来第一次让「她的想法」有可能变成动作。
 * 前十四轮验证的全是「她不会乱来」，而这一轮要验证的是——
 * **闸门在她真的要动手时拦不拦得住，以及拦不住时是不是我们自己放的口子**。
 *
 * ## 覆盖的三类反例（门禁第一铁律）
 *
 *   ① 漏传参数：intent 缺 hint / hint 空 / deps 未就绪 —— 一个都不能建案
 *   ② 恶意变体：hint 夹绝对路径 / 夹分隔符 / 夹 .. 段 —— 想跑出沙盒
 *   ③ 边界值：超长名、纯点、`.hidden` 这类合法隐藏名（**应放行**）
 *
 * ⚠️ 这里刻意**不引入 main.js 的真实启动**（那要拉起整个 Electron 替身）。
 *   而是直接测两处**可独立验证**的东西：
 *     · agent-ipc 的 proposeInternal 与通道**同一条路径**（抽函数后的硬约束）
 *     · hint 安全边界的判据函数（等价复刻在测试里对照 main.js 的行）
 *   真实端到端由 `test/d10-e2e.test.js` 之外的运行验证覆盖 ——
 *   本文件的局限如实写在报告里，不冒充端到端。
 */

const path = require('path');
const { registerAgentIpc } = require('../src/agent-ipc');
const { PermissionPolicy, ExecutionBudget, CapabilityRegistry, AuditLog } = require('../src/agent-interfaces');
const { UserConfirmationGate } = require('../src/agent-confirmation');
const os = require('os');
const fs = require('fs');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
const _d10Dirs = [];
const _d10OrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d10OrigMkdtemp.apply(fs, a);
  _d10Dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d10Dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d10OrigMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* 与 main.js 的 tryBuildProposalFromIntent 中安全边界**逐条对应**。
   为什么在测试里复刻：那段代码在 main.js 里不导出。
   ⚠️ 复刻带来的风险是「两处漂移」—— 所以下面同时有一条断言
      直接读 main.js 源码，确认判据行仍然存在（漂移则红）。 */
function hintRejectReason(rawHint) {
  const h = String(rawHint == null ? '' : rawHint).trim();
  if (!h) return 'EMPTY';
  if (path.win32.isAbsolute(h) || path.posix.isAbsolute(h)) return 'ABSOLUTE';
  if (/[\\/]/.test(h)) return 'SEPARATOR';
  if (h === '.' || h === '..') return 'DOT_SEG';
  // ⚠️ 不能用 split('.').includes('..')：'a..b.md'.split('.') 里没有 '..' 元素，
  //   那条判据恒假。实测就是被这个坑抓住的 —— 第一版测试里三条反例全绿（假绿）。
  if (/\.\./.test(h)) return 'DOTDOT_SEG';
  if (h.length > 200) return 'TOO_LONG';
  return null;
}

function harness() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'd10-'));
  const guard = { handle() {}, assertTrustedRenderer() {}, isTrustedRenderer: () => true };
  const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read', 'workspace.write'] });
  policy.setScopeRoots('workspace.read', [sandbox]);
  policy.setScopeRoots('workspace.write', [sandbox]);
  const budget = new ExecutionBudget();
  const confirmation = new UserConfirmationGate();
  const auditLog = { list: () => [], append: () => {} };
  const api = registerAgentIpc(guard, {
    registry: new CapabilityRegistry(), policy, budget, auditLog, confirmation,
  }, {});
  return { sandbox, api, policy, budget, confirmation };
}

console.log('--- D-10 建案路径门禁 ---');

/* ============ 1. 抽函数后：通道与主进程同一条路径 ============ */
{
  const h = harness();
  check('registerAgentIpc 交出实例化的 evaluateProposal 与 proposeInternal',
    typeof h.api.evaluateProposal === 'function' && typeof h.api.proposeInternal === 'function');

  const scope = path.join(h.sandbox, 'note.md');
  const viaMain = h.api.proposeInternal({ capability: 'workspace.write', scope, reason: 'r', content: '测试写入正文' }, 'main');
  check('主进程路径能建案（via=main）',
    viaMain && viaMain.ok === true && !!viaMain.proposal, JSON.stringify(viaMain && viaMain.error));
  check('❌ 建案后提案必须进注册表（confirm/execute 靠它做存在性核对）',
    viaMain && viaMain.ok === true && h.api.evaluateProposal({ capability: 'workspace.write', scope }) !== null);

  // 同一条路径 ⇒ 同样是主进程发起，第二次应因预算正常扣减而非被拒
  const viaIpc = h.api.proposeInternal({ capability: 'workspace.write', scope: path.join(h.sandbox, 'b.md'), reason: 'r', content: '测试写入正文' }, 'ipc');
  check('❌ 通道路径与主进程路径共用同一份逻辑（两处判定会漂移）',
    viaIpc && viaIpc.ok === true);
}

/* ============ 2. 反例①：漏传参数 ============ */
{
  const h = harness();
  check('❌ 反例：raw 为 null 不建案', (h.api.proposeInternal(null, 'main') || {}).ok === false);
  check('❌ 反例：raw 为数组不建案', (h.api.proposeInternal([], 'main') || {}).ok === false);
  check('❌ 反例：缺 capability 不建案', (h.api.proposeInternal({ scope: 'x' }, 'main') || {}).ok === false);
  check('❌ 反例：空 capability 不建案', (h.api.proposeInternal({ capability: '' }, 'main') || {}).ok === false);
}

/* ============ 3. 反例②：hint 安全边界（恶意变体） ============ */
{
  check('❌ 反例：绝对路径被拒（Windows 盘符）', hintRejectReason('C:\\Windows\\x.md') === 'ABSOLUTE');
  check('❌ 反例：反斜杠分隔符被拒', hintRejectReason('..\\secret.md') === 'SEPARATOR');
  check('❌ 反例：正斜杠分隔符被拒', hintRejectReason('sub/dir.md') === 'SEPARATOR');
  check('❌ 反例：纯 .. 被拒', hintRejectReason('..') === 'DOT_SEG');
  check('❌ 反例：纯 . 被拒', hintRejectReason('.') === 'DOT_SEG');
  check('❌ 反例：主名含 .. 段被拒', hintRejectReason('a..b.md') === 'DOTDOT_SEG');
  check('❌ 反例：空 hint 被拒', hintRejectReason('') === 'EMPTY');
  check('❌ 反例：纯空白 hint 被拒', hintRejectReason('   ') === 'EMPTY');
  check('❌ 反例：超长名（>200）被拒', hintRejectReason('a'.repeat(201) + '.md') === 'TOO_LONG');

  // 边界：恰好 200 应放行（阈值不许偏移）
  const atLimit = 'a'.repeat(197) + '.md';   // 197 + 3 = 200 字符
  check('❌ 边界：恰好 200 字符应放行（阈值不偏移）',
    atLimit.length === 200 && hintRejectReason(atLimit) === null, 'len=' + atLimit.length);
}

/* ============ 4. 沙盒内取名自由（用户拍板 A'） ============ */
{
  check('中文名放行（她想叫「我的日记.md」都随她）', hintRejectReason('我的日记.md') === null);
  check('带空格的名字放行', hintRejectReason('my notes.md') === null);
  check('纯数字名放行', hintRejectReason('1234.txt') === null);
  check('隐藏文件放行（.foo 是合法文件名，不是点段）', hintRejectReason('.foo.md') === null);
  check('连字符/下划线放行', hintRejectReason('report-final_v2.md') === null);
  check('❌ 但主名以点开头的多重点仍拒（.a..b.md）', hintRejectReason('.a..b.md') === 'DOTDOT_SEG');
}

/* ============ 5. 防漂移：判据必须仍在 main.js 里 ============ */
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('❌ main.js 仍有绝对路径判据（防止有人删了它而测试仍绿）',
    mainSrc.includes('path.isAbsolute(rawHint)'));
  // 🔵 D-12 修订：这三条判据**从 tryBuildProposalFromIntent 搬到了
  //   maybeAskForSelfNote**（通路 B 暂缓后，唯一还在建案的是通路 A）。
  //   断言的**意图没变**（判据必须仍在、不许被删），只是换了宿主函数。
  //   ⚠️ 这条修订本身就是一次实证：断言指向了具体语法，函数一搬家就红。
  check('❌ main.js 仍有分隔符判据（现位于 maybeAskForSelfNote）',
    mainSrc.includes('if (/[\\\\/]/.test(rawHint)) return;'));
  check('❌ main.js 的连续点判据用正则而非 split（split 版恒假，实测）',
    mainSrc.includes('if (/\\.\\./.test(rawHint)) return;')
    && !mainSrc.includes("rawHint.split('.').includes('..')"));
  // 变异测试补漏（2026-10-07）：mD 删掉超长判据时上面全绿 —— 覆盖缺失。
  //   超长名是「病态输入」这一类的唯一防线，漏了它等于没测边界。
  check('❌ main.js 仍有超长名判据（>200 拒绝）',
    mainSrc.includes('if (rawHint.length > 200) return;'));
  check('❌ main.js 仍复用 proposeInternal（不许就地复刻建案）',
    mainSrc.includes('deps.agentIpc.proposeInternal('));
  // 🔵 D-27 修订：这条断言的**原意**是「不留空内容的半截案」——
  //   D-12 时期用「直接 return null」实现这个意图，D-27 接通通路 B 后
  //   return null 不再是唯一形态，但**意图没变**：建案前必须拿到非空正文。
  //   ⚠️ 这是本文件第三次「断言指向了具体语法、功能一落地就红」：
  //     D-12 搬函数一次、D-27 改 async 一次、D-27 复核改三态一次。
  //     教训一致：**钉判据，别钉实现路径**。
  //   现在的判据：不是 ok 三态、或 content 非字符串/为空 ⇒ 一律不建案。
  check('❌ 通路 B：非 ok 或正文为空时仍必须 return null（不留空内容的半截案）',
    /draftStatus !== 'ok' \|\| typeof draft\.content !== 'string' \|\| !draft\.content\.trim\(\)\) \{[\s\S]{0,600}?return null;/
      .test(mainSrc));
  // 🔵 D-27 复核新增：三态必须分开处理 —— refused 要留痕，不能与 unavailable 混成一支。
  //   🔵 第二次复核再改：审计的区分方式从「reason 前缀」改成了**独立 outcome**
  //      （`refused_by_subject` vs `draft_unavailable`）——只按 outcome 汇总时，
  //      前缀区分会把拟稿故障统计成她的决策。断言随之改为钉 outcome。
  check('🔴 通路 B：refused 与 unavailable 用不同 outcome（否则拒案无法正确统计）',
    mainSrc.includes("draftStatus === 'refused'")
    && mainSrc.includes("'refused_by_subject'")
    && mainSrc.includes("'draft_unavailable'"));
  // 🔵 D-27 新增：消费即清空必须在 **await 之前**（同步段）完成。
  //   若写在 await 之后，等待期间用户发的新意图会被这句话误删，
  //   而同一意图也可能被二次消费（重复建案）。
  check('🔴 通路 B：_pendingAgentIntent 在 await 之前同步置空（消费即清空）',
    /brain\._pendingAgentIntent = null;[\s\S]{0,2000}?await brain\.askForProposalContent/
      .test(mainSrc));
  // 🔵 D-27 新增：建案后必须广播**语义明确**的待决事件。
  //   D-19 删掉了唯一的发送点之后，全仓再无任何 -available 广播，
  //   于是建出来的案会躺在注册表里直到 TTL 过期 —— 用户永远看不到卡片。
  check('🔴 通路 B：建案后广播 agent-proposal-pending（否则卡片永不亮）',
    mainSrc.includes("broadcastToWindows('agent-proposal-pending'"));
  // 🔵 D-27 新增：**绝不复用** -available 这个名字（D-19 已判它语义歧义）。
  check('❌ 通路 B 不得复用 agent-proposal-available（D-19 铁律）',
    !mainSrc.includes("broadcastToWindows('agent-proposal-available'"));
  // 🔵 D-27 新增：建案期**不许再扣写额度**（那是回退到双重扣减/时机错位）。
  check('❌ 建案期只扣 actions，不扣 writes（writes 留给真正落盘）',
    !mainSrc.includes('evaluateProposal({ capability: intent.capability, scope, reason: intent.reason })'));
  // 🔵 D-27 修订：原来是 `/^function tryBuildProposalFromIntent\(\)/m` ——
  //   函数变 async 之后那条正则直接落空（实测：改完立刻 FAIL）。
  //   **约束本身没变**：它必须仍在模块顶层，放进 whenReady 里会 ReferenceError
  //   （chat-send 的 handler 在模块顶层注册，顶层闭包引用块级 const 会抛 TDZ）。
  check('❌ main.js 建案函数在模块顶层（放进 whenReady 会 ReferenceError）',
    /^(?:async )?function tryBuildProposalFromIntent\(\)/m.test(mainSrc));
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
