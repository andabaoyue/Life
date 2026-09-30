/**
 * test/creative-ipc-p3.test.js — Life v0.9.9 Phase 3: Creative IPC + UI 专项回归
 *
 * 集成形态：renderer-facing IPC（真实 ipc-guard sender 校验）→ main handler →
 * Creative Core →（Provider Registry 注册的）mocked Adapter。
 * 覆盖：IPC 安全、输入验证、Project、Generation/Streaming/Abort、并发门禁、
 * 项目切换不串轨、Recovery、出站数据安全边界、Subject 零写入、UI 文案隔离。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const { createIpcGuard } = require('../src/ipc-guard');
const { registerCreativeIpc, validateContext, MAX_CONTENT_CHARS } = require('../src/creative-ipc');
const { createCreativeStore } = require('../src/creative/creative-store');
const { createCreativeSession, CREATIVE_SYSTEM_PROMPT } = require('../src/creative/creative-session');
const { registerProvider } = require('../src/provider-registry');
const { PERSONA } = require('../src/persona');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await wait(10);
  }
  return cond();
}

function makeHarness({ dataDir, skillsDir }) {
  const appDir = ROOT;
  const mainFrame = { url: pathToFileURL(path.join(appDir, 'index.html')).href };
  const webContents = {
    mainFrame,
    sent: [],
    send(ch, p) { this.sent.push([ch, p]); }
  };
  const win = { isDestroyed: () => false, webContents };
  const handlers = new Map();
  const fakeIpcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set('on:' + ch, fn)
  };
  const guard = createIpcGuard({ ipcMain: fakeIpcMain, getMainWindow: () => win, appDir });
  return {
    guard, webContents, handlers,
    trusted: () => ({ sender: webContents, senderFrame: mainFrame }),
    invoke: (ch, event, ...args) => handlers.get(ch)(event, ...args)
  };
}

async function run() {
  const dataDir = tmpDir('creative-ipc-');
  const skillsDir = path.join(dataDir, 'creative', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  const store = createCreativeStore(dataDir);
  let session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-mock', apiKey: 'sk-tes...-000', baseURL: 'https://internal.example/v1', model: 'm' } });
  const h = makeHarness({ dataDir, skillsDir });
  registerCreativeIpc(h.guard, {
    getStore: () => store,
    getSession: () => session,
    getWebContents: () => h.webContents,
    skillsDir,
    dataRoot: dataDir
  });

  /* ================= S. IPC Security（真实 guard 防线） ================= */
  {
    let e1 = null;
    try { await h.invoke('creative:list-projects', { sender: {}, senderFrame: h.webContents.mainFrame }); } catch (e) { e1 = e; }
    check('S1 非法 sender 被拒绝（UNTRUSTED_RENDERER）', e1 && e1.message === 'UNTRUSTED_RENDERER');

    let e2 = null;
    try { await h.invoke('creative:list-projects', { sender: h.webContents, senderFrame: { url: h.webContents.mainFrame.url } }); } catch (e) { e2 = e; }
    check('S2 child frame 被拒绝', e2 && e2.message === 'UNTRUSTED_RENDERER');

    let e3 = null;
    try {
      await h.invoke('creative:list-projects', { sender: h.webContents, senderFrame: { url: 'https://evil.example/x' } });
    } catch (e) { e3 = e; }
    check('S3 非法 URL/origin 被拒绝', e3 && e3.message === 'UNTRUSTED_RENDERER');

    const r4 = await h.invoke('creative:create-project', h.trusted(), '../pwn');
    check('S4 非法 projectId fail-closed', r4.ok === false && r4.code === 'CREATIVE_PROJECT_ID_INVALID');

    const r5 = await h.invoke('creative:load-skill', h.trusted(), '../../etc/passwd.md');
    check('S5 非法 skillName fail-closed', r5.ok === false && r5.code === 'CREATIVE_SKILL_NAME_INVALID');

    const r6 = await h.invoke('creative:send', h.trusted(), { projectId: 'default', content: 12345 });
    check('S6 非字符串 content 拒绝', r6.ok === false && r6.code === 'CREATIVE_VALIDATION_ERROR');

    const r7 = await h.invoke('creative:send', h.trusted(), { projectId: 'default', content: 'x'.repeat(MAX_CONTENT_CHARS + 1) });
    check('S7 超限 content 拒绝', r7.ok === false && r7.code === 'CREATIVE_VALIDATION_ERROR');

    const badCtx = { fn: () => {}, __proto__: { x: 1 } };
    const r8 = await h.invoke('creative:update-context', h.trusted(), 'default', badCtx);
    const r8b = await h.invoke('creative:update-context', h.trusted(), 'default', { when: new Date() });
    const r8c = await h.invoke('creative:update-context', h.trusted(), 'default', JSON.parse('{"__proto__":{"polluted":true}}'));
    check('S8 恶意 context payload 拒绝（函数/Date/原型键）',
      r8.ok === false && r8.code === 'CREATIVE_VALIDATION_ERROR' &&
      r8b.ok === false && r8c.ok === false);

    // 正文不做关键词过滤：含「初澜」的 content 必须被接受（未 trim）
    const adapterK = { complete: async (messages) => ({ text: 'ok', usage: null, observedModel: 'm', attempts: 1 }), stream: async () => ({ text: 'ok' }), validateConfig: () => ({ ok: true }), capabilities: () => ({}), normalizeError: (e) => e, usage: () => null };
    registerProvider({ providerId: 'creative-ipc-kw', adapterFactory: () => adapterK, override: true });
    await h.invoke('creative:create-project', h.trusted(), 'kw');
    session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-kw', apiKey: 'sk-tes...-000', model: 'm' } });
    const r9 = await h.invoke('creative:send', h.trusted(), { projectId: 'kw', content: '  初澜 GPT娘 persona  ' });
    await waitFor(() => h.webContents.sent.some(([ch]) => ch === 'creative:completed'));
    const kwRec = store.readHistory('kw').find((r) => r.role === 'user');
    check('S9 正文不做关键词过滤、不 trim（含敏感词与空格原文入史）',
      r9.ok === true && kwRec && kwRec.content === '  初澜 GPT娘 persona  ');
  }

  /* ================= G. Generation 集成（IPC→Core→Adapter） ================= */
  {
    const captured = [];
    const adapter = {
      complete: async (messages) => {
        captured.push(messages.map((m) => ({ ...m })));
        return { text: '创作草稿', usage: null, observedModel: 'm', attempts: 1 };
      },
      stream: async (messages, onDelta) => {
        captured.push(messages.map((m) => ({ ...m })));
        onDelta('第'); onDelta('一段');
        return { text: '第一段', usage: null, observedModel: 'm', attempts: 1 };
      },
      validateConfig: () => ({ ok: true }),
      capabilities: () => ({ streaming: true }),
      normalizeError: (e) => e,
      usage: () => null
    };
    registerProvider({ providerId: 'creative-ipc-gen', adapterFactory: () => adapter, override: true });
    session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-gen', apiKey: 'sk-tes...-000', model: 'm' } });

    await h.invoke('creative:create-project', h.trusted(), 'gen');
    const before = h.webContents.sent.length;
    const r1 = await h.invoke('creative:send', h.trusted(), { projectId: 'gen', content: '写一段开头' });
    await waitFor(() => h.webContents.sent.slice(before).some(([ch]) => ch === 'creative:completed'));
    const evs = h.webContents.sent.slice(before);
    check('G1 completed 事件到达且 record 状态 completed',
      r1.ok === true && evs.some(([ch, p]) => ch === 'creative:completed' && p.record.status === 'completed'));
    check('G2 流式 delta 事件按序到达 renderer',
      evs.filter(([ch]) => ch === 'creative:delta').map(([, p]) => p.text).join('') === '第一段');
    check('G3 集成链路 messages[0] === CREATIVE_SYSTEM_PROMPT（真实参数传递）',
      captured.length > 0 && captured[0][0].role === 'system' && captured[0][0].content === CREATIVE_SYSTEM_PROMPT);

    // Persona 隔离证明：persona 模块被替换为假标记也不改变 Creative messages
    const personaPath = require.resolve('../src/persona');
    const saved = require.cache[personaPath];
    require.cache[personaPath] = { id: personaPath, filename: personaPath, loaded: true, exports: { PERSONA: 'FAKE-PERSONA-MARKER-XYZ' } };
    try {
      const freshSession = createCreativeSession({ store, cfg: { provider: 'creative-ipc-gen', apiKey: 'sk-tes...-000', model: 'm' } });
      await h.invoke('creative:create-project', h.trusted(), 'iso');
      session = freshSession;
      await h.invoke('creative:send', h.trusted(), { projectId: 'iso', content: 'hi' });
      await waitFor(() => h.webContents.sent.some(([ch, p]) => ch === 'creative:completed' && p.projectId === 'iso'));
      const last = captured[captured.length - 1];
      check('G4 修改 PERSONA 不改变 Creative messages（无偷塞标记）',
        last.every((m) => !String(m.content).includes('FAKE-PERSONA-MARKER-XYZ')) &&
        last[0].content === CREATIVE_SYSTEM_PROMPT);
    } finally {
      if (saved) require.cache[personaPath] = saved; else delete require.cache[personaPath];
    }
  }

  /* ================= A. Abort / E. Provider error（partial 保留） ================= */
  {
    const abortErr = new Error('aborted'); abortErr.name = 'AbortError';
    const adapterA = {
      complete: async () => { throw abortErr; },
      stream: async (messages, onDelta) => {
        onDelta('已经');
        onDelta('收到');
        throw abortErr; // 收到 partial 后中断
        return { text: 'never' };
      },
      validateConfig: () => ({ ok: true }), capabilities: () => ({ streaming: true }), normalizeError: (e) => e, usage: () => null
    };
    registerProvider({ providerId: 'creative-ipc-abort', adapterFactory: () => adapterA, override: true });
    session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-abort', apiKey: 'sk-tes...-000', model: 'm' } });
    await h.invoke('creative:create-project', h.trusted(), 'ab');
    const before = h.webContents.sent.length;
    await h.invoke('creative:send', h.trusted(), { projectId: 'ab', content: 'x', });
    // 需要 onDelta 走 stream：IPC send 不带 onDelta 走 complete —— 改用直接 stream 路径：
    // IPC 层 send 不暴露 onDelta 参数，streaming 由 session 内部按需选择；这里改测 complete 失败路径 + 直接 session abort。
    await waitFor(() => h.webContents.sent.slice(before).some(([ch]) => ch === 'creative:aborted' || ch === 'creative:error'));
    const abRec = store.readHistory('ab').filter((r) => r.role === 'assistant').pop();
    check('A1 中止后 partial 真实保留（content=已收原文）且 finishReason=abort',
      abRec && abRec.content === '已经收到' && abRec.finishReason === 'abort');

    // 显式 abort：慢 adapter + creative:abort
    let release;
    const gate = new Promise((r) => { release = r; });
    const adapterSlow = {
      complete: async (messages, opts = {}) => {
        await new Promise((_, reject) => {
          if (opts.signal) opts.signal.addEventListener('abort', () => reject(abortErr), { once: true });
        });
        return { text: 'never' };
      },
      stream: async (messages, onDelta, opts = {}) => {
        onDelta('部分');
        await new Promise((_, reject) => {
          if (opts.signal) opts.signal.addEventListener('abort', () => reject(abortErr), { once: true });
        });
        return { text: 'never' };
      },
      validateConfig: () => ({ ok: true }), capabilities: () => ({ streaming: true }), normalizeError: (e) => e, usage: () => null
    };
    registerProvider({ providerId: 'creative-ipc-slow', adapterFactory: () => adapterSlow, override: true });
    session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-slow', apiKey: 'sk-tes...-000', model: 'm' } });
    await h.invoke('creative:create-project', h.trusted(), 'slow');
    const before2 = h.webContents.sent.length;
    const rs = await h.invoke('creative:send', h.trusted(), { projectId: 'slow', content: 'x' });
    await wait(30);
    const rAb = await h.invoke('creative:abort', h.trusted(), 'slow');
    await waitFor(() => h.webContents.sent.slice(before2).some(([ch]) => ch === 'creative:aborted'));
    const slowRec = store.readHistory('slow').filter((r) => r.role === 'assistant').pop();
    check('A2 creative:abort 全链传递（IPC→Session→Adapter）且 status=aborted/finishReason=abort',
      rs.ok === true && rAb.ok === true && slowRec && slowRec.status === 'aborted' && slowRec.finishReason === 'abort');
    check('A3 aborted 事件携带 safeRecord（partial 如实）',
      h.webContents.sent.slice(before2).some(([ch, p]) => ch === 'creative:aborted' && p.record.status === 'aborted'));
    release();

    // provider error：错误归一化后出站
    const netErr = new Error('boom ' + 'ghp_' + 'FAKESECRETtokenvalue1234567890');
    const adapterErr = {
      complete: async () => { throw netErr; },
      stream: async (messages, onDelta) => { onDelta('半'); throw netErr; },
      validateConfig: () => ({ ok: true }), capabilities: () => ({ streaming: true }), normalizeError: (e) => e, usage: () => null
    };
    registerProvider({ providerId: 'creative-ipc-err', adapterFactory: () => adapterErr, override: true });
    session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-err', apiKey: 'sk-tes...-000', model: 'm' } });
    await h.invoke('creative:create-project', h.trusted(), 'pe');
    const before3 = h.webContents.sent.length;
    await h.invoke('creative:send', h.trusted(), { projectId: 'pe', content: 'x' });
    await waitFor(() => h.webContents.sent.slice(before3).some(([ch]) => ch === 'creative:error'));
    const errEv = h.webContents.sent.slice(before3).find(([ch]) => ch === 'creative:error');
    const peRec = store.readHistory('pe').filter((r) => r.role === 'assistant').pop();
    check('E1 provider error -> creative:error 事件 + record status=error + partial 保留',
      errEv && errEv[1].code === 'CREATIVE_PROVIDER_ERROR' && peRec && peRec.status === 'error' && peRec.finishReason === 'error');
  }

  /* ================= C. Concurrency 门禁 ================= */
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const adapterGate = {
      complete: async () => { await gate; return { text: 'A 完成', usage: null, observedModel: 'm', attempts: 1 }; },
      stream: async () => { await gate; return { text: 'A 完成' }; },
      validateConfig: () => ({ ok: true }), capabilities: () => ({}), normalizeError: (e) => e, usage: () => null
    };
    registerProvider({ providerId: 'creative-ipc-gate', adapterFactory: () => adapterGate, override: true });
    session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-gate', apiKey: 'sk-tes...-000', model: 'm' } });
    await h.invoke('creative:create-project', h.trusted(), 'cc');
    const before = h.webContents.sent.length;
    const rA = await h.invoke('creative:send', h.trusted(), { projectId: 'cc', content: 'A 的生成' });
    await wait(30);
    const rB = await h.invoke('creative:send', h.trusted(), { projectId: 'cc', content: 'B 的生成' });
    const pendingPath = path.join(dataDir, 'creative', 'projects', 'cc', 'history.pending.json');
    const pending = fs.existsSync(pendingPath) ? JSON.parse(fs.readFileSync(pendingPath, 'utf8')) : null;
    check('C1 同项目 in-flight 二次发送 -> CREATIVE_GENERATION_IN_FLIGHT',
      rA.ok === true && rB.ok === false && rB.code === 'CREATIVE_GENERATION_IN_FLIGHT');
    check('C2 A 的 pending 未被覆盖（仍是 A 的 streaming 事务）',
      pending && pending.status === 'streaming' && pending.role === 'assistant');
    release();
    await waitFor(() => h.webContents.sent.slice(before).some(([ch]) => ch === 'creative:completed'));
    const ccHistory = store.readHistory('cc');
    check('C3 B 不产生第二事务、history 不重复不串轨',
      ccHistory.filter((r) => r.role === 'user').length === 1 &&
      ccHistory.filter((r) => r.role === 'assistant').length === 1 &&
      ccHistory.find((r) => r.role === 'user').content === 'A 的生成');
  }

  /* ================= PS. 项目切换不串轨 ================= */
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const adapterG2 = {
      complete: async () => { await gate; return { text: 'PA 的生成', usage: null, observedModel: 'm', attempts: 1 }; },
      stream: async () => { await gate; return { text: 'PA 的生成' }; },
      validateConfig: () => ({ ok: true }), capabilities: () => ({}), normalizeError: (e) => e, usage: () => null
    };
    registerProvider({ providerId: 'creative-ipc-switch', adapterFactory: () => adapterG2, override: true });
    session = createCreativeSession({ store, cfg: { provider: 'creative-ipc-switch', apiKey: 'sk-tes...-000', model: 'm' } });
    await h.invoke('creative:create-project', h.trusted(), 'pa');
    await h.invoke('creative:create-project', h.trusted(), 'pb');
    await h.invoke('creative:send', h.trusted(), { projectId: 'pa', content: '在 pa 开始' });
    await wait(20);
    await h.invoke('creative:set-active-project', h.trusted(), 'pb'); // 中途切换 active project
    release();
    await waitFor(() => store.readHistory('pa').some((r) => r.role === 'assistant'));
    check('PS1 in-flight 结果只进原 project（切换不串轨）',
      store.readHistory('pa').some((r) => r.role === 'assistant') &&
      store.readHistory('pb').filter((r) => r.role === 'assistant').length === 0);
  }

  /* ================= R. Recovery（经 IPC 读路径触发） ================= */
  {
    await h.invoke('creative:create-project', h.trusted(), 'rc');
    const histPath = path.join(dataDir, 'creative', 'projects', 'rc', 'history.jsonl');
    fs.writeFileSync(histPath, '{"recordId":"torn'); // 撕裂半行
    fs.writeFileSync(path.join(dataDir, 'creative', 'projects', 'rc', 'history.pending.json'),
      JSON.stringify({ recordId: 'cr-recover-1', projectId: 'rc', status: 'streaming', role: 'assistant', content: '崩溃半截', createdAt: 1 }));
    const r = await h.invoke('creative:get-history', h.trusted(), 'rc');
    check('R1 读路径先执行 recoverPending（半行清除 + streaming pending 安全落终态）',
      r.ok === true && r.history.some((x) => x.recordId === 'cr-recover-1' && x.status === 'error'));
    const raw = fs.readFileSync(histPath, 'utf8');
    check('R2 恢复后 history 零不可解析行（幂等可重复读取）',
      raw.split('\n').filter((l) => l.trim()).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  }

  /* ================= SB. 出站数据安全边界 ================= */
  {
    const allOut = JSON.stringify(h.webContents.sent) + JSON.stringify([...h.handlers.keys()]);
    check('SB1 renderer 永远拿不到 credential / provider 内部配置 / 文件系统路径',
      !allOut.includes('sk-tes...-000') && !allOut.includes('https://internal.example') && !allOut.includes(dataDir.split(path.sep).join('\\\\')) &&
      !allOut.includes(dataDir));
    const payloadOnly = JSON.stringify(h.webContents.sent.map(([, p]) => p));
    check('SB2 出站 payload 无 Authorization / adapter 对象 / secret token 形态',
      !payloadOnly.includes('Authorization') && !payloadOnly.includes('adapterFactory') &&
      !payloadOnly.includes('FAKESECRETtokenvalue1234567890') && !payloadOnly.includes('ghp_FAKESECRET'));
  }

  /* ================= Z. Subject 零写入（IPC 全流程） ================= */
  {
    const subjectFiles = ['memory.json', 'experiences.jsonl', 'subject-state.json', 'self-ledger.json'];
    for (const f of subjectFiles) fs.writeFileSync(path.join(dataDir, f), f + '-sentinel');
    const snap = () => subjectFiles.map((f) => sha256(fs.readFileSync(path.join(dataDir, f), 'utf8'))).join('|');
    const before = snap();
    await h.invoke('creative:send', h.trusted(), { projectId: 'cc', content: '再写一段' });
    await wait(50);
    await h.invoke('creative:abort', h.trusted(), 'cc');
    await h.invoke('creative:summarize', h.trusted(), 'cc');
    await h.invoke('creative:update-context', h.trusted(), 'cc', { theme: 'test' });
    await h.invoke('creative:create-project', h.trusted(), 'zz');
    await h.invoke('creative:set-active-project', h.trusted(), 'zz');
    check('Z1 Creative UI + send + abort + summarize + context + switch 全流程 Subject 零写入',
      snap() === before);
  }

  /* ================= U. UI 文案与暴露面隔离 ================= */
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/<div id="creativePanel"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
    const block = html.slice(html.indexOf('id="creativePanel"'), html.indexOf('实验观测与可复盘工具面板'));
    check('U1 创作空间面板存在且文案中性（不与主体人格混同）',
      block.includes('创作空间') && block.includes('创作助手') && !block.includes('初澜'));
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    check('U2 preload 只暴露业务方法（无 require/fs/Store 对象）',
      preload.includes('creative: {') && !/window\.require|window\.fs|creativeStore/.test(preload));
    const pet = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
    check('U3 pet.js Creative UI 不读取 Subject 数据面（无 memory/ledger/state 读取接线）',
      pet.includes('api.creative') && !/api\.creative[\s\S]{0,200}(getMemory|selfLedger|subjectState)/.test(pet));
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

run().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
