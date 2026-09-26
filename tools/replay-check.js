#!/usr/bin/env node
/**
 * tools/replay-check.js
 * 
 * 初澜数字生命实验：Replay 离线推演一致性核验工具 (v0.9.4)
 * 
 * 核心功能：
 * 1. 读取指定目录下的 experiences.jsonl 与 subject-state.json
 * 2. 纯离线执行 SubjectState.replay()
 * 3. 校验 Replay 终态与持久化 State 是否严格一致
 * 4. 输出核验报告，退出码 0 表示一致，1 表示存在漂移
 */

const fs = require('fs');
const path = require('path');
const { ExperiencesArchive } = require('../src/experiences-archive');
const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');

function runSelfTest() {
  console.log('=== 运行 Replay 校验器内部自检 ===');
  const initialTraits = { ...DEFAULT_TRAITS };
  const mockRecords = [
    {
      schemaVersion: 1,
      recordType: 'window_summary',
      windowNo: 1,
      timestamp: 1000,
      payload: {
        verifiedEvidence: [
          { evidenceId: 'ev-001', trait: 'quiet_preference', direction: 1, strength: 1.0 }
        ],
        rejectedEvidence: []
      }
    }
  ];

  const report = SubjectState.replay(mockRecords, { initialTraits, stepWeight: 20, maxDeltaPerWindow: 50 });
  const mockPersisted = {
    values: {
      ...initialTraits,
      quiet_preference: initialTraits.quiet_preference + 20
    }
  };

  const consistency = SubjectState.checkConsistency(mockPersisted, report);
  if (consistency.match) {
    console.log('PASS Replay 校验器内部自检通过');
    return 0;
  } else {
    console.error('FAIL Replay 校验器自检失败:', consistency.diffs);
    return 1;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test') || args.includes('-t')) {
    process.exit(runSelfTest());
  }

  // 确定目标数据目录
  let targetDir = args[0];
  if (!targetDir) {
    const candidateDirs = [
      path.join(process.cwd(), 'userdata'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Life') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'deskpet') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'gptgirl') : null, // legacy migration fallback
      path.join(process.cwd(), 'data')
    ].filter(Boolean);

    for (const d of candidateDirs) {
      if (fs.existsSync(path.join(d, 'subject-state.json')) || fs.existsSync(path.join(d, 'experiences.jsonl'))) {
        targetDir = d;
        break;
      }
    }
  }

  if (!targetDir || !fs.existsSync(targetDir)) {
    console.log('[ReplayCheck] 未指定或未发现已存在的用户数据目录。');
    console.log('[ReplayCheck] 提示: node tools/replay-check.js <userDataDir> 或 node tools/replay-check.js --self-test');
    // 执行自检确保工具健全
    process.exit(runSelfTest());
  }

  const statePath = path.join(targetDir, 'subject-state.json');
  const archivePath = path.join(targetDir, 'experiences.jsonl');

  if (!fs.existsSync(statePath) && !fs.existsSync(archivePath)) {
    console.log(`[ReplayCheck] 目录 ${targetDir} 中未找到 subject-state.json 或 experiences.jsonl`);
    process.exit(0);
  }

  const archive = new ExperiencesArchive(targetDir);
  const diag = archive.readAllWithDiagnostics();
  console.log(`[ReplayCheck] 数据目录: ${targetDir}`);
  console.log(`[ReplayCheck] 读取归档记录: ${diag.records.length} 条 (有效: ${diag.diagnostics.validCount}, 异常跳过: ${diag.diagnostics.skippedCount})`);

  let persistedState = { values: { ...DEFAULT_TRAITS } };
  if (fs.existsSync(statePath)) {
    try {
      persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      console.log(`[ReplayCheck] 读取持久化状态: Window #${persistedState.windowNo || 1}`);
    } catch (e) {
      console.error(`[ReplayCheck] 警告: 读取持久化状态文件失败: ${e.message}`);
    }
  } else {
    console.log('[ReplayCheck] 提示: 未发现持久化状态文件，将以 DEFAULT_TRAITS 作为初始核验基线');
  }

  const replayReport = SubjectState.replay(diag.records, { diagnostics: diag.diagnostics });
  const consistency = SubjectState.checkConsistency(persistedState, replayReport);

  console.log('\n--- Replay 离线推演报告 ---');
  console.log(`已处理记录: ${replayReport.processedRecords}`);
  console.log(`已拒绝证据: ${replayReport.rejectedRecords}`);
  console.log(`产生状态跃迁: ${replayReport.stateChanges.length} 次`);
  console.log(`归档完整性: ${replayReport.integrity.toUpperCase()}`);
  console.log('推演终态:', replayReport.finalState);
  console.log('持久化终态:', persistedState.values || {});

  if (consistency.certified) {
    console.log('\nPASS [一致且完全认证] State Replay matches persisted state (Certified)');
    process.exit(0);
  } else if (consistency.match && !consistency.certified) {
    console.warn('\nFAIL [未认证] State matches replayed survivors, but Archive integrity is UNCERTIFIED!');
    console.warn(`  - 损坏/跳过记录数: ${diag.diagnostics.skippedCount}`);
    process.exit(1);
  } else {
    console.error('\nFAIL [漂移] Replay mismatch detected!');
    for (const d of consistency.diffs) {
      console.error(`  - Trait [${d.trait}]: 持久化值 = ${d.persisted}, Replay 推演值 = ${d.replayed}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runSelfTest };
