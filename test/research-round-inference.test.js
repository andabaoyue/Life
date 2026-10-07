/**
 * test/research-round-inference.test.js
 * 
 * 初澜数字生命实验：v0.9.5.2 彻底禁止 Message ID -> Round 推断专项攻击测试 (Test A)
 * 
 * 核心验证：
 * 1. 绝不通过 messageId 解析数字推断轮次 (如 m-000005 -> 严禁推断为 Round 3)
 * 2. 缺少合法真实轮次元数据时，轮次必须保持为 roundNo = null, status = 'UNRESOLVED'
 * 3. 真实合法元数据 (roundNo, round, turnNo) 正常解析为真实轮次
 * 4. 严禁通过时间戳顺序、数组 index、奇偶数推测轮次
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

function tmpDir(prefix = 'round-infer-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: Elimination of Round Inference (Test A) ---');

const dir = tmpDir('no-infer-');
const archivePath = path.join(dir, 'experiences.jsonl');
const statePath = path.join(dir, 'subject-state.json');

// 构造归档记录：
// 1. evt-1: messageId 为 m-000005，但无 roundNo (传统 bug 会推断为 Math.ceil(5/2) = Round 3)
// 2. evt-2: messageId 为 m-000010，无 roundNo (传统 bug 会推断为 Round 5)
// 3. evt-3: 具备真实 payload.roundNo = 7
// 4. evt-4: 具备真实 payload.turnNo = 4
// 5. evt-5: 具备真实 payload.round = 2
const summaryRec = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 10000,
  payload: {
    turns: 10,
    messageCount: 5,
    events: [
      {
        eventId: 'evt-000001',
        type: 'message',
        source: 'user',
        messageId: 'm-000005',
        timestamp: 10010,
        payload: { content: '我只有消息编号，没有轮次' }
      },
      {
        eventId: 'evt-000002',
        type: 'message',
        source: 'assistant',
        messageId: 'm-000010',
        timestamp: 10020,
        payload: { content: '初澜回复，同样没有轮次' }
      },
      {
        eventId: 'evt-000003',
        type: 'message',
        source: 'user',
        messageId: 'm-real-007',
        timestamp: 10030,
        payload: { content: '真实第 7 轮', roundNo: 7 }
      },
      {
        eventId: 'evt-000004',
        type: 'message',
        source: 'assistant',
        messageId: 'm-real-004',
        timestamp: 10040,
        payload: { content: '真实第 4 轮', turnNo: 4 }
      },
      {
        eventId: 'evt-000005',
        type: 'message',
        source: 'user',
        messageId: 'm-real-002',
        timestamp: 10050,
        payload: { content: '真实第 2 轮', round: 2 }
      }
    ],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
};

fs.writeFileSync(archivePath, JSON.stringify(summaryRec) + '\n', 'utf8');
fs.writeFileSync(statePath, JSON.stringify({ windowNo: 1, values: { ...DEFAULT_TRAITS } }), 'utf8');

const query = new ResearchQuery(dir);

// 1. 全窗口轮次查询
const allRounds = query.getWindowRounds(1);
check('getWindowRounds 成功返回数组', Array.isArray(allRounds));

// 2. 针对 m-000005 的专项核查 (严禁 roundNo === 3)
const round3 = allRounds.find(r => r.roundNo === 3);
check('第 3 轮绝对不包含未标明轮次的 m-000005 (严禁 Math.ceil(5/2) 推断)', !round3 || !round3.userMessage || round3.userMessage.messageId !== 'm-000005');
check('第 3 轮如实保持为未记录或空 (userMessage === null)', !round3 || round3.userMessage === null);

// 3. 针对 m-000010 的专项核查 (严禁 roundNo === 5)
const round5 = allRounds.find(r => r.roundNo === 5);
check('第 5 轮绝对不包含未标明轮次的 m-000010 (严禁 Math.ceil(10/2) 推断)', !round5 || !round5.assistantMessage || round5.assistantMessage.messageId !== 'm-000010');

// 4. 检查未确定轮次记录的归宿 (roundNo = null, status = 'UNRESOLVED')
const unassigned = allRounds.filter(r => r.roundNo === null);
check('存在 roundNo 为 null 的未分配轮次项', unassigned.length >= 2);

const unassignedMsg5 = unassigned.find(r => r.userMessage && r.userMessage.messageId === 'm-000005');
check('m-000005 被正确收容为 roundNo === null 项', !!unassignedMsg5);
check('m-000005 状态明确标记为 UNRESOLVED', !!unassignedMsg5 && unassignedMsg5.status === 'UNRESOLVED');
check('m-000005 保留真实文本内容', !!unassignedMsg5 && unassignedMsg5.userMessage.content === '我只有消息编号，没有轮次');

const unassignedMsg10 = unassigned.find(r => r.assistantMessage && r.assistantMessage.messageId === 'm-000010');
check('m-000010 被正确收容为 roundNo === null 项', !!unassignedMsg10);
check('m-000010 状态明确标记为 UNRESOLVED', !!unassignedMsg10 && unassignedMsg10.status === 'UNRESOLVED');

// 5. 真实合法轮次字段提取验证
const round7 = allRounds.find(r => r.roundNo === 7);
check('真实 payload.roundNo=7 正确落入 Round 7', !!round7 && round7.userMessage && round7.userMessage.messageId === 'm-real-007');
check('Round 7 状态标记为 RECORDED', !!round7 && round7.status === 'RECORDED');

const round4 = allRounds.find(r => r.roundNo === 4);
check('真实 payload.turnNo=4 正确落入 Round 4', !!round4 && round4.assistantMessage && round4.assistantMessage.messageId === 'm-real-004');

const round2 = allRounds.find(r => r.roundNo === 2);
check('真实 payload.round=2 正确落入 Round 2', !!round2 && round2.userMessage && round2.userMessage.messageId === 'm-real-002');

// 6. 分段查询隔离核查 (Segment #1: 1..20 轮)
const seg1 = query.getWindowRounds(1, 1);
check('分段 1 返回标准 20 轮', seg1.length === 20);
check('分段 1 的第 3 轮不包含 m-000005', seg1[2].userMessage === null);
check('分段 1 的第 5 轮不包含 m-000010', seg1[4].assistantMessage === null);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
