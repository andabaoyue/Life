/**
 * 配件智能自适应成套（v1.0 UX-02a / 第三战役）—— 纯函数决策层。
 *
 * 铁律边界（与 src/wardrobe.js 三条铁律同源，此处机械遵守）：
 * 1. 标签永不进逻辑 —— 风格家族是 UI 侧「条目 ID 策展表」（FAMILIES），
 *    绝不读 catalog 的 tags 字段（测试 8 断言本文件无 .tags）；
 * 2. dress ↔ top/bottom 互斥逐帧成立 —— planOutfit 保证 off_ 摘除全部先行，
 *    每个中间态都过既有校验器；
 * 3. 身份层永不入计划 —— hair（required）与发饰/饰品一律不碰。
 *
 * 只建议不强制（拍板）：本层只产出「目标终态 + 操作计划」，
 * 落不落子由用户点一键成套决定；走既有 wardrobe-set 通道逐槽落子，0 新 IPC、src/ 0 行。
 */

/* 家族策展表：family → { slot: itemId }。只按 ID 策展，与 tags 无关。
   三家族与衣柜 PRESETS 对齐（default / casual / gothic）；
   共享条目（black_boots_01 双家族）在锚定上归首个家族，见 familyOf。 */
const FAMILIES = {
  default: {
    top: 'lace_corset_01', bottom: 'black_shorts_01', socks: 'white_thighhigh_01',
    shoes: 'black_boots_01', outerwear: 'white_tech_jacket_01'
  },
  casual: {
    top: 'gray_tee_01', bottom: 'sport_shorts_01', shoes: 'white_sneakers_01'
  },
  gothic: {
    dress: 'gothic_black_01', shoes: 'black_boots_01'
  }
};

/* 成套关注的基础槽（hair / hairAccessory / accessory 永不在此列） */
const BASIC_SLOTS = ['socks', 'dress', 'top', 'bottom', 'outerwear', 'shoes'];

function familyOf(itemId) {
  if (!itemId || typeof itemId !== 'string') return null;
  for (const fam of Object.keys(FAMILIES)) {
    if (Object.values(FAMILIES[fam]).includes(itemId)) return fam;
  }
  return null;
}

/**
 * 以用户点选单品为锚 → 目标终态（成套补齐）。
 * 只动基础槽：家族定义的补齐；dress ↔ top/bottom 互斥对侧清空；其余原样保留。
 * 锚无效 / catalog 缺失 → null（不猜、不崩）。
 */
function completeOutfit(equip, catalog, anchorItemId) {
  if (!equip || typeof equip !== 'object' || !catalog || typeof catalog !== 'object') return null;
  const fam = familyOf(anchorItemId);
  if (!fam) return null;
  const set = FAMILIES[fam];

  // 策展表里的每个 ID 必须真实存在于 catalog 且槽位吻合（数据不虚构）
  for (const [slot, id] of Object.entries(set)) {
    if (!catalog[id] || catalog[id].slot !== slot) return null;
  }

  const desired = {};
  for (const slot of BASIC_SLOTS) {
    if (Object.prototype.hasOwnProperty.call(set, slot)) {
      desired[slot] = set[slot];                       // 家族定义 → 补齐/换上
    } else if (slot === 'dress' && set.top) {
      desired[slot] = null;                            // 上下装家族 → 清互斥连衣裙
    } else if ((slot === 'top' || slot === 'bottom') && set.dress) {
      desired[slot] = null;                            // 连衣裙家族 → 清互斥上下装
    } else {
      desired[slot] = (slot in equip) ? equip[slot] : null;   // 不定义 → 原样
    }
  }
  return desired;
}

/**
 * 目标终态 → 有序操作计划 [{ slot, itemId }]：
 * off_ 摘除（'off_' + 槽名小写，既有通道惯用 id）全部先行，其后逐槽上装 ——
 * dress ↔ top/bottom 互斥在每个中间态都成立。已成套 → 空数组（无噪声）。
 */
function planOutfit(current, target) {
  if (!current || typeof current !== 'object' || !target || typeof target !== 'object') return [];
  const offs = [];
  const ons = [];
  for (const slot of BASIC_SLOTS) {
    const cur = (slot in current) ? current[slot] : null;
    const want = (slot in target) ? target[slot] : null;
    if (cur && cur !== want) offs.push({ slot, itemId: 'off_' + slot.toLowerCase() });
    if (want && want !== cur) ons.push({ slot, itemId: want });
  }
  return offs.concat(ons);
}

// 双环境守卫：Node 测试可 require；浏览器侧全局照常生效（同 ui-i18n / ui-chat-store 先例）
if (typeof module === 'object' && module.exports) {
  module.exports = { FAMILIES, BASIC_SLOTS, familyOf, completeOutfit, planOutfit };
}
