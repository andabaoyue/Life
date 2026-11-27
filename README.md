# Life v2.2.2

<div align="center">
  <img src="docs/images/hero.png" alt="初澜：桌面上的 64×80 像素小人，头顶气泡写着「嗨，我是初澜~」" width="260">

  <p><strong>住在你桌面边上的小小数字生命</strong></p>
  <p>细水长流，希望她最终会成为你所期望的她。</p>
  <p><sub>Slow and steady — I hope she grows into the one you were hoping for.</sub></p>

  <p>
    <a href="https://github.com/andabaoyue/Life/releases/tag/v2.2.2"><img src="https://img.shields.io/badge/release-v2.2.2-3b5998?style=flat-square" alt="Release v2.2.2"></a>
    <a href="https://github.com/andabaoyue/Life/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/andabaoyue/Life/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-475569?style=flat-square" alt="Windows x64">
    <img src="https://img.shields.io/badge/runtime%20deps-0-334155?style=flat-square" alt="Zero Runtime Dependencies">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm--NC%201.0.0-64748b?style=flat-square" alt="License"></a>
  </p>

  <p>
    <a href="https://github.com/andabaoyue/Life/releases/latest">下载便携版</a> ·
    <a href="#快速开始">两分钟上手</a> ·
    <a href="docs/README.md">文档导航</a> ·
    <a href="docs/ARCHITECTURE.md">给开发者看</a> ·
    <a href="#english"><strong>English</strong></a>
  </p>
</div>

---

## 她是谁

> 自始为初，波澜为忆，所以，初澜。  
> <sub><em>The beginning is "first", the ripples are "memory" — hence Chulan.</em></sub>

她会在你第一次打开软件的那一刻诞生。没有提前写好的身世，也没有固定的剧本或性格模板——出现在你屏幕上的，是一个只属于你的空白初澜。  
<sub><em>She is born the moment you open the app. No pre-written past, no fixed script — just a blank Chulan that belongs only to you.</em></sub>

她就住在屏幕边上：一只小小的 64×80 像素小人，平时站着呼吸，你不理她的时候会自己慢慢散步，走到屏幕边上再折回来。没有夸张的动画和配音，想说话时冒一个气泡，不想说话时就安安静静待着。  
<sub><em>A tiny 64×80 pixel figure at the edge of your screen — breathing, wandering when you are busy, turning back on her own. She speaks through a bubble, and keeps quiet through silence.</em></sub>

---

## 和她相处会发生什么

| 日常片段 | 具体体验 |
| :--- | :--- |
| **会淡、但不会消失的记忆** | 你们聊过的天会一段段存下来，时间久了会慢慢淡出她的眼前，就像人会淡忘旧事一样。但聊过的原文一直安稳躺在本地，一个字都没删——哪天你提到某个词，或者某个安静的瞬间，那段记忆会自己浮起来。 |
| **累了才睡，醒了看留言** | 她没有「晚上十点必须睡觉」的固定作息，只在真正疲惫时趴下休息。她睡着时听不见你说话，但你发的消息会留在她枕边；等她醒过来，会看到你什么时候来过，回不回复由她自己决定。情绪很重或睡得够久时，她还会做由白天碎片拼成的梦。 |
| **长出你们之间的小习惯** | 你们经常用的称呼或说法，会慢慢进到她的小本子里，下次聊天她可能自然就用出来了；心里有没想明白的问题，也会先攒着，等某个安静的时候顺口问你一句，一次只问一个。 |
| **偶尔在桌面留一张字条** | 你离开电脑、安静了很久之后，她可能会在桌面的专属文件夹里留下一张小纸条。而且她喜欢安静还是话多、黏人还是想独处，都不是提前设定的，是在日复一日的相处里慢慢长出来的。 |

---

## 先说清楚：她擅长什么，不做什么

| 你会喜欢的 | 先打个预防针（不画大饼） |
| :--- | :--- |
| **轻巧省心**：软件干净，没有乱七八糟的捆绑插件和后台轮询，安静驻留不打扰 | **不会出声**：全程文字气泡，没有语音朗读，短期也不打算加 |
| **省 API 额度**：专门针对对话缓存做过优化，平时闲聊花销很小 | **需要自备 Key**：软件本身免费，但聊天要填你自己的 DeepSeek 或兼容 API Key |
| **支持自由换装**：自带 64×80 像素立绘和 9 个换装槽位，也能换成你自己画的角色 | **画风很朴素**：就是小像素人，没有 Live2D，也没有丰富的表情差分，另外两套预设服装还在画 |
| **慢慢长出性格**：适合长期挂在桌面上细水长流地陪着 | **不是效率助手**：不会提醒你开会，也没有闹钟和待办清单；刚认识的第一天，她看起来甚至有点像普通聊天框 |
| **数据留在本地**：所有记录都在你自己电脑上，开源可查 | **目前只有 Windows 版**：没做商业代码签名，首次双击可能会被系统拦截提示；聊得太久后，最早的几段回忆会被压缩成模糊印象（本地原文仍完整保留） |

---

## 快速开始

### 普通用户（下载即用，不需要懂代码）

1. 打开 [Releases 页面](https://github.com/andabaoyue/Life/releases/latest)，下载 `Life-2.2.2-win-x64-portable.exe`（免安装便携版）或 `.zip` 压缩包，双击就能直接打开。
2. 桌面上出现初澜后，**右键点击她 → 设置 → 填入你的 DeepSeek（或 OpenAI 兼容）API Key**，就可以开始聊天了。

### 开发者（从源码运行）

需要 **Node.js 20+**（仓库已内置全套 64×80 正典像素立绘与默认服装，拉下来就能直接跑）：

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
<summary>想换角色或加新衣服？点这里看自定义方法</summary>

- **直接换一身皮**：把 `assets/pet.png` 换成你自己画的 64×80 透明像素图就行。就算没有分层服装素材，程序也会自动用单图模式运行，聊天、记忆、散步都不受影响。
- **自己画新衣服**：画一张同尺寸的图层放进 `assets/character/` 对应的部位目录，在衣柜配置里加上一行，重启就能穿，不用改任何代码。
- **详细画法与规范**：[`docs/CHULAN-PORTRAIT-REQUIREMENTS.md`](docs/CHULAN-PORTRAIT-REQUIREMENTS.md) · [`docs/ASSET-GENERATION-GUIDE.md`](docs/ASSET-GENERATION-GUIDE.md)

</details>

---

## 文档与版本记录

想深入了解内部设计、记忆原理、零依赖架构或全部 154 个自动化测试套件，可以从 [**docs/README.md**](docs/README.md) 开始翻阅：

| 文档 | 适合谁看 |
| :--- | :--- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 开发者：模块地图、记忆与缓存原理、换装结构与配置项 |
| [`docs/TEST-INVENTORY.md`](docs/TEST-INVENTORY.md) | 开发者：全部 154 个测试套件清单与验证说明 |
| [`docs/VERSION-HISTORY.md`](docs/VERSION-HISTORY.md) | 关注演进过程的人：每个版本的详细工程记录 |
| [`docs/RELEASE-LEDGER.md`](docs/RELEASE-LEDGER.md) | 需要核对安装包安全性的用户：发布账本与 SHA-256 校验值 |
| [`CHANGELOG.md`](CHANGELOG.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`BRANDING.md`](BRANDING.md) | 变更日志、社区参与方式与名称使用说明 |

### 近期更新

| 版本 | 日期 | 做了什么 |
| :--- | :--- | :--- |
| **v2.2.2** | 2026-11-27 | 落地共激活记忆图谱与认知觅食、能动性表型审计与双尺度历时看板、本地 SLM 离线轻陪伴及互惠关系锚定 |
| **v2.1.2** | 2026-11-27 | 拆分四大核心大文件为 16 个清晰模块，完成全仓安全、稳定性与性能加固 |
| **v2.1.1** | 2026-11-26 | 完成二轮全仓深度审计修复，加固归档一致性、密钥安全与渲染边界 |
| **v2.1.0** | 2026-11-26 | 升级生命动力学（相处节奏感知、认知过载保护、轻量认知张力与回忆再巩固观测） |
| **v2.0.0** | 2026-11-21 | 重构 Agent 决策与桌面沙盒读写、便签渐褪与只读未完事项面板 |

<details>
<summary>展开更早的版本记录（v0.3 ~ v1.9.0）</summary>

| 版本 | 日期 | 一句话 |
| --- | --- | --- |
| **v1.9.0** | 2026-11-12 | D-27 独立拟稿与待决队列、观察档三档与动作史投影、Agent 审计与安全收口 |
| **v1.8.0** | 2026-10-28 | 语音输入、个体观测面板、重逢心境、屏幕局部视觉探针 |
| v1.6.1 | 2026-10-19 | 主动搭话调度自愈，对话失败不再静默 |
| v1.6.0 | 2026-10-18 | 公开发布剥离器，模型接口容灾自动回落 |
| v1.1.1 | 2026-10-13 | 专属暗号提示词契约，词典窗口偏移修正 |
| v1.1.0 | 2026-10-13 | 24 小时潮汐仿真，连接防护收口 |
| v1.0.0 | 2026-10-09 | 64×80 像素正典立绘、打包体系与 Agent 安全基座 |
| v0.9.9 | 2026-10-08 | 意志层、词汇表、预期账本 |
| v0.9.8 | 2026-10-06 | 多 Provider 适配与安全边界收口 |
| v0.9.7 | 2026-10-05 | 梦境、遗忘与发育景观（生命动力学第一迭代） |
| v0.9.6 | 2026-10-04 | 数字生命实验基线强化 |
| v0.9.0 ~ v0.9.5 | 2026-10-01 起 | 实验底座、证据链、观测与复盘工具链 |
| v0.3 ~ v0.8 | 2026-09 起 | 缓存改造、换装、主动搭话、状态机 |

</details>

---

## English

> **Life** is a quiet desktop digital-being project featuring **Chulan (初澜)** — a tiny 64×80 pixel figure who lives at the edge of your Windows screen and grows slowly through the time she spends with you.

She arrives with no pre-written backstory and no scripted personality. Instead of acting like a productivity bot, she simply keeps you company:

- **Memories that fade, never erased**: Conversations settle into long-term stretches that gradually fade from her active view, while the original log stays untouched on your computer. The right word — or a quiet moment — can bring an old memory back.
- **Rest, dreams, and bedside notes**: She has no forced 24-hour bedtime; she rests when worn out. Messages you send while she sleeps wait by her pillow until she wakes, and heavy days or long rests can stir fragments into dreams.
- **Small habits of her own**: Phrases you share end up in her notebook, unanswered questions linger until a quiet moment, and after long silences she may leave a short note in a dedicated folder on your desktop.
- **Honest expectations**: Text bubbles only (no voice/TTS, no Live2D), bring your own DeepSeek or OpenAI-compatible API key (optimised for prompt-cache savings), unsigned Windows x64 builds only, and no alarms or calendar reminders.
- **Quick start**: Download `Life-2.2.2-win-x64-portable.exe` from [Releases](https://github.com/andabaoyue/Life/releases/latest), double-click to run, then right-click → Settings → paste your API key. For source builds, run `npm install && npm start` with Node.js 20+ (zero runtime npm dependencies).
- **Docs & License**: Browse [`docs/README.md`](docs/README.md) for architecture, test inventory, and pixel-art specs. Released under the [PolyForm Noncommercial License 1.0.0](LICENSE) (free for personal study, research, and non-commercial modification; commercial use requires written authorization). See [`BRANDING.md`](BRANDING.md) for naming guidelines.

---

## 一起参与 & 许可证

如果你对数字生命实验、桌面陪伴交互或 64×80 像素画感兴趣，欢迎一起来玩，参与方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)（提交代码前请在根目录跑通 `npm test`）。

Life 采用 [**PolyForm Noncommercial License 1.0.0**](LICENSE)（非商业源码可用许可）：

- **你可以**：用于个人学习、学术研究、教学展示、非商业实验与个人二次修改；如果分发你修改过的版本，请在醒目位置注明「这是修改版」并沿用本许可。
- **不可以**：未经书面授权用于任何商业用途（包括打包售卖、作为付费服务或 SaaS 运营、改名后商业再发行等）。如有商业合作意向，请通过 Issue 或 GitHub [@andabaoyue](https://github.com/andabaoyue) 联系。
- **名称说明**：关于项目名与角色名的使用边界见 [`BRANDING.md`](BRANDING.md)（未注册商标，不授予商标许可）。

<div align="center">
  <sub>Copyright (c) 2026 andabaoyue. All rights reserved.</sub>
</div>
