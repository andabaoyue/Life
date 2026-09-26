const fs = require('fs');
const path = require('path');
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
const LEGACY_KEY_FILE = 'gpt-girl-key';
const CFG_FILE = 'life-config.json';
const LEGACY_CFG_FILE = 'gpt-girl-config.json';

function keyPath(dir) {
  const primary = path.join(dir, KEY_FILE);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(dir, LEGACY_KEY_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}
function primaryKeyPath(dir) { return path.join(dir, KEY_FILE); }

function cfgPath(dir) {
  const primary = path.join(dir, CFG_FILE);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(dir, LEGACY_CFG_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}
function primaryCfgPath(dir) { return path.join(dir, CFG_FILE); }

/** 加密不可用返回 false，调用方据此退回明文并如实上报 */
function encryptKey(getSS, dir, apiKey) {
  try {
    const ss = typeof getSS === 'function' ? getSS() : null;
    if (!ss || !ss.isEncryptionAvailable()) return false;
    // 必须原子写：这一步成功之后 config.json 里那份明文就会被删掉，
    // 写出半截密文 = key 真的没了。
    writeFileAtomic(primaryKeyPath(dir), ss.encryptString(apiKey));
    return true;
  } catch (e) {
    console.error('key encrypt failed:', e.message);
    return false;
  }
}

/** 没有密文文件、或解不出（换机器/换 Windows 用户）都返回 null */
function decryptKey(getSS, dir) {
  try {
    const kp = keyPath(dir);
    const buf = fs.readFileSync(kp);
    const ss = typeof getSS === 'function' ? getSS() : null;
    if (!ss || !ss.isEncryptionAvailable()) return null;
    const key = ss.decryptString(buf) || null;
    if (key && kp.endsWith(LEGACY_KEY_FILE) && !fs.existsSync(primaryKeyPath(dir))) {
      try { writeFileAtomic(primaryKeyPath(dir), buf); } catch {}
    }
    return key;
  } catch {
    return null;
  }
}

function dropKeyFile(dir) {
  try { fs.unlinkSync(primaryKeyPath(dir)); } catch {}
  try { fs.unlinkSync(path.join(dir, LEGACY_KEY_FILE)); } catch {}
}

/** 从 config.json 里抹掉明文 apiKey（就地改文件） */
function stripPlainKey(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
    if (!raw || !('apiKey' in raw)) return false;
    delete raw.apiKey;
    writeJsonAtomic(cfgPath(dir), raw);
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
function saveConfig(getSS, dir, cfg, writeDisk, _hooks) {
  const kp = primaryKeyPath(dir);
  const cp = primaryCfgPath(dir);

  // 1. 保存前记录旧 Key 文件与 Config 文件状态快照
  const activeKp = keyPath(dir);
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
      const fd = fs.openSync(tmpKeyPath, 'w');
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
      const idx = tmpFiles.indexOf(tmpKeyPath);
      if (idx !== -1) tmpFiles.splice(idx, 1);
    } else {
      // 未加密或清空 key 时，删除可能残留的旧密文文件
      dropKeyFile(dir);
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
        writeFileAtomic(kp, oldKeyData);
      } else {
        dropKeyFile(dir);
      }
    } catch (rbErr) {
      console.error('[Rollback] 恢复旧 Key 文件失败:', rbErr.message);
    }

    // 回滚 Config 文件
    try {
      if (oldCfgExists && oldCfgData !== null) {
        writeFileAtomic(cp, oldCfgData);
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
  const disk = readDisk() || {};
  const fromKey = decryptKey(getSS, dir);
  if (fromKey) {
    if ('apiKey' in disk) stripPlainKey(dir);
    return { cfg: { ...disk, apiKey: fromKey }, encrypted: true };
  }
  const legacy = String(disk.apiKey || '');
  const noCipher = !fs.existsSync(keyPath(dir));
  if (legacy && noCipher && encryptKey(getSS, dir, legacy)
      && decryptKey(getSS, dir) === legacy) {
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
