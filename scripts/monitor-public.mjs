import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import { pathToFileURL } from 'node:url';

import {
  isValidIsoTimestamp,
  readRegularJsonFile,
  validateApprovedSnapshot,
} from '../src/lib/snapshot-integrity.js';
import { checkSnapshotFreshness } from './snapshot/check-freshness.js';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const homepageByteLimit = 1024 * 1024;
const releaseByteLimit = 16 * 1024;
const requestTimeoutMs = 15_000;
const releaseKeys = ['dataHash', 'releaseSha', 'snapshotId'];

class MonitorError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = 'MonitorError';
    this.stage = stage;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function isNonPublicIpv4(address) {
  const octets = parseIpv4(address);
  if (octets === null) return true;
  const [a, b] = octets;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  );
}

function isNonPublicIpv6(address) {
  const normalized = address.toLowerCase().split('%', 1)[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isNonPublicIpv4(normalized.slice('::ffff:'.length));
  }
  const first = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || normalized.startsWith('2001:db8:')
  );
}

function isNonPublicIp(address) {
  const family = isIP(address);
  if (family === 4) return isNonPublicIpv4(address);
  if (family === 6) return isNonPublicIpv6(address);
  return true;
}

export function parsePublicOrigin(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    throw new Error('PUBLIC_BASE_URL must be a non-empty HTTPS origin');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_BASE_URL must be a valid HTTPS origin');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment');
  }
  const hostname = unbracket(url.hostname).toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('PUBLIC_BASE_URL must not use localhost');
  }
  if (isIP(hostname) !== 0 && isNonPublicIp(hostname)) {
    throw new Error('PUBLIC_BASE_URL must not use a private or loopback IP address');
  }
  return url;
}

export function assertPublicAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('hostname must resolve to at least one public address');
  }
  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    if (typeof address !== 'string' || isIP(address) === 0 || isNonPublicIp(address)) {
      throw new Error('hostname resolved to a private, loopback, or otherwise non-public address');
    }
  }
}

export function parseMaxSnapshotAgeHours(value) {
  const text = value === undefined ? '24' : value;
  if (
    typeof text !== 'string'
    || !/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/.test(text)
  ) {
    throw new Error('maximum snapshot age must be a positive decimal number of hours');
  }
  const maxAgeMs = Number(text) * hourMs;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('maximum snapshot age must resolve to positive safe integer milliseconds');
  }
  return maxAgeMs;
}

export function assertSnapshotFreshness(snapshot, nowMs, maxAgeMs) {
  const errors = checkSnapshotFreshness(snapshot, nowMs, maxAgeMs);
  if (errors.length > 0) {
    throw new Error(`snapshot freshness failed: ${errors.join('; ')}`);
  }
}

function assertReleaseSchema(value) {
  if (!isObject(value)) throw new Error('release schema must be a JSON object');
  const keys = Object.keys(value).sort();
  if (keys.length !== releaseKeys.length || keys.some((key, index) => key !== releaseKeys[index])) {
    throw new Error('release schema must contain exactly releaseSha, snapshotId, and dataHash');
  }
  if (!/^[0-9a-f]{40}$/.test(value.releaseSha)) {
    throw new Error('releaseSha has an invalid format');
  }
  const snapshotIdMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-[0-9a-f]{12}$/.exec(
    value.snapshotId,
  );
  if (snapshotIdMatch === null || !isValidIsoTimestamp(snapshotIdMatch[1])) {
    throw new Error('snapshotId has an invalid format');
  }
  if (!/^[0-9a-f]{64}$/.test(value.dataHash)) {
    throw new Error('dataHash has an invalid format');
  }
  return value;
}

export function parseRelease(text) {
  if (typeof text !== 'string') throw new Error('release response must be text');
  for (const key of releaseKeys) {
    const occurrences = text.match(new RegExp(`"${key}"\\s*:`, 'g'))?.length ?? 0;
    if (occurrences > 1) throw new Error(`release response contains duplicate ${key}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('release response is not valid JSON');
  }
  return assertReleaseSchema(value);
}

export function assertReleaseIdentity(release, approvedSnapshot, expectedSha) {
  assertReleaseSchema(release);
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('expected GITHUB_SHA must be exactly 40 lowercase hexadecimal characters');
  }
  if (!isObject(approvedSnapshot)) throw new Error('approved snapshot must be an object');
  if (release.releaseSha !== expectedSha) {
    throw new Error('releaseSha does not match the expected GITHUB_SHA');
  }
  if (release.snapshotId !== approvedSnapshot.snapshotId) {
    throw new Error('snapshotId does not match the approved snapshot');
  }
  if (release.dataHash !== approvedSnapshot.dataHash) {
    throw new Error('dataHash does not match the approved snapshot');
  }
}

export function assertCertificate(certificate, hostname, nowMs, minimumFullDays = 21) {
  if (!isObject(certificate) || typeof certificate.subjectaltname !== 'string') {
    throw new Error('TLS certificate SAN is missing');
  }
  const identityError = checkServerIdentity(hostname, certificate);
  if (identityError !== undefined) {
    throw new Error(`TLS certificate SAN does not include hostname: ${hostname}`);
  }
  const notAfterMs = Date.parse(certificate.valid_to);
  if (!Number.isSafeInteger(nowMs) || !Number.isFinite(notAfterMs)) {
    throw new Error('TLS certificate expiry or monitor clock is invalid');
  }
  if (!Number.isSafeInteger(minimumFullDays) || minimumFullDays <= 0) {
    throw new Error('minimum certificate lifetime must be a positive whole-day count');
  }
  const remainingMs = notAfterMs - nowMs;
  if (remainingMs < minimumFullDays * dayMs) {
    throw new Error(`TLS certificate must remain valid for at least ${minimumFullDays} full days`);
  }
  return Math.floor(remainingMs / dayMs);
}

async function resolveHost(hostname) {
  if (isIP(hostname) !== 0) {
    return [{ address: hostname, family: isIP(hostname) }];
  }
  return lookup(hostname, { all: true, verbatim: true });
}

function readCertificate(hostname, port) {
  return new Promise((resolveCertificate, rejectCertificate) => {
    let settled = false;
    const options = {
      host: hostname,
      port,
      rejectUnauthorized: true,
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
    };
    const socket = connectTls(options, () => {
      const certificate = socket.getPeerCertificate(false);
      settled = true;
      socket.end();
      resolveCertificate(certificate);
    });
    socket.setTimeout(requestTimeoutMs, () => {
      socket.destroy(new Error('TLS certificate check timed out'));
    });
    socket.on('error', (error) => {
      if (!settled) rejectCertificate(error);
    });
  });
}

async function readBoundedText(response, label, expectedContentType, byteLimit) {
  if (!isObject(response) || response.ok !== true) {
    const status = isObject(response) && Number.isInteger(response.status)
      ? response.status
      : 'unknown';
    throw new Error(`${label} returned unsuccessful HTTP status ${status}`);
  }
  const contentType = response.headers?.get?.('content-type');
  if (typeof contentType !== 'string' || !expectedContentType.test(contentType)) {
    throw new Error(`${label} did not return the expected HTML or JSON content type`);
  }
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > byteLimit) {
      throw new Error(`${label} response is too large`);
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > byteLimit) {
    throw new Error(`${label} response is too large`);
  }
  return text;
}

async function atStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(stage, messageOf(error));
  }
}

export async function monitorPublicRelease(config, dependencies = {}) {
  const nowMs = config.nowMs ?? Date.now();
  const originUrl = await atStage('configuration', async () => parsePublicOrigin(config.publicBaseUrl));
  const maxAgeMs = await atStage(
    'configuration',
    async () => parseMaxSnapshotAgeHours(config.maxSnapshotAgeHours),
  );
  const minimumCertificateDays = config.minimumCertificateDays ?? 21;
  const approvedSnapshot = config.approvedSnapshot ?? await atStage(
    'snapshot-read',
    async () => (
      await readRegularJsonFile(
        config.approvedPath ?? 'data/approved/current.json',
        'approved snapshot',
      )
    ).value,
  );

  await atStage('snapshot-integrity', async () => {
    const errors = validateApprovedSnapshot(approvedSnapshot, nowMs);
    if (errors.length > 0) throw new Error(errors.join('; '));
    assertSnapshotFreshness(approvedSnapshot, nowMs, maxAgeMs);
  });

  const hostname = unbracket(originUrl.hostname);
  const addresses = await atStage(
    'dns',
    async () => (dependencies.resolveHost ?? resolveHost)(hostname),
  );
  await atStage('dns', async () => assertPublicAddresses(addresses));

  const certificate = await atStage(
    'tls',
    async () => (dependencies.readCertificate ?? readCertificate)(
      hostname,
      Number(originUrl.port || '443'),
    ),
  );
  const certificateDaysRemaining = await atStage(
    'tls',
    async () => assertCertificate(certificate, hostname, nowMs, minimumCertificateDays),
  );

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new MonitorError('http', 'fetch is unavailable');
  const requestOptions = {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      accept: 'text/html,application/json;q=0.9',
      'user-agent': 'CS-BAOYAN-DDL-public-monitor/1',
    },
  };
  const homepageResponse = await atStage(
    'homepage',
    async () => fetchImpl(`${originUrl.origin}/`, requestOptions),
  );
  const homepage = await atStage(
    'homepage',
    async () => readBoundedText(homepageResponse, 'homepage', /^text\/html(?:\s*;|$)/i, homepageByteLimit),
  );
  if (!/<(?:!doctype\s+html|html)\b/i.test(homepage)) {
    throw new MonitorError('homepage', 'homepage is not recognizable HTML');
  }

  const releaseResponse = await atStage(
    'release',
    async () => fetchImpl(`${originUrl.origin}/release.json`, {
      ...requestOptions,
      headers: {
        ...requestOptions.headers,
        accept: 'application/json',
      },
    }),
  );
  const releaseText = await atStage(
    'release',
    async () => readBoundedText(
      releaseResponse,
      'release response',
      /^application\/json(?:\s*;|$)/i,
      releaseByteLimit,
    ),
  );
  const release = await atStage('release', async () => parseRelease(releaseText));
  await atStage(
    'release-identity',
    async () => assertReleaseIdentity(release, approvedSnapshot, config.expectedSha),
  );

  return {
    origin: originUrl.origin,
    release,
    certificateDaysRemaining,
    maxSnapshotAgeHours: maxAgeMs / hourMs,
  };
}

async function writeDiagnostics(path, diagnostic) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(diagnostic)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function runCli() {
  const checkedAt = new Date().toISOString();
  const diagnosticsPath = process.env.MONITOR_DIAGNOSTICS_PATH
    ?? 'monitor-diagnostics/public-monitor.json';
  try {
    const result = await monitorPublicRelease({
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
      expectedSha: process.env.GITHUB_SHA,
      maxSnapshotAgeHours: process.env.MAX_SNAPSHOT_AGE_HOURS,
      minimumCertificateDays: Number(process.env.CERT_MIN_VALID_DAYS ?? '21'),
      approvedPath: 'data/approved/current.json',
    });
    console.log(
      `Public monitor passed: releaseSha=${result.release.releaseSha} `
      + `snapshotId=${result.release.snapshotId} `
      + `certificateDaysRemaining=${result.certificateDaysRemaining}`,
    );
  } catch (error) {
    const diagnostic = {
      ok: false,
      checkedAt,
      stage: error instanceof MonitorError ? error.stage : 'monitor',
      message: messageOf(error),
    };
    try {
      await writeDiagnostics(diagnosticsPath, diagnostic);
    } catch (writeError) {
      console.error(`public monitor diagnostics could not be written: ${messageOf(writeError)}`);
    }
    console.error(`public monitor failed at ${diagnostic.stage}: ${diagnostic.message}`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  runCli().catch((error) => {
    console.error(`public monitor failed: ${messageOf(error)}`);
    process.exitCode = 1;
  });
}
