import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyFilters,
  countModes,
  countUpcomingDeadlines,
  countStatuses,
  deriveSchool,
  eventModeLabel,
  expiredDeadlineText,
  opportunityStatusLabel,
  pickCalendarMonth,
  rowGroup,
  rowKey,
  sourceLinkLabel,
} from '../src/lib/filter';
import {
  defaultFeedId,
  feedCatalog,
  getSchools,
  isValidFeedId,
  legacyDisplayTags,
  legacyProjectId,
  sourceCounts,
} from '../src/lib/schools';
import { SCHOOL_TAGS, type School } from '../src/lib/types';
import { resolveSchoolTierTags } from '../src/lib/school-tier';
import approved from '../data/approved/current.json';
import legacy from '../src/data/legacy-schools.json';

interface LegacyRow {
  name: string;
  institute: string;
  description: string;
  deadline?: string | null;
  website: string;
  tags: string[];
  province?: string;
}

const legacyByFeed = legacy as Record<string, LegacyRow[]>;
const filterPanelSource = readFileSync(
  new URL('../src/components/FilterPanel.svelte', import.meta.url),
  'utf8',
);
const headerSource = readFileSync(new URL('../src/components/Header.svelte', import.meta.url), 'utf8');
const schoolRowSource = readFileSync(
  new URL('../src/components/SchoolRow.svelte', import.meta.url),
  'utf8',
);
const detailPanelSource = readFileSync(
  new URL('../src/components/DetailPanel.svelte', import.meta.url),
  'utf8',
);

const now = Date.parse('2026-07-15T00:00:00+08:00');

function school(overrides: Partial<School>): School {
  return {
    projectId: '2027|测试大学|计算机学院|夏令营',
    feedId: 'test-feed',
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
    eventArrangement: {
      mode: 'unknown',
      time: { status: 'not-published', summary: '未公布' },
      formatLocation: { status: 'not-published', summary: '未公布' },
    },
    ...overrides,
  };
}

const emptyFilters = {
  query: '',
  tags: [],
  status: [],
  modes: [],
  provinces: [],
};

test('resolves one stable display tier from explicit, historical and research-institute evidence', () => {
  assert.deepEqual(resolveSchoolTierTags('北京大学', ['985', 'TOP2'], []), ['TOP2']);
  assert.deepEqual(resolveSchoolTierTags('浙江大学', [], ['985', 'C9', '华五']), ['华五']);
  assert.deepEqual(resolveSchoolTierTags('中国科学院软件研究所', [], []), ['研究院']);
  assert.deepEqual(resolveSchoolTierTags('未分类大学', [], []), []);
});

test('enriches the current approved feed with reference-compatible tier tags', () => {
  const current = getSchools(defaultFeedId);
  const tagged = current.filter((row) => row.tags.some((tag) => SCHOOL_TAGS.includes(tag as never)));

  assert.ok(tagged.length >= 50, `expected broad tier coverage, got ${tagged.length}`);
  assert.deepEqual(
    current.find((row) => row.name === '清华大学')?.tags,
    ['TOP2'],
  );
  assert.deepEqual(
    current.find((row) => row.name === '中国科学院软件研究所')?.tags,
    ['研究院'],
  );
});

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

test('moves a confirmed-open row into the ended group when its deadline arrives', () => {
  const deadlineEpochMs = Date.parse('2026-07-18T12:00:00+08:00');
  const before = deriveSchool(school({ projectId: 'runtime-deadline', deadlineEpochMs }), deadlineEpochMs - 1);
  const ended = deriveSchool(school({ projectId: 'runtime-deadline', deadlineEpochMs }), deadlineEpochMs);

  assert.equal(rowGroup(before), 'active-timed');
  assert.equal(rowGroup(ended), 'expired');
  assert.equal(ended.urgency, 'expired');
  assert.equal(opportunityStatusLabel(ended), '已结束');
  assert.equal(expiredDeadlineText(ended), '已结束');
  assert.deepEqual(countStatuses([before, ended]), { 开放: 1, 已结束: 1 });
  assert.deepEqual(
    applyFilters([before, ended], { ...emptyFilters, status: ['已结束'] }).map(rowKey),
    [ended.projectId],
  );
});

test('excludes the exact-deadline row from upcoming toolbar counts', () => {
  const deadlineEpochMs = Date.parse('2026-07-18T12:00:00+08:00');
  const ended = deriveSchool(school({ projectId: 'ended-now', deadlineEpochMs }), deadlineEpochMs);
  const upcoming = deriveSchool(
    school({ projectId: 'upcoming', deadlineEpochMs: deadlineEpochMs + 1 }),
    deadlineEpochMs,
  );

  assert.deepEqual(countUpcomingDeadlines([ended, upcoming]), { week: 1, month: 1, all: 1 });
});

test('filters status from verificationStatus with OR semantics and ignores contradictory tags', () => {
  const active = deriveSchool(school({ projectId: 'active-empty-tags', tags: [] }), now);
  const activeUnknown = deriveSchool(school({
    projectId: 'active-unknown-empty-tags',
    verificationStatus: 'confirmed-unknown-deadline',
    deadline: null,
    deadlineEpochMs: null,
    tags: [],
  }), now);
  const activeWithStaleTag = deriveSchool(school({
    projectId: 'active-with-stale-ended-tag',
    tags: ['已结营'],
  }), now);
  const legacyWithContradictoryTag = deriveSchool(school({
    projectId: 'legacy|archive|school|institute|0',
    verificationStatus: 'expired',
    deadline: null,
    deadlineEpochMs: null,
    tags: ['已开营'],
    discoverySources: [{
      kind: 'other-discovery',
      label: '历史归档来源（未核验）',
      url: 'https://discovery.example/archive',
    }],
  }), now);
  const rows = [legacyWithContradictoryTag, activeUnknown, activeWithStaleTag, active];
  const filteredIds = (status: string[]) => new Set(
    applyFilters(rows, { ...emptyFilters, status }).map(rowKey),
  );

  assert.deepEqual(filteredIds(['开放']), new Set([
    active.projectId,
    activeUnknown.projectId,
    activeWithStaleTag.projectId,
  ]));
  assert.deepEqual(filteredIds(['已结束']), new Set([legacyWithContradictoryTag.projectId]));
  assert.deepEqual(filteredIds(['开放', '已结束']), new Set(rows.map(rowKey)));
  assert.deepEqual(countStatuses(rows), { 开放: 3, 已结束: 1 });
});

test('counts event modes and applies mode OR with cross-dimension AND semantics', () => {
  const online = deriveSchool(school({
    projectId: 'online',
    project: '人工智能开放日',
    eventType: '开放日',
    tags: ['985'],
    province: '北京',
    eventArrangement: {
      mode: 'online',
      time: { status: 'confirmed', summary: '7月20日' },
      formatLocation: { status: 'confirmed', summary: '腾讯会议' },
    },
  }), now);
  const offline = deriveSchool(school({
    projectId: 'offline',
    project: '网络安全夏令营',
    eventType: '夏令营',
    tags: ['211'],
    province: '上海',
    eventArrangement: {
      mode: 'offline',
      time: { status: 'confirmed', summary: '7月21日' },
      formatLocation: { status: 'confirmed', summary: '校内' },
    },
  }), now);
  const hybrid = deriveSchool(school({
    projectId: 'hybrid',
    project: '智能系统体验营',
    eventType: '夏令营',
    tags: ['985'],
    province: '北京',
    eventArrangement: {
      mode: 'hybrid',
      time: { status: 'confirmed', summary: '7月22日' },
      formatLocation: { status: 'confirmed', summary: '线上与校内' },
    },
  }), now);
  const unknown = deriveSchool(school({ projectId: 'unknown' }), now);
  const rows = [online, offline, hybrid, unknown];

  assert.deepEqual(countModes(rows), { online: 1, offline: 1, hybrid: 1, unknown: 1 });
  assert.deepEqual(
    new Set(applyFilters(rows, { ...emptyFilters, modes: ['online', 'offline'] }).map(rowKey)),
    new Set(['online', 'offline']),
  );
  assert.deepEqual(
    applyFilters(rows, {
      ...emptyFilters,
      modes: ['online', 'hybrid'],
      tags: ['985'],
      status: ['开放'],
      provinces: ['北京'],
      query: '人工智能',
    }).map(rowKey),
    ['online'],
  );
  assert.deepEqual(
    ['online', 'offline', 'hybrid', 'unknown'].map((mode) => eventModeLabel(mode as never)),
    ['线上', '线下', '混合', '未核验'],
  );
});

test('searches name, institute, project and event type', () => {
  const row = deriveSchool(school({
    projectId: 'searchable',
    project: '可信人工智能开放日',
    eventType: '招生宣讲',
  }), now);

  for (const query of ['测试大学', '计算机学院', '可信人工智能', '招生宣讲']) {
    assert.deepEqual(applyFilters([row], { ...emptyFilters, query }).map(rowKey), ['searchable']);
  }
});

test('labels links by official-source provenance', () => {
  const official = school({});
  const historical = school({
    discoverySources: [{
      kind: 'other-discovery',
      label: '历史归档来源（未核验）',
      url: 'https://discovery.example/archive',
    }],
  });

  assert.equal(sourceLinkLabel(official), '官方来源');
  assert.equal(sourceLinkLabel(historical), '历史来源（未核验）');
  assert.equal(sourceLinkLabel(school({ discoverySources: [] })), '历史来源（未核验）');
});

test('overrides a null relative deadline only for expired rows', () => {
  const expired = school({
    verificationStatus: 'expired',
    deadline: null,
    deadlineEpochMs: null,
  });
  const activeUnknown = school({
    verificationStatus: 'confirmed-unknown-deadline',
    deadline: null,
    deadlineEpochMs: null,
  });

  assert.equal(expiredDeadlineText(expired), '已结束');
  assert.equal(expiredDeadlineText(activeUnknown), null);
});

test('keeps status authority in filters while compact rows avoid redundant status/source labels', () => {
  assert.match(filterPanelSource, /countStatuses\(rows\)/);
  assert.doesNotMatch(schoolRowSource, /opportunityStatusLabel\(school\)/);
  assert.doesNotMatch(
    schoolRowSource,
    /school\.verificationStatus === 'expired'\s*\?\s*'已过期'\s*:\s*'已核验'/,
  );
  assert.match(schoolRowSource, /expiredDeadlineText\(school\)/);
  assert.doesNotMatch(schoolRowSource, /sourceLinkLabel\(school\)/);
  assert.doesNotMatch(detailPanelSource, /expiredDeadlineText\(school\)/);
  assert.doesNotMatch(detailPanelSource, /sourceLinkLabel\(school\)/);
});

test('keeps the feed selector readable on narrow mobile headers and auto-sized on desktop', () => {
  assert.match(headerSource, /w-32 min-w-32 shrink-0/);
  assert.match(headerSource, /sm:w-auto sm:min-w-0 sm:max-w-none/);
  assert.match(headerSource, /w-full min-w-0 sm:w-auto/);
});

test('uses AA-safe foreground tokens for small filter counts', () => {
  assert.doesNotMatch(filterPanelSource, /text-\[10px\][^"\n]*text-fg-3/);
  assert.match(filterPanelSource, /text-\[10px\][^"\n]*text-fg-2/);
});

test('keeps row selection and the source link as sibling interactive controls', () => {
  const markup = schoolRowSource.slice(schoolRowSource.indexOf('</script>') + '</script>'.length);
  const primaryButtonEnd = markup.indexOf('</button>');
  const sourceLinkStart = markup.indexOf('<a');

  assert.match(markup, /^\s*<div\s+[\s\S]*data-row-key=\{key\}/);
  assert.ok(primaryButtonEnd !== -1 && sourceLinkStart > primaryButtonEnd);
});

test('uses an archive deadline month when a feed has no active timed rows', () => {
  const archiveDeadline = Date.parse('2025-04-20T00:00:00+08:00');
  const archive = deriveSchool(school({
    projectId: 'legacy|archive-feed|测试大学|计算机学院|0',
    verificationStatus: 'expired',
    deadlineEpochMs: archiveDeadline,
  }), now);

  assert.deepEqual(pickCalendarMonth([archive], now), { y: 2025, m: 3 });
});

test('uses the approved default and accepts every approved feed dynamically', () => {
  const approvedFeedIds = approved.feeds.map((feed) => feed.id);

  assert.equal(defaultFeedId, approved.defaultFeedId);
  assert.equal(isValidFeedId(defaultFeedId), true);
  assert.equal(approvedFeedIds.includes(defaultFeedId), true);
  for (const feedId of approvedFeedIds) {
    assert.equal(isValidFeedId(feedId), true);
    assert.equal(feedCatalog.some((feed) => feed.id === feedId), true);
  }
});

test('each approved feed exclusively exposes its approved opportunities', () => {
  for (const feed of approved.feeds) {
    const expectedIds = approved.opportunities
      .filter((row) => row.feedId === feed.id)
      .map((row) => row.projectId);
    assert.deepEqual(getSchools(feed.id).map(rowKey), expectedIds);
  }
});

test('adapts the approved v1 snapshot with explicit unknown arrangements', () => {
  if (approved.schemaVersion !== 1) return;
  const rows = approved.feeds.flatMap((feed) => getSchools(feed.id));

  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.eventArrangement.mode, 'unknown');
    assert.deepEqual(row.eventArrangement.time, {
      status: 'unverified',
      summary: '旧版快照未记录',
    });
    assert.deepEqual(row.eventArrangement.formatLocation, {
      status: 'unverified',
      summary: '旧版快照未记录',
    });
  }
});

test('appends only legacy feeds absent from the approved catalog', () => {
  const approvedFeedIds = approved.feeds.map((feed) => feed.id);
  const approvedFeedSet = new Set(approvedFeedIds);
  const missingLegacyFeedIds = Object.keys(legacyByFeed)
    .filter((feedId) => !approvedFeedSet.has(feedId));

  assert.deepEqual(
    feedCatalog.slice(0, approved.feeds.length).map((feed) => feed.id),
    approvedFeedIds,
  );
  assert.deepEqual(
    feedCatalog.slice(approved.feeds.length).map((feed) => feed.id),
    missingLegacyFeedIds,
  );
});

test('strips stale status tags across the legacy corpus while preserving every other tag', () => {
  let staleOpenRows = 0;

  for (const rawRows of Object.values(legacyByFeed)) {
    for (const rawRow of rawRows) {
      const expectedTags = rawRow.tags.filter((tag) => tag !== '已开营' && tag !== '已结营');
      assert.deepEqual(legacyDisplayTags(rawRow.tags), expectedTags);
      if (rawRow.tags.includes('已开营')) staleOpenRows += 1;
    }
  }

  assert.ok(staleOpenRows > 0, 'legacy corpus must exercise stale 已开营 rows');
});

test('maps appended legacy feeds with deterministic IDs and unverified provenance', () => {
  const approvedFeedSet = new Set(approved.feeds.map((feed) => feed.id));
  for (const [feedId, rawRows] of Object.entries(legacyByFeed)) {
    rawRows.forEach((rawRow, index) => {
      assert.equal(
        legacyProjectId(feedId, rawRow, index),
        `legacy|${feedId}|${rawRow.name}|${rawRow.institute}|${index}`,
      );
    });
    if (approvedFeedSet.has(feedId)) continue;

    const mappedRows = getSchools(feedId);
    assert.equal(mappedRows.length, rawRows.length);
    mappedRows.forEach((row, index) => {
      assert.equal(row.projectId, legacyProjectId(feedId, rawRows[index], index));
      assert.equal(row.verificationStatus, 'expired');
      assert.deepEqual(
        row.tags,
        resolveSchoolTierTags(
          rawRows[index].name,
          legacyDisplayTags(rawRows[index].tags),
          [],
        ),
      );
      assert.equal(row.tags.includes('已开营'), false);
      assert.equal(row.tags.includes('已结营'), false);
      assert.equal(sourceLinkLabel(row), '历史来源（未核验）');
      assert.equal(row.discoverySources.some((source) => source.kind === 'official'), false);
      assert.equal(row.eventArrangement.mode, 'unknown');
      assert.equal(row.eventArrangement.time.status, 'unverified');
      assert.equal(row.eventArrangement.formatLocation.status, 'unverified');
    });
  }
});

test('computes counts from the dynamic feed catalog', () => {
  const counts = sourceCounts();

  assert.deepEqual(Object.keys(counts), feedCatalog.map((feed) => feed.id));
  for (const feed of feedCatalog) {
    assert.equal(counts[feed.id], getSchools(feed.id).length);
  }
});
