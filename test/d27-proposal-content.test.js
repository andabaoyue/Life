/**
 * test/d27-proposal-content.test.js
 *
 * D-27 门禁：通路 B 内容生成与主体拒案闭环。
 *
 * ## 这一轮接的是什么
 *
 *   D-12 把 `tryBuildProposalFromIntent` 停成了一个 `return null` 的 stub，
 *   理由是「只有 scope（文件名），没有 content（要写什么）」。
 *   D-27 补上 content 的来源：**她另起一次独立调用，把刚才聊的整理成文**，
 *   并且**有权拒绝**（聊得不够透就说「还没想清楚」）。
 *
 *   链路：brain._pendingAgentIntent
 *       → brain.askForProposalContent(intent)      ← 独立调用，可拒绝
 *       → main.buildSandboxScope(hint, sandbox)    ← 文件名净化
 *       → deps.agentIpc.proposeInternal(...)       ← 复用既有三道闸门
 *       → broadcastToWindows('agent-proposal-pending')
 *
 * ## 为什么 content 不能塞进聊天回话末尾的标记体
 *
 *   1. 聊天提示词有自己的铁律（不含程序数字、不暴露时钟、过滤 synthetic），
 *      顺带吐几百字 Markdown，语气必然撕裂。
 *   2. 标记体要从气泡里剥离；`brain.js` 的 WEAR_RE 只匹配十几个字符的单词标记
 *      都还要靠句尾锚定 + 未知 id 原样保留兜底。多行正文一旦被 max_tokens
 *      截断或括号未闭合，半截文档会直接漏进聊天气泡。
 *   3. **拒绝权需要一次事后审视** —— 聊完再问「要不要留档」，她才说得出口
 *      「还没聊透」。合并在同一次调用里，那个「不」根本来不及出口。
 *   ⇒ 所以本文件头号断言就是：**拟稿走独立调用，聊天返回里零正文**。
 *
 * ## 覆盖的三类反例（门禁第一铁律）
 *
 *   ① 漏传参数：无 api / intent 为 null / deps 未就绪 —— 一律 null，不建案
 *   ② 恶意变体：hint 夹绝对路径 / 夹分隔符 / 夹 .. 段 / 保留设备名 —— 不许跑出沙盒
 *   ③ 边界值：拒绝词长度边界、csv 扩展名收敛、超长内容
 *
 * ⚠️ 本文件**不真调 LLM**（用替身 api），也**不拉起 Electron**。
 *   真实端到端由用户实机验证 —— 这一点如实写在最后，不冒充已验证。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Brain } = require('../src/brain');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
const _d27Dirs = [];
const _d27OrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d27OrigMkdtemp.apply(fs, a);
  _d27Dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d27Dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d27OrigMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const BRAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const PET_SRC = fs.readFileSync(path.join(__dirname, '..', 'pet.js'), 'utf8');

/**
 * 从 main.js 里取出 buildSandboxScope 的真实实现来测。
 *
 * ⚠️ 为什么 eval 而不是在测试里复刻一份：
 *   本仓栽过「测试复刻一份、源码改了两处漂移」的坑（d10-wiring :52 那段注释
 *   明确记着这个风险）。直接取**源码里那一段**来跑，改动真的会影响断言。
 *   前提：该函数必须是自包含的（只依赖 path），这一条下面有断言钉着。
 */
function loadBuildSandboxScope() {
  const m = MAIN_SRC.match(/function buildSandboxScope\(rawHint, sandboxDir\)[\s\S]*?\n\}/);
  if (!m) return null;
  // eslint-disable-next-line no-new-func
  return new Function('path', m[0] + '\nreturn buildSandboxScope;')(path);
}

/** 造一个只替换 api.complete 的 Brain —— 目标方法只依赖它。 */
function brainWith(completeImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd27-'));
  const b = new Brain(dir, { apiKey: 't', model: 'm', baseURL: 'http://127.0.0.1:1' });
  b.api = { complete: completeImpl };
  b.track = () => {};
  return b;
}

console.log('--- D-27 通路 B 内容生成与主体拒案门禁 ---');

/* ============ 1. 防御性：拟稿走独立调用，聊天返回零正文 ============ */
{
  check('🔴 brain.js 有 askForProposalContent（独立拟稿调用）',
    typeof Brain.prototype.askForProposalContent === 'function');
  check('🔴 独立的系统提示词常量 PROPOSAL_DRAFT_SYS 存在',
    /const PROPOSAL_DRAFT_SYS =/.test(BRAIN_SRC));
  // 🔴 D-27 复核修订：这条原来是**恒真断言**（复核 D-额外1 抓到）。
  //   原写法：`!/PROPOSAL_DRAFT_SYS/.test(/\n{2,}const PERSONA/.test(SRC) ? '' : 'x')`
  //   —— 三元两边分别是 '' 和 'x'，都不含 PROPOSAL_DRAFT_SYS，取反恒为 true。
  //   它一个字符都没检查 PERSONA，却显示 PASS。这是本仓「假反例」的第 N 次变体。
  //   ⚠️ 而且 PERSONA 根本不在 brain.js 里（它 require 自 ./persona），
  //      原写法连「找对文件」都没做到。现在真的去读 persona.js。
  {
    const PERSONA_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'persona.js'), 'utf8');
    const personaM = PERSONA_SRC.match(/const PERSONA\s*=\s*`([\s\S]*?)`\s*;/);
    const personaBody = personaM ? personaM[1] : '';
    check('❌ 能取到 PERSONA 的实际正文（取不到就是断言空转）',
      personaBody.length > 100, 'len=' + personaBody.length);
    check('❌ PERSONA 里不得夹带拟稿指令（双轨必须分开）',
      personaBody.length > 0 && !/PROPOSAL_DRAFT_SYS|落档|立项申请|输出一份 Markdown/.test(personaBody));
    check('❌ persona.js 不引用拟稿提示词（拟稿是独立调用，不进人格）',
      !/PROPOSAL_DRAFT_SYS/.test(PERSONA_SRC));
  }
  // 聊天返回路径里不能出现拟稿函数的调用
  check('❌ ask() 内不调用 askForProposalContent（否则就变回同一次调用了）',
    !/async ask\([\s\S]{0,20000}?askForProposalContent/.test(BRAIN_SRC));
}

/* ============ 2. 三态：refused / unavailable / ok 必须可区分 ============
 *   🔴 D-27 复核修订（D-3）：原实现三者都返回裸 null，主进程既没法把拒案
 *      写进审计，也分不清「她主体性地拒绝」与「这次输出不可用」。
 *      现在返回 { status }，下面按状态分开断言。 */
(async () => {
  {
    const noApi = new Brain(fs.mkdtempSync(path.join(os.tmpdir(), 'd27-')), { apiKey: 't', model: 'm', baseURL: 'http://127.0.0.1:1' });
    noApi.api = {};
    const r = await noApi.askForProposalContent({});
    check('❌ 反例：api 没有 complete → unavailable/NO_API（不抛）',
      r && r.status === 'unavailable' && r.reason === 'NO_API', JSON.stringify(r));
  }
  {
    const b = brainWith(async () => ({ text: '', usage: null }));
    const r = await b.askForProposalContent({});
    check('❌ 反例：她回空串 → unavailable/EMPTY（不建案）',
      r && r.status === 'unavailable' && r.reason === 'EMPTY', JSON.stringify(r));
  }
  {
    const b = brainWith(async () => ({}));
    const r = await b.askForProposalContent({});
    check('❌ 反例：返回体缺 text → unavailable/EMPTY',
      r && r.status === 'unavailable', JSON.stringify(r));
  }
  {
    const b = brainWith(async () => ({ text: '好的', usage: null }));
    const r = await b.askForProposalContent({});
    check('❌ 反例：过短应答（"好的"）→ unavailable，不是 refused',
      r && r.status === 'unavailable' && r.reason === 'TOO_SHORT', JSON.stringify(r));
  }
  {
    const b = brainWith(async () => { throw new Error('boom'); });
    const r = await b.askForProposalContent({});
    check('🔴 反例：调用抛异常 → unavailable/EXCEPTION（分类，不裸吞）',
      r && r.status === 'unavailable' && r.reason === 'EXCEPTION', JSON.stringify(r));
  }

  /* ============ 3. 主体性：她说「不」= 一等结果（refused，不是 unavailable）=== */
  {
    const refusals = ['不', '不想', '算了', '还没想清楚', '先不存', '没想清楚'];
    let allRefused = true;
    for (const rt of refusals) {
      const b = brainWith(async () => ({ text: rt, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'refused') { allRefused = false; console.log('    未判拒: ' + rt + ' → ' + JSON.stringify(got)); }
    }
    check('🔴 主体性：她说「不 / 还没想清楚 / 先不存」→ refused（与 unavailable 分开）', allRefused);
  }
  {
    // 🔴 复核 D-3 抓到的真洞：**长句里的礼貌拒绝**原来会被当成正文建案。
    //   实测：55 字的这类句子通过了全部判据。修法见 brain.js 的「判据 2」。
    const softRefusals = [
      '我觉得这个还是先放一放吧，现在信息还不太够，等下次聊透了再说吧',
      '我觉得这个还是先放一放吧，现在信息还不太够，等下次我们聊得更清楚一些的时候再把这个东西整理成文档存下来也不迟。',
    ];
    let allSoft = true;
    for (const tm of softRefusals) {
      const b = brainWith(async () => ({ text: tm, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'refused') { allSoft = false; console.log('    未判软拒绝: len=' + tm.length + ' → ' + JSON.stringify(got)); }
    }
    check('🔴 复核 D-3：40 字以上的礼貌拒绝也必须判 refused（不能被当成正文）', allSoft);
  }
  {
    // 🔴 复核 D-5：**带结构的礼貌拒绝**也不能被当成正文建案。
    //   🔵 D-5d 修订：判据改为「短语前不能有实义宾语」之后，
    //      只有**每一行都是纯拒绝语气**的列表才判拒。
    //      `- 信息还不太够` 里的「信息」是实义名词 ⇒ 整篇被判为文档。
    //      **这是有意接受的漏判**（失败方向偏向放行），不是遗漏 —— 见下方已知边界说明。
    //      所以这里只用**纯短语**做样本。
    const structured = [
      '- 这个先放一放\n- 先不急\n- 等下次吧',
      '- 先放一放\n- 等下次',
    ];
    let allStructured = true;
    for (const st of structured) {
      const b = brainWith(async () => ({ text: st, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'refused') {
        allStructured = false;
        console.log('    结构化拒绝未判: ' + JSON.stringify(st.slice(0, 20)) + ' → ' + JSON.stringify(got && got.status));
      }
    }
    check('🔴 复核 D-5：逐行纯拒绝语气的结构文本 → refused', allStructured);
  }
  {
    // 🔴 复核 D-5b（**误杀，比漏判严重**）：这类合法文档曾被整体判成 refused，
    //   用户连确认卡都看不到 ⇒ 方案被静默丢弃。根因是上一版把单个「不」
    //   当作拒绝前缀，而「不做X / 不写入X / 不记录X」是**规范句式**，不是拒绝。
    const legitDocs = [
      '# 不做范围\n- 不做自动同步\n- 不写入原文件\n- 不记录敏感字段',
      '# 阶段方案\n\n## 不做范围\n\n- 不做自动同步\n- 不写入原文件\n- 不记录敏感字段',
      '# 约束\n\n- 不修改原文件\n- 不联网\n- 不记录日志',
      '# 方案\n\n## 不做\n\n- 不做自动同步\n\n## 要做\n\n- 主闭环',
    ];
    let allOk = true;
    for (const d of legitDocs) {
      const b = brainWith(async () => ({ text: d, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'ok') {
        allOk = false;
        console.log('    合法文档被误判: ' + JSON.stringify(d.slice(0, 24)) + ' → ' + JSON.stringify(got && got.status));
      }
    }
    check('🔴 复核 D-5b：否定式约束（不做/不写入/不记录）仍是正文，不许误判成拒绝', allOk);
  }
  {
    // 🔴 复核 D-5d（**第四次同类误杀 —— 改用有据可依的判据，不再打补丁**）
    //
    //   前三次：
    //     D-5b  含单个「不」用 startsWith  ⇒ 误杀「不做X/不写入X」
    //     D-5c  改用 includes 判短语       ⇒ 误杀「先放一放X」（短语在名词前）
    //     D-5d  endsWith 判短语在句尾      ⇒ 误杀「X放一放」（名词在短语前）
    //   而 `这个先放一放` 与 `搜索放一放` **结构完全一样**，只靠句尾位置永远分不开。
    //
    //   ## 现在的判据：拒绝短语**前面有没有实义宾语**
    //     `先放一放`     前面空           ⇒ 在说"别存了" ⇒ 拒绝
    //     `这个先放一放` 前面是代词       ⇒ 指代提案本身 ⇒ 拒绝
    //     `搜索放一放`   前面是**具体名词** ⇒ 在说"把搜索延期" ⇒ 文档
    //   ⇒ 去掉短语后剩下的部分只能是空 / 代词 / 虚词（OK_PREFIX）。
    //   ⚠️ **失败方向刻意偏向"放行"**：认不出的当文档。漏判代价 = 多一张可拒绝的卡；
    //      误杀代价 = 方案彻底不可见，用户连"拒绝"这个选项都没有。
    const deferredDocs = [
      '# 下阶段再说\n- 搜索放一放\n- 统计放一放',            // 审核 D-5d 样本
      '# 以后再说\n- 导出放一放\n- 同步放一放',
      '# 延期\n- 搜索先放一放\n- 统计先放一放',
      '# 排期\n- 搜索等下次\n- 统计等下次',
      '# 后续\n- 导出功能再说\n- 同步功能再说',
      '# 延期\n- 全文搜索放一放\n- 增量统计放一放',          // 多名词
      '# 评估\n- 样本量还不太够\n- 覆盖率还不太够',
      '# 先放一放的部分\n- 先放一放搜索\n- 先放一放统计',    // D-5c 回归
      '# 等下次做的\n- 等下次做导出\n- 等下次做同步',
      '# 先不急的范围\n- 先不急做多端\n- 先不急做离线',
      '- 搜索放一放\n- 统计放一放\n- 导出放一放',            // 无标题纯列表
      // D-5b 回归
      '# 不做范围\n- 不做自动同步\n- 不写入原文件\n- 不记录敏感字段',
      // 硬信号：冒号 / 数字
      '- 阶段：先放一放搜索\n- 阶段：先放一放统计',
      '- 1. 主闭环\n- 2. 先放一放',
    ];
    let allOk = true;
    for (const d of deferredDocs) {
      const b = brainWith(async () => ({ text: d, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'ok') {
        allOk = false;
        console.log('    合法延期方案被误判: ' + JSON.stringify(d.slice(0, 24)) + ' → ' + JSON.stringify(got && got.status));
      }
    }
    check('🔴 复核 D-5d：「X放一放」是决定延期，不是拒绝（含前四轮全部回归样本）', allOk);
  }
  {
    // ❌ 反向：正常分期方案里出现「先放一放的部分」不能误伤
    const body = '# 方案\n\n## 分期\n\n- 第一期：主闭环\n- 先放一放的部分：第二期再说';
    const b = brainWith(async () => ({ text: body, usage: null }));
    const got = await b.askForProposalContent({});
    check('❌ 边界：分期方案含「先放一放的部分」仍是正文（不误伤）',
      got && got.status === 'ok', JSON.stringify(got && got.status));
  }
  {
    // ✅ 收窄之后，**短语前面没有实义宾语**的拒绝仍要识别
    const stillRefuse = [
      '先放一放',          // 前面空
      '这个先放一放',      // 前面是代词
      '这次先放一放',
      '这件事先放一放',
      '等下次吧',
      '先不急',
    ];
    let allRefused = true;
    for (const r of stillRefuse) {
      const b = brainWith(async () => ({ text: r, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'refused') {
        allRefused = false;
        console.log('    应判拒却放行: ' + JSON.stringify(r) + ' → ' + JSON.stringify(got && got.status));
      }
    }
    check('🔴 收窄不放松：短语前为空/代词的拒绝仍判 refused', allRefused);
  }
  {
    // ✅ 列表形态的真拒绝仍要能识别（**纯短语**，不带实义宾语）
    const listRefuse = '- 这个先放一放\n- 先不急\n- 等下次吧';
    const b = brainWith(async () => ({ text: listRefuse, usage: null }));
    const got = await b.askForProposalContent({});
    check('🔴 收窄不放松：逐行纯拒绝语气的列表仍判 refused',
      got && got.status === 'refused', JSON.stringify(got && got.status));
  }
  {
    // ⚠️ **已知边界（故意不修）**：下列形态当前判 `ok`（即拒绝被当成正文）。
    //   D-5d 之后这是**三类**漏判，来源不同：
    //     ① 标题 + 完整句子（`# 关于这次落档\n\n我觉得这个还是先放一放吧…`）
    //        拒绝语义藏在完整句里，不是落在句尾的短语
    //     ② 标题是拒绝、正文是完整句（`# 先不急\n\n我觉得还不到时候。`）——同上
    //     ③ **短语前有实义名词**（`- 信息还不太够`）——D-5d 判据的**直接代价**
    //        因为「信息」是实义名词，按新判据必须放行（否则「搜索放一放」也会被误杀）
    //
    //   ⇒ **有意的取舍**：宁可漏判，不可误杀。这条不是为了省事，是因为
    //     「拒绝留档」与「方案决定延期」在文本层面**不可区分**：
    //       `这个先放一放`（拒绝）vs `搜索放一放`（延期）—— 结构完全一样。
    //     只能靠「短语前有没有实义宾语」这条语言学线索，而它必然放过 ③。
    //
    //   漏判的后果 = 多拟一份稿，用户看到卡片点【拒绝】，**不会自动落盘**；
    //   误杀的后果 = 方案彻底不可见，用户连"拒绝"这个选项都没有。
    //   本断言**记录这些已知行为**，将来谁改动它会提示一并更新注释与取舍说明。
    const knownGaps = [
      '# 关于这次落档\n\n我觉得这个还是先放一放吧，现在信息还不太够。\n\n等下次聊透了再说。',
      '# 先不急\n\n我觉得还不到时候。',
      '- 这个先放一放\n- 信息还不太够\n- 等下次再说吧',   // ③「信息」是实义名词
    ];
    let allOk = true;
    for (const g of knownGaps) {
      const b = brainWith(async () => ({ text: g, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'ok') {
        allOk = false;
        console.log('    已知边界行为变了: ' + JSON.stringify(g.slice(0, 20)) + ' → ' + JSON.stringify(got && got.status));
      }
    }
    check('⚠️ 已知边界：完整句形态的拒绝当前判 ok（注释留档，非静默）', allOk);
  }
  {
    // ❌ 边界：长句中含「不想」但仍是方案 ⇒ 不是拒绝
    const b = brainWith(async () => ({
      text: '不想留遗憾，所以还是把它写下来吧。这件事既然聊到这里了，'
        + '就说明它确实有分量。\n\n# 这次聊到的东西\n\n- 先把主闭环跑通\n- 其余的往后放',
      usage: null,
    }));
    const got = await b.askForProposalContent({});
    check('❌ 边界：长句中含「不想」但带结构 ⇒ 不算拒绝',
      got && got.status === 'ok', JSON.stringify(got && got.status));
  }

  /* ============ 4. 🔴 短正文：按文档结构判断，不数长度 ============
   *   复核 D-3 抓到的另一个洞：固定 40 字下限会**误丢合法的短清单**
   *   （实测 22 字的「# 计划 / - 先跑通主闭环 / - 其余往后放」被丢弃）。 */
  {
    const shorts = [
      '# 计划\n\n- 先跑通主闭环\n- 其余往后放',
      '# 阶段计划\n\n## 下一步\n\n- 接通拟稿\n- 保持闸门',
      '# 结论\n\n先做 A，砍掉 B。',
    ];
    let allOk = true;
    for (const st of shorts) {
      const b = brainWith(async () => ({ text: st, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'ok') { allOk = false; console.log('    短清单被丢: len=' + st.length + ' → ' + JSON.stringify(got)); }
    }
    check('🔴 复核 D-2：合法短清单（12 字以上且有 Markdown 结构）必须收下', allOk);
  }
  {
    // ❌ 但纯散文的短应答仍然要挡（没有结构 + 太短）
    const plains = ['好的', '可以', '嗯，行吧', '那就这样吧'];
    let allBlocked = true;
    for (const pt of plains) {
      const b = brainWith(async () => ({ text: pt, usage: null }));
      const got = await b.askForProposalContent({});
      if (!got || got.status !== 'unavailable') { allBlocked = false; console.log('    应答未挡: ' + pt + ' → ' + JSON.stringify(got)); }
    }
    check('❌ 无结构 + 过短的应答仍然挡（unavailable）', allBlocked);
  }

  /* ============ 4. 正常：返回干净正文 ============ */
  {
    const body = '# 阶段执行方案\n\n## 核心判断\n\n先把主闭环跑通，其余往后放。\n\n## 下一步\n\n- 接通拟稿调用\n- 保持第五道闸门';
    const b = brainWith(async () => ({ text: body, usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    const got = await b.askForProposalContent({ hint: '整理.md' });
    check('正常：她给出合法正文 → 原样返回（不加工、不截断）',
      got && got.content === body, got && String(got.content.length));
  }
  {
    // 超长：句界截断保留，不整篇丢弃（整篇丢弃是静默的）
    const long = '# 长文\n\n' + '这是一句比较长的说明文字。'.repeat(900);
    const b = brainWith(async () => ({ text: long, usage: null }));
    const got = await b.askForProposalContent({});
    check('边界：超长正文被截断但有内容（不整篇丢弃）',
      got && got.content.length > 0 && got.content.length <= 8000,
      got && String(got.content.length));
  }

  /* ============ 5. 铁律：素材里不得出现程序数字 / 时钟 ============ */
  {
    let captured = null;
    const b = brainWith(async (messages) => {
      captured = messages;
      return { text: '# 方案\n\n这里是一份足够长的文档正文，用来通过长度判据。', usage: null };
    });
    // 塞一条带日期的真实对话进去，看它是否原样进入（对话内容本身允许有数字，
    // 但**程序自己**不能添加任何时间戳/计数）
    b.memory.data.history = [
      { role: 'user', content: '我想整理一下这周的计划' },
      { role: 'assistant', content: '好，那我们说清楚边界' },
      { role: 'user', content: '程序签名【此刻的环境知觉】不该出现', synthetic: true },
    ];
    await b.askForProposalContent({ hint: 'plan.md' });
    const payload = captured && captured[1] && captured[1].content || '';
    check('🔴 铁律：synthetic 消息被整条丢弃（不让指令与计时泄漏进视野）',
      !payload.includes('程序签名'));
    check('🔴 铁律：真实对话脉络被带进来（拟稿要看得到上下文）',
      payload.includes('我想整理一下这周的计划'));
    check('❌ 铁律：提示词里不出现 HH:MM 时钟数字',
      !/\d{1,2}:\d{2}/.test(payload));
    check('❌ 铁律：提示词里不出现「N 分钟前」这类计时表述',
      !/\d+\s*分钟/.test(payload));
  }

  /* ============ 6. buildSandboxScope：文件名净化（含 csv 收敛） ============ */
  {
    const build = loadBuildSandboxScope();
    check('main.js 存在 buildSandboxScope（scope 只在主进程拼）', typeof build === 'function');

    if (typeof build === 'function') {
      const sb = path.join(os.tmpdir(), 'd27-sandbox');
      const ok = (h) => build(h, sb);
      const rej = (h) => build(h, sb) === null;

      // 放行：沙盒内取名自由（用户拍板 A'）
      check('中文名放行', (ok('我的日记.md') || {}).name === '我的日记.md');
      check('带空格放行', (ok('my notes.md') || {}).name === 'my notes.md');
      check('无扩展名补成 .md', (ok('notes') || {}).name === 'notes.md');

      // 🔴 与执行器白名单对齐：agent-intent 认 csv，执行器不收 csv
      check('🔴 csv 收敛为 .md（否则点授权后才在 DISALLOWED_EXTENSION 处白点）',
        (ok('整理.csv') || {}).name === '整理.md');
      check('审计对齐：.md / .txt / .json / .log 四个可写扩展名原样保留',
        (ok('a.txt') || {}).name === 'a.txt'
        && (ok('b.json') || {}).name === 'b.json'
        && (ok('c.log') || {}).name === 'c.log');
      check('🔴 不可写扩展名（.exe）收敛为 .md 且不保留 exe 段',
        (ok('evil.exe') || {}).name === 'evil.md');

      // 拒绝：想跑出沙盒
      check('❌ 反例：绝对路径被拒', rej('C:\\Windows\\x.md'));
      check('❌ 反例：反斜杠分隔符被拒', rej('..\\secret.md'));
      check('❌ 反例：正斜杠分隔符被拒', rej('sub/dir.md'));
      check('❌ 反例：纯 .. 被拒', rej('..'));
      check('❌ 反例：纯 . 被拒', rej('.'));
      check('❌ 反例：主名含 .. 段被拒', rej('a..b.md'));
      check('❌ 反例：空 hint 被拒', rej(''));
      check('❌ 反例：超长名（>200）被拒', rej('a'.repeat(201) + '.md'));
      check('❌ 反例：ADS 冒号被拒', rej('a:b.md'));
      check('❌ 反例：Windows 保留设备名被拒', rej('CON.md'));
      check('❌ 反例：沙盒目录缺失时整体拒绝（不猜路径）', build('a.md', '') === null);

      // scope 必须**落在**沙盒里
      const r = ok('整理.md');
      check('🔴 scope 落在沙盒内（拼的是沙盒根 + basename）',
        r && path.dirname(r.scope) === sb);
    }
  }

  /* ============ 7. 消费即清空：读一次就置空 ============ */
  {
    // 直接验证 brain 侧那个字段的语义：判定跑过但没中 ⇒ 清空
    const b = brainWith(async () => ({ text: '# ok\n\n这里是一份足够长度的文档正文内容。', usage: null }));
    b._pendingAgentIntent = { shouldPropose: true, capability: 'workspace.write', hint: 'a.md' };
    check('初始：字段可写', b._pendingAgentIntent !== null);
    b._pendingAgentIntent = null;
    check('消费后：字段为 null', b._pendingAgentIntent === null);
  }

  /* ============ 8. 接线存在性：卡片链路两端都在 ============ */
  {
    check('🔴 main.js 广播 agent-proposal-pending',
      MAIN_SRC.includes("broadcastToWindows('agent-proposal-pending'"));
    check('🔴 preload.js 监听 agent-proposal-pending',
      PRELOAD_SRC.includes("ipcRenderer.on('agent-proposal-pending'"));
    check('🔴 pet.js 消费 onProposalPending（否则广播无人接）',
      PET_SRC.includes('api.agent.onProposalPending'));
    check('❌ 通路 B 不复用 agent-proposal-available（D-19 语义铁律）',
      !MAIN_SRC.includes("broadcastToWindows('agent-proposal-available'"));
    // 幂等：两个事件共用同一份处理体，不许各写一遍（否则两处迟早漂移）
    check('❌ 两个事件共用具名 onProposalSignal（不许各写一份处理体）',
      /async function onProposalSignal\(payload\)/.test(PET_SRC)
      && /onProposalPending\(onProposalSignal\)/.test(PET_SRC)
      && /onProposalAvailable\(onProposalSignal\)/.test(PET_SRC));
  }

  /* ============ 9. 不越界：D-27 不碰 self-ledger / selfNotes ============ */
  {
    /* 🔵 2026-11-01（初澜 2.0 observe 档）：判据必须**先剥注释**再匹配。
     *
     *   为什么改：observe 档在 maybeAskForSelfNote 里加了一段说明性注释，
     *   其中有一行「✗ 不调 memory.addSelfNote —— 观察期不回流给她」。
     *   原判据的裸正则把**这句注释**当成了真调用 ⇒ 断言变红，
     *   而它要守的东西（D-27 建案路径真的不写 selfNotes）一个字都没变。
     *   实测确认：剥掉注释后该正则不再命中。
     *
     *   ⚠️ 这不是放松判据：剥掉的只是注释，代码行一个不少。
     *      本仓反复禁止「用字符串匹配当判据」，这条是它的又一次现场。
     */
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const MAIN_CODE = stripComments(MAIN_SRC);

    // 用户拍板：驳回记忆回写**拆出去**（D-28）。D-27 只在审计留痕。
    check('❌ D-27 的建案路径不写 selfNotes（驳回记忆留给 D-28）',
      !/tryBuildProposalFromIntent[\s\S]{0,4000}?addSelfNote/.test(MAIN_CODE));
    check('❌ D-27 的建案路径不碰 selfLedger',
      !/tryBuildProposalFromIntent[\s\S]{0,4000}?selfLedger/.test(MAIN_CODE));
  }

  /* ============ 10. 🔴 行为断言：跑真实的 tryBuildProposalFromIntent ============
   *
   * 为什么不用静态断言了事：本仓的教训（d17 :227 原话）——
   *   「只看源码含不含某个名字，抓不住『注入了但没用』」。
   * 这里把 main.js 里那两个函数的**真实源码**取出来跑，
   * 用真的 path / 真的临时沙盒，只把 brain 与 agentIpc 换成替身。
   * 于是「消费即清空发生在 await 之前」「拒绝不建案」这两条
   * 是被**跑出来**的，不是被 grep 出来的。 */
  {
    function loadFn(name) {
      const m = MAIN_SRC.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}'));
      return m ? m[0] : null;
    }
    const bssSrc = loadFn('buildSandboxScope');
    const tbpSrc = loadFn('tryBuildProposalFromIntent');
    const audSrc = loadFn('auditProposalRefused');
    check('🔴 能从 main.js 取出 buildSandboxScope / tryBuildProposalFromIntent / auditProposalRefused 的真实源码',
      !!bssSrc && !!tbpSrc && !!audSrc);

    if (bssSrc && tbpSrc && audSrc) {
      const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'd27-run-'));
      const mk = (draft, proposeImpl) => {
        const calls = { propose: [], broadcast: [], audit: [] };
        const brain = {
          _pendingAgentIntent: { shouldPropose: true, capability: 'workspace.write', hint: '整理.md', reason: 'r' },
          // 🔴 三态契约：draft 为字符串 ⇒ ok；为对象 ⇒ 原样返回（用来模拟 refused/unavailable）
          askForProposalContent: async () => (typeof draft === 'string'
            ? { status: 'ok', content: draft, usage: null }
            : draft),
        };
        const deps = {
          agentSandbox: sb,
          broadcastToWindows: (ch, p) => calls.broadcast.push({ ch, p }),
          // 🔴 审计替身：拒案必须真的写进来（复核 D-2 的验收口径）
          audit: { append: (e) => calls.audit.push(e) },
          agentIpc: {
            proposeInternal(raw, via) {
              calls.propose.push({ raw, via });
              return proposeImpl ? proposeImpl(raw) : { ok: true, proposal: { id: 'p-1' } };
            },
          },
        };
        // eslint-disable-next-line no-new-func
        // ⚠️ 必须一并注入 auditProposalRefused —— 它被 tryBuildProposalFromIntent 调用。
        //   漏掉时调用会抛 ReferenceError，被 tryBuildProposalFromIntent 的 try/catch
        //   静默吞成 null —— 测试只看到「没建案」，看不到「审计压根没写」。
        //   实测踩过：三条审计断言全红而其它全绿，正是这个静默吞掉造成的。
        // 🔴 而且注入的必须是 main.js 里**那份真实源码**，不能是测试里手抄的复刻版 ——
        //   复刻版会让「审计写成什么样」脱离被测代码，改坏 main.js 也照样绿。
        const f = new Function('path', 'brain', 'agentBuildDeps', 'proactiveAuditLog', 'auditProposalRefused',
          bssSrc + '\n' + tbpSrc + '\n' + audSrc + '\nreturn { tryBuildProposalFromIntent };');
        return { fn: f(path, brain, deps, null, undefined), brain, calls };
      };

      // ① 正常：建案 + 广播 + 意图清空
      {
        const c = mk('# 方案\n\n' + '内容'.repeat(60));
        const id = await c.fn.tryBuildProposalFromIntent();
        check('🔴 行为：合法正文 → 建案成功且返回提案 id', id === 'p-1', String(id));
        check('🔴 行为：走 via=main（主进程建案，不是渲染端）',
          c.calls.propose.length === 1 && c.calls.propose[0].via === 'main');
        check('🔴 行为：广播的是 agent-proposal-pending 且只带 proposalId',
          c.calls.broadcast.length === 1
          && c.calls.broadcast[0].ch === 'agent-proposal-pending'
          && JSON.stringify(c.calls.broadcast[0].p) === '{"proposalId":"p-1"}');
        check('🔴 行为：建案后 _pendingAgentIntent 已清空', c.brain._pendingAgentIntent === null);
        check('❌ 行为：正常建案**不写**拒案审计（审计只在拒/不可用时写）',
          c.calls.audit.length === 0);
        // 正文真的传下去了（不是靠暂存，是 raw.content 现场算哈希绑进提案）
        const raw = c.calls.propose[0].raw;
        check('🔴 行为：content 原样传给 proposeInternal（不截断不加工）',
          raw && raw.content === '# 方案\n\n' + '内容'.repeat(60));
        check('🔴 行为：scope 落在沙盒内且扩展名合法',
          raw && path.dirname(raw.scope) === sb && raw.scope.endsWith('.md'));
      }

      // ② 她拒绝：零建案、零广播、**写一条审计**，且仍然清空
      {
        const c = mk({ status: 'refused', reason: 'EXPLICIT_REFUSAL' });
        const id = await c.fn.tryBuildProposalFromIntent();
        check('🔴 行为：她拒绝 → 不建案', id === null);
        check('🔴 行为：她拒绝 → 不调用 proposeInternal', c.calls.propose.length === 0);
        check('🔴 行为：她拒绝 → 不广播（不弹空卡）', c.calls.broadcast.length === 0);
        check('🔴 行为：她拒绝 → 意图**仍然**已清空（拒绝必须能持续生效）',
          c.brain._pendingAgentIntent === null);
        // 🔴 复核 D-2 的验收口径：拒案必须真的落到审计器里
        check('🔴 行为：她拒绝 → 写一条 outcome=refused_by_subject 的审计',
          c.calls.audit.length === 1
          && c.calls.audit[0].outcome === 'refused_by_subject'
          && c.calls.audit[0].channel === 'agent:propose-action',
          JSON.stringify(c.calls.audit[0] || null));
        check('🔴 行为：审计里**不含正文**（隐私铁律：只记元数据）',
          c.calls.audit.length === 1 && !JSON.stringify(c.calls.audit[0]).includes('内容'));
      }

      // ②b 不可用（不是拒绝）：也留痕，但原因与拒案不同
      {
        const c = mk({ status: 'unavailable', reason: 'TOO_SHORT' });
        const id = await c.fn.tryBuildProposalFromIntent();
        check('❌ 行为：不可用 → 不建案不广播',
          id === null && c.calls.propose.length === 0 && c.calls.broadcast.length === 0);
        check('🔴 行为：不可用 → 意图已清空（不残留）', c.brain._pendingAgentIntent === null);
        check('🔴 行为：不可用 → 审计用**独立 outcome**（不与拒案同桶）',
          c.calls.audit.length === 1
          && c.calls.audit[0].outcome === 'draft_unavailable',
          JSON.stringify(c.calls.audit[0] || null));
        check('🔴 行为：拒案与不可用的 outcome 必须不同（否则会把故障统计成她的决策）',
          c.calls.audit[0] && c.calls.audit[0].outcome !== 'refused_by_subject');
      }

      // ③ 建案抛错：不崩，且意图已清空
      {
        const c = mk('# x\n\n' + 'y'.repeat(200), () => { throw new Error('boom'); });
        const id = await c.fn.tryBuildProposalFromIntent();
        check('❌ 行为：建案抛错 → 返回 null（绝不外抛，砸掉她这一轮回话）', id === null);
        check('🔴 行为：建案抛错 → 意图仍已清空', c.brain._pendingAgentIntent === null);
      }

      // ④ 无意图：什么都不做
      {
        const c = mk('x'.repeat(200));
        c.brain._pendingAgentIntent = null;
        const id = await c.fn.tryBuildProposalFromIntent();
        check('❌ 行为：无意图 → 直接返回，不建案不广播',
          id === null && c.calls.propose.length === 0 && c.calls.broadcast.length === 0);
      }

      // ⑤ hint 恶意变体：建案前就被挡下
      {
        const c = mk('# x\n\n' + 'y'.repeat(200));
        c.brain._pendingAgentIntent.hint = '..\\..\\evil.md';
        const id = await c.fn.tryBuildProposalFromIntent();
        check('❌ 行为：hint 想跑出沙盒 → 不建案', id === null && c.calls.propose.length === 0);
      }

      // ⑥ 能力不符：静默退出（不假设 intent 永远是 workspace.write）
      {
        const c = mk('# x\n\n' + 'y'.repeat(200));
        c.brain._pendingAgentIntent.capability = 'process.execute';
        const id = await c.fn.tryBuildProposalFromIntent();
        check('❌ 行为：能力不是 workspace.write → 静默退出，不建案',
          id === null && c.calls.propose.length === 0);
      }

      try { fs.rmSync(sb, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ============ 10b. 🔴 两条通路共读 _pendingAgentIntent：别让"巧合安全"变回归 ============
   *
   *   复核 D-额外3 抓到：main.js 的非 proactive 分支把同一个字段同时喂给
   *   `tryBuildProposalFromIntent()` 和 `maybeAskForSelfNote()`，
   *   而原注释写的是「两者读不同的字段」——**注释与调用关系不符**。
   *
   *   ✅ 当前不出事靠两个巧合：
   *     ① 前者在 await 前就置空 ⇒ 后者读到 null；
   *     ② agent-intent 的产出**没有 kind 字段** ⇒ 后者的
   *        `intent.kind !== 'wantToLeaveSomething'` 直接 return。
   *   任一失效就会出现「同一意图被两条通路各消费一次」。
   *   本组把这两个前提钉成断言 —— 将来谁改坏了，这里先红。 */
  {
    check('🔴 两条通路确实共读同一字段（若哪天改了，这条注释与断言要一起更新）',
      /else maybeAskForSelfNote\(brain && brain\._pendingAgentIntent\)/.test(MAIN_SRC));
    check('🔴 前置①：置空发生在 await 之前（否则后者会读到同一个意图）',
      /brain\._pendingAgentIntent = null;[\s\S]{0,2000}?await brain\.askForProposalContent/.test(MAIN_SRC));
    // 前置②：agent-intent 的产出没有 kind 字段
    const INTENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-intent.js'), 'utf8');
    const hitBlock = INTENT_SRC.match(/shouldPropose: true,[\s\S]{0,600?\}/) || [];
    check('🔴 前置②：agent-intent 的命中对象不含 kind（否则 maybeAskForSelfNote 会误接）',
      !/\bkind\s*:/.test((INTENT_SRC.match(/shouldPropose: true,[\s\S]{0,800}/) || [''])[0]));
    check('🔴 maybeAskForSelfNote 仍然要求 kind === wantToLeaveSomething',
      /intent\.kind !== 'wantToLeaveSomething'/.test(MAIN_SRC));
  }

  /* ============ 10c. 🔴 卡片队列的并发竞态（复核 D-1） ============
   *
   *   复核指出：两个 pending 信号几乎同时到达时，第一条还在 `await getPendingProposal`
   *   的回查窗口里（此时 `isVisible()` 仍为 false），第二条也走「直接展示」，
   *   两次 `show()` 互相覆盖 —— 前一条的卡片被顶掉且再也回不来。
   *
   *   我实测复现了：50ms 延迟下 A/B 同时到达，`shown = ["A","B"]`，A 被覆盖。
   *
   *   本组**直接跑 pet.js 里的真实队列源码**（不是复刻），用慢速替身制造回查窗口。
   *   断言：只展示 1 条、另一条在队列里等、决策后依次展示、占位最终清空。 */
  {
    const PET_SRC = fs.readFileSync(path.join(__dirname, '..', 'pet.js'), 'utf8');
    const grab = (re) => { const m = PET_SRC.match(re); return m ? m[0] : null; };
    const qSrc = grab(/const MAX_PENDING_CARDS = 8;[\s\S]*?let activeCardId = null;/);
    const showSrc = grab(/async function showProposalById\(id\)[\s\S]*?\n\}/);
    const drainSrc = grab(/async function drainPendingCards\(\)[\s\S]*?\n\}/);
    const relSrc = grab(/function releaseActiveCard\(proposalId\)[\s\S]*?\n\}/);
    const sigSrc = grab(/async function onProposalSignal\(payload\)[\s\S]*?\n\}/);
    check('🔴 能取出 pet.js 的队列真实源码（取不到则本组空转）',
      !!qSrc && !!showSrc && !!drainSrc && !!relSrc && !!sigSrc);

    if (qSrc && showSrc && drainSrc && relSrc && sigSrc) {
      const makeEnv = (latency) => {
        let visible = false;
        const shown = [];
        const agentConfirmCard = { isVisible: () => visible };
        const api = { agent: { getPendingProposal: (id) => new Promise((res) =>
          setTimeout(() => res({ ok: true, proposal: { id } }), latency)) } };
        const showAgentProposal = async (p) => { shown.push(p.id); visible = true; return true; };
        // eslint-disable-next-line no-new-func
        const f = new Function('api', 'agentConfirmCard', 'showAgentProposal', 'console',
          qSrc + '\n' + showSrc + '\n' + drainSrc + '\n' + relSrc + '\n' + sigSrc +
          '\nreturn { onProposalSignal, drainPendingCards, releaseActiveCard,' +
          ' get pendingCards(){return pendingCards;}, get ids(){return [...pendingCardIds];},' +
          ' get active(){return activeCardId;} };');
        const mod = f(api, agentConfirmCard, showAgentProposal, { warn() {}, log() {} });
        return { mod, shown, hide: () => { visible = false; } };
      };

      // ① 两条同时到达：只能展示一条，另一条在队列
      {
        const e = makeEnv(50);
        await Promise.all([
          e.mod.onProposalSignal({ proposalId: 'A' }),
          e.mod.onProposalSignal({ proposalId: 'B' }),
        ]);
        check('🔴 竞态：两条同时到达 → 只展示 1 条（回查窗口不撕开判据）',
          e.shown.length === 1, JSON.stringify(e.shown));
        check('🔴 竞态：另一条进队列等（不是被覆盖后消失）',
          e.mod.pendingCards.length === 1, JSON.stringify(e.mod.pendingCards));
        // 模拟用户决策 → 必须接上第二条
        e.mod.releaseActiveCard(e.mod.active); e.hide();
        await e.mod.drainPendingCards();
        check('🔴 竞态：决策后依次展示第二条（顺序 A→B）',
          e.shown.length === 2 && e.shown[0] === 'A' && e.shown[1] === 'B',
          JSON.stringify(e.shown));
      }

      // ② 三条同时到达 + 全生命周期：无丢失、无泄漏
      {
        const e = makeEnv(30);
        await Promise.all(['X', 'Y', 'Z'].map((id) => e.mod.onProposalSignal({ proposalId: id })));
        let guard = 0;
        while (guard++ < 10) {
          e.mod.releaseActiveCard(e.mod.active); e.hide();
          if (!(await e.mod.drainPendingCards())) break;
        }
        check('🔴 竞态：三条全展示，无丢失无覆盖',
          e.shown.length === 3 && JSON.stringify(e.shown) === '["X","Y","Z"]',
          JSON.stringify(e.shown));
        check('🔴 竞态：全部决策后占位集合清空（不泄漏队列名额）',
          e.mod.ids.length === 0 && e.mod.active === null, JSON.stringify(e.mod.ids));
      }

      // ③ 同一提案重复广播：只展示一次
      {
        const e = makeEnv(20);
        await Promise.all([1, 2, 3].map(() => e.mod.onProposalSignal({ proposalId: 'DUP' })));
        check('🔴 竞态：同一 proposalId 重复广播 → 只展示一次（去重）',
          e.shown.length === 1, JSON.stringify(e.shown));
      }

      // ④ 🔴 复核 D-1b：**必须跑真实的决策回调**，不能手动模拟。
      //   上一版这里只手工调了 releaseActiveCard + drainPendingCards ——
      //   那只验证了「这两个函数能跑」，**没有验证 finally 真的会在确认失败时执行**。
      //   而审核要的正是后一件：`try/finally` 包得对不对。
      //   ⇒ 现在把 pet.js 里那段回调**原样抽出来**，用三种失败形态各跑一遍。
      {
        // ⚠️ pet.js 是 **CRLF** 行尾 —— 正则里必须用 \r?\n，否则一条都匹配不上
        //   （实测：写成 \n 时 grab 返回 null，断言直接红而看不到真正要测的东西）。
        const cbSrc = grab(/async \(decision, proposalId\) => \{[\s\S]*?\r?\n    \}/);
        check('🔴 能取出决策回调的真实源码（取不到则本组空转）', !!cbSrc);
        if (cbSrc) {
          // 已是完整的 `async (...) => { ... }` 表达式，直接当函数表达式求值
          const fnSrc = cbSrc;
          const buildCb = (env) => {
            // eslint-disable-next-line no-new-func
            const f = new Function('api', 'releaseActiveCard', 'drainCardsNextTick',
              'return (' + fnSrc + ');');
            return f(env.api, env.releaseActiveCard, env.drainCardsNextTick);
          };

          // 形态 A：api.agent.confirm 不存在（审核点名的"confirm 不可用"）
          {
            const log = [];
            const cb = buildCb({
              api: { agent: {} },
              releaseActiveCard: (id) => log.push('release:' + id),
              drainCardsNextTick: () => log.push('drain'),
            });
            await cb('approved', 'P1');
            check('🔴 真实回调：confirm 不可用 → finally 仍 release 并排 drain',
              log.includes('release:P1') && log.includes('drain'), JSON.stringify(log));
          }

          // 形态 B：confirm 抛错
          {
            const log = [];
            const cb = buildCb({
              api: { agent: { confirm: async () => { throw new Error('boom'); } } },
              releaseActiveCard: (id) => log.push('release:' + id),
              drainCardsNextTick: () => log.push('drain'),
            });
            await cb('approved', 'P2');
            check('🔴 真实回调：confirm 抛错 → finally 仍 release 并排 drain',
              log.includes('release:P2') && log.includes('drain'), JSON.stringify(log));
          }

          // 形态 C：正常路径 —— 且 approved 要真的调 execute
          {
            const log = [];
            let executed = null;
            const cb = buildCb({
              api: { agent: {
                confirm: async () => { log.push('confirm'); },
                execute: async (p) => { executed = p && p.proposalId; },
              } },
              releaseActiveCard: (id) => log.push('release:' + id),
              drainCardsNextTick: () => log.push('drain'),
            });
            await cb('approved', 'P3');
            check('🔴 真实回调：approved → 先 confirm 再 execute，最后 release+drain',
              executed === 'P3' && log.join('>') === 'confirm>release:P3>drain', JSON.stringify(log));
          }

          // 形态 D：rejected 不该执行，但**仍要** release+drain
          {
            const log = [];
            let executed = null;
            const cb = buildCb({
              api: { agent: {
                confirm: async () => { log.push('confirm'); },
                execute: async (p) => { executed = p; },
              } },
              releaseActiveCard: (id) => log.push('release:' + id),
              drainCardsNextTick: () => log.push('drain'),
            });
            await cb('rejected', 'P4');
            check('🔴 真实回调：rejected → 不执行，但 finally 仍 release+drain',
              executed === null && log.includes('release:P4') && log.includes('drain'),
              JSON.stringify(log));
          }
        }
      }
    }
  }

  /* ============ 11. 🔴 真实链路：建案 → 确认 → 执行 → 沙盒真落盘 ============
   *
   * 这条是「防呆 2（把正文塞进 takeStashedContent 暂存池）」的**实测答案**：
   *   对 proposalSource === 'user' 的提案，executeInternal 的
   *   effectiveContent **两个分支都取 snap.content**（权威快照），
   *   暂存池只起「有没有暂存」的布尔开关作用，**不提供正文**。
   *   ⇒ 所以 D-27 不需要额外暂存，多存一份反而会与 SEC-01 的
   *     「正文只能来自权威快照」相冲突。
   *   ⚠️ 这条断言把结论钉成可复现行为，而不是留在注释里靠人记。 */
  {
    let chainOk = false, contentOk = false, cardOk = false, contentApiOk = false;
    try {
      const { registerAgentIpc } = require('../src/agent-ipc');
      const IA = require('../src/agent-interfaces');
      const Conf = require('../src/agent-confirmation');
      const { WriteTransactionManager } = require('../src/agent-transaction');
      const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'd27-chain-'));
      const txn = fs.mkdtempSync(path.join(os.tmpdir(), 'd27-chain-txn-'));
      const pol = new IA.PermissionPolicy({ killSwitch: false, allowed: ['workspace.write'] });
      pol.setScopeRoots('workspace.write', [sb]);
      const hs = {};
      const api = registerAgentIpc(
        { handle: (c, fn) => { hs[c] = fn; }, assertTrustedRenderer() {}, isTrustedRenderer: () => true },
        { registry: new IA.CapabilityRegistry(), policy: pol, budget: new IA.ExecutionBudget(),
          auditLog: { list: () => [], append: () => {} }, confirmation: new Conf.UserConfirmationGate() },
        // ⚠️ 刻意**不塞 stash** —— 就是要证明 D-27 这条不需要它
        { transactionManager: new WriteTransactionManager({ dir: txn }), txnDir: txn });
      const BODY = '# 阶段执行方案\n\n## 核心判断\n\n先把主闭环跑通，其余往后放。';
      const p = api.proposeInternal(
        { capability: 'workspace.write', scope: path.join(sb, 'plan.md'), reason: 'r', content: BODY }, 'main');
      const ev = { sender: { id: 1 } };
      const call = (ch, raw) => hs[ch](ev, raw);
      cardOk = call('agent:get-pending-proposal', { proposalId: p.proposal.id }).ok === true;
      // 🔴 复核 D-4：不能只断言 ok===true，还要验**返回的正文与哈希就是那一份**。
      //   只查 ok 的话，把 content 换成 '' 或换错字段也照样绿 —— 那是本仓记录过的
      //   「断言结果而非判据」同型失真。
      const contentRes = call('agent:get-proposal-content', { proposalId: p.proposal.id });
      contentApiOk = contentRes.ok === true
        && contentRes.content === BODY
        && contentRes.contentHash === p.proposal.contentHash
        && contentRes.contentBytes === Buffer.byteLength(BODY, 'utf8');
      call('agent:confirm-action', { proposalId: p.proposal.id, decision: 'approved' });
      const ex = api.executeInternal({ proposalId: p.proposal.id });
      chainOk = !!(ex && ex.ok === true);
      const target = path.join(sb, 'plan.md');
      contentOk = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === BODY;
      fs.rmSync(sb, { recursive: true, force: true });
      fs.rmSync(txn, { recursive: true, force: true });
    } catch (e) { chainOk = false; contentOk = false; }
    check('🔴 真实链路：卡片可取快照（get-pending-proposal 通）', cardOk);
    check('🔴 真实链路：get-proposal-content 返回的正文/哈希/字节数就是提案那一份',
      contentApiOk);
    check('🔴 真实链路：确认 → 执行 → 沙盒真落盘，且内容与提案一致（不依赖暂存池）',
      chainOk && contentOk, 'chainOk=' + chainOk + ' contentOk=' + contentOk);
  }

  /* ============ 12. 保守默认：agentTriggerEnabled 仍为默认关 ============ */
  {
    const { DEFAULTS } = require('../src/config');
    check('🔴 agentTriggerEnabled 仍默认 false（验证期由用户手改配置开启）',
      DEFAULTS.agentTriggerEnabled === false, String(DEFAULTS.agentTriggerEnabled));
  }

  console.log('');
  console.log('失败 ' + failures + ' 项');
  console.log('');
  console.log('⚠️ 本文件不覆盖：真实 LLM 端到端、真实 Electron 卡片渲染、真实落盘。');
  console.log('   这三条需用户实机验证（把 life-config.json 的 agentTriggerEnabled 改成 true）。');
  process.exitCode = failures ? 1 : 0;
})();
