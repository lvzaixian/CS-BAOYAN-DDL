import {
  canonicalDataHash as computeCanonicalDataHash,
  isValidIsoTimestamp,
} from '../../src/lib/snapshot-integrity.js';
import { isDeepStrictEqual } from 'node:util';
import type {
  PublicSnapshot,
  ReadablePublicSnapshot,
  SnapshotCandidate,
} from '../../src/lib/snapshot-types.js';
import {
  diffSnapshots,
  type SnapshotDiff,
} from './diff-snapshots.js';

type JsonObject = Record<string, unknown>;

export interface ReleaseGateArtifactDigests {
  bundleSha256: string;
  institutionRegistrySha256: string;
  sentinelRegistrySha256: string;
  identityRegistrySha256: string;
  submittedRegistrySha256: string;
  pendingBaseSha256: string;
  pendingNextSha256: string;
  lifecycleSha256: string;
  evidenceDispositionsSha256: string;
  artifactManifestSha256: string;
}

export interface ReleaseGateLossMetrics {
  unaccountedParentActive: number;
  undisposedEvidenceRecords: number;
  missingPreviousPendingEvents: number;
  unaccountedPendingScopes: number;
  pendingProjectionMismatch: number;
}

export interface ReleaseGateHardError {
  code: string;
  message: string;
  evidenceIds: string[];
}

export interface RemovalReview {
  projectId: string;
  decision: 'approve-removal';
  reviewedBy: string;
  reviewedAt: string;
  reason: string;
  evidenceIds: string[];
}

export interface TrustedRemovalAuthorization {
  schemaVersion: 1;
  runId: string;
  parent: {
    snapshotId: string;
    dataHash: string;
  };
  candidateCanonicalDataHash: string;
  removalReviewsSha256: string;
  removedProjectIds: string[];
  reviewedBy: string;
  reviewedAt: string;
  reason: string;
}

export interface ReleaseApprovalAuthorization {
  removalAuthorization: unknown;
  removalReviewsSha256: string;
}

export interface ReleaseGateManifest {
  schemaVersion: 2;
  runId: string;
  status: 'needs-review' | 'ready';
  parent: {
    snapshotId: string | null;
    dataHash: string | null;
  };
  candidate: {
    canonicalDataHash: string;
  };
  diff: SnapshotDiff;
  artifactDigests: ReleaseGateArtifactDigests;
  hardErrors: ReleaseGateHardError[];
  zeroLossMetrics: ReleaseGateLossMetrics;
  removalReviews: RemovalReview[];
}

export interface CreateReleaseGateOptions {
  runId: string;
  parent: ReadablePublicSnapshot | null;
  candidate: SnapshotCandidate;
  artifactDigests: ReleaseGateArtifactDigests;
  hardErrors: ReleaseGateHardError[];
  zeroLossMetrics: ReleaseGateLossMetrics;
  removalReviews: RemovalReview[];
}

const sha256Pattern = /^[a-f0-9]{64}$/i;
const projectIdPattern = /^\d{4}\|[^|]+\|[^|]+\|[^|]+$/u;

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(
  object: JsonObject,
  path: string,
  required: readonly string[],
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in object)) throw new Error(`${path}.${key} is required`);
  }
}

function stringAt(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function nullableStringAt(object: JsonObject, key: string, path: string): string | null {
  const value = object[key];
  if (value === null) return null;
  return stringAt(object, key, path);
}

function digestAt(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path);
  if (!sha256Pattern.test(value)) {
    throw new Error(`${path}.${key} must be a SHA-256 digest`);
  }
  return value.toLowerCase();
}

function nullableDigestAt(object: JsonObject, key: string, path: string): string | null {
  if (object[key] === null) return null;
  return digestAt(object, key, path);
}

function integerAt(object: JsonObject, key: string, path: string): number {
  const value = object[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${path}.${key} must be an integer >= 0`);
  }
  return value as number;
}

function enumAt<T extends string>(
  object: JsonObject,
  key: string,
  path: string,
  values: readonly T[],
): T {
  const value = object[key];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${path}.${key} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function stringArrayAt(object: JsonObject, key: string, path: string): string[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${path}.${key} must be an array`);
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${path}.${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`${path}.${key} must not contain duplicates`);
  }
  return result;
}

function projectIdArrayAt(object: JsonObject, key: string, path: string): string[] {
  const values = stringArrayAt(object, key, path);
  values.forEach((projectId, index) => {
    if (!projectIdPattern.test(projectId)) {
      throw new Error(
        `${path}.${key}[${index}] must use cycle|school|institute|round`,
      );
    }
  });
  const sorted = [...values].sort(codePointCompare);
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(`${path}.${key} must be sorted by Unicode code point`);
  }
  return values;
}

function parseDiff(value: unknown): SnapshotDiff {
  const path = 'release gate.diff';
  const object = objectAt(value, path);
  exactKeys(object, path, ['added', 'changed', 'expired', 'removed']);
  const diff = {
    added: projectIdArrayAt(object, 'added', path),
    changed: projectIdArrayAt(object, 'changed', path),
    expired: projectIdArrayAt(object, 'expired', path),
    removed: projectIdArrayAt(object, 'removed', path),
  };
  const seen = new Set<string>();
  for (const [kind, projectIds] of Object.entries(diff)) {
    for (const projectId of projectIds) {
      if (seen.has(projectId)) {
        throw new Error(`release gate.diff.${kind} overlaps another diff array at ${projectId}`);
      }
      seen.add(projectId);
    }
  }
  return diff;
}

function parseArtifactDigests(value: unknown): ReleaseGateArtifactDigests {
  const path = 'release gate.artifactDigests';
  const object = objectAt(value, path);
  exactKeys(object, path, [
    'bundleSha256',
    'institutionRegistrySha256',
    'sentinelRegistrySha256',
    'identityRegistrySha256',
    'submittedRegistrySha256',
    'pendingBaseSha256',
    'pendingNextSha256',
    'lifecycleSha256',
    'evidenceDispositionsSha256',
    'artifactManifestSha256',
  ]);
  return {
    bundleSha256: digestAt(object, 'bundleSha256', path),
    institutionRegistrySha256: digestAt(
      object,
      'institutionRegistrySha256',
      path,
    ),
    sentinelRegistrySha256: digestAt(
      object,
      'sentinelRegistrySha256',
      path,
    ),
    identityRegistrySha256: digestAt(
      object,
      'identityRegistrySha256',
      path,
    ),
    submittedRegistrySha256: digestAt(
      object,
      'submittedRegistrySha256',
      path,
    ),
    pendingBaseSha256: digestAt(object, 'pendingBaseSha256', path),
    pendingNextSha256: digestAt(object, 'pendingNextSha256', path),
    lifecycleSha256: digestAt(object, 'lifecycleSha256', path),
    evidenceDispositionsSha256: digestAt(
      object,
      'evidenceDispositionsSha256',
      path,
    ),
    artifactManifestSha256: digestAt(
      object,
      'artifactManifestSha256',
      path,
    ),
  };
}

function parseLossMetrics(value: unknown): ReleaseGateLossMetrics {
  const path = 'release gate.zeroLossMetrics';
  const object = objectAt(value, path);
  exactKeys(object, path, [
    'unaccountedParentActive',
    'undisposedEvidenceRecords',
    'missingPreviousPendingEvents',
    'unaccountedPendingScopes',
    'pendingProjectionMismatch',
  ]);
  return {
    unaccountedParentActive: integerAt(object, 'unaccountedParentActive', path),
    undisposedEvidenceRecords: integerAt(object, 'undisposedEvidenceRecords', path),
    missingPreviousPendingEvents: integerAt(object, 'missingPreviousPendingEvents', path),
    unaccountedPendingScopes: integerAt(object, 'unaccountedPendingScopes', path),
    pendingProjectionMismatch: integerAt(object, 'pendingProjectionMismatch', path),
  };
}

function parseHardError(value: unknown, index: number): ReleaseGateHardError {
  const path = `release gate.hardErrors[${index}]`;
  const object = objectAt(value, path);
  exactKeys(object, path, ['code', 'message', 'evidenceIds']);
  return {
    code: stringAt(object, 'code', path),
    message: stringAt(object, 'message', path),
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
  };
}

function parseRemovalReview(value: unknown, index: number): RemovalReview {
  const path = `release gate.removalReviews[${index}]`;
  const object = objectAt(value, path);
  exactKeys(object, path, [
    'projectId',
    'decision',
    'reviewedBy',
    'reviewedAt',
    'reason',
    'evidenceIds',
  ]);
  const projectId = stringAt(object, 'projectId', path);
  if (!projectIdPattern.test(projectId)) {
    throw new Error(`${path}.projectId must use cycle|school|institute|round`);
  }
  const reviewedAt = stringAt(object, 'reviewedAt', path);
  if (!isValidIsoTimestamp(reviewedAt)) {
    throw new Error(`${path}.reviewedAt must be a valid ISO timestamp`);
  }
  return {
    projectId,
    decision: enumAt(object, 'decision', path, ['approve-removal'] as const),
    reviewedBy: stringAt(object, 'reviewedBy', path),
    reviewedAt,
    reason: stringAt(object, 'reason', path),
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
  };
}

export function parseRemovalReviews(input: unknown): RemovalReview[] {
  return parseArray(input, 'removal reviews', (value, index) => {
    const review = parseRemovalReview(value, index);
    return review;
  });
}

export function parseTrustedRemovalAuthorization(
  input: unknown,
): TrustedRemovalAuthorization {
  const path = 'trusted removal authorization';
  const object = objectAt(input, path);
  exactKeys(object, path, [
    'schemaVersion',
    'runId',
    'parent',
    'candidateCanonicalDataHash',
    'removalReviewsSha256',
    'removedProjectIds',
    'reviewedBy',
    'reviewedAt',
    'reason',
  ]);
  if (object.schemaVersion !== 1) {
    throw new Error(`${path}.schemaVersion must be exactly 1`);
  }
  const parentPath = `${path}.parent`;
  const parentObject = objectAt(object.parent, parentPath);
  exactKeys(parentObject, parentPath, ['snapshotId', 'dataHash']);
  const reviewedAt = stringAt(object, 'reviewedAt', path);
  if (!isValidIsoTimestamp(reviewedAt)) {
    throw new Error(`${path}.reviewedAt must be a valid ISO timestamp`);
  }
  return {
    schemaVersion: 1,
    runId: stringAt(object, 'runId', path),
    parent: {
      snapshotId: stringAt(parentObject, 'snapshotId', parentPath),
      dataHash: digestAt(parentObject, 'dataHash', parentPath),
    },
    candidateCanonicalDataHash: digestAt(
      object,
      'candidateCanonicalDataHash',
      path,
    ),
    removalReviewsSha256: digestAt(object, 'removalReviewsSha256', path),
    removedProjectIds: projectIdArrayAt(object, 'removedProjectIds', path),
    reviewedBy: stringAt(object, 'reviewedBy', path),
    reviewedAt,
    reason: stringAt(object, 'reason', path),
  };
}

function parseArray<T>(
  value: unknown,
  path: string,
  parser: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map(parser);
}

function deriveStatus(
  diff: SnapshotDiff,
  hardErrors: ReleaseGateHardError[],
  metrics: ReleaseGateLossMetrics,
): ReleaseGateManifest['status'] {
  const hasLoss = Object.values(metrics).some((value) => value !== 0);
  const hasRemoval = diff.removed.length !== 0;
  return hardErrors.length === 0 && !hasLoss && !hasRemoval
    ? 'ready'
    : 'needs-review';
}

export function parseReleaseGateManifest(input: unknown): ReleaseGateManifest {
  const path = 'release gate';
  const object = objectAt(input, path);
  exactKeys(object, path, [
    'schemaVersion',
    'runId',
    'status',
    'parent',
    'candidate',
    'diff',
    'artifactDigests',
    'hardErrors',
    'zeroLossMetrics',
    'removalReviews',
  ]);
  if (object.schemaVersion !== 2) {
    throw new Error('release gate.schemaVersion must be exactly 2');
  }
  const runId = stringAt(object, 'runId', path);
  const status = enumAt(object, 'status', path, ['needs-review', 'ready'] as const);

  const parentPath = 'release gate.parent';
  const parentObject = objectAt(object.parent, parentPath);
  exactKeys(parentObject, parentPath, ['snapshotId', 'dataHash']);
  const parent = {
    snapshotId: nullableStringAt(parentObject, 'snapshotId', parentPath),
    dataHash: nullableDigestAt(parentObject, 'dataHash', parentPath),
  };
  if ((parent.snapshotId === null) !== (parent.dataHash === null)) {
    throw new Error('release gate.parent snapshotId and dataHash must both be null or both be set');
  }

  const candidatePath = 'release gate.candidate';
  const candidateObject = objectAt(object.candidate, candidatePath);
  exactKeys(candidateObject, candidatePath, ['canonicalDataHash']);
  const candidate = {
    canonicalDataHash: digestAt(candidateObject, 'canonicalDataHash', candidatePath),
  };

  const diff = parseDiff(object.diff);
  const artifactDigests = parseArtifactDigests(object.artifactDigests);
  const hardErrors = parseArray(
    object.hardErrors,
    'release gate.hardErrors',
    parseHardError,
  );
  const zeroLossMetrics = parseLossMetrics(object.zeroLossMetrics);
  const removalReviews = parseArray(
    object.removalReviews,
    'release gate.removalReviews',
    parseRemovalReview,
  );

  const removed = new Set(diff.removed);
  const reviewed = new Set<string>();
  for (const review of removalReviews) {
    if (!removed.has(review.projectId)) {
      throw new Error(
        `release gate.removalReviews contains review for non-removal ${review.projectId}`,
      );
    }
    if (reviewed.has(review.projectId)) {
      throw new Error(
        `release gate.removalReviews contains duplicate review for ${review.projectId}`,
      );
    }
    reviewed.add(review.projectId);
  }

  const expectedStatus = deriveStatus(
    diff,
    hardErrors,
    zeroLossMetrics,
  );
  if (status !== expectedStatus) {
    throw new Error(`release gate.status must be ${expectedStatus} for its bound contents`);
  }

  return {
    schemaVersion: 2,
    runId,
    status,
    parent,
    candidate,
    diff,
    artifactDigests,
    hardErrors,
    zeroLossMetrics,
    removalReviews,
  };
}

export function createReleaseGate(
  options: CreateReleaseGateOptions,
): ReleaseGateManifest {
  const diff = diffSnapshots(
    options.parent as PublicSnapshot | null,
    options.candidate,
  );
  const removalReviews = [...options.removalReviews].sort((left, right) =>
    codePointCompare(left.projectId, right.projectId));
  const status = deriveStatus(
    diff,
    options.hardErrors,
    options.zeroLossMetrics,
  );
  return parseReleaseGateManifest({
    schemaVersion: 2,
    runId: options.runId,
    status,
    parent: {
      snapshotId: options.parent?.snapshotId ?? null,
      dataHash: options.parent?.dataHash ?? null,
    },
    candidate: {
      canonicalDataHash: computeCanonicalDataHash(options.candidate),
    },
    diff,
    artifactDigests: options.artifactDigests,
    hardErrors: options.hardErrors,
    zeroLossMetrics: options.zeroLossMetrics,
    removalReviews,
  });
}

function sameDiff(left: SnapshotDiff, right: SnapshotDiff): boolean {
  return (
    left.added.length === right.added.length
    && left.added.every((value, index) => value === right.added[index])
    && left.changed.length === right.changed.length
    && left.changed.every((value, index) => value === right.changed[index])
    && left.expired.length === right.expired.length
    && left.expired.every((value, index) => value === right.expired[index])
    && left.removed.length === right.removed.length
    && left.removed.every((value, index) => value === right.removed[index])
  );
}

export function validateReleaseGateForApproval(
  input: unknown,
  parent: ReadablePublicSnapshot | null,
  candidate: SnapshotCandidate,
  replayedInput: unknown,
  authorization?: ReleaseApprovalAuthorization,
): SnapshotDiff {
  if (replayedInput === undefined) {
    throw new Error('an independent replay is required for release approval');
  }
  const gate = parseReleaseGateManifest(input);
  const replayed = parseReleaseGateManifest(replayedInput);
  if (!isDeepStrictEqual(gate, replayed)) {
    throw new Error('release gate differs from the independently replayed gate');
  }
  const actualParentSnapshotId = parent?.snapshotId ?? null;
  const actualParentDataHash = parent?.dataHash ?? null;
  if (gate.parent.snapshotId !== actualParentSnapshotId) {
    throw new Error('release gate parent snapshotId drifted from the current snapshot');
  }
  if (gate.parent.dataHash !== actualParentDataHash) {
    throw new Error('release gate parent dataHash drifted from the current snapshot');
  }

  const candidateHash = computeCanonicalDataHash(candidate);
  if (gate.candidate.canonicalDataHash !== candidateHash) {
    throw new Error('release gate candidate canonical hash drifted');
  }

  const recomputedDiff = diffSnapshots(parent as PublicSnapshot | null, candidate);
  if (!sameDiff(gate.diff, recomputedDiff)) {
    throw new Error('release gate diff does not match the recomputed diff');
  }
  if (gate.hardErrors.length > 0) {
    throw new Error('release gate contains hard errors');
  }
  if (Object.values(gate.zeroLossMetrics).some((value) => value !== 0)) {
    throw new Error('release gate contains nonzero loss metrics');
  }
  const reviewed = new Set(gate.removalReviews.map(({ projectId }) => projectId));
  const unreviewed = recomputedDiff.removed.filter((projectId) => !reviewed.has(projectId));
  if (unreviewed.length > 0) {
    throw new Error(`release gate has unreviewed removals: ${unreviewed.join(', ')}`);
  }
  if (recomputedDiff.removed.length === 0) {
    if (authorization !== undefined) {
      throw new Error('trusted external removal authorization is forbidden without removals');
    }
    if (gate.status !== 'ready') {
      throw new Error('release gate is not ready');
    }
    return recomputedDiff;
  }
  if (authorization === undefined) {
    throw new Error('trusted external removal authorization is required');
  }
  if (!sha256Pattern.test(authorization.removalReviewsSha256)) {
    throw new Error('trusted removal authorization review digest must be a SHA-256 digest');
  }
  const trusted = parseTrustedRemovalAuthorization(
    authorization.removalAuthorization,
  );
  if (trusted.runId !== gate.runId) {
    throw new Error('trusted removal authorization runId drifted');
  }
  if (
    trusted.parent.snapshotId !== gate.parent.snapshotId
    || trusted.parent.dataHash !== gate.parent.dataHash
  ) {
    throw new Error('trusted removal authorization parent drifted');
  }
  if (
    trusted.candidateCanonicalDataHash
    !== gate.candidate.canonicalDataHash
  ) {
    throw new Error('trusted removal authorization candidate canonical hash drifted');
  }
  if (
    trusted.removalReviewsSha256
    !== authorization.removalReviewsSha256.toLowerCase()
  ) {
    throw new Error('trusted removal authorization review digest drifted');
  }
  if (
    !isDeepStrictEqual(trusted.removedProjectIds, recomputedDiff.removed)
  ) {
    throw new Error('trusted removal authorization project set drifted');
  }
  if (Date.parse(trusted.reviewedAt) < Date.parse(candidate.scanAt)) {
    throw new Error('trusted removal authorization predates the candidate scan');
  }
  if (gate.status !== 'needs-review') {
    throw new Error('release gate with removals must remain needs-review');
  }
  return recomputedDiff;
}
