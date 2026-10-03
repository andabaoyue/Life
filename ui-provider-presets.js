/**
 * 服务商预设与 Key 前缀本地识别（v1.0 笔 7 / UX-01）。
 *
 * 铁律：
 * 1. 识别只在本地内存进行 —— 绝不上传、绝不落盘、绝不打印/回显 Key 本身；
 * 2. 只建议不强制 —— 绝不覆写用户已手填的自定义端点（高级玩家自由度）；
 * 3. 边界铁律 —— 不 require('electron')、不进 src/、0 IPC 新增；
 *    与 src/provider-policy.js 的口径一致性由 test/ui-provider-presets.test.js 防漂移断言钉死。
 */
const PRESETS = {
  'deepseek': {
    id: 'deepseek', nameKey: 'preset.deepseek', providerId: 'deepseek', protocol: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat'
  },
  'mimo': {
    id: 'mimo', nameKey: 'preset.mimo', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2-flash'
  },
  'mimo-token-plan': {
    id: 'mimo-token-plan', nameKey: 'preset.mimoTokenPlan', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2-flash'
  },
  'gpt': {
    id: 'gpt', nameKey: 'preset.gpt', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini'
  },
  // 预设补全（v1.0 用户拍板：全一点）——端点按各家官方 OpenAI 兼容文档；
  // 模型 ID 演进快、不确定者留空（用户在「高级」手填），绝不瞎编。
  'claude': {
    id: 'claude', nameKey: 'preset.claude', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.anthropic.com/v1', model: ''
  },
  'gemini': {
    id: 'gemini', nameKey: 'preset.gemini', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.0-flash'
  },
  'glm': {
    id: 'glm', nameKey: 'preset.glm', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash'
  },
  'kimi': {
    id: 'kimi', nameKey: 'preset.kimi', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k'
  },
  'qwen': {
    id: 'qwen', nameKey: 'preset.qwen', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo'
  },
  'doubao': {
    id: 'doubao', nameKey: 'preset.doubao', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: ''
  },
  'siliconflow': {
    id: 'siliconflow', nameKey: 'preset.siliconflow', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1', model: ''
  },
  'groq': {
    id: 'groq', nameKey: 'preset.groq', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile'
  },
  'mistral': {
    id: 'mistral', nameKey: 'preset.mistral', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://api.mistral.ai/v1', model: 'mistral-small-latest'
  },
  'openrouter': {
    id: 'openrouter', nameKey: 'preset.openrouter', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1', model: ''
  },
  'ernie': {
    id: 'ernie', nameKey: 'preset.ernie', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://qianfan.baidubce.com/v2', model: ''
  },
  'spark': {
    id: 'spark', nameKey: 'preset.spark', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: 'https://spark-api-open.xf-yun.com/v1', model: ''
  },
  'local': {
    id: 'local', nameKey: 'preset.local', providerId: 'local', protocol: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1', model: 'qwen2.5'
  },
  'custom': {
    id: 'custom', nameKey: 'preset.custom', providerId: 'custom', protocol: 'openai-compatible',
    baseURL: '', model: ''
  }
};

function getPreset(id) {
  return Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id] : null;
}

/**
 * Key 前缀本地识别（纯函数）：只返回「像哪个服务商」的建议，绝不返回/保留 Key 本身。
 * 只建议不强制：套不套用由用户点一下决定。
 */
function detectProviderByKey(rawKey) {
  const k = String(rawKey || '').trim();
  if (!k) return null;
  if (/^t?tp-[a-zA-Z0-9_-]+/.test(k)) {
    return { presetId: 'mimo-token-plan', confidence: 'high', reasonKey: 'detect.reason.tp' };
  }
  if (/^mimo-[a-zA-Z0-9_-]+/.test(k)) {
    return { presetId: 'mimo', confidence: 'high', reasonKey: 'detect.reason.mimo' };
  }
  if (/^sk-[a-zA-Z0-9_-]+/.test(k)) {
    return { presetId: 'deepseek', confidence: 'medium', reasonKey: 'detect.reason.sk' };
  }
  return null;
}

// 双环境守卫：Node 测试可 require；浏览器侧全局照常生效（同 ui-i18n / ui-chat-store 先例）
if (typeof module === 'object' && module.exports) {
  module.exports = { PRESETS, getPreset, detectProviderByKey };
}
