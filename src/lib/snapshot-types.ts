export type VerificationStatus =
  | 'confirmed-open'
  | 'confirmed-unknown-deadline'
  | 'expired';

export type FactStatus = 'confirmed' | 'not-published' | 'unverified' | 'not-applicable';

export type EventMode = 'online' | 'offline' | 'hybrid' | 'unknown';

export type DiscoveryKind = 'official' | 'baoyan-notice' | 'cs-baoyan' | 'other-discovery';

export interface FieldFactGroup {
  status: FactStatus;
  summary: string;
}

export interface EventArrangement {
  mode: EventMode;
  time: FieldFactGroup;
  formatLocation: FieldFactGroup;
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

interface PublicOpportunityBase {
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

export interface LegacyPublicOpportunityV1 extends PublicOpportunityBase {}

export interface PublicOpportunity extends PublicOpportunityBase {
  eventArrangement: EventArrangement;
}

interface SnapshotPayload<TSchemaVersion extends 1 | 2, TOpportunity> {
  schemaVersion: TSchemaVersion;
  scanAt: string;
  defaultFeedId: string;
  feeds: FeedDescriptor[];
  counts: {
    confirmedOpen: number;
    confirmedUnknownDeadline: number;
    pendingExcluded: number;
    expired: number;
  };
  opportunities: TOpportunity[];
}

interface ApprovalMetadata {
  snapshotId: string;
  approvedAt: string;
  previousSnapshotId: string | null;
  dataHash: string;
}

export interface LegacySnapshotCandidateV1
  extends SnapshotPayload<1, LegacyPublicOpportunityV1> {}

export interface SnapshotCandidate extends SnapshotPayload<2, PublicOpportunity> {}

export interface LegacyPublicSnapshotV1
  extends LegacySnapshotCandidateV1, ApprovalMetadata {}

export interface PublicSnapshot extends SnapshotCandidate, ApprovalMetadata {}

export type ReadablePublicSnapshot = LegacyPublicSnapshotV1 | PublicSnapshot;
