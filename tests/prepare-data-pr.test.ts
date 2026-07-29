import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertGitChangeSetStable,
  assertRegularJsonFileStable,
  collectGitChangeSet,
  collectGitChangedFiles,
  prepareDataPrPlan,
} from '../scripts/snapshot/prepare-data-pr.js';
import {
  canonicalDataHash,
  deriveSnapshotId,
  readRegularJsonFile,
} from '../src/lib/snapshot-integrity.js';
import type { PublicSnapshot } from '../src/lib/snapshot-types.js';
import type { ProjectIdentityRegistry } from '../scripts/snapshot/scan-release-contract.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/snapshot-valid.json', import.meta.url),
  'utf8',
)) as PublicSnapshot;
function identityRegistry(
  overrides: Partial<ProjectIdentityRegistry> = {},
): ProjectIdentityRegistry {
  return {
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [],
    tombstones: [],
    ...overrides,
  };
}

function urlAlias(
  url: string,
  canonicalProjectId: string,
): ProjectIdentityRegistry['urlAliases'][number] {
  return {
    url,
    canonicalProjectId,
    cycle: canonicalProjectId.slice(0, 4),
    reason: '测试中的官网通知路径迁移',
    introducedRunId: '20260729-data-pr-test',
  };
}

function projectAlias(
  sourceProjectId: string,
  canonicalProjectId: string,
): ProjectIdentityRegistry['projectAliases'][number] {
  return {
    sourceProjectId,
    canonicalProjectId,
    cycle: sourceProjectId.slice(0, 4),
    reason: '测试中的项目名称迁移',
    introducedRunId: '20260729-data-pr-test',
  };
}

function tombstone(
  projectId: string,
  mergedInto: string,
): ProjectIdentityRegistry['tombstones'][number] {
  return {
    projectId,
    mergedInto,
    cycle: projectId.slice(0, 4),
    reason: '测试中的重复项目合并',
    introducedRunId: '20260729-data-pr-test',
  };
}

const validAliases = identityRegistry({
  urlAliases: [
    urlAlias(
      'https://cs.example.edu.cn/notice/1',
      '2027|测试大学|计算机学院|夏令营',
    ),
  ],
});

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

test('revalidates unchanged approved snapshots at approval time after their deadlines pass', () => {
  const base = approvedSnapshot();
  const plan = prepareDataPrPlan({
    base,
    next: structuredClone(base),
    changedFiles: [],
    now: new Date('2026-07-21T10:00:00+08:00'),
  });

  assert.equal(plan.status, 'no-change');
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
    identityRegistry({
      urlAliases: [
        urlAlias('not-a-url', '2027|测试大学|计算机学院|夏令营'),
      ],
    }),
    identityRegistry({
      urlAliases: [
        urlAlias('https://cs.example.edu.cn/notice/1', 'broken-project-id'),
      ],
    }),
    identityRegistry({
      urlAliases: [
        urlAlias(
          'https://cs.example.edu.cn/notice/1',
          '2027|测试大学|计算机学院|联系人a@example.com',
        ),
      ],
    }),
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

test('rejects a legacy bare alias map even when its target exists in the base snapshot', () => {
  const base = approvedSnapshot();
  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);

  assert.throws(
    () => prepareDataPrPlan({
      base,
      next,
      changedFiles: ['data/approved/current.json', 'data/project-id-aliases.json'],
      aliases: {
        'https://cs.example.edu.cn/notice/1':
          '2027|测试大学|计算机学院|夏令营',
      },
      now: new Date('2026-07-17T10:00:00+08:00'),
    }),
    /identity registry.*(?:not allowed|schemaVersion must be exactly 2)/i,
  );
});

test('rejects registry cycle violations, normalized conflicts, and contradictory mappings', () => {
  const base = approvedSnapshot();
  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);

  for (const [label, aliases, expected] of [
    [
      'project-alias cycle mismatch',
      identityRegistry({
        projectAliases: [
          projectAlias(
            '2028|测试大学|计算机学院|夏令营',
            '2027|测试大学|计算机学院|夏令营',
          ),
        ],
      }),
      /cycle/i,
    ],
    [
      'conflict after URL normalization',
      identityRegistry({
        urlAliases: [
          urlAlias(
            'https://cs.example.edu.cn/notice/1',
            '2027|测试大学|计算机学院|夏令营',
          ),
          urlAlias(
            'https://CS.EXAMPLE.EDU.CN/notice/1/',
            '2027|另一所大学|计算机学院|夏令营',
          ),
        ],
      }),
      /conflicting URL alias/i,
    ],
    [
      'tombstone cycle mismatch',
      identityRegistry({
        tombstones: [
          tombstone(
            '2028|测试大学|计算机学院|旧夏令营',
            '2027|测试大学|计算机学院|夏令营',
          ),
        ],
      }),
      /cycle/i,
    ],
    [
      'project alias and tombstone disagree',
      identityRegistry({
        projectAliases: [
          projectAlias(
            '2027|测试大学|计算机学院|旧夏令营',
            '2027|测试大学|计算机学院|夏令营',
          ),
        ],
        tombstones: [
          tombstone(
            '2027|测试大学|计算机学院|旧夏令营',
            '2027|测试大学|计算机学院|开放日',
          ),
        ],
      }),
      /conflict.*disagree/i,
    ],
  ] as const) {
    assert.throws(
      () => prepareDataPrPlan({
        base,
        next,
        changedFiles: ['data/approved/current.json', 'data/project-id-aliases.json'],
        aliases,
        now: new Date('2026-07-17T10:00:00+08:00'),
      }),
      expected,
      label,
    );
  }
});

test('allows schema-valid historical registry targets absent from both base and next', () => {
  const base = approvedSnapshot();
  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);
  const historicalTargets = [
    '2027|测试大学|计算机学院|经审历史项目',
    '2027|测试大学|计算机学院|经审历史暑期学校',
    '2027|测试大学|计算机学院|经审历史合并项目',
  ];

  for (const target of historicalTargets) {
    assert.equal(
      [...base.opportunities, ...next.opportunities]
        .some((row) => row.projectId === target),
      false,
    );
  }

  const plan = prepareDataPrPlan({
    base,
    next,
    changedFiles: ['data/approved/current.json', 'data/project-id-aliases.json'],
    aliases: identityRegistry({
      urlAliases: [
        urlAlias('https://history.example.edu.cn/notice', historicalTargets[0]),
      ],
      projectAliases: [
        projectAlias(
          '2027|测试大学|计算机学院|本轮观察名称',
          historicalTargets[1],
        ),
      ],
      tombstones: [
        tombstone(
          '2027|测试大学|计算机学院|已审重复旧项目',
          historicalTargets[2],
        ),
      ],
    }),
    now: new Date('2026-07-17T10:00:00+08:00'),
  });

  assert.equal(plan.status, 'ready');
});

test('accepts a tombstone whose obsolete project ID is absent but merged target is approved', () => {
  const base = approvedSnapshot();
  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);

  const plan = prepareDataPrPlan({
    base,
    next,
    changedFiles: ['data/approved/current.json', 'data/project-id-aliases.json'],
    aliases: identityRegistry({
      tombstones: [
        tombstone(
          '2027|测试大学|计算机学院|已废弃旧项目',
          '2027|测试大学|计算机学院|夏令营',
        ),
      ],
    }),
    now: new Date('2026-07-17T10:00:00+08:00'),
  });

  assert.equal(plan.status, 'ready');
});

test('CLI derives its file set from Git instead of accepting caller-declared paths', () => {
  const source = readFileSync(
    new URL('../scripts/snapshot/prepare-data-pr.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /git[\s\S]*diff[\s\S]*--name-only/);
  assert.match(source, /git[\s\S]*ls-files[\s\S]*--others[\s\S]*--exclude-standard/);
  assert.match(source, /baseOid/);
  assert.match(source, /headOid/);
  assert.match(source, /origin\/main/);
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

  const expectedFiles = [
    'data/approved/current.json',
    'docs/unexpected.md',
  ];
  assert.deepEqual(await collectGitChangedFiles(directory, 'HEAD'), expectedFiles);

  const state = await collectGitChangeSet(directory, 'HEAD');
  assert.equal(state.baseRef, 'HEAD');
  assert.match(state.baseOid, /^[0-9a-f]{40}$/);
  assert.equal(state.headOid, state.baseOid);
  assert.deepEqual(state.changedFiles, expectedFiles);
});

test('binds the diff to the resolved base OID when the remote-tracking ref moves', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'csddl-data-pr-ref-move-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gitOutput = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const git = (...args: string[]) => {
    gitOutput(...args);
  };

  git('init', '-q');
  mkdirSync(join(directory, 'data', 'approved'), { recursive: true });
  writeFileSync(join(directory, 'data', 'approved', 'current.json'), '{"version":"base"}\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base');
  const originalBaseOid = gitOutput('rev-parse', 'HEAD').trim();
  git('update-ref', 'refs/remotes/origin/main', originalBaseOid);

  writeFileSync(join(directory, 'data', 'approved', 'current.json'), '{"version":"moved"}\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'moved');
  const movedBaseOid = gitOutput('rev-parse', 'HEAD').trim();
  writeFileSync(join(directory, 'data', 'approved', 'current.json'), '{"version":"base"}\n');

  let moved = false;
  const movingRunner = async (_repositoryRoot: string, args: string[]) => {
    const output = gitOutput(...args);
    if (!moved && args[0] === 'rev-parse' && args.at(-1) === 'origin/main^{commit}') {
      git('update-ref', 'refs/remotes/origin/main', movedBaseOid);
      moved = true;
    }
    return output;
  };

  const state = await collectGitChangeSet(directory, 'origin/main', movingRunner);

  assert.equal(state.baseOid, originalBaseOid);
  assert.deepEqual(state.changedFiles, []);
  assert.equal(gitOutput('rev-parse', 'origin/main').trim(), movedBaseOid);
});

test('rejects a plan when the remote-tracking baseline moves during preparation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'csddl-data-pr-stability-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gitOutput = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const git = (...args: string[]) => {
    gitOutput(...args);
  };

  git('init', '-q');
  mkdirSync(join(directory, 'data', 'approved'), { recursive: true });
  writeFileSync(join(directory, 'data', 'approved', 'current.json'), '{"version":"base"}\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const initial = await collectGitChangeSet(directory, 'origin/main');

  writeFileSync(join(directory, 'data', 'approved', 'current.json'), '{"version":"moved"}\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'moved');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  await assert.rejects(
    () => assertGitChangeSetStable(directory, initial),
    /base ref moved during data PR preparation/i,
  );
});

test('rejects same-path JSON content replacement after validation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'csddl-data-pr-content-move-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'current.json');
  writeFileSync(file, '{"value":"A"}\n');
  const initial = await readRegularJsonFile(file, 'test snapshot');
  writeFileSync(file, '{"value":"B"}\n');

  await assert.rejects(
    () => assertRegularJsonFileStable(file, 'test snapshot', initial),
    /content changed during data PR preparation/i,
  );
});

test('runs the CLI against a real origin/main tracking ref in a temporary repository', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'csddl-data-pr-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  git('init', '-q');
  mkdirSync(join(directory, 'data', 'approved'), { recursive: true });
  const base = approvedSnapshot();
  writeFileSync(
    join(directory, 'data', 'approved', 'current.json'),
    `${JSON.stringify(base, null, 2)}\n`,
  );
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base');
  const baseOid = git('rev-parse', 'HEAD').trim();
  git('update-ref', 'refs/remotes/origin/main', baseOid);

  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);
  writeFileSync(
    join(directory, 'data', 'approved', 'current.json'),
    `${JSON.stringify(next, null, 2)}\n`,
  );

  const cliPath = fileURLToPath(
    new URL('../scripts/snapshot/prepare-data-pr.ts', import.meta.url),
  );
  const tsxPath = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  const result = spawnSync(tsxPath, [cliPath, '--base-ref', 'origin/main'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout) as {
    status: string;
    audit: {
      baseRef: string;
      baseOid: string;
      headOid: string;
      contentSha256: Record<string, string>;
    };
  };
  assert.equal(plan.status, 'ready');
  assert.equal(plan.audit.baseRef, 'origin/main');
  assert.equal(plan.audit.baseOid, baseOid);
  assert.equal(plan.audit.headOid, baseOid);
  assert.equal(
    plan.audit.contentSha256['data/approved/current.json'],
    createHash('sha256')
      .update(readFileSync(join(directory, 'data', 'approved', 'current.json')))
      .digest('hex'),
  );
});

test('rejects staged data so the plan cannot diverge from the eventual commit', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'csddl-data-pr-staged-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  git('init', '-q');
  mkdirSync(join(directory, 'data', 'approved'), { recursive: true });
  const base = approvedSnapshot();
  writeFileSync(
    join(directory, 'data', 'approved', 'current.json'),
    `${JSON.stringify(base, null, 2)}\n`,
  );
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  const next = approvedSnapshot('更新后的项目');
  next.previousSnapshotId = base.snapshotId;
  next.dataHash = canonicalDataHash(next);
  next.snapshotId = deriveSnapshotId(next.approvedAt, next.dataHash);
  writeFileSync(
    join(directory, 'data', 'approved', 'current.json'),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  git('add', 'data/approved/current.json');

  const cliPath = fileURLToPath(
    new URL('../scripts/snapshot/prepare-data-pr.ts', import.meta.url),
  );
  const tsxPath = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  const result = spawnSync(tsxPath, [cliPath, '--base-ref', 'origin/main'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /index must be clean before data PR preparation/i);
});

test('rejects a remote baseline that is not an ancestor of HEAD', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'csddl-data-pr-ancestry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  git('init', '-q');
  writeFileSync(join(directory, 'base.txt'), 'shared\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'shared');
  git('switch', '-qc', 'remote-main');
  writeFileSync(join(directory, 'remote.txt'), 'remote\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'remote');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', '-');
  writeFileSync(join(directory, 'local.txt'), 'local\n');
  git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'local');

  await assert.rejects(
    () => collectGitChangeSet(directory, 'origin/main'),
    /must be an ancestor of HEAD/i,
  );
});
