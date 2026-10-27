/**
 * src/observability.js — 个体观测面板的声明式注册表（v1.7-b）
 *
 * ## 这个模块解决什么问题
 *
 * 在它之前，`main.js` 的 `life-mechanisms` 是**手写字段**、`pet.js` 是**手写渲染**。
 * 每加一个新机制，都要同时改两处，而且**没人会记得** —— D-23 的 `retrievalCount`
 * 就是这么变成"算出来了但从来没被看见"的。
 *
 * 这里把「有哪些可观测项」变成**一张数据表**：
 *   - `main.js` 遍历它产出数据，不再手写字段；
 *   - `pet.js` 按 group 遍历它渲染，不再手写 DOM；
 *   - 新增机制只需**注册一行**，两端自动跟上，不可能漏。
 *
 * ## 三条铁律（违反即打回）
 *
 * 1. **只读**。任何 `read(ctx)` 都不得推进时钟、不得消费队列、不得落盘。
 *    打开观测面板本身**不能改变她的状态** —— 那是观察者效应污染实验。
 *    为此，`_read` 包装器对每项做了 try/catch，单点失败不影响整块。
 *
 * 2. **绝不造假**。数据缺失给 `null`，渲染层显示破折号。
 *    **不许补零、不许估算** —— 0 和「没有」是两件事。
 *
 * 3. **绝不外泄主体私有内容**。便签/日记只暴露条数与状态，
 *    **正文不进 payload**（有门禁断言）。正文走桌面沙盒或既有研究导出链路。
 *
 * ## 与旧字段的关系（平滑演进）
 *
 * `life-mechanisms` 同时返回 `groups`（新）与旧的顶层字段（lexicon/expectations/
 * vitals/development/cognition/relations）。**两者并行存在**，这样渲染层可以分两批改，
 * 中途任何时刻套件都是绿的。等新渲染层验证通过后，再在后续小版本删旧字段。
 */

/**
 * 分组顺序 = UI 上从上到下的展示顺序。
 * 加新 group 就在这里加一行；不在这里的 group 会排在最后（不丢数据，只是位置靠后）。
 */
const GROUP_ORDER = Object.freeze([
  'vitals',      // 生理与内态
  'cognition',   // 认知与成长
  'memory',      // 记忆印痕
  'curiosity',   // 好奇与愿望
  'notes',       // 她写下的字
  'agency',      // 主动性
  'provider',    // 供应商与容错
  'agent'        // 受控执行器
]);

/** 分组的中英文标签（渲染层按 labelKey 取，这里只给兜底文案） */
const GROUP_LABELS = Object.freeze({
  vitals: { zh: '生理与内态', en: 'Vitals' },
  cognition: { zh: '认知与成长', en: 'Cognition' },
  memory: { zh: '记忆印痕', en: 'Memory Engrams' },
  curiosity: { zh: '好奇与愿望', en: 'Curiosity' },
  notes: { zh: '她写下的字', en: 'Her Notes' },
  agency: { zh: '主动性', en: 'Agency' },
  provider: { zh: '供应商与容错', en: 'Provider' },
  agent: { zh: '受控执行器', en: 'Agent' }
});

/**
 * 把一个可能抛的读取函数包成"永不抛、失败给 null"。
 *
 * 为什么必须包：`life-mechanisms` 是**观测**通道，
 * 任何一项读失败都不该让整块面板白屏 —— 那会让人误判成"系统全坏了"。
 * 失败要**如实显示为空**（破折号），而不是伪造一个 0。
 *
 * @param {Function} fn 读取函数，接收 ctx
 * @returns {Function} 包装后的读取函数（永不抛）
 */
function safeRead(fn) {
  return (ctx) => {
    try {
      const v = fn(ctx);
      return v === undefined ? null : v;
    } catch (e) {
      return null;
    }
  };
}

/**
 * 取对象的数值字段，缺失/非数值一律给 null（绝不补 0）。
 * @param {object|null} obj
 * @param {string} key
 * @returns {number|null}
 */
function num(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj[key];
  return Number.isFinite(v) ? v : null;
}

/**
 * 从 brain 安全地取内稳态状态；取不到给 null。
 * @param {object} ctx
 */
function regulationState(ctx) {
  const reg = ctx && ctx.brain && ctx.brain.internalRegulation;
  if (!reg || typeof reg.getState !== 'function') return null;
  return reg.getState();
}

/**
 * 统计自述队列中某一来源的条数，**只数条数，永不返回正文**。
 *
 * @param {object} ctx
 * @param {string} source 'selfNote' | 'observerJournal'
 * @returns {{total:number, pending:number, engraved:number}|null}
 */
function noteStats(ctx, source) {
  const memData = ctx && ctx.brain && ctx.brain.memory && ctx.brain.memory.data;
  if (!memData || !Array.isArray(memData.selfNotes)) return null;
  const items = memData.selfNotes.filter((n) => n && n.source === source);
  return {
    total: items.length,
    // pending = 还没注入过的（drained !== true）
    pending: items.filter((n) => n.drained !== true).length,
    // engraved = 已经铸进经历档案的
    engraved: items.filter((n) => n.engraved === true).length
  };
}

/* ============================================================
 * 注册表本体
 *
 * 每项结构：
 *   id      唯一键，渲染层按它建 DOM（死项守卫按它做双向差集）
 *   group   分组（见 GROUP_ORDER）
 *   labelKey i18n 键；渲染层取不到时回退到 text
 *   text    兜底中文标签（i18n 缺键时用，避免面板显示空白）
 *   read    读取函数，收 ctx、返任意可 JSON 化的值或 null
 *   range   数值条形图的取值区间；null = 纯文本展示
 * ============================================================ */
const OBSERVABILITY_SPECS = Object.freeze([

  /* ---------- vitals：生理与内态 ---------- */

  {
    id: 'vitals.core',
    group: 'vitals',
    labelKey: 'obs.vitals.core',
    text: '精力 / 疲惫 / 觉醒',
    range: [0, 100],
    read: safeRead((ctx) => {
      const s = regulationState(ctx);
      if (!s) return null;
      // 只取 getState() 已有的字段；不新增计算，不代拟情绪
      return {
        energy: num(s, 'energy'),
        restPressure: num(s, 'restPressure'),
        arousal: num(s, 'arousal'),
        isSleeping: s.isSleeping === true
      };
    })
  },

  {
    // 🔴 本项是 v1.7-b 的核心缺口之一：getMood() 一直存在，但 getState() 不含它，
    //   handler 也从没取过 ⇒ 48h 慢变心境在面板上完全不可见。
    id: 'vitals.mood',
    group: 'vitals',
    labelKey: 'obs.vitals.mood',
    text: '心境底色（48h 半衰）',
    range: [-100, 100],
    read: safeRead((ctx) => {
      const reg = ctx && ctx.brain && ctx.brain.internalRegulation;
      if (!reg || typeof reg.getMood !== 'function') return null;
      // getMood() 头注释明确：纯函数、绝不推进内部时钟 —— 符合本模块"只读"铁律
      const m = reg.getMood();
      if (!m) return null;
      return { warmth: num(m, 'warmth'), stillness: num(m, 'stillness') };
    })
  },

  {
    id: 'vitals.social',
    group: 'vitals',
    labelKey: 'obs.vitals.social',
    text: '社交密度 / 认知负荷 / 显著性',
    range: [0, 100],
    read: safeRead((ctx) => {
      const s = regulationState(ctx);
      if (!s) return null;
      // v1.0.7 的社交密度体感带、显著性闸门都在 getState() 里，此前 handler 只取了 4 个字段
      return {
        interactionDensity: num(s, 'interactionDensity'),
        cognitiveLoadProxy: num(s, 'cognitiveLoadProxy'),
        salienceThreshold: num(s, 'salienceThreshold')
      };
    })
  },

  {
    id: 'vitals.watermark',
    group: 'vitals',
    labelKey: 'obs.vitals.watermark',
    text: '知觉事件水位线',
    range: null,
    read: safeRead((ctx) => {
      const s = regulationState(ctx);
      if (!s || !s.watermark) return null;
      // 具身知觉的消费进度：缓存里多少、已落盘多少
      return {
        runtimeCached: num(s.watermark, 'runtimeCachedCount'),
        persisted: num(s.watermark, 'persistedCount'),
        capacity: num(s.watermark, 'runtimeCacheCapacity')
      };
    })
  },

  /* ---------- cognition：认知与成长 ---------- */

  {
    id: 'cognition.self',
    group: 'cognition',
    labelKey: 'obs.cognition.self',
    text: '自我确信度 / 反思压力',
    range: [0, 1],
    read: safeRead((ctx) => {
      const ledger = ctx && ctx.brain && ctx.brain.selfLedger;
      if (!ledger || typeof ledger.getEntryMetrics !== 'function') return null;
      // 🔴 D-14：必须覆盖全部 8 维（含三个评价性自我关系维度），
      //   否则自我关系类条目会被系统性漏统计。此口径与 main.js 既有实现一致。
      const TRAITS = ['quiet_preference', 'social_initiative', 'attachment_need', 'vitality',
        'philosophical_curiosity', 'self_continuity', 'meaning_presence', 'self_clarity'];
      const ms = TRAITS.map((t) => { try { return ledger.getEntryMetrics(t); } catch (e) { return null; } })
        .filter(Boolean);
      if (!ms.length) return null;
      const avg = (k) => ms.reduce((a, x) => a + (Number(x[k]) || 0), 0) / ms.length;
      return { confidence: avg('confidence'), revisionPressure: avg('revisionPressure'), dims: ms.length };
    })
  },

  // ⛔️ 这里**故意不提供** `cognition.development`（原 v1.7-b 初版有，已删除）。
  //
  //   原因：`test/canalization.test.js` 的 P2-3c 守卫物理锁死了
  //   `getCanalizationMetrics` 不得被任何生产代码引用 —— 因为
  //   DEVELOPMENTAL_STAGES（幼态期/发育期/稳定个体化期）是**纯叙事标签、无机制消费方**：
  //   它说「她进入了稳定个体化期」，但背后没有任何机制变化，那正是「拟人化伪生命」的形状
  //   （叙事层比机制层厚）。
  //
  //   ⚠️ 这不是"被门禁挡住所以绕过"，而是门禁**说对了**：
  //   把发育阶段搬上观测面板，恰恰会把一个纯叙事标签升格成"可观测机制"，
  //   等于用 UI 给它镀上机制的可信度。**观测面板只该显示真实参与运算的标量。**
  //
  //   旧的 `development` 字段仍在 `life-mechanisms` 的顶层返回（main.js 既有实现），
  //   那是**历史遗留**、不属于本注册表，本文件不复制这个错误。

  /* ---------- memory：记忆印痕 ---------- */

  {
    // 🔴 本项是 v1.7-b 的核心缺口之二：engramManager 的 tier 分层与召回账本
    //   一直被内部调用，从来没有统计出口 ⇒ 三层记忆的"遗忘退行"完全不可见。
    id: 'memory.engrams',
    group: 'memory',
    labelKey: 'obs.memory.engrams',
    text: '记忆印痕分层',
    range: null,
    read: safeRead((ctx) => {
      const mem = ctx && ctx.brain && ctx.brain.memory;
      if (!mem || typeof mem.observationSnapshot !== 'function') return null;
      // observationSnapshot 是既有的只读出口（tiersForDisplay 纯函数实时算，零写盘）
      const snap = mem.observationSnapshot();
      if (!snap) return null;
      return {
        windowNo: num(snap, 'windowNo'),
        summary: snap.summary || null,   // { ACTIVE, FADING, DORMANT }
        total: Array.isArray(snap.traces) ? snap.traces.length : null,
        // 有多少条已跨过关窗边界但 decayAll 尚未执行（正常只在关窗前出现）
        drifted: Array.isArray(snap.traces)
          ? snap.traces.filter((t) => t && t.driftedFromPrompt === true).length : null
      };
    })
  },

  {
    id: 'memory.relation',
    group: 'memory',
    labelKey: 'obs.memory.relation',
    text: '关系与存在',
    range: null,
    read: safeRead((ctx) => {
      const memData = ctx && ctx.brain && ctx.brain.memory && ctx.brain.memory.data;
      if (!memData) return null;
      const lexicon = Array.isArray(memData.lexicon) ? memData.lexicon : [];
      const expectations = Array.isArray(memData.expectations) ? memData.expectations : [];
      const fulfilled = expectations.filter((x) => x && x.status === 'fulfilled').length;
      const broken = expectations.filter((x) => x && x.status === 'broken').length;
      const settled = fulfilled + broken;
      return {
        // 除零守卫：没有结算过就是 null（"无数据"），不是 0（"守信率 0%"）
        promiseFidelity: settled > 0 ? fulfilled / settled : null,
        fulfilled,
        broken,
        words: lexicon.length,
        reusedWords: lexicon.filter((x) => x && Array.isArray(x.uses) && x.uses.length > 0).length
      };
    })
  },

  {
    id: 'memory.archive',
    group: 'memory',
    labelKey: 'obs.memory.archive',
    text: '经历链长度',
    range: null,
    read: safeRead((ctx) => {
      const arc = ctx && ctx.brain && ctx.brain.experiencesArchive;
      if (!arc || typeof arc._readTailAnchor !== 'function') return null;
      // 护栏：只读尾部锚点的小 JSON，不重读 experiences.jsonl
      const tail = arc._readTailAnchor();
      const seq = tail && tail.anchor && tail.anchor.archiveSeq;
      return { archiveSeq: Number.isFinite(seq) ? seq : null };
    })
  },

  /* ---------- curiosity：好奇与愿望 ---------- */

  {
    id: 'curiosity.queue',
    group: 'curiosity',
    labelKey: 'obs.curiosity.queue',
    text: '好奇队列（未解疑问）',
    range: null,
    read: safeRead((ctx) => {
      const memData = ctx && ctx.brain && ctx.brain.memory && ctx.brain.memory.data;
      if (!memData) return null;
      // 只报条数，不报问题原文（原文属她的内态，面板职责是遥测不是展示内容）
      const q = Array.isArray(memData.curiosityQueue) ? memData.curiosityQueue : [];
      return { count: q.length, capacity: 5 };
    })
  },

  {
    id: 'curiosity.expectations',
    group: 'curiosity',
    labelKey: 'obs.curiosity.expectations',
    text: '预期账本',
    range: null,
    read: safeRead((ctx) => {
      const memData = ctx && ctx.brain && ctx.brain.memory && ctx.brain.memory.data;
      if (!memData) return null;
      const ex = Array.isArray(memData.expectations) ? memData.expectations : [];
      return {
        total: ex.length,
        open: ex.filter((x) => x && x.status === 'open').length,
        fulfilled: ex.filter((x) => x && x.status === 'fulfilled').length,
        broken: ex.filter((x) => x && x.status === 'broken').length
      };
    })
  },

  /* ---------- notes：她写下的字 ---------- */

  {
    // 🔴 铁律 3：只报条数与状态，**正文不进 payload**（有门禁断言）
    id: 'notes.self',
    group: 'notes',
    labelKey: 'obs.notes.self',
    text: '自发便签',
    range: null,
    read: safeRead((ctx) => noteStats(ctx, 'selfNote'))
  },

  {
    id: 'notes.journal',
    group: 'notes',
    labelKey: 'obs.notes.journal',
    text: '观察日记',
    range: null,
    read: safeRead((ctx) => noteStats(ctx, 'observerJournal'))
  },

  /* ---------- agency：主动性 ---------- */

  {
    // 🔴 本项是 v1.7-b 的核心缺口之三：initiativeBias 每次 updateTraits 都在重算，
    //   但全仓没有任何读取入口 ⇒ "特质如何影响搭话频率"完全不可见。
    id: 'agency.bias',
    group: 'agency',
    labelKey: 'obs.agency.bias',
    text: '主动开口意愿偏置',
    range: [0.5, 1.5],
    read: safeRead((ctx) => {
      const brain = ctx && ctx.brain;
      const values = brain && brain.subjectState && brain.subjectState.values;
      if (!values) return null;
      // 用导出的纯函数复算，不读 trigger 内部状态（那个没有出口，且不该为此新开接口）
      const { computeInitiativeBias } = require('./trigger');
      const bias = computeInitiativeBias(values);
      return {
        bias,
        // 有界区间是设计约束，一并暴露便于 UI 画条
        min: 0.5,
        max: 1.5
      };
    })
  },

  /* ---------- provider：供应商与容错 ---------- */

  {
    id: 'provider.breaker',
    group: 'provider',
    labelKey: 'obs.provider.breaker',
    text: '熔断器状态',
    range: null,
    read: safeRead((ctx) => {
      const b = ctx && ctx.brain && ctx.brain.providerBreaker;
      if (!b || typeof b.getState !== 'function') return null;
      const s = b.getState();
      if (!s) return null;
      // getState() 只暴露运行状态，不含任何 provenance 字段 —— 与既有设计一致
      return {
        state: s.state,
        consecutiveFailures: num(s, 'consecutiveFailures'),
        cooldownUntil: num(s, 'cooldownUntil'),
        probeInFlight: s.probeInFlight === true
      };
    })
  },

  /* ---------- agent：受控执行器 ---------- */

  {
    id: 'agent.budget',
    group: 'agent',
    labelKey: 'obs.agent.budget',
    text: '执行预算余额',
    range: null,
    read: safeRead((ctx) => {
      const b = ctx && ctx.agentBudget;
      if (!b || typeof b.state !== 'function') return null;
      const s = b.state();
      if (!s) return null;
      // 只取标量字段；limits 是对象、tripReason 是字符串，单独处理成可读值
      return {
        actions: num(s, 'actions'),
        writes: num(s, 'writes'),
        consecutiveErrors: num(s, 'consecutiveErrors'),
        remainingActions: num(s, 'remainingActions'),
        remainingWrites: num(s, 'remainingWrites'),
        tripped: s.tripped === true,
        // 熔断原因给原文（这是程序自己的状态，不是主体内态，可以直出）
        tripReason: typeof s.tripReason === 'string' ? s.tripReason : null
      };
    })
  },

  {
    id: 'agent.audit',
    group: 'agent',
    labelKey: 'obs.agent.audit',
    text: '执行审计条数',
    range: null,
    read: safeRead((ctx) => {
      const log = ctx && ctx.agentAuditLog;
      if (!log || typeof log.list !== 'function') return null;
      // 只报条数，不报事件内容（事件里可能有路径）
      const ev = log.list();
      return { count: Array.isArray(ev) ? ev.length : null };
    })
  }
]);

/**
 * 按注册表读取全部可观测项，组装成 `{ groups, order }`。
 *
 * **绝不抛**：任何单项失败都给 null，保证观测面板永远能渲染出结构。
 *
 * @param {object} ctx 上下文（brain / agentBudget / agentAuditLog 等）
 * @returns {{ok:boolean, groups:object, order:string[], generatedAt:number}}
 */
function collectObservability(ctx) {
  const groups = {};
  for (const spec of OBSERVABILITY_SPECS) {
    let value = null;
    try {
      value = spec.read(ctx);
    } catch (e) {
      value = null;   // 双保险：safeRead 已包一层，这里防注册表本身被改坏
    }
    if (!groups[spec.group]) groups[spec.group] = [];
    groups[spec.group].push({
      id: spec.id,
      labelKey: spec.labelKey,
      text: spec.text,
      range: spec.range || null,
      value
    });
  }

  // 排序：GROUP_ORDER 里声明过的按声明顺序，未声明的追加在后面（不丢数据）
  const known = GROUP_ORDER.filter((g) => groups[g]);
  const rest = Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g)).sort();
  const order = known.concat(rest);

  return { ok: true, groups, order, generatedAt: Date.now() };
}

module.exports = {
  OBSERVABILITY_SPECS,
  GROUP_ORDER,
  GROUP_LABELS,
  collectObservability,
  // 导出给门禁做单元测试用
  noteStats,
  num,
  safeRead
};
