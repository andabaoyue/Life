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

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
