import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import type {
  PublicSnapshot,
  SnapshotCandidate,
} from '../src/lib/snapshot-types.js';
import { validateSnapshot } from '../src/lib/snapshot-validation.js';
import { writeReplayableReleaseFixture } from './helpers/scan-release-fixture.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-valid.json', import.meta.url), 'utf8'),
) as PublicSnapshot;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const approveCliPath = resolve(
  repositoryRoot,
  'scripts/snapshot/approve-snapshot.ts',
);
const validateCliPath = resolve(
  repositoryRoot,
  'scripts/snapshot/validate-current.ts',
);
const snapshotIntegrityPath = resolve(
  repositoryRoot,
  'src/lib/snapshot-integrity.ts',
);
const approvedAt = '2026-07-16T09:35:00+08:00';
const nextApprovedAt = '2026-07-16T09:40:00+08:00';

function candidate(): SnapshotCandidate {
  const value = structuredClone(fixture) as Partial<PublicSnapshot>;
  delete value.snapshotId;
  delete value.approvedAt;
  delete value.previousSnapshotId;
  delete value.dataHash;
  return value as SnapshotCandidate;
}

function longLivedCandidate(): SnapshotCandidate {
  const value = candidate();
  value.opportunities[0].deadline = '2099-12-31T23:59:00+08:00';
  value.opportunities[0].deadlineOriginal = '2099年12月31日23:59';
  value.opportunities[0].deadlineEpochMs = Date.parse(
    value.opportunities[0].deadline,
  );
  return value;
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

function secureFixture(prefix: string) {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const approvedPath = join(tempRoot, 'current.json');
  const current = approveCandidate(longLivedCandidate(), null, approvedAt);
  writeJson(approvedPath, current);
  const release = writeReplayableReleaseFixture(tempRoot, current);
  return {
    tempRoot,
    approvedPath,
    current,
    release,
    options: {
      releaseDir: release.releaseDir,
      approvedPath,
      pendingCurrentPath: release.pendingCurrentPath,
      approvedAt: nextApprovedAt,
    },
  };
}

test('snapshot integrity rules have one shared source outside the approval CLI', () => {
  assert.ok(existsSync(snapshotIntegrityPath));
  const integritySource = readFileSync(snapshotIntegrityPath, 'utf8');
  const approvalSource = readFileSync(approveCliPath, 'utf8');
  for (const script of [
    'import-scouting-data.ts',
    'diff-snapshots.ts',
    'validate-current.ts',
    'check-freshness.ts',
  ]) {
    const source = readFileSync(
      resolve(repositoryRoot, 'scripts/snapshot', script),
      'utf8',
    );
    assert.match(source, /src\/lib\/snapshot-integrity\.js/);
    assert.doesNotMatch(source, /from ['"]\.\/approve-snapshot\.js['"]/);
  }
  assert.match(approvalSource, /src\/lib\/snapshot-integrity\.js/);
  assert.doesNotMatch(approvalSource, /function canonicalPayload\b/);
  assert.equal(
    [...integritySource.matchAll(/schemaVersion:\s*input\.schemaVersion/g)].length,
    1,
  );
});

test('canonical SHA-256 is stable and ignores object key order', () => {
  const input: SnapshotCandidate = {
    schemaVersion: 2,
    scanAt: '2026-01-02T03:04:05Z',
    defaultFeedId: 'feed',
    feeds: [
      {
        id: 'feed',
        label: 'Feed',
        admissionCycle: '2027',
        eventYear: 2026,
      },
    ],
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
  assert.equal(
    canonicalDataHash(Object.fromEntries(Object.entries(input).reverse())),
    canonicalDataHash(input),
  );
});

test('approveCandidate seals lineage and rejects invalid chronology or current hash', () => {
  const first = approveCandidate(candidate(), null, approvedAt);
  const approved = approveCandidate(candidate(), first, nextApprovedAt);
  assert.equal(approved.previousSnapshotId, first.snapshotId);
  assert.equal(
    approved.snapshotId,
    `${new Date(nextApprovedAt).toISOString()}-${approved.dataHash.slice(0, 12)}`,
  );
  assert.deepEqual(validateSnapshot(approved, Date.parse(nextApprovedAt)), []);
  assert.throws(
    () => approveCandidate(candidate(), null, 'not-a-date'),
    /approvedAt.*valid ISO/i,
  );
  assert.throws(
    () =>
      approveCandidate(
        candidate(),
        null,
        '2026-07-15T22:59:00+08:00',
      ),
    /approvedAt.*before.*scanAt/i,
  );
  const tampered = structuredClone(first);
  tampered.opportunities[0].website = 'https://cs.example.edu.cn/tampered';
  assert.throws(
    () => approveCandidate(candidate(), tampered, nextApprovedAt),
    /current snapshot[\s\S]*hash/i,
  );
});

test('approveCandidate accepts a structurally valid historic parent with elapsed open status', () => {
  const staleParent = approveCandidate(longLivedCandidate(), null, approvedAt);
  const staleRow = staleParent.opportunities[0];
  staleRow.deadline = '2026-07-15T08:00:00+08:00';
  staleRow.deadlineOriginal = '2026年7月15日08:00';
  staleRow.deadlineEpochMs = Date.parse(staleRow.deadline);
  staleParent.dataHash = canonicalDataHash(staleParent);
  staleParent.snapshotId = `${new Date(staleParent.approvedAt).toISOString()}-${staleParent.dataHash.slice(0, 12)}`;

  assert.match(
    validateSnapshot(staleParent, Date.parse(nextApprovedAt)).join('\n'),
    /confirmed-open deadline must be in the future/i,
  );
  assert.doesNotThrow(() => approveCandidate(longLivedCandidate(), staleParent, nextApprovedAt));
});

test('validateApprovedSnapshot rejects publication and lineage tampering', () => {
  const approved = approveCandidate(candidate(), null, approvedAt);
  const tampered = structuredClone(approved);
  tampered.opportunities[0].materials.summary = 'tampered';
  tampered.snapshotId = 'not-derived-from-hash';
  tampered.previousSnapshotId = 'forged-parent';
  const errors = validateApprovedSnapshot(
    tampered,
    Date.parse(approvedAt),
  ).join('\n');
  assert.match(errors, /dataHash.*canonical/i);
  assert.match(errors, /snapshotId.*approvedAt.*hash/i);
  assert.match(errors, /previousSnapshotId.*snapshot ID format/i);
});

test('secure approval replays the fixed release directory and preserves inputs', async () => {
  const setup = secureFixture('snapshot-secure-approve-');
  const candidateBefore = readFileSync(
    join(setup.release.releaseDir, 'candidate.json'),
  );
  try {
    const approved = await approveSnapshotFile(setup.options);
    assert.equal(approved.previousSnapshotId, setup.current.snapshotId);
    assert.deepEqual(
      validateApprovedSnapshot(approved, Date.parse(nextApprovedAt)),
      [],
    );
    assert.deepEqual(
      readFileSync(join(setup.release.releaseDir, 'candidate.json')),
      candidateBefore,
    );
  } finally {
    rmSync(setup.tempRoot, { recursive: true, force: true });
  }
});

test('secure approval rejects every replay or provenance drift byte-identically', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (setup: ReturnType<typeof secureFixture>) => void;
    pattern: RegExp;
  }> = [
    {
      name: 'forged gate digest',
      mutate: (setup) => {
        const path = join(setup.release.releaseDir, 'gate.json');
        const gate = JSON.parse(readFileSync(path, 'utf8'));
        gate.artifactDigests.bundleSha256 = 'f'.repeat(64);
        writeJson(path, gate);
      },
      pattern: /gate.*replay|replayed gate|digest/i,
    },
    {
      name: 'candidate drift',
      mutate: (setup) => {
        const path = join(setup.release.releaseDir, 'candidate.json');
        const value = JSON.parse(readFileSync(path, 'utf8'));
        value.opportunities[0].website =
          'https://cs.example.edu.cn/drifted';
        writeJson(path, value);
      },
      pattern: /candidate.*replayed|candidate.*differs/i,
    },
    {
      name: 'uncommitted pending ledger',
      mutate: (setup) => {
        const base = readFileSync(
          join(setup.release.releaseDir, 'pending-base.json'),
        );
        writeFileSync(setup.release.pendingCurrentPath, base);
      },
      pattern: /live pending|committed|pending-next/i,
    },
    {
      name: 'evidence artifact drift',
      mutate: (setup) => {
        writeFileSync(
          join(setup.release.releaseDir, 'artifacts', 'sentinel.txt'),
          'tampered evidence\n',
        );
      },
      pattern: /artifact.*sha256|artifact.*current file/i,
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, async () => {
      const setup = secureFixture(`snapshot-${currentCase.name}-`);
      const before = readFileSync(setup.approvedPath);
      currentCase.mutate(setup);
      try {
        await assert.rejects(
          approveSnapshotFile(setup.options),
          currentCase.pattern,
        );
        assert.deepEqual(readFileSync(setup.approvedPath), before);
      } finally {
        rmSync(setup.tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test('secure approval rejects symlinked inputs and pending-next aliasing', async (t) => {
  await t.test('symlinked candidate', async () => {
    const setup = secureFixture('snapshot-release-symlink-');
    const candidatePath = join(setup.release.releaseDir, 'candidate.json');
    const targetPath = join(setup.tempRoot, 'candidate-target.json');
    writeFileSync(targetPath, readFileSync(candidatePath));
    unlinkSync(candidatePath);
    symlinkSync(targetPath, candidatePath);
    try {
      await assert.rejects(
        approveSnapshotFile(setup.options),
        /candidate.*symlink/i,
      );
      assert.ok(lstatSync(candidatePath).isSymbolicLink());
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('pending-next hardlink', async () => {
    const setup = secureFixture('snapshot-pending-hardlink-');
    unlinkSync(setup.release.pendingCurrentPath);
    linkSync(
      join(setup.release.releaseDir, 'pending-next.json'),
      setup.release.pendingCurrentPath,
    );
    try {
      await assert.rejects(
        approveSnapshotFile(setup.options),
        /separately committed ledger|hardlink/i,
      );
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });
});

test('atomic cancellation and concurrent replacement preserve the latest current', async (t) => {
  await t.test('cancellation', async () => {
    const setup = secureFixture('snapshot-approval-cancel-');
    const before = readFileSync(setup.approvedPath);
    const controller = new AbortController();
    controller.abort(new Error('cancelled before approved rename'));
    try {
      await assert.rejects(
        approveSnapshotFile(setup.options, controller.signal),
        /cancelled before approved rename/i,
      );
      assert.deepEqual(readFileSync(setup.approvedPath), before);
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('concurrent replacement', async () => {
    const setup = secureFixture('snapshot-approval-race-');
    const concurrent = `${JSON.stringify({
      marker: 'concurrent replacement',
    })}\n`;
    const signal = {
      get aborted(): boolean {
        writeFileSync(setup.approvedPath, concurrent, 'utf8');
        return false;
      },
    } as AbortSignal;
    try {
      await assert.rejects(
        approveSnapshotFile(setup.options, signal),
        /changed concurrently/i,
      );
      assert.equal(readFileSync(setup.approvedPath, 'utf8'), concurrent);
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('replacement after the final fingerprint check is preserved', async () => {
    const setup = secureFixture('snapshot-approval-final-check-race-');
    const concurrent = `${JSON.stringify({
      marker: 'replacement after final fingerprint check',
    })}\n`;
    try {
      await assert.rejects(
        approveSnapshotFile(setup.options, undefined, {
          afterApprovedFingerprintCheck: async () => {
            writeFileSync(setup.approvedPath, concurrent, 'utf8');
          },
        }),
        /changed concurrently/i,
      );
      assert.equal(readFileSync(setup.approvedPath, 'utf8'), concurrent);
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });
});

test('atomic approved replacement keeps current readable while recovery is captured', async () => {
  const setup = secureFixture('snapshot-approval-readable-current-');
  let inspected = false;
  const hooks = {
    afterApprovedRecoveryLink: async () => {
      inspected = true;
      assert.equal(
        JSON.parse(readFileSync(setup.approvedPath, 'utf8')).snapshotId,
        setup.current.snapshotId,
      );
    },
  } as Parameters<typeof approveSnapshotFile>[2] & {
    afterApprovedRecoveryLink: () => Promise<void>;
  };
  try {
    await approveSnapshotFile(setup.options, undefined, hooks);
    assert.equal(inspected, true);
    assert.ok(existsSync(setup.approvedPath));
  } finally {
    rmSync(setup.tempRoot, { recursive: true, force: true });
  }
});

test('approval lock excludes a cooperating writer and is cleaned', async () => {
  const setup = secureFixture('snapshot-approval-lock-');
  const lockPath = join(
    dirname(setup.approvedPath),
    `.${setup.approvedPath.split('/').at(-1)}.lock`,
  );
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const releasePromise = new Promise<void>((resolvePromise) => {
    releaseFirst = resolvePromise;
  });
  const enteredPromise = new Promise<void>((resolvePromise) => {
    firstEntered = resolvePromise;
  });
  const first = approveSnapshotFile(setup.options, undefined, {
    beforeRename: async () => {
      firstEntered();
      await releasePromise;
    },
  });
  try {
    await enteredPromise;
    assert.ok(existsSync(lockPath));
    await assert.rejects(
      approveSnapshotFile(setup.options),
      /approval.*lock|another approval/i,
    );
    releaseFirst();
    await first;
    assert.equal(existsSync(lockPath), false);
  } finally {
    releaseFirst();
    await first.catch(() => undefined);
    rmSync(setup.tempRoot, { recursive: true, force: true });
  }
});

test('approval lock release preserves a replacement lock and excludes a third approval', async () => {
  const setup = secureFixture('snapshot-approval-lock-replaced-');
  const lockPath = join(
    dirname(setup.approvedPath),
    `.${setup.approvedPath.split('/').at(-1)}.lock`,
  );
  const replacementContents = `${JSON.stringify({
    token: '11111111-1111-4111-8111-111111111111',
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const releasePromise = new Promise<void>((resolvePromise) => {
    releaseFirst = resolvePromise;
  });
  const enteredPromise = new Promise<void>((resolvePromise) => {
    firstEntered = resolvePromise;
  });
  const first = approveSnapshotFile(setup.options, undefined, {
    beforeRename: async () => {
      firstEntered();
      await releasePromise;
    },
  });
  try {
    await enteredPromise;
    unlinkSync(lockPath);
    writeFileSync(lockPath, replacementContents, 'utf8');
    releaseFirst();
    await first;
    assert.equal(readFileSync(lockPath, 'utf8'), replacementContents);
    await assert.rejects(
      approveSnapshotFile(setup.options),
      /approval.*lock|another approval/i,
    );
    assert.equal(readFileSync(lockPath, 'utf8'), replacementContents);
  } finally {
    releaseFirst();
    await first.catch(() => undefined);
    rmSync(setup.tempRoot, { recursive: true, force: true });
  }
});

test('approval lock release restores a replacement introduced at the atomic release point', async () => {
  const setup = secureFixture('snapshot-approval-lock-final-race-');
  const lockPath = join(
    dirname(setup.approvedPath),
    `.${setup.approvedPath.split('/').at(-1)}.lock`,
  );
  const replacementContents = `${JSON.stringify({
    token: '22222222-2222-4222-8222-222222222222',
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  try {
    await approveSnapshotFile(setup.options, undefined, {
      beforeLockReleaseRename: async () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, replacementContents, 'utf8');
      },
    });
    assert.equal(readFileSync(lockPath, 'utf8'), replacementContents);
    await assert.rejects(
      approveSnapshotFile(setup.options),
      /approval.*lock|another approval/i,
    );
  } finally {
    rmSync(setup.tempRoot, { recursive: true, force: true });
  }
});

test('directory durability hooks distinguish pre-commit and post-commit failure', async (t) => {
  await t.test('directory open failure is pre-commit', async () => {
    const setup = secureFixture('snapshot-approval-dir-open-');
    const before = readFileSync(setup.approvedPath);
    try {
      await assert.rejects(
        approveSnapshotFile(setup.options, undefined, {
          openDirectory: async () => {
            throw new Error('injected directory open failure');
          },
        }),
        /directory open failure/i,
      );
      assert.deepEqual(readFileSync(setup.approvedPath), before);
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('post-rename sync failure still reports success', async () => {
    const setup = secureFixture('snapshot-approval-dir-sync-');
    try {
      const approved = await approveSnapshotFile(
        setup.options,
        undefined,
        {
          syncDirectory: async () => {
            throw new Error('injected post-rename sync failure');
          },
        },
      );
      assert.equal(approved.previousSnapshotId, setup.current.snapshotId);
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });
});

test('approve CLI uses only the fixed release directory contract', async (t) => {
  await t.test('success', () => {
    const setup = secureFixture('snapshot-approve-cli-');
    try {
      const result = runCli(approveCliPath, [
        '--release-dir',
        setup.release.releaseDir,
        '--approved',
        setup.approvedPath,
        '--pending-current',
        setup.release.pendingCurrentPath,
        '--approved-at',
        nextApprovedAt,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Approved snapshot/);
    } finally {
      rmSync(setup.tempRoot, { recursive: true, force: true });
    }
  });

  const cases: Array<[string, string[], RegExp]> = [
    [
      'legacy candidate flag',
      ['--candidate', 'a', '--approved', 'b', '--gate', 'g'],
      /unknown|usage/i,
    ],
    [
      'duplicate',
      [
        '--release-dir',
        'a',
        '--release-dir',
        'b',
        '--approved',
        'c',
        '--pending-current',
        'p',
      ],
      /duplicate/i,
    ],
    [
      'missing required',
      ['--release-dir', 'a', '--approved', 'b'],
      /required|usage/i,
    ],
  ];
  for (const [name, args, pattern] of cases) {
    await t.test(name, () => {
      const result = runCli(approveCliPath, args);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, pattern);
    });
  }
});

test('validate-current CLI prints counts and all integrity errors', async (t) => {
  await t.test('valid summary', () => {
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

  await t.test('tampered snapshot', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-errors-'));
    const approvedPath = join(tempRoot, 'current.json');
    const tampered = approveCandidate(
      candidate(),
      null,
      approvedAt,
    ) as Record<string, any>;
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
});

test('validate-current rejects symlink, directory, and invalid CLI arguments', async (t) => {
  await t.test('symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-validate-symlink-'));
    const targetPath = join(tempRoot, 'target.json');
    const approvedPath = join(tempRoot, 'current.json');
    writeJson(
      targetPath,
      approveCandidate(longLivedCandidate(), null, approvedAt),
    );
    symlinkSync(targetPath, approvedPath);
    try {
      const result = runCli(validateCliPath, ['--approved', approvedPath]);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /approved snapshot.*symlink/i,
      );
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
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /approved snapshot.*regular file/i,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('invalid arguments', () => {
    const result = runCli(validateCliPath, ['--wat', 'x']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /unknown|usage/i);
  });
});
