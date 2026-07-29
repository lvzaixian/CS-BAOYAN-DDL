import assert from 'node:assert/strict';
import {
  readFileSync,
} from 'node:fs';
import test from 'node:test';

import {
  approveCandidate,
} from '../scripts/snapshot/approve-snapshot.js';
import {
  createReleaseGate,
  parseReleaseGateManifest,
  validateReleaseGateForApproval,
  type ReleaseGateArtifactDigests,
  type ReleaseGateLossMetrics,
  type RemovalReview,
} from '../scripts/snapshot/release-gate.js';
import type {
  PublicOpportunity,
  PublicSnapshot,
  SnapshotCandidate,
} from '../src/lib/snapshot-types.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-valid.json', import.meta.url), 'utf8'),
) as PublicSnapshot;
const parentApprovedAt = '2026-07-16T09:35:00+08:00';
const nextApprovedAt = '2026-07-16T09:40:00+08:00';
const projectA = '2027|测试大学|计算机学院|A';
const projectB = '2027|测试大学|计算机学院|B';
const projectC = '2027|测试大学|计算机学院|C';

const artifactDigests: ReleaseGateArtifactDigests = {
  bundleSha256: '1'.repeat(64),
  institutionRegistrySha256: '2'.repeat(64),
  sentinelRegistrySha256: '3'.repeat(64),
  identityRegistrySha256: '4'.repeat(64),
  submittedRegistrySha256: '5'.repeat(64),
  pendingBaseSha256: '6'.repeat(64),
  pendingNextSha256: '7'.repeat(64),
  lifecycleSha256: '8'.repeat(64),
  evidenceDispositionsSha256: '9'.repeat(64),
  artifactManifestSha256: 'a'.repeat(64),
};

const zeroLossMetrics: ReleaseGateLossMetrics = {
  unaccountedParentActive: 0,
  undisposedEvidenceRecords: 0,
  missingPreviousPendingEvents: 0,
  unaccountedPendingScopes: 0,
  pendingProjectionMismatch: 0,
};

function opportunity(projectId: string, index: number): PublicOpportunity {
  return {
    ...structuredClone(fixture.opportunities[0]),
    projectId,
    project: projectId.split('|')[3],
    website: `https://cs.example.edu.cn/admissions/${index}`,
    discoverySources: [
      {
        kind: 'official',
        label: '学院官网',
        url: `https://cs.example.edu.cn/admissions/${index}`,
      },
    ],
  };
}

function candidate(projectIds: string[]): SnapshotCandidate {
  const value = structuredClone(fixture) as Partial<PublicSnapshot>;
  delete value.snapshotId;
  delete value.approvedAt;
  delete value.previousSnapshotId;
  delete value.dataHash;
  const opportunities = projectIds.map(opportunity);
  return {
    ...(value as SnapshotCandidate),
    counts: {
      confirmedOpen: opportunities.length,
      confirmedUnknownDeadline: 0,
      pendingExcluded: 0,
      expired: 0,
    },
    opportunities,
  };
}

function parent(
  projectIds: string[],
  approvedAt = parentApprovedAt,
): PublicSnapshot {
  return approveCandidate(candidate(projectIds), null, approvedAt);
}

function review(projectId: string): RemovalReview {
  return {
    projectId,
    decision: 'approve-removal',
    reviewedBy: 'release-gate-test',
    reviewedAt: nextApprovedAt,
    reason: 'The exact removal was checked against the bound evidence artifact.',
    evidenceIds: [`evidence:${projectId}`],
  };
}

function gateFor(
  current: PublicSnapshot | null,
  next: SnapshotCandidate,
  removalReviews: RemovalReview[] = [],
  overrides: {
    hardErrors?: Array<{ code: string; message: string; evidenceIds: string[] }>;
    zeroLossMetrics?: ReleaseGateLossMetrics;
  } = {},
) {
  return createReleaseGate({
    runId: '20260729-release-gate-test',
    parent: current,
    candidate: next,
    artifactDigests,
    hardErrors: overrides.hardErrors ?? [],
    zeroLossMetrics: overrides.zeroLossMetrics ?? zeroLossMetrics,
    removalReviews,
  });
}

test('release-local removal reviews cannot authorize removal B', () => {
  const current = parent([projectA, projectB]);
  const next = candidate([projectA]);

  const unreviewed = gateFor(current, next);
  assert.equal(unreviewed.status, 'needs-review');
  assert.deepEqual(unreviewed.diff, {
    added: [],
    changed: [],
    expired: [],
    removed: [projectB],
  });

  const reviewed = gateFor(current, next, [review(projectB)]);
  assert.equal(reviewed.status, 'needs-review');
  assert.deepEqual(reviewed.removalReviews.map(({ projectId }) => projectId), [projectB]);

  assert.throws(
    () => parseReleaseGateManifest({
      ...reviewed,
      status: 'ready',
    }),
    /status must be needs-review/i,
  );
});

test('a trusted external authorization can approve an exactly bound removal set', () => {
  const current = parent([projectA, projectB]);
  const next = candidate([projectA]);
  const gate = gateFor(current, next, [review(projectB)]);
  const removalReviewsSha256 = 'b'.repeat(64);
  const authorization = {
    schemaVersion: 1,
    runId: gate.runId,
    parent: {
      snapshotId: current.snapshotId,
      dataHash: current.dataHash,
    },
    candidateCanonicalDataHash: gate.candidate.canonicalDataHash,
    removalReviewsSha256,
    removedProjectIds: [projectB],
    reviewedBy: 'trusted-parent-operator',
    reviewedAt: nextApprovedAt,
    reason: 'Exact removal evidence was reviewed outside the release directory.',
  };

  assert.deepEqual(
    validateReleaseGateForApproval(
      gate,
      current,
      next,
      structuredClone(gate),
      {
        removalAuthorization: authorization,
        removalReviewsSha256,
      },
    ),
    gate.diff,
  );

  assert.throws(
    () => validateReleaseGateForApproval(
      gate,
      current,
      next,
      structuredClone(gate),
    ),
    /trusted external removal authorization/i,
  );
  assert.throws(
    () => validateReleaseGateForApproval(
      gate,
      current,
      next,
      structuredClone(gate),
      {
        removalAuthorization: {
          ...authorization,
          candidateCanonicalDataHash: 'c'.repeat(64),
        },
        removalReviewsSha256,
      },
    ),
    /candidate canonical hash/i,
  );
});

test('release gate parsing exact-key validates every artifact digest and loss metric', async (t) => {
  const ready = gateFor(null, candidate([projectA]));

  assert.deepEqual(parseReleaseGateManifest(ready), ready);
  assert.throws(
    () => parseReleaseGateManifest({ ...ready, unexpected: true }),
    /release gate\.unexpected is not allowed/,
  );

  for (const key of Object.keys(artifactDigests) as Array<keyof ReleaseGateArtifactDigests>) {
    await t.test(`artifactDigests.${key}`, () => {
      const missing = structuredClone(ready) as Record<string, any>;
      delete missing.artifactDigests[key];
      assert.throws(
        () => parseReleaseGateManifest(missing),
        new RegExp(`release gate\\.artifactDigests\\.${key} is required`),
      );

      const malformed = structuredClone(ready) as Record<string, any>;
      malformed.artifactDigests[key] = 'not-a-digest';
      assert.throws(
        () => parseReleaseGateManifest(malformed),
        new RegExp(`release gate\\.artifactDigests\\.${key} must be a SHA-256 digest`),
      );
    });
  }

  for (const key of Object.keys(zeroLossMetrics) as Array<keyof ReleaseGateLossMetrics>) {
    await t.test(`zeroLossMetrics.${key}`, () => {
      const missing = structuredClone(ready) as Record<string, any>;
      delete missing.zeroLossMetrics[key];
      assert.throws(
        () => parseReleaseGateManifest(missing),
        new RegExp(`release gate\\.zeroLossMetrics\\.${key} is required`),
      );

      const malformed = structuredClone(ready) as Record<string, any>;
      malformed.zeroLossMetrics[key] = -1;
      assert.throws(
        () => parseReleaseGateManifest(malformed),
        new RegExp(`release gate\\.zeroLossMetrics\\.${key} must be an integer >= 0`),
      );
    });
  }

  const nestedCases: Array<[string, (value: Record<string, any>) => void, RegExp]> = [
    [
      'parent',
      (value) => {
        value.parent.unexpected = true;
      },
      /release gate\.parent\.unexpected is not allowed/,
    ],
    [
      'candidate',
      (value) => {
        value.candidate.unexpected = true;
      },
      /release gate\.candidate\.unexpected is not allowed/,
    ],
    [
      'diff',
      (value) => {
        value.diff.unexpected = [];
      },
      /release gate\.diff\.unexpected is not allowed/,
    ],
    [
      'artifactDigests',
      (value) => {
        value.artifactDigests.unexpected = 'f'.repeat(64);
      },
      /release gate\.artifactDigests\.unexpected is not allowed/,
    ],
    [
      'zeroLossMetrics',
      (value) => {
        value.zeroLossMetrics.unexpected = 0;
      },
      /release gate\.zeroLossMetrics\.unexpected is not allowed/,
    ],
  ];
  for (const [name, mutate, pattern] of nestedCases) {
    await t.test(`${name} rejects unknown keys`, () => {
      const malformed = structuredClone(ready) as Record<string, any>;
      mutate(malformed);
      assert.throws(() => parseReleaseGateManifest(malformed), pattern);
    });
  }

  const reviewed = gateFor(parent([projectA, projectB]), candidate([projectA]), [
    review(projectB),
  ]) as Record<string, any>;
  reviewed.removalReviews[0].unexpected = true;
  assert.throws(
    () => parseReleaseGateManifest(reviewed),
    /removalReviews\[0\]\.unexpected is not allowed/,
  );
});

test('approval rejects a gate whose artifact digests differ from an independent replay', () => {
  const current = parent([projectA]);
  const next = candidate([projectA]);
  const replayed = gateFor(current, next);
  const forged = structuredClone(replayed);
  forged.artifactDigests.bundleSha256 = 'f'.repeat(64);

  assert.throws(
    () => validateReleaseGateForApproval(forged, current, next, replayed),
    /artifact|replay|recomputed|digest/i,
  );
});

test('approval always requires an independently replayed gate', () => {
  const current = parent([projectA]);
  const next = candidate([projectA]);
  const ready = gateFor(current, next);

  assert.throws(
    () => validateReleaseGateForApproval(ready, current, next),
    /independent replay is required/i,
  );
});

test('approval recomputes and rejects a forged empty diff', () => {
  const current = parent([projectA, projectB]);
  const next = candidate([projectA]);
  const forged = gateFor(current, next, [review(projectB)]) as Record<string, any>;
  forged.diff = { added: [], changed: [], expired: [], removed: [] };
  forged.removalReviews = [];
  forged.status = 'ready';
  assert.throws(
    () => validateReleaseGateForApproval(forged, current, next, forged),
    /release gate diff.*recomputed diff/i,
  );
});

test('approval rejects candidate and current drift', async (t) => {
  await t.test('candidate drift', () => {
    const current = parent([projectA, projectB]);
    const next = candidate([projectA]);
    const gate = gateFor(current, next, [review(projectB)]);
    const drifted = structuredClone(next);
    drifted.opportunities[0].website =
      'https://cs.example.edu.cn/admissions/drifted';
    drifted.opportunities[0].discoverySources[0].url =
      drifted.opportunities[0].website;
    assert.throws(
      () => validateReleaseGateForApproval(gate, current, drifted, gate),
      /candidate.*drift|candidate.*hash/i,
    );
  });

  await t.test('current parent drift', () => {
    const gateParent = parent([projectA, projectB]);
    const driftedCurrent = parent(
      [projectA, projectC],
      '2026-07-16T09:36:00+08:00',
    );
    const next = candidate([projectA]);
    const gate = gateFor(gateParent, next, [review(projectB)]);
    assert.throws(
      () => validateReleaseGateForApproval(gate, driftedCurrent, next, gate),
      /parent.*drift|parent.*snapshotId|parent.*dataHash/i,
    );
  });
});

test('approval fails closed on hard errors, nonzero loss, and unreviewed removals', async (t) => {
  const cases: Array<{
    name: string;
    current: PublicSnapshot | null;
    next: SnapshotCandidate;
    gate: ReturnType<typeof gateFor>;
    pattern: RegExp;
  }> = [
    {
      name: 'hard errors',
      current: null,
      next: candidate([projectA]),
      gate: gateFor(null, candidate([projectA]), [], {
        hardErrors: [
          {
            code: 'ORPHAN_EVIDENCE',
            message: 'evidence has no disposition',
            evidenceIds: ['evidence:orphan'],
          },
        ],
      }),
      pattern: /hard errors/i,
    },
    {
      name: 'nonzero loss metrics',
      current: null,
      next: candidate([projectA]),
      gate: gateFor(null, candidate([projectA]), [], {
        zeroLossMetrics: {
          ...zeroLossMetrics,
          undisposedEvidenceRecords: 1,
        },
      }),
      pattern: /loss metrics/i,
    },
    {
      name: 'unreviewed removal',
      current: parent([projectA, projectB]),
      next: candidate([projectA]),
      gate: gateFor(parent([projectA, projectB]), candidate([projectA])),
      pattern: /unreviewed removals/i,
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, () => {
      assert.throws(
        () =>
          validateReleaseGateForApproval(
            currentCase.gate,
            currentCase.current,
            currentCase.next,
            currentCase.gate,
          ),
        currentCase.pattern,
      );
    });
  }
});
