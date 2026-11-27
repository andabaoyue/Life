/**
 * test/v22a-engram-graph-foraging.test.js
 *
 * v2.2-a 共激活记忆图谱与精准度加权认知觅食门禁：
 *   1. EngramGraph 纯函数与契约：edgeKey 字典序/防自环、decayEdgeWeight、同窗去重、MAX_EDGE_WEIGHT=5.0、
 *      跨窗幂等与 0.92^ΔW 衰减、PRUNE_THRESHOLD=0.25 弱边修剪（不动 traces/windows）、MAX_EDGES 淘汰、
 *      原子写跨重启恢复、坏 JSON 安全回退空图；
 *   2. 共激活接线与跨窗联想回溯：reactivateByContext 写入 peer 共激活边（确定性排序限最近 3 个）、
 *      不篡改 computeEngramDecay 且不向 retrievalCount 灌水；triggerInvoluntaryRecall 优先关联候选，
 *      空图/无种子/未达标无缝回退原排序，12h + 同窗单次门禁不可突破；
 *   3. 精准度加权认知觅食：computeCuriosityGain 四因子有界性、reactivateByContext 命中更新 mentionCount
 *      （专用 lastMentionedWindow 判重且独立于 memoryRecallTopN<=0）、nextCuriosity 稳定择优不改序、
 *      refreshCuriosity 关窗重排截断 Top 5 与同窗同分保序；
 *   4. 前缀缓存不变式：对话中途 reactivateByContext / markCuriosityIncubated / nextCuriosity 前后 systemText 逐字节恒等；
 *   5. 基线与消融隔离 + 热切换 & 关窗端到端：baseline / memoryDynamics=false 旁路零落盘、Memory.reset() 清空、
 *      swapBrain 预刷盘、Brain.closeWindow() 透传 lastWindowTension 与 decayAllEdges、跨窗热切；
 *   6. D-001 静态门禁：src/engram-graph.js 零 setInterval / setTimeout / writeFileSync。
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v22a-engram-'));
}

const {
  MAX_EDGE_WEIGHT,
  DECAY_FACTOR,
  PRUNE_THRESHOLD,
  edgeKey,
  decayEdgeWeight,
  EngramGraph
} = require(path.join(ROOT, 'src', 'engram-graph'));
const { Memory, computeCuriosityGain } = require(path.join(ROOT, 'src', 'memory'));
const { computeEngramDecay } = require(path.join(ROOT, 'src', 'memory-dynamics'));
const { DEFAULTS, sanitize, save: saveConfig } = require(path.join(ROOT, 'src', 'config'));
const { DEFAULT_EXPERIMENT_MODULES } = require(path.join(ROOT, 'src', 'experiment-types'));
const { Brain } = require(path.join(ROOT, 'src', 'brain'));
const { swapBrain } = require(path.join(ROOT, 'src', 'brain-hot-swap'));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  // ---- 1. EngramGraph 纯函数与基本契约 ----
  {
    check('1.1 edgeKey 按字典序规范化无向边键，并严禁自环与非法节点',
      edgeKey('tr-b', 'tr-a') === 'tr-a::tr-b' &&
      edgeKey('tr-a', 'tr-b') === 'tr-a::tr-b' &&
      edgeKey('tr-a', 'tr-a') === null &&
      edgeKey('', 'tr-b') === null &&
      edgeKey(null, 'tr-b') === null);

    check('1.2 decayEdgeWeight 符合 0.92^ΔW 幂律衰减且 ΔW<=0 不衰减',
      decayEdgeWeight(2.0, 0) === 2.0 &&
      decayEdgeWeight(2.0, 1) === Number((2.0 * DECAY_FACTOR).toFixed(4)) &&
      decayEdgeWeight(2.0, 3) === Number((2.0 * Math.pow(DECAY_FACTOR, 3)).toFixed(4)));

    const gDir = makeTempDir();
    const g = new EngramGraph(gDir, { enabled: true });

    // 同窗同对去重 + 跨窗累积 + 上限 5.0
    const e1 = g.recordCoactivation('tr-2', 'tr-1', 1);
    const eDup = g.recordCoactivation('tr-1', 'tr-2', 1);
    check('1.3 同窗同对共激活严格去重（第二次返回 null 且权重仍为 1.0）',
      e1 !== null && e1.weight === 1.0 && eDup === null && g.getEdge('tr-1', 'tr-2').weight === 1.0);

    for (let w = 2; w <= 8; w++) {
      g.recordCoactivation('tr-1', 'tr-2', w);
    }
    check('1.4 跨窗累积共激活受 MAX_EDGE_WEIGHT=5.0 封顶且 coactivations 如实计数',
      g.getEdge('tr-1', 'tr-2').weight === MAX_EDGE_WEIGHT &&
      g.getEdge('tr-1', 'tr-2').coactivations === 8);

    // 跨多窗连续关窗衰减：验证不会重复按 deltaW 累乘，且同窗幂等
    g.recordCoactivation('tr-a', 'tr-b', 10); // w=1.0
    g.decayAllEdges(11);
    const w11 = g.getEdge('tr-a', 'tr-b').weight;
    g.decayAllEdges(11); // 同窗再调一次应幂等
    const w11Repeat = g.getEdge('tr-a', 'tr-b').weight;
    g.decayAllEdges(12);
    const w12 = g.getEdge('tr-a', 'tr-b').weight;
    const expected12 = decayEdgeWeight(decayEdgeWeight(1.0, 1), 1);
    check('1.5 跨多窗 decayAllEdges 同窗幂等且连续衰减等价 0.92^N（不重复累乘）',
      w11 === Number((1.0 * DECAY_FACTOR).toFixed(4)) &&
      w11Repeat === w11 &&
      Math.abs(w12 - expected12) < 1e-4,
      `w11=${w11}, w12=${w12}, exp=${expected12}`);

    // 弱边修剪（< PRUNE_THRESHOLD=0.25）
    g.recordCoactivation('tr-weak-1', 'tr-weak-2', 10); // w=1.0 -> 0.92^18 ≈ 0.2229 < 0.25
    const decRes = g.decayAllEdges(28);
    check('1.6 弱边低于 PRUNE_THRESHOLD=0.25 时从图索引修剪移除',
      decRes.pruned >= 1 && g.getEdge('tr-weak-1', 'tr-weak-2') === null);

    // 原子写落盘 & 跨重启恢复
    g.flush();
    const expectedW = g.getEdge('tr-1', 'tr-2').weight;
    const gReloaded = new EngramGraph(gDir, { enabled: true });
    check('1.7 engram-graph.json 经原子写落盘后跨重启完整恢复',
      fs.existsSync(path.join(gDir, 'engram-graph.json')) &&
      gReloaded.getEdge('tr-1', 'tr-2') !== null &&
      gReloaded.getEdge('tr-1', 'tr-2').weight === expectedW &&
      gReloaded.getEdge('tr-1', 'tr-2').coactivations === 8);

    // 全局边数上限 MAX_EDGES 容量淘汰（用小容量参数测试淘汰最弱最久边）
    const capDir = makeTempDir();
    const gCap = new EngramGraph(capDir, { enabled: true, maxEdges: 3 });
    gCap.recordCoactivation('n1', 'n2', 1); // w=1.0, win=1 (最弱最久 -> 应被淘汰)
    gCap.recordCoactivation('n2', 'n3', 2); // w=1.0, win=2
    gCap.recordCoactivation('n3', 'n4', 2);
    gCap.recordCoactivation('n3', 'n4', 3); // w=2.0
    gCap.recordCoactivation('n4', 'n5', 4); // 第 4 条触发淘汰
    check('1.8 超出 maxEdges 上限时按最弱且最久未共激活淘汰边',
      gCap.edges.size === 3 &&
      gCap.getEdge('n1', 'n2') === null &&
      gCap.getEdge('n3', 'n4').weight === 2.0 &&
      gCap.getEdge('n4', 'n5') !== null);

    // 坏 JSON 安全回退空图，绝不抛错
    const badDir = makeTempDir();
    fs.writeFileSync(path.join(badDir, 'engram-graph.json'), '{broken-json!!', 'utf8');
    let badThrew = false;
    let gBad = null;
    try {
      gBad = new EngramGraph(badDir, { enabled: true });
    } catch {
      badThrew = true;
    }
    check('1.9 engram-graph.json 损坏时安全备份 .bak 并回退空图，绝不抛错',
      !badThrew && gBad && gBad.edges.size === 0 && fs.existsSync(path.join(badDir, 'engram-graph.json.bak')));
  }

  // ---- 2. 共激活接线与跨窗联想回溯 + D-011/D-26 边界 ----
  {
    const mDir = makeTempDir();
    const m = new Memory(mDir, {
      persona: 'P',
      memoryDynamics: true,
      engramGraph: true,
      epistemicForaging: true,
      memoryRecallTopN: 1
    });
    m.data.windows = [
      { no: 1, text: '夏天在海边捡了一枚白色海螺贝壳。' },
      { no: 2, text: '深夜天文台用望远镜观测猎户座星云。' },
      { no: 3, text: '雨夜书店一起挑了一本旧诗集。' },
      { no: 4, text: '窗台多肉植物今天冒出新芽。' }
    ];
    m.data.windowNo = 10;

    // 构造多段印痕：w1(DORMANT, lastRetrieved=2), w2(DORMANT, lastRetrieved=1 更久更弱), w3(ACTIVE), w4(ACTIVE)
    const t1 = m.engramManager.registerTrace({ traceId: 'tr-1', sourceWindowNo: 1, createdWindow: 1 });
    const t2 = m.engramManager.registerTrace({ traceId: 'tr-2', sourceWindowNo: 2, createdWindow: 1 });
    const t3 = m.engramManager.registerTrace({ traceId: 'tr-3', sourceWindowNo: 3, createdWindow: 8 });
    const t4 = m.engramManager.registerTrace({ traceId: 'tr-4', sourceWindowNo: 4, createdWindow: 9 });
    t1.tier = 'DORMANT'; t1.lastRetrievedWindow = 2; t1.currentStrength = 0.25;
    t2.tier = 'DORMANT'; t2.lastRetrievedWindow = 1; t2.currentStrength = 0.15;
    t3.tier = 'ACTIVE';  t3.lastRetrievedWindow = 8; t3.currentStrength = 0.85;
    t4.tier = 'ACTIVE';  t4.lastRetrievedWindow = 9; t4.currentStrength = 0.88;

    // 先检查空图 / 无种子时，triggerInvoluntaryRecall 100% 退化为「最久远 + 强度最低」（tr-2）
    const coldRes = m.triggerInvoluntaryRecall(10, 1_000_000_000_000);
    check('2.1 冷启动空图且无种子时 triggerInvoluntaryRecall 无缝退化为最久远最弱候选 (tr-2)',
      coldRes !== null && coldRes.traceId === 'tr-2');

    // 验证同窗防洪 & 12h 门禁仍铁打不动
    const blockedSameWin = m.triggerInvoluntaryRecall(10, 1_000_000_000_000 + 20 * 3600 * 1000);
    const blockedTooSoon = m.triggerInvoluntaryRecall(11, 1_000_000_000_000 + 2 * 3600 * 1000);
    check('2.2 启用 engramGraph 后同窗单次与 12h 物理时间门禁仍然不可突破',
      blockedSameWin === null && blockedTooSoon === null);

    // 预置强共激活边 tr-1 <-> tr-3 (weight = 2.0 >= 1.2)
    m.engramGraph.recordCoactivation('tr-1', 'tr-3', 5);
    m.engramGraph.recordCoactivation('tr-1', 'tr-3', 6);
    // 确保 tr-1 本窗未被召回，且在窗口 12 激活 tr-3 作为种子，同时把 tr-2 保持比 tr-1 更久更弱
    t1.lastRetrievedWindow = 2; t1.tier = 'DORMANT';
    t2.lastRetrievedWindow = 1; t2.tier = 'DORMANT';
    t2.currentStrength = 0.10;
    m.data.windowNo = 12;
    const reactRes = m.reactivateByContext('记得雨夜书店的旧诗集吗', 12);
    check('2.3 reactivateByContext 命中 tr-3 且不向无关印痕灌水 retrievalCount',
      reactRes.length === 1 && reactRes[0].traceId === 'tr-3' && t1.retrievalCount === 0);

    // 窗口 12 内，此时种子为 tr-3（与 tr-1 有 weight>=1.2 共激活边），t2 比 t1 更久更弱，应优先捞回联想候选 tr-1
    const assocRes = m.triggerInvoluntaryRecall(12, 1_000_000_000_000 + 20 * 3600 * 1000);
    check('2.4 存在共激活边且本窗有种子时，triggerInvoluntaryRecall 优先唤起联想候选 (tr-1 而非 tr-2)',
      assocRes !== null && assocRes.traceId === 'tr-1');

    // 再在同一窗口 12 激活 tr-4，验证 reactivateByContext 自动写下 tr-4 <-> 已有peer 的共激活边（且只跟最近<=3个peer配对）
    const extraPeers = ['p1', 'p2', 'p3', 'p4'];
    for (const pid of extraPeers) {
      const tp = m.engramManager.registerTrace({ traceId: pid, sourceWindowNo: 4, createdWindow: 4 });
      tp.lastRetrievedWindow = 12;
      tp.retrievalCount = pid === 'p4' ? 5 : 1; // 确定性排序应优先选中 p4
    }
    const react4 = m.reactivateByContext('窗台多肉植物新芽', 12);
    // 在 react4 之前已有 tr-3, tr-1, p1..p4 共 6 个本窗活跃 peer，按排序只配对前 3 个
    let pairedCount = 0;
    for (const pid of ['tr-3', 'tr-1', ...extraPeers]) {
      if (m.engramGraph.getEdge('tr-4', pid)) pairedCount++;
    }
    check('2.5 reactivateByContext 自动记录共激活边且单次最多配对确定性排序的前 3 个 peer',
      react4.length === 1 && pairedCount === 3 && m.engramGraph.getEdge('tr-4', 'p4') !== null,
      `pairedCount=${pairedCount}`);

    // 验证 D-011 computeEngramDecay 公式与三阶梯队未被动过
    const dCheck = computeEngramDecay({ initialStrength: 0.6, createdWindow: 1, retrievalCount: 0, lastRetrievedWindow: 1 }, 1);
    check('2.6 computeEngramDecay 公式与默认门限保持原样（未被图谱乘子篡改）',
      dCheck && dCheck.currentStrength === 0.6 && dCheck.tier === 'ACTIVE');
  }

  // ---- 3. 精准度加权认知觅食（Epistemic Foraging） ----
  {
    const g0 = computeCuriosityGain({ q: 'Q', windowNo: 5, mentionCount: 0, incubated: false, lastTouchedWindow: 5 }, 5, 0);
    const gMention = computeCuriosityGain({ q: 'Q', windowNo: 5, mentionCount: 99, incubated: false, lastTouchedWindow: 5 }, 5, 0);
    const gDream = computeCuriosityGain({ q: 'Q', windowNo: 5, mentionCount: 0, incubated: true, lastTouchedWindow: 5 }, 5, 0);
    const gTension = computeCuriosityGain({ q: 'Q', windowNo: 5, mentionCount: 0, incubated: false, lastTouchedWindow: 5 }, 5, 2.5);
    const gOld = computeCuriosityGain({ q: 'Q', windowNo: 1, mentionCount: 0, incubated: false, lastTouchedWindow: 1 }, 6, 0);
    check('3.1 computeCuriosityGain 四因子公式与有界性精确（mention<=5, dream+0.5, tension<=0.3, ageDamping）',
      g0 === 1.0 &&
      gMention === Number((1 + 5 * 0.35).toFixed(4)) &&
      gDream === 1.5 &&
      gTension === 1.3 &&
      gOld === Number((1.0 / (1 + 0.18 * 5)).toFixed(4)));

    // 3.2 reactivateByContext 触及好奇心条目 + lastMentionedWindow 同窗去重 + 独立于 topN<=0
    const fDir = makeTempDir();
    const fm = new Memory(fDir, {
      persona: 'P',
      memoryDynamics: true,
      engramGraph: true,
      epistemicForaging: true,
      memoryRecallTopN: 0 // 刻意置 0，验证 curiosityQueue 触及不被 topN<=0 误杀
    });
    fm.data.windowNo = 6;
    fm.data.curiosityQueue = [
      { q: '老问题一直没问', windowNo: 2, mentionCount: 0, lastMentionedWindow: null, lastTouchedWindow: 2, epistemicGain: 0.5 },
      { q: '那本海螺图鉴后来有没有读完', windowNo: 6, mentionCount: 0, lastMentionedWindow: null, lastTouchedWindow: 6, epistemicGain: 1.0 }
    ];

    const sysBeforeTouch = fm.systemText();
    const qOrderBefore = fm.data.curiosityQueue.map(x => x.q).join('|');
    fm.reactivateByContext('今天又翻到那本海螺图鉴了', 6);
    const hitItem = fm.data.curiosityQueue[1];
    const afterFirstTouch = hitItem.mentionCount;
    // 同窗再次提及 -> lastMentionedWindow === 6 拦截，不再 +1
    fm.reactivateByContext('海螺图鉴真的很漂亮', 6);
    check('3.2 新入队同窗首次提及正常 +1（未被 lastTouchedWindow 误吞），同窗二次去重，且不受 memoryRecallTopN=0 拦截',
      afterFirstTouch === 1 &&
      hitItem.mentionCount === 1 &&
      hitItem.lastMentionedWindow === 6 &&
      hitItem.epistemicGain > 1.0);

    check('3.3 对话触及仅更新元数据，不改队列顺序且 systemText 逐字节恒等',
      fm.data.curiosityQueue.map(x => x.q).join('|') === qOrderBefore &&
      fm.systemText() === sysBeforeTouch);

    // 3.4 nextCuriosity 择优（不改原数组顺序），跳过已问条目
    check('3.4 nextCuriosity 优先返回 epistemicGain 最高未问项且保持原数组顺序不变',
      fm.nextCuriosity() === '那本海螺图鉴后来有没有读完' &&
      fm.data.curiosityQueue[0].q === '老问题一直没问');
    fm.markCuriosityAsked('那本海螺图鉴后来有没有读完');
    check('3.5 markCuriosityAsked 后 nextCuriosity 跳过已问项回落到次高未问项且 systemText 仍不变',
      fm.nextCuriosity() === '老问题一直没问' &&
      fm.systemText() === sysBeforeTouch);

    // 3.6 refreshCuriosity 关窗重排截断 Top 5 + 同窗同分保序
    const rDir = makeTempDir();
    const rm = new Memory(rDir, { persona: 'P', epistemicForaging: true });
    rm.refreshCuriosity(['旧问题A', '旧问题B'], 1);
    check('3.6a 同窗入队同分条目严格保持原数组相对顺序',
      rm.data.curiosityQueue[0].q === '旧问题A' && rm.data.curiosityQueue[1].q === '旧问题B');

    // 让 旧问题A 经过梦境发酵 + 多次提及，随后连续写入 5 条平淡新疑问，旧问题A 必须保住不被挤出！
    rm.markCuriosityIncubated('旧问题A', 2);
    rm.data.curiosityQueue[0].mentionCount = 3;
    rm.refreshCuriosity(['平淡1', '平淡2', '平淡3', '平淡4', '平淡5'], 3, { windowTension: 0.2 });
    check('3.6b 高张力/发酵老疑问在关窗 Top-5 重排中成功保留（不被 5 条平淡新疑问挤掉）且排在首位',
      rm.data.curiosityQueue.length === 5 &&
      rm.data.curiosityQueue[0].q === '旧问题A');
  }

  // ---- 4. 基线与消融隔离 + 热切换 & Brain 关窗端到端 ----
  {
    check('4.1 experiment-types 与 config.js 白名单均登记 engramGraph / epistemicForaging',
      'engramGraph' in DEFAULT_EXPERIMENT_MODULES &&
      'epistemicForaging' in DEFAULT_EXPERIMENT_MODULES &&
      DEFAULTS.experimentModules.engramGraph === true &&
      DEFAULTS.experimentModules.epistemicForaging === true);

    const baseSan = sanitize({
      experimentMode: 'baseline',
      experimentModules: { engramGraph: true, epistemicForaging: true, memoryDynamics: true }
    });
    const ablSan = sanitize({
      experimentMode: 'ablation',
      experimentModules: { engramGraph: false, epistemicForaging: false }
    });
    check('4.2 baseline 强制双开关 false；ablation 显式 false 严格保留',
      baseSan.experimentModules.engramGraph === false &&
      baseSan.experimentModules.epistemicForaging === false &&
      ablSan.experimentModules.engramGraph === false &&
      ablSan.experimentModules.epistemicForaging === false);

    // 基线 Brain 零读盘零落盘 engram-graph.json + 好奇退化严格 FIFO
    const baseDir = makeTempDir();
    const baseBrain = new Brain(baseDir, {
      ...DEFAULTS,
      apiKey: 'sk-v22a-base',
      experimentMode: 'baseline'
    });
    baseBrain.memory.refreshCuriosity(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'], 1);
    baseBrain.memory.refreshCuriosity(['Q6'], 2);
    baseBrain.memory.flush();
    check('4.3 baseline 模式下零创建 engram-graph.json 且 refreshCuriosity 严格 FIFO',
      baseBrain.memory.isEngramGraphActive === false &&
      baseBrain.memory.epistemicForagingEnabled === false &&
      !fs.existsSync(path.join(baseDir, 'engram-graph.json')) &&
      baseBrain.memory.data.curiosityQueue[0].q === 'Q2' &&
      baseBrain.memory.data.curiosityQueue[4].q === 'Q6');

    // memoryDynamics: false 消融时 engramGraph 自动旁路零写盘
    const noDynDir = makeTempDir();
    const noDynBrain = new Brain(noDynDir, {
      ...DEFAULTS,
      apiKey: 'sk-v22a-nodyn',
      experimentMode: 'ablation',
      experimentModules: { ...DEFAULTS.experimentModules, memoryDynamics: false, engramGraph: true }
    });
    noDynBrain.memory.flush();
    check('4.4 memoryDynamics=false 时 engramGraph 自动旁路且零写盘',
      noDynBrain.memory.isEngramGraphActive === false &&
      !fs.existsSync(path.join(noDynDir, 'engram-graph.json')));

    // Brain 关窗端到端：lastWindowTension 前移至 refreshCuriosity() + decayAllEdges 同刻落盘 + reset() + 热切换预刷盘
    const expDir = makeTempDir();
    const expBrain = new Brain(expDir, {
      ...DEFAULTS,
      apiKey: 'sk-v22a-exp',
      experimentMode: 'experimental',
      keepTailMessages: 0,
      selfGrowthEnabled: false,
      experimentModules: {
        ...DEFAULTS.experimentModules,
        internalRegulation: true,
        memoryDynamics: true,
        engramGraph: true,
        epistemicForaging: true,
        sleepConsolidation: false
      }
    });
    expBrain.api.stream = async (_msgs, onDelta) => {
      onDelta('嗯，记下来了。');
      return { text: '嗯，记下来了。', observedModel: 'deepseek-flash', usage: { prompt_tokens: 30, completion_tokens: 6 } };
    };
    expBrain.api.complete = async (msgs) => {
      const last = msgs[msgs.length - 1].content;
      if (last.includes('【对话】')) {
        return {
          text: JSON.stringify({
            segments: [{ range: '1-2', userGiven: ['海边旅行'], chulanExperience: ['产生疑问'], stateEvidence: [] }],
            windowSynthesis: {
              stableUserFacts: ['去了海边'],
              subjectExperiences: ['留意到情绪波动'],
              unresolved: ['海风为什么在傍晚突然变凉']
            }
          }),
          observedModel: 'deepseek-flash',
          usage: { prompt_tokens: 60, completion_tokens: 40 }
        };
      }
      return { text: '[]', observedModel: 'deepseek-flash', usage: { prompt_tokens: 10, completion_tokens: 4 } };
    };

    // 预埋一条第 1 窗共激活边（后续关窗 window 2 时会先记下边再经 window 1 closeWindow 衰减）
    expBrain.memory.engramGraph.recordCoactivation('tr-seed-a', 'tr-seed-b', 0); // w=1.0 at win 0
    await expBrain.ask('今天海风好大', () => {});
    expBrain.internalRegulation.history.push({ timestamp: Date.now() - 1000, nextValues: { arousal: 15 } });
    expBrain.internalRegulation.arousal = 90;
    await expBrain.ask('突然很感慨', () => {});
    const closed = await expBrain.closeWindow('turn_limit');
    const savedTension = expBrain.internalRegulation.getLastWindowTension();
    const qAfterClose = expBrain.memory.data.curiosityQueue;
    const expectedGain = computeCuriosityGain({ q: '海风为什么在傍晚突然变凉', windowNo: 1, mentionCount: 0, lastTouchedWindow: 1 }, 1, savedTension);
    check('4.5 Brain.closeWindow 端到端将非零 lastWindowTension 透传至 refreshCuriosity 并触发 decayAllEdges 落盘',
      closed === true &&
      savedTension > 0 &&
      qAfterClose.length === 1 &&
      qAfterClose[0].epistemicGain === expectedGain &&
      expBrain.memory.engramGraph.getEdge('tr-seed-a', 'tr-seed-b').weight === decayEdgeWeight(1.0, 1) &&
      fs.existsSync(path.join(expDir, 'engram-graph.json')),
      `tension=${savedTension}, gain=${qAfterClose[0] && qAfterClose[0].epistemicGain}`);

    // 验证 swapBrain 热切换 pre-flush 后新实例可立刻读到未 flush 的共激活边
    expBrain.memory.engramGraph.recordCoactivation('tr-hot-1', 'tr-hot-2', 2); // 仅 markDirty，尚未 flush
    const swapRes = swapBrain({
      oldBrain: expBrain,
      oldCfg: expBrain.cfg,
      nextCfg: { ...expBrain.cfg, model: 'deepseek-flash' },
      createCandidate: (nextCfg) => new Brain(expDir, nextCfg),
      persistCfg: () => {}
    });
    check('4.6 swapBrain 热切换预刷盘后，新 Brain 实例立即恢复 engramGraph 最新边权',
      swapRes.ok === true &&
      swapRes.brain.memory.engramGraph.getEdge('tr-hot-1', 'tr-hot-2') !== null &&
      swapRes.brain.memory.engramGraph.getEdge('tr-hot-1', 'tr-hot-2').weight === 1.0);

    // 验证跨窗热切 syncWindowExperimentSnapshot：experimental -> baseline -> experimental
    const activeBrain = swapRes.brain;
    saveConfig(expDir, { ...activeBrain.cfg, experimentMode: 'baseline' });
    activeBrain._syncWindowExperimentSnapshot();
    const disabledState = activeBrain.memory.isEngramGraphActive === false && activeBrain.memory.epistemicForagingEnabled === false;
    saveConfig(expDir, { ...activeBrain.cfg, experimentMode: 'experimental', experimentModules: { ...DEFAULTS.experimentModules, engramGraph: true, epistemicForaging: true, memoryDynamics: true } });
    activeBrain._syncWindowExperimentSnapshot();
    const reEnabledState = activeBrain.memory.isEngramGraphActive === true && activeBrain.memory.epistemicForagingEnabled === true;
    check('4.7 syncWindowExperimentSnapshot 支持跨窗热切 baseline 旁路与重新启用恢复',
      disabledState && reEnabledState);

    // 验证 Memory.reset() 同步清空图谱
    activeBrain.memory.reset();
    check('4.8 Memory.reset() 同步清空 engramGraph 边并落盘',
      activeBrain.memory.engramGraph.edges.size === 0 &&
      new EngramGraph(expDir, { enabled: true }).edges.size === 0);
  }

  // ---- 5. D-001 静态零定时器与原子写扫描 ----
  {
    const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const graphSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'engram-graph.js'), 'utf8'));
    check('5.1 D-001 静态门禁：src/engram-graph.js 零 setInterval / setTimeout / writeFileSync',
      !/\b(setInterval|setTimeout|writeFileSync)\b/.test(graphSrc));
  }

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
