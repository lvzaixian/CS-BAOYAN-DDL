import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
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
const fixedDiscoveryCheckIds = [
  'shenyanpai-profile',
  'shenyanpai-summer-camp',
  'shenyanpai-pre-recommend',
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function shanghaiSourceYear(checkedAt: string): string {
  const year = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).formatToParts(new Date(checkedAt)).find((part) => part.type === 'year')?.value;
  if (year === undefined) throw new Error('fixture could not derive the Shanghai source year');
  return year;
}

function fixedDiscoveryArtifactContent(checkId: string): string {
  return `<html><body>GitHub fixed discovery check: ${checkId}</body></html>`;
}

function fixedDiscoveryArtifactFixtures(checkedAt: string) {
  const year = shanghaiSourceYear(checkedAt);
  const checks = [
    {
      checkId: 'shenyanpai-profile',
      url: 'https://github.com/shenyanpai',
    },
    {
      checkId: 'shenyanpai-summer-camp',
      url: `https://github.com/shenyanpai/awesome-summer-camp-${year}`,
    },
    {
      checkId: 'shenyanpai-pre-recommend',
      url: `https://github.com/shenyanpai/awesome-pre-recommend-${year}`,
    },
  ];
  return checks.map(({ checkId, url }) => {
    const content = fixedDiscoveryArtifactContent(checkId);
    const artifactSha256 = sha256(content);
    return {
      check: {
        checkId,
        url,
        checkedAt,
        result: 'checked' as const,
        artifactSha256,
        reason: null,
      },
      artifact: {
        path: `artifacts/fixed-discovery-${checkId}.html`,
        sha256: artifactSha256,
        url,
        contentType: 'text/html',
        fetchedAt: checkedAt,
        extractedTextArtifactSha256: null,
      },
    };
  });
}

function fixedDiscoveryArtifactContents(): Map<string, string> {
  return new Map(fixedDiscoveryCheckIds.map((checkId) => {
    const content = fixedDiscoveryArtifactContent(checkId);
    return [sha256(content), content];
  }));
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
  const fixedDiscoveryArtifacts = fixedDiscoveryArtifactFixtures(runScannedAt);
  const entryUrl = additions[0]?.website ?? 'https://cs-new.example.edu.cn/admissions/summer-camp';
  const school = additions[0]?.name ?? parent.opportunities[0].name;
  return {
    schemaVersion: 3,
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
    fixedDiscoveryChecks: fixedDiscoveryArtifacts.map((item) => item.check),
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
      ...fixedDiscoveryArtifacts.map((item) => item.artifact),
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
  const fixedArtifactContents = fixedDiscoveryArtifactContents();
  for (const artifact of run.artifacts) {
    if (fixedArtifactContents.has(artifact.sha256)) {
      artifact.fetchedAt = run.finishedAt;
    }
    const artifactPath = resolve(source.root, artifact.path);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(
      artifactPath,
      contents.get(artifact.path)
        ?? fixedArtifactContents.get(artifact.sha256)
        ?? artifactTextFor(run.additions.map((addition) => addition.opportunity)),
    );
  }
}

function fixedDiscoveryCheck(
  run: AdditiveApprovalRun,
  checkId: typeof fixedDiscoveryCheckIds[number],
) {
  const check = run.fixedDiscoveryChecks.find((candidate) => candidate.checkId === checkId);
  if (check === undefined) throw new Error(`fixture must include ${checkId}`);
  return check;
}

function fixedDiscoveryArtifact(run: AdditiveApprovalRun, artifactSha256: string) {
  const artifact = run.artifacts.find((candidate) => candidate.sha256 === artifactSha256);
  if (artifact === undefined) throw new Error('fixture must include the fixed discovery artifact');
  return artifact;
}

function blockFixedDiscoveryCheck(
  run: AdditiveApprovalRun,
  checkId: typeof fixedDiscoveryCheckIds[number],
): void {
  const check = fixedDiscoveryCheck(run, checkId);
  if (check.artifactSha256 === null) throw new Error('fixture fixed discovery check must be checked');
  const artifactSha256 = check.artifactSha256;
  check.result = 'blocked';
  check.artifactSha256 = null;
  check.reason = 'network timeout while reading the fixed discovery source';
  run.artifacts = run.artifacts.filter((artifact) => artifact.sha256 !== artifactSha256);
}

function fixedDiscoveryArtifacts(run: AdditiveApprovalRun) {
  const sha256s = new Set(
    run.fixedDiscoveryChecks
      .map((check) => check.artifactSha256)
      .filter((artifactSha256): artifactSha256 is string => artifactSha256 !== null),
  );
  return run.artifacts.filter((artifact) => sha256s.has(artifact.sha256));
}

async function assertRejectedBeforeApproval(
  source: ReturnType<typeof paths>,
  parentText: string,
  operation: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  await assert.rejects(operation, expected);
  assert.equal(readFileSync(source.approved, 'utf8'), parentText);
  assert.equal(existsSync(source.decision), false);
}

function approve(source: ReturnType<typeof paths>) {
  return approveAdditiveSnapshotFile({
    runPath: source.run,
    parentPath: source.parent,
    approvedPath: source.approved,
    decisionPath: source.decision,
    approvedAt: nextApprovedAt,
    nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
  });
}

test('rejects a fixed discovery URL mutation before writing a private decision', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  const profile = fixedDiscoveryCheck(run, 'shenyanpai-profile');
  profile.url = 'https://github.com/not-shenyanpai';
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assertRejectedBeforeApproval(
      source,
      parentText,
      () => approve(source),
      /fixed discovery check.*URL must match/i,
    );
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(
      run.fixedDiscoveryChecks.map((check) => check.checkId).sort(),
      [...fixedDiscoveryCheckIds].sort(),
    );
    assert.equal(
      new Set(run.fixedDiscoveryChecks.map((check) => check.artifactSha256)).size,
      fixedDiscoveryCheckIds.length,
    );
    for (const check of run.fixedDiscoveryChecks) {
      assert.notEqual(check.artifactSha256, null);
      const artifact = run.artifacts.find((candidate) => candidate.sha256 === check.artifactSha256);
      assert.notEqual(artifact, undefined);
      assert.equal(artifact!.url, check.url);
    }
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('requires exactly the three fixed Shenyanpai discovery check IDs before a decision', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (run: AdditiveApprovalRun) => void;
    expected: RegExp;
  }> = [
    {
      name: 'v2 schema',
      mutate: (run) => { (run as unknown as { schemaVersion: number }).schemaVersion = 2; },
      expected: /schemaVersion must equal 3/i,
    },
    {
      name: 'missing fixedDiscoveryChecks',
      mutate: (run) => {
        delete (run as unknown as { fixedDiscoveryChecks?: unknown }).fixedDiscoveryChecks;
      },
      expected: /fixedDiscoveryChecks.*required/i,
    },
    {
      name: 'missing required ID',
      mutate: (run) => { run.fixedDiscoveryChecks.pop(); },
      expected: /fixed discovery checks.*exactly/i,
    },
    {
      name: 'duplicate ID',
      mutate: (run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-summer-camp').checkId = 'shenyanpai-profile';
      },
      expected: /fixed discovery check.*duplicated/i,
    },
    {
      name: 'unexpected ID',
      mutate: (run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-summer-camp').checkId = 'other-source';
      },
      expected: /fixed discovery check.*unexpected/i,
    },
    {
      name: 'missing required field',
      mutate: (run) => {
        delete (fixedDiscoveryCheck(run, 'shenyanpai-profile') as unknown as { url?: unknown }).url;
      },
      expected: /fixedDiscoveryChecks.*url.*required/i,
    },
    {
      name: 'invalid timestamp',
      mutate: (run) => { fixedDiscoveryCheck(run, 'shenyanpai-profile').checkedAt = 'not-a-timestamp'; },
      expected: /fixedDiscoveryChecks.*checkedAt.*valid ISO timestamp/i,
    },
    {
      name: 'invalid SHA-256',
      mutate: (run) => { fixedDiscoveryCheck(run, 'shenyanpai-profile').artifactSha256 = 'not-a-sha'; },
      expected: /fixedDiscoveryChecks.*artifactSha256.*SHA-256/i,
    },
    {
      name: 'non-string artifactSha256',
      mutate: (run) => {
        (fixedDiscoveryCheck(run, 'shenyanpai-profile') as unknown as { artifactSha256: unknown }).artifactSha256 = 1;
      },
      expected: /fixedDiscoveryChecks.*artifactSha256.*string or null/i,
    },
    {
      name: 'non-string reason',
      mutate: (run) => {
        (fixedDiscoveryCheck(run, 'shenyanpai-profile') as unknown as { reason: unknown }).reason = 1;
      },
      expected: /fixedDiscoveryChecks.*reason.*string or null/i,
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
        await assertRejectedBeforeApproval(source, parentText, () => approve(source), item.expected);
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects a fixed discovery check URL with the wrong owner, repository, year, or query', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (run: AdditiveApprovalRun) => void;
  }> = [
    {
      name: 'owner',
      mutate: (run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-summer-camp').url =
          'https://github.com/other/awesome-summer-camp-2026';
      },
    },
    {
      name: 'repository',
      mutate: (run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-summer-camp').url =
          'https://github.com/shenyanpai/not-the-summer-camp-2026';
      },
    },
    {
      name: 'year',
      mutate: (run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-pre-recommend').url =
          'https://github.com/shenyanpai/awesome-pre-recommend-2025';
      },
    },
    {
      name: 'query',
      mutate: (run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-pre-recommend').url += '?spoof=1';
      },
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
        await assertRejectedBeforeApproval(
          source,
          parentText,
          () => approve(source),
          /fixed discovery check.*URL must match/i,
        );
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
  }
});

test('enforces checked and blocked fixed discovery check coupling before a decision', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (run: AdditiveApprovalRun) => void;
    expected: RegExp;
  }> = [
    {
      name: 'checked without an artifact',
      mutate: (run) => { fixedDiscoveryCheck(run, 'shenyanpai-profile').artifactSha256 = null; },
      expected: /fixed discovery check.*checked.*artifact/i,
    },
    {
      name: 'checked with a reason',
      mutate: (run) => { fixedDiscoveryCheck(run, 'shenyanpai-profile').reason = 'unexpected'; },
      expected: /fixed discovery check.*checked.*reason/i,
    },
    {
      name: 'blocked with an artifact',
      mutate: (run) => {
        const check = fixedDiscoveryCheck(run, 'shenyanpai-profile');
        check.result = 'blocked';
        check.reason = 'timeout';
      },
      expected: /fixed discovery check.*blocked.*artifact/i,
    },
    {
      name: 'blocked without a reason',
      mutate: (run) => {
        const check = fixedDiscoveryCheck(run, 'shenyanpai-profile');
        check.result = 'blocked';
        check.artifactSha256 = null;
      },
      expected: /fixed discovery check.*blocked.*reason/i,
    },
    {
      name: 'blocked with a blank reason',
      mutate: (run) => {
        const check = fixedDiscoveryCheck(run, 'shenyanpai-profile');
        check.result = 'blocked';
        check.artifactSha256 = null;
        check.reason = '  ';
      },
      expected: /fixed discovery check.*blocked.*reason/i,
    },
    {
      name: 'unsupported result',
      mutate: (run) => {
        (fixedDiscoveryCheck(run, 'shenyanpai-profile') as unknown as { result: string }).result = 'skipped';
      },
      expected: /fixed discovery check.*unsupported result/i,
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
        await assertRejectedBeforeApproval(source, parentText, () => approve(source), item.expected);
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
  }
});

test('requires every checked fixed discovery check to bind a unique verified text artifact', async (t) => {
  const cases: Array<{
    name: string;
    prepare: (source: ReturnType<typeof paths>, run: AdditiveApprovalRun) => ReadonlyMap<string, string | Uint8Array> | undefined;
    afterMaterialize?: (source: ReturnType<typeof paths>, run: AdditiveApprovalRun) => void;
    expected: RegExp;
  }> = [
    {
      name: 'missing manifest artifact',
      prepare: (_source, run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-profile').artifactSha256 = sha256('missing fixed artifact');
        return undefined;
      },
      expected: /fixed discovery check.*(?:artifact.*missing|missing artifact)/i,
    },
    {
      name: 'wrong artifact URL',
      prepare: (_source, run) => {
        const check = fixedDiscoveryCheck(run, 'shenyanpai-profile');
        fixedDiscoveryArtifact(run, check.artifactSha256!).url = 'https://github.com/shenyanpai/other';
        return undefined;
      },
      expected: /fixed discovery check.*artifact URL must match/i,
    },
    {
      name: 'binary artifact',
      prepare: (_source, run) => {
        const check = fixedDiscoveryCheck(run, 'shenyanpai-profile');
        const artifact = fixedDiscoveryArtifact(run, check.artifactSha256!);
        const bytes = Buffer.from('%PDF-1.7\nfixed discovery binary artifact\n', 'utf8');
        const artifactSha256 = sha256(bytes);
        check.artifactSha256 = artifactSha256;
        artifact.sha256 = artifactSha256;
        artifact.contentType = 'application/pdf';
        return new Map([[artifact.path, bytes]]);
      },
      expected: /fixed discovery check.*readable UTF-8 text/i,
    },
    {
      name: 'checked before the run',
      prepare: (_source, run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-profile').checkedAt = '2026-08-09T08:29:59.999Z';
        return undefined;
      },
      expected: /fixed discovery check.*outside the run window/i,
    },
    {
      name: 'checked after the run',
      prepare: (_source, run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-profile').checkedAt = '2026-08-09T08:30:00.001Z';
        return undefined;
      },
      expected: /fixed discovery check.*outside the run window/i,
    },
    {
      name: 'shared checked artifact SHA-256',
      prepare: (_source, run) => {
        fixedDiscoveryCheck(run, 'shenyanpai-summer-camp').artifactSha256 =
          fixedDiscoveryCheck(run, 'shenyanpai-profile').artifactSha256;
        return undefined;
      },
      expected: /fixed discovery check.*reuse.*SHA-256/i,
    },
    {
      name: 'missing fixed artifact file',
      prepare: () => undefined,
      afterMaterialize: (source, run) => {
        const check = fixedDiscoveryCheck(run, 'shenyanpai-profile');
        rmSync(join(source.root, fixedDiscoveryArtifact(run, check.artifactSha256!).path));
      },
      expected: /ENOENT|additive artifact/i,
    },
    {
      name: 'tampered fixed artifact file',
      prepare: () => undefined,
      afterMaterialize: (source, run) => {
        const check = fixedDiscoveryCheck(run, 'shenyanpai-profile');
        writeFileSync(
          join(source.root, fixedDiscoveryArtifact(run, check.artifactSha256!).path),
          'tampered fixed discovery artifact',
          'utf8',
        );
      },
      expected: /additive artifact.*SHA-256|additive artifact.*digest/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const source = paths();
      const parent = sealedParent();
      const parentText = writeJson(source.parent, parent);
      writeFileSync(source.approved, parentText, 'utf8');
      const run = additiveRun(parent, parentText, []);
      const contents = item.prepare(source, run);
      materializeRunArtifacts(source, run, contents);
      item.afterMaterialize?.(source, run);
      writeJson(source.run, run);

      try {
        await assertRejectedBeforeApproval(source, parentText, () => approve(source), item.expected);
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
  }
});

test('allows each fixed discovery check to be blocked without blocking an official addition', async (t) => {
  for (const checkId of fixedDiscoveryCheckIds) {
    await t.test(checkId, async () => {
      const source = paths();
      const parent = sealedParent();
      const parentText = writeJson(source.parent, parent);
      writeFileSync(source.approved, parentText, 'utf8');
      const run = additiveRun(parent, parentText, [additionFor(parent)]);
      blockFixedDiscoveryCheck(run, checkId);
      materializeRunArtifacts(source, run);
      writeJson(source.run, run);

      try {
        const result = await approve(source);
        assert.equal(result.status, 'ready');
        const decision = JSON.parse(readFileSync(source.decision, 'utf8')) as Record<string, unknown>;
        assert.equal(decision.status, 'ready');
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
  }
});

test('allows an all-blocked fixed discovery run to record a normal no-additions decision', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  for (const checkId of fixedDiscoveryCheckIds) blockFixedDiscoveryCheck(run, checkId);
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    const result = await approve(source);
    assert.deepEqual(result, { status: 'no-additions', runId: '20260809-additive-unit-test' });
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
    const decision = JSON.parse(readFileSync(source.decision, 'utf8')) as Record<string, unknown>;
    assert.equal(decision.status, 'no-additions');
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('derives the fixed source repository year from finishedAt in Asia/Shanghai', async () => {
  const source = paths();
  const parent = sealedParent();
  const parentText = writeJson(source.parent, parent);
  writeFileSync(source.approved, parentText, 'utf8');
  const run = additiveRun(parent, parentText, []);
  const boundary = '2026-12-31T16:00:00.000Z';
  run.startedAt = boundary;
  run.finishedAt = boundary;
  for (const scope of run.scopes) scope.checkedAt = boundary;
  for (const artifact of run.artifacts) artifact.fetchedAt = boundary;
  for (const check of run.fixedDiscoveryChecks) check.checkedAt = boundary;
  fixedDiscoveryCheck(run, 'shenyanpai-summer-camp').url =
    'https://github.com/shenyanpai/awesome-summer-camp-2026';
  materializeRunArtifacts(source, run);
  writeJson(source.run, run);

  try {
    await assertRejectedBeforeApproval(
      source,
      parentText,
      () => approveAdditiveSnapshotFile({
        runPath: source.run,
        parentPath: source.parent,
        approvedPath: source.approved,
        decisionPath: source.decision,
        approvedAt: boundary,
        nowMs: Date.parse('2027-01-01T00:00:00.001Z'),
      }),
      /fixed discovery check.*awesome-summer-camp-2027/i,
    );
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('keeps direct GitHub URLs out of every additive public evidence route', async (t) => {
  const cases: Array<{
    name: string;
    prepareAddition?: (addition: PublicSnapshot['opportunities'][number]) => void;
    prepareRun?: (
      run: AdditiveApprovalRun,
      addition: PublicSnapshot['opportunities'][number],
    ) => ReadonlyMap<string, string | Uint8Array> | undefined;
    expected: RegExp;
  }> = [
    {
      name: 'officialUrl',
      prepareRun: (run) => {
        run.additions[0].evidence.officialUrl = 'https://github.com/shenyanpai';
        return undefined;
      },
      expected: /officialUrl.*institutional official host|officialUrl.*approved official platform/i,
    },
    {
      name: 'website',
      prepareAddition: (addition) => {
        addition.website = 'https://github.com/shenyanpai';
        addition.discoverySources[0].url = addition.website;
      },
      expected: /denied discovery host.*official website|denied discovery host.*official source/i,
    },
    {
      name: 'primary artifact URL',
      prepareRun: (run, addition) => {
        run.artifacts[0].url = 'https://github.com/shenyanpai';
        const text = `${artifactTextFor([addition])}\nseparate official scope artifact`;
        const artifactSha256 = sha256(text);
        const path = 'artifacts/official-scope.html';
        run.artifacts.push({
          path,
          sha256: artifactSha256,
          url: addition.website,
          contentType: 'text/html',
          fetchedAt: runScannedAt,
          extractedTextArtifactSha256: null,
        });
        for (const scope of run.scopes) scope.artifactSha256 = artifactSha256;
        return new Map([[path, text]]);
      },
      expected: /primary artifact.*officialUrl/i,
    },
    {
      name: 'field evidence source and artifact URL',
      prepareRun: (run, addition) => {
        const text = `${artifactTextFor([addition])}\nseparate GitHub field artifact`;
        const artifactSha256 = sha256(text);
        const path = 'artifacts/github-field.html';
        const url = 'https://github.com/shenyanpai';
        run.artifacts.push({
          path,
          sha256: artifactSha256,
          url,
          contentType: 'text/html',
          fetchedAt: runScannedAt,
          extractedTextArtifactSha256: null,
        });
        run.additions[0].evidence.fieldEvidence[0].artifactSha256 = artifactSha256;
        run.additions[0].evidence.fieldEvidence[0].sourceUrl = url;
        return new Map([[path, text]]);
      },
      expected: /field evidence sourceUrl.*institutional official host|field evidence sourceUrl.*approved official platform/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const source = paths();
      const parent = sealedParent();
      const parentText = writeJson(source.parent, parent);
      writeFileSync(source.approved, parentText, 'utf8');
      const addition = additionFor(parent);
      item.prepareAddition?.(addition);
      const run = additiveRun(parent, parentText, [addition]);
      const contents = item.prepareRun?.(run, addition);
      materializeRunArtifacts(source, run, contents);
      writeJson(source.run, run);

      try {
        await assertRejectedBeforeApproval(source, parentText, () => approve(source), item.expected);
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects every GitHub host from additive other-discovery sources before a decision', async (t) => {
  const urls = [
    'https://github.com/shenyanpai',
    'https://gist.github.com/example',
    'https://raw.githubusercontent.com/shenyanpai/example/main/README.md',
  ];
  for (const url of urls) {
    await t.test(url, async () => {
      const source = paths();
      const parent = sealedParent();
      const parentText = writeJson(source.parent, parent);
      writeFileSync(source.approved, parentText, 'utf8');
      const addition = additionFor(parent);
      addition.discoverySources.push({
        kind: 'other-discovery',
        label: 'Shenyanpai discovery clue',
        url,
      });
      const run = additiveRun(parent, parentText, [addition]);
      materializeRunArtifacts(source, run);
      writeJson(source.run, run);

      try {
        await assertRejectedBeforeApproval(
          source,
          parentText,
          () => approve(source),
          /must not expose a GitHub discovery source/i,
        );
      } finally {
        rmSync(source.root, { recursive: true, force: true });
      }
    });
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
  assert.equal(
    new Set(run.fixedDiscoveryChecks.map((check) => check.artifactSha256)).size,
    fixedDiscoveryCheckIds.length,
  );
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
  const fixedArtifacts = fixedDiscoveryArtifacts(run);
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
    ...fixedArtifacts,
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
  const fixedArtifacts = fixedDiscoveryArtifacts(run);
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
    ...fixedArtifacts,
  ];
  for (const scope of run.scopes) scope.artifactSha256 = pdfSha256;
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
  const fixedArtifacts = fixedDiscoveryArtifacts(run);
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
    ...fixedArtifacts,
  ];
  for (const scope of run.scopes) scope.artifactSha256 = pdfSha256;
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
  for (const check of run.fixedDiscoveryChecks) check.checkedAt = currentRunTime;
  for (const artifact of run.artifacts) artifact.fetchedAt = currentRunTime;
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
