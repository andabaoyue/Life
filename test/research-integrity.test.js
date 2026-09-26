/**
 * test/research-integrity.test.js
 * 
 * 初澜数字生命实验：v0.9.5.1 统一归档完整性服务专项测试 (P0-04, P0-05, P0-09)
 * 
 * 核心验证：
 * 1. 统一事实源：ArchiveIntegrityService、Replay 与 ResearchQuery 三者对完整性判定绝对一致
 * 2. 纯净归档 -> CERTIFIED + COMPLETE
 * 3. 坏行损坏归档 -> PARTIAL / CORRUPTED，绝不给出虚假 CERTIFIED
 * 4. 非法 Schema / 未知 recordType -> UNCERTIFIED / INVALID
 * 5. 遗留兼容格式 (v0.9.3) -> 平滑加载但绝不自动认证 (hasLegacyAdapter=true, UNCERTIFIED)
 * 6. 缺失归档 -> INVALID
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveIntegrityService, INTEGRITY_STATUS, REPLAY_STATUS } = require('../src/archive-integrity');
const { ResearchQuery } = require('../src/research-query');
const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'integrity-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Unified Archive Integrity Service ---');

// 1. 缺失归档文件测试
const missingDir = tmpDir('missing-');
const missingReport = ArchiveIntegrityService.checkArchive(path.join(missingDir, 'not_found.jsonl'));
check('缺失归档返回 integrity 为 invalid', missingReport.integrity === INTEGRITY_STATUS.INVALID);
check('缺失归档返回 replayStatus 为 invalid', missingReport.replayStatus === REPLAY_STATUS.INVALID);

// 2. 纯净完整归档测试 (CERTIFIED)
const cleanDir = tmpDir('clean-');
const cleanArchive = path.join(cleanDir, 'experiences.jsonl');
const cleanState = path.join(cleanDir, 'subject-state.json');

const validRec1 = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 100,
    messageCount: 200,
    events: [],
    verifiedEvidence: [
      { evidenceId: 'ev-clean-1', trait: 'quiet_preference', direction: 1, strength: 0.5, messageId: 'm-1', quote: 'q' }
    ],
    rejectedEvidence: [],
    stateChanges: []
  }
};
fs.writeFileSync(cleanArchive, JSON.stringify(validRec1) + '\n', 'utf8');
fs.writeFileSync(cleanState, JSON.stringify({ windowNo: 1, values: { ...DEFAULT_TRAITS } }), 'utf8');

const cleanReport = ArchiveIntegrityService.checkArchive(cleanArchive);
check('纯净归档完整性判定为 certified', cleanReport.integrity === INTEGRITY_STATUS.CERTIFIED);
check('纯净归档 replayStatus 为 complete', cleanReport.replayStatus === REPLAY_STATUS.COMPLETE);
check('纯净归档有效记录数为 1', cleanReport.validCount === 1);
check('纯净归档无损坏行', cleanReport.corruptLines === 0);

const cleanQuery = new ResearchQuery(cleanDir);
const cleanSummaries = cleanQuery.getWindowSummaries();
check('ResearchQuery.getWindowSummaries 对纯净归档报告 CERTIFIED', cleanSummaries.items[0].archiveIntegrity === 'CERTIFIED');
check('ResearchQuery.getWindowDetail 对纯净归档报告 CERTIFIED', cleanQuery.getWindowDetail(1).archiveIntegrity === 'CERTIFIED');

// 3. 包含 JSON 损坏行的归档测试 (Fail-Stop 与防虚假认证)
const corruptDir = tmpDir('corrupt-');
const corruptArchive = path.join(corruptDir, 'experiences.jsonl');
fs.writeFileSync(corruptArchive, JSON.stringify(validRec1) + '\nMALFORMED_JSON_LINE_HERE\n', 'utf8');

const corruptReport = ArchiveIntegrityService.checkArchive(corruptArchive);
check('包含坏行时完整性判定为 partial', corruptReport.integrity === INTEGRITY_STATUS.PARTIAL);
check('包含坏行时 replayStatus 判定为 partial', corruptReport.replayStatus === REPLAY_STATUS.PARTIAL);
check('捕获 1 行损坏行 (corruptLines=1)', corruptReport.corruptLines === 1);

const corruptQuery = new ResearchQuery(corruptDir);
const corruptDetail = corruptQuery.getWindowDetail(1);
check('ResearchQuery 对损坏归档如实报告 PARTIAL 完整性 (绝无虚假 CERTIFIED)', corruptDetail.archiveIntegrity === 'PARTIAL');
check('ResearchQuery 对损坏归档如实报告 PARTIAL replayStatus', corruptDetail.replayStatus === 'PARTIAL');

// 4. 包含未知 recordType 的非法归档测试 (Schema 强校验)
const invalidDir = tmpDir('invalid-type-');
const invalidArchive = path.join(invalidDir, 'experiences.jsonl');
const invalidRec = {
  schemaVersion: 1,
  recordType: 'unauthorized_hacker_record',
  windowNo: 1,
  timestamp: 2000,
  payload: { data: 'poison' }
};
fs.writeFileSync(invalidArchive, JSON.stringify(invalidRec) + '\n', 'utf8');

const invalidReport = ArchiveIntegrityService.checkArchive(invalidArchive);
check('包含未知 recordType 时完整性降级为 uncertified', invalidReport.integrity === INTEGRITY_STATUS.UNCERTIFIED);
check('包含未知 recordType 时记录为 invalidCount=1', invalidReport.invalidCount === 1);
check('诊断信息中准确标明 UNKNOWN_RECORD_TYPE', invalidReport.diagnostics[0].error.includes('UNKNOWN_RECORD_TYPE'));

// 5. 遗留兼容格式 (v0.9.3) 测试 (P0-09)
const legacyDir = tmpDir('legacy-');
const legacyArchive = path.join(legacyDir, 'experiences.jsonl');
const legacyRec = {
  type: 'window_archive',
  windowNo: 1,
  createdAt: 1000,
  turns: 50,
  events: [],
  verifiedEvidence: []
};
fs.writeFileSync(legacyArchive, JSON.stringify(legacyRec) + '\n', 'utf8');

const legacyReport = ArchiveIntegrityService.checkArchive(legacyArchive);
check('遗留 v0.9.3 记录能够被识别为有效结构 (validCount=1)', legacyReport.validCount === 1);
check('准确标记 hasLegacyAdapter 为 true', legacyReport.hasLegacyAdapter === true);
check('遗留兼容格式绝对不自动赋予 certified (integrity === uncertified)', legacyReport.integrity === INTEGRITY_STATUS.UNCERTIFIED);

try {
  fs.rmSync(missingDir, { recursive: true, force: true });
  fs.rmSync(cleanDir, { recursive: true, force: true });
  fs.rmSync(corruptDir, { recursive: true, force: true });
  fs.rmSync(invalidDir, { recursive: true, force: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
} catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
