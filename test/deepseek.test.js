/**
 * DeepSeek 客户端测试 —— 流内错误与峰谷判定。
 *
 * 两块都是"错了不会崩、只会静默给出错误答案"的地方：
 *   1. OpenAI 兼容服务在流里报错时 HTTP 仍是 200，不接住就等于
 *      把半截回复当成功、真实原因永久丢失（余额耗尽会被显示成"返回空内容"）。
 *   2. 峰谷价直接影响花费估算，判定不能依赖宿主时区。
 */
const http = require('http');
const { execFileSync } = require('child_process');
const path = require('path');
const { DeepSeek, isPeakHour, costOf } = require('../src/deepseek');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const pkg = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const DELTA = (t) => pkg({ choices: [{ delta: { content: t } }] });
const DONE = 'data: [DONE]\n\n';

async function main() {
  /* 每个用例用 model 名选服务端行为，跟 brain.test.js 里那套一致 */
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const model = JSON.parse(body).model;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      switch (model) {
        case 'err-mid':                    // 说了一半才报错（余额耗尽/审核拦截）
          res.write(DELTA('今天天气'));
          res.write(pkg({ error: { message: 'Insufficient Balance', type: 'invalid_request_error' } }));
          res.write(DONE); res.end(); break;
        case 'err-first':                  // 一个字都没有就报错
          res.write(pkg({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }));
          res.write(DONE); res.end(); break;
        case 'err-bare':                   // 报错但没 message 没 type 没 code
          res.write(DELTA('半句'));
          res.write(pkg({ error: {} }));
          res.end(); break;
        case 'err-no-error':               // 反面对照：正常流不许被当成错误
          res.write(DELTA('好')); res.write(DONE); res.end(); break;
        case 'err-after-delta-json-broken':// 坏 JSON 行照旧忽略，后面的错误仍然接住
          res.write(DELTA('前'));
          res.write('data: {坏掉的 json\n\n');
          res.write(pkg({ error: { message: 'boom' } }));
          res.end(); break;
        default:
          res.write(DELTA('正常')); res.write(DONE); res.end();
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const grab = async (model) => {
    const d = new DeepSeek({ baseURL: base, apiKey: 't', model });
    let streamed = '';
    try {
      const r = await d.stream([{ role: 'user', content: 'hi' }], x => { streamed += x; });
      return { ok: true, r, streamed };
    } catch (e) {
      return { ok: false, e, streamed };
    }
  };

  /* ---- 1. 流内报错必须抛出，而不是当成成功 ---- */
  const a = await grab('err-mid');
  check('流中途报错会抛出（旧行为：静默返回半截 + 空 usage）', a.ok === false,
    a.ok ? '没抛错' : a.e.message);
  check('抛出的是服务端的真实原因，不是"返回空内容"',
    /Insufficient Balance/.test(a.e.message), JSON.stringify(a.e.message));
  check('带上 type/code 便于自查', /invalid_request_error/.test(a.e.message),
    JSON.stringify(a.e.message));
  check('已经收到的半截回复挂在 error.partial 上', a.e.partial === '今天天气',
    JSON.stringify(a.e.partial));
  check('半截也确实逐字上屏过（用户看得见"说到一半断的"）', a.streamed === '今天天气');

  const b = await grab('err-first');
  check('一个字都没有就报错：照样抛出真实原因',
    !b.ok && /Rate limit reached/.test(b.e.message) && b.e.partial === '',
    JSON.stringify(b.e && b.e.message));

  const c = await grab('err-bare');
  check('error 里啥字段都没有也不崩：把整个对象原样带出，并保留半截',
    !c.ok && c.e.message === '{}' && c.e.partial === '半句',
    JSON.stringify([c.e && c.e.message, c.e && c.e.partial]));

  const bj = await grab('err-after-delta-json-broken');
  check('坏 JSON 行仍被忽略，紧随其后的错误帧仍接得住',
    !bj.ok && /boom/.test(bj.e.message) && bj.e.partial === '前',
    JSON.stringify([bj.ok, bj.e && bj.e.message, bj.e && bj.e.partial]));

  const n = await grab('err-no-error');
  check('对照：正常流不受影响（没有 error 字段时不报错）',
    n.ok && n.r.text === '好', JSON.stringify([n.ok, n.r && n.r.text]));

  /* 报错时不该再把后续帧/尾巴当正文处理：文本长度必须正好等于半截 */
  check('报错后不再继续消费流（文本没有被后续内容污染）',
    a.ok === false && a.e.partial.length === 4, JSON.stringify(a.e.partial));

  /* ---- 1.5 报错之后必须把底层流释放掉（reader.cancel）----
     break 只是"不再消费"，连接还开着。真实服务经常就是这样：error 帧写完
     就挂着等客户端走。桌宠是常驻进程，而报错往往是连续的（余额耗尽时
     每轮都报），不释放就是越用越多的挂起连接。
     判据一律用**服务端视角**：客户端 cancel 之后服务端会收到 res 'close'。
     不在客户端数 socket —— undici 的 keep-alive 池自带固定基线，实测单次
     请求就 +2，泄漏量会被基线噪声盖住；上一轮就是这样差点得出错误结论。 */
  {
    let closed = 0, aborted = 0, endedByServer = 0;
    const linger = http.createServer((req, res) => {
      req.on('aborted', () => { aborted++; });
      const realEnd = res.end.bind(res);
      res.end = (...a) => { endedByServer++; return realEnd(...a); };
      // 必须真的把请求体喝掉，否则 IncomingMessage 一直暂停、'end' 不来，
      // 服务端就永远不写响应 —— 测试会卡在这里而不是卡在被测代码上。
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(DELTA('半句'));
        res.write(pkg({ error: { message: 'Insufficient Balance' } }));
        // 刻意不 res.end()：这条连接只能由客户端来断
      });
      res.on('close', () => { closed++; });
    });
    await new Promise(r => linger.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + linger.address().port;
    const d = new DeepSeek({ baseURL: url, apiKey: 'x', model: 'm' });
    let threw = null;
    try { await d.stream([{ role: 'user', content: 'hi' }], () => {}); }
    catch (e) { threw = e; }
    check('流内报错时确实抛出（前提，别只测释放）',
      threw && /Insufficient Balance/.test(threw.message));

    // 连跑 6 次：每一次服务端都必须看到连接被关掉
    for (let i = 0; i < 6; i++) {
      try { await d.stream([{ role: 'user', content: 'hi' }], () => {}); } catch {}
    }
    const want = 7;                       // 前面那 1 次 + 这里 6 次
    for (let i = 0; i < 40 && closed < want; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    check('报错后服务端那边连接已关闭（客户端主动 cancel，不是挂着等超时）',
      closed >= want, '服务端收到 close ' + closed + ' 次，共 ' + want + ' 个请求');
    // 这个 close 只能算在客户端头上：服务端在整段代码里**从没调用过 res.end()**，
    // 也没有超时逻辑，所以它不可能是"服务端主动关的"。
    // （原本这里想断言 req 的 'aborted' 事件先于 close，但那个事件自 Node 16
    //  起已废弃、实测一次都不触发 —— 拿不存在的信号当判据等于没判。）
    check('服务端从未自行结束响应（close 只能来自客户端断开）',
      endedByServer === 0, 'serverEnd=' + endedByServer);
    check(want + ' 次连续报错没有一次漏掉释放（逐条对应）', closed === want,
      'close=' + closed);
    linger.close();
  }

  /* HTTP 非 200：这条路径本来就对，留个护栏别改坏 */
  {
    const bad = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
    await new Promise(r => bad.listen(0, '127.0.0.1', r));
    const d = new DeepSeek({ baseURL: 'http://127.0.0.1:' + bad.address().port,
                             apiKey: 'x', model: 'm' });
    let msg = '';
    try { await d.stream([{ role: 'user', content: 'hi' }]); } catch (e) { msg = e.message; }
    check('HTTP 401 抛出含状态码与服务端正文',
      /401/.test(msg) && /invalid api key/.test(msg), JSON.stringify(msg));
    bad.close();
  }
  srv.close();

  /* ---- 2. 峰谷判定：宿主时区不参与 ----
     isPeakHour 一律用 getUTC*（先把瞬间平移 8 小时），所以理论上与 TZ 无关。
     "理论上"不算证据，起子进程在四种宿主时区下跑同一批时刻实测。 */
  const CASES = [
    // ISO 瞬间,              说明,                       期望峰?
    ['2026-09-21T02:30:00Z', '北京周一 10:30',            true],
    ['2026-09-21T01:00:00Z', '北京周一 09:00 整点即峰',    true],
    ['2026-09-21T00:59:59Z', '北京周一 08:59 差一分钟',    false],
    ['2026-09-21T03:59:59Z', '北京 11:59 上午末',          true],
    ['2026-09-21T04:00:00Z', '北京 12:00 午休转谷',        false],
    ['2026-09-21T06:00:00Z', '北京 14:00 下午开峰',        true],
    ['2026-09-21T09:59:59Z', '北京 17:59 下班前一分钟',    true],
    ['2026-09-21T10:00:00Z', '北京 18:00 整点即谷',        false],
    ['2026-09-19T02:30:00Z', '北京周六一律谷',             false],
    ['2026-09-20T02:30:00Z', '周日（恰是调休补班日）仍谷', false],
    ['2026-10-01T02:30:00Z', '国庆工作日但全天谷',         false],
    ['2026-02-17T02:30:00Z', '春节假期中的周二',           false],
    ['2026-04-06T02:30:00Z', '清明假期',                   false],
    ['2026-09-25T01:30:00Z', '中秋假期（周五）',           false]
  ];
  const script = path.join(__dirname, '..', 'src', 'deepseek.js');
  const TZONE = ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin', 'UTC', 'Pacific/Kiritimati'];
  const runIn = (tz) => {
    const js = `const {isPeakHour}=require(${JSON.stringify(script)});
      const C=${JSON.stringify(CASES)};
      console.log(JSON.stringify(C.map(x=>isPeakHour(new Date(x[0])))));`;
    return JSON.parse(execFileSync(process.execPath, ['-e', js],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim());
  };
  const reference = runIn('Asia/Shanghai');
  let tzMismatch = [];
  for (const tz of TZONE) {
    const got = runIn(tz);
    got.forEach((v, i) => { if (v !== CASES[i][2]) tzMismatch.push(tz + ' @ ' + CASES[i][1]); });
  }
  check('14 个关键时刻在 5 种宿主时区下判定全部正确（含 DST 时区）',
    tzMismatch.length === 0, tzMismatch.slice(0, 3).join(' | '));
  check('Asia/Shanghai 的实测结果与用例表一致（用例表不是抄代码抄出来的）',
    JSON.stringify(reference) === JSON.stringify(CASES.map(x => x[2])));

  /* 不传参数时用的是"现在"，别退化成 undefined */
  check('默认取当前时间且不抛', typeof isPeakHour() === 'boolean');

  /* ---- 3. 调休表：核对表本身，而不是只核逻辑 ---- */
  {
    const src = require('fs').readFileSync(script, 'utf8');
    const grabSet = (name) => {
      const m = src.match(new RegExp(name + " = new Set\\(\\[([\\s\\S]*?)\\]\\)"));
      return m ? [...m[1].matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map(x => x[1]) : [];
    };
    const hol = grabSet('HOLIDAYS'), mk = grabSet('MAKEUP_WORKDAYS');
    check('节假日表非空且全部是 2026 年（过期了至少要看得出来）',
      hol.length >= 20 && hol.every(d => d.startsWith('2026')), hol.length + ' 天');
    check('调休表就是通知里那 6 天，不多不少',
      JSON.stringify(mk) === JSON.stringify(['2026-01-04', '2026-02-14', '2026-02-28',
        '2026-05-09', '2026-09-20', '2026-10-10']), mk.join(','));
    check('两张表不互相重叠（同一天既是假期又是补班 = 抄错了）',
      mk.filter(d => hol.includes(d)).length === 0);
    // 补班日应当落在周末，否则它就真的在改变判定（现行安排下 6 天全是周六/周日）
    check('调休日全部落在周六/周日（与通知一致，所以这张表目前是冗余护栏）',
      mk.every(d => { const g = new Date(d + 'T00:00:00Z').getUTCDay(); return g === 0 || g === 6; }));
    // 关键方向性检查：普通工作日高峰绝不能被误标成谷
    {
      const plainPeak = ['2026-03-09', '2026-04-07', '2026-06-18', '2026-09-21', '2026-11-11'];
      const wrongly = plainPeak.filter(d => {
        const g = new Date(d + 'T00:00:00Z').getUTCDay();
        if (g === 0 || g === 6) return false;              // 周末本来就谷，不算错
        return hol.includes(d) || mk.includes(d);
      });
      check('没有把普通工作日标成补班/假期（那会把高峰算成低谷、少算钱）',
        wrongly.length === 0, wrongly.join(','));
    }
  }

  /* ---- 4. costOf 与峰谷联动 ---- */
  check('costOf 按档位分别计价', (() => {
    const u = { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 };
    const p = { hit: 0.04, miss: 2, out: 8 };
    return Math.abs(costOf(u, p) - 10.04) < 1e-9;
  })(), costOf({ prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6,
                 completion_tokens: 1e6 }, { hit: 0.04, miss: 2, out: 8 }));
  check('usage 缺字段按 0 算而不是 NaN',
    costOf({}, { hit: 1, miss: 1, out: 1 }) === 0 && !Number.isNaN(costOf({}, {})));

  /* ---- 5. P1-1 & P1-2: 流式生命周期 AbortSignal 与双超时隔离 ---- */
  {
    let abortTestClosed = false;
    const streamSrv = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(DELTA('第1句'));
        // 挂起不结束，等待客户端操作
      });
      res.on('close', () => { abortTestClosed = true; });
    });
    await new Promise(r => streamSrv.listen(0, '127.0.0.1', r));
    const srvUrl = 'http://127.0.0.1:' + streamSrv.address().port;

    // 5.1 caller AbortSignal 中途取消测试
    const dAbort = new DeepSeek({ baseURL: srvUrl, apiKey: 'k', model: 'm', streamIdleTimeoutMs: 10000 });
    const ac = new AbortController();
    let receivedFirst = '';
    const streamPromise = dAbort.stream([{ role: 'user', content: 'test' }], chunk => {
      receivedFirst += chunk;
      ac.abort(new Error('user cancelled'));
    }, { signal: ac.signal });

    let abortCaught = null;
    try {
      await streamPromise;
    } catch (e) {
      abortCaught = e;
    }
    check('P1-1: 中途触发 AbortSignal 立即中止流式读取', abortCaught && /user cancelled/.test(abortCaught.message));
    check('P1-1: 中途取消保留已接收的 partial 文本', abortCaught && abortCaught.partial === '第1句');

    // 等待服务端收到连接释放
    for (let i = 0; i < 20 && !abortTestClosed; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    check('P1-1: AbortSignal 取消后底层 reader 与连接已释放', abortTestClosed === true);

    // 5.2 streamIdleTimeoutMs 块间空闲超时测试
    const dIdle = new DeepSeek({ baseURL: srvUrl, apiKey: 'k', model: 'm', streamIdleTimeoutMs: 100 });
    let idleCaught = null;
    try {
      await dIdle.stream([{ role: 'user', content: 'test' }], () => {});
    } catch (e) {
      idleCaught = e;
    }
    check('P1-2: 超过 streamIdleTimeoutMs 触发 stream idle timeout',
      idleCaught && idleCaught.message === 'stream idle timeout' && idleCaught.name === 'TimeoutError');

    // 5.3 requestTimeoutMs 全局生命周期超时测试
    const dReq = new DeepSeek({ baseURL: srvUrl, apiKey: 'k', model: 'm', requestTimeoutMs: 100, streamIdleTimeoutMs: 5000 });
    let reqCaught = null;
    try {
      await dReq.stream([{ role: 'user', content: 'test' }], () => {});
    } catch (e) {
      reqCaught = e;
    }
    check('P1-2: 超过 requestTimeoutMs 触发 request timeout',
      reqCaught && reqCaught.message === 'request timeout' && reqCaught.name === 'TimeoutError');

    streamSrv.close();
  }

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃', e); process.exit(1); });
