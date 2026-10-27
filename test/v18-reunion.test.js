/**
 * test/v18-reunion.test.js
 *
 * v1.8-a 门禁：**重逢心境（主观时间）**。
 *
 * ## 这一块补的是什么
 *   她要知道「你离开了多久」。跨重启、跨休眠的事实，不是会话内计时。
 *
 * ## 🔴 核心纠偏：重逢是关系事件，不是进程事件
 *   桌宠常驻（关对话窗是 hide），绝大多数时候不重启。
 *   绑「应用启动」会让这功能几乎永不触发。
 *   正确触发点：**你下次开口说话时回头检查**。
 *
 * ## 三条铁律（各有独立断言）
 *   1. **只陈述时长，绝不推断作息**（不知道你是睡觉还是通宵）；
 *   2. **不进 system、不进 history**（只挂当轮尾部，护前缀缓存）；
 *   3. **一次性消费**（同一次离开只说一次）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REUNION_MIN_MS, HOUR_MS, formatReunionLine, evaluateReunion
} = require('../src/reunion');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const brainSrc = fs.readFileSync(path.join(ROOT, 'src', 'brain.js'), 'utf8');
const memSrc = fs.readFileSync(path.join(ROOT, 'src', 'memory.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.8-a 重逢心境门禁 ---');

/* ============ 1. 阈值与常量 ============ */

check('🔴 阈值是 6 小时', REUNION_MIN_MS === 6 * 60 * 60 * 1000, 'REUNION_MIN_MS=' + REUNION_MIN_MS);
check('HOUR_MS 常量正确', HOUR_MS === 3600000);

/* ============ 2. 三级时长格式化（边界逐条比对） ============ */

const H = HOUR_MS;
const D = 24 * H;

const FORMAT_CASES = [
  [6 * H, '【你离开了 6 小时】', '恰好 6 小时'],
  [8.5 * H, '【你离开了 8.5 小时】', '8.5 小时'],
  [23.5 * H, '【你离开了 23.5 小时】', '23.5 小时'],
  [24 * H, '【你离开了 1 天】', '恰好 24 小时'],
  [28 * H, '【你离开了 1 天 4 小时】', '1 天 4 小时'],
  [6 * D + 23 * H, '【你离开了 6 天 23 小时】', '6 天 23 小时'],
  [7 * D, '【你离开了 7 天】', '恰好 7 天'],
  [12 * D + 5 * H, '【你离开了 12 天】', '12 天（不带小时）'],
  [30 * D, '【你离开了 30 天】', '30 天']
];

for (const [ms, expect, label] of FORMAT_CASES) {
  const got = formatReunionLine(ms);
  check('🔴 格式化: ' + label, got === expect, 'got=' + JSON.stringify(got));
}

/* ============ 3. 🔴 铁律一：只陈述时长，绝不推断作息 ============ */

// 禁句表：任何一条出现都说明程序在替她推断/抒情
const FORBIDDEN = ['睡', '通宵', '等', '终于', '寂寞', '想你', '辛苦了', '早', '晚'];
for (const [ms, got, label] of FORMAT_CASES.map(([ms, e]) => [ms, formatReunionLine(ms)])) {
  const hit = FORBIDDEN.filter((w) => got.includes(w));
  check('🔴 禁句表（不含作息/抒情词）: ' + (got || '空'),
    hit.length === 0, hit.join(','));
}

/* ============ 4. 冷启动守卫 ============ */

{
  const v = evaluateReunion(null, Date.now());
  check('🔴 冷启动：lastSeenAt=null → 不判重逢', v.isReunion === false && v.coldStart === true);
  check('🔴 冷启动：awayMs 必须是 null（不是 0，不能拿 0 算差值）', v.awayMs === null);

  const v2 = evaluateReunion(undefined, Date.now());
  check('🔴 冷启动：undefined 同样安全', v2.coldStart === true);

  const v3 = evaluateReunion(0, Date.now());
  check('🔴 冷启动：0 也当首次（不能用 0 当时间戳）', v3.coldStart === true);

  const v4 = evaluateReunion(NaN, Date.now());
  check('🔴 冷启动：NaN 安全', v4.coldStart === true);
}

/* ============ 5. 阈值边界 ============ */

{
  const now = 1700000000000;
  const justBelow = evaluateReunion(now - (6 * H - 1), now);
  check('🔴 5.9999 小时 → 不判重逢', justBelow.isReunion === false, 'awayMs=' + justBelow.awayMs);

  const exact = evaluateReunion(now - 6 * H, now);
  check('🔴 恰好 6 小时 → 判重逢', exact.isReunion === true);

  // 时钟回拨：now 早于 lastSeen（用户改了系统时间）
  const back = evaluateReunion(now + H, now);
  check('🔴 时钟回拨（now < lastSeen）不判重逢、不抛', back.isReunion === false);
}

/* ============ 6. 🔴 铁律三：一次性消费（用真实 Brain） ============ */

/**
 * 🔴 临时目录卫生（本仓 tmp-hygiene.test.js 会扫这个）。
 *
 * 首版忘了清理，跑一次留一个 v18-reunion-* 目录，实测残留 8 个。
 * 这里用 mkdtemp 登记 + exit 统一清理（与 d25 / d17 等套件同款手法）。
 */
const _hygDirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _hygDirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _hygDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 清理失败不掀桌 */ }
  }
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v18-reunion-'));
let brain = null;
try {
  const { Brain } = require('../src/brain');
  brain = new Brain(tmpDir, { persona: 'P' });
} catch (e) {
  check('构造 Brain 失败: ' + e.message, false);
}

if (brain) {
  const now = Date.now();

  // 6a. 冷启动：第一次取，不返回任何内容，且把时间初始化
  brain.stats.lastSeenAt = undefined;
  const first = brain.takeReunionNote(now);
  check('🔴 冷启动不注入任何事实行', first === '', 'got=' + JSON.stringify(first));
  check('🔴 冷启动后 lastSeenAt 被初始化为当前时间',
    brain.getLastSeenAt() === now, 'lastSeenAt=' + brain.getLastSeenAt());

  // 6b. 8 小时后再取 → 有内容
  brain.stats.lastSeenAt = now - 8 * H;
  const r1 = brain.takeReunionNote(now);
  check('🔴 8 小时后返回事实行', r1 === '【你离开了 8 小时】', 'got=' + JSON.stringify(r1));

  // 6c. 立刻再取 → 一次性，第二次为空
  const r2 = brain.takeReunionNote(now);
  check('🔴 一次性：连续第二次为空', r2 === '', 'got=' + JSON.stringify(r2));

  // 6d. 不足 6 小时 → 不注入，但时间被刷新
  brain.stats.lastSeenAt = now - 3 * H;
  const r3 = brain.takeReunionNote(now);
  check('🔴 3 小时不注入（与 120 分钟自发便签不抢窗口）', r3 === '');
  check('🔴 未达阈值也会刷新时间（否则会一直停在很久以前）',
    brain.getLastSeenAt() === now);

  // 6e. touchLastSeen 会把 statsWriter 标脏
  brain.stats.lastSeenAt = 0;
  brain.touchLastSeen(now);
  check('🔴 touchLastSeen 写入 stats', brain.stats.lastSeenAt === now);
  check('🔴 touchLastSeen 走 DeferredWriter（不新开写盘路径）',
    brain.statsWriter.isDirty === true || typeof brain.statsWriter.markDirty === 'function');
}

/* ============ 7. 🔴 铁律二：不进 system / history ============ */

if (brain) {
  /* 造历史 + 当轮消息。
   *
   * ⚠️ 两处踩坑如实记录（都是判据/夹具写错，不是被测代码的问题）：
   *
   *   ① **append 签名是 (role, content, meta)，不是对象**。
   *      首版写 `append({ role:'user', content:'…' })` ⇒ 整个对象被当成 role，
   *      build 输出变成 `{ role: {role,content} }` 的怪形状，
   *      于是「找不到注入行」的断言全部误报。
   *
   *   ② **必须让当轮 user 在最后**。build 的挂点是从后往前找 role==='user'，
   *      若最后一条是 assistant，它会挂到历史里那条旧的 user 上（污染旧消息）。
   */
  brain.memory.append('user', '早先的一句');
  brain.memory.append('assistant', '嗯。');

  // 设成 8 小时前，让下次 build 产生重逢事实
  brain.stats.lastSeenAt = Date.now() - 8 * H;

  // 当轮 user 必须是最后一条（真实 chat 链路就是这样）
  brain.memory.append('user', '我回来了');

  // ⚠️ 实测：memory.build() 直接返回**消息数组**（不是 { msgs }）
  const before = brain.memory.build();

  check('build 返回数组', Array.isArray(before), 'type=' + typeof before);
  check('最后一条是当轮 user', before[before.length - 1].role === 'user',
    '实际 role=' + JSON.stringify(before[before.length - 1].role));

  const sysBefore = JSON.stringify(before[0]);
  check('🔴 system 角色确实是 system', before[0] && before[0].role === 'system');

  const histBefore = JSON.stringify(brain.memory.history);
  check('🔴 history 里不含重逢文本',
    !histBefore.includes('你离开了'), 'history 长度=' + brain.memory.history.length);

  // 反向对照：确认这次 build 真的注入了（否则上一条是假绿）
  const flat = (msgs) => msgs.map((m) => String(m.content || '')).join('\n');
  check('🔴 反向对照：本次 build 确实注入了重逢行',
    flat(before).includes('你离开了'), '未找到 —— 断言可能恒真');

  // 一次性：第二次 build 不该再出现（消费已刷新 lastSeenAt）
  const after = brain.memory.build();
  check('🔴 一次性：第二次 build 不再出现重逢行',
    !flat(after).includes('你离开了'), '第二次仍出现 —— 重复注入');

  // 前缀缓存：两次的 system 必须逐字节相等
  check('🔴 前缀缓存：system 逐字节不变（重逢不碰 system）',
    JSON.stringify(before[0]) === JSON.stringify(after[0]));

  // 挂点必须落在当轮 user 上，不能污染历史里那条旧的 user
  const oldUser = before.find((m) => m.role === 'user' && String(m.content || '').startsWith('早先的一句'));
  check('🔴 重逢行没有污染历史里那条旧的 user',
    oldUser && !String(oldUser.content).includes('你离开了'),
    oldUser ? '旧 user 内容=' + JSON.stringify(oldUser.content) : '找不到旧 user');
}

/* ============ 8. 接线与职责划分 ============ */

check('🔴 memory 有 setReunionProvider（依赖注入，不直接碰 stats）',
  memSrc.includes('setReunionProvider('));
check('🔴 memory 有 _reunionNote 挂点', memSrc.includes('_reunionNote()'));
// ⚠️ 2026-10-20：v1.8-b 在 reunion 与 suffix 之间插入了 visionNote，
//   所以顺序断言必须跟着更新 —— 不是放宽，是承认新的事实元。
check('🔴 build 的 tail 顺序：bedside → selfNote → reunion → vision → suffix',
  /\[bedsideNote,\s*selfNote,\s*reunionNote,\s*visionNote,\s*suffix\]/.test(memSrc));

check('🔴 brain 初始化时接线 provider',
  brainSrc.includes('setReunionProvider(() => this.takeReunionNote())'));

check('🔴 物理互动算「见到」（activity IPC 里 touchLastSeen）',
  /ipcGuard\.on\('activity'[\s\S]{0,400}touchLastSeen\(\)/.test(mainSrc));

/**
 * 🔴 chat-send 里**不得**预刷时间。
 *
 * 为什么这条是致命的：chat-send → brain.chat() → memory.build() → takeReunionNote()。
 * 如果在入口先 touch，lastSeenAt 已被刷成"现在"，build 里算出的差值必然≈0
 * ⇒ 重逢永远不触发（功能看起来存在，实际 100% 失效）。
 *
 * ⚠️ 判据必须**剥注释**再扫：我在这段代码的注释里正写着
 * 「这里刻意不调 touchLastSeen()」，不剥注释会把警示本身当成违规。
 */
{
  const sendBody = (() => {
    const i = mainSrc.indexOf("ipcGuard.handle('chat-send'");
    if (i < 0) return '';
    // 取到下一个顶层 ipcGuard.handle / ipcGuard.on 为止
    const rest = mainSrc.slice(i + 10);
    const next = rest.search(/\nipcGuard\.(handle|on)\(/);
    return next < 0 ? rest : rest.slice(0, next);
  })();
  const noComment = sendBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  check('🔴 chat-send 里不预刷 lastSeenAt（否则重逢永不触发）',
    !noComment.includes('touchLastSeen('),
    '预刷会让 takeReunionNote 永远算不出离开时长');

  // 反向对照：确认这段体确实取到了东西，否则上面恒真
  check('（对照）chat-send 函数体取到了（否则上一条恒真）', sendBody.length > 200,
    'len=' + sendBody.length);
}

check('🔴 打开对话窗不算「见到」（panel/window-open 里无 touchLastSeen）',
  !/chat-window-open[\s\S]{0,300}touchLastSeen\(\)/.test(mainSrc));

/* ============ 9. 渲染层不持有时间戳 ============ */

{
  const renderers = ['chat.js', 'pet.js', 'preload.js'];
  const offenders = renderers.filter((f) => {
    try {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // 允许注释里提到，但代码里不许读写 lastSeenAt
      const noComment = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      return /lastSeenAt/.test(noComment);
    } catch (e) { return false; }
  });
  check('🔴 lastSeenAt 只在主进程维护（渲染层不持有副本）',
    offenders.length === 0, offenders.join(','));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
