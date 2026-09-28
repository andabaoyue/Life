/**
 * test/research-integrity-p0-1-p0-2.test.js
 *
 * Life v0.9.7.1 Research Integrity P0 regression suite.
 *
 * 覆盖：
 * 1. Archive 自身结构完整、无独立证据时不得 CERTIFIED
 * 2. payload 自称 CERTIFIED 不能绕过独立证据门禁
 * 3. write-time SubjectState evidence attestation 可以支撑 CERTIFIED
 * 4. 外部 attestation 被篡改时必须降级
 * 5. 伪造 verifiedEvidence 无外部 attestation 时必须降级
 * 6. 新 Archive 首次写入创建 Genesis Anchor
 * 7. 删除头部 N 条必须被 Genesis Anchor 检出
 * 8. 篡改 Genesis Anchor 必须 INVALID
 * 9. 缺失 Genesis Anchor 必须 UNCERTIFIED
 * 10. appendWindowArchive 缺失 epistemicStatus 不得默认为 CERTIFIED
 *
 * 实际 check() 断言总数：17。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExperiencesArchive } = require('../src/experiences-archive');
const { ArchiveIntegrityService } = require('../src/archive-integrity');
const { SubjectState } = require('../src/subject-state');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function tmpDir(prefix = 'research-integrity-p0-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function sampleEvent(content = '我喜欢安静的环境。') {
  return {
    eventId: 'evt-000001',
    type: 'message',
    timestamp: 1700000000000,
    windowNo: 1,
    messageId: 'm-000001',
    source: 'user',
    payload: {
      content,
      roundNo: 1
    }
  };
}

function windowPayload(overrides = {}) {
  return {
    windowNo: 1,
    targetTurnCount: 100,
    actualTurnCount: 1,
    closeReason: 'turn_limit',
    turns: 1,
    messageCount: 1,
    events: [sampleEvent()],
    observations: [],
    interpretations: [],
    segments: [],
    windowSynthesis: {
      stableUserFacts: ['用户偏好安静环境']
    },
    stateEvidence: [],
    verifiedEvidence: [],
    rejectedEvidence: [],
    stateChanges: [],
    explanations: [],
    rawSummaryText: '用户偏好安静环境',
    structuredSummaryAvailable: true,
    ...overrides
  };
}

console.log('--- Test Suite: Research Integrity P0-1 / P0-2 (v0.9.7.1) ---');

// 1. 结构完整但没有独立事实证据
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.appendWindowArchive(windowPayload());
  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('结构完整但无独立证据不得 CERTIFIED', report.integrity === 'uncertified',
    'independent=' + report.independent_evidence_integrity);
  check('独立证据状态如实标记为 not_recorded',
    report.independent_evidence_integrity === 'not_recorded');
  cleanup(dir);
}

// 2. 自称 CERTIFIED 不能绕过独立证据门禁
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.appendWindowArchive(windowPayload({ epistemicStatus: 'CERTIFIED' }));
  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('Archive payload 自称 CERTIFIED 仍不得认证', report.integrity === 'uncertified');
  cleanup(dir);
}

// 3. write-time SubjectState attestation + matching archive evidence -> CERTIFIED
{
  const dir = tmpDir();
  const state = new SubjectState(dir);
  const msg = {
    messageId: 'm-000001',
    role: 'user',
    source: 'user',
    windowNo: 1,
    content: '我喜欢安静的环境。',
    roundNo: 1
  };
  const result = state.verifyEvidence([{
    evidenceId: 'ev-000001',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.8,
    messageId: msg.messageId,
    quote: '我喜欢安静的环境。'
  }], [msg], 1);
  state.attestMessages([msg], 1);
  state.flush();

  const evidence = result.verified[0];
  const archive = new ExperiencesArchive(dir);
  archive.appendWindowArchive(windowPayload({
    verifiedEvidence: [evidence],
    stateEvidence: [evidence]
  }));
  archive.updateProvenanceAttestations(
    state.data.messageAttestations,
    state.data.evidenceAttestations
  );

  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('匹配 write-time 独立证据后可 CERTIFIED', report.integrity === 'certified',
    'independent=' + report.independent_evidence_integrity);
  check('独立证据状态 verified', report.independent_evidence_integrity === 'verified');
  check('attestation 至少存在一条', report.evidenceAttestationCount >= 1);
  const provenancePath = archive.path + '.provenance.json';
  check('独立 provenance sidecar 已持久化', fs.existsSync(provenancePath));
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  check('provenance sidecar 同时保存 message/evidence attestations',
    provenance.messageAttestations.length >= 1 && provenance.evidenceAttestations.length >= 1);
  cleanup(dir);
}

// 4. 外部 attestation 被篡改
{
  const dir = tmpDir();
  const state = new SubjectState(dir);
  const msg = {
    messageId: 'm-000001',
    role: 'user',
    source: 'user',
    windowNo: 1,
    content: '我喜欢安静的环境。',
    roundNo: 1
  };
  const result = state.verifyEvidence([{
    evidenceId: 'ev-000001',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.8,
    messageId: msg.messageId,
    quote: '我喜欢安静的环境。'
  }], [msg], 1);
  state.attestMessages([msg], 1);
  state.flush();

  const evidence = result.verified[0];
  const statePath = path.join(dir, 'subject-state.json');
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  persisted.evidenceAttestations[0].fingerprint = 'forged-fingerprint';
  fs.writeFileSync(statePath, JSON.stringify(persisted), 'utf8');

  const archive = new ExperiencesArchive(dir);
  archive.appendWindowArchive(windowPayload({ verifiedEvidence: [evidence] }));
  archive.updateProvenanceAttestations(
    state.data.messageAttestations,
    state.data.evidenceAttestations
  );
  const provenancePath = archive.path + '.provenance.json';
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  provenance.evidenceAttestations[0].fingerprint = 'forged-fingerprint';
  fs.writeFileSync(provenancePath, JSON.stringify(provenance), 'utf8');
  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('attestation 被篡改时降级为 UNCERTIFIED', report.integrity === 'uncertified');
  check('给出 fingerprint mismatch 证据',
    report.independentEvidenceDefects.some(d => d.detail === 'INDEPENDENT_EVIDENCE_FINGERPRINT_MISMATCH'));
  cleanup(dir);
}

// 5. 伪造 verifiedEvidence 无独立 attestation
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  const forgedEvidence = {
    evidenceId: 'ev-forged',
    status: 'verified',
    fingerprint: 'm-000001:伪造内容:quiet_preference:1',
    trait: 'quiet_preference',
    direction: 1,
    strength: 0.9,
    messageId: 'm-000001',
    quote: '伪造内容',
    windowNo: 1
  };
  archive.appendWindowArchive(windowPayload({ verifiedEvidence: [forgedEvidence] }));
  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('伪造 verifiedEvidence 无外部 attestation 不得 CERTIFIED', report.integrity === 'uncertified');
  cleanup(dir);
}

// 6. 新 Archive 首次写入创建 Genesis Anchor
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.append({ recordType: 'diagnostic', windowNo: null, payload: { kind: 'genesis-probe' } });
  const anchorPath = archive.path + '.anchor.json';
  const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  check('首次写入创建 Genesis Anchor', Boolean(anchor.genesis));
  check('Genesis Anchor 固定 archiveSeq=1', anchor.genesis && anchor.genesis.archiveSeq === 1);
  cleanup(dir);
}

// 7. 删除头部 N 条
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.append({ recordType: 'diagnostic', windowNo: null, payload: { n: 1 } });
  archive.append({ recordType: 'diagnostic', windowNo: null, payload: { n: 2 } });
  archive.append({ recordType: 'diagnostic', windowNo: null, payload: { n: 3 } });

  const lines = fs.readFileSync(archive.path, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(archive.path, lines.slice(1).join('\n') + '\n', 'utf8');

  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('删除头部 1 条被 Genesis Anchor 检出', report.genesis_anchor === 'tampered');
  check('删头后 Archive 为 INVALID', report.integrity === 'invalid');
  cleanup(dir);
}

// 8. 篡改 Genesis Anchor
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.append({ recordType: 'diagnostic', windowNo: null, payload: { probe: true } });
  const anchorPath = archive.path + '.anchor.json';
  const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  anchor.genesis.recordHash = '0'.repeat(64);
  fs.writeFileSync(anchorPath, JSON.stringify(anchor), 'utf8');

  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('篡改 Genesis Anchor 被检出', report.genesis_anchor === 'tampered');
  check('Genesis Anchor 篡改导致 INVALID', report.integrity === 'invalid');
  cleanup(dir);
}

// 9. 缺失 Genesis Anchor
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.append({ recordType: 'diagnostic', windowNo: null, payload: { probe: true } });
  const anchorPath = archive.path + '.anchor.json';
  const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  delete anchor.genesis;
  fs.writeFileSync(anchorPath, JSON.stringify(anchor), 'utf8');

  const report = ArchiveIntegrityService.checkArchive(archive.path);
  check('缺失 Genesis Anchor 不得 CERTIFIED', report.genesis_anchor === 'invalid' ? false : report.integrity === 'uncertified');
  cleanup(dir);
}

// 10. appendWindowArchive 不再默认 CERTIFIED
{
  const dir = tmpDir();
  const archive = new ExperiencesArchive(dir);
  archive.appendWindowArchive(windowPayload());
  const rec = JSON.parse(fs.readFileSync(archive.path, 'utf8').trim());
  check('缺失 epistemicStatus 默认 UNKNOWN', rec.payload.epistemicStatus === 'UNKNOWN');
  cleanup(dir);
}

process.exitCode = failures ? 1 : 0;
