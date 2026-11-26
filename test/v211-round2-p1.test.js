/**
 * test/v211-round2-p1.test.js
 *
 * v2.1.1 二轮全仓复审 P1 回归门禁（R2-P1-1 ~ R2-P1-4 安全与沙盒边界，后续分批追加）：
 *   1. R2-P1-1: 结构操作逐段校验祖先目录 symlink，拦截沙盒内嵌软链穿透
 *   2. R2-P1-2: 端点 origin 变更强制解绑/拒绝复用旧凭据，stt:set-config 校验端点合法性
 *   3. R2-P1-3: plain:v1:（含 -/_/.）与 URL userinfo 脱敏 + AuditLog/ObservationLog 内存落盘同口径脱敏
 *   4. R2-P1-4: vision:capture 校验 picker 打开态与发送者、pickCaptureSource 多屏失配拒返回 null、cropRect 钳位与 stage 尺寸校验
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

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  const ROOT = path.resolve(__dirname, '..');

  // ── R2-P1-1: 嵌套祖先目录 symlink 校验（workspace.remove / workspace.move） ──
  {
    const dir = mkTmp();
    try {
      const sandbox = path.join(dir, 'LifeSandbox');
      const impDir = path.join(sandbox, 'important');
      const impFile = path.join(impDir, 'file.txt');
      fs.mkdirSync(impDir, { recursive: true });
      fs.writeFileSync(impFile, 'important content', 'utf8');

      const fakeLinkDir = path.join(sandbox, 'link_dir');
      const linkTargetLeaf = path.join(fakeLinkDir, 'file.txt');
      const realLinkTargetLeaf = path.join(impDir, 'file.txt');

      const {
        CapabilityRegistry, PermissionPolicy, ExecutionBudget, AuditLog, createActionProposal
      } = require('../src/agent-interfaces');
      const { UserConfirmationGate } = require('../src/agent-confirmation');
      const { ControlledAgentExecutor } = require('../src/agent-executor');

      const reg = new CapabilityRegistry();
      const policy = new PermissionPolicy({
        killSwitch: false,
        allowed: ['workspace.remove', 'workspace.move']
      });
      policy.setScopeRoots('workspace.remove', [sandbox]);
      policy.setScopeRoots('workspace.move', [sandbox]);
      const budget = new ExecutionBudget({ maxActions: 10, maxWrites: 10 });
      const confirmation = new UserConfirmationGate();
      const auditLog = new AuditLog({ persist: false });
      const proposalStore = new Map();

      // 注入 fs：真实委托磁盘操作，仅把 sandbox/link_dir 伪装为指向 sandbox/important 的目录 symlink
      const fakeFs = {
        ...fs,
        lstatSync(p) {
          const norm = path.resolve(p);
          if (norm === path.resolve(fakeLinkDir)) {
            return { isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false };
          }
          if (norm === path.resolve(linkTargetLeaf)) {
            return fs.lstatSync(impFile);
          }
          return fs.lstatSync(p);
        },
        realpathSync: Object.assign(
          (p) => {
            const norm = path.resolve(p);
            if (norm === path.resolve(fakeLinkDir)) return fs.realpathSync(impDir);
            if (norm === path.resolve(linkTargetLeaf)) return fs.realpathSync(realLinkTargetLeaf);
            return fs.realpathSync(p);
          },
          {
            native: (p) => {
              const norm = path.resolve(p);
              if (norm === path.resolve(fakeLinkDir)) return fs.realpathSync.native(impDir);
              if (norm === path.resolve(linkTargetLeaf)) return fs.realpathSync.native(realLinkTargetLeaf);
              return fs.realpathSync.native(p);
            }
          }
        )
      };

      const executor = new ControlledAgentExecutor({
        policy, budget, confirmation, auditLog, proposalStore, fs: fakeFs, txnDir: dir
      });

      const pRm = createActionProposal({
        capability: 'workspace.remove',
        scope: linkTargetLeaf,
        summary: 'rm via symlink ancestor',
        reason: 'test',
        proposalSource: 'user',
        actionItems: [{ src: linkTargetLeaf }]
      });
      proposalStore.set(pRm.id, pRm);
      confirmation.confirm(pRm.id, 'approved', { status: 'proposed' });
      const rRm = executor.execute({ proposalId: pRm.id });
      check('R2-P1-1a workspace.remove 拦截沙盒内嵌套目录 symlink 穿透并保护目标文件',
        rRm.ok === false && rRm.code === 'SYMLINK_ESCAPE' && fs.readFileSync(impFile, 'utf8') === 'important content',
        rRm.code);

      const pMv = createActionProposal({
        capability: 'workspace.move',
        scope: linkTargetLeaf,
        dst: path.join(sandbox, 'moved.txt'),
        summary: 'move via symlink ancestor',
        reason: 'test',
        proposalSource: 'user'
      });
      proposalStore.set(pMv.id, pMv);
      confirmation.confirm(pMv.id, 'approved', { status: 'proposed' });
      const rMv = executor.execute({ proposalId: pMv.id });
      check('R2-P1-1b workspace.move 拦截沙盒内嵌套目录 symlink 穿透并保护目标文件',
        rMv.ok === false && rMv.code === 'SYMLINK_ESCAPE' && fs.existsSync(impFile),
        rMv.code);
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-2: connections update origin 变更拒复用旧凭据 & main.js stt:set-config ──
  {
    const dir = mkTmp();
    try {
      const connections = require('../src/connections');
      const created = connections.createConnection(dir, {
        displayName: 'Custom A',
        providerId: 'custom',
        protocol: 'openai-compatible',
        baseURL: 'https://a.example.com/v1',
        model: 'm1'
      });
      const cid = created.connection.connectionId;
      const sameOrigin = connections.updateConnection(dir, cid, { baseURL: 'https://a.example.com/v2' });
      const crossOriginNoKey = connections.updateConnection(dir, cid, { baseURL: 'https://evil.example.com/v1' });
      const baseUrlAfterRejected = connections.loadStore(dir).store.connections[0].baseURL;
      const crossOriginWithAuth = connections.updateConnection(
        dir, cid, { baseURL: 'https://b.example.com/v1' }, { allowOriginChange: true }
      );
      check('R2-P1-2a 同 origin 改路径正常放行', sameOrigin.ok === true);
      check('R2-P1-2b 跨 origin 变更未授权新凭据被拒且原 baseURL 保留',
        crossOriginNoKey.ok === false && crossOriginNoKey.error === 'CREDENTIAL_REQUIRED_ON_ORIGIN_CHANGE'
        && baseUrlAfterRejected === 'https://a.example.com/v2');
      check('R2-P1-2c 带新凭据授权跨 origin 变更允许保存',
        crossOriginWithAuth.ok === true && crossOriginWithAuth.connection.baseURL === 'https://b.example.com/v1');

      const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
      const sttSetIdx = mainSrc.indexOf("ipcGuard.handle('stt:set-config'");
      const sttSetSlice = sttSetIdx >= 0 ? mainSrc.slice(sttSetIdx, sttSetIdx + 1200) : '';
      check('R2-P1-2d main.js stt:set-config 校验端点合法性且 origin 变更未传新密钥时清除旧 STT 凭据',
        sttSetSlice.includes("require('./src/stt-transport').validateConfig")
        && sttSetSlice.includes('deleteCredential(STT_CREDENTIAL_REF'));
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-3: plain:v1: / URL userinfo / AuditLog / ObservationLog 脱敏 ──
  {
    const dir = mkTmp();
    try {
      const { redactSecrets } = require('../src/redact');
      const { AuditLog } = require('../src/agent-interfaces');
      const { ObservationLog } = require('../src/agent-observations');

      const rawPlain = 'leak plain:v1:abc-def_123.xyz== end';
      const redPlain = redactSecrets(rawPlain);
      check('R2-P1-3a redactSecrets 完整脱敏含 -/_/. 的 plain:v1: 前缀凭据不截断漏出',
        redPlain === 'leak [REDACTED] end', redPlain);

      const rawUrl = 'connect error at https://alice:s3cr3tPass@api.example.com/v1/chat';
      const redUrl = redactSecrets(rawUrl);
      check('R2-P1-3b redactSecrets 脱敏 URL userinfo 账密且保留 host',
        redUrl.includes('https://[REDACTED]:[REDACTED]@api.example.com/v1/chat') && !redUrl.includes('s3cr3tPass'),
        redUrl);

      const audit = new AuditLog({ persist: false });
      audit.append({ outcome: 'rejected', apiKey: 'sk-12345678', detail: 'bad plain:v1:abc-def_1' });
      const memAudit = audit.list()[0];
      check('R2-P1-3c AuditLog.append 入口前移脱敏并同步清洗内存 events',
        memAudit && !('apiKey' in memAudit) && memAudit.detail === 'bad [REDACTED]',
        JSON.stringify(memAudit));

      const obs = new ObservationLog({ dir });
      obs.append({
        capability: 'selfNote',
        scopeName: 'note plain:v1:secret-part_1',
        content: 'hello https://u:p@x.example.com and sk-proj-abcdefg'
      });
      const diskObs = fs.readFileSync(path.join(dir, 'agent-observations.jsonl'), 'utf8');
      check('R2-P1-3d ObservationLog.append 落盘前与内存同口径脱敏 content 与 scopeName',
        obs.events[0].scopeName === 'note [REDACTED]'
        && !obs.events[0].content.includes('sk-proj-abcdefg')
        && !diskObs.includes('u:p@') && !diskObs.includes('sk-proj-abcdefg'),
        obs.events[0].content);
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-4: vision 多屏失配 / picker 权限 / cropRect 钳位 / stage 尺寸校验 ──
  {
    const { pickCaptureSource } = require('../src/vision');
    const s1 = { display_id: '101', id: 'screen:101:0' };
    const s2 = { display_id: '202', id: 'screen:202:0' };
    const singleNoId = { display_id: '', id: 'screen:0:0' };
    check('R2-P1-4a pickCaptureSource 多屏失配返回 null（不回落 sources[0]）',
      pickCaptureSource([s1, s2], { id: 999 }) === null);
    check('R2-P1-4b pickCaptureSource 单屏无 display_id 仍放行',
      pickCaptureSource([singleNoId], { id: 101 }) === singleNoId);

    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const capIdx = mainSrc.indexOf("ipcGuard.handle('vision:capture'");
    const capSlice = capIdx >= 0 ? mainSrc.slice(capIdx, capIdx + 5000) : '';
    const stageIdx = mainSrc.indexOf("ipcGuard.handle('vision:stage'");
    const stageSlice = stageIdx >= 0 ? mainSrc.slice(stageIdx, stageIdx + 900) : '';
    check('R2-P1-4c main.js vision:capture 校验 picker 打开态与发送者、处理 display_mismatch 并钳位 cropRect',
      capSlice.includes("fail('picker_not_active')")
      && capSlice.includes("fail('display_mismatch')")
      && capSlice.includes('clampedX') && capSlice.includes('clampedY'));
    check('R2-P1-4d main.js vision:stage 校验正整数宽高边界',
      stageSlice.includes('Number.isInteger(opts.width)') && stageSlice.includes("errorType: 'bad_dimensions'"));
  }

  // ── R2-P1-5: snapshotMaxSeq 防尾部弹出后新窗消息被误标 bridge: true ──
  {
    const dir = mkTmp();
    try {
      const { Memory } = require('../src/memory');
      const mem = new Memory(dir, { windowTurns: 100, keepTail: 4 });
      for (let i = 1; i <= 4; i++) {
        mem.append('user', `u${i}`);
        mem.append('assistant', `a${i}`);
      }
      const snap = mem.windowSnapshot(); // len=8, drop=4, last=a4(msgSeq=8)
      mem.rollback(1); // 模拟 abort 弹出快照末条 a4，使 lastSnapshotMsgId 失配
      mem.append('user', 'new-win-user'); // msgSeq=9
      mem.closeWindow('第一窗总结', snap);
      const u1 = mem.data.history.find(m => m.content === 'u3');
      const newU = mem.data.history.find(m => m.content === 'new-win-user');
      check('R2-P1-5 snapshotMaxSeq 在快照末条被弹出后仍精确锚定边界，新窗消息保持 bridge=false',
        snap.snapshotMaxSeq === 8 && u1 && u1.bridge === true && newU && newU.bridge === false && newU.windowNo === 2);
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-6: pendingDreamFragments 写入改为同步落盘 this.memory.save(true) ──
  {
    const brainSrc = fs.readFileSync(path.join(ROOT, 'src', 'brain.js'), 'utf8');
    const fragIdx = brainSrc.indexOf('this.memory.data.pendingDreamFragments.push');
    const fragSlice = fragIdx >= 0 ? brainSrc.slice(fragIdx, fragIdx + 450) : '';
    check('R2-P1-6 _dreamCycle 写入 pendingDreamFragments 后调用 this.memory.save(true) 同步原子落盘',
      fragSlice.includes('this.memory.save(true)'));
  }

  // ── R2-P1-7: _restoreInternalRegulationFromArchive 滞回/孤立睡眠/allostasis 完整性 ──
  {
    const dir = mkTmp();
    try {
      const { InternalRegulationManager } = require('../src/internal-regulation');
      const { ExperiencesArchive } = require('../src/experiences-archive');
      const { Brain } = require('../src/brain');

      const reg = new InternalRegulationManager(dir);
      reg.isSleeping = true;
      reg.sleepStartTime = 1700000000000;
      const snapWithSleep = reg.createSnapshotRecord(1);
      reg.isSleeping = false;
      reg.sleepStartTime = null;
      const snapAwake = reg.createSnapshotRecord(2);
      check('R2-P1-7a createSnapshotRecord 睡眠态携带 sleepStartTime、清醒态为 null',
        snapWithSleep.payload.sleepStartTime === 1700000000000 && snapAwake.payload.sleepStartTime === null);

      const dir2 = mkTmp();
      try {
        const arch = new ExperiencesArchive(dir2);
        arch.appendRecord('internal_regulation_snapshot', 1, {
          state: { energy: 70, restPressure: 20, arousal: 55, interactionDensity: 10, cognitiveLoadProxy: 15, isSleeping: true, updatedAt: Date.now() },
          mood: { warmth: 55, stillness: 72 },
          salienceThreshold: 40,
          recentTransitionsCount: 1,
          allostasis: { lastSurprise: 2.5 }, // 缺 recentGapsMs，应被忽略保留冷启动
          timestamp: Date.now()
        });
        const b = new Brain(dir2, { apiKey: '' });
        b._restoreInternalRegulationFromArchive();
        const r2 = b.internalRegulation;
        check('R2-P1-7b 归档恢复同步 stillness 滞回、拦截无 sleepStartTime 孤立睡眠并拒绝不完整 allostasis',
          r2._moodState.stillActive === true
          && r2.isSleeping === false && r2.sleepStartTime === null
          && r2.allostasisPrior.recentGapsMs.length === 0 && r2.allostasisPrior.lastSurprise === 0);
        b.shutdown();
      } finally {
        cleanup(dir2);
      }
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-8: internalRegulation.enabled = false 跨窗切基线时 getState/getMood 返回中性基线 ──
  {
    const dir = mkTmp();
    try {
      const { InternalRegulationManager } = require('../src/internal-regulation');
      const reg = new InternalRegulationManager(dir, { enabled: true });
      reg.energy = 42;
      reg.arousal = 88;
      reg.moodWarmth = 81;
      reg.moodStillness = 25;
      reg.approachingOverload = true;
      reg.isSleeping = true;
      reg.enabled = false;
      const m = reg.getMood();
      const s = reg.getState();
      check('R2-P1-8 enabled=false 时 getMood 与 getState 返回标准中性基线且不泄漏实验态残留',
        m.warmth === 50 && m.stillness === 50
        && s.energy === 100 && s.arousal === 50 && s.approachingOverload === false && s.isSleeping === false);
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-9: SubjectState RECOVERY_UNCERTIFIED 跨重启保持阻断门禁 ──
  {
    const dir = mkTmp();
    try {
      const { SubjectState } = require('../src/subject-state');
      fs.writeFileSync(path.join(dir, 'subject-state.json'), JSON.stringify({
        schemaVersion: 1,
        values: { quiet_preference: 0, emotional_sensitivity: 0, social_initiative: 0, curiosity: 0, attachment_tendency: 0 },
        currentWindowNo: 2,
        lastArchivedWindowNo: 1,
        committedEvidenceIds: [],
        committedFingerprints: [],
        stateChanges: [],
        recoveryStatus: 'RECOVERY_UNCERTIFIED'
      }), 'utf8');
      const ss = new SubjectState(dir);
      check('R2-P1-9 RECOVERY_UNCERTIFIED 跨重启 load 后同步置 recoveryPending=true 阻断继续推进',
        ss.recoveryStatus === 'RECOVERY_UNCERTIFIED'
        && ss.recoveryPending === true
        && ss.recoveryPendingReason === 'recovery_uncertified');
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-10: SelfLedger 损坏态拦截写入与 _preserveBackupPending 延迟清零 ──
  {
    const dir = mkTmp();
    try {
      const { SelfLedger } = require('../src/self-ledger');
      const p = path.join(dir, 'self-ledger.json');
      fs.writeFileSync(p, '{bad main json', 'utf8');
      fs.writeFileSync(p + '.bak', '{bad bak json', 'utf8');
      const ledger = new SelfLedger(dir);
      const appRes = ledger.append([{ trait: 'test', polarity: 'support', reason: 'x', evidence: 'y' }]);
      const oppRes = ledger.recordOpposingEvidence('test', { quote: 'x' });
      check('R2-P1-10a 损坏态下 append 与 recordOpposingEvidence 拒写且不覆写损坏主文件与备份',
        ledger.status.ok === false && appRes === 0 && oppRes.ok === false
        && fs.readFileSync(p, 'utf8') === '{bad main json'
        && fs.readFileSync(p + '.bak', 'utf8') === '{bad bak json');

      const dir2 = mkTmp();
      try {
        const l2 = new SelfLedger(dir2);
        l2._preserveBackupPending = true;
        // 通过不存在的父目录制造原子写异常（覆盖 _writeActual 若 writeJsonAtomic 失败时不提前清零）
        const badLedger = new SelfLedger(dir2);
        badLedger.path = path.join(dir2, 'missing_parent', 'sub', 'self-ledger.json');
        badLedger._preserveBackupPending = true;
        // 即使没有目录也会递归创建，用只读/符号替身或直接替掉 writeJsonAtomic 测试：用原型路径太脆，改用文件占位父目录让 mkdir/write 失败
        const blockerFile = path.join(dir2, 'blocker');
        fs.writeFileSync(blockerFile, 'not a dir', 'utf8');
        badLedger.path = path.join(blockerFile, 'self-ledger.json');
        let threw = false;
        try { badLedger._writeActual(); } catch { threw = true; }
        check('R2-P1-10b _writeActual 写入失败时不提前清零 _preserveBackupPending',
          threw === true && badLedger._preserveBackupPending === true);
      } finally {
        cleanup(dir2);
      }
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-11: tracker stepMin 阶梯差 / Brain.flushAll 隔离 / DeferredWriter 失败重试 ──
  {
    const { ActivityTracker } = require('../src/tracker');
    const { DeferredWriter } = require('../src/deferred-writer');
    const { Brain } = require('../src/brain');

    const stepLogs = [];
    const tr = new ActivityTracker({
      internalRegulation: { updateOnActivity: (kind, d) => { if (kind === 'idle') stepLogs.push(d.stepMin); } }
    });
    tr.recordIdle(10);
    tr.recordIdle(29);
    tr.recordIdle(35);
    check('R2-P1-11a tracker.recordIdle 按 10 分钟梯级差计算 stepMin（29分计10而非19，35分计10而非15）',
      stepLogs.length === 3 && stepLogs[0] === 10 && stepLogs[1] === 10 && stepLogs[2] === 10
      && tr.lastReportedIdleMin === 30,
      JSON.stringify(stepLogs));

    const flushed = [];
    const fakeBrain = {
      memory: { flush: () => flushed.push('memory') },
      selfLedger: { flush: () => { throw new Error('boom'); } },
      subjectState: { flush: () => flushed.push('subjectState') },
      experiencesArchive: { flush: () => flushed.push('experiencesArchive') },
      statsWriter: { flush: () => flushed.push('statsWriter') }
    };
    Brain.prototype.flushAll.call(fakeBrain);
    check('R2-P1-11b Brain.flushAll 单个模块异常不阻断其余 4 个模块落盘',
      flushed.length === 4 && flushed.includes('subjectState') && flushed.includes('statsWriter'));

    let dwAttempts = 0;
    const dw = new DeferredWriter(() => {
      dwAttempts++;
      if (dwAttempts === 1) throw new Error('transient');
    }, { delayMs: 10, retryBaseMs: 25 });
    dw.markDirty();
    await new Promise((r) => setTimeout(r, 90));
    const retriedOk = (dwAttempts === 2 && dw.isDirty === false);
    dw.cancel();
    check('R2-P1-11c DeferredWriter 异步写入失败后自动退避重排并在重试成功后清零 dirty',
      retriedOk, `attempts=${dwAttempts}, dirty=${dw.isDirty}`);
  }

  // ── R2-P1-12: chat.js micState='starting' 并发与取消路径 ──
  {
    const chatSrc = fs.readFileSync(path.join(ROOT, 'chat.js'), 'utf8');
    check('R2-P1-12a chat.js renderMicState 与 syncMicState 显式覆盖 starting 态',
      chatSrc.includes("else if (micState === 'starting')")
      && chatSrc.includes("micState === 'starting' || micState === 'recording' || micState === 'transcribing'"));
    check('R2-P1-12b chat.js starting 态支持 ESC/blur/hidden 取消并立即释放 getUserMedia 音轨',
      chatSrc.includes('let micStartCancelled = false;')
      && chatSrc.includes("if (micStartCancelled || document.hidden || micState !== 'starting')")
      && chatSrc.includes("e.key === 'Escape' && micState === 'starting'"));
  }

  // ── R2-P1-13: pet.js remoteStreaming 气泡定时器清理与守卫 ──
  {
    const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
    const busyIdx = petSrc.indexOf('api.onChatBusy');
    const busySlice = busyIdx >= 0 ? petSrc.slice(busyIdx, busyIdx + 220) : '';
    check('R2-P1-13 pet.js onChatBusy 清理 bubbleTimer 且 say/hideBubble 守卫 remoteStreaming',
      busySlice.includes('clearTimeout(bubbleTimer)')
      && petSrc.includes('function say(text, ms = 3600)')
      && petSrc.includes('function hideBubble()')
      && (petSrc.match(/if \(streaming \|\| remoteStreaming\) return;/g) || []).length >= 2);
  }

  // ── R2-P1-14: provider-policy.js 放行本地 IPv6 [::1] ──
  {
    const { isLocalHost, providerFor, validateCredentialTarget } = require('../src/provider-policy');
    const v = validateCredentialTarget({ provider: 'local', baseURL: 'http://[::1]:11434/v1', credentialType: 'apiKey' });
    check('R2-P1-14 provider-policy.js isLocalHost 与校验链路放行 http://[::1]',
      isLocalHost('[::1]') === true && providerFor('http://[::1]:11434/v1') === 'local' && v.ok === true,
      v.error || '');
  }

  // ── R2-P1-15: 流式空闲超时主动 ctrl.abort() 且 <= 0 视为禁用 ──
  {
    const { createOpenAICompatibleAdapter } = require('../src/adapters/openai-compatible-adapter');
    const { DeepSeek } = require('../src/deepseek');
    const realFetch = globalThis.fetch;
    try {
      const makeSlowStreamRes = (delayMs, abortLog) => async (_url, init) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => abortLog.push(init.signal.reason && init.signal.reason.name), { once: true });
        }
        const enc = new TextEncoder();
        let step = 0;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: () => new Promise((resolve, reject) => {
                if (step > 0) return resolve({ done: true, value: undefined });
                const timer = setTimeout(() => {
                  step++;
                  resolve({ done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n') });
                }, delayMs);
                if (init && init.signal) {
                  init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
                }
              }),
              cancel: async () => {}
            })
          }
        };
      };

      // 1. OpenAI-compatible: idleTimeoutMs=0 不超时 + idleTimeoutMs=25 主动 ctrl.abort()
      const aborts1 = [];
      globalThis.fetch = makeSlowStreamRes(35, aborts1);
      const adapterNoTimeout = createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: 'sk-test', model: 'm', streamIdleTimeoutMs: 0 }, { providerId: 'generic' });
      const resOk = await adapterNoTimeout.stream([{ role: 'user', content: 'hi' }], () => {});
      check('R2-P1-15a openai-compatible-adapter streamIdleTimeoutMs=0 禁用空闲超时不误超',
        resOk && resOk.text === 'ok' && aborts1.length === 0);

      const aborts2 = [];
      globalThis.fetch = makeSlowStreamRes(120, aborts2);
      const adapterShortTimeout = createOpenAICompatibleAdapter({ baseURL: 'https://llm.example.com', apiKey: 'sk-test', model: 'm', streamIdleTimeoutMs: 25 }, { providerId: 'generic' });
      let err2 = null;
      try { await adapterShortTimeout.stream([{ role: 'user', content: 'hi' }], () => {}); } catch (e) { err2 = e; }
      check('R2-P1-15b openai-compatible-adapter 空闲超时触发主动 ctrl.abort() 并抛出 TimeoutError',
        err2 && err2.name === 'TimeoutError' && aborts2.includes('TimeoutError'),
        `${err2 && err2.name}/${err2 && err2.errorType} / aborts=${JSON.stringify(aborts2)}`);

      // 2. DeepSeek 同口径
      const aborts3 = [];
      globalThis.fetch = makeSlowStreamRes(35, aborts3);
      const dsNoTimeout = new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat', streamIdleTimeoutMs: -1 });
      const dsOk = await dsNoTimeout.stream([{ role: 'user', content: 'hi' }], () => {});
      const aborts4 = [];
      globalThis.fetch = makeSlowStreamRes(120, aborts4);
      const dsShort = new DeepSeek({ baseURL: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat', streamIdleTimeoutMs: 25 });
      let err4 = null;
      try { await dsShort.stream([{ role: 'user', content: 'hi' }], () => {}); } catch (e) { err4 = e; }
      check('R2-P1-15c DeepSeekClient streamIdleTimeoutMs<=0 禁用且超时主动 ctrl.abort()',
        dsOk && dsOk.text === 'ok' && aborts3.length === 0
        && err4 && err4.name === 'TimeoutError' && aborts4.includes('TimeoutError'));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ── R2-P1-16: AnimationController 睡眠态被戳保留 SLEEP 回落态 ──
  {
    const AnimationController = require('../src/animation-controller');
    const { ANIMATION_STATES, EYE_STATES } = require('../src/animation-state');
    let now = 1000;
    const ctrl = new AnimationController({ now: () => now, pokeDurationMs: 600 });
    ctrl.setSleeping(true, 'test_sleep');
    ctrl.poke();
    now += 200;
    ctrl.poke(); // 连戳二次仍保持 SLEEP 回落
    ctrl.computeFrame(now);
    const duringPoke = ctrl.state;
    now += 650;
    ctrl.computeFrame(now);
    check('R2-P1-16 睡眠态被戳结束后回落 SLEEP 且眼睛保持 CLOSE',
      duringPoke === ANIMATION_STATES.POKE
      && ctrl.state === ANIMATION_STATES.SLEEP
      && ctrl.eyeState === EYE_STATES.CLOSE,
      `state=${ctrl.state}, eye=${ctrl.eyeState}`);
    ctrl.destroy();
  }

  // ── R2-P1-17: pet.js startReplay() 轮询 try/catch、!taskId 复原取消按钮与 beforeunload 清理 ──
  {
    const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
    const repIdx = petSrc.indexOf('async function startReplay');
    const repSlice = repIdx >= 0 ? petSrc.slice(repIdx, repIdx + 4000) : '';
    const unloadIdx = petSrc.indexOf("window.addEventListener('beforeunload'");
    const unloadSlice = unloadIdx >= 0 ? petSrc.slice(unloadIdx, unloadIdx + 300) : '';
    check('R2-P1-17 pet.js startReplay 轮询 try/catch 保护、!taskId 复原按钮且 beforeunload 清理定时器',
      repSlice.includes('if (!taskId)')
      && repSlice.includes('if (cancelBtn) cancelBtn.disabled = true;')
      && repSlice.includes('catch (pollErr)')
      && unloadSlice.includes('clearInterval(activeReplayPollingTimer)'));
  }

  // ── R2-P1-18: self_note_state 纳入 FACTUAL_RECORD_TYPES，缺外部背书不得 CERTIFIED ──
  {
    const dir = mkTmp();
    try {
      const { ExperiencesArchive } = require('../src/experiences-archive');
      const { ArchiveIntegrityService } = require('../src/archive-integrity');
      const arch = new ExperiencesArchive(dir);
      arch.appendRecord('self_note_state', 1, {
        noteId: 'sn-1',
        verifiedEvidence: [{
          evidenceId: 'ev-sn-1',
          messageId: 'm-000001',
          trait: 'curiosity',
          direction: 1,
          quote: 'note'
        }],
        stateChanges: []
      });
      const rep = ArchiveIntegrityService.checkArchive(path.join(dir, 'experiences.jsonl'));
      check('R2-P1-18 self_note_state 无外部背书时不放行 CERTIFIED',
        rep.factualRecordCount > 0 && rep.integrity === 'uncertified',
        `factual=${rep.factualRecordCount}, integrity=${rep.integrity}`);
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-19: tools/artifact-freshness.js --strict 与 CI 配置 ──
  {
    const { spawnSync } = require('child_process');
    const tmpRoot = mkTmp();
    try {
      fs.mkdirSync(path.join(tmpRoot, 'tools'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'dist', 'win-unpacked', 'resources'), { recursive: true });
      fs.copyFileSync(
        path.join(ROOT, 'tools', 'artifact-freshness.js'),
        path.join(tmpRoot, 'tools', 'artifact-freshness.js')
      );
      fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ version: '2.1.1' }), 'utf8');
      const packedPkg = Buffer.from(JSON.stringify({ version: '2.1.0' }), 'utf8');
      const headerJson = Buffer.from(JSON.stringify({
        files: { 'package.json': { size: packedPkg.length, offset: '0' } }
      }), 'utf8');
      const pad = (4 - (headerJson.length % 4)) % 4;
      const pickleLen = 8 + headerJson.length + pad;
      const sizeBuf = Buffer.alloc(16);
      sizeBuf.writeUInt32LE(4, 0);
      sizeBuf.writeUInt32LE(pickleLen, 4);
      sizeBuf.writeUInt32LE(4 + headerJson.length + pad, 8);
      sizeBuf.writeUInt32LE(headerJson.length, 12);
      const asarBuf = Buffer.concat([sizeBuf, headerJson, Buffer.alloc(pad), packedPkg]);
      fs.writeFileSync(path.join(tmpRoot, 'dist', 'win-unpacked', 'resources', 'app.asar'), asarBuf);

      const strictRun = spawnSync(
        process.execPath,
        [path.join(tmpRoot, 'tools', 'artifact-freshness.js'), '--strict'],
        { cwd: tmpRoot, encoding: 'utf8' }
      );
      const ciYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
      check('R2-P1-19a artifact-freshness.js --strict 在产物版本失配时以非零退出失败',
        strictRun.status !== 0 && /FAIL/.test((strictRun.stderr || '') + (strictRun.stdout || '')),
        `status=${strictRun.status}`);
      check('R2-P1-19b .github/workflows/ci.yml 使用 --strict 运行 artifact-freshness',
        ciYml.includes('node tools/artifact-freshness.js --strict'));
    } finally {
      cleanup(tmpRoot);
    }
  }

  // ── R2-P1-20: readRecordsAtOffsets 兼容 windowIndex 描述符并接入 getWindowDetail ──
  {
    const dir = mkTmp();
    try {
      const { ExperiencesArchive } = require('../src/experiences-archive');
      const { ResearchIndex } = require('../src/research-index');
      const { ResearchQuery } = require('../src/research-query');
      const arch = new ExperiencesArchive(dir);
      arch.appendWindowArchive({
        windowNo: 1,
        epoch: 1,
        rawSummaryText: 'window 1 summary',
        events: [],
        observations: [],
        interpretations: [],
        segments: [{ segNo: 1, summary: 's1' }]
      });
      const archPath = path.join(dir, 'experiences.jsonl');
      const idx = new ResearchIndex(archPath);
      const q = new ResearchQuery(dir, { index: idx });
      let batchCalls = 0;
      const origBatch = idx.readRecordsAtOffsets.bind(idx);
      idx.readRecordsAtOffsets = function (entries) {
        batchCalls++;
        return origBatch(entries);
      };
      const detail = q.getWindowDetail(1);
      check('R2-P1-20 readRecordsAtOffsets 兼容无 valid 字段的 windowIndex 描述符且 getWindowDetail 走单 fd 批量读',
        batchCalls === 1 && detail && detail.windowNo === 1 && detail.segments.length === 1);
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-21: writeExportFileToDir 防非法文件名 & 子导出透传截断元数据 ──
  {
    const dir = mkTmp();
    try {
      const { writeExportFileToDir } = require('../src/research-export');
      const { ResearchService } = require('../src/research-service');
      let emptyBlocked = false, dotBlocked = false, dotdotBlocked = false;
      try { writeExportFileToDir(dir, '', 'x'); } catch (e) { emptyBlocked = /INVALID_EXPORT_FILENAME/.test(e.message); }
      try { writeExportFileToDir(dir, '.', 'x'); } catch (e) { dotBlocked = /INVALID_EXPORT_FILENAME/.test(e.message); }
      try { writeExportFileToDir(dir, '..', 'x'); } catch (e) { dotdotBlocked = /INVALID_EXPORT_FILENAME/.test(e.message); }
      check('R2-P1-21a writeExportFileToDir 拒绝空串/. /.. 非法文件名',
        emptyBlocked && dotBlocked && dotdotBlocked);

      const svc = new ResearchService(dir);
      svc.query = {
        getStateChanges: () => ({ items: [{ windowNo: 1, trait: 'curiosity', delta: 1, newValue: 1 }], total: 10050 }),
        getEvidence: () => ({ items: [{ evidenceId: 'e1', messageId: 'm1', trait: 'curiosity', direction: 1, quote: 'q' }], total: 10002 })
      };
      const outDir = path.join(dir, 'exports');
      const rSc = svc.exportData({ type: 'state_changes', format: 'json', targetDir: outDir });
      const rEv = svc.exportData({ type: 'evidence', format: 'json', targetDir: outDir });
      const rMem = svc.exportData({ type: 'state_changes', format: 'json' });
      check('R2-P1-21b state_changes 与 evidence 子导出透传 truncated/totalCount/exportedCount 且兼容内存串返回',
        rSc.truncated === true && rSc.totalCount === 10050 && rSc.exportedCount === 1
        && rEv.truncated === true && rEv.totalCount === 10002 && rEv.exportedCount === 1
        && typeof rMem === 'string');
    } finally {
      cleanup(dir);
    }
  }

  // ── R2-P1-22: docs/VERSION-HISTORY.md 补齐 v2.1.0 工程记录 ──
  {
    const vh = fs.readFileSync(path.join(ROOT, 'docs', 'VERSION-HISTORY.md'), 'utf8');
    check('R2-P1-22 docs/VERSION-HISTORY.md 顶部包含 v2.1.0 工程记录',
      vh.includes('**v2.1.0**') && vh.indexOf('**v2.1.0**') < vh.indexOf('**v2.0.0**'));
  }

  console.log(`\nv211-round2-p1: PASS=${passed}, FAIL=${failed}`);
  if (failed > 0) process.exit(1);
})();
