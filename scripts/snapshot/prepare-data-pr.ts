import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  readRegularJsonFile,
  validateApprovedSnapshot,
} from '../../src/lib/snapshot-integrity.js';
import type { PublicSnapshot } from '../../src/lib/snapshot-types.js';
import { validatePublicPrivacyBoundary } from '../../src/lib/snapshot-validation.js';

const execFileAsync = promisify(execFile);

const DATA_ONLY_ALLOWLIST = new Set([
  'data/approved/current.json',
  'data/project-id-aliases.json',
]);

export interface PrepareDataPrInput {
  base: unknown;
  next: unknown;
  changedFiles: string[];
  aliases?: unknown;
  now?: Date;
}

export interface NoChangePlan {
  status: 'no-change';
  dataHash: string;
  snapshotId: string;
  changedFiles: [];
}

export interface ReadyDataPrPlan {
  status: 'ready';
  branchName: string;
  commitMessage: string;
  prTitle: string;
  changedFiles: string[];
  dataHash: string;
  snapshotId: string;
  previousSnapshotId: string;
  counts: PublicSnapshot['counts'];
}

export type DataPrPlan = NoChangePlan | ReadyDataPrPlan;

interface CliOptions {
  baseRef: string;
}

const usage = 'Usage: data-pr:prepare -- --base-ref GIT_REF';

function quoted(value: string): string {
  return JSON.stringify(value);
}

function assertDataOnlyFiles(changedFiles: string[]): string[] {
  const unique = [...new Set(changedFiles)].sort();
  for (const file of unique) {
    if (!DATA_ONLY_ALLOWLIST.has(file)) {
      throw new Error(`changed file ${quoted(file)} is outside the data-only allowlist`);
    }
  }
  return unique;
}

function assertProjectId(value: string, path: string): void {
  const parts = value.split('|').map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => part === '') || !/^\d{4}$/.test(parts[0])) {
    throw new Error(`${path} must be a four-part project ID`);
  }
}

function validateAliases(input: unknown): void {
  const privacyErrors = validatePublicPrivacyBoundary(input, 'aliases');
  if (privacyErrors.length > 0) {
    throw new Error(`alias privacy validation failed:\n${privacyErrors.join('\n')}`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('aliases must be an object');
  }
  const entries = Object.entries(input);
  if (entries.length > 10_000) throw new Error('aliases exceed the entry limit');
  for (const [key, targetProjectId] of entries) {
    if (typeof targetProjectId !== 'string') {
      throw new Error(`alias ${quoted(key)} must map to a project ID`);
    }
    const separator = key.indexOf('::');
    const urlText = separator === -1 ? key : key.slice(0, separator);
    const inputProjectId = separator === -1 ? null : key.slice(separator + 2);
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new Error(`alias ${quoted(key)} must start with a valid URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error(`alias ${quoted(key)} must use a public HTTP(S) URL without credentials or fragment`);
    }
    if (inputProjectId !== null) assertProjectId(inputProjectId, `alias ${quoted(key)} input`);
    assertProjectId(targetProjectId, `alias ${quoted(key)} target`);
  }
}

function validateSnapshot(input: unknown, label: string, nowMs: number): PublicSnapshot {
  const errors = validateApprovedSnapshot(input, nowMs);
  if (errors.length > 0) {
    throw new Error(`${label} is not a valid approved snapshot:\n${errors.join('\n')}`);
  }
  return input as PublicSnapshot;
}

function compactUtcTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
}

function beijingDate(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error('next scanAt must be a valid timestamp');
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function prepareDataPrPlan(input: PrepareDataPrInput): DataPrPlan {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');

  const changedFiles = assertDataOnlyFiles(input.changedFiles);
  const base = validateSnapshot(input.base, 'base snapshot', now.getTime());
  const next = validateSnapshot(input.next, 'next snapshot', now.getTime());

  if (changedFiles.includes('data/project-id-aliases.json')) {
    if (input.aliases === undefined) throw new Error('changed alias file requires alias contents');
    validateAliases(input.aliases);
  } else if (input.aliases !== undefined) {
    throw new Error('alias contents were provided without a changed alias file');
  }

  if (base.dataHash === next.dataHash) {
    if (changedFiles.length > 0) {
      throw new Error('no-change snapshot cannot include changed data-only files');
    }
    return {
      status: 'no-change',
      dataHash: next.dataHash,
      snapshotId: next.snapshotId,
      changedFiles: [],
    };
  }

  if (!changedFiles.includes('data/approved/current.json')) {
    throw new Error('changed snapshot requires data/approved/current.json in the data-only allowlist');
  }
  if (next.previousSnapshotId !== base.snapshotId) {
    throw new Error('next previousSnapshotId must equal the base snapshotId');
  }

  const date = beijingDate(next.scanAt);
  return {
    status: 'ready',
    branchName: `codex/data-refresh-${compactUtcTimestamp(now)}`,
    commitMessage: `data: publish ${date} admissions snapshot`,
    prTitle: `data: refresh admissions snapshot (${date})`,
    changedFiles,
    dataHash: next.dataHash,
    snapshotId: next.snapshotId,
    previousSnapshotId: base.snapshotId,
    counts: structuredClone(next.counts),
  };
}

function parseCliOptions(argv: string[]): CliOptions {
  if (argv.length !== 2 || argv[0] !== '--base-ref') throw new Error(usage);
  const baseRef = argv[1];
  if (!/^(?!-)(?!.*\.\.)[a-z0-9._/-]+$/i.test(baseRef)) {
    throw new Error('base ref contains unsupported characters');
  }
  return { baseRef };
}

async function runGit(repositoryRoot: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0]} failed: ${message}`);
  }
}

function nulList(output: string): string[] {
  return output.split('\0').filter((value) => value !== '');
}

export async function collectGitChangedFiles(
  repositoryRoot: string,
  baseRef: string,
): Promise<string[]> {
  await runGit(repositoryRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const [tracked, untracked] = await Promise.all([
    runGit(repositoryRoot, [
      'diff',
      '--name-only',
      '-z',
      '--diff-filter=ACDMRTUXB',
      baseRef,
      '--',
    ]),
    runGit(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return [...new Set([...nulList(tracked), ...nulList(untracked)])].sort();
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const repositoryRoot = (await runGit(resolve('.'), ['rev-parse', '--show-toplevel'])).trim();
  const changedFiles = await collectGitChangedFiles(repositoryRoot, options.baseRef);
  const [baseText, next, aliases] = await Promise.all([
    runGit(repositoryRoot, ['show', `${options.baseRef}:data/approved/current.json`]),
    readRegularJsonFile(resolve(repositoryRoot, 'data/approved/current.json'), 'next approved snapshot'),
    changedFiles.includes('data/project-id-aliases.json')
      ? readRegularJsonFile(resolve(repositoryRoot, 'data/project-id-aliases.json'), 'project ID aliases')
      : Promise.resolve(null),
  ]);
  let base: unknown;
  try {
    base = JSON.parse(baseText);
  } catch {
    throw new Error('base approved snapshot from Git is not valid JSON');
  }
  const plan = prepareDataPrPlan({
    base,
    next: next.value,
    changedFiles,
    ...(aliases === null ? {} : { aliases: aliases.value }),
  });
  console.log(JSON.stringify(plan, null, 2));
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  runCli().catch((error: unknown) => {
    console.error(`data PR planning failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
