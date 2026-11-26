/**
 * src/memory-lexicon.js — 语言指纹词库与词汇动力学子存储（从 src/memory.js 拆出）
 *
 * 维护 data.lexicon 的引证入库（WORD_TOO_SHORT / adopted 角色与内容核验）
 * 与关窗静默共振/每 3 窗平滑淡化三态流转（ACTIVE/FADING/DORMANT）。
 */

function isLexiconWordMentioned(text, word) {
  if (!text || !word) return false;
  const w = String(word).trim();
  if (w.length < 2) return false;

  if (/^[\w-]+$/.test(w)) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^a-zA-Z0-9_-])' + escaped + '([^a-zA-Z0-9_-]|$)', 'i');
    return re.test(text);
  }
  return text.includes(w);
}

function addLexicon(mem, entry = {}, opts = {}) {
  const kind = String(entry.kind || '');
  if (!['coinage', 'metaphor', 'nickname', 'adopted'].includes(kind)) return { ok: false, error: 'INVALID_KIND' };
  const word = String(entry.word || '').trim();
  if (!word) return { ok: false, error: 'EMPTY_WORD' };
  if (word.length < 2) return { ok: false, error: 'WORD_TOO_SHORT' };
  const messageId = String(entry.messageId || '');
  const msg = mem._resolveMessage(messageId, opts);
  if (!msg) return { ok: false, error: 'UNRESOLVED_MESSAGE_ID' };

  const gloss = String(entry.gloss || '').trim();
  if (kind === 'adopted' && !gloss) return { ok: false, error: 'EMPTY_GLOSS' };

  if (kind === 'adopted' && (!msg.role || msg.role !== 'assistant')) {
    return { ok: false, error: 'INVALID_MESSAGE_ROLE' };
  }

  if (kind === 'adopted' && (!msg.content || typeof msg.content !== 'string' || !msg.content.includes(word))) {
    return { ok: false, error: 'WORD_NOT_IN_MESSAGE' };
  }

  const list = Array.isArray(mem.data.lexicon) ? mem.data.lexicon : (mem.data.lexicon = []);
  const hit = list.find((x) => x && x.word === word);
  if (hit) {
    hit.weight = Math.min(3, Number(((Number(hit.weight) || 1) + 0.2).toFixed(2)));
    hit.status = 'ACTIVE';
    hit.lastUsedWindow = Number.isFinite(entry.windowNo) ? entry.windowNo : (mem.data.windowNo || 1);
    hit.lastDecayedWindow = hit.lastUsedWindow;
    mem.save();
    return { ok: true, entry: hit, created: false };
  }

  const targetWin = Number.isFinite(entry.windowNo) ? entry.windowNo : (mem.data.windowNo || 1);
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
  mem.save();
  return { ok: true, entry: rec, created: true };
}

function refreshLexiconDynamics(mem, activeItems = [], windowNo) {
  if (!Array.isArray(mem.data.lexicon) || !mem.data.lexicon.length) return [];
  const curWin = Number.isFinite(windowNo) ? windowNo : (mem.data.windowNo || 1);
  const items = Array.isArray(activeItems) ? activeItems : [];
  const allText = items
    .map(m => (m && typeof m.content === 'string') ? m.content : '')
    .join('\n');

  for (const entry of mem.data.lexicon) {
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
  return mem.data.lexicon;
}

module.exports = {
  isLexiconWordMentioned,
  addLexicon,
  refreshLexiconDynamics,
};
