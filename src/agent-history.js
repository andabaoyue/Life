/**
 * 动作史投影（第 2 步）—— 把审计与观察记录投影成「她自己的动作史」。
 *
 * ## 这个模块解决什么
 *   她做过什么，`agent-audit.jsonl` 里全有，但那是**给我们排查用的**，她读不到。
 *   本模块把它投影成她读得到的事实，供 `askForSelf*` 独立调用时注入。
 *
 * ## 为什么是纯函数（不读盘、不写盘）
 *   数据由调用方读好传进来，单测可以喂构造数据，不必造环境。
 *   **D-27 那轮栽过一次「测的是模块行为、不是接线」**，纯函数 + 接线断言才是正解。
 *
 * ## 三个关键判据（每一条都有实测依据，改之前请先看 2026-11-01 的方案）
 *
 * ### ① 来源必须从 `propose-action` 取，不能从 `execute` 取
 *   实测 4 条 `agent:execute` 记录里，`proposalSource` 出现 **0 次**；
 *   而 3 条 `agent:propose-action` 里出现 3 次。
 *   ⇒ 必须按 `proposalId` 把两边**配对**，来源取前者。
 *
 * ### ② 必须按 `proposalId` 聚合，不能按单条记录投影
 *   实测那条 `ALREADY_EXECUTED` 是 D-19 事故化石（selfNote 本该免确认却亮了卡，
 *   用户点【授权】→ 执行器回 ALREADY_EXECUTED）。按单条投影会写成
 *   「你又被拒了一次」——**那是错的，不是她判断失败**。
 *
 * ### ③ 只收她自己的动作
 *   `proactive-offer`（调度）、`chat-failed`（系统故障）、
 *   `agent:confirm-action`（**用户**的操作）一律剔除。
 *   混着喂等于让她把系统噪音当成自己的经历。
 */

/** 一条链的终局。`executed` 与 `failed` 都算「她的动作」；`rejected` 单独看。 */
const FINAL_EXECUTED = 'executed';
const FINAL_FAILED = 'failed';
const FINAL_REJECTED = 'rejected';

/** 只有这两种来源算「她自发的动作」。`user` 是用户吩咐的，不进她的动作史。 */
const SELF_SOURCES = Object.freeze(['selfNote', 'observerJournal']);

/** 系统噪音：这些 rejected 不是她的判断失误。 */
const NOISE_REJECT_CODES = Object.freeze(['ALREADY_EXECUTED']);

/**
 * 把审计记录投影成「她的动作链」。
 *
 * @param {Array<object>} auditRecords 审计记录（调用方用 `AuditLog.readAll()` 读好传入）
 * @returns {Array<object>} 每条 = 一个 proposalId 的最终事实
 */
function projectProposalChains(auditRecords) {
  const list = Array.isArray(auditRecords) ? auditRecords : [];

  /* 第一遍：按 proposalId 建链。
   *   ⚠️ 用 Map 而不是对象：proposalId 是外部字符串，用对象有原型污染面
   *      （`__proto__` / `constructor` 这类键）。 */
  const chains = new Map();

  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const id = typeof rec.proposalId === 'string' ? rec.proposalId : '';
    if (!id) continue;

    const channel = String(rec.channel || '');
    const outcome = String(rec.outcome || '');

    // 只有这两类 channel 与动作史有关；其余（proactive-offer / chat-failed）直接跳过
    if (channel !== 'agent:propose-action' && channel !== 'agent:execute') continue;

    let chain = chains.get(id);
    if (!chain) {
      chain = {
        proposalId: id,
        proposalSource: null,   // 只在 propose-action 上有
        intentKind: null,
        scopeName: '',
        at: null,               // 建案时刻
        final: null,            // executed / failed / rejected
        finalAt: null,
        rejectCode: null,
      };
      chains.set(id, chain);
    }

    if (channel === 'agent:propose-action') {
      // 只认 accepted 的建案；其余 outcome 不构成「她发起过一件事」
      if (outcome !== 'accepted') continue;
      if (chain.proposalSource == null && typeof rec.proposalSource === 'string') {
        chain.proposalSource = rec.proposalSource;
      }
      if (chain.intentKind == null && typeof rec.intentKind === 'string') {
        chain.intentKind = rec.intentKind;
      }
      // scope 只留 basename：完整绝对路径不该进她的意识（与 D-13 同款纪律）
      if (!chain.scopeName && typeof rec.scope === 'string' && rec.scope) {
        chain.scopeName = String(rec.scope).replace(/\\/g, '/').split('/').pop().slice(0, 120);
      }
      if (chain.at == null && Number.isFinite(rec.at)) chain.at = rec.at;
      continue;
    }

    // channel === 'agent:execute'
    if (outcome === FINAL_EXECUTED || outcome === FINAL_FAILED || outcome === FINAL_REJECTED) {
      /* ⚠️ 覆盖规则：**executed 优先**。
       *
       *   实测那条链是 `executed → rejected(ALREADY_EXECUTED)`：
       *   先真的写成了，用户再点一次授权才被拦。
       *   若按「最后一条覆盖」，它会被记成 rejected —— 事实是她写成了。
       *   ⇒ executed 一旦出现就不再被后续覆盖。 */
      if (chain.final === FINAL_EXECUTED) continue;
      chain.final = outcome;
      chain.finalAt = Number.isFinite(rec.at) ? rec.at : null;
      chain.rejectCode = outcome === FINAL_REJECTED
        ? (typeof rec.code === 'string' ? rec.code : null)
        : null;
    }
  }

  return [...chains.values()];
}

/**
 * 把链投影成「她自己的动作史」。
 *
 * @param {Array<object>} auditRecords 审计记录
 * @param {Array<object>} observationRecords 观察记录（observe 档产生，可能为空）
 * @param {object} [opts]
 * @param {number} [opts.limit=20] 最多保留多少条（按时间取最近的）
 * @returns {{recent: Array<object>, truncated: boolean}}
 */
function projectOwnActions(auditRecords, observationRecords, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 20;
  const actions = [];

  for (const chain of projectProposalChains(auditRecords)) {
    // 判据①：只收她自发的（来源取自 propose-action，见文件头 ①）
    if (!SELF_SOURCES.includes(chain.proposalSource)) continue;

    // 判据②：系统噪音剔除（ALREADY_EXECUTED 不是她的判断失误）
    if (chain.final === FINAL_REJECTED) {
      if (chain.rejectCode == null || NOISE_REJECT_CODES.includes(chain.rejectCode)) continue;
    }

    // 没有终局的链（建案了但从没执行过）也如实记——她确实发起过
    let kind;
    if (chain.final === FINAL_EXECUTED) kind = 'written';
    else if (chain.final === FINAL_FAILED) kind = 'failed';
    else if (chain.final === FINAL_REJECTED) kind = 'refused';
    else kind = 'proposed';

    actions.push({
      at: chain.finalAt != null ? chain.finalAt : chain.at,
      kind,
      name: chain.scopeName || '',
      intentKind: chain.intentKind,
    });
  }

  /* 观察记录：标记为「没有落成」。
   *   ⚠️ 刻意**不存正文**、不存 contentChars —— 只记「有过这么一次」这个事实。
   *      正文在 agent-observations.jsonl 里，她真要回看是第 3 步的事。 */
  const obsList = Array.isArray(observationRecords) ? observationRecords : [];
  for (const obs of obsList) {
    if (!obs || typeof obs !== 'object') continue;
    const at = Number.isFinite(obs.at) ? obs.at : null;
    if (at == null) continue;   // 没有时刻的记录不进动作史（无法排序）
    actions.push({
      at,
      kind: 'observed',
      name: '',
      intentKind: typeof obs.intentKind === 'string' ? obs.intentKind : null,
    });
  }

  // 按时间升序（最近的在后）；同刻用 kind 做稳定次序，避免顺序随读盘抖动
  actions.sort((a, b) => {
    const d = (a.at || 0) - (b.at || 0);
    if (d !== 0) return d;
    return String(a.kind).localeCompare(String(b.kind));
  });

  const truncated = actions.length > limit;
  const recent = truncated ? actions.slice(-limit) : actions;
  return { recent, truncated };
}

/**
 * 把投影结果渲染成她能读的自然语言。
 *
 * ## 三条纪律（每条都是产品判断，不是文风偏好）
 *
 * ### ① 只陈述事实，不给聚合数字
 *   「写成 2 次 / 没落成 8 次」这种**可比较的数字对是指标化**——
 *   最容易让模型产生「我得提高成功率」的念头，进而改变行为。
 *   ⇒ 只给逐条事实，**不给合计**。
 *
 * ### ② 不写绝对时间
 *   不出现日期钟点（与 `WANT_TO_LEAVE_SYS` 铁律一致：她不知道现在几点）。
 *   用「最近」这类定性表述。
 *
 * ### ③ 不作为判断指令
 *   不给「所以你应该……」的结论。她拿这些事实干什么，她自己决定。
 *
 * @param {{recent: Array<object>, truncated: boolean}} history
 * @returns {string} 空字符串表示没有可注入的内容
 */
function renderHistory(history) {
  const recent = history && Array.isArray(history.recent) ? history.recent : [];
  if (!recent.length) return '';

  const lines = [];
  for (const a of recent) {
    if (!a || typeof a !== 'object') continue;
    const name = typeof a.name === 'string' && a.name ? a.name : '';

    if (a.kind === 'written') {
      lines.push(name ? '- 你写过 ' + name : '- 你写过一点东西');
    } else if (a.kind === 'failed') {
      // ⚠️ 不写具体错误码：那是程序内部状态，不是她的经历
      lines.push(name ? '- 有一次你想写 ' + name + '，但没有写成' : '- 有一次你想写点什么，但没有写成');
    } else if (a.kind === 'refused') {
      lines.push('- 有一次你想写，但没有落成');
    } else if (a.kind === 'proposed') {
      lines.push(name ? '- 你想写 ' + name + '，后来没走到落成那一步' : '- 你有过一次想写的念头，后来没走到落成那一步');
    } else if (a.kind === 'observed') {
      // 聚合成一句，避免刷屏（观察记录可能很多条）
      lines.push('- 有几次你想写点什么，当时还没有开放落成文件');
    }
  }

  if (!lines.length) return '';

  // observed 可能重复多行 —— 去重后保持原顺序
  const seen = new Set();
  const unique = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    unique.push(l);
  }

  return '【你最近做过的事】\n' + unique.join('\n');
}

module.exports = {
  projectOwnActions,
  renderHistory,
  // 导出判据常量：让门禁能直接测边界，而不只是通过「跑一遍看结果」间接观察
  SELF_SOURCES,
  NOISE_REJECT_CODES,
  FINAL_EXECUTED,
  FINAL_FAILED,
  FINAL_REJECTED,
};
