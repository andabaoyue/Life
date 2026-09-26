/**
 * test/legacy-schema-certification.test.js
 * 
 * 初澜数字生命实验：v0.9.5.2 缺失 schemaVersion 规范处理与防冒充认证专项测试 (Test C)
 * 
 * 核心验证：
 * 1. 缺失 schemaVersion 时严禁程序隐式补写为原生 schemaVersion: 1
 * 2. 缺失 schemaVersion 的记录必须经过 LegacySchemaAdapter，附带 sourceSchema 属性
 * 3. 能够识别的过渡记录标为 legacy-v0.9.4 + LEGACY_COMPATIBLE
 * 4. 无法识别的历史记录标为 legacy-unknown + LEGACY_UNKNOWN
 * 5. 任何包含 Legacy 适配记录的归档，完整性只能为 UNCERTIFIED，绝不得直接 CERTIFIED
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeArchiveRecord } = require('../src/experience-schema');
const { validateArchiveRecord, ArchiveIntegrityService, INTEGRITY_STATUS } = require('../src/archive-integrity');
const { DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'legacy-schema-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Legacy Schema Adaptation and Certification Gate (Test C) ---');

// 1. 直接校验缺 schemaVersion 的裸记录必须失败
const rawNoSchema = {
  recordType: 'diagnostic',
  payload: { info: 'test' }
};

const directValid = validateArchiveRecord(rawNoSchema);
check('直接对缺 schemaVersion 记录做底层 Schema 校验必须失败', directValid.valid === false);
check('失败原因为 MISSING_OR_INVALID_SCHEMA_VERSION', directValid.reason === 'MISSING_OR_INVALID_SCHEMA_VERSION');

// 2. normalizeArchiveRecord 必须显式走 LegacySchemaAdapter 路径
const adapted = normalizeArchiveRecord(rawNoSchema);
check('标准化后具备 compatibilityAdapter 标记', adapted.compatibilityAdapter === 'LegacySchemaAdapter');
check('标准化后具备 sourceSchema: legacy-v0.9.4', adapted.sourceSchema === 'legacy-v0.9.4');
check('标准化后具有 canonicalSchema: v1', adapted.canonicalSchema === 'v1');
check('标准化后标记 legacyStatus 为 LEGACY_COMPATIBLE', adapted.legacyStatus === 'LEGACY_COMPATIBLE');

// 3. 无法识别的结构：标为 legacy-unknown
const unknownRaw = {
  recordType: 'arbitrary_unknown_type',
  foo: 'bar'
};
const adaptedUnknown = normalizeArchiveRecord(unknownRaw);
check('未知结构标准化后标记为 legacy-unknown', adaptedUnknown.sourceSchema === 'legacy-unknown');
check('未知结构标准化后 legacyStatus 为 LEGACY_UNKNOWN', adaptedUnknown.legacyStatus === 'LEGACY_UNKNOWN');

// 4. 归档完整性门禁：包含 Legacy 记录的归档绝对不得认证为 CERTIFIED
const dir = tmpDir('legacy-cert-');
const archivePath = path.join(dir, 'experiences.jsonl');
const statePath = path.join(dir, 'subject-state.json');

// 写入一条缺 schemaVersion 的 v0.9.4 风格记录
const uncertifiedLine = JSON.stringify({
  recordType: 'diagnostic',
  timestamp: 1000,
  windowNo: 1,
  payload: { message: 'no schemaVersion originally present' }
});

fs.writeFileSync(archivePath, uncertifiedLine + '\n', 'utf8');
fs.writeFileSync(statePath, JSON.stringify({ windowNo: 1, values: { ...DEFAULT_TRAITS } }), 'utf8');

const report = ArchiveIntegrityService.checkArchive(archivePath);
check('检测到 Legacy 适配器介入', report.hasLegacyAdapter === true);
check('包含 Legacy 适配记录的归档完整性判定为 uncertified (严禁直接 certified)', report.integrity === INTEGRITY_STATUS.UNCERTIFIED);
check('Replay 状态保持 complete (平滑支持复盘执行)', report.replayStatus === 'complete');

// 5. 写入无法识别的 legacy-unknown 记录
const corruptDir = tmpDir('legacy-unknown-');
const corruptArchive = path.join(corruptDir, 'experiences.jsonl');
fs.writeFileSync(corruptArchive, JSON.stringify({ recordType: 'something_completely_unknown', foo: 'bar' }) + '\n', 'utf8');

const unknownReport = ArchiveIntegrityService.checkArchive(corruptArchive);
check('未知 Legacy 记录被标记为 invalidCount=1', unknownReport.invalidCount === 1);
check('未知 Legacy 记录归档完整性为 uncertified', unknownReport.integrity === INTEGRITY_STATUS.UNCERTIFIED);
check('未知 Legacy 记录回放状态降级为 partial', unknownReport.replayStatus === 'partial');

try {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(corruptDir, { recursive: true, force: true });
} catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
