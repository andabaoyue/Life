/**
 * test/archive-write-gate.test.js
 * 
 * Life v0.9.7 实验有效性收口专项测试：Archive Write Gate (F-10 / User Constraint #3)
 * 
 * 检验点：
 * 1. 伪造/跳跃 archiveSeq 在写盘前被硬门禁拦截，append 返回 false，磁盘无脏数据
 * 2. 伪造 prevHash 在写盘前被硬门禁拦截，append 返回 false，磁盘无脏数据
 * 3. 伪造 recordHash 在写盘前被硬门禁拦截，append 返回 false，磁盘无脏数据
 * 4. 显式传入正确 archiveSeq/prevHash/recordHash 时正常通过并落盘
 * 5. 未知 recordType 在写盘前被硬门禁拦截，磁盘绝不写入
 * 6. synthetic / generated 标记在写盘前被硬门禁拦截
 * 7. 非法 payload（非对象）在写盘前被硬门禁拦截
 * 8. F-10 典型复现：先写正常记录，再尝试写入伪造序号/哈希记录，断言写盘失败且磁盘底座保持 certified 纯净
 * 9. getLastSequencedRecord() 对被破坏尾部的鉴伪能力：绝不盲目信赖非法残留记录
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

function tmpDir(prefix = 'archive-gate-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Archive Write Gate (F-10) ---');

// 1. 伪造 archiveSeq 拦截验证
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const res = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    payload: { probe: 'test' },
    archiveSeq: 999
  });

  check('伪造 archiveSeq: 999 被拦截', res === false);
  check('磁盘文件未被创建或为空', !fs.existsSync(archive.path) || fs.readFileSync(archive.path, 'utf8').trim() === '');
  check('archive 计数仍为 0', archive.count() === 0);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 2. 伪造 prevHash 拦截验证
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const res = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    payload: { probe: 'test' },
    prevHash: 'bogus_hash_value'
  });

  check('首条记录伪造 prevHash 被拦截', res === false);
  check('磁盘无脏写入', !fs.existsSync(archive.path) || fs.readFileSync(archive.path, 'utf8').trim() === '');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 3. 伪造 recordHash 拦截验证
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const res = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    payload: { probe: 'test' },
    recordHash: 'forged_hash_64_chars_long_0123456789abcdef0123456789abcdef01234567'
  });

  check('伪造 recordHash 被拦截', res === false);
  check('磁盘无脏写入', !fs.existsSync(archive.path) || fs.readFileSync(archive.path, 'utf8').trim() === '');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 4. 显式传入合法匹配字段顺利落盘
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const rawEntry = {
    schemaVersion: 1,
    recordType: 'diagnostic',
    recordId: 'rec-000001',
    archiveSeq: 1,
    windowNo: 1,
    timestamp: 1234567890,
    payload: { probe: 'valid' },
    prevHash: 'GENESIS'
  };
  const expectedHash = computeCanonicalRecordHash(rawEntry);
  rawEntry.recordHash = expectedHash;

  const res = archive.append(rawEntry);
  check('显式传入完全匹配的 seq/prevHash/recordHash 成功落盘', res === true);
  check('记录数精准为 1', archive.count() === 1);
  const r = archive.readAll()[0];
  check('落盘哈希与计算哈希一致', r.recordHash === expectedHash);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 5. 非法 recordType 拦截验证
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const res = archive.append({
    recordType: 'unregistered_telemetry_type',
    windowNo: 1,
    payload: { a: 1 }
  });

  check('非法 recordType 被写门禁拦截', res === false);
  check('磁盘文件未被污染', !fs.existsSync(archive.path) || fs.readFileSync(archive.path, 'utf8').trim() === '');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 6. synthetic / generated 标记拦截验证
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const resSynth = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    synthetic: true,
    payload: { note: 'fake' }
  });
  check('synthetic 记录被写门禁拦截', resSynth === false);

  const resGen = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    generated: true,
    payload: { note: 'fake' }
  });
  check('generated 记录被写门禁拦截', resGen === false);
  check('磁盘文件未被污染', !fs.existsSync(archive.path) || fs.readFileSync(archive.path, 'utf8').trim() === '');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 7. 非法 payload（非对象）拦截验证
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  const res1 = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    payload: 'string_payload'
  });
  check('非对象 payload 被写门禁拦截', res1 === false);

  const res2 = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    payload: [1, 2, 3]
  });
  check('数组 payload 被写门禁拦截', res2 === false);
  check('磁盘文件未被污染', !fs.existsSync(archive.path) || fs.readFileSync(archive.path, 'utf8').trim() === '');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 8. F-10 完整复现与防污染验证
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  // 第一步：写入合法诊断记录
  const r1 = archive.appendRecord('diagnostic', 1, { x: 1 });
  check('F-10 步骤 1: 正常记录写入成功', r1 === true);
  check('F-10 步骤 1: 当前记录数为 1', archive.count() === 1);

  // 第二步：尝试注入伪造记录 (F-10 证据中的测试用例)
  const r2 = archive.append({
    recordType: 'diagnostic',
    windowNo: 1,
    payload: { x: 2 },
    archiveSeq: 999,
    prevHash: 'bogus',
    recordHash: 'forged'
  });
  check('F-10 步骤 2: 注入伪造 seq/prevHash/recordHash 记录被拦截', r2 === false);
  check('F-10 步骤 2: 磁盘文件仍然只有 1 行记录', archive.count() === 1);

  // 第三步：完整性验证必须仍然为 CERTIFIED，底座绝不受污染
  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('底座完整性不受污染 (certified)', report.integrity === 'certified');
  check('序列完整性不受污染 (monotonic)', report.sequence_integrity === 'monotonic');
  check('哈希链完整性不受污染 (verified)', report.hash_integrity === 'verified');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 9. getLastSequencedRecord() 鉴伪能力验证（忽略磁盘尾部非法损坏行）
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  // 正常写入第 1 条
  archive.appendRecord('diagnostic', 1, { valid: true });
  const validRec = archive.getLastSequencedRecord();
  check('正常写入后 getLastSequencedRecord 返回第 1 条', validRec && validRec.archiveSeq === 1);

  // 模拟外部直接往文件尾部强行追加一行篡改伪造数据
  const forgedLine = JSON.stringify({
    schemaVersion: 1,
    recordType: 'diagnostic',
    recordId: 'rec-000002',
    archiveSeq: 2,
    timestamp: Date.now(),
    windowNo: 1,
    payload: { tampered: true },
    prevHash: 'WRONG_HASH',
    recordHash: 'FAKE_RECORD_HASH'
  }) + '\n';
  fs.appendFileSync(archive.path, forgedLine, 'utf8');

  // getLastSequencedRecord 不应把这行伪造行认作链尾
  const headAfterTamper = archive.getLastSequencedRecord();
  check('文件尾部被非法写入篡改行时，getLastSequencedRecord 拒绝假尾部并安全回退到真实第 1 条',
    headAfterTamper && headAfterTamper.archiveSeq === 1 && headAfterTamper.recordHash === validRec.recordHash);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
