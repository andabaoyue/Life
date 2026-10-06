/**
 * Memory 模块单元测试
 * 覆盖：
 *   1. 基础状态初始化与 schemaVersion
 *   2. append 追加与 synthetic 轮数计算
 *   3. build 纯净消息装配与 transientContext 瞬时上下文动态挂载（Q-01）
 *   4. historyTokens 计算纯洁性（不包含瞬时尾巴）
 *   5. rollback 回滚与 turnsInWindow 同步
 *   6. cleanContentForSummary 瞬态标记剥离
 *   7. 窗口边界快照与 closeWindow 归档
 *   8. 记忆查看与物理删除
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory, estimateTokens } = require('../src/memory');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-')); }

const dir = tmpDir();
const mem = new Memory(dir, {
  persona: '你是一个桌宠助手。',
  windowTurns: 5,
  windowMaxTokens: 500,
  keepTailMessages: 2,
  memoryCapTokens: 300
});

// 1. 基础结构
check('初始 schemaVersion 正确', mem.data.schemaVersion === 1);
check('初始 windows 与 history 为空数组', Array.isArray(mem.windows) && mem.windows.length === 0 && mem.history.length === 0);
check('初始 systemText 包含 persona', mem.systemText().includes('你是一个桌宠助手。'));

// 2. append 与轮数
mem.append('user', '你好');
check('append user 增加 turnsInWindow 与 totalTurns',
  mem.data.turnsInWindow === 1 && mem.data.totalTurns === 1 && mem.history.length === 1);

mem.append('assistant', '你好！我是初澜。');
check('append assistant 不增加 turnsInWindow',
  mem.data.turnsInWindow === 1 && mem.data.totalTurns === 1 && mem.history.length === 2);

mem.append('user', '[桌宠自主感知触发]：闲置搭话', { synthetic: true, source: 'proactive' });
check('append synthetic user 不增加 turnsInWindow',
  mem.data.turnsInWindow === 1 && mem.data.totalTurns === 1 && mem.history.length === 3);

// 3. build 与瞬时上下文（Q-01 核心契约）
const msgsPure = mem.build();
check('build() 无参数返回纯净消息列表',
  msgsPure.length === 4 && msgsPure[0].role === 'system' && msgsPure[3].content === '[桌宠自主感知触发]：闲置搭话');

const transientSuffix = '【当前环境感知】\n- 被戳 1 次\n\n【出生时刻】\n- 出生时刻：2026-01-01';
const msgsWithTransient = mem.build(transientSuffix);
check('build(transientSuffix) 动态附加在最后一条 user 消息末尾',
  msgsWithTransient[3].content.includes('闲置搭话')
  && msgsWithTransient[3].content.includes('【当前环境感知】')
  && msgsWithTransient[3].content.includes('【出生时刻】'));

check('build(transientSuffix) 不污染持久化 history',
  mem.data.history[2].content === '[桌宠自主感知触发]：闲置搭话'
  && !mem.data.history[2].content.includes('【当前环境感知】')
  && !mem.data.history[2].content.includes('【出生时刻】'));

const msgsWithOpt = mem.build({ currentTurnSuffix: '【临时标记】' });
check('build({ currentTurnSuffix }) 支持选项对象传参',
  msgsWithOpt[3].content.endsWith('【临时标记】'));

// 4. historyTokens 纯洁性
const tokPure = mem.historyTokens();
const estTransient = estimateTokens(transientSuffix);
check('historyTokens 只计算真实 history，不虚高包含瞬态上下文',
  tokPure < 100);

// 5. rollback 行为
mem.rollback(1);
check('rollback(1) 成功移除最后一条 synthetic 消息',
  mem.history.length === 2 && mem.history[mem.history.length - 1].role === 'assistant');

mem.rollback(1); // 弹出 assistant
mem.rollback(1); // 弹出 user
check('rollback user 消息正常回退 turnsInWindow',
  mem.data.turnsInWindow === 0 && mem.history.length === 0);

// 6. cleanContentForSummary 过滤
const dirty = '用户原话\n\n【当前环境感知】\n- 鼠标点击 3 次\n\n【出生时刻】\n- 出生时刻（本地时间）：2026-01-01\n\n【当前自我投影】\n- 倾向：思考';
check('cleanContentForSummary 彻底清除环境感知与自我投影',
  mem.cleanContentForSummary(dirty) === '用户原话');
check('cleanContentForSummary 清理主动搭话前缀',
  mem.cleanContentForSummary('[桌宠自主感知触发]：你想聊什么') === '你想聊什么');

// 🔴 v3.1 A 方案的漏斗防线：段名从「出生与程序年龄」改成了「出生时刻」，
// 但磁盘上已归档的旧窗口摘要 / 旧 history 里仍是**旧段名**。
// 若 cleanContentForSummary 只认新段名，那批含「运行时长」的原文会漏进
// 长期记忆摘要 —— 正是刚拔掉的报时素材从另一个入口复活。
// 故新旧段名都必须剥离，此断言专门锁住旧段名那条腿。
check('cleanContentForSummary 同时剥离**旧**段名【出生与程序年龄】（A 方案漏斗防线）',
  mem.cleanContentForSummary('用户原话\n\n【出生与程序年龄】\n- 程序累计运转时长：约 101.5 小时') === '用户原话');
check('cleanContentForSummary 剥离新段名【出生时刻】',
  mem.cleanContentForSummary('用户原话\n\n【出生时刻】\n- 出生时刻（本地时间）：2026-01-01') === '用户原话');

// 7. 记忆窗口归档生命周期
mem.append('user', '我是程序员阿哲');
mem.append('assistant', '你好阿哲！');
mem.append('user', '我喜欢喝黑咖啡');
mem.append('assistant', '记住了，喜欢黑咖啡。');
mem.append('user', '今天在写代码');
mem.append('assistant', '加油写代码！');

check('达到 windowTurns 前 needsWindowReset 为 false', !mem.needsWindowReset());
mem.data.turnsInWindow = 5;
check('达到 windowTurns 时 needsWindowReset 为 true', mem.needsWindowReset());

const snap = mem.windowSnapshot();
check('windowSnapshot 切割旧消息并预留 keepTailMessages',
  snap.drop === 4 && snap.len === 6 && snap.items.length === 4);

const closed = mem.closeWindow('阿哲是程序员，喜欢黑咖啡。', snap);
check('closeWindow 成功创建新窗口小结', closed && mem.windows.length === 1);
check('小结并入 systemText', mem.systemText().includes('阿哲是程序员，喜欢黑咖啡。'));
check('history 保留 keepTailMessages 条原文', mem.history.length === 2);
check('windowNo 推进且 turnsInWindow 重新计', mem.data.windowNo === 2 && mem.data.turnsInWindow === 0);
check('保留下来的尾部消息标记为 bridge: true 且保持原 windowNo=1',
  mem.history.every(m => m.bridge === true && m.windowNo === 1 && /^m-\d{6}$/.test(m.messageId)));

// 7.1 Bridge 与 Active Window 分离测试（第 2 窗口严格计数且不重复总结旧 bridge）
mem.append('user', '第2窗口第1轮');
mem.append('assistant', '回复2-1');
mem.append('user', '第2窗口第2轮');
mem.append('assistant', '回复2-2');
check('新窗口消息标记为 bridge: false 且 windowNo=2',
  mem.history.slice(2).every(m => m.bridge === false && m.windowNo === 2));
check('turnsInWindow 只统计新窗口真实 user turn（不受 bridge 干扰）',
  mem.data.turnsInWindow === 2);
const snap2 = mem.windowSnapshot();
check('snap2.activeItems 严格只包含第 2 窗口的新消息，完全剔除旧 bridge',
  snap2.activeItems.length === 4 && snap2.activeItems.every(m => !m.bridge && m.windowNo === 2));

// 8. 记忆查看与删除守卫（v0.9.9 F-099-01 / D-005：物理删除入口已拔除，旧「真删」契约反转）
const memList = mem.listMemory();
check('listMemory 列出第 1 段记忆', memList.length === 1 && memList[0].label === '第1段');
const delRes = mem.deleteWindow(0);
check('deleteWindow 一律拒绝物理删除（D-005 守卫）', delRes === false && mem.windows.length === 1);
check('被拒后记忆完好：systemText 仍包含该段小结', mem.systemText().includes('阿哲是程序员'));

// 9. reset
mem.reset();
check('reset 清空所有记忆与历史并更新 epoch', mem.windows.length === 0 && mem.history.length === 0 && mem.data.epoch === 1);

// 10. 顶层非对象结构（如 JSON 数组）损坏守卫
const corruptDir = tmpDir();
const badMemPath = path.join(corruptDir, 'memory.json');
fs.writeFileSync(badMemPath, JSON.stringify([1, 2, 3]));
const corruptMem = new Memory(corruptDir);
check('顶层为数组时拒绝接纳且不污染 data 为数组', !Array.isArray(corruptMem.data) && corruptMem.data.schemaVersion === 1);
check('顶层受损文件成功备份至 .bak', fs.existsSync(badMemPath + '.bak'));
try { fs.rmSync(corruptDir, { recursive: true, force: true }); } catch {}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
