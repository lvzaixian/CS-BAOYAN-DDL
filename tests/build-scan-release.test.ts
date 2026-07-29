import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  PublicOpportunity,
  PublicSnapshot,
} from '../src/lib/snapshot-types.js';
import type {
  ProjectObservation,
  ScanBundle,
} from '../scripts/snapshot/scan-release-contract.js';
import {
  assertBundleCoverage,
  buildCandidateFromReduction,
  buildScanReleaseArtifacts,
  countPendingProjectionMismatch,
  parsePrioritySentinels,
  verifyScanReleaseReplay,
} from '../scripts/snapshot/build-scan-release.js';
import {
  buildNextPendingLedger,
} from '../scripts/snapshot/pending-ledger.js';
import type {
  PendingLedger,
  PendingLedgerEntry,
} from '../scripts/snapshot/pending-ledger.js';
import {
  approveCandidate,
} from '../scripts/snapshot/approve-snapshot.js';
import type {
  ScanReduction,
} from '../scripts/snapshot/scan-release-reducer.js';

const HASH = 'a'.repeat(64);
const SCAN_AT = '2026-07-29T01:00:00.000Z';

function opportunity(
  projectId: string,
  verificationStatus: PublicOpportunity['verificationStatus'],
): PublicOpportunity {
  const [, name, institute, project] = projectId.split('|');
  const deadline =
    verificationStatus === 'expired'
      ? '2026-07-01T15:59:59.000Z'
      : '2026-08-03T15:59:59.000Z';
  return {
    projectId,
    feedId: 'camp2027',
    name,
    institute,
    project,
    eventType: '预推免',
    description: project,
    verificationStatus,
    deadline,
    deadlineOriginal: '官网时间',
    deadlineEpochMs: Date.parse(deadline),
    website: `https://${institute === '计算机学院' ? 'cs' : 'se'}.example.edu/2027`,
    tags: [],
    verifiedAt: '2026-07-28T01:00:00.000Z',
    discoverySources: [
      {
        kind: 'official',
        label: '官方链接',
        url: `https://${institute === '计算机学院' ? 'cs' : 'se'}.example.edu/2027`,
      },
    ],
    logistics: { status: 'not-published', summary: '未公布' },
    recommendation: { status: 'not-published', summary: '未公布' },
    materials: { status: 'not-published', summary: '未公布' },
    eventArrangement: {
      mode: 'unknown',
      time: { status: 'not-published', summary: '未公布' },
      formatLocation: { status: 'not-published', summary: '未公布' },
    },
  };
}

function parent(opportunities: PublicOpportunity[]): PublicSnapshot {
  return {
    schemaVersion: 2,
    scanAt: '2026-07-28T00:00:00.000Z',
    defaultFeedId: 'camp2027',
    feeds: [
      {
        id: 'camp2027',
        label: '推免活动 2027',
        admissionCycle: '2027',
        eventYear: 2026,
      },
    ],
    counts: {
      confirmedOpen: opportunities.filter(
        (item) => item.verificationStatus === 'confirmed-open',
      ).length,
      confirmedUnknownDeadline: 0,
      pendingExcluded: 0,
      expired: opportunities.filter(
        (item) => item.verificationStatus === 'expired',
      ).length,
    },
    opportunities,
    snapshotId: 'snapshot-parent',
    approvedAt: '2026-07-28T01:00:00.000Z',
    previousSnapshotId: null,
    dataHash: HASH,
  };
}

function baseBundle(): ScanBundle {
  return {
    schemaVersion: 2,
    runId: '20260729-projector-test',
    scanMode: 'incremental',
    scanStartedAt: '2026-07-29T00:00:00.000Z',
    scanFinishedAt: SCAN_AT,
    candidateBase: {
      type: 'public-approved-snapshot',
      url: 'https://ddl.meta-mind.cn/data/current.json',
      sha256: HASH,
      snapshotId: 'snapshot-parent',
      dataHash: HASH,
      privateParentCandidateUsed: false,
    },
    registry: { sha256: HASH, institutionCount: 310 },
    pendingLedger: { generation: 1, sha256: HASH },
    errors: [],
    warnings: [],
    discoverySourceChecks: [],
    scopeItems: [],
    evidenceRecords: [],
    projectObservations: [],
    pendingUpdates: [],
    exclusions: [],
  };
}

function reduction(
  overrides: Partial<ScanReduction> = {},
): ScanReduction {
  return {
    evidenceDispositions: [],
    lifecycle: [],
    normalizedObservations: [],
    pending: [],
    hardErrors: [],
    metrics: {
      evidenceRecords: 0,
      disposedEvidence: 0,
      parentActive: 0,
      carriedParentActive: 0,
      unaccountedParentActive: 0,
      unaccountedPendingScopes: 0,
      pending: 0,
    },
    ...overrides,
  };
}

test('candidate projection preserves carried active and historical expired rows byte-for-byte', () => {
  const active = opportunity(
    '2027|测试大学|计算机学院|推免预报名',
    'confirmed-open',
  );
  const expired = opportunity(
    '2027|测试大学|软件学院|夏令营',
    'expired',
  );
  const previous = parent([active, expired]);
  const result = reduction({
    lifecycle: [
      {
        sourceProjectId: active.projectId,
        canonicalProjectId: active.projectId,
        state: 'carried-active',
        reason: 'incremental carry',
        evidenceIds: [],
        verifiedAt: active.verifiedAt,
      },
      {
        sourceProjectId: expired.projectId,
        canonicalProjectId: expired.projectId,
        state: 'expired',
        reason: 'preserved parent expired project',
        evidenceIds: [],
        verifiedAt: expired.verifiedAt,
      },
    ],
  });

  const candidate = buildCandidateFromReduction(baseBundle(), previous, result);
  assert.deepEqual(candidate.opportunities, [active, expired]);
  assert.equal(candidate.scanAt, SCAN_AT);
  assert.deepEqual(candidate.counts, {
    confirmedOpen: 1,
    confirmedUnknownDeadline: 0,
    pendingExcluded: 0,
    expired: 1,
  });
});

test('candidate projection expires an existing project after an official closure', () => {
  const active = opportunity(
    '2027|测试大学|计算机学院|推免预报名',
    'confirmed-open',
  );
  const closed = opportunity(
    '2027|测试大学|软件学院|科学营',
    'confirmed-open',
  );
  const result = reduction({
    lifecycle: [
      {
        sourceProjectId: active.projectId,
        canonicalProjectId: active.projectId,
        state: 'carried-active',
        reason: 'incremental carry',
        evidenceIds: [],
        verifiedAt: active.verifiedAt,
      },
      {
        sourceProjectId: closed.projectId,
        canonicalProjectId: closed.projectId,
        state: 'official-closed',
        reason: 'official event has ended',
        evidenceIds: ['closed-evidence'],
        verifiedAt: SCAN_AT,
      },
    ],
  });

  const candidate = buildCandidateFromReduction(
    baseBundle(),
    parent([active, closed]),
    result,
  );

  assert.deepEqual(
    candidate.opportunities.map(({ projectId, verificationStatus }) => ({
      projectId,
      verificationStatus,
    })),
    [
      {
        projectId: active.projectId,
        verificationStatus: 'confirmed-open',
      },
      {
        projectId: closed.projectId,
        verificationStatus: 'expired',
      },
    ],
  );
});

test('candidate projection maps verified observations and counts private pending identities', () => {
  const observation: ProjectObservation = {
    observationId: 'obs-bupt',
    sourceProjectId: '2027|北京邮电大学|研究生院|推免预报名',
    cycle: '2027',
    school: '北京邮电大学',
    project: '2027 推免预报名',
    eventType: '预推免',
    registrationState: 'open',
    deadline: null,
    deadlineOriginal: '报名系统未公布截止时间',
    eventMode: 'unknown',
    eventTime: '待公布',
    formatLocation: '待公布',
    accommodation: '未公布',
    meals: '未公布',
    transport: '未公布',
    reimbursement: '未公布',
    recommendationLetters: '未公布',
    recommendationTemplate: '未公布',
    materialComplexity: 'unknown',
    materialList: '未公布',
    officialUrl: 'https://yzfs.bupt.edu.cn/MasterTm/ApplyBmxz.aspx',
    evidenceIds: ['bupt-system'],
  };
  const result = reduction({
    lifecycle: [
      {
        sourceProjectId: observation.sourceProjectId,
        canonicalProjectId: observation.sourceProjectId,
        state: 'confirmed-unknown-deadline',
        reason: 'official application system',
        evidenceIds: ['bupt-system'],
        verifiedAt: '2026-07-29T00:30:00.000Z',
      },
    ],
    normalizedObservations: [
      {
        canonicalProjectId: observation.sourceProjectId,
        state: 'confirmed-unknown-deadline',
        verifiedAt: '2026-07-29T00:30:00.000Z',
        observation,
      },
    ],
    pending: [
      {
        ledgerId: 'scope:bupt-cs',
        scopeItemId: 'bupt-cs',
        school: '北京邮电大学',
        targetId: 'bupt-cs',
        reason: 'official scope blocked',
        evidenceIds: ['bupt-cs-blocked'],
        checkedAt: '2026-07-29T00:40:00.000Z',
      },
    ],
    metrics: {
      evidenceRecords: 2,
      disposedEvidence: 2,
      parentActive: 0,
      carriedParentActive: 0,
      unaccountedParentActive: 0,
      unaccountedPendingScopes: 0,
      pending: 1,
    },
  });

  const candidate = buildCandidateFromReduction(baseBundle(), null, result);
  assert.equal(candidate.opportunities.length, 1);
  assert.equal(
    candidate.opportunities[0].projectId,
    '2027|北京邮电大学|研究生院|推免预报名',
  );
  assert.equal(
    candidate.opportunities[0].verificationStatus,
    'confirmed-unknown-deadline',
  );
  assert.equal(candidate.opportunities[0].verifiedAt, '2026-07-29T00:30:00.000Z');
  assert.equal(candidate.counts.pendingExcluded, 1);
});

test('candidate projection fails closed on reducer hard errors', () => {
  const result = reduction({
    hardErrors: [
      {
        code: 'UNACCOUNTED_PARENT_ACTIVE',
        message: 'missing transition',
        evidenceIds: [],
      },
    ],
  });
  assert.throws(
    () => buildCandidateFromReduction(baseBundle(), null, result),
    /cannot project a scan reduction with hard errors/,
  );
});

test('full coverage requires every registry institution and priority sentinel', () => {
  const sentinels = parsePrioritySentinels({
    schemaVersion: 1,
    cycle: '2027',
    institutions: [
      {
        school: '北京邮电大学',
        minimumEvidenceRecords: 1,
        requiredOfficialKinds: ['application-system'],
      },
    ],
  });
  const input: ScanBundle = {
    ...baseBundle(),
    scanMode: 'full',
    scopeItems: [
      {
        scopeItemId: 'registry-a',
        kind: 'registry',
        school: '测试大学',
        targetId: '测试大学',
        status: 'no-current-notice',
        evidenceIds: ['test-surface'],
      },
      {
        scopeItemId: 'sentinel-bupt',
        kind: 'sentinel',
        school: '北京邮电大学',
        targetId: '北京邮电大学',
        status: 'checked',
        evidenceIds: ['bupt-system'],
      },
    ],
    evidenceRecords: [
      {
        evidenceId: 'test-surface',
        scopeItemId: 'registry-a',
        school: '测试大学',
        region: '华北',
        kind: 'graduate-admissions',
        url: 'https://grad.example.edu/admissions',
        result: 'no-current-notice',
        checkedAt: '2026-07-29T00:30:00.000Z',
        artifactSha256: 'b'.repeat(64),
        query: '测试大学 2027 推免',
        discoveredScopeItemIds: [],
      },
      {
        evidenceId: 'bupt-system',
        scopeItemId: 'sentinel-bupt',
        school: '北京邮电大学',
        region: '华北',
        kind: 'application-system',
        url: 'https://yzfs.bupt.edu.cn/MasterTm/ApplyBmxz.aspx',
        result: 'hit',
        checkedAt: '2026-07-29T00:30:00.000Z',
        artifactSha256: 'c'.repeat(64),
        query: '北京邮电大学 2027 推免',
        discoveredScopeItemIds: [],
      },
    ],
  };

  assert.doesNotThrow(() =>
    assertBundleCoverage(
      input,
      [{ name: '测试大学' }],
      sentinels,
    ),
  );
  assert.throws(
    () =>
      assertBundleCoverage(
        input,
        [
          { name: '测试大学' },
          { name: '遗漏大学' },
        ],
        sentinels,
      ),
    /full scan is missing registry institution 遗漏大学/,
  );
});

test('full coverage rejects nominal registry and sentinel scopes', () => {
  const sentinels = parsePrioritySentinels({
    schemaVersion: 1,
    cycle: '2027',
    institutions: [
      {
        school: '北京邮电大学',
        minimumEvidenceRecords: 1,
        requiredOfficialKinds: ['application-system'],
      },
    ],
  });
  const nominalRegistry: ScanBundle = {
    ...baseBundle(),
    scanMode: 'full',
    scopeItems: [
      {
        scopeItemId: 'registry-empty',
        kind: 'registry',
        school: '测试大学',
        targetId: '测试大学',
        status: 'not-applicable',
        reason: 'placeholder',
        evidenceIds: [],
      },
      {
        scopeItemId: 'sentinel-bupt',
        kind: 'sentinel',
        school: '北京邮电大学',
        targetId: '北京邮电大学',
        status: 'checked',
        evidenceIds: ['bupt-system'],
      },
    ],
    evidenceRecords: [
      {
        evidenceId: 'bupt-system',
        scopeItemId: 'sentinel-bupt',
        school: '北京邮电大学',
        region: '华北',
        kind: 'application-system',
        url: 'https://yzfs.bupt.edu.cn/MasterTm/ApplyBmxz.aspx',
        result: 'hit',
        checkedAt: '2026-07-29T00:30:00.000Z',
        artifactSha256: 'c'.repeat(64),
        query: '北京邮电大学 2027 推免',
        discoveredScopeItemIds: [],
      },
    ],
  };

  assert.throws(
    () => assertBundleCoverage(nominalRegistry, [{ name: '测试大学' }], sentinels),
    /full registry scope 测试大学 must have current-run official evidence/,
  );

  const emptySentinel: ScanBundle = {
    ...nominalRegistry,
    scopeItems: nominalRegistry.scopeItems.map((item) =>
      item.scopeItemId === 'registry-empty'
        ? {
            ...item,
            status: 'no-current-notice' as const,
            evidenceIds: ['registry-evidence'],
          }
        : { ...item, evidenceIds: [] }),
    evidenceRecords: [
      {
        evidenceId: 'registry-evidence',
        scopeItemId: 'registry-empty',
        school: '测试大学',
        region: '华北',
        kind: 'graduate-admissions',
        url: 'https://grad.example.edu/admissions',
        result: 'no-current-notice',
        checkedAt: '2026-07-29T00:30:00.000Z',
        artifactSha256: 'b'.repeat(64),
        query: '测试大学 2027 推免',
        discoveredScopeItemIds: [],
      },
    ],
  };
  assert.throws(
    () => assertBundleCoverage(emptySentinel, [{ name: '测试大学' }], sentinels),
    /priority sentinel 北京邮电大学 must have current-run official evidence/,
  );
});

test('incremental coverage requires every configured priority sentinel', () => {
  const sentinels = parsePrioritySentinels({
    schemaVersion: 1,
    cycle: '2027',
    institutions: [
      {
        school: '北京邮电大学',
        minimumEvidenceRecords: 1,
        requiredOfficialKinds: ['application-system'],
      },
      {
        school: '南方科技大学',
        minimumEvidenceRecords: 1,
        requiredOfficialKinds: ['college-notice'],
      },
    ],
  });
  const input = {
    ...baseBundle(),
    scopeItems: [
      {
        scopeItemId: 'sentinel-bupt',
        kind: 'sentinel' as const,
        school: '北京邮电大学',
        targetId: '北京邮电大学',
        status: 'checked' as const,
        evidenceIds: ['bupt-system'],
      },
    ],
    evidenceRecords: [
      {
        evidenceId: 'bupt-system',
        scopeItemId: 'sentinel-bupt',
        school: '北京邮电大学',
        region: '华北',
        kind: 'application-system' as const,
        url: 'https://yzfs.bupt.edu.cn/MasterTm/ApplyBmxz.aspx',
        result: 'hit' as const,
        checkedAt: '2026-07-29T00:30:00.000Z',
        artifactSha256: 'c'.repeat(64),
        query: '北京邮电大学 2027 推免',
        discoveredScopeItemIds: [],
      },
    ],
  };
  assert.throws(
    () => assertBundleCoverage(input, [], sentinels),
    /scan is missing priority sentinel 南方科技大学/,
  );
});

function emptyPendingLedger(): PendingLedger {
  const payload = {
    schemaVersion: 1 as const,
    current: {
      generation: 0,
      previousSha256: null,
      entries: [],
    },
    history: [],
  };
  const sha256 = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  return {
    schemaVersion: 1,
    current: {
      generation: 0,
      sha256,
      previousSha256: null,
      entries: [],
    },
    history: [],
  };
}

function emptyArtifactManifest(runId = baseBundle().runId) {
  return {
    schemaVersion: 1 as const,
    runId,
    artifacts: [],
  };
}

function emptySubmittedRegistry() {
  return {
    schemaVersion: 1 as const,
    source: 'test fixture',
    submittedProjectIds: [],
  };
}

test('buildScanReleaseArtifacts binds candidate, pending projection, diff and gate', () => {
  const active = opportunity(
    '2027|测试大学|计算机学院|推免预报名',
    'confirmed-open',
  );
  const previous = parent([active]);
  const pending = emptyPendingLedger();
  const input: ScanBundle = {
    ...baseBundle(),
    candidateBase: {
      ...baseBundle().candidateBase,
      snapshotId: previous.snapshotId,
      dataHash: previous.dataHash,
    },
    pendingLedger: {
      generation: pending.current.generation,
      sha256: pending.current.sha256,
    },
  };
  const artifacts = buildScanReleaseArtifacts({
    bundle: input,
    parent: previous,
    registryInstitutions: [],
    sentinels: {
      schemaVersion: 1,
      cycle: '2027',
      institutions: [],
    },
    identityRegistry: {
      schemaVersion: 2,
      urlAliases: [],
      projectAliases: [],
      tombstones: [],
    },
    submittedRegistry: emptySubmittedRegistry(),
    pendingLedger: pending,
    artifactManifest: emptyArtifactManifest(input.runId),
    removalReviews: [],
  });

  assert.equal(artifacts.gate.status, 'ready');
  assert.deepEqual(artifacts.diff, {
    added: [],
    changed: [],
    expired: [],
    removed: [],
  });
  assert.equal(artifacts.pendingNext.current.generation, 1);
  assert.equal(artifacts.candidate.counts.pendingExcluded, 0);
  assert.equal(artifacts.gate.zeroLossMetrics.pendingProjectionMismatch, 0);
  assert.equal(artifacts.audit.runStatus, 'ready');
});

test('buildScanReleaseArtifacts persists canonical pending identities from alias updates', () => {
  const source = '2027|测试大学|计算机学院|夏令营';
  const middle = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical = '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const pending = emptyPendingLedger();
  const carriedActive = opportunity(
    '2027|测试大学|软件学院|推免预报名',
    'confirmed-open',
  );
  const previous = parent([carriedActive, opportunity(source, 'confirmed-open')]);
  const input: ScanBundle = {
    ...baseBundle(),
    candidateBase: {
      ...baseBundle().candidateBase,
      snapshotId: previous.snapshotId,
      dataHash: previous.dataHash,
    },
    pendingLedger: {
      generation: pending.current.generation,
      sha256: pending.current.sha256,
    },
    scanMode: 'incremental',
    scopeItems: [{
      scopeItemId: 'middle-blocked',
      kind: 'registry',
      school: '测试大学',
      targetId: middle,
      status: 'blocked',
      evidenceIds: ['middle-blocked-evidence'],
    }],
    evidenceRecords: [{
      evidenceId: 'middle-blocked-evidence',
      scopeItemId: 'middle-blocked',
      school: '测试大学',
      region: '华北',
      kind: 'college-notice',
      url: 'https://cs.example.edu/blocked',
      result: 'blocked',
      checkedAt: '2026-07-29T00:30:00.000Z',
      query: '测试大学 2027 推免',
      discoveredScopeItemIds: [],
    }],
    pendingUpdates: [{
      ledgerId: `project:${middle}`,
      outcome: 'pending',
      checkedAt: '2026-07-29T00:30:00.000Z',
      evidenceIds: ['middle-blocked-evidence'],
      reason: '官网入口受阻',
      scopeItemId: 'middle-blocked',
      school: '测试大学',
      region: '华北',
      targetId: middle,
      officialUrls: ['https://cs.example.edu/blocked'],
      nextAction: '下一轮复核官网',
      projectId: middle,
    }],
  };

  const artifacts = buildScanReleaseArtifacts({
    bundle: input,
    parent: previous,
    registryInstitutions: [],
    sentinels: { schemaVersion: 1, cycle: '2027', institutions: [] },
    identityRegistry: {
      schemaVersion: 2,
      urlAliases: [],
      projectAliases: [
        {
          sourceProjectId: source,
          canonicalProjectId: middle,
          cycle: '2027',
          reason: '历史标题',
          introducedRunId: '20260729-build-pending-canonical',
        },
        {
          sourceProjectId: middle,
          canonicalProjectId: canonical,
          cycle: '2027',
          reason: '统一正式标题',
          introducedRunId: '20260729-build-pending-canonical',
        },
      ],
      tombstones: [],
    },
    submittedRegistry: emptySubmittedRegistry(),
    pendingLedger: pending,
    artifactManifest: emptyArtifactManifest(input.runId),
    removalReviews: [],
  });

  assert.deepEqual(
    artifacts.pendingNext.current.entries.map(({ ledgerId, targetId, projectId }) => ({
      ledgerId,
      targetId,
      projectId,
    })),
    [{ ledgerId: `project:${canonical}`, targetId: canonical, projectId: canonical }],
  );
  assert.equal(artifacts.gate.zeroLossMetrics.pendingProjectionMismatch, 0);
});

test('buildScanReleaseArtifacts migrates a prior alias pending ledger without rewriting history', () => {
  const source = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical = '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const oldUpdate = {
    ledgerId: `project:${source}`,
    outcome: 'pending' as const,
    checkedAt: '2026-07-29T00:05:00.000Z',
    evidenceIds: ['old-pending-evidence'],
    reason: '官网入口受阻',
    scopeItemId: 'old-pending-scope',
    school: '测试大学',
    region: '华北',
    targetId: source,
    officialUrls: ['https://cs.example.edu/old-blocked'],
    nextAction: '下一轮复核官网',
    projectId: source,
  };
  const pending = buildNextPendingLedger(emptyPendingLedger(), [oldUpdate], {
    runId: '20260729-prior-pending-alias',
    scanStartedAt: '2026-07-29T00:00:00.000Z',
    scanFinishedAt: '2026-07-29T00:10:00.000Z',
  });
  const carriedActive = opportunity(
    '2027|测试大学|软件学院|推免预报名',
    'confirmed-open',
  );
  const previous = parent([carriedActive, opportunity(source, 'confirmed-open')]);
  const input: ScanBundle = {
    ...baseBundle(),
    runId: '20260729-build-pending-migration',
    scanStartedAt: '2026-07-29T01:00:00.000Z',
    scanFinishedAt: '2026-07-29T01:10:00.000Z',
    candidateBase: {
      ...baseBundle().candidateBase,
      snapshotId: previous.snapshotId,
      dataHash: previous.dataHash,
    },
    pendingLedger: {
      generation: pending.current.generation,
      sha256: pending.current.sha256,
    },
    scanMode: 'incremental',
    scopeItems: [{
      scopeItemId: 'current-pending-scope',
      kind: 'registry',
      school: '测试大学',
      targetId: source,
      status: 'blocked',
      evidenceIds: ['current-pending-evidence'],
    }],
    evidenceRecords: [{
      evidenceId: 'current-pending-evidence',
      scopeItemId: 'current-pending-scope',
      school: '测试大学',
      region: '华北',
      kind: 'college-notice',
      url: 'https://cs.example.edu/current-blocked',
      result: 'blocked',
      checkedAt: '2026-07-29T01:05:00.000Z',
      query: '测试大学 2027 推免',
      discoveredScopeItemIds: [],
    }],
    pendingUpdates: [{
      ...oldUpdate,
      checkedAt: '2026-07-29T01:05:00.000Z',
      evidenceIds: ['current-pending-evidence'],
      scopeItemId: 'current-pending-scope',
      officialUrls: ['https://cs.example.edu/current-blocked'],
    }],
  };

  const artifacts = buildScanReleaseArtifacts({
    bundle: input,
    parent: previous,
    registryInstitutions: [],
    sentinels: { schemaVersion: 1, cycle: '2027', institutions: [] },
    identityRegistry: {
      schemaVersion: 2,
      urlAliases: [],
      projectAliases: [{
        sourceProjectId: source,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '统一正式标题',
        introducedRunId: '20260729-build-prior-pending-canonical',
      }],
      tombstones: [],
    },
    submittedRegistry: emptySubmittedRegistry(),
    pendingLedger: pending,
    artifactManifest: emptyArtifactManifest(input.runId),
    removalReviews: [],
  });

  assert.deepEqual(artifacts.pendingNext.history[0], pending.history[0]);
  assert.deepEqual(
    artifacts.pendingNext.current.entries.map(({ ledgerId, targetId, projectId }) => ({
      ledgerId,
      targetId,
      projectId,
    })),
    [{ ledgerId: `project:${canonical}`, targetId: canonical, projectId: canonical }],
  );
  assert.equal(artifacts.gate.zeroLossMetrics.pendingProjectionMismatch, 0);
});

test('release replay rejects forged gate digests and an uncommitted pending ledger', () => {
  const active = opportunity(
    '2027|测试大学|计算机学院|推免预报名',
    'confirmed-open',
  );
  const previous = parent([active]);
  const pending = emptyPendingLedger();
  const input: ScanBundle = {
    ...baseBundle(),
    candidateBase: {
      ...baseBundle().candidateBase,
      snapshotId: previous.snapshotId,
      dataHash: previous.dataHash,
    },
    pendingLedger: {
      generation: pending.current.generation,
      sha256: pending.current.sha256,
    },
  };
  const buildOptions = {
    bundle: input,
    parent: previous,
    registryInstitutions: [],
    sentinels: {
      schemaVersion: 1 as const,
      cycle: '2027',
      institutions: [],
    },
    identityRegistry: {
      schemaVersion: 2 as const,
      urlAliases: [],
      projectAliases: [],
      tombstones: [],
    },
    submittedRegistry: emptySubmittedRegistry(),
    pendingLedger: pending,
    artifactManifest: emptyArtifactManifest(input.runId),
    removalReviews: [],
  };
  const artifacts = buildScanReleaseArtifacts(buildOptions);
  const forgedGate = structuredClone(artifacts.gate);
  forgedGate.artifactDigests.bundleSha256 = 'f'.repeat(64);

  assert.throws(
    () => verifyScanReleaseReplay({
      buildOptions,
      candidate: artifacts.candidate,
      diff: artifacts.diff,
      pendingNext: artifacts.pendingNext,
      lifecycle: artifacts.reduction.lifecycle,
      evidenceDispositions: artifacts.reduction.evidenceDispositions,
      gate: forgedGate,
      audit: artifacts.audit,
      livePending: artifacts.pendingNext,
    }),
    /gate.*replay|replayed gate|digest/i,
  );
  assert.throws(
    () => verifyScanReleaseReplay({
      buildOptions,
      candidate: artifacts.candidate,
      diff: artifacts.diff,
      pendingNext: artifacts.pendingNext,
      lifecycle: artifacts.reduction.lifecycle,
      evidenceDispositions: artifacts.reduction.evidenceDispositions,
      gate: artifacts.gate,
      audit: artifacts.audit,
      livePending: pending,
    }),
    /pending.*committed|live pending|generation|digest/i,
  );
});

test('pending projection mismatch compares exact identities, not only counts', () => {
  const projectedProjectId = '2027|测试大学|软件学院|推免预报名';
  const ledgerProjectId = '2027|测试大学|人工智能学院|推免预报名';
  const projected = reduction({
    pending: [
      {
        ledgerId: `project:${projectedProjectId}`,
        scopeItemId: 'projected-pending',
        school: '测试大学',
        region: '华北',
        targetId: projectedProjectId,
        officialUrls: ['https://se.example.edu/admissions/2027'],
        nextAction: '下一轮继续核验',
        projectId: projectedProjectId,
        reason: '本轮仍待核验',
        evidenceIds: [],
        checkedAt: SCAN_AT,
      },
    ],
  });
  const ledgerEntries: PendingLedgerEntry[] = [
    {
      ledgerId: `project:${ledgerProjectId}`,
      lastRunId: 'previous-run',
      outcome: 'pending',
      scopeItemId: 'ledger-pending',
      school: '测试大学',
      region: '华北',
      targetId: ledgerProjectId,
      officialUrls: ['https://ai.example.edu/admissions/2027'],
      nextAction: '下一轮继续核验',
      projectId: ledgerProjectId,
      reason: '本轮仍待核验',
      evidenceIds: [],
      checkedAt: SCAN_AT,
    },
  ];

  assert.equal(
    countPendingProjectionMismatch(projected, ledgerEntries),
    2,
  );
});

test('build CLI verifies declared input hashes and writes gate last', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'build-scan-release-cli-'));
  const paths = Object.fromEntries(
    [
      'bundle',
      'parent',
      'registry',
      'sentinels',
      'identity',
      'submitted',
      'pending',
      'artifact-manifest',
      'candidate',
      'diff',
      'lifecycle',
      'evidence-dispositions',
      'gate',
      'pending-next',
      'audit',
    ].map((name) => [name, join(tempRoot, `${name}.json`)]),
  );
  const candidateParent = structuredClone(parent([
    opportunity(
      '2027|测试大学|计算机学院|推免预报名',
      'confirmed-open',
    ),
  ]));
  candidateParent.scanAt = '2026-07-28T02:00:00.000Z';
  delete (candidateParent as Partial<PublicSnapshot>).snapshotId;
  delete (candidateParent as Partial<PublicSnapshot>).approvedAt;
  delete (candidateParent as Partial<PublicSnapshot>).previousSnapshotId;
  delete (candidateParent as Partial<PublicSnapshot>).dataHash;
  const approved = approveCandidate(
    candidateParent,
    null,
    '2026-07-28T03:00:00.000Z',
  );
  const parentText = `${JSON.stringify(approved, null, 2)}\n`;
  const registry = [{ name: '测试大学' }];
  const registryText = `${JSON.stringify(registry, null, 2)}\n`;
  const pending = emptyPendingLedger();
  const artifactRoot = join(tempRoot, 'artifacts');
  const artifactRelativePath = 'official/evidence.txt';
  const artifactText = 'current-run official evidence\n';
  const artifactSha256 = createHash('sha256').update(artifactText).digest('hex');
  const strictBundle = {
    ...baseBundle(),
    candidateBase: {
      ...baseBundle().candidateBase,
      sha256: createHash('sha256').update(parentText).digest('hex'),
      snapshotId: approved.snapshotId,
      dataHash: approved.dataHash,
    },
    registry: {
      sha256: createHash('sha256').update(registryText).digest('hex'),
      institutionCount: 1,
    },
    pendingLedger: {
      generation: pending.current.generation,
      sha256: pending.current.sha256,
    },
    discoverySourceChecks: [
      {
        name: '保研通知网',
        url: 'https://baoyantongzhi.com/',
        status: 'checked',
        pagesChecked: 1,
        checkedAt: '2026-07-29T00:10:00.000Z',
        artifactSha256,
      },
      {
        name: 'CS-BAOYAN DDL',
        url: 'https://ddl.csbaoyan.top/',
        status: 'checked',
        pagesChecked: 1,
        checkedAt: '2026-07-29T00:11:00.000Z',
        artifactSha256,
      },
      {
        name: 'BoardCaster',
        url: 'https://boardcaster.net/',
        status: 'checked',
        pagesChecked: 1,
        checkedAt: '2026-07-29T00:12:00.000Z',
        artifactSha256,
      },
    ],
    scopeItems: [
      {
        scopeItemId: 'sentinel-test',
        kind: 'sentinel',
        school: '测试大学',
        targetId: '测试大学',
        status: 'no-current-notice',
        evidenceIds: ['test-grad'],
      },
    ],
    evidenceRecords: [
      {
        evidenceId: 'test-grad',
        scopeItemId: 'sentinel-test',
        school: '测试大学',
        region: '华北',
        kind: 'graduate-admissions',
        url: 'https://grad.example.edu/admissions',
        result: 'no-current-notice',
        checkedAt: '2026-07-29T00:30:00.000Z',
        artifactSha256,
        query: '测试大学 2027 推免',
        discoveredScopeItemIds: [],
      },
    ],
  };
  writeFileSync(paths.parent, parentText);
  writeFileSync(paths.registry, registryText);
  writeFileSync(paths.bundle, `${JSON.stringify(strictBundle, null, 2)}\n`);
  writeFileSync(
    paths.sentinels,
    `${JSON.stringify({
      schemaVersion: 1,
      cycle: '2027',
      institutions: [
        {
          school: '测试大学',
          minimumEvidenceRecords: 1,
          requiredOfficialKinds: ['graduate-admissions'],
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    paths.identity,
    `${JSON.stringify({
      schemaVersion: 2,
      urlAliases: [],
      projectAliases: [],
      tombstones: [],
    }, null, 2)}\n`,
  );
  writeFileSync(
    paths.submitted,
    `${JSON.stringify(emptySubmittedRegistry(), null, 2)}\n`,
  );
  writeFileSync(paths.pending, `${JSON.stringify(pending, null, 2)}\n`);
  mkdirSync(join(artifactRoot, 'official'), { recursive: true });
  writeFileSync(join(artifactRoot, artifactRelativePath), artifactText);
  writeFileSync(
    paths['artifact-manifest'],
    `${JSON.stringify({
      schemaVersion: 1,
      runId: strictBundle.runId,
      artifacts: [
        {
          relativePath: artifactRelativePath,
          sha256: artifactSha256,
          sizeBytes: Buffer.byteLength(artifactText),
        },
      ],
    }, null, 2)}\n`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        new URL(
          '../scripts/snapshot/build-scan-release.ts',
          import.meta.url,
        ).pathname,
        '--bundle',
        paths.bundle,
        '--parent',
        paths.parent,
        '--registry',
        paths.registry,
        '--sentinels',
        paths.sentinels,
        '--identity-registry',
        paths.identity,
        '--submitted',
        paths.submitted,
        '--pending-current',
        paths.pending,
        '--artifact-manifest',
        paths['artifact-manifest'],
        '--artifact-root',
        artifactRoot,
        '--candidate',
        paths.candidate,
        '--diff',
        paths.diff,
        '--lifecycle',
        paths.lifecycle,
        '--evidence-dispositions',
        paths['evidence-dispositions'],
        '--gate',
        paths.gate,
        '--pending-next',
        paths['pending-next'],
        '--audit',
        paths.audit,
      ],
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(paths.gate, 'utf8')).status, 'ready');
    assert.equal(JSON.parse(readFileSync(paths.audit, 'utf8')).runStatus, 'ready');
    assert.deepEqual(JSON.parse(readFileSync(paths.lifecycle, 'utf8')), [
      {
        sourceProjectId: approved.opportunities[0].projectId,
        canonicalProjectId: approved.opportunities[0].projectId,
        state: 'carried-active',
        reason: 'untouched parent project carried by incremental scan',
        evidenceIds: [],
        verifiedAt: approved.opportunities[0].verifiedAt,
      },
    ]);
    assert.deepEqual(
      JSON.parse(readFileSync(paths['evidence-dispositions'], 'utf8')),
      [
        {
          evidenceId: 'test-grad',
          kind: 'scope',
          scopeItemId: 'sentinel-test',
          reason: 'official evidence result no-current-notice',
        },
      ],
    );
    assert.equal(
      JSON.parse(readFileSync(paths['pending-next'], 'utf8')).current.generation,
      1,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
