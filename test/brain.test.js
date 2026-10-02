/**
 * 用假 DeepSeek 服务实测整条链路，验证「轮数窗口」记忆方案是否真的成立。
 * 检查点：
 *   1. 窗口内 system 逐字不变，前一次请求是下一次的严格前缀（缓存命中的硬条件）
 *   2. 满 windowTurns 轮才关窗：生成小结、旧原文丢弃、只留尾部几条
 *   3. 破缓存次数 = 关窗次数；记忆合并搭在关窗同一刻，不多破一次
 *   4. token 兜底能提前关窗；未超预算不合并
 *   5. 小结/合并调用不污染主线命中率统计
 *   6. 请求失败回滚干净；重启进程后记忆能原样接上
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Brain, parseState, parseWear } = require('../src/brain');
const { DEFAULTS } = require('../src/config');

const SUMMARY_SYS_HEAD = '你是对话记忆整理助手';
const MERGE_SYS_HEAD = '你是长期记忆合并助手';

const reqs = [];
let mode = 'ok';
let replySeq = 0;
let summaryDelay = 0;   // 让小结调用挂起，制造「小结在飞、用户又发消息」的窗口
let chatDelay = 0;      // 让对话回复挂起，制造「打断后旧请求 catch 晚到」的窗口
let stateReply = null;  // 覆盖对话回复内容，用于测试 [state:xx] 解析
let summaryReply = null;// 覆盖小结回复内容，用于测试 5x20 结构化小结与 Provenance

const sig = (ms) => ms.map(m => m.role + '::' + m.content);

function isPrefix(a, b) {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function kindOf(msgs) {
  const c = msgs[0].content;
  if (c.indexOf(SUMMARY_SYS_HEAD) === 0) return 'summary';
  if (c.indexOf(MERGE_SYS_HEAD) === 0) return 'merge';
  return 'chat';
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    const j = JSON.parse(body);
    const kind = kindOf(j.messages);
    reqs.push({ kind, messages: j.messages, stream_options: j.stream_options });

    if (mode === 'fail') { res.writeHead(500); res.end('boom'); return; }

    const reply = kind === 'chat'
      ? (stateReply || '嗯，我记住了（第' + (++replySeq) + '次）')
      : kind === 'summary'
        ? (summaryReply || '用户叫阿哲，做投资，喜欢喝美式，最近在赶一个季度报告。')
        : '阿哲，投资人，爱美式；长期在做的事是季度报告与健身。';

    const prompt = j.messages.reduce((s, m) => s + m.content.length, 0);
    // 只有对话请求模拟前缀命中；摘要/合并是另一套前缀，全未命中
    const hit = kind === 'chat' ? Math.max(0, prompt - 40) : 0;
    const usage = {
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: prompt - hit,
      completion_tokens: 20
    };

    if (!j.stream) {
      if (kind === 'summary' && summaryDelay) await sleep(summaryDelay);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (chatDelay && kind === 'chat') await sleep(chatDelay);
    for (const ch of reply) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\n\n');
    }
    // 忠实模拟真实协议：不带 stream_options.include_usage 就不回 usage。
    // 客户端哪天漏了这个参数，命中率统计会直接归零、下面的断言会红。
    const wantUsage = j.stream_options && j.stream_options.include_usage === true;
    if (wantUsage) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-test-')); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const BASE = {
  apiKey: 'test', model: 'mock',
  windowTurns: 5, windowMaxTokens: 1e9, keepTailMessages: 6, memoryCapTokens: 1e9,
  price: { peak: {}, valley: {} }
};

function chatReqs() { return reqs.filter(r => r.kind === 'chat').map(r => r.messages); }

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const cfg = { ...BASE, baseURL: base };
  console.log('mock server', base, '\n');

  /* ---- 用例 1：窗口没满，前缀严格只追加 ---- */
  let brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999 });
  for (let i = 0; i < 6; i++) await brain.ask('第' + i + '句话，稍微长一点好让 token 上去', () => {});

  let cr = chatReqs();
  let okPrefix = true;
  for (let i = 1; i < cr.length; i++) if (!isPrefix(sig(cr[i - 1]), sig(cr[i]))) okPrefix = false;
  check('前 6 轮未关窗：每次都是上次的严格前缀', okPrefix);
  check('前 6 轮未关窗：system 逐字不变', new Set(cr.map(m => m[0].content)).size === 1);
  // 第 k 轮请求发出时 assistant 还没写回，所以是 1(system) + 2k - 1
  check('末次请求条数 = 1 + 2*6 - 1',
    cr[5].length === 12, 'len=' + cr[5].length);
  check('用例 1：未触发小结', brain.stats.compressions === 0);
  check('用例 1：命中率 > 80%', brain.report().rate > 80, 'rate=' + brain.report().rate + '%');
  // 真实协议不带 stream_options.include_usage 就不回 usage（mock 忠实执行了这条），
  // 所以命中率 > 80% 已隐含参数存在；这里再直接钉一下请求本身。
  check('流式请求带 stream_options.include_usage',
    reqs.filter(r => r.kind === 'chat')
        .every(r => r.stream_options && r.stream_options.include_usage === true));

  /* ---- 用例 2：满 windowTurns 轮关窗 ---- */
  brain = new Brain(tmpDir(), cfg);
  reqs.length = 0; replySeq = 0;
  for (let i = 0; i < 5; i++) await brain.ask('第' + i + '句', () => {});
  check('满 5 轮触发一次小结', brain.stats.compressions === 1,
    'compressions=' + brain.stats.compressions);
  check('小结调用恰好 1 次', reqs.filter(r => r.kind === 'summary').length === 1);
  check('小结未混入对话请求数', chatReqs().length === 5, 'chat=' + chatReqs().length);
  check('生成了 1 条窗口小结', brain.memory.windows.length === 1);
  check('小结已并入 system',
    brain.memory.systemText().indexOf('【第1段】') >= 0
    && brain.memory.systemText().indexOf('阿哲') >= 0);
  check('旧原文被裁掉，只剩尾部', brain.memory.history.length === 6,
    'history=' + brain.memory.history.length);
  check('新窗口轮数从 0 重新计', brain.memory.data.turnsInWindow === 0,
    'turnsInWindow=' + brain.memory.data.turnsInWindow);
  check('窗口编号推进', brain.memory.data.windowNo === 2);

  // 关窗后重新开始只追加
  const before = chatReqs().length;
  await brain.ask('关窗后第一句', () => {});
  await brain.ask('关窗后第二句', () => {});
  cr = chatReqs();
  check('关窗后又发两轮：最后两次仍是前缀递增',
    isPrefix(sig(cr[cr.length - 2]), sig(cr[cr.length - 1])));
  check('关窗后 system 才变（共 2 个版本）',
    new Set(cr.map(m => m[0].content)).size === 2);
  check('关窗那一轮未额外多发请求', cr.length === before + 2);

  /* ---- 用例 3：记忆超预算 -> 合并，且搭在关窗同一刻 ---- */
  brain = new Brain(tmpDir(), { ...cfg, memoryCapTokens: 60 });
  reqs.length = 0; replySeq = 0;
  for (let i = 0; i < 15; i++) await brain.ask('第' + i + '句', () => {});
  const segs = brain.memory.windows.length;
  // 关窗后尾部残留的 user 消息计入新窗口，所以 15 轮的关窗次数比 15/5 多一次
  check('15 轮至少关窗 3 次', brain.stats.compressions >= 3,
    'compressions=' + brain.stats.compressions);
  check('预算 60 tok 被超出后触发了合并', brain.stats.merges >= 1,
    'merges=' + brain.stats.merges);
  check('合并后小结条数被压回预算内',
    brain.memory.memoryTokens() <= brain.memory.memoryCap,
    'mem=' + brain.memory.memoryTokens() + ' cap=' + brain.memory.memoryCap);
  check('最早一段被标成【早期】', brain.memory.windows[0].early === true);
  check('system 里出现【早期】标记',
    brain.memory.systemText().indexOf('【早期】') >= 0);
  check('长期记忆保留条数 < 关窗次数', segs < 3, 'segments=' + segs);

  cr = chatReqs();
  // 最后一次关窗发生在末轮回答之后，没有请求能观察到那一版 system，
  // 所以 system 版本数 <= 关窗次数 + 1
  const sysVariants = new Set(cr.map(m => m[0].content)).size;
  check('破缓存次数 <= 关窗次数（合并没有多破一次）',
    sysVariants <= brain.stats.compressions + 1 && sysVariants >= brain.stats.compressions,
    'sysVariants=' + sysVariants + ' closes=' + brain.stats.compressions);
  check('合并调用次数 = 合并统计',
    reqs.filter(r => r.kind === 'merge').length === brain.stats.merges);
  check('合并后仍是只追加', (() => {
    let ok = true;
    for (let i = 1; i < cr.length; i++) {
      const same = cr[i - 1][0].content === cr[i][0].content;
      if (same && !isPrefix(sig(cr[i - 1]), sig(cr[i]))) ok = false;
    }
    return ok;
  })());
  check('小结/合并不计入主线命中率分母',
    brain.report().requests === cr.length,
    'requests=' + brain.report().requests);

  /* ---- 用例 4：token 兜底提前关窗 ---- */
  brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999, windowMaxTokens: 400, keepTailMessages: 2 });
  reqs.length = 0;
  await brain.ask('这一句故意写得很长很长，用来触发 token 兜底而不是轮数上限 ' + '啊'.repeat(300), () => {});
  await brain.ask('第二句同样很长，加上就该超窗口上限了 ' + '哦'.repeat(300), () => {});
  check('未到轮数但超 token 也关窗', brain.stats.compressions === 1,
    'compressions=' + brain.stats.compressions);

  /* ---- 用例 5：请求失败回滚干净 ---- */
  brain = new Brain(tmpDir(), cfg);
  await brain.ask('正常的一句', () => {});
  const h0 = brain.memory.history.length;
  const t0 = brain.memory.data.turnsInWindow;
  mode = 'fail';
  let threw = false;
  try { await brain.ask('这句会失败', () => {}); } catch { threw = true; }
  mode = 'ok';
  check('失败时抛出异常', threw);
  check('失败后历史长度不变', brain.memory.history.length === h0);
  check('失败后轮数不涨', brain.memory.data.turnsInWindow === t0);
  await brain.ask('失败后再问一句', () => {});
  const roles = brain.memory.history.map(m => m.role);
  let alt = true;
  for (let i = 1; i < roles.length; i++) if (roles[i] === roles[i - 1]) alt = false;
  check('回滚后 user/assistant 仍严格交替', alt, roles.join(','));

  /* ---- 用例 5.5：小结在飞时用户又发消息，不能把新对话裁掉 ---- */
  brain = new Brain(tmpDir(), { ...cfg, windowTurns: 2, keepTailMessages: 2 });
  reqs.length = 0;
  summaryDelay = 250;
  await brain.ask('A1', () => {});
  const p2 = brain.ask('A2 触发关窗', () => {});      // 回答完进入关窗，小结挂起 250ms
  await sleep(60);
  const p3 = brain.ask('A3 小结期间发的', () => {});
  await p2; await p3;
  let hist = brain.memory.history.map(m => m.content);
  check('小结在飞时新发的对话没被裁掉',
    hist.indexOf('A3 小结期间发的') >= 0 && hist.indexOf('A3 小结期间发的') % 2 === 0,
    hist.join(' | '));
  check('关窗只删快照里的那部分（保留尾部+新增）',
    brain.memory.history.length === 4, 'history=' + brain.memory.history.length);
  check('新窗口轮数含小结期间追加的那轮',
    brain.memory.data.turnsInWindow === 1, 'turns=' + brain.memory.data.turnsInWindow);
  summaryDelay = 0;

  /* ---- 用例 5.6：小结期间点「清空记忆」，旧快照必须作废 ---- */
  brain = new Brain(tmpDir(), { ...cfg, windowTurns: 2, keepTailMessages: 2 });
  summaryDelay = 200;
  await brain.ask('B1', () => {});
  const p4 = brain.ask('B2', () => {});
  await sleep(50);
  brain.clearMemory();
  await p4;
  check('reset 后过期快照不再写入小结',
    brain.memory.windows.length === 0, 'windows=' + brain.memory.windows.length);
  check('reset 后历史确实为空', brain.memory.history.length === 0);
  summaryDelay = 0;

  /* ---- 用例 5.7：连续两次打断，旧请求的 catch 不能抹掉新请求的 ctrl ---- */
  brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999 });
  chatDelay = 400;
  const pa = brain.ask('C1 会被打断', () => {}).catch(e => e.name || e.message);
  await sleep(60);                       // C1 的流还在挂起
  brain.abort();
  const pb = brain.ask('C2 也会被打断', () => {}).catch(e => e.name || e.message);
  await sleep(60);                       // 此刻 C1 的 AbortError 才进 catch
  brain.abort();
  const rc = await brain.ask('C3 正常完成', () => {});
  check('两次打断后第三次正常回复', typeof rc.text === 'string' && rc.text.length > 0);
  const errA = await pa, errB = await pb;
  check('旧请求 catch 未抹掉新 ctrl（abort 仍生效）',
    errA === 'AbortError' && errB === 'AbortError', errA + '/' + errB);
  const roles2 = brain.memory.history.map(m => m.role);
  let alt2 = true;
  for (let i = 1; i < roles2.length; i++) if (roles2[i] === roles2[i - 1]) alt2 = false;
  check('连续打断后历史仍只含最后一轮', alt2 && brain.memory.history.length === 2,
    roles2.join(','));
  check('连续打断后轮数正确', brain.memory.data.turnsInWindow === 1,
    'turns=' + brain.memory.data.turnsInWindow);
  chatDelay = 0;

  /* ---- 用例 6：重启后记忆原样接上 ---- */
  const dir = tmpDir();
  brain = new Brain(dir, cfg);
  for (let i = 0; i < 5; i++) await brain.ask('重启前第' + i + '句', () => {});
  const sysBefore = brain.memory.systemText();
  const brain2 = new Brain(dir, cfg);
  check('重启后窗口小结还在', brain2.memory.windows.length === 1);
  check('重启后 system 完全一致（不破坏已缓存前缀）',
    brain2.memory.systemText() === sysBefore);
  reqs.length = 0;
  await brain2.ask('重启后说一句', () => {});
  check('重启后没有立刻再关窗', brain2.stats.compressions === 1,
    'compressions=' + brain2.stats.compressions);
  check('重启后只多发了一次对话请求', chatReqs().length === 1);
  check('重启后历史正常接上（尾部 6 条 + 新一轮）',
    brain2.memory.history.length === 8, 'history=' + brain2.memory.history.length);

  /* ---- 用例 7：时间不进 system ---- */
  check('system 不含易变时间戳', !/当前时间|今天是|\d{4}-\d{2}-\d{2}/.test(chatReqs()[0][0].content));

  /* ---- 用例 8：状态标记解析与降级 ---- */
  check('正常标记被剥离并识别',
    JSON.stringify(parseState('让我想想嘛~[state:thinking]')) ===
    JSON.stringify({ text: '让我想想嘛~', state: 'thinking' }));
  check('无标记 → idle 且文本原样',
    parseState('普通回复').state === 'idle' && parseState('普通回复').text === '普通回复');
  check('未知状态词 → idle',
    parseState('好的[state:dance]').state === 'idle');
  check('标记在中间不算数（防误伤正文）',
    parseState('[state:happy] 开头就带也不行').state === 'idle'
    && parseState('[state:happy] 开头就带也不行').text === '[state:happy] 开头就带也不行');
  check('中文冒号/大小写/空格容错',
    parseState('嗯[state：Happy ]').state === 'happy');
  check('句末标点尾巴被容忍（不再泄漏进历史）',
    parseState('好呀~[state:happy]。').state === 'happy'
    && parseState('好呀~[state:happy]。').text === '好呀~');
  check('句末波浪号尾巴',
    parseState('好呀~[state:happy]~').state === 'happy');
  check('未知状态词不掏空正文（宁可留标记也不丢回复）',
    parseState('[state:dance]').text === '[state:dance]'
    && parseState('正文[state:dance]').text === '正文[state:dance]');

  /* ---- 用例 9：ask() 端到端带 state，且标记不进历史 ---- */
  brain = new Brain(tmpDir(), cfg);
  stateReply = '好呀~[state:happy]';
  const rs = await brain.ask('测试状态返回', () => {});
  stateReply = null;
  check('ask 返回剥离后的文本', rs.text === '好呀~' && rs.state === 'happy',
    JSON.stringify(rs.text) + '/' + rs.state);
  check('历史里存的是剥离后的文本（标记不污染前缀）',
    brain.memory.history[brain.memory.history.length - 1].content === '好呀~');

  /* ---- 用例 10：记忆可见 / 可删 ---- */
  brain = new Brain(tmpDir(), { ...cfg, windowTurns: 2, keepTailMessages: 2 });
  await brain.ask('D1', () => {});
  await brain.ask('D2', () => {});      // 关窗 -> 1 条小结
  await brain.ask('D3', () => {});
  await brain.ask('D4', () => {});      // 再关窗 -> 2 条
  let list = brain.memory.listMemory();
  check('listMemory 返回 2 条带标签的记忆',
    list.length === 2 && list[0].label === '第1段' && list[0].text.length > 0
    && typeof list[0].tokens === 'number', JSON.stringify(list.map(l => l.label)));
  check('deleteWindow 越界返回 false',
    brain.memory.deleteWindow(9) === false && brain.memory.deleteWindow(-1) === false
    && brain.memory.deleteWindow(1.5) === false);
  brain.memory.deleteWindow(0);
  const saved = JSON.parse(fs.readFileSync(brain.memory.path, 'utf8'));
  check('删除真实落盘（不是假装忘记）',
    saved.windows.length === 1 && saved.windows[0].no === 2,
    JSON.stringify(saved.windows.map(w => w.no)));
  const reloaded = new (require('../src/memory').Memory)(
    path.dirname(brain.memory.path), { persona: 'P', windowTurns: 2 });
  check('重读文件确认只剩 1 条', reloaded.windows.length === 1);
  check('删除后 system 不再含被删片段',
    brain.memory.systemText().indexOf('【第1段】') < 0);

  /* ---- 用例 11：换装提案 —— 语言状态 ≠ 程序状态 ---- */
  check('parseWear 剥离合法单品并小写化',
    JSON.stringify(parseWear('换这件[wear:Gray_Tee_01]'))
    === JSON.stringify({ text: '换这件', wear: 'gray_tee_01' }));
  check('parseWear 剥离预设名',
    parseWear('好[wear:gothic]').wear === 'gothic');
  check('parseWear 幻觉 id 不剥离（同 state 的教训）',
    parseWear('好[wear:maid_dress_01]').wear === null
    && parseWear('好[wear:maid_dress_01]').text === '好[wear:maid_dress_01]');
  check('无 wear 标记返回 null 且文本原样',
    parseWear('普通回复').wear === null);
  check('标记不在末尾不算数',
    parseWear('[wear:gothic] 开头不算').wear === null);

  // 端到端：注入真实 wardrobe
  const { Wardrobe } = require('../src/wardrobe');
  brain = new Brain(tmpDir(), cfg);
  const wd = new Wardrobe(tmpDir());
  brain.wardrobe = wd;
  brain.memory.wardrobe = wd.promptBlock();
  const sysW = brain.memory.systemText();
  check('穿着块与衣柜清单挂进 system（模型据此如实回答穿了什么）',
    sysW.includes('【当前穿着】') && sysW.includes('【衣柜里可用的 itemId】')
    && sysW.includes('lace_corset_01'));
  check('穿着块之后 system 不再变化（缓存稳定）', (() => {
    const a = brain.memory.systemText();
    brain.memory.append('user', '随便聊聊');
    return a === brain.memory.systemText();
  })());

  /* 顺序不变式：穿着块必须在**整段 system 的最末尾**，长期记忆在它之前。
     前缀缓存是从头开始比的，所以"谁在前面"决定了换装要赔多少：
       persona + 记忆 + 穿着   换一次衣服 → 只有穿着之后的一小段未命中
       persona + 穿着 + 记忆   换一次衣服 → 记忆和历史全部未命中
     这条以前没有任何测试钉住，于是代码把穿着块拼在记忆前面、注释和 README
     却都写"挂在末尾"，谁都没发现（文档说意图、代码干另一件事，是最坑的一种
     不一致：读文档的人会以为已经有保证）。所以这里既测顺序、也测真实后果。 */
  brain.memory.data.windows = [
    { no: 1, text: '【测试段】用户叫阿哲', early: false },
    { no: 2, text: '【测试段2】用户在做桌宠', early: false }
  ];
  const sysOrder = brain.memory.systemText();
  const iMem = sysOrder.indexOf('【你与此前的记忆】');
  const iWd = sysOrder.indexOf('【当前穿着】');
  check('穿着块与长期记忆同时存在时两块都在', iMem >= 0 && iWd >= 0,
    'iMem=' + iMem + ' iWd=' + iWd);
  check('长期记忆在穿着块之前（穿着块是最后一段）', iMem < iWd,
    'iMem=' + iMem + ' iWd=' + iWd);
  check('穿着块就是 system 的结尾（后面没有别的内容）',
    sysOrder.endsWith(brain.memory.wardrobe)
    && !sysOrder.slice(iWd).includes('【你与此前的记忆】'),
    'tail=' + JSON.stringify(sysOrder.slice(-14)));
  // 后果测量：换一次衣服，"从头开始一样"的部分有没有把长期记忆包住。
  // 判据不是"未命中比例小于某个阈值"——穿着块里带着整份衣柜清单，本身就有
  // 一千多字节，改不改顺序未命中都不小，用比例当门槛只能得到 60% vs 62%
  // 这种擦边的判据，等于没测。真正要的不变式很干脆：**公共前缀必须长到
  // 盖住整段长期记忆**，也就是未命中严格从穿着块那一点开始。
  const beforeSwap = brain.memory.systemText();
  brain.memory.wardrobe = '【当前穿着】\n- 连衣裙：哥特黑连衣裙';
  const afterSwap = brain.memory.systemText();
  let shared = 0;
  while (shared < beforeSwap.length && beforeSwap[shared] === afterSwap[shared]) shared++;
  const wdStart = beforeSwap.indexOf('【当前穿着】');
  check('换一次衣服：未命中严格从穿着块那一点开始（长期记忆全在公共前缀内）',
    shared >= wdStart,
    '公共前缀 ' + shared + ' 字节，穿着块从 ' + wdStart + ' 开始；差 ' + (shared - wdStart));
  check('长期记忆的字节原样保留在公共前缀里（没被换装牵连）',
    afterSwap.slice(0, shared).includes('用户叫阿哲')
    && afterSwap.slice(0, shared).includes('用户在做桌宠'));
  brain.memory.data.windows = [];
  brain.memory.wardrobe = wd.promptBlock();

  stateReply = '那我穿这套试试[wear:gothic][state:happy]';
  const rw = await brain.ask('换成哥特风吧', () => {});
  stateReply = null;
  check('ask 返回 wears 数组（有序、逐条）',
    Array.isArray(rw.wears) && rw.wears.length === 1 && rw.wears[0] === 'gothic');
  check('正文里两个标记都被剥掉', rw.text === '那我穿这套试试' && rw.state === 'happy',
    JSON.stringify(rw.text));
  check('衣柜状态被真实改变（不是说说而已）',
    wd.equip.dress === 'gothic_black_01' && wd.equip.top === null);
  check('执行结果写进历史（下一轮看到的是事实）',
    brain.memory.history[brain.memory.history.length - 1].content
    === '那我穿这套试试\n[系统] 换装执行结果：已实际换上 gothic');
  check('换装后穿着块同步更新',
    brain.memory.systemText().includes('哥特黑连衣裙'));

  // 幻觉提案：模型说了不存在的东西
  stateReply = '我换上女仆装了哦[wear:maid_dress_01][state:happy]';
  const rh = await brain.ask('你穿女仆装看看', () => {});
  stateReply = null;
  check('幻觉 wear id 不剥离也不执行',
    rh.wears.length === 0 && rh.text === '我换上女仆装了哦[wear:maid_dress_01]');
  check('衣柜状态纹丝不动',
    wd.equip.dress === 'gothic_black_01' && wd.equip.top === null);
  check('没有谎报的「执行结果」混进历史',
    !brain.memory.history[brain.memory.history.length - 1].content.includes('[系统]'));

  // 缓存：不换装时 system 逐字节稳定（穿着块不能每轮抖动）
  const rn = await brain.ask('今天天气不错', () => {});
  check('没有 wear 标记时 wears 为空数组、无执行结果注记',
    Array.isArray(rn.wears) && rn.wears.length === 0 && rn.wearNote === null);
  check('历史里的 assistant 消息不带 [系统] 注记',
    !brain.memory.history[brain.memory.history.length - 1].content.includes('[系统]'));

  // 降级：衣柜未注入（例如 browser 预览 / 初始化失败）
  const brainNoWd = new Brain(tmpDir(), cfg);
  stateReply = '好[wear:casual][state:happy]';
  const rd = await brainNoWd.ask('换休闲', () => {});
  stateReply = null;
  check('衣柜未注入时标记照常被剥离、不误称换好',
    rd.wears.length === 1 && rd.wears[0] === 'casual'
    && rd.wearNote === null && rd.text === '好',
    JSON.stringify(rd.text));
  check('衣柜未注入时屏幕状态仍然正确回落', rd.state === 'happy');

  // 没有实际变化时不推倒重画（wearChanged 是渲染端唯一的推送开关）
  check('首次换装 wearChanged=true', rw.wearChanged === true);
  stateReply = '还是这套吧[wear:gothic][state:happy]';
  const rSame = await brain.ask('再换一次哥特', () => {});
  stateReply = null;
  check('重复提案同一套装：执行如实但 wearChanged=false（屏幕不白闪）',
    rSame.wears[0] === 'gothic' && rSame.wearNote === '本来就已经穿着 gothic'
    && rSame.wearChanged === false, JSON.stringify(rSame.wearNote));
  check('穿着块没被无谓重写', brain.memory.systemText().includes('【当前穿着】'));

  /* ---- 连发多个换装提案：逐条执行，不能只认最后一个 ----
     模型完全可能一条回复里写两个 [wear:]（"这条不合适，那就穿外套"）。
     旧实现只有一个 wear 变量，后面的覆盖前面的 —— 屏幕上只换了一件，
     历史里也只有一条执行结果，等于程序替模型少说了一件事。
     这里故意选一对结果确定的提案：先撞互斥规则，再换外套成功。 */
  stateReply = '连衣裙配不了T恤，那加件外套[wear:gray_tee_01][wear:white_tech_jacket_01][state:happy]';
  const rMulti = await brain.ask('叠穿一下', () => {});
  stateReply = null;
  check('连发两个提案：wears 按正文顺序保留两条',
    rMulti.wears.length === 2 && rMulti.wears[0] === 'gray_tee_01'
    && rMulti.wears[1] === 'white_tech_jacket_01', JSON.stringify(rMulti.wears));
  check('连发提案：正文里两个标记都剥掉',
    rMulti.text === '连衣裙配不了T恤，那加件外套', JSON.stringify(rMulti.text));
  check('连发提案的执行结果逐条如实拼进一条注记（成功与失败各一）',
    (rMulti.wearNote || '').split('；').length === 2
    && rMulti.wearNote.includes('gray_tee_01 未生效：连衣裙不能和上装/下装同时穿')
    && rMulti.wearNote.includes('已实际换上 white_tech_jacket_01'),
    JSON.stringify(rMulti.wearNote));
  check('有一条真换上 → wearChanged=true', rMulti.wearChanged === true);
  check('失败的那条没有改动衣柜，成功的那条改了',
    wd.equip.top === null && wd.equip.outerwear === 'white_tech_jacket_01',
    JSON.stringify(wd.equip));
  check('两条执行结果都进了历史（下一轮模型看到的是事实）',
    brain.memory.history[brain.memory.history.length - 1].content.includes('gray_tee_01 未生效'));


  check('穿着块计入上下文 token 估算（面板数字不虚低）',
    (() => {
      const m = brain.memory;
      const withWd = m.contextTokens();
      const keep = m.wardrobe; m.wardrobe = '';
      const without = m.contextTokens();
      m.wardrobe = keep;
      return without > 0 && withWd > without;
    })());

  /* ---- 用例 11.5：配置热重载（Gemini #9，属实） ----
     README 引导用户去手改 life-config.json 调价格和窗口大小，
     而旧的模块级单一 cached 让这种改动必须重启才生效。
     现在每轮 ask 开头重读一次盘，并把结果就地应用（不换对象引用）。 */
  {
    const d = tmpDir();
    const cf = path.join(d, 'life-config.json');
    const writeCfg = (o) => fs.writeFileSync(cf, JSON.stringify(o));
    writeCfg({ ...BASE, baseURL: base, model: 'disk-A', windowTurns: 5 });
    const hb = new Brain(d, { ...BASE, apiKey: 'sk-memory', baseURL: base,
                              model: 'in-memory', windowTurns: 999 });
    check('热重载前用的是内存里那份', hb.memory.windowTurns === 999
      && hb.api.cfg.model === 'in-memory');
    await hb.ask('先聊一句', () => {});
    check('盘上的 windowTurns 下一轮就生效（不必重启）',
      hb.memory.windowTurns === 5, 'got ' + hb.memory.windowTurns);
    check('model 也热更新，且 DeepSeek 客户端与 report 看到的是同一份',
      hb.api.cfg.model === 'disk-A' && hb.cfg.model === 'disk-A'
      && hb.api.cfg === hb.cfg, JSON.stringify(hb.report().model));
    check('apiKey 不被盘上那份抹掉（盘上按设计不含明文 key）',
      hb.cfg.apiKey === 'sk-memory', JSON.stringify(hb.cfg.apiKey));
    check('用量面板的 model 跟着热更新（不是启动时的旧值）',
      hb.report().model === 'disk-A', JSON.stringify(hb.report().model));

    writeCfg({ ...BASE, baseURL: base, model: 'disk-B', windowTurns: 3 });
    await hb.ask('再聊一句', () => {});
    check('第二次改动同样生效（不是一次性读取）',
      hb.cfg.model === 'disk-B' && hb.memory.windowTurns === 3);

    // 改坏配置：正在跑的参数不许跳回出厂值
    const before = { model: hb.cfg.model, wt: hb.memory.windowTurns };
    fs.writeFileSync(cf, '{ 手抖删了一个引号');
    const broken = await hb.ask('配置改坏了也照常回话', () => {});
    check('配置文件语法坏掉时保持现状而不是退回 DEFAULTS',
      hb.cfg.model === before.model && hb.memory.windowTurns === before.wt,
      JSON.stringify([hb.cfg.model, hb.memory.windowTurns]));
    check('配置写坏也不能让这轮对话失败（照样拿到回复）',
      typeof broken.text === 'string' && broken.text.length > 0,
      JSON.stringify(broken.text));

    writeCfg({ ...BASE, baseURL: base, model: 'disk-C', windowTurns: 4 });
    await hb.ask('修好了就继续跟盘', () => {});
    check('把文件修好后热重载自然恢复', hb.memory.windowTurns === 4,
      'got ' + hb.memory.windowTurns);
  }

  /* ---- 用例 13：本地活动与环境块（v0.8） ----
     这一组钉三件事，每件都对应一次真实的钱或一次真实的撒谎：
       1. 环境块里有分钟级时效数据，进 system 就等于每轮破一次前缀缓存；
       2. 主动搭话的触发理由不是用户说的话，进 history 就是凭空造记忆；
       3. 遥测按水位线消费，请求失败时不许 commit（否则"她记得被戳过"
          这件事会随一次失败悄悄消失）。 */
  {
    const { ActivityTracker } = require('../src/tracker');
    let tc = 1000000;
    const trk = new ActivityTracker({ now: () => tc });
    brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999 });
    brain.tracker = trk;
    reqs.length = 0;
    await brain.ask('先聊一句不带互动的', () => {});
    let last = chatReqs().pop();
    check('无互动时 user 消息就是原句（不硬塞一段没发生的事）',
      last[last.length - 1].content === '先聊一句不带互动的',
      JSON.stringify(last[last.length - 1].content));

    trk.record('click'); trk.record('click');
    await brain.ask('戳了我两下', () => {});
    last = chatReqs().pop();
    const u = last[last.length - 1].content;
    check('有互动时环境块追加在最后一条 user 消息末尾',
      u.indexOf('戳了我两下') === 0 && u.includes('【当前环境感知】'), JSON.stringify(u));
    check('环境块如实带着那 2 下', /被戳 2 次/.test(u), JSON.stringify(u));
    const sysSet = new Set(chatReqs().map(m => m[0].content));
    check('环境块绝不进 system（进了就是每轮破一次前缀缓存）',
      !chatReqs()[0][0].content.includes('【当前环境感知】') && sysSet.size === 1,
      'sysVersions=' + sysSet.size);
    check('带环境块的这一轮仍是上一轮的严格前缀（历史只追加）',
      isPrefix(sig(chatReqs()[chatReqs().length - 2]), sig(last)),
      JSON.stringify([chatReqs().length]));
    check('环境块不进 history（保持永久历史纯净，作为瞬时上下文仅在请求时附加）',
      !brain.memory.history.some(m => m.content.includes('【当前环境感知】')));

    /* 主动搭话：写入 synthetic history，保卫下一轮完整缓存前缀 */
    reqs.length = 0;
    const users0 = brain.memory.history.filter(m => m.role === 'user').length;
    const len0 = brain.memory.history.length;
    // brain 只认 opts.proactive；hint 只给模型看，不冒充用户原话
    const rPro = await brain.ask('用户在 8 秒内戳了你 6 下', () => {},
      { proactive: true, proactiveHint: '轻微抗议，别真的生气' });
    last = chatReqs().pop();
    const proactiveRequest = last;
    check('主动搭话的请求带上了触发理由与环境块',
      /\[自主感知触发\]/.test(last[last.length - 1].content)
      && last[last.length - 1].content.includes('【当前环境感知】'),
      JSON.stringify(last[last.length - 1].content));
    check('主动搭话写入 synthetic user，下一轮可复用缓存前缀',
      brain.memory.history.length === len0 + 2
      && brain.memory.history.filter(m => m.role === 'user').length === users0 + 1
      && brain.memory.history.slice(-2)[0].synthetic === true
      && brain.memory.history.slice(-2)[0].content.includes('内部语气提示'),
      'len=' + brain.memory.history.length + ' users=' + users0);
    check('主动搭话正常返回文本', typeof rPro.text === 'string' && rPro.text.length > 0,
      JSON.stringify(rPro.text));
    check('前提复核：普通那一轮确实写过 user（否则上一条是空转）',
      brain.memory.history.some(m => m.role === 'user' && m.content.includes('先聊一句')));

    /* 主动搭话失败：synthetic user 必须和 assistant 一起回滚，不能残留半轮。 */
    const lenP = brain.memory.history.length;
    const usersP = brain.memory.history.filter(m => m.role === 'user').length;
    mode = 'fail';
    let proThrew = false;
    try { await brain.ask('这次会失败的主动搭话', () => {}, { proactive: true }); }
    catch { proThrew = true; }
    mode = 'ok';
    check('主动搭话失败时抛错（不静默假装说过）', proThrew);
    check('主动搭话失败后历史一条没动（synthetic user 会被安全回滚）',
      brain.memory.history.length === lenP
      && brain.memory.history.filter(m => m.role === 'user').length === usersP,
      'len=' + brain.memory.history.length + '/' + lenP);
    // 紧接着的正常一轮必须还能干净地追加 —— 检查 pendingUser 没被搞脏
    await brain.ask('失败后的正常一句', () => {});
    check('主动搭话失败不影响下一轮的追加/回滚配对',
      brain.memory.history.length === lenP + 2
      && brain.memory.history.slice(-2).map(m => m.role).join(',') === 'user,assistant',
      JSON.stringify(brain.memory.history.slice(-2).map(m => m.role)));
    const afterProactiveRequest = chatReqs().pop();
    check('主动搭话作为 synthetic 历史完整保留在下一轮对话前缀中',
      afterProactiveRequest.some(m => m.role === 'user' && m.content.includes('内部语气提示'))
      && afterProactiveRequest.some(m => m.role === 'assistant' && m.content.includes('嗯，我记住了')));

    /* 遥测的水位线：失败时不 commit */
    const trk2 = new ActivityTracker({ now: () => tc });
    trk2.record('click');
    brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999 });
    brain.tracker = trk2;
    mode = 'fail';
    let caught = false;
    try { await brain.ask('这句会失败', () => {}); } catch { caught = true; }
    mode = 'ok';
    check('失败时那一下没被当作已消费（下次如实补报）',
      caught && trk2.snapshot().clicks === 1, 'clicks=' + trk2.snapshot().clicks);
    await brain.ask('再来一句', () => {});
    check('补报之后水位线才推进', trk2.snapshot().clicks === 0,
      'clicks=' + trk2.snapshot().clicks);

    /* 睡眠：只接受用户明确晚安，不把模型当下困倦扩大成全局睡眠 */
    const trk3 = new ActivityTracker({ now: () => tc });
    brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999 });
    brain.tracker = trk3;
    await brain.ask('晚安啦', () => {});
    check('道晚安真的让她进入睡眠（不是只在嘴上答应）', trk3.sleepMode === true);
    const start = trk3.sleepStartTime;
    tc += 60000;
    await brain.ask('其实我还是要说晚安', () => {});
    check('重复道晚安不重置睡眠起点（brain 这条路上幂等）',
      trk3.sleepStartTime === start);
    await brain.ask('在吗', () => {});
    check('醒来之后环境块带"刚被叫醒"（她知道自己才醒）',
      chatReqs().pop().slice(-1)[0].content.includes('刚被叫醒'));
    stateReply = '我有点困了[state:sleepy]';
    const trk4 = new ActivityTracker({ now: () => tc });
    brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999 });
    brain.tracker = trk4;
    await brain.ask('你困了吗', () => {});
    stateReply = null;
    check('模型打出 [state:sleepy] 不会把白天切入全局睡眠',
      trk4.sleepMode === false);
    const trk5 = new ActivityTracker({ now: () => tc });
    brain = new Brain(tmpDir(), { ...cfg, windowTurns: 999 });
    brain.tracker = trk5;
    await brain.ask('你困了吗', () => {});
    check('没有 sleepy 标记时，问"你困了吗"不会让她入睡',
      trk5.sleepMode === false);

    /* 小结材料要剥掉环境块，历史本身不许改写 */
    const m = brain.memory;
    check('cleanContentForSummary 剥掉行首锚定的环境块',
      m.cleanContentForSummary('早\n\n【当前环境感知】\n- 被戳 1 次') === '早',
      JSON.stringify(m.cleanContentForSummary('早\n\n【当前环境感知】\n- 被戳 1 次')));
    check('正文里提到的【当前环境感知】不被动（那不是注入的块）',
      m.cleanContentForSummary('你刚才写的【当前环境感知】那段我看到了')
        === '你刚才写的【当前环境感知】那段我看到了');
    check('主动搭话的触发前缀在小结材料里被去掉',
      m.cleanContentForSummary('[自主感知触发]：用户在 8 秒内戳了你 5 下')
        === '用户在 8 秒内戳了你 5 下' &&
      m.cleanContentForSummary('[桌宠自主感知触发]：用户在 8 秒内戳了你 5 下')
        === '用户在 8 秒内戳了你 5 下', JSON.stringify(
        m.cleanContentForSummary('[自主感知触发]：用户在 8 秒内戳了你 5 下')));
    check('非字符串输入不炸（老数据里可能有 undefined）',
      m.cleanContentForSummary(undefined) === '');
  }

  /* ---- 用例 12：SSE 分帧健壮性（GPT 提的第 3 条，属实） ----
     构造三种恶劣情况：UTF-8 多字节被切断、最后一行没有换行、
     usage 包正好在那个没有换行的尾巴上。
     真实 DeepSeek 的 usage 就在 [DONE] 之前，服务端少发一个换行
     就会让命中率与计费静默归零 —— 这个必须测住。 */
  const { DeepSeek } = require('../src/deepseek');
  const sse = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const usage = { prompt_cache_hit_tokens: 100,
                      prompt_cache_miss_tokens: 20, completion_tokens: 7 };
      const uPkg = 'data: ' + JSON.stringify({ choices: [{ delta: {} }], usage }) + '\n\n';
      const done = 'data: [DONE]\n\n';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (j.model === 'ragged') {
        // 每个字节单独一帧，且中文正好被切在字节中间
        const bytes = Buffer.from(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好呀，中文多字节' } }] })
          + '\n\n' + uPkg + done);
        for (const b of bytes) res.write(Buffer.from([b]));
        res.end();
      } else if (j.model === 'no-final-newline') {
        // 最后一段没有换行：老代码会把它整段留在 buf 里丢掉
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '尾巴' } }] }) + '\n\n');
        res.write(uPkg.trimEnd());          // 砍掉结尾换行
        res.end();                          // 连 [DONE] 都不发
      } else {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '正常' } }] }) + '\n\n');
        res.write(uPkg);
        res.write(done);
        res.end();
      }
    });
  });
  await new Promise(r => sse.listen(0, '127.0.0.1', r));
  const sbase = 'http://127.0.0.1:' + sse.address().port;

  // 用 model 名选服务端行为，逐字上屏的累计值也带回来一起断言
  const pick = async (name) => {
    const d2 = new DeepSeek({ baseURL: sbase, apiKey: 't', model: name });
    let got = '';
    const r = await d2.stream([{ role: 'user', content: 'hi' }], (x) => { got += x; });
    return { ...r, got };
  };
  const a = await pick('normal');
  const b = await pick('ragged');
  const c = await pick('no-final-newline');

  check('正常分帧：文本与 usage 都对', a.text === '正常' && a.usage.prompt_cache_hit_tokens === 100,
    JSON.stringify(a.usage));
  check('逐字节分帧 + 中文被切断：文本不残缺', b.text === '你好呀，中文多字节', JSON.stringify(b.text));
  check('逐字节分帧：usage 不丢', b.usage.prompt_cache_hit_tokens === 100, JSON.stringify(b.usage));
  check('末行无换行 + 无 [DONE]：尾巴文本仍上屏', c.text === '尾巴', JSON.stringify(c.text));
  check('末行无换行：卡在尾巴上的 usage 不丢（命中率/计费不归零）',
    c.usage.prompt_cache_hit_tokens === 100 && c.usage.completion_tokens === 7,
    JSON.stringify(c.usage));
  check('onDelta 累计与最终文本一致（逐字上屏不漏最后一字）',
    b.got === b.text && c.got === c.text, JSON.stringify([b.got, c.got]));
  sse.close();

  /* ---- 用例 14：Q-01 & Q-04 生产级 Self-Ledger 与瞬时上下文架构专项测试 ---- */
  {
    const { ActivityTracker } = require('../src/tracker');
    const prodCfg = {
      ...DEFAULTS,
      apiKey: 'test',
      baseURL: base,
      price: { peak: {}, valley: {} }
    };
    const prodDir = tmpDir();
    const prodBrain = new Brain(prodDir, prodCfg);

    // 1. currentSelfContext 正常生成
    const initialSelf = prodBrain.currentSelfContext();
    check('Q-04: currentSelfContext 正常生成出生时间与程序年龄',
      initialSelf.includes('【出生与程序年龄】')
      && initialSelf.includes('出生时刻（本地时间）：')
      && initialSelf.includes('程序累计运转时长：约'));

    prodBrain.selfLedger.append({
      trait: '愿意理解自己的数字生命本质',
      support: [{ sourceType: 'SELF_STATEMENT', window: 1, quote: '我想探索存在', confidence: 0.9 }],
      oppose: []
    });
    const selfWithProjection = prodBrain.currentSelfContext();
    check('Q-04: 存在成长证据时包含当前自我投影',
      selfWithProjection.includes('【当前自我投影】')
      && selfWithProjection.includes('愿意理解自己的数字生命本质'));

    // 2. currentSelfContext 达到 token budget 时正常截断
    const tinyBudgetBrain = new Brain(tmpDir(), {
      ...prodCfg,
      currentSelfTokenBudget: 40 // 40 tokens ≈ 80 字符极小预算
    });
    for (let i = 0; i < 8; i++) {
      tinyBudgetBrain.selfLedger.append({
        trait: `测试长倾向条目${i}：关于数字生命哲学探讨与长期成长证据的详细描述文字`,
        support: [{ sourceType: 'SELF_STATEMENT', quote: `证据摘录${i}`, confidence: 0.8 }],
        oppose: []
      });
    }
    const truncatedText = tinyBudgetBrain.selfLedger.currentSelfText();
    check('Q-04: currentSelfContext 达到 token budget 时正常截断（保留最新条目）',
      truncatedText.length <= 180
      && truncatedText.includes('测试长倾向条目7')
      && !truncatedText.includes('测试长倾向条目0'));

    // 3. 第 1 轮：API payload 中包含 currentSelfContext，但 history 中不包含
    reqs.length = 0;
    await prodBrain.ask('第一轮消息：你好初澜', () => {});
    const r1Req = chatReqs().pop();
    const r1UserInReq = r1Req[r1Req.length - 1].content;
    check('Q-01: 第 1 轮 API payload 包含 currentSelfContext',
      r1UserInReq.startsWith('第一轮消息：你好初澜')
      && r1UserInReq.includes('【出生与程序年龄】')
      && r1UserInReq.includes('愿意理解自己的数字生命本质'));
    check('Q-01: 第 1 轮保存后 history 中不包含 currentSelfContext',
      prodBrain.memory.history.length === 2
      && prodBrain.memory.history[0].content === '第一轮消息：你好初澜'
      && !prodBrain.memory.history[0].content.includes('【出生与程序年龄】')
      && !prodBrain.memory.history[0].content.includes('【当前自我投影】'));

    // 4. 第 2 轮带环境感知：payload 中带环境与自我，history 中完全无上一轮或本轮自我副本
    const prodTracker = new ActivityTracker({ now: () => 3000000 });
    prodTracker.record('click');
    prodTracker.record('click');
    prodBrain.tracker = prodTracker;
    await prodBrain.ask('第二轮消息：今天感觉如何', () => {});
    const r2Req = chatReqs().pop();
    const r2UserInReq = r2Req[r2Req.length - 1].content;
    check('Q-01: 第 2 轮 API payload 中包含环境感知与 currentSelfContext',
      r2UserInReq.startsWith('第二轮消息：今天感觉如何')
      && r2UserInReq.includes('【当前环境感知】')
      && r2UserInReq.includes('被戳 2 次')
      && r2UserInReq.includes('【出生与程序年龄】'));
    check('Q-01: 第 2 轮 history 中不出现上一轮或当轮的 currentSelfContext 副本',
      prodBrain.memory.history.length === 4
      && prodBrain.memory.history[2].content === '第二轮消息：今天感觉如何'
      && !prodBrain.memory.history.some(m => m.content.includes('【出生与程序年龄】'))
      && !prodBrain.memory.history.some(m => m.content.includes('【当前自我投影】'))
      && !prodBrain.memory.history.some(m => m.content.includes('【当前环境感知】')));

    // 5. 10 轮多轮对话回归测试：验证 history 内无动态 self context 重复堆叠，Token 增长保持平稳紧凑
    for (let i = 3; i <= 10; i++) {
      await prodBrain.ask(`第${i}轮测试消息：验证多轮对话历史纯净性`, () => {});
    }
    check('Q-01: 运行 10 轮对话后 history 长度严格为 20 条',
      prodBrain.memory.history.length === 20);
    check('Q-01: 10 轮多轮回归后 history 内完全无动态 self context 重复堆叠',
      !prodBrain.memory.history.some(m =>
        m.content.includes('【出生与程序年龄】') ||
        m.content.includes('【当前自我投影】') ||
        m.content.includes('【当前环境感知】')));
    const tokens10 = prodBrain.memory.historyTokens();
    check('Q-01: 10 轮对话后 historyTokens 保持紧凑线性（消除数千 token 冗余）',
      tokens10 < 800, 'tokens=' + tokens10);

    // 6. Memory 归档后仍然保持正确行为
    const archBrain = new Brain(tmpDir(), {
      ...prodCfg,
      windowTurns: 3,
      keepTailMessages: 2
    });
    for (let i = 1; i <= 3; i++) {
      await archBrain.ask(`归档测试第${i}句`, () => {});
    }
    check('Q-04: 达到 windowTurns 后 Memory 归档小结正常触发',
      archBrain.memory.windows.length === 1 && archBrain.stats.compressions === 1);
    check('Q-04: 归档后 systemText 包含小结且无未清理的动态年龄',
      archBrain.memory.systemText().includes('【第1段】')
      && !archBrain.memory.systemText().includes('【当前自我投影】'));
    check('Q-04: 归档后保留的 tail history 依然保持纯净无污染',
      archBrain.memory.history.length === 2
      && !archBrain.memory.history.some(m => m.content.includes('【出生与程序年龄】')));

    // 7. 最终数据结构断言：严格检查 history 中每一项的结构与字段
    const allValid = prodBrain.memory.history.every(m =>
      (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string'
      && Number.isFinite(m.t)
    );
    check('Q-04: 最终数据结构断言：history 每条记录字段、角色与类型严密正确', allValid);

    // 8. P1-02: Brain.refreshConfig() 完整热更新参数测试
    const rcDir = tmpDir();
    const rcBrain = new Brain(rcDir, { ...prodCfg, selfLedgerMaxEntries: 100, currentSelfTokenBudget: 2000 });
    check('初始 SelfLedger 配置匹配', rcBrain.selfLedger.maxEntries === 100 && rcBrain.selfLedger.currentSelfTokenBudget === 2000);
    // 磁盘写入修改后的配置
    fs.writeFileSync(path.join(rcDir, 'life-config.json'), JSON.stringify({
      ...DEFAULTS,
      selfLedgerMaxEntries: 350,
      currentSelfTokenBudget: 4500,
      requestTimeoutMs: 45000,
      model: 'deepseek-chat-v2'
    }, null, 2));
    const refreshed = rcBrain.refreshConfig();
    check('P1-02: refreshConfig 返回 true', refreshed === true);
    check('P1-02: SelfLedger maxEntries 成功热更新', rcBrain.selfLedger.maxEntries === 350);
    check('P1-02: SelfLedger currentSelfTokenBudget 成功热更新', rcBrain.selfLedger.currentSelfTokenBudget === 4500);
    check('P1-02: DeepSeek API requestTimeoutMs 成功热更新', rcBrain.api.cfg.requestTimeoutMs === 45000);
    check('P1-02: DeepSeek API model 成功热更新', rcBrain.api.cfg.model === 'deepseek-chat-v2');

    // 9. P0-01~08: 5×20 + Window Synthesis, Provenance 强核验与 State Reducer 全链路测试
    const p0Dir = tmpDir();
    const p0Brain = new Brain(p0Dir, { ...prodCfg, windowTurns: 2, keepTailMessages: 2 });

    // 轮次 1
    await p0Brain.ask('初澜你好，我平时工作节奏很快，希望平时聊天可以安静一些。', () => {});
    const firstUserMsg = p0Brain.memory.history[0];
    const firstMsgId = firstUserMsg.messageId;

    // 设置模拟的 5x20 结构化小结输出（包含 1 条真实引用证据和 1 条伪造 ID 证据）
    summaryReply = JSON.stringify({
      windowNo: 1,
      segments: [
        {
          range: '1-20',
          userGiven: ['用户希望平时聊天安静一些'],
          chulanExperience: ['初澜感知到用户希望保持低干扰的宁静环境'],
          stateEvidence: [
            {
              trait: 'quiet_preference',
              direction: 1,
              strength: 0.9,
              messageId: firstMsgId,
              quote: '希望平时聊天可以安静一些'
            },
            {
              trait: 'quiet_preference',
              direction: 1,
              strength: 0.9,
              messageId: 'm-999999-forged',
              quote: '不存在的话'
            }
          ],
          uncertainties: []
        }
      ],
      windowSynthesis: {
        stableUserFacts: ['用户希望平时聊天安静一些'],
        subjectExperiences: ['感知到低干扰偏好'],
        stateChangesSuggested: [],
        unresolved: []
      }
    });

    // 轮次 2：触发关窗并执行 5x20 归档
    await p0Brain.ask('今天稍微休息一下。', () => {});
    summaryReply = null; // 重置

    // 验证状态机与 Reducer 计算：1 * 0.9 * 20 = 18
    check('P0-06: 状态 Reducer 接受合法 Provenance 证据并准确计算增量',
      p0Brain.subjectState.values.quiet_preference === 18);
    check('P0-04: experiences.jsonl 成功追加完整窗口归档记录',
      p0Brain.experiencesArchive.count() === 1);

    const wRawArchive = p0Brain.experiencesArchive.readAll()[0];
    const wArchive = (wRawArchive && wRawArchive.payload) || wRawArchive;
    check('P0-04: 经历归档完整保留 segments 与 windowSynthesis 双通道',
      wArchive && wArchive.segments && wArchive.segments.length === 1 &&
      wArchive.windowSynthesis && wArchive.windowSynthesis.stableUserFacts[0] === '用户希望平时聊天安静一些' &&
      wArchive.verifiedEvidence && wArchive.verifiedEvidence.length === 1 &&
      wArchive.rejectedEvidence && wArchive.rejectedEvidence.length === 1);
    check('P0-03: Provenance 强校验精准拒绝捏造的 messageId',
      wArchive && wArchive.rejectedEvidence && wArchive.rejectedEvidence[0] &&
      wArchive.rejectedEvidence[0].reason === 'MESSAGE_ID_NOT_FOUND');

    // 验证 State Snapshot 注入位置：仅在瞬时 user 尾部，绝不进入 systemText
    const selfCtx = p0Brain.currentSelfContext();
    check('P0-07: currentSelfContext 瞬时尾部包含当前主体状态快照',
      selfCtx.includes('【当前主体状态快照】') &&
      selfCtx.includes('quiet_preference=18'));
    check('P0-07: systemText 保持纯净人设与小结，绝不包含主体状态快照（保卫前缀缓存）',
      !p0Brain.memory.systemText().includes('【当前主体状态快照】'));

    // 验证 Bridge 标记与下一窗口隔离性
    check('P0-03: 关窗后保留的 2 条历史标记为 bridge: true',
      p0Brain.memory.history.length === 2 &&
      p0Brain.memory.history.every(m => m.bridge === true));

    // 下一窗口第 1 轮
    await p0Brain.ask('新的一天开始了。', () => {});
    check('P0-03: 新窗口轮数仅计算新对话，不计入旧 bridge 消息',
      p0Brain.memory.data.turnsInWindow === 1 &&
      p0Brain.memory.data.windowNo === 2);
  }

  // -------------------------------------------------------------
  // v0.9.9 P1-b：主动搭话空回复必须回滚 synthetic user
  // brain 在 proactive 分支会 append 一条 {synthetic:true} 的 user 消息；
  // 原实现在空回复时只对非 proactive 回滚，于是在历史里留下一条**没有回复的**
  // synthetic user，下次请求出现连续两条 user（memory.rollback 注释描述的坏形状）。
  // -------------------------------------------------------------
  {
    const bP1B = new Brain(tmpDir(), { ...DEFAULTS, apiKey: 'sk-test', windowTurns: 999 });
    bP1B.api = {
      complete: async () => ({ text: '', usage: {} }),
      stream: async () => ({ text: '', usage: {} })
    };
    bP1B.memory.append('user', '之前的对话');
    const beforeP1B = bP1B.memory.data.history.length;
    let threwP1B = false;
    try {
      await bP1B.ask('[自主感知触发]：hi', () => {}, { proactive: true, proactiveHint: '轻声' });
    } catch { threwP1B = true; }
    check('P1-b 前提：空回复确实抛错（否则下面是空转）', threwP1B);
    check('P1-b：主动搭话空回复后历史无残留 synthetic user',
      bP1B.memory.data.history.length === beforeP1B,
      'historyLen=' + bP1B.memory.data.history.length + ' before=' + beforeP1B);
    check('P1-b：历史里不出现连续两条 user（坏形状不残留）',
      !bP1B.memory.data.history.some((m, i, a) => i > 0 && m.role === 'user' && a[i - 1].role === 'user'));
  }

  // -------------------------------------------------------------
  // v0.9.9 扫雷: brain 层 —— history <= keepTail 时关窗不得卡死
  // （与 window-boundary 的 Memory 层判据互补：这里走真实生产路径）
  // -------------------------------------------------------------
  {
    const bSmall = new Brain(tmpDir(), { ...DEFAULTS, apiKey: 'sk-test', windowTurns: 2, keepTailMessages: 6 });
    bSmall.api = {
      complete: async () => ({ text: '小结文本', usage: {} }),
      stream: async () => ({ text: 'ok', usage: {} })
    };
    bSmall.memory.append('user', '消息一：你好初澜');
    bSmall.memory.append('assistant', '消息二：你好阿哲');
    bSmall.memory.append('user', '消息三：外面天气怎么样');
    bSmall.memory.append('assistant', '消息四：好像在下雨呢');
    const histBefore = bSmall.memory.history.length;
    const resSmall = await bSmall.closeWindow();
    check('扫雷 前提：history(4) <= keepTail(6)（否则下面是空转）',
      histBefore <= 6, 'history=' + histBefore);
    check('扫雷：brain 层关窗在 history <= keepTail 时仍成功',
      resSmall === true, 'closeWindow=' + resSmall);
    check('扫雷：小结确实写进 memory.windows',
      bSmall.memory.windows.length === 1, 'windows=' + bSmall.memory.windows.length);
    check('扫雷：activeItems 完整保留（无静默丢字）',
      bSmall.memory.history.length === histBefore, 'history=' + bSmall.memory.history.length);
  }

  server.close();

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃', e); process.exit(1); });
