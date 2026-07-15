import type { PublicOpportunity } from './snapshot-types';

export type FeedId = string;

export interface School extends PublicOpportunity {}

export const SCHOOL_TAGS = ['TOP2', '港三', '华五', 'C9', '985', '211', '双非', '四非', '研究院', '联培'] as const;
export type SchoolTag = (typeof SCHOOL_TAGS)[number];

export const STATUS_TAGS = ['已开营', '已结营'] as const;
export type StatusTag = (typeof STATUS_TAGS)[number];

export type ViewMode = 'list' | 'calendar';

export interface FilterState {
  source: FeedId;
  view: ViewMode;
  query: string;
  tags: SchoolTag[];
  status: StatusTag[];
  provinces: string[];
}

export type Urgency = 'expired' | 'critical' | 'soon' | 'near' | 'far' | 'unknown';

export interface DerivedSchool extends School {
  /** UI compatibility alias for deadlineEpochMs. */
  deadlineMs: number | null;
  /** ms remaining; null if no deadline. Negative if expired. */
  remainingMs: number | null;
  urgency: Urgency;
}
