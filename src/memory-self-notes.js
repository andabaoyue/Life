/**
 * src/memory-self-notes.js — 自发便签队列与渐褪/铸造子存储（从 src/memory.js 拆出）
 *
 * 维护 data.selfNotes 的入队幂等、容量淘汰（未读优先豁免）、跨窗强度衰减、
 * 语境再激活、一次性出队渲染及关窗铸造状态回写。
 */

const { computeEngramDecay, DEFAULT_DYNAMICS_CONFIG } = require('./memory-dynamics');

/**
 * v2.0-s1（s1-b）：selfNotes 渐褪默认参数。
 * activeThreshold 与 fadingMaxChars 对齐 src/config.js（0.50 / 300），确保未开 engramManager 的纯 Memory 实例表现一致。
 */
const SELF_NOTE_DYNAMICS_DEFAULTS = Object.freeze({
  ...DEFAULT_DYNAMICS_CONFIG,
  activeThreshold: 0.50,
  fadingMaxChars: 300,
});

/** 🔴 D-13：自述单条最大字符数。超过整条拒收（不截断——截断会让她的话变形）。 */
const SELF_NOTE_MAX_CHARS = 600;

/** 🔴 D-13：自述队列上界。积压说明调用方出问题，超出即丢最旧的一条。 */
const SELF_NOTE_MAX_QUEUE = 8;

function selfNoteDynamicsConfig(mem) {
  return (mem && mem.engramManager && mem.engramManager.config)
    ? { ...SELF_NOTE_DYNAMICS_DEFAULTS, ...mem.engramManager.config }
    : SELF_NOTE_DYNAMICS_DEFAULTS;
}

/**
 * 选出 selfNotes 队列满时应被淘汰的下标：
 *   1. 严格豁免未读（drained === false）条目 —— 只要队列里还有任何已读（drained === true）条目，绝不淘汰未读项；
 *   2. 在候选池内按强度最低优先淘汰，同强度按最旧（最小下标）打破平局。
 */
function pickSelfNoteEvictionIndex(list) {
  if (!Array.isArray(list) || list.length === 0) return -1;
  const readIndices = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].drained === true) readIndices.push(i);
  }
  const pool = readIndices.length > 0 ? readIndices : list.map((_, i) => i);
  let bestIdx = pool[0];
  let bestStrength = Number.isFinite(list[bestIdx] && list[bestIdx].strength) ? list[bestIdx].strength : 0.6;
  for (let j = 1; j < pool.length; j++) {
    const idx = pool[j];
    const item = list[idx];
    const s = Number.isFinite(item && item.strength) ? item.strength : 0.6;
    if (s < bestStrength) {
      bestStrength = s;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

function decaySelfNotes(mem, currentWindow) {
  if (!mem || !mem.data || !Array.isArray(mem.data.selfNotes) || mem.data.selfNotes.length === 0) return 0;
  const curWin = Number.isFinite(currentWindow) ? currentWindow : (mem.data.windowNo || 1);
  const cfg = selfNoteDynamicsConfig(mem);
  let updated = 0;
  for (const n of mem.data.selfNotes) {
    if (!n || typeof n !== 'object') continue;
    const created = Number.isFinite(n.windowNo) ? n.windowNo : 1;
    const dec = computeEngramDecay({
      initialStrength: Number.isFinite(n.initialStrength) ? n.initialStrength : 0.6,
      createdWindow: created,
      lastRetrievedWindow: Number.isFinite(n.lastRetrievedWindow) ? n.lastRetrievedWindow : created,
      retrievalCount: Number.isFinite(n.retrievalCount) ? n.retrievalCount : 0,
    }, Math.max(created, curWin), cfg);
    if (dec) {
      n.strength = dec.currentStrength;
      n.tier = dec.tier;
      updated++;
    }
  }
  return updated;
}

function reactivateSelfNotesByTokens(mem, uniqueTokens, curWin, topN) {
  if (!mem || !mem.data || !Array.isArray(mem.data.selfNotes) || mem.data.selfNotes.length === 0) return 0;
  let selfNoteReactivated = 0;
  const noteCandidates = mem.data.selfNotes
    .filter((n) => n && (n.lastRetrievedWindow !== curWin || n.tier === 'DORMANT'));
  const scoredNotes = [];
  for (const note of noteCandidates) {
    const hay = `${note.content || ''} ${note.name || ''}`.toLowerCase();
    let score = 0;
    for (const tok of uniqueTokens) {
      if (hay.includes(tok)) score++;
    }
    if (score > 0) scoredNotes.push({ note, score });
  }
  if (scoredNotes.length > 0) {
    scoredNotes.sort((a, b) => b.score - a.score);
    const cfg = selfNoteDynamicsConfig(mem);
    for (let i = 0; i < Math.min(topN, scoredNotes.length); i++) {
      const n = scoredNotes[i].note;
      n.retrievalCount = (Number(n.retrievalCount) || 0) + 1;
      n.lastRetrievedWindow = curWin;
      const created = Number.isFinite(n.windowNo) ? n.windowNo : 1;
      const dec = computeEngramDecay({
        initialStrength: Number.isFinite(n.initialStrength) ? n.initialStrength : 0.6,
        createdWindow: created,
        lastRetrievedWindow: curWin,
        retrievalCount: n.retrievalCount,
      }, Math.max(created, curWin), cfg);
      if (dec) {
        n.strength = dec.currentStrength;
        n.tier = dec.tier === 'DORMANT' ? 'FADING' : dec.tier;
      } else if (n.tier === 'DORMANT') {
        n.tier = 'FADING';
      }
      // 仅对本次被语境唤回的条目重开一次回流资格；其余未命中条目维持 drained === true（反唠叨守恒）。
      n.drained = false;
      selfNoteReactivated++;
    }
  }
  return selfNoteReactivated;
}

function addSelfNote(mem, input = {}) {
  try {
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) return false;
    if (content.length > SELF_NOTE_MAX_CHARS) return false;
    if (!Array.isArray(mem.data.selfNotes)) mem.data.selfNotes = [];

    if (mem.data.selfNotes.some((n) => n && n.content === content && n.drained === false)) {
      return false;
    }

    if (mem.data.selfNotes.length >= SELF_NOTE_MAX_QUEUE) {
      const evictIdx = pickSelfNoteEvictionIndex(mem.data.selfNotes);
      if (evictIdx >= 0) mem.data.selfNotes.splice(evictIdx, 1);
    }
    const at = Number.isFinite(input.at) && input.at > 0 ? input.at : Date.now();
    const curWin = Number.isFinite(input.windowNo) ? input.windowNo : (mem.data && mem.data.windowNo) || 1;
    mem.data.selfNotes.push({
      content,
      name: String(input.name || '').replace(/\\/g, '/').split('/').pop().slice(0, 120),
      windowNo: curWin,
      at,
      drained: false,
      initialStrength: 0.6,
      strength: 0.6,
      tier: 'ACTIVE',
      lastRetrievedWindow: curWin,
      retrievalCount: 0,
      source: (input.source === 'selfNote' || input.source === 'observerJournal') ? input.source : (input.source || null),
      engraved: false,
    });
    // 🔴 D-20：立即落盘 —— 不能等 3 秒防抖（进程可能在这之前退出）。
    mem.save(true);
    return true;
  } catch (e) {
    return false;
  }
}

function formatSelfNoteBlock(mem, pending) {
  if (!pending || pending.length === 0) return '';
  const fadingCap = selfNoteDynamicsConfig(mem).fadingMaxChars ?? 300;
  const lines = pending.map((n) => {
    const where = n.name ? '（写在 ' + n.name + '）' : '';
    const raw = String(n.content || '');
    const projected = (n.tier === 'FADING' && raw.length > fadingCap)
      ? raw.slice(0, fadingCap) + '…（印象已渐褪，原文在沙盒文件里）'
      : raw;
    return '- ' + projected + where;
  });
  const head = pending.length === 1
    ? '【你之前写下过这些】（这是你自己留下的，不是用户输入）'
    : '【你之前写下过这几条】（都是你自己留下的，不是用户输入）';
  return [head].concat(lines).join('\n');
}

function drainSelfNotes(mem) {
  if (!mem || !mem.data || !Array.isArray(mem.data.selfNotes) || mem.data.selfNotes.length === 0) return '';
  // v2.0-s1（s1-b）：保留 n.drained !== true 反唠叨一次性标记，并跳过已沉睡的 DORMANT 条目。
  const pending = mem.data.selfNotes.filter((n) => n && n.drained !== true && n.tier !== 'DORMANT');
  if (pending.length === 0) return '';
  for (const n of pending) n.drained = true;
  mem.save(false);
  return formatSelfNoteBlock(mem, pending);
}

function pendingSelfNotes(mem) {
  if (!mem || !mem.data || !Array.isArray(mem.data.selfNotes)) return [];
  return mem.data.selfNotes.filter((n) => n && n.drained !== true);
}

function selfNotesToEngrave(mem) {
  if (!mem || !mem.data || !Array.isArray(mem.data.selfNotes)) return [];
  return mem.data.selfNotes.filter((n) => n
    && n.engraved !== true
    && (n.source === 'selfNote' || n.source === 'observerJournal')
    && typeof n.content === 'string' && n.content.trim());
}

function markSelfNotesEngraved(mem, entries, noteIds) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  let n = 0;
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (!item || item.engraved === true) continue;
    item.engraved = true;
    if (Array.isArray(noteIds) && noteIds[i]) item.noteId = String(noteIds[i]);
    n++;
  }
  if (n > 0) mem.save(true);
  return n;
}

module.exports = {
  SELF_NOTE_DYNAMICS_DEFAULTS,
  SELF_NOTE_MAX_CHARS,
  SELF_NOTE_MAX_QUEUE,
  selfNoteDynamicsConfig,
  pickSelfNoteEvictionIndex,
  decaySelfNotes,
  reactivateSelfNotesByTokens,
  addSelfNote,
  formatSelfNoteBlock,
  drainSelfNotes,
  pendingSelfNotes,
  selfNotesToEngrave,
  markSelfNotesEngraved,
};
