/**
 * 公开发布剥离门禁的测试（v1.6-c）。
 *
 * 为什么要有这个文件：tools/public-export.js 是「能否推公开库」的唯一判据，
 * 而它上线时的第一版就有三个洞（协议被当盘符的 599 处假阳性、转义反斜杠导致的
 * 26 处误报、以及「只测真实仓库所以永远绿」）。门禁不会被自己证伪，必须拿
 * **合成输入**逐条钉住每条规则的方向性 —— 尤其是「该拦的必须拦」这一侧。
 *
 * 本文件刻意不出现任何真实开发机路径的字面量：它会随公开库一起发布。
 * 需要「已知坏串」的地方一律用片段拼装（与旧 release-check 同一手法），
 * 并附注释说明为什么不能直写。
 */
const fs = require('fs');
const path = require('path');

const pe = require(path.join(__dirname, '..', 'tools', 'public-export.js'));

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

/* 已知坏串：拼装而非直写（本文件会被公开，直写等于自己泄露） */
const DEV_REPO = ['D:', ['GAME', 'LIFE'].join('\\')].join('\\');
const PREV_PROJECT = ['D:', 'software', ['GPT', 'gptgirl-v0.9.1-optimized'].join('\\')].join('\\');
const REAL_USER_DIR = ['C:', 'Users', ['and', 'ab'].join('')].join('\\');

/* ---------- 一、glob 语义 ---------- */
check('globToRe: src/** 同时匹配一级与多级',
  pe.globToRe('src/**').test('src/brain.js') && pe.globToRe('src/**').test('src/adapters/deepseek-adapter.js'));
check('globToRe: docs/agent/** 不越界到 docs/ 其它文件',
  !pe.globToRe('docs/agent/**').test('docs/ROADMAP-AND-PUBLIC-RELEASE-PLAN.md')
  && pe.globToRe('docs/agent/**').test('docs/agent/pi-life-runtime-report-2026-09-29.md'));
check('globToRe: 根文件名是精确匹配（README.md 不含 README.en.md）',
  pe.globToRe('README.md').test('README.md') && !pe.globToRe('README.md').test('README.en.md'));

/* ---------- 二、绝对路径识别 ---------- */
check('absPathTokens: 协议不产生 token（https:// 的 s: 曾被当成盘符，599 处假阳性）',
  pe.absPathTokens('see https://github.com/andabaoyue/Life and ftp://x.y/z').length === 0);
check('absPathTokens: 盘符路径能被切出来',
  pe.absPathTokens('path = ' + DEV_REPO + ' ok').length === 1);
check('normPath: 转义双反斜杠压成单反斜杠（否则豁免清单永远匹配不上）',
  pe.normPath('C:\\\\Users\\\\example') === 'c:/users/example');
check('isBenignAbs: 通用系统路径豁免',
  pe.isBenignAbs('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe') === true);
check('isBenignAbs: 转义形态的虚构用户目录也豁免',
  pe.isBenignAbs('C:\\\\Users\\\\example\\\\Desktop') === true);
check('isBenignAbs: 开发机仓库路径不豁免', pe.isBenignAbs(DEV_REPO) === false);
check('isBenignAbs: 前任工程路径不豁免（旧门禁正是在这里放行的）',
  pe.isBenignAbs(PREV_PROJECT) === false);
check('looksLikeShapeNotLocation: 光杆盘符是形状不是位置', pe.looksLikeShapeNotLocation('C:\\') === true);
check('looksLikeShapeNotLocation: 带省略号是缩写不是位置',
  pe.looksLikeShapeNotLocation('C:\\...\\notes.txt') === true);
check('looksLikeShapeNotLocation: 常规绝对路径不是形状',
  pe.looksLikeShapeNotLocation('C:\\Users\\example\\note.md') === false);

/* ---------- 三、逐行判据（scanText） ---------- */
check('scanText: 非 test 文件里的开发机路径被检出',
  pe.scanText('root: ' + DEV_REPO, {}).some(v => v.kind === 'devAbsPath'));
check('scanText: 测试夹具的虚构绝对路径零误报',
  pe.scanText('p = "C:\\\\Users\\\\example\\\\Desktop\\\\LifeSandbox"', {}).length === 0);
check('scanText: test 文件里规则 A 让位（虚构夹具不再逐条豁免）',
  pe.scanText('x = "C:\\\\fake-app\\\\index.html"', { inTest: true }).length === 0);
check('scanText: test 文件里规则 B 仍然生效（真用户名一律拦）',
  pe.scanText('p = "' + REAL_USER_DIR + '\\\\note.md"', { inTest: true })
    .some(v => v.kind === 'realUserDir'));
check('scanText: 虚构用户名不触发规则 B',
  pe.scanText('p = "C:\\\\Users\\\\example\\\\note.md"', { inTest: true }).length === 0);
check('scanText: API Key 形态被检出',
  pe.scanText('key = "sk-' + 'A'.repeat(24) + '"', {}).some(v => v.kind === 'secret'));

/* ---------- 四、分类（默认拒绝） ---------- */
check('classify: 历史审计报告被挡住并带非空理由',
  (() => {
    const r = pe.classify(['COGNITIVE-IDENTITY-AUDIT-REPORT.md']);
    return r.excluded.length === 1 && r.excluded[0].reason.length > 0;
  })());
check('classify: scripts/** 被挡住',
  pe.classify(['scripts/build_authentic_chibi.py']).excluded.length === 1);
check('classify: 白名单内文件被放行',
  pe.classify(['src/brain.js', 'docs/v1.6-IMPLEMENTATION-ORDER.md', 'test/brain.test.js'])
    .included.length === 3);
check('classify: 谁都没认领的文件进 unclassified（默认拒绝，不默认放行）',
  (() => {
    const r = pe.classify(['src/brain.js', 'NEW-INTERNAL-NOTES.md']);
    return r.unclassified.length === 1 && r.unclassified[0] === 'NEW-INTERNAL-NOTES.md';
  })());
check('classify: 死规则会被点出来（规则写歪了不能静默）',
  pe.classify(['src/brain.js']).deadRules.length > 0);
check('EXCLUDE 每条规则都写了理由', pe.EXCLUDE.every(x => typeof x[1] === 'string' && x[1].trim().length > 0));

/* ---------- 五、真实仓库端到端 ---------- */
const rep = pe.report();
check('真实公开集内零开发机路径与零凭据', rep.leaks.length === 0,
  rep.leaks.slice(0, 3).map(v => v.file + ':' + v.line).join(', '));
check('真实公开集内零断链', rep.brokenLinks.length === 0,
  rep.brokenLinks.slice(0, 3).map(b => b.file + ' -> ' + b.target).join(', '));
check('真实仓库零未分类文件（新增顶层文件必须显式表态）', rep.unclassified.length === 0,
  rep.unclassified.join(', '));
check('真实仓库零死规则', rep.deadRules.length === 0,
  rep.deadRules.map(x => x.kind + ':' + x.rule).join(', '));
check('公开集包含 v1.3~v1.6 的代码、测试与规划文档（防发布回退）',
  ['src/fallback-adapter.js', 'src/power-monitor-source.js',
    'test/v13-perception-channel.test.js', 'test/v14-observer-journal.test.js',
    'test/v15-provider-fallback.test.js', 'docs/v1.6-IMPLEMENTATION-ORDER.md',
    '启动初澜.vbs'].every(f => rep.included.indexOf(f) >= 0));
check('公开集不含工具链配置、内部报告与研究脚本',
  !rep.included.some(f => f.indexOf('.pi/') === 0 || f.indexOf('.agents/') === 0
    || f.indexOf('docs/agent/') === 0 || f.indexOf('scripts/') === 0
    || f.indexOf('research/security/') === 0));
/* 变异对照：证明扫描器不是空转。
   判据写成「有就必须抓到」而不是「必须命中 25 处」—— 该私有审计报告只存在于私有研究库，
   公开库形态下根本没有这个文件。若写死命中数，这条断言会让公开库自己的 CI 变红。 */
const PRIVATE_REPORT = 'COGNITIVE-IDENTITY-AUDIT-REPORT.md';
const hasPrivateReport = fs.existsSync(path.join(__dirname, '..', PRIVATE_REPORT));
const privateHits = pe.scanLeaks([PRIVATE_REPORT]).length;
check('扫描器不是空转：私有库形态下该文件必须被抓出（公开库形态退化为无文件可扫，不得报错）',
  hasPrivateReport ? privateHits >= 25 : privateHits === 0,
  hasPrivateReport ? '命中 ' + privateHits + ' 处' : '公开库形态，该文件不存在');

/* ---------- 六、--sync 的三道守卫 ----------
   守卫的价值全在「拒绝」这一侧，所以只断言拒绝分支；放行分支由真实同步那一次运行验证。
   全部用纯路径判据，不建临时目录 —— 临时目录会污染 %TEMP% 前缀表，撞 test/tmp-hygiene.test.js。 */
const PROJECT_ROOT = path.join(__dirname, '..');
function guardReason(target) {
  try { pe.assertSyncTarget(target); return null; } catch (e) { return e.reason || 'UNKNOWN'; }
}
check('sync 守卫：不存在的目标被拒（NOT_FOUND）',
  guardReason(path.join(PROJECT_ROOT, 'no-such-dir-for-sync-guard')) === 'NOT_FOUND');
check('sync 守卫：私有库自身被拒（SELF_OR_NESTED）',
  guardReason(PROJECT_ROOT) === 'SELF_OR_NESTED');
check('sync 守卫：私有库内子目录被拒（SELF_OR_NESTED，而不是误报 NOT_GIT）',
  guardReason(path.join(PROJECT_ROOT, 'src')) === 'SELF_OR_NESTED');
check('sync 守卫：私有库的父目录被拒（SELF_OR_NESTED，否则会连带清空仓库）',
  guardReason(path.join(PROJECT_ROOT, '..')) === 'SELF_OR_NESTED');

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
