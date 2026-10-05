/**
 * test/sleep-dream-timing.test.js
 *
 * Life v3.1 梦境时序改造专项测试：结算点从「入睡那一刻」后移到「苏醒那一刻」
 *
 * 背景（用户实测报障）：初澜睡觉时退出软件，重进后梦已经做完了。
 * 根因：入睡那一刻就直接调 LLM 做梦且不等待（实测 15:37:10 说晚安 → 15:37:12 梦已落盘）。
 *
 * 检验点：
 * 1. 入睡只冻结梦境原料，零 LLM 调用；sleepStartTime 与原料同盘原子持久化
 * 2. 睡眠状态跨重启恢复：「退出前什么状态，回归后还是什么状态」
 * 3. 物理时长门禁：小憩（Δt < 30 分钟）不做梦，且时长必须用挂钟不能用窗口数
 * 4. 拿不出可信睡眠时长就不做梦，绝不编造时长
 * 5. 睡眠来源豁免窗口间隔门禁（跨夜长睡期间窗口号静止，会被误杀）
 * 6. 豁免不放行 24h 频次硬顶与认知门禁（成本与张力护栏必须守住）
 * 7. 原料一次性消费：同一份睡眠原料绝不重复做梦
 * 8. 陈旧状态防线：清醒态却带着入睡时刻的陈旧数据必须丢弃
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { InternalRegulationManager } = require('../src/internal-regulation');
const { evaluateDreamGate } = require('../src/dream-system');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('PASS  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  }
}

const MIN = 60 * 1000;
const T0 = 1791185830796;   // 固定时刻，保证判定确定性

// 高张力证据：让认知门禁（第一道）放行，从而单独检验成本与时长门禁
const TENSE_EVIDENCE = [
  { trait: 'trust', direction: 1, strength: 0.8, quote: '我一直都相信你' },
  { trait: 'trust', direction: -1, strength: 0.8, quote: '但你上次骗了我' }
];

function mkReg(dir) {
  return new InternalRegulationManager(dir, { enabled: true });
}

// ============ 1. 入睡冻结：零 LLM，原料与时刻同盘持久化 ============
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-sdt1-'));
  const reg = mkReg(dir);

  reg.updateOnSleep(true, { timestamp: T0 });
  const staging = reg.stageSleepContext({
    at: T0,
    windowNo: 5,
    dayResidues: [{ sourceType: 'tail_conversation', role: 'user', text: '我去睡了' }],
    arousalTrajectory: { arousalValues: [30, 70] },
    noveltyScore: 0.1
  });

  check('入睡冻结返回冻结体并标记 fromSleep', staging !== null && staging.fromSleep === true);
  check('入睡时刻被记录', reg.sleepStartTime === T0);
  check('原料条数被限制在 6 条以内', staging.dayResidues.length <= 6);

  // 原料条数超限必须被截断（防止 Prompt 膨胀）
  const many = reg.stageSleepContext({
    at: T0, windowNo: 5,
    dayResidues: Array.from({ length: 20 }, (_, i) => ({ sourceType: 'x', text: 'r' + i }))
  });
  check('原料超过 6 条被截断', many.dayResidues.length === 6, 'got ' + many.dayResidues.length);

  // 拿不到窗口号时记0，绝不臆造
  const noWin = reg.stageSleepContext({ at: T0, dayResidues: [{ text: 'a' }] });
  check('缺窗口号时如实记 0（不臆造窗口号）', noWin.windowNo === 0, 'got ' + noWin.windowNo);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'internal-regulation.json'), 'utf8'));
  check('落盘 isSleeping=true', onDisk.isSleeping === true);
  check('落盘 sleepStartTime', onDisk.sleepStartTime === T0);
  check('落盘 sleepStaging 原料', !!(onDisk.sleepStaging && onDisk.sleepStaging.dayResidues.length > 0));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============ 2. 跨重启恢复：退出前什么状态，回归后还是什么状态 ============
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-sdt2-'));
  const reg1 = mkReg(dir);
  reg1.updateOnSleep(true, { timestamp: T0 });
  reg1.stageSleepContext({
    at: T0, windowNo: 5,
    dayResidues: [{ sourceType: 'tail_conversation', role: 'user', text: '我去睡了' }],
    noveltyScore: 0.1
  });
  // 进程消亡（模拟退出软件），磁盘原样保留

  const reg2 = mkReg(dir);
  check('重进后仍在睡', reg2.isSleeping === true);
  check('重进后入睡时刻恢复（睡眠进度没被重置）', reg2.sleepStartTime === T0);
  check('重进后原料恢复', !!(reg2.sleepStaging && reg2.sleepStaging.dayResidues.length > 0));

  // 重复触发入睡不得刷新起始时间（否则「晚安」连说三遍她永远是刚睡）
  reg2.updateOnSleep(true, { timestamp: T0 + 999999 });
  check('重复触发入睡不刷新起始时刻（幂等）', reg2.sleepStartTime === T0);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============ 3. 物理时长门禁：小憩不做梦 ============
{
  const base = {
    windowNo: 5,
    verifiedEvidence: TENSE_EVIDENCE,
    dreamHistory: [],
    now: T0 + 8 * 60 * MIN
  };

  const rNap = evaluateDreamGate({
    ...base, fromSleep: true, sleepElapsedMs: 20 * MIN
  });
  check('小憩 20 分钟被拦', rNap.allowDream === false);
  check('小憩拦截原因明确为 NAP_TOO_SHORT', /^NAP_TOO_SHORT/.test(rNap.reason), rNap.reason);

  const rDeep = evaluateDreamGate({
    ...base, fromSleep: true, sleepElapsedMs: 8 * 60 * MIN
  });
  check('睡够 8 小时放行', rDeep.allowDream === true, rDeep.reason);
  check('睡眠时长被如实登记（480 分钟）', rDeep.sleepElapsedMinutes === 480, 'got ' + rDeep.sleepElapsedMinutes);

  const rEdge = evaluateDreamGate({ ...base, fromSleep: true, sleepElapsedMs: 30 * MIN });
  check('恰好 30 分钟放行（边界含等号）', rEdge.allowDream === true, rEdge.reason);
  const rUnder = evaluateDreamGate({ ...base, fromSleep: true, sleepElapsedMs: 29.9 * MIN });
  check('29.9 分钟被拦（边界不含）', rUnder.allowDream === false, rUnder.reason);

  // 非睡眠来源（关窗老路径）时长门禁完全不生效，行为逐字节不变
  const rPlain = evaluateDreamGate(base);
  check('非睡眠来源不做时长判定', rPlain.sleepGateChecked === false);
  check('非睡眠来源 fromSleep=false', rPlain.fromSleep === false);
}

// ============ 4. 拿不出可信时长就不做梦，绝不编造 ============
{
  const base = {
    windowNo: 5, verifiedEvidence: TENSE_EVIDENCE, dreamHistory: [],
    now: T0 + 8 * 60 * MIN, fromSleep: true
  };
  const rNone = evaluateDreamGate(base);
  check('缺时长参数被拦', rNone.allowDream === false);
  check('原因明确为 SLEEP_ELAPSED_UNKNOWN', /SLEEP_ELAPSED_UNKNOWN/.test(rNone.reason), rNone.reason);

  const rNeg = evaluateDreamGate({ ...base, sleepElapsedMs: -5 });
  check('负时长被拦（负值不得当成"睡了一整夜"）', rNeg.allowDream === false, rNeg.reason);
}

// ============ 5. 睡眠来源豁免窗口间隔（跨夜长睡会被误杀） ============
{
  // 睡觉期间不关窗（关窗要调 LLM），跨夜醒来时 windowNo 几乎没动过Δ=0，
  // 若不豁免，这次梦会被误杀成 INTERVAL_TOO_SHORT。
  // 历史梦必须挪到 24h 之外，否则频次硬顶会先触发、盖住要验的窗口豁免效果。
  const hist = [
    { windowNo: 3, generatedAt: T0 - 48 * 60 * MIN, preClose: false },
    { windowNo: 5, generatedAt: T0 - 47 * 60 * MIN, preClose: true }
  ];
  const base = {
    windowNo: 5, verifiedEvidence: TENSE_EVIDENCE, dreamHistory: hist,
    now: T0 + 8 * 60 * MIN
  };

  const rNoWaiver = evaluateDreamGate(base);
  check('无豁免时同窗口去重确实会拦（证明豁免有必要）',
    rNoWaiver.allowDream === false, rNoWaiver.reason);

  const rWaived = evaluateDreamGate({ ...base, fromSleep: true, sleepElapsedMs: 8 * 60 * MIN });
  check('睡眠来源豁免窗口间隔后放行', rWaived.allowDream === true, rWaived.reason);
}

// ============ 6. 豁免绝不放行 24h 频次硬顶与认知门禁 ============
{
  const heavyHist = [
    { windowNo: 1, generatedAt: T0 - 60 * MIN, preClose: false },
    { windowNo: 2, generatedAt: T0 - 30 * MIN, preClose: false }
  ];
  const rRate = evaluateDreamGate({
    windowNo: 20, verifiedEvidence: TENSE_EVIDENCE, dreamHistory: heavyHist,
    now: T0 + 8 * 60 * MIN, fromSleep: true, sleepElapsedMs: 8 * 60 * MIN
  });
  check('24h频次硬顶不被豁免击穿（成本护栏必须守住）', rRate.allowDream === false, rRate.reason);
  check('频次超限原因如实保留', /DAILY_RATE_LIMIT_EXCEEDED/.test(rRate.reason), rRate.reason);

  const rTension = evaluateDreamGate({
    windowNo: 5, verifiedEvidence: [], dreamHistory: [],
    now: T0 + 8 * 60 * MIN, fromSleep: true, sleepElapsedMs: 8 * 60 * MIN
  });
  check('豁免不放行认知门禁（无张力仍不做梦）', rTension.allowDream === false, rTension.reason);
  check('无张力时原因明确为 INSUFFICIENT_TENSION', rTension.reason === 'INSUFFICIENT_TENSION', rTension.reason);
}

// ============ 7. 原料一次性消费 + 8. 陈旧状态防线 ============
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-sdt7-'));
  const reg = mkReg(dir);
  reg.updateOnSleep(true, { timestamp: T0 });
  reg.stageSleepContext({
    at: T0, windowNo: 5,
    dayResidues: [{ sourceType: 'tail_conversation', role: 'user', text: 'x' }], noveltyScore: 0.1
  });

  const had = reg.clearSleepContext();
  check('清空睡眠上下文返回 true（确有数据被清）', had === true);
  check('原料已清空', reg.sleepStaging === null);
  check('入睡时刻已清空', reg.sleepStartTime === null);
  check('清空后不再能发起第二次睡眠结算', reg.getSleepContext(T0 + 8 * MIN) === null);
  check('不在睡时 getSleepContext 返回 null（零开销）', reg.getSleepContext(Date.now()) === null);

  // 磁盘上被注入「清醒态 + 陈旧入睡时刻」的自相矛盾组合
  reg.updateOnSleep(false, { timestamp: T0 + 8 * 60 * MIN });
  const file = path.join(dir, 'internal-regulation.json');
  const corrupted = JSON.parse(fs.readFileSync(file, 'utf8'));
  corrupted.isSleeping = false;
  corrupted.sleepStartTime = T0;
  corrupted.sleepStaging = { at: T0, windowNo: 5, dayResidues: [{ text: 'stale' }], fromSleep: true };
  fs.writeFileSync(file, JSON.stringify(corrupted, null, 2));

  const reg3 = mkReg(dir);
  check('清醒态的陈旧入睡时刻被丢弃', reg3.sleepStartTime === null, 'got ' + reg3.sleepStartTime);
  check('清醒态的陈旧原料被丢弃', reg3.sleepStaging === null);
  check('丢弃后不会谎报「睡了8 小时」', reg3.getSleepContext(T0 + 8 * 60 * MIN) === null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============ 9. 基线隔离：模块未启用时坚决不写盘 ============
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-sdt9-'));
  const reg = new InternalRegulationManager(dir, { enabled: false });
  check('未启用时冻结返回 null', reg.stageSleepContext({ at: T0, windowNo: 5 }) === null);
  check('未启用时 state 文件未被创建', !fs.existsSync(path.join(dir, 'internal-regulation.json')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ============ 10. 纯函数确定性 ============
{
  const args = {
    windowNo: 5, verifiedEvidence: TENSE_EVIDENCE, dreamHistory: [],
    now: T0 + 8 * 60 * MIN, fromSleep: true, sleepElapsedMs: 8 * 60 * MIN
  };
  const a = evaluateDreamGate(args);
  const b = evaluateDreamGate(args);
  check('门禁为纯函数：同输入两次结果严格一致', JSON.stringify(a) === JSON.stringify(b));
}

// ============ 11. 孤立睡眠态自愈（v3.1 修复「显示深睡却在漫步」的根因）============
{
  // 用户实测报障：isSleeping=true 但 sleepStartTime=null（跨版本残留：旧版只写
  // isSleeping 不写时刻）。此态若不自愈：getSleepContext 恒返回 null →
  // 惰性苏醒分支永远进不去 → 唤醒永不发生 → isSleeping 永为 true，
  // 而 tracker 已在内存里醒着 ——「显示深度休眠却在桌面上漫步」且永不自愈。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-sdt11-'));
  const file = path.join(dir, 'internal-regulation.json');

  // 手工造出卡死态：只写 isSleeping，不写 sleepStartTime（模拟旧版本残留）
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    isSleeping: true,
    updatedAt: T0,
    values: { energy: 28, restPressure: 2, arousal: 73, salienceThreshold: 34, interactionDensity: 30, cognitiveLoadProxy: 3 },
    history: [{ transitionId: 'reg-old', trigger: 'enter_sleep', timestamp: T0, deltas: {}, previousValues: {}, nextValues: {} }]
  }, null, 2));

  const reg = mkReg(dir);
  check('孤立睡眠态被自愈纠正为清醒', reg.isSleeping === false, 'isSleeping=' + reg.isSleeping);
  check('自愈后无残留入睡时刻', reg.sleepStartTime === null);
  check('自愈原因被如实登记（可审计）',
    reg.persistenceError === 'ORPHAN_SLEEP_STATE_SELF_HEALED', reg.persistenceError);
  check('自愈后 getSleepContext 返回 null（不再卡死）', reg.getSleepContext(T0 + 8 * 60 * MIN) === null);

  // 自愈后必须还能正常入睡 —— 修复不能把功能锁死
  reg.updateOnSleep(true, { timestamp: T0 });
  reg.stageSleepContext({ at: T0, windowNo: 5, dayResidues: [{ text: 'x' }] });
  check('自愈后仍可正常入睡并冻结', reg.isSleeping === true && reg.sleepStartTime === T0);
  check('自愈后 getSleepContext 恢复正常', reg.getSleepContext(T0 + 40 * MIN) !== null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============ 12. 正常睡眠态绝不被误伤（自愈不能过度）============
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-sdt12-'));
  const reg1 = mkReg(dir);
  reg1.updateOnSleep(true, { timestamp: T0 });
  reg1.stageSleepContext({ at: T0, windowNo: 5, dayResidues: [{ text: 'x' }] });

  // 冷启动重读：状态完整，必须原样恢复而不是被自愈误判
  const reg2 = mkReg(dir);
  check('完整睡眠态跨重启原样恢复（不被自愈误伤）', reg2.isSleeping === true);
  check('完整睡眠态跨重启时刻不丢', reg2.sleepStartTime === T0);
  check('完整睡眠态跨重启原料不丢', !!(reg2.sleepStaging && reg2.sleepStaging.dayResidues.length > 0));
  check('完整睡眠态无自愈告警', reg2.persistenceError !== 'ORPHAN_SLEEP_STATE_SELF_HEALED');

  // 清醒态依旧清干净（原有防线不能被破坏）
  reg2.updateOnSleep(false, { timestamp: T0 + 40 * MIN });
  const reg3 = mkReg(dir);
  check('清醒态跨重启不被误判为睡眠', reg3.isSleeping === false);
  check('清醒态无残留时刻', reg3.sleepStartTime === null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============ 13. 苏醒解耦：拿不到睡眠上下文也必须醒（v3.1 修复核心）============
{
  // brain 层铁律：苏醒是不可逆的物理事实，绝不能因为 sleepCtx 为 null 就不醒。
  // 这条用源码断言锁住 —— 历史上正是"if (sleepCtx && ...)"写法导致唤醒永不发生。
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
  check('brain.js 不再用 sleepCtx 作为唤醒的前置条件',
    !/if \(sleepCtx\s*&&\s*this\.internalRegulation\.updateOnSleep/.test(brainSrc));
  check('brain.js 惰性苏醒以 isSleeping 为唯一唤醒判据',
    /internalRegulation\.isSleeping === true[\s\S]{0,400}updateOnSleep\(false/.test(brainSrc));

  const trackerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tracker.js'), 'utf8');
  // 只比对真实调用行（注释里也会出现这两个名字，比对全文首现位置会误判）
  const grabCall = trackerSrc.split('\n').findIndex(l => /getSleepContext\(at\)/.test(l));
  const clearCall = trackerSrc.split('\n').findIndex(l => /internalRegulation\.updateOnSleep\(false/.test(l));
  check('tracker.js 唤醒顺序：先抓上下文再清空（原料才不会被冲掉）',
    grabCall > -1 && clearCall > -1 && grabCall < clearCall,
    'grab=' + grabCall + ' clear=' + clearCall);

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('main.js 睡眠判定为双源守卫（tracker + internalRegulation）',
    /tracker && tracker\.sleepMode\)\s*\|\|\s*brainIsSleeping/.test(mainSrc));

  const regSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'internal-regulation.js'), 'utf8');
  check('internal-regulation.js 含孤立睡眠态自愈分支',
    /ORPHAN_SLEEP_STATE_SELF_HEALED/.test(regSrc));
}

// ============ 14. 回话腰斩：思维链不得吞掉台词配额（v3.1 修复）============
{
  const ds = fs.readFileSync(path.join(__dirname, '..', 'src', 'deepseek.js'), 'utf8');
  check('deepseek.js 显式关闭服务端思维链', /thinking:\s*\{\s*type:\s*'disabled'\s*\}/.test(ds));
  check('日常对话默认 max_tokens 已放宽（600 → 1200）',
    /max_tokens:\s*opts\.maxTokens\s*\?\?\s*1200/.test(ds));
  check('不再残留 600 的日常对话上限',
    !/max_tokens:\s*opts\.maxTokens\s*\?\?\s*600\b/.test(ds));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);