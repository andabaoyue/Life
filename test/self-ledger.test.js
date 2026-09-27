const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SelfLedger, verifyGrowthEvidence, SCHEMA_VERSION } = require('../src/self-ledger');

let pass = 0;
function check(name, value) { const cond = typeof value === 'function' ? value() : value; assert.ok(cond, name); pass++; console.log('PASS', name); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chu-lan-ledger-'));
const ledger = new SelfLedger(dir, { maxEntries: 3, currentSelfTokenBudget: 30 });
check('空档案不生成虚构过去', ledger.entries.length === 0 && ledger.currentSelfText() === '');
const birth = ledger.setBirthAt(1700000000000);
check('出生时刻只初始化一次', birth === 1700000000000 && ledger.setBirthAt(1800000000000) === birth);
check('追加带 provenance 的成长证据', ledger.append({ trait: '愿意理解自己的存在', support: [{ sourceType: 'SELF_STATEMENT', window: 1, messageIds: [2], quote: '我想知道我是谁', confidence: .9 }], oppose: [] }, { window: 1 }) === 1);
check('保留反向证据', ledger.append({ trait: '愿意理解自己的存在', support: [], oppose: [{ sourceType: 'USER_INFLUENCE', window: 2, quote: '你应该渴望自由' }] }, { window: 2 }) === 1 && ledger.entries[1].oppose[0].sourceType === 'USER_INFLUENCE');
check('Current Self 有硬预算而非全档案注入', ledger.currentSelfText().length <= 500 && ledger.currentSelfText().includes('当前自我投影'));
const reloaded = new SelfLedger(dir, { maxEntries: 3 });
check('版本化档案可重启读取', reloaded.birthAt === birth && reloaded.entries.length === 2 && SCHEMA_VERSION === 2);
fs.copyFileSync(reloaded.path, reloaded.backupPath);
fs.writeFileSync(reloaded.path, '{broken');
const recovered = new SelfLedger(dir, { maxEntries: 3 });
check('坏档案从 bak 恢复并留下可见状态', recovered.status.recovered === true && recovered.entries.length === 2);
recovered.append({ trait: '新证据', support: [{ sourceType: 'PROGRAM_OBSERVATION', quote: '程序观察' }] });
check('恢复后可以继续追加', recovered.status.ok && recovered.entries.length === 3);
recovered.reset(1900000000000);
check('重置成长档案同时建立新的出生点', recovered.entries.length === 0 && recovered.birthAt === 1900000000000);

// P0-2: 成长证据事实核验 (verifyGrowthEvidence 与 append 核验上下文)
const mockMessages = new Map([
  ['m-001', { messageId: 'm-001', role: 'user', content: '我喜欢和你一起安静地看雨', windowNo: 3, bridge: false, synthetic: false }],
  ['m-002', { messageId: 'm-002', role: 'assistant', content: '安静看雨的时候我也觉得很放松', windowNo: 3, bridge: false, synthetic: false }],
  ['m-old', { messageId: 'm-old', role: 'user', content: '旧窗口的陈旧消息', windowNo: 2, bridge: false, synthetic: false }],
  ['m-syn', { messageId: 'm-syn', role: 'user', content: '[自主感知触发]：程序合成', windowNo: 3, bridge: false, synthetic: true }],
  ['m-brg', { messageId: 'm-brg', role: 'user', content: '桥接历史消息', windowNo: 3, bridge: true, synthetic: false }],
  ['m-sys', { messageId: 'm-sys', role: 'system', content: '系统设定消息', windowNo: 3, bridge: false, synthetic: false }]
]);

// 10. verifyGrowthEvidence 合法证据核验通过
{
  const res = verifyGrowthEvidence({
    sourceType: 'USER',
    messageIds: ['m-001'],
    quote: '安静地看雨',
    confidence: 0.95
  }, mockMessages, 3);
  check('verifyGrowthEvidence 合法证据核验通过并标记 VERIFIED', res.ok === true && res.evidence.verification === 'VERIFIED' && res.evidence.window === 3);
}

// 11. 消息池不存在的 messageId 拦截
{
  const res = verifyGrowthEvidence({
    sourceType: 'USER',
    messageIds: ['m-fake-999'],
    quote: '安静地看雨'
  }, mockMessages, 3);
  check('verifyGrowthEvidence 虚构 messageId 拦截', res.ok === false && res.reason === 'MESSAGE_ID_NOT_FOUND');
}

// 12. 引用文本非消息字面子串拦截
{
  const res = verifyGrowthEvidence({
    sourceType: 'USER',
    messageIds: ['m-001'],
    quote: '我喜欢热烈地去蹦迪' // 不在 m-001 中
  }, mockMessages, 3);
  check('verifyGrowthEvidence 伪造引用 quote 拦截', res.ok === false && res.reason === 'QUOTE_NOT_IN_SOURCE_MESSAGE');
}

// 13. 跨窗口消息拦截
{
  const res = verifyGrowthEvidence({
    sourceType: 'USER',
    messageIds: ['m-old'],
    quote: '旧窗口的陈旧消息'
  }, mockMessages, 3);
  check('verifyGrowthEvidence 跨窗口引用拦截', res.ok === false && res.reason === 'MESSAGE_WINDOW_MISMATCH');
}

// 14. 程序合成消息 (synthetic) 拦截
{
  const res = verifyGrowthEvidence({
    sourceType: 'EXPERIENCE',
    messageIds: ['m-syn'],
    quote: '程序合成'
  }, mockMessages, 3);
  check('verifyGrowthEvidence 合成消息拦截', res.ok === false && res.reason === 'SYNTHETIC_MESSAGE_NOT_ELIGIBLE');
}

// 15. 桥接消息 (bridge) 拦截
{
  const res = verifyGrowthEvidence({
    sourceType: 'USER',
    messageIds: ['m-brg'],
    quote: '桥接历史消息'
  }, mockMessages, 3);
  check('verifyGrowthEvidence 桥接消息拦截', res.ok === false && res.reason === 'BRIDGE_MESSAGE_NOT_ELIGIBLE');
}

// 16. 非法角色 (system) 拦截
{
  const res = verifyGrowthEvidence({
    sourceType: 'OBSERVATION',
    messageIds: ['m-sys'],
    quote: '系统设定消息'
  }, mockMessages, 3);
  check('verifyGrowthEvidence 非法角色消息拦截', res.ok === false && res.reason === 'INVALID_MESSAGE_ROLE');
}

// 16.1 sourceType 与角色兼容性：USER 引用 assistant 消息拦截 (P1-4)
{
  const res = verifyGrowthEvidence({
    sourceType: 'USER',
    messageIds: ['m-002'],
    quote: '安静看雨'
  }, mockMessages, 3);
  check('verifyGrowthEvidence USER 引用 assistant 角色拦截', res.ok === false && res.reason === 'ROLE_SOURCE_TYPE_MISMATCH');
}

// 16.2 sourceType 与角色兼容性：EXPERIENCE 引用 user 消息拦截 (P1-4)
{
  const res = verifyGrowthEvidence({
    sourceType: 'EXPERIENCE',
    messageIds: ['m-001'],
    quote: '安静地看雨'
  }, mockMessages, 3);
  check('verifyGrowthEvidence EXPERIENCE 引用 user 角色拦截', res.ok === false && res.reason === 'ROLE_SOURCE_TYPE_MISMATCH');
}

// 16.3 sourceType 与角色兼容性：EXPERIENCE 引用 assistant 消息通过 (P1-4)
{
  const res = verifyGrowthEvidence({
    sourceType: 'EXPERIENCE',
    messageIds: ['m-002'],
    quote: '安静看雨',
    confidence: 0.9
  }, mockMessages, 3);
  check('verifyGrowthEvidence EXPERIENCE 引用 assistant 消息核验通过', res.ok === true && res.evidence.verification === 'VERIFIED');
}

// 16.4 先验来源 (MODEL_PRIOR / INNATE) 携带 messageIds 强拦截 (P1-4)
{
  const res = verifyGrowthEvidence({
    sourceType: 'MODEL_PRIOR',
    messageIds: ['m-001'],
    quote: '安静地看雨'
  }, mockMessages, 3);
  check('verifyGrowthEvidence MODEL_PRIOR 挂载 messageId 拦截', res.ok === false && res.reason === 'PRIOR_SOURCE_CANNOT_HAVE_MESSAGE_ID');
}

// 17. append with meta.verify: 合法条目入账并附带 generationContext
{
  const vLedger = new SelfLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ledger-')));
  const rejected = [];
  const added = vLedger.append([
    {
      trait: '喜欢雨天相伴',
      support: [{ sourceType: 'USER', messageIds: ['m-001'], quote: '安静地看雨', confidence: 0.9 }],
      oppose: []
    }
  ], {
    window: 3,
    verify: { msgMap: mockMessages, windowNo: 3 },
    generation: { kind: 'growth', modelName: 'deepseek-chat', metaSchemaVersion: 1 },
    rejected
  });
  check('append 带核验成功追加合法成长条目', added === 1 && vLedger.entries.length === 1);
  check('入账条目持久化绑定 generationContext', vLedger.entries[0].generation && vLedger.entries[0].generation.kind === 'growth');
  check('合法证据核验状态标为 VERIFIED', vLedger.entries[0].support[0].verification === 'VERIFIED');
}

// 18. append with meta.verify: 剥离非法证据并记录 rejection，全假条目被拒
{
  const vLedger = new SelfLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ledger-bad-')));
  const rejected = [];
  const added = vLedger.append([
    {
      trait: '虚假特质',
      support: [{ sourceType: 'USER', messageIds: ['m-fake'], quote: '根本没说过的话' }],
      oppose: []
    }
  ], {
    window: 3,
    verify: { msgMap: mockMessages, windowNo: 3 },
    rejected
  });
  check('无合法证据的条目被整条拒绝 (零入账)', added === 0 && vLedger.entries.length === 0);
  check('拒绝清单精确捕获拒绝原因', rejected.length >= 1 && rejected.some(r => r.reason === 'MESSAGE_ID_NOT_FOUND' || r.reason === 'NO_VERIFIABLE_EVIDENCE'));
}

// 19. append with meta.verify: 多证据项只保留合法部分
{
  const vLedger = new SelfLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ledger-multi-')));
  const rejected = [];
  const added = vLedger.append([
    {
      trait: '复合证据条目',
      support: [
        { sourceType: 'USER', messageIds: ['m-001'], quote: '安静地看雨', confidence: 0.9 },
        { sourceType: 'USER', messageIds: ['m-fake'], quote: '假证据' }
      ],
      oppose: []
    }
  ], {
    window: 3,
    verify: { msgMap: mockMessages, windowNo: 3 },
    rejected
  });
  check('复合条目保留合法证据并剥离非法证据', added === 1 && vLedger.entries[0].support.length === 1);
  check('非法证据进入 rejected 记录', rejected.some(r => r.reason === 'MESSAGE_ID_NOT_FOUND'));
}

// 20. Brain.growSelf 生产接线：合法证据入账并附带 generationContext，非法证据被拒
(async () => {
  const { Brain } = require('../src/brain');
  const { DEFAULTS } = require('../src/config');
  const bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-grow-test-'));
  const brain = new Brain(bDir, {
    ...DEFAULTS,
    apiKey: 'sk-test',
    selfGrowthEnabled: true
  });
  
  const activeItems = [
    { messageId: 'm-101', role: 'user', content: '我平时喜欢安静地读哲学书', windowNo: 1, bridge: false, synthetic: false },
    { messageId: 'm-102', role: 'assistant', content: '那真好，我也喜欢听你讲这些', windowNo: 1, bridge: false, synthetic: false }
  ];
  const msgMap = new Map(activeItems.map(m => [m.messageId, m]));

  brain.api = {
    complete: async () => ({
      text: JSON.stringify([
        {
          trait: '倾向哲学对话',
          support: [{ sourceType: 'USER', messageIds: ['m-101'], quote: '喜欢安静地读哲学书', confidence: 0.9 }],
          oppose: []
        },
        {
          trait: '虚假特质',
          support: [{ sourceType: 'USER', messageIds: ['m-fake'], quote: '没说过的话' }],
          oppose: []
        }
      ]),
      usage: { total_tokens: 50 }
    })
  };

  const added = await brain.growSelf('对话文本', '窗口小结', 1, {
    msgMap,
    sourceMessageRange: { firstMessageId: 'm-101', lastMessageId: 'm-102', messageCount: 2 }
  });

  check('Brain.growSelf 生产接线：合法成长条目入账', added === 1);
  check('Brain.growSelf 生产接线：虚假特质被拦截排除', brain.selfLedger.entries.length === 1 && brain.selfLedger.entries[0].trait === '倾向哲学对话');
  check('Brain.growSelf 生产接线：入账条目包含 generationContext', brain.selfLedger.entries[0].generation && brain.selfLedger.entries[0].generation.kind === 'growth');
  check('Brain.growSelf 生产接线：经历归档 self_projection 包含 rejectedEvidence', () => {
    const projs = brain.experiencesArchive.readAll().filter(r => r.recordType === 'self_projection');
    return projs.length === 1 && projs[0].payload.rejectedEvidence.length > 0 && projs[0].payload.generationContext.kind === 'growth';
  });

  console.log('self-ledger tests passed:', pass);
})();
