/**
 * src/agent-transaction.js
 *
 * v1.0 D-2：workspace.write 单文件写事务 + 持久化恢复日志（WAL）。
 *
 *## 为什么需要这一层
 * `src/atomic.js` 已经保证了「写不坏一半」（临时文件 → fsync → 同目录 rename），
 * 但它的注释写得很清楚（第 13 行）：**只解决「撕裂」，不解决「误删」**。
 * 一旦写错了内容、或写坏了想把原内容还回来，atomic.js 无能为力。
 * D-2 补的就是这个：**写前快照 + 失败字节级还原**。
 *
 *## 为什么必须有持久化恢复日志（而不是只做内存 catch）
 * 🔴 桌宠与传统守护进程最大的不同：**跑着跑着被用户关窗是日常，不是异常**。
 * 只在 catch 里还原，遇到 OOM / 断电 / 用户强制关进程 / 系统更新时，
 * 备份就悬在磁盘上没人还原 —— 而这恰恰是最常见的真实失败场景，
 * 恰恰是回滚机制存在的意义。故事务开工前先把「pending」落盘，
 * 成功提交后才清理；进程重启时扫一遍孤儿事务自动还原。
 *
 * ## 三条不变式（全部门禁测试围绕它们设计）
 *   1. **新建与覆盖的回滚动作不同**：目标原本不存在（isNew）时，
 *      回滚是**删除目标文件**，而不是恢复一个空文件。
 *   2. **哈希闭环校验**：回滚完成后必须重新比对目标文件哈希与写前哈希，
 *      字节级一致才算回滚成功 —— 否则宁可报failed 也不能假装成功。
 *   3. **孤儿事务自愈**：磁盘上残留的 pending 事务必须在下次启动时被识别并还原。
 *
 * 作用域刻意限定为**单文件**：ActionProposal 的 scope 本身就是单文件路径，
 * 多文件批次需要真正的两阶段提交，当前无复合写用例，属过早复杂化。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic');

/** 事务日志文件名（放在数据目录，不与用户文件混在一起）。 */
const WAL_FILE = 'agent-write-txn.jsonl';
/** 备份目录名（在数据目录下，与目标文件所在目录分离）。 */
const BACKUP_DIR = 'agent-txn-backups';

function sha256OfFile(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 事务管理器。
 * @param {object} opts { dir }  数据目录（用户 userData），WAL 与备份都放这里。
 */
class WriteTransactionManager {
  constructor(opts = {}) {
    this.dir = opts.dir || null;
    this.walPath = this.dir ? path.join(this.dir, WAL_FILE) : null;
    this.backupDir = this.dir ? path.join(this.dir, BACKUP_DIR) : null;
    this.persist = Boolean(this.dir) && opts.persist !== false;
    /** 单笔事务最大字节数，默认 5MB —— 防止 agent 往磁盘里灌超大文件。 */
    this.maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(1, opts.maxBytes) : 5 * 1024 * 1024;
  }

  /** 记录一条 WAL（append-only）。写不进去就抛——审计/日志写不进去等于没日志。 */
  _appendWal(record) {
    if (!this.persist) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.walPath, JSON.stringify(record) + '\n', 'utf8');
      return true;
    } catch (err) {
      throw Object.assign(new Error('WAL_APPEND_FAILED: ' + (err && err.message)), { code: 'WAL_APPEND_FAILED' });
    }
  }

  _readWal() {
    if (!this.persist || !fs.existsSync(this.walPath)) return [];
    let raw;
    try {
      raw = fs.readFileSync(this.walPath, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || !line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 半截行 = 崩溃残留，跳过 */ }
    }
    return out;
  }

  _backupPathFor(txId, target) {
    // 备份名带txId 与原文件名，避免不同事务互相覆盖
    return path.join(this.backupDir, txId + '-' + path.basename(target));
  }

  /**
   * 开始一个写事务。
   *
   * 流程（顺序刻意如此，fail-safe）：
   *   1. 校验目标与数据；
   *   2. 快照原文件（存在则备份 + 记哈希；不存在则记 isNew）；
   *   3. **先落 pending WAL**，再动目标文件 —— 反过来会让崩溃时无据可查；
   *   4. 原子写目标文件。
   *
   * @param {object} input { target, data, mode }
   * @returns {object} tx 事务句柄，调用方须commit() 或 rollback()
   */
  begin(input = {}) {
    const target = String(input.target || '');
    if (!target || typeof input.data !== 'string') {
      throw Object.assign(new Error('INVALID_TXN_INPUT'), { code: 'INVALID_TXN_INPUT' });
    }
    if (input.data.length > this.maxBytes) {
      throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE' });
    }

    const txId = 'txn-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const existedBefore = fs.existsSync(target);
    let backupPath = null;
    let originalHash = null;
    let originalBytesInMemory = null;

    if (existedBefore) {
      // 不变式 2 的前提：覆盖写必须留原字节，否则"还原"无从谈起。
      const originalBytes = fs.readFileSync(target);
      originalHash = crypto.createHash('sha256').update(originalBytes).digest('hex');
      if (this.persist) {
        // 🔴 备份只落盘时才需要路径；无 dir（内存模式）不能调 path.join(null,...) ——
        //   那会直接抛 ERR_INVALID_ARG_TYPE，让退化模式整体不可用。
        fs.mkdirSync(this.backupDir, { recursive: true });
        backupPath = this._backupPathFor(txId, target);
        fs.writeFileSync(backupPath, originalBytes);
      } else {
        // 内存模式：原字节留在内存里，回滚时直接用（无跨进程恢复能力，这是有意的取舍）。
        originalBytesInMemory = originalBytes;
      }
    }

    const tx = {
      txId,
      target,
      backupPath,
      originalHash,
      originalBytes: originalBytesInMemory,
      // 🔴 不变式 1：新建文件回滚动作是"删除"，不是"恢复空文件"。
      isNew: !existedBefore,
      status: 'pending',
      mode: input.mode,
      committed: false,
      rolledBack: false,
      persist: this.persist,
    };

    // 先落 pending 再动目标文件 —— 顺序反了，崩溃窗口就无据可查。
    this._appendWal({
      txId, target, backupPath, originalHash,
      isNew: !existedBefore, status: 'pending', at: Date.now(),
    });

    try {
      writeFileAtomic(target, input.data, input.mode !== undefined ? { mode: input.mode } : {});
    } catch (err) {
      // 写入失败：立刻原地还原，然后把异常抛给调用方。
      this.rollback(tx);
      throw err;
    }
    return tx;
  }

  /**
   * 提交事务：清理备份 + WAL 记committed。
   * 提交后不可回滚（数据已落盘且用户可能已看到）—— 故设committed 标志。
   */
  commit(tx) {
    if (!tx || !tx.txId) throw Object.assign(new Error('INVALID_TXN_HANDLE'), { code: 'INVALID_TXN_HANDLE' });
    if (tx.rolledBack) {
      throw Object.assign(new Error('TXN_ALREADY_ROLLED_BACK'), { code: 'TXN_ALREADY_ROLLED_BACK' });
    }
    tx.status = 'committed';
    tx.committed = true;
    let walErr = null;
    try {
      this._appendWal({
        txId: tx.txId, target: tx.target, status: 'committed', at: Date.now(),
      });
    } catch (err) {
      walErr = err;
    }
    if (tx.backupPath && tx.persist) {
      try { fs.unlinkSync(tx.backupPath); } catch { /* 备份清理失败不掩盖提交成功 */ }
    }
    if (walErr) {
      // M2: commit WAL 写失败时仍删除备份文件，防下次启动 recover 误将已写入的新数据回滚掉；
      // 重启恢复时会报 BACKUP_MISSING，属 fail-safe 预期残留，不代表数据损坏。
      throw walErr;
    }
    return true;
  }

  /**
   * 回滚事务：字节级还原。
   *
   * 两条硬规则：
   *   - 新建文件（isNew）→ 删除目标文件，不留残余空壳；
   *   - 覆盖文件 → 从备份还原，**并重算哈希与写前哈希比对**，
   *     字节级一致才算成功（不变式 2）；不一致则抛，**绝不假装成功**。
   */
  rollback(tx) {
    if (!tx || !tx.txId) throw Object.assign(new Error('INVALID_TXN_HANDLE'), { code: 'INVALID_TXN_HANDLE' });
    if (tx.committed) {
      throw Object.assign(new Error('TXN_ALREADY_COMMITTED'), { code: 'TXN_ALREADY_COMMITTED' });
    }
    if (tx.rolledBack) return true;

    if (tx.isNew) {
      // 不变式 1：新建的回滚是删除。
      if (fs.existsSync(tx.target)) fs.unlinkSync(tx.target);
    } else {
      //还原源二选一：落盘备份（正常模式）或内存原字节（无 dir 退化模式）。
      let originalBytes = null;
      if (tx.backupPath && fs.existsSync(tx.backupPath)) {
        originalBytes = fs.readFileSync(tx.backupPath);
      } else if (tx.originalBytes) {
        originalBytes = tx.originalBytes;
      } else {
        throw Object.assign(new Error('BACKUP_MISSING'), { code: 'BACKUP_MISSING' });
      }
      writeFileAtomic(tx.target, originalBytes);
      // 不变式 2：哈希闭环校验，字节级一致才算还原成功。
      const after = sha256OfFile(tx.target);
      if (after !== tx.originalHash) {
        throw Object.assign(new Error('ROLLBACK_HASH_MISMATCH'), { code: 'ROLLBACK_HASH_MISMATCH' });
      }
    }

    tx.status = 'rolled_back';
    tx.rolledBack = true;
    this._appendWal({
      txId: tx.txId, target: tx.target, status: 'rolled_back', at: Date.now(),
    });
    if (tx.backupPath && tx.persist) {
      try { fs.unlinkSync(tx.backupPath); } catch { /* 同上 */ }
    }
    return true;
  }

  /**
   * 启动自愈：扫描 WAL 中**没有对应 committed / rolled_back 记录**的pending 事务
   * （= 上次进程被强杀的孤儿），逐个还原。
   *
   * 这是 WAL 存在的全部意义：没有它，桌宠被用户关窗后备份就永远悬在磁盘上。
   *
   * @returns {{recovered:number, failed:Array, details:Array}}
   */
  recoverPendingTransactions() {
    const records = this._readWal();
    if (!records.length) return { recovered: 0, failed: [], details: [] };

    // 折叠成 txId → 终态集合（committed / rolled_back）与 pending 记录
    const byTx = new Map();
    for (const r of records) {
      if (!r || !r.txId) continue;
      const entry = byTx.get(r.txId) || { pending: null, terminal: null };
      if (r.status === 'pending') entry.pending = r;
      else if (r.status === 'committed' || r.status === 'rolled_back') entry.terminal = r;
      byTx.set(r.txId, entry);
    }

    const details = [];
    const failed = [];
    for (const [txId, entry] of byTx) {
      // 已有终态记录 → 正常路径处理过了，不碰。
      if (entry.terminal) continue;
      const p = entry.pending;
      if (!p) continue;
      try {
        if (p.isNew) {
          // 新建文件被强杀：目标可能是半截内容，也可能是干净的。
          // 既然原意图是"新建"，回滚就是让目标不存在。
          if (fs.existsSync(p.target)) fs.unlinkSync(p.target);
        } else {
          if (!p.backupPath || !fs.existsSync(p.backupPath)) {
            throw Object.assign(new Error('BACKUP_MISSING'), { code: 'BACKUP_MISSING' });
          }
          writeFileAtomic(p.target, fs.readFileSync(p.backupPath));
          const after = sha256OfFile(p.target);
          if (p.originalHash && after !== p.originalHash) {
            throw Object.assign(new Error('ROLLBACK_HASH_MISMATCH'), { code: 'ROLLBACK_HASH_MISMATCH' });
          }
        }
        if (p.backupPath) { try { fs.unlinkSync(p.backupPath); } catch { /* 忽略 */ } }
        this._appendWal({ txId, target: p.target, status: 'rolled_back', at: Date.now(), via: 'recover' });
        details.push({ txId, target: p.target, isNew: p.isNew, ok: true });
      } catch (err) {
        failed.push({ txId, target: p.target, error: String((err && err.message) || err) });
      }
    }
    return { recovered: details.length, failed, details };
  }

  /** 当前是否还有未决（pending）事务 —— 供 UI 显示"上次有未完成的写入"。 */
  listPending() {
    const records = this._readWal();
    const byTx = new Map();
    for (const r of records) {
      if (!r || !r.txId) continue;
      const e = byTx.get(r.txId) || { pending: null, terminal: null };
      if (r.status === 'pending') e.pending = r;
      else if (r.status === 'committed' || r.status === 'rolled_back') e.terminal = r;
      byTx.set(r.txId, e);
    }
    const out = [];
    for (const [txId, e] of byTx) {
      if (e.pending && !e.terminal) out.push(e.pending);
    }
    return out;
  }

  /** 清空 WAL（仅供测试/维护用；生产不应调用）。 */
  _resetWal() {
    if (this.persist && fs.existsSync(this.walPath)) {
      try { fs.unlinkSync(this.walPath); } catch { /* 忽略 */ }
    }
  }
}

module.exports = { WriteTransactionManager, WAL_FILE, BACKUP_DIR };