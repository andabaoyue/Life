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

// -------------------------------------------------------------
// 5. P0-01: Modern Canonical Record 缺链字段绝不 CERTIFIED
// -------------------------------------------------------------
{
  function makeChained(seq, prevHash, overrides = {}) {
    const rec = {
      schemaVersion: 1,
      recordType: 'custom',
      recordId: 'rec-' + String(seq).padStart(6, '0'),
      archiveSeq: seq,
      prevHash,
      windowNo: null,
      timestamp: 1000 + seq,
      payload: { note: 'n-' + seq }
    };
    const merged = Object.assign(rec, overrides);
    merged.recordHash = computeCanonicalRecordHash(merged);
    return merged;
  }

  const base = (missing) => {
    const rec = makeChained(1, 'GENESIS');
    delete rec[missing];
    return rec;
  };

  for (const field of ['archiveSeq', 'recordHash', 'prevHash', 'recordId']) {
    const rep = ArchiveIntegrityService.checkRecords([base(field)]);
    check(`Modern Record 缺 ${field} -> 非 certified`, rep.integrity !== 'certified');
    check(`Modern Record 缺 ${field} -> modern_chain_integrity=missing_fields`, rep.modern_chain_integrity === 'missing_fields');
  }

  const chain = [makeChained(1, 'GENESIS'), makeChained(2, makeChained(1, 'GENESIS').recordHash)];
  const brokenMiddle = makeChained(2, chain[0].recordHash);
  delete brokenMiddle.prevHash;
  const repMixed = ArchiveIntegrityService.checkRecords([chain[0], brokenMiddle, makeChained(3, brokenMiddle.recordHash)]);
  check('Modern Record 某一条缺链字段 -> 整体认证降级 (非 certified)', repMixed.integrity !== 'certified');
  check('Modern Record 某一条缺链字段 -> 诊断标明 MODERN_RECORD_MISSING_CHAIN_FIELDS',
    repMixed.diagnostics.some(d => (d.error || '').includes('MODERN_RECORD_MISSING_CHAIN_FIELDS')));

  const legacyRec = { type: 'window_archive', windowNo: 1, createdAt: 1000, turns: 5, events: [], verifiedEvidence: [] };
  const repLegacy = ArchiveIntegrityService.checkRecords([legacyRec]);
  check('Legacy Adapter 缺链字段 -> 允许读取 (validCount=1)', repLegacy.validCount === 1);
  check('Legacy Adapter 缺链字段 -> UNCERTIFIED (绝不认证)', repLegacy.integrity === 'uncertified');
}

// -------------------------------------------------------------
// 6. P0-02: Archive Tail Anchor（链外尾部锚点，检测“合法尾部截断”）
// -------------------------------------------------------------
{
  const dir = tmpDir('anchor-');
  const archive = new ExperiencesArchive(dir);
  for (let i = 1; i <= 4; i++) {
    archive.appendWindowArchive({ windowNo: i, turns: 10, windowSynthesis: { stableUserFacts: ['f' + i] } });
  }
  const archivePath = path.join(dir, 'experiences.jsonl');
  const anchorPath = archivePath + '.anchor.json';

  const okReport = ArchiveIntegrityService.checkArchive(archivePath);
  check('正常 archive + 正常 anchor -> CERTIFIED', okReport.integrity === 'certified');
  check('正常 archive + 正常 anchor -> tail_anchor=verified', okReport.tail_anchor === 'verified');

  // 删除最后 1 条 record -> TAIL_TRUNCATED
  const allLines = fs.readFileSync(archivePath, 'utf8').trim().split('\n');
  fs.writeFileSync(archivePath, allLines.slice(0, 3).join('\n') + '\n', 'utf8');
  const trunc1 = ArchiveIntegrityService.checkArchive(archivePath);
  check('删除最后 1 条 record -> TAIL_TRUNCATED', trunc1.tail_anchor === 'tail_truncated');
  check('删除最后 1 条 record -> integrity=invalid', trunc1.integrity === 'invalid');

  // 删除最后 N 条 record -> TAIL_TRUNCATED
  fs.writeFileSync(archivePath, allLines.slice(0, 1).join('\n') + '\n', 'utf8');
  const truncN = ArchiveIntegrityService.checkArchive(archivePath);
  check('删除最后 N 条 record -> TAIL_TRUNCATED', truncN.tail_anchor === 'tail_truncated');
  check('删除最后 N 条 record -> integrity=invalid', truncN.integrity === 'invalid');

  // 修改中间 record -> hash mismatch
  fs.writeFileSync(archivePath, allLines.join('\n') + '\n', 'utf8');
  const tamperedLines = JSON.parse(JSON.stringify(allLines));
  const midRec = JSON.parse(tamperedLines[1]);
  midRec.payload.windowSynthesis.stableUserFacts[0] = '被篡改的事实';
  tamperedLines[1] = JSON.stringify(midRec);
  fs.writeFileSync(archivePath, tamperedLines.join('\n') + '\n', 'utf8');
  const tamperedMid = ArchiveIntegrityService.checkArchive(archivePath);
  check('修改中间 record -> hash mismatch (hash_integrity=mismatch)', tamperedMid.hash_integrity === 'mismatch');
  check('修改中间 record -> integrity=invalid', tamperedMid.integrity === 'invalid');

  // 重新排序 -> sequence/hash mismatch
  const reordered = [allLines[0], allLines[2], allLines[1], allLines[3]];
  fs.writeFileSync(anchorPath, fs.readFileSync(anchorPath, 'utf8'), 'utf8');
  fs.writeFileSync(archivePath, reordered.join('\n') + '\n', 'utf8');
  const reorderedReport = ArchiveIntegrityService.checkArchive(archivePath);
  check('重新排序 -> sequence/hash mismatch (integrity=invalid)', reorderedReport.integrity === 'invalid');

  // anchor 被篡改 -> anchor integrity failure
  fs.writeFileSync(archivePath, allLines.join('\n') + '\n', 'utf8');
  const realAnchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  fs.writeFileSync(anchorPath, JSON.stringify(Object.assign({}, realAnchor, { recordHash: 'f'.repeat(64) })), 'utf8');
  const anchorTampered = ArchiveIntegrityService.checkArchive(archivePath);
  check('anchor 被篡改 -> tail_anchor=tampered', anchorTampered.tail_anchor === 'tampered');
  check('anchor 被篡改 -> integrity=invalid (anchor integrity failure)', anchorTampered.integrity === 'invalid');

  // archive 比 anchor 长 -> uncertified / recovery-needed
  fs.writeFileSync(anchorPath, JSON.stringify(realAnchor), 'utf8');
  const lastRec = JSON.parse(allLines[3]);
  const extraRec = {
    schemaVersion: 1,
    recordType: 'custom',
    recordId: 'rec-000005',
    archiveSeq: 5,
    prevHash: lastRec.recordHash,
    windowNo: null,
    timestamp: 5000,
    payload: { note: 'uncommitted' }
  };
  extraRec.recordHash = computeCanonicalRecordHash(extraRec);
  fs.writeFileSync(archivePath, allLines.join('\n') + '\n' + JSON.stringify(extraRec) + '\n', 'utf8');
  const staleReport = ArchiveIntegrityService.checkArchive(archivePath);
  check('archive 比 anchor 长 -> tail_anchor=anchor_stale (UNCOMMITTED_TAIL)', staleReport.tail_anchor === 'anchor_stale');
  check('archive 比 anchor 长 -> 非 certified (fail-closed)', staleReport.integrity !== 'certified');
  check('anchor 落后时 append 拒绝续写 (fail-closed)', archive.append({ recordType: 'custom', payload: { note: 'x' } }) === false);

  // legacy archive 无 anchor -> UNCERTIFIED
  const legacyDir = tmpDir('anchor-legacy-');
  fs.writeFileSync(path.join(legacyDir, 'experiences.jsonl'), JSON.stringify({ type: 'window_archive', windowNo: 1, createdAt: 900, turns: 3, events: [], verifiedEvidence: [] }) + '\n', 'utf8');
  const legacyNoAnchor = ArchiveIntegrityService.checkArchive(path.join(legacyDir, 'experiences.jsonl'));
  check('legacy archive 无 anchor -> UNCERTIFIED', legacyNoAnchor.integrity === 'uncertified');

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  } catch {}
}

// -------------------------------------------------------------
// 7. P1-02: Archive EOI 深度引用一致性（引用不存在/无法证明 -> 绝不认证）
// -------------------------------------------------------------
{
  function makeRelRecord(payloadExtra) {
    const rec = {
      schemaVersion: 1,
      recordType: 'window_summary',
      recordId: 'rec-rel-000001',
      archiveSeq: 1,
      prevHash: 'GENESIS',
      windowNo: 1,
      timestamp: 7000,
      payload: Object.assign({
        events: [{ eventId: 'evt-r1', type: 'message', source: 'user', messageId: 'm-r1', timestamp: 6900, payload: { content: 'q', roundNo: 1 } }],
        observations: [{ observationId: 'obs-r1', eventIds: ['evt-r1'], content: '观察' }],
        interpretations: [{ interpretationId: 'it-r1', observationIds: ['obs-r1'], content: '解读' }],
        verifiedEvidence: [{ evidenceId: 'ev-r1', trait: 'quiet_preference', direction: 1, strength: 0.5, messageId: 'm-r1', quote: 'q' }],
        stateChanges: [{ stateChangeId: 'sc-r1', trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20, evidenceIds: ['ev-r1'] }]
      }, payloadExtra)
    };
    rec.recordHash = computeCanonicalRecordHash(rec);
    return rec;
  }

  const relOK = ArchiveIntegrityService.checkRecords([makeRelRecord({})]);
  check('全部引用可解析 -> relationship_integrity=verified 且 certified', relOK.relationship_integrity === 'verified' && relOK.integrity === 'certified');

  const relObs = ArchiveIntegrityService.checkRecords([makeRelRecord({ observations: [{ observationId: 'obs-x', eventIds: ['evt-missing'], content: 'x' }] })]);
  check('Observation.eventIds 悬空 -> NOT_RECORDED 且非 certified', relObs.relationship_integrity === 'not_recorded' && relObs.integrity !== 'certified');

  const relIt = ArchiveIntegrityService.checkRecords([makeRelRecord({ interpretations: [{ interpretationId: 'it-x', observationIds: ['obs-missing'], content: 'x' }] })]);
  check('Interpretation.observationIds 悬空 -> NOT_RECORDED 且非 certified', relIt.relationship_integrity === 'not_recorded' && relIt.integrity !== 'certified');

  const relSc = ArchiveIntegrityService.checkRecords([makeRelRecord({ stateChanges: [{ stateChangeId: 'sc-x', trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20, evidenceIds: ['ev-missing'] }] })]);
  check('StateChange.evidenceIds 悬空 -> NOT_RECORDED 且非 certified', relSc.relationship_integrity === 'not_recorded' && relSc.integrity !== 'certified');

  const relEv = ArchiveIntegrityService.checkRecords([makeRelRecord({
    verifiedEvidence: [{ evidenceId: 'ev-x', trait: 'quiet_preference', direction: 1, strength: 0.5, messageId: 'm-never-recorded', quote: 'q' }],
    stateChanges: [{ stateChangeId: 'sc-x', trait: 'quiet_preference', delta: 20, previousValue: 0, newValue: 20, evidenceIds: ['ev-x'] }]
  })]);
  check('Evidence.messageId 无对应 provenance -> UNRESOLVED 且非 certified', relEv.relationship_integrity === 'unresolved' && relEv.integrity !== 'certified');

  const relBad = ArchiveIntegrityService.checkRecords([makeRelRecord({ observations: [{ observationId: 'obs-y', eventIds: [''], content: 'y' }] })]);
  check('引用 ID 结构非法 (空串) -> INVALID 且 integrity=invalid', relBad.relationship_integrity === 'invalid' && relBad.integrity === 'invalid');
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
