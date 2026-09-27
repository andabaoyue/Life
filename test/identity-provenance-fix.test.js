/**
 * 定点收尾修复回归测试 (Fixed-Point Repair Regressions)
 *
 * 问题 1：Experiment Initial State Identity 必须覆盖 reducer 参数
 *   - initialStateA/B.subjectState 注入的 stepWeight / maxDeltaPerWindow 直接决定
 *     SubjectState.reduce() 的增量步长与单窗口变动限额（真正影响 trajectory），
 *     必须参与初始状态同一性认证；mismatch 必须被拦截。
 *   - 注入值必须真正作用于执行（与前置条件核验阶段对称），认证的初始状态 = 执行的初始状态。
 *
 * 问题 2：Dream Event 溯源禁止"无法证明 → 全窗口归因"
 *   - verified evidence 能证明 Event 来源 → sourceEventIds 只含被证明的 eventId；
 *   - 不能证明 → sourceEventIds 为 []，并以 eventProvenanceStatus 显式标记 provenance 缺口；
 *   - 多 event 窗口严禁把未被证据关联的事件无依据全部归因给梦境。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPathDependencyExperiment } = require('../src/path-dependency');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');
const { synthesizeDream, buildDreamSynthesisPrompt } = require('../src/dream-system');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'life-identity-fix-'));
}

const baseCfg = { experimentMode: 'enabled', experimentModules: { internalRegulation: true } };
const evidenceEvent = {
  type: 'evidence',
  windowNo: 1,
  evidenceList: [{
    evidenceId: 'ev-fix-001',
    messageId: 'm-000001',
    quote: '保持安静的生活节奏',
    trait: 'quiet_preference',
    direction: 1,
    strength: 1,
    sourceType: 'dialogue',
    sourceWindow: 1
  }]
};

// ==========================================
// 1. stepWeight mismatch 必须被初始状态同一性拦截
// ==========================================
{
  const r = runPathDependencyExperiment({
    sequenceA: [], sequenceB: [],
    config: baseCfg,
    initialStateA: { subjectState: { stepWeight: 20 } },
    initialStateB: { subjectState: { stepWeight: 5 } }
  });
  check('stepWeight 不一致被 Initial State Identity 拦截 (PATH_EXPERIMENT_INITIAL_STATE_MISMATCH)',
    r.valid === false && r.reason === 'PATH_EXPERIMENT_INITIAL_STATE_MISMATCH');
  check('stepWeight mismatch 标记 initialStateEqual=false',
    r.preconditions && r.preconditions.initialStateEqual === false);
}

// ==========================================
// 2. maxDeltaPerWindow mismatch 必须被初始状态同一性拦截
// ==========================================
{
  const r = runPathDependencyExperiment({
    sequenceA: [], sequenceB: [],
    config: baseCfg,
    initialStateA: { subjectState: { maxDeltaPerWindow: 50 } },
    initialStateB: { subjectState: { maxDeltaPerWindow: 10 } }
  });
  check('maxDeltaPerWindow 不一致被 Initial State Identity 拦截 (PATH_EXPERIMENT_INITIAL_STATE_MISMATCH)',
    r.valid === false && r.reason === 'PATH_EXPERIMENT_INITIAL_STATE_MISMATCH');
  check('maxDeltaPerWindow mismatch 标记 initialStateEqual=false',
    r.preconditions && r.preconditions.initialStateEqual === false);
}

// ==========================================
// 3. 相同非默认 reducer 参数放行，且注入真正作用于执行
// ==========================================
{
  const r = runPathDependencyExperiment({
    sequenceA: [evidenceEvent], sequenceB: [evidenceEvent],
    config: baseCfg,
    initialStateA: { subjectState: { stepWeight: 5, maxDeltaPerWindow: 50 } },
    initialStateB: { subjectState: { stepWeight: 5, maxDeltaPerWindow: 50 } },
    clock: { now: () => 1000 }
  });
  // effectiveStepWeight=5 -> quiet_preference 增量 = 1*1*5 = 5（默认 stepWeight=20 会得 20）
  check('相同非默认 reducer 参数放行且注入值真正作用于 reduce (增量=5 而非默认 20)',
    r.valid === true && r.trajectoryA.subjectState.quiet_preference === 5,
    `valid=${r.valid}, quiet_preference=${r.trajectoryA && r.trajectoryA.subjectState && r.trajectoryA.subjectState.quiet_preference}`);
}

// ==========================================
// 4/5. Dream Event 溯源：多 event 窗口 + 部分关联 / 无关联
// ==========================================
async function runDreamScenario(mode) {
  const dir = tmpDir();
  const brain = new Brain(dir, {
    ...DEFAULTS,
    apiKey: 'sk-test',
    baseURL: 'https://api.deepseek.com',
    provider: 'deepseek',
    experimentMode: 'experimental',
    experimentModules: {
      internalRegulation: true,
      biographicalCanalization: true,
      sleepConsolidation: true
    },
    keepTailMessages: 0
  });

  let msgIds = [];
  brain.api.stream = async (messages, onDelta) => {
    onDelta('好的，我在听。');
    return { text: '好的，我在听。', observedModel: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  brain.api.complete = async (messages) => {
    const content = String(messages[messages.length - 1].content);
    if (content.includes('小结') || content.includes('【对话】')) {
      const stateEvidence = mode === 'partial'
        ? [{ messageId: msgIds[0], quote: '保持安静的生活节奏', trait: 'quiet_preference', direction: 1, strength: 1 }]
        : [{ messageId: msgIds[0], quote: '机械猫测试内容片段', trait: 'quiet_preference', direction: 1, strength: 1 }];
      return {
        text: JSON.stringify({
          windowSynthesis: {
            stableUserFacts: ['事实一', '事实二'],
            subjectExperiences: ['体验一', '体验二'],
            stateExplanations: { quiet_preference: { claimedTrait: 'quiet_preference', text: '用户表达了安静偏好' } }
          },
          segments: [{ range: '1-20', userGiven: ['测试'], chulanExperience: ['体验'], stateEvidence, uncertainties: [] }]
        }),
        observedModel: 'deepseek-chat', usage: { prompt_tokens: 50, completion_tokens: 20 }
      };
    }
    if (content.includes('梦')) {
      return { text: '梦境叙事：在安静的房间里回想白天的事。', observedModel: 'deepseek-chat', usage: { prompt_tokens: 30, completion_tokens: 15 } };
    }
    return { text: '自我认知更新测试', observedModel: 'deepseek-chat', usage: { prompt_tokens: 20, completion_tokens: 10 } };
  };

  if (mode === 'partial') {
    await brain.ask('今天的交流让我想保持安静的生活节奏。', () => {});
    await brain.ask('第二条消息用于制造多事件窗口。', () => {});
  } else {
    await brain.ask('【对话】CHAT-PREFIX 机械猫测试内容片段', () => {});
    await brain.ask('今天想聊聊安静生活的话题。', () => {});
  }
  msgIds = brain.memory.data.history.filter(m => !m.synthetic && !m.bridge).map(m => m.messageId);

  await brain.closeWindow('turn_limit');

  const dreamRecord = (brain.dreamHistory || [])[(brain.dreamHistory || []).length - 1] || null;
  const winRec = brain.experiencesArchive.readAll().find(r => (r.recordType || r.type) === 'window_summary');
  const winEvents = (winRec && winRec.payload && Array.isArray(winRec.payload.events)) ? winRec.payload.events : [];
  return { dreamRecord, winEvents, msgIds };
}

(async () => {
  // ---- 案例 A：多 event 窗口，仅一个事件被证据明确关联（partial provenance）----
  {
    const { dreamRecord, winEvents, msgIds } = await runDreamScenario('partial');
    const srcIds = dreamRecord ? dreamRecord.sourceEventIds : null;
    const linked = winEvents.filter(e => Array.isArray(srcIds) && srcIds.includes(e.eventId));
    check('partial: sourceEventIds 只含被证据关联的 Event（不把整个窗口算进来）',
      dreamRecord && Array.isArray(srcIds) && srcIds.length === 1 && linked.length === 1,
      `sourceEventIds=${JSON.stringify(srcIds)}, windowEvents=${winEvents.length}`);
    check('partial: 多 event 窗口禁止无依据全量归因（未关联事件绝不进入 sourceEventIds）',
      dreamRecord && winEvents.length > 1 &&
      winEvents.every(e => e.messageId !== msgIds[0] ? !srcIds.includes(e.eventId) : true) &&
      srcIds.length < winEvents.length,
      `linked=${linked.length}, windowEvents=${winEvents.length}`);
    check('dream 记录与 payload 的溯源字段镜像一致 (sourceEventIds + eventProvenanceStatus)',
      dreamRecord &&
      JSON.stringify(dreamRecord.payload.sourceEventIds) === JSON.stringify(dreamRecord.sourceEventIds) &&
      dreamRecord.payload.eventProvenanceStatus === dreamRecord.eventProvenanceStatus &&
      dreamRecord.eventProvenanceStatus === 'evidence_linked');
  }

  // ---- 案例 B：证据存在但无法建立 Event 来源（missing provenance）----
  {
    const { dreamRecord, winEvents } = await runDreamScenario('missing');
    check('missing: 无法证明 Event 来源时 sourceEventIds=[] 且 eventProvenanceStatus=unavailable（严禁全窗口扩大归因）',
      dreamRecord && Array.isArray(dreamRecord.sourceEventIds) && dreamRecord.sourceEventIds.length === 0 &&
      dreamRecord.eventProvenanceStatus === 'unavailable',
      `sourceEventIds=${dreamRecord ? JSON.stringify(dreamRecord.sourceEventIds) : 'null'}, status=${dreamRecord && dreamRecord.eventProvenanceStatus}`);
    check('missing: 窗口确实存在 Event（区分 unavailable 与 no_window_events，归因缺口如实标记）',
      winEvents.length > 0 && dreamRecord && dreamRecord.eventProvenanceStatus === 'unavailable',
      `windowEvents=${winEvents.length}`);
  }

  // ---- 案例 C：dream-system 派生规则（显式 ID / 空 ID）----
  {
    const apiMock = { complete: async () => ({ text: '梦境叙事', observedModel: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    const prompt = buildDreamSynthesisPrompt([], 1);
    const recWith = await synthesizeDream(apiMock, prompt, {
      windowNo: 1, sourceEventIds: ['evt-000001'], sourceEvents: [{ eventId: 'evt-000001' }]
    }, { now: 1000 });
    const recWithout = await synthesizeDream(apiMock, prompt, {
      windowNo: 2, sourceEventIds: [], sourceEvents: [{ eventId: 'evt-000002' }]
    }, { now: 2000 });
    check('dream-system: 显式 sourceEventIds → evidence_linked，空 sourceEventIds → unavailable',
      recWith && recWith.eventProvenanceStatus === 'evidence_linked' &&
      recWithout && recWithout.eventProvenanceStatus === 'unavailable',
      `with=${recWith && recWith.eventProvenanceStatus}, without=${recWithout && recWithout.eventProvenanceStatus}`);
  }

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exitCode = failures ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 1; });
