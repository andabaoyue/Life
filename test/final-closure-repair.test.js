'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');
const { ResearchService } = require('../src/research-service');
const { DEFAULTS } = require('../src/config');
const { ArchiveIntegrityService } = require('../src/archive-integrity');
const { getPackageVersion, createExperimentRunManifest } = require('../src/experiment-run');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function pass(name) { console.log('PASS  ' + name); }

// Telemetry: absent, empty, restart, and damaged tail are all non-destructive.
{
  const missingDir = tmp('closure-telemetry-missing-');
  const missing = new Brain(missingDir, { ...DEFAULTS });
  assert.strictEqual(missing.telemetrySeq, 0);
  pass('不存在 telemetry 文件时序号从 0 开始');
  fs.writeFileSync(missing.telemetryPath, '', 'utf8');
  const empty = new Brain(missingDir, { ...DEFAULTS });
  assert.strictEqual(empty.telemetrySeq, 0);
  pass('空 telemetry 文件时序号从 0 开始');
  empty.appendTelemetry({ timestamp: 1 });
  empty.appendTelemetry({ timestamp: 2 });
  assert.strictEqual(empty.telemetrySeq, 2);
  pass('单进程 telemetry append 连续递增');
  const restarted = new Brain(missingDir, { ...DEFAULTS });
  assert.strictEqual(restarted.telemetrySeq, 2);
  assert.strictEqual(restarted.appendTelemetry({ timestamp: 3 }).telemetrySeq, 3);
  pass('模拟进程重启后恢复最后合法 telemetrySeq');
  fs.appendFileSync(restarted.telemetryPath, '{broken-tail\n', 'utf8');
  const damaged = new Brain(missingDir, { ...DEFAULTS });
  assert.strictEqual(damaged.telemetrySeq, 3);
  assert.strictEqual(damaged.appendTelemetry({ timestamp: 4 }).telemetrySeq, 4);
  pass('telemetry 尾部损坏时保留既有序号且安全继续 append');
  fs.rmSync(missingDir, { recursive: true, force: true });
}

// Plain text summary is preserved but cannot create structured epistemic effects.
(async () => {
  const dir = tmp('closure-summary-');
  const brain = new Brain(dir, { ...DEFAULTS, experimentMode: 'baseline', windowTurns: 2, keepTailMessages: 1 });
  brain.memory.append('user', '这是一个纯文本摘要测试。');
  brain.memory.append('assistant', '保留原始信息，但不要把它当作结构化证据。');
  const before = JSON.stringify(brain.subjectState.data.values);
  brain.api = { complete: async () => ({ text: 'plain text summary: structured summary unavailable', usage: {} }) };
  const closed = await brain.closeWindow();
  assert.strictEqual(closed, true);
  const record = brain.experiencesArchive.readAll().find(r => r.recordType === 'window_summary');
  assert.ok(record && record.payload.epistemicStatus === 'UNCERTIFIED');
  assert.strictEqual(record.payload.structuredSummaryAvailable, false);
  assert.strictEqual(record.payload.summaryFailureReason, 'NON_JSON_SUMMARY');
  pass('非 JSON summary 可保全但明确标记 UNCERTIFIED');
  assert.strictEqual(record.payload.observations.length, 0);
  assert.strictEqual(record.payload.interpretations.length, 0);
  assert.strictEqual(record.payload.verifiedEvidence.length, 0);
  assert.strictEqual(JSON.stringify(brain.subjectState.data.values), before);
  pass('UNCERTIFIED plain-text summary 不产生未经验证的 SubjectState mutation');

  // 🔴 2026-10-07 真实事故回归：解析失败时**绝不能让原始输出进她的意识**。
  //
  //   事故经过：第 5 段小结的 LLM 输出是 JSON，但中文引号未转义 ⇒ JSON.parse 抛错
  //   ⇒ 当时 `summaryTextForMemory` 的初值是 `text`（原始坏 JSON）⇒ 原封不动经
  //   closeWindow() 进了 memory.windows[].text ⇒ 她的 system prompt 里出现了
  //   `{"segments":[{"range":"1-20"…` 这串碎片，还带 `m-000401` 内部 ID。
  //
  //   这条断言锁的是**结果**（她的记忆里是什么），不是实现细节。
  const memWinText = String(brain.memory.data.windows[0].text || '');
  // ⚠️ 判据是**精准**的：只有「看起来像 JSON 但坏了」才拦；
  //   普通散文小结（本 mock 就是）**必须放行** —— 丢掉它等于白丢一段真实经历。
  assert.strictEqual(memWinText, 'plain text summary: structured summary unavailable',
    '散文小结必须原样放行（不得被降级误伤），实际 = ' + JSON.stringify(memWinText.slice(0, 60)));
  pass('🔴 散文小结放行（精准判据不误伤非 JSON 输出）');

  // 对照的另一半：**看起来像 JSON 的坏输出必须被拦下** —— 这才是本次事故的形态。
  //   单独起一个 brain，让 mock 回一段坏 JSON（模拟 LLM 未转义引号导致解析失败）。
  {
    const jsonDir = tmp('closure-badjson-');
    const bj = new Brain(jsonDir, { ...DEFAULTS, experimentMode: 'baseline', windowTurns: 2, keepTailMessages: 1 });
    bj.memory.append('user', '坏 JSON 小结测试。');
    bj.memory.append('assistant', '应当被拦下。');
    // 形态与事故一致：半截 JSON + 未转义引号
    bj.api = { complete: async () => ({ text: '{"segments":[{"range":"1-20","userGiven":["用户说"喂"（m-000401）"]', usage: {} }) };
    await bj.closeWindow();
    const t = String(bj.memory.data.windows[0].text || '');
    assert.ok(!t.trim().startsWith('{'),
      '坏 JSON 不得进她的记忆，实际 = ' + JSON.stringify(t.slice(0, 60)));
    assert.ok(!/m-[0-9]{6}/.test(t), '内部 messageId 不得出现在她的记忆里');
    assert.ok(t.includes('未能结构化解析'), '应替换为中性降级文本，实际 = ' + JSON.stringify(t.slice(0, 60)));
    pass('🔴 坏 JSON 被拦下并降级为中性文本（事故形态回归）');
    // 对照：归档里仍如实保留原始输出（证据不被清洗）
    const recBad = bj.experiencesArchive.readAll().find(r => r.recordType === 'window_summary');
    assert.ok(recBad.payload.rawSummaryText.trim().startsWith('{'),
      '归档必须保留原始坏 JSON（研究证据不得篡改）');
    pass('对照：归档仍保留原始坏 JSON（证据不被清洗）');
    fs.rmSync(jsonDir, { recursive: true, force: true });
  }

  // 反向对照：归档里仍**如实保留** rawSummaryText —— 降级只针对「她的意识」，
  //   归档是研究证据，绝不能也被清洗（否则等于篡改证据）。
  assert.strictEqual(record.payload.rawSummaryText, 'plain text summary: structured summary unavailable');
  pass('对照：归档 rawSummaryText 仍如实保留原始输出（证据不被清洗）');

  const report = ArchiveIntegrityService.checkArchive(path.join(dir, 'experiences.jsonl'));
  assert.strictEqual(report.integrity, 'uncertified');
  pass('ArchiveIntegrity 传播 UNCERTIFIED summary 状态');
  fs.rmSync(dir, { recursive: true, force: true });

  // Version provenance: normal package is real; unavailable package is unknown, not 0.9.7.
  assert.strictEqual(getPackageVersion(path.join(os.tmpdir(), 'package-does-not-exist.json')), null);
  const manifest = createExperimentRunManifest({ now: 1, idSuffix: 'test', runId: 'run-version-test' });
  assert.strictEqual(manifest.lifeVersion, getPackageVersion());
  pass('package.json 正常读取真实版本，不可读取时返回未知');

  // Research task cleanup retains only queryable terminal metadata.
  const researchDir = tmp('closure-research-');
  // SEC-04 自动 cleanup 接管 retention 到期释放；本测试专测手动 cleanup 机械，故 fixture 用大 retention 避免竞争
  const research = new ResearchService(researchDir, { taskRetentionMs: 3600000 });
  const running = research.startReplayTask();
  assert.strictEqual(research.activeTasks.has(running.taskId), true);
  pass('running replay task 保留在 activeTasks');
  await new Promise(resolve => setTimeout(resolve, 20));
  const completed = research.getReplayTaskStatus(running.taskId);
  assert.strictEqual(completed.status, 'completed');
  const removedCompleted = research.cleanupReplayTasks({ retentionMs: 0, now: Date.now() + 1 });
  assert.strictEqual(removedCompleted, 1);
  assert.strictEqual(research.activeTasks.has(running.taskId), false);
  assert.strictEqual(research.getReplayTaskStatus(running.taskId).status, 'completed');
  pass('completed task 清理 runtime 后保留最小查询 metadata 与 replay 结果');
  const cancelled = research.startReplayTask();
  assert.strictEqual(research.cancelReplayTask(cancelled.taskId), true);
  assert.strictEqual(research.cleanupReplayTasks({ retentionMs: 0, now: Date.now() + 1 }), 1);
  assert.strictEqual(research.getReplayTaskStatus(cancelled.taskId).status, 'cancelled');
  pass('cancelled task 可清理且查询状态不丢失');
  const failedId = 'failed-fixture';
  research.activeTasks.set(failedId, { taskId: failedId, status: 'failed', stage: 'failed', percent: 0, cancelled: false, result: null, error: 'fixture', completedAt: Date.now() });
  assert.strictEqual(research.cleanupReplayTasks({ retentionMs: 0, now: Date.now() + 1 }), 1);
  assert.strictEqual(research.getReplayTaskStatus(failedId).status, 'failed');
  pass('failed task 可清理且查询状态不丢失');
  fs.rmSync(researchDir, { recursive: true, force: true });
  console.log('全部通过');
})().catch(err => { console.error(err); process.exitCode = 1; });
