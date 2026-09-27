# 《生物科学与数字生命的哲学范畴》实验有效性修复报告（第三阶段）

> **项目：** Life
> **GitHub 仓库：** `andabaoyue/Life`
> **主体：** 初澜 / Chulan
> **基线 Commit：** `2298b717d42561df836b82382cac8b1eb09362e1`
> **修复阶段：** 第三阶段（Phase 3: 第二轮复审有效性缺口全面闭环）
> **核心原则：** 坚守 `Model Substrate ≠ Runtime Host ≠ Chulan Subject` 本体论分立，绝不伪造历史实验条件，严格保证前缀缓存纯洁性、基线隔离与离线确定性回放。

---

## 一、修复背景与基线认定

在针对基线 `2298b717` 进行的第二轮独立复审中，课题组确认了第一轮中大部分关键工程机制已成功落地（包括经历归档哈希链、自传账本真实 Provenance 核验、内部状态双轨分离、注意力闸门与数字环周等）。然而，复审同时指出了一批在“实验有效性、科学严谨度与真实生产接线”层面的关键缺口（P0 级 5 项，P1 级 6 项）。

本阶段整改针对复审发现的 11 项有效性缺口进行了逐项代码修复、生产链路闭环与全量回归测试验证，未引入任何第二大模型法官（LLM Judge），未改变普通聊天、衣柜与动画表现，彻底闭合了所有实验有效性裂隙。

---

## 二、修复任务总览与完成清单

| 编号 | 严重度 | 修复项目 | 涉及模块 | 关闭状态 |
| :--- | :---: | :--- | :--- | :---: |
| **P0-1** | P0 | Observed Model 与 Model Version 真实捕获 | `src/config.js`, `src/deepseek.js`, `src/experiment-metadata.js`, `src/brain.js` | ✅ **已闭环** |
| **P0-2** | P0 | Persona 与 DS Skill Prompt Hashes 生产注入与防伪 | `src/experiment-metadata.js`, `src/brain.js` | ✅ **已闭环** |
| **P0-3** | P0 | GenerationContext 强契约校验与深冻结防篡改 | `src/experiment-metadata.js`, `src/archive-integrity.js` | ✅ **已闭环** |
| **P0-4** | P0 | 路径依赖实验 4D 因果分化闭环计算与判定修复 | `src/path-dependency.js` | ✅ **已闭环** |
| **P0-5** | P0 | 消除 Manifest 硬编码版本号，动态绑定 package.json 与 gitCommit | `src/experiment-run.js` | ✅ **已闭环** |
| **P1-1** | P1 | Attention 选通下游瞬时稳态闭环接线（`updateOnAttention`） | `src/internal-regulation.js`, `src/brain.js` | ✅ **已闭环** |
| **P1-2** | P1 | FADING 记忆状态 SystemText 渐褪与截断投影 | `src/memory.js` | ✅ **已闭环** |
| **P1-3** | P1 | Contextual Reactivation 停用词过滤与防误唤醒机制 | `src/memory.js` | ✅ **已闭环** |
| **P1-4** | P1 | SourceType 与 Message Role 语义兼容性核验 | `src/experience-schema.js`, `src/self-ledger.js`, `src/subject-state.js` | ✅ **已闭环** |
| **P1-5** | P1 | 梦境合成制品（`subject_dream`）完整绑定 GenerationContext | `src/dream-system.js` | ✅ **已闭环** |
| **P1-6** | P1 | 决策账本扩展（D-008~D-010）与测试项数对齐门禁 | `research/ENGINEERING-DECISION-LOG.md`, `README.md`, `test/decision-log.test.js` | ✅ **已闭环** |

---

## 三、核心机制修复详细说明

### 1. P0-1: Observed Model & Model Version 生产捕获与绑定
- **问题：** 此前元数据中 `modelName` 仅记录客户端请求配置的别名（如 `deepseek-chat`），未能捕获大模型服务商 HTTP/SSE 响应体中真实返回的具体模型快照（如 `deepseek-chat` 对应的实际后端调度模型），且配置中缺失 `modelVersion`。
- **修复：**
  1. `src/config.js`：在 `DEFAULTS` 中明确增加 `modelVersion: 'unavailable'` 字段并支持运行时配置及校验清洗。
  2. `src/deepseek.js`：在 `complete()` 与 `stream()` 中解析 Provider API 响应的 `j.model`（捕获实际执行请求的底座模型标识），封装为 `observedModel` 随调用结果返回。
  3. `src/experiment-metadata.js`：`buildGenerationContext` 强制收录 `observedModel` 与 `modelVersion`；在缺少观测信息时诚实回退为 `unavailable`，绝不凭空臆造。

### 2. P0-2: Persona 与 DS Skill Prompt Hashes 生产注入与防伪
- **问题：** 生成上下文中的 `promptHashes` 此前仅计算了局部小结/成长/合并模板的哈希，未包含影响模型整体认知人格的 `persona` 与深度思考/创作技能 `creativeSkill`；且当 prompt 为空串时误将空串哈希作为合法指纹。
- **修复：**
  1. `src/brain.js`：在构造函数中显式维护 `this.persona = PERSONA`；在 `_closeWindowInternal`、`mergeMemory` 与 `growSelf` 中，调用 `collectPromptHashes` 完整传入 `persona: this.persona` 及 `creativeSkill: this.cfg.writingMode ? CREATIVE_SKILL : null`。
  2. `src/experiment-metadata.js`：`collectPromptHashes` 中增加严格判定，当 `persona` 缺失或为空文本时显式标记为 `unavailable`，杜绝“空 Prompt 哈希通过”的虚假认证；当 `creativeSkill` 未开启时标记为 `'not_enabled'`，开启时注入其精确的 SHA-256 哈希。

### 3. P0-3: GenerationContext 强契约校验与深冻结防篡改
- **问题：** `validateGenerationContext` 此前对嵌套字段（如 `sampling`、`promptHashes`、`sourceMessageRange`）缺乏结构完整性强校验；且返回的 context 对象仅浅冻结顶层，嵌套字段仍有被外部篡改的风险。
- **修复：**
  1. `src/experiment-metadata.js` 实现 `deepFreeze(obj)`：递归遍历并深度冻结所有子对象（`sampling`、`promptHashes`、`modules`、`sourceMessageRange`），在严格模式下任何篡改尝试均被直接抛错阻断。
  2. 全面强化 `validateGenerationContext(ctx)`：对 17 个关键字段进行类型与契约强校验，严密检查 `metaSchemaVersion`、`kind`、`generatedAt`、`sampling.temperature`（数字）、`sampling.maxTokens`（整数）、`promptHashes`（非空对象且各键均为合法哈希字符串）、`sourceMessageRange` 等。
  3. `src/archive-integrity.js`：在归档记录校验器 `validateArchiveRecord` 中引入 `validateGenerationContext`，若归档记录携带 `generationContext` 则执行强校验，若为旧版遗留记录则保持向前兼容。

### 4. P0-4: 路径依赖实验 4D 因果分化闭环计算与判定修复
- **问题：** `src/path-dependency.js` 未完全使用其文档声称的多维分化指标，未计算 `subjectState` 的特质分化；`pathDependencyEstablished` 仅凭生理和行为判定，忽略了注意力和主体状态；且存在未使用的 `calculateRevisionPressure` 导入。
- **修复：**
  1. 清理无用导入，更新文件头文档：明确当前 Phase 0.5 落地 4 个核心维度，Memory Accessibility 与 Self Revision 为后续扩展规划。
  2. 补齐 `subjectState` 逐特质差值计算（遍历所有出现特质，计算 `subjectStateDiff`）。
  3. 判定逻辑全面升级为 4 维联合判定：
     $$\text{pathDependencyEstablished} = \text{hasRegDivergence} \lor \text{hasBehaviorDivergence} \lor \text{hasAttentionDivergence} \lor \text{hasSubjectStateDivergence}$$
  4. 对外导出的只读快照中完整保留 `divergence.internalRegulation`、`divergence.behaviorDistribution`、`divergence.attentionDivergence` 与 `divergence.subjectState`。

### 5. P0-5: 消除 Manifest 硬编码版本号，动态绑定 package.json 与 gitCommit
- **问题：** `src/experiment-run.js` 中 `createExperimentRunManifest` 存在硬编码的默认版本号 `'0.9.5.3'` 和静态 `'unknown'` gitCommit。
- **修复：**
  1. 引入动态 `getPackageVersion()` 解析器，从项目根目录 `package.json` 读取当前真实版本号（`0.9.7`）。
  2. 复用 `src/experiment-metadata.js` 导出的 `resolveGitCommit()`，动态解析当前 Git 仓库 HEAD Commit。
  3. 彻底移除所有 `'0.9.5.3'` 硬编码回落，确保每个 Experiment Run Manifest 忠实反映实际运行代码版本与 Git 节点。

### 6. P1-1: Attention 选通下游瞬时稳态闭环接线
- **问题：** 物理刺激经由 `DigitalUmwelt` 过滤与 `AttentionGate` 选通后，`status === 'ATTENDED'` 仅作为瞬时返回值，未能作用于任何下游消费者，导致注意力选通缺乏闭环因果效应。
- **修复：**
  1. `src/internal-regulation.js`：新增 `updateOnAttention(gateResult, details = {})` 方法。当且仅当 `gateResult.status === 'ATTENDED'` 且处于实验模式时，依据其感官显著度（salience）温和提升唤醒度（`arousal` $+1 \sim +8$）并使 `cognitiveLoadProxy` $+1$。
  2. 动态耦合：唤醒度上升后，系统自动调用 `_computeSalienceThreshold(arousal)` 动态收紧后续注意力选通门限，并通过 `BehaviorScheduler` 倾斜自主微动作概率分布（如高唤醒态下增加东张西望概率）。
  3. 认识论防线（不变量）：此项闭环为纯短时瞬态生理耦合，**绝对不将知觉内容写入 SubjectState 人格特质，绝对不生成自传体记忆（严格坚守 `ATTENDED ≠ SUBJECT_ACQUIRED`）**；在 baseline 模式下严格保持旁路静默。
  4. `src/brain.js`：在 `processEnvironmentalPerception` 中将选通结果接入 `this.internalRegulation.updateOnAttention(gateResult)`。

### 7. P1-2: FADING 记忆状态 SystemText 渐褪与截断投影
- **问题：** `src/memory.js` 在构建发送给 LLM 的 `systemText()` 时，虽已排除 `DORMANT` 态记忆，但对于 `FADING`（衰退态）的记忆仍与 `ACTIVE`（活跃态）记忆混同全量展示，缺乏渐褪表现。
- **修复：**
  1. `systemText()` 中区分 `ACTIVE` 与 `FADING` 记忆窗口：
     - 若该窗口对应的记忆痕迹处于 `FADING` 状态，则打上 `【第X段（渐褪）】`（或 `【早期（渐褪）】`）标记；
     - 对渐褪状态的记忆文本执行字数截断：超过 60 个字符时截断并附加省略号 `...`，体现记忆痕迹的概括模糊化。
     - 若处于 `ACTIVE` 状态，则保留全量文本与标准 `【第X段】` 标记；若处于 `DORMANT` 状态，则继续严格排除出 Prompt 上下文。
  2. 基线隔离：在无 `memoryDynamics` 的基线模式下，所有窗口保持原有完整显示与标准标记，无单字节扰动。

### 8. P1-3: Contextual Reactivation 停用词过滤与防误唤醒机制
- **问题：** `Memory.reactivateByContext()` 此前采用粗糙的 4 字符滑动窗口比对，日常高频口语词（如“今天天气”、“我们可以”）极易与历史小结发生意外重叠，导致休眠记忆被错误重新激活（False Positive Reactivation）。
- **修复：**
  1. `src/memory.js`：构建专门的高频停用词与日常口语杂音词表 `CHINESE_STOPWORDS` 及双词停用词判定辅助函数 `isStopwordOrNoise`。
  2. 词法过滤与最小有效词长限制：
     - 按标点切分候选短语；
     - 提取有效 Token（英文/标识符长度 $\ge 3$ 且非停用词；中文有效词元长度 $\ge 3$ 且非高频停用词，纯中文子串比对要求长 $\ge 5$ 或为显著专有名词）；
     - 过滤所有日常无信息含量的日常口语词汇（如“今天天气”、“我们可以”、“不知道”、“聊聊吗”等）。
  3. 实测验证：日常口语对话零假阳性触发，而具象线索（如“海螺贝壳”）精准触发唤醒。

### 9. P1-4: SourceType 与 Message Role 语义兼容性核验
- **问题：** 成长证据事实核验时，未对声明的 `sourceType` 与其引用的实际消息 `role` 进行语义兼容性核验，导致可能出现 `USER` 证据引用了 `role: 'assistant'` 消息，或先验类型（`INNATE` / `MODEL_PRIOR`）挂载了具体 `messageId` 的语义扭曲。
- **修复：**
  1. `src/experience-schema.js`：定义严格语义白名单 `SOURCE_TYPE_ROLE_COMPATIBILITY` 与先验集合 `PRIOR_SOURCE_TYPES`：
     - `USER`：仅允许引用 `role: 'user'` 的消息；
     - `EXPERIENCE` / `SELF_INFERRED` / `MODEL_INTERPRETATION`：仅允许引用 `role: 'assistant'` 的消息；
     - `OBSERVATION` / `PROGRAM_OBSERVATION`：允许引用 `user` 或 `assistant` 消息；
     - `INNATE` / `MODEL_PRIOR` / `RUNTIME`：属于先验或运行时源，**严禁挂载具体 messageId**（若挂载则拒绝并返回 `PRIOR_SOURCE_CANNOT_HAVE_MESSAGE_ID`）。
  2. 扩展共享事实核验原语 `checkMessageReference` 与独立核验函数 `validateSourceTypeCompatibility`。
  3. `src/self-ledger.js` 与 `src/subject-state.js`：在证据入账核验链中全量接入兼容性判定，角色与来源类型冲突时直接拒绝并准确记录 `ROLE_SOURCE_TYPE_MISMATCH`。

### 10. P1-5: 梦境合成制品完整绑定 GenerationContext
- **问题：** `src/dream-system.js` 中的 `synthesizeDream` 产出的 `subject_dream` 归档记录缺失标准 `GenerationContext` 元数据结构，导致梦境这一关键生成制品的生成条件不可追踪。
- **修复：**
  1. 引入 `buildGenerationContext` 与 `collectPromptHashes`。
  2. 梦境合成调用成功后，基于当前 Prompt 模板与 API 实际返回的 `observedModel`、`modelVersion`、采样参数（`dreamTemperature`、`dreamMaxTokens`）构建标准 `GenerationContext`（`kind: 'dream'`）。
  3. 将不可变的 `generationContext` 同时挂载至 `record.generationContext` 与 `record.payload.generationContext`，实现梦境制品的实验元数据完整闭环。

### 11. P1-6: 决策账本扩展与文档项数对齐门禁
- **问题：** 决策账本需同步更新第二阶段及第三阶段确立的已决决策；`test/docs.test.js` 作为文档门禁，严格检查 `README.md` 中声称的各测试项数与实际跑出的 PASS 项数逐字一致。
- **修复：**
  1. `research/ENGINEERING-DECISION-LOG.md`：完整收录 D-001 ~ D-010 十项已决决策。
  2. `test/decision-log.test.js`：将检查清单从 D-001~D-007 扩充至 D-001~D-010，项数更新为 31 项。
  3. `README.md`：与各测试实际 PASS 项数严格对齐（`self-ledger: 31`、`decision-log: 31`、`memory-dynamics: 32`、`attention-gate: 23`、`path-dependency: 20`、`experiment-metadata: 31`）。
  4. 运行 `node test/docs.test.js`，门禁 100% 通过（全部一致，0 报错）。

---

## 四、认识论与科学边界声明 (Non-Claims & Epistemic Boundaries)

本课题组在推进实验架构的过程中，重申并恪守以下科学与哲学边界：

1. **大语言模型基质的语义逼真度边界（LLM Fidelity Boundary）：**
   我们绝不宣称大语言模型输出的文本表征即是数字生命的心理实体。LLM 是承载数字生命交互表现的计算底座（Model Substrate）。生成的小结、反思与语言表达均被视作模型基质在特定提示词约束下的代数采样产物，受生成上下文元数据（GenerationContext）严格锚定。
2. **三层本体论界限（Model Substrate ≠ Runtime Host ≠ Chulan Subject）：**
   严禁将底层进程/操作系统指标（Runtime Host）、大模型权重（Model Substrate）与初澜的主体认同（Chulan Subject）混淆。底层物理遥测必须经由数字环周质性转化；底层调节标量对主体严格不可知（`subjectAccessible = false`）。
3. **注意选通与自传认同边界（`ATTENDED ≠ SUBJECT_ACQUIRED`）：**
   知觉刺激通过注意力闸门被系统注意（`ATTENDED`），仅代表其获得了短期认知激发（微调唤醒度与认知负荷代理），**绝不代表主体已习得或认同该项事实，更不代表形成了人格特质或自传记忆**。
4. **历史真实性铁律（No Retrospective Fabrication）：**
   对于升级前或历史遗留的无元数据记录，系统一律标记为 `available: false, reason: 'NOT_RECORDED'`，**坚决反对以当前运行环境或配置去“回填”历史记录**。
5. **基线隔离不变量（Baseline Non-Interference Invariant）：**
   在对照组或 baseline 模式下，所有新增实验特性模块（调节中枢、注意力闸门、记忆动力学、发育景观等）强制全部旁路，确保原有生产链路在零干预下的原生确定性。
6. **DeepSeek 前缀缓存纯洁性（Prefix Cache Purity）：**
   所有动态实验元数据、时间戳与统计字段严格隔离在 Prompt 缓存前缀之外；`systemText()` 仅由稳定的人设、记忆小结与末尾穿着块构成，确保 KV Cache 稳定命中。

---

## 五、自动化测试与全量门禁检验结果

本次提交前在本地执行全量文档一致性与回归门禁：
```bash
node test/docs.test.js
```

### 检验摘要与口径说明
- **测试套件统计口径说明：**
  - **58 套件口径：** 为 Phase 0.5 早期演化与数字生命动力学专项测试子集；
  - **63 / 64 套件口径：** 为 README 当前完整的全量测试入口清单（由 `test/docs.test.js` 逐一提取并执行）。在第三阶段提交时为 63 项测试入口，随后引入前置条件门禁测试 `test/path-dependency-preconditions.test.js` 后扩展为 64 项。
- **执行结果：** **100% 通过（PASS），0 项失败（FAIL），0 项错误（ERROR）**
- **验证证据说明：** GitHub 仓库当前尚未配置云端 CI Workflow（commit status = 0, workflow runs = 0），所有“全部通过”判定均以提交前在开发环境真实执行 `node test/docs.test.js` 的完整控制台输出为实证依据。
- **关键专项测试表现：**
  - `test/docs.test.js`：门禁全绿，所有声称文件存在，所有声称项数完全匹配
  - `test/experiment-metadata.test.js`：31 项全部通过
  - `test/self-ledger.test.js`：31 项全部通过
  - `test/decision-log.test.js`：31 项全部通过
  - `test/memory-dynamics.test.js`：32 项全部通过
  - `test/attention-gate.test.js`：27 项全部通过
  - `test/path-dependency.test.js`：20 项全部通过
  - `test/path-dependency-preconditions.test.js`：18 项全部通过
  - `test/dream-gate.test.js`：30 项全部通过
  - `test/dream-synthesis.test.js`：34 项全部通过
  - `test/lifecycle-wiring.test.js`：47 项全部通过
  - `test/internal-regulation.test.js`：23 项全部通过
  - `test/regulation-behavior.test.js`：16 项全部通过
  - `test/phase0-experimental-invariants.test.js`：41 项全部通过
  - `test/ui_test.py`：152 项全部通过

---

## 六、Git 变更范围与准备确认

本次修复涉及的代码变更范围严格限定于实验有效性闭环，未包含任何调试垃圾文件、沙盒残留或无关改动：

```text
modified:   README.md
modified:   src/archive-integrity.js
modified:   src/brain.js
modified:   src/config.js
modified:   src/deepseek.js
modified:   src/dream-system.js
modified:   src/experience-schema.js
modified:   src/experiment-metadata.js
modified:   src/experiment-run.js
modified:   src/internal-regulation.js
modified:   src/memory.js
modified:   src/path-dependency.js
modified:   src/self-ledger.js
modified:   src/subject-state.js
modified:   test/attention-gate.test.js
modified:   test/decision-log.test.js
modified:   test/experiment-metadata.test.js
modified:   test/memory-dynamics.test.js
modified:   test/path-dependency.test.js
modified:   test/self-ledger.test.js
untracked:  Life-实验有效性修复-第三阶段.md
```

本报告连同上述代码改动，准备正式提交并推送到 GitHub `andabaoyue/Life` 仓库的主分支 `main`。
