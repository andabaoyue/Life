const fs = require('fs');
const path = require('path');

/**
 * 启动资源完整性检查器
 *
 * 在桌宠启动时检查必要与可选立绘资源：
 * 1. CRITICAL_ASSETS（绝对底线）：缺少则桌宠彻底无法显示；
 * 2. LAYER_ASSETS（分层渲染基础）：缺少则无法合成衣柜分层，自动降级为单张兜底立绘；
 * 3. catalog（衣柜清单）：若提供，逐项检查已登记的服装各图层部件文件。
 */

const CRITICAL_ASSETS = ['assets/pet.png'];
const LAYER_ASSETS = ['assets/character/base/base.png'];

/**
 * 检查应用资源完整性
 *
 * @param {string} rootDir 应用根目录（assets/ 目录的父目录）
 * @param {Record<string, { file: string }>} [catalog] 衣柜 CATALOG 字典（可选）
 * @returns {{
 *   ok: boolean,
 *   missing: string[],
 *   hasFallback: boolean,
 *   hasLayers: boolean,
 *   warnings: string[]
 * }} 资源健康状况检查结果
 */
function checkAssets(rootDir, catalog) {
  const baseDir = typeof rootDir === 'string' && rootDir.length > 0 ? rootDir : '.';
  const missing = [];
  const warnings = [];

  // 1. 检查关键兜底立绘资源
  for (const file of CRITICAL_ASSETS) {
    const fullPath = path.join(baseDir, file);
    if (!fs.existsSync(fullPath)) {
      missing.push(file);
      if (file === 'assets/pet.png') {
        warnings.push('缺少兜底立绘 assets/pet.png，角色将无法显示');
      }
    }
  }

  // 2. 检查分层基础图层资源
  for (const file of LAYER_ASSETS) {
    const fullPath = path.join(baseDir, file);
    if (!fs.existsSync(fullPath)) {
      missing.push(file);
      if (file === 'assets/character/base/base.png') {
        warnings.push('缺少基础图层 assets/character/base/base.png，将使用单图兜底模式');
      }
    }
  }

  // 3. 若提供衣柜 CATALOG，检查所有已登记配件图层文件
  if (catalog && typeof catalog === 'object') {
    for (const [itemId, item] of Object.entries(catalog)) {
      if (!item || typeof item.file !== 'string') {
        continue;
      }
      const file = item.file;
      const relPath = `assets/character/${file}`;
      const fullPath = path.join(baseDir, relPath);
      if (!fs.existsSync(fullPath)) {
        missing.push(relPath);
        warnings.push(`衣柜图层缺失：assets/character/${file}（${itemId}）`);
      }
    }
  }

  const ok = CRITICAL_ASSETS.every(f => !missing.includes(f));
  const hasFallback = !missing.includes('assets/pet.png');
  const hasLayers = !missing.includes('assets/character/base/base.png');

  return {
    ok,
    missing,
    hasFallback,
    hasLayers,
    warnings
  };
}

module.exports = {
  checkAssets,
  CRITICAL_ASSETS,
  LAYER_ASSETS
};
