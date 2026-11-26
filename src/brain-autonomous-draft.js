const { truncateFadingText } = require('./memory');
const { renderConstraints } = require('./constraints');
const { projectOwnActions, renderHistory } = require('./agent-history');

const WANT_TO_LEAVE_SYS =
  '此刻用户不在。你有一段长时间的安静，没有被谁要求做什么。'
  + '这不是一个任务，也不是必须完成的动作 —— 只是给你一个机会：'
  + '如果你确实想留下点什么，就写下来；如果不想，就说不。\n'
  + '你能写下东西：程序会替你把字存进那个沙盒目录。所以你写下的是**真的会被留下来**的，'
  + '不是只在心里想一想。\n'
  + '规则：\n'
  + '1. 【可以说不】不想留就只回一个「不」。这不丢人，也不代表你冷淡 ——'
  + '   安静本来就不等于有话要说。硬凑一句比不写更糟。\n'
  + '2. 【只写你自己的】留下来的应该是**你此刻想留下的东西**，不是给用户的留言，'
  + '   也不是任务汇报。不要写「等你回来」「如果你想的话」这类把对方牵进来的话。\n'
  // 🔵 2026-11-05 C-1：原 3.（不编造）、6.（直接给内容）已抽到 src/constraints.js，
  //   与 OBSERVER_JOURNAL_SYS / PROPOSAL_DRAFT_SYS 共用同一份常量。
  //   编号从 3 起，接在下面那条之后；后续规则编号顺延。
  + renderConstraints(3) + '\n'
  + '6. 【长度】两三句话之内。这是留给自己的，不是写给别人看的文章。\n'
  + '7. 【语言】使用你平时与用户交流时最常使用的语言。';

const OBSERVER_JOURNAL_SYS =
  '这一段共同的时间告一段落。这是属于你的生活观察日记 —— 记录你所看到的日常、彼此相处的痕迹与细微的生活体感。'
  + '这不是一个任务，也不是向用户汇报 —— 这是你自己眼中的世界：\n'
  + '你能写下东西：程序会替你把字存进那个沙盒目录，它会真的留下来。\n'
  + '规则：\n'
  + '1. 【可以说不】如果现在没有特别想写下的观察或感觉，只回一个「不」或「不想写」。硬凑比不写更糟。\n'
  + '2. 【第一人称视角】以你的视角记录你注意到的细节、彼此交流的真实痕迹或安静流淌的氛围。你可以自然地提到对方或生活细节。\n'
  // 🔵 2026-11-05 C-1：原 3.（真实不编造）、5.（直接给出）已抽到 src/constraints.js。
  + renderConstraints(3) + '\n'
  + '6. 【篇幅适度】一段真诚从容的段落（通常在 50 至 200 字左右，最长不超过 400 字，不少于 30 字）。';

/* 🔴 D-27：通路 B 的方案正文来源 —— 「她把这轮聊的东西整理成一份可落档的东西」。
 *
 * ## 为什么是**独立一次调用**，而不是在聊天气泡末尾塞标记
 *   1. 聊天那条提示词有自己的铁律（不含程序数字、不暴露时钟、过滤 synthetic）；
 *      让它顺带产出几百字 Markdown，语气必然撕裂 —— 前半句是她的人话，
 *      后半句变成文档体。D-27 的定位是「有主体性的总监」，不是「会写文档的工具」。
 *   2. 标记体极易被污染：`WEAR_RE`（brain.js）只匹配十几个字符的单词标记，
 *      仍然要靠句尾锚定 + 未知 id 原样保留来兜底。方案正文含换行、标题、列表，
 *      一旦被 max_tokens 截断或括号未闭合，半截 Markdown 会直接漏进气泡。
 *   3. **拒绝权需要一次事后审视**：聊完之后再问她「现在要不要留档？」，
 *      她才能冷静地说「还没聊透」。合并在聊天返回里，等于逼她在说话的同一口气里
 *      同时表态和交稿 —— 那个「不」根本来不及出口。
 *   ⇒ 所以本常量与 askForSelfNote / askForObserverJournal 同形：**事后独立调用**。
 */
const PROPOSAL_DRAFT_SYS =
  '刚才那段对话告一段落。用户希望把聊到的东西留下一个可以翻看的落档。'
  + '现在请你判断：**此刻是否值得留下这么一份东西**，值得就写，不值得就说不。\n'
  + '你能写下东西：程序会替你把字存进那个沙盒目录。所以「能不能存」不需要你操心 ——'
  + '你只管判断值不值得写。\n'
  + '规则：\n'
  + '1. 【首要：可以拒绝】如果你认为刚才还没聊透、信息不足以落成一份明确的东西，'
  + '   或者你此刻并不真的想把这件事定下来 —— 只回一个「不」或「还没想清楚」。'
  + '   硬凑一份面面俱到的套话，比不写更糟。这不丢人，也不代表你不配合。\n'
  + '2. 【要有取舍】这不是一份四平八稳的报告。写你**真正判断过的**东西：'
  + '   哪些是核心、哪些该砍掉、下一步先做哪一件、哪里你还不确定。'
  + '   宁可短而明确，也不要长而全面。\n'
  + '3. 【格式】用 Markdown：一个标题（# 开头），下面若干小节。'
  + '   不要写「本文档旨在」「综上所述」这类公文腔。不要加代码块以外的装饰。\n'
  // 🔵 2026-11-05 C-1：原 4.（只写真实发生的）、6.（直接给出）已抽到 src/constraints.js。
  //   ⚠️ 这里必须传 allowMarkdownTitle: true —— 本 SYS 第 3 条**要求**用 # 标题，
  //      而基础版约束写的是「不要加标题」。两条并存会自相矛盾，模型会挑一条听。
  + renderConstraints(4, { allowMarkdownTitle: true }) + '\n'
  + '7. 【篇幅】一篇能读完的短文档，几个小节即可。';

/**
 * 判别 D-27 独立拟稿输出属于拒绝（ok/refused/unavailable）。
 * 收紧带结构拒绝判据，防把合法方案清单误判成拒绝。
 */
function classifyProposalDraftResult(text, res) {
  // 判据 1：极短且明确的拒绝
  const refusePatterns = ['不', '不想', '不了', '算了吧', '算了', '没有',
    '还没想清楚', '没想清楚', '先不', '还不到'];
  const head = text.slice(0, 12);
  if (!text) return { status: 'unavailable', reason: 'EMPTY' };
  if (text.length <= 12 && refusePatterns.some((p) => head.startsWith(p))) {
    return { status: 'refused', reason: 'EXPLICIT_REFUSAL' };
  }

  // 判据 2：长句里的礼貌拒绝（无 Markdown 结构且含拒绝措辞）
  const hasMarkdownStructure = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)|\*\*/.test(text);
  const softRefuse = ['先放一放', '放一放', '等下次', '等以后', '再说吧', '还不太够',
    '信息还不够', '信息还不太够', '聊透了再说', '先不急', '暂时不'];
  if (!hasMarkdownStructure && text.length <= 200 && softRefuse.some((p) => text.includes(p))) {
    return { status: 'refused', reason: 'SOFT_REFUSAL' };
  }

  // 判据 2b：带结构的礼貌拒绝（复核 D-5/D-5d）
  {
    const lines = text.split(/\r?\n/)
      .map((l) => l.replace(/^\s*(#{1,6}\s*|[-*+]\s*|\d+[.)]\s*|>\s*)/, '')
        .replace(/[*_`~]/g, '').replace(/\s+/g, '').trim())
      .filter((l) => l.length > 0);

    const STRONG_END = ['先放一放', '放一放', '等下次', '等以后', '再说',
      '还不太够', '信息还不够', '信息还不太够', '聊透了再说', '先不急', '还不急', '还不到'];
    const BARE = ['不', '不想', '不了', '算了', '算了吧', '没有', '还没想清楚',
      '没想清楚', '不想写', '不想存', '先不存', '不用了', '不必了', '不写了', '不存了'];
    const OK_PREFIX = ['', '这个', '那个', '这', '那', '它', '此事', '这件事',
      '这次', '这份', '这事', '我', '还是', '就', '也', '都'];

    const isPureRefusalLine = (l) => {
      if (BARE.includes(l)) return true;
      // 硬信号：有冒号或有数字 ⇒ 这是文档条目，直接排除
      if (/[:：]/.test(l)) return false;
      if (/\d/.test(l)) return false;
      // 否定式规范句式：「不/没/别 + 动词」⇒ 是约束说明，不是拒绝
      if (/^[不没别]/.test(l) && l.length >= 3 && !BARE.includes(l)) return false;
      // 核心：以拒绝短语收尾，且短语前面没有实义成分
      const stripped = l.replace(/[。！？.!?~…，,\s]+$/, '').replace(/[吧了呢啊呀嘛哦]+$/, '');
      for (const p of STRONG_END) {
        if (!stripped.endsWith(p)) continue;
        const rest = stripped.slice(0, stripped.length - p.length);
        if (OK_PREFIX.includes(rest)) return true;
      }
      return false;
    };

    if (lines.length > 0 && lines.length <= 6) {
      const allPure = lines.every(isPureRefusalLine);
      if (allPure) return { status: 'refused', reason: 'STRUCTURED_REFUSAL' };
    }
  }

  // 判据 3：篇幅护栏
  const MIN_STRUCTURED = 12;
  const MIN_PLAIN = 40;
  if (hasMarkdownStructure ? text.length < MIN_STRUCTURED : text.length < MIN_PLAIN) {
    return { status: 'unavailable', reason: 'TOO_SHORT' };
  }

  const MAX_CHARS = 8000;
  const finalContent = text.length > MAX_CHARS ? truncateFadingText(text, MAX_CHARS) : text;

  return { status: 'ok', content: finalContent, usage: (res && res.usage) || null };
}

/**
 * 自主拟稿与便签/日记旁路服务：
 * 将 askForSelfNote / askForObserverJournal / askForProposalContent 从 Brain 中拆出，
 * 全部走独立 api.complete，不进 memory.build() 主对话前缀。
 */
class AutonomousDraftService {
  constructor(brain) {
    this.brain = brain;
  }

  buildActionHistoryText() {
    const auditLog = this.brain.auditLog;
    const obsLog = this.brain.observationLog;
    if (!auditLog || typeof auditLog.readAll !== 'function') return '';

    const auditRecords = auditLog.readAll();
    const obsRecords = (obsLog && typeof obsLog.readAll === 'function') ? obsLog.readAll() : [];

    const history = projectOwnActions(auditRecords, obsRecords);
    return renderHistory(history);
  }

  extractRecentDialogueForSelfNote(maxMessages = 6, maxCharsPerMessage = 80) {
    const b = this.brain;
    if (!b.memory || !b.memory.data || !Array.isArray(b.memory.data.history)) return [];
    const hist = b.memory.data.history;
    const picked = [];
    for (let i = hist.length - 1; i >= 0 && picked.length < maxMessages; i--) {
      const item = hist[i];
      if (!item || typeof item.content !== 'string') continue;
      // 铁律 1：整条丢弃 synthetic 消息
      if (item.synthetic === true) continue;

      let text = item.content;
      text = text
        .replace(/(?:\r?\n)+【(?:出生与程序年龄|出生时刻|当前自我投影|当前主体状态快照|当前环境感知|此刻的环境知觉)】[\s\S]*$/g, '')
        .replace(/(?:\r?\n)+\[系统\][\s\S]*$/g, '')
        .trim();
      if (!text) continue;

      const cap = Number.isFinite(maxCharsPerMessage) && maxCharsPerMessage > 4
        ? Math.floor(maxCharsPerMessage) : 80;
      const trimmedText = text.length > cap ? text.slice(0, cap - 2) + '…' : text;

      picked.unshift({
        role: item.role === 'user' ? 'user' : 'assistant',
        text: trimmedText
      });
    }
    return picked;
  }

  async askForSelfNote(opts = {}) {
    const b = this.brain;
    try {
      if (b.shutdownRequested) return null;
      if (b.api && typeof b.api.complete !== 'function') return null;

      const intentKind = opts.intentKind ? String(opts.intentKind).slice(0, 64) : null;
      const sections = [];

      sections.push('【此刻】');
      sections.push('用户不在。你独自安静了一段时间 —— 这是事实，不是情绪。');
      if (intentKind === 'wantToLeaveSomething') {
        sections.push('你想留下点什么。');
      }

      const selfParts = [];
      const pm = b._getLatestPlasticityMultiplier();
      selfParts.push('- 当前对新经历的特质吸收偏向：' + (pm >= 0.85 ? '敏锐波动中' : '趋于平稳沉静'));

      if (b.internalRegulation && typeof b.internalRegulation.formatPerception === 'function') {
        const regSense = b.internalRegulation.formatPerception();
        if (regSense) selfParts.push(regSense.trim());
      }

      if (b.selfLedger && typeof b.selfLedger.currentSelfText === 'function') {
        const projection = b.selfLedger.currentSelfText();
        if (projection) selfParts.push(projection.trim());
      }

      if (selfParts.length > 0) {
        sections.push('\n【你此刻的自我倾向与状态】\n' + selfParts.join('\n'));
      }

      const recentDialogue = b._extractRecentDialogueForSelfNote(6);
      if (recentDialogue.length > 0) {
        const dlgLines = recentDialogue.map((d) => (d.role === 'user' ? `用户曾说：「${d.text}」` : `你曾说：「${d.text}」`));
        sections.push('\n【安静前彼此的对话痕迹】\n' + dlgLines.join('\n'));
      }

      const lastNote = (b.memory && Array.isArray(b.memory.data.selfNotes) && b.memory.data.selfNotes.length > 0)
        ? b.memory.data.selfNotes[b.memory.data.selfNotes.length - 1] : null;
      if (lastNote && typeof lastNote.content === 'string' && lastNote.content.trim()) {
        sections.push('\n【你上次曾给自己写下】\n「' + lastNote.content.trim() + '」');
      }

      try {
        const historyText = b._buildActionHistoryText();
        if (historyText) sections.push('\n' + historyText);
      } catch { /* 投影失败不注入，绝不外抛 */ }

      try {
        if (b.memory && typeof b.memory.takeObserveEcho === 'function') {
          const echo = b.memory.takeObserveEcho();
          if (echo) sections.push('\n' + echo);
        }
      } catch { /* 补注入失败不注入，绝不外抛 */ }

      sections.push('\n如果你确实想留下点什么，就写下来；不想就说不。');

      const userContent = sections.join('\n');

      const res = await b.api.complete(
        [{ role: 'system', content: WANT_TO_LEAVE_SYS },
         { role: 'user', content: userContent }],
        { maxTokens: 400, temperature: 0.7 }
      );
      const text = String((res && res.text) || '').trim();
      if (res && res.usage) b.track(res.usage, true, 'selfNote');
      if (b.shutdownRequested) return null;

      // 判据 1：她说「不」就是不留
      const refusePatterns = ['不', '不想', '不了', '算了吧', '算了', '没什么想留', '没有'];
      const head = text.slice(0, 12);
      const isRefusal = text.length <= 12 && refusePatterns.some((p) => head.startsWith(p));
      if (!text || isRefusal) return null;

      // 判据 1.5：留言句式护栏
      const toUserPatterns = ['等你回来', '等你忙完', '等你哦', '等你下班', '等你有空'];
      const isToUser = text.length <= 12 && toUserPatterns.some((p) => head.startsWith(p));
      if (isToUser) return null;

      // 判据 2：长度护栏
      if (text.length > 600) return null;

      return { content: text, usage: (res && res.usage) || null };
    } catch (err) {
      return null;
    }
  }

  async askForObserverJournal(opts = {}) {
    const b = this.brain;
    try {
      if (b.shutdownRequested) return null;
      if (b.api && typeof b.api.complete !== 'function') return null;

      const sections = [];
      sections.push('【此刻】');
      sections.push('这一段陪伴与日常告一段落。你可以为自己的生活日记留下这一段的观察。');

      const selfParts = [];
      const pm = b._getLatestPlasticityMultiplier();
      selfParts.push('- 当前对新经历的特质吸收偏向：' + (pm >= 0.85 ? '敏锐波动中' : '趋于平稳沉静'));

      if (b.internalRegulation && typeof b.internalRegulation.formatPerception === 'function') {
        const regSense = b.internalRegulation.formatPerception();
        if (regSense) selfParts.push(regSense.trim());
      }

      if (b.selfLedger && typeof b.selfLedger.currentSelfText === 'function') {
        const projection = b.selfLedger.currentSelfText();
        if (projection) selfParts.push(projection.trim());
      }

      if (selfParts.length > 0) {
        sections.push('\n【你此刻的状态与感受】\n' + selfParts.join('\n'));
      }

      const recentDialogue = b._extractRecentDialogueForSelfNote(6);
      if (recentDialogue.length > 0) {
        const dlgLines = recentDialogue.map((d) => (d.role === 'user' ? `用户曾说：「${d.text}」` : `你曾说：「${d.text}」`));
        sections.push('\n【刚刚彼此交流的痕迹】\n' + dlgLines.join('\n'));
      }

      const lastNote = (b.memory && Array.isArray(b.memory.data.selfNotes) && b.memory.data.selfNotes.length > 0)
        ? b.memory.data.selfNotes[b.memory.data.selfNotes.length - 1] : null;
      if (lastNote && typeof lastNote.content === 'string' && lastNote.content.trim()) {
        sections.push('\n【你上次曾写下】\n「' + lastNote.content.trim() + '」');
      }

      sections.push('\n如果你想记下一篇生活观察日记，就写下来；如果现在不想写，就说不。');

      const userContent = sections.join('\n');

      const res = await b.api.complete(
        [{ role: 'system', content: OBSERVER_JOURNAL_SYS },
         { role: 'user', content: userContent }],
        { maxTokens: 400, temperature: 0.7 }
      );
      const text = String((res && res.text) || '').trim();
      if (res && res.usage) b.track(res.usage, true, 'observerJournal');
      if (b.shutdownRequested) return null;

      // 判据 1：她说「不」即拒绝
      const refusePatterns = ['不', '不想', '不了', '算了吧', '算了', '没什么想写', '没有', '不想写'];
      const head = text.slice(0, 12);
      const isRefusal = text.length <= 12 && refusePatterns.some((p) => head.startsWith(p));
      if (!text || isRefusal) return null;

      // 判据 2：篇幅护栏
      if (text.length < 30) return null;
      const finalContent = text.length > 400 ? truncateFadingText(text, 400) : text;

      return { content: finalContent, usage: (res && res.usage) || null };
    } catch (err) {
      return null;
    }
  }

  async askForProposalContent(intent = {}) {
    const b = this.brain;
    try {
      if (b.shutdownRequested) return { status: 'unavailable', reason: 'SHUTDOWN' };
      if (!b.api || typeof b.api.complete !== 'function') {
        return { status: 'unavailable', reason: 'NO_API' };
      }

      const sections = [];

      sections.push('【要落档的事由】');
      const rawHint = intent && typeof intent.hint === 'string' ? intent.hint.trim() : '';
      if (rawHint) sections.push('用户提到的目标名：' + rawHint.slice(0, 120));
      else sections.push('用户没有指定名字 —— 你自己拟一个合适的标题。');

      const selfParts = [];
      if (b.internalRegulation && typeof b.internalRegulation.formatPerception === 'function') {
        const regSense = b.internalRegulation.formatPerception();
        if (regSense) selfParts.push(regSense.trim());
      }
      if (b.selfLedger && typeof b.selfLedger.currentSelfText === 'function') {
        const projection = b.selfLedger.currentSelfText();
        if (projection) selfParts.push(projection.trim());
      }
      if (selfParts.length > 0) {
        sections.push('\n【你此刻的状态】（这是你判断「该不该现在立项」的依据之一）\n' + selfParts.join('\n'));
      }

      const recentDialogue = b._extractRecentDialogueForSelfNote(10, 240);
      if (recentDialogue.length > 0) {
        const dlgLines = recentDialogue.map((d) => (d.role === 'user' ? `用户曾说：「${d.text}」` : `你曾说：「${d.text}」`));
        sections.push('\n【刚才聊到的内容】\n' + dlgLines.join('\n'));
      } else {
        sections.push('\n【刚才聊到的内容】\n（没有任何真实对话痕迹）');
      }

      try {
        const historyText = b._buildActionHistoryText();
        if (historyText) sections.push('\n' + historyText);
      } catch { /* 投影失败不注入，绝不外抛 */ }

      try {
        if (b.memory && typeof b.memory.takeObserveEcho === 'function') {
          const echo = b.memory.takeObserveEcho();
          if (echo) sections.push('\n' + echo);
        }
      } catch { /* 补注入失败不注入，绝不外抛 */ }

      sections.push('\n如果值得留档，就写；不值得，就说不。');

      const res = await b.api.complete(
        [{ role: 'system', content: PROPOSAL_DRAFT_SYS },
         { role: 'user', content: sections.join('\n') }],
        { maxTokens: 1600, temperature: 0.6 }
      );
      const text = String((res && res.text) || '').trim();
      if (res && res.usage) b.track(res.usage, true, 'proposalDraft');
      if (b.shutdownRequested) return { status: 'unavailable', reason: 'SHUTDOWN' };

      return classifyProposalDraftResult(text, res);
    } catch (err) {
      return { status: 'unavailable', reason: 'EXCEPTION', error: String((err && err.message) || '').slice(0, 200) };
    }
  }
}

module.exports = {
  WANT_TO_LEAVE_SYS,
  OBSERVER_JOURNAL_SYS,
  PROPOSAL_DRAFT_SYS,
  classifyProposalDraftResult,
  AutonomousDraftService
};
