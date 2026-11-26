/**
 * test/v20b-ticket-lifecycle.test.js — v2.0-b Ticket 生命周期（任务 A）门禁测试
 *
 * 覆盖验收判据（A1~A6）与硬约束（1~5）：
 *   1. 状态机：open ⇄ paused → ended 全路径合法；ended → open / paused / ended 及非法态全拒；
 *      ended 后不可 updateNote；文件头含对原型 open→ended 偏离说明。
 *   2. 原子持久化：复用 atomic.writeJsonAtomic（零 writeFileSync），重启（重新实例化）读回一致，
 *      字段最小集（<=60 字标题、<=200 字进展、无全文/无多余字段）且返回冻结对象。
 *   3. 损坏恢复：agent-tickets.json 写入垃圾/数组/null/断尾/部分坏条目时不抛不阻塞启动，降级为空集或保留合法条目。
 *   4. 注入隔离：Ticket 摘要仅出现在 memory.build() / Brain.ask() 尾部，systemText() 逐字节不变，
 *      memory.data.history 绝不含 Ticket 文本或摘要标题。
 *   5. 空集不注入：无 ticket 或仅有 ended ticket 时尾部不输出任何【当前未完事项】空白标题。
 *   6. 上限与单行长度：造 10 条 open + 1 条 ended，严格只注入最近 3 条（且每行 <= 80 字，不漏进 ended），
 *      且普通聊天绝不自动新建 Ticket。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 临时目录卫生：统一 v20b- 前缀并在 exit 时清空
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
});

const ROOT = path.resolve(__dirname, '..');
const {
  TicketStore,
  TICKET_FILE_NAME,
  TICKET_STATES,
  TICKET_TITLE_MAX_CHARS,
  TICKET_NOTE_MAX_CHARS,
  TICKET_MAX_INJECT,
  TICKET_LINE_MAX_CHARS,
  formatTicketLine,
  formatTicketsForPrompt,
} = require(path.join(ROOT, 'src', 'agent-lifecycle'));
const { Memory } = require(path.join(ROOT, 'src', 'memory'));
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

(async () => {
  console.log('=== v2.0-b Ticket 生命周期门禁测试 ===');

  /* ============ 1. 状态机：open ⇄ paused → ended 与非法转移拒绝 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b-'));
    const store = new TicketStore({ dir });

    check('1.0 状态全集只含 open/paused/ended 且文件未建案前不提前落盘',
      TICKET_STATES.length === 3
      && TICKET_STATES.includes('open')
      && TICKET_STATES.includes('paused')
      && TICKET_STATES.includes('ended')
      && !fs.existsSync(path.join(dir, TICKET_FILE_NAME)));

    const cRes = store.createTicket({
      title: '整理用户发来的读书笔记清单',
      windowNo: 4,
      capability: 'workspace.write',
      note: '已读完前半段，等待继续补充',
      now: 1000,
    });
    const tId = cRes.ticket.id;
    check('1.1 创建默认处于 open，返回冻结对象且仅含最小字段集',
      cRes.ok === true
      && cRes.ticket.state === 'open'
      && Object.isFrozen(cRes.ticket)
      && cRes.ticket.capability === 'workspace.write'
      && cRes.ticket.windowNo === 4
      && Object.keys(cRes.ticket).sort().join(',') === 'capability,createdAt,id,note,state,title,updatedAt,windowNo');

    // open -> paused
    const p1 = store.transition(tId, 'paused', { note: '先等用户吃完饭回来', now: 2000 });
    check('1.2 open → paused 合法且更新 note 与 updatedAt',
      p1.ok === true && p1.ticket.state === 'paused' && p1.ticket.note === '先等用户吃完饭回来' && p1.ticket.updatedAt === 2000);

    // paused -> open
    const o2 = store.transition(tId, 'open', { note: '用户回来了，继续处理', now: 3000 });
    check('1.3 paused → open 合法且可恢复进行',
      o2.ok === true && o2.ticket.state === 'open' && o2.ticket.updatedAt === 3000);

    // 非法同态 / 未知态拒绝
    const sameOpen = store.transition(tId, 'open', { now: 3500 });
    const badTarget = store.transition(tId, 'cancelled', { now: 3600 });
    check('1.4 同态与未知目标态转换均被拒绝（INVALID_TRANSITION）',
      !sameOpen.ok && sameOpen.code === 'INVALID_TRANSITION'
      && !badTarget.ok && badTarget.code === 'INVALID_TRANSITION'
      && store.get(tId).state === 'open');

    // open -> ended
    const e1 = store.transition(tId, 'ended', { note: '已整理完并确认归档', now: 4000 });
    check('1.5 open → ended 合法终结',
      e1.ok === true && e1.ticket.state === 'ended' && e1.ticket.updatedAt === 4000);

    // paused -> ended 也合法
    const tPauseOnly = store.createTicket({ title: '待定便签草稿', state: 'paused', now: 4100 });
    const pToEnd = store.transition(tPauseOnly.ticket.id, 'ended', { now: 4200 });
    check('1.6 paused → ended 合法终结且支持无 capability 纯记录型 Ticket (capability=null)',
      pToEnd.ok === true && pToEnd.ticket.state === 'ended' && tPauseOnly.ticket.capability === null);

    // ended 不可逆（反例：ended -> open / paused / ended + updateNote）
    const endToOpen = store.transition(tId, 'open', { now: 5000 });
    const endToPaused = store.transition(tId, 'paused', { now: 5100 });
    const endToEnd = store.transition(tId, 'ended', { now: 5200 });
    const endNoteEdit = store.updateNote(tId, '试图篡改已结束记录', { now: 5300 });
    check('1.7 ended 为终态：ended→open / paused / ended 及 updateNote 一律被拒且状态未改',
      !endToOpen.ok && endToOpen.code === 'INVALID_TRANSITION'
      && !endToPaused.ok && endToPaused.code === 'INVALID_TRANSITION'
      && !endToEnd.ok && endToEnd.code === 'INVALID_TRANSITION'
      && !endNoteEdit.ok && endNoteEdit.code === 'TICKET_ALREADY_ENDED'
      && store.get(tId).state === 'ended'
      && store.get(tId).note === '已整理完并确认归档');

    // 非法创建输入拒收
    const emptyTitle = store.createTicket({ title: '   ' });
    const initEnded = store.createTicket({ title: '直接创建为ended', state: 'ended' });
    const badCap = store.createTicket({ title: '非法能力名', capability: 'bad cap!' });
    check('1.8 空白标题 / 初始ended / 非法capability名均被拒收',
      !emptyTitle.ok && emptyTitle.code === 'TITLE_REQUIRED'
      && !initEnded.ok && initEnded.code === 'INVALID_INITIAL_STATE'
      && !badCap.ok && badCap.code === 'INVALID_CAPABILITY');
  }

  /* ============ 2. 原子持久化、重启读回、字段长度裁剪与原型偏离声明 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b-'));
    const store1 = new TicketStore({ dir });
    const longTitle = '标'.repeat(90);
    const longNote = '进\n展'.repeat(130);
    const created = store1.createTicket({
      title: longTitle,
      note: longNote,
      windowNo: 9,
      capability: null,
      now: 123456,
    });
    store1.transition(created.ticket.id, 'paused', { now: 123999 });

    const ticketFile = path.join(dir, TICKET_FILE_NAME);
    const diskFiles = fs.readdirSync(dir);
    check('2.1 已落盘到 agent-tickets.json 且无残留 .tmp- 临时文件',
      fs.existsSync(ticketFile) && diskFiles.every((f) => !f.includes('.tmp-')));

    // 模拟进程重启：重新实例化 TicketStore
    const store2 = new TicketStore({ dir });
    const reloaded = store2.get(created.ticket.id);
    check('2.2 重启重新实例化后读回状态、windowNo、capability、title、note 与写入前完全一致',
      reloaded !== null
      && reloaded.id === created.ticket.id
      && reloaded.state === 'paused'
      && reloaded.createdAt === 123456
      && reloaded.updatedAt === 123999
      && reloaded.windowNo === 9
      && reloaded.capability === null
      && reloaded.title.length === TICKET_TITLE_MAX_CHARS
      && reloaded.note.length <= TICKET_NOTE_MAX_CHARS
      && !/[\r\n]/.test(reloaded.note));

    // 源码硬约束检查：剥注释后的可执行代码只用 atomic.writeJsonAtomic（零 writeFileSync），且头注释写明偏离原型理由
    const src = fs.readFileSync(path.join(ROOT, 'src', 'agent-lifecycle.js'), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('2.3 源码仅用 atomic.writeJsonAtomic（零 fs.writeFileSync）且头注释写明偏离原型理由',
      /writeJsonAtomic\(/.test(codeOnly)
      && !/writeFileSync/.test(codeOnly)
      && /dsh-superagent-prototype/.test(src)
      && /open ⇄ paused → ended/.test(src));
  }

  /* ============ 3. 损坏恢复：垃圾文件 / 非法结构降级为空白票据集 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b-'));
    const f = path.join(dir, TICKET_FILE_NAME);

    const corruptPayloads = [
      '{ "tickets": [ broken json ~~~',
      '[1, 2, 3]',
      'null',
      '"string-root"',
      '{"schemaVersion": 1, "tickets": "not-array"}',
    ];
    let allRecoveredCleanly = true;
    for (const payload of corruptPayloads) {
      fs.writeFileSync(f, payload, 'utf8');
      let threw = false;
      let s;
      try {
        s = new TicketStore({ dir });
      } catch {
        threw = true;
      }
      if (threw || !s || s.corrupted !== true || s.list().length !== 0 || s.formatSummary() !== '') {
        allRecoveredCleanly = false;
        break;
      }
    }
    check('3.1 五种损坏 agent-tickets.json 均不抛不阻塞启动，降级为空白票据集且摘要为空',
      allRecoveredCleanly);

    // 混入坏条目的合法容器：剔除坏条目保留合法条目
    fs.writeFileSync(f, JSON.stringify({
      schemaVersion: 1,
      tickets: [
        null,
        { id: 'bad-no-title', state: 'open', createdAt: 1, updatedAt: 1 },
        { id: 'bad-state', title: '坏状态', state: 'bogus', createdAt: 1, updatedAt: 1 },
        { id: 'good-1', title: '保留的合法事项', state: 'paused', createdAt: 10, updatedAt: 20, windowNo: 2, capability: null, note: '正常' },
      ],
    }), 'utf8');
    const mixedStore = new TicketStore({ dir });
    check('3.2 tickets 数组中混入损坏条目时剔除坏条目、保留合法条目不崩溃',
      mixedStore.list().length === 1 && mixedStore.get('good-1').title === '保留的合法事项');
  }

  /* ============ 4 & 5 & 6. 注入隔离 / 空集不注入 / 10 条上限 3 条 / 单行 <=80 字 ============ */
  {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b-'));
    const mem = new Memory(userDir, { persona: 'base-persona', windowTurns: 20 });
    const store = new TicketStore({ dir: userDir });
    mem.setTicketProvider(() => store.formatSummary());

    const sysInitial = mem.systemText();
    mem.append('user', '你好呀');
    const msgsEmpty = mem.build();
    const tailEmpty = msgsEmpty[msgsEmpty.length - 1].content;
    check('5.1 Memory 层空票据时不注入任何内容也不留空白【当前未完事项】标题',
      tailEmpty === '你好呀' && !tailEmpty.includes('未完事项') && mem.systemText() === sysInitial);

    // 仅有 ended 票据时也不注入
    const endedRes = store.createTicket({ title: '已经完结的旧事项', now: 100 });
    store.transition(endedRes.ticket.id, 'ended', { now: 200 });
    const msgsEndedOnly = mem.build();
    check('5.2 仅有 ended 票据时不注入任何内容也不留空白标题',
      msgsEndedOnly[msgsEndedOnly.length - 1].content === '你好呀'
      && !msgsEndedOnly[msgsEndedOnly.length - 1].content.includes('已经完结的旧事项'));

    // 造 10 条 open（故意带长标题与长进展）+ 1 条 paused
    const ids = [];
    for (let i = 1; i <= 10; i++) {
      const r = store.createTicket({
        title: `第${i}号待办事项-${'甲'.repeat(40)}`,
        note: `进展详情${i}-${'乙'.repeat(100)}`,
        now: 1000 + i * 10,
      });
      ids.push(r.ticket.id);
    }
    store.transition(ids[9], 'paused', { note: '等待你回来决定下一步怎么处理这份资料的收尾排版', now: 5000 });

    const summary = store.formatSummary();
    const summaryLines = summary.split('\n');
    const bulletLines = summaryLines.slice(1);
    check('6.1 造 10 条 open 后严格只注入最近 3 条且每条摘要 <= 80 字',
      TICKET_MAX_INJECT === 3
      && TICKET_LINE_MAX_CHARS === 80
      && bulletLines.length === 3
      && bulletLines.every((l) => l.length <= TICKET_LINE_MAX_CHARS)
      && bulletLines[0].includes('暂停') && bulletLines[0].includes('第10号')
      && bulletLines[1].includes('进行中') && bulletLines[1].includes('第9号')
      && bulletLines[2].includes('进行中') && bulletLines[2].includes('第8号')
      && !summary.includes('第7号')
      && !summary.includes('已经完结的旧事项'));

    check('6.2 formatTicketLine 对 ended 直接返回空串，formatTicketsForPrompt 空数组返回空串',
      formatTicketLine({ state: 'ended', title: 'x' }) === ''
      && formatTicketsForPrompt([]) === '');
  }

  /* ============ 端到端 Brain.ask() 验证：只进尾部 dynamicBody、不进 history、不碰 systemText、不自动建 Ticket ============ */
  {
    const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b-'));
    const captured = [];
    const brain = new Brain(brainDir, {
      apiKey: 'test-key',
      model: 'deepseek-chat',
    });
    brain.api = {
      async stream(messages) {
        captured.push(messages);
        return { text: '记着呢。', usage: {} };
      },
    };
    const sysBefore = brain.memory.systemText();

    // 轮 1：无 Ticket 时调用 brain.ask -> 不注入、不自动创建 Ticket
    await brain.ask('今天天气怎么样', () => {}, {});
    const req1 = captured[0];
    check('5.3 Brain 空集轮次不注入未完事项段落，且普通对话绝不自动创建 Ticket',
      brain.ticketStore.list().length === 0
      && req1[0].content === sysBefore
      && !JSON.stringify(req1).includes('当前未完事项'));

    // 手工登记 1 条 paused 与 1 条 open，随后发第二轮聊天
    brain.ticketStore.createTicket({ title: '整理桌面的周报草稿', capability: 'workspace.write', note: '差最后一段', now: 1000 });
    const pausedTkt = brain.ticketStore.createTicket({ title: '等你确认是否删掉旧草稿', capability: null, now: 2000 });
    brain.ticketStore.transition(pausedTkt.ticket.id, 'paused', { now: 2100 });

    await brain.ask('我们继续聊吧', () => {}, {});
    const req2 = captured[1];
    const lastUserMsg = req2[req2.length - 1];
    const historyJson = JSON.stringify(brain.memory.data.history);

    check('4.1 Brain 端到端注入隔离：Ticket 摘要只出现在尾部 user 消息，systemText() 逐字节不变',
      req2[0].content === sysBefore
      && brain.memory.systemText() === sysBefore
      && lastUserMsg.role === 'user'
      && lastUserMsg.content.includes('【当前未完事项】')
      && lastUserMsg.content.includes('整理桌面的周报草稿')
      && lastUserMsg.content.includes('等你确认是否删掉旧草稿'));

    check('4.2 Ticket 摘要与标题绝不进入 memory.data.history（不污染历史）且不自动扩增',
      !historyJson.includes('当前未完事项')
      && !historyJson.includes('整理桌面的周报草稿')
      && !historyJson.includes('等你确认是否删掉旧草稿')
      && brain.ticketStore.list().length === 2);
  }

  // Batch 3.2: TicketStore 200 条容量上限拦截
  {
    const dirCap = fs.mkdtempSync(path.join(os.tmpdir(), 'v20b-'));
    try {
      const capStore = new TicketStore({ dir: dirCap });
      for (let i = 0; i < 200; i++) {
        const r = capStore.createTicket({ title: `t-${i}`, now: 1000 + i });
        if (!r.ok) throw new Error('unexpected fail before 200');
      }
      const over = capStore.createTicket({ title: 'overflow-201', now: 9999 });
      check('7.1 Batch3.2: TicketStore 达 200 条上限时拒绝新增并返回 TICKET_LIMIT_REACHED',
        over.ok === false && over.code === 'TICKET_LIMIT_REACHED' && capStore.list().length === 200);
    } finally {
      try { fs.rmSync(dirCap, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\nv20b-ticket-lifecycle: PASS=${pass}, FAIL=${failures}`);
  if (failures > 0) process.exit(1);
})();
