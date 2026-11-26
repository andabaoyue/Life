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

check('10 P0-6 结构守卫：wdAnchor / wdPendingPlan 与 #wdSuggestBtn 监听绑定均位于 refreshWardrobe 外部模块作用域', (() => {
  const petSrc = fs.readFileSync(path.join(__dirname, '..', 'ui-wardrobe.js'), 'utf8');
  const idxFn = petSrc.indexOf('async function refreshWardrobe()');
  const idxAnchor = petSrc.indexOf('let wdAnchor = null;');
  const idxPlan = petSrc.indexOf('let wdPendingPlan = [];');
  const idxBind = petSrc.indexOf("if (wdSuggestBtn) wdSuggestBtn.addEventListener('click'");
  const fnBodyStart = idxFn;
  const fnBodyEnd = petSrc.indexOf('function toggleWardrobe(', fnBodyStart);
  const fnBody = petSrc.slice(fnBodyStart, fnBodyEnd);
  return idxFn > 0 && idxAnchor > 0 && idxPlan > 0 && idxBind > 0
    && idxAnchor < idxFn && idxPlan < idxFn && idxBind < idxFn
    && !/let\s+wdAnchor\s*=/.test(fnBody)
    && !/wdSuggestBtn\.addEventListener/.test(fnBody);
})());

check('11 P0-6 行为模拟：连续刷新衣橱不叠加 #wdSuggestBtn 监听器且点击单品后锚点保留触发单次建议', (() => {
  const petSrc = fs.readFileSync(path.join(__dirname, '..', 'ui-wardrobe.js'), 'utf8');
  const m = petSrc.match(/\/\* -{10} 智能成套建议[\s\S]*?(?=\n\s*async function refreshWardrobe\(\))/);
  if (!m) return false;
  let btnClicks = 0;
  let wardrobeSetCalls = 0;
  const suggestEl = { classList: { _s: new Set(['hidden']), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } } };
  const textEl = { textContent: '' };
  const btnEl = {
    textContent: '',
    handlers: [],
    addEventListener(ev, fn) { if (ev === 'click') this.handlers.push(fn); }
  };
  const hintEl = { textContent: '' };
  const sandbox = {
    document: {
      getElementById(id) {
        if (id === 'wdSuggest') return suggestEl;
        if (id === 'wdSuggestText') return textEl;
        if (id === 'wdSuggestBtn') return btnEl;
        if (id === 'wdHint') return hintEl;
        return null;
      }
    },
    api: { wardrobeSet: async () => { wardrobeSetCalls++; return { ok: true }; } },
    t: (_k, fb) => fb || _k,
    completeOutfit,
    planOutfit,
    refreshWardrobe: () => { sandbox.updateOutfitSuggest(sandbox._cat); },
    _cat: {
      equip: { hair: 'silver_wavy_01', top: 'gray_tee_01', bottom: null, shoes: null, dress: null },
      items: {
        top: [{ id: 'gray_tee_01', name: '灰T' }],
        bottom: [{ id: 'sport_shorts_01', name: '运动短裤' }],
        shoes: [{ id: 'white_sneakers_01', name: '白运动鞋' }]
      }
    }
  };
  const vm = require('vm');
  vm.runInNewContext(m[0] + '; this.updateOutfitSuggest = updateOutfitSuggest; this.setAnchor = (v) => { wdAnchor = v; }; this.getAnchor = () => wdAnchor;', sandbox);
  sandbox.setAnchor('gray_tee_01');
  sandbox.refreshWardrobe();
  sandbox.refreshWardrobe();
  sandbox.refreshWardrobe();
  const shown = !suggestEl.classList._s.has('hidden') && sandbox.getAnchor() === 'gray_tee_01';
  for (const h of btnEl.handlers) btnClicks++, h();
  return shown && btnEl.handlers.length === 1 && btnClicks === 1;
})());

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
