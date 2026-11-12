# Changelog / 变更履历

本项目的所有重要更新与架构演进均记录于此文件。  
版本记录格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/)。

---

## [1.9.0] - 2026-11-12

> **相比上一个公开版本 v1.8.0**，本版打通受托落档（D-27 通路 B）、补齐自发能力的观察档与动作史闭环、
> 完成 Agent 框架审计收口与 S-2/S-3/S-4 安全加固，并修复个体观测面板排版与高级连接设置的 P0 缺陷。
> 以下按功能线归纳，不逐笔罗列提交。

### 📄 文档：README 收成门面（纯文档重构，不改运行行为）

> **为什么做**：README 从 240 行涨到 1109 行，其中 267 行是内部审计级别的版本记录、
> 161 行是 135 个测试套件的逐条说明、136 行英文、51 行 `src/` 模块清单。
> 这些东西对开发者有用，但**放在仓库首页等于把门厅当成了档案室** ——
> 来的人先看到 800 行实现细节，还没看到「这是个什么东西」就走了。

- **README 1109 → 240 行**，只留四块：她是谁 / 她记得你 / 她做不到什么 / 怎么扩展。
- **中英逐段对照**：一段中文接一段英文斜体，不再分成隔了 950 行的两大块
  （原来英文读者要滚到底，实际没人会滚）。
- 新增 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：模块地图、记忆模型、缓存不变式、
  换装数据结构、配置项、Roadmap。**逐字搬运，一个字符未改**。
- 新增 [`docs/TEST-INVENTORY.md`](docs/TEST-INVENTORY.md)：135 个套件清单与逐条说明。
- 新增 [`docs/VERSION-HISTORY.md`](docs/VERSION-HISTORY.md)：v0.3 ~ v1.8.0 完整工程记录。
  README 里只留一张一行一版的总表。

### 🔧 门禁：换读取路径，判据一条没松

- `test/docs.test.js`、`tools/release-check.js`、`test/gate-selfcheck.test.js`
  三处原本从 `README.md` 读「## 测试 + bash 块」，现改读 `docs/TEST-INVENTORY.md`。
- 🔴 **项数对账、双向差集、未点名检查全部照旧**。为什么不能只留个链接：
  那样项数声明就再没有任何东西在核对了，门禁会退化成永远通过的装饰。
  **搬走的是位置，不是判据。**
- 测试项数不变（135 套件 / 4849 断言），三处门禁实跑全绿。

### 🖼 资产

- **删 `docs/images/outfit-gothic.png`**：那条黑裙把她的头整个盖住了 ——
  正是 `src/wardrobe.js` 里记为「待重做」的残缺点阵，不该出现在仓库首页。
- **`docs/images/hero.png` 黑底改透明**：原来纯黑底，在 GitHub 浅色主题下是一块黑方块。
  改法是**从四边泛洪**而不是全图颜色替换 —— 第一版全图替换把她的黑色短裤、靴子、
  轮廓线一起填成了浅色（肉眼即见：立绘下半身被抹平），改成边缘连通才只动背景。
  气泡是白底黑字，故用透明而不是浅灰，明暗两种主题都能用。

### ⚠️ 顺带修掉的三处

- 英文段里有一句 `The full documentation ... is maintained in [README.md](README.md)`
  —— 英文内容搬进 README 后它变成**指向自己**，随搬家一并消失。
- 中英各有一行版权声明，同一份文件重复，已合并为末尾一处。
- `docs/RELEASE-LEDGER.md` 的发布流程原写真实盘符，会让剥离门禁报断链，改用 `<公库工作树>` 占位。

---

### 🎯 新增：D-27 通路 B —— 她拟稿、她可以拒绝、你点头才落盘

> **为什么做**：D-12 把 `tryBuildProposalFromIntent` 停成了一个 `return null` 的 stub，
> 理由是「只有 scope（文件名），没有 content（要写什么）」。十六轮之后补上这个缺口：
> **正文从她自己的一次独立判断里来**，而且**她有权拒绝立项**。

- **独立拟稿调用**：新增 `brain.askForProposalContent()`，与 `askForSelfNote` /
  `askForObserverJournal` 同形 —— **绝不在聊天回话末尾夹带正文**。三条理由：
  ① 聊天提示词有自己的铁律（不含程序数字、不暴露时钟、过滤 synthetic），
  顺带吐几百字 Markdown 语气必然撕裂；② 多行标记一旦被 max_tokens 截断，
  半截文档会漏进气泡；③ **拒绝权需要一次事后审视** —— 聊完再问「要不要留档」，
  她才说得出口「还没聊透」。合并在同一次调用里，那个「不」来不及出口。
- **三态结果**：`ok / refused / unavailable`，不再用裸 `null`。
  拒案与拟稿故障**分开审计**（`refused_by_subject` vs `draft_unavailable`）——
  只按 outcome 汇总时，把故障统计成她的决策会误判她的行为倾向。
- **保留第五道闸门**：通路 B 的提案来源仍是 `'user'`，**用户点【授权】才落盘**。
  与通路 A（自发留条，免确认）是两件事：她替用户干的事按用户的说法来。
- **新事件 `agent-proposal-pending`**：D-19 删掉唯一的 `agent-proposal-available`
  发送点之后，全仓再无发送点，建出来的案会躺到 10 分钟 TTL 过期、用户永远看不到卡片。
  新事件语义明确（只表示「有待决提案」），不复用那个已被判为歧义的名字。
- **待决卡片队列**（`pet.js`，不改 `ui-agent-confirm.js` 的单卡契约）：
  拟稿是并行异步调用，广播顺序不定，而确认卡是单容器。实测复现覆盖竞态
  （50ms 延迟下 A/B 同时到达，A 被 B 顶掉且再也回不来），根因是 `busy` 判据
  读 `isVisible()` 会被 `await` 撕开。修法：占位在同步段、判据改「集合里除自己
  还有没有别人」、确认回调整段包 `try/finally`。
- **文件名净化与执行器对齐**：`agent-intent` 的扩展名白名单认 `csv`，
  执行器 `ALLOWED_WRITE_EXTENSIONS` 不收 csv ⇒ 「整理.csv」会建案成功、
  点授权后白点在 `DISALLOWED_EXTENSION`。`buildSandboxScope()` 收敛为 `.md`。

**⚠️ 如实声明（已知边界，不是遗漏）**：拒绝识别采用**启发式判据**（实义宾语检测），
已知三类漏判：① 标题 + 完整句子；② 标题是拒绝、正文是完整句；③ 短语前有实义名词
（`信息还不太够` 里的「信息」）。**失败方向刻意偏向「把拒绝当正文」** ——
最坏多一张可拒绝的卡片，不会误丢弃合法方案。五次复核中同一类误杀出现过四次
（`不做X` → `先放一放X` → `X放一放`），根治需改为显式协议（模型输出独立字段表态），
不在本轮范围。

### 🔍 新增：自发能力观察档（`off / observe / auto`）与期满补注入

- **三档模式开关**（`agentCapabilityModes`）：
  - `off`：在 `askForSelf*` 之前直接拦截，零 LLM 开销；
  - `observe`：在 `proposeInternal` 之前分流拦截，照常思考拟稿但**不建案、不写安全审计、不占写预算、不回流 `selfNotes`**，完整正文写入独立文件 `agent-observations.jsonl`（`src/agent-observations.js`，100 条 / 90 天双维度轮转，保留完整正文不被审计 500 字上限截断）；
  - `auto`：维持既有自动路径（`selfNote` / `observerJournal` 默认保持 `auto`，未登记的新能力默认保守回落 `observe`）。
- **观察期满补注入与启动兜底**：
  - `src/memory.js` 新增 `observeEpoch` / `observedNotes` / `pendingEcho`、`noteObserved()`、`markObserveEpoch()` 与 `takeObserveEcho()`，按能力分通道隔离观察次数与待补回声；
  - `markObserveEpoch('out')` 幂等防止离开后反复触发；消费时清除已用通道 `observedNotes`，避免再次进入观察期翻出上一轮旧账；
  - `brain.js` 在 `askForSelf*` 优先注入（`memory.build()` 仅在 `synthetic` 轮次作为兜底且绝不污染 `system`），只给出定性描述，不报告触发数字或时刻；
  - `main.js` 在启动阶段对已离开 `observe` 档但 `leftAt === null` 的历史状态做一次性兜底落账（实机重启日志已确认写入 `leftAt` 与 `pendingEcho`）。

### 📜 新增：动作史投影与能力认知对齐

- **动作史投影（`src/agent-history.js`）**：纯粹从审计日志只读投影她自己的行动记录，按 `proposalId` 聚合（以 `propose-action` 的 `proposalSource` 归属、执行优先 `executed`），自动剔除 `proactive-offer` / `chat-failed` / `confirm-action`（用户操作）以及 D-19 历史遗留 `ALREADY_EXECUTED` 误报。
- **不污染对话前缀缓存**：`brain._buildActionHistoryText()` 仅挂进独立 `askForSelf*` 调用，不进 `memory.build()`，只陈述事实而不给出可比较聚合计数或绝对时钟。
- **能力认知对齐**：更新 `src/persona.js` 诚实边界与三条独立提示词，明确沙盒文件夹是她唯一可写下的外部位置且她无法读取其内部内容；通过新抽离的 `src/constraints.js` 统一共享核心约束，并建立意图层读能力一致性门禁防认知漂移。（提示：`persona` 变更会触发一次已有对话系统前缀缓存重建。）

### 🛡️ 安全加固与 Agent 框架审计收口

- **Agent 框架 A/B/C 三批收口**：
  - 执行确认（`NOT_CONFIRMED`）时保留快照与重试次数，`get-pending` 拦截已执行案并区分 `SNAPSHOT_EXPIRED` / `SNAPSHOT_MISSING`；补齐 `observerJournal` 观察期记账；移除渲染端可控的无用字段 `requiresUserConfirmation`；
  - `addSelfNote` 增加未读内容去重，观察日志轮转改用原子写，移除无用死导出 `realpathBestEffort` 及 `memory.js` 零调用死方法 `buildWithEphemeralUser`。
- **S-2 WAL 与备份物理落盘（`src/agent-transaction.js`）**：
  - 抽取私有 `writeAllAndFsyncSync`（含防短写死循环保护），`_appendWal` 与 `begin()` 备份统一改用 `openSync → writeSync → fsyncSync → closeSync`；
  - 修复新建 WAL 时若 `fstatSync` 抛错导致残余 0 字节 `agent-write-txn.jsonl` 幽灵文件的边界漏洞，统一按 `!committed` 回滚截断/删空并清理孤儿备份。
- **S-3 沙盒不可用降级启动（`main.js`）**：
  - 沙盒目录初始化失败或被同名文件占坑时捕获异常，降级为 `agentSandbox = null`（内部状态记录 `agentSandboxUnavailable`），不阻断 `app.whenReady()` 主流程，并借助 `scope_not_in_whitelist` 自动停用写能力。
- **S-4 媒体权限白名单收窄（`main.js`）**：
  - `setPermissionRequestHandler` 接入第 4 参数 `details` 的 `mediaTypes`，收窄为严格白名单 `types.length === 0 || !types.every((t) => t === 'audio')`；`setPermissionCheckHandler` 同步限制为 `details.mediaType === 'audio'`，显式拒绝 `video` 与空数组请求。

### 🖥️ UI 体验与连接设置修复

- **个体观测面板排版精修（`index.html` / `style.css` / `pet.js` / `ui-i18n.js`）**：
  - 重构个体观测与机制遥测 KV 网格及度量条样式，补齐双语标签、遥测刷新时间戳（`#rObsTimestamp`）与机制分组全部展开/收起工具栏（`#rObsToggleAllBtn`）。
- **高级连接设置 4 项 P0 修复（`pet.js` / `ui-i18n.js` / `src/connections.js` / `src/openai-transport.js`）**：
  - **预设切换清残留**：`applyPreset()` 允许空值（如 Custom、未填预设模型的厂商）清掉旧 Endpoint / Model 残留，`fillConnEditor()` 同步更新 `#connPresetSelect` 选中态；
  - **Model 保存生效**：`updateConnection()` 兼容前端传入 `patch.model`，且显式传空模型名时 fail-closed 拒绝而不回弹旧 `models[0]`；
  - **URL 去重**：`resolveChatCompletionsURL()` 规范识别尾部已带 `/chat/completions` 的 Endpoint（含大小写变体），避免拼出双倍后缀；
  - **未建档与脏表单拦截**：在连接未建档或表单存在未保存修改时点击「测试连接」，明确中英文提示先创建或保存，不再静默拿着旧配置测试。

### 🔧 门禁与测试规模

- 测试套件扩展至 **138 个已编号套件（137 个 Node 套件 + 1 个 Python UI 套件，合计 5162 项断言）**，另含门禁聚合器 `docs.test.js` 与自检 `gate-selfcheck.test.js`（全目录共 140 个测试文件）。
- 新增/扩充 `agent-observe-mode`、`agent-history`、`agent_transaction`、`agent-sandbox`、`v17-permission-gate`、`connections`、`connection-ipc` 等多项边界与变异回归门禁。
- `tools/release-check.js` 新增安装包 PE overlay 大小校验，拦截构建失败遗留的残缺存根（`overlay < 10MB` 直接判 `FAIL`）。

### ⚠️ 已知限制（不粉饰）

- **本版未附 `Setup.exe`**：NSIS 卸载器导出阶段在本机被 Defender 实时保护阻断（`Error writing temporary file`），非管理员无法加排除项。当前交付便携单文件版 `Life-1.9.0-win-x64-portable.exe` 与绿色解压版 `Life-1.9.0-win-x64.zip`。

- **Agent 长链路实机样本仍有限**：`agentTriggerEnabled` 出厂默认仍为 `false`；观察期重启写 `leftAt` 已获实机日志验证，但观察档触发、期满补注入与动作史注入整体主要靠单测与变异测试覆盖，尚缺长时间真实挂机实机样本。
- **D-27 通路 B 拒案识别为启发式**：目前仍保留三类偏保守漏判（宁可将拒绝呈为可拒绝待决卡，不误丢合法方案），根治需后续改为显式结构化协议。
- **S-3 缺运行时「沙盒不可用」告知通道**：沙盒初始化失败时虽可安全降级且阻断写入，但尚未向对话模型传递「桌面沙盒暂时不可用」的状态提示（已登记于 `docs/PENDING-TASKS.md` §8.3）。
- **高级连接设置遗留 P1（本版未改动）**：部分官方预设（如 Claude）无默认预设模型名需手动输入、`anthropic-native` 协议目前尚无适配层实现、`local` 类型连接暂未豁免非空 API Key、`mimo-token-plan` 仍在预设下拉列表保持隐藏。
- **延续 v1.8.0 同口径限制**：观测面板多组遥测数值未逐项真机核对、重逢心境仍仅验证 1–7 天档、STT 需独立配置 Key、视觉探针能力判定仅对支持图片输入的特定模型名放行。

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
