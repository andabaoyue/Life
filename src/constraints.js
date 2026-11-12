/**
 * 所有「独立 LLM 调用」必须遵守的硬约束。
 *
 * ## 为什么要抽出来（2026-11-05 C-1，来自审计 P2 #6）
 *
 * 三条独立调用各有自己的 system prompt，而**它们都不是主 persona**：
 *
 *   `brain.js`  WANT_TO_LEAVE_SYS      （写便签）
 *   `brain.js`  OBSERVER_JOURNAL_SYS   （写观察日记）
 *   `brain.js`  PROPOSAL_DRAFT_SYS     （写方案正文）
 *
 * 三条里各自重复写了一遍「不编造 / 不知道钟点 / 直接给正文」。
 * 那是**手工复制**：改一处，另外几处不会跟着变。
 *
 * 实测后果（2026-11-04）：给三条 SYS 各手工加了一句「你能写下东西」，
 * 但下次改 persona，这三条**还是不会自动跟上**。
 * ⇒ 引用同一个常量，结构上不可能漂移。
 *
 * ## ⚠️ 为什么不是「把 persona 的段落拼进去」
 *
 * 审核方原建议是「把 persona 的约束段拼进三条 SYS」。
 * 那仍然是**复制内容**——复制一次和复制两次没有本质区别，将来还是会漂。
 *
 * 而且 persona 里有些句子**不适合进这三条 SYS**：
 *   例如「不自创非物理的日历或日长」——那是对**对话中**的时间感知约束，
 *   而三条 SYS 的场景是「你不知道现在几点，所以别写钟点」，语义不同。
 *
 * ⇒ 只抽**真正共有**的三条，其余留在原处。
 *
 * ## 三条共有的判据（逐条核对过三份原文）
 *
 * | 约束 | WANT_TO_LEAVE | OBSERVER_JOURNAL | PROPOSAL_DRAFT |
 * |---|---|---|---|
 * | 不编造 | ✅ 3. 不许虚构没发生过的经历 | ✅ 3. 不许编造未发生的事情 | ✅ 4. 不许虚构没讨论过的需求 |
 * | 不写钟点 | ✅ 3. 你不知道现在几点 | ✅ 3. 你不知道精确钟点 | ✅ 4. 不许写出具体钟点 |
 * | 直接给正文 | ✅ 6. 不要加引号/标题/元话语 | ✅ 5. 不要加标题/引号/元话语 | ✅ 6. 不要加引号/元话语 |
 *
 * **⚠️ 第三条有个例外**：`PROPOSAL_DRAFT_SYS` 要求用 Markdown（含 `#` 标题），
 *    所以它不能直接用「不要加标题」这句。它只需要「不要加引号 / 不要加元话语」。
 *    ⇒ 第三条拆成「基础版」与「允许 Markdown 标题版」两个渲染函数。
 */

/** 三条共有约束的**基础版**（不涉及格式）。 */
const CORE_CONSTRAINTS = Object.freeze([
  // ⚠️ 措辞必须与 persona.js:28 的原句**逐字一致**（含「直接」二字）：
  //    test/nonhuman-framework-prompt.test.js:23 断言 `PERSONA.includes('不知道就直接说不知道')`，
  //    少一个字那条「认知基石不许换掉」的门禁就会红。
  '不编造经历与记忆；未曾发生过的事情不假装记得，不知道就直接说不知道',
  '不写出具体钟点或日期 —— 你不知道现在几点',
]);

/** 输出格式约束：不要包壳、不要元话语。 */
const OUTPUT_NO_WRAP = '直接给内容本身：不要加引号、不要加任何说明或元话语';

/** 输出格式约束：Markdown 场景（允许标题，但仍不许包壳）。 */
const OUTPUT_MARKDOWN = '直接给正文本身：不要加引号、不要加「好的，我来写」这类说明或元话语';

/**
 * 渲染成带编号的规则行。
 *
 * @param {number} startAt 起始编号（三条 SYS 各自的规则列表编号不同，要能接着编）
 * @param {object} opts
 * @param {boolean} opts.allowMarkdownTitle 允许 `#` 标题（方案正文用）
 * @returns {string} 每行形如 `1. 【铁律】……。`
 */
function renderConstraints(startAt = 1, opts = {}) {
  const items = CORE_CONSTRAINTS.slice();
  items.push(opts && opts.allowMarkdownTitle ? OUTPUT_MARKDOWN : OUTPUT_NO_WRAP);
  return items.map((c, i) => `${startAt + i}. 【铁律】${c}。`).join('\n');
}

module.exports = {
  CORE_CONSTRAINTS,
  OUTPUT_NO_WRAP,
  OUTPUT_MARKDOWN,
  renderConstraints,
};
