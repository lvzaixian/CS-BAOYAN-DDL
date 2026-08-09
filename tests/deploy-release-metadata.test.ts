import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validatorPath = resolve(repositoryRoot, 'scripts/deploy/validate-release-metadata.py');
const releaseSha = 'a'.repeat(40);

function validMetadata(): Record<string, string> {
  return {
    releaseSha,
    snapshotId: `2026-08-09T08:35:00.000Z-${'b'.repeat(12)}`,
    dataHash: 'c'.repeat(64),
    archiveSha: 'd'.repeat(64),
  };
}

function run(metadata: unknown, expectedSha = releaseSha) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-release-metadata-'));
  const path = join(root, 'release-metadata.json');
  writeFileSync(path, JSON.stringify(metadata), 'utf8');
  try {
    return spawnSync('python3', [validatorPath, path, expectedSha], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('release metadata validator accepts only the immutable four-field release identity', () => {
  const accepted = run(validMetadata());
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

  const extraField = run({ ...validMetadata(), snapshotScanAt: '2026-08-09T08:30:00.000Z' });
  assert.notEqual(extraField.status, 0);
  assert.match(`${extraField.stdout}\n${extraField.stderr}`, /unexpected schema/i);

  const mismatchedSha = run(validMetadata(), 'b'.repeat(40));
  assert.notEqual(mismatchedSha.status, 0);
  assert.match(`${mismatchedSha.stdout}\n${mismatchedSha.stderr}`, /does not match/i);

  const invalidHash = run({ ...validMetadata(), archiveSha: 'invalid' });
  assert.notEqual(invalidHash.status, 0);
  assert.match(`${invalidHash.stdout}\n${invalidHash.stderr}`, /archiveSha.*invalid/i);
});
