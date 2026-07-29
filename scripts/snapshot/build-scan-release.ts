import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import type {
  FactStatus,
  FieldFactGroup,
  PublicOpportunity,
  PublicSnapshot,
  SnapshotCandidate,
  VerificationStatus,
} from '../../src/lib/snapshot-types.js';
import {
  readRegularJsonFile,
  validateStoredApprovedSnapshot,
} from '../../src/lib/snapshot-integrity.js';
import { validateCandidate } from '../../src/lib/snapshot-validation.js';
import type {
  ProjectIdentityRegistry,
  OfficialSurfaceKind,
  ScanBundle,
  ScopeItem,
} from './scan-release-contract.js';
import {
  parseIdentityRegistry,
  parseScanBundle,
} from './scan-release-contract.js';
import type {
  NormalizedObservation,
  ScanReduction,
} from './scan-release-reducer.js';
import {
  normalizePriorPendingIdentities,
  normalizePendingUpdates,
  reduceScanRelease,
} from './scan-release-reducer.js';
import {
  buildNextPendingLedger,
  parsePendingLedger,
  type PendingLedger,
  type PendingLedgerEntry,
  type PendingLedgerIdentityMigration,
} from './pending-ledger.js';
import {
  createReleaseGate,
  parseRemovalReviews,
  validateReleaseGateForApproval,
  type ReleaseGateManifest,
  type RemovalReview,
} from './release-gate.js';
import type { SnapshotDiff } from './diff-snapshots.js';
import {
  assertReadableEvidenceArtifactsCovered,
  parseEvidenceArtifactManifest,
  verifyEvidenceArtifactManifest,
  type EvidenceArtifactManifest,
} from './evidence-artifact-manifest.js';

const beijingOffsetMs = 8 * 60 * 60 * 1000;
const notPublishedPattern = /未公布|待公布|暂未公布|暂无|待定|后续通知/u;
const unverifiedPattern = /unknown|未知|待核实|未核实|未确认|不确定/u;
const officialKinds = new Set<OfficialSurfaceKind>([
  'graduate-admissions',
  'college-notice',
  'application-system',
  'official-account',
  'attachment',
  'other-official',
]);

export interface PrioritySentinel {
  school: string;
  minimumEvidenceRecords: number;
  requiredOfficialKinds: OfficialSurfaceKind[];
}

export interface PrioritySentinelConfig {
  schemaVersion: 1;
  cycle: string;
  institutions: PrioritySentinel[];
}

export interface SubmittedProjectRegistry {
  schemaVersion: 1;
  source: string;
  submittedProjectIds: string[];
}

export interface BuildScanReleaseOptions {
  bundle: ScanBundle;
  parent: PublicSnapshot | null;
  registryInstitutions: ReadonlyArray<{ name: string }>;
  sentinels: PrioritySentinelConfig;
  identityRegistry: ProjectIdentityRegistry;
  submittedRegistry: SubmittedProjectRegistry;
  pendingLedger: PendingLedger;
  artifactManifest: EvidenceArtifactManifest;
  removalReviews: RemovalReview[];
}

export interface ScanReleaseAudit {
  schemaVersion: 1;
  runId: string;
  scanMode: ScanBundle['scanMode'];
  runStatus: ReleaseGateManifest['status'];
  candidateBase: ScanBundle['candidateBase'];
  counts: SnapshotCandidate['counts'];
  reductionMetrics: ScanReduction['metrics'];
  gateStatus: ReleaseGateManifest['status'];
  artifactDigests: ReleaseGateManifest['artifactDigests'];
}

export interface ScanReleaseArtifacts {
  reduction: ScanReduction;
  candidate: SnapshotCandidate;
  diff: SnapshotDiff;
  pendingNext: PendingLedger;
  gate: ReleaseGateManifest;
  audit: ScanReleaseAudit;
}

export interface ScanReleaseReplay {
  buildOptions: BuildScanReleaseOptions;
  candidate: SnapshotCandidate;
  diff: SnapshotDiff;
  pendingNext: PendingLedger;
  lifecycle: ScanReduction['lifecycle'];
  evidenceDispositions: ScanReduction['evidenceDispositions'];
  gate: ReleaseGateManifest;
  audit: ScanReleaseAudit;
  livePending: PendingLedger;
  removalAuthorization?: unknown;
  removalReviewsSha256?: string;
}

interface CliOptions {
  bundle: string;
  parent: string;
  registry: string;
  sentinels: string;
  identityRegistry: string;
  submitted: string;
  pendingCurrent: string;
  artifactManifest: string;
  artifactRoot: string;
  candidate: string;
  diff: string;
  lifecycle: string;
  evidenceDispositions: string;
  gate: string;
  pendingNext: string;
  audit: string;
  removalReviews?: string;
}

type JsonObject = Record<string, unknown>;

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

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

export function parsePrioritySentinels(
  input: unknown,
): PrioritySentinelConfig {
  const object = objectAt(input, 'priority sentinels');
  exactKeys(object, 'priority sentinels', [
    'schemaVersion',
    'cycle',
    'institutions',
  ]);
  if (object.schemaVersion !== 1) {
    throw new Error('priority sentinels.schemaVersion must be exactly 1');
  }
  const cycle = nonEmptyString(object.cycle, 'priority sentinels.cycle');
  if (!/^\d{4}$/u.test(cycle)) {
    throw new Error('priority sentinels.cycle must be four digits');
  }
  if (!Array.isArray(object.institutions) || object.institutions.length === 0) {
    throw new Error('priority sentinels.institutions must be a non-empty array');
  }
  const institutions = object.institutions.map((value, index) => {
    const path = `priority sentinels.institutions[${index}]`;
    const item = objectAt(value, path);
    exactKeys(item, path, [
      'school',
      'minimumEvidenceRecords',
      'requiredOfficialKinds',
    ]);
    if (
      !Number.isInteger(item.minimumEvidenceRecords) ||
      (item.minimumEvidenceRecords as number) < 1
    ) {
      throw new Error(`${path}.minimumEvidenceRecords must be an integer >= 1`);
    }
    if (
      !Array.isArray(item.requiredOfficialKinds) ||
      item.requiredOfficialKinds.length === 0
    ) {
      throw new Error(`${path}.requiredOfficialKinds must be a non-empty array`);
    }
    const requiredOfficialKinds = item.requiredOfficialKinds.map(
      (kind, kindIndex) => {
        if (typeof kind !== 'string' || !officialKinds.has(kind as OfficialSurfaceKind)) {
          throw new Error(
            `${path}.requiredOfficialKinds[${kindIndex}] is not an official surface kind`,
          );
        }
        return kind as OfficialSurfaceKind;
      },
    );
    if (new Set(requiredOfficialKinds).size !== requiredOfficialKinds.length) {
      throw new Error(`${path}.requiredOfficialKinds must not contain duplicates`);
    }
    return {
      school: nonEmptyString(item.school, `${path}.school`),
      minimumEvidenceRecords: item.minimumEvidenceRecords as number,
      requiredOfficialKinds,
    };
  });
  if (new Set(institutions.map((item) => item.school)).size !== institutions.length) {
    throw new Error('priority sentinels.institutions must not contain duplicate schools');
  }
  return { schemaVersion: 1, cycle, institutions };
}

export function parseSubmittedProjectRegistry(
  input: unknown,
): SubmittedProjectRegistry {
  const object = objectAt(input, 'submitted registry');
  exactKeys(object, 'submitted registry', [
    'schemaVersion',
    'source',
    'submittedProjectIds',
  ]);
  if (object.schemaVersion !== 1) {
    throw new Error('submitted registry.schemaVersion must be exactly 1');
  }
  if (!Array.isArray(object.submittedProjectIds)) {
    throw new Error('submitted registry.submittedProjectIds must be an array');
  }
  const submittedProjectIds = object.submittedProjectIds.map((value, index) => {
    const projectId = nonEmptyString(
      value,
      `submitted registry.submittedProjectIds[${index}]`,
    );
    if (!/^\d{4}\|[^|]+\|[^|]+\|[^|]+$/u.test(projectId)) {
      throw new Error(
        `submitted registry.submittedProjectIds[${index}] must use cycle|school|institute|round`,
      );
    }
    return projectId;
  });
  if (new Set(submittedProjectIds).size !== submittedProjectIds.length) {
    throw new Error(
      'submitted registry.submittedProjectIds must not contain duplicates',
    );
  }
  return {
    schemaVersion: 1,
    source: nonEmptyString(object.source, 'submitted registry.source'),
    submittedProjectIds,
  };
}

function registrySchoolName(value: string): string {
  const match = value.match(/^[^A-Za-z/]+/u);
  return (match?.[0] ?? value.split('/')[0]).trim();
}

export function assertBundleCoverage(
  bundle: ScanBundle,
  registryInstitutions: ReadonlyArray<{ name: string }>,
  sentinels: PrioritySentinelConfig,
): void {
  const assertCurrentRunScopes = (
    scopes: ScopeItem[],
    label: string,
  ): void => {
    if (
      scopes.some(
        (scope) =>
          scope.status === 'not-applicable' || scope.evidenceIds.length === 0,
      )
    ) {
      throw new Error(`${label} must have current-run official evidence`);
    }
  };
  for (const sentinel of sentinels.institutions) {
    const scopes = bundle.scopeItems.filter(
      (item) => item.kind === 'sentinel' && item.school === sentinel.school,
    );
    if (scopes.length === 0) {
      throw new Error(`scan is missing priority sentinel ${sentinel.school}`);
    }
    assertCurrentRunScopes(
      scopes,
      `priority sentinel ${sentinel.school}`,
    );
    const scopeIds = new Set(scopes.map((item) => item.scopeItemId));
    const records = bundle.evidenceRecords.filter(
      (record) =>
        record.school === sentinel.school &&
        scopeIds.has(record.scopeItemId),
    );
    if (records.length < sentinel.minimumEvidenceRecords) {
      throw new Error(
        `priority sentinel ${sentinel.school} has ${records.length} evidence records; expected at least ${sentinel.minimumEvidenceRecords}`,
      );
    }
    const kinds = new Set(records.map((record) => record.kind));
    for (const kind of sentinel.requiredOfficialKinds) {
      if (!kinds.has(kind)) {
        throw new Error(
          `priority sentinel ${sentinel.school} is missing official kind ${kind}`,
        );
      }
    }
  }
  if (bundle.scanMode !== 'full') return;
  for (const institution of registryInstitutions) {
    const school = registrySchoolName(
      nonEmptyString(institution.name, 'registry institution.name'),
    );
    const registryScopes = bundle.scopeItems.filter(
      (item) => item.kind === 'registry' && item.school === school,
    );
    if (registryScopes.length === 0) {
      throw new Error(`full scan is missing registry institution ${school}`);
    }
    assertCurrentRunScopes(
      registryScopes,
      `full registry scope ${school}`,
    );
  }
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const object = value as JsonObject;
  const sorted: JsonObject = {};
  for (const key of Object.keys(object).sort(codePointCompare)) {
    sorted[key] = canonicalize(object[key]);
  }
  return sorted;
}

function canonicalObjectSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function rawSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function factStatus(value: string): FactStatus {
  if (unverifiedPattern.test(value)) return 'unverified';
  if (notPublishedPattern.test(value)) return 'not-published';
  return 'confirmed';
}

function factGroup(
  values: ReadonlyArray<{ label: string; value: string }>,
): FieldFactGroup {
  const statuses = values.map(({ value }) => factStatus(value));
  if (statuses.includes('unverified')) {
    return { status: 'unverified', summary: '待官方公布' };
  }
  if (statuses.every((status) => status === 'not-published')) {
    return { status: 'not-published', summary: '未公布' };
  }
  return {
    status: 'confirmed',
    summary: values
      .filter((_, index) => statuses[index] === 'confirmed')
      .map(({ label, value }) =>
        values.length === 1 ? value : `${label}：${value}`,
      )
      .join('；'),
  };
}

function opportunityOrder(
  left: PublicOpportunity,
  right: PublicOpportunity,
): number {
  const rank = (status: VerificationStatus): number => {
    if (status === 'confirmed-open') return 0;
    if (status === 'confirmed-unknown-deadline') return 1;
    return 2;
  };
  const statusDifference =
    rank(left.verificationStatus) - rank(right.verificationStatus);
  if (statusDifference !== 0) return statusDifference;
  if (
    left.verificationStatus === 'confirmed-open' &&
    right.verificationStatus === 'confirmed-open'
  ) {
    const deadlineDifference =
      (left.deadlineEpochMs ?? 0) - (right.deadlineEpochMs ?? 0);
    if (deadlineDifference !== 0) return deadlineDifference;
  }
  return codePointCompare(left.projectId, right.projectId);
}

function observationToOpportunity(
  item: NormalizedObservation,
): PublicOpportunity {
  if (item.state === 'pending') {
    throw new Error(
      `pending observation ${item.observation.observationId} cannot enter the public candidate`,
    );
  }
  const observation = item.observation;
  const segments = item.canonicalProjectId.split('|');
  if (segments.length !== 4) {
    throw new Error(
      `canonical project ID ${item.canonicalProjectId} is malformed`,
    );
  }
  return {
    projectId: item.canonicalProjectId,
    feedId: `camp${observation.cycle}`,
    name: observation.school,
    institute: segments[2],
    project: observation.project,
    eventType: observation.eventType,
    description: observation.project,
    verificationStatus: item.state,
    deadline: observation.deadline,
    deadlineOriginal: observation.deadlineOriginal,
    deadlineEpochMs:
      observation.deadline === null ? null : Date.parse(observation.deadline),
    website: observation.officialUrl,
    tags: [],
    verifiedAt: item.verifiedAt,
    discoverySources: [
      {
        kind: 'official',
        label: '官方链接',
        url: observation.officialUrl,
      },
      ...(observation.baoyanNoticeUrl === undefined
        ? []
        : [
            {
              kind: 'baoyan-notice' as const,
              label: '保研通知网',
              url: observation.baoyanNoticeUrl,
            },
          ]),
    ],
    eventArrangement: {
      mode: item.state === 'expired' ? 'unknown' : observation.eventMode,
      time: factGroup([
        { label: '活动时间', value: observation.eventTime },
      ]),
      formatLocation: factGroup([
        { label: '形式地点', value: observation.formatLocation },
      ]),
    },
    logistics: factGroup([
      { label: '住宿', value: observation.accommodation },
      { label: '餐食', value: observation.meals },
      { label: '交通', value: observation.transport },
      { label: '报销', value: observation.reimbursement },
    ]),
    recommendation: factGroup([
      { label: '推荐信数量', value: observation.recommendationLetters },
      { label: '推荐信模板', value: observation.recommendationTemplate },
    ]),
    materials: factGroup([
      { label: '材料复杂度', value: observation.materialComplexity },
      { label: '材料清单', value: observation.materialList },
    ]),
  };
}

function expireParentOpportunity(
  opportunity: PublicOpportunity,
  verifiedAt: string,
): PublicOpportunity {
  if (opportunity.verificationStatus === 'expired') return opportunity;
  const invalidatedFutureDeadline = (
    opportunity.deadlineEpochMs !== null
    && opportunity.deadlineEpochMs > Date.parse(verifiedAt)
  );
  return {
    ...opportunity,
    verificationStatus: 'expired',
    ...(invalidatedFutureDeadline
      ? {
          deadline: null,
          deadlineEpochMs: null,
          deadlineOriginal: '本轮官方复核确认活动已结束，原报名截止不再有效',
        }
      : {}),
    verifiedAt,
    eventArrangement: {
      ...opportunity.eventArrangement,
      mode: 'unknown',
    },
  };
}

function parentOpportunity(
  previous: PublicSnapshot | null,
  projectId: string,
): PublicOpportunity | undefined {
  return previous?.opportunities.find(
    (opportunity) => opportunity.projectId === projectId,
  );
}

function pendingIdentityIds(reduction: ScanReduction): Set<string> {
  const identities = new Set(reduction.pending.map((item) => item.ledgerId));
  for (const lifecycle of reduction.lifecycle) {
    if (lifecycle.state === 'pending') {
      identities.add(`project:${lifecycle.canonicalProjectId}`);
    }
  }
  return identities;
}

function pendingIdentityCount(reduction: ScanReduction): number {
  return pendingIdentityIds(reduction).size;
}

export function countPendingProjectionMismatch(
  reduction: ScanReduction,
  pendingEntries: PendingLedgerEntry[],
): number {
  const projected = pendingIdentityIds(reduction);
  const persisted = new Set(pendingEntries.map((entry) => entry.ledgerId));
  let mismatch = 0;
  for (const ledgerId of projected) {
    if (!persisted.has(ledgerId)) mismatch += 1;
  }
  for (const ledgerId of persisted) {
    if (!projected.has(ledgerId)) mismatch += 1;
  }
  return mismatch;
}

export function buildCandidateFromReduction(
  bundle: ScanBundle,
  previous: PublicSnapshot | null,
  reduction: ScanReduction,
): SnapshotCandidate {
  if (reduction.hardErrors.length > 0) {
    throw new Error('cannot project a scan reduction with hard errors');
  }
  if (
    reduction.metrics.evidenceRecords !== reduction.metrics.disposedEvidence
  ) {
    throw new Error('cannot project a scan reduction with undisposed evidence');
  }
  if (reduction.metrics.unaccountedParentActive !== 0) {
    throw new Error(
      'cannot project a scan reduction with unaccounted parent active projects',
    );
  }

  const normalizedByCanonical = new Map(
    reduction.normalizedObservations.map((item) => [
      item.canonicalProjectId,
      item,
    ]),
  );
  const opportunities: PublicOpportunity[] = [];
  const projectedIds = new Set<string>();
  for (const lifecycle of reduction.lifecycle) {
    const normalized = normalizedByCanonical.get(lifecycle.canonicalProjectId);
    if (
      normalized !== undefined &&
      lifecycle.state !== 'pending' &&
      lifecycle.state !== 'submitted-excluded' &&
      lifecycle.state !== 'out-of-scope' &&
      lifecycle.state !== 'identity-merged' &&
      lifecycle.state !== 'official-closed' &&
      lifecycle.state !== 'data-correction'
    ) {
      const opportunity = observationToOpportunity(normalized);
      if (projectedIds.has(opportunity.projectId)) {
        throw new Error(`duplicate projected project ${opportunity.projectId}`);
      }
      projectedIds.add(opportunity.projectId);
      opportunities.push(opportunity);
      continue;
    }
    const parent = parentOpportunity(previous, lifecycle.sourceProjectId);
    if (lifecycle.state === 'carried-active') {
      if (parent === undefined) {
        throw new Error(
          `carried project ${lifecycle.sourceProjectId} is absent from the parent`,
        );
      }
      projectedIds.add(parent.projectId);
      opportunities.push(parent);
    } else if (
      (lifecycle.state === 'expired' || lifecycle.state === 'official-closed')
      && parent !== undefined
    ) {
      const expired = expireParentOpportunity(parent, lifecycle.verifiedAt);
      projectedIds.add(expired.projectId);
      opportunities.push(expired);
    }
  }
  opportunities.sort(opportunityOrder);

  const active = opportunities.filter(
    (item) => item.verificationStatus !== 'expired',
  );
  if (active.length === 0) {
    throw new Error('candidate projection must contain at least one active project');
  }
  const cycles = [
    ...new Set(opportunities.map((item) => item.projectId.slice(0, 4))),
  ].sort((left, right) => Number(left) - Number(right));
  const newestActiveCycle = active
    .map((item) => item.projectId.slice(0, 4))
    .sort((left, right) => Number(right) - Number(left))[0];
  const eventYear = new Date(
    Date.parse(bundle.scanFinishedAt) + beijingOffsetMs,
  ).getUTCFullYear();
  const candidate: SnapshotCandidate = {
    schemaVersion: 2,
    scanAt: bundle.scanFinishedAt,
    defaultFeedId: `camp${newestActiveCycle}`,
    feeds: cycles.map((cycle) => ({
      id: `camp${cycle}`,
      label: `推免活动 ${cycle}`,
      admissionCycle: cycle,
      eventYear,
    })),
    counts: {
      confirmedOpen: opportunities.filter(
        (item) => item.verificationStatus === 'confirmed-open',
      ).length,
      confirmedUnknownDeadline: opportunities.filter(
        (item) =>
          item.verificationStatus === 'confirmed-unknown-deadline',
      ).length,
      pendingExcluded: pendingIdentityCount(reduction),
      expired: opportunities.filter(
        (item) => item.verificationStatus === 'expired',
      ).length,
    },
    opportunities,
  };
  const validationErrors = validateCandidate(
    candidate,
    Date.parse(candidate.scanAt),
  );
  if (validationErrors.length > 0) {
    throw new Error(
      `Candidate validation failed:\n${validationErrors.join('\n')}`,
    );
  }
  return candidate;
}

export function buildScanReleaseArtifacts(
  options: BuildScanReleaseOptions,
): ScanReleaseArtifacts {
  const {
    bundle,
    parent,
    registryInstitutions,
    sentinels,
    identityRegistry,
    submittedRegistry,
    pendingLedger,
    removalReviews,
  } = options;
  if (
    bundle.candidateBase.snapshotId !== parent?.snapshotId ||
    bundle.candidateBase.dataHash !== parent?.dataHash
  ) {
    throw new Error('scan bundle candidate base does not match the supplied parent snapshot');
  }
  if (
    bundle.pendingLedger.generation !== pendingLedger.current.generation ||
    bundle.pendingLedger.sha256 !== pendingLedger.current.sha256
  ) {
    throw new Error('scan bundle pending ledger base does not match the supplied ledger');
  }
  if (sentinels.cycle !== '2027') {
    throw new Error('priority sentinel cycle must match the active 2027 admissions cycle');
  }
  const artifactManifest = parseEvidenceArtifactManifest(
    options.artifactManifest,
  );
  assertReadableEvidenceArtifactsCovered(bundle, artifactManifest);
  assertBundleCoverage(bundle, registryInstitutions, sentinels);
  const normalizedPendingUpdates = normalizePendingUpdates(
    bundle.pendingUpdates,
    identityRegistry,
  );
  const normalizedPriorPending = normalizePriorPendingIdentities(
    pendingLedger.current.entries.map((entry) => ({
      ledgerId: entry.ledgerId,
      ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
      scopeItemId: entry.scopeItemId,
    })),
    identityRegistry,
  );
  const identityMigrations: PendingLedgerIdentityMigration[] = pendingLedger.current.entries
    .map((entry, index) => ({
      fromLedgerId: entry.ledgerId,
      toLedgerId: normalizedPriorPending[index].ledgerId,
    }))
    .filter(({ fromLedgerId, toLedgerId }) => fromLedgerId !== toLedgerId);

  const reduction = reduceScanRelease(
    bundle,
    parent,
    identityRegistry,
    pendingLedger.current.entries,
    submittedRegistry.submittedProjectIds,
  );
  const pendingNext = buildNextPendingLedger(
    pendingLedger,
    normalizedPendingUpdates,
    {
      runId: bundle.runId,
      scanStartedAt: bundle.scanStartedAt,
      scanFinishedAt: bundle.scanFinishedAt,
    },
    identityMigrations,
  );
  const candidate = buildCandidateFromReduction(bundle, parent, reduction);
  const pendingProjectionMismatch = countPendingProjectionMismatch(
    reduction,
    pendingNext.current.entries,
  );
  const artifactDigests = {
    bundleSha256: canonicalObjectSha256(bundle),
    institutionRegistrySha256: canonicalObjectSha256(registryInstitutions),
    sentinelRegistrySha256: canonicalObjectSha256(sentinels),
    identityRegistrySha256: canonicalObjectSha256(identityRegistry),
    submittedRegistrySha256: canonicalObjectSha256(submittedRegistry),
    pendingBaseSha256: canonicalObjectSha256(pendingLedger),
    pendingNextSha256: canonicalObjectSha256(pendingNext),
    lifecycleSha256: canonicalObjectSha256(reduction.lifecycle),
    evidenceDispositionsSha256: canonicalObjectSha256(
      reduction.evidenceDispositions,
    ),
    artifactManifestSha256: canonicalObjectSha256(artifactManifest),
  };
  const gate = createReleaseGate({
    runId: bundle.runId,
    parent,
    candidate,
    artifactDigests,
    hardErrors: reduction.hardErrors,
    zeroLossMetrics: {
      unaccountedParentActive:
        reduction.metrics.unaccountedParentActive,
      undisposedEvidenceRecords: Math.max(
        0,
        reduction.metrics.evidenceRecords -
          reduction.metrics.disposedEvidence,
      ),
      missingPreviousPendingEvents: 0,
      unaccountedPendingScopes:
        reduction.metrics.unaccountedPendingScopes,
      pendingProjectionMismatch,
    },
    removalReviews,
  });
  const audit: ScanReleaseAudit = {
    schemaVersion: 1,
    runId: bundle.runId,
    scanMode: bundle.scanMode,
    runStatus: gate.status,
    candidateBase: bundle.candidateBase,
    counts: candidate.counts,
    reductionMetrics: reduction.metrics,
    gateStatus: gate.status,
    artifactDigests,
  };
  return {
    reduction,
    candidate,
    diff: gate.diff,
    pendingNext,
    gate,
    audit,
  };
}

export function verifyScanReleaseReplay(
  input: ScanReleaseReplay,
): ScanReleaseArtifacts {
  const replayed = buildScanReleaseArtifacts(input.buildOptions);
  const persistedArtifacts = [
    ['candidate', input.candidate, replayed.candidate],
    ['diff', input.diff, replayed.diff],
    ['pending-next', input.pendingNext, replayed.pendingNext],
    ['lifecycle', input.lifecycle, replayed.reduction.lifecycle],
    [
      'evidence dispositions',
      input.evidenceDispositions,
      replayed.reduction.evidenceDispositions,
    ],
    ['audit', input.audit, replayed.audit],
  ] as const;
  for (const [label, persisted, expected] of persistedArtifacts) {
    if (!isDeepStrictEqual(persisted, expected)) {
      throw new Error(`${label} differs from the independently replayed release`);
    }
  }
  validateReleaseGateForApproval(
    input.gate,
    input.buildOptions.parent,
    input.candidate,
    replayed.gate,
    input.removalAuthorization === undefined
      ? undefined
      : {
          removalAuthorization: input.removalAuthorization,
          removalReviewsSha256: input.removalReviewsSha256 ?? '',
        },
  );
  const livePending = parsePendingLedger(input.livePending);
  if (!isDeepStrictEqual(livePending, replayed.pendingNext)) {
    throw new Error(
      'live pending ledger does not equal the committed replayed pending-next ledger',
    );
  }
  return replayed;
}

function parseCliOptions(argv: string[]): CliOptions {
  const flagToKey = new Map<`--${string}`, keyof CliOptions>([
    ['--bundle', 'bundle'],
    ['--parent', 'parent'],
    ['--registry', 'registry'],
    ['--sentinels', 'sentinels'],
    ['--identity-registry', 'identityRegistry'],
    ['--submitted', 'submitted'],
    ['--pending-current', 'pendingCurrent'],
    ['--artifact-manifest', 'artifactManifest'],
    ['--artifact-root', 'artifactRoot'],
    ['--candidate', 'candidate'],
    ['--diff', 'diff'],
    ['--lifecycle', 'lifecycle'],
    ['--evidence-dispositions', 'evidenceDispositions'],
    ['--gate', 'gate'],
    ['--pending-next', 'pendingNext'],
    ['--audit', 'audit'],
    ['--removal-reviews', 'removalReviews'],
  ]);
  const parsed: Partial<CliOptions> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as `--${string}`;
    const key = flagToKey.get(flag);
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(`invalid build argument ${JSON.stringify(flag)}`);
    }
    if (parsed[key] !== undefined) {
      throw new Error(`duplicate build argument ${JSON.stringify(flag)}`);
    }
    parsed[key] = value;
  }
  const required: Array<Exclude<keyof CliOptions, 'removalReviews'>> = [
    'bundle',
    'parent',
    'registry',
    'sentinels',
    'identityRegistry',
    'submitted',
    'pendingCurrent',
    'artifactManifest',
    'artifactRoot',
    'candidate',
    'diff',
    'lifecycle',
    'evidenceDispositions',
    'gate',
    'pendingNext',
    'audit',
  ];
  for (const key of required) {
    if (parsed[key] === undefined) {
      throw new Error(`missing required build argument ${key}`);
    }
  }
  return parsed as CliOptions;
}

export function parseRegistryInstitutions(
  value: unknown,
): Array<{ name: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('institution registry must be a non-empty array');
  }
  return value.map((item, index) => {
    const object = objectAt(item, `institution registry[${index}]`);
    return {
      name: nonEmptyString(
        object.name,
        `institution registry[${index}].name`,
      ),
    };
  });
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error(`output must be absent or a regular file: ${path}`);
    }
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    directoryHandle = await open(parent, 'r');
    await rename(temporary, path);
    await directoryHandle.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function assertDistinctPaths(options: CliOptions): void {
  const inputPaths = [
    options.bundle,
    options.parent,
    options.registry,
    options.sentinels,
    options.identityRegistry,
    options.submitted,
    options.pendingCurrent,
    options.artifactManifest,
    ...(options.removalReviews === undefined
      ? []
      : [options.removalReviews]),
  ].map((value) => resolve(value));
  const outputPaths = [
    options.candidate,
    options.diff,
    options.lifecycle,
    options.evidenceDispositions,
    options.gate,
    options.pendingNext,
    options.audit,
  ].map((value) => resolve(value));
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new Error('build output paths must be distinct');
  }
  for (const output of outputPaths) {
    if (inputPaths.includes(output)) {
      throw new Error('build output path collides with an input path');
    }
  }
}

async function runCli(argv: string[]): Promise<void> {
  const options = parseCliOptions(argv);
  assertDistinctPaths(options);
  const [
    bundleFile,
    parentFile,
    registryFile,
    sentinelsFile,
    identityFile,
    submittedFile,
    pendingFile,
    artifactManifestFile,
    removalReviewFile,
  ] = await Promise.all([
    readRegularJsonFile(options.bundle, 'scan bundle'),
    readRegularJsonFile(options.parent, 'parent snapshot'),
    readRegularJsonFile(options.registry, 'institution registry'),
    readRegularJsonFile(options.sentinels, 'priority sentinels'),
    readRegularJsonFile(options.identityRegistry, 'identity registry'),
    readRegularJsonFile(options.submitted, 'submitted registry'),
    readRegularJsonFile(options.pendingCurrent, 'pending ledger'),
    readRegularJsonFile(options.artifactManifest, 'evidence artifact manifest'),
    options.removalReviews === undefined
      ? Promise.resolve(undefined)
      : readRegularJsonFile(options.removalReviews, 'removal reviews'),
  ]);
  const parentErrors = validateStoredApprovedSnapshot(parentFile.value);
  if (parentErrors.length > 0) {
    throw new Error(
      `Parent snapshot validation failed:\n${parentErrors.join('\n')}`,
    );
  }
  const parent = parentFile.value as PublicSnapshot;
  const bundle = parseScanBundle(bundleFile.value);
  if (Date.parse(bundle.scanFinishedAt) > Date.now()) {
    throw new Error('scan bundle.scanFinishedAt must not be in the future');
  }
  if (rawSha256(parentFile.text) !== bundle.candidateBase.sha256) {
    throw new Error('scan bundle candidateBase SHA-256 does not match the parent bytes');
  }
  const registryInstitutions = parseRegistryInstitutions(registryFile.value);
  if (rawSha256(registryFile.text) !== bundle.registry.sha256) {
    throw new Error('scan bundle registry SHA-256 does not match the registry bytes');
  }
  if (registryInstitutions.length !== bundle.registry.institutionCount) {
    throw new Error('scan bundle registry institutionCount does not match the registry');
  }
  const sentinels = parsePrioritySentinels(sentinelsFile.value);
  const identityRegistry = parseIdentityRegistry(identityFile.value);
  const submittedRegistry = parseSubmittedProjectRegistry(
    submittedFile.value,
  );
  const pendingLedger = parsePendingLedger(pendingFile.value);
  const artifactManifest = await verifyEvidenceArtifactManifest({
    artifactRoot: options.artifactRoot,
    manifest: artifactManifestFile.value,
  });
  const removalReviews =
    removalReviewFile === undefined
      ? []
      : parseRemovalReviews(removalReviewFile.value);
  const artifacts = buildScanReleaseArtifacts({
    bundle,
    parent,
    registryInstitutions,
    sentinels,
    identityRegistry,
    submittedRegistry,
    pendingLedger,
    artifactManifest,
    removalReviews,
  });

  await writeJsonAtomically(options.candidate, artifacts.candidate);
  await writeJsonAtomically(options.diff, artifacts.diff);
  await writeJsonAtomically(options.lifecycle, artifacts.reduction.lifecycle);
  await writeJsonAtomically(
    options.evidenceDispositions,
    artifacts.reduction.evidenceDispositions,
  );
  await writeJsonAtomically(options.pendingNext, artifacts.pendingNext);
  await writeJsonAtomically(options.audit, artifacts.audit);
  await writeJsonAtomically(options.gate, artifacts.gate);
  process.stdout.write(
    `${JSON.stringify({
      runId: bundle.runId,
      status: artifacts.gate.status,
      candidate: options.candidate,
      diff: options.diff,
      lifecycle: options.lifecycle,
      evidenceDispositions: options.evidenceDispositions,
      pendingNext: options.pendingNext,
      audit: options.audit,
      gate: options.gate,
    })}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
}
