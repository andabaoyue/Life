"""真实交互测试：打字 -> 发送 -> 逐字上屏 -> 记录写入

需要静态服务器指向项目根目录。默认假设 127.0.0.1:8000；
test/docs.test.js 会自己起一个并通过 DESKPET_URL 传进来。
"""
import os
from playwright.sync_api import sync_playwright

URL = os.environ.get("DESKPET_URL", "http://127.0.0.1:8000") + "/index.html"
# 可用 DESKPET_CHROME 指定浏览器路径；不设则先试 /usr/bin/chromium，
# 再回落到 Playwright 自带的 chromium（Windows/Mac 机器通常走这条）。
_env = os.environ.get("DESKPET_CHROME")
_candidates = [_env] if _env else [
    "/usr/bin/chromium",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    None
]
CHROME = next((c for c in _candidates
               if c is not None and os.path.exists(c)), None)

fails = []
def check(name, cond, extra=""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  " + extra) if extra else ""))
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 340, "height": 480})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(600)

    check("页面加载无 JS 报错", not errs, "; ".join(errs[:2]))

    # 启动那一帧：data-state 必须已经是 idle 且没有切换微动。
    # setState 用 body 的 data-state 当"上一次是什么"的唯一出处，
    # 若启动时它是空值，第一次 setState('idle')（hideBubble 收尾必经）
    # 就会被当成一次切换 —— 她一上屏莫名其妙压扁一下。
    check("启动时 data-state 已是 idle 且没有残留切换微动",
          pg.evaluate("document.body.dataset.state") == "idle"
          and not pg.evaluate("pet.classList.contains('state-switch')"),
          repr(pg.evaluate("document.body.dataset.state")))

    # ---- v1.0 方案二：独立对话窗（chat.html）专用 mock（笔 4）----
    CHAT_MOCK = """
    window.__chat = [
      {role:'user', content:'在吗', messageId:'m-1', windowNo:1, bridge:true, synthetic:false, t:1790000000000},
      {role:'assistant', content:'在的[state:happy]', messageId:'m-2', windowNo:2, bridge:false, synthetic:false, t:1790000001000},
      {role:'user', content:'[自主感知触发]：用户戳了你 5 下', messageId:'m-3', windowNo:2, bridge:false, synthetic:true, t:null}
    ];
    window.__calls = [];
    window.deskpet = {
      onDelta(cb){ window.__deltaCb = cb; },
      onWardrobe(){}, wardrobeState(){ return Promise.resolve(null); },
      async chatHistory(){ window.__calls.push(['chatHistory']); return window.__chat.slice(); },
      async chatBusy(busy, state){ window.__calls.push(['chatBusy', !!busy, state || null]); return {ok:true}; },
      async chatWindowClose(){ window.__calls.push(['chatWindowClose']); return {ok:true}; },
      async chatWindowHome(){ window.__calls.push(['chatWindowHome']); return {ok:true}; },
      async send(t){
        window.__calls.push(['send', t]);
        if (t === 'boom') return { ok:false, error:'测试故障' };
        if (window.__deltaCb) { window.__deltaCb('逐字'); window.__deltaCb('回复'); }
        window.__chat = window.__chat.concat([
          {role:'user', content:t, messageId:'m-u' + window.__chat.length, windowNo:2, bridge:false, synthetic:false, t:1790000002000},
          {role:'assistant', content:'逐字回复', messageId:'m-a' + window.__chat.length, windowNo:2, bridge:false, synthetic:false, t:1790000003000}
        ]);
        return { ok:true, text:'逐字回复', state:'happy' };
      }
    };
    """
    pg3 = b.new_page(viewport={"width": 380, "height": 520})
    errs3 = []
    pg3.on("pageerror", lambda e: errs3.append(str(e)))
    pg3.add_init_script(CHAT_MOCK)
    pg3.goto(URL.replace('index.html', 'chat.html'))
    pg3.wait_for_timeout(400)

    # v1.0 方案二：主窗输入条已退役，对话迁独立窗
    check("主窗输入条已退役（对话迁独立窗）", pg.query_selector("#inputBar") is None)

    # 右键 -> 对话（预览无 api：只进 talking 态；Electron 下开独立对话窗）
    pg.click("#pet", button="right")
    pg.wait_for_timeout(250)
    check("右键弹出菜单", pg.is_visible("#menu"))
    pg.click('#menu div[data-act="talk"]')
    pg.wait_for_timeout(300)
    check("点菜单进入对话态（talking）", pg.evaluate("document.body.classList.contains('talking')"))

    # 打字并发送（v1.0 方案二：对话在独立对话窗 chat.html 进行）
    pg3.fill("#input", "你好呀，记住我叫阿哲")
    pg3.keyboard.press("Enter")
    pg3.wait_for_timeout(500)
    check("发送后对话窗即时上屏（用户气泡含留言）",
          pg3.evaluate("[...document.querySelectorAll('#chatList .b-user')].some(r => r.textContent.includes('阿哲'))"))
    check("流式结束后文本完整（对账显示助手回复）",
          pg3.evaluate("[...document.querySelectorAll('#chatList .b-text')].some(e => e.textContent.includes('逐字回复'))"))
    check("权威对账后历史如实（行数 = 单一事实源条数）",
          pg3.evaluate("document.querySelectorAll('#chatList .b-row').length") == pg3.evaluate("window.__chat.length"))
    check("收尾无流式临时残留",
          pg3.evaluate("document.querySelectorAll('#chatList .b-streaming').length") == 0)
    check("发送后输入框清空", (pg3.input_value("#input") or "") == "")
    check("synthetic 条目渲染为 note（绝不冒充用户）",
          pg3.evaluate("document.querySelectorAll('#chatList .b-note').length") >= 1)


    # 记录面板开关后气泡隐藏
    pg.click("#pet", button="right")
    pg.wait_for_timeout(250)
    pg.click('#menu div[data-act="log"]')
    pg.wait_for_timeout(300)
    check("打开记录时气泡让位", not pg.is_visible("#bubble"))
    lw = pg.evaluate("document.getElementById('log').getBoundingClientRect().width")
    iw = pg.evaluate("window.innerWidth")
    check("记录面板满幅契约（inset 8，与设置同规格）", abs(lw - (iw - 16)) <= 2, "w=%s iw=%s" % (round(lw), iw))
    pg.click("#log", button="right")
    pg.wait_for_timeout(300)
    check("记录面板右键可关闭（× 已退役）", not pg.is_visible("#log"))
    check("关闭后气泡恢复显示", pg.is_visible("#bubble"))

    # 设置面板
    pg.click("#pet", button="right")
    pg.wait_for_timeout(250)
    pg.click('#menu div[data-act="panel"]')
    pg.wait_for_timeout(400)
    check("设置面板可打开", pg.is_visible("#panel"))
    # 预览模式没有 api，refreshStats 会提前返回，此处只验证元素存在；
    # Key 状态文案在 Electron 下由 refreshStats 填充
    check("Key 状态提示元素存在", "Key" in (pg.text_content("#keyState") or ""))
    check("Key 输入框存在", pg.is_visible("#keyInput"))

    # 记忆管理区（预览模式应显示占位文案，而不是报错）
    pg.click('.pnav-item[data-sec="memory"]')
    pg.wait_for_timeout(120)
    check("记忆列表区块存在", pg.is_visible("#memList"))
    check("预览模式记忆区有降级文案",
          "预览" in (pg.text_content("#memList") or ""))

    # 衣柜区（预览模式同样必须降级，而不是空面板或报错）
    pg.keyboard.press("Escape")   # v1.0：衣橱自设置独立，关设置后走菜单
    pg.wait_for_timeout(200)
    pg.click("#pet", button="right")
    pg.wait_for_timeout(250)
    pg.click('#menu div[data-act="wardrobe"]')
    pg.wait_for_timeout(300)
    check("衣柜预设区存在", pg.query_selector("#wdPresets") is not None)
    check("预览模式衣柜区有降级文案",
          "预览" in (pg.text_content("#wdSlots") or ""))
    check("衣柜提示写明不影响性格",
          "不影响性格" in (pg.text_content("#wdHint") or ""))

    # 换装图层：预览模式没有 api，必须回退单张 pet.png，不能是空白
    layered = pg.evaluate("document.querySelector('#figure').classList.contains('layered')")
    sprite_vis = pg.is_visible("#sprite")
    check("无衣柜数据时回退单图皮套（桌宠不会变空白）",
          (not layered) and sprite_vis, "layered=%s visible=%s" % (layered, sprite_vis))
    check("回退时图层容器为空",
          pg.evaluate("document.querySelector('#layers').children.length") == 0)

    # ---------------------------------------------------------------
    # 带 mock bridge 的页面：验证真实换装路径（图层上屏 + 面板交互）
    # ---------------------------------------------------------------
    MOCK = """
    window.__wd = { equip: {hair:'silver_wavy_01',hairAccessory:'black_bow_01',
        top:'lace_corset_01',bottom:'black_shorts_01',dress:null,
        socks:'white_thighhigh_01',shoes:'black_boots_01',
        outerwear:'white_tech_jacket_01',accessory:'choker_key_01'},
      preset:'default' };
    window.__calls = [];
    // 与 src/wardrobe.js 同款：身份约束写在槽位上（required），
    // 不从商品条目反推 —— 反推会在"加第二款发型忘了标 locked"时失效。
    const SLOTS = [
      {id:'hair',z:10,name:'发型',required:true},{id:'socks',z:20,name:'袜子'},
      {id:'dress',z:30,name:'连衣裙'},{id:'top',z:31,name:'上装'},
      {id:'bottom',z:32,name:'下装'},{id:'outerwear',z:40,name:'外套'},
      {id:'shoes',z:45,name:'鞋子'},{id:'hairAccessory',z:50,name:'发饰',required:true},
      {id:'accessory',z:60,name:'饰品'}];
    const ITEMS = {
      hair:[{id:'silver_wavy_01',name:'银白微卷长发'}],
      hairAccessory:[{id:'black_bow_01',name:'右侧黑色蝴蝶结'}],
      top:[{id:'lace_corset_01',name:'黑色蕾丝吊带'},{id:'gray_tee_01',name:'灰色宽松T恤'}],
      bottom:[{id:'black_shorts_01',name:'黑色短裤'},{id:'sport_shorts_01',name:'深灰运动短裤'}],
      dress:[{id:'gothic_black_01',name:'哥特黑连衣裙'}],
      socks:[{id:'white_thighhigh_01',name:'白色过膝袜'}],
      shoes:[{id:'black_boots_01',name:'黑色厚底靴'},{id:'white_sneakers_01',name:'白色运动鞋'}],
      outerwear:[{id:'white_tech_jacket_01',name:'落肩白色外套'}],
      accessory:[{id:'choker_key_01',name:'黑色项圈（钥匙坠）'}]};
    const FILE = {};
    Object.entries(ITEMS).forEach(([s,arr]) => arr.forEach(i => {
      const dir = {hair:'hair',hairAccessory:'hair-accessories',top:'tops',bottom:'bottoms',
                   dress:'dresses',socks:'socks',shoes:'shoes',outerwear:'outerwear',
                   accessory:'accessories'}[s];
      FILE[i.id]=dir+'/'+i.id+'.png';
    }));
    function layers(){
      return SLOTS.filter(s=>window.__wd.equip[s.id])
        .map(s=>({slot:s.id,z:s.z,itemId:window.__wd.equip[s.id],
                  src:'assets/character/'+FILE[window.__wd.equip[s.id]]}))
        .sort((a,b)=>a.z-b.z);
    }
    // 与数据层同款规则：连衣裙不与上装/下装共存，身份件不许脱空
    function validate(e){
      if(e.dress&&(e.top||e.bottom)) return '连衣裙不能和上装/下装同时穿';
      for(const s of SLOTS) if(s.required&&!e[s.id]) return s.name+' 是身份，不能脱空';
      return null;
    }
    window.deskpet = {
      onDelta(){}, onWardrobe(cb){ window.__wdCb = cb; }, onChatBusy(cb){ window.__chatBusyCb = cb; },
      async getConfig(){ return {hasKey:true, keyEncrypted:true}; },
      // model 来自配置文件，是唯一可能带用户可控内容的统计字段：
      // 故意塞一段注入串，验证它只作为文本出现
      async report(){ return {requests:5, model:'<img src=x onerror=alert(1)>',
        rate:99, peak:false, lastRate:100, hit:10, miss:2, out:3, cost:0.1,
        windowNo:1, windowTurns:2, windowTarget:100, historyTokens:100,
        contextTokens:300, segments:1, memoryTokens:20, memoryCap:1500,
        compressions:1, merges:0}; },
      async listMemory(){ return []; },
      async deleteMemory(){ return true; },
      async clearMemory(){ return true; },
      dragStart(){}, dragEnd(){}, dragMove(){}, quit(){}, togglePin(){}, resize(){},
      openConfig(){}, setKey(){},
      activity(t){ window.__calls.push(['activity', t]); },
      async proactiveCheck(){
        window.__calls.push(['proactiveCheck']);
        return (typeof window.__offer === 'function') ? window.__offer() : (window.__offer || null);
      },
      async wardrobeState(){
        return { catalog:{ slots:SLOTS, items:ITEMS,
                  presets:{default:'默认白毛套装',casual:'日常休闲',gothic:'哥特风'},
                  equip:window.__wd.equip, preset:window.__wd.preset },
                 layers: layers() };
      },
      async wardrobeSet(slot,itemId){
        window.__calls.push(['set',slot,itemId]);
        const next = {...window.__wd.equip,[slot]:itemId};
        const bad = validate(next);
        if(bad) return {ok:false,error:bad};
        if(window.__wd.equip[slot]===itemId) return {ok:true,changed:false};
        window.__wd.equip = next; window.__wd.preset=null;
        if(window.__wdCb) window.__wdCb(layers());
        return {ok:true,changed:true};
      },
      async wardrobePreset(id){
        window.__calls.push(['preset',id]);
        if(!{default:1,casual:1,gothic:1}[id]) return {ok:false,error:'没有这个套装'};
        const P = {
          default:{hair:'silver_wavy_01',hairAccessory:'black_bow_01',top:'lace_corset_01',
                   bottom:'black_shorts_01',dress:null,socks:'white_thighhigh_01',
                   shoes:'black_boots_01',outerwear:'white_tech_jacket_01',accessory:'choker_key_01'},
          casual:{top:'gray_tee_01',bottom:'sport_shorts_01',dress:null,
                  shoes:'white_sneakers_01',outerwear:null},
          gothic:{dress:'gothic_black_01',top:null,bottom:null,
                  shoes:'black_boots_01',outerwear:null}}[id];
        const next = {...window.__wd.equip,...P};
        const bad = validate(next);
        if(bad) return {ok:false,error:bad};
        window.__wd.equip = next; window.__wd.preset = id;
        if(window.__wdCb) window.__wdCb(layers());
        return {ok:true,changed:true};
      },
      async send(t, o){
        window.__calls.push(['send', t, o ? JSON.stringify(o) : null]);
        if (o && o.proactive) {
          // 主进程拒收过期提案时只回 declined：这轮该当没发生过
          if (window.__decline) return { ok:false, declined:true, proactive:true };
          return { ok:true, text:'谁一直戳我呀~', state:'annoyed',
                   wears:[], proactive:true };
        }
        // 模拟一次真实换装：模型提案 -> 程序执行 -> 结果如实带回
        // wears 是数组（main.js 契约）：一条回复连发多个提案时逐条列出
        const r = await window.deskpet.wardrobePreset('gothic');
        return { ok:true, text:'我换上哥特那套了~', state:'happy',
                 wears:['gothic'],
                 wearNote: r.ok?'已实际换上 gothic':'gothic 未生效：'+r.error };
      }
    };
    """
    pg2 = b.new_page(viewport={"width": 340, "height": 480})
    errs2 = []
    pg2.on("pageerror", lambda e: errs2.append(str(e)))
    pg2.add_init_script(MOCK)
    pg2.goto(URL)
    pg2.wait_for_timeout(1200)
    check("mock 桥接下页面无 JS 报错", not errs2, "; ".join(errs2[:2]))
    check("图层上屏后进入 layered 模式",
          pg2.evaluate("document.querySelector('#figure').classList.contains('layered')"))
    check("默认套装渲染出 base + 8 层",
          pg2.evaluate("document.querySelector('#layers').children.length") == 9,
          "n=%s" % pg2.evaluate("document.querySelector('#layers').children.length"))
    check("layered 时单图皮套隐藏（不出现重影）",
          not pg2.is_visible("#sprite"))
    z = pg2.evaluate("""[...document.querySelectorAll('#layers .layer:not(.base)')]
        .map(e => e.style.zIndex)""")
    check("图层 z 顺序按数据层下发（袜子在鞋之前）",
          [int(x) for x in z] == sorted(int(x) for x in z) and len(z) == 8, ",".join(z))
    check("每张图层都占满画布（同锚点对齐）",
          pg2.evaluate("""(() => {const a=[...document.querySelectorAll('#layers img')];
            const w=a[0].clientWidth;
            return a.every(e => Math.abs(e.clientWidth-w)<1);})()"""))

    pg2.screenshot(path="/tmp/pw_wardrobe_default.png")

    # 面板：预设按钮 + 槽位按钮 + 身份件不给「脱下」
    pg2.click("#pet", button="right")
    pg2.wait_for_timeout(250)
    pg2.click('#menu div[data-act="wardrobe"]')   # v1.0：衣橱独立入菜单
    pg2.wait_for_timeout(500)
    check("衣柜渲染出 3 个预设按钮",
          pg2.evaluate("document.querySelectorAll('#wdPresets button').length") == 3)
    check("当前预设高亮",
          pg2.evaluate("document.querySelector('#wdPresets button.on').textContent")
          == "默认白毛套装")
    check("每个有货槽位一行",
          pg2.evaluate("document.querySelectorAll('#wdSlots .wd-row').length") == 9)
    check("身份槽不给脱下按钮",
          pg2.evaluate("""[...document.querySelectorAll('#wdSlots .wd-row')]
            .filter(r => ['发型','发饰'].includes(r.querySelector('.wd-slot').textContent))
            .every(r => r.querySelector('.wd-off') === null)"""))
    check("普通槽给脱下按钮",
          pg2.evaluate("""[...document.querySelectorAll('#wdSlots .wd-row')]
            .filter(r => r.querySelector('.wd-slot').textContent === '外套')
            .every(r => r.querySelector('.wd-off') !== null)"""))
    check("面板文案不泄漏 itemId 之外的内部字段",
          pg2.evaluate("document.querySelector('#wdSlots').innerHTML.includes('<script')")
          is False)

    # 统计面板：来自配置文件的 model 只能当文本，不许变成标签
    pg2.keyboard.press("Escape")   # 关衣橱
    pg2.wait_for_timeout(200)
    pg2.click("#pet", button="right")
    pg2.wait_for_timeout(250)
    pg2.click('#menu div[data-act="panel"]')   # 开设置（用量/Key 在这）
    pg2.wait_for_timeout(400)
    pg2.click('.pnav-item[data-sec="conn"]')
    pg2.wait_for_timeout(120)
    pg2.evaluate("document.querySelector('#stats').textContent")  # 触发一次读取
    check("用量面板把注入型 model 当纯文本显示",
          "<img src=x" in (pg2.text_content("#stats") or ""))
    check("用量面板里没有因此多出任何元素",
          pg2.evaluate("document.querySelectorAll('#stats img, #stats script').length") == 0)
    check("Key 状态如实标注加密存储",
          "加密" in (pg2.text_content("#keyState") or ""),
          repr(pg2.text_content("#keyState")))

    # 互斥自动解绑（v1.0 实机反馈）：穿着上装时点连衣裙 → 前端先脱上下装再穿裙，无缝不报错
    # （数据层校验一字未动：src/wardrobe.js 仍是互斥铁律的唯一权威）
    before = pg2.evaluate("JSON.stringify(window.__wd.equip)")
    pg2.keyboard.press("Escape")   # 关设置
    pg2.wait_for_timeout(200)
    pg2.click("#pet", button="right")
    pg2.wait_for_timeout(250)
    pg2.click('#menu div[data-act="wardrobe"]')   # 回衣橱做互斥解绑实测
    pg2.wait_for_timeout(300)
    pg2.evaluate("""(() => {const r=[...document.querySelectorAll('#wdSlots .wd-row')]
        .find(r => r.querySelector('.wd-slot').textContent === '连衣裙');
      r.querySelector('.wd-item').click();})()""")
    pg2.wait_for_timeout(400)
    after = pg2.evaluate("JSON.stringify(window.__wd.equip)")
    check("互斥自动解绑：点连衣裙自动脱上下装并穿上（状态如实变化）",
          after != before and '"dress":"gothic_black_01"' in after
          and '"top":null' in after and '"bottom":null' in after, repr(after))
    check("自动解绑丝滑无报错（气泡没有「穿不上」）",
          "穿不上" not in (pg2.text_content("#bubble") or ""),
          repr((pg2.text_content("#bubble") or "")[:30]))

    # 对话触发换装：程序状态、图层、历史记录三者一致
    pg2.keyboard.press("Escape")   # 设计变更：关闭按钮移除，ESC / 右键关闭面板
    pg2.wait_for_timeout(200)
    pg2.click("#pet", button="right")
    pg2.wait_for_timeout(250)
    pg2.click('#menu div[data-act="talk"]')
    pg2.wait_for_timeout(200)
    pg2.evaluate("runChat('换成哥特那套吧', {})")   # v1.0 方案二：输入条退役，直驱 runChat（同一 mock 换装路径）
    pg2.wait_for_timeout(900)
    check("换装后预设切到哥特",
          pg2.evaluate("window.__wd.preset") == "gothic")
    check("换装后 dress 真的穿上、上下装真的脱了",
          pg2.evaluate("window.__wd.equip.dress") == "gothic_black_01"
          and pg2.evaluate("window.__wd.equip.top") is None)
    n2 = pg2.evaluate("document.querySelectorAll('#layers .layer:not(.base)').length")
    check("屏幕图层同步为 6 层（默认8 - 上装/下装/外套 + 连衣裙）", n2 == 6, "n=%s" % n2)
    logs2 = pg2.text_content("#log") or ""
    check("执行结果如实写进记录",
          "[换装]" in logs2 and "已实际换上" in logs2, repr(logs2[-60:]))
    pg2.screenshot(path="/tmp/pw_wardrobe_gothic.png")

    # 状态回落 + 无标记泄漏
    check("换装回复里不含标记文本",
          "[wear" not in (pg2.text_content("#bubble") or "")
          and "[state" not in (pg2.text_content("#bubble") or ""))
    pg2.wait_for_timeout(6200)
    check("气泡收起后状态回落 idle",
          pg2.evaluate("document.body.dataset.state") == "idle")

    # ---- v0.8 本地活动上报：戳一下就要被主进程看见 ----
    # 判据是"渲染端只报事件、不自己算账"：所以这里只看有没有把 click 送出去，
    # 不看触发结果（触发由 test/trigger.test.js 与 main 层各自钉）。
    pg2.evaluate("window.__calls.length = 0")
    pg2.click("#pet")
    pg2.wait_for_timeout(120)
    acts = [c for c in pg2.evaluate("window.__calls") if c[0] == "activity"]
    check("点一下立绘会上报 activity('click')（不然她永远不知道你戳过我）",
          acts == [["activity", "click"]], repr(acts))

    # 拖拽：只有真的挪过才算"被拖了一下"，纯失焦收尾不许伪造
    pg2.evaluate("window.__calls.length = 0")
    bb = pg2.evaluate("""(()=>{const r=document.getElementById('pet').getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+40)};})()""")
    pg2.mouse.move(bb["x"], bb["y"]); pg2.mouse.down()
    pg2.mouse.move(bb["x"] + 40, bb["y"] + 10, steps=5)
    pg2.wait_for_timeout(80); pg2.mouse.up()
    pg2.wait_for_timeout(120)
    drags = [c[1] for c in pg2.evaluate("window.__calls") if c[0] == "activity"]
    check("真的拖动后上报 activity('drag')", "drag" in drags, repr(drags))
    check("拖动结束时那一下 click 不算戳（moved>6 会被提前 return，不重复计数）",
          "click" not in drags, repr(drags))
    pg2.evaluate("window.__calls.length = 0")
    pg2.mouse.move(bb["x"], bb["y"]); pg2.mouse.down()
    pg2.wait_for_timeout(60)
    pg2.evaluate("window.dispatchEvent(new Event('blur'))")   # 按住不动就失焦
    pg2.wait_for_timeout(120)
    pg2.mouse.up()
    pg2.wait_for_timeout(120)
    acts3 = [c[1] for c in pg2.evaluate("window.__calls") if c[0] == "activity"]
    check("按住没挪动就收尾时不伪造 drag（没发生的事就是没发生）",
          "drag" not in acts3, repr(acts3))
    # 原位置按下再松开本来就是"戳一下"，浏览器会派发 click —— 报 click 是对的。
    # 这条同时说明上一句为什么不写死成 == []：判据要按语义，不是按实现方便。
    check("同一位置按下再松开算一次戳（不因为进过拖拽态就吞掉）",
          "click" in acts3, repr(acts3))

    # ---- 主动搭话：提案要原样带回去，被拒时这一轮当没发生过 ----
    offer = {"kind": "poke", "at": __import__("time").time() * 1000,
             "reason": "用户在 8 秒内戳了你 6 下", "hint": "喊痒"}
    pg2.evaluate("o => { window.__offer = o; window.__decline = false; }", offer)
    # 礼貌闸门的前提先归零：面板/记录开着、输入框有字或有焦点、上一条气泡还没收。
    # 气泡必须先收 —— 不然这三条测的是"闸门拦住了"，不是各自那件事。
    pg2.evaluate("""(()=>{window.__calls.length=0;
        document.getElementById('logBody').innerHTML='';
        document.getElementById('panel').classList.add('hidden');
        document.getElementById('log').classList.add('hidden');
        document.body.classList.remove('showlog');
        const inp=document.getElementById('input'); if(inp){inp.value=''; inp.blur();}
        streaming=false; hideBubble();})()""")
    pg2.evaluate("tryProactive()")
    pg2.wait_for_timeout(400)
    sends = [c for c in pg2.evaluate("window.__calls") if c[0] == "send"]
    check("拿到提案后发出去时把 offer 原样带回（主进程靠它记账）",
          len(sends) == 1 and sends[0][2] and '"kind":"poke"' in sends[0][2],
          repr(sends))
    check("主动搭话的话照常用同一条上屏路径（不另写一套渲染）",
          "谁一直戳我" in (pg2.text_content("#bubble") or ""),
          repr(pg2.text_content("#bubble")))
    logs3 = pg2.text_content("#logBody") or ""
    check("主动搭话不写「你：…」（没人说过那句话）", "你：" not in logs3, repr(logs3))
    check("但她那句话进了记录面板（用户能查她为什么开口）",
          "谁一直戳我" in logs3, repr(logs3))

    # 被拒（提案过期）：气泡、记录、光标都不许留下痕迹
    pg2.evaluate("""(()=>{window.__decline = true; window.__calls.length = 0;
        document.getElementById('logBody').innerHTML = '';
        streaming=false; hideBubble();})()""")
    pg2.evaluate("tryProactive()")
    pg2.wait_for_timeout(400)
    check("被拒的这一轮不往记录面板里留任何一行",
          (pg2.text_content("#logBody") or "").strip() == "",
          repr(pg2.text_content("#logBody")))
    check("被拒后气泡收起（不顶着空气泡卡在 thinking）",
          pg2.evaluate("document.getElementById('bubble').classList.contains('hidden')"))
    check("被拒后状态回落 idle",
          pg2.evaluate("document.body.dataset.state") == "idle")
    check("被拒后 busy 已释放（不把她永久锁住）",
          pg2.evaluate("busy === false && streaming === false"))

    # 礼貌闸门：用户正在打字时，提案必须被拒且**不发请求**（不白烧钱）。
    # 直接改 input.value 而不是走 fill()：闸门看的是"有没有内容/有没有焦点"，
    # 与输入栏可见无关，用菜单打开输入栏只会把这条测成一串前置动作。
    pg2.evaluate("window.__decline = false; window.__calls.length = 0")
    pg2.evaluate("""(()=>{streaming=false; hideBubble();
        window.__chatBusyCb({busy:true});})()""")   # v1.0：「用户正在打字」演进为「对话窗正在对话」
    pg2.evaluate("tryProactive()")
    pg2.wait_for_timeout(300)
    check("对话窗正在对话时不开口（chatBusy 闸）",
          "谁一直戳我" not in (pg2.text_content("#bubble") or ""),
          repr(pg2.text_content("#bubble")))
    check("而且一次请求都不发（拒绝发生在花钱之前）",
          [c for c in pg2.evaluate("window.__calls") if c[0] == "send"] == [],
          repr(pg2.evaluate("window.__calls")))
    pg2.evaluate("window.__chatBusyCb({busy:false})")   # 对话结束，闸门放开（旧「留焦点也拦」随输入条退役）
    # 上一条成功开口后气泡还开着，会撞另一条闸门（"上一条还没说完"）；
    # 这里要测的是"不打扰"这一条，先把无关的变量归零。
    pg2.evaluate("streaming=false; hideBubble()")
    pg2.wait_for_timeout(60)
    # 前提复核：这条闸门若不让发，上面那句判据就是空转
    pg2.evaluate("window.__calls.length = 0")
    pg2.evaluate("tryProactive()")
    pg2.wait_for_timeout(300)
    check("测试前提：chatBusy 放开后同一个提案就能发出去（上一条不是空转）",
          len([c for c in pg2.evaluate("window.__calls") if c[0] == "send"]) == 1,
          repr(pg2.evaluate("window.__calls")))
    pg2.evaluate("window.__offer = null")
    pg2.evaluate("streaming=false; hideBubble()")
    pg2.wait_for_timeout(100)

    # 提案为 null 时什么都不做（45 秒滴答里绝大多数轮次都是这种）
    pg2.evaluate("window.__calls.length = 0")
    pg2.evaluate("tryProactive()")
    pg2.wait_for_timeout(200)
    check("主进程说「这次别说」时不发请求",
          [c for c in pg2.evaluate("window.__calls") if c[0] == "send"] == [],
          repr(pg2.evaluate("window.__calls")))

    # ---- 90 秒静默闸只管 idle，不管 poke ----
    # 这是第一版真实踩到的坑：被戳本身就是"现在方便"的意思，
    # 拿静默闸去挡连戳提案会把 poke 这条路整个饿死（永远开不了口）。
    idle_offer = {"kind": "idle", "at": __import__("time").time() * 1000,
                  "reason": "用户已经离开 31 分钟", "hint": "轻声说一句"}
    poke_offer = dict(idle_offer, kind="poke", reason="用户在 8 秒内戳了你 5 下")
    pg2.evaluate("""(([io, po]) => {
        streaming = false; hideBubble();
        const inp = document.getElementById('input'); if (inp) { inp.value = ''; inp.blur(); }
        noteUserAct();                     // 假装"3 秒前刚互动过"
        window.__offer = io; window.__decline = false; window.__calls.length = 0;
        window.__poke = po;
        // 闸门状态要在**任何发送之前**采：一旦开口，气泡开着就会另外拦住两条。
        window.__gates = [politeToSpeak('idle'), politeToSpeak('poke')];
      })""", [idle_offer, poke_offer])
    pg2.evaluate("tryProactive()")
    pg2.wait_for_timeout(250)
    check("刚互动过就来的 idle 提案被礼貌闸拦下（不追着人说话）",
          [c for c in pg2.evaluate("window.__calls") if c[0] == "send"] == [],
          repr(pg2.evaluate("window.__calls")))
    pg2.evaluate("window.__offer = window.__poke")
    pg2.evaluate("tryProactive()")
    pg2.wait_for_timeout(250)
    check("同样刚互动过，poke 提案照样开口（被戳本身就是「方便」的意思）",
          len([c for c in pg2.evaluate("window.__calls") if c[0] == "send"]) == 1,
          repr(pg2.evaluate("window.__calls")))
    check("测试前提：这一刻闸门确实是「idle 不许、poke 许」（否则上两条同为空转）",
          pg2.evaluate("window.__gates[0] === false && window.__gates[1] === true"),
          repr(pg2.evaluate("window.__gates")))
    pg2.evaluate("window.__offer = null; streaming=false; hideBubble()")
    pg2.wait_for_timeout(100)

    check("mock 路径全程无 JS 报错", not errs2, "; ".join(errs2[:3]))
    pg2.close()

    # 状态机：发送后 body 应挂上 data-state
    pg.evaluate("void runChat('再测一句状态', {})")   # v1.0：直驱 runChat；void 防 evaluate 等完 promise（否则查不到 thinking 中途态）
    pg.wait_for_timeout(400)
    state = pg.evaluate("document.body.dataset.state")
    check("发送时进入 thinking 状态", state == "thinking", repr(state))
    pg.wait_for_timeout(2600)
    check("状态标记不会显示在气泡里",
          "[state" not in (pg.text_content("#bubble") or ""))
    # 预览分支也要走收尾生命周期：流式结束后应自动回落 idle
    state_done = pg.evaluate("document.body.dataset.state")
    check("预览模式回复结束后状态回落 idle", state_done == "idle", repr(state_done))

    # 定格 Bug 回归：单次情绪动画必须把 breathe 串在后面，否则播完不再呼吸
    pg.evaluate("document.body.dataset.state='happy'")
    anim = pg.evaluate("getComputedStyle(document.querySelector('#figure')).animationName")
    check("happy 状态动画串了 breathe（不会定格）",
          "bounce" in anim and "breathe" in anim, repr(anim))
    pg.evaluate("document.body.dataset.state='idle'")

    # 气泡收起后状态应回落 idle（不永久挂着 data-state）
    state_after = pg.evaluate("document.body.dataset.state")
    check("手动复位后可回到 idle", state_after == "idle", repr(state_after))

    # ---- 表情之间的"衔接"（Gemini v0.8.3 提议的三个方向） ----
    # 1) 眨眼不许再把状态动画整个顶掉。旧写法 blink 挂 #figure，
    #    animation-name 是覆盖属性 -> tilt/sway 被 blink 抢走，180ms 后从 0%
    #    重播，倾角被硬拉回 0（实测跳 2.23 度）。现在 blink 挂 #sprite/#layers。
    pg.evaluate("setState('curious')")
    pg.wait_for_timeout(400)
    ang_before = pg.evaluate("""(() => { const t = getComputedStyle(
        document.getElementById('figure')).transform;
        const n = (!t || t === 'none') ? [1,0] : t.slice(t.indexOf('(')+1,
          t.lastIndexOf(')')).split(',').map(Number);
        return Math.atan2(n[1], n[0]) * 180 / Math.PI; })()""")
    check("测试前提：curious 跑到中段时倾角非 0（否则下面的跳变判据是空转）",
          abs(ang_before) > 0.5, "%.2f°" % ang_before)
    pg.evaluate("window.__ang = []; clearInterval(window.__aid); window.__aid = setInterval(() => {"
                " const t = getComputedStyle(document.getElementById('figure')).transform;"
                " const n = (!t || t === 'none') ? [1,0] :"
                " t.slice(t.indexOf('(')+1, t.lastIndexOf(')')).split(',').map(Number);"
                " window.__ang.push(Math.atan2(n[1], n[0]) * 180 / Math.PI); }, 16)")
    pg.wait_for_timeout(300)
    pg.evaluate("blink()")
    pg.wait_for_timeout(700)
    pg.evaluate("clearInterval(window.__aid)")
    angs = pg.evaluate("window.__ang")
    jump = max(abs(angs[i + 1] - angs[i]) for i in range(len(angs) - 1))
    check("眨眼时倾角不跳回 0（旧实测最大跳 2.23°）", jump < 0.5,
          "max jump %.3f°" % jump)
    check("眨眼期间 #figure 仍跑着状态动画",
          pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                      ".animationName").find("tilt") >= 0,
          repr(pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                           ".animationName")))
    # 眨眼动画本身只有 .18s，等不到就没了 —— 直接挂类再读，测的是那条 CSS 规则
    pg.evaluate("pet.classList.add('blink')")
    check("眨眼动画落在 #sprite 上（真正被眨的那个元素）",
          "blink" in pg.evaluate("getComputedStyle(document.getElementById('sprite'))"
                                 ".animationName"))
    check("挂上 blink 时 #figure 的 tilt 没被顶掉（两条并行）",
          pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                      ".animationName").find("tilt") >= 0,
          repr(pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                           ".animationName")))
    pg.evaluate("pet.classList.remove('blink')")
    pg.evaluate("setState('idle')")
    pg.wait_for_timeout(400)
    # 2) 状态之间切换要有一下遮掩微动（差分表情图我们没有，能做的就是这个）。
    #    判据按"该触发的触发、不该触发的别触发"两头查。
    pg.evaluate("pet.classList.remove('state-switch'); setState('happy')")
    check("切到不同状态时挂上 state-switch", pg.evaluate("pet.classList.contains('state-switch')"))
    check("微动落在 #sprite 上而不是 #figure（不顶掉状态动画）",
          "face-switch" in pg.evaluate("getComputedStyle(document.getElementById('sprite'))"
                                       ".animationName"),
          pg.evaluate("getComputedStyle(document.getElementById('figure')).animationName"))
    check("挂微动时 #figure 的动画仍是新状态的（bounce）",
          "bounce" in pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                                  ".animationName"))
    pg.wait_for_timeout(300)
    check("180ms 后微动类自动摘掉（不常驻）",
          not pg.evaluate("pet.classList.contains('state-switch')"))
    # 先落回 idle 并等微动跑完，再测"重复同一状态" —— 顺序反了的话，
    # 这一次 setState('idle') 是 happy -> idle 的真切换，本来就该挂类。
    pg.evaluate("setState('idle')")
    pg.wait_for_timeout(300)
    check("测试前提：已落回 idle 且类已摘（否则下一条是空转）",
          pg.evaluate("document.body.dataset.state") == 'idle'
          and not pg.evaluate("pet.classList.contains('state-switch')"))
    # 重复同一状态不许再触发：hideBubble / finish 都会调 setState('idle')，
    # 守不住就是"每收一次气泡她抖一下"
    pg.evaluate("setState('idle'); setState('idle')")
    check("重复 setState('idle') 不触发微动",
          not pg.evaluate("pet.classList.contains('state-switch')"))
    check("测试前提：上面这条不是空转（切到别的状态确实会挂上）",
          pg.evaluate("setState('sad'); pet.classList.contains('state-switch')") is True)
    pg.evaluate("setState('idle')")
    pg.wait_for_timeout(300)
    check("切换微动不会常驻（跑完就摘干净）",
          not pg.evaluate("pet.classList.contains('state-switch')"))
    # 启动即 idle 那条挪到页面刚加载处测（见文件开头），在这里测会被
    # 上面无数次 setState 覆盖掉，测不到"启动"这件事。

    # 3) 表情之间切换的明暗变化要有过渡，不能硬切。根因是 transition-duration
    #    实测 0s —— 写了 transition 没给时长等于没写。修在 style.css 的 #figure。
    check("测试前提：#figure 的 filter 有非零过渡时长",
          pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                      ".transitionDuration").startswith("0.2"),
          pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                      ".transitionDuration"))
    pg.evaluate("setState('sad')")
    filts = []
    for _ in range(8):          # 8 x 40ms = 320ms > .2s 过渡时长，能采到终点
        filts.append(pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                                 ".filter"))
        pg.wait_for_timeout(40)
    check("切到 sad 时 filter 有中间值（旧实测 6 次采样只有 1 种 = 硬切）",
          len(set(filts)) >= 3, "%d 种" % len(set(filts)))
    check("过渡终点确实是 sad 的目标值",
          "brightness(0.88)" in filts[-1] and "saturate(0.7)" in filts[-1],
          repr(filts[-1]))
    pg.evaluate("setState('idle')")
    pg.wait_for_timeout(400)
    # transform 不许一起加 transition：它由 animation 全程接管，会跟关键帧抢属性
    check("过渡只作用于 filter（transform 交给 animation）",
          pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                      ".transitionProperty") == "filter",
          pg.evaluate("getComputedStyle(document.getElementById('figure'))"
                      ".transitionProperty"))

    # 4) relayout 不许把已收起的气泡复活（Gemini #1 说对了方向，这里是回归）
    vis_js = ("!bubble.classList.contains('hidden') &&"
              "getComputedStyle(bubble).display !== 'none'")
    pg.evaluate("streaming = false; hideBubble(); lastText = '上一句话';")
    check("测试前提：气泡此刻是收起的", not pg.evaluate(vis_js))
    pg.evaluate("relayout()")
    pg.wait_for_timeout(60)
    check("relayout 不复活已收起的气泡（旧实测会复活且永久挂屏）",
          not pg.evaluate(vis_js))
    # 反过来：开着时必须重排，否则这条判据就成了"干脆不重排"
    pg.evaluate("lastText = ''; render('长文本占位'); bubble.classList.remove('hidden');"
                "document.documentElement.style.setProperty('--bubble-max', '90px');")
    pg.evaluate("relayout()")
    pg.wait_for_timeout(60)
    check("开着的气泡 relayout 后仍在（重排没被一起砍掉）",
          pg.evaluate(vis_js) and "长文本占位" in (pg.text_content("#bubble") or ""),
          repr(pg.text_content("#bubble")))
    check("测试前提：relayout 会按当前立绘重算 --bubble-max",
          pg.evaluate("getComputedStyle(document.documentElement)"
                      ".getPropertyValue('--bubble-max')").strip() != "90px",
          pg.evaluate("getComputedStyle(document.documentElement)"
                      ".getPropertyValue('--bubble-max')"))
    pg.evaluate("hideBubble(); streaming = false;")
    pg.wait_for_timeout(80)

    # 5) 拖拽：窗外松手后 buttons=0 立刻收尾（比任何计时器都快），
    #    而"按住停一下再拖"不再被 700ms 误杀。
    # 前面几段把设置面板和 talking 态留着了 —— 面板会盖住立绘，
    # 鼠标落在面板上而不是 #pet 上（实测命中 #stats）。先复位再测拖拽。
    pg.evaluate("panel.classList.add('hidden'); setTalking(false);"
                "toggleLog(false); streaming = false; hideBubble();")
    pg.wait_for_timeout(150)

    def pet_center(reset=True):
        """预览模式下拖的是 #pet 自己（没有窗口可挪），每做一遍手势都会把她
        越拖越远 —— 实测漂到 +1188px 之后鼠标再也点不到她，下一段就从
        "拖不动"变成"前提不成立"。所以每次取中心前先把内联定位清掉。"""
        if reset:
            pg.evaluate("(() => { const s = document.getElementById('pet').style;"
                        " s.left = ''; s.bottom = ''; })()")
            pg.wait_for_timeout(80)
        return pg.evaluate("""(() => { const r = document.getElementById('pet')
            .getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2),
                   y: Math.round(r.top + 40) }; })()""")

    pb2 = pet_center()
    pg.mouse.move(pb2["x"], pb2["y"])
    pg.mouse.down()
    pg.mouse.move(pb2["x"] + 30, pb2["y"], steps=3)
    pg.wait_for_timeout(80)
    check("测试前提：正在拖拽", pg.evaluate("dragging"))
    # 窗外松手 = 没有 mouseup，只有一个 buttons=0 的 mousemove 进来
    pg.evaluate("""(() => { const r = document.getElementById('pet').getBoundingClientRect();
      window.dispatchEvent(new MouseEvent('mousemove', {
        screenX: r.x + 300, screenY: r.y + 80, clientX: 300, clientY: 80,
        buttons: 0, bubbles: true })); })()""")
    pg.wait_for_timeout(60)
    check("buttons=0 的 mousemove 立刻收尾（不必等看门狗）",
          not pg.evaluate("dragging"))
    check("收尾时同步清掉 dragging 类",
          not pg.evaluate("pet.classList.contains('dragging')"))
    check("收尾时把 dragWatch 也置空（不留悬空定时器）",
          pg.evaluate("dragWatch === null"))
    pg.mouse.up()
    pg.wait_for_timeout(80)
    # 手还按着时 buttons=1 绝不能被误判成松手
    pb2 = pet_center()
    pg.mouse.move(pb2["x"], pb2["y"])
    pg.mouse.down()
    pg.wait_for_timeout(60)
    for _ in range(6):
        pg.evaluate("""(() => { const r = document.getElementById('pet').getBoundingClientRect();
          window.dispatchEvent(new MouseEvent('mousemove', {
            screenX: r.x + 20, screenY: r.y + 5, clientX: 20, clientY: 5,
            buttons: 1, bubbles: true })); })()""")
        pg.wait_for_timeout(60)
    check("按住不动时 buttons=1 的移动不误判脱手", pg.evaluate("dragging"))
    pg.mouse.up()
    pg.wait_for_timeout(80)
    # 按住停 1.2 秒再继续拖（旧 700ms 阈值会在这 1.2 秒里把手势掐死）。
    # 自成一段：每次手势都重新按下、重新取中心，不复用上一段的手感 ——
    # 预览模式没有窗口可挪，拖的是 #pet 自己，串着用会越拖越远。
    check("测试前提：看门狗阈值已放宽到 2500ms",
          pg.evaluate("DRAG_IDLE_MS") == 2500, str(pg.evaluate("DRAG_IDLE_MS")))
    pb4 = pet_center()
    pg.mouse.move(pb4["x"], pb4["y"])
    pg.mouse.down()
    pg.wait_for_timeout(1200)
    check("按住 1.2s 不停手（旧阈值会在 700ms 误判脱手）", pg.evaluate("dragging"))
    x1 = pg.evaluate("document.getElementById('pet').getBoundingClientRect().x")
    pg.mouse.move(pb4["x"] + 120, pb4["y"], steps=6)
    pg.wait_for_timeout(200)
    drift = pg.evaluate("document.getElementById('pet').getBoundingClientRect().x") - x1
    check("停顿之后继续拖，窗口跟手（旧实测位移 0）", abs(drift) >= 40,
          "%.1fpx" % drift)
    pg.mouse.up()
    pg.wait_for_timeout(80)
    # 这条专防 Gemini 那个 `moved > 6` 门槛：位移没超过 6px 时它的判据永不触发，
    # 于是"抖一下就把鼠标移出窗口松开"会变成永久粘着（实测 dragging 停在 True，
    # 松手后窗口还跟着鼠标跑）。我们的看门狗不看位移，所以照样收尾。
    pb3 = pet_center()
    pg.mouse.move(pb3["x"], pb3["y"])
    pg.mouse.down()
    pg.mouse.move(pb3["x"] + 1, pb3["y"] + 1)
    pg.wait_for_timeout(60)
    check("测试前提：这一下位移不超过 6px（正好落在它门槛的另一侧）",
          pg.evaluate("moved") <= 6, "moved=%s" % pg.evaluate("Math.round(moved)"))
    check("测试前提：此刻还在拖拽中", pg.evaluate("dragging"))
    pg.wait_for_timeout(2700)
    check("没有位移门槛：小幅抖动后停手，看门狗照样收尾",
          not pg.evaluate("dragging"))
    pg.mouse.up()
    # 收尾后把她放回原位：后面"贴边弹菜单"那段要在她身上点右键。
    pet_center()
    pg.wait_for_timeout(120)
    check("测试前提：拖完把立绘复位（后面还要在它身上点右键）",
          pg.evaluate("document.getElementById('pet').getBoundingClientRect().right")
          <= 341, "right=%s" % pg.evaluate(
              "Math.round(document.getElementById('pet').getBoundingClientRect().right)"))


    # ---- 贴边元素不许被透明窗口裁掉（Gemini #2） ----
    # 右键菜单：真实尺寸 272px 高（Gemini 估的 245 偏小），在 480 高的窗口里
    # 贴着立绘右下角弹出时，不夹取就会露出窗口外 —— 那里既看不见也点不到。
    # 必须点在 #pet 上（菜单只挂在立绘的 contextmenu 上），
    # 所以取立绘包围盒的右下角，而不是窗口的右下角。
    pet_box = pg.evaluate("""(()=>{const r=document.getElementById('pet')
        .getBoundingClientRect();
        return {x:Math.round(r.right)-4, y:Math.round(r.bottom)-4};})()""")
    # 上面几步把设置面板打开了，它盖住立绘 —— 不先关掉，右键点到的就不是 #pet
    if pg.is_visible("#panel"):
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(250)
    pg.evaluate("document.getElementById('menu').classList.add('hidden')")
    pg.mouse.click(pet_box["x"], pet_box["y"], button="right")
    pg.wait_for_timeout(200)
    mrect = pg.evaluate("""(()=>{const m=document.getElementById('menu');
        const r=m.getBoundingClientRect();
        return {hidden:m.classList.contains('hidden'),
                top:r.top,bottom:r.bottom,left:r.left,right:r.right,
                h:r.height,vh:innerHeight,vw:innerWidth};})()""")
    check("极端贴边也能弹出菜单（不是靠运气）", not mrect["hidden"])
    # 9 项菜单跨平台布局契约 (C-08 审计收口)：
    # #menu padding: 4px*2 = 8px; 9 个菜单项各 padding: 7px*2 = 14px，font-size: 12.5px。
    # 字体行高 (line-height: normal) 因系统字体引擎而异：
    # - Windows (Segoe UI / 微软雅黑): line-height ≈ 16.5px -> 单项高 ≈ 30.5px -> 总高 ≈ 282px (实测 272~285px)
    # - Linux Headless CI (DejaVu/FreeSans): line-height ≈ 19.6px -> 单项高 ≈ 33.6px -> 总高 ≈ 310px (实测 295~315px)
    # v0.9.5 新增「实验观测/复盘」使菜单项由 8 项扩充至 9 项，合法渲染区间严格界定为 [260px, 315px]，拒绝无界放宽
    # v1.0 菜单瘦身（放大/缩小退役→滚轮接管）：9 项 → 7 项，区间同步演进（实测 7 项 ≈ 218px）
    # v1.0 菜单 +「衣橱」= 8 项，区间同步演进
    check("8 项菜单高度符合跨平台字体渲染布局契约 [225px, 285px]",
          225 <= mrect["h"] <= 285, "h=%s" % round(mrect["h"]))
    check("菜单下沿不出窗口", mrect["bottom"] <= mrect["vh"] + 1,
          "bottom=%s vh=%s" % (round(mrect["bottom"]), mrect["vh"]))
    check("菜单右沿不出窗口", mrect["right"] <= mrect["vw"] + 1,
          "right=%s vw=%s" % (round(mrect["right"]), mrect["vw"]))
    check("菜单上沿也不出窗口", mrect["top"] >= -1, "top=%s" % round(mrect["top"]))
    pg.evaluate("document.getElementById('menu').classList.add('hidden')")

    # 长回复气泡：必须整块落在立绘上方、窗口之内
    long_text = "这是很长的一条回复。" * 12
    pg.evaluate("t => render(t, false)", long_text)
    pg.wait_for_timeout(150)
    brec = pg.evaluate("""(()=>{const el=document.getElementById('bubble');
        const r=el.getBoundingClientRect(), f=document.getElementById('figure');
        const fr=f.getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,vh:innerHeight,figTop:fr.top,
                max:getComputedStyle(document.documentElement).getPropertyValue('--bubble-max'),
                scrollH:el.scrollHeight};})()""")
    check("长回复被夹在窗口内（顶边不出上沿）", brec["top"] >= -1,
          "top=%s max=%s" % (round(brec["top"]), brec["max"]))
    check("长回复不压到立绘头上", brec["bottom"] <= brec["figTop"] + 1,
          "bottom=%s figTop=%s" % (round(brec["bottom"]), round(brec["figTop"])))
    check("内容确实超出而被裁（说明裁剪在起作用，不是文本变短）",
          brec["scrollH"] > float(brec["max"].strip('px ')),
          "scrollH=%s" % brec["scrollH"])
    shown = pg.text_content("#bubble") or ""
    check("裁掉的是开头、保留的是结尾（最新那句必须在）",
          shown.endswith("这是很长的一条回复。"), repr(shown[-16:]))

    # 回归：--bubble-max 必须跟着窗口尺寸双向走。
    # 旧写法是 if (room > 40) 才写属性，缩到没空间时留着大窗口的旧值；
    # 而且这一版还顺带证明了它不是"只减不加"的一次性写死。
    # 基准值用上面 480 高时实测的 brec["max"]，不写死数字（改安全边距时不用回来改测试）。
    max480 = float(brec["max"].strip('px '))
    pg.set_viewport_size({"width": 340, "height": 420})
    pg.wait_for_timeout(300)
    brec2 = pg.evaluate("""(()=>{const el=document.getElementById('bubble');
        const r=el.getBoundingClientRect();
        return {top:r.top,max:getComputedStyle(document.documentElement)
                 .getPropertyValue('--bubble-max')};})()""")
    max420 = float(brec2["max"].strip('px '))
    check("窗口变小后气泡上限跟着变小", max420 < max480,
          "420:max=%s 480:max=%s" % (round(max420), round(max480)))
    check("窗口变小后气泡仍在窗口内", brec2["top"] >= -1, "top=%s" % round(brec2["top"]))
    pg.set_viewport_size({"width": 340, "height": 480})
    pg.wait_for_timeout(300)
    brec3 = pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bubble-max')")
    check("窗口放大回去气泡上限也放回（不是一次性写死）",
          abs(float(brec3.strip('px ')) - max480) < 1,
          "max=%s want=%s" % (round(float(brec3.strip('px '))), round(max480)))
    pg.evaluate("document.getElementById('bubble').classList.add('hidden')")
    pg.wait_for_timeout(100)
    pg.evaluate("document.getElementById('bubble').classList.remove('hidden')")

    # ---- 换装图层异步加载完之后必须重算气泡上限（Gemini #3） ----
    # fitBubble 按 figure.offsetHeight 推剩余空间，而兜底单图（1015x1171）
    # 与图层画布（760x1000）宽高比不同：实测同一 210px 宽下 242 -> 276。
    # 关键是这**不是闪一下**：Electron 窗口启动后根本不发 resize，
    # 所以旧写法是启动即中、一直错到用户下次手动缩放为止。
    h_fallback = pg.evaluate("document.getElementById('figure').offsetHeight")
    pg.evaluate("t => render(t, false)", "这是很长的一条回复。" * 12)
    pg.wait_for_timeout(120)
    lay = pg.evaluate("""async ()=>{
        const f=document.getElementById('figure');
        const el=document.getElementById('bubble');
        const snap=()=>({h:f.offsetHeight,
          max:getComputedStyle(document.documentElement).getPropertyValue('--bubble-max'),
          ch:el.clientHeight, sh:el.scrollHeight, top:el.getBoundingClientRect().top});
        const before=snap();
        applyLayers([{src:'assets/character/dresses/gothic_black_01.png',z:30},
                     {src:'assets/character/hair/silver_wavy_01.png',z:10}]);
        // 等 Promise.all 落地（含 .then 里的重算）
        for(let i=0;i<40 && !f.classList.contains('layered');i++)
          await new Promise(r=>setTimeout(r,25));
        await new Promise(r=>setTimeout(r,80));
        return {before, after:snap(), vh:innerHeight,
                layered:f.classList.contains('layered')};
    }""")
    b0, a0 = lay["before"], lay["after"]
    check("测试前提：图层加载确实改变了立绘高度（否则这条测不到东西）",
          b0["h"] != a0["h"], "%s -> %s" % (b0["h"], a0["h"]))
    check("立绘高度与兜底实测一致，且图层态更高（242 -> 276 量级）",
          b0["h"] == h_fallback and a0["h"] > b0["h"],
          "%s -> %s" % (b0["h"], a0["h"]))
    mb0 = float(b0["max"].strip('px '))
    mb1 = float(a0["max"].strip('px '))
    check("图层加载完成后 --bubble-max 跟着重算（旧写法留着立绘 242 时算的旧值）",
          abs((mb0 - mb1) - (a0["h"] - b0["h"])) <= 1,
          "max %s->%s 高度 %s->%s" % (round(mb0), round(mb1), b0["h"], a0["h"]))
    check("重算后的上限变小了（立绘更高，可用空间更少）", mb1 < mb0,
          "%s -> %s" % (round(mb0), round(mb1)))
    check("加载完成后长回复气泡顶边仍在窗口内", a0["top"] >= -1,
          "top=%s" % round(a0["top"]))
    # 「只改属性」是不够的：已经上屏的那条长回复必须按新上限重新裁一次。
    # 实测气泡实际渲染高度贴着上限走，且确实比加载前矮了一档。
    check("已经上屏的长回复按新上限重裁（实际高度跟着变小，不是只写属性）",
          abs(a0["ch"] - mb1) <= 2 and a0["ch"] < b0["ch"] - 1 and a0["sh"] > a0["ch"],
          "clientHeight %s->%s 上限=%s scrollH=%s" % (b0["ch"], a0["ch"],
                                                      round(mb1), a0["sh"]))

    # 加载失败这条路也要重算：整套回退时高度是往回缩的，方向相反、同一类问题
    fail = pg.evaluate("""async ()=>{
        const f=document.getElementById('figure');
        const el=document.getElementById('bubble');
        const b0={h:f.offsetHeight,
          max:getComputedStyle(document.documentElement).getPropertyValue('--bubble-max')};
        applyLayers([{src:'assets/character/不存在的图_9999.png',z:30}]);
        for(let i=0;i<40 && f.classList.contains('layered');i++)
          await new Promise(r=>setTimeout(r,25));
        await new Promise(r=>setTimeout(r,120));
        return {b0, h1:f.offsetHeight, layered:f.classList.contains('layered'),
          max1:getComputedStyle(document.documentElement).getPropertyValue('--bubble-max'),
          top:el.getBoundingClientRect().top};
    }""")
    check("图片缺失回退单图时也重算（旧值不会留在更大的立绘上）",
          fail["h1"] == h_fallback and abs(
              float(fail["max1"].strip('px ')) - float(fail["b0"]["max"].strip('px '))
              - (fail["b0"]["h"] - fail["h1"])) <= 1,
          "h %s->%s max %s->%s" % (fail["b0"]["h"], fail["h1"],
                                   fail["b0"]["max"].strip(), fail["max1"].strip()))
    check("回退后气泡仍在窗口内", fail["top"] >= -1, "top=%s" % round(fail["top"]))
    pg.evaluate("document.getElementById('bubble').classList.add('hidden')")
    pg.wait_for_timeout(80)

    # ---- 拖到窗口外松手：桌宠不许粘在鼠标上（Gemini #4） ----
    # 真实成因是光标离开操作系统窗口后渲染进程再也收不到 mouseup，
    # setPointerCapture 修不了它（窗口外的输入属于别的程序）。
    # 兜底有四层，这里验最关键的两层：看门狗 + blur。
    pg.evaluate("document.getElementById('menu').classList.add('hidden')")
    pb = pg.evaluate("""(()=>{const r=document.getElementById('pet').getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+40)};})()""")
    pos0 = pg.evaluate("getComputedStyle(document.getElementById('pet')).left")
    pg.mouse.move(pb["x"], pb["y"])
    pg.mouse.down()
    pg.wait_for_timeout(60)
    pg.mouse.move(pb["x"] + 40, pb["y"] + 10, steps=5)
    pg.wait_for_timeout(60)
    check("按住并移动时进入拖拽态",
          pg.evaluate("document.getElementById('pet').classList.contains('dragging')"))
    pos_drag = pg.evaluate("getComputedStyle(document.getElementById('pet')).left")
    check("预览模式（无 bridge）拖拽确实挪了位置", pos_drag != pos0,
          "%s -> %s" % (pos0, pos_drag))
    # 故意不发 mouseup —— 模拟在窗外松手。
    # 注意这里必须先"晃一下带 buttons=0 的 mousemove"以外的路径：本段测的是
    # 第 4 层兜底（松手后鼠标再也没动过），所以停手时间要跨过新的 2500ms。
    pg.wait_for_timeout(2700)
    check("没有 mouseup 且鼠标不再移动时，看门狗自动收尾（不粘住）",
          not pg.evaluate("document.getElementById('pet').classList.contains('dragging')"))
    pos_after = pg.evaluate("getComputedStyle(document.getElementById('pet')).left")
    pg.mouse.move(pb["x"] + 120, pb["y"] + 80, steps=5)   # 松手后鼠标继续动
    pg.wait_for_timeout(150)
    check("收尾后继续动鼠标不再带着桌宠跑",
          pg.evaluate("getComputedStyle(document.getElementById('pet')).left") == pos_after,
          "%s vs %s" % (pos_after,
                        pg.evaluate("getComputedStyle(document.getElementById('pet')).left")))
    pg.mouse.up()
    pg.wait_for_timeout(60)
    # 第二层兜底：窗口失焦
    pg.mouse.move(pb["x"], pb["y"])
    pg.mouse.down()
    pg.wait_for_timeout(60)
    pg.mouse.move(pb["x"] + 20, pb["y"], steps=3)
    pg.evaluate("window.dispatchEvent(new Event('blur'))")
    pg.wait_for_timeout(60)
    check("窗口 blur 也立刻收尾",
          not pg.evaluate("document.getElementById('pet').classList.contains('dragging')"))
    pg.mouse.up()
    # 正常路径别被兜底弄坏：按 -> 动 -> 松
    pg.mouse.move(pb["x"], pb["y"])
    pg.mouse.down()
    pg.mouse.move(pb["x"] - 30, pb["y"] + 5, steps=4)
    pg.wait_for_timeout(60)
    pg.mouse.up()
    pg.wait_for_timeout(60)
    check("正常 mouseup 仍即时收尾（兜底没把拖拽弄钝）",
          not pg.evaluate("document.getElementById('pet').classList.contains('dragging')"))

    # ---- 立绘尺寸唯一权威 = 显式缩放指令（v1.0 实机反馈：「越拖越大」的根治）----
    # 旧契约「立绘随 innerWidth × 210/340 跟随」正是病根：对话视窗拓宽（340→440）
    # 与 DWM 贴边抖动都会被误当缩放指令，把她的体型逐次撑大固化。
    # 新契约：窗口 resize 绝不动体型（zoomPet 是唯一权威）——窗口怎么变，她都纹丝不动。
    base_pet_w = pg.evaluate("Math.round(document.getElementById('pet').getBoundingClientRect().width)")
    for w, h in ((391, 552), (552, 779), (760, 1073), (200, 282)):
        pg.set_viewport_size({"width": w, "height": h})
        pg.wait_for_timeout(200)
        got = pg.evaluate("Math.round(document.getElementById('pet').getBoundingClientRect().width)")
        check("窗口 %s 宽时立绘体型纹丝不动（显式缩放是唯一权威）" % w,
              abs(got - base_pet_w) <= 1, "got=%s base=%s" % (got, base_pet_w))
    pg.set_viewport_size({"width": 340, "height": 480})
    pg.wait_for_timeout(200)

    pg.screenshot(path="/tmp/pw_final.png")
    # ---- 流式半截标记必须逐帧藏住（Gemini #2：瞬态正则字符集不含 _ 和数字） ----
    # 以前只在"闭合之后"测（见上面「状态标记不会显示在气泡里」），
    # 而缺陷正好发生在闭合之前那几帧：模型吐到 [wear:gothic_ 时旧正则只允许
    # 字母，判定失败，半截标记会闪到屏幕上。这里逐帧调 stripState 看每一帧。
    # id 集合从真实数据层取（不硬编码），衣柜加新品时这条自动覆盖到。
    REAL_IDS = __import__("subprocess").run(
        ["node", "-e",
         "const{CATALOG,PRESETS}=require('./src/wardrobe.js');"
         "console.log(JSON.stringify([...Object.keys(CATALOG),...Object.keys(PRESETS)]))"],
        capture_output=True, text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).stdout
    real_ids = __import__("json").loads(REAL_IDS)
    check("测试前提：从数据层取到的 id 里含带下划线和数字的单品",
          len(real_ids) > 0 and any("_0" in i for i in real_ids), "n=%s" % len(real_ids))
    pg.evaluate("ids => setKnownWear(ids)", real_ids)
    STREAM = "好呀那我换这件[wear:gothic_black_01][state:happy]"
    # 第二参 partial = "还在吐字"。逐帧模拟流式时必须传 true：
    # 半截标记靠的就是这个开关才藏；页面本身没在流式，默认值是 false。
    frames = pg.evaluate("""(full)=>{
        const out=[];
        for(let n=1;n<=full.length;n++)
          out.push({n, raw: full.slice(0,n), shown: stripState(full.slice(0,n), true)});
        return out;
    }""", STREAM)
    # 判据用最严的一种：**任何一帧**屏上都不许出现 [wear / [state，
    # 不管 raw 闭没闭合。未闭合时靠瞬态遮蔽，闭合后靠循环剥离，
    # 两头都封住才是"用户永远看不到它"这句话的意思。
    # （第一版这里用"raw 未闭合"过滤，是因为当时的实现真会在
    #  [state: 那几帧把已经闭合的 wear 标记重新露出来 —— 过滤条件
    #   是为了绕开那个 bug 写的，等于把缺陷藏进了判据里。改成最严判据
    #   后它必须为 0，这个 bug 才被重新暴露并修掉。）
    leaked = [f for f in frames
              if "[wear" in f["shown"] or "[state" in f["shown"]]
    check("半截 [wear:gothic_black_01 的每一帧都不外泄（含 _ 与数字）",
          not [f for f in leaked if "[wear" in f["shown"]],
          "泄漏 %d 帧：%s" % (len([f for f in leaked if "[wear" in f["shown"]]),
                              [f["shown"][-16:] for f in leaked][:3]))
    check("半截 [state:happy 同样逐帧不外泄",
          not [f for f in leaked if "[state" in f["shown"]],
          "泄漏 %s 帧" % len([f for f in leaked if "[state" in f["shown"]]))
    check("逐帧判据确实扫过整条流（不是空转）",
          len(frames) == len(STREAM) and len(STREAM) > 40,
          "帧 %s / 全文 %s 字" % (len(frames), len(STREAM)))
    check("全部吐完后正文干净（两个标记都剥掉）",
          frames[-1]["shown"] == "好呀那我换这件", repr(frames[-1]["shown"]))
    # 反向：藏过头=吞字，比闪一下更糟。未知 id 后端不剥，前端也不能吞。
    # 每条都测两个时刻：partial=true 是"还在吐字"，false 是"流已经结束了"。
    # 截断的那条不能硬编码 id：衣柜里没有 'maid_dress_0' 这种半截前缀时，
    # "吐字途中会被藏"这个前提就不成立，收尾判据会变成空转。
    # 所以从真实 id 里现挑一个带 _ 和数字的，砍掉尾巴两个字符当输入。
    trunc_id = next(i for i in real_ids if "_" in i and any(c.isdigit() for c in i))
    TRUNC = "这件[wear:" + trunc_id[:-2]
    keep = pg.evaluate("""(T)=>{
        return T.map(s => [s, stripState(s, true), stripState(s, false)]);
      }""", ['这个 [wear:maid_dress_01 我不认识',
             '数组写法 [1, 2, 3] 要留着',
             '话说一半 [state:aw',
             '可能要 happy [state:ha',
             '引用一下 [state:happy] 这种标记',
             TRUNC])
    check("陌生 id 未闭合时不藏（与后端「未知值不剥离」同向）",
          keep[0][1] == keep[0][0], repr(keep[0][1]))
    check("正文里的普通方括号不受影响", "[1, 2, 3]" in keep[1][1], repr(keep[1][1]))
    check("长成不了合法值的半截不藏（不吞正文）", keep[2][1] == keep[2][0],
          repr(keep[2][1]))
    check("吐字途中，还可能长成合法词的半截要藏", keep[3][1] == "可能要 happy ", repr(keep[3][1]))
    check("正文中间被引用的完整标记不误伤", "[state:happy]" in keep[4][1], repr(keep[4][1]))
    # 收尾这一帧最要紧：流已经停了，半截标记再也长不成合法标记，
    # 后端此时也不会剥它（parseWear 要 ] 闭合）。这时候还藏就是
    # "屏幕上没有、历史里有" —— 与我否掉「放宽字符集」的理由同一条。
    # 真实成因不稀有：max_tokens 截断、用户点停止都会停在半截上。
    check("收尾后 [state:ha 不再被藏（后端也不会剥它）", keep[3][2] == keep[3][0],
          repr(keep[3][2]))
    check("收尾后半截真 id 不被吞（max_tokens 截断那一类）", keep[5][2] == keep[5][0],
          repr(keep[5][2]))
    check("测试前提：吐字途中这条确实会被藏（否则上一条判据是空转）",
          keep[5][1] != keep[5][0], repr(keep[5][1]))
    # 预览模式没有 bridge，knownWear 为空 —— 此时任何半截 wear 都不该被藏，
    # 因为后端也不会剥它（两边必须剥同一批）。
    pg.evaluate("setKnownWear([])")
    blank = pg.evaluate("stripState('好[wear:gothic_black_01', true)")
    check("knownWear 为空时不藏半截 wear（前后端剥同一批）",
          blank == '好[wear:gothic_black_01', repr(blank))
    pg.evaluate("setKnownWear(%s)" % __import__("json").dumps(real_ids))


    # =====================================================================
    # 方案二封关（v1.0 笔 4）：独立对话窗契约（15 项）
    # 对话迁独立系统窗口（chat.html）：关闭=隐藏不销毁、单一事实源对账、
    # synthetic 反冒充、零伪造时间、失败如实不假装换好。
    # =====================================================================
    pg3.reload()
    pg3.wait_for_timeout(500)

    # ---- A 组：对话窗基础契约（5 项）----
    check("A1 对话窗加载即拉取单一事实源（chatHistory 被调用）",
          pg3.evaluate("window.__calls.some(c => c[0]==='chatHistory')"))
    check("A2 初始历史渲染完整（含 synthetic 与跨窗口条目）",
          pg3.evaluate("document.querySelectorAll('#chatList .b-row').length") == 3)
    check("A3 输入区可用（独立窗自成一体）",
          pg3.is_visible("#input") and pg3.is_visible("#send"))
    check("A4 独立窗无主窗杂物（不承载立绘/面板）",
          pg3.evaluate("document.querySelector('#pet') === null && document.querySelector('#panel') === null"))
    check("A5 对话窗加载全程零 JS 报错", not errs3, "; ".join(errs3[:2]))

    # ---- B 组：发送与关闭语义（7 项）----
    pg3.fill("#input", "你好呀")
    pg3.keyboard.press("Enter")
    pg3.wait_for_timeout(400)
    check("B1 发送即时上屏（Optimistic 用户气泡）",
          pg3.evaluate("[...document.querySelectorAll('#chatList .b-user')].some(r => r.textContent.includes('你好呀'))"))
    check("B2 权威对账收口（无临时态、助手回复落定）",
          pg3.evaluate("document.querySelectorAll('#chatList .b-streaming').length") == 0
          and pg3.evaluate("[...document.querySelectorAll('#chatList .b-text')].some(e => e.textContent.includes('逐字回复'))"))
    check("B3 对话生命周期同步给主窗（chatBusy 起止成对）",
          pg3.evaluate("window.__calls.filter(c => c[0]==='chatBusy').length") >= 2)
    pg3.fill("#input", "boom")
    pg3.keyboard.press("Enter")
    pg3.wait_for_timeout(400)
    check("B4 发送失败如实报错（.b-error，绝不假装换好）",
          pg3.evaluate("document.querySelectorAll('#chatList .b-error').length") == 1
          and pg3.evaluate("[...document.querySelectorAll('#chatList .b-error')].some(e => e.textContent.includes('没送出去'))"))
    pg3.fill("#input", "再试一次")
    pg3.keyboard.press("Enter")
    pg3.wait_for_timeout(400)
    check("B5 失败后重发成功（错误提示被对账清掉）",
          pg3.evaluate("document.querySelectorAll('#chatList .b-error').length") == 0)
    pg3.keyboard.press("Escape")
    pg3.wait_for_timeout(150)
    pg3.mouse.click(200, 300, button="right")
    pg3.wait_for_timeout(150)
    check("B6 双通道关闭语义（ESC / 右键）都走 chatWindowClose",
          pg3.evaluate("window.__calls.filter(c => c[0]==='chatWindowClose').length") >= 2)
    pg3.dblclick("#chatHead")
    pg3.wait_for_timeout(150)
    check("B7 双击标题栏回她身边（chatWindowHome）",
          pg3.evaluate("window.__calls.some(c => c[0]==='chatWindowHome')"))

    # ---- C 组：数据层渲染契约（3 项）----
    check("C1 synthetic 渲染为居中 note（剥前缀、绝不冒充用户气泡）",
          pg3.evaluate("() => { const rows = [...document.querySelectorAll('#chatList .b-row')]; const note = rows.find(r => r.classList.contains('b-note')); return !!note && note.textContent.includes('用户戳了你') && !note.textContent.includes('[自主感知触发]'); }"))
    check("C2 时间严格条件渲染（t 缺失省略时间 DOM）",
          pg3.evaluate("() => { const rows = [...document.querySelectorAll('#chatList .b-row')]; const note = rows.find(r => r.classList.contains('b-note')); return !!note && !note.querySelector('.b-ts'); }"))
    check("C3 bridge→非 bridge 边界渲染窗口分界线",
          pg3.evaluate("() => document.querySelectorAll('#chatList .win-divider').length === 1"))
    pg3.close()
    pg.wait_for_timeout(100)


    pg.screenshot(path="/tmp/pw_final.png")
    check("收尾仍无 JS 报错", not errs, "; ".join(errs[:3]))
    b.close()

print("\n" + ("%d 项失败" % len(fails) if fails else "全部通过"))
