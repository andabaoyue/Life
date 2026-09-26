/**
 * src/experiment-types.js
 * 
 * 《生物科学与数字生命的哲学范畴》
 * 实验层核心常量、枚举与 Schema 版本化规范契约 (Phase 0)
 */

'use strict';

const SCHEMA_VERSION = 1;
const EXPERIMENT_CONFIG_VERSION = 1;
const RESEARCH_FORMAT_VERSION = 1;
const MIGRATION_VERSION = 1;

/**
 * 实验运行模式枚举
 */
const EXPERIMENT_MODES = Object.freeze({
  BASELINE: 'baseline',         // 基线对照组：所有实验模块强制关闭，严格等价于 v0.9.5.3 原生状态
  EXPERIMENTAL: 'experimental', // 实验组：按配置启用生命动力学机制
  ABLATION: 'ablation'          // 消融组：针对性关闭特定单一模块进行因果检验
});

/**
 * 严格归因溯源类型（涵盖人工干预在内的 6 大来源）
 */
const PROVENANCE_SOURCE_KINDS = Object.freeze({
  AUTONOMOUS_SYSTEM: 'AUTONOMOUS_SYSTEM',   // 运行时自动化确定性算法触发（如定时清空、衰减等）
  MODEL_DERIVED: 'MODEL_DERIVED',           // 大语言模型推理生成的文本或建议结构
  SUBJECT_DERIVED: 'SUBJECT_DERIVED',       // 经核验证明由初澜主体自主引用的认知
  HUMAN_INTERVENTION: 'HUMAN_INTERVENTION', // 开发者、研究员在调试或维护时的人工干预
  MIGRATION: 'MIGRATION',                   // 跨版本升级执行的数据结构迁移
  RECOVERY: 'RECOVERY'                      // 故障自愈（Replay / 一致性自检）生成的恢复记录
});

/**
 * 语义分层枚举：系统指标与主体代理状态严格隔离
 */
const SEMANTIC_LAYERS = Object.freeze({
  SYSTEM_METRICS: 'SYSTEM_METRICS',               // 纯技术指标（CPU、FPS、IPC 延迟、待写盘队列等）
  SUBJECT_STATE_PROXY: 'SUBJECT_STATE_PROXY'      // 主体内部状态代理变量（能量、激活度、负荷代理等）
});

/**
 * 自传印痕候选状态机枚举（防循环证明）
 */
const CANDIDATE_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED',                     // 初始提出：仅基于单次事件初筛
  REINFORCED: 'REINFORCED',                 // 语境强化：经历时间间隔并在后续独立语境中重现
  CITED_BY_SUBJECT: 'CITED_BY_SUBJECT',     // 主体自主采纳：由主体在后续自发回溯并用于自我解释
  CRYSTALLIZED: 'CRYSTALLIZED',             // 固化结晶：多轮验证形成稳定的自传连续性，不可逆落盘
  DISCARDED: 'DISCARDED'                    // 废弃：未能在窗口演进中获得真实强化
});

/**
 * 行为起源分类：区分系统诱导行为与主体自主生成行为
 */
const BEHAVIOR_ORIGIN = Object.freeze({
  SYSTEM_INDUCED: 'SYSTEM_INDUCED',         // 由系统算法或提示词诱发（不能作为 Defining Moment 的直接证词）
  SUBJECT_GENERATED: 'SUBJECT_GENERATED'   // 主体在对话交互中自发回溯生成
});

/**
 * 睡眠记忆认识论三态分立
 */
const MEMORY_EPISTEMIC_STATUS = Object.freeze({
  SLEEP_REPLAY_ARTIFACT: 'SLEEP_REPLAY_ARTIFACT',           // 系统睡眠回放中间制品（机器运算物，非主体梦境）
  SYSTEM_CONSOLIDATED: 'SYSTEM_CONSOLIDATED',               // 系统整合候选表征（暂存外部缓冲，未获主体确认）
  SUBJECT_ACQUIRED: 'SUBJECT_ACQUIRED'                     // 主体习得自传记忆（清醒期经由主体主动唤醒并融入对话）
});

/**
 * 默认实验特性模块开关
 */
const DEFAULT_EXPERIMENT_MODULES = Object.freeze({
  homeostasis: false,
  sleepConsolidation: false,
  digitalUmwelt: false,
  biographicalCanalization: false
});

module.exports = {
  SCHEMA_VERSION,
  EXPERIMENT_CONFIG_VERSION,
  RESEARCH_FORMAT_VERSION,
  MIGRATION_VERSION,
  EXPERIMENT_MODES,
  PROVENANCE_SOURCE_KINDS,
  SEMANTIC_LAYERS,
  CANDIDATE_STATUS,
  BEHAVIOR_ORIGIN,
  MEMORY_EPISTEMIC_STATUS,
  DEFAULT_EXPERIMENT_MODULES
};
