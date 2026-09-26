/**
 * 换装系统数据层测试
 *
 * 覆盖：槽位/层序、互斥规则、身份锁定、非法输入、AI 提案诚实性、
 *       持久化往返、脏文件降级、衣柜资源真实存在。
 *
 * 这些是「语言状态 ≠ 程序状态」这条铁律的守门人：
 * 只要有人以后把换装改成「模型说换了就算换了」，这里会红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wardrobe, CATALOG, PRESETS, SLOTS, SLOT_IDS, validate } = require('../src/wardrobe');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));

/* ---------- 结构与资源 ---------- */
check('9 个槽位齐备',
  SLOT_IDS.length === 9 &&
  ['hair', 'hairAccessory', 'top', 'bottom', 'dress', 'socks', 'shoes', 'outerwear', 'accessory']
    .every(s => SLOT_IDS.includes(s)));

check('每个槽位都有中文名（面板要用）', SLOTS.every(s => !!s.name));

check('衣柜里每个 file 在磁盘上真实存在',
  Object.entries(CATALOG).every(([, it]) =>
    fs.existsSync(path.join(__dirname, '..', 'assets', 'character', it.file))),
  Object.entries(CATALOG).filter(([, it]) =>
    !fs.existsSync(path.join(__dirname, '..', 'assets', 'character', it.file)))
    .map(([k]) => k).join(','));

check('衣柜条目的 slot 都是合法槽位',
  Object.values(CATALOG).every(it => SLOT_IDS.includes(it.slot)));

check('预设引用的 itemId 都在衣柜里',
  Object.values(PRESETS).every(p =>
    Object.entries(p.equip).every(([s, v]) =>
      v === null || (CATALOG[v] && CATALOG[v].slot === s))));

/* ---------- 默认状态 ---------- */
let dir = tmp();
let w = new Wardrobe(dir);
check('初始为默认套装', w.preset === 'default');
check('equip getter 返回对象而非函数（曾被子类方法同名覆盖）',
  typeof w.equip === 'object' && w.equip !== null);
check('默认套装 7 层可见（不含已删除项圈）', w.layers().length === 7, 'layers=' + w.layers().length);
check('layers 按 z 升序（叠放顺序稳定）',
  w.layers().every((l, i, a) => i === 0 || a[i - 1].z <= l.z));
check('袜子在鞋子之下、外套在衣物之上',
  w.layers().findIndex(l => l.slot === 'socks') < w.layers().findIndex(l => l.slot === 'shoes')
  && w.layers().findIndex(l => l.slot === 'outerwear') > w.layers().findIndex(l => l.slot === 'top'));

/* ---------- 互斥：dress vs top/bottom ---------- */
check('validate 拒绝 dress+top',
  validate({ ...w.equip, dress: 'gothic_black_01', top: 'gray_tee_01' }) !== null);
check('validate 接受 dress 单独穿',
  validate({ ...w.equip, dress: 'gothic_black_01', top: null, bottom: null }) === null);

const r1 = w.setEquip('dress', 'gothic_black_01');
check('已有 top 时直接穿连衣裙被拒', r1.ok === false && !!r1.error, r1.error);
check('被拒后状态一字未动', w.equip.top === 'lace_corset_01' && w.equip.dress === null);

w.setEquip('top', null);
w.setEquip('bottom', null);
const r2 = w.setEquip('dress', 'gothic_black_01');
check('清空上下装后能穿连衣裙', r2.ok === true, r2.error);
check('穿着连衣裙时再穿上装被拒', w.setEquip('top', 'gray_tee_01').ok === false);
check('正确解法：先脱连衣裙再穿上装',
  w.setEquip('dress', null).ok === true && w.setEquip('top', 'gray_tee_01').ok === true);

/* ---------- 身份锁定 ---------- */
check('发型不能脱空（身份件）', w.setEquip('hair', null).ok === false);
check('蝴蝶结可以作为外饰摘下', w.setEquip('hairAccessory', null).ok === true);
check('摘下发饰不影响核心发型', w.equip.hair === 'silver_wavy_01' && w.equip.hairAccessory === null);
check('off_hairAccessory 提案与面板脱下走同一执行路径', (() => {
  w.setEquip('hairAccessory', 'black_bow_01');
  const r = w.applyProposal('off_hairAccessory');
  return r.ok === true && w.equip.hairAccessory === null;
})());
check('off_hair 提案不能摘下核心发型', w.applyProposal('off_hair').ok === false);
check('普通衣服可以脱空', w.setEquip('outerwear', null).ok === true && w.equip.outerwear === null);

/* ---------- 非法输入 ---------- */
check('未知 itemId 被拒', w.setEquip('top', 'nope_99').ok === false);
check('跨槽位被拒（鞋穿不到上装）', w.setEquip('shoes', 'gray_tee_01').ok === false);
check('未知槽位被拒', w.setEquip('nonsense', 'gray_tee_01').ok === false);
check('重复装备返回 changed=false 且不写盘',
  w.setEquip('shoes', 'black_boots_01').changed === false);

/* ---------- 预设切换：曾卡死的回归 ---------- */
dir = tmp();
w = new Wardrobe(dir);
check('默认 -> 休闲', w.applyPreset('casual').ok === true);
const g = w.applyPreset('gothic');
check('休闲 -> 哥特不卡死（校验最终态而非中间态）', g.ok === true, g.error);
check('哥特态数据真实', w.equip.dress === 'gothic_black_01' && w.equip.top === null && w.equip.bottom === null);
check('未知预设被拒', w.applyPreset('nope').ok === false);
check('哥特 -> 默认 可回', w.applyPreset('default').ok === true && w.equip.top === 'lace_corset_01');
check('重复应用同一预设 changed=false（不白刷屏幕、不多写盘）',
  w.applyPreset('default').changed === false);
check('changed=false 时不写盘（哨兵法，不依赖 mtime 精度）', (() => {
  const p = path.join(dir, 'wardrobe.json');
  const real = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, 'SENTINEL', 'utf8');
  w.applyPreset('default');                 // 无变化 → 不该覆盖文件
  const after = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, real, 'utf8');        // 还原，别影响后面的往返测试
  return after === 'SENTINEL';
})());
check('自由组合后重打同一预设 changed=true（状态确有变化）', (() => {
  w.setEquip('shoes', 'white_sneakers_01');
  return w.applyPreset('default').changed === true;
})());

/* ---------- AI 提案：语言状态 ≠ 程序状态 ---------- */
dir = tmp();
w = new Wardrobe(dir);
check('提案预设生效', w.applyProposal('casual').ok === true && w.preset === 'casual');
// 选一件休闲套里确实没穿的单品（accessory 沿用默认，提案它不会改动状态）
check('提案单品生效并清掉预设标记',
  w.applyProposal('lace_corset_01').ok === true && w.preset === null
  && w.equip.top === 'lace_corset_01');
check('提案一件已经穿着的单品：无改动则预设标记也不动',
  w.applyProposal('lace_corset_01').changed === false && w.preset === null);
check('提案幻觉 id 如实失败', w.applyProposal('maid_dress_01').ok === false);
check('提案 null/对象/数字都不崩',
  w.applyProposal(null).ok === false && w.applyProposal({}).ok === false
  && w.applyProposal(123).ok === false);
check('提案带空格也能识别', w.applyProposal('  gothic  ').ok === true);
check('失败提案不改动任何状态', (() => {
  const snap = JSON.stringify(w.equip);
  w.applyProposal('ghost_item');
  return JSON.stringify(w.equip) === snap;
})());

/* ---------- 持久化往返 ---------- */
dir = tmp();
w = new Wardrobe(dir);
w.applyPreset('gothic');
const snap = JSON.stringify(w.equip);
const w2 = new Wardrobe(dir);
check('重启后 equip 逐字段一致', JSON.stringify(w2.equip) === snap);
check('重启后 preset 标记保留', w2.preset === 'gothic');

/* ---------- 脏文件降级 ---------- */
function reloadWith(json) {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'wardrobe.json'), json);
  return new Wardrobe(d);
}
check('坏 JSON 不崩，回退默认',
  reloadWith('{{{坏文件').preset === 'default');
check('空对象不崩，回退默认', reloadWith('{}').preset === 'default');
check('非法组合（dress+top）回退默认',
  reloadWith(JSON.stringify({ equip: { hair: 'silver_wavy_01', hairAccessory: 'black_bow_01', top: 'gray_tee_01', dress: 'gothic_black_01' } })).preset === 'default');
check('未知 id 被丢弃后用默认补齐',
  (() => {
    const x = reloadWith(JSON.stringify({ equip: { hair: 'not_exist', top: 'gray_tee_01' } }));
    return x.equip.hair === 'silver_wavy_01';
  })());
check('旧项圈存档迁移为 null 且不影响其他衣物', (() => {
  const x = reloadWith(JSON.stringify({ preset: 'default', equip: {
    hair: 'silver_wavy_01', hairAccessory: 'black_bow_01', top: 'gray_tee_01',
    bottom: 'sport_shorts_01', dress: null, socks: 'white_thighhigh_01',
    shoes: 'white_sneakers_01', outerwear: null, accessory: 'choker_key_01'
  }}));
  return x.equip.accessory === null && x.equip.top === 'gray_tee_01'
    && x.equip.shoes === 'white_sneakers_01';
})());
check('合法的自由组合能原样读回',
  (() => {
    const x = reloadWith(JSON.stringify({
      preset: null,
      equip: { hair: 'silver_wavy_01', hairAccessory: 'black_bow_01', top: 'gray_tee_01',
               bottom: 'sport_shorts_01', dress: null, socks: 'white_thighhigh_01',
               shoes: 'white_sneakers_01', outerwear: null, accessory: null }
    }));
    return x.equip.top === 'gray_tee_01' && x.preset === null;
  })());

/* ---------- 面板数据 ---------- */
dir = tmp();
w = new Wardrobe(dir);
const cat = w.catalog();
check('catalog 返回 9 槽位与 9 组条目',
  cat.slots.length === 9 && Object.keys(cat.items).length === 9);
check('catalog 带当前 equip 与预设名表',
  !!cat.equip && Object.keys(cat.presets).length === 3);
check('每个条目有 id/name/tags（UI 渲染依赖）',
  Object.values(cat.items).flat().every(i => i.id && i.name && Array.isArray(i.tags)));

/* ---------- 人格隔离：换装不许碰 persona ---------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'wardrobe.js'), 'utf8');
check('wardrobe.js 不引用 persona（服装与人格物理隔离）',
  !/require\(.*persona/.test(src));
// 只看逻辑代码：剥离注释后检索，避免「解释为什么不碰」的说明文字误伤
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('wardrobe.js 逻辑代码里不含任何人格相关词',
  !/病娇|女仆|语气|人格|口癖|称呼|persona/i.test(code));

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
