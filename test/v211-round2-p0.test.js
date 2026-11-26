/**
 * test/v211-round2-p0.test.js
 *
 * v2.1.1 二轮全仓复审 9 项 P0 止血回归门禁：
 *   1. P0-1: main.js vision:capture 引入 visionPicker 且对 null opts/display 判空
 *   2. P0-2: connections.js createConnection 新建 DeepSeek 官方连接不再被策略拒单
 *   3. P0-3: pet.js 切换语言不再引用未声明变量 chatTitle
 *   4. P0-4: brain-hot-swap.js 切换前预刷旧 Brain + shutdown 不误杀新 Brain 的 powerMonitorSource
 *   5. P0-5: brain.js ask/abort 并发竞态不误清 pendingUser 与不误删新消息
 *   6. P0-6: brain.js 停机后异步梦境与关窗后段不再覆写落盘 + _settleDreamOnWake 防跨睡眠周期清零
 *   7. P0-7: research-service.js 篡改归档在零窗口产出时不被 Replay 洗白为 CERTIFIED
 *   8. P0-8: archive-integrity.js 含 Legacy 前缀时仍对现代链执行哈希与序号篡改检测
 *   9. P0-9: experiences-archive.js hasWindowArchive 按 (windowNo, epoch) 联合判重，跨血脉不丢窗
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log('PASS ', name, detail ? ' ' + detail : '');
  } else {
    failed++;
    console.error('FAIL ', name, detail ? ' ' + detail : '');
  }
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  const ROOT = path.resolve(__dirname, '..');

  // ── P0-1: main.js vision:capture 引入 visionPicker 且判空 ──
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const capIdx = mainSrc.indexOf("ipcGuard.handle('vision:capture'");
  const capSlice = capIdx >= 0 ? mainSrc.slice(capIdx, capIdx + 1800) : '';
  check('P0-1a main.js vision:capture 显式引入 visionPicker',
    capSlice.includes("const visionPicker = require('./src/vision-picker-window')"));
  check('P0-1b main.js vision:capture 对 opts 与 display 做空值守卫',
    capSlice.includes("const rawOpts = (opts && typeof opts === 'object') ? opts : {}")
    && capSlice.includes("if (!display || !display.size) return fail('no_screen_source')"));

  // ── P0-2: connections.js 新建 DeepSeek 官方连接成功且命名空间隔离 ──
  {
    const dir = mkTmp('life-v211-p02-');
    try {
      const { createConnection, credentialTypeFromRef } = require('../src/connections');
      const res = createConnection(dir, {
        displayName: 'DeepSeek Official',
        providerId: 'deepseek',
        protocol: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        activeModel: 'deepseek-chat'
      });
      check('P0-2a 新建 DeepSeek 官方连接通过策略校验', res.ok === true && Boolean(res.connection), res.error || '');
      check('P0-2b 新建 DeepSeek 凭据带 deepseek- 独占命名空间并推导为 deepseek-api-key',
        res.ok && res.connection.credentialRef.startsWith('cred:deepseek-')
        && credentialTypeFromRef(res.connection.credentialRef) === 'deepseek-api-key');
    } finally {
      cleanup(dir);
    }
  }

  // ── P0-3: pet.js 切换语言不再引用裸标识符 chatTitle ──
  {
    const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
    check('P0-3 pet.js 切语言分支移除未声明的裸 if (chatTitle)',
      !petSrc.includes('if (chatTitle) chatTitle.textContent'));
  }

  // ── P0-4: 热切换先刷旧 Brain、不误杀新 Brain 的 powerMonitorSource ──
  {
    const { swapBrain } = require('../src/brain-hot-swap');
    const { Brain } = require('../src/brain');
    const order = [];
    const oldBrain = {
      flushAll: () => order.push('old.flushAll'),
      shutdown: () => order.push('old.shutdown')
    };
    const res = swapBrain({
      oldBrain,
      oldCfg: { a: 1 },
      nextCfg: { a: 2 },
      persistCfg: () => order.push('persist'),
      createCandidate: () => { order.push('createCandidate'); return { id: 'new' }; },
      bindCandidate: () => order.push('bindCandidate')
    });
    check('P0-4a swapBrain 在 createCandidate 之前预刷旧 Brain',
      res.ok && order.indexOf('old.flushAll') >= 0 && order.indexOf('old.flushAll') < order.indexOf('createCandidate'),
      order.join(' -> '));

    const dir = mkTmp('life-v211-p04-');
    try {
      let stopped = 0;
      const sharedPower = { start: () => {}, stop: () => { stopped++; } };
      const b1 = new Brain(dir, { apiKey: '' });
      const b2 = new Brain(dir, { apiKey: '' });
      b1.bindPowerMonitorSource(sharedPower);
      b2.bindPowerMonitorSource(sharedPower);
      b1.shutdown();
      check('P0-4b oldBrain.shutdown() 不误杀已移交新 Brain 的 powerMonitorSource', stopped === 0, `stopped=${stopped}`);
      b2.shutdown();
      check('P0-4c 当前持有者 newBrain.shutdown() 正常停止 powerMonitorSource', stopped === 1, `stopped=${stopped}`);
    } finally {
      cleanup(dir);
    }
  }

  // ── P0-5: ask/abort 并发竞态不误删新消息 ──
  {
    const dir = mkTmp('life-v211-p05-');
    try {
      const { Brain } = require('../src/brain');
      const b = new Brain(dir, { apiKey: 'sk-test-1234567890abcdef' });
      let resolveFirst;
      let callNo = 0;
      b.api = {
        stream: (msgs, onDelta, { signal }) => {
          callNo++;
          if (callNo === 1) {
            return new Promise((resolve) => { resolveFirst = resolve; });
          }
          return Promise.resolve({ text: '第二轮正常回复', usage: {} });
        }
      };
      const p1 = b.ask('第一句', () => {});
      await new Promise((r) => setTimeout(r, 15));
      b.abort();
      const p2 = b.ask('第二句', () => {});
      // 模拟被中止的 ask1 微任务返回空串
      resolveFirst({ text: '', usage: {} });
      let p1Aborted = false;
      try { await p1; } catch (e) { p1Aborted = (e && e.name === 'AbortError'); }
      const r2 = await p2;
      const texts = b.memory.data.history.map((m) => m.content);
      check('P0-5a 被中止的 ask1 返回空串时按 AbortError 退出', p1Aborted);
      check('P0-5b ask1 未误删 ask2 的用户消息与回复',
        r2.text === '第二轮正常回复' && texts.includes('第二句') && texts.includes('第二轮正常回复'),
        JSON.stringify(texts));
      b.shutdown();
    } finally {
      cleanup(dir);
    }
  }

  // ── P0-6: Brain 停机守卫与 _settleDreamOnWake 跨睡眠周期防清空 ──
  {
    const brainSrc = fs.readFileSync(path.join(ROOT, 'src', 'brain.js'), 'utf8');
    check('P0-6a _dreamCycle 合成后检查 shutdownRequested 与 generationId',
      brainSrc.includes('const dreamStartGen = this.generationId;')
      && brainSrc.includes('if (this.shutdownRequested || this.generationId !== dreamStartGen)'));
    check('P0-6b _settleDreamOnWake 具并发锁并校验 stillSameSleep 防跨睡眠清零',
      brainSrc.includes('if (this._settlingDreamOnWake || this.shutdownRequested) return null;')
      && brainSrc.includes('const stillSameSleep = (!reg.isSleeping) || (reg.sleepStartTime === sleepStartTime);'));
  }

  // ── P0-7: 篡改归档零窗口不被 Replay 洗白为 CERTIFIED ──
  {
    const dir = mkTmp('life-v211-p07-');
    try {
      const { ExperiencesArchive } = require('../src/experiences-archive');
      const { ResearchService } = require('../src/research-service');
      const arch = new ExperiencesArchive(dir);
      arch.appendRecord('diagnostic', 1, { msg: 'orig' });
      // 篡改 payload 使 recordHash 失配
      const archPath = path.join(dir, 'experiences.jsonl');
      const raw = fs.readFileSync(archPath, 'utf8').replace('orig', 'tampered');
      fs.writeFileSync(archPath, raw, 'utf8');

      const svc = new ResearchService(dir);
      const { taskId } = svc.startReplayTask({});
      let status = null;
      for (let i = 0; i < 40; i++) {
        status = svc.getReplayTaskStatus(taskId);
        if (status && (status.status === 'completed' || status.status === 'failed')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      check('P0-7 篡改归档在零窗口产出时保持 invalid 而非被洗白为 certified',
        status && status.result && status.result.integrity !== 'certified',
        status && status.result ? `integrity=${status.result.integrity}` : 'no result');
    } finally {
      cleanup(dir);
    }
  }

  // ── P0-8: 含 Legacy 前缀时仍检测现代链哈希篡改 ──
  {
    const dir = mkTmp('life-v211-p08-');
    try {
      const { ExperiencesArchive } = require('../src/experiences-archive');
      const { ArchiveIntegrityService } = require('../src/archive-integrity');
      const arch = new ExperiencesArchive(dir);
      arch.appendRecord('diagnostic', 1, { msg: 'm1' });
      arch.appendRecord('diagnostic', 2, { msg: 'm2' });
      const archPath = path.join(dir, 'experiences.jsonl');
      const lines = fs.readFileSync(archPath, 'utf8').trim().split('\n');
      const legacyHead = JSON.stringify({
        type: 'window_archive',
        windowNo: 0,
        rawSummaryText: 'legacy',
        createdAt: '2026-01-01T00:00:00.000Z'
      });
      // 前置 1 条 Legacy 并篡改第 2 条现代记录
      lines[1] = lines[1].replace('m2', 'm2_hacked');
      fs.writeFileSync(archPath, [legacyHead, ...lines].join('\n') + '\n', 'utf8');

      const rep = ArchiveIntegrityService.checkArchive(archPath);
      check('P0-8 含 Legacy 前缀时现代记录篡改仍被判为 invalid/mismatch',
        rep.hash_integrity === 'mismatch' && rep.integrity === 'invalid',
        `hash=${rep.hash_integrity}, integrity=${rep.integrity}`);
    } finally {
      cleanup(dir);
    }
  }

  // ── P0-9: hasWindowArchive 按 (windowNo, epoch) 联合判重 ──
  {
    const dir = mkTmp('life-v211-p09-');
    try {
      const { ExperiencesArchive } = require('../src/experiences-archive');
      const arch = new ExperiencesArchive(dir);
      arch.appendWindowArchive({ windowNo: 1, epoch: 1, rawSummaryText: 'epoch1 summary' });
      check('P0-9a 同 epoch 判重命中', arch.hasWindowArchive(1, 1) === true);
      check('P0-9b 新 epoch 不被旧血脉同名窗口拦截', arch.hasWindowArchive(1, 2) === false);
      const ok2 = arch.appendWindowArchive({ windowNo: 1, epoch: 2, rawSummaryText: 'epoch2 summary' });
      const recs = arch.readAll().filter((r) => (r.recordType || r.type) === 'window_summary' || (r.recordType || r.type) === 'window_archive');
      check('P0-9c memory.reset() 后新血脉第 1 窗成功落盘不丢经历', ok2 === true && recs.length === 2, `count=${recs.length}`);
    } finally {
      cleanup(dir);
    }
  }

  console.log(`\nv211-round2-p0: PASS=${passed}, FAIL=${failed}`);
  if (failed > 0) process.exit(1);
})();
