/**
 * test/v222-relational-anchor.test.js
 *
 * v2.2.2 门禁：互惠关系锚定（Relational Anchor）
 *
 * 覆盖：
 *  1. 冷启动零注入（relationalAnchors 初始为空，systemText 零先验）
 *  2. 稳定称呼筛选：单窗偶发词不升格、跨窗复现升格、adopted 门槛与 nickname 上限 2 确定性排序
 *  3. 互惠事实沉淀：fulfilled/broken 分别格式化为 [兑现事实]/[偏差事实]、空 note 省略箭头、open/moot/缺引证过滤、缺失 resolvedWindowNo 兼容回退、上限 3 且滚出 FIFO-10 后仍不丢失
 *  4. 关窗双点幂等刷新：Brain.closeWindow() 当轮同步刷新本窗新增称呼共振与刚刚结算的 expectationOutcomes（零滞后一窗）
 *  5. systemText() 前缀与顺序不变式：仅关窗更新、插于 expectations 与 dreamFragments/wardrobe 之间、wardrobe 仍在结尾、绝不输出 anchorWeight/id/messageId
 *  6. baseline/ablation 隔离、跨窗热切 setRelationalAnchorEnabled、Memory.load() 旧档/脏数据归一、Memory.reset() 清空
 *  7. observability 仅报计数零正文泄露 & ui-i18n 双语对称、D-001 零定时器与零正则静态守卫
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// [tmp-hygiene] 包住 fs.mkdtempSync 本身并于 exit 时统一清理
const _tmpHygieneDirs = [];
const _tmpHygieneOrig = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _tmpHygieneOrig.apply(fs, a);
  _tmpHygieneDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _tmpHygieneDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdtempSync = _tmpHygieneOrig;
});

const ROOT = path.join(__dirname, '..');
const { Memory } = require('../src/memory');
const { Brain } = require('../src/brain');
const { DEFAULTS, sanitize, save: saveConfig } = require('../src/config');
const { DEFAULT_EXPERIMENT_MODULES } = require('../src/experiment-types');
const {
  refreshRelationalAnchors,
  formatRelationalAnchorsBlock,
  normalizeRelationalAnchors
} = require('../src/memory-relational-anchor');
const { collectObservability } = require('../src/observability');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  /* ============ 1. 冷启动零注入与传记空白 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const mem = new Memory(dir, { persona: 'P', relationalAnchor: true });
    const sys = mem.systemText();
    check('1a 冷启动 relationalAnchors 初始为空数组且 formatRelationalAnchorsBlock 返回空串',
      Array.isArray(mem.data.relationalAnchors) && mem.data.relationalAnchors.length === 0 &&
      formatRelationalAnchorsBlock([]) === '');
    check('1b 冷启动 systemText() 不含关系锚点标题（零先验注入）',
      !sys.includes('【长期沉淀的关系锚点】'));
  }

  /* ============ 2. 稳定称呼筛选：单窗不升格 / 跨窗升格 / 上限 2 / 状态退化出队 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const mem = new Memory(dir, { persona: 'P', relationalAnchor: true });
    mem.append('user', '以后叫你小星吧');
    mem.append('assistant', '好呀，那小星与云朵就作为暗号');
    const idUser = mem.data.history[0].messageId;
    const idAsst = mem.data.history[1].messageId;

    // 单窗高权重词（lastUsedWindow === windowNo）与 weight 不足词不应升格
    mem.addLexicon({ word: '偶发称呼', kind: 'nickname', gloss: '单窗一次', messageId: idUser, windowNo: 1 });
    mem.data.lexicon[0].weight = 2.0; // 单窗仍不得升格

    mem.addLexicon({ word: '小星', kind: 'nickname', gloss: '用户常叫的昵称', messageId: idUser, windowNo: 1 });
    mem.addLexicon({ word: '小星', kind: 'nickname', messageId: idUser, windowNo: 2 }); // w=1.2 不够 1.4
    mem.addLexicon({ word: '小星', kind: 'nickname', messageId: idUser, windowNo: 3 }); // w=1.4, lastUsed=3 > 1 -> 达标

    mem.addLexicon({ word: '云朵', kind: 'adopted', gloss: '专属暗号', messageId: idAsst, windowNo: 1 });
    mem.data.lexicon.find((x) => x.word === '云朵').lastUsedWindow = 2;
    mem.data.lexicon.find((x) => x.word === '云朵').weight = 1.5; // adopted 要求 >= 1.6

    refreshRelationalAnchors(mem, 3);
    const list1 = mem.data.relationalAnchors.filter((x) => x.kind === 'nickname');
    check('2a 单窗偶发词与未达权重阈值的 adopted 不误升格；跨窗达标称呼正确升格',
      list1.length === 1 && list1[0].label === '小星' && list1[0].firstWindowNo === 1 && list1[0].lastConfirmedWindow === 3);

    // 补足 adopted 与第三个高权 nickname，检验排序与上限 2
    mem.data.lexicon.find((x) => x.word === '云朵').weight = 1.7;
    mem.addLexicon({ word: '阿澜', kind: 'nickname', gloss: '高权重称呼', messageId: idUser, windowNo: 1 });
    const aLan = mem.data.lexicon.find((x) => x.word === '阿澜');
    aLan.lastUsedWindow = 4;
    aLan.weight = 2.2;
    refreshRelationalAnchors(mem, 4);
    const list2 = mem.data.relationalAnchors.filter((x) => x.kind === 'nickname');
    check('2b 稳定称呼按权重降序截断上限为 2（阿澜 2.2 + 云朵 1.7）且原 lexicon 零删除',
      list2.length === 2 && list2[0].label === '阿澜' && list2[1].label === '云朵' && mem.data.lexicon.length === 4);

    // 阿澜退入 FADING 后自然移出稳定称呼，小星顺位补回（lexicon 原记录仍在）
    aLan.status = 'FADING';
    refreshRelationalAnchors(mem, 7);
    const list3 = mem.data.relationalAnchors.filter((x) => x.kind === 'nickname');
    check('2c 非 ACTIVE 词汇自然移出稳定称呼，不物理删除 lexicon',
      list3.length === 2 && list3[0].label === '云朵' && list3[1].label === '小星' &&
      mem.data.lexicon.some((x) => x.word === '阿澜' && x.status === 'FADING'));
  }

  /* ============ 3. 互惠事实沉淀、[偏差事实]/空note格式化、FIFO-10 滚出后保留 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const mem = new Memory(dir, { persona: 'P', relationalAnchor: true });
    mem.append('user', '周六一起去听音乐会');
    mem.append('assistant', '好，周六见');
    const idU = mem.data.history[0].messageId;
    const idA = mem.data.history[1].messageId;

    const eOpen = mem.addExpectation({ kind: 'external', source: 'user', text: '未完成约定', messageId: idU, windowNo: 1 });
    const eMoot = mem.addExpectation({ kind: 'pledge', source: 'chulan', text: '作废约定', messageId: idA, windowNo: 1 });
    mem.resolveExpectation(eMoot.entry.id, { status: 'moot' });

    const eBroken = mem.addExpectation({ kind: 'external', source: 'user', text: '没寄出的明信片', messageId: idU, windowNo: 2 });
    mem.resolveExpectation(eBroken.entry.id, { status: 'broken', messageId: idU, note: '', windowNo: 3 });

    const eFulfilled = mem.addExpectation({ kind: 'pledge', source: 'chulan', text: '周六一起听音乐会', messageId: idA, windowNo: 3 });
    mem.resolveExpectation(eFulfilled.entry.id, { status: 'fulfilled', messageId: idU, note: '周六顺利去听了', windowNo: 4 });

    // 旧档缺失 outcome.resolvedWindowNo 的兼容性回 Fallback
    mem.data.expectations.push({
      id: 'exp-000099',
      kind: 'external',
      text: '旧档已兑现之约',
      source: 'user',
      messageId: idU,
      windowNo: 2,
      status: 'fulfilled',
      outcome: { at: null, messageId: idA, note: '旧档备注' }
    });

    refreshRelationalAnchors(mem, 4);
    const recs1 = mem.data.relationalAnchors.filter((x) => x.kind === 'reciprocity');
    const block = formatRelationalAnchorsBlock(mem.data.relationalAnchors);

    check('3a open / moot 不沉淀；fulfilled / broken 与旧档缺 resolvedWindowNo 均正确沉淀且上限为 3',
      recs1.length === 3 &&
      !recs1.some((x) => x.text === '未完成约定' || x.text === '作废约定') &&
      recs1[0].text === '周六一起听音乐会' &&
      recs1.some((x) => x.text === '旧档已兑现之约' && x.resolvedWindowNo === 2));
    check('3b 格式化正确区分 [兑现事实]/[偏差事实]，空 note 省略箭头，绝不泄漏 anchorWeight/id/messageId',
      block.includes('- [兑现事实] 周六一起听音乐会 → 周六顺利去听了') &&
      block.includes('- [偏差事实] 没寄出的明信片') &&
      !block.includes('没寄出的明信片 →') &&
      !block.includes('anchorWeight') &&
      !block.includes('anc-rec-') &&
      !block.includes(idU));

    // 用 12 条新 open 约定把已结算条目完全挤出 expectations FIFO-10
    for (let i = 0; i < 12; i++) {
      mem.addExpectation({ kind: 'external', source: 'user', text: '新队列挤压' + i, messageId: idU, windowNo: 5 });
    }
    refreshRelationalAnchors(mem, 5);
    const recsAfterEvict = mem.data.relationalAnchors.filter((x) => x.kind === 'reciprocity');
    check('3c 原约定滚出 expectations FIFO-10 后，已沉淀的互惠事实锚点仍完整保留',
      !mem.data.expectations.some((x) => x.text === '周六一起听音乐会') &&
      recsAfterEvict.some((x) => x.text === '周六一起听音乐会'));
  }

  /* ============ 4. systemText() 顺序不变式（expectations 后、dreamFragments & wardrobe 前） ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const mem = new Memory(dir, { persona: '【人设】你是初澜', relationalAnchor: true });
    mem.append('user', '把我们的约定记下');
    const idU = mem.data.history[0].messageId;
    mem.addExpectation({ kind: 'external', source: 'user', text: '明晚散步', messageId: idU, windowNo: 1 });
    mem.data.dreamFragments = ['梦见一片静止的海'];
    mem.wardrobe = '【当前穿着】\n- 上装：浅蓝针织衫';
    mem.data.relationalAnchors = [{
      id: 'anc-nick-阿月',
      kind: 'nickname',
      label: '阿月',
      gloss: '稳定昵称',
      sourceMessageId: idU,
      firstWindowNo: 1,
      lastConfirmedWindow: 2,
      anchorWeight: 1.8
    }];

    const sys = mem.systemText();
    const iExp = sys.indexOf('【当前指向未来的约定与预期】');
    const iAnc = sys.indexOf('【长期沉淀的关系锚点】');
    const iDream = sys.indexOf('【离线重组碎片】');
    const iWd = sys.indexOf('【当前穿着】');
    check('4 systemText() 注入位置严格在 expectations 与 dreamFragments 之间且 wardrobe 仍在最末尾',
      iExp >= 0 && iAnc > iExp && iDream > iAnc && iWd > iDream && sys.endsWith(mem.wardrobe));
  }

  /* ============ 5. 端到端 Brain.closeWindow() 双点刷新：当窗新增称呼共振 + 当窗刚结算预期零滞后 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const brain = new Brain(dir, {
      ...DEFAULTS,
      apiKey: 'sk-test-anchor',
      baseURL: 'https://api.deepseek.com',
      provider: 'deepseek',
      windowTurns: 10,
      keepTailMessages: 2,
      selfGrowthEnabled: false,
      experimentMode: 'experimental',
      experimentModules: { ...DEFAULTS.experimentModules, sleepConsolidation: false, relationalAnchor: true }
    });

    // 预置 window 1 立下的约定和称呼（权重 1.2，待 window 2 再提及升到 1.4+）
    brain.memory.data.windowNo = 1;
    brain.memory.append('user', '以后你可以叫我阿星，下回一起看月亮');
    const m1Id = brain.memory.data.history[0].messageId;
    brain.memory.addLexicon({ word: '阿星', kind: 'nickname', gloss: '亲近称呼', messageId: m1Id, windowNo: 1 });
    brain.memory.data.lexicon[0].weight = 1.2;
    const exp1 = brain.memory.addExpectation({ kind: 'external', source: 'user', text: '下回一起看月亮', messageId: m1Id, windowNo: 1 });

    // 推进到第 2 窗对话并触发 closeWindow()
    brain.memory.data.windowNo = 2;
    brain.memory.append('user', '阿星今天过来啦，我们刚看完月亮');
    brain.memory.append('assistant', '阿星，今晚月亮真亮');
    const m2Id = brain.memory.data.history[1].messageId;

    brain.api.complete = async () => ({
      text: JSON.stringify({
        segments: [{ range: '1-2', userGiven: ['阿星一起看了月亮'], chulanExperience: ['一起赏月'], stateEvidence: [], uncertainties: [] }],
        windowSynthesis: {
          stableUserFacts: ['一起看了月亮'],
          subjectExperiences: ['被叫阿星时的默契感'],
          stateChangesSuggested: [],
          unresolved: [],
          coinages: [{ word: '阿星', kind: 'nickname', gloss: '亲近称呼', messageId: m2Id }],
          expectations: [],
          expectationOutcomes: [{ id: exp1.entry.id, status: 'fulfilled', messageId: m2Id, note: '当晚一起看了月亮' }]
        }
      }),
      observedModel: 'deepseek-flash',
      usage: { prompt_tokens: 40, completion_tokens: 30 }
    });

    const closed = await brain.closeWindow({ closeReason: 'turn_limit' });
    const anchors = brain.memory.data.relationalAnchors;
    const sysAfter = brain.memory.systemText();
    // 窗口运行期内再读 systemText() 应逐字节恒等
    brain.memory.append('user', '新窗口日常对话一');
    const sysMidWindow = brain.memory.systemText();

    check('5a Brain.closeWindow() 当窗刷新：本窗刚共振的阿星与刚结算的 expectationOutcomes 零滞后立即可用',
      closed === true &&
      anchors.some((x) => x.kind === 'nickname' && x.label === '阿星' && x.lastConfirmedWindow === 2 && x.anchorWeight >= 1.4) &&
      anchors.some((x) => x.kind === 'reciprocity' && x.text === '下回一起看月亮' && x.outcomeStatus === 'fulfilled'));
    check('5b 关窗后新窗口运行期间 systemText() 逐字节恒等且含关系锚点',
      sysAfter === sysMidWindow && sysAfter.includes('【长期沉淀的关系锚点】') && sysAfter.includes('阿星'));
  }

  /* ============ 6. 实验开关隔离、跨窗热切、旧档/脏数据兼容与 reset 清空 ============ */
  {
    check('6a DEFAULT_EXPERIMENT_MODULES 登记 relationalAnchor=false，DEFAULTS 与 sanitize() 均正常处理',
      DEFAULT_EXPERIMENT_MODULES.relationalAnchor === false &&
      DEFAULTS.experimentModules.relationalAnchor === true &&
      sanitize({ experimentMode: 'experimental' }).experimentModules.relationalAnchor === true &&
      sanitize({ experimentMode: 'baseline', experimentModules: { relationalAnchor: true } }).experimentModules.relationalAnchor === false &&
      sanitize({ experimentMode: 'ablation', experimentModules: { relationalAnchor: false } }).experimentModules.relationalAnchor === false);

    const dirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const baseBrain = new Brain(dirBase, {
      ...DEFAULTS,
      apiKey: 'sk-base',
      experimentMode: 'baseline'
    });
    const expDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const expBrain = new Brain(expDir, {
      ...DEFAULTS,
      apiKey: 'sk-exp',
      experimentMode: 'ablation',
      experimentModules: { ...DEFAULTS.experimentModules, relationalAnchor: false }
    });
    const offBefore = expBrain.memory.relationalAnchorEnabled;
    saveConfig(expDir, {
      ...expBrain.cfg,
      experimentMode: 'experimental',
      experimentModules: { ...DEFAULTS.experimentModules, relationalAnchor: true }
    });
    expBrain._syncWindowExperimentSnapshot();

    check('6b Brain baseline 强制关闭 relationalAnchor 且 _syncWindowExperimentSnapshot() 支持跨窗热切',
      baseBrain.memory.relationalAnchorEnabled === false &&
      offBefore === false &&
      expBrain.memory.relationalAnchorEnabled === true);

    // 旧档案缺 relationalAnchors 与脏条目兼容，以及 reset() 清空
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    fs.writeFileSync(path.join(legacyDir, 'memory.json'), JSON.stringify({
      schemaVersion: 1, windows: [], history: [], turnsInWindow: 0, totalTurns: 0, windowNo: 2, epoch: 0,
      relationalAnchors: [null, { kind: 'nickname', label: 'bad-missing-id' }]
    }));
    const legacyMem = new Memory(legacyDir, { relationalAnchor: true });
    legacyMem.data.relationalAnchors = normalizeRelationalAnchors([{
      id: 'anc-nick-阿星', kind: 'nickname', label: '阿星', gloss: '昵称',
      sourceMessageId: 'm-000001', firstWindowNo: 1, lastConfirmedWindow: 2, anchorWeight: 1.6
    }]);
    legacyMem.reset();
    check('6c 旧档无字段/脏条目加载自动清洗归一，Memory.reset() 同步清空 relationalAnchors',
      Array.isArray(legacyMem.data.relationalAnchors) && legacyMem.data.relationalAnchors.length === 0);
  }

  /* ============ 7. Observability 只读零泄露、i18n 对称与 D-001 静态门禁 ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-anchor-'));
    const memOff = new Memory(dir, { relationalAnchor: false });
    const memOn = new Memory(dir, { relationalAnchor: true });
    memOn.data.relationalAnchors = [
      { id: 'anc-nick-阿月', kind: 'nickname', label: '绝密称呼阿月', gloss: '绝密释义', sourceMessageId: 'm-1', firstWindowNo: 1, lastConfirmedWindow: 2, anchorWeight: 1.8 },
      { id: 'anc-rec-exp-1', kind: 'reciprocity', outcomeStatus: 'fulfilled', source: 'user', text: '绝密约定文本', note: '绝密兑现备注', sourceMessageId: 'm-1', outcomeMessageId: 'm-2', resolvedWindowNo: 2 }
    ];

    const obsEmpty = collectObservability({});
    const obsOff = collectObservability({ brain: { memory: memOff } });
    const obsOn = collectObservability({ brain: { memory: memOn } });
    const specOff = obsOff.groups.memory.find((x) => x.id === 'memory.relationalAnchors');
    const specEmpty = obsEmpty.groups.memory.find((x) => x.id === 'memory.relationalAnchors');
    const specOn = obsOn.groups.memory.find((x) => x.id === 'memory.relationalAnchors');
    const obsSerialized = JSON.stringify(obsOn);

    check('7a observability memory.relationalAnchors 空/关闭给 null，启用只报计数且零正文泄露',
      specEmpty && specEmpty.value === null &&
      specOff && specOff.value === null &&
      specOn && specOn.value && specOn.value.enabled === true &&
      specOn.value.total === 2 && specOn.value.nicknameCount === 1 && specOn.value.reciprocityCount === 1 &&
      !obsSerialized.includes('绝密称呼阿月') && !obsSerialized.includes('绝密约定文本') && !obsSerialized.includes('绝密兑现备注'));

    const i18nSrc = fs.readFileSync(path.join(ROOT, 'ui-i18n.js'), 'utf8');
    const anchorSrc = fs.readFileSync(path.join(ROOT, 'src', 'memory-relational-anchor.js'), 'utf8');
    const stripped = anchorSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    check('7b ui-i18n 双语键齐备且 memory-relational-anchor.js 严守 D-001 零定时器与零正则提取',
      (i18nSrc.split("'obs.memory.relationalAnchors'").length - 1) >= 2 &&
      (i18nSrc.split("'obs.field.nicknameCount'").length - 1) >= 2 &&
      (i18nSrc.split("'obs.field.reciprocityCount'").length - 1) >= 2 &&
      !/\b(setTimeout|setInterval|new RegExp)\b/.test(stripped) &&
      !/\.match\(|\.test\(/.test(stripped));
  }

  console.log('\n' + (failures ? failures + ' 项失败' : 'v222-relational-anchor tests passed'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
