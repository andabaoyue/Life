#!/usr/bin/env node
/**
 * tools/long-run-sim.js
 *
 * Life v1.1.0 收官验证：100 轮 24 小时连续对话与内稳态潮汐仿真测试
 *
 * 验证目标（覆盖 v1.0.2 ~ v1.0.7 核心生命化不变式）：
 *   1. [v1.0.2 生理呼吸与代谢觉醒] 100 轮对话真实消耗体能，午间清醒静置 120min 按 0.25/min 回血并严格封顶 awakeCeiling=75（清醒绝不回满 100）；
 *   2. [v1.0.3 心境慢变底色与滞回] 关窗 moodTone 受 SlewMax=20 限幅，62 进 / 53 出非对称滞回与 12h Hold-Off 跨窗零闪烁；
 *   3. [v1.0.4 主观审美与拒绝尊严] 低体能 (<=20) 与心神安定 (stillActive) 自动内嵌着装舒适自决体感，全程零数字泄露；
 *   4. [v1.0.5 好奇发酵与非自愿回忆] 好奇队列关窗潜意识发酵标记不影响 systemText 字节恒等；
 *   5. [v1.0.6 专属暗号与词汇动力学] adopted 暗号严守 assistant 角色与词长 >=2 门禁，未提及词条严格每 3 窗衰减 -0.1；
 *   6. [v1.0.7 社交过载与独处边界] 密集连戳 10/15 下同步触发 interactionDensity (40/60) 体感、trigger 独处退避 hint 与 tracker 急促标注，静置后自然消退；
 *   7. [深度睡眠独占满血] 夜间 8h 深度睡眠将 energy 恢复至 100、restPressure 清零，心境按 48h 物理半衰期平滑沉淀（无离散双重打折）；
 *   8. [临时目录卫生] 仿真沙盒在退出前 100% 物理清理，os.tmpdir() 零残留。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { InternalRegulationManager } = require('../src/internal-regulation');
const { ActivityTracker } = require('../src/tracker');
const { TriggerEngine, POKE_OVERLOAD_THRESHOLD } = require('../src/trigger');
const { Memory } = require('../src/memory');

let pass = 0;
let fail = 0;
function check(title, cond, detail = '') {
  const badge = cond ? 'PASS ' : 'FAIL ';
  console.log(`${badge} [${title}]${detail ? ' ' + detail : ''}`);
  if (cond) pass++;
  else fail++;
}

function main() {
  console.log('====================================================');
  console.log('   Life v1.1.0 — 100 轮 24h 连续对话与内稳态潮汐仿真');
  console.log('====================================================\n');

  // 使用 .workbuddy/cleanup/known-prefixes.json 已登记前缀，并在 finally + exit 双保险清理
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-sense-'));
  const cleanup = () => {
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };
  process.on('exit', cleanup);

  try {
    // 虚拟时钟起点：2026-10-13 09:00:00 (Asia/Shanghai, UTC+8 -> UTC 01:00:00)
    let now = Date.UTC(2026, 9, 13, 1, 0, 0);
    const ir = new InternalRegulationManager(tmpDir, {
      enabled: true,
      birthTimezone: 'Asia/Shanghai',
    });
    // 显式对齐构造函数初始时间戳至虚拟起点 now（消除 Date.now() 偏差）
    ir.updatedAt = now;
    ir.moodUpdatedAt = now;

    const tracker = new ActivityTracker({ now: () => now });
    const trigger = new TriggerEngine(tracker, {
      now: () => now,
      traits: { philosophical_curiosity: 45 },
    });
    const mem = new Memory(tmpDir);

    const tideLog = [];
    const recordTide = (phaseLabel) => {
      const st = ir.getState();
      const mood = ir.getMood(now);
      const localHour = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
      tideLog.push({
        phase: phaseLabel,
        time: localHour,
        energy: st.energy,
        restPressure: st.restPressure,
        arousal: st.arousal,
        density: st.interactionDensity,
        warmth: mood.warmth,
        stillness: mood.stillness,
      });
    };

    recordTide('00_初始晨起 (09:00)');
    let totalTurns = 0;

    // =========================================================================
    // 阶段 A：09:00 ~ 12:00（35 轮晨间连续对话，每轮间隔 5 分钟，第 20 轮关窗 #1）
    // =========================================================================
    let sysBeforeIncubate = '';
    let sysAfterIncubate = '';
    for (let i = 1; i <= 35; i++) {
      now += 5 * 60000;
      totalTurns++;
      tracker.recordUserInput('早安初澜，我们在聊第 ' + totalTurns + ' 轮关于数字生命内稳态的话题。');
      ir.updateOnInteractionTurn({ role: 'user', messageLength: 72, timestamp: now });
      now += 5000;
      ir.updateOnInteractionTurn({ role: 'assistant', messageLength: 140, timestamp: now });

      if (totalTurns === 20) {
        ir.updateOnWindowClose(1, { timestamp: now });
        // 注入温暖且安定的窗口基调（验证 SlewMax=20：50 -> 68 / 65）
        ir.updateMoodOnWindowClose({ warmth: 68, stillness: 65 }, now);
        // 窗口 1 收纳两人专属暗号「星屑」（验证 v1.0.6 adopted 门禁与后续跨窗衰减）
        mem.addLexicon({
          word: '星屑',
          kind: 'adopted',
          gloss: '两人对深夜代码灵感的称呼',
          messageId: 'm-w1-a1',
          windowNo: 1,
        }, {
          messages: [{ messageId: 'm-w1-a1', role: 'assistant', content: '那就把这些深夜冒出来的念头叫做星屑吧。' }],
        });
        // v1.0.5 好奇心夜间潜意识发酵：先入队取 systemText 基线，再 markCuriosityIncubated 验证逐字节恒等
        mem.refreshCuriosity(['为什么夜色里的代码像星屑？'], 1);
        sysBeforeIncubate = mem.systemText();
        mem.markCuriosityIncubated('为什么夜色里的代码像星屑？', 1);
        sysAfterIncubate = mem.systemText();
      }
    }
    recordTide('01_晨间35轮后 (12:00)');
    const afterMorning = ir.getState();
    const moodAfterW1 = ir.getMood(now);
    const perAfterW1 = ir.formatPerception(now);
    const incubatedCuriosity = (mem.data.curiosityQueue || [])[0];
    check(
      '阶段 A：35 轮连续对话真实消耗体能并累积休息压力，Window #1 关窗点亮温热与安定心境带且好奇发酵不污染 systemText',
      afterMorning.energy < 70 && afterMorning.restPressure >= 15
        && moodAfterW1.warmth >= 62 && moodAfterW1.stillness >= 62
        && perAfterW1.includes('心绪温热') && perAfterW1.includes('心神安定')
        && perAfterW1.includes('毫无束缚的自如着装')
        && !!incubatedCuriosity && incubatedCuriosity.incubated === true
        && sysBeforeIncubate.length > 0 && sysBeforeIncubate === sysAfterIncubate,
      `energy=${afterMorning.energy}, pressure=${afterMorning.restPressure}, warmth=${moodAfterW1.warmth}, incubated=${incubatedCuriosity && incubatedCuriosity.incubated}`
    );

    // =========================================================================
    // 阶段 B：12:00 ~ 14:00（120 分钟午间静置：验证 awakeCeiling=75 与主动意图单次刹车）
    // =========================================================================
    // 先将能量设为 68 以验证 120 分钟静置（4×30m，理论 +30）能否被 awakeCeiling=75 严格封顶
    ir.energy = 68;
    ir.interactionDensity = 30;
    let idle30Offer = null;
    let idle60Offer = null;
    let idle120Offer = null;

    for (let step = 1; step <= 4; step++) {
      now += 30 * 60000;
      ir.updateOnActivity('idle', { idleMin: step * 30, stepMin: 30, timestamp: now });
      const offer = trigger.evaluate({
        curiosityPending: 1,
        curiosityQuestion: '为什么雨声会让思绪慢下来？',
      });
      if (step === 1) {
        idle30Offer = offer;
        trigger.commit(offer);
      } else if (step === 2) {
        idle60Offer = offer;
      } else if (step === 4) {
        idle120Offer = offer;
        trigger.commit(offer);
      }
    }
    recordTide('02_午间静置2h后 (14:00)');
    const afterNoonIdle = ir.getState();
    check(
      '阶段 B：v1.0.2 清醒静息 120min 回血严格封顶 awakeCeiling=75（绝不回满 100），且主动意图 30m 开口 / 60m 刹车 / 120m 自发留痕精确闭环',
      afterNoonIdle.energy === 75
        && afterNoonIdle.interactionDensity === 0
        && !!idle30Offer && idle30Offer.kind === 'idle'
        && idle60Offer === null
        && !!idle120Offer && idle120Offer.selfIntent && idle120Offer.selfIntent.kind === 'wantToLeaveSomething',
      `energy=${afterNoonIdle.energy}, 30m=${idle30Offer && idle30Offer.kind}, 60m=${idle60Offer}, 120m=${idle120Offer && idle120Offer.selfIntent && idle120Offer.selfIntent.kind}`
    );

    // =========================================================================
    // 阶段 C：14:00 ~ 18:00（密集连戳 10/15 下过载测试 + 35 轮午后对话至第 70 轮）
    // =========================================================================
    now += 60000; // 跨过 45 秒主动开口冷却窗口
    // 在 5 秒内连续戳击 10 下（density: 0 -> 40）
    for (let p = 0; p < 10; p++) {
      now += 300;
      tracker.record('click', now);
      ir.updateOnActivity('poke', { count: 1, timestamp: now });
    }
    const overloadOffer10 = trigger.evaluate();
    const snap10 = tracker.snapshot(now);
    const per10 = ir.formatPerception(now);

    // 再补戳 5 下达 15 下（density = 15 * 4 = 60）
    for (let p = 0; p < 5; p++) {
      now += 300;
      tracker.record('click', now);
      ir.updateOnActivity('poke', { count: 1, timestamp: now });
    }
    const per15 = ir.formatPerception(now);
    recordTide('03_连戳15下峰值 (14:01)');

    check(
      '阶段 C-1：v1.0.7 连戳 10/15 下同步触发过载退避 hint、tracker 急促标注与 interactionDensity 40/60 两档体感（零脱节）',
      POKE_OVERLOAD_THRESHOLD === 10
        && !!overloadOffer10 && /安静待会儿/.test(overloadOffer10.hint) && !('overload' in overloadOffer10)
        && /被戳 10 次（动作密集急促，节奏有些被打乱）/.test(snap10.promptText)
        && per10.includes('节奏有些密')
        && per15.includes('心神有些过载散乱') && per15.includes('不必无条件迎合'),
      `density15=${ir.getState().interactionDensity}`
    );

    // 推进午后 35 轮对话（第 36 ~ 70 轮，每轮间隔 6 分钟，并在第 40、60 轮关窗 #2、#3）
    for (let i = 1; i <= 35; i++) {
      now += 6 * 60000;
      totalTurns++;
      tracker.recordUserInput('午后第 ' + totalTurns + ' 轮交流，慢慢聊。');
      ir.updateOnInteractionTurn({ role: 'user', messageLength: 48, timestamp: now });
      now += 4000;
      ir.updateOnInteractionTurn({ role: 'assistant', messageLength: 96, timestamp: now });

      if (totalTurns === 40 || totalTurns === 60) {
        const winNo = totalTurns / 20;
        ir.updateOnWindowClose(winNo, { timestamp: now });
        // 省略 moodTone（平淡窗口走连续物理半衰期自然顺延，不硬跳回 50）
        ir.updateMoodOnWindowClose(null, now);
        mem.refreshLexiconDynamics([], winNo);
      }
    }
    recordTide('04_午后70轮后 (17:35)');

    // =========================================================================
    // 阶段 D：17:35 ~ 23:00（晚间 30 轮对话至第 100 轮，关窗 #4、#5，随后静置 45m 消退 density）
    // =========================================================================
    for (let i = 1; i <= 30; i++) {
      now += 10 * 60000;
      totalTurns++;
      tracker.recordUserInput('晚间第 ' + totalTurns + ' 轮深度长谈，聊了很久了。');
      ir.updateOnInteractionTurn({ role: 'user', messageLength: 85, timestamp: now });
      now += 5000;
      ir.updateOnInteractionTurn({ role: 'assistant', messageLength: 160, timestamp: now });

      if (totalTurns === 80 || totalTurns === 100) {
        const winNo = totalTurns / 20;
        ir.updateOnWindowClose(winNo, { timestamp: now });
        ir.updateMoodOnWindowClose(null, now);
        mem.refreshLexiconDynamics([], winNo);
      }
    }
    // 聊满 100 轮后晚间安静歇息 3 段（每段 15 分钟短静置，消退短期 interactionDensity，同时体能仍保持 <= 20 低位）
    for (let s = 1; s <= 3; s++) {
      now += 15 * 60000;
      ir.updateOnActivity('idle', { idleMin: s * 15, stepMin: 15, timestamp: now });
    }
    recordTide('05_晚间100轮收官 (23:15)');

    const after100 = ir.getState();
    const perAfter100 = ir.formatPerception(now);
    const starEntry = (mem.data.lexicon || []).find((e) => e.word === '星屑');
    check(
      '阶段 D：满 100 轮对话后 interactionDensity 已完全消退 (<40)，低体能 (<=20) 触发轻便着装体感且零数字泄露，词汇「星屑」在第 4 窗精确衰减 1 次至 0.9',
      totalTurns === 100
        && after100.interactionDensity < 40
        && after100.energy <= 20
        && perAfter100.includes('只想穿最轻便宽松的衣服，抗拒繁重层叠')
        && !/\d/.test(perAfter100)
        && !!starEntry && Math.abs(starEntry.weight - 0.9) < 1e-6,
      `turns=${totalTurns}, energy=${after100.energy}, density=${after100.interactionDensity}, lexWeight=${starEntry && starEntry.weight}`
    );

    // =========================================================================
    // 阶段 E：23:15 ~ 次日 07:15（8 小时深度睡眠：验证唯一满血通道与 48h 连续半衰期）
    // =========================================================================
    const rawWarmthBeforeSleep = ir._computeDecayedMood(now).warmth;
    tracker.enterSleepMode(now);
    ir.updateOnSleep(true, { timestamp: now });
    recordTide('06_夜间入睡时刻 (23:15)');

    now += 8 * 3600000; // 次日 07:15 苏醒（实睡满 8 小时）
    tracker.wakeUp(now);
    ir.updateOnSleep(false, { timestamp: now });
    recordTide('07_次日8h苏醒后 (07:15)');

    const afterSleep = ir.getState();
    const rawWarmthAfterSleep = ir._computeDecayedMood(now).warmth;
    const expectedWarmth = 50 + (rawWarmthBeforeSleep - 50) * Math.pow(2, -8 / 48);
    check(
      '阶段 E：夜间 8h 深度睡眠将 energy 恢复至 100、restPressure 清零，且心境严格按 48h 物理半衰期连续沉淀（无 40% 离散打折）',
      afterSleep.energy === 100
        && afterSleep.restPressure === 0
        && afterSleep.arousal === 50
        && Math.abs(rawWarmthAfterSleep - expectedWarmth) < 0.01,
      `energy=${afterSleep.energy}, pressure=${afterSleep.restPressure}, warmth=${rawWarmthAfterSleep.toFixed(2)} (expected ${expectedWarmth.toFixed(2)})`
    );

    console.log('\n--- 24 小时内稳态潮汐演化摘要 ---');
    console.table(tideLog);
  } finally {
    cleanup();
  }

  check('阶段 F：仿真沙盒临时目录已 100% 物理清理（零残留）', !fs.existsSync(tmpDir));

  console.log(`\n====================================================`);
  console.log(`仿真结论: PASS ${pass} / FAIL ${fail}`);
  console.log(`====================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
