/**
 * test/v20s-note-fading.test.js — v2.0-s1（s1-b：selfNotes 渐褪与按强度淘汰）门禁测试
 *
 * 覆盖：
 *   1. 新建与历史兼容迁移：initialStrength / strength / tier / lastRetrievedWindow / retrievalCount
 *   2. 跨 6 窗口无召回：ACTIVE → FADING → DORMANT，零物理删除，保留 D-24 铸造资格
 *   3. FADING 截断（300 字）与 DORMANT 不主动注入
 *   4. DORMANT 情景唤醒（无 engramManager 也成立）+ D-20 反唠叨守恒（已读未命中不重塞，唤醒只重开一次）
 *   5. 按强度淘汰 + 未读严格豁免 + 全未读兜底（守住 SELF_NOTE_MAX_QUEUE = 8 上界）
 *   6. 前缀缓存不变式（systemText 逐字节不变）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Memory } = require('../src/memory');

const _tmpDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _tmpDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  fs.mkdtempSync = _origMkdtemp;
});

let pass = 0;
let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (extra ? '  ' + extra : ''));
  } else {
    failures++;
    console.log('FAIL  ' + name + (extra ? '  ' + extra : ''));
  }
}

function advanceCloseWindow(mem, n) {
  for (let i = 0; i < n; i++) {
    mem.append('user', `窗口 ${mem.data.windowNo} 对话-${i}`);
    mem.append('assistant', `窗口 ${mem.data.windowNo} 回复-${i}`);
    const snap = mem.windowSnapshot();
    mem.closeWindow(`窗口 ${mem.data.windowNo} 小结。`, snap);
  }
}

console.log('=== v2.0-s1 (s1-b) 便签渐褪门禁 ===');

/* ============ 1. 初始化与旧数据平缓迁移 ============ */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s-fading-'));
  const m = new Memory(dir, { persona: 'test-persona', windowTurns: 10 });
  m.addSelfNote({ content: '海螺贝壳放在桌面沙盒里', name: 'shell.md', source: 'selfNote', windowNo: 1 });
  const entry = m.data.selfNotes[0];

  check('1.1 新建 selfNote 自动带全 5 个动力学字段（初始强度 0.6、tier ACTIVE、retrievalCount 0）',
    entry.initialStrength === 0.6
    && entry.strength === 0.6
    && entry.tier === 'ACTIVE'
    && entry.lastRetrievedWindow === 1
    && entry.retrievalCount === 0);

  // 写入不含动力学字段的旧版 JSON 验证兼容加载
  const memPath = path.join(dir, 'memory.json');
  const legacyRaw = JSON.parse(fs.readFileSync(memPath, 'utf8'));
  legacyRaw.selfNotes = [{
    content: '旧版无渐褪字段便签',
    name: 'legacy.txt',
    windowNo: 1,
    at: Date.now() - 1000,
    drained: true,
    source: 'selfNote',
    engraved: false,
  }];
  fs.writeFileSync(memPath, JSON.stringify(legacyRaw), 'utf8');
  const mReloaded = new Memory(dir, { persona: 'test-persona', windowTurns: 10 });
  const rel = mReloaded.data.selfNotes[0];
  check('1.2 历史 archive 加载平缓补全渐褪字段并保留 source/drained',
    rel.initialStrength === 0.6
    && rel.strength === 0.6
    && rel.tier === 'ACTIVE'
    && rel.lastRetrievedWindow === 1
    && rel.retrievalCount === 0
    && rel.drained === true
    && rel.source === 'selfNote');
}

/* ============ 2. 跨 6 窗不召回渐褪与零删除 + FADING 截断 + DORMANT 跳过 ============ */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s-fading-'));
  const m = new Memory(dir, { persona: 'test-persona', windowTurns: 20 });
  const longBody = '海螺风声' + '字'.repeat(420);
  m.addSelfNote({ content: longBody, name: 'long.md', source: 'selfNote', windowNo: 1 });
  for (let i = 1; i <= 7; i++) {
    m.addSelfNote({ content: `第${i}条关于灯塔与潮汐的记忆-${i}`, name: `n${i}.txt`, source: 'selfNote', windowNo: 1 });
  }
  const sys0 = m.systemText();
  // 先读过全部 8 条
  m.append('user', '刚写完便签');
  const msgsActive = m.build();
  const activeUserTail = msgsActive[msgsActive.length - 1].content;
  check('2.1 ACTIVE 态首次注入给出完整原文（> 300 字未截断）且不改 systemText',
    activeUserTail.includes(longBody) && m.systemText() === sys0);

  // 关 2 次窗（entering windowNo = 3, ΔW = 2）：应进入 FADING 态
  advanceCloseWindow(m, 2);
  check('2.2 跨 2 窗进入 FADING 态，且 8 条一条未删（零物理删除）',
    m.data.windowNo === 3
    && m.data.selfNotes.length === 8
    && m.data.selfNotes[0].tier === 'FADING'
    && m.data.selfNotes[0].strength < 0.50
    && m.data.selfNotes[0].strength >= 0.35);

  // 检验 FADING 渲染截断（构造同条件新写/待注入态观测 _selfNote 输出）
  const fadingText = m._selfNote([m.data.selfNotes[0]]);
  check('2.3 FADING 态投影按 fadingMaxChars=300 截断并附隐退提示',
    fadingText.includes('印象已渐褪') && fadingText.length < longBody.length);

  // 再关 4 次窗（共 6 次关窗，entering windowNo = 7, ΔW = 6）：进入 DORMANT 态
  advanceCloseWindow(m, 4);
  check('2.4 跨 6 窗进入 DORMANT 态且队列条数仍为 8（零物理删除）、D-24 待铸造仍在',
    m.data.windowNo === 7
    && m.data.selfNotes.length === 8
    && m.data.selfNotes.every((n) => n.tier === 'DORMANT' && n.strength < 0.35)
    && m.selfNotesToEngrave().length === 8);

  // DORMANT 且已 drained 不再注入
  m.append('user', '今天没什么特别的事');
  const msgsDormant = m.build();
  check('2.5 DORMANT 且未唤回时不再占 Prompt 上下文',
    !msgsDormant[msgsDormant.length - 1].content.includes('你之前写下过'));
}

/* ============ 3. DORMANT 情景唤醒（无 engramManager）与反唠叨守恒 ============ */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s-fading-'));
  const m = new Memory(dir, { persona: 'test-persona', windowTurns: 20 }); // 默认 engramManager === null
  m.addSelfNote({ content: '那枚海螺贝壳藏在北岸灯塔的旧抽屉里', name: 'shell.md', source: 'selfNote', windowNo: 1 });
  m.addSelfNote({ content: '无关的第二条关于咖啡豆烘焙记录', name: 'coffee.txt', source: 'selfNote', windowNo: 1 });

  // 首轮消费掉两张纸
  m.append('user', '写完啦');
  m.build();
  check('3.1 首轮后两条均已标记 drained=true；下轮闲聊不重复唠叨（D-20 守恒）', (() => {
    m.append('user', '喝杯水吧');
    const b2 = m.build();
    return m.data.selfNotes.every((n) => n.drained === true)
      && !b2[b2.length - 1].content.includes('你之前写下过');
  })());

  // 跨 6 窗全部变 DORMANT
  advanceCloseWindow(m, 6);
  check('3.2 前提：无 engramManager 时仍正确衰减为 DORMANT',
    m.engramManager === null && m.data.selfNotes.every((n) => n.tier === 'DORMANT'));

  // 语境触发唤醒（仅命中「海螺贝壳」那条）
  m.reactivateByContext('初澜，你记得北岸灯塔那枚海螺贝壳吗', m.data.windowNo);
  const shell = m.data.selfNotes[0];
  const coffee = m.data.selfNotes[1];
  check('3.3 DORMANT 命中关键词后立即回升且只为命中条重开 drained=false，未命中条保持沉睡与 drained=true',
    shell.tier !== 'DORMANT' && shell.retrievalCount === 1 && shell.drained === false
    && coffee.tier === 'DORMANT' && coffee.drained === true);

  m.append('user', '想起那个贝壳了');
  const msgsWake = m.build();
  const tailWake = msgsWake[msgsWake.length - 1].content;
  check('3.4 唤醒后当轮 build() 成功重新注入贝壳便签，未命中条不趁机混入',
    tailWake.includes('海螺贝壳') && !tailWake.includes('咖啡豆'));

  // 下一轮闲聊再次满足 D-20 反唠叨（只注入一次）
  m.append('user', '继续聊别的');
  const msgsAfter = m.build();
  check('3.5 唤醒重注入一轮后立刻恢复 drained=true，后续不再反复唠叨',
    shell.drained === true && !msgsAfter[msgsAfter.length - 1].content.includes('你之前写下过'));
}

/* ============ 4. 按强度淘汰 + 未读豁免 + 全未读兜底 + systemText 前缀不变 ============ */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s-fading-'));
  const m = new Memory(dir, { persona: 'test-persona', windowTurns: 20 });
  const sysInitial = m.systemText();

  // 构造：index 0 是高强度已读旧条（strength=0.9）；index 1..7 是低强度已读新条（index 3 最弱=0.12）
  m.addSelfNote({ content: '高强度旧记忆-必须存活', name: 'old-strong.md', source: 'selfNote' });
  m.data.selfNotes[0].strength = 0.9;
  m.data.selfNotes[0].drained = true;
  for (let i = 1; i <= 7; i++) {
    m.addSelfNote({ content: `弱记忆-${i}`, name: `weak-${i}.md`, source: 'selfNote' });
    m.data.selfNotes[i].strength = i === 3 ? 0.12 : 0.3;
    m.data.selfNotes[i].drained = true;
  }

  m.addSelfNote({ content: '第9条新写入', name: 'new-9.md', source: 'selfNote' });
  check('4.1 队列满 8 条按强度淘汰最弱项（weak-3），高强度旧便签（old-strong）未被误删',
    m.data.selfNotes.length === 8
    && m.data.selfNotes.some((n) => n.name === 'old-strong.md')
    && !m.data.selfNotes.some((n) => n.name === 'weak-3.md')
    && m.data.selfNotes.some((n) => n.name === 'new-9.md'));

  // 未读豁免：把 new-9 设为未读(drained=false)且人为置超低强度 0.01，其余 7 条已读且强度 >= 0.4
  const unreadItem = m.data.selfNotes.find((n) => n.name === 'new-9.md');
  unreadItem.drained = false;
  unreadItem.strength = 0.01;
  for (const n of m.data.selfNotes) {
    if (n !== unreadItem) {
      n.drained = true;
      n.strength = n.name === 'weak-1.md' ? 0.41 : 0.8;
    }
  }
  m.addSelfNote({ content: '第10条新写入', name: 'new-10.md', source: 'selfNote' });
  check('4.2 未读豁免：虽 strength 最低，drained===false 条目严禁被淘汰；淘汰已读中最弱的 weak-1',
    m.data.selfNotes.length === 8
    && m.data.selfNotes.some((n) => n.name === 'new-9.md' && n.drained === false)
    && !m.data.selfNotes.some((n) => n.name === 'weak-1.md'));

  check('4.3 前缀缓存不变式：增删、渐褪、重排全程未改变 systemText()',
    m.systemText() === sysInitial);

  // 全未读满队列兜底：写入 10 条连续未读不突破上界 8
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'v20s-fading-'));
  const m2 = new Memory(dir2, { persona: 'test-persona', windowTurns: 20 });
  for (let i = 0; i < 10; i++) {
    m2.addSelfNote({ content: `unread-${i}`, name: `u-${i}.txt`, source: 'selfNote' });
  }
  check('4.4 全部未读连续写入仍守住 SELF_NOTE_MAX_QUEUE=8 且保留最新条目',
    m2.data.selfNotes.length === 8 && m2.data.selfNotes[7].content === 'unread-9');
}

console.log(`\nv20s-note-fading: PASS=${pass}, FAIL=${failures}`);
if (failures > 0) process.exit(1);
