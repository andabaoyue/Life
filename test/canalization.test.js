/**
 * test/canalization.test.js
 * 
 * Life v0.9.7 沃丁顿发育景观与经历依赖塑性衰减专项测试
 * 
 * 检验点：
 * 1. 塑性乘子单调递减：W=0 时为 1.0，随 W 增长 strictly 递减
 * 2. 模块禁用 / Baseline 模式下塑性乘子严格恒为 1.0 (基线零干预不变量)
 * 3. 发展阶段枚举正确映射 (JUVENILE -> DEVELOPMENTAL -> STABILIZED)
 * 4. StateChange 完整记录 baseStepWeight、effectiveStepWeight、plasticityMultiplier
 * 5. 相同 Evidence 在 Window 1 与 Window 30 下产生不同 effectiveStepWeight 与阻尼效果
 * 6. 确定性 Replay 严格还原历史落盘发育参数，达到 100% 确定性重现
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  computePlasticityMultiplier,
  computeEffectiveStepWeight,
  getDevelopmentalStage,
  getCanalizationMetrics,
  DEVELOPMENTAL_STAGES,
  DEFAULT_CANALIZATION_GAMMA
} = require('../src/canalization');
const { SubjectState } = require('../src/subject-state');
const { createStateChange } = require('../src/state-change');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'canalization-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. 塑性乘子代数计算与单调衰减
// -------------------------------------------------------------
{
  check('默认 gamma 为 0.25', DEFAULT_CANALIZATION_GAMMA === 0.25);

  const m0 = computePlasticityMultiplier(0);
  check('W=0 时塑性乘子严格为 1.0', m0 === 1.0);

  const m1 = computePlasticityMultiplier(1);
  const m5 = computePlasticityMultiplier(5);
  const m10 = computePlasticityMultiplier(10);
  const m30 = computePlasticityMultiplier(30);
  const m100 = computePlasticityMultiplier(100);

  check('m1 < m0', m1 < m0, `m0=${m0}, m1=${m1}`);
  check('m5 < m1', m5 < m1, `m1=${m1}, m5=${m5}`);
  check('m10 < m5', m10 < m5, `m5=${m5}, m10=${m10}`);
  check('m30 < m10', m30 < m10, `m10=${m10}, m30=${m30}`);
  check('m100 < m30', m100 < m30, `m30=${m30}, m100=${m100}`);

  check('禁用状态下塑性乘子恒为 1.0', computePlasticityMultiplier(50, { enabled: false }) === 1.0);

  // 步长衰减计算
  const eff0 = computeEffectiveStepWeight(20, 0);
  const eff30 = computeEffectiveStepWeight(20, 30);
  check('W=0 有效步长等于 20', eff0 === 20);
  check('W=30 有效步长显著衰减低于 15', eff30 < 15, `eff30=${eff30}`);
}

// -------------------------------------------------------------
// 2. 发育阶段划分映射
// -------------------------------------------------------------
{
  check('Window 1 为幼态期 JUVENILE', getDevelopmentalStage(1) === DEVELOPMENTAL_STAGES.JUVENILE);
  check('Window 5 为幼态期 JUVENILE', getDevelopmentalStage(5) === DEVELOPMENTAL_STAGES.JUVENILE);
  check('Window 6 进入发育期 DEVELOPMENTAL', getDevelopmentalStage(6) === DEVELOPMENTAL_STAGES.DEVELOPMENTAL);
  check('Window 30 仍为发育期 DEVELOPMENTAL', getDevelopmentalStage(30) === DEVELOPMENTAL_STAGES.DEVELOPMENTAL);
  check('Window 31 进入稳定个体化期 STABILIZED', getDevelopmentalStage(31) === DEVELOPMENTAL_STAGES.STABILIZED);
  check('Window 100 为稳定个体化期 STABILIZED', getDevelopmentalStage(100) === DEVELOPMENTAL_STAGES.STABILIZED);

  const metrics = getCanalizationMetrics(10, 20);
  check('metrics 包含完备发育参数结构', metrics.stage === DEVELOPMENTAL_STAGES.DEVELOPMENTAL && metrics.effectiveStepWeight > 0);
}

// -------------------------------------------------------------
// 3. StateChange 记录与 SubjectState Reducer 集成
// -------------------------------------------------------------
{
  const sc = createStateChange({
    windowNo: 15,
    trait: 'warmth',
    previousValue: 50,
    delta: 10,
    baseStepWeight: 20,
    effectiveStepWeight: 12.5,
    plasticityMultiplier: 0.625
  });

  check('StateChange 包含 baseStepWeight', sc.baseStepWeight === 20);
  check('StateChange 包含 effectiveStepWeight', sc.effectiveStepWeight === 12.5);
  check('StateChange 包含 plasticityMultiplier', sc.plasticityMultiplier === 0.625);
  check('reducer 嵌套对象保留 plasticityMultiplier', sc.reducer.plasticityMultiplier === 0.625);
}

// -------------------------------------------------------------
// 4. SubjectState.reduce 在幼态 vs 成熟期对比与基线零干预
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const state = new SubjectState(dir);

  // 4.1 基线对照组（canalization: false）：Window 1 与 Window 30 步长严格一致
  const ev1 = [{ evidenceId: 'ev-b1', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-1', quote: 'test' }];
  const ev2 = [{ evidenceId: 'ev-b2', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-2', quote: 'test' }];

  state.reduce(ev1, 1, { canalization: false, stepWeight: 20 });
  state.reduce(ev2, 30, { canalization: false, stepWeight: 20 });
  check('基线模式下无论 Window 多少，effectiveStepWeight 严格等于 baseStepWeight',
    state.data.stateChanges[0].effectiveStepWeight === 20 &&
    state.data.stateChanges[1].effectiveStepWeight === 20
  );

  // 4.2 实验组（canalization: true）：Window 1 塑性为 1.0，Window 30 塑性显著降低
  const ev3 = [{ evidenceId: 'ev-exp1', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-3', quote: 'test' }];
  const ev4 = [{ evidenceId: 'ev-exp2', trait: 'vitality', direction: 1, strength: 0.8, messageId: 'm-4', quote: 'test' }];

  state.reduce(ev3, 1, { canalization: true, stepWeight: 20 });
  const expChangeW1 = state.data.stateChanges[state.data.stateChanges.length - 1];

  state.reduce(ev4, 30, { canalization: true, stepWeight: 20 });
  const expChangeW30 = state.data.stateChanges[state.data.stateChanges.length - 1];

  check('实验组 Window 1 塑性乘子为 1.0', expChangeW1.plasticityMultiplier === 1.0);
  check('实验组 Window 30 塑性乘子严格小于 1.0', expChangeW30.plasticityMultiplier < 1.0, `actual: ${expChangeW30.plasticityMultiplier}`);
  check('实验组 Window 30 有效步长显著小于 Window 1', expChangeW30.effectiveStepWeight < expChangeW1.effectiveStepWeight);

  // 4.3 离线 Replay 验证：Replay 使用历史记录参数，不重新猜测
  const mockArchiveRecords = [
    {
      recordType: 'window_summary',
      archiveSeq: 1,
      windowNo: 30,
      payload: {
        windowNo: 30,
        verifiedEvidence: ev4,
        stateChanges: [expChangeW30]
      }
    }
  ];

  const replayResult = SubjectState.replay(mockArchiveRecords);
  check('Replay 成功推演', replayResult && replayResult.replayStatus === 'complete');
  check('Replay 提取的历史 StateChange 保持原有 effectiveStepWeight',
    replayResult.stateChanges[0].effectiveStepWeight === expChangeW30.effectiveStepWeight
  );

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 5. v0.9.9 P2-3: 单调性确证 + 源码扫描守卫（杜绝拟人化伪生命）
// -------------------------------------------------------------
{
  // P2-3a: 「经历依赖的可塑性单调衰减」是本模块的核心命题，必须钉住性质本身，
  // 而不只是几个散点的取值范围。
  const W = [];
  for (let i = 0; i <= 1000; i++) W.push(i);
  const vals = W.map(w => computePlasticityMultiplier(w));
  let mono = true;
  for (let i = 1; i < vals.length; i++) { if (vals[i] > vals[i - 1]) { mono = false; break; } }
  check('P2-3a：可塑性乘子随经历深度单调不增（0→1000 采样）',
    mono, 'head=' + vals.slice(0, 5).join(',') + ' tail=' + vals.slice(-3).join(','));
  check('P2-3a：W=0 时乘子为 1.0（出生即最大可塑性）',
    computePlasticityMultiplier(0) === 1.0);
  check('P2-3a：乘子值域恒在 (0, 1]（阻尼但永不锁死）',
    vals.every(v => v > 0 && v <= 1),
    'min=' + Math.min(...vals) + ' max=' + Math.max(...vals));
  check('P2-3a：enabled=false 时恒为 1.0（基线零干预）',
    [0, 1, 50, 500].every(w => computePlasticityMultiplier(w, { enabled: false }) === 1.0));

  // P2-3c: 源码扫描守卫 —— 发育阶段标签永不升格为机制。
  // DEVELOPMENTAL_STAGES（幼态期/发育期/稳定个体化期）是纯叙事标签、无生产消费方：
  // 它说「她进入了稳定个体化期」，但背后没有任何机制变化 —— 那正是「拟人化伪生命」
  // 的形状（叙事层比机制层厚）。这里把它物理锁死：生产代码不得引用它们。
  //（手法与 test/wardrobe.test.js「正则扫源码执法服装不碰人格」一致）
  const srcDir = path.join(__dirname, '..', 'src');
  const rootDir = path.join(__dirname, '..');
  const offenders = [];
  // 剥掉注释再扫：守卫要拦的是「被引用/被升级为机制」，不是「被提及」。
  // 否则谁在注释里写一句 DEVELOPMENTAL_STAGES 就误报，守卫很快就没人信了。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const walkSrc = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walkSrc(p); continue; }
      if (!p.endsWith('.js')) continue;
      if (path.basename(p) === 'canalization.js') continue;   // 定义处本身豁免
      const text = stripComments(fs.readFileSync(p, 'utf8'));
      for (const sym of ['DEVELOPMENTAL_STAGES', 'getDevelopmentalStage', 'getCanalizationMetrics']) {
        if (text.includes(sym)) offenders.push(path.relative(rootDir, p) + ' -> ' + sym);
      }
    }
  };
  walkSrc(srcDir);

  /* 🔴 2026-10-27：补扫**根目录的运行时入口**。
   *
   *   实测漏洞：本守卫原先只 walkDir(src)，而 main.js / preload.js / pet.js / chat.js
   *   全在仓库根目录 —— `main.js:1358` 长期在调 `canal.getCanalizationMetrics()`
   *   产出 { stage, plasticity } 喂给观测面板的「发育景观」区块，
   *   正是本条守则要拦的形状，却因为扫不到而一直绿。
   *
   *   这不是"扩检查让红变绿"，是**把本来就该成立的规则补全**：
   *   根目录那几个文件同样是生产代码，同样拿得到 canalization 模块。
   */
  const ROOT_RUNTIME_ENTRIES = ['main.js', 'preload.js', 'pet.js', 'chat.js'];
  for (const name of ROOT_RUNTIME_ENTRIES) {
    const p = path.join(rootDir, name);
    if (!fs.existsSync(p)) continue;
    const text = stripComments(fs.readFileSync(p, 'utf8'));
    for (const sym of ['DEVELOPMENTAL_STAGES', 'getDevelopmentalStage', 'getCanalizationMetrics']) {
      if (text.includes(sym)) offenders.push(name + ' -> ' + sym);
    }
  }

  check('P2-3c：DEVELOPMENTAL_STAGES 等不得被生产代码引用（杜绝拟人化伪生命）',
    offenders.length === 0, JSON.stringify(offenders));

  // 反向对照：确认根目录入口确实被扫到了（否则上面那条对根目录恒真）
  check('（对照）P2-3c 已覆盖根目录运行时入口',
    ROOT_RUNTIME_ENTRIES.some((n) => fs.existsSync(path.join(rootDir, n))),
    '一个根目录入口都不存在则本条无意义');
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
