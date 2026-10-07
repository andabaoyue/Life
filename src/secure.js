const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, writeJsonAtomic, renameWithRetry, tmpNameFor } = require('./atomic');

/**
 * API Key 的加密存储 —— 边界层。
 * config.js 保持「纯 JSON 读写」，本模块只多一个密文文件，
 * 并且不 require('electron')：由 main 把 safeStorage 取函数传进来。
 * 这样 node 侧测试能直接跑，不必拉起 Electron。
 *
 * 背景：apiKey 以前明文写进 gpt-girl-config.json，README 还把路径写在脸上 ——
 * 本机任何能读该文件的进程/用户都能直接拿走 Key。现在：
 *   gpt-girl-config.json  —— 只有非敏感配置，绝不含明文 key
 *   gpt-girl-key          —— safeStorage 密文（Windows 走 DPAPI，绑当前用户）
 *
 * 诚实的边界（不吹安全等级）：
 *   - 挡的是「配置文件被直接读走 / 备份泄露 / 别人翻你 AppData」；
 *     挡不住能调用 Electron API 的运行中进程 —— 那种场景 key 本来就在内存里。
 *   - Linux 没有可用 secret service 时 Electron 会退到弱密钥后端，
 *     所以「到底加密了没有」由 isEncryptionAvailable() 决定并如实上报，
 *     绝不在没加密的情况下告诉用户已加密。
 *   - 加密不可用时退回明文存储（桌宠必须还能跑），面板显示真实状态。
 */

const KEY_FILE = 'life-key';
// SEC-05: 敏感文件（credential/config）落盘权限 —— Unix 0600；Windows 保持既有 ACL 语义（chmod 为有限语义，仅尽力）
const SENSITIVE_FILE_MODE = 0o600;
const PLAINTEXT_PREFIX = 'plain:v1:';
const LEGACY_KEY_FILE = 'gpt-girl-key';
const CFG_FILE = 'life-config.json';
const LEGACY_CFG_FILE = 'gpt-girl-config.json';

/**
 * Credential storage contract（P5-C2）：
 *   { providerId, credentialType, secret value }
 *     → 逻辑命名空间 apiKey:${providerId} → 存储文件映射（命名空间经净化，不机械把冒号当文件名）。
 *   - providerId 'deepseek'（含缺省/legacy）：沿用 life-key / gpt-girl-key（legacy 迁移语义保持）；
 *   - 其他 providerId：隔离文件 life-key--<ns> —— deepseek key ≠ generic key ≠ provider A/B，
 *     切换 Provider 后绝不读到另一个 Provider 的 key。
 */
function credentialNamespace(providerId) {
  const pid = String(providerId == null ? '' : providerId).trim() || 'deepseek';
  if (pid === 'deepseek') return 'deepseek'; // legacy 行为逐位保持
  // P5-C-01: readablePrefix + stableHash(fullProviderId) —— 碰撞不可能后缀。
  // 简单字符替换可碰撞（'a/b' 与 'a_b' 同名）、64 字符截断可碰撞；
  // hash 取自完整 providerId（非加密，仅作 namespace 唯一性），有界且文件名安全。
  const readable = pid.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 32) || 'p';
  const hash = crypto.createHash('sha256').update(pid).digest('hex').slice(0, 16);
  return readable + '--' + hash;
}

/** P5 首版命名（可碰撞、64 截断），仅用于旧文件迁移读取，绝不用于新写入 */
function legacyV0Namespace(providerId) {
  const pid = String(providerId == null ? '' : providerId).trim() || 'deepseek';
  return pid.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'deepseek';
}

/**
 * P5-C-01: v0 旧命名归属判定 —— 候选集 = 当前 providerId + Registry 全部已注册 providerId。
 * 映射到同一 v0 路径的候选（文件名按大小写不敏感比较，与 Windows 文件系统一致）：
 *   仅 1 个 -> 归属可证明，允许 legacy fallback / 迁移；
 *   >1 个 -> 归属无法证明，必须 fail-closed（不读取、不迁移、不覆盖新 namespace）。
 * Registry 不可枚举时返回 null（同样 fail-closed）。通用规则，无任何 id 特例。
 */
function legacyV0Claimants(providerId) {
  const pid = String(providerId == null ? '' : providerId).trim() || 'deepseek';
  let known;
  try {
    known = require('./provider-registry').listProviders();
  } catch {
    return null; // 无法枚举候选 -> 无法证明归属
  }
  const target = legacyV0Namespace(pid).toLowerCase();
  const claimants = new Set();
  for (const id of [pid, ...known.map((x) => String(x))]) {
    if (legacyV0Namespace(id).toLowerCase() === target) claimants.add(String(id).trim());
  }
  return [...claimants];
}

function keyPath(dir, providerId) {
  const ns = credentialNamespace(providerId);
  if (ns !== 'deepseek') {
    const primary = path.join(dir, KEY_FILE + '--' + ns);
    if (fs.existsSync(primary)) return primary;
    // P5-C-01 兼容迁移：P5 首版命名的旧文件仅在归属可证明（唯一 claimant）时读取；
    // 历史碰撞（多个 provider 映射同一旧路径）-> fail-closed：不读取、不迁移。
    const claimants = legacyV0Claimants(providerId);
    if (claimants && claimants.length === 1) {
      const legacyV0 = path.join(dir, KEY_FILE + '--' + legacyV0Namespace(providerId));
      if (fs.existsSync(legacyV0)) return legacyV0;
    }
    return primary;
  }
  const primary = path.join(dir, KEY_FILE);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(dir, LEGACY_KEY_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}
function primaryKeyPath(dir, providerId) {
  const ns = credentialNamespace(providerId);
  return path.join(dir, ns === 'deepseek' ? KEY_FILE : KEY_FILE + '--' + ns);
}

function cfgPath(dir) {
  const primary = path.join(dir, CFG_FILE);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(dir, LEGACY_CFG_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}
function primaryCfgPath(dir) { return path.join(dir, CFG_FILE); }

/** 加密不可用返回 false，调用方据此退回明文并如实上报 */
function encryptKey(getSS, dir, apiKey, providerId) {
  try {
    const ss = typeof getSS === 'function' ? getSS() : null;
    if (!ss || !ss.isEncryptionAvailable()) return false;
    // 必须原子写：这一步成功之后 config.json 里那份明文就会被删掉，
    // 写出半截密文 = key 真的没了。
    writeFileAtomic(primaryKeyPath(dir, providerId), ss.encryptString(apiKey), { mode: SENSITIVE_FILE_MODE });
    return true;
  } catch (e) {
    console.error('key encrypt failed:', e.message);
    return false;
  }
}

/** 尝试从指定文件路径解析并解密凭据（支持识别 plain:v1: 降级明文并按需安全迁移） */
function tryDecryptFile(getSS, filePath, dir, providerId, meta) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const raw = buf.toString('utf8');
  const ss = typeof getSS === 'function' ? getSS() : null;
  const hasSS = Boolean(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable());

  if (raw.startsWith(PLAINTEXT_PREFIX)) {
    const plainKey = raw.slice(PLAINTEXT_PREFIX.length);
    let migrated = false;
    // 若当前加密可用，自动迁移为密文
    if (hasSS) {
      try {
        const cipher = ss.encryptString(plainKey);
        // 必须在写入之前做 round-trip：写完再读会先把 primary 覆盖成可能不可解的密文，
        // 而 keyPath() 优先返回 primary —— legacy 明文从此被遮蔽，校验就失去意义。
        if (cipher && ss.decryptString(cipher) === plainKey) {
          writeFileAtomic(primaryKeyPath(dir, providerId), cipher, { mode: SENSITIVE_FILE_MODE });
          if (filePath !== primaryKeyPath(dir, providerId)) {
            try { fs.unlinkSync(filePath); } catch {}
          }
          migrated = true;
        }
      } catch {}
    }
    if (meta && typeof meta === 'object') {
      meta.encrypted = migrated;
      meta.sourcePath = filePath;
      meta.migrated = migrated;
    }
    return plainKey;
  }

  if (hasSS) {
    try {
      const key = ss.decryptString(buf) || null;
      if (key) {
        if (filePath !== primaryKeyPath(dir, providerId) && !fs.existsSync(primaryKeyPath(dir, providerId))) {
          try { writeFileAtomic(primaryKeyPath(dir, providerId), buf, { mode: SENSITIVE_FILE_MODE }); } catch {}
        }
        if (meta && typeof meta === 'object') {
          meta.encrypted = true;
          meta.sourcePath = filePath;
        }
        return key;
      }
    } catch {
      // 解密失败：继续检查其他兜底
    }
  }
  return null;
}

/** 没有密文文件、或解不出（换机器/换 Windows 用户）都返回 null；兼容识别 plain:v1: 降级明文 */
function decryptKey(getSS, dir, providerId, meta) {
  try {
    const primary = primaryKeyPath(dir, providerId);
    const key = tryDecryptFile(getSS, primary, dir, providerId, meta);
    if (key !== null) return key;

    // 若 primary 文件不存在或损坏解不出，尝试 legacy 路径（双层防遮蔽兜底）
    const ns = credentialNamespace(providerId);
    let legacy = null;
    if (ns === 'deepseek') {
      legacy = path.join(dir, LEGACY_KEY_FILE);
    } else {
      const claimants = legacyV0Claimants(providerId);
      if (claimants && claimants.length === 1) {
        legacy = path.join(dir, KEY_FILE + '--' + legacyV0Namespace(providerId));
      }
    }
    if (legacy && legacy !== primary && fs.existsSync(legacy)) {
      return tryDecryptFile(getSS, legacy, dir, providerId, meta);
    }
    return null;
  } catch {
    return null;
  }
}

function dropKeyFile(dir, providerId) {
  try { fs.unlinkSync(primaryKeyPath(dir, providerId)); } catch {}
  if (credentialNamespace(providerId) === 'deepseek') {
    try { fs.unlinkSync(path.join(dir, LEGACY_KEY_FILE)); } catch {}
  } else {
    try { fs.unlinkSync(path.join(dir, KEY_FILE + '--' + legacyV0Namespace(providerId))); } catch {}
  }
}

/** 从 config.json 里抹掉明文 apiKey（就地改文件） */
function stripPlainKey(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
    if (!raw || !('apiKey' in raw)) return false;
    delete raw.apiKey;
    writeJsonAtomic(cfgPath(dir), raw, { mode: SENSITIVE_FILE_MODE });
    return true;
  } catch {
    return false;   // 文件不存在/坏掉都当没这回事，load 自有兜底
  }
}

/**
 * 事务式保存配置与 API Key。
 *
 * 采用两阶段事务保存思路（P0-01 规范）：
 * 1. 保存前记录旧 Key 文件和 Config 文件的完整快照状态。
 * 2. 新 Key 先写入同目录临时文件 + fsync。
 * 3. 配置通过 writeDisk 写入临时文件并原子替换。
 * 4. 两边均成功后，原子替换新 Key 文件（或安全删除旧 Key 文件）。
 * 5. 任一步骤失败，均清理临时文件并全量回滚到原快照状态，抛出异常。
 * 6. 严禁留下半写入文件或版本不一致的组合。
 */
function saveConfig(getSS, dir, cfg, writeDisk, _hooks, opts = {}) {
  const providerId = String((cfg && cfg.provider) || '').trim() || 'deepseek';
  const kp = primaryKeyPath(dir, providerId);
  const cp = primaryCfgPath(dir);

  // 1. 保存前记录旧 Key 文件与 Config 文件状态快照
  const activeKp = keyPath(dir, providerId);
  const activeCp = cfgPath(dir);
  const oldKeyExists = fs.existsSync(activeKp);
  const oldKeyData = oldKeyExists ? fs.readFileSync(activeKp) : null;
  const oldCfgExists = fs.existsSync(activeCp);
  const oldCfgData = oldCfgExists ? fs.readFileSync(activeCp) : null;

  const { apiKey, ...disk } = cfg;
  const key = String(apiKey || '').trim();

  let encrypted = false;
  let hasKey = false;
  let cipherBuf = null;

  if (key) {
    hasKey = true;
    try {
      const ss = typeof getSS === 'function' ? getSS() : null;
      if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
        cipherBuf = ss.encryptString(key);
        encrypted = true;
      }
    } catch (e) {
      console.error('key encrypt failed:', e.message);
      encrypted = false;
      cipherBuf = null;
    }
  }

  const tmpFiles = [];

  try {
    // 2. 新 Key 密文先写入临时文件（若走加密存储）
    let tmpKeyPath = null;
    if (encrypted && cipherBuf) {
      tmpKeyPath = tmpNameFor(kp);
      tmpFiles.push(tmpKeyPath);
      const fd = fs.openSync(tmpKeyPath, 'w', SENSITIVE_FILE_MODE);
      try {
        fs.writeFileSync(fd, cipherBuf);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }

    // 3. 配置写入（通过 writeDisk 原子落盘）
    // 加密或无 Key 时，config.json 绝不含明文 apiKey；加密不可用时降级明文写入
    const diskToSave = (encrypted || !hasKey) ? disk : { ...disk, apiKey: key };
    writeDisk(diskToSave);

    // 4. 配置写入成功后，完成第二阶段提交
    if (_hooks && typeof _hooks.beforeKeyCommit === 'function') {
      _hooks.beforeKeyCommit();
    }
    if (encrypted && tmpKeyPath) {
      renameWithRetry(tmpKeyPath, kp);
      try { fs.chmodSync(kp, SENSITIVE_FILE_MODE); } catch {} // SEC-05: 落盘后再次确保 mode
      const idx = tmpFiles.indexOf(tmpKeyPath);
      if (idx !== -1) tmpFiles.splice(idx, 1);
    } else if (hasKey && !encrypted) {
      // 架构决策（Legacy 降级保全）：加密不可用但存在有效 Key 时，由 diskToSave 将明文 Key 降级写入 config.json
      // （供用户手改或无安全存储环境启动保住凭据），同时删除密文文件以防被误判为已加密（严格对齐 test/secure.test.js:103 契约）。
      dropKeyFile(dir, providerId);
    } else if (key === '') {
      // 显式清空 key 时（必须显式声明 clearKey），删除密文文件；若未显式要求清空则严禁误删旧凭据
      const shouldClear = Boolean(
        (opts && opts.clearKey === true) ||
        (cfg && cfg.clearKey === true) ||
        (_hooks && _hooks.clearKey === true)
      );
      if (shouldClear) {
        dropKeyFile(dir, providerId);
      }
    }

    return { encrypted, hasKey };
  } catch (err) {
    // 5. 任一步失败，清理临时文件并恢复旧状态
    for (const tmpFile of tmpFiles) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    // 回滚 Key 文件
    try {
      if (oldKeyExists && oldKeyData !== null) {
        writeFileAtomic(kp, oldKeyData, { mode: SENSITIVE_FILE_MODE });
      } else {
        dropKeyFile(dir, providerId);
      }
    } catch (rbErr) {
      console.error('[Rollback] 恢复旧 Key 文件失败:', rbErr.message);
    }

    // 回滚 Config 文件
    try {
      if (oldCfgExists && oldCfgData !== null) {
        writeFileAtomic(cp, oldCfgData, { mode: SENSITIVE_FILE_MODE });
      } else {
        try { fs.unlinkSync(cp); } catch {}
      }
    } catch (rbErr) {
      console.error('[Rollback] 恢复旧 Config 文件失败:', rbErr.message);
    }

    throw err;
  }
}

/**
 * 读配置，并顺手把老版本（v0.5 及更早）留在 config.json 里的明文 key 迁成密文。
 */
function loadConfig(getSS, dir, readDisk) {
  const disk = { ...(readDisk() || {}) };
  delete disk.writingMode; // v0.9.9: 旧字段静默忽略 —— 读取兼容、不报错、不打回默认值
  const providerId = String(disk.provider || '').trim() || 'deepseek';
  const meta = {};
  const fromKey = decryptKey(getSS, dir, providerId, meta);
  if (fromKey) {
    if ('apiKey' in disk) stripPlainKey(dir);
    return { cfg: { ...disk, apiKey: fromKey }, encrypted: meta.encrypted === true };
  }
  const legacy = String(disk.apiKey || '');
  const noCipher = !fs.existsSync(keyPath(dir, providerId));
  if (legacy && noCipher && encryptKey(getSS, dir, legacy, providerId)
      && decryptKey(getSS, dir, providerId) === legacy) {
    stripPlainKey(dir);
    return { cfg: { ...disk, apiKey: legacy }, encrypted: true, migrated: true };
  }
  return { cfg: { ...disk, apiKey: legacy }, encrypted: false };
}

module.exports = {
  KEY_FILE,
  LEGACY_KEY_FILE,
  CFG_FILE,
  LEGACY_CFG_FILE,
  PLAINTEXT_PREFIX,
  credentialNamespace,
  legacyV0Namespace,
  legacyV0Claimants,
  keyPath,
  primaryKeyPath,
  cfgPath,
  primaryCfgPath,
  encryptKey,
  decryptKey,
  dropKeyFile,
  stripPlainKey,
  saveConfig,
  loadConfig
};
