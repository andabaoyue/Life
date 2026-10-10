/**
 * test/d11-self-note.test.js
 *
 * D-11 门禁：她想留下点什么 —— 那个文件的内容从哪来。
 *
 * ## 这一轮补的是 D-10 留下的缺口
 *
 *   D-10 接通了「建案 → 卡片 → 执行」，但 **content 一直没有来源**。
 *   本轮的答案是：**她自己组织一句话**（brain.askForSelfNote）。
 *
 * ## 用户拍板的设计
 *
 *   用户原话：「不如，让她把她的愿望写进去」
 *   ⇒ 不是把用户的话存下来，是**她为自己写一句**。
 *
 * ## 覆盖的三类反例
 *
 *   ① 漏传参数：无 api / 无 text / 空 text —— 一律 null，不许编
 *   ② 恶意变体：超长内容、她说「不」、异常抛出 —— 不许建案、不许崩
 *   ③ 边界值：拒绝词的长度边界、内容长度护栏
 *
 * ⚠️ 本文件**不真调 LLM**（用替身 api）。真实端到端由用户实机验证，
 *   这一点如实写在报告里，不冒充已验证。
 */

const path = require('path');
const { Brain } = require('../src/brain');
const { TriggerEngine, computeSelfIntent, SELF_INTENT_KINDS } = require('../src/trigger');
const fs = require('fs');
const os = require('os');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
const _d11Dirs = [];
const _d11OrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d11OrigMkdtemp.apply(fs, a);
  _d11Dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d11Dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d11OrigMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/** 造一个只替换 api.complete 的 Brain —— 目标方法只依赖它。 */
function brainWith(completeImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
  const b = new Brain(dir, { apiKey: 't', model: 'm', baseURL: 'http://127.0.0.1:1' });
  b.api = { complete: completeImpl };
  b.track = () => {};
  return b;
}

console.log('--- D-11 她想留下点什么门禁 ---');

/* ============ 1. 新意图类别的存在与分层 ============ */
{
  check('SELF_INTENT_KINDS 登记了 wantToLeaveSomething',
    !!SELF_INTENT_KINDS.wantToLeaveSomething);
  check('它的阈值是 120 分钟（高于 idleness 两档，防止安静久一点就想写文件）',
    SELF_INTENT_KINDS.wantToLeaveSomething.min === 120,
    String(SELF_INTENT_KINDS.wantToLeaveSomething.min));
  check('它的来源是 tracker（既有客观事实，不新造状态机）',
    SELF_INTENT_KINDS.wantToLeaveSomething.requires === 'idleness_minutes');

  const at119 = computeSelfIntent({ traits: {}, idleMinutes: 119 });
  const at120 = computeSelfIntent({ traits: {}, idleMinutes: 120 });
  check('❌ 边界：119 分钟不产该意图（阈值不偏移）',
    !at119 || at119.kind !== 'wantToLeaveSomething', at119 && at119.kind);
  check('❌ 边界：恰好 120 分钟产该意图',
    at120 && at120.kind === 'wantToLeaveSomething', at120 && at120.kind);
  check('🔴 深静默时它优先于 idleness（否则 130 分钟的安静只会得到「说一句安静」）',
    computeSelfIntent({ traits: {}, idleMinutes: 130 }).kind === 'wantToLeaveSomething');
  check('50 分钟仍走 idleness_deep（阈值分层没被压平）',
    computeSelfIntent({ traits: {}, idleMinutes: 50 }).kind === 'idleness_deep');
}

/* ============ 2. 反例①：漏传参数 ============ */
{
  void (async () => {
    const noApi = new Brain(fs.mkdtempSync(path.join(os.tmpdir(), 'd11-')), { apiKey: 't', model: 'm', baseURL: 'x' });
    noApi.api = {};
    check('❌ 反例：api 没有 complete 时返回 null（不抛）',
      (await noApi.askForSelfNote({})) === null);
  })();

  void (async () => {
    const b = brainWith(async () => ({ text: '', usage: null }));
    check('❌ 反例：她回空串 → null（不建案）', (await b.askForSelfNote({})) === null);
  })();

  void (async () => {
    const b = brainWith(async () => ({}));
    check('❌ 反例：返回体缺 text 字段 → null', (await b.askForSelfNote({})) === null);
  })();
}

/* ============ 3. 反例②：她说「不」= 合法结果 ============ */
{
  const refusals = ['不', '不想', '不了', '算了吧', '算了', '没有', '没什么想留'];
  refusals.forEach((r) => {
    void (async () => {
      const b = brainWith(async () => ({ text: r, usage: null }));
      check('❌ 反例：她说「' + r + '」→ null（不想留是合法结果，不是失败）',
        (await b.askForSelfNote({})) === null);
    })();
  });

  // 🔴 边界：拒绝判据必须**只认短句开头**，不能用「含不含某词」的大网 ——
  //   否则「不想留遗憾」这类正常句子会被误判成拒绝。
  void (async () => {
    const b = brainWith(async () => ({ text: '不想留遗憾，所以还是写点什么吧', usage: null }));
    check('❌ 边界：长句中含「不想」**不算**拒绝（判据只看极短句的开头）',
      (await b.askForSelfNote({})) !== null);
  })();
}

/* ============ 4. 反例③：长度护栏与异常 ============ */
{
  void (async () => {
    const long = '啊'.repeat(601);
    const b = brainWith(async () => ({ text: long, usage: null }));
    check('❌ 反例：超长内容（>600）→ null（它跑偏了，在写文章不是留话）',
      (await b.askForSelfNote({})) === null);
  })();

  void (async () => {
    const ok = '啊'.repeat(600);
    const b = brainWith(async () => ({ text: ok, usage: null }));
    check('❌ 边界：恰好 600 字符放行（阈值不偏移）',
      (await b.askForSelfNote({})) !== null);
  })();

  void (async () => {
    const b = brainWith(async () => { throw new Error('网络炸了'); });
    check('❌ 反例：调用抛异常 → null（旁路异常一律吞掉，不崩）',
      (await b.askForSelfNote({})) === null);
  })();
}

/* ============ 5. 正常通路：内容原样返回 ============ */
{
  void (async () => {
    const text = '今天安静得很久，我想留一句话在这儿。';
    const b = brainWith(async () => ({ text, usage: { total: 1 } }));
    const r = await b.askForSelfNote({ intentKind: 'wantToLeaveSomething' });
    check('正常：她的原话原样成为 content（不加工、不截断）',
      r && r.content === text, r && r.content);
  })();
}

/* ============ 6. 防漂移：主进程侧的接线仍在 ============ */
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('❌ main.js 有 maybeAskForSelfNote（否则 content 永远无来源）',
    mainSrc.includes('function maybeAskForSelfNote('));   // 🔵 D-15：签名改为 (selfIntent)，匹配不带右括号
  check('❌ 它只在 wantToLeaveSomething 时跑（防止安静久了就写文件）',
    mainSrc.includes("intent.kind !== 'wantToLeaveSomething'"));
  check('❌ 主进程暂存内容且取用即删（重放不许重复写）',
    mainSrc.includes('pendingSelfNoteContent.delete(id)'));
  check('❌ main.js 把 takeStashedContent 注入了 agentIpc',
    mainSrc.includes('takeStashedContent }'));

  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-ipc.js'), 'utf8');
  check('🔴 execute 通道优先用主进程暂存内容，无视渲染端传的（防渲染端改写她的话）',
    ipcSrc.includes('const effectiveContent = stashed !== null && stashed !== undefined'));
  check('🔴 未注入 takeStashedContent 时退回原行为（等价于 D-10）',
    ipcSrc.includes('? takeStashedContent') && ipcSrc.includes(': null;'));
}

console.log('');
console.log('失败 ' + failures + ' 项');
process.exitCode = failures ? 1 : 0;
