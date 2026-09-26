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

/** 粗估 token：中文约 1 字 1 token，其余约 3.5 字符 1 token */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

function msgTokens(m) {
  return estimateTokens(typeof m.content === 'string' ? m.content : '') + 4;
}

class Memory {
  constructor(dir, opts = {}) {
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
    this.data = { schemaVersion: SCHEMA_VERSION, windows: [], history: [], turnsInWindow: 0,
                  totalTurns: 0, windowNo: 1, nextMessageSeq: 0, epoch: 0 };

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
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (!raw || !Array.isArray(raw.history)) return;
      const { data } = migrate(raw, SCHEMA_VERSION, {
        1: (d) => {
          // 老版本（v0.2）是一条滚动 summary，没有 windows。
          // 不迁走的话，升级一次就把之前的记忆读不到了。
          if (!d.windows && d.summary) {
            d.windows = [{ no: 1, turns: 0, at: Date.now(), text: d.summary }];
            d.windowNo = 2;
            delete d.summary;
          }
          if (!d.windows) d.windows = [];
          if (!d.history) d.history = [];
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
                    windowNo: 1, nextMessageSeq: seq, epoch: 0, ...data, nextMessageSeq: Math.max(seq, data.nextMessageSeq || 0) };
    } catch { /* 首次运行 */ }
  }

  save(immediate = false) {
    this.writer.markDirty();
    if (immediate) {
      this.writer.flush();
    }
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
      if (this.engramManager) {
        const dormantNos = new Set(this.engramManager.getDormantTraces().map(t => t.sourceWindowNo));
        activeWindows = this.data.windows.filter(w => !dormantNos.has(w.no));
      }
      if (activeWindows.length) {
        const mem = activeWindows
          .map(w => (w.early ? '【早期】' : '【第' + w.no + '段】') + w.text)
          .join('\n');
        s += '\n\n【你与此前的记忆】\n' + mem;
      }
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
    const msgs = [
      { role: 'system', content: this.systemText() },
      ...this.data.history.map(m => ({ role: m.role, content: m.content }))
    ];
    if (suffix && msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === 'user') {
        msgs[msgs.length - 1] = {
          role: last.role,
          content: last.content ? last.content + '\n\n' + suffix : suffix
        };
      }
    }
    return msgs;
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
    if (!summaryText || !snap || !snap.items.length) return false;
    if (snap.epoch !== this.data.epoch) return false;

    const closedWindowNo = this.data.windowNo;
    const turnsRecorded = (snap && typeof snap.snapshotTurnCount === 'number') ? snap.snapshotTurnCount : this.data.turnsInWindow;
    this.data.windows.push({
      no: closedWindowNo,
      turns: turnsRecorded,
      actualTurnCount: (snap && typeof snap.actualTurnCount === 'number') ? snap.actualTurnCount : turnsRecorded,
      closeReason: (snap && snap.closeReason) || 'turn_limit',
      at: Date.now(),
      text: String(summaryText).trim()
    });

    if (this.engramManager) {
      this.engramManager.registerTrace({
        sourceWindowNo: closedWindowNo,
        createdWindow: closedWindowNo,
        salienceBonus: 0.1,
        contentRef: String(summaryText).slice(0, 100)
      });
      this.lastDecayReport = this.engramManager.decayAll(closedWindowNo);
    }

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
      .replace(/(?:\r?\n)+【出生与程序年龄】[\s\S]*$/g, '')
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

  applyMerge(mergedText, keptWindows) {
    this.data.windows = [
      { no: 0, early: true, at: Date.now(), text: String(mergedText).trim() },
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
   * 真删除某条记忆片段 —— 从数据里去掉并落盘，不是回答里假装忘记。
   * system 会变，破一次缓存，这是诚实删除的必要代价。
   */
  deleteWindow(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.data.windows.length) return false;
    this.data.windows.splice(i, 1);
    this.save(true);
    return true;
  }

  reset() {
    // epoch++ 让在飞的小结快照作废，不会把新记忆又裁一次
    const epoch = (this.data.epoch || 0) + 1;
    this.data = { schemaVersion: SCHEMA_VERSION, windows: [], history: [], turnsInWindow: 0, totalTurns: 0, windowNo: 1, nextMessageSeq: 0, epoch };
    this.save(true);
  }
}

module.exports = { Memory, estimateTokens };
