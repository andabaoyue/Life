/**
 * 门禁自检：test/docs.test.js 的「沙箱假阴性」修复必须长期锁住。
 *
 * 为什么要有这个文件：v1.0 之前 docs.test.js 用 execFileSync 同步跑其它测试，
 * 在部分沙箱环境下 spawnSync 被拦成 EBUSY，于是 91 个套件全被报成 FAIL ——
 * 但那不是测试失败，是环境压根没让跑。危害在于「91 项失败」会被当成真实回归，
 * 或者被误读成「环境问题，可以忽略」，两种都会掩盖真问题。
 *
 * 本文件不重跑全仓（那是 docs.test.js 的活），只断言「调度层的设计正确」：
 *   1. 必须走异步 spawn，代码里不得再拿 execFileSync 当调度器；
 *   2. spawn 完全不可用时要报 SKIP，且结尾必须单独汇总跳过数（不能被0 FAIL 吞掉）；
 *   3. python 解释器不许写死 —— 系统 python 没装 playwright，会让 ui_test.py假失败；
 *   4. SKIP 不得被计成 failure（SKIP ≠ PASS，也 ≠ FAIL）。
 *
 * 注意：本文件自己**不**在 README 的测试块里标项数 —— 它会被 docs.test.js
 * 回收进清单递归调用自己（与 docs.test.js 同样的坑，见其文件头注释）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'test', 'docs.test.js');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

check('test/docs.test.js 存在', fs.existsSync(TARGET));
if (!fs.existsSync(TARGET)) { console.log('\n无法继续'); process.exit(1); }

const src = fs.readFileSync(TARGET, 'utf8');
// 按行切开，避免注释文字干扰（教训：源码断言不能直接 indexOf 整段字符串）
const lines = src.split('\n');

/** 找出真正调用了某API 的代码行（排除注释里出现的同名字符串）。 */
function callLines(pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  return lines
    .map((l, i) => ({ i: i + 1, l }))
    .filter(({ l }) => re.test(l))
    .filter(({ l }) => !/^\s*(\*|\/\/|<!--)/.test(l));   // 纯注释行排除
}

/* 1. 调度器不得再是 execFileSync */
const execCalls = callLines(/execFileSync\s*\(/);
check('docs.test.js 不再拿 execFileSync 当调度器',
  execCalls.length === 0,
  execCalls.length ? '第 ' + execCalls.map(x => x.i).join(',') + ' 行仍在调用' : '');

/* 2. 必须走异步 spawn */
const asyncSpawn = callLines(/\bspawn\s*\(/);
check('docs.test.js 走异步 spawn 调度', asyncSpawn.length > 0,
  '找到 ' + asyncSpawn.length + ' 处 spawn 调用');

/* 3. spawn 被禁时必须报 SKIP，且结尾单独汇总 —— 否则「0 FAIL」会掩盖「什么都没跑」 */
check('存在 SPAWN_UNSUPPORTED 判据（spawn 被禁时识别得出）',
  /SPAWN_UNSUPPORTED/.test(src));
check('存在 SKIP 通道（跑不了≠测试失败）', /\bSKIP\b/.test(src));
check('跳过项在结尾单独汇总（避免被 0 FAIL 吞掉）',
  /skipped\s*\?\s*'（另有 /.test(src) || /另有\s*'\s*\+\s*skipped/.test(src)
  || /跳过明细/.test(src));
check('SKIP 不计入 failures（SKIP 既非 PASS 也非 FAIL）',
  /function skip\(/.test(src) && /skipList\.push/.test(src)
  && !/function skip\([^)]*\)\s*\{[^}]*failures\+\+/.test(src));

/* 4. python 解释器不许写死 —— 系统 python 没 playwright，会让 ui_test.py 假失败 */
const hardcodedPy = callLines(/['"]python3?['"]\s*$/).filter(({ l }) =>
  /spawn\(|spawnSync\(|execFileSync\(/.test(l));
check('.py 解释器不再直接写死 python', hardcodedPy.length === 0,
  hardcodedPy.length ? '第 ' + hardcodedPy.map(x => x.i).join(',') + ' 行' : '');
check('python 解释器可经DESPET_PY 覆盖', /DESPET_PY/.test(src));
check('探测 playwright 可用性（缺依赖报 SKIP 而非假 FAIL）',
  /hasPlaywright/.test(src));

/* 5. 依赖缺失要走 SKIP，不能报 FAIL —— 这正是 ui_test.py 假失败的根因 */
check('ModuleNotFoundError 判定为环境限制（SKIP）',
  /ModuleNotFoundError/.test(src));

/* 5b. 同源病根的第二处：test/deepseek.test.js 自己内部也曾用 execFileSync 设 TZ 跑子进程，
   撞上同一个EBUSY —— README 写 32 项，实际只跑出 15 项。必须一起锁住，否则只修门禁不够。 */
const DS = path.join(ROOT, 'test', 'deepseek.test.js');
check('test/deepseek.test.js 存在', fs.existsSync(DS));
if (fs.existsSync(DS)) {
  const dsLines = fs.readFileSync(DS, 'utf8').split('\n');
  const dsCall = dsLines
    .map((l, i) => ({ i: i + 1, l }))
    .filter(({ l }) => /execFileSync\s*\(/.test(l))
    .filter(({ l }) => !/^\s*(\*|\/\/)/.test(l));
  check('deepseek.test.js 不再用 execFileSync 起子进程（同源EBUSY 假阴性）',
    dsCall.length === 0,
    dsCall.length ? '第 ' + dsCall.map(x => x.i).join(',') + ' 行' : '');
  check('deepseek.test.js 改走异步 spawn', /\bspawn\s*\(/.test(fs.readFileSync(DS, 'utf8')));
}

/* 6. 排版自检：README 测试块里**不能给本文件标项数** ——
    docs.test.js 的回收正则要求「文件 + # + N项」，标了项数就会被它当普通套件跑，
    而本文件断言的是 docs.test.js 自己的设计，会形成不必要的自举。
    注意：README **必须**提到本文件名（否则 release-check 与 docs.test.js
    的「每个测试都被点名」会 FAIL），只是不标项数 —— 与 docs.test.js 自身的做法一致。 */
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const block = readme.match(/## 测试[\r\n]+```bash[\r\n]+([\s\S]*?)```/);
check('README 有「测试」代码块', !!block);
const selfName = path.basename(__filename);
const selfLine = block ? block[1].split('\n').find(l => l.includes(selfName)) : null;
check('README 已登记本文件（否则门禁报「未被点名」）', !!selfLine, selfName || '');
check('README 没给本文件标项数（否则被 docs.test.js 回收自举）',
  !!selfLine && !/(\d+)\s*项/.test(selfLine), selfLine ? selfLine.trim() : '');

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
