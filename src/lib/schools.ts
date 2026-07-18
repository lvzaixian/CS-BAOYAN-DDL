import approved from '$approved/current.json';
import legacy from '$data/legacy-schools.json';
import { parseDeadline } from './time';
import type {
  FeedDescriptor,
  FieldFactGroup,
  LegacyPublicOpportunityV1,
  PublicOpportunity,
  ReadablePublicSnapshot,
} from './snapshot-types';
import type { FeedId, School } from './types';
import { resolveSchoolTierTags } from './school-tier';

interface LegacySchool {
  name: string;
  institute: string;
  description: string;
  deadline?: string | null;
  website: string;
  tags: string[];
  province?: string;
}

type LegacySchoolsByFeed = Record<string, LegacySchool[]>;

const snapshot = approved as ReadablePublicSnapshot;
const legacySchools = legacy as LegacySchoolsByFeed;

const historicalTagsBySchool = new Map<string, string[]>();
for (const row of Object.values(legacySchools).flat()) {
  const tags = historicalTagsBySchool.get(row.name) ?? [];
  tags.push(...row.tags);
  historicalTagsBySchool.set(row.name, tags);
}

function unrecordedV1Fact(): FieldFactGroup {
  return { status: 'unverified', summary: '旧版快照未记录' };
}

function adaptV1Opportunity(row: LegacyPublicOpportunityV1): PublicOpportunity {
  return {
    ...row,
    eventArrangement: {
      mode: 'unknown',
      time: unrecordedV1Fact(),
      formatLocation: unrecordedV1Fact(),
    },
  };
}

const approvedOpportunities: PublicOpportunity[] = (snapshot.schemaVersion === 1
  ? snapshot.opportunities.map(adaptV1Opportunity)
  : snapshot.opportunities).map((row) => ({
    ...row,
    tags: resolveSchoolTierTags(
      row.name,
      row.tags,
      historicalTagsBySchool.get(row.name) ?? [],
    ),
  }));

function legacyFeedDescriptor(feedId: string): FeedDescriptor {
  const year = feedId.match(/\d{4}/)?.[0] ?? '0000';
  const baseLabel = feedId.startsWith('camp')
    ? `夏令营 ${year}`
    : feedId.startsWith('yutuimian')
      ? `预推免 ${year}`
      : feedId;
  return {
    id: feedId,
    label: `${baseLabel}（历史归档）`,
    admissionCycle: year,
    eventYear: Number(year),
  };
}

function unverifiedLegacyFact(): FieldFactGroup {
  return { status: 'unverified', summary: '历史归档未核验' };
}

export function legacyProjectId(
  feedId: FeedId,
  row: { name: string; institute: string },
  index: number,
): string {
  return `legacy|${feedId}|${row.name}|${row.institute}|${index}`;
}

export function legacyDisplayTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag !== '已开营' && tag !== '已结营');
}

function mapLegacySchool(feedId: FeedId, row: LegacySchool, index: number): School {
  const deadlineOriginal = row.deadline?.trim() ?? '';
  const deadlineEpochMs = parseDeadline(deadlineOriginal);
  return {
    projectId: legacyProjectId(feedId, row, index),
    feedId,
    name: row.name,
    institute: row.institute,
    project: row.description,
    eventType: '历史归档',
    description: row.description,
    verificationStatus: 'expired',
    deadline: deadlineEpochMs === null ? null : deadlineOriginal,
    deadlineOriginal: deadlineOriginal || '历史数据未提供',
    deadlineEpochMs,
    website: row.website,
    tags: resolveSchoolTierTags(row.name, legacyDisplayTags(row.tags), []),
    ...(row.province ? { province: row.province } : {}),
    verifiedAt: '',
    discoverySources: row.website
      ? [{ kind: 'other-discovery', label: '历史归档来源（未核验）', url: row.website }]
      : [],
    logistics: unverifiedLegacyFact(),
    recommendation: unverifiedLegacyFact(),
    materials: unverifiedLegacyFact(),
    eventArrangement: {
      mode: 'unknown',
      time: unverifiedLegacyFact(),
      formatLocation: unverifiedLegacyFact(),
    },
  };
}

const approvedFeedIds = new Set(snapshot.feeds.map((feed) => feed.id));
const legacyFeedCatalog = Object.keys(legacySchools)
  .filter((feedId) => !approvedFeedIds.has(feedId))
  .map(legacyFeedDescriptor);

export const feedCatalog: FeedDescriptor[] = [...snapshot.feeds, ...legacyFeedCatalog];
export const defaultFeedId: FeedId = snapshot.defaultFeedId;

export const schoolsByFeed: Record<FeedId, School[]> = Object.fromEntries([
  ...snapshot.feeds.map((feed) => [
    feed.id,
    approvedOpportunities.filter((row) => row.feedId === feed.id),
  ] as const),
  ...legacyFeedCatalog.map((feed) => [
    feed.id,
    legacySchools[feed.id].map((row, index) => mapLegacySchool(feed.id, row, index)),
  ] as const),
]);

export function isValidFeedId(value: string): value is FeedId {
  return feedCatalog.some((feed) => feed.id === value);
}

export function getSchools(feedId: FeedId): School[] {
  return schoolsByFeed[feedId] ?? [];
}

export function sourceCounts(): Record<FeedId, number> {
  return Object.fromEntries(
    feedCatalog.map((feed) => [feed.id, schoolsByFeed[feed.id]?.length ?? 0]),
  );
}
