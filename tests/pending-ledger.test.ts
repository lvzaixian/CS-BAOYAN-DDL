import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNextPendingLedger,
  commitPendingLedger,
  parsePendingLedger,
  type PendingLedger,
  type PendingLedgerEntry,
  type PendingLedgerEvent,
  type PendingLedgerRun,
  type PendingUpdate,
} from '../scripts/snapshot/pending-ledger.js';

const RUN_1: PendingLedgerRun = {
  runId: '20260729-pending-1',
  scanStartedAt: '2026-07-29T00:00:00.000Z',
  scanFinishedAt: '2026-07-29T00:10:00.000Z',
};
const RUN_2: PendingLedgerRun = {
  runId: '20260729-pending-2',
  scanStartedAt: '2026-07-29T01:00:00.000Z',
  scanFinishedAt: '2026-07-29T01:10:00.000Z',
};
const RUN_3: PendingLedgerRun = {
  runId: '20260729-pending-3',
  scanStartedAt: '2026-07-29T02:00:00.000Z',
  scanFinishedAt: '2026-07-29T02:10:00.000Z',
};

type DurableIdentity = Pick<
  PendingUpdate,
  | 'scopeItemId'
  | 'school'
  | 'region'
  | 'targetId'
  | 'officialUrls'
  | 'nextAction'
>;

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

const LOCK_TOKEN_A = '11111111-1111-4111-8111-111111111111';
const LOCK_TOKEN_B = '22222222-2222-4222-8222-222222222222';

function ledgerDigest(ledger: PendingLedger): string {
  return createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: ledger.schemaVersion,
      current: {
        generation: ledger.current.generation,
        previousSha256: ledger.current.previousSha256,
        entries: ledger.current.entries,
      },
      history: ledger.history,
    }))
    .digest('hex');
}

function emptyLedger(): PendingLedger {
  const ledger: PendingLedger = {
    schemaVersion: 1,
    current: {
      generation: 0,
      sha256: '',
      previousSha256: null,
      entries: [],
    },
    history: [],
  };
  ledger.current.sha256 = ledgerDigest(ledger);
  return ledger;
}

function update(
  ledgerId: string,
  outcome: PendingUpdate['outcome'],
  checkedAt: string,
  reason: string,
  evidenceIds = [`evidence:${ledgerId}`],
  identity: Partial<DurableIdentity> = {},
): PendingUpdate {
  return {
    ledgerId,
    outcome,
    checkedAt,
    evidenceIds,
    reason,
    scopeItemId: identity.scopeItemId ?? `scope:${ledgerId}`,
    school: identity.school ?? '测试大学',
    region: identity.region ?? '华北',
    targetId: identity.targetId ?? `target:${ledgerId}`,
    officialUrls: identity.officialUrls === undefined
      ? [`https://yz.test.edu.cn/pending/${encodeURIComponent(ledgerId)}`]
      : [...identity.officialUrls],
    nextAction: identity.nextAction ?? '复核官方页面',
  };
}

function writeLedger(path: string, ledger: PendingLedger): void {
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

function writeLock(path: string, owner: LockOwner): void {
  writeFileSync(path, `${JSON.stringify(owner)}\n`, 'utf8');
}

function terminatedPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  assert.ok(child.pid > 0);
  assert.throws(
    () => process.kill(child.pid, 0),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ESRCH'
    ),
  );
  return child.pid;
}

test('parsePendingLedger accepts only the exact schema-v1 ledger shape', () => {
  const valid = emptyLedger();
  assert.deepEqual(parsePendingLedger(valid), valid);

  assert.throws(
    () => parsePendingLedger({ ...valid, unexpected: true }),
    /pending ledger\.unexpected is not allowed/i,
  );

  const unknownCurrent = structuredClone(valid) as PendingLedger & {
    current: PendingLedger['current'] & { unexpected: boolean };
  };
  unknownCurrent.current.unexpected = true;
  assert.throws(
    () => parsePendingLedger(unknownCurrent),
    /pending ledger\.current\.unexpected is not allowed/i,
  );

  const withHistory = buildNextPendingLedger(
    valid,
    [update('lead:bupt-cs', 'pending', '2026-07-29T00:05:00.000Z', 'official scope blocked')],
    RUN_1,
  );
  const unknownEvent = structuredClone(withHistory) as PendingLedger & {
    history: Array<PendingLedgerEvent & { unexpected?: boolean }>;
  };
  unknownEvent.history[0].unexpected = true;
  assert.throws(
    () => parsePendingLedger(unknownEvent),
    /pending ledger\.history\[0\]\.unexpected is not allowed/i,
  );

  const unknownEntry = structuredClone(withHistory);
  (unknownEntry.current.entries[0] as PendingLedgerEntry & {
    unexpected?: boolean;
  }).unexpected = true;
  assert.throws(
    () => parsePendingLedger(unknownEntry),
    /pending ledger\.current\.entries\[0\]\.unexpected is not allowed/i,
  );

  const missingEntryIdentity = structuredClone(withHistory);
  delete (
    missingEntryIdentity.current.entries[0] as Partial<PendingLedgerEntry>
  ).scopeItemId;
  assert.throws(
    () => parsePendingLedger(missingEntryIdentity),
    /pending ledger\.current\.entries\[0\]\.scopeItemId is required/i,
  );

  const missingEventIdentity = structuredClone(withHistory);
  delete (
    missingEventIdentity.history[0] as Partial<PendingLedgerEvent>
  ).nextAction;
  assert.throws(
    () => parsePendingLedger(missingEventIdentity),
    /pending ledger\.history\[0\]\.nextAction is required/i,
  );
});

test('current entries and history events preserve durable identity fields verbatim', () => {
  const identity: DurableIdentity = {
    scopeItemId: 'scope:bupt-computer-college',
    school: '北京邮电大学',
    region: '华北',
    targetId: 'college-notice:computer',
    officialUrls: [
      'https://scs.bupt.edu.cn/info/1050/12345.htm',
      'https://yzb.bupt.edu.cn/content/content.php?p=8_4_1',
    ],
    nextAction: '重试学院通知页并核对研究生报名系统',
  };
  const next = buildNextPendingLedger(
    emptyLedger(),
    [
      update(
        'lead:bupt-computer',
        'pending',
        '2026-07-29T00:05:00.000Z',
        'official college scope blocked',
        ['evidence:bupt-computer'],
        identity,
      ),
    ],
    RUN_1,
  );

  for (const persisted of [next.current.entries[0], next.history[0]]) {
    assert.deepEqual(
      {
        scopeItemId: persisted.scopeItemId,
        school: persisted.school,
        region: persisted.region,
        targetId: persisted.targetId,
        officialUrls: persisted.officialUrls,
        nextAction: persisted.nextAction,
      },
      identity,
    );
  }
});

test('buildNextPendingLedger requires exact durable identity update fields', () => {
  const missing = update(
    'lead:missing-identity',
    'pending',
    '2026-07-29T00:05:00.000Z',
    'blocked',
  );
  delete (missing as Partial<PendingUpdate>).school;
  assert.throws(
    () => buildNextPendingLedger(emptyLedger(), [missing], RUN_1),
    /updates\[0\]\.school is required/i,
  );

  const unknown = {
    ...update(
      'lead:unknown-identity',
      'pending',
      '2026-07-29T00:05:00.000Z',
      'blocked',
    ),
    unexpected: true,
  } as PendingUpdate;
  assert.throws(
    () => buildNextPendingLedger(emptyLedger(), [unknown], RUN_1),
    /updates\[0\]\.unexpected is not allowed/i,
  );
});

test('updates, current entries and history events reject invalid official URLs', () => {
  const invalidUpdates: Array<[string, RegExp]> = [
    ['not-a-url', /officialUrls\[0\] must be a valid HTTP\(S\) URL/i],
    ['ftp://yz.test.edu.cn/pending', /officialUrls\[0\] must be a credential-free HTTP\(S\) URL/i],
    [
      'https://user:secret@yz.test.edu.cn/pending',
      /officialUrls\[0\] must be a credential-free HTTP\(S\) URL/i,
    ],
    ['https://github.com/example/pending', /officialUrls\[0\] must be an official source/i],
  ];
  for (const [officialUrl, expected] of invalidUpdates) {
    assert.throws(
      () => buildNextPendingLedger(
        emptyLedger(),
        [
          update(
            'lead:invalid-url',
            'pending',
            '2026-07-29T00:05:00.000Z',
            'blocked',
            ['evidence:invalid-url'],
            { officialUrls: [officialUrl] },
          ),
        ],
        RUN_1,
      ),
      expected,
    );
  }

  const valid = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:url-parser', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const invalidEntry = structuredClone(valid);
  invalidEntry.current.entries[0].officialUrls = ['https://boardcaster.net/pending'];
  invalidEntry.current.sha256 = ledgerDigest(invalidEntry);
  assert.throws(
    () => parsePendingLedger(invalidEntry),
    /pending ledger\.current\.entries\[0\]\.officialUrls\[0\] must be an official source/i,
  );

  const resolved = buildNextPendingLedger(
    valid,
    [update('lead:url-parser', 'rejected', '2026-07-29T01:05:00.000Z', 'not applicable')],
    RUN_2,
  );
  const invalidEvent = structuredClone(resolved);
  invalidEvent.history[1].officialUrls = ['javascript:alert(1)'];
  invalidEvent.current.sha256 = ledgerDigest(invalidEvent);
  assert.throws(
    () => parsePendingLedger(invalidEvent),
    /pending ledger\.history\[1\]\.officialUrls\[0\] must be a credential-free HTTP\(S\) URL/i,
  );
});

test('parsePendingLedger and the reducer reject future run timestamps', () => {
  const first = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:future', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const resolved = buildNextPendingLedger(
    first,
    [update('lead:future', 'rejected', '2026-07-29T01:05:00.000Z', 'not applicable')],
    RUN_2,
  );
  const future = structuredClone(resolved);
  future.history[1].runFinishedAt = '2999-01-01T00:10:00.000Z';
  future.current.sha256 = ledgerDigest(future);

  assert.throws(
    () => parsePendingLedger(future),
    /runFinishedAt must not be in the future/i,
  );
  assert.throws(
    () => buildNextPendingLedger(resolved, [], {
      runId: 'future-run',
      scanStartedAt: '2999-01-01T00:00:00.000Z',
      scanFinishedAt: '2999-01-01T00:10:00.000Z',
    }),
    /scanFinishedAt must not be in the future/i,
  );
});

test('every unresolved previous entry requires exactly one current-run update', () => {
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [
      update('lead:a', 'pending', '2026-07-29T00:05:00.000Z', 'blocked A'),
      update('lead:b', 'pending', '2026-07-29T00:06:00.000Z', 'blocked B'),
    ],
    RUN_1,
  );
  const previousBefore = structuredClone(previous);

  assert.throws(
    () => buildNextPendingLedger(
      previous,
      [update('lead:a', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked A')],
      RUN_2,
    ),
    /lead:b.*exactly one current-run update/i,
  );
  assert.throws(
    () => buildNextPendingLedger(
      previous,
      [
        update('lead:a', 'pending', '2026-07-29T01:04:00.000Z', 'still blocked A'),
        update('lead:a', 'pending', '2026-07-29T01:05:00.000Z', 'duplicate A'),
        update('lead:b', 'hard-error', '2026-07-29T01:06:00.000Z', 'failed B'),
      ],
      RUN_2,
    ),
    /lead:a.*exactly one current-run update/i,
  );

  const next = buildNextPendingLedger(
    previous,
    [
      update('lead:b', 'hard-error', '2026-07-29T01:06:00.000Z', 'failed B'),
      update('lead:a', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked A'),
    ],
    RUN_2,
  );

  assert.deepEqual(previous, previousBefore, 'the pure reducer must not mutate its input');
  assert.equal(next.current.generation, previous.current.generation + 1);
  assert.equal(next.current.previousSha256, previous.current.sha256);
  assert.deepEqual(next.current.entries.map((entry) => entry.ledgerId), ['lead:a', 'lead:b']);
  assert.equal(
    next.history.filter((event) => event.runId === RUN_2.runId).length,
    2,
  );
  assert.deepEqual(
    next.history
      .filter((event) => event.runId === RUN_2.runId)
      .map((event) => event.ledgerId),
    ['lead:a', 'lead:b'],
  );
});

test('new and repeated pending evidence keeps one current entry while appending immutable history', () => {
  const first = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:bupt-cs', 'pending', '2026-07-29T00:05:00.000Z', 'official scope blocked')],
    RUN_1,
  );
  assert.equal(first.current.entries.length, 1);
  assert.equal(first.history.length, 1);

  const second = buildNextPendingLedger(
    first,
    [update('lead:bupt-cs', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  assert.equal(second.current.entries.length, 1);
  assert.equal(second.history.length, 2);
  assert.deepEqual(second.history.slice(0, first.history.length), first.history);
  assert.equal(second.current.entries[0].reason, 'still blocked');

  const resolved = buildNextPendingLedger(
    second,
    [
      update(
        'lead:bupt-cs',
        'promoted-active',
        '2026-07-29T02:05:00.000Z',
        'official project became readable',
      ),
    ],
    RUN_3,
  );
  assert.deepEqual(resolved.current.entries, []);
  assert.deepEqual(
    resolved.history.map((event) => event.outcome),
    ['pending', 'pending', 'promoted-active'],
  );
  assert.deepEqual(resolved.history.slice(0, second.history.length), second.history);
  assert.deepEqual(parsePendingLedger(resolved), resolved);
});

test('commitPendingLedger rejects stale generation and digest, then atomically replaces current', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-cas-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:cas', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:cas', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  const before = readFileSync(ledgerPath);

  try {
    const invalidNext = structuredClone(next);
    invalidNext.current.entries[0].officialUrls = ['https://github.com/example/pending'];
    invalidNext.current.sha256 = ledgerDigest(invalidNext);
    await assert.rejects(
      commitPendingLedger(
        ledgerPath,
        previous.current.generation,
        previous.current.sha256,
        invalidNext,
      ),
      /officialUrls\[0\] must be an official source/i,
    );
    assert.deepEqual(readFileSync(ledgerPath), before);

    await assert.rejects(
      commitPendingLedger(
        ledgerPath,
        previous.current.generation + 1,
        previous.current.sha256,
        next,
      ),
      /stale pending ledger generation/i,
    );
    assert.deepEqual(readFileSync(ledgerPath), before);

    await assert.rejects(
      commitPendingLedger(
        ledgerPath,
        previous.current.generation,
        'f'.repeat(64),
        next,
      ),
      /stale pending ledger digest/i,
    );
    assert.deepEqual(readFileSync(ledgerPath), before);

    await commitPendingLedger(
      ledgerPath,
      previous.current.generation,
      previous.current.sha256,
      next,
    );
    assert.deepEqual(
      parsePendingLedger(JSON.parse(readFileSync(ledgerPath, 'utf8'))),
      next,
    );
    assert.deepEqual(readdirSync(tempRoot), [basename(ledgerPath)]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commitPendingLedger rejects a live sibling owner even after the stale threshold', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-lock-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:lock', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:lock', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  const owner: LockOwner = {
    token: LOCK_TOKEN_A,
    pid: process.pid,
    createdAt: new Date(Date.now() - (2 * 60 * 60 * 1_000)).toISOString(),
  };
  writeLock(lockPath, owner);
  const before = readFileSync(ledgerPath);
  const lockBefore = readFileSync(lockPath);

  try {
    await assert.rejects(
      commitPendingLedger(
        ledgerPath,
        previous.current.generation,
        previous.current.sha256,
        next,
      ),
      /pending ledger is locked by another writer/i,
    );
    assert.deepEqual(readFileSync(ledgerPath), before);
    assert.deepEqual(readFileSync(lockPath), lockBefore);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commitPendingLedger fails closed for a fresh lock whose owner has exited', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-fresh-lock-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:fresh-lock', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:fresh-lock', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  writeLock(lockPath, {
    token: LOCK_TOKEN_A,
    pid: terminatedPid(),
    createdAt: new Date().toISOString(),
  });
  const before = readFileSync(ledgerPath);
  const lockBefore = readFileSync(lockPath);

  try {
    await assert.rejects(
      commitPendingLedger(
        ledgerPath,
        previous.current.generation,
        previous.current.sha256,
        next,
      ),
      /pending ledger is locked by another writer/i,
    );
    assert.deepEqual(readFileSync(ledgerPath), before);
    assert.deepEqual(readFileSync(lockPath), lockBefore);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commitPendingLedger fails closed when lock ownership cannot be disproved', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-unknown-owner-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:unknown-owner', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:unknown-owner', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  writeLock(lockPath, {
    token: LOCK_TOKEN_A,
    pid: 1,
    createdAt: new Date(Date.now() - (2 * 60 * 60 * 1_000)).toISOString(),
  });
  const before = readFileSync(ledgerPath);
  const lockBefore = readFileSync(lockPath);

  try {
    await assert.rejects(
      commitPendingLedger(
        ledgerPath,
        previous.current.generation,
        previous.current.sha256,
        next,
      ),
      /pending ledger is locked by another writer/i,
    );
    assert.deepEqual(readFileSync(ledgerPath), before);
    assert.deepEqual(readFileSync(lockPath), lockBefore);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commitPendingLedger fails closed for malformed owner metadata', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-malformed-lock-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:malformed-lock', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:malformed-lock', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  const before = readFileSync(ledgerPath);
  const old = new Date(Date.now() - (2 * 60 * 60 * 1_000)).toISOString();
  const malformed = [
    'held\n',
    `${JSON.stringify({ token: LOCK_TOKEN_A, pid: terminatedPid() })}\n`,
    `${JSON.stringify({
      token: LOCK_TOKEN_A,
      pid: terminatedPid(),
      createdAt: old,
      unexpected: true,
    })}\n`,
    `${JSON.stringify({ token: 'not-a-token', pid: terminatedPid(), createdAt: old })}\n`,
    `${JSON.stringify({ token: LOCK_TOKEN_A, pid: 0, createdAt: old })}\n`,
    `${JSON.stringify({ token: LOCK_TOKEN_A, pid: terminatedPid(), createdAt: 'not-a-date' })}\n`,
    `${JSON.stringify({
      token: LOCK_TOKEN_A,
      pid: terminatedPid(),
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    })}\n`,
  ];

  try {
    for (const contents of malformed) {
      writeFileSync(lockPath, contents, 'utf8');
      await assert.rejects(
        commitPendingLedger(
          ledgerPath,
          previous.current.generation,
          previous.current.sha256,
          next,
        ),
        /pending ledger is locked by another writer/i,
      );
      assert.deepEqual(readFileSync(ledgerPath), before);
      assert.equal(readFileSync(lockPath, 'utf8'), contents);
      rmSync(lockPath, { force: true });
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commitPendingLedger recovers a stale lock only after its owner has exited', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-stale-lock-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:stale-lock', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:stale-lock', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  writeLock(lockPath, {
    token: LOCK_TOKEN_A,
    pid: terminatedPid(),
    createdAt: new Date(Date.now() - (2 * 60 * 60 * 1_000)).toISOString(),
  });

  try {
    await commitPendingLedger(
      ledgerPath,
      previous.current.generation,
      previous.current.sha256,
      next,
    );
    assert.deepEqual(
      parsePendingLedger(JSON.parse(readFileSync(ledgerPath, 'utf8'))),
      next,
    );
    assert.deepEqual(readdirSync(tempRoot), [basename(ledgerPath)]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent stale-lock recovery still permits exactly one CAS writer', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-stale-race-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [update('lead:stale-race', 'pending', '2026-07-29T00:05:00.000Z', 'blocked')],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:stale-race', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  writeLock(lockPath, {
    token: LOCK_TOKEN_A,
    pid: terminatedPid(),
    createdAt: new Date(Date.now() - (2 * 60 * 60 * 1_000)).toISOString(),
  });

  try {
    const outcomes = await Promise.allSettled([
      commitPendingLedger(
        ledgerPath,
        previous.current.generation,
        previous.current.sha256,
        next,
      ),
      commitPendingLedger(
        ledgerPath,
        previous.current.generation,
        previous.current.sha256,
        next,
      ),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'rejected').length,
      1,
    );
    assert.deepEqual(
      parsePendingLedger(JSON.parse(readFileSync(ledgerPath, 'utf8'))),
      next,
    );
    assert.deepEqual(readdirSync(tempRoot), [basename(ledgerPath)]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commitPendingLedger atomically publishes strict owner metadata', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-lock-owner-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [
      update(
        'lead:lock-owner',
        'pending',
        '2026-07-29T00:05:00.000Z',
        'blocked '.repeat(100_000),
      ),
    ],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:lock-owner', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  writeLedger(ledgerPath, previous);
  let contents = '';

  try {
    await commitPendingLedger(
      ledgerPath,
      previous.current.generation,
      previous.current.sha256,
      next,
      {
        afterLockAcquired: (observedLockPath) => {
          contents = readFileSync(observedLockPath, 'utf8');
        },
      },
    );
    const owner = JSON.parse(contents) as LockOwner;
    assert.deepEqual(
      Object.keys(owner).sort(),
      ['createdAt', 'pid', 'token'],
    );
    assert.match(
      owner.token,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    assert.equal(owner.pid, process.pid);
    assert.equal(new Date(owner.createdAt).toISOString(), owner.createdAt);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commitPendingLedger release preserves a replacement lock with another token', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pending-ledger-lock-release-'));
  const ledgerPath = join(tempRoot, 'pending.json');
  const lockPath = join(tempRoot, '.pending.json.lock');
  const previous = buildNextPendingLedger(
    emptyLedger(),
    [
      update(
        'lead:lock-release',
        'pending',
        '2026-07-29T00:05:00.000Z',
        'blocked '.repeat(100_000),
      ),
    ],
    RUN_1,
  );
  const next = buildNextPendingLedger(
    previous,
    [update('lead:lock-release', 'pending', '2026-07-29T01:05:00.000Z', 'still blocked')],
    RUN_2,
  );
  const replacement: LockOwner = {
    token: LOCK_TOKEN_B,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  writeLedger(ledgerPath, previous);

  try {
    await commitPendingLedger(
      ledgerPath,
      previous.current.generation,
      previous.current.sha256,
      next,
      {
        afterLockAcquired: (observedLockPath) => {
          rmSync(observedLockPath, { force: true });
          writeLock(observedLockPath, replacement);
        },
      },
    );
    assert.deepEqual(
      JSON.parse(readFileSync(lockPath, 'utf8')),
      replacement,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
