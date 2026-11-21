'use strict';

/**
 * v2.0-a：Agent 统一决策入口（Router）。
 *
 * 定位与边界：
 *   1. 只做三件事：单一消费约束、统一事件分派、统一决策快照（为 v2.0-b Ticket/Mandate 预留）。
 *   2. 刻意不搬运 tryBuildProposalFromIntent / maybeAskForSelfNote / maybeAskForObserverJournal 的函数体，
 *      也不下沉 mode === 'off' / markObserveEpoch / 配额探针，避免破坏既有记账顺序与源码兼容断言。
 *   3. 第一层快筛只看“物理沙盒是否可用”（无副作用）：不可用时直接短路，不触发下游拟稿调用（零 LLM 消耗）。
 */

const ROUTER_DECISION_KINDS = Object.freeze(['accept', 'stop', 'ignore', 'unavailable']);
const ROUTER_EVENT_KINDS = Object.freeze(['turn_chat', 'proactive_idle', 'window_closed']);
/**
 * 强度取值**只认原型 policy.ts 的两档**（见 docs/v2.0-AGENT-ARCHITECTURE-PROPOSAL.md §1.1）。
 * 刻意不发明第三档：v2.0-b 的 Mandate 要直接吃这个字段，
 * 自造值（如 'soft' / 'none'）会在那一期变成必须迁移的技术债。
 * 不适用时用 null —— 「没有强度」与「弱强度」不是一回事，别用假值假装有信息。
 */
const ROUTER_STRENGTHS = Object.freeze(['explicit', 'inferred']);

function makeDecision({
  kind,
  eventKind = null,
  strength = null,
  capability = null,
  logicalCap = null,
  mode = null,
  reasonCode,
  detail = null,
}) {
  return Object.freeze({
    ts: Date.now(),
    kind,
    eventKind,
    strength: ROUTER_STRENGTHS.includes(strength) ? strength : null,
    capability,
    logicalCap,
    mode,
    reasonCode,
    detail,
  });
}

function defaultLogicalCapFor(eventKind) {
  if (eventKind === 'proactive_idle') return 'selfNote';
  if (eventKind === 'window_closed') return 'observerJournal';
  return null;
}

/**
 * 判断 L1 物理沙盒门禁是否放行（无副作用）。
 * sandboxUnavailable 可为非空错误码字符串或布尔值 true。
 */
function isSandboxReady(deps) {
  if (!deps || !deps.agentSandbox) return false;
  if (deps.sandboxUnavailable) return false;
  return true;
}

/**
 * 创建 Agent Router 实例；测试与主进程共用。
 */
function createAgentRouter(options = {}) {
  const maxDecisions = Math.max(1, Number(options.maxDecisions) || 64);
  const recentDecisions = [];

  function record(decision, deps) {
    recentDecisions.push(decision);
    if (recentDecisions.length > maxDecisions) {
      recentDecisions.splice(0, recentDecisions.length - maxDecisions);
    }
    if (deps && typeof deps.onDecision === 'function') {
      try { deps.onDecision(decision); } catch (_) {}
    }
    return decision;
  }

  /**
   * 统一处理对话收尾 / 空闲触发 / 关窗轮转三类 Agent 决策事件。
   *
   * @param {{ kind: 'turn_chat'|'proactive_idle'|'window_closed', trigger?: object, windowCloseRes?: object }} event
   * @param {{ agentSandbox?: string|null, sandboxUnavailable?: string|boolean|null, handlers?: object, onDecision?: Function }} deps
   */
  function handleEvent(event, deps) {
    const evt = event && typeof event === 'object' ? event : {};
    const eventKind = evt.kind;
    if (!ROUTER_EVENT_KINDS.includes(eventKind)) {
      return record(makeDecision({
        kind: 'ignore',
        eventKind: typeof eventKind === 'string' ? eventKind : null,
        reasonCode: 'UNKNOWN_EVENT',
      }), deps);
    }

    const logicalCap = defaultLogicalCapFor(eventKind);

    // L1 快筛（无副作用）：沙盒未就绪或初始化失败时直接短路，不调下游也不记 observe 纪元
    if (!isSandboxReady(deps)) {
      const reasonCode = (deps && deps.sandboxUnavailable)
        ? 'SANDBOX_UNAVAILABLE'
        : 'SANDBOX_MISSING';
      return record(makeDecision({
        kind: 'unavailable',
        eventKind,
        logicalCap,
        reasonCode,
        detail: (deps && deps.sandboxUnavailable) ? String(deps.sandboxUnavailable) : null,
      }), deps);
    }

    const handlers = (deps && deps.handlers) || {};

    if (eventKind === 'turn_chat') {
      // 同现行顺序严格一致：
      // 1) tryBuildProposalFromIntent() 在同步段内单一消费并清空 brain._pendingAgentIntent；
      // 2) maybeAskForSelfNote(null) 显式传 null，绝不回落重读 _pendingAgentIntent，
      //    从结构上消灭“两路共读同一字段靠没有 kind 字段凑巧不重入”的隐患。
      //
      // 🔴 D-11 / D-15 的三个刻意选择（v2.0-a 前位于 main.js 的 chat-send 收尾，随调用点迁到这里）：
      //   1. **不 await**（`void` 起独立 promise）—— 她那句话已经说完了，
      //      留下东西是旁路，绝不能让用户多等一次 LLM 往返；
      //   2. **只在 wantToLeaveSomething 时跑** —— 该意图阈值（静默 120 分钟）
      //      远高于 idleness 两档，绝大部分主动搭话根本走不到这里
      //      （具体判定仍由 maybeAskForSelfNote 内的 `intent.kind` 守卫负责，此处不做二次判定）；
      //   3. **失败静默** —— 她说不出 / 不想留 / 调用出错都是 null，不建案。
      //      「她说不想留」是**合法结果**，不是错误（见 brain.askForSelfNote 判据 1）。
      //   D-15 修断点 2：原来 `if (!proactive)` 把自发愿望整个排除在外；
      //   现在 proactive 走 proactive_idle 分支传 trigger.selfIntent。
      if (typeof handlers.tryBuildProposalFromIntent === 'function') {
        void handlers.tryBuildProposalFromIntent();
      }
      if (typeof handlers.maybeAskForSelfNote === 'function') {
        handlers.maybeAskForSelfNote(null);
      }
      return record(makeDecision({
        kind: 'accept',
        eventKind,
        strength: 'explicit',   // turn_chat = 用户这一轮明确提出的话题，对应原型 explicit
        reasonCode: 'DISPATCHED_TURN_CHAT',
      }), deps);
    }

    if (eventKind === 'proactive_idle') {
      const selfIntent = (evt.trigger && evt.trigger.selfIntent) || null;
      if (typeof handlers.maybeAskForSelfNote === 'function') {
        handlers.maybeAskForSelfNote(selfIntent);
      }
      return record(makeDecision({
        kind: 'accept',
        eventKind,
        strength: 'inferred',   // 挂机自发，无人明确要求，对应原型 inferred
        logicalCap,
        reasonCode: 'DISPATCHED_PROACTIVE_IDLE',
      }), deps);
    }

    // window_closed
    if (typeof handlers.maybeAskForObserverJournal === 'function') {
      handlers.maybeAskForObserverJournal(evt.windowCloseRes);
    }
    return record(makeDecision({
      kind: 'accept',
      eventKind,
      strength: 'inferred',   // 关窗轮转由程序触发，非人明确提出
      logicalCap,
      reasonCode: 'DISPATCHED_WINDOW_CLOSED',
    }), deps);
  }

  return {
    handleEvent,
    getRecentDecisions: () => recentDecisions.slice(),
  };
}

const defaultRouter = createAgentRouter();

module.exports = {
  ROUTER_DECISION_KINDS,
  ROUTER_EVENT_KINDS,
  createAgentRouter,
  handleEvent: defaultRouter.handleEvent,
  getRecentDecisions: defaultRouter.getRecentDecisions,
};
