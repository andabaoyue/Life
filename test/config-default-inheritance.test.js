/**
 * test/config-default-inheritance.test.js
 *
 * v1.2.y Phase 1 回归门禁：
 * 验证 sanitize() 对 DEFAULTS.experimentMode 与 DEFAULTS.experimentModules 的正确缺省继承，
 * 修复此前「DEFAULTS 只写不读、被硬编码 baseline 否决」的架构缺陷，
 * 同时保证 baseline 隔离不变式与老用户显式配置完全不受破坏。
 */

const { DEFAULTS, sanitize } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- Config DEFAULTS Inheritance Tests ---');

// 1. 空配置下的 experimentMode 与 DEFAULTS 对齐（不再硬编码回落 baseline）
check('1. sanitize({}).experimentMode === DEFAULTS.experimentMode（出厂模式继承）',
  sanitize({}).experimentMode === DEFAULTS.experimentMode,
  sanitize({}).experimentMode + ' vs ' + DEFAULTS.experimentMode);

// 2. Phase 2 (v1.2.y / D-011): memoryDynamics 出厂默认通电为 true
check('2. sanitize({}).experimentModules.memoryDynamics === true（D-011 出厂通电）',
  sanitize({}).experimentModules.memoryDynamics === true);

// 3. 老用户/显式 true 覆盖不受破坏
check('3. 老用户显式配置 memoryDynamics: true 正常透传',
  sanitize({ experimentModules: { memoryDynamics: true } }).experimentModules.memoryDynamics === true);

// 4. 显式 false 严格保留（尊重用户或 ablation 消融意图，不被 DEFAULTS 冲掉）
check('4. 显式 false 严格保留，不被 DEFAULTS 覆盖',
  sanitize({ experimentModules: { memoryDynamics: false } }).experimentModules.memoryDynamics === false);

// 5. baseline 隔离不变式：只要 mode 是 baseline，所有模块强制 false
const allTrue = {
  homeostasis: true,
  internalRegulation: true,
  digitalUmwelt: true,
  attentionGate: true,
  biographicalCanalization: true,
  memoryDynamics: true,
  sleepConsolidation: true
};
const baselineResult = sanitize({ experimentMode: 'baseline', experimentModules: allTrue });
const allFalse = Object.values(baselineResult.experimentModules).every(v => v === false);
check('5. baseline 模式下强制所有模块为 false（Baseline Isolation Invariant）',
  baselineResult.experimentMode === 'baseline' && allFalse);

// 6. sleepConsolidation 地雷防线验证（缺省为 true，不能因统一 pick() 误变成 false）
check('6. sanitize({}).experimentModules.sleepConsolidation === true（地雷防线验证）',
  sanitize({}).experimentModules.sleepConsolidation === true);

// 7. 动态修改 DEFAULTS 验证：证明缺省键真正具备了继承能力（根除只写不读缺陷）
{
  const saved = DEFAULTS.experimentModules.memoryDynamics;
  try {
    DEFAULTS.experimentModules.memoryDynamics = false;
    check('7. 动态设置 DEFAULTS.experimentModules 能被 sanitize({}) 正确继承',
      sanitize({}).experimentModules.memoryDynamics === false);
  } finally {
    DEFAULTS.experimentModules.memoryDynamics = saved;
  }
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
