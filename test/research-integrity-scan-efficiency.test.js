/**
 * test/research-integrity-scan-efficiency.test.js
 * 
 * Codex H-04 性能与算法复杂度验证：
 * 验证 ResearchQuery.getWindows() 不再对每个 Window 重复执行全量 Archive Integrity Scan。
 * 复杂度由 O(Window × Archive) 降为 O(Archive)。
 * 
 * 验证项：
 * 1. 存在 N (如 100) 个 Window 时，单次 getWindows() 调用只触发 1 次 checkArchive。
 * 2. 对同一无修改的 Archive，连续调用 getWindows()、getWindowDetail()、getWindowRounds() 命中快照缓存，不再触发冗余磁盘扫描。
 * 3. 当归档文件发生变更 (mtime/size 改变) 时，快照缓存自动失效并准确重算。
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { ResearchQuery } = require('../src/research-query');
const { ArchiveIntegrityService } = require('../src/archive-integrity');
const { wrapArchiveRecord } = require('../src/experience-schema');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

async function runTests() {
  console.log('--- 测试 H-04: getWindows() 全量扫描消减与完整性缓存验证 ---');

  const testDir = path.join(os.tmpdir(), 'life-test-integrity-efficiency-' + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  const originalCheckArchive = ArchiveIntegrityService.checkArchive;
  let checkArchiveCallCount = 0;

  // 拦截统计 checkArchive 调用次数
  ArchiveIntegrityService.checkArchive = function(archivePath) {
    checkArchiveCallCount++;
    return originalCheckArchive.call(ArchiveIntegrityService, archivePath);
  };

  try {
    const archivePath = path.join(testDir, 'experiences.jsonl');
    const statePath = path.join(testDir, 'subject-state.json');

    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      traits: { quiet_preference: 50 },
      evidenceIndex: {}
    }), 'utf8');

    // 构造 100 个 Windows 的合法归档（P0-01: 完整链字段；P0-02: Tail Anchor）
    const { computeCanonicalRecordHash } = require('../src/archive-integrity');
    const lines = [];
    const WINDOW_COUNT = 100;
    let prevHash = 'GENESIS';
    for (let w = 1; w <= WINDOW_COUNT; w++) {
      const rec = wrapArchiveRecord('window_summary', w, {
        windowNo: w,
        turns: 100,
        createdAt: 1000 + w * 10,
        messageCount: 50,
        events: [{
          eventId: `evt-w${w}-1`,
          messageId: `msg-w${w}-1`,
          type: 'message',
          source: 'user',
          text: `User message window ${w}`,
          payload: { content: `User message window ${w}` },
          timestamp: 1000 + w * 10
        }],
        stateChanges: []
      }, {
        archiveSeq: w,
        recordId: `rec-${String(w).padStart(6, '0')}`,
        prevHash,
        timestamp: 1000 + w * 10
      });
      rec.recordHash = computeCanonicalRecordHash(rec);
      prevHash = rec.recordHash;
      lines.push(JSON.stringify(rec));
    }
    fs.writeFileSync(archivePath, lines.join('\n') + '\n', 'utf8');
    const messageAttestations = Array.from({ length: WINDOW_COUNT }, (_, idx) => ({
      messageId: `msg-w${idx + 1}-1`,
      sourceContentHash: crypto.createHash('sha256').update(`User message window ${idx + 1}`, 'utf8').digest('hex'),
      windowNo: idx + 1,
      sourceRole: 'user',
      attestedAt: 1000 + (idx + 1) * 10
    }));
    fs.writeFileSync(archivePath + '.provenance.json', JSON.stringify({
      schemaVersion: 1,
      messageAttestations,
      evidenceAttestations: [],
      updatedAt: Date.now()
    }), 'utf8');
    const firstScanRec = JSON.parse(lines[0]);
    const lastScanRec = JSON.parse(lines[lines.length - 1]);
    fs.writeFileSync(archivePath + '.anchor.json', JSON.stringify({
      schemaVersion: 1,
      genesis: {
        schemaVersion: 1,
        archiveSeq: firstScanRec.archiveSeq,
        recordId: firstScanRec.recordId,
        recordHash: firstScanRec.recordHash,
        recordedAt: Date.now()
      },
      archiveSeq: lastScanRec.archiveSeq,
      recordId: lastScanRec.recordId,
      recordHash: lastScanRec.recordHash,
      updatedAt: Date.now()
    }), 'utf8');

    const query = new ResearchQuery(testDir);

    // -------------------------------------------------------------------------
    // 验证 1: 包含 100 个 Window 时，单次 getWindows() 只调用 1 次 checkArchive
    // -------------------------------------------------------------------------
    console.log(`\n[场景 1: ${WINDOW_COUNT} 个 Window 汇总扫描]`);
    checkArchiveCallCount = 0;

    const res = query.getWindows({ limit: 100 });
    check('getWindows 返回了全部 100 个窗口', res.items && res.items.length === 100);
    check(`checkArchive 仅被执行 1 次 (实测: ${checkArchiveCallCount} 次，消除了 O(W×A) 循环扫描)`, checkArchiveCallCount === 1);
    check('首个窗口完整性状态为 CERTIFIED', res.items[0].archiveIntegrity === 'CERTIFIED');
    check('末尾窗口完整性状态为 CERTIFIED', res.items[99].archiveIntegrity === 'CERTIFIED');

    // -------------------------------------------------------------------------
    // 验证 2: 再次调用 getWindows() 与 getWindowDetail() 命中快照缓存
    // -------------------------------------------------------------------------
    console.log('\n[场景 2: 未修改文件的高频查询命中快照缓存]');
    const countBefore = checkArchiveCallCount;

    query.getWindows({ limit: 50 });
    query.getWindowDetail(1);
    query.getWindowDetail(50);
    query.getWindowRounds(1);

    const callIncrease = checkArchiveCallCount - countBefore;
    check(`连续 4 次重型查询未增加 checkArchive 次数 (增加: ${callIncrease} 次，命中快照缓存)`, callIncrease === 0);

    // -------------------------------------------------------------------------
    // 验证 3: 文件修改后，缓存自动失效并准确重算
    // -------------------------------------------------------------------------
    console.log('\n[场景 3: 文件修改后自动失效与重新扫描]');
    // 人为休眠片刻确保 mtime 变化
    await new Promise(r => setTimeout(r, 100));

    // 追加损坏行以测试缓存感知文件变化
    fs.appendFileSync(archivePath, 'CORRUPTED LINE CONTENT\n', 'utf8');

    const corruptRes = query.getWindows({ limit: 10 });
    check('文件变更后重新触发了 checkArchive 扫描', checkArchiveCallCount > countBefore);
    check('缓存失效后准确反映最新完整性状态 (PARTIAL 或 UNCERTIFIED)', corruptRes.items[0].archiveIntegrity === 'PARTIAL' || corruptRes.items[0].archiveIntegrity === 'UNCERTIFIED');

  } finally {
    // 恢复原始方法
    ArchiveIntegrityService.checkArchive = originalCheckArchive;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (e) {}
  }

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
