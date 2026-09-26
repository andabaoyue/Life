/**
 * API Key 存储测试
 *
 * 守的是两件事：
 *   1. 明文 key 不能悄悄落盘（加密可用时一个字节都不许进 config.json）
 *   2. 不能为了安全把用户搞成「下次启动没 key」，也不能没加密却声称已加密
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const secure = require('../src/secure');
const { save: saveCfg, DEFAULTS } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
const KEY = 'sk-abcdef-1234567890';

/* 假 safeStorage：可逆「加密」（XOR），只验接口行为，不验密码学 */
const MAGIC = Buffer.from('FKE1');   // 让我们造的"密文"能被认出真伪
function fakeSS(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => {
      if (!available) throw new Error('unavailable');
      return Buffer.concat([MAGIC, Buffer.from(s, 'utf8').map(b => b ^ 0x5a)]);
    },
    decryptString: (b) => {
      if (!available) throw new Error('unavailable');
      if (!b || b.length < MAGIC.length || !b.subarray(0, 4).equals(MAGIC))
        throw new Error('decrypt failed');   // 真实 safeStorage 在换机器/数据损坏时就是这样抛
      return Buffer.from(b.subarray(4).map(x => x ^ 0x5a)).toString('utf8');
    }
  };
}
/* 走真实 config.js 的写入，验证的是**实际落盘内容**。
   读取也刻意直接读文件而不是走 config.load：secure.loadConfig 收的是
   一个 readDisk 回调，测试要把"磁盘上到底有没有明文 key"这件事
   和被测函数自己传给它的东西对上，中间隔一层缓存就没法断言。
   （v0.7 起 load 已改为每次真读盘、且按目录分开，跨目录串味那个老问题没了；
   这里保留绕过的写法，因为它验的是更下面一层。） */
function disk(dir) {
  return {
    read: () => { try { return JSON.parse(fs.readFileSync(secure.cfgPath(dir), 'utf8')); }
                  catch { return null; } },
    write: (obj) => saveCfg(dir, { ...DEFAULTS, ...obj })
  };
}
const readDisk = (dir) => () => {
  const raw = disk(dir).read();
  return raw ? { ...DEFAULTS, ...raw, price: { ...DEFAULTS.price, ...(raw.price || {}) } } : null;
};
function rawText(dir) {
  try { return fs.readFileSync(secure.cfgPath(dir), 'utf8'); } catch { return ''; }
}
/**
 * 造一份「老版本写出来的明文配置文件」。
 * 必须绕开 config.save 直接写文件：v0.6 起裸 save 已经不会再落明文 key，
 * 用它模拟 v0.5.0 的产物就等于什么也没模拟（这个坑我自己踩过一次）。
 */
function writeLegacyPlaintext(dir, key) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(secure.cfgPath(dir),
    JSON.stringify({ ...DEFAULTS, apiKey: key }, null, 2), 'utf8');
}

/* ---------- 0. 裸 save 也不会漏出明文 key ---------- */
let dir = tmp();
saveCfg(dir, { ...DEFAULTS, apiKey: KEY });            // 不带 override 的那条路
check('裸 save 不落明文 key（防止绕过 secure 的写口）',
  !rawText(dir).includes(KEY) && !('apiKey' in (disk(dir).read() || {})));

/* ---------- 1. 加密可用：明文绝不进配置文件 ---------- */
dir = tmp();
let d = disk(dir);
const mem = (obj, key) => ({ ...DEFAULTS, ...obj, apiKey: key });  // 内存态
let r = secure.saveConfig(() => fakeSS(true), dir,
  { ...DEFAULTS, apiKey: KEY, model: 'deepseek-flash' },
  (diskObj) => saveCfg(dir, mem(diskObj, KEY), diskObj));
check('加密可用时报告 encrypted=true', r.encrypted === true && r.hasKey === true);
check('config.json 里不含明文 key', !rawText(dir).includes(KEY), rawText(dir).slice(0, 60));
check('config.json 里没有 apiKey 字段', !('apiKey' in (d.read() || {})));
check('密文文件已生成且不是明文',
  fs.existsSync(secure.keyPath(dir)) &&
  !fs.readFileSync(secure.keyPath(dir)).includes(KEY));
check('其余配置照常落盘', d.read().model === 'deepseek-flash');

/* 读回：内存里有 key，文件里依然没有 */
let l = secure.loadConfig(() => fakeSS(true), dir, readDisk(dir));
check('能从密文文件解出原 key', l.cfg.apiKey === KEY && l.encrypted === true);
check('解出后 config.json 仍无明文', !rawText(dir).includes(KEY));

/* ---------- 2. 加密不可用：退回明文但如实上报 ---------- */
dir = tmp(); d = disk(dir);
r = secure.saveConfig(() => fakeSS(false), dir, { ...DEFAULTS, apiKey: KEY },
  (diskObj) => saveCfg(dir, mem(diskObj, KEY), diskObj));
check('加密不可用时 encrypted=false（不许谎称已加密）', r.encrypted === false);
check('加密不可用时仍保住 key（不能让用户下次启动没 key）',
  r.hasKey === true && d.read().apiKey === KEY);
check('此时不留密文文件（避免误判成已加密）',
  !fs.existsSync(secure.keyPath(dir)));
l = secure.loadConfig(() => fakeSS(false), dir, readDisk(dir));
check('降级路径读回 key 一致', l.cfg.apiKey === KEY && l.encrypted === false);

/* ---------- 3. 老版本明文迁移 ---------- */
dir = tmp();
writeLegacyPlaintext(dir, KEY);                      // 模拟 v0.5.0 留下的明文
l = secure.loadConfig(() => fakeSS(true), dir, readDisk(dir));
check('老版本明文 key 升级即转加密（不用用户再保存一次）',
  l.cfg.apiKey === KEY && l.encrypted === true && l.migrated === true);
check('迁移后明文从 config.json 消失', !rawText(dir).includes(KEY));
check('迁移后密文文件可用', secure.loadConfig(() => fakeSS(true), dir,
  readDisk(dir)).cfg.apiKey === KEY);

dir = tmp();
writeLegacyPlaintext(dir, KEY);
l = secure.loadConfig(() => fakeSS(false), dir, readDisk(dir));
check('加密不可用时不迁移也不删明文（删了就等于删掉唯一凭据）',
  l.encrypted === false && rawText(dir).includes(KEY));
// 用户下次保存即转加密
secure.saveConfig(() => fakeSS(true), dir, { ...DEFAULTS, apiKey: KEY },
  (diskObj) => saveCfg(dir, mem(diskObj, KEY), diskObj));
check('下次保存后明文彻底消失', !rawText(dir).includes(KEY));
check('迁移后能正常解出', secure.loadConfig(() => fakeSS(true), dir, readDisk(dir)).cfg.apiKey === KEY);

/* ---------- 4. 密文解不出时不能删明文 ---------- */
dir = tmp();
writeLegacyPlaintext(dir, KEY);
fs.writeFileSync(secure.keyPath(dir), Buffer.from('garbage-not-decryptable'));
l = secure.loadConfig(() => fakeSS(true), dir, readDisk(dir));
check('密文损坏时回退到明文 key', l.cfg.apiKey === KEY && l.encrypted === false);
check('密文损坏时明文保留（否则用户被锁死）', rawText(dir).includes(KEY));

/* ---------- 5. 清 key ---------- */
dir = tmp();
secure.saveConfig(() => fakeSS(true), dir, { ...DEFAULTS, apiKey: KEY },
  (diskObj) => saveCfg(dir, mem(diskObj, KEY), diskObj));
secure.saveConfig(() => fakeSS(true), dir, { ...DEFAULTS, apiKey: '' },
  (diskObj) => saveCfg(dir, mem(diskObj, ''), diskObj));
check('清空 key 时密文文件一并删除', !fs.existsSync(secure.keyPath(dir)));
check('清空后读回无 key',
  secure.loadConfig(() => fakeSS(true), dir, readDisk(dir)).cfg.apiKey === '');

/* ---------- 6. safeStorage 缺失/抛异常也不能崩 ---------- */
dir = tmp();
r = secure.saveConfig(() => null, dir, { ...DEFAULTS, apiKey: KEY },
  (diskObj) => saveCfg(dir, mem(diskObj, KEY), diskObj));
check('safeStorage 为 null 时降级不崩', r.encrypted === false && r.hasKey === true);
r = secure.saveConfig(() => { throw new Error('boom'); }, dir,
  { ...DEFAULTS, apiKey: KEY }, (diskObj) => saveCfg(dir, mem(diskObj, KEY), diskObj));
check('isEncryptionAvailable 抛异常时降级不崩', r.encrypted === false && r.hasKey === true);
l = secure.loadConfig(() => { throw new Error('boom'); }, dir, readDisk(dir));
check('读取侧抛异常也不崩且保住 key', l.cfg.apiKey === KEY);

/* ---------- 7. 明文不许从任何出口漏出 ---------- */
const srcMain = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
check('main.js 里 config-open 不再整份写 cfg（含 key 的那份）',
  !/writeFileSync\(p,\s*JSON\.stringify\(cfg/.test(srcMain));
check('main.js 的 config-set-key 走 persistCfg 而不是裸 save',
  !/save\(app\.getPath\('userData'\),\s*\{[^}]*apiKey/.test(srcMain));
const srcPet = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
check('preload 不把 apiKey 透给渲染进程', !/apiKey/.test(srcPet));

/* ---------- 8. 事务式保存一致性与回滚测试 (P0-01) ---------- */
dir = tmp(); d = disk(dir);
const OLD_KEY = 'sk-old-version-111';
const NEW_KEY = 'sk-new-version-222';

// 初始保存老版本
secure.saveConfig(() => fakeSS(true), dir, { ...DEFAULTS, apiKey: OLD_KEY, model: 'deepseek-flash' },
  (diskObj) => saveCfg(dir, mem(diskObj, OLD_KEY), diskObj));

// 8.1 模拟 config 写入失败：Key 保持旧版本，config 保持旧版本
let threw = false;
try {
  secure.saveConfig(() => fakeSS(true), dir, { ...DEFAULTS, apiKey: NEW_KEY, model: 'deepseek-v3' },
    () => { throw new Error('simulated disk failure'); });
} catch (e) {
  threw = true;
}
check('模拟 config 写入失败时抛出异常', threw);
l = secure.loadConfig(() => fakeSS(true), dir, readDisk(dir));
check('模拟 config 写入失败后 Key 保持旧版本', l.cfg.apiKey === OLD_KEY);
check('模拟 config 写入失败后 config 保持旧版本', d.read().model === 'deepseek-flash');
check('失败后无临时文件残留', fs.readdirSync(dir).filter(f => f.includes('.tmp-')).length === 0);

// 8.2 正常修改 Key 后重启，读取到新 Key
secure.saveConfig(() => fakeSS(true), dir, { ...DEFAULTS, apiKey: NEW_KEY, model: 'deepseek-v3' },
  (diskObj) => saveCfg(dir, mem(diskObj, NEW_KEY), diskObj));
l = secure.loadConfig(() => fakeSS(true), dir, readDisk(dir));
check('正常修改 Key 后读取到新 Key', l.cfg.apiKey === NEW_KEY);
check('正常修改后 config 生效', d.read().model === 'deepseek-v3');

// 8.3 模拟第二阶段 Key 提交失败：两边全部回滚到原有状态
threw = false;
try {
  secure.saveConfig(() => fakeSS(true), dir, { ...DEFAULTS, apiKey: 'sk-fail-commit-333', model: 'deepseek-r1' },
    (diskObj) => saveCfg(dir, mem(diskObj, 'sk-fail-commit-333'), diskObj),
    { beforeKeyCommit: () => { throw new Error('simulated commit failure'); } });
} catch (e) {
  threw = true;
}
check('模拟第二阶段失败时抛出异常', threw);
l = secure.loadConfig(() => fakeSS(true), dir, readDisk(dir));
check('第二阶段失败后 Key 保持旧版本', l.cfg.apiKey === NEW_KEY);
check('第二阶段失败后 config 保持旧版本', d.read().model === 'deepseek-v3');
check('第二阶段失败后无临时文件残留', fs.readdirSync(dir).filter(f => f.includes('.tmp-')).length === 0);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);

