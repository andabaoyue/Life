/**
 * 公开发布剥离器（Public Export Selector）
 *
 * 为什么需要它：docs/ROADMAP-AND-PUBLIC-RELEASE-PLAN.md §11 要求「正式 Public Release 前
 * 必须建立一次独立的公开发布剥离流程」，但仓库里从来没有这个流程 —— 2026-10 之前的公开库
 * 是手工挑文件的 276 文件快照，不可复查、每次全凭记忆。
 * 实测代价：按旧口径直接推会把 33 份内部审计/规划文档、49 行开发机绝对路径、8 张源素材 PNG
 * 一次性送进公开库，而 release-check 的旧扫描给的是「0 处泄露」的假绿灯。
 *
 * 本文件的定位不是「黑名单过滤器」，而是默认拒绝的发布边界：
 *   ① 只导出白名单命中的文件（INCLUDE）；
 *   ② 白名单内可以再显式挖洞（EXCLUDE，每条必须写理由）；
 *   ③ 既没命中 INCLUDE 也没命中 EXCLUDE 的文件 = UNCLASSIFIED = 门禁失败。
 *      —— 新增一个根目录 .md 或新顶层目录时，除非有人明写它该不该发，否则发不出去。
 *      这是本文件唯一不可协商的性质：默认拒绝，不默认放行。
 *
 * 三个入口：--check 门禁 / --list 判定明细 / --out <目录> 物化新树 /
 *          --sync <已存在的 Git 工作树> [--yes] 就地更新公开库工作树（带三道守卫）。
 *
 * 退出码约定：--check 有任意违规即 exit 1（供 CI 与 test/public-export.test.js 使用）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* ============================================================
 * 一、可公开（INCLUDE）
 *
 * 目录级白名单按「这套目录整体是可公开的工程资料」来写，不逐个列文件 ——
 * 逐文件列会腐烂，而目录级规则在新文件加入时自动覆盖，再由 EXCLUDE 挖洞。
 * ============================================================ */
const INCLUDE = [
  // 运行入口与前端（与 electron-builder.yml 的 files 白名单同源）
  'main.js',
  'preload.js',
  'vision-picker-preload.js',
  'index.html',
  'chat.html',
  // v1.8-b：全屏框选窗（独立窗口，与 electron-builder.yml 的 files 白名单同步）
  'vision-picker.html',
  'vision-picker.js',
  'chat.js',
  'pet.js',
  'style.css',
  'ui-i18n.js',
  'ui-chat-store.js',
  'ui-chat-render.js',
  'ui-provider-presets.js',
  'ui-outfit-complete.js',
  'ui-agent-confirm.js',
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  '.gitignore',
  '启动Life.vbs',
  '启动初澜.vbs',

  /* 🔴 2026-10-27（P4-1 修订）：`known-prefixes.json` 必须**进公开集**。
   *
   *   为什么（这一条我第一版判断错了，审核纠正）：
   *     · 它是 `test/tmp-hygiene` 的**运行时依赖**（双向差集断言的对照清单）；
   *     · 若公开集里没有它，`tmp-hygiene` 会走「文件不存在」分支 ——
   *       `archived = allPres.slice()`（自己等于自己）⇒ 双向差集**恒真**。
   *       那条门禁在公开库里会**静默变松**，比直接报错更危险。
   *
   *   安全性已核：111 条全是测试前缀（形如 `agentcnf-app-`、`archive-test-`），
   *   无盘符、无用户名、无绝对路径。
   *
   *   ⚠️ 必须放在 INCLUDE 而非靠 EXCLUDE 的 `!` 否定 ——
   *      `classify()` 的实现是「EXCLUDE 用 find 取第一个命中」，**不支持否定语法**。
   */
  '.workbuddy/cleanup/known-prefixes.json',

  // 门面与合规文档（公开库的对外契约面）
  // ⚠️ 2026-10-29：README.en.md 已删除（内容并入 README.md 的英文段）。
  //    这里的 INCLUDE 条目必须同步摘掉 —— classify() 会把零命中的 include 规则
  //    判成 deadRules，而 test/public-export.test.js 断言「真实仓库零死规则」，
  //    留着它会让剥离门禁自己变红。
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'LICENSE',
  'NOTICE',
  'BRANDING.md',
  'ASSET-GENERATION-GUIDE.md',
  'SOFTWARE-PURPOSES-AND-APPLICATIONS.md',

  // 目录级
  'src/**',
  'test/**',
  'tools/**',
  'assets/**',
  '.github/**',
  'docs/**',
  'research/**'
];

/* ============================================================
 * 二、不公开（EXCLUDE）
 *
 * 每一条都必须写理由 —— 理由不是注释，是这条规则的审计依据：
 * 半年后有人想「顺手把 OPTIMIZATION-REPORT.md 发了吧」，得先看见它为什么被挡。
 * ============================================================ */
const EXCLUDE = [
  // —— 根目录历史审计与迭代报告 ——
  // 这些是私有研究库的过程留档，不是软件交付物；其中 4 份含前任工程的开发机绝对路径。
  ['COGNITIVE-IDENTITY-AUDIT-REPORT.md', '内部身份审计报告；25 处 file:/// 直指开发机绝对路径'],
  ['IDENTITY-MIGRATION-AUDIT.md', '内部身份迁移审计；含前任工程开发机绝对路径'],
  ['PHILOSOPHICAL-IDENTITY-SPECIFICATION-AUDIT.md', '内部哲学身份规格审计；含前任工程开发机绝对路径'],
  ['OPTIMIZATION-REPORT.md', 'v0.8.2 时期过程报告，含早期临时工程称谓，非交付物'],
  ['V0.9-ARCHITECTURE-REPORT.md', 'v0.9 迭代过程报告，非交付物'],
  ['V0.9.1-ITERATION-REPORT.md', 'v0.9.1 迭代过程报告，非交付物'],
  ['V0.9.2-SYSTEM-AUDIT-REPORT.md', 'v0.9.2 系统审计；含前任工程开发机绝对路径'],
  ['V0.9.5.3-CODEX-FINDINGS-FIX-REPORT.md', 'v0.9.5.3 内部评审修复报告，非交付物'],
  ['V0.9.5.3-SECOND-REVIEW-REPORT.md', 'v0.9.5.3 内部二次评审报告，非交付物'],
  ['V1.0-CHIBI-PIXEL-ACCEPTANCE-AUDIT.md', 'v1.0 像素验收审计；含开发机绝对路径'],
  ['V1.0-CHIBI-PIXEL-REVERIFICATION-REPORT.md', 'v1.0 像素复验报告，非交付物'],
  ['V1.0-CHIBI-PIXEL-REVERIFICATION-2-REPORT.md', 'v1.0 像素复验报告（第二次），非交付物'],
  ['chulan_V3.1_讨论方案.md', '主体外观方案讨论稿；含开发机绝对路径'],
  ['chulan_subject_framework_spec_REVIEW.md', '主体框架规格评审稿；含开发机绝对路径'],
  ['P2诊断更正_self-ledger.md', 'Self-Ledger 诊断更正过程稿，非交付物'],
  ['Life-实验有效性修复-第二阶段.md', '实验有效性修复过程稿（第二阶段），非交付物'],
  ['Life-实验有效性修复-第三阶段.md', '实验有效性修复过程稿（第三阶段），非交付物'],
  ['拟人化三条_实施方案_待审核.md', '待审核的实施方案草案，未定稿不外发'],
  ['AGENTS.md', '内部开发纪律；引用 .pi/skills 工具链与本机环境备注，且它指向的 .pi 不外发'],

  // —— 工具链配置 ——
  ['.pi/**', '内部 Agent 技能与模式配置（Pi/DSH 工具链专用，与软件运行无关）'],
  ['.agents/**', '内部 Agent 技能配置（与 .pi 同源）'],

  /* 🔴 2026-10-27（P4-1 修订，最终版）：`.workbuddy/` **不写 EXCLUDE 规则**。
   *
   *   第一版把整个目录（含 known-prefixes.json）排除，理由是「绑定本机测试前缀，
   *   对使用者无意义」。审核指出这与我同一笔提交里「它是门禁运行时依赖，所以入库」
   *   的理由**自相矛盾**，而且后果更糟：公开集里没有它 ⇒ `tmp-hygiene` 走
   *   「文件缺失」分支 ⇒ 双向差集断言**恒真**（自己等于自己），门禁静默变松。
   *
   *   ⚠️ 五条实测教训（全踩过，写下来免得重犯）：
   *     ① `classify()` 用 `EXCLUDE_RE.find()` 取**第一个**命中 ⇒ 不支持 `!` 否定语法；
   *     ② EXCLUDE **优先于** INCLUDE ⇒ 写 `*.json` 或 `.workbuddy/**` 通配会挡住例外；
   *     ③ 拆成 11 条细排除 ⇒ 绝大多数零命中 ⇒ 集体被判**死规则** FAIL；
   *     ④ 在 classify() 里用 Set 摘出例外 ⇒ `.workbuddy/**` 变零命中死规则 FAIL；
   *     ⑤ 用 RegExp 负向断言表达例外 ⇒ **仍然零命中**，还是死规则 FAIL。
   *        根因：`.workbuddy/` 下**只有 known-prefixes.json 一个文件被 git 跟踪**
   *        （实测 `git ls-files .workbuddy` 仅此一条），而它正是要放行的那个。
   *        所以任何"排除 .workbuddy"的规则在当前仓库形态下**必然零命中**。
   *
   *   最终结论：**这条 EXCLUDE 不该存在**。该文件已加入 INCLUDE；
   *   将来 `.workbuddy` 下若有新文件入库，会被 classify() 判 UNCLASSIFIED
   *   并让门禁 FAIL，强制显式表态 —— 这比一条永远零命中的通配规则更有效。
   */

  // —— 内部实施报告与研究档案 ——
  ['docs/agent/**', '内部 Agent 实施报告（含内部工具链与私库改造细节）'],
  ['research/security/**', '内部安全审计档案（含沙箱攻击面与漏洞复现细节）'],

  // —— 研究库资产与构建脚本 ——
  ['scripts/**', '研究用 Python 资产生成脚本；含开发机绝对路径，README 已声明不随公开发布版分发'],
  ['assets/character-archive-760x1000/**', '760x1000 高分辨率源素材，electron-builder 已排除，不进发布包亦不进公开库'],
  ['assets/character/base/base_legacy_full.png', '像素换代后淘汰的旧版整身底图，零引用']
];

/* ============================================================
 * 三、绝对路径豁免清单
 *
 * 判据是「任意盘符绝对路径默认违规，除非整条路径命中下面的虚构前缀」。
 * 为什么不用关键词黑名单（只查 GAME / huihua）：实测旧门禁就是这么漏的 ——
 * 它只认 D 盘 software 目录下的 huihua，于是 software 目录下的其它工程一路绿灯。
 * 反过来做（默认违规 + 显式豁免）后，换来的是「新增一条绝对路径必须有人签字」。
 * ============================================================ */
const BENIGN_ABS = [
  ['C:\\Program Files', '浏览器探测路径（test/ui_test.py）'],
  ['C:\\Program Files (x86)', '浏览器探测路径（test/ui_test.py）'],
  ['C:\\Windows', '测试夹具里的系统路径反例（cmd.exe / x.md）'],
  ['C:\\Users\\example', '测试夹具虚构用户目录'],
  ['C:\\Users\\Administrator', '测试夹具虚构用户目录'],
  ['C:\\secret', '测试夹具虚构敏感路径（断言不泄露栈内路径）'],
  ['C:\\safe', '测试夹具虚构安全路径（断言 network 请求硬封死）'],
  ['C:\\tools', '测试夹具虚构工具目录（断言命令名是盘符路径即拦）'],
  ['D:\\repo', '注释里的虚构仓库对（"D:\\repo-other" 不得误配 "D:\\repo" 的前缀反例）']
];

/* 虚构用户名清单：配合「真用户名探测」使用（见 scanLeaks 规则 B）。
   为什么单列一份而不并进 BENIGN_ABS：用户名判据要跨平台生效（\Users\ 与 /home/），
   与「整条绝对路径豁免」是两件事，混在一起会让两边都变糊。 */
const FICTIONAL_USERS = [
  'example', 'administrator', 'public', 'user', 'test',
  'me', 'you', 'someone', 'alice', 'bob', 'fake', 'demo'
];

/* 用户目录段：同时认 Windows 的 Users 与类 Unix 的 home（macOS 的 Users 已在其中）。
 *
 * 用户名只收「字母 / 数字 / . _ - / 汉字」。早先收的是「除分隔符外全部收」，
 * 结果注释里的全角括号、日式引号被当成用户名的一部分 —— 门禁把本文件自己写的
 * 说明文字报成泄露（实测两次，都发生在这个文件里）。限定字符集后，
 * `home/）` 这种直接不算匹配，而 `home/张三` 仍能命中（中文用户名不能漏）。 */
const USER_DIR_RE = /[\\/](?:Users|home)[\\/]([A-Za-z0-9._\-\p{Script=Han}]+)/gu;

/* ============================================================
 * 四、凭据形态（与绝对路径分开，命中即违规，无豁免）
 * ============================================================ */
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{16,}/, 'OpenAI/DeepSeek 风格 API Key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub Token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS Access Key'],
  [/BEGIN [A-Z ]*PRIVATE KEY/, '私钥 PEM 块'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack Token']
];

/* ============================================================
 * 五、匹配与枚举
 * ============================================================ */

/* 需要转义的 glob 元字符表。
   刻意用映射表而不是正则字符类 —— 字符类里要写 $ 与花括号，放进本文件会被
   外层模板当作插值起点、被反引号打断，是「工具本身被自己的转义绊倒」的经典坑。 */
const GLOB_ESCAPE = {
  '.': 1, '+': 1, '^': 1, '$': 1, '{': 1, '}': 1,
  '(': 1, ')': 1, '|': 1, '[': 1, ']': 1, '\\': 1
};

/**
 * 把 glob 转成正则（不引入依赖：本仓 tools/ 零依赖是既定风格）。
 *
 * 🔴 2026-10-27（P4-1）：**允许直接传 RegExp**，原样使用。
 *   为什么需要：glob 只支持 `*` / `**`，而「排除整个目录但放行其中一个文件」
 *   这种语义没法用 glob 表达 —— 试过的三种写法全失败（实测）：
 *     ① `!.workbuddy/...` 否定语法 → classify 用 find 取第一个命中，不支持；
 *     ② `*.json` / `.workbuddy/**` 通配 → EXCLUDE 优先，把要放行的也挡了；
 *     ③ 在 glob 里写负向断言 `(?!...)` → 被 GLOB_ESCAPE 转义成字面量，两条都 false。
 *   所以加一条最小扩展：glob 为 RegExp 时直接用，不做转义。
 */
function globToRe(glob) {
  if (glob instanceof RegExp) return glob;
  let s = '';
  for (const ch of glob) {
    if (ch === '*') { s += '*'; continue; }
    s += GLOB_ESCAPE[ch] ? '\\' + ch : ch;
  }
  s = s.replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*');
  return new RegExp('^' + s + '$');
}
const INCLUDE_RE = INCLUDE.map(g => ({ glob: g, re: globToRe(g) }));
const EXCLUDE_RE = EXCLUDE.map(pair => ({ glob: pair[0], re: globToRe(pair[0]), why: pair[1] }));

/** 定位 git 可执行文件。
 *
 *  为什么不能只靠 PATH：本机（AGENTS.md 已载明）git 以 MinGit 形式装在 WinGet 目录，
 *  PATH 里没有 git —— 直接写 'git' 会让门禁崩掉，而门禁崩掉和门禁不设防一样危险。
 *  为什么不能写死绝对路径：本文件自己就在公开导出集里，写死等于自己泄露开发机路径。
 *  所以按环境变量拼标准安装位置：不含任何硬编码盘符，换机器也能用。 */
function resolveGit() {
  if (process.env.LIFE_GIT) return process.env.LIFE_GIT;
  const cands = ['git'];
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    for (const r of roots) {
      cands.push(path.join(r, 'Programs', 'Git', 'cmd', 'git.exe'));
      cands.push(path.join(r, 'Git', 'cmd', 'git.exe'));
    }
    const winget = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(winget)) {
        if (/^Git\./i.test(d)) cands.push(path.join(winget, d, 'cmd', 'git.exe'));
      }
    } catch (e) { /* 没装 WinGet 版就跳过，不是错误 */ }
  }
  for (const c of cands) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch (e) { /* 试下一个 */ }
  }
  return null;
}

let _git = null;
function gitExe() {
  if (_git === null) _git = resolveGit();
  if (!_git) {
    throw new Error('找不到 git 可执行文件，无法确定已跟踪文件集；公开发布剥离器拒绝在未知集合上放行。'
      + '可用环境变量 LIFE_GIT 指定 git 路径。');
  }
  return _git;
}

/** 已跟踪文件清单（用 -z 分隔：避免 core.quotepath 把中文路径转义成八进制串导致匹配失败）。 */
function listTrackedFiles(cwd) {
  const out = execFileSync(gitExe(), ['ls-files', '-z'], {
    cwd: cwd || ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe']
  });
  return String(out).split('\u0000').filter(Boolean);
}

/** 分类：INCLUDE 命中 → 公开；EXCLUDE 命中 → 挡住（带理由）；都没命中 → unclassified。 */
function classify(files) {
  const included = [];
  const excluded = [];
  const unclassified = [];
  const hits = new Map();
  const bump = g => hits.set(g, (hits.get(g) || 0) + 1);

  /* 2026-10-27（P4-1）最终状态：**本函数内没有任何例外逻辑，也不需要**。
   *
   *   `.workbuddy/cleanup/known-prefixes.json` 的放行完全由 INCLUDE 里那条精确条目
   *   负责；EXCLUDE 里**不存在**任何能命中它的规则（那条 `.workbuddy/**` 及
   *   其负向断言版本都已删除，因为它们必然零命中 —— 详见 EXCLUDE 段顶部注释）。
   *
   *   ⚠️ 此处曾有一条注释说「例外已由 EXCLUDE 的负向断言 `(?!...)` 表达」——
   *   那是修复过程中的遗留：该规则后来被删了，注释没跟着删。
   *   审核实测「EXCLUDE 段内 `(?!` 出现 0 次」把它抓了出来。
   *   教训：**删代码时同步删/改注释**，否则注释会变成误导后来者的假事实。
   */

  for (const f of files) {
    const ex = EXCLUDE_RE.find(r => r.re.test(f));
    if (ex) { excluded.push({ file: f, reason: ex.why }); bump(ex.glob); continue; }
    const inc = INCLUDE_RE.find(r => r.re.test(f));
    if (inc) { included.push(f); bump(inc.glob); continue; }
    unclassified.push(f);
  }
  // 死规则 = 写了却一个文件都没命中（规则腐烂的早期信号）。
  //
  // 但两类要分开：「include 规则一条都没命中」在任何形态下都是错的（你以为在发布某类
  // 文件，其实没有）；而「exclude 规则一条都没命中」只在**本次确实有文件被挡住**时才有
  // 意义 —— 公开库形态下被挡集合本来就是空的（里面没有内部文件），该判据不可判定。
  // 若不分开，剥离工具一旦被发布，它会让公开库自己的 CI 变红：实测公开库形态是
  // 291 个文件全部入选、0 个被挡，于是 28 条 exclude 规则会集体变成「死规则」。
  const includeDead = INCLUDE
    .map(g => ({ kind: 'include', rule: g, n: hits.get(g) || 0 }))
    .filter(r => r.n === 0);
  const excludeDead = excluded.length === 0 ? [] : EXCLUDE
    .map(pair => ({ kind: 'exclude', rule: pair[0], n: hits.get(pair[0]) || 0 }))
    .filter(r => r.n === 0);
  return { included, excluded, unclassified, deadRules: includeDead.concat(excludeDead) };
}

/* ============================================================
 * 六、扫描：绝对路径 / 凭据 / 相对链接
 * ============================================================ */

const TOKEN_STOP = /[\s\u0060'"()<>\[\]|,;，。、]/;

/** 把一行里每个盘符路径起点之后的 token 切出来。 */
function absPathTokens(line) {
  const out = [];
  // 前置字符不能是字母数字：否则 https:// 里的 `s:` / `p:` 会被当成盘符（实测踩过，599 处假阳性）。
  const re = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/g;
  let m;
  while ((m = re.exec(line))) {
    let end = m.index + 2;
    while (end < line.length && !TOKEN_STOP.test(line[end])) end++;
    out.push(line.slice(m.index, end));
  }
  return out;
}

/** 归一化路径：反斜杠连续串压成一个、分隔符统一成 /、小写。
 *
 *  为什么必须归一化：源码里的字符串字面量是**转义后**的形态（'C:\\Users\\example' 在磁盘上
 *  是双反斜杠），不压缩就会让豁免清单里的单反斜杠永远匹配不上 —— 实测第一版 34 处误报里
 *  有 26 处是这一个原因。 */
function normPath(s) {
  return s.replace(/\\{2,}/g, '\\').replace(/\\/g, '/').toLowerCase();
}

function isBenignAbs(token) {
  const t = normPath(token);
  return BENIGN_ABS.some(pair => {
    const b = normPath(pair[0]);
    // 双向前缀：token 落在豁免根之下（C:/users/example/desktop），或 token 只是豁免根的前半截
    // （'C:\Program Files' 中间有空格，会被 token 切分截成 'C:\Program'）。
    return t.startsWith(b) || b.startsWith(t);
  });
}

/** 判断一个绝对路径 token 是否根本不像「位置」：只有盘符（C:\ 、C:/ ）或带省略号（C:\...\x）。
 *
 *  这两类出现在注释里表示的是**形状**而不是位置 —— src/agent-interfaces.js:67 的
 *  「C:\ 或 C:/」讲的是判据、:221 的 C:\...\notes.txt 讲的是「路径冒充命令」的反例。
 *  把它们当泄露报出来，等于让门禁对着注释里的语法说明报警。 */
function looksLikeShapeNotLocation(token) {
  const afterDrive = token.slice(2);
  if (!/[A-Za-z0-9]/.test(afterDrive)) return true;   // 只剩分隔符
  return token.indexOf('...') >= 0;                    // 省略号 = 缩写，不是位置
}

/** 扫描公开集里的开发机绝对路径与凭据。返回 [{file, line, kind, text}]。
 *
 *  两条规则，刻意不对称：
 *
 *  规则 A（绝对路径，只管非 test 文件）：默认违规 + 显式豁免。
 *    test/ 不适用这条 —— 测试夹具按定义塞满虚构绝对路径（实测 20 处），
 *    逐条豁免会把清单养成几十行，而清单越长越没人看。对测试目录改用规则 B。
 *    代价写明：测试文件里若真出现 D:\某个私人工程 这类路径，规则 A 不拦 —— 这是明知的口子。
 *
 *  规则 B（真用户名，全量生效）：\Users\<名> 或 /home/<名> 的名字不在虚构清单里即违规。
 *    这一条针对的才是真正能指认到人的东西（操作系统用户名），而且不受目录类型影响。
 *    实测它单独就能拦住 2026-10 之前真实存在的 test 内 C:/Users/<真名> 历史形态。
 */
function scanLeaks(files) {
  const violations = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
    for (const v of scanText(content, { inTest: f.startsWith('test/') })) {
      violations.push({ file: f, line: v.line, kind: v.kind, text: v.text });
    }
  }
  return violations;
}

/** 逐行判据本体：与 IO 分离，好让 test/public-export.test.js 用合成文本直接钉住每条规则。
 *
 *  为什么要拆出来：门禁一旦只能对着真实仓库跑，验证「它到底会不会响」就必须去改仓库文件 ——
 *  那是用污染工作树的方式验证门禁，本仓已经栽过一次（变异测试的备份目录不存在，
 *  还原静默失败，源码留在被改坏的状态）。纯函数 + 合成输入才是可复现的验法。 */
function scanText(text, opts) {
  const inTest = !!(opts && opts.inTest);
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    if (!inTest) {
      for (const token of absPathTokens(line)) {
        if (looksLikeShapeNotLocation(token)) continue;
        if (isBenignAbs(token)) continue;
        out.push({ line: i + 1, kind: 'devAbsPath', text: token });
      }
    }
    for (const m of line.matchAll(USER_DIR_RE)) {
      if (FICTIONAL_USERS.indexOf(m[1].toLowerCase()) >= 0) continue;
      out.push({ line: i + 1, kind: 'realUserDir', text: m[0] });
    }
    for (const pair of SECRET_PATTERNS) {
      if (pair[0].test(line)) out.push({ line: i + 1, kind: 'secret', text: pair[1] });
    }
  });
  return out;
}

/** 校验公开集内部的相对 Markdown 链接都能解析到公开集里的真实文件。
 *
 *  这类断链在私有库不痛不痒（本地能点开），一旦公开就是「文档指向一个不存在/没发布的东西」。
 *  实测存量 4 条：docs/ROADMAP 少写 ./、docs/v1.1 的 src/ 少一级 ../。 */
function checkLinks(files) {
  const set = new Set(files);
  const broken = [];
  for (const f of files) {
    if (!/\.md$/i.test(f)) continue;
    let content;
    try { content = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
    const base = path.posix.dirname(f);
    content.split('\n').forEach((line, i) => {
      const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
      let m;
      while ((m = re.exec(line))) {
        let href = m[1];
        if (/^(https?:|mailto:|file:|#)/i.test(href)) continue;
        href = href.split('#')[0].split('?')[0];
        if (!href) continue;
        let target;
        try { target = decodeURIComponent(href); } catch (e) { target = href; }
        target = target.startsWith('/') ? target.slice(1) : path.posix.join(base, target);
        target = path.posix.normalize(target);
        if (set.has(target)) continue;
        broken.push({
          file: f, line: i + 1, target,
          reason: fs.existsSync(path.join(ROOT, target)) ? 'EXCLUDED' : 'MISSING'
        });
      }
    });
  }
  return broken;
}

/** 汇总报告（release-check 与测试都走这个入口，避免两套口径）。 */
function report() {
  const c = classify(listTrackedFiles());
  return {
    included: c.included,
    excluded: c.excluded,
    unclassified: c.unclassified,
    deadRules: c.deadRules,
    leaks: scanLeaks(c.included),
    brokenLinks: checkLinks(c.included)
  };
}

/* ============================================================
 * 七、同步到公开工作树（--sync）
 *
 * 为什么要有这个子命令：把公开集铺进一个已存在的公开库工作树，本来就是「清空 + 复制」，
 * 而手工在 PowerShell 里敲 rm -rf * 是三件事同时做错的经典场景 ——
 * 通配符漏掉点开头目录、文件被占用中途失败留下半棵残树、以及最要命的「敲在了错误的目录里」。
 * 收进这里之后，破坏动作只发生在过了三道守卫的目标上，且永远不碰 .git。
 * ============================================================ */

function syncGuardError(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

/** 校验并返回可安全清空的目标工作树绝对路径。
 *
 *  三道守卫（任意一道不过就拒绝，且拒绝时不落任何文件系统改动）：
 *    1. 目标必须存在且是 Git 工作树（.git 可能是目录，也可能是 linked worktree 的指针文件）；
 *    2. 目标与私有库根目录不得相等、也不得互相包含 —— 防「在仓库里执行清空」把源码删光；
 *    3. 目标必须正好是工作树根，且工作树干净 —— 否则清空会吞掉别人未提交的改动。 */
function assertSyncTarget(dest) {
  const resolved = path.resolve(dest);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw syncGuardError('NOT_FOUND', '目标不存在或不是目录：' + resolved);
  }
  // 重叠检查排在 .git 检查之前：安全判据优先于可用性判据。
  // 否则「仓库内的某个子目录」会先被打成 NOT_GIT，看起来像配置问题而不是危险操作。
  const a = resolved.toLowerCase();
  const b = ROOT.toLowerCase();
  const sep = path.sep.toLowerCase();
  if (a === b || a.indexOf(b + sep) === 0 || b.indexOf(a + sep) === 0) {
    throw syncGuardError('SELF_OR_NESTED', '目标与私有库目录重叠（相等或互相包含），拒绝清空：' + resolved);
  }
  if (!fs.existsSync(path.join(resolved, '.git'))) {
    throw syncGuardError('NOT_GIT', '目标不是 Git 工作树（缺 .git）：' + resolved);
  }
  let top = '';
  let dirty = '';
  try {
    top = String(execFileSync(gitExe(), ['-C', resolved, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).trim();
    dirty = String(execFileSync(gitExe(), ['-C', resolved, 'status', '--porcelain'], { encoding: 'utf8' })).trim();
  } catch (e) {
    throw syncGuardError('NOT_GIT', '目标不是可用的 Git 工作树：' + String(e.message || e));
  }
  if (path.resolve(top).toLowerCase() !== a) {
    throw syncGuardError('NOT_TOPLEVEL', '目标不是工作树根（实际根目录为 ' + top + '），拒绝清空');
  }
  if (dirty) {
    throw syncGuardError('DIRTY', '目标工作树有未提交改动，拒绝覆盖：' + dirty.split('\n')[0]);
  }
  return resolved;
}

/** 用公开集覆盖目标工作树。返回 { removed, copied }。
 *
 *  🔴 只删「目标工作树里**已跟踪**」的文件，不整目录清空。
 *     整目录清空的写法（第一版就是那样）会连 node_modules / dist / .workbuddy 一起删掉 ——
 *     而 .workbuddy 在本仓是审计证据与清理脚本（见 .gitignore 里的注释），
 *     删它属于「同步一次公开库，顺手毁掉私有侧的证物」。实测这个工作树里这三样都在。
 *     只按 tracked 列表删，还能保证「目标里已跟踪但不应公开的文件」被正确移除。 */
function syncToWorktree(target, files) {
  const tracked = listTrackedFiles(target);
  let removed = 0;
  for (const f of tracked) {
    const full = path.join(target, f);
    try {
      if (fs.statSync(full).isFile()) { fs.rmSync(full, { force: true }); removed++; }
    } catch (e) { /* 文件本就不在盘上（半截工作树），跳过 */ }
  }
  let copied = 0;
  for (const f of files) {
    const to = path.join(target, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), to);
    copied++;
  }
  return { removed, copied };
}

/* ============================================================
 * 八、CLI
 * ============================================================ */
function main(argv) {
  const has = f => argv.includes(f);
  let r;
  try {
    r = report();
  } catch (e) {
    console.error('FAIL  ' + e.message);
    process.exit(1);
  }

  if (has('--list')) {
    console.log('公开集 ' + r.included.length + ' 个文件：');
    r.included.forEach(f => console.log('   + ' + f));
    console.log('');
    console.log('挡住 ' + r.excluded.length + ' 个文件：');
    r.excluded.forEach(x => console.log('   - ' + x.file + '   ← ' + x.reason));
    if (r.unclassified.length) {
      console.log('');
      console.log('未分类（既不在 INCLUDE 也不在 EXCLUDE，默认拒绝）：');
      r.unclassified.forEach(f => console.log('   ? ' + f));
    }
    return;
  }

  const outIdx = argv.indexOf('--out');
  if (outIdx >= 0) {
    const dest = path.resolve(argv[outIdx + 1] || '');
    if (!argv[outIdx + 1]) { console.error('FAIL  --out 需要一个目标目录'); process.exit(1); }
    // 用「是否以仓库根为前缀」判断，不要用 path.relative 的 '..' 判断：
    // Windows 上跨盘符时 relative 会直接返回绝对路径（因为无法表达相对关系），
    // 于是「D 盘仓库 → C 盘 TEMP」会被误判成「在仓库内」而遭到拒绝（实测踩过）。
    const insideRepo = dest === ROOT || dest.indexOf(ROOT + path.sep) === 0;
    if (insideRepo) { console.error('FAIL  导出目标不得落在仓库目录内：' + dest); process.exit(1); }
    if (fs.existsSync(dest) && fs.readdirSync(dest).length && !has('--force')) {
      console.error('FAIL  目标目录非空，需显式 --force：' + dest); process.exit(1);
    }
    for (const f of r.included) {
      const to = path.join(dest, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), to);
    }
    console.log('已导出 ' + r.included.length + ' 个文件 → ' + dest);
    return;
  }

  const syncIdx = argv.indexOf('--sync');
  if (syncIdx >= 0) {
    const dest = argv[syncIdx + 1];
    if (!dest || dest.indexOf('--') === 0) { console.error('FAIL  --sync 需要一个目标工作树目录'); process.exit(1); }
    let target;
    try {
      target = assertSyncTarget(dest);
    } catch (e) {
      console.error('FAIL  --sync 守卫拦下（' + (e.reason || 'UNKNOWN') + '）：' + e.message);
      process.exit(1);
    }
    const apply = has('--yes');
    const tracked = listTrackedFiles(target);
    console.log('目标工作树: ' + target);
    console.log('将重写目标已跟踪的 ' + tracked.length + ' 个文件，铺入公开集 ' + r.included.length + ' 个文件');
    console.log('未跟踪内容（node_modules / dist / .workbuddy 等）原样保留，.git 永不触碰');
    if (!apply) {
      console.log('（预演）确认无误后加 --yes 才会真正执行');
      return;
    }
    const res = syncToWorktree(target, r.included);
    console.log('已删除旧内容 ' + res.removed + ' 个文件，铺入 ' + res.copied + ' 个文件');
    console.log('下一步（在该工作树内执行）:');
    console.log('  git add -A');
    console.log('  git commit -m "feat(v1.6): 同步 v1.2~v1.6 全部代码、测试与规划文档"');
    return;
  }

  // 默认 = --check
  let bad = 0;
  if (r.unclassified.length) {
    bad++;
    console.log('FAIL  [未分类文件] ' + r.unclassified.length + ' 个：' + r.unclassified.slice(0, 8).join(', '));
  }
  if (r.deadRules.length) {
    bad++;
    console.log('FAIL  [死规则] ' + r.deadRules.length + ' 条一个文件都没命中：'
      + r.deadRules.map(x => x.kind + ':' + x.rule).join(', '));
  }
  if (r.leaks.length) {
    bad++;
    console.log('FAIL  [开发机路径/凭据] ' + r.leaks.length + ' 处：');
    r.leaks.slice(0, 10).forEach(v => console.log('        ' + v.file + ':' + v.line + '  ' + v.kind + '  ' + v.text));
  }
  if (r.brokenLinks.length) {
    bad++;
    console.log('FAIL  [公开集内断链] ' + r.brokenLinks.length + ' 条：');
    r.brokenLinks.slice(0, 10).forEach(b => console.log('        ' + b.file + ':' + b.line + ' -> ' + b.target + '  (' + b.reason + ')'));
  }
  if (bad) {
    console.log('\n公开集 ' + r.included.length + ' 个 / 挡住 ' + r.excluded.length + ' 个：剥离门禁未通过');
    process.exit(1);
  }
  console.log('PASS  公开集 ' + r.included.length + ' 个文件，挡住 ' + r.excluded.length + ' 个；'
    + '绝对路径 0 处、凭据 0 处、断链 0 条');
}

module.exports = {
  INCLUDE,
  EXCLUDE,
  BENIGN_ABS,
  SECRET_PATTERNS,
  globToRe,
  resolveGit,
  listTrackedFiles,
  classify,
  normPath,
  isBenignAbs,
  looksLikeShapeNotLocation,
  absPathTokens,
  scanText,
  scanLeaks,
  assertSyncTarget,
  syncToWorktree,
  checkLinks,
  report
};

if (require.main === module) main(process.argv.slice(2));
