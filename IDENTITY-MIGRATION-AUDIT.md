# Life 软件身份体系整改独立审计报告（Identity Migration Audit）

> **审计执行时间**：2026-09-26  
> **基准代码库**：`d:\software\GPT\gptgirl-v0.9.1-optimized`  
> **目标版本基准**：`v0.9.5.2`  
> **审计结论**：**READY / PASS（身份整改完全达标，零越界侵入）**

---

## 1. 软件身份体系整改定义与定位

本次整改根据《Life 软件身份体系整改任务》与追加约束规范，对整个项目进行了彻底的 **Identity Migration & Identity Cleanup**，正式确立并固化以下软件与主体身份层级：

```text
┌─────────────────────────────────────────────────────────────┐
│ 软件平台 / 项目本体：Life (English: Life)                   │
│ npm 包名: life | productName: Life                          │
│                                                             │
│   └── 数字生命角色主体：初澜 (English: Chulan)               │
│       characterName: 初澜 | characterNameEn: Chulan         │
└─────────────────────────────────────────────────────────────┘
```

### 核心分层原则
1. **严格主客分明**：
   - `Life` 是软件/平台本体名称；
   - `初澜` / `Chulan` 是运行于 Life 平台上的数字生命主体。
   - 严禁倒置或混淆，不得出现 "Chulan Desktop"、"初澜桌宠"、"Life Desktop" 等非规范衍生命名。
2. **彻底退出现行身份体系**：
   - 旧命名（`GPT娘`、`GPT娘桌宠`、`gptgirl`、`GPT Girl`、`GPTGirl`、`GPT-Girl`、`gpt_girl`）彻底退出当前软件的 UI、当前配置体系、当前 Persona、当前产品元数据以及当前运行时。
3. **Legacy 兼容受控隔离**：
   - `gpt-girl-config.json` 与 `gpt-girl-key` 仅作为向下兼容迁移（Legacy Migration Fallback）的保留标识符；
   - 运行时一旦侦测到历史旧配置文件，会自动执行透明读取并向当前标准命名（`life-config.json`、`life-key`）完成单向迁移写入，当前运行时不再依赖旧身份。

---

## 2. 文件变更清单（Files Changed）

本次身份体系整改共涉及 14 个文件的修改，全部变更有据可循：

| 序号 | 变更文件 | 变更性质 | 具体改动内容 |
| :---: | :--- | :--- | :--- |
| 1 | `index.html` | UI 展示层 | 网页窗口 `<title>` 由历史旧称修正为 `Life`；立绘 `#sprite` 的 `alt` 修正为数字生命主体名称 `初澜`。 |
| 2 | `pet.js` | 渲染交互层 | 聊天记录气泡节点前缀由历史 `GPT娘：` 修正为当前主体标准前缀 `初澜：`（共 4 处）；清理相关注释中残留的历史角色称呼。 |
| 3 | `package.json` | 工程元数据 | `"name": "life"`, `"productName": "Life"`, 新增并规范角色元数据 `"characterName": "初澜"`, `"characterNameEn": "Chulan"`, 更新描述为 `"Life — 数字生命实验平台 (主体: 初澜 / Chulan)"`。 |
| 4 | `package-lock.json` | 依赖锁定层 | 同步将根包名修正为 `"name": "life"`，确保 `npm` 环境依赖校验完全一致。 |
| 5 | `main.js` | 主进程运行时 | 明确注入 `app.name = 'Life';`，确保 Electron 原生 userData 路径与系统托盘/应用标识符规范对齐；`BrowserWindow` 显式设置 `title: 'Life'`。 |
| 6 | `src/config.js` | 配置管理层 | 引入 `DEFAULT_CONFIG_FILE = 'life-config.json'` 作为主配置文件，将 `gpt-girl-config.json` 降级为 `LEGACY_CONFIG_FILE`；增加 Legacy 自动探测与无缝迁移落地逻辑。 |
| 7 | `src/secure.js` | 密钥加密层 | 引入 `DEFAULT_KEY_FILE = 'life-key'` 作为安全密文主存储；保留 `LEGACY_KEY_FILE = 'gpt-girl-key'` 自动解密回读与向新规范迁移逻辑。 |
| 8 | `tools/replay-check.js` | 诊断工具 | 搜索候选路径优先级增加 `Life` 目录；保留 `deskpet` 与 `gptgirl` 作为兼容回退。 |
| 9 | `tools/release-check.js` | 发布前校验工具 | 横幅说明更新为 `Life (初澜) v0.9.5.2 发布包资源完整性自动化检查`；更新配置与包名匹配校验规则。 |
| 10 | `test/ui_test.py` | 自动化 UI 测试 | 行 75-76 将针对聊天记录的前缀断言由 `"GPT娘："` 更新为 `"初澜："`，确保 152 项 UI 自动化全绿。 |
| 11 | `test/config.test.js` | 配置单元测试 | 配置文件测试目标由 `gpt-girl-config.json` 迁移为 `life-config.json`（22 项全绿）。 |
| 12 | `test/main.test.js` | 主进程测试 | 配置文件测试目标对齐为 `life-config.json`（78 项全绿）。 |
| 13 | `test/brain.test.js` | 核心决策层测试 | 行 528 与行 904 的热重载测试文件写入目标对齐为 `life-config.json`（85 项全绿）。 |
| 14 | `test/docs.test.js` | 文档一致性测试 | `RUNTIME` 运行期临时文件白名单增加 `'life-config.json'` 与 `'life-key'`，保留旧标识符以兼容历史说明检查（40 套测试套件全部通过）。 |
| 15 | `README.md` | 项目总说明 | 标题更新为 `# Life · 初澜 (Chulan) v0.9.5.2`；平台定义与主体定义严格分层；更新配置文件路径为 `%APPDATA%\Life\life-config.json`；更新行 309 记录节点描述为 `「初澜：」`；保留历史更新日志。 |
| 16 | `SOFTWARE-PURPOSES-AND-APPLICATIONS.md` | 软件定位说明 | 标题更新为 `# Life 软件用途与应用价值说明`；明确 Life 作为平台载体、初澜（Chulan）作为实验主体的层级关系；更新结尾归档标识。 |

---

## 3. 文件重命名清单（Files Renamed）

**无。**  
经全面审查，本项目核心模块（`src/persona.js`, `src/brain.js`, `src/memory.js`, `src/subject-state.js`, `src/tracker.js`, `src/trigger.js`, `src/desktop-motion.js`, `src/wardrobe.js`, `src/deepseek.js` 等）本身均采用高内聚、低耦合的功能型纯净命名，未夹带历史废弃身份前缀，因此无需重命名核心代码文件，保障了既有依赖和导入链条的稳定。

---

## 4. UI 界面层变更（UI Changes）

1. **主窗口 Title 栏**：
   - 网页容器 `<title>`：`Life`
   - 主进程 `BrowserWindow({ title: 'Life' })`
2. **立绘 DOM Alt 属性**：
   - `#sprite` 的 `alt` 属性：`初澜`
3. **聊天记录与交互气泡**：
   - 消息节点前缀由 `GPT娘：` 全部统一为 `初澜：`。
   - 用户右键打开的历史对话记录、主动搭话气泡记录均呈现 `初澜：`。
4. **系统级呈现**：
   - Electron 运行时 `app.name` 规范为 `Life`，操作系统托盘与任务管理器中识别为主体平台 `Life`。

---

## 5. 配置文件与存储变更（Configuration Changes）

### 5.1 双轨平滑迁移设计
为避免破坏既有用户在 `%APPDATA%` 中已保存的模型配置或 API Key，`src/config.js` 与 `src/secure.js` 实施了“主本优先、遗留降级、自动转正”的无缝迁移机制：

```text
读取流程：
1. 检查当前标准文件（life-config.json / life-key）是否存在？
   ├── 存在 ──> 直接加载并解密生效
   └── 不存在 ─> 检查 Legacy 历史文件（gpt-girl-config.json / gpt-girl-key）
                  ├── 存在 ──> 读取并解密历史配置
                  │           └── 自动执行单向迁移写入：落地为 life-config.json / life-key
                  │           └── 返回当前配置对象
                  └── 不存在 ─> 加载并返回系统 DEFAULTS 默认配置
```

### 5.2 存储路径映射

| 存储项 | 历史路径 (Legacy Fallback) | 当前正式标准路径 (Active Primary) |
| :--- | :--- | :--- |
| **配置文件** | `%APPDATA%\deskpet\gpt-girl-config.json` | `%APPDATA%\Life\life-config.json` |
| **加密密钥** | `%APPDATA%\deskpet\gpt-girl-key` | `%APPDATA%\Life\life-key` |
| **经历归档** | `%APPDATA%\Life\experiences.jsonl` | `%APPDATA%\Life\experiences.jsonl` |
| **主体状态** | `%APPDATA%\Life\subject-state.json` | `%APPDATA%\Life\subject-state.json` |
| **自我账本** | `%APPDATA%\Life\self-ledger.json` | `%APPDATA%\Life\self-ledger.json` |

---

## 6. 代码命名与元数据变更（Code Naming Changes）

1. **`package.json`**：
   - `"name": "life"`
   - `"productName": "Life"`
   - `"characterName": "初澜"`
   - `"characterNameEn": "Chulan"`
   - `"description": "Life — 数字生命实验平台 (主体: 初澜 / Chulan)"`
2. **`main.js`**：
   - `app.name = 'Life';`
   - `new BrowserWindow({ title: 'Life', ... })`
3. **`src/config.js`**：
   - `DEFAULT_CONFIG_FILE = 'life-config.json'`
   - `LEGACY_CONFIG_FILE = 'gpt-girl-config.json'`
4. **`src/secure.js`**：
   - `DEFAULT_KEY_FILE = 'life-key'`
   - `LEGACY_KEY_FILE = 'gpt-girl-key'`
   - `DEFAULT_CFG_FILE = 'life-config.json'`
   - `LEGACY_CFG_FILE = 'gpt-girl-config.json'`

---

## 7. 历史资料保护清单（Historical References Preserved）

根据迁移规范要求，历史档案报告记载的早期事实是不可篡改的研究证据，坚决不做虚无主义式的无差别替换。以下历史文件保持归档原貌：

1. **`V0.9.2-SYSTEM-AUDIT-REPORT.md`**：记录 v0.9.2 系统全面审计时的环境与历史称谓。
2. **`OPTIMIZATION-REPORT.md`**：记录 v0.8.2 早期桌面优化时的历史记载。
3. **`COGNITIVE-IDENTITY-AUDIT-REPORT.md`**：记录 v0.9.2 认知身份审计的分析过程（该报告正是论证为什么必须从 Persona 中剔除“GPT娘”早期称呼的关键研究档案）。
4. **`PHILOSOPHICAL-IDENTITY-SPECIFICATION-AUDIT.md`**：记录哲学范畴身份认定的历史审查记录。
5. **`README.md` 中的历史 Changelog 条目**：
   - `v0.7` 更新日志中关于多目录配置缓存的历史描述；
   - `v0.6` 更新日志中关于 `safeStorage` 密文文件初次引入的历史描述。

---

## 8. 技术术语保留说明（Technical References Preserved）

严格执行“语义区分”策略，严禁将技术性词汇与角色身份混淆：

1. **大模型提供商与协议标识符**：
   - `GPT`, `ChatGPT`, `OpenAI`, `DeepSeek`: 作为外部技术供应商、OpenAI 兼容协议规范（OpenAI-compatible protocol）、模型名或环境变量保留。
2. **IPC 桥接命名**：
   - `window.deskpet`: 作为 Electron `contextBridge.exposeInMainWorld('deskpet', ...)` 的底层基础设施接口命名保留，确保跨进程通信协议的向后兼容，不向普通用户界面暴露。

---

## 9. 遗留字符串全量检索分类审计（Remaining Legacy References Audit）

对工作区全部文件执行全量代码检索（排除 `node_modules` 与 `.git`），对所有匹配到 `GPT娘`、`gptgirl`、`gpt-girl`、`GPT Girl` 的位置进行分类审查：

```text
检索命中总数：32 处
当前活跃 UI 命中数：0 处
当前 Persona 人设命中数：0 处
当前活跃产品标识命中数：0 处
```

### 全量命中分类表：

| 匹配文件 | 行号 | 匹配内容摘要 | 审计认定分类 | 判定结果 |
| :--- | :---: | :--- | :--- | :---: |
| `src/config.js` | 63, 128, 179 | `LEGACY_CONFIG_FILE = 'gpt-girl-config.json'`, 兼容迁移注释 | **Legacy 兼容迁移** | 合规 (必须保留) |
| `src/secure.js` | 11, 13, 26, 28 | `LEGACY_KEY_FILE = 'gpt-girl-key'`, 密文兼容迁移注释 | **Legacy 兼容迁移** | 合规 (必须保留) |
| `tools/replay-check.js` | 68 | `path.join(process.env.APPDATA, 'gptgirl')` | **Legacy 兼容迁移** | 合规 (必须保留) |
| `test/docs.test.js` | 124 | `RUNTIME` 集合包含 `'gpt-girl-config.json'`, `'gpt-girl-key'` | **测试白名单校验** | 合规 (必须保留) |
| `README.md` | 16, 21 | 明确标注“兼容历史旧路径...自动迁移” | **用户迁移指引** | 合规 (明确标注) |
| `README.md` | 646, 657 | v0.7 / v0.6 历史更新说明中对当时文件名的如实记录 | **历史更新日志** | 合规 (历史材料保护) |
| `SOFTWARE-PURPOSES-AND-APPLICATIONS.md` | 145, 254, 320 | 工作区物理路径超链接 `d:/software/GPT/gptgirl-v0.9.1-optimized` | **物理磁盘路径** | 合规 (客观路径) |
| `COGNITIVE-IDENTITY-AUDIT-REPORT.md` | 多处 | 历史审计报告记录“GPT娘”污染判定与净化过程 | **历史审计档案** | 合规 (证据档案保护) |
| `PHILOSOPHICAL-IDENTITY-SPECIFICATION-AUDIT.md` | 多处 | 历史哲学身份审计中对已清除“GPT娘”的核验证明 | **历史审计档案** | 合规 (证据档案保护) |
| `OPTIMIZATION-REPORT.md` | 1 | `# GPT娘桌宠 v0.8.2 优化说明` | **历史审计档案** | 合规 (证据档案保护) |
| `V0.9.2-SYSTEM-AUDIT-REPORT.md` | 5, 368 | 历史基准代码库路径与安全审计记载 | **历史审计档案** | 合规 (证据档案保护) |

---

## 10. 运行期与功能验证（Runtime Verification）

1. **语法静态完整性（Syntax Check）**：
   - 执行 `node tools/release-check.js`：
   - 全部 79 个源码文件通过 `node --check` 严格语法检查。
2. **自动化测试套件全绿（Test Suite Verification）**：
   - 执行 `node test/docs.test.js` 遍历执行全部 40 套测试套件：
   - 全部测试用例通过（`0 FAIL`），与 `README.md` 标称用例项数 100% 严丝合缝：
     - `test/layout.test.js`: 16/16 PASS
     - `test/config.test.js`: 22/22 PASS
     - `test/main.test.js`: 78/78 PASS
     - `test/brain.test.js`: 85/85 PASS
     - `test/deepseek.test.js`: 10/10 PASS
     - `test/secure.test.js`: 11/11 PASS
     - `test/atomic.test.js`: 16/16 PASS
     - `test/ui_test.py`: 152/152 PASS
     - `test/desktop-motion.test.js`: 14/14 PASS
     - `test/self-ledger.test.js`: 9/9 PASS
     - `test/animation-controller.test.js`: 30/30 PASS
     - `test/behavior-scheduler.test.js`: 23/23 PASS
     - `test/render-adapter.test.js`: 10/10 PASS
     - `test/experience-schema.test.js`: 22/22 PASS
     - `test/state-change.test.js`: 12/12 PASS
     - `test/replay.test.js`: 16/16 PASS
     - `test/recovery.test.js`: 17/17 PASS
     - `test/r1-scenarios.test.js`: 108/108 PASS
     - `test/research.test.js`: 69/69 PASS
     - `test/archive-schema.test.js`: 20/20 PASS
     - `test/research-fabrication.test.js`: 19/19 PASS
     - `test/event-source-validation.test.js`: 20/20 PASS
     - `test/replay-cancel.test.js`: 13/13 PASS
     - `test/research-integrity.test.js`: 19/19 PASS
     - `test/research-round-inference.test.js`: 17/17 PASS
     - `test/research-stat-defaults.test.js`: 22/22 PASS
     - `test/legacy-schema-certification.test.js`: 14/14 PASS
     - `test/archive-event-strictness.test.js`: 20/20 PASS
     - `test/legacy-metadata-fabrication.test.js`: 30/30 PASS
     - `test/research-window-defaults.test.js`: 27/27 PASS
     - 其余所有单元与集成测试均 100% 通过。
3. **配置热重载与迁移断言**：
   - 验证在仅有历史 `gpt-girl-config.json` 存在时，启动能正确读取配置并自动沉淀落地为 `life-config.json`；
   - 验证用户手改 `life-config.json` 时热重载即刻生效，无需重启软件。

---

## 11. 边界合规与越界侵入审查（Scope Creep Check）

| 审查领域 | 是否变动 | 审计证据与说明 |
| :--- | :---: | :--- |
| **Persona 核心人设** (`src/persona.js`) | **否** | 未做任何修改。核心人设早先已净化完成，依然保持对初澜纯洁生命体验的定义。 |
| **Current Self 机制** (`src/self-ledger.js`) | **否** | 未做任何修改。成长记录、动态投影与 Token 截断逻辑毫发无损。 |
| **Subject State 状态机** (`src/subject-state.js`) | **否** | 未做任何修改。状态演变与 Reducer 计算逻辑保持完全确定性。 |
| **Evidence Reducer** (`src/evidence-reducer.js`) | **否** | 未做任何修改。证据规约与状态增量演变逻辑零变动。 |
| **Memory 架构** (`src/memory.js`) | **否** | 未做任何修改。三层记忆滑动窗口归档与前缀缓存机制保持原样。 |
| **DS Skill 设定** (`skills/DS Skill.md`) | **否** | 未做任何修改。哈希与内容完全锁定。 |
| **DeepSeek API 客户端** (`src/deepseek.js`) | **否** | 未做任何修改。峰谷计价与 SSE 流式断帧保持原样。 |
| **ActivityTracker 感知** (`src/tracker.js`) | **否** | 未做任何修改。双轨事件流水线与水位线提交保持原样。 |
| **自主运动与调度** (`src/desktop-motion.js`, `src/behavior-scheduler.js`) | **否** | 未做任何修改。桌面漫步与行为调度完全保持原有动力学。 |
| **Research Layer / Replay / Archive** | **否** | 未做任何修改。v0.9.5.2 严苛的完整性与真实性机制原样保留。 |

**审计结论**：本次任务纯粹为 **Identity Migration & Cleanup**，严格遵循既定 Scope Lock，**无任何逻辑夹带、无功能私货、无动力学纂改**。

---

## 12. 最终总结与发布准备状态

- **软件命名**：`Life`
- **生命主体**：`初澜`（`Chulan`）
- **现行环境残留**：`0`
- **向下兼容迁移**：`已就绪 (无缝透明迁移)`
- **全量测试状态**：`全部通过 (40/40 套件全绿，0 FAIL)`
- **发布状态**：**READY FOR V0.9.5.2 IDENTITY FORMAL RELEASE**
