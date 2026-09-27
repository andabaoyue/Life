/**
 * src/experiment-run.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 实验 Run 生命周期、Manifest 契约与窗口级不可变配置快照 (Phase 0)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  EXPERIMENT_CONFIG_VERSION,
  RESEARCH_FORMAT_VERSION,
  EXPERIMENT_MODES,
  PROVENANCE_SOURCE_KINDS,
  DEFAULT_EXPERIMENT_MODULES
} = require('./experiment-types');
const { resolveGitCommit } = require('./experiment-metadata');

let cachedPkgVersion = null;
function getPackageVersion(packagePath = path.join(__dirname, '..', 'package.json')) {
  const defaultPath = path.join(__dirname, '..', 'package.json');
  if (packagePath === defaultPath && cachedPkgVersion) return cachedPkgVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (pkg && pkg.version) {
      const version = String(pkg.version);
      if (packagePath === defaultPath) cachedPkgVersion = version;
      return version;
    }
  } catch {}
  return null;
}

/**
 * 创建实验 Run Manifest
 * 
 * 基线原则（Baseline Non-Interference Invariant）：
 * 当 mode 为 'baseline' 时，强制将所有实验特性模块置为 false，
 * 绝不允许基线对照组夹带任何实验机制。
 * 
 * @param {Object} options
 * @param {string} [options.experimentMode='baseline']
 * @param {Object} [options.modules={}]
 * @param {number} [options.windowNo=1]
 * @param {string} [options.lifeVersion]
 * @param {string} [options.gitCommit]
 * @param {string} [options.label='']
 * @returns {Readonly<Object>}
 */
function createExperimentRunManifest(options = {}) {
  const mode = options.experimentMode || EXPERIMENT_MODES.BASELINE;
  const validModes = Object.values(EXPERIMENT_MODES);
  if (!validModes.includes(mode)) {
    throw new Error(`Invalid experiment mode: "${mode}". Expected one of: ${validModes.join(', ')}`);
  }

  // 模块开关处理
  let activeModules = { ...DEFAULT_EXPERIMENT_MODULES };
  if (mode === EXPERIMENT_MODES.BASELINE) {
    // 基线模式强制全关
    for (const key of Object.keys(activeModules)) {
      activeModules[key] = false;
    }
  } else {
    // 实验组或消融组按需开启
    if (options.modules && typeof options.modules === 'object') {
      for (const [key, val] of Object.entries(options.modules)) {
        if (key in activeModules) {
          activeModules[key] = Boolean(val);
        }
      }
    }
  }

  const nowMs = typeof options.now === 'number'
    ? options.now
    : (options.clock && typeof options.clock.now === 'function' ? options.clock.now() : Date.now());
  const nowIso = options.nowIso || new Date(nowMs).toISOString();
  const idSuffix = typeof options.idGenerator === 'function'
    ? options.idGenerator('run')
    : (options.idSuffix || crypto.randomBytes(4).toString('hex'));
  const runId = options.runId || `expr-${nowMs}-${idSuffix}`;

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    experimentConfigVersion: EXPERIMENT_CONFIG_VERSION,
    researchFormatVersion: RESEARCH_FORMAT_VERSION,
    experimentRunId: runId,
    experimentMode: mode,
    modules: Object.freeze(activeModules),
    initialWindowNo: typeof options.windowNo === 'number' ? options.windowNo : 1,
    lifeVersion: options.lifeVersion != null ? String(options.lifeVersion) : getPackageVersion(),
    gitCommit: String(options.gitCommit || resolveGitCommit()),
    label: String(options.label || ''),
    createdAt: nowIso,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp: nowIso
    })
  };

  return Object.freeze(manifest);
}

/**
 * 创建窗口级不可变实验配置快照
 * 
 * 保证窗口生命周期内实验条件恒定，禁止中途篡改配置。
 * 
 * @param {number} windowNo
 * @param {Object} runManifest
 * @param {Object} [options={}]
 * @returns {Readonly<Object>}
 */
function createWindowExperimentSnapshot(windowNo, runManifest, options = {}) {
  if (typeof windowNo !== 'number' || windowNo < 0) {
    throw new Error(`Invalid windowNo: ${windowNo}. Must be non-negative integer.`);
  }
  if (!runManifest || typeof runManifest !== 'object' || !runManifest.experimentRunId) {
    throw new Error('Valid experiment runManifest is required to create window snapshot.');
  }

  const nowMs = typeof options.now === 'number'
    ? options.now
    : (options.clock && typeof options.clock.now === 'function' ? options.clock.now() : Date.now());
  const nowIso = options.nowIso || new Date(nowMs).toISOString();
  const idSuffix = typeof options.idGenerator === 'function'
    ? options.idGenerator('snapshot')
    : (options.idSuffix || crypto.randomBytes(3).toString('hex'));
  const snapshotId = options.snapshotId || `snap-${runManifest.experimentRunId}-w${windowNo}-${idSuffix}`;

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    experimentConfigVersion: EXPERIMENT_CONFIG_VERSION,
    snapshotId,
    experimentRunId: runManifest.experimentRunId,
    windowNo,
    experimentMode: runManifest.experimentMode,
    modules: Object.freeze({ ...runManifest.modules }),
    createdAt: nowIso,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp: nowIso
    })
  };

  return Object.freeze(snapshot);
}

/**
 * 校验快照完整性与合法性
 * 
 * @param {Object} snapshot
 * @returns {boolean}
 */
function validateExperimentSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== SCHEMA_VERSION) return false;
  if (snapshot.experimentConfigVersion !== EXPERIMENT_CONFIG_VERSION) return false;
  if (!snapshot.snapshotId || !snapshot.experimentRunId) return false;
  if (typeof snapshot.windowNo !== 'number' || snapshot.windowNo < 0) return false;
  if (!Object.values(EXPERIMENT_MODES).includes(snapshot.experimentMode)) return false;
  if (!snapshot.modules || typeof snapshot.modules !== 'object') return false;
  if (!snapshot.provenance || !snapshot.provenance.sourceKind) return false;

  // 若为基线模式，验证所有模块必为 false
  if (snapshot.experimentMode === EXPERIMENT_MODES.BASELINE) {
    for (const val of Object.values(snapshot.modules)) {
      if (val !== false) return false;
    }
  }

  return true;
}

/**
 * 判定当前快照或模式是否为严格基线模式
 * 
 * @param {Object|string} target 快照对象、Manifest 对象或模式字符串
 * @returns {boolean}
 */
function isBaselineMode(target) {
  if (typeof target === 'string') {
    return target === EXPERIMENT_MODES.BASELINE;
  }
  if (!target || typeof target !== 'object') return false;

  const mode = target.experimentMode;
  if (mode !== EXPERIMENT_MODES.BASELINE) return false;

  if (target.modules) {
    for (const val of Object.values(target.modules)) {
      if (val !== false) return false;
    }
  }
  return true;
}

module.exports = {
  createExperimentRunManifest,
  createWindowExperimentSnapshot,
  validateExperimentSnapshot,
  isBaselineMode,
  getPackageVersion
};
