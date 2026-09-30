/**
 * src/connection-switch.js — Connection 激活编排（0.9.8 Z2-B）
 *
 * 职责：activeConnection 切换 = runtime cfg 解析（Z2-A）+ Brain hot-swap（复用 brain-hot-swap.js）
 * + 双写一致性回滚（flat cfg 镜像 ↔ store.activeConnectionId）。
 *
 * brain-hot-swap.js 的 swapBrain 骨架**零改动**（本模块只作为其调用方做参数化接线）；
 * 失败语义沿用其硬要求：candidate 任一步失败 -> dispose candidate -> 配置回滚 -> 旧 Brain 继续服务。
 *
 * 一致性硬要求（不允许出现 store=B/runtime=A 或 store=A/runtime=B 的终态）：
 *   persistCfg 回调内同时维护 flat cfg 镜像与 store.activeConnectionId；
 *   任一写失败 -> 补偿回滚另一个 -> 抛错（swapBrain step-1 捕获后整体失败）。
 *   swapBrain 的 rollback 路径（persistCfg(oldCfg)）同样走本回调 -> 两个状态一起回 A。
 *
 * Subject Isolation（Z2-E）：切换只是 Runtime Host 改变——不写 Subject identity /
 * self-ledger / birthAt / provenance / experience archive；displayName/baseURL/providerId
 * 只进 runtime cfg（resolveRuntimeCfg 已排除全部 Connection 元数据）。
 *
 * Runtime Evidence（Z2-D）：本模块不触碰 provider-runtime-trust.js / experiment-metadata.js。
 * 每个 candidate Brain 自带新 adapter/client -> 新 mint 实例 -> WeakSet per-object 信任根
 * 天然保证 A/B evidence 不串绑。
 */
const { loadStore, setActiveConnection, resolveRuntimeCfg } = require('./connections');
const { swapBrain } = require('./brain-hot-swap');

/**
 * @param {object} p
 * @param {string} p.dir                    userData 目录（connections store 所在）
 * @param {string} p.targetConnectionId     目标连接
 * @param {object} p.oldBrain               当前 Brain（失败时必须继续服务）
 * @param {object} p.oldCfg                 当前 runtime cfg（回滚目标）
 * @param {(cfg: object) => void} p.persistFlat   写旧 flat 配置镜像（main.js persistCfg 的写盘口）
 * @param {(cfg: object) => object} p.createCandidate  创建候选 Brain
 * @param {(brain: object) => void} [p.bindCandidate]
 * @param {Function} [p.getSS]              safeStorage 取函数（透传 secure-credentials）
 * @param {string} [p.fallbackSecret]       legacy 明文降级 secret（调用方显式提供）
 * @param {Function} [p.disposeCandidate]   覆盖默认 candidate 清理（测试用）
 * @returns {{ok: boolean, brain?: object, cfg?: object, activeConnectionId: string,
 *            error?: string, rolledBack?: boolean, consistent?: boolean}}
 */
function activateConnection({
  dir, targetConnectionId,
  oldBrain, oldCfg,
  persistFlat, createCandidate, bindCandidate = null,
  getSS, fallbackSecret,
  disposeCandidate
}) {
  // 0. store / target 校验（fail-closed：任何异常都一切未动）
  const loaded = loadStore(dir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, brain: oldBrain, cfg: oldCfg, activeConnectionId: currentActive(dir), consistent: true };
  }
  if (!loaded.store) {
    return { ok: false, error: 'STORE_ABSENT', brain: oldBrain, cfg: oldCfg, activeConnectionId: null, consistent: true };
  }
  const prevActiveId = loaded.store.activeConnectionId;
  const target = loaded.store.connections.find((c) => c.connectionId === targetConnectionId);
  if (!target) {
    return { ok: false, error: 'CONNECTION_NOT_FOUND: ' + targetConnectionId, brain: oldBrain, cfg: oldCfg, activeConnectionId: prevActiveId, consistent: true };
  }

  // 1. Z2-A：解析目标 Connection -> runtime cfg（credential 不可用 -> 拒绝，未验证 ≠ 可用）
  const resolved = resolveRuntimeCfg(target, { dir, getSS, fallbackSecret });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, brain: oldBrain, cfg: oldCfg, activeConnectionId: prevActiveId, consistent: true };
  }
  // 保留全局参数（窗口/memoryCap/price 等）；连接字段覆盖之。Connection 元数据不进 cfg。
  const nextCfg = { ...oldCfg, ...resolved.cfg };

  // 2. 双写回调：flat 镜像 + activeConnectionId 必须同向；失败补偿，绝不留不一致终态
  const persistBoth = (c) => {
    persistFlat(c); // 先写 flat：失败即未动 store
    const wantActive = (c === nextCfg) ? targetConnectionId : prevActiveId;
    const r = setActiveConnection(dir, wantActive);
    if (!r.ok) {
      // 补偿：flat 恢复 + store 恢复（尽力），随后抛错交由 swapBrain 统一失败路径
      try { persistFlat(oldCfg); } catch { /* 补偿失败也要继续报错 */ }
      try { setActiveConnection(dir, prevActiveId); } catch { /* 同上 */ }
      throw new Error('ACTIVE_CONNECTION_UPDATE_FAILED: ' + r.error);
    }
  };

  // 3. 复用 swapBrain 骨架（零改动）：persist -> create/bind -> 失败 dispose+回滚 -> 成功换引用
  const res = swapBrain({
    oldBrain,
    oldCfg,
    nextCfg,
    createCandidate,
    bindCandidate,
    persistCfg: persistBoth,
    disposeCandidate
  });

  const afterActive = currentActive(dir);
  if (!res.ok) {
    // 失败终态必须是 A/A/A：runtime cfg = oldCfg、store = prevActive、旧 Brain 存活
    return {
      ok: false,
      error: res.error,
      brain: oldBrain,
      cfg: oldCfg,
      activeConnectionId: afterActive,
      rolledBack: res.rolledBack === true,
      consistent: afterActive === prevActiveId
    };
  }
  return {
    ok: true,
    brain: res.brain,
    cfg: res.cfg,
    activeConnectionId: afterActive,
    rolledBack: false,
    consistent: afterActive === targetConnectionId
  };
}

function currentActive(dir) {
  try {
    const l = loadStore(dir);
    return l.store ? l.store.activeConnectionId : null;
  } catch {
    return null;
  }
}

module.exports = { activateConnection };
