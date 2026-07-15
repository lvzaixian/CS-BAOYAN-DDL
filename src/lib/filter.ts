import type { DerivedSchool, FilterState, School, StatusTag } from './types';
import { urgency } from './time';
import { resolveProvince } from '$data/provinces';

export function deriveSchool(s: School, nowMs: number): DerivedSchool {
  const deadlineMs = s.deadlineEpochMs;
  const remainingMs = deadlineMs === null ? null : deadlineMs - nowMs;
  const group = rowGroup(s);
  return {
    ...s,
    deadlineMs,
    remainingMs,
    urgency: group === 'expired' ? 'expired' : group === 'active-unknown' ? 'unknown' : urgency(remainingMs),
  };
}

export type RowGroup = 'active-timed' | 'active-unknown' | 'expired';

const ROW_GROUP_ORDER: Record<RowGroup, number> = {
  'active-timed': 0,
  'active-unknown': 1,
  expired: 2,
};

export function rowGroup(
  row: Pick<School, 'verificationStatus' | 'deadlineEpochMs'>,
): RowGroup {
  if (row.verificationStatus === 'expired') return 'expired';
  if (row.verificationStatus === 'confirmed-unknown-deadline' || row.deadlineEpochMs === null) {
    return 'active-unknown';
  }
  return 'active-timed';
}

export function rowKey(row: Pick<School, 'projectId'>): string {
  return row.projectId;
}

export function opportunityStatusLabel(
  row: Pick<School, 'verificationStatus'>,
): StatusTag {
  return row.verificationStatus === 'expired' ? '已结营' : '已开营';
}

export function countStatuses(
  rows: readonly Pick<School, 'verificationStatus'>[],
): Record<StatusTag, number> {
  const counts: Record<StatusTag, number> = { 已开营: 0, 已结营: 0 };
  for (const row of rows) counts[opportunityStatusLabel(row)] += 1;
  return counts;
}

export function sourceLinkLabel(
  row: Pick<School, 'discoverySources'>,
): '官方来源' | '历史来源（未核验）' {
  return row.discoverySources.some((source) => source.kind === 'official')
    ? '官方来源'
    : '历史来源（未核验）';
}

export function expiredDeadlineText(
  row: Pick<School, 'verificationStatus'>,
): '已结束' | null {
  return row.verificationStatus === 'expired' ? '已结束' : null;
}

export function pickCalendarMonth(
  rows: readonly Pick<School, 'verificationStatus' | 'deadlineEpochMs'>[],
  nowMs: number,
): { y: number; m: number } {
  let earliestActive: number | null = null;
  let earliestArchive: number | null = null;
  for (const row of rows) {
    if (row.deadlineEpochMs === null) continue;
    if (rowGroup(row) === 'active-timed') {
      if (earliestActive === null || row.deadlineEpochMs < earliestActive) {
        earliestActive = row.deadlineEpochMs;
      }
    } else if (earliestArchive === null || row.deadlineEpochMs < earliestArchive) {
      earliestArchive = row.deadlineEpochMs;
    }
  }
  const target = new Date(earliestActive ?? earliestArchive ?? nowMs);
  return { y: target.getFullYear(), m: target.getMonth() };
}

function compareProjectId(a: School, b: School): number {
  return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
}

interface ApplyOpts {
  query: string;
  tags: readonly string[];
  status: readonly string[]; // 已开营 / 已结营
  provinces: readonly string[];
}

/** Pure: filter + sort. Caller passes already-derived rows. */
export function applyFilters(
  rows: readonly DerivedSchool[],
  { query, tags, status, provinces }: ApplyOpts,
): DerivedSchool[] {
  const q = query.trim().toLowerCase();
  const tagSet = new Set(tags);
  const statusSet = new Set(status);
  const provSet = new Set(provinces);

  const out = rows.filter((r) => {
    // school-tier tags: OR across selected
    if (tagSet.size > 0) {
      const hit = r.tags.some((t) => tagSet.has(t));
      if (!hit) return false;
    }
    // opening status: OR across selected, derived from authoritative verification state
    if (statusSet.size > 0 && !statusSet.has(opportunityStatusLabel(r))) return false;
    // search across name + institute (case-insensitive)
    if (q) {
      const hay = `${r.name} ${r.institute}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // province
    if (provSet.size > 0) {
      const p = resolveProvince(r.name, r.province);
      if (!p || !provSet.has(p)) return false;
    }
    return true;
  });

  // Approved verification status is authoritative for grouping.
  out.sort((a, b) => {
    const aGroup = rowGroup(a);
    const bGroup = rowGroup(b);
    const aBucket = ROW_GROUP_ORDER[aGroup];
    const bBucket = ROW_GROUP_ORDER[bGroup];
    if (aBucket !== bBucket) return aBucket - bBucket;
    if (aGroup === 'active-timed') {
      const deadlineOrder = (a.deadlineEpochMs as number) - (b.deadlineEpochMs as number);
      if (deadlineOrder !== 0) return deadlineOrder;
    } else if (aGroup === 'expired') {
      if (a.deadlineEpochMs === null && b.deadlineEpochMs !== null) return 1;
      if (a.deadlineEpochMs !== null && b.deadlineEpochMs === null) return -1;
      if (a.deadlineEpochMs !== null && b.deadlineEpochMs !== null) {
        const deadlineOrder = b.deadlineEpochMs - a.deadlineEpochMs;
        if (deadlineOrder !== 0) return deadlineOrder;
      }
    }
    return compareProjectId(a, b);
  });

  return out;
}

export const matchesFilter = (state: FilterState) => ({
  query: state.query,
  tags: state.tags,
  status: state.status,
  provinces: state.provinces,
});
