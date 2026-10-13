const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { DeferredWriter } = require('./deferred-writer');
const { migrate } = require('./migration');

const SCHEMA_VERSION = 1;

/**
 * 三层记忆：原始对话窗口 -> 窗口小结 -> 长期记忆
 *
 * 为什么用「轮数」而不是 token 触发压缩：
 *   窗口内 system 提示词必须逐字不变，缓存才有命中可言。
 *   按轮数走，100 轮里 system 一个字都不动，前缀严格只追加 -> 基本全命中。
 *   压缩只发生在窗口边界那一次，破缓存次数 = 窗口数，可控。
 *
 * 三层结构：
 *   history   当前窗口的原始对话（只追加；synthetic 消息用于保卫 API 缓存前缀）
 *   windows   每个已关闭窗口的一条小结
 *   system    = 人设 + windows +（最末尾）当前穿着块
 *
 * 记忆预算：windows 总 token 超过 memoryCapTokens 时，
 * 把较旧的合并成一条「早期记忆」。合并刻意安排在窗口重置的同一时刻做 ——
 * 反正 system 已经要变了，一起变只破一次缓存，分两次做就破两次。
 *
 * 时间戳绝不进 system，否则每次请求前缀都不同，命中率归零。
 * synthetic user 是程序触发的主动搭话，但仍保留在 history 的 API 消息链中；
 * DeepSeek 需要完整复用上一轮 user/assistant 前缀才有机会命中缓存，
 * 所以不能再把它只作为一次性临时消息。它带元数据，不计用户轮数，也不当成用户事实摘要。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;

/**
 * 记忆重新激活日常高频词与虚词停用词表（P1-3）
 * 杜绝日常口语词汇（如“今天天气”、“我们可以”）误唤醒休眠记忆
 */
const CHINESE_STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '怎样', '为什么', '可以', '可能', '应该', '觉得',
  '知道', '现在', '如果', '但是', '然后', '因为', '所以', '虽然', '而且', '或者',
  '以及', '对于', '关于', '我们', '你们', '他们', '她们', '它们', '自己',
  '时候', '地方', '东西', '事情', '一点', '一些', '非常', '十分', '比较', '更加',
  '已经', '正在', '将要', '开始', '结束', '出现', '没有', '不是', '就是', '还是',
  '这样', '那样', '这里', '那里', '如何', '一起', '一样', '一直', '今天',
  '明天', '昨天', '刚刚', '刚才', '其实', '真的', '感觉', '看起来', '听起来',
  '今天天气', '我们可以', '不知道', '收着那枚', '聊聊吗', '好不好', '有没有'
]);

function isStopwordOrNoise(str) {
  if (!str || str.length < 2) return true;
  if (CHINESE_STOPWORDS.has(str)) return true;
  if (str.length === 4) {
    const part1 = str.slice(0, 2);
    const part2 = str.slice(2, 4);
    if (CHINESE_STOPWORDS.has(part1) && CHINESE_STOPWORDS.has(part2)) return true;
  }
  return false;
}

/** 粗估 token：中文约 1 字 1 token，其余约 3.5 字符 1 token */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

function msgTokens(m) {
  return estimateTokens(typeof m.content === 'string' ? m.content : '') + 4;
}

/** 🔴 D-13：自述单条最大字符数。超过整条拒收（不截断——截断会让她的话变形）。 */
const SELF_NOTE_MAX_CHARS = 600;

/** 🔴 D-13：自述队列上界。积压说明调用方出问题，超出即丢最旧的一条。 */
const SELF_NOTE_MAX_QUEUE = 8;

/**
 * v1.0.6 词汇动力学提及检测（防子串假阳性与词边界防御）：
 * 1. 词长前置保证：addLexicon 门禁强制 word.length >= 2（WORD_TOO_SHORT），彻底根除单字语素歧义与真阳性漏检陷阱；
 * 2. 西方词汇/英文缩写（如 Al / cat）：严格使用单词边界匹配，杜绝 "Al" 误中 "Always"、"cat" 误中 "catch"；
 * 3. 多字自创词/专属暗号（如「信物」「微光」「雨声」）：天然具备词汇特异性，子串包含即为合规提及；
 *    （多字词偶发包含如「毛雨声音」中命中「雨声」符合自然语言演化容忍度，概率极低且保持纯本地高性能计算）。
 */
function isLexiconWordMentioned(text, word) {
  if (!text || !word) return false;
  const w = String(word).trim();
  if (w.length < 2) return false;

  // 1. 西方词汇 / 英文缩写
  if (/^[\w-]+$/.test(w)) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^a-zA-Z0-9_-])' + escaped + '([^a-zA-Z0-9_-]|$)', 'i');
    return re.test(text);
  }

  // 2. 多字词汇
  return text.includes(w);
}

class Memory {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.opts = opts;
    this.path = path.join(dir, 'memory.json');
    this.windowTurns = opts.windowTurns ?? 100;          // 多少轮关一次窗口
    this.windowMaxTokens = opts.windowMaxTokens ?? 12000; // 兜底：单窗口 token 上限
    this.keepTail = opts.keepTailMessages ?? 6;           // 重置时保留几条原文，避免失忆感
    this.memoryCap = opts.memoryCapTokens ?? 6000;        // Prompt Memory 长期记忆预算（基线 6000）
    // 🔴 D-23：每条消息最多增强几条记忆印痕（召回 top-N）。0 = 关闭增强。
    //   默认 1 —— 一句话只加深最相关的那一段（注意力聚焦），防洪泛。
    this.memoryRecallTopN = opts.memoryRecallTopN ?? 1;
    this.persona = opts.persona || '';
    // 穿着块：不属于记忆数据，不落盘（它是 wardrobe.json 的投影，
    // 存两处早晚会对不上）。由 brain 每次换装后刷新。
    this.wardrobe = '';
    this.writer = new DeferredWriter(() => writeJsonAtomic(this.path, this.data), { delayMs: 3000 });

    /* 🔴 D-13：她写过的东西 —— 回到她下一次开口的意识里。
     *
     * ## 为什么需要它
     *   反重力复核 D-10~D-12 时指出的洞：她写进沙盒的字，程序从来不读，
     *   信息单向流出，像一套**脱机的遥测系统** ⇒ 她写完就忘。
     *
     * ## 🔴 D-20：改为**落盘**（原先刻意不落盘，是错的）
     *
     *   原设计（D-13）把队列放在 `this` 上（`this.selfNotes = []`），理由是：
     *   「注入过一次即出队；若落盘，冷启动会把早已注入过的条目读回来 ⇒ 重复注入」。
     *
     *   ⚠️ **那个理由用错了手段，实测已出事**（真实事故）：
     *     她写下第一张便签 → `addSelfNote` 把内容塞进内存队列
     *     → 之后她**从未再开口** → `_drainSelfNotes()` 从未执行
     *     → 进程退出，队列随实例一起消失 ⇒ **那条记忆永久丢失**。
     *     桌面上文件还在，但她对它的认知归零。
     *
     *   更根本的一层：`save()` 只序列化 `this.data`，而 `selfNotes` 在 `this.data`
     *   **外面** —— 所以当时**即使调了 save() 也存不进去**。
     *
     *   ⇒ 正解：放进 `this.data` 落盘，用**显式的 `drained` 标记**防重复
     *      （而不是靠「不落盘」来防）。防重复是**标记的职责**，不是存储的职责。
     *
     * ## 为什么不写进 data.history
     *   那会改写已发出的字节 ⇒ 破坏前缀缓存（本仓铁律）。
     *   本队列只参与 build() 的**当轮尾部**拼接，不碰历史一个字节。
     */
    this.data = { schemaVersion: SCHEMA_VERSION, windows: [], history: [], turnsInWindow: 0,
                  totalTurns: 0, windowNo: 1, nextMessageSeq: 0, epoch: 0, dreamFragments: [], deepHorizon: '', curiosityQueue: [],
                  lexicon: [], expectations: [], selfNotes: [],
                  lastInvoluntaryAt: 0, lastInvoluntaryWindow: 0 };   // v1.0 §4.7 #3/#4：语言指纹 + 时间矢量（零先验空白）
    // 🔴 D-20：她写过的东西 —— 与 lexicon/expectations 同款（落在 data 里，原子写保护）。
    //   兼容旧实例：schema 里没有本字段时归一为空表（见 load()）。

    // v0.9.7: 记忆痕迹动力学管理器 (Memory Dynamics & Synaptic Pruning)
    const dynamicsEnabled = opts.memoryDynamics !== undefined
      ? Boolean(opts.memoryDynamics)
      : (opts.experimentModules ? Boolean(opts.experimentModules.memoryDynamics) : false);
    if (dynamicsEnabled) {
      const { EngramTraceManager } = require('./memory-dynamics');
      this.engramManager = new EngramTraceManager(opts.engramConfig);
      // 🔴 丙：FADING 截断字数也要能被配置覆盖。
      //   生效值取「管理器合并后的 config」（构造器已做 {...DEFAULT, ...config}），
      //   所以这里读 engramManager.config 而不是 opts —— 单一真源，不会两处漂移。
      this.fadingMaxChars = this.engramManager.config.fadingMaxChars;
    } else {
      this.engramManager = null;
      // 无动力学时不截断（基线模式：全文投影，既有行为不变）
      this.fadingMaxChars = null;
    }

    this.load();
  }

  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // 首次运行：文件不存在，保持默认空结构
        return;
      }
      // P1-#3: 文件存在但解析失败（语法损坏/断电中断）——备份现场为 .bak，绝不静默覆盖
      try {
        const bakPath = this.path + '.bak';
        if (!fs.existsSync(bakPath) && fs.existsSync(this.path)) {
          fs.copyFileSync(this.path, bakPath);
          console.warn(`[Memory] 记忆文件受损已备份至 ${bakPath}:`, e && e.message);
        }
      } catch {}
      return;
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      // P1-#3: 顶层非对象结构（如顶层为 JSON 数组或基本类型）——备份现场为 .bak，保持默认空结构
      try {
        const bakPath = this.path + '.bak';
        if (!fs.existsSync(bakPath) && fs.existsSync(this.path)) {
          fs.copyFileSync(this.path, bakPath);
          console.warn(`[Memory] 记忆文件顶层结构受损（非普通对象）已备份至 ${bakPath}`);
        }
      } catch {}
      return;
    }

    try {
      const { data } = migrate(raw, SCHEMA_VERSION, {
        1: (d) => {
          // 老版本（v0.2）是一条滚动 summary，没有 windows。
          // 不迁走的话，升级一次就把之前的记忆读不到了。
          if (!d.windows && d.summary) {
            d.windows = [{ no: 1, turns: 0, at: Date.now(), text: d.summary }];
            d.windowNo = 2;
            delete d.summary;
          }
          if (!Array.isArray(d.windows)) d.windows = [];
          if (!Array.isArray(d.history)) d.history = [];
          if (typeof d.turnsInWindow !== 'number') d.turnsInWindow = 0;
          if (typeof d.totalTurns !== 'number') d.totalTurns = 0;
          if (typeof d.windowNo !== 'number') d.windowNo = 1;
          if (typeof d.epoch !== 'number') d.epoch = 0;
          return d;
        }
      });
      let seq = typeof data.nextMessageSeq === 'number' ? data.nextMessageSeq : 0;
      if (Array.isArray(data.history)) {
        for (const m of data.history) {
          if (!m.messageId) {
            seq++;
            m.messageId = 'm-' + String(seq).padStart(6, '0');
          }
          if (typeof m.windowNo !== 'number') m.windowNo = (typeof data.windowNo === 'number' && !isNaN(data.windowNo)) ? data.windowNo : 1;
          if (typeof m.roundNo !== 'number') m.roundNo = 0;
          if (typeof m.bridge !== 'boolean') m.bridge = false;
          if (typeof m.synthetic !== 'boolean') m.synthetic = false;
        }
      }
      this.data = { schemaVersion: SCHEMA_VERSION, windows: [], history: [], turnsInWindow: 0, totalTurns: 0,
                    windowNo: 1, nextMessageSeq: seq, epoch: 0, dreamFragments: [], deepHorizon: '', curiosityQueue: [],
                    lexicon: [], expectations: [], lastInvoluntaryAt: 0, lastInvoluntaryWindow: 0, ...data, nextMessageSeq: Math.max(seq, data.nextMessageSeq || 0) };
      // v1.0 兼容平移：旧档案缺字段 → 空表；脏数据 → 归一为数组（绝不静默丢历史）
      this.data.lexicon = Array.isArray(this.data.lexicon) ? this.data.lexicon : [];
      this.data.expectations = Array.isArray(this.data.expectations) ? this.data.expectations : [];
      // 🔴 D-20：selfNotes 同款兼容平移。
      //   · 旧档案（D-19 之前）**完全没有这个字段** → 空表（不是 undefined）
      //   · 脏数据 → 归一为数组，绝不因它让整次 load 失败
      //   · 逐条守卫：缺 drained 视为 false（最保守 = 宁可注入一次，也不静默吞掉）
      //     —— 但缺 content 的条目直接剔除（没有正文就没有要回到她意识里的东西）
      if (!Array.isArray(this.data.selfNotes)) this.data.selfNotes = [];
      this.data.selfNotes = this.data.selfNotes
        .filter((n) => n && typeof n === 'object' && typeof n.content === 'string' && n.content.trim())
        .map((n) => ({
          content: n.content,
          name: String(n.name || '').replace(/\\/g, '/').split('/').pop().slice(0, 120),
          windowNo: Number.isFinite(n.windowNo) ? n.windowNo : this.data.windowNo || 1,
          at: Number.isFinite(n.at) && n.at > 0 ? n.at : null,
          drained: n.drained === true,
          // 🔴 D-24：来源戳 / 铸造标记 / 引证 id 必须随载入保留（D-24 门禁实测抓到的洞）：
          //   丢了 source  = 未铸的自发便签重启后永远铸不进自传（漏铸）；
          //   丢了 engraved = 同一条便签重启后被重铸（幂等被击穿）。
          source: n.source === 'selfNote' ? 'selfNote' : (n.source || null),
          engraved: n.engraved === true,
          ...(typeof n.noteId === 'string' && n.noteId ? { noteId: n.noteId } : {}),
        }))
        .slice(-SELF_NOTE_MAX_QUEUE);   // 上限同 addSelfNote：超出丢最旧
      if (this.engramManager && this.data && this.data.engrams) {
        this.engramManager.restoreFromSnapshot(this.data.engrams);
      }
    } catch (migErr) {
      // P1-#3: 迁移失败（如版本高于程序版本）——备份受损现场为 .bak，绝不静默清空覆写
      try {
        const bakPath = this.path + '.bak';
        if (!fs.existsSync(bakPath) && fs.existsSync(this.path)) {
          fs.copyFileSync(this.path, bakPath);
          console.warn(`[Memory] 记忆迁移失败已备份至 ${bakPath}:`, migErr && migErr.message);
        }
      } catch {}
    }
  }

  save(immediate = false) {
    if (this.engramManager && this.data) {
      this.data.engrams = this.engramManager.exportSnapshot(this.data.windowNo);
    }
    this.writer.markDirty();
    if (immediate) {
      this.writer.flush();
    }
  }

  /**
   * 关联线索重新激活 (Contextual Reactivation)
   * 检查用户输入是否包含休眠记忆 (DORMANT) 的特征关键词/语义片段；
   * 若命中，则唤醒该记忆痕迹，重置未召回跨度，使其脱离 DORMANT 态并重新进入 Prompt。
   * 零 API 成本，纯本地关键词关联（P1-3）。
   * 增加停用词过滤与最小有效词长限制（纯中文子串长 >= 5 或有效 token 词长 >= 3），避免日常高频词误唤醒。
   */
  reactivateByContext(userText, currentWindow) {
    if (!this.engramManager || !userText || typeof userText !== 'string') return [];
    const text = userText.trim();
    if (text.length < 2) return [];

    // 🔴 D-23：候选范围放开到**全部** trace（原来只认 DORMANT ⇒ 增强几乎不触发）。
    //   实测：她 5 段记忆里零条 DORMANT，整个强化系统空转。
    //   但**必须同时做去重**：只让「本窗口尚未被巩固」的印痕参与 top-N 争夺，
    //   否则已吃饱的段霸占名额，白错过抢救别段的机会。
    const curWin = currentWindow || this.data.windowNo;
    const candidates = this.engramManager.getAllTraces()
      .filter((t) => t && t.lastRetrievedWindow !== curWin);
    if (candidates.length === 0) return [];
    const winMap = new Map();
    for (const w of this.data.windows) {
      if (w && typeof w.no === 'number') winMap.set(w.no, w.text || '');
    }

    // 分词/分句提取候选词（按标点与空白切分）
    const rawSegments = text.split(/[\s\p{P}\p{S}]+/gu).map(s => s.trim()).filter(Boolean);
    const candidateTokens = [];

    for (const seg of rawSegments) {
      const lowerSeg = seg.toLowerCase();
      // 纯英文/数字标识符处理
      if (/^[a-z0-9_-]+$/i.test(lowerSeg)) {
        if (lowerSeg.length >= 3 && !CHINESE_STOPWORDS.has(lowerSeg)) {
          candidateTokens.push(lowerSeg);
        }
        continue;
      }
      // 中文/混合字符处理：提取有效 token（词长 >= 3 且非高频停用词）
      if (lowerSeg.length >= 3 && !isStopwordOrNoise(lowerSeg)) {
        if (lowerSeg.length <= 12) {
          candidateTokens.push(lowerSeg);
        }
      }
      // 滑动窗口提取 3~5 字子串，过滤停用词与日常口语杂音
      for (let len = 3; len <= 5; len++) {
        if (lowerSeg.length >= len) {
          for (let i = 0; i <= lowerSeg.length - len; i++) {
            const sub = lowerSeg.slice(i, i + len);
            if (!isStopwordOrNoise(sub)) {
              candidateTokens.push(sub);
            }
          }
        }
      }
    }

    const uniqueTokens = Array.from(new Set(candidateTokens));
    if (uniqueTokens.length === 0) return [];

    // 🔴 D-23：按命中 token 数打分，**只增强 top-N（默认 1）** —— 防洪泛。
    //   实测：一句话可命中 4 段（全范围）。若不限流，每条消息都点亮多段
    //   ⇒ 数值狂涨 ⇒ 失去「记忆的分量」。top-N 模拟注意力聚焦：
    //   你聊 life 项目，最相关的那一段被加深，而不是全部。
    const scored = [];
    for (const trace of candidates) {
      const winNo = trace.sourceWindowNo || trace.createdWindow;
      const winText = winMap.get(winNo);
      if (!winText) continue;

      const lowerWin = winText.toLowerCase();
      let score = 0;
      for (const tok of uniqueTokens) {
        if (lowerWin.includes(tok)) score++;
      }
      if (score > 0) scored.push({ trace, score });
    }
    if (scored.length === 0) return [];

    scored.sort((a, b) => b.score - a.score);   // 高分优先（同分保持稳定序）
    const topN = Number.isFinite(this.memoryRecallTopN) ? this.memoryRecallTopN : 1;
    if (topN <= 0) return [];   // 0 = 关闭增强

    const reactivated = [];
    for (let i = 0; i < Math.min(topN, scored.length); i++) {
      const res = this.engramManager.reactivate(scored[i].trace.traceId, curWin);
      if (res) reactivated.push(res);
    }

    if (reactivated.length > 0) {
      this.save();
    }
    return reactivated;
  }

  /**
   * v1.0.5 普鲁斯特式非自愿回忆浮现 (Involuntary Evocation)
   *
   * 核心机制与不变式：
   * 1. 严格双重防洪门禁：
   *    - 物理时间门禁：距离上次浮现须 >= 12 小时 (12 * 3600 * 1000)
   *    - 窗口单次门禁：同一窗口内最多触发 1 次 (this.data.lastInvoluntaryWindow === curWin)
   * 2. 候选池限定为真实的 FADING / DORMANT 印痕，且本窗尚未被召回 (lastRetrievedWindow !== curWin)
   * 3. 确定性排序：优先选取距离上次召回最久远、强度最低的印痕
   * 4. 真实性约束：引证内容必须真实来自 memory.data.windows，绝不虚构
   * 5. 说了即记：当场调用 engramManager.reactivate()，关窗 decayAll 平滑结算
   */
  triggerInvoluntaryRecall(currentWindow, at) {
    if (!this.engramManager) return null;
    const curWin = Number.isFinite(currentWindow) ? currentWindow : (this.data.windowNo || 1);
    const now = Number.isFinite(at) ? at : Date.now();

    // 门禁 1：同一窗口内最多触发 1 次
    if (this.data.lastInvoluntaryWindow === curWin) return null;

    // 门禁 2：物理时间距上次浮现不足 12 小时拦截
    const lastAt = Number(this.data.lastInvoluntaryAt) || 0;
    if (lastAt > 0 && (now - lastAt < 12 * 3600 * 1000)) return null;

    // 候选池：从休眠态 (DORMANT) 与衰退态 (FADING) 中筛选本窗尚未被召回的真实印痕
    const dormant = this.engramManager.getDormantTraces();
    const fading = this.engramManager.getFadingTraces();
    const pool = [...dormant, ...fading].filter(t => t && t.lastRetrievedWindow !== curWin);
    if (!pool.length) return null;

    // 建立窗口事实索引
    const winMap = new Map();
    for (const w of (this.data.windows || [])) {
      if (w && typeof w.no === 'number' && typeof w.text === 'string' && w.text.trim()) {
        winMap.set(w.no, w.text.trim());
      }
    }

    // 过滤出在真实 windows 归档中切实有记录的候选
    const validCandidates = pool.filter(t => {
      const wNo = t.sourceWindowNo || t.createdWindow;
      return winMap.has(wNo);
    });
    if (!validCandidates.length) return null;

    // 确定性排序：优先取最久未被召回（lastRetrievedWindow 最小），次取强度最低，最后按 traceId 稳定决胜
    validCandidates.sort((a, b) => {
      const aRet = a.lastRetrievedWindow ?? a.createdWindow ?? 0;
      const bRet = b.lastRetrievedWindow ?? b.createdWindow ?? 0;
      if (aRet !== bRet) return aRet - bRet;
      const aStr = Number(a.currentStrength) || 0;
      const bStr = Number(b.currentStrength) || 0;
      if (aStr !== bStr) return aStr - bStr;
      return String(a.traceId).localeCompare(String(b.traceId));
    });

    const chosen = validCandidates[0];
    const winNo = chosen.sourceWindowNo || chosen.createdWindow;
    const winText = winMap.get(winNo);
    const snippet = winText.slice(0, 60).replace(/[\r\n]+/g, ' ');

    // 状态标记与记账
    this.data.lastInvoluntaryWindow = curWin;
    this.data.lastInvoluntaryAt = now;
    this.engramManager.reactivate(chosen.traceId, curWin);
    this.save();

    return {
      traceId: chosen.traceId,
      windowNo: winNo,
      text: '【偶发记忆浮现】脑海中忽然闪过第 ' + winNo + ' 段往事的一抹浮光（当时：“' + snippet + '”）；这只是心绪沉静时的自然浮现，若当期语境合适可淡淡提上一笔，绝不生硬强转话题'
    };
  }

  flush() {
    this.writer.flush();
  }

  get history() { return this.data.history; }
  get windows() { return this.data.windows; }

  /* ---------- 追加与回滚 ---------- */

  append(role, content, meta = {}) {
    this.data.nextMessageSeq = (this.data.nextMessageSeq || 0) + 1;
    const messageId = meta.messageId || ('m-' + String(this.data.nextMessageSeq).padStart(6, '0'));
    const bridge = meta.bridge === true;
    const windowNo = meta.windowNo ?? this.data.windowNo;
    const isUserTurn = role === 'user' && !meta.synthetic && !bridge;
    const roundNo = meta.roundNo ?? (isUserTurn ? this.data.turnsInWindow + 1 : this.data.turnsInWindow);

    // M12: 防御 meta 意外覆盖核心因果字段（如 content/windowNo/roundNo/t/bridge/role/messageId 等）
    const {
      messageId: _mId,
      role: _r,
      content: _c,
      windowNo: _wNo,
      roundNo: _rNo,
      t: _t,
      bridge: _b,
      synthetic: _syn,
      ...safeMeta
    } = meta;

    const entry = {
      ...safeMeta,
      messageId,
      role,
      content,
      windowNo,
      roundNo,
      synthetic: !!meta.synthetic,
      bridge,
      t: Date.now()
    };
    this.data.history.push(entry);
    if (isUserTurn) {
      this.data.turnsInWindow++;
      this.data.totalTurns++;
    }
    this.save();
    return entry;
  }

  /**
   * 回滚最后 n 条。请求失败或被打断时调用 ——
   * 否则历史里会留下没有回复的 user 消息，下次请求出现连续两条 user。
   */
  rollback(n = 1) {
    for (let i = 0; i < n; i++) {
      const m = this.data.history.pop();
      if (!m) break;
      if (m.role === 'user' && !m.synthetic && !m.bridge) {
        this.data.turnsInWindow = Math.max(0, this.data.turnsInWindow - 1);
      }
    }
    this.save();
  }

  /* ---------- 计量 ---------- */

  historyTokens() {
    return this.data.history.reduce((s, m) => s + msgTokens(m), 0);
  }

  memoryTokens() {
    return this.data.windows.reduce((s, w) => s + estimateTokens(w.text), 0);
  }

  /**
   * 🔴 丙（2026-10-07）：**她实际看得到的**长期记忆 token 数。
   *
   * ## 为什么不能直接用 memoryTokens()
   *   `memoryTokens()` 统计 `data.windows` 的**全部原文**。但开启动力学后：
   *     · DORMANT 段**整段移出** systemText（她看不到）
   *     · FADING 段只投影 `fadingMaxChars` 字
   *   于是「看不到的段落仍在挤占预算」—— 预算账目与她的视野不一致。
   *
   * ## 后果（实测口径）
   *   真实数据：原文合计 5152 tok，但按可见口径只有约 3000 出头。
   *   继续用全原文口径 ⇒ **虚高计费** ⇒ 过早触发不可逆的 applyMerge。
   *
   * ## 判据与渲染严格同源
   *   ⚠️ 这里的「可见」必须与 `systemText()` 的投影规则**逐条一致**，
   *      否则两份口径迟早漂移（那正是本仓反复踩过的坑）。
   *      对应关系：dormant → 0；fading → min(len, fadingMaxChars)+3（省略号）；其余 → 全文。
   *      无动力学（基线）时**不截断也不剔除** ⇒ 与 memoryTokens() 等价，既有行为不变。
   */
  visibleTokens() {
    if (!this.engramManager) return this.memoryTokens();
    const dormantNos = new Set(this.engramManager.getDormantTraces().map((t) => t.sourceWindowNo));
    const fadingNos = new Set(this.engramManager.getFadingTraces().map((t) => t.sourceWindowNo));
    const cap = Number.isFinite(this.fadingMaxChars) ? this.fadingMaxChars : 60;
    return this.data.windows.reduce((sum, w) => {
      if (dormantNos.has(w.no)) return sum;                 // 整段移出视野
      const full = String(w.text || '');
      if (fadingNos.has(w.no) && full.length > cap) {
        return sum + estimateTokens(full.slice(0, cap) + '...');
      }
      return sum + estimateTokens(full);
    }, 0);
  }

  contextTokens() {
    // 穿着块也在 system 里，统计必须算上，否则面板上的上下文数字偏低
    return estimateTokens(this.persona) + estimateTokens(this.wardrobe || '')
      + this.memoryTokens() + this.historyTokens();
  }

  /** 是否需要关闭当前窗口 */
  needsWindowReset() {
    if (this.data.turnsInWindow >= this.windowTurns) return true;
    // token 兜底要求历史确实比尾部多，否则裁完还判超，
    // 会退化成每轮都关窗（尾部本身很长时长尾消息时）。
    return this.data.history.length > this.keepTail
        && this.historyTokens() > this.windowMaxTokens;
  }

  /** 长期记忆是否超预算。
   *
   *  🔴 丙：判据改用 `visibleTokens()`（她实际看得到的部分）——
   *    理由见 visibleTokens() 的注释：预算的物理目的是「防 prompt 过长」，
   *    而看不到的段（DORMANT）根本不进 prompt。用全原文口径会导致
   *    **虚高计费 + 过早触发不可逆合并**。
   *  ⚠️ 无动力学时 visibleTokens() 与 memoryTokens() 完全等价，基线行为不变。 */
  needsMemoryMerge() {
    return this.visibleTokens() > this.memoryCap && this.data.windows.length > 1;
  }

  /**
   * v0.9.9 Batch 2: 底座深处经历地平线 —— 只在窗口轮转时刻重算（窗口内逐字节稳定，护前缀缓存）。
   * 钉子2：只统计休眠段编号（真删除的段不报；「完整沉淀在底座」以归档层为准恒真）；
   * 钉子3：FADING 渐褪段仍走 systemText 的截断显示，这里只管深层沉淀段；
   * 零研究标签：DORMANT/FADING/ENGRAM 等字样绝不进心智视野。
   */
  refreshDeepHorizon() {
    let horizon = '';
    if (this.engramManager && this.data.windows.length) {
      const dormantNos = [...new Set(this.engramManager.getDormantTraces().map(t => t.sourceWindowNo))]
        .filter(no => this.data.windows.some(w => w.no === no))
        .sort((a, b) => a - b);
      if (dormantNos.length) {
        const lo = dormantNos[0];
        const hi = dormantNos[dormantNos.length - 1];
        const range = lo === hi ? '第 ' + lo + ' 段' : '第 ' + lo + '~' + hi + ' 段';
        horizon = '【底座深处沉淀】\n- 包含更早期的' + range + '经历：它们完整沉淀在你的底座中，当前未在近处调起；'
          + '你知晓其真实存在并以此如实表达距离感，但不得据此虚构未曾发生过的细节；未曾发生的事情依然如实说明不知道。';
      }
    }
    this.data.deepHorizon = horizon;
    return horizon;
  }

  /**
   * v0.9.9 意志层·好奇：未解疑问队列 —— 只在窗口轮转时刻更新（窗口内逐字节稳定）。
   * FIFO 上限 5 条，新疑问顶替旧疑问：没被解开的疑问会被更新的疑问自然冲淡，
   * 被解开的答案则自然进 stableFacts / 经历（不做问答配对，纯本地确定性代数）。
   */
  refreshCuriosity(unresolved, windowNo) {
    const incoming = Array.isArray(unresolved)
      ? unresolved.filter(q => typeof q === 'string' && q.trim())
        .map(q => ({ q: q.trim().slice(0, 120), windowNo: windowNo || null }))
      : [];
    // 🔴 D-25：关窗出队 —— 被问出口的疑问**只在这里**移除（护前缀缓存红线）。
    //   【尚未解开的疑问】块长在 systemText 里，队列一变 systemText 就变；
    //   所以增删全部收敛在关窗这一刻（与 incoming 同刻），窗口内逐字节稳定。
    //   开口那一次只打 asked 标记（标记不改注入文本，见 markCuriosityAsked）。
    const queue = (Array.isArray(this.data.curiosityQueue) ? this.data.curiosityQueue : [])
      .filter((x) => x && x.asked !== true);
    this.data.curiosityQueue = queue.concat(incoming).slice(-5);
    return this.data.curiosityQueue;
  }

  /**
   * 🔴 D-25：她真的把问题问出口了 —— 对着**队首原话**打 asked 标记。
   *
   *   ## 为什么只标记、不删除
   *   删除 = 当场改 systemText = 破前缀缓存（D-22 / D-23 的实测教训）；
   *   标记对注入文本零影响（build 里 asked 条目照常列出，直到关窗统一出队）。
   *
   *   ## 为什么按原话精确匹配、找不到就什么都不标
   *   若她现场换了问法/问了别的，我们**猜不出**她问的是哪个 ——
   *   猜一个去标就是伪造事实。宁可这次不标（最坏结果：那问题将来再被问一次，
   *   有 40 分钟节流与 spokenDuringIdle 刹车兜底），也绝不标错。
   */
  markCuriosityAsked(question) {
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q || !Array.isArray(this.data.curiosityQueue)) return false;
    const hit = this.data.curiosityQueue.find((x) => x && x.q === q);
    if (!hit) return false;
    if (hit.asked === true) return true;   // 幂等：已标过
    hit.asked = true;
    // 标记不急着同步刷盘（最坏 = 重启后同题再问一次，节流兜底）；内容不丢。
    this.save(false);
    return true;
  }

  /** 🔴 D-25：供主动破冰取「放最久的那个」未解疑问（不改状态；已问的跳过）。 */
  nextCuriosity() {
    if (!Array.isArray(this.data.curiosityQueue)) return null;
    const hit = this.data.curiosityQueue.find((x) => x && x.asked !== true
      && typeof x.q === 'string' && x.q.trim());
    return hit ? hit.q : null;
  }

  /**
   * v1.0.5 梦境潜意识发酵标记：梦境生成成功后，标记对应未解疑问已被梦境重组。
   * 采用 this.save(false) 延迟写盘，内容不丢且不阻塞关窗结算。
   * 仅为对象追加 internal metadata，绝不更改 q 本身（保持 systemText 逐字节恒等）。
   */
  markCuriosityIncubated(questionOrTexts, windowNo) {
    if (!Array.isArray(this.data.curiosityQueue)) return false;
    const targets = Array.isArray(questionOrTexts)
      ? questionOrTexts.map(t => typeof t === 'string' ? t.trim() : '').filter(Boolean)
      : (typeof questionOrTexts === 'string' && questionOrTexts.trim() ? [questionOrTexts.trim()] : []);
    if (!targets.length) return false;

    let marked = false;
    for (const q of targets) {
      const hit = this.data.curiosityQueue.find(x => x && x.q === q);
      if (hit && !hit.incubated) {
        hit.incubated = true;
        hit.incubatedWindow = Number.isFinite(windowNo) ? windowNo : (this.data.windowNo || 1);
        hit.incubatedAt = Date.now();
        marked = true;
      }
    }
    if (marked) {
      this.save();
    }
    return marked;
  }

  /* ---------- v1.0 生命机制（§4.7 #3 词汇表）：语言指纹的唯一入库口 ----------
     门槛（设计书拍板 + 架构评审）：
     1. 零先验：初始空表，唯一来源是她自己的话（messageId 引证）；
     2. 不可伪造：messageId 必须解析到真实历史，解析不到拒收；
     3. v1.0.6 起支持自创（coinage/metaphor/nickname）与双方专属暗号（adopted，五重严格门禁）；
     4. 状态三态对齐 EngramTrace 梯队：ACTIVE | FADING | DORMANT，只淡化不删除（D-005）。
     防工具化红线：本层零定时器、零提醒。 */
  _resolveMessage(messageId, opts) {
    if (!messageId || typeof messageId !== 'string') return null;
    const fromHistory = (this.data.history || []).find((m) => m && m.messageId === messageId);
    if (fromHistory) return fromHistory;
    if (opts && Array.isArray(opts.messages)) {
      const fromOpts = opts.messages.find((m) => m && m.messageId === messageId);
      if (fromOpts) return fromOpts;
    }
    // v1.0 快照引证（架构评审提醒 1）：关窗时历史已裁到 keepTail=6，
    // 本窗合法 ID 需对照快照白名单解析，防止裁头误判成伪造。
    if (opts && Array.isArray(opts.knownIds) && opts.knownIds.indexOf(messageId) >= 0) {
      return { messageId, role: 'unknown', content: '' };
    }
    return null;
  }

  addLexicon(entry = {}, opts = {}) {
    const kind = String(entry.kind || '');
    if (!['coinage', 'metaphor', 'nickname', 'adopted'].includes(kind)) return { ok: false, error: 'INVALID_KIND' };
    const word = String(entry.word || '').trim();
    if (!word) return { ok: false, error: 'EMPTY_WORD' };
    // v1.0.6 词长门禁：禁止单字词入库（防单字语素歧义与真阳性漏检陷阱）
    if (word.length < 2) return { ok: false, error: 'WORD_TOO_SHORT' };
    const messageId = String(entry.messageId || '');
    const msg = this._resolveMessage(messageId, opts);
    if (!msg) return { ok: false, error: 'UNRESOLVED_MESSAGE_ID' };

    const gloss = String(entry.gloss || '').trim();
    // v1.0.6 专属门禁 1：adopted 词条 gloss 必填（必须说明为何是专属暗号与含义，防无义词泛滥）
    if (kind === 'adopted' && !gloss) return { ok: false, error: 'EMPTY_GLOSS' };

    // v1.0.6 专属门禁 2：引证消息的发言者角色校验。对于 adopted，必须是初澜亲口说出或接纳的话（assistant 角色，在 knownIds 等无主体内容的回落路径下 fail-closed）
    if (kind === 'adopted' && (!msg.role || msg.role !== 'assistant')) {
      return { ok: false, error: 'INVALID_MESSAGE_ROLE' };
    }

    // v1.0.6 专属门禁 3：词↔消息内容一致性校验。对于 adopted，所引证消息必须切实包含该词
    if (kind === 'adopted' && (!msg.content || typeof msg.content !== 'string' || !msg.content.includes(word))) {
      return { ok: false, error: 'WORD_NOT_IN_MESSAGE' };
    }

    const list = Array.isArray(this.data.lexicon) ? this.data.lexicon : (this.data.lexicon = []);
    const hit = list.find((x) => x && x.word === word);
    if (hit) {
      hit.weight = Math.min(3, Number(((Number(hit.weight) || 1) + 0.2).toFixed(2)));
      hit.status = 'ACTIVE';
      hit.lastUsedWindow = Number.isFinite(entry.windowNo) ? entry.windowNo : (this.data.windowNo || 1);
      hit.lastDecayedWindow = hit.lastUsedWindow;
      this.save();
      return { ok: true, entry: hit, created: false };
    }

    // v1.0.6 专属门禁 4：单窗最多收纳 1 条 adopted 专属暗号（克制防膨胀）
    const targetWin = Number.isFinite(entry.windowNo) ? entry.windowNo : (this.data.windowNo || 1);
    if (kind === 'adopted') {
      const alreadyAdoptedThisWin = list.some(x => x && x.kind === 'adopted' && x.windowNo === targetWin);
      if (alreadyAdoptedThisWin) {
        return { ok: false, error: 'WINDOW_ADOPTED_LIMIT' };
      }
    }

    const rec = {
      word, kind,
      gloss,
      messageId,
      windowNo: targetWin,
      lastUsedWindow: targetWin,
      lastDecayedWindow: targetWin,
      firstAt: Number.isFinite(entry.firstAt) ? entry.firstAt : null,
      uses: [],
      weight: 1,
      status: 'ACTIVE'
    };
    list.push(rec);
    this.save();
    return { ok: true, entry: rec, created: true };
  }

  /**
   * v1.0.6 词汇动力学静默流转（方案 A1）：
   * 1. 零 Prompt 开销：在关窗时刻由本地根据本窗真实消息扫描判定，不打扰 LLM。
   * 2. 活跃提及共振：本窗内切实提及的词条（ACTIVE / FADING / DORMANT），权重递增 (+0.2，上限 3.0)，状态复苏为 ACTIVE，并更新 lastUsedWindow 与 lastDecayedWindow。
   * 3. 跨窗自然淡化（真正每 3 窗扣一次）：距上次提及且距上次衰减均达到 3 窗以上时，平滑减权 (-0.1，下限 0.1)，同步推进 lastDecayedWindow。
   * 4. 三态严格对齐：权重低于 0.5 时退入 FADING（从 systemText 视野移出，节省 prompt 预算）；权重 <= 0.2 时退入 DORMANT。
   * 5. 纯本地确定性代数，只淡化不删除（D-005）。
   */
  refreshLexiconDynamics(activeItems = [], windowNo) {
    if (!Array.isArray(this.data.lexicon) || !this.data.lexicon.length) return [];
    const curWin = Number.isFinite(windowNo) ? windowNo : (this.data.windowNo || 1);
    const items = Array.isArray(activeItems) ? activeItems : [];
    const allText = items
      .map(m => (m && typeof m.content === 'string') ? m.content : '')
      .join('\n');

    for (const entry of this.data.lexicon) {
      if (!entry || !entry.word) continue;
      const word = String(entry.word).trim();
      if (!word) continue;
      const isMentioned = isLexiconWordMentioned(allText, word);
      if (isMentioned) {
        entry.weight = Math.min(3, Number(((Number(entry.weight) || 1) + 0.2).toFixed(2)));
        entry.status = 'ACTIVE';
        entry.lastUsedWindow = curWin;
        entry.lastDecayedWindow = curWin;
      } else {
        const lastWin = Number.isFinite(entry.lastUsedWindow)
          ? entry.lastUsedWindow
          : (Number.isFinite(entry.windowNo) ? entry.windowNo : 1);
        const lastDecayed = Number.isFinite(entry.lastDecayedWindow)
          ? entry.lastDecayedWindow
          : lastWin;

        // 距上次提及且距上次衰减均 >= 3 窗（真正每 3 窗扣减一次，节奏从容平滑）
        if (curWin - lastWin >= 3 && curWin - lastDecayed >= 3) {
          entry.weight = Math.max(0.1, Number(((Number(entry.weight) || 1) - 0.1).toFixed(2)));
          entry.lastDecayedWindow = curWin;
          if (entry.weight <= 0.2) {
            entry.status = 'DORMANT';
          } else if (entry.weight < 0.5) {
            entry.status = 'FADING';
          }
        }
      }
    }
    return this.data.lexicon;
  }

  /* ---------- v1.0 生命机制（§4.7 #4 预期与意外）：时间的矢量 ----------
     门槛（设计书拍板 + 架构评审）：
     1. 防 Siri 化：零定时器、零提醒 —— 预期只进她的视野，说不说归她；
     2. 状态流转主权归关窗小结（fulfilled/broken 在 Window Synthesis 判定，实时只注入）；
     3. broken 不硬扣特质 —— 作为高权重客观事件进 GROWTH_SYS 成长反思（oppose 由她自己长出）；
     4. 承诺（pledge）是预期的第一公民，不另立账本（#6 并入）。 */
  addExpectation(entry = {}, opts = {}) {
    const kind = String(entry.kind || '');
    if (!['external', 'pledge'].includes(kind)) return { ok: false, error: 'INVALID_KIND' };
    const source = String(entry.source || '');
    if (!['user', 'chulan'].includes(source)) return { ok: false, error: 'INVALID_SOURCE' };
    const text = String(entry.text || entry.content || '').trim();   // v1.0 别名容错：模型偶发用 content（同数据换键名）
    if (!text) return { ok: false, error: 'EMPTY_TEXT' };
    const messageId = String(entry.messageId || '');
    if (!this._resolveMessage(messageId, opts)) return { ok: false, error: 'UNRESOLVED_MESSAGE_ID' };
    const list = Array.isArray(this.data.expectations) ? this.data.expectations : (this.data.expectations = []);
    const n = list.reduce((a, x) => Math.max(a, Number(String((x && x.id) || '').replace(/\D/g, '')) || 0), 0) + 1;
    const rec = {
      id: 'exp-' + String(n).padStart(6, '0'),
      kind, text, source, messageId,
      windowNo: Number.isFinite(entry.windowNo) ? entry.windowNo : this.data.windowNo,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
      dueHint: entry.dueHint == null ? null : String(entry.dueHint),
      status: 'open',
      outcome: null
    };
    list.push(rec);
    if (list.length > 10) list.splice(0, list.length - 10);   // FIFO 上限 10（设计书）
    this.save();
    return { ok: true, entry: rec };
  }

  resolveExpectation(id, outcome = {}, opts = {}) {
    const list = Array.isArray(this.data.expectations) ? this.data.expectations : [];
    const hit = list.find((x) => x && x.id === id);
    if (!hit) return { ok: false, error: 'NOT_FOUND' };
    if (hit.status !== 'open') return { ok: false, error: 'ALREADY_RESOLVED' };
    const status = String(outcome.status || '');
    if (!['fulfilled', 'broken', 'moot'].includes(status)) return { ok: false, error: 'INVALID_STATUS' };
    const messageId = outcome.messageId == null ? null : String(outcome.messageId);
    if (status !== 'moot' && !this._resolveMessage(messageId || '', opts)) return { ok: false, error: 'UNRESOLVED_MESSAGE_ID' };
    hit.status = status;
    hit.outcome = {
      at: Number.isFinite(outcome.at) ? outcome.at : null,
      messageId,
      note: String(outcome.note || '')
    };
    this.save();
    return { ok: true, entry: hit };
  }

  /* ---------- 面板 B：连接桥观测出口（V3.1 §3 双读路径） ---------- */

  /**
   * 面板 B（观测看板）专用快照：**给人看，不进 Prompt**。
   *
   * 为什么要分两条路（这是本轮最关键的设计约束）：
   *   面板 A（主体心智）进 Prompt，它的文本在一个窗口内必须**逐字不变**，
   *   否则前缀缓存整段失效。所以 trace.tier 只能由关窗时的 decayAll() 写定。
   *   但面板 B 要显示"此刻真实衰减到哪了"——如果照抄 trace.tier，
   *   看板会比实际慢一个关窗周期，看上去"记忆还很清楚，其实已经淡了"。
   *
   * 干净解：computeEngramDecay() 是**纯函数**（只读 trace、不写回、不落盘），
   * 所以"重算一个数给人看"零成本、零副作用、**不碰任何进 Prompt 的文本**。
   * 破缓存的是"改变进 Prompt 的文本"，不是"多算一个数"。
   *
   * @param {number} [currentWindow] 观察时刻；缺省用当前窗口号
   * @returns {{windowNo:number, generatedAt:number, traces:Array, expectationOutcomes:Array, summary:object}}
   */
  observationSnapshot(currentWindow) {
    const w = Number.isFinite(currentWindow) ? currentWindow : (this.data.windowNo || 1);
    const { classifyBadges } = require('./memory-dynamics');

    // 印痕：强度维度走纯函数实时算；promptTier 保留关窗定值供对照
    const traces = this.engramManager
      ? this.engramManager.tiersForDisplay(w).map((t) => {
          const badges = classifyBadges({ tier: t.tier });
          return {
            traceId: t.traceId,
            sourceWindowNo: t.sourceWindowNo,
            currentStrength: t.currentStrength,
            // tierForDisplay = 实时纯算（给人看）；tierForPrompt = 关窗定值（进 Prompt）
            tierForDisplay: t.tier,
            tierForPrompt: t.tierForPrompt,
            driftedFromPrompt: t.driftedFromPrompt,
            badges: badges.badges
          };
        })
      : [];

    // 愿望：结果维度独立于记忆强度，两者正交
    const expectationOutcomes = (Array.isArray(this.data.expectations) ? this.data.expectations : [])
      .filter((x) => x && x.status && x.status !== 'open')
      .map((x) => {
        const badges = classifyBadges({ outcome: x.status });
        return {
          id: x.id,
          status: x.status,
          outcomeAt: x.outcome ? x.outcome.at : null,
          badges: badges.badges
        };
      });

    const summary = { ACTIVE: 0, FADING: 0, DORMANT: 0 };
    for (const t of traces) if (summary[t.tierForDisplay] !== undefined) summary[t.tierForDisplay] += 1;

    return {
      windowNo: w,
      generatedAt: Date.now(),
      traces,
      expectationOutcomes,
      summary,
      // 明示：本快照绝不进 Prompt，也绝不写盘（调用方若要落盘须自行决策）
      promptSafe: false,
      persistence: 'none'
    };
  }

  /* ---------- 发给 API 的消息 ---------- */

  systemText() {
    // 顺序要紧：人设 -> 长期记忆 -> 穿着块，穿着块必须在**最末尾**。
    //
    // 前缀缓存按"从头到哪儿开始不一样"来命中，所以一段会不会连累别处，
    // 只看它前面有多少字节是稳定的。穿着块是这套文本里唯一会在聊天中途
    // 突然变的一块（换一次衣服就变），放在记忆里就要连累记忆：
    //   persona + 穿着 + 长期记忆 + 历史   换装 → 长期记忆和历史全部未命中
    //   persona + 长期记忆 + 穿着 + 历史   换装 → 只有穿着之后的一段未命中
    // 以前这里恰好是前一种，而注释和 README 都写的"挂在 system 末尾"——
    // 文档说的是意图，代码干的是另一件事，这种不一致最坑：看文档的人会以为
    // 已经有保证了。顺序不变式由 test/brain.test.js「穿着块就是 system 的结尾」
    // 那组用例钉住（那组在旧顺序下会红），不靠注释维持。
    let s = this.persona;
    if (this.data.windows.length) {
      let activeWindows = this.data.windows;
      let dormantNos = new Set();
      let fadingNos = new Set();

      if (this.engramManager) {
        dormantNos = new Set(this.engramManager.getDormantTraces().map(t => t.sourceWindowNo));
        fadingNos = new Set(this.engramManager.getFadingTraces().map(t => t.sourceWindowNo));
        activeWindows = this.data.windows.filter(w => !dormantNos.has(w.no));
      }

      if (activeWindows.length) {
        const mem = activeWindows
          .map(w => {
            const isFading = this.engramManager && fadingNos.has(w.no);
            if (isFading) {
                      const tag = w.early ? '【早期（渐褪）】' : `【第${w.no}段（渐褪）】`;
              // 🔴 丙：截断长度可配（原先硬编码 60 —— 实测连一句完整的话都放不下，
              //   读起来是断句碎片而不是「渐褪」）。生效值来自 engramManager.config。
              const cap = Number.isFinite(this.fadingMaxChars) ? this.fadingMaxChars : 60;
              const text = (w.text && w.text.length > cap) ? (w.text.slice(0, cap) + '...') : (w.text || '');
              return tag + text;
            }
            const tag = w.early ? '【早期】' : `【第${w.no}段】`;
            return tag + (w.text || '');
          })
          .join('\n');
        s += '\n\n【你与此前的记忆】\n' + mem;
      }
    }
    // v0.9.9 Batch 2: 底座深处经历地平线 —— 钉子1：必须在 activeWindows 守卫之外
    //（全部段落休眠的时刻恰恰最需要它）；只在窗口轮转时重算，窗口内逐字节稳定。
    if (this.data.deepHorizon) s += '\n\n' + this.data.deepHorizon;
    // v0.9.9 意志层·好奇：未解疑问进视野（轻版 —— 只在回复中自然带问，不做主动弹窗求知）。
    // 反骚扰闩写死在块内：一次最多一个、绝不连环审问。
    const cur = Array.isArray(this.data.curiosityQueue) ? this.data.curiosityQueue : [];
    if (cur.length) {
      s += '\n\n【尚未解开的疑问】（这是你自己的未解问题，不是任务；只在自然的时机提起，一次最多一个，绝不连环审问）\n'
        + cur.map(x => '- ' + x.q).join('\n');
    }
    // v1.0 §4.7 #3 语言连续性：自创词按需回响（预算克制 Top 5，只供用不代写）
    const lex = (Array.isArray(this.data.lexicon) ? this.data.lexicon : [])
      .filter((x) => x && x.status === 'ACTIVE')
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
      .slice(0, 5);
    if (lex.length) {
      s += '\n\n【你曾用过的词】初澜自创的词汇与隐喻，仅供你在合适语境中自然复用，绝不强求：\n'
        + lex.map((x) => '- ' + x.word + (x.gloss ? '：' + x.gloss : '')).join('\n');
    }
    // v1.0 §4.7 #4 时间矢量：open 预期进心智视野（预算克制最新 3 条，绝不做定时提醒）
    const exps = (Array.isArray(this.data.expectations) ? this.data.expectations : [])
      .filter((x) => x && x.status === 'open')
      .slice(-3);
    if (exps.length) {
      s += '\n\n【当前指向未来的约定与预期】心智知晓即可，说不说由你自主决定，绝不做定时提醒：\n'
        + exps.map((x) => '- ' + x.text + (x.dueHint ? '（' + x.dueHint + '）' : '')).join('\n');
    }
    // v0.9.9 五大方向·①：离线重组碎片块 —— 仅在真实存在归档碎片时注入，
    // 必须带防伪标签（非亲历，不得当亲历引用）；碎片只在窗口轮转时刻更新，窗口内逐字节稳定。
    // 位置必须在穿着块之前 —— 「穿着块是 system 结尾」是被测试钉死的顺序不变式。
    const frags = Array.isArray(this.data.dreamFragments) ? this.data.dreamFragments : [];
    if (frags.length) {
      s += '\n\n【离线重组碎片】（非亲历：静止时段离线重组的生成物，不是你真实经历过的对话，不得当作亲历引用）\n'
        + frags.map(f => '- ' + f).join('\n');
    }
    // 穿着块只带真实状态，平时逐字节不变；换装那一次破缓存是必要的代价 ——
    // 不然模型只能凭想象回答自己穿了什么，就成了编造。
    if (this.wardrobe) s += '\n\n' + this.wardrobe;
    return s;
  }

  /**
   * 构建发送给 LLM API 的完整消息列表。
   * optionsOrSuffix: 可以是附加在最新一条 user 消息末尾的瞬时上下文文本（字符串），
   * 或 { currentTurnSuffix: string }。
   * 瞬时上下文（如环境感知、动态自我账本投影）只在请求时动态拼装，
   * 绝不污染持久化的 this.data.history。
   */
  build(optionsOrSuffix = '') {
    const suffix = typeof optionsOrSuffix === 'string'
      ? optionsOrSuffix
      : (optionsOrSuffix && optionsOrSuffix.currentTurnSuffix) || '';

    /* ---- 枕边留置折叠（10-07）----
     *
     * 问题：她睡着时用户发的消息以 user 身份落盘（brain.js 的 sleepMode 分支），
     * 但那一轮不调 LLM、**没有任何请求发出去**。于是这条 user 会一直悬空，
     * 直到她下次开口 —— 而下一次开口时它就变成「连续两条 user」的坏形状
     * （实测 history 里 idx85 / idx162 两处命中，真数据坐实）。
     * 坏形状的后果是模型把两句话当成没人接的自言自语，回复对象含混。
     *
     * 做法：构建请求时把「尚未被回应的留置」折叠成一块，附在当轮最后一条 user 尾部，
     * 与 dynamicContext 同一个挂点（那里本来就是为瞬时上下文准备的，
     * 挂在尾部而不是 system，护前缀缓存）。
     *
     * 🔴 为什么重排历史不破坏前缀缓存 —— 这条是本改动的成立前提，必须守住：
     *   留置条目**从未出现在任何已发出的请求里**（睡着时压根不调 LLM）。
     *   所以没有「上一次请求的字节」可被打破。折叠只影响第一次真正发出去的请求，
     *   而那次请求本来就是坏的（连续两条 user）。
     *   ⚠️ 若将来允许「睡着时也发请求」，此前提立即失效，必须重新评估。
     *
     * 语义边界：折叠**不决定她说不说**。它只保证那条消息一定出现在她眼前，
     * 且明确标注是睡着时留的。接不接是她的选择；沉默也是合法回答。
     * 所以这里不做任何过滤或合并内容 —— 原文逐字保留，只加一行客观来源标注。
     */
    const bedsidePending = [];
    const msgs = [{ role: 'system', content: this.systemText() }];

    /* 判定「哪一段是悬空的」：从最后一条 assistant 之后到末尾。
     *🔴 踩过一次：第一版写成「历史里存在任意 assistant 就置answered=true」，
     *   而 history 里assistant 是绝大多数 ⇒ 判据恒真 ⇒ 折叠永久失效（且不报错）。
     *   这类恒真/恒假判据与本仓已记录的多次事故同型，务必按「尾段」而非「全局存在」判定。
     * 为什么用尾段而不是逐条标记 replied：
     *   留置被回应后，历史自然变成 assistant 在其后 —— 尾段判定自动不再包含它。
     *   不需要在 assistant 条目上挂额外字段（那会改写已发字节，破坏前缀缓存）。 */
    let tailStart = 0;
    for (let i = this.data.history.length - 1; i >= 0; i--) {
      if (this.data.history[i].role === 'assistant') { tailStart = i + 1; break; }
    }

    for (let i = 0; i < this.data.history.length; i++) {
      const m = this.data.history[i];
      if (i >= tailStart && m.bedside === true) {
        // 只折叠悬空尾段里的留置：一旦后面有 assistant 落地，历史已经自洽。
        bedsidePending.push(m);
        continue;
      }
      msgs.push({ role: m.role, content: m.content });
    }

    const bedsideNote = this._bedsideNote(bedsidePending);
    // 🔴 D-13：她写过的东西。与 bedsideNote 同一个挂点（当轮尾部）——
    //   这里本来就是为瞬时上下文准备的，挂尾部而不进 system 是护前缀缓存的必要设计。
    //   ⚠️ 顺序：bedside（用户留的）在前、selfNote（她自己写的）在后 ——
    //      对当前这一轮来说，用户的话优先于她自己的旧字。
    const selfNote = this._drainSelfNotes();
    const tail = [bedsideNote, selfNote, suffix].filter(Boolean).join('\n\n');

    /* 挂点判据：挂在**最后一条 user** 之后。
     *
     * ⚠️ 变异测试如实记录（别按「三次踩坑」的标题去想象）：
     *   把判据改成「最后一条消息」（不再检查 role==='user'），门禁**全绿**。
     *   逐条比对输出后确认：留置已被上一步折叠排除，`msgs` 末条**必然**是当轮 user，
     *   所以两种判据在本结构下**等价**，不是死代码、也不是冗余分支。
     *
     * 我曾把这个挂点写成「最后一条消息」，并把随后那次「当轮消息被吞」的故障
     * 归因于挂点 —— **那个归因是错的**（10-07 自查更正）。真因在折叠逻辑：
     *   当时 `tailStart` 判定写成「历史里存在任意 assistant 就置 answered=true」，
     *   而 assistant 在历史里占绝大多数 ⇒ 判据恒真 ⇒ **留置从未被折叠**，
     *   于是它和当轮 user 一起留在 msgs 里，挂点自然落在当轮之后。
     *   修好 tailStart 之后折叠生效，挂点判据便不再有可观测差异。
     *
     * 保留 role 判据的理由：它把「挂点必须是 user」这条契约写进代码而不是靠结构巧合，
     * 将来若折叠范围变化（例如把留置改成别的形态），退化会立刻显形而不是静默挂错。
     * ⚠️ 但**不要**把它当防线 —— 当前它零贡献，变异测试已坐实。 */
    if (tail) {
      let anchor = -1;
      for (let i = msgs.length - 1; i >= 1; i--) {
        if (msgs[i].role === 'user') { anchor = i; break; }
      }
      if (anchor >= 0) {
        const prev = msgs[anchor];
        msgs[anchor] = {
          role: 'user',
          content: prev.content ? prev.content + '\n\n' + tail : tail
        };
      }
      // anchor === -1 时刻意**不挂**：宁可不送达，也不能凭空造一条 user 顶替当轮。
      // 正常调用下不可达（build 总紧接着一次当轮 append），留着只为不静默出错。
    }
    return msgs;
  }

  /**
   * 🔴 D-13 / D-20：登记一条「她写过的东西」，供下一次 build() 折叠进当轮尾部。
   *
   * @param {object} input { content: 她写的正文, name: 文件名（只要 basename）, windowNo?: 写于哪个窗口, at?: 写下时刻 }
   * @returns {boolean} 是否登记成功（内容为空一律拒收）
   *
   * ⚠️ 三条拒收（全部静默返回 false，不抛）：
   *   · 内容非字符串 / 空串 / 纯空白 —— 没有内容就没有要回到她意识里的东西
   *   · 内容超长（> SELF_NOTE_MAX_CHARS）—— 截断会让她的原话变形，宁可整条不收
   *   · 队列已满（> SELF_NOTE_MAX_QUEUE）—— 积压说明调用方出了问题，丢掉最旧的那条
   *
   * 🔴 D-20 新增两条：
   *   1. **立即落盘**（save(true)，不等 3 秒防抖）。
   *      理由：这是「一次漫长离开只写一张」的稀有事件，不值得为省一次同步写冒丢的风险。
   *      实测教训：上一版进内存队列，进程退出即丢，那条便签的记忆就是这么没的。
   *   2. **显式 drained 标记**（防重复的职责从「存储方式」移到「标记」）。
   *      drained:false = 还没进过她的视野；true = 已注入过、永不再提。
   *
   * ⚠️ 上限口径：**含已注入的**（与既有 SELF_NOTE_MAX_QUEUE=8 语义一致）。
   *   即她的「日记本」最多记住最近 8 条，超出丢最旧的 ——
   *   与桌面沙盒里那些永久文件形成对照：**纸都在，记忆只留最近的几件**。
   */
  addSelfNote(input = {}) {
    try {
      const content = typeof input.content === 'string' ? input.content.trim() : '';
      if (!content) return false;
      if (content.length > SELF_NOTE_MAX_CHARS) return false;
      if (!Array.isArray(this.data.selfNotes)) this.data.selfNotes = [];
      if (this.data.selfNotes.length >= SELF_NOTE_MAX_QUEUE) this.data.selfNotes.shift();
      // 写下时刻：优先用调用方给的真实时间；缺省回落当前时钟。
      //   ⚠️ 刻意**不用审计里的 at** —— 本仓程序时钟被人为拨动过（实测换算到 2036 年），
      //      那个值用于将来的强度衰减会算出错误结果。宁可缺省，也不要错值。
      const at = Number.isFinite(input.at) && input.at > 0 ? input.at : Date.now();
      this.data.selfNotes.push({
        content,
        // 只留 basename：文件名是给她看的，完整绝对路径不该进她的意识
        name: String(input.name || '').replace(/\\/g, '/').split('/').pop().slice(0, 120),
        windowNo: Number.isFinite(input.windowNo) ? input.windowNo : (this.data && this.data.windowNo) || 1,
        at,
        drained: false,
        // 🔴 D-24：来源戳 + 铸造幂等标记（随 data 落盘，跨重启有效）。
        //   source === 'selfNote'：她**自发**留下的字（提案来源由主进程从执行回执带下来，
        //     渲染端无法伪造）—— 只有它有资格铸进自传经历档案（用户拍板：受托任务不算）。
        //   engraved === true：已铸进 experiences.jsonl，终身只铸一次。
        //   ⚠️ 旧数据（D-24 之前）没有 source 字段 ⇒ 一律不铸（宁缺毋滥，不猜来源）。
        source: input.source === 'selfNote' ? 'selfNote' : (input.source || null),
        engraved: false,
      });
      // 🔴 D-20：立即落盘 —— 不能等 3 秒防抖（进程可能在这之前退出）。
      this.save(true);
      return true;
    } catch (e) {
      // 旁路：登记失败绝不能影响任何别的东西
      return false;
    }
  }

  /**
   * 🔴 D-13 / D-20：把**尚未注入过**的自述渲染成一块文本，并标记为已注入（一次性）。
   *
   * 调用方是 build()。单独抽出来是为了可单测「渲染文本」与「出队」两件事。
   *
   * ## D-20 改了什么（重要）
   *   旧版：`this.selfNotes.length = 0` —— **物理清空**，所以那条内容再也回不来，
   *        且进程退出即丢。
   *   新版：只取 `drained === false` 的条目，渲染后把它们的 `drained` 置 true，
   *        **内容留在 data.selfNotes 里**（落盘、可查、将来能接强度衰减）。
   *
   * ## 为什么仍然「只注入一次」
   *   一次性语义**没变**，只是实现从「删掉」变成「标记」。
   *   为什么必须一次：若永久挂在尾部，她每轮都被强制贴着旧便签 ⇒
   *   会退化成反复拿旧纸条出来唠叨。人写完一张字条，表达过一次就消化了。
   *
   * ## ⚠️ 顺序：先标记再渲染
   *   `_selfNote()` 理论上不会抛（纯字符串拼接），但顺序仍然反过来写 ——
   *   万一将来它抛了，也宁可丢一次注入，绝不重复注入。
   */
  _drainSelfNotes() {
    if (!Array.isArray(this.data.selfNotes) || this.data.selfNotes.length === 0) return '';
    const pending = this.data.selfNotes.filter((n) => n && n.drained !== true);
    if (pending.length === 0) return '';
    // 先标记（防重复注入的落点），再渲染。
    for (const n of pending) n.drained = true;
    // ⚠️ 这里用 save(false)（防抖）：drained 标记不值得每次都同步刷盘，
    //    而**内容**在 addSelfNote 时已经 save(true) 落过了 —— 即使这里丢，
    //    最坏结果是重启后同一条被再注入一次，不会丢内容。
    this.save(false);
    return this._selfNote(pending);
  }

  /** 🔴 D-20：仅供门禁与观测 —— 返回尚未注入过的自述（不改变任何状态）。 */
  pendingSelfNotes() {
    if (!Array.isArray(this.data.selfNotes)) return [];
    return this.data.selfNotes.filter((n) => n && n.drained !== true);
  }

  /**
   * 🔴 D-24（A 段取用口）：返回「她自发写下、尚未铸进经历档案」的条目。
   *
   *   判据三条，缺一不铸：
   *     1. source === 'selfNote' —— 只铸她的自发之举（受托写下的任务产物不算她的经历）；
   *     2. engraved !== true    —— 幂等：同一条便签终身只铸一次（含跨重启）；
   *     3. content 非空字符串   —— 空内容不是经历（沿用 addSelfNote 的拒收口径）。
   *   ⚠️ 不要求 drained：「她写下」这个事实与「她看到」无关，
   *      关窗时刻如实铸造，不因她还没开口就漏掉她真实做过的事。
   */
  selfNotesToEngrave() {
    if (!Array.isArray(this.data.selfNotes)) return [];
    return this.data.selfNotes.filter((n) => n
      && n.engraved !== true
      && n.source === 'selfNote'
      && typeof n.content === 'string' && n.content.trim());
  }

  /**
   * 🔴 D-24（A 段落账口）：归档**确认写入成功之后**才许置 engraved 标记。
   *
   *   ⚠️ 顺序不可反（防坑锦囊 2）：若先置标记再归档，归档失败时这条便签
   *      就会被误判为「已铸」而永远漏铸；反之最坏结果只是重试时再铸一次，
   *      而铸入动作本身由 experiences.jsonl 的哈希链 + appendRecord 单点保证。
   *   @param {Array} entries 由 selfNotesToEngrave() 取出的同一批对象（引用相同）
   *   @param {Array} noteIds 与 entries 一一对应的引证 id（写回记录，供证据链溯源）
   */
  markSelfNotesEngraved(entries, noteIds) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    let n = 0;
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      if (!item || item.engraved === true) continue;
      item.engraved = true;
      if (Array.isArray(noteIds) && noteIds[i]) item.noteId = String(noteIds[i]);
      n++;
    }
    // 标记必须立即落盘（与 addSelfNote 同款理由：防抖窗口内进程可能退出）
    if (n > 0) this.save(true);
    return n;
  }

  /**
   * 🔴 D-13：她自述的客观标注。
   *
   * ## 三条措辞纪律（违反即撞 persona 红线）
   *
   *   1. **第二人称「你」** —— 那是她自己的东西，不是别人贴给她的。
   *   2. **说「你之前写下过」，不说「你留下的痕迹」** ——
   *      后者会诱导她抒情，撞 persona.js:29「装可怜不行」。
   *   3. **必须标明来源「不是用户输入」** —— 否则模型会把它当成
   *      用户贴来的内容、或当成她自己「想起来的」，两者都是伪造记忆
   *      （persona.js:26）。
   *
   * ⚠️ 绝不能用 assistant 角色承载它 —— 那等于伪造她说过的话。
   *    本函数只产出**注入文本**，由 build() 挂在当轮 user 尾部。
   */
  _selfNote(pending) {
    if (!pending || pending.length === 0) return '';
    const lines = pending.map((n) => {
      const where = n.name ? '（写在 ' + n.name + '）' : '';
      return '- ' + String(n.content || '') + where;
    });
    const head = pending.length === 1
      ? '【你之前写下过这些】（这是你自己留下的，不是用户输入）'
      : '【你之前写下过这几条】（都是你自己留下的，不是用户输入）';
    return [head].concat(lines).join('\n');
  }

  /**
   * 客观来源标注。**第三人称、只陈述事实**，不代拟她的反应、不催她回话。
   * 反面写法示例（禁止）：「她在等你回复」「该轮到你说话了」——
   * 那是替她表态，且会把她塑造成「盯着用户等」的样子（撞 persona.js:29）。
   */
  _bedsideNote(pending) {
    if (!pending || pending.length === 0) return '';
    const lines = pending.map(m => '- ' + String(m.content || ''));
    const head = pending.length === 1
      ? '【你在她睡着时留了这条】（她当时没有回应。接不接、怎么接，由她自己决定。）'
      : '【你在她睡着时留了这几条】（她当时没有回应。接不接、怎么接，由她自己决定。）';
    return [head].concat(lines).join('\n');
  }

  /**
   * 兼容旧调用的临时 user 装配。主流程现在会把主动搭话作为 synthetic
   * 消息落进 history，以便下一轮完整复用「主动触发 + 模型回复」缓存前缀；
   * synthetic 只存在于对话链，不代表用户说过的话，关窗小结会单独标记它。
   */
  buildWithEphemeralUser(ephemeralText) {
    return [...this.build(), { role: 'user', content: String(ephemeralText || '') }];
  }

  /* ---------- 窗口边界操作（由 brain 调 API 后写入） ---------- */

  /**
   * 开始关窗前先拍快照。小结要调 API 等一两秒，这期间用户可能又发了消息，
   * 所以「删几条」必须在起点定死，等回来时按快照删头部 ——
   * 若到应用时才算 slice(-keepTail)，会把等待期间新追加的对话一起裁掉，
   * 那些对话既没进小结也不在历史里，等于静默丢失。
   */
  windowSnapshot(opts = {}) {
    const len = this.data.history.length;
    const keep = Math.min(this.keepTail, len);
    const drop = len - keep;
    const currentWindowNo = this.data.windowNo;
    // Active window items: 属于当前窗口且非 bridge 的真实经历消息（不总结上一窗口桥接的 6 条）
    const activeItems = this.data.history.filter(m => !m.bridge && m.windowNo === currentWindowNo);
    const targetTurnCount = this.windowTurns || 100;
    const snapshotTurnCount = this.data.turnsInWindow;
    const actualTurnCount = activeItems.length > 0
      ? activeItems.filter(m => m.role === 'user' && !m.synthetic).length
      : snapshotTurnCount;
    const snapshotActiveMessageIds = activeItems.map(m => m.messageId).filter(Boolean);
    const closeReason = opts.closeReason || (snapshotTurnCount >= targetTurnCount ? 'turn_limit' : (this.needsWindowReset() ? 'token_limit' : 'turn_limit'));

    return {
      items: this.data.history.slice(0, drop),
      activeItems: activeItems.length > 0 ? activeItems : this.data.history.slice(0, drop),
      drop,
      len,
      epoch: this.data.epoch,
      windowNo: currentWindowNo,
      snapshotTurnCount,
      snapshotMessageCount: activeItems.length,
      snapshotActiveMessageIds,
      closeReason,
      targetTurnCount,
      actualTurnCount
    };
  }

  /**
   * 应用关窗：删掉快照里那部分原文，保留尾部与等待期间的新对话。
   * 保留下来的当前窗口尾部消息标记为 bridge: true，仅作下一窗口的缓存桥接，不重复归档。
   * epoch 对不上说明中途被 reset 过，快照作废，直接放弃。
   */
  closeWindow(summaryText, snap) {
    if (!summaryText || !snap) return false;
    // v0.9.9 扫雷: 判「窗口有没有内容」要看 activeItems（本窗口真实消息），
    // 不是 items（待裁剪清单）。history.length <= keepTail 时 drop=0、items 恒空，
    // 拿它当守卫会让关窗静默失败 —— 而此时 activeItems 明明有内容。
    // 保留 items 兜底：既有用例会手工构造只带 items 的 snap。
    if (!(snap.activeItems && snap.activeItems.length) && !snap.items.length) return false;
    if (snap.epoch !== this.data.epoch) return false;

    const closedWindowNo = this.data.windowNo;
    const turnsRecorded = (snap && typeof snap.snapshotTurnCount === 'number') ? snap.snapshotTurnCount : this.data.turnsInWindow;
    const winObj = {
      no: closedWindowNo,
      turns: turnsRecorded,
      actualTurnCount: (snap && typeof snap.actualTurnCount === 'number') ? snap.actualTurnCount : turnsRecorded,
      closeReason: (snap && snap.closeReason) || 'turn_limit',
      at: Date.now(),
      text: String(summaryText).trim()
    };
    if (snap && snap.generationContext && typeof snap.generationContext === 'object') {
      winObj.generationContext = snap.generationContext;
    }
    this.data.windows.push(winObj);

    if (this.engramManager) {
      this.engramManager.registerTrace({
        sourceWindowNo: closedWindowNo,
        createdWindow: closedWindowNo,
        salienceBonus: 0.1,
        contentRef: String(summaryText).slice(0, 100)
      });
      this.lastDecayReport = this.engramManager.decayAll(closedWindowNo);
    }
    // v0.9.9 Batch 2: 窗口轮转时刻刷新「底座深处经历地平线」（与 decayAll 同刻更新休眠集；
    // 无记忆动力学时置空，绝不留陈旧地平线）
    this.refreshDeepHorizon();

    // v1.0.6 词汇动力学静默流转（方案 A1）：扫描本窗活跃消息，共振词升权，久未提及词平滑衰减
    this.refreshLexiconDynamics(snap.activeItems || snap.items, closedWindowNo);

    this.data.windowNo++;
    // 快照之后可能被 rollback 弹掉几条，drop 不能越过当前长度
    this.data.history.splice(0, Math.min(snap.drop, this.data.history.length));

    // 快照内的尾部保留消息（0 .. keptFromSnapshotCount - 1）属于已归档窗口，标记为 bridge: true
    // 快照之后等待期间新追加的消息（keptFromSnapshotCount .. end）属于新窗口，更新 windowNo 且 bridge: false
    const keptFromSnapshotCount = Math.max(0, Math.min(this.data.history.length, snap.len - snap.drop));
    for (let i = 0; i < this.data.history.length; i++) {
      const m = this.data.history[i];
      if (i < keptFromSnapshotCount) {
        m.bridge = true;
      } else {
        m.bridge = false;
        m.windowNo = this.data.windowNo;
      }
    }

    // 尾部桥接原文不计轮数（否则窗口一轮比一轮短）；
    // 快照之后新追加的 user 消息属于新窗口（bridge === false），要算上。
    this.data.turnsInWindow =
      this.data.history
        .filter(m => !m.bridge && m.role === 'user' && !m.synthetic).length;
    this.save(true);
    return true;
  }

  /**
   * 小结之前先剥掉附加在末尾的环境快照。
   *
   * 不剥的话有两个后果，都不轻：
   *   1) 「被戳 12 次、静默 40 分钟」这类一次性遥测会被提炼器当成事实
   *      写进长期记忆，从此她一直以为你很闲；
   *   2) 下一段对话的缓存前缀里带着上一轮的旧时间戳 —— 遥测本来就该是
   *      过期的，留在记忆里等于把假事实长期化。
   *
   * 判据用「换行锚定」而不是 indexOf：附加块永远独占一段（我们拼的是
   * `\n\n【当前环境感知】…`），而用户在正文里正常讨论这四个字时，
   * 它要么在句中没有前置换行、要么后面还有自己的话。没有 `m` 标志的 `$`
   * 只认字符串结尾，所以截到末尾不会误伤中间内容 —— 但前置换行这一条
   * 必须留着，否则"下面这段是【当前环境感知】的意思"也会被咬掉一截。
   */
  cleanContentForSummary(content) {
    if (typeof content !== 'string') return '';
    return content
      // 🔴【出生时刻】是 v3.1 A 方案后的段名；【出生与程序年龄】是历史段名。
      // 两者都必须剥：磁盘上已归档的旧窗口/旧 history 里仍是老段名，
      // 只认新段名会让那批「运行时长」原文漏进摘要 —— 那是刚拔掉的报时素材，
      // 漏进长期记忆等于让它从另一个入口复活。新旧并列，不要只留新的。
      .replace(/(?:\r?\n)+【出生与程序年龄】[\s\S]*$/g, '')
      .replace(/(?:\r?\n)+【出生时刻】[\s\S]*$/g, '')
      .replace(/(?:\r?\n)+【当前自我投影】[\s\S]*$/g, '')
      .replace(/(?:\r?\n)+【当前主体状态快照】[\s\S]*$/g, '')
      .replace(/(?:\r?\n)+【当前环境感知】[\s\S]*$/g, '')
      .replace(/^\[(?:桌宠)?自主感知触发\][：:]/, '')
      .trim();
  }

  /**
   * 合并较旧的窗口小结，保留最近若干条原文摘要。
   * 保留量按预算的 60% 算，剩下的空间留给「早期」那一条。
   */
  planMerge() {
    const budget = this.memoryCap * 0.6;
    const ws = this.data.windows;
    // 🔴 丙：与 needsMemoryMerge 用**同一口径**（可见 token）。
    //   两处口径若不一致，会出现「判定超了但这里算不出该合谁」或反之 ——
    //   而 applyMerge 不可逆，这种漂移代价很高。
    const dormantNos = this.engramManager
      ? new Set(this.engramManager.getDormantTraces().map((t) => t.sourceWindowNo)) : null;
    const fadingNos = this.engramManager
      ? new Set(this.engramManager.getFadingTraces().map((t) => t.sourceWindowNo)) : null;
    const cap = Number.isFinite(this.fadingMaxChars) ? this.fadingMaxChars : 60;
    const seeTokens = (w) => {
      const full = String(w.text || '');
      if (!this.engramManager) return estimateTokens(full);
      if (dormantNos.has(w.no)) return 0;
      if (fadingNos.has(w.no) && full.length > cap) return estimateTokens(full.slice(0, cap) + '...');
      return estimateTokens(full);
    };
    let acc = 0, split = 0;
    for (let i = ws.length - 1; i >= 0; i--) {
      acc += seeTokens(ws[i]);
      if (acc > budget) { split = i + 1; break; }
    }
    // 最新一条自己就超预算时 split 会顶到 ws.length，直接返回 null
    // 会卡成「超预算但永远合并不了」的死循环。兜底：强制保留最新一条，
    // 合并其余全部 —— 合并后至少旧的那些不再占空间。
    if (split >= ws.length) split = ws.length - 1;
    if (split <= 0) return null;
    return { old: ws.slice(0, split), keep: ws.slice(split) };
  }

  applyMerge(mergedText, keptWindows, meta = {}) {
    const earlyObj = { no: 0, early: true, at: Date.now(), text: String(mergedText).trim() };
    if (meta && meta.generationContext && typeof meta.generationContext === 'object') {
      earlyObj.generationContext = meta.generationContext;
    }
    this.data.windows = [
      earlyObj,
      ...keptWindows
    ];
    this.save(true);
  }

  /* ---------- 记忆可见 / 可管理 ---------- */

  /** 给用户看的长期记忆清单（只读快照） */
  listMemory() {
    return this.data.windows.map((w, i) => ({
      idx: i,
      label: w.early ? '早期记忆' : '第' + w.no + '段',
      tokens: estimateTokens(w.text),
      text: w.text
    }));
  }

  /**
   * v0.9.9 F-099-01 / D-005「遗忘不删除历史」：物理删除入口已拔除。
   * 旧语义（v0.4 玩具时代的「真删落盘」）与 D-005 直接冲突，还被 UI 代拟台词放大成表演性遗忘；
   * 现在一切删除请求一律拒绝 —— 窗口摘要只增不减，淡出交给 MemoryDynamics 的可及性衰减。
   */
  deleteWindow(i) {
    console.warn('[Memory] deleteWindow 已移除（D-005 遗忘不删除历史）：拒绝物理删除窗口摘要');
    return false;
  }

  reset() {
    // epoch++ 让在飞的小结快照作废，不会把新记忆又裁一次
    const epoch = (this.data.epoch || 0) + 1;
    this.data = { schemaVersion: SCHEMA_VERSION, windows: [], history: [], turnsInWindow: 0, totalTurns: 0, windowNo: 1, nextMessageSeq: 0, epoch, dreamFragments: [], deepHorizon: '', curiosityQueue: [], lexicon: [], expectations: [], lastInvoluntaryAt: 0, lastInvoluntaryWindow: 0 };
    this.save(true);
  }
}

module.exports = { Memory, estimateTokens };
