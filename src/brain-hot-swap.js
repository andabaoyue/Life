/**
 * src/brain-hot-swap.js — Brain 热替换编排（v0.9.8 P5-D）
 *
 * 失败路径硬要求：
 *   candidate 初始化 → 任一步骤失败 → candidate cleanup（复用 shutdown()/abort()，
 *   覆盖 abort controller / pending request / DeferredWriter flush / generation 终止）
 *   → 恢复旧 cfg（persistCfg(oldCfg)）→ 旧 Brain 继续服务、无残留半初始化 Brain。
 *
 * 【implemented+tested；production-wired：main.js config-set-key 处理器已改用本编排】
 */

/** 复用既有 shutdown()/abort() 清理 candidate（不足之处才需要 dispose() —— 当前不需要）。 */
function disposeCandidateBrain(candidate) {
  if (!candidate) return;
  try {
    if (typeof candidate.shutdown === 'function') {
      candidate.shutdown(); // shutdownRequested + generationId++ + abort() + flushAll()
      return;
    }
    if (typeof candidate.abort === 'function') candidate.abort();
  } catch (e) {
    try { if (typeof candidate.abort === 'function') candidate.abort(); } catch {}
    throw e;
  }
}

/**
 * @returns {{ok: boolean, brain?: object, cfg?: object, error?: string,
 *            candidateDisposed: boolean, rolledBack: boolean}}
 */
function swapBrain({
  oldBrain,
  oldCfg,
  nextCfg,
  createCandidate,
  bindCandidate = null,
  persistCfg,
  disposeCandidate = disposeCandidateBrain
}) {
  // 1. 持久化新配置（失败则一切未动）
  try {
    persistCfg(nextCfg);
  } catch (err) {
    return { ok: false, error: '配置持久化失败: ' + err.message, candidateDisposed: false, rolledBack: false };
  }

  // 2. 创建 + 绑定 candidate；任一步失败 -> cleanup + 配置回滚，旧 Brain 继续服务
  let candidate = null;
  try {
    candidate = createCandidate(nextCfg);
    if (typeof bindCandidate === 'function') bindCandidate(candidate);
  } catch (err) {
    let disposed = false;
    if (candidate) {
      try { disposeCandidate(candidate); disposed = true; } catch (e) {
        console.error('[HotSwap] candidate cleanup 失败:', e.message);
      }
    }
    try {
      persistCfg(oldCfg);
    } catch (rbErr) {
      console.error('[Rollback] 回滚配置失败:', rbErr.message);
    }
    return {
      ok: false,
      error: '新 Brain 初始化失败: ' + err.message,
      candidateDisposed: disposed,
      rolledBack: true
    };
  }

  // 3. 成功：flush / 关闭旧 Brain（非致命异常不阻断切换）
  try {
    if (oldBrain) {
      if (typeof oldBrain.flushAll === 'function') oldBrain.flushAll();
      if (typeof oldBrain.shutdown === 'function') oldBrain.shutdown();
      else if (typeof oldBrain.abort === 'function') oldBrain.abort();
    }
  } catch (err) {
    console.warn('[Brain] 旧 Brain 关闭异常（非致命）:', err.message);
  }

  // 4. 切换主引用（由调用方赋值）
  return { ok: true, brain: candidate, cfg: nextCfg, candidateDisposed: false, rolledBack: false };
}

module.exports = { swapBrain, disposeCandidateBrain };
