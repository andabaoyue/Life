const fs = require('fs');
const path = require('path');

/**
 * 把 intent 给的 hint 净化成一个沙盒内的安全文件名。
 * 规则与 maybeAskForSelfNote 镜像一致，并将扩展名收敛到 ALLOWED_WRITE_EXTENSIONS。
 *
 * @param {string} rawHint 意图里给的文件名（来自用户原话）
 * @param {string} sandboxDir 沙盒绝对路径
 * @returns {?{scope:string, name:string}} null = 这个 hint 不能用于建案
 */
function buildSandboxScope(rawHint, sandboxDir) {
  if (typeof sandboxDir !== 'string' || !sandboxDir) return null;
  const h = String(rawHint == null ? '' : rawHint).trim();
  if (!h) return null;
  if (path.isAbsolute(h)) return null;
  if (/[\\/]/.test(h)) return null;
  if (h === '.' || h === '..') return null;
  if (/\.\./.test(h)) return null;
  if (h.length > 200) return null;
  if (h.includes(':') || h.endsWith('.') || h.endsWith(' ')) return null;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(h.split('.')[0])) return null;

  const WRITABLE = ['.txt', '.md', '.json', '.log'];
  let name = path.basename(h);
  const ext = path.extname(name).toLowerCase();
  if (!WRITABLE.includes(ext)) {
    name = (ext ? name.slice(0, name.length - ext.length) : name) + '.md';
  }
  if (!name || name === '.md') return null;

  return { scope: path.join(sandboxDir, name), name: name };
}

/**
 * v2.0-s1：构造只读提案的沙盒文件路径（不做 `.md` 强改扩展名，保留原名供无扩展名文本探测与 .tsv 读取）。
 * @param {string} rawHint 从用户消息提取的文件名
 * @param {string} sandboxDir 沙盒绝对路径
 * @returns {?{scope:string, name:string}}
 */
function buildReadSandboxScope(rawHint, sandboxDir) {
  if (typeof sandboxDir !== 'string' || !sandboxDir) return null;
  const h = String(rawHint == null ? '' : rawHint).trim();
  if (!h) return null;
  if (path.isAbsolute(h)) return null;
  if (/[\\/]/.test(h)) return null;
  if (h === '.' || h === '..') return null;
  if (/\.\./.test(h)) return null;
  if (h.length > 200) return null;
  if (h.includes(':') || h.endsWith('.') || h.endsWith(' ')) return null;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(h.split('.')[0])) return null;
  const name = path.basename(h);
  if (!name || name.charAt(0) === '.') return null;
  return { scope: path.join(sandboxDir, name), name };
}

/**
 * 创建主进程 Agent 调度、提案构造、自发便签/观察日记旁路与 Ticket 超时转换控制器。
 */
function createMainAgentController(ctx) {
  let agentBuildDeps = null;
  let proactiveAuditLog = null;
  let agentSandboxUnavailable = null;
  const pendingSelfNoteContent = new Map();

  function takeStashedContent(proposalId) {
    const id = String(proposalId || '');
    if (!id || !pendingSelfNoteContent.has(id)) return null;
    const v = pendingSelfNoteContent.get(id);
    pendingSelfNoteContent.delete(id);
    return v;
  }

  function auditProposalRefused(intent, reason, deps, outcome) {
    const sink = (deps && deps.audit && typeof deps.audit.append === 'function')
      ? deps.audit
      : proactiveAuditLog;
    if (!sink) return;
    const oc = (outcome === 'draft_unavailable') ? 'draft_unavailable' : 'refused_by_subject';
    try {
      sink.append({
        channel: 'agent:propose-action',
        outcome: oc,
        capability: 'workspace.write',
        via: 'main',
        hint: String((intent && intent.hint) || '').slice(0, 120) || null,
        reason: String(reason || '').slice(0, 80) || null,
      });
    } catch { /* 审计写不进去也不能挡住建案路径 */ }
  }

  async function tryBuildProposalFromIntent() {
    try {
      const deps = agentBuildDeps;
      const brain = ctx.getBrain();
      if (!deps || !deps.agentIpc || !deps.agentSandbox) return null;
      if (!brain || typeof brain.askForProposalContent !== 'function') return null;

      // 读取即清空：必须同步且在 await 之前
      const intent = brain._pendingAgentIntent;
      if (!intent || intent.shouldPropose !== true) return null;
      brain._pendingAgentIntent = null;

      if (intent.capability !== 'workspace.write') return null;

      const draft = await brain.askForProposalContent(intent);
      const draftStatus = draft && typeof draft.status === 'string' ? draft.status : 'unavailable';

      if (draftStatus === 'refused') {
        auditProposalRefused(intent, draft.reason, deps, 'refused_by_subject');
        console.log('[Agent] 通路 B：她拒绝立项（' + String(draft.reason || '').slice(0, 40) + '），按主体性设计不建案');
        return null;
      }
      if (draftStatus !== 'ok' || typeof draft.content !== 'string' || !draft.content.trim()) {
        auditProposalRefused(intent, String((draft && draft.reason) || 'UNKNOWN').slice(0, 40), deps, 'draft_unavailable');
        console.log('[Agent] 通路 B：拟稿不可用（' + String((draft && draft.reason) || 'unknown').slice(0, 40) + '），不建案');
        return null;
      }

      const built = buildSandboxScope(intent.hint, deps.agentSandbox);
      if (!built) {
        console.log('[Agent] 通路 B：文件名不合格，放弃建案:', String(intent.hint || '').slice(0, 60));
        return null;
      }

      const res = deps.agentIpc.proposeInternal({
        capability: 'workspace.write',
        scope: built.scope,
        reason: intent.reason || '按你的要求整理成文',
        content: draft.content,
      }, 'main');

      if (!res || !res.ok || !res.proposal) {
        console.log('[Agent] 通路 B：建案被拒:', (res && (res.error || res.code)) || 'unknown');
        return null;
      }

      deps.broadcastToWindows('agent-proposal-pending', { proposalId: res.proposal.id });
      console.log('[Agent] 通路 B：她拟好了一份东西，等你决定是否落盘:', String(built.name).slice(0, 60));

      return res.proposal.id;
    } catch (err) {
      return null;
    }
  }

  function maybeAskForSelfNote(selfIntent) {
    try {
      const deps = agentBuildDeps;
      const brain = ctx.getBrain();
      const cfg = ctx.getCfg();
      if (!deps || !deps.agentSandbox) return;
      const intent = selfIntent;
      if (!intent || intent.kind !== 'wantToLeaveSomething') return;

      const mode = ctx.getCapabilityMode(cfg, 'selfNote');
      if (mode === 'off') return;

      try {
        if (brain && brain.memory && typeof brain.memory.markObserveEpoch === 'function') {
          if (mode === 'observe') brain.memory.markObserveEpoch('selfNote', 'in');
          else if (mode === 'auto') brain.memory.markObserveEpoch('selfNote', 'out');
        }
      } catch { /* 记账失败不影响主流程 */ }

      void (async () => {
        try {
          const note = await brain.askForSelfNote({ intentKind: intent.kind });
          if (!note || !note.content) return;

          let rawHint = String(intent.hint == null ? '' : intent.hint).trim();
          if (!rawHint) {
            const d = new Date();
            const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            rawHint = 'note-' + ds + '-' + Math.random().toString(36).slice(2, 6) + '.txt';
          }
          if (path.isAbsolute(rawHint)) return;
          if (/[\\/]/.test(rawHint)) return;
          if (rawHint === '.' || rawHint === '..') return;
          if (/\.\./.test(rawHint)) return;
          if (rawHint.length > 200) return;
          if (rawHint.includes(':') || rawHint.endsWith('.') || rawHint.endsWith(' ') || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(rawHint.split('.')[0])) return;

          const scope = path.join(deps.agentSandbox, rawHint);

          if (mode === 'observe') {
            try {
              if (deps.observationLog && typeof deps.observationLog.append === 'function') {
                deps.observationLog.append({
                  capability: 'selfNote',
                  intentKind: intent.kind,
                  proposalSource: 'selfNote',
                  scopeName: rawHint,
                  content: note.content,
                });
              }
              if (brain && brain.memory && typeof brain.memory.noteObserved === 'function') {
                brain.memory.noteObserved('selfNote');
              }
              console.log('[Agent] 观察档：她想留一张纸条（未落盘）:', String(rawHint).slice(0, 60));
            } catch { /* 观察记录失败绝不能影响别的 */ }
            return;
          }

          const res = typeof deps.agentIpc.proposeInternal === 'function'
            ? deps.agentIpc.proposeInternal(
              { capability: 'workspace.write', scope, reason: intent.reason },
              'main',
              'selfNote',
              note.content
            )
            : null;
          if (res && res.ok && res.proposal) {
            pendingSelfNoteContent.set(res.proposal.id, note.content);

            const exec = typeof deps.agentIpc.executeInternal === 'function'
              ? deps.agentIpc.executeInternal({ proposalId: res.proposal.id })
              : null;
            if (exec && exec.ok) {
              console.log('[Agent] 她自己留下了一张纸条:', String(rawHint).slice(0, 60));
            } else {
              console.log('[Agent] 自发留条未落盘（按设计不告诉她）:', exec && exec.error);
            }
          }
        } catch (err) {
          // 静默
        }
      })();
    } catch (err) {
      // 静默
    }
  }

  function maybeAskForObserverJournal(windowCloseRes) {
    try {
      const deps = agentBuildDeps;
      const brain = ctx.getBrain();
      const cfg = ctx.getCfg();
      if (!deps || !deps.agentSandbox || !deps.agentIpc) return;
      if (!brain || typeof brain.askForObserverJournal !== 'function') return;

      const budget = deps.agentBudget;
      if (budget && typeof budget.state === 'function') {
        const bState = budget.state();
        if (bState.tripped || (typeof bState.remainingWrites === 'number' && bState.remainingWrites <= 0)) {
          return;
        }
      }

      const mode = ctx.getCapabilityMode(cfg, 'observerJournal');
      if (mode === 'off') return;

      try {
        if (brain && brain.memory && typeof brain.memory.markObserveEpoch === 'function') {
          if (mode === 'observe') brain.memory.markObserveEpoch('observerJournal', 'in');
          else if (mode === 'auto') brain.memory.markObserveEpoch('observerJournal', 'out');
        }
      } catch { /* 记账失败不影响主流程 */ }

      const d = new Date();
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      try {
        if (fs.existsSync(deps.agentSandbox)) {
          const files = fs.readdirSync(deps.agentSandbox);
          const hasJournalToday = files.some((f) => f.startsWith(`journal-${ds}`) && f.endsWith('.md'));
          if (hasJournalToday) return;
        }
      } catch (_) {
        return;
      }

      void (async () => {
        try {
          const journal = await brain.askForObserverJournal({
            windowNo: (brain.memory && brain.memory.data && brain.memory.data.windowNo) || 1,
            synthesis: windowCloseRes && windowCloseRes.summaryText
          });
          if (!journal || !journal.content) return;

          const filename = 'journal-' + ds + '-' + Math.random().toString(36).slice(2, 6) + '.md';
          const scope = path.join(deps.agentSandbox, filename);

          if (mode === 'observe') {
            try {
              if (deps.observationLog && typeof deps.observationLog.append === 'function') {
                deps.observationLog.append({
                  capability: 'observerJournal',
                  intentKind: 'observerJournal',
                  proposalSource: 'observerJournal',
                  scopeName: filename,
                  content: journal.content,
                });
              }
              if (brain && brain.memory && typeof brain.memory.noteObserved === 'function') {
                brain.memory.noteObserved('observerJournal');
              }
              console.log('[Agent] 观察档：她想写一篇观察日记（未落盘）:', filename);
            } catch { /* 观察记录失败绝不能影响别的 */ }
            return;
          }

          const res = typeof deps.agentIpc.proposeInternal === 'function'
            ? deps.agentIpc.proposeInternal(
              { capability: 'workspace.write', scope, reason: '生活观察日记' },
              'main',
              'observerJournal',
              journal.content
            )
            : null;

          if (res && res.ok && res.proposal) {
            pendingSelfNoteContent.set(res.proposal.id, journal.content);

            const exec = typeof deps.agentIpc.executeInternal === 'function'
              ? deps.agentIpc.executeInternal({ proposalId: res.proposal.id })
              : null;

            if (exec && exec.ok) {
              console.log('[Agent] 初澜写下了一篇生活观察日记:', filename);
            } else {
              console.log('[Agent] 观察日记未落盘:', exec && exec.error);
            }
          }
        } catch (err) {
          // 静默
        }
      })();
    } catch (err) {
      // 静默
    }
  }

  function routeAgentEvent(event) {
    const deps = agentBuildDeps || {};
    return ctx.agentRouter.handleEvent(event, {
      agentSandbox: deps.agentSandbox || null,
      sandboxUnavailable: agentSandboxUnavailable || deps.sandboxUnavailable || null,
      handlers: {
        tryBuildProposalFromIntent,
        maybeAskForSelfNote,
        maybeAskForObserverJournal,
      },
    });
  }

  function syncExpiredProposalsToTickets(now = Date.now()) {
    try {
      const deps = agentBuildDeps;
      const brain = ctx.getBrain();
      if (!deps || !deps.agentIpc || typeof deps.agentIpc.drainExpiredPendingWriteProposals !== 'function') return [];
      if (!brain || !brain.ticketStore || typeof brain.ticketStore.createTicket !== 'function') return [];
      const expired = deps.agentIpc.drainExpiredPendingWriteProposals(now);
      if (!Array.isArray(expired) || expired.length === 0) return [];
      const winNo = (brain.memory && brain.memory.data && Number.isFinite(brain.memory.data.windowNo))
        ? brain.memory.data.windowNo
        : 1;
      const created = [];
      for (const item of expired) {
        if (!item || !item.name) continue;
        const res = brain.ticketStore.createTicket({
          title: item.name,
          state: 'paused',
          capability: 'workspace.write',
          note: '有一份没落的稿子，搁在那儿',
          windowNo: winNo,
        });
        if (res && res.ok && res.ticket) created.push(res.ticket);
      }
      return created;
    } catch {
      return [];
    }
  }

  return {
    routeAgentEvent,
    auditProposalRefused,
    tryBuildProposalFromIntent,
    maybeAskForSelfNote,
    maybeAskForObserverJournal,
    takeStashedContent,
    syncExpiredProposalsToTickets,
    setAgentBuildDeps: (d) => { agentBuildDeps = d; },
    getAgentBuildDeps: () => agentBuildDeps,
    setProactiveAuditLog: (l) => { proactiveAuditLog = l; },
    getProactiveAuditLog: () => proactiveAuditLog,
    setSandboxUnavailable: (v) => { agentSandboxUnavailable = v; },
    getSandboxUnavailable: () => agentSandboxUnavailable,
  };
}

module.exports = { buildSandboxScope, buildReadSandboxScope, createMainAgentController };
