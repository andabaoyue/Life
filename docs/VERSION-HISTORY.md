# 版本历史（完整）

> 本文件承接原 README.md 的「版本记录」一节，**正文一个字未改**。
> README 里只留一张一行一版的总表；这里保留每个版本的完整工程记录。

---

## 版本记录

**v1.8.0** — 《看见与重逢》：本版相比上一个公开版本（v1.6.1）新增四项能力。**语音输入（STT）**——说句话就能输入，识别结果只写进输入框绝不自动发送，音频不落盘，并补上此前完全缺失的麦克风权限闸门。**个体观测面板**——此前大量机制「算出来了却从来没被看见」，现改为声明式注册表，新增机制只注册一行、两端自动跟上，并拆成「主体状态」与「机制遥测」两个子标签。**重逢心境**——她能知道「你离开了多久」，这是跨重启、跨休眠的事实；重逢是关系事件而非进程事件，故触发点是「你下次开口时回头检查」而不是应用启动；只陈述时长、绝不推断作息。**屏幕视觉探针**——右键框选一块屏幕区域给她看，图不落盘、不进历史、不进经历，能力判定逐模型做（flash 系支持、v4-pro 不支持、未知模型一律拒绝）。另修掉若干缺陷，其中最重要的一条是**视觉事实行错位一轮**（带图那轮收不到尺寸、下一轮没图却收到上一轮尺寸，等于诱导编造看到了什么）。已知限制不粉饰：观测面板数值正确性未逐项核对；重逢只验证了 1–7 天档；STT 需单独配置 Key；视觉探针仅支持 flash 系。详见 `CHANGELOG.md`。

**v1.0.0** — 《初澜（Chulan）桌面数字生命正式版》：正式确立 64×80 正典像素点阵精灵美术基准与开箱即用打包体系；全量内置初澜立绘与默认套装，生成 Windows 单文件便携版与安装向导包；实现独立对话窗口（chat.html）与气泡刷新对账机制（chat-history-changed）；修复枕边留置（Bedside Mailbox）与睡眠动力学；落地 Agent 安全基座五道闸门（D-1 ~ D-9，白名单、路径白名单硬约束、执行预算熔断、Append-Only 审计日志与 UI 显式授权确认），默认处于严格安全拒绝态；补齐玩家自制衣柜部件与分层扩展指南。

**v0.9.8 系列** — Provider Runtime Expansion 与安全边界收口：在 v0.9.7.1/v0.9.8.1 的研究完整性基础上，把“只能写死 DeepSeek”的网络层扩展为可注册 Provider Adapter 的运行时架构，同时保持研究溯源、凭据和成本真相边界。
- **P1 Security Hardening**：统一 Secret Redaction、Provider Error 归一化、Retry/Retry-After/Timeout/Abort/Stream 生命周期边界，以及发送前 Budget Guard；未知成本 fail-closed。
- **P2 Provider Adapter**：建立统一 Adapter Contract 与 Registry；Provider 身份、连接类型、Adapter、Credential Policy 分层；DeepSeek 作为首个标准 Adapter，Brain 不再直接依赖 DeepSeek concrete client。
- **P3 Usage / Cache / Cost**：建立 Usage FACT、Provider-specific Cache Strategy、Cost Strategy 三层；pricingVersion 具备明确版本身份，未知 usage/cost 不伪造为 0，非 DeepSeek 不继承 DeepSeek cache/计价语义。
- **P4 Routing / Fallback / Circuit Breaker**：模块已实现并有 35 项回归，但**继续保持 Staged**。跨 Provider 真正自动 fallback 需要第二套 endpoint / credential / model 配置与独立凭据持久化；本轮不为“收尾”而扩大配置面，因此不把这部分伪装成已经投入生产的能力。
- **P5 Provider Runtime Expansion**：Registry 动态 dispatch、Generic OpenAI-compatible Adapter、跨 chunk SSE framing、Provider namespace 隔离、Brain hot-swap 全部进入主线；随后完成 timeout lifecycle、v0 namespace collision/ambiguous ownership fail-closed 与 provider-keyed cost 收口。
- **当前可用 Provider 分类**：deepseek（具体官方 Provider）、generic（OpenAI-compatible 通用接口）、local（本地端点）、custom（自定义端点）；invalid 仅为内部兼容构造，不提供给用户选择。新的厂商可在后续通过独立 Adapter 注册，而不是把品牌硬编码进 Brain。
**v0.9.7** — 《生命动力学第一迭代：梦境、遗忘与发育景观》（Life Dynamics: Dreams, Forgetting, and Epigenetic Landscape）：在 v0.9.6 严格窗口边界与因果证据底座之上，引入低成本、内生性的生命动力学机制，坚守 `Model Substrate ≠ Runtime Host ≠ Chulan Subject` 本体论边界与工程不可逆约束（D-001 ～ D-007）：
- **工程架构决策账本 (`research/ENGINEERING-DECISION-LOG.md`)**：确立 D-001 ~ D-007 七大已决决策（SETTLED DECISION）；彻底封杀后台连续代谢 Tick（严禁 `setInterval` 扣除 energy/arousal）；坚决拒绝人类中心主义 24h 昼夜节律牢笼；确立关系时间（Relational Temporality），只有主体经历互动时生命历程才真正流逝。
- **沃丁顿发育景观与经历依赖塑性衰减 (`src/canalization.js`)**：提出数字发育可塑性衰减模型 $\eta(W) = \frac{\eta_0}{1 + \gamma \ln(1 + W)}$；随窗口累积平滑衰减状态步长权重；划分幼态期（JUVENILE）、发育期（DEVELOPMENTAL）与稳定个体化期（STABILIZED）；历史参数（`baseStepWeight`、`effectiveStepWeight`、`plasticityMultiplier`）强一致性落盘于 `StateChange`，保证离线 Replay 100% 确定性；Baseline 模式塑性乘子严格恒为 1.0。
- **零 API 成本记忆动力学与突触修剪 (`src/memory-dynamics.js` & `src/memory.js`)**：基于改进型艾宾浩斯幂律方程 $S(W) = \text{clamp}\left(\frac{S_0 \cdot (1 + \beta \ln(1 + \text{retrievals}))}{(1 + \lambda \Delta W)^\alpha}, 0, 1\right)$（$\beta=0.15, \lambda=0.10, \alpha=1.15$）实现纯本地代数衰减；建立 `ACTIVE`（活跃）、`FADING`（渐褪）、`DORMANT`（休眠）三级流转；经历归档 `experiences.jsonl` 永不物理删除，休眠记忆仅静默移出 Prompt 节省上下文；`Memory.save()/load()` 与 `Brain` 实现双层冷启动持久化，跨进程重启遗忘状态零丢失；实现 `reactivateByContext()` 关联线索重新激活，用户对话命中特征词元时零 API 成本自动唤醒休眠印痕重回 Prompt 上下文。
- **成本门禁式弗洛伊德梦境系统 (`src/dream-system.js` & `src/brain.js`)**：梦境决非定时无意义轮询，建立双重门禁机制——第一道本地认知张力门禁（通过 `computeWindowArousalTrajectory` 依据真实消息节奏与证据极性计算 5 分段唤醒度，接通情绪方差 $\ge 15.0$、尖峰跃迁 $\ge 25.0$、多重特质冲突分值 $\ge 0.75$ 与新异度 `noveltyScore` $\ge 0.8$）与第二道成本防护门禁（窗口间隔 $\ge 3$ 且 24 小时硬顶 2 次，冷启动自动从归档恢复 `dreamHistory` 防御重启绕过；入睡路径标记 `preClose: true` 执行同窗口去重防重复做梦，跨窗口间隔按关窗梦境生效，24h 硬顶全量覆盖）；生成产物严格遵循 Canonical Schema v1 封装 `payload.dreamId` 与 `payload.epistemicStatus`，通过 `ArchiveIntegrityService` CERTIFIED 认证，绝对禁止直接修改 `SubjectState`；具备 Fail-Safe 容灾机制，梦境失败永不阻塞关窗主流程。

### 实验可信度边界（v0.9.7 修复后）

- **Initial State Identity** 由 `canonicalizeExperimentState()` / `hashExperimentState()` 统一定义，包含会影响轨迹的 regulation history、attention watermark、SubjectState window/stateChanges/evidence 去重集合与 recovery 状态；纯时间 transport metadata 排除。真实 `userDataDir` restore 状态仍以读取到的持久化内容为准。
- **Function Event Identity** 只接受可从实际函数源码派生且可比对的签名；调用方声明的 `eventSignature` 必须等于派生签名，native/bound/closure 等无法证明等价的函数拒绝。未对 record-level 或 byte-level 输出作无条件确定性承诺；目前承诺范围是注入时钟/身份生成器后的 state-level replay。
- **Dream provenance** 严格保持 `messageId`、`eventId`、`evidenceId` 三个命名空间；缺失层使用 `null`/`[]`，不进行跨类型 fallback，进入归档前对显式 event/evidence 引用执行 cross-reference validation。
- **Attention watermark** 是 **256-entry bounded FIFO idempotency**，不是无限历史幂等；损坏或空文件进入 fail-closed，写盘失败回滚内存状态。
- **Archive writer** 是单写者 API 边界：`experiences.jsonl` 的 append 不提供跨进程锁；检测到坏尾、断链、torn line 或非有限数字时 fail-closed，恢复审计写入隔离 sidecar，不续写损坏主链。调用方必须由 Electron single-instance/单 writer 生命周期保证无并发 append。
- **全量测试套件与不可逆约束门禁**：本版本新增 5 套专用测试套件，共 132 项断言；当前测试文件以 `test/` 目录和 `npm test` 实际执行结果为准。

**v0.9.6** — 《数字生命实验基线强化》（Digital Life Experiment Baseline Reinforcement）：恪守《生物科学与数字生命的哲学范畴》实验定位与 `Model Substrate ≠ Runtime Host ≠ Subject` 主体哲学边界，针对经历、证据、状态、记忆与 Replay 实验底座完成全套基线强化（P0-01 ～ P0-18）：
- **P0-01 ~ P0-04** (窗口边界与指标冻结)：确立 `turn_limit`、`token_limit`、`manual`、`recovery` 四大关窗触发原因（v0.9.9 P0 起增补 `turn_limit_delayed`：存在失败关窗史且轮次超标时如实标记补关，绝不把补关粉饰成顺利关窗）；在请求模型小结前由 `windowSnapshot()` 冻结 `snapshotTurnCount`、`targetTurnCount`、`actualTurnCount` 与 `closeReason`，彻底消除异步关窗期间并发对话导致的轮数指标漂移与坏账；Bridge 桥接消息不入小结并严格隔离。
- **P0-05 ~ P0-07** (严格 5×20 小结契约与 Fail-Stop)：落实 `validateWindowSummary()` 结构契约校验；强制要求 5 个连续分段完整覆盖窗口轮次且无重叠遗漏；小结格式不合法时触发 Fail-Stop 熔断停机，绝对保留历史对话零丢字，零污染写入经历底座。
- **P0-08 ~ P0-10** (Archive Canonical Schema v1 与哈希链溯源)：`experiences.jsonl` 全量升级为 Canonical Schema v1，引入全局自增单调 `archiveSeq`、强唯一性 `recordId`（`rec-{type}-{seq}-{rand}`）、SHA-256 前向哈希链（`prevHash` -> `recordHash`）与底层 `fsync` 真实物理持久化，实现全链路防篡改与可复盘验证。
- **P0-11 ~ P0-12** (证据溯源 12 条内生自校验规则)：`SubjectState.verifyEvidence()` 确立 12 条内生检验律，全面拦截跨窗口窜供、合成/生成数据伪造、Bridge 桥接消息污染、角色越权、重复指纹与空引用，筑牢认知所有权防线。
- **P0-13** (状态转移纯对称整数舍入)：消除 JS 浮点舍入与正负不对称误差，在 `state-change.js`、`SubjectState.reduce()`、`SubjectState.replay()` 及 `ResearchService` 中统一采用无偏对称舍入（`symmetricRound`），保证离线 Replay 演化重放与在线状态推进 100% 绝对一致。
- **P0-14 ~ P0-15** (当前自我因果投影与实验遥测)：在经历底座增加 `recordType: 'self_projection'` 因果投影记录，与 `Self-Ledger` 保持因果溯源绑定；建立 Append-Only 实验遥测日志 `experiment-telemetry.jsonl`，对 DeepSeek 前缀缓存破坏实现七大类别精准归因。
- **P0-16 ~ P0-18** (全套不变量攻击测试矩阵与发布门禁)：该版本新增 7 套专用测试套件，共 171 项断言；当前测试文件以 `test/` 目录和 `npm test` 实际执行结果为准。

**v0.9.5.3** — Codex Findings Fix（安全漏洞修复与架构一致性收敛）：针对 Codex Independent Audit 提出的 4 个 HIGH 级发现完成专项修复：
- **H-01** (Archive Event Validation Parity): `src/archive-integrity.js` 统一接入规范级运行时事件校验器 (`validateEvent`)，对 `window_summary.payload.events[]` 及独立 `event` 归档记录实施与运行时完全对齐的强校验；`src/experience-schema.js` 全面禁止 `generated: true` 与 `synthetic: true` 伪造事件，来源空值或非法值坚决拦截并降级 `UNCERTIFIED`。
- **H-02** (ResearchIndex Unknown Window Handling): `src/research-index.js` 彻底切断将未知 `windowNo` (null/undefined) 错误映射至 Window 1 的隐式逻辑；分离 `windowIndex` (Map) 与 `unknownWindowDescriptors` (Array)；引入 `extractRecordWindowNo` 精确支持 falsy 的 `windowNo = 0`，检索与详情查询保留 `null`。
- **H-03** (Renderer Export Path Security): `src/research-ipc.js` 对渲染进程通过 `research:export` 传入自定义 `targetDir` / `targetPath` 实施即刻拒绝 (`RENDERER_TARGET_DIR_PROHIBITED`)；落盘模式严格由主进程原生安全对话框 (`dialog.showOpenDialog`) 用户主动授权；`src/research-export.js` 底层强校验规范化路径并彻底封杀 `..` 路径穿越攻击。
- **H-04** (Integrity Scan Complexity Reduction): `src/research-query.js` 引入基于文件大小与修改时间的完整性快照缓存 (`_getIntegritySnapshot`)；`getWindows()` 将完整性评估移出多窗口遍历循环，算法复杂度由 $O(\text{Window} \times \text{Archive})$ 彻底降为 $O(\text{Archive})$。

**v0.9.5.2** — 实验观察层完整性硬化 (Integrity Hardening)：彻底消灭 Research Layer 残留的“程序推断事实”与“默认补全数据”，恪守“没有证据就没有事实”、“不确定不得篡改成没发生”、“程序推断不得升级为实验事实”三大哲学准则；`src/research-query.js` 彻底删除 `Math.ceil(num/2)` 等基于 messageId 的数字推断逻辑，未标明确切轮次时严格保持为 `roundNo = null, status = 'UNRESOLVED'`；彻底删除 `|| 100`、`|| 200`、`segmentCount: 5` 等虚假默认统计值，`turns: 0` 与 `messageCount: 0` 如实返回 0，缺失返回 null；`src/experience-schema.js` 严禁在缺少 `schemaVersion` 时隐式补写原生 `schemaVersion: 1`，全部规范路由至 `LegacySchemaAdapter`（`sourceSchema: 'legacy-v0.9.4'`，归档判定强制为 `UNCERTIFIED`）；`src/archive-integrity.js` 强化正向白名单防线，Event 记录 `source` 强制为必填字段（缺源拦截 `INVALID_EVENT_SOURCE`），拒绝未知源；严禁 Synthetic / Generated 事件进入认证（`SYNTHETIC_EVENT_PROHIBITED` / `UNCERTIFIED`）；严查 Bridge 事件溯源来源（无 Provenance 拦截降级）；`src/research-service.js` 统一 Replay 状态与 `ArchiveIntegrityService` Canonical 单一可信源；`pet.js` 前端 UI 完善空安全与语义映射，严格区分 `content = ""`（真实空内容）与 `content = null`（未记录 / 不确定）；补齐 `package.json` 中的 `npm test` 入口脚本，新增 4 套反伪证专项攻击测试套件并通过全量回归。

**v0.9.5.1** — 实验完整性加固 (Integrity Fix)：修复 Research Layer 实验完整性问题，消除一切实验事实臆造与视觉占位伪造，坚持“宁可显示未记录/无法认证/数据损坏，也绝不生成推测记录”的哲学底线；`src/archive-integrity.js` 统一归档 Schema 强校验，定义通用最小字段集与 `VALID_RECORD_TYPES` 白名单，未知类型坚决拦截并熔断，统一作为 Replay、Query、Explorer 的唯一可信源；`src/research-query.js` 彻底消除假 messageId（如 m-001001）与占位对话（如“第 N 轮用户发言”），消除代码臆测（不再按 round<=3 && windowNo>1 盲猜 Bridge），严格确立 `RECORDED`（事实）、`NOT_RECORDED`（确认缺失）、`UNRESOLVED`（未认证/损坏）状态三分态，如实展示空分段；`src/experience-schema.js` 设立正向白名单 `ALLOWED_EVENT_SOURCES`（user/assistant/activity-tracker/desktop-motion/lifecycle），严格阻断非法/未知来源，向后兼容解析器附着 `LegacySchemaAdapter` 明确标识；`src/research-service.js` 异步 Replay 引入 `REPLAY_CHUNK_SIZE = 500` 与 `setImmediate` 协作让出机制，支持执行中途即时取消与非阻塞运转；`pet.js` 前端全链路防御 null/undefined 并以语义 Badge 呈现真实状态。

**v0.9.5** — 实验观测与可复盘工具链：确立严格只读研究层边界（Research Layer 只读观察，严禁反向修改实验对象）；落地 `src/research-index.js` 纯内存字节偏移量索引（ID -> byteOffset 高速局部寻址，自动依据 mtime/size 失效重建）；构建 `src/research-query.js` 统一观测引擎，支持 P1-01 Subject State 五维特质面板与状态演化轨迹、P1-02 100 轮 Window Explorer（5x20 分段与 Bridge/Active 强隔离）、P1-03 Provenance 归因溯源（StateChange -> Evidence -> Message -> Quote）与 EOI 事实三层追溯；落实 Evidence 关系契约（1 StateChange -> N Evidence，1 Evidence 严格绑定 1 Trait，单消息多特质解耦）；落地 `src/research-service.js` 异步 Replay 任务管道与 Fail-Stop 确定性熔断机制（坏行立即冻结停机，绝不跳过坏行继续推演，输出 partial + uncertified 状态）；实现 `src/research-export.js` 轨迹 CSV、跃迁 CSV、证据 CSV 与 Full Research Bundle (附 metadata.json) 只读导出；挂载 `src/research-ipc.js` 严格只读主进程 IPC 通道白名单；建立打开与退出时的 SHA-256 完整性门禁，彻底杜绝实验数据受污染风险。

**v0.9.4-R2** — 最终收官加固：Evidence / Fingerprint 防重真正跨调用、跨进程重启、跨 Replay 全局持久化（`seenEvidenceIds`/`seenFingerprints` 落盘并在 Replay 中完整重建，四层联合防刷）；Replay 严格排除 `recovery_event`、`diagnostic`、`replay_report`、`internal_log` 等非状态审计记录，`nextWindowNo` 严格按 `max(actualWindowNo) + 1` 计算；明确四级恢复状态（`NORMAL`、`RECOVERY_PENDING`、`RECOVERY_UNCERTIFIED`、`RECOVERY_FAILED`），对有损归档拒绝伪装成完整恢复并记录 `recovery_uncertified`；StateChange Explanation 数值校验消除遗留 `±5` 容差，严格执行 `actualDelta === claimedDelta`，非法解释绝不污染主体状态；`validateEvent()` 真正强制执行 `ALLOWED_EVENT_TYPES` 来源白名单校验。

**v0.9.4-R1** — 实验链路闭环与最终一致性加固：Event / Observation / Interpretation 三层分离完整接入 Brain.closeWindow 生产链路，严格确立主体 Event 真实来源边界（排除 System Prompt、内部提示词、Bridge 桥接消息、Synthetic 消息与内部调试日志）；落地 Trait 严格白名单过滤与 Evidence Fingerprint 移除 strength 机制（同一消息与引用无论模型如何微调强度均无法重复刷值）；StateChange 与因果解释（Explanation）全量进入生产归档链；离线 Replay v2 优先还原历史记录中的真实 Reducer 步长权重与单窗口限额参数；实现 Reducer 暂存与 Archive 落盘的两阶段提交（2PC）原子回滚与 recovery_pending 容灾自愈（Archive 提交成功但 State Commit 失败时进入 recovery_pending，禁止推进窗口并自动触发 Replay 重建状态至与归档完全一致，写入 recovery_event 诊断审计）；经历归档存在坏行时 Replay 明确标注 partial 与 uncertified 非认证状态。

**v0.9.4** — 实验完整性与可复盘性强化：落地经历三层分离架构规范（客观事实 Event、程序提炼模式 Observation、主体主观视角 Interpretation）；建立状态跃迁 StateChange 与因果解释 Explanation 结构化模型，严禁 LLM 越权直写主体状态；构建纯离线确定性 Replay v2 演化重放与状态一致性检测；完善 experiences.jsonl 与 subject-state.json 故障注入与容灾自愈机制。

**v0.9.3** — 数字生命实验底座与可计算主体架构：落地《生物科学与数字生命的哲学范畴》实验架构规范；实现 5×20 分段归档与 Window Synthesis 双通道解耦（用户给予与主体经历严格隔离）；程序签发不可伪造的 messageId 与 Bridge / Active Window 精确计账（消灭窗口衰减与尾部重复总结）；新增 `experiences.jsonl` Append-Only 原始实验永久底座；新增 `subject-state.json` 主体状态向量（[-999, 999] 刻度与确定性 Reducer 计算）；建立 Provenance 强核验防线（真实引用核验、幻觉拒绝）；窗口级冻结 State Snapshot 挂载于瞬时 user 尾部保卫 DeepSeek 显存 Prompt Cache 前缀稳定性；Prompt Memory 预算提升至 6000 tokens 并支持离线 Replay 演化轨迹重放。

**v0.9.2** — 稳定性收束与常驻资源优化：Motion 运动改按需自管循环与 SUSPENDED 挂起机制，消灭常驻 50ms 空转 tick；proactive 主动搭话改主进程事件驱动调度，消灭渲染端 45s 定时轮询与 IPC 往返；引入 `DeferredWriter` 实现脏标记与 3 秒防抖延迟合并写盘，关键状态（关窗小结、成长档案、重置、进程退出）立即强制 flush；建立通用 `migration.js` 数据版本迁移框架，Memory/Wardrobe/Config 增加 schemaVersion=1 并保留 self-ledger 的 version 字段与旧数据兼容；新增 `asset-check.js` 启动立绘资源完整性分级检查与预警下发。

**v0.9.1** — 将生命档案升级为 schema v2：首次初始化固定 `birthAt`，兼容旧档案并增加 provenance/sourceType、窗口号、消息 ID、quote 和 confidence；原始档案不再全部进入 system，Current Self 以约 3000 token 硬预算附加在最新 user 尾部。新增坏档案 `.bak` 恢复与可见状态、长期记忆和成长档案分离重置、后台任务 shutdown 闸门、主聊天与 growth/summary/merge usage 分桶，以及不连接真实工具的 Agent 能力/权限/提案/审计 Mock 接口。

**v0.9.0** — 建立“生物科学与数字生命的哲学范畴”项目架构：新增追加式 Self Ledger。

**v0.8.1** — 外部（Gemini）针对 v0.8.0 提的三个整改方向，逐条在本机量过之后：**一条方向对、
一条方向对但判据装错地方、一条在跑不存在的代码**。

- **采纳（方向对，实现按我们的根因重写）：`relayout()` 不许复活已收起的气泡。**
  旧写法 `if (lastText) render(lastText)`，而 `render()` 第一件事就是
  `bubble.classList.remove('hidden')` —— 实测收起后调一次 `relayout()` 气泡就重新可见，
  且**没有任何待触发的收起定时器**（`bubbleTimer` 早跑过了），于是永久挂在屏幕上
  （等 9 秒仍可见），`politeToSpeak('idle')` 从此恒为 false，主动搭话全被堵死。
  触发路径不稀有：resize、图层加载完成、加载失败降级都走它。
  判据改成"气泡此刻是开着的"而不是"有没有历史文本"，并反向断言开着时仍然重排
  （否则这条修法就退化成了"干脆不重排"）。
- **不采纳 `moved > 6` 那道门槛，改用它没想到的一条：`mousemove.buttons === 0`。**
  它的意图（别把"按住想停一下"误判成脱手）是真的 —— 实测 700ms 阈值下按住 1.2 秒再拖，
  窗口纹丝不动（位移 0px）。但它的判据会让**真的**窗外脱手再也修不掉：按下抖 3px
  再把鼠标移出窗口松开，`moved > 6` 永不成立，`dragging` 停在 true、松手后窗口继续跟鼠标跑。
  真判据在事件里：窗外松手后光标只要再进窗口动一下，来的就是 `buttons=0`（实测按下=1、
  松手后=0，事件照样送达 window）。加上它之后看门狗退回只兜"松手后鼠标再也没动过"，
  阈值从 700 放宽到 2500，两头都不误伤。回归测试同时**装了它那条判据做反例**
  （位移 ≤6px 停手，我们的看门狗照样收尾），删掉门槛才会红。
- **不采纳表情差分图层，但把"没衔接"这件事真的修了。** 它那段代码找的是
  `document.getElementById('face')` —— 我们的 DOM 里没有这个元素（实测 0 个），
  它按状态拼出来的那张差分图路径在磁盘上也不存在（实测请求返回 **404**）。
  逐字接在 `pet.js` 末尾还会
  直接语法报错（`Identifier 'STATES' has already been declared`），整份脚本不执行。
  真正测出来的三条根因与修法见「状态机 → 表情之间切换的衔接」：
  `transition-duration` 是 `0s`（写了没给时长）、blink 挂 `#figure` 会把状态动画顶掉
  （实测倾角跳 2.23°）、峰值切换跳 3.0°/9.97px（CSS 修不掉，用一下 .18s 遮掩微动）。
- **`#bubble` 的 z-index 不动。** 它建议从 10 提到 25 以"盖过设置面板"，
  实测面板开着时气泡与面板**重叠 100%**、命中的是 `#clearMem` 按钮 ——
  提到 25 的结果是气泡糊在"打开配置文件 / 清空记忆"上面（`pointer-events:none`
  还会让那些点得到却看不见）。真相是记录面板已有的处理方式对：`body.showlog #bubble { display:none }`，
  面板/记录开着时气泡本来就该让位，不是抢层级。
- 测试 ui_test 118→152 项，整套矩阵 11 个文件 565→599 项。

**v0.8.0** — 合并外部规范文档《v0.8.2 架构升级与交互状态机开发规范》里**真正 additive**
的那部分（本地活动 + 主动搭话 + 记忆纯洁性），文档自带的两份代码则**逐字跑过之后拒收**。

新增：`src/tracker.js`（双轨活动 + 水位线 + 晚安/唤醒）、`src/trigger.js`（该不该开口的判据，
纯函数）、`memory.buildWithEphemeralUser()` / `cleanContentForSummary()`、brain 的环境块与
睡眠联动、`activity` / `proactive-check` 两个 IPC、渲染端的礼貌闸门与提案往返。
测试 brain 111→135、main 48→71、ui 98→118，另加 tracker 42 / trigger 36；
整套矩阵 11 个文件共 565 项（上一版 9 个文件 420 项）。

- **拒收 1：文档 §4.2 的 `getWearValidator` 会让换装整个失效。** 它写的是
  `wardrobe.catalog().items[itemId]`，而我们 `catalog().items` 是**按槽位**分组的
  （`{hair:[…], top:[…]}`）。把它逐字跑在真实衣柜上：15 个真 id 里判为合法的 **0 个**，
  `gothic_black_01 → false`、而槽位名 `hair → true`；用它过一遍 `[wear:gothic_black_01]`
  得到 `wears=[]` —— 从此一件衣服都换不上。校验器的合法集合仍然取自 `CATALOG`/`PRESETS`
  本身（后端 `parseWear` + 前端 `setKnownWear(catalog)` 已经是同一个出处），不引入它。
- **拒收 2：文档 §3.3 的 `StreamTagParser` 自己跟自己不一致，而且比现状更爱憋字。**
  同一条输入 `"好的 [ state:happy]"`（冒号前一个空格）：流式 `feed()` 原样放行，
  收尾 `stripAllTags()` 把它剥掉 —— 它自己在 #5 里承诺的"存显 100% 镜像一致"就这么破了，
  也正是我上一轮用来否掉"放宽字符集"的那条理由。逐字喂实测：正文里一个裸 `[`
  冻住 **17/38 帧**（我们 1/38）；未知 wear id 藏 **20/31 帧**、到第 25 帧又凭空长回来
  （我们 5/31，且收尾与后端 `parseWear` 同口径）。它的"严格前缀预检"确实比裸放宽字符集
  好，但代价是缓冲到 `]` 或 64 字才吐 —— 打字机手感直接完蛋。判据保留我们的
  "还可能长成合法标记吗"（衣柜真 id 比前缀），不换实现。
- **收下但改写法：200 条硬上限。** 文档 #2 说"强制丢弃最老陈旧事件"。它没写的是：
  被挤掉的**可能是还没消费的事件**，于是"被戳 N 次"悄悄变成假小值 —— 撞 persona
  那条硬边界。上限照收（防无界增长），但挤掉未消费事件时环境块改口"被戳**至少** N 次"，
  `commit` 之后恢复精确口径。
- **不实现：`[face:]` / `[act:]` 两条新通道、走动/边缘吸附、Task Identity 重写。**
  前两者没有对应图层，接了就是"她能声明、程序执行不了"——那是我们花两轮拆掉的东西
  （语言状态 ≠ 程序状态）；文档 #7 的"自主漫步只算环境感知"因此也无从属，我顺手删掉了
  环境块里那行 `当前姿态：idle`（**没有任何代码会改它**，报了就是编造）。
  Task Identity 用测的不是设计：上一轮那份抢占探针（在 /data 下，不随包发布）在我们现有
  `ctrl === ctrl` 守卫下打出迟到 chunk 泄漏 0、陈旧历史 0，再叠一层 taskId 只是多一个可失配的状态。
- **两个我自己写出来又被测试拽回来的缺陷**（都是先写完、测过才算修好）：
  `res.declined` 分支里必须先 `streaming = false` 再 `hideBubble()` —— 否则气泡收不掉，
  而 `politeToSpeak` 从此永远返回 false（"上一条还没说完"），**一次过期提案会把她往后
  所有主动搭话永久堵死**；以及第一版把 90 秒静默闸放在 poke 前面，把连戳这条路整个饿死
  （被戳本身就是"现在方便"）。两条都有对应用例，且都配了"前提复核"断言防止判据空转。
- **顺带删掉我自己上一轮写的死代码**：`POKE_DEDUPE_MS`（同串去重 32 秒）与 `pokeFiredAt`。
  它看着像第二道防骚扰闸门，实际永不开火 —— poke 提案提出时 `commit` 把 `lastFiredAt`
  定在同一个 `at`，之后任何一次再触发都必须先跨过 45 秒冷却，而那时早就不算同一串了。
  判据测不出来就等于没有，写在那里比没有更糟。

**v0.7.2** — 复核自己 v0.7.1 的修法时，发现**我把用来否掉 Gemini 建议的那条理由，
从另一个方向又犯了一遍**。起因是我想把 changelog 里"Δ10 socket"那个数复算一遍
（结果那个数确实错了，见下），顺手给半截标记补了个"流结束后"的场景：
- **收尾那一帧还在藏半截标记 → 吞字。** 新判据是"还可能长成合法标记就先藏"，
  它只问"像不像"、没问"**还来不来得及长成**"。流一旦结束，那条半截永远闭合不了，
  后端 `parseWear` 要 `]` 才剥、于是把它原样留在历史里 —— 屏幕上没有、历史里有，
  **正是我用来否掉"放宽字符集"的同一条理由**。真 id `silver_wavy_01` 被 `max_tokens`
  截断成 `[wear:silver_wavy_` 时实测整条被吞。改成 `stripState(t, partial)`
  （默认跟 `streaming`），收尾一律不藏。
  `test/ui_test.py` 原本查不出来：它那条流的结尾是**闭合**的 `[state:happy]`，
  收尾帧本来就正常 —— 逐帧测试只测了"吐字途中"，等于把判据的一半写成了盲区。
  现在两头都卡（途中必须藏 / 收尾必须照原样显示），截断用的 id 从衣柜现挑：
  写死一个 id 的话，衣柜里没有该前缀时"途中会被藏"这个前提就不成立，判据变空转。
  项数 95 → 98。
- 另外把 v0.7.1 条目里 #4 的 socket 数按客户端单侧口径重测并订正了（那个数当时错了），
  也补上了"为什么不能用打补丁 `ReadableStreamDefaultReader` 关掉 cancel"这条踩坑。
- **顺带订正一条我自己说过头的话。** v0.7.1 我拿"屏幕上没有、历史里有，两边剥的不是
  同一批"否掉放宽字符集 —— 补上 `partial` 之后拿真实后端 `parseState`→`parseWear`
  对了一遍：**收尾那一帧两种判据完全一致**（放宽版也不会再吞，因为它压根不看收尾）。
  真正还成立的差别只有"吐字途中"：放宽版会把幻觉 id 整条藏 14 帧、直到流结束又
  **凭空长回来**（C 只藏 6 帧且早早就露出来）。所以否掉建议的**主理由应该是那张表里
  B 列的 11 帧 —— 单轮结构换字符集治不了**，"前后端不同批"只是途中的一小幅。
  结论没变（仍然不该照抄），但当时的措辞把次要理由说成了决定性理由。
- 结论：v0.7.1 交付的那版**没有把 #2 修完**，只是把它从"闪出来"变成了"该显示时不显示"。
  这条不影响缓存和稳定性，但方向是吞正文 —— 比闪一下更糟的那个方向。

**v0.7.1** — 第二轮外部审阅（Gemini 对 v0.7.0 源码的 5 条）逐条复核，5 条**全部属实**，
但其中两条的修法不能照抄：
- **穿着块排到了 system 中间，把长期记忆的缓存一起赔进去了。** 代码是
  `persona + 穿着 + 长期记忆 + 历史`，注释和 README 却都写"挂在末尾"——
  文档说的是意图、代码干的是另一件事，这种不一致最坑：读文档的人会以为已经有保证。
  前缀缓存从头开始比，谁在前面决定了换一次衣服要赔多少；排反时换装会把全部
  长期记忆和历史一起顶出缓存。已改成 `persona + 长期记忆 + 穿着 + 历史`。
  **这条之前没有任何测试钉住顺序**，所以补了不变式测试（那组在旧顺序下确实会红）。
- **流式半截 `[wear:gothic_black_01]` 会闪出来。** 瞬态正则只允许字母，不含 `_` 和数字，
  实测吐到 `[wear:gothic_` 起连漏 9 帧。**没有采用建议的"字符集放宽成 `[a-z0-9_]*`"**：
  那样连 `[wear:maid_dress_01` 这种幻觉 id 也会被藏，而后端 `parseWear` 不认它、
  会原样留在正文里 —— 屏幕上没有、历史里有，两边剥的就不是同一批标记，比闪一下更糟。
  改成拿衣柜真实 id 集合比前缀：还可能长成合法标记的才藏，长不成的照原样显示。
  **顺带查出第二个更深的缺陷（建议的修法抓不到）**：剥完整标记与藏半截是两段单轮代码，
  把末尾 `[s` 藏掉后露出的 `[wear:xxx]` 本该继续剥 —— 实测泄漏 11 帧。已改为整体迭代。
  > 这几个数都是在 **v0.7.0 zip 抽出来的原样 `stripState`** 上改出来的（不是重写一份
  > 复刻，免得把结论写进判据）：`A` 原样、`B` 只把字符集放宽成 `[a-z0-9_]*`、
  > `C` 只换判据仍单轮、`D` 现状。9 帧出自 A，11 帧出自 B/C —— 也就是
  > **"换了判据但保留单轮结构"还剩多少**，跟用哪套判据无关。
  >
  > | 输入 | A v0.7.0 | B 只放宽字符集 | C 只换判据 | D v0.7.1 |
  > |---|---|---|---|---|
  > | `…[wear:gothic_black_01]` | 9 帧 | 0 | 0 | 0 |
  > | `…[wear:gothic_black_01][s` | 10 帧 | 1 | 1 | 0 |
  > | `…[wear:gothic_black_01][state:happy]` | 20 帧 | **11** | **11** | 0 |
  >
  > B 那一列就是"照抄建议"的结果：前两行修好了，第三行还剩 11 帧 —— 单轮换字符集治不了。
- **图层异步加载完成后没重算气泡上限。** `figure.offsetHeight` 实测 242 → 276
  （兜底单图 1015×1171 与图层画布 760×1000 宽高比不同），而 Electron 窗口启动后
  不发 resize，所以是启动即中、错到下次手动缩放。已在 `.then` 和 `.catch` 两条
  出口都补一次重算（含把已上屏的长回复按新上限重裁）。
  如实说明偏差方向：上限偏大 34px 会吃掉 46px 安全边距里的 34px（气泡顶边 38 → 4），
  **在当前可达尺寸区间内还不至于裁掉字**，但只剩 12px 余量。
- **报错后不释放底层连接。** `break` 只是不再消费。实测（服务端发完 error 帧后
  故意不关，**只在客户端进程数 `net.Socket` 句柄**）每报一次错就挂住一条连接：
  连发 1/3/6 次 → Δ1/Δ3/Δ6，等 GC 也不归零；补 `reader.cancel()` 后 Δ-1，
  也就是连接回收进 keep-alive 池、不随次数累积（跑 12 次仍是 Δ-1）。
  桌宠是常驻进程且报错往往连续（余额耗尽时每轮都报），攒下来就是越用越多。
  > 第一版这个探针把 server 建在同一进程里，读出 Δ12 —— 里面有一半是服务端的
  > 连接；"Δ10 / 补完为 0"是那个读数留下的，现已按客户端单侧口径改成本文数字。
  > 另外 `cancel` 不能用打补丁 `ReadableStreamDefaultReader` 的方式关掉：undici
  > 走自己那套流实现，改全局原型不生效，那样测出来是假绿——要劫持 `res.body`。
- **配置热重载只挂在 `brain.ask()` 上。** 改完 model 不发消息、直接开面板，
  看到的还是旧值，像是热重载根本没生效。已在 `config-get` / `chat-report` 各补一次读盘，
  并且**不碰 apiKey**：加密用户的盘上本来就没有 key 字段，顺手灌回内存会把 key 抹成空
  （表现是"打开一次设置面板，然后她就再也不会说话了"）—— 这两种情形都有测试。
- 新增 `test/main.test.js`（48 项）：主进程 IPC 面以前完全没有护栏，
  `src/` 下的单元测试碰不到 handler，于是"brain 那边对、main 传出去就错"这一整类缺陷无人看守。

**v0.7** — 外部审阅（Gemini 9 条）逐条对着源码复核后的结果，属实才改：
- **SSE 流里的错误帧不再被吞掉。** OpenAI 兼容服务报错时 HTTP 仍是 200，
  原因只写在某条 `data:` 里（余额耗尽、限速、审核拦截）。以前它会连着半截回复
  一起被当成"成功"，最后只报一句"返回空内容"，真实原因永久查不到。
  现在抛出服务端原文（带 type/code），并把已收到的半截挂在 `error.partial` 上。
- **一条回复里连发多个 `[wear:]` 全部逐条执行。** 以前只有一个 `wear` 变量，
  后面的覆盖前面的：屏幕上只换了一件，历史里也只有一条执行结果 ——
  那是程序替模型少说了一件事。现在返回 `wears` 数组，每条结果（换上 /
  本来就穿着 / 未生效+原因）按顺序如实写回历史。
- **身份约束从商品 `locked` 迁到槽位 `required`**，`locked` 整个删掉，
  避免同一个事实两个出处（反推的两种失效方向见「换装系统」一节）。
- **原子写补上 Windows 瞬态失败重试**：`rename` 遇 `EPERM/EBUSY/EACCES`
  线性退避重试 3 次（杀软/索引器/OneDrive 短暂持句柄），非瞬态错误原样抛出；
  临时文件名加随机后缀。
- **窗口缩放改用常量比例**（`src/layout.js`）。旧写法用"上一次量出来的 h/w"
  推下一次，round 误差只累积不归零；同时窗口宽与立绘宽各有夹取范围，
  放大到顶时比例脱钩（实测窗口 760 时立绘还卡死在 420）。
- **菜单与长回复气泡不再被透明窗口裁掉**：都改成实测尺寸夹取
  （`fitBubble()` 也不再是"量不出空间就不写"，缩窗后必须跟着改）。
- **丢 `mouseup` 的兜底做成四层**（正常 mouseup / 渲染进程 blur /
  主进程 `win.on('blur')` 转发 / 700ms 看门狗）。
  **没有采用 `setPointerCapture`**：它捕获的是同一个 DOM 元素内的指针，
  而这里丢事件的成因是光标离开了操作系统窗口，窗口外的输入属于别的程序，
  Electron 不会替我们送进来 —— 捕获得再正确也收不到那个 `pointerup`。
- **配置缓存按目录分 Key 且每次真的读盘**（`src/config.js`）：旧的模块级
  单一 `cached` 会让换目录读到上一份配置，也让用户手改 `gpt-girl-config.json`
  必须重启。瞬时读失败（`EPERM/EACCES/EBUSY`）时退回上一次成功读到的值，
  不能退成 DEFAULTS —— 否则紧跟着的 save 会把用户配置写成出厂值。
- **峰谷判定**：显式按北京时刻 + 2026 法定节假日/调休表判定。
  实测扫描表明旧写法在国内机器上 2026 全年一个点都没错、在 DST 时区也只有
  25 个点错一小时且**没有任何一个跨越峰谷边界** —— 所以这次改的是"不再依赖
  恰好没有踩到边界的时刻"，不是修一个正在发生的错账。
- 新增 `test/layout.test.js`、`test/config.test.js`、`test/deepseek.test.js`；
  `brain`/`atomic`/`ui_test` 相应补齐；项数仍由 `docs.test.js` 核对。

**v0.6**
- API Key 不再明文写进 `gpt-girl-config.json`，改为 `safeStorage` 密文文件 `gpt-girl-key`；
  加密不可用时如实降级为明文并在面板标注。**v0.5 老用户在启动读盘时自动迁移**
  （不会要求他再点一次保存，否则这个漏洞实际上永远修不上），
  迁移必须「写进去 + 立刻读回来逐字相等」才删明文；密文损坏时绝不删明文；
  密文文件用原子写，避免半截密文把 key 真弄丢。
- 所有持久化 JSON 改原子写（`src/atomic.js`）。
- SSE 收尾补 flush：最后一段没有换行时，之前的实现会丢掉尾包 —— 真实 DeepSeek 的
  `usage` 就在 `[DONE]` 前一条，表现为命中率/花费静默为 0。
- 用量面板里 `model` 字段改为 textContent 填充（它来自配置文件，此前直接拼进 innerHTML）。
- 新增 `test/secure.test.js`、`test/atomic.test.js`、`test/docs.test.js`；
  文档项数改由测试核对。

**v0.5** — 换装系统第一阶段（架构 + 3 套预设），`[wear:]` 提案协议，图层资源目录规范。
**v0.4** — 三层记忆（窗口小结 + 长期记忆合并）、记忆可见可单条忘掉。
**v0.3** — 前缀缓存改造、峰谷计价、用量面板。

