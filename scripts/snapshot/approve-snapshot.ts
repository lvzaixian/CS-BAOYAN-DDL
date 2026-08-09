import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  posix,
  resolve,
  sep,
  win32,
} from 'node:path';
import { MIMEType } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalDataHash,
  deriveSnapshotId,
  isValidIsoTimestamp,
  readRegularJsonFile,
  validateApprovedSnapshot,
  validateApprovedSnapshotStructure,
} from '../../src/lib/snapshot-integrity.js';
import type { RegularJsonFile } from '../../src/lib/snapshot-integrity.js';
import type {
  PublicSnapshot,
  PublicOpportunity,
  ReadablePublicSnapshot,
  SnapshotCandidate,
} from '../../src/lib/snapshot-types.js';
import {
  validateCandidate,
  validateCandidateStructure,
} from '../../src/lib/snapshot-validation.js';
import {
  parsePrioritySentinels,
  parseRegistryInstitutions,
  parseSubmittedProjectRegistry,
  verifyScanReleaseReplay,
  type ScanReleaseAudit,
} from './build-scan-release.js';
import {
  assertReadableEvidenceArtifactsCovered,
  verifyEvidenceArtifactManifest,
} from './evidence-artifact-manifest.js';
import { parsePendingLedger } from './pending-ledger.js';
import {
  parseIdentityRegistry,
  parseScanBundle,
} from './scan-release-contract.js';
import type { ScanReduction } from './scan-release-reducer.js';
import {
  parseRemovalReviews,
  type ReleaseGateManifest,
} from './release-gate.js';
import type { SnapshotDiff } from './diff-snapshots.js';

export {
  canonicalDataHash,
  readRegularJsonFile,
  validateApprovedSnapshot,
};
export { MAX_SNAPSHOT_JSON_BYTES } from '../../src/lib/snapshot-integrity.js';
export type { RegularJsonFile } from '../../src/lib/snapshot-integrity.js';

type JsonObject = Record<string, unknown>;

interface CliOptions {
  releaseDir: string;
  approved: string;
  pendingCurrent: string;
  approvedAt?: string;
  removalAuthorization?: string;
  removalAuthorizationSha256?: string;
}

interface FileFingerprint {
  exists: boolean;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  contentHash?: string;
}

interface ApprovedFileState {
  value: ReadablePublicSnapshot | null;
  fingerprint: FileFingerprint;
  text?: string;
}

interface ApprovalLockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

interface ApprovalLock {
  handle: FileHandle;
  path: string;
  token: string;
  dev: number;
  ino: number;
}

export interface ApproveSnapshotIoHooks {
  beforeRename?: () => Promise<void>;
  afterApprovedFingerprintCheck?: () => Promise<void>;
  afterApprovedRecoveryLink?: () => Promise<void>;
  beforeLockReleaseRename?: () => Promise<void>;
  openDirectory?: (path: string) => Promise<FileHandle>;
  syncDirectory?: (handle: FileHandle) => Promise<void>;
}

export interface ApproveSnapshotFileOptions {
  releaseDir: string;
  approvedPath: string;
  pendingCurrentPath: string;
  approvedAt: string;
  removalAuthorizationPath?: string;
  expectedRemovalAuthorizationSha256?: string;
}

export interface AdditiveFieldEvidence {
  field: string;
  normalizedValue: string;
  sourceUrl: string;
  artifactSha256: string;
  locator: string;
  method: string;
  checkedAt: string;
  quote: string;
}

export interface AdditiveOpportunityEvidence {
  school: string;
  scopeId: string;
  officialUrl: string;
  artifactSha256: string;
  fieldEvidence: AdditiveFieldEvidence[];
}

export interface AdditiveApprovalArtifact {
  path: string;
  sha256: string;
  url: string;
  contentType: string;
  fetchedAt: string;
  extractedTextArtifactSha256: string | null;
}

export interface AdditiveDiscoveryScope {
  scopeId: string;
  school: string;
  queue: 'fresh-signal' | 'sentinel' | 'registry-rotation' | 'discovered-child' | 'retry';
  parentScopeId: string | null;
  entryUrl: string;
  checkedAt: string;
  result: 'new-clue' | 'no-new-clue' | 'blocked';
  reason: string | null;
  childScopeIds: string[];
  artifactSha256: string | null;
}

export interface AdditiveCoveragePlan {
  schemaVersion: 1;
  rotationDate: string;
  registrySha256: string;
  sentinelsSha256: string;
}

export interface AdditiveFixedDiscoveryCheck {
  checkId: string;
  url: string;
  checkedAt: string;
  result: 'checked' | 'blocked';
  artifactSha256: string | null;
  reason: string | null;
}

export interface AdditiveApprovalRun {
  schemaVersion: 3;
  runId: string;
  mode: 'incremental' | 'sweep';
  startedAt: string;
  finishedAt: string;
  parent: {
    url: 'https://ddl.meta-mind.cn/data/current.json';
    sha256: string;
    snapshotId: string;
    dataHash: string;
    privateParentCandidateUsed: false;
  };
  coverage: AdditiveCoveragePlan;
  fixedDiscoveryChecks: AdditiveFixedDiscoveryCheck[];
  scopes: AdditiveDiscoveryScope[];
  artifacts: AdditiveApprovalArtifact[];
  additions: Array<{
    opportunity: PublicOpportunity;
    evidence: AdditiveOpportunityEvidence;
  }>;
}

export interface ApproveAdditiveSnapshotFileOptions {
  runPath: string;
  parentPath: string;
  approvedPath: string;
  decisionPath: string;
  approvedAt: string;
  registryPath?: string;
  sentinelsPath?: string;
  nowMs?: number;
}

export type AdditiveApprovalResult =
  | { status: 'no-additions'; runId: string }
  | {
    status: 'ready';
    runId: string;
    snapshotId: string;
    dataHash: string;
    additions: number;
  };

const usage =
  'Usage: snapshot:approve -- --release-dir PATH --approved PATH --pending-current PATH [--approved-at ISO_TIMESTAMP] [--removal-authorization PATH --removal-authorization-sha256 SHA256]';
const sha256Pattern = /^[a-f0-9]{64}$/iu;
const additiveRequiredEvidenceFields = [
  'name',
  'institute',
  'project',
  'eventType',
  'website',
  'verificationStatus',
  'deadline',
  'deadlineOriginal',
  'eventArrangement.time',
  'eventArrangement.formatLocation',
  'materials',
  'recommendation',
  'logistics',
] as const;
const additiveRunMaximumAgeMs = 24 * 60 * 60 * 1000;
const additiveRegistryPath = fileURLToPath(
  new URL('../source/universities.json', import.meta.url),
);
const additiveSentinelsPath = fileURLToPath(
  new URL('../source/priority-sentinels.json', import.meta.url),
);
const additiveInstitutionalHostSuffixes = [
  '.edu.cn',
  '.ac.cn',
  '.edu.hk',
  '.edu.mo',
  '.edu.tw',
  '.cas.cn',
  '.gov.cn',
] as const;
const additiveOfficialPlatformHosts = new Set([
  'mp.weixin.qq.com',
  'yz.chsi.com.cn',
  'yz.chsi.cn',
  'bm.chsi.com.cn',
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function safeError(error: unknown): string {
  return JSON.stringify(error instanceof Error ? error.message : String(error));
}

function exactKeys(object: JsonObject, path: string, keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${path}.${key} is required`);
  }
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function stringAt(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function timestampAt(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path);
  if (!isValidIsoTimestamp(value)) throw new Error(`${path}.${key} must be a valid ISO timestamp`);
  return value;
}

function sha256At(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path).toLowerCase();
  if (!sha256Pattern.test(value)) throw new Error(`${path}.${key} must be a lowercase SHA-256`);
  return value;
}

function normalizeComparableUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${path} must be a valid HTTP(S) URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${path} must not include URL credentials`);
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  url.hash = '';
  if (
    (url.protocol === 'https:' && url.port === '443')
    || (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '');
  url.searchParams.sort();
  return url.toString();
}

function assertAdditiveInstitutionalOfficialUrl(value: string, path: string): string {
  const normalized = normalizeComparableUrl(value, path);
  const hostname = new URL(normalized).hostname;
  if (
    !additiveOfficialPlatformHosts.has(hostname)
    && !additiveInstitutionalHostSuffixes.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error(`${path} must use an institutional official host or an approved official platform`);
  }
  return normalized;
}

function deadlineOriginalSupportsNormalizedDate(original: string, deadline: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(deadline);
  if (match === null) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const escapedYear = String.raw`0*${year}`;
  const escapedMonth = String.raw`0*${month}`;
  const escapedDay = String.raw`0*${day}`;
  const completeDate = new RegExp(
    String.raw`${escapedYear}\s*(?:年|[-./])\s*${escapedMonth}\s*(?:月|[-./])\s*${escapedDay}(?:日)?`,
    'u',
  );
  const monthDay = new RegExp(
    String.raw`${escapedMonth}\s*(?:月|[-./])\s*${escapedDay}(?:日)?`,
    'u',
  );
  return completeDate.test(original) || monthDay.test(original);
}

function parseFieldEvidence(value: unknown, path: string): AdditiveFieldEvidence {
  const object = objectAt(value, path);
  exactKeys(object, path, [
    'field',
    'normalizedValue',
    'sourceUrl',
    'artifactSha256',
    'locator',
    'method',
    'checkedAt',
    'quote',
  ]);
  return {
    field: stringAt(object, 'field', path),
    normalizedValue: stringAt(object, 'normalizedValue', path),
    sourceUrl: stringAt(object, 'sourceUrl', path),
    artifactSha256: sha256At(object, 'artifactSha256', path),
    locator: stringAt(object, 'locator', path),
    method: stringAt(object, 'method', path),
    checkedAt: timestampAt(object, 'checkedAt', path),
    quote: stringAt(object, 'quote', path),
  };
}

function additiveArtifactPathAt(object: JsonObject, path: string): string {
  const artifactPath = stringAt(object, 'path', path);
  if (artifactPath.trim() === '' || artifactPath.includes('\0')) {
    throw new Error(`${path}.path must be a non-empty relative artifact path`);
  }
  if (posix.isAbsolute(artifactPath) || win32.isAbsolute(artifactPath)) {
    throw new Error(`${path}.path must be relative to the additive run directory`);
  }
  if (artifactPath.includes('\\')) {
    throw new Error(`${path}.path must use forward-slash separators`);
  }
  const segments = artifactPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${path}.path must not contain empty, dot, or parent segments`);
  }
  return artifactPath;
}

function additiveMediaType(contentType: string, path: string): string {
  try {
    return new MIMEType(contentType).essence.toLowerCase();
  } catch {
    throw new Error(`${path}.contentType must be a valid MIME type`);
  }
}

function isAdditiveTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/xhtml+xml'
    || mediaType === 'application/xml';
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const epoch = Date.UTC(year, month - 1, day);
  const normalized = new Date(epoch);
  return (
    normalized.getUTCFullYear() === year
    && normalized.getUTCMonth() === month - 1
    && normalized.getUTCDate() === day
  );
}

function coverageAt(object: JsonObject, path: string): AdditiveCoveragePlan {
  const coverage = objectAt(object.coverage, `${path}.coverage`);
  exactKeys(coverage, `${path}.coverage`, [
    'schemaVersion',
    'rotationDate',
    'registrySha256',
    'sentinelsSha256',
  ]);
  if (coverage.schemaVersion !== 1) {
    throw new Error(`${path}.coverage.schemaVersion must equal 1`);
  }
  const rotationDate = stringAt(coverage, 'rotationDate', `${path}.coverage`);
  if (!validCalendarDate(rotationDate)) {
    throw new Error(`${path}.coverage.rotationDate must be a valid YYYY-MM-DD calendar date`);
  }
  return {
    schemaVersion: 1,
    rotationDate,
    registrySha256: sha256At(coverage, 'registrySha256', `${path}.coverage`),
    sentinelsSha256: sha256At(coverage, 'sentinelsSha256', `${path}.coverage`),
  };
}

function fixedDiscoveryChecksAt(
  object: JsonObject,
  path: string,
): AdditiveFixedDiscoveryCheck[] {
  if (!Array.isArray(object.fixedDiscoveryChecks)) {
    throw new Error(`${path}.fixedDiscoveryChecks must be an array`);
  }
  return object.fixedDiscoveryChecks.map((value, index) => {
    const checkPath = `${path}.fixedDiscoveryChecks[${index}]`;
    const check = objectAt(value, checkPath);
    exactKeys(check, checkPath, [
      'checkId',
      'url',
      'checkedAt',
      'result',
      'artifactSha256',
      'reason',
    ]);
    const artifactSha256 = check.artifactSha256;
    if (artifactSha256 !== null && typeof artifactSha256 !== 'string') {
      throw new Error(`${checkPath}.artifactSha256 must be a SHA-256 string or null`);
    }
    const reason = check.reason;
    if (reason !== null && typeof reason !== 'string') {
      throw new Error(`${checkPath}.reason must be a string or null`);
    }
    return {
      checkId: stringAt(check, 'checkId', checkPath),
      url: stringAt(check, 'url', checkPath),
      checkedAt: timestampAt(check, 'checkedAt', checkPath),
      result: stringAt(check, 'result', checkPath) as AdditiveFixedDiscoveryCheck['result'],
      artifactSha256: artifactSha256 === null
        ? null
        : sha256At(check, 'artifactSha256', checkPath),
      reason,
    };
  });
}

function parseAdditiveRun(value: unknown): AdditiveApprovalRun {
  const object = objectAt(value, 'discovery run');
  exactKeys(object, 'discovery run', [
    'schemaVersion',
    'runId',
    'mode',
    'startedAt',
    'finishedAt',
    'parent',
    'coverage',
    'fixedDiscoveryChecks',
    'scopes',
    'artifacts',
    'additions',
  ]);
  if (object.schemaVersion !== 3) {
    throw new Error('discovery run.schemaVersion must equal 3');
  }
  const runId = stringAt(object, 'runId', 'discovery run');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(runId)) {
    throw new Error('discovery run.runId has an unsafe format');
  }
  const mode = stringAt(object, 'mode', 'discovery run');
  if (mode !== 'incremental' && mode !== 'sweep') {
    throw new Error('discovery run.mode must be incremental or sweep');
  }
  const startedAt = timestampAt(object, 'startedAt', 'discovery run');
  const finishedAt = timestampAt(object, 'finishedAt', 'discovery run');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('discovery run.finishedAt must not precede startedAt');
  }

  const parentObject = objectAt(object.parent, 'discovery run.parent');
  exactKeys(parentObject, 'discovery run.parent', [
    'url',
    'sha256',
    'snapshotId',
    'dataHash',
    'privateParentCandidateUsed',
  ]);
  const url = stringAt(parentObject, 'url', 'discovery run.parent');
  if (url !== 'https://ddl.meta-mind.cn/data/current.json') {
    throw new Error('discovery run.parent.url must be the public current.json endpoint');
  }
  if (parentObject.privateParentCandidateUsed !== false) {
    throw new Error('discovery run.parent.privateParentCandidateUsed must be false');
  }
  const parent: AdditiveApprovalRun['parent'] = {
    url,
    sha256: sha256At(parentObject, 'sha256', 'discovery run.parent'),
    snapshotId: stringAt(parentObject, 'snapshotId', 'discovery run.parent'),
    dataHash: sha256At(parentObject, 'dataHash', 'discovery run.parent'),
    privateParentCandidateUsed: false,
  };
  const coverage = coverageAt(object, 'discovery run');
  const fixedDiscoveryChecks = fixedDiscoveryChecksAt(object, 'discovery run');

  if (!Array.isArray(object.scopes)) throw new Error('discovery run.scopes must be an array');
  const scopes = object.scopes.map((value, index) => {
    const path = `discovery run.scopes[${index}]`;
    const scope = objectAt(value, path);
    exactKeys(scope, path, [
      'scopeId',
      'school',
      'queue',
      'parentScopeId',
      'entryUrl',
      'checkedAt',
      'result',
      'reason',
      'childScopeIds',
      'artifactSha256',
    ]);
    const parentScopeId = scope.parentScopeId;
    if (parentScopeId !== null && typeof parentScopeId !== 'string') {
      throw new Error(`${path}.parentScopeId must be a string or null`);
    }
    const reason = scope.reason;
    if (reason !== null && typeof reason !== 'string') {
      throw new Error(`${path}.reason must be a string or null`);
    }
    const artifactSha256 = scope.artifactSha256;
    if (artifactSha256 !== null && typeof artifactSha256 !== 'string') {
      throw new Error(`${path}.artifactSha256 must be a SHA-256 string or null`);
    }
    if (!Array.isArray(scope.childScopeIds) || scope.childScopeIds.some((child) => typeof child !== 'string')) {
      throw new Error(`${path}.childScopeIds must be an array of strings`);
    }
    return {
      scopeId: stringAt(scope, 'scopeId', path),
      school: stringAt(scope, 'school', path),
      queue: stringAt(scope, 'queue', path) as AdditiveDiscoveryScope['queue'],
      parentScopeId,
      entryUrl: stringAt(scope, 'entryUrl', path),
      checkedAt: timestampAt(scope, 'checkedAt', path),
      result: stringAt(scope, 'result', path) as AdditiveDiscoveryScope['result'],
      reason,
      childScopeIds: [...scope.childScopeIds],
      artifactSha256: artifactSha256 === null ? null : sha256At(scope, 'artifactSha256', path),
    };
  });

  if (!Array.isArray(object.artifacts)) throw new Error('discovery run.artifacts must be an array');
  const artifacts = object.artifacts.map((value, index) => {
    const path = `discovery run.artifacts[${index}]`;
    const artifact = objectAt(value, path);
    exactKeys(artifact, path, [
      'path',
      'sha256',
      'url',
      'contentType',
      'fetchedAt',
      'extractedTextArtifactSha256',
    ]);
    const extractedTextArtifactSha256 = artifact.extractedTextArtifactSha256;
    if (
      extractedTextArtifactSha256 !== null
      && typeof extractedTextArtifactSha256 !== 'string'
    ) {
      throw new Error(`${path}.extractedTextArtifactSha256 must be a SHA-256 string or null`);
    }
    return {
      path: additiveArtifactPathAt(artifact, path),
      sha256: sha256At(artifact, 'sha256', path),
      url: stringAt(artifact, 'url', path),
      contentType: stringAt(artifact, 'contentType', path),
      fetchedAt: timestampAt(artifact, 'fetchedAt', path),
      extractedTextArtifactSha256: extractedTextArtifactSha256 === null
        ? null
        : sha256At(artifact, 'extractedTextArtifactSha256', path),
    };
  });

  if (!Array.isArray(object.additions)) throw new Error('discovery run.additions must be an array');
  const additions = object.additions.map((value, index) => {
    const path = `discovery run.additions[${index}]`;
    const addition = objectAt(value, path);
    exactKeys(addition, path, ['opportunity', 'evidence']);
    const evidenceObject = objectAt(addition.evidence, `${path}.evidence`);
    exactKeys(evidenceObject, `${path}.evidence`, [
      'school',
      'scopeId',
      'officialUrl',
      'artifactSha256',
      'fieldEvidence',
    ]);
    if (!Array.isArray(evidenceObject.fieldEvidence)) {
      throw new Error(`${path}.evidence.fieldEvidence must be an array`);
    }
    return {
      opportunity: addition.opportunity as PublicOpportunity,
      evidence: {
        school: stringAt(evidenceObject, 'school', `${path}.evidence`),
        scopeId: stringAt(evidenceObject, 'scopeId', `${path}.evidence`),
        officialUrl: stringAt(evidenceObject, 'officialUrl', `${path}.evidence`),
        artifactSha256: sha256At(evidenceObject, 'artifactSha256', `${path}.evidence`),
        fieldEvidence: evidenceObject.fieldEvidence.map((entry, fieldIndex) =>
          parseFieldEvidence(entry, `${path}.evidence.fieldEvidence[${fieldIndex}]`)),
      },
    };
  });

  return {
    schemaVersion: 3,
    runId,
    mode,
    startedAt,
    finishedAt,
    parent,
    coverage,
    fixedDiscoveryChecks,
    scopes,
    artifacts,
    additions,
  };
}

const additiveScopeQueues = new Set<AdditiveDiscoveryScope['queue']>([
  'fresh-signal',
  'sentinel',
  'registry-rotation',
  'discovered-child',
  'retry',
]);
const additiveScopeResults = new Set<AdditiveDiscoveryScope['result']>([
  'new-clue',
  'no-new-clue',
  'blocked',
]);

function assertScopeManifest(run: AdditiveApprovalRun): void {
  if (run.scopes.length === 0) {
    throw new Error('additive discovery run scope manifest must not be empty');
  }
  const startedAtMs = Date.parse(run.startedAt);
  const finishedAtMs = Date.parse(run.finishedAt);
  const artifacts = new Map<string, AdditiveApprovalArtifact>();
  const artifactPaths = new Set<string>();
  for (const artifact of run.artifacts) {
    if (artifacts.has(artifact.sha256)) {
      throw new Error('additive discovery run artifacts must not reuse a SHA-256');
    }
    if (artifactPaths.has(artifact.path)) {
      throw new Error('additive discovery run artifacts must not reuse an artifact path');
    }
    artifactPaths.add(artifact.path);
    normalizeComparableUrl(artifact.url, 'additive artifact URL');
    additiveMediaType(artifact.contentType, 'additive artifact');
    const fetchedAtMs = Date.parse(artifact.fetchedAt);
    if (fetchedAtMs < startedAtMs || fetchedAtMs > finishedAtMs) {
      throw new Error('additive discovery artifact must be fetched within the run window');
    }
    artifacts.set(artifact.sha256, artifact);
  }

  for (const artifact of run.artifacts) {
    if (artifact.extractedTextArtifactSha256 === null) continue;
    const extractedTextArtifact = artifacts.get(artifact.extractedTextArtifactSha256);
    if (extractedTextArtifact === undefined) {
      throw new Error('additive artifact extracted text artifact is missing');
    }
    if (extractedTextArtifact.sha256 === artifact.sha256) {
      throw new Error('additive artifact must not declare itself as extracted text');
    }
    if (!isAdditiveTextMediaType(additiveMediaType(extractedTextArtifact.contentType, 'extracted text artifact'))) {
      throw new Error('additive artifact extracted text artifact must have a text content type');
    }
    if (extractedTextArtifact.extractedTextArtifactSha256 !== null) {
      throw new Error('additive artifact extracted text artifact must not chain another extraction');
    }
    if (
      normalizeComparableUrl(extractedTextArtifact.url, 'extracted text artifact URL')
      !== normalizeComparableUrl(artifact.url, 'additive artifact URL')
    ) {
      throw new Error('additive artifact extracted text artifact must retain the same source URL');
    }
  }

  const scopes = new Map<string, AdditiveDiscoveryScope>();
  for (const scope of run.scopes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(scope.scopeId)) {
      throw new Error('additive discovery scopeId has an unsafe format');
    }
    if (scopes.has(scope.scopeId)) {
      throw new Error(`additive discovery scope ${quoted(scope.scopeId)} is duplicated`);
    }
    if (!additiveScopeQueues.has(scope.queue)) {
      throw new Error(`additive discovery scope ${quoted(scope.scopeId)} has an unsupported queue`);
    }
    if (!additiveScopeResults.has(scope.result)) {
      throw new Error(`additive discovery scope ${quoted(scope.scopeId)} has an unsupported result`);
    }
    normalizeComparableUrl(scope.entryUrl, 'additive discovery scope entryUrl');
    const checkedAtMs = Date.parse(scope.checkedAt);
    if (checkedAtMs < startedAtMs || checkedAtMs > finishedAtMs) {
      throw new Error(`additive discovery scope ${quoted(scope.scopeId)} was checked outside the run window`);
    }
    if (scope.result === 'blocked') {
      if (scope.reason === null || scope.reason.trim() === '') {
        throw new Error(`blocked scope ${quoted(scope.scopeId)} must retain a non-empty reason`);
      }
    } else {
      if (scope.reason !== null) {
        throw new Error(`non-blocked scope ${quoted(scope.scopeId)} must not carry a blocked reason`);
      }
      if (scope.artifactSha256 === null) {
        throw new Error(`read scope ${quoted(scope.scopeId)} must reference an artifact`);
      }
    }
    if (scope.artifactSha256 !== null) {
      const artifact = artifacts.get(scope.artifactSha256);
      if (artifact === undefined) {
        throw new Error(`scope ${quoted(scope.scopeId)} references a missing artifact`);
      }
      if (
        normalizeComparableUrl(scope.entryUrl, 'additive discovery scope entryUrl')
        !== normalizeComparableUrl(artifact.url, 'additive discovery artifact URL')
      ) {
        throw new Error(`scope ${quoted(scope.scopeId)} artifact must match its entryUrl`);
      }
    }
    const childIds = new Set<string>();
    for (const childId of scope.childScopeIds) {
      if (childIds.has(childId)) {
        throw new Error(`scope ${quoted(scope.scopeId)} repeats a child scope`);
      }
      childIds.add(childId);
    }
    scopes.set(scope.scopeId, scope);
  }

  for (const scope of run.scopes) {
    if (scope.parentScopeId !== null) {
      const parent = scopes.get(scope.parentScopeId);
      if (parent === undefined) {
        throw new Error(`scope ${quoted(scope.scopeId)} has a missing parent scope`);
      }
      if (parent.school !== scope.school || !parent.childScopeIds.includes(scope.scopeId)) {
        throw new Error(`scope ${quoted(scope.scopeId)} is not closed against its parent scope`);
      }
    }
    for (const childScopeId of scope.childScopeIds) {
      const child = scopes.get(childScopeId);
      if (child === undefined || child.parentScopeId !== scope.scopeId) {
        throw new Error(`scope ${quoted(scope.scopeId)} is not closed against a child scope`);
      }
    }
    const ancestors = new Set<string>();
    let current: AdditiveDiscoveryScope | undefined = scope;
    while (current !== undefined) {
      if (ancestors.has(current.scopeId)) {
        throw new Error(`scope ${quoted(scope.scopeId)} has a parent cycle`);
      }
      ancestors.add(current.scopeId);
      current = current.parentScopeId === null ? undefined : scopes.get(current.parentScopeId);
    }
  }
}

interface AdditiveCoverageSummary {
  rotationDate: string;
  rotationSlot: number;
  registryTargetCount: number;
  parentExtraTargetCount: number;
  sentinelSchools: string[];
  rotationSchools: string[];
  blockedScopeIds: string[];
}

function additiveRegistrySchoolName(value: string): string {
  const match = value.match(/^[^A-Za-z/]+/u);
  return (match?.[0] ?? value.split('/')[0]).trim();
}

function beijingCalendarDate(timestamp: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Date.parse(timestamp)));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('could not derive Beijing coverage date');
  }
  return `${year}-${month}-${day}`;
}

const additiveFixedDiscoveryCheckIds = [
  'shenyanpai-profile',
  'shenyanpai-summer-camp',
  'shenyanpai-pre-recommend',
] as const;

function expectedAdditiveFixedDiscoveryUrl(checkId: string, finishedAt: string): string {
  const year = beijingCalendarDate(finishedAt).slice(0, 4);
  switch (checkId) {
    case 'shenyanpai-profile':
      return 'https://github.com/shenyanpai';
    case 'shenyanpai-summer-camp':
      return `https://github.com/shenyanpai/awesome-summer-camp-${year}`;
    case 'shenyanpai-pre-recommend':
      return `https://github.com/shenyanpai/awesome-pre-recommend-${year}`;
    default:
      throw new Error(`unsupported fixed discovery check ${quoted(checkId)}`);
  }
}

function assertAdditiveFixedDiscoveryChecks(
  run: AdditiveApprovalRun,
  artifactMaterials: ReadonlyMap<string, AdditiveArtifactMaterial>,
): void {
  if (run.fixedDiscoveryChecks.length !== additiveFixedDiscoveryCheckIds.length) {
    throw new Error('fixed discovery checks must contain exactly three required check IDs');
  }
  const checks = new Map<string, AdditiveFixedDiscoveryCheck>();
  for (const check of run.fixedDiscoveryChecks) {
    if (!(additiveFixedDiscoveryCheckIds as readonly string[]).includes(check.checkId)) {
      throw new Error(`fixed discovery check ${quoted(check.checkId)} is unexpected`);
    }
    if (checks.has(check.checkId)) {
      throw new Error(`fixed discovery check ${quoted(check.checkId)} is duplicated`);
    }
    checks.set(check.checkId, check);
  }

  const startedAtMs = Date.parse(run.startedAt);
  const finishedAtMs = Date.parse(run.finishedAt);
  const checkedArtifactSha256s = new Set<string>();
  for (const checkId of additiveFixedDiscoveryCheckIds) {
    const check = checks.get(checkId);
    if (check === undefined) {
      throw new Error(`fixed discovery check ${quoted(checkId)} is missing`);
    }
    const expectedUrl = expectedAdditiveFixedDiscoveryUrl(check.checkId, run.finishedAt);
    const checkUrl = normalizeComparableUrl(
      check.url,
      `fixed discovery check ${quoted(check.checkId)} URL`,
    );
    if (checkUrl !== expectedUrl) {
      throw new Error(
        `fixed discovery check ${quoted(check.checkId)} URL must match ${quoted(expectedUrl)}`,
      );
    }
    const checkedAtMs = Date.parse(check.checkedAt);
    if (checkedAtMs < startedAtMs || checkedAtMs > finishedAtMs) {
      throw new Error(
        `fixed discovery check ${quoted(check.checkId)} was checked outside the run window`,
      );
    }
    if (check.result === 'checked') {
      if (check.artifactSha256 === null) {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} with result checked must reference an artifact`,
        );
      }
      if (check.reason !== null) {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} with result checked must have a null reason`,
        );
      }
      if (checkedArtifactSha256s.has(check.artifactSha256)) {
        throw new Error(
          `fixed discovery checks with result checked must not reuse an artifact SHA-256`,
        );
      }
      const material = artifactMaterials.get(check.artifactSha256);
      if (material === undefined) {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} references a missing artifact`,
        );
      }
      const artifactUrl = normalizeComparableUrl(
        material.artifact.url,
        `fixed discovery check ${quoted(check.checkId)} artifact URL`,
      );
      if (artifactUrl !== expectedUrl) {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} artifact URL must match ${quoted(expectedUrl)}`,
        );
      }
      if (material.text === null || material.text.trim() === '') {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} must bind a non-empty readable UTF-8 text artifact`,
        );
      }
      checkedArtifactSha256s.add(check.artifactSha256);
      continue;
    }
    if (check.result === 'blocked') {
      if (check.artifactSha256 !== null) {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} with result blocked must not reference an artifact`,
        );
      }
      if (check.reason === null || check.reason.trim() === '') {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} with result blocked must retain a non-empty reason`,
        );
      }
      continue;
    }
    throw new Error(`fixed discovery check ${quoted(check.checkId)} has an unsupported result`);
  }
}

const additiveGitHubDiscoveryTextPattern = /github\.com|raw\.githubusercontent\.com/iu;
const additiveProvenanceDecodeDepth = 4;
const additivePercentByteRunPattern = /(?:%[0-9A-Fa-f]{2})+/gu;
const additiveIdnaEquivalentDotPattern = /[\u3002\uFF0E\uFF61]/gu;
const additiveUnicodeEscapePattern = /\\{1,2}u(?:([0-9A-Fa-f]{4})|\{([0-9A-Fa-f]{1,6})\})/gu;

function additiveFixedDiscoveryPrivateValues(
  run: AdditiveApprovalRun,
  artifactMaterials: ReadonlyMap<string, AdditiveArtifactMaterial>,
): ReadonlySet<string> {
  const values = new Set<string>();
  for (const check of run.fixedDiscoveryChecks) {
    values.add(check.checkId);
    values.add(expectedAdditiveFixedDiscoveryUrl(check.checkId, run.finishedAt));
    if (check.artifactSha256 !== null) {
      values.add(check.artifactSha256);
      const material = artifactMaterials.get(check.artifactSha256);
      if (material === undefined || material.text === null) {
        throw new Error(
          `fixed discovery check ${quoted(check.checkId)} must bind a readable UTF-8 text artifact`,
        );
      }
      // Empty text has no bytes to disclose; matching it would make every serialized addition fail.
      if (material.text !== '') values.add(material.text);
    }
    if (check.reason !== null) values.add(check.reason);
  }
  return values;
}

function serializedAdditiveString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function decodeAdditivePercentByteRuns(value: string): string {
  return value.replace(additivePercentByteRunPattern, (percentBytes) => {
    try {
      return decodeURIComponent(percentBytes);
    } catch {
      return percentBytes;
    }
  });
}

function decodeAdditiveUnicodeEscapes(value: string): string {
  return value.replace(additiveUnicodeEscapePattern, (escape, fixedWidth, braced) => {
    const codePoint = Number.parseInt(fixedWidth ?? braced, 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
  });
}

function normalizeAdditiveProvenanceText(value: string): string {
  return value.normalize('NFKC').replace(additiveIdnaEquivalentDotPattern, '.');
}

interface AdditiveProvenanceCandidates {
  candidates: readonly string[];
  nestedPercentEncoding: boolean;
}

function additiveHostDetectionCandidates(serializedContent: string): AdditiveProvenanceCandidates {
  const candidates = new Set<string>([serializedContent]);
  const addNormalizedCandidates = (value: string): string => {
    const unicodeDecoded = decodeAdditiveUnicodeEscapes(value);
    candidates.add(unicodeDecoded);
    const nfkc = unicodeDecoded.normalize('NFKC');
    candidates.add(nfkc);
    const normalized = normalizeAdditiveProvenanceText(unicodeDecoded);
    candidates.add(normalized);
    return normalized;
  };
  let current = addNormalizedCandidates(serializedContent);
  for (let depth = 0; depth < additiveProvenanceDecodeDepth; depth += 1) {
    const decoded = decodeAdditivePercentByteRuns(current);
    if (decoded === current) {
      return { candidates: [...candidates], nestedPercentEncoding: false };
    }
    candidates.add(decoded);
    current = addNormalizedCandidates(decoded);
  }
  return {
    candidates: [...candidates],
    nestedPercentEncoding: decodeAdditivePercentByteRuns(current) !== current,
  };
}

function assertAdditivePublicProvenance(
  opportunity: PublicOpportunity,
  fixedDiscoveryPrivateValues: ReadonlySet<string>,
): void {
  const serializedOpportunity = JSON.stringify(opportunity);
  const provenanceCandidates = additiveHostDetectionCandidates(serializedOpportunity);
  if (provenanceCandidates.nestedPercentEncoding) {
    throw new Error(
      `addition ${quoted(opportunity.projectId)} nested percent encoding exceeds supported depth`,
    );
  }
  const { candidates } = provenanceCandidates;
  if (
    candidates.some((candidate) => additiveGitHubDiscoveryTextPattern.test(candidate))
    || [...fixedDiscoveryPrivateValues].some((value) =>
      candidates.some((candidate) =>
        candidate.includes(value) || candidate.includes(serializedAdditiveString(value))))
  ) {
    throw new Error(
      `addition ${quoted(opportunity.projectId)} must not expose fixed discovery provenance`,
    );
  }
}

const additiveUmbrellaInstituteSubstrings = [
  'whole-school',
  'wholeschool',
  '全校',
  '全院系',
  '各学院',
  '各院系',
  '校级',
  '招生系统',
  '报名系统',
  '系统级',
] as const;

function normalizeAdditiveInstituteLabel(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

function assertAdditiveCollegeGranularity(opportunity: PublicOpportunity): void {
  const projectIdParts = opportunity.projectId.split('|');
  if (projectIdParts.length !== 4 || projectIdParts.some((part) => part.trim() === '')) {
    throw new Error(
      `addition ${quoted(opportunity.projectId)} projectId must use cycle|name|institute|project/round`,
    );
  }
  const [, projectIdName, projectIdInstitute] = projectIdParts;
  if (projectIdName !== opportunity.name) {
    throw new Error(
      `addition ${quoted(opportunity.projectId)} projectId name segment must exactly match opportunity name`,
    );
  }
  if (projectIdInstitute !== opportunity.institute) {
    throw new Error(
      `addition ${quoted(opportunity.projectId)} projectId institute segment must exactly match opportunity institute`,
    );
  }
  const normalizedInstitute = normalizeAdditiveInstituteLabel(opportunity.institute);
  if (additiveUmbrellaInstituteSubstrings.some((label) => normalizedInstitute.includes(label))) {
    throw new Error(
      `addition ${quoted(opportunity.projectId)} institute must name a concrete college-level unit`,
    );
  }
}

function additiveRotationDateSlot(rotationDate: string): number {
  const [yearText, monthText, dayText] = rotationDate.split('-');
  const epochDay = Math.floor(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)) / 86_400_000,
  );
  return ((epochDay % 7) + 7) % 7;
}

function additiveRotationTargetSlot(school: string): number {
  return createHash('sha256')
    .update('cs-ddl-additive-rotation-v1\0', 'utf8')
    .update(school, 'utf8')
    .digest()
    .readUInt32BE(0) % 7;
}

function codePointUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(codePointCompare);
}

function assertAdditiveCoverage(
  run: AdditiveApprovalRun,
  parent: PublicSnapshot,
  registryFile: RegularJsonFile,
  sentinelsFile: RegularJsonFile,
): AdditiveCoverageSummary {
  if (bytesHash(registryFile.text) !== run.coverage.registrySha256) {
    throw new Error('frozen institution registry bytes do not match the discovery run coverage header');
  }
  if (bytesHash(sentinelsFile.text) !== run.coverage.sentinelsSha256) {
    throw new Error('frozen priority sentinels bytes do not match the discovery run coverage header');
  }
  const expectedDate = beijingCalendarDate(run.finishedAt);
  if (run.coverage.rotationDate !== expectedDate) {
    throw new Error('discovery run coverage.rotationDate must equal finishedAt in Asia/Shanghai');
  }
  const registrySchools = codePointUnique(
    parseRegistryInstitutions(registryFile.value).map((institution) =>
      additiveRegistrySchoolName(institution.name)),
  );
  if (registrySchools.some((school) => school === '')) {
    throw new Error('institution registry contains an empty canonical school name');
  }
  const registrySet = new Set(registrySchools);
  const parentExtraSchools = codePointUnique(
    parent.opportunities
      .map((opportunity) => opportunity.name)
      .filter((school) => !registrySet.has(school)),
  );
  const rotationUniverse = codePointUnique([...registrySchools, ...parentExtraSchools]);
  const sentinels = parsePrioritySentinels(sentinelsFile.value);
  if (sentinels.cycle !== '2027') {
    throw new Error('priority sentinels must match the active 2027 admissions cycle');
  }
  const sentinelSchools = codePointUnique(sentinels.institutions.map((item) => item.school));
  const roots = run.scopes.filter((scope) => scope.parentScopeId === null);
  const hasRootScope = (school: string, queues: ReadonlySet<AdditiveDiscoveryScope['queue']>) =>
    roots.some((scope) => scope.school === school && queues.has(scope.queue));
  for (const school of sentinelSchools) {
    if (!hasRootScope(school, new Set(['sentinel']))) {
      throw new Error(`discovery run is missing priority sentinel root scope ${quoted(school)}`);
    }
  }
  const rotationSlot = additiveRotationDateSlot(run.coverage.rotationDate);
  const rotationSchools = run.mode === 'sweep'
    ? rotationUniverse
    : rotationUniverse.filter((school) => additiveRotationTargetSlot(school) === rotationSlot);
  for (const school of rotationSchools) {
    if (!hasRootScope(school, new Set(['registry-rotation', 'sentinel']))) {
      throw new Error(`discovery run is missing required registry rotation root scope ${quoted(school)}`);
    }
  }
  return {
    rotationDate: run.coverage.rotationDate,
    rotationSlot,
    registryTargetCount: registrySchools.length,
    parentExtraTargetCount: parentExtraSchools.length,
    sentinelSchools,
    rotationSchools,
    blockedScopeIds: roots
      .filter((scope) => scope.result === 'blocked')
      .map((scope) => scope.scopeId)
      .sort(codePointCompare),
  };
}

interface AdditiveFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface AdditiveArtifactRoot {
  originalPath: string;
  resolvedPath: string;
  identity: AdditiveFileIdentity;
}

interface AdditiveArtifactPathEntry {
  path: string;
  displayPath: string;
  type: 'directory' | 'file';
  identity: AdditiveFileIdentity;
}

interface AdditiveBoundArtifactPath {
  path: string;
  entries: AdditiveArtifactPathEntry[];
}

interface AdditiveArtifactMaterial {
  artifact: AdditiveApprovalArtifact;
  text: string | null;
}

function additiveFileIdentity(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): AdditiveFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function sameAdditiveFileIdentity(
  stat: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  },
  expected: AdditiveFileIdentity,
): boolean {
  return (
    stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs
  );
}

async function lstatAdditiveArtifactPath(
  path: string,
  changedMessage: string,
): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    throw new Error(changedMessage, { cause: error });
  }
}

async function assertAdditiveArtifactRootUnchanged(root: AdditiveArtifactRoot): Promise<void> {
  const changedMessage = 'additive artifact root changed during read';
  const original = await lstatAdditiveArtifactPath(root.originalPath, changedMessage);
  if (
    original.isSymbolicLink()
    || !original.isDirectory()
    || !sameAdditiveFileIdentity(original, root.identity)
  ) {
    throw new Error(changedMessage);
  }
  const resolved = await lstatAdditiveArtifactPath(root.resolvedPath, changedMessage);
  if (
    resolved.isSymbolicLink()
    || !resolved.isDirectory()
    || !sameAdditiveFileIdentity(resolved, root.identity)
  ) {
    throw new Error(changedMessage);
  }
}

async function resolveAdditiveArtifactRoot(runPath: string): Promise<AdditiveArtifactRoot> {
  const originalPath = dirname(runPath);
  const information = await lstat(originalPath);
  if (information.isSymbolicLink()) {
    throw new Error('additive artifact root must not be a symbolic link');
  }
  if (!information.isDirectory()) {
    throw new Error('additive artifact root must be a directory');
  }
  const root: AdditiveArtifactRoot = {
    originalPath,
    resolvedPath: await realpath(originalPath),
    identity: additiveFileIdentity(information),
  };
  await assertAdditiveArtifactRootUnchanged(root);
  return root;
}

async function resolveAdditiveArtifactPath(
  root: AdditiveArtifactRoot,
  artifact: AdditiveApprovalArtifact,
): Promise<AdditiveBoundArtifactPath> {
  await assertAdditiveArtifactRootUnchanged(root);
  const entries: AdditiveArtifactPathEntry[] = [];
  let currentPath = root.resolvedPath;
  const segments = artifact.path.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = join(currentPath, segments[index]);
    const displayPath = segments.slice(0, index + 1).join('/');
    const information = await lstat(currentPath);
    if (information.isSymbolicLink()) {
      throw new Error(`additive artifact ${displayPath} must not be a symbolic link`);
    }
    if (index < segments.length - 1 && !information.isDirectory()) {
      throw new Error(`additive artifact path ${displayPath} must be a directory`);
    }
    if (index === segments.length - 1 && !information.isFile()) {
      throw new Error(`additive artifact ${artifact.path} must be a regular file`);
    }
    entries.push({
      path: currentPath,
      displayPath,
      type: index < segments.length - 1 ? 'directory' : 'file',
      identity: additiveFileIdentity(information),
    });
  }
  return { path: currentPath, entries };
}

async function assertAdditiveArtifactPathUnchanged(
  root: AdditiveArtifactRoot,
  path: AdditiveBoundArtifactPath,
  artifact: AdditiveApprovalArtifact,
): Promise<void> {
  await assertAdditiveArtifactRootUnchanged(root);
  for (const entry of path.entries) {
    const changedMessage = entry.type === 'file'
      ? `additive artifact ${artifact.path} changed during read`
      : `additive artifact path ${entry.displayPath} changed during read`;
    const information = await lstatAdditiveArtifactPath(entry.path, changedMessage);
    const expectedType = entry.type === 'file'
      ? information.isFile()
      : information.isDirectory();
    if (
      information.isSymbolicLink()
      || !expectedType
      || !sameAdditiveFileIdentity(information, entry.identity)
    ) {
      throw new Error(changedMessage);
    }
  }
}

async function readAdditiveArtifactMaterial(
  root: AdditiveArtifactRoot,
  artifact: AdditiveApprovalArtifact,
): Promise<AdditiveArtifactMaterial> {
  const artifactPath = await resolveAdditiveArtifactPath(root, artifact);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(artifactPath.path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const fileEntry = artifactPath.entries[artifactPath.entries.length - 1];
    if (!opened.isFile() || !sameAdditiveFileIdentity(opened, fileEntry.identity)) {
      throw new Error(`additive artifact ${artifact.path} changed during read`);
    }
    const openedIdentity = additiveFileIdentity(opened);
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      !afterRead.isFile()
      || !sameAdditiveFileIdentity(afterRead, openedIdentity)
      || bytes.byteLength !== openedIdentity.size
    ) {
      throw new Error(`additive artifact ${artifact.path} changed during read`);
    }
    await assertAdditiveArtifactPathUnchanged(root, artifactPath, artifact);
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== artifact.sha256) {
      throw new Error(`additive artifact ${artifact.path} SHA-256 does not match its declared digest`);
    }
    const mediaType = additiveMediaType(artifact.contentType, `additive artifact ${artifact.path}`);
    let text: string | null = null;
    if (isAdditiveTextMediaType(mediaType)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`additive text artifact ${artifact.path} is not valid UTF-8`);
      }
    } else if (mediaType === 'application/pdf') {
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))) {
        throw new Error(`additive PDF artifact ${artifact.path} is missing the PDF signature`);
      }
    }
    return { artifact, text };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readAndVerifyAdditiveArtifacts(
  runPath: string,
  run: AdditiveApprovalRun,
): Promise<Map<string, AdditiveArtifactMaterial>> {
  const root = await resolveAdditiveArtifactRoot(runPath);
  const materials = new Map<string, AdditiveArtifactMaterial>();
  for (const artifact of run.artifacts) {
    const material = await readAdditiveArtifactMaterial(root, artifact);
    if (materials.has(artifact.sha256)) {
      throw new Error('additive discovery run artifacts must not reuse a SHA-256');
    }
    materials.set(artifact.sha256, material);
  }
  for (const material of materials.values()) {
    const extractedTextSha256 = material.artifact.extractedTextArtifactSha256;
    if (extractedTextSha256 === null) continue;
    const extractedText = materials.get(extractedTextSha256);
    if (extractedText === undefined || extractedText.text === null) {
      throw new Error(`additive artifact ${material.artifact.path} extracted text is not file-backed UTF-8 text`);
    }
  }
  return materials;
}

function countRows(opportunities: PublicOpportunity[]): SnapshotCandidate['counts'] {
  return {
    confirmedOpen: opportunities.filter((row) => row.verificationStatus === 'confirmed-open').length,
    confirmedUnknownDeadline: opportunities.filter(
      (row) => row.verificationStatus === 'confirmed-unknown-deadline',
    ).length,
    pendingExcluded: 0,
    expired: opportunities.filter((row) => row.verificationStatus === 'expired').length,
  };
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const commonLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function compareRows(left: PublicOpportunity, right: PublicOpportunity): number {
  const rank = (row: PublicOpportunity): number => {
    if (row.verificationStatus === 'confirmed-open') return 0;
    if (row.verificationStatus === 'confirmed-unknown-deadline') return 1;
    return 2;
  };
  const rankDifference = rank(left) - rank(right);
  if (rankDifference !== 0) return rankDifference;
  if (
    left.verificationStatus === 'confirmed-open'
    && right.verificationStatus === 'confirmed-open'
    && left.deadlineEpochMs !== right.deadlineEpochMs
  ) {
    return (left.deadlineEpochMs ?? Number.POSITIVE_INFINITY)
      - (right.deadlineEpochMs ?? Number.POSITIVE_INFINITY);
  }
  return codePointCompare(left.projectId, right.projectId);
}

function additiveFieldValue(opportunity: PublicOpportunity, field: string): unknown {
  switch (field) {
    case 'name': return opportunity.name;
    case 'institute': return opportunity.institute;
    case 'project': return opportunity.project;
    case 'eventType': return opportunity.eventType;
    case 'website': return opportunity.website;
    case 'verificationStatus': return opportunity.verificationStatus;
    case 'deadline': return opportunity.deadline;
    case 'deadlineOriginal': return opportunity.deadlineOriginal;
    case 'eventArrangement.time': return opportunity.eventArrangement.time;
    case 'eventArrangement.formatLocation': return opportunity.eventArrangement.formatLocation;
    case 'materials': return opportunity.materials;
    case 'recommendation': return opportunity.recommendation;
    case 'logistics': return opportunity.logistics;
    default: throw new Error(`unknown field evidence ${quoted(field)}`);
  }
}

function additiveFieldQuoteSourceValue(
  opportunity: PublicOpportunity,
  field: string,
): string | null {
  switch (field) {
    case 'name': return opportunity.name;
    case 'institute': return opportunity.institute;
    case 'project': return opportunity.project;
    case 'eventType': return opportunity.eventType;
    // The URL itself is proven by the exact source/artifact URL binding below.
    case 'website': return null;
    // Verification status is a derived public classification. Its supporting notice is the project
    // title, while deadline status is independently bound by the deadline evidence below.
    case 'verificationStatus': return opportunity.project;
    // ISO deadline is derived from the source-facing deadlineOriginal text.
    case 'deadline': return opportunity.deadlineOriginal;
    case 'deadlineOriginal': return opportunity.deadlineOriginal;
    case 'eventArrangement.time': return opportunity.eventArrangement.time.summary;
    case 'eventArrangement.formatLocation': return opportunity.eventArrangement.formatLocation.summary;
    case 'materials': return opportunity.materials.summary;
    case 'recommendation': return opportunity.recommendation.summary;
    case 'logistics': return opportunity.logistics.summary;
    default: throw new Error(`unknown field evidence ${quoted(field)}`);
  }
}

function isAdditiveGitHubDiscoveryHost(hostname: string): boolean {
  return hostname === 'github.com'
    || hostname.endsWith('.github.com')
    || hostname === 'raw.githubusercontent.com';
}

function assertAdditivePublicDiscoverySources(opportunity: PublicOpportunity): void {
  for (const source of opportunity.discoverySources) {
    const sourceUrl = normalizeComparableUrl(source.url, 'addition discovery source URL');
    if (isAdditiveGitHubDiscoveryHost(new URL(sourceUrl).hostname)) {
      throw new Error(
        `addition ${quoted(opportunity.projectId)} must not expose a GitHub discovery source`,
      );
    }
  }
}

function assertAdditiveEvidence(
  run: AdditiveApprovalRun,
  opportunity: PublicOpportunity,
  evidence: AdditiveOpportunityEvidence,
  artifactMaterials: ReadonlyMap<string, AdditiveArtifactMaterial>,
): void {
  if (evidence.school !== opportunity.name) {
    throw new Error(`addition ${quoted(opportunity.projectId)} evidence school must match opportunity name`);
  }
  const scope = run.scopes.find((candidate) => candidate.scopeId === evidence.scopeId);
  if (
    scope === undefined
    || scope.school !== evidence.school
    || scope.result !== 'new-clue'
  ) {
    throw new Error(`addition ${quoted(opportunity.projectId)} must bind to a same-school new-clue scope`);
  }
  const officialUrl = assertAdditiveInstitutionalOfficialUrl(
    evidence.officialUrl,
    'addition evidence officialUrl',
  );
  if (officialUrl !== assertAdditiveInstitutionalOfficialUrl(
    opportunity.website,
    'addition opportunity website',
  )) {
    throw new Error(`addition ${quoted(opportunity.projectId)} officialUrl must match opportunity website`);
  }
  assertAdditivePublicDiscoverySources(opportunity);
  const officialSources = opportunity.discoverySources
    .filter((source) => source.kind === 'official')
    .map((source) => assertAdditiveInstitutionalOfficialUrl(
      source.url,
      'addition official discovery source',
    ));
  if (!officialSources.includes(officialUrl)) {
    throw new Error(`addition ${quoted(opportunity.projectId)} must retain an exact official discovery source`);
  }
  const artifacts = new Map(
    run.artifacts.map((artifact) => [artifact.sha256, artifact] as const),
  );
  const primaryArtifact = artifacts.get(evidence.artifactSha256);
  if (primaryArtifact === undefined) {
    throw new Error(`addition ${quoted(opportunity.projectId)} primary artifact is missing`);
  }
  if (normalizeComparableUrl(primaryArtifact.url, 'addition primary artifact URL') !== officialUrl) {
    throw new Error(`addition ${quoted(opportunity.projectId)} primary artifact must match officialUrl`);
  }
  const primaryMaterial = artifactMaterials.get(evidence.artifactSha256);
  if (primaryMaterial === undefined) {
    throw new Error(`addition ${quoted(opportunity.projectId)} primary artifact was not read`);
  }
  const primaryText = primaryMaterial.text ?? (
    primaryArtifact.extractedTextArtifactSha256 === null
      ? null
      : artifactMaterials.get(primaryArtifact.extractedTextArtifactSha256)?.text ?? null
  );
  if (primaryText === null) {
    throw new Error(`addition ${quoted(opportunity.projectId)} binary primary artifact must declare a file-backed extracted text artifact`);
  }
  if (!primaryText.includes(opportunity.name)) {
    throw new Error(`addition ${quoted(opportunity.projectId)} primary official artifact must identify its school`);
  }

  const seenFields = new Set<string>();
  for (const fieldEvidence of evidence.fieldEvidence) {
    if (!(additiveRequiredEvidenceFields as readonly string[]).includes(fieldEvidence.field)) {
      throw new Error(`addition ${quoted(opportunity.projectId)} has unsupported field evidence`);
    }
    if (seenFields.has(fieldEvidence.field)) {
      throw new Error(`addition ${quoted(opportunity.projectId)} has duplicate field evidence`);
    }
    seenFields.add(fieldEvidence.field);
    const artifact = artifacts.get(fieldEvidence.artifactSha256);
    if (artifact === undefined) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence artifact is missing`);
    }
    const material = artifactMaterials.get(fieldEvidence.artifactSha256);
    if (material === undefined) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence artifact was not read`);
    }
    const fieldSourceUrl = assertAdditiveInstitutionalOfficialUrl(
      fieldEvidence.sourceUrl,
      'field evidence sourceUrl',
    );
    if (fieldSourceUrl !== assertAdditiveInstitutionalOfficialUrl(
      artifact.url,
      'field evidence artifact URL',
    )) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence source must match artifact`);
    }
    if (
      fieldSourceUrl === officialUrl
      && fieldEvidence.artifactSha256 !== primaryArtifact.sha256
      && fieldEvidence.artifactSha256 !== primaryArtifact.extractedTextArtifactSha256
    ) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence at the primary URL must use its primary artifact or declared extracted text`);
    }
    const checkedAtMs = Date.parse(fieldEvidence.checkedAt);
    if (
      checkedAtMs < Date.parse(run.startedAt)
      || checkedAtMs > Date.parse(run.finishedAt)
    ) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence was checked outside the run`);
    }
    if (fieldEvidence.normalizedValue !== JSON.stringify(additiveFieldValue(opportunity, fieldEvidence.field))) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence value does not match public data`);
    }
    if (fieldEvidence.quote.trim() === '') {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence quote must not be blank`);
    }
    const quoteText = material.text ?? (
      material.artifact.extractedTextArtifactSha256 === null
        ? null
        : artifactMaterials.get(material.artifact.extractedTextArtifactSha256)?.text ?? null
    );
    if (quoteText === null || !quoteText.includes(fieldEvidence.quote)) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence quote must occur in its file-backed artifact text`);
    }
    const sourceValue = additiveFieldQuoteSourceValue(opportunity, fieldEvidence.field);
    if (sourceValue !== null && !fieldEvidence.quote.includes(sourceValue)) {
      throw new Error(`addition ${quoted(opportunity.projectId)} field evidence quote must contain the field source value`);
    }
  }
  for (const field of additiveRequiredEvidenceFields) {
    if (!seenFields.has(field)) {
      throw new Error(`addition ${quoted(opportunity.projectId)} is missing fieldEvidence for ${field}`);
    }
  }
  if (
    opportunity.deadline !== null
    && !deadlineOriginalSupportsNormalizedDate(opportunity.deadlineOriginal, opportunity.deadline)
  ) {
    throw new Error(`addition ${quoted(opportunity.projectId)} normalized deadline must match the calendar date in deadlineOriginal`);
  }
}

function buildAdditiveCandidate(
  parent: PublicSnapshot,
  additions: PublicOpportunity[],
  scanAt: string,
): SnapshotCandidate {
  const opportunities = [...parent.opportunities, ...additions]
    .map((row) => structuredClone(row))
    .sort(compareRows);
  const counts = countRows(opportunities);
  counts.pendingExcluded = parent.counts.pendingExcluded;
  return {
    schemaVersion: 2,
    scanAt,
    defaultFeedId: parent.defaultFeedId,
    feeds: structuredClone(parent.feeds),
    counts,
    opportunities,
  };
}

function sealAdditiveCandidate(
  candidate: SnapshotCandidate,
  parent: PublicSnapshot,
  approvedAt: string,
): PublicSnapshot {
  if (!isValidIsoTimestamp(approvedAt)) {
    throw new Error('approvedAt must be a valid ISO timestamp');
  }
  if (Date.parse(approvedAt) < Date.parse(candidate.scanAt)) {
    throw new Error('approvedAt must not be before additive run finishedAt');
  }
  const candidateErrors = validateCandidateStructure(candidate);
  if (candidateErrors.length > 0) {
    throw new Error(`Additive candidate validation failed:\n${candidateErrors.join('\n')}`);
  }
  const dataHash = canonicalDataHash(candidate);
  const sealed: PublicSnapshot = {
    ...structuredClone(candidate),
    snapshotId: deriveSnapshotId(approvedAt, dataHash),
    approvedAt,
    previousSnapshotId: parent.snapshotId,
    dataHash,
  };
  const sealedErrors = validateApprovedSnapshotStructure(sealed);
  if (sealedErrors.length > 0) {
    throw new Error(`Sealed additive snapshot validation failed:\n${sealedErrors.join('\n')}`);
  }
  return sealed;
}

export function approveCandidate(
  candidate: SnapshotCandidate,
  current: ReadablePublicSnapshot | null,
  approvedAt: string,
): PublicSnapshot {
  if (!isValidIsoTimestamp(approvedAt)) {
    throw new Error('approvedAt must be a valid ISO timestamp');
  }
  const approvedAtMs = Date.parse(approvedAt);
  const candidateErrors = validateCandidate(candidate, approvedAtMs);
  if (candidateErrors.length > 0) {
    throw new Error(`Candidate validation failed:\n${candidateErrors.join('\n')}`);
  }
  const scanAtMs = Date.parse(candidate.scanAt);
  if (approvedAtMs < scanAtMs) {
    throw new Error('approvedAt must not be before candidate scanAt');
  }

  if (current !== null) {
    const currentReferenceTime = isValidIsoTimestamp(current.approvedAt)
      ? Date.parse(current.approvedAt)
      : 0;
    const currentErrors = validateApprovedSnapshot(current, currentReferenceTime);
    if (currentErrors.length > 0) {
      throw new Error(`Current snapshot validation failed:\n${currentErrors.join('\n')}`);
    }
  }

  const dataHash = canonicalDataHash(candidate);
  const sealed: PublicSnapshot = {
    ...structuredClone(candidate),
    snapshotId: deriveSnapshotId(approvedAt, dataHash),
    approvedAt,
    previousSnapshotId: current?.snapshotId ?? null,
    dataHash,
  };
  const sealedErrors = validateApprovedSnapshot(sealed, approvedAtMs);
  if (sealedErrors.length > 0) {
    throw new Error(`Sealed snapshot validation failed:\n${sealedErrors.join('\n')}`);
  }
  return sealed;
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--release-dir',
    '--approved',
    '--pending-current',
    '--approved-at',
    '--removal-authorization',
    '--removal-authorization-sha256',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${quoted(flag)}\n${usage}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${quoted(flag)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${quoted(flag)}\n${usage}`);
    }
    values.set(flag, value);
    index += 1;
  }
  const releaseDir = values.get('--release-dir');
  const approved = values.get('--approved');
  const pendingCurrent = values.get('--pending-current');
  if (
    releaseDir === undefined ||
    approved === undefined ||
    pendingCurrent === undefined
  ) {
    throw new Error(`missing required argument\n${usage}`);
  }
  const removalAuthorization = values.get('--removal-authorization');
  const removalAuthorizationSha256 = values.get(
    '--removal-authorization-sha256',
  );
  if (
    (removalAuthorization === undefined)
    !== (removalAuthorizationSha256 === undefined)
  ) {
    throw new Error(
      `removal authorization path and SHA-256 must be provided together\n${usage}`,
    );
  }
  if (
    removalAuthorizationSha256 !== undefined
    && !sha256Pattern.test(removalAuthorizationSha256)
  ) {
    throw new Error('removal authorization SHA-256 must be a 64-character hexadecimal digest');
  }
  return {
    releaseDir,
    approved,
    pendingCurrent,
    approvedAt: values.get('--approved-at'),
    removalAuthorization,
    removalAuthorizationSha256: removalAuthorizationSha256?.toLowerCase(),
  };
}

function bytesHash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function readApprovedFileState(path: string): Promise<ApprovedFileState> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { value: null, fingerprint: { exists: false } };
    }
    throw new Error(`current snapshot could not be inspected at ${quoted(path)}: ${safeError(error)}`);
  }
  if (info.isSymbolicLink()) throw new Error('--approved must not be an existing symlink');
  if (!info.isFile()) throw new Error('--approved must be absent or an existing regular file');
  const file = await readRegularJsonFile(path, 'current snapshot');
  return {
    value: file.value as ReadablePublicSnapshot,
    fingerprint: {
      exists: true,
      dev: file.dev,
      ino: file.ino,
      size: file.size,
      mtimeMs: file.mtimeMs,
      contentHash: bytesHash(file.text),
    },
    text: file.text,
  };
}

async function assertRegularFileUnchanged(
  path: string,
  expected: FileFingerprint,
  label: string,
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') && !expected.exists) return;
    throw new Error(`${label} changed concurrently before atomic rename`);
  }
  if (!expected.exists || info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} changed concurrently before atomic rename`);
  }
  let file: RegularJsonFile;
  try {
    file = await readRegularJsonFile(path, 'approved snapshot');
  } catch {
    throw new Error(`${label} changed concurrently before atomic rename`);
  }
  if (
    file.dev !== expected.dev
    || file.ino !== expected.ino
    || file.size !== expected.size
    || file.mtimeMs !== expected.mtimeMs
    || bytesHash(file.text) !== expected.contentHash
  ) {
    throw new Error(`${label} changed concurrently before atomic rename`);
  }
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) return;
  }
}

async function writeApprovedAtomically(
  path: string,
  snapshot: PublicSnapshot,
  expected: FileFingerprint,
  signal?: AbortSignal,
  hooks: ApproveSnapshotIoHooks = {},
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const previousPath = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.previous`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: FileHandle | undefined;
  let recoveryLinked = false;
  let replacementRenamed = false;
  let committed = false;
  let preparedFingerprint: FileFingerprint | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    const expectedText = `${JSON.stringify(snapshot, null, 2)}\n`;
    await handle.writeFile(expectedText, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const preparedFile = await readRegularJsonFile(
      tempPath,
      'prepared approved snapshot',
    );
    preparedFingerprint = {
      exists: true,
      dev: preparedFile.dev,
      ino: preparedFile.ino,
      size: preparedFile.size,
      mtimeMs: preparedFile.mtimeMs,
      contentHash: bytesHash(preparedFile.text),
    };
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Atomic approved write cancelled before rename');
    }
    directoryHandle = await (hooks.openDirectory ?? ((directory) => open(directory, 'r')))(parent);
    await hooks.beforeRename?.();
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Atomic approved write cancelled before rename');
    }
    await assertRegularFileUnchanged(
      path,
      expected,
      'approved snapshot',
    );
    await hooks.afterApprovedFingerprintCheck?.();
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Atomic approved write cancelled before commit');
    }
    // Keep current continuously readable: capture its inode, then replace it in one rename.
    await link(path, previousPath);
    recoveryLinked = true;
    await assertRegularFileUnchanged(
      previousPath,
      expected,
      'approved snapshot',
    );
    await assertRegularFileUnchanged(
      path,
      expected,
      'approved snapshot',
    );
    await hooks.afterApprovedRecoveryLink?.();
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Atomic approved write cancelled before commit');
    }
    await assertRegularFileUnchanged(
      path,
      expected,
      'approved snapshot',
    );
    await rename(tempPath, path);
    replacementRenamed = true;
    const committedFile = await readRegularJsonFile(path, 'committed approved snapshot');
    if (
      committedFile.dev !== preparedFingerprint.dev
      || committedFile.ino !== preparedFingerprint.ino
      || committedFile.size !== preparedFingerprint.size
      || bytesHash(committedFile.text) !== preparedFingerprint.contentHash
    ) {
      throw new Error('approved snapshot changed concurrently during atomic commit');
    }
    committed = true;
    try {
      await (hooks.syncDirectory ?? ((directory) => directory.sync()))(directoryHandle);
    } catch {
      // The rename is committed; later durability or cleanup failures must not report rejection.
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (directoryHandle !== undefined) await directoryHandle.close().catch(() => undefined);
    if (
      recoveryLinked
      && replacementRenamed
      && !committed
      && preparedFingerprint !== undefined
    ) {
      try {
        const current = await readRegularJsonFile(
          path,
          'failed committed approved snapshot',
        );
        if (
          current.dev === preparedFingerprint.dev
          && current.ino === preparedFingerprint.ino
        ) {
          await rename(previousPath, path);
          recoveryLinked = false;
        }
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
      }
    }
    if (recoveryLinked) await removeTempFile(previousPath);
    await removeTempFile(tempPath);
  }
}

async function acquireApprovalLock(path: string): Promise<ApprovalLock> {
  const lockPath = join(dirname(path), `.${basename(path)}.lock`);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error('approved target is locked by another approval');
    }
    throw new Error(`approval lock could not be acquired beside ${quoted(path)}: ${safeError(error)}`);
  }
  const token = randomUUID();
  let lock: ApprovalLock | undefined;
  try {
    const information = await handle.stat();
    lock = {
      handle,
      path: lockPath,
      token,
      dev: information.dev,
      ino: information.ino,
    };
    const owner: ApprovalLockOwner = {
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    return lock;
  } catch (error) {
    if (lock === undefined) {
      await handle.close().catch(() => undefined);
    } else {
      await releaseApprovalLock(lock);
    }
    throw new Error(`approval lock could not be initialized beside ${quoted(path)}: ${safeError(error)}`);
  }
}

async function releaseApprovalLock(
  lock: ApprovalLock,
  hooks: ApproveSnapshotIoHooks = {},
): Promise<void> {
  const releasePath = `${lock.path}.release.${lock.token}`;
  let moved = false;
  let restored = false;
  try {
    await hooks.beforeLockReleaseRename?.();
    await rename(lock.path, releasePath);
    moved = true;
    const captured = await lstat(releasePath);
    if (
      captured.isSymbolicLink()
      || !captured.isFile()
      || captured.dev !== lock.dev
      || captured.ino !== lock.ino
    ) {
      try {
        await link(releasePath, lock.path);
        restored = true;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      }
    }
  } catch {
    // A missing or replaced lock is not ours to remove.
  } finally {
    if (moved) {
      const captured = await lstat(releasePath).catch(() => undefined);
      const capturedOurs = (
        captured !== undefined
        && !captured.isSymbolicLink()
        && captured.isFile()
        && captured.dev === lock.dev
        && captured.ino === lock.ino
      );
      if (capturedOurs || restored) {
        await unlink(releasePath).catch(() => undefined);
      }
    }
    await lock.handle.close().catch(() => undefined);
  }
}

async function writePrivateDecisionAtomically(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const existing = await lstat(target).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('release decision must be absent or an existing regular file');
  }
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await removeTempFile(temporary);
  }
}

async function assertAdditiveDecisionPath(
  decisionPath: string,
  runDirectory: string,
  runPath: string,
  parentPath: string,
  approvedPath: string,
  registryPath: string,
  sentinelsPath: string,
  runFile: RegularJsonFile,
  parentFile: RegularJsonFile,
  approvedState: ApprovedFileState,
  registryFile: RegularJsonFile,
  sentinelsFile: RegularJsonFile,
): Promise<void> {
  // A decision is intentionally a single private sibling of discovery-run.json.
  // Allowing a nested destination lets an intermediate symlink escape the run
  // directory and turn the private write into a public-input overwrite.
  if (dirname(decisionPath) !== runDirectory) {
    throw new Error('release decision path must be a direct file in the additive run directory');
  }
  const runDirectoryInfo = await lstat(runDirectory);
  if (runDirectoryInfo.isSymbolicLink() || !runDirectoryInfo.isDirectory()) {
    throw new Error('additive run directory must be a regular directory, not a symbolic link');
  }
  const physicalRunDirectory = await realpath(runDirectory);
  const physicalDecisionPath = join(physicalRunDirectory, basename(decisionPath));
  const physicalInputs = await Promise.all([
    realpath(runPath),
    realpath(parentPath),
    approvedState.value === null ? Promise.resolve('') : realpath(approvedPath),
    realpath(registryPath),
    realpath(sentinelsPath),
  ]);
  if (physicalInputs.includes(physicalDecisionPath)) {
    throw new Error('release decision path must not alias an additive input or public output');
  }
  const decisionInfo = await lstat(decisionPath).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (decisionInfo === undefined) return;
  if (decisionInfo.isSymbolicLink() || !decisionInfo.isFile()) {
    throw new Error('release decision must be absent or an existing regular file');
  }
  const inputIdentities = [
    runFile,
    parentFile,
    approvedState.value === null
      ? undefined
      : approvedState.fingerprint,
    registryFile,
    sentinelsFile,
  ];
  if (
    inputIdentities.some(
      (input) => input !== undefined && input.dev === decisionInfo.dev && input.ino === decisionInfo.ino,
    )
  ) {
    throw new Error('release decision path must not alias an additive input or public output');
  }
}

async function assertAdditiveDecisionDoesNotCollideWithArtifacts(
  decisionPath: string,
  runDirectory: string,
  run: AdditiveApprovalRun,
): Promise<void> {
  const decisionName = basename(decisionPath);
  const decisionInfo = await lstat(decisionPath).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  for (const artifact of run.artifacts) {
    if (artifact.path === decisionName) {
      throw new Error('release decision path must not collide with a declared additive artifact');
    }
    if (decisionInfo === undefined) continue;
    const artifactInfo = await lstat(join(runDirectory, artifact.path)).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (
      artifactInfo !== undefined
      && artifactInfo.isFile()
      && !artifactInfo.isSymbolicLink()
      && artifactInfo.dev === decisionInfo.dev
      && artifactInfo.ino === decisionInfo.ino
    ) {
      throw new Error('release decision path must not alias a declared additive artifact');
    }
  }
}

function additiveDecisionBase(run: AdditiveApprovalRun, coverage: AdditiveCoverageSummary) {
  return {
    schemaVersion: 1,
    runId: run.runId,
    parent: {
      sha256: run.parent.sha256,
      snapshotId: run.parent.snapshotId,
      dataHash: run.parent.dataHash,
    },
    coverage,
  };
}

export async function approveAdditiveSnapshotFile(
  options: ApproveAdditiveSnapshotFileOptions,
  signal?: AbortSignal,
  hooks: ApproveSnapshotIoHooks = {},
): Promise<AdditiveApprovalResult> {
  const runPath = resolve(options.runPath);
  const parentPath = resolve(options.parentPath);
  const approvedPath = resolve(options.approvedPath);
  const decisionPath = resolve(options.decisionPath);
  const registryPath = resolve(options.registryPath ?? additiveRegistryPath);
  const sentinelsPath = resolve(options.sentinelsPath ?? additiveSentinelsPath);
  const runDirectory = dirname(runPath);
  if (
    decisionPath === runPath
    || decisionPath === parentPath
    || decisionPath === approvedPath
    || decisionPath === registryPath
    || decisionPath === sentinelsPath
    || approvedPath === parentPath
  ) {
    throw new Error('release decision path must not equal an additive input or public output');
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be a finite timestamp');
  if (!isValidIsoTimestamp(options.approvedAt)) {
    throw new Error('approvedAt must be a valid ISO timestamp');
  }
  const approvedAtMs = Date.parse(options.approvedAt);
  if (approvedAtMs > nowMs) {
    throw new Error('approvedAt must not be in the future');
  }

  const [runFile, parentFile, approvedState, registryFile, sentinelsFile] = await Promise.all([
    readRegularJsonFile(runPath, 'additive discovery run'),
    readRegularJsonFile(parentPath, 'frozen public parent'),
    readApprovedFileState(approvedPath),
    readRegularJsonFile(registryPath, 'frozen institution registry'),
    readRegularJsonFile(sentinelsPath, 'frozen priority sentinels'),
  ]);
  await assertAdditiveDecisionPath(
    decisionPath,
    runDirectory,
    runPath,
    parentPath,
    approvedPath,
    registryPath,
    sentinelsPath,
    runFile,
    parentFile,
    approvedState,
    registryFile,
    sentinelsFile,
  );
  const run = parseAdditiveRun(runFile.value);
  assertScopeManifest(run);
  await assertAdditiveDecisionDoesNotCollideWithArtifacts(decisionPath, runDirectory, run);
  const artifactMaterials = await readAndVerifyAdditiveArtifacts(runPath, run);
  assertAdditiveFixedDiscoveryChecks(run, artifactMaterials);
  const fixedDiscoveryPrivateValues = additiveFixedDiscoveryPrivateValues(run, artifactMaterials);
  const finishedAtMs = Date.parse(run.finishedAt);
  if (finishedAtMs > nowMs) throw new Error('additive discovery run finishedAt is in the future');
  if (nowMs - finishedAtMs > additiveRunMaximumAgeMs) {
    throw new Error('additive discovery run is older than the 24-hour publication window');
  }
  if (bytesHash(parentFile.text) !== run.parent.sha256) {
    throw new Error('frozen public parent bytes do not match the discovery run');
  }
  if (!isObject(parentFile.value) || parentFile.value.schemaVersion !== 2) {
    throw new Error('daily additive publication requires a schemaVersion 2 public parent');
  }
  const parent = parentFile.value as unknown as PublicSnapshot;
  const parentErrors = validateApprovedSnapshotStructure(parent);
  if (parentErrors.length > 0) {
    throw new Error(`frozen public parent validation failed:\n${parentErrors.join('\n')}`);
  }
  if (
    parent.snapshotId !== run.parent.snapshotId
    || parent.dataHash !== run.parent.dataHash
  ) {
    throw new Error('frozen public parent identity does not match the discovery run');
  }
  if (
    approvedState.value === null
    || approvedState.text === undefined
    || bytesHash(approvedState.text) !== run.parent.sha256
  ) {
    throw new Error('local approved snapshot no longer equals the frozen public parent');
  }
  const coverage = assertAdditiveCoverage(run, parent, registryFile, sentinelsFile);

  const additions = run.additions.map(({ opportunity }) => opportunity);
  const additionIds = new Set<string>();
  const parentIds = new Set(parent.opportunities.map((opportunity) => opportunity.projectId));
  for (const addition of additions) {
    if (parentIds.has(addition.projectId)) {
      throw new Error(`addition ${quoted(addition.projectId)} duplicates an existing parent project`);
    }
    if (additionIds.has(addition.projectId)) {
      throw new Error(`addition ${quoted(addition.projectId)} duplicates another addition`);
    }
    additionIds.add(addition.projectId);
  }

  if (additions.length === 0) {
    await assertAdditiveDecisionDoesNotCollideWithArtifacts(decisionPath, runDirectory, run);
    await writePrivateDecisionAtomically(decisionPath, {
      status: 'no-additions',
      ...additiveDecisionBase(run, coverage),
    });
    return { status: 'no-additions', runId: run.runId };
  }

  const additionsCandidate: SnapshotCandidate = {
    schemaVersion: 2,
    scanAt: run.finishedAt,
    defaultFeedId: parent.defaultFeedId,
    feeds: structuredClone(parent.feeds),
    counts: countRows(additions),
    opportunities: [...additions].sort(compareRows),
  };
  const additionsErrors = validateCandidate(additionsCandidate, finishedAtMs);
  if (additionsErrors.length > 0) {
    throw new Error(`additions validation failed:\n${additionsErrors.join('\n')}`);
  }
  for (const addition of additions) {
    assertAdditiveCollegeGranularity(addition);
  }
  for (const { opportunity, evidence } of run.additions) {
    assertAdditiveEvidence(run, opportunity, evidence, artifactMaterials);
  }
  for (const addition of additions) {
    assertAdditivePublicProvenance(addition, fixedDiscoveryPrivateValues);
  }

  const candidate = buildAdditiveCandidate(parent, additions, run.finishedAt);
  const approved = sealAdditiveCandidate(candidate, parent, options.approvedAt);
  const decision = {
    ...additiveDecisionBase(run, coverage),
    additions: {
      count: additions.length,
      projectIds: [...additionIds].sort(codePointCompare),
    },
    candidate: {
      snapshotId: approved.snapshotId,
      dataHash: approved.dataHash,
    },
  };
  await assertAdditiveDecisionDoesNotCollideWithArtifacts(decisionPath, runDirectory, run);
  await writePrivateDecisionAtomically(decisionPath, {
    status: 'eligible',
    ...decision,
  });

  const lock = await acquireApprovalLock(approvedPath);
  try {
    await writeApprovedAtomically(
      approvedPath,
      approved,
      approvedState.fingerprint,
      signal,
      hooks,
    );
  } finally {
    await releaseApprovalLock(lock, hooks);
  }
  await assertAdditiveDecisionDoesNotCollideWithArtifacts(decisionPath, runDirectory, run);
  await writePrivateDecisionAtomically(decisionPath, {
    status: 'ready',
    ...decision,
  });
  return {
    status: 'ready',
    runId: run.runId,
    snapshotId: approved.snapshotId,
    dataHash: approved.dataHash,
    additions: additions.length,
  };
}

export async function approveSnapshotFile(
  options: ApproveSnapshotFileOptions,
  signal?: AbortSignal,
  hooks: ApproveSnapshotIoHooks = {},
): Promise<PublicSnapshot> {
  const releaseDir = resolve(options.releaseDir);
  const approvedPath = resolve(options.approvedPath);
  const pendingCurrentPath = resolve(options.pendingCurrentPath);
  const removalAuthorizationPath = options.removalAuthorizationPath === undefined
    ? undefined
    : resolve(options.removalAuthorizationPath);
  if (
    (removalAuthorizationPath === undefined)
    !== (options.expectedRemovalAuthorizationSha256 === undefined)
  ) {
    throw new Error(
      'removal authorization path and expected SHA-256 must be provided together',
    );
  }
  if (
    options.expectedRemovalAuthorizationSha256 !== undefined
    && !sha256Pattern.test(options.expectedRemovalAuthorizationSha256)
  ) {
    throw new Error('expected removal authorization SHA-256 is invalid');
  }
  if (
    approvedPath === releaseDir ||
    approvedPath.startsWith(`${releaseDir}${sep}`)
  ) {
    throw new Error('--approved must be outside --release-dir');
  }
  if (
    pendingCurrentPath === releaseDir ||
    pendingCurrentPath.startsWith(`${releaseDir}${sep}`)
  ) {
    throw new Error('--pending-current must be outside --release-dir');
  }
  if (
    removalAuthorizationPath !== undefined
    && (
      removalAuthorizationPath === releaseDir
      || removalAuthorizationPath.startsWith(`${releaseDir}${sep}`)
    )
  ) {
    throw new Error('--removal-authorization must be outside --release-dir');
  }
  if (pendingCurrentPath === approvedPath) {
    throw new Error('--pending-current and --approved paths collide');
  }
  if (
    removalAuthorizationPath !== undefined
    && (
      removalAuthorizationPath === approvedPath
      || removalAuthorizationPath === pendingCurrentPath
    )
  ) {
    throw new Error('--removal-authorization collides with mutable release state');
  }
  const releaseInfo = await lstat(releaseDir);
  if (releaseInfo.isSymbolicLink() || !releaseInfo.isDirectory()) {
    throw new Error('--release-dir must be a regular directory, not a symlink');
  }
  try {
    await mkdir(dirname(options.approvedPath), { recursive: true });
  } catch (error) {
    throw new Error(
      `approved parent could not be created for ${quoted(options.approvedPath)}: ${safeError(error)}`,
    );
  }
  const lock = await acquireApprovalLock(options.approvedPath);
  try {
    const approvedState = await readApprovedFileState(options.approvedPath);
    if (approvedState.value === null || approvedState.text === undefined) {
      throw new Error('secure release approval requires an existing approved parent');
    }
    const removalAuthorizationFile = removalAuthorizationPath === undefined
      ? undefined
      : await readRegularJsonFile(
          removalAuthorizationPath,
          'trusted removal authorization',
        );
    if (
      removalAuthorizationFile !== undefined
      && bytesHash(removalAuthorizationFile.text)
        !== options.expectedRemovalAuthorizationSha256!.toLowerCase()
    ) {
      throw new Error('trusted removal authorization SHA-256 does not match its bytes');
    }
    const paths = {
      bundle: join(releaseDir, 'scan-bundle.json'),
      registry: join(releaseDir, 'universities.json'),
      sentinels: join(releaseDir, 'priority-sentinels.json'),
      identityRegistry: join(releaseDir, 'project-id-aliases.json'),
      submitted: join(releaseDir, 'submitted.json'),
      pendingBase: join(releaseDir, 'pending-base.json'),
      candidate: join(releaseDir, 'candidate.json'),
      diff: join(releaseDir, 'diff.json'),
      lifecycle: join(releaseDir, 'lifecycle.json'),
      evidenceDispositions: join(releaseDir, 'evidence-dispositions.json'),
      pendingNext: join(releaseDir, 'pending-next.json'),
      audit: join(releaseDir, 'release-audit.json'),
      gate: join(releaseDir, 'gate.json'),
      artifactManifest: join(releaseDir, 'artifact-manifest.json'),
      removalReviews: join(releaseDir, 'removal-reviews.json'),
      artifactRoot: join(releaseDir, 'artifacts'),
    };
    const [
      bundleFile,
      registryFile,
      sentinelsFile,
      identityFile,
      submittedFile,
      pendingBaseFile,
      candidateFile,
      diffFile,
      lifecycleFile,
      evidenceDispositionsFile,
      pendingNextFile,
      auditFile,
      gateFile,
      artifactManifestFile,
      pendingCurrentFile,
      removalReviewsFile,
    ] = await Promise.all([
      readRegularJsonFile(paths.bundle, 'scan bundle'),
      readRegularJsonFile(paths.registry, 'institution registry'),
      readRegularJsonFile(paths.sentinels, 'priority sentinels'),
      readRegularJsonFile(paths.identityRegistry, 'identity registry'),
      readRegularJsonFile(paths.submitted, 'submitted registry'),
      readRegularJsonFile(paths.pendingBase, 'pending base ledger'),
      readRegularJsonFile(paths.candidate, 'candidate'),
      readRegularJsonFile(paths.diff, 'snapshot diff'),
      readRegularJsonFile(paths.lifecycle, 'lifecycle'),
      readRegularJsonFile(
        paths.evidenceDispositions,
        'evidence dispositions',
      ),
      readRegularJsonFile(paths.pendingNext, 'pending next ledger'),
      readRegularJsonFile(paths.audit, 'release audit'),
      readRegularJsonFile(paths.gate, 'release gate'),
      readRegularJsonFile(paths.artifactManifest, 'artifact manifest'),
      readRegularJsonFile(options.pendingCurrentPath, 'live pending ledger'),
      readRegularJsonFile(paths.removalReviews, 'removal reviews'),
    ]);
    for (const file of [
      bundleFile,
      registryFile,
      sentinelsFile,
      identityFile,
      submittedFile,
      pendingBaseFile,
      candidateFile,
      diffFile,
      lifecycleFile,
      evidenceDispositionsFile,
      pendingNextFile,
      auditFile,
      gateFile,
      artifactManifestFile,
      removalReviewsFile,
    ]) {
      if (
        file.dev === approvedState.fingerprint.dev &&
        file.ino === approvedState.fingerprint.ino
      ) {
        throw new Error('release input and approved target collide by inode or hardlink');
      }
      if (
        removalAuthorizationFile !== undefined
        && file.dev === removalAuthorizationFile.dev
        && file.ino === removalAuthorizationFile.ino
      ) {
        throw new Error(
          'trusted removal authorization collides with a release input by inode or hardlink',
        );
      }
    }
    if (
      pendingCurrentFile.dev === pendingNextFile.dev &&
      pendingCurrentFile.ino === pendingNextFile.ino
    ) {
      throw new Error(
        '--pending-current must be a separately committed ledger, not pending-next',
      );
    }
    if (
      removalAuthorizationFile !== undefined
      && removalAuthorizationFile.dev === pendingCurrentFile.dev
      && removalAuthorizationFile.ino === pendingCurrentFile.ino
    ) {
      throw new Error(
        'trusted removal authorization collides with the live pending ledger by inode or hardlink',
      );
    }
    const bundle = parseScanBundle(bundleFile.value);
    if (bytesHash(approvedState.text) !== bundle.candidateBase.sha256) {
      throw new Error(
        'scan bundle candidateBase SHA-256 does not match the approved parent bytes',
      );
    }
    const registryInstitutions = parseRegistryInstitutions(registryFile.value);
    if (bytesHash(registryFile.text) !== bundle.registry.sha256) {
      throw new Error(
        'scan bundle registry SHA-256 does not match the registry bytes',
      );
    }
    if (registryInstitutions.length !== bundle.registry.institutionCount) {
      throw new Error(
        'scan bundle registry institutionCount does not match the registry',
      );
    }
    const artifactManifest = await verifyEvidenceArtifactManifest({
      artifactRoot: paths.artifactRoot,
      manifest: artifactManifestFile.value,
    });
    assertReadableEvidenceArtifactsCovered(bundle, artifactManifest);
    const pendingBase = parsePendingLedger(pendingBaseFile.value);
    const livePending = parsePendingLedger(pendingCurrentFile.value);
    const replayed = verifyScanReleaseReplay({
      buildOptions: {
        bundle,
        parent: approvedState.value as PublicSnapshot,
        registryInstitutions,
        sentinels: parsePrioritySentinels(sentinelsFile.value),
        identityRegistry: parseIdentityRegistry(identityFile.value),
        submittedRegistry: parseSubmittedProjectRegistry(
          submittedFile.value,
        ),
        pendingLedger: pendingBase,
        artifactManifest,
        removalReviews: parseRemovalReviews(removalReviewsFile.value),
      },
      candidate: candidateFile.value as SnapshotCandidate,
      diff: diffFile.value as SnapshotDiff,
      pendingNext: parsePendingLedger(pendingNextFile.value),
      lifecycle: lifecycleFile.value as ScanReduction['lifecycle'],
      evidenceDispositions:
        evidenceDispositionsFile.value as ScanReduction['evidenceDispositions'],
      gate: gateFile.value as ReleaseGateManifest,
      audit: auditFile.value as ScanReleaseAudit,
      livePending,
      removalAuthorization: removalAuthorizationFile?.value,
      removalReviewsSha256: bytesHash(removalReviewsFile.text),
    });
    const candidate = replayed.candidate;
    const approved = approveCandidate(
      candidate,
      approvedState.value,
      options.approvedAt,
    );
    await assertRegularFileUnchanged(
      options.pendingCurrentPath,
      {
        exists: true,
        dev: pendingCurrentFile.dev,
        ino: pendingCurrentFile.ino,
        size: pendingCurrentFile.size,
        mtimeMs: pendingCurrentFile.mtimeMs,
        contentHash: bytesHash(pendingCurrentFile.text),
      },
      'live pending ledger',
    );
    if (removalAuthorizationFile !== undefined) {
      await assertRegularFileUnchanged(
        removalAuthorizationPath!,
        {
          exists: true,
          dev: removalAuthorizationFile.dev,
          ino: removalAuthorizationFile.ino,
          size: removalAuthorizationFile.size,
          mtimeMs: removalAuthorizationFile.mtimeMs,
          contentHash: bytesHash(removalAuthorizationFile.text),
        },
        'trusted removal authorization',
      );
    }
    try {
      await writeApprovedAtomically(
        options.approvedPath,
        approved,
        approvedState.fingerprint,
        signal,
        hooks,
      );
    } catch (error) {
      throw new Error(
        `approved snapshot could not be replaced at ${quoted(options.approvedPath)}: ${safeError(error)}`,
      );
    }
    return approved;
  } finally {
    await releaseApprovalLock(lock, hooks);
  }
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const approved = await approveSnapshotFile({
    releaseDir: options.releaseDir,
    approvedPath: options.approved,
      pendingCurrentPath: options.pendingCurrent,
      approvedAt: options.approvedAt ?? new Date().toISOString(),
      removalAuthorizationPath: options.removalAuthorization,
      expectedRemovalAuthorizationSha256:
        options.removalAuthorizationSha256,
    });
  console.log(`Approved snapshot ${approved.snapshotId} to ${quoted(options.approved)}`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  runCli().catch((error: unknown) => {
    console.error(
      `snapshot approval failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
