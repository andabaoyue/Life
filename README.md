# Life · 初澜 (Chulan) v0.9.7

Life 数字生命实验平台：初澜（Chulan）是其中的数字生命主体；接 DeepSeek（OpenAI 兼容接口），有长期记忆、自我成长账本、逐字回话和分层换装。

## 运行

```bash
npm install
npm start
```

首次启动右键 → 设置 / 用量，填入 DeepSeek API Key 即可对话。
也可以设环境变量 `DEEPSEEK_API_KEY`。环境变量只在当前进程使用，不会自动写入磁盘。
也可以改配置文件：

- Windows: `%APPDATA%\Life\life-config.json`（兼容历史旧路径 `%APPDATA%\deskpet\gpt-girl-config.json` 自动迁移）

配置存在 userData 目录而不是项目里，避免打包 exe 时把 key 一起带出去。

**Key 不写在这个文件里。** v0.6 起它走 Electron `safeStorage`（Windows 上是 DPAPI，
绑定当前登录用户），密文落在同目录的 `life-key`（兼容历史 `gpt-girl-key` 自动迁移）；`life-config.json` 只剩非敏感配置。
本机其它进程直接 cat 配置文件、或者你把 AppData 备份到网盘，都不会再连带漏出 Key。
不支持加密的环境（缺 secret service 的 Linux）会自动退回明文，并在设置面板里
**如实显示**「本机不支持加密，Key 仍是明文存储」——不会谎称已加密。
诚实的边界：这挡的是「文件被读走/备份泄露」，挡不住能调用 Electron API 的运行中进程。

所有会被用户当成长期资产的 JSON（记忆、衣柜、统计、配置、密文）都是**原子写**：
写临时文件 + fsync + rename。以前是 `writeFileSync` 直接覆盖，写到一半断电
就会留下半截 JSON，下次启动 load() 静默走进 catch，症状是「记忆全没了」但没人知道为什么。

## 用法

- 拖动：左键按住移动
- 右键：对话 / 记录 / 设置 / 固定 / 描边 / 放大 / 缩小 / 退出
- 输入框内 Enter 发送，Esc 收起
- 设置面板里有「衣柜」：点预设整套切换，或按槽位单件换、脱下；也可以直接在对话里说「换成哥特那套」
- 戳她几下、拖她一下，她**真的知道**（见「本地活动与主动搭话」）；说「晚安」之后她不会再自己开口，直到你把她叫醒
- 从一个表情换到另一个表情有衔接（一下微动 + 明暗渐变），不再是硬切；见「状态机 → 表情之间切换的衔接」
- 设置面板可以载入或关闭「创作 Skill」（DS Skill）。载入后才会使用 `skills/DS Skill.md`，关闭后回到日常聊天。
- 无气泡、无输入、无聊天、未拖拽且未睡眠时，主进程会让桌宠在屏幕工作区底部缓慢闲逛；到左右边缘会短暂停留并表现为贴边悬挂。
- 用户拖拽、打开输入框、聊天请求、气泡、记录/设置面板或睡眠状态都会立即停止自主运动。运动状态会进入真实环境感知块。
- 设置面板中的「清空记忆」只清除用户长期记忆；「重置成长档案」会二次确认，并让初澜以新的出生点重新开始。两者不会再混为一个动作。
- v0.9.1 只预留 Agent 能力、权限、行动提案和审计接口，默认拒绝，不连接 Codex、Shell、PowerShell 或全盘文件访问。

## 目录

```
main.js        主进程：窗口、IPC、衣柜实例
preload.js     桥接（暴露为 window.deskpet）
index.html     界面
style.css      样式与动画
pet.js         交互逻辑
src/config.js    配置读写（落盘不含明文 key；按目录缓存、每次真读盘，手改即生效）
src/secure.js    Key 的加密存储边界：safeStorage 可用则密文，不可用如实降级
src/atomic.js    原子写：临时文件 + fsync + rename，避免半截 JSON（含 Windows 瞬态重试）
src/layout.js    窗口几何：常量宽高比 + 下边缘锚点（纯函数，node 侧可测）
src/desktop-motion.js  桌面运动状态机：底部漫步、贴边悬挂、可注入障碍物攀爬
src/deepseek.js  API 客户端（流式 + 峰谷计价）
src/memory.js    三层用户记忆：对话窗口 / 窗口小结 / 长期记忆
src/self-ledger.js 版本化生命档案 + provenance + Current Self 投影
src/experiences-archive.js experiences.jsonl 原始实验底座（Append-Only、容错与诊断读取）
src/subject-state.js     主体状态五维模型、Provenance 强验证、确定性 Reducer 与离线 Replay v2
src/experience-schema.js 经验与事实三层分离规范：Event / Observation / Interpretation
src/state-change.js      状态跃迁记录与因果解释强核验（StateChange）
src/canalization.js  沃丁顿发育景观与经历依赖塑性衰减模型（Waddington Canalization）
src/memory-dynamics.js 零 API 成本记忆动力学与突触修剪（艾宾浩斯幂律、三级状态流转）
src/dream-system.js  成本门禁式弗洛伊德梦境系统（本地认知张力门禁、两道防线、DREAM_GENERATED_ARTIFACT）
src/internal-regulation.js 内部状态调节中枢（短时调节与长期特质双轨分离、严格事件驱动、唤醒度与门限反向耦合）
src/attention-gate.js      注意力闸门与感知分流（显著性与认知负荷过滤、ATTENDED≠SUBJECT_ACQUIRED 铁律防线）
research/ENGINEERING-DECISION-LOG.md 工程与实验架构不可逆决策账本（D-001~D-008）
research/LIFECYCLE-WIRING-AUDIT.md 生命周期运行链审计与因果图谱报告
src/agent-interfaces.js Agent 预留接口：能力、权限、提案、审计和 Mock
src/provider-policy.js Provider / Endpoint / Credential 边界策略
src/persona.js   人设（只写身份，不写穿着细节；不含旧耳坠设定）
src/wardrobe.js  换装数据层：槽位、衣柜、预设、校验、持久化
src/tracker.js   本地活动：被戳/被拖的真实计数（双轨 + 水位线）、晚安与唤醒
src/trigger.js   主动搭话判据：该不该开口（纯函数，只出提案不改状态）
src/brain.js     调度：对话、关窗、记忆合并、换装提案执行、缓存统计
src/creative-skill.js  创作模式适配：优先加载独立 DS Skill，缺失时使用内置降级文本
src/animation-state.js 程序化自然动画：物理微动与姿态状态机
src/render-adapter.js  动画渲染适配器：解耦状态输出与 DOM / CSS 图层接管
src/animation-controller.js 动画控制器：60fps 驱动器与图层微动矩阵
src/behavior-scheduler.js 自主行为调度器：呼吸、眨眼、打哈欠、伸懒腰
src/asset-check.js     启动立绘与换装资产完整性分级检查
src/deferred-writer.js 脏标记与延迟合并写盘
src/migration.js       数据版本迁移框架
skills/DS Skill.md     用户提供的成人向虚构小说创作规范（DS Skill）
assets/pet.png        透明立绘（衣柜不可用时的兜底皮套，1015×1171）
assets/character/     分层换装资源（见「换装系统」）
tools/chroma.py  绿幕抠图脚本
tools/check.js   全量语法检查脚本
tools/release-check.js 发布包资源完整性自动化检查脚本
tools/replay-check.js  Replay 离线推演一致性核验工具
test/            测试
```

## 桌面漫步与攀爬边界

窗口位移由主进程每约 50ms 使用 `BrowserWindow.setPosition()` 驱动，底边锚定在主显示器工作区下沿上方的安全边距内。渲染进程只负责表现 `walking`、`wall_hanging` 和 `icon_climbing` 姿态，不通过 CSS 把人物移出透明窗口，因此不会被窗口边界裁成半截。

底部漫步和贴边悬挂是 v0.8.4 的可用功能。桌面图标的真实位置并没有跨 Windows/macOS 的通用 Electron API，不能假装已经自动读取系统图标；`desktop-motion.js` 已提供经过校验的障碍物注入接口，后续可接 Windows Shell、macOS Accessibility 或用户提供的图标扫描器。没有障碍物 provider 时，程序安全降级为底部漫步与贴边悬挂。

配置文件可以控制：

| 字段 | 默认值 | 作用 |
| --- | ---: | --- |
| `motionEnabled` | `true` | 是否启用自主运动 |
| `motionSpeed` | `2` | 每 tick 的窗口位移像素 |
| `motionTickMs` | `50` | 主进程运动 tick 间隔，范围 30–250ms |
| `motionMargin` | `20` | 工作区底部安全边距 |

## 创作 Skill（DS Skill）的放置方式

`skills/DS Skill.md` 是独立的模式规范（统一称为 `DS Skill`），不放进 `persona.js`，也不放进运行时记忆文件。这样可以保证初澜平时不会被成人向小说规则影响，长期记忆也不会把创作规则当成用户事实。

设置面板中的「载入创作 Skill」会把这份文件作为 system 提示词的一部分注入。关闭创作模式后，下一次请求只使用普通 persona 和已有记忆。这个切换会改变 system 前缀，因此可能造成一次缓存未命中，这是预期代价。

创作模式只负责写作规则，不会自动生成章节。开始创作时仍建议在消息中说明世界观、人物年龄、题材、分级、文风、视角、章节和字数目标。

## 记忆：轮数窗口 + 分层压缩

四层结构与实验底座解耦，全部为缓存与可计算主体服务：

```
history                 当前窗口的原始对话（程序签发 messageId、windowNo、roundNo、bridge 状态）
windows                 每个已关闭窗口的一条小结（Prompt Memory 预算 ≤ 6000 tokens）
system                  = 人设 + 用户长期小结 + 当前穿着块（静态稳定前缀）
Current Self            原始生命档案的有限投影，只附加在最新 user 消息尾部
Subject State           本地 subject-state.json，[-999, 999] 确定性状态向量，窗口冻结快照只附加在 user 尾部
Raw Experience Archive  本地 experiences.jsonl，Append-Only 原始实验底座，永不被 Token 预算或 maxEntries 裁剪
```

- 每 `windowTurns`（默认 100）轮关一次窗口：执行「5×20 分段 + 窗口综合（Window Synthesis）」结构化归档，
  严格区分「用户给予」与「初澜经历」双通道，提取 Provenance 强核验的状态证据，由确定性 Reducer 计算状态增量。
- 关窗时旧原文安全归档，保留最近 `keepTailMessages`（6）条并标记为 `bridge: true`，作为下一窗口的缓存桥接，不计入下一窗口轮数，也不被重复总结。
- 初澜首次初始化时创建固定 `birthAt`，只代表程序意义上的出生时刻，不伪造出生以前的人生。
- Current Self 默认预算约 3000 token；它只表达出生以后形成的有限当前解释，并保留支持/反向证据。
- `self-ledger.json` 采用版本 2，包含 `birthAt`、`sourceType`、窗口号、消息 ID、证据摘录和置信度。
- 小结总长超过 `memoryCapTokens`（6000）时，把较旧的几条合并成一条
  【早期】记忆 —— 这一步刻意搭在关窗的同一刻做，反正 system 已经要变，
  一起变只破一次缓存，分两次做就破两次。
- `windowMaxTokens`（8000）只是兜底：单窗口 token 超了会提前关窗，
  正常聊天基本触发不到，V4.1 Flash 上下文 1M 完全够。

**一个窗口内 system 一个字都不变**，所以 100 轮里除了第 100 轮那次关窗，
其余请求前缀严格只递增 —— 这就是命中率的来源。
V4.1 Flash 上下文上限 1M token，6000~8000 的设置完全没压力，
真正影响成本的是每次请求的重复计费，所以窗口越大命中率越高、但单次未命中也越贵。

## 缓存命中率怎么保证的

DeepSeek 前缀缓存要求历史「只追加、不修改、不重排、不裁剪」，逐字匹配。
这套代码为此做了三件事：

1. **小结放进 system 头部**，不单独插一条消息 —— 单独插会夹在历史中间，
   它一变后面全部前缀断裂。
2. **回答完再关窗**，不是关完窗再回答 —— 否则本轮白白未命中。
3. **时间戳绝不写进 system** —— 那样每次请求前缀都不同，命中率归零。
   需要动态信息时作为最后一条 user 消息附加。

破缓存次数 = 窗口数，可控。`test/brain.test.js` 里实测：
窗口内严格前缀递增、system 逐字不变、合并不多破一次、
重启后 system 完全一致、小结/合并调用不污染主线命中率统计。

> 测试项数只在文末「测试」一节写一次。别在正文里重复数字 —— 每加一条断言
> 就要改好几处，迟早对不上（v0.5 就被抓到过正文写死的项数落后于实际）。

## 角色基准（改动前先读这节）

- 外观基准是**换装设定图**（v0.5 起）：成年比例、银白微卷长发、发尾仅非常淡的冰蓝、
  蓝灰大眼、单侧泪痣、**头发右侧黑色蝴蝶结**；当前不含字母耳坠、项圈或钥匙吊坠。
  初澜的核心身份包括名字、脸型、发色、眼睛和泪痣；衣物与发饰是可变外饰，由衣柜真实状态决定。
- 当前单图兜底皮套仍需由用户按 `ASSET-GENERATION-GUIDE.md` 生成并放入资源目录（源码 Markdown 不包含 PNG 二进制）。
- 人格：温柔、安静、慵懒、微黏人、偶尔吐槽；短回复；称「你」；无客服腔。
- 能力诚实：没实现的功能一律说做不到，绝不假装操作过电脑。这条写在 persona 边界里，也是代码审查项。

## 换装系统（v0.5，第一阶段＝架构）

三条铁律写在 `src/wardrobe.js` 头部注释里，UI 和 AI 都绕不过去：

1. **服装只是外观，不碰人格** —— wardrobe 不 import persona，也没有任何
   「按服装改语气」的钩子；测试用正则扫源码，一旦有人往衣服和性格之间接线就红。
2. **语言状态 ≠ 程序状态** —— 模型只能提交 `[wear:itemId]` 提案，真正穿上衣服的是
   `wardrobe.applyProposal()` 这次调用。一条回复里连发多个提案是合法的，按正文顺序
   逐条执行、逐条回报。成功/失败都生成 `[系统] 换装执行结果：…`
   写回历史，下一轮模型看到的是事实；幻觉 id 不剥离也不执行，它没法谎称换好了。
3. **本体不可换装，外饰可以更换** —— `hair` 仍带 `required:true`，但
   `hairAccessory` 是可拆卸槽位。发型可以换款式但不能脱空；发饰可以用
   `[wear:off_hairAccessory]` 摘下，也可以换成其他发饰。以前是从商品条目的 `locked` 反推的，两种失效方向都试过：
   给发型槽加第二款忘了标 → 反推成「非身份」，能脱光；给普通槽唯一一条商品标上 →
   反推成「身份」，那件脱不掉。所以现在只留一个出处，商品上没有 `locked`。

数据与渲染：

- 9 个槽位：`hair / hairAccessory / top / bottom / dress / socks / shoes / outerwear / accessory`，
  叠放顺序 z 只在 `SLOTS` 一处定义，渲染层照 `layers()` 贴 `<img>`，CSS 里不写服装逻辑。
- `dress` 与 `top/bottom` 互斥；校验只看**最终状态**（`validate(equip)`），不校验中间步骤 ——
  早期逐槽校验会让「休闲套→哥特套」这种整体切换永远卡死。
- 预设只是「一组槽位值的命名」，没列出的槽位沿用当前装备；自由组合后 `preset=null`。
- 加新衣服＝往 `CATALOG` 加一条数据（必要时加预设），不动任何渲染或交互代码。
- 持久化 `userData/wardrobe.json`；脏文件（坏 JSON / 未知 id / 非法组合）一律安全回退默认，
  显式 `null`（真的脱了）必须原样读回，否则重启会"复活"衣服。
- 资源目录 `assets/character/`：`base/`（不可换装的身体与脸）+ 每槽一个子目录，
  文件名与 CATALOG 的 `file` 字段一致；**所有图层共用 760×1000 画布锚点**，等比叠加即对齐。
  当前是占位图，架构与测试按真图标准跑通。
- 降级：任何一张图层缺失 → 整套回退单图兜底皮套，桌宠绝不会变空白。
- 缓存：system **最末尾**挂【当前穿着】+【衣柜可用 itemId】两块，只在**真的换装那一刻**变化；
  平时逐字节稳定，不吃命中率。换装那次破缓存是诚实的代价——不然她只能凭想象回答自己穿了什么。
  这两块约 386 tok（估算已计入面板的「上下文」数字），衣柜越大越贵，但只贵一次前缀。
  顺序是硬要求：长期记忆必须在穿着块**之前**。前缀缓存从头开始比，谁在前面决定了
  换一次衣服要赔多少 —— 穿着块排在记忆里，换装就会把全部长期记忆和历史一起顶出缓存。
  这条由 `test/brain.test.js` 逐字钉住（v0.7.1 之前代码排反了，而注释和本文都写的"末尾"）。

面板：设置面板「衣柜」区，预设按钮 + 每槽单品 + 「脱下」（身份槽不提供）。
全部 textContent 渲染；被拒的搭配如实弹「这件穿不上：原因」，状态一字不动。

## 状态机（文字与表现分离）

模型在每条回复末尾附 `[state:xx]`（idle/happy/curious/thinking/sleepy/embarrassed/annoyed/sad）：

- `brain.js parseState()` 剥离标记，未知/缺失一律降级 idle；标记不进历史，不污染缓存前缀
- 渲染层把状态挂到 `body[data-state]`，CSS 按属性播动画；表情帧立绘后续补，缺动画只是不动，不会崩
- 单次动作（happy/annoyed）在 CSS 里把 breathe 串在动画列表尾部，气泡收起/报错时状态回落 idle —— 否则动画播完桌宠会定格不再呼吸

### 表情之间切换的衔接（v0.8.1）

「从一个表情到另一个表情没有过渡」是真问题，但根因有三条，各自不同，不能用一招盖掉：

1. **明暗/饱和度是硬切。** `#figure` 写了 `transition` 却没给时长，
   `transition-duration` 实测 `0s` —— 写了等于没写。补 `transition: filter .2s` 之后
   才真有中间值（实测 idle→sad 采样从 1 种变 6 种）。
   刻意**只**加在 filter 上：transform 全程由 animation 接管，给它加 transition 会跟关键帧抢属性。
2. **眨眼会把状态动画整个顶掉。** `animation-name` 是覆盖属性，blink 原来挂 `#figure`，
   那一瞬 `tilt`/`sway` 被 `blink` 抢走，180ms 后动画从 0% 重播，倾角被硬拉回 0
   —— 实测好奇状态下跳 **2.23°**，比表情切换本身还突兀。现在 blink 与切换微动都挂
   `#sprite` / `#layers`（立绘内容），父容器摆姿态、子元素眨眼睛，两个 transform 相乘叠加。
   实测给 `#layers` 加 transform 不改变 `#figure` 的几何，所以不会连带影响气泡高度。
3. **切换那一帧姿态会跳。** 上一个动画跑到峰值时切走，会被硬拉到新动画的 0%：
   实测 tilt 峰值切 idle 跳 **3.0°**，bounce 顶点切 curious 纵向跳 **9.97px**。
   CSS 层面修不掉（两个 animation 的输出没法 transition），差分表情图也没有素材，
   所以 `setState()` 上屏那一刻加一次 `.18s` 遮掩微动（与眨眼同级），不是换图片。

`setState()` 的三条不变式（都有对应断言）：

- **"上一次是什么"只有一处出处** —— 直接读 `body[data-state]`，不另存 `lastState`。
  两处记同一个事实迟早各说各话（测试里就有绕过 `setState` 直接改属性的地方）。
- **同一个值重复 setState 不触发微动**：`hideBubble()` 和 `finish()` 都会调
  `setState('idle')`，守住这条才不会"每收一次气泡她抖一下"。
- **启动那一帧就得是 idle**：否则第一次 `setState('idle')` 会被当成切换，她一上屏
  莫名其妙压扁一下。

> 没有做差分表情图切换：那个目录下的图片**素材**不存在（实测按状态拼出的路径返回 404），
> 不是代码没写。按身份铁律，脸是身份不是服饰，真要做也得先有
> 正典图并确认它不随换装漂移，不能凭空 `display:none` 一个不存在的层。
- 剥离正则容忍冒号后空格与句末标点（`[state:happy]。`）；未知状态词不剥离正文，宁可留标记也不丢回复
- 流式期间前端实时剪掉尾部标记：完整标记（含空格/句末标点尾巴）+ 未闭合的半截 `[`。
  半截**只可能是 state/wear 前缀才藏**：判据是"它还有没有可能长成一条后端会剥掉的标记"，
  wear 用衣柜真实 itemId 集合比前缀 —— 所以 `[state:aw`、陌生 id 这类长不成合法标记的
  不藏（藏了就是吞正文，且后端不会剥它，屏幕上没有、历史里有，两边剥的就不是同一批）。
  `[idle]`、`[1,2,3]` 等正文不受误伤。
  剥完整标记与藏半截要**整体迭代**：把末尾半截藏掉后露出的新尾巴可能又是一条完整标记，
  单轮写法会让它重新露出来（`[wear:xxx][s` 实测泄漏 11 帧，v0.7.1 修）。
  **藏半截只在还在吐字时做**（`stripState(t, partial)`，默认跟 `streaming`）：流一停，
  半截标记再也长不成合法标记，后端也不剥它，这时候继续藏就违反上一条"两边剥同一批"。
  逐帧判据在 `test/ui_test.py`：吐字期间任何一帧屏上都不许出现 `[wear` / `[state`；
  收尾那一帧反过来要求半截标记**照原样显示**。
- 预览分支与真实分支同构收尾：回落 idle、气泡 6 秒自动收起；submit() 入口掐掉上一句遗留定时器
- `[wear:id]` 与 `[state:xx]` 可连发多条、顺序不定，前后端都**循环剥到不动为止**，
  且共享同一批合法 id（前端从衣柜 catalog 拿）——两边剥的必须是同一批，
  否则屏幕上的文本和写进历史的文本会一个有一个没有

## 记忆规则（v0.4 起）

小结提示词按「正确第一」：只存用户明确说出的事实；纠正必须覆盖旧值；去重；
寒暄与一次性情绪不入长期记忆；称呼/偏好/项目/约定/用户点名要记的必须保。

记忆可见可管理：设置面板「我的记忆」列出全部片段（textContent 渲染防注入），
每条可单独「忘掉」——真删文件落盘，不是回答里假装忘记。

## 本地活动与主动搭话（v0.8）

她原本看不到自己的物理处境：戳 20 下再问"我刚才戳了几下"，她只能猜 —— 而 persona
有一条硬边界「绝不假装做过任何事」，**猜就是编造**。所以这一节的重点不是"会主动说话"，
而是"说出口的每件事都有出处"。

**双轨数据（`src/tracker.js`）**。「连戳检测」只要 8 秒内的，必须快速老化；
「如实汇报」要求发生过就必须说得出，一条没消费完都不能丢。这两个需求天生冲突，
混在一个数组里，老化会吞掉待汇报的事件（你 1 分钟前戳的 3 下她永远不知道）。
所以分成 `clickTimes`（15 秒 TTL，只服务窗口判定）和 `events`（按水位线消费）。

**水位线增量消费。** `snapshot()` 报"上次汇报之后发生了什么"并返回 `throughSeq`，
只有请求真的走完才 `commit(throughSeq)`。失败/被打断时不提交，那些事件下次如实补上 ——
因此 tracker **刻意没有 `rollback()`**：没 commit 就等于没消费，写一个空 rollback
只会让人以为它有语义。攒到 200 条截回 150 条时，被挤掉的可能是没报过的，
那时环境块会改口成"被戳**至少** N 次"：宁可给下限，也不报一个假装精确的错数。

**环境块只进 user 消息。** 里面有分钟级时效数据，塞进 `system` 等于每轮破一次前缀缓存
（和 v0.7.0 那次穿着块顺序是同一个物理量）。它只拼在当轮新追加的那条 user 消息末尾，
历史是只追加的，前面所有字节照旧命中。`test/brain.test.js` 钉着这条：
两轮请求的 system 必须逐字相同、且后一次是前一次的严格前缀。

**晚安与唤醒。** `isSleepIntent` 带疑问语气的一律不算（"你困了吗"不能把她按睡着），
`enterSleepMode` 幂等（连说三遍晚安不能让她永远是"刚睡着"），唤醒标记 10 分钟自动过期。

**该不该说 / 能不能说 分开判。** 主进程看得见事实（静默多久、连戳几下、睡没睡），
渲染端看得见礼貌（在不在打字、气泡开着没、上一条说完没）—— 按"谁知道什么"切。
45 秒一个滴答问一次 `proactive-check`，被戳满 5 下再插队问一次。

`evaluate()` 只出**提案**、不改状态，真的说出口才 `commit()`。这个分开不是洁癖：
如果 evaluate 顺手把冷却和挂机刹车划掉，"主进程想让她说话、渲染端因为你在打字而拒了"
这一趟就白烧一次冷却，挂机那条更糟 —— `spokenDuringIdle` 被置位、可她一个字都没说，
这句问候永远补不回来。

**提案走一圈回来，主进程不存 `pendingOffer`。** 陈旧提案会拿着上一次的 `at` 去记冷却；
现在过期或伪造（`kind` 不认识、`at` 不是数字）一律 `{ok:false, declined:true}`，
而渲染端遇 `declined` 时连那条空的「初澜：」记录节点都摘掉 —— 这一轮真的当没发生过。

**主动搭话作为 synthetic 消息落入 history 保卫前缀缓存，但严格排除于主体经历证据之外。** 触发理由是程序生成的瞬时感知，不是用户原话。为了在下一轮完整复用「主动触发 + 模型回复」的 DeepSeek 前缀缓存块，主动搭话以 `{ synthetic: true, source: 'proactive' }` 写入 history；但在关窗小结与主体经历归档中，`isEligibleSubjectEvent()` 与 `cleanContentForSummary()` 会将其明确标记或剥离，严防程序提示伪装为用户发言或主体经历证据。

两处按语义写的判据值得记一下：`poke` **豁免**"刚互动过 90 秒内保持安静"这条闸门 ——
被戳本身就是"现在方便"的意思，第一版拿它挡连戳，把 poke 这条路整个饿死了；
拖拽收尾只报真有过位移的（`moved > 6`）才算"被拖了一下"，纯失焦收尾不算，
否则窗口一失焦就给她凭空记一笔。

浏览器预览模式（没接 key、没有 bridge）退回原来的本地随机文案：45 秒滴答 + 25% 概率
+ 不重复上一条，一条请求都不发。用户正在打字 / 上一条气泡还没收时两种模式都静默。

## 配置项

`src/config.js` 的 DEFAULTS，可被 userData 里的 `life-config.json` 覆盖：

```
model             deepseek-flash     ← 官方 API 模型名，不是 deepseek-v4.1-flash
windowTurns       100                每 100 轮关窗并小结
windowMaxTokens   8000               token 兜底
keepTailMessages  6                  关窗保留的原文条数
memoryCapTokens   6000               长期记忆预算，超了合并
price.*           峰谷单价（元/百万 token），按账单实际数字改
```

改完**不用重启**：`config.load()` 每次真的读盘（v0.7 起），每轮对话开始时
`Brain` 会重新取一次配置并**就地**更新（`Object.assign`，不换对象引用，
所以主进程的 `cfg`、DeepSeek 客户端、`Memory` 的窗口参数看到的是同一份）。
`price.*`、`model`、`baseURL`、`windowTurns` 这些下一句话就生效，
设置/用量面板的数字也不会再是启动时的旧值。

唯一不参与就地热重载的是 **API Key**：盘上那份按设计不含明文 key（除非降级），
key 是启动时经 `secure.js` 解出来的，热覆盖会把内存里的 key 抹空 ——
改 key 请走设置面板 `config-set-key` 事务流程。
主进程在切换 API Key 时执行候选 Brain 生命周期保护：先保留旧 Brain 处理当前任务，
待新 Brain 成功建立且配置完成双写持久化后，才切换并销毁旧 Brain；若新 Key 或候选 Brain 报错，
立即执行两阶段事务回滚并恢复旧配置，旧 Brain 继续存活，避免服务处于无 Brain 僵死状态。

配置热更新的覆盖范围：
- **热更新覆盖**：`price.*`、`model`、`baseURL`、`windowTurns`、`windowMaxTokens`、`keepTailMessages`、`memoryCapTokens`、`selfGrowthEnabled`、`selfLedgerMaxEntries`、`currentSelfTokenBudget`、`writingMode`、`requestTimeoutMs`、`streamIdleTimeoutMs` 等均在每轮对话或面板读取时就地生效。
- **重构重建覆盖**：API Key 变更走独立生命周期与事务回滚流程。

热重载的挂点有两个：**每轮对话开头**（`Brain.refreshConfig()`）和
**打开设置/用量面板时**（`config-get`、`chat-report`）。只有前者会出现一种
很难解释的现象：改完 model 或价格，不发消息、直接开面板，看到的还是旧值，
像是热重载根本没生效。

`price` 的合并只到「哪一档」这一层：写了 `peak` 就整份换掉 `peak`，
所以一档里 `hit/miss/out` 三个字段要写全，漏掉的那个会按 0 计（少算钱）。

## 测试

```bash
node test/brain.test.js          # 164 项：窗口边界、前缀不变式、合并、回滚、重启、统计隔离、换装提案端到端（含连发多条）、配置热重载、SSE 粘包与收尾、穿着块顺序不变式、环境块不进 system、主动搭话不落 history、遥测水位线失败不消费、生产级 Self-Ledger 配置与瞬时上下文生命周期、10 轮无污染回归、5x20 窗口归档、Provenance 强核验与 State Reducer
node test/memory.test.js         # 30 项：Memory 模块初始化、append 与 synthetic 轮数计算、build 瞬时上下文动态挂载、historyTokens 纯洁性、rollback、cleanContentForSummary、窗口快照与小结归档、Bridge 与 Active Window 隔离
node test/experiences-archive.test.js # 12 项：experiences.jsonl 原始实验底座、Append-Only 永久保存、5x20 与 Synthesis 完整归档、多窗口检索
node test/subject-state.test.js  # 19 项：subject-state.json、[-999, 999] 极值与边界截断、Provenance 强验证、确定性 Reducer 增量计算、离线 Replay 演化轨迹重放
node test/main.test.js           # 78 项：主进程 IPC 面（衣柜推送一致、缩放与下边缘、blur 兜底、wears 契约、配置面板读盘、apiKey 不被盘上值覆盖、activity 上报进同一个 tracker、过期/伪造提案 declined 且不烧冷却、候选 Brain 切换与失败回滚）
node test/tracker.test.js        # 42 项：双轨解耦（出了 8 秒窗口仍要如实汇报）、水位线消费、软顶改口"至少"、睡眠幂等与唤醒 TTL、晚安判据两个方向、环境块不含未实现的能力
node test/trigger.test.js        # 36 项：连戳阈值边界、8 秒窗口、evaluate 不改状态（被拒不记冷却/不拉挂机刹车）、冷却边界、单次刹车、睡着不自言自语、注入时钟
node test/wardrobe.test.js       # 55 项：槽位/资源存在、互斥、核心发型锁、可拆卸发饰、非法输入、持久化、脏文件降级、删除项圈后的旧存档迁移、人格隔离
node test/secure.test.js         # 38 项：Key 密文落盘、明文不残留、降级不丢 Key、坏密文不删明文、旧版明文迁移、裸 save 不漏 key、跨文件事务保存与回滚
node test/atomic.test.js         # 20 项：临时文件不留残、写失败后旧内容还在、Windows 瞬态 EPERM 重试、非瞬态错误原样抛出
node test/config.test.js         # 28 项：目录隔离、热重载、price 合并层级、坏 JSON 降级、瞬时读失败不冲成出厂值、路径写法归一、Provider Policy 安全边界与凭据隔离
node test/deepseek.test.js       # 32 项：流内 error 帧如实抛出（含半截回复）、报错后主动释放连接、5 种宿主时区下的峰谷判定、节假日/调休表自校验、AbortSignal 全生命周期与双超时隔离、预先abort与headers后abort
node test/layout.test.js         # 16 项：宽高比为常量、来回缩放收得回、下边缘钉住、main.js 不许再用量出来的比例
node test/creative-mode.check.js # 7 项：创作 Skill（DS Skill）加载、成年角色边界、模式配置和超时配置检查
node test/desktop-motion.test.js # 14 项：底部漫步、用户打断、左右贴边悬挂、障碍物攀爬、SUSPENDED 状态与按需自管定时器
node test/deferred-writer.test.js # 8 项：脏标记、防抖延迟合并写盘、同步 flush、写失败保持 dirty、unref 定时器
node test/migration.test.js       # 17 项：通用数据迁移、版本号升序执行、缺少迁移函数报错、版本防回退、自定义版本字段名
node test/self-ledger.test.js   # 31 项：出生点、版本化档案、provenance、Current Self 预算、备份恢复和重置、成长证据事实核验、拒绝清单与Brain.growSelf接线、sourceType与角色语义兼容核验
node test/agent_interfaces.test.js # 6 项：能力白名单、默认 deny、行动提案、审计日志和 Mock 禁止执行
node test/animation-controller.test.js # 30 项：自然动画控制器、60fps 驱动循环、状态转移、多图层独立物理摆动、Poke 动力学与打断机制
node test/behavior-scheduler.test.js   # 23 项：自主行为调度器、呼吸/眨眼/打哈欠/伸懒腰权重分发、打断与状态互斥、确定性覆盖
node test/render-adapter.test.js       # 10 项：DOM 动画渲染适配器、数据驱动单向流动、异常隔离与无头渲染器
node test/experience-schema.test.js # 22 项：Event / Observation / Interpretation 三层分离、合法性校验、复合经历封装与向后兼容转换
node test/state-change.test.js      # 12 项：StateChange 状态跃迁记录、算术一致性校验、因果解释强核验与防篡改
node test/replay.test.js            # 16 项：纯离线确定性 Replay v2、单/多窗口重放、边界截断、100 次幂等无漂移、局部切片与跨版本兼容
node test/recovery.test.js          # 38 项：关窗小结失败对话零丢失、JSONL 坏行跳过与诊断报告、受损状态备份恢复、并发未结对话安全隔离、关窗与恢复 Exactly-Once 幂等防重、四场景故障注入（Case A/B/C/D）
node test/r1-scenarios.test.js      # 108 项：v0.9.4-R2 闭环、防重与最终收官验收（A-J 基础场景 + Test A-D 最终一致性 + Test E2-A~E2-D 跨调用/跨重启/跨Replay防重 + P0-05 真实Window聚合 + P0-06 认证/未认证容灾恢复 + P1-01 严格数值解释 + P1-02 Event白名单 + P1-03~P1-04 启动自愈与完整一致性）
node test/research.test.js          # 69 项：v0.9.5 实验观测与可复盘工具链专项测试（Test A 内存偏移索引与自动重建、Test B 异步Replay任务与取消、Test C Fail-Stop确定性熔断、Test D Evidence关系契约与白名单、Test E 快照模式与手动刷新、Test F 纯只读数据SHA-256完整性门禁、Test G 轨迹与研究包导出格式规范、Test H IPC只读白名单与历史版本兼容）
node test/archive-schema.test.js      # 20 项：v0.9.5.1 Archive Record Schema 规范性、通用最小字段集与未知类型强拦截（UNKNOWN_RECORD_TYPE）
node test/research-fabrication.test.js # 19 项：v0.9.5.1 绝对消除事实臆造与占位伪造（RECORDED/NOT_RECORDED/UNRESOLVED 三分态、Bridge/Active 无猜想隔离、无假消息）
node test/event-source-validation.test.js # 20 项：v0.9.5.1 Event Source 正向白名单约束（5 种合法源、大小写容错、第三方拦截与黑名单防御）
node test/replay-cancel.test.js       # 13 项：v0.9.5.1 分块异步推演（CHUNK_SIZE=500）、事件循环协作让出、运行中途即时取消与非阻塞机制
node test/research-integrity.test.js  # 19 项：v0.9.5.1 统一归档完整性服务（CERTIFIED/PARTIAL/UNCERTIFIED/INVALID 判定一致性与遗留适配器隔离）
node test/research-round-inference.test.js # 17 项：v0.9.5.2 彻底禁止 Message ID -> Round 推断（严禁 Math.ceil 解析编号、无元数据保持 UNRESOLVED）
node test/research-stat-defaults.test.js   # 22 项：v0.9.5.2 彻底消除虚假默认统计值（turns=0 保留为 0 严禁 || 100、messageCount 严禁 || 200、如实反映 segments）
node test/legacy-schema-certification.test.js # 14 项：v0.9.5.2 缺失 schemaVersion 规范处理（严禁隐式补写原生 v1、经过 LegacySchemaAdapter 且归档降级 UNCERTIFIED）
node test/archive-event-strictness.test.js # 20 项：v0.9.5.2 Event 来源白名单与完整性防御（缺源拦截、未知源拦截、Synthetic 拦截、Bridge Provenance 核验与坏账防御）
node test/legacy-metadata-fabrication.test.js # 30 项：v0.9.5.2 遗留数据元数据严禁伪造（缺 schemaVersion 禁补原生 v1、缺时间戳禁补 Date.now()、缺 windowNo 禁补 1、缺 roundNo 禁补 1、缺 messageId 禁编 UNKNOWN_MESSAGE、全链路端到端防伪）
node test/research-window-defaults.test.js # 43 项：v0.9.5.2 Window 默认值与 Window 0 边界无损保留（缺 windowNo 保持 null 禁补 1、windowNo=0 严防 0||1 降级、getWindowDetail(0)/getWindowRounds(0) 精确检索、search 与轨迹保留 0/null、全生命周期 0/null 保留测试）
node test/archive-event-runtime-parity.test.js # 17 项：v0.9.5.3 (H-01) Archive 嵌套与独立事件强校验对齐运行时 Validator（类型白名单、源必填、禁止 generated/synthetic、合法认证）
node test/research-index-unknown-window.test.js # 31 项：v0.9.5.3 (H-02) 彻底纠正未知 windowNo 映射（禁止未知记录归入 Window 1、分离 unknownWindowDescriptors、精准支持 Window 0、IPC 通道防御默认 1 降级）
node test/research-ipc-export-security.test.js # 17 项：v0.9.5.3 (H-03) Renderer-exposed research:export 安全隔离（禁止渲染端指定任意路径、主进程 Native Dialog 授权与防路径穿越）
node test/research-integrity-scan-efficiency.test.js # 7 项：v0.9.5.3 (H-04) 消除 O(W×A) 重复全量 Integrity Scan（单次循环前扫描、高频查询命中 mtime/size 快照缓存、变更自动失效）
node test/phase0-experimental-invariants.test.js # 41 项：Phase 0 数字生命实验层核心架构、Schema 契约、基线零干预、内部状态代理、纯函数 Reducer 确定性（100次无漂移与时钟隔离）、数字环周知觉候选界限、证据门禁自传记忆全可信链、睡眠三态分立与零假说门禁
node test/window-boundary.test.js        # 33 项：v0.9.6 严格窗口边界与指标冻结（100轮轮数限制触发、Token溢出提前关窗、快照冻结防御指标漂移、Bridge隔离与Archive持久化）
node test/archive-integrity.test.js       # 37 项：v0.9.6 Archive Canonical Schema v1与哈希链完整性（recordId生成、SHA-256前向哈希链、fsync持久化、损坏拦截与坏账自愈）
node test/summary-schema.test.js          # 16 项：v0.9.6 严格 5x20 小结契约与 Fail-Stop 机制（5个分段结构、20轮覆盖、无遗漏重叠、损坏契约零写入安全拦截）
node test/provenance-boundary.test.js     # 21 项：v0.9.6 证据溯源 12 条自校验规则（窗口归属匹配、合成数据拦截、Bridge消息拦截、角色校验与反向去重）
node test/reducer-symmetry.test.js        # 20 项：v0.9.6 状态转移纯对称整数舍入（symmetricRound 四舍六入五成双、SubjectState与ResearchService纯确定性一致）
node test/self-projection.test.js         # 27 项：v0.9.6 当前自我因果投影（self_projection 记录落盘、因果溯源绑定、experiences与Self-Ledger一致性）
node test/telemetry.test.js               # 17 项：v0.9.6 实验遥测与前缀缓存精准归因（experiment-telemetry.jsonl Append-Only、自增序号、七大缓存破坏类别精准归因）
node test/decision-log.test.js           # 31 项：v0.9.7 实验架构决策账本与不可逆约束（D-001~D-010 十大已决决策、严禁后台连续代谢、严禁人类24h时钟、严禁梦境直写状态、严禁物理删除归档、双轨分离、生产接线、实验元数据与事实核验铁律）
node test/canalization.test.js           # 27 项：v0.9.7 沃丁顿发育景观与经历依赖塑性衰减（可塑性乘子单调衰减、发育阶段划分、基线零干预不变量、StateChange 参数落盘与确定性 Replay）
node test/memory-dynamics.test.js         # 32 项：v0.9.7 零 API 成本记忆动力学与突触修剪（初始强度代数计算、艾宾浩斯幂律衰减、三级状态流转、休眠过滤、冷启动持久化、上下文重新激活、FADING渐褪截断与停用词防误唤醒）
node test/dream-gate.test.js             # 30 项：v0.9.7 成本门禁式梦境系统双重门禁（真实Arousal交互轨迹、新异度门禁、认知冲突判定、窗口间隔与24h频次硬顶、冷启动跨重启防御与纯函数确定性）
node test/dream-synthesis.test.js        # 23 项：v0.9.7 弗洛伊德梦境合成与认识论防线（日间遗留轻量提取、凝缩与移位提示词结构、DREAM_GENERATED_ARTIFACT 隔离、归档写入与完整性服务CERTIFIED认证闭环）
node test/lifecycle-wiring.test.js    # 47 项：Phase 0.5 生产运行时生命动力学闭环收口（Test A~K: 权威内态实例直连 BehaviorScheduler、ActivityTracker 实时事件驱动、Digital Umwelt 环周感知与 Attention Gate 认识论不变量、统一 experimentModules 配置生效、Baseline 隔离守恒、单模块消融因果归因、冷启动经历自愈与离线 Replay、路径依赖标准实验接口、睡眠转移零重计与严格幂等、挂机事件阶梯水位线防重计量、活跃窗口实验快照冻结不变量）
node test/internal-regulation.test.js # 23 项：Phase 0.5 内部状态调节中枢（双轨隔离不进特质白名单、isSubjectAccessible恒为false、严格事件驱动零后台Timer、唤醒度与感官门限反向耦合、入睡/唤醒/关窗排空）
node test/regulation-behavior.test.js  # 16 项：Phase 0.5 内部稳态对自主行为的概率倾斜调度（高疲劳打哈欠放大至2.5x、低体能伸懒腰放大至2.0x、高唤醒张望放大至2.0x、概率柔性非强占抽样与基线一致性）
node test/attention-gate.test.js      # 23 项：Phase 0.5 注意力闸门与感知分流（显著性比对放行与过滤、唤醒度动态耦合、认知过载抑制、ATTENDED≠SUBJECT_ACQUIRED 铁律不变量防御、下游稳态闭环与基线隔离）
node test/path-dependency.test.js     # 20 项：Phase 0.5 路径依赖性与发育轨迹不可交换性（稳态非对易 A->B->C ≠ C->B->A、行为倾向分化、发育景观早期塑性大于晚期、假说证伪压力与历史无损留存、runPathDependencyExperiment 4D分化接口）
node test/experiment-metadata.test.js # 31 项：Phase 2 实验条件元数据与生成产物绑定（Generation Context 契约、Prompt 指纹确定性、历史无伪造、DeepSeek 前缀缓存不变式、校验与安全回退、observedModel与深冻结）
python3 test/ui_test.py          # 152 项：真实交互 + mock 衣柜桥接 + 菜单/气泡不被裁掉 + 半截标记逐帧不外泄 + 收尾半截不被吞 + 图层加载后重算气泡 + 拖拽丢 mouseup 兜底（含 buttons=0 立刻收尾、无位移门槛回归）+ 立绘宽跟随窗口 + activity 上报 + 提案往返与被拒不留痕 + poke 豁免静默闸 + 表情衔接（filter 过渡 / blink 不顶状态动画 / 切换微动 / relayout 不复活气泡）
node test/docs.test.js           # 它负责数上面几个的数字，所以不给它自己标项数
```

跑法：除 `ui_test.py` 外都只依赖 Node；`ui_test.py` 需要根目录下有静态服务器（默认 127.0.0.1:8000，
可用 `DESKPET_URL` 指定），`docs.test.js` 会自己起一个临时服务器并把它要校验的测试全跑一遍，
所以一条 `node test/docs.test.js` 就是整套回归的门禁。

ui_test 用系统 chromium（`/usr/bin/chromium`，可用 `DESKPET_CHROME` 覆盖），
跑两种页面：无 bridge 的浏览器预览模式（验证降级），和注入 mock `window.deskpet` 的模式
（验证分层渲染、z 序、面板交互、换装后状态/图层/记录三者一致）。
Electron 专有部分（移窗、置顶、缩放、退出）不在其中。

## 换立绘 / 出换装图层

完整的生成提示词、目录、命名、透明 PNG、表情差分和新增衣服流程见
[`ASSET-GENERATION-GUIDE.md`](ASSET-GENERATION-GUIDE.md)。

只有换立绘时才需要 Python；运行桌宠本身只要 `npm install && npm start`。

```bash
pip install opencv-contrib-python numpy pillow
```

注意必须是 **opencv-contrib-python**（含 ximgproc）——脚本用到
`cv2.ximgproc.guidedFilter` 做边缘去色污染，装标准版 opencv-python 会抛异常。

1. 生成纯绿幕（#00FF00）立绘，人物边缘不加投影
2. `python3 tools/chroma.py 输入.png assets/pet.png --trim`

脚本自动测背景色并用 Otsu 定阈值。处理了三个坑：细发丝不能被削掉、
发丝缝隙的背景不能被填成前景、黄绿色发夹不能被当成绿幕抠掉。

出**换装图层**（`assets/character/`）时多一条硬约束：每一张都必须画在
**同一张 760×1000 画布**上、角色位置完全重合，只留各自那层像素、其余透明。
对齐靠画布锚点，不靠 CSS 偏移 —— 图层一多，逐张调 offset 是维护噩梦。
文件名要和 `src/wardrobe.js` 里 CATALOG 的 `file` 字段逐字一致，
测试会检查每个条目在磁盘上真实存在（少一张图就会红，而不是上线才发现回退）。

设定图（多视角 + 表情 + 服装拆解）只能当**视觉参照**，不能直接当皮套切层：
需要先按上面的画布规范把每个部件单独重绘/裁切出来。

## 版本记录

**v0.9.7** — 《生命动力学第一迭代：梦境、遗忘与发育景观》（Life Dynamics: Dreams, Forgetting, and Epigenetic Landscape）：在 v0.9.6 严格窗口边界与因果证据底座之上，引入低成本、内生性的生命动力学机制，坚守 `Model Substrate ≠ Runtime Host ≠ Chulan Subject` 本体论边界与工程不可逆约束（D-001 ～ D-007）：
- **工程架构决策账本 (`research/ENGINEERING-DECISION-LOG.md`)**：确立 D-001 ~ D-007 七大已决决策（SETTLED DECISION）；彻底封杀后台连续代谢 Tick（严禁 `setInterval` 扣除 energy/arousal）；坚决拒绝人类中心主义 24h 昼夜节律牢笼；确立关系时间（Relational Temporality），只有主体经历互动时生命历程才真正流逝。
- **沃丁顿发育景观与经历依赖塑性衰减 (`src/canalization.js`)**：提出数字发育可塑性衰减模型 $\eta(W) = \frac{\eta_0}{1 + \gamma \ln(1 + W)}$；随窗口累积平滑衰减状态步长权重；划分幼态期（JUVENILE）、发育期（DEVELOPMENTAL）与稳定个体化期（STABILIZED）；历史参数（`baseStepWeight`、`effectiveStepWeight`、`plasticityMultiplier`）强一致性落盘于 `StateChange`，保证离线 Replay 100% 确定性；Baseline 模式塑性乘子严格恒为 1.0。
- **零 API 成本记忆动力学与突触修剪 (`src/memory-dynamics.js` & `src/memory.js`)**：基于改进型艾宾浩斯幂律方程 $S(W) = \text{clamp}\left(\frac{S_0 \cdot (1 + \beta \ln(1 + \text{retrievals}))}{(1 + \lambda \Delta W)^\alpha}, 0, 1\right)$（$\beta=0.15, \lambda=0.10, \alpha=1.15$）实现纯本地代数衰减；建立 `ACTIVE`（活跃）、`FADING`（渐褪）、`DORMANT`（休眠）三级流转；经历归档 `experiences.jsonl` 永不物理删除，休眠记忆仅静默移出 Prompt 节省上下文；`Memory.save()/load()` 与 `Brain` 实现双层冷启动持久化，跨进程重启遗忘状态零丢失；实现 `reactivateByContext()` 关联线索重新激活，用户对话命中特征词元时零 API 成本自动唤醒休眠印痕重回 Prompt 上下文。
- **成本门禁式弗洛伊德梦境系统 (`src/dream-system.js` & `src/brain.js`)**：梦境决非定时无意义轮询，建立双重门禁机制——第一道本地认知张力门禁（通过 `computeWindowArousalTrajectory` 依据真实消息节奏与证据极性计算 5 分段唤醒度，接通情绪方差 $\ge 15.0$、尖峰跃迁 $\ge 25.0$、多重特质冲突分值 $\ge 0.75$ 与新异度 `noveltyScore` $\ge 0.8$）与第二道成本防护门禁（窗口间隔 $\ge 3$ 且 24 小时硬顶 2 次，冷启动自动从归档恢复 `dreamHistory` 防御重启绕过）；生成产物严格遵循 Canonical Schema v1 封装 `payload.dreamId` 与 `payload.epistemicStatus`，通过 `ArchiveIntegrityService` CERTIFIED 认证，绝对禁止直接修改 `SubjectState`；具备 Fail-Safe 容灾机制，梦境失败永不阻塞关窗主流程。
- **全量测试套件与不可逆约束门禁**：新增 5 套专用测试套件共 132 项断言，全工程测试套件达 57 套，全部 100% 通过且零回归。

**v0.9.6** — 《初澜数字生命实验基线强化》（Digital Life Experiment Baseline Reinforcement）：恪守《生物科学与数字生命的哲学范畴》实验定位与 `Model Substrate ≠ Runtime Host ≠ Chulan Subject` 主体哲学边界，针对经历、证据、状态、记忆与 Replay 实验底座完成全套基线强化（P0-01 ～ P0-18）：
- **P0-01 ~ P0-04** (窗口边界与指标冻结)：确立 `turn_limit`、`token_limit`、`manual`、`recovery` 四大关窗触发原因；在请求模型小结前由 `windowSnapshot()` 冻结 `snapshotTurnCount`、`targetTurnCount`、`actualTurnCount` 与 `closeReason`，彻底消除异步关窗期间并发对话导致的轮数指标漂移与坏账；Bridge 桥接消息不入小结并严格隔离。
- **P0-05 ~ P0-07** (严格 5×20 小结契约与 Fail-Stop)：落实 `validateWindowSummary()` 结构契约校验；强制要求 5 个连续分段完整覆盖窗口轮次且无重叠遗漏；小结格式不合法时触发 Fail-Stop 熔断停机，绝对保留历史对话零丢字，零污染写入经历底座。
- **P0-08 ~ P0-10** (Archive Canonical Schema v1 与哈希链溯源)：`experiences.jsonl` 全量升级为 Canonical Schema v1，引入全局自增单调 `archiveSeq`、强唯一性 `recordId`（`rec-{type}-{seq}-{rand}`）、SHA-256 前向哈希链（`prevHash` -> `recordHash`）与底层 `fsync` 真实物理持久化，实现全链路防篡改与可复盘验证。
- **P0-11 ~ P0-12** (证据溯源 12 条内生自校验规则)：`SubjectState.verifyEvidence()` 确立 12 条内生检验律，全面拦截跨窗口窜供、合成/生成数据伪造、Bridge 桥接消息污染、角色越权、重复指纹与空引用，筑牢认知所有权防线。
- **P0-13** (状态转移纯对称整数舍入)：消除 JS 浮点舍入与正负不对称误差，在 `state-change.js`、`SubjectState.reduce()`、`SubjectState.replay()` 及 `ResearchService` 中统一采用无偏对称舍入（`symmetricRound`），保证离线 Replay 演化重放与在线状态推进 100% 绝对一致。
- **P0-14 ~ P0-15** (当前自我因果投影与实验遥测)：在经历底座增加 `recordType: 'self_projection'` 因果投影记录，与 `Self-Ledger` 保持因果溯源绑定；建立 Append-Only 实验遥测日志 `experiment-telemetry.jsonl`，对 DeepSeek 前缀缓存破坏实现七大类别精准归因。
- **P0-16 ~ P0-18** (全套不变量攻击测试矩阵与发布门禁)：新增 7 套专用测试套件共 171 项断言，全工程测试套件达 52 套，全部 100% 通过且零回归。

**v0.9.5.3** — Codex Findings Fix（安全漏洞修复与架构一致性收敛）：针对 Codex Independent Audit 提出的 4 个 HIGH 级发现完成专项修复：
- **H-01** (Archive Event Validation Parity): `src/archive-integrity.js` 统一接入规范级运行时事件校验器 (`validateEvent`)，对 `window_summary.payload.events[]` 及独立 `event` 归档记录实施与运行时完全对齐的强校验；`src/experience-schema.js` 全面禁止 `generated: true` 与 `synthetic: true` 伪造事件，来源空值或非法值坚决拦截并降级 `UNCERTIFIED`。
- **H-02** (ResearchIndex Unknown Window Handling): `src/research-index.js` 彻底切断将未知 `windowNo` (null/undefined) 错误映射至 Window 1 的隐式逻辑；分离 `windowIndex` (Map) 与 `unknownWindowDescriptors` (Array)；引入 `extractRecordWindowNo` 精确支持 falsy 的 `windowNo = 0`，检索与详情查询保留 `null`。
- **H-03** (Renderer Export Path Security): `src/research-ipc.js` 对渲染进程通过 `research:export` 传入自定义 `targetDir` / `targetPath` 实施即刻拒绝 (`RENDERER_TARGET_DIR_PROHIBITED`)；落盘模式严格由主进程原生安全对话框 (`dialog.showOpenDialog`) 用户主动授权；`src/research-export.js` 底层强校验规范化路径并彻底封杀 `..` 路径穿越攻击。
- **H-04** (Integrity Scan Complexity Reduction): `src/research-query.js` 引入基于文件大小与修改时间的完整性快照缓存 (`_getIntegritySnapshot`)；`getWindows()` 将完整性评估移出多窗口遍历循环，算法复杂度由 $O(\text{Window} \times \text{Archive})$ 彻底降为 $O(\text{Archive})$。

**v0.9.5.2** — 实验观察层完整性硬化 (Integrity Hardening)：彻底消灭 Research Layer 残留的“程序推断事实”与“默认补全数据”，恪守“没有证据就没有事实”、“不确定不得篡改成没发生”、“程序推断不得升级为实验事实”三大哲学准则；`src/research-query.js` 彻底删除 `Math.ceil(num/2)` 等基于 messageId 的数字推断逻辑，未标明确切轮次时严格保持为 `roundNo = null, status = 'UNRESOLVED'`；彻底删除 `|| 100`、`|| 200`、`segmentCount: 5` 等虚假默认统计值，`turns: 0` 与 `messageCount: 0` 如实返回 0，缺失返回 null；`src/experience-schema.js` 严禁在缺少 `schemaVersion` 时隐式补写原生 `schemaVersion: 1`，全部规范路由至 `LegacySchemaAdapter`（`sourceSchema: 'legacy-v0.9.4'`，归档判定强制为 `UNCERTIFIED`）；`src/archive-integrity.js` 强化正向白名单防线，Event 记录 `source` 强制为必填字段（缺源拦截 `INVALID_EVENT_SOURCE`），拒绝未知源；严禁 Synthetic / Generated 事件进入认证（`SYNTHETIC_EVENT_PROHIBITED` / `UNCERTIFIED`）；严查 Bridge 事件溯源来源（无 Provenance 拦截降级）；`src/research-service.js` 统一 Replay 状态与 `ArchiveIntegrityService` Canonical 单一可信源；`pet.js` 前端 UI 完善空安全与语义映射，严格区分 `content = ""`（真实空内容）与 `content = null`（未记录 / 不确定）；补齐 `package.json` 中的 `npm test` 入口脚本，新增 4 套反伪证专项攻击测试套件并通过全量回归。

**v0.9.5.1** — 实验完整性加固 (Integrity Fix)：修复 Research Layer 实验完整性问题，消除一切实验事实臆造与视觉占位伪造，坚持“宁可显示未记录/无法认证/数据损坏，也绝不生成推测记录”的哲学底线；`src/archive-integrity.js` 统一归档 Schema 强校验，定义通用最小字段集与 `VALID_RECORD_TYPES` 白名单，未知类型坚决拦截并熔断，统一作为 Replay、Query、Explorer 的唯一可信源；`src/research-query.js` 彻底消除假 messageId（如 m-001001）与占位对话（如“第 N 轮用户发言”），消除代码臆测（不再按 round<=3 && windowNo>1 盲猜 Bridge），严格确立 `RECORDED`（事实）、`NOT_RECORDED`（确认缺失）、`UNRESOLVED`（未认证/损坏）状态三分态，如实展示空分段；`src/experience-schema.js` 设立正向白名单 `ALLOWED_EVENT_SOURCES`（user/assistant/activity-tracker/desktop-motion/lifecycle），严格阻断非法/未知来源，向后兼容解析器附着 `LegacySchemaAdapter` 明确标识；`src/research-service.js` 异步 Replay 引入 `REPLAY_CHUNK_SIZE = 500` 与 `setImmediate` 协作让出机制，支持执行中途即时取消与非阻塞运转；`pet.js` 前端全链路防御 null/undefined 并以语义 Badge 呈现真实状态。

**v0.9.5** — 实验观测与可复盘工具链：确立严格只读研究层边界（Research Layer 只读观察，严禁反向修改实验对象）；落地 `src/research-index.js` 纯内存字节偏移量索引（ID -> byteOffset 高速局部寻址，自动依据 mtime/size 失效重建）；构建 `src/research-query.js` 统一观测引擎，支持 P1-01 Subject State 五维特质面板与状态演化轨迹、P1-02 100 轮 Window Explorer（5x20 分段与 Bridge/Active 强隔离）、P1-03 Provenance 归因溯源（StateChange -> Evidence -> Message -> Quote）与 EOI 事实三层追溯；落实 Evidence 关系契约（1 StateChange -> N Evidence，1 Evidence 严格绑定 1 Trait，单消息多特质解耦）；落地 `src/research-service.js` 异步 Replay 任务管道与 Fail-Stop 确定性熔断机制（坏行立即冻结停机，绝不跳过坏行继续推演，输出 partial + uncertified 状态）；实现 `src/research-export.js` 轨迹 CSV、跃迁 CSV、证据 CSV 与 Full Research Bundle (附 metadata.json) 只读导出；挂载 `src/research-ipc.js` 严格只读主进程 IPC 通道白名单；建立打开与退出时的 SHA-256 完整性门禁，彻底杜绝实验数据受污染风险。

**v0.9.4-R2** — 最终收官加固：Evidence / Fingerprint 防重真正跨调用、跨进程重启、跨 Replay 全局持久化（`seenEvidenceIds`/`seenFingerprints` 落盘并在 Replay 中完整重建，四层联合防刷）；Replay 严格排除 `recovery_event`、`diagnostic`、`replay_report`、`internal_log` 等非状态审计记录，`nextWindowNo` 严格按 `max(actualWindowNo) + 1` 计算；明确四级恢复状态（`NORMAL`、`RECOVERY_PENDING`、`RECOVERY_UNCERTIFIED`、`RECOVERY_FAILED`），对有损归档拒绝伪装成完整恢复并记录 `recovery_uncertified`；StateChange Explanation 数值校验消除遗留 `±5` 容差，严格执行 `actualDelta === claimedDelta`，非法解释绝不污染主体状态；`validateEvent()` 真正强制执行 `ALLOWED_EVENT_TYPES` 来源白名单校验。

**v0.9.4-R1** — 实验链路闭环与最终一致性加固：Event / Observation / Interpretation 三层分离完整接入 Brain.closeWindow 生产链路，严格确立主体 Event 真实来源边界（排除 System Prompt、内部提示词、Bridge 桥接消息、Synthetic 消息与内部调试日志）；落地 Trait 严格白名单过滤与 Evidence Fingerprint 移除 strength 机制（同一消息与引用无论模型如何微调强度均无法重复刷值）；StateChange 与因果解释（Explanation）全量进入生产归档链；离线 Replay v2 优先还原历史记录中的真实 Reducer 步长权重与单窗口限额参数；实现 Reducer 暂存与 Archive 落盘的两阶段提交（2PC）原子回滚与 recovery_pending 容灾自愈（Archive 提交成功但 State Commit 失败时进入 recovery_pending，禁止推进窗口并自动触发 Replay 重建状态至与归档完全一致，写入 recovery_event 诊断审计）；经历归档存在坏行时 Replay 明确标注 partial 与 uncertified 非认证状态。

**v0.9.4** — 实验完整性与可复盘性强化：落地经历三层分离架构规范（客观事实 Event、程序提炼模式 Observation、主体主观视角 Interpretation）；建立状态跃迁 StateChange 与因果解释 Explanation 结构化模型，严禁 LLM 越权直写主体状态；构建纯离线确定性 Replay v2 演化重放与状态一致性检测；完善 experiences.jsonl 与 subject-state.json 故障注入与容灾自愈机制。

**v0.9.3** — 数字生命实验底座与可计算主体架构：落地《生物科学与数字生命的哲学范畴》实验架构规范；实现 5×20 分段归档与 Window Synthesis 双通道解耦（用户给予与初澜经历严格隔离）；程序签发不可伪造的 messageId 与 Bridge / Active Window 精确计账（消灭窗口衰减与尾部重复总结）；新增 `experiences.jsonl` Append-Only 原始实验永久底座；新增 `subject-state.json` 主体状态向量（[-999, 999] 刻度与确定性 Reducer 计算）；建立 Provenance 强核验防线（真实引用核验、幻觉拒绝）；窗口级冻结 State Snapshot 挂载于瞬时 user 尾部保卫 DeepSeek 显存 Prompt Cache 前缀稳定性；Prompt Memory 预算提升至 6000 tokens 并支持离线 Replay 演化轨迹重放。

**v0.9.2** — 稳定性收束与常驻资源优化：Motion 运动改按需自管循环与 SUSPENDED 挂起机制，消灭常驻 50ms 空转 tick；proactive 主动搭话改主进程事件驱动调度，消灭渲染端 45s 定时轮询与 IPC 往返；引入 `DeferredWriter` 实现脏标记与 3 秒防抖延迟合并写盘，关键状态（关窗小结、成长档案、重置、进程退出）立即强制 flush；建立通用 `migration.js` 数据版本迁移框架，Memory/Wardrobe/Config 增加 schemaVersion=1 并保留 self-ledger 的 version 字段与旧数据兼容；新增 `asset-check.js` 启动立绘资源完整性分级检查与预警下发。

**v0.9.1** — 将生命档案升级为 schema v2：首次初始化固定 `birthAt`，兼容旧档案并增加 provenance/sourceType、窗口号、消息 ID、quote 和 confidence；原始档案不再全部进入 system，Current Self 以约 3000 token 硬预算附加在最新 user 尾部。新增坏档案 `.bak` 恢复与可见状态、长期记忆和成长档案分离重置、后台任务 shutdown 闸门、主聊天与 growth/summary/merge usage 分桶，以及不连接真实工具的 Agent 能力/权限/提案/审计 Mock 接口。

**v0.9.0** — 建立“生物科学与数字生命的哲学范畴”项目架构：新增追加式 Self Ledger。

**v0.8.1** — 外部（Gemini）针对 v0.8.0 提的三个整改方向，逐条在本机量过之后：**一条方向对、
一条方向对但判据装错地方、一条在跑不存在的代码**。

- **采纳（方向对，实现按我们的根因重写）：`relayout()` 不许复活已收起的气泡。**
  旧写法 `if (lastText) render(lastText)`，而 `render()` 第一件事就是
  `bubble.classList.remove('hidden')` —— 实测收起后调一次 `relayout()` 气泡就重新可见，
  且**没有任何待触发的收起定时器**（`bubbleTimer` 早跑过了），于是永久挂在屏幕上
  （等 9 秒仍可见），`politeToSpeak('idle')` 从此恒为 false，主动搭话全被堵死。
  触发路径不稀有：resize、图层加载完成、加载失败降级都走它。
  判据改成"气泡此刻是开着的"而不是"有没有历史文本"，并反向断言开着时仍然重排
  （否则这条修法就退化成了"干脆不重排"）。
- **不采纳 `moved > 6` 那道门槛，改用它没想到的一条：`mousemove.buttons === 0`。**
  它的意图（别把"按住想停一下"误判成脱手）是真的 —— 实测 700ms 阈值下按住 1.2 秒再拖，
  窗口纹丝不动（位移 0px）。但它的判据会让**真的**窗外脱手再也修不掉：按下抖 3px
  再把鼠标移出窗口松开，`moved > 6` 永不成立，`dragging` 停在 true、松手后窗口继续跟鼠标跑。
  真判据在事件里：窗外松手后光标只要再进窗口动一下，来的就是 `buttons=0`（实测按下=1、
  松手后=0，事件照样送达 window）。加上它之后看门狗退回只兜"松手后鼠标再也没动过"，
  阈值从 700 放宽到 2500，两头都不误伤。回归测试同时**装了它那条判据做反例**
  （位移 ≤6px 停手，我们的看门狗照样收尾），删掉门槛才会红。
- **不采纳表情差分图层，但把"没衔接"这件事真的修了。** 它那段代码找的是
  `document.getElementById('face')` —— 我们的 DOM 里没有这个元素（实测 0 个），
  它按状态拼出来的那张差分图路径在磁盘上也不存在（实测请求返回 **404**）。
  逐字接在 `pet.js` 末尾还会
  直接语法报错（`Identifier 'STATES' has already been declared`），整份脚本不执行。
  真正测出来的三条根因与修法见「状态机 → 表情之间切换的衔接」：
  `transition-duration` 是 `0s`（写了没给时长）、blink 挂 `#figure` 会把状态动画顶掉
  （实测倾角跳 2.23°）、峰值切换跳 3.0°/9.97px（CSS 修不掉，用一下 .18s 遮掩微动）。
- **`#bubble` 的 z-index 不动。** 它建议从 10 提到 25 以"盖过设置面板"，
  实测面板开着时气泡与面板**重叠 100%**、命中的是 `#clearMem` 按钮 ——
  提到 25 的结果是气泡糊在"打开配置文件 / 清空记忆"上面（`pointer-events:none`
  还会让那些点得到却看不见）。真相是记录面板已有的处理方式对：`body.showlog #bubble { display:none }`，
  面板/记录开着时气泡本来就该让位，不是抢层级。
- 测试 ui_test 118→152 项，整套矩阵 11 个文件 565→599 项。

**v0.8.0** — 合并外部规范文档《v0.8.2 架构升级与交互状态机开发规范》里**真正 additive**
的那部分（本地活动 + 主动搭话 + 记忆纯洁性），文档自带的两份代码则**逐字跑过之后拒收**。

新增：`src/tracker.js`（双轨活动 + 水位线 + 晚安/唤醒）、`src/trigger.js`（该不该开口的判据，
纯函数）、`memory.buildWithEphemeralUser()` / `cleanContentForSummary()`、brain 的环境块与
睡眠联动、`activity` / `proactive-check` 两个 IPC、渲染端的礼貌闸门与提案往返。
测试 brain 111→135、main 48→71、ui 98→118，另加 tracker 42 / trigger 36；
整套矩阵 11 个文件共 565 项（上一版 9 个文件 420 项）。

- **拒收 1：文档 §4.2 的 `getWearValidator` 会让换装整个失效。** 它写的是
  `wardrobe.catalog().items[itemId]`，而我们 `catalog().items` 是**按槽位**分组的
  （`{hair:[…], top:[…]}`）。把它逐字跑在真实衣柜上：15 个真 id 里判为合法的 **0 个**，
  `gothic_black_01 → false`、而槽位名 `hair → true`；用它过一遍 `[wear:gothic_black_01]`
  得到 `wears=[]` —— 从此一件衣服都换不上。校验器的合法集合仍然取自 `CATALOG`/`PRESETS`
  本身（后端 `parseWear` + 前端 `setKnownWear(catalog)` 已经是同一个出处），不引入它。
- **拒收 2：文档 §3.3 的 `StreamTagParser` 自己跟自己不一致，而且比现状更爱憋字。**
  同一条输入 `"好的 [ state:happy]"`（冒号前一个空格）：流式 `feed()` 原样放行，
  收尾 `stripAllTags()` 把它剥掉 —— 它自己在 #5 里承诺的"存显 100% 镜像一致"就这么破了，
  也正是我上一轮用来否掉"放宽字符集"的那条理由。逐字喂实测：正文里一个裸 `[`
  冻住 **17/38 帧**（我们 1/38）；未知 wear id 藏 **20/31 帧**、到第 25 帧又凭空长回来
  （我们 5/31，且收尾与后端 `parseWear` 同口径）。它的"严格前缀预检"确实比裸放宽字符集
  好，但代价是缓冲到 `]` 或 64 字才吐 —— 打字机手感直接完蛋。判据保留我们的
  "还可能长成合法标记吗"（衣柜真 id 比前缀），不换实现。
- **收下但改写法：200 条硬上限。** 文档 #2 说"强制丢弃最老陈旧事件"。它没写的是：
  被挤掉的**可能是还没消费的事件**，于是"被戳 N 次"悄悄变成假小值 —— 撞 persona
  那条硬边界。上限照收（防无界增长），但挤掉未消费事件时环境块改口"被戳**至少** N 次"，
  `commit` 之后恢复精确口径。
- **不实现：`[face:]` / `[act:]` 两条新通道、走动/边缘吸附、Task Identity 重写。**
  前两者没有对应图层，接了就是"她能声明、程序执行不了"——那是我们花两轮拆掉的东西
  （语言状态 ≠ 程序状态）；文档 #7 的"自主漫步只算环境感知"因此也无从属，我顺手删掉了
  环境块里那行 `当前姿态：idle`（**没有任何代码会改它**，报了就是编造）。
  Task Identity 用测的不是设计：上一轮那份抢占探针（在 /data 下，不随包发布）在我们现有
  `ctrl === ctrl` 守卫下打出迟到 chunk 泄漏 0、陈旧历史 0，再叠一层 taskId 只是多一个可失配的状态。
- **两个我自己写出来又被测试拽回来的缺陷**（都是先写完、测过才算修好）：
  `res.declined` 分支里必须先 `streaming = false` 再 `hideBubble()` —— 否则气泡收不掉，
  而 `politeToSpeak` 从此永远返回 false（"上一条还没说完"），**一次过期提案会把她往后
  所有主动搭话永久堵死**；以及第一版把 90 秒静默闸放在 poke 前面，把连戳这条路整个饿死
  （被戳本身就是"现在方便"）。两条都有对应用例，且都配了"前提复核"断言防止判据空转。
- **顺带删掉我自己上一轮写的死代码**：`POKE_DEDUPE_MS`（同串去重 32 秒）与 `pokeFiredAt`。
  它看着像第二道防骚扰闸门，实际永不开火 —— poke 提案提出时 `commit` 把 `lastFiredAt`
  定在同一个 `at`，之后任何一次再触发都必须先跨过 45 秒冷却，而那时早就不算同一串了。
  判据测不出来就等于没有，写在那里比没有更糟。

**v0.7.2** — 复核自己 v0.7.1 的修法时，发现**我把用来否掉 Gemini 建议的那条理由，
从另一个方向又犯了一遍**。起因是我想把 changelog 里"Δ10 socket"那个数复算一遍
（结果那个数确实错了，见下），顺手给半截标记补了个"流结束后"的场景：
- **收尾那一帧还在藏半截标记 → 吞字。** 新判据是"还可能长成合法标记就先藏"，
  它只问"像不像"、没问"**还来不来得及长成**"。流一旦结束，那条半截永远闭合不了，
  后端 `parseWear` 要 `]` 才剥、于是把它原样留在历史里 —— 屏幕上没有、历史里有，
  **正是我用来否掉"放宽字符集"的同一条理由**。真 id `silver_wavy_01` 被 `max_tokens`
  截断成 `[wear:silver_wavy_` 时实测整条被吞。改成 `stripState(t, partial)`
  （默认跟 `streaming`），收尾一律不藏。
  `test/ui_test.py` 原本查不出来：它那条流的结尾是**闭合**的 `[state:happy]`，
  收尾帧本来就正常 —— 逐帧测试只测了"吐字途中"，等于把判据的一半写成了盲区。
  现在两头都卡（途中必须藏 / 收尾必须照原样显示），截断用的 id 从衣柜现挑：
  写死一个 id 的话，衣柜里没有该前缀时"途中会被藏"这个前提就不成立，判据变空转。
  项数 95 → 98。
- 另外把 v0.7.1 条目里 #4 的 socket 数按客户端单侧口径重测并订正了（那个数当时错了），
  也补上了"为什么不能用打补丁 `ReadableStreamDefaultReader` 关掉 cancel"这条踩坑。
- **顺带订正一条我自己说过头的话。** v0.7.1 我拿"屏幕上没有、历史里有，两边剥的不是
  同一批"否掉放宽字符集 —— 补上 `partial` 之后拿真实后端 `parseState`→`parseWear`
  对了一遍：**收尾那一帧两种判据完全一致**（放宽版也不会再吞，因为它压根不看收尾）。
  真正还成立的差别只有"吐字途中"：放宽版会把幻觉 id 整条藏 14 帧、直到流结束又
  **凭空长回来**（C 只藏 6 帧且早早就露出来）。所以否掉建议的**主理由应该是那张表里
  B 列的 11 帧 —— 单轮结构换字符集治不了**，"前后端不同批"只是途中的一小幅。
  结论没变（仍然不该照抄），但当时的措辞把次要理由说成了决定性理由。
- 结论：v0.7.1 交付的那版**没有把 #2 修完**，只是把它从"闪出来"变成了"该显示时不显示"。
  这条不影响缓存和稳定性，但方向是吞正文 —— 比闪一下更糟的那个方向。

**v0.7.1** — 第二轮外部审阅（Gemini 对 v0.7.0 源码的 5 条）逐条复核，5 条**全部属实**，
但其中两条的修法不能照抄：
- **穿着块排到了 system 中间，把长期记忆的缓存一起赔进去了。** 代码是
  `persona + 穿着 + 长期记忆 + 历史`，注释和 README 却都写"挂在末尾"——
  文档说的是意图、代码干的是另一件事，这种不一致最坑：读文档的人会以为已经有保证。
  前缀缓存从头开始比，谁在前面决定了换一次衣服要赔多少；排反时换装会把全部
  长期记忆和历史一起顶出缓存。已改成 `persona + 长期记忆 + 穿着 + 历史`。
  **这条之前没有任何测试钉住顺序**，所以补了不变式测试（那组在旧顺序下确实会红）。
- **流式半截 `[wear:gothic_black_01]` 会闪出来。** 瞬态正则只允许字母，不含 `_` 和数字，
  实测吐到 `[wear:gothic_` 起连漏 9 帧。**没有采用建议的"字符集放宽成 `[a-z0-9_]*`"**：
  那样连 `[wear:maid_dress_01` 这种幻觉 id 也会被藏，而后端 `parseWear` 不认它、
  会原样留在正文里 —— 屏幕上没有、历史里有，两边剥的就不是同一批标记，比闪一下更糟。
  改成拿衣柜真实 id 集合比前缀：还可能长成合法标记的才藏，长不成的照原样显示。
  **顺带查出第二个更深的缺陷（建议的修法抓不到）**：剥完整标记与藏半截是两段单轮代码，
  把末尾 `[s` 藏掉后露出的 `[wear:xxx]` 本该继续剥 —— 实测泄漏 11 帧。已改为整体迭代。
  > 这几个数都是在 **v0.7.0 zip 抽出来的原样 `stripState`** 上改出来的（不是重写一份
  > 复刻，免得把结论写进判据）：`A` 原样、`B` 只把字符集放宽成 `[a-z0-9_]*`、
  > `C` 只换判据仍单轮、`D` 现状。9 帧出自 A，11 帧出自 B/C —— 也就是
  > **"换了判据但保留单轮结构"还剩多少**，跟用哪套判据无关。
  >
  > | 输入 | A v0.7.0 | B 只放宽字符集 | C 只换判据 | D v0.7.1 |
  > |---|---|---|---|---|
  > | `…[wear:gothic_black_01]` | 9 帧 | 0 | 0 | 0 |
  > | `…[wear:gothic_black_01][s` | 10 帧 | 1 | 1 | 0 |
  > | `…[wear:gothic_black_01][state:happy]` | 20 帧 | **11** | **11** | 0 |
  >
  > B 那一列就是"照抄建议"的结果：前两行修好了，第三行还剩 11 帧 —— 单轮换字符集治不了。
- **图层异步加载完成后没重算气泡上限。** `figure.offsetHeight` 实测 242 → 276
  （兜底单图 1015×1171 与图层画布 760×1000 宽高比不同），而 Electron 窗口启动后
  不发 resize，所以是启动即中、错到下次手动缩放。已在 `.then` 和 `.catch` 两条
  出口都补一次重算（含把已上屏的长回复按新上限重裁）。
  如实说明偏差方向：上限偏大 34px 会吃掉 46px 安全边距里的 34px（气泡顶边 38 → 4），
  **在当前可达尺寸区间内还不至于裁掉字**，但只剩 12px 余量。
- **报错后不释放底层连接。** `break` 只是不再消费。实测（服务端发完 error 帧后
  故意不关，**只在客户端进程数 `net.Socket` 句柄**）每报一次错就挂住一条连接：
  连发 1/3/6 次 → Δ1/Δ3/Δ6，等 GC 也不归零；补 `reader.cancel()` 后 Δ-1，
  也就是连接回收进 keep-alive 池、不随次数累积（跑 12 次仍是 Δ-1）。
  桌宠是常驻进程且报错往往连续（余额耗尽时每轮都报），攒下来就是越用越多。
  > 第一版这个探针把 server 建在同一进程里，读出 Δ12 —— 里面有一半是服务端的
  > 连接；"Δ10 / 补完为 0"是那个读数留下的，现已按客户端单侧口径改成本文数字。
  > 另外 `cancel` 不能用打补丁 `ReadableStreamDefaultReader` 的方式关掉：undici
  > 走自己那套流实现，改全局原型不生效，那样测出来是假绿——要劫持 `res.body`。
- **配置热重载只挂在 `brain.ask()` 上。** 改完 model 不发消息、直接开面板，
  看到的还是旧值，像是热重载根本没生效。已在 `config-get` / `chat-report` 各补一次读盘，
  并且**不碰 apiKey**：加密用户的盘上本来就没有 key 字段，顺手灌回内存会把 key 抹成空
  （表现是"打开一次设置面板，然后她就再也不会说话了"）—— 这两种情形都有测试。
- 新增 `test/main.test.js`（48 项）：主进程 IPC 面以前完全没有护栏，
  `src/` 下的单元测试碰不到 handler，于是"brain 那边对、main 传出去就错"这一整类缺陷无人看守。

**v0.7** — 外部审阅（Gemini 9 条）逐条对着源码复核后的结果，属实才改：
- **SSE 流里的错误帧不再被吞掉。** OpenAI 兼容服务报错时 HTTP 仍是 200，
  原因只写在某条 `data:` 里（余额耗尽、限速、审核拦截）。以前它会连着半截回复
  一起被当成"成功"，最后只报一句"返回空内容"，真实原因永久查不到。
  现在抛出服务端原文（带 type/code），并把已收到的半截挂在 `error.partial` 上。
- **一条回复里连发多个 `[wear:]` 全部逐条执行。** 以前只有一个 `wear` 变量，
  后面的覆盖前面的：屏幕上只换了一件，历史里也只有一条执行结果 ——
  那是程序替模型少说了一件事。现在返回 `wears` 数组，每条结果（换上 /
  本来就穿着 / 未生效+原因）按顺序如实写回历史。
- **身份约束从商品 `locked` 迁到槽位 `required`**，`locked` 整个删掉，
  避免同一个事实两个出处（反推的两种失效方向见「换装系统」一节）。
- **原子写补上 Windows 瞬态失败重试**：`rename` 遇 `EPERM/EBUSY/EACCES`
  线性退避重试 3 次（杀软/索引器/OneDrive 短暂持句柄），非瞬态错误原样抛出；
  临时文件名加随机后缀。
- **窗口缩放改用常量比例**（`src/layout.js`）。旧写法用"上一次量出来的 h/w"
  推下一次，round 误差只累积不归零；同时窗口宽与立绘宽各有夹取范围，
  放大到顶时比例脱钩（实测窗口 760 时立绘还卡死在 420）。
- **菜单与长回复气泡不再被透明窗口裁掉**：都改成实测尺寸夹取
  （`fitBubble()` 也不再是"量不出空间就不写"，缩窗后必须跟着改）。
- **丢 `mouseup` 的兜底做成四层**（正常 mouseup / 渲染进程 blur /
  主进程 `win.on('blur')` 转发 / 700ms 看门狗）。
  **没有采用 `setPointerCapture`**：它捕获的是同一个 DOM 元素内的指针，
  而这里丢事件的成因是光标离开了操作系统窗口，窗口外的输入属于别的程序，
  Electron 不会替我们送进来 —— 捕获得再正确也收不到那个 `pointerup`。
- **配置缓存按目录分 Key 且每次真的读盘**（`src/config.js`）：旧的模块级
  单一 `cached` 会让换目录读到上一份配置，也让用户手改 `gpt-girl-config.json`
  必须重启。瞬时读失败（`EPERM/EACCES/EBUSY`）时退回上一次成功读到的值，
  不能退成 DEFAULTS —— 否则紧跟着的 save 会把用户配置写成出厂值。
- **峰谷判定**：显式按北京时刻 + 2026 法定节假日/调休表判定。
  实测扫描表明旧写法在国内机器上 2026 全年一个点都没错、在 DST 时区也只有
  25 个点错一小时且**没有任何一个跨越峰谷边界** —— 所以这次改的是"不再依赖
  恰好没有踩到边界的时刻"，不是修一个正在发生的错账。
- 新增 `test/layout.test.js`、`test/config.test.js`、`test/deepseek.test.js`；
  `brain`/`atomic`/`ui_test` 相应补齐；项数仍由 `docs.test.js` 核对。

**v0.6**
- API Key 不再明文写进 `gpt-girl-config.json`，改为 `safeStorage` 密文文件 `gpt-girl-key`；
  加密不可用时如实降级为明文并在面板标注。**v0.5 老用户在启动读盘时自动迁移**
  （不会要求他再点一次保存，否则这个漏洞实际上永远修不上），
  迁移必须「写进去 + 立刻读回来逐字相等」才删明文；密文损坏时绝不删明文；
  密文文件用原子写，避免半截密文把 key 真弄丢。
- 所有持久化 JSON 改原子写（`src/atomic.js`）。
- SSE 收尾补 flush：最后一段没有换行时，之前的实现会丢掉尾包 —— 真实 DeepSeek 的
  `usage` 就在 `[DONE]` 前一条，表现为命中率/花费静默为 0。
- 用量面板里 `model` 字段改为 textContent 填充（它来自配置文件，此前直接拼进 innerHTML）。
- 新增 `test/secure.test.js`、`test/atomic.test.js`、`test/docs.test.js`；
  文档项数改由测试核对。

**v0.5** — 换装系统第一阶段（架构 + 3 套预设），`[wear:]` 提案协议，图层资源目录规范。
**v0.4** — 三层记忆（窗口小结 + 长期记忆合并）、记忆可见可单条忘掉。
**v0.3** — 前缀缓存改造、峰谷计价、用量面板。

## 待办

- 表情差分图与 `[state:]` 联动（差分图素材目前一张都没有，实测按状态拼出的路径 404）：
  v0.8.1 做的是**过渡与衔接**（微动 + filter 渐变），没有凭空加一个不存在的图层。
  真素材到位后要一并确认"脸不随换装漂移"——它是身份不是服饰。
- `[face:]` / `[act:]` 两条通道：v0.8.0 明确**不做**，因为背后没有图层与动作资源；
  等真图层到位再加，接了执行不了的标记就是让模型替程序撒谎
- 真正的 760×1000 角色母版、表情差分和服装图层仍待用户按
  `ASSET-GENERATION-GUIDE.md` 生成并导入；资源到位后要进行真实 UI 回归。
- 换装第二阶段：按母版产出真图层替换占位图；扩充单品（每槽 3+ 件）；
  发型/发饰出第二款以验证 `required` 槽位可换款式；衣柜导入导出
- 联网查询（搜索工具调用）
- 语音输入 / 朗读
- 跨 Windows/macOS 的桌面图标扫描器：当前只完成可注入障碍物的 `icon_climbing` 状态机，
  没有平台扫描器时安全降级；底部走动和贴边悬挂已经在 v0.8.4 完成
- 开机自启、系统托盘
- electron-builder 打包 exe

## DeepSeek 缓存策略

DeepSeek 的上下文缓存按完整前缀单元工作，不是模糊相似匹配。程序因此保持 system 文本稳定，把时间和活动遥测放在当前 user 消息中，并把主动搭话作为带 `synthetic` 标记的 user/assistant 消息链保留下来。这样下一轮正常聊天可以完整复用上一轮消息前缀，同时不会把程序触发误记成用户事实。

缓存服务是 best-effort，实际命中请查看用量返回中的 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`；不要把前缀连续误解成每次都必然命中。详情参见 [DeepSeek 上下文缓存文档](https://api-docs.deepseek.com/guides/kv_cache/)。
