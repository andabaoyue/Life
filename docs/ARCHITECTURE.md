# 架构与实现细节

> 本文件承接原 README.md 里的实现层章节。README 只留「她是什么 / 能做什么 / 做不到什么 / 怎么扩展」，
> 这里给开发者和想改代码的人看：模块地图、记忆模型、缓存不变式、换装数据结构、配置项、路线图。
>
> **搬移时正文一个字未改**，只在章节之间加了分隔线。

---

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
src/animation-state.js 程序化自然动画：物理微动与姿态状态机
src/render-adapter.js  动画渲染适配器：解耦状态输出与 DOM / CSS 图层接管
src/animation-controller.js 动画控制器：60fps 驱动器与图层微动矩阵
src/behavior-scheduler.js 自主行为调度器：呼吸、眨眼、打哈欠、伸懒腰
src/asset-check.js     启动立绘与换装资产完整性分级检查
src/deferred-writer.js 脏标记与延迟合并写盘
src/migration.js       数据版本迁移框架
assets/pet.png        透明立绘（单图兜底皮套，64×80 像素点阵）
assets/character/     分层换装资源（见「换装系统」）
tools/chroma.py  绿幕抠图脚本
tools/check.js   全量语法检查脚本
tools/release-check.js 发布包资源完整性自动化检查脚本（含公开发布剥离门禁）
tools/public-export.js 公开发布剥离器：白名单选出可公开文件，默认拒绝未分类文件
tools/replay-check.js  Replay 离线推演一致性核验工具
test/            测试
```


---

## 桌面漫步与运动边界

窗口位移由主进程每约 50ms 使用 `BrowserWindow.setPosition()` 驱动，底边锚定在主显示器工作区下沿上方的安全边距内。渲染进程只负责表现漫步姿态，不通过 CSS 把人物移出透明窗口，因此不会被窗口边界裁成半截。

- **真实可用运动**：屏幕底部缓慢漫步并在触碰主显示器左右边界时短暂停留（约 1.8s）后自主掉头折返；
- **诚实的能力边界**：桌面图标的真实位置并没有跨 Windows/macOS 的通用 Electron API，程序绝不假装已经自动感知读取系统图标或窗体（`desktop-motion.js` 仅预留障碍物注入接口，后续可接注入适配器）；没有障碍物 provider 时，程序安全降级为底部漫步与边缘折返；
- **环境块诚实不变式**：当前的运动状态**不会**编造注入进大模型对话的环境感知块（恪守 D-007「绝不向模型编造无出处事实」铁律）；
- **窗口缩放机制**：桌面窗口固定采用原生 4x 整数倍像素缩放比（256×320 视口），不提供滚轮拖拽任意缩放功能，确保点阵绝对锐利无双线性模糊。

配置文件可以控制：

| 字段 | 默认值 | 作用 |
| --- | ---: | --- |
| `motionEnabled` | `true` | 是否启用自主运动 |
| `motionSpeed` | `2` | 每 tick 的窗口位移像素 |
| `motionTickMs` | `50` | 主进程运动 tick 间隔，范围 30–250ms |
| `motionMargin` | `20` | 工作区底部安全边距 |


---

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
  严格区分「用户给予」与「主体经历」双通道，提取 Provenance 强核验的状态证据，由确定性 Reducer 计算状态增量。
- 关窗时旧原文安全归档，保留最近 `keepTailMessages`（6）条并标记为 `bridge: true`，作为下一窗口的缓存桥接，不计入下一窗口轮数，也不被重复总结。
- 桌面数字生命首次初始化时创建固定 `birthAt`，只代表程序意义上的出生时刻，不伪造出生以前的人生。
- Current Self 默认预算约 3000 token；它只表达出生以后形成的有限当前解释，并保留支持/反向证据。
- `self-ledger.json` 采用版本 2，包含 `birthAt`、`sourceType`、窗口号、消息 ID、证据摘录和置信度。
- 小结总长超过 `memoryCapTokens`（12000）时，把较旧的几条合并成一条
  【早期】记忆 —— 这一步刻意搭在关窗的同一刻做，反正 system 已经要变，
  一起变只破一次缓存，分两次做就破两次。
- `windowMaxTokens`（30000）只是兜底：单窗口 token 超了会提前关窗，
  正常聊天基本触发不到，V4.1 Flash 上下文 1M 完全够。

**一个窗口内 system 一个字都不变**，所以 100 轮里除了第 100 轮那次关窗，
其余请求前缀严格只递增 —— 这就是命中率的来源。
V4.1 Flash 上下文上限 1M token，6000~8000 的设置完全没压力，
真正影响成本的是每次请求的重复计费，所以窗口越大命中率越高、但单次未命中也越贵。


---

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


---

## DeepSeek 缓存策略

DeepSeek 的上下文缓存按完整前缀单元工作，不是模糊相似匹配。程序因此保持 system 文本稳定，把时间和活动遥测放在当前 user 消息中，并把主动搭话作为带 `synthetic` 标记的 user/assistant 消息链保留下来。这样下一轮正常聊天可以完整复用上一轮消息前缀，同时不会把程序触发误记成用户事实。
缓存服务是 best-effort，实际命中请查看用量返回中的 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`；不要把前缀连续误解成每次都必然命中。详情参见 [DeepSeek 上下文缓存文档](https://api-docs.deepseek.com/guides/kv_cache/)。


---

## 角色基准（改动前先读这节）

- 外观基准是**换装设定图**（v0.5 起）：成年比例、银白微卷长发、发尾仅非常淡的冰蓝、
  蓝灰大眼、单侧泪痣、**头发右侧黑色蝴蝶结**。
  v1.0 语义收口：核心身份为名字、脸型、**发色**、眼睛与泪痣；**发型款式与有无（含无发素体形态）**、
  发饰、颈带吊坠与衣物均为可变外饰，由衣柜真实状态决定。不含字母耳坠。
- 默认单图兜底立绘已全量内置（`assets/pet.png` 为 64×80 正典像素点阵）；若用户需要替换为第三方自定义立绘，可参考进阶玩法章节或 `ASSET-GENERATION-GUIDE.md`。
- 人格：温柔、安静、慵懒、微黏人、偶尔吐槽；短回复；称「你」；无客服腔。
- 能力诚实：没实现的功能一律说做不到，绝不假装操作过电脑。这条写在 persona 边界里，也是代码审查项。


---

## 换装系统（v0.5，第一阶段＝架构）

三条铁律写在 `src/wardrobe.js` 头部注释里，UI 和 AI 都绕不过去：

1. **服装只是外观，不碰人格** —— wardrobe 不 import persona，也没有任何
   「按服装改语气」的钩子；测试用正则扫源码，一旦有人往衣服和性格之间接线就红。
2. **语言状态 ≠ 程序状态** —— 模型只能提交 `[wear:itemId]` 提案，真正穿上衣服的是
   `wardrobe.applyProposal()` 这次调用。一条回复里连发多个提案是合法的，按正文顺序
   逐条执行、逐条回报。成功/失败都生成 `[系统] 换装执行结果：…`
   写回历史，下一轮模型看到的是事实；幻觉 id 不剥离也不执行，它没法谎称换好了。
3. **槽位约束在 SLOTS 上，不在商品上** —— 身份约束统一写在 `SLOTS.required`，
   商品上绝不加 `locked`。v1.0 发型槽放开为自由可脱槽位（支持光头素体换装与无发衣物生成）；
   身份不变式改由**发色/脸型/眼睛/泪痣**承载，`SLOTS.required` 保留为通用槽位策略（当前无槽位使用）。
   发饰、外套等普通槽均可脱空。发型与发饰均可通过 `[wear:off_hair]` / `[wear:off_hairAccessory]`
   脱下。以前是从商品条目的 `locked` 反推的，两种失效方向都试过：
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
  文件名与 CATALOG 的 `file` 字段一致；**所有图层共用 64×80 像素画布锚点**，等比叠加即对齐。
  当前已包含 64×80 纯正像素图层，架构与测试按真图标准跑通。
- 降级：任何一张图层缺失 → 整套回退单图兜底皮套，桌宠绝不会变空白。
- 缓存：system **最末尾**挂【当前穿着】+【衣柜可用 itemId】两块，只在**真的换装那一刻**变化；
  平时逐字节稳定，不吃命中率。换装那次破缓存是诚实的代价——不然她只能凭想象回答自己穿了什么。
  这两块约 386 tok（估算已计入面板的「上下文」数字），衣柜越大越贵，但只贵一次前缀。
  顺序是硬要求：长期记忆必须在穿着块**之前**。前缀缓存从头开始比，谁在前面决定了
  换一次衣服要赔多少 —— 穿着块排在记忆里，换装就会把全部长期记忆和历史一起顶出缓存。
  这条由 `test/brain.test.js` 逐字钉住（v0.7.1 之前代码排反了，而注释和本文都写的"末尾"）。

面板：设置面板「衣柜」区，预设按钮 + 每槽单品 + 「脱下」（身份槽不提供）。
全部 textContent 渲染；被拒的搭配如实弹「这件穿不上：原因」，状态一字不动。


---

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


---

## 记忆规则（v0.4 起）

小结提示词按「正确第一」：只存用户明确说出的事实；纠正必须覆盖旧值；去重；
寒暄与一次性情绪不入长期记忆；称呼/偏好/项目/约定/用户点名要记的必须保。

记忆遵循 D-005「遗忘不删除历史」铁律：设置面板「我的记忆」只读展示，
淡出由 MemoryDynamics 依艾宾浩斯动力学自主演化进入休眠（DORMANT），严禁人工物理删除。


---

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
而渲染端遇 `declined` 时连那条空的「角色：」记录节点都摘掉 —— 这一轮真的当没发生过。

**主动搭话作为 synthetic 消息落入 history 保卫前缀缓存，但严格排除于主体经历证据之外。** 触发理由是程序生成的瞬时感知，不是用户原话。为了在下一轮完整复用「主动触发 + 模型回复」的 DeepSeek 前缀缓存块，主动搭话以 `{ synthetic: true, source: 'proactive' }` 写入 history；但在关窗小结与主体经历归档中，`isEligibleSubjectEvent()` 与 `cleanContentForSummary()` 会将其明确标记或剥离，严防程序提示伪装为用户发言或主体经历证据。

两处按语义写的判据值得记一下：`poke` **豁免**"刚互动过 90 秒内保持安静"这条闸门 ——
被戳本身就是"现在方便"的意思，第一版拿它挡连戳，把 poke 这条路整个饿死了；
拖拽收尾只报真有过位移的（`moved > 6`）才算"被拖了一下"，纯失焦收尾不算，
否则窗口一失焦就给她凭空记一笔。

浏览器预览模式（没接 key、没有 bridge）退回原来的本地随机文案：45 秒滴答 + 25% 概率
+ 不重复上一条，一条请求都不发。用户正在打字 / 上一条气泡还没收时两种模式都静默。


---

## 配置项

`src/config.js` 的 DEFAULTS，可被 userData 里的 `life-config.json` 覆盖：

```
model             deepseek-flash     ← 官方 API 模型名，不是 deepseek-v4.1-flash
windowTurns       100                每 100 轮关窗并小结
windowMaxTokens   30000              token 兜底
keepTailMessages  6                  关窗保留的原文条数
memoryCapTokens   12000              长期记忆预算，超了合并
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
- **热更新覆盖**：`price.*`、`model`、`baseURL`、`windowTurns`、`windowMaxTokens`、`keepTailMessages`、`memoryCapTokens`、`selfGrowthEnabled`、`selfLedgerMaxEntries`、`currentSelfTokenBudget`、`requestTimeoutMs`、`streamIdleTimeoutMs` 等均在每轮对话或面板读取时就地生效。
- **重构重建覆盖**：API Key 变更走独立生命周期与事务回滚流程。

热重载的挂点有两个：**每轮对话开头**（`Brain.refreshConfig()`）和
**打开设置/用量面板时**（`config-get`、`chat-report`）。只有前者会出现一种
很难解释的现象：改完 model 或价格，不发消息、直接开面板，看到的还是旧值，
像是热重载根本没生效。

`price` 的合并只到「哪一档」这一层：写了 `peak` 就整份换掉 `peak`，
所以一档里 `hit/miss/out` 三个字段要写全，漏掉的那个会按 0 计（少算钱）。


---

## 发展路线图与后续计划 (Roadmap)

Life 平台将持续围绕「桌面原生交互」、「通用数字生命架构」与「生态开放扩展」三大通用主线推进演化：

### 1. 桌面原生通用交互演化 (Desktop Interaction)
- 🎙️ **多模态流式语音交互 (TTS / STT)**：集成轻量级端侧或云端语音合成与流式语音输入，结合桌宠呼吸与动画状态机实现说话口型与音律共振。
- 🎭 **通用表情差分槽位 (Emotion Differential Layer)**：完善 `[state:emotion]` 渲染桥接，提供标准化的通用差分表情贴图规范（喜悦、思索、困倦、委屈等），支持社区为任意角色注入生动差分。
- 🧗 **真实桌面环境感知与避让 (Desktop Environment Sensing)**：在跨 Windows/macOS 平台接入真实桌面图标与活动窗口边界扫描适配器，为现有的 `desktop-motion.js` 注入物理障碍物，实现动态攀爬、贴窗悬挂与趣味避让。
- 📥 **拖拽投喂与剪贴板感知 (Drag-and-Drop Intake)**：支持将文件、文本片段或图片直接拖入桌宠窗口，触发即时理解、总结归纳与长程记忆沉淀。
- 🔍 **受控工具调用与搜索 (Controlled Tool Use)**：在安全预算与权限沙箱保护下，逐步拓展联网搜索与桌面轻量查询工具调用能力。

### 2. 通用数字生命实验平台演化 (Digital Life Architecture)
- 🌐 **多模型生态生产级接线 (Provider Fallback & Circuit Breaker)**：已由 v1.5-a 的 `src/fallback-adapter.js` 覆盖运行时主备双端点回落、熔断与流式防重播需求；P4 契约（`provider-routing.js` 与 `generation-attempt.js`）保留为架构储备，不计划启用（见上方 INT-01 处置声明）。当前支持主备双端点配置与故障自动降级（非多点网状转移）。
- 🧠 **本地轻量向量联想图谱 (Semantic Associative Memory)**：在现有的艾宾浩斯幂律遗忘动力学上，引入纯本地轻量向量检索（Embedding），实现对话过程中的潜意识记忆自由联想与被动线索激活。
- 🌙 **心智演化与睡眠整合看板 (Evolution Dashboard)**：提供直观的可视化面板，展现每日夜间睡眠整合、记忆突触修剪、特质向量演化轨迹与因果证据图谱。
- 🧭 **环境驱动自决意志网络 (Self-Intent Network)**：深化 `trigger.js` 的自发意图机制，在严格前缀缓存不变式与零虚构原则下，让桌面生命基于系统活动与闲置节律自发产生有据可查的探索提案。

### 3. 生态工具与分发工程 (Ecosystem & Distribution)
- 📦 **社区角色与皮肤资产包规范 (`.lifepack`)**：制定统一的角色资产包格式，支持用户一键打包、分享和导入自定义角色立绘、衣柜组件与人设配置文件。
- 🚀 **开机静默驻留与多平台便携打包**：完善 Windows / macOS 便携版（Portable Zip）构建流程与安装包自动构建，提供开机静默托盘自启动管理。


---
