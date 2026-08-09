import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { approveAdditiveSnapshotFile } from './approve-snapshot.js';

interface CliOptions {
  run: string;
  parent: string;
  approved: string;
  decision: string;
  approvedAt?: string;
  registry?: string;
  sentinels?: string;
}

const usage =
  'Usage: snapshot:approve-additive -- --run PATH --parent PATH --approved PATH --decision PATH [--approved-at ISO_TIMESTAMP] [--registry PATH --sentinels PATH]';

function quoted(value: string): string {
  return JSON.stringify(value);
}

function parseCliOptions(argv: string[]): CliOptions {
  const allowed = new Set([
    '--run',
    '--parent',
    '--approved',
    '--decision',
    '--approved-at',
    '--registry',
    '--sentinels',
  ]);
  const values = new Map<string, string>();
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
  const run = values.get('--run');
  const parent = values.get('--parent');
  const approved = values.get('--approved');
  const decision = values.get('--decision');
  if (run === undefined || parent === undefined || approved === undefined || decision === undefined) {
    throw new Error(`missing required argument\n${usage}`);
  }
  const registry = values.get('--registry');
  const sentinels = values.get('--sentinels');
  if ((registry === undefined) !== (sentinels === undefined)) {
    throw new Error(`--registry and --sentinels must be provided together\n${usage}`);
  }
  return {
    run,
    parent,
    approved,
    decision,
    approvedAt: values.get('--approved-at'),
    registry,
    sentinels,
  };
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const result = await approveAdditiveSnapshotFile({
    runPath: options.run,
    parentPath: options.parent,
    approvedPath: options.approved,
    decisionPath: options.decision,
    approvedAt: options.approvedAt ?? new Date().toISOString(),
    registryPath: options.registry,
    sentinelsPath: options.sentinels,
  });
  console.log(JSON.stringify(result));
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  runCli().catch((error: unknown) => {
    console.error(
      `additive snapshot approval failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
