export type VerificationStatus =
  | 'confirmed-open'
  | 'confirmed-unknown-deadline'
  | 'expired';

export type FactStatus = 'confirmed' | 'not-published' | 'unverified' | 'not-applicable';

export type DiscoveryKind = 'official' | 'baoyan-notice' | 'cs-baoyan' | 'other-discovery';

export interface FieldFactGroup {
  status: FactStatus;
  summary: string;
}

export interface PublicSourceLink {
  kind: DiscoveryKind;
  label: string;
  url: string;
}

export interface FeedDescriptor {
  id: string;
  label: string;
  admissionCycle: string;
  eventYear: number;
}

export interface PublicOpportunity {
  projectId: string;
  feedId: string;
  name: string;
  institute: string;
  project: string;
  eventType: string;
  description: string;
  verificationStatus: VerificationStatus;
  deadline: string | null;
  deadlineOriginal: string;
  deadlineEpochMs: number | null;
  website: string;
  tags: string[];
  province?: string;
  verifiedAt: string;
  discoverySources: PublicSourceLink[];
  logistics: FieldFactGroup;
  recommendation: FieldFactGroup;
  materials: FieldFactGroup;
}

export interface SnapshotCandidate {
  schemaVersion: 1;
  scanAt: string;
  defaultFeedId: string;
  feeds: FeedDescriptor[];
  counts: {
    confirmedOpen: number;
    confirmedUnknownDeadline: number;
    pendingExcluded: number;
    expired: number;
  };
  opportunities: PublicOpportunity[];
}

export interface PublicSnapshot extends SnapshotCandidate {
  snapshotId: string;
  approvedAt: string;
  previousSnapshotId: string | null;
  dataHash: string;
}
