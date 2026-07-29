import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseIdentityRegistry,
  parseScanBundle,
} from '../scripts/snapshot/scan-release-contract.js';

const digest = 'a'.repeat(64);

function validBundle(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    runId: '20260729-contract-test',
    scanMode: 'full',
    scanStartedAt: '2026-07-29T08:00:00.000Z',
    scanFinishedAt: '2026-07-29T08:30:00.000Z',
    candidateBase: {
      type: 'public-approved-snapshot',
      url: 'https://ddl.meta-mind.cn/data/current.json',
      sha256: digest,
      snapshotId: '2026-07-29T07:00:00.000Z-123456789abc',
      dataHash: 'b'.repeat(64),
      privateParentCandidateUsed: false,
    },
    registry: {
      sha256: 'c'.repeat(64),
      institutionCount: 1,
    },
    pendingLedger: {
      generation: 0,
      sha256: 'd'.repeat(64),
    },
    errors: [],
    warnings: [],
    discoverySourceChecks: [
      {
        name: '保研通知网',
        url: 'https://baoyantongzhi.com/',
        status: 'checked',
        pagesChecked: 1,
        checkedAt: '2026-07-29T08:10:00.000Z',
        artifactSha256: 'e'.repeat(64),
      },
      {
        name: 'CS-BAOYAN DDL',
        url: 'https://ddl.csbaoyan.top/',
        status: 'checked',
        pagesChecked: 1,
        checkedAt: '2026-07-29T08:11:00.000Z',
        artifactSha256: 'f'.repeat(64),
      },
      {
        name: 'BoardCaster',
        url: 'https://boardcaster.net/',
        status: 'checked',
        pagesChecked: 1,
        checkedAt: '2026-07-29T08:12:00.000Z',
        artifactSha256: '1'.repeat(64),
      },
    ],
    scopeItems: [
      {
        scopeItemId: 'registry:test-university',
        kind: 'registry',
        school: '测试大学',
        targetId: 'graduate-admissions',
        status: 'checked',
        evidenceIds: ['evidence:test'],
      },
    ],
    evidenceRecords: [
      {
        evidenceId: 'evidence:test',
        scopeItemId: 'registry:test-university',
        school: '测试大学',
        region: '华东',
        kind: 'graduate-admissions',
        url: 'https://yz.test.edu.cn/2027推免',
        result: 'hit',
        checkedAt: '2026-07-29T08:20:00.000Z',
        artifactSha256: '2'.repeat(64),
        query: '测试大学 2027 推免 官方',
        discoveredScopeItemIds: [],
      },
    ],
    projectObservations: [
      {
        observationId: 'observation:test',
        sourceProjectId: '2027|测试大学|计算机学院|推免预报名',
        cycle: '2027',
        school: '测试大学',
        project: '计算机学院｜推免预报名',
        eventType: '推免预报名',
        registrationState: 'open',
        deadline: null,
        deadlineOriginal: '官方未公布截止时间',
        eventMode: 'unknown',
        eventTime: '未公布',
        formatLocation: '未公布',
        accommodation: '未知',
        meals: '未知',
        transport: '未知',
        reimbursement: '未知',
        recommendationLetters: '未知',
        recommendationTemplate: '未知',
        materialComplexity: '未知',
        materialList: '未知',
        officialUrl: 'https://yz.test.edu.cn/2027推免',
        evidenceIds: ['evidence:test'],
      },
    ],
    pendingUpdates: [],
    exclusions: [],
  };
}

test('accepts one exact strict scan bundle', () => {
  const parsed = parseScanBundle(validBundle());
  assert.equal(parsed.runId, '20260729-contract-test');
  assert.equal(parsed.evidenceRecords.length, 1);
});

test('rejects unknown bundle and nested keys with an exact path', () => {
  const topLevel = { ...validBundle(), pendingProjects: [] };
  assert.throws(
    () => parseScanBundle(topLevel),
    /scan bundle\.pendingProjects is not allowed/,
  );

  const nested = structuredClone(validBundle());
  (nested.evidenceRecords as Array<Record<string, unknown>>)[0].httpStatus = 200;
  assert.throws(
    () => parseScanBundle(nested),
    /evidenceRecords\[0\]\.httpStatus is not allowed/,
  );
});

test('rejects readable evidence without an artifact digest', () => {
  const bundle = structuredClone(validBundle());
  delete (bundle.evidenceRecords as Array<Record<string, unknown>>)[0].artifactSha256;
  assert.throws(
    () => parseScanBundle(bundle),
    /evidenceRecords\[0\]\.artifactSha256 is required for readable evidence/,
  );
});

test('rejects blocked evidence without an error', () => {
  const bundle = structuredClone(validBundle());
  const evidence = (bundle.evidenceRecords as Array<Record<string, unknown>>)[0];
  evidence.result = 'blocked';
  delete evidence.artifactSha256;
  assert.throws(
    () => parseScanBundle(bundle),
    /evidenceRecords\[0\]\.error is required for blocked evidence/,
  );
});

test('rejects a project observation without evidence', () => {
  const bundle = structuredClone(validBundle());
  (bundle.projectObservations as Array<Record<string, unknown>>)[0].evidenceIds = [];
  assert.throws(
    () => parseScanBundle(bundle),
    /projectObservations\[0\]\.evidenceIds must not be empty/,
  );
});

test('rejects a project observation backed only by blocked evidence', () => {
  const bundle = structuredClone(validBundle());
  const evidence = (bundle.evidenceRecords as Array<Record<string, unknown>>)[0];
  evidence.result = 'blocked';
  evidence.error = 'HTTP 412';
  delete evidence.artifactSha256;
  assert.throws(
    () => parseScanBundle(bundle),
    /projectObservations\[0\] must have readable hit evidence matching officialUrl/,
  );
});

test('rejects a project observation whose hit evidence is for another official URL', () => {
  const bundle = structuredClone(validBundle());
  (bundle.evidenceRecords as Array<Record<string, unknown>>)[0].result = 'hit';
  (bundle.evidenceRecords as Array<Record<string, unknown>>)[0].url =
    'https://yz.test.edu.cn/another-notice';
  assert.throws(
    () => parseScanBundle(bundle),
    /projectObservations\[0\] must have readable hit evidence matching officialUrl/,
  );
});

test('rejects cross-scope evidence ownership in coverage declarations', () => {
  const bundle = structuredClone(validBundle());
  (bundle.scopeItems as Array<Record<string, unknown>>).push({
    scopeItemId: 'sentinel:test-university',
    kind: 'sentinel',
    school: '测试大学',
    targetId: '测试大学',
    status: 'checked',
    evidenceIds: ['evidence:test'],
  });
  assert.throws(
    () => parseScanBundle(bundle),
    /scopeItems\[1\]\.evidenceIds evidence:test is owned by registry:test-university/,
  );
});

test('rejects owner evidence assigned to a different school', () => {
  const bundle = structuredClone(validBundle());
  (bundle.evidenceRecords as Array<Record<string, unknown>>)[0].school = '另一所大学';
  (bundle.projectObservations as Array<Record<string, unknown>>)[0].school = '另一所大学';
  assert.throws(
    () => parseScanBundle(bundle),
    /evidenceRecords\[0\]\.school must match owner scopeItems\[0\]\.school \(registry:test-university\)/,
  );
});

test('rejects a discovered scope assigned to a different school', () => {
  const bundle = structuredClone(validBundle());
  (bundle.scopeItems as Array<Record<string, unknown>>).push({
    scopeItemId: 'discovered:other-university',
    kind: 'discovered-child',
    school: '另一所大学',
    targetId: 'other-university',
    status: 'checked',
    evidenceIds: [],
  });
  (bundle.evidenceRecords as Array<Record<string, unknown>>)[0].discoveredScopeItemIds = [
    'discovered:other-university',
  ];
  assert.throws(
    () => parseScanBundle(bundle),
    /evidenceRecords\[0\]\.discoveredScopeItemIds\[0\] references scopeItems\[1\] \(discovered:other-university\) whose school does not match evidenceRecords\[0\]\.school/,
  );
});

test('rejects evidence timestamps outside the run window', () => {
  const bundle = structuredClone(validBundle());
  (bundle.evidenceRecords as Array<Record<string, unknown>>)[0].checkedAt =
    '2026-07-29T08:30:00.001Z';
  assert.throws(
    () => parseScanBundle(bundle),
    /evidenceRecords\[0\]\.checkedAt must belong to the scan run/,
  );
});

test('rejects legacy pending aliases instead of partially consuming them', () => {
  for (const key of ['pendingProjects', 'pendingProjectLeads', 'pendingLeads']) {
    const bundle = { ...validBundle(), [key]: [] };
    assert.throws(
      () => parseScanBundle(bundle),
      new RegExp(`scan bundle\\.${key} is not allowed`),
    );
  }
});

test('pending updates preserve the identity and official surfaces needed by the next scan', () => {
  const complete = structuredClone(validBundle());
  complete.pendingUpdates = [
    {
      ledgerId: 'project:2027|测试大学|计算机学院|推免预报名',
      outcome: 'pending',
      checkedAt: '2026-07-29T08:20:00.000Z',
      evidenceIds: ['evidence:test'],
      reason: '学院通知页本轮受阻',
      scopeItemId: 'registry:test-university',
      school: '测试大学',
      region: '华东',
      targetId: '2027|测试大学|计算机学院|推免预报名',
      officialUrls: ['https://yz.test.edu.cn/2027推免'],
      nextAction: '下一轮复核学院通知页和报名系统',
      projectId: '2027|测试大学|计算机学院|推免预报名',
    },
  ];
  const parsed = parseScanBundle(complete);
  assert.deepEqual(parsed.pendingUpdates[0].officialUrls, [
    'https://yz.test.edu.cn/2027推免',
  ]);

  const incomplete = structuredClone(complete);
  delete (incomplete.pendingUpdates as Array<Record<string, unknown>>)[0].school;
  assert.throws(
    () => parseScanBundle(incomplete),
    /pendingUpdates\[0\]\.school is required/,
  );
});

test('accepts one versioned identity registry and rejects legacy maps', () => {
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [
      {
        url: 'https://example.edu/notices/1',
        canonicalProjectId: '2027|测试大学|计算机学院|推免预报名',
        cycle: '2027',
        reason: '官网栏目路径迁移',
        introducedRunId: '20260729-contract-test',
      },
    ],
    projectAliases: [],
    tombstones: [],
  });
  assert.equal(registry.urlAliases.length, 1);
  assert.throws(
    () =>
      parseIdentityRegistry({
        'https://example.edu/notices/1':
          '2027|测试大学|计算机学院|推免预报名',
      }),
    /identity registry\.https:\/\/example\.edu\/notices\/1 is not allowed/,
  );
});
