/**
 * test/research-role-unknown.test.js
 *
 * P1-03: Research Query role 映射反伪造专项测试
 *
 * 检验点：
 * 1. 缺 role + source=activity-tracker -> UNKNOWN/null（绝不伪造成 user）
 * 2. 缺 role + source=desktop-motion  -> UNKNOWN/null
 * 3. 缺 role + source=lifecycle       -> UNKNOWN/null
 * 4. source=assistant -> assistant
 * 5. source=user      -> user
 * 6. UNKNOWN role 消息绝不进入 userMessage / assistantMessage 消息位
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExperiencesArchive } = require('../src/experiences-archive');
const { ResearchQuery } = require('../src/research-query');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'role-unknown-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const dir = tmpDir();
const archive = new ExperiencesArchive(dir);
archive.append({
  schemaVersion: 1,
  recordType: 'window_summary',
  windowNo: 1,
  timestamp: 1000,
  payload: {
    turns: 3,
    messageCount: 5,
    events: [
      { eventId: 'evt-u1', type: 'message', source: 'user', messageId: 'm-u1', timestamp: 1010, payload: { content: '你好', roundNo: 1 } },
      { eventId: 'evt-a1', type: 'message', source: 'assistant', messageId: 'm-a1', timestamp: 1020, payload: { content: '好呀', roundNo: 1 } },
      { eventId: 'evt-at1', type: 'activity_tracker', source: 'activity-tracker', messageId: 'm-at1', timestamp: 1030, payload: { content: '活动数据', roundNo: 2 } },
      { eventId: 'evt-dm1', type: 'desktop_motion', source: 'desktop-motion', messageId: 'm-dm1', timestamp: 1040, payload: { content: '桌面动态', roundNo: 2 } },
      { eventId: 'evt-lc1', type: 'lifecycle', source: 'lifecycle', messageId: 'm-lc1', timestamp: 1050, payload: { content: '生命周期', roundNo: 3 } }
    ],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: []
  }
});

const query = new ResearchQuery(dir);
const rounds = query.getWindowRounds(1);
const unresolved = rounds.unresolved || [];

const findUnresolved = (mid) => unresolved.find(u => u && u.message && u.message.messageId === mid);

const at = findUnresolved('m-at1');
check('缺 role + source=activity-tracker -> UNKNOWN/null', !!at && at.status === 'UNRESOLVED' && at.message.role === null);

const dm = findUnresolved('m-dm1');
check('缺 role + source=desktop-motion -> UNKNOWN/null', !!dm && dm.status === 'UNRESOLVED' && dm.message.role === null);

const lc = findUnresolved('m-lc1');
check('缺 role + source=lifecycle -> UNKNOWN/null', !!lc && lc.status === 'UNRESOLVED' && lc.message.role === null);

const round1 = rounds.find(r => r.roundNo === 1 && r.status === 'RECORDED');
check('source=assistant -> assistant', !!round1 && !!round1.assistantMessage && round1.assistantMessage.role === 'assistant');
check('source=user -> user', !!round1 && !!round1.userMessage && round1.userMessage.role === 'user');

const noFabrication = rounds.every(r => {
  const uRole = r.userMessage ? r.userMessage.role : null;
  const aRole = r.assistantMessage ? r.assistantMessage.role : null;
  return (r.userMessage === null || uRole === 'user') && (r.assistantMessage === null || aRole === 'assistant');
});
check('UNKNOWN role 消息绝不进入 userMessage/assistantMessage 消息位', noFabrication);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
