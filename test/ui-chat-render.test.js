/* test/ui-chat-render.test.js
 * 气泡流纯函数决策层门禁（v1.0 笔 3a）：
 * 气泡分流、synthetic 契约（note 剥前缀 / hide 跳过）、零伪造时间戳、
 * 标记遮蔽（完整 + 流式半截容错）、bridge 透传、双环境守卫、单份正则防漂移。
 */
const fs = require('fs');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { MARK_RE, setMarkContext, stripState, decideBubble, bubbleView, shouldStickToBottom, dividerNeeded, CARD_DEFAULT, clampCardBox } = require(path.join(__dirname, '..', 'ui-chat-render.js'));
setMarkContext({
  STATES: ['idle', 'happy'],
  knownWear: new Set(['gray_tee_01', 'gothic_black_01']),
  wearCandidates: ['wear:gray_tee_01', 'wear:gothic_black_01']
});

check('1 user / assistant 气泡分流正确',
  decideBubble({ role: 'user', content: '你好', t: 1 }, 'note').kind === 'user'
  && decideBubble({ role: 'assistant', content: '嗯', t: 1 }, 'note').kind === 'assistant');
check('2 synthetic + note → 剥前缀居中注记（绝不冒充用户）', (() => {
  const d = decideBubble({ role: 'user', synthetic: true, content: '[自主感知触发]：用户戳了你', t: 1 }, 'note');
  return d.kind === 'note' && d.text === '用户戳了你';
})());
check('3 synthetic + hide → skip', decideBubble({ role: 'user', synthetic: true, content: '[自主感知触发]：x', t: 1 }, 'hide').kind === 'skip');
check('4 零伪造时间戳：t 缺失 → undefined、真实值原样',
  decideBubble({ role: 'user', content: 'x', t: null }, 'note').at === undefined
  && decideBubble({ role: 'user', content: 'x', t: 123 }, 'note').at === 123);
check('5 标记遮蔽：完整标记剥除、流式半截仅在吐字时藏', (() => {
  const full = decideBubble({ role: 'assistant', content: '你好[state:happy][wear:gray_tee_01]', t: 1 }, 'note');
  return full.text === '你好'
    && stripState('你好[state:ha', true) === '你好'
    && stripState('你好[state:ha', false) === '你好[state:ha';
})());
check('6 bridge 标记透传（窗口分界由上层渲染）',
  decideBubble({ role: 'user', content: 'x', t: 1, bridge: true }, 'note').bridge === true
  && decideBubble({ role: 'user', content: 'x', t: 1 }, 'note').bridge === false);
check('7 双环境守卫 + 边界铁律：Node 可 require、不依赖 electron、无写口', (() => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'ui-chat-render.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return code.includes('module.exports')
    && !/require\(['"]electron['"]\)/.test(code)
    && !/\.append\(|\.save\(|writeJson|splice\(/.test(code);
})());
check('8 单份遮蔽正则防漂移：pet.js 只引用导出、不自带第二份 MARK_RE', (() => {
  const pet = fs.readFileSync(path.join(__dirname, '..', 'pet.js'), 'utf8');
  return !/MARK_RE\s*=/.test(pet) && /setMarkContext\(/.test(pet) && /stripState\(/.test(pet)
    && Object.keys(MARK_RE).length === 2;
})());

/* ---------- 3b-b: 视图映射与贴底判定 ---------- */
check('9 bubbleView 类名与头像映射（user 你 / assistant 初 / note 无像）',
  bubbleView({ role: 'user', content: 'x', t: 1 }, 'note').cls === 'b-user'
  && bubbleView({ role: 'user', content: 'x', t: 1 }, 'note').avatar === '你'
  && bubbleView({ role: 'assistant', content: 'x', t: 1 }, 'note').cls === 'b-ai'
  && bubbleView({ role: 'assistant', content: 'x', t: 1 }, 'note').avatar === '初'
  && bubbleView({ role: 'user', synthetic: true, content: '[自主感知触发]：x', t: 1 }, 'note').avatar === null);
check('10 bubbleView 时间严格条件渲染（t 缺 → ts null，省略 DOM）',
  bubbleView({ role: 'user', content: 'x', t: null }, 'note').ts === null
  && bubbleView({ role: 'user', content: 'x', t: 456 }, 'note').ts === 456);
check('11 shouldStickToBottom 容差边界（贴底跟随 / 上翻暂停）',
  shouldStickToBottom(100, 1000, 860) === true
  && shouldStickToBottom(100, 1000, 860, 40) === true
  && shouldStickToBottom(0, 1000, 860) === false);
check('12 dividerNeeded 窗口分界时机（bridge→非 bridge 处且仅此）',
  dividerNeeded({ bridge: true }, { bridge: false }) === true
  && dividerNeeded({ bridge: false }, { bridge: false }) === false
  && dividerNeeded(null, { bridge: false }) === false);

/* ---------- 笔 4: 伴随卡片几何与记忆契约 ---------- */
check('13 clampCardBox 垂直下限钳制（dyFromBottom 100 → 336，交互不变式）',
  clampCardBox({ dx: 6, dyFromBottom: 100 }, 380).dyFromBottom === 336);
check('14 clampCardBox 水平两端钳制（越左 / 越右 / 卡宽外）',
  clampCardBox({ dx: -50, dyFromBottom: 400 }, 380, 340).dx === 6
  && clampCardBox({ dx: 999, dyFromBottom: 400 }, 380, 340).dx === 34);
check('15 clampCardBox 合法位置原样通过', (() => {
  const p = clampCardBox({ dx: 20, dyFromBottom: 350 }, 380, 340);
  return p.dx === 20 && p.dyFromBottom === 350;
})());
check('16 clampCardBox 非法输入回 CARD_DEFAULT（NaN / 缺键）', (() => {
  const a = clampCardBox({ dx: NaN, dyFromBottom: 350 }, 380);
  const b = clampCardBox(null, 380);
  return a.dx === CARD_DEFAULT.dx && a.dyFromBottom === CARD_DEFAULT.dyFromBottom
    && b.dx === CARD_DEFAULT.dx && b.dyFromBottom === CARD_DEFAULT.dyFromBottom;
})());
check('17 位置记忆契约：{ dx, dyFromBottom } 两键数值', (() => {
  const p = clampCardBox({ dx: 12, dyFromBottom: 340 }, 380);
  return Object.keys(p).sort().join(',') === 'dx,dyFromBottom'
    && Number.isFinite(p.dx) && Number.isFinite(p.dyFromBottom);
})());

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
