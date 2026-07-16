import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkerPath = resolve(repositoryRoot, 'scripts/check-public.sh');

function run(repo: string, command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
  });
}

function git(repo: string, args: string[]): void {
  const result = run(repo, 'git', args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function createRepository(t: TestContext): string {
  const repo = mkdtempSync(join(tmpdir(), 'check-public-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  writeFileSync(
    join(repo, '.gitignore'),
    readFileSync(join(repositoryRoot, '.gitignore'), 'utf8'),
    'utf8',
  );
  git(repo, ['add', '.gitignore']);
  return repo;
}

function write(repo: string, path: string, content: string | Buffer): void {
  const absolutePath = join(repo, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function writeTracked(repo: string, path: string, content: string): void {
  write(repo, path, content);
  git(repo, ['add', '--', path]);
}

function check(repo: string) {
  return run(repo, 'bash', [checkerPath]);
}

function assertPasses(repo: string): void {
  const result = check(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertPrivateLeak(repo: string): void {
  const result = check(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private (?:contact )?data found/i);
}

function createRootWorkEntry(repo: string, type: 'file' | 'symlink'): void {
  if (type === 'file') {
    write(repo, 'work', '{"project":"private"}\n');
  } else {
    symlinkSync('private-target', join(repo, 'work'));
  }
}

function commitIndex(repo: string, message: string): void {
  git(repo, [
    '-c',
    'user.name=Test User',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    message,
  ]);
}

test('root work ignore covers a regular file, directory, and symbolic link', async (t) => {
  const cases: Array<[string, (repo: string) => void]> = [
    ['regular file', (repo) => createRootWorkEntry(repo, 'file')],
    ['directory', (repo) => mkdirSync(join(repo, 'work'))],
    ['symbolic link', (repo) => createRootWorkEntry(repo, 'symlink')],
  ];

  for (const [name, prepare] of cases) {
    await t.test(name, (subtest) => {
      const repo = createRepository(subtest);
      prepare(repo);
      const result = run(repo, 'git', ['check-ignore', '-q', '--', 'work']);

      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
});

test('rejects force-added root work files and symbolic links', async (t) => {
  for (const type of ['file', 'symlink'] as const) {
    await t.test(type, (subtest) => {
      const repo = createRepository(subtest);
      createRootWorkEntry(repo, type);
      git(repo, ['add', '-f', '--', 'work']);

      const result = check(repo);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /tracked work file is forbidden/i);
      assert.match(result.stderr, /(?:^|\n)work(?:\n|$)/i);
    });
  }
});

test('rejects root work files and symbolic links already tracked in HEAD', async (t) => {
  for (const type of ['file', 'symlink'] as const) {
    await t.test(type, (subtest) => {
      const repo = createRepository(subtest);
      createRootWorkEntry(repo, type);
      git(repo, ['add', '-f', '--', 'work']);
      commitIndex(repo, `track root work ${type}`);

      const result = check(repo);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /tracked work file is forbidden/i);
      assert.match(result.stderr, /(?:^|\n)work(?:\n|$)/i);
    });
  }
});

test('rejects a force-added file below the root work directory', (t) => {
  const repo = createRepository(t);
  write(repo, 'work/private.json', '{"project":"private"}\n');
  git(repo, ['add', '-f', '--', 'work/private.json']);

  const result = check(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracked work file is forbidden/i);
  assert.match(result.stderr, /work\/private\.json/i);
});

test('passes for clean tracked public inputs', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'data/approved/current.json', '{"project":"public"}\n');

  assertPasses(repo);
});

test('passes while scanning the privacy validator source itself', (t) => {
  const repo = createRepository(t);
  const validatorSource = readFileSync(
    join(repositoryRoot, 'src/lib/snapshot-validation.ts'),
    'utf8',
  );
  writeTracked(repo, 'src/lib/snapshot-validation.ts', validatorSource);

  assertPasses(repo);
});

test('rejects every private token and contact category', async (t) => {
  const cases = [
    ['submitted project IDs', '{"submittedProjectIds":[]}'],
    ['submitted target path', '{"path":"targets/submitted/example"}'],
    ['welfare score', '{"welfareScore":5}'],
    ['city platform value', '{"cityPlatformValue":5}'],
    ['social value', '{"socialValue":5}'],
    ['recommendation tier', '{"recommendationTier":"A"}'],
    ['profile target path', '{"path":"profile_space/targets/example"}'],
    ['macOS user path', '{"path":"/Users/alice/private.json"}'],
    ['Unix home path', '{"path":"/home/alice/private.json"}'],
    ['macOS file URI', '{"path":"file:///Users/alice/private.json"}'],
    ['Unix file URI', '{"path":"file:///home/alice/private.json"}'],
    ['uppercase file URI', '{"path":"FILE:///Users/alice/private.json"}'],
    ['file URI with authority', '{"path":"file://localhost/Users/alice/private.json"}'],
    ['Windows backslash user path', String.raw`{"path":"C:\Users\Alice\private.json"}`],
    ['Windows slash user path', '{"path":"C:/Users/Alice/private.json"}'],
    ['email address', '{"contact":"student@example.com"}'],
    ['URL encoded email address', '{"contact":"student%40example.com"}'],
    ['Chinese mobile number', '{"phone":"13800138000"}'],
    ['hyphenated Chinese mobile number', '{"phone":"138-0013-8000"}'],
    ['spaced Chinese mobile number', '{"phone":"138 0013 8000"}'],
    ['international Chinese mobile number', '{"phone":"+8613800138000"}'],
    ['spaced international Chinese mobile number', '{"phone":"+86 138 0013 8000"}'],
    ['hyphenated international Chinese mobile number', '{"phone":"+86-138-0013-8000"}'],
    ['encoded international Chinese mobile number', '{"phone":"%2B8613800138000"}'],
  ] as const;

  for (const [name, content] of cases) {
    await t.test(name, (subtest) => {
      const repo = createRepository(subtest);
      writeTracked(repo, 'data/approved/current.json', `${content}\n`);

      assertPrivateLeak(repo);
    });
  }
});

test('does not mistake an embedded legacy URL hash for a mobile number', (t) => {
  const repo = createRepository(t);
  writeTracked(
    repo,
    'src/data/legacy.json',
    '{"url":"https://legacy.example/84d17857554739/details"}\n',
  );

  assertPasses(repo);
});

test('allows ordinary submitted and welfare prose in public data and docs', (t) => {
  const repo = createRepository(t);
  writeTracked(
    repo,
    'data/approved/current.json',
    '{"message":"Application submitted successfully","summary":"Student welfare information"}\n',
  );
  writeTracked(
    repo,
    'docs/public-guide.md',
    'Application submitted successfully. Student welfare information is public.\n',
  );

  assertPasses(repo);
});

test('allows only explicitly reviewed public contacts in the legacy archive', (t) => {
  const repo = createRepository(t);
  writeTracked(
    repo,
    'src/data/legacy-schools.json',
    '{"contacts":["admissions@pjlab.org.cn","rbcc@hkust-gz.edu.cn"]}\n',
  );

  assertPasses(repo);
});

test('rejects every unreviewed contact in the legacy archive', async (t) => {
  for (const [name, content] of [
    ['email', '{"contact":"private@example.com"}'],
    ['phone', '{"phone":"13800138000"}'],
    [
      'extra contact beside an allowed address',
      '{"contacts":["admissions@pjlab.org.cn","private@example.com"]}',
    ],
    ['allowed address with local prefix', '{"contact":"eviladmissions@pjlab.org.cn"}'],
    ['allowed address with domain suffix', '{"contact":"rbcc@hkust-gz.edu.cn.evil"}'],
  ] as const) {
    await t.test(name, (subtest) => {
      const repo = createRepository(subtest);
      writeTracked(repo, 'src/data/legacy-schools.json', `${content}\n`);
      assertPrivateLeak(repo);
    });
  }
});

test('still scans private fields and paths inside the frozen legacy archive', async (t) => {
  for (const [name, content] of [
    ['private field', '{"submittedProjectIds":[]}'],
    ['private path', '{"path":"/Users/alice/profile.json"}'],
  ] as const) {
    await t.test(name, (subtest) => {
      const repo = createRepository(subtest);
      writeTracked(repo, 'src/data/legacy-schools.json', `${content}\n`);
      assertPrivateLeak(repo);
    });
  }
});

test('does not exempt similarly named mutable files from contact checks', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'src/data/legacy-schools-copy.json', '{"contact":"private@example.com"}\n');

  assertPrivateLeak(repo);
});

test('checks the staged index even when the worktree was cleaned afterward', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'data/approved/current.json', '{"contact":"private@example.com"}\n');
  write(repo, 'data/approved/current.json', '{"project":"clean worktree"}\n');

  assertPrivateLeak(repo);
});

test('checks the worktree even when the staged index is clean', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'data/approved/current.json', '{"project":"clean index"}\n');
  write(repo, 'data/approved/current.json', '{"contact":"private@example.com"}\n');

  assertPrivateLeak(repo);
});

test('rejects a private local path in docs from the worktree side', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'docs/plan.md', 'Public deployment plan\n');
  write(repo, 'docs/plan.md', 'Private source: /Users/alice/private.json\n');

  assertPrivateLeak(repo);
});

test('rejects a private marker in docs from the index side', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'docs/plan.md', 'Internal field: recommendationTier\n');
  write(repo, 'docs/plan.md', 'Public deployment plan\n');

  assertPrivateLeak(repo);
});

test('rejects private markers in built dist output', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'data/approved/current.json', '{"project":"clean"}\n');
  write(repo, 'dist/assets/app.js', 'const source = "/Users/alice/private.json";\n');

  assertPrivateLeak(repo);
});

test('rejects unreviewed contacts in built dist output', async (t) => {
  for (const [name, content] of [
    ['email', 'const contact = "private@example.com";\n'],
    ['phone', 'const phone = "138-0013-8000";\n'],
  ] as const) {
    await t.test(name, (subtest) => {
      const repo = createRepository(subtest);
      writeTracked(repo, 'data/approved/current.json', '{"project":"clean"}\n');
      write(repo, 'dist/assets/app.js', content);
      assertPrivateLeak(repo);
    });
  }
});

test('allows the exact reviewed public contacts in built dist output', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'data/approved/current.json', '{"project":"clean"}\n');
  write(
    repo,
    'dist/assets/app.js',
    'const contacts = ["admissions@pjlab.org.cn", "rbcc@hkust-gz.edu.cn"];\n',
  );

  assertPasses(repo);
});

test('rejects binary contact data in built dist output', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'data/approved/current.json', '{"project":"clean"}\n');
  write(repo, 'dist/assets/private.bin', Buffer.from('prefix\0private@example.com\0suffix'));

  assertPrivateLeak(repo);
});

test('rejects sensitive content in a tracked binary public input', (t) => {
  const repo = createRepository(t);
  writeTracked(repo, 'public/private.bin', Buffer.from('prefix\0private@example.com\0suffix'));

  assertPrivateLeak(repo);
});

test('ignores untracked staging JSON covered by gitignore', (t) => {
  const repo = createRepository(t);
  write(repo, 'data/staging/candidate.json', '{"phone":"13800138000"}\n');
  const ignored = run(repo, 'git', ['check-ignore', '-q', 'data/staging/candidate.json']);
  assert.equal(ignored.status, 0, ignored.stderr || ignored.stdout);

  assertPasses(repo);
});

test('rejects staging JSON even when force-tracked', (t) => {
  const repo = createRepository(t);
  write(repo, 'data/staging/candidate.json', '{"project":"private"}\n');
  git(repo, ['add', '-f', '--', 'data/staging/candidate.json']);

  const result = check(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracked staging JSON is forbidden/i);
});

test('rejects public CNAME', (t) => {
  const repo = createRepository(t);
  write(repo, 'public/CNAME', 'example.com\n');

  const result = check(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public\/CNAME is forbidden/i);
});

test('rejects the legacy update_json workflow', (t) => {
  const repo = createRepository(t);
  write(repo, '.github/workflows/update_json.yml', 'name: legacy\n');

  const result = check(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /update_json\.yml is forbidden/i);
});
