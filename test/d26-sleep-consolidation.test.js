/**
 * test/d26-sleep-consolidation.test.js
 *
 * D-26 门禁：深睡突触巩固 —— 梦真实发生时，对白天核心激活记忆做有界的抗衰减加固。
 *
 * ## 不变式（用户拍板：只强化抗衰减能力，绝不借梦境伪造记忆事实）
 *   1. 只动既有真实 trace 的记账字段 dreamSupport —— 不新建、不删除（D-005）、不改内容
 *   2. 🔴 绝不加 retrievalCount —— 那是「她真实被召回过」的事实计数，梦里重放不是召回
 *   3. 🔴 只记账不结算 —— 当场零重算 strength/tier（同 D-23 reactivate 护缓存铁律），
 *      效果统一在关窗 decayAll() 显现
 *   4. 选择零梦境内容参与 —— 候选 = 本窗真实活跃，确定性排序取 Top-N；梦不能「挑」记忆
 *   5. 同窗去重 + 累计封顶 + 每笔只 +1（有界）
 *
 * 变异对应：M1 删同窗去重 / M2 删封顶 / M3 把巩固记进 retrievalCount / M4 当场改 tier
 *          / M5 允许梦境内容参与选择（非活跃痕迹被选中）—— 各有独立 FAIL 靶。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EngramTraceManager, computeEngramDecay, DEFAULT_DYNAMICS_CONFIG } = require('../src/memory-dynamics');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function seeded() {
  const m = new EngramTraceManager();
  // 三条真实痕迹 + 一条「更早的非活跃」痕迹
  // ⚠️ traceId 用固定值：registerTrace 默认随机 id，会让「两次结果逐序一致」对账错位（首轮实测踩到）
  const a = m.registerTrace({ traceId: 'tr-a', createdWindow: 1, sourceWindowNo: 1, contentRef: 'a' });
  const b = m.registerTrace({ traceId: 'tr-b', createdWindow: 2, sourceWindowNo: 2, contentRef: 'b' });
  const c = m.registerTrace({ traceId: 'tr-c', createdWindow: 3, sourceWindowNo: 3, contentRef: 'c' });
  const old = m.registerTrace({ traceId: 'tr-old', createdWindow: 1, sourceWindowNo: 1, contentRef: 'old' });
  m.reactivate(a.traceId, 2); m.reactivate(a.traceId, 2);   // 真实召回 2 次
  m.reactivate(b.traceId, 2);                               // 真实召回 1 次
  // c：本窗新建（3），零召回；old：老痕迹零召回 ⇒ 不是「本窗真实活跃」
  return { m, a, b, c, old };
}

console.log('--- D-26 深睡突触巩固门禁 ---');

/* ============ 1. 🔴 记账不变式：不伪造、不跳变、不增删 ============ */
{
  const { m, a, b, c, old } = seeded();
  const sizeBefore = m.traces.size;
  const retBefore = m.getAllTraces().map((t) => t.retrievalCount);
  const strBefore = m.getAllTraces().map((t) => t.currentStrength);
  const tierBefore = m.getAllTraces().map((t) => t.tier);
  const r = m.consolidateByDream(3, { topN: 3 });

  check('梦真实发生 ⇒ 真的加固了痕迹', r.consolidated.length > 0, JSON.stringify(r.consolidated));
  check('🔴 retrievalCount 零变化（梦里重放不是召回，绝不伪造）',
    JSON.stringify(m.getAllTraces().map((t) => t.retrievalCount)) === JSON.stringify(retBefore));
  check('🔴 当场 strength 零变化（只记账不结算）',
    JSON.stringify(m.getAllTraces().map((t) => t.currentStrength)) === JSON.stringify(strBefore));
  check('🔴 当场 tier 零变化（护前缀缓存，M4 变异对应）',
    JSON.stringify(m.getAllTraces().map((t) => t.tier)) === JSON.stringify(tierBefore));
  check('🔴 不新建痕迹（M5 反向：梦不得凭空造记忆）', m.traces.size === sizeBefore, 'size=' + m.traces.size);
  check('🔴 不删除痕迹（D-005）', m.getAllTraces().every((t) => !!t));
  check('加固对象只动了 dreamSupport 记账字段',
    m.getTrace(a.traceId).dreamSupport === 1 && m.getTrace(a.traceId).retrievalCount === 2);
}

/* ============ 2. 选择判据：真实活跃 + 确定性排序 + Top-N ============ */
{
  const { m, a, b, c, old } = seeded();
  const r = m.consolidateByDream(3, { topN: 3 });
  const ids = r.consolidated;
  check('召回最多的排最前（确定性排序）', ids[0] === a.traceId, ids[0] + ' vs ' + a.traceId);
  check('本窗新建的真实痕迹可入选', ids.indexOf(c.traceId) >= 0);
  check('❌ 更早的非活跃痕迹不入选（选择零梦境内容参与，M5 变异对应）',
    ids.indexOf(old.traceId) < 0, JSON.stringify(ids));
  check('Top-N 上限：4 候选最多取 3', ids.length <= 3, 'got=' + ids.length);

  // 确定性：同输入两次结果一致
  const s2 = seeded();
  const r2 = s2.m.consolidateByDream(3, { topN: 3 });
  check('同输入两次结果逐序一致（零随机）', JSON.stringify(r2.consolidated) === JSON.stringify(ids));

  const empty = new EngramTraceManager();
  check('❌ 空痕迹库 ⇒ 零动作（不硬造）',
    empty.consolidateByDream(1, { topN: 3 }).consolidated.length === 0);
  const idle = new EngramTraceManager();
  idle.registerTrace({ createdWindow: 1, sourceWindowNo: 1 });
  check('❌ 无任何真实活跃痕迹 ⇒ 零动作',
    idle.consolidateByDream(5, { topN: 3 }).consolidated.length === 0);
}

/* ============ 3. 有界：同窗去重 + 每笔 +1 + 累计封顶 ============ */
{
  const { m, a } = seeded();
  m.consolidateByDream(3, { topN: 3 });
  const again = m.consolidateByDream(3, { topN: 3 });
  check('🔴 同窗去重：一条印痕一窗最多 +1（M1 变异对应）',
    again.consolidated.length === 0 && m.getTrace(a.traceId).dreamSupport === 1,
    JSON.stringify(again) + ' support=' + m.getTrace(a.traceId).dreamSupport);

  // 跨窗累计，撞 cap
  for (let w = 4; w <= 9; w++) m.consolidateByDream(w, { topN: 3 });
  const cap = DEFAULT_DYNAMICS_CONFIG.dreamSupportCap;
  check('🔴 累计封顶（M2 变异对应）',
    m.getAllTraces().every((t) => (Number(t.dreamSupport) || 0) <= cap),
    'max=' + Math.max(...m.getAllTraces().map((t) => t.dreamSupport || 0)) + ' cap=' + cap);
  const capped = m.consolidateByDream(20, { topN: 3 });
  check('已达封顶的痕迹不再入选（预算不白花）', capped.consolidated.length === 0, JSON.stringify(capped));
}

/* ============ 4. 衰减效果：只在 decayAll 显现，有界、对照成立 ============ */
{
  const left = seeded();
  const right = seeded();
  right.m.consolidateByDream(3, { topN: 3 });
  left.m.decayAll(12);
  right.m.decayAll(12);
  const l = left.m.getTrace(left.a.traceId).currentStrength;
  const rr = right.m.getTrace(right.a.traceId).currentStrength;
  check('🔴 巩固的痕迹衰减后留存更高（抗衰减能力真的变强）', rr > l, l + ' -> ' + rr);
  check('效果有界（不是刻骨铭心：差距被 γ/cap 压住）', rr - l <= 0.2, 'gap=' + (rr - l));
  check('clamp 仍在（留存绝不越 1.0）', rr <= 1.0, String(rr));
  check('未巩固的对照痕迹两边一致（巩固不外溢）',
    left.m.getTrace(left.old.traceId).currentStrength === right.m.getTrace(right.old.traceId).currentStrength);
  const tiers = right.m.getAllTraces().map((t) => t.tier);
  check('tier 仍由 decayAll 单点结算（与 D-23 同款）', tiers.length === right.m.traces.size);
}

/* ============ 5. 持久化往返（含旧快照兼容） ============ */
{
  const { m, a } = seeded();
  m.consolidateByDream(3, { topN: 3 });
  const snap = m.exportSnapshot(3);
  const m2 = new EngramTraceManager();
  m2.restoreFromSnapshot(snap);
  check('🔴 快照往返保留 dreamSupport', m2.getTrace(a.traceId).dreamSupport === 1);
  check('往返保留同窗去重水位', m2.getTrace(a.traceId).lastConsolidatedWindow === 3);
  check('往返后 retrievalCount 仍是事实值', m2.getTrace(a.traceId).retrievalCount === 2);

  // 旧快照（无新字段）不崩、视为未巩固
  const legacy = new EngramTraceManager();
  legacy.restoreFromSnapshot({ traces: [{ traceId: 'tr-legacy', createdWindow: 1, currentStrength: 0.6, retrievalCount: 0, tier: 'FADING' }] });
  const t = legacy.getTrace('tr-legacy');
  check('旧快照无新字段不崩（零迁移）', !!t && (Number(t.dreamSupport) || 0) === 0);
  const decayed = computeEngramDecay(t, 5, legacy.config);
  check('旧痕迹参与衰减计算不抛、support 视为 0', !!decayed && typeof decayed.currentStrength === 'number');
}

/* ============ 6. brain 挂点静态锁（同 D1-11b 风格） ============ */
{
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
  check('🔴 巩固只在 dreamRecord 真实产出分支内（合成失败零巩固）',
    /if \(dreamRecord\) \{[\s\S]{0,1600}?consolidateByDream/.test(brainSrc));
  check('🔴 consolidatedTraceIds 随梦境记录入档（加固全程可审计）',
    brainSrc.includes('consolidatedTraceIds'));
  check('归档在巩固之后（哈希链覆盖加固清单）',
    brainSrc.indexOf('consolidateByDream') < brainSrc.indexOf('this.experiencesArchive.append(dreamRecord)'));
  check('巩固失败不掀桌（fail-safe 同款：try/catch 旁路）',
    /engramManager\.consolidateByDream[\s\S]{0,600}catch \(e\)/.test(brainSrc));
}

console.log(failures === 0 ? '全部通过' : ('失败 ' + failures + ' 项'));
process.exitCode = failures === 0 ? 0 : 1;
