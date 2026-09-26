/**
 * test/dream-synthesis.test.js
 * 
 * Life v0.9.7 梦境合成、弗洛伊德结构与认识论防线专项测试
 * 
 * 检验点：
 * 1. 日间遗留 (extractDayResidues) 提炼：
 *    - 提取高显著性证据引文与尾部活跃对话残余，绝不传输完整 100 轮对话
 * 2. 提示词结构 (buildDreamSynthesisPrompt)：
 *    - 包含日间遗留、凝缩 (Condensation) 与移位 (Displacement) 指令
 * 3. 梦境记录 Schema 与认识论隔离 (DREAM_GENERATED_ARTIFACT)：
 *    - 包含 recordType: 'subject_dream'
 *    - epistemicStatus 严格声明为 DREAM_GENERATED_ARTIFACT
 *    - 生成确定性 promptHash 与 outputHash
 * 4. 容灾隔离 (Fail-Safe)：
 *    - API 异常/超时不抛错，安全返回 null，不阻断主流程
 * 5. 认识论防线严密性：
 *    - 梦境产物绝对禁止直接输入 SubjectState Reducer，状态向量零变化
 */

const {
  extractDayResidues,
  buildDreamSynthesisPrompt,
  synthesizeDream
} = require('../src/dream-system');
const { MEMORY_EPISTEMIC_STATUS } = require('../src/experiment-types');
const { SubjectState } = require('../src/subject-state');
const os = require('os');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// -------------------------------------------------------------
// 1. 日间遗留提取：轻量非全量
// -------------------------------------------------------------
{
  const activeItems = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}`,
    bridge: false
  }));

  const verifiedEvidence = [
    { trait: 'vitality', quote: 'I walked ten miles today.' },
    { trait: 'quiet_preference', quote: 'I love reading in silence.' }
  ];

  const residues = extractDayResidues(activeItems, verifiedEvidence);
  check('日间遗留条目数量受限 (<= 6)', residues.length <= 6 && residues.length > 0);
  check('包含证据中的高显著性引文', residues.some(r => r.text.includes('ten miles')));
  check('包含尾部对话残余', residues.some(r => r.text.includes('Message 19')));
}

// -------------------------------------------------------------
// 2. 提示词结构：弗洛伊德凝缩与移位指令
// -------------------------------------------------------------
{
  const residues = [
    { sourceType: 'evidence_quote', text: 'Error in code compilation' },
    { sourceType: 'tail_conversation', text: 'Rain is falling heavily outside' }
  ];

  const prompt = buildDreamSynthesisPrompt(residues, 3);
  check('返回 system 与 user 两条消息', Array.isArray(prompt) && prompt.length === 2);
  check('system 包含日间遗留说明', prompt[0].content.includes('日间遗留'));
  check('system 包含凝缩 (Condensation) 说明', prompt[0].content.includes('凝缩'));
  check('system 包含移位 (Displacement) 说明', prompt[0].content.includes('移位'));
  check('user 包含传入的残余内容', prompt[1].content.includes('Rain is falling'));
}

// -------------------------------------------------------------
// 3. 梦境合成与认识论制品落盘结构
// -------------------------------------------------------------
(async () => {
  const mockClient = {
    cfg: { model: 'deepseek-chat' },
    complete: async () => ({
      text: '在幽蓝的深海之下，一台湿透的发报机正在断断续续敲击着无声的代码，窗外的雨声变成了海潮。',
      usage: { prompt_tokens: 150, completion_tokens: 60 }
    })
  };

  const dreamRecord = await synthesizeDream(
    mockClient,
    [{ role: 'user', content: 'test' }],
    { windowNo: 7, sourceEventIds: ['ev-1'] }
  );

  check('生成有效梦境记录对象', dreamRecord && typeof dreamRecord === 'object');
  check('recordType 为 subject_dream', dreamRecord.recordType === 'subject_dream');
  check('windowNo 准确对齐', dreamRecord.windowNo === 7);
  check('包含有效的 dreamId', typeof dreamRecord.dreamId === 'string' && dreamRecord.dreamId.startsWith('dream-w7-'));
  check('epistemicStatus 为 DREAM_GENERATED_ARTIFACT', dreamRecord.epistemicStatus === MEMORY_EPISTEMIC_STATUS.DREAM_GENERATED_ARTIFACT);
  check('包含 SHA-256 promptHash', typeof dreamRecord.promptHash === 'string' && dreamRecord.promptHash.length === 64);
  check('包含 SHA-256 outputHash', typeof dreamRecord.outputHash === 'string' && dreamRecord.outputHash.length === 64);
  check('内容保留完整的象征性叙述', dreamRecord.content.includes('发报机'));

  // -------------------------------------------------------------
  // 4. 容灾隔离 (Fail-Safe)：API 抛错不中断
  // -------------------------------------------------------------
  const failingClient = {
    complete: async () => { throw new Error('Simulated DeepSeek Timeout 504'); }
  };

  const safeResult = await synthesizeDream(failingClient, [{ role: 'user', content: 'test' }], { windowNo: 8 });
  check('API 失败时优雅捕获并返回 null，不抛出未捕获异常', safeResult === null);

  // -------------------------------------------------------------
  // 5. 认识论防线严密性：梦境产物不入 SubjectState Reducer
  // -------------------------------------------------------------
  const dir = os.tmpdir();
  const state = new SubjectState(dir);
  const initialValues = { ...state.data.values };

  // 尝试将梦境制品传入 reduce (应当被忽略或无法通过证据核验)
  const reductionAttempt = state.reduce([dreamRecord], 7);
  check('非合法 Trait 证据无法对 SubjectState 造成任何数值改变',
    JSON.stringify(state.data.values) === JSON.stringify(initialValues)
  );

  // -------------------------------------------------------------
  // 6. 归档写入与完整性服务认证闭环 (P0 核心修复验证)
  // -------------------------------------------------------------
  const { ExperiencesArchive } = require('../src/experiences-archive');
  const { normalizeArchiveRecord } = require('../src/experience-schema');
  const { ArchiveIntegrityService, validateArchiveRecord, INTEGRITY_STATUS } = require('../src/archive-integrity');
  const fs = require('fs');
  const path = require('path');

  const testArchiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-test-dream-arc-'));
  const testArchive = new ExperiencesArchive(testArchiveDir);
  const appendOk = testArchive.append(dreamRecord);
  check('梦境记录成功通过 append 写入归档底座', appendOk === true);

  const archiveRecords = testArchive.readAll();
  const loadedDream = archiveRecords.find(r => r.recordType === 'subject_dream');
  check('从归档底座成功读回梦境记录', !!loadedDream);
  check('梦境记录 payload 包含完整 dreamId 与 epistemicStatus',
    Boolean(loadedDream && loadedDream.payload &&
    typeof loadedDream.payload.dreamId === 'string' &&
    loadedDream.payload.epistemicStatus === MEMORY_EPISTEMIC_STATUS.DREAM_GENERATED_ARTIFACT)
  );

  const normDream = normalizeArchiveRecord(loadedDream);
  const vReport = validateArchiveRecord(normDream);
  check('归档中的梦境记录符合 Canonical Schema 校验', vReport.valid === true, vReport.reason);

  const intReport = ArchiveIntegrityService.checkRecords([loadedDream]);
  check('完整性分析服务判定梦境记录为 CERTIFIED (无破坏/无降级)', intReport.integrity === INTEGRITY_STATUS.CERTIFIED);

  try { fs.rmSync(testArchiveDir, { recursive: true, force: true }); } catch {}

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
