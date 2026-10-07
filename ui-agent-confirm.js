/**
 * ui-agent-confirm.js — D-3 第四道闸门的渲染层：用户确认卡片
 *
 * 设计原则（沿用 ui-chat-store 的分层）：**纯逻辑与 DOM 分离**。
 *   buildViewModel() 是纯函数，可被Node 单测直接验证，不需要浏览器。
 *   render() 只负责把 viewModel 写进 DOM。
 * 这样「卡片在什么情况下该出现」这条安全规则才能被门禁覆盖 ——
 * 写成 if/else 混在 DOM 操作里时，没法测。
 *
 * 🔴 头号不变式：**没有待确认提案时，卡片绝不出现在 DOM 里。**
 *   这不是审美问题：桌宠常驻桌面，一个凭空出现的确认框会被当成系统弹窗，
 *   久而久之用户会闭眼点【授权】—— 那这道闸门就白设了。
 *   所以 show() 只在有真实提案时把 hidden 摘掉，且卡片默认就是 hidden。
 *
 * 边界：本模块**不执行任何动作**，confirm 回调由外部注入（通常是 pet.js 接 window.deskpet.agent）。
 * 它连 IPC 都不碰 —— 渲染层只负责"把用户的点击如实上报"。
 */

/** 危险等级 → 展示用的严重度。渲染层不自己判断危险度，只映射主进程给的定级。 */
const DANGER_LABEL = {
  low: { key: 'agent.danger.low', fallback: '低风险' },
  medium: { key: 'agent.danger.medium', fallback: '中风险' },
  high: { key: 'agent.danger.high', fallback: '高风险' },
  unknown: { key: 'agent.danger.unknown', fallback: '未定级' },
};

/** 决策值。必须与 src/agent-confirmation.js 的 DECISIONS 逐字一致 —— 不同则后端会拒。 */
const DECISIONS = Object.freeze(['approved', 'rejected']);

/** scope 展示时截断：路径可能很长，全量渲染会把卡片撑破。 */
const SCOPE_MAX = 120;

function truncate(s, max) {
  const v = String(s === null || s === undefined ? '' : s);
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
}

/**
 * 能力名的展示映射。刻意只认白名单里的几个 —— 未登记的能力名**原样显示**而不是
 * 美化成"友好名称"，因为未知能力名本身就值得用户警惕。
 */
function labelForCapability(capability) {
  const c = String(capability || '');
  const map = {
    'workspace.read': { key: 'agent.cap.read', fallback: '读取文件' },
    'workspace.write': { key: 'agent.cap.write', fallback: '写入文件' },
    'process.execute': { key: 'agent.cap.exec', fallback: '执行命令' },
    'network.request': { key: 'agent.cap.net', fallback: '网络请求（已封禁）' },
  };
  const hit = map[c];
  return hit ? { key: hit.key, fallback: hit.fallback } : { key: null, fallback: c || '(未指明能力)' };
}

/**
 * 文案取值：i18n 挂了就退回 fallback。
 * 🔴 为什么必须兜：t() 是从页面全局拿的引用，它抛错（表未加载/被打包裁剪/未来改签名）
 *   不该让**确认卡片整个炸掉** —— 那是安全闸门的UI，炸了等于闸门失效。
 *   界面上出现 fallback 文案远好过出现空白卡片或异常。
 */
function safeT(t) {
  if (typeof t !== 'function') return (k, f) => f;
  return (k, f) => {
    try {
      const v = t(k, f);
      return (v === undefined || v === null || v === '') ? f : v;
    } catch (e) {
      return f;
    }
  };
}

/**
 * 构造卡片的 view model。纯函数，无副作用。
 *
 * @param {object|null} proposal 提案快照（来自 agent:propose-action）
 * @param {object} opts
 * @param {function} opts.t            i18n 取值函数（可传 null → 全部走 fallback）
 * @param {object}  opts.budget        ExecutionBudget.state()
 * @returns {object} viewModel
 */
function buildViewModel(proposal, opts = {}) {
  const t = safeT(opts.t);

  // 🔴 不变式 1：没有提案就没有卡片。
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { visible: false, reason: 'NO_PROPOSAL' };
  }
  const capability = String(proposal.capability || '');
  if (!capability) return { visible: false, reason: 'NO_CAPABILITY' };

  const proposalId = String(proposal.id || '');
  if (!proposalId) return { visible: false, reason: 'NO_PROPOSAL_ID' };

  const budget = opts.budget && typeof opts.budget === 'object' ? opts.budget : {};
  // 熔断是终态：预算耗尽时不该再展示可点的确认卡片 —— 点了也会被主进程拒，
  // 只会让用户以为自己点成功了。所以这里直接把卡片置为不可操作。
  const tripped = budget.tripped === true;
  const reason = String(budget.tripReason || '');

  const capLabel = labelForCapability(capability);
  const danger = DANGER_LABEL[String(opts.dangerLevel || 'unknown')] || DANGER_LABEL.unknown;

  return {
    visible: true,
    proposalId,
    capability,
    capabilityLabel: capLabel.fallback,
    capabilityLabelKey: capLabel.key,
    dangerLevel: String(opts.dangerLevel || 'unknown'),
    dangerLabel: danger.fallback,
    dangerLabelKey: danger.key,
    // 高风险必须显式警示，不能只靠一个小标签。
    warnHighRisk: String(opts.dangerLevel) === 'high',
    scope: truncate(proposal.scope, SCOPE_MAX),
    scopeTruncated: String(proposal.scope || '').length > SCOPE_MAX,
    reason: truncate(proposal.reason || t('agent.reason.empty', '（未说明理由）'), 200),
    budget: {
      tripped,
      tripReason: reason,
      tripLabel: tripped ? t('agent.budget.tripped', '执行预算已耗尽，无法执行任何动作') : '',
      remainingActions: Number.isFinite(budget.remainingActions) ? budget.remainingActions : null,
    },
    actions: tripped
      // 熔断时**不给可点的按钮** —— 给一个必然失败的按钮是在骗用户。
      ? []
      : [
        { decision: 'approved', label: t('agent.action.approve', '授权'), primary: true },
        { decision: 'rejected', label: t('agent.action.reject', '拒绝'), primary: false },
      ],
  };
}

/**
 * 绑定到 DOM。返回一个小控制器，供外部 show/hide。
 *
 * @param {object} el   卡片根元素
 * @param {function} onDecision (decision, proposalId) => void|Promise
 * @param {function} t     i18n
 */
function bind(el, onDecision, t) {
  if (!el) return { show() { return false; }, hide() {}, isVisible() { return false; } };

  // 🔴 t 可能不传（调用方疏忽、测试替身、单测里只想验 DOM 行为）。
  //   buildViewModel 内部已做safeT 兜底，但 show() 自己也在用 t ——
  //   漏掉这一处就会「t is not a function」直接崩掉整个卡片。
  //   安全红线不该依赖调用方自觉。
  const tr = safeT(t);

  let current = null;          // 当前展示的 viewModel
  let busy = false;            // 决策上报中：防连点导致重复确认

  function hide() {
    current = null;
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  }

  function show(proposal, opts = {}) {
    const vm = buildViewModel(proposal, Object.assign({ t: tr }, opts));
    if (!vm.visible) { hide(); return false; }
    current = vm;

    const set = (sel, text) => {
      const n = el.querySelector(sel);
      if (n) n.textContent = text;
    };
    set('[data-agent-field="capability"]', vm.capabilityLabel);
    set('[data-agent-field="danger"]', vm.dangerLabel);
    set('[data-agent-field="scope"]', vm.scope);
    set('[data-agent-field="reason"]', vm.reason);
    set('[data-agent-field="budget"]',
      vm.budget.tripped
        ? vm.budget.tripLabel
        : (typeof vm.budget.remainingActions === 'number'
          ? tr('agent.budget.remaining', '剩余可用动作：') + vm.budget.remainingActions
          : ''));
    set('[data-agent-field="warn"]',
      vm.warnHighRisk ? tr('agent.warn.highRisk', '这是高风险操作，请确认你要改动的确实是这个目标。') : '');
    if (typeof el.querySelectorAll === 'function') {
      const keys = el.querySelectorAll('.ac-key');
      if (keys && keys.length >= 3) {
        keys[0].textContent = tr('agent.label.scope', '目标');
        keys[1].textContent = tr('agent.label.reason', '理由');
        keys[2].textContent = tr('agent.label.budget', '预算');
      }
    }

    // 按钮按 vm.actions 动态生成 —— 熔断时 actions 为空，卡片就只有说明没有按钮。
    const box = el.querySelector('[data-agent-actions]');
    if (box) {
      box.textContent = '';
      for (const a of vm.actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'agent-btn' + (a.primary ? ' agent-btn-primary' : '');
        b.textContent = a.label;
        b.addEventListener('click', async () => {
          // 🔴 反例防线：连点防护。重复确认会被主进程当重放拒掉，
          //   但那时用户看到的是"点了没反应"，体验比直接禁用更糟。
          if (busy || !current) return;
          busy = true;
          el.classList.add('agent-busy');
          try {
            if (typeof onDecision === 'function') await onDecision(a.decision, current.proposalId);
          } finally {
            busy = false;
            el.classList.remove('agent-busy');
            // 决策已上报，卡片完成使命 —— 留着会让用户以为还能再点。
            hide();
          }
        });
        box.appendChild(b);
      }
    }

    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    return true;
  }

  return { show, hide, isVisible: () => !!current };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildViewModel, bind, DANGER_LABEL, DECISIONS, SCOPE_MAX, safeT };
}

/* 浏览器侧挂全局：与 ui-i18n.js / ui-chat-render.js / ui-outfit-complete.js 同范式
   （顶层 function 声明即全局，不额外挂 window.AgentConfirm，避免与 module 导出两套出处）。 */
if (typeof window !== 'undefined') {
  window.AgentConfirm = { buildViewModel, bind, DANGER_LABEL, DECISIONS, SCOPE_MAX, safeT };
}
