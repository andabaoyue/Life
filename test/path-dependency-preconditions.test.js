/**
 * test/path-dependency-preconditions.test.js
 *
 * Life Phase 0.5 路径依赖实验受控前置条件门禁专项测试 (Preconditions Audit Testing)
 *
 * 核心验证：
 * 1. 初始状态不一致拦截 (Initial State Mismatch -> Reject)
 * 2. 事件集合不匹配拦截 (Event Multiset Mismatch -> Reject)
 * 3. 事件数量不一致拦截 (Event Count Mismatch -> Reject)
 * 4. 实验配置不一致拦截 (Config Mismatch -> Reject)
 * 5. 探测环境不一致拦截 (Probe Mismatch -> Reject)
 * 6. 合法顺序置换正常放行 (Identical Set / Different Order -> Accept)
 * 7. 受控审计凭证完整性 (Preconditions Audit Complete)
 * 8. 确定性重放结果完全等价 (Deterministic Replay)
 * 9. throwOnError 抛错语义契约
 */

'use strict';

const { runPathDependencyExperiment } = require('../src/path-dependency');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 标准测试事件项
const evtPoke = { type: 'activity', activityKind: 'poke', payload: { count: 3 } };
const evtSleep = { type: 'sleep', isAsleep: true };
const evtWake = { type: 'sleep', isAsleep: false };
const evtChat = { type: 'interaction', payload: { role: 'user', messageLength: 80 } };
const evtDrag = { type: 'activity', activityKind: 'drag', payload: { distance: 100 } };

// 1. 初始状态不一致 -> 拒绝
{
  const res = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    initialStateA: { internalRegulation: { arousal: 50 } },
    initialStateB: { internalRegulation: { arousal: 80 } }
  });
  check('初始状态不一致被明确拦截', res.valid === false && res.reason === 'PATH_EXPERIMENT_INITIAL_STATE_MISMATCH');
  check('前置条件审计报告标记 initialStateEqual=false', res.preconditions && res.preconditions.initialStateEqual === false);
}

// 2. 事件集合不匹配 (不同种类) -> 拒绝
{
  const res = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtSleep, evtChat],
    sequenceB: [evtPoke, evtSleep, evtDrag]
  });
  check('事件集合不匹配被明确拦截', res.valid === false && res.reason === 'PATH_EXPERIMENT_EVENT_SET_MISMATCH');
  check('前置条件审计报告标记 eventMultisetEqual=false', res.preconditions && res.preconditions.eventMultisetEqual === false);
}

// 3. 事件数量不一致 -> 拒绝
{
  const res = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtPoke, evtChat],
    sequenceB: [evtPoke, evtChat]
  });
  check('事件数量不一致被明确拦截', res.valid === false && res.reason === 'PATH_EXPERIMENT_EVENT_SET_MISMATCH');
}

// 4. 实验配置不一致 -> 拒绝
{
  const res = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { experimentModules: { internalRegulation: true } },
    configB: { experimentModules: { internalRegulation: false } }
  });
  check('实验配置不一致被明确拦截', res.valid === false && res.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');
  check('前置条件审计报告标记 configEqual=false', res.preconditions && res.preconditions.configEqual === false);
}

// 5. 探测环境不一致 -> 拒绝
{
  const res = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', salience: 30 },
    probeStimulusB: { category: 'sound_probe', salience: 85 }
  });
  check('探测刺激不一致被明确拦截', res.valid === false && res.reason === 'PATH_EXPERIMENT_PROBE_MISMATCH');
  check('前置条件审计报告标记 probeEqual=false', res.preconditions && res.preconditions.probeEqual === false);
}

// 6. 合法顺序置换 -> 正常放行
{
  const res = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtSleep, evtWake, evtChat],
    sequenceB: [evtChat, evtSleep, evtWake, evtPoke]
  });
  check('合法事件集合置换实验获得放行', res.valid === true && res.pathDependencyEstablished !== undefined);
  check('放行实验 preconditions.valid 为 true', res.preconditions && res.preconditions.valid === true);
}

// 7. 受控审计凭证完整性
{
  const res = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtSleep, evtWake, evtChat],
    sequenceB: [evtChat, evtSleep, evtWake, evtPoke],
    probeStimulus: { category: 'probe_test', salience: 50, intensity: 50 }
  });
  const p = res.preconditions;
  check('审计凭证包含全部 4 项守恒判定',
    p.initialStateEqual === true &&
    p.eventMultisetEqual === true &&
    p.configEqual === true &&
    p.probeEqual === true
  );
  check('审计凭证包含完整哈希指纹集合',
    typeof p.initialStateHash === 'string' && p.initialStateHash.startsWith('sha256:') &&
    typeof p.eventSetHashA === 'string' && p.eventSetHashA.startsWith('sha256:') &&
    p.eventSetHashA === p.eventSetHashB &&
    typeof p.configHash === 'string' && p.configHash.startsWith('sha256:') &&
    typeof p.probeHash === 'string' && p.probeHash.startsWith('sha256:')
  );
}

// 8. 确定性重放结果完全等价
{
  const opts = {
    sequenceA: [evtPoke, evtSleep, evtWake, evtChat],
    sequenceB: [evtChat, evtSleep, evtWake, evtPoke],
    probeStimulus: { category: 'deterministic_probe', salience: 44, intensity: 48 }
  };
  const run1 = runPathDependencyExperiment(opts);
  const run2 = runPathDependencyExperiment(opts);

  check('相同输入重放的 divergence.internalRegulation 完全一致',
    JSON.stringify(run1.divergence.internalRegulation) === JSON.stringify(run2.divergence.internalRegulation)
  );
  check('相同输入重放的 divergence.behaviorDistribution 完全一致',
    JSON.stringify(run1.divergence.behaviorDistribution) === JSON.stringify(run2.divergence.behaviorDistribution)
  );
  check('相同输入重放的 pathDependencyEstablished 判定完全一致',
    run1.pathDependencyEstablished === run2.pathDependencyEstablished
  );
}

// 9. throwOnError 契约校验
{
  let threw = false;
  try {
    runPathDependencyExperiment({
      sequenceA: [evtPoke],
      sequenceB: [evtDrag],
      throwOnError: true
    });
  } catch (err) {
    threw = true;
    check('throwOnError=true 在前置条件不满足时抛出确切错误码', err.message === 'PATH_EXPERIMENT_EVENT_SET_MISMATCH');
  }
  check('throwOnError 成功拦截异常', threw === true);
}

// 10. 函数事件审计：两个同名但实现不同的函数被明确拦截 (Event Multiset Mismatch)
{
  function stepA(ctx) { if (ctx && ctx.reg) ctx.reg.energy = 50; }
  function stepB(ctx) { if (ctx && ctx.reg) ctx.reg.restPressure = 50; }
  Object.defineProperty(stepB, 'name', { value: 'stepA' });

  const res = runPathDependencyExperiment({
    sequenceA: [stepA, evtPoke],
    sequenceB: [evtPoke, stepB]
  });
  check('同名但不同实现的函数事件未通过等价性校验，被明确拦截',
    res.valid === false && res.reason === 'PATH_EXPERIMENT_EVENT_SET_MISMATCH'
  );
  check('函数事件不匹配时 eventMultisetEqual=false',
    res.preconditions && res.preconditions.eventMultisetEqual === false
  );
}

// 11. 无法证明等价性的裸函数（如 native 函数无显式签名）被直接拒绝
{
  const res = runPathDependencyExperiment({
    sequenceA: [Math.sin, evtPoke],
    sequenceB: [evtPoke, Math.sin]
  });
  check('无法证明等价性的裸 native 函数事件被明确拒绝',
    res.valid === false && res.reason === 'PATH_EXPERIMENT_UNVERIFIABLE_FUNCTION_EVENT'
  );
}

// 12. 具备显式实验签名或相同源码实现的函数事件放行
{
  const fn1 = function customAction(ctx) { return 1; };
  const fn2 = function customAction(ctx) { return 1; };
  const res = runPathDependencyExperiment({
    sequenceA: [fn1, evtPoke],
    sequenceB: [evtPoke, fn2]
  });
  check('源码实现相同的函数事件通过签名比对并正常放行',
    res.valid === true && res.preconditions.eventMultisetEqual === true
  );

  // 显式 eventSignature
  const sigFnA = (ctx) => 1;
  sigFnA.eventSignature = 'sig:custom_action_v1';
  const sigFnB = (ctx) => 2;
  sigFnB.eventSignature = 'sig:custom_action_v1';
  const resSig = runPathDependencyExperiment({
    sequenceA: [sigFnA, evtPoke],
    sequenceB: [evtPoke, sigFnB]
  });
  check('显式声明相同 eventSignature 的函数事件正常放行',
    resSig.valid === true && resSig.preconditions.eventMultisetEqual === true
  );
}

// 13. F-01 对抗反例矩阵：模型、版本、提供商、采样参数、随机种子与未知字段差异拦截
{
  // 13.1 模型不同 -> 拦截
  const resModel = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { model: 'deepseek-chat' },
    configB: { model: 'deepseek-coder' }
  });
  check('配置模型不同被明确拦截 (model mismatch)',
    resModel.valid === false && resModel.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');

  // 13.2 模型版本不同 -> 拦截
  const resVer = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { model: 'deepseek-chat', modelVersion: '202603' },
    configB: { model: 'deepseek-chat', modelVersion: '202609' }
  });
  check('配置模型版本不同被明确拦截 (modelVersion mismatch)',
    resVer.valid === false && resVer.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');

  // 13.3 提供商不同 -> 拦截
  const resProv = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { provider: 'deepseek' },
    configB: { provider: 'custom-proxy' }
  });
  check('配置提供商不同被明确拦截 (provider mismatch)',
    resProv.valid === false && resProv.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');

  // 13.4 API Endpoint 目标不同 -> 拦截
  const resEnd = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { endpoint: 'https://api.deepseek.com/v1' },
    configB: { endpoint: 'https://backup.deepseek.com/v1' }
  });
  check('配置 API Endpoint 不同被明确拦截 (endpoint mismatch)',
    resEnd.valid === false && resEnd.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');

  // 13.5 采样温度不同 -> 拦截
  const resTemp = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { sampling: { temperature: 0.7 } },
    configB: { sampling: { temperature: 1.0 } }
  });
  check('配置采样温度不同被明确拦截 (temperature mismatch)',
    resTemp.valid === false && resTemp.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');

  // 13.6 maxTokens 不同 -> 拦截
  const resMax = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { sampling: { maxTokens: 500 } },
    configB: { sampling: { maxTokens: 1000 } }
  });
  check('配置 maxTokens 不同被明确拦截 (maxTokens mismatch)',
    resMax.valid === false && resMax.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');

  // 13.7 随机种子 seed 不同 -> 拦截
  const resSeed = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { seed: 42 },
    configB: { seed: 1024 }
  });
  check('配置随机种子 seed 不同被明确拦截 (seed mismatch)',
    resSeed.valid === false && resSeed.reason === 'PATH_EXPERIMENT_CONFIG_MISMATCH');

  // 13.8 未知实验字段拒绝 (Reject Unknown Semantic Fields)
  const resUnknownCfg = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { experimentMode: 'enabled', unknownAlphaParameter: 123 },
    configB: { experimentMode: 'enabled' }
  });
  check('配置包含未知实验字段时触发强门禁直接拒绝 (unknown config fields rejected)',
    resUnknownCfg.valid === false && resUnknownCfg.reason === 'PATH_EXPERIMENT_CONFIG_UNKNOWN_FIELDS');
  check('前置条件审计报告记录未知的具体字段名',
    resUnknownCfg.preconditions && resUnknownCfg.preconditions.unknownConfigFieldsA.includes('unknownAlphaParameter'));

  // 13.9 敏感凭据字段被安全排除并不影响语义等价
  const resCred = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    configA: { model: 'deepseek-chat', apiKey: 'sk-user-a-123' },
    configB: { model: 'deepseek-chat', apiKey: 'sk-user-b-456' }
  });
  check('不同非语义凭据 apiKey 不泄露且不破坏合法实验配置的语义等价',
    resCred.valid === true && resCred.preconditions.configEqual === true);
}

// 14. F-02 对抗反例矩阵：Probe 环境字段（来源、位置、版本、载荷、噪声、传感器、未知字段）
{
  // 14.1 刺激来源 source 不同 -> 拦截
  const resSource = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', salience: 40, intensity: 40, source: 'mouse_click' },
    probeStimulusB: { category: 'touch_probe', salience: 40, intensity: 40, source: 'pen_touch' }
  });
  check('Probe 刺激来源不同被明确拦截 (source mismatch)',
    resSource.valid === false && resSource.reason === 'PATH_EXPERIMENT_PROBE_MISMATCH');

  // 14.2 刺激位置 location 不同 -> 拦截
  const resLoc = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', location: { x: 10, y: 20 } },
    probeStimulusB: { category: 'touch_probe', location: { x: 50, y: 80 } }
  });
  check('Probe 空间位置不同被明确拦截 (location mismatch)',
    resLoc.valid === false && resLoc.reason === 'PATH_EXPERIMENT_PROBE_MISMATCH');

  // 14.3 环境版本 environmentVersion 不同 -> 拦截
  const resEnvVer = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', environmentVersion: 'v1.0' },
    probeStimulusB: { category: 'touch_probe', environmentVersion: 'v2.0' }
  });
  check('Probe 环境版本不同被明确拦截 (environmentVersion mismatch)',
    resEnvVer.valid === false && resEnvVer.reason === 'PATH_EXPERIMENT_PROBE_MISMATCH');

  // 14.4 探测细粒度 payload 不同 -> 拦截
  const resPayload = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', payload: { pressure: 0.2 } },
    probeStimulusB: { category: 'touch_probe', payload: { pressure: 0.9 } }
  });
  check('Probe 探测载荷不同被明确拦截 (payload mismatch)',
    resPayload.valid === false && resPayload.reason === 'PATH_EXPERIMENT_PROBE_MISMATCH');

  // 14.5 背景噪声 noise 不同 -> 拦截
  const resNoise = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', noise: { level: 5 } },
    probeStimulusB: { category: 'touch_probe', noise: { level: 25 } }
  });
  check('Probe 背景噪声不同被明确拦截 (noise mismatch)',
    resNoise.valid === false && resNoise.reason === 'PATH_EXPERIMENT_PROBE_MISMATCH');

  // 14.6 传感器类型 sensorType 不同 -> 拦截
  const resSensor = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', sensorType: 'capacitive' },
    probeStimulusB: { category: 'touch_probe', sensorType: 'optical' }
  });
  check('Probe 传感器类型不同被明确拦截 (sensorType mismatch)',
    resSensor.valid === false && resSensor.reason === 'PATH_EXPERIMENT_PROBE_MISMATCH');

  // 14.7 未知 Probe 字段强门禁拒绝
  const resUnknownProbe = runPathDependencyExperiment({
    sequenceA: [evtPoke, evtChat],
    sequenceB: [evtChat, evtPoke],
    probeStimulusA: { category: 'touch_probe', unverifiedSensorField: 'quantum_fluctuation' },
    probeStimulusB: { category: 'touch_probe' }
  });
  check('Probe 包含未定义未知字段时被强门禁拒绝 (unknown probe fields rejected)',
    resUnknownProbe.valid === false && resUnknownProbe.reason === 'PATH_EXPERIMENT_PROBE_UNKNOWN_FIELDS');
  check('前置条件审计报告记录未知的 Probe 字段名',
    resUnknownProbe.preconditions && resUnknownProbe.preconditions.unknownProbeFieldsA.includes('unverifiedSensorField'));
}

// 15. F-03 对抗反例矩阵：语义负载 vs 传输 ID vs 因果溯源身份 (Semantic vs Transport vs Provenance)
{
  // 15.1 同 semantic event + 不同 transport ID -> 正常放行
  const evtWithTransA = { type: 'activity', activityKind: 'poke', payload: { count: 3, id: 'tx-uuid-001' } };
  const evtWithTransB = { type: 'activity', activityKind: 'poke', payload: { count: 3, id: 'tx-uuid-002' } };
  const resTrans = runPathDependencyExperiment({
    sequenceA: [evtWithTransA, evtChat],
    sequenceB: [evtChat, evtWithTransB]
  });
  check('同语义事件即便传输 ID 不同依然被判定为等价事件 Multiset 并放行',
    resTrans.valid === true && resTrans.preconditions.eventMultisetEqual === true);

  // 15.2 不同 semantic payload + 不同 ID -> 明确拦截
  const evtDiffA = { type: 'activity', activityKind: 'poke', payload: { count: 3, id: 'tx-001' } };
  const evtDiffB = { type: 'activity', activityKind: 'poke', payload: { count: 5, id: 'tx-002' } };
  const resDiffPayload = runPathDependencyExperiment({
    sequenceA: [evtDiffA, evtChat],
    sequenceB: [evtChat, evtDiffB]
  });
  check('语义负载不同即便 ID 不同也被明确拦截 (eventMultisetEqual=false)',
    resDiffPayload.valid === false && resDiffPayload.reason === 'PATH_EXPERIMENT_EVENT_SET_MISMATCH');

  // 15.3 相同 ID + 不同 semantic payload -> 明确拦截
  const evtSameIdDiffPayloadA = { type: 'activity', activityKind: 'poke', payload: { count: 3, id: 'shared-id' } };
  const evtSameIdDiffPayloadB = { type: 'activity', activityKind: 'poke', payload: { count: 99, id: 'shared-id' } };
  const resSameIdDiff = runPathDependencyExperiment({
    sequenceA: [evtSameIdDiffPayloadA, evtChat],
    sequenceB: [evtChat, evtSameIdDiffPayloadB]
  });
  check('相同 ID 但语义负载不同被明确拦截 (不可被 ID 掩盖真实语义差异)',
    resSameIdDiff.valid === false && resSameIdDiff.reason === 'PATH_EXPERIMENT_EVENT_SET_MISMATCH');

  // 15.4 审计凭证完整记录各事件因果溯源身份 (Event Provenance Metadata)
  const evtWithProvA = { type: 'activity', activityKind: 'poke', source: 'user_mouse_click', payload: { count: 1 } };
  const evtWithProvB = { type: 'activity', activityKind: 'poke', source: 'user_mouse_click', payload: { count: 1 } };
  const resProv = runPathDependencyExperiment({
    sequenceA: [evtWithProvA, evtChat],
    sequenceB: [evtChat, evtWithProvB]
  });
  check('前置条件审计报告如实独立记录各序列事件的因果溯源身份',
    resProv.preconditions &&
    Array.isArray(resProv.preconditions.eventProvenanceA) &&
    resProv.preconditions.eventProvenanceA[0] === 'user_mouse_click');
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
