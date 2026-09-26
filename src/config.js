const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');

const { migrate } = require('./migration');

/**
 * 配置存在 userData 目录，不放在项目里 —— 避免连 key 一起被打包或提交。
 */

const CONFIG_MIGRATIONS = {
  1: (raw) => {
    const d = { ...(raw || {}) };
    if (!d.configVersion) d.configVersion = '1.0.0';
    return d;
  }
};

function migrateConfig(raw) {
  if (!raw || typeof raw !== 'object') return { data: raw, migrated: false, fromVersion: 0 };
  return migrate(raw, 1, CONFIG_MIGRATIONS, { versionKey: 'schemaVersion' });
}

const DEFAULTS = {
  schemaVersion: 1,
  configVersion: '1.0.0',
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  provider: 'deepseek',
  credentialType: 'deepseek-api-key',
  // 官方 API 模型名。V4.1 Flash 对应的就是 deepseek-flash，
  // 写成 deepseek-v4.1-flash 可能报模型不存在，以你控制台看到的为准。
  model: 'deepseek-flash',

  /* ---- 记忆窗口 ----
     V4.1 Flash 上下文上限 1M token，所以窗口大小不是模型限制，
     纯粹是「多久破一次缓存」的权衡：
       windowTurns 越大 -> system 越久不变 -> 命中率越高，但单次请求越贵
       100 轮 ≈ 4000~8000 token 上下文，命中率能稳在 95%+  */
  windowTurns: 100,          // 每 100 轮关一次窗口并生成小结
  windowMaxTokens: 8000,     // 兜底：单窗口超此 token 也提前关窗
  keepTailMessages: 6,       // 关窗时保留最近 6 条原文，避免突然失忆
  memoryCapTokens: 6000,     // Prompt Memory 长期记忆预算（基线 6000），超了就把旧片段合并
  selfGrowthEnabled: true,   // 每个记忆窗口结束时，提炼一次主体成长证据
  selfLedgerMaxEntries: 200, // 只限制条目数量，不把旧经历覆盖成一个“最新人格”
  currentSelfTokenBudget: 3000, // 只注入最新 user 尾部的有限自我投影
  writingMode: false,        // 只在用户主动打开时注入成人向虚构小说 Skill
  requestTimeoutMs: 60000,   // 请求总超时，避免网络卡住永久锁死界面
  streamIdleTimeoutMs: 20000,// SSE 长时间无新数据时主动中止

  // ---- 桌面自主运动 ----
  motionEnabled: true,
  motionSpeed: 2,
  motionTickMs: 50,
  motionMargin: 20,

  // 单价（元/百万 token）。峰谷价不同，按你账单实际数字改这里。
  price: {
    peak:   { hit: 0.04, miss: 2, out: 8 },
    valley: { hit: 0.02, miss: 1, out: 4 }
  },

  // ---- 生命实验动力学体系 (Phase 0.5) ----
  experimentMode: 'baseline', // 'baseline' | 'experimental' | 'ablation'
  experimentModules: {
    homeostasis: false,
    internalRegulation: false,
    digitalUmwelt: false,
    attentionGate: false,
    biographicalCanalization: false,
    memoryDynamics: false,
    sleepConsolidation: false
  }
};

const CONFIG_FILE = 'life-config.json';
const LEGACY_CONFIG_FILE = 'gpt-girl-config.json';

function file(dir) {
  const primary = path.join(dir, CONFIG_FILE);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(dir, LEGACY_CONFIG_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

function primaryFile(dir) {
  return path.join(dir, CONFIG_FILE);
}

function finiteInt(v, fallback, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function finiteNonNegative(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* 手改配置仍然支持，但坏类型不能直接流入 Brain。 */
function sanitize(raw = {}) {
  const { providerFor, validateCredentialTarget } = require('./provider-policy');
  const price = raw.price && typeof raw.price === 'object' ? raw.price : {};
  const peak = price.peak && typeof price.peak === 'object' ? price.peak : {};
  const valley = price.valley && typeof price.valley === 'object' ? price.valley : {};
  let baseURL = typeof raw.baseURL === 'string' && /^https?:\/\//i.test(raw.baseURL)
    ? raw.baseURL.trim() : DEFAULTS.baseURL;

  const rawProvider = raw.provider || providerFor(baseURL);
  const rawCredType = raw.credentialType || (rawProvider === 'deepseek' ? 'deepseek-api-key' : 'apiKey');
  const policy = validateCredentialTarget({ provider: rawProvider, baseURL, credentialType: rawCredType });

  let provider = DEFAULTS.provider;
  let credentialType = DEFAULTS.credentialType;
  if (policy.ok) {
    provider = policy.provider;
    credentialType = policy.credentialType;
  } else {
    console.warn('[Config] Provider policy validation failed:', policy.error, 'reverting to default');
    baseURL = DEFAULTS.baseURL;
    provider = DEFAULTS.provider;
    credentialType = DEFAULTS.credentialType;
  }

  return {
    ...DEFAULTS,
    schemaVersion: finiteInt(raw.schemaVersion, DEFAULTS.schemaVersion, 1, 100),
    configVersion: typeof raw.configVersion === 'string' && raw.configVersion.trim() ? raw.configVersion.trim() : DEFAULTS.configVersion,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULTS.apiKey,
    baseURL,
    provider,
    credentialType,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULTS.model,
    windowTurns: finiteInt(raw.windowTurns, DEFAULTS.windowTurns, 1, 100000),
    windowMaxTokens: finiteInt(raw.windowMaxTokens, DEFAULTS.windowMaxTokens, 256, 10000000),
    keepTailMessages: finiteInt(raw.keepTailMessages, DEFAULTS.keepTailMessages, 0, 1000),
    memoryCapTokens: finiteInt(raw.memoryCapTokens, DEFAULTS.memoryCapTokens, 64, 1000000),
    selfGrowthEnabled: raw.selfGrowthEnabled !== false,
    selfLedgerMaxEntries: finiteInt(raw.selfLedgerMaxEntries, DEFAULTS.selfLedgerMaxEntries, 20, 2000),
    currentSelfTokenBudget: finiteInt(raw.currentSelfTokenBudget, DEFAULTS.currentSelfTokenBudget, 256, 10000),
    writingMode: raw.writingMode === true,
    requestTimeoutMs: finiteInt(raw.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 5000, 600000),
    streamIdleTimeoutMs: finiteInt(raw.streamIdleTimeoutMs, DEFAULTS.streamIdleTimeoutMs, 2000, 120000),
    motionEnabled: raw.motionEnabled !== false,
    motionSpeed: finiteInt(raw.motionSpeed, DEFAULTS.motionSpeed, 1, 20),
    motionTickMs: finiteInt(raw.motionTickMs, DEFAULTS.motionTickMs, 30, 250),
    motionMargin: finiteInt(raw.motionMargin, DEFAULTS.motionMargin, 0, 200),
    price: {
      peak: { hit: finiteNonNegative(peak.hit, DEFAULTS.price.peak.hit), miss: finiteNonNegative(peak.miss, DEFAULTS.price.peak.miss), out: finiteNonNegative(peak.out, DEFAULTS.price.peak.out) },
      valley: { hit: finiteNonNegative(valley.hit, DEFAULTS.price.valley.hit), miss: finiteNonNegative(valley.miss, DEFAULTS.price.valley.miss), out: finiteNonNegative(valley.out, DEFAULTS.price.valley.out) }
    },
    ...(() => {
      const validModes = ['baseline', 'experimental', 'ablation'];
      const rawModules = raw.experimentModules && typeof raw.experimentModules === 'object' ? raw.experimentModules : {};
      let experimentMode = typeof raw.experimentMode === 'string' && validModes.includes(raw.experimentMode.trim().toLowerCase())
        ? raw.experimentMode.trim().toLowerCase()
        : null;

      if (!experimentMode) {
        const hasAnyActive = Object.values(rawModules).some(v => v === true);
        experimentMode = hasAnyActive ? 'experimental' : 'baseline';
      }

      const isBaseline = experimentMode === 'baseline';
      const experimentModules = {
        homeostasis: isBaseline ? false : Boolean(rawModules.homeostasis),
        internalRegulation: isBaseline ? false : Boolean(rawModules.internalRegulation),
        digitalUmwelt: isBaseline ? false : Boolean(rawModules.digitalUmwelt),
        attentionGate: isBaseline ? false : Boolean(rawModules.attentionGate),
        biographicalCanalization: isBaseline ? false : Boolean(rawModules.biographicalCanalization),
        memoryDynamics: isBaseline ? false : Boolean(rawModules.memoryDynamics),
        sleepConsolidation: isBaseline ? false : Boolean(rawModules.sleepConsolidation)
      };

      return { experimentMode, experimentModules };
    })()
  };
}

/**
 * 缓存只用来「读不到时兜底」，不用来「少读一次盘」。
 *
 * 改之前的样子：模块级单一 `let cached`，谁先到谁永久占位。两个真实代价：
 *   1. 换目录读会拿到上一个目录的配置 —— 测试里两个 tmpDir 必踩
 *      （secure.test.js 就是因此被迫绕过 load、自己读文件才敢信"磁盘真相"）；
 *   2. 用户手改 gpt-girl-config.json 不生效 —— README 明确引导他去改这个文件
 *      调价格和窗口大小，改完却要重启，属于文档和实现互相打脸。
 *
 * 现在每次 load 都真的读盘。为什么不加"mtime 变了才重读"这层快取：
 * 实测同一毫秒内两次写入，mtimeMs 和 size 都完全相同
 * （`{model:'two-with-longer-text'}` → `{model:'two-with-longer-tex2'}`
 * 都是 32 字节、mtimeMs 一字不差），也就是说带 size 的键仍然会漏掉一次真实修改。
 * 而"缓存失效判断不可靠"正是第 9 条要修的病根 —— 用一个不可靠的判断去修它，
 * 症状一模一样，只是更难复现。配置文件几百字节，load 一年也调不了几次
 * （启动一次、设置面板打开一次），没有省这一口的必要。
 *
 * 那这个 Map 留着的唯一理由：瞬时读失败（EPERM/EACCES/EBUSY —— 占用、
 * 移动盘没就绪）时文件内容是好的，此刻退回 DEFAULTS 的话，
 * 紧跟着任何一次 save 就把用户的配置文件写成出厂值 ——
 * 一次瞬时故障升级成「配置被重置」。这时返回上一次成功读到的那份。
 *
 * Key 用 realpath 而不是原字符串：同一个 userData 可能被不同写法抵达
 * （尾斜杠、`..`、软链接、Windows 的 8.3 短路径），不合并的话一份写进去、
 * 另一份还兜着旧值。normalize 挡不住软链接，realpath 可以；
 * 目录还不存在时它抛错，退回 normalize 的结果。
 */
const lastGood = new Map();                 // realPath -> cfg（只在读成功时更新）

function realKey(dir) {
  try { return fs.realpathSync(dir); } catch { return path.normalize(dir); }
}

/**
 * 读盘，失败时返回 null 而不是 DEFAULTS。
 *
 * 存在的意义：热重载需要一个"这次真的读到了"的信号。
 * 用户在编辑器里改配置，改到一半必然是语法错误 —— 这时若把 DEFAULTS
 * 当成"最新配置"应用进正在运行的对象，窗口参数会当场跳回出厂值，
 * 表现成"我改了个错别字，桌宠的对话窗口突然变了"。读不到就保持现状。
 */
function tryLoad(userDataDir) {
  const rk = realKey(userDataDir);
  try {
    const primary = primaryFile(userDataDir);
    const legacy = path.join(userDataDir, LEGACY_CONFIG_FILE);
    let target = primary;
    let fromLegacy = false;
    if (fs.existsSync(primary)) {
      target = primary;
    } else if (fs.existsSync(legacy)) {
      target = legacy;
      fromLegacy = true;
    }
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const { data } = migrateConfig(raw);
    const cfg = sanitize(data);
    // Legacy 兼容自动迁移：检测到 gpt-girl-config.json 时自动落地写入 life-config.json
    if (fromLegacy && !fs.existsSync(primary)) {
      try {
        writeJsonAtomic(primary, data);
      } catch {}
    }
    lastGood.set(rk, cfg);
    return cfg;
  } catch (e) {
    // 占用/权限类：内容没坏，别丢掉已知好的那份
    if (e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY')) {
      const prev = lastGood.get(rk);
      if (prev) return prev;
    }
    // 文件不存在（首次运行）/ JSON 被改坏：返回 null，由调用方决定怎么兜。
    // 注意不写 lastGood —— 兜底值不该被当成"上一次成功读到的配置"再传下去。
    return null;
  }
}

function load(userDataDir) {
  return tryLoad(userDataDir) || sanitize(DEFAULTS);
}

/**
 * 写盘。diskOverride 存在时，**落盘只写 override**。
 * 这是 apiKey 加密改造的接缝：明文 key 留在调用方内存里给运行时用，
 * 文件里那份交给 src/secure.js 处理（密文文件或降级明文）。
 * 不新增第二个写文件函数，是为了避免以后有人绕过 override 直接落盘。
 *
 * 不传 override 时也不能把内存里那份整个写出去 —— 它可能带着明文 key
 * （set-key 之后），而 config.json 是用户会被引导去手改的文件，
 * 下次任何一次裸 save 都会把 key 重新塞回明文。所以从源头摘掉。
 *
 * 返回值是「落盘内容 + DEFAULTS 补齐」的对象，不是传进来的 cfg：
 * 调用方拿去当本轮生效配置用，与下一次 load() 读到的完全一致。
 * 顺带更新 lastGood —— 刚写进去的内容就是"已知好的那份"。
 */
function save(userDataDir, cfg, diskOverride) {
  const { apiKey, ...rest } = cfg;
  const disk = diskOverride === undefined ? rest : diskOverride;
  writeJsonAtomic(primaryFile(userDataDir), disk);
  const written = sanitize(disk);
  lastGood.set(realKey(userDataDir), written);
  return written;
}

/** 只给测试用：清掉兜底缓存，用来证明「真的是从盘上读出来的」 */
function _clearCache() { lastGood.clear(); }

module.exports = {
  load,
  tryLoad,
  save,
  DEFAULTS,
  sanitize,
  _clearCache,
  migrateConfig,
  CONFIG_MIGRATIONS,
  CONFIG_FILE,
  LEGACY_CONFIG_FILE
};
