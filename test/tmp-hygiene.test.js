/* 临时目录卫生门禁（D-8a 收尾）
 *
 * 🔴 为什么需要这个门禁：
 *   2026-10-06 扫描 %TEMP% 发现本仓测试沙盒累积 **39221 个 / 55 种前缀**（10-01 起 6 天）。
 *   用户此前已投诉过「下载后出现含截图的 tmp 目录」—— 同类问题复发。
 *
 *   实测归因（不是猜测，逐个跑出来的）：
 *     · test/brain.test.js       —— 28 处 tmpDir()，**全文件 0 处 rmSync** ⇒ 单次净留 28
 *     · test/config.test.js      —— 12 处 mk()，清理只写了 [A, B] 两个 ⇒ 单次净留 10
 *     · test/wardrobe.test.js    —— 12 处 tmp()，0 处清理 ⇒ 单次净留 12
 *     · test/secure.test.js      —— 0 处清理 ⇒ 单次净留 11
 *   四处均已改为「工厂函数登记 + process.on('exit') 统一清」。
 *
 * 🔴🔴 本门禁第一版犯过两个错，写在这里防止重犯：
 *
 *   ①判据用手写的前缀白名单（只3 个）⇒ 实际 55 种，**漏掉 52 种**。
 *     正解：前缀表**从源码自动推导**，不手写维护。
 *
 *   ② 判据用「跑完增量 ≠ 0 就红」，而当时**后台清理批次正在并发删除同一目录**：
 *     wardrobe 明明净增 12 判对了，agent_executor 明明净增几十却显示 0（被清理掩盖）。
 *     ⇒ **有其他进程写同一目录时，计数差不再是有效判据。**
 *     正解：跑审计前**必须确认无并发清理**；本门禁在开头显式检查并拒绝启动。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = os.tmpdir();
const LOCK = path.join(TMP, '_deskpet_cleanup_running.lock');
const knownPrefixFile = path.join(ROOT, '.workbuddy', 'cleanup', 'known-prefixes.json');

/* 🔴 2026-10-27（P4-1）：本套件的启动时刻。
 *   用途：判断「跑完之后 known-prefixes.json 的 mtime 是否被无谓刷新」。
 *   必须在任何读写之前取，否则判据自我失效。 */
const SUITE_START_MS = Date.now();

/* 🔴 2026-10-27（审核问题 2）：**启动瞬间**该文件是否存在。
 *   必须在这里快照，不能等到断言处再查 —— 那时文件可能已被本套件生成，
 *   判据会自我失效（分不清「原本就有」和「刚被创建」）。
 *   用途：首次生成属初始化，mtime 守卫应判 SKIP 而非 FAIL。 */
const PREFIX_FILE_EXISTED_AT_START = fs.existsSync(knownPrefixFile);

let failures = 0;
let skips = 0;
let total = 0;      // 已执行的断言总数（含 SKIP）—— 供结构化摘要对账
function check(name, cond, extra) {
  total++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '' + extra : ''));
  if (!cond) failures++;
}

/**
 * 🔴 2026-10-27（审核问题 3 + 项数漂移，最终解）：环境不适用 → **真 SKIP**。
 *
 * ## 曾经的两次错误
 *   ① 第一版写成 `check(..., true, '  SKIP: ...')` —— 标签是 PASS、文案写 SKIP，
 *      那是假绿（CI 上看不出没验）；
 *   ② 第二版改成真 SKIP，但破坏了项数稳定性：
 *      `docs.test.js` 用 `/^PASS/gm` 数行 ⇒ 有 git 22 PASS / 无 git 21 PASS + 1 SKIP
 *      ⇒ README 只能写一个数，必然一边红。
 *      我当时的结论是「真解法要动 docs.test.js，影响 134 个套件，风险大，不做」——
 *      **那个理由是错的**：实测只有 2 个套件输出 SKIP；而且 docs.test.js
 *      早已支持结构化摘要（`ASSERT total=N passed=M failed=K`，
 *      experiences-archive / subject-state / replay-cancel 三处已在用）。
 *
 * ## 最终解（本文件）
 *   真 SKIP（语义正确）+ 输出 `ASSERT total=N passed=M failed=K`，
 *   其中 **total 含 SKIP、passed 不含**。
 *   `docs.test.js` 的 countPass() 优先读结构化摘要，并用 **total** 与 README 对账
 *   （见该文件 §countPass 的 2026-10-27 注释）。
 *   于是：项数恒定（total 不随环境变），语义也不冒充通过。
 */
function skipCheck(name, reason) {
  total++;
  skips++;
  console.log('SKIP  ' + name + '  （环境不适用：' + reason + '）');
}

// ---- 前缀表从源码自动推导（第一版手写 3 个 ⇒ 漏 52 种，此坑勿重犯） ----
// 🔴🔴 口径演进史（三版都实测过，别退回旧版）：
//   v1 手写白名单 3 个 ⇒ 漏 52 种。
//   v2 位置正则 /mkdtempSync\([^)]{0,200}?['"].../ ⇒ **跨不过 os.tmpdir() 里的括号**，
//      82 种只捞到 2 种。位置法在有嵌套调用时静默失效，比漏报更危险（看着在工作）。
//   v3 纯字面量 /['"]([\w.\-]*-)['"]/ ⇒ 召回 222 种，过宽（'n-'、'idx-' 都被收进来）。
//   **v4 = v3 + 行级限定**：前缀字面量必须与临时目录 API 同一行内出现。
//      实测 82 种，与留档 known-prefixes.json 完全一致（0 漏 0 多）。
//⚠️ 「覆盖缺失」和「召回过宽」都会让门禁失效，且都不报错—— 必须每次改口径都跑差集核对。
function buildPrefixMap() {
  const map = {};
  const TMPCTX = /(mkdtemp|tmpdir\(\)|TEMP_DIR|TMP_DIR)/;
  for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (!f.endsWith('.js')) continue;
    // 剥注释再扫：注释里写禁用词/示例前缀会自己命中自己（已踩两次）
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const set = new Set();
    for (const line of src.split(/\r?\n/)) {
      if (!TMPCTX.test(line)) continue;
      for (const m of line.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9_.\-]*-)['"]/g)) set.add(m[1]);
    }
    if (set.size) map[f] = [...set];
  }
  return map;
}

function countPrefixes(pres) {
  const names = fs.readdirSync(TMP);
  let n = 0;
  for (const p of pres) for (const e of names) if (e.startsWith(p)) n++;
  return n;
}

function run(file) {
  return new Promise((resolve) => {
    let out = '';
    // ⚠️ 必须异步 spawn：本机沙箱拦 spawnSync（EBUSY），已坐实过的环境事实。
    const p = spawn('node', [file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (rc) => resolve({ rc, out }));
    p.on('error', (e) => resolve({ rc: -1, out: String(e && e.message) }));
  });
}

(async () => {
  // ---- 第 0 层：拒绝在有并发清理时启动（第一版的病根） ----
  if (fs.existsSync(LOCK)) {
    console.log('SKIP  临时目录卫生：本仓清理任务正在运行（锁文件 ' + LOCK + ' 存在）');
    console.log('      计数差在这种环境下无效 —— 这正是第一版门禁的病根。已跳过，不产出结论。');
    process.exit(2);   // 2 = SKIP，不是 FAIL
  }
  check('无并发清理任务（否则计数差无效，见文件头第 ② 条）', true);

  const map = buildPrefixMap();
  const allPres = [...new Set(Object.values(map).flat())];
  check('🔴 前缀表从源码自动推导得出（手写维护必漏）',
    allPres.length >= 50,
    '套件 ' + Object.keys(map).length + ' 个 / 前缀 ' + allPres.length + ' 种');

  // ---- 第1.5 层：推导口径必须与留档清单一致（双向差集，缺一不可） ----
  // 🔴 为什么必须双向：只查「留档里有、推导没有」会漏掉「源码新增了前缀但清单没更新」；
  //   只查反向会漏掉「清单里的前缀其实源码已不用，清单成了僵尸条目」。
  //   两种失配都会让后续清理脚本按错误名单行动。
  let archived = [];
  try {
    if (fs.existsSync(knownPrefixFile)) {
      const parsed = JSON.parse(fs.readFileSync(knownPrefixFile, 'utf8'));
      archived = Array.isArray(parsed) ? parsed : allPres.slice().sort();
    } else {
      archived = allPres.slice().sort();
    }
  } catch {
    archived = allPres.slice().sort();
  }
  const onlyInSrc = allPres.filter((p) => !archived.includes(p));
  const onlyInFile = archived.filter((p) => !allPres.includes(p));
  check('🔴 推导口径与留档清单双向一致（否则清理脚本会按错名单行动）',
    onlyInSrc.length === 0 && onlyInFile.length === 0,
    '仅源码有=' + JSON.stringify(onlyInSrc) + ' 仅清单有=' + JSON.stringify(onlyInFile));

  // ---- 第 1 层：用户投诉过的历史前缀必须为空 ----
  const historic = fs.readdirSync(TMP).filter((e) => e.startsWith('chulan_'));
  check('🔴 历史前缀 chulan_* 已清空（用户 10-06 投诉过的截图残留不得再出现）',
    historic.length === 0, '  当前 ' + historic.length + ' 个');

  // ---- 第 2 层：逐套件实测增量，**按该套件自己的前缀**做差 ----
  // ⚠️ 只抽查下面这7 个「已修好」的当回归靶子：全量 103 套跑一遍要 2 分半，不适合进门禁。
  //   换靶子时要重跑确认那对文件也不漏，别假设。
  //🔴 2026-10-06 新增后三个：它们的 makeTempDir 走 path.join+mkdirSync 手工建目录，
  //   绕过 fs.mkdtempSync ⇒ 旧版门禁的 v2 口径给它们算出 0 个前缀，
  //   **永远不会被抽中，也永远测不出泄漏**（实测已漏 6752 个）。这三条是补那个洞的回归靶子。
  const TARGETS = ['test/brain.test.js', 'test/config.test.js',
    'test/wardrobe.test.js', 'test/secure.test.js',
    'test/internal-regulation.test.js', 'test/lifecycle-wiring.test.js',
    'test/path-dependency.test.js'];
  for (const f of TARGETS) {
    const key = path.basename(f);
    const pres = map[key];
    if (!pres) { check('（对照）' + key + ' 前缀已登记', false, '  未在源码里找到 mkdtemp 前缀'); continue; }
    const before = countPrefixes(pres);
    const r = await run(f);
    const after = countPrefixes(pres);
    const grew = after - before;
    const passes = (r.out.match(/^PASS/gm) || []).length;
    const fails = (r.out.match(/^FAIL/gm) || []).length;

    // 前置断言：套件真跑起来了。否则「增量=0」是假绿。
    check('（对照）' + key + ' 真的跑起来了（否则下一条是假绿）',
      r.rc === 0 && passes > 0 && fails === 0,
      '  RC=' + r.rc + ' PASS=' + passes + ' FAIL=' + fails);

    check('🔴 ' + key + ' 跑完不新增 %TEMP% 沙盒（增量须恰好 0）',
      grew === 0, '  增量=' + grew + '（' + before + '→' + after + '）');
  }

  // ---- 第 3 层：源码级辅检（明确标注辅检，不是主判据） ----
  // ⚠️ 可被「照抄一份清理到别处」骗过；主判据是第 2 层的运行时增量。
  const noCleanup = Object.entries(map)
    .filter(([f]) => !/process\.on\(['"]exit|rmSync|rmtree|afterAll|tearDown|addCleanup/.test(
      fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')))
    .map(([f]) => f);
  check('（辅检）所有创建临时目录的套件都显式声明了清理手段',
    noCleanup.length === 0,
    noCleanup.length ? '  缺清理: ' + noCleanup.join(', ') : '');

  // ---- 第 4 层：前缀表留档，供清理脚本复用 ----
  // ⚠️ 只写推导值会**丢掉清单里的历史前缀**（本仓实测存在 src 里已不再出现的条目，
  //   那些是旧版本测试留下的残留，仍需清理脚本认得）。故写并集。
  const merged = [...new Set(archived.concat(allPres))].sort();

  /* 🔴 2026-10-27（P4-1）：本文件已纳入版本控制，写回策略必须改。
   *
   *   为什么改：该文件原本被 .gitignore 挡住，随便写无所谓。现在它是**受版本控制的
   *   门禁资产**，若每次跑测试都无条件 writeFileSync，就会：
   *     · 内容没变也刷新 mtime ⇒ `git status` 时不脏，但 `artifact-freshness`
   *       与各种 mtime 判据会被无谓扰动；
   *     · 一旦内容真变了（新增测试前缀），工作树**在跑测试的过程中**变脏，
   *       而这正是"跑门禁"这个动作本身制造了未提交改动 —— 不可接受。
   *
   *   新策略：**只在内容真的不同时才写**，并且写之前把它算成一次显式的
   *   「留档更新」而不是静默副作用。内容相同时**一个字节都不动**。
   *
   *   仍然保留原有的自愈防线：存在差集或 failures 时绝不写。
   */
  if (failures === 0 && onlyInSrc.length === 0 && onlyInFile.length === 0) {
    let needWrite = true;
    try {
      const cur = JSON.parse(fs.readFileSync(knownPrefixFile, 'utf8'));
      needWrite = JSON.stringify(cur) !== JSON.stringify(merged);
    } catch (e) {
      needWrite = true;   // 文件不存在或坏了 → 需要（重）写
    }
    if (needWrite) {
      fs.mkdirSync(path.dirname(knownPrefixFile), { recursive: true });
      fs.writeFileSync(knownPrefixFile, JSON.stringify(merged, null, 1));
      // 写回是「留档更新」这一显式事件，不是静默副作用 —— 让人看得见
      console.log('  [留档更新] 前缀表内容有变化，已写回 ' + merged.length + ' 种');
    }
  }
  check('（辅检）前缀表已留档，清理脚本可复用（不必再手写白名单）',
    fs.existsSync(knownPrefixFile)
    && JSON.parse(fs.readFileSync(knownPrefixFile, 'utf8')).length === merged.length,
    '  并集 ' + merged.length + ' 种');

  /* 🔴 2026-10-27（P4-1 配套）：该文件已入库，跑门禁不得**无谓重写**它。
   *
   *   ⚠️ 为什么不能用 git status 当主判据（实测踩过）：
   *     无条件 writeFileSync 但内容相同时，**哈希不变 ⇒ git 完全看不到变化**
   *     （实测：mtime 变了，`git status --porcelain` 仍显示 `A `）。
   *     首版用 git status 做判据，变异测试（把「内容不同才写」改成「无条件写」）
   *     **未捕获** —— 那是个假绿。这里改用 mtime：无谓重写必然刷新 mtime。
   *
   *   🔴 2026-10-27 审核问题 2 修正：**首次生成必须判 SKIP，不是 FAIL**。
   *     上一版注释写了「若文件本不存在（首次生成），跳过」，但**代码没实现这个分支**
   *     —— 注释与实现不一致，与 A5（style.css 照抄旧文档）同型。
   *     实测：删掉文件再跑 ⇒ 正确行为（首次生成）却被判 FAIL。
   *     影响面：干净克隆 / 换机 / 公开库首次跑都会红。
   */
  const existedBefore = SUITE_START_MS > 0 && PREFIX_FILE_EXISTED_AT_START;
  if (!existedBefore) {
    skipCheck('跑完本套件不得无谓重写前缀表（防 mtime 扰动）',
      '套件启动时该文件不存在 —— 首次生成属初始化，不是无谓重写');
  } else {
    try {
      const st = fs.statSync(knownPrefixFile);
      const startMs = typeof SUITE_START_MS === 'number' ? SUITE_START_MS : 0;
      const rewritten = startMs > 0 && st.mtimeMs > startMs + 1000;
      check('🔴 跑完本套件不得无谓重写前缀表（防 mtime 扰动）',
        !rewritten,
        rewritten
          ? '  mtime=' + new Date(st.mtimeMs).toISOString() + ' 晚于启动时刻，说明被无条件写过'
          : '');
    } catch (e) {
      // 启动时存在、跑完却 stat 不到 —— 那是真异常，不能当 SKIP
      check('🔴 跑完本套件不得无谓重写前缀表（防 mtime 扰动）', false,
        '  启动时存在、跑完却读不到: ' + (e.code || e.message));
    }
  }

  /* 第二道：工作树侧不得出现「已修改」标记。
   * 这条只防**内容变化**，防不住同内容重写（见上）—— 作为附加，不是主判据。
   *
   * 🔴 2026-10-27 审核问题 3 修正：git 不可用时必须记 **SKIP**，不是 PASS。
   *   上一版写 `check(..., true, '  SKIP: ...')` —— 标签是 PASS、文案写 SKIP。
   *   实测（PATH 只留 node、去掉 git）：
   *     `PASS  （环境）工作树洁净度检查不适用  SKIP: ENOENT`
   *   这正是本仓反复禁止的假绿：CI 上看不出这项其实没验。
   */
  try {
    const { execFileSync } = require('child_process');
    const rel = path.relative(ROOT, knownPrefixFile).replace(/\\/g, '/');
    const st = execFileSync('git', ['status', '--porcelain', '--', rel], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    // 第二列 = 工作树相对暂存区；只有 M/D 或 ?? 才算脏（第一列的 A/M 是提交前正常准备态）
    const dirty = st.split(/\r?\n/).filter(Boolean).some((line) => {
      const worktreeFlag = line.charAt(1);
      return worktreeFlag === 'M' || worktreeFlag === 'D' || line.startsWith('??');
    });
    check('🔴 跑完本套件不得改变前缀表内容（工作树侧无修改）',
      !dirty, st ? '  git status: ' + st : '');
  } catch (e) {
    skipCheck('跑完本套件不得改变前缀表内容（工作树侧无修改）',
      'git 不可用（' + (e.code || e.message) + '）');
  }

  /* 汇总：输出结构化摘要供 docs.test.js 对账。
   *   total  = 已执行的断言总数（**含 SKIP**）—— README 里的项数指的就是它，
   *            因此不随环境漂移（git 有无、文件是否首次生成都不影响 total）。
   *   passed = 真正通过的项（不含 SKIP）。
   *   failed = 失败项。
   * docs.test.js 的 countPass() 优先读这一行，并用 total 与 README 比对。 */
  console.log('\n' + (failures
    ? failures + ' 项失败' + (skips ? '，' + skips + ' 项跳过' : '')
    : '临时目录卫生全部通过' + (skips ? '（' + skips + ' 项因环境不适用跳过）' : '')));
  console.log('ASSERT total=' + total + ' passed=' + (total - failures - skips)
    + ' failed=' + failures + ' skipped=' + skips);
  process.exit(failures ? 1 : 0);
})();

/* 变异测试注记（写这行时已实测，见 D-8a 日报）：
 *   删掉 brain.test.js 的 process.on('exit') 块 ⇒ 第 2 层 FAIL。
 *   把 config.test.js 的 [A,B] 散弹清理加回（覆盖登记制）⇒ 第 2 层 FAIL。
 *   wardrobe / secure 同理。
 *   ⇒ 不是恒真式。
 * ⚠️ 复现变异时**先停掉并发清理任务**（否则第 0 层会 SKIP），
 *    或手动删除 %TEMP%\_deskpet_cleanup_running.lock。 */
