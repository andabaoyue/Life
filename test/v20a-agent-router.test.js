/**
 * v2.0-a 门禁：CAPABILITY_META 驱动 + agentRouter 统一入口 + S-3 沙盒不可用告知
 *
 * 覆盖 §5.1 六条可验证判据 + 反绕过/变异校验：
 *   1. CAPABILITY_META 冻结键 & 加法式判据：新注册能力或尝试篡改 metaOf() 均不得关闭既有安全闸门
 *   2. _pendingAgentIntent 全仓收敛为单点读取+置空（tryBuildProposalFromIntent），maybeAskForSelfNote 不回落重读
 *   3. agentRouter.handleEvent 正确分派 turn_chat / proactive_idle / window_closed 并保持原调用顺序
 *   4. L1 物理沙盒门禁：sandbox 缺失或 sandboxUnavailable 为真时零下游调用（零 LLM 消耗）且不记 observe 纪元
 *   5. main.js 作用域与接线结构：agentSandboxUnavailable 提升至模块顶层（无 TDZ）且经由 chat-send 接入 router & Brain.ask
 *   6. S-3 运行时告知：sandboxUnavailable=true 时仅追加至动态后缀（覆盖 persona.js:32），system 前缀逐字不变且不写入历史
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  CAPABILITIES, CAPABILITY_META,
  CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
} = require('../src/agent-interfaces');
const { registerAgentIpc } = require('../src/agent-ipc');
const { createAgentRouter, ROUTER_DECISION_KINDS, ROUTER_EVENT_KINDS } = require('../src/agent-router');
const { createIpcGuard } = require('../src/ipc-guard');
const { Brain } = require('../src/brain');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const tmpDirs = [];
function makeTmpDir(prefix = 'v20a-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function createTrustedIpcHarness() {
  const appDir = makeTmpDir('v20a-app-');
  const channels = new Map();
  const localUrl = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
  const mainFrame = { url: localUrl };
  const webContents = { mainFrame, on() {}, setWindowOpenHandler() {} };
  const win = { webContents, isDestroyed: () => false };
  const ipcGuard = createIpcGuard({
    ipcMain: {
      handle(name, fn) { channels.set(name, fn); },
      on() {},
    },
    getMainWindow: () => win,
    appDir,
    getTrustedWebContents: () => [],
  });
  return { ipcGuard, channels, trustedEvent: { sender: webContents, senderFrame: mainFrame } };
}

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

async function main() {
  console.log('--- v2.0-a Agent Router & CAPABILITY_META 门禁 ---');

  /* ============ 1. CAPABILITY_META 冻结与加法式防绕过 ============ */
  {
    check('CAPABILITY_META 存在且顶层与每个能力条目均已冻结',
      Object.isFrozen(CAPABILITY_META)
      && CAPABILITIES.every((c) => CAPABILITY_META[c] && Object.isFrozen(CAPABILITY_META[c])));

    const writeMeta = CAPABILITY_META['workspace.write'];
    check('workspace.write 元数据三项安全标志均为 true',
      writeMeta.enforcesWriteExtension === true
      && writeMeta.requiresContentSnapshot === true
      && writeMeta.checksOverwrite === true);

    const othersFalse = ['workspace.read', 'process.execute', 'network.request'].every((c) => {
      const m = CAPABILITY_META[c];
      return m.enforcesWriteExtension === false
        && m.requiresContentSnapshot === false
        && m.checksOverwrite === false;
    });
    check('非写能力三项元数据标志显式为 false（无隐式放行语义）', othersFalse);

    // 运行时注册能力 + 尝试污染 metaOf 副本：绝对不能绕开 workspace.write 的安全门禁
    const sb = makeTmpDir('v20a-sb-');
    const registry = new CapabilityRegistry();
    registry.register('workspace.custom_probe', {
      dangerLevel: 'low',
      requiresConfirm: true,
      scopeKind: 'path',
      enforcesWriteExtension: false,
      requiresContentSnapshot: false,
      checksOverwrite: false,
    });
    const leakedCopy = registry.metaOf('workspace.write');
    leakedCopy.enforcesWriteExtension = false;
    leakedCopy.requiresContentSnapshot = false;
    leakedCopy.checksOverwrite = false;

    const policy = new PermissionPolicy({
      killSwitch: false,
      allowed: ['workspace.write', 'workspace.custom_probe'],
    });
    policy.setScopeRoots('workspace.write', [sb]);
    policy.setScopeRoots('workspace.custom_probe', [sb]);

    const { ipcGuard, channels, trustedEvent } = createTrustedIpcHarness();
    const agentIpc = registerAgentIpc(ipcGuard, {
      registry,
      policy,
      budget: new ExecutionBudget(),
      auditLog: new AuditLog(),
      confirmationGate: {
        request: () => ({ id: 'c-1' }),
        decide: () => ({ ok: true, approved: true }),
      },
      sandboxRoots: [sb],
    });

    const badExt = agentIpc.proposeInternal({
      capability: 'workspace.write',
      scope: path.join(sb, 'evil.exe'),
      reason: 'test',
      content: 'hello',
    }, 'ipc');
    check('即使污染 metaOf 副本，workspace.write 非法扩展名仍被 DISALLOWED_EXTENSION 拦下',
      badExt && badExt.ok === false && badExt.error === 'DISALLOWED_EXTENSION',
      JSON.stringify(badExt));

    const noContent = agentIpc.proposeInternal({
      capability: 'workspace.write',
      scope: path.join(sb, 'note.md'),
      reason: 'test',
    }, 'ipc');
    check('即使污染 metaOf 副本，workspace.write 缺正文仍被 CONTENT_REQUIRED 拦下（SEC-01 不失效）',
      noContent && noContent.ok === false && noContent.error === 'INVALID_PROPOSAL' && noContent.detail === 'CONTENT_REQUIRED',
      JSON.stringify(noContent));

    // 验证 overwrite 检测在 workspace.write 确认前读取快照阶段依然触发
    const targetFile = path.join(sb, 'existing.md');
    fs.writeFileSync(targetFile, 'old', 'utf8');
    const proposed = agentIpc.proposeInternal({
      capability: 'workspace.write',
      scope: targetFile,
      reason: 'overwrite test',
    }, 'main', 'selfNote', 'new content');
    const getPendingHandler = channels.get('agent:get-pending-proposal');
    const snap = proposed.ok ? getPendingHandler(trustedEvent, { proposalId: proposed.proposal.id }) : null;
    check('即使污染 metaOf 副本，workspace.write 快照期 isOverwrite 检测仍准确命中已有文件',
      proposed.ok === true && snap && snap.ok === true && snap.proposal && snap.proposal.isOverwrite === true,
      JSON.stringify(snap));
  }

  /* ============ 2. agentRouter L1 门禁、三分派顺序与单一消费 ============ */
  {
    check('Router 枚举常量冻结且对齐 §2 第 4 步预留契约',
      Object.isFrozen(ROUTER_DECISION_KINDS)
      && ROUTER_DECISION_KINDS.join(',') === 'accept,stop,ignore,unavailable'
      && ROUTER_EVENT_KINDS.join(',') === 'turn_chat,proactive_idle,window_closed');

    /* 🔴 2026-11-12 复核补：strength 只许原型 policy.ts 的两档，且必须真按事件语义给值。
     *   起因：首版三处都写 strength:'soft' —— 既不在 explicit|inferred 里，
     *   也把「人明确要求」和「挂机自发」压成了同一个值，v2.0-b 接 Mandate 时会直接吃到脏数据。
     *   这条断言同时防两个方向：自造值（'soft'/'none'）与语义压平（全填同一个）。 */
    {
      const r2 = createAgentRouter();
      const shell = { tryBuildProposalFromIntent() {}, maybeAskForSelfNote() {}, maybeAskForObserverJournal() {} };
      const sChat = r2.handleEvent({ kind: 'turn_chat' }, { agentSandbox: 'C:/sb', handlers: shell }).strength;
      const sIdle = r2.handleEvent(
        { kind: 'proactive_idle', trigger: { selfIntent: null } },
        { agentSandbox: 'C:/sb', handlers: shell },
      ).strength;
      const sWin = r2.handleEvent(
        { kind: 'window_closed', windowCloseRes: {} },
        { agentSandbox: 'C:/sb', handlers: shell },
      ).strength;
      const all = [sChat, sIdle, sWin];
      check('strength 只用 explicit / inferred 两档，无自造值',
        all.every((s) => s === 'explicit' || s === 'inferred'), JSON.stringify(all));
      check('strength 按事件语义给值：turn_chat=explicit，proactive_idle/window_closed=inferred',
        sChat === 'explicit' && sIdle === 'inferred' && sWin === 'inferred', JSON.stringify(all));
      // 反例：L1 短路的决策不该假装有强度（没有强度 ≠ 弱强度）
      const sMissing = r2.handleEvent({ kind: 'turn_chat' }, { agentSandbox: null, handlers: shell }).strength;
      check('未真正分派时 strength 为 null，不用假值冒充',
        sMissing === null, String(sMissing));
    }

    // L1 短路：sandbox 缺失 / sandboxUnavailable 为真 => 零下游调用、零副作用
    const router = createAgentRouter();
    const calls = [];
    const handlers = {
      tryBuildProposalFromIntent: () => { calls.push('proposal'); },
      maybeAskForSelfNote: (intent) => { calls.push(['selfNote', intent]); },
      maybeAskForObserverJournal: (res) => { calls.push(['journal', res]); },
    };

    const dMissing = router.handleEvent({ kind: 'turn_chat' }, { agentSandbox: null, handlers });
    const dUnavail = router.handleEvent(
      { kind: 'proactive_idle', trigger: { selfIntent: { kind: 'wantToLeaveSomething', direction: 'x' } } },
      { agentSandbox: 'C:/sb', sandboxUnavailable: 'EACCES', handlers },
    );
    const dWindowUnavail = router.handleEvent(
      { kind: 'window_closed', windowCloseRes: { windowClosed: true } },
      { agentSandbox: 'C:/sb', sandboxUnavailable: true, handlers },
    );

    check('L1 短路：agentSandbox 缺失或 sandboxUnavailable 为真时零下游调用（零 LLM 消耗）',
      calls.length === 0
      && dMissing.kind === 'unavailable' && dMissing.reasonCode === 'SANDBOX_MISSING'
      && dUnavail.kind === 'unavailable' && dUnavail.reasonCode === 'SANDBOX_UNAVAILABLE'
      && dUnavail.logicalCap === 'selfNote'
      && dWindowUnavail.kind === 'unavailable' && dWindowUnavail.logicalCap === 'observerJournal');

    // 正常分派：turn_chat 顺序为 tryBuildProposalFromIntent -> maybeAskForSelfNote(null)
    const dChat = router.handleEvent({ kind: 'turn_chat' }, { agentSandbox: 'C:/sb', handlers });
    check('turn_chat 同序调用 tryBuildProposalFromIntent 后调 maybeAskForSelfNote(null)',
      dChat.kind === 'accept'
      && calls.length === 2
      && calls[0] === 'proposal'
      && Array.isArray(calls[1]) && calls[1][0] === 'selfNote' && calls[1][1] === null,
      JSON.stringify(calls));

    // proactive_idle 只调用 maybeAskForSelfNote(trigger.selfIntent)
    calls.length = 0;
    const fakeSelfIntent = { kind: 'wantToLeaveSomething', direction: '记一笔' };
    const dProactive = router.handleEvent(
      { kind: 'proactive_idle', trigger: { selfIntent: fakeSelfIntent } },
      { agentSandbox: 'C:/sb', handlers },
    );
    check('proactive_idle 只分派 maybeAskForSelfNote 且透传 trigger.selfIntent',
      dProactive.kind === 'accept'
      && calls.length === 1
      && calls[0][0] === 'selfNote'
      && calls[0][1] === fakeSelfIntent);

    // window_closed 只调用 maybeAskForObserverJournal(windowCloseRes)
    calls.length = 0;
    const winRes = { windowClosed: true, windowId: 7 };
    const dWin = router.handleEvent(
      { kind: 'window_closed', windowCloseRes: winRes },
      { agentSandbox: 'C:/sb', handlers },
    );
    check('window_closed 只分派 maybeAskForObserverJournal 且透传 windowCloseRes',
      dWin.kind === 'accept'
      && calls.length === 1
      && calls[0][0] === 'journal'
      && calls[0][1] === winRes);

    // 未知事件降级为 ignore，不抛错也不误触下游
    calls.length = 0;
    const dUnknown = router.handleEvent({ kind: 'unexpected_kind' }, { agentSandbox: 'C:/sb', handlers });
    check('未知事件返回 ignore/UNKNOWN_EVENT 且不误触下游',
      dUnknown.kind === 'ignore' && dUnknown.reasonCode === 'UNKNOWN_EVENT' && calls.length === 0);

    // Recent decisions 留痕且可读
    check('Router 留存最近决策快照并支持 getRecentDecisions() 回读',
      router.getRecentDecisions().length === 7);
  }

  /* ============ 3. main.js 接线与单一消费静态防回归 ============ */
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const mainCode = stripJsComments(mainSrc);

    const topDeclIdx = mainCode.indexOf('let agentSandboxUnavailable = null;');
    const whenReadyIdx = mainCode.indexOf('app.whenReady');
    check('S-3 作用域：agentSandboxUnavailable 声明在模块顶层（早于 app.whenReady，防 TDZ）',
      topDeclIdx !== -1 && whenReadyIdx !== -1 && topDeclIdx < whenReadyIdx
      && !/\n\s*let\s+agentSandboxUnavailable\s*=/.test(mainCode.slice(whenReadyIdx)));

    // 剥除注释后，全 main.js 代码中 _pendingAgentIntent 仅允许出现在 tryBuildProposalFromIntent 函数体内部
    const proposalFnStart = mainCode.indexOf('async function tryBuildProposalFromIntent()');
    const proposalFnEnd = mainCode.indexOf('function maybeAskForSelfNote(', proposalFnStart);
    const outsideProposal = mainCode.slice(0, proposalFnStart) + mainCode.slice(proposalFnEnd);
    check('单一消费：剥除注释后 main.js 代码中 _pendingAgentIntent 在 tryBuildProposalFromIntent 之外零出现',
      proposalFnStart > 0 && proposalFnEnd > proposalFnStart
      && !/_pendingAgentIntent/.test(outsideProposal)
      && /_pendingAgentIntent\s*=\s*null/.test(mainCode.slice(proposalFnStart, proposalFnEnd)));

    check('chat-send 接入了 window_closed / proactive_idle / turn_chat 三条路由',
      mainCode.includes("routeAgentEvent({ kind: 'window_closed', windowCloseRes: res })")
      && mainCode.includes("routeAgentEvent({ kind: 'proactive_idle', trigger })")
      && mainCode.includes("routeAgentEvent({ kind: 'turn_chat' })"));
  }

  /* ============ 4. S-3 运行时告知：前缀缓存与历史纯净度实测 ============ */
  {
    const captured = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        captured.push(payload.messages);
        const reply = '好的，我知道了。';
        const prompt = payload.messages.reduce((s, m) => s + m.content.length, 0);
        const usage = { prompt_cache_hit_tokens: Math.max(0, prompt - 20), prompt_cache_miss_tokens: 20, completion_tokens: 6 };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const ch of reply) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\n\n');
        }
        if (payload.stream_options && payload.stream_options.include_usage === true) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const baseURL = 'http://127.0.0.1:' + server.address().port;
      const brain = new Brain(makeTmpDir('v20a-brain-'), {
        apiKey: 'test',
        model: 'mock',
        baseURL,
        windowTurns: 99,
        windowMaxTokens: 1e9,
        keepTailMessages: 6,
        memoryCapTokens: 1e9,
        price: { peak: {}, valley: {} },
      });

      const NOTICE_TEXT = '【系统环境事实：本机桌面沙盒目录本次初始化失败，落盘能力已关闭。persona 里「你可以在那里留下文字」这一条此刻不成立，不要承诺或假装写过任何文件。】';

      await brain.ask('你好呀，正常一轮', () => {}, { sandboxUnavailable: false });
      await brain.ask('现在沙盒挂了', () => {}, { sandboxUnavailable: true });
      await brain.ask('现在沙盒恢复了', () => {}, { sandboxUnavailable: false });

      const sys0 = captured[0][0].content;
      const sys1 = captured[1][0].content;
      const sys2 = captured[2][0].content;
      check('S-3 前缀缓存不变式：三轮 system 提示词逐字完全相等',
        sys0 === sys1 && sys1 === sys2);

      const u0 = captured[0][captured[0].length - 1].content;
      const u1 = captured[1][captured[1].length - 1].content;
      const u2 = captured[2][captured[2].length - 1].content;
      check('S-3 告知精确出现条件：仅 sandboxUnavailable=true 那一轮携带覆盖说明，恢复后自动消失',
        !u0.includes(NOTICE_TEXT) && u1.includes(NOTICE_TEXT) && !u2.includes(NOTICE_TEXT));

      const historyStr = JSON.stringify(brain.memory.data.history || []);
      check('S-3 历史纯净性：沙盒失败告知行绝不写进 memory.data.history',
        !historyStr.includes('沙盒目录本次初始化失败') && !historyStr.includes('落盘能力已关闭'));
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }

  console.log('\n失败 ' + failures + ' 项');
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
