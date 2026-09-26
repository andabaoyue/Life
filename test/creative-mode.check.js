const assert = require('assert');
const fs = require('fs');
const { CREATIVE_SKILL, DS_SKILL_PATH, getLoadedSkillPath, isFallbackSkill } = require('../src/creative-skill');
const { sanitize } = require('../src/config');

function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '  ' + e.message); process.exitCode = 1; }
}

check('DS_SKILL_PATH 指向 skills/DS Skill.md 且物理存在', () => {
  assert(DS_SKILL_PATH.endsWith('DS Skill.md'));
  assert(fs.existsSync(DS_SKILL_PATH), 'skills/DS Skill.md 必须在磁盘上物理存在');
});

check('成功载入 DS Skill 且非 fallback 降级', () => {
  assert.strictEqual(getLoadedSkillPath(), DS_SKILL_PATH);
  assert.strictEqual(isFallbackSkill(), false);
  assert(CREATIVE_SKILL.includes('DS Skill'), '内容必须包含 DS Skill 标题');
});

check('Skill 包含成人向虚构小说规范', () => assert(CREATIVE_SKILL.includes('成人向虚构小说创作规范')));
check('Skill 包含成年角色边界', () => assert(CREATIVE_SKILL.includes('18 岁以上')));
check('writingMode 严格接受 true', () => assert.strictEqual(sanitize({ writingMode: true }).writingMode, true));
check('writingMode 拒绝字符串 true', () => assert.strictEqual(sanitize({ writingMode: 'true' }).writingMode, false));
check('非法请求超时回退默认值', () => assert.strictEqual(sanitize({ requestTimeoutMs: -1 }).requestTimeoutMs, 60000));

if (!process.exitCode) console.log('creative-mode integration check passed');
