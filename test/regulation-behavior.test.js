/**
 * test/regulation-behavior.test.js
 * 
 * Life Phase 0.5 内部稳态对自主行为的概率倾斜调度专项测试 (Regulation -> Behavior Channel)
 * 
 * 核心验证：
 * 1. 行为权重动态调制算法：
 *    - 疲劳压力 (restPressure) 放大打哈欠 (yawn) 倾向 (最高 2.5x)
 *    - 低能量 (energy) 放大伸懒腰 (stretch) 倾向 (最高 2.0x)
 *    - 高唤醒度 (arousal) 放大张望 (look_around) 倾向 (最高 2.0x)
 *    - 平静低唤醒 (arousal) 适度提升梳理头发 (tidy_hair) 倾向
 * 2. 概率倾斜而非硬编码强行执行 (Probabilistic Modulation Invariant)：
 *    - 行为抽样遵循分布转移，绝不剥夺其他动作发生机率
 * 3. 基线与未注入稳态时的绝对一致性 (Baseline Identity)
 * 4. 礼貌闸门与 Controller 联动
 */

'use strict';

const { BehaviorScheduler, BEHAVIOR_DEFINITIONS } = require('../src/behavior-scheduler');
const { ANIMATION_STATES } = require('../src/animation-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 1. 无调节注入时的基线权重检查
const scheduler = new BehaviorScheduler();
const baselineWeights = scheduler.getModulatedWeights();
check('未注入内态时行为权重严格等于基线静态定义',
  baselineWeights[ANIMATION_STATES.YAWN] === BEHAVIOR_DEFINITIONS[ANIMATION_STATES.YAWN].weight &&
  baselineWeights[ANIMATION_STATES.STRETCH] === BEHAVIOR_DEFINITIONS[ANIMATION_STATES.STRETCH].weight &&
  baselineWeights[ANIMATION_STATES.LOOK_AROUND] === BEHAVIOR_DEFINITIONS[ANIMATION_STATES.LOOK_AROUND].weight
);

// 2. 注入模拟内部稳态提供者
const mockReg = {
  state: {
    energy: 100,
    restPressure: 0,
    arousal: 50,
    salienceThreshold: 45
  },
  getState() {
    return { ...this.state };
  }
};

scheduler.setInternalRegulation(mockReg);
const neutralWeights = scheduler.getModulatedWeights();
check('稳态处于平衡基线 (energy=100, restPressure=0, arousal=50) 时权重保持原始基准',
  neutralWeights[ANIMATION_STATES.YAWN] === BEHAVIOR_DEFINITIONS[ANIMATION_STATES.YAWN].weight &&
  neutralWeights[ANIMATION_STATES.STRETCH] === BEHAVIOR_DEFINITIONS[ANIMATION_STATES.STRETCH].weight
);

// 3. 高疲劳状态对打哈欠 (yawn) 的放大
mockReg.state.restPressure = 100;
const tiredWeights = scheduler.getModulatedWeights();
const baseYawn = BEHAVIOR_DEFINITIONS[ANIMATION_STATES.YAWN].weight;
const expectedTiredYawn = Number((baseYawn * 2.5).toFixed(4));
check('极端高疲劳 (restPressure=100) 使打哈欠权重放大至 2.5 倍',
  tiredWeights[ANIMATION_STATES.YAWN] === expectedTiredYawn,
  `base=${baseYawn}, tired=${tiredWeights[ANIMATION_STATES.YAWN]}`
);

// 4. 低能量状态对伸懒腰 (stretch) 的放大
mockReg.state.restPressure = 0;
mockReg.state.energy = 0;
const exhaustedWeights = scheduler.getModulatedWeights();
const baseStretch = BEHAVIOR_DEFINITIONS[ANIMATION_STATES.STRETCH].weight;
const expectedExhaustedStretch = Number((baseStretch * 2.0).toFixed(4));
check('能量见底 (energy=0) 使伸懒腰权重放大至 2.0 倍',
  exhaustedWeights[ANIMATION_STATES.STRETCH] === expectedExhaustedStretch,
  `base=${baseStretch}, exhausted=${exhaustedWeights[ANIMATION_STATES.STRETCH]}`
);

// 5. 高唤醒度对警觉张望 (look_around) 的放大
mockReg.state.energy = 100;
mockReg.state.arousal = 100;
const alertWeights = scheduler.getModulatedWeights();
const baseLook = BEHAVIOR_DEFINITIONS[ANIMATION_STATES.LOOK_AROUND].weight;
const expectedAlertLook = Number((baseLook * 2.0).toFixed(4));
check('高神经唤醒 (arousal=100) 使张望警觉权重放大至 2.0 倍',
  alertWeights[ANIMATION_STATES.LOOK_AROUND] === expectedAlertLook,
  `base=${baseLook}, alert=${alertWeights[ANIMATION_STATES.LOOK_AROUND]}`
);

// 6. 低唤醒度（平静）对整理头发 (tidy_hair) 的提升
mockReg.state.arousal = 0;
const calmWeights = scheduler.getModulatedWeights();
const baseHair = BEHAVIOR_DEFINITIONS[ANIMATION_STATES.TIDY_HAIR].weight;
const expectedCalmHair = Number((baseHair * 1.5).toFixed(4));
check('低唤醒度平静状态 (arousal=0) 提升整理头发权重至 1.5 倍',
  calmWeights[ANIMATION_STATES.TIDY_HAIR] === expectedCalmHair,
  `base=${baseHair}, calm=${calmWeights[ANIMATION_STATES.TIDY_HAIR]}`
);

// 7. 概率抽样测试：高疲劳下打哈欠频率显著提升，但非 100% 绝对强制
const sampleCount = 2000;
let baseYawnCount = 0;
mockReg.state = { energy: 100, restPressure: 0, arousal: 50 };
for (let i = 0; i < sampleCount; i++) {
  const b = scheduler._pickBehavior();
  if (b.id === ANIMATION_STATES.YAWN) baseYawnCount++;
}

let tiredYawnCount = 0;
mockReg.state = { energy: 100, restPressure: 100, arousal: 50 };
for (let i = 0; i < sampleCount; i++) {
  const b = scheduler._pickBehavior();
  if (b.id === ANIMATION_STATES.YAWN) tiredYawnCount++;
}

const baseYawnRatio = baseYawnCount / sampleCount;
const tiredYawnRatio = tiredYawnCount / sampleCount;

check('高疲劳下的打哈欠抽样发生率显著高于基线 (具有统计显著差异)',
  tiredYawnRatio > baseYawnRatio * 1.5,
  `baseRatio=${(baseYawnRatio * 100).toFixed(1)}%, tiredRatio=${(tiredYawnRatio * 100).toFixed(1)}%`
);
check('高疲劳下依然发生其他非哈欠自主动作 (保持概率柔性非强占)',
  tiredYawnRatio < 0.9,
  `tiredRatio=${(tiredYawnRatio * 100).toFixed(1)}%`
);

// 8. 低能量下的伸懒腰发生率测试
mockReg.state = { energy: 0, restPressure: 0, arousal: 50 };
let stretchCount = 0;
for (let i = 0; i < sampleCount; i++) {
  const b = scheduler._pickBehavior();
  if (b.id === ANIMATION_STATES.STRETCH) stretchCount++;
}
const stretchRatio = stretchCount / sampleCount;
check('低体能下的伸懒腰抽样发生率显著升高', stretchRatio > 0.3, `stretchRatio=${(stretchRatio * 100).toFixed(1)}%`);

// 9. Controller 执行与礼貌检查
let playedAction = null;
const mockController = {
  state: ANIMATION_STATES.IDLE,
  playAction(id, opts) {
    playedAction = id;
    return true;
  }
};

const liveScheduler = new BehaviorScheduler({
  controller: mockController,
  idleMinMs: 10,
  cooldownMinMs: 10,
  cooldownMaxMs: 10
});

liveScheduler.setInternalRegulation(mockReg);
const chosen = liveScheduler.evaluate(Date.now() + 1000);
check('满足静默与空闲条件时 evaluate 正确触发微动作执行', !!chosen && playedAction === chosen.id);

// 10. 礼貌检查拦截
let politeAllowed = false;
const politeScheduler = new BehaviorScheduler({
  controller: mockController,
  idleMinMs: 10,
  politeCheck: () => politeAllowed
});
const politeResult = politeScheduler.evaluate(Date.now() + 1000);
check('礼貌检查未通过时绝不打扰用户 (evaluate 返回 null)', politeResult === null);

// 11. 生命周期与资源管理
liveScheduler.start();
check('start() 成功建立调度循环', !!liveScheduler._timer);
liveScheduler.stop();
check('stop() 清空调度循环定时器', liveScheduler._timer === null);
liveScheduler.destroy();
check('destroy() 标记已销毁并释放资源', liveScheduler._destroyed === true);

// 12. 自定义 pickBehavior 钩子优先级
const overrideScheduler = new BehaviorScheduler({
  pickBehavior: (pool) => pool.find(p => p.id === ANIMATION_STATES.TIDY_HAIR)
});
check('自定义 pickBehavior 拥有最高优先级', overrideScheduler._pickBehavior().id === ANIMATION_STATES.TIDY_HAIR);

// 13. 基线不变量隔离
const isolatedScheduler = new BehaviorScheduler({ internalRegulation: null });
const isoWeights = isolatedScheduler.getModulatedWeights();
check('稳态隔离实例行为权重 100% 等同于基准', isoWeights[ANIMATION_STATES.YAWN] === BEHAVIOR_DEFINITIONS[ANIMATION_STATES.YAWN].weight);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
