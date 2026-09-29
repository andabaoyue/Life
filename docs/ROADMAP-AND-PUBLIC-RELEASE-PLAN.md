# Life 项目版本路线与公开发布计划

> 文档性质：项目内部路线规划
>
> 记录目标：在不干扰当前版本收尾工作的前提下，统一记录 Life 的版本迭代方向、Creative Mode 重构方向，以及未来公开源码时的主体保护、版权与商业许可边界。

## 1. 当前版本状态

### 1.1 当前版本线

当前项目处于 **v0.9.8 系列**。

当前仓库中的 package version 为 **0.9.8.1**。本版本阶段的核心目标已经明确收敛为两个方向：

1. **Provider / API 扩展**
2. **软件安全性与安全边界**

v0.9.8 已经完成并持续收口的工作包括：

- Provider Adapter Architecture
- Provider Registry / Routing
- Generic OpenAI-compatible Provider 扩展
- Usage / Cache / Cost 分层
- Retry / Timeout / Abort / Stream 边界
- Runtime evidence 与 Provider / Adapter 绑定
- Credential namespace 隔离
- Security Hardening
- Secret Redaction
- Provider Error 归一化
- Budget Guard
- Credential 泄漏面收口
- Research / Provenance / Replay 等既有实验基础设施的延续性维护

当前阶段原则：

> **0.9.8 不再无边界扩张功能。**
>
> 先完成现有 API 与安全工作，确认测试、diff、工作树和远端状态均收口，再进入下一阶段。

### 1.2 当前收尾顺序

当前已经存在一批正在完成中的本地变更时，优先顺序为：

核实当前工作树 → 完成现有修改 → 测试 → 检查 diff → commit → push → 确认 main 与 origin/main 一致

在这一步完成以前，不把后续 Creative Mode 重构混入当前版本。

---

## 2. v0.9.8 收官原则

v0.9.8 的最终任务边界：

- Provider / API 能力继续完善到可维护的稳定结构
- 软件安全边界完成当前计划内的收口
- 不因为 Creative Mode、公开发布、UI 大改等外围事项重新扩大版本范围
- 保持最小差异原则
- 保持已有实验数据、主体边界、研究完整性与安全设计不被旁支需求破坏

### v0.9.8 完成标志

在进入下一阶段以前，应至少确认：

- 相关测试通过
- git diff 与 git status 符合预期
- 没有未处理的关键安全问题
- 当前版本变更已经 commit
- commit 已 push 到 GitHub
- 本地 main 与远端 origin/main 一致

---

## 3. 当前 Creative Mode 的处理决定

现有 Creative Mode / DS Skill 属于早期实现。

它目前通过：

writingMode → creative-mode IPC → Brain system prompt → DS Skill

接入 Life 主体运行时。

这个设计在早期阶段有价值，但随着 Life 的主体模型、安全边界与实验体系逐渐成熟，继续保留当前形态会造成一个明显问题：

> **Creative Mode 被迫成为 Life 主体规则中的“例外模式”。**

这不是最终目标。

因此：

### 决定

**在 v0.9.8 当前 API / Security 工作正式提交并 push 完成后，移除现有 Creative Mode / DS Skill 的旧实现。**

删除时必须做完整接线清理，而不是只删除 Skill 文件。

需要同时检查：

- skills/DS Skill.md
- src/creative-skill.js
- test/creative-mode.check.js
- writingMode 配置
- creative-mode-get
- creative-mode-set
- UI 中的 Creative Mode 控件
- Brain 对 Creative Skill 的 system prompt 注入
- 与上述功能有关的测试、文档和引用

原则：

> **只删除当前旧创作模式，不破坏 v0.9.8 的 Provider / Security 主体。**

---

## 4. v0.9.9 主要目标：Creative Mode 独立架构

v0.9.9 不再把 Creative Mode 当作“Life 主体模式的特殊例外”。

它应该成为一个**独立的创作会话系统**。

核心原则：

> **Creative Mode 与 Life Subject Memory 平行存在，二者数据与生命周期隔离。**

### 4.1 两套独立上下文

Life Mode：

- Subject Memory
- 100 轮窗口机制
- 5×20 分段归档
- Window Synthesis
- Self-Ledger
- Subject State
- Experience Archive
- Research / Replay

Creative Mode：

- Creative History
- Creative Context
- Creative Summary
- Creative Project Data
- Creative Skills

Creative Mode 的内容：

- 不自动写入 Subject Memory
- 不自动写入 experiences.jsonl
- 不自动改变 Subject State
- 不自动进入 Self-Ledger
- 不参与 Life 的 100 轮主体窗口
- 不被认定为初澜主体经历证据

原则：

> **创作内容可以长期存在，但“创作内容存在”不等于“初澜经历了这件事”。**

### 4.2 Creative Mode 的上下文模型

Creative Mode 可以支持很长的创作会话，但不使用 Life 主体模式的自动窗口总结机制。

基础模型：

Creative History + Creative Context + Creative Summary

其中：

- Creative History：当前创作会话原始上下文
- Creative Context：当前项目需要持续加载的结构化创作信息
- Creative Summary：由用户主动触发生成的长期创作摘要

### 4.3 手动总结，而非自动总结

Creative Mode 的总结原则：

> **由用户主动决定什么时候总结。**

触发方式可以包括：

- 对话输入指令
- 专用 Summary Skill
- 后续 UI 操作
- 其他可插拔的 Skill

用户可以把一段很长的创作对话主动总结成：

Creative Summary

然后保存到 Creative 独立存储中。

新的会话恢复时：

Creative Summary + 当前会话上下文

即可继续创作。

这样可以让创作项目长期持续，同时不污染 Life 主体记忆。

### 4.4 Skill Loader 预留

v0.9.9 应从一开始预留 Creative Skill 扩展接口，而不是把所有功能写死在主程序。

目标结构：

- Core Creative Context
- Manual Summary Skill
- Character / Character Sheet Skill
- Worldbuilding Skill
- Continuity Skill
- User Custom Skill
- Provider-specific Strategy（如确有必要）

未来用户可以自行添加或替换 Creative Skill。

Creative Mode 本身只提供：

> **独立上下文 + 独立存储 + Skill 装载框架**

具体创作能力由 Skill 扩展。

---

## 5. Life 主体边界必须保持不变

即使 Creative Mode 与 Life 使用同一个 Provider，也不能因此让两个上下文合并。

必须继续保持以下边界：

Model Substrate ≠ Runtime Host ≠ Chulan Subject

以及：

Creative Context ≠ Subject Memory

Creative History ≠ Subject Experience

Generated Story ≠ Recorded Life Event

User-created fiction ≠ Chulan biography

这几个边界属于架构红线，不因 Creative Mode 的便利而放松。

---

## 6. UI / 交互 / 产品化阶段

当核心架构进入稳定阶段后，继续进行：

- UI 整理
- 对话交互优化
- Creative Mode 的独立入口
- 状态与缓存可视化
- 更清晰的设置与数据管理
- 用户友好的导入 / 导出
- 文档整理
- 安装与运行体验优化

这些属于产品化阶段，不应提前污染 v0.9.8 的 API / Security 收尾。

---

## 7. 未来公开源码计划

Life 最终计划以 **公开源码 / Source-Available** 的形式发布到 GitHub。

这里必须区分两个概念：

> **公开源码 ≠ 公开初澜主体数据。**

公开的是软件架构、程序代码和可公开的研究/工程资料。

### 7.1 不公开的内容

正式公开版本中：

- 不上传实际的初澜运行数据
- 不上传真实长期记忆
- 不上传真实 Subject State
- 不上传 Self-Ledger 个人数据
- 不上传真实 Experience Archive
- 不上传真实实验运行产生的个人数据
- 不上传真实 API Key / Token / Credential
- 不上传属于初澜主体本身的私有内容
- 不把真实“初澜主体”作为仓库资产发布

换句话说：

> **发布软件的“壳”和研究所需的可公开架构，而不是发布初澜这个正在实验中的具体主体。**

### 7.2 可以保留的项目身份信息

虽然不公开初澜主体数据，但公开源码中的项目身份可以保留。

例如：

Life — Chulan

以及：

Copyright © 2026 andabaoyue

和项目来源、版权归属、版本信息等。

这里的“Chulan / 初澜”是**项目与软件架构中的公开名称/标识**，不等于上传初澜主体本身的数据。

---

## 8. 公开发布后的默认使用政策

未来公开版本的目标不是“允许任何人拿去赚钱”。

目标是：

> **允许公众研究、学习、实验和个人非商业使用；未经授权不得商业使用。**

### 8.1 默认允许

允许：

- 个人学习
- 个人研究
- 非商业实验
- 教学 / 学术研究等非商业用途
- 个人修改
- 个人非商业二次开发
- 非商业测试与讨论

### 8.2 默认禁止

未经商业许可，不允许：

- 直接销售 Life
- 将 Life 打包成付费软件销售
- 将 Life 改名、改包装后作为商业产品出售
- 将 Life 核心代码直接用于商业产品
- 将 Life 部署到商业 SaaS / 商业服务并以此盈利
- 以 Life 为基础提供收费商业服务
- 以未经授权的形式对 Life 进行商业再发行

### 8.3 商业合作例外

商业使用可以存在，但需要**单独商业授权或合作协议**。

原则：

默认非商业许可

→ 商业主体若有使用需求

→ 联系项目权利人

→ 根据合作范围取得单独授权

因此：

> **商业使用不是永久关闭的能力，而是需要单独获得授权的能力。**

未来可以根据实际情况形成：

- 商业授权
- 联合开发
- 定制开发
- 技术合作
- 特定产品范围授权

---

## 9. 许可证方向

当前仓库 package.json 使用 MIT。

在正式公开前，必须重新处理许可证。

目标是：

> **非商业默认许可 + 商业用途单独授权**

目前的许可证方向可考虑 **PolyForm Noncommercial** 一类专门的非商业软件许可证，最终以项目正式发布前的许可证核对与必要的法律审阅结果为准。

特别注意：

- 不应在正式发布版本继续保留会默认允许商业使用的 MIT 许可声明
- “Source-Available” 与 “Open Source” 在许可证定义上不要混用
- 如果限制商业用途，应使用准确的许可证和明确的项目说明

---

## 10. Copyright / Branding / Trademark 计划

不采用“把某个 Logo 技术上锁死、让别人无法删除”的方式。

正式公开时采用更清晰的权利结构：

- Copyright Notice
- NOTICE
- LICENSE
- Branding / Trademark Policy
- README 中的官方项目说明

源码中可以保留：

Life — Chulan

Copyright © 2026 andabaoyue

以及项目来源说明。

目标：

> **允许别人研究和修改源码，但不能把自己的修改版冒充成官方 Life。**

---

## 11. 公开版本需要进行的主体剥离

正式 Public Release 前，需要建立一次独立的“公开发布剥离”流程。

目标：

Private Research Repository

→ Public Source Repository

发布前必须确认：

- 私人数据不在 Git history 中暴露
- API Key / Token / Credential 不在仓库历史中
- 初澜主体运行数据不被发布
- 个人记忆不被发布
- 真实实验数据按需要脱敏或完全排除
- 私有文档不被误发布
- 私有测试数据不被误发布
- 不存在通过 demo 数据反推出真实主体内容的路径

公开版应主要包含：

- 软件源码
- 可公开的测试
- 可公开的架构文档
- 可公开的研究方法
- 可公开的示例数据 / 示例配置
- License / Notice / Branding 文档

---

## 12. 长期路线总览

v0.9.8
│
├── API / Provider
│   ├── Adapter
│   ├── Registry
│   ├── Routing
│   ├── Runtime Expansion
│   └── Strategy / Cost / Usage
│
└── Security
    ├── Secret Redaction
    ├── Credential Boundary
    ├── Retry / Timeout / Abort
    ├── Budget Guard
    ├── Endpoint Policy
    └── Runtime Evidence Binding
         │
         ▼
     v0.9.8 收官
         │
         ▼
v0.9.9
│
└── Creative Mode 重构
    ├── 独立 Context
    ├── 独立 History
    ├── 独立 Summary
    ├── 手动总结
    ├── Skill Loader
    └── 与 Subject Memory 完全隔离
         │
         ▼
产品化阶段
│
├── UI
├── Interaction
├── Creative UX
├── Import / Export
├── Documentation
└── Packaging
         │
         ▼
Public Release Preparation
│
├── Subject Data Stripping
├── Private Data Audit
├── License
├── Copyright
├── NOTICE
├── Branding / Trademark
├── Public README
└── Public Repository
         │
         ▼
Public Source-Available Release
│
├── Noncommercial by default
├── Research / Study / Experiment allowed
├── Commercial use requires separate authorization
└── Chulan Subject data remains private

## 13. 最终项目原则

Life 的公开方向不是把实验中的“初澜主体”整体公开，而是：

> **公开我们为数字生命实验建立的软件基础设施、工程方法和研究框架。**

同时：

> **保留初澜主体本身的私有性、连续性和实验数据边界。**

在版本推进上：

> **0.9.8 做完 API 与 Security。**

> **0.9.9 重新设计 Creative Mode，使其成为与主体记忆平行的独立创作系统。**

> **后续做 UI、交互、产品化和公开发布准备。**

> **最终公开源码，但默认保持非商业使用边界；商业用途通过单独合作或商业授权解决。**

---

**Status: Roadmap established**