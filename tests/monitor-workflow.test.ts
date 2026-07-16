import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repositoryRoot, '.github/workflows/monitor.yml');
const monitorPath = resolve(repositoryRoot, 'scripts/monitor-public.mjs');
const operationsPath = resolve(repositoryRoot, 'docs/operations/public-monitoring.md');
const approvedPath = resolve(repositoryRoot, 'data/approved/current.json');

const monitorModule = existsSync(monitorPath)
  ? await import(pathToFileURL(monitorPath).href)
  : {};

type UnknownFunction = (...args: any[]) => any;

function exported(name: string): UnknownFunction {
  const value = (monitorModule as Record<string, unknown>)[name];
  assert.equal(typeof value, 'function', `monitor must export ${name}`);
  return value as UnknownFunction;
}

function source(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function fakeResponse(status: number, contentType: string, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async text() {
      return body;
    },
  };
}

const expectedSha = 'a'.repeat(40);
const approvedSnapshot = JSON.parse(readFileSync(approvedPath, 'utf8')) as Record<string, unknown>;
const releaseIdentity = {
  releaseSha: expectedSha,
  snapshotId: approvedSnapshot.snapshotId,
  dataHash: approvedSnapshot.dataHash,
};
const approvedAtMs = Date.parse(String(approvedSnapshot.approvedAt));
const nowMs = approvedAtMs + 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

test('monitor workflow is scheduled, manually runnable, read-only, and isolated from production credentials', () => {
  const workflow = source(workflowPath);
  assert.notEqual(workflow, '', '.github/workflows/monitor.yml must exist');
  assert.match(workflow, /schedule:\s*\n\s*- cron:\s*['"]\d{1,2} \*\/6 \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /^\s*environment:/m);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /TENCENT|SSH_|DEPLOY_HOST|DEPLOY_USER/i);

  assert.match(workflow, /node-version:\s*20/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(
    workflow,
    /PUBLIC_BASE_URL:\s*\$\{\{\s*vars\.PUBLIC_BASE_URL\s*\}\}/,
  );
  assert.match(
    workflow,
    /MAX_SNAPSHOT_AGE_HOURS:\s*\$\{\{\s*vars\.MAX_SNAPSHOT_AGE_HOURS\s*\|\|\s*['"]24['"]\s*\}\}/,
  );
  assert.match(workflow, /if:\s*\$\{\{\s*failure\(\)\s*\}\}[\s\S]*upload-artifact/);
  assert.match(workflow, /if:\s*\$\{\{\s*always\(\)\s*\}\}[\s\S]*GITHUB_STEP_SUMMARY/);
  assert.match(
    workflow,
    /MONITOR_DIAGNOSTICS_PATH:\s*\$\{\{\s*runner\.temp\s*\}\}\/public-monitor-diagnostics\/public-monitor\.json/,
  );
  assert.match(
    workflow,
    /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/public-monitor-diagnostics\//,
  );
});

test('monitor implementation reuses repository snapshot integrity and freshness logic', () => {
  const monitor = source(monitorPath);
  assert.notEqual(monitor, '', 'scripts/monitor-public.mjs must exist');
  assert.match(monitor, /src\/lib\/snapshot-integrity\.js/);
  assert.match(monitor, /snapshot\/check-freshness\.js/);
  assert.doesNotMatch(monitor, /createHash|createHmac|sha256/i);
});

test('operations guide documents repository variables and the no-secrets boundary', () => {
  const operations = source(operationsPath);
  assert.notEqual(operations, '', 'docs/operations/public-monitoring.md must exist');
  assert.match(operations, /repository[- ]level[^\n]*PUBLIC_BASE_URL/i);
  assert.match(operations, /production environment[^\n]*(?:不会|不被|does not|is not)[^\n]*(?:读取|read)/i);
  assert.match(operations, /no secrets|不(?:使用|读取|引用)[^\n]*secret/i);
  assert.match(operations, /不(?:声明|使用)[^\n]*environment|no environment/i);
});

test('accepts only a credential-free HTTPS origin with no path, query, or fragment', async (t) => {
  const parsePublicOrigin = exported('parsePublicOrigin');
  assert.equal(parsePublicOrigin('https://admissions.example').href, 'https://admissions.example/');
  assert.equal(parsePublicOrigin('https://admissions.example:8443/').port, '8443');

  const malicious = [
    'http://admissions.example',
    'https://user:pass@admissions.example',
    'https://admissions.example/path',
    'https://admissions.example/?query=1',
    'https://admissions.example/#fragment',
    'https://localhost',
    'https://app.localhost',
    'https://127.0.0.1',
    'https://127.1',
    'https://0.0.0.0',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://169.254.1.1',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
  ];
  for (const value of malicious) {
    await t.test(value, () => {
      assert.throws(() => parsePublicOrigin(value), /HTTPS origin|public origin|localhost|private|loopback/i);
    });
  }
});

test('rejects private or loopback DNS answers before HTTP requests', async () => {
  const monitorPublicRelease = exported('monitorPublicRelease');
  let fetchCalls = 0;
  await assert.rejects(
    monitorPublicRelease(
      {
        publicBaseUrl: 'https://admissions.example',
        expectedSha,
        maxSnapshotAgeHours: '24',
        approvedSnapshot,
        nowMs,
      },
      {
        resolveHost: async () => [{ address: '10.20.30.40', family: 4 }],
        fetch: async () => {
          fetchCalls += 1;
          throw new Error('fetch must not run');
        },
        readCertificate: async () => {
          throw new Error('TLS must not run');
        },
      },
    ),
    /private|loopback|public address/i,
  );
  assert.equal(fetchCalls, 0);
});

test('release metadata has exactly the three strict identity fields', async (t) => {
  const parseRelease = exported('parseRelease');
  const assertReleaseIdentity = exported('assertReleaseIdentity');
  assert.deepEqual(parseRelease(JSON.stringify(releaseIdentity)), releaseIdentity);
  assert.doesNotThrow(() => assertReleaseIdentity(releaseIdentity, approvedSnapshot, expectedSha));

  const invalidPayloads: Array<[string, unknown]> = [
    ['extra field', { ...releaseIdentity, deployedAt: '2026-07-17T00:00:00Z' }],
    ['missing field', { releaseSha: expectedSha, snapshotId: releaseIdentity.snapshotId }],
    ['uppercase SHA', { ...releaseIdentity, releaseSha: expectedSha.toUpperCase() }],
    ['short data hash', { ...releaseIdentity, dataHash: 'a'.repeat(63) }],
    ['malformed snapshot ID', { ...releaseIdentity, snapshotId: 'latest' }],
    ['impossible snapshot date', { ...releaseIdentity, snapshotId: `2026-02-30T00:00:00.000Z-${'a'.repeat(12)}` }],
    ['array', [releaseIdentity]],
    ['null', null],
  ];
  for (const [name, payload] of invalidPayloads) {
    await t.test(name, () => {
      assert.throws(() => parseRelease(JSON.stringify(payload)), /release|field|schema|format|object/i);
    });
  }
  assert.throws(
    () => parseRelease(
      `{"releaseSha":"${'b'.repeat(40)}","releaseSha":"${expectedSha}",`
      + `"snapshotId":"${releaseIdentity.snapshotId}","dataHash":"${releaseIdentity.dataHash}"}`,
    ),
    /duplicate.*releaseSha/i,
  );

  const mismatches: Array<[string, Record<string, unknown>, RegExp]> = [
    ['release SHA', { ...releaseIdentity, releaseSha: 'b'.repeat(40) }, /releaseSha.*expected/i],
    ['snapshot ID', { ...releaseIdentity, snapshotId: `2026-07-17T00:00:00.000Z-${'b'.repeat(12)}` }, /snapshotId.*approved/i],
    ['data hash', { ...releaseIdentity, dataHash: 'b'.repeat(64) }, /dataHash.*approved/i],
  ];
  for (const [name, identity, pattern] of mismatches) {
    await t.test(name, () => {
      assert.throws(() => assertReleaseIdentity(identity, approvedSnapshot, expectedSha), pattern);
    });
  }
});

test('snapshot age input and timestamps fail closed at exact boundaries', async (t) => {
  const parseMaxSnapshotAgeHours = exported('parseMaxSnapshotAgeHours');
  const assertSnapshotFreshness = exported('assertSnapshotFreshness');
  assert.equal(parseMaxSnapshotAgeHours(undefined), dayMs);
  assert.equal(parseMaxSnapshotAgeHours('0.5'), dayMs / 48);

  for (const invalid of ['', '0', '-1', ' 24', '24 ', '01', '1e2', 'NaN', 'Infinity']) {
    await t.test(`invalid threshold ${JSON.stringify(invalid)}`, () => {
      assert.throws(() => parseMaxSnapshotAgeHours(invalid), /maximum snapshot age|positive decimal|safe/i);
    });
  }

  const boundaryNow = Date.parse('2026-07-17T12:00:00Z');
  const maxAgeMs = 24 * dayMs;
  const timestamps = (scanAtMs: number, approvedAtMs: number) => ({
    scanAt: new Date(scanAtMs).toISOString(),
    approvedAt: new Date(approvedAtMs).toISOString(),
  });
  assert.doesNotThrow(() => {
    assertSnapshotFreshness(
      timestamps(boundaryNow - maxAgeMs, boundaryNow - maxAgeMs),
      boundaryNow,
      maxAgeMs,
    );
  });
  assert.throws(
    () => assertSnapshotFreshness(
      timestamps(boundaryNow - maxAgeMs - 1, boundaryNow - maxAgeMs),
      boundaryNow,
      maxAgeMs,
    ),
    /scanAt.*older/i,
  );
  assert.throws(
    () => assertSnapshotFreshness(
      timestamps(boundaryNow + 1, boundaryNow + 2),
      boundaryNow,
      maxAgeMs,
    ),
    /future/i,
  );
  assert.throws(
    () => assertSnapshotFreshness(
      timestamps(boundaryNow - 1, boundaryNow - 2),
      boundaryNow,
      maxAgeMs,
    ),
    /approvedAt.*before.*scanAt/i,
  );
});

test('certificate SAN and remaining full-day boundary are strict', () => {
  const assertCertificate = exported('assertCertificate');
  const hostname = 'admissions.example';
  const certificate = (notAfterMs: number, subjectaltname = `DNS:${hostname}`) => ({
    subject: { CN: hostname },
    subjectaltname,
    valid_to: new Date(notAfterMs).toUTCString(),
  });
  assert.doesNotThrow(() => {
    assertCertificate(certificate(nowMs + 21 * dayMs), hostname, nowMs, 21);
  });
  assert.throws(
    () => assertCertificate(certificate(nowMs + 21 * dayMs - 1), hostname, nowMs, 21),
    /21 full days|certificate.*expire/i,
  );
  assert.throws(
    () => assertCertificate(certificate(nowMs + 30 * dayMs, 'DNS:other.example'), hostname, nowMs, 21),
    /SAN|hostname|certificate/i,
  );
});

test('normal monitor path uses injected network fixtures and validates homepage, release, and TLS', async () => {
  const monitorPublicRelease = exported('monitorPublicRelease');
  const requests: Array<{ url: string; redirect: unknown }> = [];
  const result = await monitorPublicRelease(
    {
      publicBaseUrl: 'https://admissions.example',
      expectedSha,
      maxSnapshotAgeHours: '24',
      approvedSnapshot,
      nowMs,
    },
    {
      resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
      fetch: async (url: string, options: Record<string, unknown>) => {
        requests.push({ url, redirect: options.redirect });
        if (url.endsWith('/release.json')) {
          return fakeResponse(200, 'application/json; charset=utf-8', JSON.stringify(releaseIdentity));
        }
        return fakeResponse(200, 'text/html; charset=utf-8', '<!doctype html><html><body>ok</body></html>');
      },
      readCertificate: async () => ({
        subject: { CN: 'admissions.example' },
        subjectaltname: 'DNS:admissions.example',
        valid_to: new Date(nowMs + 30 * dayMs).toUTCString(),
      }),
    },
  );

  assert.deepEqual(requests, [
    { url: 'https://admissions.example/', redirect: 'error' },
    { url: 'https://admissions.example/release.json', redirect: 'error' },
  ]);
  assert.deepEqual(result.release, releaseIdentity);
  assert.equal(result.origin, 'https://admissions.example');
  assert.equal(result.certificateDaysRemaining, 30);
});

test('homepage and release fetches fail closed without recording response bodies', async (t) => {
  const monitorPublicRelease = exported('monitorPublicRelease');
  const baseDependencies = {
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    readCertificate: async () => ({
      subject: { CN: 'admissions.example' },
      subjectaltname: 'DNS:admissions.example',
      valid_to: new Date(nowMs + 30 * dayMs).toUTCString(),
    }),
  };
  const config = {
    publicBaseUrl: 'https://admissions.example',
    expectedSha,
    maxSnapshotAgeHours: '24',
    approvedSnapshot,
    nowMs,
  };

  await t.test('non-HTML homepage', async () => {
    await assert.rejects(
      monitorPublicRelease(config, {
        ...baseDependencies,
        fetch: async (url: string) => url.endsWith('/release.json')
          ? fakeResponse(200, 'application/json', JSON.stringify(releaseIdentity))
          : fakeResponse(200, 'text/plain', 'private-token-must-not-appear'),
      }),
      (error: Error) => {
        assert.match(error.message, /homepage.*HTML/i);
        assert.doesNotMatch(error.message, /private-token-must-not-appear/);
        return true;
      },
    );
  });

  await t.test('oversized release response', async () => {
    await assert.rejects(
      monitorPublicRelease(config, {
        ...baseDependencies,
        fetch: async (url: string) => url.endsWith('/release.json')
          ? fakeResponse(200, 'application/json', 'x'.repeat(20_000))
          : fakeResponse(200, 'text/html', '<html><body>ok</body></html>'),
      }),
      /release response.*large/i,
    );
  });
});
