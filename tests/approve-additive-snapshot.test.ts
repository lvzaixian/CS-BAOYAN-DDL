import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  linkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalDataHash, deriveSnapshotId } from '../src/lib/snapshot-integrity.js';
import {
  approveAdditiveSnapshotFile,
  type AdditiveApprovalRun,
} from '../scripts/snapshot/approve-snapshot.js';
import type { PublicSnapshot } from '../src/lib/snapshot-types.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-valid.json', import.meta.url), 'utf8'),
) as PublicSnapshot;
const parentApprovedAt = '2026-07-15T15:05:00.000Z';
const runScannedAt = '2026-08-09T08:30:00.000Z';
const nextApprovedAt = '2026-08-09T08:35:00.000Z';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const defaultArtifactText = '<html><body>官方招生通知原文</body></html>';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const registryText = readFileSync(
  join(repositoryRoot, 'scripts/source/universities.json'),
  'utf8',
);
const sentinelsText = readFileSync(
  join(repositoryRoot, 'scripts/source/priority-sentinels.json'),
  'utf8',
);
const registry = JSON.parse(registryText) as Array<{ name: string }>;
const sentinels = JSON.parse(sentinelsText) as {
  institutions: Array<{ school: string }>;
};

function registrySchoolName(value: string): string {
  const match = value.match(/^[^A-Za-z/]+/u);
  return (match?.[0] ?? value.split('/')[0]).trim();
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rotationDateSlot(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) % 7;
}

function rotationTargetSlot(school: string): number {
  return createHash('sha256')
    .update('cs-ddl-additive-rotation-v1\0', 'utf8')
    .update(school, 'utf8')
    .digest()
    .readUInt32BE(0) % 7;
}

function coverageScopes(
  parent: PublicSnapshot,
  artifactSha256: string,
  entryUrl: string,
): AdditiveApprovalRun['scopes'] {
  const registrySchools = [...new Set(registry.map((item) => registrySchoolName(item.name)))];
  const registrySet = new Set(registrySchools);
  const parentExtras = [...new Set(parent.opportunities.map((opportunity) => opportunity.name))]
    .filter((school) => !registrySet.has(school));
  const rotationSlot = rotationDateSlot('2026-08-09');
  const sentinelSchools = [...new Set(sentinels.institutions.map((item) => item.school))]
    .sort(codePointCompare);
  const rotationSchools = [...new Set([...registrySchools, ...parentExtras])]
    .filter((school) => rotationTargetSlot(school) === rotationSlot)
    .filter((school) => !sentinelSchools.includes(school))
    .sort(codePointCompare);
  return [
    ...sentinelSchools.map((school, index) => ({
      scopeId: `coverage-sentinel-${index}`,
      school,
      queue: 'sentinel' as const,
      parentScopeId: null,
      entryUrl,
      checkedAt: runScannedAt,
      result: 'no-new-clue' as const,
      reason: null,
      childScopeIds: [],
      artifactSha256,
    })),
    ...rotationSchools.map((school, index) => ({
      scopeId: `coverage-rotation-${index}`,
      school,
      queue: 'registry-rotation' as const,
      parentScopeId: null,
      entryUrl,
      checkedAt: runScannedAt,
      result: 'no-new-clue' as const,
      reason: null,
      childScopeIds: [],
      artifactSha256,
    })),
  ];
}

function writeJson(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text, 'utf8');
  return text;
}

function sealedParent(): PublicSnapshot {
  const parent = structuredClone(fixture);
  parent.approvedAt = parentApprovedAt;
  parent.scanAt = '2026-07-15T15:00:00.000Z';
  parent.previousSnapshotId = null;
  parent.dataHash = canonicalDataHash(parent);
  parent.snapshotId = deriveSnapshotId(parent.approvedAt, parent.dataHash);
  return parent;
}

function additionFor(parent: PublicSnapshot): PublicSnapshot['opportunities'][number] {
  const addition = structuredClone(parent.opportunities[0]);
  addition.projectId = '2027|新增测试大学|计算机学院|夏令营';
  addition.name = '新增测试大学';
  addition.project = '2026年新增测试大学优秀大学生夏令营';
  addition.description = addition.project;
  addition.website = 'https://cs-new.example.edu.cn/admissions/summer-camp';
  addition.deadline = '2026-08-20T23:59:00+08:00';
  addition.deadlineOriginal = '2026年8月20日截止';
  addition.deadlineEpochMs = Date.parse(addition.deadline);
  addition.verifiedAt = runScannedAt;
  addition.discoverySources = [
    { kind: 'official', label: '计算机学院通知', url: addition.website },
  ];
  return addition;
}

function sourceQuoteFor(
  opportunity: PublicSnapshot['opportunities'][number],
  field: string,
): string {
  switch (field) {
    case 'name': return opportunity.name;
    case 'institute': return opportunity.institute;
    case 'project': return opportunity.project;
    case 'eventType': return opportunity.eventType;
    case 'website': return opportunity.project;
    case 'verificationStatus': return opportunity.project;
    case 'deadline': return opportunity.deadlineOriginal;
    case 'deadlineOriginal': return opportunity.deadlineOriginal;
    case 'eventArrangement.time': return opportunity.eventArrangement.time.summary;
    case 'eventArrangement.formatLocation': return opportunity.eventArrangement.formatLocation.summary;
    case 'materials': return opportunity.materials.summary;
    case 'recommendation': return opportunity.recommendation.summary;
    case 'logistics': return opportunity.logistics.summary;
    default: throw new Error(`unsupported test field ${field}`);
  }
}

function artifactTextFor(additions: PublicSnapshot['opportunities']): string {
  const fields = [
    'name',
    'institute',
    'project',
    'eventType',
    'website',
    'verificationStatus',
    'deadline',
    'deadlineOriginal',
    'eventArrangement.time',
    'eventArrangement.formatLocation',
    'materials',
    'recommendation',
    'logistics',
  ];
  return `${defaultArtifactText}\n${additions.flatMap((opportunity) =>
    fields.map((field) => sourceQuoteFor(opportunity, field))).join('\n')}`;
}

function evidenceFor(
  opportunity: PublicSnapshot['opportunities'][number],
  artifactSha256: string,
) {
  const values: Record<string, unknown> = {
    name: opportunity.name,
    institute: opportunity.institute,
    project: opportunity.project,
    eventType: opportunity.eventType,
    website: opportunity.website,
    verificationStatus: opportunity.verificationStatus,
    deadline: opportunity.deadline,
    deadlineOriginal: opportunity.deadlineOriginal,
    'eventArrangement.time': opportunity.eventArrangement.time,
    'eventArrangement.formatLocation': opportunity.eventArrangement.formatLocation,
    materials: opportunity.materials,
    recommendation: opportunity.recommendation,
    logistics: opportunity.logistics,
  };
  return Object.entries(values).map(([field, value]) => ({
    field,
    normalizedValue: JSON.stringify(value),
    sourceUrl: opportunity.website,
    artifactSha256,
    locator: 'article > main',
    method: 'html',
    checkedAt: runScannedAt,
    quote: sourceQuoteFor(opportunity, field),
  }));
}

function additiveRun(
  parent: PublicSnapshot,
  parentText: string,
  additions: PublicSnapshot['opportunities'],
): AdditiveApprovalRun {
  const artifactSha256 = sha256(artifactTextFor(additions));
  const entryUrl = additions[0]?.website ?? 'https://cs-new.example.edu.cn/admissions/summer-camp';
  const school = additions[0]?.name ?? parent.opportunities[0].name;
  return {
    schemaVersion: 2,
    runId: '20260809-additive-unit-test',
    mode: 'incremental',
    startedAt: runScannedAt,
    finishedAt: runScannedAt,
    parent: {
      url: 'https://ddl.meta-mind.cn/data/current.json',
      sha256: sha256(parentText),
      snapshotId: parent.snapshotId,
      dataHash: parent.dataHash,
      privateParentCandidateUsed: false,
    },
    coverage: {
      schemaVersion: 1,
      rotationDate: '2026-08-09',
      registrySha256: sha256(registryText),
      sentinelsSha256: sha256(sentinelsText),
    },
    scopes: [
      ...coverageScopes(parent, artifactSha256, entryUrl),
      ...(additions.length === 0 ? [] : [{
        scopeId: 'scope-root',
        school,
        queue: 'fresh-signal' as const,
        parentScopeId: null,
        entryUrl,
        checkedAt: runScannedAt,
        result: 'new-clue' as const,
        reason: null,
        childScopeIds: [],
        artifactSha256,
      }]),
    ],
    artifacts: [
      {
        path: 'artifacts/official.html',
        sha256: artifactSha256,
        url: entryUrl,
        contentType: 'text/html',
        fetchedAt: runScannedAt,
        extractedTextArtifactSha256: null,
      },
    ],
    additions: additions.map((opportunity) => ({
      opportunity,
      evidence: {
        school: opportunity.name,
        scopeId: 'scope-root',
        officialUrl: opportunity.website,
        artifactSha256,
        fieldEvidence: evidenceFor(opportunity, artifactSha256),
      },
    })),
  };
}

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'approve-additive-snapshot-'));
  return {
    root,
    artifacts: join(root, 'artifacts'),
    parent: join(root, 'parent.json'),
    run: join(root, 'discovery-run.json'),
    approved: join(root, 'current.json'),
    decision: join(root, 'release-decision.json'),
  };
}

function materializeRunArtifacts(
  source: ReturnType<typeof paths>,
  run: AdditiveApprovalRun,
  contents: ReadonlyMap<string, string | Uint8Array> = new Map(),
): void {
  for (const artifact of run.artifacts) {
    const artifactPath = resolve(source.root, artifact.path);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(
      artifactPath,
      contents.get(artifact.path) ?? artifactTextFor(run.additions.map((addition) => addition.opportunity)),
    );
  }
}

test('no additions writes only a private no-change decision and leaves public bytes untouched', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    const result = await approveAdditiveSnapshotFile({
      runPath: source.run,
      parentPath: source.parent,
      approvedPath: source.approved,
      decisionPath: source.decision,
      approvedAt: nextApprovedAt,
      nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
    });

    assert.deepEqual(result, { status: 'no-additions', runId: '20260809-additive-unit-test' });
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
    const decision = JSON.parse(readFileSync(source.decision, 'utf8')) as Record<string, any>;
    assert.equal(decision.schemaVersion, 1);
    assert.equal(decision.status, 'no-additions');
    assert.equal(decision.runId, '20260809-additive-unit-test');
    assert.deepEqual(decision.parent, {
      sha256: sha256(parentText),
      snapshotId: parent.snapshotId,
      dataHash: parent.dataHash,
    });
    assert.equal(decision.coverage.rotationDate, '2026-08-09');
    assert.equal(decision.coverage.registryTargetCount, 310);
    assert.equal(decision.coverage.parentExtraTargetCount, 1);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects a decision path that could overwrite an additive input', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.parent,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /release decision path must not equal an additive input/i,
    );
    assert.equal(readFileSync(source.parent, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('keeps the private decision inside the same additive run directory', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);
  const outsideDecision = join(dirname(source.root), 'outside-release-decision.json');

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: outsideDecision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /release decision path.*direct.*additive run directory/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);

    rmSync(source.decision, { force: true });
    const artifactCollision = additiveRun(parent, parentText, []);
    artifactCollision.artifacts[0].path = 'release-decision.json';
    materializeRunArtifacts(source, artifactCollision);
    writeJson(source.run, artifactCollision);
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /decision.*artifact|artifact.*decision/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects a symlinked or inode-aliased decision path before it can replace an input', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    const redirectedDecision = join(source.root, 'redirect', 'current.json');
    symlinkSync(source.root, join(source.root, 'redirect'));
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: redirectedDecision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /decision path.*direct|decision.*symbolic link|decision.*alias/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);

    linkSync(source.approved, source.decision);
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /decision.*alias|decision.*input/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('requires a closed, artifact-backed scope manifest even when there are no additions', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  materializeRunArtifacts(source, run);
  delete (run as unknown as Record<string, unknown>).scopes;
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /scope manifest|scopes/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('derives daily sentinel and registry-rotation coverage from the pinned public inputs', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  const missingSentinel = run.scopes.find((scope) => scope.queue === 'sentinel')!;
  run.scopes = run.scopes.filter((scope) => scope.scopeId !== missingSentinel.scopeId);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /missing priority sentinel root scope/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects a mismatched coverage hash, Shanghai date, or required rotation root before writing', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (run: AdditiveApprovalRun) => void;
    pattern: RegExp;
  }> = [
    {
      name: 'registry hash',
      mutate: (run) => { run.coverage.registrySha256 = '0'.repeat(64); },
      pattern: /registry bytes.*coverage header/i,
    },
    {
      name: 'Shanghai calendar date',
      mutate: (run) => { run.coverage.rotationDate = '2026-08-08'; },
      pattern: /rotationDate.*Asia\/Shanghai/i,
    },
    {
      name: 'registry rotation scope',
      mutate: (run) => {
        const rotation = run.scopes.find((scope) => scope.queue === 'registry-rotation');
        if (rotation === undefined) throw new Error('fixture must include a registry rotation scope');
        run.scopes = run.scopes.filter((scope) => scope.scopeId !== rotation.scopeId);
      },
      pattern: /missing required registry rotation root scope/i,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const source = paths();
      const parent = sealedParent();
      const parentText = writeJson(source.parent, parent);
      writeFileSync(source.approved, parentText, 'utf8');
      const run = additiveRun(parent, parentText, []);
      item.mutate(run);
      materializeRunArtifacts(source, run);
      writeJson(source.run, run);
      try {
        await assert.rejects(
          approveAdditiveSnapshotFile({
            runPath: source.run,
            parentPath: source.parent,
            approvedPath: source.approved,
            decisionPath: source.decision,
            approvedAt: nextApprovedAt,
            nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
          }),
          item.pattern,
        );
        assert.equal(readFileSync(source.approved, 'utf8'), parentText);
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
  }
});

test('records blocked required scopes privately without blocking independent no-additions coverage', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  const blocked = run.scopes.find((scope) => scope.queue === 'sentinel')!;
  blocked.result = 'blocked';
  blocked.reason = 'WAF blocked the official entry during this run';
  blocked.artifactSha256 = null;
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    const result = await approveAdditiveSnapshotFile({
      runPath: source.run,
      parentPath: source.parent,
      approvedPath: source.approved,
      decisionPath: source.decision,
      approvedAt: nextApprovedAt,
      nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
    });
    assert.equal(result.status, 'no-additions');
    const decision = JSON.parse(readFileSync(source.decision, 'utf8')) as Record<string, any>;
    assert.deepEqual(decision.coverage.blockedScopeIds, [blocked.scopeId]);
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('adds only field-evidenced new rows while retaining an elapsed parent row byte-for-byte', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const addition = additionFor(parent);
  const run = additiveRun(parent, parentText, [addition]);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    const result = await approveAdditiveSnapshotFile({
      runPath: source.run,
      parentPath: source.parent,
      approvedPath: source.approved,
      decisionPath: source.decision,
      approvedAt: nextApprovedAt,
      nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
    });

    assert.equal(result.status, 'ready');
    const approved = JSON.parse(readFileSync(source.approved, 'utf8')) as PublicSnapshot;
    assert.equal(approved.previousSnapshotId, parent.snapshotId);
    assert.equal(approved.opportunities.length, 2);
    assert.deepEqual(
      approved.opportunities.find((row) => row.projectId === parent.opportunities[0].projectId),
      parent.opportunities[0],
    );
    assert.deepEqual(
      approved.opportunities.find((row) => row.projectId === addition.projectId),
      addition,
    );
    const decision = JSON.parse(readFileSync(source.decision, 'utf8')) as Record<string, unknown>;
    assert.equal(decision.status, 'ready');
    assert.equal(decision.runId, '20260809-additive-unit-test');
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('uses Unicode code-point ordering for equal-priority additive rows', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const northern = additionFor(parent);
  northern.projectId = '2027|北|计算机学院|夏令营-A';
  const upper = additionFor(parent);
  upper.projectId = '2027|上|计算机学院|夏令营-B';
  const run = additiveRun(parent, parentText, [northern, upper]);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await approveAdditiveSnapshotFile({
      runPath: source.run,
      parentPath: source.parent,
      approvedPath: source.approved,
      decisionPath: source.decision,
      approvedAt: nextApprovedAt,
      nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
    });
    const approved = JSON.parse(readFileSync(source.approved, 'utf8')) as PublicSnapshot;
    assert.deepEqual(
      approved.opportunities
        .filter((row) => row.projectId === northern.projectId || row.projectId === upper.projectId)
        .map((row) => row.projectId),
      [upper.projectId, northern.projectId],
    );
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects duplicate parent IDs and incomplete field evidence before writing public data', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const duplicate = structuredClone(parent.opportunities[0]);
  duplicate.verifiedAt = runScannedAt;
  const run = additiveRun(parent, parentText, [duplicate]);
  materializeRunArtifacts(source, run);
  run.additions[0].evidence.fieldEvidence = [];
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /duplicate.*parent|fieldEvidence/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects an approved-file replacement after the final parent fingerprint check', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, [additionFor(parent)]);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile(
        {
          runPath: source.run,
          parentPath: source.parent,
          approvedPath: source.approved,
          decisionPath: source.decision,
          approvedAt: nextApprovedAt,
          nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
        },
        undefined,
        {
          afterApprovedFingerprintCheck: async () => {
            writeFileSync(source.approved, `${JSON.stringify(sealedParent())}\n`, 'utf8');
          },
        },
      ),
      /changed concurrently/i,
    );
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects artifact path traversal before any private or public write', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  materializeRunArtifacts(source, run);
  run.artifacts[0].path = '../outside-run.html';
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /artifacts\[0\]\.path.*relative|artifacts\[0\]\.path.*parent/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('recomputes artifact bytes and rejects symlinked or tampered evidence files', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const tampered = additiveRun(parent, parentText, []);
  materializeRunArtifacts(source, tampered);
  writeFileSync(join(source.root, tampered.artifacts[0].path), 'tampered artifact', 'utf8');
  writeJson(source.run, tampered);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /artifact.*SHA-256|artifact.*digest/i,
    );

    const symlinked = additiveRun(parent, parentText, []);
    materializeRunArtifacts(source, symlinked);
    const artifactPath = join(source.root, symlinked.artifacts[0].path);
    const externalPath = join(source.root, 'external-official.html');
    writeFileSync(externalPath, defaultArtifactText, 'utf8');
    rmSync(artifactPath);
    symlinkSync(externalPath, artifactPath);
    writeJson(source.run, symlinked);

    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /artifact.*symbolic link|artifact.*symlink/i,
    );

    rmSync(source.artifacts, { recursive: true, force: true });
    const externalArtifactDirectory = join(source.root, 'external-artifacts');
    mkdirSync(externalArtifactDirectory);
    writeFileSync(join(externalArtifactDirectory, 'official.html'), defaultArtifactText, 'utf8');
    symlinkSync(externalArtifactDirectory, source.artifacts);
    writeJson(source.run, symlinked);

    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /artifact.*symbolic link|artifact.*symlink/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('requires every published field quote to occur in its declared artifact text', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, [additionFor(parent)]);
  materializeRunArtifacts(source, run);
  run.additions[0].evidence.fieldEvidence[0].quote = '不在证据文件中的引文';
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /quote.*artifact|quote.*occur/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('requires each field quote to carry that field’s source value', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, [additionFor(parent)]);
  materializeRunArtifacts(source, run);
  run.additions[0].evidence.fieldEvidence[0].quote = '官方招生通知原文';
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /quote.*source value|quote.*field value/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects an unrelated non-institutional host even when every self-declared URL agrees', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const addition = additionFor(parent);
  addition.website = 'https://unrelated.example.org/not-a-school-notice';
  addition.discoverySources[0].url = addition.website;
  const run = additiveRun(parent, parentText, [addition]);
  run.scopes.find((scope) => scope.scopeId === 'scope-root')!.entryUrl = addition.website;
  run.artifacts[0].url = addition.website;
  run.additions[0].evidence.officialUrl = addition.website;
  for (const fieldEvidence of run.additions[0].evidence.fieldEvidence) {
    fieldEvidence.sourceUrl = addition.website;
  }
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /official.*institutional|official.*host|official.*domain/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('requires a plausible institutional primary source to identify the same school', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const addition = additionFor(parent);
  addition.website = 'https://other.example.edu.cn/notice';
  addition.discoverySources[0].url = addition.website;
  const run = additiveRun(parent, parentText, [addition]);
  const primaryText = '<html><body>大学招生通知</body></html>';
  const primarySha256 = sha256(primaryText);
  const fieldText = artifactTextFor([addition]);
  const fieldSha256 = sha256(fieldText);
  const fieldUrl = 'https://child.example.edu.cn/attachment';
  run.artifacts = [
    {
      path: 'artifacts/primary.html',
      sha256: primarySha256,
      url: addition.website,
      contentType: 'text/html',
      fetchedAt: runScannedAt,
      extractedTextArtifactSha256: null,
    },
    {
      path: 'artifacts/child.html',
      sha256: fieldSha256,
      url: fieldUrl,
      contentType: 'text/html',
      fetchedAt: runScannedAt,
      extractedTextArtifactSha256: null,
    },
  ];
  for (const scope of run.scopes) scope.artifactSha256 = primarySha256;
  run.additions[0].evidence.artifactSha256 = primarySha256;
  run.additions[0].evidence.officialUrl = addition.website;
  for (const fieldEvidence of run.additions[0].evidence.fieldEvidence) {
    fieldEvidence.artifactSha256 = fieldSha256;
    fieldEvidence.sourceUrl = fieldUrl;
  }
  materializeRunArtifacts(source, run, new Map([
    ['artifacts/primary.html', primaryText],
    ['artifacts/child.html', fieldText],
  ]));
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /primary official artifact.*school/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects a normalized deadline whose source quotation names a different calendar date', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const addition = additionFor(parent);
  addition.deadline = '2026-12-31T23:59:00+08:00';
  addition.deadlineEpochMs = Date.parse(addition.deadline);
  const run = additiveRun(parent, parentText, [addition]);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /deadline.*source date|deadline.*original/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('accepts a PDF quote only through its declared, file-backed extracted text artifact', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const addition = additionFor(parent);
  const run = additiveRun(parent, parentText, [addition]);
  const pdfBytes = Buffer.from('%PDF-1.7\nfixture PDF bytes\n', 'utf8');
  const extractedText = artifactTextFor([addition]);
  const pdfSha256 = sha256(pdfBytes);
  const extractedTextSha256 = sha256(extractedText);
  run.artifacts = [
    {
      path: 'artifacts/official.pdf',
      sha256: pdfSha256,
      url: addition.website,
      contentType: 'application/pdf',
      fetchedAt: runScannedAt,
      extractedTextArtifactSha256: extractedTextSha256,
    },
    {
      path: 'artifacts/official.pdf.txt',
      sha256: extractedTextSha256,
      url: addition.website,
      contentType: 'text/plain; charset=utf-8',
      fetchedAt: runScannedAt,
      extractedTextArtifactSha256: null,
    },
  ];
  run.scopes.find((scope) => scope.scopeId === 'scope-root')!.artifactSha256 = pdfSha256;
  run.additions[0].evidence.artifactSha256 = pdfSha256;
  for (const fieldEvidence of run.additions[0].evidence.fieldEvidence) {
    fieldEvidence.artifactSha256 = pdfSha256;
  }
  materializeRunArtifacts(source, run, new Map([
    ['artifacts/official.pdf', pdfBytes],
    ['artifacts/official.pdf.txt', extractedText],
  ]));
  writeJson(source.run, run);

  try {
    const result = await approveAdditiveSnapshotFile({
      runPath: source.run,
      parentPath: source.parent,
      approvedPath: source.approved,
      decisionPath: source.decision,
      approvedAt: nextApprovedAt,
      nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
    });
    assert.equal(result.status, 'ready');
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects a binary primary artifact that is not explicitly bound to the text used for fields', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const addition = additionFor(parent);
  const run = additiveRun(parent, parentText, [addition]);
  const pdfBytes = Buffer.from('%PDF-1.7\nunlinked primary artifact\n', 'utf8');
  const pdfSha256 = sha256(pdfBytes);
  const extractedText = artifactTextFor([addition]);
  const extractedTextSha256 = sha256(extractedText);
  run.artifacts = [
    {
      path: 'artifacts/official.pdf',
      sha256: pdfSha256,
      url: addition.website,
      contentType: 'application/pdf',
      fetchedAt: runScannedAt,
      extractedTextArtifactSha256: null,
    },
    {
      path: 'artifacts/unlinked.txt',
      sha256: extractedTextSha256,
      url: addition.website,
      contentType: 'text/plain; charset=utf-8',
      fetchedAt: runScannedAt,
      extractedTextArtifactSha256: null,
    },
  ];
  run.scopes.find((scope) => scope.scopeId === 'scope-root')!.artifactSha256 = pdfSha256;
  run.additions[0].evidence.artifactSha256 = pdfSha256;
  for (const fieldEvidence of run.additions[0].evidence.fieldEvidence) {
    fieldEvidence.artifactSha256 = extractedTextSha256;
  }
  materializeRunArtifacts(source, run, new Map([
    ['artifacts/official.pdf', pdfBytes],
    ['artifacts/unlinked.txt', extractedText],
  ]));
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: nextApprovedAt,
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /primary artifact.*extracted|binary primary.*text/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('rejects an approvedAt timestamp that is in the future', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, [additionFor(parent)]);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: '2026-08-09T09:01:00.000Z',
        nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
      }),
      /approvedAt.*future/i,
    );
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('records an eligible private decision, not ready, when the public atomic write fails', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, [additionFor(parent)]);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assert.rejects(
      approveAdditiveSnapshotFile(
        {
          runPath: source.run,
          parentPath: source.parent,
          approvedPath: source.approved,
          decisionPath: source.decision,
          approvedAt: nextApprovedAt,
          nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
        },
        undefined,
        {
          beforeRename: async () => {
            throw new Error('simulated public atomic write failure');
          },
        },
      ),
      /simulated public atomic write failure/i,
    );
    const decision = JSON.parse(readFileSync(source.decision, 'utf8')) as Record<string, unknown>;
    assert.equal(decision.status, 'eligible');
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('daily additive approval has a dedicated narrow CLI instead of the legacy replay command', () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  const currentRunTime = new Date().toISOString();
  run.startedAt = currentRunTime;
  run.finishedAt = currentRunTime;
  for (const scope of run.scopes) scope.checkedAt = currentRunTime;
  run.artifacts[0].fetchedAt = currentRunTime;
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.equal(
      packageJson.scripts?.['snapshot:approve-additive'],
      'tsx scripts/snapshot/approve-additive-snapshot.ts',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/snapshot/approve-additive-snapshot.ts',
        '--run',
        source.run,
        '--parent',
        source.parent,
        '--approved',
        source.approved,
        '--decision',
        source.decision,
        '--approved-at',
        currentRunTime,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'no-additions',
      runId: '20260809-additive-unit-test',
    });
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});
