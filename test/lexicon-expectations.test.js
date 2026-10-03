/* test/lexicon-expectations.test.js
 * v1.0 生命机制门槛（§4.7 #3 词汇表 + #4 预期与意外）——第一笔：Schema + 入库口 + 铁律单测。
 * 钉死：零先验空白、messageId 引证强校验、v1 只收自创（adopted 仅占位）、
 * 状态流转枚举、FIFO 上限、只淡化不删除（D-005）、防工具化红线（零定时器）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const { Memory } = require(path.join(__dirname, '..', 'src', 'memory'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-exp-'));
const m = new Memory(dir);

// 造两条真实消息，拿到可解析的 messageId
m.append('user', '市里就是「是的」的意思');
m.append('assistant', '记下了，我管这种认同叫「市里」');
const idUser = m.data.history[0].messageId;
const idAsst = m.data.history[1].messageId;

// 1 零先验：新档案两表皆空（传记空白原则）
check('1 零先验：新档案 lexicon/expectations 皆为空表',
  Array.isArray(m.data.lexicon) && m.data.lexicon.length === 0
  && Array.isArray(m.data.expectations) && m.data.expectations.length === 0);

// 2 兼容平移：旧档案缺字段 → 载入归一为空表
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-exp-old-'));
fs.writeFileSync(path.join(dir2, 'memory.json'), JSON.stringify({
  schemaVersion: 1, windows: [], history: [], turnsInWindow: 0, totalTurns: 0,
  windowNo: 1, nextMessageSeq: 0, epoch: 0
}));
const m2 = new Memory(dir2);
check('2 兼容平移：旧档案缺字段载入即空表（不崩不造）',
  Array.isArray(m2.data.lexicon) && Array.isArray(m2.data.expectations));

// 3 引证强校验：伪 messageId 拒收
check('3 词条引证强校验：伪 messageId 拒收',
  m.addLexicon({ word: '假词', kind: 'coinage', messageId: 'm-forged' }).ok === false);

// 4 正常入库 + 字段完整
const r4 = m.addLexicon({ word: '市里', kind: 'coinage', gloss: '表示认同', messageId: idAsst });
check('4 自创词入库成功且字段完整（word/kind/gloss/messageId/uses/weight/status）',
  r4.ok === true && r4.created === true
  && r4.entry.word === '市里' && r4.entry.messageId === idAsst
  && Array.isArray(r4.entry.uses) && r4.entry.weight === 1 && r4.entry.status === 'ACTIVE');

// 5 kind 枚举拒收非法
check('5 词条 kind 枚举：非法值拒收',
  m.addLexicon({ word: '乱词', kind: 'meme', messageId: idAsst }).ok === false);

// 6 adopted 占位拒收（v1 拍板：只收自创）
check('6 adopted 仅占位声明：v1 拒收（只收自创）',
  m.addLexicon({ word: '采纳词', kind: 'adopted', messageId: idAsst }).error === 'ADOPTED_NOT_YET');

// 7 词重复入库 = 复用升权不复制
const r7 = m.addLexicon({ word: '市里', kind: 'coinage', messageId: idUser });
check('7 词重复入库：升权不复制（weight 增、表长不变）',
  r7.ok === true && r7.created === false && r7.entry.weight > 1 && m.data.lexicon.length === 1);

// 8 预期引证强校验
check('8 预期引证强校验：伪 messageId 拒收',
  m.addExpectation({ kind: 'external', source: 'user', text: '假预期', messageId: 'm-forged' }).ok === false);

// 9 预期入库 + 初始 open + id 单调
const r9 = m.addExpectation({ kind: 'external', source: 'user', text: '用户说晚上会来', messageId: idUser, dueHint: '今晚' });
check('9 预期入库：id 单调、status 初始 open、outcome 为空',
  r9.ok === true && /^exp-\d{6}$/.test(r9.entry.id) && r9.entry.status === 'open' && r9.entry.outcome === null);

// 10 FIFO 上限 10
for (let i = 0; i < 12; i++) {
  m.addExpectation({ kind: 'pledge', source: 'chulan', text: '第' + i + '条', messageId: idAsst });
}
check('10 预期 FIFO 上限 10（旧的先出）',
  m.data.expectations.length === 10 && m.data.expectations[0].text === '第2条');

// 11 状态流转枚举：非法拒收
check('11 状态流转枚举：非法 status 拒收',
  m.resolveExpectation(m.data.expectations[0].id, { status: 'done', messageId: idAsst }).ok === false);

// 12 非 moot 必须引证
check('12 兑现/落空必须引证：无 messageId 拒收',
  m.resolveExpectation(m.data.expectations[0].id, { status: 'fulfilled' }).ok === false);

// 13 resolve 成功 + 重复 resolve 拒收
const rid = m.data.expectations[0].id;
const r13 = m.resolveExpectation(rid, { status: 'broken', messageId: idUser, note: '他没来' });
check('13 落空入账：status=broken + outcome 带引证，且重复 resolve 拒收',
  r13.ok === true && r13.entry.status === 'broken' && r13.entry.outcome.messageId === idUser
  && m.resolveExpectation(rid, { status: 'fulfilled', messageId: idAsst }).ok === false);

// 14 moot 可无引证（不硬造证据）
check('14 moot 免引证（不硬造证据）',
  m.resolveExpectation(m.data.expectations[1].id, { status: 'moot' }).ok === true);

// 15 防工具化红线：memory.js 零定时器（机械门）
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory.js'), 'utf8');
check('15 防工具化红线：memory.js 零 setTimeout/setInterval（不是闹钟）',
  !/setTimeout|setInterval/.test(src));

// 16 三态枚举在册且只淡化不删除（D-005）
check('16 词汇三态对齐 EngramTrace：ACTIVE/FADING/DORMANT 语义在册',
  /ACTIVE/.test(src) && /FADING|fading|淡化/.test(src) && /DORMANT|dormant|沉睡/.test(src));

// 17 落盘往返保留两表
m.save(true);
const m3 = new Memory(dir);
// 18 快照引证（架构评审提醒 1）：关窗裁头后，本窗合法 ID 按快照白名单解析
check('18 快照引证：knownIds 白名单内的本窗 ID 不被裁头误判为伪造',
  m.addLexicon({ word: '雨声', kind: 'metaphor', messageId: 'm-snap-01' }, { knownIds: ['m-snap-01'] }).ok === true
  && m.addLexicon({ word: '真伪造', kind: 'metaphor', messageId: 'm-snap-X' }, { knownIds: ['m-snap-01'] }).ok === false);

// 19 提示词契约防漂移：三键在 SUMMARY_SYS 模板里（windowSynthesis 窗级产物）
const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
check('19 提示词契约防漂移：模板含 coinages/expectations/expectationOutcomes',
  /coinages/.test(brainSrc) && /expectationOutcomes/.test(brainSrc) && /"expectations":\[\]/.test(brainSrc));

// 20 偏差事实防漂移：broken 进成长反思且「只报事实不代拟」格式在册
check('20 偏差事实防漂移：【偏差事实】客观格式进 GROWTH 输入',
  /【偏差事实】曾预期/.test(brainSrc));

// 21 注入契约（提醒 2）：双段在册 + 克制语气原文 + 预算截断（词 Top5 / 预期最新3）
const m4 = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-inject-')));
m4.append('user', '她说市里');
const idX = m4.data.history[0].messageId;
for (let i = 0; i < 7; i++) m4.addLexicon({ word: '词' + i, kind: 'coinage', messageId: idX, gloss: '释' + i });
for (let i = 0; i < 5; i++) m4.addExpectation({ kind: 'external', source: 'user', text: '预期' + i, messageId: idX });
const st = m4.systemText();
check('21 注入契约：双段在册 + 克制语气 + 预算截断（词≤5/预期≤3）',
  st.includes('【你曾用过的词】') && st.includes('绝不强求')
  && st.includes('【当前指向未来的约定与预期】') && st.includes('绝不做定时提醒')
  && (st.match(/- 词/g) || []).length === 5 && (st.match(/- 预期/g) || []).length === 3);

// 22 空表守卫（提醒 1 同源）：零词汇且无 open 预期时两段都不注入（防幻觉）
const m5 = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-empty-')));
check('22 空表守卫：两段皆不注入（不给模型幻觉素材）',
  !m5.systemText().includes('【你曾用过的词】') && !m5.systemText().includes('【当前指向未来的约定与预期】'));

check('17 落盘往返：lexicon/expectations 持久化不丢',
  m3.data.lexicon.length === 1 && m3.data.expectations.length === 10);

console.log(failures === 0
  ? ('lexicon-expectations tests passed: ' + 22)
  : ('lexicon-expectations tests FAILED: ' + failures));
process.exit(failures === 0 ? 0 : 1);
