import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  importScoutingData,
  writeCandidateAtomically,
  type IdentityContext,
} from '../scripts/snapshot/import-scouting-data.js';
import { canonicalDataHash } from '../scripts/snapshot/approve-snapshot.js';
import { validateCandidate } from '../src/lib/snapshot-validation.js';
import type {
  LegacyPublicSnapshotV1,
  PublicSnapshot,
  SnapshotCandidate,
} from '../src/lib/snapshot-types.js';

const validFixturePath = fileURLToPath(
  new URL('./fixtures/scouting-valid.json', import.meta.url),
);
const invalidOfficialFixturePath = fileURLToPath(
  new URL('./fixtures/scouting-invalid-aggregator-official.json', import.meta.url),
);
const snapshotFixture = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-valid.json', import.meta.url), 'utf8'),
) as PublicSnapshot;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(repositoryRoot, 'scripts/snapshot/import-scouting-data.ts');
const tsxPath = resolve(repositoryRoot, 'node_modules/.bin/tsx');

function validInput(): Record<string, any> {
  return JSON.parse(readFileSync(validFixturePath, 'utf8')) as Record<string, any>;
}

function identities(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return {
    previous: null,
    aliases: {},
    ...overrides,
  };
}

function previousWith(website: string, projectId: string): PublicSnapshot {
  const previous = structuredClone(snapshotFixture);
  previous.opportunities[0].website = website;
  previous.opportunities[0].projectId = projectId;
  previous.dataHash = canonicalDataHash(previous);
  previous.snapshotId = snapshotIdFor(previous.approvedAt, previous.dataHash);
  return previous;
}

function snapshotIdFor(approvedAt: string, dataHash: string): string {
  return `${new Date(Date.parse(approvedAt)).toISOString()}-${dataHash.slice(0, 12)}`;
}

function sealCandidate(candidate: SnapshotCandidate): PublicSnapshot {
  const approvedAt = candidate.scanAt;
  const dataHash = canonicalDataHash(candidate);
  return {
    ...structuredClone(candidate),
    snapshotId: snapshotIdFor(approvedAt, dataHash),
    approvedAt,
    previousSnapshotId: null,
    dataHash,
  };
}

function legacySnapshotV1(candidate: SnapshotCandidate): LegacyPublicSnapshotV1 {
  const legacyCandidate = {
    ...structuredClone(candidate),
    schemaVersion: 1 as const,
    opportunities: candidate.opportunities.map(
      ({ eventArrangement: _eventArrangement, ...opportunity }) => opportunity,
    ),
  };
  const approvedAt = candidate.scanAt;
  const dataHash = canonicalDataHash(legacyCandidate);
  return {
    ...legacyCandidate,
    snapshotId: snapshotIdFor(approvedAt, dataHash),
    approvedAt,
    previousSnapshotId: null,
    dataHash,
  };
}

function sharedOfficialUrlInput(): Record<string, any> {
  const input = validInput();
  const second = structuredClone(input.mainRows[0]);
  second.projectId = '2027|测试大学|计算机学院|开放日';
  second.project = '2026年计算机学院开放日';
  second.eventType = '开放日';
  input.mainRows.splice(1, 0, second);
  return input;
}

function renamedSharedOfficialUrlInput(): Record<string, any> {
  const input = sharedOfficialUrlInput();
  input.mainRows[0].projectId = '2027|测试大学|计算机学院|暑期学校';
  input.mainRows[0].project = '2026年计算机学院暑期学校';
  input.mainRows[1].projectId = '2027|测试大学|计算机学院|校园开放体验';
  input.mainRows[1].project = '2026年计算机学院校园开放体验';
  return input;
}

function freshCliInput(): Record<string, any> {
  const input = validInput();
  input.mainRows[0].deadline = '2099-12-31T23:59:00+08:00';
  input.mainRows[0].deadlineOriginal = '2099年12月31日23:59';
  return input;
}

function staleCliInput(): Record<string, any> {
  const input = validInput();
  input.scanAt = '2000-01-01T12:00:00+08:00';
  input.mainRows[0].deadline = '2000-01-02T23:59:00+08:00';
  input.mainRows[0].deadlineOriginal = '2000年1月2日23:59';
  for (const row of input.mainRows) row.verifiedAt = input.scanAt;
  return input;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function prepareCliSources(tempRoot: string, input = freshCliInput()) {
  const inputPath = join(tempRoot, 'input.json');
  const aliasesPath = join(tempRoot, 'aliases.json');
  const approvedPath = join(tempRoot, 'approved.json');
  writeJson(inputPath, input);
  writeJson(aliasesPath, {});
  writeJson(approvedPath, sealCandidate(importScoutingData(input, identities())));
  return { inputPath, aliasesPath, approvedPath };
}

function runImporterCli(options: {
  input: string;
  aliases: string;
  output: string;
  approved?: string;
}) {
  const args = [
    cliPath,
    '--input',
    options.input,
    '--aliases',
    options.aliases,
    '--output',
    options.output,
  ];
  if (options.approved !== undefined) args.push('--approved', options.approved);
  return spawnSync(tsxPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function opportunity(candidate: SnapshotCandidate, project: string) {
  const found = candidate.opportunities.find((row) => row.project === project);
  assert.ok(found, `missing opportunity: ${project}`);
  return found;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

test('maps confirmed and sparse expired rows while excluding pending and private fields', () => {
  const candidate = importScoutingData(validInput(), identities());

  assert.equal(candidate.schemaVersion, 2);
  assert.deepEqual(candidate.counts, {
    confirmedOpen: 1,
    confirmedUnknownDeadline: 1,
    pendingExcluded: 1,
    expired: 1,
  });
  assert.equal(candidate.opportunities.length, 3);
  assert.ok(!candidate.opportunities.some((row) => row.projectId.includes('待核实大学')));

  const active = opportunity(candidate, '2026年优秀大学生夏令营');
  assert.equal(active.name, '测试大学');
  assert.equal(active.institute, '计算机学院');
  assert.equal(active.eventType, '夏令营');
  assert.equal(active.description, '2026年优秀大学生夏令营');
  assert.equal(active.website, 'https://cs.example.edu.cn/admissions/summer-camp/');
  assert.deepEqual(active.tags, []);
  assert.deepEqual(active.eventArrangement, {
    mode: 'unknown',
    time: { status: 'confirmed', summary: '2026年8月' },
    formatLocation: { status: 'confirmed', summary: '线下，北京' },
  });
  assert.deepEqual(active.discoverySources, [
    {
      kind: 'official',
      label: '官方链接',
      url: 'https://cs.example.edu.cn/admissions/summer-camp/',
    },
    {
      kind: 'baoyan-notice',
      label: '保研通知网',
      url: 'https://www.baoyantongzhi.com/notice/detail/12345',
    },
  ]);

  const expired = opportunity(candidate, '2025年预推免活动');
  assert.equal(expired.projectId, '2026|历史大学|网络空间安全学院|预推免');
  assert.equal(expired.institute, '网络空间安全学院');
  assert.equal(expired.eventType, '已过期活动');
  assert.equal(expired.description, '2025年预推免活动');
  assert.equal(expired.deadline, null);
  assert.equal(expired.deadlineEpochMs, null);
  assert.equal(expired.deadlineOriginal, '未公布');
  assert.equal(expired.verifiedAt, candidate.scanAt);
  assert.deepEqual(expired.eventArrangement, {
    mode: 'unknown',
    time: { status: 'not-published', summary: '未公布' },
    formatLocation: { status: 'not-published', summary: '未公布' },
  });

  const serialized = JSON.stringify(candidate);
  for (const privateValue of [
    'PENDING_SECRET_SENTINEL',
    'PENDING_PRIVATE_RISK',
    'PENDING_PRIVATE_ACTION',
    '/Users/example/private/evidence.md',
    '/private/expired-evidence.md',
    'private-submitted-id',
    'DROP_ME',
  ]) {
    assert.ok(!serialized.includes(privateValue), `leaked private value: ${privateValue}`);
  }
});

test('copies only the validated input eventMode without inferring from public text', async (t) => {
  for (const mode of ['online', 'offline', 'hybrid', 'unknown'] as const) {
    await t.test(mode, () => {
      const input = validInput();
      input.mainRows[0].eventMode = mode;
      input.mainRows[0].formatLocation = '线下，到校现场举办';
      input.mainRows[0].accommodation = '提供校内住宿';

      const active = opportunity(
        importScoutingData(input, identities()),
        '2026年优秀大学生夏令营',
      );

      assert.equal(active.eventArrangement.mode, mode);
      assert.equal(active.eventArrangement.formatLocation.summary, '线下，到校现场举办');
      assert.match(active.logistics.summary, /住宿/);
    });
  }
});

test('rejects active rows with a missing or invalid eventMode', async (t) => {
  await t.test('missing', () => {
    const input = validInput();
    delete input.mainRows[0].eventMode;

    assert.throws(
      () => importScoutingData(input, identities()),
      /mainRows\[0\]\.eventMode.*(?:required|non-empty|allowed)/i,
    );
  });

  await t.test('invalid', () => {
    for (const eventMode of ['onsite', ' online ']) {
      const input = validInput();
      input.mainRows[0].eventMode = eventMode;

      assert.throws(
        () => importScoutingData(input, identities()),
        /mainRows\[0\]\.eventMode.*allowed/i,
      );
    }
  });
});

test('always uses the public project title instead of an input description', () => {
  const input = validInput();
  input.mainRows[0].description = 'PRIVATE_DESCRIPTION_MUST_NOT_SHIP';

  const candidate = importScoutingData(input, identities());
  const active = opportunity(candidate, '2026年优秀大学生夏令营');

  assert.equal(active.description, active.project);
  assert.ok(!JSON.stringify(candidate).includes('PRIVATE_DESCRIPTION_MUST_NOT_SHIP'));
});

test('derives feed catalog from mapped rows and chooses the newest active feed', () => {
  const candidate = importScoutingData(validInput(), identities());

  assert.deepEqual(candidate.feeds, [
    { id: 'camp2026', label: '推免活动 2026', admissionCycle: '2026', eventYear: 2026 },
    { id: 'camp2027', label: '推免活动 2027', admissionCycle: '2027', eventYear: 2026 },
    { id: 'camp2028', label: '推免活动 2028', admissionCycle: '2028', eventYear: 2026 },
  ]);
  assert.equal(candidate.defaultFeedId, 'camp2028');
  assert.ok(candidate.opportunities.every((row) =>
    candidate.feeds.some((feed) => feed.id === row.feedId)));
  assert.ok(!candidate.feeds.some((feed) => feed.id === 'camp2029'));
});

test('sorts timed active rows ascending, then unknown deadline, then expired', () => {
  const input = validInput();
  const later = structuredClone(input.mainRows[0]);
  later.projectId = '2027|测试大学|计算机学院|开放日';
  later.project = '2026年计算机学院开放日';
  later.eventType = '开放日';
  later.deadline = '2026-07-25T18:00:00+08:00';
  later.deadlineOriginal = '2026年7月25日18:00';
  later.officialUrl = 'https://cs.example.edu.cn/admissions/open-day';
  input.mainRows = [input.mainRows[1], later, input.mainRows[0]];

  const candidate = importScoutingData(input, identities());

  assert.deepEqual(candidate.opportunities.map((row) => row.project), [
    '2026年优秀大学生夏令营',
    '2026年计算机学院开放日',
    '2026年研究生招生开放日',
    '2025年预推免活动',
  ]);
});

test('uses deterministic code-point ordering for equal-status equal-deadline rows', () => {
  const input = validInput();
  const a = structuredClone(input.mainRows[0]);
  a.projectId = '2027|阿大学|计算机学院|夏令营';
  a.school = '阿大学';
  a.project = '阿大学夏令营';
  a.officialUrl = 'https://a.example.edu.cn/summer-camp';
  const zhong = structuredClone(input.mainRows[0]);
  zhong.projectId = '2027|中大学|计算机学院|夏令营';
  zhong.school = '中大学';
  zhong.project = '中大学夏令营';
  zhong.officialUrl = 'https://zhong.example.edu.cn/summer-camp';
  input.mainRows = [a, zhong];
  input.expiredRows = [];

  const candidate = importScoutingData(input, identities());

  assert.deepEqual(candidate.opportunities.map((row) => row.projectId), [
    zhong.projectId,
    a.projectId,
  ]);
});

test('rejects expired-only input so it cannot replace an active snapshot', () => {
  const input = validInput();
  input.mainRows = [];

  assert.throws(
    () => importScoutingData(input, identities()),
    /mainRows must contain an active row/i,
  );
});

test('rejects duplicate resolved project IDs', () => {
  const input = validInput();
  input.mainRows[1].projectId = input.mainRows[0].projectId;
  input.mainRows[1].cycle = '2027';

  assert.throws(
    () => importScoutingData(input, identities()),
    /duplicate resolved projectId/i,
  );
});

test('requires one unambiguous four-digit cycle source per row', async (t) => {
  await t.test('ambiguous main-row cycle', () => {
    const input = validInput();
    input.mainRows[0].cycle = '2027或2028推免';

    assert.throws(
      () => importScoutingData(input, identities()),
      /unambiguous four-digit cycle/i,
    );
  });

  await t.test('main row cannot fall back to its project ID', () => {
    const input = validInput();
    delete input.mainRows[0].cycle;

    assert.throws(
      () => importScoutingData(input, identities()),
      /unambiguous four-digit cycle/i,
    );
  });
});

test('reuses a previous ID across a display-name change via normalized official URL', () => {
  const previousId = '2027|旧测试大学|计算机学院|夏令营';
  const previous = previousWith(
    'HTTPS://CS.EXAMPLE.EDU.CN/admissions/summer-camp',
    previousId,
  );

  const candidate = importScoutingData(validInput(), identities({ previous }));
  const active = opportunity(candidate, '2026年优秀大学生夏令营');

  assert.equal(active.projectId, previousId);
  assert.equal(active.name, '测试大学');
});

test('normalizes a trailing-dot hostname before previous URL identity lookup', () => {
  const previousId = '2027|旧测试大学|计算机学院|夏令营';
  const previous = previousWith(
    'https://cs.example.edu.cn./admissions/summer-camp',
    previousId,
  );

  const candidate = importScoutingData(validInput(), identities({ previous }));

  assert.equal(
    opportunity(candidate, '2026年优秀大学生夏令营').projectId,
    previousId,
  );
});

test('does not reuse a previous URL identity from another admission cycle', () => {
  const previousInput = validInput();
  previousInput.mainRows[0].projectId = '2026|旧测试大学|计算机学院|夏令营';
  previousInput.mainRows[0].cycle = '2026';
  const previous = sealCandidate(importScoutingData(previousInput, identities()));

  const candidate = importScoutingData(validInput(), identities({ previous }));

  assert.equal(
    opportunity(candidate, '2026年优秀大学生夏令营').projectId,
    '2027|测试大学|计算机学院|夏令营',
  );
});

test('uses an alias only for an explicit official URL migration', () => {
  const previousId = '2027|测试大学|计算机学院|旧夏令营';
  const previous = previousWith('https://cs.example.edu.cn/admissions/old', previousId);

  const withoutAlias = importScoutingData(validInput(), identities({ previous }));
  assert.equal(
    opportunity(withoutAlias, '2026年优秀大学生夏令营').projectId,
    '2027|测试大学|计算机学院|夏令营',
  );

  const withAlias = importScoutingData(validInput(), identities({
    previous,
    aliases: {
      'HTTPS://CS.EXAMPLE.EDU.CN/admissions/summer-camp': previousId,
    },
  }));
  assert.equal(opportunity(withAlias, '2026年优秀大学生夏令营').projectId, previousId);
});

test('repeat import preserves distinct stable IDs that share one official URL', () => {
  const input = sharedOfficialUrlInput();
  const first = importScoutingData(input, identities());
  const repeated = importScoutingData(input, identities({ previous: sealCandidate(first) }));
  const sharedUrl = input.mainRows[0].officialUrl;

  assert.deepEqual(
    repeated.opportunities
      .filter((row) => row.website === sharedUrl)
      .map((row) => row.projectId)
      .sort(),
    [input.mainRows[0].projectId, input.mainRows[1].projectId].sort(),
  );
});

test('one previous row expanding to multiple current rows preserves the exact ID only', () => {
  const previousInput = validInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const currentInput = sharedOfficialUrlInput();

  const candidate = importScoutingData(currentInput, identities({ previous }));

  assert.deepEqual(
    candidate.opportunities
      .filter((row) => row.website === currentInput.mainRows[0].officialUrl)
      .map((row) => row.projectId)
      .sort(),
    [currentInput.mainRows[0].projectId, currentInput.mainRows[1].projectId].sort(),
  );
});

test('shared URL growth preserves all previous IDs and accepts a new current ID', () => {
  const previousInput = sharedOfficialUrlInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const currentInput = sharedOfficialUrlInput();
  const addition = structuredClone(currentInput.mainRows[0]);
  addition.projectId = '2027|测试大学|计算机学院|校园开放体验';
  addition.project = '2026年计算机学院校园开放体验';
  addition.eventType = '校园开放体验';
  currentInput.mainRows.splice(2, 0, addition);

  const candidate = importScoutingData(currentInput, identities({ previous }));

  assert.deepEqual(
    candidate.opportunities
      .filter((row) => row.website === currentInput.mainRows[0].officialUrl)
      .map((row) => row.projectId)
      .sort(),
    [
      previousInput.mainRows[0].projectId,
      previousInput.mainRows[1].projectId,
      addition.projectId,
    ].sort(),
  );
});

test('shared URL replacement is ambiguous when a previous ID is missing', () => {
  const previousInput = sharedOfficialUrlInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const currentInput = sharedOfficialUrlInput();
  currentInput.mainRows[1].projectId = '2027|测试大学|计算机学院|校园开放体验';
  currentInput.mainRows[1].project = '2026年计算机学院校园开放体验';

  assert.throws(
    () => importScoutingData(currentInput, identities({ previous })),
    /ambiguous.*compound alias/i,
  );
});

test('shared URL rename rejects partial compound alias coverage', () => {
  const previousInput = sharedOfficialUrlInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const currentInput = renamedSharedOfficialUrlInput();
  const sharedUrl = currentInput.mainRows[0].officialUrl;

  assert.throws(
    () => importScoutingData(currentInput, identities({
      previous,
      aliases: {
        [`${sharedUrl}::${currentInput.mainRows[0].projectId}`]:
          previousInput.mainRows[0].projectId,
      },
    })),
    /cover every missing previous ID exactly once/i,
  );
});

test('shared URL rename accepts complete compound alias coverage', () => {
  const previousInput = sharedOfficialUrlInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const currentInput = renamedSharedOfficialUrlInput();
  const sharedUrl = currentInput.mainRows[0].officialUrl;

  const candidate = importScoutingData(currentInput, identities({
    previous,
    aliases: {
      [`${sharedUrl}::${currentInput.mainRows[0].projectId}`]:
        previousInput.mainRows[0].projectId,
      [`${sharedUrl}::${currentInput.mainRows[1].projectId}`]:
        previousInput.mainRows[1].projectId,
    },
  }));

  assert.deepEqual(
    candidate.opportunities
      .filter((row) => row.website === sharedUrl)
      .map((row) => row.projectId)
      .sort(),
    [previousInput.mainRows[0].projectId, previousInput.mainRows[1].projectId].sort(),
  );
});

test('shared URL rename admits a new ID after complete previous-ID coverage', () => {
  const previousInput = sharedOfficialUrlInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const currentInput = renamedSharedOfficialUrlInput();
  const sharedUrl = currentInput.mainRows[0].officialUrl;
  const addition = structuredClone(currentInput.mainRows[0]);
  addition.projectId = '2027|测试大学|计算机学院|实验室开放日';
  addition.project = '2026年计算机学院实验室开放日';
  currentInput.mainRows.splice(2, 0, addition);

  const candidate = importScoutingData(currentInput, identities({
    previous,
    aliases: {
      [`${sharedUrl}::${currentInput.mainRows[0].projectId}`]:
        previousInput.mainRows[0].projectId,
      [`${sharedUrl}::${currentInput.mainRows[1].projectId}`]:
        previousInput.mainRows[1].projectId,
    },
  }));

  assert.deepEqual(
    candidate.opportunities
      .filter((row) => row.website === sharedUrl)
      .map((row) => row.projectId)
      .sort(),
    [
      previousInput.mainRows[0].projectId,
      previousInput.mainRows[1].projectId,
      addition.projectId,
    ].sort(),
  );
});

test('one previous row with multiple renamed current rows requires a compound alias', () => {
  const previous = sealCandidate(importScoutingData(validInput(), identities()));
  const currentInput = sharedOfficialUrlInput();
  currentInput.mainRows[0].projectId = '2027|测试大学|计算机学院|暑期学校';
  currentInput.mainRows[1].projectId = '2027|测试大学|计算机学院|校园开放体验';

  assert.throws(
    () => importScoutingData(currentInput, identities({ previous })),
    /ambiguous.*compound alias/i,
  );
});

test('compound alias selects the renamed row in a one-to-many transition', () => {
  const previousInput = validInput();
  const approvedId = previousInput.mainRows[0].projectId;
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const currentInput = sharedOfficialUrlInput();
  const renamedId = '2027|测试大学|计算机学院|暑期学校';
  const newId = '2027|测试大学|计算机学院|校园开放体验';
  currentInput.mainRows[0].projectId = renamedId;
  currentInput.mainRows[1].projectId = newId;

  const candidate = importScoutingData(currentInput, identities({
    previous,
    aliases: {
      [`${currentInput.mainRows[0].officialUrl}::${renamedId}`]: approvedId,
    },
  }));

  assert.deepEqual(
    candidate.opportunities
      .filter((row) => row.website === currentInput.mainRows[0].officialUrl)
      .map((row) => row.projectId)
      .sort(),
    [approvedId, newId].sort(),
  );
});

test('shared previous URL requires a compound alias when the current input ID changed', () => {
  const previousInput = sharedOfficialUrlInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const changedInput = sharedOfficialUrlInput();
  changedInput.mainRows[0].projectId = '2027|测试大学|计算机学院|暑期学校';

  assert.throws(
    () => importScoutingData(changedInput, identities({ previous })),
    /ambiguous previous IDs.*compound alias/i,
  );
});

test('compound alias resolves exactly one changed input ID on a shared URL', () => {
  const previousInput = sharedOfficialUrlInput();
  const approvedId = previousInput.mainRows[0].projectId;
  const unchangedId = previousInput.mainRows[1].projectId;
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const changedInput = sharedOfficialUrlInput();
  const changedId = '2027|测试大学|计算机学院|暑期学校';
  changedInput.mainRows[0].projectId = changedId;

  const candidate = importScoutingData(changedInput, identities({
    previous,
    aliases: {
      [`HTTPS://CS.EXAMPLE.EDU.CN/admissions/summer-camp::${changedId}`]: approvedId,
    },
  }));

  assert.deepEqual(
    candidate.opportunities
      .filter((row) => row.website === changedInput.mainRows[0].officialUrl)
      .map((row) => row.projectId)
      .sort(),
    [approvedId, unchangedId].sort(),
  );
});

test('compound alias must resolve to an ID approved for that shared URL', () => {
  const previousInput = sharedOfficialUrlInput();
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const changedInput = sharedOfficialUrlInput();
  const changedId = '2027|测试大学|计算机学院|暑期学校';
  changedInput.mainRows[0].projectId = changedId;

  assert.throws(
    () => importScoutingData(changedInput, identities({
      previous,
      aliases: {
        [`${changedInput.mainRows[0].officialUrl}::${changedId}`]:
          '2027|测试大学|计算机学院|未批准项目',
      },
    })),
    /compound alias.*approved ID/i,
  );
});

test('alias targets must exist in the previous snapshot and match the current cycle', async (t) => {
  await t.test('simple alias rejects an arbitrary target without a previous snapshot', () => {
    const input = validInput();
    assert.throws(
      () => importScoutingData(input, identities({
        aliases: {
          [input.mainRows[0].officialUrl]: '2027|任意大学|计算机学院|任意项目',
        },
      })),
      /simple alias target.*validated previous snapshot/i,
    );
  });

  await t.test('simple alias rejects a previous target from another cycle', () => {
    const previousInput = validInput();
    const previousId = '2026|旧测试大学|计算机学院|夏令营';
    previousInput.mainRows[0].projectId = previousId;
    previousInput.mainRows[0].cycle = '2026';
    previousInput.mainRows[0].officialUrl = 'https://cs.example.edu.cn/admissions/old';
    const previous = sealCandidate(importScoutingData(previousInput, identities()));
    const input = validInput();

    assert.throws(
      () => importScoutingData(input, identities({
        previous,
        aliases: { [input.mainRows[0].officialUrl]: previousId },
      })),
      /simple alias target.*cycle/i,
    );
  });

  await t.test('compound alias rejects a previous target from another cycle', () => {
    const previousInput = sharedOfficialUrlInput();
    const previousId = '2026|旧测试大学|计算机学院|夏令营';
    previousInput.mainRows[0].projectId = previousId;
    previousInput.mainRows[0].cycle = '2026';
    const previous = sealCandidate(importScoutingData(previousInput, identities()));
    const input = sharedOfficialUrlInput();
    const changedId = '2027|测试大学|计算机学院|暑期学校';
    input.mainRows[0].projectId = changedId;

    assert.throws(
      () => importScoutingData(input, identities({
        previous,
        aliases: {
          [`${input.mainRows[0].officialUrl}::${changedId}`]: previousId,
        },
      })),
      /compound alias target.*cycle/i,
    );
  });
});

test('rejects malformed and normalized conflicting alias entries', async (t) => {
  await t.test('empty compound input ID', () => {
    assert.throws(
      () => importScoutingData(validInput(), identities({
        aliases: {
          'https://cs.example.edu.cn/admissions/summer-camp/::':
            '2027|测试大学|计算机学院|夏令营',
        },
      })),
      /malformed compound alias/i,
    );
  });

  await t.test('conflicting simple aliases after URL normalization', () => {
    assert.throws(
      () => importScoutingData(validInput(), identities({
        aliases: {
          'https://cs.example.edu.cn/admissions/summer-camp/':
            '2027|测试大学|计算机学院|夏令营',
          'HTTPS://CS.EXAMPLE.EDU.CN/admissions/summer-camp':
            '2027|测试大学|计算机学院|开放日',
        },
      })),
      /conflicting simple alias/i,
    );
  });

  await t.test('conflicting compound aliases after URL normalization', () => {
    const currentId = '2027|测试大学|计算机学院|暑期学校';
    assert.throws(
      () => importScoutingData(validInput(), identities({
        aliases: {
          [`https://cs.example.edu.cn/admissions/summer-camp/::${currentId}`]:
            '2027|测试大学|计算机学院|夏令营',
          [`HTTPS://CS.EXAMPLE.EDU.CN/admissions/summer-camp::${currentId}`]:
            '2027|测试大学|计算机学院|开放日',
        },
      })),
      /conflicting compound alias/i,
    );
  });
});

test('simple URL alias cannot collapse multiple current rows into one ID', () => {
  const previousInput = validInput();
  previousInput.mainRows[0].officialUrl = 'https://cs.example.edu.cn/admissions/old';
  const previous = sealCandidate(importScoutingData(previousInput, identities()));
  const input = sharedOfficialUrlInput();
  const migratedUrl = 'https://cs.example.edu.cn/admissions/migrated';
  input.mainRows[0].officialUrl = migratedUrl;
  input.mainRows[1].officialUrl = migratedUrl;

  assert.throws(
    () => importScoutingData(input, identities({
      previous,
      aliases: { [migratedUrl]: input.mainRows[0].projectId },
    })),
    /duplicate resolved projectId/i,
  );
});

test('candidate has no approval metadata', () => {
  const candidate = importScoutingData(validInput(), identities());

  for (const key of ['snapshotId', 'approvedAt', 'previousSnapshotId', 'dataHash']) {
    assert.ok(!Object.hasOwn(candidate, key));
  }
});

test('emits the exact public shape and recursively omits private input fields', () => {
  const candidate = importScoutingData(validInput(), identities());
  const candidateKeys = Object.keys(candidate).sort();
  const opportunityKeys = Object.keys(candidate.opportunities[0]).sort();

  assert.deepEqual(candidateKeys, [
    'counts',
    'defaultFeedId',
    'feeds',
    'opportunities',
    'scanAt',
    'schemaVersion',
  ]);
  assert.deepEqual(opportunityKeys, [
    'deadline',
    'deadlineEpochMs',
    'deadlineOriginal',
    'description',
    'discoverySources',
    'eventArrangement',
    'eventType',
    'feedId',
    'institute',
    'logistics',
    'materials',
    'name',
    'project',
    'projectId',
    'recommendation',
    'tags',
    'verificationStatus',
    'verifiedAt',
    'website',
  ]);

  const outputKeys = collectKeys(candidate);
  for (const forbidden of [
    'fit',
    'eventMode',
    'welfareScore',
    'recommendationTier',
    'cityPlatformValue',
    'socialValue',
    'risks',
    'nextAction',
    'localPath',
    'privatePath',
    'privateEvidencePath',
    'submittedProjectIds',
    'pendingRows',
    'pendingEvidence',
    'unknownInputProperty',
    'unknownTopLevel',
  ]) {
    assert.ok(!outputKeys.has(forbidden), `leaked key: ${forbidden}`);
  }
  assert.deepEqual(validateCandidate(candidate, Date.parse(candidate.scanAt)), []);
});

test('imports a minimal current-style sparse expired row safely', () => {
  const input = validInput();
  input.expiredRows = [{
    projectId: '2025|精简大学|信息学院|夏令营',
    school: '精简大学',
    project: '2024年优秀大学生夏令营',
    verificationStatus: 'expired',
    officialUrl: 'https://info.example.edu.cn/expired',
    discoverySources: ['学院官网'],
  }];

  const candidate = importScoutingData(input, identities());
  const expired = opportunity(candidate, '2024年优秀大学生夏令营');

  assert.equal(expired.feedId, 'camp2025');
  assert.equal(expired.eventType, '已过期活动');
  assert.equal(expired.description, expired.project);
  assert.equal(expired.deadline, null);
  assert.equal(expired.verifiedAt, candidate.scanAt);
  assert.deepEqual(expired.eventArrangement, {
    mode: 'unknown',
    time: { status: 'not-published', summary: '未公布' },
    formatLocation: { status: 'not-published', summary: '未公布' },
  });
  assert.deepEqual(expired.logistics, { status: 'not-published', summary: '未公布' });
});

test('normalizes date-only and zoned deadlines and suppresses raw unverified text', () => {
  const input = validInput();
  const candidate = importScoutingData(input, identities());
  const active = opportunity(candidate, '2026年优秀大学生夏令营');

  assert.equal(active.deadline, '2026-07-20T23:59:00+08:00');
  assert.equal(active.deadlineEpochMs, Date.parse(active.deadline));
  assert.match(active.deadlineOriginal, /官方未公布具体时刻/);
  assert.deepEqual(active.logistics, { status: 'unverified', summary: '待官方公布' });
  assert.deepEqual(active.materials, { status: 'not-published', summary: '未公布' });
  assert.ok(!JSON.stringify(active).includes('可能提供校内住宿'));
  assert.ok(!JSON.stringify(active).includes('后续通知'));

  input.mainRows[0].deadline = '2026-07-20T00:30:00Z';
  input.mainRows[0].deadlineOriginal = '2026年7月20日00:30 UTC';
  const zoned = opportunity(
    importScoutingData(input, identities()),
    '2026年优秀大学生夏令营',
  );
  assert.equal(zoned.deadline, '2026-07-20T08:30:00+08:00');
  assert.equal(zoned.deadlineOriginal, '2026年7月20日00:30 UTC');
});

test('suppresses real unverified and unpublished phrases with fixed summaries', () => {
  const input = validInput();
  const row = input.mainRows[0];
  row.accommodation = '未提及';
  delete row.meals;
  delete row.transport;
  delete row.reimbursement;
  delete row.recommendationLetters;
  row.recommendationTemplate = '未确认官方模板';
  row.materialList = '待系统核实';
  delete row.materialComplexity;

  const active = opportunity(
    importScoutingData(input, identities()),
    '2026年优秀大学生夏令营',
  );

  assert.deepEqual(active.logistics, { status: 'not-published', summary: '未公布' });
  assert.deepEqual(active.recommendation, { status: 'unverified', summary: '待官方公布' });
  assert.deepEqual(active.materials, { status: 'unverified', summary: '待官方公布' });
  const serialized = JSON.stringify(active);
  for (const phrase of ['未确认官方模板', '待系统核实', '未提及']) {
    assert.ok(!serialized.includes(phrase), `leaked raw phrase: ${phrase}`);
  }
});

test('suppresses ambiguous not-listed recommendation wording', () => {
  const input = validInput();
  input.mainRows[0].recommendationLetters = '未要求或未在通知中列出';
  delete input.mainRows[0].recommendationTemplate;

  const active = opportunity(
    importScoutingData(input, identities()),
    '2026年优秀大学生夏令营',
  );

  assert.deepEqual(active.recommendation, {
    status: 'not-published',
    summary: '未公布',
  });
  assert.ok(!JSON.stringify(active).includes('未要求或未在通知中列出'));
});

test('suppresses ambiguous recommendation and official-system phrases as unverified', async (t) => {
  await t.test('未明确要求推荐信', () => {
    const input = validInput();
    input.mainRows[0].recommendationLetters = '未明确要求推荐信';
    delete input.mainRows[0].recommendationTemplate;

    const active = opportunity(
      importScoutingData(input, identities()),
      '2026年优秀大学生夏令营',
    );

    assert.deepEqual(active.recommendation, {
      status: 'unverified',
      summary: '待官方公布',
    });
    assert.ok(!JSON.stringify(active).includes('未明确要求推荐信'));
  });

  for (const phrase of ['以官方报名系统为准', '最终材料以学校官方报名系统要求为准']) {
    await t.test(phrase, () => {
      const input = validInput();
      input.mainRows[0].materialList = phrase;
      delete input.mainRows[0].materialComplexity;

      const active = opportunity(
        importScoutingData(input, identities()),
        '2026年优秀大学生夏令营',
      );

      assert.deepEqual(active.materials, {
        status: 'unverified',
        summary: '待官方公布',
      });
      assert.ok(!JSON.stringify(active).includes(phrase));
    });
  }
});

test('suppresses deferred system language without weakening authoritative negatives', async (t) => {
  const deferredCases = [
    {
      phrase: '具体材料以报名系统为准',
      field: 'materialList',
      otherField: 'materialComplexity',
      group: 'materials',
      expected: { status: 'unverified', summary: '待官方公布' },
    },
    {
      phrase: '未在通知中要求推荐信',
      field: 'recommendationLetters',
      otherField: 'recommendationTemplate',
      group: 'recommendation',
      expected: { status: 'not-published', summary: '未公布' },
    },
    {
      phrase: '是否使用模板请以系统为准',
      field: 'recommendationTemplate',
      otherField: 'recommendationLetters',
      group: 'recommendation',
      expected: { status: 'unverified', summary: '待官方公布' },
    },
  ] as const;

  for (const deferred of deferredCases) {
    await t.test(deferred.phrase, () => {
      const input = validInput();
      input.mainRows[0][deferred.field] = deferred.phrase;
      delete input.mainRows[0][deferred.otherField];

      const active = opportunity(
        importScoutingData(input, identities()),
        '2026年优秀大学生夏令营',
      );

      assert.deepEqual(active[deferred.group], deferred.expected);
      assert.ok(!JSON.stringify(active).includes(deferred.phrase));
    });
  }
});

test('suppresses local and private markers found in otherwise allowed fact fields', async (t) => {
  const markers = [
    '/Users/max/private/evidence.md',
    '/home/maxwell/private/evidence.md',
    '/private/expired-evidence.md',
    '/tmp/private-note.md',
    '/var/folders/private-note.md',
    'C:\\Users\\max\\private\\evidence.md',
    'D:\\USERS\\max\\private.md',
    'E:\\Projects\\private-note.md',
    '\\\\server\\share\\private-note.md',
    'profile_space/private-note.md',
    'targets/submitted/private-note.md',
    'targets/2027-school/private-note.md',
    'submittedProjectIds=secret',
    'PENDING_PRIVATE_RISK',
    'PRIVATE_EVIDENCE_PATH',
    'file:///Users/max/private/evidence.md',
  ];

  for (const marker of markers) {
    await t.test(marker, () => {
      const input = validInput();
      input.mainRows[0].materialList = marker;
      delete input.mainRows[0].materialComplexity;

      const candidate = importScoutingData(input, identities());
      const active = opportunity(candidate, '2026年优秀大学生夏令营');

      assert.deepEqual(active.materials, {
        status: 'unverified',
        summary: '待官方公布',
      });
      assert.ok(!JSON.stringify(candidate).includes(marker), `leaked private marker: ${marker}`);
    });
  }
});

test('rejects private markers that reach another public candidate field', async (t) => {
  for (const marker of [
    '/home/maxwell/private/evidence.md',
    '/private/expired-evidence.md',
    '/tmp/private-note.md',
    '/var/folders/private-note.md',
    'D:\\USERS\\max\\private.md',
    'E:\\Projects\\private-note.md',
    '\\\\server\\share\\private-note.md',
    'PENDING_PRIVATE_RISK',
    'targets/2027-school/private-note.md',
  ]) {
    await t.test(marker, () => {
      const input = validInput();
      input.mainRows[0].project = `夏令营 ${marker}`;

      assert.throws(
        () => importScoutingData(input, identities()),
        /candidate.*private marker/i,
      );
    });
  }
});

test('rejects or sanitizes wrapped embedded private paths', async (t) => {
  const wrappedPaths = [
    '夏令营(/tmp/private.md)',
    '夏令营[path:/var/private.md]',
    '夏令营(`/private/expired-evidence.md`)',
    '夏令营(path:C:\\Private\\secret.md)',
    '夏令营[unc:\\\\server\\share\\secret.md]',
    '夏令营(`targets/2027/private.md`)',
    '夏令营[profile:profile_space/private-note.md]',
  ];

  for (const wrappedPath of wrappedPaths) {
    await t.test(`${wrappedPath} in a prominent field`, () => {
      const input = validInput();
      input.mainRows[0].project = wrappedPath;

      assert.throws(
        () => importScoutingData(input, identities()),
        /candidate.*private marker/i,
      );
    });

    await t.test(`${wrappedPath} in a fact field`, () => {
      const input = validInput();
      input.mainRows[0].materialList = wrappedPath;
      delete input.mainRows[0].materialComplexity;

      const candidate = importScoutingData(input, identities());
      const active = opportunity(candidate, '2026年优秀大学生夏令营');

      assert.deepEqual(active.materials, {
        status: 'unverified',
        summary: '待官方公布',
      });
      assert.ok(
        !JSON.stringify(candidate).includes(wrappedPath),
        `leaked wrapped private path: ${wrappedPath}`,
      );
    });
  }
});

test('rejects or sanitizes private paths adjacent to Chinese text', async (t) => {
  const adjacentPaths = [
    '证据见/tmp/private.md',
    '证据见/资料/私密.md',
    '证据见/2026/private.md',
    '证据见C:\\Private\\secret.md',
    '证据见targets/2027/private.md',
  ];

  for (const adjacentPath of adjacentPaths) {
    await t.test(`${adjacentPath} in a prominent field`, () => {
      const input = validInput();
      input.mainRows[0].project = adjacentPath;

      assert.throws(
        () => importScoutingData(input, identities()),
        /candidate.*private marker/i,
      );
    });

    await t.test(`${adjacentPath} in a fact field`, () => {
      const input = validInput();
      input.mainRows[0].materialList = adjacentPath;
      delete input.mainRows[0].materialComplexity;

      const candidate = importScoutingData(input, identities());
      const active = opportunity(candidate, '2026年优秀大学生夏令营');

      assert.deepEqual(active.materials, {
        status: 'unverified',
        summary: '待官方公布',
      });
      assert.ok(!JSON.stringify(candidate).includes(adjacentPath));
    });
  }
});

test('preserves validated HTTP URL substrings in fact text', () => {
  const input = validInput();
  const fact = '官网：https://gs.example.edu.cn/targets/private/Home';
  input.mainRows[0].materialList = fact;
  delete input.mainRows[0].materialComplexity;

  const active = opportunity(
    importScoutingData(input, identities()),
    '2026年优秀大学生夏令营',
  );

  assert.deepEqual(active.materials, {
    status: 'confirmed',
    summary: `材料清单：${fact}`,
  });
});

test('does not exempt file, credential-bearing, or malformed URL text', async (t) => {
  for (const value of [
    '官网：file:///tmp/private.md',
    '官网：https://user:secret@gs.example.edu.cn/targets/private/Home',
    '官网：https://[invalid]/tmp/private.md',
  ]) {
    await t.test(value, () => {
      const input = validInput();
      input.mainRows[0].materialList = value;
      delete input.mainRows[0].materialComplexity;

      const candidate = importScoutingData(input, identities());
      const active = opportunity(candidate, '2026年优秀大学生夏令营');

      assert.deepEqual(active.materials, {
        status: 'unverified',
        summary: '待官方公布',
      });
      assert.ok(!JSON.stringify(candidate).includes(value));
    });
  }
});

test('preserves benign date and Chinese slash text', () => {
  const input = validInput();
  const project = '2026/07/16 线上/线下活动';
  const fact = '日期：2026/07/16；形式：线上/线下';
  input.mainRows[0].project = project;
  input.mainRows[0].materialList = fact;
  delete input.mainRows[0].materialComplexity;

  const active = opportunity(importScoutingData(input, identities()), project);

  assert.equal(active.project, project);
  assert.deepEqual(active.materials, {
    status: 'confirmed',
    summary: `材料清单：${fact}`,
  });
});

test('preserves slash-delimited category text from the real corpus', () => {
  const input = validInput();
  const project = '2027年推免研究生预报名（计算机/软件/大数据等）';
  input.mainRows[0].project = project;

  const active = opportunity(importScoutingData(input, identities()), project);

  assert.equal(active.project, project);
});

test('does not scan validated official URL paths as private free text', async (t) => {
  for (const path of ['targets', 'private', 'Home']) {
    await t.test(`/${path}/`, () => {
      const input = validInput();
      input.mainRows[0].officialUrl = `https://gs.example.edu.cn/${path}/Detail/8021`;

      const active = opportunity(
        importScoutingData(input, identities()),
        '2026年优秀大学生夏令营',
      );

      assert.equal(active.website, input.mainRows[0].officialUrl);
      assert.equal(active.discoverySources[0].url, input.mainRows[0].officialUrl);
    });
  }
});

test('preserves confirmed negative recommendation wording', async (t) => {
  for (const phrase of ['无需推荐信', '未要求推荐信']) {
    await t.test(phrase, () => {
      const input = validInput();
      input.mainRows[0].recommendationLetters = phrase;
      delete input.mainRows[0].recommendationTemplate;

      const active = opportunity(
        importScoutingData(input, identities()),
        '2026年优秀大学生夏令营',
      );

      assert.deepEqual(active.recommendation, {
        status: 'confirmed',
        summary: `推荐信数量：${phrase}`,
      });
    });
  }
});

test('rejects a non-null previous identity unless it is a valid approved snapshot', () => {
  const invalidPrevious = validInput() as unknown as PublicSnapshot;

  assert.throws(
    () => importScoutingData(validInput(), identities({ previous: invalidPrevious })),
    /approved snapshot validation failed/i,
  );
});

test('rejects a hash-tampered v1 previous snapshot before candidate generation', () => {
  const previous = legacySnapshotV1(importScoutingData(validInput(), identities()));
  previous.opportunities[0].description = 'structurally valid but hash-tampered';

  assert.throws(
    () => importScoutingData(validInput(), identities({ previous })),
    /snapshot\.dataHash: must equal the lowercase canonical SHA-256 hash/i,
  );
});

test('rejects aggregator detail URLs used as the official website', () => {
  const input = JSON.parse(
    readFileSync(invalidOfficialFixturePath, 'utf8'),
  ) as Record<string, any>;
  for (const row of input.mainRows) row.eventMode = 'unknown';

  assert.throws(
    () => importScoutingData(input, identities()),
    /official website/i,
  );
});

test('rejects denied discovery-host subdomains as official websites', async (t) => {
  for (const host of [
    'm.baoyantongzhi.com',
    'sub.ddl.csbaoyan.top',
    'admissions.github.com',
  ]) {
    await t.test(host, () => {
      const input = validInput();
      input.mainRows[0].officialUrl = `https://${host}/official/notice`;

      assert.throws(
        () => importScoutingData(input, identities()),
        /official website/i,
      );
    });
  }
});

test('pure import remains deterministic for a corpus that is stale at wall-clock time', () => {
  const input = staleCliInput();
  const first = importScoutingData(input, identities());
  const second = importScoutingData(input, identities());

  assert.deepEqual(second, first);
  assert.deepEqual(validateCandidate(first, Date.parse(first.scanAt)), []);
  assert.match(validateCandidate(first, Date.now()).join('\n'), /confirmed-open.*future/i);
});

test('rejects relative CLI input paths', () => {
  const result = spawnSync(tsxPath, [
    cliPath,
    '--input',
    'tests/fixtures/scouting-valid.json',
    '--aliases',
    'data/project-id-aliases.json',
    '--output',
    'data/staging/test-candidate.json',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /input.*absolute/i);
});

test('CLI imports an absolute input and creates the output parent on first import', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-import-'));
  const inputPath = join(tempRoot, 'input.json');
  const aliasesPath = join(tempRoot, 'aliases.json');
  const outputPath = join(tempRoot, 'nested', 'candidate.json');
  writeJson(inputPath, freshCliInput());
  writeJson(aliasesPath, {});

  try {
    const result = spawnSync('corepack', [
      'pnpm@10.28.2',
      'run',
      'snapshot:import',
      '--',
      '--input',
      inputPath,
      '--aliases',
      aliasesPath,
      '--output',
      outputPath,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const candidate = JSON.parse(readFileSync(outputPath, 'utf8')) as SnapshotCandidate;
    assert.equal(candidate.counts.pendingExcluded, 1);
    assert.deepEqual(validateCandidate(candidate, Date.parse(candidate.scanAt)), []);
    assert.deepEqual(readdirSync(join(tempRoot, 'nested')), ['candidate.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects an explicitly supplied missing approved snapshot without output', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-missing-approved-'));
  const { inputPath, aliasesPath } = prepareCliSources(tempRoot);
  const approvedPath = join(tempRoot, 'does-not-exist.json');
  const outputPath = join(tempRoot, 'candidate.json');

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
      approved: approvedPath,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /approved snapshot.*could not be read/i);
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects a hash-tampered v1 previous snapshot before candidate write', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-tampered-approved-'));
  const input = freshCliInput();
  const inputPath = join(tempRoot, 'input.json');
  const aliasesPath = join(tempRoot, 'aliases.json');
  const approvedPath = join(tempRoot, 'approved.json');
  const outputPath = join(tempRoot, 'candidate.json');
  const previous = legacySnapshotV1(importScoutingData(input, identities()));
  previous.opportunities[0].description = 'structurally valid but hash-tampered';
  writeJson(inputPath, input);
  writeJson(aliasesPath, {});
  writeJson(approvedPath, previous);
  writeFileSync(outputPath, 'CURRENT_CANDIDATE_MUST_SURVIVE\n', 'utf8');
  const inputBefore = readFileSync(inputPath);
  const aliasesBefore = readFileSync(aliasesPath);
  const approvedBefore = readFileSync(approvedPath);
  const outputBefore = readFileSync(outputPath);

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
      approved: approvedPath,
    });

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /snapshot\.dataHash: must equal the lowercase canonical SHA-256 hash/i,
    );
    assert.deepEqual(readFileSync(inputPath), inputBefore);
    assert.deepEqual(readFileSync(aliasesPath), aliasesBefore);
    assert.deepEqual(readFileSync(approvedPath), approvedBefore);
    assert.deepEqual(readFileSync(outputPath), outputBefore);
    assert.deepEqual(readdirSync(tempRoot).sort(), [
      'aliases.json',
      'approved.json',
      'candidate.json',
      'input.json',
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects resolved output collisions without modifying protected files', async (t) => {
  for (const protectedName of ['input', 'aliases', 'approved'] as const) {
    await t.test(protectedName, () => {
      const tempRoot = mkdtempSync(join(tmpdir(), `scouting-collision-${protectedName}-`));
      const { inputPath, aliasesPath, approvedPath } = prepareCliSources(tempRoot);
      const protectedPaths = { input: inputPath, aliases: aliasesPath, approved: approvedPath };
      mkdirSync(join(tempRoot, 'path-segment'));
      const outputPath = protectedName === 'input'
        ? `${join(tempRoot, 'path-segment')}/../input.json`
        : protectedPaths[protectedName];
      const before = new Map(
        Object.values(protectedPaths).map((path) => [path, readFileSync(path, 'utf8')]),
      );

      try {
        const result = runImporterCli({
          input: inputPath,
          aliases: aliasesPath,
          output: outputPath,
          approved: approvedPath,
        });

        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /output.*collid/i);
        for (const [path, contents] of before) {
          assert.equal(readFileSync(path, 'utf8'), contents, `modified protected file: ${path}`);
        }
        assert.deepEqual(readdirSync(tempRoot).sort(), [
          'aliases.json',
          'approved.json',
          'input.json',
          'path-segment',
        ]);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test('CLI rejects a hardlink output collision without modifying its source inode', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-hardlink-output-'));
  const { inputPath, aliasesPath, approvedPath } = prepareCliSources(tempRoot);
  const outputPath = join(tempRoot, 'candidate.json');
  linkSync(inputPath, outputPath);
  const sourceBefore = readFileSync(inputPath, 'utf8');
  const aliasesBefore = readFileSync(aliasesPath, 'utf8');
  const approvedBefore = readFileSync(approvedPath, 'utf8');
  const inputStat = statSync(inputPath);
  const outputStat = statSync(outputPath);
  assert.equal(outputStat.dev, inputStat.dev);
  assert.equal(outputStat.ino, inputStat.ino);

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
      approved: approvedPath,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /output.*collid|hardlink/i);
    assert.equal(readFileSync(inputPath, 'utf8'), sourceBefore);
    assert.equal(readFileSync(outputPath, 'utf8'), sourceBefore);
    assert.equal(readFileSync(aliasesPath, 'utf8'), aliasesBefore);
    assert.equal(readFileSync(approvedPath, 'utf8'), approvedBefore);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects an existing symlink output without modifying its target', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-symlink-output-'));
  const { inputPath, aliasesPath, approvedPath } = prepareCliSources(tempRoot);
  const targetPath = join(tempRoot, 'symlink-target.json');
  const outputPath = join(tempRoot, 'candidate.json');
  const targetBefore = 'SYMLINK_TARGET_MUST_NOT_CHANGE\n';
  writeFileSync(targetPath, targetBefore, 'utf8');
  symlinkSync(targetPath, outputPath);
  const inputBefore = readFileSync(inputPath, 'utf8');
  const aliasesBefore = readFileSync(aliasesPath, 'utf8');
  const approvedBefore = readFileSync(approvedPath, 'utf8');

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
      approved: approvedPath,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /output.*symlink/i);
    assert.ok(lstatSync(outputPath).isSymbolicLink());
    assert.equal(readlinkSync(outputPath), targetPath);
    assert.equal(readFileSync(targetPath, 'utf8'), targetBefore);
    assert.equal(readFileSync(inputPath, 'utf8'), inputBefore);
    assert.equal(readFileSync(aliasesPath, 'utf8'), aliasesBefore);
    assert.equal(readFileSync(approvedPath, 'utf8'), approvedBefore);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI atomically replaces an existing regular candidate and leaves no temp residue', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-regular-output-'));
  const { inputPath, aliasesPath } = prepareCliSources(tempRoot);
  const approvedPath = join(tempRoot, 'approved.json');
  rmSync(approvedPath);
  const outputPath = join(tempRoot, 'candidate.json');
  writeFileSync(outputPath, 'OLD_CANDIDATE\n', 'utf8');
  const inputBefore = readFileSync(inputPath, 'utf8');
  const aliasesBefore = readFileSync(aliasesPath, 'utf8');

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const candidate = JSON.parse(readFileSync(outputPath, 'utf8')) as SnapshotCandidate;
    assert.equal(candidate.opportunities.length, 3);
    assert.equal(readFileSync(inputPath, 'utf8'), inputBefore);
    assert.equal(readFileSync(aliasesPath, 'utf8'), aliasesBefore);
    assert.deepEqual(readdirSync(tempRoot).sort(), [
      'aliases.json',
      'candidate.json',
      'input.json',
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('atomic writer cancellation before rename preserves output and removes its temp file', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-atomic-cancel-'));
  const outputPath = join(tempRoot, 'candidate.json');
  const outputBefore = 'CURRENT_CANDIDATE_MUST_SURVIVE\n';
  writeFileSync(outputPath, outputBefore, 'utf8');
  const controller = new AbortController();
  controller.abort(new Error('cancelled before atomic rename'));

  try {
    await assert.rejects(
      writeCandidateAtomically(
        outputPath,
        importScoutingData(freshCliInput(), identities()),
        controller.signal,
      ),
      /cancelled before atomic rename/i,
    );
    assert.equal(readFileSync(outputPath, 'utf8'), outputBefore);
    assert.deepEqual(readdirSync(tempRoot), ['candidate.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI cleans sibling temp files when atomic replacement fails', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-output-failure-'));
  const { inputPath, aliasesPath } = prepareCliSources(tempRoot);
  rmSync(join(tempRoot, 'approved.json'));
  const outputPath = join(tempRoot, 'candidate.json');
  mkdirSync(outputPath);

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
    });

    assert.notEqual(result.status, 0);
    assert.ok(lstatSync(outputPath).isDirectory());
    assert.deepEqual(readdirSync(tempRoot).sort(), [
      'aliases.json',
      'candidate.json',
      'input.json',
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects a stale confirmed-open candidate and leaves output untouched', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-stale-output-'));
  const inputPath = join(tempRoot, 'input.json');
  const aliasesPath = join(tempRoot, 'aliases.json');
  const outputPath = join(tempRoot, 'candidate.json');
  const outputBefore = 'CURRENT_CANDIDATE_MUST_SURVIVE\n';
  writeJson(inputPath, staleCliInput());
  writeJson(aliasesPath, {});
  writeFileSync(outputPath, outputBefore, 'utf8');

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /freshness|confirmed-open.*future/i);
    assert.equal(readFileSync(outputPath, 'utf8'), outputBefore);
    assert.deepEqual(readdirSync(tempRoot).sort(), [
      'aliases.json',
      'candidate.json',
      'input.json',
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects a denied official subdomain without creating output', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-denied-subdomain-'));
  const input = freshCliInput();
  input.mainRows[0].officialUrl = 'https://m.baoyantongzhi.com/notice/1';
  const inputPath = join(tempRoot, 'input.json');
  const aliasesPath = join(tempRoot, 'aliases.json');
  const outputPath = join(tempRoot, 'candidate.json');
  writeJson(inputPath, input);
  writeJson(aliasesPath, {});

  try {
    const result = runImporterCli({
      input: inputPath,
      aliases: aliasesPath,
      output: outputPath,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /official website/i);
    assert.equal(existsSync(outputPath), false);
    assert.deepEqual(readdirSync(tempRoot).sort(), ['aliases.json', 'input.json']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects an existing non-snapshot approved JSON without writing output', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scouting-invalid-approved-'));
  const outputPath = join(tempRoot, 'candidate.json');

  try {
    const result = spawnSync('corepack', [
      'pnpm@10.28.2',
      'run',
      'snapshot:import',
      '--',
      '--input',
      validFixturePath,
      '--aliases',
      resolve(repositoryRoot, 'data/project-id-aliases.json'),
      '--output',
      outputPath,
      '--approved',
      validFixturePath,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /approved snapshot validation failed/i);
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
