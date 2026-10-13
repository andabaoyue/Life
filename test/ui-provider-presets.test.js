/* test/ui-provider-presets.test.js
 * 服务商预设与 Key 前缀识别门禁（v1.0 笔 7 / UX-01）：
 * 预设字典完整性、前缀精准命中（tp-/ttp- / mimo- / sk-）、非法输入防御、
 * 双环境守卫 + 边界铁律（无 electron、无网络调用、不碰 src/）、
 * 防漂移（预设 providerId 与 src/provider-policy.js 的 providerFor 口径一致）。
 */
const fs = require('fs');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { PRESETS, getPreset, detectProviderByKey } = require(path.join(__dirname, '..', 'ui-provider-presets.js'));

check('1 PRESETS 五预设字段完整（id/nameKey/providerId/protocol/baseURL/model）',
  ['deepseek', 'mimo', 'mimo-token-plan', 'local', 'custom'].every(id => {
    const p = PRESETS[id];
    return p && ['id', 'nameKey', 'providerId', 'protocol', 'baseURL', 'model'].every(k => k in p) && p.id === id;
  }));
check('2 tp-/ttp- 前缀命中 mimo-token-plan（high）且专属端点为 token-plan-cn.xiaomimimo.com',
  detectProviderByKey('tp-abc123').presetId === 'mimo-token-plan'
  && detectProviderByKey('ttp-abc123').confidence === 'high'
  && getPreset('mimo-token-plan').baseURL === 'https://token-plan-cn.xiaomimimo.com/v1'
  && getPreset('mimo-token-plan').baseURL !== getPreset('mimo').baseURL);
check('3 mimo- 前缀命中 mimo（high）',
  detectProviderByKey('mimo-abc123').presetId === 'mimo'
  && detectProviderByKey('mimo-abc123').confidence === 'high');
check('4 通用 sk- 前缀不误判为特定服务商（防 OpenAI/Claude/Kimi/Qwen 误套用 DeepSeek 引发 401）',
  detectProviderByKey('sk-test-0000') === null
  && detectProviderByKey('sk-proj-abc123') === null
  && detectProviderByKey('sk-ant-abc123') === null);
check('5 非法输入防御（空串 / 空白 / 无前缀 / 数字）',
  detectProviderByKey('') === null && detectProviderByKey('   ') === null
  && detectProviderByKey('abc123') === null && detectProviderByKey(12345) === null);
check('6 getPreset 命中与未知 id 回退 null',
  getPreset('deepseek').baseURL.includes('deepseek.com') && getPreset('nope') === null);
check('7 双环境守卫 + 边界铁律：无 electron、无网络调用、不碰 src/', (() => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'ui-provider-presets.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return code.includes('module.exports')
    && !/require\(['"]electron['"]\)/.test(code)
    && !/fetch\(|XMLHttpRequest|WebSocket/.test(code)
    && !/src\//.test(code)
    && !/localStorage|sessionStorage/.test(code);   // 识别结果不落盘（Key 绝不落盘）
})());
check('8 防漂移：预设 providerId 与 provider-policy.js 的 providerFor 口径一致', (() => {
  const { providerFor } = require(path.join(__dirname, '..', 'src', 'provider-policy.js'));
  return ['deepseek', 'mimo', 'mimo-token-plan', 'local'].every(id => {
    const p = PRESETS[id];
    return providerFor(p.baseURL) === p.providerId;
  });
})());

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
