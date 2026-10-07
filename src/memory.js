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

class Memory {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.opts = opts;
    this.path = path.join(dir, 'memory.json');
    this.windowTurns = opts.windowTurns ?? 100;          // 多少轮关一次窗口
    this.windowMaxTokens = opts.windowMaxTokens ?? 12000; // 兜底：单窗口 token 上限
    this.keepTail = opts.keepTailMessages ?? 6;           // 重置时保留几条原文，避免失忆感
    this.memoryCap = opts.memoryCapTokens ?? 6000;        // Prompt Memory 长期记忆预算（基线 6000）
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
     * ## 为什么是内存队列（刻意不落盘）
     *   决策「一次性」：注入过一次即出队。
     *   若落盘，冷启动会把「早已注入过」的条目重新读回来 ⇒ 重复注入
     *   ⇒ 她会以为写过两遍。**宁可丢一次，也不重复。**
     *   ⚠️ 已知代价：进程重启时未注入的条目会丢。接受。
     *
     * ## 为什么不写进 data.history
     *   那会改写已发出的字节 ⇒ 破坏前缀缓存（本仓铁律）。
     *   本队列只参与 build() 的**当轮尾部**拼接，不碰历史一个字节。
     */
    this.selfNotes = [];
    this.data = { schemaVersion: SCHEMA_VERSION, windows: [], history: [], turnsInWindow: 0,
                  totalTurns: 0, windowNo: 1, nextMessageSeq: 0, epoch: 0, dreamFragments: [], deepHorizon: '', curiosityQueue: [],
                  lexicon: [], expectations: [] };   // v1.0 §4.7 #3/#4：语言指纹 + 时间矢量（零先验空白）

    // v0.9.7: 记忆痕迹动力学管理器 (Memory Dynamics & Synaptic Pruning)
    const dynamicsEnabled = opts.memoryDynamics !== undefined
      ? Boolean(opts.memoryDynamics)
      : (opts.experimentModules ? Boolean(opts.experimentModules.memoryDynamics) : false);
    if (dynamicsEnabled) {
      const { EngramTraceManager } = require('./memory-dynamics');
      this.engramManager = new EngramTraceManager(opts.engramConfig);
    } else {
      this.engramManager = null;
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
                    lexicon: [], expectations: [], ...data, nextMessageSeq: Math.max(seq, data.nextMessageSeq || 0) };
      // v1.0 兼容平移：旧档案缺字段 → 空表；脏数据 → 归一为数组（绝不静默丢历史）
      this.data.lexicon = Array.isArray(this.data.lexicon) ? this.data.lexicon : [];
      this.data.expectations = Array.isArray(this.data.expectations) ? this.data.expectations : [];
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

    const dormantTraces = this.engramManager.getDormantTraces();
    if (!dormantTraces || dormantTraces.length === 0) return [];

    const reactivated = [];
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

    for (const trace of dormantTraces) {
      const winNo = trace.sourceWindowNo || trace.createdWindow;
      const winText = winMap.get(winNo);
      if (!winText) continue;

      const lowerWin = winText.toLowerCase();
      let matched = false;

      for (const tok of uniqueTokens) {
        if (lowerWin.includes(tok)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        const res = this.engramManager.reactivate(trace.traceId, currentWindow || this.data.windowNo);
        if (res) reactivated.push(res);
      }
    }

    if (reactivated.length > 0) {
      this.save();
    }
    return reactivated;
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

    const entry = {
      messageId,
      role,
      content,
      windowNo,
      roundNo,
      synthetic: !!meta.synthetic,
      bridge,
      t: Date.now(),
      ...meta
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

  /** 长期记忆是否超预算 */
  needsMemoryMerge() {
    return this.memoryTokens() > this.memoryCap && this.data.windows.length > 1;
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
    const queue = Array.isArray(this.data.curiosityQueue) ? this.data.curiosityQueue : [];
    this.data.curiosityQueue = queue.concat(incoming).slice(-5);
    return this.data.curiosityQueue;
  }

  /* ---------- v1.0 生命机制（§4.7 #3 词汇表）：语言指纹的唯一入库口 ----------
     门槛（设计书拍板 + 架构评审）：
     1. 零先验：初始空表，唯一来源是她自己的话（messageId 引证）；
     2. 不可伪造：messageId 必须解析到真实历史，解析不到拒收；
     3. v1 只收自创（coinage/metaphor/nickname）—— adopted 仅枚举占位，明确拒收；
     4. 状态三态对齐 EngramTrace 梯队：ACTIVE | FADING | DORMANT，只淡化不删除（D-005）。
     防工具化红线：本层零定时器、零提醒。 */
  _resolveMessage(messageId, opts) {
    if ((this.data.history || []).some((m) => m && m.messageId === messageId)) return true;
    // v1.0 快照引证（架构评审提醒 1）：关窗时历史已裁到 keepTail=6，
    // 本窗合法 ID 需对照快照白名单解析，防止裁头误判成伪造。
    return !!(opts && Array.isArray(opts.knownIds) && opts.knownIds.indexOf(messageId) >= 0);
  }

  addLexicon(entry = {}, opts = {}) {
    const kind = String(entry.kind || '');
    if (!['coinage', 'metaphor', 'nickname', 'adopted'].includes(kind)) return { ok: false, error: 'INVALID_KIND' };
    if (kind === 'adopted') return { ok: false, error: 'ADOPTED_NOT_YET' };   // v1 拍板：只收自创，占位声明
    const word = String(entry.word || '').trim();
    if (!word) return { ok: false, error: 'EMPTY_WORD' };
    const messageId = String(entry.messageId || '');
    if (!this._resolveMessage(messageId, opts)) return { ok: false, error: 'UNRESOLVED_MESSAGE_ID' };
    const list = Array.isArray(this.data.lexicon) ? this.data.lexicon : (this.data.lexicon = []);
    const hit = list.find((x) => x && x.word === word);
    if (hit) {
      hit.weight = Math.min(3, (Number(hit.weight) || 1) + 0.2);
      hit.status = 'ACTIVE';
      this.save();
      return { ok: true, entry: hit, created: false };
    }
    const rec = {
      word, kind,
      gloss: String(entry.gloss || ''),
      messageId,
      firstAt: Number.isFinite(entry.firstAt) ? entry.firstAt : null,
      uses: [],
      weight: 1,
      status: 'ACTIVE'
    };
    list.push(rec);
    this.save();
    return { ok: true, entry: rec, created: true };
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
              const text = (w.text && w.text.length > 60) ? (w.text.slice(0, 60) + '...') : (w.text || '');
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
   * 🔴 D-13：登记一条「她写过的东西」，供下一次 build() 折叠进当轮尾部。
   *
   * @param {object} input { content: 她写的正文, name: 文件名（只要 basename）, windowNo?: 写于哪个窗口 }
   * @returns {boolean} 是否登记成功（内容为空一律拒收）
   *
   * ⚠️ 三条拒收（全部静默返回 false，不抛）：
   *   · 内容非字符串 / 空串 / 纯空白 —— 没有内容就没有要回到她意识里的东西
   *   · 内容超长（> SELF_NOTE_MAX_CHARS）—— 截断会让她的原话变形，宁可整条不收
   *   · 队列已满（> SELF_NOTE_MAX_QUEUE）—— 积压说明调用方出了问题，丢掉最旧的那条
   */
  addSelfNote(input = {}) {
    try {
      const content = typeof input.content === 'string' ? input.content.trim() : '';
      if (!content) return false;
      if (content.length > SELF_NOTE_MAX_CHARS) return false;
      if (this.selfNotes.length >= SELF_NOTE_MAX_QUEUE) this.selfNotes.shift();
      this.selfNotes.push({
        content,
        // 只留 basename：文件名是给她看的，完整绝对路径不该进她的意识
        name: String(input.name || '').replace(/\\/g, '/').split('/').pop().slice(0, 120),
        windowNo: Number.isFinite(input.windowNo) ? input.windowNo : (this.data && this.data.windowNo) || 1,
      });
      return true;
    } catch (e) {
      // 旁路：登记失败绝不能影响任何别的东西
      return false;
    }
  }

  /**
   * 🔴 D-13：把队列里的自述渲染成一块文本，**并清空队列**（一次性）。
   *
   * 调用方是 build()。单独抽出来是为了可单测「渲染文本」与「出队」两件事。
   *
   * ⚠️ 出队后再返回：即使后续拼装失败，也不重复注入。
   *   （这正是「宁可丢一次也不重复」的落点）
   */
  _drainSelfNotes() {
    if (!Array.isArray(this.selfNotes) || this.selfNotes.length === 0) return '';
    const pending = this.selfNotes.slice();
    this.selfNotes.length = 0;   // 先清空再渲染，杜绝「渲染抛错导致重复注入」
    return this._selfNote(pending);
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
    const actualTurnCount = activeItems.filter(m => m.role === 'user' && !m.synthetic).length || snapshotTurnCount;
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
    let acc = 0, split = 0;
    for (let i = ws.length - 1; i >= 0; i--) {
      acc += estimateTokens(ws[i].text);
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
    this.data = { schemaVersion: SCHEMA_VERSION, windows: [], history: [], turnsInWindow: 0, totalTurns: 0, windowNo: 1, nextMessageSeq: 0, epoch, dreamFragments: [], deepHorizon: '', curiosityQueue: [], lexicon: [], expectations: [] };
    this.save(true);
  }
}

module.exports = { Memory, estimateTokens };
