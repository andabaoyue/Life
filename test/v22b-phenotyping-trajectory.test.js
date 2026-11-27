/**
 * test/v22b-phenotyping-trajectory.test.js
 *
 * v2.2-b 能动性表型审计、双尺度历时看板与 v2.2-a P3 收口门禁：
 *   1. 块 A 回归：dirty 目录（含损坏 engram-graph.json）下 baseline 构造零读盘、零 .bak 产生；
 *      refreshCuriosity 持久化 lastWindowTension，reactivateByContext / markCuriosityIncubated 重算
 *      epistemicGain 保留原张力加成，且全程保持 systemText 逐字节恒等；
 *   2. 块 B observability.js 扩展：phenotyping 分组与 5 项新 spec 完整注册、空上下文 100% 返回 null
 *      （绝不补 0）、真实上下文返回准确只读数值、连读两次 groups 逐字节相等、绝不泄漏问题原文/便签正文/路径、
 *      P2-3c 静态合规（绝不引用 DEVELOPMENTAL_STAGES / getDevelopmentalStage / getCanalizationMetrics）；
 *   3. 块 C getTrajectorySummary & internal-regulation 快照：0 窗空归档诚实返回 windowCount=0、
 *      1 窗即产出微观视图（三阶印痕/张力/异稳态）、缺失历史快照字段严格给 null 绝不补 0、
 *      多窗产出单调下降 plasticitySeries 与真实 traitSeries、maxWindows 限幅 [1, 200]、只读零改盘；
 *   4. IPC / Preload / 渲染安全：research:get-trajectory 挂载且参数白名单仅透传 maxWindows、
 *      preload 暴露 research.getTrajectory、index.html 含 #rSubPaneTrajectory 与 data-subtab="trajectory"、
 *      静态扫描 ui-research.js / ui-settings.js 零不安全 DOM 注入且 i18n 双语对称。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// [tmp-hygiene] 临时目录统一登记清理
const _tmpDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...args) {
  const d = _origMkdtemp.apply(fs, args);
  _tmpDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdtempSync = _origMkdtemp;
});

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v22b-pheno-'));
}

const { Brain } = require(path.join(ROOT, 'src', 'brain'));
const { Memory, computeCuriosityGain } = require(path.join(ROOT, 'src', 'memory'));
const { DEFAULTS } = require(path.join(ROOT, 'src', 'config'));
const { OBSERVABILITY_SPECS, GROUP_ORDER, collectObservability } = require(path.join(ROOT, 'src', 'observability'));
const { InternalRegulationManager } = require(path.join(ROOT, 'src', 'internal-regulation'));
const { ResearchQuery } = require(path.join(ROOT, 'src', 'research-query'));
const { registerResearchIpc } = require(path.join(ROOT, 'src', 'research-ipc'));
const { computePlasticityMultiplier } = require(path.join(ROOT, 'src', 'canalization'));
const { I18N } = require(path.join(ROOT, 'ui-i18n.js'));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  // ---- 1. 块 A：v2.2-a 两处 P3 收口 ----
  {
    const dirtyDir = makeTempDir();
    fs.writeFileSync(path.join(dirtyDir, 'engram-graph.json'), '{broken-graph-json', 'utf8');
    const baseBrain = new Brain(dirtyDir, {
      ...DEFAULTS,
      apiKey: 'sk-v22b-base',
      experimentMode: 'baseline',
      experimentModules: { ...DEFAULTS.experimentModules, engramGraph: true, memoryDynamics: true, epistemicForaging: true }
    });
    check('1.1 baseline 构造期即使目录存在损坏 engram-graph.json 也零读盘、零生成 .bak',
      baseBrain.memory.engramGraph === null &&
      baseBrain.memory.isEngramGraphActive === false &&
      !fs.existsSync(path.join(dirtyDir, 'engram-graph.json.bak')));

    const mDir = makeTempDir();
    const m = new Memory(mDir, { persona: 'P', memoryDynamics: true, engramGraph: true, epistemicForaging: true });
    m.refreshCuriosity(['那本天文图鉴还在不在'], 3, { windowTension: 0.8 });
    const q0 = m.data.curiosityQueue[0];
    const sys0 = m.systemText();
    m.reactivateByContext('今天看到天文图鉴了', 3);
    const expectedAfterTouch = computeCuriosityGain({ ...q0, mentionCount: 1, lastTouchedWindow: 3 }, 3, 0.8);
    check('1.2 reactivateByContext 重算 epistemicGain 时保留同窗 lastWindowTension 加成',
      q0.lastWindowTension === 0.8 &&
      q0.mentionCount === 1 &&
      q0.epistemicGain === expectedAfterTouch &&
      m.systemText() === sys0,
      `gain=${q0.epistemicGain}, expected=${expectedAfterTouch}`);

    m.markCuriosityIncubated('那本天文图鉴还在不在', 3);
    const expectedAfterInc = computeCuriosityGain(q0, 3, 0.8);
    check('1.3 markCuriosityIncubated 重算 epistemicGain 时保留同窗 lastWindowTension 加成且 systemText 恒等',
      q0.incubated === true &&
      q0.epistemicGain === expectedAfterInc &&
      m.systemText() === sys0,
      `gain=${q0.epistemicGain}, expected=${expectedAfterInc}`);
  }

  // ---- 2. 块 B：observability.js 扩展 + P2-3c + 三铁律 ----
  {
    const ids = OBSERVABILITY_SPECS.map((s) => s.id);
    const expectedIds = [
      'memory.engramGraph',
      'curiosity.foraging',
      'phenotyping.provenanceClosure',
      'phenotyping.canalizationDamping',
      'phenotyping.empowermentProxy'
    ];
    check('2.1 GROUP_ORDER 包含 phenotyping 且 5 项新 spec 完整注册',
      GROUP_ORDER.includes('phenotyping') && expectedIds.every((id) => ids.includes(id)));

    const emptyObs = collectObservability({});
    const newValsEmpty = [];
    for (const g of Object.keys(emptyObs.groups)) {
      for (const it of emptyObs.groups[g]) {
        if (expectedIds.includes(it.id)) newValsEmpty.push(it.value);
      }
    }
    check('2.2 空上下文下 5 项新 spec 全部返回 null（绝不补 0）',
      newValsEmpty.length === 5 && newValsEmpty.every((v) => v === null));

    const obsDir = makeTempDir();
    const obsBrain = new Brain(obsDir, {
      ...DEFAULTS,
      apiKey: 'sk-v22b-obs',
      experimentMode: 'experimental',
      experimentModules: { ...DEFAULTS.experimentModules, memoryDynamics: true, engramGraph: true, epistemicForaging: true }
    });
    obsBrain.memory.data.windowNo = 6;
    obsBrain.memory.engramGraph.recordCoactivation('tr-x', 'tr-y', 6);
    const secretQuestion = '绝对不能泄露的问题正文ABC';
    const secretNoteBody = '绝对不能泄露的便签正文XYZ';
    obsBrain.memory.refreshCuriosity([secretQuestion], 6, { windowTension: 0.5 });
    obsBrain.memory.reactivateByContext(secretQuestion, 6);
    obsBrain.memory.addSelfNote({ content: secretNoteBody, name: 'secret-note.md', source: 'selfNote', windowNo: 6 });
    obsBrain.memory.data.selfNotes[0].engraved = true;
    obsBrain.memory.data.expectations.push(
      { id: 'exp-1', text: '约定1', status: 'fulfilled' },
      { id: 'exp-2', text: '约定2', status: 'broken' }
    );
    obsBrain.selfLedger.entries.push({
      id: 'sl-1',
      trait: 'quiet_preference',
      support: [{ sourceType: 'EXPERIENCE', quote: '绝对不能泄露的证据摘录', verification: 'VERIFIED' }],
      oppose: [{ sourceType: 'MODEL_INTERPRETATION', quote: '未闭环摘录', verification: 'UNVERIFIED' }]
    });

    const r1 = collectObservability({ brain: obsBrain });
    const r2 = collectObservability({ brain: obsBrain });
    const findVal = (res, id) => {
      for (const g of Object.keys(res.groups)) {
        const hit = res.groups[g].find((x) => x.id === id);
        if (hit) return hit.value;
      }
      return null;
    };
    const egVal = findVal(r1, 'memory.engramGraph');
    const cfVal = findVal(r1, 'curiosity.foraging');
    const pcVal = findVal(r1, 'phenotyping.provenanceClosure');
    const cdVal = findVal(r1, 'phenotyping.canalizationDamping');
    const epVal = findVal(r1, 'phenotyping.empowermentProxy');

    check('2.3 真实上下文下 5 项新 spec 返回准确统计标量',
      egVal && egVal.edgeCount === 1 && egVal.maxWeight === 1 &&
      cfVal && cfVal.trackedCount === 1 && cfVal.touchedCount === 1 && cfVal.maxGain > 1 &&
      pcVal && pcVal.verified === 1 && pcVal.rejected === 1 && pcVal.closureRatio === 0.5 &&
      cdVal && cdVal.windowNo === 6 && cdVal.completedWindows === 5 && cdVal.plasticityMultiplier === computePlasticityMultiplier(5) &&
      epVal && epVal.expectationFulfillRate === 0.5 && epVal.selfNoteEngraveRate === 1 && epVal.sampleSize === 3);

    check('2.4 连读两次 groups 逐字节相等（只读零副作用）',
      JSON.stringify(r1.groups) === JSON.stringify(r2.groups));

    const payloadJson = JSON.stringify(r1);
    check('2.5 观测 payload 绝不泄露未解疑问原文、便签正文、证据摘录或文件名',
      !payloadJson.includes(secretQuestion) &&
      !payloadJson.includes(secretNoteBody) &&
      !payloadJson.includes('secret-note.md') &&
      !payloadJson.includes('绝对不能泄露的证据摘录'));

    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const obsCode = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'observability.js'), 'utf8'));
    const rqCode = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'research-query.js'), 'utf8'));
    check('2.6 P2-3c 静态合规：observability.js 与 research-query.js 均不引用叙事阶段符号',
      !/\b(DEVELOPMENTAL_STAGES|getDevelopmentalStage|getCanalizationMetrics)\b/.test(obsCode) &&
      !/\b(DEVELOPMENTAL_STAGES|getDevelopmentalStage|getCanalizationMetrics)\b/.test(rqCode));
  }

  // ---- 3. 块 C：getTrajectorySummary 双尺度只读聚合 + InternalRegulation 快照字段 ----
  {
    const qEmptyDir = makeTempDir();
    const qEmpty = new ResearchQuery(qEmptyDir);
    const emptyTraj = qEmpty.getTrajectorySummary();
    check('3.1 空归档 getTrajectorySummary 诚实返回 windowCount=0 与空集合',
      emptyTraj && emptyTraj.windowCount === 0 &&
      emptyTraj.micro.windows.length === 0 &&
      emptyTraj.macro.plasticitySeries.length === 0 &&
      Object.keys(emptyTraj.macro.traitSeries).length === 0);

    // 验证 InternalRegulation.createSnapshotRecord 包含 lastWindowTension（disabled 时 null）
    const irDir = makeTempDir();
    const ir = new InternalRegulationManager(irDir, { enabled: true });
    ir.updateOnWindowClose(1, { lastWindowTension: 0.44 });
    const snapRec = ir.createSnapshotRecord(1);
    const irOff = new InternalRegulationManager(irDir, { enabled: false });
    const snapOff = irOff.createSnapshotRecord(1);
    check('3.2 InternalRegulation.createSnapshotRecord 携带 lastWindowTension，disabled 时严格为 null',
      snapRec.payload.lastWindowTension === 0.44 && snapOff.payload.lastWindowTension === null);

    // 1 窗微观生效验证 + 缺失历史快照字段严格为 null
    const q1Dir = makeTempDir();
    const q1 = new ResearchQuery(q1Dir);
    const oneWinTraj = q1.getTrajectorySummary({
      _preloadedRecords: [
        { recordType: 'window_summary', windowNo: 1, payload: { windowNo: 1 } },
        { recordType: 'memory_dynamics_snapshot', windowNo: 1, payload: { windowNo: 1, report: { tierCounts: { ACTIVE: 2, FADING: 1, DORMANT: 0 } } } },
        { recordType: 'internal_regulation_snapshot', windowNo: 1, payload: { state: { interactionDensity: 24 } } } // 刻意缺少 lastWindowTension 与 allostasis
      ]
    });
    const w1 = oneWinTraj.micro.windows[0];
    check('3.3 1 窗起微观视图即生效，且缺失的 lastWindowTension / allostasis 严格保持 null（不补 0）',
      oneWinTraj.windowCount === 1 &&
      w1.windowNo === 1 &&
      w1.engramTiers.ACTIVE === 2 && w1.engramTiers.FADING === 1 &&
      w1.interactionDensity === 24 &&
      w1.lastWindowTension === null &&
      w1.allostasis === null);

    // 多窗宏观轨迹 + maxWindows 限幅
    const multiRecords = [
      { recordType: 'window_summary', windowNo: 1, payload: { windowNo: 1, stateChanges: [{ stateChangeId: 'sc-1', windowNo: 1, trait: 'quiet_preference', newValue: 12 }] } },
      { recordType: 'window_summary', windowNo: 2, payload: { windowNo: 2 } },
      { recordType: 'window_summary', windowNo: 5, payload: { windowNo: 5, stateChanges: [{ stateChangeId: 'sc-2', windowNo: 5, trait: 'quiet_preference', newValue: 26 }] } }
    ];
    const multiTraj = q1.getTrajectorySummary({ _preloadedRecords: multiRecords });
    const limitedTraj = q1.getTrajectorySummary({ maxWindows: 2, _preloadedRecords: multiRecords });
    check('3.4 多窗宏观 plasticitySeries 单调递减、traitSeries 只含真实跃迁且 maxWindows 限幅生效',
      multiTraj.windowCount === 3 &&
      multiTraj.macro.plasticitySeries[0].plasticityMultiplier === 1 &&
      multiTraj.macro.plasticitySeries[2].plasticityMultiplier < multiTraj.macro.plasticitySeries[1].plasticityMultiplier &&
      multiTraj.macro.traitSeries.quiet_preference.length === 2 &&
      multiTraj.macro.traitSeries.quiet_preference[1].value === 26 &&
      !multiTraj.macro.traitSeries.vitality &&
      limitedTraj.windowCount === 2 &&
      limitedTraj.micro.windows[0].windowNo === 5);
  }

  // ---- 4. IPC / Preload / 渲染安全 & i18n ----
  {
    const handlers = new Map();
    let capturedOpts = null;
    registerResearchIpc(
      { handle: (ch, fn) => handlers.set(ch, fn) },
      {
        query: {
          getTrajectorySummary: (opts) => {
            capturedOpts = opts;
            return { queryMode: 'FULL_SCAN', windowCount: 0, micro: { windows: [] }, macro: { plasticitySeries: [], traitSeries: {} } };
          }
        }
      }
    );
    const trajHandler = handlers.get('research:get-trajectory');
    const trajRes = typeof trajHandler === 'function' ? trajHandler({}, { maxWindows: 20, targetDir: 'evil' }) : null;
    check('4.1 registerResearchIpc 挂载只读 research:get-trajectory 且只透传 maxWindows',
      typeof trajHandler === 'function' &&
      trajRes && trajRes.windowCount === 0 &&
      capturedOpts && capturedOpts.maxWindows === 20 && !('targetDir' in capturedOpts));

    const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const uiResearchRaw = fs.readFileSync(path.join(ROOT, 'ui-research.js'), 'utf8');
    const uiSettingsRaw = fs.readFileSync(path.join(ROOT, 'ui-settings.js'), 'utf8');
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const dangerousProp = 'inner' + 'HTML';
    check('4.2 preload / index.html 接线就位，且 ui-research.js 与 ui-settings.js 零不安全 HTML 注入',
      preloadSrc.includes("ipcRenderer.invoke('research:get-trajectory'") &&
      htmlSrc.includes('id="rSubPaneTrajectory"') &&
      htmlSrc.includes('data-subtab="trajectory"') &&
      !stripComments(uiResearchRaw).includes(dangerousProp) &&
      !stripComments(uiSettingsRaw).includes(dangerousProp));

    const zhKeys = Object.keys(I18N['zh-CN']).sort().join(',');
    const enKeys = Object.keys(I18N.en).sort().join(',');
    const enHasCjk = Object.values(I18N.en).some((v) => typeof v === 'string' && /[\u4e00-\u9fa5]/.test(v));
    check('4.3 ui-i18n.js 中英双语键 100% 对称且英文词典零中文残留',
      zhKeys === enKeys && !enHasCjk &&
      Boolean(I18N['zh-CN']['obs.group.phenotyping']) &&
      Boolean(I18N['zh-CN']['research.trajectory.title']));
  }

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
