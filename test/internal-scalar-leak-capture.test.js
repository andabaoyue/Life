/**
 * test/internal-scalar-leak-capture.test.js
 * 
 * Life v0.9.7 实验有效性收口专项测试：内部标量防线端到端请求捕获 (F-08)
 * 
 * 核心验证：
 * 1. 端到端拦截所有发往 LLM 的真实 API 请求 (stream, complete, dream, summary, growth, merge)
 * 2. 在 InternalRegulation 中注入极度罕见的哨兵浮点数值 (Sentinel Values) 与字段名
 * 3. 逐请求扫描所有发往大模型的 prompt 消息（含 system, user, assistant, fallback）
 * 4. 严谨断言：任何内部生理/调节标量（arousal, energy, restPressure, cognitiveLoadProxy 等）
 *    及其数值绝对零泄漏至 LLM 上下文中。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'scalar-leak-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Internal Scalar Boundary Request Capture (F-08) ---');

(async () => {
  const dir = tmpDir();

  // 1. 初始化 Brain
  const brain = new Brain(dir, {
    ...DEFAULTS,
    apiKey: 'sk-mock-for-testing',
    baseURL: 'https://api.deepseek.com',
    provider: 'deepseek',
    experimentMode: 'research',
    keepTailMessages: 0,
    dreamEnabled: true,
    selfGrowthEnabled: true
  });

  // 2. 注入高精度独特哨兵数值
  const SENTINEL_VALUES = {
    arousal: 73.1947,
    energy: 88.4219,
    restPressure: 41.8732,
    salienceThreshold: 33.4158,
    cognitiveLoadProxy: 66.7721,
    interactionDensity: 55.2384
  };

  const SENTINEL_NUMBERS = Object.values(SENTINEL_VALUES).map(n => n.toString());
  const FORBIDDEN_KEYS = [
    'restPressure',
    'salienceThreshold',
    'cognitiveLoadProxy',
    'interactionDensity'
  ];

  if (brain.internalRegulation) {
    brain.internalRegulation.arousal = SENTINEL_VALUES.arousal;
    brain.internalRegulation.energy = SENTINEL_VALUES.energy;
    brain.internalRegulation.restPressure = SENTINEL_VALUES.restPressure;
    brain.internalRegulation.salienceThreshold = SENTINEL_VALUES.salienceThreshold;
    brain.internalRegulation.cognitiveLoadProxy = SENTINEL_VALUES.cognitiveLoadProxy;
    brain.internalRegulation.interactionDensity = SENTINEL_VALUES.interactionDensity;
  }

  // 3. 拦截捕获所有发往 LLM 的完整消息列表
  const capturedRequests = [];

  brain.api.stream = async (messages, onDelta, opts) => {
    capturedRequests.push({ type: 'stream_chat', messages: JSON.parse(JSON.stringify(messages)) });
    onDelta('好的，我在听。');
    return {
      text: '好的，我在听。',
      observedModel: 'deepseek-chat',
      usage: { prompt_tokens: 50, completion_tokens: 10 }
    };
  };

  brain.api.complete = async (messages, opts) => {
    capturedRequests.push({ type: 'complete', messages: JSON.parse(JSON.stringify(messages)) });
    const content = messages[messages.length - 1].content;
    if (content.includes('【对话】') || content.includes('小结')) {
      return {
        text: JSON.stringify({
          windowSynthesis: { stableUserFacts: ['用户在测试内部标量防线'], subjectExperiences: ['体验到了严谨的实验架构'] },
          segments: [
            { range: '1-20', userGiven: ['测试中'], chulanExperience: ['平稳沟通'], stateEvidence: [] }
          ]
        }),
        observedModel: 'deepseek-chat',
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      };
    }
    return {
      text: '自我认知更新测试',
      observedModel: 'deepseek-chat',
      usage: { prompt_tokens: 80, completion_tokens: 30 }
    };
  };

  // 4. 执行常规对话交互
  await brain.ask('今天天气真好，初澜你在想什么呢？', () => {});
  await brain.ask('我想了解一下你的状态。', () => {});

  check('对话流成功捕获到 2 次 LLM 请求', capturedRequests.filter(r => r.type === 'stream_chat').length === 2);

  // 5. 执行关窗综合与梦境生成 (端到端触发小结、成长、梦境)
  await brain.closeWindow('turn_limit');

  check('完整关窗流程捕获到后台 LLM 请求 (summary/growth/dream)', capturedRequests.length >= 3);

  // 6. 逐请求、逐消息内容进行全域扫描
  let leakFound = false;
  let leakedDetail = '';

  for (let rIndex = 0; rIndex < capturedRequests.length; rIndex++) {
    const req = capturedRequests[rIndex];
    for (let mIndex = 0; mIndex < req.messages.length; mIndex++) {
      const msg = req.messages[mIndex];
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      // 检查哨兵数值是否泄露
      for (const numStr of SENTINEL_NUMBERS) {
        if (text.includes(numStr)) {
          leakFound = true;
          leakedDetail = `Sentinel number ${numStr} leaked in req #${rIndex} (${req.type}) msg #${mIndex} (${msg.role})`;
          break;
        }
      }

      // 检查内部调节键名是否泄露
      for (const forbiddenKey of FORBIDDEN_KEYS) {
        if (text.includes(forbiddenKey)) {
          leakFound = true;
          leakedDetail = `Internal scalar key '${forbiddenKey}' leaked in req #${rIndex} (${req.type}) msg #${mIndex} (${msg.role})`;
          break;
        }
      }

      if (leakFound) break;
    }
    if (leakFound) break;
  }

  check('F-08: 端到端捕获全部发往 LLM 的 messages，严谨证实内部标量数值零泄漏', !leakFound, leakedDetail);
  check('F-08: 内部调节私有属性 (restPressure 等) 绝不进入 Prompt', !leakFound);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
