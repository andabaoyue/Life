/**
 * src/agent-sandbox.js
 *
 * v1.0 D-5：沙盒目录定位与启用。
 *
 * ## 这个模块解决什么
 *
 * D-4 把受控执行器接上了，但main.js 维持**三重默认关闭**（killSwitch=true、
 * allowed=[]、未配 scope 根），所以执行器虽在，实际动不了任何用户文件。
 * D-5 起按用户拍板放开一条路：**桌面 LifeSandbox/ 子目录**。
 *
 * ## 🔴 用户拍板时的附带条件（必须写在代码里，不能只写在文档里）
 *
 * 拍板原文：「请在注释和 README 里写明**沙盒内文件一律视为可被 Agent 覆写**。
 * 用户可能自己往里丢东西，没有这条约定就等于默认授权了。」
 *
 * 所以本模块的 SANDBOX_NOTICE 是给用户看的正式约定，不是内部实现细节。
 * 渲染层展示沙盒路径时应一并展示，避免用户往里丢重要文件后被静默覆写。
 *
 * ## 为什么不用 userData（拍板时的取舍）
 *
 * 桌面目录「用户一眼看得见」是刻意的：出问题能自己翻、能自己清理。
 * 代价是它会出现在用户桌面上、可能被云同步/备份扫到 —— 对一个
 * 「可被Agent 覆写」的目录来说，这些反而是应该被看见的行为，不是风险。
 *
 * ## 边界
 *
 * 本模块**只负责定位与确保目录存在**，不碰 PermissionPolicy 的判定逻辑。
 * 「路径落在沙盒内」这件事仍由 PermissionPolicy.setScopeRoots + authorize 负责，
 * 这里只是把那个根目录准备好。两处职责不能混：混了就等于白名单自己判自己。
 */

const fs = require('fs');
const path = require('path');

/** 沙盒子目录名。放在桌面下，用户看得见、也便于自行清理。 */
const SANDBOX_DIR_NAME = 'LifeSandbox';

/**
 * 沙盒内的文件约定。会随路径一并展示给用户。
 * 措辞是「用户能据此行动」的规格，不是给实现者看的注释。
 */
const SANDBOX_NOTICE = '沙盒内文件一律视为可被 Agent 覆写，请勿放入重要文件。';

/**
 * 定位沙盒绝对路径（**不创建**，纯路径计算，可单测）。
 *
 * @param {string} desktopPath app.getPath('desktop')
 * @returns {string} 沙盒绝对路径
 */
function sandboxPathFor(desktopPath) {
  // 🔴 2026-10-06 审核修掉的真漏洞（变异测试反例3逼出来的）：
  //   原实现先 `String(desktopPath || '')` **再**查 typeof，
  //   于是 `sandboxPathFor(123)` 会把数字转成 '123' 拼进路径，
  //   `path.resolve('123')` 解析成 **当前工作目录**下的 '123'。
  //   实测曾产出 `<project-root>\123\LifeSandbox` ——
  //   也就是说「桌面路径异常」时会静默把工作目录当成沙盒根。
  //   （`[]` 因为空数组 falsy 被挡住，纯属侥幸。）
  //   正确顺序：**先查类型再取值**，非字符串一律拒。
  if (typeof desktopPath !== 'string' || !desktopPath.trim()) {
    throw new Error('DESKTOP_PATH_UNAVAILABLE');
  }
  return path.join(path.resolve(desktopPath.trim()), SANDBOX_DIR_NAME);
}

/**
 * 确保沙盒目录存在。创建失败**一律抛错，绝不静默继续**。
 *
 * 🔴 为什么不能静默失败：沙盒建不出来却继续往下走，最终要么写到别处
 * （写权限泄漏到桌面之外），要么每次执行都在同一个 mkdir 上报错 ——
 * 后者会让用户以为「Agent 坏了」，前者是真的越界。宁可当场拒。
 *
 * @param {string} dir 沙盒绝对路径
 * @param {object} [fsImpl] 注入用（测试）
 * @returns {string} dir
 */
function ensureSandboxDir(dir, fsImpl) {
  const f = fsImpl || fs;
  const target = String(dir || '');
  if (!target) throw new Error('SANDBOX_PATH_REQUIRED');
  try {
    f.mkdirSync(target, { recursive: true });
  } catch (err) {
    // 不吞异常：调用方需要知道「沙盒不可用」这个事实并拒绝执行。
    throw Object.assign(new Error('SANDBOX_UNAVAILABLE: ' + String((err && err.message) || '')), {
      code: 'SANDBOX_UNAVAILABLE',
    });
  }
  // 建完必须确认它真的是目录：mkdirSync 遇到同名**文件**时不会报错就返回。
  let st = null;
  try {
    st = f.statSync(target);
  } catch {
    throw Object.assign(new Error('SANDBOX_UNAVAILABLE: stat failed'), { code: 'SANDBOX_UNAVAILABLE' });
  }
  if (!st || !st.isDirectory()) {
    throw Object.assign(new Error('SANDBOX_UNAVAILABLE: not a directory'), { code: 'SANDBOX_UNAVAILABLE' });
  }
  return target;
}

module.exports = { SANDBOX_DIR_NAME, SANDBOX_NOTICE, sandboxPathFor, ensureSandboxDir };
