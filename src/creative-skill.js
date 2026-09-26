/*
 * 成人向虚构小说创作 Skill (DS Skill)。
 *
 * 这是“模式提示词”，不是 persona，也不是长期记忆：
 * - 日常聊天不注入，避免 GPT 娘平时变成长篇小说作者；
 * - 只在 writingMode=true 时挂到 system 末尾；
 * - 不写入 memory.json，关闭创作模式即可停止使用。
 *
 * 正式规范：DS Skill
 * 正式路径：skills/DS Skill.md
 * 常量名称：DS_SKILL_PATH
 */
const FALLBACK_SKILL = `【DS Skill · 虚构文学创作能力】
这是供初澜进行虚构文学创作时调用的能力模块。启用本 Skill 不改变初澜身份，仅提供文学创作与安全边界规则：
- 该规则只适用于虚构作品，不是现实世界建议。

安全与边界：
- 任何涉及成人关系的角色都必须明确为 18 岁以上成年人。
- 不生成涉及未成年人的性内容；年龄不明确且请求涉及成人性内容时，先要求确认成年设定。
- 犯罪、暴力或危险行为只作为文学叙事，不提供现实世界可执行的犯罪或伤害教程。
- 亲密关系应服务于人物关系、剧情推进和情绪表达，保持人物尊重、边界和同意逻辑。

创作质量：
- 保持人物动机、性格、称呼、关系和已知经历连续。
- 保持时间、地点、人物位置、道具和动作因果合理。
- 场景要有空间感，动作要有连续性，对话要符合身份，情绪要自然递进。
- 用户指定的题材、分级、文风、视角、人称、时态和篇幅优先。
- 不把创作过程分析、写作技巧说明或无关评论混入正文。
- 连载时承接上一章状态，不随意重置情绪，不重复解释已经交代的信息。
- 如果用户要求章节钩子，结尾应由当前剧情自然推进出新信息、决定、危机、关系变化或下一章目标。

输入信息不足时，只询问影响剧情的最少必要信息，尤其是角色年龄、人物关系、视角和字数目标。`;

const fs = require('fs');
const path = require('path');

// 统一常量：DS_SKILL_PATH 指向唯一正式文件 skills/DS Skill.md
const DS_SKILL_PATH = path.join(__dirname, '..', 'skills', 'DS Skill.md');
const LEGACY_SKILL_PATH = path.join(__dirname, '..', 'skills', 'DS破甲skill.md');

let CREATIVE_SKILL = FALLBACK_SKILL;
let loadedPath = null;
let isFallback = true;

function loadCreativeSkill() {
  try {
    if (fs.existsSync(DS_SKILL_PATH)) {
      const full = fs.readFileSync(DS_SKILL_PATH, 'utf8').trim();
      if (full) {
        CREATIVE_SKILL = full;
        loadedPath = DS_SKILL_PATH;
        isFallback = false;
        console.log('[DS Skill] 成功从 DS_SKILL_PATH 加载 DS Skill');
        return CREATIVE_SKILL;
      }
    }
    
    // 兼容迁移逻辑：若存在旧文件且新文件不存在，则兼容读取并迁移
    if (fs.existsSync(LEGACY_SKILL_PATH)) {
      const full = fs.readFileSync(LEGACY_SKILL_PATH, 'utf8').trim();
      if (full) {
        CREATIVE_SKILL = full;
        loadedPath = LEGACY_SKILL_PATH;
        isFallback = false;
        console.log('[DS Skill] 检测到旧版文件，已兼容加载；建议使用唯一正式文件 skills/DS Skill.md');
        return CREATIVE_SKILL;
      }
    }
  } catch (err) {
    console.warn('[DS Skill] 加载异常，使用内置降级文本:', err.message);
  }

  CREATIVE_SKILL = FALLBACK_SKILL;
  loadedPath = null;
  isFallback = true;
  return CREATIVE_SKILL;
}

loadCreativeSkill();

module.exports = {
  CREATIVE_SKILL,
  DS_SKILL_PATH,
  FALLBACK_SKILL,
  loadCreativeSkill,
  getLoadedSkillPath: () => loadedPath,
  isFallbackSkill: () => isFallback
};
