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

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
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
  (w1Records[0].schemaVersion === 1 ? w1Records[0].recordType === 'window_archive' : w1Records[0].type === 'window_archive') &&
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

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
