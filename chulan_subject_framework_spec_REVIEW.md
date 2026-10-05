# 初澜主体本体论扩容与 Agent 协同架构规范（V3.0）· 独立交叉核对报告

> 审阅对象：`chulan_subject_framework_spec.md`（V3.0 全景版，标称"已全面定稿封版"）
> 审阅方式：逐条与 `D:\GAME\LIFE` 仓库真实代码交叉核对（只读，不改码）
> 审阅日期：2026-10-05

---

## 〇、总体裁定

**架构哲学与配额意图：通过。工程现状描述：不通过。**

规范的认识论骨架（唯一主体 / 边界与节制 / 自然遗忘 / 技能零遗忘）立得很稳，
Token 配额的**基线数字实测全部准确**。但它把大量**已经上线并有门禁保护的既有系统**描述成待建，
同时把**零基础的部分**描述成"现有的"，并存在**一处规范内部不自洽**与**一处会撞测试门禁的改动**。

**建议：不要按"封版"处理，先修订 §五 / §六 / §三 三章再定锚。**§一 §二 §四 可原样保留。

---

## 一、核对通过（基线数字逐条实测准确）

| 规范声称 | 实测位置 | 结论 |
| --- | --- | --- |
| 自我账本 3,000（硬上限 10,000） | `src/config.js:48`、`src/self-ledger.js:167`；钳制上限 `config.js:155` = 10000 | ✅ 准确 |
| 长期记忆 6,000 | `src/config.js:45`、`src/memory.js:79` | ✅ 准确 |
| 人设本体约 1,000 | `src/persona.js` 3,927 字节 UTF-8 中文 ≈ 1.0K token | ✅ 准确 |
| 梦境单次 350 硬锁 | `src/dream-system.js:81` `dreamMaxTokens: 350` | ✅ 准确 |
| 词汇"死板截断 Top 5" | `src/memory.js:553` `.slice(0, 5)` | ✅ 准确 |
| 预期"只留最新 3 条" | `src/memory.js:561` `.slice(-3)` | ✅ 准确 |
| 遗忘方程与五项常数 | `src/memory-dynamics.js:26-34` | ✅ **逐个吻合** |

遗忘方程核对细节（规范 §四 vs `DEFAULT_DYNAMICS_CONFIG`）：
`beta 0.15` ✅ / `lambda 0.10` ✅ / `alpha 1.15` ✅ / `activeThreshold 0.60` ✅ /
`dormantThreshold 0.35` ✅ / `dormantWindowGap 5` ✅ / `baseStrength 0.50` ✅，
公式 `clamp(S0·(1+β·ln(1+n))/(1+λ·ΔW)^α, 0, 1)` 与 `computeEngramDecay()` 逐字一致。

另：规范 §二 说人设要"为银发、蓝灰眸、单侧泪痣预留空间"——`persona.js:9,14` 里这些**已经写死了**，
且已包含"无发素体形态依然是初澜""发饰可拆卸"等本体论断言。本体核心的**内容质量不是短板，篇幅才是**。

---

## 二、🔴 硬伤三条（会误导落地，必须修订）

### 硬伤 1：支柱五宣称"现有的 child_process 与 PowerShell"——仓库里一处都没有

规范 §六.5 写"基于桌面端**现有的** Node.js 子进程（`child_process`）与 PowerShell 作为底层执行驱动"。

实测：`child_process|execSync|spawn` 在 `src/*.js` 与根目录 `*.js` 中**零命中**。

LIFE 现有的进程/安全相关基建只有 `ipc-guard.js`（4KB）、`circuit-breaker.js`（2KB）、
`secure.js`（16KB）——都是**约束 Life 自身进程内行为**的，没有一个能调度外部命令。

**影响**：Agent 执行框架不是"在现有基建上扩建"，而是**从零新建一个执行引擎**。
按 §六 的体量（五支柱 + 1M 工作区 + 沙盒四件套 + MCP 接入），这是本规范里最大的工作量，
但文档把它描述成了支柱之一。工期与风险评估会严重失真。

### 硬伤 2：连接桥要 5 个徽章，认知引擎只有 3 个状态，且两者之间没有 join

规范 §三 要求面板 B 每个条目实时绑定 5 个标注：
`🟢 ACTIVE` / `🟡 FADING` / `⚪ DORMANT` / `🟣 FULFILLED` / `🔄 REACTIVATED`。

实测 `src/experiment-types.js:76-80`：

```js
const ENGRAM_TIERS = Object.freeze({
  ACTIVE: 'ACTIVE', FADING: 'FADING', DORMANT: 'DORMANT'
});
```

**只有 3 态。** 且：

- `FULFILLED` 不在 tier 体系里。愿望状态是**另一套独立数组** `memory.expectations`，
  由 `resolveExpectation()` 维护（`src/memory.js:478`），与 `EngramTraceManager` 的 traces **毫无关联**。
- `REACTIVATED` 也不是 tier。`reactivate()`（`memory-dynamics.js:174`）只是把
  `retrievalCount +1`、改写 `lastRetrievedWindow`，再重算强度——**不产生持久状态**。
- 结论：连接桥需要**新建一条从 `expectations.status` + `EngramTrace.tier` 到 UI 标注的联表与渲染链路**，
  这是实打实的开发量，规范里没有体现，也没有对应门禁。

### 硬伤 3：§二 与 §三 自相矛盾——"破灭"在配额章有、在连接桥章丢了

- §二第 6 行写："实现**或破灭**自然闭环"；
- §三徽章列表只有 `🟣 [已实现 / 已闭环] (FULFILLED)`，**没有破灭/作废的徽章**。

而代码 `src/memory.js:483` 明确支持**三态**：

```js
if (!['fulfilled', 'broken', 'moot'].includes(status)) return { ok:false, error:'INVALID_STATUS' };
```

规范漏掉了 `broken`（破灭）与 `moot`（作废）。
按现规范实现，一个"愿望破灭"的条目在面板 B 上**没有正确归属的标注**——
它会落进 `⚪ 已遗忘` 或 `🟢 活跃`，这是**认识论层面的错误呈现**（破灭的愿望不该被当成"她还在惦记"）。

---

## 三、⚠️ 需修订四条

### 修订 1：取消梦境 350 上限会打开成本盲区（双重门禁拦不住）

现有第二道成本门禁是**按调用次数**限的，不是按 token 限：
`minimumDreamIntervalWindows`（间隔 3 个窗口）、`maximumDreamCallsPer24h`（24h 次数硬顶），
判据全部在 `evaluateDreamGate()`，测试见 `test/dream-gate.test.js` 第 5/6/11 组。

规范 §五"彻底取消单次生成 350 Token 硬上限"之后，**单次梦境的 token 花费没有任何上界**，
而门禁一次都拦不住——它只看"该不该做梦"，不看"这次做梦多贵"。

**建议**：改成「次数门禁 + 单次 token 保底上限」双限（例如 350 → 4,000 上限），
而不是裸取消。取消后仍保留一个防 runaway 的硬顶。

### 修订 2：改配额会撞现成门禁（三项被硬断言）

实测 `test/nonhuman-framework-prompt.test.js:143-147` **以字符串字面量硬断言** `src/config.js` 源码：

```js
check('FC 三项预算双注册（DEFAULTS + 白名单：growth 4000 / summary 10000 / window 30000）', (() => {
  const cfgSrc = fs.readFileSync(path.join(__dirname,'..','src','config.js'), 'utf8');
  return /growthMaxTokens: 4000/.test(cfgSrc) && /summaryMaxTokens: 10000/.test(cfgSrc) && /windowMaxTokens: 30000/.test(cfgSrc) ...
})());
```

**含义**：动 `growthMaxTokens` / `summaryMaxTokens` / `windowMaxTokens` 任何一项，测试立刻红。
规范没提这层耦合。

好消息：规范要改的 `memoryCapTokens` 与 `currentSelfTokenBudget` **没有硬断言**
（测试里用的是 `memoryCapTokens: 1e9` 的宽松夹具），改这两项是安全的。

### 修订 3："100 万 Token 上下文底座"是未验证前提

LIFE 实际 provider 是 `deepseek` / 模型 `deepseek-flash`（`src/config.js:28-33`）。
规范 §二"在 100 万（1M）的大模型上下文底座中，仅占约 2.5%，为后续 Agent 留下 97.5 万 Token"
把"1M 底座"当作**已成立的前提**来推算余量。

这一步没有依据。1M 是**目标架构的愿望**，不是当前底座的事实。
若底座实际是 128K 级，则 23.8K 主体已占 **~19%**，Agent 可用空间不足 104K——
**结论会从"充沛"变成"紧张"**，整个扩容的必要性论证要重做。
建议把这一句改成显式的**待验证假设 + 验证方法**。

### 修订 4：技能"零遗忘自主进化"与仓库现有纪律冲突，且缺少退役机制

规范 §七要求技能总结"直接追加回写进 `learned_patterns.md`"，"零遗忘！永久沉淀！越战越勇"。

- 与仓库现状冲突：`AGENTS.md` 明确"不擅自 commit/push/改配置"，
  `.agents/skills/chulan-pixel-art/SKILL.md` 等技能文件是受控资产；技能自改写属于**无门禁的自修改**。
- "零遗忘"的反面风险：一条**错误**的工程经验会永久污染技能库，且没有任何退役/复核路径。
  对比主体记忆有 ACTIVE/FADING/DORMANT 三级 + `reactivate()` 兜底，技能侧一个兜底都没有。
- 建议：技能总结**先落草稿、经验证或人工确认后入库**；并给技能条目加"命中次数 / 最近验证时间"，
  低命中且久未验证的条目可被标记复核（不删，但可折叠）。

---

## 四、已被规范当成"待建"、实则**已上线且有门禁**的部分

| 规范章节 | 仓库既有实现 | 规模 |
| --- | --- | --- |
| §四 遗忘动力学引擎（"已在 memory-dynamics.js 验证"） | `EngramTraceManager`：`decayAll` / `reactivate` / `getActiveTraces` / `exportSnapshot` / `restoreFromSnapshot` 全在 | 239 行 |
| §五 客观观测层、`experiences.jsonl`、`DREAM_GENERATED_ARTIFACT` | `experiences-archive.js` + `archive-integrity.js` | 27KB + 54KB |
| §三 实验观测者看板 | `research-service.js` / `research-query.js` / `research-export.js` / `research-index.js` | 约 100KB |
| §三 愿望闭环 | `resolveExpectation()`（fulfilled / broken / moot） | `memory.js:478` |
| §二 主体边界与节制哲学 | `memory-dynamics.js:1-20` 文件头四段哲学声明已固化（档案不可篡改 / 零 API 成本 / 关系时间 / 三级分级） | — |

**这不是缺点**，反而说明地基比规范以为的更厚。风险在于：**按规范排工期会把这些当成新建工作而重复造轮子**。
建议规范增加一节「既有基座对照表」，逐项标注 `已实现 / 需扩建 / 零基础` 三态。

另外，遗忘动力学已有一条关键缓存铁律，规范 §四 未提及但必须继承：
**衰减只在窗口关闭边界执行一次**（`memory-dynamics.js:13-15`「绝不在每条消息或对话期间随意变动记忆文本，
杜绝制造额外的前缀缓存破坏」）。任何"实时映射遗忘数值到面板 B"的实现
（连接桥要求"实时"打标注）**与这条铁律直接冲突**——面板标注只能在关窗时刷新，不能逐消息刷新。

---

## 五、落地建议（三阶段）

**阶段 0 · 修订规范（0.5 天，纯文档）**
补「既有基座对照表」；改 §六.5 的"现有"→"零基础新建"；§三 徽章补 `BROKEN`/`MOOT` 并说明与
`expectations` 的联表方案；§五 改双限保底；§二 把"1M 底座"标为待验证假设。

**阶段 1 · 低风险高收益（配额扩容，1~2 天）**
只动 `memoryCapTokens 6000→12000`、`currentSelfTokenBudget 3000→9000`。
这两项**无测试硬断言**，且 `config.js` 已有 `finiteInt` 白名单（`memoryCapTokens` 上限 1,000,000、
`currentSelfTokenBudget` 上限 10,000，9K 在范围内）。改完跑直跑门禁即可。
`persona.js` 2000 建议缓——现有本体论内容已高度浓缩，扩到 2K 的边际收益低于前两项。

**阶段 2 · 连接桥（3~5 天，需设计评审）**
新建 `expectations ↔ EngramTrace` 联表 + 5 态标注渲染。
**必须先定"实时"与"关窗缓存"的关系**（见 §四 末），否则会破坏前缀缓存铁律。
门禁当前对这条链路**零覆盖**——需同步补测试，否则会重演"P0 缺陷全绿溜过"。

**阶段 3 · Agent 执行引擎（独立立项，不建议并入本规范）**
零基础新建，含执行引擎 / 1M 工作区 / 沙盒四件套 / MCP 接入 / 技能回写。
建议**独立成第二份规范**并单独立项评估——它的工期量级与主体扩容不在一个数量级，
混在一份文档里会让主体侧的需求被Agent 侧的工程量淹没。

---

## 六、一句话总结

**这份规范把"想清楚的事"写得很清楚，把"已经做完的事"写成了待建，把"还没开始的事"写成了现有。**
建议按 §五 的三阶段推进，先落阶段 1 的两项无风险扩容拿到即时收益，
同时把 §三 连接桥的 5 态问题与 §六.5 的零基础问题在文档里改掉，再谈 Agent 引擎。
