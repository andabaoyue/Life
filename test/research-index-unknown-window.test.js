/**
 * test/research-index-unknown-window.test.js
 * 
 * Life v0.9.5.3 H-02 回归测试：ResearchIndex 禁止把未知 Window 映射为 Window 1
 * 
 * 核心不变量：
 * Index 不能改变历史事实，只能加速定位真实存在的历史事实。缺失 windowNo 必须保持 null，不得将 unknown window 映射到 key=1。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchIndex } = require('../src/research-index');
const { ResearchQuery } = require('../src/research-query');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'idx-unk-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log('--- Test Suite: ResearchIndex Unknown Window (H-02) ---');

// =============================================================================
// Test A: Legacy Record 没有 windowNo
// =============================================================================
const dirA = tmpDir('idx-a-');
const archiveA = path.join(dirA, 'experiences.jsonl');

// Legacy 记录：无 windowNo
const legacyNoWindowRec = {
  type: 'window_archive',
  turns: 10,
  messageCount: 20,
  createdAt: 1000,
  events: [{ eventId: 'evt-unk-01', messageId: 'm-unk-01', source: 'user' }]
};
fs.writeFileSync(archiveA, JSON.stringify(legacyNoWindowRec) + '\n', 'utf8');

// 1. Full Scan 模式
const queryFullScan = new ResearchQuery(dirA);
const fullScanDetail1 = queryFullScan.getWindowDetail(1);
check('Test A (Full Scan): 未指定 windowNo 的记录在 windowNo=1 查询中返回 null', fullScanDetail1 === null);

// 2. Index 模式
const indexA = new ResearchIndex(archiveA);
const queryIndexed = new ResearchQuery(dirA, { index: indexA });
const indexedDetail1 = queryIndexed.getWindowDetail(1);
check('Test A (Indexed): 未指定 windowNo 的记录在 Indexed 查询 windowNo=1 时绝对不得返回', indexedDetail1 === null);

const statsA = indexA.getStats();
check('Test A (Index Stats): unknownWindowCount 正确记录为 1', statsA.unknownWindowCount === 1);
check('Test A (Index Stats): windowCount 中不包含伪造的 Window 1', !indexA.windowIndex.has(1));

// =============================================================================
// Test B: getWindowDetail(1) 不得返回 unknown-window record
// =============================================================================
check('Test B: getWindowDetail(1) 严格为 null，未把 unknown record 归入 Window 1', indexedDetail1 === null);
const desc1 = indexA.getWindowDescriptors(1);
check('Test B: indexA.getWindowDescriptors(1) 返回空数组', Array.isArray(desc1) && desc1.length === 0);

// =============================================================================
// Test C: getWindowDetail(null) 不得转换成 1
// =============================================================================
const detailNull = queryIndexed.getWindowDetail(null);
check('Test C: getWindowDetail(null) 返回的对象 windowNo 严格保持为 null', detailNull !== null && detailNull.windowNo === null);
check('Test C: getWindowDetail(null) 绝对不包含 windowNo=1 标记', detailNull.windowNo !== 1);
const descNull = indexA.getWindowDescriptors(null);
check('Test C: getWindowDescriptors(null) 返回 unknown 描述符清单', Array.isArray(descNull) && descNull.length === 1);

// =============================================================================
// Test D: 真实 windowNo=1 的 Record 仍然正常工作
// =============================================================================
const dirD = tmpDir('idx-d-');
const archiveD = path.join(dirD, 'experiences.jsonl');
const realWindow1Rec = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 2000,
  payload: {
    turns: 5,
    messageCount: 10,
    events: [{ eventId: 'evt-real-1', type: 'message', source: 'user' }]
  }
};
fs.writeFileSync(archiveD, JSON.stringify(realWindow1Rec) + '\n', 'utf8');

const indexD = new ResearchIndex(archiveD);
const queryD = new ResearchQuery(dirD, { index: indexD });
const detailD1 = queryD.getWindowDetail(1);
check('Test D: 真实 windowNo=1 记录正常被索引与读取', detailD1 !== null && detailD1.windowNo === 1);
check('Test D: 真实 windowNo=1 轮数正确返回', detailD1.turns === 5);
check('Test D: index.getWindowDescriptors(1) 包含真实记录', indexD.getWindowDescriptors(1).length === 1);
check('Test D: index.unknownWindowDescriptors 为空', indexD.getWindowDescriptors(null).length === 0);

// =============================================================================
// Test E: 真实 windowNo=0 不得因为 falsy 判断而变成 1
// =============================================================================
const dirE = tmpDir('idx-e-');
const archiveE = path.join(dirE, 'experiences.jsonl');
const realWindow0Rec = {
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 0,
  timestamp: 3000,
  payload: {
    turns: 0,
    messageCount: 0,
    events: []
  }
};
fs.writeFileSync(archiveE, JSON.stringify(realWindow0Rec) + '\n', 'utf8');

const indexE = new ResearchIndex(archiveE);
const queryE = new ResearchQuery(dirE, { index: indexE });
const detailE0 = queryE.getWindowDetail(0);
check('Test E: 真实 windowNo=0 记录正常被索引为 0 (不因 falsy 被改成 1)', detailE0 !== null && detailE0.windowNo === 0);
const detailE1 = queryE.getWindowDetail(1);
check('Test E: windowNo=0 绝对不泄露至 windowNo=1 查询', detailE1 === null);

// =============================================================================
// Test F: unknown + known records 混合场景，Indexed 与 Full Scan 语义一致
// =============================================================================
const dirF = tmpDir('idx-f-');
const archiveF = path.join(dirF, 'experiences.jsonl');

const mixedRecords = [
  // 1. Unknown record (无 windowNo)
  {
    type: 'window_archive',
    createdAt: 100,
    turns: 12,
    messageCount: 24,
    events: [{ eventId: 'evt-mix-unk', messageId: 'm-mix-unk', source: 'user' }]
  },
  // 2. Known Window 0
  {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 0,
    timestamp: 200,
    payload: { turns: 0, messageCount: 0, events: [] }
  },
  // 3. Known Window 1
  {
    schemaVersion: 1,
    recordType: 'window_summary',
    windowNo: 1,
    timestamp: 300,
    payload: { turns: 25, messageCount: 50, events: [{ eventId: 'evt-mix-w1', type: 'message', source: 'user' }] }
  }
];

fs.writeFileSync(archiveF, mixedRecords.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const queryFull = new ResearchQuery(dirF);
const queryIdx = new ResearchQuery(dirF, { index: new ResearchIndex(archiveF) });

// 对比 window 0
const fullW0 = queryFull.getWindowDetail(0);
const idxW0 = queryIdx.getWindowDetail(0);
check('Test F: Window 0 在 FullScan 与 Indexed 下 turns 一致', fullW0.turns === idxW0.turns && fullW0.windowNo === 0 && idxW0.windowNo === 0);

// 对比 window 1
const fullW1 = queryFull.getWindowDetail(1);
const idxW1 = queryIdx.getWindowDetail(1);
check('Test F: Window 1 在 FullScan 与 Indexed 下 turns 一致', fullW1.turns === idxW1.turns && fullW1.windowNo === 1 && idxW1.windowNo === 1);
check('Test F: Window 1 中均不包含 unknown record 的事件', 
  fullW1.events.every(e => e.eventId !== 'evt-mix-unk') &&
  idxW1.events.every(e => e.eventId !== 'evt-mix-unk')
);

// 对比 window null
const fullNull = queryFull.getWindowDetail(null);
const idxNull = queryIdx.getWindowDetail(null);
check('Test F: Unknown Window (null) 在 FullScan 与 Indexed 下均正确检索', fullNull !== null && idxNull !== null);
check('Test F: Unknown Window 下 turns 均为 12', fullNull.turns === 12 && idxNull.turns === 12);
check('Test F: Unknown Window 下 windowNo 均为 null', fullNull.windowNo === null && idxNull.windowNo === null);

// =============================================================================
// Test G: IPC 边界回归测试 (H-02: research:get-window-rounds 与 research:get-window)
// =============================================================================
const { registerResearchIpc } = require('../src/research-ipc');

const ipcCalls = [];
const mockResearchService = {
  query: {
    getWindowRounds(wNo, segIdx) {
      ipcCalls.push({ method: 'getWindowRounds', wNo, segIdx });
      return { wNo, segIdx, rounds: [] };
    },
    getWindowDetail(wNo) {
      ipcCalls.push({ method: 'getWindowDetail', wNo });
      return { wNo, detail: true };
    }
  }
};

const handlers = new Map();
const fakeIpcMain = {
  handle(channel, fn) {
    handlers.set(channel, fn);
  }
};

registerResearchIpc(fakeIpcMain, mockResearchService);

const handleGetWindowRounds = handlers.get('research:get-window-rounds');
const handleGetWindow = handlers.get('research:get-window');

// 1. windowNo = 0 必须保持 0
ipcCalls.length = 0;
handleGetWindowRounds({}, { windowNo: 0 });
check('Test G (IPC rounds): { windowNo: 0 } 必须严格传 0 而非 1', ipcCalls[0].wNo === 0);

ipcCalls.length = 0;
handleGetWindowRounds({}, 0);
check('Test G (IPC rounds): 裸传 0 必须严格传 0 而非 1', ipcCalls[0].wNo === 0);

// 2. windowNo = null 必须保持 null / UNKNOWN
ipcCalls.length = 0;
handleGetWindowRounds({}, { windowNo: null });
check('Test G (IPC rounds): { windowNo: null } 必须保持 null 而非 1', ipcCalls[0].wNo === null);

ipcCalls.length = 0;
handleGetWindowRounds({}, null);
check('Test G (IPC rounds): 裸传 null 必须保持 null 而非 1', ipcCalls[0].wNo === null);

// 3. windowNo 缺失不得自动变成 1
ipcCalls.length = 0;
handleGetWindowRounds({}, {});
check('Test G (IPC rounds): {} (windowNo 缺失) 必须为 null，不得自动变成 1', ipcCalls[0].wNo === null);

ipcCalls.length = 0;
handleGetWindowRounds({}, undefined);
check('Test G (IPC rounds): undefined (windowNo 缺失) 必须为 null，不得自动变成 1', ipcCalls[0].wNo === null);

// 4. 正确的 windowNo = 1 正常传递
ipcCalls.length = 0;
handleGetWindowRounds({}, { windowNo: 1 });
check('Test G (IPC rounds): { windowNo: 1 } 正常传 1', ipcCalls[0].wNo === 1);

// 5. research:get-window 验证
ipcCalls.length = 0;
handleGetWindow({}, { windowNo: 0 });
check('Test G (IPC window): { windowNo: 0 } 必须保持 0', ipcCalls[0].wNo === 0);

ipcCalls.length = 0;
handleGetWindow({}, { windowNo: null });
check('Test G (IPC window): { windowNo: null } 必须保持 null', ipcCalls[0].wNo === null);

ipcCalls.length = 0;
handleGetWindow({}, {});
check('Test G (IPC window): 空参数 {} 作为 UI 导航默认展示 Window 1', ipcCalls[0].wNo === 1);

try {
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirD, { recursive: true, force: true });
  fs.rmSync(dirE, { recursive: true, force: true });
  fs.rmSync(dirF, { recursive: true, force: true });
} catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
