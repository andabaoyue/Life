# 发布账本（Release Ledger）

> **性质**：每次公开版本发布的**事实档案**。只记录已发生的事实，不写计划。
> **为什么要有这个文件**：2026-10-28 查历史时发现，v1.6.0 的安装包是坏的（代码修了但包没重打）、
> v1.1.1 有 tag 却没建 Release —— 这些全靠翻网页推断，太费劲且容易错。有账本就不用猜。
> **纪律**：发布后**立即**补记，不要事后追忆；SHA-256 必须来自 GitHub 资产 digest（或本地实测），
> 不得复制粘贴未经核对的值。

---

## 发布仓库

| 角色 | 地址 | 说明 |
|---|---|---|
| **公库（对外）** | `https://github.com/andabaoyue/Life.git` | 剥离后的可运行仓库，独立历史 |
| 私库（内部） | `https://github.com/andabaoyue/Life-Chulan.git` | 完整开发历史 |

> ⚠️ 两个仓库**无共同祖先**（公库根提交 `141533b`，私库根提交 `1e93185`）。
> 公库同步方式：`public-export --out` 物化 → 在公库 worktree 提交 → **普通 push（不 force）**。
> 只要提交的父节点是公库当前 HEAD，就是 fast-forward。

---

## v1.8.0 · 2026-10-28

| 项 | 值 |
|---|---|
| 版本 | **1.8.0** |
| 代号 | 《看见与重逢》 |
| 公库 tag | `v1.8.0`（lightweight） |
| 公库提交 | **`fb2b3ce`** |
| 私库提交 | `d699f79` |
| Release | https://github.com/andabaoyue/Life/releases/tag/v1.8.0 |
| 公库提交总数 | 58（未 force，原有 56 条全部保留） |
| 公开集文件数 | **326**（上次同步 299） |

### 交付物

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `Life-1.8.0-Setup.exe` | 100,856,192 | `212436bad05266aaf0082a4bc0d1e967646ee7b5095dc0ba16f3cfe60845b8ac` |
| `Life-1.8.0-win-x64-portable.exe` | 100,616,465 | `2e5b24cf128fc187b5ec7a0c2b4107b4698f35909bdc4abf1876a79174f885b0` |
| `Life-1.8.0-win-x64.zip` | 153,692,397 | `ed979f46b6936d6b98ff41349710c4b50e1031644257aae08c5abe176b267cb4` |

> ✅ 三个 digest 由 GitHub 在接收时计算，与本地 `Get-FileHash -Algorithm SHA256` 逐一核对一致
> —— 说明上传未损坏。

> 📌 **为什么只有 3 个资产**（历史版本是 5 个）：
> v1.6.0 / v1.6.1 还上传了 `Life-X.Y.Z-Setup.exe.blockmap` 与 `latest.yml`。
> 这两个是 **electron-builder 为自动更新生成的副产物**，只在启用自动更新时才有用。
> 本仓库实测：`electron-builder.yml` **没有 `publish` 配置**，`package.json` **没有
> `electron-updater` 依赖**，全仓 grep `autoUpdater` / `checkForUpdates` **零引用**
> —— 也就是说，用户拿到 `.blockmap` 和 `latest.yml` 也**没有任何代码会去读它们**。
> 故 v1.8.0 刻意只传 3 个包。历史版本带它们是遗留，不是规范。

### 主要内容

**四项新能力**：语音输入（STT）、个体观测面板、重逢心境、屏幕视觉探针。

**关键修复**：视觉事实行错位一轮（本版审核发现）、框选窗 IPC 权限过宽（本版审核发现）、
CSV 导出公式注入、STT 配置写失败静默、对话窗输入栏遮挡。

**门禁**：135 个套件 / 4849 项断言全绿；新增产物新鲜度门禁与公开发布剥离门禁。

### 已知限制（随 Release 公开）

- v1.7 未单独发布，内容并入本版
- 观测面板 16 项数值正确性未逐项核对
- 重逢心境只验证 1–7 天档；6–24h 与 ≥7d 无真机样本
- STT 需单独配置 Key（DeepSeek 无 STT 端点）
- 视觉探针仅支持 `deepseek-flash` 系
- 框选窗权限收窄只在单元层验证，Electron 实机集成未跑通

---

## 历史版本（补记，供对照）

> 以下为 2026-10-28 从 GitHub API 回溯补录。**当时未记账**，故只记可核实的事实。

### v1.6.1 · 2026-10-19

| 项 | 值 |
|---|---|
| 公库 tag | `v1.6.1`（**annotated**，tag 对象 `00db85f` → 提交 `6aa9085`） |
| Release | ✅ 已建 |
| 备注 | 「为什么单独发一版」：v1.6.0 的包构建于 10-18，而修复是 10-19 才落的，两者 `app.asar` 逐文件比对全部不一致 |

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `Life-1.6.1-Setup.exe` | 100,816,796 | `a0999fcd9bba1df922fee5534e5aacebe68da27de07697e22e016e4586b922d5` |
| `Life-1.6.1-win-x64-portable.exe` | 100,577,170 | `ff411d2c3e06ca6cd3934939caa593f6779351c60e1b4bf299f424e501e92387` |
| `Life-1.6.1-win-x64.zip` | 153,639,457 | `8bf9adf0aa248f0afe4f345fc170a6966d7be5340b4c713987dee994ed54e11c` |

### v1.6.0 · 2026-10-18

| 项 | 值 |
|---|---|
| 公库 tag | `v1.6.0`（lightweight）→ `8dfe463` |
| Release | ✅ 已建 |
| 🔴 **已知问题** | **该版本的安装包不含 10-19 的修复**（打包早于修复），实际内容等同缺陷态。用户若下载 v1.6.0 会遇到已知 bug —— **这是历史事实，不修改、不隐藏** |

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `Life-1.6.0-Setup.exe` | 100,812,530 | `efa849e0b4874f0bf47a10dbda574c4ba844a4d32586f340d6cd46ada0cc1895` |
| `Life-1.6.0-win-x64-portable.exe` | 100,572,901 | `b347c2e839f7eecef2def2ca11396c432e9b3332fc231d6b9024a68359b59c69` |
| `Life-1.6.0-win-x64.zip` | 153,632,230 | `b4b45b28f7edc1524ccc7f2e817f9ed6277afed5eabdcfb978e9e93abc70ea91` |

### v1.1.1 · 2026-10-13

| 项 | 值 |
|---|---|
| 公库 tag | `v1.1.1`（lightweight）→ `f527bbc` |
| Release | 🔴 **未建**（有 tag 无 Release） |
| 处置 | 用户 2026-10-28 明确：**不补建**。记录在此以免日后又被当成遗漏 |

### v1.0.0 · 2026-10-07

| 项 | 值 |
|---|---|
| 公库 tag | `v1.0.0`（lightweight）→ `fad7907` |
| Release | ✅ 已建（首个公开版本） |

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `Life-1.0.0-Setup.exe` | 100,796,929 | `24a03562b9b2f277a106f04961cb653c67d27e15b263ebacd65b805caa4a34f1` |
| `Life-1.0.0-win-x64-portable.exe` | 100,557,298 | `e63d04a68750b7e091bffb7f5f5e9c6e462ea4416ad4fb43458cf4e857e42cd1` |
| `Life-1.0.0-win-x64.zip` | 153,610,209 | `77ce41bc39006e5ee1589c2eb1b7e270644dbf509c40daf65d7e07e2bb03d118` |

---

## 发布流程（下次照做）

> ⚠️ 这份文档会随公开库发布（`docs/**` 在 `public-export` 白名单内），而剥离门禁禁止开发机
> 绝对路径。所以下面的公库路径一律写成 `<公库工作树>` 占位，不写盘符——本机实际是与私库
> 同级的 `LIFE-public`，换台机器只是填不同的目录，流程不变。
>
> 🔴 教训（2026-10-29）：这段原本写的是真实盘符路径，`release-check` 与 `public-export.test`
> 因此**双双变红**——账本写好一周后才发现，账本自己成了发布门禁的拦路虎。

```bash
# ── 阶段 1：版本收口（私库）
# 1. package.json / package-lock.json（🔴 lock 只改根包两处，别动依赖自身的版本）
# 2. README.md 首行（v1.8.0 起中英合成一份，README.en.md 已删除）
# 3. CHANGELOG.md 补 [X.Y.Z]，按功能线归纳，不逐笔列提交
# 4. 校验：node tools/release-check.js 应 0 FAIL

# ── 阶段 2：构建与验证
npm run build:win
node test/docs.test.js          # 全绿
node tools/release-check.js     # 0 FAIL
node test/artifact-freshness.test.js  # stale=[] missing=[]

# ── 阶段 3：物化公库并验证（不碰远端）
node tools/public-export.js --sync <公库工作树>          # 先预演
node tools/public-export.js --sync <公库工作树> --yes    # 再执行
cd <公库工作树> && node test/docs.test.js                # 公库形态必须全绿

# ── 阶段 4：提交与推送
git -C <公库工作树> add -A
git -C <公库工作树> commit -m "feat(release): 同步私库 vX.Y.Z —— ..."
git -C <公库工作树> log --oneline -2   # 🔴 确认父节点是上一次的 HEAD
git push public public-main:main              # 普通 push，不 force
git tag vX.Y.Z <提交号> && git push public vX.Y.Z

# ── 阶段 5：Release
gh release create vX.Y.Z --repo andabaoyue/Life --title "..." --notes-file <正文>
gh release upload vX.Y.Z <三个包> --repo andabaoyue/Life
# 核对：gh release view vX.Y.Z --json assets  ← digest 必须与本地实测一致

# ── 阶段 6：记账
# 回填本文件：提交号、SHA-256、已知限制
```

### 踩过的坑（会重犯，先记住）

| 坑 | 后果 | 正确做法 |
|---|---|---|
| `package-lock.json` 全局替换版本号 | 会改坏 sax 等依赖自身的 version 与 resolved URL，`npm ci` 失败 | **只改根包两处**（文件开头 `version` 与 `packages[""].version`） |
| 物化树 `git init` 后直接跑测试 | `public-export.test.js` 依赖 `git ls-files`，报「not a git repository」假失败 | 必须先 `git add` 让仓库有内容，或用 worktree |
| tag 打好后忘了移 | 补记 CHANGELOG 之后再建 Release，tag 落后一个提交，Release 页面显示旧 CHANGELOG | 建 Release 前核对 `git ls-remote --tags` 与 HEAD 是否同一提交 |
| 改版本号但 README 安装包名没改 | Release 说明与 README 对不上，用户找不到文件 | 搜 `Life-\d+\.\d+\.\d+-` 全量核对 |
| 写测试数字靠记忆 | CHANGELOG 一处写 4622+（实际 4837），对外文档失真 | 从 README 声明加总（`docs.test.js` 已逐个核对过），不要凭印象 |
| 账本只记 3 个包，历史有 5 个 | 后人误以为 v1.8.0 漏传了 blockmap / latest.yml | 先确认 `electron-builder.yml` 有无 `publish` 配置；没有就是不需要（本仓库确实没有） |

---

**Status: 账本建立于 2026-10-28（v1.8.0 发布当日）。历史版本为回溯补录，只记可核实事实。**
