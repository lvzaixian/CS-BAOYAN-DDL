import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectGitChangedFiles,
  prepareDataPrPlan,
} from '../scripts/snapshot/prepare-data-pr.js';
import {
  canonicalDataHash,
  deriveSnapshotId,
} from '../src/lib/snapshot-integrity.js';
import type { PublicSnapshot } from '../src/lib/snapshot-types.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/snapshot-valid.json', import.meta.url),
  'utf8',
)) as PublicSnapshot;
const validAliases = {
  'https://cs.example.edu.cn/notice/1': '2027|测试大学|计算机学院|夏令营',
};

function approvedSnapshot(label = '原始项目'): PublicSnapshot {
  const snapshot = structuredClone(fixture);
  snapshot.opportunities[0].project = label;
  snapshot.scanAt = '2026-07-17T09:00:00+08:00';
  snapshot.approvedAt = '2026-07-17T09:05:00+08:00';
  snapshot.dataHash = canonicalDataHash(snapshot);
  snapshot.snapshotId = deriveSnapshotId(snapshot.approvedAt, snapshot.dataHash);
  return snapshot;
}

test('returns no-change when canonical public data is identical', () => {
  const base = approvedSnapshot();
  const plan = prepareDataPrPlan({
    base,
    next: structuredClone(base),
    changedFiles: [],
    now: new Date('2026-07-17T10:00:00+08:00'),
  });

  assert.deepEqual(plan, {
    status: 'no-change',
    dataHash: base.dataHash,
    snapshotId: base.snapshotId,
    changedFiles: [],
  });
});

test('returns a deterministic bounded data-only PR plan for changed data', () => {
  const base = approvedSnapshot();
  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);

  const plan = prepareDataPrPlan({
    base,
    next,
    changedFiles: ['data/project-id-aliases.json', 'data/approved/current.json'],
    aliases: validAliases,
    now: new Date('2026-07-17T10:00:00+08:00'),
  });

  assert.equal(plan.status, 'ready');
  if (plan.status !== 'ready') return;
  assert.equal(plan.branchName, 'codex/data-refresh-20260717-020000');
  assert.equal(plan.commitMessage, 'data: publish 2026-07-17 admissions snapshot');
  assert.equal(plan.prTitle, 'data: refresh admissions snapshot (2026-07-17)');
  assert.deepEqual(plan.changedFiles, [
    'data/approved/current.json',
    'data/project-id-aliases.json',
  ]);
  assert.equal(plan.dataHash, next.dataHash);
  assert.equal(plan.snapshotId, next.snapshotId);
  assert.equal(plan.counts.confirmedOpen, next.counts.confirmedOpen);
});

test('rejects files outside the public data-only allowlist', () => {
  const base = approvedSnapshot();
  const next = approvedSnapshot('更新后的项目');
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);

  for (const file of [
    'data/staging/candidate.json',
    'scripts/snapshot/import-scouting-data.ts',
    '/Users/maxwellbrooks/private/workbook.json',
    '../submitted-projects.json',
  ]) {
    assert.throws(
      () => prepareDataPrPlan({
        base,
        next,
        changedFiles: ['data/approved/current.json', file],
        now: new Date('2026-07-17T10:00:00+08:00'),
      }),
      /data-only allowlist/i,
      file,
    );
  }
});

test('rejects private application state and contact data even if hashes are recomputed', () => {
  const base = approvedSnapshot();

  const submitted = approvedSnapshot('更新后的项目') as PublicSnapshot & {
    submittedProjectIds?: string[];
  };
  submitted.submittedProjectIds = ['private-id'];
  submitted.dataHash = canonicalDataHash(submitted);
  submitted.snapshotId = deriveSnapshotId(submitted.approvedAt, submitted.dataHash);
  assert.throws(
    () => prepareDataPrPlan({
      base,
      next: submitted,
      changedFiles: ['data/approved/current.json'],
      now: new Date('2026-07-17T10:00:00+08:00'),
    }),
    /private|submitted/i,
  );

  const contact = approvedSnapshot('更新后的项目');
  contact.opportunities[0].description = '联系人 student@example.com';
  contact.dataHash = canonicalDataHash(contact);
  contact.snapshotId = deriveSnapshotId(contact.approvedAt, contact.dataHash);
  assert.throws(
    () => prepareDataPrPlan({
      base,
      next: contact,
      changedFiles: ['data/approved/current.json'],
      now: new Date('2026-07-17T10:00:00+08:00'),
    }),
    /private|contact|email/i,
  );
});

test('validates changed alias contents against schema and the shared privacy boundary', () => {
  const base = approvedSnapshot();
  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);

  for (const aliases of [
    { 'not-a-url': '2027|测试大学|计算机学院|夏令营' },
    { 'https://cs.example.edu.cn/notice/1': 'broken-project-id' },
    { 'https://cs.example.edu.cn/notice/1': '2027|测试大学|计算机学院|联系人a@example.com' },
  ]) {
    assert.throws(
      () => prepareDataPrPlan({
        base,
        next,
        changedFiles: ['data/approved/current.json', 'data/project-id-aliases.json'],
        aliases,
        now: new Date('2026-07-17T10:00:00+08:00'),
      }),
      /alias|private|email|url|project id/i,
    );
  }
});

test('CLI derives its file set from Git instead of accepting caller-declared paths', () => {
  const source = readFileSync(
    new URL('../scripts/snapshot/prepare-data-pr.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /git[\s\S]*diff[\s\S]*--name-only/);
  assert.match(source, /git[\s\S]*ls-files[\s\S]*--others[\s\S]*--exclude-standard/);
  assert.doesNotMatch(source, /flag === '--changed-file'/);
});

test('collects tracked and untracked Git changes from the real worktree', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'csddl-data-pr-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };

  git('init', '-q');
  mkdirSync(join(directory, 'data', 'approved'), { recursive: true });
  writeFileSync(join(directory, 'data', 'approved', 'current.json'), '{}\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base');

  writeFileSync(join(directory, 'data', 'approved', 'current.json'), '{"changed":true}\n');
  mkdirSync(join(directory, 'docs'));
  writeFileSync(join(directory, 'docs', 'unexpected.md'), 'untracked\n');

  assert.deepEqual(await collectGitChangedFiles(directory, 'HEAD'), [
    'data/approved/current.json',
    'docs/unexpected.md',
  ]);
});
