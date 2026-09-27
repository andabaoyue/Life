/**
 * test/dream-provenance.test.js
 * 
 * Life v0.9.7 梦境溯源字段语义与确定性生成专项测试 (F-11 / F-15 / F-16)
 * 
 * 检验点：
 * 1. F-11 语义错位修复：evidenceId ≠ eventId ≠ messageId
 *    - 当 verifiedEvidence 包含 { evidenceId: 'ev-1', messageId: 'm-0001' } 时：
 *    - generationContext.sourceMessageRange 必须为 'm-0001'，绝非 'ev-1'
 *    - dreamPayload.sourceEvidenceIds 准确记录 ['ev-1']
 *    - dreamPayload.sourceEventIds 准确记录客观事件 ID
 * 2. 显式 sourceMessageRange 传递保持最高优先级
 * 3. F-15 确定性 ID 生成器注入 (idGenerator / dreamIdSuffix)：
 *    - 生产环境默认 Math.random 保持随机唯一
 *    - 实验/Replay 环境注入确定性 idGenerator 时梦境 ID 完全可重复
 * 4. F-16 显式时钟与时间注入：
 *    - evaluateDreamGate 支持 opts.clock.now()
 *    - synthesizeDream 支持 options.clock / options.now 注入
 */

const { synthesizeDream, evaluateDreamGate } = require('../src/dream-system');
const { computeCanonicalRecordHash } = require('../src/archive-integrity');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- Test Suite: Dream Provenance & Determinism (F-11, F-15, F-16) ---');

// 1. F-11 核心复现：验证 evidenceId 不再误写为 messageId
(async () => {
  const mockClient = {
    cfg: { model: 'deepseek-chat', provider: 'deepseek' },
    complete: async () => ({
      text: '模拟梦境文本：海潮拍打着岩石',
      observedModel: 'deepseek-chat',
      usage: { prompt_tokens: 100, completion_tokens: 50 }
    })
  };

  const verifiedEvidence = [
    { evidenceId: 'ev-special-001', messageId: 'm-000123', trait: 'quiet_preference', quote: '安静' }
  ];

  const dreamRecord = await synthesizeDream(
    mockClient,
    [{ role: 'user', content: 'prompt' }],
    {
      windowNo: 5,
      verifiedEvidence,
      sourceEvidenceIds: ['ev-special-001'],
      sourceEventIds: ['evt-000123'],
      dayResidues: [{ sourceType: 'evidence_quote', text: '安静' }]
    },
    {
      now: 1700000000000
    }
  );

  check('生成有效梦境记录', dreamRecord && dreamRecord.recordType === 'subject_dream');
  
  const genCtx = dreamRecord.generationContext;
  check('F-11: generationContext.sourceMessageRange.startMessageId 准确反映 messageId (m-000123)',
    genCtx && genCtx.sourceMessageRange && genCtx.sourceMessageRange.startMessageId === 'm-000123');
  check('F-11: generationContext 绝不把 evidenceId (ev-special-001) 误当做 startMessageId',
    genCtx && genCtx.sourceMessageRange && genCtx.sourceMessageRange.startMessageId !== 'ev-special-001');

  check('F-11: dreamRecord.sourceEvidenceIds 准确保留 evidenceId',
    Array.isArray(dreamRecord.sourceEvidenceIds) && dreamRecord.sourceEvidenceIds.includes('ev-special-001'));
  check('F-11: dreamRecord.sourceEventIds 准确保留 eventId',
    Array.isArray(dreamRecord.sourceEventIds) && dreamRecord.sourceEventIds.includes('evt-000123'));
  check('F-11: dreamRecord.sourceMessageRange 准确记录消息范围',
    dreamRecord.sourceMessageRange && dreamRecord.sourceMessageRange.startMessageId === 'm-000123');

  // 2. 显式传入 sourceMessageRange
  const dreamRecordWithRange = await synthesizeDream(
    mockClient,
    [{ role: 'user', content: 'prompt' }],
    {
      windowNo: 5,
      sourceMessageRange: { startMessageId: 'm-000010', endMessageId: 'm-000100', count: 91 },
      sourceEvidenceIds: ['ev-1', 'ev-2'],
      sourceEventIds: ['evt-1', 'evt-2']
    },
    { now: 1700000000000 }
  );
  check('显式 sourceMessageRange 正确注入 generationContext',
    dreamRecordWithRange.generationContext.sourceMessageRange.startMessageId === 'm-000010' &&
    dreamRecordWithRange.generationContext.sourceMessageRange.endMessageId === 'm-000100' &&
    dreamRecordWithRange.generationContext.sourceMessageRange.count === 91);

  // 3. F-15 确定性 ID 生成器注入与可复现性
  const detClock = { now: () => 1700000000000 };
  const detIdGen = (kind) => 'det-0001';

  const dream1 = await synthesizeDream(
    mockClient,
    [{ role: 'user', content: 'prompt' }],
    {
      windowNo: 6,
      sourceMessageIds: ['m-1', 'm-2'],
      idGenerator: detIdGen,
      clock: detClock
    },
    {
      clock: detClock,
      idGenerator: detIdGen
    }
  );

  const dream2 = await synthesizeDream(
    mockClient,
    [{ role: 'user', content: 'prompt' }],
    {
      windowNo: 6,
      sourceMessageIds: ['m-1', 'm-2'],
      idGenerator: detIdGen,
      clock: detClock
    },
    {
      clock: detClock,
      idGenerator: detIdGen
    }
  );

  check('F-15: 注入 deterministic idGenerator 时 dreamId 确定生成',
    dream1.dreamId.includes('det-0001') && dream1.dreamId === dream2.dreamId);
  check('F-15: 两次注入确定性时钟与 ID 生成器产物输出 hash 完全一致',
    dream1.outputHash === dream2.outputHash && dream1.promptHash === dream2.promptHash);

  // 4. F-16 显式时钟注入 evaluateDreamGate
  let gateClockCalled = false;
  const mockGateClock = {
    now: () => {
      gateClockCalled = true;
      return 1700000000000;
    }
  };
  const gateRes = evaluateDreamGate({
    windowNo: 3,
    arousalTrajectory: [0.8, 0.9, 0.8, 0.7, 0.85],
    noveltyScore: 0.8,
    stateHistory: [],
    verifiedEvidence: [{ trait: 'vitality' }],
    dreamHistory: [],
    clock: mockGateClock
  });
  check('F-16: evaluateDreamGate 支持注入时钟对象 opts.clock', gateClockCalled === true);
  check('F-16: 满足条件时门禁正常通过', gateRes && gateRes.allowDream === true);

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
