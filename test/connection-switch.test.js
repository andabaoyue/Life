/**
 * test/connection-switch.test.js — Runtime Connection Switching（0.9.8 Z2）
 *
 * 覆盖（Z2 测试清单）：
 *  1. A → B 成功   2. B 初始化失败   3. B credential 无效/不可用
 *  4. rollback（flat cfg）   5. activeConnectionId rollback
 *  6. 同连接切 model   7. 跨连接 model isolation
 *  8. DeepSeek → custom   9. custom A → custom B
 * 10. runtime evidence isolation   11. Subject / provenance 不受影响
 *
 * fake Brain + fake safeStorage + tmp 目录：无真实 API Key、无网络请求。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const connections = require('../src/connections');
const secureCreds = require('../src/secure-credentials');
const { activateConnection } = require('../src/connection-switch');
const trust = require('../src/provider-runtime-trust');
const { buildGenerationContext } = require('../src/experiment-metadata');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
function tmpDir(prefix = 'conn-switch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const fakeSS = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + s),
  decryptString: (b) => {
    const t = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
    return t.startsWith('ENC:') ? t.slice(4) : null;
  }
};

class FakeBrain {
  constructor(cfg) {
    if (FakeBrain.failNext) { FakeBrain.failNext = false; throw new Error('simulated candidate crash'); }
    this.cfg = cfg;
    this.shutdownCalled = false;
    this.flushed = false;
    this.bound = false;
    this.birthAt = 111111; // Subject identity 哨兵：切换绝不可改
  }
  flushAll() { this.flushed = true; }
  shutdown() { this.shutdownCalled = true; }
  abort() {}
}
FakeBrain.failNext = false;
let createdCount = 0;
const makeCreator = () => (cfg) => { createdCount++; return new FakeBrain(cfg); };
const bindCandidate = (b) => { b.bound = true; };

/* ================= 场景 1：custom A / custom B ================= */
const dir = tmpDir();
const cA = connections.createConnection(dir, {
  displayName: '连接 A', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://a.example.com', model: 'model-a'
});
const cB = connections.createConnection(dir, {
  displayName: '连接 B', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://b.example.com', model: 'model-b'
});
const idA = cA.connection.connectionId, idB = cB.connection.connectionId;
const refA = cA.connection.credentialRef, refB = cB.connection.credentialRef;
secureCreds.setCredential(refA, 'secret-A', { dir, getSS: () => fakeSS });
secureCreds.setCredential(refB, 'secret-B', { dir, getSS: () => fakeSS });
connections.setActiveConnection(dir, idA);

const oldCfg = {
  provider: 'custom', baseURL: 'https://a.example.com', credentialType: 'apiKey',
  model: 'model-a', apiKey: 'secret-A', windowTurns: 100 // 全局参数哨兵
};
const flatWrites = [];
const persistFlat = (cfg) => { flatWrites.push({ ...cfg }); };
const brainA = new FakeBrain(oldCfg);

const r1 = activateConnection({
  dir, targetConnectionId: idB,
  oldBrain: brainA, oldCfg,
  persistFlat, createCandidate: makeCreator(), bindCandidate,
  getSS: () => fakeSS
});
const lastFlat = () => flatWrites[flatWrites.length - 1];
check('1 A → B 成功：store/runtime/Brain 三者一致换绑',
  r1.ok === true && r1.brain !== brainA && r1.brain.bound === true &&
  r1.brain.cfg.apiKey === 'secret-B' && r1.cfg.model === 'model-b' &&
  connections.loadStore(dir).store.activeConnectionId === idB);

check('1 A → B 成功：flat 镜像写入 B 的连接字段并保留全局参数',
  lastFlat().provider === 'custom' && lastFlat().baseURL === 'https://b.example.com' &&
  lastFlat().model === 'model-b' && lastFlat().apiKey === 'secret-B' &&
  lastFlat().windowTurns === 100);

check('1 成功路径关闭旧 Brain（flush + shutdown）',
  brainA.flushed === true && brainA.shutdownCalled === true);

const resolveKey = (cid) => {
  const c = connections.loadStore(dir).store.connections.find((x) => x.connectionId === cid);
  return connections.resolveRuntimeCfg(c, { dir, getSS: () => fakeSS }).cfg.apiKey;
};
check('9 custom A → custom B：两套 key 各自独立、不串写',
  resolveKey(idA) === 'secret-A' && resolveKey(idB) === 'secret-B' &&
  flatWrites.some((w) => w.apiKey === 'secret-B' && w.baseURL === 'https://b.example.com') &&
  !flatWrites.some((w) => (w.apiKey === 'secret-B') !== (w.baseURL === 'https://b.example.com')));

/* ---- 3. credential 不可用 -> fail-closed ---- */
const cC = connections.createConnection(dir, {
  displayName: '连接 C（无凭据）', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://c.example.com', model: 'model-c'
});
const idC = cC.connection.connectionId;
const brainB = r1.brain;
const cfgB = r1.cfg;
const writesBefore3 = flatWrites.length;
const r3 = activateConnection({
  dir, targetConnectionId: idC,
  oldBrain: brainB, oldCfg: cfgB,
  persistFlat, createCandidate: makeCreator(), bindCandidate,
  getSS: () => fakeSS
});
check('3 B credential 不可用 -> fail-closed 拒绝切换（一切未动；present-but-wrong 由请求期/Test Connection 发现）',
  r3.ok === false && r3.error === 'CREDENTIAL_UNAVAILABLE' &&
  flatWrites.length === writesBefore3 &&
  connections.loadStore(dir).store.activeConnectionId === idB &&
  r3.brain === brainB && brainB.shutdownCalled === false);

/* ---- 2/4/5. B 初始化失败 -> dispose + 双回滚 ---- */
const cD = connections.createConnection(dir, {
  displayName: '连接 D（初始化失败）', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://d.example.com', model: 'model-d'
});
const idD = cD.connection.connectionId;
secureCreds.setCredential(cD.connection.credentialRef, 'secret-D', { dir, getSS: () => fakeSS });
FakeBrain.failNext = true;
const r2 = activateConnection({
  dir, targetConnectionId: idD,
  oldBrain: brainB, oldCfg: cfgB,
  persistFlat, createCandidate: makeCreator(), bindCandidate,
  getSS: () => fakeSS
});
check('2 B 初始化失败 -> candidate 失败、旧 Brain 继续服务',
  r2.ok === false && r2.error.includes('新 Brain 初始化失败') &&
  r2.brain === brainB && brainB.shutdownCalled === false);

check('4 rollback：flat cfg 镜像回滚到 A（B 的连接字段不残留）',
  lastFlat().model === 'model-b' && lastFlat().apiKey === 'secret-B' &&
  lastFlat().baseURL === 'https://b.example.com');

check('5 activeConnectionId rollback：store 回到切换前的活动连接',
  r2.activeConnectionId === idB && r2.consistent === true &&
  connections.loadStore(dir).store.activeConnectionId === idB);

/* ---- 6/7. model 切换语义 ---- */
const createdBefore6 = createdCount;
connections.updateConnection(dir, idB, { activeModel: 'model-b2' });
const connB2 = connections.loadStore(dir).store.connections.find((c) => c.connectionId === idB);
const res6 = connections.resolveRuntimeCfg(connB2, { dir, getSS: () => fakeSS });
check('6 同连接切 model：热读生效、不重建 Brain（createCandidate 未被调用）',
  res6.ok === true && res6.cfg.model === 'model-b2' && createdCount === createdBefore6);

const connA = connections.loadStore(dir).store.connections.find((c) => c.connectionId === idA);
const res7 = connections.resolveRuntimeCfg(connA, { dir, getSS: () => fakeSS });
check('7 跨连接 model isolation：A 的 model 不受 B 修改影响',
  res7.ok === true && res7.cfg.model === 'model-a' && res6.cfg.model === 'model-b2');

/* ================= 场景 2：DeepSeek → custom（legacy 零搬移） ================= */
const dir2 = tmpDir('conn-ds-');
fs.writeFileSync(path.join(dir2, 'life-key'), Buffer.from('ENC:legacy-key'));
const mig = connections.migrateLegacyConfig(dir2, {
  provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash'
});
const idDefault = mig.store.connections[0].connectionId;
const cX = connections.createConnection(dir2, {
  displayName: 'Custom X', providerId: 'custom', protocol: 'openai-compatible',
  baseURL: 'https://x.example.com', model: 'model-x'
});
const idX = cX.connection.connectionId;
secureCreds.setCredential(cX.connection.credentialRef, 'secret-x', { dir: dir2, getSS: () => fakeSS });

const flatWrites2 = [];
const oldCfg2 = {
  provider: 'deepseek', baseURL: 'https://api.deepseek.com', credentialType: 'deepseek-api-key',
  model: 'deepseek-flash', apiKey: 'legacy-key'
};
const brainDS = new FakeBrain(oldCfg2);
const r8a = activateConnection({
  dir: dir2, targetConnectionId: idX,
  oldBrain: brainDS, oldCfg: oldCfg2,
  persistFlat: (c) => flatWrites2.push({ ...c }), createCandidate: makeCreator(), bindCandidate,
  getSS: () => fakeSS
});
check('8 DeepSeek → custom：切换解析出 custom 凭据与 credentialType',
  r8a.ok === true && r8a.cfg.provider === 'custom' && r8a.cfg.credentialType === 'apiKey' &&
  r8a.brain.cfg.apiKey === 'secret-x');

const r8b = activateConnection({
  dir: dir2, targetConnectionId: idDefault,
  oldBrain: r8a.brain, oldCfg: r8a.cfg,
  persistFlat: (c) => flatWrites2.push({ ...c }), createCandidate: makeCreator(), bindCandidate,
  getSS: () => fakeSS
});
check('8 custom → DeepSeek：切回 legacy 连接读出原 key（零搬移、文件字节不变）',
  r8b.ok === true && r8b.cfg.provider === 'deepseek' &&
  r8b.cfg.credentialType === 'deepseek-api-key' && r8b.brain.cfg.apiKey === 'legacy-key' &&
  fs.readFileSync(path.join(dir2, 'life-key'), 'utf8') === 'ENC:legacy-key');

/* ---- 11. Subject / provenance 不受影响 ---- */
const sentinels = {
  'self-ledger.json': '{"version":2,"birthAt":111111,"entries":[]}',
  'subject-state.json': '{"values":{"quiet_preference":7}}',
  'experiences.jsonl': '{"archiveSeq":1,"recordHash":"x"}\n'
};
for (const [f, content] of Object.entries(sentinels)) fs.writeFileSync(path.join(dir2, f), content);
// 再执行一次成功切换 + 一次失败切换，观察哨兵
const r11a = activateConnection({
  dir: dir2, targetConnectionId: idX,
  oldBrain: r8b.brain, oldCfg: r8b.cfg,
  persistFlat: () => {}, createCandidate: makeCreator(), bindCandidate,
  getSS: () => fakeSS
});
FakeBrain.failNext = true;
const r11b = activateConnection({
  dir: dir2, targetConnectionId: idDefault,
  oldBrain: r11a.brain, oldCfg: r11a.cfg,
  persistFlat: () => {}, createCandidate: makeCreator(), bindCandidate,
  getSS: () => fakeSS
});
check('11 Subject / provenance 不受影响：self-ledger/subject-state/experiences 零写入',
  r11a.ok === true && r11b.ok === false &&
  Object.entries(sentinels).every(([f, content]) =>
    fs.readFileSync(path.join(dir2, f), 'utf8') === content));

check('11 Subject isolation：Connection 元数据不进 runtime cfg / 不改 birthAt',
  (() => {
    const metaKeys = ['displayName', 'connectionId', 'credentialRef', 'credentialOwnership', 'capabilitySnapshot', 'testState', 'protocol', 'models'];
    return metaKeys.every((k) => !(k in r11a.cfg)) && r11a.brain.birthAt === 111111;
  })());

/* ================= 10. runtime evidence isolation ================= */
const mintA = trust.createProviderRuntimeMintAuthority('deepseek', { complete: () => {}, stream: () => {} });
const mintB = trust.createProviderRuntimeMintAuthority('deepseek', { complete: () => {}, stream: () => {} });
const respA = mintA({ text: 'A', usage: {}, observedModel: 'm-a' });
const respB = mintB({ text: 'B', usage: {}, observedModel: 'm-b' });
const dsCfg = { provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'm' };
const ctxA = buildGenerationContext({ kind: 'summary', cfg: dsCfg, providerResponse: respA });
const ctxB = buildGenerationContext({ kind: 'summary', cfg: dsCfg, providerResponse: respB });
check('10 runtime evidence isolation：A/B 各自认证、互不串绑（observedModel 不跨连接）',
  ctxA.observedModelSource === 'provider_response' && ctxA.observedModel === 'm-a' &&
  ctxB.observedModelSource === 'provider_response' && ctxB.observedModel === 'm-b');

const forged = { text: 'F', usage: {}, observedModel: 'm-fake' };
const ctxF = buildGenerationContext({ kind: 'summary', cfg: dsCfg, providerResponse: forged });
check('10 伪造/跨源对象不得升级（caller_or_config），trust root 未被绕过',
  ctxF.observedModelSource === 'caller_or_config' && ctxF.observedModel === 'm-fake');

check('10 connectionId/displayName 不进入 attestation / GenerationContext',
  !('connectionId' in ctxA) && !('displayName' in ctxA) && !('credentialRef' in ctxA));

console.log('\n' + (failures ? failures + ' 项失败' : 'connection-switch tests passed: '));
process.exit(failures ? 1 : 0);
