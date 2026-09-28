/**
 * test/r1-scenarios.test.js
 * 
 * 初澜数字生命实验：v0.9.4-R1 闭环与一致性专项验收测试集
 * 
 * 覆盖规范：
 * 场景 A: 真实消息 -> Event (Event.messageId 与真实消息强绑定)
 * 场景 B: Observation -> Event (Observation 引用不存在的 Event 被拒绝)
 * 场景 C: Interpretation -> Observation (Interpretation 引用不存在的 Observation 被拒绝)
 * 场景 D: 非法 Trait 过滤 (fake_trait 被 TRAIT_NOT_IN_WHITELIST 拒绝)
 * 场景 E: Duplicate Evidence 防重 (同一 evidence 重复提交被拒绝，状态只累加一次)
 * 场景 F: 历史 Reducer 参数重放 (历史 stepWeight=5，当前=20，Replay 精确还原历史参数 5)
 * 场景 G: 状态文件损坏自愈 (subject-state.json 损坏但归档完好，离线 Replay 重建状态并记录 recovery_event)
 * 场景 H: 归档写入失败原子回滚 (Archive append 失败，Subject State 回滚不提交，不丢原始对话)
 * 场景 I: 归档部分损坏标记 (experiences.jsonl 存在损坏行，Replay 标记 partial 与 uncertified)
 * 场景 J (E2E 集成): Brain 真实生产链路闭环，落盘完整包含三层事实与状态解释
 */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');
const { Memory } = require('../src/memory');
const { SubjectState, DEFAULT_TRAITS, ALLOWED_TRAITS } = require('../src/subject-state');
const { ExperiencesArchive } = require('../src/experiences-archive');
const {
  createEvent,
  validateEvent,
  createObservation,
  validateObservation,
  createInterpretation,
  validateInterpretation
} = require('../src/experience-schema');
const { createStateChange, createStateChangeExplanation } = require('../src/state-change');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'r1-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProvenanceForArchive(archive) {
  const hash = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
  const normalizeQuote = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const messageAttestations = [];
  const evidenceAttestations = [];
  for (const rec of archive.readAll()) {
    const p = rec.payload || {};
    for (const evt of (Array.isArray(p.events) ? p.events : [])) {
      const mid = evt && (evt.messageId || evt.payload?.messageId);
      if (!mid) continue;
      const content = evt.payload?.content ?? evt.content ?? '';
      messageAttestations.push({
        messageId: String(mid),
        sourceContentHash: hash(content),
        windowNo: rec.windowNo ?? p.windowNo ?? null,
        sourceRole: evt.source || evt.payload?.role || null,
        attestedAt: rec.timestamp || Date.now()
      });
    }
    for (const ev of (Array.isArray(p.verifiedEvidence) ? p.verifiedEvidence : [])) {
      if (!ev?.evidenceId || !ev?.messageId || !ev?.fingerprint) continue;
      evidenceAttestations.push({
        evidenceId: String(ev.evidenceId),
        fingerprint: String(ev.fingerprint),
        messageId: String(ev.messageId),
        quoteHash: hash(normalizeQuote(ev.quote)),
        windowNo: rec.windowNo ?? p.windowNo ?? null
      });
    }
  }
  if (!archive.updateProvenanceAttestations(messageAttestations, evidenceAttestations)) {
    throw new Error('failed to write provenance fixture');
  }
}

// -----------------------------------------------------------------------------
// 场景 A: 真实消息 -> Event (Event.messageId 与真实消息强绑定)
// -----------------------------------------------------------------------------
function testScenarioA() {
  const mockMsg = {
    messageId: 'm-000101',
    role: 'user',
    content: '初澜，今天看了一本关于数字生命的书。',
    t: Date.now()
  };

  const evt = createEvent({
    type: 'message',
    messageId: mockMsg.messageId,
    timestamp: mockMsg.t,
    source: mockMsg.role,
    payload: { content: mockMsg.content }
  });

  check('场景 A: Event.messageId 与真实消息 ID 强绑定', evt.messageId === mockMsg.messageId);
  const v = validateEvent(evt);
  check('场景 A: Event 验证通过 valid === true', v.valid === true);

  const invalidEvt = createEvent({ type: 'message', messageId: '' });
  delete invalidEvt.eventId;
  const vBad = validateEvent(invalidEvt);
  check('场景 A: 缺失 eventId 的非法 Event 被拒绝', vBad.valid === false && vBad.reason === 'MISSING_EVENT_ID');
}

// -----------------------------------------------------------------------------
// 场景 B: Observation -> Event (Observation 引用不存在的 Event 被拒绝)
// -----------------------------------------------------------------------------
function testScenarioB() {
  const realEvt = createEvent({
    type: 'message',
    messageId: 'm-000201',
    payload: { content: '今天下雨' }
  });
  const validEventIds = new Set([realEvt.eventId]);

  const validObs = createObservation({
    eventIds: [realEvt.eventId],
    content: '用户描述天气下雨'
  });
  const v1 = validateObservation(validObs, validEventIds);
  check('场景 B: 引用合法 Event 的 Observation 通过校验', v1.valid === true);

  const fakeObs = createObservation({
    eventIds: ['evt-non-existent-999'],
    content: '凭空捏造的事件观察'
  });
  const v2 = validateObservation(fakeObs, validEventIds);
  check('场景 B: 引用不存在 Event 的 Observation 被拒绝', v2.valid === false && v2.reason.includes('REFERENCED_EVENT_NOT_FOUND'));

  const emptyObs = createObservation({ eventIds: [], content: '无根基观察' });
  const v3 = validateObservation(emptyObs, validEventIds);
  check('场景 B: 无 eventIds 的 Observation 被拒绝', v3.valid === false && v3.reason === 'OBSERVATION_REQUIRES_EVENTS');
}

// -----------------------------------------------------------------------------
// 场景 C: Interpretation -> Observation (Interpretation 引用不存在的 Observation 被拒绝)
// -----------------------------------------------------------------------------
function testScenarioC() {
  const realObs = createObservation({
    eventIds: ['evt-000301'],
    content: '用户工作繁忙'
  });
  const validObsIds = new Set([realObs.observationId]);

  const validInterp = createInterpretation({
    observationIds: [realObs.observationId],
    content: '初澜感知到用户需要安静的陪伴'
  });
  const v1 = validateInterpretation(validInterp, validObsIds);
  check('场景 C: 引用合法 Observation 的 Interpretation 通过校验', v1.valid === true);

  const fakeInterp = createInterpretation({
    observationIds: ['obs-non-existent-999'],
    content: '凭空推断的主观解释'
  });
  const v2 = validateInterpretation(fakeInterp, validObsIds);
  check('场景 C: 引用不存在 Observation 的 Interpretation 被拒绝', v2.valid === false && v2.reason.includes('REFERENCED_OBSERVATION_NOT_FOUND'));

  const emptyInterp = createInterpretation({ observationIds: [], content: '无源解释' });
  const v3 = validateInterpretation(emptyInterp, validObsIds);
  check('场景 C: 无 observationIds 的 Interpretation 被拒绝', v3.valid === false && v3.reason === 'INTERPRETATION_REQUIRES_OBSERVATIONS');
}

// -----------------------------------------------------------------------------
// 场景 D: 非法 Trait 过滤 (fake_trait 被 TRAIT_NOT_IN_WHITELIST 拒绝)
// -----------------------------------------------------------------------------
function testScenarioD() {
  const dir = tmpDir('r1-trait-');
  const ss = new SubjectState(dir);
  const mockMsgs = [
    { messageId: 'm-000401', role: 'user', content: '我想要安静的环境' }
  ];

  const badEv = [
    { trait: 'fake_invented_trait', direction: 1, strength: 0.8, messageId: 'm-000401', quote: '安静的环境' },
    { trait: 'quiet_preference', direction: 1, strength: 0.8, messageId: 'm-000401', quote: '安静的环境' }
  ];

  const verifyRes = ss.verifyEvidence(badEv, mockMsgs);
  check('场景 D: 非法 trait 被核验拒绝', verifyRes.rejected.length === 1);
  check('场景 D: 拒绝原因为 TRAIT_NOT_IN_WHITELIST', verifyRes.rejected[0].reason === 'TRAIT_NOT_IN_WHITELIST');
  check('场景 D: 白名单内的合法 trait 通过核验', verifyRes.verified.length === 1 && verifyRes.verified[0].trait === 'quiet_preference');

  // Reducer 确保非法 trait 无法修改状态
  const reduceRes = ss.reduce(verifyRes.verified, 1);
  check('场景 D: Reducer 仅修改白名单特质', reduceRes.deltas.quiet_preference === 16 && reduceRes.deltas.fake_invented_trait === undefined);
}

// -----------------------------------------------------------------------------
// 场景 E: Duplicate Evidence 防重 (同一 evidence 重复提交被拒绝，状态只累加一次)
// -----------------------------------------------------------------------------
function testScenarioE() {
  const dir = tmpDir('r1-dedup-');
  const ss = new SubjectState(dir, { stepWeight: 20 });
  const mockMsgs = [
    { messageId: 'm-000501', role: 'user', content: '喜欢安静阅读' }
  ];

  const ev1 = {
    evidenceId: 'ev-fixed-001',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.5,
    messageId: 'm-000501',
    quote: '安静阅读'
  };

  // 重复 1：相同 evidenceId
  // 重复 2：不同 evidenceId 但相同语义指纹 (trait+dir+str+msgId+quote)
  const ev2_sameId = { ...ev1 };
  const ev3_sameFingerprint = { ...ev1, evidenceId: 'ev-fixed-002' };

  const verifyRes = ss.verifyEvidence([ev1, ev2_sameId, ev3_sameFingerprint], mockMsgs);
  check('场景 E: 仅首条证据通过核验', verifyRes.verified.length === 1);
  check('场景 E: 2 条重复证据全部被拦截拒绝', verifyRes.rejected.length === 2);
  check('场景 E: 捕获 DUPLICATE_EVIDENCE_ID', verifyRes.rejected.some(r => r.reason === 'DUPLICATE_EVIDENCE_ID'));
  check('场景 E: 捕获 DUPLICATE_EVIDENCE_FINGERPRINT', verifyRes.rejected.some(r => r.reason === 'DUPLICATE_EVIDENCE_FINGERPRINT'));

  // 执行 Reducer：状态只应累加 1 次 (0.5 * 20 = 10)
  const reduceRes = ss.reduce(verifyRes.verified, 1);
  check('场景 E: 状态增量只应用 1 次 (+10)', reduceRes.deltas.quiet_preference === 10);
  check('场景 E: 状态最终值为 10 而非重复后的 30', ss.values.quiet_preference === 10);
}

// -----------------------------------------------------------------------------
// 场景 F: 历史 Reducer 参数重放 (历史 stepWeight=5，当前=20，Replay 精确还原历史参数 5)
// -----------------------------------------------------------------------------
function testScenarioF() {
  const archiveRecords = [
    {
      schemaVersion: 1,
      recordType: 'window_summary',
      windowNo: 1,
      timestamp: 1000,
      payload: {
        reducer: { stepWeight: 5, maxDelta: 20 },
        verifiedEvidence: [
          { evidenceId: 'ev-hist-1', trait: 'quiet_preference', direction: 1, strength: 1.0 }
        ],
        stateChanges: [
          {
            trait: 'quiet_preference',
            delta: 5,
            previousValue: 0,
            newValue: 5,
            reducer: { stepWeight: 5, maxDelta: 20 }
          }
        ]
      }
    }
  ];

  // 全局默认配置 stepWeight = 20，但重放历史记录时应采用记录中的 5
  const replayReport = SubjectState.replay(archiveRecords, { stepWeight: 20, maxDeltaPerWindow: 50 });
  check('场景 F: Replay 采用历史记录中的 stepWeight=5 算得 delta=5', replayReport.finalState.quiet_preference === 5);
  check('场景 F: 未受默认 stepWeight=20 污染', replayReport.finalState.quiet_preference !== 20);
}

// -----------------------------------------------------------------------------
// 场景 G: 状态文件损坏自愈 (subject-state.json 损坏但归档完好，离线 Replay 重建状态并记录 recovery_event)
// -----------------------------------------------------------------------------
function testScenarioG() {
  const dir = tmpDir('r1-heal-');
  const archive = new ExperiencesArchive(dir);

  // 写入两轮正常的历史归档
  archive.appendRecord('window_summary', 1, {
    reducer: { stepWeight: 20, maxDelta: 50 },
    events: [
      { eventId: 'evt-w1-1', type: 'message', source: 'user', messageId: 'm-w1-1', payload: { content: '喜欢安静', roundNo: 1 } }
    ],
    verifiedEvidence: [
      { evidenceId: 'ev-w1-1', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-w1-1', quote: '喜欢安静', fingerprint: 'm-w1-1:喜欢安静:quiet_preference:1' } // +20
    ],
    stateChanges: [
      { trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20, reducer: { stepWeight: 20, maxDelta: 50 } }
    ]
  });

  archive.appendRecord('window_summary', 2, {
    reducer: { stepWeight: 20, maxDelta: 50 },
    events: [
      { eventId: 'evt-w2-1', type: 'message', source: 'user', messageId: 'm-w2-1', payload: { content: '喜欢陪伴', roundNo: 2 } }
    ],
    verifiedEvidence: [
      { evidenceId: 'ev-w2-1', trait: 'attachment_need', direction: 1, strength: 0.5, messageId: 'm-w2-1', quote: '喜欢陪伴', fingerprint: 'm-w2-1:喜欢陪伴:attachment_need:1' } // +10
    ],
    stateChanges: [
      { trait: 'attachment_need', delta: 10, previousValue: 0, newValue: 10, reducer: { stepWeight: 20, maxDelta: 50 } }
    ]
  });
  writeProvenanceForArchive(archive);

  // 故意写入损坏的 subject-state.json 文件
  const statePath = path.join(dir, 'subject-state.json');
  fs.writeFileSync(statePath, '{"values":{"quiet_preference": 999 [CORRUPTED_JSON_EOF');

  // 实例化 SubjectState 触发损坏自愈流程
  const ss = new SubjectState(dir);

  check('场景 G: 损坏状态自动通过 Replay 重建成功', ss.values.quiet_preference === 20 && ss.values.attachment_need === 10);
  check('场景 G: 窗口号准确恢复至最新窗口 + 1', ss.currentWindowNo === 3);

  // 检查现场损坏备份是否存在
  const dirFiles = fs.readdirSync(dir);
  const backup = dirFiles.find(f => f.startsWith('subject-state.json.corrupt.'));
  check('场景 G: 受损现场被备份至 .corrupt.<timestamp> 文件', !!backup);

  // 检查 experiences.jsonl 是否记录了 recovery_event
  const records = archive.readAll();
  const recoveryEvt = records.find(r => (r.recordType === 'recovery_event' || r.type === 'recovery_event'));
  check('场景 G: experiences.jsonl 追加记录了 recovery_event', !!recoveryEvt);
  check('场景 G: recovery_event 标记 action 为 state_rebuilt_from_replay',
    recoveryEvt && (recoveryEvt.payload?.action === 'state_rebuilt_from_replay' || recoveryEvt.action === 'state_rebuilt_from_replay'));
}

// -----------------------------------------------------------------------------
// 场景 H: 归档写入失败原子回滚 (Archive append 失败，Subject State 回滚不提交，不丢原始对话)
// -----------------------------------------------------------------------------
async function testScenarioH() {
  const dir = tmpDir('r1-rollback-');
  const mockApi = {
    complete: async () => ({
      text: JSON.stringify({
        windowSynthesis: {
          stableUserFacts: ['用户在赶报告'],
          subjectExperiences: ['初澜陪伴用户'],
          stateChangesSuggested: [
            { trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-h-001', quote: '好累想静静' }
          ]
        },
        segments: []
      }),
      usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }
    }),
    stream: async () => ({ text: 'ok', usage: {} })
  };

  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurnLimit: 2,
    keepTailMessages: 2
  });
  brain.api = mockApi;

  // 模拟填入对话
  brain.memory.append('user', '消息一：今天工作好累想静静');
  brain.memory.history[0].messageId = 'm-h-001';
  brain.memory.append('assistant', '消息二：好好休息哦');
  brain.memory.history[1].messageId = 'm-h-002';

  const initialValues = { ...brain.subjectState.values };
  const initialWindowNo = brain.subjectState.currentWindowNo;
  const initialHistoryLen = brain.memory.history.length;

  // 模拟 Archive 写入失败 (例如磁盘满或无写权限)
  brain.experiencesArchive.appendWindowArchive = () => false;

  const result = await brain.closeWindow();
  check('场景 H: 归档失败时 closeWindow 返回 false', result === false);
  check('场景 H: SubjectState 状态未提交并成功回滚',
    brain.subjectState.values.quiet_preference === initialValues.quiet_preference &&
    brain.subjectState.currentWindowNo === initialWindowNo);
  check('场景 H: 对话原始消息未被丢弃或裁剪', brain.memory.history.length === initialHistoryLen);
}

// -----------------------------------------------------------------------------
// 场景 I: 归档部分损坏标记 (experiences.jsonl 存在损坏行，Replay 标记 partial 与 uncertified)
// -----------------------------------------------------------------------------
function testScenarioI() {
  const dir = tmpDir('r1-partial-');
  const archivePath = path.join(dir, 'experiences.jsonl');

  const line1 = JSON.stringify({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 1000,
    payload: {
      verifiedEvidence: [{ evidenceId: 'ev-ok-1', trait: 'vitality', direction: 1, strength: 1.0 }]
    }
  });
  const badLine = '{"schemaVersion": 1, "recordType": "incomplete... BAD_JSON';
  const line2 = JSON.stringify({
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 2,
    timestamp: 2000,
    payload: {
      verifiedEvidence: [{ evidenceId: 'ev-ok-2', trait: 'vitality', direction: 1, strength: 1.0 }]
    }
  });

  fs.writeFileSync(archivePath, [line1, badLine, line2].join('\n') + '\n', 'utf8');

  const archive = new ExperiencesArchive(dir);
  const diag = archive.readAllWithDiagnostics();
  check('场景 I: 诊断读取准确识别跳过 1 行坏记录', diag.diagnostics.skippedCount === 1);

  // 执行 Replay 并传入诊断信息
  const replayReport = SubjectState.replay(diag.records, { diagnostics: diag.diagnostics, stepWeight: 20 });
  check('场景 I: 包含损坏记录时 replayStatus 标记为 partial', replayReport.replayStatus === 'partial');
  check('场景 I: 包含损坏记录时 integrity 标记为 uncertified', replayReport.integrity === 'uncertified');

  const consistency = SubjectState.checkConsistency({ values: replayReport.finalState }, replayReport);
  check('场景 I: checkConsistency 判定 certified 为 false (未认证)', consistency.certified === false);
}

// -----------------------------------------------------------------------------
// 场景 J (E2E 集成): Brain 真实生产链路闭环，落盘完整包含三层事实与状态解释
// -----------------------------------------------------------------------------
async function testScenarioJ_E2E() {
  const dir = tmpDir('r1-e2e-');
  const mockApi = {
    complete: async () => ({
      text: JSON.stringify({
        windowSynthesis: {
          stableUserFacts: ['用户是一名哲学研究者，喜欢安静独处'],
          subjectExperiences: ['初澜陪伴用户探讨生命的定义'],
          stateChangesSuggested: [
            {
              trait: 'quiet_preference',
              direction: 1,
              strength: 1.0,
              messageId: 'm-e2e-001',
              quote: '享受安静独处'
            },
            {
              trait: 'philosophical_curiosity',
              direction: 1,
              strength: 0.8,
              messageId: 'm-e2e-003',
              quote: '什么是数字生命的本质'
            }
          ]
        },
        segments: [
          {
            chulanExperience: ['与用户深入交流哲学概念'],
            userOfferings: ['分享关于数字生命认知的思考'],
            stateEvidence: []
          }
        ]
      }),
      usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 150 }
    }),
    stream: async () => ({ text: 'ok', usage: {} })
  };

  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurnLimit: 2,
    keepTailMessages: 2,
    subjectStateOpts: { stepWeight: 20, maxDeltaPerWindow: 50 }
  });
  brain.api = mockApi;

  // 写入两轮 4 条真实对话
  brain.memory.append('user', '初澜，我平日里总是享受安静独处。');
  brain.memory.history[0].messageId = 'm-e2e-001';
  brain.memory.append('assistant', '安静的生活很适合思考呢。');
  brain.memory.history[1].messageId = 'm-e2e-002';
  brain.memory.append('user', '你在想什么呢？什么是数字生命的本质？');
  brain.memory.history[2].messageId = 'm-e2e-003';
  brain.memory.append('assistant', '我觉得是记忆与关系的持续连接。');
  brain.memory.history[3].messageId = 'm-e2e-004';

  const closed = await brain.closeWindow();
  check('场景 J: Brain.closeWindow 执行成功', closed === true);

  // 验证 Subject State 状态变化
  check('场景 J: quiet_preference 状态正确累加 (+20)', brain.subjectState.values.quiet_preference === 20);
  check('场景 J: philosophical_curiosity 状态正确累加 (+16)', brain.subjectState.values.philosophical_curiosity === 16);
  check('场景 J: SubjectState 窗口号推进至 2', brain.subjectState.currentWindowNo === 2);

  // 验证 experiences.jsonl 归档内容完备性
  const archive = new ExperiencesArchive(dir);
  const records = archive.readAll();
  check('场景 J: experiences.jsonl 成功追加 1 条 window_archive', records.length === 1);

  const rec = (records[0] && records[0].payload) || records[0];
  check('场景 J: 归档包含 Event 列表且与真实 messageId 一致',
    Array.isArray(rec.events) && rec.events.length === 4 &&
    rec.events.some(e => e.messageId === 'm-e2e-001') &&
    rec.events.some(e => e.messageId === 'm-e2e-003'));

  check('场景 J: 归档包含 Observation 列表且溯源关联真实 Event',
    Array.isArray(rec.observations) && rec.observations.length > 0 &&
    rec.observations.every(o => Array.isArray(o.eventIds) && o.eventIds.length > 0));

  check('场景 J: 归档包含 Interpretation 列表且溯源关联真实 Observation',
    Array.isArray(rec.interpretations) && rec.interpretations.length > 0 &&
    rec.interpretations.every(i => Array.isArray(i.observationIds) && i.observationIds.length > 0));

  check('场景 J: 归档包含 verifiedEvidence 并成功匹配 messageId 与 quote',
    Array.isArray(rec.verifiedEvidence) && rec.verifiedEvidence.length === 2 &&
    rec.verifiedEvidence.some(ev => ev.trait === 'quiet_preference' && ev.quote === '享受安静独处'));

  check('场景 J: 归档包含 stateChanges 与 Reducer 运算结果一致',
    Array.isArray(rec.stateChanges) && rec.stateChanges.length === 2 &&
    rec.stateChanges.some(sc => sc.trait === 'quiet_preference' && sc.delta === 20) &&
    rec.stateChanges.some(sc => sc.trait === 'philosophical_curiosity' && sc.delta === 16));

  check('场景 J: 归档包含 explanations 且因果解释强核验一致',
    Array.isArray(rec.explanations) && rec.explanations.length === 2 &&
    rec.explanations.every(exp => exp.valid === true && exp.stateChangeId && exp.explanation && typeof exp.explanation.claimedDelta === 'number'));
}

// -----------------------------------------------------------------------------
// 最终一致性 Test A (P0-01): Archive Commit 成功但 State Commit 失败 -> recovery_pending -> Replay 恢复
// -----------------------------------------------------------------------------
async function testFinalConsistencyTestA() {
  const dir = tmpDir('r1-commit-fail-');
  const mockApi = {
    complete: async () => ({
      text: JSON.stringify({
        windowSynthesis: {
          stableUserFacts: ['用户在进行哲学研究'],
          subjectExperiences: ['初澜陪伴用户'],
          stateChangesSuggested: [
            { trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-fa-003', quote: '安静的思考环境' }
          ]
        },
        segments: []
      }),
      usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }
    }),
    stream: async () => ({ text: 'ok', usage: {} })
  };

  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurnLimit: 2,
    keepTailMessages: 2,
    subjectStateOpts: { stepWeight: 20 }
  });
  brain.api = mockApi;

  brain.memory.append('user', '初澜，我们在研究数字生命的哲学本质');
  brain.memory.history[0].messageId = 'm-fa-001';
  brain.memory.append('assistant', '我在听呢');
  brain.memory.history[1].messageId = 'm-fa-002';
  brain.memory.append('user', '我希望能保持安静的思考环境');
  brain.memory.history[2].messageId = 'm-fa-003';
  brain.memory.append('assistant', '好的，安静陪伴你');
  brain.memory.history[3].messageId = 'm-fa-004';

  // 模拟 State Commit 失败 (例如底层写盘瞬时报错或 EPERM)
  const origSave = brain.subjectState.save.bind(brain.subjectState);
  brain.subjectState.save = () => {
    throw new Error('EIO: simulated disk write failure on subject-state.json');
  };

  const closeRes = await brain.closeWindow();
  check('Test A: State commit 失败时 closeWindow 返回 false', closeRes === false);
  check('Test A: SubjectState 状态机标记 recoveryPending 为 true', brain.subjectState.recoveryPending === true);
  check('Test A: 原始 Message 未被丢弃（对话零丢失）', brain.memory.history.length === 4);

  // 检查 experiences.jsonl 是否保留了本次归档记录与 state_commit_failed 审计事件
  const records = brain.experiencesArchive.readAll();
  const windowArchive = records.find(r => r.type === 'window_archive' || r.recordType === 'window_archive');
  const commitFailedEvt = records.find(r => (r.recordType === 'recovery_event' || r.type === 'recovery_event') &&
    (r.payload?.action === 'state_commit_failed' || r.action === 'state_commit_failed'));
  check('Test A: Archive 成功落盘并完整保留 window_archive', !!windowArchive);
  check('Test A: Archive 记录了 recovery_event (state_commit_failed, recoveryPending: true)', !!commitFailedEvt);

  // 恢复磁盘写权限
  brain.subjectState.save = origSave;

  // 启动 Replay Recovery 修复
  const recoverSuccess = brain.subjectState.recoverFromPending(brain.experiencesArchive, 'state_commit_failed');
  check('Test A: Replay Recovery 执行成功', recoverSuccess === true);
  check('Test A: recoveryPending 标记已清除', brain.subjectState.recoveryPending === false);
  check('Test A: Subject State 成功重建并恢复至归档状态 (+20)', brain.subjectState.values.quiet_preference === 20);

  // 检查 experiences.jsonl 是否追加记录了 state_rebuilt_from_replay
  const recordsAfter = brain.experiencesArchive.readAll();
  const rebuiltEvt = recordsAfter.find(r =>
    (r.recordType === 'recovery_event' || r.type === 'recovery_event') &&
    (r.payload?.action === 'state_rebuilt_from_replay' || r.action === 'state_rebuilt_from_replay') &&
    (r.payload?.reason === 'state_commit_failed' || r.reason === 'state_commit_failed')
  );
  check('Test A: 恢复完成记录 recovery_event (action=state_rebuilt_from_replay, reason=state_commit_failed)', !!rebuiltEvt);
  check('Test A: 恢复记录包含 beforeValues 与 afterValues 状态摘要',
    !!(rebuiltEvt && rebuiltEvt.payload?.beforeValues && rebuiltEvt.payload?.afterValues));
}

// -----------------------------------------------------------------------------
// 最终一致性 Test B (P0-02): Evidence Fingerprint 移除 strength (修改 strength 无法绕过防重)
// -----------------------------------------------------------------------------
function testFinalConsistencyTestB() {
  const dir = tmpDir('r1-strength-');
  const ss = new SubjectState(dir, { stepWeight: 20 });
  const mockMsgs = [
    { messageId: 'm-str-001', role: 'user', content: '我非常喜欢安静的房间' }
  ];

  // 同一事实：仅 strength 不同 (0.3 vs 0.8)
  const ev1 = {
    evidenceId: 'ev-str-1',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.3,
    messageId: 'm-str-001',
    quote: '安静的房间'
  };

  const ev2 = {
    evidenceId: 'ev-str-2',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.8, // 模型妄图通过改变强度伪造成新证据
    messageId: 'm-str-001',
    quote: '安静的房间'
  };

  const verifyRes = ss.verifyEvidence([ev1, ev2], mockMsgs);
  check('Test B: 首次提交 (strength=0.3) 予以 ACCEPT 通过', verifyRes.verified.length === 1 && verifyRes.verified[0].evidenceId === 'ev-str-1');
  check('Test B: 二次提交 (strength=0.8) 必须拒绝 (DUPLICATE_EVIDENCE_FINGERPRINT)',
    verifyRes.rejected.length === 1 && verifyRes.rejected[0].reason === 'DUPLICATE_EVIDENCE_FINGERPRINT');
  check('Test B: Fingerprint 不包含 strength 字段',
    !verifyRes.verified[0].fingerprint.includes('0.3') && !verifyRes.verified[0].fingerprint.includes('0.8'));

  const reduceRes = ss.reduce(verifyRes.verified, 1);
  check('Test B: 状态仅应用一次增量 (0.3 * 20 = 6)', reduceRes.deltas.quiet_preference === 6 && ss.values.quiet_preference === 6);
}

// -----------------------------------------------------------------------------
// 最终一致性 Test C (P0-03): 严格定义 Event 真实来源边界 (排除 System/Summary/Bridge/Synthetic/Debug)
// -----------------------------------------------------------------------------
async function testFinalConsistencyTestC() {
  // 1. 架构级校验 validateEvent
  const fakeSysEvt = createEvent({
    type: 'message',
    messageId: 'm-sys-1',
    source: 'system_prompt',
    payload: { content: '人设内容' }
  });
  const vSys = validateEvent(fakeSysEvt);
  check('Test C: System Prompt 不得作为 Event (PROHIBITED_EVENT_SOURCE)',
    vSys.valid === false && vSys.reason.includes('PROHIBITED_EVENT_SOURCE'));

  const fakeBridgeEvt = createEvent({
    type: 'message',
    messageId: 'm-br-1',
    source: 'user',
    payload: { content: '桥接消息', bridge: true }
  });
  const vBridge = validateEvent(fakeBridgeEvt);
  check('Test C: Bridge 消息不得作为当前窗口新 Event (BRIDGE_EVENT_PROHIBITED)',
    vBridge.valid === false && vBridge.reason === 'BRIDGE_EVENT_PROHIBITED');

  const fakeSynthEvt = createEvent({
    type: 'message',
    messageId: 'm-syn-1',
    source: 'user',
    payload: { content: '主动搭话合成消息', synthetic: true }
  });
  const vSynth = validateEvent(fakeSynthEvt);
  check('Test C: Synthetic 消息不得作为主体 Event (SYNTHETIC_EVENT_PROHIBITED)',
    vSynth.valid === false && vSynth.reason === 'SYNTHETIC_EVENT_PROHIBITED');

  const fakeDebugEvt = createEvent({
    type: 'message',
    messageId: 'm-dbg-1',
    source: 'internal_debug',
    payload: { content: 'debug info' }
  });
  const vDebug = validateEvent(fakeDebugEvt);
  check('Test C: Internal Debug 不得作为 Event',
    vDebug.valid === false && vDebug.reason.includes('PROHIBITED_EVENT_SOURCE'));

  // 2. 生产链关窗过滤验证
  const dir = tmpDir('r1-boundary-');
  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurnLimit: 2,
    keepTailMessages: 2
  });
  brain.api = {
    complete: async () => ({
      text: JSON.stringify({
        windowSynthesis: { stableUserFacts: ['真实测试'], subjectExperiences: ['真实交互'] },
        segments: []
      }),
      usage: {}
    }),
    stream: async () => ({ text: 'ok', usage: {} })
  };

  // 注入混合消息：2 条真实消息，1 条 Bridge，1 条 Synthetic，1 条 System
  brain.memory.append('user', '真实用户消息一');
  brain.memory.history[0].messageId = 'm-real-001';

  brain.memory.append('assistant', '真实初澜回复二');
  brain.memory.history[1].messageId = 'm-real-002';

  brain.memory.append('user', '上一窗口残留 Bridge 消息');
  brain.memory.history[2].messageId = 'm-bridge-003';
  brain.memory.history[2].bridge = true;

  brain.memory.append('user', '程序主动搭话 Synthetic 消息');
  brain.memory.history[3].messageId = 'm-synth-004';
  brain.memory.history[3].synthetic = true;

  brain.memory.append('system', '系统人设提示词');
  brain.memory.history[4].messageId = 'm-sys-005';

  await brain.closeWindow();

  const archive = new ExperiencesArchive(dir);
  const recRaw = archive.readAll()[0];
  const rec = (recRaw && recRaw.payload) || recRaw;
  check('Test C: 归档 Event 列表仅包含真实交互 (恰好 2 条)', rec.events.length === 2);
  check('Test C: 真实用户消息进入 Event', rec.events.some(e => e.messageId === 'm-real-001'));
  check('Test C: 真实初澜回复进入 Event', rec.events.some(e => e.messageId === 'm-real-002'));
  check('Test C: Bridge 消息未进入 Event', !rec.events.some(e => e.messageId === 'm-bridge-003'));
  check('Test C: Synthetic 消息未进入 Event', !rec.events.some(e => e.messageId === 'm-synth-004'));
  check('Test C: System Prompt 未进入 Event', !rec.events.some(e => e.messageId === 'm-sys-005'));
}

// -----------------------------------------------------------------------------
// 最终一致性 Test D (P0-01/P1-01): 完整 Replay 认证与状态一致性 (Persisted State == Replay State 且 Certified)
// -----------------------------------------------------------------------------
function testFinalConsistencyTestD() {
  const dir = tmpDir('r1-cert-');
  const archive = new ExperiencesArchive(dir);

  archive.appendRecord('window_summary', 1, {
    reducer: { stepWeight: 20, maxDelta: 50 },
    events: [
      { eventId: 'evt-d-1', type: 'message', source: 'user', messageId: 'm-d-1', payload: { content: '安静阅读', roundNo: 1 } },
      { eventId: 'evt-d-2', type: 'message', source: 'user', messageId: 'm-d-2', payload: { content: '数字生命', roundNo: 2 } }
    ],
    verifiedEvidence: [
      { evidenceId: 'ev-d-1', trait: 'quiet_preference', direction: 1, strength: 1.0, messageId: 'm-d-1', quote: '安静阅读', fingerprint: 'm-d-1:安静阅读:quiet_preference:1' },
      { evidenceId: 'ev-d-2', trait: 'philosophical_curiosity', direction: 1, strength: 0.5, messageId: 'm-d-2', quote: '数字生命', fingerprint: 'm-d-2:数字生命:philosophical_curiosity:1' }
    ],
    stateChanges: [
      { trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20, reducer: { stepWeight: 20, maxDelta: 50 } },
      { trait: 'philosophical_curiosity', delta: 10, previousValue: 0, newValue: 10, reducer: { stepWeight: 20, maxDelta: 50 } }
    ]
  });
  writeProvenanceForArchive(archive);

  const ss = new SubjectState(dir);
  // 执行 Replay 重建状态
  ss.recoverFromPending(archive, 'init');

  // 1. 完整无损归档下的 Replay
  const { records, diagnostics } = archive.readAllWithDiagnostics();
  const replayClean = SubjectState.replay(records, { diagnostics, archivePath: archive.path });

  check('Test D: 完整归档下 Replay 输出 certified', replayClean.integrity === 'certified');
  check('Test D: 完整归档下 replayStatus 为 complete', replayClean.replayStatus === 'complete');
  check('Test D: 损坏记录数为 0', replayClean.corruptRecords === 0);

  const consistencyClean = SubjectState.checkConsistency({ values: ss.values }, replayClean);
  check('Test D: Persisted State 与 Replay State 数值完全匹配 (match === true)', consistencyClean.match === true);
  check('Test D: 状态一致性认证通过 (certified === true)', consistencyClean.certified === true);

  // 2. 模拟归档出现损坏行
  const archivePath = path.join(dir, 'experiences.jsonl');
  fs.appendFileSync(archivePath, '{"broken line TRUNCATED\n', 'utf8');

  const { records: recCorrupt, diagnostics: diagCorrupt } = archive.readAllWithDiagnostics();
  check('Test D: 诊断读取捕获损坏行 (skippedCount === 1)', diagCorrupt.skippedCount === 1);

  const replayCorrupt = SubjectState.replay(recCorrupt, { diagnostics: diagCorrupt });
  check('Test D: 存在损坏行时 Replay 输出 uncertified', replayCorrupt.integrity === 'uncertified');
  check('Test D: 存在损坏行时 replayStatus 为 partial', replayCorrupt.replayStatus === 'partial');

  const consistencyCorrupt = SubjectState.checkConsistency({ values: ss.values }, replayCorrupt);
  check('Test D: 归档有损时拒绝给出认证 (certified === false)', consistencyCorrupt.certified === false);
}

// =============================================================================
// v0.9.4-R2 最终收官修订专项测试 (E2-A/B/C/D, P0-05, P0-06, P1-01~P1-04)
// =============================================================================

/**
 * P0-04: 跨调用 / 跨重启 / 跨 Replay Evidence 持久化防重测试 (Test E2-A ~ E2-D)
 */
function testR2_PersistentEvidenceDedup() {
  const dir = tmpDir('r2-e2-dedup-');
  const ss1 = new SubjectState(dir, { stepWeight: 20 });
  const mockMsgs = [
    { messageId: 'm-r2-001', role: 'user', content: '我喜欢一个人静静地听雨声' }
  ];

  const evOriginal = {
    evidenceId: 'ev-r2-101',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.5,
    messageId: 'm-r2-001',
    quote: '静静地听雨声'
  };

  // Test E2-A: 跨调用防重 (第一次 verifyEvidence -> ACCEPT, 第二次 verifyEvidence -> REJECT)
  const resCall1 = ss1.verifyEvidence([evOriginal], mockMsgs, 1);
  check('Test E2-A: 首次调用 verifyEvidence -> ACCEPT', resCall1.verified.length === 1 && resCall1.rejected.length === 0);
  ss1.reduce(resCall1.verified, 1);
  check('Test E2-A: 首次 Reducer 应用增量 (+10)', ss1.values.quiet_preference === 10);

  const resCall2 = ss1.verifyEvidence([evOriginal], mockMsgs, 1);
  check('Test E2-A: 第二次调用 verifyEvidence (同一 evidenceId) -> REJECT',
    resCall2.verified.length === 0 && resCall2.rejected.length === 1 && resCall2.rejected[0].reason === 'DUPLICATE_EVIDENCE_ID');

  const evDiffIdSameFp = { ...evOriginal, evidenceId: 'ev-r2-102' };
  const resCall3 = ss1.verifyEvidence([evDiffIdSameFp], mockMsgs, 1);
  check('Test E2-A: 第二次调用 verifyEvidence (不同 ID 相同 fingerprint) -> REJECT',
    resCall3.verified.length === 0 && resCall3.rejected.length === 1 && resCall3.rejected[0].reason === 'DUPLICATE_EVIDENCE_FINGERPRINT');

  // Test E2-B: 跨进程重启防重 (Process A 落盘 subject-state.json -> Process B 重启读取 -> 相同 evidence REJECT)
  const ss2 = new SubjectState(dir, { stepWeight: 20 });
  const resRestartId = ss2.verifyEvidence([evOriginal], mockMsgs, 2);
  check('Test E2-B: 跨重启后提交相同 evidenceId -> REJECT',
    resRestartId.verified.length === 0 && resRestartId.rejected[0].reason === 'DUPLICATE_EVIDENCE_ID');

  const resRestartFp = ss2.verifyEvidence([evDiffIdSameFp], mockMsgs, 2);
  check('Test E2-B: 跨重启后提交相同 fingerprint -> REJECT',
    resRestartFp.verified.length === 0 && resRestartFp.rejected[0].reason === 'DUPLICATE_EVIDENCE_FINGERPRINT');

  // Test E2-D: 修改 strength 跨调用/跨重启仍被拒绝
  const evDiffStrength = { ...evOriginal, evidenceId: 'ev-r2-103', strength: 0.9 };
  const resStrength = ss2.verifyEvidence([evDiffStrength], mockMsgs, 2);
  check('Test E2-D: 跨重启修改 strength (0.5 -> 0.9) 提交 -> 仍然 REJECT',
    resStrength.verified.length === 0 && resStrength.rejected[0].reason === 'DUPLICATE_EVIDENCE_FINGERPRINT');

  // Test E2-C: Archive Replay 恢复 accepted fingerprints -> 重新提交历史 Evidence -> REJECT
  const dirReplay = tmpDir('r2-e2c-replay-');
  const archive = new ExperiencesArchive(dirReplay);
  archive.appendRecord('window_summary', 1, {
    reducer: { stepWeight: 20, maxDelta: 50 },
    // P1-02: Evidence 的 messageId 必须有真实消息/Event provenance
    events: [{ eventId: 'evt-e2c-1', type: 'message', source: 'user', messageId: resCall1.verified[0].messageId, timestamp: 1000, payload: { content: resCall1.verified[0].quote || 'q', roundNo: 1 } }],
    verifiedEvidence: [resCall1.verified[0]],
    stateChanges: [{ trait: 'quiet_preference', delta: 10, previousValue: 0, newValue: 10, reducer: { stepWeight: 20, maxDelta: 50 } }]
  });
  writeProvenanceForArchive(archive);

  // 模拟 state 损坏或丢失后通过 Replay 重建
  const ssRebuilt = new SubjectState(dirReplay, { stepWeight: 20 });
  ssRebuilt.recoverFromPending(archive, 'state_file_corrupted');
  check('Test E2-C: Replay 恢复后状态值为 +10', ssRebuilt.values.quiet_preference === 10);

  const resAfterReplay = ssRebuilt.verifyEvidence([{ ...evOriginal, evidenceId: 'ev-r2-999', strength: 0.8 }], mockMsgs, 2);
  check('Test E2-C: Replay 重建后重新提交历史 Evidence -> REJECT',
    resAfterReplay.verified.length === 0 && resAfterReplay.rejected[0].reason === 'DUPLICATE_EVIDENCE_FINGERPRINT');
}

/**
 * P0-05: Replay Window 聚合测试 (排除 recovery_event / diagnostic 等非状态记录)
 */
function testR2_ReplayWindowAggregation() {
  const records = [
    {
      schemaVersion: 1,
      recordType: 'window_summary',
      windowNo: 1,
      timestamp: 1000,
      payload: {
        verifiedEvidence: [{ evidenceId: 'ev-w1', trait: 'quiet_preference', direction: 1, strength: 0.5 }],
        stateChanges: [{ trait: 'quiet_preference', delta: 10, previousValue: 0, newValue: 10, reducer: { stepWeight: 20, maxDelta: 50 } }]
      }
    },
    {
      schemaVersion: 1,
      recordType: 'recovery_event',
      windowNo: 1,
      timestamp: 1500,
      payload: { action: 'state_commit_failed', reason: 'disk_busy' }
    },
    {
      schemaVersion: 1,
      recordType: 'diagnostic',
      windowNo: 1,
      timestamp: 1600,
      payload: { skippedCount: 0 }
    },
    {
      schemaVersion: 1,
      recordType: 'window_summary',
      windowNo: 2,
      timestamp: 2000,
      payload: {
        verifiedEvidence: [{ evidenceId: 'ev-w2', trait: 'philosophical_curiosity', direction: 1, strength: 1.0 }],
        stateChanges: [{ trait: 'philosophical_curiosity', delta: 20, previousValue: 0, newValue: 20, reducer: { stepWeight: 20, maxDelta: 50 } }]
      }
    },
    {
      schemaVersion: 1,
      recordType: 'recovery_event',
      windowNo: 2,
      timestamp: 2500,
      payload: { action: 'state_rebuilt_from_replay' }
    }
  ];

  const report = SubjectState.replay(records);
  check('P0-05: Replay 正确识别真实 Window (windowStates 长度严格为 2，绝非 5)', report.windowStates.length === 2);
  check('P0-05: windowStates 窗口序号严格为 [1, 2]',
    report.windowStates[0].windowNo === 1 && report.windowStates[1].windowNo === 2);
  check('P0-05: latestWindowNo === 2', report.latestWindowNo === 2);
  check('P0-05: nextWindowNo === 3 (max(actualWindowNo) + 1)', report.nextWindowNo === 3);
}

/**
 * P0-06: Recovery Integrity 测试 (COMPLETE vs PARTIAL/UNCERTIFIED vs INVALID)
 */
function testR2_RecoveryIntegrity() {
  // 1. 完整 Archive -> COMPLETE + CERTIFIED -> Recovery success
  const dir1 = tmpDir('r2-rec-complete-');
  const arch1 = new ExperiencesArchive(dir1);
  arch1.appendRecord('window_summary', 1, {
    reducer: { stepWeight: 20, maxDelta: 50 },
    events: [{ eventId: 'evt-rec-1', type: 'message', source: 'user', messageId: 'm-rec-1', payload: { content: '活力', roundNo: 1 } }],
    verifiedEvidence: [{ evidenceId: 'ev-rec-1', trait: 'vitality', direction: 1, strength: 1.0, messageId: 'm-rec-1', quote: '活力', fingerprint: 'm-rec-1:活力:vitality:1' }],
    stateChanges: [{ trait: 'vitality', delta: 20, previousValue: 0, newValue: 20, reducer: { stepWeight: 20, maxDelta: 50 } }]
  });
  writeProvenanceForArchive(arch1);
  const ss1 = new SubjectState(dir1);
  const ok1 = ss1.recoverFromPending(arch1, 'test_complete');
  check('P0-06: COMPLETE Archive 自动 Recovery 成功 (ok === true)', ok1 === true);
  check('P0-06: COMPLETE Recovery 状态为 NORMAL 且清除 recoveryPending',
    ss1.recoveryStatus === 'NORMAL' && ss1.recoveryPending === false);

  // 2. Archive 有坏行 -> PARTIAL + UNCERTIFIED -> Recovery 不得标记为 COMPLETE
  const dir2 = tmpDir('r2-rec-partial-');
  const arch2 = new ExperiencesArchive(dir2);
  arch2.appendRecord('window_summary', 1, {
    reducer: { stepWeight: 20, maxDelta: 50 },
    verifiedEvidence: [{ evidenceId: 'ev-rec-2', trait: 'vitality', direction: 1, strength: 1.0 }],
    stateChanges: [{ trait: 'vitality', delta: 20, previousValue: 0, newValue: 20, reducer: { stepWeight: 20, maxDelta: 50 } }]
  });
  fs.appendFileSync(path.join(dir2, 'experiences.jsonl'), '{"CORRUPT_LINE_TRUNCATED\n', 'utf8');

  const ss2 = new SubjectState(dir2);
  const ok2 = ss2.recoverFromPending(arch2, 'test_partial');
  check('P0-06: PARTIAL Archive 拒绝伪装为完整恢复 (ok === false)', ok2 === false);
  check('P0-06: PARTIAL Recovery 状态标记为 RECOVERY_UNCERTIFIED 并保留 recoveryPending',
    ss2.recoveryStatus === 'RECOVERY_UNCERTIFIED' && ss2.recoveryPending === true);

  const recEvents2 = arch2.readAll().filter(r => r.recordType === 'recovery_event');
  check('P0-06: PARTIAL Recovery 写入 action="recovery_uncertified" 审计事件',
    recEvents2.some(e => e.payload && e.payload.action === 'recovery_uncertified'));

  // 3. Archive 无法读取 / 无有效记录 -> INVALID -> Recovery failed，不覆盖已有有效 State
  const dir3 = tmpDir('r2-rec-invalid-');
  const ss3 = new SubjectState(dir3);
  ss3.data.values.quiet_preference = 88;
  ss3.save(true);
  const arch3 = new ExperiencesArchive(dir3); // 空归档
  const ok3 = ss3.recoverFromPending(arch3, 'test_invalid');
  check('P0-06: INVALID/空 Archive 恢复返回 false 且标记 RECOVERY_FAILED',
    ok3 === false && ss3.recoveryStatus === 'RECOVERY_FAILED');
  check('P0-06: INVALID Recovery 不覆盖已有有效 State (quiet_preference 仍为 88)',
    ss3.values.quiet_preference === 88);
}

/**
 * P1-01 & P1-02: Explanation 严格数值一致 & Event Type 白名单强制执行
 */
function testR2_StrictExplanationAndEventWhitelist() {
  // P1-01: 320 -> 347, delta = +27
  const sc = createStateChange({
    windowNo: 1,
    trait: 'quiet_preference',
    previousValue: 320,
    delta: 27,
    newValue: 347,
    evidenceIds: ['ev-27']
  });

  const expPass = createStateChangeExplanation(sc, {
    text: 'quiet_preference 增加 +27'
  });
  check('P1-01: Explanation delta = +27 (精确一致) -> PASS', expPass.valid === true);

  const expFail28 = createStateChangeExplanation(sc, {
    text: 'quiet_preference 增加 +28'
  });
  check('P1-01: Explanation delta = +28 (相差 1，消除 ±5 容差) -> FAIL',
    expFail28.valid === false && expFail28.reason === 'DELTA_MISMATCH');

  const expFail30 = createStateChangeExplanation(sc, {
    claimedDelta: 30,
    text: 'quiet_preference 增加 +30'
  });
  check('P1-01: Explanation delta = +30 -> FAIL',
    expFail30.valid === false && expFail30.reason === 'DELTA_MISMATCH');

  check('P1-01: 非法 Explanation 不影响 StateChange 本身 (delta 仍为 27, newValue 仍为 347)',
    sc.delta === 27 && sc.newValue === 347);

  // P1-02: Event Type 白名单强制执行
  const validEvt = createEvent({ type: 'desktop_motion', source: 'user' });
  check('P1-02: 白名单内 Event 类型 (desktop_motion) -> PASS', validateEvent(validEvt).valid === true);

  const disallowedEvt = createEvent({ type: 'arbitrary_custom_type', source: 'user' });
  const vDisallowed = validateEvent(disallowedEvt);
  check('P1-02: 非白名单 Event 类型 (arbitrary_custom_type) -> REJECT (EVENT_TYPE_NOT_ALLOWED)',
    vDisallowed.valid === false && vDisallowed.reason === 'EVENT_TYPE_NOT_ALLOWED');
}

/**
 * P1-03 & P1-04: 启动自动恢复与 Raw Archive / Replay / Persisted State 完整一致性测试
 */
function testR2_FullConsistencyAndStartupRecovery() {
  const dir = tmpDir('r2-full-consistency-');
  const archive = new ExperiencesArchive(dir);

  // 写入 Window 1 归档与未决 recovery_event
  archive.appendRecord('window_summary', 1, {
    reducer: { stepWeight: 20, maxDelta: 50 },
    // P1-02: Evidence 的 messageId 必须有真实消息/Event provenance
    events: [{ eventId: 'evt-fc-1', type: 'message', source: 'user', messageId: 'm-fc-1', timestamp: 500, payload: { content: '哲思时刻', roundNo: 1 } }],
    verifiedEvidence: [
      { evidenceId: 'ev-fc-1', messageId: 'm-fc-1', quote: '哲思时刻', trait: 'philosophical_curiosity', direction: 1, strength: 1.0, fingerprint: 'm-fc-1:哲思时刻:philosophical_curiosity:1' }
    ],
    stateChanges: [
      { trait: 'philosophical_curiosity', delta: 20, previousValue: 0, newValue: 20, reducer: { stepWeight: 20, maxDelta: 50 } }
    ]
  });
  archive.appendRecord('recovery_event', 1, {
    action: 'state_commit_failed',
    recoveryPending: true
  });
  writeProvenanceForArchive(archive);

  // 写入落后的 subject-state.json (Window 1 尚未提交，值为 0)
  fs.writeFileSync(path.join(dir, 'subject-state.json'), JSON.stringify({
    schemaVersion: 1,
    windowNo: 1,
    values: { ...DEFAULT_TRAITS }
  }), 'utf8');

  // P1-03: 下一次启动 SubjectState 自动检测并执行 Replay 恢复
  const ss = new SubjectState(dir);
  check('P1-03: 下一次启动自动通过 Archive Replay 恢复状态 (+20)', ss.values.philosophical_curiosity === 20);
  check('P1-03: 恢复后 nextWindowNo 准确为 2 (recovery_event 未拉高窗口号)', ss.currentWindowNo === 2);

  // P1-04: Raw Archive -> Replay -> Persisted State 三方完整一致性
  const { records, diagnostics } = archive.readAllWithDiagnostics();
  const replayRep = SubjectState.replay(records, { diagnostics, archivePath: archive.path });
  const consistency = SubjectState.checkConsistency(ss, replayRep);

  check('P1-04: State values / WindowNo / Accepted Evidence / StateChanges 全部一致',
    consistency.match === true &&
    consistency.windowNoMatch === true &&
    consistency.acceptedEvidenceMatch === true &&
    consistency.stateChangesMatch === true);
  check('P1-04: Certified Archive 下 Consistency status === PASS',
    consistency.certified === true && consistency.status === 'PASS');

  // 注入损坏行后即使数值相同，Consistency 也必须为 NOT_CERTIFIED
  fs.appendFileSync(path.join(dir, 'experiences.jsonl'), '{"CORRUPT_TAIL\n', 'utf8');
  const { records: rec2, diagnostics: diag2 } = archive.readAllWithDiagnostics();
  const replayUncert = SubjectState.replay(rec2, { diagnostics: diag2 });
  const consistencyUncert = SubjectState.checkConsistency(ss, replayUncert);
  check('P1-04: Uncertified Archive 下即使数值相同也必须返回 status === NOT_CERTIFIED',
    consistencyUncert.match === true && consistencyUncert.certified === false && consistencyUncert.status === 'NOT_CERTIFIED');
}

async function runAll() {
  console.log('====================================================');
  console.log('    初澜 v0.9.4-R2 闭环、防重与最终收官验收测试集     ');
  console.log('====================================================\n');

  testScenarioA();
  testScenarioB();
  testScenarioC();
  testScenarioD();
  testScenarioE();
  testScenarioF();
  testScenarioG();
  await testScenarioH();
  testScenarioI();
  await testScenarioJ_E2E();

  await testFinalConsistencyTestA();
  testFinalConsistencyTestB();
  await testFinalConsistencyTestC();
  testFinalConsistencyTestD();

  // R2 新增专项验收
  testR2_PersistentEvidenceDedup();
  testR2_ReplayWindowAggregation();
  testR2_RecoveryIntegrity();
  testR2_StrictExplanationAndEventWhitelist();
  testR2_FullConsistencyAndStartupRecovery();

  console.log('\n====================================================');
  console.log(failures ? `${failures} 项失败` : '全部通过');
  console.log('====================================================');
  process.exit(failures ? 1 : 0);
}

runAll();
