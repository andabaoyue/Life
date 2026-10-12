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

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 4 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});
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

// 6 v1.0.6 adopted 专属暗号解封与四重严格门禁
const dirAdopt = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-exp-'));
const mAdopt = new Memory(dirAdopt);
mAdopt.append('user', '这是我们之间约定的暗号');
mAdopt.append('assistant', '好，那我们把这个约定叫做「信物」');
const idAdoptUser = mAdopt.data.history[0].messageId;
const idAdoptAsst = mAdopt.data.history[1].messageId;

const r6 = mAdopt.addLexicon({ word: '信物', kind: 'adopted', gloss: '双方确认的羁绊信物', messageId: idAdoptAsst });
check('6 v1.0.6 adopted 专属暗号解封且合规入库',
  r6.ok === true && r6.entry.kind === 'adopted' && r6.entry.gloss === '双方确认的羁绊信物');

check('6a adopted 门禁 1：gloss 必填（为空拒收）',
  mAdopt.addLexicon({ word: '信物2', kind: 'adopted', gloss: '', messageId: idAdoptAsst }).error === 'EMPTY_GLOSS');

check('6b adopted 门禁 2：引证角色必须为 assistant（user 消息拒收）',
  mAdopt.addLexicon({ word: '暗号', kind: 'adopted', gloss: '代称', messageId: idAdoptUser }).error === 'INVALID_MESSAGE_ROLE');

check('6c adopted 门禁 3：词↔消息内容一致性校验（消息未出现该词拒收）',
  mAdopt.addLexicon({ word: '海螺', kind: 'adopted', gloss: '代称', messageId: idAdoptAsst }).error === 'WORD_NOT_IN_MESSAGE');

mAdopt.append('assistant', '另外我也提到了「微光」');
const idAdoptAsst2 = mAdopt.data.history[mAdopt.data.history.length - 1].messageId;
check('6d adopted 门禁 4：单窗最多收纳 1 条 adopted（同窗第 2 条拒收）',
  mAdopt.addLexicon({ word: '微光', kind: 'adopted', gloss: '第二个词', messageId: idAdoptAsst2, windowNo: 1 }).error === 'WINDOW_ADOPTED_LIMIT');

check('6e adopted 门禁在 knownIds 回落路径下 fail-closed 不放行',
  mAdopt.addLexicon({ word: '信物3', kind: 'adopted', gloss: 'g', messageId: 'm-snap-fallback' }, { knownIds: ['m-snap-fallback'] }).ok === false);

check('6f adopted 引证通过 opts.messages 补足真实 assistant 内容时合规放行',
  mAdopt.addLexicon({ word: '海螺', kind: 'adopted', gloss: '约定之物', messageId: 'm-opts-asst', windowNo: 2 },
    { messages: [{ messageId: 'm-opts-asst', role: 'assistant', content: '我们说好的海螺' }] }).ok === true);


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

// 23 看板护栏：守信率除零守卫文案在册（不许蹦 NaN%）
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const petSrc23 = fs.readFileSync(path.join(__dirname, '..', 'pet.js'), 'utf8');
check('23 守信率除零守卫：main 出 null + pet 出「—（暂无约定结算）」（跨两文件钉死）',
  mainSrc.includes('promiseFidelity') && /fulfilled \+ broken\) > 0/.test(mainSrc)
  && petSrc23.includes('—（暂无约定结算）'));

// 24 看板护栏：经历链只读尾锚计数，life-mechanisms 口绝不 readAll 大档（防 I/O 阻塞）
const lmBlock = (mainSrc.split("ipcGuard.handle('life-mechanisms'")[1] || '').split('\n});')[0] || '';
check('24 经历链轻量口：life-mechanisms 不调 readAll（防掉帧）',
  lmBlock.length > 0 && !/readAll/.test(lmBlock) && /_readTailAnchor/.test(lmBlock));

// 25 别名容错：content → text（模型字段漂移的双保险，同数据换键名）
check('25 别名容错：expectations 的 content 字段被归一承接',
  m.addExpectation({ kind: 'external', source: 'user', content: '别名条目', messageId: idAsst }).ok === true
  && m.data.expectations.some((x) => x.text === '别名条目'));

// 26 组装归一防 [object Object]：引证式条目 {messageId, content} 提取在册
check('26 组装归一防 [object Object]：factText 提取与 map 归一在册',
  brainSrc.includes('factText') && /content \|\| x\.text/.test(brainSrc));

// 27 梦境防伪链不动摇：产物标签在库（[DREAM_GENERATED_ARTIFACT] / 非亲历）
const dreamSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'dream-system.js'), 'utf8');
const memFragSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory.js'), 'utf8');
check('27 梦境防伪标签在册（绝不冒充亲历）',
  dreamSrc.includes('DREAM_GENERATED_ARTIFACT')
  && memFragSrc.includes('离线重组碎片') && memFragSrc.includes('非亲历'));

// 28 睡眠双触发接线：关窗 + 入睡共用 _dreamCycle（防漂移）
check('28 梦境双触发接线：_dreamCycle 供关窗与入睡共用',
  (brainSrc.match(/_dreamCycle/g) || []).length >= 3 && /noveltyProxy/.test(brainSrc));

// 29 词汇动力学方案 A1：本窗提及共振升权 (+0.2, 上限 3.0) 且状态保持/复苏为 ACTIVE
const mDyn = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-exp-')));
mDyn.append('assistant', '初澜自创了雨声');
const idDyn = mDyn.data.history[0].messageId;
mDyn.addLexicon({ word: '雨声', kind: 'metaphor', gloss: '窗外雨声', messageId: idDyn, windowNo: 1 });
mDyn.refreshLexiconDynamics([{ role: 'assistant', content: '今天又听到了雨声' }], 1);
const lexDyn1 = mDyn.data.lexicon.find(x => x.word === '雨声');
check('29 词汇动力学：本窗提及共振升权 (+0.2) 且保持 ACTIVE',
  lexDyn1 && lexDyn1.weight === 1.2 && lexDyn1.status === 'ACTIVE' && lexDyn1.lastUsedWindow === 1);

// 30 词汇动力学方案 A1：跨 3 窗未提及自然衰减 (-0.1)，跌破 0.5 转入 FADING
lexDyn1.weight = 0.5;
mDyn.refreshLexiconDynamics([{ role: 'assistant', content: '完全没提那个词' }], 4); // 4 - 1 = 3 >= 3
check('30 词汇动力学：跨 3 窗未提及平滑减权 (-0.1) 且 weight < 0.5 转入 FADING',
  lexDyn1.weight === 0.4 && lexDyn1.status === 'FADING');

// 30a 衰减步长守卫：紧邻下个窗（窗5）不重复扣减（真正每 3 窗扣一次）
mDyn.refreshLexiconDynamics([{ role: 'assistant', content: '还是没提' }], 5); // 5 - 4 = 1 < 3
check('30a 衰减步长守卫：紧邻下个窗不重复扣减（真正每 3 窗扣一次）',
  lexDyn1.weight === 0.4 && lexDyn1.lastDecayedWindow === 4);

// 31 词汇动力学方案 A1：持续衰减至 <= 0.2 转入 DORMANT，再度提及时升权并复苏为 ACTIVE
lexDyn1.weight = 0.3;
mDyn.refreshLexiconDynamics([], 7); // 7 - 4 = 3 >= 3, 0.3 - 0.1 = 0.2
check('31 词汇动力学：衰减至 <= 0.2 转入 DORMANT',
  lexDyn1.weight === 0.2 && lexDyn1.status === 'DORMANT');
mDyn.refreshLexiconDynamics([{ role: 'user', content: '你想念雨声吗' }], 8);
check('31a 词汇动力学：再度提及复苏为 ACTIVE 且权重恢复 (+0.2)',
  lexDyn1.weight === 0.4 && lexDyn1.status === 'ACTIVE' && lexDyn1.lastUsedWindow === 8);

// 32 关窗集成：closeWindow 驱动 refreshLexiconDynamics 推进生命周期
const snapDyn = mDyn.windowSnapshot();
mDyn.closeWindow('窗口小结：这一轮平淡日常', snapDyn);
check('32 关窗集成：closeWindow 成功推进且词汇账本动力学生效',
  mDyn.data.windowNo === 2 && Array.isArray(mDyn.data.lexicon) && mDyn.data.lexicon.length === 1);

// 33 词长门禁：单字词过短拒收（防语素歧义与真阳性漏检陷阱）
const dirSub = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-exp-'));
const mSub = new Memory(dirSub);
mSub.append('assistant', '这是约定 Al 和新词');
const idSub = mSub.data.history[0].messageId;

check('33 词长门禁：单字词过短拒收（WORD_TOO_SHORT）',
  mSub.addLexicon({ word: '月', kind: 'adopted', gloss: '单字', messageId: idSub, windowNo: 1 }).error === 'WORD_TOO_SHORT');

mSub.addLexicon({ word: 'Al', kind: 'coinage', gloss: '缩写自创', messageId: idSub, windowNo: 1 });

// 英文单词 "Always" 不应触发缩写 "Al"
mSub.refreshLexiconDynamics([{ role: 'user', content: 'Always with you' }], 1);
const lexAl = mSub.data.lexicon.find(x => x.word === 'Al');
check('33a 英文边界防误判：英文缩写 Al 在 Always 中不被误判为提及（weight保持1）',
  lexAl && lexAl.weight === 1.0);

// 真实独立边界（独立单词 Al is here）合规命中并升权
mSub.refreshLexiconDynamics([{ role: 'assistant', content: 'Al is here with us' }], 1);
check('33b 真实英文边界合规命中：英文缩写在独立单词边界（如 Al is here）中合规命中升权',
  lexAl.weight === 1.2 && lexAl.lastUsedWindow === 1);

check('17 落盘往返：lexicon/expectations 持久化不丢',
  m3.data.lexicon.length === 1 && m3.data.expectations.length === 10);

console.log(failures === 0
  ? ('lexicon-expectations tests passed: ' + 43)
  : ('lexicon-expectations tests FAILED: ' + failures));
process.exit(failures === 0 ? 0 : 1);
