# Changelog / 变更履历

本项目的所有重要更新与架构演进均记录于此文件。  
版本记录格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/)。

---

## [1.8.0] - 2026-10-27

> **相比上一个公开版本 v1.6.1**，本版新增四项能力、修掉若干缺陷。
> 以下按功能线归纳，不逐笔罗列提交。

### 🎙 新增：语音输入（STT）

- **说句话就能输入**：点麦克风开始、再点结束，识别结果只写进输入框，**绝不自动发送**
  （自动发送等于程序替用户按回车，会污染对话事实链）。
- **传输层与对话链路物理隔离**：DeepSeek 官方没有 STT 端点，复用对话 Key 只会让用户在
  401/404 上困惑。故走 OpenAI Whisper 兼容协议，厂商差异全交给配置
  （硅基流动 / Groq / OpenAI 官方 / 本地 whisper.cpp 四家预设）。
- **零新增依赖**：用 Node 24 原生 `FormData` + `Blob` + `fetch`。
- **音频绝不落盘、绝不记录内容**；超过 25MB 直接拒而不截断（截断会让识别变形）。
- **麦克风权限闸门**：本仓此前没有任何 `setPermissionRequestHandler`，
  等于把麦克风/通知/地理位置的授权交给 Electron 默认行为。本版补上显式闸门。

### 📊 新增：个体观测面板

- 此前 `life-mechanisms` 是**手写 6 组字段**、渲染层是**手写渲染**，
  于是 v1.1~v1.6 陆续落地的机制（心境、互动密度、认知负荷、知觉事件水位线、
  主动开口偏置、好奇队列、自发便签、观察日记、印痕分层、熔断状态、执行预算、审计条数）
  **全都算出来了却从来没被看见**。
- 本版改为**声明式注册表**：新增机制只注册一行，主进程与渲染层两端自动跟上。
- 面板拆成「主体状态」与「机制遥测」两个子标签，遥测按组折叠、默认收起。
- 🔴 三条铁律各有断言：**只读**（连读两次逐字节相等，避免观察者效应污染实验）、
  **不造假**（空上下文返回 null 而不是 0）、**不外泄**（便签/日记只报条数与状态，
  正文与文件名绝不进 payload）。

### 🌙 新增：重逢心境（主观时间）

- 她要知道「你离开了多久」。这是**跨重启、跨休眠**的事实，不是会话内计时。
- 🔴 核心设计：**重逢是关系事件，不是进程事件**。桌宠常驻（关对话窗是 hide 不销毁），
  绑「应用启动」会让这功能几乎永不触发；正确触发点是「你下次开口说话时回头检查」。
- **只陈述时长，绝不推断作息**：不知道你是睡觉、通宵还是出差，
  禁句表含 睡 / 通宵 / 等 / 终于 / 寂寞 / 想你。
- 三级刻度：6–24h 用小时、1–7d 用天+小时、≥7d 只用天
  （「168 小时」听起来像倒计时报警）。
- **一次性消费**：同一次离开只说一次。

### 👁 新增：屏幕视觉探针（框选）

- 右键菜单「看看这个…」→ 全屏框选 → 拖框 → 她真的能看见你选的那块屏幕。
- 🔴 **隐私铁律**：只做**用户框选**，绝不截全屏/活动窗口；绝不后台定时截屏；
  **图不落盘、不进历史、不进经历**；审计只记尺寸/耗时/成败，不记像素与 OCR 文本。
- **能力判定逐模型做**：`deepseek-flash` 支持图片输入，`deepseek-v4-pro` **不支持**，
  无法识别的模型名一律保守拒绝 —— 宁可少看，也绝不假装看过。
- 无 vision 能力时**显式失败**（MODEL_HAS_NO_VISION），不静默丢图后继续回答。
- 待发送的截图在对话窗有预览条，可以看见、可以取消。

### 🐛 修复

- **视觉事实行错位一轮**（本版审核发现）：带图那一轮模型收不到「看到多大一块」，
  下一轮没图却收到上一轮尺寸 —— 等于**诱导编造看到了什么**。根因是赋值晚于取值。
- **CSV 导出公式注入防护**：`=cmd|' /C calc'!A1` 这类载荷原本原样落盘，
  Excel / WPS 打开即执行。现已对危险前缀前置单引号，**只加前缀不清洗原文**（数据不伪造）。
- **对话窗输入栏压住她的回话**。
- **框选窗两次返工**：初版遮罩画在主窗里框不到屏幕；改为独立全屏窗后又遇到
  IPC 信任白名单与 `destroy()` 卡死进程两个致命 bug。
- **框选窗 IPC 权限过宽**（本版审核发现）：校验粒度是「通道是否可信」而非
  「这个窗口能不能调这个通道」，于是框选窗虽在信任白名单内，实际能调 59 个通道
  中的任意一个（含 `config-set-key` / `connections:delete` / `agent:execute`）。
  现已收窄到精确四通道（capture / stage / close-picker / notify），
  并换成只暴露这四条通道的专用最小权限 preload。
- **语音识别配置写入失败会静默回退**：原子写失败后原本退化成普通覆盖写，
  中断可能留下损坏 JSON。现已改为如实返回失败并在设置界面提示中英文文案。

### 🔧 工具与门禁

- **产物新鲜度门禁**：让「代码修了、包没重打」不再是盲区（v1.6.0 就栽在这上面 ——
  已发布的包里一个修复都没有，而所有测试全绿）。
- **公开发布剥离门禁**：公开集内零开发机绝对路径、零凭据、零断链、零未分类文件。
- 测试套件 **135 个**（134 个 Node 套件 + 1 个 Python UI 套件），断言 **4849 项**，全绿。

### ⚠️ 已知限制（不粉饰）

- **v1.7 未单独发布**，其内容已并入本版。
- **观测面板的数值正确性未逐项核对**：面板能打开、结构正确（有截图），
  但 16 项数值是否都对，尚无逐项确认记录。
- **重逢心境只验证了 1–7 天档**（真机样本：离开 141.374 小时）。
  6–24h 与 ≥7d 两档目前只有门禁覆盖，没有真机样本。
- **语音输入需要单独的 STT Key**：与对话 Key 分开配置，
  因为 DeepSeek 官方不提供 STT 端点。
- **视觉探针只支持 `deepseek-flash` 系**，其他模型会被明确拒绝。

---

## [1.6.1] - 2026-10-19

> **为什么单独发一版**：`v1.6.0` 的三个安装包（Setup / portable / zip）构建于 2026-10-18 21:02，
> 而下面这批修复是 10-19 白天才落的。两者的 `app.asar` 哈希逐文件比对**全部不一致** ——
> 也就是说，已发布的 v1.6.0 里**一个修复都没有**。
> 代码修了、测试绿了、包没重打，是发布流程里一直没被门禁覆盖的缺口（见文末说明）。

### 🩹 修复：主动搭话调度在丢回执后永久停摆

- **根因**：`checkAndPushProactive()` 里「已派发提案」那条分支只发 IPC、**不安排下一次 tick**。
  整条链的存续完全押在渲染端回执上；回执一丢（Modern Standby 冻结 IPC、渲染端卡顿、进程回收），
  调度就永久停摆，直到用户下一次互动才被唤醒。
  实机证据：2026-10-18 夜，系统 22:30 进 Modern Standby，她整夜零开口。
- **修复**：立不变式「每一次 tick 结束都必须已安排好下一次 tick」，三条出口一律重排
  （未就绪 60 秒 / 已派发 90 秒 / 无提案按原口径）。
- 补两处叫醒：`config-set-key` 成功后重排；`powerMonitor.on('resume')` 后隔一个冷却复查。
- **D-25 收口**：新增 `evaluateTriggerWithCuriosity()`，`proactive-check` IPC 不再漏传
  `curiosityPending` / `curiosityQuestion`（此前好奇破冰只在后台 tick 那一半世界里存在）。
- 新增 `proactive-offer` 派发审计留痕。

### 🩹 修复：对话失败完全不可见

- **根因**：`llm_call` 遥测只在**成功**时写；失败只落到一个 6 秒自动收起的气泡上。
  Key 失效后 7 次主动搭话全被 401 拒掉，磁盘上**零痕迹**，四小时无人察觉。
- 新增 `chat-failed` 审计（只记元数据：错误类别 / HTTP 状态 / 是否主动搭话）。
- `chat-send` 的 catch 透传 `errorType` / `status`；`TimeoutError` 按 name 归类
  （`provider-adapter` 刻意透传该类错误不重包，它本身没有 `errorType`）。
- 失败同时广播到对话窗常驻注记行 —— 头顶气泡会收、审计用户不会翻，
  而主动搭话失败恰恰总发生在用户不在电脑前的时候。
- 头顶气泡按类别分流：认证失败指路「去设置重填 Key」并延长到 15 秒。
- 认证失败进 10 分钟退避（否则 90 秒自愈重排会变成每 90 秒打一次注定 401 的请求）；
  填 Key 与切换连接两条路都解除退避并立刻重排；退避只存内存、不落盘。

### 📄 文档

- 新增 `docs/v1.6-PROACTIVE-SCHEDULER-VERIFICATION.md`：四项实机验证清单
  （Modern Standby 唤醒自愈 / 回执丢失 90 秒自愈 / 冷启动无 Key 恢复 / D-25 两入口一致）。
- 新增两份测试：`test/proactive-scheduler.test.js`（17 项）、
  `test/chat-failure-visibility.test.js`（23 项），关键断言经变异测试验证过判别力。

> ⚠️ **遗留缺口（未在本版修复）**：`dist/` 被 `.gitignore` 忽略，
> 所以没有任何门禁会发现「代码已修、产物仍旧」。本版是人工比对 `app.asar` 哈希才发现的。
> 后续应在 `release-check` 里加一条「产物内 `main.js` 哈希 == 工作树」的 WARN 级检查。

## [1.6.0] - 2026-10-18

> **版本补录说明**：`v1.1.1`（2026-10-13）之后仓库连续交付了 v1.2 → v1.6 五条演进线，但版本号与本文件一直停在上一正式版。
> 这不是「版本号漂移」—— `package.json` / `README.md` / `README.en.md` / 本文件四处**一致地**停在 `1.1.1`，任何一致性门禁都不会报错；缺的是**一次发版动作本身**。
> 本次把五条演进线一次性收口为 `1.6.0`，条目文字取自当时的施工单与提交，未做回溯性美化。

### 🔒 v1.2 预期/守信跨窗闭环与记忆动力学通电
- **跨窗 `broken` 漏检修复 + `fulfilled` 兑现事实闭环 (A-1 + A-2)**：预期账本关窗结算时不再漏掉跨窗失效项；兑现事实以客观证据写入 `growSelf`，不代拟情绪。
- **记忆动力学出厂通电（D-011 三阶梯度标定）**：`memoryDynamics` 出厂 `true`，`memoryActiveThreshold = 0.50`、`memoryFadingMaxChars = 300`；老用户显式 `false` 严格保留以支持消融实验（`test/config-default-inheritance.test.js` 7 项同时锁住「缺键继承」与「显式 false 不被覆盖」两个方向）。
- **句界截断判别力补强**：`truncateFadingText` 的系数与 `trimEnd` 断言补齐，消除恒真断言盲区。
- **隐私边界收口**：`NOTICE` 移除指向私有归档的链接声明，`release-check` 的隔离门禁补强。

### 🫀 v1.3 具身环境知觉与沉默留白
- **知觉注入通道**：宿主环境事件（解锁、供电状态变化等）经显著性筛选后**只注入当轮 user 消息尾部**，不进 System Prompt、不落 `history`，前缀缓存不变式不受影响。
- **沉默留白第三种结局**：她可以选择不回应，而不被记为异常。
- 三条新测试：`test/v13-perception-channel.test.js`（32 项）、`test/v13-silent-presence.test.js`（23 项）、`test/v13-power-monitor-source.test.js`（13 项）。
- 实机验证：`experiment-telemetry.jsonl` 中出现首条真实 `perception_attach`（`host_unlock` / `salience 88` / window 6 / turn 314）。

### 📔 v1.4 生命观察日记与自发便签
- **观察日记（通路 B）**：观察结果走沙盒提案通路入传，`PROPOSAL_SOURCES` 扩展为 `user` / `selfNote` / `observerJournal`；闸门 4 对两类自源内容免确认，其余四道闸门照旧。
- **自发便签的素材供给与零污染防护 (v1.4-a)**：便签输入由 `selfLedger` 投影、调节感知、清洗后的近期对话与上一条便签构成；`synthetic` 轮整条跳过，避免程序自造内容回流成她的记忆。
- 两条新测试：`test/v14-observer-journal.test.js`（27 项）、`test/v14-selfnote-context.test.js`（27 项）。

### 🔌 v1.5 Provider 容灾回落与熔断编排 (v1.5-a)
- **`src/fallback-adapter.js`**：主端点 `retryable` 失败时一次回落备用端点；**流式已吐字（`emitted > 0`）硬阻断回落**，避免同一句话被两个模型各说一半；`maxFallbacksPerCall = 1` 防抖动放大。
- **`src/circuit-breaker.js` 生产接线**：`failureThreshold = 3`、`cooldownMs = 30000`；熔断后直接走备用。
- **计费口径修正**：401 等客户端错误不计入熔断失败数，避免把「Key 错了」误报成「熔断打开」。
- **`getSS` 透传修复**：`Brain` 构造时未把 `getSS` 传进备用适配器，备用端点永远解析不到凭据 —— 功能对真实用户静默失效而测试全绿；已修并补 3 项断言。
- `test/v15-provider-fallback.test.js`（51 项）。

### 🩹 v1.6 缺口收口 (v1.6-a / v1.6-b)
- **观察日记超长不再整篇丢弃 (v1.6-a)**：原文 `text.length > 400` 直接 `return null`，而提示词允许写到约 600 字 —— 她认真写长了反而一个字都不留。改为复用 `truncateFadingText(text, 400)` 句界截断保留（无标点则硬截 + 省略号，上界 403）。
- **INT-01 处置结论澄清 (v1.6-b)**：P4 契约裁定为架构储备，不列入本版施工。
- 既有断言「超 400 返回 null」随之**重写**为三条新断言（丢弃 → 截断保留），而不是删除。
- **连接管理区消歧义**：改标「已保存的连接」、`＋ 新建连接`、`💾 保存修改`，并在覆盖已有 Key 前加确认。

### 🛠 v1.6-c 公开发布剥离（本版新增）
- **`tools/public-export.js`**：把「哪些文件可公开」从人工挑选改为**默认拒绝的发布边界** —— 白名单 `INCLUDE` 决定能出去什么，带理由的 `EXCLUDE` 在白名单内挖洞，两者都未命中的文件判为未分类并让门禁失败。三个入口：`--check` 门禁、`--list` 判定明细、`--out <目录>` 物化公开集。
- **`release-check.js` 第 10 项重做**：旧实现有三重盲区（文件名前缀跳过 `V1.` / `chulan_`、只认一个 `software` 子目录、只扫 4 个目录），实测对 49 行开发机绝对路径报「0 处泄露」。现改为调用公开集判定。
- **`test/public-export.test.js`（32 项）**：含「已知含 27 处开发机路径的私有文件必须被抓出」的变异对照，防止门禁退化成空转。
- 修 4 条存量断链（`docs/v1.1-UPDATE-PLAN.md` 3 条少一级 `../`、`docs/ROADMAP-AND-PUBLIC-RELEASE-PLAN.md` 1 条重复 `docs/`）。

---

## [1.1.1] - 2026-10-13

> **补丁说明**：针对 `v1.1.0` 收官独立审计发现的关窗专属暗号（`adopted`）提示词契约与词典入库 `windowNo` 偏移进行热修复，并补强 24h 潮汐仿真、内稳态唤醒边界与语法检查脚本。

### 🩹 缺陷修复与门禁加固 (Fixes & Hardening)
- **关窗小结 `adopted` 暗号提示词契约补齐 (`src/brain.js`)**：在 `SUMMARY_SYS` 的 `coinages` 条款中开放 `adopted` 枚举，明确至少 2 字、双方共同约定且由初澜 `assistant` 亲口复述接纳、`gloss` 必填及单窗最多 1 条的五重门禁规则，与 `Memory.addLexicon` 实现完全对齐。
- **词典关窗入库 `windowNo` 透传修复 (`src/brain.js`, `test/lexicon-expectations.test.js`)**：修复 `closeWindow()` 自增 `windowNo` 后 `addLexicon` 未显式透传 `windowNo: snap.windowNo` 导致的入库窗口号偏移，确保跨 3 窗自然衰减与单窗 `adopted` 限额精准按已归档窗口结算。
- **24h 潮汐仿真与内态边界门禁加固 (`tools/long-run-sim.js`, `test/internal-regulation.test.js`, `tools/check.js`)**：修正 `tools/long-run-sim.js` 中 6 处 `updateOnInteractionTurn` 的 `messageLength` 键名并补入 `markCuriosityIncubated` 发酵及 `systemText()` 逐字节恒等验证；在 `test/internal-regulation.test.js` 补强 `messageLength` `100` vs `101/120` 唤醒度边界对照断言；`tools/check.js` 跳过 `.workbuddy` / `dist` 并改用 `stdio: 'ignore'` 兼容受限沙盒。
- **记忆层死代码与文档收口 (`src/memory.js`, `docs/`)**：移除未调用的 `_isWordMentioned` 死方法及过时注释，并在 `v1.1` 演进文档中补注非自愿回忆浮现的 `experimentModules.memoryDynamics = true` 前置条件说明。

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
