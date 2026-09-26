const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SelfLedger, SCHEMA_VERSION } = require('../src/self-ledger');

let pass = 0;
function check(name, value) { assert.ok(value, name); pass++; console.log('PASS', name); }
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
console.log('self-ledger tests passed:', pass);
