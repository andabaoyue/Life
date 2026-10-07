/**
 * test/connections.test.js — ConnectionStore / CredentialRef / Legacy Migration（0.9.8 Z1）
 *
 * 覆盖（Z1-H 清单）：
 *  1. 单 Connection  2. 同协议多 Connection  3. A/B 不同 credentialRef
 *  4. credential isolation  5. 删除 Connection 的 credential 语义  6. Legacy migration
 *  7. migration idempotence  8. DeepSeek legacy 零搬移  9. migration fail-closed
 * 10. models / activeModel 独立  11. protocol 枚举校验  12. capabilitySnapshot 与 runtime capability 分离
 *
 * 全部使用 tmp 目录与 fake safeStorage，不使用真实 API Key、不发网络请求。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const connections = require('../src/connections');
const secureCreds = require('../src/secure-credentials');
const secure = require('../src/secure');
const { assertCapability } = require('../src/provider-adapter');

// [D-8a 手法] 临时目录卫生：包住 fs.mkdtempSync 登记 + process.on('exit') 统一清。
// 不清理单次跑净留沙盒目录（%TEMP% 累积投诉的根因，见 tmp-hygiene.test.js 头注释）。
const _hygDirs = [];
const _hygOrigMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _hygOrigMkdtemp.apply(fs, a);
  _hygDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _hygDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不掀桌 */ }
  }
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'conn-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// fake safeStorage：加密“可用”但算法可逆（仅供测试，绝不接触真实 keychain）
const fakeSS = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + s),
  decryptString: (b) => {
    const t = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
    return t.startsWith('ENC:') ? t.slice(4) : null;
  }
};

/* ================= 1/2/3/4/5/10：CRUD + credential ================= */
const dir1 = tmpDir();
const c1 = connections.createConnection(dir1, {
  displayName: '连接 A', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://a.example.com', model: 'model-a'
});
check('1 单 Connection：createConnection 生成 connectionId/credentialRef 并落盘 store',
  c1.ok === true && /^conn-/.test(c1.connection.connectionId) &&
  /^cred:/.test(c1.connection.credentialRef) &&
  fs.existsSync(connections.storePath(dir1)));

const loaded1 = connections.loadStore(dir1);
const rec1 = loaded1.store && loaded1.store.connections[0];
check('2 单 Connection：store 回读字段完整（Provider/Protocol/Model/capabilitySnapshot/testState）',
  loaded1.status === 'ok' && rec1.providerId === 'custom' && rec1.protocol === 'openai-compatible' &&
  rec1.activeModel === 'model-a' && Array.isArray(rec1.models) && rec1.models.includes('model-a') &&
  rec1.testState && rec1.testState.status === 'unverified' && rec1.credentialOwnership === 'exclusive');

const c2 = connections.createConnection(dir1, {
  displayName: '连接 B', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://b.example.com', model: 'model-b'
});
check('3 同协议多 Connection：两个 openai-compatible 连接共存（同 providerId 不互斥）',
  c2.ok === true && connections.loadStore(dir1).store.connections.length === 2 &&
  connections.loadStore(dir1).store.connections.every((c) => c.protocol === 'openai-compatible'));

check('3 A/B 不同 credentialRef（独立且不派生自 connectionId）',
  c1.connection.credentialRef !== c2.connection.credentialRef &&
  c1.connection.credentialRef !== 'cred:' + c1.connection.connectionId);

check('3 createConnection 拒绝调用方指定 credentialRef / connectionId（服务端生成）',
  connections.createConnection(dir1, { displayName: 'X', providerId: 'custom', protocol: 'openai-compatible', baseURL: 'https://x.example.com', model: 'm', credentialRef: 'cred:hack' }).error === 'CREDENTIAL_REF_MUST_BE_SERVER_GENERATED' &&
  connections.createConnection(dir1, { displayName: 'X', providerId: 'custom', protocol: 'openai-compatible', baseURL: 'https://x.example.com', model: 'm', connectionId: 'conn-hack' }).error === 'CONNECTION_ID_MUST_BE_SERVER_GENERATED');

const wA = secureCreds.setCredential(c1.connection.credentialRef, 'secret-A', { dir: dir1, getSS: () => fakeSS });
const wB = secureCreds.setCredential(c2.connection.credentialRef, 'secret-B', { dir: dir1, getSS: () => fakeSS });
check('4 credential isolation：A/B 各自读回自己的 secret',
  wA.ok && wB.ok && wA.encrypted === true &&
  secureCreds.getCredential(c1.connection.credentialRef, { dir: dir1, getSS: () => fakeSS }) === 'secret-A' &&
  secureCreds.getCredential(c2.connection.credentialRef, { dir: dir1, getSS: () => fakeSS }) === 'secret-B');

check('4 credential isolation：A/B 落盘 namespace 文件不同（互不可见）',
  secure.primaryKeyPath(dir1, secureCreds.parseCredentialRef(c1.connection.credentialRef).key) !==
  secure.primaryKeyPath(dir1, secureCreds.parseCredentialRef(c2.connection.credentialRef).key));

check('10 models / activeModel 独立：update A 的 model 不影响 B',
  connections.updateConnection(dir1, c1.connection.connectionId, { activeModel: 'model-a2' }).ok === true &&
  connections.loadStore(dir1).store.connections.find((c) => c.connectionId === c1.connection.connectionId).activeModel === 'model-a2' &&
  connections.loadStore(dir1).store.connections.find((c) => c.connectionId === c2.connection.connectionId).activeModel === 'model-b');

check('5 updateConnection 拒绝改 immutable 字段（credentialRef/connectionId/credentialOwnership）',
  connections.updateConnection(dir1, c1.connection.connectionId, { credentialRef: 'cred:x' }).error === 'IMMUTABLE_FIELD: credentialRef' &&
  connections.updateConnection(dir1, c1.connection.connectionId, { connectionId: 'conn-z' }).error === 'IMMUTABLE_FIELD: connectionId' &&
  connections.updateConnection(dir1, c1.connection.connectionId, { credentialOwnership: 'legacy-mapped' }).error === 'IMMUTABLE_FIELD: credentialOwnership');

const delB = connections.deleteConnection(dir1, c2.connection.connectionId, { deleteCredential: true, getSS: () => fakeSS });
check('5 删除 exclusive Connection 联动删除其独占 credential',
  delB.ok === true && delB.credentialDeleted === true &&
  secureCreds.getCredential(c2.connection.credentialRef, { dir: dir1, getSS: () => fakeSS }) === null);

check('5 删除 A 不影响 B 残留语义：A 的 secret 仍可读（B 已删、A 未删）',
  secureCreds.getCredential(c1.connection.credentialRef, { dir: dir1, getSS: () => fakeSS }) === 'secret-A');

// 共享凭据本轮不实现：共享 ref 的 store 在入口级即被拒绝（防"删 A 误删 B 凭据"）
const sharedStore = {
  schemaVersion: 1,
  activeConnectionId: 'conn-1',
  connections: [
    { connectionId: 'conn-1', displayName: 'S1', providerId: 'custom', protocol: 'openai-compatible', baseURL: 'https://s1.example.com', credentialRef: 'cred:shared', credentialOwnership: 'exclusive', models: ['m'], activeModel: 'm', capabilitySnapshot: null, testState: { status: 'unverified', lastTestedAt: null, phase: null, reason: null } },
    { connectionId: 'conn-2', displayName: 'S2', providerId: 'custom', protocol: 'openai-compatible', baseURL: 'https://s2.example.com', credentialRef: 'cred:shared', credentialOwnership: 'exclusive', models: ['m'], activeModel: 'm', capabilitySnapshot: null, testState: { status: 'unverified', lastTestedAt: null, phase: null, reason: null } }
  ]
};
check('5 共享 credentialRef 的 store 被拒绝（入口级防误删）',
  connections.validateStore(sharedStore).ok === false &&
  connections.saveStore(dir1, sharedStore).ok === false &&
  connections.validateStore(sharedStore).errors.some((e) => e.includes('SHARED_CREDENTIAL_REF_NOT_ALLOWED')));

check('1 setActiveConnection 切换生效 / 未知 id fail-closed',
  connections.setActiveConnection(dir1, c1.connection.connectionId).ok === true &&
  connections.loadStore(dir1).store.activeConnectionId === c1.connection.connectionId &&
  connections.setActiveConnection(dir1, 'conn-nope').ok === false);

/* ================= 6/7/8/9：Legacy Migration ================= */
const dir2 = tmpDir('conn-legacy-');
// 预置 DeepSeek legacy 密文文件（fake cipher）——迁移必须零搬移、零改动
fs.writeFileSync(path.join(dir2, 'life-key'), Buffer.from('ENC:legacy-key'));
const flatCfg = {
  apiKey: 'sk-never-persisted', baseURL: 'https://api.deepseek.com',
  provider: 'deepseek', credentialType: 'deepseek-api-key',
  model: 'deepseek-flash', modelVersion: 'v3'
};
const mig1 = connections.migrateLegacyConfig(dir2, flatCfg);
const mconn = mig1.store && mig1.store.connections[0];
check('6 Legacy migration：conn-default 字段映射正确（provider/protocol/ref/ownership/model）',
  mig1.ok === true && mig1.migrated === true &&
  mconn.connectionId === 'conn-default' && mconn.providerId === 'deepseek' &&
  mconn.protocol === 'openai-compatible' && mconn.credentialRef === 'cred:deepseek' &&
  mconn.credentialOwnership === 'legacy-mapped' &&
  mconn.models.includes('deepseek-flash') && mconn.activeModel === 'deepseek-flash');

check('6 Legacy migration：activeConnectionId 指向 default connection',
  mig1.store.activeConnectionId === 'conn-default');

const mig2 = connections.migrateLegacyConfig(dir2, flatCfg);
check('7 migration idempotence：重复执行不重复建连接、ref 不变、migrated:false',
  mig2.ok === true && mig2.migrated === false &&
  mig2.store.connections.length === 1 &&
  mig2.store.connections[0].credentialRef === 'cred:deepseek');

check('8 DeepSeek legacy 零搬移：life-key 文件字节不变',
  fs.readFileSync(path.join(dir2, 'life-key'), 'utf8') === 'ENC:legacy-key');

check('8 DeepSeek legacy 零搬移：cred:deepseek 可读出 legacy key（密文路径）',
  secureCreds.getCredential('cred:deepseek', { dir: dir2, getSS: () => fakeSS }) === 'legacy-key');

check('8 Legacy 明文降级：fallbackSecret 仅由调用方显式提供才可读',
  secureCreds.getCredential('cred:deepseek', { dir: dir2, getSS: () => null }) === null &&
  secureCreds.getCredential('cred:deepseek', { dir: dir2, getSS: () => null, fallbackSecret: 'sk-plain' }) === 'sk-plain');

const delLegacy = connections.deleteConnection(dir2, 'conn-default', { deleteCredential: true, getSS: () => fakeSS });
check('5 legacy-mapped Connection 删除只删连接、legacy 文件保留（不误删）',
  delLegacy.ok === true && delLegacy.credentialDeleted === false &&
  delLegacy.credentialNote === 'LEGACY_CREDENTIAL_KEPT' &&
  fs.existsSync(path.join(dir2, 'life-key')));

// fail-closed：store 已损坏 -> 拒绝迁移、不覆盖文件、不触碰 flat config
const dir3 = tmpDir('conn-corrupt-');
const corruptPath = connections.storePath(dir3);
fs.writeFileSync(corruptPath, '{not-json');
const flatPath = path.join(dir3, 'life-config.json');
fs.writeFileSync(flatPath, JSON.stringify({ apiKey: 'sk-keep', provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }));
const migBad = connections.migrateLegacyConfig(dir3, flatCfg);
check('9 migration fail-closed：store 已损坏时拒绝迁移且不覆盖半成品',
  migBad.ok === false && fs.readFileSync(corruptPath, 'utf8') === '{not-json' &&
  connections.loadStore(dir3).status === 'invalid');

check('9 migration 全程不改写旧 flat 配置（旧真源保持原样）',
  fs.readFileSync(flatPath, 'utf8').includes('sk-keep') &&
  JSON.parse(fs.readFileSync(flatPath, 'utf8')).model === 'deepseek-flash');

/* ================= 11：protocol 枚举 ================= */
const badProto = (proto) => connections.createConnection(dir1, {
  displayName: 'P', providerId: 'custom', protocol: proto,
  baseURL: 'https://p.example.com', model: 'm'
});
check('11 protocol 枚举：cloud-direct / local / custom / 空值一律拒绝（部署类型不得写入 protocol）',
  badProto('cloud-direct').ok === false && badProto('cloud-direct').error.includes('PROTOCOL_NOT_SUPPORTED') &&
  badProto('local').ok === false && badProto('custom').ok === false && badProto('').ok === false);

check('11 protocol 枚举：anthropic-native 可保存（数据结构支持，本轮不实现 transport）',
  (() => {
    const r = connections.createConnection(dir1, {
      displayName: 'Claude', providerId: 'claude', protocol: 'anthropic-native',
      baseURL: 'https://api.anthropic.com', model: 'claude-x'
    });
    return r.ok === true && r.connection.protocol === 'anthropic-native';
  })());

check('11 protocol 枚举：未知 protocol 拒绝（不猜测）',
  badProto('some-unknown-wire').ok === false);

/* ================= 12：capabilitySnapshot ≠ runtime capability ================= */
const capConn = connections.createConnection(dir1, {
  displayName: 'Cap', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://cap.example.com', model: 'm', capabilitySnapshot: { streaming: true, modelDiscovery: true }
});
check('12 capabilitySnapshot 可持久化为快照数据（仅 UI/缓存）',
  capConn.ok === true &&
  connections.loadStore(dir1).store.connections.find((c) => c.connectionId === capConn.connection.connectionId)
    .capabilitySnapshot.streaming === true);

const fakeAdapterNoDecl = { providerId: 'custom' }; // 无 capabilities() 声明
const fakeAdapterEmpty = { providerId: 'custom', capabilities: () => ({}) }; // 显式空声明
check('12 capabilitySnapshot ≠ runtime capability：快照 streaming:true 不授予 runtime 能力（assertCapability 仍 fail-closed）',
  (() => {
    try { assertCapability(fakeAdapterNoDecl, 'streaming'); return false; }
    catch (e) { return e.name === 'UnsupportedCapabilityError'; }
  })() &&
  (() => {
    try { assertCapability(fakeAdapterEmpty, 'streaming'); return false; }
    catch (e) { return e.name === 'UnsupportedCapabilityError'; }
  })());

console.log('\n' + (failures ? failures + ' 项失败' : 'connections tests passed: '));
process.exit(failures ? 1 : 0);
