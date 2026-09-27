/**
 * test/research-fabrication.test.js
 * 
 * 初澜数字生命实验：v0.9.5.1 绝对消除事实臆造与占位伪造专项测试
 * 
 * 核心验证：
 * 1. 消除伪造 messageId (如 m-001001) 与臆造对话 (如 "第 N 轮用户发言")
 * 2. 真实轮次与 Bridge 强隔离：严禁代码推断 (round <= 3 && windowNo > 1)，必须直接取自元数据
 * 3. 状态严格三分：RECORDED (事实) vs NOT_RECORDED (缺失) vs UNRESOLVED (不确定)
 * 4. Window Explorer 绝不自动构造虚假 5x20 空段落
 * 5. 显式报告 queryMode ('INDEX' | 'FULL_SCAN')
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchQuery } = require('../src/research-query');
const { ResearchIndex } = require('../src/research-index');
const { DEFAULT_TRAITS } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'fabrication-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Elimination of Fabrication ---');

const dir = tmpDir('no-fake-');
const archivePath = path.join(dir, 'experiences.jsonl');
const statePath = path.join(dir, 'subject-state.json');

// 准备只有 2 轮真实对话的 Window #2 归档
// 重点：第 1 轮并非 bridge 消息；真实 content 与真实 messageId
const rec1 = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 2,
  timestamp: 10000,
  payload: {
    turns: 2,
    messageCount: 4,
    events: [
      {
        eventId: 'evt-000001',
        type: 'message',
        source: 'user',
        messageId: 'm-real-user-01',
        timestamp: 10010,
        payload: { content: '初澜，你好！这是真实用户发言。', roundNo: 1, bridge: false }
      },
      {
        eventId: 'evt-000002',
        type: 'message',
        source: 'assistant',
        messageId: 'm-real-asst-01',
        timestamp: 10020,
        payload: { content: '你好呀，我是初澜。', roundNo: 1, bridge: false }
      },
      {
        eventId: 'evt-000003',
        type: 'message',
        source: 'user',
        messageId: 'm-real-user-02',
        timestamp: 10030,
        payload: { content: '今天天气真好。', roundNo: 2, bridge: false }
      },
      {
        eventId: 'evt-000004',
        type: 'message',
        source: 'assistant',
        messageId: 'm-real-asst-02',
        timestamp: 10040,
        payload: { content: '嗯呢，适合散散步。', roundNo: 2, bridge: false }
      }
    ],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};

fs.writeFileSync(statePath, JSON.stringify({ windowNo: 2, values: { ...DEFAULT_TRAITS } }), 'utf8');
// P0-01/P0-02: 现代归档经 Canonical 写入路径生成链字段与 Tail Anchor
const { ExperiencesArchive } = require('../src/experiences-archive');
new ExperiencesArchive(dir).append(rec1);

const index = new ResearchIndex(archivePath);
const query = new ResearchQuery(dir, { index });

// 1. 查询第 1 分段 (1..20 轮)
const roundsSeg1 = query.getWindowRounds(2, 1);
check('getWindowRounds 返回数组格式', Array.isArray(roundsSeg1) && roundsSeg1.length === 20);
check('显式报告 queryMode 为 INDEX', roundsSeg1.queryMode === 'INDEX');

// 第 1 轮应为 RECORDED 且具备真实消息
const r1 = roundsSeg1[0];
check('第 1 轮状态标记为 RECORDED', r1.status === 'RECORDED');
check('第 1 轮用户消息包含真实 messageId (m-real-user-01)', r1.userMessage && r1.userMessage.messageId === 'm-real-user-01');
check('第 1 轮用户消息包含真实内容原文', r1.userMessage && r1.userMessage.content === '初澜，你好！这是真实用户发言。');
check('绝不根据 windowNo>1 盲目猜测第 1 轮为 BRIDGE (bridge === false)', r1.bridge === false);
check('第 1 轮 tag 为 ACTIVE 而非 BRIDGE', r1.tag === 'ACTIVE');

// 第 2 轮应为 RECORDED
const r2 = roundsSeg1[1];
check('第 2 轮状态标记为 RECORDED', r2.status === 'RECORDED');
check('第 2 轮初澜回复为真实内容', r2.assistantMessage && r2.assistantMessage.content === '嗯呢，适合散散步。');

// 第 3 轮至第 20 轮：归档完好但无记录，必须为 NOT_RECORDED
const r3 = roundsSeg1[2];
check('未记录轮次 (第 3 轮) 状态为 NOT_RECORDED', r3.status === 'NOT_RECORDED');
check('未记录轮次 userMessage 为 null (绝不伪造)', r3.userMessage === null);
check('未记录轮次 assistantMessage 为 null (绝不伪造)', r3.assistantMessage === null);
check('未记录轮次 bridge 为 null', r3.bridge === null);

// 验证所有未记录轮次均未产生假消息 ID 或占位文本
let fakeMsgFound = false;
let fakeContentFound = false;
for (let i = 2; i < roundsSeg1.length; i++) {
  const r = roundsSeg1[i];
  if (r.userMessage !== null || r.assistantMessage !== null) fakeMsgFound = true;
  if (JSON.stringify(r).includes('第') && JSON.stringify(r).includes('轮用户发言')) fakeContentFound = true;
}
check('未记录轮次中绝对没有伪造的 messageId', fakeMsgFound === false);
check('未记录轮次中绝对没有占位对话文本 (如 第 N 轮用户发言)', fakeContentFound === false);

// 2. getWindowDetail 不得伪造 segments
const detail = query.getWindowDetail(2);
check('归档无 segments 时，getWindowDetail 如实返回空数组 (segmentCount=0)', detail.segmentCount === 0 && detail.segments.length === 0);
check('getWindowDetail 报告 queryMode 为 INDEX', detail.queryMode === 'INDEX');

// 3. 损坏归档下的状态应为 UNRESOLVED
fs.appendFileSync(archivePath, 'CORRUPTED_LINE_JSON_ERROR\n', 'utf8');
index.invalidate(); // 使索引失效以重新检测
const queryCorrupt = new ResearchQuery(dir);
const roundsCorrupt = queryCorrupt.getWindowRounds(2, 1);
const r3Corrupt = roundsCorrupt[2];
check('归档存在损坏行时，未确认轮次降级为 UNRESOLVED (而非确定性的 NOT_RECORDED)', r3Corrupt.status === 'UNRESOLVED');
check('降级状态下 bridge 保持为 null', r3Corrupt.bridge === null);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
