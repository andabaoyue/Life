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
 * 4. Full Research Bundle 附带元数据 metadata.json (schemaVersion, appVersion=0.9.5, exportTimestamp)。
 */

const fs = require('fs');
const path = require('path');

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
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
        row.windowNo ?? row.window ?? '',
        escapeCsvCell(row.trait),
        row.previousValue ?? row.previous ?? 0,
        row.delta ?? 0,
        row.newValue ?? 0
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
        sc.windowNo ?? '',
        escapeCsvCell(sc.trait),
        sc.previousValue ?? 0,
        sc.delta ?? 0,
        sc.newValue ?? 0,
        escapeCsvCell(evIds),
        sc.createdAt || sc.timestamp || ''
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
        ev.direction ?? 0,
        ev.strength ?? 0,
        escapeCsvCell(ev.status || 'verified'),
        escapeCsvCell(ev.reason || ''),
        escapeCsvCell(ev.fingerprint || '')
      ].join(','));
    }
    return lines.join('\n');
  }
  return JSON.stringify(evidenceList, null, 2);
}

/**
 * 导出完整实验包 (Full Research Bundle)
 */
function exportFullResearchBundle(researchQuery, options = {}) {
  const { targetDir = null } = options;

  const metadata = {
    schemaVersion: 1,
    appVersion: '0.9.5.2',
    archiveSchemaVersion: 1,
    subjectStateSchemaVersion: 1,
    exportTimestamp: Date.now()
  };

  const subjectState = researchQuery.getSubjectState();
  const stateTrajectory = researchQuery.getStateTrajectory();
  const events = researchQuery.getEvents({ limit: 10000 }).items;
  const observations = researchQuery.getObservations({ limit: 10000 }).items;
  const interpretations = researchQuery.getInterpretations({ limit: 10000 }).items;
  const evidence = researchQuery.getEvidence({ limit: 10000 }).items;
  const stateChanges = researchQuery.getStateChanges({ limit: 10000 }).items;

  const bundle = {
    'metadata.json': JSON.stringify(metadata, null, 2),
    'state.json': JSON.stringify(subjectState, null, 2),
    'state-history.json': JSON.stringify(stateTrajectory, null, 2),
    'events.json': JSON.stringify(events, null, 2),
    'observations.json': JSON.stringify(observations, null, 2),
    'interpretations.json': JSON.stringify(interpretations, null, 2),
    'evidence.json': JSON.stringify(evidence, null, 2),
    'state-changes.json': JSON.stringify(stateChanges, null, 2)
  };

  if (targetDir) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    for (const [filename, content] of Object.entries(bundle)) {
      fs.writeFileSync(path.join(targetDir, filename), content, 'utf8');
    }
  }

  return {
    metadata,
    files: bundle
  };
}

module.exports = {
  exportStateTrajectory,
  exportStateChanges,
  exportEvidence,
  exportFullResearchBundle
};
