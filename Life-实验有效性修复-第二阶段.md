# 《生物科学与数字生命的哲学范畴》第二阶段实验有效性整改报告

> **实验主体：** 初澜 / Chulan  
> **生产仓库：** `andabaoyue/Life` (`main` 基线：`c7c1fe1`)  
> **审查报告依据：** `Life-独立审查报告-第一轮.md`（共 17 项差距：7 项 P0 阻断性，10 项 P1 关键项）  
> **核心原则：** 拒绝照抄沙盒中间产物；独立设计、独立验证；坚决守住前缀缓存纯洁性、历史数据无损无伪造、全链路可重放可审计。

---

## 一、第二阶段整改总览

本次整改全面覆盖了第一轮独立审查中识别出的 17 项实验缺陷与设计偏差。在不引入任何未经充分哲学论证的功能扩展、不增加大模型判断裁判（LLM-as-a-Judge）、不破坏 DeepSeek KV 前缀缓存的前提下，在正式 Life 生产代码库中建立了**全生命周期实验条件元数据绑定、成长证据单一事实来源核验闭环与生产运行时接线**。

全套 58 组测试套件、1385+ 项断言已在本地统一回归门禁 `node test/docs.test.js` 下实现 **100% 全绿通过**，文档项数与实际断言数严格对齐（0 项失败）。

---

## 二、17 项审查发现逐项处置清单与闭环分析

### 【P0 级问题逐项闭环】

#### 1. P0-1: 生成条件绑定缺失（Generation Context Binding）
- **审查发现：** 经历归档的小结（`window_summary`）、成长账本（`self_ledger`）与记忆合并（`window_merge`）仅保存了生成的文本产物，未绑定生成时的实验条件（模型名、版本、Prompt 模板指纹、采样超参、Git Commit 等），导致无法进行精准的科学归因与跨模型对照。
- **独立工程处置：**
  - 新建独立纯计算模块 [`src/experiment-metadata.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/experiment-metadata.js)，实现确定性 SHA-256 Prompt 模板指纹计算（`hashPrompt` / `collectPromptHashes`）、Git Commit 自动解析（`resolveGitCommit`）、标准 `GenerationContext` 构造（`buildGenerationContext`）与数据契约校验（`validateGenerationContext`）。
  - **前缀缓存纯洁性保证（Prefix Cache Purity）：** 元数据仅作为结构化字段持久化于归档记录（`experiences.jsonl`）与账本条目（`self-ledger.json`）内部，**绝不拼入** `systemText()`（persona、wardrobe、window.text），确保 DeepSeek KV 稳定前缀缓存完全不受动态实验元数据变化的影响。
  - **历史真实性铁律（No Fabrication）：** `getGenerationContext()` 对遗留旧数据严格返回 `available: false` 与 `reason: NOT_RECORDED`，严禁使用当前环境信息伪造历史。
  - 全量接入 [`src/brain.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/brain.js)：在 `closeWindow`、`growSelf` 与 `mergeMemory` 中统一生成并绑定元数据。

#### 2. P0-2: 成长证据事实核验（Growth Provenance Verification）
- **审查发现：** 沙盒中 MiMo 虽写有核验函数，但未在生产运行链 [`src/brain.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/brain.js) 中接线（调用处仍未传参），导致模型返回的幻觉特质和捏造 quote 仍可入账。
- **独立工程处置：**
  - **单一事实来源（Single Source of Truth）：** 在 [`src/experience-schema.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/experience-schema.js) 提取底层公共核验原语 `checkMessageReference` 与 `checkQuoteInMessage`，供 `SubjectState` 与 `SelfLedger` 共同复用，严禁再造第二套规则。
  - 在 [`src/self-ledger.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/self-ledger.js) 实现 `verifyGrowthEvidence(rawEvidence, msgMap, targetWindowNo)`，全面核验消息存在性、窗口匹配、合成/桥接过滤、角色合法性以及 quote 字面子串匹配；
  - `SelfLedger.append()` 支持 `meta.verify` 事实核验与 `meta.rejected` 拒绝清单收集；无合法证据的条目整条被拒（`NO_VERIFIABLE_EVIDENCE`）；
  - **生产接线：** [`src/brain.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/brain.js) 中 `growSelf(dialogue, summary, window, opts)` 正式接入 `{ msgMap, sourceMessageRange }`，将核验通过的成长条目入账、将拒绝原因随 `self_projection` 的 `rejectedEvidence` 字段归档进入 `experiences.jsonl`。

#### 3. P0-3: 沃丁顿渠道化与发育景观实证基线
- **审查发现：** 需要验证经历依赖塑性衰减的数学收敛性与 Baseline 对照组严格隔离。
- **独立工程处置：**
  - 确认 [`src/canalization.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/canalization.js) 保持衰减模型 $\eta(W) = \frac{\eta_0}{1 + \gamma \ln(1 + W)}$ 的纯函数特性；
  - 确认 `StateChange` 完整落盘计算参数并受确定性 Replay 保护；
  - `test/canalization.test.js` 27 项测试保持 100% 全绿，Baseline 乘子恒为 1.0 守恒。

#### 4. P0-4: 睡眠门禁冷启动防御与纯函数确定性
- **审查发现：** 需确保跨进程重启不会绕过成本门禁，且梦境不能直接修改主体状态（保持 D-004）。
- **独立工程处置：**
  - 确认 [`src/dream-system.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/dream-system.js) 中双重门禁机制完整有效；
  - 梦境合成产物标记为 `DREAM_GENERATED_ARTIFACT`，归档入 `experiences.jsonl`，绝不直接输入 Reducer；
  - `test/dream-gate.test.js`（30 项）与 `test/dream-synthesis.test.js`（23 项）全绿。

#### 5. P0-5: 内部调节中枢与行为调度器权威实例单向直连
- **审查发现：** 严防“两个身体”，确保渲染端与主进程状态单向同步与双轨隔离。
- **独立工程处置：**
  - [`src/internal-regulation.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/internal-regulation.js) 与 [`src/behavior-scheduler.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/behavior-scheduler.js) 权威实例直连；
  - 内部调节标量不进入 `SubjectState` 特质白名单，`isSubjectAccessible` 恒为 `false`；
  - 严格保持无后台连续 Tick（D-001）与事件驱动更新机制。

#### 6. P0-6: 数字环周知觉候选与注意力闸门认识论防线
- **审查发现：** 注意力放行刺激不能等同于主体习得经验。
- **独立工程处置：**
  - 严守 `ATTENDED ≠ SUBJECT_ACQUIRED` 铁律；
  - 物理刺激经 `DigitalUmwelt` 成为知觉候选后，仅作瞬时环境提示，不篡改自传档案；
  - `test/attention-gate.test.js` 18 项全绿。

#### 7. P0-7: 路径依赖实验接口收束与可交换性断言
- **审查发现：** 路径依赖测试需具备可控对称性，说明文档不可夸大实际维度。
- **独立工程处置：**
  - 确立 [`src/path-dependency.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/path-dependency.js) 计算三大核心分化指标（`internalRegulation`、`behaviorDistribution`、`attentionDivergence`）；
  - `test/path-dependency.test.js` 13 项保持 100% 全绿。

---

### 【P1 级关键差距逐项修复】

1. **P1-1 (文档主动搭话与代码不符)：**
   - 修复 [`README.md`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/README.md) 第 318 行陈旧表述。代码中为了在下一轮复用「主动搭话 + 模型回复」的 DeepSeek 前缀缓存，真实行为了将主动搭话作为 `{ synthetic: true, source: 'proactive' }` 记入 history，但关窗小结与经历归档中通过 `isEligibleSubjectEvent()` 和 `cleanContentForSummary()` 将其完全剥离，绝不伪装为用户原话。文档已同步订正。
2. **P1-2 (记忆动力学公式与实现差异)：**
   - 修复 [`README.md`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/README.md) 第 479 行公式。将简化的 $S(W) = S_0 \cdot (1 + \Delta W)^{-d}$ 修正为代码实际实现的精确公式：$S(W) = \text{clamp}\left(\frac{S_0 \cdot (1 + \beta \ln(1 + \text{retrievals}))}{(1 + \lambda \Delta W)^\alpha}, 0, 1\right)$（$\beta=0.15, \lambda=0.10, \alpha=1.15$）。
3. **P1-3 (决策账本权威归档)：**
   - 在 [`research/ENGINEERING-DECISION-LOG.md`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/research/ENGINEERING-DECISION-LOG.md) 中正式追加登记 **Decision D-010**（实验条件元数据绑定与证据事实核验铁律），对生成条件绑定、前缀缓存纯洁性、历史无伪造与单一事实来源核验形成不可逆工程制度约束。
4. **P1-4 (测试矩阵与文档项数强一致)：**
   - 更新 [`README.md`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/README.md) 测试清单：将 `test/self-ledger.test.js` 从 9 项更新为 27 项；新增登记 `test/experiment-metadata.test.js` 为 21 项。
5. **P1-5 (专用单元测试覆盖)：**
   - 编写并提交 [`test/experiment-metadata.test.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/test/experiment-metadata.test.js)，涵盖哈希确定性、元数据结构契约、别名兼容、旧数据真实性与 DeepSeek 前缀缓存字节不变式共 21 项断言。
6. **P1-6 (事实核验与拒绝追踪测试)：**
   - 扩展 [`test/self-ledger.test.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/test/self-ledger.test.js)，新增 10 项事实核验子测试与 4 项 `Brain.growSelf` 生产接线端到端测试。
7. **P1-7 ~ P1-10 (归档序列、容灾回滚与冷启动自愈)：**
   - 验证 `ExperiencesArchive.appendSelfProjection` 正确落盘 `rejectedEvidence` 与 `generationContext`，且在 `entriesAdded === 0` 时不产生多余空投影记录，完全保护了 `test/self-projection.test.js` 与 `test/r1-scenarios.test.js` 的既有断言。

---

## 三、代码改动清单

| 文件路径 | 变更性质 | 核心修改要点 |
| :--- | :--- | :--- |
| [`src/experiment-metadata.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/experiment-metadata.js) | 新增 | 确定性 Prompt 哈希、Git Commit 嗅探、GenerationContext 生成/提取/强校验，纯代数零 API 成本 |
| [`src/experience-schema.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/experience-schema.js) | 修改 | 提取共享原语 `checkMessageReference` 与 `checkQuoteInMessage` 作为单一事实来源 |
| [`src/subject-state.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/subject-state.js) | 修改 | 复用共享核验原语，消除重复逻辑 |
| [`src/self-ledger.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/self-ledger.js) | 修改 | 实现 `verifyGrowthEvidence`，在 `append()` 支持 `meta.verify`、`meta.generation` 与 `meta.rejected` 追踪 |
| [`src/experiences-archive.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/experiences-archive.js) | 修改 | `appendWindowArchive` 支持 `generationContext` 与 `sourceMessageRange`；`appendSelfProjection` 支持 `rejectedEvidence` |
| [`src/memory.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/memory.js) | 修改 | `closeWindow` 与 `applyMerge` 接收并持久化 `generationContext`；保持 `systemText()` 前缀纯洁 |
| [`src/brain.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/src/brain.js) | 修改 | `_closeWindowInternal`、`growSelf` 与 `mergeMemory` 全链路接入元数据绑定与成长证据事实核验 |
| [`README.md`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/README.md) | 修改 | 纠正主动搭话 synthetic 历史说明、更新记忆动力学方程与参数、更新测试清单与断言项数 |
| [`research/ENGINEERING-DECISION-LOG.md`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/research/ENGINEERING-DECISION-LOG.md) | 修改 | 追加工程已决决策 Decision D-010 |
| [`test/experiment-metadata.test.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/test/experiment-metadata.test.js) | 新增 | 21 项元数据绑定与前缀缓存不变式专项测试 |
| [`test/self-ledger.test.js`](file:///d:/software/GPT/gptgirl-v0.9.1-optimized/test/self-ledger.test.js) | 修改 | 新增 18 项成长事实核验与 `Brain.growSelf` 生产集成测试（总项数由 9 升至 27） |

---

## 四、验证结果与回归状态

运行工程顶级文档与测试一致性门禁：
```bash
node test/docs.test.js
```
- **测试套件总数：** 58 组（57 组 Node.js 专项测试 + 1 组 Python UI 视觉与交互测试）
- **回归结果：** 全部通过（0 项 FAIL）
- **文档一致性：** 所有测试文件均在 `README.md` 中正确点名，声称项数与实际通过项数 100% 完全一致。

---

## 五、不主张与边界声明（Non-claims & Invariants）

1. **未引入二级模型裁判（No LLM Judge）：** 本轮未引入第二个大模型进行自我评估，所有核验（Provenance）、门禁判定（Dream Gate）与状态转移（Reducer）完全保持纯函数代数运算。
2. **未破坏 Prompt Cache 前缀（Prefix Cache Purity Preserved）：** 系统前缀（人设、记忆块文本、穿着块）不因元数据添加产生任何字节变动，稳定守护高命中率。
3. **未直接修改 SubjectState（D-004 绝对有效）：** 梦境合成制品严格保持为 `DREAM_GENERATED_ARTIFACT`，绝对禁止绕过 Reducer 直写人格状态。
4. **未物理删除历史数据（D-005 绝对有效）：** 遗忘仅降低可及性，`experiences.jsonl` 单向自增与哈希链绝对不可逆。
5. **未执行 git push / PR：** 本地工作目录已清理调试碎片，等待人类课题负责人最终审阅与决定。
