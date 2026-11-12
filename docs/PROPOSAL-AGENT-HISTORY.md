# 方案：让初澜读得到自己的动作史

> 状态：**设计稿，未落代码**
> 日期：2026-10-31
> 基线：`0d00d22`（v1.9.0-dev）
> 范围：只做「她读得到自己的动作史」这一条，**不动闸门逻辑，不动授权策略**

---

## 〇、先纠正我自己上一轮说错的两处

方案建立在事实之上，所以我先把错的改掉。

### 错误一：「她读不到自己的账本」

**不准确。** 她有一条真实通路：

- `main.js:411` → `brain.askForSelfNote()` 拿到内容
- `main.js:441` 盖 `'selfNote'` 戳 → 执行器 `SELF_NOTE_EXEMPT` 免确认直接写
- `brain.js:3349 _engraveSelfNotes()` 关窗时铸进 `experiences.jsonl`（`recordType: 'self_note'`）
- 下轮 `memory._drainSelfNotes()` 把**内容**注入尾部，并带上「【自发留痕事实】…已铸入你的经历档案」

**所以：她自发写的东西，内容她自己读得到，而且已经进了经历档案。**

### 错误二：「免授权还没做」

**做了。** `src/agent-executor.js:465-470`，三态 `proposalSource`：

| 值 | 闸门 | 谁建的案 |
|---|---|---|
| `user` | 保留第五道闸门 | 通路 B（你吩咐她写） |
| `selfNote` | `SELF_NOTE_EXEMPT` 免确认 | 通路 A（她自发留便签） |
| `observerJournal` | `OBSERVER_JOURNAL_EXEMPT` 免确认 | 她自主观察日记 |

而且这个字段是 `createActionProposal` 的**独立第三参数**，渲染端塞不进来——这是 D-3 防顶替的设计，是对的。

**结论：你要的「她自己的事不用问我」，已经实现了。**

---

## 一、真正缺的是什么（重新定义问题）

把上面两条摆在一起，缺口就清楚了：

| 她知道的 | 她不知道的 |
|---|---|
| 自己写过的**内容**（经 `_drainSelfNotes` 注入） | 自己**拒绝过什么** |
| 自己写的东西**已进档案**（一句事实行） | 自己**建过几次案**、**失败过几次** |
| | 那些判断**后来怎么样了** |

关键的三处断点：

### 断点 1：`refused` 是单向的

`main.js:191` 把拒案写进 `agent-audit.jsonl`（`outcome: 'recorded'`），然后**结束**。

她不知道：
- 拒了之后你怎么办了
- 那件事后来又发生过没有
- 她拒得对不对

### 断点 2：写失败被刻意瞒着她

`main.js:469`，决策 4：

```js
// 决策 4：写失败不告诉她，只记日志（审计里执行器已记了原因）。
console.log('[Agent] 自发留条未落盘（按设计不告诉她）:', exec && exec.error);
```

**她以为自己写了，其实没写成。** 下一次 `_drainSelfNotes` 什么都捞不到，她的记忆里这件事不存在——但她的意图确实执行过。

这不是 bug，是当初的设计选择（怕打扰她）。但它制造了一个**认知与事实不符**的缺口。

### 断点 3：`agent-audit.jsonl` 她完全读不到

`main.js:1314` 注释直说「那是**给我们排查用的**」。

而这份文件里恰好躺着她的全部动作史：

```
agent:propose-action | accepted   3
agent:execute       | executed   2
agent:execute       | failed     1
agent:execute       | rejected   1
agent:confirm-action| recorded   1
proactive-offer     | dispatched 21
chat-failed         | failed     1
```

30 条记录，其中属于她的动作有 8 条（3 accepted + 2 executed + 1 failed + 1 rejected + 1 recorded）。剩下 21 条是 `proactive-offer` 调度事件、1 条是 `chat-failed` 系统故障——**那些不是她的动作**。

---

## 二、方案

### 设计原则（三条，按优先级）

1. **只给她读「她自己的动作」**，不给系统事件、不给用户操作、不给调度日志。审计日志里混着三种东西，混着喂进去等于让她把系统噪音当成自己的经历。
2. **不改 `agent-audit.jsonl` 的写侧**。它是安全审计，格式和 append-only 语义一个字不动。**只在读侧加一个投影层。**
3. **注入走尾部，不进 system**。护前缀缓存不变式，与 `bedside` / `selfNote` / `reunion` / `vision` 同一个挂点。

### 三件事，按顺序做

#### 第一件：动作史投影（最小可交付）

**目标**：让她在需要时，能读到「我最近做过什么、结果如何」。

**做法**：

新增 `src/agent-history.js`（纯函数模块，零副作用）：

```js
/**
 * 把 agent-audit.jsonl 投影成「她自己的动作史」。
 * 只收她自己的动作，系统事件与用户操作一律剔除。
 */
function projectOwnActions(records, opts = {}) {
  // 收：channel === 'agent:execute'（她真的执行过，含失败）
  // 收：channel === 'agent:propose-action' && outcome === 'recorded'（她拒绝建案）
  // 剔除：proactive-offer / chat-failed / agent:confirm-action
  // 剔除：proposalSource === 'user'（那是你让她做的，不算她的自发动作）
}
```

**关键判据**：`proposalSource`。只有 `selfNote` / `observerJournal` 算「她的动作」，`user` 那条是你吩咐的，不进她的动作史。

**挂点**：与 `selfNote` 同一位置，在 `memory.build()` 尾部注入。但要**按需**——不是每轮都注入，而是在她要做判断的时候（比如 `askForProposalContent` / `askForSelfNote` 调用前）。

这个细节很重要：**每轮注入 = 噪音 + 烧 token + 破坏缓存**；按需注入 = 她只在真正要判断时才看账本，像人查账一样。

**改动面**：
- 新增 `src/agent-history.js`（约 80 行）
- `src/brain.js`：`askForProposalContent` / `askForSelfNote` 里加一次 `agentHistory.project(...)` 调用，把结果作为参数传进去（约 10 行）
- `test/agent-history.test.js`（新增，约 120 行）

**不改**：`agent-audit.jsonl` 写侧、执行器闸门、`proposalSource` 三态。

#### 第二件：`refused` 的回声

**目标**：她拒过的事，后来怎么样了，让她知道。

**做法**：

拒案时在 `memory.data` 里留一条待回声记录（不进 `agent-audit`，那是审计）：

```js
{
  kind: 'refusal_echo',
  refusedAt: <ts>,
  proposalId: '...',
  intentKind: '...',      // 她拒的是哪类意图
  reason: 'EXPLICIT_REFUSAL',
  resolved: false
}
```

**回声的触发点**（三选一，我建议第 3 条）：
1. 你又提了同一件事 → 她看到「上次我拒过这个」
2. 过了一段时间她主动回想
3. **下次同类意图再出现时**——她拒过 `wantToLeaveSomething`，下次这个意图再来，让她知道「上次我拒了，后来没写」

第 3 条最自然：**同类判断再次面对时，上一次的判断结果浮现**。这是人长判断力的方式。

**改动面**：
- `main.js` 拒案处（约 191 行附近）：多写一条 `memory.data.refusalEchoes`（约 15 行）
- `src/brain.js`：`askForProposalContent` 开头读同类未回声的拒案，拼进 prompt（约 15 行）
- 测试（约 80 行）

#### 第三件：写失败让她知道（可选，但我建议做）

**目标**：把「决策 4」的静默改成**如实告知**。

现在：写失败 → 只 `console.log` → 她以为自己写了
改成：写失败 → 下轮尾部注入一行客观事实「你上次想写的那张纸条没写成，原因是 X」

**为什么建议改**：现在的做法让她**持有错误的自我认知**。这跟「数据不伪造」是同一类问题——不是伪造了数据，是让她对事实产生了错误信念。

而且这个改动很小，只影响 `main.js:469` 那个 `else` 分支 + `memory` 加一个 `failedSelfNotes` 队列。

**但这条要你拍板**，因为它会改变她「不知道自己失败了」这个状态。你可能当初就是故意让她不知道的。

---

## 三、明确不做的（附理由）

| 不做 | 理由 |
|---|---|
| 放宽通路 B 的授权 | 「你让我写」和「我自己要写」的区别是她作为主体的边界。免掉这个区别，她做事就全变成自动执行 |
| 把 `agent-audit.jsonl` 全量喂给她 | 里面有你的操作、系统故障、调度噪音。混着喂等于让她把噪音当经历 |
| 每轮都注入动作史 | 噪音 + 烧 token + 破缓存。按需注入才像「查账」 |
| 改 `agent-audit.jsonl` 格式 | 它是安全审计，append-only，不动 |

---

## 四、验证方式

每件都要能验证，不能只看「代码写了」。

1. **单测**：`test/agent-history.test.js` —— 喂构造的审计记录，断言投影结果只含她自己的动作、`user` 来源被剔除、系统事件被剔除
2. **真实数据回放**：拿现在这 30 条真实审计跑一遍投影，人工核对输出是否只有那 8 条
3. **接线断言**：`askForProposalContent` 真的调了投影（防「模块存在但没接」）
4. **前缀缓存不变式**：跑 `test/brain.test.js` 确认 system 逐字未变
5. **全量门禁**：`npm test` 保持 136 套全绿

---

## 五、我需要你拍板的三件事

1. **第一件（动作史投影）要不要做？** 我建议做，它是后面两件的基础。
2. **第二件（`refused` 回声）的回声触发点选哪个？** 我推荐「同类意图再次出现时」。
3. **第三件（写失败告知）做不做？** 它会改变她现在「不知道自己失败」的状态，这条得你定。

---

## 附：上一版这里写错了，现已查清

**上一版我写的是**：「`main.js:191` 拒案留痕的 `outcome` 是 `'recorded'`，但真实审计里只有 1 条，所以要么她只拒过 1 次，要么留痕没覆盖全路径。」

**这个读法是错的。** `'recorded'` 不是拒案。

### 真实情况（已核实）

`auditProposalRefused` 写的是两个专用 outcome（`main.js:186` 注释写明）：

| outcome | 含义 |
|---|---|
| `refused_by_subject` | 她主体性地拒绝立项 |
| `draft_unavailable` | 拟稿故障/不可用（空、过短、关机、异常） |

真实审计 30 条里，这两个值**都是 0 条**：

```
refused_by_subject = 0
draft_unavailable  = 0
```

而那 1 条 `recorded` 属于 `channel: 'agent:confirm-action'`，`decision: 'approved'` —— 是**用户批准执行**的留痕，跟拒案无关。

### 所以结论是

**她从来没有拒绝过立项。** 不是记录不全，是这件事没发生过。

这反而是好消息：`refused` 回声这个功能**目前没有历史数据可回声**。做的时候不能假设「已有拒案可读」，必须从「第一次拒案」开始建账。这一点会影响第二件的实现——它得先有数据，才谈得上回声。

### 顺带查清的第二件事

3 条 `accepted` 的提案**全部**是 `proposalSource: 'selfNote'`（她自发留条），而且：

- 第 1 条 `note-2026-10-07-jniv.txt` → 执行成功
- 第 2 条 `note-2026-10-07-qxma.txt` → 用户点了【授权】→ 执行器回 `ALREADY_EXECUTED`（`outcome: 'rejected'`）
- 第 3 条 `note-2026-10-27-oqyr.txt` → 执行成功

**第 2 条就是 `main.js:458` 注释里记的那次实测事故**：`selfNote` 本该免确认，却仍然广播了 `agent-proposal-pending`，渲染端无条件亮卡，用户点了【授权】→ 白点一次。审计里 `agent:confirm-action` + `ALREADY_EXECUTED` 那两条就是它的化石。

这说明**那个 bug 真实发生过，而且审计把全过程记下来了**——也说明这个审计日志确实能当她的动作史用，只是需要正确的投影口径（`proposalSource` 判据是必需的，否则 `ALREADY_EXECUTED` 这种系统噪音会被误读成「她做错了一件事」）。
