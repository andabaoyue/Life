/**
 * 本地活动追踪器测试 —— 这一层的存在理由有两条，测试就照着钉：
 *
 * A. 「绝不假装做过任何事」：她汇报的戳数/拖数必须是真账。
 *    所以"事件还没被消费就不许丢"（哪怕早就出了 8 秒连戳窗口）是硬要求 ——
 *    双轨解耦一旦被人合并回一个数组，这里立刻红。
 * B. 前缀缓存：环境块里的数字是分钟级时效数据，只能进当轮 user 消息。
 *    本文件只管数据对不对，"不进 system"由 test/brain.test.js 钉那边。
 *
 * 时钟全部注入（构造传 now）：日期算术没有别的可靠测法，
 * 用 setTimeout 真等的测试既慢又会在 CI 上随机红。
 */
const { ActivityTracker } = require('../src/tracker');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 可拨时钟：advance(n) 让所有 tracker 看到的时间往前走 n 毫秒
function makeTracker(opts = {}) {
  let t = opts.start ?? 1000000;
  const tk = new ActivityTracker({ ...opts, now: () => t });
  tk.__advance = (ms) => { t += ms; return t; };
  return tk;
}

/* ============ 1. 双轨解耦：快速老化 ≠ 消费完毕 ============ */
let tr = makeTracker();
tr.record('click');
tr.__advance(10000);            // 过了 10 秒：出了 8 秒连戳窗口，但没到 60 秒
check('出了 8 秒窗口就不再算连戳（触发判定那条轨老化快）', tr.recentClicks(8000) === 0,
  'recent=' + tr.recentClicks(8000));
let snap = tr.snapshot();
check('同一个 click 仍未消费：snapshot 照样如实报 1 次',
  snap.clicks === 1 && snap.drags === 0, JSON.stringify([snap.clicks, snap.drags]));
check('被戳 1 次会写进环境块（她答得出来，不用猜）',
  /被戳 1 次/.test(snap.promptText), JSON.stringify(snap.promptText));
tr.commit(snap.throughSeq);
check('commit 之后同一批不再重复汇报（否则她会数两遍）',
  tr.snapshot().clicks === 0);

/* 双轨如果合并成一个数组，第一条断言就会红 —— 这里把它写成显式判据 */
tr = makeTracker();
tr.record('click');             // t0
tr.__advance(30000);
tr.record('click');             // t0+30s
tr.__advance(30000);
tr.record('click');             // t0+60s
const aged = tr.snapshot();
check('隔 30 秒的三下：连戳判定只数最近这一下（窗口只有 8 秒）',
  tr.recentClicks(8000) === 1, 'recent=' + tr.recentClicks(8000));
check('但汇报口径仍是 3 次（一条都没丢）', aged.clicks === 3, 'clicks=' + aged.clicks);
check('水位线取的是快照那一刻的 seq（之后的新事件不该被这次 commit 划掉）',
  aged.throughSeq === tr.seq);
tr.record('drag');
tr.commit(aged.throughSeq);
check('快照之后新发生的事件仍然待汇报', tr.snapshot().drags === 1,
  JSON.stringify(tr.snapshot()));

/* ============ 2. 未消费的绝不因时间丢弃 ============ */
tr = makeTracker();
tr.record('click');
tr.__advance(10 * 60000);       // 10 分钟不对话
snap = tr.snapshot();
check('久未对话时旧事件依旧在报（没 commit 就没消费）', snap.clicks === 1,
  'clicks=' + snap.clicks);
check('静默分钟数按最后互动算，不按事件时间算', snap.idleMin >= 10, 'idleMin=' + snap.idleMin);

/* 无界增长要有顶。注意它是"高水位触发"的软顶（攒到 cap 才截回 keep），
   不是每条都裁 —— 所以断言写成区间，而不是钉死一个数。 */
tr = makeTracker({ eventCap: 200, eventKeep: 150 });
for (let i = 0; i < 300; i++) tr.record('click');
check('事件流水被封顶在 200 以内（长时间不对话也不会吃满内存）',
  tr.events.length <= 200 && tr.events.length >= 150, 'len=' + tr.events.length);
snap = tr.snapshot();
check('被挤掉未消费的事件后，计数改口成"至少"（不假装精确）',
  snap.lowerBound === true && /被戳 至少 \d+ 次/.test(snap.promptText),
  JSON.stringify(snap.promptText));
check('软顶确实会丢东西（不然上面那条断言是空转）',
  snap.clicks < 300, 'clicks=' + snap.clicks);
tr.commit(snap.throughSeq);
snap = tr.snapshot();
check('消费完之后恢复精确口径（新攒的都在数组里）',
  snap.lowerBound === false && !/至少/.test(snap.promptText) && snap.clicks === 0,
  JSON.stringify(snap));
tr.__advance(2 * 60000);
tr.record('click');
check('已提交且过了 1 分钟的才会被清（水位线 + 时间双条件）',
  tr.events.length < 151, 'len=' + tr.events.length);
tr = makeTracker({ eventCap: 5, eventKeep: 3 });
for (let i = 0; i < 5; i++) tr.record('click');
tr.commit(5);                    // 前 5 条都已经汇报过
tr.record('click');              // 第 6 条把流水顶到 6 > cap，截掉最旧的 3 条
snap = tr.snapshot();
check('只挤掉"已汇报过"的事件时不虚报"至少"（截断本身不等于丢数据）',
  snap.lowerBound === false && snap.clicks === 1 && tr.events.length === 3,
  JSON.stringify([snap.clicks, snap.lowerBound, tr.events.length]));

/* 非法类型不许记账，也不许推进 seq */
tr = makeTracker();
const seq0 = tr.seq;
check('未知活动类型被拒（渲染端拼错字符串不会污染遥测）',
  tr.record('telepathy') === seq0 && tr.events.length === 0);

/* ============ 3. 睡眠：幂等 + 唤醒 TTL ============ */
tr = makeTracker();
check('第一次 enterSleepMode 生效', tr.enterSleepMode() === true);
const sleepAt = tr.sleepStartTime;
tr.__advance(60000);
check('重复道晚安不重置睡眠起点（否则永远是"刚睡着"）',
  tr.enterSleepMode() === false && tr.sleepStartTime === sleepAt,
  'start=' + tr.sleepStartTime + ' vs ' + sleepAt);
const s1 = tr.snapshot();
check('晚安中的环境块如实报"已睡约 X 小时"', /晚安中/.test(s1.promptText)
  && /已睡约 0\.0 小时/.test(s1.promptText), JSON.stringify(s1.promptText));

check('wakeUp 返回是否真的叫醒了', tr.wakeUp() === true && tr.wakeUp() === false);
check('醒来带 wokenDurationHours（她说"睡了很久"得有依据）',
  tr.wokenDurationHours === 0.0 && tr.justWokenUp === true);
const w0 = tr.snapshot();
check('刚醒时环境块走"刚被叫醒"分支', /刚被叫醒/.test(w0.promptText) && w0.justWokenUp === true,
  JSON.stringify(w0.promptText));
tr.__advance(11 * 60000);       // 超过 10 分钟 TTL
const w1 = tr.snapshot();
check('唤醒标记 10 分钟后自动过期（不然她一整天都在"刚醒"）',
  w1.justWokenUp === false && !/刚被叫醒/.test(w1.promptText), JSON.stringify(w1.promptText));

/* commit 也会清掉唤醒标记：那句话说过了就不该再说第二遍 */
tr = makeTracker();
tr.enterSleepMode(); tr.wakeUp();
tr.commit(tr.snapshot().throughSeq);
check('一次正常对话消费掉唤醒上下文', tr.justWokenUp === false);

/* ============ 4. 谁才算"互动"：只有用户那边的动作才算 ============ */
tr = makeTracker();
tr.__advance(5 * 60000);
const idleA = tr.snapshot().idleMin;
/* 自主活动不许刷新活跃时间，否则挂机判定永远不成立、她会在你不在时自言自语烧钱。
   现在这条只能从**反面**钉：除了下面三样，没有任何东西能动 lastInteractionAt，
   而且环境块里不许出现没有代码支撑的"姿态"一行（走动没实现，报了就是编造）。 */
check('时间往前走之外没有任何事发生时，静默如实增长', idleA === 5, 'idle=' + idleA);
check('环境块里没有"当前姿态"这一行（走动未实现，不许报一个没人改的数）',
  !/姿态/.test(tr.snapshot().promptText), JSON.stringify(tr.snapshot().promptText));
tr.recordUserInput('在吗');
check('用户说话把静默清零', tr.snapshot().idleMin === 0);
tr = makeTracker();
tr.__advance(3 * 60000);
tr.record('click');
check('被戳也算互动', tr.snapshot().idleMin === 0);
tr = makeTracker();
tr.__advance(3 * 60000);
tr.commit(tr.snapshot().throughSeq);
check('commit 刷新 lastConversationAt（说完话重新开始计静默）',
  tr.snapshot().idleMin === 0);

/* ============ 5. 晚安意图：两个方向都会痛 ============ */
const yes = ['晚安', '我先睡了', '去睡啦', '躺了', '下线了', '先不聊了'];
const no = ['你困了吗', '我要是睡了怎么办', '睡了会死吗', '晚安是什么意思？',
            '他在呢', '这是什么', '睡神是谁'];
check('道晚安的说法全部识别', yes.every(t => ActivityTracker.isSleepIntent(t)),
  yes.filter(t => !ActivityTracker.isSleepIntent(t)).join(','));
check('带疑问语气的一律不算晚安（问"你困了吗"不能把她按睡着）',
  no.every(t => ActivityTracker.isSleepIntent(t) === false),
  no.filter(t => ActivityTracker.isSleepIntent(t)).join(','));
check('陈述句里没有疑问词才算晚安（两种误判的方向都有用例）',
  ActivityTracker.isSleepIntent('我睡了') === true
  && ActivityTracker.isSleepIntent('我睡了吗') === false);

tr = makeTracker();
tr.enterSleepMode();
check('道晚安时 recordUserInput 返回意图并且不叫醒',
  tr.recordUserInput('晚安') === true && tr.sleepMode === true);
check('晚安之后她自己打出 sleepy 也不会被"叫醒"', tr.enterSleepMode() === false);
tr = makeTracker();
tr.enterSleepMode();
check('v2.0 枕边信箱：睡着后说话不再吵醒（消息留置在侧，醒不醒归她）',
  tr.recordUserInput('在吗') === false && tr.sleepMode === true && tr.justWokenUp === false);
tr = makeTracker();
tr.enterSleepMode();
tr.record('click');
check('v2.0 摇晃唤醒：轻碰 1 下不醒，短时连击 5 下才摇醒（零台词）',
  (() => {
    const lightStill = tr.sleepMode === true;
    for (let i = 0; i < 4; i++) tr.record('click');
    return lightStill && tr.sleepMode === false && tr.justWokenUp === true;
  })());

/* v1.0 睡相安放容错三根钉（物理尺度判据，无时间窗） */
tr = makeTracker(); tr.enterSleepMode();
tr.record('drag', undefined, { distance: 30 });
check('睡眠安放容错：单次小位移 (< 80px) 保持沉睡不惊醒', tr.sleepMode === true && tr.justWokenUp === false);
tr.record('drag', undefined, { distance: 120 });
check('睡眠大位移摇晃：位移 (>= 80px) 触发摇晃唤醒', tr.sleepMode === false && tr.justWokenUp === true);
tr = makeTracker(); tr.enterSleepMode();
tr.record('drag');
check('睡眠拖拽缺省位移：fail-safe 视作摇晃唤醒（向下兼容旧调用）', tr.sleepMode === false && tr.justWokenUp === true);

/* v2.0 通路 B：生理昏睡极限（纯物理断电）——疲惫 95 + 安静 5 分钟才成立 */
check('通路 B 生理昏睡：疲惫 >= 95 且安静 >= 5 分钟才断电（防误断电）',
  ActivityTracker.isPhysiologicalCollapse(95, Date.now() - 6 * 60 * 1000) === true
  && ActivityTracker.isPhysiologicalCollapse(94, Date.now() - 60 * 60 * 1000) === false
  && ActivityTracker.isPhysiologicalCollapse(99, Date.now() - 60 * 1000) === false);

/* 睡眠状态要能真的从对话链路里成立：brain 用返回值决定进不进睡眠 */
tr = makeTracker();
check('recordUserInput 的返回值就是"是否晚安意图"这一个比特',
  tr.recordUserInput('先不聊了') === true && tr.recordUserInput('好的') === false);

/* ============ 6. 环境块内容：只说真话，且带"以它为准" ============ */
tr = makeTracker();
tr.record('click'); tr.record('click'); tr.record('drag');
snap = tr.snapshot();
check('环境块标题写明是程序真实记录',
  /【当前环境感知】/.test(snap.promptText) && /真实记录/.test(snap.promptText));
check('戳与拖分别计数（混成一个数她就没法如实回答）',
  /被戳 2 次/.test(snap.promptText) && /被拖动 1 次/.test(snap.promptText),
  JSON.stringify(snap.promptText));
check('没有任何物理互动时不硬凑一行（没发生就不写）',
  !/物理互动/.test(makeTracker().snapshot().promptText));
check('环境块只列程序真有的东西（戳/拖/静默/睡眠），不夹带未实现的能力',
  !/姿态|走动|天气|屏幕内容/.test(snap.promptText), JSON.stringify(snap.promptText));

tr = makeTracker();
for (let i = 0; i < 9; i++) tr.record('click');
check('v1.0.7 未达 10 次连戳时不附带节奏急促标注（9 次正常汇报）',
  /被戳 9 次，被拖动 0 次/.test(tr.snapshot().promptText));
tr.record('click');
check('v1.0.7 累计未消费戳击 >= 10 次时附带动作密集急促定性标注',
  /被戳 10 次（动作密集急促，节奏有些被打乱），被拖动 0 次/.test(tr.snapshot().promptText));

console.log('\n' + (failures ? failures + ' 项失败' : 'tracker 层测试全部通过'));
process.exit(failures ? 1 : 0);
