/**
 * test/provenance-boundary.test.js
 * 
 * Life v0.9.6 实验基线强化测试集 4：SubjectState.verifyEvidence 完整 12 规则校验专项测试
 * 
 * 检验点：
 * 1. INVALID_OBJECT: 非法对象或 null 拒绝
 * 2. TRAIT_NOT_IN_WHITELIST: 非白名单特质拒绝
 * 3. DUPLICATE_EVIDENCE_ID: 重复 evidenceId 拦截
 * 4. MISSING_MESSAGE_ID: 缺失 messageId 拦截
 * 5. MESSAGE_ID_NOT_FOUND: messageId 在当前快照消息池不存在时拒绝
 * 6. MESSAGE_WINDOW_MISMATCH: 消息所属窗口与目标归档窗口不符时拦截
 * 7. SYNTHETIC_MESSAGE_NOT_ELIGIBLE: 程序合成消息 (synthetic: true) 拒绝作为主体经历证据
 * 8. BRIDGE_MESSAGE_NOT_ELIGIBLE: 缓存桥接消息 (bridge: true) 拒绝作为新窗口证据
 * 9. INVALID_MESSAGE_ROLE: 非法消息角色 (如 system/tool) 拦截拒绝
 * 10. MISSING_QUOTE & QUOTE_NOT_IN_SOURCE_MESSAGE: 缺少摘录或摘录非消息字面子串时拒绝
 * 11. DIRECTION_OUT_OF_BOUNDS & STRENGTH_OUT_OF_BOUNDS: 方向超出 [-1, 1] 或强度超出 [0, 1] 时拒绝
 * 12. DUPLICATE_EVIDENCE_FINGERPRINT: 相同指纹防重提交拦截
 * 13. 合法证据通过检验，输出 status: 'verified' 并带完整 Provenance 元数据
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SubjectState } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'provenance-boundary-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const dir = tmpDir();
const state = new SubjectState(dir);

// 准备测试用消息池 (Window 1)
const mockMessages = [
  {
    messageId: 'm-000001',
    role: 'user',
    content: '初澜，我喜欢安静且专注的交流环境。',
    windowNo: 1,
    bridge: false,
    synthetic: false
  },
  {
    messageId: 'm-000002',
    role: 'assistant',
    content: '好的，我会一直安静陪伴你思考。',
    windowNo: 1,
    bridge: false,
    synthetic: false
  },
  {
    messageId: 'm-000003',
    role: 'user',
    content: '跨窗口历史消息',
    windowNo: 2, // 窗口 2
    bridge: false,
    synthetic: false
  },
  {
    messageId: 'm-000004',
    role: 'user',
    content: '[自主感知触发]：主动搭话',
    windowNo: 1,
    bridge: false,
    synthetic: true // 程序合成
  },
  {
    messageId: 'm-000005',
    role: 'user',
    content: '上一窗口留存的桥接对话',
    windowNo: 1,
    bridge: true, // 桥接消息
    synthetic: false
  },
  {
    messageId: 'm-000006',
    role: 'system',
    content: '系统提示词消息',
    windowNo: 1,
    bridge: false,
    synthetic: false
  }
];

// 规则 1: INVALID_OBJECT
{
  const res = state.verifyEvidence([null, undefined, 'not-an-object'], mockMessages, 1);
  check('规则 1: null 与非法对象被拒绝 (INVALID_OBJECT)', res.rejected.length === 3 && res.rejected[0].reason === 'INVALID_OBJECT');
}

// 规则 2: TRAIT_NOT_IN_WHITELIST
{
  const res = state.verifyEvidence([
    {
      trait: 'super_intelligence_fictional',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000001',
      quote: '喜欢安静'
    }
  ], mockMessages, 1);
  check('规则 2: 非白名单特质被拒绝 (TRAIT_NOT_IN_WHITELIST)', res.rejected.length === 1 && res.rejected[0].reason === 'TRAIT_NOT_IN_WHITELIST');
}

// 规则 3: DUPLICATE_EVIDENCE_ID
{
  const res = state.verifyEvidence([
    {
      evidenceId: 'ev-fixed-id-01',
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000001',
      quote: '喜欢安静'
    },
    {
      evidenceId: 'ev-fixed-id-01', // 重复 ID
      trait: 'vitality',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000002',
      quote: '安静陪伴'
    }
  ], mockMessages, 1);
  check('规则 3: 同批次重复 evidenceId 被拒绝 (DUPLICATE_EVIDENCE_ID)', res.verified.length === 1 && res.rejected[0].reason === 'DUPLICATE_EVIDENCE_ID');
}

// 规则 4: MISSING_MESSAGE_ID
{
  const res = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: '',
      quote: '喜欢安静'
    }
  ], mockMessages, 1);
  check('规则 4: 缺失 messageId 被拒绝 (MISSING_MESSAGE_ID)', res.rejected.length === 1 && res.rejected[0].reason === 'MISSING_MESSAGE_ID');
}

// 规则 5: MESSAGE_ID_NOT_FOUND
{
  const res = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-non-existent-999',
      quote: '喜欢安静'
    }
  ], mockMessages, 1);
  check('规则 5: 消息池中不存在的 messageId 被拒绝 (MESSAGE_ID_NOT_FOUND)', res.rejected.length === 1 && res.rejected[0].reason === 'MESSAGE_ID_NOT_FOUND');
}

// 规则 6: MESSAGE_WINDOW_MISMATCH
{
  const res = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000003', // 属于 Window 2
      quote: '跨窗口历史消息'
    }
  ], mockMessages, 1); // 目标归档窗口为 Window 1
  check('规则 6: 消息所属窗口不匹配被拒绝 (MESSAGE_WINDOW_MISMATCH)', res.rejected.length === 1 && res.rejected[0].reason === 'MESSAGE_WINDOW_MISMATCH');
}

// 规则 7: SYNTHETIC_MESSAGE_NOT_ELIGIBLE
{
  const res = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000004', // synthetic: true
      quote: '主动搭话'
    }
  ], mockMessages, 1);
  check('规则 7: 程序合成消息被拒绝 (SYNTHETIC_MESSAGE_NOT_ELIGIBLE)', res.rejected.length === 1 && res.rejected[0].reason === 'SYNTHETIC_MESSAGE_NOT_ELIGIBLE');
}

// 规则 8: BRIDGE_MESSAGE_NOT_ELIGIBLE
{
  const res = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000005', // bridge: true
      quote: '桥接对话'
    }
  ], mockMessages, 1);
  check('规则 8: 缓存桥接消息被拒绝 (BRIDGE_MESSAGE_NOT_ELIGIBLE)', res.rejected.length === 1 && res.rejected[0].reason === 'BRIDGE_MESSAGE_NOT_ELIGIBLE');
}

// 规则 9: INVALID_MESSAGE_ROLE
{
  const res = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000006', // role: system
      quote: '系统提示词'
    }
  ], mockMessages, 1);
  check('规则 9: 非法消息角色 (system) 被拒绝 (INVALID_MESSAGE_ROLE)', res.rejected.length === 1 && res.rejected[0].reason === 'INVALID_MESSAGE_ROLE');
}

// 规则 10: MISSING_QUOTE & QUOTE_NOT_IN_SOURCE_MESSAGE
{
  const resEmptyQuote = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000001',
      quote: ''
    }
  ], mockMessages, 1);
  check('规则 10.1: 缺失引用文本被拒绝 (MISSING_QUOTE)', resEmptyQuote.rejected.length === 1 && resEmptyQuote.rejected[0].reason === 'MISSING_QUOTE');

  const resWrongQuote = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 0.5,
      messageId: 'm-000001',
      quote: '凭空捏造的话，原文根本没有'
    }
  ], mockMessages, 1);
  check('规则 10.2: 引用文本非消息子串被拒绝 (QUOTE_NOT_IN_SOURCE_MESSAGE)', resWrongQuote.rejected.length === 1 && resWrongQuote.rejected[0].reason === 'QUOTE_NOT_IN_SOURCE_MESSAGE');
}

// 规则 11: DIRECTION_OUT_OF_BOUNDS & STRENGTH_OUT_OF_BOUNDS
{
  const resBadDir = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 5, // 超出 [-1, 1]
      strength: 0.5,
      messageId: 'm-000001',
      quote: '喜欢安静'
    }
  ], mockMessages, 1);
  check('规则 11.1: 方向数值越界被拒绝 (DIRECTION_OUT_OF_BOUNDS)', resBadDir.rejected.length === 1 && resBadDir.rejected[0].reason === 'DIRECTION_OUT_OF_BOUNDS');

  const resBadStr = state.verifyEvidence([
    {
      trait: 'quiet_preference',
      direction: 1,
      strength: 2.5, // 超出 [0, 1]
      messageId: 'm-000001',
      quote: '喜欢安静'
    }
  ], mockMessages, 1);
  check('规则 11.2: 强度数值越界被拒绝 (STRENGTH_OUT_OF_BOUNDS)', resBadStr.rejected.length === 1 && resBadStr.rejected[0].reason === 'STRENGTH_OUT_OF_BOUNDS');
}

// 规则 12: DUPLICATE_EVIDENCE_FINGERPRINT
{
  const res1 = state.verifyEvidence([
    {
      trait: 'philosophical_curiosity',
      direction: 1,
      strength: 0.8,
      messageId: 'm-000001',
      quote: '专注的交流环境'
    }
  ], mockMessages, 1);
  check('首次提交新指纹证据成功验证', res1.verified.length === 1);

  const resDupFingerprint = state.verifyEvidence([
    {
      trait: 'philosophical_curiosity',
      direction: 1,
      strength: 0.4, // 修改 strength 依然属于同一指纹
      messageId: 'm-000001',
      quote: '专注的交流环境'
    }
  ], mockMessages, 1);
  check('规则 12: 相同指纹防重复提交被拒绝 (DUPLICATE_EVIDENCE_FINGERPRINT)', resDupFingerprint.rejected.length === 1 && resDupFingerprint.rejected[0].reason === 'DUPLICATE_EVIDENCE_FINGERPRINT');
}

// 验证完全合法证据
{
  const resValid = state.verifyEvidence([
    {
      trait: 'attachment_need',
      direction: 1,
      strength: 0.9,
      messageId: 'm-000002',
      quote: '一直安静陪伴你'
    }
  ], mockMessages, 1);

  check('合法证据核验通过 (verified)', resValid.verified.length === 1);
  const ev = resValid.verified[0];
  check('合法证据状态为 verified', ev.status === 'verified');
  check('合法证据包含指纹 fingerprint', typeof ev.fingerprint === 'string' && ev.fingerprint.length > 0);
  check('合法证据保留来源 messageId', ev.messageId === 'm-000002');
  check('合法证据精确引用原文 quote', ev.quote === '一直安静陪伴你');
  check('合法证据记录正确 windowNo', ev.windowNo === 1);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
