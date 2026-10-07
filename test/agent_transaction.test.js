/**
 * test/agent_transaction.test.js — v1.0 D-2 单文件写事务 + WAL 恢复门禁
 *
 * 严格遵守第一铁律「门禁测试必须包含反例。只测正例，真漏洞会藏在绿色里。」
 *
 * 本文件的三条核心反例（缺任一条，整套回滚机制就是纸糊的）：
 *   ❌ 反例 A（运行时失败）：写入抛错 → 原文件字节与哈希100% 还原
 *   ❌ 反例 B（新建失败）：新文件写入失败回滚 → 磁盘不留残余文件
 *   ❌ 反例 C（模拟崩溃断电）：手工在磁盘留下 pending WAL + 备份（模拟进程强杀），
 *      调 recoverPendingTransactions() 断言孤儿事务被识别并**精准**还原
 *
 * 🔴 反例 C 是本阶段唯一能证明"WAL 值得做"的用例：只做内存 catch 的机制
 * 在真实场景（用户关窗 / OOM / 断电）下永远不会被触发，也就永远不会被验证。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const { WriteTransactionManager, WAL_FILE, BACKUP_DIR } = require('../src/agent-transaction');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashOf(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 数据目录 + 工作目录分离：WAL/备份在 dataDir，目标文件在 workDir。 */
function scenario() {
  const dataDir = tmpDir('txn-data-');
  const workDir = tmpDir('txn-work-');
  const mgr = new WriteTransactionManager({ dir: dataDir });
  return { dataDir, workDir, mgr, walPath: path.join(dataDir, WAL_FILE), backupDir: path.join(dataDir, BACKUP_DIR) };
}

console.log('--- D-2 单文件写事务 + WAL 门禁 ---');

/* ================= 1. 正常提交（正例） ================= */
{
  const { workDir, mgr } = scenario();
  const f = path.join(workDir, 'notes.txt');
  fs.writeFileSync(f, 'ORIGINAL');

  const tx = mgr.begin({ target: f, data: 'UPDATED' });
  check('D2-1 begin 后目标文件已是新内容', fs.readFileSync(f, 'utf8') === 'UPDATED');
  mgr.commit(tx);
  check('D2-2 commit 后新内容留存且备份已清理',
    fs.readFileSync(f, 'utf8') === 'UPDATED' &&
    fs.readdirSync(mgr.backupDir || '').filter((n) => n.includes('notes.txt')).length === 0);
}

/* ================= 2. ❌ 反例 A：写入抛错 → 原文件字节级还原 ================= */
{
  const { workDir, mgr } = scenario();
  const f = path.join(workDir, 'a.txt');
  fs.writeFileSync(f, 'PRECIOUS_ORIGINAL_BYTES');
  const h0 = hashOf(f);

  // 用一个必失败的路径触发"写前快照完成、写入阶段抛错"：
  // 目标是一个已存在的**目录**，rename 会失败（EISDIR/EPERM）。
  const asDir = path.join(workDir, 'target-dir');
  fs.mkdirSync(asDir);
  fs.writeFileSync(path.join(asDir, 'child.txt'), 'x');

  let threw = null;
  try {
    const tx = mgr.begin({ target: asDir, data: 'NEW' });
    mgr.rollback(tx);
  } catch (err) {
    threw = err;
  }
  check('❌ 反例A 写入失败时抛错且目标（目录）未被破坏成文件',
    threw !== null && fs.statSync(asDir).isDirectory() &&
    fs.readFileSync(path.join(asDir, 'child.txt'), 'utf8') === 'x',
    threw && String(threw.message).slice(0, 60));

  // 🔴 核心断言：正常覆盖写 + 主动 rollback → 哈希与字节 100% 还原
  const tx = mgr.begin({ target: f, data: 'TEMP_WRONG' });
  check('   反例A 中间态确认（此刻是新内容）', fs.readFileSync(f, 'utf8') === 'TEMP_WRONG');
  mgr.rollback(tx);
  const h1 = hashOf(f);
  check('❌ 反例A rollback 后字节与哈希 100% 还原',
    fs.readFileSync(f, 'utf8') === 'PRECIOUS_ORIGINAL_BYTES' && h0 === h1,
    `${h0 && h0.slice(0, 12)} -> ${h1 && h1.slice(0, 12)}`);
}

/* ================= 3. ❌ 反例 B：新建文件失败 → 不留残余文件 ================= */
{
  const { workDir, mgr } = scenario();
  const f = path.join(workDir, 'brand-new.txt');
  check('D2-3 新建前文件确实不存在', !fs.existsSync(f));

  const tx = mgr.begin({ target: f, data: 'NEW_CONTENT' });
  check('D2-4 新建后文件存在且内容正确', fs.existsSync(f) && fs.readFileSync(f, 'utf8') === 'NEW_CONTENT');
  mgr.rollback(tx);
  // 🔴 不变式 1：新建文件的回滚是"删除"，绝不能留下空壳或半截文件
  check('❌ 反例B 新建文件回滚后磁盘不留残余',
    !fs.existsSync(f),
    fs.existsSync(f) ? `残留内容=${fs.readFileSync(f, 'utf8')}` : '已删除');

  // 新建→提交→再想回滚：应拒绝（已提交不可回滚）
  const f2 = path.join(workDir, 'committed.txt');
  const tx2 = mgr.begin({ target: f2, data: 'KEEP' });
  mgr.commit(tx2);
  let err2 = null;
  try { mgr.rollback(tx2); } catch (e) { err2 = e; }
  check('❌ 反例B2 已提交事务不可回滚（防止用户以为已还原）',
    err2 && err2.code === 'TXN_ALREADY_COMMITTED' && fs.existsSync(f2), err2 && err2.code);
}

/* ================= 4. ❌ 反例 C：模拟崩溃断电 → 启动自愈 ================= */
{
  const { dataDir, workDir, walPath, backupDir } = scenario();
  const f = path.join(workDir, 'crash.txt');
  fs.writeFileSync(f, 'BEFORE_CRASH');
  const h0 = hashOf(f);

  // 🔴 手工模拟进程被强杀：备份已落盘、pending WAL 已落盘，
  // 但目标文件已被写成新内容、且**没有任何终态记录**。
  fs.mkdirSync(backupDir, { recursive: true });
  const bakPath = path.join(backupDir, 'txn-fake-crash-crash.txt');
  fs.writeFileSync(bakPath, 'BEFORE_CRASH');            // 备份=原字节
  fs.writeFileSync(f, 'HALF_WRITTEN_AFTER_CRASH');        // 目标=新内容
  fs.appendFileSync(walPath, JSON.stringify({
    txId: 'txn-fake-crash', target: f, backupPath: bakPath,
    originalHash: h0, isNew: false, status: 'pending', at: Date.now(),
  }) + '\n', 'utf8');

  const mgr = new WriteTransactionManager({ dir: dataDir });
  const pendingBefore = mgr.listPending();
  const rec = mgr.recoverPendingTransactions();

  check('❌ 反例C 崩溃后listPending 能识别孤儿事务',
    pendingBefore.length === 1 && pendingBefore[0].txId === 'txn-fake-crash',
    `pending=${pendingBefore.length}`);
  check('❌ 反例C recoverPendingTransactions 精准还原（原字节+哈希一致）',
    rec.recovered === 1 && rec.failed.length === 0 &&
    fs.readFileSync(f, 'utf8') === 'BEFORE_CRASH' && hashOf(f) === h0,
    `recovered=${rec.recovered} failed=${JSON.stringify(rec.failed)}`);
  check('D2-5 还原后备份已清理且无残留 pending',
    !fs.existsSync(bakPath) && mgr.listPending().length === 0);
}

/* ================= 5. ❌ 反例 C2：崩溃在「新建」上 ================= */
{
  const { dataDir, workDir, walPath } = scenario();
  const f = path.join(workDir, 'crash-new.txt');
  // 模拟：新建文件写到一半被强杀（文件存在但内容不完整），WAL 仍 pending
  fs.writeFileSync(f, 'PARTIAL');
  fs.appendFileSync(walPath, JSON.stringify({
    txId: 'txn-fake-new', target: f, backupPath: null,
    originalHash: null, isNew: true, status: 'pending', at: Date.now(),
  }) + '\n', 'utf8');

  const mgr = new WriteTransactionManager({ dir: dataDir });
  const rec = mgr.recoverPendingTransactions();
  check('❌ 反例C2 崩溃在新建事务上 → 半截文件被删除（不变式 1 在崩溃路径同样成立）',
    rec.recovered === 1 && rec.failed.length === 0 && !fs.existsSync(f),
    `recovered=${rec.recovered} exists=${fs.existsSync(f)}`);
}

/* ================= 6. ❌ 反例 D：已有终态的事务不被误还原 ================= */
{
  const { dataDir, workDir, walPath } = scenario();
  const f = path.join(workDir, 'done.txt');
  fs.writeFileSync(f, 'COMMITTED_CONTENT');
  // 同一 txId 同时有 pending 与 committed → 必须判为"已正常处理"，绝不动它
  fs.appendFileSync(walPath, JSON.stringify({
    txId: 'txn-done', target: f, isNew: false, status: 'pending', at: 1,
  }) + '\n', 'utf8');
  fs.appendFileSync(walPath, JSON.stringify({
    txId: 'txn-done', target: f, status: 'committed', at: 2,
  }) + '\n', 'utf8');

  const mgr = new WriteTransactionManager({ dir: dataDir });
  const rec = mgr.recoverPendingTransactions();
  check('❌ 反例D 已 committed 的事务不被自愈误还原（数据必须保住）',
    rec.recovered === 0 && rec.failed.length === 0 &&
    fs.readFileSync(f, 'utf8') === 'COMMITTED_CONTENT',
    `recovered=${rec.recovered} content=${fs.readFileSync(f, 'utf8')}`);
}

/* ================= 7. ❌ 反例 E：备份丢失时必须报 failed 而非假装成功 ================= */
{
  const { dataDir, workDir, walPath, backupDir } = scenario();
  const f = path.join(workDir, 'lost-backup.txt');
  fs.writeFileSync(f, 'SOME_NEW_CONTENT');
  fs.mkdirSync(backupDir, { recursive: true });
  // WAL 说有备份，但备份文件实际不存在（磁盘被外部清理/损坏）
  fs.appendFileSync(walPath, JSON.stringify({
    txId: 'txn-lost', target: f,
    backupPath: path.join(backupDir, 'not-exist-backup'),
    originalHash: null, isNew: false, status: 'pending', at: 1,
  }) + '\n', 'utf8');

  const mgr = new WriteTransactionManager({ dir: dataDir });
  const rec = mgr.recoverPendingTransactions();
  check('❌ 反例E 备份丢失时报 failed 且不谎报成功（数据不被二次破坏）',
    rec.recovered === 0 && rec.failed.length === 1 &&
    /BACKUP_MISSING/.test(rec.failed[0].error),
    JSON.stringify(rec.failed));
}

/* ================= 8. ❌ 反例 F：哈希不闭环时必须抛错 ================= */
{
  const { workDir, mgr } = scenario();
  const f = path.join(workDir, 'tampered.txt');
  fs.writeFileSync(f, 'ORIGINAL');
  const tx = mgr.begin({ target: f, data: 'NEW' });
  // 模拟"回滚后内容对不上"：把备份偷换掉，强制制造哈希不匹配
  fs.writeFileSync(tx.backupPath, 'TAMPERED_BACKUP');
  let err = null;
  try { mgr.rollback(tx); } catch (e) { err = e; }
  check('❌ 反例F 哈希不闭环时抛 ROLLBACK_HASH_MISMATCH（绝不假装还原成功）',
    err && err.code === 'ROLLBACK_HASH_MISMATCH', err && err.code);
}

/* ================= 9. 输入校验 ================= */
{
  const { workDir, mgr } = scenario();
  let e1 = null;
  try { mgr.begin({ data: 'x' }); } catch (e) { e1 = e; }
  let e2 = null;
  try { mgr.begin({ target: path.join(workDir, 'x.txt') }); } catch (e) { e2 = e; }
  check('D2-6 缺 target / 缺 data 均被拒', e1 && e2 &&
    e1.code === 'INVALID_TXN_INPUT' && e2.code === 'INVALID_TXN_INPUT');

  const big = new WriteTransactionManager({ dir: workDir, maxBytes: 10 });
  let e3 = null;
  try { big.begin({ target: path.join(workDir, 'big.txt'), data: 'x'.repeat(100) }); } catch (e) { e3 = e; }
  check('D2-7 超大小上限被拒（防灌超大文件）', e3 && e3.code === 'PAYLOAD_TOO_LARGE', e3 && e3.code);
}

/* ================= 10. 无dir 退化（内存模式） ================= */
{
  const { workDir } = scenario();
  const m = new WriteTransactionManager({});     // 无 dir → persist=false
  const f = path.join(workDir, 'nodir.txt');
  fs.writeFileSync(f, 'ORIG');
  const tx = m.begin({ target: f, data: 'NEW' });
  check('D2-8 无 dir 也能完成写与回滚（退化可用，不静默崩）',
    fs.readFileSync(f, 'utf8') === 'NEW' && m.rollback(tx) === true &&
    fs.readFileSync(f, 'utf8') === 'ORIG');
}

/* ================= 11. WAL 半截行容错 ================= */
{
  const { dataDir, workDir, walPath } = scenario();
  const f = path.join(workDir, 'half.txt');
  fs.writeFileSync(f, 'X');
  // 模拟崩溃留下的半截 JSON 行
  fs.writeFileSync(walPath, '{"txId":"broken","targ\n{"txId":"x"}\n');
  const mgr = new WriteTransactionManager({ dir: dataDir });
  let ok = true;
  try { const r = mgr.recoverPendingTransactions(); ok = r.recovered === 0; } catch { ok = false; }
  check('D2-9 WAL 半截行被跳过而非崩溃（崩溃现场本来就可能残缺）', ok);
}

console.log(failures === 0 ? '\nall agent_transaction tests passed' : `\n${failures} FAILED`);
assert.strictEqual(failures, 0, `${failures} 项写事务门禁失败`);