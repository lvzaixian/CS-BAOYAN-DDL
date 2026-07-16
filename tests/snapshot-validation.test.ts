import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { validateCandidate, validateSnapshot } from '../src/lib/snapshot-validation.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-valid.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const nowMs = Date.parse('2026-07-16T00:00:00+08:00');

function validSnapshot(): Record<string, any> {
  return structuredClone(fixture);
}

function validCandidate(): Record<string, any> {
  const candidate = validSnapshot();
  delete candidate.snapshotId;
  delete candidate.approvedAt;
  delete candidate.previousSnapshotId;
  delete candidate.dataHash;
  return candidate;
}

function validLegacySnapshotV1(): Record<string, any> {
  const snapshot = validSnapshot();
  snapshot.schemaVersion = 1;
  for (const opportunity of snapshot.opportunities) {
    delete opportunity.eventArrangement;
  }
  return snapshot;
}

function setOnlyOpportunityStatus(
  snapshot: Record<string, any>,
  status: 'confirmed-open' | 'confirmed-unknown-deadline' | 'expired',
  deadline: string | null,
): void {
  snapshot.opportunities[0].verificationStatus = status;
  snapshot.opportunities[0].deadline = deadline;
  snapshot.opportunities[0].deadlineEpochMs = deadline === null ? null : Date.parse(deadline);
  snapshot.counts.confirmedOpen = status === 'confirmed-open' ? 1 : 0;
  snapshot.counts.confirmedUnknownDeadline =
    status === 'confirmed-unknown-deadline' ? 1 : 0;
  snapshot.counts.expired = status === 'expired' ? 1 : 0;
}

const privateValueCases: Array<{
  name: string;
  path: string;
  mutate: (snapshot: Record<string, any>) => void;
}> = [
  {
    name: 'email address',
    path: 'snapshot.opportunities[0].description',
    mutate: (value) => (value.opportunities[0].description = '联系 student@example.com'),
  },
  {
    name: 'Chinese mainland mobile number',
    path: 'snapshot.opportunities[0].logistics.summary',
    mutate: (value) => (value.opportunities[0].logistics.summary = '咨询 138-0013-8000'),
  },
  {
    name: 'compact international Chinese mainland mobile number',
    path: 'snapshot.opportunities[0].description',
    mutate: (value) => (value.opportunities[0].description = '咨询 +8613800138000'),
  },
  {
    name: 'spaced international Chinese mainland mobile number',
    path: 'snapshot.opportunities[0].logistics.summary',
    mutate: (value) => (value.opportunities[0].logistics.summary = '咨询 +86 138 0013 8000'),
  },
  {
    name: 'hyphenated international Chinese mainland mobile number',
    path: 'snapshot.opportunities[0].materials.summary',
    mutate: (value) => (value.opportunities[0].materials.summary = '咨询 +86-138-0013-8000'),
  },
  {
    name: 'encoded international Chinese mainland mobile number',
    path: 'snapshot.opportunities[0].recommendation.summary',
    mutate: (value) =>
      (value.opportunities[0].recommendation.summary = '咨询 %2B8613800138000'),
  },
  {
    name: 'macOS user-local path',
    path: 'snapshot.opportunities[0].materials.summary',
    mutate: (value) => (value.opportunities[0].materials.summary = '/Users/alice/private.json'),
  },
  {
    name: 'Linux user-local path',
    path: 'snapshot.opportunities[0].discoverySources[0].label',
    mutate: (value) =>
      (value.opportunities[0].discoverySources[0].label = '/home/alice/private.json'),
  },
  {
    name: 'Windows user-local path',
    path: 'snapshot.opportunities[0].recommendation.summary',
    mutate: (value) =>
      (value.opportunities[0].recommendation.summary = String.raw`C:\Users\Alice\private.json`),
  },
  {
    name: 'file URI',
    path: 'snapshot.opportunities[0].tags[0]',
    mutate: (value) => (value.opportunities[0].tags[0] = 'file:///Users/alice/private.json'),
  },
  {
    name: 'submitted marker',
    path: 'snapshot.opportunities[0].project',
    mutate: (value) => (value.opportunities[0].project = 'submittedProjectIds'),
  },
  {
    name: 'welfare marker',
    path: 'snapshot.opportunities[0].eventType',
    mutate: (value) => (value.opportunities[0].eventType = 'welfareScore'),
  },
  {
    name: 'recommendation tier marker',
    path: 'snapshot.opportunities[0].institute',
    mutate: (value) => (value.opportunities[0].institute = 'recommendationTier=A'),
  },
  {
    name: 'private profile target marker',
    path: 'snapshot.feeds[0].label',
    mutate: (value) => (value.feeds[0].label = 'profile_space/targets/private'),
  },
  {
    name: 'double-encoded email address',
    path: 'snapshot.opportunities[0].description',
    mutate: (value) => (value.opportunities[0].description = '联系 student%2540example.com'),
  },
  {
    name: 'encoded private profile target marker',
    path: 'snapshot.opportunities[0].materials.summary',
    mutate: (value) =>
      (value.opportunities[0].materials.summary = 'profile_space%2Ftargets%2Fprivate'),
  },
  {
    name: 'double-encoded private profile target marker',
    path: 'snapshot.opportunities[0].recommendation.summary',
    mutate: (value) =>
      (value.opportunities[0].recommendation.summary =
        'profile_space%252Ftargets%252Fprivate'),
  },
];

test('accepts valid v2 approved snapshots and candidates', () => {
  assert.deepEqual(validateSnapshot(validSnapshot(), nowMs), []);
  assert.deepEqual(validateCandidate(validCandidate(), nowMs), []);
});

test('strictly reads historical v1 approved snapshots but never v1 candidates', () => {
  const legacy = validLegacySnapshotV1();

  assert.deepEqual(validateSnapshot(legacy, nowMs), []);
  const candidate = structuredClone(legacy);
  delete candidate.snapshotId;
  delete candidate.approvedAt;
  delete candidate.previousSnapshotId;
  delete candidate.dataHash;
  assert.match(validateCandidate(candidate, nowMs).join('\n'), /schemaVersion.*exactly 2/i);
});

test('rejects eventArrangement on v1 opportunities', () => {
  const legacy = validLegacySnapshotV1();
  legacy.opportunities[0].eventArrangement = structuredClone(
    validSnapshot().opportunities[0].eventArrangement,
  );

  assert.match(
    validateSnapshot(legacy, nowMs).join('\n'),
    /eventArrangement.*unknown propert/i,
  );
});

test('rejects duplicate projectId values', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities.push(structuredClone(snapshot.opportunities[0]));
  snapshot.counts.confirmedOpen = 2;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /duplicate projectId/i);
});

test('rejects baoyantongzhi.com as the official website', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].website = 'https://baoyantongzhi.com/notice/1';

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /website.*denied/i);
});

test('rejects an expired deadline epoch on a confirmed-open row', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].deadline = '2026-07-15T23:59:00+08:00';
  snapshot.opportunities[0].deadlineEpochMs = Date.parse(snapshot.opportunities[0].deadline);

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /confirmed-open.*future/i);
});

test('candidate rejects private values with their public field paths', async (t) => {
  for (const { name, path, mutate } of privateValueCases) {
    await t.test(name, () => {
      const candidate = validCandidate();
      mutate(candidate);

      const errors = validateCandidate(candidate, nowMs).join('\n');
      assert.match(errors, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }
});

test('approved snapshot rejects private values with their public field paths', async (t) => {
  for (const { name, path, mutate } of privateValueCases) {
    await t.test(name, () => {
      const snapshot = validSnapshot();
      mutate(snapshot);

      const errors = validateSnapshot(snapshot, nowMs).join('\n');
      assert.match(errors, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }
});

test('privacy validation does not reject normal public URLs or embedded long URL IDs', () => {
  const candidate = validCandidate();
  candidate.opportunities[0].description =
    'Application submitted successfully. Student welfare information: https://apply.example.edu.cn/application-submitted/student-welfare/84d17857554739?channel=public';
  const snapshot = validSnapshot();
  snapshot.opportunities[0].description = candidate.opportunities[0].description;

  assert.deepEqual(validateCandidate(candidate, nowMs), []);
  assert.deepEqual(validateSnapshot(snapshot, nowMs), []);
});

test('privacy validation matches exact private keys but not similarly named keys', () => {
  const privateCandidate = validCandidate();
  privateCandidate.opportunities[0].recommendationTier = 'A';
  const privateErrors = validateCandidate(privateCandidate, nowMs).join('\n');
  assert.match(
    privateErrors,
    /snapshot\.opportunities\[0\]\.recommendationTier: contains a private publication marker/i,
  );

  const publicCandidate = validCandidate();
  publicCandidate.opportunities[0].recommendationTierLabel = 'Public recommendation label';
  const publicErrors = validateCandidate(publicCandidate, nowMs).join('\n');
  assert.doesNotMatch(publicErrors, /private publication marker/i);
});

test('malformed percent encoding does not throw or create a privacy error', () => {
  const candidate = validCandidate();
  candidate.opportunities[0].description = '公开说明 %E0%A4%A';

  assert.doesNotThrow(() => validateCandidate(candidate, nowMs));
  assert.deepEqual(validateCandidate(candidate, nowMs), []);
});

test('privacy validation scans only present sparse-array entries', () => {
  const candidate = validCandidate();
  const sparse: unknown[] = [];
  sparse[1_000_000_000] = 'private@example.com';
  candidate.untrustedExtension = sparse;

  const startedAt = performance.now();
  const errors = validateCandidate(candidate, nowMs).join('\n');

  assert.ok(performance.now() - startedAt < 1_000, 'sparse-array validation took too long');
  assert.match(errors, /snapshot\.untrustedExtension\[1000000000\].*email address/i);
});

test('privacy validation fails closed at its nesting-depth limit', () => {
  const candidate = validCandidate();
  let cursor: Record<string, unknown> = candidate;

  for (let depth = 0; depth < 300; depth += 1) {
    const child: Record<string, unknown> = {};
    cursor.untrustedExtension = child;
    cursor = child;
  }

  assert.match(
    validateCandidate(candidate, nowMs).join('\n'),
    /privacy scan exceeded depth budget/i,
  );
});

test('privacy validation fails closed at its node limit', () => {
  const candidate = validCandidate();
  candidate.untrustedExtension = Object.fromEntries(
    Array.from({ length: 50_001 }, (_, index) => [`public${index}`, index]),
  );

  assert.match(
    validateCandidate(candidate, nowMs).join('\n'),
    /privacy scan exceeded node budget/i,
  );
});

test('candidate rejects every approval-only metadata field', async (t) => {
  for (const key of ['snapshotId', 'approvedAt', 'previousSnapshotId', 'dataHash']) {
    await t.test(key, () => {
      const candidate = validCandidate();
      candidate[key] = fixture[key];
      assert.match(validateCandidate(candidate, nowMs).join('\n'), /unknown propert/i);
    });
  }
});

test('approved snapshot requires every approval metadata field', async (t) => {
  for (const key of ['snapshotId', 'approvedAt', 'previousSnapshotId', 'dataHash']) {
    await t.test(key, () => {
      const snapshot = validSnapshot();
      delete snapshot[key];
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /missing propert/i);
    });
  }
});

test('accepts uppercase hexadecimal dataHash without recomputing it', () => {
  const snapshot = validSnapshot();
  snapshot.dataHash = 'A'.repeat(64);

  assert.deepEqual(validateSnapshot(snapshot, nowMs), []);
});

test('rejects dataHash unless it is exactly 64 hexadecimal characters', async (t) => {
  for (const hash of ['0'.repeat(63), '0'.repeat(65), `${'0'.repeat(63)}g`]) {
    await t.test(hash.length.toString(), () => {
      const snapshot = validSnapshot();
      snapshot.dataHash = hash;
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /dataHash.*64.*hexadecimal/i);
    });
  }
});

test('previousSnapshotId must be a string or null', () => {
  const snapshot = validSnapshot();
  snapshot.previousSnapshotId = 42;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /previousSnapshotId.*string.*null/i);
});

test('snapshot schemaVersion must be exactly 1 or 2', () => {
  const snapshot = validSnapshot();
  snapshot.schemaVersion = 3;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /schemaVersion.*1 or 2/i);
});

test('requires an exact eventArrangement shape on v2 opportunities', async (t) => {
  const cases: Array<[string, (arrangement: Record<string, any>) => void, RegExp]> = [
    ['missing mode', (value) => delete value.mode, /eventArrangement\.mode.*missing propert/i],
    ['missing time', (value) => delete value.time, /eventArrangement\.time.*missing propert/i],
    [
      'missing formatLocation',
      (value) => delete value.formatLocation,
      /eventArrangement\.formatLocation.*missing propert/i,
    ],
    ['invalid mode', (value) => (value.mode = 'onsite'), /eventArrangement\.mode.*allowed/i],
    ['extra key', (value) => (value.source = 'private'), /eventArrangement\.source.*unknown propert/i],
    [
      'invalid time fact',
      (value) => (value.time.extra = true),
      /eventArrangement\.time\.extra.*unknown propert/i,
    ],
    [
      'invalid location fact',
      (value) => (value.formatLocation.status = 'guessed'),
      /eventArrangement\.formatLocation\.status.*allowed/i,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const snapshot = validSnapshot();
      mutate(snapshot.opportunities[0].eventArrangement);
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), pattern);
    });
  }
});

test('requires eventArrangement on v2 opportunities', () => {
  const snapshot = validSnapshot();
  delete snapshot.opportunities[0].eventArrangement;

  assert.match(
    validateSnapshot(snapshot, nowMs).join('\n'),
    /eventArrangement.*missing propert/i,
  );
});

const unknownPropertyCases: Array<{
  name: string;
  path: string;
  mutate: (snapshot: Record<string, any>) => void;
}> = [
  { name: 'snapshot', path: 'snapshot', mutate: (value) => (value.extra = true) },
  { name: 'counts', path: 'counts', mutate: (value) => (value.counts.extra = true) },
  { name: 'feed', path: 'feeds[0]', mutate: (value) => (value.feeds[0].extra = true) },
  {
    name: 'opportunity',
    path: 'opportunities[0]',
    mutate: (value) => (value.opportunities[0].extra = true),
  },
  {
    name: 'discovery source',
    path: 'discoverySources[0]',
    mutate: (value) => (value.opportunities[0].discoverySources[0].extra = true),
  },
  {
    name: 'fact group',
    path: 'logistics',
    mutate: (value) => (value.opportunities[0].logistics.extra = true),
  },
  {
    name: 'event arrangement',
    path: 'eventArrangement',
    mutate: (value) => (value.opportunities[0].eventArrangement.extra = true),
  },
];

for (const { name, path, mutate } of unknownPropertyCases) {
  test(`rejects unknown properties on ${name} objects`, () => {
    const snapshot = validSnapshot();
    mutate(snapshot);

    const errors = validateSnapshot(snapshot, nowMs).join('\n');
    assert.match(errors, /unknown propert/i);
    assert.match(errors, new RegExp(path.replace(/[\[\]]/g, '\\$&'), 'i'));
  });
}

test('rejects missing required opportunity properties', () => {
  const snapshot = validSnapshot();
  delete snapshot.opportunities[0].eventType;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /eventType.*missing propert/i);
});

test('returns errors instead of throwing for malformed input', async (t) => {
  for (const input of [undefined, null, [], 'snapshot', 1]) {
    await t.test(String(input), () => {
      assert.doesNotThrow(() => validateCandidate(input, nowMs));
      assert.doesNotThrow(() => validateSnapshot(input, nowMs));
      assert.ok(validateCandidate(input, nowMs).length > 0);
      assert.ok(validateSnapshot(input, nowMs).length > 0);
    });
  }
});

test('returns errors instead of throwing for malformed nested values', () => {
  const snapshot = validSnapshot();
  snapshot.feeds = null;
  snapshot.opportunities = [null];

  assert.doesNotThrow(() => validateSnapshot(snapshot, nowMs));
  assert.ok(validateSnapshot(snapshot, nowMs).length > 0);
});

test('rejects invalid timestamp syntax and impossible calendar timestamps', async (t) => {
  const cases = [
    { name: 'scanAt', mutate: (value: Record<string, any>) => (value.scanAt = 'July 15, 2026') },
    {
      name: 'approvedAt',
      mutate: (value: Record<string, any>) => (value.approvedAt = '2026-02-30T12:00:00Z'),
    },
    {
      name: 'verifiedAt',
      mutate: (value: Record<string, any>) =>
        (value.opportunities[0].verifiedAt = 'not-a-timestamp'),
    },
  ];

  for (const { name, mutate } of cases) {
    await t.test(name, () => {
      const snapshot = validSnapshot();
      mutate(snapshot);
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), new RegExp(`${name}.*ISO`, 'i'));
    });
  }
});

test('rejects malformed website and discovery source URLs', async (t) => {
  await t.test('website', () => {
    const snapshot = validSnapshot();
    snapshot.opportunities[0].website = 'not a URL';
    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /website.*URL/i);
  });

  await t.test('discovery source', () => {
    const snapshot = validSnapshot();
    snapshot.opportunities[0].discoverySources[0].url = 'not a URL';
    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /discoverySources\[0\]\.url.*URL/i);
  });
});

test('rejects unsupported status and source enum values', async (t) => {
  const cases = [
    {
      name: 'verification status',
      pattern: /verificationStatus.*allowed value/i,
      mutate: (value: Record<string, any>) =>
        (value.opportunities[0].verificationStatus = 'pending'),
    },
    {
      name: 'fact status',
      pattern: /logistics\.status.*allowed value/i,
      mutate: (value: Record<string, any>) => (value.opportunities[0].logistics.status = 'maybe'),
    },
    {
      name: 'source kind',
      pattern: /discoverySources\[0\]\.kind.*allowed value/i,
      mutate: (value: Record<string, any>) =>
        (value.opportunities[0].discoverySources[0].kind = 'blog'),
    },
  ];

  for (const { name, pattern, mutate } of cases) {
    await t.test(name, () => {
      const snapshot = validSnapshot();
      mutate(snapshot);
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), pattern);
    });
  }
});

test('feed IDs must be unique and non-empty', async (t) => {
  await t.test('non-empty', () => {
    const snapshot = validSnapshot();
    snapshot.feeds[0].id = '';
    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /feeds\[0\]\.id.*non-empty/i);
  });

  await t.test('unique', () => {
    const snapshot = validSnapshot();
    snapshot.feeds.push({ ...snapshot.feeds[0], label: '重复 feed' });
    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /duplicate feed id/i);
  });
});

test('defaultFeedId must identify a declared feed', () => {
  const snapshot = validSnapshot();
  snapshot.defaultFeedId = 'missing-feed';

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /defaultFeedId.*known feed/i);
});

test('every opportunity must reference a declared feed', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].feedId = 'missing-feed';

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /feedId.*known feed/i);
});

test('feed eventYear must be a number', () => {
  const snapshot = validSnapshot();
  snapshot.feeds[0].eventYear = '2026';

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /eventYear.*number/i);
});

test('province is optional but must be a string when present', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].province = 1;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /province.*string/i);
});

test('every opportunity must have an explicitly official discovery source', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].discoverySources[0].kind = 'cs-baoyan';

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /official discovery source/i);
});

test('rejects every denied discovery host as the official website', async (t) => {
  for (const host of ['ddl.csbaoyan.top', 'github.com', 'www.baoyantongzhi.com']) {
    await t.test(host, () => {
      const snapshot = validSnapshot();
      snapshot.opportunities[0].website = `https://${host}/notice/1`;
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /website.*denied/i);
    });
  }
});

test('confirmed-open requires a non-null finite deadline epoch', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].deadline = null;
  snapshot.opportunities[0].deadlineEpochMs = null;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /confirmed-open.*deadline/i);
});

test('confirmed-open deadline epoch must match its normalized timestamp', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].deadlineEpochMs += 1;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /deadlineEpochMs.*match/i);
});

test('rejects null deadlineOriginal', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].deadlineOriginal = null;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /deadlineOriginal.*string/i);
});

test('confirmed-unknown-deadline requires null deadline fields', () => {
  const snapshot = validSnapshot();
  setOnlyOpportunityStatus(snapshot, 'confirmed-unknown-deadline', null);
  snapshot.opportunities[0].deadline = '2026-07-20T23:59:00+08:00';

  assert.match(
    validateSnapshot(snapshot, nowMs).join('\n'),
    /confirmed-unknown-deadline.*null deadline/i,
  );
});

test('accepts a confirmed-unknown-deadline row with null deadline fields', () => {
  const snapshot = validSnapshot();
  setOnlyOpportunityStatus(snapshot, 'confirmed-unknown-deadline', null);

  assert.deepEqual(validateSnapshot(snapshot, nowMs), []);
});

test('expired rows cannot carry a future active deadline', () => {
  const snapshot = validSnapshot();
  setOnlyOpportunityStatus(snapshot, 'expired', '2026-07-20T23:59:00+08:00');

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /expired.*future/i);
});

test('accepts an expired row with a normalized past deadline', () => {
  const snapshot = validSnapshot();
  setOnlyOpportunityStatus(snapshot, 'expired', '2026-07-15T23:59:00+08:00');

  assert.deepEqual(validateSnapshot(snapshot, nowMs), []);
});

test('status counts must match opportunity rows', async (t) => {
  for (const key of ['confirmedOpen', 'confirmedUnknownDeadline', 'expired']) {
    await t.test(key, () => {
      const snapshot = validSnapshot();
      snapshot.counts[key] += 1;
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), new RegExp(`${key}.*match`, 'i'));
    });
  }
});

test('pendingExcluded must be a nonnegative integer', async (t) => {
  for (const value of [-1, 0.5, Number.NaN]) {
    await t.test(String(value), () => {
      const snapshot = validSnapshot();
      snapshot.counts.pendingExcluded = value;
      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /pendingExcluded.*nonnegative integer/i);
    });
  }
});

test('timed active rows must be ascending by deadline epoch', () => {
  const snapshot = validSnapshot();
  const later = structuredClone(snapshot.opportunities[0]);
  later.projectId = '2027|测试大学|计算机学院|夏令营-later';
  snapshot.opportunities.unshift(later);
  snapshot.opportunities[1].deadline = '2026-07-19T23:59:00+08:00';
  snapshot.opportunities[1].deadlineEpochMs = Date.parse(snapshot.opportunities[1].deadline);
  snapshot.counts.confirmedOpen = 2;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /ascending.*deadline/i);
});

test('unknown-deadline active rows must follow timed active rows', () => {
  const snapshot = validSnapshot();
  const unknown = structuredClone(snapshot.opportunities[0]);
  unknown.projectId = '2027|测试大学|计算机学院|夏令营-unknown';
  unknown.verificationStatus = 'confirmed-unknown-deadline';
  unknown.deadline = null;
  unknown.deadlineEpochMs = null;
  snapshot.opportunities.unshift(unknown);
  snapshot.counts.confirmedUnknownDeadline = 1;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /unknown-deadline.*after timed/i);
});

test('expired rows must follow all active rows', () => {
  const snapshot = validSnapshot();
  const expired = structuredClone(snapshot.opportunities[0]);
  expired.projectId = '2027|测试大学|计算机学院|夏令营-expired';
  expired.verificationStatus = 'expired';
  expired.deadline = '2026-07-15T23:59:00+08:00';
  expired.deadlineEpochMs = Date.parse(expired.deadline);
  snapshot.opportunities.unshift(expired);
  snapshot.counts.expired = 1;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /expired.*after active/i);
});

test('accepts timed, unknown-deadline, then expired row ordering', () => {
  const snapshot = validSnapshot();
  const unknown = structuredClone(snapshot.opportunities[0]);
  unknown.projectId = '2027|测试大学|计算机学院|夏令营-unknown';
  unknown.verificationStatus = 'confirmed-unknown-deadline';
  unknown.deadline = null;
  unknown.deadlineEpochMs = null;
  const expired = structuredClone(snapshot.opportunities[0]);
  expired.projectId = '2027|测试大学|计算机学院|夏令营-expired';
  expired.verificationStatus = 'expired';
  expired.deadline = '2026-07-15T23:59:00+08:00';
  expired.deadlineEpochMs = Date.parse(expired.deadline);
  snapshot.opportunities.push(unknown, expired);
  snapshot.counts.confirmedUnknownDeadline = 1;
  snapshot.counts.expired = 1;

  assert.deepEqual(validateSnapshot(snapshot, nowMs), []);
});

test('rejects URL credentials in websites and every discovery source', async (t) => {
  await t.test('website credentials', () => {
    const snapshot = validSnapshot();
    snapshot.opportunities[0].website = 'https://user:pass@cs.example.edu.cn/notice/1';

    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /website.*credentials/i);
  });

  await t.test('non-official discovery source credentials', () => {
    const snapshot = validSnapshot();
    snapshot.opportunities[0].discoverySources.push({
      kind: 'cs-baoyan',
      label: '发现源',
      url: 'https://user:pass@ddl.example.test/notice/1',
    });

    assert.match(
      validateSnapshot(snapshot, nowMs).join('\n'),
      /discoverySources\[1\]\.url.*credentials/i,
    );
  });
});

test('canonicalizes trailing-dot hosts before denylist checks', async (t) => {
  for (const host of [
    'ddl.csbaoyan.top',
    'github.com',
    'www.baoyantongzhi.com',
    'baoyantongzhi.com',
  ]) {
    await t.test(`website ${host}.`, () => {
      const snapshot = validSnapshot();
      snapshot.opportunities[0].website = `https://${host}./notice/1`;

      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /website.*denied/i);
    });
  }

  await t.test('official source github.com.', () => {
    const snapshot = validSnapshot();
    snapshot.opportunities[0].discoverySources[0].url = 'https://github.com./notice/1';

    assert.match(
      validateSnapshot(snapshot, nowMs).join('\n'),
      /discoverySources\[0\]\.url.*denied/i,
    );
  });
});

test('applies the denied-host list to official discovery sources', async (t) => {
  for (const host of [
    'ddl.csbaoyan.top',
    'github.com',
    'www.baoyantongzhi.com',
    'baoyantongzhi.com',
  ]) {
    await t.test(host, () => {
      const snapshot = validSnapshot();
      snapshot.opportunities[0].discoverySources[0].url = `https://${host}/notice/1`;

      assert.match(
        validateSnapshot(snapshot, nowMs).join('\n'),
        /discoverySources\[0\]\.url.*denied/i,
      );
    });
  }
});

test('requires non-empty projectId and snapshotId values', async (t) => {
  await t.test('projectId', () => {
    const snapshot = validSnapshot();
    snapshot.opportunities[0].projectId = '';

    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /projectId.*non-empty/i);
  });

  await t.test('snapshotId', () => {
    const snapshot = validSnapshot();
    snapshot.snapshotId = '';

    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /snapshotId.*non-empty/i);
  });
});

test('requires eventYear to be an integer', () => {
  const snapshot = validSnapshot();
  snapshot.feeds[0].eventYear = 2026.5;

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /eventYear.*integer/i);
});

test('rejects non-finite nowMs values', async (t) => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await t.test(String(value), () => {
      assert.match(validateSnapshot(validSnapshot(), value).join('\n'), /nowMs.*finite/i);
    });
  }
});

test('enforces candidate and approval chronology', async (t) => {
  await t.test('candidate verifiedAt is not after scanAt', () => {
    const candidate = validCandidate();
    candidate.opportunities[0].verifiedAt = '2026-07-15T23:01:00+08:00';

    assert.match(validateCandidate(candidate, nowMs).join('\n'), /verifiedAt.*scanAt/i);
  });

  await t.test('approvedAt is not before scanAt', () => {
    const snapshot = validSnapshot();
    snapshot.approvedAt = '2026-07-15T22:59:00+08:00';

    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /approvedAt.*scanAt/i);
  });

  await t.test('approved snapshot verifiedAt is not after approvedAt', () => {
    const snapshot = validSnapshot();
    snapshot.approvedAt = '2026-07-15T22:15:00+08:00';

    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /verifiedAt.*approvedAt/i);
  });
});

test('rejects sparse feeds and opportunities arrays by index', async (t) => {
  await t.test('feeds hole', () => {
    const snapshot = validSnapshot();
    snapshot.feeds = new Array(1);

    assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /feeds\[0\].*missing array element/i);
  });

  await t.test('opportunities hole', () => {
    const snapshot = validSnapshot();
    snapshot.opportunities = new Array(1);

    assert.match(
      validateSnapshot(snapshot, nowMs).join('\n'),
      /opportunities\[0\].*missing array element/i,
    );
  });
});

test('rejects denied discovery-host subdomains for websites and official sources', async (t) => {
  for (const host of [
    'sub.ddl.csbaoyan.top',
    'pages.github.com',
    'm.www.baoyantongzhi.com',
    'm.baoyantongzhi.com',
  ]) {
    await t.test(`website ${host}`, () => {
      const snapshot = validSnapshot();
      snapshot.opportunities[0].website = `https://${host}/notice/1`;

      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /website.*denied/i);
    });

    await t.test(`official source ${host}`, () => {
      const snapshot = validSnapshot();
      snapshot.opportunities[0].discoverySources[0].url = `https://${host}/notice/1`;

      assert.match(
        validateSnapshot(snapshot, nowMs).join('\n'),
        /discoverySources\[0\]\.url.*denied/i,
      );
    });
  }
});

test('does not treat github.io as a github.com subdomain', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].website = 'https://github.io/notice/1';
  snapshot.opportunities[0].discoverySources[0].url = 'https://github.io/notice/1';

  assert.deepEqual(validateSnapshot(snapshot, nowMs), []);
});

test('approved projectId admission cycle must match its referenced feed', () => {
  const snapshot = validSnapshot();
  snapshot.opportunities[0].projectId = '2029|测试大学|计算机学院|夏令营';

  assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /projectId.*admissionCycle/i);
});

test('approved projectId must use four non-empty stable ID parts', async (t) => {
  for (const projectId of [
    '2027|测试大学|计算机学院',
    '2027|测试大学|计算机学院|夏令营|extra',
    '2027||计算机学院|夏令营',
  ]) {
    await t.test(projectId, () => {
      const snapshot = validSnapshot();
      snapshot.opportunities[0].projectId = projectId;

      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /projectId.*four non-empty parts/i);
    });
  }
});

test('candidate projectId must use four non-empty stable ID parts', async (t) => {
  for (const projectId of [
    '2027|测试大学|计算机学院',
    '2027|测试大学|计算机学院|夏令营|extra',
    '2027||计算机学院|夏令营',
  ]) {
    await t.test(projectId, () => {
      const candidate = validCandidate();
      candidate.opportunities[0].projectId = projectId;

      assert.match(validateCandidate(candidate, nowMs).join('\n'), /projectId.*four non-empty parts/i);
    });
  }
});

test('candidate projectId admission cycle must match its referenced feed', () => {
  const candidate = validCandidate();
  candidate.opportunities[0].projectId = '2029|测试大学|计算机学院|夏令营';

  assert.match(validateCandidate(candidate, nowMs).join('\n'), /projectId.*admissionCycle/i);
});

test('candidate feed admissionCycle must be exactly four digits', async (t) => {
  for (const admissionCycle of ['27', '20270', '20A7']) {
    await t.test(admissionCycle, () => {
      const candidate = validCandidate();
      candidate.feeds[0].admissionCycle = admissionCycle;

      assert.match(
        validateCandidate(candidate, nowMs).join('\n'),
        /feeds\[0\]\.admissionCycle.*four digits/i,
      );
    });
  }
});

test('approved feed admissionCycle must be exactly four digits', async (t) => {
  for (const admissionCycle of ['27', '20270', '20A7']) {
    await t.test(admissionCycle, () => {
      const snapshot = validSnapshot();
      snapshot.feeds[0].admissionCycle = admissionCycle;

      assert.match(
        validateSnapshot(snapshot, nowMs).join('\n'),
        /feeds\[0\]\.admissionCycle.*four digits/i,
      );
    });
  }
});

test('candidate projectId leading cycle must be exactly four digits', async (t) => {
  for (const admissionCycle of ['27', '20270', '20A7']) {
    await t.test(admissionCycle, () => {
      const candidate = validCandidate();
      candidate.feeds[0].admissionCycle = admissionCycle;
      candidate.opportunities[0].projectId = `${admissionCycle}|测试大学|计算机学院|夏令营`;

      assert.match(validateCandidate(candidate, nowMs).join('\n'), /projectId.*four digits/i);
    });
  }
});

test('approved projectId leading cycle must be exactly four digits', async (t) => {
  for (const admissionCycle of ['27', '20270', '20A7']) {
    await t.test(admissionCycle, () => {
      const snapshot = validSnapshot();
      snapshot.feeds[0].admissionCycle = admissionCycle;
      snapshot.opportunities[0].projectId = `${admissionCycle}|测试大学|计算机学院|夏令营`;

      assert.match(validateSnapshot(snapshot, nowMs).join('\n'), /projectId.*four digits/i);
    });
  }
});
