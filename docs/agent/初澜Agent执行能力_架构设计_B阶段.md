# 初澜 Agent 执行能力 · 架构设计（B 阶段：只做设计，不接执行器）

> 编制：2026-10-06
> 定位：**纯架构设计文档，零代码改动。** 本阶段不实现任何执行能力、不接子进程、不开写通道。
> 依据：代码实勘（`src/agent-interfaces.js` / `main.js` / `src/research-ipc.js` / `src/tracker.js`）
> + `%APPDATA%\Life` 真实运行数据 + V3.1 讨论方案 §4.3/§阶段6
> 前置：`bc86cf9`（v3.1 日期锚点 + 静息回血，已提交）
>
> ⚠️ **本文的定位必须先说清**：V3.1 讨论方案 §4.3 把「§六.5 Agent 执行引擎」列为
> **零基础新建**，§阶段6 明确写「**独立立项，不建议并入本规范**」。
> 所以本文**不是**主体扩容的第五个框架，而是独立立项的第一份设计稿。

---

## 〇、结论先行

1. **现有地基比"零基础"多一点点，但远远不够**：`agent-interfaces.js` 52 行提供了正确的
   **骨架**（能力→策略→提案→确认→审计五段闭环），但**执行器是空的、审计日志是内存数组、
   策略层没有 scope 白名单**。可复用的骨架远多于 V3.1 §4.3 表格暗示的"零"。
2. **唯一现成可借道的是 IPC 白名单范式**：`src/research-ipc.js`（168 行）已经示范了
   「主进程注册通道 + 严格只读 + 显式拒绝写通道」的完整做法，**Agent 执行通道应照抄它的形，
   而不是另起一套**。
3. **本阶段的核心结论：先补三块地基，再谈执行器。** 其中最要命的是**执行预算**
   —— 这是 V0.9.2 审计与现有文档都**从未提及**的一块（详见 §三.5）。

---

## 一、地基实勘（不采信历史审计结论，重新实测）

### 1.1 `src/agent-interfaces.js` 逐模块定性

| 模块 | 行数 | 定性 | 缺口 |
|---|---:|---|---|
| `CAPABILITIES` | 1 | **骨架可用** | 硬编码 4 项，`Object.freeze` 不可扩展；无能力元数据（是否危险/是否需确认/作用域规则） |
| `CapabilityRegistry` | 4 | **骨架可用** | 只有 `has`/`list`，无 `register()`，**运行时无法新增能力** |
| `PermissionPolicy` | 9 | ⚠️ **有实质缺陷** | 见 §1.2 |
| `createActionProposal` | 10 | **骨架可用** | `status` 硬编码 `'proposed'`，无状态机（无`approved`/`rejected`/`executed`/`expired`） |
| `AuditLog` | 6 | 🔴 **必须重写** | `this.events = []` **纯内存**，进程重启即丢 |
| `AgentBridgeMock` | 3 | 空壳 | `execute()` 必抛 `AgentBridge尚未连接真实执行器` |

**git 溯源**：该文件自 `1e93185`（基线初始化）起**从未修改**，从未被 `main.js` 或渲染层导入。

### 1.2 `PermissionPolicy` 的实质缺陷（现有文档均未指出）

```js
can(capability, scope) {
  if (this.killSwitch) return false;
  return this.allowed.has(String(capability)) && !!scope;  // ← 只判 scope 非空
}
```

- `scope` 是**任意字符串即通过**。`scope: "*"`、`scope: "C:\\Users\\andab"` 全部放行。
  → **没有任何路径约束概念**，这是最要命的一条。
- `killSwitch` 默认 `true`（`opts.killSwitch !== false`），所以默认全拒——
  这个默认值是对的，但**只有布尔开关**，没有分级。
- 无「一次性授权」语义：一旦`allowed` 里有 `workspace.write`，就**永久**可写。

### 1.3 真实缺口清单（零命中的部分）

实测 `grep -rn "child_process|execSync|spawn(" src/*.js main.js` → **零命中**。故以下**全部为零基础**：

| 缺口 | 状态 | 风险 |
|---|---|---|
| 子进程执行基建 | 🔴 零命中 | 无隔离层 |
| 沙盒四件套 | 🔴 零命中 | 无路径限制/无资源限制/无超时/无输出上限 |
| 指令回滚机制 | 🔴 零命中 | 执行失败后无法撤销，**这是最危险的一条** |
| MCP 接入 | 🔴 零命中 | — |
| Agent 专属 IPC 通道 | 🔴 零命中（但有 `research-ipc.js` 可照抄） | — |

### 1.4 ✅ 重要发现：已有成熟 IPC 白名单范式可复用

`src/research-ipc.js`（168 行，`main.js:14` 注册）是本仓**现成的安全范式**：

```js
/**
 * 核心安全边界：
 * 1. 严格只读！只挂载查询、复盘任务与导出通道。
 * 2. 严禁暴露任何写通道（set-state / update-event / delete-evidence / edit-archive 等）。
 * 3. 渲染进程绝无对底层实验数据库的直接修改能力。
 */
```

它已经示范了：主进程注册 `ipcMain.handle`、按白名单逐个挂载、
**写通道在设计层就不存在**（而不是靠运行时拦截）。
**Agent 执行通道应当照抄这个形状**，区别只在于：research 全只读，agent 需要写——
所以写通道必须**逐条显式列举 + 逐条确认**，绝不能出现通配。

---

## 二、能力矩阵

### 2.1 四个既有能力的边界裁定

| 能力 | 裁定 | 作用域规则 | 理由 |
|---|---|---|---|
| `workspace.read` | 🟡 **有条件开放** | 只读白名单目录（见 §2.2） | 低风险，但读什么必须可控 |
| `workspace.write` | 🟠 **严格受限** | 白名单目录 + **逐次确认** + 可回滚 | 写操作不可逆，须有 undo |
| `process.execute` | 🔴 **默认封死** | 白名单命令 + **永不执行 shell 拼接** | 见 §2.3 |
| `network.request` | ⛔ **建议永久封死** | — | 见 §2.4 |

### 2.2 作用域白名单（替代当前"任意字符串即通过"）

建议配置结构（替代 `allowed: Set<string>`）：

```js
SCOPES = {
  'workspace.read':  { roots: ['<用户显式授权目录>'], recursive: true,followSymlink: false },
  'workspace.write': { roots: ['<同上>'], requirePerActionConfirm: true, transactional: true },
  'process.execute': { allowlist: [/* 逐条列举，绝不 glob */], shell: false, timeoutMs: 30000 },
}
```

三条硬规则：
1. **`followSymlink: false`** —— 否则符号链接可指向白名单外，等于没有白名单。
2. **路径归一化后再比对**（`path.resolve` + 大小写不敏感处理），防`..` 穿越。
3. **`recursive: true` 需显式声明**，默认不递归。

### 2.3 `process.execute` 的三条铁律

1. **永不 shell 拼接**。`spawn(cmd, argsArray)`，`shell: false`。用户输入永远进args 数组，
   永进命令字符串。
2. **永不 glob**。allowlist 必须逐条列举到具体命令 + 具体参数模式。
   （可直接借鉴 `.pi/modes.config.json` 里 pi-agent-modes 的 `readOnly` 校验思路：
   拦截危险 flag `-i`/`--in-place`/`--delete`/`--exec` 等，详见 §六.1）
3. **超时 + 输出上限**。超过 `timeoutMs` 强制 kill，输出超过 N MB 截断并标记。

### 2.4 为什么建议 `network.request` 永久封死

反对意见预演：V3.1/ `SOFTWARE-PURPOSES` §326 规划过"查天气"。但：

- **初澜的人格红线不允许她虚构外部信息**。她无法验证网络返回的真伪，
  一旦联网就会出现"她说查了天气"而实际请求失败/被劫持的情况 ——
  这**直接违反** `persona.js` 的反表演铁律。
- 网络是**唯一无法用本地沙盒约束**的外部输入源。文件系统至少有路径白名单，
  网络只能靠域名白名单，而域名白名单挡不住响应内容被污染。
- 收益极低：查天气这件事，用户自己开窗更快。

**若将来必须开**，前置条件是：① 独立于人格链路的「工具结果」标注（绝不让网络内容进
  `memory.history` 当作她的认知）；② 域名白名单 + 响应内容不可信标注。

---

## 三、五道闸门（本文核心）

前四道是现有骨架的补全，**第五道是全新的**，也是最要紧的。

```
① CapabilityRegistry 能力白名单    ← 现有（需加 register()）
      ↓
② PermissionPolicy 作用域硬策略    ← 现有（需重写 can()）
      ↓
③ ExecutionBudget 执行预算熔断     ← 🔴 新增，现有设计完全没有
      ↓
④ UserConfirmation 用户显式确认     ← 现有（需接UI）
      ↓
⑤ AuditLog 持久化审计              ← 现有（必须重写为落盘）
```

### 3.1 ① CapabilityRegistry 补全

只需加 `register(name, meta)` + 元数据（`dangerLevel` / `requiresConfirm` / `scopeRule`）。
能力集合改为**配置驱动**而非硬编码。

### 3.2 ② PermissionPolicy 重写核心

从 `can(capability, scope)` 改为 `authorize(request)`，返回**判定明细**而非布尔：

```js
{ allowed: false, reason: 'scope_not_in_whitelist', matchedRoot: null }
```

理由：审计日志必须记录**为什么拒绝**，布尔值无法追溯。

### 3.3 ④ UserConfirmation 的一个哲学问题（需拍板）

见 §五 · Q3。技术上简单，难的是"她能不能主动提出"。

### 3.4 ⑤ AuditLog 重写为落盘

现状 `this.events = []` 重启即丢。**审计日志丢失等于安全机制失效**。

建议落`%APPDATA%\Life\agent-audit.jsonl`（append-only，与 `experiences.jsonl` 同构）。
必须字段：`at` / `capability` / `scope` / `decision` + `reason` / `proposalId` / `confirmedBy`。

⚠️ **绝对不记**：命令原文中的凭据、文件内容、用户隐私数据。只记元数据。

### 3.5 🔴 ③ ExecutionBudget（本阶段最重要的一块）

**现有全部文档（V0.9.2 审计、V3.1 §4.3、S `SOFTWARE-PURPOSES`）都没有这一块。**

V0.9.2 审计第 493 行说「缺乏完备的权限确认沙箱、指令回滚机制与审计日志」，
三项里**没人提预算**。但一个**能无限循环的 Agent 比一个不能执行的 Agent 危险得多**。

必须有的四个上限：

| 维度 | 建议初值 | 说明 |
|---|---|---|
| `maxActionsPerSession` | 20 | 单次会话动作总数硬顶 |
| `maxWritesPerSession` | 5 | 写动作单独更严 |
| `maxConsecutiveErrors` | 3 | 连续失败 N 次自动熔断（防死循环） |
| `maxWallClockMs` | 10min | 单次提案的端到端时限 |

熔断后必须有**明确的用户可见状态**，且**不得静默重试**。

### 3.6 🔴 指令回滚（现有文档提到但无方案）

写操作若无可回滚，一次误操作就是永久损失。
建议：写动作走 **transactional** 语义 —— 先写临时文件 + 记录原路径哈希，
成功后 commit，失败/超时则回滚。**这不是"尽力而为"，是硬要求。**

---

## 四、与已有系统的咬合

### 4.1✅ 可直接复用：V3.1 附录 A 的 checkpoint 机制 → Agent 执行断点

V3.1 附录 A 已经把上下文压缩的 checkpoint 机制设计清楚了
（`test/` 已有相关门禁，A.4 定调「**标记折叠、不物理删除**，保留可回查」）。

**这是唯一现成的、能承接 Agent 执行断点的地基。** 建议：
- Agent 执行每个关键步产出 checkpoint，**永久归档**（沿用 A.4.1 的不删原则）；
- V3.1 §6.3 已写「每份 checkpoint 本身就是一份阶段工程经验」——
  Agent 的执行 checkpoint 同样如此，且**反向喂给技能库**（§七 技能回写）。

### 4.2 ✅ 可直接复用：`research-ipc.js` 的白名单范式

见 §1.4。Agent IPC 通道照抄它的形状，差别是 research 全只读、agent 需写，
所以**写通道必须逐条显式注册，绝不 glob**。

### 4.3 ⛔ 不可复用：人格直连执行

**执行器绝不可由 `brain.js` 直接调用。** 必须经主进程 IPC 隔离
（渲染层无 Node 能力，这是 Electron 的既有安全边界，必须保住）。

---

## 五、需要你拍板的三个问题

### Q1 `network.request` 封死还是保留？
我的建议是**永久封死**（理由见 §2.4：人格红线 + 无法本地约束）。
但这会砍掉 `SOFTWARE-PURPOSES` §326 规划的"查天气"。

### Q2 `workspace.write` 的作用域？
我建议：**显式授权目录白名单 + 逐次确认 + 事务可回滚**。
绝不允许"整仓库可写"。

### Q3 🔴 Agent 是"她主动提出"还是"你调用"？

这是**哲学问题，不是工程问题**，但它决定了 `persona.js` 要不要加约束：

- 若**她能主动提**：必须回答——她会不会为干活而**编造理由**？会不会**催促**你确认？
  会不会**反复申请**直到你烦了同意？这些都要写进 `persona.js` 红线。
- 若**只由你调用**：`persona.js` 一行不改，纯粹是工具通道，风险骤降。

我倾向**先做"你调用"，把人格侧的命题留到真要做主动提议时再解**——
因为让一个人格去求人授权，涉及自我认知的一致性，比工程难度大得多。

---

## 六、附：可借鉴的外部范式（已在本仓落地验证过）

### 6.1 pi-agent-modes 的三档 bash 策略（见 `docs/agent/pi-agent-modes-implementation-report-2026-09-29.md`）

`allow` / `readOnly` / `deny` 三档，`readOnly` 严格拦截危险 flag
（`-i`/`--in-place`/`--delete`/`--exec`/`--execdir`/`-x`/`--exec-batch`）
与危险调用模式（`system|exec|eval|spawn|popen|subprocess|unlink|rename|chmod|chown`）。

**这份报告已实测通过 7 项验证**（§9），且已落地 `.pi/modes.config.json`。
`process.execute` 的 allowlist 设计可直接沿用这套思路。

### 6.2 V0.9.2 审计的既有结论（仍然有效）

> "桌宠的核心价值在于伴随与情感共鸣，而非代替用户执行高危操作系统命令。
> 在缺乏完备的权限确认沙箱、指令回滚机制与审计日志的情况下，
> 盲目接入 Shell 执行或文件写操作是极不负责任的安全隐患。"

**本文认同该结论，并补一条：还缺执行预算（§3.5）。**

---

## 七、本阶段不含的内容（避免范围蔓延）

明确**不做**：
- ❌ 不写执行器代码
- ❌ 不开任何 IPC 通道
- ❌ 不接 MCP
- ❌ 不做沙盒四件套
- ❌ 不改 `persona.js`（等 Q3 拍板）
- ❌ 不改 `agent-interfaces.js`（本文只是设计，实现在下一阶段）

---

## 八、审计自查（本文自身的已知不确定处）

按项目纪律，标出**未验证**的部分：

- ⚠️ **未跑任何测试**：B 阶段本文为纯文档，零代码改动。（C 阶段实现后已补49 项测试，见 §九）
- ⚠️ **未验证 Electron IPC 的实际连通性**：`research-ipc.js` 的通道是否在渲染层
  全部被消费过，未查（只读了主进程注册侧）。
- ⚠️ **`SOFTWARE-PURPOSES` §326 的"整理桌面无用截图"是否真能只靠 read+write 实现**：
  "判断哪些截图无用"需要语义判断，可能需要读全部图片 —— 成本与可行性未评估。
- ⚠️ **checkpoint 复用的具体接口未验证**：V3.1 附录 A 的 checkpoint schema
  与 Agent 执行断点的字段需求是否吻合，未逐字段比对。
- ⚠️ **Q3 未做任何技术预研**：主动提议的人格一致性风险只有定性判断，无实证。

---

## 九、C 阶段终审裁定（2026-10-06，已拍板并落地）

三个问题已定调，**不再讨论**：

| 问题 | 裁定 | 落地情况 |
|---|---|---|
| Q1 `network.request` | 🔴 **C 阶段彻底封死（Hard-deny）** | `CAPABILITY_META['network.request'].hardDenied = true`，即便显式授权 + 合法 scope 仍拒绝 |
| Q2 `workspace.write` | 白名单目录 + 逐次 UI 确认 + 事务性回滚 | 路径白名单已实现（`scopeRoots`）；UI 与回滚属D 阶段 |
| Q3 触发方式 | **「你调用」**，`persona.js` **一行不改** | 未触碰 `persona.js`；提案仍由外部构造，无人格主动提议 |

**C 阶段已实现（`src/agent-interfaces.js` 52 → 382 行）**：

1. ✅ **① CapabilityRegistry** —— 加 `register()` + `metaOf()`（返回副本防篡改）+ `isHardDenied()`，
   能力集合改配置驱动（`CAPABILITY_META`）。
2. ✅ **② PermissionPolicy** —— `can()` 升级为 `authorize()` 返回判定明细（`allowed`/`reason`/`matchedRoot`）；
   scope 从 `!!scope` 换成路径白名单硬约束（`path.resolve` 归一化 + 前缀相似目录不误配 + `followSymlink` 默认关闭）。
   保留 `can()` 向后兼容，但**语义有意变严**（未配根目录一律拒）。
3. ✅ **③ ExecutionBudget** —— 四上限全部落地并测试：动作 20/ 写 5 / 连续错误 3 / 墙钟 10min。
   熔断为**终态**（触发后不再放行任何动作，不得静默重试），`state()` 暴露剩余配额供 UI 显示。
4. ✅ **④ AuditLog** —— append-only 落盘 `agent-audit.jsonl`，可 `readAll()` 回读；
   凭据类字段（key/token/secret/password/credential/cookie）**绝不落盘**；超长字段截断。
5. ✅ **提案状态机** —— `PROPOSAL_STATES` 八态，非法状态构造即抛。
6. ✅ **额外发现并修掉一处真漏洞**：`process.execute` 原只判「非空字符串」，
   导致**一个文件路径也能通过**（实测 `C:\...\notes.txt` 与 `git status` 同样 `allowed:true`）——
   等于让调用方的命令白名单比对着路径比对，校验形同虚设。
   现补 `looksLikePath()` 前置拦截（盘符/UNC/目录遍历/无分隔符判命令/可执行扩展名不算路径）。
   🔴 收窄判据时踩过一次坑：初版把「带扩展名」当路径判据，导致 `cmd.exe` 被误拒 ——
   可执行文件名不是路径，已修正。

**测试**：`test/agent_interfaces.test.js` 6 → **49 项**，全 RC=0；`release-check` PASS 8 WARN 0 FAIL 0。

### 🔴 C 阶段实施过程中的一次自审失误（留档警示）

用 `str-replace` 把 `class AuditLog {` 当作锚点做替换时，**锚点本身被替换掉**，
导致类头丢失 + 产生重复的 `createActionProposal` / `AgentBridgeMock` / 两处 `module.exports`，
`node --check` 直接语法报错。

**教训**：以「类/函数声明首行」作为替换锚点时，必须确认该字符串**只出现一次**，
且替换后不能把声明行本身吃掉。本次靠 `node --check` + 结构grep 双重确认才定位到。

---

### 🔴 C 阶段复核加固（2026-10-06 二次复核坐实三处隐患，已修）

C 阶段实现后做了一轮独立复核，**三处隐患全部实测复现并修掉**，测试 49 → **57 项**：

| # | 隐患 | 实测症状 | 修法 |
|---|---|---|---|
| 2 | 🔴 **安全红线实质失效** | `authorize` 原 `ctx.meta \|\| null` —— 不传 ctx.meta 时**整个跳过 hardDenied 检查**。实测 `authorize('network.request','C:\\safe\\file')` 返回 `allowed:true`，network 硬封死可被「不传 meta」绕过 | 兜底 `ctx.meta \|\| CAPABILITY_META[cap] \|\| null`，安全红线**不依赖调用方自觉** |
| 3 | 🔴 **后门** | `register()` 未调 `isHardDenied()`，注释写了原则实现却没这道关。实测 `register('network.request',{hardDenied:false})` 后 `isHardDenied` 变 false | register 开头 `if (this.isHardDenied(key)) return false;` |
| 1 |⚠️ **误杀合法命令** | `looksLikePath` 对**整条命令行**做路径判定 → `git diff docs/agent/report.md`、`node tools/release-check.js`、`cat test/readme.txt` 全被判路径而拒，命令白名单形同虚设 | 改为**只看命令名（首个 token）**，参数不参与判定。参数里的路径交由调用方 args 数组白名单逐条比对，本层不越权 |

**连带修好的问题**：`can('process.execute','git status')` 因元数据丢失恒为 `false`，
兜底修好后恢复为 `true`。

**一条重要的口径澄清**：JS/TS/Python 等**源文件扩展名在可执行白名单里是有意的**——
源文件极常作为命令参数（`git diff src/x.js`），若把它们当路径会大面积误杀。
真正要拦的是「**命令名本身**是路径形态」（`C:\Windows\System32\cmd.exe`、`/usr/bin/git`）。

**复核方法论留档**：这三条都不是靠读代码发现的，是**逐条构造反例实跑**发现的。
`looksLikePath` 那条尤其 —— 它 49 项测试**全绿**却仍有真漏洞，
因为测试只覆盖了「单token 无路径」的情形，**没覆盖带路径参数的复合命令**。
→ 门禁测试必须包含**反例**，只测正例会让真漏洞藏在绿色里。

---

## 十、C 阶段不含的内容

- ❌ 不接执行器（`AgentBridgeMock.execute()` 仍抛「尚未连接真实执行器」）
- ❌ 不开任何 IPC 通道
- ❌ 不做沙盒四件套
- ❌ 不做指令回滚（属D 阶段）
- ❌ 不改 `persona.js`（Q3 已裁定「你调用」，人格侧不动）
- ❌ 不接`main.js`（本阶段纯模块层，验证通过后再接线）

按项目纪律，标出**未验证**的部分：

- ⚠️ **未跑任何测试**：本文为纯文档，零代码改动，未运行测试。
- ⚠️ **未验证 Electron IPC 的实际连通性**：`research-ipc.js` 的通道是否在渲染层
  全部被消费过，未查（只读了主进程注册侧）。
- ⚠️ **`SOFTWARE-PURPOSES` §326 的"整理桌面无用截图"是否真能只靠 read+write 实现**：
  "判断哪些截图无用"需要语义判断，可能需要读全部图片 —— 成本与可行性未评估。
- ⚠️ **checkpoint 复用的具体接口未验证**：V3.1 附录 A 的 checkpoint schema
  与 Agent 执行断点的字段需求是否吻合，未逐字段比对。
- ⚠️ **Q3 未做任何技术预研**：主动提议的人格一致性风险只有定性判断，无实证。