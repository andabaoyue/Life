/**
 * src/circuit-breaker.js — Provider Health / Circuit Breaker（v0.9.8 P4-3）
 *
 * 【Staged 预留阶段】本模块已实现并有回归覆盖，但暂未接进主干生产编排
 * （brain.js 主链路当前无真实熔断流量经此流转）——INT-01：实现 ≠ 运行时。
 *
 * 状态机：closed → open → half-open → closed / open。
 * - closed：正常放行；
 * - open：连续失败达到阈值后熔断，cooldown 内拒绝尝试；
 * - cooldown 到期进入 half-open，放行一次探测：成功回 closed，失败回 open（重新 cooldown）。
 *
 * 红线：熔断只控制「是否允许尝试」，不参与 provenance 真值判定 ——
 * breaker 状态/计数永远不进入 Attempt / Result / GenerationContext 的事实字段。
 */

function createCircuitBreaker({ failureThreshold = 3, cooldownMs = 30000, now = () => Date.now() } = {}) {
  const threshold = Math.max(1, Math.floor(failureThreshold));
  const cooldown = Math.max(0, Math.floor(cooldownMs));
  let state = 'closed'; // closed | open | half-open
  let consecutiveFailures = 0;
  let cooldownUntil = null;
  let probeInFlight = false;

  function allowAttempt() {
    if (state === 'closed') return true;
    if (state === 'open') {
      if (Number.isFinite(cooldownUntil) && now() >= cooldownUntil) {
        state = 'half-open';
        probeInFlight = true;
        return true; // 放行一次探测
      }
      return false;
    }
    // half-open：一次只允许一个探测，其余拒绝
    return false;
  }

  function recordSuccess() {
    state = 'closed';
    consecutiveFailures = 0;
    cooldownUntil = null;
    probeInFlight = false;
  }

  function recordFailure() {
    consecutiveFailures += 1;
    if (state === 'half-open') {
      state = 'open';
      probeInFlight = false;
      cooldownUntil = now() + cooldown;
      return;
    }
    if (consecutiveFailures >= threshold) {
      state = 'open';
      cooldownUntil = now() + cooldown;
    }
  }

  function getState() {
    // 刻意只暴露运行状态，不含任何 provenance 字段
    return {
      state,
      consecutiveFailures,
      cooldownUntil,
      probeInFlight
    };
  }

  return { allowAttempt, recordSuccess, recordFailure, getState };
}

module.exports = { createCircuitBreaker };
