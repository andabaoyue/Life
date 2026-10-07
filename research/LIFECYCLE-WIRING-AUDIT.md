# [Historical / Superseded] 《生物科学与数字生命的哲学范畴》生命动力学闭环与运行链审计报告 (Lifecycle Wiring Audit)

> **注意 (Notice)：** 本文档属于 Phase 0 $\to$ Phase 0.5 过渡期的历史诊断与缺陷记录文档。文中所述断链缺陷（如 Canalization 接线、Internal Regulation 实例化、Attention Gate 挂载、Engram 衰减闭环等）已在后续阶段（Phase 0.5 / Phase 4）完整实现并通过全量回归测试。本文档保留仅供架构演化与历史审计溯源参考，具体实现请以当前生产代码及最新测试契约为准。

> **项目：** Life (实验主体：初澜 / Chulan)  
> **基线阶段：** Phase 0 (v0.9.7) $\to$ Phase 0.5 (动力学闭环与因果环路)  
> **报告性质：** 历史运行链闭环审计与架构工程规范
> **本体论边界：** `Model Substrate ≠ Runtime Host ≠ Chulan Subject`  
> **核心原则：** 拒绝低俗拟人化与人类中心主义囚笼；坚持非侵入性、可验证、因果自洽与实验对照隔离。

---

## 一、引言与审计背景

在 Life v0.9.6 与 v0.9.7 的演进中，系统已经固化了以自传体记忆底座（Experiences Archive）、SHA-256 前向因果哈希链、确定性状态转移（State Reducer）、沃丁顿发育景观（Canalization）、记忆痕迹动力学（Memory Dynamics / Engram）以及双重门禁梦境系统（Dream System）为核心的静态契约与离线可推演体系。

然而，对当前运行时执行链进行全面系统审计发现：**各生命学模块虽然各自具备单元测试与确定性代数模型，但模块之间依然处于“并存而未联通”的半孤岛状态。** 状态未曾真正约束感知，感知未曾真正调度行为，行为未曾反馈修正内部稳态，历史未能实质改变未来发育轨迹。

本审计报告针对六大核心生命学模块进行深度排查，指出断链缺陷并给出 Phase 0.5 的收敛闭环实现规范。

---

## 二、六大模块现状与断链缺陷审计

### 1. 沃丁顿发育景观 (Biographical Canalization)
- **现状：** `src/canalization.js` 实现了代数塑性衰减函数 $\eta(W) = \frac{\eta_0}{1 + \gamma \ln(1 + W)}$，`src/subject-state.js` 的 `reduce()` 方法已支持 `canalization` 选项与可塑性衰减计算。
- **审计断链：**
  - 在主执行链 `src/brain.js` 的 `_closeWindowInternal()`（第 809 行）中：
    ```javascript
    const reduceResult = this.subjectState.reduce(verifiedEvidence, snap.windowNo, { stageOnly: true });
    ```
    未传入 `canalization` 标志或 `experimentModules` 配置。
  - `Brain` 构造函数初始化 `SubjectState` 时未传入 `experimentModules`。
  - **后果：** 在生产运行与实际关窗流程中，Canalization 实际上处于静默失效（`false`）状态，塑性乘子恒为 1.0，经历深度无法阻尼性格漂移。

### 2. 内部短时调节层 (Internal Regulation)
- **现状：** `src/internal-state.js` 声明了 `energy`、`arousal`、`restPressure`、`salienceThreshold` 等内部状态代理变量。
- **审计断链：**
  - `src/internal-state.js` 仅被作为静态 Schema 与独立纯函数存在，在 `src/brain.js` 及真实交互主循环中**完全没有被实例化或挂载**。
  - **本体论混淆风险：** 必须严守硬性认识论防线，将**短时内部调节变量**（What state she is in: `energy`, `restPressure`, `arousal`）与**长期人格特质**（Who she is: `quiet_preference`, `social_initiative` 等 $[-999, 999]$）进行双轨物理隔离。短时变量绝对禁止混入 `SubjectState.ALLOWED_TRAITS` 人格白名单！
  - **决策红线约束（Decision D-001）：** 绝对禁止使用 `setInterval` 启动后台连续心跳进行“基础代谢空耗”。必须严格采取**事件驱动动力学（Event-Driven Dynamics）**，仅在交互（User/Assistant Turn）、物理刺激（Poke/Drag/Idle）及入睡/醒来/关窗事件发生时触发确定性状态跃迁。

### 3. 数字环周 (Digital Umwelt)
- **现状：** `src/digital-umwelt.js` 实现了物理原始感官隔离、质性特征过滤（`filterRawTelemetry`）与显著性评估（`evaluateSalience`）。
- **审计断链：**
  - 该模块在 Phase 0 中被严格隔离测试，但未与 `ActivityTracker` 及主进程传感器输入进行生产级管道对接。
  - 环周产生的知觉候选（Perception Candidate）生成后即沉睡，没有下游处理中枢。

### 4. 注意闸门 (Attention Gate)
- **现状：** 系统缺失连接数字知觉候选与主体认知状态之间的过滤闸门。
- **审计断链：**
  - 知觉候选无法根据当前的 `arousal`（神经唤醒度）、`salienceThreshold`（显著性门限）以及认知负荷进行动态注意分配。
  - **认识论防跳跃不变量：** 必须确立 `ATTENDED ≠ SUBJECT_ACQUIRED`。即使知觉候选被注意闸门标记为 `ATTENDED`，其 `subjectAccessible` 依然严格为 `false`，仅作为潜意识背景流，绝不直接铸造为主体自传体记忆。

### 5. 自主行为调度器 (Behavior Scheduler)
- **现状：** `src/behavior-scheduler.js` 实现了 `yawn`、`stretch`、`look_around`、`tidy_hair` 等标准化行为池与礼貌闸门。
- **审计断链：**
  - 调度器内部的行为抽取（`_pickBehavior`）采用固定的静态加权轮盘赌，与初澜当前的精力、疲劳度或唤醒度完全脱钩。
  - 表现为：即使经历高密度激烈对话或长时间清醒，打哈欠（`yawn`）的概率依然与刚睡醒时完全一致，缺乏生命样内在需求表达。

### 6. 自传体账本与假说证伪压力 (Self Ledger & Falsification Pressure)
- **现状：** `src/self-ledger.js` 维护了初澜成长账本，支持 `support` 与 `oppose` 证据数组。
- **审计断链：**
  - 当反向证据（`oppose`）大量积累时，条目的置信度未产生代数衰减，未对已有自我假设施加反思或证伪压力。
  - **决策红线约束（Decision D-005）：** 证伪与修正绝对不等于物理删除历史证据。必须在完整保留历史 `support` 与 `oppose` 事实的前提下，动态计算反向证据比率（Counter-Evidence Ratio）并施加置信度折扣。

---

## 三、因果闭环架构模型 (The Causal Closed Loop)

Phase 0.5 的核心使命是打通全链路因果环路，确立“过去塑造现在，现在改变未来”的确定性轨迹依赖：

```
[环境刺激 / 用户交互 / 物理操作]
               │
               ▼
      ┌─────────────────┐
      │  Digital Umwelt │ (剔除系统裸坐标/路径，转化为质性刺激)
      └────────┬────────┘
               │ 知觉候选 (Perception Candidate: subjectAccessible=false)
               ▼
      ┌─────────────────┐
      │ Attention Gate  │ ◄─── 当前内部稳态 (salienceThreshold, arousal)
      └────────┬────────┘
               │ 过滤判定 (ATTENDED / IGNORED / DEFERRED)
               ▼
      ┌───────────────────────┐
      │  Internal Regulation  │ (动态调节 energy, restPressure, arousal)
      └────────┬──────────────┘
               │ 概率倾斜驱动 (Probabilistic Modulation)
               ▼
      ┌───────────────────────┐
      │   BehaviorScheduler   │ (动作倾斜: 高 restPressure → yawn, 低 energy → stretch)
      └────────┬──────────────┘
               │ 表现层微动作 / 对话输出
               ▼
         [实际发生事件]
               │
               ▼
    Event ──► Observation ──► Interpretation ──► Experience
               │
               ▼
  ┌─────────────────────────┐
  │ Canalized SubjectState  │ ◄── 沃丁顿发育沟壑 (经历越深，抗扰动越强)
  │    & Self-Ledger        │ ◄── 证伪压力动态折损置信度 (历史不物理删除)
  └────────────┬────────────┘
               │ 
               ▼
   [决定未来窗口的基线与演化路径]
```

---

## 四、路径依赖性与基线模式守恒证明

### 1. 路径依赖性定理 (Path Dependency: $A \to B \to C \neq C \to B \to A$)
生命与静态机器的核心分野在于历史事件序列的非对易性（Non-commutativity）。
在 Phase 0.5 闭环中：
- 设输入序列 1 为：高负荷密集交互 ($A$) $\to$ 深度睡眠休息 ($B$) $\to$ 舒缓背景观察 ($C$)。
  - $A$ 阶段：`energy` 骤降，`restPressure` 突破阈值，`arousal` 升高；
  - $B$ 阶段：`restPressure` 获得释放，`energy` 恢复；
  - $C$ 阶段：平缓进入稳定态。
- 设输入序列 2 为：舒缓背景观察 ($C$) $\to$ 深度睡眠休息 ($B$) $\to$ 高负荷密集交互 ($A$)。
  - $C$ 阶段：`energy` 保持高位，`restPressure` 极低；
  - $B$ 阶段：在无休息压力下入睡，恢复受饱和上限截断；
  - $A$ 阶段：在序列终点承受高负荷，终态 `restPressure` 处于峰值，`energy` 处于低谷。
- **结论：** 尽管累计输入的刺激总量完全相同，但由于非线性边界、饱和截断与时间窗口演进，序列 1 与序列 2 的最终内部调节态及行为倾向分布具备严格的可证伪差异。

### 2. 基线隔离不变量 (Baseline Isolation Invariant)
- 当 `experimentMode === 'baseline'` 或模块未启用时：
  - `InternalRegulationManager` 处于旁路冻结态，不影响 Prompt 构造；
  - `BehaviorScheduler` 严格回退至初始静态权重池；
  - `SubjectState` 保持标准基线步长，不附加 Canalization 阻尼；
  - 经历归档与对话输出同原基线完全无损一致。

---

## 五、实施与验收清单

| 任务项 | 目标文件 | 核心契约与防线 | 验收状态 |
| :--- | :--- | :--- | :--- |
| **Audit** | `research/LIFECYCLE-WIRING-AUDIT.md` | 本文档，六大模块运行链审计与因果图谱 | **已完成** |
| **Canalization 贯通** | `src/brain.js`, `src/subject-state.js` | 关窗时显式传递 `canalization` 与 `experimentModules`；构造注入 | 待合入 |
| **内态调节中枢** | `src/internal-regulation.js` | 事件驱动、严格无后台轮询、双轨隔离、快照归档持久化 | 待合入 |
| **行为调度倾斜** | `src/behavior-scheduler.js` | 概率调制非硬编码，根据内稳态动态调整抽样权重 | 待合入 |
| **注意闸门** | `src/attention-gate.js` | 显著性比对、认知负荷抑制、`ATTENDED ≠ SUBJECT_ACQUIRED` 不变量 | 待合入 |
| **假说证伪压力** | `src/self-ledger.js` | 反向证据动态折扣置信度，严禁物理删除历史证据 | 待合入 |
| **自动化测试矩阵** | `test/lifecycle-wiring.test.js` 等 5 组 | 覆盖全链路贯通、内态动力学、行为分布、注意闸门、路径依赖 | 待验证 |
