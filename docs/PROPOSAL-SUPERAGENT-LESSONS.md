# 方案：从 DeepSeek Super-agent 里借什么、不借什么

> 状态：**设计稿，未落代码**
> 日期：2026-11-01
> 基线：`0d00d22`（v1.9.0-dev）
> 性质：外部架构调研 + 对初澜 Agent 线的取舍建议

---

## 〇、结论先说

**不是天上掉的馅饼，是一本很厚的参考书，其中三页对我们直接有用。**

DeepSeek Harness 团队 2026-10-31 发布了《Super-agent 设计探索：迈向更自主的 Agent 系统》，
配套开源原型 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，2.1k star）。

**但它的定位要先看清**，README 第一句自己写着：

> Research prototype for reference only, not an official DeepSeek product. ... It may still contain bugs,
> and its coding style and engineering practices may be inconsistent.
>
> Some designs discussed in the article are **directions for future development and are not implemented in this prototype**.

它是一个**针对单个 GitHub 仓库的主动式编码 agent**。Source 是 GitHub / Feishu，执行环境是云端 + 本地 daemon。
跟初澜的桌面、时间、对话，一个都不重合。

**架构不能直接搬。但有三样东西是真的值钱，另有一件事必须明确拒绝。**

---

## 一、已核实的事实（我读了源码，不是只读文档）

> 下面这些是**本仓库之外**的验证：我直接读了原型仓库的 `src/policy.ts`。
> 可复核地址：`https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/src/policy.ts`

### 1.1 `observe` 三态模式**确实实现了**

`EvalConfigSchema` 里：

```ts
mode: z.enum(['off', 'observe', 'auto']).default('observe'),
```

**注意默认值是 `observe`，不是 `auto`。** 这是一个很强的设计表态：默认状态下它**不主动做事**。

### 1.2 `observe` 的记录形态（关键）

`assessmentOutcome()` 里的核心分支：

```ts
if (strength === 'inferred' && settings.eval.mode !== 'auto') {
  const proposal = { title, scope, worktree_name: name }
  return {
    kind: 'ignore',
    audit: { ...audit, would_accept: true, proposal },
    reason: { code: 'observed', values: { text: assessment.reason } }
  }
}
```

**它记的不是一句「我本来想做」，而是一份完整的拟案**：`title` / `scope` / `worktree_name`。
然后判定为 `ignore`，理由码 `observed`。

这一点很重要——**观察档记录的是「如果放行，会做成什么样」的完整快照**，不是意图摘要。
所以事后翻记录时，看到的是一份可以直接审阅的成品草稿，而不是一句愿望。

### 1.3 其它已核实的点

| 项 | 值 | 出处 |
|---|---|---|
| Policy 版本号常量 | `POLICY_REVISION = 'mandate-v3'` | `src/policy.ts` |
| Decision 枚举 | `accept` / `stop` / `ignore` / `unavailable` | `docs/001-domain.md` |
| Strength 枚举 | `explicit` / `inferred` | 同上 |
| Assignment 枚举 | `pending` / `running` / `ended` | 同上 |
| Report 枚举 | `progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped` | 同上 |
| 接受需满足 | 方向已定 + 至少匹配一条启用规则 + 有 `intent_evidence` | `src/policy.ts` |

### 1.4 我**没有**核实的（不要当已验）

- `src/executor/` 整条执行链路
- 面板如何展示 `would_accept` 记录
- 文章里说的投机执行、异步 ReAct Loop、Watchdog 是否真的实现（README 明说「文中的一些设计只是方向」）
- 性能实验数据（文章自陈：合成负载、简化环境，不衡量单任务执行能力）

---

## 二、可以借的三样

### 2.1 `observe` 观察档 —— 最值钱，而且现在就能用

**它解决的是我们昨天讨论的那个真问题**：你说「我想给他权限，不需要我授权」。

DeepSeek 的答案不是「问 → 不问」的二选一，是**中间加一档**：

| 模式 | 行为 |
|---|---|
| `off` | 推断出的候选一律不成案 |
| `observe` | 照常研判，结果记成「ignore + would_accept + 完整拟案」，**什么都不做** |
| `auto` | 研判通过就接单执行 |

文档原话：

> Start in observe and switch to auto after reviewing the recorded Decisions.

**对初澜的价值**：它给了你一个「看她在没人的时候会做什么」的窗口，而且这个窗口**零成本**——
不落盘、不打扰、不烧额外 API（拟稿本来就要跑）。

你翻一段时间记录，觉得她判断得不错，再切 `auto`。切过去之后，她就真的不用问你了。

**这条路比我之前提的更稳**：它不是「先给权限再观察后果」，是「先观察再给权限」。

### 2.2 `Mandate` 生命周期 —— 补「判断没有回声」那个断点

我之前那份方案（`PROPOSAL-AGENT-HISTORY.md`）里最弱的一环是「`refused` 回声」：
她拒了，之后怎么样，她不知道。

DeepSeek 的模型是（`docs/001-domain.md`）：

> **Mandate**: What an accept grants: the Policy version, the scope, the strength, the matched rules,
> the sender's identity... **Immutable**; wider scope means a new Ticket.
> A Ticket's end does not end it: **only a person's stop withdraws it**.

> **Ticket**: ... Goes open → ended, and **back to open when a person's message on one of its Threads resumes it**.

**关键在最后一句：工单结束了，授权还在。你后来又说了一句，它自己就续上了，不用重新研判。**

这就是回声。不是「记住我拒过什么」，是「**授权本身有生命周期，结束不等于作废**」。

初澜现在的 `proposalSource` 是这个东西的**原始形态**：只有三态、建案时定死、没有生命周期。
往这个方向长，比我原来想的「拒案回声」更干净。

### 2.3 文档纪律 —— 比架构更值得学的一条

原型 README 第一段就写清了：

> Some designs discussed in the article are **directions for future development and are not implemented in this prototype**.

**把「哪些是方向、哪些实现了」写在最显眼的位置。**

这正好是我们 10-31 那份审核报告栽的坑——三个分部的断言总数对不上仓库实际，
原因是「看起来验过了」。DeepSeek 这个习惯成本极低，收益极高。

---

## 三、必须明确拒绝的一样

**它的核心哲学不能借。**

`docs/000-philosophy.md` 开篇：

> **Take as little human attention as possible, and give as much value as possible.**
> Every part of the project is judged by the attention it costs.
> It speaks only when a person must act or can use a result.

**这句话套到初澜身上，会把她砍掉一半。**

初澜挂机 120 分钟写一张便签——按这个判据，它「cost your attention」而且不产生「value」。
照这个哲学，该删。

**但那张便签的价值恰恰在于它没用。** 那是她一个人待着的时候想说话。

所以我的判断是：

> **它的「授权机制」可以借，它的「注意力哲学」不能借。**

前者是工程，后者是产品定位。这两件事在这个文档里是绑在一起的，搬的时候必须拆开。

---

## 四、对初澜的具体方案

### 4.1 设计原则

1. **默认不改变现有行为。** 初澜现在 `selfNote` / `observerJournal` 是免授权直接写，
   这是你拍板过的（D-17 用户拍板 C1）。**不要因为引入 observe 就把默认降级**——那是收权，不是给权。
2. **observe 用在「新增的自发能力」上，不用在已有能力上。**
   已有能力已经跑出数据了（3 张便签），不需要再观察。新能力才需要。
3. **记录要给完整拟案，不是一句愿望。** 照 DeepSeek 的 `proposal { title, scope, worktree_name }` 形态。

### 4.2 具体设计：自发动作三档

在 config 里加一个字段（**默认 `auto`，保持现有行为**）：

```js
agentSelfInitiatedMode: 'off' | 'observe' | 'auto'   // 默认 'auto'
```

| 档位 | 她自发想做事时 | 落盘 | 记录 |
|---|---|---|---|
| `off` | 不评估（`wantToLeaveSomething` 直接跳过） | 否 | 否 |
| `observe` | 照常想、照常拟稿 | **否** | 写 `would_accept` + 完整拟案 |
| `auto` | 照常想、照常拟稿 | **是**（现状） | 写 `executed`（现状） |

**观察档的记录形态**（写进 `agent-audit.jsonl`，与现有审计同构）：

```json
{
  "at": 1793600000000,
  "channel": "agent:propose-action",
  "outcome": "would_accept",
  "proposalSource": "selfNote",
  "intentKind": "wantToLeaveSomething",
  "intentOrigin": "user_action",
  "proposal": {
    "title": "note-2026-11-01-xxxx",
    "scope": "<沙盒目录>\\note-2026-11-01-xxxx.txt",
    "contentPreview": "（正文前 200 字）",
    "contentBytes": 512
  },
  "reason": "observed"
}
```

⚠️ **`contentPreview` 只放前 200 字**，与现有 `AuditLog._appendToDisk` 的 500 字截断纪律一致。
不落全文——观察档不是存档，正文没写成就是没写成。

### 4.3 改动面（预估）

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/config.js` | 加 `agentSelfInitiatedMode` 默认值 + sanitize | ~10 |
| `main.js` `maybeAskForSelfNote()` | 拟稿成功后按档位分流：observe 只记不执行 | ~25 |
| `main.js` `maybeAskForObserverJournal()`（若有同构逻辑） | 同上 | ~20 |
| `src/agent-interfaces.js` | 审计 outcome 增加 `would_accept` 合法值 | ~5 |
| `test/agent-observe-mode.test.js` | 新增 | ~120 |

**不改**：执行器闸门、`proposalSource` 三态、沙箱白名单、预算熔断。

### 4.4 这个方案真正的用途

**不是现在切过去，是以后加新能力时用。**

举例：将来给初澜加「主动整理沙盒目录」「主动归档旧便签」这类新自发能力时——
**先让它跑 `observe` 一周**，你看记录里的完整拟案，判断她做得对不对，再切 `auto`。

这比「先放出去、出事再收回」安全得多，也比「一直问她」自由得多。

---

## 五、明确不做的

| 不做 | 理由 |
|---|---|
| 把 `observe` 设为默认 | 那是收权。她现在的免授权是你拍板的，不该因为引入新机制就降级 |
| 搬它的 Source / Thread / Channel / Executor 架构 | 那套是为「一个团队一个仓库」设计的，初澜没有这些概念。硬套会得到一个更复杂但不知道解决什么的东西 |
| 借它的注意力哲学 | 见第三节。「她的话没用」正是初澜的价值所在 |
| 现在做 Mandate 生命周期 | 那是主体性那条线，你说往后放。而且它依赖「她有过判断」这个前提，现在她拒过 0 次 |
| 现在做观察档的 UI 面板 | 先让记录落盘，用文本看。面板等有数据了再说 |

---

## 六、和之前那份方案的关系

| 文档 | 主题 | 状态 |
|---|---|---|
| `PROPOSAL-AGENT-HISTORY.md`（桌面已有） | 让她读得到自己的动作史 | 设计完成，未落代码 |
| **本文** | 从 DeepSeek 借 observe 三档 + Mandate 生命周期 | 设计完成，未落代码 |

**两份不冲突，但顺序要排**：

1. **先做 observe 三档**（本文 4.2）—— 因为它服务于「以后加新能力」，越早进越好
2. **再做动作史投影**（前一份）—— 它需要数据积累，而 observe 正好在积累数据
3. **最后做 Mandate 生命周期** —— 需要「她有过判断」这个前提

**注意 1 和 2 有协同**：observe 产生的 `would_accept` 记录，正好是动作史投影要读的数据源之一。
所以 observe 的记录格式（4.2 那张 JSON）应该**按动作史投影的需要来设计**，不要各做各的。

---

## 七、待你拍板

1. **observe 三档要不要进这一版？** 我建议进，理由：它只加一个配置字段和一条分流，
   不碰闸门，默认值不变，风险接近零，但它把「以后加新能力」的成本降下来了。
2. **记录格式认不认可？** 特别是 `contentPreview` 只放 200 字这条——
   它决定了观察档能不能真的用来判断「她写得对不对」。
3. **要不要我把这个也放进 `docs/`？** 还是只留桌面。

---

## 附：参考资料

- 官方文章报道：[IT之家 · DeepSeek提出Super-agent架构设计](https://news.qq.com/rain/a/20261031A0D6TD00)
- 原型仓库：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
- 哲学文档：[000-philosophy.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)
- 领域模型：[001-domain.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)
- 授权机制：[002-authorization.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)
- 三态实现源码：[src/policy.ts](https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/src/policy.ts)
