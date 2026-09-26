/**
 * 延迟写入器测试
 *
 * 覆盖：
 * 1. markDirty 后 flush 立即写盘
 * 2. flush 时 dirty=false 不调用 writeFn
 * 3. 连续多次 markDirty 在 flush 时只写一次
 * 4. writeFn 抛异常时 dirty 标记保持为 true
 * 5. flush 抛异常后仍可再次 flush
 * 6. isDirty getter 正确反映状态
 * 7. 构造参数与默认配置
 * 8. flush 时正确清除未决定时器
 */
const assert = require('assert');
const { DeferredWriter } = require('../src/deferred-writer');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + '  ' + e.message);
  }
}

// 1. markDirty 后 flush 立即写盘
check('markDirty 后 flush 立即写盘', () => {
  let writes = 0;
  const writer = new DeferredWriter(() => { writes++; });
  writer.markDirty();
  assert.strictEqual(writes, 0, 'flush 之前不应执行写入');
  writer.flush();
  assert.strictEqual(writes, 1, 'flush 之后应立即完成一次写盘');
  assert.strictEqual(writer.isDirty, false, 'flush 之后 dirty 状态应为 false');
});

// 2. flush 时 dirty=false 不调用 writeFn
check('flush 时 dirty=false 不调用 writeFn', () => {
  let writes = 0;
  const writer = new DeferredWriter(() => { writes++; });
  assert.strictEqual(writer.isDirty, false);
  writer.flush();
  assert.strictEqual(writes, 0, 'dirty 为 false 时 flush 不应调用 writeFn');
});

// 3. 连续多次 markDirty 在 flush 时只写一次
check('连续多次 markDirty 在 flush 时只写一次', () => {
  let writes = 0;
  const writer = new DeferredWriter(() => { writes++; });
  writer.markDirty();
  writer.markDirty();
  writer.markDirty();
  assert.strictEqual(writes, 0);
  writer.flush();
  assert.strictEqual(writes, 1, '多次 markDirty 仅在 flush 时触发单次写入');
  assert.strictEqual(writer.isDirty, false);
});

// 4. writeFn 抛异常时 dirty 标记保持为 true
check('writeFn 抛异常时 dirty 标记保持为 true', () => {
  const customError = new Error('模拟磁盘写入异常');
  const writer = new DeferredWriter(() => {
    throw customError;
  });
  writer.markDirty();
  assert.strictEqual(writer.isDirty, true);
  assert.throws(() => {
    writer.flush();
  }, (err) => err === customError);
  assert.strictEqual(writer.isDirty, true, '写入抛出异常后 dirty 标记必须保持为 true');
});

// 5. flush 抛异常后仍可再次 flush
check('flush 抛异常后仍可再次 flush', () => {
  let attempts = 0;
  let successWrites = 0;
  const writer = new DeferredWriter(() => {
    attempts++;
    if (attempts === 1) {
      throw new Error('首次写入失败');
    }
    successWrites++;
  });
  writer.markDirty();

  // 第一次 flush 抛出异常
  assert.throws(() => {
    writer.flush();
  }, /首次写入失败/);
  assert.strictEqual(writer.isDirty, true, '首次异常后 dirty 标记仍为 true');
  assert.strictEqual(attempts, 1);
  assert.strictEqual(successWrites, 0);

  // 第二次 flush 应该可以重试并成功
  writer.flush();
  assert.strictEqual(attempts, 2);
  assert.strictEqual(successWrites, 1, '第二次 flush 应能成功重试写入');
  assert.strictEqual(writer.isDirty, false, '第二次 flush 成功后 dirty 应清空');
});

// 6. isDirty getter 正确反映状态
check('isDirty getter 正确反映状态', () => {
  const writer = new DeferredWriter(() => {});
  assert.strictEqual(writer.isDirty, false, '初始状态 isDirty 应为 false');
  writer.markDirty();
  assert.strictEqual(writer.isDirty, true, '调用 markDirty 后 isDirty 应为 true');
  writer.flush();
  assert.strictEqual(writer.isDirty, false, 'flush 之后 isDirty 应恢复为 false');
});

// 7. 构造参数与默认配置
check('构造参数校验与默认延迟配置', () => {
  assert.throws(() => new DeferredWriter(null), TypeError, 'writeFn 非函数时必须抛 TypeError');
  assert.throws(() => new DeferredWriter('string'), TypeError, 'writeFn 非函数时必须抛 TypeError');

  const defaultWriter = new DeferredWriter(() => {});
  assert.strictEqual(defaultWriter._delayMs, 3000, '默认延迟应为 3000ms');

  const customWriter = new DeferredWriter(() => {}, { delayMs: 1500 });
  assert.strictEqual(customWriter._delayMs, 1500, '自定义延迟应为 1500ms');
});

// 8. flush 时正确清除未决定时器
check('flush 会清除未决的定时器', () => {
  let writes = 0;
  const writer = new DeferredWriter(() => { writes++; }, { delayMs: 10000 });
  writer.markDirty();
  assert.ok(writer._timer !== null, 'markDirty 应建立未决定时器');
  writer.flush();
  assert.strictEqual(writer._timer, null, 'flush 应清除未决定时器');
  assert.strictEqual(writes, 1);
});

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
