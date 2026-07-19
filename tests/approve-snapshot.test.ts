import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  approveCandidate,
  approveSnapshotFile,
  canonicalDataHash,
  validateApprovedSnapshot,
} from '../scripts/snapshot/approve-snapshot.js';
import { validateSnapshot } from '../src/lib/snapshot-validation.js';
import type {
  LegacyPublicSnapshotV1,
  PublicOpportunity,
  PublicSnapshot,
  ReadablePublicSnapshot,
  SnapshotCandidate,
} from '../src/lib/snapshot-types.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-valid.json', import.meta.url), 'utf8'),
) as PublicSnapshot;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const approveCliPath = resolve(repositoryRoot, 'scripts/snapshot/approve-snapshot.ts');
const validateCliPath = resolve(repositoryRoot, 'scripts/snapshot/validate-current.ts');
const snapshotIntegrityPath = resolve(repositoryRoot, 'src/lib/snapshot-integrity.ts');
const approvedAt = '2026-07-16T09:35:00+08:00';

function candidate(): SnapshotCandidate {
  const value = structuredClone(fixture) as PublicSnapshot;
  const candidateValue = value as Partial<PublicSnapshot>;
  delete candidateValue.snapshotId;
  delete candidateValue.approvedAt;
  delete candidateValue.previousSnapshotId;
  delete candidateValue.dataHash;
  return candidateValue as SnapshotCandidate;
}

function longLivedCandidate(): SnapshotCandidate {
  const value = candidate();
  value.opportunities[0].deadline = '2099-12-31T23:59:00+08:00';
  value.opportunities[0].deadlineOriginal = '2099年12月31日23:59';
  value.opportunities[0].deadlineEpochMs = Date.parse(value.opportunities[0].deadline);
  return value;
}

function legacySnapshotV1(): LegacyPublicSnapshotV1 {
  const next = candidate();
  const legacyCandidate = {
    ...structuredClone(next),
    schemaVersion: 1 as const,
    opportunities: next.opportunities.map(({ eventArrangement: _eventArrangement, ...row }) => row),
  };
  const dataHash = canonicalDataHash(legacyCandidate);
  return {
    ...legacyCandidate,
    snapshotId: `${new Date(approvedAt).toISOString()}-${dataHash.slice(0, 12)}`,
    approvedAt,
    previousSnapshotId: null,
    dataHash,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runCli(path: string, args: string[], timeout?: number) {
  return spawnSync(process.execPath, ['--import', 'tsx', path, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout,
  });
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

test('snapshot integrity rules have one shared source outside the approval CLI', () => {
  assert.ok(existsSync(snapshotIntegrityPath), 'src/lib/snapshot-integrity.ts must exist');

  const integritySource = readFileSync(snapshotIntegrityPath, 'utf8');
  const approvalSource = readFileSync(approveCliPath, 'utf8');
  for (const script of [
    'import-scouting-data.ts',
    'diff-snapshots.ts',
    'validate-current.ts',
    'check-freshness.ts',
  ]) {
    const source = readFileSync(resolve(repositoryRoot, 'scripts/snapshot', script), 'utf8');
    assert.match(source, /src\/lib\/snapshot-integrity\.js/);
    assert.doesNotMatch(source, /from ['"]\.\/approve-snapshot\.js['"]/);
  }

  assert.match(approvalSource, /src\/lib\/snapshot-integrity\.js/);
  assert.doesNotMatch(approvalSource, /function canonicalPayload\b/);
  assert.equal(
    [...integritySource.matchAll(/schemaVersion:\s*input\.schemaVersion/g)].length,
    1,
    'canonical payload top-level fields must be constructed once',
  );
});

test('canonical SHA-256 matches a hard-coded known answer', () => {
  const input: SnapshotCandidate = {
    schemaVersion: 2,
    scanAt: '2026-01-02T03:04:05Z',
    defaultFeedId: 'feed',
    feeds: [{ id: 'feed', label: 'Feed', admissionCycle: '2027', eventYear: 2026 }],
    counts: {
      confirmedOpen: 0,
      confirmedUnknownDeadline: 0,
      pendingExcluded: 0,
      expired: 0,
    },
    opportunities: [],
  };

  assert.equal(
    canonicalDataHash(input),
    '2d1ac6c1deeea7e7fb4a5864af63dbeda7b876780a03872ea75c1a51fdbc36d0',
  );
});

test('canonical hash ignores object key order but preserves array order', () => {
  const input = candidate();
  const reordered = reverseObjectKeys(input) as SnapshotCandidate;
  const arrayReordered = structuredClone(input);
  arrayReordered.opportunities[0].tags = ['second', 'first'];
  const reversedTags = structuredClone(arrayReordered);
  reversedTags.opportunities[0].tags.reverse();

  assert.equal(canonicalDataHash(reordered), canonicalDataHash(input));
  assert.notEqual(canonicalDataHash(arrayReordered), canonicalDataHash(reversedTags));
});

test('canonical hash covers only candidate fields and every publication field', async (t) => {
  const input = candidate();
  const sealed = approveCandidate(input, null, approvedAt);
  const approvalMetadataChanged = {
    ...sealed,
    snapshotId: 'different',
    approvedAt: '2099-01-01T00:00:00Z',
    previousSnapshotId: 'different',
    dataHash: 'f'.repeat(64),
  };
  assert.equal(canonicalDataHash(approvalMetadataChanged), canonicalDataHash(input));

  const mutations: Array<[string, (row: Record<string, any>) => void]> = [
    ['projectId', (row) => (row.projectId = '2027|测试大学|计算机学院|开放日')],
    ['feedId', (row) => (row.feedId = 'other')],
    ['name', (row) => (row.name = '另一所大学')],
    ['institute', (row) => (row.institute = '软件学院')],
    ['project', (row) => (row.project = '开放日')],
    ['eventType', (row) => (row.eventType = '开放日')],
    ['description', (row) => (row.description = '新描述')],
    ['verificationStatus', (row) => (row.verificationStatus = 'expired')],
    ['deadline', (row) => (row.deadline = '2026-07-21T23:59:00+08:00')],
    ['deadlineOriginal', (row) => (row.deadlineOriginal = '新原文')],
    ['deadlineEpochMs', (row) => (row.deadlineEpochMs += 1)],
    ['website', (row) => (row.website = 'https://cs.example.edu.cn/notice/2')],
    ['tags', (row) => row.tags.push('双一流')],
    ['province', (row) => (row.province = '上海')],
    ['verifiedAt', (row) => (row.verifiedAt = '2026-07-15T22:45:00+08:00')],
    ['discoverySources', (row) => (row.discoverySources[0].label = '研究生院官网')],
    ['eventArrangement mode', (row) => (row.eventArrangement.mode = 'hybrid')],
    ['eventArrangement time', (row) => (row.eventArrangement.time.summary = '2026年9月')],
    [
      'eventArrangement formatLocation',
      (row) => (row.eventArrangement.formatLocation.summary = '线上举行'),
    ],
    ['logistics', (row) => (row.logistics.summary = '提供住宿')],
    ['recommendation', (row) => (row.recommendation.summary = '需要推荐信')],
    ['materials', (row) => (row.materials.summary = '成绩单')],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const changed = structuredClone(input);
      mutate(changed.opportunities[0] as unknown as Record<string, any>);
      assert.notEqual(canonicalDataHash(changed), canonicalDataHash(input));
    });
  }
});

test('seals v2 candidates against valid v1 current snapshots', () => {
  const current = legacySnapshotV1();
  const nextApprovedAt = '2026-07-16T09:40:00+08:00';
  const approved = approveCandidate(candidate(), current, nextApprovedAt);

  assert.equal(approved.schemaVersion, 2);
  assert.equal(approved.previousSnapshotId, current.snapshotId);
  assert.deepEqual(validateApprovedSnapshot(current, Date.parse(current.approvedAt)), []);
  assert.deepEqual(validateApprovedSnapshot(approved, Date.parse(nextApprovedAt)), []);
});

test('seals a candidate against the actual current snapshot', () => {
  const first = approveCandidate(candidate(), null, approvedAt);
  const nextApprovedAt = '2026-07-16T09:40:00+08:00';
  const approved = approveCandidate(candidate(), first, nextApprovedAt);

  assert.equal(approved.previousSnapshotId, first.snapshotId);
  assert.equal(approved.approvedAt, nextApprovedAt);
  assert.equal(
    approved.snapshotId,
    `${new Date(nextApprovedAt).toISOString()}-${approved.dataHash.slice(0, 12)}`,
  );
  assert.match(approved.dataHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateSnapshot(approved, Date.parse(nextApprovedAt)), []);
  assert.deepEqual(validateApprovedSnapshot(approved, Date.parse(nextApprovedAt)), []);
  assert.equal(approved.dataHash, canonicalDataHash(approved));
});

test('approval rejects invalid chronology and malformed candidates', async (t) => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['invalid approvedAt', () => approveCandidate(candidate(), null, 'not-a-date'), /approvedAt.*valid ISO/i],
    [
      'approvedAt before scanAt',
      () => approveCandidate(candidate(), null, '2026-07-15T22:59:00+08:00'),
      /approvedAt.*before.*scanAt/i,
    ],
    [
      'malformed candidate',
      () => approveCandidate({} as SnapshotCandidate, null, approvedAt),
      /candidate validation failed/i,
    ],
  ];

  for (const [name, action, pattern] of cases) {
    await t.test(name, () => assert.throws(action, pattern));
  }
});

test('approval validates the current snapshot hash before trusting its ID', async (t) => {
  const current = approveCandidate(candidate(), null, approvedAt);

  await t.test('tampered publication field', () => {
    const tampered = structuredClone(current);
    tampered.opportunities[0].website = 'https://cs.example.edu.cn/tampered';
    tampered.snapshotId = 'must-not-be-trusted';
    assert.throws(
      () => approveCandidate(candidate(), tampered, '2026-07-16T09:40:00+08:00'),
      /current snapshot[\s\S]*hash/i,
    );
  });

  await t.test('uppercase stored hash', () => {
    const uppercase = structuredClone(current);
    uppercase.dataHash = uppercase.dataHash.toUpperCase();
    assert.throws(
      () => approveCandidate(candidate(), uppercase, '2026-07-16T09:40:00+08:00'),
      /current snapshot.*lowercase|hash/i,
    );
  });

  await t.test('malformed current snapshot', () => {
    assert.throws(
      () => approveCandidate(candidate(), {} as PublicSnapshot, approvedAt),
      /current snapshot validation failed/i,
    );
  });
});

test('validateApprovedSnapshot rejects hash and snapshot ID tampering', () => {
  const approved = approveCandidate(candidate(), null, approvedAt);
  const tampered = structuredClone(approved);
  tampered.opportunities[0].materials.summary = 'tampered';
  tampered.snapshotId = 'not-derived-from-hash';

  const errors = validateApprovedSnapshot(tampered, Date.parse(approvedAt)).join('\n');
  assert.match(errors, /dataHash.*canonical/i);
  assert.match(errors, /snapshotId.*approvedAt.*hash/i);
});

test('validateApprovedSnapshot rejects forged lineage identifiers', async (t) => {
  const approved = approveCandidate(candidate(), null, approvedAt);
  for (const previousSnapshotId of [
    'forged-parent',
    '2026-99-99T01:35:00.000Z-123456789abc',
    '2026-07-16T01:35:00.000Z-ABCDEF123456',
  ]) {
    await t.test(previousSnapshotId, () => {
      const forged = { ...approved, previousSnapshotId };
      assert.match(
        validateApprovedSnapshot(forged, Date.parse(approvedAt)).join('\n'),
        /previousSnapshotId.*snapshot ID format/i,
      );
    });
  }
});

test('approve CLI creates the first current snapshot and preserves staging files', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-first-'));
  const candidatePath = join(tempRoot, 'staging', 'candidate.json');
  const diffPath = join(tempRoot, 'staging', 'diff.json');
  const approvedPath = join(tempRoot, 'approved', 'current.json');
  writeJson(candidatePath, candidate());
  writeJson(diffPath, { added: ['seed'], changed: [], expired: [], removed: [] });
  const candidateBefore = readFileSync(candidatePath, 'utf8');
  const diffBefore = readFileSync(diffPath, 'utf8');

  try {
    const result = runCli(approveCliPath, [
      '--candidate', candidatePath,
      '--approved', approvedPath,
      '--approved-at', approvedAt,
    ]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const approved = JSON.parse(readFileSync(approvedPath, 'utf8')) as PublicSnapshot;
    assert.equal(approved.previousSnapshotId, null);
    assert.deepEqual(validateApprovedSnapshot(approved, Date.parse(approvedAt)), []);
    assert.equal(readFileSync(candidatePath, 'utf8'), candidateBefore);
    assert.equal(readFileSync(diffPath, 'utf8'), diffBefore);
    assert.deepEqual(readdirSync(dirname(approvedPath)), ['current.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('approve CLI derives previousSnapshotId from an existing valid v1 current file', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-existing-'));
  const candidatePath = join(tempRoot, 'candidate.json');
  const approvedPath = join(tempRoot, 'current.json');
  const current: ReadablePublicSnapshot = legacySnapshotV1();
  writeJson(candidatePath, candidate());
  writeJson(approvedPath, current);

  try {
    const result = runCli(approveCliPath, [
      '--candidate', candidatePath,
      '--approved', approvedPath,
      '--approved-at', '2026-07-16T09:40:00+08:00',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const approved = JSON.parse(readFileSync(approvedPath, 'utf8')) as PublicSnapshot;
    assert.equal(approved.previousSnapshotId, current.snapshotId);
    assert.deepEqual(
      validateApprovedSnapshot(approved, Date.parse('2026-07-16T09:40:00+08:00')),
      [],
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('approve CLI rejects missing or malformed candidates without changing current', async (t) => {
  const cases: Array<[string, (path: string) => void, RegExp]> = [
    ['missing', () => undefined, /candidate.*could not be read/i],
    ['invalid JSON', (path) => writeFileSync(path, '{broken', 'utf8'), /candidate.*valid JSON/i],
    ['invalid shape', (path) => writeJson(path, {}), /candidate validation failed/i],
  ];

  for (const [name, prepare, pattern] of cases) {
    await t.test(name, () => {
      const tempRoot = mkdtempSync(join(tmpdir(), `snapshot-approve-candidate-${name}-`));
      const candidatePath = join(tempRoot, 'candidate.json');
      const approvedPath = join(tempRoot, 'current.json');
      const current = approveCandidate(candidate(), null, approvedAt);
      writeJson(approvedPath, current);
      const before = readFileSync(approvedPath);
      prepare(candidatePath);

      try {
        const result = runCli(approveCliPath, [
          '--candidate', candidatePath,
          '--approved', approvedPath,
          '--approved-at', '2026-07-16T09:40:00+08:00',
        ]);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, pattern);
        assert.deepEqual(readFileSync(approvedPath), before);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test('approve CLI rejects unsafe candidate file types before reading', async (t) => {
  await t.test('symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-candidate-symlink-'));
    const targetPath = join(tempRoot, 'candidate-target.json');
    const candidatePath = join(tempRoot, 'candidate.json');
    const approvedPath = join(tempRoot, 'current.json');
    writeJson(targetPath, candidate());
    symlinkSync(targetPath, candidatePath);

    try {
      const result = runCli(approveCliPath, [
        '--candidate', candidatePath,
        '--approved', approvedPath,
        '--approved-at', approvedAt,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /candidate.*symlink/i);
      assert.ok(lstatSync(candidatePath).isSymbolicLink());
      assert.equal(existsSync(approvedPath), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('FIFO', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-candidate-fifo-'));
    const candidatePath = join(tempRoot, 'candidate.fifo');
    const approvedPath = join(tempRoot, 'current.json');
    const created = spawnSync('mkfifo', [candidatePath], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);

    try {
      const result = runCli(approveCliPath, [
        '--candidate', candidatePath,
        '--approved', approvedPath,
        '--approved-at', approvedAt,
      ], 500);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /candidate.*regular file/i);
      assert.ok(lstatSync(candidatePath).isFIFO());
      assert.equal(existsSync(approvedPath), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('approve CLI rejects oversized candidate JSON before parsing', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-candidate-oversized-'));
  const candidatePath = join(tempRoot, 'candidate.json');
  const approvedPath = join(tempRoot, 'current.json');
  writeFileSync(
    candidatePath,
    `${' '.repeat(16 * 1024 * 1024 + 1)}${JSON.stringify(candidate())}`,
    'utf8',
  );

  try {
    const result = runCli(approveCliPath, [
      '--candidate', candidatePath,
      '--approved', approvedPath,
      '--approved-at', approvedAt,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /candidate.*(?:too large|size limit)/i);
    assert.equal(existsSync(approvedPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('approve CLI rejects malformed or tampered current snapshots byte-identically', async (t) => {
  const cases: Array<[string, unknown | string, RegExp]> = [
    ['invalid JSON', '{broken', /current snapshot.*valid JSON/i],
    ['malformed shape', {}, /current snapshot validation failed/i],
    ['tampered hash', (() => {
      const current = approveCandidate(candidate(), null, approvedAt);
      current.opportunities[0].project = 'tampered';
      return current;
    })(), /current snapshot[\s\S]*hash/i],
  ];

  for (const [name, current, pattern] of cases) {
    await t.test(name, () => {
      const tempRoot = mkdtempSync(join(tmpdir(), `snapshot-approve-current-${name}-`));
      const candidatePath = join(tempRoot, 'candidate.json');
      const approvedPath = join(tempRoot, 'current.json');
      writeJson(candidatePath, candidate());
      if (typeof current === 'string') {
        writeFileSync(approvedPath, current, 'utf8');
      } else {
        writeJson(approvedPath, current);
      }
      const candidateBefore = readFileSync(candidatePath);
      const approvedBefore = readFileSync(approvedPath);

      try {
        const result = runCli(approveCliPath, [
          '--candidate', candidatePath,
          '--approved', approvedPath,
          '--approved-at', '2026-07-16T09:40:00+08:00',
        ]);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, pattern);
        assert.deepEqual(readFileSync(candidatePath), candidateBefore);
        assert.deepEqual(readFileSync(approvedPath), approvedBefore);
        assert.deepEqual(readdirSync(tempRoot).sort(), ['candidate.json', 'current.json']);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test('approve CLI rejects path and inode collisions', async (t) => {
  await t.test('same resolved path', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-same-path-'));
    const path = join(tempRoot, 'candidate.json');
    writeJson(path, candidate());
    const before = readFileSync(path);
    try {
      const result = runCli(approveCliPath, [
        '--candidate', path,
        '--approved', `${tempRoot}/./candidate.json`,
        '--approved-at', approvedAt,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /collid/i);
      assert.deepEqual(readFileSync(path), before);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('hardlink alias', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-hardlink-'));
    const candidatePath = join(tempRoot, 'candidate.json');
    const approvedPath = join(tempRoot, 'current.json');
    writeJson(candidatePath, candidate());
    linkSync(candidatePath, approvedPath);
    const before = readFileSync(candidatePath);
    try {
      const result = runCli(approveCliPath, [
        '--candidate', candidatePath,
        '--approved', approvedPath,
        '--approved-at', approvedAt,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /collid|inode|hardlink/i);
      assert.deepEqual(readFileSync(candidatePath), before);
      assert.deepEqual(readFileSync(approvedPath), before);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('approve CLI rejects symlink and non-regular approved targets', async (t) => {
  await t.test('symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-symlink-'));
    const candidatePath = join(tempRoot, 'candidate.json');
    const targetPath = join(tempRoot, 'target.json');
    const approvedPath = join(tempRoot, 'current.json');
    writeJson(candidatePath, candidate());
    writeJson(targetPath, approveCandidate(candidate(), null, approvedAt));
    const targetBefore = readFileSync(targetPath);
    symlinkSync(targetPath, approvedPath);
    try {
      const result = runCli(approveCliPath, [
        '--candidate', candidatePath,
        '--approved', approvedPath,
        '--approved-at', '2026-07-16T09:40:00+08:00',
      ]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /approved.*symlink/i);
      assert.ok(lstatSync(approvedPath).isSymbolicLink());
      assert.deepEqual(readFileSync(targetPath), targetBefore);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('directory', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-directory-'));
    const candidatePath = join(tempRoot, 'candidate.json');
    const approvedPath = join(tempRoot, 'current.json');
    writeJson(candidatePath, candidate());
    mkdirSync(approvedPath);
    try {
      const result = runCli(approveCliPath, [
        '--candidate', candidatePath,
        '--approved', approvedPath,
        '--approved-at', approvedAt,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /approved.*regular file/i);
      assert.ok(lstatSync(approvedPath).isDirectory());
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('atomic approval cancellation preserves current and staging files', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-cancel-'));
  const candidatePath = join(tempRoot, 'staging', 'candidate.json');
  const diffPath = join(tempRoot, 'staging', 'diff.json');
  const approvedPath = join(tempRoot, 'approved', 'current.json');
  writeJson(candidatePath, candidate());
  writeJson(diffPath, { added: [], changed: [], expired: [], removed: [] });
  writeJson(approvedPath, approveCandidate(candidate(), null, approvedAt));
  const before = new Map([
    [candidatePath, readFileSync(candidatePath)],
    [diffPath, readFileSync(diffPath)],
    [approvedPath, readFileSync(approvedPath)],
  ]);
  const controller = new AbortController();
  controller.abort(new Error('cancelled before approved rename'));

  try {
    await assert.rejects(
      approveSnapshotFile({
        candidatePath,
        approvedPath,
        approvedAt: '2026-07-16T09:40:00+08:00',
      }, controller.signal),
      /cancelled before approved rename/i,
    );
    for (const [path, contents] of before) {
      assert.deepEqual(readFileSync(path), contents);
    }
    assert.deepEqual(readdirSync(dirname(approvedPath)), ['current.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('atomic approval detects a concurrent current replacement before rename', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-concurrent-'));
  const candidatePath = join(tempRoot, 'staging', 'candidate.json');
  const approvedPath = join(tempRoot, 'approved', 'current.json');
  writeJson(candidatePath, candidate());
  writeJson(approvedPath, approveCandidate(candidate(), null, approvedAt));
  const candidateBefore = readFileSync(candidatePath);
  const concurrentContents = 'CONCURRENT_REPLACEMENT_MUST_SURVIVE\n';
  const mutationSignal = {
    get aborted(): boolean {
      writeFileSync(approvedPath, concurrentContents, 'utf8');
      return false;
    },
  } as AbortSignal;

  try {
    await assert.rejects(
      approveSnapshotFile({
        candidatePath,
        approvedPath,
        approvedAt: '2026-07-16T09:40:00+08:00',
      }, mutationSignal),
      /changed concurrently/i,
    );
    assert.deepEqual(readFileSync(candidatePath), candidateBefore);
    assert.equal(readFileSync(approvedPath, 'utf8'), concurrentContents);
    assert.deepEqual(readdirSync(dirname(approvedPath)), ['current.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('approval lock excludes a cooperating concurrent writer and is cleaned', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-lock-concurrent-'));
  const candidatePath = join(tempRoot, 'candidate.json');
  const approvedPath = join(tempRoot, 'current.json');
  const lockPath = join(tempRoot, '.current.json.lock');
  writeJson(candidatePath, candidate());
  writeJson(approvedPath, approveCandidate(candidate(), null, approvedAt));
  const currentBefore = readFileSync(approvedPath);
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const enteredPromise = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const first = approveSnapshotFile({
    candidatePath,
    approvedPath,
    approvedAt: '2026-07-16T09:40:00+08:00',
  }, undefined, {
    beforeRename: async () => {
      firstEntered();
      await releasePromise;
    },
  });

  try {
    await Promise.race([
      enteredPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('first approval never reached the rename barrier')), 500);
      }),
    ]);
    assert.ok(existsSync(lockPath));
    await assert.rejects(
      approveSnapshotFile({
        candidatePath,
        approvedPath,
        approvedAt: '2026-07-16T09:45:00+08:00',
      }),
      /approval.*lock|another approval/i,
    );
    assert.deepEqual(readFileSync(approvedPath), currentBefore);
    releaseFirst();
    await first;
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(readdirSync(tempRoot).sort(), ['candidate.json', 'current.json']);
  } finally {
    releaseFirst();
    await first.catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('directory open failure is pre-commit and preserves the old current', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-directory-open-failure-'));
  const candidatePath = join(tempRoot, 'candidate.json');
  const approvedPath = join(tempRoot, 'current.json');
  writeJson(candidatePath, candidate());
  writeJson(approvedPath, approveCandidate(candidate(), null, approvedAt));
  const before = readFileSync(approvedPath);

  try {
    await assert.rejects(
      approveSnapshotFile({
        candidatePath,
        approvedPath,
        approvedAt: '2026-07-16T09:40:00+08:00',
      }, undefined, {
        openDirectory: async () => {
          throw new Error('injected directory open failure');
        },
      }),
      /injected directory open failure/i,
    );
    assert.deepEqual(readFileSync(approvedPath), before);
    assert.deepEqual(readdirSync(tempRoot).sort(), ['candidate.json', 'current.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('post-rename directory sync failure does not report a false approval failure', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-directory-sync-failure-'));
  const candidatePath = join(tempRoot, 'candidate.json');
  const approvedPath = join(tempRoot, 'current.json');
  writeJson(candidatePath, candidate());
  writeJson(approvedPath, approveCandidate(candidate(), null, approvedAt));
  let syncCalls = 0;

  try {
    const approved = await approveSnapshotFile({
      candidatePath,
      approvedPath,
      approvedAt: '2026-07-16T09:40:00+08:00',
    }, undefined, {
      syncDirectory: async () => {
        syncCalls += 1;
        throw new Error('injected post-rename sync failure');
      },
    });
    assert.equal(syncCalls, 1);
    assert.deepEqual(
      validateApprovedSnapshot(
        JSON.parse(readFileSync(approvedPath, 'utf8')),
        Date.parse(approved.approvedAt),
      ),
      [],
    );
    assert.deepEqual(readdirSync(tempRoot).sort(), ['candidate.json', 'current.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('approve and validate CLIs JSON-escape user-controlled paths', async (t) => {
  await t.test('approve failure stderr', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-path-error-'));
    const candidatePath = join(tempRoot, 'missing\ncandidate.json');
    const approvedPath = join(tempRoot, 'current.json');

    try {
      const result = runCli(approveCliPath, [
        '--candidate', candidatePath,
        '--approved', approvedPath,
        '--approved-at', approvedAt,
      ]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(JSON.stringify(candidatePath)));
      assert.equal(result.stderr.includes(candidatePath), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('approve success stdout', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-approve-path-success-'));
    const candidatePath = join(tempRoot, 'candidate.json');
    const approvedPath = join(tempRoot, 'current\napproved.json');
    writeJson(candidatePath, candidate());

    try {
      const result = runCli(approveCliPath, [
        '--candidate', candidatePath,
        '--approved', approvedPath,
        '--approved-at', approvedAt,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.includes(JSON.stringify(approvedPath)));
      assert.equal(result.stdout.includes(approvedPath), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('validate failure stderr', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-path-error-'));
    const approvedPath = join(tempRoot, 'missing\napproved.json');

    try {
      const result = runCli(validateCliPath, ['--approved', approvedPath]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(JSON.stringify(approvedPath)));
      assert.equal(result.stderr.includes(approvedPath), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('approve CLI rejects unknown, duplicate and missing arguments', async (t) => {
  const cases: Array<[string, string[], RegExp]> = [
    ['unknown', ['--candidate', 'a', '--approved', 'b', '--wat', 'x'], /unknown|usage/i],
    ['duplicate', ['--candidate', 'a', '--candidate', 'b', '--approved', 'c'], /duplicate/i],
    ['missing value', ['--candidate', '--approved', 'b'], /missing|usage/i],
    ['missing required', ['--candidate', 'a'], /required|usage/i],
  ];
  for (const [name, args, pattern] of cases) {
    await t.test(name, () => {
      const result = runCli(approveCliPath, args);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, pattern);
    });
  }
});

test('validate-current CLI prints the true four-count summary', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-current-'));
  const approvedPath = join(tempRoot, 'current.json');
  const input = longLivedCandidate();
  input.counts.pendingExcluded = 7;
  writeJson(approvedPath, approveCandidate(input, null, approvedAt));
  try {
    const result = runCli(validateCliPath, ['--approved', approvedPath]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stdout,
      /^confirmedOpen=1 confirmedUnknownDeadline=0 pendingExcluded=7 expired=0\s*$/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('validate-current CLI revalidates an aged approved snapshot at its approval time', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-aged-current-'));
  const approvedPath = join(tempRoot, 'current.json');
  const input = candidate();
  input.scanAt = '2020-01-01T08:00:00+08:00';
  input.opportunities[0].verifiedAt = input.scanAt;
  input.opportunities[0].deadline = '2020-01-02T23:59:00+08:00';
  input.opportunities[0].deadlineOriginal = '2020年1月2日23:59';
  input.opportunities[0].deadlineEpochMs = Date.parse(input.opportunities[0].deadline);
  writeJson(approvedPath, approveCandidate(input, null, '2020-01-01T08:05:00+08:00'));

  try {
    const result = runCli(validateCliPath, ['--approved', approvedPath]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^confirmedOpen=1 /);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('validate-current CLI prints every structural and hash error', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-errors-'));
  const approvedPath = join(tempRoot, 'current.json');
  const tampered = approveCandidate(candidate(), null, approvedAt) as Record<string, any>;
  tampered.counts.confirmedOpen = 9;
  tampered.opportunities[0].website = 'not a URL';
  writeJson(approvedPath, tampered);
  try {
    const result = runCli(validateCliPath, ['--approved', approvedPath]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /confirmedOpen.*match/i);
    assert.match(output, /website.*URL/i);
    assert.match(output, /dataHash.*canonical/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('validate-current rejects symlink and oversized approved inputs before reading', async (t) => {
  await t.test('symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-symlink-'));
    const targetPath = join(tempRoot, 'target.json');
    const approvedPath = join(tempRoot, 'current.json');
    writeJson(targetPath, approveCandidate(longLivedCandidate(), null, approvedAt));
    symlinkSync(targetPath, approvedPath);

    try {
      const result = runCli(validateCliPath, ['--approved', approvedPath]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /approved snapshot.*symlink/i);
      assert.ok(lstatSync(approvedPath).isSymbolicLink());
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('oversized JSON', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-oversized-'));
    const approvedPath = join(tempRoot, 'current.json');
    const approved = approveCandidate(longLivedCandidate(), null, approvedAt);
    writeFileSync(
      approvedPath,
      `${' '.repeat(16 * 1024 * 1024 + 1)}${JSON.stringify(approved)}`,
      'utf8',
    );

    try {
      const result = runCli(validateCliPath, ['--approved', approvedPath]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /approved snapshot.*(?:too large|size limit)/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('directory', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-directory-'));
    const approvedPath = join(tempRoot, 'current.json');
    mkdirSync(approvedPath);

    try {
      const result = runCli(validateCliPath, ['--approved', approvedPath]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /approved snapshot.*regular file/i);
      assert.ok(lstatSync(approvedPath).isDirectory());
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('validate-current CLI rejects unknown, duplicate and missing arguments', async (t) => {
  const cases: Array<[string, string[], RegExp]> = [
    ['unknown', ['--wat', 'x'], /unknown|usage/i],
    ['duplicate', ['--approved', 'a', '--approved', 'b'], /duplicate/i],
    ['missing value', ['--approved'], /missing|usage/i],
  ];
  for (const [name, args, pattern] of cases) {
    await t.test(name, () => {
      const result = runCli(validateCliPath, args);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, pattern);
    });
  }
});
