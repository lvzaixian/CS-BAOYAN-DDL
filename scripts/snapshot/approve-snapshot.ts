import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PublicSnapshot, SnapshotCandidate } from '../../src/lib/snapshot-types.js';
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
  value: PublicSnapshot | null;
  fingerprint: FileFingerprint;
}

export interface ApproveSnapshotFileOptions {
  candidatePath: string;
  approvedPath: string;
  approvedAt: string;
}

const usage =
  'Usage: snapshot:approve -- --candidate PATH --approved PATH [--approved-at ISO_TIMESTAMP]';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
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

function canonicalPayload(input: SnapshotCandidate | PublicSnapshot): SnapshotCandidate {
  return {
    schemaVersion: input.schemaVersion,
    scanAt: input.scanAt,
    defaultFeedId: input.defaultFeedId,
    feeds: input.feeds,
    counts: input.counts,
    opportunities: input.opportunities,
  };
}

export function canonicalDataHash(input: SnapshotCandidate | PublicSnapshot): string {
  const canonicalJson = JSON.stringify(canonicalize(canonicalPayload(input)));
  return createHash('sha256').update(canonicalJson).digest('hex');
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

export function validateApprovedSnapshot(input: unknown, nowMs = Date.now()): string[] {
  const errors = validateSnapshot(input, nowMs);
  if (!isObject(input)) return errors;

  let recomputedHash: string;
  try {
    recomputedHash = canonicalDataHash(input as unknown as PublicSnapshot);
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
  return errors;
}

export function approveCandidate(
  candidate: SnapshotCandidate,
  current: PublicSnapshot | null,
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
    const currentErrors = validateSnapshot(current, currentReferenceTime);
    if (currentErrors.length > 0) {
      throw new Error(`Current snapshot validation failed:\n${currentErrors.join('\n')}`);
    }
    const currentHash = canonicalDataHash(current);
    if (current.dataHash !== currentHash) {
      throw new Error('Current snapshot dataHash does not match the lowercase canonical hash');
    }
    if (current.snapshotId !== snapshotIdFor(current.approvedAt, currentHash)) {
      throw new Error('Current snapshot snapshotId does not match approvedAt and canonical hash');
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
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}\n${usage}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}\n${usage}`);
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

async function readText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} could not be read at ${path}: ${String(error)}`);
  }
}

function parseJson(text: string, path: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${path}: ${String(error)}`);
  }
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
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('--approved must not be an existing symlink');
  if (!info.isFile()) throw new Error('--approved must be absent or an existing regular file');
  const contents = await readText(path, 'current snapshot');
  return {
    value: parseJson(contents, path, 'current snapshot') as PublicSnapshot,
    fingerprint: {
      exists: true,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      contentHash: bytesHash(contents),
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
  const contents = await readFile(path, 'utf8');
  if (
    info.dev !== expected.dev
    || info.ino !== expected.ino
    || info.size !== expected.size
    || info.mtimeMs !== expected.mtimeMs
    || bytesHash(contents) !== expected.contentHash
  ) {
    throw new Error('approved snapshot changed concurrently before atomic rename');
  }
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

async function writeApprovedAtomically(
  path: string,
  snapshot: PublicSnapshot,
  expected: FileFingerprint,
  signal?: AbortSignal,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
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
    await assertApprovedFileUnchanged(path, expected);
    await rename(tempPath, path);
    const directoryHandle = await open(parent, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await removeTempFile(tempPath);
  }
}

export async function approveSnapshotFile(
  options: ApproveSnapshotFileOptions,
  signal?: AbortSignal,
): Promise<PublicSnapshot> {
  if (resolve(options.candidatePath) === resolve(options.approvedPath)) {
    throw new Error('--candidate and --approved paths collide');
  }
  const candidateText = await readText(options.candidatePath, 'candidate');
  const candidateInfo = await stat(options.candidatePath);
  if (!candidateInfo.isFile()) throw new Error('--candidate must be a regular file');
  const approvedState = await readApprovedFileState(options.approvedPath);
  if (
    approvedState.fingerprint.exists
    && candidateInfo.dev === approvedState.fingerprint.dev
    && candidateInfo.ino === approvedState.fingerprint.ino
  ) {
    throw new Error('--candidate and --approved collide by inode or hardlink');
  }
  const candidateInput = parseJson(
    candidateText,
    options.candidatePath,
    'candidate',
  ) as SnapshotCandidate;
  const approved = approveCandidate(
    candidateInput,
    approvedState.value,
    options.approvedAt,
  );
  await writeApprovedAtomically(
    options.approvedPath,
    approved,
    approvedState.fingerprint,
    signal,
  );
  return approved;
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
  console.log(`Approved snapshot ${approved.snapshotId} to ${options.approved}`);
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
