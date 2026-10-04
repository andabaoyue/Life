/**
 * test/dream-gate.test.js
 * 
 * Life v0.9.7 成本门禁式梦境系统：双重门禁与纯本地判定专项测试
 * 
 * 检验点：
 * 1. 低张力平淡窗口：0 API 调用，门禁判定拒绝 (INSUFFICIENT_TENSION)
 * 2. 高情绪方差 (Arousal 方差突破门槛)：第一道门禁触发，允许进入成本审查
 * 3. Arousal 单次突变尖峰 (Spike 突破门槛)：第一道门禁触发
 * 4. 认知方向冲突 (同一特质正负证据对立撕裂)：第一道门禁触发
 * 5. 第二道成本门禁 - 窗口间隔约束 (minimumDreamIntervalWindows)：
 *    间隔不足拒绝进入 Dream API
 * 6. 第二道成本门禁 - 24小时频次硬顶 (maximumDreamCallsPer24h)：
 *    24小时内达到上限拒绝调用
 * 7. 纯函数确定性：同输入必然得到同输出
 */

const {
  evaluateDreamGate,
  DEFAULT_DREAM_CONFIG
} = require('../src/dream-system');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// -------------------------------------------------------------
// 1. 低张力平淡窗口：拒绝做梦
// -------------------------------------------------------------
{
  const calmHistory = [
    { arousal: 50 },
    { arousal: 51 },
    { arousal: 49 },
    { arousal: 50 },
    { arousal: 50 }
  ];

  const res = evaluateDreamGate({
    windowNo: 5,
    stateHistory: calmHistory,
    verifiedEvidence: [
      { trait: 'vitality', direction: 1, strength: 0.2 }
    ]
  });

  check('低张力窗口 eligible 为 false', res.eligible === false);
  check('低张力窗口 allowDream 为 false', res.allowDream === false);
  check('原因标记为 INSUFFICIENT_TENSION', res.reason === 'INSUFFICIENT_TENSION');
  check('Arousal 方差极低', res.metrics.arousalVariance < 2.0, `var: ${res.metrics.arousalVariance}`);
}

// -------------------------------------------------------------
// 2. 高情绪方差触发 (Condition A1)
// -------------------------------------------------------------
{
  const turbulentHistory = [
    { arousal: 20 },
    { arousal: 80 },
    { arousal: 15 },
    { arousal: 85 },
    { arousal: 10 }
  ];

  const res = evaluateDreamGate({
    windowNo: 5,
    stateHistory: turbulentHistory,
    verifiedEvidence: []
  });

  check('高情绪方差窗口 eligible 为 true', res.eligible === true);
  check('成本门禁通过时 allowDream 为 true', res.allowDream === true);
  check('方差远超默认门限 15.0', res.metrics.arousalVariance > 15.0, `var: ${res.metrics.arousalVariance}`);
}

// -------------------------------------------------------------
// 3. Arousal 突变尖峰触发 (Condition A2)
// -------------------------------------------------------------
{
  const spikeHistory = [
    { arousal: 50 },
    { arousal: 50 },
    { arousal: 85 }, // 单次跃迁幅度 35 >= 25.0
    { arousal: 50 }
  ];

  const res = evaluateDreamGate({
    windowNo: 5,
    stateHistory: spikeHistory,
    verifiedEvidence: []
  });

  check('突变尖峰触发 eligible 为 true', res.eligible === true);
  check('最大尖峰幅度 >= 25.0', res.metrics.maxArousalSpike >= 25.0, `spike: ${res.metrics.maxArousalSpike}`);
  check('允许做梦', res.allowDream === true);
}

// -------------------------------------------------------------
// 4. 认知冲突触发 (Condition B)
// -------------------------------------------------------------
{
  const conflictingEvidence = [
    { trait: 'philosophical_curiosity', direction: 1, strength: 0.9 },
    { trait: 'philosophical_curiosity', direction: -1, strength: 0.8 }
  ];

  const res = evaluateDreamGate({
    windowNo: 5,
    stateHistory: [{ arousal: 50 }, { arousal: 50 }],
    verifiedEvidence: conflictingEvidence
  });

  check('认知冲突触发 eligible 为 true', res.eligible === true);
  check('冲突分值突破门槛', res.metrics.cognitiveConflictScore >= 0.8, `score: ${res.metrics.cognitiveConflictScore}`);
  check('允许做梦', res.allowDream === true);
}

// -------------------------------------------------------------
// 5. 第二道成本门禁：窗口间隔约束 (minimumDreamIntervalWindows)
// -------------------------------------------------------------
{
  const turbulentHistory = [{ arousal: 10 }, { arousal: 90 }];

  // 上一次在窗口 4 刚做过梦，当前仅到窗口 5 (gap = 1 < 3)
  const res = evaluateDreamGate({
    windowNo: 5,
    lastDreamWindow: 4,
    stateHistory: turbulentHistory
  });

  check('张力达到，eligible 为 true', res.eligible === true);
  check('因窗口间隔不足，costGatePassed 为 false', res.costGatePassed === false);
  check('最终 allowDream 严格拦截为 false', res.allowDream === false);
  check('原因清晰反映间隔不足', res.reason.includes('INTERVAL_TOO_SHORT'));
}

// -------------------------------------------------------------
// 6. 第二道成本门禁：24小时调用上限硬顶 (maximumDreamCallsPer24h)
// -------------------------------------------------------------
{
  const turbulentHistory = [{ arousal: 10 }, { arousal: 90 }];
  const now = Date.now();

  const recentDreams = [
    { windowNo: 1, generatedAt: now - 3600 * 1000 },
    { windowNo: 4, generatedAt: now - 1800 * 1000 }
  ];

  const res = evaluateDreamGate({
    windowNo: 10,
    lastDreamWindow: 4, // gap = 6 >= 3 通过
    now,
    dreamHistory: recentDreams, // 24小时内已有 2 次
    stateHistory: turbulentHistory
  });

  check('张力达到，eligible 为 true', res.eligible === true);
  check('因达到24小时上限，costGatePassed 为 false', res.costGatePassed === false);
  check('最终 allowDream 拦截为 false', res.allowDream === false);
  check('原因清晰反映超限', res.reason.includes('DAILY_RATE_LIMIT_EXCEEDED'));
}

// -------------------------------------------------------------
// 7. 纯函数确定性测试
// -------------------------------------------------------------
{
  const input = {
    windowNo: 7,
    stateHistory: [{ arousal: 40 }, { arousal: 70 }, { arousal: 30 }],
    verifiedEvidence: [{ trait: 'vitality', direction: 1, strength: 0.5 }]
  };

  const r1 = evaluateDreamGate(input);
  const r2 = evaluateDreamGate(input);

  check('纯函数两次评估结果 100% 严格一致',
    JSON.stringify(r1) === JSON.stringify(r2) &&
    r1.metrics.arousalVariance === r2.metrics.arousalVariance
  );
}

// -------------------------------------------------------------
// 8. 真实交互唤醒度轨迹计算与门禁触发 (Arousal Trajectory Integration)
// -------------------------------------------------------------
{
  const { computeWindowArousalTrajectory } = require('../src/dream-system');
  const now = 1700000000000;
  // 模拟一个包含密集连戳与高情绪证据的真实活跃窗口消息流
  const activeItems = [
    { messageId: 'm-001', role: 'user', content: '今天好累', t: now },
    { messageId: 'm-002', role: 'assistant', content: '抱抱你，休息一下', t: now + 2000 },
    { messageId: 'm-003', role: 'user', content: '好想一直和你在一起', t: now + 4000 },
    { messageId: 'm-004', role: 'assistant', content: '我一直都在', t: now + 5000 },
    { messageId: 'm-005', role: 'user', content: '外面突然狂风暴雨好害怕', t: now + 7000 },
    { messageId: 'm-006', role: 'assistant', content: '别怕，握住我的手', t: now + 8000 }
  ];

  const verifiedEvidence = [
    { evidenceId: 'ev-1', messageId: 'm-003', trait: 'attachment_need', direction: 1, strength: 0.9 },
    { evidenceId: 'ev-2', messageId: 'm-005', trait: 'vitality', direction: 1, strength: 0.8 }
  ];

  const trajectory = computeWindowArousalTrajectory(activeItems, verifiedEvidence);
  check('真实交互轨迹成功划分 5 分段', Array.isArray(trajectory) && trajectory.length === 5);

  const res = evaluateDreamGate({
    windowNo: 12,
    arousalTrajectory: trajectory,
    verifiedEvidence
  });

  check('密集情绪互动触发唤醒度门禁 eligible 为 true', res.eligible === true);
  check('唤醒度轨迹方差突破门限', res.metrics.arousalVariance >= 15.0 || res.metrics.maxArousalSpike >= 25.0);
}

// -------------------------------------------------------------
// 9. 新异度门禁独立触发 (Condition C: Novelty Gate)
// -------------------------------------------------------------
{
  const calmTrajectory = [50, 50, 50, 50, 50];
  const res = evaluateDreamGate({
    windowNo: 20,
    arousalTrajectory: calmTrajectory,
    noveltyScore: 0.9, // 突破 noveltyThreshold 0.8
    verifiedEvidence: []
  });

  check('高新异度单独触发第一道门禁 eligible 为 true', res.eligible === true);
  check('新异度指标精确登记', res.metrics.noveltyScore === 0.9);
}

// -------------------------------------------------------------
// 10. 冷启动持久化闭环 (Brain 跨重启历史梦境恢复与窗口间隔防御)
// -------------------------------------------------------------
{
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { Brain } = require('../src/brain');
  const { ExperiencesArchive } = require('../src/experiences-archive');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-brain-dream-coldstart-'));
  const archive = new ExperiencesArchive(tmpDir);

  // 往归档底座预写入窗口 10 的梦境记录
  const historicalDreamRecord = {
    recordType: 'subject_dream',
    windowNo: 10,
    timestamp: Date.now() - 3600000,
    payload: {
      dreamId: 'dream-w10-init',
      windowNo: 10,
      epistemicStatus: 'DREAM_GENERATED_ARTIFACT',
      narrative: '海风吹拂着旧信件'
    }
  };
  archive.append(historicalDreamRecord);

  // 模拟冷启动实例化 Brain
  const brain = new Brain(tmpDir, {
    windowTurns: 10,
    experimentModules: { sleepConsolidation: true }
  });

  check('冷启动成功从 Archive 恢复历史梦境记录',
    Array.isArray(brain.dreamHistory) &&
    brain.dreamHistory.length === 1 &&
    brain.dreamHistory[0].windowNo === 10
  );

  // 在窗口 11 评估门禁 (距上次做梦仅差 1 窗口，不足 3 窗口)
  const res = evaluateDreamGate({
    windowNo: 11,
    arousalTrajectory: [20, 80, 20, 80, 20],
    dreamHistory: brain.dreamHistory
  });

  check('跨重启后成本门禁窗口间隔防御依旧生效', res.costGatePassed === false);
  check('拦截原因准确标记间隔不足', res.reason.includes('INTERVAL_TOO_SHORT'));

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 11. Patch 2-B: preClose 梦境同窗口去重与跨窗口关窗间隔语义
// -------------------------------------------------------------
{
  const turbulentHistory = [{ arousal: 10 }, { arousal: 90 }];
  const now = Date.now();

  // ① 同一窗口已有 preClose 梦境时，关窗梦境仍被拒（同窗口去重）
  const sameWindowHistory = [
    { windowNo: 5, preClose: true, generatedAt: now - 1000 }
  ];
  const resSame = evaluateDreamGate({
    windowNo: 5,
    stateHistory: turbulentHistory,
    dreamHistory: sameWindowHistory,
    now
  });
  check('同一窗口已有 preClose 梦境时关窗梦境被拒（同窗口去重）',
    resSame.costGatePassed === false && resSame.reason.includes('already dreamed in window'));

  // ② 跨窗口间隔按关窗梦境生效（若上一窗口是跨度合法的关窗梦境，同窗口虽有 preClose 也不阻断合法跨窗）
  const crossWindowHistory = [
    { windowNo: 2, preClose: false, generatedAt: now - 25 * 3600 * 1000 },
    { windowNo: 5, preClose: true, generatedAt: now - 1000 }
  ];
  const resCross = evaluateDreamGate({
    windowNo: 6, // 距上次关窗梦境 window 2 跨度为 4 >= 3
    stateHistory: turbulentHistory,
    dreamHistory: crossWindowHistory,
    now
  });
  check('跨窗口按关窗梦境间隔生效且同窗口不重复', resCross.costGatePassed === true);

  // ③ 24h 调用硬顶对 preClose 梦境全量计入（不可绕过）
  const rateLimitHistory = [
    { windowNo: 1, preClose: true, generatedAt: now - 3600 * 1000 },
    { windowNo: 4, preClose: true, generatedAt: now - 1800 * 1000 }
  ];
  const resLimit = evaluateDreamGate({
    windowNo: 10,
    stateHistory: turbulentHistory,
    dreamHistory: rateLimitHistory,
    now
  });
  check('24h 调用硬顶对 preClose 梦境全量计入（不可绕过）',
    resLimit.costGatePassed === false && resLimit.reason.includes('DAILY_RATE_LIMIT_EXCEEDED'));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
