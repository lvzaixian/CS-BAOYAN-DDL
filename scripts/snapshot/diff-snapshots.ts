import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  PublicOpportunity,
  PublicSnapshot,
  SnapshotCandidate,
} from '../../src/lib/snapshot-types.js';
import { validateCandidate, validateSnapshot } from '../../src/lib/snapshot-validation.js';

export interface SnapshotDiff {
  added: string[];
  changed: string[];
  expired: string[];
  removed: string[];
}

interface CliOptions {
  previous?: string;
  next: string;
  output: string;
}

type JsonObject = Record<string, unknown>;

const usage =
  'Usage: snapshot:diff -- [--previous PATH] --next PATH --output PATH';

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

function publicationFingerprint(opportunity: PublicOpportunity): string {
  const publication = { ...opportunity } as JsonObject;
  delete publication.verifiedAt;
  if (typeof publication.description === 'string') {
    publication.description = publication.description.replace(/\s+/gu, ' ').trim();
  }
  return JSON.stringify(canonicalize(publication));
}

export function diffSnapshots(
  previous: PublicSnapshot | null,
  next: SnapshotCandidate,
): SnapshotDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const expired: string[] = [];
  const removed: string[] = [];
  const previousById = new Map(
    (previous?.opportunities ?? []).map((opportunity) => [opportunity.projectId, opportunity]),
  );
  const nextById = new Map(
    next.opportunities.map((opportunity) => [opportunity.projectId, opportunity]),
  );

  for (const [projectId, nextOpportunity] of nextById) {
    const previousOpportunity = previousById.get(projectId);
    if (previousOpportunity === undefined) {
      added.push(projectId);
    } else if (
      previousOpportunity.verificationStatus !== 'expired'
      && nextOpportunity.verificationStatus === 'expired'
    ) {
      expired.push(projectId);
    } else if (
      publicationFingerprint(previousOpportunity) !== publicationFingerprint(nextOpportunity)
    ) {
      changed.push(projectId);
    }
  }

  for (const projectId of previousById.keys()) {
    if (!nextById.has(projectId)) removed.push(projectId);
  }

  return {
    added: added.sort(codePointCompare),
    changed: changed.sort(codePointCompare),
    expired: expired.sort(codePointCompare),
    removed: removed.sort(codePointCompare),
  };
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set(['--previous', '--next', '--output']);
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
  const next = values.get('--next');
  const output = values.get('--output');
  if (next === undefined || output === undefined) {
    throw new Error(`missing required argument\n${usage}`);
  }
  return { previous: values.get('--previous'), next, output };
}

async function readJson(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} could not be read at ${path}: ${String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${path}: ${String(error)}`);
  }
}

function referenceTime(value: unknown, key: 'scanAt' | 'approvedAt'): number {
  if (value !== null && typeof value === 'object') {
    const timestamp = (value as JsonObject)[key];
    if (typeof timestamp === 'string') return Date.parse(timestamp);
  }
  return 0;
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const protectedPaths = [options.next, options.previous].filter(
    (path): path is string => path !== undefined,
  );
  if (protectedPaths.some((path) => resolve(path) === resolve(options.output))) {
    throw new Error('--output must not collide with an input path');
  }

  const [nextInput, previousInput] = await Promise.all([
    readJson(options.next, 'next candidate'),
    options.previous === undefined
      ? Promise.resolve(null)
      : readJson(options.previous, 'previous snapshot'),
  ]);
  const candidateErrors = validateCandidate(nextInput, referenceTime(nextInput, 'scanAt'));
  if (candidateErrors.length > 0) {
    throw new Error(`Next candidate validation failed:\n${candidateErrors.join('\n')}`);
  }
  if (previousInput !== null) {
    const previousErrors = validateSnapshot(
      previousInput,
      referenceTime(previousInput, 'approvedAt'),
    );
    if (previousErrors.length > 0) {
      throw new Error(`Previous snapshot validation failed:\n${previousErrors.join('\n')}`);
    }
  }

  const diff = diffSnapshots(
    previousInput as PublicSnapshot | null,
    nextInput as SnapshotCandidate,
  );
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  console.log(`Wrote snapshot diff to ${options.output}`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  runCli().catch((error: unknown) => {
    console.error(`snapshot diff failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
