/**
 * test/research-stat-defaults.test.js
 * 
 * 初澜数字生命实验：v0.9.5.2 彻底消除虚假默认统计值专项攻击测试 (Test B)
 * 
 * 核心验证：
 * 1. 真实 turns = 0 必须保留为 0，严禁通过 || 100 变成 100
 * 2. 真实 messageCount = 0 必须保留为 0，严禁通过 || 200 变成 200
 * 3. 统计数据缺失时必须返回 null 或明确未知，严禁使用人为默认数字填补
 * 4. segmentCount 必须如实反映实际 segments 数量，严禁写死 5
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchQuery } = require('../src/research-query');
const { DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'stat-defaults-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Elimination of Fake Statistical Defaults (Test B) ---');

const dir = tmpDir('no-fake-stats-');
const archivePath = path.join(dir, 'experiences.jsonl');
const statePath = path.join(dir, 'subject-state.json');

// 准备三类典型窗口记录：
// Window 1: 真实 turns = 0, messageCount = 0 (零交互窗口，例如静默挂机)
const w1Rec = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 0,
    messageCount: 0,
    segments: [],
    events: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};

// Window 2: 真实小额交互 turns = 3, messageCount = 6, 包含 2 个 segment
const w2Rec = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 2,
  timestamp: 2000,
  payload: {
    turns: 3,
    messageCount: 6,
    segments: [{ segmentIndex: 1 }, { segmentIndex: 2 }],
    events: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};

// Window 3: 未记录 turns 和 messageCount (完全缺失元数据)
const w3Rec = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 3,
  timestamp: 3000,
  payload: {
    events: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};

fs.writeFileSync(archivePath, [w1Rec, w2Rec, w3Rec].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
fs.writeFileSync(statePath, JSON.stringify({ windowNo: 3, values: { ...DEFAULT_TRAITS } }), 'utf8');

const query = new ResearchQuery(dir);

// 1. 测试 getWindows() 列表概况中的统计字段
const windowSummaries = query.getWindows().items;
check('成功获取全部 3 个窗口概况', windowSummaries.length === 3);

// Window 1 校验 (turns=0, messageCount=0, segmentCount=0)
const s1 = windowSummaries.find(w => w.windowNo === 1);
check('Window 1 概况中 turns 保持为 0 (严禁 || 100)', s1 && s1.turns === 0);
check('Window 1 概况中 messageCount 保持为 0 (严禁 || 200)', s1 && s1.messageCount === 0);
check('Window 1 概况中 segmentCount 为 0 (严禁固定为 5)', s1 && s1.segmentCount === 0);

// Window 2 校验 (turns=3, messageCount=6, segmentCount=2)
const s2 = windowSummaries.find(w => w.windowNo === 2);
check('Window 2 概况中 turns 为真实值 3', s2 && s2.turns === 3);
check('Window 2 概况中 messageCount 为真实值 6', s2 && s2.messageCount === 6);
check('Window 2 概况中 segmentCount 为真实值 2', s2 && s2.segmentCount === 2);

// Window 3 校验 (数据缺失时返回 null)
const s3 = windowSummaries.find(w => w.windowNo === 3);
check('Window 3 未记录 turns 时概况返回 null (严禁伪造数字)', s3 && s3.turns === null);
check('Window 3 未记录 messageCount 时概况返回 null (严禁伪造数字)', s3 && s3.messageCount === null);
check('Window 3 未记录 segments 时 segmentCount 为 0', s3 && s3.segmentCount === 0);

// 2. 测试 getWindowDetail() 详细报告中的统计字段
const d1 = query.getWindowDetail(1);
check('Window 1 详情中 turns 准确保持为 0', d1 && d1.turns === 0);
check('Window 1 详情中 messageCount 准确保持为 0', d1 && d1.messageCount === 0);
check('Window 1 详情中 segmentCount 为 0', d1 && d1.segmentCount === 0);

const d2 = query.getWindowDetail(2);
check('Window 2 详情中 turns 准确保持为 3', d2 && d2.turns === 3);
check('Window 2 详情中 messageCount 准确保持为 6', d2 && d2.messageCount === 6);
check('Window 2 详情中 segmentCount 准确保持为 2', d2 && d2.segmentCount === 2);

const d3 = query.getWindowDetail(3);
check('Window 3 详情中未记录 turns 时返回 null', d3 && d3.turns === null);
check('Window 3 详情中未记录 messageCount 时返回 null', d3 && d3.messageCount === null);
check('Window 3 详情中未记录 segments 时 segmentCount 为 0', d3 && d3.segmentCount === 0);

// 3. 验证没有硬编码 100/200/5 渗入返回体
check('Window 1 JSON 绝对不含 "turns":100', !JSON.stringify(d1).includes('"turns":100'));
check('Window 1 JSON 绝对不含 "messageCount":200', !JSON.stringify(d1).includes('"messageCount":200'));
check('Window 1 概况 JSON 绝对不含 "segmentCount":5', !JSON.stringify(s1).includes('"segmentCount":5'));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
