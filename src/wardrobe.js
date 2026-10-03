const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { migrate } = require('./migration');

const SCHEMA_VERSION = 1;

/**
 * 换装系统 —— 数据层
 *
 * 三条铁律（写死在这里，UI 和 AI 都别想绕过去）：
 *
 * 1. 服装只是外观，不碰人格。
 *    本模块不 import persona，也不提供任何「按服装改语气」的钩子。
 *    换一套衣服只换像素，不换性格 —— 那是人格漂移，不是换装。
 *
 * 2. 语言状态 ≠ 程序状态。
 *    AI 只能提交一个 itemId 提案，真正穿上衣服的是这次函数调用。
 *    提案无效就返回 ok:false，上层据此如实告知「没换成」，
 *    绝不允许回复「我换好了」而状态没动。
 *
 * 3. 角色本体不可换装，外饰可以更换。
 *    脸型、身体比例、银白发、发梢淡冰蓝、蓝灰眼、泪痣属于 base/identity 层；
 *    发饰是可拆卸外饰，不应被误当成不可改变的身体。
 *    （v1.0 演进，用户拍板）发 = 可换外饰，但必须有发（不许光头）；默认永远是
 *    银白微卷——她的样子不漂移，但可以为特别的日子换个颜色。发色变体先行，
 *    新剪裁仍走 §6.7 资产管线。
 *
 * 加新衣服 = 往 CATALOG 加一条数据（必要时加个预设），
 * 不需要动任何渲染或交互逻辑。
 */

/* ---------- 槽位与叠放顺序 ----------
   z 越大越靠上层，渲染层照 layers() 的顺序贴 <img>，
   所以叠放顺序只在这一处定义，不散落进 CSS。
   参考设定图的遮挡关系：袜子被短裤压住上缘、鞋套在袜口外、
   外套盖过所有衣物、蝴蝶结在最上。

   required:true 表示「这个槽位必须有东西穿着」——角色身份约束。
   它过去是从 CATALOG 反推的（该槽位所有条目都 locked 就算身份），
   那个方向有两个坑，都实测过：
     - 给发型槽加第二款发型却忘了标 locked → 反推结果变成「非身份」，
       发型能被脱成 null，桌宠直接变光头；
     - 给某个普通槽位唯一一条商品标上 locked → 反推成「身份」，
       明明是可脱的饰品却报「不能脱空」。
   身份是槽位的属性，不是商品的属性，所以写在这儿。
   商品上不再有任何 locked 字段 —— 反推那条路一旦走通，
   以后就得同时维护两处，迟早对不上。 */
const SLOTS = [
  { id: 'hair',          z: 10, name: '发型',   required: true },
  { id: 'socks',         z: 20, name: '袜子' },
  { id: 'dress',         z: 30, name: '连衣裙' },
  { id: 'top',           z: 31, name: '上装' },
  { id: 'bottom',        z: 32, name: '下装' },
  { id: 'outerwear',     z: 40, name: '外套' },
  { id: 'shoes',         z: 45, name: '鞋子' },
  { id: 'hairAccessory', z: 50, name: '发饰' },
  { id: 'accessory',     z: 60, name: '饰品' }
];

const SLOT_IDS = SLOTS.map(s => s.id);

/* ---------- 衣柜 ----------
   slot 槽位 / file 相对 assets/character/ 的路径 / tags 供检索。
   tags 只是给人和 AI 挑衣服用的描述，不参与任何逻辑判断 ——
   刻意不让「哥特」这种词影响人格。

   身份约束在 SLOTS.required 上，不在商品上：发型槽永远不许空，
   但里面可以换款式（以后出第二款发型就直接加进来，不用标任何东西）。
   刻意不再给商品加 locked —— 同一个事实有两个出处，早晚对不上。 */
const CATALOG = {
  /* 发型：身份层，第一阶段只有一款，槽位留着以后出多发型
     （v1.0 拍板：发色变体先行 —— 同剪裁不同色，scripts/gen-hair-tints.py 派生；
       新剪裁仍走 §6.7 资产管线） */
  silver_wavy_01: { slot: 'hair', name: '银白微卷长发', file: 'hair/silver_wavy_01.png',
                    tags: ['默认', '银白', '发梢淡冰蓝'] },
  ink_long_01: { slot: 'hair', name: '墨黑微卷长发', file: 'hair/ink_long_01.png',
                 tags: ['发色', '墨黑', '变体'] },
  gold_long_01: { slot: 'hair', name: '鎏金微卷长发', file: 'hair/gold_long_01.png',
                  tags: ['发色', '鎏金', '变体'] },
  pink_long_01: { slot: 'hair', name: '樱粉微卷长发', file: 'hair/pink_long_01.png',
                  tags: ['发色', '樱粉', '变体'] },
  blue_long_01: { slot: 'hair', name: '黛蓝微卷长发', file: 'hair/blue_long_01.png',
                  tags: ['发色', '黛蓝', '变体'] },

  black_bow_01: { slot: 'hairAccessory', name: '右侧黑色蝴蝶结', file: 'hair-accessories/black_bow_01.png',
                  tags: ['默认', '黑蝴蝶结', '右侧', '可拆卸发饰'] },

  lace_corset_01: { slot: 'top', name: '黑色蕾丝吊带', file: 'tops/lace_corset_01.png',
                    tags: ['默认', '黑色', '蕾丝'] },
  gray_tee_01: { slot: 'top', name: '灰色宽松T恤', file: 'tops/gray_tee_01.png',
                 tags: ['休闲', '日常', '浅色'] },

  black_shorts_01: { slot: 'bottom', name: '黑色短裤', file: 'bottoms/black_shorts_01.png',
                     tags: ['默认', '黑色'] },
  sport_shorts_01: { slot: 'bottom', name: '深灰运动短裤', file: 'bottoms/sport_shorts_01.png',
                     tags: ['休闲', '日常'] },

  gothic_black_01: { slot: 'dress', name: '哥特黑连衣裙', file: 'dresses/gothic_black_01.png',
                     tags: ['哥特', '黑色', '连衣裙'] },

  white_thighhigh_01: { slot: 'socks', name: '白色过膝袜', file: 'socks/white_thighhigh_01.png',
                        tags: ['默认', '白色'] },

  black_boots_01: { slot: 'shoes', name: '黑色厚底靴', file: 'shoes/black_boots_01.png',
                    tags: ['默认', '黑色', '靴子'] },
  white_sneakers_01: { slot: 'shoes', name: '白色运动鞋', file: 'shoes/white_sneakers_01.png',
                       tags: ['休闲', '白色'] },

  white_tech_jacket_01: { slot: 'outerwear', name: '落肩白色外套', file: 'outerwear/white_tech_jacket_01.png',
                          tags: ['默认', '白色', '外套'] },

};

/* ---------- 预设套装 ----------
   预设只是「一组槽位值的命名」，不是新机制。
   没列出的槽位沿用当前装备，所以 casual 不动头发和袜子。 */
const PRESETS = {
  default: {
    name: '默认白毛套装',
    equip: {
      hair: 'silver_wavy_01', hairAccessory: 'black_bow_01',
      top: 'lace_corset_01', bottom: 'black_shorts_01', dress: null,
      socks: 'white_thighhigh_01', shoes: 'black_boots_01',
      outerwear: 'white_tech_jacket_01', accessory: null
    }
  },
  casual: {
    name: '日常休闲',
    equip: {
      top: 'gray_tee_01', bottom: 'sport_shorts_01', dress: null,
      shoes: 'white_sneakers_01', outerwear: null
    }
  },
  gothic: {
    name: '哥特风',
    equip: {
      dress: 'gothic_black_01', top: null, bottom: null,
      shoes: 'black_boots_01', outerwear: null
    }
  }
};

/* ---------- 主体特质偏好亲和度与自主选择 (v0.9.9) ----------
   初澜作为数字生命主体，根据内在特质喜好值驱动衣着倾向与风格选择。
   这属于主体动力学向外观自决的投射，衣服本身不篡改基础性格（严格遵循铁律 1）。 */
const STYLE_AFFINITIES = {
  casual: {
    name: '日常休闲',
    affinities: { vitality: 0.8, quiet_preference: -0.3, social_initiative: 0.3 },
    mood: '偏好活力与轻松自如，讨厌拘束'
  },
  gothic: {
    name: '哥特风',
    affinities: { quiet_preference: 0.8, philosophical_curiosity: 0.7, vitality: -0.3 },
    mood: '偏好深邃、静谧与哲思沉思，喜欢独处的安宁'
  },
  default: {
    name: '默认白毛套装',
    affinities: { attachment_need: 0.7, quiet_preference: 0.2 },
    mood: '偏好被宽大外套包裹的温暖与依恋，温柔而有安全感'
  }
};

/**
 * 计算指定预设在给定特质下的偏好得分
 */
function evaluatePresetPreference(presetId, traits = {}) {
  const meta = STYLE_AFFINITIES[presetId];
  if (!meta) return 0;
  let score = 0;
  for (const [trait, weight] of Object.entries(meta.affinities)) {
    const val = Number(traits[trait]) || 0;
    score += val * weight;
  }
  return score;
}

/**
 * 根据主体特质数值获取初澜当前最偏好的预设方案
 */
function getSubjectPreferredPreset(traits = {}) {
  let bestPreset = 'default';
  let bestScore = 0;
  for (const pid of Object.keys(STYLE_AFFINITIES)) {
    const sc = evaluatePresetPreference(pid, traits);
    if (sc > bestScore) {
      bestScore = sc;
      bestPreset = pid;
    }
  }
  const meta = STYLE_AFFINITIES[bestPreset] || STYLE_AFFINITIES.default;
  return {
    preset: bestPreset,
    name: meta.name,
    score: bestScore,
    mood: meta.mood
  };
}

/**
 * 校验一套搭配是否合法。
 *
 * 关键一：只校验「最终状态」，不校验「每一步」。
 * 早期版本是每改一个槽位就查一次冲突，结果从休闲套切哥特风必然失败 ——
 * 因为 dress 落下去的那一刻，残留的 top 还在。预设切换是整体替换，
 * 中途状态没有意义，只有结果值得判断。
 *
 * 关键二：只有核心身份件不许为空。换装和摘下外饰不能改变角色本体。
 */
function validate(equip) {
  if (equip.dress && (equip.top || equip.bottom))
    return '连衣裙不能和上装/下装同时穿';
  // 身份槽位必须有着装（当前只有 hair；发饰是可拆卸外饰）
  for (const s of SLOTS) {
    if (s.required && !equip[s.id])
      return s.name + '属于角色身份，不能脱空';
  }
  return null;
}

function defaultEquip() {
  const e = {};
  for (const s of SLOT_IDS) e[s] = null;
  return { ...e, ...PRESETS.default.equip };
}

class Wardrobe {
  constructor(dir) {
    this.path = path.join(dir, 'wardrobe.json');
    this.data = { schemaVersion: SCHEMA_VERSION, equip: defaultEquip(), preset: 'default' };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (!raw || !raw.equip) return;
      const { data } = migrate(raw, SCHEMA_VERSION, {
        1: (d) => {
          if (d && d.equip && d.equip.accessory === 'choker_key_01') {
            d.equip.accessory = null;
          }
          return d;
        }
      });
      const e = defaultEquip();
      for (const k of SLOT_IDS) {
        if (!(k in data.equip)) continue;        // 文件没写这个槽位 → 默认补齐
        const v = data.equip[k];
        if (v === null) { e[k] = null; continue; } // 显式脱下要保留，否则哥特档读回会变成默认
        // v0.8.4 删除的旧身份外饰只迁移为 null，不影响其他槽位。
        if (v === 'choker_key_01') { e[k] = null; continue; }
        // 未知 id / 穿错槽位一律丢弃后用默认补齐：手改坏文件也不能把渲染层带崩
        const it = CATALOG[v];
        if (it && it.slot === k) e[k] = v;
      }
      // 文件里的组合本身不合法（比如手写了 dress+top）就退回默认
      if (validate(e)) return;
      this.data = { schemaVersion: SCHEMA_VERSION, equip: e, preset: data.preset || null };
    } catch { /* 首次运行用默认套装 */ }
  }

  save() {
    try {
      writeJsonAtomic(this.path, this.data);
      return true;
    } catch (e) {
      // 写盘失败不能让换装崩：内存状态仍有效，桌宠照常显示，下次再存
      console.error('wardrobe save failed:', e.message);
      return false;
    }
  }

  get equip() { return this.data.equip; }
  get preset() { return this.data.preset; }

  static checkItem(slot, itemId) {
    if (itemId === null || itemId === undefined) return { ok: true, value: null };
    const it = CATALOG[itemId];
    if (!it) return { ok: false, error: '衣柜里没有这件：' + itemId };
    if (it.slot !== slot)
      return { ok: false, error: itemId + ' 是 ' + it.slot + '，不能穿到 ' + slot + ' 槽位' };
    return { ok: true, value: itemId };
  }

  /**
   * 装备/脱下（itemId 传 null 即脱下）。失败时状态一字未动。
   *
   * 方法名刻意叫 setEquip 而不是 equip：类里已有 get equip() 读状态，
   * 同名会让方法静默覆盖 getter，wardrobe.equip 变成函数、
   * 读出来全是 undefined —— 而且 `undefined === undefined` 还能把测试骗过去。
   */
  setEquip(slot, itemId) {
    if (!SLOT_IDS.includes(slot)) return { ok: false, error: '没有这个槽位：' + slot };
    const chk = Wardrobe.checkItem(slot, itemId);
    if (!chk.ok) return { ok: false, error: chk.error };
    if (this.data.equip[slot] === chk.value) return { ok: true, changed: false };

    const next = { ...this.data.equip, [slot]: chk.value };
    const bad = validate(next);
    if (bad) return { ok: false, error: bad };

    this.data.equip = next;
    this.data.preset = null;          // 自由组合后不再是任何预设
    this.save();
    return { ok: true, changed: true, equip: next };
  }

  /** 应用预设：整体替换后再校验一次，两条路径共用同一套规则 */
  applyPreset(id) {
    const p = PRESETS[id];
    if (!p) return { ok: false, error: '没有这个套装：' + id };
    const next = { ...this.data.equip };
    for (const [slot, val] of Object.entries(p.equip)) {
      const chk = Wardrobe.checkItem(slot, val);
      if (!chk.ok) return { ok: false, error: chk.error };
      next[slot] = chk.value;
    }
    const bad = validate(next);
    if (bad) return { ok: false, error: '套装数据有问题：' + bad };

    const before = JSON.stringify(this.data);
    this.data.equip = next;
    this.data.preset = id;
    // 重复点同一个预设时可能一个像素都没变（但 preset 标记从 null 变回来算变化）
    const changed = JSON.stringify(this.data) !== before;
    if (changed) this.save();
    return { ok: true, changed, equip: next, preset: id };
  }

  /**
   * AI 提案入口 —— 铁律 2 的落点。
   * 模型只能给一个 id，认不出来就如实返回失败，
   * 上层据此说「这件我没有」，而不是顺着话假装换好了。
   */
  applyProposal(id) {
    const key = String(id || '').trim();
    if (PRESETS[key]) return this.applyPreset(key);
    if (key.toLowerCase().startsWith('off_')) {
      const slot = SLOTS.find(s => s.id.toLowerCase() === key.slice(4).toLowerCase());
      if (!slot || slot.required) return { ok: false, error: '这个部位属于核心身份，不能脱下' };
      return this.setEquip(slot.id, null);
    }
    const it = CATALOG[key];
    if (!it) return { ok: false, error: '衣柜里没有 ' + key };
    return this.setEquip(it.slot, key);
  }

  /** 渲染层用：按 z 排序的可见图层（跳过空槽） */
  layers() {
    return SLOTS
      .filter(s => this.data.equip[s.id])
      .map(s => ({
        slot: s.id,
        z: s.z,
        itemId: this.data.equip[s.id],
        src: 'assets/character/' + CATALOG[this.data.equip[s.id]].file
      }))
      .sort((a, b) => a.z - b.z);
  }

  /** 面板用：衣柜清单 + 槽位 + 预设 */
  catalog() {
    const items = {};
    for (const s of SLOT_IDS) items[s] = [];
    for (const [id, it] of Object.entries(CATALOG))
      items[it.slot].push({ id, name: it.name, tags: it.tags || [], file: it.file });   // v1.0：带 file 供缩略图
    const presets = {};
    for (const [id, p] of Object.entries(PRESETS)) presets[id] = p.name;
    return { slots: SLOTS, items, presets, equip: this.data.equip, preset: this.data.preset };
  }

  reset() {
    this.data = { schemaVersion: SCHEMA_VERSION, equip: defaultEquip(), preset: 'default' };
    this.save();
  }

  /**
   * 给模型的「我现在穿着什么」—— 程序真实状态，不是模型的想象。
   * 顺序按槽位表固定，同一套搭配永远生成同一串字节，
   * 所以它挂在 system 末尾也不会每轮抖动、把缓存打没。
   */
  outfitText() {
    const lines = [];
    for (const s of SLOTS) {
      const id = this.data.equip[s.id];
      lines.push('- ' + s.name + '：' + (id ? CATALOG[id].name : '（没穿）'));
    }
    return lines.join('\n');
  }

  /** 衣柜清单：让模型只能从真实存在的 id 里挑，减少幻觉 */
  static catalogText() {
    const lines = [];
    for (const [id, it] of Object.entries(CATALOG)) {
      lines.push('- ' + id + '：' + it.name + '（' + it.slot + '）');
    }
    for (const [id, p] of Object.entries(PRESETS)) {
      lines.push('- ' + id + '：整套「' + p.name + '」（预设）');
    }
    return lines.join('\n');
  }

  getSubjectPreference(traits) {
    return getSubjectPreferredPreset(traits);
  }

  /** system 末尾那一整块；换衣服或关窗特质演进才会变一次 */
  promptBlock(traits = null) {
    let block = '【当前穿着】（这是程序里的真实状态，回答穿着相关的问题以它为准）\n'
      + this.outfitText()
      + '\n\n【衣柜里可用的 itemId】（[wear:] 只能引用下面这些，别的都不存在）\n'
      + Wardrobe.catalogText();

    if (traits && typeof traits === 'object') {
      const pref = getSubjectPreferredPreset(traits);
      block += '\n\n【主体着装偏好与当下心境】\n'
        + '- 当下特质驱动的着装倾向：' + pref.name + '（' + pref.mood + '）\n'
        + '- 你拥有根据自身喜好与心境挑选衣物的自主权；在交流或有需要时，你可以主动提议换上符合你心境的衣服（在回复末尾附带 [wear:' + pref.preset + '] 或具体 itemId）。';
    }
    return block;
  }
}

module.exports = { Wardrobe, CATALOG, PRESETS, SLOTS, SLOT_IDS, STYLE_AFFINITIES, evaluatePresetPreference, getSubjectPreferredPreset, validate, defaultEquip };
