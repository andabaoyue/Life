/**
 * 通用 JSON 数据版本迁移器。
 *
 * 纯数据转换函数，不涉及磁盘读写与备份（I/O 与备份由调用方负责）。
 *
 * 迁移流程：
 *   1. 读取 data[opts.versionKey]（若缺失或非有限数字则默认为 0，记为 fromVersion）
 *   2. 若 fromVersion === currentVersion，直接返回 { data, migrated: false, fromVersion }
 *   3. 若 fromVersion > currentVersion，抛出异常提示程序版本过低
 *   4. 从 (fromVersion + 1) 到 currentVersion 逐级执行迁移函数，并回写目标版本号
 *   5. 返回 { data: migratedData, migrated: true, fromVersion }
 */

/**
 * 执行数据迁移
 *
 * @param {object|null|undefined} data - 从磁盘读取的原始 JSON 数据对象（初次运行时可为 null/undefined）
 * @param {number} currentVersion - 代码期望的目标 Schema 版本号
 * @param {Object<number|string, Function>} migrations - 版本迁移函数映射表，键为目标版本号，值为迁移函数 (data) => migratedData
 * @param {object} [opts] - 可选配置项
 * @param {string} [opts.versionKey='schemaVersion'] - 数据对象中记录版本号的字段名，默认为 'schemaVersion'
 * @returns {{ data: any, migrated: boolean, fromVersion: number }} 迁移结果对象
 */
function migrate(data, currentVersion, migrations, opts) {
  const versionKey = (opts && typeof opts.versionKey === 'string' && opts.versionKey)
    ? opts.versionKey
    : 'schemaVersion';

  const rawVersion = (data && typeof data === 'object') ? data[versionKey] : undefined;
  const fromVersion = Number.isFinite(rawVersion) ? rawVersion : 0;

  if (fromVersion === currentVersion) {
    return { data, migrated: false, fromVersion };
  }

  if (fromVersion > currentVersion) {
    throw new Error(`数据版本 (${fromVersion}) 高于程序版本 (${currentVersion})，请升级程序`);
  }

  let currentData = data;
  for (let v = fromVersion + 1; v <= currentVersion; v++) {
    const migrator = migrations && migrations[v];
    if (typeof migrator !== 'function') {
      throw new Error(`缺少 v${v} 的迁移函数`);
    }
    const result = migrator(currentData);
    currentData = result !== undefined ? result : currentData;
    if (currentData && typeof currentData === 'object') {
      currentData[versionKey] = v;
    }
  }

  return {
    data: currentData,
    migrated: true,
    fromVersion
  };
}

module.exports = {
  migrate
};
