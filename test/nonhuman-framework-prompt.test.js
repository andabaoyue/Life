/* test/nonhuman-framework-prompt.test.js
 * 「非人类框架生命结构」五大方向的提示词边界门禁（静态 + 离线，不调模型）：
 * 1. 认识论分层：离线重组碎片必须带防伪标签、按需注入、且在穿着块之前（穿着块仍是 system 结尾）；
 * 2. 可及性距离：persona 保留反编造原句，增补距离隐喻，负向禁词只出现在禁令里；
 * 3. 价值自生：GROWTH_SYS 含「禁通用道德词、锚定真实取舍」强约束；
 * 4. 改变的改变：内态感知只出定性词 —— 零数字标量、零研究标签；
 * 5. 安静时段厚度：persona 含反虚伪情绪红线，且不误伤主动搭话。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { PERSONA } = require('../src/persona');
const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');

/* ---------- 方向②：可及性距离（增补而非替换） ---------- */
check('② persona 保留反编造原句（认知基石不许换掉）',
  PERSONA.includes('不知道就直接说不知道'));
check('② persona 增补距离隐喻（经历永不物理丢失）',
  PERSONA.includes('永不物理丢失') && PERSONA.includes('距离感'));
check('② 负向禁词只出现在禁令里（我忘了/丢了 类说法被点名禁止）',
  /我忘了/.test(PERSONA) && /丢了/.test(PERSONA));

/* ---------- 方向⑤：安静时段事实厚度 ---------- */
check('⑤ persona 含反虚伪情绪红线',
  /寂寞/.test(PERSONA) && /情绪表演/.test(PERSONA));
check('⑤ 红线不误伤主动搭话（主动性明文保留）',
  PERSONA.includes('主动搭话'));

/* ---------- 方向③：价值自生 ---------- */
const gStart = brainSrc.indexOf('const GROWTH_SYS');
const gEnd = brainSrc.indexOf('const MERGE_SYS');
const growthSys = brainSrc.slice(gStart, gEnd > gStart ? gEnd : brainSrc.length);
check('③ GROWTH_SYS 含反通用道德词禁令',
  growthSys.includes('严禁套用') && growthSys.includes('通用道德'));
check('③ GROWTH_SYS 证据链约束未变（messageIds/quote/oppose 仍在）',
  growthSys.includes('messageIds') && growthSys.includes('quote') && growthSys.includes('oppose'));

/* ---------- 方向④：改变的改变（定性感知、数字与研究标签不可知） ---------- */
const { Brain } = require('../src/brain');
const b = new Brain(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-')), {
  apiKey: 'sk-test', model: 'mock', windowTurns: 999, windowMaxTokens: 1e9,
  keepTailMessages: 6, memoryCapTokens: 1e9, currentSelfTokenBudget: 3000,
  price: { peak: {}, valley: {} }
});
const selfCtx = b.currentSelfContext();
const senseIdx = selfCtx.indexOf('【内态感知】');
check('④ 内态感知已注入自我上下文', senseIdx >= 0);
const senseSection = senseIdx >= 0 ? selfCtx.slice(senseIdx) : '';
check('④ 内态感知零数字标量（数字不可知红线）', !/\d/.test(senseSection), JSON.stringify(senseSection));
check('④ 内态感知无研究标签/研究术语',
  !/JUVENILE|DEVELOPMENTAL|STABILIZED|canalization|plasticity|渠化|沟壑/i.test(senseSection));
check('④ 内态感知只用定性词', /敏锐波动中|趋于平稳沉静/.test(senseSection));

/* ---------- 方向①：认识论分层（碎片防伪 + 位置不变式） ---------- */
const { Memory } = require('../src/memory');
const m = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-mem-')), { windowTurns: 999 });
m.persona = '人格文本';
m.wardrobe = '【当前穿着】\n- 外套：落肩白色外套';
const sysNoFrag = m.systemText();
check('① 无碎片时零注入（向下兼容）', !sysNoFrag.includes('【离线重组碎片】'));
m.data.dreamFragments = ['碎片甲', '碎片乙'];
const sysFrag = m.systemText();
check('① 碎片块带防伪标签（非亲历、不得当亲历引用）',
  sysFrag.includes('【离线重组碎片】') && sysFrag.includes('非亲历') && sysFrag.includes('不得当作亲历引用'));
check('① 碎片块位于穿着块之前、穿着块仍是 system 结尾',
  sysFrag.indexOf('【离线重组碎片】') < sysFrag.indexOf('【当前穿着】') && sysFrag.endsWith('外套：落肩白色外套'));

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
