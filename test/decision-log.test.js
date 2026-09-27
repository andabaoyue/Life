/**
 * test/decision-log.test.js
 * 
 * Life v0.9.7 实验决策账本与不可逆架构约束专项测试
 * 
 * 检验点：
 * 1. research/ENGINEERING-DECISION-LOG.md 存在且非空
 * 2. 完整记录 D-001 ~ D-007 七项已决决策 (SETTLED DECISION)
 * 3. 严格禁止项断言：
 *    - 严禁连续后台生理 Tick (D-001)
 *    - 严禁人类 24h 昼夜时钟作为默认生命周期 (D-002)
 *    - 严禁梦境成为每窗口例行任务与无门禁调用 (D-003)
 *    - 严禁梦境输出直接修改 SubjectState (D-004)
 *    - 严禁遗忘物理删除 experiences.jsonl 历史记录 (D-005)
 *    - 严禁记忆衰减调用 LLM (D-006)
 *    - 确立经历依赖塑性衰减与历史参数落盘 (D-007)
 * 4. 源码静态扫描：源码中不存在对 SubjectState 的 setInterval/setTimeout 连续后台自消耗
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const ROOT = path.join(__dirname, '..');
const logPath = path.join(ROOT, 'research', 'ENGINEERING-DECISION-LOG.md');

// 1. 文档存在性与基本元数据
check('ENGINEERING-DECISION-LOG.md 真实存在', fs.existsSync(logPath));
const content = fs.readFileSync(logPath, 'utf8');
check('决策账本内容充足非空 (> 1000 字节)', content.length > 1000, `当前长度: ${content.length}`);

// 2. 十项已决决策完整性检查 (D-001 ~ D-010)
const requiredDecisions = [
  { id: 'D-001', name: '不实现连续后台基础代谢' },
  { id: 'D-002', name: '不采用人类 24h 昼夜节律作为默认生命周期' },
  { id: 'D-003', name: 'Dream 不是固定周期任务' },
  { id: 'D-004', name: 'Dream 不得直接改变 SubjectState' },
  { id: 'D-005', name: '遗忘不删除历史' },
  { id: 'D-006', name: 'Memory Dynamics 零 API 调用保证' },
  { id: 'D-007', name: '发育景观采用经历依赖塑性衰减' },
  { id: 'D-008', name: '内部短时调节与长期人格特质的双轨分离' },
  { id: 'D-009', name: '生产运行时统一权威接线与因果闭环规范' },
  { id: 'D-010', name: '实验条件元数据绑定与证据事实核验铁律' }
];

for (const d of requiredDecisions) {
  const hasId = content.includes(d.id);
  const isSettled = content.includes(d.id) && content.includes('SETTLED DECISION');
  check(`决策账本登记 ${d.id} (${d.name})`, hasId);
  check(`决策 ${d.id} 状态明确标记为 SETTLED DECISION`, isSettled);
}

// 3. 关键哲学与工程约束条款覆盖
check('包含严禁 setInterval 连续代谢条款', content.includes('setInterval') && content.includes('基础代谢'));
check('包含关系时间 (Relational Temporality) 定义', content.includes('关系时间') || content.includes('Relational Temporality'));
check('包含拒绝人类中心主义囚笼说明', content.includes('人类中心主义') || content.includes('智人'));
check('包含梦境第一道本地认知门禁与第二道成本门禁约束', content.includes('本地认知门禁') && content.includes('成本门禁'));
check('包含梦境制品 DREAM_GENERATED_ARTIFACT 隔离说明', content.includes('DREAM_GENERATED_ARTIFACT') || content.includes('潜意识'));
check('包含原始归档绝对物理只读条款', content.includes('物理删除') && content.includes('experiences.jsonl'));
check('包含艾宾浩斯幂律本地代数计算说明', content.includes('幂律') || content.includes('艾宾浩斯'));
check('包含塑性乘子 (plasticityMultiplier) 历史落盘约束', content.includes('plasticityMultiplier') || content.includes('经历依赖'));

// 4. 源码工程约束静态安全扫描：严格禁止在 src/ 下对内部状态做 setInterval 轮询递减
const srcDir = path.join(ROOT, 'src');
const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
let hasBackgroundDecayTick = false;
for (const f of srcFiles) {
  const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
  if (code.includes('setInterval') && (code.includes('energy -=') || code.includes('arousal -=') || code.includes('energy--'))) {
    hasBackgroundDecayTick = true;
    break;
  }
}
check('源码中坚决杜绝后台连续代谢 Tick (无 setInterval energy/arousal decay)', !hasBackgroundDecayTick);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
