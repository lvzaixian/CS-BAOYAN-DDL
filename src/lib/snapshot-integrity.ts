import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import type {
  LegacySnapshotCandidateV1,
  ReadablePublicSnapshot,
  SnapshotCandidate,
} from './snapshot-types.js';
import { validateSnapshot } from './snapshot-validation.js';

type JsonObject = Record<string, unknown>;

export type CanonicalSnapshotInput =
  | LegacySnapshotCandidateV1
  | ReadablePublicSnapshot
  | SnapshotCandidate;

export interface RegularJsonFile {
  value: unknown;
  text: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export const MAX_SNAPSHOT_JSON_BYTES = 16 * 1024 * 1024;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function canonicalPayload(input: CanonicalSnapshotInput | JsonObject) {
  return {
    schemaVersion: input.schemaVersion,
    scanAt: input.scanAt,
    defaultFeedId: input.defaultFeedId,
    feeds: input.feeds,
    counts: input.counts,
    opportunities: input.opportunities,
  };
}

function hashCanonicalPayload(input: CanonicalSnapshotInput | JsonObject): string {
  const canonicalJson = JSON.stringify(canonicalize(canonicalPayload(input)));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

export function canonicalDataHash(input: CanonicalSnapshotInput): string {
  return hashCanonicalPayload(input);
}

export function isValidIsoTimestamp(value: string): boolean {
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

export function deriveSnapshotId(approvedAt: string, dataHash: string): string {
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
    recomputedHash = hashCanonicalPayload(input);
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
    && input.snapshotId !== deriveSnapshotId(input.approvedAt, recomputedHash)
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

export function validateStoredApprovedSnapshot(
  input: unknown,
  fallbackNowMs = Date.now(),
): string[] {
  const referenceTimeMs = isObject(input)
    && typeof input.approvedAt === 'string'
    && isValidIsoTimestamp(input.approvedAt)
    ? Date.parse(input.approvedAt)
    : fallbackNowMs;
  return validateApprovedSnapshot(input, referenceTimeMs);
}

async function readRegularText(
  path: string,
  label: string,
): Promise<Omit<RegularJsonFile, 'value'>> {
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

export async function readRegularJsonFile(
  path: string,
  label: string,
): Promise<RegularJsonFile> {
  const file = await readRegularText(path, label);
  try {
    return { ...file, value: JSON.parse(file.text) as unknown };
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${quoted(path)}: ${safeError(error)}`);
  }
}
