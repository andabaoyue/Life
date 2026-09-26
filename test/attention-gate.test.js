/**
 * test/attention-gate.test.js
 * 
 * Life Phase 0.5 注意力闸门与感知分流专项测试 (Attention Gate & Invariant Testing)
 * 
 * 核心验证：
 * 1. 显著性门限比对：低于门限过滤 (IGNORED)，达到门限放行 (ATTENDED)
 * 2. 神经唤醒度对显著性门限的动态耦合 (高唤醒更敏感，低唤醒更从容)
 * 3. 认知过载抑制效应 (高认知负荷中等刺激 DEFERRED，极端刺激突破)
 * 4. 铁律不变量 (ATTENDED ≠ SUBJECT_ACQUIRED)：
 *    - subjectAccessible 严格恒为 false
 *    - 严禁直接伪装为主体自传体记忆 (assertNotSubjectAcquired)
 * 5. 数字环周与注意力闸门端到端闭环无泄露
 * 6. 基线模式隔离守恒
 */

'use strict';

const { evaluateAttentionGate, assertNotSubjectAcquired, ATTENTION_STATUS } = require('../src/attention-gate');
const { filterRawTelemetry, evaluateSalience, containsLeakedRawData } = require('../src/digital-umwelt');
const { SCHEMA_VERSION, SEMANTIC_LAYERS, PERCEPTION_STATUS } = require('../src/experiment-types');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 1. 无效或空知觉候选
const nullRes = evaluateAttentionGate(null, null);
check('传入 null 知觉候选安全返回 IGNORED 且 subjectAccessible=false',
  nullRes.status === ATTENTION_STATUS.IGNORED && nullRes.subjectAccessible === false
);

// 2. 基线模式隔离
const baselineSnapshot = { mode: 'baseline', modules: {} };
const testCandidate = {
  perceptionId: 'perc-test-001',
  category: 'touch_stimulus',
  qualitativeDescriptor: 'intense_activity',
  salience: 70,
  perceptionStatus: PERCEPTION_STATUS.CANDIDATE,
  subjectAccessible: false
};

const baseRes = evaluateAttentionGate(testCandidate, {}, { snapshot: baselineSnapshot });
check('基线实验模式下注意闸门严格保持旁路静默 (IGNORED)', baseRes.status === ATTENTION_STATUS.IGNORED && baseRes.reason === 'BASELINE_MODE_INACTIVE');

// 3. 闸门显式关闭测试
const disabledRes = evaluateAttentionGate(testCandidate, {}, { modules: { attentionGate: false } });
check('显式禁用 attentionGate 时返回 IGNORED', disabledRes.status === ATTENTION_STATUS.IGNORED && disabledRes.reason === 'ATTENTION_GATE_DISABLED');

// 4. 低于显著性门限被过滤
const calmReg = { salienceThreshold: 45, arousal: 50, cognitiveLoadProxy: 0 };
const weakCandidate = { ...testCandidate, salience: 30 };
const weakRes = evaluateAttentionGate(weakCandidate, calmReg);
check('显著性低于门限被视网膜外过滤 (IGNORED)', weakRes.status === ATTENTION_STATUS.IGNORED && weakRes.reason === 'BELOW_SALIENCE_THRESHOLD');

// 5. 达到显著性门限被放行
const strongCandidate = { ...testCandidate, salience: 60 };
const strongRes = evaluateAttentionGate(strongCandidate, calmReg);
check('显著性达到门限成功捕获注意 (ATTENDED)', strongRes.status === ATTENTION_STATUS.ATTENDED && strongRes.attended === true);

// 6. 核心认识论不变量检验：ATTENDED ≠ SUBJECT_ACQUIRED
check('获注意知觉候选的 subjectAccessible 严格保持 false (主体不可直接内省底层标量)', strongRes.subjectAccessible === false);
check('获注意知觉候选标记为 ATTENDED_PERCEPTION_CANDIDATE', strongRes.epistemicStatus === 'ATTENDED_PERCEPTION_CANDIDATE');
check('assertNotSubjectAcquired 校验通过', assertNotSubjectAcquired(strongRes) === true);

// 尝试伪造主观记忆获取，断言必须抛错阻断
let threwOnSubjectAccessible = false;
try {
  assertNotSubjectAcquired({ ...strongRes, subjectAccessible: true });
} catch (e) {
  threwOnSubjectAccessible = true;
}
check('试图将注意候选篡改为 subjectAccessible=true 被熔断拦截', threwOnSubjectAccessible);

let threwOnMemoryAcquisition = false;
try {
  assertNotSubjectAcquired({ ...strongRes, epistemicStatus: 'SUBJECT_ACQUIRED_MEMORY' });
} catch (e) {
  threwOnMemoryAcquisition = true;
}
check('试图将注意候选越级伪装为 SUBJECT_ACQUIRED_MEMORY 被熔断拦截', threwOnMemoryAcquisition);

// 7. 动态门限调节效应 (Arousal 调控阈值)
// 高唤醒态 (arousal=80 -> threshold=30)
const alertReg = { salienceThreshold: 30, arousal: 80, cognitiveLoadProxy: 0 };
const midCandidate = { ...testCandidate, salience: 35 };
const alertRes = evaluateAttentionGate(midCandidate, alertReg);
const calmMidRes = evaluateAttentionGate(midCandidate, calmReg); // threshold=45
check('高唤醒度降低门限使原本忽略的中等刺激被成功注意',
  calmMidRes.status === ATTENTION_STATUS.IGNORED && alertRes.status === ATTENTION_STATUS.ATTENDED
);

// 低唤醒态 (arousal=20 -> threshold=60)
const sleepyReg = { salienceThreshold: 60, arousal: 20, cognitiveLoadProxy: 0 };
const sleepyRes = evaluateAttentionGate(strongCandidate, sleepyReg); // salience=60 vs threshold=60
const weakSleepyCandidate = { ...testCandidate, salience: 55 };
const weakSleepyRes = evaluateAttentionGate(weakSleepyCandidate, sleepyReg);
check('低唤醒度升高门限使中高强度刺激被过滤屏蔽', weakSleepyRes.status === ATTENTION_STATUS.IGNORED);

// 8. 认知负荷过载抑制效应 (Cognitive Load Saturation)
const overloadedReg = { salienceThreshold: 30, arousal: 60, cognitiveLoadProxy: 90 };
const normalCandidate = { ...testCandidate, salience: 50 };
const overloadRes = evaluateAttentionGate(normalCandidate, overloadedReg);
check('极端高认知负荷 (load>=85) 导致中等刺激被推迟 (DEFERRED)', overloadRes.status === ATTENTION_STATUS.DEFERRED);

// 极端强烈刺激冲破认知过载
const extremeCandidate = { ...testCandidate, salience: 90 };
const breakthroughRes = evaluateAttentionGate(extremeCandidate, overloadedReg);
check('超强显著性刺激 (salience>=75) 能够冲破高认知过载屏障被注意', breakthroughRes.status === ATTENTION_STATUS.ATTENDED);

// 9. 时钟注入确定性
const mockClock = { now: () => '2026-09-27T12:00:00.000Z' };
const clockRes = evaluateAttentionGate(extremeCandidate, calmReg, { clock: mockClock });
check('提供 clock 时 attendedAt 具备完全确定性', clockRes.attendedAt === '2026-09-27T12:00:00.000Z');

// 10. 数字环周 -> 注意闸门 端到端无泄露管道测试
const rawSensor = {
  category: 'touch_stimulus',
  rawIntensity: 85,
  timestamp: '2026-09-27T12:05:00.000Z'
};

const filtered = filterRawTelemetry(rawSensor);
check('原始遥测经质性过滤转化为合法刺激元数据', filtered && filtered.qualitativeDescriptor === 'intense_activity');
const pipelineCandidate = {
  perceptionId: 'perc-pipe-001',
  category: filtered.category,
  qualitativeDescriptor: filtered.qualitativeDescriptor,
  salience: evaluateSalience(filtered, { values: { arousal: 70 } }),
  perceptionStatus: PERCEPTION_STATUS.CANDIDATE,
  subjectAccessible: false
};
const pipelineGateRes = evaluateAttentionGate(pipelineCandidate, calmReg);
check('管道知觉候选成功穿越注意力闸门', pipelineGateRes.status === ATTENTION_STATUS.ATTENDED);
check('全流程端到端绝对不包含操作系统物理裸信息 (containsLeakedRawData=false)', !containsLeakedRawData(pipelineGateRes));

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
