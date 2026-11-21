/**
 * test/v20b2-ticket-ipc.test.js — v2.0-b2 Ticket IPC 接线（任务 A）门禁测试
 *
 * 覆盖施工单 §五（A1~A7 + 端到端 13~15）：
 *   1. 四条通道登记（8 → 12）且全走 ipcGuard（非受信 sender / child frame 拒且零副作用）。
 *   2. agent:ticket-create 返回 {ok:true, ticket}，id 由主进程生成、windowNo 取自注入的 getWindowNo()。
 *   3. 反例：渲染端传 windowNo: 999 / 自定义 id / now / state 一律被忽略（防越权影响认知）。
 *   4. 反例：ended → open / paused、ended 后 updateNote、空白标题、不存在 id 均返回
 *      { ok: false, error: '...' }，且绝不泄露内部 code 字段。
 *   5. ticketStore 为 null 时四条通道返回 { ok: false, error: 'TICKETS_UNAVAILABLE' } 不抛。
 *   6. 源码门禁：src/agent-ipc.js 内零 new TicketStore（防双实例），main.js 注入 brain.ticketStore 与 getWindowNo。
 *   7. 端到端：通过 IPC 建单 → Brain.memory.build() / Brain.ask() 尾部注入（10 条限 3 条），
 *      systemText() 逐字节不变、history 不受污染；摘掉 provider 的判别对照必须 FAIL。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 临时目录卫生：统一 v20b2- 前缀并在退出时清空
const _hygDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _hygDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _hygDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掀桌 */ }
  }
  fs.mkdtempSync = _origMkdtemp;
});

const ROOT = path.resolve(__dirname, '..');
const { registerAgentIpc, AGENT_CHANNELS } = require(path.join(ROOT, 'src', 'agent-ipc'));
const { createIpcGuard } = require(path.join(ROOT, 'src', 'ipc-guard'));
const {
  CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog,
} = require(path.join(ROOT, 'src', 'agent-interfaces'));
const { TicketStore, TICKET_FILE_NAME } = require(path.join(ROOT, 'src', 'agent-lifecycle'));
const { Brain } = require(path.join(ROOT, 'src', 'brain'));

let pass = 0;
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS ', name);
  } else {
    failures++;
    console.error('FAIL ', name, detail || '');
  }
}

function buildHarness(opts = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b2-app-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b2-data-'));
  fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html>');

  const handlers = new Map();
  const bareCalls = [];
  const fakeIpcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    on(channel) { bareCalls.push(channel); },
  };

  const localUrl = 'file:///' + appDir.replace(/\\/g, '/') + '/index.html';
  const mainFrame = { url: localUrl };
  const webContents = { mainFrame, on() {}, setWindowOpenHandler() {} };
  const win = { webContents, isDestroyed: () => false };

  const guard = createIpcGuard({
    ipcMain: fakeIpcMain,
    getMainWindow: () => win,
    appDir,
    getTrustedWebContents: () => [],
  });

  const ticketStore = Object.prototype.hasOwnProperty.call(opts, 'ticketStore')
    ? opts.ticketStore
    : new TicketStore({ dir: dataDir });

  let currentWindowNo = opts.windowNo || 7;
  const regOpts = {
    ticketStore,
    ...(opts.omitGetWindowNo ? {} : { getWindowNo: () => currentWindowNo }),
  };

  const api = registerAgentIpc(guard, {
    registry: new CapabilityRegistry(),
    policy: new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read'] }),
    budget: new ExecutionBudget(),
    auditLog: new AuditLog({ dir: dataDir }),
  }, regOpts);

  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  const rogueWc = { mainFrame: { url: localUrl }, on() {}, setWindowOpenHandler() {} };
  const untrustedEvent = { sender: rogueWc, senderFrame: rogueWc.mainFrame };
  const childEvent = { sender: webContents, senderFrame: { url: localUrl } };

  const call = (channel, event, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('channel not registered: ' + channel);
    return fn(event, ...args);
  };

  return {
    appDir,
    dataDir,
    handlers,
    bareCalls,
    ticketStore,
    api,
    trustedEvent,
    untrustedEvent,
    childEvent,
    setWindowNo(n) { currentWindowNo = n; },
    call,
  };
}

(async () => {
  console.log('=== v2.0-b2 Ticket IPC 接线门禁测试 ===');

  /* ============ 1. 通道登记与数量对齐 ============ */
  {
    const h = buildHarness();
    const ticketChannels = [
      'agent:ticket-list',
      'agent:ticket-create',
      'agent:ticket-transition',
      'agent:ticket-note',
    ];
    check('T1.1 AGENT_CHANNELS 含 4 条 Ticket 通道且与实际注册 handler 数严格相等（12 条）',
      h.api && h.api.ok === true
      && h.bareCalls.length === 0
      && AGENT_CHANNELS.length === 12
      && ticketChannels.every((c) => AGENT_CHANNELS.includes(c) && h.handlers.has(c))
      && h.handlers.size === AGENT_CHANNELS.length,
      `channels=${AGENT_CHANNELS.length} handlers=${h.handlers.size}`);
  }

  /* ============ 2. 建单正例 + 伪造 id / windowNo / now / state 反例 ============ */
  {
    const h = buildHarness({ windowNo: 7 });
    const created = h.call('agent:ticket-create', h.trustedEvent, {
      id: 'tkt-forged-123',
      title: '整理沙盒里的旧便签',
      note: '还差三张',
      capability: 'workspace.write',
      windowNo: 999,
      now: 123456,
      state: 'ended',
    });

    check('T1.2 agent:ticket-create 返回 {ok:true, ticket} 且主进程生成 tkt-* id',
      created && created.ok === true
      && created.ticket
      && typeof created.ticket.id === 'string'
      && created.ticket.id.startsWith('tkt-')
      && created.ticket.title === '整理沙盒里的旧便签'
      && created.ticket.note === '还差三张'
      && created.ticket.capability === 'workspace.write');

    check('T1.3 ❌ 反例：渲染端传 windowNo: 999 被忽略（主进程写入真实 windowNo=7）',
      created.ticket.windowNo === 7 && created.ticket.windowNo !== 999,
      `windowNo=${created.ticket.windowNo}`);

    check('T1.4 ❌ 反例：渲染端传自定义 id / now / state 均被忽略',
      created.ticket.id !== 'tkt-forged-123'
      && created.ticket.state === 'open'
      && created.ticket.createdAt !== 123456
      && created.ticket.updatedAt !== 123456);

    const listed = h.call('agent:ticket-list', h.trustedEvent);
    check('T1.5 agent:ticket-list 只读返回全部票据且磁盘文件已原子落盘',
      listed && listed.ok === true
      && Array.isArray(listed.tickets)
      && listed.tickets.length === 1
      && listed.tickets[0].id === created.ticket.id
      && fs.existsSync(path.join(h.dataDir, TICKET_FILE_NAME)));

    /* ============ 3. 状态转移 / 改备注 / 终态拦截与 error 字段归一 ============ */
    h.setWindowNo(8);
    const paused = h.call('agent:ticket-transition', h.trustedEvent, {
      id: created.ticket.id,
      state: 'paused',
      note: '先等用户吃完饭',
      windowNo: 888,
      now: 1,
    });
    const noted = h.call('agent:ticket-note', h.trustedEvent, {
      id: created.ticket.id,
      note: '补充：桌面右下角那张',
      windowNo: 777,
      now: 2,
    });
    const ended = h.call('agent:ticket-transition', h.trustedEvent, {
      id: created.ticket.id,
      state: 'ended',
    });
    check('T1.6 transition 与 note 正常更新且同样忽略渲染端伪造 windowNo/now',
      paused.ok === true && paused.ticket.state === 'paused' && paused.ticket.windowNo === 8
      && noted.ok === true && noted.ticket.note === '补充：桌面右下角那张' && noted.ticket.updatedAt !== 2
      && ended.ok === true && ended.ticket.state === 'ended');

    const reopenErr = h.call('agent:ticket-transition', h.trustedEvent, {
      id: created.ticket.id,
      state: 'open',
    });
    const endedNoteErr = h.call('agent:ticket-note', h.trustedEvent, {
      id: created.ticket.id,
      note: '试图修改终态',
    });
    const emptyTitleErr = h.call('agent:ticket-create', h.trustedEvent, { title: '   ' });
    const missingIdErr = h.call('agent:ticket-transition', h.trustedEvent, { id: 'tkt-none', state: 'paused' });
    const badCapErr = h.call('agent:ticket-create', h.trustedEvent, { title: 'x', capability: 'bad cap!' });

    const allNormalized = [reopenErr, endedNoteErr, emptyTitleErr, missingIdErr, badCapErr]
      .every((r) => r && r.ok === false && typeof r.error === 'string' && !('code' in r));
    check('T1.7 ❌ 反例：ended→open / 终态改备注 / 异常输入均返回 {ok:false, error} 且不含 code 字段',
      allNormalized
      && reopenErr.error === 'INVALID_TRANSITION'
      && endedNoteErr.error === 'TICKET_ALREADY_ENDED'
      && emptyTitleErr.error === 'TITLE_REQUIRED'
      && missingIdErr.error === 'TICKET_NOT_FOUND'
      && badCapErr.error === 'INVALID_CAPABILITY',
      JSON.stringify({ reopenErr, endedNoteErr, emptyTitleErr }));
  }

  /* ============ 4. 非受信 sender / child frame 拦截且零副作用 ============ */
  {
    const h = buildHarness({ windowNo: 3 });
    const seed = h.call('agent:ticket-create', h.trustedEvent, { title: '既有事项', note: '原备注' });
    const ticketChs = [
      ['agent:ticket-list', undefined],
      ['agent:ticket-create', { title: '越权建单' }],
      ['agent:ticket-transition', { id: seed.ticket.id, state: 'ended' }],
      ['agent:ticket-note', { id: seed.ticket.id, note: '越权篡改' }],
    ];
    let blocked = 0;
    for (const [ch, payload] of ticketChs) {
      let caught = null;
      try { h.call(ch, h.untrustedEvent, payload); } catch (e) { caught = e; }
      if (caught && (caught.code === 'UNTRUSTED_RENDERER' || caught.message === 'UNTRUSTED_RENDERER')) {
        blocked++;
      }
      let childCaught = null;
      try { h.call(ch, h.childEvent, payload); } catch (e) { childCaught = e; }
      if (childCaught && (childCaught.code === 'UNTRUSTED_RENDERER' || childCaught.message === 'UNTRUSTED_RENDERER')) {
        blocked++;
      }
    }
    const after = h.ticketStore.list();
    check('T1.8 ❌ 反例：非受信 sender 与 child frame 调四条 Ticket 通道全部被拒且零副作用',
      blocked === 8
      && after.length === 1
      && after[0].state === 'open'
      && after[0].note === '原备注',
      `blocked=${blocked}`);
  }

  /* ============ 5. ticketStore 缺失安全降级 ============ */
  {
    const h = buildHarness({ ticketStore: null });
    const resList = [
      h.call('agent:ticket-list', h.trustedEvent),
      h.call('agent:ticket-create', h.trustedEvent, { title: '测试' }),
      h.call('agent:ticket-transition', h.trustedEvent, { id: 'x', state: 'paused' }),
      h.call('agent:ticket-note', h.trustedEvent, { id: 'x', note: 'n' }),
    ];
    check('T1.9 ticketStore 为 null 时四条通道返回 {ok:false, error:"TICKETS_UNAVAILABLE"} 而非抛错',
      resList.every((r) => r && r.ok === false && r.error === 'TICKETS_UNAVAILABLE'));
  }

  /* ============ 6. 源码门禁：严禁双实例 + main.js 接线 ============ */
  {
    const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent-ipc.js'), 'utf8');
    const ipcCode = ipcSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const regBlock = mainSrc.slice(mainSrc.indexOf('registerAgentIpc('), mainSrc.indexOf('registerAgentIpc(') + 1800);

    check('T1.10 源码门禁：agent-ipc.js 内零 new TicketStore 且 main.js 注入 brain.ticketStore 与 getWindowNo',
      !/new\s+TicketStore\b/.test(ipcCode)
      && !/require\(['"]\.\/agent-lifecycle['"]\)/.test(ipcCode)
      && /ticketStore\s*:.*brain\s*&&\s*brain\.ticketStore/.test(regBlock)
      && /getWindowNo\s*:/.test(regBlock));
  }

  /* ============ 7. 端到端：IPC 建单 → Brain.ask() 尾部注入（含摘除 provider 对照 & 10→3 上限） ============ */
  {
    const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b2-brain-'));
    const captured = [];
    const brain = new Brain(brainDir, { apiKey: 'test-key', model: 'deepseek-chat' });
    brain.api = {
      async stream(messages) {
        captured.push(messages);
        return { text: '好的。', usage: {} };
      },
    };
    const h = buildHarness({
      ticketStore: brain.ticketStore,
      windowNo: 5,
    });
    const sysBefore = brain.memory.systemText();

    const ipcCreated = h.call('agent:ticket-create', h.trustedEvent, {
      title: '整理沙盒里的旧便签',
      note: '还差三张',
      windowNo: 999,
    });
    assert.strictEqual(ipcCreated.ok, true);

    await brain.ask('在干嘛', () => {}, {});
    const req1 = captured[0];
    const tail1 = req1[req1.length - 1].content;
    const historyJson = JSON.stringify(brain.memory.data.history);

    check('T2.1 端到端：IPC 建单 → 下一轮 Brain.ask() 尾部含标题与备注，systemText() 逐字节不变且不进 history',
      ipcCreated.ticket.windowNo === 5
      && req1[0].content === sysBefore
      && brain.memory.systemText() === sysBefore
      && tail1.includes('【当前未完事项】')
      && tail1.includes('整理沙盒里的旧便签')
      && tail1.includes('还差三张')
      && !historyJson.includes('整理沙盒里的旧便签')
      && !historyJson.includes('当前未完事项'));

    // 判别力对照：摘掉 provider 后再 build() 不得再包含该摘要（防止恒真）
    brain.memory.setTicketProvider(null);
    brain.memory.append('user', '再看一眼');
    const msgsWithoutProvider = brain.memory.build();
    const tailWithout = msgsWithoutProvider[msgsWithoutProvider.length - 1].content;
    check('T2.2 判别力对照：摘掉 ticketProvider 后 build() 尾部不再出现未完事项摘要',
      !tailWithout.includes('整理沙盒里的旧便签') && !tailWithout.includes('【当前未完事项】'));

    // 恢复 provider，再通过 IPC 建 9 条（共 10 条），严格只注入 3 条
    brain.memory.setTicketProvider(() => brain.takeTicketNote());
    for (let i = 2; i <= 10; i++) {
      h.call('agent:ticket-create', h.trustedEvent, { title: `待办-${i}` });
    }
    const msgsTen = brain.memory.build();
    const tailTen = msgsTen[msgsTen.length - 1].content;
    const injectedLines = tailTen.split('\n').filter((l) => l.startsWith('- ['));
    check('T2.3 端到端上限：IPC 连建 10 条后 build() 尾部严格只注入 3 条且 systemText() 不变',
      brain.ticketStore.list().length === 10
      && injectedLines.length === 3
      && brain.memory.systemText() === sysBefore,
      `injected=${injectedLines.length}`);
  }

  /* ============ 8. 任务 B：preload 桥接白名单 + 面板白名单/渲染纪律 ============ */
  {
    const Module = require('module');
    const invoked = [];
    let exposed = null;
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return {
          contextBridge: { exposeInMainWorld(name, api) { exposed = { name, api }; } },
          ipcRenderer: {
            invoke(ch, payload) { invoked.push({ ch, payload }); return Promise.resolve({ ok: true }); },
            send() {},
            on() {},
          },
        };
      }
      return origLoad.call(this, request, parent, isMain);
    };
    try {
      const preloadPath = path.join(ROOT, 'preload.js');
      delete require.cache[require.resolve(preloadPath)];
      require(preloadPath);
    } finally {
      Module._load = origLoad;
    }

    const agentBridge = exposed && exposed.name === 'deskpet' && exposed.api && exposed.api.agent;
    const onlyReadTicketExposed = Boolean(agentBridge)
      && typeof agentBridge.ticketList === 'function'
      && agentBridge.ticketCreate === undefined
      && agentBridge.ticketTransition === undefined
      && agentBridge.ticketNote === undefined;

    if (onlyReadTicketExposed) {
      await agentBridge.ticketList();
    }

    check('T3.1 preload.js 遵守 D-005 主体性只读铁律：仅暴露 ticketList，绝不暴露写/改接口给渲染端',
      onlyReadTicketExposed
      && invoked.length === 1
      && invoked[0].ch === 'agent:ticket-list');

    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
    const selectBodyMatch = /function selectPanelSection\([\s\S]*?\n\}/.exec(petSrc);
    const selectBody = selectBodyMatch ? selectBodyMatch[0] : '';

    check('T3.2 面板结构与只读纪律：PANEL_SECTIONS 含 tickets、index.html 含 tab 与列表、无人工新建/修改按钮',
      /const\s+PANEL_SECTIONS\s*=\s*\[[^\]]*'tickets'[^\]]*\]/.test(petSrc)
      && /class="pnav-item[^"]*"\s+data-sec="tickets"/.test(indexHtml)
      && /class="psec[^"]*"\s+data-sec="tickets"/.test(indexHtml)
      && /id="ticketList"/.test(indexHtml)
      && !/id="ticketNewTitle"/.test(indexHtml)
      && !/id="ticketNewBtn"/.test(indexHtml)
      && !/ticketCreate|ticketTransition|ticketNote/.test(petSrc)
      && /if\s*\(\s*k\s*===\s*'tickets'\s*\)\s*refreshTickets\(\)/.test(selectBody));

    const ticketSectionIdx = petSrc.indexOf('function ticketStateTagText');
    const ticketSectionEnd = petSrc.indexOf('async function refreshStats', ticketSectionIdx);
    const ticketUiSlice = (ticketSectionIdx >= 0 && ticketSectionEnd > ticketSectionIdx)
      ? petSrc.slice(ticketSectionIdx, ticketSectionEnd)
      : '';
    const lifecycleSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent-lifecycle.js'), 'utf8');
    check('T3.3 面板纪律：空态有文案、已结束默认折叠(<details>无open)、状态词与 formatTicketLine 同字、无 innerHTML、不渲染 id',
      ticketUiSlice.includes('还没有记录任何事项')
      && ticketUiSlice.includes("createElement('details')")
      && !/\.open\s*=\s*true/.test(ticketUiSlice)
      && ticketUiSlice.includes("'进行中'") && ticketUiSlice.includes("'暂停'")
      && lifecycleSrc.includes("'进行中'") && lifecycleSrc.includes("'暂停'")
      && !/innerHTML/.test(ticketUiSlice)
      && !/textContent\s*=\s*[^;]*\bticket\.id\b/.test(ticketUiSlice));
  }

  console.log(`\nv20b2-ticket-ipc: PASS=${pass}, FAIL=${failures}`);
  if (failures > 0) process.exit(1);
})();
