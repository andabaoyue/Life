/**
 * v1.0 D-3 第四道闸门：用户显式确认（UserConfirmation）
 *
 * 为什么单独一个模块：C 阶段的五道闸门里，只有这一道**依赖人**。
 * 前面三道（授权/预算/建案）都是纯代码判定，出错最多是逻辑错；
 * 这一道出错的后果是「用户没点头却动了他的文件」，属信任事故。
 *
 * 🔴 三条设计不变式（写死在这里，改动必须同步改 test/agent_confirmation.test.js）：
 * 1. **未确认不得进入执行**：isExecutionAllowed() 是唯一的放行口，
 *    它要求提案必须处于 approved 且确认记录未被篡改。
 * 2. **一次提案只能确认一次**：重复 confirm() 一律拒绝。防的是「重放攻击」——
 *    渲染层或将来接进来的执行器反复拿同一个提案 id 来要授权。
 * 3. **拒绝是终态**：rejected 之后不允许再改approved。
 *    这是「拒绝」这个动作应有的分量 —— 用户点了拒绝就不该被再问一次。
 *
 * 本模块**纯逻辑、零 DOM、零 I/O**。UI 在 ui-agent-confirm.js，IPC 在 agent-ipc.js，
 * 三者互不依赖，便于各自单测。
 */

const crypto = require('crypto');

/** 确认决策的合法取值。注意这里**没有** 'executed' —— 确认与执行是两件事。 */
const DECISIONS = Object.freeze(['approved', 'rejected']);

/** 提案在被确认前允许停留的状态。 */
const PENDING_STATUS = 'proposed';

function nowMs() {
  return Date.now();
}

/** 决策指纹：把「谁、何时、批了什么」绑成一个不可伪造的摘要。
 *  执行前必须重算比对 —— 记录在内存里被改过（bug 或攻击）都会暴露。 */
function decisionFingerprint(decision, proposalId, at) {
  return crypto.createHash('sha256')
    .update(`${decision}|${proposalId}|${at}`, 'utf8')
    .digest('hex');
}

class UserConfirmationGate {
  /**
   * @param {object} opts
   * @param {number} [opts.ttlMs=120000] 确认有效期：超时的确认视为过期。
   *   为什么要有 TTL：用户点【授权】后可能离开电脑，几小时后回来，
   *   上下文早已改变（文件可能已被别人改、理由可能已不成立）。
   *   一个两分钟前的授权不该套在今天的动作上。
   */
  constructor(opts = {}) {
    // 🔴 TTL 必须**双向**设界。只写下界不写下界（Math.max）的后果是：
    // 一旦有人传 ttlMs: Infinity 或 1e18，授权就变成**永久有效** ——
    // 而"用户点头只对当时那个动作有效"恰恰是这道闸门存在的全部意义。
    // 越界值（含负数/Infinity/NaN/字符串）一律**回落默认**而不是夹紧：
    // 夹紧成1 秒会让授权瞬间失效（同样是错的），回落默认是"退回已知可用值"。
    const DEFAULT_TTL = 120000;
    const MIN_TTL = 1000;
    const MAX_TTL = 15 * 60 * 1000;          // 15 分钟硬顶，超出即视为配置写错
    const v = opts.ttlMs;
    // 越界（含 Infinity/NaN/字符串/null）一律回落默认，而不是夹紧：
    // 夹紧成 1 秒会让授权瞬间失效，那同样是错的。
    this.ttlMs = (typeof v === 'number' && Number.isFinite(v) && v >= MIN_TTL && v <= MAX_TTL)
      ? Math.floor(v)
      : DEFAULT_TTL;
    /** @type {Map<string, {proposalId:string, decision:string, at:number, fingerprint:string}>} */
    this.records = new Map();
  }

  /**
   * 登记一次用户决策。
   *
   * 🔴 反例防线 1：decision 必须是 approved/rejected 之一。
   *   'maybe' / '' / null / 大小写变体 一律拒 —— 不能让「未知值」混过确认闸门。
   * 🔴 反例防线 2：proposalId 必须在**待确认状态**，否则重复确认被拒。
   * 🔴 反例防线 3：已确认过的 id 直接拒（重放）。
   *
   * @param {string} proposalId
   * @param {string} decision
   * @param {object} [meta]
   * @param {string} [meta.status]提案当前状态，默认视为 PENDING_STATUS
   * @param {number} [meta.at]    决策时刻（测试可注入）
   * @returns {{ok:true, record:object}|{ok:false, code:string}}
   */
  confirm(proposalId, decision, meta = {}) {
    const id = String(proposalId || '').trim();
    if (!id) return { ok: false, code: 'PROPOSAL_ID_REQUIRED' };

    // 🔴 决策值**不做 trim 容错**：值必须精确等于 'approved' / 'rejected'。
    //   这是跨进程通道，值由本仓自己生成 —— 出现 ' approved ' 说明链路有 bug
    //   或有人在试探边界。宁可全拒，不可替调用方"猜"它想表达什么。
    //   （proposalId 反过来必须 trim：它是标识符，两端空白属无害噪声。）
    const d = String(decision === null || decision === undefined ? '' : decision);
    if (!DECISIONS.includes(d)) return { ok: false, code: 'INVALID_DECISION' };

    const status = String(meta.status || PENDING_STATUS);
    //🔴 先查重放，再查状态。
    //   顺序反了会让「重放」被报成「状态不对」，审计里就看不出这是攻击还是流程问题。
    //   两者都要拒，但**原因码必须能区分**：前者是重放尝试，后者是流程时序错。
    if (this.records.has(id)) {
      return { ok: false, code: 'ALREADY_CONFIRMED', record: this.records.get(id) };
    }
    if (status !== PENDING_STATUS) {
      return { ok: false, code: 'PROPOSAL_NOT_PENDING', status };
    }

    const at = Number.isFinite(meta.at) ? meta.at : nowMs();
    const record = Object.freeze({
      proposalId: id,
      decision: d,
      at,
      fingerprint: decisionFingerprint(d, id, at),
      // 显式落 false：revoke() 会把它翻成 true。字段缺失会让
      // 「未作废」与「状态不明」在审计里混同，排查时分不清。
      revoked: false,
      revokeReason: null,
    });
    this.records.set(id, record);
    return { ok: true, record };
  }

  /** 查某提案的决策记录；未确认返回 null。 */
  lookup(proposalId) {
    return this.records.get(String(proposalId || '').trim()) || null;
  }

  /**
   * 主动作废一条授权记录。
   *
   * 🔴 为什么需要这个方法（2026-10-06 加固复核）：
   *   提案被逐出注册表（上界保护）后，「用户点头的内容」已经不存在了，
   *   那条授权**再也无法被核对**。而 isExecutionAllowed 只看records 里的
   *   decision 与指纹，**不关心提案是否还在** —— 于是会拿着一条无法验证的
   *   授权去放行。这比"超时失效"更糟：超时至少是显式、可解释的。
   *   所以逐出提案时必须**同步作废授权**，宁可让授权消失，不留悬空授权。
   *
   * 🔴 一旦 revoked，该 id 记录**保持存在**（不删），这样重复确认仍会命中
   *   ALREADY_CONFIRMED 而不是"凭空再造一条" —— 复用即重放的原不变式不受破坏。
   *
   * ⚠️ 但这只在**提案仍在注册表里**时成立。提案被逐出后，confirm 通道的
   *   存在性校验会**先**拒掉，返回 PROPOSAL_NOT_FOUND 而非 ALREADY_CONFIRMED。
   *   两者都是拒绝，行为上都安全；区别仅在审计追溯时能看出是"重放尝试"
   *   还是"提案已不可核对"。这是刻意的：授权无法核对时不该接受新决策。
   *
   * @param {string} proposalId
   * @param {string} [reason]作废原因，仅供审计追溯
   * @returns {{ok:true, record:object}|{ok:false, code:string}}
   */
  revoke(proposalId, reason = 'REVOKED') {
    const id = String(proposalId || '').trim();
    if (!id) return { ok: false, code: 'PROPOSAL_ID_REQUIRED' };
    const rec = this.records.get(id);
    if (!rec) return { ok: false, code: 'NOT_CONFIRMED' };
    if (rec.revoked) return { ok: false, code: 'ALREADY_REVOKED' };
    const next = Object.freeze({
      proposalId: rec.proposalId,
      decision: rec.decision,
      at: rec.at,
      fingerprint: rec.fingerprint,
      revoked: true,
      revokeReason: String(reason || '').slice(0, 64),
    });
    this.records.set(id, next);
    return { ok: true, record: next };
  }

  /**
   * 唯一执行放行口。
   * 🔴 反例防线 4：四重校验缺一不可 —— 记录存在、未被作废、指纹可重算一致、未过 TTL。
   *   任何一项不过都返回 false，且**附带原因**供审计记「为什么没放行」。
   */
  isExecutionAllowed(proposalId, atMs) {
    const rec = this.records.get(String(proposalId || '').trim());
    if (!rec) return { allowed: false, reason: 'NOT_CONFIRMED' };
    // 🔴 作废优先于一切：被 revoke 的记录哪怕 decision 是 approved、
    //   指纹也没被改、TTL 也还在 —— 一律不放行。
    if (rec.revoked) {
      return { allowed: false, reason: rec.revokeReason || 'AUTHORIZATION_REVOKED' };
    }
    if (rec.decision !== 'approved') return { allowed: false, reason: 'REJECTED_BY_USER' };
    const now = Number.isFinite(atMs) ? atMs : nowMs();
    if (now - rec.at > this.ttlMs) return { allowed: false, reason: 'CONFIRMATION_EXPIRED' };
    const recomputed = decisionFingerprint(rec.decision, rec.proposalId, rec.at);
    if (recomputed !== rec.fingerprint) {
      // 记录在内存里被改过（代码 bug 或攻击）—— 绝不信任，直接拒。
      return { allowed: false, reason: 'DECISION_TAMPERED' };
    }
    return { allowed: true, reason: 'ok', record: rec };
  }

  /**
   * 列出仍待确认的提案 id。
   * 供 UI 判断「要不要显示卡片」—— 无待确认提案时前端应保持零打扰。
   */
  listPending(ids = []) {
    const out = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw || '').trim();
      if (!id) continue;
      if (!this.records.has(id)) out.push(id);
    }
    return out;
  }

  /** 决策总数（给 UI/审计用）。 */
  count() {
    return this.records.size;
  }

  /**
   * 清理过期记录。
   * 为什么要清：records 是常驻内存，用户开一天电脑可能积几百条。
   * 只清**过期的已批准**记录 —— 已拒绝的是终态，保留它是为了
   * 「拒绝过就不能再问」这条不变式在长时间运行后依然成立。
   *
   * ⚠️ 已撤销（revoked）的已批准记录**也会被清掉**（决策仍是 approved）。
   *   这是刻意的取舍：若为它们破例跳过，records 就失去上界，长时间运行
   *   会重新变成内存增长点。代价是逐出原因 PROPOSAL_EVICTED 在审计里丢失，
   *   但清掉后 isExecutionAllowed 返回 NOT_CONFIRMED —— **依然是拒绝**，
   *   不存在「清掉反而放行」的方向性风险。逐出事件本身另有审计日志留痕。
   */
  prune(atMs) {
    const now = Number.isFinite(atMs) ? atMs : nowMs();
    let removed = 0;
    for (const [id, rec] of this.records) {
      if (rec.decision === 'approved' && (now - rec.at) > this.ttlMs) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = { UserConfirmationGate, DECISIONS, PENDING_STATUS, decisionFingerprint };
