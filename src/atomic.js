const fs = require('fs');
const path = require('path');

/**
 * 原子写：先写同目录临时文件 + fsync，再 rename 覆盖。
 *
 * 为什么需要：memory.json 是这台桌宠的全部长期记忆，stats.json 是账单数据，
 * 它们此前都是 fs.writeFileSync 直接覆盖。写一半时断电/进程被杀，
 * 文件就成了半截 JSON，下次启动 load() 走进 catch —— 表现为「记忆全没了」，
 * 而且用户完全不知道发生了什么。
 * rename 在同一文件系统内是原子的：要么旧内容，要么新内容，没有中间态。
 *
 * 只解决「撕裂」，不解决「误删」——那需要备份策略，这里刻意不做。
 */

const RENAME_RETRIES = 3;
const RETRY_MS = 15;

/**
 * Windows 上 rename 覆盖一个刚被读过的文件，偶发 EPERM/EBUSY：
 * 杀毒软件、Windows Search 索引、OneDrive 同步都可能在别人 close 之后
 * 还短暂持有句柄。这类是瞬态错误，隔十几毫秒重试基本就过了；
 * 真·权限问题（比如目录只读）重试也不会过，所以次数要有限。
 *
 * 同步 sleep：这几个写都在主进程的关键路径上，本来就已经同步阻塞，
 * 最坏情况多等 45ms，换来的是「不会一次偶发就丢掉整份记忆」。
 */
function retryable(e) {
  return e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (!retryable(e) || attempt >= RENAME_RETRIES) throw e;
      sleepMs(RETRY_MS * (attempt + 1));      // 线性退避：给占用句柄一点时间释放
    }
  }
}

// 单独抽出来，测试里可以替换成不真等 clock 的实现
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tmpNameFor(file) {
  // 光用 pid 不够：用户把桌宠开两份（或者 dev 版和打包版同目录）时 pid 不同但
  // 文件名相同也没关系，真正会撞的是"同一个 pid 里异步交叠"——本模块全是同步写，
  // 所以这里加随机后缀主要是为了防呆，而不是修一个已经发生的 bug。
  const rnd = Math.random().toString(36).slice(2, 8);
  return path.join(path.dirname(file),
    '.' + path.basename(file) + '.tmp-' + process.pid + '-' + rnd);
}

function writeFileAtomic(file, data, opts = {}) {
  const tmp = tmpNameFor(file);
  try {
    // SEC-05: opts.mode（如 0o600）在创建时即生效，不依赖默认 umask；不传则行为不变
    const fd = fs.openSync(tmp, 'w', opts.mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);          // 数据进盘再 rename，否则崩溃后可能读到零字节
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);  // 同目录 rename 是原子的，Windows 下同样覆盖
    if (opts.mode !== undefined) {
      // SEC-05: 落盘后再次确保 mode（rename 携带 inode mode，此处双保险；Windows chmod 语义有限则容忍）
      try { fs.chmodSync(file, opts.mode); } catch {}
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖真正的错误 */ }
    throw e;
  }
}

function writeJsonAtomic(file, obj, opts = {}) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2), opts);
}

module.exports = {
  writeFileAtomic,
  writeJsonAtomic,
  renameWithRetry,
  tmpNameFor,
  // 导出给测试用；不是给业务代码调的
  _internals: { renameWithRetry, tmpNameFor, RENAME_RETRIES }
};
