/**
 * test/telemetry.test.js
 * 
 * Life v0.9.6 实验基线强化测试集 7：实验遥测与前缀缓存归因专项测试
 * 
 * 检验点：
 * 1. experiment-telemetry.jsonl 严格 Append-Only，落盘格式为合法 JSON 行
 * 2. telemetrySeq 严格自增 (1, 2, 3...)
 * 3. 时间戳 timestamp 单调递增
 * 4. 缓存破坏原因 (cacheBreakReason) 七大类别精准归因：
 *    - window_boundary (窗口小结)
 *    - memory_merge (长期记忆合并)
 *    - wardrobe_change (换装改变)
 *    - writing_mode_change (创作模式切换)
 *    - manual_memory_delete (手动删除窗口)
 *    - config_prompt_change (配置/人设调整)
 *    - unknown (冷启动或无因由未命中)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');
const { Wardrobe } = require('../src/wardrobe');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'telemetry-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. Telemetry 基础写入、自增序号与时间戳单调性
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const brain = new Brain(dir, { ...DEFAULTS });

  check('初始 telemetryPath 存在', typeof brain.telemetryPath === 'string');

  // 追加 3 条不同请求类型的遥测数据
  const t1 = brain.appendTelemetry({
    requestType: 'chat',
    promptTokens: 100,
    promptCacheHitTokens: 80,
    promptCacheMissTokens: 20,
    completionTokens: 10,
    cacheHitRate: 0.8,
    cacheBreakReason: 'unknown'
  });

  const t2 = brain.appendTelemetry({
    requestType: 'summary',
    promptTokens: 200,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 200,
    completionTokens: 50,
    cacheHitRate: 0.0,
    cacheBreakReason: 'window_boundary'
  });

  const t3 = brain.appendTelemetry({
    requestType: 'merge',
    promptTokens: 150,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 150,
    completionTokens: 40,
    cacheHitRate: 0.0,
    cacheBreakReason: 'memory_merge'
  });

  check('t1 写入成功', t1 && t1.telemetrySeq === 1);
  check('t2 序号递增为 2', t2 && t2.telemetrySeq === 2);
  check('t3 序号递增为 3', t3 && t3.telemetrySeq === 3);

  // 读取底层文件验证
  const content = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n');
  check('底层文件恰好包含 3 行合法 JSON', content.length === 3 && content.every(l => {
    try { JSON.parse(l); return true; } catch { return false; }
  }));

  const records = content.map(l => JSON.parse(l));
  check('第 1 条 telemetrySeq 为 1', records[0].telemetrySeq === 1);
  check('第 2 条 telemetrySeq 为 2', records[1].telemetrySeq === 2);
  check('第 3 条 telemetrySeq 为 3', records[2].telemetrySeq === 3);
  check('时间戳单调性满足 t1 <= t2 <= t3', records[0].timestamp <= records[1].timestamp && records[1].timestamp <= records[2].timestamp);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 2. 缓存破坏归因 (cacheBreakReason) 七大类别精准映射
// -------------------------------------------------------------
async function testCacheBreakAttribution() {
  const dir = tmpDir();
  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurns: 2,
    keepTailMessages: 1
  });

  const wd = new Wardrobe(dir);
  brain.wardrobe = wd;

  // 2.1 冷启动/初次未命中: unknown
  brain.track({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10 }, false, 'chat');
  let records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('冷启动未命中归因为 unknown', records[records.length - 1].cacheBreakReason === 'unknown');

  // 2.2 换装导致缓存破坏: wardrobe_change
  brain.recordCacheBreak('wardrobe_change');
  brain.track({ prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50, completion_tokens: 10 }, false, 'chat');
  records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('换装后未命中归因为 wardrobe_change', records[records.length - 1].cacheBreakReason === 'wardrobe_change');

  // 2.3 窗口小结边界导致缓存破坏: window_boundary
  brain.recordCacheBreak('window_boundary');
  brain.track({ prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens: 10 }, false, 'chat');
  records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('关窗后未命中归因为 window_boundary', records[records.length - 1].cacheBreakReason === 'window_boundary');

  // 2.4 长期记忆合并导致缓存破坏: memory_merge
  brain.recordCacheBreak('memory_merge');
  brain.track({ prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70, completion_tokens: 10 }, false, 'chat');
  records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('记忆合并后未命中归因为 memory_merge', records[records.length - 1].cacheBreakReason === 'memory_merge');

  // 2.5 创作模式切换: writing_mode_change
  brain.recordCacheBreak('writing_mode_change');
  brain.track({ prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 10 }, false, 'chat');
  records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('创作模式切换未命中归因为 writing_mode_change', records[records.length - 1].cacheBreakReason === 'writing_mode_change');

  // 2.6 配置/人设调整: config_prompt_change
  brain.recordCacheBreak('config_prompt_change');
  brain.track({ prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 90, completion_tokens: 10 }, false, 'chat');
  records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('配置提示词调整归因为 config_prompt_change', records[records.length - 1].cacheBreakReason === 'config_prompt_change');

  // 2.7 手动删除记忆窗口: manual_memory_delete
  brain.deleteWindow(1);
  brain.track({ prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 90, completion_tokens: 10 }, false, 'chat');
  records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('手动删除窗口后归因为 manual_memory_delete', records[records.length - 1].cacheBreakReason === 'manual_memory_delete');

  // 2.8 缓存命中 (miss === 0) 时无破坏原因 (null)
  brain.track({ prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 0, completion_tokens: 10 }, false, 'chat');
  records = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('完全命中缓存时 cacheBreakReason 为 null', records[records.length - 1].cacheBreakReason === null);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  await testCacheBreakAttribution();
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
