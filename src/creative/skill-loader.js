/**
 * src/creative/skill-loader.js — Skill Loader 最小接口（v0.9.9 Phase 2）
 *
 * 仅做一件事：从限定基目录读取一份创作技能 Markdown。
 * 路径安全：文件名受限字符集（含中文），结构上不可能包含路径分隔符 / ../ / 绝对路径 / 控制字符。
 * 不实现技能市场、热加载、版本管理 —— 那些不属于本轮。
 */

const fs = require('fs');
const path = require('path');

const SKILL_NAME_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,64}\.md$/;

function loadCreativeSkill(skillName, { baseDir } = {}) {
  const name = String(skillName == null ? '' : skillName);
  if (!SKILL_NAME_PATTERN.test(name)) {
    const err = new Error('CREATIVE_SKILL_NAME_INVALID');
    err.code = 'CREATIVE_SKILL_NAME_INVALID';
    throw err;
  }
  const root = path.resolve(String(baseDir == null ? '' : baseDir));
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) {
    const err = new Error('CREATIVE_SKILL_NAME_INVALID');
    err.code = 'CREATIVE_SKILL_NAME_INVALID';
    throw err;
  }
  if (!fs.existsSync(target)) return null;
  return { name, text: fs.readFileSync(target, 'utf8') };
}

module.exports = { loadCreativeSkill, SKILL_NAME_PATTERN };
