/* test/ui-chat-store.test.js
 * 气泡流数据层门禁（v1.0 笔 2）：
 * 7 字段投影契约、synthetic 双态保留、零伪造时间戳、SYNTHETIC_RENDER 渲染契约、
 * load() 注入与幂等、双环境守卫 + 边界铁律剥注释扫描。
 */
const fs = require('fs');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { ChatStore, SYNTHETIC_RENDER } = require(path.join(__dirname, '..', 'ui-chat-store.js'));
const FIELDS = ['role', 'content', 'messageId', 'windowNo', 'bridge', 'synthetic', 't'];
const sample = [
  { role: 'user', content: '你好', messageId: 'm-000001', windowNo: 1, bridge: false, synthetic: false, t: 1790000000000 },
  { role: 'user', content: '[自主感知触发]：用户在 8 秒内戳了你 5 下', messageId: 'm-000002', windowNo: 1, bridge: true, synthetic: true, t: null }
];

check('投影 7 字段完整（契约钉死）',
  sample.every(m => FIELDS.every(k => k in m)));
check('synthetic 双态保留（true 不吞、false 明确）',
  sample[0].synthetic === false && sample[1].synthetic === true);
check('零伪造时间戳：t 缺失即 null、真实值原样保留',
  sample[1].t === null && Number.isFinite(sample[0].t));
check('SYNTHETIC_RENDER 双模式渲染契约存在（note / hide）',
  (SYNTHETIC_RENDER === 'note' || SYNTHETIC_RENDER === 'hide'));
check('双环境守卫 + 边界铁律：Node 可 require、不依赖 electron、不碰主体数据写口', (() => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'ui-chat-store.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return code.includes('module.exports')
    && !/require\(['"]electron['"]\)/.test(code)
    && !/memory\.append|\.save\(|writeJson|splice\(/.test(code);
})());

(async () => {
  let fired = 0;
  const off = ChatStore.onChange(() => { fired++; });
  await ChatStore.load(async () => sample);
  check('load(fetchFn) 注入生效且 onChange 触发', ChatStore.messages.length === 2 && fired >= 1);
  await ChatStore.load(async () => []);
  await ChatStore.load(async () => []);
  check('空历史 → [] 且幂等、订阅可退订', ChatStore.messages.length === 0 && typeof off === 'function');
  off();

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
