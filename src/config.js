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
  // 实验标签/用户配置模型版本标识（如 'v3', 'r1', 'unavailable'），不是自动发现的真实版本
  modelVersion: 'unavailable',

  /* ---- 记忆窗口 ----
     V4.1 Flash 上下文上限 1M token（2026-10-05 实测确认：服务端回包 observedModel=deepseek-flash，
     官方文档 CONTEXT LENGTH 1M），所以窗口大小不是模型限制，
     纯粹是「多久破一次缓存」的权衡：
       windowTurns 越大 -> system 越久不变 -> 命中率越高，但单次请求越贵
       100 轮实测 ≈ 250 token/轮 × 100 ≈ 25K token 上下文，命中率能稳在 95%+（v0.9.9 实测校准） */
  windowTurns: 100,          // 每 100 轮关一次窗口并生成小结
  windowMaxTokens: 30000,    // 兜底：单窗口超此 token 也提前关窗（30K = 满 100 轮 + 裕度，让 windowTurns 成为真约束）
  keepTailMessages: 6,       // 关窗时保留最近 6 条原文，避免突然失忆
  memoryCapTokens: 12000,    // Prompt Memory 长期记忆预算（v3.1 扩容：基线 6000 → 12000），超了就把旧片段合并
  selfGrowthEnabled: true,   // 每个记忆窗口结束时，提炼一次主体成长证据
  selfLedgerMaxEntries: 200, // 只限制条目数量，不把旧经历覆盖成一个“最新人格”
  currentSelfTokenBudget: 9000, // 只注入最新 user 尾部的有限自我投影（v3.1 扩容：3000 → 9000）
  requestTimeoutMs: 60000,   // 请求总超时，避免网络卡住永久锁死界面
  streamIdleTimeoutMs: 20000,// SSE 长时间无新数据时主动中止
  // v0.9.9 P1-a: 发送前输出 token 预算（跨 retry 的最坏情况，见 budget-guard.assertBudget）。
  // 0 = 不设限，与既有行为完全一致；配置为正数后 budget-guard 在发送前 fail-closed。
  // 之前该键不在下面 sanitize 的白名单里，手写进 life-config.json 会被整份丢弃 ——
  // 于是 README 声称的「Budget Guard 发送前 fail-closed」在生产恒不可达。
  budgetMaxOutputTokens: 0,
  // v0.9.9 P0: 关窗小结 (分段 + WindowSynthesis) 的输出 token 上限。
  // 实测 43 轮窗口小结已用 3,923 token（4000 上限的 98%）——按满窗 100 轮预留 10000；
  // 硬编码 900 截断 JSON 触发 Fail-Stop 连败、4000 又濒临熔断，教训全在裕度上。
  summaryMaxTokens: 10000,
  // v0.9.9: 成长提炼 (GROWTH_SYS JSON 数组) 的输出上限。实测 420 与 1500 两度被撞顶腰斩、
  // self-ledger 空转（截断无声失败 ×3）；按紧凑纪律 + 最坏情况预留 4000。
  growthMaxTokens: 4000,

  // ---- 桌面自主运动 ----
  motionEnabled: true,
  // v1.0 D-6：Agent 提案触发源总开关。**默认关**（用户拍板，不可改）。
  //   沙盒写权限在 D-5 已打开，本开关是触发源接线的最后一道闸门。
  //   打开方式：把 life-config.json 里这一项改成 true（需同时在 sanitize 白名单里，见下）。
  agentTriggerEnabled: false,

  // 🔴 D-17：挂机基准与自发愿望阈值（分钟）。**默认值与既有常量完全一致**，
  //   抽成配置只为联调验证时能整体调小 —— 而**不必去动 trigger.js 里
  //   `idleMs >= idleNeed` 那道防骚扰铁律**（在那里开旁路会留下永久的洞）。
  //
  //   ⚠️ 调小 agentIdleMinutes 会让**普通挂机问候**也一并变频繁（验证期间可接受）。
  //   ⚠️ agentSelfNoteIdleMinutes 必须 >= agentIdleMinutes 才有意义
  //      （否则普通问候先触发、自发愿望永远排不上）。
  agentIdleMinutes: 30,
  agentSelfNoteIdleMinutes: 120,

  // 🔴 D-011（v1.2.y）：长期记忆「渐褪」的标定参数与出厂通电。
  //   决策依据（D-011 实测真实数据）：
  //   1. 活跃门限 0.50：确立三阶认知金字塔 —— ΔW 0-1 保持全文 ACTIVE（近景焦点），
  //      ΔW 2-5 保持 300 字句界主干 FADING（远景摘要），ΔW >= 6 沉入 DORMANT（潜意识），
  //      彻底克服 0.60 关窗腰斩与 0.40 FADING 塌缩成 1 窗窄缝的缺陷；
  //   2. 渐褪截断 300：配合 v1.2.x 句界截断，提供完整意思的印象速写；在默认 6000 预算下稳态占 38.5%~55.6%，
  //      彻底根除 0.40 在长文下飙至 147% 触发不可逆合并的重大风险；
  //   3. 存量用户显式配置优先，出厂默认变更仅惠及新装用户。
  memoryActiveThreshold: 0.50,
  memoryFadingMaxChars: 300,
  // 🔴 D-23：每条消息最多增强几条记忆印痕（召回 top-N）。0 = 关闭增强。
  //   默认 1 —— 一句话只加深最相关的那一段（注意力聚焦），防洪泛。
  memoryRecallTopN: 1,
  motionSpeed: 2,
  motionTickMs: 50,
  motionMargin: 20,

  // ---- v1.5-a: Provider 容灾自动回落 ----
  fallbackConnectionId: '',        // 空串 = 未配置备用
  fallbackFailureThreshold: 3,
  fallbackCooldownMs: 30000,

  // 单价（元/百万 token）。峰谷价不同，按你账单实际数字改这里。
  price: {
    peak:   { hit: 0.04, miss: 2, out: 8 },
    valley: { hit: 0.02, miss: 1, out: 4 }
  },

  // ---- 生命实验动力学体系 (Phase 0.5) ----
  experimentMode: 'experimental', // 'baseline' | 'experimental' | 'ablation' (v1.0.2 出厂默认启用实验模式通电)
  experimentModules: {
    homeostasis: false,
    internalRegulation: true,  // v1.0.2 通电：正典生命代谢节律出厂默认启用
    digitalUmwelt: false,
    attentionGate: false,
    biographicalCanalization: false,
    memoryDynamics: true,      // v1.2.y D-011 通电：出厂默认启用长期记忆三阶动力学梯度
    sleepConsolidation: true   // v2.0 拍板：真睡眠开梦（baseline 仍关；显式 false 可关）
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

/** 🔴 丙：有界浮点数（与 finiteInt 同款语义，但不要求是整数）。
 *  用于 activeThreshold 这类 0~1 之间的小数配置 ——
 *  finiteInt 会把 0.4 判成非整数而回落默认值，用它是个隐蔽的错。 */
function finiteNumber(v, fallback, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
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
    modelVersion: typeof raw.modelVersion === 'string' && raw.modelVersion.trim() ? raw.modelVersion.trim() : DEFAULTS.modelVersion,
    windowTurns: finiteInt(raw.windowTurns, DEFAULTS.windowTurns, 1, 100000),
    windowMaxTokens: finiteInt(raw.windowMaxTokens, DEFAULTS.windowMaxTokens, 256, 10000000),
    keepTailMessages: finiteInt(raw.keepTailMessages, DEFAULTS.keepTailMessages, 0, 1000),
    memoryCapTokens: finiteInt(raw.memoryCapTokens, DEFAULTS.memoryCapTokens, 64, 1000000),
    selfGrowthEnabled: raw.selfGrowthEnabled !== false,
    selfLedgerMaxEntries: finiteInt(raw.selfLedgerMaxEntries, DEFAULTS.selfLedgerMaxEntries, 20, 2000),
    currentSelfTokenBudget: finiteInt(raw.currentSelfTokenBudget, DEFAULTS.currentSelfTokenBudget, 256, 10000),
    requestTimeoutMs: finiteInt(raw.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 5000, 600000),
    streamIdleTimeoutMs: finiteInt(raw.streamIdleTimeoutMs, DEFAULTS.streamIdleTimeoutMs, 2000, 120000),
    // v0.9.9 P1-a: 补进白名单，手写配置才真的生效（此前会被 sanitize 整份丢弃）
    budgetMaxOutputTokens: finiteInt(raw.budgetMaxOutputTokens, DEFAULTS.budgetMaxOutputTokens, 0, 10000000),
    // v0.9.9 P0: 同上教训，补进白名单手写配置才生效
    summaryMaxTokens: finiteInt(raw.summaryMaxTokens, DEFAULTS.summaryMaxTokens, 256, 100000),
    growthMaxTokens: finiteInt(raw.growthMaxTokens, DEFAULTS.growthMaxTokens, 256, 100000),
    motionEnabled: raw.motionEnabled !== false,
    // v1.0 D-6：Agent 提案触发源总开关。**默认关**（用户拍板，不可改）。
    // 🔴 这里刻意**不**用 `!== false` 那套写法：本开关键缺失时必须安全（=关），
    //   而 `!== false` 会把「键缺失」当成 true，等于升级即默认开启。
    //   沙盒写权限在 D-5 已经打开，若触发源默认开着，装好即生效——那不是默认该有的姿态。
    // ⚠️ 必须同时加进 DEFAULTS 与本白名单，只加 DEFAULTS 等于没加：
    //   不在 sanitize 白名单里的键，手写进 life-config.json 会被整份丢弃（见上方 :54 注释）。
    agentTriggerEnabled: raw.agentTriggerEnabled === true,
    // D-17：上下界防手滑（1 分钟 ~ 24 小时）。越界即回落默认，不静默接受。
    agentIdleMinutes: finiteInt(raw.agentIdleMinutes, DEFAULTS.agentIdleMinutes, 1, 1440),
    agentSelfNoteIdleMinutes: finiteInt(raw.agentSelfNoteIdleMinutes, DEFAULTS.agentSelfNoteIdleMinutes, 1, 1440),
    // 丙：强度门限 0~1；渐褪截断字数 20~4000（下界保证「能读出一件事」，上界防它退化成全文投影）
    memoryActiveThreshold: finiteNumber(raw.memoryActiveThreshold, DEFAULTS.memoryActiveThreshold, 0.05, 0.99),
    memoryFadingMaxChars: finiteInt(raw.memoryFadingMaxChars, DEFAULTS.memoryFadingMaxChars, 20, 4000),
    memoryRecallTopN: finiteInt(raw.memoryRecallTopN, DEFAULTS.memoryRecallTopN, 0, 5),
    motionSpeed: finiteInt(raw.motionSpeed, DEFAULTS.motionSpeed, 1, 20),
    motionTickMs: finiteInt(raw.motionTickMs, DEFAULTS.motionTickMs, 30, 250),
    motionMargin: finiteInt(raw.motionMargin, DEFAULTS.motionMargin, 0, 200),
    // v1.5-a: Provider 容灾自动回落配置清洗
    fallbackConnectionId: typeof raw.fallbackConnectionId === 'string' ? raw.fallbackConnectionId.trim() : DEFAULTS.fallbackConnectionId,
    fallbackFailureThreshold: finiteInt(raw.fallbackFailureThreshold, DEFAULTS.fallbackFailureThreshold, 1, 100),
    fallbackCooldownMs: finiteInt(raw.fallbackCooldownMs, DEFAULTS.fallbackCooldownMs, 1000, 3600000),
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
        // v1.2.y：与 DEFAULTS.experimentMode 对齐 —— 此前这里硬编码推导 baseline，
        //   导致 DEFAULTS.experimentMode 成为只写不读的死配置，改它对新装用户零效果。
        //   新语义：配置里没有任何模块显式开启时，回落到 DEFAULTS 声明的出厂模式。
        const hasAnyActive = Object.values(rawModules).some(v => v === true);
        const fallbackMode = validModes.includes(String(DEFAULTS.experimentMode).trim().toLowerCase())
          ? String(DEFAULTS.experimentMode).trim().toLowerCase()
          : 'baseline';
        experimentMode = hasAnyActive ? 'experimental' : fallbackMode;
      }

      const isBaseline = experimentMode === 'baseline';
      // v1.2.y：缺省键继承 DEFAULTS（而非硬编码 false），显式 false 仍保留 false。
      //   - 缺省键 ⇒ 用户从没表过态 ⇒ 应吃出厂默认姿态
      //   - 显式 false ⇒ 用户或 ablation 明确关闭 ⇒ 必须尊重，绝不覆盖
      //   ⚠️ sleepConsolidation 原本就是 `!== false` 语义（缺省视为 true），
      //      改造后与其余模块统一，但**必须用 DEFAULTS 里的值兜底**，
      //      不能直接写成 Boolean(undefined) —— 那会把出厂默认 from true 变 false。
      const pick = (key) => {
        if (isBaseline) return false;
        if (Object.prototype.hasOwnProperty.call(rawModules, key)) return Boolean(rawModules[key]);
        return Boolean(DEFAULTS.experimentModules && DEFAULTS.experimentModules[key]);
      };
      const experimentModules = {
        homeostasis: pick('homeostasis'),
        internalRegulation: pick('internalRegulation'),
        digitalUmwelt: pick('digitalUmwelt'),
        attentionGate: pick('attentionGate'),
        biographicalCanalization: pick('biographicalCanalization'),
        memoryDynamics: pick('memoryDynamics'),
        sleepConsolidation: pick('sleepConsolidation')
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
  delete disk.writingMode; // v0.9.9: 旧字段静默淘汰 —— 旧配置读取兼容，保存永不写回
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
