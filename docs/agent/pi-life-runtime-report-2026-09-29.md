# Pi × Life 运行时调查报告（2026-09-29）

> 本文件是**调查报告**，不是 Agent Skill。内容分三级并显式标注：**【事实】**=实际命令输出或实际读取的文件内容；
> **【推断】**=基于证据的判断，非直接观测；**【未验证】**=本次未实际验证。未标注处默认为【事实】。

## 0. 报告元信息

- 日期：2026-09-29
- 工作目录：`/data/data/com.termux/files/home/Life`（= `~/Life`）
- 调查方式：以只读检查为主（`git status` / `ls` / `grep` / `node --check` / 文件阅读）
- 本会话写操作总账（全部且仅有）：
  1. 创建目录 `~/Life/.pi/skills/`（空目录）
  2. 创建 `~/Life/.pi/skills/life-dev-guide/SKILL.md`（早期版本，内容已并入 life Skill）
  3. 创建并多轮修订 `~/Life/.pi/skills/life/SKILL.md`（最终版，149 行）
  4. 创建本报告文件
- 未执行：测试套件、依赖安装、任何 `git add/commit/push`、任何对既有文件的修改/删除/重命名

---

## 1. 仓库与环境核实（实测）

| 项目 | 实测结果 |
| --- | --- |
| Git 分支 | `main`，与 `origin/main` 同步（无 ahead/behind） |
| 工作树 | 干净；`git ls-files --others --exclude-standard` 在调查期间为空 |
| 远端 | 仅 `origin` → `https://github.com/andabaoyue/Life.git`（fetch/push 同址） |
| 跟踪文件数 | 184 |
| 大文件 | 无超过 1MB 的文件 |
| AGENTS.md / CLAUDE.md | 均不存在 |
| `package.json` | `version: 0.9.8.1`，`productName: Life`，`characterName: 初澜`，依赖仅 `electron ^44.4.3` |
| 脚本 | `start`=electron .；`check`=全量 node --check；`test`=`node test/docs.test.js` |
| 最新提交 | `fb3e4a8` docs(security): archive v0.9.8.1 sandbox black-box security audit report |

## 2. 只读审计结论（实测）

1. **语法完整性**：对仓库全部 `.js`（排除 node_modules）执行 `node --check`，真实退出码 0，零语法错误。
2. **敏感信息扫描**：对 `*.js/*.json/*.html` 扫描 api_key/secret/token/password/sk- 模式——命中全部为变量名（`cfg.apiKey` 等）、配置键名或 `index.html` 输入框占位符 `"sk-..."`，未发现真实密钥。
3. **`.gitignore` 覆盖面**：node_modules、`.env*`、`*.key/*.pem/*.secret`、credentials/secrets、运行时状态文件（experiences.jsonl、subject-state.json、self-ledger.json、memory.json、wardrobe.json、life-config.json、life-key、gpt-girl-* 等）、日志与构建产物。
4. **文档一致性**：README 引用的全部 `test/*`、`src/*`、`tools/*` 路径实测存在；`test/` 下全部 79 个文件在 README 均有条目；`skills/DS Skill.md`、`assets/pet.png` 等清单文件实测存在。
5. **遗留标记**：`src/`、`main.js`、`pet.js`、`preload.js` 中 `TODO/FIXME/XXX/HACK` 零命中。

## 3. README 全文阅读（767 行，两段读完）

关键观察：

- **缓存命中率三原则**：小结进 system 头部；回答完再关窗；时间戳绝不进 system。穿着块固定 system 最末尾且长期记忆必须在其之前。破缓存次数 = 窗口数。
- **衣柜三条铁律**（`src/wardrobe.js` 头部）：服装不碰人格（测试用正则扫源码执法）；语言状态 ≠ 程序状态（`[wear:id]` 仅是提案，`wardrobe.applyProposal()` 才是执行）；本体不可换装、外饰可更换。
- **测试体系**：`npm test` = `node test/docs.test.js` 为整套回归门禁（自动起临时服务器并核对 README 测试项数）；`ui_test.py` 需静态服务器 + chromium，逐帧断言流式标记不外泄。
- **版本记录 v0.3 → v0.9.7**：README 版本记录止于 v0.9.7（package.json 为 0.9.8.1，即 README changelog 落后于版本号，是 README 现状）。v0.9.7 含「实验可信度边界」：Initial State Identity、Function Event Identity、Dream provenance 三命名空间、Attention watermark 256-entry bounded FIFO、Archive writer 单写者边界。
- **外部审阅处理模式**：v0.7 / v0.7.1 / v0.8.1 均「逐条复核、属实才改、不照抄修法」，并公开订正自己写错的数字与说过头的结论。
- **DeepSeek 缓存策略**：best-effort，命中以 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 为准，不承诺必然命中。
- **待办清单**：表情差分图（素材实测 404 不存在）、`[face:]/[act:]` 明确不做、真图层替换占位、换装第二阶段、联网查询、语音、桌面图标扫描器、托盘、打包 exe。

## 4. skills/DS Skill.md 阅读（331 行）

- 性质：Life 应用的**运行时创作模式规范**（成人向虚构小说），与 agent skill 是两种东西。
- 15 节结构：定位与能力边界（「Skill 是能力，而不是人格」，18+ 锁定）、核心创作原则、输入协议、默认参数、输出格式、成人/暴力场景、人物连续性检查、风格执行、连载模式、修改章节、信息不足、结尾钩子、文本最终检查（13 项 checkbox）、启动模板。
- 【推断】与 Agent Skill 的关系正交：DS Skill 管初澜的创作行为（README 载明「载入后作为 system 提示词的一部分注入」），`life` Skill 管开发者的改码行为；据两文件内容对照，未发现冲突或重复。本会话未运行验证两者同时启用时的行为。

## 5. 源码架构观察（Subject / Provider / Experience / State / Runtime）

行数为 `wc -l` 实测，职责取自各文件头部注释。

### 5.0 架构总览（本轮观察到的主要结构）

分层地图（自下而上）：

```
渲染层   index.html / style.css / pet.js          （表现、动画、气泡、逐帧标记剪裁）
桥接层   preload.js → window.deskpet              （contextBridge，IPC 封装）
宿主层   main.js                                  （Electron 窗口/IPC/位移/衣柜实例/safeStorage）
调度层   src/brain.js                             （对话、关窗、记忆合并、换装提案、经 Registry 取 adapter）
主体层   persona / subject-state / self-ledger / biographical-candidate / internal-* / attention-gate
经验层   experience-schema / experiences-archive / archive-integrity / state-change / experiment-* / research-*/dream-*
Provider provider-adapter / policy / registry / routing / adapters/* / deepseek / usage|cache|cost / circuit-breaker
支撑层   config / secure / atomic / migration / deferred-writer / layout / desktop-motion / digital-umwelt
数据层   userData（memory.json / wardrobe.json / subject-state.json / self-ledger.json /
         experiences.jsonl / experiment-telemetry.jsonl / life-config.json / life-key）
测试层   test/ 79 个文件（Node 单测 + ui_test.py），docs.test.js 为门禁并核对 README 项数
```

观察到的三条结构特征（【事实】，来自源码头注释与 README 规格）：
1. **单向数据流 + 提案/执行分离**：模型只能出提案（`[wear:id]`、State 建议），执行权在程序侧（`wardrobe.applyProposal()`、确定性 Reducer）。
2. **写入面收敛**：所有持久化经 `atomic.js` + `deferred-writer.js`，归档经 `archive-integrity.js` 单写者边界，实验底座 Append-Only。
3. **观察面只读**：research-* 层严格只读（Snapshot Mode、只读 IPC 白名单），与实验对象单向隔离。

### 5.1 Subject（主体层）
- `src/persona.js`（33）：最小主体内核，「认知基底 ≠ 初澜主体」「保护传记空白」「不强加桌宠/AI/所有权标签」
- `src/subject-state.js`（1346）：`class SubjectState`，ALLOWED_TRAITS 严格白名单、Provenance 强验证、确定性 Reducer、离线 Replay
- `src/self-ledger.js`（381）：生命档案 schema v2，原始证据与 Current Self 投影分离
- `src/biographical-candidate.js`（267）：自传印痕候选状态机与防循环验证器

### 5.2 State（状态与调节）
- `src/internal-state.js`（363）：SUBJECT_STATE_PROXY ≠ SYSTEM_METRICS ≠ Qualia；`subjectAccessible = false`，禁止把 `energy=40` 类标量喂进 Prompt
- `src/internal-regulation.js`（616）：`InternalRegulationManager`，双轨分离（D-001/D-008），短期调节变量禁入人格白名单
- `src/state-change.js`（162）：StateChange 记录，LLM 严禁直写 previousValue/delta/newValue，`symmetricRound`
- `src/canalization.js`（99）/ `src/memory-dynamics.js`（238）/ `src/path-dependency.js`（701）/ `src/attention-gate.js`（157，ATTENDED ≠ SUBJECT_ACQUIRED）

### 5.3 Experience（经验与归档）
- `src/experience-schema.js`（603）：Event / Observation / Interpretation 三层分离
- `src/experiences-archive.js`（591）：experiences.jsonl Append-Only 原始底座
- `src/archive-integrity.js`（1304）：「宁可显示未记录/无法认证/数据损坏，也绝不生成、推断、补全、伪造」
- `src/experiment-metadata.js`（530）/ `src/experiment-run.js`（209）/ `src/research-service.js`（508，只读 Snapshot Mode）/ `src/dream-system.js`（571，禁止直写 SubjectState）

### 5.4 Provider（v0.9.8 P1–P4）
- `src/provider-adapter.js`（99）：三层边界——Registry 选 adapter / Adapter 通信 / Policy 判定是否允许
- `src/provider-policy.js`（54）/ `src/provider-registry.js`（80，非信任根）/ `src/provider-routing.js`（94，保留原始失败事实）
- `src/adapters/deepseek-adapter.js`（100）：首个标准 Adapter，不复制网络实现
- `src/deepseek.js`（534）/ `src/generation-attempt.js`（94，一次调用=一 Attempt，Retry≠新语义生成，Fallback=新 Attempt）/ `src/circuit-breaker.js`（69）
- `src/usage-normalizer.js`（78）/ `src/cache-strategy.js`（40）/ `src/cost-strategy.js`（70）：FACT / 解释 / 定价三层，pricingVersion 版本化价格真相

### 5.5 Runtime（宿主层）
- `main.js`（510）/ `preload.js`（80）/ `src/brain.js`（1661，经 Registry 取 adapter）
- `src/config.js`（302，每次真读盘热重载）/ `src/atomic.js`（86，临时文件+fsync+rename）/ `src/migration.js`（62）
- `src/layout.js`（46，纯函数）/ `src/desktop-motion.js`（318，可注入障碍物）/ `src/deferred-writer.js`（88）/ `src/digital-umwelt.js`（211，宿主感知→知觉候选的质性转化）

### 5.6 跨层红线（源码头部注释直接读到）
1. 内部状态标量对主体不可知（`subjectAccessible = false`）
2. LLM 严禁直写状态值（一切状态变动经确定性 Reducer）
3. Provider 三层互不吞职责，Registry 非信任根
4. Research 层严格只读，绝不 Live Tail
5. 归档可伪造成分零容忍（三分态 RECORDED / NOT_RECORDED / UNRESOLVED）

### 5.7 层间边界（Subject / Runtime / Provider 等）

【事实】边界均在本轮读过的源码头注释或 README 中明确声明，执行机制一并列出：

| 边界 | 两侧区分 | 声明位置 |
| --- | --- | --- |
| Model Substrate ≠ Subject | 计算底座 ≠ 初澜主体 | `src/persona.js` 头注释；v0.9.7 本体论边界 |
| Runtime Host ≠ Subject | 进程/OS/遥测 ≠ 主体认同 | `src/internal-state.js`（SUBJECT_STATE_PROXY ≠ SYSTEM_METRICS，`subjectAccessible = false`）；`src/internal-regulation.js` 双轨分离 |
| 感知 ≠ 主体获得 | ATTENDED ≠ SUBJECT_ACQUIRED | `src/attention-gate.js` 头注释铁律；`src/digital-umwelt.js` 四级过滤漏斗 |
| Provider 三层互不吞职责 | Registry 选型 / Adapter 通信 / Policy 授权 | `src/provider-adapter.js` 头注释；`src/provider-policy.js` 域名白名单；`src/provider-registry.js`「非信任根」红线 |
| 语言 ≠ 程序状态 | 模型提案 ≠ 程序执行 | README 衣柜铁律：`[wear:id]` 仅提案，`applyProposal()` 才执行 |
| LLM ≠ 状态值 | 严禁直写 previousValue/delta/newValue | `src/state-change.js` 头注释（全由确定性 Reducer 产生） |
| 事实 ≠ 解释 | Event / Observation / Interpretation | `src/experience-schema.js` 头注释（解释不得覆盖客观 Event） |
| 观察 ≠ 干预 | Research 层严格只读 | `src/research-service.js`「绝不 Live Tail」 |
| 宿主感知 ≠ 主体事实 | 程序生成物不冒充主体经历 | README：synthetic/proactive 消息保缓存但排除于经历证据 |
| 运行环境 ≠ 身份标签 | UI 形态不写入主体认同 | `src/persona.js`「不强加桌宠/AI/所有权标签」 |

【推断】这些边界的共同形态是「单向转化 + 提案/执行分离 + fail-closed」：跨层信息只沿规定方向流动，越界输入被拒绝或降级（UNCERTIFIED / NOT_RECORDED）而非被容忍或补全。

## 6. pi Skills 体系调研（pi 官方文档 + 实测）

- pi 实现 Agent Skills 规范：skill = 含 `SKILL.md` 的目录（可带 scripts/references/assets），frontmatter 需 `name` + `description`，name 用小写字母/数字/连字符、≤64 字符，description ≤1024 字符。
- 发现位置：用户/项目 skills 目录、`~/.agents/skills/`、`.agents/skills/`（项目级从工作目录向上发现至仓库根）；`/skill:name` 可强制加载，`/reload` 热加载。
- 实测：调查开始时 `~/Life/.pi`、`~/.pi`、`~/.agents` 均不存在；仓库自带的 `~/Life/skills/` 是应用资产目录（DS Skill.md），不是 pi skill 位置。
- 本次会话创建了 `~/Life/.pi/skills/`（pi 项目级 skills 目录）及其中的 `life` Skill。

### 6.1 当前 Agent / Skill 相关观察（重点记录）

- 【事实】仓库原无 AGENTS.md / CLAUDE.md，无 `.pi/`、无 `.agents/`；`skills/DS Skill.md` 由 `src/creative-skill.js` 的 `DS_SKILL_PATH` 常量引用，README 载明设置面板载入后作为 system 提示词注入——属应用运行时 skill，不是 agent skill。
- 【事实】本会话在 pi 侧创建 `.pi/skills/life/SKILL.md`（`name: life`，149 行 16 章节，通用核心工作规范）；另有历史副本 `life-dev-guide/`（见第 12 节遗留事项）。
- 【事实】两套 skill 体系并存互不干扰：应用内 skill（DS Skill，运行时注入 system）与 agent skill（life，开发规范，按需加载）。
- 【未验证】pi 对 `life` Skill 的实际发现与 `/skill:life` 加载未实测（另见第 9 节）。

## 7. 工作流程分析

### 7.1 本次会话实际执行的流程
会话以分步指令推进，逐步为：环境确认（cwd/branch/status/remote）→ 项目阅读（README、目录结构）→ 只读审计 → 建 pi skills 目录 → 逐条口述规范由 agent 落入 Skill → 定位澄清（通用核心工作规范而非任务 Skill）→ 必备原则清单补全（一、项目身份；二、本体论原则）→ 收尾（保留 Skill、出独立报告）。

【推断】约束演化（后令覆盖前令）：初期「不执行任何写操作」→ 允许建目录 → 「不创建 SKILL.md/具体 Skill」→ 明确指令创建 Skill → 「只允许新增 `.pi/skills/life/SKILL.md`；不创建其他文件、不修改源码、不运行测试、不提交不 push」→ 收尾阶段授权新增本报告文件。此项系对会话指令序列的解读，非用户逐字声明的规则表述。

### 7.2 沉淀到 life Skill 的八步修改工作流
核实现场 → 明确问题 → 制定最小修改方案 → 修改 → 执行相关测试 → 检查 git diff → 再次核实行为 → 汇报实际证据；配套硬规则「没有证据时不要声称已完成/已修复/测试通过」。

### 7.3 与项目自身工作流的一致性（【推断】）
README 版本记录显示项目既有实践为「外部建议逐条实测复核、属实才改、公开订正错误数字」；本会话执行流程与其同构——此为基于两份材料的比较判断，非项目明文规定的流程条文。本会话全部结论均按「源码事实 / 测试事实 / 推断 / 建议」分级表述。

### 7.4 本轮实际发现的重要工作流程信息（重点记录）

- 【事实】测试门禁：`npm test` = `node test/docs.test.js`，自动起临时服务器跑整套回归，并核对 README「测试」一节的项数；README 明言「测试项数只在文末写一次」防多处漂移。
- 【事实】配套纪律：改断言数必须同步 README 项数；新增测试文件必须在 README 加条目；`ui_test.py` 需静态服务器（`DESKPET_URL`）与 chromium（`DESKPET_CHROME`）。
- 【事实】CI（`.github/workflows/ci.yml`）：Node 22 + Playwright Chromium，整套失败最多重试 3 次，超时 15 分钟。
- 【事实】配置热重载：`config.load()` 每次真读盘；唯一例外 API Key，走 `config-set-key` 事务与候选 Brain 生命周期回滚（README）。
- 【事实】项目惯例：外部建议逐条实测复核后才改（v0.7 / v0.7.1 / v0.8.1 changelog），不照抄修法，并公开订正自己写错的数字。

## 8. 已确认事实清单（附证据方式）

1. 当前工作目录即 `~/Life`，分支 `main`，工作树干净（`pwd` / `git status`）。
2. 仓库无 AGENTS.md / CLAUDE.md（`ls` 实测）。
3. 全部 JS 语法检查通过，退出码 0（无管道重跑实测）。
4. 仓库内无真实密钥（模式扫描 + 人工判读命中项）。
5. README 引用的测试/源码/工具文件全部存在，79 个测试文件全部有 README 条目（逐项 `ls`/grep 核对）。
6. README changelog 止于 v0.9.7，package.json 为 0.9.8.1（两者直接读取对比）。
7. `skills/DS Skill.md` 为应用运行时资产，与 agent skill 体系正交（全文阅读）。
8. 五域源码的行数、职责与红线（各文件头部注释 + `wc -l`）。
9. `~/Life/.pi/skills/life/SKILL.md` 最终为 149 行、16 章节、frontmatter `name: life`（`grep -n '^## '` + `wc -l`）。
10. 报告完成时 `git status --short` 实测输出为 `?? .pi/` 与 `?? docs/` 两行，零已跟踪文件改动（修订时补实测）。

## 9. 未验证项（【未验证】，如实标注）

- 测试套件的实际断言总数与通过情况——按约束「不运行测试」，未验证。
- `package-lock.json` 与 `package.json` 依赖一致性、Electron 44.4.3 可安装性——未验证。
- pi 对 `~/Life/.pi/skills/life/SKILL.md` 的实际发现/加载（startup 诊断、`/skill:life`）——未运行 pi 验证。
- README 中测试项数与实际断言数是否一致——依赖 `docs.test.js` 运行结果，本次未跑。
- 运行时行为（对话、换装、记忆、热重载、UI、动画）均未实际运行验证，本报告不含运行时观测。
- README 规格与代码实现的一致性只做到「路径存在级」核对，未做语义级逐条比对（如穿着块顺序、剥标口径未对照 `brain.js` 实现逐行验证）。
- Git 历史仅查看最近 10 条提交与分支/远端状态，未做全量历史审阅。
- `pet.js` / `style.css` / `index.html` 正文未读（仅被语法/模式扫描覆盖），其行为描述均来自 README 转述（另见 10.5）。
- `userData` 运行数据（真实记忆/衣柜/归档文件）不在仓库内，未见亦未验。

## 10. 本轮实际检查的目录与文件清单（重点记录）

以下为【事实】，按实际检查深度分级，未列入者即未检查。

### 10.1 目录（存在性 / 列表检查）
- `~/Life`（根目录完整列表、`find` 全树遍历）、`~/Life/.git`（经 git 命令间接检查）
- `~/Life/src`、`~/Life/src/adapters`、`~/Life/test`（79 个文件列表）、`~/Life/tools`、`~/Life/skills`、`~/Life/assets`、`~/Life/assets/character/*`（9 个换装子目录）、`~/Life/research`、`~/Life/.github/workflows`
- 存在性探测：`~/Life/.pi`、`~/Life/.pi/skills`、`~/.pi`、`~/.agents`、`~/.agents/skills`（创建前均不存在，后仅 `.pi/skills` 为本会话创建）

### 10.2 文件全文阅读
- `README.md`（767 行，两段读完）、`package.json`、`.gitignore`、`.github/workflows/ci.yml`
- `skills/DS Skill.md`（331 行）
- pi 官方文档：`docs/skills.md`（全文）、`docs/settings.md`（Resources 节）

### 10.3 文件头部 / 部分阅读（架构观察依据）
- Subject：`src/persona.js`、`src/subject-state.js`、`src/self-ledger.js`、`src/biographical-candidate.js`
- State：`src/internal-state.js`、`src/internal-regulation.js`、`src/state-change.js`、`src/canalization.js`、`src/memory-dynamics.js`、`src/path-dependency.js`、`src/attention-gate.js`
- Experience：`src/experience-schema.js`、`src/experiences-archive.js`、`src/archive-integrity.js`、`src/experiment-metadata.js`、`src/experiment-run.js`、`src/research-service.js`、`src/dream-system.js`
- Provider：`src/provider-adapter.js`、`src/provider-policy.js`、`src/provider-registry.js`、`src/provider-routing.js`、`src/adapters/deepseek-adapter.js`、`src/deepseek.js`、`src/generation-attempt.js`、`src/circuit-breaker.js`、`src/usage-normalizer.js`、`src/cache-strategy.js`、`src/cost-strategy.js`
- Runtime：`main.js`、`preload.js`、`src/brain.js`、`src/config.js`、`src/atomic.js`、`src/migration.js`、`src/layout.js`、`src/desktop-motion.js`、`src/deferred-writer.js`、`src/digital-umwelt.js`

### 10.4 仅扫描 / grep（未阅读全文）
- 全部 `*.js`（排除 node_modules）：`node --check` 语法扫描
- `*.js/*.json/*.html`：敏感信息模式扫描；`src/、main.js、pet.js、preload.js`：TODO/FIXME/XXX/HACK 扫描
- README 交叉引用核对：`test/*`、`src/*`、`tools/*` 路径存在性逐项比对
- `COGNITIVE-IDENTITY-AUDIT-REPORT.md`、`PHILOSOPHICAL-IDENTITY-SPECIFICATION-AUDIT.md`、`Life-实验有效性修复-第三阶段.md`：仅关键词 grep（substrate/主体/边界类术语定位）

### 10.5 未检查（如实声明）
- `pet.js`、`style.css`、`index.html` 正文（仅被语法/模式扫描覆盖）
- `test/` 各测试文件内容（仅列表与 README 条目核对，未读任何测试代码）
- `research/` 下文档全文、`ASSET-GENERATION-GUIDE.md` 及其余根目录报告全文、`assets/` 图片内容、`skills/DS Skill.md` 以外的 skill 相关运行代码（`src/creative-skill.js` 仅 grep 到路径引用）

## 11. 对未来 Agent workflow / thinking / token 优化有价值的观察（重点记录）

- 【事实】pi skill 的按需加载机制（description 路由，全文仅在匹配时读入）：项目规范沉淀为 skill 而非常驻 system prompt，是结构性的 token 优化；大部头调查材料放报告文件、不进 skill，避免污染 agent 常驻上下文。
- 【事实】本会话采用「分步口述 → 逐条落盘」模式，每条目一次 edit 往返，累计数十次工具调用（未逐次清点）；批量条目并批下达可显著减少往返轮次。
- 【事实】多条指令在「：」后截断丢失，需追问补发才继续，产生额外往返；agent 的正确应对是显式追问而非猜测，指令方宜自包含或分段确认。
- 【推断】「最小补丁 + 定点编辑」同时是 token 与注意力优化：整文件重写消耗大量输出 token、制造 diff 噪声、增加误伤风险。
- 【推断】三分类标注（事实/推断/未验证）降低后续 agent 的复核成本：事实段可直接采信，只需对推断段做二次核验。
- 【推断】README 中 DeepSeek 前缀缓存的经验（只追加、稳定前缀、易变信息集中尾部）同构适用于 agent 会话的上下文管理，可提高 prompt cache 复用、降低 token 成本。

## 12. 遗留事项

- `~/Life/.pi/skills/life-dev-guide/SKILL.md`：早前会话按当时指令创建的版本，内容已并入 `life/SKILL.md`。【事实】该文件存在且内容与 `life/SKILL.md` 重复。【推断】按「只允许新增 `.pi/skills/life/SKILL.md`」边界，它属于超范围残留。【待裁决】删除属破坏性操作，尚待用户明确指令（「确认删除」或「保留」）。
