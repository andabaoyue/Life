# P2 诊断更正：self-ledger 为空的真实原因

> **本文件纠正 2026-10-06 早先的判断。** 早先称"提取器系统性编造证据、被核验拦 17次"，
> 那是**误读归档数据**。逐条核验后真相如下。

## 一、结论先行

`self-ledger.json` 的 `entries` 为空，**不是核验太严把合法成长拦掉了**。

| 项 | 真实数字 |
|---|---|
| `growthCalls` | 3 |
| growth 遥测实际调用 | 4 次（10/1 19:05 / 10/2 10:54 / 10/2 15:10 / 10/3 22:44） |
| 最近一次 growth 调用 | **10/3 22:44**（= window 4 关窗时刻） |
| `self_projection` 归档条数 | **0** |
| `self-ledger.entries` | 0 |

**关键事实：`growthCalls` 停在 3 不是 bug，是「之后没有关过窗」。**

窗口关闭时间线（来自 `experiences.jsonl` 的 `sourceMessageRange`）：

```
window 1  归档 10/1 19:05   m-000001~ m-000042
window 2  归档 10/2 10:54   m-000044~ m-000129
window 3  归档 10/2 15:10   m-000130~ m-000197
window 4  归档 10/3 22:44   m-000198~ m-000400
（当前活跃窗口，未关）      m-000401~ m-000531   ← 131 条消息在这里
```

`growSelf()` 只在关窗路径里被调用（`brain.js:1611`，前置条件
`cfg.selfGrowthEnabled === true` —— 实测该配置为 `true`，开关是开的）。
10/3 22:44 之后**一次窗都没关过**，所以没有新的 growth 调用，账本自然是空的。

**账本空是「还没到时候」，不是「被拦掉了」。**

## 二、我上一轮误读了什么

我统计了 `experiences.jsonl` 里的拒绝原因，得到：
`MISSING_MESSAGE_ID` ×10、`MISSING_QUOTE` ×7、`QUOTE_NOT_IN_SOURCE_MESSAGE` ×3。

**这批拒绝全部不属于 self-ledger 通路。** 它们来自 `stateEvidence`（五格数
`subject-state` 的证据提取），不是 `self_projection`。真正属于 self-ledger 的拒绝是：

```
window 1: DUPLICATE_EVIDENCE_FINGERPRINT ×4
```

即**同一批证据被重复提交，去重机制正常工作** —— 这是设计意图，不是病灶。

而且 `subject-state` 那条路是**通的**：

```
window 1  verified= 7  rejected=4
window 2  verified=12  rejected=5
window 3  verified=11  rejected=8
window 4  verified=24  rejected=7
```

54 条成长证据全部核验通过，稳稳落进 `subject-state.json`。

## 三、对话文本里本来就有 messageId

我早先说「prompt 里没给 ID 清单，模型无从知道哪些 ID 存在」—— **这也是错的**。
`brain.js:1130`：

```js
const idPrefix = m.messageId ? `[${m.messageId}] ` : '';
return `${idPrefix}${roundPrefix}${speaker}：` + ...;
```

送进 prompt 的每一行对话**都带 `[m-000123]` 前缀**，ID 清单就在文本里。
所以「补 ID 清单」这个方案是多余的，不必做。

## 四、那还剩什么问题

`entries` 空的**唯一真实原因**是流程性的，不是缺陷性的：

> 生命账本只在**关窗成长**时写入。当前活跃窗口已经攒了 131 条消息（远超100 轮
> 的 `turn_limit`），一旦关窗就会产出第一条 `self_projection`。

所以 P2 **不需要改代码**。它是一个「等下一次关窗自然发生」的事。

唯一值得考虑的是**观测**：账本空着的时候，哲学审计里那张验收表第 4 行
「认知溯源可视化」看不出端倪。可以考虑在观测面板显式区分
「尚未沉淀」vs「沉淀失败」——但那是 UI 增强，不是 bug 修复。

## 五、待办

1. **关窗验证**：下次关窗后查`experiences.jsonl` 是否出现首条 `self_projection`、
   `self-ledger.entries` 是否 > 0。这是 P2 唯一的验收标准。
2. **不要**为 P2 改 `GROWTH_SYS` 提示词—— ID 清单已在对话文本里，
   核验机制也没有误伤。改提示词只会引入新的复读/幻觉风险。
3. 哲学审计验收表第 4 行暂标「待首次关窗后复核」，不要提前标 PASS。
