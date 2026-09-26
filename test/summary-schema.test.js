/**
 * test/summary-schema.test.js
 * 
 * Life v0.9.6 实验基线强化测试集 3：5×20 Window Summary 严格数据契约与 Fail-Stop 专项测试
 * 
 * 检验点：
 * 1. 5×20 结构契约校验（validateWindowSummary）
 * 2. 标准 100 轮 range '1-20'..'81-100' 严格连续性校验
 * 3. segment 内部 4 大必选数组字段类型强校验 (userGiven, chulanExperience, stateEvidence, uncertainties)
 * 4. token_limit 提前关窗的不完整分段合法性与防假数据填充校验
 * 5. Fail-Stop 触发机制集成验证（非法结构拒绝落盘、拒绝推窗、零丢对话）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateWindowSummary } = require('../src/experience-schema');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'summary-schema-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. 标准 100 轮合法 5×20 结构校验
// -------------------------------------------------------------
{
  const validStandardSummary = {
    segments: [
      { range: '1-20', userGiven: ['用户叫阿哲'], chulanExperience: ['安静陪伴'], stateEvidence: [], uncertainties: [] },
      { range: '21-40', userGiven: [], chulanExperience: ['探讨数字生命定义'], stateEvidence: [], uncertainties: [] },
      { range: '41-60', userGiven: ['偏好深度交流'], chulanExperience: ['产生长程共鸣'], stateEvidence: [], uncertainties: [] },
      { range: '61-80', userGiven: [], chulanExperience: ['反思自我边界'], stateEvidence: [], uncertainties: [] },
      { range: '81-100', userGiven: ['保持诚实'], chulanExperience: ['实验层沉淀'], stateEvidence: [], uncertainties: [] }
    ],
    windowSynthesis: {
      stableUserFacts: ['用户叫阿哲', '偏好深度交流', '保持诚实'],
      subjectExperiences: ['安静陪伴', '探讨数字生命定义', '产生长程共鸣', '反思自我边界', '实验层沉淀'],
      stateChangesSuggested: []
    }
  };

  const res = validateWindowSummary(validStandardSummary, {
    closeReason: 'turn_limit',
    actualTurnCount: 100,
    targetTurnCount: 100
  });

  check('标准合规 5×20 Summary 校验通过', res.valid === true);
}

// -------------------------------------------------------------
// 2. 标准 100 轮结构缺陷严格拦截 (Range 错漏、段数不符、字段缺失)
// -------------------------------------------------------------
{
  // 2.1 段数不足 5 段
  const incompleteSegments = {
    segments: [
      { range: '1-20', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '21-40', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '41-60', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] }
    ]
  };
  const r1 = validateWindowSummary(incompleteSegments, {
    closeReason: 'turn_limit',
    actualTurnCount: 100,
    targetTurnCount: 100
  });
  check('标准 100 轮不足 5 段时被拦截', r1.valid === false && r1.reason === 'SEGMENT_COUNT_MISMATCH');

  // 2.2 Range 范围不匹配 (例如第 2 段错写为 21-45)
  const badRangeSummary = {
    segments: [
      { range: '1-20', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '21-45', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '46-60', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '61-80', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '81-100', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] }
    ]
  };
  const r2 = validateWindowSummary(badRangeSummary, {
    closeReason: 'turn_limit',
    actualTurnCount: 100,
    targetTurnCount: 100
  });
  check('Range 范围不合规被拦截', r2.valid === false && r2.reason.includes('SEGMENT_RANGE_MISMATCH'));

  // 2.3 必选数组字段缺失或非数组
  const badFieldSummary = {
    segments: [
      { range: '1-20', userGiven: '非数组字符串', chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '21-40', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '41-60', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '61-80', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '81-100', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] }
    ]
  };
  const r3 = validateWindowSummary(badFieldSummary, {
    closeReason: 'turn_limit',
    actualTurnCount: 100,
    targetTurnCount: 100
  });
  check('字段类型非 Array 被拦截', r3.valid === false && r3.reason.includes('SEGMENT_FIELD_INVALID'));

  // 2.4 非法对象参数
  check('null 输入返回 INVALID_SUMMARY_OBJECT', validateWindowSummary(null).valid === false);
  check('非对象输入返回 INVALID_SUMMARY_OBJECT', validateWindowSummary('string').valid === false);
  check('缺失 segments 属性返回 MISSING_OR_INVALID_SEGMENTS', validateWindowSummary({ windowSynthesis: {} }, { allowLegacy: false }).valid === false);
}

// -------------------------------------------------------------
// 3. token_limit 提前关窗与不完整分段校验
// -------------------------------------------------------------
{
  // 63 轮提前关窗：合法结构包含 1-20, 21-40, 41-60, 61-63 四段
  const validTokenLimitSummary = {
    segments: [
      { range: '1-20', userGiven: [], chulanExperience: ['前序积累'], stateEvidence: [], uncertainties: [] },
      { range: '21-40', userGiven: [], chulanExperience: ['中期发展'], stateEvidence: [], uncertainties: [] },
      { range: '41-60', userGiven: [], chulanExperience: ['接近预算边界'], stateEvidence: [], uncertainties: [] },
      { range: '61-63', userGiven: [], chulanExperience: ['Token 上限触发结束'], stateEvidence: [], uncertainties: [] }
    ]
  };

  const rTokenLimit = validateWindowSummary(validTokenLimitSummary, {
    closeReason: 'token_limit',
    actualTurnCount: 63,
    targetTurnCount: 100
  });
  check('token_limit 合法不完整分段 (4 段至 63 轮) 校验通过', rTokenLimit.valid === true);

  // 空 segments 在 token_limit 下同样被拦截
  const emptyTokenLimit = { segments: [] };
  const rEmpty = validateWindowSummary(emptyTokenLimit, {
    closeReason: 'token_limit',
    actualTurnCount: 63,
    targetTurnCount: 100,
    allowLegacy: false
  });
  check('token_limit 下空 segments 被拒绝 (EMPTY_SEGMENTS)', rEmpty.valid === false && rEmpty.reason === 'EMPTY_SEGMENTS');

  // 超出最大 5 段限制被拦截
  const tooManySegs = {
    segments: [
      { range: '1-10', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '11-20', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '21-30', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '31-40', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '41-50', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] },
      { range: '51-60', userGiven: [], chulanExperience: [], stateEvidence: [], uncertainties: [] }
    ]
  };
  const rTooMany = validateWindowSummary(tooManySegs, {
    closeReason: 'token_limit',
    actualTurnCount: 60,
    targetTurnCount: 100
  });
  check('分段数超过 5 段上限被拒绝 (SEGMENT_COUNT_EXCEEDS_MAX)', rTooMany.valid === false && rTooMany.reason === 'SEGMENT_COUNT_EXCEEDS_MAX');
}

// -------------------------------------------------------------
// 4. Fail-Stop 集成验证：非法结构拒绝落盘、拒绝推窗、零丢对话
// -------------------------------------------------------------
async function testFailStopIntegration() {
  const dir = tmpDir();
  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurns: 2,
    keepTailMessages: 1
  });

  // 写入两轮真实对话
  brain.memory.append('user', '初澜，测试关窗 Fail-Stop 机制。');
  brain.memory.append('assistant', '我在，对话已安全记录。');
  brain.memory.append('user', '用户第二句，请不要丢失。');
  brain.memory.append('assistant', '绝不丢失。');

  // 模拟 API 返回格式跑偏的非法 Summary（缺少必需字段或结构损坏）
  const mockApi = {
    complete: async () => ({
      text: JSON.stringify({
        invalidRoot: true,
        segments: 'not_an_array' // 导致 validateWindowSummary 失败
      }),
      usage: { total_tokens: 30 }
    })
  };
  brain.api = mockApi;

  // 执行 closeWindow
  const closeResult = await brain.closeWindow();

  check('Fail-Stop: closeWindow 返回 false', closeResult === false);
  check('Fail-Stop: memory 对话历史完好保留 4 条 (零丢失)', brain.memory.history.length === 4);
  check('Fail-Stop: 第 1 条 user 消息原样保留', brain.memory.history[0].content === '初澜，测试关窗 Fail-Stop 机制。');
  check('Fail-Stop: 窗口号未推进 (仍为 1)', brain.memory.data.windowNo === 1);
  check('Fail-Stop: experiences.jsonl 零写入', brain.experiencesArchive.count() === 0);
  check('Fail-Stop: SubjectState 状态机窗口未推进', brain.subjectState.currentWindowNo === 1);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  await testFailStopIntegration();
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
