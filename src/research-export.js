/**
 * src/research-export.js
 * 
 * 初澜数字生命实验：Research Export 轨迹与研究包只读导出器 (v0.9.5 / P1-05)
 * 
 * 核心规范与设计原则：
 * 1. 严格只读复制，绝不改写生产环境 experiences.jsonl 或 subject-state.json。
 * 2. 支持 JSON 与标准 CSV 两大格式。
 * 3. CSV 字段对齐规范：
 *    - Trajectory: window,trait,previous,delta,newValue
 *    - StateChanges: stateChangeId,windowNo,trait,previousValue,delta,newValue,evidenceIds,timestamp
 *    - Evidence: evidenceId,messageId,quote,trait,direction,strength,status,reason,fingerprint
 * 4. Full Research Bundle 附带元数据 metadata.json (schemaVersion, appVersion=当前软件版本, exportTimestamp)。
 *    appVersion 唯一来源为 package.json（getAppVersion()），禁止任何第二份版本常量。
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

/**
 * 当前软件版本唯一来源：package.json (P1-01)
 * 运行版本与导出实验产物声明版本必须一致，禁止硬编码旧版本。
 */
function getAppVersion() {
  const pkg = require('../package.json');
  return pkg.version;
}

/**
 * CSV 单元格转义（含**公式注入防护**）。
 *
 * ## 为什么需要公式注入防护（2026-10-20 GPT 审计发现，实测确认）
 *   实测：`quote: '=1+1'` 导出后单元格原样是 `=1+1`。
 *   Excel / WPS / Numbers 打开 CSV 时，以 `=` `+` `-` `@` 开头的单元格
 *   **会被当成公式执行**。这里有一条真实的攻击链：
 *   她说过的话（`evidence.quote`，来自对话，内容不可信）
 *     → 落进 experiences / evidence
 *     → 用户导出 CSV 用 Excel 打开
 *     → `=cmd|' /C calc'!A1` 这类 DDE 载荷被执行
 *   这不是"数据看着怪"，是**本地代码执行**。
 *
 * ## 防护做法
 *   对以危险字符开头的值，前置一个单引号 `'`（Excel 的"强制文本"前缀），
 *   并照常加引号包裹。这样：
 *     - 电子表格里显示的是原文（前缀被 Excel 吃掉，不显示）；
 *     - 任何解析器都不会把它当公式。
 *
 * ⚠️ 也被**制表符/回车/换行开头**的载荷绕过（实测 `\t=1+1`），
 *   所以判定前先剥掉前导空白再检查首字符，但**保留原值**（不清洗内容，
 *   只加前缀 —— 数据不伪造）。
 *
 * @param {*} val
 * @returns {string}
 */
const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  let str = String(val);

  // 1. 公式注入防护：先看"剥掉前导空白后的首字符"是不是危险字符
  const lead = str.replace(/^[\s]+/, '');
  const dangerous = lead.length > 0 && (
    CSV_FORMULA_PREFIXES.includes(lead[0])
    || CSV_FORMULA_PREFIXES.includes(str[0])
  );
  if (dangerous) {
    // 前置单引号强制成文本；不清洗原文，只加前缀（数据不伪造）
    str = "'" + str;
  }

  // 2. 标准 CSV 转义
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * 导出状态演化轨迹 (State Trajectory)
 */
function exportStateTrajectory(trajectoryItems, format = 'json') {
  if (format === 'csv') {
    const headers = ['window', 'trait', 'previous', 'delta', 'newValue'];
    const lines = [headers.join(',')];
    for (const row of trajectoryItems) {
      lines.push([
        escapeCsvCell(row.windowNo ?? row.window ?? ''),
        escapeCsvCell(row.trait),
        // 🔴 2026-10-20：这三个字段**原本是裸拼进 CSV 的**（以为"都是数字所以安全"）。
        //   实测 `newValue: '=1+1'` 原样落盘 —— 上游若把字符串塞进来，
        //   就绕过了全部转义。CSV 的输入不可信假设必须覆盖每一个格子，
        //   不能因为"它本应是数字"就免责。
        escapeCsvCell(row.previousValue ?? row.previous ?? 0),
        escapeCsvCell(row.delta ?? 0),
        escapeCsvCell(row.newValue ?? 0)
      ].join(','));
    }
    return lines.join('\n');
  }
  return JSON.stringify(trajectoryItems, null, 2);
}

/**
 * 导出状态跃迁历史 (State Changes)
 */
function exportStateChanges(stateChanges, format = 'json') {
  if (format === 'csv') {
    const headers = ['stateChangeId', 'windowNo', 'trait', 'previousValue', 'delta', 'newValue', 'evidenceIds', 'timestamp'];
    const lines = [headers.join(',')];
    for (const sc of stateChanges) {
      const id = sc.stateChangeId || sc.changeId || '';
      const evIds = Array.isArray(sc.evidenceIds) ? sc.evidenceIds.join(';') : '';
      lines.push([
        escapeCsvCell(id),
        escapeCsvCell(sc.windowNo ?? ''),
        escapeCsvCell(sc.trait),
        escapeCsvCell(sc.previousValue ?? 0),
        escapeCsvCell(sc.delta ?? 0),
        escapeCsvCell(sc.newValue ?? 0),
        escapeCsvCell(evIds),
        escapeCsvCell(sc.createdAt || sc.timestamp || '')
      ].join(','));
    }
    return lines.join('\n');
  }
  return JSON.stringify(stateChanges, null, 2);
}

/**
 * 导出事实与因果证据 (Evidence)
 */
function exportEvidence(evidenceList, format = 'json') {
  if (format === 'csv') {
    const headers = ['evidenceId', 'messageId', 'quote', 'trait', 'direction', 'strength', 'status', 'reason', 'fingerprint'];
    const lines = [headers.join(',')];
    for (const ev of evidenceList) {
      lines.push([
        escapeCsvCell(ev.evidenceId || ''),
        escapeCsvCell(ev.messageId || ''),
        escapeCsvCell(ev.quote || ''),
        escapeCsvCell(ev.trait || ''),
        escapeCsvCell(ev.direction ?? 0),
        escapeCsvCell(ev.strength ?? 0),
        escapeCsvCell(ev.status || 'unknown'),
        escapeCsvCell(ev.reason || ''),
        escapeCsvCell(ev.fingerprint || '')
      ].join(','));
    }
    return lines.join('\n');
  }
  return JSON.stringify(evidenceList, null, 2);
}

/**
 * 校验导出目标目录并确保目录存在（禁止包含 `..` 路径段，放行如 `v2.1..final` 合法文件夹名）。
 */
function resolveSafeExportDir(targetDir) {
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('INVALID_TARGET_DIR: Target directory must be a valid non-empty string');
  }
  if (targetDir.split(/[\\/]+/).some((seg) => seg === '..')) {
    throw new Error('PATH_TRAVERSAL_DETECTED: Target directory cannot contain traversal sequence (..)');
  }
  const canonicalDir = path.resolve(targetDir);
  if (!fs.existsSync(canonicalDir)) {
    fs.mkdirSync(canonicalDir, { recursive: true });
  }
  return canonicalDir;
}

/**
 * 原子写入单个子导出文件到受信任目标目录（P1-18）。
 */
function writeExportFileToDir(targetDir, filename, content) {
  const canonicalDir = resolveSafeExportDir(targetDir);
  const safeFilename = path.basename(filename);
  const filePath = path.join(canonicalDir, safeFilename);
  writeFileAtomic(filePath, content);
  return filePath;
}

function summarizePaginatedExport(res) {
  const items = Array.isArray(res && res.items) ? res.items : (Array.isArray(res) ? res : []);
  const totalCount = (res && typeof res.total === 'number' && !Number.isNaN(res.total)) ? res.total : items.length;
  const exportedCount = items.length;
  return {
    items,
    meta: {
      exportedCount,
      totalCount,
      truncated: exportedCount < totalCount
    }
  };
}

/**
 * 导出完整实验包 (Full Research Bundle)
 */
function exportFullResearchBundle(researchQuery, options = {}) {
  const { targetDir = null } = options;

  const subjectState = researchQuery.getSubjectState();
  const stateTrajectory = researchQuery.getStateTrajectory();
  const evBucket = summarizePaginatedExport(researchQuery.getEvents({ limit: 10000 }));
  const obsBucket = summarizePaginatedExport(researchQuery.getObservations({ limit: 10000 }));
  const interpBucket = summarizePaginatedExport(researchQuery.getInterpretations({ limit: 10000 }));
  const evidenceBucket = summarizePaginatedExport(researchQuery.getEvidence({ limit: 10000 }));
  const scBucket = summarizePaginatedExport(researchQuery.getStateChanges({ limit: 10000 }));

  const counts = {
    events: evBucket.meta,
    observations: obsBucket.meta,
    interpretations: interpBucket.meta,
    evidence: evidenceBucket.meta,
    stateChanges: scBucket.meta
  };
  const hasTruncation = Object.values(counts).some((c) => c.truncated === true);

  const metadata = {
    schemaVersion: 1,
    appVersion: getAppVersion(),
    archiveSchemaVersion: 1,
    subjectStateSchemaVersion: 1,
    exportTimestamp: Date.now(),
    counts,
    hasTruncation
  };

  const bundle = {
    'metadata.json': JSON.stringify(metadata, null, 2),
    'state.json': JSON.stringify(subjectState, null, 2),
    'state-history.json': JSON.stringify(stateTrajectory, null, 2),
    'events.json': JSON.stringify(evBucket.items, null, 2),
    'observations.json': JSON.stringify(obsBucket.items, null, 2),
    'interpretations.json': JSON.stringify(interpBucket.items, null, 2),
    'evidence.json': JSON.stringify(evidenceBucket.items, null, 2),
    'state-changes.json': JSON.stringify(scBucket.items, null, 2)
  };

  if (targetDir !== null && targetDir !== undefined) {
    const canonicalDir = resolveSafeExportDir(targetDir);
    for (const [filename, content] of Object.entries(bundle)) {
      const safeFilename = path.basename(filename);
      writeFileAtomic(path.join(canonicalDir, safeFilename), content);
    }
  }

  return {
    metadata,
    files: bundle
  };
}

module.exports = {
  getAppVersion,
  exportStateTrajectory,
  exportStateChanges,
  exportEvidence,
  exportFullResearchBundle,
  writeExportFileToDir,
  resolveSafeExportDir
};
