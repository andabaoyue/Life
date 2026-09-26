/**
 * test/event-source-validation.test.js
 * 
 * 初澜数字生命实验：v0.9.5.1 Event Source 正向白名单强约束专项测试
 * 
 * 核心验证：
 * 1. 严格正向白名单 (user, assistant, activity-tracker, desktop-motion, lifecycle)
 * 2. 未在白名单内的未知或第三方 source 坚决拒绝 (INVALID_EVENT_SOURCE)
 * 3. 既定黑名单来源拦截 (PROHIBITED_EVENT_SOURCE)
 * 4. 大小写容错与严格清理
 */

const {
  createEvent,
  validateEvent,
  ALLOWED_EVENT_SOURCES,
  PROHIBITED_EVENT_SOURCES
} = require('../src/experience-schema');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- Test Suite: Event Source Validation ---');

// 1. 白名单内全部 5 种合法来源测试
const allowedList = ['user', 'assistant', 'activity-tracker', 'desktop-motion', 'lifecycle'];
check('ALLOWED_EVENT_SOURCES 正好包含 5 种合法来源', ALLOWED_EVENT_SOURCES.size === 5);

for (const src of allowedList) {
  const evt = createEvent({ type: 'message', source: src, messageId: 'm-src-01' });
  const v = validateEvent(evt);
  check(`白名单来源 [${src}] 校验通过`, v.valid === true);
}

// 2. 大小写容错性
const evtUpper = createEvent({ type: 'message', source: 'USER', messageId: 'm-src-02' });
check('大写 USER 经规范化后校验通过', validateEvent(evtUpper).valid === true);

const evtMixed = createEvent({ type: 'desktop_motion', source: 'Desktop-Motion', messageId: 'm-src-03' });
check('混合大小写 Desktop-Motion 校验通过', validateEvent(evtMixed).valid === true);

// 3. 非白名单未知来源拦截 (INVALID_EVENT_SOURCE)
const disallowedSources = [
  'third_party_plugin',
  'external_http_api',
  'custom_script',
  'unknown_sensor',
  'arbitrary_agent'
];

for (const src of disallowedSources) {
  const evt = createEvent({ type: 'message', source: src, messageId: 'm-bad-01' });
  const v = validateEvent(evt);
  check(`非白名单来源 [${src}] 拦截拒绝 (INVALID_EVENT_SOURCE)`, !v.valid && v.reason.startsWith('INVALID_EVENT_SOURCE'));
}

// 4. 黑名单来源拦截 (PROHIBITED_EVENT_SOURCE)
const prohibitedList = ['system', 'system_prompt', 'internal_debug', 'synthetic_message', 'memory_compression'];
for (const src of prohibitedList) {
  const evt = createEvent({ type: 'message', source: src, messageId: 'm-pro-01' });
  const v = validateEvent(evt);
  check(`黑名单来源 [${src}] 拦截拒绝 (PROHIBITED_EVENT_SOURCE)`, !v.valid && v.reason.startsWith('PROHIBITED_EVENT_SOURCE'));
}

// 5. 顶层与 payload 中的 synthetic / bridge 污染拦截
const evtSynthetic = createEvent({ type: 'message', source: 'user', messageId: 'm-syn-01', payload: { synthetic: true } });
check('payload 夹带 synthetic 标记拦截', !validateEvent(evtSynthetic).valid && validateEvent(evtSynthetic).reason === 'SYNTHETIC_EVENT_PROHIBITED');

const evtBridge = createEvent({ type: 'message', source: 'user', messageId: 'm-brg-01', payload: { bridge: true } });
check('payload 夹带 bridge 标记拦截', !validateEvent(evtBridge).valid && validateEvent(evtBridge).reason === 'BRIDGE_EVENT_PROHIBITED');

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
