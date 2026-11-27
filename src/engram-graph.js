/**
 * src/engram-graph.js
 *
 * v2.2-a: 使用驱动的共激活联想图谱（Co-Activation Engram Graph）
 *
 * 核心边界：
 * 1. 纯本地确定性代数，零 API 调用，零 setInterval（D-001 / D-006）。
 * 2. 物理零删档与存储隔离（D-005）：独立持久化为 engram-graph.json（经 atomic + DeferredWriter），
 *    弱边修剪仅移除拓扑索引边，绝不删除任何 trace 或 experiences.jsonl / windows 历史。
 * 3. 严格基线隔离（D-009）：enabled=false 时 100% 旁路，不读也不写 engram-graph.json。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { DeferredWriter } = require('./deferred-writer');

const SCHEMA_VERSION = 1;
const MAX_EDGE_WEIGHT = 5.0;
const COACTIVATION_INCREMENT = 1.0;
const DECAY_FACTOR = 0.92;
const PRUNE_THRESHOLD = 0.25;
const MAX_EDGES = 500;
const DEFAULT_MIN_ASSOC_WEIGHT = 1.2;

/**
 * 规范化无向边键：按字典序拼接 `${min}::${max}`；禁止自环或非法节点。
 *
 * @param {string} id1
 * @param {string} id2
 * @returns {string|null}
 */
function edgeKey(id1, id2) {
  if (typeof id1 !== 'string' || typeof id2 !== 'string') return null;
  const a = id1.trim();
  const b = id2.trim();
  if (!a || !b || a === b) return null;
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * 关窗边权衰减纯函数：w * (decayFactor ^ deltaW)，保持 4 位小数精度。
 *
 * @param {number} weight
 * @param {number} deltaW
 * @param {number} [decayFactor=DECAY_FACTOR]
 * @returns {number}
 */
function decayEdgeWeight(weight, deltaW, decayFactor = DECAY_FACTOR) {
  const w = Number.isFinite(weight) ? Math.max(0, Math.min(MAX_EDGE_WEIGHT, weight)) : 0;
  const d = Number.isFinite(deltaW) ? deltaW : 0;
  if (d <= 0) return Number(w.toFixed(4));
  return Number((w * Math.pow(decayFactor, d)).toFixed(4));
}

class EngramGraph {
  /**
   * @param {string} dir 数据目录
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=true] 是否激活图谱读写
   * @param {number} [opts.maxEdges=MAX_EDGES] 全局边数上限
   * @param {number} [opts.delayMs=3000] DeferredWriter 防抖延迟
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.opts = opts;
    this.path = path.join(dir, 'engram-graph.json');
    this.enabled = opts.enabled !== false;
    this.maxEdges = Number.isInteger(opts.maxEdges) && opts.maxEdges > 0 ? opts.maxEdges : MAX_EDGES;
    this.edges = new Map();
    this.writer = new DeferredWriter(() => this._writeDisk(), {
      delayMs: Number.isFinite(opts.delayMs) && opts.delayMs >= 0 ? opts.delayMs : 3000
    });

    if (this.enabled) {
      this.load();
    }
  }

  load() {
    if (!this.enabled) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return;
      }
      // 坏文件安全备份并回退空图，绝不抛错拖垮 memory.json
      try {
        const bakPath = this.path + '.bak';
        if (!fs.existsSync(bakPath) && fs.existsSync(this.path)) {
          fs.copyFileSync(this.path, bakPath);
        }
      } catch {}
      this.edges.clear();
      return;
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.edges || typeof raw.edges !== 'object' || Array.isArray(raw.edges)) {
      try {
        const bakPath = this.path + '.bak';
        if (!fs.existsSync(bakPath) && fs.existsSync(this.path)) {
          fs.copyFileSync(this.path, bakPath);
        }
      } catch {}
      this.edges.clear();
      return;
    }

    this.edges.clear();
    for (const item of Object.values(raw.edges)) {
      if (!item || typeof item !== 'object') continue;
      const key = edgeKey(item.a, item.b);
      if (!key) continue;
      const weight = Number(item.weight);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      const [a, b] = key.split('::');
      const lastCoactivatedWindow = Number.isFinite(item.lastCoactivatedWindow) ? item.lastCoactivatedWindow : 1;
      const lastDecayedWindow = Number.isFinite(item.lastDecayedWindow)
        ? Math.max(lastCoactivatedWindow, item.lastDecayedWindow)
        : lastCoactivatedWindow;
      const coactivations = Number.isFinite(item.coactivations) && item.coactivations >= 1
        ? Math.floor(item.coactivations)
        : 1;
      this.edges.set(key, {
        a,
        b,
        weight: Number(Math.min(MAX_EDGE_WEIGHT, weight).toFixed(4)),
        coactivations,
        lastCoactivatedWindow,
        lastDecayedWindow
      });
    }
    this._enforceCap();
  }

  _writeDisk() {
    if (!this.enabled) return;
    const edgesObj = {};
    for (const [k, v] of this.edges.entries()) {
      edgesObj[k] = {
        a: v.a,
        b: v.b,
        weight: v.weight,
        coactivations: v.coactivations,
        lastCoactivatedWindow: v.lastCoactivatedWindow,
        lastDecayedWindow: v.lastDecayedWindow
      };
    }
    writeJsonAtomic(this.path, {
      schemaVersion: SCHEMA_VERSION,
      edges: edgesObj
    });
  }

  save(immediate = false) {
    if (!this.enabled) return;
    this.writer.markDirty();
    if (immediate) {
      this.writer.flush();
    }
  }

  flush() {
    if (!this.enabled) {
      this.writer.cancel();
      return;
    }
    this.writer.flush();
  }

  setEnabled(nextEnabled) {
    const next = Boolean(nextEnabled);
    if (!next) {
      this.writer.cancel();
      this.enabled = false;
      return false;
    }
    const wasEnabled = this.enabled;
    this.enabled = true;
    if (!wasEnabled && this.edges.size === 0) {
      this.load();
    }
    return true;
  }

  clear() {
    this.edges.clear();
    if (!this.enabled) {
      this.writer.cancel();
      return;
    }
    this.save(true);
  }

  _enforceCap() {
    if (this.edges.size <= this.maxEdges) return 0;
    const sorted = Array.from(this.edges.entries()).sort((e1, e2) => {
      const [k1, v1] = e1;
      const [k2, v2] = e2;
      if (v1.weight !== v2.weight) return v1.weight - v2.weight;
      if (v1.lastCoactivatedWindow !== v2.lastCoactivatedWindow) {
        return v1.lastCoactivatedWindow - v2.lastCoactivatedWindow;
      }
      return k1.localeCompare(k2);
    });
    const toRemove = this.edges.size - this.maxEdges;
    for (let i = 0; i < toRemove; i++) {
      this.edges.delete(sorted[i][0]);
    }
    return toRemove;
  }

  /**
   * 记录两条记忆印痕在当前窗口的共激活（同窗同对去重）。
   *
   * @param {string} id1
   * @param {string} id2
   * @param {number} currentWindow
   * @returns {object|null}
   */
  recordCoactivation(id1, id2, currentWindow) {
    if (!this.enabled) return null;
    const key = edgeKey(id1, id2);
    if (!key) return null;
    const curWin = Number.isFinite(currentWindow) ? currentWindow : 1;
    const prev = this.edges.get(key);
    if (prev && prev.lastCoactivatedWindow === curWin) {
      return null;
    }

    const [a, b] = key.split('::');
    const nextWeight = Number(Math.min(MAX_EDGE_WEIGHT, (prev ? prev.weight : 0) + COACTIVATION_INCREMENT).toFixed(4));
    const nextEdge = {
      a,
      b,
      weight: nextWeight,
      coactivations: (prev ? prev.coactivations : 0) + 1,
      lastCoactivatedWindow: curWin,
      lastDecayedWindow: curWin
    };
    this.edges.set(key, nextEdge);
    this._enforceCap();
    this.save(false);
    return { ...nextEdge };
  }

  /**
   * 关窗边权衰减与弱边修剪（使用 lastDecayedWindow 保证同窗幂等与跨窗等价 0.92^N）。
   *
   * @param {number} currentWindow
   * @returns {{decayed: number, pruned: number, remaining: number}}
   */
  decayAllEdges(currentWindow) {
    if (!this.enabled) {
      return { decayed: 0, pruned: 0, remaining: this.edges.size };
    }
    const curWin = Number.isFinite(currentWindow) ? currentWindow : 1;
    let decayed = 0;
    let pruned = 0;

    for (const [key, edge] of Array.from(this.edges.entries())) {
      const anchorWin = Math.max(
        Number.isFinite(edge.lastCoactivatedWindow) ? edge.lastCoactivatedWindow : curWin,
        Number.isFinite(edge.lastDecayedWindow) ? edge.lastDecayedWindow : -Infinity
      );
      const stepW = curWin - anchorWin;
      if (stepW <= 0) continue;

      const nextW = decayEdgeWeight(edge.weight, stepW, DECAY_FACTOR);
      if (nextW < PRUNE_THRESHOLD) {
        this.edges.delete(key);
        pruned++;
      } else {
        edge.weight = nextW;
        edge.lastDecayedWindow = curWin;
        decayed++;
      }
    }

    if (decayed > 0 || pruned > 0) {
      this.save(false);
    }
    return { decayed, pruned, remaining: this.edges.size };
  }

  /**
   * 给定本窗种子印痕集合，对候选池按联想边权总和降序排列，过滤不达标候选。
   *
   * @param {string[]} seedIds
   * @param {Array<object|string>} pool
   * @param {object} [opts]
   * @param {number} [opts.minWeight=DEFAULT_MIN_ASSOC_WEIGHT]
   * @returns {Array}
   */
  rankAssociatedCandidates(seedIds, pool, opts = {}) {
    if (!this.enabled) return [];
    if (!Array.isArray(seedIds) || seedIds.length === 0) return [];
    if (!Array.isArray(pool) || pool.length === 0) return [];

    const minWeight = Number.isFinite(opts.minWeight) ? opts.minWeight : DEFAULT_MIN_ASSOC_WEIGHT;
    const seeds = Array.from(new Set(seedIds.filter((id) => typeof id === 'string' && id.trim())));
    if (seeds.length === 0) return [];

    const scored = [];
    for (const cand of pool) {
      const cid = typeof cand === 'string' ? cand : (cand && cand.traceId);
      if (typeof cid !== 'string' || !cid.trim()) continue;

      let totalScore = 0;
      for (const sid of seeds) {
        if (sid === cid) continue;
        const key = edgeKey(sid, cid);
        if (!key) continue;
        const edge = this.edges.get(key);
        if (edge && Number.isFinite(edge.weight) && edge.weight > 0) {
          totalScore += edge.weight;
        }
      }
      totalScore = Number(totalScore.toFixed(4));
      if (totalScore >= minWeight) {
        scored.push({ cand, cid, score: totalScore });
      }
    }

    scored.sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      const aRet = typeof x.cand === 'object' ? (x.cand.lastRetrievedWindow ?? x.cand.createdWindow ?? 0) : 0;
      const bRet = typeof y.cand === 'object' ? (y.cand.lastRetrievedWindow ?? y.cand.createdWindow ?? 0) : 0;
      if (aRet !== bRet) return aRet - bRet;
      const aStr = typeof x.cand === 'object' ? (Number(x.cand.currentStrength) || 0) : 0;
      const bStr = typeof y.cand === 'object' ? (Number(y.cand.currentStrength) || 0) : 0;
      if (aStr !== bStr) return aStr - bStr;
      return x.cid.localeCompare(y.cid);
    });

    return scored.map((entry) => entry.cand);
  }

  getEdge(id1, id2) {
    const key = edgeKey(id1, id2);
    if (!key) return null;
    const edge = this.edges.get(key);
    return edge ? { ...edge } : null;
  }

  /** 只读统计 */
  getStats() {
    let maxWeight = 0;
    for (const edge of this.edges.values()) {
      if (edge.weight > maxWeight) maxWeight = edge.weight;
    }
    return {
      edgeCount: this.edges.size,
      maxWeight: this.edges.size > 0 ? Number(maxWeight.toFixed(4)) : 0
    };
  }
}

module.exports = {
  SCHEMA_VERSION,
  MAX_EDGE_WEIGHT,
  COACTIVATION_INCREMENT,
  DECAY_FACTOR,
  PRUNE_THRESHOLD,
  MAX_EDGES,
  DEFAULT_MIN_ASSOC_WEIGHT,
  edgeKey,
  decayEdgeWeight,
  EngramGraph
};
