import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readRegularJsonFile,
  validateStoredApprovedSnapshot,
} from '../../src/lib/snapshot-integrity.js';
import type { PublicSnapshot } from '../../src/lib/snapshot-types.js';

interface CliOptions {
  approved: string;
}

const usage = 'Usage: snapshot:validate -- [--approved PATH]';

function quoted(value: string): string {
  return JSON.stringify(value);
}

function parseCliOptions(argv: string[]): CliOptions {
  if (argv.length === 0) return { approved: 'data/approved/current.json' };
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--approved') throw new Error(`unknown argument: ${quoted(flag)}\n${usage}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${quoted(flag)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${quoted(flag)}\n${usage}`);
    }
    values.set(flag, value);
    index += 1;
  }
  return { approved: values.get('--approved')! };
}

async function readSnapshot(path: string): Promise<unknown> {
  return (await readRegularJsonFile(path, 'approved snapshot')).value;
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const input = await readSnapshot(options.approved);
  const errors = validateStoredApprovedSnapshot(input);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const snapshot = input as PublicSnapshot;
  console.log(
    `confirmedOpen=${snapshot.counts.confirmedOpen} `
      + `confirmedUnknownDeadline=${snapshot.counts.confirmedUnknownDeadline} `
      + `pendingExcluded=${snapshot.counts.pendingExcluded} `
      + `expired=${snapshot.counts.expired}`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  runCli().catch((error: unknown) => {
    console.error(
      `snapshot validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
