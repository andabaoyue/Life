/**
 * test/d24-selfnote-engrave.test.js
 *
 * D-24 门禁：便签入传 —— 她自发写下的字，反过来雕刻她自己。
 *
 * ## 这一轮补的是哪个洞
 *   D-13 / D-20 把「她写的东西」接回了她的意识（当轮注入 + 落盘 + 跨重启），
 *   但那还只是**脱机遥测的半山腰**：便签被看到一次就淡出，
 *   既不进 experiences.jsonl（自传经历档案），也不进 SelfLedger，更不碰特质。
 *   ⇒ 她自主做出的行为，没有反过来塑造她是谁。
 *
 * ## 三段式（用户拍板：三段全做；只铸自发便签）
 *   A 段·铸造：关窗时刻把 source==='selfNote' 的便签铸进 experiences.jsonl
 *   B 段·吸收：【自发留痕事实】进当轮成长反思，产出带引证的 SELF_INFERRED 记录
 *   C 段·微调：只有经核验的证据才动特质 —— verifyEvidence → reduce → 归档 → commit
 *
 * ## 五条红线（每条有独立断言）
 *   1. 前缀缓存不变式：绝不进 system、绝不改写历史；特质变化只在关窗结算
 *   2. 数据不伪造：未落盘/失败的便签绝不铸；内容零改写；引证解析不到就拒收
 *   3. 幂等：同一条便签终身只铸一次（含跨重启）
 *   4. persona：不伪装 assistant、不催她回应（沿用 D-13 禁句表）
 *   5. D-005：只增不删，物理删除永久排除
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/memory');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');
const { SubjectState } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'd24-')); }
function freshBrain(dir) {
  return new Brain(dir || freshDir(), { ...DEFAULTS, apiKey: 'sk-test', selfGrowthEnabled: true });
}

console.log('--- D-24 便签入传门禁 ---');

/* ============ 1. A 段范围：只铸自发便签（范围拍板） ============ */
{
  const dir = freshDir();
  const m = new Memory(dir, { persona: 'P' });
  m.addSelfNote({ content: '她自发写下的字', name: 'a.txt', source: 'selfNote' });
  m.addSelfNote({ content: '受托写下的任务产物', name: 'b.txt', source: 'user' });
  m.addSelfNote({ content: '旧数据没有来源戳', name: 'c.txt' });
  const toEngrave = m.selfNotesToEngrave();
  check('只铸 source===selfNote 的便签', toEngrave.length === 1, 'got=' + toEngrave.length);
  check('自发便签内容原样取用', toEngrave[0] && toEngrave[0].content === '她自发写下的字');
  check('受托任务产物不铸（用户拍板边界）', !toEngrave.some((n) => n.content === '受托写下的任务产物'));
  check('旧数据无来源戳一律不铸（宁缺毋滥，不猜来源）', !toEngrave.some((n) => n.content === '旧数据没有来源戳'));
}

/* ============ 2. A 段铸造：入档 + noteId 写回 + 幂等 ============ */
{
  const dir = freshDir();
  const b = freshBrain(dir);
  b.memory.addSelfNote({ content: '安静里没有需要填满的东西。', name: 'note.md', source: 'selfNote' });
  const r = b._engraveSelfNotes(1);
  check('A 段铸造成功 1 条', r.minted === 1, 'minted=' + r.minted);
  check('facts 带【自发留痕事实】标注', r.facts.includes('【自发留痕事实】'));
  check('facts 带可回查引证 id', /selfnote-w1-/.test(r.facts));
  check('attestations 以 noteId 为键', r.attestations.size === 1 && [...r.attestations.keys()][0].startsWith('selfnote-w1-'));

  const records = b.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note');
  check('🔴 experiences.jsonl 里真有 self_note 记录', records.length === 1, 'got=' + records.length);
  const p = records[0] && records[0].payload;
  check('🔴 铸入内容零改写（与原文逐字相等）', p && p.content === '安静里没有需要填满的东西。');
  check('文件名只留 basename（沿用 D-13 口径）', p && p.name === 'note.md');
  check('noteId 写回记录供溯源', p && typeof p.noteId === 'string' && p.noteId.startsWith('selfnote-w1-'));

  const r2 = b._engraveSelfNotes(1);
  check('🔴 幂等：同一条便签终身只铸一次', r2.minted === 0, 'second=' + r2.minted);
  const again = b.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note');
  check('归档里没有第二条重复记录', again.length === 1);

  // 跨重启幂等（engraved 标记已落盘）—— 断言必须钉到字段级，
  //   否则「字段被载入归一化丢掉」会碰巧看起来像幂等（D-24 实测抓到过这个假绿）。
  const m2 = new Memory(dir, { persona: 'P' });
  const carried = m2.data.selfNotes[0] || {};
  check('🔴 载入保留 source 来源戳（丢了=漏铸）', carried.source === 'selfNote', 'source=' + carried.source);
  check('🔴 载入保留 engraved 标记（丢了=重铸击穿幂等）', carried.engraved === true, 'engraved=' + carried.engraved);
  check('🔴 跨重启不重铸（engraved 真落盘，不是字段丢失的巧合）',
    m2.selfNotesToEngrave().length === 0 && carried.engraved === true);
  check('noteId 已写回持久化记录', carried.noteId === ((p || {}).noteId));
}

/* ============ 3. 防坑锦囊 2：归档失败绝不置 engraved（不漏铸） ============ */
{
  const dir = freshDir();
  const b = freshBrain(dir);
  b.memory.addSelfNote({ content: '归档失败也要活下来的字', name: 'x.md', source: 'selfNote' });
  b.experiencesArchive = { appendRecord: () => false };
  const r = b._engraveSelfNotes(1);
  check('归档失败 ⇒ 铸造计数为 0', r.minted === 0);
  check('🔴 归档失败绝不置 engraved（下次关窗重试，绝不漏铸）', b.memory.selfNotesToEngrave().length === 1);
  b.experiencesArchive = new (require('../src/experiences-archive').ExperiencesArchive)(dir);
  const r2 = b._engraveSelfNotes(1);
  check('重试后补铸成功（不漏铸）', r2.minted === 1 && b.memory.selfNotesToEngrave().length === 0);
}

/* ============ 4. 🔴 铁律 1：铸造绝不进 system、绝不改写历史 ============ */
{
  const dir = freshDir();
  const m = new Memory(dir, { persona: 'P' });
  m.data.history = [{ role: 'user', content: '我回来了', messageId: 'm1' }];
  m.addSelfNote({ content: '她写下的字', name: 'n.md', source: 'selfNote' });
  m.build('');   // 先把注入消化掉（D-13 一次性语义）
  const sysBefore = JSON.stringify(m.build(''));
  const histBefore = JSON.stringify(m.data.history);
  m.markSelfNotesEngraved(m.selfNotesToEngrave(), ['selfnote-w1-x']);
  const sysAfter = JSON.stringify(m.build(''));
  const histAfter = JSON.stringify(m.data.history);
  check('🔴 铸造标记前后 systemText 逐字节相等（前缀缓存不变式）', sysBefore === sysAfter);
  check('🔴 铸造绝不改写 history', histBefore === histAfter);
  check('🔴 不新增任何冒充 assistant 的消息', !m.data.history.some((x) => x.role === 'assistant'));
}

/* ============ 5. B 段：成长反思端到端（stub API）—— 引证合法才入账 ============ */
{
  const dir = freshDir();
  const b = freshBrain(dir);
  b.memory.addSelfNote({ content: '我更愿意把安静留给自己。', name: 'n.md', source: 'selfNote' });
  const mint = b._engraveSelfNotes(1);
  const noteId = [...mint.attestations.keys()][0];

  // stub 成长调用：返回一条引证合法 selfnote 的条目 + 一条伪造引证的条目
  const growthPayload = JSON.stringify([
    {
      trait: '她把安静留给自己',
      support: [{ sourceType: 'SELF_INFERRED', window: 1, messageIds: [noteId], quote: '我更愿意把安静留给自己。', confidence: 0.8 }],
      oppose: [],
      traitHint: { trait: 'quiet_preference', direction: 1, strength: 1 }
    },
    {
      trait: '伪造引证的漂亮话',
      support: [{ sourceType: 'SELF_INFERRED', window: 1, messageIds: ['selfnote-w1-forged'], quote: '不存在的原话', confidence: 0.9 }],
      oppose: []
    }
  ]);
  b.api = {
    complete: async () => ({
      text: growthPayload,
      usage: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1, completion_tokens: 1 },
      observedModel: 'stub'
    })
  };
  const hints = [];
  const run = b.growSelf('对话', '小结', 1, {
    msgMap: new Map(),
    selfNoteFacts: mint.facts,
    selfNoteAttestations: mint.attestations,
    traitHintsOut: hints
  }).then((added) => {
    check('B 段：合法自发留痕引证的成长条目入账', added >= 1, 'added=' + added);
    check('B 段：伪造引证的条目被拒（NO_VERIFIABLE_EVIDENCE 同一套判据）',
      !b.selfLedger.entries.some((e) => e.trait === '伪造引证的漂亮话'));
    check('C 段取材口：只收引证了自发留痕的 traitHint', hints.length === 1 && hints[0].noteId === noteId,
      'hints=' + JSON.stringify(hints.map((h) => h.noteId)));
    check('traitHint 原样携带 trait/direction/strength（程序零代拟）',
      hints[0] && hints[0].trait === 'quiet_preference' && hints[0].direction === 1 && hints[0].strength === 1);

    /* ============ 6. C 段：核验 → Reducer → 归档 → commit ============ */
    const vBefore = b.subjectState.data.values.quiet_preference;
    const res = b._applySelfNoteTraitHints(hints, mint.attestations, new Map(), 1);
    const vAfter = b.subjectState.data.values.quiet_preference;
    check('🔴 C 段：合法证据让特质真实演进', vAfter !== vBefore, vBefore + ' -> ' + vAfter);
    check('🔴 单条便签 ≤ 单档步长（增量有界）', Math.abs(vAfter - vBefore) <= b.subjectState.stepWeight,
      'delta=' + (vAfter - vBefore));
    const scRec = b.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note_state');
    check('C 段增量已归档（Replay 可重放）', scRec.length === 1 && Array.isArray(scRec[0].payload.stateChanges));
    check('归档含 verifiedEvidence（Replay 对称消费口）',
      scRec[0] && Array.isArray(scRec[0].payload.verifiedEvidence) && scRec[0].payload.verifiedEvidence.length === 1);

    // Replay 对称：用归档记录重放出同样的最终值
    const replay = SubjectState.replay(scRec);
    check('🔴 Replay 重放与运行态增量一致（reducer 对称不变式）',
      replay && replay.finalState && replay.finalState.quiet_preference === (vAfter - vBefore),
      JSON.stringify(replay && replay.finalState && replay.finalState.quiet_preference) + ' vs ' + (vAfter - vBefore));

    /* ============ 7. C 段反例：四类伪造一律拒收、特质分毫不动 ============ */
    const v0 = b.subjectState.data.values.quiet_preference;
    const badQuote = b._applySelfNoteTraitHints(
      [{ noteId, quote: '这句不在便签里', trait: 'quiet_preference', direction: 1, strength: 1 }],
      mint.attestations, new Map(), 1);
    check('❌ 伪造 quote（非原文子串）⇒ 拒收、特质不动',
      badQuote && badQuote.added === 0 && b.subjectState.data.values.quiet_preference === v0);
    const badTrait = b._applySelfNoteTraitHints(
      [{ noteId, quote: '我更愿意把安静留给自己。', trait: 'kindness', direction: 1, strength: 1 }],
      mint.attestations, new Map(), 1);
    check('❌ trait 不在白名单 ⇒ 拒收、特质不动',
      badTrait && badTrait.added === 0 && b.subjectState.data.values.quiet_preference === v0);
    const badDir = b._applySelfNoteTraitHints(
      [{ noteId, quote: '我更愿意把安静留给自己。', trait: 'quiet_preference', direction: 1.5, strength: 1 }],
      mint.attestations, new Map(), 1);
    check('❌ direction 越界 ⇒ 拒收、特质不动',
      badDir && badDir.added === 0 && b.subjectState.data.values.quiet_preference === v0);
    const badId = b._applySelfNoteTraitHints(
      [{ noteId: 'selfnote-w1-forged', quote: '我更愿意把安静留给自己。', trait: 'quiet_preference', direction: 1, strength: 1 }],
      mint.attestations, new Map(), 1);
    check('❌ 伪造 noteId（证据池里不存在）⇒ 拒收、特质不动',
      badId && badId.added === 0 && b.subjectState.data.values.quiet_preference === v0);
    const noHints = b._applySelfNoteTraitHints([], mint.attestations, new Map(), 1);
    check('❌ 空证据（宁缺毋滥）⇒ 什么都不发生', noHints === null && b.subjectState.data.values.quiet_preference === v0);

    /* ============ 8. C 段限流（D-23 同款纪律） ============ */
    const dupRes = b._applySelfNoteTraitHints(
      [
        { noteId, quote: '我更愿意把安静留给自己。', trait: 'vitality', direction: 1, strength: 1 },
        { noteId, quote: '我更愿意把安静留给自己。', trait: 'vitality', direction: 1, strength: 1 }
      ], mint.attestations, new Map(), 1);
    const dupRec = b.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note_state').slice(-1)[0];
    check('同 noteId 去重：一条便签一窗口最多 1 个证据',
      dupRes && dupRes.added >= 0 && dupRec && dupRec.payload.verifiedEvidence.length === 1,
      'verified=' + (dupRec && dupRec.payload.verifiedEvidence.length));

    /* ============ 9. 归档失败 ⇒ 回滚暂存，增量绝不留在状态里 ============ */
    const vRoll = b.subjectState.data.values.vitality;
    const realAppend = b.experiencesArchive.appendRecord;
    b.experiencesArchive.appendRecord = () => false;
    const rollRes = b._applySelfNoteTraitHints(
      [{ noteId, quote: '我更愿意把安静留给自己。', trait: 'vitality', direction: 1, strength: 1 }],
      mint.attestations, new Map(), 1);
    b.experiencesArchive.appendRecord = realAppend;
    check('🔴 归档失败 ⇒ 回滚暂存、特质分毫不动（Replay 对称优先）',
      rollRes && rollRes.added === 0 && b.subjectState.data.values.vitality === vRoll,
      'v=' + b.subjectState.data.values.vitality);
  });

  // growSelf 是异步的：尾声放 then 链里收口
  run.then(async () => {
    /* ============ 10. 实机链路 E2E（真实模块，非 mock 业务逻辑） ============ */

    // 10a. 真实执行器回执的来源戳（proposalSource 是免确认闸门的命门，必须不可伪造）
    const { ControlledAgentExecutor } = require('../src/agent-executor');
    const { WriteTransactionManager } = require('../src/agent-transaction');
    const {
      PermissionPolicy, ExecutionBudget, AuditLog, createActionProposal,
    } = require('../src/agent-interfaces');
    const { UserConfirmationGate } = require('../src/agent-confirmation');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd24-exec-'));
    const sandbox = path.join(root, 'sandbox');
    fs.mkdirSync(sandbox);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd24-exec-data-'));
    // ⚠️ PermissionPolicy 默认 killSwitch=on（安全默认）—— 测试装配必须显式关掉，
    //   否则执行在闸门口被拒，验的就不是我们要验的那条链路（首轮实测踩过）。
    const policy = new PermissionPolicy({ killSwitch: false, allowed: ['workspace.read', 'workspace.write'] });
    policy.setScopeRoots('workspace.read', [sandbox]);
    policy.setScopeRoots('workspace.write', [sandbox]);
    const proposalStore = new Map();
    const executor = new ControlledAgentExecutor({
      policy,
      budget: new ExecutionBudget({}),
      confirmation: new UserConfirmationGate(),
      auditLog: new AuditLog({ dir: dataDir }),
      proposalStore,
      transactionManager: new WriteTransactionManager({ dir: dataDir }),
      fs,
    });

    const pSelf = createActionProposal({ capability: 'workspace.write', scope: path.join(sandbox, 'n.md') }, null, 'selfNote');
    proposalStore.set(pSelf.id, pSelf);
    const rSelf = executor.execute({ proposalId: pSelf.id, content: '她自发写下的字' });
    check('E2E：真实执行器回执带 selfNote 来源戳', rSelf.ok === true && rSelf.proposalSource === 'selfNote',
      'src=' + (rSelf && rSelf.proposalSource));

    const pUser = createActionProposal({ capability: 'workspace.write', scope: path.join(sandbox, 'u.md') });
    proposalStore.set(pUser.id, pUser);
    const gate2 = new UserConfirmationGate();
    const executor2 = new ControlledAgentExecutor({
      policy,
      budget: new ExecutionBudget({}),
      confirmation: gate2,
      auditLog: new AuditLog({ dir: dataDir }),
      proposalStore,
      transactionManager: new WriteTransactionManager({ dir: dataDir }),
      fs,
    });
    gate2.confirm(pUser.id, 'approved', { status: 'proposed' });
    const rUser = executor2.execute({ proposalId: pUser.id, content: '受托写的' });
    check('E2E：用户提案回执来源戳恒为 user（不可冒充自发）', rUser.ok === true && rUser.proposalSource === 'user');

    const forged = createActionProposal({ capability: 'workspace.write', scope: path.join(sandbox, 'f.md'), proposalSource: 'selfNote' });
    check('E2E：payload 自报 proposalSource 一律无效（第三参数是唯一入口）', forged.proposalSource === 'user');

    // 10b. 接线静态断言（house style：同 D1-11b 的 main.js 接线断言）
    const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-ipc.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('E2E：agent-ipc 把来源戳交给 onExecuted', /proposalSource:\s*String\(\(result && result\.proposalSource\)/.test(ipcSrc));
    check('E2E：main.js 把来源戳登记进 addSelfNote', /addSelfNote\(\{[^}]*source:\s*info\.proposalSource/.test(mainSrc));

    // 10c. 真实 closeWindow 全链（A→B→C 接线在 _closeWindowInternal 里真的被走到）
    const dirE = freshDir();
    const be = freshBrain(dirE);
    be.cfg.experimentModules = { sleepConsolidation: false, internalRegulation: false, biographicalCanalization: false };
    // 用真实 memory.append 播种（messageId/轮次簿记由生产代码生成，手搓 history 会过不了快照守卫）
    be.memory.append('user', '你好呀');
    be.memory.append('assistant', '我在。');
    be.memory.append('user', '今天就这样');
    be.memory.addSelfNote({ content: '把安静留给自己。', name: 'n.md', source: 'selfNote' });

    let growthUserContent = '';
    be.api = {
      complete: async (msgs) => {
        const sys = String((msgs && msgs[0] && msgs[0].content) || '');
        if (sys.includes('经历筛选器')) {
          // A 段在 growSelf 之前已铸 —— 从真实归档里取 noteId，做一次真引证
          const minted = be.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note');
          const noteId = minted[0] && minted[0].payload.noteId;
          growthUserContent = String((msgs && msgs[1] && msgs[1].content) || '');
          return {
            text: JSON.stringify([{
              trait: '她把安静留给自己',
              support: [{ sourceType: 'SELF_INFERRED', window: 1, messageIds: [noteId], quote: '把安静留给自己。', confidence: 0.8 }],
              oppose: [],
              traitHint: { trait: 'quiet_preference', direction: 1, strength: 1 },
            }]),
            usage: {},
          };
        }
        return { text: '小结文本', usage: {} };
      }
    };

    const closed = await be.closeWindow();
    check('E2E：真实关窗成功', closed === true, 'closed=' + closed);
    const realNotes = be.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note');
    check('E2E·A：真实关窗链路把便签铸进 experiences.jsonl', realNotes.length === 1, 'got=' + realNotes.length);
    check('E2E·B：成长反思上下文真的带上了【自发留痕事实】',
      growthUserContent.includes('【自发留痕事实】') && realNotes[0] && growthUserContent.includes(realNotes[0].payload.noteId));
    const vE = be.subjectState.data.values.quiet_preference;
    check('E2E·C：特质经正规通道真实演进', vE > 0, 'v=' + vE);
    check('E2E·C：增量有界（≤ 单档步长）', vE <= be.subjectState.stepWeight, 'v=' + vE + ' step=' + be.subjectState.stepWeight);
    const realState = be.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note_state');
    check('E2E·C：特质增量随记录归档', realState.length === 1 && realState[0].payload.stateChanges.length >= 1);
    const replayE = SubjectState.replay(realState);
    check('E2E：Replay 重放与运行态一致',
      replayE && replayE.finalState && replayE.finalState.quiet_preference === vE,
      JSON.stringify(replayE && replayE.finalState && replayE.finalState.quiet_preference) + ' vs ' + vE);

    // 真实链路幂等：第二次关窗不再铸、不再动特质
    be.memory.append('user', '又过了一窗');
    be.memory.append('assistant', '嗯。');
    await be.closeWindow();
    const notes2 = be.experiencesArchive.readAll().filter((x) => x.recordType === 'self_note');
    check('E2E：第二次关窗不重铸（真实链路幂等）', notes2.length === 1, 'got=' + notes2.length);
    check('E2E：第二次关窗特质分毫不再动', be.subjectState.data.values.quiet_preference === vE,
      'v=' + be.subjectState.data.values.quiet_preference);
  }).then(() => {
    console.log(failures === 0 ? '全部通过' : ('失败 ' + failures + ' 项'));
    process.exitCode = failures === 0 ? 0 : 1;
  }).catch((e) => {
    console.log('FAIL  测试异常 ' + (e && e.message));
    process.exitCode = 1;
  });
}
