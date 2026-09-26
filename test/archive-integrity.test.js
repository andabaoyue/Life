/**
 * test/archive-integrity.test.js
 * 
 * Life v0.9.6 实验基线强化测试集 2：归档不可变哈希链与完整性校验专项测试
 * 
 * 检验点：
 * 1. Canonical Schema 完整字段校验（archiveSeq, recordId, prevHash, recordHash, schemaVersion）
 * 2. 序列号严格单调递增 (1, 2, 3...) 与 recordId 对齐 (rec-000001, rec-000002...)
 * 3. 哈希链完整性验证（首条 prevHash === 'GENESIS', 后续 prevHash === 前一条 recordHash）
 * 4. 篡改检测（修改 payload 字段立即导致 hash_integrity 校验失败）
 * 5. 乱序检测（行顺序颠倒导致 sequence_integrity / hash_integrity 校验失败）
 * 6. fsync 落盘持久化验证（每条追加操作均经过操作系统底层持久化刷盘）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExperiencesArchive } = require('../src/experiences-archive');
const { ArchiveIntegrityService, computeCanonicalRecordHash } = require('../src/archive-integrity');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'archive-integrity-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. Canonical Schema 完整字段与哈希链递增验证
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  // 写入第 1 条：窗口小结
  const r1 = archive.appendWindowArchive({
    windowNo: 1,
    targetTurnCount: 100,
    actualTurnCount: 100,
    closeReason: 'turn_limit',
    turns: 100,
    messageCount: 200,
    segments: [],
    windowSynthesis: { stableUserFacts: ['事实1'] }
  });
  check('第 1 条记录追加成功', r1 === true);

  // 写入第 2 条：自我投影
  const r2 = archive.appendSelfProjection({
    windowNo: 1,
    projectionVersion: '1.0',
    sourceExperienceRecords: ['rec-000001'],
    sourceStateChanges: [],
    entriesAdded: 1,
    result: { currentSelfText: '自我叙事A' }
  });
  check('第 2 条记录追加成功', r2 === true);

  // 写入第 3 条：恢复事件
  const r3 = archive.appendRecord('recovery_event', 1, {
    action: 'state_rebuilt_from_replay',
    windowNo: 1,
    reason: 'test_audit'
  });
  check('第 3 条记录追加成功', r3 === true);

  const records = archive.readAll();
  check('归档记录总数为 3', records.length === 3);

  // 逐条验证 Canonical Schema 字段
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const expectedSeq = i + 1;
    const expectedRecordId = 'rec-' + String(expectedSeq).padStart(6, '0');

    check(`[第${expectedSeq}条] schemaVersion 严格为 1`, rec.schemaVersion === 1);
    check(`[第${expectedSeq}条] archiveSeq 严格递增为 ${expectedSeq}`, rec.archiveSeq === expectedSeq);
    check(`[第${expectedSeq}条] recordId 严格对应 ${expectedRecordId}`, rec.recordId === expectedRecordId);
    check(`[第${expectedSeq}条] recordHash 满足 64 位十六进制 SHA-256`, typeof rec.recordHash === 'string' && /^[0-9a-f]{64}$/.test(rec.recordHash));
    check(`[第${expectedSeq}条] recordHash 与确定性重算结果完全一致`, rec.recordHash === computeCanonicalRecordHash(rec));
  }

  // 哈希链关联验证
  check('首条记录 prevHash 严格为 GENESIS', records[0].prevHash === 'GENESIS');
  check('第 2 条记录 prevHash 等于第 1 条 recordHash', records[1].prevHash === records[0].recordHash);
  check('第 3 条记录 prevHash 等于第 2 条 recordHash', records[2].prevHash === records[1].recordHash);

  // ArchiveIntegrityService 链条全局校验
  const report = ArchiveIntegrityService.checkRecords(records);
  check('完整归档 report.integrity 为 certified', report.integrity === 'certified');
  check('完整归档 report.sequence_integrity 为 monotonic', report.sequence_integrity === 'monotonic');
  check('完整归档 report.hash_integrity 为 verified', report.hash_integrity === 'verified');
  check('完整归档 report.syntax_integrity 为 valid', report.syntax_integrity === 'valid');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 2. 篡改检测 (Tampering Detection)
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  for (let i = 1; i <= 3; i++) {
    archive.appendWindowArchive({
      windowNo: i,
      targetTurnCount: 100,
      actualTurnCount: 100,
      closeReason: 'turn_limit',
      turns: 100,
      windowSynthesis: { stableUserFacts: [`事实${i}`] }
    });
  }

  const validRecords = archive.readAll();
  check('未篡改前 integrity 报告正常', ArchiveIntegrityService.checkRecords(validRecords).hash_integrity === 'verified');

  // 模拟非法篡改中间记录的 payload
  const tamperedRecords = JSON.parse(JSON.stringify(validRecords));
  tamperedRecords[1].payload.windowSynthesis.stableUserFacts[0] = '被恶意伪造的事实';

  const tamperedReport = ArchiveIntegrityService.checkRecords(tamperedRecords);
  check('篡改 payload 后 hash_integrity 校验标记为 mismatch', tamperedReport.hash_integrity === 'mismatch');
  check('篡改后 integrity 状态判定为 invalid', tamperedReport.integrity === 'invalid');
  check('篡改检测捕获到 hash 不匹配的错误记录', tamperedReport.diagnostics.some(e => (e.error || '').includes('RECORD_HASH_MISMATCH')));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 3. 乱序检测 (Reordering Detection)
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  for (let i = 1; i <= 3; i++) {
    archive.appendWindowArchive({
      windowNo: i,
      turns: 100,
      windowSynthesis: { stableUserFacts: [`w-${i}`] }
    });
  }

  const validRecords = archive.readAll();

  // 模拟第 2 条与第 3 条颠倒顺序
  const reorderedRecords = [validRecords[0], validRecords[2], validRecords[1]];
  const reorderedReport = ArchiveIntegrityService.checkRecords(reorderedRecords);

  check('颠倒顺序后 sequence_integrity 校验失败 (invalid)', reorderedReport.sequence_integrity === 'invalid');
  check('颠倒顺序后 hash_integrity 校验失败 (前驱哈希链断裂)', reorderedReport.hash_integrity === 'mismatch');
  check('乱序报告 integrity 为 invalid', reorderedReport.integrity === 'invalid');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 4. fsync 底层落盘持久化验证
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  let fsyncCalled = 0;
  const origFsyncSync = fs.fsyncSync;
  fs.fsyncSync = function(fd) {
    fsyncCalled++;
    return origFsyncSync.apply(this, arguments);
  };

  try {
    archive.appendWindowArchive({ windowNo: 1, turns: 100, windowSynthesis: {} });
    archive.appendSelfProjection({ windowNo: 1, entriesAdded: 0 });
    check('每次写入均调用 fsyncSync 进行硬件级持久化刷盘', fsyncCalled >= 2);

    // 验证底层文件内容直接可见且完全落盘
    const rawContent = fs.readFileSync(archive.path, 'utf8').trim().split('\n');
    check('底层文件立即包含 2 行落盘数据', rawContent.length === 2);
    const line1 = JSON.parse(rawContent[0]);
    const line2 = JSON.parse(rawContent[1]);
    check('第 1 行已正确持久化 recordHash', !!line1.recordHash);
    check('第 2 行已正确持久化 prevHash 关联', line2.prevHash === line1.recordHash);
  } finally {
    fs.fsyncSync = origFsyncSync;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
