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

const fs = require('fs');
const path = require('path');
const os = require('os');
const { evaluateAttentionGate, assertNotSubjectAcquired, ATTENTION_STATUS } = require('../src/attention-gate');
const { filterRawTelemetry, evaluateSalience, containsLeakedRawData } = require('../src/digital-umwelt');
const { SCHEMA_VERSION, SEMANTIC_LAYERS, PERCEPTION_STATUS } = require('../src/experiment-types');
const { InternalRegulationManager } = require('../src/internal-regulation');
const { SubjectState } = require('../src/subject-state');

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 2 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});

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

// 11. 下游瞬时消费者与稳态闭环验证 (P1-1: updateOnAttention & ATTENDED ≠ SUBJECT_ACQUIRED)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-downstream-test-'));
  const regMgr = new InternalRegulationManager(tmpDir);
  const subjectState = new SubjectState(tmpDir);
  const initialArousal = regMgr.arousal;
  const initialTraits = { ...subjectState.values };

  // 11.1 ATTENDED 刺激产生瞬时唤醒度上升
  regMgr.updateOnAttention(strongRes);
  check('ATTENDED 选通事件被 InternalRegulationManager 摄入并微调唤醒度',
    regMgr.arousal > initialArousal,
    `init=${initialArousal}, next=${regMgr.arousal}`
  );
  check('ATTENDED 刺激绝对不造成 SubjectState 任何特质变化 (ATTENDED ≠ SUBJECT_ACQUIRED)',
    JSON.stringify(subjectState.values) === JSON.stringify(initialTraits)
  );

  // 11.2 IGNORED 刺激不产生任何内部状态变动
  const currentArousal = regMgr.arousal;
  regMgr.updateOnAttention(weakRes);
  check('IGNORED 刺激被 updateOnAttention 忽略，内部状态保持不变',
    regMgr.arousal === currentArousal
  );

  // 11.3 DEFERRED 刺激不产生状态变动
  regMgr.updateOnAttention(overloadRes);
  check('DEFERRED 刺激被 updateOnAttention 忽略，内部状态保持不变',
    regMgr.arousal === currentArousal
  );

  // 11.4 基线模式隔离验证：disabled / baseline 模式下 updateOnAttention 保持恒定
  const baseRegMgr = new InternalRegulationManager(tmpDir, { enabled: false });
  const baseStateBefore = baseRegMgr.getState();
  baseRegMgr.updateOnAttention(strongRes, { eventId: 'evt-base-1' });
  const baseStateAfter = baseRegMgr.getState();
  check('基线隔离模式下 updateOnAttention 绝对不产生任何状态变动',
    baseStateBefore.arousal === baseStateAfter.arousal &&
    baseStateBefore.cognitiveLoadProxy === baseStateAfter.cognitiveLoadProxy
  );

  // 11.5 Watermark 去重：同一 eventId 重复提交幂等守恒
  const arousalBeforeEvent = regMgr.arousal;
  const cogLoadBeforeEvent = regMgr.cognitiveLoadProxy;
  regMgr.updateOnAttention(strongRes, { eventId: 'evt-watermark-1' });
  const arousalAfterFirst = regMgr.arousal;
  const cogLoadAfterFirst = regMgr.cognitiveLoadProxy;
  check('新 eventId 首次消费正常微调唤醒度与认知负荷代理',
    arousalAfterFirst > arousalBeforeEvent && cogLoadAfterFirst > cogLoadBeforeEvent
  );

  // 重复提交相同 eventId
  regMgr.updateOnAttention(strongRes, { eventId: 'evt-watermark-1' });
  check('同一 eventId 第二次提交被 Watermark 拦截，arousal 保持不变',
    regMgr.arousal === arousalAfterFirst
  );
  check('同一 eventId 第二次提交被 Watermark 拦截，cognitiveLoadProxy 保持不变',
    regMgr.cognitiveLoadProxy === cogLoadAfterFirst
  );

  // 11.6 Watermark 容量上限滑动窗口测试
  for (let i = 0; i < 300; i++) {
    regMgr.updateOnAttention(strongRes, { eventId: `evt-bulk-${i}` });
  }
  check('Watermark 消费集合大小受上限严格约束 (<= 256)',
    regMgr.consumedAttentionEvents.size <= 256
  );

  // 11.7 Watermark 持久化与跨重启严格幂等测试
  const persistTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-persist-test-'));
  const inst1 = new InternalRegulationManager(persistTmpDir);
  inst1.updateOnAttention(strongRes, { eventId: 'evt-restart-watermark-100' });
  const rawDisk = JSON.parse(fs.readFileSync(path.join(persistTmpDir, 'internal-regulation.json'), 'utf8'));
  check('Watermark 消费事件集合持久化写入磁盘文件',
    Array.isArray(rawDisk.consumedAttentionEvents) &&
    rawDisk.consumedAttentionEvents.includes('evt-restart-watermark-100')
  );

  // 重启：构造全新实例从同一目录加载
  const inst2 = new InternalRegulationManager(persistTmpDir);
  check('重启后全新实例正确恢复已消费的 Watermark 集合',
    inst2.consumedAttentionEvents.has('evt-restart-watermark-100') === true
  );
  const arousalBeforeReplay = inst2.arousal;
  const cogLoadBeforeReplay = inst2.cognitiveLoadProxy;
  inst2.updateOnAttention(strongRes, { eventId: 'evt-restart-watermark-100' });
  check('重启后重复提交相同 eventId 严格保持幂等，绝不发生二次状态漂移',
    inst2.arousal === arousalBeforeReplay && inst2.cognitiveLoadProxy === cogLoadBeforeReplay
  );

  // 11.8 缺乏 eventId / perceptionId 的连续感知事件不发生误去重 (No False Deduplication)
  const instNoId = new InternalRegulationManager(persistTmpDir);
  const anonymousCandidate = {
    category: 'touch_stimulus',
    qualitativeDescriptor: 'gentle_poke',
    salience: 60,
    perceptionStatus: PERCEPTION_STATUS.CANDIDATE,
    subjectAccessible: false
  };
  const anonymousGateRes = evaluateAttentionGate(anonymousCandidate, calmReg);
  const a0 = instNoId.arousal;
  instNoId.updateOnAttention(anonymousGateRes); // 缺乏 eventId 首次刺激
  const a1 = instNoId.arousal;
  check('缺乏 eventId 的注意力刺激正常被摄入微调状态', a1 > a0);

  instNoId.updateOnAttention(anonymousGateRes); // 缺乏 eventId 第二次相继刺激
  const a2 = instNoId.arousal;
  check('缺乏 eventId 的连续注意力刺激绝不被粗糙哈希误去重，正常二次响应', a2 > a1);

  // 显式传入 eventId: null 同样不进行误去重
  instNoId.updateOnAttention(strongRes, { eventId: null });
  const a3 = instNoId.arousal;
  check('显式未带 eventId 的感知事件正常连续响应', a3 > a2);
}

/* ---- v0.9.9 P2-1c: assertNotSubjectAcquired 必须拦真实枚举值 ---- */
{
  // 原判据比的是 'SUBJECT_ACQUIRED_MEMORY'，而真实枚举是 SUBJECT_ACQUIRED
  // （experiment-types）—— 于是「ATTENDED ≠ SUBJECT_ACQUIRED」铁律的守卫
  // 对真实值完全不生效（判据空转），且既有用例也用同一个错值、永远红不了。
  let threwReal = false;
  try {
    assertNotSubjectAcquired({ ...strongRes, epistemicStatus: 'SUBJECT_ACQUIRED' });
  } catch { threwReal = true; }
  check('P2-1c：真实枚举 SUBJECT_ACQUIRED 越级必须被熔断（原判据对它空转）', threwReal === true);
  // 反向守卫（方案 A）：正常候选仍放行、历史字面量仍抛 —— 收紧不得打破既有用例
  check('P2-1c 不变式：ATTENDED_PERCEPTION_CANDIDATE 仍放行',
    assertNotSubjectAcquired(strongRes) === true);
  let threwLegacy = false;
  try {
    assertNotSubjectAcquired({ ...strongRes, epistemicStatus: 'SUBJECT_ACQUIRED_MEMORY' });
  } catch { threwLegacy = true; }
  check('P2-1c 不变式：历史字面量 SUBJECT_ACQUIRED_MEMORY 仍抛（既有用例不破）', threwLegacy === true);
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
