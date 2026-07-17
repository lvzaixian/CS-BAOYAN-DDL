import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  readRegularJsonFile,
  validateApprovedSnapshot,
} from '../../src/lib/snapshot-integrity.js';
import type { RegularJsonFile } from '../../src/lib/snapshot-integrity.js';
import type { PublicSnapshot } from '../../src/lib/snapshot-types.js';
import { validatePublicPrivacyBoundary } from '../../src/lib/snapshot-validation.js';
import { validateProjectIdAliases } from './import-scouting-data.js';

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

export interface GitChangeSet {
  baseRef: string;
  baseOid: string;
  headOid: string;
  changedFiles: string[];
  stagedFiles: string[];
}

const REQUIRED_BASE_REF = 'origin/main';
const usage = `Usage: data-pr:prepare -- --base-ref ${REQUIRED_BASE_REF}`;

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

function validateAliases(input: unknown, base: PublicSnapshot): void {
  const privacyErrors = validatePublicPrivacyBoundary(input, 'aliases');
  if (privacyErrors.length > 0) {
    throw new Error(`alias privacy validation failed:\n${privacyErrors.join('\n')}`);
  }
  validateProjectIdAliases(input, base);
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
    validateAliases(input.aliases, base);
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
  if (baseRef !== REQUIRED_BASE_REF) {
    throw new Error(`base ref must be ${REQUIRED_BASE_REF}`);
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

export type GitCommandRunner = (repositoryRoot: string, args: string[]) => Promise<string>;

function nulList(output: string): string[] {
  return output.split('\0').filter((value) => value !== '');
}

function contentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function assertRegularJsonFileStable(
  path: string,
  label: string,
  expected: RegularJsonFile,
): Promise<void> {
  const actual = await readRegularJsonFile(path, label);
  if (actual.text !== expected.text) {
    throw new Error(`${label} content changed during data PR preparation`);
  }
}

export async function collectGitChangeSet(
  repositoryRoot: string,
  baseRef: string,
  runGitCommand: GitCommandRunner = runGit,
): Promise<GitChangeSet> {
  const baseOid = (await runGitCommand(
    repositoryRoot,
    ['rev-parse', '--verify', `${baseRef}^{commit}`],
  )).trim();
  const headOid = (await runGitCommand(
    repositoryRoot,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
  )).trim();
  try {
    await runGitCommand(repositoryRoot, ['merge-base', '--is-ancestor', baseOid, headOid]);
  } catch {
    throw new Error(`${baseRef} must be an ancestor of HEAD; fetch origin/main and rebase first`);
  }
  const [tracked, untracked, staged] = await Promise.all([
    runGitCommand(repositoryRoot, [
      'diff',
      '--name-only',
      '-z',
      '--diff-filter=ACDMRTUXB',
      baseOid,
      '--',
    ]),
    runGitCommand(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    runGitCommand(repositoryRoot, [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      '--diff-filter=ACDMRTUXB',
      '--',
    ]),
  ]);
  return {
    baseRef,
    baseOid,
    headOid,
    changedFiles: [...new Set([...nulList(tracked), ...nulList(untracked)])].sort(),
    stagedFiles: [...new Set(nulList(staged))].sort(),
  };
}

export async function collectGitChangedFiles(
  repositoryRoot: string,
  baseRef: string,
): Promise<string[]> {
  return (await collectGitChangeSet(repositoryRoot, baseRef)).changedFiles;
}

export async function assertGitChangeSetStable(
  repositoryRoot: string,
  expected: GitChangeSet,
  runGitCommand: GitCommandRunner = runGit,
): Promise<void> {
  const actual = await collectGitChangeSet(repositoryRoot, expected.baseRef, runGitCommand);
  if (actual.baseOid !== expected.baseOid) {
    throw new Error('base ref moved during data PR preparation');
  }
  if (actual.headOid !== expected.headOid) {
    throw new Error('HEAD moved during data PR preparation');
  }
  if (
    actual.changedFiles.length !== expected.changedFiles.length
    || actual.changedFiles.some((file, index) => file !== expected.changedFiles[index])
  ) {
    throw new Error('changed files moved during data PR preparation');
  }
  if (
    actual.stagedFiles.length !== expected.stagedFiles.length
    || actual.stagedFiles.some((file, index) => file !== expected.stagedFiles[index])
  ) {
    throw new Error('staged files moved during data PR preparation');
  }
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const repositoryRoot = (await runGit(resolve('.'), ['rev-parse', '--show-toplevel'])).trim();
  const gitState = await collectGitChangeSet(repositoryRoot, options.baseRef);
  if (gitState.stagedFiles.length > 0) {
    throw new Error('Git index must be clean before data PR preparation');
  }
  const { changedFiles } = gitState;
  const [baseText, next, aliases] = await Promise.all([
    runGit(repositoryRoot, ['show', `${gitState.baseOid}:data/approved/current.json`]),
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
  await assertGitChangeSetStable(repositoryRoot, gitState);
  await Promise.all([
    assertRegularJsonFileStable(
      resolve(repositoryRoot, 'data/approved/current.json'),
      'next approved snapshot',
      next,
    ),
    ...(aliases === null
      ? []
      : [assertRegularJsonFileStable(
          resolve(repositoryRoot, 'data/project-id-aliases.json'),
          'project ID aliases',
          aliases,
        )]),
  ]);
  console.log(JSON.stringify({
    ...plan,
    audit: {
      baseRef: gitState.baseRef,
      baseOid: gitState.baseOid,
      headOid: gitState.headOid,
      contentSha256: {
        'data/approved/current.json': contentSha256(next.text),
        ...(aliases === null
          ? {}
          : { 'data/project-id-aliases.json': contentSha256(aliases.text) }),
      },
    },
  }, null, 2));
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  runCli().catch((error: unknown) => {
    console.error(`data PR planning failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
