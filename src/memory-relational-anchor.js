/**
 * src/memory-relational-anchor.js — 互惠关系锚定子存储（v2.2.2）
 *
 * 定位：
 * - 纯本地、零 API 成本、严格基于已过 messageId 引证核验的 lexicon 与已结算 expectations。
 * - 仅在关窗时刻（Memory.closeWindow / brain-window-pipeline）调用 refreshRelationalAnchors()，
 *   维护窗口内 systemText() 前缀缓存逐字节稳定。
 * - 严守 D-008 / D-005 / v2.0-b3：零好感度/亲密度标量、零正则猜测、物理零删档。
 */

const MAX_NICKNAME_ANCHORS = 2;
const MAX_RECIPROCITY_ANCHORS = 3;
const MAX_TOTAL_ANCHORS = 5;
const NICKNAME_MIN_WEIGHT = 1.4;
const ADOPTED_MIN_WEIGHT = 1.6;
const MAX_GLOSS_CHARS = 60;
const MAX_RECIPROCITY_TEXT_CHARS = 80;
const MAX_RECIPROCITY_NOTE_CHARS = 60;

function trimText(v, maxChars) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

/**
 * 归一化关系锚点数组（兼容旧 archive 缺失与脏数据过滤，上限 5 条：称呼 <= 2 + 互惠 <= 3）。
 * @param {unknown} raw
 * @returns {Array<object>}
 */
function normalizeRelationalAnchors(raw) {
  if (!Array.isArray(raw)) return [];
  const nicks = [];
  const recs = [];
  const seenIds = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seenIds.has(id)) continue;
    if (item.kind === 'nickname') {
      const label = trimText(item.label, 80);
      const sourceMessageId = typeof item.sourceMessageId === 'string' ? item.sourceMessageId.trim() : '';
      const firstWindowNo = Number(item.firstWindowNo);
      const lastConfirmedWindow = Number(item.lastConfirmedWindow);
      const anchorWeight = Number(item.anchorWeight);
      if (
        !label ||
        label.length < 2 ||
        !sourceMessageId ||
        !Number.isFinite(firstWindowNo) ||
        !Number.isFinite(lastConfirmedWindow) ||
        !Number.isFinite(anchorWeight)
      ) {
        continue;
      }
      if (nicks.length >= MAX_NICKNAME_ANCHORS) continue;
      seenIds.add(id);
      nicks.push({
        id,
        kind: 'nickname',
        label,
        gloss: trimText(item.gloss, MAX_GLOSS_CHARS),
        sourceMessageId,
        firstWindowNo: Math.floor(firstWindowNo),
        lastConfirmedWindow: Math.floor(lastConfirmedWindow),
        anchorWeight: Number(anchorWeight.toFixed(4))
      });
    } else if (item.kind === 'reciprocity') {
      const outcomeStatus = item.outcomeStatus;
      const source = item.source;
      const text = trimText(item.text, MAX_RECIPROCITY_TEXT_CHARS);
      const sourceMessageId = typeof item.sourceMessageId === 'string' ? item.sourceMessageId.trim() : '';
      const outcomeMessageId = typeof item.outcomeMessageId === 'string' ? item.outcomeMessageId.trim() : '';
      const resolvedWindowNo = Number(item.resolvedWindowNo);
      if (
        (outcomeStatus !== 'fulfilled' && outcomeStatus !== 'broken') ||
        (source !== 'user' && source !== 'chulan') ||
        !text ||
        !sourceMessageId ||
        !outcomeMessageId ||
        !Number.isFinite(resolvedWindowNo)
      ) {
        continue;
      }
      if (recs.length >= MAX_RECIPROCITY_ANCHORS) continue;
      seenIds.add(id);
      recs.push({
        id,
        kind: 'reciprocity',
        outcomeStatus,
        source,
        text,
        note: trimText(item.note, MAX_RECIPROCITY_NOTE_CHARS),
        sourceMessageId,
        outcomeMessageId,
        resolvedWindowNo: Math.floor(resolvedWindowNo)
      });
    }
  }
  return nicks.concat(recs).slice(0, MAX_TOTAL_ANCHORS);
}

/**
 * 在关窗时刻从已核验 lexicon 与已结算 expectations 纯本地提炼稳定关系锚点（不删原数据）。
 * @param {object} mem Memory 实例
 * @param {number} [closedWindowNo] 当前关闭的窗口号
 * @returns {Array<object>}
 */
function refreshRelationalAnchors(mem, closedWindowNo) {
  if (!mem || !mem.data || typeof mem.data !== 'object') return [];
  const curWin = Number.isFinite(closedWindowNo)
    ? Math.floor(closedWindowNo)
    : (Number.isFinite(mem.data.windowNo) ? Math.floor(mem.data.windowNo) : 1);

  // 1. 稳定称呼筛选（仅从 ACTIVE 且跨窗复现过的 nickname/adopted 词汇中升格，绝不做正则猜测）
  const lexicon = Array.isArray(mem.data.lexicon) ? mem.data.lexicon : [];
  const nickByWord = new Map();
  for (const entry of lexicon) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.status !== 'ACTIVE') continue;
    const label = typeof entry.word === 'string' ? entry.word.trim() : '';
    if (label.length < 2) continue;
    const messageId = typeof entry.messageId === 'string' ? entry.messageId.trim() : '';
    if (!messageId) continue;
    const firstWin = Number(entry.windowNo);
    const lastWin = Number(entry.lastUsedWindow);
    if (!Number.isFinite(firstWin) || !Number.isFinite(lastWin) || lastWin <= firstWin) continue;
    const w = Number(entry.weight);
    if (!Number.isFinite(w)) continue;
    const qualified = (entry.kind === 'nickname' && w >= NICKNAME_MIN_WEIGHT)
      || (entry.kind === 'adopted' && w >= ADOPTED_MIN_WEIGHT);
    if (!qualified) continue;

    const anchor = {
      id: 'anc-nick-' + label,
      kind: 'nickname',
      label,
      gloss: trimText(entry.gloss, MAX_GLOSS_CHARS),
      sourceMessageId: messageId,
      firstWindowNo: Math.floor(firstWin),
      lastConfirmedWindow: Math.floor(lastWin),
      anchorWeight: Number(w.toFixed(4))
    };
    const prev = nickByWord.get(label);
    if (!prev || anchor.anchorWeight > prev.anchorWeight ||
        (anchor.anchorWeight === prev.anchorWeight && anchor.lastConfirmedWindow > prev.lastConfirmedWindow)) {
      nickByWord.set(label, anchor);
    }
  }
  const nicknames = [...nickByWord.values()]
    .sort((a, b) => {
      if (b.anchorWeight !== a.anchorWeight) return b.anchorWeight - a.anchorWeight;
      if (b.lastConfirmedWindow !== a.lastConfirmedWindow) return b.lastConfirmedWindow - a.lastConfirmedWindow;
      return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
    })
    .slice(0, MAX_NICKNAME_ANCHORS);

  // 2. 互惠事实沉淀（合并既有已沉淀锚点与当前 expectations 中已结算条目，防 FIFO-10 滚出失忆）
  const recById = new Map();
  const existing = normalizeRelationalAnchors(mem.data.relationalAnchors);
  for (const anc of existing) {
    if (anc.kind === 'reciprocity') {
      recById.set(anc.id, anc);
    }
  }

  const expectations = Array.isArray(mem.data.expectations) ? mem.data.expectations : [];
  for (const exp of expectations) {
    if (!exp || typeof exp !== 'object') continue;
    if (exp.status !== 'fulfilled' && exp.status !== 'broken') continue;
    if (exp.source !== 'user' && exp.source !== 'chulan') continue;
    const expId = typeof exp.id === 'string' ? exp.id.trim() : '';
    const text = trimText(exp.text, MAX_RECIPROCITY_TEXT_CHARS);
    const sourceMessageId = typeof exp.messageId === 'string' ? exp.messageId.trim() : '';
    const outcomeMsgId = (exp.outcome && typeof exp.outcome.messageId === 'string')
      ? exp.outcome.messageId.trim() : '';
    if (!expId || !text || !sourceMessageId || !outcomeMsgId) continue;

    // 兼容历史存档：缺失 outcome.resolvedWindowNo 时依次回落 entry.windowNo -> closedWindowNo
    let resolvedWin = curWin;
    if (exp.outcome && Number.isFinite(exp.outcome.resolvedWindowNo)) {
      resolvedWin = Math.floor(exp.outcome.resolvedWindowNo);
    } else if (Number.isFinite(exp.windowNo)) {
      resolvedWin = Math.floor(exp.windowNo);
    }

    const id = 'anc-rec-' + expId;
    recById.set(id, {
      id,
      kind: 'reciprocity',
      outcomeStatus: exp.status,
      source: exp.source,
      text,
      note: trimText(exp.outcome && exp.outcome.note, MAX_RECIPROCITY_NOTE_CHARS),
      sourceMessageId,
      outcomeMessageId: outcomeMsgId,
      resolvedWindowNo: resolvedWin
    });
  }

  const reciprocities = [...recById.values()]
    .sort((a, b) => {
      if (b.resolvedWindowNo !== a.resolvedWindowNo) return b.resolvedWindowNo - a.resolvedWindowNo;
      return b.id < a.id ? -1 : (b.id > a.id ? 1 : 0);
    })
    .slice(0, MAX_RECIPROCITY_ANCHORS);

  mem.data.relationalAnchors = nicknames.concat(reciprocities).slice(0, MAX_TOTAL_ANCHORS);
  return mem.data.relationalAnchors;
}

/**
 * 纯函数格式化关系锚点块，绝不输出 anchorWeight / id / sourceMessageId / outcomeMessageId。
 * @param {Array<object>} anchors
 * @returns {string}
 */
function formatRelationalAnchorsBlock(anchors) {
  const list = normalizeRelationalAnchors(anchors);
  if (!list.length) return '';
  const lines = [];
  for (const a of list) {
    if (a.kind === 'nickname') {
      lines.push('- [稳定称呼] ' + a.label + (a.gloss ? '（' + a.gloss + '）' : ''));
    } else if (a.kind === 'reciprocity') {
      const tag = a.outcomeStatus === 'broken' ? '[偏差事实]' : '[兑现事实]';
      lines.push('- ' + tag + ' ' + a.text + (a.note ? ' → ' + a.note : ''));
    }
  }
  if (!lines.length) return '';
  return '【长期沉淀的关系锚点】（仅基于过往真实对话证据，自然延续即可，绝不刻意表演）\n' + lines.join('\n');
}

module.exports = {
  MAX_NICKNAME_ANCHORS,
  MAX_RECIPROCITY_ANCHORS,
  MAX_TOTAL_ANCHORS,
  NICKNAME_MIN_WEIGHT,
  ADOPTED_MIN_WEIGHT,
  normalizeRelationalAnchors,
  refreshRelationalAnchors,
  formatRelationalAnchorsBlock
};
