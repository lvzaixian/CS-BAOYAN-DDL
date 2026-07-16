import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const activateScript = resolve(repositoryRoot, 'deploy/activate-release.sh');
const bootstrapScript = resolve(repositoryRoot, 'deploy/bootstrap-server.sh');
const rollbackScript = resolve(repositoryRoot, 'deploy/rollback-release.sh');
const smokeScript = resolve(repositoryRoot, 'deploy/smoke.sh');
const workflowPath = resolve(repositoryRoot, '.github/workflows/deploy.yml');
const packagePath = resolve(repositoryRoot, 'package.json');
const lockfilePath = resolve(repositoryRoot, 'pnpm-lock.yaml');
const nginxTemplatePath = resolve(repositoryRoot, 'deploy/nginx/cs-baoyan-ddl.conf');
const baotaHttpTemplatePath = resolve(
  repositoryRoot,
  'deploy/nginx/cs-baoyan-ddl-bt-http.conf',
);
const baotaTlsTemplatePath = resolve(
  repositoryRoot,
  'deploy/nginx/cs-baoyan-ddl-bt-tls.conf',
);
const deployDocumentationPath = resolve(repositoryRoot, 'docs/operations/tencent-deploy.md');
const productionLaunchPlanPath = resolve(
  repositoryRoot,
  'docs/superpowers/plans/2026-07-16-production-launch-refresh-plan.md',
);
const rollbackDocumentationPath = resolve(repositoryRoot, 'docs/operations/rollback.md');
const expectedTitle = 'CS 保研 DDL · 倒计时';

interface ReleaseIdentity {
  releaseSha: string;
  snapshotId: string;
  dataHash: string;
}

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function assertTextOrder(text: string, needles: string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `expected ordered token after offset ${cursor}: ${needle}`);
    cursor = next;
  }
}

function markdownSection(source: string, heading: string, nextHeading: string): string {
  const start = source.indexOf(heading);
  const end = source.indexOf(nextHeading, start + heading.length);
  assert.ok(start >= 0, `missing Markdown heading: ${heading}`);
  assert.ok(end > start, `missing Markdown boundary after: ${heading}`);
  return source.slice(start, end);
}

function bashBlocks(source: string): string[] {
  return [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}

function firstBashBlock(source: string): string {
  const blocks = bashBlocks(source);
  assert.ok(blocks.length > 0, 'expected a fenced bash block');
  return blocks[0];
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

function setUnknownExtendedAttribute(path: string): string {
  const names = process.platform === 'darwin'
    ? ['com.openai.bootstrap-test', 'user.openai.bootstrap-test']
    : ['user.openai.bootstrap-test', 'com.openai.bootstrap-test'];

  const failures: string[] = [];
  for (const name of names) {
    const result = process.platform === 'darwin'
      ? spawnSync('xattr', ['-w', name, 'bootstrap-test', path], { encoding: 'utf8' })
      : spawnSync(
          'python3',
          [
            '-c',
            'import os, sys\nos.setxattr(sys.argv[1], sys.argv[2], b"bootstrap-test")\n',
            path,
            name,
          ],
          { encoding: 'utf8' },
        );
    if (result.status === 0) return name;
    failures.push(`${name}: ${result.stderr.trim()}`);
  }
  throw new Error(`could not set a test xattr on ${path}: ${failures.join('; ')}`);
}

function makeDeployRoot(
  t: TestContext,
  options: { fakeFlock?: boolean } = {},
): { deployRoot: string; fakeBin: string } {
  const sandbox = mkdtempSync(join(tmpdir(), 'deploy-scripts-'));
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+w', sandbox]);
    rmSync(sandbox, { recursive: true, force: true });
  });

  const deployRoot = join(sandbox, 'deploy-root');
  for (const path of [
    deployRoot,
    join(deployRoot, 'releases'),
    join(deployRoot, 'shared'),
    join(deployRoot, 'shared', 'staging'),
    join(deployRoot, 'transactions'),
  ]) {
    mkdirSync(path, { recursive: true });
  }

  const fakeBin = join(sandbox, 'bin');
  mkdirSync(fakeBin);
  if (options.fakeFlock !== false) {
    writeExecutable(join(fakeBin, 'flock'), '#!/bin/sh\nexit 0\n');
  }
  writeExecutable(
    join(fakeBin, 'sha256sum'),
    '#!/bin/sh\nif [ -n "${LOCK_PROBE_FILE:-}" ]; then : > "$LOCK_PROBE_FILE"; fi\nif [ -x /usr/bin/sha256sum ]; then exec /usr/bin/sha256sum "$@"; fi\nif [ "$1" = "-c" ]; then\n  shift\n  exec shasum -a 256 -c "$@"\nfi\nexec shasum -a 256 "$@"\n',
  );

  return { deployRoot, fakeBin };
}

function writeReleaseTree(
  directory: string,
  identity: ReleaseIdentity,
  marker = '',
  assetSource = '/assets/app.js',
): void {
  mkdirSync(join(directory, 'assets'), { recursive: true });
  writeFileSync(
    join(directory, 'index.html'),
    `<!doctype html><html><head><title>${expectedTitle}</title></head><body>${marker}<script type="module" src="${assetSource}"></script></body></html>`,
    'utf8',
  );
  writeFileSync(join(directory, 'assets', 'app.js'), `console.log(${JSON.stringify(marker)});\n`);
  writeFileSync(join(directory, 'release.json'), `${JSON.stringify(identity)}\n`, 'utf8');
}

function stageMaliciousArchive(
  deployRoot: string,
  runToken: string,
  kind: 'symlink' | 'path',
): { archiveSha: string } {
  const staging = join(deployRoot, 'shared', 'staging', runToken);
  mkdirSync(staging, { recursive: true });
  const archivePath = join(staging, 'release.tar.gz');
  const memberName = kind === 'symlink' ? 'assets/link.js' : '../../escaped-by-archive';
  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import io, sys, tarfile',
        'archive, kind, name = sys.argv[1:]',
        'with tarfile.open(archive, "w:gz") as bundle:',
        '    member = tarfile.TarInfo(name)',
        '    if kind == "symlink":',
        '        member.type = tarfile.SYMTYPE',
        '        member.linkname = "../../outside"',
        '        bundle.addfile(member)',
        '    else:',
        '        payload = b"escape"',
        '        member.size = len(payload)',
        '        bundle.addfile(member, io.BytesIO(payload))',
      ].join('\n'),
      archivePath,
      kind,
      memberName,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr || python.stdout);
  const archiveSha = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha256`, `${archiveSha}  release.tar.gz\n`, 'utf8');
  return { archiveSha };
}

function stageMemberLimitEarlyStopArchive(
  deployRoot: string,
  runToken: string,
): { archiveSha: string } {
  const staging = join(deployRoot, 'shared', 'staging', runToken);
  mkdirSync(staging, { recursive: true });
  const archivePath = join(staging, 'release.tar.gz');
  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import gzip, sys, tarfile',
        'archive = sys.argv[1]',
        'def record(name, payload):',
        '    member = tarfile.TarInfo(name)',
        '    member.size = len(payload)',
        '    padding = b"\\0" * ((512 - len(payload) % 512) % 512)',
        '    return member.tobuf(format=tarfile.USTAR_FORMAT) + payload + padding',
        'with gzip.open(archive, "wb") as output:',
        '    output.write(record("first.txt", b"first"))',
        '    output.write(record("second.txt", b"second"))',
        '    output.write(b"X" * 512)',
        '    output.write(b"\\0" * 1024)',
      ].join('\n'),
      archivePath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr || python.stdout);
  const archiveSha = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha256`, `${archiveSha}  release.tar.gz\n`, 'utf8');
  return { archiveSha };
}

function stageCompressedTarExtensionArchive(
  deployRoot: string,
  runToken: string,
  kind: 'gnu-long-name' | 'pax',
): { archiveSha: string } {
  const staging = join(deployRoot, 'shared', 'staging', runToken);
  mkdirSync(staging, { recursive: true });
  const archivePath = join(staging, 'release.tar.gz');
  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import gzip, sys, tarfile',
        'archive, kind = sys.argv[1:]',
        'payload_size = 2 * 1024 * 1024',
        'sentinel = b"DO_NOT_LOG_LONG_PATH/"',
        'if kind == "gnu-long-name":',
        '    payload = sentinel + b"A" * (payload_size - len(sentinel) - 1) + b"\\0"',
        '    extension_type = tarfile.GNUTYPE_LONGNAME',
        '    extension_name = "././@LongLink"',
        '    archive_format = tarfile.GNU_FORMAT',
        'else:',
        '    prefix = b"2097152 path="',
        '    payload = prefix + sentinel + b"A" * (payload_size - len(prefix) - len(sentinel) - 1) + b"\\n"',
        '    extension_type = tarfile.XHDTYPE',
        '    extension_name = "PaxHeader"',
        '    archive_format = tarfile.USTAR_FORMAT',
        'assert len(payload) == payload_size',
        'extension = tarfile.TarInfo(extension_name)',
        'extension.type = extension_type',
        'extension.size = len(payload)',
        'regular = tarfile.TarInfo("placeholder")',
        'regular.size = 0',
        'padding = b"\\0" * ((512 - len(payload) % 512) % 512)',
        'with gzip.open(archive, "wb", compresslevel=9) as output:',
        '    output.write(extension.tobuf(format=archive_format))',
        '    output.write(payload)',
        '    output.write(padding)',
        '    output.write(regular.tobuf(format=tarfile.USTAR_FORMAT))',
        '    output.write(b"\\0" * 1024)',
      ].join('\n'),
      archivePath,
      kind,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr || python.stdout);
  assert.ok(statSync(archivePath).size < 64 * 1024, 'fixture must remain highly compressed');
  const archiveSha = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha256`, `${archiveSha}  release.tar.gz\n`, 'utf8');
  return { archiveSha };
}

function stageArchive(
  deployRoot: string,
  runToken: string,
  identity: ReleaseIdentity,
  marker = '',
): { archiveSha: string; archivePath: string } {
  const staging = join(deployRoot, 'shared', 'staging', runToken);
  const source = join(staging, 'source');
  mkdirSync(source, { recursive: true });
  writeReleaseTree(source, identity, marker);

  const archivePath = join(staging, 'release.tar.gz');
  const tar = spawnSync('tar', ['--format=ustar', '-czf', archivePath, '-C', source, '.'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  assert.equal(tar.status, 0, tar.stderr || tar.stdout);
  rmSync(source, { recursive: true, force: true });

  const archiveSha = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha256`, `${archiveSha}  release.tar.gz\n`, 'utf8');
  return { archiveSha, archivePath };
}

function restageArchive(
  deployRoot: string,
  fromArchive: string,
  runToken: string,
): { archiveSha: string } {
  const staging = join(deployRoot, 'shared', 'staging', runToken);
  mkdirSync(staging, { recursive: true });
  const archivePath = join(staging, 'release.tar.gz');
  copyFileSync(fromArchive, archivePath);
  copyFileSync(`${fromArchive}.sha256`, `${archivePath}.sha256`);
  return {
    archiveSha: createHash('sha256').update(readFileSync(archivePath)).digest('hex'),
  };
}

function runScript(path: string, env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', [path], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
  });
}

interface BootstrapHarness {
  configPath: string;
  customNginx: string;
  flockLog: string;
  installLog: string;
  mvLog: string;
  nginxLog: string;
  sandbox: string;
  systemctlLog: string;
  run: (env?: NodeJS.ProcessEnv) => ScriptResult;
}

function makeBootstrapHarness(t: TestContext): BootstrapHarness {
  const sandbox = mkdtempSync(join(tmpdir(), 'bootstrap-server-'));
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+w', sandbox]);
    rmSync(sandbox, { recursive: true, force: true });
  });

  const fakeBin = join(sandbox, 'bin');
  const deployRoot = join(sandbox, 'deploy-root');
  const configPath = join(sandbox, 'nginx', 'site.conf');
  const flockLog = join(sandbox, 'flock.log');
  const installLog = join(sandbox, 'install.log');
  const mvLog = join(sandbox, 'mv.log');
  const nginxLog = join(sandbox, 'nginx.log');
  const systemctlLog = join(sandbox, 'systemctl.log');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });

  writeExecutable(
    join(fakeBin, 'id'),
    '#!/bin/sh\n' +
      'if [ "$#" -eq 1 ] && [ "$1" = "$BOOTSTRAP_DEPLOY_USER" ]; then exit 0; fi\n' +
      'if [ "$#" -eq 2 ] && [ "$1" = "-gn" ] && [ "$2" = "$BOOTSTRAP_DEPLOY_USER" ]; then printf "%s\\n" "$BOOTSTRAP_DEPLOY_USER"; exit 0; fi\n' +
      'exec /usr/bin/id "$@"\n',
  );
  writeExecutable(
    join(fakeBin, 'install'),
    '#!/bin/sh\n' +
      'directory=0\n' +
      'mode=\n' +
      'while [ "$#" -gt 0 ]; do\n' +
      '  case "$1" in\n' +
      '    -d) directory=1; shift ;;\n' +
      '    -m) mode=$2; shift 2 ;;\n' +
      '    -o|-g) shift 2 ;;\n' +
      '    --) shift; break ;;\n' +
      '    -*) exit 2 ;;\n' +
      '    *) break ;;\n' +
      '  esac\n' +
      'done\n' +
      'if [ "$directory" -eq 1 ]; then mkdir -p -- "$@"; exit 0; fi\n' +
      '[ "$#" -eq 2 ] || exit 2\n' +
      'printf "%s\\n" "$2" >> "$BOOTSTRAP_INSTALL_LOG"\n' +
      'mkdir -p -- "${2%/*}"\n' +
      'cp -- "$1" "$2"\n' +
      'if [ -n "$mode" ]; then chmod "$mode" "$2"; fi\n',
  );
  writeExecutable(
    join(fakeBin, 'mv'),
    '#!/bin/sh\n' +
      'destination=\n' +
      'for argument do destination=$argument; done\n' +
      'printf "%s\\n" "$destination" >> "$BOOTSTRAP_MV_LOG"\n' +
      'exec /bin/mv "$@"\n',
  );
  writeExecutable(
    join(fakeBin, 'systemctl'),
    '#!/bin/sh\n' +
      'printf "%s\\n" "$*" >> "$BOOTSTRAP_SYSTEMCTL_LOG"\n' +
      'if [ -n "${BOOTSTRAP_SYSTEMCTL_FAIL_ONCE:-}" ] && [ ! -e "$BOOTSTRAP_SYSTEMCTL_FAIL_ONCE" ]; then\n' +
      '  : > "$BOOTSTRAP_SYSTEMCTL_FAIL_ONCE"\n' +
      '  exit 1\n' +
      'fi\n' +
      'exit 0\n',
  );
  writeExecutable(
    join(fakeBin, 'flock'),
    '#!/bin/sh\n' +
      'printf "%s\\n" "$*" >> "$BOOTSTRAP_FLOCK_LOG"\n' +
      'exit "${BOOTSTRAP_FLOCK_STATUS:-0}"\n',
  );
  for (const commandName of ['curl', 'sha256sum', 'tar']) {
    writeExecutable(join(fakeBin, commandName), '#!/bin/sh\nexit 0\n');
  }

  const nginxStub =
    '#!/bin/sh\n' +
      'printf "%s\\n" "$*" >> "$BOOTSTRAP_NGINX_LOG"\n' +
      'if [ -n "${BOOTSTRAP_NGINX_FAIL_ONCE:-}" ] && [ ! -e "$BOOTSTRAP_NGINX_FAIL_ONCE" ]; then\n' +
      '  : > "$BOOTSTRAP_NGINX_FAIL_ONCE"\n' +
      '  exit 1\n' +
      'fi\n' +
      'if [ "$*" = "-s reload" ] && [ -n "${BOOTSTRAP_NGINX_RELOAD_FAIL_ONCE:-}" ] && [ ! -e "$BOOTSTRAP_NGINX_RELOAD_FAIL_ONCE" ]; then\n' +
      '  : > "$BOOTSTRAP_NGINX_RELOAD_FAIL_ONCE"\n' +
      '  exit 1\n' +
      'fi\n' +
      'exit "${BOOTSTRAP_NGINX_STATUS:-0}"\n';
  const customNginx = join(fakeBin, 'selected-nginx');
  writeExecutable(customNginx, nginxStub);
  writeExecutable(join(fakeBin, 'nginx'), nginxStub);

  const source = readFileSync(bootstrapScript, 'utf8');
  const rootExpression = '${EUID:-$(id -u)}';
  assert.equal(source.split(rootExpression).length - 1, 1, 'root gate changed unexpectedly');
  let testableSource = source.replace(
    rootExpression,
    '${BOOTSTRAP_TEST_EUID:-${EUID:-$(id -u)}}',
  );
  if (process.platform === 'darwin') {
    // APFS attaches protected provenance to test fixtures. Permit it only in
    // the generated test copy; production remains limited to security.selinux.
    const productionAllowlist = 'allowed_extended_attributes = {"security.selinux"}';
    assert.equal(
      source.split(productionAllowlist).length - 1,
      1,
      'production xattr allowlist changed unexpectedly',
    );
    testableSource = testableSource.replace(
      productionAllowlist,
      'allowed_extended_attributes = {"security.selinux", "com.apple.provenance"}',
    );
  }
  const testableScript = join(sandbox, 'bootstrap-server.sh');
  writeExecutable(testableScript, testableSource);

  return {
    configPath,
    customNginx,
    flockLog,
    installLog,
    mvLog,
    nginxLog,
    sandbox,
    systemctlLog,
    run: (env = {}) => {
      const result = spawnSync('bash', [testableScript], {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          ...process.env,
          BOOTSTRAP_DEPLOY_USER: 'deploy-test',
          BOOTSTRAP_FLOCK_LOG: flockLog,
          BOOTSTRAP_INSTALL_LOG: installLog,
          BOOTSTRAP_MV_LOG: mvLog,
          BOOTSTRAP_NGINX_LOG: nginxLog,
          BOOTSTRAP_SYSTEMCTL_LOG: systemctlLog,
          BOOTSTRAP_TEST_EUID: '0',
          DEPLOY_ROOT: deployRoot,
          DEPLOY_USER: 'deploy-test',
          NGINX_BIN: customNginx,
          NGINX_CONFIG: configPath,
          SERVER_NAME: 'ddl.example.com',
          TLS_CERTIFICATE: '',
          TLS_CERTIFICATE_KEY: '',
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          ...env,
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

function currentTarget(deployRoot: string): string | null {
  const current = join(deployRoot, 'current');
  return existsSync(current) ? realpathSync(current) : null;
}

function releasePath(deployRoot: string, releaseSha: string): string {
  return join(realpathSync(deployRoot), 'releases', releaseSha);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function waitForPath(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function startCurrentFixture(
  t: TestContext,
  deployRoot: string,
  options: {
    expectedHost?: string;
    corruptIdentity?: boolean;
    missingAssetStatus?: number;
    redirectHomeTo?: string;
  } = {},
): Promise<string> {
  const server = createServer((request, response) => {
    if (options.expectedHost && request.headers.host !== options.expectedHost) {
      response.writeHead(421).end('wrong host');
      return;
    }

    if (options.redirectHomeTo && request.url === '/') {
      response.writeHead(302, { Location: options.redirectHomeTo }).end('redirect');
      return;
    }

    const current = join(deployRoot, 'current');
    if (!existsSync(current)) {
      response.writeHead(503).end('no current release');
      return;
    }

    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (pathname.startsWith('/assets/__deploy_smoke_missing__')) {
      response.writeHead(options.missingAssetStatus ?? 404).end('missing');
      return;
    }

    let relativePath: string;
    if (pathname === '/') {
      relativePath = 'index.html';
    } else if (pathname === '/release.json') {
      relativePath = 'release.json';
    } else if (pathname.startsWith('/assets/')) {
      relativePath = pathname.slice(1);
    } else {
      relativePath = 'index.html';
    }

    const path = join(current, relativePath);
    if (!existsSync(path)) {
      response.writeHead(404).end('missing');
      return;
    }

    let body = readFileSync(path);
    if (options.corruptIdentity && relativePath === 'release.json') {
      const identity = JSON.parse(body.toString('utf8')) as ReleaseIdentity;
      identity.dataHash = 'f'.repeat(64);
      body = Buffer.from(`${JSON.stringify(identity)}\n`);
    }
    response.writeHead(200, {
      'Content-Type': relativePath.endsWith('.json') ? 'application/json' : 'text/html',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  return `http://127.0.0.1:${port}`;
}

function deployEnv(
  deployRoot: string,
  fakeBin: string,
  smokeUrl: string,
  runToken: string,
  identity: ReleaseIdentity,
  archiveSha: string,
): NodeJS.ProcessEnv {
  return {
    DEPLOY_ROOT: deployRoot,
    RUN_TOKEN: runToken,
    RELEASE_SHA: identity.releaseSha,
    ARCHIVE_SHA: archiveSha,
    EXPECTED_SNAPSHOT_ID: identity.snapshotId,
    EXPECTED_DATA_HASH: identity.dataHash,
    SMOKE_URL: smokeUrl,
    SMOKE_HOST_HEADER: 'ddl.test',
    SMOKE_ATTEMPTS: '2',
    SMOKE_RETRY_DELAY: '0',
    SMOKE_CONNECT_TIMEOUT: '1',
    SMOKE_MAX_TIME: '2',
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
}

test('publishes versioned read-only releases, reuses identical SHA, rejects checksum conflicts, and rolls back by transaction', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const smokeUrl = await startCurrentFixture(t, deployRoot, { expectedHost: 'ddl.test' });
  const first: ReleaseIdentity = {
    releaseSha: '1'.repeat(40),
    snapshotId: 'snapshot-one',
    dataHash: 'a'.repeat(64),
  };
  const second: ReleaseIdentity = {
    releaseSha: '2'.repeat(40),
    snapshotId: 'snapshot-two',
    dataHash: 'b'.repeat(64),
  };

  const firstArchive = stageArchive(deployRoot, 'run-first', first, 'first');
  const firstResult = await runScript(
    activateScript,
    deployEnv(deployRoot, fakeBin, smokeUrl, 'run-first', first, firstArchive.archiveSha),
  );
  assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, first.releaseSha));
  assert.equal(
    readFileSync(join(deployRoot, 'releases', first.releaseSha, '.archive-sha256'), 'utf8'),
    `${firstArchive.archiveSha}\n`,
  );
  assert.equal(
    statSync(join(deployRoot, 'releases', first.releaseSha, '.archive-sha256')).mode & 0o222,
    0,
  );

  const secondArchive = stageArchive(deployRoot, 'run-second', second, 'second');
  const secondResult = await runScript(
    activateScript,
    deployEnv(deployRoot, fakeBin, smokeUrl, 'run-second', second, secondArchive.archiveSha),
  );
  assert.equal(secondResult.status, 0, secondResult.stderr || secondResult.stdout);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, second.releaseSha));
  assert.equal(
    readFileSync(join(deployRoot, 'transactions', 'run-second', 'previous'), 'utf8').trim(),
    releasePath(deployRoot, first.releaseSha),
  );

  const secondReleaseInode = statSync(join(deployRoot, 'releases', second.releaseSha)).ino;
  const reuse = restageArchive(deployRoot, secondArchive.archivePath, 'run-reuse');
  const reuseResult = await runScript(
    activateScript,
    deployEnv(deployRoot, fakeBin, smokeUrl, 'run-reuse', second, reuse.archiveSha),
  );
  assert.equal(reuseResult.status, 0, reuseResult.stderr || reuseResult.stdout);
  assert.equal(statSync(join(deployRoot, 'releases', second.releaseSha)).ino, secondReleaseInode);

  const conflict = stageArchive(deployRoot, 'run-conflict', second, 'conflicting archive');
  const conflictResult = await runScript(
    activateScript,
    deployEnv(deployRoot, fakeBin, smokeUrl, 'run-conflict', second, conflict.archiveSha),
  );
  assert.notEqual(conflictResult.status, 0);
  assert.match(conflictResult.stderr, /checksum.*conflict/i);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, second.releaseSha));

  const rollbackResult = await runScript(rollbackScript, {
    DEPLOY_ROOT: deployRoot,
    RUN_TOKEN: 'run-second',
    FAILED_RELEASE_SHA: second.releaseSha,
    SMOKE_URL: smokeUrl,
    SMOKE_HOST_HEADER: 'ddl.test',
    SMOKE_ATTEMPTS: '2',
    SMOKE_RETRY_DELAY: '0',
    SMOKE_CONNECT_TIMEOUT: '1',
    SMOKE_MAX_TIME: '2',
    PATH: `${fakeBin}:${process.env.PATH}`,
  });
  assert.equal(rollbackResult.status, 0, rollbackResult.stderr || rollbackResult.stdout);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, first.releaseSha));

  const repeatedRollback = await runScript(rollbackScript, {
    DEPLOY_ROOT: deployRoot,
    RUN_TOKEN: 'run-second',
    FAILED_RELEASE_SHA: second.releaseSha,
    SMOKE_URL: smokeUrl,
    SMOKE_HOST_HEADER: 'ddl.test',
    SMOKE_ATTEMPTS: '2',
    SMOKE_RETRY_DELAY: '0',
    SMOKE_CONNECT_TIMEOUT: '1',
    SMOKE_MAX_TIME: '2',
    PATH: `${fakeBin}:${process.env.PATH}`,
  });
  assert.equal(repeatedRollback.status, 0, repeatedRollback.stderr || repeatedRollback.stdout);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, first.releaseSha));
});

test('transaction rollback restores the first release after the second activation process dies post-switch', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const smokeUrl = await startCurrentFixture(t, deployRoot, { expectedHost: 'ddl.test' });
  const first: ReleaseIdentity = {
    releaseSha: '6'.repeat(40),
    snapshotId: 'snapshot-six',
    dataHash: '6'.repeat(64),
  };
  const second: ReleaseIdentity = {
    releaseSha: '7'.repeat(40),
    snapshotId: 'snapshot-seven',
    dataHash: '7'.repeat(64),
  };
  const firstArchive = stageArchive(deployRoot, 'run-crash-first', first, 'first');
  const firstResult = await runScript(
    activateScript,
    deployEnv(
      deployRoot,
      fakeBin,
      smokeUrl,
      'run-crash-first',
      first,
      firstArchive.archiveSha,
    ),
  );
  assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);

  const crashSmoke = join(dirname(deployRoot), 'crash-after-switch-smoke.sh');
  writeExecutable(
    crashSmoke,
    `#!/usr/bin/env bash\nset -eu\ncurrent=${JSON.stringify(join(deployRoot, 'current'))}\ncurrent_sha=$(python3 - "$current" <<'PY'\nimport os, sys\nprint(os.path.basename(os.path.realpath(sys.argv[1])))\nPY\n)\nif test "$current_sha" = "$EXPECTED_RELEASE_SHA"; then\n  kill -KILL "$PPID"\n  exit 99\nfi\nexec bash ${JSON.stringify(smokeScript)}\n`,
  );
  const secondArchive = stageArchive(deployRoot, 'run-crash-second', second, 'second');
  const crashed = await runScript(activateScript, {
    ...deployEnv(
      deployRoot,
      fakeBin,
      smokeUrl,
      'run-crash-second',
      second,
      secondArchive.archiveSha,
    ),
    SMOKE_SCRIPT: crashSmoke,
  });
  assert.notEqual(crashed.status, 0);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, second.releaseSha));

  const rollbackEnv = {
    DEPLOY_ROOT: deployRoot,
    RUN_TOKEN: 'run-crash-second',
    FAILED_RELEASE_SHA: second.releaseSha,
    SMOKE_URL: smokeUrl,
    SMOKE_HOST_HEADER: 'ddl.test',
    SMOKE_ATTEMPTS: '2',
    SMOKE_RETRY_DELAY: '0',
    SMOKE_CONNECT_TIMEOUT: '1',
    SMOKE_MAX_TIME: '2',
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const rollback = await runScript(rollbackScript, rollbackEnv);
  assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, first.releaseSha));
  const repeated = await runScript(rollbackScript, rollbackEnv);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, first.releaseSha));
});

test('activation rejects malicious tar symlinks and traversal paths before extraction', async (t) => {
  for (const [kind, runToken] of [
    ['symlink', 'run-malicious-symlink'],
    ['path', 'run-malicious-path'],
  ] as const) {
    await t.test(kind, async (subtest) => {
      const { deployRoot, fakeBin } = makeDeployRoot(subtest);
      const identity: ReleaseIdentity = {
        releaseSha: kind === 'symlink' ? '8'.repeat(40) : '9'.repeat(40),
        snapshotId: `snapshot-malicious-${kind}`,
        dataHash: kind === 'symlink' ? '8'.repeat(64) : '9'.repeat(64),
      };
      const archive = stageMaliciousArchive(deployRoot, runToken, kind);
      const result = await runScript(
        activateScript,
        deployEnv(deployRoot, fakeBin, 'http://127.0.0.1:1', runToken, identity, archive.archiveSha),
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /raw tar preflight rejected archive: (?:raw tar header type is forbidden|path escapes archive root)|archive member (?:type is forbidden|escapes extraction root)/i,
      );
      assert.equal(existsSync(join(dirname(deployRoot), 'escaped-by-archive')), false);
      assert.equal(existsSync(join(deployRoot, 'current')), false);
    });
  }
});

test('activation stops raw preflight at the member limit before extracting archive records', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const runToken = 'run-member-limit-early-stop';
  const identity: ReleaseIdentity = {
    releaseSha: 'f'.repeat(40),
    snapshotId: 'snapshot-member-limit-early-stop',
    dataHash: 'f'.repeat(64),
  };
  const archive = stageMemberLimitEarlyStopArchive(deployRoot, runToken);
  const result = await runScript(activateScript, {
    ...deployEnv(
      deployRoot,
      fakeBin,
      'http://127.0.0.1:1',
      runToken,
      identity,
      archive.archiveSha,
    ),
    ARCHIVE_MAX_MEMBERS: '1',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(?:archive )?member count exceeds limit: 2 > 1/i);
  const extractDirectory = join(deployRoot, 'shared', 'staging', runToken, 'extracted');
  assert.equal(existsSync(extractDirectory), false);
  assert.equal(existsSync(join(deployRoot, 'releases', identity.releaseSha)), false);
  assert.equal(existsSync(join(deployRoot, 'current')), false);
});

test('raw tar preflight rejects compressed GNU LongName and PAX headers before extension payloads', async (t) => {
  for (const [index, kind] of ['gnu-long-name', 'pax'].entries()) {
    await t.test(kind, async (subtest) => {
      const { deployRoot, fakeBin } = makeDeployRoot(subtest);
      const runToken = `run-raw-extension-${index}`;
      const identity: ReleaseIdentity = {
        releaseSha: (index + 1).toString(16).repeat(40),
        snapshotId: `snapshot-raw-extension-${index}`,
        dataHash: (index + 1).toString(16).repeat(64),
      };
      const archive = stageCompressedTarExtensionArchive(
        deployRoot,
        runToken,
        kind as 'gnu-long-name' | 'pax',
      );
      const result = await runScript(activateScript, {
        ...deployEnv(
          deployRoot,
          fakeBin,
          'http://127.0.0.1:1',
          runToken,
          identity,
          archive.archiveSha,
        ),
        ARCHIVE_MAX_MEMBERS: '1',
        ARCHIVE_MAX_FILE_BYTES: '1',
        ARCHIVE_MAX_EXPANDED_BYTES: '1',
        ARCHIVE_MAX_PATH_BYTES: '1',
      });

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.length < 1024, `stderr length was ${result.stderr.length}`);
      assert.match(result.stderr, /raw tar header type is forbidden at member 1/i);
      assert.doesNotMatch(result.stderr, /DO_NOT_LOG_LONG_PATH/);
      assert.equal(
        existsSync(join(deployRoot, 'shared', 'staging', runToken, 'extracted')),
        false,
      );
    });
  }
});

test('activation enforces compressed, member, file, expanded, and disk archive limits', async (t) => {
  const cases: Array<{
    name: string;
    override: Record<string, string>;
    expected: RegExp;
  }> = [
    {
      name: 'compressed archive bytes',
      override: { ARCHIVE_MAX_BYTES: '1' },
      expected: /compressed archive.*limit/i,
    },
    {
      name: 'archive member count',
      override: { ARCHIVE_MAX_MEMBERS: '1' },
      expected: /member count.*limit/i,
    },
    {
      name: 'single archive file bytes',
      override: { ARCHIVE_MAX_FILE_BYTES: '1' },
      expected: /file size.*limit/i,
    },
    {
      name: 'total expanded bytes',
      override: { ARCHIVE_MAX_EXPANDED_BYTES: '1' },
      expected: /expanded size.*limit/i,
    },
    {
      name: 'archive member path bytes',
      override: { ARCHIVE_MAX_PATH_BYTES: '1' },
      expected: /path length.*limit/i,
    },
    {
      name: 'free disk bytes',
      override: { ARCHIVE_MIN_FREE_BYTES: '999999999999999999999999999999' },
      expected: /free disk space.*required/i,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async (subtest) => {
      const { deployRoot, fakeBin } = makeDeployRoot(subtest);
      const identity: ReleaseIdentity = {
        releaseSha: (index + 1).toString(16).repeat(40),
        snapshotId: `snapshot-limit-${index}`,
        dataHash: (index + 1).toString(16).repeat(64),
      };
      const runToken = `run-limit-${index}`;
      const archive = stageArchive(deployRoot, runToken, identity, entry.name);
      const result = await runScript(activateScript, {
        ...deployEnv(
          deployRoot,
          fakeBin,
          'http://127.0.0.1:1',
          runToken,
          identity,
          archive.archiveSha,
        ),
        ...entry.override,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, entry.expected);
      assert.equal(existsSync(join(deployRoot, 'releases', identity.releaseSha)), false);
    });
  }
});

test('archive limit overrides are strict and cannot weaken hard bounds', async (t) => {
  const cases = [
    ['ARCHIVE_MAX_BYTES', '0'],
    ['ARCHIVE_MAX_MEMBERS', 'not-a-number'],
    ['ARCHIVE_MAX_FILE_BYTES', '-1'],
    ['ARCHIVE_MAX_EXPANDED_BYTES', '134217729'],
    ['ARCHIVE_MAX_PATH_BYTES', '257'],
    ['ARCHIVE_MIN_FREE_BYTES', '1'],
  ] as const;

  for (const [index, [name, value]] of cases.entries()) {
    await t.test(name, async (subtest) => {
      const { deployRoot, fakeBin } = makeDeployRoot(subtest);
      const identity: ReleaseIdentity = {
        releaseSha: 'e'.repeat(39) + index.toString(16),
        snapshotId: `snapshot-invalid-limit-${index}`,
        dataHash: 'e'.repeat(63) + index.toString(16),
      };
      const runToken = `run-invalid-limit-${index}`;
      const archive = stageArchive(deployRoot, runToken, identity, name);
      const result = await runScript(activateScript, {
        ...deployEnv(
          deployRoot,
          fakeBin,
          'http://127.0.0.1:1',
          runToken,
          identity,
          archive.archiveSha,
        ),
        [name]: value,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
    });
  }
});

test('Linux activation uses real flock to serialize concurrent releases', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('real flock concurrency is a required Linux/CI gate; macOS runs skip explicitly');
    return;
  }
  const flockProbe = spawnSync('flock', ['--version'], { encoding: 'utf8' });
  assert.equal(flockProbe.status, 0, 'Linux CI must provide util-linux flock');

  const { deployRoot, fakeBin } = makeDeployRoot(t, { fakeFlock: false });
  const smokeUrl = await startCurrentFixture(t, deployRoot);
  const first: ReleaseIdentity = {
    releaseSha: '6'.repeat(40),
    snapshotId: 'snapshot-flock-first',
    dataHash: '6'.repeat(64),
  };
  const second: ReleaseIdentity = {
    releaseSha: '7'.repeat(40),
    snapshotId: 'snapshot-flock-second',
    dataHash: '7'.repeat(64),
  };
  const firstArchive = stageArchive(deployRoot, 'run-flock-first', first, 'flock-first');
  const secondArchive = stageArchive(deployRoot, 'run-flock-second', second, 'flock-second');
  const firstEntered = join(dirname(deployRoot), 'first-entered');
  const secondEntered = join(dirname(deployRoot), 'second-entered');
  const releaseGate = join(dirname(deployRoot), 'release-first');
  const blockingSmoke = join(dirname(deployRoot), 'blocking-smoke.sh');
  writeExecutable(
    blockingSmoke,
    `#!/usr/bin/env bash\nset -eu\nif test "$EXPECTED_RELEASE_SHA" = "$FIRST_RELEASE_SHA"; then\n  : > "$FIRST_ENTERED"\n  while test ! -e "$RELEASE_GATE"; do sleep 0.05; done\nelse\n  : > "$SECOND_ENTERED"\nfi\nexec bash "$REAL_SMOKE_SCRIPT"\n`,
  );
  const probeEnv = {
    SMOKE_SCRIPT: blockingSmoke,
    FIRST_RELEASE_SHA: first.releaseSha,
    FIRST_ENTERED: firstEntered,
    SECOND_ENTERED: secondEntered,
    RELEASE_GATE: releaseGate,
    REAL_SMOKE_SCRIPT: smokeScript,
  };

  const firstResultPromise = runScript(activateScript, {
    ...deployEnv(
      deployRoot,
      fakeBin,
      smokeUrl,
      'run-flock-first',
      first,
      firstArchive.archiveSha,
    ),
    ...probeEnv,
  });
  let secondResultPromise: Promise<ScriptResult> | null = null;
  try {
    await waitForPath(firstEntered);
    secondResultPromise = runScript(activateScript, {
      ...deployEnv(
        deployRoot,
        fakeBin,
        smokeUrl,
        'run-flock-second',
        second,
        secondArchive.archiveSha,
      ),
      ...probeEnv,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.equal(existsSync(secondEntered), false, 'second activation crossed the real flock');
  } finally {
    writeFileSync(releaseGate, 'release\n');
  }

  const firstResult = await firstResultPromise;
  assert.ok(secondResultPromise, 'second activation must start after the first enters smoke');
  const secondResult = await secondResultPromise;
  assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(secondResult.status, 0, secondResult.stderr || secondResult.stdout);
  assert.equal(existsSync(secondEntered), true);
  assert.equal(currentTarget(deployRoot), releasePath(deployRoot, second.releaseSha));
});

test('transaction rollback rejects symlinked transaction files', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const smokeUrl = await startCurrentFixture(t, deployRoot);
  const identity: ReleaseIdentity = {
    releaseSha: 'a'.repeat(40),
    snapshotId: 'snapshot-transaction-file',
    dataHash: 'a'.repeat(64),
  };
  const archive = stageArchive(deployRoot, 'run-transaction-file', identity, 'transaction');
  const activated = await runScript(
    activateScript,
    deployEnv(
      deployRoot,
      fakeBin,
      smokeUrl,
      'run-transaction-file',
      identity,
      archive.archiveSha,
    ),
  );
  assert.equal(activated.status, 0, activated.stderr || activated.stdout);

  const previousFile = join(deployRoot, 'transactions', 'run-transaction-file', 'previous');
  rmSync(previousFile);
  symlinkSync(join(deployRoot, 'current'), previousFile);
  const result = await runScript(rollbackScript, {
    DEPLOY_ROOT: deployRoot,
    RUN_TOKEN: 'run-transaction-file',
    FAILED_RELEASE_SHA: identity.releaseSha,
    SMOKE_URL: smokeUrl,
    PATH: `${fakeBin}:${process.env.PATH}`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transaction.*regular|unsafe transaction/i);
});

test('failed first activation removes current and rejects path-shaped release identifiers', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const smokeUrl = await startCurrentFixture(t, deployRoot, {
    expectedHost: 'ddl.test',
    corruptIdentity: true,
  });
  const identity: ReleaseIdentity = {
    releaseSha: '3'.repeat(40),
    snapshotId: 'snapshot-three',
    dataHash: 'c'.repeat(64),
  };
  const archive = stageArchive(deployRoot, 'run-failed-first', identity, 'failed-first');
  const failed = await runScript(
    activateScript,
    deployEnv(
      deployRoot,
      fakeBin,
      smokeUrl,
      'run-failed-first',
      identity,
      archive.archiveSha,
    ),
  );
  assert.notEqual(failed.status, 0);
  assert.equal(
    existsSync(join(deployRoot, 'current')),
    false,
    failed.stderr || failed.stdout,
  );

  const rejected = await runScript(activateScript, {
    ...deployEnv(
      deployRoot,
      fakeBin,
      smokeUrl,
      'run-path-reject',
      { ...identity, releaseSha: '../../outside' },
      archive.archiveSha,
    ),
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /RELEASE_SHA.*40.*hex/i);
  assert.equal(existsSync(join(dirname(deployRoot), 'outside')), false);
});

test('smoke verifies exact release identity, title, asset, SPA fallback, and missing asset status', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const identity: ReleaseIdentity = {
    releaseSha: '4'.repeat(40),
    snapshotId: 'snapshot-four',
    dataHash: 'd'.repeat(64),
  };
  const release = join(deployRoot, 'releases', identity.releaseSha);
  writeReleaseTree(release, identity, 'smoke');
  symlinkSync(release, join(deployRoot, 'current'));
  const smokeUrl = await startCurrentFixture(t, deployRoot, { expectedHost: 'ddl.test' });
  const env = {
    EXPECTED_RELEASE_SHA: identity.releaseSha,
    EXPECTED_SNAPSHOT_ID: identity.snapshotId,
    EXPECTED_DATA_HASH: identity.dataHash,
    SMOKE_URL: smokeUrl,
    SMOKE_HOST_HEADER: 'ddl.test',
    SMOKE_ATTEMPTS: '2',
    SMOKE_RETRY_DELAY: '0',
    SMOKE_CONNECT_TIMEOUT: '1',
    SMOKE_MAX_TIME: '2',
    PATH: `${fakeBin}:${process.env.PATH}`,
  };

  const passed = await runScript(smokeScript, env);
  assert.equal(passed.status, 0, passed.stderr || passed.stdout);

  const wrongIdentity = await runScript(smokeScript, {
    ...env,
    EXPECTED_SNAPSHOT_ID: 'wrong-snapshot',
  });
  assert.notEqual(wrongIdentity.status, 0);
  assert.match(wrongIdentity.stderr, /smoke failed/i);
});

test('smoke fails when a missing asset does not return 404', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const identity: ReleaseIdentity = {
    releaseSha: '5'.repeat(40),
    snapshotId: 'snapshot-five',
    dataHash: 'e'.repeat(64),
  };
  const release = join(deployRoot, 'releases', identity.releaseSha);
  writeReleaseTree(release, identity, 'bad-missing-asset');
  symlinkSync(release, join(deployRoot, 'current'));
  const smokeUrl = await startCurrentFixture(t, deployRoot, { missingAssetStatus: 200 });

  const result = await runScript(smokeScript, {
    SMOKE_URL: smokeUrl,
    EXPECTED_RELEASE_SHA: identity.releaseSha,
    EXPECTED_SNAPSHOT_ID: identity.snapshotId,
    EXPECTED_DATA_HASH: identity.dataHash,
    SMOKE_ATTEMPTS: '1',
    SMOKE_RETRY_DELAY: '0',
    SMOKE_CONNECT_TIMEOUT: '1',
    SMOKE_MAX_TIME: '2',
    PATH: `${fakeBin}:${process.env.PATH}`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /smoke failed/i);
});

test('smoke rejects a cross-origin redirect without contacting the redirect target', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const identity: ReleaseIdentity = {
    releaseSha: 'b'.repeat(40),
    snapshotId: 'snapshot-cross-origin-redirect',
    dataHash: 'b'.repeat(64),
  };
  const release = join(deployRoot, 'releases', identity.releaseSha);
  writeReleaseTree(release, identity, 'redirect-source');
  symlinkSync(release, join(deployRoot, 'current'));

  let redirectTargetRequests = 0;
  const redirectTarget = createServer((_request, response) => {
    redirectTargetRequests += 1;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(readFileSync(join(release, 'index.html')));
  });
  const redirectTargetPort = await listen(redirectTarget);
  t.after(() => new Promise<void>((resolveClose) => redirectTarget.close(() => resolveClose())));
  const smokeUrl = await startCurrentFixture(t, deployRoot, {
    redirectHomeTo: `http://127.0.0.1:${redirectTargetPort}/`,
  });

  const result = await runScript(smokeScript, {
    SMOKE_URL: smokeUrl,
    EXPECTED_RELEASE_SHA: identity.releaseSha,
    EXPECTED_SNAPSHOT_ID: identity.snapshotId,
    EXPECTED_DATA_HASH: identity.dataHash,
    SMOKE_ATTEMPTS: '1',
    SMOKE_RETRY_DELAY: '0',
    PATH: `${fakeBin}:${process.env.PATH}`,
  });
  assert.notEqual(result.status, 0);
  assert.equal(redirectTargetRequests, 0);
});

test('smoke rejects an absolute cross-origin JavaScript asset', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const identity: ReleaseIdentity = {
    releaseSha: 'c'.repeat(40),
    snapshotId: 'snapshot-cross-origin-asset',
    dataHash: 'c'.repeat(64),
  };
  let assetRequests = 0;
  const assetServer = createServer((_request, response) => {
    assetRequests += 1;
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('console.log("cross")');
  });
  const assetPort = await listen(assetServer);
  t.after(() => new Promise<void>((resolveClose) => assetServer.close(() => resolveClose())));

  const release = join(deployRoot, 'releases', identity.releaseSha);
  writeReleaseTree(
    release,
    identity,
    'cross-origin-asset',
    `http://127.0.0.1:${assetPort}/assets/app.js`,
  );
  symlinkSync(release, join(deployRoot, 'current'));
  const smokeUrl = await startCurrentFixture(t, deployRoot);
  const result = await runScript(smokeScript, {
    SMOKE_URL: smokeUrl,
    EXPECTED_RELEASE_SHA: identity.releaseSha,
    EXPECTED_SNAPSHOT_ID: identity.snapshotId,
    EXPECTED_DATA_HASH: identity.dataHash,
    SMOKE_ATTEMPTS: '1',
    SMOKE_RETRY_DELAY: '0',
    PATH: `${fakeBin}:${process.env.PATH}`,
  });
  assert.notEqual(result.status, 0);
  assert.equal(assetRequests, 0);
});

test('smoke requires a credential-free HTTP(S) root origin and strict expected hashes', async (t) => {
  const { deployRoot, fakeBin } = makeDeployRoot(t);
  const identity: ReleaseIdentity = {
    releaseSha: 'd'.repeat(40),
    snapshotId: 'snapshot-strict-input',
    dataHash: 'd'.repeat(64),
  };
  const release = join(deployRoot, 'releases', identity.releaseSha);
  writeReleaseTree(release, identity, 'strict-input');
  symlinkSync(release, join(deployRoot, 'current'));
  const smokeUrl = await startCurrentFixture(t, deployRoot);
  const baseEnv = {
    EXPECTED_RELEASE_SHA: identity.releaseSha,
    EXPECTED_SNAPSHOT_ID: identity.snapshotId,
    EXPECTED_DATA_HASH: identity.dataHash,
    SMOKE_ATTEMPTS: '1',
    SMOKE_RETRY_DELAY: '0',
    PATH: `${fakeBin}:${process.env.PATH}`,
  };

  for (const invalidUrl of [
    `${smokeUrl}/nested`,
    `${smokeUrl}?query=1`,
    `${smokeUrl}#fragment`,
    smokeUrl.replace('http://', 'http://user:password@'),
    smokeUrl.replace('http://', 'ftp://'),
  ]) {
    const result = await runScript(smokeScript, { ...baseEnv, SMOKE_URL: invalidUrl });
    assert.notEqual(result.status, 0, invalidUrl);
    assert.match(result.stderr, /SMOKE_URL.*root origin/i);
  }

  const invalidHash = await runScript(smokeScript, {
    ...baseEnv,
    SMOKE_URL: smokeUrl,
    EXPECTED_DATA_HASH: 'not-a-hash',
  });
  assert.notEqual(invalidHash.status, 0);
  assert.match(invalidHash.stderr, /EXPECTED_DATA_HASH.*64.*hex/i);
});

test('package metadata exposes no gh-pages deployment bypass', () => {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(Object.hasOwn(packageJson.scripts ?? {}, 'deploy'), false);
  for (const command of Object.values(packageJson.scripts ?? {})) {
    assert.doesNotMatch(command, /gh-pages/i);
  }
  assert.equal(packageJson.dependencies?.['gh-pages'], undefined);
  assert.equal(packageJson.devDependencies?.['gh-pages'], undefined);
  assert.doesNotMatch(readFileSync(lockfilePath, 'utf8'), /gh-pages/i);
});

test('workflow isolates build output, package control plane, and production deployment', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const prepareStart = workflow.indexOf('  prepare:');
  const controlPlaneStart = workflow.indexOf('  package-control-plane:');
  const deployStart = workflow.indexOf('  deploy:');
  assert.ok(
    prepareStart >= 0 && controlPlaneStart > prepareStart && deployStart > controlPlaneStart,
  );
  const prepare = workflow.slice(prepareStart, controlPlaneStart);
  const controlPlane = workflow.slice(controlPlaneStart, deployStart);
  const deploy = workflow.slice(deployStart);

  assert.doesNotMatch(prepare, /environment:\s*production/);
  assert.doesNotMatch(prepare, /secrets\./);
  assert.match(prepare, /pnpm install --frozen-lockfile/);
  assert.match(prepare, /pnpm run test:unit/);
  assert.match(prepare, /pnpm run snapshot:validate/);
  assert.match(prepare, /pnpm run check:public/);
  assert.match(prepare, /pnpm run check/);
  assert.match(prepare, /pnpm run build/);
  assert.match(prepare, /tar --format=ustar/);
  assert.match(
    prepare,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );
  assert.doesNotMatch(prepare, /deploy\/|(?:activate|rollback)-release\.sh|smoke\.sh/);

  assert.doesNotMatch(controlPlane, /environment:\s*production|secrets\./);
  assert.match(
    controlPlane,
    /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/,
  );
  assert.match(controlPlane, /persist-credentials:\s*false/);
  assert.doesNotMatch(controlPlane, /\b(?:pnpm|npm|yarn|bun)\b|setup-node|action-setup/);
  assert.doesNotMatch(controlPlane, /(?:bash|sh|source|\.)\s+(?:\.\/)?deploy\//);
  assert.doesNotMatch(controlPlane, /pnpm run|npm run|node\s|tsx|vite|svelte-check/);
  assert.match(
    controlPlane,
    /scripts=\(activate-release\.sh rollback-release\.sh smoke\.sh\)/,
  );
  assert.match(controlPlane, /source_path="deploy\/\$script"/);
  assert.match(controlPlane, /scripts\.sha256/);
  assert.match(
    controlPlane,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );

  assert.match(deploy, /needs:\s*\[prepare, package-control-plane\]/);
  assert.match(deploy, /environment:\s*production/);
  assert.equal(
    [...deploy.matchAll(/actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/g)]
      .length,
    2,
  );
  assert.ok(deploy.indexOf('Download build artifact') < deploy.indexOf('Configure pinned SSH'));
  assert.ok(
    deploy.indexOf('Download control-plane artifact') < deploy.indexOf('Configure pinned SSH'),
  );
  assert.doesNotMatch(deploy, /actions\/checkout@/);
  assert.doesNotMatch(deploy, /pnpm\/action-setup@|actions\/setup-node@/);
  assert.doesNotMatch(deploy, /pnpm install|pnpm run build|npm (?:ci|install|run build)/);
  assert.doesNotMatch(deploy, /bash deploy\//);
  assert.match(deploy, /BUILD_BUNDLE_DIR/);
  assert.match(deploy, /CONTROL_BUNDLE_DIR/);
  assert.match(deploy, /"\$CONTROL_BUNDLE_DIR\/scripts\.sha256"/);
  assert.match(deploy, /bash "\$CONTROL_BUNDLE_DIR\/smoke\.sh"/);
  assert.doesNotMatch(deploy, /\$BUILD_BUNDLE_DIR\/(?:activate|rollback)-release\.sh/);
  assert.doesNotMatch(deploy, /\$BUILD_BUNDLE_DIR\/smoke\.sh/);
  assert.match(deploy, /rm -f -- "\$HOME\/\.ssh\/deploy_key" "\$HOME\/\.ssh\/known_hosts"/);

  for (const match of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
    assert.match(match[1], /^[0-9a-f]{40}$/, `action is not pinned: ${match[0]}`);
  }
});

test('workflow bridges smoke identity, compensates attempted activation, and rechecks main adjacent to activation', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const publicSmokeStart = workflow.indexOf('- name: Run public release smoke');
  const compensationStart = workflow.indexOf('- name: Compensate');
  assert.ok(publicSmokeStart >= 0 && compensationStart > publicSmokeStart);
  const publicSmoke = workflow.slice(publicSmokeStart, compensationStart);
  assert.match(publicSmoke, /EXPECTED_RELEASE_SHA="\$RELEASE_SHA"/);
  assert.match(publicSmoke, /EXPECTED_SNAPSHOT_ID="\$EXPECTED_SNAPSHOT_ID"/);
  assert.match(publicSmoke, /EXPECTED_DATA_HASH="\$EXPECTED_DATA_HASH"/);
  assert.match(publicSmoke, /SMOKE_URL="\$PUBLIC_BASE_URL"/);

  const compensationEnd = workflow.indexOf('- name: Remove remote staging', compensationStart);
  const compensation = workflow.slice(compensationStart, compensationEnd);
  assert.match(compensation, /steps\.activate\.outcome != 'skipped'/);
  assert.doesNotMatch(compensation, /steps\.activate\.outcome == 'success'/);

  const upload = workflow.indexOf('- name: Upload release archive');
  const activate = workflow.indexOf('- name: Verify archive and activate release');
  const adjacentMainCheck = workflow.lastIndexOf('latest_main=', activate);
  assert.ok(upload >= 0 && adjacentMainCheck > upload && adjacentMainCheck < activate);
});

test('Nginx rejects unknown Host values before serving the release', () => {
  const template = readFileSync(nginxTemplatePath, 'utf8');
  assert.match(template, /listen 80 default_server;/);
  assert.match(template, /server_name _;/);
  assert.match(template, /return 444;/);
  assert.match(template, /if \(\$host != "__SERVER_NAME__"\)/);
});

test('BaoTa HTTP template avoids a competing default server and preserves the static-site contract', () => {
  assert.ok(existsSync(baotaHttpTemplatePath), 'BaoTa HTTP template must exist');
  const standardTemplate = readFileSync(nginxTemplatePath, 'utf8');
  const template = readFileSync(baotaHttpTemplatePath, 'utf8');

  assert.doesNotMatch(template, /default_server/);
  assert.match(template, /listen 80;/);
  assert.match(template, /listen \[::\]:80;/);
  assert.match(template, /server_name __SERVER_NAME__;/);
  assert.match(template, /if \(\$host != "__SERVER_NAME__"\)/);
  assert.match(template, /root __DEPLOY_ROOT__\/current;/);
  assert.match(template, /location = \/release\.json[\s\S]*?Cache-Control "no-store, no-cache, must-revalidate"/);
  assert.match(template, /location ~ \(\^\|\/\)\\\.[\s\S]*?return 404;/);
  assert.match(template, /location \/assets\/[\s\S]*?Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(template, /try_files \$uri \$uri\/ \/index\.html;/);

  const securityHeaderNames = (source: string): string[] =>
    [...new Set(
      [...source.matchAll(/add_header\s+([A-Za-z-]+)\s+/g)]
        .map((match) => match[1])
        .filter((name) => name !== 'Cache-Control'),
    )].sort();
  assert.deepEqual(securityHeaderNames(template), securityHeaderNames(standardTemplate));
});

test('BaoTa TLS template defines exact-domain redirect and final HTTPS routing', () => {
  assert.ok(existsSync(baotaTlsTemplatePath), 'BaoTa TLS template must exist');
  const standardTemplate = readFileSync(nginxTemplatePath, 'utf8');
  const template = readFileSync(baotaTlsTemplatePath, 'utf8');

  assert.doesNotMatch(template, /default_server/);
  assert.match(template, /listen 80;/);
  assert.match(template, /listen \[::\]:80;/);
  assert.match(template, /listen 443 ssl;/);
  assert.match(template, /listen \[::\]:443 ssl;/);
  assert.match(template, /http2 on;/);
  assert.match(template, /ssl_certificate __TLS_CERTIFICATE__;/);
  assert.match(template, /ssl_certificate_key __TLS_CERTIFICATE_KEY__;/);
  assert.match(template, /return 308 https:\/\/__SERVER_NAME__\$request_uri;/);
  assert.equal(template.match(/if \(\$host != "__SERVER_NAME__"\)/g)?.length, 2);
  assert.match(template, /root __DEPLOY_ROOT__\/current;/);
  assert.match(template, /location = \/release\.json[\s\S]*?Cache-Control "no-store, no-cache, must-revalidate"/);
  assert.match(template, /location ~ \(\^\|\/\)\\\.[\s\S]*?return 404;/);
  assert.match(template, /location \/assets\/[\s\S]*?Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(template, /try_files \$uri \$uri\/ \/index\.html;/);

  const securityHeaderNames = (source: string): string[] =>
    [...new Set(
      [...source.matchAll(/add_header\s+([A-Za-z-]+)\s+/g)]
        .map((match) => match[1])
        .filter((name) => name !== 'Cache-Control'),
    )].sort();
  assert.deepEqual(securityHeaderNames(template), securityHeaderNames(standardTemplate));
});

test('bootstrap validates both BaoTa templates with the selected Nginx binary', async (t) => {
  await t.test('absolute binary renders the HTTP template', () => {
    assert.ok(existsSync(baotaHttpTemplatePath), 'BaoTa HTTP template must exist');
    const harness = makeBootstrapHarness(t);
    const result = harness.run({ NGINX_TEMPLATE: baotaHttpTemplatePath });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = readFileSync(harness.configPath, 'utf8');
    assert.match(config, /server_name ddl\.example\.com;/);
    assert.match(config, new RegExp(`root ${resolve(harness.sandbox, 'deploy-root')}/current;`));
    assert.doesNotMatch(config, /__[A-Z_]+__/);
    assert.equal(readFileSync(harness.nginxLog, 'utf8'), '-t\n-s reload\n');
  });

  await t.test('bare binary renders literal TLS paths', () => {
    assert.ok(existsSync(baotaTlsTemplatePath), 'BaoTa TLS template must exist');
    const harness = makeBootstrapHarness(t);
    const certificate = '/www/server/panel/vhost/cert/ddl.example.com/fullchain.pem';
    const certificateKey = '/www/server/panel/vhost/cert/ddl.example.com/privkey.pem';
    const result = harness.run({
      NGINX_BIN: 'selected-nginx',
      NGINX_TEMPLATE: baotaTlsTemplatePath,
      TLS_CERTIFICATE: certificate,
      TLS_CERTIFICATE_KEY: certificateKey,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = readFileSync(harness.configPath, 'utf8');
    assert.match(config, new RegExp(`ssl_certificate ${certificate};`));
    assert.match(config, new RegExp(`ssl_certificate_key ${certificateKey};`));
    assert.doesNotMatch(config, /__[A-Z_]+__/);
    assert.equal(readFileSync(harness.nginxLog, 'utf8'), '-t\n-s reload\n');
  });
});

test('bootstrap review: TLS completion names only untouched external surfaces', (t) => {
  const harness = makeBootstrapHarness(t);
  const result = harness.run({
    NGINX_TEMPLATE: baotaTlsTemplatePath,
    TLS_CERTIFICATE: '/cert/live/fullchain.pem',
    TLS_CERTIFICATE_KEY: '/cert/live/privkey.pem',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /No firewall, sshd, DNS, or certificate files were changed\./,
  );
  assert.doesNotMatch(result.stdout, /TLS settings were changed/);
});

test('bootstrap review: standard template succeeds with empty TLS inputs and default nginx', (t) => {
  const harness = makeBootstrapHarness(t);
  const result = harness.run({
    NGINX_BIN: '',
    NGINX_TEMPLATE: nginxTemplatePath,
    TLS_CERTIFICATE: '',
    TLS_CERTIFICATE_KEY: '',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(harness.nginxLog, 'utf8'), '-t\n-s reload\n');
  const config = readFileSync(harness.configPath, 'utf8');
  assert.match(config, /server_name ddl\.example\.com;/);
  assert.doesNotMatch(config, /__TLS_CERTIFICATE(?:_KEY)?__/);
  assert.match(
    result.stdout,
    /No firewall, sshd, DNS, or certificate files were changed\./,
  );
});

test('bootstrap hardening: selected binary owns validation and reload identity', async (t) => {
  await t.test('success validates and reloads through the same selected binary', () => {
    const harness = makeBootstrapHarness(t);
    const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(harness.nginxLog, 'utf8'), '-t\n-s reload\n');
    assert.equal(existsSync(harness.systemctlLog), false);
  });

  await t.test('reload recovery validates and reloads through the same selected binary', () => {
    const harness = makeBootstrapHarness(t);
    writeFileSync(harness.configPath, 'previous config\n', 'utf8');
    const failOnce = join(harness.sandbox, 'selected-nginx-reload-failed-once');
    const result = harness.run({
      BOOTSTRAP_NGINX_RELOAD_FAIL_ONCE: failOnce,
      NGINX_TEMPLATE: nginxTemplatePath,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recovery reload signal command accepted/);
    assert.doesNotMatch(result.stderr, /\b(?:applied|active|reloaded|serving)\b/i);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'previous config\n');
    assert.equal(
      readFileSync(harness.nginxLog, 'utf8'),
      '-t\n-s reload\n-t\n-s reload\n',
    );
    assert.equal(existsSync(harness.systemctlLog), false);
  });
});

test('bootstrap host gates: xattrs, idempotence, and reload semantics are bounded', async (t) => {
  await t.test('unknown platform-settable xattr is rejected without modifying config', () => {
    const harness = makeBootstrapHarness(t);
    writeFileSync(harness.configPath, 'xattr-protected config\n', 'utf8');
    const xattrName = setUnknownExtendedAttribute(harness.configPath);

    const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported extended attributes/i);
    assert.ok(result.stderr.includes(xattrName), result.stderr);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'xattr-protected config\n');
    assert.equal(existsSync(harness.installLog), false);
    assert.equal(existsSync(harness.mvLog), false);
  });

  await t.test('metadata validator allowlists only security.selinux', () => {
    const source = readFileSync(bootstrapScript, 'utf8');
    assert.match(
      source,
      /allowed_extended_attributes\s*=\s*\{"security\.selinux"\}/,
    );
    assert.match(
      source,
      /unknown_extended_attributes\s*=\s*sorted\(set\(extended_attributes\) - allowed_extended_attributes\)/,
    );
    assert.doesNotMatch(source, /removexattr|setxattr/);
  });

  await t.test('two consecutive bootstraps remain idempotent', () => {
    const harness = makeBootstrapHarness(t);
    const first = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstConfig = readFileSync(harness.configPath, 'utf8');

    const second = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(readFileSync(harness.configPath, 'utf8'), firstConfig);
    assert.equal(
      readFileSync(harness.nginxLog, 'utf8'),
      '-t\n-s reload\n-t\n-s reload\n',
    );
    assert.equal(readFileSync(harness.flockLog, 'utf8'), '-n 9\n-n 9\n');
  });

  await t.test('successful signal command does not claim configuration application', () => {
    const harness = makeBootstrapHarness(t);
    const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /reload signal command accepted by selected Nginx binary/i);
    assert.doesNotMatch(
      result.stdout,
      /configuration (?:applied|active)|workers? reloaded|now serving/i,
    );
  });

  await t.test('recovery signal acceptance does not claim worker reload', () => {
    const harness = makeBootstrapHarness(t);
    writeFileSync(harness.configPath, 'previous config\n', 'utf8');
    const failOnce = join(harness.sandbox, 'selected-nginx-reload-failed-once');
    const result = harness.run({
      BOOTSTRAP_NGINX_RELOAD_FAIL_ONCE: failOnce,
      NGINX_TEMPLATE: nginxTemplatePath,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recovery reload signal command accepted/);
    assert.doesNotMatch(result.stderr, /\b(?:applied|active|reloaded|serving)\b/i);
  });
});

test('bootstrap hardening: TLS template rejects absent or mismatched SNI', () => {
  const template = readFileSync(baotaTlsTemplatePath, 'utf8');
  const httpsServerOffset = template.indexOf('listen 443 ssl;');
  const sniGuard = 'if ($ssl_server_name != "__SERVER_NAME__")';

  assert.ok(httpsServerOffset >= 0, 'TLS server block must exist');
  assert.equal(template.split(sniGuard).length - 1, 1);
  assert.ok(template.indexOf(sniGuard) > httpsServerOffset);
  assert.match(
    template.slice(template.indexOf(sniGuard)),
    /if \(\$ssl_server_name != "__SERVER_NAME__"\) \{\s*return 444;\s*\}/,
  );
});

test('bootstrap hardening: existing config identity and metadata are strict', async (t) => {
  await t.test('symlinked NGINX_CONFIG is rejected without modifying its target', () => {
    const harness = makeBootstrapHarness(t);
    const target = join(harness.sandbox, 'symlink-target.conf');
    writeFileSync(target, 'symlink target config\n', 'utf8');
    symlinkSync(target, harness.configPath);

    const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NGINX_CONFIG.*symbolic link/i);
    assert.equal(readFileSync(target, 'utf8'), 'symlink target config\n');
    assert.equal(lstatSync(harness.configPath).isSymbolicLink(), true);
    assert.equal(existsSync(harness.installLog), false);
    assert.equal(existsSync(harness.mvLog), false);
  });

  await t.test('non-0644 NGINX_CONFIG is rejected without modifying the file', () => {
    const harness = makeBootstrapHarness(t);
    writeFileSync(harness.configPath, 'mode-sensitive config\n', 'utf8');
    chmodSync(harness.configPath, 0o600);

    const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NGINX_CONFIG.*mode 0644/i);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'mode-sensitive config\n');
    assert.equal(statSync(harness.configPath).mode & 0o777, 0o600);
    assert.equal(existsSync(harness.installLog), false);
    assert.equal(existsSync(harness.mvLog), false);
  });

  await t.test('validator requires regular single-link process ownership and xattr inspection', () => {
    const source = readFileSync(bootstrapScript, 'utf8');
    assert.match(source, /stat\.S_ISREG/);
    assert.match(source, /st_nlink/);
    assert.match(source, /st_uid[^\n]*os\.geteuid\(\)/);
    assert.match(source, /st_gid[^\n]*os\.getegid\(\)/);
    assert.match(source, /os\.listxattr/);
  });
});

test('bootstrap hardening: per-config lock serializes publication', async (t) => {
  await t.test('non-blocking lock failure stops before target modification', () => {
    const harness = makeBootstrapHarness(t);
    writeFileSync(harness.configPath, 'locked config\n', 'utf8');

    const result = harness.run({
      BOOTSTRAP_FLOCK_STATUS: '1',
      NGINX_TEMPLATE: nginxTemplatePath,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not acquire bootstrap lock/i);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'locked config\n');
    assert.equal(existsSync(harness.installLog), false);
    assert.equal(existsSync(harness.mvLog), false);
    assert.equal(existsSync(harness.nginxLog), false);
  });

  await t.test('symlinked lock path is rejected without modifying the config', () => {
    const harness = makeBootstrapHarness(t);
    writeFileSync(harness.configPath, 'config before symlinked lock\n', 'utf8');
    const lockTarget = join(harness.sandbox, 'lock-target');
    writeFileSync(lockTarget, 'lock target\n', 'utf8');
    symlinkSync(lockTarget, `${harness.configPath}.lock`);

    const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap lock path must not be a symbolic link/i);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'config before symlinked lock\n');
    assert.equal(readFileSync(lockTarget, 'utf8'), 'lock target\n');
    assert.equal(existsSync(harness.installLog), false);
    assert.equal(existsSync(harness.mvLog), false);
  });

  await t.test('selected per-config lock is acquired and held across reload', () => {
    const harness = makeBootstrapHarness(t);
    const lockPath = `${harness.configPath}.lock`;
    const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(lockPath), 'selected per-config lock file must exist');
    assert.match(readFileSync(harness.flockLog, 'utf8'), /^-n [0-9]+\n$/);
    assert.match(result.stdout, new RegExp(`bootstrap lock acquired: ${lockPath}`));

    const source = readFileSync(bootstrapScript, 'utf8');
    assertTextOrder(source, [
      'config_lock_path="${NGINX_CONFIG}.lock"',
      'config_lock_fd=9',
      'exec 9<>"$config_lock_path"',
      'flock -n "$config_lock_fd"',
      'cp -p -- "$NGINX_CONFIG" "$backup_config"',
      '"$NGINX_BIN" -t',
      '"$NGINX_BIN" -s reload',
    ]);
  });
});

test('bootstrap review: successful config publication uses a same-directory atomic rename', (t) => {
  const harness = makeBootstrapHarness(t);
  const result = harness.run({ NGINX_TEMPLATE: nginxTemplatePath });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(existsSync(harness.installLog), 'config install must be recorded');
  const installTargets = readFileSync(harness.installLog, 'utf8').trim().split('\n');
  assert.equal(installTargets.length, 1);
  assert.equal(dirname(installTargets[0]), dirname(harness.configPath));
  assert.notEqual(installTargets[0], harness.configPath);
  assert.ok(existsSync(harness.mvLog), 'atomic config rename must be recorded');
  assert.equal(readFileSync(harness.mvLog, 'utf8'), `${harness.configPath}\n`);
});

test('selected Nginx binary rejects missing, non-executable, and shell-command values', async (t) => {
  await t.test('absolute binary must be executable', () => {
    const harness = makeBootstrapHarness(t);
    const nonExecutable = join(harness.sandbox, 'not-executable-nginx');
    writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', 'utf8');
    const result = harness.run({
      NGINX_BIN: nonExecutable,
      NGINX_TEMPLATE: nginxTemplatePath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NGINX_BIN is not executable/);
  });

  await t.test('bare binary must resolve through PATH', () => {
    const harness = makeBootstrapHarness(t);
    const result = harness.run({
      NGINX_BIN: 'missing-nginx',
      NGINX_TEMPLATE: nginxTemplatePath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required command is missing: missing-nginx/);
  });

  await t.test('path-shaped binary must be absolute', () => {
    const harness = makeBootstrapHarness(t);
    const relativeDirectory = join(harness.sandbox, 'relative');
    mkdirSync(relativeDirectory);
    writeExecutable(join(relativeDirectory, 'nginx'), '#!/bin/sh\nexit 0\n');
    const result = harness.run({
      NGINX_BIN: 'relative/nginx',
      NGINX_TEMPLATE: nginxTemplatePath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NGINX_BIN.*absolute path or a bare command name/);
  });

  await t.test('shell command text is never evaluated', () => {
    const harness = makeBootstrapHarness(t);
    const marker = join(harness.sandbox, 'pwned');
    const result = harness.run({
      NGINX_BIN: 'selected-nginx;touch pwned;#',
      NGINX_TEMPLATE: nginxTemplatePath,
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(readFileSync(bootstrapScript, 'utf8'), /\beval\b/);
  });
});

test('BaoTa TLS bootstrap requires safe absolute certificate paths', async (t) => {
  assert.ok(existsSync(baotaTlsTemplatePath), 'BaoTa TLS template must exist');
  const validCertificate = '/www/server/panel/vhost/cert/ddl.example.com/fullchain.pem';
  const validKey = '/www/server/panel/vhost/cert/ddl.example.com/privkey.pem';
  const cases: Array<[string, NodeJS.ProcessEnv]> = [
    ['missing paths', {}],
    ['missing key', { TLS_CERTIFICATE: validCertificate }],
    ['relative path', { TLS_CERTIFICATE: 'cert/fullchain.pem', TLS_CERTIFICATE_KEY: validKey }],
    ['traversal', { TLS_CERTIFICATE: '/cert/live/../fullchain.pem', TLS_CERTIFICATE_KEY: validKey }],
    ['whitespace', { TLS_CERTIFICATE: '/cert/live/full chain.pem', TLS_CERTIFICATE_KEY: validKey }],
    ['control character', { TLS_CERTIFICATE: validCertificate, TLS_CERTIFICATE_KEY: '/cert/live/private\tkey.pem' }],
    ['unsafe syntax', { TLS_CERTIFICATE: '/cert/live/fullchain.pem;touch-pwned', TLS_CERTIFICATE_KEY: validKey }],
  ];

  for (const [name, env] of cases) {
    await t.test(name, () => {
      const harness = makeBootstrapHarness(t);
      const result = harness.run({ NGINX_TEMPLATE: baotaTlsTemplatePath, ...env });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /TLS_CERTIFICATE(?:_KEY)?.*(?:required|absolute|unsafe)/i);
      assert.equal(existsSync(harness.configPath), false);
      assert.equal(existsSync(join(harness.sandbox, 'pwned')), false);
    });
  }
});

test('bootstrap review: BaoTa bootstrap reports validation and reload recovery exactly', async (t) => {
  await t.test('persistent validation failure restores but cannot revalidate the prior config', () => {
    assert.ok(existsSync(baotaHttpTemplatePath), 'BaoTa HTTP template must exist');
    const harness = makeBootstrapHarness(t);
    mkdirSync(dirname(harness.configPath), { recursive: true });
    writeFileSync(harness.configPath, 'previous HTTP config\n', 'utf8');
    const result = harness.run({
      BOOTSTRAP_NGINX_STATUS: '1',
      NGINX_TEMPLATE: baotaHttpTemplatePath,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /previous config restored but failed revalidation/);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'previous HTTP config\n');
    assert.equal(readFileSync(harness.nginxLog, 'utf8'), '-t\n-t\n');
  });

  await t.test('initial validation failure atomically restores and revalidates the prior config', () => {
    const harness = makeBootstrapHarness(t);
    mkdirSync(dirname(harness.configPath), { recursive: true });
    writeFileSync(harness.configPath, 'previous HTTP config\n', 'utf8');
    const failOnce = join(harness.sandbox, 'nginx-failed-once');
    const result = harness.run({
      BOOTSTRAP_NGINX_FAIL_ONCE: failOnce,
      NGINX_TEMPLATE: baotaHttpTemplatePath,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /previous config restored and revalidated/);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'previous HTTP config\n');
    assert.equal(readFileSync(harness.nginxLog, 'utf8'), '-t\n-t\n');
    const installTargets = readFileSync(harness.installLog, 'utf8').trim().split('\n');
    assert.equal(installTargets.length, 2);
    for (const target of installTargets) {
      assert.equal(dirname(target), dirname(harness.configPath));
      assert.notEqual(target, harness.configPath);
    }
    assert.equal(
      readFileSync(harness.mvLog, 'utf8'),
      `${harness.configPath}\n${harness.configPath}\n`,
    );
  });

  await t.test('first-install validation failure removes the candidate and revalidates the remainder', () => {
    const harness = makeBootstrapHarness(t);
    const failOnce = join(harness.sandbox, 'nginx-failed-once');
    const result = harness.run({
      BOOTSTRAP_NGINX_FAIL_ONCE: failOnce,
      NGINX_TEMPLATE: baotaHttpTemplatePath,
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /rendered config removed and remaining configuration revalidated; no previous config existed/,
    );
    assert.equal(existsSync(harness.configPath), false);
    assert.equal(readFileSync(harness.nginxLog, 'utf8'), '-t\n-t\n');
  });

  await t.test('TLS reload failure restores and revalidates the prior config', () => {
    assert.ok(existsSync(baotaTlsTemplatePath), 'BaoTa TLS template must exist');
    const harness = makeBootstrapHarness(t);
    mkdirSync(dirname(harness.configPath), { recursive: true });
    writeFileSync(harness.configPath, 'previous TLS config\n', 'utf8');
    const failOnce = join(harness.sandbox, 'selected-nginx-reload-failed-once');
    const result = harness.run({
      BOOTSTRAP_NGINX_RELOAD_FAIL_ONCE: failOnce,
      NGINX_TEMPLATE: baotaTlsTemplatePath,
      TLS_CERTIFICATE: '/cert/live/fullchain.pem',
      TLS_CERTIFICATE_KEY: '/cert/live/privkey.pem',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recovery reload signal command accepted/);
    assert.doesNotMatch(result.stderr, /\b(?:applied|active|reloaded|serving)\b/i);
    assert.equal(readFileSync(harness.configPath, 'utf8'), 'previous TLS config\n');
    assert.equal(
      readFileSync(harness.nginxLog, 'utf8'),
      '-t\n-s reload\n-t\n-s reload\n',
    );
    assert.equal(existsSync(harness.systemctlLog), false);
  });
});

test('BaoTa operations require a selected domain and keep final TLS launch gated', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  assert.match(deployment, /SELECTED_DOMAIN:\?user-approved domain is required/);
  assert.match(deployment, /case "\$SELECTED_DOMAIN" in \*\[!a-z0-9\.\-\]\*\|\.\*\|\*\.\.\*\|\*\.\) exit 1 ;; esac/);
  assert.match(deployment, /SERVER_NAME="\$SELECTED_DOMAIN"/);
  assert.match(deployment, /NGINX_BIN=\/www\/server\/nginx\/sbin\/nginx/);
  assert.match(deployment, /NGINX_TEMPLATE="\$PWD\/deploy\/nginx\/cs-baoyan-ddl-bt-http\.conf"/);
  assert.match(deployment, /NGINX_CONFIG="\/www\/server\/panel\/vhost\/nginx\/\$SELECTED_DOMAIN\.conf"/);
  assert.match(deployment, /--resolve "\$SELECTED_DOMAIN:80:127\.0\.0\.1"/);
  assert.match(deployment, /NGINX_TEMPLATE="\$PWD\/deploy\/nginx\/cs-baoyan-ddl-bt-tls\.conf"/);
  assert.match(deployment, /TLS_CERTIFICATE="\$TLS_CERTIFICATE"/);
  assert.match(deployment, /TLS_CERTIFICATE_KEY="\$TLS_CERTIFICATE_KEY"/);
  assert.match(deployment, /TLS[^。\n]*public launch[^。\n]*(?:stop gate|停止门)/i);
});

test('bootstrap review: operations describe atomic Nginx recovery without TLS overclaiming', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  assert.match(deployment, /同一目录[^。\n]*临时文件[^。\n]*原子重命名/);
  assert.match(
    deployment,
    /首次 `nginx -t` 失败[^。\n]*reload signal command 被拒绝[^。\n]*恢复旧配置[^。\n]*重新验证/,
  );
  assert.match(
    deployment,
    /原先不存在配置[^。\n]*删除本次新配置[^。\n]*不会[^。\n]*恢复了旧配置/,
  );
  assert.match(deployment, /certificate files/);
  assert.doesNotMatch(deployment, /不会触碰[^。\n]*TLS 资产/);
});

test('bootstrap hardening: operations document identity, SNI, metadata, and locking', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');

  assert.match(deployment, /`NGINX_BIN -t`[^。\n]*`NGINX_BIN -s reload`/);
  assert.doesNotMatch(deployment, /systemctl reload nginx/);
  assert.match(deployment, /Host[^。\n]*`\$ssl_server_name`[^。\n]*(?:SNI|域名)/i);
  assert.match(deployment, /`NGINX_CONFIG`[^。\n]*符号链接/);
  assert.match(
    deployment,
    /单链接[^。\n]*普通文件[^。\n]*`0644`[^。\n]*(?:UID|所有者)[^。\n]*(?:GID|属组)/,
  );
  assert.match(deployment, /扩展属性/);
  assert.match(
    deployment,
    /`\$\{NGINX_CONFIG\}\.lock`[^。\n]*符号链接[^。\n]*非阻塞[^。\n]*`flock`/,
  );
  assert.match(deployment, /--resolve "rejected\.invalid:443:127\.0\.0\.1"/);
  assert.match(
    deployment,
    /--header "Host: \$SELECTED_DOMAIN"[\s\S]{0,200}https:\/\/rejected\.invalid\//,
  );
  assert.match(
    deployment,
    /--header "Host: \$SELECTED_DOMAIN"[\s\S]{0,200}https:\/\/127\.0\.0\.1\//,
  );
});

test('bootstrap host gates: operations require SELinux, process, backup, and recovery evidence', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const bootstrap = readFileSync(bootstrapScript, 'utf8');

  assert.match(deployment, /`security\.selinux`[^。\n]*(?:允许|allowlist)/i);
  assert.match(deployment, /其余[^。\n]*xattr[^。\n]*fail closed/i);
  assert.match(deployment, /getenforce/);
  assert.match(deployment, /ls -lZ/);
  assert.match(deployment, /restorecon -n/);

  assert.match(deployment, /reload signal command accepted\/sent/i);
  assert.match(deployment, /不(?:表示|证明)[^。\n]*(?:应用|生效|worker)/i);
  assert.match(deployment, /NGINX_PID_FILE/);
  assert.match(deployment, /\$PROC_ROOT\/\$MASTER_PID\/exe/);
  assert.match(deployment, /\$PROC_ROOT\/\$MASTER_PID\/cmdline/);
  assert.match(deployment, /"\$NGINX_BIN" -V/);
  assert.match(deployment, /"\$NGINX_BIN" -T/);
  assert.match(deployment, /include/);
  assert.match(deployment, /WORKERS_BEFORE/);
  assert.match(deployment, /WORKERS_AFTER/);
  assert.match(deployment, /NEW_WORKERS/);
  assert.match(deployment, /error\.log/);
  assert.match(deployment, /Host[^。\n]*SNI[^。\n]*路由探针/i);

  assert.match(deployment, /flock --version/);
  assert.match(deployment, /SCRATCH_LOCK/);
  assert.match(deployment, /flock -n 8/);
  assert.match(deployment, /flock -n "\$SCRATCH_LOCK" -c true/);
  assert.match(deployment, /st_uid != 0/);
  assert.match(deployment, /mode & 0o022/);
  assert.match(deployment, /冻结[^。\n]*宝塔[^。\n]*(?:保存|重载|配置)/);

  assert.match(deployment, /BACKUP_ROOT=\$\{BACKUP_ROOT:-\/root\//);
  assert.match(deployment, /install -d -m 0700/);
  assert.match(deployment, /sha256sum[^\n]*BACKUP/);
  assert.match(deployment, /已有配置中断恢复/);
  assert.match(deployment, /首次安装中断恢复/);
  assert.match(deployment, /sha256sum -c/);
  assert.match(deployment, /rm -f -- "\$NGINX_CONFIG"/);

  assert.doesNotMatch(bootstrap, /BACKUP_ROOT|restorecon|WORKERS_BEFORE|SCRATCH_LOCK/);
});

test('BaoTa host-gate command blocks are independently fail-fast and domain-first', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const task14 = markdownSection(
    deployment,
    '### Task 14 主机身份、备份与执行窗口门禁',
    '### Task 16 activation 后内容与身份验收',
  );
  const blocks = bashBlocks(task14);

  assert.equal(
    blocks.length,
    3,
    'Task 14 should remain one executable gate plus two recovery blocks',
  );
  assert.ok(
    task14.split('\n').length < 430,
    'Task 14 host gates should remain compact enough to review and copy',
  );
  assert.equal(
    task14.match(/# BEGIN VALIDATED_WORKER_GATE/g)?.length,
    1,
    'worker validation helpers must not be duplicated across command blocks',
  );
  for (const [index, block] of blocks.entries()) {
    assert.ok(
      block.trimStart().startsWith('set -Eeuo pipefail'),
      `Task 14 bash block ${index + 1} must enable fail-fast semantics first`,
    );
    const requiredDomain = block.indexOf(
      ': "${SELECTED_DOMAIN:?user-approved domain is required}"',
    );
    const validatedDomain = block.indexOf('case "$SELECTED_DOMAIN" in');
    const firstPathUse = block.search(
      /(?:NGINX_BIN|NGINX_CONFIG|NGINX_PID_FILE|NGINX_ERROR_LOG|BACKUP_ROOT|BACKUP_CONFIG|FIRST_INSTALL_MARKER|TLS_CERTIFICATE|HTTP_HEADERS|TLS_HEADERS|\/dev\/null|https?:|\/www\/)/,
    );
    assert.ok(requiredDomain >= 0, `Task 14 bash block ${index + 1} requires a domain`);
    assert.ok(
      validatedDomain > requiredDomain,
      `Task 14 bash block ${index + 1} validates the required domain`,
    );
    assert.ok(
      firstPathUse > validatedDomain,
      `Task 14 bash block ${index + 1} validates the domain before path use`,
    );
  }
});

test('BaoTa preflight branches on config existence and preserves a unique metadata-complete backup', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const task14 = markdownSection(
    deployment,
    '### Task 14 主机身份、备份与执行窗口门禁',
    '### Task 16 activation 后内容与身份验收',
  );

  assert.match(
    task14,
    /if test -e "\$NGINX_CONFIG"; then[\s\S]*?# configuration file \$NGINX_CONFIG:[\s\S]*?else[\s\S]*?include \/www\/server\/panel\/vhost\/nginx\/\*\.conf;/,
  );
  assert.match(task14, /BACKUP_DIR=\$\(mktemp -d "\$BACKUP_ROOT\/\$SELECTED_DOMAIN\.XXXXXX"\)/);
  assert.match(task14, /cp -a -- "\$NGINX_CONFIG" "\$BACKUP_CONFIG"/);
  assert.doesNotMatch(task14, /BACKUP_STAMP|date -u \+%Y%m%dT%H%M%SZ/);
  assertTextOrder(task14, [
    'RESTORECON_PREVIEW=$(restorecon -n -v "$NGINX_CONFIG"',
    'test -z "$RESTORECON_PREVIEW"',
    'BACKUP_DIR=$(mktemp -d "$BACKUP_ROOT/$SELECTED_DOMAIN.XXXXXX")',
    'cp -a -- "$NGINX_CONFIG" "$BACKUP_CONFIG"',
  ]);
  assert.match(task14, /cmp -s -- "\$BACKUP_CONFIG" "\$NGINX_CONFIG"/);
  assert.match(task14, /security\.selinux/);
  assert.match(task14, /st_mtime_ns/);
  assert.doesNotMatch(
    task14,
    /chmod 0600 "\$BACKUP_DIR"\/\*/,
    'the root-only directory must protect the backup without rewriting preserved metadata',
  );
});

test('documented recovery stops before target modification on checksum or flock failure', async (t) => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const existingRecovery = firstBashBlock(
    markdownSection(deployment, '#### 已有配置中断恢复', '#### 首次安装中断恢复'),
  );

  const runRecovery = (
    subtest: TestContext,
    options: { corruptChecksum?: boolean; flockStatus?: string },
  ): { config: string; result: ReturnType<typeof spawnSync> } => {
    const sandbox = mkdtempSync(join(tmpdir(), 'documented-nginx-recovery-'));
    subtest.after(() => rmSync(sandbox, { recursive: true, force: true }));
    const fakeBin = join(sandbox, 'bin');
    const config = join(sandbox, 'nginx', 'ddl.example.com.conf');
    const backup = join(sandbox, 'backup', 'site.conf');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(dirname(config), { recursive: true });
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(config, 'active config must survive\n', 'utf8');
    writeFileSync(backup, 'verified prior config\n', 'utf8');
    const backupHash = options.corruptChecksum
      ? '0'.repeat(64)
      : createHash('sha256').update(readFileSync(backup)).digest('hex');
    writeFileSync(`${backup}.sha256`, `${backupHash}  ${backup}\n`, 'utf8');

    writeExecutable(
      join(fakeBin, 'sha256sum'),
      '#!/bin/sh\n' +
        'if [ -x /usr/bin/sha256sum ]; then exec /usr/bin/sha256sum "$@"; fi\n' +
        'if [ "$1" = "-c" ]; then shift; exec shasum -a 256 -c "$@"; fi\n' +
        'exec shasum -a 256 "$@"\n',
    );
    writeExecutable(
      join(fakeBin, 'flock'),
      '#!/bin/sh\nexit "${DOCUMENTED_FLOCK_STATUS:-0}"\n',
    );
    writeExecutable(
      join(fakeBin, 'install'),
      '#!/bin/sh\n' +
        'while [ "$#" -gt 2 ]; do\n' +
        '  case "$1" in -m|-o|-g) shift 2 ;; *) shift ;; esac\n' +
        'done\n' +
        'cp -- "$1" "$2"\n',
    );
    const nginx = join(fakeBin, 'selected-nginx');
    writeExecutable(nginx, '#!/bin/sh\nexit 0\n');

    const result = spawnSync('bash', ['-c', existingRecovery], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKUP_CONFIG: backup,
        BACKUP_CONFIG_SHA256: `${backup}.sha256`,
        DOCUMENTED_FLOCK_STATUS: options.flockStatus ?? '0',
        NGINX_BIN: nginx,
        NGINX_CONFIG: config,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        SELECTED_DOMAIN: 'ddl.example.com',
      },
    });
    return { config, result };
  };

  await t.test('checksum failure', (subtest) => {
    const { config, result } = runRecovery(subtest, { corruptChecksum: true });
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(config, 'utf8'), 'active config must survive\n');
  });

  await t.test('flock failure', (subtest) => {
    const { config, result } = runRecovery(subtest, { flockStatus: '1' });
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(config, 'utf8'), 'active config must survive\n');
  });
});

test('BaoTa worker gate rejects PID-set false positives and times out without a stable worker', async (t) => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const task14 = markdownSection(
    deployment,
    '### Task 14 主机身份、备份与执行窗口门禁',
    '### Task 16 activation 后内容与身份验收',
  );
  const startMarker = '# BEGIN VALIDATED_WORKER_GATE';
  const endMarker = '# END VALIDATED_WORKER_GATE';
  const start = task14.indexOf(startMarker);
  const end = task14.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, 'documented worker functions must be extractable');
  const workerFunctions = task14.slice(start + startMarker.length, end);

  assert.doesNotMatch(workerFunctions, /comm -13|sort -n/);
  assert.match(workerFunctions, /PPid:/);
  assert.match(workerFunctions, /nginx: worker process/);
  assert.match(workerFunctions, /\/exe/);
  assert.match(workerFunctions, /previous_new_workers/);

  const sandbox = mkdtempSync(join(tmpdir(), 'documented-worker-gate-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const procRoot = join(sandbox, 'proc');
  const nginx = join(sandbox, 'selected-nginx');
  const otherBinary = join(sandbox, 'other-nginx');
  mkdirSync(procRoot, { recursive: true });
  writeExecutable(nginx, '#!/bin/sh\nexit 0\n');
  writeExecutable(otherBinary, '#!/bin/sh\nexit 0\n');

  const addProcess = (
    pid: number,
    parentPid: number,
    command: string,
    executable: string,
  ): void => {
    const processRoot = join(procRoot, String(pid));
    mkdirSync(processRoot, { recursive: true });
    writeFileSync(join(processRoot, 'status'), `Name:\tnginx\nPPid:\t${parentPid}\n`, 'utf8');
    writeFileSync(join(processRoot, 'cmdline'), Buffer.from(`${command}\0`, 'utf8'));
    symlinkSync(executable, join(processRoot, 'exe'));
  };

  addProcess(101, 910, 'nginx: worker process', nginx);
  addProcess(201, 911, 'nginx: worker process', nginx);
  addProcess(202, 910, 'nginx: cache manager process', nginx);
  addProcess(203, 910, 'nginx: worker process', otherBinary);
  addProcess(204, 910, 'nginx: worker process', nginx);

  const workerEnv = {
    ...process.env,
    MASTER_PID: '910',
    NGINX_REAL: realpathSync(nginx),
    PROC_ROOT: procRoot,
    WORKER_POLL_ATTEMPTS: '2',
    WORKER_POLL_INTERVAL_SECONDS: '0',
  };
  const collected = spawnSync(
    'bash',
    ['-c', `set -Eeuo pipefail\n${workerFunctions}\ncollect_valid_workers`],
    { encoding: 'utf8', env: workerEnv },
  );
  assert.equal(collected.status, 0, collected.stderr || collected.stdout);
  assert.deepEqual(collected.stdout.trim().split(/\s+/), ['101', '204']);

  const stable = spawnSync(
    'bash',
    ['-c', `set -Eeuo pipefail\n${workerFunctions}\nwait_for_new_worker '101'`],
    { encoding: 'utf8', env: workerEnv },
  );
  assert.equal(stable.status, 0, stable.stderr || stable.stdout);
  assert.equal(stable.stdout.trim(), '204');

  rmSync(join(procRoot, '204'), { recursive: true, force: true });
  const timedOut = spawnSync(
    'bash',
    ['-c', `set -Eeuo pipefail\n${workerFunctions}\nwait_for_new_worker '101'`],
    { encoding: 'utf8', env: workerEnv },
  );
  assert.notEqual(timedOut.status, 0);
  assert.match(timedOut.stderr, /stable new nginx worker/i);
});

test('BaoTa error-log gate is bound to the selected master and fails closed on rotation', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const task14 = markdownSection(
    deployment,
    '### Task 14 主机身份、备份与执行窗口门禁',
    '### Task 16 activation 后内容与身份验收',
  );

  assert.doesNotMatch(task14, /\/www\/server\/nginx\/logs\/error\.log/);
  assert.match(task14, /\/www\/wwwlogs\/nginx_error\.log/);
  assert.match(task14, /--conf-path=/);
  assert.match(task14, /NGINX_MAIN_CONFIG/);
  assert.match(task14, /# configuration file .*NGINX_MAIN_CONFIG/);
  assert.match(task14, /GLOBAL_ERROR_LOG/);
  assert.match(task14, /depth/);
  assert.match(task14, /"\$PROC_ROOT\/\$MASTER_PID\/fd\/2"/);
  assert.match(task14, /"\$PROC_ROOT\/\$MASTER_PID\/fd\/11"/);
  assert.match(task14, /ERROR_LOG_DEV_INODE/);
  assert.match(task14, /ERROR_LOG_OFFSET/);
  assert.match(task14, /ERROR_LOG_DEV_INODE_AFTER/);
  assert.match(task14, /test "\$ERROR_LOG_DEV_INODE_AFTER" = "\$ERROR_LOG_DEV_INODE"/);
  assert.match(task14, /ERROR_OBSERVE_SECONDS/);
  assert.match(task14, /emerg\|alert\|crit/);
});

test('Task 14 routing gates do not depend on Task 16 activation content', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const task14 = markdownSection(
    deployment,
    '### Task 14 主机身份、备份与执行窗口门禁',
    '### Task 16 activation 后内容与身份验收',
  );
  const task16 = markdownSection(
    deployment,
    '### Task 16 activation 后内容与身份验收',
    '## SSH 主机密钥外部核验',
  );
  const plan = readFileSync(productionLaunchPlanPath, 'utf8');
  const plannedTask14 = markdownSection(plan, '### Task 14:', '### Task 15:');
  const plannedTask16 = markdownSection(plan, '### Task 16:', '### Task 17:');

  assert.match(task14, /预期 404/);
  assert.match(task14, /Host[^。\n]*SNI[^。\n]*(?:vhost|虚拟主机)/i);
  assert.doesNotMatch(task14, /test -f \/srv\/cs-baoyan-ddl\/current\/release\.json/);
  assert.doesNotMatch(plannedTask14, /DDL content|SPA deep link|release\.json|asset/i);

  for (const token of ['release.json', 'SPA', 'asset', 'release identity']) {
    assert.ok(task16.includes(token), `Task 16 operations must include ${token}`);
    assert.ok(plannedTask16.includes(token), `Task 16 plan must include ${token}`);
  }
  assert.match(task16, /activate-release\.sh|activation/i);
  assert.match(plannedTask16, /activate-release\.sh|activation/i);
});

test('activation and rollback durably sync release, transaction, link, and state mutations', () => {
  const activation = readFileSync(activateScript, 'utf8');
  const rollback = readFileSync(rollbackScript, 'utf8');

  for (const source of [activation, rollback]) {
    assert.match(source, /fsync_regular_file\(\)/);
    assert.match(source, /fsync_directory\(\)/);
    assert.match(source, /os\.fsync\(descriptor\)/);
    assert.doesNotMatch(source, /except OSError[\s\S]{0,200}os\.fsync/);

    const linkStart = source.indexOf('atomic_link()');
    const linkEnd = source.indexOf('\n}\n', linkStart) + 3;
    assert.ok(linkStart >= 0 && linkEnd > linkStart);
    assertTextOrder(source.slice(linkStart, linkEnd), [
      'ln -s -- "$target" "$temporary"',
      'fsync_directory "$DEPLOY_ROOT"',
      'atomic_replace "$temporary" "$current_link"',
      'fsync_directory "$DEPLOY_ROOT"',
    ]);

    const stateStart = source.indexOf('write_transaction_state()');
    const stateEnd = source.indexOf('\n}\n', stateStart) + 3;
    assert.ok(stateStart >= 0 && stateEnd > stateStart);
    assertTextOrder(source.slice(stateStart, stateEnd), [
      'printf \'%s\\n\' "$value" > "$temporary"',
      'fsync_regular_file "$temporary"',
      'fsync_directory "$transaction"',
      'atomic_replace "$temporary" "$transaction/state"',
      'fsync_directory "$transaction"',
    ]);
    assert.match(source, /remove_current_link\(\)/);
  }

  assert.match(activation, /fsync_tree\(\)/);
  assertTextOrder(activation, [
    'printf \'%s\\n\' "$ARCHIVE_SHA" > "$extract_dir/.archive-sha256"',
    'chmod -R a-w "$extract_dir"',
    'fsync_tree "$extract_dir"',
    'mv -- "$extract_dir" "$release"',
    'fsync_directory "$releases_dir"',
    'fsync_directory "$staging_dir"',
  ]);
  assertTextOrder(activation, [
    'chmod 0600 "$transaction_temp/state"',
    'fsync_regular_file "$transaction_temp/release"',
    'fsync_regular_file "$transaction_temp/previous"',
    'fsync_regular_file "$transaction_temp/archive-sha256"',
    'fsync_regular_file "$transaction_temp/state"',
    'fsync_directory "$transaction_temp"',
    'mv -- "$transaction_temp" "$transaction"',
    'fsync_directory "$transactions_dir"',
  ]);
});

test('operations docs state recovery, account, approval, and TLS trust boundaries conservatively', () => {
  const deployment = readFileSync(deployDocumentationPath, 'utf8');
  const rollback = readFileSync(rollbackDocumentationPath, 'utf8');
  const combined = `${deployment}\n${rollback}`;

  assert.doesNotMatch(combined, /发生任意失败.*workflow.*调用/);
  assert.doesNotMatch(combined, /即使远端已经切换.*workflow 也会/);
  assert.match(combined, /runner[^。\n]*仍可执行[^。\n]*自动补偿/);
  assert.match(combined, /runner[^。\n]*(?:丢失|不可用)[^。\n]*(?:rollback|reconcile|对账)/);
  assert.match(combined, /主机断电[^。\n]*(?:rollback|reconcile|对账)/);
  assert.match(combined, /只读[^。\n]*防误改/);
  assert.match(combined, /不抵御[^。\n]*deploy 用户/);
  assert.match(combined, /专用账号[^。\n]*通用命令能力/);
  assert.match(combined, /production approval[^。\n]*信任边界/);
  assert.match(combined, /TLS[^。\n]*生产[^。\n]*(?:stop gate|停止门)/i);
  assert.match(combined, /Linux\/CI[^。\n]*真实[^。\n]*flock/);
  assert.match(combined, /macOS[^。\n]*跳过/);
  assert.match(combined, /fsync[^。\n]*(?:不能|不替代)[^。\n]*(?:rollback|reconcile|对账)/i);
});
