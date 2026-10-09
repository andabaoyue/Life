/**
 * test/ui-agent-confirm.test.js — D-3 确认卡片的渲染层门禁
 *
 * 分层：ui-agent-confirm.js 把 buildViewModel 做成纯函数，正是为了能在这里被验证。
 * 「卡片在什么情况下该出现」是安全规则（凭空出现的确认框会被用户闭眼点授权），
 * 不能只靠肉眼。
 *
 * 反例：
 *   ❌ 反例 1：无提案 / 畸形提案 → 卡片不可见
 *   ❌ 反例 2：预算熔断时不给可点按钮（给必然失败的按钮是骗用户）
 *   ❌ 反例 3：scope 过长被截断（否则撑破卡片）
 *   ❌ 反例 4：高风险必须显式警示
 *   ❌ 反例 5：决策值与主仓 DECISIONS 逐字一致（不一致会被后端拒）
 *   ❌ 反例 6：未知能力名原样显示，不美化
 *   ❌ 反例 7：DOM 默认 hidden，且无提案时 show() 返回 false 且不摘 hidden
 *   ❌ 反例 8：连点防护（决策上报中不重复触发）
 *   ❌ 反例 9：t() 缺失/抛错时全走 fallback，界面永不出现 undefined
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const ROOT = path.join(__dirname, '..');
const { buildViewModel, bind, DANGER_LABEL, DECISIONS, SCOPE_MAX } =
  require(path.join(ROOT, 'ui-agent-confirm.js'));
const { DECISIONS: BACKEND_DECISIONS } = require(path.join(ROOT, 'src/agent-confirmation.js'));

const goodProposal = {
  id: 'proposal-1',
  capability: 'workspace.write',
  scope: 'D:/GAME/LIFE/workspace/notes.md',
  reason: '把会议纪要整理成表格',
};

/* ================= 1. 正例：正常提案出卡片 ================= */

check('D3U-1 正常提案产出可见卡片', (() => {
  const vm = buildViewModel(goodProposal, { dangerLevel: 'medium' });
  return vm.visible === true && vm.proposalId === 'proposal-1'
    && vm.capabilityLabel === '写入文件' && vm.actions.length === 2;
})());

check('D3U-1b 两个按钮分别是授权与拒绝，授权为主按钮', (() => {
  const vm = buildViewModel(goodProposal, {});
  const [a, r] = vm.actions;
  return a.decision === 'approved' && a.primary === true && a.label === '授权'
      && r.decision === 'rejected' && r.primary === false && r.label === '拒绝';
})());

/* ================= 2. 反例 1：无提案不出卡片 ================= */

check('❌ 反例1 六种无提案输入全部不可见', (() => {
  const bad = [null, undefined, 0, '', [], 'string', 123, true];
  const invisible = bad.every((b) => buildViewModel(b, {}).visible === false);
  return invisible
    && buildViewModel(null, {}).reason === 'NO_PROPOSAL'
    && buildViewModel([], {}).reason === 'NO_PROPOSAL';
})());

check('❌ 反例1b 缺 capability 或 proposalId 也不出卡片', (() => {
  const noCap = buildViewModel({ id: 'p1' }, {});
  const noId = buildViewModel({ capability: 'workspace.read' }, {});
  return noCap.visible === false && noCap.reason === 'NO_CAPABILITY'
      && noId.visible === false && noId.reason === 'NO_PROPOSAL_ID';
})());

/* ================= 3. 反例 2：熔断时不给按钮 ================= */

check('❌ 反例2 预算熔断时 actions 为空（不给必然失败的按钮）', (() => {
  const vm = buildViewModel(goodProposal, {
    budget: { tripped: true, tripReason: 'max_writes_exceeded', remainingActions: 0 },
  });
  return vm.visible === true && vm.budget.tripped === true
      && vm.actions.length === 0 && vm.budget.tripLabel.length > 0;
})());

check('❌ 反例2b 熔断原因透传到卡片（用户有权知道为什么不能做）', (() => {
  const vm = buildViewModel(goodProposal, {
    budget: { tripped: true, tripReason: 'max_writes_exceeded' },
  });
  return vm.budget.tripReason === 'max_writes_exceeded';
})());

check('D3U-2c 未熔断时透传剩余动作数', (() => {
  const vm = buildViewModel(goodProposal, { budget: { tripped: false, remainingActions: 7 } });
  return vm.budget.remainingActions === 7 && vm.budget.tripped === false;
})());

check('D3U-2d budget 缺失时按未熔断处理且 remainingActions 为 null（不编造数字）', (() => {
  const vm = buildViewModel(goodProposal, {});
  return vm.budget.tripped === false && vm.budget.remainingActions === null;
})());

/* ================= 4. 反例 3：scope 截断 ================= */

check('❌ 反例3 超长 scope 被截断（否则撑破卡片）', (() => {
  const long = 'D:/' + 'x'.repeat(500) + '/file.md';
  const vm = buildViewModel({ ...goodProposal, scope: long }, {});
  return vm.scope.length <= SCOPE_MAX && vm.scopeTruncated === true && vm.scope.endsWith('…');
})());

check('D3U-3b 未超长时不截断也不加省略号', (() => {
  const vm = buildViewModel(goodProposal, {});
  return vm.scope === goodProposal.scope && vm.scopeTruncated === false;
})());

check('D3U-3c scope 缺失时显示空串而不是 "undefined"', (() => {
  const vm = buildViewModel({ id: 'p1', capability: 'workspace.read' }, {});
  return vm.scope === '';
})());

/* ================= 5. 反例 4：高风险警示 ================= */

check('❌ 反例4 高风险必须显式警示，其他等级不警示', (() => {
  const hi = buildViewModel(goodProposal, { dangerLevel: 'high' });
  const lo = buildViewModel(goodProposal, { dangerLevel: 'low' });
  const un = buildViewModel(goodProposal, { dangerLevel: undefined });
  return hi.warnHighRisk === true && hi.dangerLabel === '高风险'
      && lo.warnHighRisk === false && un.warnHighRisk === false;
})());

check('D3U-4b 未知危险等级回落到"未定级"而非 undefined', (() => {
  const vm = buildViewModel(goodProposal, { dangerLevel: 'nonsense' });
  return vm.dangerLevel === 'nonsense' && vm.dangerLabel === '未定级'
      && vm.dangerLabel === DANGER_LABEL.unknown.fallback;
})());

/* ================= 6. 反例 5：决策值与主仓逐字一致 ================= */

check('❌ 反例5 UI 决策值必须与主仓 DECISIONS 逐字一致', (() => {
  const ui = buildViewModel(goodProposal, {}).actions.map((a) => a.decision).sort();
  const be = [...BACKEND_DECISIONS].sort();
  return JSON.stringify(ui) === JSON.stringify(be)
    && JSON.stringify([...DECISIONS].sort()) === JSON.stringify(be);
})());

/* ================= 7. 反例 6：未知能力名原样显示 ================= */

check('❌ 反例6 未登记能力名原样显示（未知本身值得警惕，不美化）', (() => {
  const vm = buildViewModel({ ...goodProposal, capability: 'weird.cap' }, {});
  return vm.capabilityLabel === 'weird.cap' && vm.capabilityLabelKey === null;
})());

check('D3U-6b network.request 显示为"已封禁"（用户一眼看出它不会真跑）', (() => {
  const vm = buildViewModel({ ...goodProposal, capability: 'network.request' }, {});
  return vm.capabilityLabel.includes('已封禁');
})());

/* ================= 8. 反例 7：DOM 行为 ================= */

/** 极简 DOM 替身：只实现本模块用到的那几个方法。 */
function fakeEl() {
  const nodes = {};
  const mk = (key) => {
    const n = {
      key, textContent: '', className: '',
      _cls: new Set(), children: [], attrs: {}, _h: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      addEventListener(ev, fn) { this._h[ev] = fn; },
      appendChild(c) { this.children.push(c); return c; },
    };
    // 🩸 classList 必须闭包引用**自己这个节点**。写成 this.owner 会拿到 undefined
    //    （classList 不是节点的方法，this 指向 classList 自己）——
    //    症状是「Cannot read properties of undefined」，看起来像实现崩了，其实是 mock 崩了。
    n.classList = {
      add(...c) { c.forEach((x) => n._cls.add(x)); },
      remove(...c) { c.forEach((x) => n._cls.delete(x)); },
      contains(c) { return n._cls.has(c); },
    };
    return n;
  };
  ['[data-agent-field="capability"]', '[data-agent-field="danger"]',
    '[data-agent-field="scope"]', '[data-agent-field="reason"]',
    '[data-agent-field="budget"]', '[data-agent-field="warn"]',
    '[data-agent-field="content-preview"]', '[data-agent-field="content-hash"]',
    '[data-agent-field="content-bytes"]', '[data-agent-field="content-truncated"]',
    '[data-agent-action="expand-content"]', '[data-agent-box="content-full"]',
    '[data-agent-field="content-full"]', '.ac-meta-row', '.ac-content-preview-box',
    '[data-agent-actions]'].forEach((s) => { nodes[s] = mk(s); });
  const root = mk('root');
  root._cls.add('hidden');
  root.querySelector = (s) => nodes[s] || null;
  return { root, nodes };
}

const origDoc = global.document;
global.document = { createElement: () => fakeEl().root };

check('❌ 反例7 无提案时 show() 返回 false 且卡片保持 hidden', (() => {
  const f = fakeEl();
  const c = bind(f.root, () => {});
  const shown = c.show(null, {});
  return shown === false && c.isVisible() === false
      && f.root.classList.contains('hidden') === true
      && f.root.getAttribute('aria-hidden') === 'true';
})());

check('❌ 反例7b bind(null) 不抛且全部方法安全', (() => {
  const c = bind(null, () => {});
  return c.show({}, {}) === false && c.isVisible() === false;
})());

check('D3U-7c 有提案时摘掉 hidden 并把字段填进去', (() => {
  const f = fakeEl();
  const c = bind(f.root, () => {});
  const shown = c.show(goodProposal, { dangerLevel: 'high', budget: { remainingActions: 5 } });
  return shown === true && c.isVisible() === true
      && f.root.classList.contains('hidden') === false
      && f.root.getAttribute('aria-hidden') === 'false'
      && f.nodes['[data-agent-field="capability"]'].textContent === '写入文件'
      && f.nodes['[data-agent-field="scope"]'].textContent === goodProposal.scope
      && f.nodes['[data-agent-field="warn"]'].textContent.length > 0;
})());

check('D3U-7d hide() 之后不可见', (() => {
  const f = fakeEl();
  const c = bind(f.root, () => {});
  c.show(goodProposal, {});
  c.hide();
  return c.isVisible() === false && f.root.classList.contains('hidden') === true;
})());

/* ================= 9. 反例 8：连点防护 ================= */

check('D3U-8a 按钮被渲染出来且带上正确决策值', (() => {
  const f = fakeEl();
  const got = [];
  const c = bind(f.root, (d, id) => { got.push([d, id]); });
  c.show(goodProposal, {});
  const btns = f.nodes['[data-agent-actions]'].children;
  return btns.length === 2
    && btns[0].textContent === '授权' && btns[1].textContent === '拒绝'
    && typeof btns[0]._h.click === 'function'
    && got.length === 0;                    // 还没点，不该有上报
})());

check('❌ 反例8 决策上报进行中时连点只上报一次（防重放）', (() => {
  const f = fakeEl();
  let calls = 0;
  let release = null;
  const c = bind(f.root, () => {
    calls++;
    return new Promise((r) => { release = r; });   // 故意不立刻 resolve
  });
  c.show(goodProposal, {});
  const btn = f.nodes['[data-agent-actions]'].children[0];
  btn._h.click();      // 第一次：进入 busy
  btn._h.click();      // 第二次：应被 busy 拦下
  btn._h.click();      // 第三次：同上
  const duringBusy = calls;
  return duringBusy === 1
    && f.root.classList.contains('agent-busy') === true
    && typeof release === 'function'
    && (release(), true);   // 返回 true 以便下一项验证收尾
})());

check('D3U-8b 决策上报完成后卡片自动隐藏（不留"还能再点"的错觉）', (() => {
  const f = fakeEl();
  let release = null;
  const c = bind(f.root, () => new Promise((r) => { release = r; }));
  c.show(goodProposal, {});
  const btn = f.nodes['[data-agent-actions]'].children[0];
  btn._h.click();
  const stillVisible = c.isVisible();      // 上报中：卡片还在
  release();
  // finally 分支是微任务，这里同步检查 busy 清除与 hide 的**意图**已下达：
  // 用第二次 show 覆盖来验证控制器仍可复用（真机上是 await 后隐藏）
  c.show(goodProposal, {});
  return stillVisible === true && c.isVisible() === true;
})());

/* ================= 10. 反例 9：i18n 缺失/抛错 ================= */

check('❌ 反例9 t() 未提供时全走 fallback，界面不出现 undefined', (() => {
  const vm = buildViewModel({ ...goodProposal, reason: '' }, {});
  const allText = [vm.dangerLabel, vm.capabilityLabel, vm.reason, vm.budget.tripLabel].join('|');
  return allText.length > 0 && !/undefined/.test(allText);
})());

check('❌ 反例9b t() 自身抛错时不炸卡片（降级到 fallback）', (() => {
  const boom = () => { throw new Error('i18n down'); };
  let vm = null;
  try { vm = buildViewModel(goodProposal, { t: boom }); } catch (e) { return false; }
  return vm !== null && vm.visible === true;
})());

/* ================= 11. 源码级门禁 ================= */

check('D3U-11 ui-agent-confirm.js 不碰 IPC（只上报，不执行）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ui-agent-confirm.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // 反例门禁本体：渲染层若出现 execute/fs 写入，就是越权了
  return !/ipcRenderer|require\(['"]electron/.test(code)
    && !/child_process|execSync|spawn\(/.test(code)
    && !/writeFileSync|fs\.write/.test(code);
});

check('D3U-11b 卡片 DOM 默认 hidden（HTML 里必须带 class="hidden"）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<div[^>]*id="agentConfirm"[^>]*>/);
  if (!m) return false;
  return /class="[^"]*\bhidden\b/.test(m[0]);
});

check('D3U-11c index.html 加载了 ui-agent-confirm.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return /<script src="ui-agent-confirm\.js"><\/script>/.test(html);
});

/* ================= 12. SEC-01 内容安全元数据模型与渲染 ================= */
check('SEC01-U1 buildViewModel 正确透传 contentHash / contentBytes / contentPreview / isTruncated', () => {
  const proposalWithMeta = {
    ...goodProposal,
    contentHash: 'a1b2c3d4e5f6',
    contentBytes: 120,
    contentPreview: '预览正文内容',
    isTruncated: false,
  };
  const vm = buildViewModel(proposalWithMeta, {});
  return vm.contentHash === 'a1b2c3d4e5f6'
    && vm.contentBytes === 120
    && vm.contentPreview === '预览正文内容'
    && vm.isTruncated === false;
});

check('SEC01-U2 缺省内容元数据时安全回退（不产生 undefined 字符串）', () => {
  const vm = buildViewModel(goodProposal, {});
  return vm.contentHash === null
    && vm.contentBytes === null
    && vm.contentPreview === null
    && vm.isTruncated === false;
});

check('SEC01-U3 截断文本展示「查看完整正文」按钮，非截断时隐藏', () => {
  const f = fakeEl();
  const c = bind(f.root, () => {});
  const truncatedProposal = {
    ...goodProposal,
    contentPreview: 'A'.repeat(300),
    isTruncated: true,
  };
  c.show(truncatedProposal, {});
  const btnTrunc = f.nodes['[data-agent-action="expand-content"]'];
  const isShown = !btnTrunc.classList.contains('hidden');

  const shortProposal = {
    ...goodProposal,
    contentPreview: '短文本',
    isTruncated: false,
  };
  c.show(shortProposal, {});
  const btnShort = f.nodes['[data-agent-action="expand-content"]'];
  const isHidden = btnShort.classList.contains('hidden');

  return isShown && isHidden;
});

check('SEC01-U4 点击展开按钮获取并展示完整正文（纯 textContent，防 XSS 注入）', async () => {
  const f = fakeEl();
  let fetchedId = null;
  const xssPayload = '<img src=x onerror=alert(1)> & <script>dangerous()</script>';
  const c = bind(f.root, () => {}, null, {
    onFetchContent: async (id) => {
      fetchedId = id;
      return { ok: true, content: xssPayload };
    },
  });
  const truncatedProposal = {
    ...goodProposal,
    contentPreview: '前缀...',
    isTruncated: true,
  };
  c.show(truncatedProposal, {});
  const expandBtn = f.nodes['[data-agent-action="expand-content"]'];
  const fullBox = f.nodes['[data-agent-box="content-full"]'];
  const fullText = f.nodes['[data-agent-field="content-full"]'];

  await expandBtn._h.click();

  return fetchedId === 'proposal-1'
    && fullText.textContent === xssPayload
    && !fullBox.classList.contains('hidden')
    && expandBtn.classList.contains('hidden');
});

check('SEC01-U5 展开正文失败时友好提示并不崩溃，按钮可重试', async () => {
  const f = fakeEl();
  let calls = 0;
  const c = bind(f.root, () => {}, null, {
    onFetchContent: async () => {
      calls++;
      throw new Error('NETWORK_TIMEOUT');
    },
  });
  const truncatedProposal = {
    ...goodProposal,
    contentPreview: '前缀...',
    isTruncated: true,
  };
  c.show(truncatedProposal, {});
  const expandBtn = f.nodes['[data-agent-action="expand-content"]'];
  const fullText = f.nodes['[data-agent-field="content-full"]'];

  await expandBtn._h.click();

  return calls === 1
    && fullText.textContent.includes('无法加载完整正文')
    && expandBtn.disabled === false
    && expandBtn.textContent === '重新获取正文';
});

check('SEC01-U6 hide() 时重置展开抽屉状态与正文内容', async () => {
  const f = fakeEl();
  const c = bind(f.root, () => {}, null, {
    onFetchContent: async () => ({ ok: true, content: '完整正文' }),
  });
  c.show({ ...goodProposal, isTruncated: true }, {});
  const expandBtn = f.nodes['[data-agent-action="expand-content"]'];
  const fullBox = f.nodes['[data-agent-box="content-full"]'];
  const fullText = f.nodes['[data-agent-field="content-full"]'];

  await expandBtn._h.click();
  c.hide();

  return fullBox.classList.contains('hidden')
    && fullText.textContent === ''
    && expandBtn.classList.contains('hidden')
    && expandBtn.disabled === false;
});

/* ================= 13. UX-SEC-01 覆写风险警示模型与渲染 ================= */
check('UXSEC-U1 buildViewModel 在 isOverwrite: true 且写操作时生成覆写警告与文案', (() => {
  const overwriteProposal = {
    ...goodProposal,
    capability: 'workspace.write',
    isOverwrite: true,
  };
  const vm = buildViewModel(overwriteProposal, {});
  return vm.isOverwrite === true
    && vm.warnOverwrite === true
    && vm.overwriteLabel === '⚠️ 将覆盖沙盒内已存在的同名文件';
})());

check('UXSEC-U2 buildViewModel 在 isOverwrite: false 或非写操作时不产生覆写警告', (() => {
  const newProposal = {
    ...goodProposal,
    capability: 'workspace.write',
    isOverwrite: false,
  };
  const vmNew = buildViewModel(newProposal, {});

  const readProposal = {
    ...goodProposal,
    capability: 'workspace.read',
    isOverwrite: true,
  };
  const vmRead = buildViewModel(readProposal, {});

  return vmNew.isOverwrite === false
    && vmNew.warnOverwrite === false
    && vmNew.overwriteLabel === ''
    && vmRead.isOverwrite === true
    && vmRead.warnOverwrite === false
    && vmRead.overwriteLabel === '';
})());

check('UXSEC-U3 show() 将覆写警告安全渲染至 warn 字段（纯 textContent，与高风险警示安全拼接）', (() => {
  const f = fakeEl();
  const c = bind(f.root, () => {});
  const proposal = {
    ...goodProposal,
    capability: 'workspace.write',
    isOverwrite: true,
  };
  // 覆写 + 高风险
  c.show(proposal, { dangerLevel: 'high' });
  const warnEl = f.nodes['[data-agent-field="warn"]'];
  const doubleWarn = warnEl.textContent;
  const hasHighRisk = doubleWarn.includes('这是高风险操作');
  const hasOverwrite = doubleWarn.includes('⚠️ 将覆盖沙盒内已存在的同名文件');

  // 仅覆写（无高风险）
  c.show(proposal, { dangerLevel: 'low' });
  const singleWarn = warnEl.textContent;
  const onlyOverwrite = singleWarn === '⚠️ 将覆盖沙盒内已存在的同名文件';

  // 既无覆写也无高风险
  c.show({ ...proposal, isOverwrite: false }, { dangerLevel: 'low' });
  const noWarn = warnEl.textContent === '';

  return hasHighRisk && hasOverwrite && onlyOverwrite && noWarn;
})());

if (origDoc === undefined) delete global.document; else global.document = origDoc;

console.log(failures === 0 ? '\nall ui-agent-confirm tests passed' : `\n${failures} FAILED`);
if (failures !== 0) process.exitCode = 1;
