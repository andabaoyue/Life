/**
 * test/v13-perception-channel.test.js
 *
 * Life v1.3-a 具身环境知觉注入通道专项测试
 *
 * 核心不变式与验收判据：
 * 1. 知觉挂载通道：ATTENDED 知觉候选质性描述注入 user 消息末尾；
 * 2. 提示词前缀缓存不变式：systemText() 绝不含任何环境知觉文本（零污染）；
 * 3. 严格节流：同窗最多 N=3 次，相邻挂载间隔 >= 5 轮；
 * 4. 严格 Null-Perception 原则：无真实感知或未达门限时不注入任何占位符；
 * 5. ATTENDED ≠ SUBJECT_ACQUIRED：知觉注入绝不改写 SubjectState 与 experiences.jsonl；
 * 6. 成本遥测：挂载事件落盘至 experiment-telemetry.jsonl (recordType: 'perception_attach')。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'v13-perception-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. _formatPerceptionSnippet 质性描述格式化与映射
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const brain = new Brain(dir, { ...DEFAULTS });

  const sPoke = brain._formatPerceptionSnippet({ category: 'tactile_poke' });
  check('1.1 tactile_poke 质性格式化包含【此刻的环境知觉】与碰触描述',
    sPoke.includes('【此刻的环境知觉】') && sPoke.includes('被人轻轻碰了一下'));

  const sSuspend = brain._formatPerceptionSnippet({ category: 'host_suspend' });
  check('1.2 host_suspend 质性格式化包含休眠描述',
    sSuspend.includes('【此刻的环境知觉】') && sSuspend.includes('宿主设备的休眠停顿'));

  const sResume = brain._formatPerceptionSnippet({ category: 'host_resume' });
  check('1.3 host_resume 质性格式化包含唤醒描述',
    sResume.includes('【此刻的环境知觉】') && sResume.includes('唤醒与重启运转'));

  const sLock = brain._formatPerceptionSnippet({ category: 'host_lock' });
  check('1.4 host_lock 质性格式化包含锁屏描述',
    sLock.includes('【此刻的环境知觉】') && sLock.includes('屏幕被锁定'));

  const sUnlock = brain._formatPerceptionSnippet({ category: 'host_unlock' });
  check('1.5 host_unlock 质性格式化包含解锁描述',
    sUnlock.includes('【此刻的环境知觉】') && sUnlock.includes('屏幕已解锁'));

  const sNull = brain._formatPerceptionSnippet(null);
  check('1.6 无候选时返回空字符串（Null-Perception）', sNull === '');

  const sEmpty = brain._formatPerceptionSnippet({});
  check('1.7 空对象候选时返回空字符串', sEmpty === '');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 2. 节流策略：同窗最多 3 次 + 间隔 >= 5 轮
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const brain = new Brain(dir, {
    ...DEFAULTS,
    experimentMode: 'experimental',
    experimentModules: { digitalUmwelt: true }
  });

  // 辅助注入一条 ATTENDED 知觉记录
  function injectAttended(category = 'tactile_poke', salience = 80) {
    brain.recentPerceptions.push({
      candidate: {
        category,
        salience,
        qualitativeDescriptor: 'intense_activity',
        perceptionId: 'perc-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6)
      },
      gateResult: { status: 'ATTENDED', attended: true },
      timestamp: Date.now(),
      consumed: false
    });
  }

  // 初始轮次 totalTurns = 0, windowNo = 1
  brain.memory.data.totalTurns = 0;
  brain.memory.data.windowNo = 1;

  // 第一次注入并消费 (turn 0)
  injectAttended('tactile_poke');
  const snip1 = brain._drainAttendedPerception();
  check('2.1 第 0 轮知觉成功挂载', snip1.includes('被人轻轻碰了一下'));
  check('2.2 挂载后窗口计数为 1', brain._windowPerceptionCount === 1);
  check('2.3 挂载后最后挂载轮次为 0', brain._lastPerceptionTurn === 0);

  // 在第 2 轮尝试挂载 (gap = 2 < 5)，应被节流拦截
  brain.memory.data.totalTurns = 2;
  injectAttended('host_lock');
  const snipBlockedGap = brain._drainAttendedPerception();
  check('2.4 间隔小于 5 轮时被严格节流拦截（返回空串）', snipBlockedGap === '');

  // 前进到第 5 轮 (gap = 5 - 0 = 5 >= 5)，应放行 (第 2 次挂载)
  brain.memory.data.totalTurns = 5;
  injectAttended('host_lock');
  const snip2 = brain._drainAttendedPerception();
  check('2.5 间隔达到 5 轮后成功挂载第 2 次', snip2.includes('屏幕被锁定'));
  check('2.6 挂载后窗口计数为 2', brain._windowPerceptionCount === 2);

  // 前进到第 10 轮 (gap = 10 - 5 = 5 >= 5)，放行 (第 3 次挂载)
  brain.memory.data.totalTurns = 10;
  injectAttended('host_unlock');
  const snip3 = brain._drainAttendedPerception();
  check('2.7 间隔达到 5 轮后成功挂载第 3 次', snip3.includes('屏幕已解锁'));
  check('2.8 挂载后窗口计数为 3', brain._windowPerceptionCount === 3);

  // 前进到第 16 轮 (gap = 6 >= 5)，但同窗已达 3 次上限，应被同窗节流拦截
  brain.memory.data.totalTurns = 16;
  injectAttended('tactile_drag');
  const snipBlockedCap = brain._drainAttendedPerception();
  check('2.9 同窗达到 3 次上限后被同窗截断（返回空串）', snipBlockedCap === '');

  // 跨窗：新窗口 windowNo = 2
  brain.memory.data.windowNo = 2;
  brain.memory.data.totalTurns = 25; // gap = 25 - 10 = 15 >= 5
  injectAttended('host_resume');
  const snipNewWin = brain._drainAttendedPerception();
  check('2.10 窗口演进后计数自动归零，新窗恢复挂载能力', snipNewWin.includes('唤醒与重启运转'));
  check('2.11 新窗挂载后计数为 1', brain._windowPerceptionCount === 1);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 3. 端到端问答与前缀缓存不变式 (Prompt Cache Invariant)
// -------------------------------------------------------------
(async () => {
  const dir = tmpDir();
  const brain = new Brain(dir, {
    ...DEFAULTS,
    apiKey: 'mock-key',
    experimentMode: 'experimental',
    experimentModules: { digitalUmwelt: true }
  });

  let capturedMessages = null;
  brain.api = {
    stream: async (messages, onDelta) => {
      capturedMessages = JSON.parse(JSON.stringify(messages));
      if (onDelta) onDelta('你好呀！');
      return {
        text: '你好呀！',
        usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens: 10 }
      };
    }
  };

  // 3.1 注入 ATTENDED 感知并调用 ask
  brain.processEnvironmentalPerception({
    category: 'tactile_poke',
    rawIntensity: 75,
    timestamp: Date.now()
  });

  check('3.1 成功注入 perception candidate 到 recentPerceptions',
    brain.recentPerceptions.length === 1 && brain.recentPerceptions[0].gateResult.status === 'ATTENDED');

  await brain.ask('你在吗？');

  check('3.2 ask 成功发起', !!capturedMessages);

  // 检查 user 消息尾部
  const lastUserMsg = capturedMessages.filter(m => m.role === 'user').pop();
  check('3.3 最后一条 user 消息末尾包含【此刻的环境知觉】',
    lastUserMsg && lastUserMsg.content.includes('【此刻的环境知觉】'));
  check('3.4 最后一条 user 消息包含质性描述「被人轻轻碰了一下」',
    lastUserMsg && lastUserMsg.content.includes('被人轻轻碰了一下'));

  // 检查 systemText 铁律：绝不被感知污染
  const systemMsg = capturedMessages.find(m => m.role === 'system');
  const systemText = systemMsg ? systemMsg.content : brain.memory.systemText();
  check('3.5 system 提示词绝不包含【此刻的环境知觉】(前缀缓存铁律)',
    !systemText.includes('【此刻的环境知觉】'));
  check('3.6 system 提示词绝不包含「被人轻轻碰了一下」',
    !systemText.includes('被人轻轻碰了一下'));
  check('3.7 system 提示词绝不包含 tactile_poke',
    !systemText.includes('tactile_poke'));

  // 3.8 认识论防线：感知绝不写入 SubjectState 与 experiences.jsonl
  const subValues = brain.subjectState ? brain.subjectState.values : {};
  check('3.8 SubjectState 中无感知数据渗入', !('tactile_poke' in subValues));

  const archiveRecords = brain.experiencesArchive.readAll();
  const hasPerceptionInArchive = archiveRecords.some(r =>
    r.recordType === 'perception' || JSON.stringify(r).includes('tactile_poke'));
  check('3.9 experiences.jsonl 归档中无感知记录渗入 (ATTENDED ≠ SUBJECT_ACQUIRED)',
    !hasPerceptionInArchive);

  // 3.10 遥测文件校验
  const telemetryContent = fs.readFileSync(brain.telemetryPath, 'utf8').trim().split('\n');
  const telemetryRecords = telemetryContent.map(l => JSON.parse(l));
  const attachRec = telemetryRecords.find(r => r.recordType === 'perception_attach');
  check('3.10 experiment-telemetry.jsonl 中记录了 perception_attach 遥测', !!attachRec);
  if (attachRec) {
    check('3.11 遥测 category 精准为 tactile_poke', attachRec.category === 'tactile_poke');
    check('3.12 遥测 windowNo 为 1', attachRec.windowNo === 1);
    check('3.13 遥测包含有效 salience', typeof attachRec.salience === 'number');
  }

  // 3.14 下一轮空感知（Null-Perception）校验
  capturedMessages = null;
  brain.memory.data.totalTurns = 1; // 仍在节流期内，且无新感知
  await brain.ask('第二句话');
  const secondUserMsg = capturedMessages.filter(m => m.role === 'user').pop();
  check('3.14 无感知时 user 消息末尾绝不包含【此刻的环境知觉】',
    secondUserMsg && !secondUserMsg.content.includes('【此刻的环境知觉】'));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
