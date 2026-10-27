/**
 * test/v18-vision.test.js
 *
 * v1.8-b 门禁：**屏幕局部视觉探针（框选）**。
 *
 * ## 事实更正（2026-10-20 实测）
 *   旧结论「DeepSeek 纯文本，发图必 400」是**过期信息**。
 *   实测：deepseek-flash + image_url → HTTP 200，1×1 红色 PNG 回复「粉色」，
 *   prompt_tokens 223（纯文本仅几十）。官方文档确认支持 JPEG/PNG/GIF/WebP。
 *   但 deepseek-v4-pro 仍不支持（400）。
 *
 * ## 隐私铁律（每条都有独立断言）
 *   1. 只做用户框选，绝不做全屏 / 活动窗口
 *   2. 只在显式唤起时截，**绝不后台定时截屏**
 *   3. 图不落盘、不进历史、不进经历
 *   4. 审计只记尺寸/耗时/成败，不记像素与 OCR
 *   5. 无 vision 能力时**显式失败**，绝不假装看过
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const vision = require('../src/vision');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const brainSrc = fs.readFileSync(path.join(ROOT, 'src', 'brain.js'), 'utf8');
const memSrc = fs.readFileSync(path.join(ROOT, 'src', 'memory.js'), 'utf8');
const regSrc = fs.readFileSync(path.join(ROOT, 'src', 'provider-registry.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('--- v1.8-b 屏幕视觉探针门禁 ---');

/* ============ 1. 🔴 vision 能力判定（宁可保守） ============ */

check('🔴 deepseek-flash 支持 vision', vision.modelSupportsVision('deepseek-flash') === true);
check('🔴 deepseek-v4-pro 不支持 vision', vision.modelSupportsVision('deepseek-v4-pro') === false);
check('🔴 v3 系不支持（纯文本）', vision.modelSupportsVision('deepseek-v3.2') === false);
check('🔴 r1 系不支持', vision.modelSupportsVision('deepseek-r1') === false);

// 无法识别的模型名一律保守拒绝
for (const m of ['', null, undefined, 'gpt-4o', 'unknown-model', 'qwen-max']) {
  check('🔴 无法识别的模型保守拒绝: ' + JSON.stringify(m),
    vision.modelSupportsVision(m) === false);
}

/* ============ 2. 矩形校验 ============ */

check('正常矩形通过',
  !!vision.normalizeRect({ x: 10, y: 10, width: 100, height: 100 }));

check('🔴 小于 16×16 拒绝（防误触）',
  vision.normalizeRect({ x: 0, y: 0, width: 15, height: 15 }) === null);

check('🔴 非数字拒绝', vision.normalizeRect({ x: 'a', y: 0, width: 100, height: 100 }) === null);
check('🔴 null 拒绝', vision.normalizeRect(null) === null);
check('🔴 数组拒绝', vision.normalizeRect([1, 2, 3, 4]) === null);

// 负宽高（反向拖拽）要归一化
{
  const r = vision.normalizeRect({ x: 100, y: 100, width: -50, height: -50 });
  check('🔴 反向拖拽归一化成正矩形',
    r && r.x === 50 && r.y === 50 && r.width === 50 && r.height === 50,
    JSON.stringify(r));
}

// 越界裁剪
{
  const r = vision.normalizeRect({ x: -20, y: -20, width: 100, height: 100 },
    { maxW: 1920, maxH: 1080 });
  check('🔴 越界部分被裁剪（不报错，裁到可用范围）',
    r && r.x === 0 && r.y === 0 && r.width === 80 && r.height === 80,
    JSON.stringify(r));
}

/* ============ 3. 缩放 ============ */

{
  const big = vision.fitCaptureSize(3840, 2160);
  check('🔴 超大图缩到短边 ≤ 1024', Math.min(big.width, big.height) <= 1024,
    big.width + '×' + big.height);
  check('🔴 缩放保持比例', Math.abs((big.width / big.height) - (3840 / 2160)) < 0.02);

  const small = vision.fitCaptureSize(800, 600);
  check('小图不缩放', small.scaled === false && small.width === 800);
}

/* ============ 4. 🔴 图片附加（不可变、只影响本次请求） ============ */

{
  const DATA_URL = 'data:image/png;base64,AAAA';
  const msgs = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '早先' },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '你看这个' }
  ];
  const snapshot = JSON.stringify(msgs);

  const out = vision.attachImageToLastUser(msgs, DATA_URL);

  check('🔴 返回新数组（原数组不被修改）', JSON.stringify(msgs) === snapshot);

  const last = out[out.length - 1];
  check('🔴 最后一条是 user', last.role === 'user');
  check('🔴 content 变成数组', Array.isArray(last.content));
  check('🔴 数组含 text 块', last.content.some((c) => c.type === 'text'));
  check('🔴 数组含 image_url 块', last.content.some((c) => c.type === 'image_url'));
  check('🔴 image_url.url 就是要发的 data URL',
    last.content.find((c) => c.type === 'image_url').image_url.url === DATA_URL);

  // 历史里那条旧的 assistant 不能被动
  check('🔴 前面的消息原样保留',
    out[1].content === '早先' && out[2].content === '嗯');

  // 没有 user 消息时不凭空造
  const noUser = [{ role: 'system', content: 'S' }];
  check('🔴 没有 user 消息时原样返回（不造消息）',
    vision.attachImageToLastUser(noUser, DATA_URL) === noUser);

  // 重复附加不应叠第二张
  const twice = vision.attachImageToLastUser(out, DATA_URL);
  const lastTwice = twice[twice.length - 1];
  check('🔴 重复附加不叠第二张图',
    lastTwice.content.filter((c) => c.type === 'image_url').length === 1);
}

/* ============ 5. 事实行只陈述尺寸，不描述内容 ============ */

{
  const note = vision.formatVisionNote(800, 600);
  check('🔴 事实行含尺寸', note.includes('800') && note.includes('600'), note);
  check('🔴 事实行不含"内容/显示/上面写"等描述词',
    !/内容|显示|写着|画着|上面是/.test(note), note);
  check('🔴 缺尺寸时降级为不带尺寸的说法',
    vision.formatVisionNote(0, 0) === '【你看到了一块屏幕区域】');
}

/* ============ 6. 🔴 隐私铁律：绝不后台定时截屏 ============ */

{
  // 把 capturePage 附近的代码段取出来，检查有没有定时器驱动
  const idx = mainSrc.indexOf("ipcGuard.handle('vision:capture'");
  const seg = idx >= 0 ? mainSrc.slice(idx, idx + 4000) : '';
  check('vision:capture handler 存在', seg.length > 0);

  const noComment = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('🔴 截图代码里没有 setInterval（禁后台定时截屏）',
    !noComment.includes('setInterval'));
  check('🔴 截图代码里没有 setTimeout 驱动的重复截图',
    !/setTimeout\([^)]*capture/i.test(noComment));
}

/* ============ 7. 🔴 图不落盘 ============ */

{
  const idx = mainSrc.indexOf("ipcGuard.handle('vision:capture'");
  const end = mainSrc.indexOf("ipcGuard.handle('vision:stage'");
  const seg = idx >= 0 && end > idx ? mainSrc.slice(idx, end) : '';
  const noComment = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('🔴 截图函数内不写任何文件（无 fs.write / writeFileSync / createWriteStream）',
    !/fs\.write|writeFileSync|createWriteStream/.test(noComment),
    '图只存在内存，用完即弃');
}

/* ============ 8. 🔴 审计不记像素与 OCR ============ */

{
  const idx = mainSrc.indexOf('function appendVisionAudit');
  const seg = idx >= 0 ? mainSrc.slice(idx, idx + 1200) : '';
  check('appendVisionAudit 存在', seg.length > 0);
  check('🔴 审计字段只有尺寸/耗时/token/错误类别',
    /width/.test(seg) && /height/.test(seg) && /elapsedMs/.test(seg));
  check('🔴 审计不含像素/base64/OCR 文本字段',
    !/dataUrl|base64|pixels|ocr|text/i.test(
      seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    ));
}

/**
 * 🔴 2026-10-27 补：失败分支必须留痕。
 *
 * 修之前只有成功那条写 `stage:'captured'`，四个失败分支全裸 return ——
 * 出问题时审计只能看到"用户点了、没成功、没有下文"，答不了"为什么失败"。
 *
 * ⚠️ 判据必须**剥注释再扫**：本节注释里正写着这些 errorType 名字，
 * 不剥就等于让警示语自己通过检查。
 */
{
  const start = mainSrc.indexOf("ipcGuard.handle('vision:capture'");
  /* 🔴 区间必须精确到 capture 自己的函数体末尾。
   *
   *   首版把终点写成下一个 `vision:peek`，结果把 openPicker / stage / peek
   *   三个**别的 handler** 的裸 return 也算了进来（实测误报 7 处）。
   *   那不是本次要修的范围，硬改成 fail() 是越界改动。
   *   改用「handler 结束的 `});` + 后续注释块起点」定位。
   */
  const endMark = start >= 0 ? mainSrc.indexOf('打开全屏框选窗', start) : -1;
  const body = (start >= 0 && endMark > start) ? mainSrc.slice(start, endMark) : '';
  const noComment = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  check('（对照）vision:capture 函数体取到了', body.length > 500, 'len=' + body.length);

  // 四个失败 errorType 都必须经由 fail()，不能裸 return
  for (const et of ['bad_rect', 'no_screen_source', 'capture_failed', 'capture_threw']) {
    check('🔴 失败分支留痕: ' + et,
      new RegExp("fail\\('" + et + "'\\)").test(noComment),
      '裸 return 会让审计失去失败原因');
  }

  /* 反向对照：除 fail() 内部那一行外，capture 体里不得再有裸 return { ok: false }。
   * fail() 自身的 `return { ok: false, errorType };` 是合法出口，先剥掉再数。 */
  const stripped = noComment.replace(/return\s*\{\s*ok:\s*false,\s*errorType\s*\};/, '');
  const bareReturns = stripped.match(/return\s*\{\s*ok:\s*false/g) || [];
  check('🔴 capture 体内不存在裸 return 的失败分支（全部走 fail()）',
    bareReturns.length === 0, '残留 ' + bareReturns.length + ' 处');

  /* 🔴 光"调用了 fail()"不够 —— 还必须证明 fail() 内部真的写了审计。
   *   否则有人在 fail() 里删掉 appendVisionAudit，上面五条全绿而功能已失效。
   *   （此条是补的：手工变异时发现 fail() 被掏空仍能全绿）
   *
   * ⚠️ 取值范围必须**精确到 fail 函数的闭合 `};`**：
   *   首版傻切 400 字符，越界取到了后面的 `opts.rect,`，误报"记了坐标"。
   */
  const failIdx = noComment.indexOf('const fail =');
  const failEnd = failIdx >= 0 ? noComment.indexOf('};', failIdx) : -1;
  const failBody = (failIdx >= 0 && failEnd > failIdx)
    ? noComment.slice(failIdx, failEnd + 2) : '';
  check('（对照）fail() 函数体取到了', failBody.length > 60, 'len=' + failBody.length);
  check('🔴 fail() 内部确实调用 appendVisionAudit（不是空壳）',
    /appendVisionAudit\s*\(/.test(failBody), 'fail 被掏空则审计在失败时全部丢失');
  check('🔴 fail() 写入的 stage 为 failed（与成功态 captured 可区分）',
    /stage:\s*'failed'/.test(failBody));
  check('🔴 fail() 的审计不含矩形坐标（坐标泄露屏幕内容线索）',
    !/\b(x|y|rect|width|height)\s*[:,]/.test(failBody.replace(/errorType/g, '')),
    '只记 errorType 与耗时，不记 x/y/width/height');
}

/* ============ 9. 接线 ============ */

check('🔴 provider-registry 的 deepseek vision 已改为 true',
  /providerId: 'deepseek'[\s\S]{0,1200}?vision: true/.test(regSrc),
  'deepseek 注册项的 capabilities.vision 必须是 true');

/* 🔴 2026-10-27 改写：原断言名为「brain 在 build 之前附加图片」，
 *   但它实际匹配的是「takeVisionPick() 之后 600 字符内出现 attachImageToLastUser」——
 *   而旧代码里这两句都在 build **之后**，名字与判据本就不一致（旧代码从未在 build 前附加）。
 *   修复「事实行错位一轮」后，正确的时序是**两段**，故拆成两条各自钉住：
 *     ① 事实行必须在 build 之前写好（否则 build 内部的 _visionNote() 取不到，差一轮）；
 *     ② 图片必须在 build 之后附加（它改的是 build 的产出）。
 *   两条都用「相对位置」判定，不用固定字符距离（字符距离会随注释增删而误报）。 */
{
  const iPick = brainSrc.indexOf('const visionPick = this.takeVisionPick()');
  const iNote = brainSrc.indexOf('this.pendingVisionNote = visionMod.formatVisionNote');
  const iBuild = brainSrc.indexOf('let messages = this.memory.build(dynamicContext)');
  const iAttach = brainSrc.indexOf('attachImageToLastUser(messages');

  check('（对照）brain 里四个关键位置都取到了',
    iPick > 0 && iNote > 0 && iBuild > 0 && iAttach > 0,
    'pick=' + iPick + ' note=' + iNote + ' build=' + iBuild + ' attach=' + iAttach);

  check('🔴 事实行在 build **之前**写好（否则 build 取不到，错位一轮）',
    iNote > 0 && iBuild > 0 && iNote < iBuild,
    'note@' + iNote + ' 必须 < build@' + iBuild);

  check('🔴 图片在 build **之后**附加（它改的是 build 的产出）',
    iAttach > 0 && iBuild > 0 && iAttach > iBuild,
    'attach@' + iAttach + ' 必须 > build@' + iBuild);
}

check('🔴 无 vision 能力时显式失败（不静默丢图）',
  /MODEL_HAS_NO_VISION/.test(brainSrc));

check('🔴 memory 的 tail 顺序含 vision（reunion 之后、suffix 之前）',
  /\[bedsideNote,\s*selfNote,\s*reunionNote,\s*visionNote,\s*suffix\]/.test(memSrc));

check('🔴 brain 接线 vision provider',
  brainSrc.includes('setVisionProvider(() => this.takeVisionNote())'));

/* ============ 9.5 UI 接线与隐私入口 ============ */

{
  const idxHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const petSrc = fs.readFileSync(path.join(ROOT, 'pet.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const pickerHtml = fs.readFileSync(path.join(ROOT, 'vision-picker.html'), 'utf8');
  const pickerJs = fs.readFileSync(path.join(ROOT, 'vision-picker.js'), 'utf8');
  const pickerWinSrc = fs.readFileSync(path.join(ROOT, 'src', 'vision-picker-window.js'), 'utf8');

  check('🔴 右键菜单有「看看这个」入口',
    /data-act="vision"/.test(idxHtml));

  check('🔴 菜单 act 分发处理 vision',
    /act === 'vision'/.test(petSrc));

  /* 🔴 2026-10-20 重做后的架构守卫。
   *
   *   第一版把遮罩寄生在主窗里，用户实测「点了一下直接出了个小方块，然后不可操作」：
   *     ① 主窗只有 256×320，inset:0 只能覆盖窗口，框不到屏幕；
   *     ② pet.js 的 updateMouseIgnore 只认 #pet/#menu/#bubble/.panel/#chatStream，
   *        遮罩不在白名单 ⇒ setIgnoreMouseEvents(true) ⇒ 拖拽事件收不到。
   *   现改为**独立全屏窗**，所以断言必须指向新架构，不能再测已删除的 __beginVisionPick。 */
  check('🔴 菜单入口改为开独立全屏框选窗（不再寄生主窗）',
    /act === 'vision'[\s\S]{0,300}openPicker/.test(petSrc));

  check('🔴 主窗里不再残留旧的内联遮罩（installVisionPicker 已删）',
    !petSrc.includes('installVisionPicker') && !petSrc.includes('__beginVisionPick'));

  check('🔴 框选窗是独立全屏窗口并加载专用 preload（全屏 + 透明 + 置顶）',
    /width:\s*bounds\.width[\s\S]{0,400}transparent:\s*true[\s\S]{0,400}alwaysOnTop:\s*true/.test(pickerWinSrc)
    && pickerWinSrc.includes('vision-picker-preload.js'));

  /* 🔴 2026-10-21 修：原断言是「用完即毁（destroy）」，
   *   但实测 destroy 会把进程卡死（渲染进程正在派发事件时双向等待）。
   *   现在改成 **hide + 复用**：用户立刻脱困（实测 7ms），代价是隐藏窗口常驻几十 MB。
   *   断言据此改成「必须 hide，且代码里不得真的调用 destroy」——
   *   ⚠️ 判据要剥掉注释：本文件注释里正写着「不要 destroy」，不剥会把警示当成违规。 */
  {
    const noComment = pickerWinSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const closeFn = (() => {
      const i = noComment.indexOf('function closeVisionPicker');
      if (i < 0) return '';
      let depth = 0, started = false;
      for (let k = i; k < noComment.length; k++) {
        if (noComment[k] === '{') { depth++; started = true; }
        else if (noComment[k] === '}') { depth--; if (started && depth === 0) return noComment.slice(i, k + 1); }
      }
      return noComment.slice(i);
    })();

    check('🔴 closeVisionPicker 真的调用了 hide()',
      closeFn.includes('.hide('), 'closeFn 长度=' + closeFn.length);

    check('🔴 closeVisionPicker 里不调用 destroy（实测会卡死进程）',
      !/\.destroy\(/.test(closeFn), '命中即等于把进程锁死');

    check('🔴 有 hiddenPicker 复用机制（不新建窗口、不泄漏）',
      pickerWinSrc.includes('hiddenPicker'));
  }

  check('🔴 框选页 ESC 可取消', /Escape[\s\S]{0,80}finish/.test(pickerJs));

  check('🔴 矩形小于 16 时前端也拒（与主进程同口径）',
    /MIN_SIDE\s*=\s*16/.test(pickerJs) && pickerJs.includes('w < MIN_SIDE'));

  check('🔴 框选页不自己算窗口偏移（全屏窗的坐标就是屏幕坐标）',
    !/addEventListener\('mouseup'[\s\S]{0,600}winPos/.test(pickerJs));

  // 🔴 框选窗必须在 IPC 信任白名单里，否则它连自己的截图/关闭都调不通
  //   （2026-10-21 实测事故：拖框不提交、ESC 关不掉、进程锁死）
  check('🔴 框选窗在 IPC 信任白名单内（否则所有 IPC 被拒）',
    /getTrustedWebContents:[\s\S]{0,1400}vision-picker-window/.test(mainSrc),
    '不在白名单 = 拖框不提交 + ESC 关不掉 + 进程锁死');

  check('🔴 框选窗通道守卫覆盖所有 IPC 且只放行实际四通道',
    mainSrc.includes('authorizeChannel: (event, channel) => assertChannelAllowedForPicker(event, channel)')
    && /const VISION_ONLY_CHANNELS = new Set\(\[[\s\S]*?'vision:capture'[\s\S]*?'vision:stage'[\s\S]*?'vision:close-picker'[\s\S]*?'vision-notify'[\s\S]*?\]\);/.test(mainSrc)
    && !/VISION_ONLY_CHANNELS[\s\S]{0,180}'vision:pending'/.test(mainSrc)
    && !/VISION_ONLY_CHANNELS[\s\S]{0,180}'vision:capability'/.test(mainSrc));

  check('🔴 主进程侧有 ESC 逃生门（不依赖渲染层 IPC）',
    /before-input-event[\s\S]{0,300}Escape/.test(pickerWinSrc));

  const pickerPreloadSrc = fs.readFileSync(path.join(ROOT, 'vision-picker-preload.js'), 'utf8');
  const pickerPreloadChannels = [...pickerPreloadSrc.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)]
    .map((m) => m[1]);
  check('🔴 主窗 preload 保持视觉能力、框选窗 preload 仅暴露四个通道',
    /vision:\s*\{[\s\S]{0,500}capture[\s\S]{0,300}stage[\s\S]{0,300}openPicker/.test(preloadSrc)
    &&
    pickerPreloadChannels.length === 4
    && ['vision:capture', 'vision:stage', 'vision:close-picker', 'vision-notify']
      .every((channel) => pickerPreloadChannels.includes(channel)));

  // 隐私红线：菜单入口不得直接调 capture（必须先框选）
  check('🔴 菜单入口不直接截图（必须先框选）',
    !/act === 'vision'[\s\S]{0,200}api\.vision\.capture/.test(petSrc));

  // 打包闭包：新入口必须在三处白名单里，否则打出来的包打不开框选窗
  const builderYml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const asarSrc = fs.readFileSync(path.join(ROOT, 'tools', 'asar-check.js'), 'utf8');
  const releaseSrc = fs.readFileSync(path.join(ROOT, 'tools', 'release-check.js'), 'utf8');
  const exportSrc = fs.readFileSync(path.join(ROOT, 'tools', 'public-export.js'), 'utf8');

  check('🔴 electron-builder.yml 收进框选页及隔离 preload',
    builderYml.includes('vision-picker.html') && builderYml.includes('vision-picker.js')
    && builderYml.includes('vision-picker-preload.js'));
  check('🔴 asar-check 的必需入口含框选窗',
    asarSrc.includes('vision-picker.html') && asarSrc.includes('vision-picker-preload.js'));
  check('🔴 release-check 的运行入口含框选窗',
    releaseSrc.includes('vision-picker.html') && releaseSrc.includes('vision-picker-preload.js'));
  check('🔴 public-export 的 INCLUDE 含框选窗',
    exportSrc.includes('vision-picker.html') && exportSrc.includes('vision-picker.js')
    && exportSrc.includes('vision-picker-preload.js'));

  // 框选页自身的 CSP 与提示文案
  check('🔴 框选页有 CSP', /Content-Security-Policy/.test(pickerHtml));
  check('🔴 框选页有"拖一个框"提示（不再让人不知道要做什么）',
    pickerHtml.includes('拖一个框'));
}

/* ============ 9.6 🔴 待发送截图的可见反馈 ============ */

/**
 * 用户实测反馈（2026-10-21）：
 *   「那张图在截出来之后，对话框里找不到，也不会出现在输入框里，具有迷惑性」
 *
 * 根因：截图确实存进了 brain（功能是通的），但对话窗**零反馈** ——
 *   既无缩略图也无提示，用户看不到就只能以为没截到。
 * 修法：预览条（缩略图 + 尺寸 + 可移除）+ 发完自动收起。
 */
{
  const chatHtmlSrc = fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8');
  const chatJsSrc = fs.readFileSync(path.join(ROOT, 'chat.js'), 'utf8');
  const i18nSrc2 = fs.readFileSync(path.join(ROOT, 'ui-i18n.js'), 'utf8');

  check('🔴 对话窗有截图预览条 #visionBar',
    /id="visionBar"/.test(chatHtmlSrc));
  check('🔴 预览条有缩略图与移除按钮',
    /id="visionThumb"/.test(chatHtmlSrc) && /id="visionDrop"/.test(chatHtmlSrc));

  check('🔴 chat.js 有 syncVisionBar（刷新预览）',
    /function syncVisionBar/.test(chatJsSrc));
  check('🔴 chat.js 有 dropVisionPick（用户主动丢弃）',
    /function dropVisionPick/.test(chatJsSrc));

  // 发完消息必须收起预览（否则用户以为图还在，下一条又带一次）
  check('🔴 发送完成后自动收起预览条',
    /finally\s*\{[\s\S]{0,600}syncVisionBar\(\)/.test(chatJsSrc));

  check('🔴 主进程有 vision:peek（只读预览）与 vision:drop（丢弃）',
    mainSrc.includes("'vision:peek'") && mainSrc.includes("'vision:drop'"));

  check('🔴 brain 有 peekVisionPick（只读，不消费）',
    brainSrc.includes('peekVisionPick('));

  // peek 必须返回副本，不能把内部对象直接吐出去
  check('🔴 peekVisionPick 返回副本（不是内部引用）',
    /peekVisionPick\(\)\s*\{[\s\S]{0,400}return\s*\{\s*dataUrl:\s*p\.dataUrl/.test(brainSrc));

  check('🔴 预览文案中英双语齐备',
    (i18nSrc2.split("'vision.pendingMeta'").length - 1) >= 2);
}

/* ============ 10. 运行时：暂存与消费 ============ */

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v18-vision-'));
  let brain = null;
  try {
    const { Brain } = require('../src/brain');
    brain = new Brain(tmpDir, { persona: 'P', model: 'deepseek-flash' });
  } catch (e) {
    check('构造 Brain 失败: ' + e.message, false);
  }

  if (brain) {
    const pick = { dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 80 };

    check('初始无待送图', brain.hasVisionPick() === false);

    brain.stageVisionPick(pick);
    check('🔴 暂存成功', brain.hasVisionPick() === true);

    const got = brain.takeVisionPick();
    check('🔴 取出得到同一张图', got && got.dataUrl === pick.dataUrl);
    check('🔴 取出即清（一次性，不连续两轮都带图）',
      brain.hasVisionPick() === false);
    check('🔴 第二次取出为 null', brain.takeVisionPick() === null);

    // 非图片 dataUrl 必须拒
    check('🔴 非 image dataUrl 拒不接收',
      brain.stageVisionPick({ dataUrl: 'data:text/plain;base64,AA', width: 1, height: 1 }) === false);
    check('🔴 空值拒不接收', brain.stageVisionPick(null) === false);

    // 后到覆盖先到
    brain.stageVisionPick({ dataUrl: 'data:image/png;base64,AAAA', width: 1, height: 1 });
    brain.stageVisionPick({ dataUrl: 'data:image/png;base64,BBBB', width: 2, height: 2 });
    const latest = brain.takeVisionPick();
    check('🔴 只存一张：后到覆盖先到', latest && latest.dataUrl.endsWith('BBBB'));
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

/* ============ 11. 🔴 端到端：事实行必须出现在**带图那一轮** ============
 *
 * ## 为什么必须补这一节（2026-10-27 实测缺陷）
 *   上面 1~10 节全部在测「零件」：纯函数单测 + 源码字符串匹配。
 *   它们能证明 `formatVisionNote` 会拼字符串、能证明 `setVisionProvider` 这行接线存在，
 *   但**证明不了事实行真的进入了本轮 messages** —— 而那正是用户要的功能。
 *
 *   实测缺陷（本仓 2026-10-27 审核复现）：
 *     `brain.ask()` 里 `memory.build()` 先执行，其内部 `_visionNote()` 已把
 *     `pendingVisionNote` 取走并清空；而赋值写在 build **之后** ⇒ 永远差一轮。
 *     后果 ①：带图那轮模型收不到尺寸（不知道看的是多大一块）；
 *     后果 ②：下一轮没图，却收到上一轮的尺寸（**诱导编造看到了什么**）。
 *     后果 ③：连续带图时尺寸错配（第 N 轮收到第 N-1 轮的尺寸）。
 *
 * ## 判据口径
 *   真的起一个本地 mock server、真的调 `brain.ask()`、真的解析**发出去的请求体**。
 *   不读源码、不调私有方法 —— 只认线上跑出来的东西。
 *   ⚠️ 前缀复用已有的 'v18-vision-'：新增临时目录前缀会让 tmp-hygiene 的
 *      双向差集失配（源码多出前缀但留档清单没有），那是另一个门禁的事。
 */
{
  const http = require('http');
  const { Brain } = require('../src/brain');

  const sent = [];               // 每次请求的 messages
  const sockets = [];            // 活动连接，退出前必须主动销毁（见文件末尾注释）
  let server = null;

  const startMock = () => new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let msgs = [];
        try { msgs = JSON.parse(body).messages || []; } catch (e) { msgs = []; }
        sent.push(msgs);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: {} }],
          usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 1 }
        }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.on('connection', (s) => {
      sockets.push(s);
      s.on('close', () => {
        const i = sockets.indexOf(s);
        if (i >= 0) sockets.splice(i, 1);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });

  // 取最后一条 user 的「有没有图 / 正文」，与真实协议同形（content 可能是数组）
  const inspect = (msgs) => {
    let last = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') { last = msgs[i]; break; }
    }
    const c = last && last.content;
    if (Array.isArray(c)) {
      return {
        hasImage: c.some((p) => p && p.type === 'image_url'),
        text: c.filter((p) => p && p.type === 'text').map((p) => p.text).join('')
      };
    }
    return { hasImage: false, text: String(c || '') };
  };

  (async () => {
    let base = null;
    try {
      base = await startMock();
    } catch (e) {
      check('（环境）能为端到端用例起 mock server', false, e.message);
      return;
    }
    check('（环境）能为端到端用例起 mock server', !!base, base || '');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v18-vision-'));
    let brain = null;
    try {
      brain = new Brain(tmpDir, {
        apiKey: 'test', model: 'deepseek-flash', baseURL: base,
        windowTurns: 999, windowMaxTokens: 1e9, keepTailMessages: 6,
        memoryCapTokens: 1e9, price: { peak: {}, valley: {} }
      });
    } catch (e) {
      check('构造 Brain 失败: ' + e.message, false);
    }

    if (brain) {
      try {
        // 第 1 轮：无图（建立基线，确保不是"每轮都带事实行"）
        await brain.ask('第一句话', () => {});
        // 第 2 轮：带图 800×600
        brain.stageVisionPick({ dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 600 });
        await brain.ask('第二句话', () => {});
        // 第 3 轮：无图
        await brain.ask('第三句话', () => {});

        const r1 = inspect(sent[0] || []);
        const r2 = inspect(sent[1] || []);
        const r3 = inspect(sent[2] || []);

        check('（对照）三轮请求都真的发出去了', sent.length === 3, '实际 ' + sent.length + ' 次');

        check('🔴 基线：第 1 轮无图也无事实行',
          !r1.hasImage && !/你看到了一块/.test(r1.text));

        check('🔴 第 2 轮真的带上了图', r2.hasImage === true);

        /* 🔴 本缺陷的核心断言：带图那一轮必须同时带事实行。
         *   修复前这条是 FAIL —— 事实行要等到第 3 轮才出现。 */
        check('🔴 带图那一轮同时带上事实行（修前 FAIL：错位一轮）',
          /你看到了一块/.test(r2.text),
          '带图但无事实行 ⇒ 模型不知道看的是多大一块');

        check('🔴 事实行尺寸与本轮图一致（800×600，防错配）',
          /你看到了一块\s*800\s*×\s*600\s*的屏幕区域/.test(r2.text),
          '实测: ' + (r2.text.match(/【你看到了一块[^】]*】/) || ['(无)'])[0]);

        check('🔴 第 3 轮无图，不得残留上一轮的事实行（防诱导编造）',
          !/你看到了一块/.test(r3.text),
          '实测: ' + (r3.text.match(/【你看到了一块[^】]*】/) || ['(无)'])[0]);

        /* 连续带图时的尺寸错配：第 2 轮必须报第 2 轮的尺寸，不是第 1 轮的。
         * 单独再跑一组，避免与上面的 800×600 用例互相依赖。 */
        sent.length = 0;
        const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'v18-vision-'));
        const b2 = new Brain(tmp2, {
          apiKey: 'test', model: 'deepseek-flash', baseURL: base,
          windowTurns: 999, windowMaxTokens: 1e9, keepTailMessages: 6,
          memoryCapTokens: 1e9, price: { peak: {}, valley: {} }
        });
        b2.stageVisionPick({ dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 50 });
        await b2.ask('带图一', () => {});
        b2.stageVisionPick({ dataUrl: 'data:image/png;base64,BBBB', width: 200, height: 100 });
        await b2.ask('带图二', () => {});

        const c1 = inspect(sent[0] || []);
        const c2 = inspect(sent[1] || []);
        check('🔴 连续带图：第 1 轮尺寸为 100×50',
          /你看到了一块\s*100\s*×\s*50\s*的屏幕区域/.test(c1.text),
          '实测: ' + (c1.text.match(/【你看到了一块[^】]*】/) || ['(无)'])[0]);
        check('🔴 连续带图：第 2 轮尺寸为 200×100（不得是第 1 轮的）',
          /你看到了一块\s*200\s*×\s*100\s*的屏幕区域/.test(c2.text),
          '实测: ' + (c2.text.match(/【你看到了一块[^】]*】/) || ['(无)'])[0]);

        try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) {}
      } catch (e) {
        check('端到端用例执行异常: ' + e.message, false);
      }
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    /* ⚠️ 退出必须干净，否则门禁会把「崩溃」当成失败原因（实测踩过两次）。
     *
     *   ① `server.close(); process.exit()` 同步连写 ⇒ libuv 断言
     *      （UV_HANDLE_CLOSING, async.c:94），进程以 0xC0000409 崩掉。
     *   ② 改成 `server.close(cb)` 里再 exit ⇒ 仍然崩：keep-alive 连接还挂在 server 上，
     *      close() 只是「不再接受新连接」，旧连接未断，句柄仍在关闭中。
     *
     *   正确做法：先主动销毁所有活动连接，再 close，最后**不调 process.exit**
     *   （用 process.exitCode 让事件循环自然排空）。本文件其余部分不依赖 exit 时机。
     */
    const finish = () => {
      console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
      process.exitCode = failures ? 1 : 0;
    };
    if (server && server.listening) {
      for (const s of sockets) { try { s.destroy(); } catch (e) {} }
      server.close(() => finish());
    } else {
      finish();
    }
  })();
}
