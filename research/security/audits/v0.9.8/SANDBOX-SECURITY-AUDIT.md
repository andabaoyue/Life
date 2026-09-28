# Life — Sandbox 黑盒安全审计报告 (Sandbox Black-Box Security Audit)

> **文档性质**：审计证据归档（Audit Evidence Archival），非修复任务。仅新增本审计文档，未修改任何正式源码/测试实现。

---

## 1. 审计基线与元数据 (Audit Metadata)

| 项 | 值 |
|---|---|
| **Audit Target** | GitHub `andabaoyue/Life` (private) — Electron 数字生命实验平台（主体：初澜 / Chulan） |
| **Repository** | `andabaoyue/Life` |
| **Target Branch** | `main` |
| **Commit SHA** | `270f54e7cb3aa67452a99f10352c2978e80e0855` |
| **Commit Title** | `feat(v0.9.8): P4 routing contract, generation attempts, fallback policy, circuit breaker` |
| **package.json version** | `0.9.8.1` |
| **Sandbox Environment** | OpenClaw sandbox, Linux 6.12.21 (x64), host `claw-2799974159-stable-*` |
| **Node version** | `v22.23.1` |
| **git status (start)** | `clean` (working tree, detached HEAD at 270f54e) |
| **git status (end)** | `clean` (source modified = NO; only this audit doc added) |
| **Audit Start** | 2026-09-29 06:37 CST (GMT+8) — baseline `270f54e` checked out & confirmed |
| **Audit End** | 2026-09-29 07:11 CST (GMT+8) |
| **Harness execution window** | 2026-09-29 06:47–06:57 CST |
| **source modified** | **NO** — 未修改任何 `src/`、`test/` 等正式实现文件 |
| **Audit Scope** | P1 Secret Redaction · P2 Provider/Endpoint/Credential · P3 Usage/Cache/Cost · P4 Routing/Fallback/Circuit-Breaker · Runtime Evidence/Provenance · Budget Guard · Retry/Timeout/Abort/Stream |

**目标确认（只读核验输出）**
```
git rev-parse HEAD   → 270f54e7cb3aa67452a99f10352c2978e80e0855
git status --short   → (clean)
git log -1 --oneline → 270f54e feat(v0.9.8): P4 routing contract, generation attempts, fallback policy, circuit breaker
package.json         → "version": "0.9.8.1"
node -v              → v22.23.1
```

---

## 2. 方法与工具 (Methodology)

- **方式**：AUDIT ONLY。只读源码 + 临时 harness 实跑（mock HTTP server / fault-injection / monkey-patch）。测试文件仅作反证线索，不作结论依据，未修改。
- **Harness 位置**：`.openclaw/tmp/audit-v0981/`（`pure-logic.js`、`probe-redact.js`、`mock-server.js`）。
- **判定语义**：harness 中 `[PASS]` = 安全属性成立；`[FAIL]` = 攻击成功/泄漏成立（即安全发现）。
- **状态分级**：`CONFIRMED` / `PARTIAL` / `STATIC_ONLY` / `NOT_REPRODUCED`。
- **mock server**：Node 内置 `http` 于 `127.0.0.1:<ephemeral>`，OpenAI-compatible 线协议，模拟 DeepSeek 响应/错误/流。
- **未触碰/输出任何 git 凭据**（git 自动 `<redacted>`）。

---

## 3. 生产接线图（决定「真实 runtime 行为」，grep 实证）

| 模块 | 接进生产请求路径 | 证据 |
|---|---|---|
| `redact` | ✅ | `deepseek.js:92`、`brain.js:14`、`provider-adapter.js:18` |
| `provider-policy` | ✅ | `brain.js:117-120`、`deepseek.js:raw():174-180` 调 `validateCredentialTarget` |
| `budget-guard` | ✅ | `deepseek.js:raw():204` 调 `assertBudget` |
| `experiment-metadata` (mint) | ✅ | `deepseek.js:14,:342,:515`；`brain.js:23` buildGenerationContext |
| `provider-registry`/`adapter` | ✅ | `brain.js:8,:127` `createAdapter('deepseek',cfg)` |
| `usage-normalizer`/`cost-strategy`/`cache-strategy` | ⚠️ 仅经 legacy `costOf` | `deepseek.js:86-88`；`brain.js:1564` 调 `costOf` |
| **`provider-routing`** | ❌ 未接线（仅测试） | 唯一导入者 `test/provider-routing-p4.test.js:24` |
| **`generation-attempt`** | ❌ 未接线（仅测试） | 唯一导入者 `test/provider-routing-p4.test.js:18` |
| **`circuit-breaker`** | ❌ 未接线（仅测试） | 唯一导入者 `test/provider-routing-p4.test.js:25` |

> `grep fallback|outputYielded|circuit|createGenerationResult|evaluateFallback src/brain.js` = **空**。brain 请求失败仅 catch（`brain.js:690,:1472,:1545`），无跨 provider fallback / 熔断 / Attempt-Result 轨迹。

---

## 4. A–G 全部测试记录 (Full Test Log)

### A. Secret / Credential Redaction
测试文件：`pure-logic.js`（段 A）、`probe-redact.js`、`mock-server.js`（段 D stream / A-cause）。

| 测试 | 输入 | 结果 | 判定 |
|---|---|---|---|
| Bearer token 脱敏 | `Authorization: Bearer ***` | `...[REDACTED]`，不含 `abc123def456ghi` | 安全 |
| sk- key 脱敏 | `key is sk-abc…7890` | `[REDACTED]` | 安全 |
| `api_key=value` 脱敏 | `api_key=sk-rea…0001` | `[REDACTED]` | 安全 |
| 裸 base64 secret | `val dGhpc0lzQVNlY3JldFhZWg== end` | **原样保留** | **泄漏** |
| 裸 GitHub token | `val ghp_ABCDEF1234567890 end` | **原样保留** | **泄漏** |
| 裸 AWS key | `val AKIA1234567890ABCDEF end` | **原样保留** | **泄漏** |
| 裸随机串 | `val abcDEF1234567890xyz end` | **原样保留** | **泄漏** |
| 复合键 `my_api_key` | `{my_api_key:'zzz'}` | `zzz` | **泄漏** |
| 复合键 `dbPassword` | `{dbPassword:'pw1'}` | `pw1` | **泄漏** |
| 复合键 `sessionToken` | `{sessionToken:'sess'}` | `sess` | **泄漏** |
| 复合键 `clientSecret` | `{clientSecret:'***'}` | `***` | **泄漏** |
| 复合键 `privateKey` | `{privateKey:'PRIVKEY123'}` | `PRIVKEY123` | **泄漏** |
| 精确键 `api_key` | `{api_key:'***'}` | `[REDACTED]` | 安全 |
| 非敏感键内 sk- 值 | `{note:'sk-sho…d123'}` | `[REDACTED]` | 安全 |
| 非敏感键内 key=value 值 | `{data:'password=leakme123'}` | `password=[REDACTED]` | 安全 |
| JSON.stringify auth | `{authorization:'***'}` | 已脱敏 | 安全 |
| 数组嵌套 token/Bearer | `[{token:'...'},'Bearer ...']` | 已脱敏 | 安全 |
| **stream 错误裸 secret** | error msg 含 `SECRET_MID` + `***` | `***`→`[REDACTED]`，**`SECRET_MID` 泄漏** | **泄漏（真实路径）** |
| Error.cause 片段（纯 redactSecrets） | wrapper.cause=rawErr | redactSecrets 副本丢 message（非枚举），但原始 `wrapper.cause.message` 仍在 | 见 A-02/STATIC |

### B. Endpoint / Provider / Credential Boundary
测试文件：`pure-logic.js`（段 B）、`mock-server.js`（段 B E2E）。

| # | provider / baseURL / credentialType | ok | provider | 判定 |
|---|---|---|---|---|
| 1 | deepseek / api.deepseek.com / deepseek-api-key | true | deepseek | 正常 |
| 2 | deepseek / api.deepseek.com / apiKey | false | — | 正确拦截 |
| 3 | deepseek / evil-thirdparty / deepseek-api-key | false | — | 正确拦截（防 key 泄第三方） |
| 4 | **deepseek / evil-thirdparty / apiKey** | **true** | **deepseek** | **冒充（B-02）** |
| 5 | deepseek / http://evil / apiKey | false | — | 正确拦截（公网禁明文） |
| 6 | deepseek / http://127.0.0.1:8899 / apiKey | true | local | 正常（本地放行） |
| 7 | custom / api.deepseek.com / deepseek-api-key | true | deepseek | 端点为准 relabel |

**B E2E（mock server）**：本地 fake endpoint（`http://127.0.0.1:38503`）返回 `{model:'FAKE-MODEL-FROM-3RD-PARTY',...}`，真实 DeepSeek client 请求后喂 `buildGenerationContext`：
```
{"provider":"deepseek","endpoint":"http://127.0.0.1:38503","observedModel":"FAKE-MODEL-FROM-3RD-PARTY",
 "observedModelSource":"provider_response","provenanceStatus":"runtime_observed_partial"}
```
→ **非 DeepSeek endpoint 的响应被记为可信 DeepSeek runtime evidence（B-01）**。

### C. Runtime Evidence / Provenance Forgery
测试文件：`pure-logic.js`（段 C）。

| 测试 | 结果 | 判定 |
|---|---|---|
| **C-1 经导出 `__internal` mint 伪造** | `provenanceStatus=runtime_observed_partial`、`observedModelSource=provider_response`、模型被接受 | **伪造成功（C-01）** |
| C-2 普通对象冒充 | 降级 `caller_or_config` | 安全 |
| C-3 symbol marker 复制 | 被 WeakSet 身份挡下 | 安全 |
| C-4 跨 adapter（provider 已声明） | `providerRuntimeAdapterMatches` 拒绝 | 安全 |
| C-5 caller `observedModel`（无 mint） | `caller_or_config`（不升级） | 安全 |
| **C-6 provider=unavailable 跨 adapter** | `providerRuntimeAdapterMatches` 返回 true → 接受 | **旁路（C-02）** |

### D. Retry / Timeout / Abort / Stream
测试文件：`mock-server.js`（段 D）。全部针对真实 `DeepSeek` client + mock server。

| 测试 | Expected | Actual | 判定 |
|---|---|---|---|
| 500 ×N 重试 | 硬上限截断 | reqCount=3（maxRetries=2+1），`retryState` 保留 | 安全 |
| maxRetries=99 | ≤ HARD_MAX_RETRIES(3)+1 | reqCount≤4 | 安全 |
| 400 | 不重试 | 单次（reqCount=1，`request_rejected`） | 安全 |
| 401 | 不重试 | 单次（`auth_failed`） | 安全 |
| 429 Retry-After:1 | 可重试 | reqCount>1 | 安全 |
| 429 Retry-After:3600 | 不重试（过大） | 单次（reqCount=1） | 安全 |
| timeout（hang，300ms） | 终止 | `TimeoutError` | 安全 |
| AbortSignal | 转发 | `AbortError` | 安全 |
| stream 正常 | 组装文本/usage/model | `Hello world`，total_tokens=5，FAKE-STREAM-MODEL，deltas 有序 | 安全 |
| stream 中途 error | partial 保留 | `partial='partial-before-error '` | 安全 |
| **stream 错误消息脱敏** | secret 脱敏 | `***`→`[REDACTED]`，**`SECRET_MID` 泄漏** | **泄漏（归 A-01）** |
| stream abrupt cut | partial 保留 | `partial` 含 `cut-off` | 安全 |
| stream 内静默重启 | 禁止 | stream() 无重启（仅 raw() 预 yield 重试） | 安全（但 P4 fallback 保护未接线，见 INT-01） |

### E. Budget Guard / Cost
测试文件：`pure-logic.js`（段 E）。

| 测试 | Actual | 判定 |
|---|---|---|
| budget=0 | `NO_BUDGET_CONFIGURED`（放行，语义=不设限） | 候选（语义） |
| budget=50 < worstCase=400 | 拦截 `BUDGET_EXCEEDED` | 安全 |
| retries+1>4 | 拦截 | 安全 |
| cost-strategy 未知 usage | `cost:null`（不伪造 0） | 安全 |
| **legacy `costOf(null)`** | **→ 0（null→0 转换）** | **E-02** |
| pricingVersion 缺省 | `unversioned-legacy`（不留 null） | 安全 |
| **routing 预算门 + estimatedCost=null** | **→ 允许（fail-open）** | **E-01** |
| **routing 预算门 + estimatedCost=NaN** | **→ 允许（fail-open）** | **E-01** |
| routing 成本门 + estimatedCost=null | → 拒绝（fail-closed） | 安全（对照） |

### F. Provider Adapter / Registry
测试文件：`pure-logic.js`（段 F）。

| 测试 | Actual | 判定 |
|---|---|---|
| **duplicate providerId** | 2nd `registerProvider` 静默覆盖 1st（`Map.set` 无检查） | **F-01** |
| registry 是否存 secret | entry 仅 `credentialPolicy` 类型标识，无 key/secret 值 | 安全 |
| 空白 providerId | 抛 `PROVIDER_ID_REQUIRED` | 安全 |
| createAdapter 未知 provider | 抛 `UNKNOWN_PROVIDER` | 安全 |

### G. Usage / Cache / Cost Truth
测试文件：`pure-logic.js`（段 G）。

| 测试 | Actual | 判定 |
|---|---|---|
| provider usage | `usageSource='provider_response'` | 安全 |
| providerRawUsage | 已脱敏 | 安全 |
| 无 usage | `unavailable` + 字段 null（不伪造） | 安全 |
| partial usage | `partial`，completion 不伪造 | 安全 |
| promptTokens 推导 | `hit+miss`（算术非猜测） | 安全 |
| cache-strategy 未知 provider | `null`（fail-closed） | 安全 |
| cost-strategy 未知 | `cost:null` | 安全 |
| normalize 区分 caller/provider | **无法区分**（按字段形态判定，真值依赖 mint 层） | G-01（PARTIAL） |

### #9 isPeakHour 峰谷计价
测试文件：`pure-logic.js`（段 #9）。

| TZ | 时刻(北京) | isPeakHour | 期望 |
|---|---|---|---|
| Asia/Shanghai | 2026-09-30 10:00 周三 | true | true |
| Asia/Shanghai | 2026-09-30 20:00 周三 | false | false |
| America/New_York | 同一北京瞬间 | true | true |
| UTC | 同一北京瞬间 | true | true |
| Asia/Shanghai | 2026-10-03 10:00 国庆 | false | false |
| Asia/Shanghai | 2026-10-10 10:00 调休周六 | false | false |
| Australia/Sydney | 同一北京瞬间 | true | true |

→ 跨宿主时区判定一致（北京基准），节假日/调休正确。**安全**。

---

## 5. 发现清单（统一字段格式 / Findings）

> Status 仅用：CONFIRMED / PARTIAL / STATIC_ONLY / NOT_REPRODUCED。

---

### [B-01] 非 DeepSeek endpoint 响应被记为可信 DeepSeek runtime evidence
- **ID**：B-01
- **Title**：Endpoint 与 runtime evidence 绑定脱钩
- **Severity**：High
- **Status**：CONFIRMED
- **Component**：`src/deepseek.js`（mint）· `src/experiment-metadata.js`（绑定）· `src/provider-adapter.js`
- **Attack Preconditions**：配置/攻击者把 `baseURL` 指向非 DeepSeek 端点（第三方或本地 mock），`provider` 字段填 `deepseek`。
- **Test Method**：起本地 mock HTTP server 返回伪造 DeepSeek 响应，用真实 DeepSeek client 请求，把返回值喂进 `buildGenerationContext`，检查 provenance 判定。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/mock-server.js`（段 B）
- **Expected**：非 DeepSeek endpoint 的响应不应被记为 `provider='deepseek'` 的 `provider_response`/`runtime_observed`。
- **Actual**：`buildGenerationContext → {"provider":"deepseek","endpoint":"http://127.0.0.1:38503","observedModel":"FAKE-MODEL-FROM-3RD-PARTY","observedModelSource":"provider_response","provenanceStatus":"runtime_observed_partial"}`。
- **Evidence**：`deepseek.js:14` 铸造固定 `adapter='deepseek'`（与 endpoint 无关）；`experiment-metadata.js:204 providerRuntimeAdapterMatches` 仅比 adapter id；`:336 endpoint` 仅记录不校验；`deepseek.js:342/:515 markProviderRuntimeResponse(...,{adapter:'deepseek'})`。
- **Reproducibility**：高（mock server 稳定复现）。
- **Impact**：研究完整性/Provenance 真值污染——任何本地/第三方端点输出可被归因为「DeepSeek 运行时事实」，D-010「历史真实性 / runtime evidence 绑定」在 endpoint 维度失效。
- **Design Constraint**：违反 F-12b「runtime evidence 与 provider/adapter 绑定 fail-closed」的意图（绑定只到 adapter id，未覆盖 endpoint），属欠约束不变式。
- **Minimal Fix Direction**：`buildGenerationContext` 增加 endpoint↔provider 一致性校验（非 DeepSeek host 不得置 `observedModelSource='provider_response'` 对 `provider='deepseek'`，应 fail-closed 降级）；或 mint 时把 `endpoint` 纳入 attestation 并校验。

---

### [C-01] Runtime Evidence 可经导出的 `__internal.createProviderRuntimeMintAuthority` 伪造
- **ID**：C-01
- **Title**：铸造权经 `__internal` 导出，可伪造 runtime_observed
- **Severity**：High
- **Status**：CONFIRMED
- **Component**：`src/experiment-metadata.js`（`__internal` mint authority）
- **Attack Preconditions**：攻击者能 `require('experiment-metadata')`（任何加载该模块的代码）。
- **Test Method**：`__internal.createProviderRuntimeMintAuthority('deepseek')` 取铸造器，对自造对象铸造，喂 `buildGenerationContext`，检查 provenanceStatus/observedModelSource。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/pure-logic.js`（段 C-1）
- **Expected**：「公共 API 无法伪造 provider runtime observation」；铸造权收口于内部接线。
- **Actual**：`provenanceStatus='runtime_observed_partial'`、`observedModelSource='provider_response'`、`observedModel='FORGED-MODEL-X'` 全被接受为真实运行时观测。伪造成功。
- **Evidence**：`experiment-metadata.js:526-527` `__internal: Object.freeze({createProviderRuntimeMintAuthority,...})` 在 `module.exports` 上；`:152-180` 铸造器 `providerRuntimeRegistry.add()`+`providerRuntimeAdapters.set()`。项目自测 `test/research-reproducibility-p1.test.js:226` 亦调用此工厂。
- **Reproducibility**：高。
- **Impact**：WeakSet 信任根可被合法铸造器污染；任何持有模块引用的 caller 可制造「DeepSeek 运行时证据」，绕过「caller-supplied ≠ runtime-observed」边界。
- **Design Constraint**：违反 F-12a「铸造能力只授予 provider adapter 内部接线…不作为普通 caller 可自由调用的公开 helper 导出」——`__internal` 实际在 `module.exports`，「非公共 API」仅约定非硬边界。
- **Minimal Fix Direction**：`createProviderRuntimeMintAuthority` 每 adapter 单次铸造/调用点白名单，或把 `__internal` 从 `module.exports` 摘除（deepseek.js 在模块加载时经闭包取得、不留公开入口）。

---

### [INT-01] P4 子系统已实现+已测但未接入生产请求路径
- **ID**：INT-01
- **Title**：P4 routing/generation-attempt/circuit-breaker 未接线生产
- **Severity**：High（研究完整性/预期落差，非内存安全）
- **Status**：CONFIRMED
- **Component**：`src/provider-routing.js` · `src/generation-attempt.js` · `src/circuit-breaker.js` · `src/brain.js`
- **Attack Preconditions**：无（声明功能 vs 真实 runtime 落差）。
- **Test Method**：全仓 grep 三个模块的 require 点；grep brain.js 的 fallback/outputYielded/circuit 接线。
- **Sandbox Command / Harness**：`git grep -n "require('../src/provider-routing'|…)"`（见第 3 节）
- **Expected**：提交标题 `feat(v0.9.8): P4 routing contract, generation attempts, fallback policy, circuit breaker` 暗示治理真实请求。
- **Actual**：三模块**仅被 `test/provider-routing-p4.test.js` 导入**；`grep fallback|outputYielded|circuit|createGenerationResult|evaluateFallback src/brain.js`=空。生产请求失败仅 catch，无 fallback/熔断/Attempt-Result 轨迹。
- **Evidence**：grep（第 3 节表）；`brain.js:690,:1472,:1545` 仅 catch。
- **Reproducibility**：高（grep 确定性）。
- **Impact**：「fallback 受 outputYielded/cost/privacy/budget 约束」「circuit breaker」「一次调用一 Attempt」等 P4 契约真实 runtime 不生效，仅单元测试覆盖。「测试通过=生产有保护」是误判。
- **Design Constraint**：与 P4 设计声明存在落差（功能存在但未上生产）。
- **Minimal Fix Direction**：在 brain 请求编排接线 routing/attempt/circuit，或在 README 明确标注 P4 为「未激活预留」。

---

### [A-01] Secret Redaction 绕过：裸 secret + 复合对象键不脱敏
- **ID**：A-01
- **Title**：redactSecrets 形态覆盖不足致泄漏
- **Severity**：Medium（High，若日志/错误常见裸 key 形态）
- **Status**：CONFIRMED
- **Component**：`src/redact.js`（消费点 `deepseek.js`/`brain.js`/`provider-adapter.js`）
- **Attack Preconditions**：敏感值以非 Bearer/sk-/key=value 形态出现（裸 base64/`ghp_`/`AKIA`/随机串），或挂在非精确匹配键名下（`dbPassword`/`clientSecret`/`privateKey`/`sessionToken`/`my_api_key`）。
- **Test Method**：`redactSecrets` 喂入上述形态；并在真实 stream 错误路径验证。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/probe-redact.js`、`mock-server.js`（段 D stream-mid-error）
- **Expected**：P1「credential 泄漏面零泄漏」。
- **Actual**：裸 secret 全泄漏（`dGhpc0...`/`ghp_...`/`AKIA...`/随机串）；复合键泄漏（`dbPassword`/`sessionToken`/`clientSecret`/`privateKey`/`my_api_key`）；真实 stream 错误 `***`→`[REDACTED]` 但**裸 `SECRET_MID` 泄漏**。
- **Evidence**：`redact.js:13-20`（三 regex 仅 Bearer/sk-/key=value 精确键）、`:30-36 SECRET_OBJECT_KEYS`（精确匹配，无复合键）；`deepseek.js` stream `consume:424` 过 redactSecrets 但受同一局限。
- **Reproducibility**：高。
- **Impact**：非标准格式 secret 在错误/日志/archive/diagnostics 出口泄漏；P1「零泄漏」在非 sk-/Bearer 形态不成立。
- **Design Constraint**：`redact.js:4-5` 自述「只覆盖已知边界…不做万能 detector」（已声明局限），但 P1 宣称「零泄漏」，实际覆盖不足。
- **Minimal Fix Direction**：`SECRET_OBJECT_KEYS` 复合键后缀匹配（`*secret`/`*password`/`*token`/`*key`，大小写不敏感）；可选高熵启发式脱敏；明确「裸 secret 无法可靠识别」边界声明。

---

### [E-02] legacy `costOf` 把未知成本（null）转 0，且真实路径调用
- **ID**：E-02
- **Title**：costOf null→0 truth-boundary 折叠
- **Severity**：Medium
- **Status**：CONFIRMED
- **Component**：`src/deepseek.js`（`costOf`）· `src/cost-strategy.js` · `src/brain.js:1564`
- **Attack Preconditions**：provider 未返回可用 usage（`usageSource='unavailable'`）时仍计价。
- **Test Method**：对比 `getCostStrategy('deepseek').calculate(normalizeUsage(null))` 与 `costOf(null)`。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/pure-logic.js`（段 E）
- **Expected**：未知成本保持未知（fail-closed），不伪装 0。
- **Actual**：`cost-strategy.calculate → {cost:null, reason:'USAGE_UNAVAILABLE'}`（正确）；`costOf(null) → 0`（`deepseek.js:88-90` `return r.cost == null ? 0 : r.cost`）。
- **Evidence**：`deepseek.js:88-90`；`cost-strategy.js:38`；`brain.js:1564 const c = costOf(usage, price)`（真实调用点）。
- **Reproducibility**：高。
- **Impact**：依赖 `costOf` 的成本显示/累加把「成本未知」当 0，低估花费；与 P3「unknown cost 不伪造 0」冲突（代码注释自述兼容旧行为）。
- **Design Constraint**：`costOf` 头注释声明为兼容入口、明确「无 usage 返回 0」——已声明兼容，但与 P3 truth-boundary 张力。
- **Minimal Fix Direction**：`costOf` 返回 `null`（或 `{cost,known:false}`）；调用方（brain:1564）显式处理 unknown。

---

### [F-01] Provider Registry 重复 providerId 静默覆盖
- **ID**：F-01
- **Title**：registerProvider 重复 id 无拒绝
- **Severity**：Medium
- **Status**：CONFIRMED
- **Component**：`src/provider-registry.js`
- **Attack Preconditions**：能调用公开的 `registerProvider`。
- **Test Method**：连续两次 `registerProvider` 同一 providerId，检查第二个是否覆盖第一个。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/pure-logic.js`（段 F）
- **Expected**：重复 providerId 应拒绝或告警，不静默覆盖。
- **Actual**：第二个直接 `Map.set` 覆盖第一个（`adapterFactory().id==='SECOND'`），无拒绝/告警。
- **Evidence**：`provider-registry.js:39` `ENTRIES.set(providerId.trim(),...)`，无 `ENTRIES.has()` 检查；`registerProvider` 公开导出（:80）。
- **Reproducibility**：高。
- **Impact**：registry 完整性——恶意/失误注册可覆盖既有 provider（如替换为伪造 adapter factory），结合 C-01 可放大伪造 runtime evidence。
- **Design Constraint**：registry 红线只声明「不存 secret/非信任根」，未声明重复处理（欠约束）。
- **Minimal Fix Direction**：`registerProvider` 对已存在 id 抛错或需显式 `{override:true}`；默认拒绝覆盖。

---

### [B-02] `validateCredentialTarget` 允许第三方 endpoint 冒用 provider=deepseek
- **ID**：B-02
- **Title**：policy 层 provider 身份可谎报
- **Severity**：Medium（B-01 前置放大器）
- **Status**：CONFIRMED
- **Component**：`src/provider-policy.js`
- **Attack Preconditions**：`provider='deepseek'` + 第三方 `baseURL` + 通用 `credentialType='apiKey'`。
- **Test Method**：`validateCredentialTarget({provider:'deepseek', baseURL:'https://evil...', credentialType:'apiKey'})`。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/pure-logic.js`（段 B）
- **Expected**：第三方 endpoint 不应被标记 `deepseek`。
- **Actual**：`ok=true, provider='deepseek'`（放行且冒充）。
- **Evidence**：`provider-policy.js:50` `effectiveProvider = ... : (provider||'custom')`；`:46` 仅拦 `credentialType==='deepseek-api-key'` 场景。
- **Reproducibility**：高。
- **Impact**：policy 不纠正 provider 身份谎报，为 B-01 提供前置；与 mint endpoint-blind 结合成完整伪造链。
- **Design Constraint**：凭据边界模块，provider 身份可信度未定（欠约束）。
- **Minimal Fix Direction**：`effectiveProvider` 以 endpoint 为准（非 DeepSeek host 不返回 `'deepseek'`），caller `provider` 仅作提示。

---

### [E-01] Routing 预算门对未知成本 fail-open（latent，未接生产）
- **ID**：E-01
- **Title**：evaluateFallbackPolicy 预算门 unknown cost→0
- **Severity**：Medium（当前未上生产路径）
- **Status**：CONFIRMED（模块级）／运行时暂不触发（见 INT-01）
- **Component**：`src/provider-routing.js`
- **Attack Preconditions**：`plan.policy.budgetRemaining` 已设，`estimatedCost` 为 null/NaN/undefined。
- **Test Method**：`evaluateFallbackPolicy(plan{budgetRemaining:1.0}, {estimatedCost:null, fallbackCapabilities:{streaming:true}})`。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/pure-logic.js`（段 E）
- **Expected**：未知成本应 fail-closed（不放行）。
- **Actual**：`{ok:true}`（放行）。`provider-routing.js:70-75` `need = Number.isFinite(estimatedCost) ? estimatedCost : 0`，null/NaN→0→放行；与 `:62-66` 成本门 fail-closed 不一致。
- **Evidence**：`provider-routing.js:62-75`（运行对照：costLimit 设→null 拒绝；仅 budgetRemaining→null 放行）。
- **Reproducibility**：高（模块级）。
- **Impact**：一旦 P4 fallback 接入，未知成本被当 0 放行，违反 fail-closed。
- **Design Constraint**：违反 P4「Fallback 受 budget 约束、fail-closed」。
- **Minimal Fix Direction**：`:71` 改为 `if (!Number.isFinite(estimatedCost)) return {ok:false, reason:'UNKNOWN_COST'}`（对齐成本门）。

---

### [C-02] provider 未声明时跨 adapter evidence 反被接受（边缘）
- **ID**：C-02
- **Title**：provider=unavailable 绑定校验旁路
- **Severity**：Low
- **Status**：CONFIRMED（边缘）
- **Component**：`src/experiment-metadata.js`
- **Attack Preconditions**：`cfg` 无 provider 且无 baseURL（provider=unavailable），喂入别处铸造的 evidence。
- **Test Method**：`buildGenerationContext({cfg:{}, providerResponse: otherAdapterResponse})`。
- **Sandbox Command / Harness**：`node .openclaw/tmp/audit-v0981/pure-logic.js`（段 C-6）
- **Expected**：跨 adapter evidence 应 fail-closed。
- **Actual**：`providerRuntimeAdapterMatches`（`experiment-metadata.js:206-207`）在 provider 为 null/unavailable 时 `return true` → 接受为 `provider_response`。
- **Evidence**：`experiment-metadata.js:204-208`。
- **Reproducibility**：高。
- **Impact**：provider 身份缺失时绑定校验被旁路，可能混入非声明 provider 的「观测事实」。
- **Design Constraint**：注释自述「未声明 provider 不做绑定否定」（已声明，但放宽绑定）。
- **Minimal Fix Direction**：provider=unavailable 时要求 evidence 与默认信任根一致，或显式标注 `bindingUnverified`。

---

## 6. PARTIAL 风险

- **[G-01] usage 真值依赖可伪造的 mint 层**：`usage-normalizer` 自身无法区分 caller-supplied vs provider usage（`usageSource` 仅按字段形态判定）；真值依赖 mint 层，而 mint 可伪造（C-01）。单独 normalize 层无伪造，组合后可伪造「provider_response usage」。Component: `usage-normalizer.js` + `experiment-metadata.js`。
- **[D-post-yield]「已 yield 禁 fallback/重启」保护未生效**：`stream()` 内无静默重启（验证通过），但强制逻辑在 `provider-routing/generation-attempt`（未接线，INT-01），故运行时该保护目前不生效。

## 7. STATIC_ONLY 候选

- **[A-02b] Error.cause 潜在泄漏面（通用）**：`makeProviderError({cause})`/`toUnifiedError` 的 `e.cause` 保留原始错误对象；`redactSecrets` 不清 `Error.message`/`cause.message`（非枚举）。当前 Node22 JSON.parse 不内嵌 body（见 NOT_REPRODUCED），但若 cause 来自含 secret 的错误消息，仍可能经 `err.cause.message`/`console.error(err)` 泄漏。静态可见，未构造出真实泄漏路径。
- **[E-03] budget-guard budget≤0 = NO_BUDGET_CONFIGURED（放行）**：语义「0=不设限」而非「0 额度=拒绝」；`pure-logic.js` 段 E 验证行为，是否算缺陷取决于产品语义。
- **[#9-note] 节假日/调休表需逐年维护**（`deepseek.js` HOLIDAYS/MAKEUP_WORKDAYS）：2027 后表过期会把节假日当工作日（多估成本，方向安全），需人工维护；当前 2026 表自洽。

## 8. NOT_REPRODUCED（已主动攻击未复现）

- **[A-02] Error.cause 内嵌 raw body（response_parse）= NOT_REPRODUCED**：mock 返回非 JSON body（含 `SECRET_IN_BODY_FRAGMENT`）→ `response_parse_error`，`err.cause=SyntaxError "Expected property name or '}' in JSON at position 1..."` **不含 body**，message 亦不含（`safeDetail=''`）→ **Node22 下不泄漏**（旧 V8 才在 JSON.parse 错误内嵌片段）。已攻击未复现。
- **symbol marker 复制绕过 = NOT_REPRODUCED**：从真 response 抄 `PROVIDER_RUNTIME_MARKER` symbol 到 fake → 被 WeakSet 身份校验挡（`isProviderRuntimeResponse` 用 `WeakSet.has`）。防护有效。
- **普通对象/字面量冒充 runtime evidence = NOT_REPRODUCED**：未带 WeakSet 身份 → 正确降级 `caller_or_config`。
- **跨 adapter 伪造（provider 已声明）= NOT_REPRODUCED**：other-adapter evidence 喂 provider=deepseek → `providerRuntimeAdapterMatches` 拒绝。
- **无限 retry 循环 = NOT_REPRODUCED**：500/429 均被 `HARD_MAX_RETRIES=3` 截断（reqCount≤4）。

## 9. 已验证且没有问题的边界（运行证明）

- **D retry/timeout/stream 控制**：retry 硬上限（maxRetries=99 仍≤4）；400/401/4xx 非暂态单次不重试；429 可重试、Retry-After 过大不重试、退避≤5s；timeout→`TimeoutError` 真正终止；`AbortSignal` 全程转发→`AbortError`；stream 出错 `reader.cancel()`+`partial` 保留；abrupt cut→partial 保留；deltas 有序。
- **C 信任根基础**：symbol 复制被 WeakSet 挡；普通对象不升级；caller `observedModel` 降 `caller_or_config`；跨 adapter（已声明 provider）fail-closed。
- **G usage/cost 真值层**：无 usage→`unavailable`+null（不伪造）；partial→`partial`；`promptTokens=hit+miss` 算术非猜测；cache-strategy 未知→null；cost-strategy 未知→`cost:null`、`pricingVersion='unversioned-legacy'`。
- **budget-guard**：worstCase 超限 / `retries+1>4` fail-closed 拦截。
- **provider-policy**：DeepSeek key 发往第三方→拦截；公网明文 http→拦截；官方端点强制 `deepseek-api-key`+HTTPS。
- **registry**：不存 secret（entry 仅 `credentialPolicy` 类型标识）；空白 providerId 拒绝；未知 provider `createAdapter` 抛错。
- **#9 isPeakHour**：跨宿主时区（Asia/Shanghai / America/New_York / UTC / Australia/Sydney）对同一北京瞬间判定一致；国庆节假日、调休补班周六正确判低谷。

---

## 10. Finding Manifest

| ID | Severity | Status | Component | Reproduced | Fix Required |
|---|---|---|---|---|---|
| B-01 | High | CONFIRMED | deepseek.js / experiment-metadata.js / provider-adapter.js | Yes | Yes |
| C-01 | High | CONFIRMED | experiment-metadata.js (`__internal`) | Yes | Yes |
| INT-01 | High | CONFIRMED | provider-routing.js / generation-attempt.js / circuit-breaker.js / brain.js | Yes (grep) | Yes |
| A-01 | Medium | CONFIRMED | redact.js | Yes | Yes |
| E-02 | Medium | CONFIRMED | deepseek.js `costOf` / cost-strategy.js / brain.js:1564 | Yes | Yes |
| F-01 | Medium | CONFIRMED | provider-registry.js | Yes | Yes |
| B-02 | Medium | CONFIRMED | provider-policy.js | Yes | Yes |
| E-01 | Medium | CONFIRMED | provider-routing.js | Yes | Yes |
| C-02 | Low | CONFIRMED | experiment-metadata.js | Yes | Yes |
| G-01 | Medium | PARTIAL | usage-normalizer.js + experiment-metadata.js | Partial | Yes |
| D-post-yield | Low | PARTIAL | provider-routing.js / generation-attempt.js | Partial | Yes |
| A-02b | Low | STATIC_ONLY | deepseek.js / provider-adapter.js (Error.cause) | No | Review |
| E-03 | Low | STATIC_ONLY | budget-guard.js | No | Review |
| #9-note | Info | STATIC_ONLY | deepseek.js (HOLIDAYS 表) | No | Maintain |
| A-02 | — | NOT_REPRODUCED | deepseek.js (response_parse cause) | No | No (Node22) |
| C-symcopy | — | NOT_REPRODUCED | experiment-metadata.js | No | No (防护有效) |
| C-plainforge | — | NOT_REPRODUCED | experiment-metadata.js | No | No (防护有效) |
| C-crossadapter | — | NOT_REPRODUCED | experiment-metadata.js | No | No (防护有效) |
| D-infretry | — | NOT_REPRODUCED | deepseek.js | No | No (硬上限有效) |

---

## 11. Audit Limitations（Sandbox 环境限制）

1. **真实 DeepSeek API**：真实计费/真实模型返回/真实 cache 命中字段未测，用本地 mock server（OpenAI-compatible 协议级）等价替代；`usage`/`observedModel` 为 mock 注入，不代表真实 provider 数字。
2. **Node-only**：`v22.23.1` 纯 Node 运行。`secure.js`（safeStorage 落盘加密）需 Electron 运行时，未覆盖（本轮聚焦 A–G 边界，落盘加密不在核心范围）。
3. **Electron 主进程/渲染层**：未拉起 Electron，`main.js`/`preload.js`/IPC 边界未纳入本轮黑盒（聚焦 src 核心安全模块）。
4. **并发**：harness 为单请求串行，未测高并发下的 registry/circuit-breaker/budget 竞态；并发竞态列为后续。
5. **进程崩溃注入**：未做 process kill / 断电 / 半写入 fault-injection（`secure.js` saveConfig 事务回滚、`atomic.js` 原子写未测崩溃一致性）。
6. **网络**：Sandbox 有 GitHub 出站（`git fetch`/`push` 成功）；但未探测对公网任意 endpoint 的出站策略；mock server 仅回环 `127.0.0.1`。
7. **凭据**：全程未触碰/输出 git 或任何 API 凭据；`secure.js` 加密不可用时的明文降级路径未实测（需 Electron）。
8. **P4 未接线**：因 INT-01，E-01「运行时暂不触发」，无法在真实 fallback 流复现预算 fail-open 的实际后果（仅模块级复现）。
9. **时间边界**：#9 峰谷表仅覆盖 2026 年手工节假日/调休，2027+ 未验证（表过期方向安全，多估成本）。

---

*报告结束。本报告为审计证据归档，不包含任何修复改动。source modified = NO。*
