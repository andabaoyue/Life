/**
 * 气泡流纯函数渲染决策层（v1.0 笔 3a）
 *
 * 职责：
 * 1. decideBubble(m, mode) —— 气泡分流（user / assistant / note / skip），零 DOM 依赖；
 * 2. 标记遮蔽三件套（MARK_RE / stripState / transientMarker）自 pet.js 逐字迁移 ——
 *    全库唯一出处，pet.js 只准引用这里的导出，禁止再养第二份正则（测试钉死防漂移）。
 *
 * 铁律：
 * - [state:xx] / [wear:xx] 绝不进正文，但上层照常驱动表情状态机与衣柜（遮蔽 ≠ 删除）；
 * - synthetic 条目遵从 mode（'note' 剥前缀注记 / 'hide' 跳过），绝不冒充用户发言；
 * - t 缺失 → at: undefined，零伪造时间戳。
 */

/* 尾部标记遮蔽：[state:xx] 与 [wear:id]。
   与后端 parseState/parseWear 同一条铁律——未知值不剥离，
   宁可屏幕上多一个怪标记，也不能把正文掏空。
   合法的 wear id 集合来自衣柜 catalog（启动时注入），
   保证渲染端藏起来的和后端剥掉的永远是同一批。 */
const MARK_RE = {
  state: /^\s*(?:state)\s*[:：]\s*([a-z]+)\s*$/iu,
  wear: /^\s*(?:wear)\s*[:：]\s*([a-z0-9_]+)\s*$/iu
};

// 遮蔽依赖的合法词表：由 pet.js 启动时注入最新引用（纯函数层不自持业务数据）
const MarkContext = { STATES: [], knownWear: new Set(), wearCandidates: [] };
function setMarkContext(ctx) {
  if (!ctx) return;
  if (Array.isArray(ctx.STATES)) MarkContext.STATES = ctx.STATES;
  if (ctx.knownWear) MarkContext.knownWear = ctx.knownWear;
  if (Array.isArray(ctx.wearCandidates)) MarkContext.wearCandidates = ctx.wearCandidates;
}

function stripState(t, partial = false) {
  /* 剥尾部标记要**整体迭代**，不是"先剥完整标记一轮、再藏半截一次"就完事：
     把末尾的半截藏起来之后，露出来的新尾巴可能又是一条完整的可剥标记。
     "[wear:gothic_black_01][s" 就是这一类：瞬态判据把 '[s' 藏掉，尾巴变成
     "[wear:gothic_black_01]"，本该继续剥 —— 单轮写法的结果是整条 wear
     标记重新出现在屏幕上，实测吐到 [state: 那段时泄漏 11 帧。
     每轮要么变短要么停住，所以不会死循环。 */
  for (;;) {
    const before = t;
    // 循环剥尾部：模型可能先提案（可多条）再收尾 state
    for (;;) {
      // 内容不允许跨 ']'，否则 "[wear:a][state:b]" 会被当成一整个标记，
      // 里面的 ']' 让两个子正则都匹配不上，结果一个都剥不掉。
      const m = t.match(/\[([^\]]*)\]([\s\p{P}~]*)$/iu);
      if (!m) break;
      const recognized =
        (MARK_RE.state.test(m[1]) && MarkContext.STATES.includes((m[1].match(MARK_RE.state)[1] || '').toLowerCase()))
        || (MARK_RE.wear.test(m[1]) && MarkContext.knownWear.has((m[1].match(MARK_RE.wear)[1] || '').toLowerCase()));
      if (!recognized) break;   // 未知值：原样留在正文，和后端行为一致
      const next = t.slice(0, m.index);
      // 后端 parseState/parseWear 有「掏空保护」（clean || text）：
      // 整条消息只剩标记时不剥空。这里不跟着停，前后端就会一个显示空、
      // 一个显示标记 —— 两边必须剥同一批。
      if (!next.trim()) break;
      t = next;
    }
    /* 流式瞬态：最后一个 [ 之后没有闭合的 ]。要不要藏起来，判据是
       "它还有没有可能长成一条后端会剥掉的标记"：
         state → 'state:' + 已知状态词的前缀
         wear  → 'wear:' + 衣柜里真实 itemId 的前缀（启动时注入 knownWear）
       刻意不是把字符集放宽成 [a-z0-9_]*：那样连 [wear:maid_dress_01 这种
       后端根本不认的幻觉 id 也会被整条藏起来（实测 14 帧，直到流结束再凭空
       长回来），按衣柜前缀只藏"确实还可能长成合法标记"的那几帧。
       决定性差别其实不在判据而在结构：单轮写法换掉字符集仍漏 11 帧（见函数头）。

       **只在还在吐字的时候藏**（partial 由调用方按流式状态传入）。这是上面那条
       "两边剥同一批"的推论，v0.7.1 第一版漏了：判据用的是"还可能长成合法
       标记"，可流一旦结束它就再也长不成了 —— 这时还藏，屏幕上没有、历史里
       有，正是我拿来否掉放宽字符集的那个理由。真实成因不稀有：max_tokens
       截断、用户点停止，都会让回复正好停在半截标记上。实测衣柜里的真 id
       silver_wavy_01 被截断成 "[wear:silver_wavy_" 时，收尾那一帧整条被吞掉。 */
    if (!partial) return t;
    const i = t.lastIndexOf('[');
    if (i >= 0 && t.indexOf(']', i) < 0 && transientMarker(t.slice(i + 1))) {
      t = t.slice(0, i);
    }
    if (t === before) return t;   // 这一整轮什么都没剥掉 → 收尾
  }
}

/* 半截标记判定。忽略空白是沿袭旧写法的宽容（词中间的空格后端本来也不认，
   所以这里多藏只可能藏一帧，闭合后仍按原样出现，前后端最终一致）。 */
function transientMarker(tail) {
  // 全角冒号归一 + 去空白：旧写法用 [:：] 和 \s* 容错，这里保持同样宽容
  const s = tail.toLowerCase().replace(/[：]/g, ':').replace(/\s+/g, '');
  if (!s) return true;                      // 光一个 '['：模型刚起头
  for (const w of ['state', 'wear']) {
    if (w.startsWith(s)) return true;       // 's' / 'wea' / 'stat'
    if (!s.startsWith(w + ':')) continue;
    const val = s.slice(w.length + 1);
    if (w === 'state') return val === '' || MarkContext.STATES.some(v => v.startsWith(val));
    return MarkContext.wearCandidates.some(c => c.startsWith(s));   // 含 'wear:' 本身
  }
  return false;
}

/**
 * 气泡分流决策（纯函数）：history 条目 → 渲染指令。
 * 输出白名单 { kind, text, at, bridge } —— kind ∈ user / assistant / note / skip。
 */
function decideBubble(m, mode) {
  const at = m && Number.isFinite(m.t) ? m.t : undefined;
  const bridge = Boolean(m && m.bridge);
  if (m && m.synthetic) {
    // 主动搭话的程序触发：绝不冒充用户发言（笔 2 契约）
    if (mode === 'hide') return { kind: 'skip', text: '', at, bridge };
    const text = String(m.content || '').replace(/^\s*\[自主感知触发\]\s*[:：]\s*/, '');
    return { kind: 'note', text: stripState(text, false), at, bridge };
  }
  const kind = m && m.role === 'assistant' ? 'assistant' : 'user';
  return { kind, text: stripState(String(m.content || ''), false), at, bridge };
}


/**
 * 视图映射（纯）：decideBubble 结果 → 渲染描述（类名 / 头像 / 时间是否渲染）。
 * ts 为 null 表示「严格省略时间 DOM」——t 缺失不伪造（零伪造铁律）。
 */
function bubbleView(m, mode) {
  const d = decideBubble(m, mode);
  return {
    kind: d.kind,
    text: d.text,
    bridge: d.bridge,
    cls: d.kind === 'user' ? 'b-user' : (d.kind === 'assistant' ? 'b-ai' : 'b-note'),
    avatar: d.kind === 'user' ? '你' : (d.kind === 'assistant' ? '初' : null),
    ts: d.at === undefined ? null : d.at
  };
}

/** 智能贴底：用户上翻超过容差就暂停跟随（否则新消息把人拽回底部），回到底部恢复 */
function shouldStickToBottom(scrollTop, scrollHeight, clientHeight, tolerance = 40) {
  return (scrollHeight - scrollTop - clientHeight) <= tolerance;
}

/** 窗口分界线：上一条是 bridge（上一窗口尾部）而当前条不是 → 该处插分界 */
function dividerNeeded(prev, cur) {
  return Boolean(prev && prev.bridge && cur && !cur.bridge);
}

// 双环境守卫：Node 测试可 require；浏览器侧全局照常生效（同 ui-i18n / ui-chat-store 先例）
if (typeof module === 'object' && module.exports) {
  module.exports = { MARK_RE, MarkContext, setMarkContext, stripState, transientMarker, decideBubble, bubbleView, shouldStickToBottom, dividerNeeded };
}
