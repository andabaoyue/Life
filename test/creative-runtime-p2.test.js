/**
 * test/creative-runtime-p2.test.js — Life v0.9.9 Phase 2: Creative Core 专项回归
 *
 * 覆盖完成标准：Creative Prompt provenance 隔离、History crash/pending recovery、
 * Canonical History Hash、Context/Summary 正交、Multi-Project 隔离、
 * Path Traversal 拒绝、Subject 数据零写入、Provider Adapter 复用、Skill Loader。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { canonicalizeCreativeHistory, sourceHistoryHash } = require('../src/creative/creative-hash');
const { createCreativeStore, assertProjectId } = require('../src/creative/creative-store');
const { createCreativeSession, CREATIVE_SYSTEM_PROMPT } = require('../src/creative/creative-session');
const { loadCreativeSkill } = require('../src/creative/skill-loader');
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

function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

/* ---------------- mock adapter（经真实 Provider Registry 注册） ---------------- */
function makeMockAdapter(behavior = {}) {
  const captured = [];
  return {
    captured,
    async complete(messages, opts = {}) {
      captured.push(messages.map((m) => ({ ...m })));
      if (behavior.failComplete) throw behavior.failComplete;
      return { text: behavior.completeText || 'mock-reply', usage: null, observedModel: 'mock', attempts: 1 };
    },
    async stream(messages, onDelta, opts = {}) {
      captured.push(messages.map((m) => ({ ...m })));
      for (const d of behavior.deltas || ['par', 'tial']) {
        if (onDelta) onDelta(d);
      }
      if (behavior.failStream) throw behavior.failStream;
      return { text: (behavior.deltas || ['par', 'tial']).join(''), usage: null, observedModel: 'mock', attempts: 1 };
    },
    validateConfig: () => ({ ok: true }),
    capabilities: () => ({ streaming: true, usage: true, systemMessage: true }),
    normalizeError: (e) => e,
    usage: () => null
  };
}

async function run() {
  const dir = tmpDir('creative-p2-');

  /* ================= A. Creative Prompt provenance 隔离 ================= */
  {
    const adapter = makeMockAdapter({ completeText: '创作草稿' });
    registerProvider({ providerId: 'creative-mock', adapterFactory: () => adapter, override: true });
    const store = createCreativeStore(dir);
    store.createProject('default');
    const session = createCreativeSession({ store, cfg: { provider: 'creative-mock', apiKey: 'sk-tes...-000', model: 'm' } });

    const rec = await session.send({ content: '请为我起草一段开头' });
    const msgs = adapter.captured[0];
    check('A1 Creative 请求存在明确 system message（messages[0].role === system）',
      msgs && msgs[0] && msgs[0].role === 'system');
    check('A2 system message 等于 Creative 专用 system prompt（来源与内容逐字一致）',
      msgs[0].content === CREATIVE_SYSTEM_PROMPT);
    check('A3 system message 不等于 Life PERSONA', msgs[0].content !== PERSONA);
    // A4 源码级：creative 模块无 persona 运行时依赖（注释不计，代码不得引用）
    const creativeSrc = ['creative-hash.js', 'creative-store.js', 'creative-session.js', 'skill-loader.js']
      .map((f) => codeOnly(fs.readFileSync(path.join(ROOT, 'src', 'creative', f), 'utf8')))
      .join('\n');
    check('A4 Creative Core 源码不存在 persona 运行时依赖',
      !/persona/i.test(creativeSrc) && !/require\(['"][^'"]*persona/i.test(creativeSrc));
    // A5 provider 捕获的最终 messages 无人格偷塞
    check('A5 Provider mock 捕获最终 messages：无 PERSONA 偷塞',
      msgs.every((m) => m.content !== PERSONA) && msgs[0].content === CREATIVE_SYSTEM_PROMPT);
    // A6 user content 含「初澜」合法通过，不触发任何错误分支
    const adapter2 = makeMockAdapter({ completeText: '含名字的正文' });
    registerProvider({ providerId: 'creative-mock2', adapterFactory: () => adapter2, override: true });
    const session2 = createCreativeSession({ store, cfg: { provider: 'creative-mock2', apiKey: 'sk-tes...-000', model: 'm' } });
    const rec6 = await session2.send({ content: '把主角命名为初澜，写一段独白' });
    check('A6 user content 出现「初澜」不触发错误（正常完成且原文保留）',
      rec6 && rec6.status === 'completed' && rec6.content === '含名字的正文' &&
      store.readHistory('default').some((r) => r.content && r.content.includes('初澜')));
  }

  /* ================= B. History crash / pending recovery ================= */
  {
    const store = createCreativeStore(dir);
    store.createProject('hist');

    // B1 正常生成：整行 JSON、pending 清空
    const adapter = makeMockAdapter({});
    registerProvider({ providerId: 'creative-mock3', adapterFactory: () => adapter, override: true });
    const session = createCreativeSession({ store, cfg: { provider: 'creative-mock3', apiKey: 'sk-tes...-000', model: 'm' } });
    await session.send({ projectId: 'hist', content: 'hello' });
    const raw = fs.readFileSync(path.join(dir, 'creative', 'projects', 'hist', 'history.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    check('B1 整行 JSON 提交且 pending 已清除',
      lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }) &&
      !fs.existsSync(path.join(dir, 'creative', 'projects', 'hist', 'history.pending.json')));

    // B2 Abort mid-stream：partial 如实保留，finishReason=abort
    const abortErr = new Error('aborted'); abortErr.name = 'AbortError';
    const adapterA = makeMockAdapter({ deltas: ['已经', '收到'], failStream: abortErr });
    registerProvider({ providerId: 'creative-mock-abort', adapterFactory: () => adapterA, override: true });
    const sessionA = createCreativeSession({ store, cfg: { provider: 'creative-mock-abort', apiKey: 'sk-tes...-000', model: 'm' } });
    const recA = await sessionA.send({ projectId: 'hist', content: 'x', onDelta: () => {} });
    check('B2 Abort -> status=aborted、content=真实 partial、finishReason=abort',
      recA.status === 'aborted' && recA.content === '已经收到' && recA.finishReason === 'abort');

    // B3 网络错误：status=error、partial 如实、finishReason=error
    const netErr = new Error('ECONNRESET'); netErr.name = 'ProviderError';
    const adapterE = makeMockAdapter({ deltas: ['半截'], failStream: netErr });
    registerProvider({ providerId: 'creative-mock-err', adapterFactory: () => adapterE, override: true });
    const sessionE = createCreativeSession({ store, cfg: { provider: 'creative-mock-err', apiKey: 'sk-tes...-000', model: 'm' } });
    const recE = await sessionE.send({ projectId: 'hist', content: 'x', onDelta: () => {} });
    check('B3 网络错误 -> status=error、content=真实 partial、finishReason=error',
      recE.status === 'error' && recE.content === '半截' && recE.finishReason === 'error');

    // B4 crash 于生成中：streaming pending + 撕裂半行 -> 恢复为安全终态且无半行残留
    const histPath = path.join(dir, 'creative', 'projects', 'hist', 'history.jsonl');
    fs.appendFileSync(histPath, '{"recordId":"torn-half'); // 模拟 crash 撕裂的半行
    fs.writeFileSync(path.join(dir, 'creative', 'projects', 'hist', 'history.pending.json'),
      JSON.stringify({ recordId: 'cr-crash-1', projectId: 'hist', status: 'streaming', role: 'assistant', content: '崩溃前的半截', createdAt: 1 }));
    const rec4 = store.recoverPending('hist');
    const afterLines = fs.readFileSync(histPath, 'utf8').split('\n').filter((l) => l.trim());
    check('B4 crash(streaming pending) -> 安全终态恢复且半行被清除',
      rec4.recovered === true && rec4.action === 'committed_from_pending' &&
      afterLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
    const rec4b = store.readHistory('hist').find((r) => r.recordId === 'cr-crash-1');
    check('B5 恢复记录保留真实 partial、status=error、标记 recoveredFromPending',
      rec4b && rec4b.status === 'error' && rec4b.content === '崩溃前的半截' && rec4b.recoveredFromPending === true);

    // B6 crash 于终态 pending（append 前）-> 按 pending 终态提交
    fs.writeFileSync(path.join(dir, 'creative', 'projects', 'hist', 'history.pending.json'),
      JSON.stringify({ recordId: 'cr-crash-2', projectId: 'hist', status: 'completed', role: 'assistant', content: '已完成文本', finishReason: 'stop', createdAt: 2 }));
    const rec6 = store.recoverPending('hist');
    const rec6b = store.readHistory('hist').find((r) => r.recordId === 'cr-crash-2');
    check('B6 终态 pending -> 按 pending 终态安全提交（completed）',
      rec6.action === 'committed_from_pending' && rec6b && rec6b.status === 'completed' && rec6b.content === '已完成文本');

    // B7 recordId 已在 history -> 只清 pending
    const beforeCount = store.readHistory('hist').length;
    fs.writeFileSync(path.join(dir, 'creative', 'projects', 'hist', 'history.pending.json'),
      JSON.stringify({ recordId: 'cr-crash-2', projectId: 'hist', status: 'streaming', role: 'assistant', content: 'dup', createdAt: 3 }));
    const rec7 = store.recoverPending('hist');
    check('B7 recordId 已存在 -> 只清 pending（history 不重复提交）',
      rec7.action === 'cleared_pending_record_already_committed' &&
      store.readHistory('hist').length === beforeCount &&
      !fs.existsSync(path.join(dir, 'creative', 'projects', 'hist', 'history.pending.json')));
  }

  /* ================= C. Canonical History Hash ================= */
  {
    const h = (msgs) => sourceHistoryHash(msgs);
    check('C1 Windows \\r\\n 与 Linux \\n 同 hash',
      h([{ role: 'user', content: 'a\r\nb' }]) === h([{ role: 'user', content: 'a\nb' }]));
    check('C2 \\r 与 \\n canonical 后一致',
      h([{ role: 'user', content: 'a\rb' }]) === h([{ role: 'user', content: 'a\nb' }]));
    check('C3 timestamp 不影响 hash',
      h([{ role: 'user', content: 'x', createdAt: 1 }]) === h([{ role: 'user', content: 'x', createdAt: 999999 }]));
    check('C4 machine/path 不影响 hash',
      h([{ role: 'user', content: 'x', machine: 'A', path: '/tmp/a' }]) === h([{ role: 'user', content: 'x' }]));
    check('C5 消息顺序改变 hash',
      h([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]) !==
      h([{ role: 'assistant', content: 'b' }, { role: 'user', content: 'a' }]));
    check('C6 content 改变 hash',
      h([{ role: 'user', content: 'a' }]) !== h([{ role: 'user', content: 'b' }]));
    check('C7 前后空格差异仍视为不同真实内容（不做 trim）',
      h([{ role: 'user', content: ' x ' }]) !== h([{ role: 'user', content: 'x' }]));
    check('C8 对象 key 顺序改变不影响 canonical hash',
      h([{ content: 'x', role: 'user' }]) === h([{ role: 'user', content: 'x' }]));
  }

  /* ================= D. Context 与 Summary 完全正交 ================= */
  {
    const store = createCreativeStore(dir);
    store.createProject('ortho');
    store.appendHistory('ortho', { recordId: 'r1', projectId: 'ortho', role: 'user', status: 'completed', content: '原始内容', finishReason: 'stop', createdAt: 1 });
    store.updateContext('ortho', { theme: '科幻', pov: 'first' });
    const ctxBefore = sha256(JSON.stringify(store.readContext('ortho')));
    const summary = store.summarizeCreative('ortho');
    const ctxAfter = sha256(JSON.stringify(store.readContext('ortho')));
    check('D1 summarizeCreative() -> context hash unchanged', ctxBefore === ctxAfter);
    check('D2 summarize 只写 summary.json（context.json 未被动生成）',
      store.readSummary('ortho') && summary.messageCount === 1 &&
      store.readContext('ortho').theme === '科幻' && store.readContext('ortho').pov === 'first');
    // D3 无 context 时 summarize 不得自动创建 context
    store.createProject('noctx');
    store.summarizeCreative('noctx');
    check('D3 summarize 不自动创建/清空 Context',
      !fs.existsSync(path.join(dir, 'creative', 'projects', 'noctx', 'context.json')));
    // D4 并行数据源加载，无隐式覆盖
    const proj = store.loadProject('ortho');
    check('D4 loadProject 三数据源并行（summary 不覆盖 context）',
      proj && proj.context.theme === '科幻' && proj.summary.messageCount === 1 && proj.history.length === 1);
  }

  /* ================= E. Multi-Project Storage ================= */
  {
    const store = createCreativeStore(dir);
    const a = store.createProject('alpha');
    const b = store.createProject('beta');
    store.appendHistory('alpha', { recordId: 'a1', projectId: 'alpha', role: 'user', status: 'completed', content: 'A 的内容', finishReason: 'stop', createdAt: 1 });
    store.appendHistory('beta', { recordId: 'b1', projectId: 'beta', role: 'user', status: 'completed', content: 'B 的内容', finishReason: 'stop', createdAt: 1 });
    check('E1 createProject/listProjects 多项目共存',
      a.projectId === 'alpha' && b.projectId === 'beta' && store.listProjects().includes('alpha') && store.listProjects().includes('beta'));
    check('E2 项目历史严格隔离',
      store.readHistory('alpha').every((r) => r.content === 'A 的内容') &&
      store.readHistory('beta').every((r) => r.content === 'B 的内容'));
    store.setActiveProject('alpha');
    check('E3 setActiveProject/getActiveProject（active-project.json 原子写）',
      store.getActiveProject() === 'alpha' &&
      JSON.parse(fs.readFileSync(path.join(dir, 'creative', 'active-project.json'), 'utf8')).activeProjectId === 'alpha');
    check('E4 单项目默认走 projectId=default', (() => {
      const s2 = createCreativeStore(tmpDir('creative-default-'));
      const d = s2.createProject();
      return d.projectId === 'default' && s2.loadProject('default').projectId === 'default';
    })());
  }

  /* ================= F. Project ID 路径安全边界 ================= */
  {
    const bad = ['../evil', '..\\evil', 'C:\\evil', '/abs/path', 'a/b', 'a\\b', '', '..', 'x\u0000y', 'a\u0001b', 'a.b', '.'];
    let allRejected = true;
    for (const id of bad) {
      try { assertProjectId(id); allRejected = false; } catch (e) { if (e.code !== 'CREATIVE_PROJECT_ID_INVALID') allRejected = false; }
    }
    check('F1 projectId 全部非法形态被拒绝（穿越/绝对路径/分隔符/控制字符/空）', allRejected);

    const store = createCreativeStore(dir);
    let createRejected = false;
    try { store.createProject('../pwn'); } catch (e) { createRejected = e.code === 'CREATIVE_PROJECT_ID_INVALID'; }
    check('F2 createProject 路径穿越拒绝且 projects/ 无逃逸条目',
      createRejected && store.listProjects().every((id) => !id.includes('..')));

    let skillRejected = false;
    try { loadCreativeSkill('../../etc/passwd.md', { baseDir: dir }); } catch (e) { skillRejected = e.code === 'CREATIVE_SKILL_NAME_INVALID'; }
    check('F3 Skill Loader 名称穿越拒绝', skillRejected);
  }

  /* ================= G. Subject 数据零写入 ================= */
  {
    const subjectDir = tmpDir('creative-subject-');
    const subjectFiles = ['memory.json', 'experiences.jsonl', 'subject-state.json', 'self-ledger.json'];
    for (const f of subjectFiles) fs.writeFileSync(path.join(subjectDir, f), f + '-sentinel-v1');
    const snap = () => subjectFiles.map((f) => sha256(fs.readFileSync(path.join(subjectDir, f), 'utf8'))).join('|');

    const store = createCreativeStore(subjectDir);
    store.createProject('zero');
    const adapter = makeMockAdapter({});
    registerProvider({ providerId: 'creative-mock-zero', adapterFactory: () => adapter, override: true });
    const session = createCreativeSession({ store, cfg: { provider: 'creative-mock-zero', apiKey: 'sk-tes...-000', model: 'm' } });

    const before = snap();
    await session.send({ projectId: 'zero', content: 'append creative message' });   // 1. append message
    check('G1 append creative message 不写 Subject 数据', snap() === before);
    store.summarizeCreative('zero');                                                  // 2. summarize
    check('G2 summarize 不写 Subject 数据', snap() === before);
    store.updateContext('zero', { x: 1 });                                            // 3. update context
    check('G3 update context 不写 Subject 数据', snap() === before);
    store.createProject('zero2');                                                     // 4. create project
    check('G4 create project 不写 Subject 数据', snap() === before);
    store.setActiveProject('zero2');                                                  // 5. switch project
    check('G5 switch project 不写 Subject 数据', snap() === before);
  }

  /* ================= H. Provider 架构复用 ================= */
  {
    const srcs = ['creative-hash.js', 'creative-store.js', 'creative-session.js', 'skill-loader.js']
      .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'creative', f), 'utf8')).join('\n');
    check('H1 Creative 层不复制 transport（无 fetch/XHR/http.request）',
      !/fetch\s*\(|XMLHttpRequest|http\.request|https\.request/.test(srcs));
    check('H2 Creative Core 经现有 Provider Registry 取 Adapter（不建第二套 provider 层）',
      /require\('\.\.\/provider-registry'\)/.test(srcs) && /createAdapter\(/.test(srcs));
    // H3 行为证明：真实 registry 转发到注册的 adapter（capture 非空 = Registry -> Adapter 链路活着）
    const store = createCreativeStore(dir);
    store.createProject('reuse');
    const adapter = makeMockAdapter({ completeText: 'ok' });
    registerProvider({ providerId: 'creative-mock-reuse', adapterFactory: () => adapter, override: true });
    const session = createCreativeSession({ store, cfg: { provider: 'creative-mock-reuse', apiKey: 'sk-tes...-000', model: 'm' } });
    const r = await session.send({ projectId: 'reuse', content: 'go' });
    check('H3 真实 Registry -> Adapter 转发生效（messages 被 adapter 捕获）',
      adapter.captured.length === 1 && r.status === 'completed');
  }

  /* ================= I. Skill Loader 最小接口 ================= */
  {
    const skillDir = tmpDir('creative-skills-');
    fs.writeFileSync(path.join(skillDir, '小说工作流.md'), '# 小说工作流\n正文');
    const got = loadCreativeSkill('小说工作流.md', { baseDir: skillDir });
    check('I1 Skill Loader 正常读取技能文件', got && got.name === '小说工作流.md' && got.text.includes('小说工作流'));
    check('I2 Skill Loader 不存在返回 null（不抛出、不伪造）', loadCreativeSkill('missing.md', { baseDir: skillDir }) === null);
    let rejected = false;
    try { loadCreativeSkill('..\\x.md', { baseDir: skillDir }); } catch (e) { rejected = e.code === 'CREATIVE_SKILL_NAME_INVALID'; }
    check('I3 Skill Loader 控制字符/分隔符名称拒绝', rejected);
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

run().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
