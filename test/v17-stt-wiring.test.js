/**
 * test/v17-stt-wiring.test.js
 *
 * v1.7-a 第 4 步门禁：**STT 接线**（IPC + 渲染层 + 设置面板）。
 *
 * ## 本文件守的是"接线对不对"，不是"传输层对不对"
 *   传输层已由 `test/v17-stt-transport.test.js` 覆盖（56 项）。
 *   这里只问一件事：**这条链有没有接错**，尤其是三条铁律有没有被后续改动破坏。
 *
 * ## 🔴 三条铁律（用户拍板 + 反重力审计确认）
 *   1. **识别结果只写进 `#input`，绝不自动发送**
 *      —— 语音识别必错，自动发送 = 程序替用户说话，污染 memory.history 的事实链；
 *   2. **失败静默**
 *      —— 只在 #chatHint 写一行，不弹 Modal、不打断打字；
 *   3. **绝不覆盖用户已打的字**
 *      —— 非空则追加。
 *
 * ## 为什么断言要按"函数边界"而不是"字符串区间"
 *   ⚠️ 首版区间切分踩过坑：用「STT 注释开头 → 关闭语义」当区间，
 *   结果把中间夹着的 `async function submit()` 定义与 `api.send()` 全切了进来，
 *   于是**基线自己就红**（见下方"判据校正"注释）。
 *   按函数边界取，判据才指向真正的被测代码。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(ROOT, 'chat.js'), 'utf8');
const chatHtml = fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
const uiI18nSrc = fs.readFileSync(path.join(ROOT, 'ui-i18n.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.7-a STT 接线门禁 ---');

/**
 * 取一个具名函数/方法体（从 `function name(` 或 `async function name(` 起，
 * 到下一个顶格 `\n}` 止）。用于把断言钉在**真正的被测函数**上，
 * 而不是一段可能误伤邻居的字符串区间。
 */
function fnBody(src, name) {
  // ⚠️ 用字符串拼正则（不用模板里的 \\s 转义）：本仓踩过转义层数不对导致
  //    正则恒不匹配、fnBody 恒返回 '' 的坑（那会让"不出现 submit"之类断言**恒真**）。
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return '';
  const start = m.index + m[0].length - 1;   // 指向 '{'
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

/** 反向对照：fnBody 必须真的能取到非空函数体，否则依赖它的断言全是恒真。 */
{
  const probe = fnBody(chatSrc, 'submit');
  check('（对照）fnBody 能取到函数体（否则依赖它的断言恒真）', probe.length > 100,
    'submit 体长=' + probe.length);
}

/* ================= 1. 铁律一：识别结果只入框，绝不自动发送 ================= */

const finishBody = fnBody(chatSrc, 'finishRecording');
const mergeBody = fnBody(chatSrc, 'mergeRecognizedText');

check('🔴 chat.js 存在 finishRecording（真正的识别收尾）', finishBody.length > 0);
check('🔴 chat.js 存在 mergeRecognizedText（文本并入入口）', mergeBody.length > 0);

/**
 * 剥掉注释再扫。
 *
 * ⚠️ 这不是洁癖：本仓既有守卫（`test/canalization.test.js` 的 P2-3c）就明确写过
 * 「剥掉注释再扫：守卫要拦的是被引用/被升级为机制，不是被提及」。
 * 本条也不例外 —— `finishRecording` 的注释里**故意**写了
 * 「绝不 submit()、绝不 api.send()」，那是给后来者看的警示。
 * 不剥注释就会把这条警示本身当成违规，守卫很快会被当成噪音删掉。
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

check('🔴 finishRecording 内不调用 submit（不自动发送）',
  finishBody.length > 0 && !/[^a-zA-Z_.]submit\s*\(/.test(stripComments(finishBody)),
  '命中即等于程序替用户按了回车');

check('🔴 finishRecording 内不调用 api.send（不直连对话通道）',
  finishBody.length > 0 && !stripComments(finishBody).includes('api.send('));

check('🔴 mergeRecognizedText 内不调用 submit / api.send',
  mergeBody.length > 0
  && !/[^a-zA-Z_.]submit\s*\(/.test(stripComments(mergeBody))
  && !stripComments(mergeBody).includes('api.send('));

check('🔴 finishRecording 确实把文本交给 mergeRecognizedText（不是丢了）',
  finishBody.includes('mergeRecognizedText('));

// 反向对照：submit 确实存在且仍在调用 api.send —— 证明"没调用"不是因为函数不存在
check('（对照）chat.js 里 submit 仍然调用 api.send（否则上一条是假绿）',
  fnBody(chatSrc, 'submit').includes('api.send('),
  'submit 若不再发消息，上面"finishRecording 不发送"就失去判别意义');

/* ================= 2. 铁律二：失败静默 ================= */

const wholeSttCode = finishBody + mergeBody + fnBody(chatSrc, 'startRecording')
  + fnBody(chatSrc, 'stopRecording') + fnBody(chatSrc, 'micHint') + fnBody(chatSrc, 'syncMicState');

check('🔴 STT 全链路不出现 alert(', !wholeSttCode.includes('alert('));
check('🔴 STT 全链路不出现 confirm(', !wholeSttCode.includes('confirm('));
check('🔴 失败提示走 micHint（只在 #chatHint 写一行）',
  fnBody(chatSrc, 'micHint').includes('chatHint'));
check('🔴 micHint 不清空输入框（不出现 input.value = \'\'）',
  !/input\.value\s*=\s*(''|""|``)/.test(fnBody(chatSrc, 'micHint')));

/* ================= 3. 铁律三：非空则追加，不覆盖 ================= */

check('🔴 mergeRecognizedText 读取了当前输入值（cur）', /const\s+cur\s*=/.test(mergeBody));
check('🔴 有「非空则追加」的分支（三元或 if 二选一）',
  /\?\s*\(([\s\S]{0,80}cur\s*\+)|if\s*\(\s*cur\s*\)/.test(mergeBody));
check('🔴 空输入时直接写入识别文本', /:\s*add|input\.value\s*=\s*add/.test(mergeBody));
check('🔴 追加时不粗暴覆盖（不出现 input.value = text 这种单一路径）',
  !/^\s*input\.value\s*=\s*String\(text\)/m.test(mergeBody));

/* ================= 4. IPC 通道与安全边界 ================= */

for (const ch of ['stt:get-config', 'stt:set-config', 'stt:clear-key', 'stt:transcribe']) {
  check('🔴 通道经 ipcGuard.handle 注册: ' + ch,
    mainSrc.includes("ipcGuard.handle('" + ch + "'"));
}

// 不允许裸 ipcMain.handle 新开 STT 通道（绕过 sender 校验）
check('🔴 STT 通道不走裸 ipcMain.handle',
  !/ipcMain\.handle\(\s*['"]stt:/.test(mainSrc));

// 🔴 transcribe 的入参不含 endpoint / apiKey（渲染层无权指定请求发往何处）
const transcribeHandler = (() => {
  const i = mainSrc.indexOf("ipcGuard.handle('stt:transcribe'");
  return i < 0 ? '' : mainSrc.slice(i, i + 2200);
})();
check('🔴 stt:transcribe handler 存在', transcribeHandler.length > 0);
check('🔴 transcribe 不从 opts 读 endpoint（端点只从主进程配置读）',
  !/opts\.endpoint/.test(transcribeHandler));
check('🔴 transcribe 不从 opts 读 apiKey（密钥只从凭据库读）',
  !/opts\.apiKey/.test(transcribeHandler) && !/opts\.credential/.test(transcribeHandler));
check('🔴 transcribe 从 readSttSecret 取密钥',
  transcribeHandler.includes('readSttSecret()'));
check('🔴 transcribe 失败只透 errorType（不透 safeDetail）',
  !/[^a-zA-Z_.]safeDetail\s*[:(]/.test(stripComments(transcribeHandler)),
  '注释里可以提 safeDetail（那是说明），但代码里不许把它放进返回值');

// get-config 绝不回 secret
const getCfgHandler = (() => {
  const i = mainSrc.indexOf("ipcGuard.handle('stt:get-config'");
  return i < 0 ? '' : mainSrc.slice(i, i + 900);
})();
check('🔴 stt:get-config 不回 apiKey / secret 字段',
  !/apiKey\s*:/.test(getCfgHandler) && !/secret\s*:/.test(getCfgHandler));
check('🔴 stt:get-config 只回 hasKey / encrypted 布尔',
  getCfgHandler.includes('hasKey') && getCfgHandler.includes('encrypted'));

/* ================= 5. 凭据隔离 ================= */

check('🔴 STT 用独立 credentialRef（cred:stt_api_key）',
  mainSrc.includes("'cred:stt_api_key'"));
check('🔴 STT 凭据不复用任何 conn_ ref',
  !/cred:conn_/.test(mainSrc.slice(mainSrc.indexOf('STT_CREDENTIAL_REF'), mainSrc.indexOf('STT_CREDENTIAL_REF') + 400)));
check('🔴 STT 配置写在独立文件（stt-config.json），不混入主配置',
  mainSrc.includes("stt-config.json"));
const sttWriter = fnBody(mainSrc, 'writeSttConfig');
check('🔴 STT 配置仅使用原子写，失败不回退普通覆盖写',
  sttWriter.includes('writeFileAtomic') && !/fs\.writeFileSync/.test(sttWriter));
const setSttConfigHandler = (() => {
  const i = mainSrc.indexOf("ipcGuard.handle('stt:set-config'");
  return i < 0 ? '' : mainSrc.slice(i, i + 900);
})();
check('🔴 STT 配置写失败返回稳定错误类型',
  /if\s*\(!saved\)[\s\S]{0,120}errorType:\s*'config_write_failed'/.test(setSttConfigHandler));
check('🔴 STT 配置写失败在设置 UI 显示中英文提示',
  petSrc.includes("r.errorType === 'config_write_failed'")
  && /'stt\.configSaveFailed':\s*'[^']+'/.test(uiI18nSrc)
  && /'stt\.configSaveFailed':\s*'[^']+'/.test(uiI18nSrc.slice(uiI18nSrc.indexOf("'stt.failed': 'Recognition failed'"))));

/* ================= 6. 前端按钮状态机 ================= */

check('🔴 chat.html 有 #micBtn', /id="micBtn"/.test(chatHtml));
check('🔴 麦克风按钮默认 disabled（未配置不可点）', /id="micBtn"[^>]*disabled/.test(chatHtml));
check('🔴 chat.js 实现 renderMicState（四态渲染）', fnBody(chatSrc, 'renderMicState').length > 0);
check('🔴 未配置时按钮置灰', /micState === 'disabled'[\s\S]{0,160}micBtn\.disabled = true/
  .test(fnBody(chatSrc, 'renderMicState')));
check('🔴 识别中不可点（防重入）', /transcribing[\s\S]{0,200}micBtn\.disabled = true/
  .test(fnBody(chatSrc, 'renderMicState')));
check('🔴 配置同步要求 Key + 端点 + 模型三者齐全', /hasKey[\s\S]{0,160}endpoint[\s\S]{0,160}model/
  .test(fnBody(chatSrc, 'syncMicState')));

/* ================= 7. 三条中断规则 ================= */

check('🔴 录音上限 60 秒', /MIC_MAX_MS\s*=\s*60\s*\*\s*1000/.test(chatSrc));
check('🔴 过短判误触（< 0.3 秒不发请求）', /MIC_MIN_MS\s*=\s*300/.test(chatSrc));
check('🔴 失焦丢弃当前录音', /addEventListener\('blur'[\s\S]{0,120}stopRecording\(true\)/
  .test(chatSrc) || /window\.addEventListener\('blur'[\s\S]{0,160}MIC_LOST_FOCUS_DISCARD/.test(chatSrc));
check('🔴 窗口隐藏也丢弃（visibilitychange）', /visibilitychange[\s\S]{0,200}stopRecording\(true\)/.test(chatSrc));
check('🔴 停止时必须释放音轨（否则麦克风指示灯不灭）',
  fnBody(chatSrc, 'stopMicTracks').includes('getTracks()')
  && fnBody(chatSrc, 'stopMicTracks').includes('stop()'));

/* ================= 8. 配置变更后自动同步按钮 ================= */

check('🔴 窗口 focus 时重新同步 mic 状态（配完 Key 切回即亮）',
  /addEventListener\('focus'[\s\S]{0,120}syncMicState\(\)/.test(chatSrc));
check('🔴 首次装载时同步一次', /^syncMicState\(\);$/m.test(chatSrc));

/* ================= 9. 设置面板 ================= */

check('🔴 index.html 有 STT 设置分组', /id="sttFgroup"/.test(indexHtml));
for (const id of ['sttPreset', 'sttUrl', 'sttModel', 'sttKey', 'sttLang', 'sttSave', 'sttClearKey', 'sttStatus']) {
  check('🔴 设置面板字段存在: #' + id, new RegExp('id="' + id + '"').test(indexHtml));
}
check('🔴 密钥输入框是 password 类型（不回显）',
  /id="sttKey"[^>]*type="password"/.test(indexHtml));

/**
 * 🔴 语音是**独立分区**（不再是塞在别处的一个 fgroup）。
 *
 * 为什么这条要断言：DeepSeek 没有 STT 端点，语音与对话是两件事。
 * 埋在「连接」或「沙盒」底下，用户会拿对话 Key 去填，然后在 401 上困惑。
 * 独立左侧分区本身就是一句"这是另一件事"。
 */
check('🔴 STT 有独立分区 psec[data-sec="voice"]',
  /<div class="psec" data-sec="voice">/.test(indexHtml));
check('🔴 左侧导航有「语音」项 data-sec="voice"',
  /data-sec="voice"[^>]*id="secVoice"/.test(indexHtml) || /id="secVoice"[^>]*data-sec="voice"/.test(indexHtml));
check('🔴 「语音」导航项有 i18n 键 sec.voice（双语）',
  (() => {
    // i18nSrc 在下方才声明，这里现读，避免 TDZ
    const s = fs.readFileSync(path.join(ROOT, 'ui-i18n.js'), 'utf8');
    return (s.split("'sec.voice'").length - 1) >= 2;
  })());
check('🔴 STT 面板不再嵌套在连接分区内（独立 psec 收口）',
  (() => {
    // ⚠️ 不能用裸 indexOf('data-sec="danger"')：左侧导航里也有一个
    //   `data-sec="danger" id="secDanger"`，会先被匹配到，导致判据错位。
    //   必须锚定**内容区**的分区开标签（class 里带 psec）。
    const connStart = indexHtml.indexOf('<div class="psec on" data-sec="conn">');
    const voiceStart = indexHtml.indexOf('<div class="psec" data-sec="voice">');
    const dangerStart = indexHtml.indexOf('<div class="psec danger-zone" data-sec="danger">');
    if (connStart < 0 || voiceStart < 0 || dangerStart < 0) return false;
    return voiceStart > connStart && voiceStart < dangerStart;
  })());

/**
 * 🔴 预设完整性守卫（2026-10-20 采纳建议后补）。
 *
 * `local` 预设原本是空串，用户选了之后是一片空白、不知道怎么填。
 * 现在给了可用的本地模板（127.0.0.1 + whisper-1）。
 * 这条守卫防止有人「顺手清空」把它退回不可用状态。
 */
{
  const presetBlock = (() => {
    const i = petSrc.indexOf('const STT_PRESETS');
    if (i < 0) return '';
    const j = petSrc.indexOf('function refreshSttPanel');
    return j > i ? petSrc.slice(i, j) : petSrc.slice(i, i + 1200);
  })();

  check('🔴 pet.js 有 STT_PRESETS 定义', presetBlock.length > 0);

  // 四家预设都得在
  for (const key of ['siliconflow', 'groq', 'openai', 'local']) {
    check('🔴 预设存在: ' + key, new RegExp('\\b' + key + '\\s*:').test(presetBlock));
  }

  // local 必须有可用的端点与模型（不是空串）
  const localMatch = presetBlock.match(/local\s*:\s*\{([^}]*)\}/);
  const localBody = localMatch ? localMatch[1] : '';
  check('🔴 local 预设给了可用端点（不是空串）',
    /endpoint\s*:\s*['"]http/.test(localBody), localBody.trim());
  check('🔴 local 预设给了模型名',
    /model\s*:\s*['"]\w/.test(localBody), localBody.trim());

  // 其余三家必须是 https（公网端点不许明文）
  for (const key of ['siliconflow', 'groq', 'openai']) {
    const m = presetBlock.match(new RegExp(key + '\\s*:\\s*\\{([^}]*)\\}'));
    const body = m ? m[1] : '';
    check('🔴 ' + key + ' 端点是 https', /endpoint\s*:\s*['"]https:\/\//.test(body));
  }
}

/**
 * 🔴 对话窗布局守卫：输入栏不得压住她的回话（2026-10-20 用户反馈）。
 *
 * 事故：用户说「输入框挡到初澜回话的文字了」。
 * 根因：style.css 里有一组宠物气泡时代遗留的 `#inputBar { position: absolute; bottom: 8px }`，
 * 而 chat.html 也引入了 style.css ⇒ 它覆盖掉 chat.html 自己的 `flex: none`，
 * 把输入栏从文档流里拽出来盖在消息上。
 * **那组规则是死代码**：index.html 里根本没有 #inputBar（实测 grep 零命中）。
 *
 * 判据：
 *   ① style.css 不得再声明 #inputBar 的定位规则（死代码已删）
 *   ② chat.html 的 #inputBar 必须是 flex: none（正常文档流）
 *   ③ 若将来主窗真要输入区，必须换新类名，不得复用 #inputBar
 */
{
  const cssSrc = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const cssNoComment = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');

  check('🔴 style.css 不再有 #inputBar 定位规则（死代码已删）',
    !/#inputBar\s*\{/.test(cssNoComment),
    '残留会让对话窗输入栏脱离文档流、盖住回话');

  check('🔴 style.css 不再有 #input / #send 的基础规则（避免污染对话窗）',
    !/^#input\s*\{/m.test(cssNoComment) && !/^#send\s*\{/m.test(cssNoComment));

  // chat.html 自己必须把输入栏放在文档流里
  const chatHtmlNoComment = chatHtml.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  check('🔴 chat.html 的 #inputBar 是 flex: none（在文档流里）',
    /#inputBar\s*\{[^}]*flex:\s*none/.test(chatHtmlNoComment));

  check('🔴 chat.html 的 #inputBar 不是绝对定位',
    !/#inputBar\s*\{[^}]*position:\s*absolute/.test(chatHtmlNoComment));

  // 主窗确实没有输入区（证明上面删的是死代码，不是误删活代码）
  const indexNoComment = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
  check('（对照）index.html 确实没有 #inputBar（证明删的是死代码）',
    !/id="inputBar"/.test(indexNoComment));
}

/**
 * 🔴 录音可靠性守卫（2026-10-20 真实使用中发现的缺陷 + 交互方式二次修订）。
 *
 * 用户实测「说了句你好，没有识别」，经真实链路排查确认传输层与凭据都正常，
 * 问题出在录音环节：
 *
 *   ① `rec.start()` 不传 timeslice ⇒ ondataavailable 只在 stop() 时触发一次。
 *      任何"提前停止"路径都可能拿到空 chunks。必须传 timeslice。
 *   ② 按住说话模式对鼠标极不友好：手一抖就离开按钮，
 *      旧代码还挂着按钮级 mouseleave ⇒ 录到一半被截断，且走"正常结束"而非丢弃，
 *      于是把半句话送去识别。
 *
 * 现行方案（用户拍板）：**点击开始 / 再点结束**，ESC 取消。
 *   - 手可以离开按钮，说话时不绷着；
 *   - 取消有明确出口（ESC），不会误以为"点第二下是丢弃"。
 */
{
  const startBody = fnBody(chatSrc, 'startRecording');
  check('🔴 rec.start 传了 timeslice（否则 stop 前可能没有数据）',
    /rec\.start\(\s*\d+\s*\)/.test(startBody),
    '实得: ' + (startBody.match(/rec\.start\([^)]*\)/) || ['未找到'])[0]);

  check('🔴 麦克风按钮用 click 切换（不是 mousedown/mouseup 按住）',
    /micBtn\.addEventListener\(\s*['"]click['"]/.test(chatSrc));

  check('🔴 不再有按钮级 mousedown 触发录音（按住模式已废弃）',
    !/micBtn\.addEventListener\(\s*['"]mousedown['"]/.test(chatSrc),
    '按住模式要求手不离按钮，实测易误触');

  check('🔴 麦克风按钮不监听 mouseleave（会把半句话截断）',
    !/micBtn\.addEventListener\(\s*['"]mouseleave['"]/.test(chatSrc));

  check('🔴 click 处理里区分 idle → 开始、recording → 结束',
    /micState === 'idle'[\s\S]{0,80}startRecording\(\)[\s\S]{0,160}micState === 'recording'[\s\S]{0,80}stopRecording\(false\)/
      .test(fnBody(chatSrc, 'renderMicState') + chatSrc));

  check('🔴 ESC 可取消录音（点击模式下必需的明确出口）',
    /Escape[\s\S]{0,120}stopRecording\(true\)/.test(chatSrc));

  check('🔴 取消走丢弃路径（stopRecording(true)），不送识别',
    /stopRecording\(true\)/.test(chatSrc));
}

/**
 * 🔴 录音审计留痕守卫（2026-10-20 真机排查需要）。
 *
 * 背景：用户反馈「说了话没识别」，但磁盘上**零痕迹**，
 * 无法判断卡在采集、IPC、还是识别阶段。加审计后每次录音都留一条，
 * 排查有据可查。
 *
 * 同时守住隐私边界：**只记元数据，绝不记音频内容与识别文本**。
 */
{
  check('🔴 finishRecording 每个失败分支都上报审计',
    (chatSrc.match(/auditStt\(/g) || []).length >= 4,
    '实得 ' + (chatSrc.match(/auditStt\(/g) || []).length + ' 处');

  check('🔴 成功分支也记审计（只记 textLen 不记文本）',
    /stage:\s*'ok'[\s\S]{0,160}textLen/.test(chatSrc));

  check('🔴 审计不含音频字节或识别文本字段',
    !/auditStt\(\{[^}]*(audio|text:\s)/.test(chatSrc));

  check('🔴 主进程注册了 stt-audit 通道（经 ipcGuard.on）',
    /ipcGuard\.on\(\s*['"]stt-audit['"]/.test(mainSrc));

  check('🔴 审计写入独立文件 stt-audit.jsonl',
    mainSrc.includes('stt-audit.jsonl'));

  check('🔴 preload 暴露 sttAudit',
    /sttAudit\s*:/.test(preloadSrc));
}

/**
 * 🔴 导航白名单死项守卫：
 *   pet.js 的 selectPanelSection(key) 用 PANEL_SECTIONS 白名单兜底：
 *   不在白名单里的 key 一律退回 'conn' —— 漏加白名单会导致用户点击左侧导航
 *   毫无反应（历史曾出过"时区点不出的病根"，今天由本守卫彻底封死）。
 */
check('🔴 pet.js 的 PANEL_SECTIONS 白名单包含 voice（防点不出）',
  /const\s+PANEL_SECTIONS\s*=\s*\[[^\]]*'voice'[^\]]*\]/.test(petSrc));
check('🔴 导航项 data-sec 与 PANEL_SECTIONS 双向差集为空', (() => {
  const m = /const\s+PANEL_SECTIONS\s*=\s*\[([^\]]+)\]/.exec(petSrc);
  if (!m) return false;
  const sections = m[1].replace(/['"\s]/g, '').split(',').filter(Boolean);
  const navMatches = [...indexHtml.matchAll(/class="pnav-item[^"]*"\s+data-sec="([^"]+)"/g)].map(x => x[1]);
  if (!sections.length || !navMatches.length) return false;
  const sSet = new Set(sections);
  const nSet = new Set(navMatches);
  const diff1 = sections.filter(x => !nSet.has(x));
  const diff2 = navMatches.filter(x => !sSet.has(x));
  return diff1.length === 0 && diff2.length === 0;
})());

/* ================= 10. preload 暴露面 ================= */

for (const m of ['getConfig', 'setConfig', 'clearKey', 'transcribe']) {
  check('🔴 preload 暴露 stt.' + m,
    new RegExp('stt:\\s*\\{[\\s\\S]{0,400}' + m + '\\s*:').test(preloadSrc));
}
check('🔴 preload 的 stt 块在 deskpet 命名空间内',
  preloadSrc.indexOf('stt: {') > preloadSrc.indexOf('exposeInMainWorld'));

/* ================= 11. i18n 双语齐备 ================= */

const i18nSrc = fs.readFileSync(path.join(ROOT, 'ui-i18n.js'), 'utf8');
for (const k of ['stt.notConfigured', 'stt.start', 'stt.stop', 'stt.listening',
  'stt.noSpeech', 'stt.denied', 'stt.noDevice', 'stt.failed']) {
  const cnt = i18nSrc.split("'" + k + "'").length - 1;
  check('🔴 i18n 双语键: ' + k + '（' + cnt + ' 次）', cnt >= 2, 'cnt=' + cnt);
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
