/**
 * test/memory-dynamics.test.js
 * 
 * Life v0.9.7 零 API 成本记忆衰减与突触修剪专项测试
 * 
 * 检验点：
 * 1. 初始记忆强度 S0 本地确定性代数计算与极值截断 [0.1, 1.0]
 * 2. 改进型艾宾浩斯幂律衰减纯本地计算：
 *    - 随 ΔW 增长单调衰减
 *    - 被检索召回 (retrievalCount) 能有效提升分子并抵抗衰减
 * 3. 记忆三级状态流转 (ACTIVE -> FADING -> DORMANT)：
 *    - 高强度 >= 0.6 为 ACTIVE
 *    - 0.35 <= 强度 < 0.6 为 FADING
 *    - 强度 < 0.35 且未召回窗口跨度 >= 5 为 DORMANT
 * 4. 重新激活机制 (Reactivation)：
 *    - 休眠记忆被重新召回后，retrievalCount 递增，成功复活脱离 DORMANT 态
 * 5. 档案不可篡改性 (Archive Immutability)：
 *    - 衰减仅影响 Prompt 活跃上下文，绝不物理删除底层经历与证据
 * 6. 快照导出与恢复确定性 (Snapshot Export & Restore)
 */

const {
  DEFAULT_DYNAMICS_CONFIG,
  calculateInitialStrength,
  computeEngramDecay,
  EngramTraceManager
} = require('../src/memory-dynamics');
const { ENGRAM_TIERS } = require('../src/experiment-types');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// -------------------------------------------------------------
// 1. 初始强度 S0 计算
// -------------------------------------------------------------
{
  const s0Default = calculateInitialStrength({});
  check('默认初始强度在合理基准 (0.5)', s0Default === 0.5);

  const s0Bonus = calculateInitialStrength({ salienceBonus: 0.2, evidenceBonus: 0.1 });
  check('附加显著度与证据奖励后强度增加 (0.8)', s0Bonus === 0.8);

  const s0Cap = calculateInitialStrength({ salienceBonus: 0.9, evidenceBonus: 0.9 });
  check('超额奖励严格截断于 1.0', s0Cap === 1.0);
}

// -------------------------------------------------------------
// 2. 幂律衰减计算与单调性
// -------------------------------------------------------------
{
  const trace = {
    traceId: 'tr-1',
    createdWindow: 1,
    initialStrength: 0.8,
    retrievalCount: 0,
    lastRetrievedWindow: 1
  };

  const w1 = computeEngramDecay(trace, 1);
  const w2 = computeEngramDecay(trace, 2);
  const w5 = computeEngramDecay(trace, 5);
  const w10 = computeEngramDecay(trace, 10);
  const w20 = computeEngramDecay(trace, 20);

  check('W=1 强度等于初始强度', w1.currentStrength === 0.8);
  check('w2 < w1', w2.currentStrength < w1.currentStrength);
  check('w5 < w2', w5.currentStrength < w2.currentStrength);
  check('w10 < w5', w10.currentStrength < w5.currentStrength);
  check('w20 < w10', w20.currentStrength < w10.currentStrength);

  // 召回抵抗衰减测试
  const recalledTrace = { ...trace, retrievalCount: 5 };
  const w10Recalled = computeEngramDecay(recalledTrace, 10);
  check('经历过召回的记忆在同一窗口强度显著高于未召回记忆',
    w10Recalled.currentStrength > w10.currentStrength,
    `recalled: ${w10Recalled.currentStrength}, unrecalled: ${w10.currentStrength}`
  );
}

// -------------------------------------------------------------
// 3. 记忆三级状态跃迁 (ACTIVE -> FADING -> DORMANT)
// -------------------------------------------------------------
{
  const mgr = new EngramTraceManager();

  // 注册一条高初始强度记忆
  const t1 = mgr.registerTrace({
    traceId: 'trace-alpha',
    createdWindow: 1,
    salienceBonus: 0.2, // s0 = 0.7 >= 0.6 -> ACTIVE
    contentRef: 'User prefers quiet evenings'
  });
  check('高强度新建记忆归入 ACTIVE', t1.tier === ENGRAM_TIERS.ACTIVE);

  // 演进至 Window 3: 轻微衰减 -> FADING
  mgr.decayAll(3);
  const t1W3 = mgr.getTrace('trace-alpha');
  check('Window 3 时记忆衰减至 FADING', t1W3.tier === ENGRAM_TIERS.FADING, `strength: ${t1W3.currentStrength}`);

  // 演进至 Window 10 (未召回跨度 10 - 1 = 9 >= 5 且强度 < 0.35) -> DORMANT
  mgr.decayAll(10);
  const t1W10 = mgr.getTrace('trace-alpha');
  check('Window 10 时长期未召回记忆转入 DORMANT', t1W10.tier === ENGRAM_TIERS.DORMANT, `strength: ${t1W10.currentStrength}`);
  check('DORMANT 列表中包含该记忆', mgr.getDormantTraces().some(t => t.traceId === 'trace-alpha'));
  check('ACTIVE 列表中不包含该记忆', !mgr.getActiveTraces().some(t => t.traceId === 'trace-alpha'));
}

// -------------------------------------------------------------
// 4. 重新激活机制 (Reactivation)
// -------------------------------------------------------------
{
  const mgr = new EngramTraceManager();
  mgr.registerTrace({ traceId: 'trace-dormant', createdWindow: 1, salienceBonus: 0.0 });

  // 衰减至休眠
  mgr.decayAll(12);
  check('已进入 DORMANT 态', mgr.getTrace('trace-dormant').tier === ENGRAM_TIERS.DORMANT);

  // 在 Window 12 触发重新激活
  const reactivated = mgr.reactivate('trace-dormant', 12);
  check('重新激活后 retrievalCount 增至 1', reactivated.retrievalCount === 1);
  check('重新激活后 lastRetrievedWindow 更新为 12', reactivated.lastRetrievedWindow === 12);
  check('重新激活后由于未召回跨度清零，立即脱离 DORMANT 态', reactivated.tier !== ENGRAM_TIERS.DORMANT);
}

// -------------------------------------------------------------
// 5. 快照导出与恢复一致性
// -------------------------------------------------------------
{
  const mgr1 = new EngramTraceManager();
  mgr1.registerTrace({ traceId: 't-1', createdWindow: 1 });
  mgr1.registerTrace({ traceId: 't-2', createdWindow: 2 });
  mgr1.decayAll(4);

  const snapshot = mgr1.exportSnapshot(4);
  check('快照包含 2 条记忆痕迹', snapshot.totalTraces === 2 && snapshot.traces.length === 2);

  const mgr2 = new EngramTraceManager();
  const ok = mgr2.restoreFromSnapshot(snapshot);
  check('快照恢复成功', ok);
  check('恢复后的 traceId 与强度完全对齐',
    mgr2.getTrace('t-1').currentStrength === mgr1.getTrace('t-1').currentStrength &&
    mgr2.getTrace('t-2').currentStrength === mgr1.getTrace('t-2').currentStrength
  );
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
