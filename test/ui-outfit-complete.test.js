/* test/ui-outfit-complete.test.js
 * 配件智能成套门禁（v1.0 UX-02a）：
 * 家族策展表完整性（对照真实 CATALOG）、补齐主行为、dress↔top/bottom 互斥铁律、
 * off_ 先行有序性、身份层永不入计划、已成套零噪声、防御、
 * 双环境守卫 + 边界铁律（不读 tags、不碰 src/、无写口）。
 */
const fs = require('fs');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { FAMILIES, BASIC_SLOTS, familyOf, completeOutfit, planOutfit } = require(path.join(__dirname, '..', 'ui-outfit-complete.js'));
const { CATALOG } = require(path.join(__dirname, '..', 'src', 'wardrobe.js'));

check('1 familyOf 命中与未知回 null（共享条目 black_boots_01 归首家族锚）',
  familyOf('gothic_black_01') === 'gothic' && familyOf('gray_tee_01') === 'casual'
  && familyOf('black_boots_01') === 'default' && familyOf('nope') === null && familyOf(null) === null);
check('2 FAMILIES 全部 ID 存在于真实 CATALOG 且槽位吻合', (() => {
  return Object.values(FAMILIES).every(set =>
    Object.entries(set).every(([slot, id]) => CATALOG[id] && CATALOG[id].slot === slot));
})());
check('3 补齐主行为：以 gray_tee_01 为锚补齐下装与鞋', (() => {
  const d = completeOutfit({ hair: 'silver_wavy_01', top: 'gray_tee_01' }, CATALOG, 'gray_tee_01');
  return d && d.bottom === 'sport_shorts_01' && d.shoes === 'white_sneakers_01';
})());
check('4 互斥铁律：连衣裙家族计划永不同时含 dress 与 top/bottom', (() => {
  const d = completeOutfit({ top: 'lace_corset_01', bottom: 'black_shorts_01' }, CATALOG, 'gothic_black_01');
  return d && d.dress === 'gothic_black_01' && d.top === null && d.bottom === null;
})());
check('5 有序性：off_ 摘除全部排在上装操作之前', (() => {
  const cur = { dress: 'gothic_black_01', top: null, bottom: null };
  const d = completeOutfit(cur, CATALOG, 'lace_corset_01');
  const plan = planOutfit(cur, d);
  const firstOn = plan.findIndex(p => !p.itemId.startsWith('off_'));
  const lastOff = plan.map(p => p.itemId.startsWith('off_')).lastIndexOf(true);
  return firstOn === -1 || lastOff < firstOn;
})());
check('6 身份层永不入计划（hair / hairAccessory / accessory 零触碰）',
  BASIC_SLOTS.every(s => s !== 'hair' && s !== 'hairAccessory' && s !== 'accessory')
  && planOutfit({ hair: 'silver_wavy_01' }, { hair: null, top: 'gray_tee_01' })
       .every(p => p.slot !== 'hair'));
check('7 已成套 → 空计划（无噪声不打扰）', (() => {
  const cur = { top: 'gray_tee_01', bottom: 'sport_shorts_01', shoes: 'white_sneakers_01', dress: null };
  const d = completeOutfit(cur, CATALOG, 'gray_tee_01');
  return planOutfit(cur, d).length === 0;
})());
check('8 双环境守卫 + 边界铁律：不读 tags、不碰 src/、无写口', (() => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'ui-outfit-complete.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return code.includes('module.exports')
    && !/require\(['"]electron['"]\)/.test(code)
    && !/\.tags/.test(code)
    && !/src\//.test(code)
    && !/\.append\(|\.save\(|writeJson|splice\(/.test(code);
})());
check('9 防御：缺失 catalog / 未知锚 → null / 空计划不崩',
  completeOutfit({ top: 'x' }, null, 'gray_tee_01') === null
  && completeOutfit({ top: 'x' }, CATALOG, 'unknown_item') === null
  && planOutfit(null, null).length === 0);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
