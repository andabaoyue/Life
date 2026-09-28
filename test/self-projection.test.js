/**
 * test/self-projection.test.js
 * 
 * Life v0.9.6 实验基线强化测试集 6：Current Self 因果链记录与自我投影审计专项测试
 * 
 * 检验点：
 * 1. self_projection 记录格式符合 Canonical Schema v1 规范
 * 2. sourceExperienceRecords 与 sourceStateChanges 严格溯源
 * 3. 窗口小结与自我成长后的因果链记录落盘 (experiences.jsonl)
 * 4. Replay 审计：自我投影记录平滑兼容并保持哈希链与序列完整性 (certified)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExperiencesArchive } = require('../src/experiences-archive');
const { ArchiveIntegrityService } = require('../src/archive-integrity');
const { SubjectState } = require('../src/subject-state');
const { Brain } = require('../src/brain');
const { DEFAULTS } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'self-projection-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. self_projection 记录格式与字段完整性校验
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  // 1.1 先写入一条窗口小结
  archive.appendWindowArchive({
    windowNo: 1,
    targetTurnCount: 100,
    actualTurnCount: 100,
    turns: 100,
    segments: [],
    windowSynthesis: { stableUserFacts: ['事实'] }
  });

  // 1.2 写入自我投影记录
  const projOk = archive.appendSelfProjection({
    windowNo: 1,
    projectionVersion: '1.0',
    sourceExperienceRecords: ['rec-000001'],
    sourceStateChanges: [
      {
        trait: 'quiet_preference',
        delta: 20,
        evidenceMessageIds: ['m-000005']
      }
    ],
    entriesAdded: 1,
    result: {
      personalityShift: 'quiet_preference +20',
      newSelfNarrativeSummary: '更偏好安静与深度对话'
    }
  });

  check('appendSelfProjection 成功写入', projOk === true);
  const records = archive.readAll();
  check('归档中包含 2 条记录', records.length === 2);

  const projRec = records[1];
  check('投影记录 schemaVersion 严格为 1', projRec.schemaVersion === 1);
  check('投影记录 recordType 严格为 self_projection', projRec.recordType === 'self_projection');
  check('投影记录 archiveSeq 严格自增为 2', projRec.archiveSeq === 2);
  check('投影记录 recordId 严格对齐 rec-000002', projRec.recordId === 'rec-000002');
  check('投影记录 prevHash 与前一条记录 recordHash 严格匹配', projRec.prevHash === records[0].recordHash);
  check('投影记录 recordHash 为有效 SHA-256 摘要', typeof projRec.recordHash === 'string' && projRec.recordHash.length === 64);

  const payload = projRec.payload || {};
  check('payload.projectionVersion 为 1.0', payload.projectionVersion === '1.0');
  check('payload 包含 sourceExperienceRecords', Array.isArray(payload.sourceExperienceRecords) && payload.sourceExperienceRecords[0] === 'rec-000001');
  check('payload 包含 sourceStateChanges 因果追溯', Array.isArray(payload.sourceStateChanges) && payload.sourceStateChanges[0].trait === 'quiet_preference');
  check('payload 包含 entriesAdded', payload.entriesAdded === 1);
  check('payload 包含 result 叙事概括', payload.result && payload.result.personalityShift === 'quiet_preference +20');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 2. 窗口关窗流程中的因果链记录 (Brain 集成)
// -------------------------------------------------------------
async function testBrainSelfProjectionIntegration() {
  const dir = tmpDir();
  const brain = new Brain(dir, {
    ...DEFAULTS,
    windowTurns: 2,
    keepTailMessages: 1,
    recordSelfProjection: true // 开启自省投影因果链落盘
  });

  brain.memory.append('user', '初澜，我很喜欢你安静陪伴我。');
  brain.memory.history[0].messageId = 'm-p-001';
  brain.memory.append('assistant', '我会一直安静陪伴你。');
  brain.memory.history[1].messageId = 'm-p-002';
  brain.memory.append('user', '保持这种沉静的对话节奏。');
  brain.memory.history[2].messageId = 'm-p-003';
  brain.memory.append('assistant', '好的。');
  brain.memory.history[3].messageId = 'm-p-004';

  const mockApi = {
    complete: async () => ({
      text: JSON.stringify({
        segments: [
          {
            range: '1-2',
            userGiven: ['喜欢安静陪伴'],
            chulanExperience: ['沉静对话'],
            stateEvidence: [
              {
                trait: 'quiet_preference',
                direction: 1,
                strength: 1.0,
                messageId: 'm-p-001',
                quote: '我很喜欢你安静陪伴我'
              }
            ],
            uncertainties: []
          }
        ],
        windowSynthesis: {
          stableUserFacts: ['偏好安静'],
          subjectExperiences: ['沉静陪伴'],
          stateChangesSuggested: []
        }
      }),
      usage: { total_tokens: 40 }
    })
  };
  brain.api = mockApi;

  const closed = await brain.closeWindow({ recordSelfProjection: true });
  check('Brain 关窗执行成功', closed === true);

  const archiveRecords = brain.experiencesArchive.readAll();
  check('开启投影后归档写入 2 条记录 (window_summary + self_projection)', archiveRecords.length === 2);

  const wSummary = archiveRecords[0];
  const sProj = archiveRecords[1];

  check('第 1 条为 window_summary', wSummary.recordType === 'window_summary');
  check('第 2 条为 self_projection', sProj.recordType === 'self_projection');
  check('自我投影因果链溯源关联至窗口 1 (win-1)', sProj.payload.sourceExperienceRecords[0] === 'win-1');
  check('自我投影记录包含了状态变更引用', Array.isArray(sProj.payload.sourceStateChanges));
  check('自我投影 prevHash 正确链式连接至 window_summary', sProj.prevHash === wSummary.recordHash);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -------------------------------------------------------------
// 3. Replay 审计：混编 self_projection 不影响数值且通过完整性认证
// -------------------------------------------------------------
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);

  archive.appendWindowArchive({
    windowNo: 1,
    turns: 100,
    verifiedEvidence: [
      { trait: 'vitality', direction: 1, strength: 0.5, evidenceId: 'ev-v-1' }
    ]
  });

  archive.appendSelfProjection({
    windowNo: 1,
    sourceExperienceRecords: ['rec-000001'],
    entriesAdded: 1,
    result: { currentSelfText: '充满活力' }
  });

  const records = archive.readAll();

  // 1. 完整性检查
  const intRep = ArchiveIntegrityService.checkRecords(records);
  check('ArchiveIntegrityService 判定包含 self_projection 的归档为 certified', intRep.integrity === 'certified');
  check('序列完整性为 monotonic', intRep.sequence_integrity === 'monotonic');
  check('哈希链完整性为 verified', intRep.hash_integrity === 'verified');

  // 2. Replay 重建
  const replayRep = SubjectState.replay(records);
  check('Replay 成功完成 (complete)', replayRep.replayStatus === 'complete');
  check('Replay 认证状态为 certified', replayRep.integrity === 'certified');
  check('Replay 仅将 window_summary 计入有效窗口状态 (窗口数为 1)', replayRep.windowStates.length === 1);
  check('Replay 正确计算 vitality 状态累加 (+10)', replayRep.finalState.vitality === 10);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  await testBrainSelfProjectionIntegration();
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
