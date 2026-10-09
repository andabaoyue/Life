/**
 * ExperiencesArchive (experiences.jsonl) 单元测试
 * 
 * 检验点：
 * 1. 严格 Append-Only，落盘格式为合法 JSON 行
 * 2. 永不被 maxEntries 裁剪或删除
 * 3. 完整保存 5x20 分段经历、Window Synthesis、状态证据与 Provenance
 * 4. 按窗口号检索与全量读取容错
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExperiencesArchive } = require('../src/experiences-archive');

// [D-8a] 临时目录清理：本文件此前 0 处清理，单次跑净留 1 个 %TEMP% 沙盒。
// 手法是包住 fs.mkdtempSync 本身（不逐个改调用点：形态太杂，且新增调用点会自动被覆盖）。
// ⚠️ 本仓 %TEMP% 累积曾达 39221 个 / 55 种前缀，用户投诉过同类问题。
const _d8aDirs = [];
const _d8aOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _d8aOrigMkdtemp.apply(fs, a);
  _d8aDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _d8aDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdtempSync = _d8aOrigMkdtemp;
});

let total = 0;
let passed = 0;
let failures = 0;
function check(name, cond, extra) {
  total++;
  if (cond) passed++; else failures++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-')); }

const dir = tmpDir();
const archive = new ExperiencesArchive(dir);

// 1. 初始化
check('初始记录数为 0', archive.count() === 0);
check('readAll 初始为空数组', Array.isArray(archive.readAll()) && archive.readAll().length === 0);

// 2. append 单条记录
const r1 = archive.append({
  type: 'custom',
  data: 'test-1'
});
check('append 成功落盘', r1 && archive.count() === 1);
const records1 = archive.readAll();
check('readAll 读出单条记录且自动附加 createdAt',
  records1.length === 1 && records1[0].data === 'test-1' && typeof records1[0].createdAt === 'number');

// 3. appendWindowArchive 归档完整 5x20 窗口
const sampleWindow = {
  windowNo: 1,
  turns: 100,
  messageCount: 200,
  segments: [
    {
      range: '1-20',
      userGiven: ['用户叫阿哲'],
      chulanExperience: ['初澜感受到安静的对话氛围'],
      stateEvidence: [
        { trait: 'quiet_preference', direction: 1, strength: 0.8, messageId: 'm-000005', quote: '安静' }
      ]
    },
    { range: '21-40', userGiven: [], chulanExperience: [], stateEvidence: [] },
    { range: '41-60', userGiven: [], chulanExperience: [], stateEvidence: [] },
    { range: '61-80', userGiven: [], chulanExperience: [], stateEvidence: [] },
    { range: '81-100', userGiven: [], chulanExperience: [], stateEvidence: [] }
  ],
  windowSynthesis: {
    stableUserFacts: ['用户叫阿哲'],
    subjectExperiences: ['倾向于安静平稳的交流'],
    stateChangesSuggested: [
      { trait: 'quiet_preference', direction: 1, strength: 0.8, messageId: 'm-000005', quote: '安静' }
    ]
  },
  verifiedEvidence: [
    { trait: 'quiet_preference', direction: 1, strength: 0.8, messageId: 'm-000005', quote: '安静' }
  ],
  rejectedEvidence: []
};

const r2 = archive.appendWindowArchive(sampleWindow);
check('appendWindowArchive 成功追加完整窗口', r2 && archive.count() === 2);

// 4. 按窗口号检索
const w1Records = archive.getByWindow(1);
check('getByWindow(1) 成功筛选出窗口记录',
  w1Records.length === 1 &&
  (w1Records[0].recordType === 'window_summary' || w1Records[0].recordType === 'window_archive' || w1Records[0].type === 'window_archive') &&
  w1Records[0].windowNo === 1);
const w1Payload = w1Records[0].payload || w1Records[0];
check('归档中包含完整的 5 个 segments 与 windowSynthesis',
  w1Payload.segments.length === 5 && w1Payload.windowSynthesis.stableUserFacts[0] === '用户叫阿哲');
check('getByWindow(2) 不存在时返回空数组', archive.getByWindow(2).length === 0);

// 5. 持续追加不截断（验证 Append-Only 无 maxEntries 限制）
for (let i = 2; i <= 250; i++) {
  archive.appendWindowArchive({
    windowNo: i,
    turns: 100,
    segments: [],
    windowSynthesis: { stableUserFacts: [`fact-${i}`] }
  });
}
check('经历档案突破 200 条限制持续追加不被裁剪', archive.count() === 251);
const allRecords = archive.readAll();
check('历史最旧的第 1 条与最新的第 251 条均完好留存',
  allRecords[0].data === 'test-1' && allRecords[250].windowNo === 250);

// 6. 底层文件 JSONL 格式合法性
const rawLines = fs.readFileSync(archive.path, 'utf8').trim().split('\n');
check('底层文件每行均为独立合法 JSON', rawLines.length === 251 && rawLines.every(l => {
  try { JSON.parse(l); return true; } catch { return false; }
}));

// 7. 异常容错
check('append 传入非法参数不崩溃', !archive.append(null) && !archive.append(undefined));

// 8. P1-1 (S6): Legacy 归档显式迁移边界与多次追加完整性
{
  const legacyDir = tmpDir();
  const legacyFile = path.join(legacyDir, 'experiences.jsonl');
  const legacy1 = {
    compatibilityAdapter: 'LegacySchemaAdapter',
    sourceSchema: 'legacy-v0.9.4',
    recordType: 'window_summary',
    payload: { rawSummaryText: '旧经历1' },
    timestamp: 1000
  };
  const legacy2 = {
    compatibilityAdapter: 'LegacySchemaAdapter',
    sourceSchema: 'legacy-v0.9.4',
    recordType: 'window_summary',
    payload: { rawSummaryText: '旧经历2' },
    timestamp: 2000
  };
  fs.writeFileSync(legacyFile, JSON.stringify(legacy1) + '\n' + JSON.stringify(legacy2) + '\n', 'utf8');
  const legArchive = new ExperiencesArchive(legacyDir);

  const r1 = legArchive.appendRecord('window_summary', 1, { rawSummaryText: '新经历1' });
  const r2 = legArchive.appendRecord('window_summary', 2, { rawSummaryText: '新经历2' });
  const r3 = legArchive.appendRecord('window_summary', 3, { rawSummaryText: '新经历3' });
  const recs = legArchive.readAll();
  const chainOk = r1 === true && r2 === true && r3 === true &&
    recs.length === 5 &&
    recs[2].archiveSeq === 1 && recs[2].prevHash === 'GENESIS' &&
    recs[3].archiveSeq === 2 && recs[3].prevHash === recs[2].recordHash &&
    recs[4].archiveSeq === 3 && recs[4].prevHash === recs[3].recordHash;
  check('S6: 合法 Legacy 前缀下多次连续追加现代记录成功且因果链自洽', chainOk);

  // 锚点与 Genesis 锚点检验
  const anchorPath = legacyFile + '.anchor.json';
  let anchorValid = false;
  try {
    const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
    anchorValid = !!anchor && anchor.archiveSeq === 3 &&
      anchor.recordHash === recs[4].recordHash &&
      anchor.genesis && anchor.genesis.archiveSeq === 1 &&
      anchor.genesis.recordHash === recs[2].recordHash &&
      anchor.legacyMigration && anchor.legacyMigration.legacyPrefixCount === 2;
  } catch {}
  check('S6: 成功生成包含 legacyMigration 显式边界与 Genesis 的尾部锚点', anchorValid);

  // 反向守卫 A：伪造/非 legacy 标记缺链记录被严格拦截
  const fakeDir = tmpDir();
  const fakeFile = path.join(fakeDir, 'experiences.jsonl');
  const forged = {
    schemaVersion: 1,
    recordType: 'window_summary',
    recordId: 'rec-forged-p11',
    timestamp: Date.now(),
    windowNo: 1,
    payload: { rawSummaryText: '伪造记录' },
    sourceSchema: 'legacy-v0.9.4'
  };
  fs.writeFileSync(fakeFile, JSON.stringify(forged) + '\n', 'utf8');
  const fakeArchive = new ExperiencesArchive(fakeDir);
  const fakeAppended = fakeArchive.appendRecord('window_summary', 1, { rawSummaryText: '伪造后追加' });
  check('S6 反向守卫 A: 伪造 sourceSchema 缺链记录被 fail-closed 拦截', fakeAppended === false);

  // 反向守卫 B: 现代链开启后尾部又混入 legacy 记录被拦截
  const mixedDir = tmpDir();
  const mixedFile = path.join(mixedDir, 'experiences.jsonl');
  const mixedArchive = new ExperiencesArchive(mixedDir);
  mixedArchive.appendRecord('window_summary', 1, { rawSummaryText: '现代1' });
  fs.appendFileSync(mixedFile, JSON.stringify(legacy1) + '\n', 'utf8');
  const mixedAppended = mixedArchive.appendRecord('window_summary', 2, { rawSummaryText: '现代2' });
  check('S6 反向守卫 B: 现代链尾部混入 legacy 记录被 fail-closed 拦截', mixedAppended === false);

  // 反向守卫 C: 篡改 legacy 前缀数量导致与 anchor.legacyMigration 不匹配被拦截
  const tamperDir = tmpDir();
  const tamperFile = path.join(tamperDir, 'experiences.jsonl');
  fs.writeFileSync(tamperFile, JSON.stringify(legacy1) + '\n' + JSON.stringify(legacy2) + '\n', 'utf8');
  const tamperArchive = new ExperiencesArchive(tamperDir);
  tamperArchive.appendRecord('window_summary', 1, { rawSummaryText: '新经历1' });
  const curContent = fs.readFileSync(tamperFile, 'utf8');
  fs.writeFileSync(tamperFile, JSON.stringify(legacy1) + '\n' + curContent, 'utf8');
  const tamperAppended = tamperArchive.appendRecord('window_summary', 2, { rawSummaryText: '新经历2' });
  check('S6 反向守卫 C: 篡改 legacy 前缀导致与迁移锚点失配被 fail-closed 拦截', tamperAppended === false);

  // 反向守卫 D (R-S6): 纯现代归档（anchor 无 legacyMigration）头部被注入 legacy 记录必须被拦截
  const modernInjectDir = tmpDir();
  const modernInjectFile = path.join(modernInjectDir, 'experiences.jsonl');
  const modernArchive = new ExperiencesArchive(modernInjectDir);
  modernArchive.appendRecord('window_summary', 1, { rawSummaryText: '纯现代1' });
  modernArchive.appendRecord('window_summary', 2, { rawSummaryText: '纯现代2' });
  const rawModern = fs.readFileSync(modernInjectFile, 'utf8');
  fs.writeFileSync(modernInjectFile, JSON.stringify(legacy1) + '\n' + rawModern, 'utf8');
  const injectAppended = modernArchive.appendRecord('window_summary', 3, { rawSummaryText: '纯现代3' });
  check('R-S6 反向守卫 D: 纯现代归档头部注入 legacy 记录被 fail-closed 拦截', injectAppended === false);

  // M9: 归档窗口摘要时，未提供 closeReason 保持 null（不凭空伪造为 turn_limit）
  const m9Dir = tmpDir();
  const m9Archive = new ExperiencesArchive(m9Dir);
  const ok = m9Archive.appendWindowArchive({ windowNo: 1, rawSummaryText: '无关闭原因摘要' });
  const records = m9Archive.readAll();
  check('M9: closeReason 缺失时如实为 null（不伪造 turn_limit）',
    ok === true && records.length === 1 && records[0].payload && records[0].payload.closeReason === null);
}

console.log(`ASSERT total=${total} passed=${passed} failed=${failures}`);
console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
