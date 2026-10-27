/**
 * test/csv-injection.test.js
 *
 * CSV 公式注入防护门禁（2026-10-20 GPT 审计发现，实测确认后修复）。
 *
 * ## 为什么这是个真问题而不是理论洁癖
 *   实测证据（修复前）：
 *     exportEvidence([{ quote: '=1+1' }], 'csv')  → 单元格原样是 `=1+1`；
 *     形状更狠的 `=cmd|' /C calc'!A1` 同样原样落盘。
 *   Excel / WPS / Numbers 打开 CSV 时，以 `=` `+` `-` `@` 开头的单元格
 *   **会被当成公式执行**。攻击链是真实存在的：
 *     她说过的话（evidence.quote，来自对话，内容不可信）
 *       → 落进 experiences / evidence 归档
 *       → 用户导出 CSV 用 Excel 打开
 *       → DDE 载荷执行（本地代码执行）
 *
 * ## 判据
 *   1. 危险前缀（含前导空白/制表符绕过）的值必须以 `'` 开头（Excel 强制文本）；
 *   2. **正常值一律不受影响**（不因防护而改坏普通数据）；
 *   3. **JSON 导出完全不受影响**（JSON 不是可执行格式，不该被清洗）；
 *   4. **所有格子都要转义**，不能因为"这列本应是数字"就跳过。
 */

const ex = require('../src/research-export');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- CSV 公式注入防护门禁 ---');

/** 从状态轨迹 CSV 里取出 newValue 那一格 */
function trajCell(v) {
  const out = ex.exportStateTrajectory(
    [{ windowNo: 1, trait: 'x', previousValue: 0, delta: 1, newValue: v }], 'csv');
  const rows = out.split('\n');
  return rows[1].split(',').slice(4).join(',');
}

/** 从证据 CSV 里取出 quote 那一格（第 3 列） */
function evCell(v) {
  const out = ex.exportEvidence([{
    evidenceId: 'e1', messageId: 'm1', quote: v, trait: 't',
    status: 'verified', reason: 'r', fingerprint: 'f', windowNo: 1
  }], 'csv');
  return out.split('\n')[1].split(',')[2];
}

const DANGERS = [
  ['=1+1', '等号'],
  ["=cmd|' /C calc'!A1", '经典 DDE'],
  ['+1', '加号'],
  ['-1', '减号'],
  ['@SUM(A1)', 'at 符号'],
  ['\t=1+1', '制表符绕过'],
  ['\r=1+1', '回车绕过'],
  ['   =1+1', '空格绕过']
];

const stripped = (s) => (s.startsWith('"') ? s.slice(1) : s);

/* ---- 1. 状态轨迹 CSV ---- */
for (const [v, label] of DANGERS) {
  const cell = trajCell(v);
  check('轨迹 CSV 阻断公式注入: ' + label,
    stripped(cell).startsWith("'"), 'cell=' + JSON.stringify(cell));
}

/* ---- 2. 证据 CSV（quote 是真正的不可信输入）---- */
for (const [v, label] of DANGERS) {
  const cell = evCell(v);
  check('证据 CSV 阻断公式注入: ' + label,
    stripped(cell).startsWith("'"), 'cell=' + JSON.stringify(cell));
}

/* ---- 3. 正常值必须不受影响 ---- */
{
  const cell = trajCell(42);
  check('正常数字不加前缀', cell === '42', 'cell=' + JSON.stringify(cell));

  const cell2 = evCell('今天下了雨，她说想听雨声');
  check('正常中文不加前缀', cell2 === '今天下了雨，她说想听雨声', 'cell=' + JSON.stringify(cell2));

  const cell3 = evCell('a=b');
  check('等号在中间不加前缀（只防前缀）', cell3 === 'a=b', 'cell=' + JSON.stringify(cell3));

  const cell4 = evCell('');
  check('空串仍为空', cell4 === '', 'cell=' + JSON.stringify(cell4));
}

/* ---- 4. JSON 导出不受影响（JSON 不需要清洗）---- */
{
  const j = ex.exportStateTrajectory(
    [{ windowNo: 1, trait: 'x', previousValue: 0, delta: 1, newValue: '=1+1' }], 'json');
  check('JSON 导出保留原值（不清洗非 CSV 格式）',
    j.includes('"=1+1"'), '片段=' + j.slice(0, 80));

  const je = ex.exportEvidence([{
    evidenceId: 'e1', messageId: 'm1', quote: '=1+1', trait: 't',
    status: 'verified', reason: 'r', fingerprint: 'f', windowNo: 1
  }], 'json');
  check('证据 JSON 导出保留原值', je.includes('=1+1'));
}

/* ---- 5. 源码断言：每个格子都过 escapeCsvCell ---- */
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'research-export.js'), 'utf8');

  // 状态轨迹的 CSV 分支里，五个字段都必须包 escapeCsvCell
  const trajFn = src.slice(src.indexOf('function exportStateTrajectory'), src.indexOf('function exportEvidence'));
  const cells = trajFn.match(/escapeCsvCell\(/g) || [];
  check('🔴 状态轨迹 CSV 的 5 个格子全部转义（不许"本应是数字"就跳过）',
    cells.length >= 5, 'escapeCsvCell 调用数=' + cells.length);

  check('🔴 escapeCsvCell 里存在公式前缀判定',
    /CSV_FORMULA_PREFIXES/.test(src) && /includes\(lead\[0\]\)/.test(src));

  check('🔴 危险前缀清单含 = + - @ 四类',
    /\[.*'='.*'\+'.*'-'.*'@'.*\]/.test(src) || /'='.*'\+'/.test(src));
}

/* ---- 6. 防回归：引号内的危险值也必须加前缀 ---- */
{
  // 含逗号的值会走加引号分支，前缀仍必须在里面
  const cell = evCell('=1,2');
  const s = stripped(cell);
  check('🔴 含逗号 + 公式前缀：引号内的内容仍以 \' 开头',
    s.startsWith('"\'') || s.startsWith("'\"") || s.includes("'=1"),
    'cell=' + JSON.stringify(cell));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
