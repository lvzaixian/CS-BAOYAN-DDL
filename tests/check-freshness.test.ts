import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkSnapshotFreshness } from '../scripts/snapshot/check-freshness.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(repositoryRoot, 'scripts/snapshot/check-freshness.ts');
const workflowPath = resolve(repositoryRoot, '.github/workflows/deploy.yml');
const operationsPath = resolve(repositoryRoot, 'docs/operations/data-refresh.md');
const packagePath = resolve(repositoryRoot, 'package.json');
const nowMs = Date.parse('2026-07-16T12:00:00Z');
const maxAgeMs = 6 * 60 * 60 * 1000;

function snapshot(scanAtMs: number, approvedAtMs: number): Record<string, unknown> {
  return {
    scanAt: new Date(scanAtMs).toISOString(),
    approvedAt: new Date(approvedAtMs).toISOString(),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function runCli(args: string[], timeout?: number) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout,
  });
}

test('accepts scanAt and approvedAt exactly six hours old', () => {
  assert.deepEqual(
    checkSnapshotFreshness(snapshot(nowMs - maxAgeMs, nowMs - maxAgeMs), nowMs, maxAgeMs),
    [],
  );
});

test('rejects either freshness timestamp one millisecond over six hours old', async (t) => {
  await t.test('scanAt', () => {
    const errors = checkSnapshotFreshness(
      snapshot(nowMs - maxAgeMs - 1, nowMs - maxAgeMs),
      nowMs,
      maxAgeMs,
    ).join('\n');
    assert.match(errors, /scanAt.*older.*maximum age/i);
    assert.doesNotMatch(errors, /approvedAt.*older.*maximum age/i);
  });

  await t.test('approvedAt', () => {
    const errors = checkSnapshotFreshness(
      snapshot(nowMs - maxAgeMs - 1, nowMs - maxAgeMs - 1),
      nowMs,
      maxAgeMs,
    ).join('\n');
    assert.match(errors, /approvedAt.*older.*maximum age/i);
  });
});

test('rejects future scanAt and approvedAt timestamps', async (t) => {
  await t.test('scanAt', () => {
    const errors = checkSnapshotFreshness(
      snapshot(nowMs + 1, nowMs + 2),
      nowMs,
      maxAgeMs,
    ).join('\n');
    assert.match(errors, /scanAt.*future/i);
  });

  await t.test('approvedAt', () => {
    const errors = checkSnapshotFreshness(
      snapshot(nowMs, nowMs + 1),
      nowMs,
      maxAgeMs,
    ).join('\n');
    assert.match(errors, /approvedAt.*future/i);
  });
});

test('rejects missing approval metadata', () => {
  const errors = checkSnapshotFreshness(
    { scanAt: new Date(nowMs).toISOString() },
    nowMs,
    maxAgeMs,
  ).join('\n');
  assert.match(errors, /approvedAt.*required/i);
});

test('rejects approvedAt before scanAt', () => {
  const errors = checkSnapshotFreshness(
    snapshot(nowMs - 1_000, nowMs - 1_001),
    nowMs,
    maxAgeMs,
  ).join('\n');
  assert.match(errors, /approvedAt.*before.*scanAt/i);
});

test('fails closed on malformed snapshots and invalid clock bounds', async (t) => {
  const cases: Array<[string, unknown, number, number, RegExp]> = [
    ['non-object snapshot', null, nowMs, maxAgeMs, /snapshot.*object/i],
    [
      'malformed scanAt',
      { scanAt: 'July 16, 2026', approvedAt: new Date(nowMs).toISOString() },
      nowMs,
      maxAgeMs,
      /scanAt.*valid ISO/i,
    ],
    [
      'malformed approvedAt',
      { scanAt: new Date(nowMs).toISOString(), approvedAt: '2026-02-30T00:00:00Z' },
      nowMs,
      maxAgeMs,
      /approvedAt.*valid ISO/i,
    ],
    ['non-finite now', snapshot(nowMs, nowMs), Number.NaN, maxAgeMs, /nowMs.*finite/i],
    ['zero maximum age', snapshot(nowMs, nowMs), nowMs, 0, /maxAgeMs.*positive/i],
    [
      'unsafe maximum age',
      snapshot(nowMs, nowMs),
      nowMs,
      Number.MAX_SAFE_INTEGER + 1,
      /maxAgeMs.*safe integer/i,
    ],
  ];

  for (const [name, input, clockMs, ageMs, pattern] of cases) {
    await t.test(name, () => {
      assert.doesNotThrow(() => checkSnapshotFreshness(input, clockMs, ageMs));
      assert.match(checkSnapshotFreshness(input, clockMs, ageMs).join('\n'), pattern);
    });
  }
});

test('strict CLI accepts a fresh regular JSON snapshot', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-freshness-valid-'));
  const snapshotPath = join(tempRoot, 'current.json');
  const clockMs = Date.now();
  writeJson(snapshotPath, snapshot(clockMs - 60_000, clockMs - 30_000));

  try {
    const result = runCli(['--snapshot', snapshotPath, '--max-age-hours', '6']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /snapshot freshness confirmed/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('strict CLI rejects unknown, duplicate, missing, and unsafe arguments', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-freshness-args-'));
  const snapshotPath = join(tempRoot, 'current.json');
  writeJson(snapshotPath, snapshot(Date.now(), Date.now()));

  const cases: Array<[string, string[], RegExp]> = [
    ['missing required', [], /missing required[\s\S]*usage/i],
    [
      'unknown',
      ['--snapshot', snapshotPath, '--max-age-hours', '6', '--wat', 'x'],
      /unknown argument[\s\S]*usage/i,
    ],
    [
      'duplicate snapshot',
      ['--snapshot', snapshotPath, '--snapshot', snapshotPath, '--max-age-hours', '6'],
      /duplicate argument/i,
    ],
    [
      'duplicate maximum age',
      ['--snapshot', snapshotPath, '--max-age-hours', '6', '--max-age-hours', '6'],
      /duplicate argument/i,
    ],
    ['missing value', ['--snapshot', '--max-age-hours', '6'], /missing value[\s\S]*usage/i],
    ['missing maximum age', ['--snapshot', snapshotPath], /missing required[\s\S]*usage/i],
    ['zero maximum age', ['--snapshot', snapshotPath, '--max-age-hours', '0'], /positive/i],
    ['negative maximum age', ['--snapshot', snapshotPath, '--max-age-hours', '-1'], /positive/i],
    ['NaN maximum age', ['--snapshot', snapshotPath, '--max-age-hours', 'NaN'], /decimal/i],
    ['infinite maximum age', ['--snapshot', snapshotPath, '--max-age-hours', 'Infinity'], /decimal/i],
    ['exponent maximum age', ['--snapshot', snapshotPath, '--max-age-hours', '1e2'], /decimal/i],
    [
      'unsafe maximum age',
      ['--snapshot', snapshotPath, '--max-age-hours', '9007199254740991'],
      /safe millisecond/i,
    ],
  ];

  try {
    for (const [name, args, pattern] of cases) {
      await t.test(name, () => {
        const result = runCli(args);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, pattern);
      });
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('strict CLI rejects unsafe snapshot file types before reading', async (t) => {
  await t.test('symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-freshness-symlink-'));
    const targetPath = join(tempRoot, 'target.json');
    const snapshotPath = join(tempRoot, 'current.json');
    writeJson(targetPath, snapshot(Date.now(), Date.now()));
    symlinkSync(targetPath, snapshotPath);

    try {
      const result = runCli(['--snapshot', snapshotPath, '--max-age-hours', '6']);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /snapshot.*symlink/i);
      assert.ok(lstatSync(snapshotPath).isSymbolicLink());
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('directory', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-freshness-directory-'));
    const snapshotPath = join(tempRoot, 'current.json');
    mkdirSync(snapshotPath);

    try {
      const result = runCli(['--snapshot', snapshotPath, '--max-age-hours', '6']);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /snapshot.*regular file/i);
      assert.ok(lstatSync(snapshotPath).isDirectory());
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('FIFO', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-freshness-fifo-'));
    const snapshotPath = join(tempRoot, 'current.fifo');
    const created = spawnSync('mkfifo', [snapshotPath], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);

    try {
      const result = runCli(['--snapshot', snapshotPath, '--max-age-hours', '6'], 500);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /snapshot.*regular file/i);
      assert.ok(lstatSync(snapshotPath).isFIFO());
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test('oversized JSON', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-freshness-oversized-'));
    const snapshotPath = join(tempRoot, 'current.json');
    writeFileSync(snapshotPath, '', 'utf8');
    truncateSync(snapshotPath, 16 * 1024 * 1024 + 1);

    try {
      const result = runCli(['--snapshot', snapshotPath, '--max-age-hours', '6']);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /snapshot.*(?:too large|size limit)/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('CLI rejects malformed JSON and stale timestamps', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-freshness-invalid-'));
  const snapshotPath = join(tempRoot, 'current.json');

  try {
    await t.test('malformed JSON', () => {
      writeFileSync(snapshotPath, '{broken', 'utf8');
      const result = runCli(['--snapshot', snapshotPath, '--max-age-hours', '6']);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /snapshot.*valid JSON/i);
    });

    await t.test('stale snapshot', () => {
      const clockMs = Date.now();
      writeJson(snapshotPath, snapshot(clockMs - maxAgeMs - 5_000, clockMs));
      const result = runCli(['--snapshot', snapshotPath, '--max-age-hours', '6']);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /scanAt.*older.*maximum age/i);
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workflow checks freshness at approval, before SSH, and immediately before activation', () => {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.['snapshot:check-freshness'],
    'tsx scripts/snapshot/check-freshness.ts',
  );

  const workflow = readFileSync(workflowPath, 'utf8');
  const productionGateStart = workflow.indexOf('  production_gate:');
  const prepareStart = workflow.indexOf('  prepare:');
  const controlPlaneStart = workflow.indexOf('  package-control-plane:');
  const deployStart = workflow.indexOf('  deploy:');
  assert.ok(
    productionGateStart >= 0
      && prepareStart > productionGateStart
      && controlPlaneStart > prepareStart
      && deployStart > controlPlaneStart,
  );

  const productionGate = workflow.slice(productionGateStart, prepareStart);
  const prepare = workflow.slice(prepareStart, controlPlaneStart);
  const controlPlane = workflow.slice(controlPlaneStart, deployStart);
  const deploy = workflow.slice(deployStart);
  assert.match(
    prepare,
    /dist\/release\.json[\s\S]*JSON\.stringify\(\{ releaseSha, snapshotId, dataHash \}\)/,
  );
  assert.match(prepare, /snapshotScanAt:\s*process\.env\.SNAPSHOT_SCAN_AT/);
  assert.match(prepare, /snapshotApprovedAt:\s*process\.env\.SNAPSHOT_APPROVED_AT/);
  assert.match(
    productionGate,
    /expected_keys = \{"releaseSha", "snapshotId", "dataHash", "archiveSha", "snapshotScanAt", "snapshotApprovedAt"\}/,
  );

  assert.match(productionGate, /needs:\s*prepare/);
  assert.match(productionGate, /environment:\s*production-approval/);
  assert.match(
    productionGate,
    /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/,
  );
  assert.match(productionGate, /production-build-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(productionGate, /MAX_AGE_SECONDS = 86400/);
  assert.match(productionGate, /datetime\.now\(timezone\.utc\)/);
  assert.match(productionGate, /snapshotScanAt/);
  assert.match(productionGate, /snapshotApprovedAt/);
  assert.match(productionGate, /approved_at < scan_at/);
  assert.match(productionGate, /timestamp > now/);
  assert.match(productionGate, /now - timestamp > max_age/);
  assert.doesNotMatch(productionGate, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(productionGate, /TENCENT_|HOME\/\.ssh|deploy_key|known_hosts|ssh-keygen/);
  assert.doesNotMatch(productionGate, /(?:^|\n)\s*(?:ssh|scp)\s/m);

  assert.match(controlPlane, /needs:\s*production_gate/);
  assert.match(deploy, /needs:\s*\[prepare, package-control-plane\]/);
  assert.match(deploy, /environment:\s*production(?:\s|$)/);

  const artifactDownload = deploy.indexOf('- name: Download build artifact');
  const artifactValidation = deploy.indexOf(
    '- name: Validate build and control-plane artifacts and public origin',
  );
  const deployFreshness = deploy.indexOf(
    '- name: Revalidate release metadata and snapshot freshness before SSH setup',
  );
  const sshSetup = deploy.indexOf('- name: Configure pinned SSH identity and host key');
  const upload = deploy.indexOf('- name: Upload release archive and deployment scripts');
  const activationFreshness = deploy.indexOf(
    '- name: Revalidate release metadata and snapshot freshness immediately before activation',
  );
  const activation = deploy.indexOf('- name: Verify archive and activate release');
  const firstSecret = deploy.indexOf('${{ secrets.');
  assert.ok(
    artifactDownload >= 0
      && artifactDownload < artifactValidation
      && artifactValidation < deployFreshness
      && deployFreshness < sshSetup
      && sshSetup < firstSecret,
    'deploy must revalidate downloaded metadata before its first secret-backed SSH step',
  );
  assert.ok(
    upload > sshSetup
      && activationFreshness > upload
      && activation > activationFreshness,
    'deploy must revalidate snapshot freshness after upload and immediately before activation',
  );

  const deployFreshnessStep = deploy.slice(deployFreshness, sshSetup);
  assert.match(
    deployFreshnessStep,
    /expected_keys = \{"releaseSha", "snapshotId", "dataHash", "archiveSha", "snapshotScanAt", "snapshotApprovedAt"\}/,
  );
  assert.match(
    deployFreshnessStep,
    /metadata\["releaseSha"\] != os\.environ\["RELEASE_SHA"\]/,
  );
  assert.match(deployFreshnessStep, /re\.fullmatch\(r"\[0-9a-f\]\{40\}"/);
  assert.match(deployFreshnessStep, /MAX_AGE_SECONDS = 86400/);
  assert.match(deployFreshnessStep, /datetime\.now\(timezone\.utc\)/);
  assert.match(deployFreshnessStep, /approved_at < scan_at/);
  assert.match(deployFreshnessStep, /timestamp > now/);
  assert.match(deployFreshnessStep, /now - timestamp > max_age/);
  assert.match(deployFreshnessStep, /set -euo pipefail/);
  assert.doesNotMatch(deployFreshnessStep, /continue-on-error/);

  const activationFreshnessStep = deploy.slice(activationFreshness, activation);
  assert.match(
    activationFreshnessStep,
    /expected_keys = \{"releaseSha", "snapshotId", "dataHash", "archiveSha", "snapshotScanAt", "snapshotApprovedAt"\}/,
  );
  assert.match(
    activationFreshnessStep,
    /metadata\["releaseSha"\] != os\.environ\["RELEASE_SHA"\]/,
  );
  assert.match(activationFreshnessStep, /MAX_AGE_SECONDS = 86400/);
  assert.match(activationFreshnessStep, /datetime\.now\(timezone\.utc\)/);
  assert.match(activationFreshnessStep, /approved_at < scan_at/);
  assert.match(activationFreshnessStep, /timestamp > now/);
  assert.match(activationFreshnessStep, /now - timestamp > max_age/);
  assert.match(activationFreshnessStep, /set -euo pipefail/);
  assert.doesNotMatch(activationFreshnessStep, /continue-on-error/);

  const beforeSsh = deploy.slice(0, sshSetup);
  assert.doesNotMatch(beforeSsh, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(beforeSsh, /HOME\/\.ssh|deploy_key|known_hosts|ssh-keygen/);
  assert.doesNotMatch(beforeSsh, /(?:^|\n)\s*(?:ssh|scp)\s/m);
  assert.equal([...workflow.matchAll(/MAX_AGE_SECONDS = 86400/g)].length, 3);
  assert.equal(
    [...workflow.matchAll(/older than \{MAX_AGE_SECONDS\} seconds/g)].length,
    3,
  );
  assert.doesNotMatch(workflow, /MAX_AGE_SECONDS = 21600|older than 21600 seconds/);

  const cleanupStart = deploy.indexOf('- name: Remove remote staging and local SSH material');
  assert.ok(cleanupStart >= 0);
  const cleanup = deploy.slice(cleanupStart);
  assert.match(cleanup, /if:\s*\$\{\{ always\(\) && steps\.ssh\.outcome != 'skipped' \}\}/);

  const operations = readFileSync(operationsPath, 'utf8');
  assert.match(operations, /三重检查/);
  assert.match(operations, /production.*第二次人工批准[\s\S]*TOCTOU/);
  assert.match(operations, /激活前[\s\S]*再次.*24 小时[\s\S]*(?:失败关闭|fail closed)/);
});
