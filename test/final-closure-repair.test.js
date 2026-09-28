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
  const report = ArchiveIntegrityService.checkArchive(path.join(dir, 'experiences.jsonl'));
  assert.strictEqual(report.integrity, 'uncertified');
  pass('ArchiveIntegrity 传播 UNCERTIFIED summary 状态');
  fs.rmSync(dir, { recursive: true, force: true });

  // Version provenance: normal package is real; unavailable package is unknown, not 0.9.7.
  assert.strictEqual(getPackageVersion(path.join(os.tmpdir(), 'package-does-not-exist.json')), null);
  const manifest = createExperimentRunManifest({ now: 1, idSuffix: 'test', runId: 'run-version-test' });
  assert.strictEqual(manifest.lifeVersion, '0.9.7.1');
  pass('package.json 正常读取真实版本，不可读取时返回未知');

  // Research task cleanup retains only queryable terminal metadata.
  const researchDir = tmp('closure-research-');
  const research = new ResearchService(researchDir, { taskRetentionMs: 0 });
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
