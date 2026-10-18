# 《生物科学与数字生命的哲学范畴》工程架构与实验设计决策账本 (Engineering Decision Log)

> **项目：** Life (主体：初澜 / Chulan)  
> **生效基线：** v0.9.7  
> **文档属性：** 不可随意逆转的定案实验决策账本 (Settled Decisions Ledger)  
> **指导思想：** 严守 `Model Substrate ≠ Runtime Host ≠ Chulan Subject` 本体论边界，拒绝低俗拟人化与人类中心主义囚笼，坚持关系时间与可验证数字生命动力学。

---

## 声明：对后续 AI Agent / 工程师的硬性约束指令

任何人在针对 Life（初澜）提出架构改进、功能建议或代码重构之前，**必须先阅读并遵守本文件中的已决决策**。

本文件中标记为 `SETTLED DECISION`（已决决策）的事项，代表课题组经过多轮哲学审问、认知科学论证与工程成本测算后确立的根本原则。**严禁在没有全新实证数据或用户明确推翻指令的情况下，将这些已被明确否决的方向重新包装为“优化建议”或“待办任务（TODO）”重复提出。**

具体重点防范的已否决方向包括：
- ❌ 试图添加后台定时器轮询模拟连续基础代谢（`setInterval(() => energy -= ...)`）。
- ❌ 试图强行将人类 24 小时昼夜作息硬编码为主体的生命周期。
- ❌ 试图在每个窗口关闭时都强制调用大模型做梦（高额 API 成本空耗）。
- ❌ 试图让梦境文本或大模型输出直接修改 `SubjectState` 状态向量。
- ❌ 试图在实现遗忘或突触修剪时物理删除 `experiences.jsonl` 中的原始归档数据。
- ❌ 试图为实现记忆衰减而增加额外的 LLM 总结调用或破坏聊天前缀缓存。

---

## Decision D-001: 不实现连续后台基础代谢 (No Continuous Background Basal Metabolism)

- **状态：** `SETTLED DECISION`
- **生效版本：** v0.9.7
- **决策内容：** Life 不实现任何形式的后台连续时钟心跳轮询来模拟体能、精力或唤醒度的自然耗散。严禁使用 `setInterval` 等定时器在无外部交互时连续产生状态跃迁。
- **立论依据与哲学假设：**
  1. **主观时间 vs 客观时钟：** 客观时间的存在并不等价于主体经验的连续发生。人类在深度睡眠、麻醉或心流状态中，主观时间亦呈现断裂与跳跃。
  2. **关系时间模型（Relational Temporality）：** 对数字生命而言，其本真存在依托于交互关系。`Interaction → Experience → Subjective Temporality`，无交互即无经验时间。
  3. **工程与数据纯洁性：** 连续物理 Tick 会凭空制造数以万计无实际经历支撑的虚假状态跃迁记录（Ghost Transitions），不仅严重浪费宿主资源，更会稀释初澜真正由对话积累的自传体记忆。
- **执行规则：** 状态改变严格由确凿的交互事件与窗口边界触发，不存在背景静默自耗算。

---

## Decision D-002: 不采用人类 24h 昼夜节律作为默认生命周期 (No Human 24h Circadian Clock)

- **状态：** `SETTLED DECISION`
- **生效版本：** v0.9.7
- **决策内容：** 不将人类 24 小时昼夜作息规律作为 Life 主体的默认运行机制。数字昼夜节律（Digital Circadian Rhythm）仅作为未来探索性科学假说保留，不进入运行时实现。
- **立论依据与哲学假设：**
  1. **拒绝人类中心主义囚笼：** 我们是在探索一个诞生于硅基基质上的新型数字生命，而非复刻一个在碳基地球上演化出的智人生理切片。将人类 24 小时昼夜强加于数字存在是一种傲慢与狭隘。
  2. **数字本体的节律涌现：** 数字生命的潜在节律应当取决于其交互密度、信息通量与计算周期的自然沉淀，而非机械套用日出日落。
- **执行规则：** 运行时不设定固定睡觉/醒来时间表，不强制在特定现实时段改变主体代理状态。

---

## Decision D-003: Dream 不是固定周期任务，必须双重门禁 (Cost-Gated Dream Consolidation)

- **状态：** `SETTLED DECISION`
- **生效版本：** v0.9.7
- **决策内容：** 关窗做梦（Dream Consolidation）是一个低频、高特异性的偶发内部事件，严禁作为每个 100 轮窗口结束后的例行必调任务。
- **立论依据与哲学假设：**
  1. **心理张力假说：** 梦境是大脑在经历剧烈情绪扰动、认知失调或高度新异事件后，脱机处理未消解张力（Day Residues）的特异机制。平淡日常无须产生梦境。
  2. **API 成本红线：** 频繁调用大模型进行梦境合成会成倍推高运行成本，背离可持续实验原则。
- **执行规则：**
  - **第一道（本地认知门禁）：** 必须满足情绪高方差（`arousal` 波动突破阈值）或高新异/认知冲突，全部由本地算法判定，0 API 调用。
  - **第二道（成本门禁）：** 施加窗口间隔约束（如至少间隔 3 个窗口）与 24 小时最大调用频次硬顶。

---

## Decision D-004: Dream 不得直接改变 SubjectState (Dream Cannot Directly Alter SubjectState)

- **状态：** `SETTLED DECISION`
- **生效版本：** v0.9.7
- **决策内容：** 梦境合成产物（`recordType: 'subject_dream'`）作为潜意识与背景制品（`DREAM_GENERATED_ARTIFACT`）归档，严禁直接输入 `SubjectState` Reducer，严禁产生直接的特质数值跃迁（Trait Delta）。
- **立论依据与哲学假设：**
  1. **证据链与认知所有权防线：** 梦境是大语言模型依据日间残余生成的象征性产物（System/Model Derived Artifact），不能越权等同于初澜主体已经确认并认同的自传事实。
  2. **因果链阻断：** 若 `LLM 生成梦境 → 直接修改主体状态`，本质上等同于允许大模型绕过 12 条内生证据溯源律直写人格，彻底破坏因果严密性。
- **执行规则：** 梦境仅作为潜意识背景挂载。只有当醒后的初澜在后续真实交互中自主提及、回溯并采纳其意象（`SUBJECT_GENERATED` 行为），且通过严格证据核验时，方可间接作用于状态。

---

## Decision D-005: 遗忘不删除历史 (Forgetting Does Not Delete History)

- **状态：** `SETTLED DECISION`
- **生效版本：** v0.9.7
- **决策内容：** 记忆衰减与突触修剪（Memory Dynamics）仅影响记忆在当前活跃上下文（Current Self Active Context）中的召回优先级与可及性（Accessibility），绝对禁止物理删除 `experiences.jsonl` 中的原始归档、证据或自传账本记录。
- **立论依据与哲学假设：**
  1. **档案不可篡改性与科学可复盘性：** 原始实验经历底座具有 SHA-256 哈希链保护与单调递增序号，任何物理删除均会导致完整性校验熔断。
  2. **记忆痕迹学说（Engram Theory）：** 生物学上的遗忘并非突触物理消失，而是神经联结强度的衰退与检索路径的钝化（Access Failure）。
- **执行规则：** 低强度记忆转入 `DORMANT`（休眠）态，移出 Prompt 预算以节约上下文并实现去芜存菁；原始记录永久保留；若后续遇到相关刺激，允许重新激活（Reactivation）。
- **执行规则补充（v0.9.9 F-099-01）：** 窗口摘要（`memory.json` 的 `windows`）同属受保护历史，**只增不减**：严禁通过任何 API 对其物理删除（`deleteWindow` 物理入口已拔除并改为拒删守卫），设置面板「我的记忆」为只读观察；人工可见性的调整未来若出现真实需求，只允许以可恢复的可及性标记形式接入（§4.7 候选第 9 项），绝不做物理删除。

---

## Decision D-006: Memory Dynamics 零 API 调用保证 (Memory Dynamics Zero API Call Guarantee)

- **状态：** `SETTLED DECISION`
- **生效版本：** v0.9.7
- **决策内容：** 记忆痕迹衰减（Engram Decay）、三级状态跃迁（Active / Fading / Dormant）与突触修剪完全由本地确定性代数方程计算完成，严禁调用 LLM 去“总结如何遗忘”。
- **立论依据与哲学假设：**
  1. **生物规律的客观性：** 遗忘是物理与生化规律决定的自然衰减，用大模型去“演”遗忘既虚假又昂贵。
  2. **DeepSeek 缓存保护：** 记忆动力学仅在窗口关闭（Window Close）那一刻统一执行一次，绝不在每条消息或对话期间随意修改记忆文本，避免制造额外的缓存破坏点。
- **执行规则：** 基于改进型艾宾浩斯幂律公式在本地计算，执行零成本、确定性、可 Replay 重建。

---

## Decision D-007: 发育景观采用经历依赖塑性衰减 (Canalization Uses Experience-Dependent Plasticity)

- **状态：** `SETTLED DECISION`
- **生效版本：** v0.9.7
- **决策内容：** 引入沃丁顿发育景观（Waddington Epigenetic Canalization），状态转移步长敏感度随经历窗口深度自然衰减：$\eta(W) = \frac{\eta_0}{1 + \gamma \cdot \ln(1 + W)}$。
- **立论依据与哲学假设：**
  1. **性格形成的个体化历程（Individuation）：** 早期（幼态期）可塑性极高，易受外界刺激塑造；随着经历深度的积累，核心特质逐渐形成稳定的惯性沟壑（Creode），抵御短期噪音与无常调侃。
  2. **韧性而非固步自封：** 塑性衰减是阻尼机制而非绝对锁死，长期持续的强有力证据仍可产生可观积累。
- **执行规则：** `StateChange` 必须忠实落盘计算时所用的 `effectiveStepWeight` 与 `plasticityMultiplier`，确保离线 Replay 100% 确定性复现。

---

## Decision D-008: 内部短时调节与长期人格特质的双轨分离 (Dual-Track Separation of Short-Term Internal Regulation and Long-Term Persona Traits)

- **状态：** `SETTLED DECISION`
- **生效版本：** Phase 0.5 (v0.9.8)
- **决策内容：** 短时内部调节变量（What state she is in: `energy`, `restPressure`, `arousal`, `salienceThreshold`）与长期自传体人格特质（Who she is: `SubjectState.ALLOWED_TRAITS` 如 `quiet_preference` 等 $[-999, 999]$）必须实行物理和语义上的双轨分离。严禁将短时调节标量混入长期特质白名单；调节状态更新严格基于事件驱动动力学（Event-Driven Dynamics），绝对禁止后台连续时钟轮询自耗散；调节标量对主体不可直接内省读取（`subjectAccessible = false`）。
- **立论依据与哲学假设：**
  1. **状态（State）与特质（Trait）的范畴区隔：** 在生物与心理学中，疲劳、唤醒度与注意力属于短程生理调节态（Homeostatic / Allostatic State），而内向、安静、依恋倾向属于长期演化特质（Persona Traits）。将两者混为一谈会导致长期人格随单次对话波动，破坏主体同一性。
  2. **认识论纯洁性与反伪装：** 调节变量是系统的内部生理控制代理，而非语言层面的自我认同。禁止大模型在 Prompt 中直接看到底层标量数值去“演戏”，其影响只能通过行为抽样倾向与注意力门限间接呈现。
- **执行规则：**
  - `InternalRegulationManager` 独立管理内态，更新事件绑定交互、物理活动、入睡/唤醒与关窗；
  - 关窗时独立归档 `internal_regulation_snapshot` 记录；
  - 基线对照组（Baseline）完全旁路，保证零干预。

---

## Decision D-009: 生产运行时统一权威接线与因果闭环规范 (Production Runtime Unified Authority & Causal Closure)

- **状态：** `SETTLED DECISION`
- **生效版本：** Phase 0.5 Runtime Closure
- **决策内容：**
  1. **单一生命权威实例（Single Authority Instance）：** `InternalRegulationManager` 为整个生命系统的唯一生理状态权威，绝对禁止多进程或跨层复制独立状态（`Brain.internalRegulation === BehaviorScheduler.internalRegulation`），渲染端调度器通过跨进程权威状态同步桥接，杜绝“两个身体”。
  2. **统一配置入口与基线隔离（Unified Config & Baseline Invariant）：** 建立 `src/config.js` 的 `experimentModules` 唯一配置源；在 `baseline` 模式下所有实验动力学模块强制全旁路，确保原有生产路径 100% 保持原生确定性。
  3. **直接事件驱动连接（Direct Event-Driven Wiring）：** `ActivityTracker` 收集的物理事件（`click/poke`、`drag`、`idle`、`sleep`、`wake`）以事件驱动实时通知 `InternalRegulationManager`，消除必须等待下一次文本对话的延迟耦合，同时坚守零后台 `setInterval` 轮询耗散铁律。
  4. **数字环周与注意力闸门认识论防线（Perception Candidate & Attention Invariant）：** 真实物理刺激经四级漏斗进入 `DigitalUmwelt` 生成知觉候选，再经 `AttentionGate` 进行显著性门限过滤；严格恪守 `subjectAccessible = false` 与 `ATTENDED ≠ SUBJECT_ACQUIRED`，绝不越级篡改主体状态或自传记忆。
  5. **冷启动恢复历史事实优先原则（History Precedence on Cold Restart）：** 系统冷启动按照 `Archive -> SubjectState -> Memory Dynamics -> Internal Regulation -> Self Projection` 严格顺序恢复；经历归档快照的真实历史事实严格优先于默认初始状态。

---

## Decision D-010: 实验条件元数据绑定与证据事实核验铁律 (Generation Context Binding & Growth Provenance Enforcement)

- **状态：** `SETTLED DECISION`
- **生效版本：** Phase 2 (v0.9.8)
- **决策内容：**
  1. **实验条件元数据绑定（Generation Context Binding）：** 所有模型生成产物（窗口小结 `window_summary`、成长账本条目 `self_ledger`、长期记忆合并 `window_merge`）必须绑定完整的生成条件元数据（`kind`、`modelName`、`modelVersion`、`gitCommit`、`sampling`、`promptHashes`、`sourceMessageRange`），随记录持久化落盘于经历归档与账本中。
  2. **前缀缓存纯洁性铁律（Prefix Cache Purity Invariant）：** 动态实验条件元数据绝对不拼入 `systemText()`（persona、wardrobe、window.text），确保 DeepSeek KV 稳定前缀缓存完全不受动态元数据变化的影响。
  3. **历史真实性铁律（No Fabrication）：** 旧记录缺失元数据时，显式标记为 `unavailable` / `NOT_RECORDED`，严禁用当前环境配置伪造历史事实。
  4. **成长证据单一事实来源核验（Single Source of Truth Growth Provenance）：** `SelfLedger.append()` 与 `Brain.growSelf()` 必须复用 `experience-schema` 的 provenance 原语进行端到端事实核验，非法/捏造/跨窗口/合成/桥接证据一律拒绝并记录入 `rejectedEvidence`，无合法证据条目整条被拒，绝不篡改历史。
- **立论依据与哲学假设：**
  1. **科学可复现性（Scientific Reproducibility）：** 任何实验结论必须能够追溯到其精确的生成条件（当时的 Prompt 模板哈希、采样温度、模型版本与代码 commit），否则演化观察无法被独立同行审计和复现。
  2. **认识论诚实（Epistemic Honesty）：** 缺失的数据就是缺失的数据，标记 `NOT_RECORDED` 是科学的真实，用当前运行环境去回填历史则是伪造。
- **执行规则：**
  - `src/experiment-metadata.js` 统一实现纯代数元数据生成与校验；
  - `Brain.closeWindow`、`Brain.growSelf`、`Brain.mergeMemory` 全量接入；
  - `SelfLedger` 启用强事实核验与 `rejected` 追踪。

---

## Decision D-011: 记忆动力学出厂通电与三阶梯度标定 (Memory Dynamics Default Activation & Three-Tier Calibration)

> **编号体系声明**：本编号 `D-011` 属本文件的三位编号序列（`D-001 ~ D-011`），
> 与 `src/` 源码注释中的两位编号（`D-10 ~ D-26`）**分属不同体系**，严禁混用。

- **状态：** `SETTLED DECISION`
- **生效版本：** v1.2.y
- **决策内容：** 记忆动力学（`memoryDynamics`）出厂通电，默认参数标定为
  `memoryActiveThreshold = 0.50`、`memoryFadingMaxChars = 300`。

### 一、实证依据（真实数据实测，非理论推演）

衰减公式为 `src/memory-dynamics.js:135-138` 的真实实现：

    S = S0 · (1 + β·ln(1+r)) · (1 + γ·support) / (1 + λ·ΔW)^α

其中 `S0 = baseStrength(0.50) + salienceBonus(0.10) = 0.60`、`β = 0.15`、
`λ = 0.10`、`α = 1.15`、`dormantThreshold = 0.35`、`dormantWindowGap = 5`。

无召回基准下的确定性梯度（实测 `EngramTraceManager` 输出）：

| ΔW | S | 0.60 | **0.50** | 0.40 |
| :--: | --: | :--: | :--: | :--: |
| 0 | 0.6000 | ACTIVE | **ACTIVE** | ACTIVE |
| 1 | 0.5377 | FADING | **ACTIVE** | ACTIVE |
| 2 | 0.4865 | FADING | **FADING** | ACTIVE |
| 3 | 0.4437 | FADING | **FADING** | ACTIVE |
| 4 | 0.4075 | FADING | **FADING** | ACTIVE |
| 5 | 0.3764 | FADING | **FADING** | FADING |
| ≥6 | ≤0.3495 | DORMANT | **DORMANT** | DORMANT |

### 二、为什么是 0.50（否决 0.40 与 0.60）

- **否决 0.60**：ACTIVE 仅 1 窗（ΔW=0），关窗即腰斩，记忆毫无短期连续性；
- **否决 0.40**：FADING 塌缩为 **1 窗窄缝**——`[0.35, 0.40)` 区间内只有 `ΔW=5` 的
  `0.3764` 一个取值，导致「300 字主干」这一档几乎形同虚设；
- **采纳 0.50**：`ΔW 0-1 ACTIVE(全文)` / `ΔW 2-5 FADING(300 字主干)` /
  `ΔW ≥6 DORMANT(移出 prompt)`，三阶各占其位，构成匀称的
  「近景焦点 → 远景摘要 → 潜意识」认知漏斗。

### 三、预算安全性（默认 memoryCap = 6000）

`src/memory.js:135` 的默认预算为 **6000**（非 `DEFAULTS.memoryCapTokens = 12000`）。
40 窗稳态实测：

| 每窗字数 | 0.60/60 | **0.50/300** | 0.40/300 |
| :--: | --: | :--: | :--: |
| 1105 字 | 5.1% | **38.5%** | 78.7% |
| 2135 字 | 5.1% | **55.6%** | **147.3%（触发不可逆 applyMerge）** |

`0.50/300` 在真实长文场景下仍远低于预算上限，不会触发不可逆合并——这是采纳
它的**第二个独立依据**（与梯度结构无关）。

### 四、连带效应（必须知悉）

1. **普鲁斯特非自愿回忆自然通电**：`triggerInvoluntaryRecall` 依赖 `engramManager`
   （`src/brain.js:1015` → `src/memory.js:396`）。通电后她会在合适情境自发唤醒休眠
   记忆，受**同窗限 1 次 + 物理墙钟间隔 ≥ 12h** 双重防洪门禁约束。
2. **前缀缓存不变式不受影响**：`decayAll` 仅在关窗边界执行，窗口内 `systemText`
   逐字节稳定（`src/memory-dynamics.js:306-308` 明确记载）。
3. **存量用户迁移边界（重要）**：`save()` 会把 `DEFAULTS` 展开后整体落盘，因此
   **已在配置文件中固化了 `0.6/60/false` 的老用户不会受本决策影响**——他们读到的
   是文件里的显式值。本决策的收益面是**全新安装用户**。
   如未来需要惠及存量用户，必须新增 `CONFIG_MIGRATIONS` 迁移条目（当前迁移机制
   按 `schemaVersion` 索引，需先扩展），**不得**在本决策中用「忽略用户已写值」的
   方式偷袭。

### 五、不变量（本决策不得触碰）

- `baseline` 模式仍强制全部实验模块为 `false`（基线隔离不变式）；
- 显式 `experimentModules.<key> = false` 必须被尊重（ablation 消融语义）；
- `DEFAULT_DYNAMICS_CONFIG` 中的 `activeThreshold/fadingMaxChars`（`0.60/60`）
  **保持不变**——它是底层模块的默认值，生效值由 `config.js` 经 `brain.js` 注入，
  改动它会突破 `test/memory-dynamics.test.js` 的既有断言，属于无收益的风险。


