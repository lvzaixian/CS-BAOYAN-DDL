import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalDataHash,
  deriveSnapshotId,
  isValidIsoTimestamp,
  readRegularJsonFile,
  validateApprovedSnapshot,
} from '../../src/lib/snapshot-integrity.js';
import type { RegularJsonFile } from '../../src/lib/snapshot-integrity.js';
import type {
  PublicSnapshot,
  ReadablePublicSnapshot,
  SnapshotCandidate,
} from '../../src/lib/snapshot-types.js';
import { validateCandidate } from '../../src/lib/snapshot-validation.js';
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

const usage =
  'Usage: snapshot:approve -- --release-dir PATH --approved PATH --pending-current PATH [--approved-at ISO_TIMESTAMP] [--removal-authorization PATH --removal-authorization-sha256 SHA256]';
const sha256Pattern = /^[a-f0-9]{64}$/iu;

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
