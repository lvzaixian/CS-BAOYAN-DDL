import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertReadableEvidenceArtifactsCovered,
  buildEvidenceArtifactManifest,
  parseEvidenceArtifactManifest,
  verifyEvidenceArtifactManifest,
  type EvidenceArtifactManifest,
} from '../scripts/snapshot/evidence-artifact-manifest.js';
import type { ScanBundle } from '../scripts/snapshot/scan-release-contract.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function validManifest(): EvidenceArtifactManifest {
  return {
    schemaVersion: 1,
    runId: '20260729-evidence-artifacts',
    artifacts: [
      {
        relativePath: 'official/pages/notice.html',
        sha256: SHA_A,
        sizeBytes: 123,
      },
    ],
  };
}

function manifestWithPaths(...relativePaths: string[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: '20260729-evidence-artifacts',
    artifacts: relativePaths.map((relativePath, index) => ({
      relativePath,
      sha256: index % 2 === 0 ? SHA_A : SHA_B,
      sizeBytes: index,
    })),
  };
}

function bundleForCoverage(): ScanBundle {
  return {
    schemaVersion: 2,
    runId: '20260729-evidence-artifacts',
    scanMode: 'full',
    scanStartedAt: '2026-07-29T08:00:00.000Z',
    scanFinishedAt: '2026-07-29T08:30:00.000Z',
    candidateBase: {
      type: 'public-approved-snapshot',
      url: 'https://ddl.meta-mind.cn/data/current.json',
      sha256: 'd'.repeat(64),
      snapshotId: '2026-07-29T07:00:00.000Z-123456789abc',
      dataHash: 'e'.repeat(64),
      privateParentCandidateUsed: false,
    },
    registry: {
      sha256: 'f'.repeat(64),
      institutionCount: 1,
    },
    pendingLedger: {
      generation: 0,
      sha256: '1'.repeat(64),
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
        artifactSha256: SHA_A,
      },
      {
        name: 'BoardCaster',
        url: 'https://boardcaster.net/',
        status: 'blocked',
        pagesChecked: 0,
        checkedAt: '2026-07-29T08:11:00.000Z',
        artifactSha256: SHA_C,
        error: 'access denied',
      },
    ],
    scopeItems: [],
    evidenceRecords: [
      {
        evidenceId: 'evidence:hit',
        scopeItemId: 'scope:test',
        school: '测试大学',
        region: '华东',
        kind: 'college-notice',
        url: 'https://cs.test.edu.cn/notices/1',
        result: 'hit',
        checkedAt: '2026-07-29T08:20:00.000Z',
        artifactSha256: SHA_B,
        query: '测试大学 2027 推免',
        discoveredScopeItemIds: [],
      },
      {
        evidenceId: 'evidence:no-current-notice',
        scopeItemId: 'scope:test',
        school: '测试大学',
        region: '华东',
        kind: 'graduate-admissions',
        url: 'https://grad.test.edu.cn/admissions',
        result: 'no-current-notice',
        checkedAt: '2026-07-29T08:21:00.000Z',
        artifactSha256: SHA_B,
        query: '测试大学 2027 推免',
        discoveredScopeItemIds: [],
      },
      {
        evidenceId: 'evidence:blocked',
        scopeItemId: 'scope:test',
        school: '测试大学',
        region: '华东',
        kind: 'application-system',
        url: 'https://apply.test.edu.cn/',
        result: 'blocked',
        checkedAt: '2026-07-29T08:22:00.000Z',
        error: 'login required',
        query: '测试大学 2027 推免报名',
        discoveredScopeItemIds: [],
      },
    ],
    projectObservations: [],
    pendingUpdates: [],
    exclusions: [],
  };
}

test('parses only the exact evidence artifact manifest v1 schema', () => {
  assert.deepEqual(parseEvidenceArtifactManifest(validManifest()), validManifest());

  assert.throws(
    () => parseEvidenceArtifactManifest({ ...validManifest(), schemaVersion: 2 }),
    /schemaVersion must be 1/,
  );
  assert.throws(
    () => parseEvidenceArtifactManifest({ ...validManifest(), unexpected: true }),
    /evidence artifact manifest\.unexpected is not allowed/,
  );
  assert.throws(
    () => parseEvidenceArtifactManifest({ ...validManifest(), runId: '   ' }),
    /runId must be a non-empty string/,
  );
  assert.throws(
    () => parseEvidenceArtifactManifest({ ...validManifest(), artifacts: {} }),
    /artifacts must be an array/,
  );

  const unknownArtifact = structuredClone(validManifest()) as unknown as Record<
    string,
    unknown
  >;
  (
    unknownArtifact.artifacts as Array<Record<string, unknown>>
  )[0].unexpected = true;
  assert.throws(
    () => parseEvidenceArtifactManifest(unknownArtifact),
    /artifacts\[0\]\.unexpected is not allowed/,
  );

  const malformedDigest = structuredClone(validManifest()) as unknown as Record<
    string,
    unknown
  >;
  (malformedDigest.artifacts as Array<Record<string, unknown>>)[0].sha256 =
    SHA_A.toUpperCase();
  assert.throws(
    () => parseEvidenceArtifactManifest(malformedDigest),
    /artifacts\[0\]\.sha256 must be a lowercase SHA-256 digest/,
  );

  const malformedSize = structuredClone(validManifest()) as unknown as Record<
    string,
    unknown
  >;
  (malformedSize.artifacts as Array<Record<string, unknown>>)[0].sizeBytes = 1.5;
  assert.throws(
    () => parseEvidenceArtifactManifest(malformedSize),
    /artifacts\[0\]\.sizeBytes must be a non-negative safe integer/,
  );
});

test('rejects unsafe, empty, duplicate, and colliding artifact paths', () => {
  for (const relativePath of [
    '',
    '   ',
    '/tmp/notice.html',
    'C:\\temp\\notice.html',
    '\\\\server\\share\\notice.html',
    '../notice.html',
    'official/../notice.html',
    'official\\..\\notice.html',
  ]) {
    assert.throws(
      () => parseEvidenceArtifactManifest(manifestWithPaths(relativePath)),
      /relativePath/,
      relativePath,
    );
  }

  assert.throws(
    () =>
      parseEvidenceArtifactManifest(
        manifestWithPaths('official/page.html', 'official/page.html'),
      ),
    /duplicate relativePath/,
  );
  assert.throws(
    () =>
      parseEvidenceArtifactManifest(
        manifestWithPaths('official/café.html', 'official/cafe\u0301.html'),
      ),
    /Unicode normalization collision/,
  );
  assert.throws(
    () =>
      parseEvidenceArtifactManifest(
        manifestWithPaths('official/page.html', 'official/./page.html'),
      ),
    /path normalization collision/,
  );
  assert.throws(
    () =>
      parseEvidenceArtifactManifest(
        manifestWithPaths('official/page.html', 'official\\page.html'),
      ),
    /path normalization collision/,
  );
});

test('builds a deterministic manifest from the real artifact bytes', async (t) => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'evidence-artifacts-build-'));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  await mkdir(join(artifactRoot, 'official', 'pages'), { recursive: true });
  const noticeBytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  const summaryBytes = Buffer.from('招生证据\n', 'utf8');
  await writeFile(
    join(artifactRoot, 'official', 'pages', 'notice.bin'),
    noticeBytes,
  );
  await writeFile(join(artifactRoot, 'summary.txt'), summaryBytes);

  const manifest = await buildEvidenceArtifactManifest({
    artifactRoot,
    runId: '20260729-real-artifacts',
    relativePaths: ['summary.txt', 'official/pages/notice.bin'],
  });

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    runId: '20260729-real-artifacts',
    artifacts: [
      {
        relativePath: 'official/pages/notice.bin',
        sha256: createHash('sha256').update(noticeBytes).digest('hex'),
        sizeBytes: noticeBytes.byteLength,
      },
      {
        relativePath: 'summary.txt',
        sha256: createHash('sha256').update(summaryBytes).digest('hex'),
        sizeBytes: summaryBytes.byteLength,
      },
    ],
  });
  assert.deepEqual(
    await verifyEvidenceArtifactManifest({ artifactRoot, manifest }),
    manifest,
  );
});

test('verification rejects declared metadata that does not match current bytes', async (t) => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'evidence-artifacts-verify-'));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const bytes = Buffer.from('original evidence bytes', 'utf8');
  await writeFile(join(artifactRoot, 'evidence.txt'), bytes);
  const manifest = await buildEvidenceArtifactManifest({
    artifactRoot,
    runId: '20260729-verify-artifacts',
    relativePaths: ['evidence.txt'],
  });

  const wrongDigest = structuredClone(manifest);
  wrongDigest.artifacts[0].sha256 = SHA_A;
  assert.notEqual(wrongDigest.artifacts[0].sha256, manifest.artifacts[0].sha256);
  await assert.rejects(
    verifyEvidenceArtifactManifest({ artifactRoot, manifest: wrongDigest }),
    /evidence\.txt sha256 does not match the current file/,
  );

  const wrongSize = structuredClone(manifest);
  wrongSize.artifacts[0].sizeBytes += 1;
  await assert.rejects(
    verifyEvidenceArtifactManifest({ artifactRoot, manifest: wrongSize }),
    /evidence\.txt sizeBytes does not match the current file/,
  );

  await writeFile(join(artifactRoot, 'evidence.txt'), 'changed bytes', 'utf8');
  await assert.rejects(
    verifyEvidenceArtifactManifest({ artifactRoot, manifest }),
    /evidence\.txt (sizeBytes|sha256) does not match the current file/,
  );
});

test('rejects a symlink artifact root before resolving it', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'evidence-artifacts-root-link-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const realRoot = join(parent, 'real-root');
  const artifactRoot = join(parent, 'artifact-root');
  await mkdir(realRoot);
  await writeFile(join(realRoot, 'evidence.txt'), 'outside evidence', 'utf8');
  await symlink(realRoot, artifactRoot);

  await assert.rejects(
    buildEvidenceArtifactManifest({
      artifactRoot,
      runId: '20260729-root-link',
      relativePaths: ['evidence.txt'],
    }),
    /artifactRoot must not be a symbolic link/,
  );
});

test('rejects a file replaced between path validation and open', async (t) => {
  const artifactRoot = await mkdtemp(
    join(tmpdir(), 'evidence-artifacts-file-swap-'),
  );
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactPath = join(artifactRoot, 'evidence.txt');
  const replacementPath = join(artifactRoot, 'attacker.txt');
  await writeFile(artifactPath, 'trusted evidence', 'utf8');
  await writeFile(replacementPath, 'outside evidence', 'utf8');
  let replacementTriggered = false;
  const options = {
    artifactRoot,
    runId: '20260729-file-swap',
    relativePaths: ['evidence.txt'],
    ioHooks: {
      afterPathValidation: async () => {
        replacementTriggered = true;
        await rename(artifactPath, join(artifactRoot, 'original.txt'));
        await rename(replacementPath, artifactPath);
      },
    },
  };

  await assert.rejects(
    buildEvidenceArtifactManifest(options),
    /artifact evidence\.txt changed during read/,
  );
  assert.equal(replacementTriggered, true);
});

test('rejects the artifact root replaced after file open', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'evidence-artifacts-root-swap-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const artifactRoot = join(parent, 'source-root');
  const replacementRoot = join(parent, 'attack-root');
  await mkdir(artifactRoot);
  await mkdir(replacementRoot);
  await writeFile(
    join(artifactRoot, 'evidence.txt'),
    'trusted evidence',
    'utf8',
  );
  await writeFile(
    join(replacementRoot, 'evidence.txt'),
    'outside evidence',
    'utf8',
  );
  let replacementTriggered = false;
  const options = {
    artifactRoot,
    runId: '20260729-root-swap',
    relativePaths: ['evidence.txt'],
    ioHooks: {
      afterFileOpen: async () => {
        replacementTriggered = true;
        await rename(artifactRoot, join(parent, 'backup-root'));
        await rename(replacementRoot, artifactRoot);
      },
    },
  };

  await assert.rejects(
    buildEvidenceArtifactManifest(options),
    /artifactRoot changed during read/,
  );
  assert.equal(replacementTriggered, true);
});

test('rejects an intermediate directory replaced after file open', async (t) => {
  const artifactRoot = await mkdtemp(
    join(tmpdir(), 'evidence-artifacts-directory-swap-'),
  );
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const sourceDirectory = join(artifactRoot, 'source-dir');
  const replacementDirectory = join(artifactRoot, 'attack-dir');
  await mkdir(sourceDirectory);
  await mkdir(replacementDirectory);
  await writeFile(
    join(sourceDirectory, 'evidence.txt'),
    'trusted evidence',
    'utf8',
  );
  await writeFile(
    join(replacementDirectory, 'evidence.txt'),
    'outside evidence',
    'utf8',
  );
  let replacementTriggered = false;
  const options = {
    artifactRoot,
    runId: '20260729-directory-swap',
    relativePaths: ['source-dir/evidence.txt'],
    ioHooks: {
      afterFileOpen: async () => {
        replacementTriggered = true;
        await rename(sourceDirectory, join(artifactRoot, 'backup-dir'));
        await rename(replacementDirectory, sourceDirectory);
      },
    },
  };

  await assert.rejects(
    buildEvidenceArtifactManifest(options),
    /artifact path source-dir changed during read/,
  );
  assert.equal(replacementTriggered, true);
});

test('rejects symlinks, symlinked parent directories, and non-regular files', async (t) => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'evidence-artifacts-types-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'evidence-artifacts-outside-'));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));

  await writeFile(join(outsideRoot, 'target.txt'), 'outside evidence', 'utf8');
  await symlink(join(outsideRoot, 'target.txt'), join(artifactRoot, 'link.txt'));
  await symlink(outsideRoot, join(artifactRoot, 'linked-directory'));
  await mkdir(join(artifactRoot, 'directory'));

  await assert.rejects(
    buildEvidenceArtifactManifest({
      artifactRoot,
      runId: '20260729-file-types',
      relativePaths: ['link.txt'],
    }),
    /link\.txt must not be a symbolic link/,
  );
  await assert.rejects(
    buildEvidenceArtifactManifest({
      artifactRoot,
      runId: '20260729-file-types',
      relativePaths: ['linked-directory/target.txt'],
    }),
    /linked-directory must not be a symbolic link/,
  );
  await assert.rejects(
    buildEvidenceArtifactManifest({
      artifactRoot,
      runId: '20260729-file-types',
      relativePaths: ['directory'],
    }),
    /directory must be a regular file/,
  );
});

test('pure coverage check requires one real-manifest hash per readable evidence hash', () => {
  const bundle = bundleForCoverage();
  const before = structuredClone(bundle);
  const manifest: EvidenceArtifactManifest = {
    schemaVersion: 1,
    runId: bundle.runId,
    artifacts: [
      {
        relativePath: 'discovery/baoyantongzhi.html',
        sha256: SHA_A,
        sizeBytes: 10,
      },
      {
        relativePath: 'official/test-university.html',
        sha256: SHA_B,
        sizeBytes: 20,
      },
    ],
  };

  assert.doesNotThrow(() =>
    assertReadableEvidenceArtifactsCovered(bundle, manifest),
  );
  assert.deepEqual(bundle, before);
});

test('coverage check reports uncovered readable evidence and rejects another run', () => {
  const bundle = bundleForCoverage();
  const missingEvidence: EvidenceArtifactManifest = {
    schemaVersion: 1,
    runId: bundle.runId,
    artifacts: [
      {
        relativePath: 'discovery/baoyantongzhi.html',
        sha256: SHA_A,
        sizeBytes: 10,
      },
    ],
  };
  assert.throws(
    () => assertReadableEvidenceArtifactsCovered(bundle, missingEvidence),
    /evidence:hit.*bbbbbbbb/,
  );

  assert.throws(
    () =>
      assertReadableEvidenceArtifactsCovered(bundle, {
        ...missingEvidence,
        runId: 'another-run',
      }),
    /manifest runId another-run does not match scan bundle runId/,
  );
});
