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

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
