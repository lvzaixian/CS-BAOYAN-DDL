import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  importScoutingData,
  type IdentityContext,
} from '../scripts/snapshot/import-scouting-data.js';
import { validateCandidate } from '../src/lib/snapshot-validation.js';
import type { PublicSnapshot, SnapshotCandidate } from '../src/lib/snapshot-types.js';

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
  return previous;
}

function sealCandidate(candidate: SnapshotCandidate): PublicSnapshot {
  return {
    ...structuredClone(candidate),
    snapshotId: 'test-approved-snapshot',
    approvedAt: candidate.scanAt,
    previousSnapshotId: null,
    dataHash: '0'.repeat(64),
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

test('uses the public project title when a confirmed main row omits description', () => {
  const input = validInput();
  delete input.mainRows[0].description;

  const candidate = importScoutingData(input, identities());
  const active = opportunity(candidate, '2026年优秀大学生夏令营');

  assert.equal(active.description, active.project);
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
  const input = sharedOfficialUrlInput();
  const migratedUrl = 'https://cs.example.edu.cn/admissions/migrated';
  input.mainRows[0].officialUrl = migratedUrl;
  input.mainRows[1].officialUrl = migratedUrl;

  assert.throws(
    () => importScoutingData(input, identities({
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

test('preserves confirmed negative recommendation wording', () => {
  const input = validInput();
  input.mainRows[0].recommendationLetters = '未要求推荐信';
  delete input.mainRows[0].recommendationTemplate;

  const active = opportunity(
    importScoutingData(input, identities()),
    '2026年优秀大学生夏令营',
  );

  assert.deepEqual(active.recommendation, {
    status: 'confirmed',
    summary: '推荐信数量：未要求推荐信',
  });
});

test('rejects a non-null previous identity unless it is a valid approved snapshot', () => {
  const invalidPrevious = validInput() as unknown as PublicSnapshot;

  assert.throws(
    () => importScoutingData(validInput(), identities({ previous: invalidPrevious })),
    /approved snapshot validation failed/i,
  );
});

test('rejects aggregator detail URLs used as the official website', () => {
  const input = JSON.parse(readFileSync(invalidOfficialFixturePath, 'utf8')) as unknown;

  assert.throws(
    () => importScoutingData(input, identities()),
    /official website/i,
  );
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
  const outputPath = join(tempRoot, 'nested', 'candidate.json');

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
      join(tempRoot, 'missing-approved.json'),
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const candidate = JSON.parse(readFileSync(outputPath, 'utf8')) as SnapshotCandidate;
    assert.equal(candidate.counts.pendingExcluded, 1);
    assert.deepEqual(validateCandidate(candidate, Date.parse(candidate.scanAt)), []);
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
