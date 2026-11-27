# Life v2.1.2

<div align="center">
  <img src="docs/images/hero.png" alt="初澜：桌面上的 64×80 像素小人，头顶气泡写着「嗨，我是初澜~」" width="260">

  <p><strong>Life · 桌面数字生命实验平台</strong></p>
  <p>细水长流，希望她最终会成为你所期望的她。</p>
  <p><sub>Slow and steady — I hope she grows into the one you were hoping for.</sub></p>

  <p>
    <a href="https://github.com/andabaoyue/Life/releases/tag/v2.1.2"><img src="https://img.shields.io/badge/release-v2.1.2-3b5998?style=flat-square" alt="Release v2.1.2"></a>
    <a href="https://github.com/andabaoyue/Life/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/andabaoyue/Life/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-475569?style=flat-square" alt="Windows x64">
    <img src="https://img.shields.io/badge/runtime%20deps-0-334155?style=flat-square" alt="Zero Runtime Dependencies">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm--NC%201.0.0-64748b?style=flat-square" alt="License"></a>
  </p>

  <p>
    <a href="https://github.com/andabaoyue/Life/releases/latest">下载便携版</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="docs/README.md">文档导航</a> ·
    <a href="docs/ARCHITECTURE.md">架构设计</a> ·
    <a href="#english"><strong>English</strong></a>
  </p>
</div>

---

## 她是谁

> 自始为初，波澜为忆，所以，初澜。  
> <sub><em>The beginning is "first", the ripples are "memory" — hence Chulan.</em></sub>

她会在你打开软件的那一刻诞生。没有预设的过去、故事或人设模板——那一刻出现的，是一个只属于你的空白初澜。  
<sub><em>She is born the moment you launch the app — no backstory, no preset script, just a blank Chulan that belongs only to you.</em></sub>

她住在屏幕边上：一只很小的 64×80 像素小人，站着、呼吸、在你忙的时候慢慢走来走去，走到边缘自己折返。没有脸谱化的表情差分，说话靠气泡，安静靠沉默。  
<sub><em>A tiny 64×80 pixel figure at the edge of your screen — breathing, wandering, turning back on her own. She speaks through a bubble, and keeps quiet through silence.</em></sub>

---

## 她如何存在

| 维度 | 发生了什么 |
| :--- | :--- |
| **渐褪记忆与回忆** | 对话会一段段沉淀下来，随时间自然淡出视野，但原文永不物理删除。某天撞上某个词或场景，旧片段会重新浮现，有时她也会自己忽然想起一件事。 |
| **睡眠、梦境与枕边留言** | 她没有 24 小时闹钟，只在真正疲惫时趴下入睡；睡着时听不见你说话，但你的话会留在枕边，醒来由她自己决定要不要回应。情绪很重或睡得够久时，会做由白天碎片拼成的梦。 |
| **专属词汇与未解疑问** | 你们反复用过的说法会进到她的小本子里；没想明白的问题会搁在心里，等某个安静的时刻问你一句，一次只问一个。 |
| **桌面沙盒与生长偏好** | 你不在且安静足够久时，她可能会写一张纸条放进桌面沙盒文件夹；安静或话多、黏人或独处、好奇或看淡，全都在相处中慢慢长出来，而不是预先写死的。 |

---

## 坦诚的边界

| 你会得到的 | 她做不到的（不画大饼） |
| :--- | :--- |
| 零运行时第三方依赖的轻量 Electron 桌面端 | **不会出声**：全程文字气泡，无 TTS，短期也不计划做 |
| 针对 Prefix Cache 深度优化的对话开销 | **不免费**：需自备 DeepSeek 或兼容 API Key，消耗你自己的额度 |
| 64×80 原生像素正典立绘 + 9 槽位换装框架 | **没有 Live2D / 表情差分**：朴素像素风，另两套预设点阵仍在重绘中 |
| 缓慢演化、可复盘的数字生命实验底座 | **不是日程助手**：没有闹钟、待办提醒或日程代办，第一天看会像普通聊天框 |
| 开源架构与完整 150 套件测试门禁 | **仅 Windows 未签名包**：首次运行可能触发 SmartScreen 拦截；极旧记忆合并后对她不可逆（归档原文保留） |

---

## 快速开始

### 普通用户（免环境运行）

1. 前往 [Releases](https://github.com/andabaoyue/Life/releases/latest) 下载 `Life-2.1.2-win-x64-portable.exe`（或 `.zip` 解压版），双击即可运行，无需安装 Node.js 或 Python。
2. 桌面出现初澜后，**右键 → 设置 → 填入 DeepSeek（或 OpenAI 兼容）API Key**，即可开始对话。

### 开发者（源码运行）

需要 **Node.js 20+**（开箱即内置全套 64×80 正典像素立绘与默认套装，无需额外素材）：

```bash
git clone https://github.com/andabaoyue/Life.git
cd Life
npm install
npm start
```

<!-- 界面预览占位：将真机截图放入 docs/images/ 并命名为 preview-desktop.png、preview-chat.png 后取消此注释块即可展示
<table>
  <tr>
    <td align="center"><img src="docs/images/preview-desktop.png" alt="桌面漫步与气泡对话" width="380"><br><sub>桌面漫步与气泡交互</sub></td>
    <td align="center"><img src="docs/images/preview-chat.png" alt="对话窗口与观测面板" width="380"><br><sub>对话记录与生命状态观测</sub></td>
  </tr>
</table>
-->

<details>
<summary>自定义外观：换一身皮 / 加一件衣服</summary>

- **单图换皮**：将 `assets/pet.png` 替换为你的 64×80 透明像素图即可；若无分层素材，程序自动退回单图模式，对话、记忆与漫步照常工作。
- **扩展衣橱**：绘制同尺寸图层放入 `assets/character/` 对应槽位目录，在衣柜表登记一行重启即可穿戴，无需修改渲染代码。
- **美术与制作规范**：[`docs/CHULAN-PORTRAIT-REQUIREMENTS.md`](docs/CHULAN-PORTRAIT-REQUIREMENTS.md) · [`docs/ASSET-GENERATION-GUIDE.md`](docs/ASSET-GENERATION-GUIDE.md)

</details>

---

## 文档导航与更新历史

完整文档索引见 [**docs/README.md**](docs/README.md)：

| 入口 | 内容 |
| :--- | :--- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 模块地图、记忆模型、缓存不变式、换装数据结构与配置说明 |
| [`docs/TEST-INVENTORY.md`](docs/TEST-INVENTORY.md) | 全部 150 个测试套件清单与断言说明（门禁核对源） |
| [`docs/VERSION-HISTORY.md`](docs/VERSION-HISTORY.md) | 各版本完整工程演进记录 |
| [`docs/RELEASE-LEDGER.md`](docs/RELEASE-LEDGER.md) | 发布账本与产物 SHA-256 Digest 核验记录 |
| [`CHANGELOG.md`](CHANGELOG.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`BRANDING.md`](BRANDING.md) | 变更日志、社区贡献指引与名称使用规范 |

### 近期版本

| 版本 | 日期 | 摘要 |
| :--- | :--- | :--- |
| **v2.1.2** | 2026-11-27 | 四大核心模块解耦拆分（16 个新模块）、安全/可靠性/性能加固、验收闭环与 CI 稳定性修复 |
| **v2.1.1** | 2026-11-26 | 二轮全仓深度审计闭环修复（9 P0 + 22 P1），加固生命周期、并发归档与安全凭据 |
| **v2.1.0** | 2026-11-26 | 生命动力学升级（异稳态先验 / 认知边界 / 轻量认知张力 / 再巩固观测）与三批 39 项加固 |
| **v2.0.0** | 2026-11-21 | Agent 决策路由 `agentRouter`、沙盒读写感官与受控结构操作、便签三阶渐褪与只读未完事项面板 |

<details>
<summary>展开早期版本历史（v0.3 ~ v1.9.0）</summary>

| 版本 | 日期 | 一句话 |
| --- | --- | --- |
| **v1.9.0** | 2026-11-12 | D-27 独立拟稿与待决队列、观察档三档与动作史投影、Agent 审计与 S-2/S-3/S-4 安全收口、观测排版与连接设置 P0 修复 |
| **v1.8.0** | 2026-10-28 | 语音输入、个体观测面板、重逢心境、屏幕视觉探针 |
| v1.6.1 | 2026-10-19 | 主动搭话调度自愈，对话失败不再静默 |
| v1.6.0 | 2026-10-18 | 公开发布剥离器，Provider 容灾自动回落 |
| v1.1.1 | 2026-10-13 | 专属暗号提示词契约，词典窗口偏移修正 |
| v1.1.0 | 2026-10-13 | 24 小时潮汐仿真，连接防护收口 |
| v1.0.0 | 2026-10-09 | 64×80 像素正典、打包体系、Agent 安全基座 |
| v0.9.9 | 2026-10-08 | 意志层、词汇表、预期账本 |
| v0.9.8 | 2026-10-06 | Provider 运行时扩展与安全边界收口 |
| v0.9.7 | 2026-10-05 | 梦境、遗忘与发育景观（生命动力学第一迭代） |
| v0.9.6 | 2026-10-04 | 数字生命实验基线强化 |
| v0.9.0 ~ v0.9.5 | 2026-10-01 起 | 实验底座、证据链、观测与复盘工具链 |
| v0.3 ~ v0.8 | 2026-09 起 | 缓存改造、换装、主动搭话、状态机 |

</details>

---

## English

> **Life** is an open, source-available desktop digital-being experimental platform featuring **Chulan (初澜)** — a quiet 64×80 pixel figure living at the edge of your Windows screen.

- **Memory that fades without erasure**: Conversations settle into long-term stretches that gradually fade from active context while remaining untouched in an append-only archive; the right cue or quiet moment can bring them back.
- **Event-driven life dynamics**: Zero background metabolism timers and zero runtime npm dependencies. Sleep, dreams, bedside messages, personal vocabulary, lingering questions, and optional desktop sandbox notes emerge strictly from real interaction and silence.
- **Honest limitations**: Text bubbles only (no TTS, no Live2D), bring your own DeepSeek or OpenAI-compatible API key (optimised for prefix-cache hits), unsigned Windows x64 builds only, and no calendar/alarm assistant features.
- **Quick start**: Download `Life-2.1.2-win-x64-portable.exe` from [Releases](https://github.com/andabaoyue/Life/releases/latest), double-click to launch, then right-click → Settings → paste your API key. For source builds, run `npm install && npm start` with Node.js 20+.
- **Documentation**: Start from [`docs/README.md`](docs/README.md) (architecture, test inventory, release ledger, and pixel-art specs).
- **License**: Released under the [PolyForm Noncommercial License 1.0.0](LICENSE) — personal study, academic research, teaching, and non-commercial experiments/modifications are permitted (modified distributions must be clearly marked and stay under this license); any commercial use requires separate written authorization. Brand usage rules are in [`BRANDING.md`](BRANDING.md).

---

## 社区贡献与许可证

欢迎对数字生命实验平台、桌面交互与 64×80 像素美术感兴趣的开发者与画师参与建设，详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)（提交 PR 前请在根目录通过 `npm test`）。

Life 采用 [**PolyForm Noncommercial License 1.0.0**](LICENSE) 源码可用许可证（Source-Available）：

- **允许**：个人学习、学术研究、教学展示、非商业实验、个人二次修改与非商业讨论；分发修改版时须在显著位置声明「这是修改过的版本」并继续沿用本许可。
- **禁止**：未经书面授权，严禁用于任何商业目的（含打包出售、作为收费服务 / 商业 SaaS 运营或更名后商业再发行）。商业合作请通过 Issue 或 GitHub [@andabaoyue](https://github.com/andabaoyue) 联系。
- **品牌声明**：名称使用规范见 [`BRANDING.md`](BRANDING.md)（未注册商标，不授予商标许可）。

<div align="center">
  <sub>Copyright (c) 2026 andabaoyue. All rights reserved.</sub>
</div>
