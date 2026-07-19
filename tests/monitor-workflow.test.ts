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

function fakeResponse(
  status: number,
  contentType: string,
  body: string | string[],
  contentLength?: string,
) {
  const chunks = (Array.isArray(body) ? body : [body]).map((chunk) => Buffer.from(chunk));
  const state = { chunksRead: 0, destroyed: false };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusCode: status,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-type') return contentType;
        if (name.toLowerCase() === 'content-length') return contentLength ?? null;
        return null;
      },
    },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          if (state.destroyed) return;
          state.chunksRead += 1;
          yield chunk;
        }
      },
    },
    destroy() {
      state.destroyed = true;
    },
    async text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    state,
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
const nowMs = Math.ceil(approvedAtMs / 1_000) * 1_000 + 1_000;
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
  assert.match(workflow, /MAX_SNAPSHOT_AGE_HOURS:\s*['"]24['"]/);
  assert.doesNotMatch(workflow, /vars\.MAX_SNAPSHOT_AGE_HOURS/);
  const jobEnv = workflow.match(/\n    env:\n([\s\S]*?)\n    steps:/)?.[1] ?? '';
  assert.notEqual(jobEnv, '', 'monitor job must define its non-secret environment');
  assert.doesNotMatch(
    jobEnv,
    /\$\{\{\s*runner\./,
    'runner context is unavailable in jobs.<job_id>.env',
  );
  assert.match(workflow, /MONITOR_DIAGNOSTICS_DIR=.*\$RUNNER_TEMP\/public-monitor-diagnostics/);
  assert.match(workflow, /MONITOR_DIAGNOSTICS_DIR=.*>>\s*"\$GITHUB_ENV"/);
  assert.match(workflow, /MONITOR_DIAGNOSTICS_PATH=.*>>\s*"\$GITHUB_ENV"/);
  assert.match(workflow, /if:\s*\$\{\{\s*failure\(\)\s*\}\}[\s\S]*upload-artifact/);
  assert.match(workflow, /if:\s*\$\{\{\s*always\(\)\s*\}\}[\s\S]*GITHUB_STEP_SUMMARY/);
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
  assert.match(monitor, /\/data\/current\.json/);
  assert.match(monitor, /\/data\/release\.json/);
  assert.doesNotMatch(monitor, /readRegularJsonFile|approvedPath|globalThis\.fetch|dependencies\.fetch/);
  assert.doesNotMatch(monitor, /createHash|createHmac|sha256/i);
});

test('operations guide documents repository variables and the no-secrets boundary', () => {
  const operations = source(operationsPath);
  assert.notEqual(operations, '', 'docs/operations/public-monitoring.md must exist');
  assert.match(operations, /repository[- ]level[^\n]*PUBLIC_BASE_URL/i);
  assert.match(operations, /production environment[^\n]*(?:不会|不被|does not|is not)[^\n]*(?:读取|read)/i);
  assert.match(operations, /no secrets|不(?:使用|读取|引用)[^\n]*secret/i);
  assert.match(operations, /不(?:声明|使用)[^\n]*environment|no environment/i);
  assert.match(operations, /IPv4-compatible|NAT64|6to4|Teredo/i);
  assert.match(operations, /30\s*秒[^\n]*(?:总|整体)[^\n]*(?:deadline|时限)/i);
  assert.match(operations, /(?:提前|早退|失败)[^\n]*(?:销毁|destroy)[^\n]*响应/i);
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
  let requestCalls = 0;
  const rejectAddresses = async (addresses: Array<{ address: string; family: number }>) => {
    await assert.rejects(
      monitorPublicRelease(
        {
          publicBaseUrl: 'https://admissions.example',
          expectedSha,
          maxSnapshotAgeHours: '24',
          nowMs,
        },
        {
          resolveHost: async () => addresses,
          requestHttps: async () => {
            requestCalls += 1;
            throw new Error('HTTPS must not run');
          },
          readCertificate: async () => {
            throw new Error('TLS must not run');
          },
        },
      ),
      /private|loopback|public address/i,
    );
  };

  await rejectAddresses([{ address: '10.20.30.40', family: 4 }]);
  await rejectAddresses([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  assert.equal(requestCalls, 0);
});

test('accepts native global-unicast IPv6 and rejects special-purpose IPv6 ranges', async (t) => {
  const assertPublicAddresses = exported('assertPublicAddresses');
  assert.doesNotThrow(() => assertPublicAddresses([
    { address: '2606:4700:4700::1111', family: 6 },
  ]));

  for (const address of [
    '::192.0.2.1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '64:ff9b:1::808:808',
    '100::1',
    '2001::1',
    '2001:2::1',
    '2001:db8::1',
    '2002:808:808::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
  ]) {
    await t.test(address, () => {
      assert.throws(
        () => assertPublicAddresses([{ address, family: 6 }]),
        /non-public|global-unicast|public address/i,
      );
    });
  }
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
    /duplicate.*key/i,
  );
  for (const escapedDuplicate of [
    `{"\\u0072eleaseSha":"${'b'.repeat(40)}","releaseSha":"${expectedSha}",`
      + `"snapshotId":"${releaseIdentity.snapshotId}","dataHash":"${releaseIdentity.dataHash}"}`,
    `{"rele\\u0061seSha":"${'b'.repeat(40)}","releaseSha":"${expectedSha}",`
      + `"snapshotId":"${releaseIdentity.snapshotId}","dataHash":"${releaseIdentity.dataHash}"}`,
  ]) {
    assert.throws(() => parseRelease(escapedDuplicate), /duplicate.*key/i);
  }
  const parseStrictJson = exported('parseStrictJson');
  assert.throws(
    () => parseStrictJson('{"private-token-key":1,"private-token-\\u006bey":2}', 'JSON response'),
    (error: Error) => {
      assert.match(error.message, /duplicate.*key/i);
      assert.doesNotMatch(error.message, /private-token-key/i);
      return true;
    },
  );

  const mismatches: Array<[string, Record<string, unknown>, RegExp]> = [
    ['release SHA', { ...releaseIdentity, releaseSha: 'b'.repeat(40) }, /releaseSha.*expected/i],
    [
      'snapshot ID',
      { ...releaseIdentity, snapshotId: `2026-07-17T00:00:00.000Z-${'b'.repeat(12)}` },
      /snapshotId.*current snapshot/i,
    ],
    ['data hash', { ...releaseIdentity, dataHash: 'b'.repeat(64) }, /dataHash.*current snapshot/i],
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

test('bound TLS adapter connects to the verified IP while preserving SNI and hostname checks', async () => {
  const readBoundCertificate = exported('readBoundCertificate');
  let capturedOptions: Record<string, any> | undefined;
  const certificate = {
    subject: { CN: 'admissions.example' },
    subjectaltname: 'DNS:admissions.example',
    valid_to: new Date(nowMs + 30 * dayMs).toUTCString(),
  };
  const connectImpl = (options: Record<string, any>, onSecure: () => void) => {
    capturedOptions = options;
    const socket = {
      getPeerCertificate() {
        return certificate;
      },
      setTimeout() {},
      on() {},
      end() {},
    };
    queueMicrotask(onSecure);
    return socket;
  };

  assert.deepEqual(
    await readBoundCertificate(
      'admissions.example',
      443,
      { address: '8.8.8.8', family: 4 },
      connectImpl,
    ),
    certificate,
  );
  assert.ok(capturedOptions);
  assert.equal(capturedOptions.host, '8.8.8.8');
  assert.equal(capturedOptions.family, 4);
  assert.equal(capturedOptions.port, 443);
  assert.equal(capturedOptions.servername, 'admissions.example');
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(
    capturedOptions.checkServerIdentity('ignored.example', {
      subjectaltname: 'DNS:admissions.example',
    }),
    undefined,
  );
  assert.ok(
    capturedOptions.checkServerIdentity('ignored.example', {
      subjectaltname: 'DNS:other.example',
    }) instanceof Error,
  );
});

test('bound HTTPS adapter connects to the verified IP while preserving Host, SNI, and hostname checks', async () => {
  const requestBoundHttps = exported('requestBoundHttps');
  let capturedOptions: Record<string, any> | undefined;
  const requestImpl = (
    options: Record<string, any>,
    onResponse: (response: Record<string, unknown>) => void,
  ) => {
    capturedOptions = options;
    return {
      setTimeout() {},
      on() {},
      end() {
        onResponse({ statusCode: 200, headers: {}, destroy() {} });
      },
    };
  };

  await requestBoundHttps(
    'https://admissions.example:8443/data/current.json',
    {
      address: { address: '8.8.8.8', family: 4 },
      hostname: 'admissions.example',
      headers: { accept: 'application/json' },
    },
    requestImpl,
  );

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.protocol, 'https:');
  assert.equal(capturedOptions.hostname, '8.8.8.8');
  assert.equal(capturedOptions.family, 4);
  assert.equal(capturedOptions.port, '8443');
  assert.equal(capturedOptions.path, '/data/current.json');
  assert.equal(capturedOptions.headers.host, 'admissions.example:8443');
  assert.equal(capturedOptions.servername, 'admissions.example');
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(Object.hasOwn(capturedOptions, 'lookup'), false);
  assert.equal(
    capturedOptions.checkServerIdentity('ignored.example', {
      subjectaltname: 'DNS:admissions.example',
    }),
    undefined,
  );
  assert.ok(
    capturedOptions.checkServerIdentity('ignored.example', {
      subjectaltname: 'DNS:other.example',
    }) instanceof Error,
  );
});

test('normal monitor path binds public HTTPS checks to one validated address and remote data files', async () => {
  const monitorPublicRelease = exported('monitorPublicRelease');
  const requests: Array<{ url: string; address: unknown; hostname: unknown }> = [];
  const certificateConnections: Array<{ hostname: string; port: number; address: unknown }> = [];
  let resolveCalls = 0;
  const result = await monitorPublicRelease(
    {
      publicBaseUrl: 'https://admissions.example',
      expectedSha,
      maxSnapshotAgeHours: '24',
      approvedPath: '/must-not-be-read/local-approved.json',
      nowMs,
    },
    {
      resolveHost: async () => {
        resolveCalls += 1;
        return [
          { address: '8.8.8.8', family: 4 },
          { address: '1.1.1.1', family: 4 },
        ];
      },
      fetch: async () => {
        throw new Error('built-in fetch must not be used');
      },
      requestHttps: async (url: string, options: Record<string, unknown>) => {
        requests.push({ url, address: options.address, hostname: options.hostname });
        if (url.endsWith('/data/current.json')) {
          return fakeResponse(200, 'application/json; charset=utf-8', JSON.stringify(approvedSnapshot));
        }
        if (url.endsWith('/data/release.json')) {
          return fakeResponse(200, 'application/json; charset=utf-8', JSON.stringify(releaseIdentity));
        }
        return fakeResponse(200, 'text/html; charset=utf-8', '<!doctype html><html><body>ok</body></html>');
      },
      readCertificate: async (hostname: string, port: number, address: unknown) => {
        certificateConnections.push({ hostname, port, address });
        return {
          subject: { CN: 'admissions.example' },
          subjectaltname: 'DNS:admissions.example',
          valid_to: new Date(nowMs + 30 * dayMs).toUTCString(),
        };
      },
    },
  );

  const selectedAddress = { address: '8.8.8.8', family: 4 };
  assert.deepEqual(requests, [
    { url: 'https://admissions.example/', address: selectedAddress, hostname: 'admissions.example' },
    {
      url: 'https://admissions.example/data/current.json',
      address: selectedAddress,
      hostname: 'admissions.example',
    },
    {
      url: 'https://admissions.example/data/release.json',
      address: selectedAddress,
      hostname: 'admissions.example',
    },
  ]);
  assert.deepEqual(certificateConnections, [
    { hostname: 'admissions.example', port: 443, address: selectedAddress },
  ]);
  assert.equal(resolveCalls, 1);
  assert.deepEqual(result.release, releaseIdentity);
  assert.equal(result.origin, 'https://admissions.example');
  assert.equal(result.certificateDaysRemaining, 30);
});

test('remote current integrity, freshness, schema, and release identity fail closed', async (t) => {
  const monitorPublicRelease = exported('monitorPublicRelease');
  const runMonitor = async ({
    currentText = JSON.stringify(approvedSnapshot),
    currentStatus = 200,
    release = releaseIdentity,
    checkedAt = nowMs,
    maxAgeHours = '24',
  }: {
    currentText?: string;
    currentStatus?: number;
    release?: Record<string, unknown>;
    checkedAt?: number;
    maxAgeHours?: string;
  }) => monitorPublicRelease(
    {
      publicBaseUrl: 'https://admissions.example',
      expectedSha,
      maxSnapshotAgeHours: maxAgeHours,
      nowMs: checkedAt,
    },
    {
      resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
      readCertificate: async () => ({
        subject: { CN: 'admissions.example' },
        subjectaltname: 'DNS:admissions.example',
        valid_to: new Date(checkedAt + 30 * dayMs).toUTCString(),
      }),
      requestHttps: async (url: string) => {
        if (url.endsWith('/data/current.json')) {
          return fakeResponse(currentStatus, 'application/json', currentText);
        }
        if (url.endsWith('/data/release.json')) {
          return fakeResponse(200, 'application/json', JSON.stringify(release));
        }
        return fakeResponse(200, 'text/html', '<html><body>ok</body></html>');
      },
    },
  );

  await t.test('missing remote current', async () => {
    await assert.rejects(runMonitor({ currentStatus: 404 }), /current snapshot.*status 404/i);
  });
  await t.test('tampered canonical data hash', async () => {
    await assert.rejects(
      runMonitor({
        currentText: JSON.stringify({ ...approvedSnapshot, dataHash: 'b'.repeat(64) }),
      }),
      /canonical SHA-256 hash/i,
    );
  });
  await t.test('unknown current schema field', async () => {
    await assert.rejects(
      runMonitor({
        currentText: JSON.stringify({ ...approvedSnapshot, notInTheSchema: true }),
      }),
      /unknown property/i,
    );
  });
  await t.test('Unicode escaped duplicate current key', async () => {
    await assert.rejects(
      runMonitor({
        currentText: JSON.stringify(approvedSnapshot).replace(
          /^\{/,
          '{"\\u0073chemaVersion":999,',
        ),
      }),
      /duplicate.*key/i,
    );
  });
  await t.test('stale remote current', async () => {
    await assert.rejects(
      runMonitor({ maxAgeHours: '0.0001' }),
      /freshness.*older/i,
    );
  });
  await t.test('deadline passage does not invalidate an otherwise fresh approved snapshot', async () => {
    const opportunities = approvedSnapshot.opportunities as Array<Record<string, unknown>>;
    const firstDeadlineMs = Math.min(
      ...opportunities
        .filter((row) => row.verificationStatus === 'confirmed-open')
        .map((row) => Number(row.deadlineEpochMs)),
    );
    const scanAtMs = Date.parse(String(approvedSnapshot.scanAt));
    const freshnessHours = String(Math.ceil((firstDeadlineMs - scanAtMs) / (60 * 60 * 1_000)) + 1);

    await assert.doesNotReject(
      runMonitor({ checkedAt: firstDeadlineMs, maxAgeHours: freshnessHours }),
    );
  });

  for (const [name, release, pattern] of [
    ['expected SHA', { ...releaseIdentity, releaseSha: 'b'.repeat(40) }, /releaseSha.*expected/i],
    [
      'current snapshot ID',
      { ...releaseIdentity, snapshotId: `2026-07-17T00:00:00.000Z-${'b'.repeat(12)}` },
      /snapshotId.*current snapshot/i,
    ],
    ['current data hash', { ...releaseIdentity, dataHash: 'b'.repeat(64) }, /dataHash.*current snapshot/i],
  ] as const) {
    await t.test(`release mismatch: ${name}`, async () => {
      await assert.rejects(runMonitor({ release }), pattern);
    });
  }
});

test('homepage and data response streams fail closed without recording response bodies', async (t) => {
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
    nowMs,
  };

  const responseFor = (
    url: string,
    overrides: Partial<Record<'homepage' | 'current' | 'release', ReturnType<typeof fakeResponse>>> = {},
  ) => {
    if (url.endsWith('/data/current.json')) {
      return overrides.current
        ?? fakeResponse(200, 'application/json', JSON.stringify(approvedSnapshot));
    }
    if (url.endsWith('/data/release.json')) {
      return overrides.release
        ?? fakeResponse(200, 'application/json', JSON.stringify(releaseIdentity));
    }
    return overrides.homepage
      ?? fakeResponse(200, 'text/html', '<html><body>ok</body></html>');
  };

  await t.test('non-HTML homepage', async () => {
    const homepage = fakeResponse(200, 'text/plain', 'private-token-must-not-appear');
    await assert.rejects(
      monitorPublicRelease(config, {
        ...baseDependencies,
        requestHttps: async (url: string) => responseFor(url, { homepage }),
      }),
      (error: Error) => {
        assert.match(error.message, /homepage.*HTML/i);
        assert.doesNotMatch(error.message, /private-token-must-not-appear/);
        return true;
      },
    );
    assert.equal(homepage.state.destroyed, true);
  });

  await t.test('total response deadline destroys a hanging response', async () => {
    let releaseWait: (() => void) | undefined;
    const state = { destroyed: false };
    const hangingRelease = {
      ok: true,
      status: 200,
      headers: {
        get(name: string) {
          if (name.toLowerCase() === 'content-type') return 'application/json';
          return null;
        },
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{');
          await new Promise<void>((resolveWait) => {
            releaseWait = resolveWait;
          });
        },
      },
      destroy() {
        state.destroyed = true;
        releaseWait?.();
      },
    };
    await assert.rejects(
      Promise.race([
        monitorPublicRelease(
          { ...config, responseDeadlineMs: 25 },
          {
            ...baseDependencies,
            requestHttps: async (url: string) => responseFor(url, { release: hangingRelease as any }),
          },
        ),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('test guard expired')),
          500,
        )),
      ]),
      /deadline/i,
    );
    assert.equal(state.destroyed, true);
  });

  await t.test('chunked oversized release stops at the first over-limit chunk', async () => {
    const oversized = fakeResponse(
      200,
      'application/json',
      ['x'.repeat(9_000), 'y'.repeat(9_000), 'private-token-must-not-be-read'],
    );
    await assert.rejects(
      monitorPublicRelease(config, {
        ...baseDependencies,
        requestHttps: async (url: string) => responseFor(url, { release: oversized }),
      }),
      /release response.*large/i,
    );
    assert.equal(oversized.state.chunksRead, 2);
    assert.equal(oversized.state.destroyed, true);
  });

  await t.test('declared oversized release is destroyed before reading', async () => {
    const oversized = fakeResponse(200, 'application/json', '{}', '20000');
    await assert.rejects(
      monitorPublicRelease(config, {
        ...baseDependencies,
        requestHttps: async (url: string) => responseFor(url, { release: oversized }),
      }),
      /release response.*large/i,
    );
    assert.equal(oversized.state.chunksRead, 0);
    assert.equal(oversized.state.destroyed, true);
  });
});
