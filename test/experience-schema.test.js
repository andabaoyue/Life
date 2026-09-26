/**
 * test/experience-schema.test.js
 * 
 * 初澜数字生命实验：经验与事实三层分离规范单元测试 (v0.9.4)
 * 
 * 检验点：
 * 1. Event（真实事件）创建、字段完备性与非法结构校验
 * 2. Observation（观察模式）创建、关联 Event 强核验与置信度约束
 * 3. Interpretation（主体主观解释）创建、关联 Observation 强核验
 * 4. Experience 复合单元封装
 * 5. wrapArchiveRecord 与 normalizeArchiveRecord 跨版本兼容性
 * 6. 核心哲学边界：主体解释与观察无法逆向篡改底层客观事件
 */

const {
  createEvent,
  validateEvent,
  createObservation,
  validateObservation,
  createInterpretation,
  validateInterpretation,
  createExperience,
  wrapArchiveRecord,
  normalizeArchiveRecord
} = require('../src/experience-schema');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 1. Event 基础创建与校验
const evt1 = createEvent({
  type: 'message',
  messageId: 'm-000001',
  source: 'user',
  payload: { text: '初澜，今天外面下雨了。' }
});

check('createEvent 成功分配自增 eventId', typeof evt1.eventId === 'string' && evt1.eventId.startsWith('evt-'));
check('createEvent 字段类型与默认值合法', evt1.type === 'message' && evt1.source === 'user' && typeof evt1.timestamp === 'number');

const vEvtValid = validateEvent(evt1);
check('validateEvent 合法事件返回 valid: true', vEvtValid.valid === true);

const vEvtInvalid1 = validateEvent(null);
check('validateEvent 非法对象拒绝', vEvtInvalid1.valid === false && vEvtInvalid1.reason === 'INVALID_OBJECT');

const vEvtInvalid2 = validateEvent({ eventId: '', type: 'msg' });
check('validateEvent 缺少 eventId 拒绝', vEvtInvalid2.valid === false && vEvtInvalid2.reason === 'MISSING_EVENT_ID');

const vEvtInvalid3 = validateEvent({ eventId: 'evt-999', type: '' });
check('validateEvent 缺少 type 拒绝', vEvtInvalid3.valid === false && vEvtInvalid3.reason === 'MISSING_TYPE');

// 2. Observation 观察创建与溯源校验
const obs1 = createObservation({
  eventIds: [evt1.eventId],
  type: 'weather_discussion',
  content: '用户提及外部环境天气下雨',
  confidence: 0.95
});

check('createObservation 成功分配 observationId', typeof obs1.observationId === 'string' && obs1.observationId.startsWith('obs-'));
check('createObservation 正确关联 eventIds', obs1.eventIds.length === 1 && obs1.eventIds[0] === evt1.eventId);

const availableEvents = new Set([evt1.eventId]);
const vObsValid = validateObservation(obs1, availableEvents);
check('validateObservation 在事件源存在时返回 valid: true', vObsValid.valid === true);

const obsWithoutEvents = createObservation({ eventIds: [], content: '无根观察' });
const vObsNoEvents = validateObservation(obsWithoutEvents);
check('validateObservation 拒绝无底层 Event 支撑的空泛观察', vObsNoEvents.valid === false && vObsNoEvents.reason === 'OBSERVATION_REQUIRES_EVENTS');

const obsMissingRef = createObservation({ eventIds: ['evt-not-exist'], content: '虚假引用' });
const vObsMissing = validateObservation(obsMissingRef, availableEvents);
check('validateObservation 拒绝对未收录 Event 的悬空引用', vObsMissing.valid === false && vObsMissing.reason.includes('REFERENCED_EVENT_NOT_FOUND'));

// 3. Interpretation 主体解释与观察溯源校验
const interp1 = createInterpretation({
  observationIds: [obs1.observationId],
  content: '用户在下雨天似乎渴望温和安静的陪伴',
  confidence: 0.7
});

check('createInterpretation 成功分配 interpretationId', typeof interp1.interpretationId === 'string' && interp1.interpretationId.startsWith('int-'));
check('createInterpretation 默认视角为 chulan', interp1.perspective === 'chulan');

const availableObs = new Set([obs1.observationId]);
const vInterpValid = validateInterpretation(interp1, availableObs);
check('validateInterpretation 在观察项存在时返回 valid: true', vInterpValid.valid === true);

const interpNoObs = createInterpretation({ observationIds: [], content: '无根想象' });
const vInterpNoObs = validateInterpretation(interpNoObs);
check('validateInterpretation 拒绝脱离 Observation 的凭空解释', vInterpNoObs.valid === false && vInterpNoObs.reason === 'INTERPRETATION_REQUIRES_OBSERVATIONS');

const interpMissingRef = createInterpretation({ observationIds: ['obs-missing'], content: '引空观察' });
const vInterpMissing = validateInterpretation(interpMissingRef, availableObs);
check('validateInterpretation 拒绝对未收录 Observation 的悬空引用', vInterpMissing.valid === false && vInterpMissing.reason.includes('REFERENCED_OBSERVATION_NOT_FOUND'));

// 4. Experience 复合单元
const exp = createExperience({
  windowNo: 1,
  events: [evt1],
  observations: [obs1],
  interpretations: [interp1],
  evidence: []
});
check('createExperience 成功封装复合经历', typeof exp.experienceId === 'string' && exp.events.length === 1 && exp.interpretations.length === 1);

// 5. 归档封装与向后兼容测试
const wrapped = wrapArchiveRecord('state_change', 2, { delta: 10 });
check('wrapArchiveRecord 成功包装标准 schemaVersion 与元数据',
  wrapped.schemaVersion === 1 && wrapped.recordType === 'state_change' && wrapped.windowNo === 2 && wrapped.payload.delta === 10);

const normalizedCurrent = normalizeArchiveRecord(wrapped);
check('normalizeArchiveRecord 直通 v0.9.4 标准记录', normalizedCurrent === wrapped);

const legacyRecord = {
  type: 'window_archive',
  windowNo: 3,
  turns: 100,
  createdAt: 1700000000000,
  segments: [{ range: '1-20' }],
  windowSynthesis: { stableUserFacts: ['已存在的事实'] },
  verifiedEvidence: [{ trait: 'vitality', direction: 1, strength: 1.0 }]
};

const normalizedLegacy = normalizeArchiveRecord(legacyRecord);
check('normalizeArchiveRecord 平滑转换 v0.9.3 legacy window_archive',
  normalizedLegacy.recordType === 'window_summary' &&
  normalizedLegacy.windowNo === 3 &&
  normalizedLegacy.payload.verifiedEvidence.length === 1 &&
  normalizedLegacy.payload.windowSynthesis.stableUserFacts[0] === '已存在的事实');

check('normalizeArchiveRecord 非法输入安全返回 null', normalizeArchiveRecord(null) === null && normalizeArchiveRecord(undefined) === null);

// 6. 哲学边界：主体解释不得篡改客观事实
const originalText = evt1.payload.text;
interp1.content = '用户其实非常狂躁并且讨厌雨天';
check('主体解释修改绝不影响底层 Event 事实原文', evt1.payload.text === originalText);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
