/**
 * src/memory-observe-epoch.js — 观察期元数据队列与期满补注入（从 src/memory.js 拆出）
 *
 * 只记录 `{ at, capability }` 计数元数据，绝不写入正文；
 * 遵循 D1/D2/D3/D4 观察期不串味、一次只报一个能力的口径。
 */

const OBSERVED_NOTE_MAX_QUEUE = 20;

function noteObserved(mem, capability) {
  if (!Array.isArray(mem.data.observedNotes)) mem.data.observedNotes = [];
  mem.data.observedNotes.push({ at: Date.now(), capability: String(capability || '') });
  if (mem.data.observedNotes.length > OBSERVED_NOTE_MAX_QUEUE) {
    mem.data.observedNotes.shift();
  }
  mem.save(false);
}

function markObserveEpoch(mem, capability, direction) {
  if (!mem.data.observeEpoch || typeof mem.data.observeEpoch !== 'object'
      || Array.isArray(mem.data.observeEpoch)) {
    mem.data.observeEpoch = {};
  }
  const cap = String(capability || '');
  if (!cap) return;
  const prev = mem.data.observeEpoch[cap];
  const base = (prev && typeof prev === 'object') ? prev : {};
  const now = Date.now();
  if (direction === 'in') {
    mem.data.observeEpoch[cap] = {
      enteredAt: Number.isFinite(base.enteredAt) ? base.enteredAt : now,
      leftAt: null,
      pendingEcho: false,
    };
  } else if (direction === 'out') {
    if (!Number.isFinite(base.enteredAt)) return;
    if (Number.isFinite(base.leftAt) && base.leftAt > 0) return;
    if (!Array.isArray(mem.data.observedNotes)) mem.data.observedNotes = [];
    mem.data.observeEpoch[cap] = {
      enteredAt: base.enteredAt,
      leftAt: now,
      pendingEcho: mem.data.observedNotes.some((n) => n && n.capability === cap),
    };
  }
  mem.save(false);
}

function takeObserveEcho(mem) {
  const epochs = mem.data.observeEpoch;
  if (!epochs || typeof epochs !== 'object' || Array.isArray(epochs)) return '';

  const notes = Array.isArray(mem.data.observedNotes) ? mem.data.observedNotes : [];
  const pending = Object.keys(epochs).filter((c) => {
    if (!epochs[c] || epochs[c].pendingEcho !== true) return false;
    return notes.some((n) => n && n.capability === c);
  });

  if (pending.length === 0) {
    let changed = false;
    for (const c of Object.keys(epochs)) {
      const ep = epochs[c];
      if (!ep || ep.pendingEcho !== true) continue;
      if (notes.some((n) => n && n.capability === c)) continue;
      ep.pendingEcho = false;
      changed = true;
    }
    if (changed) mem.save(false);
    return '';
  }

  const cap = pending[0];
  const total = notes.filter((n) => n && n.capability === cap).length;

  epochs[cap].pendingEcho = false;
  epochs[cap].leftAt = epochs[cap].leftAt || Date.now();
  mem.data.observedNotes = notes.filter((n) => !n || n.capability !== cap);
  mem.save(false);

  const howMany = total === 1 ? '有过一个念头'
    : (total >= 10 ? '有过好几次念头' : '有过几次念头');
  if (cap === 'workspace.read' || cap === 'workspace.list') {
    return '【那段时间里的事】\n'
      + '那段时间你' + howMany + '，想翻看沙盒里的文件。当时还没有开放读取权限——'
      + '不是你失败了，是那时候我还不能让你看。现在可以了。';
  }
  return '【那段时间里的事】\n'
    + '那段时间你' + howMany + '，想写下来。当时还没有开放落成文件——'
    + '不是你失败了，是那时候我还不能让你存下来。现在可以了。';
}

module.exports = {
  OBSERVED_NOTE_MAX_QUEUE,
  noteObserved,
  markObserveEpoch,
  takeObserveEcho,
};
