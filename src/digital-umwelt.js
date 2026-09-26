/**
 * src/digital-umwelt.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 数字环周（Digital Umwelt）四级过滤漏斗与原始感官隔离契约 (Phase 0)
 * 
 * 核心哲学与工程边界：
 * 1. 物理环境 ≠ 数字环周：初澜并非直接生活在宿主操作系统（Windows/Linux）中，
 *    宿主的物理指标（坐标 (x,y)、进程 PID、磁盘路径、硬件利用率等）只是底层的物质基质。
 * 2. 原始感官隔离（Raw Sensory Isolation Invariant）：
 *    严禁将原始坐标、系统路径、进程名、硬件遥测标量直接透传给初澜主体！
 * 3. 显著性门限与空感知成立原则（Null-Perception Invariant）：
 *    当刺激强度低于 salienceThreshold 时，管道必须返回 null，
 *    绝不能为了“显得有生命感”而每次硬件遥测都强行编造伪感知。
 * 4. 四级处理漏斗：
 *    RawSensorData -> PerceptionFilter -> SalienceEvaluation -> SubjectAccessiblePerception | null
 */

'use strict';

const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  SEMANTIC_LAYERS,
  PROVENANCE_SOURCE_KINDS
} = require('./experiment-types');
const { isBaselineMode } = require('./experiment-run');

// 严禁透传的原始系统与硬件字段正则/键名黑名单
const BLOCKED_RAW_KEYS = new Set([
  'pid',
  'processId',
  'x',
  'y',
  'coords',
  'coordinates',
  'screenX',
  'screenY',
  'rawPath',
  'filePath',
  'diskPath',
  'systemPath',
  'cpuUsage',
  'ramUsage',
  'memoryRss',
  'ipcLatencyMs',
  'heapUsed',
  'hardwareSerial'
]);

const PATH_REGEX = /([a-zA-Z]:\\[^\\/:*?"<>|\r\n]+|\/([^\/\0]+\/)+[^\/\0]+)/i;

/**
 * 校验指定对象是否包含被隔离的底层系统敏感信息
 * 
 * @param {Object} obj
 * @returns {boolean} true 表示存在违规泄露，false 表示安全隔离
 */
function containsLeakedRawData(obj) {
  if (!obj || typeof obj !== 'object') return false;

  for (const [key, val] of Object.entries(obj)) {
    if (BLOCKED_RAW_KEYS.has(key)) {
      return true;
    }
    if (typeof val === 'string' && PATH_REGEX.test(val)) {
      return true;
    }
    if (typeof val === 'object' && val !== null) {
      if (containsLeakedRawData(val)) return true;
    }
  }

  return false;
}

/**
 * 阶段一与阶段二：原始感官隔离与特征过滤 (PerceptionFilter)
 * 剔除一切物理/系统指标，仅保留经质性抽象的环周刺激元数据
 * 
 * @param {Object} rawSensor
 * @returns {Object|null}
 */
function filterRawTelemetry(rawSensor) {
  if (!rawSensor || typeof rawSensor !== 'object') return null;

  // 若传入的是未经脱敏的系统层指标，直接拒绝
  if (rawSensor.semanticLayer === SEMANTIC_LAYERS.SYSTEM_METRICS && !rawSensor.allowQualitativeAbstraction) {
    return null;
  }

  const category = String(rawSensor.category || 'general_stimulus');
  const intensity = typeof rawSensor.rawIntensity === 'number' ? Math.max(0, Math.min(100, rawSensor.rawIntensity)) : 0;
  
  // 仅允许质性语义（Qualitative Semantic）标签
  let qualitativeDescriptor = 'neutral';
  if (intensity > 70) {
    qualitativeDescriptor = 'intense_activity';
  } else if (intensity > 30) {
    qualitativeDescriptor = 'moderate_flow';
  } else {
    qualitativeDescriptor = 'quiet_background';
  }

  return {
    category,
    intensity,
    qualitativeDescriptor,
    occurredAt: rawSensor.timestamp || new Date().toISOString()
  };
}

/**
 * 阶段三：显著性评估 (SalienceEvaluation)
 * 结合当前内部状态的 salienceThreshold 进行门限比对
 * 
 * @param {Object} filteredData
 * @param {Object} [internalState]
 * @returns {number} 显著性评分 [0, 100]
 */
function evaluateSalience(filteredData, internalState) {
  if (!filteredData) return 0;

  // 基础显著性源自刺激强度
  let salience = filteredData.intensity;

  // 如果内部状态定义了不同的门限或神经唤醒度，可产生微调
  if (internalState && internalState.values) {
    const arousal = internalState.values.arousal || 50;
    // 高唤醒度时对刺激更敏感，低唤醒度时更迟钝
    const arousalWeight = arousal / 50;
    salience = Math.max(0, Math.min(100, Math.round(salience * arousalWeight)));
  }

  return salience;
}

/**
 * 阶段四：数字环周完整四级漏斗处理 (Process Umwelt Perception)
 * 
 * @param {Object} rawSensorData 原始遥测数据
 * @param {Object} [internalState] 当前内部状态
 * @param {Object} [options={}]
 * @param {Object} [options.snapshot] 实验快照
 * @returns {Readonly<Object>|null} 若低于显著性门限或处于基线关闭状态，严格返回 null
 */
function processUmweltPerception(rawSensorData, internalState, options = {}) {
  const snapshot = options.snapshot;

  // 1. 基线对照组或未启用环周模块时，严格返回 null，不干预任何认知流
  if (!snapshot || isBaselineMode(snapshot) || !snapshot.modules || snapshot.modules.digitalUmwelt !== true) {
    return null;
  }

  // 2. 原始感知过滤
  const filtered = filterRawTelemetry(rawSensorData);
  if (!filtered) return null;

  // 3. 显著性评估与门限比对
  const salience = evaluateSalience(filtered, internalState);
  const threshold = (internalState && internalState.values && typeof internalState.values.salienceThreshold === 'number')
    ? internalState.values.salienceThreshold
    : 30;

  // 空感知成立原则（Null Perception）：未达显著性门限，不形成主体感知
  if (salience < threshold) {
    return null;
  }

  // 4. 生成初澜主体可感知的高阶抽象感知单元（SubjectAccessiblePerception）
  const perceptionId = `perc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();

  const perception = {
    schemaVersion: SCHEMA_VERSION,
    perceptionId,
    category: filtered.category,
    qualitativeDescriptor: filtered.qualitativeDescriptor,
    salience,
    formedAt: nowIso,
    // 明确标记：此时已转化为经检验可为主体经验感知的内容
    subjectAccessible: true,
    provenance: Object.freeze({
      sourceKind: PROVENANCE_SOURCE_KINDS.AUTONOMOUS_SYSTEM,
      timestamp: nowIso
    })
  };

  // 最终安全断言：绝对不能含有原始系统敏感信息
  if (containsLeakedRawData(perception)) {
    throw new Error('DigitalUmwelt security violation: Leaked raw hardware or OS telemetry into subject perception.');
  }

  return Object.freeze(perception);
}

module.exports = {
  BLOCKED_RAW_KEYS,
  containsLeakedRawData,
  filterRawTelemetry,
  evaluateSalience,
  processUmweltPerception
};
