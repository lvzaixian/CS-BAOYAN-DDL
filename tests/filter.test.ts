import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFilters,
  deriveSchool,
  pickCalendarMonth,
  rowGroup,
  rowKey,
} from '../src/lib/filter';
import {
  defaultFeedId,
  feedCatalog,
  getSchools,
  isValidFeedId,
  sourceCounts,
} from '../src/lib/schools';
import type { School } from '../src/lib/types';

const now = Date.parse('2026-07-15T00:00:00+08:00');

function school(overrides: Partial<School>): School {
  return {
    projectId: '2027|测试大学|计算机学院|夏令营',
    feedId: 'camp2027',
    name: '测试大学',
    institute: '计算机学院',
    project: '优秀大学生夏令营',
    eventType: '夏令营',
    description: '优秀大学生夏令营',
    verificationStatus: 'confirmed-open',
    deadline: '2026-07-20T23:59:00+08:00',
    deadlineOriginal: '2026年7月20日',
    deadlineEpochMs: Date.parse('2026-07-20T23:59:00+08:00'),
    website: 'https://cs.example.edu.cn/summer-camp',
    tags: [],
    verifiedAt: '2026-07-15T00:00:00+08:00',
    discoverySources: [
      {
        kind: 'official',
        label: '官方链接',
        url: 'https://cs.example.edu.cn/summer-camp',
      },
    ],
    logistics: { status: 'not-published', summary: '未公布' },
    recommendation: { status: 'not-published', summary: '未公布' },
    materials: { status: 'not-published', summary: '未公布' },
    ...overrides,
  };
}

const emptyFilters = {
  query: '',
  tags: [],
  status: [],
  provinces: [],
};

test('uses projectId as the stable row key', () => {
  assert.equal(rowKey({ projectId: 'cycle|school|college|round' }), 'cycle|school|college|round');
});

test('derives approved deadlines from deadlineEpochMs without reparsing deadline text', () => {
  const deadlineEpochMs = Date.parse('2026-07-18T12:00:00+08:00');
  const row = deriveSchool(school({ deadline: 'not-a-date', deadlineEpochMs }), now);

  assert.equal(row.deadlineMs, deadlineEpochMs);
  assert.equal(row.remainingMs, deadlineEpochMs - now);
});

test('sorts active timed rows before active unknown rows and expired rows', () => {
  const sooner = school({
    projectId: '2027|测试大学|计算机学院|sooner',
    deadlineEpochMs: Date.parse('2026-07-16T00:00:00+08:00'),
  });
  const later = school({
    projectId: '2027|测试大学|计算机学院|later',
    deadlineEpochMs: Date.parse('2026-07-17T00:00:00+08:00'),
  });
  const unknown = school({
    projectId: '2027|测试大学|计算机学院|unknown',
    verificationStatus: 'confirmed-unknown-deadline',
    deadline: null,
    deadlineEpochMs: null,
  });
  const expired = school({
    projectId: '2027|测试大学|计算机学院|expired',
    verificationStatus: 'expired',
    deadline: null,
    deadlineEpochMs: null,
  });
  const rows = [unknown, later, expired, sooner].map((row) => deriveSchool(row, now));

  assert.deepEqual(applyFilters(rows, emptyFilters).map(rowKey), [
    sooner.projectId,
    later.projectId,
    unknown.projectId,
    expired.projectId,
  ]);
});

test('uses projectId to break equal-deadline ties deterministically', () => {
  const deadlineEpochMs = Date.parse('2026-07-18T00:00:00+08:00');
  const z = deriveSchool(school({ projectId: 'z-project', deadlineEpochMs }), now);
  const a = deriveSchool(school({ projectId: 'a-project', deadlineEpochMs }), now);

  assert.deepEqual(applyFilters([z, a], emptyFilters).map(rowKey), ['a-project', 'z-project']);
});

test('keeps an approved expired row with a null deadline in the expired group', () => {
  const row = deriveSchool(school({
    projectId: 'expired-without-deadline',
    verificationStatus: 'expired',
    deadline: null,
    deadlineEpochMs: null,
  }), now);

  assert.equal(rowGroup(row), 'expired');
  assert.equal(row.urgency, 'expired');
});

test('uses an archive deadline month when a feed has no active timed rows', () => {
  const archiveDeadline = Date.parse('2025-04-20T00:00:00+08:00');
  const archive = deriveSchool(school({
    projectId: 'legacy|camp2025|测试大学|计算机学院|0',
    verificationStatus: 'expired',
    deadlineEpochMs: archiveDeadline,
  }), now);

  assert.deepEqual(pickCalendarMonth([archive], now), { y: 2025, m: 3 });
});

test('accepts approved feeds dynamically and uses the approved default', () => {
  assert.equal(isValidFeedId('camp2027'), true);
  assert.equal(isValidFeedId('camp2028'), true);
  assert.equal(defaultFeedId, 'camp2028');
  assert.deepEqual(feedCatalog.map((feed) => feed.id), [
    'camp2026',
    'camp2027',
    'camp2028',
    'camp2025',
    'camp2024',
    'yutuimian2024',
  ]);
});

test('approved feeds exclusively own overlapping legacy feed IDs', () => {
  assert.deepEqual(getSchools('camp2026').map(rowKey), [
    '2026|历史大学|网络空间安全学院|预推免',
  ]);
  assert.deepEqual(getSchools('camp2027').map(rowKey), [
    '2027|测试大学|计算机学院|夏令营',
  ]);
  assert.equal(getSchools('camp2027').some((row) => row.projectId.startsWith('legacy|')), false);
});

test('maps legacy archives to deterministic IDs and unverified source metadata', () => {
  const row = getSchools('camp2025')[0];

  assert.equal(row.projectId, 'legacy|camp2025|清华大学|智能产业研究院|0');
  assert.equal(row.verificationStatus, 'expired');
  assert.equal(row.eventType, '历史归档');
  assert.equal(row.verifiedAt, '');
  assert.deepEqual(row.discoverySources, [
    {
      kind: 'other-discovery',
      label: '历史归档来源（未核验）',
      url: row.website,
    },
  ]);
  assert.deepEqual(row.logistics, { status: 'unverified', summary: '历史归档未核验' });
  assert.deepEqual(row.recommendation, { status: 'unverified', summary: '历史归档未核验' });
  assert.deepEqual(row.materials, { status: 'unverified', summary: '历史归档未核验' });
});

test('keeps a legacy row with a missing deadline as an expired archive', () => {
  const row = getSchools('camp2024').find(
    (candidate) => candidate.projectId === 'legacy|camp2024|清华大学|智能产业研究院|2',
  );
  assert.ok(row);

  const derived = deriveSchool(row, now);
  assert.equal(row.deadlineEpochMs, null);
  assert.equal(rowGroup(derived), 'expired');
  assert.equal(derived.urgency, 'expired');
});

test('keeps duplicate legacy display names distinct by deterministic projectId', () => {
  const duplicates = getSchools('camp2024').filter(
    (row) => row.name === '中国科学院' && row.institute === '沈阳自动化研究所',
  );

  assert.deepEqual(duplicates.map(rowKey), [
    'legacy|camp2024|中国科学院|沈阳自动化研究所|66',
    'legacy|camp2024|中国科学院|沈阳自动化研究所|303',
  ]);
});

test('computes counts from the dynamic feed catalog', () => {
  const counts = sourceCounts();

  assert.deepEqual(Object.keys(counts), feedCatalog.map((feed) => feed.id));
  for (const feed of feedCatalog) {
    assert.equal(counts[feed.id], getSchools(feed.id).length);
  }
});
