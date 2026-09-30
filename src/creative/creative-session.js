/**
 * src/creative/creative-session.js — Creative Core（v0.9.9 Phase 2）
 *
 * 认识论隔离（硬性）：
 *   Creative System Prompt ≠ Life PERSONA；
 *   本模块不依赖任何既定角色人格模块，Provider Adapter 也无任何到人格构建器的回退路径。
 *   验证方式不是字符串窥探（正文可合法出现任何词），而是 system message 的来源与内容：
 *   发出的 messages[0] 恒等于本模块导出的 CREATIVE_SYSTEM_PROMPT。
 *
 * 请求链路（复用现有 Provider 架构，不复制 transport/retry/timeout/policy）：
 *   Creative Core -> Provider Registry -> 现有 Adapter -> 现有 Security / Policy / Transport
 *
 * 生成事务（防半行与 crash）：
 *   beginPending(streaming) -> streaming -> terminal record(append+fsync) -> 清 pending。
 */

const { createAdapter } = require('../provider-registry');
const { sourceHistoryHash } = require('./creative-hash');

/** Creative 专用 System Prompt：中立创作助手 / 作者工作流规则，绝不夹带任何角色人格 */
const CREATIVE_SYSTEM_PROMPT = [
  '你是一名专业的虚构创作助手，服务于创作者的工作流。',
  '工作规则：先确认创作意图与约束，再给出结构化草稿、备选方案与修订建议。',
  '你不拥有也不扮演任何既定角色人格；一切输出围绕创作者给出的任务本身。',
  '仅输出与当前创作任务直接相关的内容。'
].join('\n');

function newRecordId() {
  return 'cr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function createCreativeSession({ store, cfg } = {}) {
  if (!store || typeof store.readHistory !== 'function' || typeof store.completePending !== 'function') {
    throw new Error('CREATIVE_STORE_REQUIRED');
  }
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('CREATIVE_PROVIDER_CFG_REQUIRED');
  }

  /**
   * 发起一轮创作生成。返回已提交的 assistant 历史记录（completed / aborted / error）。
   * Abort / 网络错误都不丢 partial：以真实收到的内容入史，finishReason 如实标注。
   */
  async function send({ projectId = 'default', content, onDelta, signal } = {}) {
    const history = store.readHistory(projectId);
    const historyHash = sourceHistoryHash(history.map((r) => ({ role: r.role, content: r.content })));
    const userText = String(content == null ? '' : content);

    // system 恒为 Creative 专用 prompt；其余消息逐字来自 History（含真实空格/换行）
    const messages = [
      { role: 'system', content: CREATIVE_SYSTEM_PROMPT },
      ...history.map((r) => ({ role: String(r.role), content: String(r.content) })),
      { role: 'user', content: userText }
    ];

    store.appendHistory(projectId, {
      recordId: newRecordId(),
      projectId,
      role: 'user',
      status: 'completed',
      content: userText,
      finishReason: 'stop',
      createdAt: Date.now()
    });

    const recordId = newRecordId();
    store.beginPending(projectId, {
      recordId, projectId, status: 'streaming', role: 'assistant', content: '', createdAt: Date.now()
    });

    // 复用现有 Provider Registry / Adapter（HTTP、retry、timeout、abort、policy、usage 归一全部沿用）
    const adapter = createAdapter(cfg.provider || 'deepseek', cfg);
    let partial = '';
    try {
      let text;
      if (typeof onDelta === 'function') {
        const r = await adapter.stream(messages, (d) => { partial += d; onDelta(d); }, { signal });
        text = r && typeof r.text === 'string' ? r.text : partial;
      } else {
        const r = await adapter.complete(messages, { signal });
        text = r && typeof r.text === 'string' ? r.text : '';
        partial = text;
      }
      return store.completePending(projectId, {
        recordId,
        projectId,
        role: 'assistant',
        status: 'completed',
        content: text,
        finishReason: 'stop',
        sourceHistoryHash: historyHash,
        createdAt: Date.now()
      });
    } catch (e) {
      const aborted = !!(e && e.name === 'AbortError') || (!!(signal && signal.aborted) && !(e && e.name === 'TimeoutError'));
      const record = {
        recordId,
        projectId,
        role: 'assistant',
        status: aborted ? 'aborted' : 'error',
        content: partial, // 已真实收到的 partial，绝无虚构
        finishReason: aborted ? 'abort' : 'error',
        sourceHistoryHash: historyHash,
        createdAt: Date.now()
      };
      if (!aborted && e && typeof e.message === 'string') record.errorMessage = e.message;
      store.completePending(projectId, record);
      return record;
    }
  }

  return {
    send,
    systemPrompt: CREATIVE_SYSTEM_PROMPT,
    buildMessages: (history, userText) => [
      { role: 'system', content: CREATIVE_SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history : []).map((r) => ({ role: String(r.role), content: String(r.content) })),
      { role: 'user', content: String(userText == null ? '' : userText) }
    ]
  };
}

module.exports = { createCreativeSession, createCreativeCore: createCreativeSession, CREATIVE_SYSTEM_PROMPT };
