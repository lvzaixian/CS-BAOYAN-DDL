import { pathToFileURL } from 'node:url';

import { readRegularJsonFile } from '../../src/lib/snapshot-integrity.js';
import {
  commitPendingLedger,
  parsePendingLedger,
} from './pending-ledger.js';

interface CliOptions {
  current: string;
  next: string;
  expectedGeneration: number;
  expectedSha256: string;
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--current',
    '--next',
    '--expected-generation',
    '--expected-sha256',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(flag) ||
      value === undefined ||
      value.startsWith('--') ||
      values.has(flag)
    ) {
      throw new Error(`invalid pending commit argument ${JSON.stringify(flag)}`);
    }
    values.set(flag, value);
  }
  const current = values.get('--current');
  const next = values.get('--next');
  const generationText = values.get('--expected-generation');
  const expectedSha256 = values.get('--expected-sha256');
  if (
    current === undefined ||
    next === undefined ||
    generationText === undefined ||
    expectedSha256 === undefined
  ) {
    throw new Error('pending commit requires current, next, generation and SHA-256');
  }
  const expectedGeneration = Number(generationText);
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new Error('expected pending generation must be a non-negative integer');
  }
  return { current, next, expectedGeneration, expectedSha256 };
}

async function runCli(argv: string[]): Promise<void> {
  const options = parseCliOptions(argv);
  const nextFile = await readRegularJsonFile(options.next, 'next pending ledger');
  const next = parsePendingLedger(nextFile.value);
  await commitPendingLedger(
    options.current,
    options.expectedGeneration,
    options.expectedSha256,
    next,
  );
  process.stdout.write(
    `${JSON.stringify({
      current: options.current,
      generation: next.current.generation,
      sha256: next.current.sha256,
      pending: next.current.entries.length,
    })}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
}
