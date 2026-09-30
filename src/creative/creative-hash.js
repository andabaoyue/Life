/**
 * src/creative/creative-hash.js — Creative History Canonical Form（v0.9.9 Phase 2）
 *
 * sourceHistoryHash 必须代表「这一组 Creative History 内容」，而不是物理文件行数。
 *
 * Canonical 规则（刻意不用 trim）：
 *   - 保留消息顺序、role、content 原文（含前后空格 —— 空格是真实创作文本语义的一部分）
 *   - 仅统一换行符：\r\n -> \n，\r -> \n（Windows/Linux 同文同 hash）
 *   - 不包含 timestamp / wall-clock / file path / 任何 machine-specific 信息
 *   - canonical 对象 key 顺序固定（role, content），不依赖输入对象的 key 顺序
 */

const crypto = require('crypto');

function canonicalizeCreativeHistory(messages) {
  return JSON.stringify(
    (Array.isArray(messages) ? messages : []).map((m) => ({
      role: String(m.role),
      content: String(m.content)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
    }))
  );
}

function sourceHistoryHash(messages) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalizeCreativeHistory(messages), 'utf8').digest('hex');
}

module.exports = { canonicalizeCreativeHistory, sourceHistoryHash };
