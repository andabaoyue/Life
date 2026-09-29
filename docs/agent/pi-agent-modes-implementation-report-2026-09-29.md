# pi-agent-modes 实现报告（2026-09-29）

> 本文是实现报告，不是 Agent Skill。按约定只记录以下 8 项，全部为实测/包内实证事实。

## 1. 实际使用的 extension 文件名

`extensions/index.ts`（npm 包 `pi-agent-modes` 的 manifest 入口，经 `pi install` 实际加载）。
自写文件 `.pi/extensions/pi-agent-modes.ts` 未实际使用（已由第三方取代，处置待裁决）。

## 2. extension 的实际来源

**第三方 npm 包**：`pi-agent-modes@0.3.0`（`registry.npmjs.org`，仓库 `github.com/yoyo406/pi-agent-modes`）。非自写。

## 3. package / manifest 情况

| 项 | 值 |
| --- | --- |
| 包名 / 版本 | `pi-agent-modes` / 0.3.0（latest） |
| license | MIT |
| 运行时 dependencies | 0 |
| peerDependencies | `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox` |
| scripts | 仅 `typecheck` / `test`，无 install 钩子 |
| manifest 入口 | `extensions/index.ts` |
| 包体 | 19 文件，87.6 kB |

安装方式：`pi install npm:pi-agent-modes`，0 vulnerabilities。

## 4. extension 如何实现 mode switching

- `/mode` 命令：列出、切换、别名（`act`=build、`audit`=review、`fix`=debug、`autopilot/go`=yolo）、补全。
- `--modes <name>` CLI flag：启动时直接进入指定模式。
- 切换时调用 pi Session control（`pi.setThinkingLevel()` 等）应用该模式的 thinking 级别与工具策略，并切换该模式的 system-prompt 指令段；离开模式时恢复先前 thinking level。
- 每模式独立 system-prompt 段，可经配置 `instructions` 替换或 `extraInstructions` 追加。

## 5. extension 如何改变 active tools

- 策略评估顺序：`allowTools` → `blockTools` → `allowWriteTools`（edit/write）→ `bash` 策略 → `blockUnknownTools`（只读模式默认 true；`allowTools` 恒优先）。
- 只读模式把 write/edit 从模型工具表移除（模型看不到该工具），工具集在离开模式时恢复。
- 底层经 pi 的 active tools 机制（AgentSession `setActiveToolsByName`）。

## 6. extension 如何处理 bash

- 每模式 `bash` 策略三档：`allow` / `readOnly` / `deny`。
- `deny`：模型看不到 bash 工具。
- `readOnly`：严格校验命令，拦截危险 flag（`-i`、`--in-place`、`--delete`、`--exec`、`--execdir`、`-x`、`--exec-batch` 等）与危险调用模式（`system|exec|eval|spawn|popen|subprocess|unlink|rename|chmod|chown`），非只读命令拒绝。

## 7. extension 如何改变 thinking level

- 经 pi Session control 的 `pi.setThinkingLevel(level)` 运行中切换，离开模式恢复先前级别。
- 配置字段 `thinkingLevel`：`off | minimal | low | medium | high | xhigh | max`（`null` 清除强制）。
- 包内默认：plan / review / ask / debug 强制 high；Life 配置已按目标覆盖（见第 8 节）。

## 8. modes.config.json 完整配置结构（无 secret）

文件：`.pi/modes.config.json`（项目级，trust-guarded；无任何密钥/凭据内容，已核对全文）。

```json
{
  "defaultMode": "ask",
  "modes": {
    "ask": {
      "description": "ASK / EXPLORE（Life）：只讨论、只解释、只读调查，不修改文件",
      "thinkingLevel": "low",
      "extraInstructions": [
        "Life ASK/EXPLORE 模式：只讨论、解释、只读调查；禁止修改任何文件；低成本思考，输出精炼。",
        "Life 只读模式规则：不得修改文件；不得 commit / push。",
        "Token 纪律：不做不必要的文件扫描；不重复读取；不重复调用工具；不读无关源码；不整文件重写；不重复验证；不写冗长报告。"
      ]
    },
    "plan": {
      "description": "PLAN（Life）：只制定方案，不修改文件",
      "thinkingLevel": "medium",
      "extraInstructions": [
        "Life PLAN 模式：只产出方案与步骤，不实施修改；方案遵守最小差异原则。",
        "Life 只读模式规则：不得修改文件；不得 commit / push。",
        "Token 纪律：不做不必要的文件扫描；不重复读取；不重复调用工具；不读无关源码；不整文件重写；不重复验证；不写冗长报告。"
      ]
    },
    "build": {
      "description": "BUILD（Life）：正常开发（等价 act）",
      "thinkingLevel": "medium",
      "extraInstructions": [
        "Life BUILD 模式：正常开发，最小差异修改；修改后跑相关测试并检查 git diff；不默认 commit/push。",
        "Life 写入模式规则：默认只在 ~/Life 仓库内工作，不修改仓库外文件；不碰 API Key/Token/credentials；不默认 commit；不默认 push；绝不执行 force push / reset --hard / clean -fd；保留用户已有修改。",
        "Token 纪律：不做不必要的文件扫描；不重复读取；不重复调用工具；不读无关源码；不整文件重写；不重复验证；不写冗长报告。"
      ]
    },
    "debug": {
      "description": "DEBUG（Life）：系统性定位问题（等价 fix）",
      "thinkingLevel": "high",
      "extraInstructions": [
        "Life DEBUG 模式：系统性定位根因，结论附证据；没有证据不声称已修复。",
        "Life 写入模式规则：默认只在 ~/Life 仓库内工作，不修改仓库外文件；不碰 API Key/Token/credentials；不默认 commit；不默认 push；绝不执行 force push / reset --hard / clean -fd；保留用户已有修改。",
        "Token 纪律：不做不必要的文件扫描；不重复读取；不重复调用工具；不读无关源码；不整文件重写；不重复验证；不写冗长报告。"
      ]
    },
    "review": {
      "description": "REVIEW / AUDIT（Life）：只读代码审查与安全/研究审计（等价 audit）",
      "thinkingLevel": "high",
      "extraInstructions": [
        "Life REVIEW/AUDIT 模式：只读审查与审计，禁止修改文件；调查范围限定在目标内，限制无关探索；区分【事实】/【推断】/【未验证】。",
        "Life 只读模式规则：不得修改文件；不得 commit / push。",
        "Token 纪律：不做不必要的文件扫描；不重复读取；不重复调用工具；不读无关源码；不整文件重写；不重复验证；不写冗长报告。"
      ]
    },
    "yolo": {
      "enabled": false
    }
  }
}
```

映射关系：ASK/EXPLORE→`ask`、PLAN→`plan`、BUILD→`build`(act)、DEBUG→`debug`(fix)、REVIEW/AUDIT→`review`(audit)、`yolo` 禁用。

## 9. 当前已实际验证的项目（测试事实）

| # | 验证项 | 方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 安全清单 6 项 | registry 元数据 + 零落盘 tarball 流式源码审查 | 全部通过 |
| 2 | 安装 | `pi install npm:pi-agent-modes` | 成功，0 vulnerabilities |
| 3 | 扩展被 Pi 加载 | `pi --help` 显示 `--modes` flag；模式横幅「ASK 🔒」注入可见 | ✅ |
| 4 | 模式可切换 | `--modes ask/build/debug` 行为各异、正确进入 | ✅ |
| 5 | 只读阻断写工具 | ASK 下令其 write，工具被策略禁用，文件未创建 | ✅ |
| 6 | BUILD 恢复写工具 | BUILD 下同指令，write 成功（验证后已清理） | ✅ |
| 7 | thinking 随模式变化 | 会话内实测 `PI_REASONING_LEVEL`：build=medium、debug=high | ✅ |

## 10. 尚未验证的项目（【未验证】，如实标注）

1. `yolo` 禁用在 print 模式未生效——【推断】项目配置需 project trust（`ctx.isProjectTrusted()`）才加载，待交互式可信会话复核。
2. TUI 内 `/mode` 命令的运行中切换——未验证（仅验证了 `--modes` 启动指定）。
3. `plan` / `review` 的 thinkingLevel 覆盖效果——未行为实测（仅 build/debug 两档实测过）。
4. 各模式 `extraInstructions` 的实际注入效果——仅 ASK 模式横幅实测可见，其余模式未逐条观测。
5. ASK/EXPLORE、PLAN 模式的别名入口（`audit`/`act`/`fix`）——未逐一切换实测。

## 11. 外部问题备注（与 Life 无关）

> **手机端 Pi Agent 输入框粘贴问题：当前正在修复中。** 多行文本直接粘贴到手机端 Pi Agent 的对话框时，存在前面内容被提前触发/提交而**最后一行无法正常输入**的现象。
>
> 该问题属于**手机端 Pi Agent / 输入框交互层**问题，不属于 Life 源码、Life runtime 或 Life API/provider 架构问题；在后续 Life 审计、回归检查和问题归因中，**不得将此现象计入 Life 缺陷**。

## 12. 本轮 commit hash

`dbbc11f`（feat(agent): add Life workflow modes，仅 `.pi/modes.config.json`，53 行）——**本地提交，尚未 push**。
（上一任务提交 `ba5f7ac` 已在远端，非本轮。）
