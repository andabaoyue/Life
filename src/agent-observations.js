/**
 * 观察档（observe）观察记录写入。
 *
 * ## 为什么单独一个文件
 *   `agent-audit.jsonl` 是**安全审计**（谁在何时请求了什么权限、被何理由拒绝），
 *   观察记录是**行为数据**。两者混写会有两个后果：
 *     ① 任一方改格式都会波及另一方；
 *     ② 审计的 500 字硬截断（`agent-interfaces.js:589`）存不下完整正文，
 *        而观察档的全部价值就是**完整正文**——只给摘要，人没法判断她写得对不对。
 *
 * ## 轮转：行数 + 时间双维度
 *   单一维度都不够（2026-11-01 按真实数据修正）：
 *     · 只按行数：低频能力（便签 0.12 条/天）200 条要 1666 天，等于永远不轮转；
 *     · 只按时间：高频新能力（如主动整理）可能几天就把文件撑爆。
 *   ⇒ 先到先轮转：`MAX_OBSERVATION_LINES` 条 **或** `MAX_OBSERVATION_AGE_MS` 天。
 *
 * ## 隐私
 *   正文是她自己写的字，不是凭据、不是用户隐私。但仍**只落这一个文件**，
 *   不进审计、不进日志、不进任何上报路径。
 */

const fs = require('fs');
const path = require('path');
// 🔵 2026-11-05 C-3：轮转时整文件重写，必须原子（审计 P3 #11）。
const { writeFileAtomic } = require('./atomic');

/** 最多保留多少条（按「观察窗口需要几个样本」定，不是按能存多久定）。 */
const MAX_OBSERVATION_LINES = 100;

/** 最久保留多少天（时间维度兜底，防低频能力永远填不满）。 */
const MAX_OBSERVATION_AGE_DAYS = 90;
const MAX_OBSERVATION_AGE_MS = MAX_OBSERVATION_AGE_DAYS * 24 * 60 * 60 * 1000;

/** 正文上限：与 memory 的 SELF_NOTE_MAX_CHARS 同量级，超长说明不是便签。 */
const MAX_CONTENT_CHARS = 4000;

class ObservationLog {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] 目录（通常是 app.getPath('userData')）
   * @param {string} [opts.file] 直接指定文件（单测用）
   * @param {boolean} [opts.persist] false 时只留内存（单测用）
   */
  constructor(opts = {}) {
    this.dir = opts.dir || null;
    this.file = opts.file || (this.dir ? path.join(this.dir, 'agent-observations.jsonl') : null);
    this.persist = Boolean(this.file) && opts.persist !== false;
    this.maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : MAX_OBSERVATION_LINES;
    this.maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : MAX_OBSERVATION_AGE_MS;
    this.events = [];
  }

  /**
   * 追加一条观察记录。
   *
   * ⚠️ 落盘失败**不抛**：观察档是旁路，它失败绝不能影响她本来要做的事。
   *   返回 `{ ok, persisted }` 供调用方记录，但调用方通常也不该因此中断。
   *
   * @param {object} entry
   * @param {string} entry.capability  能力名（selfNote / observerJournal / ...）
   * @param {string} entry.content     完整正文（**不截断**，超过上限则整条拒收）
   * @returns {{ok:boolean, persisted:boolean|null, reason?:string}}
   */
  append(entry = {}) {
    const content = typeof entry.content === 'string' ? entry.content : '';
    // 没有正文就没有观察价值 —— 观察档只记「她真的写出来了什么」
    if (!content.trim()) return { ok: false, persisted: null, reason: 'EMPTY_CONTENT' };
    if (content.length > MAX_CONTENT_CHARS) {
      // 超长整条拒收，不截断：截断会让她的话变形，而观察档要的就是原话
      return { ok: false, persisted: null, reason: 'TOO_LONG' };
    }

    const record = Object.freeze({
      at: Date.now(),
      capability: String(entry.capability || ''),
      intentKind: entry.intentKind == null ? null : String(entry.intentKind),
      proposalSource: entry.proposalSource == null ? null : String(entry.proposalSource),
      scopeName: String(entry.scopeName || '').slice(0, 200),
      content,
      contentBytes: Buffer.byteLength(content, 'utf8'),
      wouldHaveExecuted: true,
      reason: 'observed',
    });

    this.events.push(record);
    let persisted = null;
    if (this.persist) persisted = this._appendAndRotate(record);
    return { ok: true, persisted };
  }

  _appendAndRotate(record) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
      this._rotateIfNeeded();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 轮转：先按时间淘汰过期条目，再按行数截到上限。
   *
   * ⚠️ 只在**确实需要**时才重写文件（否则每次 append 都重写，等于 O(n²)）。
   */
  _rotateIfNeeded() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (!lines.length) return;

      const cutoff = Date.now() - this.maxAgeMs;
      let kept = [];
      for (const line of lines) {
        let rec = null;
        try { rec = JSON.parse(line); } catch { rec = null; }
        // 坏行直接丢（观察档是旁路数据，不值得为一行坏 JSON 保留整份文件）
        if (!rec || typeof rec !== 'object') continue;
        const at = Number(rec.at);
        if (Number.isFinite(at) && at > 0 && at < cutoff) continue;   // 过期
        kept.push(line);
      }

      // 行数上限：保留最近的 N 条
      if (kept.length > this.maxLines) kept = kept.slice(-this.maxLines);

      // 没变化就不写（防无谓 mtime 扰动，与本仓 tmp-hygiene 同款纪律）
      if (kept.length === lines.length && kept.every((l, i) => l === lines[i])) return;

      const body = kept.length ? kept.join('\n') + '\n' : '';
      /* 🔵 2026-11-05 C-3：改原子写（审计 P3 #11）。
       *
       *   原来这里是 `fs.writeFileSync(this.file, body, 'utf8')` ——
       *   整文件重写，中途断电会得到**半截 JSONL**。
       *   `readAll()` 有坏行容错（`try{JSON.parse}catch{return null}`），
       *   所以那是「降级可恢复」不是数据破坏，属 P3。但顺手改掉。
       *
       * ⚠️ `writeFileAtomic(file, data, opts = {})` —— 第三个参数是 **opts 对象**，
       *    不是编码。传 `'utf8'` 会被当成 opts（`opts.mode` 取到 undefined，
       *    行为恰好不变，但语义错了）。这里传 `{}`。
       */
      writeFileAtomic(this.file, body, {});
    } catch {
      // 轮转失败不影响已追加的那一条
    }
  }

  /** 读全部（观察记录是只读的旁路数据，不做状态机）。 */
  readAll() {
    if (!this.persist) return this.events.slice();
    try {
      if (!fs.existsSync(this.file)) return [];
      return fs.readFileSync(this.file, 'utf8')
        .split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((r) => r && typeof r === 'object');
    } catch {
      return [];
    }
  }

  /** 最近 N 条（面板/诊断用）。 */
  recent(n = 20) {
    const all = this.readAll();
    return all.slice(-Math.max(0, n));
  }
}

module.exports = {
  ObservationLog,
  MAX_OBSERVATION_LINES,
  MAX_OBSERVATION_AGE_DAYS,
  MAX_OBSERVATION_AGE_MS,
  MAX_CONTENT_CHARS,
};
