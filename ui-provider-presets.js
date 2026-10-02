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
