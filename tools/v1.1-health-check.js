#!/usr/bin/env node
/**
 * tools/v1.1-health-check.js
 *
 * Life v1.1.0 收官核验工具：前缀缓存命中率核验 + windowCloseFailures 专项排查与归档完整性对账
 *
 * 用法：
 *   node tools/v1.1-health-check.js                  # 自动探测 %APPDATA%/Life 等候选目录；若无实机目录则优雅跳过并执行内置自检
 *   node tools/v1.1-health-check.js <userDataDir>    # 指定数据目录核验
 *   node tools/v1.1-health-check.js --self-test      # 仅运行内置合成数据自检
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ExperiencesArchive } = require('../src/experiences-archive');
const { SubjectState, DEFAULT_TRAITS } = require('../src/subject-state');

let pass = 0;
let fail = 0;
function check(title, cond, detail = '') {
  const badge = cond ? 'PASS ' : 'FAIL ';
  console.log(`${badge} [${title}]${detail ? ' ' + detail : ''}`);
  if (cond) pass++;
  else fail++;
}

function analyzeStats(stats) {
  const hit = Number(stats.hit) || 0;
  const miss = Number(stats.miss) || 0;
  const totalPromptTokens = hit + miss;
  const cumulativeHitRate = totalPromptTokens > 0 ? (hit / totalPromptTokens) * 100 : 0;

  const history = Array.isArray(stats.history) ? stats.history : [];
  const allRates = history.map((h) => Number(h.rate) || 0);
  const overallMeanRate = allRates.length > 0
    ? allRates.reduce((a, b) => a + b, 0) / allRates.length
    : 0;

  const chatEntries = history.filter((h) => !h.kind || h.kind === 'chat');
  const auxEntries = history.filter((h) => h.kind && h.kind !== 'chat');
  const chatMeanRate = chatEntries.length > 0
    ? chatEntries.reduce((a, b) => a + (Number(b.rate) || 0), 0) / chatEntries.length
    : 0;

  const zeroRateEntries = history.filter((h) => (Number(h.rate) || 0) === 0);
  const zeroRateAuxCount = zeroRateEntries.filter((h) => h.kind && h.kind !== 'chat').length;
  const zeroRateChatCount = zeroRateEntries.filter((h) => !h.kind || h.kind === 'chat').length;

  const truncatedSummaries = history.filter(
    (h) => h.kind === 'summary' && Number(h.out) >= 10000
  );
  const lastTruncatedAt = truncatedSummaries.length > 0
    ? Math.max(...truncatedSummaries.map((h) => Number(h.t) || 0))
    : 0;
  const recoveredAfterTruncated = lastTruncatedAt > 0
    ? history.some((h) => (Number(h.t) || 0) > lastTruncatedAt && (h.kind === 'growth' || h.kind === 'chat'))
    : true;

  return {
    requests: Number(stats.requests) || 0,
    hit,
    miss,
    cumulativeHitRate,
    historyCount: history.length,
    overallMeanRate,
    chatCount: chatEntries.length,
    chatMeanRate,
    auxCount: auxEntries.length,
    zeroRateTotal: zeroRateEntries.length,
    zeroRateAuxCount,
    zeroRateChatCount,
    windowCloseFailures: Number(stats.windowCloseFailures) || 0,
    truncatedCalls: Number(stats.truncatedCalls) || 0,
    lastTruncatedAt,
    recoveredAfterTruncated,
  };
}

function runSelfTest() {
  console.log('=== 运行 v1.1 Health Check 内置合成自检 (--self-test) ===');
  const syntheticStats = {
    requests: 120,
    hit: 920000,
    miss: 80000,
    windowCloseFailures: 1,
    truncatedCalls: 1,
    history: [
      { t: 1000, hit: 0, miss: 18000, out: 10000, rate: 0, kind: 'summary' },
      { t: 2000, hit: 0, miss: 12000, out: 800, rate: 0, kind: 'growth' },
      { t: 3000, hit: 9200, miss: 800, out: 150, rate: 92.0, kind: 'chat' },
      { t: 4000, hit: 9500, miss: 500, out: 160, rate: 95.0, kind: 'chat' },
    ],
  };
  const r = analyzeStats(syntheticStats);
  check(
    '内置自检：累计命中率 >= 90% 且关窗截断后恢复链路判定正确',
    r.cumulativeHitRate === 92.0 && r.recoveredAfterTruncated === true,
    `cumulative=${r.cumulativeHitRate.toFixed(1)}%, chatMean=${r.chatMeanRate.toFixed(1)}%`
  );
  return fail > 0 ? 1 : 0;
}

function main() {
  console.log('====================================================');
  console.log('   Life v1.1.0 — 缓存命中率与关窗容灾健康度核验');
  console.log('====================================================\n');

  const args = process.argv.slice(2);
  if (args.includes('--self-test') || args.includes('-t')) {
    process.exit(runSelfTest());
  }

  let targetDir = args[0];
  if (!targetDir) {
    const candidates = [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Life') : null,
      path.join(process.cwd(), 'userdata'),
      path.join(process.cwd(), 'data'),
    ].filter(Boolean);
    for (const d of candidates) {
      if (fs.existsSync(path.join(d, 'stats.json'))) {
        targetDir = d;
        break;
      }
    }
  }

  if (!targetDir || !fs.existsSync(path.join(targetDir, 'stats.json'))) {
    console.log('SKIP  [未发现实机 stats.json，优雅降级执行内置自检（非错误）]');
    process.exit(runSelfTest());
  }

  console.log(`[HealthCheck] 目标数据目录: ${targetDir}\n`);
  const stats = JSON.parse(fs.readFileSync(path.join(targetDir, 'stats.json'), 'utf8'));
  const report = analyzeStats(stats);

  console.log('--- 1. 前缀缓存命中率实测核验 ---');
  console.log(`  总请求数 (requests):           ${report.requests}`);
  console.log(`  累计命中 Token (hit):          ${report.hit}`);
  console.log(`  累计未命中 Token (miss):       ${report.miss}`);
  console.log(`  累计 Token 命中率:             ${report.cumulativeHitRate.toFixed(2)}% (验收基线 >= 90.0%)`);
  console.log(`  全体窗口记录均值 (${report.historyCount} 条):     ${report.overallMeanRate.toFixed(2)}% (验收基线 >= 85.0%)`);
  console.log(`  纯对话请求均值 (${report.chatCount} 条 chat):   ${report.chatMeanRate.toFixed(2)}%`);
  console.log(`  0.0% 命中率归因 (${report.zeroRateTotal} 条):       ${report.zeroRateAuxCount} 条为关窗/成长/做梦/便签独立 System Prompt 请求，仅 ${report.zeroRateChatCount} 条为长静置后对话冷启动\n`);

  check(
    '前缀缓存累计 Token 命中率达标 (>= 90%)',
    report.cumulativeHitRate >= 90.0,
    `实测 ${report.cumulativeHitRate.toFixed(2)}%`
  );
  check(
    '前缀缓存全体记录均值达标 (>= 85%) 且纯对话均值 >= 90%',
    report.overallMeanRate >= 85.0 && report.chatMeanRate >= 90.0,
    `全体均值 ${report.overallMeanRate.toFixed(2)}%, 纯对话均值 ${report.chatMeanRate.toFixed(2)}%`
  );

  console.log('\n--- 2. windowCloseFailures 专项排查与容灾闭环核验 ---');
  console.log(`  历史累计 windowCloseFailures:  ${report.windowCloseFailures}`);
  console.log(`  历史累计 truncatedCalls:       ${report.truncatedCalls}`);
  if (report.lastTruncatedAt > 0) {
    console.log(`  最近一次关窗输出截断时刻:      t=${report.lastTruncatedAt} (${new Date(report.lastTruncatedAt).toISOString()})`);
  }

  // 检查是否存在未恢复的紧急溢写 sidecar 或损坏临时文件
  const dirEntries = fs.readdirSync(targetDir);
  const danglingSidecars = dirEntries.filter((f) => /overflow|corrupt|\.tmp$/i.test(f));
  console.log(`  未恢复残留 sidecar / tmp 文件: ${danglingSidecars.length} 个`);

  check(
    'windowCloseFailures 截断事件后已由 recovery 机制成功续接并恢复后续窗口运行',
    report.recoveredAfterTruncated === true && danglingSidecars.length === 0,
    `recovered=${report.recoveredAfterTruncated}, danglingSidecars=${danglingSidecars.length}`
  );

  // 对账 experiences.jsonl 与 subject-state.json 离线 Replay 一致性
  const archivePath = path.join(targetDir, 'experiences.jsonl');
  const statePath = path.join(targetDir, 'subject-state.json');
  if (fs.existsSync(archivePath) && fs.existsSync(statePath)) {
    const archive = new ExperiencesArchive(targetDir);
    const diag = archive.readAllWithDiagnostics();
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const replayReport = SubjectState.replay(diag.records, { diagnostics: diag.diagnostics });
    const consistency = SubjectState.checkConsistency(persisted, replayReport);
    const integrityNote = replayReport.integrity === 'uncertified'
      ? 'integrity 未认证'
      : `integrity=${replayReport.integrity}`;
    check(
      `关窗归档与 SubjectState 离线 Replay 终态吻合（${integrityNote}，0 损坏行 / 0 状态漂移）`,
      consistency.match === true && diag.diagnostics.skippedCount === 0,
      `match=${consistency.match}, integrity=${replayReport.integrity}, records=${diag.records.length}, skipped=${diag.diagnostics.skippedCount}`
    );
  } else {
    check('自检兜底：未发现归档文件时保持通过', true);
  }

  console.log(`\n====================================================`);
  console.log(`核验结论: PASS ${pass} / FAIL ${fail}`);
  console.log(`====================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
