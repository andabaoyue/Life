/**
 * 气泡流数据层（v1.0 笔 2）：memory.history 的只读投影缓存。
 *
 * 铁律：
 * 1. 本层永不写主体数据 —— 她脑子里的历史是唯一事实源，这里只是投影；
 * 2. 显示以重新拉取（load()）对账为准 —— 笔 3 的流式打字动效只是显示临时态，回合结束必须对账覆盖；
 * 3. synthetic 条目（主动搭话的程序触发）绝不冒充用户发言 —— 渲染契约见 SYNTHETIC_RENDER。
 */
const SYNTHETIC_RENDER = 'note';   // 'note' = 居中细灰字「自主感知触发」；'hide' = 静默隐藏（笔 3 可切）

const ChatStore = {
  messages: [],
  _listeners: [],

  onChange(fn) {
    if (typeof fn === 'function') this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(f => f !== fn); };
  },

  _emit() {
    for (const fn of this._listeners) {
      try { fn(this.messages); } catch (e) { /* 订阅者异常不打断数据层 */ }
    }
  },

  /** 拉取权威投影（浏览器默认 api.chatHistory；测试注入 fetchFn） */
  async load(fetchFn) {
    const fetcher = fetchFn
      || (typeof api !== 'undefined' && api && api.chatHistory ? api.chatHistory.bind(api) : null);
    const list = fetcher ? (await fetcher()) : null;
    this.messages = Array.isArray(list) ? list : [];
    this._emit();
    return this.messages;
  }
};

// 双环境守卫：Node 测试可 require；浏览器侧全局照常生效（同 ui-i18n 先例）
if (typeof module === 'object' && module.exports) {
  module.exports = { ChatStore, SYNTHETIC_RENDER };
}
