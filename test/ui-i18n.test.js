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

const { I18N, t, formatDisplayTime, UI_LOCALE, UI_TIMEZONE } = require(path.join(__dirname, '..', 'ui-i18n.js'));

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

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
