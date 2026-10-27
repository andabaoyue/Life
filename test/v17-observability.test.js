/**
 * test/v17-observability.test.js
 *
 * v1.7-b 门禁：个体观测面板的**声明式注册表补全**。
 *
 * ## 这一轮补的是哪块
 *   `main.js` 的 `life-mechanisms` 此前只返回 6 组手写字段，`pet.js` 手写渲染。
 *   v1.1~v1.6 陆续落地的机制（心境 warmth/stillness、互动密度、显著性阈值、
 *   知觉水位线、主动开口偏置、好奇队列、自发便签、观察日记、印痕分层、
 *   熔断状态、执行预算、审计条数）**算出来了但从来没被看见**。
 *
 * ## 三条铁律（各有独立断言）
 *   1. **只读**：连读两次，所有数值逐字节相等（观察者效应不得改变她的状态）；
 *   2. **不造假**：上下文缺数据时给 null，渲染出破折号而**不是 0**；
 *   3. **不外泄**：便签/日记只报条数与状态，**正文不进 payload**。
 *
 * ## 两道结构守卫
 *   - **死项守卫**：注册表 id 集合 ↔ 渲染层生成的 DOM id 集合**双向差集为空**
 *     （照 public-export.js 的 deadRules 手法：注册了没画、画了没注册，都是缺陷）；
 *   - **旧字段不回归**：六个旧字段仍存在且形状不变（平滑演进，分批验证）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  OBSERVABILITY_SPECS, GROUP_ORDER, GROUP_LABELS, collectObservability, noteStats, num, safeRead
} = require('../src/observability');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'ui-i18n.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.7-b 观测面板声明式补全门禁 ---');

/* ============ 1. 注册表结构完整性 ============ */

check('注册表非空', Array.isArray(OBSERVABILITY_SPECS) && OBSERVABILITY_SPECS.length > 0,
  'len=' + OBSERVABILITY_SPECS.length);

// id 唯一性：重复 id 会让渲染层的 dataset.obsId 相撞，门禁无法定位
const ids = OBSERVABILITY_SPECS.map((s) => s.id);
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
check('❌ 注册表 id 全局唯一', dupIds.length === 0, dupIds.join(','));

// 每项必须有 read 函数（否则运行时静默给 null，等于注册了一个死项）
const noRead = OBSERVABILITY_SPECS.filter((s) => typeof s.read !== 'function').map((s) => s.id);
check('❌ 每项都有 read 函数', noRead.length === 0, noRead.join(','));

// 每项必须有 labelKey（i18n 缺键会回退 text，但 labelKey 是契约）
const noLabel = OBSERVABILITY_SPECS.filter((s) => !s.labelKey).map((s) => s.id);
check('❌ 每项都有 labelKey', noLabel.length === 0, noLabel.join(','));

// group 必须在 GROUP_ORDER 里声明过（否则会排到最后，虽不丢数据但排版失控）
const unknownGroups = [...new Set(OBSERVABILITY_SPECS.map((s) => s.group))]
  .filter((g) => !GROUP_ORDER.includes(g));
check('❌ 所有 group 都在 GROUP_ORDER 中声明', unknownGroups.length === 0, unknownGroups.join(','));

// 每个 group 必须有中英双语标签
const noLabelGroup = GROUP_ORDER.filter((g) => !GROUP_LABELS[g] || !GROUP_LABELS[g].zh || !GROUP_LABELS[g].en);
check('❌ 每个 group 都有中英标签', noLabelGroup.length === 0, noLabelGroup.join(','));

/* ============ 2. 12 项缺口是否真的都注册了 ============ */

// 这是本轮的**交付物清单**：少一项就是漏观测
const REQUIRED = [
  'vitals.core', 'vitals.mood', 'vitals.social', 'vitals.watermark',
  'cognition.self',
  'memory.engrams', 'memory.relation', 'memory.archive',
  'curiosity.queue', 'curiosity.expectations',
  'notes.self', 'notes.journal',
  'agency.bias', 'provider.breaker', 'agent.budget', 'agent.audit'
];
const missing = REQUIRED.filter((id) => !ids.includes(id));
check('🔴 全部缺口项均已注册', missing.length === 0, '缺: ' + missing.join(','));

/**
 * 🔴 P2-3c 合规断言（与 test/canalization.test.js 的守卫同向，不是绕过）。
 *
 * `getCanalizationMetrics` / `DEVELOPMENTAL_STAGES` 是**纯叙事标签、无机制消费方**，
 * 把它们搬上观测面板等于用 UI 给叙事镀上机制的可信度 —— 那是「拟人化伪生命」。
 * 本模块曾是唯一违规者（v1.7-b 初版有 `cognition.development`），已删除。
 * 这条断言把"以后谁想加回来"也挡住。
 */
const obsSrcStripped = fs.readFileSync(path.join(ROOT, 'src/observability.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
check('🔴 observability 不引用 canalization 的叙事标签（P2-3c 合规）',
  !obsSrcStripped.includes('getCanalizationMetrics')
  && !obsSrcStripped.includes('DEVELOPMENTAL_STAGES')
  && !obsSrcStripped.includes('getDevelopmentalStage'),
  '观测面板只显示真实参与运算的标量，叙事标签不得升格为机制');

/* ============ 3. 空上下文不崩、不造假 ============ */

// 全空 ctx：所有 read 都必须安全返回 null，绝不抛
let emptyResult = null;
let threw = false;
try {
  emptyResult = collectObservability({});
} catch (e) { threw = true; }
check('❌ 空上下文 collectObservability 不抛', !threw && emptyResult !== null);

check('空上下文仍返回完整分组结构',
  emptyResult && emptyResult.order.length > 0 && Object.keys(emptyResult.groups).length > 0,
  'groups=' + (emptyResult ? Object.keys(emptyResult.groups).length : 0));

// 🔴 不造假：空上下文里每一笔都必须是 null，绝不能是 0
const allValues = [];
for (const g of Object.keys(emptyResult.groups)) {
  for (const it of emptyResult.groups[g]) allValues.push({ id: it.id, v: it.value });
}
const faked = allValues.filter((x) => x.v !== null && x.v !== undefined);
check('🔴 空上下文下所有数值均为 null（绝不补零）', faked.length === 0,
  faked.map((x) => x.id + '=' + JSON.stringify(x.v)).join(','));

/* ============ 3.5 有数据的上下文里，真实项必须读出真实值 ============ */

/**
 * 这一条守的是「注册表不能全是 null」——
 * 如果所有 read 都因为某个共因失败（比如 ctx 形状变了），
 * 上面"空上下文全部 null"那条反而会**恒真**，本门禁就成了空转。
 * 所以必须有一个"有数据时真能读出东西"的正向对照。
 */
const memCtx = (() => {
  const { Memory } = require('../src/memory');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v17-obs-pos-'));
  const mem = new Memory(d, { persona: 'P' });
  mem.addSelfNote({ content: '一条便签', name: 'n.md', source: 'selfNote' });
  return { ctx: { brain: { memory: mem } }, dir: d };
})();

let posResult = null;
let posThrew = false;
try {
  posResult = collectObservability(memCtx.ctx);
} catch (e) { posThrew = true; }
try { fs.rmSync(memCtx.dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不掀桌 */ }

const posNonNull = (() => {
  if (!posResult) return 0;
  let n = 0;
  for (const g of Object.keys(posResult.groups)) {
    for (const it of posResult.groups[g]) if (it.value !== null && it.value !== undefined) n++;
  }
  return n;
})();

check('❌ 有数据上下文读取不抛', !posThrew);
check('🔴 有 memory 时至少能读出 3 项真实值（防"全部 null"恒真）',
  posNonNull >= 3, '实得 ' + posNonNull + ' 项非 null');

// 便签计数项必须真的反映出那条便签
const noteSelfItem = (() => {
  if (!posResult || !posResult.groups.notes) return null;
  return posResult.groups.notes.find((x) => x.id === 'notes.self');
})();
check('🔴 notes.self 在有便签时给出 true 计数', noteSelfItem && noteSelfItem.value
  && noteSelfItem.value.total === 1, JSON.stringify(noteSelfItem && noteSelfItem.value));


/* ============ 4. 单项失败不拖垮整块 ============ */

// 伪造一个会在 read() 里抛异常的 ctx（getter 抛错）
const boom = {};
Object.defineProperty(boom, 'brain', {
  get() { throw new Error('boom'); },
  configurable: true
});
let boomThrew = false;
let boomResult = null;
try { boomResult = collectObservability(boom); } catch (e) { boomThrew = true; }
check('❌ 读取抛异常时 collectObservability 仍不抛', !boomThrew);
check('❌ 读取抛异常时仍返回完整结构（面板不白屏）',
  boomResult && boomResult.order.length > 0);

/* ============ 5. safeRead 包装器语义 ============ */

check('safeRead 把 undefined 归一为 null',
  safeRead(() => undefined)({}) === null);
check('safeRead 吞掉异常并返回 null',
  safeRead(() => { throw new Error('x'); })({}) === null);
check('safeRead 正常透传返回值',
  safeRead(() => 42)({}) === 42);

/* ============ 6. num() 不把非数值伪造成数字 ============ */

check('num() 取不到给 null', num({}, 'x') === null && num(null, 'x') === null);
check('num() 非数值给 null（字符串/NaN 都不许变数字）',
  num({ x: 'abc' }, 'x') === null && num({ x: NaN }, 'x') === null);
check('num() 0 是合法值（0 和"没有"是两件事）', num({ x: 0 }, 'x') === 0);

/* ============ 7. 🔴 铁律 3：便签/日记正文绝不进 payload ============ */

const SECRET_BODY = '这是她的便签正文，绝不该出现在遥测 payload 里';
const fakeCtx = {
  brain: {
    memory: {
      data: {
        selfNotes: [
          { content: SECRET_BODY, name: '/x/a.md', source: 'selfNote', drained: false, engraved: false },
          { content: SECRET_BODY + '2', name: '/x/b.md', source: 'selfNote', drained: true, engraved: true },
          { content: SECRET_BODY + '3', name: '/x/c.md', source: 'observerJournal', drained: false, engraved: false }
        ]
      }
    }
  }
};

const noteSelf = noteStats(fakeCtx, 'selfNote');
check('notes.self 只给条数', noteSelf && noteSelf.total === 2, 'total=' + (noteSelf && noteSelf.total));
check('notes.self 给 pending（未注入）', noteSelf && noteSelf.pending === 1, 'pending=' + (noteSelf && noteSelf.pending));
check('notes.self 给 engraved（已铸）', noteSelf && noteSelf.engraved === 1, 'engraved=' + (noteSelf && noteSelf.engraved));
check('❌ notes.self 的返回对象不含 content 字段', noteSelf && !('content' in noteSelf));

const noteJournal = noteStats(fakeCtx, 'observerJournal');
check('notes.journal 只统计 observerJournal', noteJournal && noteJournal.total === 1);

// 端到端：整个 collect 结果序列化后，绝不能 grep 到正文
const leakResult = collectObservability(fakeCtx);
const serialized = JSON.stringify(leakResult);
check('🔴 便签正文不出现在 collectObservability 结果的任何位置',
  !serialized.includes(SECRET_BODY));
check('🔴 便签文件名也不出现在 payload 里（只报条数）',
  !serialized.includes('a.md') && !serialized.includes('b.md'));

/* ============ 8. 🔴 铁律 1：只读，连读两次结果一致 ============ */

// 用真实 Memory 造一个有数据的上下文，连读两次比对
const { Memory } = require('../src/memory');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v17-obs-'));
let roOk = true, roDetail = '';
try {
  const mem = new Memory(tmpDir, { persona: 'P' });
  mem.addSelfNote({ content: '一条便签', name: 'n.md', source: 'selfNote' });
  const ctx = { brain: { memory: mem } };

  const r1 = collectObservability(ctx);
  const r2 = collectObservability(ctx);
  // generatedAt 必然不同（时间戳），故只比 groups 部分
  const g1 = JSON.stringify(r1.groups);
  const g2 = JSON.stringify(r2.groups);
  if (g1 !== g2) { roOk = false; roDetail = '两次读数不一致'; }
} catch (e) {
  roOk = false;
  roDetail = String(e && e.message);
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不掀桌 */ }
}
check('🔴 连读两次 groups 逐字节相等（只读，不推进任何状态）', roOk, roDetail);

/* ============ 9. 结构守卫：注册表 ↔ 渲染层 ↔ DOM 三方对齐 ============ */

// main.js 必须真的调用 collectObservability（不是只 import 没用）
check('🔴 main.js 的 life-mechanisms 真的调用了 collectObservability',
  mainSrc.includes('collectObservability') && mainSrc.includes("require('./src/observability')"));

// 🔴 TDZ 防回归：agentBudget / agentAuditLog 是 whenReady 的块级 const，
//   顶层 handler 直接引用会抛 TDZ（本仓已踩过同型坑）。必须走模块级入口。
check('🔴 main.js 观测上下文不含裸引用 agentBudget（防 TDZ）',
  !/collectObservability\(\{[^}]*\bagentBudget\b\s*,/.test(mainSrc)
  || mainSrc.includes('agentBuildDeps ? agentBuildDeps.agentBudget'),
  '应通过 agentBuildDeps 取 budget');

/* 🔴 2026-10-27：旧字段的**去重整改**已完成。
 *
 * 原断言写的是「旧字段必须并行保留（平滑演进：分批改两端）」，那是过渡期的约束。
 * 第二批已落地：与注册表逐字重复的三块（生理潮汐/认知张力/关系与存在）
 * 现在**只由遥测渲染一次**，手写渲染已删。
 *
 * 所以本节的断言方向必须反过来 —— 否则会守住一个已经该消失的状态：
 *   · lexicon / expectations 仍需要（它们是**原文列表**，遥测只有计数，不等价）
 *   · development 必须**恒为 null**（P2-3c：纯叙事标签不得升格为可观测机制）
 */
for (const legacy of ['lexicon', 'expectations']) {
  check('原文列表字段仍返回: ' + legacy, new RegExp('\\b' + legacy + '\\b').test(mainSrc));
}

// 重复的手写渲染必须彻底消失（否则同一份数字会在同一屏出现两遍）
for (const dead of ['rVitalsList', 'rCogList', 'rRelList', 'rDevList']) {
  check('🔴 重复区块已删除: #' + dead,
    !petSrc.includes("'" + dead + "'") && !htmlSrc.includes('id="' + dead + '"'),
    '残留会让同一数据渲染两遍');
}

// development 恒为 null（不是"忘了赋值"，是禁止赋值）
check('🔴 main.js 不再调用 getCanalizationMetrics（P2-3c）',
  !/getCanalizationMetrics\s*\(/.test(
    mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  ), '注释里可以提，代码里不许调');

check('🔴 main.js 不再调用 getDevelopmentalStage / 引用 DEVELOPMENTAL_STAGES',
  !/(getDevelopmentalStage|DEVELOPMENTAL_STAGES)/.test(
    mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  ), '纯叙事标签不得进生产代码');

// 🔴 子标签结构：两个子页 + 容器都在
check('🔴 index.html 有子标签容器 #rStateSubtabs', htmlSrc.includes('id="rStateSubtabs"'));
check('🔴 index.html 有两个子页（subject / obs）',
  htmlSrc.includes('id="rSubPaneSubject"') && htmlSrc.includes('id="rSubPaneObs"'));
check('🔴 pet.js 有 switchStateSubtab 切换函数', petSrc.includes('function switchStateSubtab'));
check('🔴 子标签事件已绑定（data-subtab）',
  /\.r-subtab[\s\S]{0,120}addEventListener\('click'/.test(petSrc));

// 🔴 折叠：默认收起 + 事件委托 + 不用 innerHTML
check('🔴 遥测分组默认收起（初始即带 hidden）',
  /obs-group-body hidden/.test(petSrc), '一次铺开 16 项会让页面过长');
check('🔴 折叠走事件委托（不逐组绑，避免刷新时叠加监听器）',
  /dataset\.obsDelegate/.test(petSrc) && /closest\('\[data-obs-group-toggle\]'\)/.test(petSrc));
/* 🔴 折叠渲染不使用 innerHTML（防注入）。
 *   ⚠️ 判据必须**剥注释再扫** —— 本函数的注释里正写着「绝不 innerHTML」这句警示，
 *   不剥注释会让警示语自己把断言弄红（这条判据首版就踩了这个坑）。 */
{
  const segRaw = petSrc.slice(petSrc.indexOf('function renderObsGroups'),
    petSrc.indexOf('function formatObsValue'));
  const segNoComment = segRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('🔴 折叠渲染不使用 innerHTML（防注入）',
    !/innerHTML/.test(segNoComment),
    '剥注释后仍含 innerHTML 才是真违规');
  check('（对照）renderObsGroups 函数体取到了', segRaw.length > 800, 'len=' + segRaw.length);
}

// pet.js 必须遍历注册表渲染，而不是手写区块
check('🔴 pet.js 有 renderObsGroups（遍历式渲染）', petSrc.includes('function renderObsGroups'));
check('🔴 pet.js 从响应里取 obs 字段并交给渲染',
  /renderObsGroups\(r\.obs\)/.test(petSrc));

// index.html 必须有动态容器（否则"注册了但没容器画"）
check('🔴 index.html 有 #rObsGroups 容器', htmlSrc.includes('id="rObsGroups"'));

// 🔴 死项守卫：注册表的每个 id，渲染层都能按 id 生成 DOM（dataset.obsId）
check('🔴 渲染层用 dataset.obsId 标记每一项（死项守卫的基础）',
  petSrc.includes('dataset.obsId'));

/* ============ 10. i18n 双语齐备 ============ */

for (const g of GROUP_ORDER) {
  const key = "'obs.group." + g + "'";
  const cnt = i18nSrc.split(key).length - 1;
  check('i18n 双语键存在: obs.group.' + g + '（出现 ' + cnt + ' 次）', cnt >= 2, 'cnt=' + cnt);
}
const obsKeyCnt = i18nSrc.split("'obs.dash'").length - 1;
check('通用文案 obs.dash 双语齐备', obsKeyCnt >= 2, 'cnt=' + obsKeyCnt);

// 每个 spec 的 labelKey 都必须有对应 i18n 键（否则面板显示裸 key）
const missingI18n = OBSERVABILITY_SPECS
  .filter((s) => (i18nSrc.split("'" + s.labelKey + "'").length - 1) < 2)
  .map((s) => s.labelKey);
check('❌ 每个 labelKey 都有双语 i18n 条目', missingI18n.length === 0, missingI18n.join(','));

/* ============ 11. 渲染层安全：绝不用 innerHTML ============ */

// 观测数据里有来自文件系统的字段（name 等），用 innerHTML 就是注入面
//
// ⚠️ 2026-10-27：原判据用 /function renderObsGroups\([\s\S]*?\n\}/ 切函数体，
//   两个缺陷：
//     ① **不剥注释** —— 函数内注释写着「绝不 innerHTML」，警示语自己把断言弄红；
//     ② `[\s\S]*?\n\}` 是**懒惰匹配到第一个行首 }**，遇到函数内的块（如折叠分支）
//        会提前截断，等于只检查了函数的一小段。
//   改为：从函数名切到下一个同名顶层函数（formatObsValue），并剥注释。
const renderRaw = petSrc.slice(
  petSrc.indexOf('function renderObsGroups'),
  petSrc.indexOf('function formatObsValue')
);
const renderBody = renderRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
check('🔴 renderObsGroups 内不使用 innerHTML',
  renderRaw.length > 0 && !renderBody.includes('innerHTML'),
  'len=' + renderRaw.length);

const fmtFn = petSrc.match(/function formatObsValue\([\s\S]*?\n\}/);
const fmtBody = fmtFn ? fmtFn[0] : '';
check('🔴 formatObsValue 内不使用 innerHTML', fmtBody.length > 0 && !fmtBody.includes('innerHTML'));

// 空值必须渲染破折号，而不是 0
check('🔴 formatObsValue 对 null 返回破折号（不是 0）',
  /value === null \|\| value === undefined\)\s*return dash/.test(fmtBody));

/* ============ 12. CSS 已就位 ============ */

const cssSrc = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
check('#rObsGroups 样式已就位',
  cssSrc.includes('#rObsGroups .obs-label') && cssSrc.includes('#rObsGroups .obs-value'));

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
