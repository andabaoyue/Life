/**
 * 配置读写测试 —— 缓存必须"可失效"，而且不能跨目录串味。
 *
 * 起因是 Gemini 提的第 9 条：`let cached` 是模块级单值，挡住了热重载。
 * 复测之后这条属实，而且比"要重启"更糟一层：换目录读会拿到上一个目录的配置。
 * 下面第 1 组用例就是这个（改之前 load(B) 返回的是 A 的配置）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, save, DEFAULTS, _clearCache } = require('../src/config');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-cfg-'));
const CFG = 'life-config.json';
const writeRaw = (dir, obj) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CFG), JSON.stringify(obj));
};

const A = mk(), B = mk();
writeRaw(A, { model: 'from-A', windowTurns: 7 });
writeRaw(B, { model: 'from-B' });

/* ---- 1. 目录隔离 ---- */
_clearCache();
check('load(A) 读到 A 自己的配置', load(A).model === 'from-A');
check('load(B) 读到 B 的配置，不是 A 的（旧的单变量缓存会在这里红）',
  load(B).model === 'from-B', load(B).model);
check('两个目录互不影响（A 仍是 A 的值）', load(A).model === 'from-A');
check('未写的字段用 DEFAULTS 补齐', load(B).windowTurns === DEFAULTS.windowTurns
  && load(B).baseURL === DEFAULTS.baseURL);
check('price 只按 peak/valley 两档合并，档内是整体替换', (() => {
  const d = mk();
  writeRaw(d, { price: { peak: { hit: 0.9, miss: 3, out: 9 } } });
  const c = load(d);
  // 合并只到"哪一档"这一层：写了 peak 就整份换掉 peak，没写的 valley 保持默认。
  // 也就是说档内少写一个字段，costOf 里 `p.miss || 0` 会按 0 计费（少算）。
  // 这是既有语义，README 的示例也是给完整一档 —— 不把测试写成"应该深合并"，
  // 那等于用测试偷偷改契约；真要改就单独改，别藏在测试里。
  return c.price.peak.hit === 0.9 && c.price.peak.miss === 3
    && c.price.valley.out === DEFAULTS.price.valley.out;
})());

/* ---- 2. 热重载：外部改文件，下一次 load 就生效 ---- */
{
  const d = mk();
  writeRaw(d, { model: 'one' });
  load(d);
  writeRaw(d, { model: 'two-with-longer-text' });      // 用户在编辑器里改
  check('手改配置文件后不必重启（Gemini #9）',
    load(d).model === 'two-with-longer-text');
  writeRaw(d, { model: 'two-with-longer-tex2' });      // 同字节数、同毫秒的第二次修改
  check('只改字符不改长度也能读到（mtime+size 做失效键会漏掉这一种）',
    load(d).model === 'two-with-longer-tex2');
  check('连续两次同内容 load 都真的来自盘（新内容立刻可见）', (() => {
    writeRaw(d, { model: 'three' });
    return load(d).model === 'three' && load(d).model === 'three';
  })());
}

/* ---- 3. save 与 load 一致，且明文 key 不落盘 ---- */
{
  const d = mk();
  const r = save(d, { ...DEFAULTS, apiKey: 'sk-secret', model: 'saved' });
  check('save 返回值与紧接着 load 到的一致', load(d).model === 'saved'
    && load(d).apiKey === r.apiKey);
  const raw = fs.readFileSync(path.join(d, CFG), 'utf8');
  check('裸 save 不把 apiKey 写进配置文件（v0.6 的源头摘除）',
    !raw.includes('sk-secret') && !raw.includes('apiKey'), raw.slice(0, 60));
  check('裸 save 的返回视图也不带明文 key（否则又会被下一次裸 save 写回去）',
    !('apiKey' in r) || r.apiKey === '', JSON.stringify(r.apiKey));
  check('save 之后改盘上文件仍能热读到', (() => {
    writeRaw(d, { model: 'external' });
    return load(d).model === 'external';
  })());
}

/* ---- 4. diskOverride 接缝（secure.js 用的那个参数） ---- */
{
  const d = mk();
  const r = save(d, { ...DEFAULTS, apiKey: 'sk-in-memory', model: 'm' },
    { model: 'm', apiKey: 'sk-fake-on-disk' });
  const raw = fs.readFileSync(path.join(d, CFG), 'utf8');
  check('给了 override 就只落 override 那份（明文 key 由降级路径写）',
    raw.includes('sk-fake-on-disk') && !raw.includes('sk-in-memory'));
  check('override 里的 apiKey 会反映到返回视图 —— 降级明文时上层还要拿它发请求',
    r.apiKey === 'sk-fake-on-disk', JSON.stringify(r.apiKey));
  check('override 没写的字段仍由 DEFAULTS 补齐', r.windowTurns === DEFAULTS.windowTurns);
}

/* ---- 5. 坏文件与缺文件的降级 ---- */
{
  const d = mk();
  writeRaw(d, { model: 'good' });
  load(d);                                             // 先建立缓存
  fs.writeFileSync(path.join(d, CFG), '{ model: 坏掉的 JSON');
  check('JSON 语法坏掉 → 退回 DEFAULTS 而不是抛', load(d).model === DEFAULTS.model);
  const e = mk();
  check('配置文件不存在 → DEFAULTS', load(e).model === DEFAULTS.model);
  check('目录不存在也不抛', load(path.join(e, 'nope')).model === DEFAULTS.model);
}

/* ---- 6. 瞬时读失败不能把缓存冲成出厂值 ----
   EPERM/EACCES/EBUSY 时文件内容是好的，只是这一刻读不到。
   若此时清缓存，下一次 load 返回 DEFAULTS，紧跟着的 save 就把用户配置写没了。 */
{
  const d = mk();
  writeRaw(d, { model: 'precious', windowTurns: 42 });
  load(d);
  const real = fs.readFileSync;
  fs.readFileSync = (p, enc) => {
    if (String(p).endsWith(CFG)) { const e = new Error('占用'); e.code = 'EPERM'; throw e; }
    return real(p, enc);
  };
  const during = load(d);
  fs.readFileSync = real;
  check('瞬时 EPERM 仍返回上一次的有效配置（不清成 DEFAULTS）',
    during.model === 'precious' && during.windowTurns === 42, JSON.stringify(during.model));
  check('占用恢复后照常读到盘上的值', load(d).model === 'precious');
}

/* ---- 7. 同一个目录的不同路径写法共用同一份兜底 ----
   现在每次都真读盘，所以"读到同样的值"是平凡的；
   真正需要 realpath 的是读失败那一刻 —— 兜底缓存若按字符串分Key，
   从另一条写法读失败就会退回 DEFAULTS，把用户配置写成出厂值。 */
{
  const d = mk();
  writeRaw(d, { model: 'one' });
  const viaDot = path.join(d, '..') + path.sep + path.basename(d);   // .../xxx/../xxx
  writeRaw(d, { model: 'two' });
  check('经 `..` 绕路访问同一目录读到同一份热更新后的值',
    load(viaDot).model === 'two' && load(d).model === 'two');
  check('两条写法在发生瞬时读失败时都退回同一份（而不是出厂值）', (() => {
    load(d); load(viaDot);                       // 两边都建立过兜底
    const real = fs.readFileSync;
    fs.readFileSync = () => { const e = new Error('占用'); e.code = 'EBUSY'; throw e; };
    const r1 = load(d).model, r2 = load(viaDot).model;
    fs.readFileSync = real;
    return r1 === 'two' && r2 === 'two';
  })());
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
for (const d of [A, B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 交给系统 */ } }
process.exit(failures ? 1 : 0);
