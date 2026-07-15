import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { diffSnapshots } from '../scripts/snapshot/diff-snapshots.js';
import type {
  PublicOpportunity,
  PublicSnapshot,
  SnapshotCandidate,
} from '../src/lib/snapshot-types.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-valid.json', import.meta.url), 'utf8'),
) as PublicSnapshot;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(repositoryRoot, 'scripts/snapshot/diff-snapshots.ts');
const tsxPath = resolve(repositoryRoot, 'node_modules/.bin/tsx');

function opportunity(projectId: string): PublicOpportunity {
  return {
    ...structuredClone(fixture.opportunities[0]),
    projectId,
  };
}

function candidate(opportunities: PublicOpportunity[]): SnapshotCandidate {
  return {
    schemaVersion: 1,
    scanAt: fixture.scanAt,
    defaultFeedId: fixture.defaultFeedId,
    feeds: structuredClone(fixture.feeds),
    counts: {
      confirmedOpen: opportunities.filter(
        ({ verificationStatus }) => verificationStatus === 'confirmed-open',
      ).length,
      confirmedUnknownDeadline: opportunities.filter(
        ({ verificationStatus }) => verificationStatus === 'confirmed-unknown-deadline',
      ).length,
      pendingExcluded: 0,
      expired: opportunities.filter(
        ({ verificationStatus }) => verificationStatus === 'expired',
      ).length,
    },
    opportunities,
  };
}

function snapshot(opportunities: PublicOpportunity[]): PublicSnapshot {
  return {
    ...candidate(opportunities),
    snapshotId: fixture.snapshotId,
    approvedAt: fixture.approvedAt,
    previousSnapshotId: fixture.previousSnapshotId,
    dataHash: fixture.dataHash,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runDiffCli(args: string[]) {
  return spawnSync(tsxPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

test('classifies added, changed, newly expired and removed IDs exclusively', () => {
  const changedBefore = opportunity('2027|测试大学|计算机学院|changed');
  const changedAfter = structuredClone(changedBefore);
  changedAfter.website = 'https://cs.example.edu.cn/notice/changed';
  const expiredBefore = opportunity('2027|测试大学|计算机学院|expired');
  const expiredAfter = structuredClone(expiredBefore);
  expiredAfter.verificationStatus = 'expired';
  expiredAfter.deadline = '2026-07-15T23:59:00+08:00';
  expiredAfter.deadlineEpochMs = Date.parse(expiredAfter.deadline);
  expiredAfter.description = 'also changed';
  const refreshed = opportunity('2027|测试大学|计算机学院|refreshed');
  const refreshedAfter = structuredClone(refreshed);
  refreshedAfter.verifiedAt = '2026-07-15T22:45:00+08:00';

  const result = diffSnapshots(
    snapshot([
      opportunity('2027|测试大学|计算机学院|removed'),
      expiredBefore,
      changedBefore,
      refreshed,
    ]),
    candidate([
      opportunity('2027|测试大学|计算机学院|added'),
      refreshedAfter,
      changedAfter,
      expiredAfter,
    ]),
  );

  assert.deepEqual(result, {
    added: ['2027|测试大学|计算机学院|added'],
    changed: ['2027|测试大学|计算机学院|changed'],
    expired: ['2027|测试大学|计算机学院|expired'],
    removed: ['2027|测试大学|计算机学院|removed'],
  });
  const classified = [result.added, result.changed, result.expired, result.removed].flat();
  assert.equal(new Set(classified).size, classified.length);
});

test('sorts every result array by Unicode code point', () => {
  const lowerCodePoint = '2027|测试大学|计算机学院|\uE000';
  const higherCodePoint = '2027|测试大学|计算机学院|\u{10000}';

  const result = diffSnapshots(null, candidate([
    opportunity(higherCodePoint),
    opportunity(lowerCodePoint),
  ]));

  assert.deepEqual(result.added, [lowerCodePoint, higherCodePoint]);
});

test('treats every public publication field except verifiedAt as meaningful', async (t) => {
  const mutations: Array<[string, (row: Record<string, any>) => void]> = [
    ['feedId', (row) => (row.feedId = 'camp2028')],
    ['name', (row) => (row.name = '另一所大学')],
    ['institute', (row) => (row.institute = '软件学院')],
    ['project', (row) => (row.project = '开放日')],
    ['eventType', (row) => (row.eventType = '开放日')],
    ['description content', (row) => (row.description = '内容发生变化')],
    ['verificationStatus', (row) => {
      row.verificationStatus = 'confirmed-unknown-deadline';
      row.deadline = null;
      row.deadlineEpochMs = null;
    }],
    ['deadline', (row) => (row.deadline = '2026-07-21T23:59:00+08:00')],
    ['deadlineOriginal', (row) => (row.deadlineOriginal = '2026年7月21日截止')],
    ['deadlineEpochMs', (row) => (row.deadlineEpochMs += 60_000)],
    ['website', (row) => (row.website = 'https://cs.example.edu.cn/notice/2')],
    ['tags', (row) => row.tags.push('双一流')],
    ['province', (row) => (row.province = '上海')],
    ['discoverySources', (row) => (row.discoverySources[0].label = '研究生院官网')],
    ['logistics', (row) => (row.logistics.summary = '提供住宿')],
    ['recommendation', (row) => (row.recommendation.summary = '需要两封推荐信')],
    ['materials', (row) => (row.materials.summary = '成绩单')],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const before = opportunity('2027|测试大学|计算机学院|same');
      const after = structuredClone(before) as Record<string, any>;
      mutate(after);

      assert.deepEqual(
        diffSnapshots(snapshot([before]), candidate([after as PublicOpportunity])).changed,
        [before.projectId],
      );
    });
  }
});

test('ignores description whitespace-only differences and pure verifiedAt refreshes', () => {
  const before = opportunity('2027|测试大学|计算机学院|same');
  before.description = '第一行 第二行';
  const after = structuredClone(before);
  after.description = '  第一行\n\t第二行  ';
  after.verifiedAt = '2026-07-15T22:45:00+08:00';

  assert.deepEqual(diffSnapshots(snapshot([before]), candidate([after])), {
    added: [],
    changed: [],
    expired: [],
    removed: [],
  });
});

test('treats all next IDs as added when no previous snapshot is supplied', () => {
  const result = diffSnapshots(null, candidate([
    opportunity('2027|测试大学|计算机学院|z'),
    opportunity('2027|测试大学|计算机学院|a'),
  ]));

  assert.deepEqual(result, {
    added: [
      '2027|测试大学|计算机学院|a',
      '2027|测试大学|计算机学院|z',
    ],
    changed: [],
    expired: [],
    removed: [],
  });
});

test('diff CLI writes a first-snapshot diff without --previous', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-diff-first-'));
  const nextPath = join(tempRoot, 'candidate.json');
  const outputPath = join(tempRoot, 'diff.json');
  writeJson(nextPath, candidate([opportunity('2027|测试大学|计算机学院|new')]));

  try {
    const result = runDiffCli(['--next', nextPath, '--output', outputPath]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), {
      added: ['2027|测试大学|计算机学院|new'],
      changed: [],
      expired: [],
      removed: [],
    });
    assert.ok(existsSync(nextPath));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('diff CLI rejects an explicitly missing previous file without output', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'snapshot-diff-missing-'));
  const nextPath = join(tempRoot, 'candidate.json');
  const outputPath = join(tempRoot, 'diff.json');
  writeJson(nextPath, candidate([opportunity('2027|测试大学|计算机学院|new')]));

  try {
    const result = runDiffCli([
      '--previous', join(tempRoot, 'missing.json'),
      '--next', nextPath,
      '--output', outputPath,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /previous.*could not be read/i);
    assert.equal(existsSync(outputPath), false);
    assert.ok(existsSync(nextPath));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('diff CLI rejects unknown, duplicate and missing arguments', async (t) => {
  const cases: Array<[string, string[], RegExp]> = [
    ['unknown', ['--next', 'next.json', '--output', 'diff.json', '--wat', 'x'], /usage|unknown/i],
    ['duplicate', ['--next', 'a.json', '--next', 'b.json', '--output', 'diff.json'], /duplicate/i],
    ['missing value', ['--next', '--output', 'diff.json'], /usage|missing/i],
    ['missing required', ['--next', 'next.json'], /usage|required/i],
  ];

  for (const [name, args, pattern] of cases) {
    await t.test(name, () => {
      const result = runDiffCli(args);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, pattern);
    });
  }
});
