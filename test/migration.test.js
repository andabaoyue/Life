const assert = require('assert');
const { migrate } = require('../src/migration');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  ' + e.message); }
}

// 1. 无需迁移时原样返回（version already current）
check('无需迁移时原样返回对象与版本信息', () => {
  const original = { schemaVersion: 2, key: 'value' };
  const res = migrate(original, 2, {});
  assert.strictEqual(res.migrated, false);
  assert.strictEqual(res.fromVersion, 2);
  assert.strictEqual(res.data, original);
});

check('版本均为 0 时无需迁移直接原样返回', () => {
  const original = { text: 'no version specified' };
  const res = migrate(original, 0, {});
  assert.strictEqual(res.migrated, false);
  assert.strictEqual(res.fromVersion, 0);
  assert.strictEqual(res.data, original);
});

// 2. v0→v1 单步迁移
check('v0→v1 单步迁移正确填充默认字段与版本号', () => {
  const original = { name: '初澜' };
  const res = migrate(original, 1, {
    1: (d) => ({ ...d, mood: 'happy' })
  });
  assert.strictEqual(res.migrated, true);
  assert.strictEqual(res.fromVersion, 0);
  assert.strictEqual(res.data.name, '初澜');
  assert.strictEqual(res.data.mood, 'happy');
  assert.strictEqual(res.data.schemaVersion, 1);
});

// 3. v0→v1→v2 链式迁移
check('v0→v1→v2 链式迁移按升序依次执行各版本函数', () => {
  const steps = [];
  const original = { name: '初澜' };
  const res = migrate(original, 2, {
    1: (d) => {
      steps.push(1);
      return { ...d, step1: 'done' };
    },
    2: (d) => {
      steps.push(2);
      assert.strictEqual(d.step1, 'done');
      assert.strictEqual(d.schemaVersion, 1);
      return { ...d, step2: 'done' };
    }
  });
  assert.strictEqual(res.migrated, true);
  assert.strictEqual(res.fromVersion, 0);
  assert.deepStrictEqual(steps, [1, 2]);
  assert.strictEqual(res.data.step1, 'done');
  assert.strictEqual(res.data.step2, 'done');
  assert.strictEqual(res.data.schemaVersion, 2);
});

check('v1→v2 增量迁移只执行未完成的版本函数', () => {
  const steps = [];
  const v1Data = { schemaVersion: 1, step1: 'already' };
  const res = migrate(v1Data, 2, {
    1: () => { steps.push(1); },
    2: (d) => {
      steps.push(2);
      return { ...d, step2: 'added' };
    }
  });
  assert.strictEqual(res.migrated, true);
  assert.strictEqual(res.fromVersion, 1);
  assert.deepStrictEqual(steps, [2]);
  assert.strictEqual(res.data.step1, 'already');
  assert.strictEqual(res.data.step2, 'added');
  assert.strictEqual(res.data.schemaVersion, 2);
});

// 4. 缺少迁移函数时抛异常
check('缺少目标版本的迁移函数时抛出清晰异常', () => {
  assert.throws(
    () => migrate({ schemaVersion: 0 }, 1, {}),
    (err) => {
      assert.strictEqual(err.message, '缺少 v1 的迁移函数');
      return true;
    }
  );
});

check('中间步骤缺少迁移函数时中断并抛出对应缺失版本的异常', () => {
  let v1Ran = false;
  assert.throws(
    () => migrate({ schemaVersion: 0 }, 3, {
      1: (d) => { v1Ran = true; return d; },
      3: (d) => d
    }),
    (err) => {
      assert.strictEqual(err.message, '缺少 v2 的迁移函数');
      return true;
    }
  );
  assert.strictEqual(v1Ran, true);
});

// 5. 数据版本高于程序版本时抛异常
check('数据版本高于程序版本时抛异常提示升级程序', () => {
  assert.throws(
    () => migrate({ schemaVersion: 5 }, 2, {}),
    (err) => {
      assert.strictEqual(err.message, '数据版本 (5) 高于程序版本 (2)，请升级程序');
      return true;
    }
  );
});

// 6. data 为 null/undefined 时 fromVersion = 0
check('data 为 null 时 fromVersion 默认为 0 并可正常迁移', () => {
  const res = migrate(null, 1, {
    1: (d) => {
      assert.strictEqual(d, null);
      return { initialized: true };
    }
  });
  assert.strictEqual(res.fromVersion, 0);
  assert.strictEqual(res.migrated, true);
  assert.strictEqual(res.data.initialized, true);
  assert.strictEqual(res.data.schemaVersion, 1);
});

check('data 为 undefined 时 fromVersion 默认为 0 并可正常迁移', () => {
  const res = migrate(undefined, 1, {
    1: (d) => {
      assert.strictEqual(d, undefined);
      return { initialized: true };
    }
  });
  assert.strictEqual(res.fromVersion, 0);
  assert.strictEqual(res.migrated, true);
  assert.strictEqual(res.data.initialized, true);
  assert.strictEqual(res.data.schemaVersion, 1);
});

check('data 为 null 且 currentVersion 为 0 时无需迁移直接返回', () => {
  const res = migrate(null, 0, {});
  assert.strictEqual(res.fromVersion, 0);
  assert.strictEqual(res.migrated, false);
  assert.strictEqual(res.data, null);
});

// 7. 自定义 versionKey（如 'version'）正常工作
check('自定义 versionKey（如 version）读取与回写正确', () => {
  const data = { version: 1, trait: '温柔' };
  const res = migrate(data, 2, {
    2: (d) => ({ ...d, level: 99 })
  }, { versionKey: 'version' });

  assert.strictEqual(res.migrated, true);
  assert.strictEqual(res.fromVersion, 1);
  assert.strictEqual(res.data.version, 2);
  assert.strictEqual(res.data.schemaVersion, undefined);
  assert.strictEqual(res.data.trait, '温柔');
  assert.strictEqual(res.data.level, 99);
});

check('自定义 versionKey 高于程序版本时也能正确校验抛错', () => {
  assert.throws(
    () => migrate({ version: 3 }, 1, {}, { versionKey: 'version' }),
    (err) => {
      assert.strictEqual(err.message, '数据版本 (3) 高于程序版本 (1)，请升级程序');
      return true;
    }
  );
});

// 8. 迁移函数抛异常时原样传播（不吞异常）
check('迁移函数内部抛出异常时原样向外传播', () => {
  const customError = new Error('自定义迁移中断');
  assert.throws(
    () => migrate({ schemaVersion: 0 }, 1, {
      1: () => { throw customError; }
    }),
    (err) => {
      assert.strictEqual(err, customError);
      return true;
    }
  );
});

// 9. migrated 返回值正确
check('migrated 标志位正确反映是否执行了迁移', () => {
  const noop = migrate({ schemaVersion: 3 }, 3, {});
  assert.strictEqual(noop.migrated, false);

  const applied = migrate({ schemaVersion: 1 }, 2, {
    2: (d) => ({ ...d })
  });
  assert.strictEqual(applied.migrated, true);
});

// 额外健全性检查：版本字段非有限数字（NaN、字符串、缺失）均防御降级为 0
check('非数字或无效版本字段防御处理为 0', () => {
  const nanRes = migrate({ schemaVersion: NaN }, 1, { 1: (d) => ({ ...d, fixed: true }) });
  assert.strictEqual(nanRes.fromVersion, 0);
  assert.strictEqual(nanRes.migrated, true);
  assert.strictEqual(nanRes.data.schemaVersion, 1);

  const strRes = migrate({ schemaVersion: 'v1' }, 1, { 1: (d) => ({ ...d, fixed: true }) });
  assert.strictEqual(strRes.fromVersion, 0);
  assert.strictEqual(strRes.migrated, true);
  assert.strictEqual(strRes.data.schemaVersion, 1);
});

// 额外检查：迁移函数就地修改原对象而不显式 return
check('迁移函数就地修改原对象时正常保留并更新版本号', () => {
  const target = { count: 10 };
  const res = migrate(target, 1, {
    1: (d) => { d.count += 5; } // 未显式 return
  });
  assert.strictEqual(res.migrated, true);
  assert.strictEqual(res.data.count, 15);
  assert.strictEqual(res.data.schemaVersion, 1);
});

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
