import type {
  PublicOpportunity,
  PublicSnapshot,
  VerificationStatus,
} from '../../src/lib/snapshot-types.js';
import type {
  EvidenceRecord,
  PendingUpdate,
  ProjectExclusion,
  ProjectIdentityRegistry,
  ProjectObservation,
  ScanBundle,
  ScopeItem,
} from './scan-release-contract.js';

const PROJECT_ID_PATTERN = /^\d{4}\|[^|]+\|[^|]+\|[^|]+$/u;

export type LifecycleState =
  | VerificationStatus
  | 'carried-active'
  | 'pending'
  | 'submitted-excluded'
  | 'out-of-scope'
  | 'identity-merged'
  | 'official-closed'
  | 'data-correction';

export interface CanonicalIdentity {
  sourceProjectId: string;
  canonicalProjectId: string;
  method:
    | 'project-alias'
    | 'url-alias'
    | 'tombstone'
    | 'parent-project-id'
    | 'new-project-id';
}

export interface EvidenceDisposition {
  evidenceId: string;
  kind: 'project' | 'scope' | 'hard-error';
  reason: string;
  canonicalProjectId?: string;
  scopeItemId?: string;
}

export interface LifecycleRecord {
  sourceProjectId: string;
  canonicalProjectId: string;
  state: LifecycleState;
  reason: string;
  evidenceIds: string[];
  verifiedAt: string;
}

export interface PendingScope {
  ledgerId: string;
  scopeItemId: string;
  school: string;
  region: string;
  targetId: string;
  officialUrls: string[];
  nextAction: string;
  projectId?: string;
  reason: string;
  evidenceIds: string[];
  checkedAt: string;
}

export interface NormalizedObservation {
  canonicalProjectId: string;
  state: VerificationStatus | 'pending';
  verifiedAt: string;
  observation: ProjectObservation;
}

export interface ReductionError {
  code: string;
  message: string;
  evidenceIds: string[];
}

export interface ScanReduction {
  evidenceDispositions: EvidenceDisposition[];
  lifecycle: LifecycleRecord[];
  normalizedObservations: NormalizedObservation[];
  pending: PendingScope[];
  hardErrors: ReductionError[];
  metrics: {
    evidenceRecords: number;
    disposedEvidence: number;
    parentActive: number;
    carriedParentActive: number;
    unaccountedParentActive: number;
    unaccountedPendingScopes: number;
    pending: number;
  };
}

export interface PriorPendingIdentity {
  ledgerId: string;
  projectId?: string;
  scopeItemId?: string;
}

function canonicalProjectIdForReviewedSource(
  sourceProjectId: string,
  registry: ProjectIdentityRegistry,
): string {
  const seen = new Set<string>();
  let currentProjectId = sourceProjectId;
  while (true) {
    if (seen.has(currentProjectId)) {
      throw new Error(`identity cycle for ${sourceProjectId} at ${currentProjectId}`);
    }
    seen.add(currentProjectId);
    const candidates = [
      ...registry.projectAliases
        .filter((item) => item.sourceProjectId === currentProjectId)
        .map((item) => item.canonicalProjectId),
      ...registry.tombstones
        .filter((item) => item.projectId === currentProjectId)
        .map((item) => item.mergedInto),
    ];
    const unique = [...new Set(candidates)];
    if (unique.length > 1) {
      throw new Error(
        `identity conflict for ${sourceProjectId}: ${unique
          .sort(codePointCompare)
          .join(', ')}`,
      );
    }
    if (unique.length === 0) return currentProjectId;
    currentProjectId = unique[0];
  }
}

function isProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

function projectIdFromLedgerId(ledgerId: string): string | undefined {
  const projectId = ledgerId.slice('project:'.length);
  return ledgerId.startsWith('project:') && isProjectId(projectId)
    ? projectId
    : undefined;
}

function canonicalProjectIdForReferences(
  references: Array<string | undefined>,
  registry: ProjectIdentityRegistry,
): string | undefined {
  const canonicalIds = [
    ...new Set(
      references
        .filter((value): value is string => value !== undefined && isProjectId(value))
        .map((value) => canonicalProjectIdForReviewedSource(value, registry)),
    ),
  ];
  if (canonicalIds.length > 1) {
    throw new Error(
      `project identity references resolve to multiple canonical IDs: ${canonicalIds
        .sort(codePointCompare)
        .join(', ')}`,
    );
  }
  return canonicalIds[0];
}

function normalizePendingUpdateIdentity(
  update: PendingUpdate,
  registry: ProjectIdentityRegistry,
): PendingUpdate {
  const canonicalProjectId = canonicalProjectIdForReferences(
    [update.targetId, update.projectId, projectIdFromLedgerId(update.ledgerId)],
    registry,
  );
  if (canonicalProjectId === undefined) return update;
  return {
    ...update,
    ...(projectIdFromLedgerId(update.ledgerId) === undefined
      ? {}
      : { ledgerId: `project:${canonicalProjectId}` }),
    ...(isProjectId(update.targetId) ? { targetId: canonicalProjectId } : {}),
    ...(update.projectId === undefined ? {} : { projectId: canonicalProjectId }),
  };
}

export function normalizePendingUpdates(
  updates: readonly PendingUpdate[],
  registry: ProjectIdentityRegistry,
): PendingUpdate[] {
  const normalizedUpdates: PendingUpdate[] = [];
  const byLedgerId = new Map<string, PendingUpdate>();
  for (const update of updates) {
    let normalizedUpdate: PendingUpdate;
    try {
      normalizedUpdate = normalizePendingUpdateIdentity(update, registry);
    } catch (error) {
      throw new Error(
        `pending update ${update.ledgerId} identity conflict: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (byLedgerId.has(normalizedUpdate.ledgerId)) {
      throw new Error(
        `multiple pending updates resolve to ${normalizedUpdate.ledgerId}`,
      );
    }
    byLedgerId.set(normalizedUpdate.ledgerId, normalizedUpdate);
    normalizedUpdates.push(normalizedUpdate);
  }
  return normalizedUpdates;
}

function normalizePriorPendingIdentity(
  item: PriorPendingIdentity,
  registry: ProjectIdentityRegistry,
): PriorPendingIdentity {
  const canonicalProjectId = canonicalProjectIdForReferences(
    [item.projectId, projectIdFromLedgerId(item.ledgerId)],
    registry,
  );
  if (canonicalProjectId === undefined) return item;
  return {
    ...item,
    ...(projectIdFromLedgerId(item.ledgerId) === undefined
      ? {}
      : { ledgerId: `project:${canonicalProjectId}` }),
    projectId: canonicalProjectId,
  };
}

export function normalizePriorPendingIdentities(
  items: readonly PriorPendingIdentity[],
  registry: ProjectIdentityRegistry,
): PriorPendingIdentity[] {
  const normalizedItems: PriorPendingIdentity[] = [];
  const byLedgerId = new Set<string>();
  for (const item of items) {
    const normalizedItem = normalizePriorPendingIdentity(item, registry);
    if (byLedgerId.has(normalizedItem.ledgerId)) {
      throw new Error(
        `multiple prior pending entries resolve to ${normalizedItem.ledgerId}`,
      );
    }
    byLedgerId.add(normalizedItem.ledgerId);
    normalizedItems.push(normalizedItem);
  }
  return normalizedItems;
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

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString();
}

function projectSchool(projectId: string): string {
  return projectId.split('|')[1] ?? '';
}

function projectCycle(projectId: string): string {
  return projectId.split('|')[0] ?? '';
}

function projectInstitute(projectId: string): string {
  return projectId.split('|')[2] ?? '';
}

export function resolveProjectIdentity(
  observation: ProjectObservation,
  parent: PublicSnapshot | null,
  registry: ProjectIdentityRegistry,
): CanonicalIdentity {
  const candidates: Array<{
    canonicalProjectId: string;
    method: CanonicalIdentity['method'];
  }> = [];
  const projectAlias = registry.projectAliases.find(
    (item) => item.sourceProjectId === observation.sourceProjectId,
  );
  const sourceCanonicalProjectId = canonicalProjectIdForReviewedSource(
    observation.sourceProjectId,
    registry,
  );
  if (sourceCanonicalProjectId !== observation.sourceProjectId) {
    candidates.push({
      canonicalProjectId: sourceCanonicalProjectId,
      method: projectAlias === undefined ? 'tombstone' : 'project-alias',
    });
  }
  const normalizedOfficialUrl = normalizeUrl(observation.officialUrl);
  const urlAliases = registry.urlAliases.filter(
    (item) => normalizeUrl(item.url) === normalizedOfficialUrl,
  );
  for (const urlAlias of urlAliases) {
    candidates.push({
      canonicalProjectId: canonicalProjectIdForReviewedSource(
        urlAlias.canonicalProjectId,
        registry,
      ),
      method: 'url-alias',
    });
  }
  const exactParent = parent?.opportunities.find(
    (item) => item.projectId === observation.sourceProjectId,
  );
  if (exactParent !== undefined) {
    candidates.push({
      canonicalProjectId: canonicalProjectIdForReviewedSource(
        exactParent.projectId,
        registry,
      ),
      method: 'parent-project-id',
    });
  }
  const canonicalIds = [...new Set(candidates.map((item) => item.canonicalProjectId))];
  if (canonicalIds.length > 1) {
    throw new Error(
      `identity conflict for ${observation.sourceProjectId}: ${canonicalIds
        .sort(codePointCompare)
        .join(', ')}`,
    );
  }
  const selected =
    candidates.find((item) => item.canonicalProjectId === canonicalIds[0]) ??
    ({
      canonicalProjectId: observation.sourceProjectId,
      method: 'new-project-id',
    } as const);
  const registryAuthorizedRename =
    selected.method === 'project-alias' ||
    selected.method === 'url-alias' ||
    selected.method === 'tombstone';
  if (
    projectCycle(selected.canonicalProjectId) !== observation.cycle ||
    (
      projectSchool(selected.canonicalProjectId) !== observation.school &&
      !registryAuthorizedRename
    )
  ) {
    throw new Error(
      `canonical identity ${selected.canonicalProjectId} does not match observation cycle/school`,
    );
  }
  return {
    sourceProjectId: observation.sourceProjectId,
    canonicalProjectId: selected.canonicalProjectId,
    method: selected.method,
  };
}

function stateForObservation(
  observation: ProjectObservation,
  scanFinishedAt: string,
): VerificationStatus | 'pending' {
  if (observation.registrationState === 'closed') return 'expired';
  if (
    observation.deadline !== null &&
    Date.parse(observation.deadline) <= Date.parse(scanFinishedAt)
  ) {
    return 'expired';
  }
  if (observation.registrationState === 'unknown') return 'pending';
  return observation.deadline === null
    ? 'confirmed-unknown-deadline'
    : 'confirmed-open';
}

function latestEvidenceTime(
  evidenceIds: string[],
  evidenceById: Map<string, EvidenceRecord>,
  fallback: string,
): string {
  return evidenceIds
    .map((evidenceId) => evidenceById.get(evidenceId)?.checkedAt)
    .filter((value): value is string => value !== undefined)
    .sort(codePointCompare)
    .at(-1) ?? fallback;
}

function lifecycleFromExclusion(
  exclusion: ProjectExclusion,
  verifiedAt: string,
  canonicalProjectId: string,
): LifecycleRecord {
  return {
    sourceProjectId: exclusion.sourceProjectId,
    canonicalProjectId,
    state: exclusion.action,
    reason: exclusion.reason,
    evidenceIds: [...exclusion.evidenceIds].sort(codePointCompare),
    verifiedAt,
  };
}

function pendingFromScope(
  scopeItem: ScopeItem,
  evidenceById: Map<string, EvidenceRecord>,
  reason: string,
  canonicalProjectId?: string,
): PendingScope {
  const checkedAt = latestEvidenceTime(
    scopeItem.evidenceIds,
    evidenceById,
    '1970-01-01T00:00:00.000Z',
  );
  const projectId = canonicalProjectId ?? (isProjectId(scopeItem.targetId)
    ? scopeItem.targetId
    : undefined);
  const evidence = scopeItem.evidenceIds
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((record): record is EvidenceRecord => record !== undefined);
  const regions = [...new Set(evidence.map((record) => record.region))].sort(
    codePointCompare,
  );
  return {
    ledgerId: projectId === undefined ? `scope:${scopeItem.scopeItemId}` : `project:${projectId}`,
    scopeItemId: scopeItem.scopeItemId,
    school: scopeItem.school,
    region: regions[0] ?? 'unknown',
    targetId: projectId ?? scopeItem.targetId,
    officialUrls: [...new Set(evidence.map((record) => record.url))].sort(
      codePointCompare,
    ),
    nextAction: 'recheck official scope in the next scan',
    ...(projectId === undefined ? {} : { projectId }),
    reason,
    evidenceIds: [...scopeItem.evidenceIds].sort(codePointCompare),
    checkedAt,
  };
}

function pendingFromObservation(
  normalized: NormalizedObservation,
  scopeItem: ScopeItem,
  evidenceById: Map<string, EvidenceRecord>,
): PendingScope {
  const evidence = normalized.observation.evidenceIds
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((record): record is EvidenceRecord => record !== undefined);
  const regions = [...new Set(evidence.map((record) => record.region))].sort(
    codePointCompare,
  );
  return {
    ledgerId: `project:${normalized.canonicalProjectId}`,
    scopeItemId: scopeItem.scopeItemId,
    school: scopeItem.school,
    region: regions[0] ?? 'unknown',
    targetId: normalized.canonicalProjectId,
    officialUrls: [...new Set(evidence.map((record) => record.url))].sort(
      codePointCompare,
    ),
    nextAction: 'recheck official project registration state in the next scan',
    projectId: normalized.canonicalProjectId,
    reason: 'official project registration state remains unknown',
    evidenceIds: [...normalized.observation.evidenceIds].sort(codePointCompare),
    checkedAt: normalized.verifiedAt,
  };
}

function errorSortKey(error: ReductionError): string {
  return `${error.code}\u0000${error.evidenceIds.join('\u0000')}\u0000${error.message}`;
}

export function reduceScanRelease(
  bundle: ScanBundle,
  parent: PublicSnapshot | null,
  registry: ProjectIdentityRegistry,
  priorPending: PriorPendingIdentity[],
  submittedProjectIds: readonly string[] = [],
): ScanReduction {
  const evidenceById = new Map(
    bundle.evidenceRecords.map((record) => [record.evidenceId, record]),
  );
  const scopeById = new Map(
    bundle.scopeItems.map((scopeItem) => [scopeItem.scopeItemId, scopeItem]),
  );
  const observationByEvidence = new Map<string, ProjectObservation[]>();
  for (const observation of bundle.projectObservations) {
    for (const evidenceId of observation.evidenceIds) {
      const current = observationByEvidence.get(evidenceId) ?? [];
      current.push(observation);
      observationByEvidence.set(evidenceId, current);
    }
  }

  const hardErrors: ReductionError[] = bundle.errors.map((error) => ({
    code: error.code,
    message: error.message,
    evidenceIds: [...error.evidenceIds].sort(codePointCompare),
  }));
  const submitted = new Set(submittedProjectIds);
  for (const submittedProjectId of submittedProjectIds) {
    try {
      submitted.add(
        canonicalProjectIdForReviewedSource(submittedProjectId, registry),
      );
    } catch (error) {
      hardErrors.push({
        code: 'SUBMITTED_EXCLUSION_IDENTITY_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
        evidenceIds: [],
      });
    }
  }
  const evidenceDispositions: EvidenceDisposition[] = [];
  const normalizedObservations: NormalizedObservation[] = [];
  const lifecycleBySource = new Map<string, LifecycleRecord>();
  const lifecycleByCanonical = new Map<string, LifecycleRecord>();
  const canonicalScopeProjectIdByScopeItemId = new Map<string, string>();
  for (const scopeItem of bundle.scopeItems) {
    if (!isProjectId(scopeItem.targetId)) continue;
    try {
      canonicalScopeProjectIdByScopeItemId.set(
        scopeItem.scopeItemId,
        canonicalProjectIdForReviewedSource(scopeItem.targetId, registry),
      );
    } catch (error) {
      hardErrors.push({
        code: 'PROJECT_IDENTITY_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
        evidenceIds: [...scopeItem.evidenceIds].sort(codePointCompare),
      });
    }
  }
  let pendingUpdates: PendingUpdate[] = [];
  try {
    pendingUpdates = normalizePendingUpdates(bundle.pendingUpdates, registry);
  } catch (error) {
    hardErrors.push({
      code: 'PENDING_UPDATE_IDENTITY_CONFLICT',
      message: error instanceof Error ? error.message : String(error),
      evidenceIds: [...new Set(bundle.pendingUpdates.flatMap((item) => item.evidenceIds))]
        .sort(codePointCompare),
    });
  }
  const parentByReviewedUrlScope = new Map<string, PublicOpportunity[]>();
  for (const opportunity of parent?.opportunities ?? []) {
    const key = [
      opportunity.projectId.slice(0, 4),
      opportunity.name,
      opportunity.institute,
      normalizeUrl(opportunity.website),
    ].join('\u0000');
    const current = parentByReviewedUrlScope.get(key) ?? [];
    current.push(opportunity);
    parentByReviewedUrlScope.set(key, current);
  }
  const observationByReviewedUrlScope = new Map<string, ProjectObservation[]>();
  for (const observation of bundle.projectObservations) {
    const key = [
      observation.cycle,
      observation.school,
      projectInstitute(observation.sourceProjectId),
      normalizeUrl(observation.officialUrl),
    ].join('\u0000');
    const current = observationByReviewedUrlScope.get(key) ?? [];
    current.push(observation);
    observationByReviewedUrlScope.set(key, current);
  }
  for (const observations of observationByReviewedUrlScope.values()) {
    const sourceIds = [...new Set(observations.map(({ sourceProjectId }) => sourceProjectId))];
    if (sourceIds.length <= 1) continue;
    const allExplicitlyReviewed = observations.every((observation) => (
      registry.projectAliases.some(
        ({ sourceProjectId }) => sourceProjectId === observation.sourceProjectId,
      )
      || registry.tombstones.some(
        ({ projectId }) => projectId === observation.sourceProjectId,
      )
    ));
    if (allExplicitlyReviewed) continue;
    hardErrors.push({
      code: 'SHARED_OFFICIAL_URL_REQUIRES_IDENTITY_REVIEW',
      message: `projects ${sourceIds.sort(codePointCompare).join(', ')} share one official URL and institute without explicit identity review`,
      evidenceIds: [...new Set(observations.flatMap(({ evidenceIds }) => evidenceIds))]
        .sort(codePointCompare),
    });
  }

  for (const observation of [...bundle.projectObservations].sort((left, right) =>
    codePointCompare(left.observationId, right.observationId),
  )) {
    let identity: CanonicalIdentity;
    try {
      identity = resolveProjectIdentity(observation, parent, registry);
    } catch (error) {
      hardErrors.push({
        code: 'PROJECT_IDENTITY_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
        evidenceIds: [...observation.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    if (
      submitted.has(observation.sourceProjectId)
      || submitted.has(identity.canonicalProjectId)
    ) {
      hardErrors.push({
        code: 'SUBMITTED_PROJECT_NOT_EXCLUDED',
        message: `${observation.sourceProjectId} resolves to submitted project ${identity.canonicalProjectId} but was emitted as an observation`,
        evidenceIds: [...observation.evidenceIds].sort(codePointCompare),
      });
    }
    if (identity.method === 'new-project-id') {
      const parentKey = [
        observation.cycle,
        observation.school,
        projectInstitute(observation.sourceProjectId),
        normalizeUrl(observation.officialUrl),
      ].join('\u0000');
      const conflictingParent = (parentByReviewedUrlScope.get(parentKey) ?? [])
        .find(({ projectId }) => projectId !== observation.sourceProjectId);
      if (conflictingParent !== undefined) {
        hardErrors.push({
          code: 'SHARED_OFFICIAL_URL_REQUIRES_IDENTITY_REVIEW',
          message: `${observation.sourceProjectId} shares the official URL and institute of ${conflictingParent.projectId} without an explicit identity registry decision`,
          evidenceIds: [...observation.evidenceIds].sort(codePointCompare),
        });
        continue;
      }
    }
    const existing = lifecycleByCanonical.get(identity.canonicalProjectId);
    if (existing !== undefined) {
      hardErrors.push({
        code: 'DUPLICATE_CANONICAL_PROJECT_OBSERVATION',
        message: `${observation.observationId} duplicates ${identity.canonicalProjectId}`,
        evidenceIds: [...observation.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    const state = stateForObservation(observation, bundle.scanFinishedAt);
    const verifiedAt = latestEvidenceTime(
      observation.evidenceIds,
      evidenceById,
      bundle.scanFinishedAt,
    );
    const lifecycle: LifecycleRecord = {
      sourceProjectId: observation.sourceProjectId,
      canonicalProjectId: identity.canonicalProjectId,
      state,
      reason: `derived from ${identity.method}`,
      evidenceIds: [...observation.evidenceIds].sort(codePointCompare),
      verifiedAt,
    };
    lifecycleBySource.set(observation.sourceProjectId, lifecycle);
    lifecycleByCanonical.set(identity.canonicalProjectId, lifecycle);
    normalizedObservations.push({
      canonicalProjectId: identity.canonicalProjectId,
      state,
      verifiedAt,
      observation,
    });
  }

  for (const record of [...bundle.evidenceRecords].sort((left, right) =>
    codePointCompare(left.evidenceId, right.evidenceId),
  )) {
    const observations = observationByEvidence.get(record.evidenceId) ?? [];
    const boundLifecycle = observations
      .map((observation) => lifecycleBySource.get(observation.sourceProjectId))
      .filter((value): value is LifecycleRecord => value !== undefined);
    const canonicalIds = [
      ...new Set(boundLifecycle.map((item) => item.canonicalProjectId)),
    ];
    if (canonicalIds.length === 1 && observations.length === 1) {
      evidenceDispositions.push({
        evidenceId: record.evidenceId,
        kind: 'project',
        canonicalProjectId: canonicalIds[0],
        reason: 'bound to project observation',
      });
      continue;
    }
    if (observations.length > 1 || canonicalIds.length > 1) {
      const error: ReductionError = {
        code: 'EVIDENCE_BOUND_TO_MULTIPLE_PROJECTS',
        message: `evidence ${record.evidenceId} is bound to multiple project observations`,
        evidenceIds: [record.evidenceId],
      };
      hardErrors.push(error);
      evidenceDispositions.push({
        evidenceId: record.evidenceId,
        kind: 'hard-error',
        reason: error.message,
      });
      continue;
    }
    if (record.result === 'hit') {
      const error: ReductionError = {
        code: 'HIT_WITHOUT_PROJECT_DISPOSITION',
        message: `readable hit ${record.evidenceId} is not bound to a project observation`,
        evidenceIds: [record.evidenceId],
      };
      hardErrors.push(error);
      evidenceDispositions.push({
        evidenceId: record.evidenceId,
        kind: 'hard-error',
        reason: error.message,
      });
      continue;
    }
    evidenceDispositions.push({
      evidenceId: record.evidenceId,
      kind: 'scope',
      scopeItemId: record.scopeItemId,
      reason: `official evidence result ${record.result}`,
    });
  }

  for (const exclusion of bundle.exclusions) {
    let canonicalProjectId: string;
    try {
      canonicalProjectId = canonicalProjectIdForReviewedSource(
        exclusion.action === 'identity-merged'
          ? exclusion.targetProjectId!
          : exclusion.sourceProjectId,
        registry,
      );
    } catch (error) {
      hardErrors.push({
        code: exclusion.action === 'submitted-excluded'
          ? 'SUBMITTED_EXCLUSION_IDENTITY_CONFLICT'
          : 'PROJECT_IDENTITY_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
        evidenceIds: [...exclusion.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    const sourceLifecycle = lifecycleBySource.get(exclusion.sourceProjectId);
    const canonicalLifecycle = lifecycleByCanonical.get(canonicalProjectId);
    if (sourceLifecycle !== undefined || (
      exclusion.action !== 'identity-merged' && canonicalLifecycle !== undefined
    )) {
      const conflictingLifecycle = sourceLifecycle ?? canonicalLifecycle!;
      hardErrors.push({
        code: 'CANONICAL_PROJECT_LIFECYCLE_CONFLICT',
        message:
          `${exclusion.sourceProjectId} resolves to ${canonicalProjectId} but conflicts with ` +
          `${conflictingLifecycle.sourceProjectId} (${conflictingLifecycle.state})`,
        evidenceIds: [...exclusion.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    if (exclusion.action === 'submitted-excluded') {
      if (!submitted.has(canonicalProjectId)) {
        hardErrors.push({
          code: 'SUBMITTED_EXCLUSION_NOT_IN_REGISTRY',
          message: `${exclusion.sourceProjectId} resolves to ${canonicalProjectId}, which is absent from the submitted registry`,
          evidenceIds: [...exclusion.evidenceIds].sort(codePointCompare),
        });
        continue;
      }
    }
    const lifecycle = lifecycleFromExclusion(
      exclusion,
      latestEvidenceTime(
        exclusion.evidenceIds,
        evidenceById,
        bundle.scanFinishedAt,
      ),
      canonicalProjectId,
    );
    lifecycleBySource.set(exclusion.sourceProjectId, lifecycle);
    if (lifecycle.state !== 'identity-merged') {
      lifecycleByCanonical.set(lifecycle.canonicalProjectId, lifecycle);
    }
  }

  const pendingByLedgerId = new Map<string, PendingScope>();
  const ambiguousPendingByLedgerId = new Map<
    string,
    { scopes: Set<string>; evidenceIds: Set<string>; error: ReductionError }
  >();
  const addPending = (item: PendingScope): void => {
    const ambiguous = ambiguousPendingByLedgerId.get(item.ledgerId);
    if (ambiguous !== undefined) {
      ambiguous.scopes.add(item.scopeItemId);
      item.evidenceIds.forEach((evidenceId) => ambiguous.evidenceIds.add(evidenceId));
      ambiguous.error.message =
        `pending ledger ${item.ledgerId} resolves from multiple scopes: ${
          [...ambiguous.scopes].sort(codePointCompare).join(', ')
        }`;
      ambiguous.error.evidenceIds = [...ambiguous.evidenceIds].sort(codePointCompare);
      return;
    }
    const existing = pendingByLedgerId.get(item.ledgerId);
    if (existing === undefined) {
      pendingByLedgerId.set(item.ledgerId, item);
      return;
    }
    if (
      existing.scopeItemId !== item.scopeItemId ||
      existing.school !== item.school ||
      existing.targetId !== item.targetId ||
      existing.projectId !== item.projectId
    ) {
      pendingByLedgerId.delete(item.ledgerId);
      const scopes = new Set([existing.scopeItemId, item.scopeItemId]);
      const evidenceIds = new Set([
        ...existing.evidenceIds,
        ...item.evidenceIds,
      ]);
      const error: ReductionError = {
        code: 'DUPLICATE_PENDING_LEDGER_IDENTITY',
        message:
          `pending ledger ${item.ledgerId} resolves from multiple scopes: ${
            [...scopes].sort(codePointCompare).join(', ')
          }`,
        evidenceIds: [...evidenceIds].sort(codePointCompare),
      };
      ambiguousPendingByLedgerId.set(item.ledgerId, {
        scopes,
        evidenceIds,
        error,
      });
      hardErrors.push(error);
      return;
    }
    const preferred =
      Date.parse(existing.checkedAt) > Date.parse(item.checkedAt) ||
      (
        existing.checkedAt === item.checkedAt &&
        JSON.stringify(existing) <= JSON.stringify(item)
      )
        ? existing
        : item;
    pendingByLedgerId.set(item.ledgerId, {
      ...preferred,
      evidenceIds: [...new Set([...existing.evidenceIds, ...item.evidenceIds])].sort(
        codePointCompare,
      ),
      officialUrls: [...new Set([
        ...existing.officialUrls,
        ...item.officialUrls,
      ])].sort(codePointCompare),
      checkedAt:
        Date.parse(existing.checkedAt) >= Date.parse(item.checkedAt)
          ? existing.checkedAt
          : item.checkedAt,
    });
  };
  for (const normalized of normalizedObservations) {
    if (normalized.state !== 'pending') continue;
    const evidenceScopeItemIds = [
      ...new Set(
        normalized.observation.evidenceIds
          .map((evidenceId) => evidenceById.get(evidenceId)?.scopeItemId)
          .filter((scopeItemId): scopeItemId is string => scopeItemId !== undefined),
      ),
    ].sort(codePointCompare);
    if (evidenceScopeItemIds.length !== 1) {
      hardErrors.push({
        code: 'PENDING_PROJECT_WITHOUT_UNIQUE_SCOPE',
        message: `pending project ${normalized.canonicalProjectId} must resolve to exactly one scope item`,
        evidenceIds: [...normalized.observation.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    const scopeItem = scopeById.get(evidenceScopeItemIds[0]);
    if (scopeItem === undefined) {
      hardErrors.push({
        code: 'PENDING_PROJECT_WITHOUT_UNIQUE_SCOPE',
        message: `pending project ${normalized.canonicalProjectId} references an unknown scope item`,
        evidenceIds: [...normalized.observation.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    addPending(
      pendingFromObservation(normalized, scopeItem, evidenceById),
    );
  }
  for (const scopeItem of bundle.scopeItems) {
    if (scopeItem.status === 'blocked') {
      addPending(pendingFromScope(
        scopeItem,
        evidenceById,
        'official scope blocked',
        canonicalScopeProjectIdByScopeItemId.get(scopeItem.scopeItemId),
      ));
    } else if (scopeItem.status === 'no-current-notice' && scopeItem.kind === 'pending') {
      addPending(
        pendingFromScope(
          scopeItem,
          evidenceById,
          'pending scope has no current notice',
          canonicalScopeProjectIdByScopeItemId.get(scopeItem.scopeItemId),
        ),
      );
    }
  }

  let unaccountedPendingScopes = 0;
  for (const [ledgerId, pendingScope] of pendingByLedgerId) {
    const update = pendingUpdates.find(
      (item) =>
        item.ledgerId === ledgerId &&
        item.scopeItemId === pendingScope.scopeItemId,
    );
    if (update === undefined) {
      unaccountedPendingScopes += 1;
      hardErrors.push({
        code: 'PENDING_SCOPE_WITHOUT_LEDGER_UPDATE',
        message: `pending scope ${pendingScope.scopeItemId} has no matching current-run ledger update`,
        evidenceIds: [...pendingScope.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    if (update.outcome !== 'pending' && update.outcome !== 'hard-error') {
      unaccountedPendingScopes += 1;
      hardErrors.push({
        code: 'PENDING_SCOPE_HAS_RESOLVED_LEDGER_OUTCOME',
        message: `pending scope ${pendingScope.scopeItemId} has resolved outcome ${update.outcome}`,
        evidenceIds: [...update.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    if (
      update.school !== pendingScope.school ||
      update.targetId !== pendingScope.targetId ||
      JSON.stringify([...update.evidenceIds].sort(codePointCompare)) !==
        JSON.stringify([...pendingScope.evidenceIds].sort(codePointCompare))
    ) {
      unaccountedPendingScopes += 1;
      hardErrors.push({
        code: 'PENDING_SCOPE_LEDGER_IDENTITY_MISMATCH',
        message: `pending scope ${pendingScope.scopeItemId} does not match ledger update ${ledgerId}`,
        evidenceIds: [...new Set([
          ...pendingScope.evidenceIds,
          ...update.evidenceIds,
        ])].sort(codePointCompare),
      });
      continue;
    }
    pendingByLedgerId.set(ledgerId, {
      ...pendingScope,
      region: update.region,
      officialUrls: [...update.officialUrls].sort(codePointCompare),
      nextAction: update.nextAction,
      reason: update.reason,
      checkedAt: update.checkedAt,
      ...(update.projectId === undefined ? {} : { projectId: update.projectId }),
    });
  }
  const normalizedPriorPending: PriorPendingIdentity[] = [];
  const priorPendingByLedgerId = new Map<string, PriorPendingIdentity>();
  for (const item of priorPending) {
    let normalizedItem: PriorPendingIdentity;
    try {
      normalizedItem = normalizePriorPendingIdentity(item, registry);
    } catch (error) {
      hardErrors.push({
        code: 'PROJECT_IDENTITY_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
        evidenceIds: [],
      });
      continue;
    }
    if (priorPendingByLedgerId.has(normalizedItem.ledgerId)) {
      hardErrors.push({
        code: 'DUPLICATE_CANONICAL_PENDING_LEDGER_IDENTITY',
        message: `multiple prior pending entries resolve to ${normalizedItem.ledgerId}`,
        evidenceIds: [],
      });
      continue;
    }
    priorPendingByLedgerId.set(normalizedItem.ledgerId, normalizedItem);
    normalizedPriorPending.push(normalizedItem);
  }
  const priorPendingLedgerIds = new Set(priorPendingByLedgerId.keys());
  for (const update of pendingUpdates) {
    if (
      !pendingByLedgerId.has(update.ledgerId) &&
      !ambiguousPendingByLedgerId.has(update.ledgerId) &&
      !priorPendingLedgerIds.has(update.ledgerId)
    ) {
      unaccountedPendingScopes += 1;
      hardErrors.push({
        code: 'LEDGER_UPDATE_WITHOUT_PENDING_IDENTITY',
        message: `ledger update ${update.ledgerId} does not match a pending scope or previous ledger entry`,
        evidenceIds: [...update.evidenceIds].sort(codePointCompare),
      });
    }
    const prior = priorPendingByLedgerId.get(update.ledgerId);
    if (
      prior !== undefined &&
      (update.outcome === 'pending' || update.outcome === 'hard-error') &&
      prior.projectId !== update.projectId
    ) {
      unaccountedPendingScopes += 1;
      hardErrors.push({
        code: 'PENDING_LEDGER_PROJECT_ID_MISMATCH',
        message: `ledger update ${update.ledgerId} changes its stable project identity`,
        evidenceIds: [...update.evidenceIds].sort(codePointCompare),
      });
      continue;
    }
    if (
      prior !== undefined &&
      !pendingByLedgerId.has(update.ledgerId) &&
      (update.outcome === 'pending' || update.outcome === 'hard-error')
    ) {
      pendingByLedgerId.set(update.ledgerId, {
        ledgerId: update.ledgerId,
        scopeItemId: update.scopeItemId,
        school: update.school,
        region: update.region,
        targetId: update.targetId,
        officialUrls: [...update.officialUrls].sort(codePointCompare),
        nextAction: update.nextAction,
        ...(update.projectId === undefined
          ? {}
          : { projectId: update.projectId }),
        reason: update.reason,
        evidenceIds: [...update.evidenceIds].sort(codePointCompare),
        checkedAt: update.checkedAt,
      });
    }
  }

  const priorPendingProjectIds = new Set<string>();
  for (const projectId of normalizedPriorPending
    .map((item) => item.projectId)
    .filter((value): value is string => value !== undefined)) {
    priorPendingProjectIds.add(projectId);
    try {
      priorPendingProjectIds.add(
        canonicalProjectIdForReviewedSource(projectId, registry),
      );
    } catch (error) {
      hardErrors.push({
        code: 'PROJECT_IDENTITY_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
        evidenceIds: [],
      });
    }
  }
  let parentActive = 0;
  let carriedParentActive = 0;
  let unaccountedParentActive = 0;
  for (const opportunity of parent?.opportunities ?? []) {
    let parentCanonicalProjectId = opportunity.projectId;
    try {
      parentCanonicalProjectId = canonicalProjectIdForReviewedSource(
        opportunity.projectId,
        registry,
      );
    } catch (error) {
      hardErrors.push({
        code: 'PROJECT_IDENTITY_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
        evidenceIds: [],
      });
    }
    if (
      lifecycleByCanonical.has(parentCanonicalProjectId) ||
      lifecycleBySource.has(opportunity.projectId)
    ) {
      continue;
    }
    if (
      submitted.has(opportunity.projectId)
      || submitted.has(parentCanonicalProjectId)
    ) {
      hardErrors.push({
        code: 'SUBMITTED_PROJECT_NOT_EXCLUDED',
        message: `parent project ${opportunity.projectId} is submitted but lacks an explicit submitted-excluded transition`,
        evidenceIds: [],
      });
      const lifecycle: LifecycleRecord = {
        sourceProjectId: opportunity.projectId,
        canonicalProjectId: parentCanonicalProjectId,
        state: 'submitted-excluded',
        reason: 'submitted registry requires an explicit exclusion transition',
        evidenceIds: [],
        verifiedAt: bundle.scanFinishedAt,
      };
      lifecycleBySource.set(opportunity.projectId, lifecycle);
      lifecycleByCanonical.set(parentCanonicalProjectId, lifecycle);
      continue;
    }
    if (opportunity.verificationStatus === 'expired') {
      const lifecycle: LifecycleRecord = {
        sourceProjectId: opportunity.projectId,
        canonicalProjectId: parentCanonicalProjectId,
        state: 'expired',
        reason: 'preserved parent expired project',
        evidenceIds: [],
        verifiedAt: opportunity.verifiedAt,
      };
      lifecycleBySource.set(opportunity.projectId, lifecycle);
      lifecycleByCanonical.set(parentCanonicalProjectId, lifecycle);
      continue;
    }
    parentActive += 1;
    if (
      opportunity.deadline !== null &&
      Date.parse(opportunity.deadline) <= Date.parse(bundle.scanFinishedAt)
    ) {
      const lifecycle: LifecycleRecord = {
        sourceProjectId: opportunity.projectId,
        canonicalProjectId: parentCanonicalProjectId,
        state: 'expired',
        reason: 'parent deadline elapsed before scan finished',
        evidenceIds: [],
        verifiedAt: bundle.scanFinishedAt,
      };
      lifecycleBySource.set(opportunity.projectId, lifecycle);
      lifecycleByCanonical.set(parentCanonicalProjectId, lifecycle);
      continue;
    }
    const exactScopes = bundle.scopeItems.filter(
      (item) =>
        canonicalScopeProjectIdByScopeItemId.get(item.scopeItemId) ===
        parentCanonicalProjectId,
    );
    if (bundle.scanMode === 'incremental' && exactScopes.length === 0) {
      carriedParentActive += 1;
      const lifecycle: LifecycleRecord = {
        sourceProjectId: opportunity.projectId,
        canonicalProjectId: parentCanonicalProjectId,
        state: 'carried-active',
        reason: 'untouched parent project carried by incremental scan',
        evidenceIds: [],
        verifiedAt: opportunity.verifiedAt,
      };
      lifecycleBySource.set(opportunity.projectId, lifecycle);
      lifecycleByCanonical.set(parentCanonicalProjectId, lifecycle);
      continue;
    }
    const blockedScope = exactScopes.find(
      (item) => item.status === 'blocked' || item.status === 'no-current-notice',
    );
    if (
      blockedScope !== undefined
      || priorPendingProjectIds.has(opportunity.projectId)
      || priorPendingProjectIds.has(parentCanonicalProjectId)
    ) {
      const evidenceIds = blockedScope?.evidenceIds ?? [];
      const lifecycle: LifecycleRecord = {
        sourceProjectId: opportunity.projectId,
        canonicalProjectId: parentCanonicalProjectId,
        state: 'pending',
        reason:
          blockedScope === undefined
            ? 'preserved from prior pending ledger'
            : 'official project scope unavailable',
        evidenceIds: [...evidenceIds].sort(codePointCompare),
        verifiedAt:
          blockedScope === undefined
            ? bundle.scanFinishedAt
            : latestEvidenceTime(
                blockedScope.evidenceIds,
                evidenceById,
                bundle.scanFinishedAt,
              ),
      };
      lifecycleBySource.set(opportunity.projectId, lifecycle);
      lifecycleByCanonical.set(parentCanonicalProjectId, lifecycle);
      if (blockedScope !== undefined) {
        addPending(
          pendingFromScope(
            blockedScope,
            evidenceById,
            'previous active project requires follow-up',
            canonicalScopeProjectIdByScopeItemId.get(blockedScope.scopeItemId),
          ),
        );
      }
      continue;
    }
    unaccountedParentActive += 1;
    const message = `parent active project ${opportunity.projectId} has no current transition`;
    hardErrors.push({
      code: 'UNACCOUNTED_PARENT_ACTIVE',
      message,
      evidenceIds: [],
    });
    const lifecycle: LifecycleRecord = {
      sourceProjectId: opportunity.projectId,
      canonicalProjectId: parentCanonicalProjectId,
      state: 'pending',
      reason: message,
      evidenceIds: [],
      verifiedAt: bundle.scanFinishedAt,
    };
    lifecycleBySource.set(opportunity.projectId, lifecycle);
    lifecycleByCanonical.set(parentCanonicalProjectId, lifecycle);
  }

  const lifecycle = [...lifecycleBySource.values()].sort((left, right) =>
    codePointCompare(left.sourceProjectId, right.sourceProjectId),
  );
  const pending = [...pendingByLedgerId.values()].sort((left, right) =>
    codePointCompare(left.scopeItemId, right.scopeItemId),
  );
  evidenceDispositions.sort((left, right) =>
    codePointCompare(left.evidenceId, right.evidenceId),
  );
  normalizedObservations.sort((left, right) =>
    codePointCompare(left.canonicalProjectId, right.canonicalProjectId),
  );
  hardErrors.sort((left, right) =>
    codePointCompare(errorSortKey(left), errorSortKey(right)),
  );

  for (const disposition of evidenceDispositions) {
    if (
      disposition.kind === 'scope' &&
      disposition.scopeItemId !== undefined &&
      !scopeById.has(disposition.scopeItemId)
    ) {
      throw new Error(`unknown disposition scope ${disposition.scopeItemId}`);
    }
  }

  return {
    evidenceDispositions,
    lifecycle,
    normalizedObservations,
    pending,
    hardErrors,
    metrics: {
      evidenceRecords: bundle.evidenceRecords.length,
      disposedEvidence: evidenceDispositions.length,
      parentActive,
      carriedParentActive,
      unaccountedParentActive,
      unaccountedPendingScopes,
      pending: pending.length,
    },
  };
}
