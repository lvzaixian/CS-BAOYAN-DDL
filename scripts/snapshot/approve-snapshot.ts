import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  LegacySnapshotCandidateV1,
  PublicSnapshot,
  ReadablePublicSnapshot,
  SnapshotCandidate,
} from '../../src/lib/snapshot-types.js';
import { validateCandidate, validateSnapshot } from '../../src/lib/snapshot-validation.js';

type JsonObject = Record<string, unknown>;

interface CliOptions {
  candidate: string;
  approved: string;
  approvedAt?: string;
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
}

export interface RegularJsonFile {
  value: unknown;
  text: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface ApproveSnapshotIoHooks {
  beforeRename?: () => Promise<void>;
  openDirectory?: (path: string) => Promise<FileHandle>;
  syncDirectory?: (handle: FileHandle) => Promise<void>;
}

export interface ApproveSnapshotFileOptions {
  candidatePath: string;
  approvedPath: string;
  approvedAt: string;
}

const usage =
  'Usage: snapshot:approve -- --candidate PATH --approved PATH [--approved-at ISO_TIMESTAMP]';
export const MAX_SNAPSHOT_JSON_BYTES = 16 * 1024 * 1024;

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

type CanonicalSnapshotInput =
  | LegacySnapshotCandidateV1
  | ReadablePublicSnapshot
  | SnapshotCandidate;

function canonicalPayload(input: CanonicalSnapshotInput) {
  return {
    schemaVersion: input.schemaVersion,
    scanAt: input.scanAt,
    defaultFeedId: input.defaultFeedId,
    feeds: input.feeds,
    counts: input.counts,
    opportunities: input.opportunities,
  };
}

function hashCanonicalPayload(payload: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

export function canonicalDataHash(input: CanonicalSnapshotInput): string {
  return hashCanonicalPayload(canonicalPayload(input));
}

function canonicalDataHashFromObject(input: JsonObject): string {
  return hashCanonicalPayload({
    schemaVersion: input.schemaVersion,
    scanAt: input.scanAt,
    defaultFeedId: input.defaultFeedId,
    feeds: input.feeds,
    counts: input.counts,
    opportunities: input.opportunities,
  });
}

function isValidIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  return (
    day >= 1
    && day <= daysInMonth
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 59
    && (offsetHour === undefined || Number(offsetHour) <= 23)
    && (offsetMinute === undefined || Number(offsetMinute) <= 59)
    && Number.isFinite(Date.parse(value))
  );
}

function snapshotIdFor(approvedAt: string, dataHash: string): string {
  return `${new Date(Date.parse(approvedAt)).toISOString()}-${dataHash.slice(0, 12)}`;
}

function isRepositorySnapshotId(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-[0-9a-f]{12}$/.exec(value);
  return match !== null && isValidIsoTimestamp(match[1]);
}

export function validateApprovedSnapshot(input: unknown, nowMs = Date.now()): string[] {
  const errors = validateSnapshot(input, nowMs);
  if (!isObject(input)) return errors;

  let recomputedHash: string;
  try {
    recomputedHash = canonicalDataHashFromObject(input);
  } catch {
    errors.push('snapshot.dataHash: canonical hash could not be recomputed');
    return errors;
  }

  if (input.dataHash !== recomputedHash) {
    errors.push('snapshot.dataHash: must equal the lowercase canonical SHA-256 hash');
  }
  if (
    typeof input.approvedAt === 'string'
    && isValidIsoTimestamp(input.approvedAt)
    && input.snapshotId !== snapshotIdFor(input.approvedAt, recomputedHash)
  ) {
    errors.push('snapshot.snapshotId: must be derived from approvedAt and the canonical hash');
  }
  if (
    typeof input.previousSnapshotId === 'string'
    && !isRepositorySnapshotId(input.previousSnapshotId)
  ) {
    errors.push('snapshot.previousSnapshotId: expected the repository snapshot ID format');
  }
  return errors;
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
    snapshotId: snapshotIdFor(approvedAt, dataHash),
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
  const allowed = new Set(['--candidate', '--approved', '--approved-at']);
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
  const candidate = values.get('--candidate');
  const approved = values.get('--approved');
  if (candidate === undefined || approved === undefined) {
    throw new Error(`missing required argument\n${usage}`);
  }
  return { candidate, approved, approvedAt: values.get('--approved-at') };
}

async function readRegularText(path: string, label: string): Promise<Omit<RegularJsonFile, 'value'>> {
  let pathInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    pathInfo = await lstat(path);
  } catch (error) {
    throw new Error(`${label} could not be read at ${quoted(path)}: ${safeError(error)}`);
  }
  if (pathInfo.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink at ${quoted(path)}`);
  }
  if (!pathInfo.isFile()) {
    throw new Error(`${label} must be a regular file at ${quoted(path)}`);
  }
  if (pathInfo.size > MAX_SNAPSHOT_JSON_BYTES) {
    throw new Error(`${label} exceeds the JSON size limit at ${quoted(path)}`);
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} could not be read at ${quoted(path)}: ${safeError(error)}`);
  }
  try {
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile()
      || openedInfo.dev !== pathInfo.dev
      || openedInfo.ino !== pathInfo.ino
    ) {
      throw new Error(`${label} changed while being opened at ${quoted(path)}`);
    }
    if (openedInfo.size > MAX_SNAPSHOT_JSON_BYTES) {
      throw new Error(`${label} exceeds the JSON size limit at ${quoted(path)}`);
    }
    const text = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_JSON_BYTES) {
      throw new Error(`${label} exceeds the JSON size limit at ${quoted(path)}`);
    }
    return {
      text,
      dev: openedInfo.dev,
      ino: openedInfo.ino,
      size: openedInfo.size,
      mtimeMs: openedInfo.mtimeMs,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseJson(text: string, path: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${quoted(path)}: ${safeError(error)}`);
  }
}

export async function readRegularJsonFile(
  path: string,
  label: string,
): Promise<RegularJsonFile> {
  const file = await readRegularText(path, label);
  return { ...file, value: parseJson(file.text, path, label) };
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
  };
}

async function assertApprovedFileUnchanged(
  path: string,
  expected: FileFingerprint,
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') && !expected.exists) return;
    throw new Error('approved snapshot changed concurrently before atomic rename');
  }
  if (!expected.exists || info.isSymbolicLink() || !info.isFile()) {
    throw new Error('approved snapshot changed concurrently before atomic rename');
  }
  let file: Omit<RegularJsonFile, 'value'>;
  try {
    file = await readRegularText(path, 'approved snapshot');
  } catch {
    throw new Error('approved snapshot changed concurrently before atomic rename');
  }
  if (
    file.dev !== expected.dev
    || file.ino !== expected.ino
    || file.size !== expected.size
    || file.mtimeMs !== expected.mtimeMs
    || bytesHash(file.text) !== expected.contentHash
  ) {
    throw new Error('approved snapshot changed concurrently before atomic rename');
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
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: FileHandle | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
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
    await assertApprovedFileUnchanged(path, expected);
    await rename(tempPath, path);
    try {
      await (hooks.syncDirectory ?? ((directory) => directory.sync()))(directoryHandle);
    } catch {
      // The rename is committed; later durability or cleanup failures must not report rejection.
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (directoryHandle !== undefined) await directoryHandle.close().catch(() => undefined);
    await removeTempFile(tempPath);
  }
}

async function acquireApprovalLock(path: string): Promise<{ handle: FileHandle; path: string }> {
  const lockPath = join(dirname(path), `.${basename(path)}.lock`);
  try {
    return { handle: await open(lockPath, 'wx', 0o600), path: lockPath };
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error('approved target is locked by another approval');
    }
    throw new Error(`approval lock could not be acquired beside ${quoted(path)}: ${safeError(error)}`);
  }
}

async function releaseApprovalLock(lock: { handle: FileHandle; path: string }): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  await unlink(lock.path).catch(() => undefined);
}

export async function approveSnapshotFile(
  options: ApproveSnapshotFileOptions,
  signal?: AbortSignal,
  hooks: ApproveSnapshotIoHooks = {},
): Promise<PublicSnapshot> {
  if (resolve(options.candidatePath) === resolve(options.approvedPath)) {
    throw new Error('--candidate and --approved paths collide');
  }
  const candidateFile = await readRegularJsonFile(options.candidatePath, 'candidate');
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
    if (
      approvedState.fingerprint.exists
      && candidateFile.dev === approvedState.fingerprint.dev
      && candidateFile.ino === approvedState.fingerprint.ino
    ) {
      throw new Error('--candidate and --approved collide by inode or hardlink');
    }
    const approved = approveCandidate(
      candidateFile.value as SnapshotCandidate,
      approvedState.value,
      options.approvedAt,
    );
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
    await releaseApprovalLock(lock);
  }
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const approved = await approveSnapshotFile({
    candidatePath: options.candidate,
    approvedPath: options.approved,
    approvedAt: options.approvedAt ?? new Date().toISOString(),
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
