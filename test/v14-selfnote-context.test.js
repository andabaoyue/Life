/**
 * test/v14-selfnote-context.test.js
 *
 * v1.4-a 门禁：自发便签素材供给与零污染防护
 *
 * ## 验证目标
 *   1. 真实形态 synthetic 消息整条丢弃（0 条进入素材，0 个程序指令泄漏）
 *   2. 严苛防污染：零 \d+ 分钟、零 HH:MM、零 [内部语气提示]、零 [此刻她想说的方向]、零 [自主感知触发]
 *   3. 坚决排除出生时刻与日期锚点（避免与「你不知道现在几点」产生认知冲突）
 *   4. 自我投射（selfLedger）与生理体感（internalRegulation）纯定性融入
 *   5. 上次自留便签（selfNotes）回响
 *   6. 既有边界守卫：拒绝模式、留言句式（「等你回来」）跑偏拦截、长度护栏、异常吞掉
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Brain } = require('../src/brain');

// 临时目录管理
const _dirs = [];
const _origMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...a) {
  const d = _origMkdtemp.apply(fs, a);
  _dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of _dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdtempSync = _origMkdtemp;
});

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function createBrain(completeImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-'));
  const b = new Brain(dir, { apiKey: 't', model: 'm', baseURL: 'http://127.0.0.1:1' });
  b.api = { complete: completeImpl };
  b.track = () => {};
  return b;
}

console.log('--- v1.4-a 自留便签素材供给与零污染防护门禁 ---');

(async () => {
  /* ============ 1. 真实形态 synthetic 夹具整条丢弃与零污染验证 ============ */
  {
    let captured = null;
    const b = createBrain(async (messages) => {
      captured = messages;
      return { text: '风吹过来很舒服。', usage: { total: 10 } };
    });

    // 填充 history：包含真实消息与真实形态的 synthetic 消息
    b.memory.append('user', '刚才把那个模块改完了，我去吃个饭。');
    b.memory.append('assistant', '好呀，快去吃吧~');

    // 真实形态 synthetic 消息夹具 1：含「用户已经离开 30 分钟」和各种提示标记
    const syntheticText1 = '[自主感知触发]：用户已经离开 30 分钟\n'
      + '[内部语气提示]：轻声问候或自言自语一句...\n'
      + '[此刻她想说的方向]：想提一句被留下的感觉（依恋渴望现在偏高）\n'
      + '（这只是倾向，不是她说过的话。请据此自己决定说什么，也可以什么都不说。）';
    b.memory.append('user', syntheticText1, { synthetic: true, source: 'proactive' });
    b.memory.append('assistant', '屋子里真安静呀。');

    // 真实形态 synthetic 消息夹具 2：含「离开 120 分钟」
    const syntheticText2 = '[自主感知触发]：用户已经离开 120 分钟\n'
      + '[内部语气提示]：安静了很久...\n'
      + '[此刻她想说的方向]：想留下点什么\n'
      + '（这只是倾向，不是她说过的话。请据此自己决定说什么，也可以什么都不说。）';
    b.memory.append('user', syntheticText2, { synthetic: true, source: 'proactive' });

    // 伪造尾部可能出现的程序块
    b.memory.append('user', '下午回来继续对齐测试。\n\n【此刻的环境知觉】\n感受到了被人轻轻碰了一下');
    b.memory.append('assistant', '好，等你回来。');

    await b.askForSelfNote({ intentKind: 'wantToLeaveSomething' });

    check('成功发起 api.complete 抓取 prompt', !!captured && captured.length === 2);
    const userMsg = captured && captured.find((m) => m.role === 'user');
    const promptText = userMsg ? userMsg.content : '';

    // 严苛判据 1：零程序时间数字
    const minuteMatches = promptText.match(/\d+\s*分钟/g);
    check('素材中零「N 分钟」程序计时数字', !minuteMatches, minuteMatches ? minuteMatches.join(', ') : '');

    // 严苛判据 2：零 HH:MM 时钟
    const clockMatches = promptText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g);
    check('素材中零 HH:MM / HH:MM:SS 时钟数字', !clockMatches, clockMatches ? clockMatches.join(', ') : '');

    // 严苛判据 3：零程序提示标签
    check('素材中无 [内部语气提示]', !promptText.includes('[内部语气提示]'));
    check('素材中无 [此刻她想说的方向]', !promptText.includes('[此刻她想说的方向]'));
    check('素材中无 [自主感知触发]', !promptText.includes('[自主感知触发]'));
    check('素材中无「这只是倾向，不是她说过的话」', !promptText.includes('这只是倾向'));
    check('素材中无「用户已经离开」', !promptText.includes('用户已经离开'));

    // 真实对话保留与剥块
    check('真实用户消息被保留进对话痕迹', promptText.includes('下午回来继续对齐测试。'));
    check('真实用户消息尾部的【此刻的环境知觉】被剥除', !promptText.includes('感受到了被人轻轻碰了一下'));
    check('对话痕迹包含前序真实对话', promptText.includes('刚才把那个模块改完了'));
  }

  /* ============ 2. 排除出生时刻与日期锚点 ============ */
  {
    let captured = null;
    const b = createBrain(async (messages) => {
      captured = messages;
      return { text: '安静下来真好。', usage: { total: 5 } };
    });
    // 人为设定出生时刻
    b.birthAt = Date.parse('2026-10-01T16:48:39+08:00');

    await b.askForSelfNote({ intentKind: 'wantToLeaveSomething' });
    const promptText = captured && captured[1] ? captured[1].content : '';

    check('排除【出生时刻】段落', !promptText.includes('【出生时刻】'));
    check('排除「出生时刻（本地时间）」行', !promptText.includes('出生时刻（本地时间）'));
    check('排除秒级时间戳（16:48:39）', !promptText.includes('16:48:39'));
    check('排除【现实客观时钟】/ 日期锚点', !promptText.includes('【现实客观时钟】'));
  }

  /* ============ 3. 自我投射、生理体感与可塑性纯定性注入 ============ */
  {
    let captured = null;
    const b = createBrain(async (messages) => {
      captured = messages;
      return { text: '记下这一笔。', usage: { total: 5 } };
    });

    // 模拟自我投射条目
    if (b.selfLedger) {
      b.selfLedger.entries = [
        {
          trait: 'quiet_preference',
          support: [{ sourceType: 'chat', quote: '我喜欢安静一点' }],
          oppose: []
        }
      ];
    }
    // 模拟生理体感
    if (b.internalRegulation) {
      b.internalRegulation.enabled = true;
      b.internalRegulation.restPressure = 60; // 身体有些乏了
      b.internalRegulation.energy = 90;       // 精力充沛
    }
    // 模拟可塑性
    if (b.subjectState) {
      b.subjectState.data = { history: [{ plasticityMultiplier: 0.95 }] };
    }

    await b.askForSelfNote({ intentKind: 'wantToLeaveSomething' });
    const promptText = captured && captured[1] ? captured[1].content : '';

    check('包含【你此刻的自我倾向与状态】标题', promptText.includes('【你此刻的自我倾向与状态】'));
    check('包含纯定性可塑性描述（敏锐波动中）', promptText.includes('当前对新经历的特质吸收偏向：敏锐波动中'));
    check('包含生理感受（乏了/困倦）', promptText.includes('身体有些乏了'));
    check('包含自我投射（quiet_preference）', promptText.includes('quiet_preference'));
  }

  /* ============ 4. 上次自留便签回响 ============ */
  {
    let captured = null;
    const b = createBrain(async (messages) => {
      captured = messages;
      return { text: '今天也是这样。', usage: { total: 5 } };
    });

    b.memory.data.selfNotes = [
      {
        content: '昨夜下了一场小雨，桌角有些凉。',
        at: Date.now() - 3600000,
        source: 'selfNote'
      }
    ];

    await b.askForSelfNote({ intentKind: 'wantToLeaveSomething' });
    const promptText = captured && captured[1] ? captured[1].content : '';

    check('包含【你上次曾给自己写下】区块', promptText.includes('【你上次曾给自己写下】'));
    check('完整引述上次写下的便签内容', promptText.includes('昨夜下了一场小雨，桌角有些凉。'));
  }

  /* ============ 5. 既有边界守卫与留言句式跑偏拦截 ============ */
  {
    // 她说「不」等拒绝词必须返回 null
    const bRefuse = createBrain(async () => ({ text: '不想写', usage: null }));
    check('拒绝词「不想写」返回 null', (await bRefuse.askForSelfNote({})) === null);

    // 留言跑偏拦截：以「等你回来」等句式开头视为留言卡片，返回 null
    const bToUser1 = createBrain(async () => ({ text: '等你回来一起看日落呀', usage: null }));
    check('跑偏句式「等你回来…」拦截为 null', (await bToUser1.askForSelfNote({})) === null);

    const bToUser2 = createBrain(async () => ({ text: '等你忙完之后我们再聊', usage: null }));
    check('跑偏句式「等你忙完…」拦截为 null', (await bToUser2.askForSelfNote({})) === null);

    // 诗意/观察性长句（>12 字，非纯套话）即使含「等你回来」也绝不误伤放行
    const bPoetic = createBrain(async () => ({ text: '等你回来的时候，窗外的雨应该停了，我把灯给你留着。', usage: { total: 10 } }));
    const poeticRes = await bPoetic.askForSelfNote({ intentKind: 'wantToLeaveSomething' });
    check('长句观察便签不被 isToUser 误伤', poeticRes && poeticRes.content === '等你回来的时候，窗外的雨应该停了，我把灯给你留着。');

    // 正常自留句子正常放行
    const bNormal = createBrain(async () => ({ text: '光线从窗台斜切过来，屋里很静。', usage: { total: 10 } }));
    const normalRes = await bNormal.askForSelfNote({ intentKind: 'wantToLeaveSomething' });
    check('正常自留便签正常接收', normalRes && normalRes.content === '光线从窗台斜切过来，屋里很静。');
  }

  /* ============ 6. 单条长对话痕迹截断保护（防止 Token 膨胀） ============ */
  {
    let captured = null;
    const b = createBrain(async (messages) => {
      captured = messages;
      return { text: '记下这一笔。', usage: { total: 5 } };
    });
    const longMsg = '今天聊了很多关于数字生命的哲学议题，包括自我同一性与连续记忆的边界，'.repeat(3); // >100 字
    b.memory.append('user', longMsg);
    b.memory.append('assistant', '好。');

    await b.askForSelfNote({ intentKind: 'wantToLeaveSomething' });
    const promptText = captured && captured[1] ? captured[1].content : '';

    check('超长对话痕迹单条截断至 80 字以内并附带省略号', promptText.includes('…') && !promptText.includes(longMsg));
  }

  console.log('\n测试完成，失败总数: ' + failures);
  if (failures > 0) process.exit(1);
})();
