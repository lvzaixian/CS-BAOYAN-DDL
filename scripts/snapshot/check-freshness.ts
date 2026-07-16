import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readRegularJsonFile } from './approve-snapshot.js';

type JsonObject = Record<string, unknown>;

interface CliOptions {
  snapshot: string;
  maxAgeMs: number;
}

const usage = 'Usage: snapshot:check-freshness -- --snapshot PATH --max-age-hours HOURS';
const millisecondsPerHour = 60 * 60 * 1000;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function parseIsoTimestamp(value: unknown, field: string, errors: string[]): number | null {
  if (value === undefined) {
    errors.push(`${field}: is required`);
    return null;
  }
  if (typeof value !== 'string') {
    errors.push(`${field}: expected a valid ISO timestamp string`);
    return null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) {
    errors.push(`${field}: expected a valid ISO timestamp`);
    return null;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  const parsed = Date.parse(value);
  if (
    day < 1
    || day > daysInMonth
    || Number(hourText) > 23
    || Number(minuteText) > 59
    || Number(secondText) > 59
    || (offsetHour !== undefined && Number(offsetHour) > 23)
    || (offsetMinute !== undefined && Number(offsetMinute) > 59)
    || !Number.isFinite(parsed)
  ) {
    errors.push(`${field}: expected a valid ISO timestamp`);
    return null;
  }
  return parsed;
}

export function checkSnapshotFreshness(
  snapshot: unknown,
  nowMs: number,
  maxAgeMs: number,
): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(nowMs)) {
    errors.push('nowMs: expected a finite number');
  } else if (!Number.isSafeInteger(nowMs)) {
    errors.push('nowMs: expected a safe integer number of milliseconds');
  }
  if (!Number.isFinite(maxAgeMs)) {
    errors.push('maxAgeMs: expected a finite number');
  } else if (maxAgeMs <= 0) {
    errors.push('maxAgeMs: expected a positive number of milliseconds');
  } else if (!Number.isSafeInteger(maxAgeMs)) {
    errors.push('maxAgeMs: expected a safe integer number of milliseconds');
  }
  if (!isObject(snapshot)) {
    errors.push('snapshot: expected an object');
    return errors;
  }

  const scanAtMs = parseIsoTimestamp(snapshot.scanAt, 'scanAt', errors);
  const approvedAtMs = parseIsoTimestamp(snapshot.approvedAt, 'approvedAt', errors);
  if (
    scanAtMs === null
    || approvedAtMs === null
    || !Number.isSafeInteger(nowMs)
    || !Number.isSafeInteger(maxAgeMs)
    || maxAgeMs <= 0
  ) {
    return errors;
  }

  if (scanAtMs > nowMs) errors.push('scanAt: must not be in the future');
  if (approvedAtMs > nowMs) errors.push('approvedAt: must not be in the future');
  if (approvedAtMs < scanAtMs) errors.push('approvedAt: must not be before scanAt');
  if (nowMs - scanAtMs > maxAgeMs) {
    errors.push('scanAt: is older than the maximum age');
  }
  if (nowMs - approvedAtMs > maxAgeMs) {
    errors.push('approvedAt: is older than the maximum age');
  }
  return errors;
}

function parseMaxAgeMs(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error('--max-age-hours must be a positive decimal number');
  }
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('--max-age-hours must be positive');
  }
  const maxAgeMs = hours * millisecondsPerHour;
  if (!Number.isSafeInteger(maxAgeMs)) {
    throw new Error('--max-age-hours must resolve to a safe millisecond integer');
  }
  return maxAgeMs;
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set(['--snapshot', '--max-age-hours']);
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
  const snapshot = values.get('--snapshot');
  const maxAgeHours = values.get('--max-age-hours');
  if (snapshot === undefined || maxAgeHours === undefined) {
    throw new Error(`missing required argument\n${usage}`);
  }
  return { snapshot, maxAgeMs: parseMaxAgeMs(maxAgeHours) };
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const input = (await readRegularJsonFile(options.snapshot, 'snapshot')).value;
  const errors = checkSnapshotFreshness(input, Date.now(), options.maxAgeMs);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log('Snapshot freshness confirmed');
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  runCli().catch((error: unknown) => {
    console.error(
      `snapshot freshness check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
