import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { PendingUpdate as ScanPendingUpdate } from './scan-release-contract.js';

export type PendingUpdate = ScanPendingUpdate;
export type PendingLedgerOutcome = PendingUpdate['outcome'] | 'identity-migrated';
export type UnresolvedPendingLedgerOutcome = Extract<
  PendingLedgerOutcome,
  'pending' | 'hard-error'
>;

export interface PendingLedgerRun {
  runId: string;
  scanStartedAt: string;
  scanFinishedAt: string;
}

export interface PendingLedgerIdentityMigration {
  fromLedgerId: string;
  toLedgerId: string;
}

export interface PendingLedgerIdentity {
  scopeItemId: string;
  school: string;
  region: string;
  targetId: string;
  officialUrls: string[];
  nextAction: string;
}

export interface PendingLedgerEntry extends PendingLedgerIdentity {
  ledgerId: string;
  lastRunId: string;
  outcome: UnresolvedPendingLedgerOutcome;
  checkedAt: string;
  evidenceIds: string[];
  reason: string;
  projectId?: string;
}

export interface PendingLedgerEvent extends PendingLedgerIdentity {
  ledgerId: string;
  runId: string;
  runStartedAt: string;
  runFinishedAt: string;
  outcome: PendingLedgerOutcome;
  checkedAt: string;
  evidenceIds: string[];
  reason: string;
  projectId?: string;
}

export interface PendingLedgerCurrent {
  generation: number;
  sha256: string;
  previousSha256: string | null;
  entries: PendingLedgerEntry[];
}

export interface PendingLedger {
  schemaVersion: 1;
  current: PendingLedgerCurrent;
  history: PendingLedgerEvent[];
}

type JsonObject = Record<string, unknown>;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/iu;
const LOCK_TOKEN_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const LOCK_STALE_AFTER_MS = 60 * 60 * 1_000;
const LOCK_MAX_BYTES = 1_024;
const MAX_PROCESS_ID = 2_147_483_647;
const UPDATE_OUTCOMES = [
  'pending',
  'promoted-active',
  'expired',
  'rejected',
  'hard-error',
] as const;
const ALL_OUTCOMES = [...UPDATE_OUTCOMES, 'identity-migrated'] as const;
const UNRESOLVED_OUTCOMES = ['pending', 'hard-error'] as const;
const DENIED_OFFICIAL_HOSTS = [
  'baoyantongzhi.com',
  'csbaoyan.top',
  'boardcaster.net',
  'github.com',
  'bing.com',
  'baidu.com',
  'google.com',
] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function exactKeys(
  object: JsonObject,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
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

function stringArrayAt(object: JsonObject, key: string, path: string): string[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${path}.${key} must be an array`);
  const parsed = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${path}.${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${path}.${key} must not contain duplicates`);
  }
  return parsed;
}

function integerAt(object: JsonObject, key: string, path: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path}.${key} must be a non-negative safe integer`);
  }
  return value as number;
}

function digestAt(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path);
  if (!DIGEST_PATTERN.test(value)) {
    throw new Error(`${path}.${key} must be a SHA-256 digest`);
  }
  return value.toLowerCase();
}

function nullableDigestAt(object: JsonObject, key: string, path: string): string | null {
  if (object[key] === null) return null;
  return digestAt(object, key, path);
}

function timestampAt(
  object: JsonObject,
  key: string,
  path: string,
  now = Date.now(),
): { value: string; milliseconds: number } {
  const value = stringAt(object, key, path);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${path}.${key} must be a valid timestamp`);
  }
  if (milliseconds > now) {
    throw new Error(`${path}.${key} must not be in the future`);
  }
  return { value, milliseconds };
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

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function optionalProjectId(
  object: JsonObject,
  path: string,
): { projectId?: string } {
  if (object.projectId === undefined) return {};
  return { projectId: stringAt(object, 'projectId', path) };
}

function isDeniedOfficialHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return DENIED_OFFICIAL_HOSTS.some(
    (host) => normalized === host || normalized.endsWith(`.${host}`),
  );
}

function officialUrlsAt(object: JsonObject, path: string): string[] {
  const officialUrls = stringArrayAt(object, 'officialUrls', path);
  if (officialUrls.length === 0) {
    throw new Error(`${path}.officialUrls must not be empty`);
  }
  for (const [index, value] of officialUrls.entries()) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${path}.officialUrls[${index}] must be a valid HTTP(S) URL`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username !== ''
      || url.password !== ''
    ) {
      throw new Error(
        `${path}.officialUrls[${index}] must be a credential-free HTTP(S) URL`,
      );
    }
    if (isDeniedOfficialHost(url.hostname)) {
      throw new Error(`${path}.officialUrls[${index}] must be an official source`);
    }
  }
  return officialUrls;
}

function identityAt(object: JsonObject, path: string): PendingLedgerIdentity {
  return {
    scopeItemId: stringAt(object, 'scopeItemId', path),
    school: stringAt(object, 'school', path),
    region: stringAt(object, 'region', path),
    targetId: stringAt(object, 'targetId', path),
    officialUrls: officialUrlsAt(object, path),
    nextAction: stringAt(object, 'nextAction', path),
  };
}

function copyIdentity(identity: PendingLedgerIdentity): PendingLedgerIdentity {
  return {
    scopeItemId: identity.scopeItemId,
    school: identity.school,
    region: identity.region,
    targetId: identity.targetId,
    officialUrls: [...identity.officialUrls],
    nextAction: identity.nextAction,
  };
}

function parseEntry(value: unknown, path: string, now: number): PendingLedgerEntry {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    [
      'ledgerId',
      'lastRunId',
      'outcome',
      'checkedAt',
      'evidenceIds',
      'reason',
      'scopeItemId',
      'school',
      'region',
      'targetId',
      'officialUrls',
      'nextAction',
    ],
    ['projectId'],
  );
  return {
    ledgerId: stringAt(object, 'ledgerId', path),
    lastRunId: stringAt(object, 'lastRunId', path),
    outcome: enumAt(object, 'outcome', path, UNRESOLVED_OUTCOMES),
    checkedAt: timestampAt(object, 'checkedAt', path, now).value,
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
    reason: stringAt(object, 'reason', path),
    ...identityAt(object, path),
    ...optionalProjectId(object, path),
  };
}

function parseEvent(value: unknown, path: string, now: number): PendingLedgerEvent {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    [
      'ledgerId',
      'runId',
      'runStartedAt',
      'runFinishedAt',
      'outcome',
      'checkedAt',
      'evidenceIds',
      'reason',
      'scopeItemId',
      'school',
      'region',
      'targetId',
      'officialUrls',
      'nextAction',
    ],
    ['projectId'],
  );
  const started = timestampAt(object, 'runStartedAt', path, now);
  const finished = timestampAt(object, 'runFinishedAt', path, now);
  const checked = timestampAt(object, 'checkedAt', path, now);
  if (finished.milliseconds < started.milliseconds) {
    throw new Error(`${path} run window is invalid`);
  }
  if (
    checked.milliseconds < started.milliseconds
    || checked.milliseconds > finished.milliseconds
  ) {
    throw new Error(`${path}.checkedAt must belong to the scan run`);
  }
  return {
    ledgerId: stringAt(object, 'ledgerId', path),
    runId: stringAt(object, 'runId', path),
    runStartedAt: started.value,
    runFinishedAt: finished.value,
    outcome: enumAt(object, 'outcome', path, ALL_OUTCOMES),
    checkedAt: checked.value,
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
    reason: stringAt(object, 'reason', path),
    ...identityAt(object, path),
    ...optionalProjectId(object, path),
  };
}

function entryFromEvent(event: PendingLedgerEvent): PendingLedgerEntry {
  if (!UNRESOLVED_OUTCOMES.includes(event.outcome as UnresolvedPendingLedgerOutcome)) {
    throw new Error('resolved events cannot be projected into current entries');
  }
  return {
    ledgerId: event.ledgerId,
    lastRunId: event.runId,
    outcome: event.outcome as UnresolvedPendingLedgerOutcome,
    checkedAt: event.checkedAt,
    evidenceIds: [...event.evidenceIds],
    reason: event.reason,
    ...copyIdentity(event),
    ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
  };
}

function isUnresolved(
  outcome: PendingLedgerOutcome,
): outcome is UnresolvedPendingLedgerOutcome {
  return UNRESOLVED_OUTCOMES.includes(outcome as UnresolvedPendingLedgerOutcome);
}

function ledgerSha256(input: {
  schemaVersion: 1;
  current: Pick<PendingLedgerCurrent, 'generation' | 'previousSha256' | 'entries'>;
  history: PendingLedgerEvent[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: input.schemaVersion,
      current: {
        generation: input.current.generation,
        previousSha256: input.current.previousSha256,
        entries: input.current.entries,
      },
      history: input.history,
    }))
    .digest('hex');
}

function assertUnique(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${path} contains duplicate ${value}`);
    seen.add(value);
  }
}

export function parsePendingLedger(input: unknown): PendingLedger {
  const now = Date.now();
  const object = objectAt(input, 'pending ledger');
  exactKeys(object, 'pending ledger', ['schemaVersion', 'current', 'history']);
  if (object.schemaVersion !== 1) {
    throw new Error('pending ledger.schemaVersion must be exactly 1');
  }

  const currentObject = objectAt(object.current, 'pending ledger.current');
  exactKeys(
    currentObject,
    'pending ledger.current',
    ['generation', 'sha256', 'previousSha256', 'entries'],
  );
  const generation = integerAt(currentObject, 'generation', 'pending ledger.current');
  const claimedSha256 = digestAt(currentObject, 'sha256', 'pending ledger.current');
  const previousSha256 = nullableDigestAt(
    currentObject,
    'previousSha256',
    'pending ledger.current',
  );
  if (generation === 0 && previousSha256 !== null) {
    throw new Error('pending ledger.current.previousSha256 must be null at generation 0');
  }
  if (generation > 0 && previousSha256 === null) {
    throw new Error('pending ledger.current.previousSha256 is required after generation 0');
  }

  if (!Array.isArray(currentObject.entries)) {
    throw new Error('pending ledger.current.entries must be an array');
  }
  const entries = currentObject.entries.map((entry, index) => (
    parseEntry(entry, `pending ledger.current.entries[${index}]`, now)
  ));
  assertUnique(
    entries.map((entry) => entry.ledgerId),
    'pending ledger.current.entries',
  );

  if (!Array.isArray(object.history)) {
    throw new Error('pending ledger.history must be an array');
  }
  const history = object.history.map((event, index) => (
    parseEvent(event, `pending ledger.history[${index}]`, now)
  ));
  assertUnique(
    history.map((event) => `${event.runId}\u0000${event.ledgerId}`),
    'pending ledger.history run/ledger pairs',
  );

  const runWindows = new Map<string, string>();
  const projected = new Map<string, PendingLedgerEntry>();
  for (const event of history) {
    const runWindow = `${event.runStartedAt}\u0000${event.runFinishedAt}`;
    const previousWindow = runWindows.get(event.runId);
    if (previousWindow !== undefined && previousWindow !== runWindow) {
      throw new Error(`pending ledger.history run ${event.runId} has inconsistent timestamps`);
    }
    runWindows.set(event.runId, runWindow);
    if (isUnresolved(event.outcome)) {
      projected.set(event.ledgerId, entryFromEvent(event));
    } else {
      projected.delete(event.ledgerId);
    }
  }
  const projectedEntries = [...projected.values()]
    .sort((left, right) => compareStrings(left.ledgerId, right.ledgerId));
  if (JSON.stringify(entries) !== JSON.stringify(projectedEntries)) {
    throw new Error('pending ledger.current.entries must equal the latest unresolved history');
  }
  if (generation === 0 && (entries.length > 0 || history.length > 0)) {
    throw new Error('pending ledger generation 0 must have empty entries and history');
  }

  const calculatedSha256 = ledgerSha256({
    schemaVersion: 1,
    current: { generation, previousSha256, entries },
    history,
  });
  if (claimedSha256 !== calculatedSha256) {
    throw new Error('pending ledger.current.sha256 does not match ledger contents');
  }

  return {
    schemaVersion: 1,
    current: {
      generation,
      sha256: calculatedSha256,
      previousSha256,
      entries,
    },
    history,
  };
}

function parseRun(input: PendingLedgerRun): PendingLedgerRun & {
  startedMs: number;
  finishedMs: number;
} {
  const now = Date.now();
  const object = objectAt(input, 'run');
  exactKeys(object, 'run', ['runId', 'scanStartedAt', 'scanFinishedAt']);
  const finished = timestampAt(object, 'scanFinishedAt', 'run', now);
  const started = timestampAt(object, 'scanStartedAt', 'run', now);
  if (finished.milliseconds < started.milliseconds) {
    throw new Error('run window is invalid');
  }
  return {
    runId: stringAt(object, 'runId', 'run'),
    scanStartedAt: started.value,
    scanFinishedAt: finished.value,
    startedMs: started.milliseconds,
    finishedMs: finished.milliseconds,
  };
}

function parseUpdate(
  input: PendingUpdate,
  index: number,
  run: ReturnType<typeof parseRun>,
): PendingUpdate {
  const path = `updates[${index}]`;
  const object = objectAt(input, path);
  exactKeys(
    object,
    path,
    [
      'ledgerId',
      'outcome',
      'checkedAt',
      'evidenceIds',
      'reason',
      'scopeItemId',
      'school',
      'region',
      'targetId',
      'officialUrls',
      'nextAction',
    ],
    ['projectId'],
  );
  const checked = timestampAt(object, 'checkedAt', path);
  if (checked.milliseconds < run.startedMs || checked.milliseconds > run.finishedMs) {
    throw new Error(`${path}.checkedAt must belong to the scan run`);
  }
  return {
    ledgerId: stringAt(object, 'ledgerId', path),
    outcome: enumAt(object, 'outcome', path, UPDATE_OUTCOMES),
    checkedAt: checked.value,
    evidenceIds: stringArrayAt(object, 'evidenceIds', path)
      .sort(compareStrings),
    reason: stringAt(object, 'reason', path),
    ...identityAt(object, path),
    ...optionalProjectId(object, path),
  };
}

function parseIdentityMigrations(
  migrations: readonly PendingLedgerIdentityMigration[],
  previousEntries: readonly PendingLedgerEntry[],
): Map<string, string> {
  if (!Array.isArray(migrations)) {
    throw new Error('identity migrations must be an array');
  }
  const previousLedgerIds = new Set(previousEntries.map((entry) => entry.ledgerId));
  const bySource = new Map<string, string>();
  const sourcesByTarget = new Map<string, string>();
  for (const [index, migration] of migrations.entries()) {
    const path = `identity migrations[${index}]`;
    const object = objectAt(migration, path);
    exactKeys(object, path, ['fromLedgerId', 'toLedgerId']);
    const fromLedgerId = stringAt(object, 'fromLedgerId', path);
    const toLedgerId = stringAt(object, 'toLedgerId', path);
    if (fromLedgerId === toLedgerId) {
      throw new Error(`${path} must change the ledger identity`);
    }
    if (!previousLedgerIds.has(fromLedgerId)) {
      throw new Error(`${path}.fromLedgerId is not a current pending entry`);
    }
    if (bySource.has(fromLedgerId)) {
      throw new Error(`identity migrations contains duplicate source ${fromLedgerId}`);
    }
    if (sourcesByTarget.has(toLedgerId)) {
      throw new Error(
        `identity migrations maps multiple sources to ${toLedgerId}`,
      );
    }
    bySource.set(fromLedgerId, toLedgerId);
    sourcesByTarget.set(toLedgerId, fromLedgerId);
  }
  const resolvedSources = new Map<string, string>();
  for (const entry of previousEntries) {
    const resolvedLedgerId = bySource.get(entry.ledgerId) ?? entry.ledgerId;
    const existing = resolvedSources.get(resolvedLedgerId);
    if (existing !== undefined) {
      throw new Error(
        `identity migrations maps both ${existing} and ${entry.ledgerId} to ${resolvedLedgerId}`,
      );
    }
    resolvedSources.set(resolvedLedgerId, entry.ledgerId);
  }
  return bySource;
}

export function buildNextPendingLedger(
  previous: PendingLedger,
  updates: PendingUpdate[],
  run: PendingLedgerRun,
  identityMigrations: readonly PendingLedgerIdentityMigration[] = [],
): PendingLedger {
  const parsedPrevious = parsePendingLedger(previous);
  const parsedRun = parseRun(run);
  if (!Array.isArray(updates)) throw new Error('updates must be an array');
  if (parsedPrevious.history.some((event) => event.runId === parsedRun.runId)) {
    throw new Error(`pending ledger already contains run ${parsedRun.runId}`);
  }
  const parsedUpdates = updates.map((current, index) => (
    parseUpdate(current, index, parsedRun)
  ));
  const migrationsBySource = parseIdentityMigrations(
    identityMigrations,
    parsedPrevious.current.entries,
  );

  const updateCounts = new Map<string, number>();
  for (const current of parsedUpdates) {
    updateCounts.set(current.ledgerId, (updateCounts.get(current.ledgerId) ?? 0) + 1);
  }
  for (const entry of parsedPrevious.current.entries) {
    const resolvedLedgerId = migrationsBySource.get(entry.ledgerId) ?? entry.ledgerId;
    if (updateCounts.get(resolvedLedgerId) !== 1) {
      throw new Error(
        `pending ledger entry ${entry.ledgerId} must receive exactly one current-run update for ${resolvedLedgerId}`,
      );
    }
  }
  for (const [ledgerId, count] of updateCounts) {
    if (count !== 1) {
      throw new Error(
        `pending ledger entry ${ledgerId} must receive exactly one current-run update`,
      );
    }
  }

  const updatesByLedgerId = new Map(
    parsedUpdates.map((update) => [update.ledgerId, update] as const),
  );
  const migrationEvents: PendingLedgerEvent[] = parsedPrevious.current.entries
    .filter((entry) => migrationsBySource.has(entry.ledgerId))
    .sort((left, right) => compareStrings(left.ledgerId, right.ledgerId))
    .map((entry) => {
      const toLedgerId = migrationsBySource.get(entry.ledgerId)!;
      const update = updatesByLedgerId.get(toLedgerId)!;
      return {
        ledgerId: entry.ledgerId,
        runId: parsedRun.runId,
        runStartedAt: parsedRun.scanStartedAt,
        runFinishedAt: parsedRun.scanFinishedAt,
        outcome: 'identity-migrated' as const,
        checkedAt: update.checkedAt,
        evidenceIds: [...update.evidenceIds],
        reason: `identity migrated to ${toLedgerId}`,
        ...copyIdentity(entry),
        ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
      };
    });
  const events: PendingLedgerEvent[] = parsedUpdates
    .sort((left, right) => compareStrings(left.ledgerId, right.ledgerId))
    .map((current) => ({
      ledgerId: current.ledgerId,
      runId: parsedRun.runId,
      runStartedAt: parsedRun.scanStartedAt,
      runFinishedAt: parsedRun.scanFinishedAt,
      outcome: current.outcome,
      checkedAt: current.checkedAt,
      evidenceIds: [...current.evidenceIds],
      reason: current.reason,
      ...copyIdentity(current),
      ...(current.projectId === undefined ? {} : { projectId: current.projectId }),
    }));
  const history = [...parsedPrevious.history, ...migrationEvents, ...events];

  const projected = new Map(
    parsedPrevious.current.entries.map((entry) => [entry.ledgerId, entry] as const),
  );
  for (const event of [...migrationEvents, ...events]) {
    if (isUnresolved(event.outcome)) {
      projected.set(event.ledgerId, entryFromEvent(event));
    } else {
      projected.delete(event.ledgerId);
    }
  }
  const entries = [...projected.values()]
    .sort((left, right) => compareStrings(left.ledgerId, right.ledgerId));
  const generation = parsedPrevious.current.generation + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new Error('pending ledger generation cannot be incremented safely');
  }
  const next: PendingLedger = {
    schemaVersion: 1,
    current: {
      generation,
      sha256: '',
      previousSha256: parsedPrevious.current.sha256,
      entries,
    },
    history,
  };
  next.current.sha256 = ledgerSha256(next);
  return parsePendingLedger(next);
}

async function readLedgerFile(path: string): Promise<PendingLedger> {
  let information: Awaited<ReturnType<typeof lstat>>;
  try {
    information = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error('pending ledger does not exist');
    }
    throw error;
  }
  if (information.isSymbolicLink()) {
    throw new Error('pending ledger path must not be a symbolic link');
  }
  if (!information.isFile()) {
    throw new Error('pending ledger path must be a regular file');
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `pending ledger could not be read as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parsePendingLedger(input);
}

function assertHistoryPrefix(
  previous: PendingLedgerEvent[],
  next: PendingLedgerEvent[],
): void {
  if (next.length < previous.length) {
    throw new Error('pending ledger history is immutable and cannot be truncated');
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) {
      throw new Error(`pending ledger history event ${index} is immutable`);
    }
  }
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

interface LockState {
  owner: LockOwner;
  dev: number;
  ino: number;
}

interface OwnedLock {
  handle: FileHandle;
  ownerPath: string;
  path: string;
  token: string;
}

export interface PendingLedgerCommitHooks {
  afterLockAcquired?: (lockPath: string) => void | Promise<void>;
}

function lockedByAnotherWriter(): Error {
  return new Error('pending ledger is locked by another writer');
}

function parseLockOwner(input: unknown): LockOwner {
  const owner = objectAt(input, 'pending ledger lock owner');
  exactKeys(
    owner,
    'pending ledger lock owner',
    ['token', 'pid', 'createdAt'],
  );
  if (
    typeof owner.token !== 'string'
    || !LOCK_TOKEN_PATTERN.test(owner.token)
  ) {
    throw new Error('pending ledger lock owner.token must be a UUID v4');
  }
  if (
    !Number.isSafeInteger(owner.pid)
    || (owner.pid as number) <= 0
    || (owner.pid as number) > MAX_PROCESS_ID
  ) {
    throw new Error('pending ledger lock owner.pid must be a process ID');
  }
  if (typeof owner.createdAt !== 'string') {
    throw new Error('pending ledger lock owner.createdAt must be an ISO timestamp');
  }
  const createdAtMilliseconds = Date.parse(owner.createdAt);
  if (
    !Number.isFinite(createdAtMilliseconds)
    || new Date(createdAtMilliseconds).toISOString() !== owner.createdAt
    || createdAtMilliseconds > Date.now()
  ) {
    throw new Error('pending ledger lock owner.createdAt must be a past ISO timestamp');
  }
  return {
    token: owner.token,
    pid: owner.pid as number,
    createdAt: owner.createdAt,
  };
}

function sameInode(
  left: Pick<LockState, 'dev' | 'ino'>,
  right: Pick<LockState, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readLockState(path: string): Promise<LockState> {
  const pathInformation = await lstat(path);
  if (
    pathInformation.isSymbolicLink()
    || !pathInformation.isFile()
    || pathInformation.size <= 0
    || pathInformation.size > LOCK_MAX_BYTES
  ) {
    throw new Error('pending ledger lock must be a small regular file');
  }
  const handle = await open(path, 'r');
  try {
    const handleInformation = await handle.stat();
    const latestPathInformation = await lstat(path);
    if (
      !handleInformation.isFile()
      || latestPathInformation.isSymbolicLink()
      || !latestPathInformation.isFile()
      || handleInformation.dev !== pathInformation.dev
      || handleInformation.ino !== pathInformation.ino
      || latestPathInformation.dev !== handleInformation.dev
      || latestPathInformation.ino !== handleInformation.ino
    ) {
      throw new Error('pending ledger lock changed while being read');
    }
    return {
      owner: parseLockOwner(JSON.parse(await handle.readFile('utf8'))),
      dev: handleInformation.dev,
      ino: handleInformation.ino,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function ownerIsStale(owner: LockOwner): boolean {
  return Date.now() - Date.parse(owner.createdAt) > LOCK_STALE_AFTER_MS;
}

function ownerIsDefinitelyGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasErrorCode(error, 'ESRCH');
  }
}

async function tryCreateLock(lockPath: string): Promise<OwnedLock | undefined> {
  const token = randomUUID();
  const owner: LockOwner = {
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const ownerPath = `${lockPath}.${process.pid}.${token}.owner`;
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await open(ownerPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    try {
      await link(ownerPath, lockPath);
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) return undefined;
      throw error;
    }
    published = true;
    await unlink(ownerPath).catch(() => undefined);
    return { handle, ownerPath, path: lockPath, token };
  } finally {
    if (!published) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(ownerPath).catch(() => undefined);
    }
  }
}

async function unlinkMatchingLock(
  path: string,
  expected: LockState,
): Promise<boolean> {
  let latest: Awaited<ReturnType<typeof lstat>>;
  try {
    latest = await lstat(path);
  } catch {
    return false;
  }
  if (
    latest.isSymbolicLink()
    || !latest.isFile()
    || latest.dev !== expected.dev
    || latest.ino !== expected.ino
  ) {
    return false;
  }
  try {
    const current = await readLockState(path);
    if (
      current.owner.token !== expected.owner.token
      || !sameInode(current, expected)
    ) {
      return false;
    }
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function recoverStaleLock(
  lockPath: string,
  observed: LockState,
): Promise<OwnedLock> {
  const claimPath = `${lockPath}.stale-${observed.owner.token}`;
  let claim: LockState | undefined;
  try {
    try {
      await link(lockPath, claimPath);
    } catch {
      throw lockedByAnotherWriter();
    }
    try {
      claim = await readLockState(claimPath);
      const current = await readLockState(lockPath);
      if (
        claim.owner.token !== observed.owner.token
        || current.owner.token !== observed.owner.token
        || !sameInode(claim, observed)
        || !sameInode(current, claim)
        || !ownerIsStale(claim.owner)
        || !ownerIsDefinitelyGone(claim.owner.pid)
      ) {
        throw lockedByAnotherWriter();
      }
      if (!await unlinkMatchingLock(lockPath, claim)) {
        throw lockedByAnotherWriter();
      }
      let recovered: OwnedLock | undefined;
      try {
        recovered = await tryCreateLock(lockPath);
      } catch {
        await link(claimPath, lockPath).catch(() => undefined);
        throw lockedByAnotherWriter();
      }
      if (recovered === undefined) throw lockedByAnotherWriter();
      return recovered;
    } catch {
      throw lockedByAnotherWriter();
    }
  } finally {
    if (claim !== undefined) {
      await unlinkMatchingLock(claimPath, claim);
    }
  }
}

async function acquireLock(lockPath: string): Promise<OwnedLock> {
  const acquired = await tryCreateLock(lockPath);
  if (acquired !== undefined) return acquired;
  let observed: LockState;
  try {
    observed = await readLockState(lockPath);
  } catch {
    throw lockedByAnotherWriter();
  }
  if (
    !ownerIsStale(observed.owner)
    || !ownerIsDefinitelyGone(observed.owner.pid)
  ) {
    throw lockedByAnotherWriter();
  }
  return recoverStaleLock(lockPath, observed);
}

async function releaseLock(lock: OwnedLock): Promise<void> {
  try {
    const [ownedInformation, current] = await Promise.all([
      lock.handle.stat(),
      readLockState(lock.path),
    ]);
    if (
      current.owner.token === lock.token
      && current.dev === ownedInformation.dev
      && current.ino === ownedInformation.ino
    ) {
      await unlinkMatchingLock(lock.path, current);
    }
  } catch {
    // A missing, malformed or replaced lock is not ours to remove.
  } finally {
    await lock.handle.close().catch(() => undefined);
    await unlink(lock.ownerPath).catch(() => undefined);
  }
}

export async function commitPendingLedger(
  path: string,
  expectedGeneration: number,
  expectedSha256: string,
  next: PendingLedger,
  hooks: PendingLedgerCommitHooks = {},
): Promise<void> {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('pending ledger path must be a non-empty string');
  }
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new Error('expectedGeneration must be a non-negative safe integer');
  }
  if (!DIGEST_PATTERN.test(expectedSha256)) {
    throw new Error('expectedSha256 must be a SHA-256 digest');
  }
  const normalizedExpectedSha256 = expectedSha256.toLowerCase();
  const parsedNext = parsePendingLedger(next);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const lockPath = join(parent, `.${basename(path)}.lock`);
  const lock = await acquireLock(lockPath);

  const tempPath = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let tempHandle: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;
  try {
    await hooks.afterLockAcquired?.(lockPath);
    const current = await readLedgerFile(path);
    if (current.current.generation !== expectedGeneration) {
      throw new Error('stale pending ledger generation');
    }
    if (current.current.sha256 !== normalizedExpectedSha256) {
      throw new Error('stale pending ledger digest');
    }
    if (parsedNext.current.generation !== expectedGeneration + 1) {
      throw new Error('next pending ledger must advance generation exactly once');
    }
    if (parsedNext.current.previousSha256 !== normalizedExpectedSha256) {
      throw new Error('next pending ledger must reference the expected previous digest');
    }
    assertHistoryPrefix(current.history, parsedNext.history);

    tempHandle = await open(tempPath, 'wx', 0o600);
    await tempHandle.writeFile(`${JSON.stringify(parsedNext, null, 2)}\n`, 'utf8');
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;
    directoryHandle = await open(parent, 'r');

    const latest = await readLedgerFile(path);
    if (
      latest.current.generation !== expectedGeneration
      || latest.current.sha256 !== normalizedExpectedSha256
    ) {
      throw new Error('pending ledger changed concurrently before atomic rename');
    }
    await rename(tempPath, path);
    try {
      await directoryHandle.sync();
    } catch {
      // The atomic rename is already committed; a directory fsync failure cannot roll it back.
    }
  } finally {
    if (tempHandle !== undefined) await tempHandle.close().catch(() => undefined);
    if (directoryHandle !== undefined) await directoryHandle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    await releaseLock(lock);
  }
}
