/* test/ui-i18n.test.js
 * 渲染层文案与时间基座门禁（v1.0 笔 1 / UX-05 前置约束）：
 * t() 命中与回退、语言表键集一致（双语结构先行）、formatDisplayTime 本地化与防御、
 * 双环境守卫 + 边界铁律机械执行（不依赖 electron、不碰 src/）。
 */
const fs = require('fs');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { I18N, t, setLocale, getTimezone, getTimezoneLabel, getTimezoneStatus, formatDisplayTime } = require(path.join(__dirname, '..', 'ui-i18n.js'));

check('t() 命中已知键、未知键回退 fallback / 原键',
  t('chat.title') === '对话' && t('nope.key', '备用') === '备用' && t('nope.key') === 'nope.key');
check('语言表键集完全一致（双语结构先行，现 zh-CN 单表）', (() => {
  const sets = Object.values(I18N).map(o => Object.keys(o).sort().join(','));
  return sets.length > 0 && sets.every(s => s === sets[0]);
})());
check('formatDisplayTime 有效时间戳输出非空字符串',
  typeof formatDisplayTime(Date.now()) === 'string' && formatDisplayTime(Date.now()).length > 0);
check('非法输入安全返回空串（NaN / undefined / 字符串）',
  formatDisplayTime(NaN) === '' && formatDisplayTime(undefined) === '' && formatDisplayTime('x') === '');
check('时间输出本地化且无 UTC Z 尾缀（F-099 时钟教训）', (() => {
  const s = formatDisplayTime(Date.now());
  return !/Z$/.test(s) && /\d/.test(s);
})());
check('双环境守卫 + 边界铁律：Node 可 require、不依赖 electron、不碰 src/', (() => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'ui-i18n.js'), 'utf8');
  // 只看逻辑代码：剥离注释再检索（注释里解释「不进 src/」的字样不算越界）
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return code.includes('module.exports')
    && !/require\(['"]electron['"]\)/.test(code) && !/src\//.test(code);
})());

/* ---------- 笔 6: UX-05 双语与创世时区锁定 ---------- */
check('7 en 与 zh-CN 键集 100% 对称（双语契约）', (() => {
  const zh = Object.keys(I18N['zh-CN']).sort().join(',');
  const en = Object.keys(I18N['en']).sort().join(',');
  return zh === en && zh.length > 0;
})());
check('8 getTimezone 返回可用时区（合法即锚定，非法回退机器本地）', (() => {
  const z = getTimezone();
  if (z === null) return true;
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch (e) { return false; }
})());
check('9 时区创世锁定不可逆（已锚定值优先于机器时区）', (() => {
  const store = {
    _v: { genesisTimezone: 'Asia/Tokyo' },
    getItem(k) { return (k in this._v) ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = v; },
    removeItem(k) { delete this._v[k]; }
  };
  const had = ('localStorage' in globalThis) ? globalThis.localStorage : undefined;
  globalThis.localStorage = store;
  const z = getTimezone();
  if (had === undefined) { delete globalThis.localStorage; } else { globalThis.localStorage = had; }
  return z === 'Asia/Tokyo';
})());
check('10 setLocale 双语切流（en 生效、zh-CN 回切）', (() => {
  const zhTitle = t('chat.title');
  setLocale('en');
  const enTitle = t('chat.title');
  const enApprove = t('agent.action.approve');
  setLocale('zh-CN');
  return zhTitle !== enTitle && enTitle === 'Chat' && enApprove === 'Approve' && t('chat.title') === zhTitle;
})());
check('11 getTimezoneStatus 锁定契约（locked 恒真 + 标签含 UTC）', (() => {
  const s = getTimezoneStatus();
  return s.locked === true && getTimezoneLabel().includes('UTC');
})());
check('12 全量防漂移门禁：全量 en 字典零中文残留、t() 插值契约与 DOM 中文硬编码零残留审计', (() => {
  // 1. 全量字典审计：en 模式下所有已登记词条（390+ 键）严格零中文残留（非抽样）
  setLocale('en');
  const enAllKeys = Object.keys(I18N['en']);
  const enAllClean = enAllKeys.every(k => {
    const val = t(k);
    return typeof val === 'string' && !/[\u4e00-\u9fa5]/.test(val);
  });
  const interpEn = t('research.snapshot.status', { time: '12:00:00' });
  setLocale('zh-CN');

  // 2. t() 轻量插值引擎契约验证
  const interpZh = t('research.prov.scTitle', { id: 'sc-1', win: 2, trait: 'vitality', prev: 10, newVal: 20, delta: 10 });
  const interpOk = interpEn.includes('12:00:00') && interpEn.includes('Snapshot:') && interpZh.includes('Window #2') && interpZh.includes('sc-1');

  // 3. 静态源码全量 DOM 审计：pet.js 中直接把中文赋给 DOM 文本属性且无 t() 保护的语句严格为 0
  const petCode = fs.readFileSync(path.join(__dirname, '..', 'pet.js'), 'utf8');
  const hardcodedDom = petCode.split('\n').filter(l =>
    /\.(textContent|innerHTML|placeholder|title)\s*=/.test(l) &&
    /[\u4e00-\u9fa5]/.test(l) && !/\bt\(/.test(l)
  );

  // 4. 关键动态接线与特质闭环模式审查（衣橱/特质/梦境/研究面板/生命看板/台词）
  const wiredInPet = ['rDreamsTitle', 'rStateTitle', 'rReplayTitle', 'rExportTitle', 'rTraceBtn', 'acLabelScope'].every(id => {
    return petCode.includes(`setText('${id}'`) || petCode.includes(`setText("${id}"`);
  });
  const dynamicWired = [
    "t('wardrobe.item.' + id",
    "t('wardrobe.preset.' + pid",
    "t('wardrobe.slot.' + slot.id",
    "t('wardrobe.item.' + it.id",
    "t('trait.' + tName",
    "t('research.snapshot.status'",
    "t('research.windows.noArchiveData'",
    "t('research.prov.scTitle'",
    "t('research.replay.fuseBlown'",
    "t('say.reacquaint'",
    "t('say.pinOn'",
    "t('dreams.count'",
    "t('research.lexicon.empty'",
    // ⚠️ 2026-10-27：原列了 t('research.vitals.line1' —— 该区块已随排版整改删除
    //   （生理潮汐与机制遥测的 vitals.core 逐字重复，只保留遥测一处）。
    //   这里换成同属遥测的新接线断言，保持"动态接线必须在用"的检查密度不降。
    "t('obs.group.' + g",
    "t('chat.needKeyBubble'"
  ].every(pattern => petCode.includes(pattern));

  return enAllClean && interpOk && hardcodedDom.length === 0 && wiredInPet && dynamicWired;
})());

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);

