/**
 * test/d14-self-relation-dims.test.js
 *
 * D-14 门禁：三个「评价性自我关系」维度 + formatPerception 分层改造。
 *
 * ## 为什么要加这三个维度（实测依据，不是理论推演）
 *
 *   翻 experiences.jsonl 里带原文引用的证据，她已表达过这三类内容，
 *   但**全部被塞进了 philosophical_curiosity 桶**（该维度因此偏高）：
 *     ① 自我连续性（对比「那时」与「现在」的我）
 *     ② 跨越时间的同一性承诺
 *     ③ 自我清晰度（说「不确定」）
 *   ⇒ 不是「她没这个维度」，是「她没有词来表达这个维度」。
 *   ⚠️ 公开分发版不引原句与计数：原句属主体经历，证据底座在研究库。
 *
 * ## 覆盖的三类反例（门禁第一铁律）
 *   ① 漏传参数：缺字段 / 非数值 / NaN —— 必须按中立处理，零抛异常
 *   ② 恶意变体：往 values 里塞未登记键 —— 不许进感知、不许被当成维度
 *   ③ 边界值：阈值 29/30、全中立、全偏离、恰好 0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SubjectState, DEFAULT_TRAITS, ALLOWED_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const NEW_DIMS = ['self_continuity', 'meaning_presence', 'self_clarity'];

console.log('--- D-14 自我关系维度门禁 ---');

/* ============ 1. 三个维度真的登记了 ============ */
{
  NEW_DIMS.forEach((k) => {
    check('白名单登记：' + k, ALLOWED_TRAITS.has(k));
    check('默认值为 0（中立未偏置，不是 undefined）',
      DEFAULT_TRAITS[k] === 0, String(DEFAULT_TRAITS[k]));
  });
  check('维度总数 = 8（原 5 + 新 3）', Object.keys(DEFAULT_TRAITS).length === 8,
    String(Object.keys(DEFAULT_TRAITS).length));
  check('❌ 反向对照：ALLOWED_TRAITS 里没有未登记的多余键',
    Object.keys(DEFAULT_TRAITS).every((k) => ALLOWED_TRAITS.has(k)));
}

/* ============ 2. 老数据自动补齐（零迁移） ============ */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd14-backfill-'));
  // 模拟「旧数据」：只写原来五个键，不含新维度
  const legacy = { windowNo: 1, values: { quiet_preference: -44, social_initiative: 86, attachment_need: 174, vitality: -28, philosophical_curiosity: 100 } };
  fs.writeFileSync(path.join(dir, 'subject-state.json'), JSON.stringify(legacy));
  const s = new SubjectState(dir, {});
  check('🔴 旧数据零迁移：新维度自动补 0',
    NEW_DIMS.every((k) => s.values[k] === 0),
    NEW_DIMS.map((k) => k + '=' + s.values[k]).join(' '));
  check('🔴 旧数据零迁移：原有五个维度的值一个都不许变',
    s.values.quiet_preference === -44 && s.values.social_initiative === 86
    && s.values.attachment_need === 174 && s.values.vitality === -28
    && s.values.philosophical_curiosity === 100);
}

/* ============ 3. formatPerception 分层契约 ============ */
{
  const p = new SubjectState(fs.mkdtempSync(path.join(os.tmpdir(), 'd14-perc-')), {});
  const boardOf = (vals) => {
    for (const k of Object.keys(p.data.values)) p.data.values[k] = 0;
    Object.assign(p.data.values, vals);
    return p.formatPerception();
  };

  check('🔴 全中立 → 只给一句「此刻各方面都平稳」（不是空列表）',
    boardOf({}) === '- 此刻各方面都平稳');
  check('🔴 有偏离但仍有中立维度 → 末尾补「其余方面平稳」',
    boardOf({ attachment_need: 100 }).includes('其余方面平稳'));
  check('🔴 全部维度都偏离 → 不出现「其余方面平稳」（那句话会撒谎）',
    !boardOf(Object.fromEntries(Object.keys(DEFAULT_TRAITS).map((k) => [k, 100]))).includes('其余方面平稳'));

  // 阈值边界（用「另一维已偏离」构造，否则走全中立分支）
  check('❌ 边界：29 不单独成行（并入概括）',
    !boardOf({ quiet_preference: 29, attachment_need: 100 }).includes('偏爱安静独处'));
  check('❌ 边界：30 单独成行（硬切换，无迟滞）',
    boardOf({ quiet_preference: 30, attachment_need: 100 }).includes('偏爱安静独处'));
  check('❌ 边界：-30 走低档文案',
    boardOf({ quiet_preference: -30, attachment_need: 100 }).includes('更想要热闹与相处'));
  check('❌ 边界：恰好 0 → 中立', !boardOf({ quiet_preference: 0, attachment_need: 100 }).includes('安静'));

  // 新增三维度必须真的能出现在输出里（防「加了但永不显示」的死维度）
  NEW_DIMS.forEach((k) => {
    const hi = boardOf({ [k]: 100 });
    const lo = boardOf({ [k]: -100 });
    check('❌ 死维度对照：' + k + ' 高值时真的出现在感知里',
      hi !== '- 此刻各方面都平稳' && hi.length > 12, hi.slice(0, 30));
    check('❌ 死维度对照：' + k + ' 低值时真的出现在感知里',
      lo !== '- 此刻各方面都平稳' && lo.length > 12, lo.slice(0, 30));
  });

  check('零数字红线：任何组合都不许出现阿拉伯数字',
    !/\d/.test(boardOf({ attachment_need: 999, self_clarity: -999, vitality: 30 })));
}

/* ============ 4. 反例①：坏值必须按中立处理 ============ */
{
  const p = new SubjectState(fs.mkdtempSync(path.join(os.tmpdir(), 'd14-bad-')), {});
  const boardOf = (vals) => {
    for (const k of Object.keys(p.data.values)) p.data.values[k] = 0;
    Object.assign(p.data.values, vals);
    return p.formatPerception();
  };
  check('❌ 反例：字符串值不抛异常、按中立', boardOf({ vitality: 'abc' }) === '- 此刻各方面都平稳');
  check('❌ 反例：NaN 不抛异常、按中立', boardOf({ self_clarity: NaN }) === '- 此刻各方面都平稳');
  check('❌ 反例：null 不抛异常、按中立', boardOf({ meaning_presence: null }) === '- 此刻各方面都平稳');
  check('❌ 反例：Infinity 不抛异常', typeof boardOf({ self_continuity: Infinity }) === 'string');
  {
    boardOf({});
    delete p.data.values.self_continuity;
    check('❌ 反例：真删字段不抛异常、按中立', p.formatPerception() === '- 此刻各方面都平稳');
  }
}

/* ============ 5. 反例②：未登记键不许进感知 ============ */
{
  const p = new SubjectState(fs.mkdtempSync(path.join(os.tmpdir(), 'd14-unreg-')), {});
  for (const k of Object.keys(p.data.values)) p.data.values[k] = 0;
  p.data.values.evil_trait = 999;
  p.data.values.self_esteem = 999;
  const out = p.formatPerception();
  check('❌ 反例：未登记键不进感知（不给任意新键开显示后门）',
    out === '- 此刻各方面都平稳', out.slice(0, 40));
}

/* ============ 6. 防漂移：提示词必须列出新维度 ============ */
{
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
  NEW_DIMS.forEach((k) => {
    check('❌ GROWTH_SYS 提示词必须列出 ' + k + '（否则她永远填不了这个桶）',
      brainSrc.includes(k));
  });
  check('❌ 提示词必须给判读口径（防与 philosophical_curiosity 再次混淆）',
    brainSrc.includes('self_continuity 自我同一'));
}

console.log('');
/* ============ 7. 🔴 UI / 聚合同步锁（2026-10 收口） ============ */
// 背景（实测）：D-14 之后，pet.js 的研究面板卡片清单与 main.js 的 life-status 认知聚合
// 仍硬编码旧 5 维 —— 新 3 维「底层有、看不见」，实验事实没有如实呈现。
// 这组断言钉死三处同源：pet.js 卡片清单 / pet.js 中文定名镜像 / main.js cognition 聚合；
// 中文定名的**单一事实源**是 subject-state.js 的 TRAIT_NAMES（她认知层在用的正典名），
// pet.js 只是展示镜像 —— 逐键断言防「两处各改各的」漂移。
{
  const petSrc = fs.readFileSync(path.join(__dirname, '..', 'pet.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const ssSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'subject-state.js'), 'utf8');
  const all8 = Object.keys(DEFAULT_TRAITS);

  check('🔴 研究面板卡片清单覆盖全部 8 维（含新 3 维）',
    all8.every((k) => petSrc.includes("'" + k + "'")),
    all8.filter((k) => !petSrc.includes("'" + k + "'")).join(',') || '8/8');
  check('❌ 反向对照：renderStateDemo mock 同步补齐（演示态也不许停在旧 5 维）',
    NEW_DIMS.every((k) => petSrc.includes(k + ': { current')),
    NEW_DIMS.map((k) => k + '=' + petSrc.includes(k + ': { current')).join(' '));
  check('🔴 life-status 认知聚合覆盖全部 8 维',
    all8.every((k) => mainSrc.includes("'" + k + "'")),
    all8.filter((k) => !mainSrc.includes("'" + k + "'")).join(',') || '8/8');

  const labelOf = (src, k) => {
    const m = src.match(new RegExp(k + ":\\s*'([^']+)'"));
    return m ? m[1] : null;
  };
  const drift = all8.filter((k) => labelOf(petSrc, k) !== labelOf(ssSrc, k));
  check('🔴 中文定名两处逐键一致（pet.js 镜像不得漂移）',
    drift.length === 0, drift.join(',') || '8/8 一致');
  check('定名映射覆盖全部 8 维（只有未知键才允许回退原键）',
    all8.every((k) => !!labelOf(petSrc, k)),
    all8.map((k) => k + '=' + labelOf(petSrc, k)).join(' '));
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
