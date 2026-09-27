/**
 * test/research-ipc-export-security.test.js
 * 
 * Codex H-03 独立安全验证：
 * 验证 Renderer-exposed research:export 禁止任意目录写入风险：
 * 1. 渲染进程直接传递 targetDir / targetPath 必须被即刻拒绝 (RENDERER_TARGET_DIR_PROHIBITED)。
 * 2. 内存模式正常返回导出内容，绝不向磁盘写入任何文件。
 * 3. 磁盘模式严格依赖主进程受信任的 native dialog 确认；取消时返回取消状态。
 * 4. 经 dialog 选定目录后安全落盘，文件写入受路径白名单与规范化保护。
 * 5. exportFullResearchBundle 底层严防路径穿越 (..) 攻击。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { registerResearchIpc } = require('../src/research-ipc');
const { exportFullResearchBundle } = require('../src/research-export');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// 模拟 IPC 与 ResearchService 环境
function createMockEnv(tmpDir) {
  const handlers = new Map();
  const mockIpcMain = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    }
  };

  const fakeQuery = {
    getSubjectState: () => ({ traits: { quiet_preference: 60 } }),
    getStateTrajectory: () => [{ windowNo: 1, trait: 'quiet_preference', delta: 10, newValue: 60 }],
    getEvents: () => ({ items: [{ eventId: 'evt-1' }] }),
    getObservations: () => ({ items: [{ observationId: 'obs-1' }] }),
    getInterpretations: () => ({ items: [{ interpretationId: 'int-1' }] }),
    getEvidence: () => ({ items: [{ evidenceId: 'evi-1' }] }),
    getStateChanges: () => ({ items: [{ stateChangeId: 'sc-1' }] })
  };

  const mockResearchService = {
    query: fakeQuery,
    exportData(opts = {}) {
      const { type = 'full', format = 'json', targetDir = null } = opts;
      if (type === 'trajectory') {
        return 'window,trait,previous,delta,newValue\n1,quiet_preference,50,10,60';
      }
      return exportFullResearchBundle(fakeQuery, { targetDir });
    }
  };

  return { handlers, mockIpcMain, mockResearchService, fakeQuery };
}

async function runTests() {
  console.log('--- 测试 H-03: research:export IPC 目录写入安全边界 ---');

  const testDir = path.join(os.tmpdir(), 'life-test-export-sec-' + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    // -------------------------------------------------------------------------
    // 场景 1: 渲染端传入 targetDir / targetPath 等自定义路径，必须直接被拦截
    // -------------------------------------------------------------------------
    console.log('\n[场景 1: 渲染端自定义路径注入拦截]');
    const forbiddenTargetDir = path.join(testDir, 'unauthorized-drop');

    const { handlers, mockIpcMain, mockResearchService, fakeQuery } = createMockEnv(testDir);
    registerResearchIpc(mockIpcMain, mockResearchService, { dialog: null });

    const exportHandler = handlers.get('research:export');
    check('research:export 处理器已正确挂载', typeof exportHandler === 'function');

    const attackRes1 = await exportHandler({}, { targetDir: forbiddenTargetDir });
    check('targetDir 被拒绝', attackRes1.ok === false && attackRes1.error === 'RENDERER_TARGET_DIR_PROHIBITED');
    check('未向磁盘写入未授权目录', !fs.existsSync(forbiddenTargetDir));

    const attackRes2 = await exportHandler({}, { targetPath: forbiddenTargetDir });
    check('targetPath 被拒绝', attackRes2.ok === false && attackRes2.error === 'RENDERER_TARGET_DIR_PROHIBITED');

    const attackRes3 = await exportHandler({}, { destPath: forbiddenTargetDir });
    check('destPath 被拒绝', attackRes3.ok === false && attackRes3.error === 'RENDERER_TARGET_DIR_PROHIBITED');

    const attackRes4 = await exportHandler({}, { destination: forbiddenTargetDir });
    check('destination 被拒绝', attackRes4.ok === false && attackRes4.error === 'RENDERER_TARGET_DIR_PROHIBITED');

    // -------------------------------------------------------------------------
    // 场景 2: 内存导出正常工作，绝不触碰文件系统
    // -------------------------------------------------------------------------
    console.log('\n[场景 2: 内存导出模式验证]');
    const memRes1 = await exportHandler({}, { type: 'trajectory', format: 'csv' });
    check('内存 CSV 轨迹导出成功返回字符串', typeof memRes1 === 'string' && memRes1.includes('quiet_preference'));

    const memRes2 = await exportHandler({}, { type: 'full', format: 'json' });
    check('内存 Full Bundle 导出成功返回文件集合', memRes2 && memRes2.metadata && memRes2.files && memRes2.files['metadata.json']);
    check('Bundle 元数据 appVersion 与当前 Life Version (package.json) 一致', memRes2.metadata.appVersion === require('../package.json').version);

    // -------------------------------------------------------------------------
    // 场景 3: 磁盘模式 - 对话框取消
    // -------------------------------------------------------------------------
    console.log('\n[场景 3: 磁盘模式 - 对话框取消]');
    const mockDialogCancelled = {
      async showOpenDialog() {
        return { canceled: true, filePaths: [] };
      }
    };
    const handlersCancelled = new Map();
    registerResearchIpc({ handle: (c, f) => handlersCancelled.set(c, f) }, mockResearchService, { dialog: mockDialogCancelled });
    const cancelRes = await handlersCancelled.get('research:export')({}, { saveToDisk: true });
    check('用户取消时返回 EXPORT_CANCELLED', cancelRes.ok === false && cancelRes.cancelled === true && cancelRes.error === 'EXPORT_CANCELLED');

    // -------------------------------------------------------------------------
    // 场景 4: 磁盘模式 - 用户通过受信任 Native Dialog 确认目标目录
    // -------------------------------------------------------------------------
    console.log('\n[场景 4: 磁盘模式 - 受信任 Native Dialog 授权写入]');
    const trustedUserSelectedDir = path.join(testDir, 'user-selected-export');
    const mockDialogApproved = {
      async showOpenDialog() {
        return { canceled: false, filePaths: [trustedUserSelectedDir] };
      }
    };
    const handlersApproved = new Map();
    registerResearchIpc({ handle: (c, f) => handlersApproved.set(c, f) }, mockResearchService, { dialog: mockDialogApproved });
    const approvedRes = await handlersApproved.get('research:export')({}, { saveToDisk: true });

    check('用户授权目录导出成功', approvedRes.ok === true && approvedRes.targetDir === trustedUserSelectedDir);
    check('导出目录中存在 metadata.json', fs.existsSync(path.join(trustedUserSelectedDir, 'metadata.json')));
    check('导出目录中存在 state.json', fs.existsSync(path.join(trustedUserSelectedDir, 'state.json')));
    check('导出目录中存在 events.json', fs.existsSync(path.join(trustedUserSelectedDir, 'events.json')));
    check('导出目录中存在 state-changes.json', fs.existsSync(path.join(trustedUserSelectedDir, 'state-changes.json')));

    // -------------------------------------------------------------------------
    // 场景 5: 底层 exportFullResearchBundle 路径遍历强校验防护
    // -------------------------------------------------------------------------
    console.log('\n[场景 5: 底层 exportFullResearchBundle 路径遍历防护]');
    let traversalCaught = false;
    try {
      exportFullResearchBundle(fakeQuery, { targetDir: testDir + '/../should-not-escape' });
    } catch (err) {
      if (err.message.includes('PATH_TRAVERSAL_DETECTED')) {
        traversalCaught = true;
      }
    }
    check('路径中包含 .. 被底层抛出 PATH_TRAVERSAL_DETECTED', traversalCaught);

    let emptyDirCaught = false;
    try {
      exportFullResearchBundle(fakeQuery, { targetDir: '   ' });
    } catch (err) {
      if (err.message.includes('INVALID_TARGET_DIR')) {
        emptyDirCaught = true;
      }
    }
    check('空目标目录被底层抛出 INVALID_TARGET_DIR', emptyDirCaught);

  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (e) {}
  }

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
