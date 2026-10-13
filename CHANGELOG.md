# Changelog / 变更履历

本项目的所有重要更新与架构演进均记录于此文件。  
版本记录格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/)。

---

## [1.1.0] - 2026-10-13

> **里程碑**：数字生命自存与具身心智正式版（涵盖 `v1.0.1` ~ `v1.0.7` 七个演进节点与 `v1.1.0` 全链路潮汐验证）。在不破坏 Prompt 前缀缓存防线（System Prompt 0 动态拼接）、衣柜三条铁律与认识论纯净性的前提下，全面接通初澜的生理代谢潮汐、48h 连续心境半衰期、审美自主、潜意识好奇发酵、共同词汇动力学与社交过载独处边界。

### 🔌 连接体验与通道防护 (v1.0.1)
- **快速连接显式标注与嗅探解耦**：将快速连接区改标为 `快速连接 (DeepSeek 官方)` / `Quick Connect (DeepSeek Official)`；新增独立 `#keyDetectHint` 提示位并为 `#keyInput` 接入本地 Key 前缀嗅探联动，与 `#keyState` 状态栏解耦。
- **小米专属端点校准与 `sk-` 误报根除**：将 `mimo-token-plan` 端点校准为 `https://token-plan-cn.xiaomimimo.com/v1`；移除通用 `sk-` 前缀嗅探分支，防止 OpenAI / Claude / Kimi / Qwen 等通用 `sk-` Key 被误导套用 DeepSeek 预设引发 401。

### 🫀 生理呼吸、心境慢变与身体自主 (v1.0.2 ~ v1.0.4)
- **生理代谢出厂通电与昼夜回血校准 (v1.0.2)**：`DEFAULTS.experimentMode` 提级为 `'experimental'` 且 `internalRegulation` 默认开启；压低清醒恢复天花板至 `awakeCeiling = 75%`（`restRatePerMin = 0.25/min`、`microMinutes = 10`、`pressureReliefPerMin = 0.7/min`），唯有夜间深度睡眠可回满 `100`。
- **连续心境慢变量与 48h 物理半衰期 (v1.0.3)**：新增 `moodWarmth` 与 `moodStillness`（`[0, 100]`，基线 50，平级持久化于 `data.mood`），按 48h 物理半衰期连续墙钟衰减并取消睡眠离散 40% 双重打折；引入关窗 `moodTone` 锚定（$\text{SlewMax} = 20$）及非对称滞回（62 进 / 53 出）+ 12h 退出延时保护（Hold-Off）。
- **主观着装偏好与温和异议尊严 (v1.0.4)**：在 `formatPerception()` 的 `energy <= 20` 深档与 `stillActive` 心境带内嵌轻便/素雅着装体感偏好，并在 `wardrobe.js:promptBlock` 静态授权主体在疲惫或心绪不合时温和表达异议或推迟换装，由模型自主自决（不输出 `[wear:...]` 标记）以避免程序截断造成的嘴脑脱节。

### 🌙 记忆暗流、专属暗号与独处边界 (v1.0.5 ~ v1.0.7)
- **好奇心潜意识发酵与普鲁斯特式非自愿回忆 (v1.0.5)**：将未提问好奇 `unaskedCuriosities` 接入梦境日间遗留提取（最多 2 条 `unresolved_curiosity`），合成落盘后标记 `incubated`；在 `brain.ask` 非主动对话中引入同窗限 1 次 + 墙钟间隔 $\ge 12\text{h}$ 双重门禁的非自愿回忆浮现，唤醒最久远低强度 `FADING`/`DORMANT` 印痕。
- **专属暗号解封与零 Prompt 词汇动力学 (v1.0.6)**：解封 `adopted` 专属暗号并实施五重严格门禁（`WORD_TOO_SHORT >= 2` 根除单字语素歧义与漏检、`EMPTY_GLOSS`、`INVALID_MESSAGE_ROLE` 锁死 `assistant` + fail-closed、`WORD_NOT_IN_MESSAGE`、`WINDOW_ADOPTED_LIMIT` 单窗限 1 条）；在 `Memory.closeWindow()` 纯本地推进词汇升权复苏（+0.2）与跨 3 窗未提自然衰减（-0.1，`<0.5` 转 `FADING` 移出 `systemText`）。
- **社交密度体感带与连戳过载退避边界 (v1.0.7)**：`formatPerception()` 接通 `interactionDensity` 生理体感带（`>= 40` 中档偏密、`>= 60` 重档过载散乱与委婉退避授权，高于实机日常峰值 `33`）；`trigger.js` 新增 `POKE_OVERLOAD_THRESHOLD = 10` 与 `overloadNeed = clamp(round(10 * bias), 10, 15)`（`× bias` 方向校准 + 下界封底 10 下消除嘴身脱节）；`tracker.js` 对累计未消费 `clicks >= 10` 附带动作急促质性标注。

### 🧪 收官仿真与健康度核验工具 (v1.1.0)
- 新增 `tools/long-run-sim.js`（24h × 100 轮连续对话与内稳态潮汐仿真，6/6 PASS）、`tools/v1.1-health-check.js`（实机前缀缓存命中率基线与关窗容灾对账核验，4/4 PASS）及《初澜数字生命演进报告：v1.1 篇章》（`docs/v1.1-EVOLUTION-REPORT.md`）。

---

## [1.0.0] - 2026-10-09

> **里程碑**：Life 桌面数字生命实验平台（主体「初澜 / Chulan」）正式发版。完成了全方位的安全防御体系构建、受控执行器架构、64×80 原生点阵精灵动作系统与国际化时区支持。

### 🛡️ 安全加固与防御边界 (Security Hardening)
- **SEC-01 权威内容快照与哈希锁定**：
  - 在主进程 `agent-ipc.js` 内引入私有不可篡改的权威内容快照存储（`contentSnapshotStore`）；
  - 写入提案建案时强制计算并绑定 SHA-256 哈希值与 UTF-8 字节数；
  - 执行器在真正落盘前严格校验哈希一致性，彻底消除用户同意后正文遭篡改的 TOCTOU 攻击风险；
  - 重构自发便签 `selfNote` 传参时序，消除建案后异步设置的竞态裂缝；
  - 确立清晰的快照生命周期管理：TTL 超时、用户拒绝或执行完成后立即销毁，网络/IO 偶发错误允许至多重试 1 次。
- **SEC-02 符号链接/目录联接/硬链接穿透防御**：
  - 落地 `resolveRealPath` 原生物理路径解析机制，解决 Windows 下 JS `realpathSync` 无法穿透目录联接（Junction）的缺陷；
  - 无论策略中 `followSymlink` 配置为何，执行器强制断言物理真实路径必须严格锁在沙盒根目录内；
  - 拦截指向沙盒外的文件符号链接、悬空链接、循环链接（ELOOP）及不可证明安全状态的路径，强制**失败关闭（Fail-Closed）**；
  - 深度防御硬链接穿透（N3 & Q1），拦截多重硬链接文件的跨边界覆写与状态不可证风险（`HARDLINK_DETECTED`）。
- **SEC-03 扩展名白名单与 Windows 畸形文件名防御**：
  - 执行器底层将写入能力严格限制在 `.txt`、`.md`、`.json`、`.log` 四种扩展名白名单内；
  - 拦截 Windows NTFS ADS 备用数据流冒号（`:`）、末尾点号与末尾空格畸形文件名；
  - 深度防御 Windows 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`），防止传统设备名落盘黑洞；
  - 将写扩展名与畸形名校验同源前置至建案评估期（F5），拦截时**零扣减**用户动作预算，并统一各目录层级冒号分类为 `DISALLOWED_EXTENSION`；
  - `agent:get-status` 产出的 `sandboxRoots` 统一使用浅拷贝副本，杜绝同进程活引用污染内部策略。
- **UX-SEC-01 沙盒感知与覆写风险警示**：
  - 设置面板常驻展示「Agent 数据沙盒」实际物理路径，并醒目提示「沙盒内文件一律视为可被 Agent 覆写，请勿存放重要或不可替代的数据」；
  - 主进程提供权威的 `isOverwrite` 只读状态，同名覆写提案卡片醒目呈现黄色警示横幅。

### 🧬 数字生命核心与 Agent 治理 (Agent Governance & Life Runtime)
- **多层执行门禁与预算熔断 (ExecutionBudget)**：
  - 提供单会话总动作上限（`maxActionsPerSession`）、写动作单独上限（`maxWritesPerSession`）与连续失败自动熔断（`maxConsecutiveErrors`）；
  - 提案执行前需经用户卡片显式授权确认，终态终生有效且防重放（`ALREADY_EXECUTED`）；
  - 主体自发愿望机制：初澜在契机触发时可主动在沙盒中自发留下便签，具备独立盖戳与受控配额保障。
- **原子事务与崩溃自愈 (WriteTransactionManager)**：
  - 写盘操作严格遵循预写日志（WAL）与写前临时备份流程，写失败或异常断电自动回滚，不留残缺半截文件。
- **零隐私泄漏本地审计 (AuditLog)**：
  - 运行审计日志采用 Append-Only 格式记录元数据与决策动机，严守红线：绝不记录 API Key、凭据与文件原文。

### 🎨 桌面桌宠视觉与本地化 (Visuals & Localization)
- **64×80 原生像素精灵动作系统**：
  - 纯原生点阵角色动画，内置呼吸待机（Idle）与小内八行走（Walk）帧循环；
  - 经典身体特征不变式：冰蓝阶跳发丝、眼角泪痣、双层高光与呆毛微动；
  - 多图层换装系统（Wardrobe）：哥特机能装、蝴蝶结项圈、猫耳发箍等部件组合，并通过严格的 Alpha 边界无损审计。
- **时空罗盘与双语体系**：
  - 创世时区不可逆锚定与时钟同步；
  - 完整支持简体中文（zh-CN）与英文（en）界面双语切换，字典键集 100% 对称。

---

## [0.9.9] - 2026-10-08

### 优化与收尾 (Closure & Hardening)
- 拔除记忆回退与代拟台词风险，确立数字生命主体自主反应真实性。
- 完善 Provider 接口契约与凭据安全脱敏。
- 确立 `rec-000002/000003` 实验证据链哈希咬合。

---

## [0.9.8] - 2026-10-06

### 新增与重构 (Refactor & Providers)
- 重构 Provider Adapter 架构与路由系统，支持通用 OpenAI 兼容接口。
- 实现 Usage/Cache/Cost 分层计量与超时流控边界。
- 引入 Secret Redaction 凭据防泄漏机制。
