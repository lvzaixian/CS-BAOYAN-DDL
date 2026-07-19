import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import { pathToFileURL } from 'node:url';

import {
  isValidIsoTimestamp,
  MAX_SNAPSHOT_JSON_BYTES,
  validateStoredApprovedSnapshot,
} from '../src/lib/snapshot-integrity.js';
import { checkSnapshotFreshness } from './snapshot/check-freshness.js';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const homepageByteLimit = 1024 * 1024;
const releaseByteLimit = 16 * 1024;
const requestTimeoutMs = 15_000;
const defaultResponseDeadlineMs = 30_000;
const releaseKeys = ['dataHash', 'releaseSha', 'snapshotId'];
const maxJsonDepth = 512;

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

export function parseStrictJson(text, label = 'JSON response') {
  if (typeof text !== 'string') throw new Error(`${label} must be text`);
  let index = 0;

  const invalid = () => {
    throw new Error(`${label} is not valid JSON`);
  };
  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? '') && text.charCodeAt(index) <= 0x20) index += 1;
  };
  const readString = () => {
    if (text[index] !== '"') invalid();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          invalid();
        }
      }
      if (text.charCodeAt(index) <= 0x1f) invalid();
      if (character === '\\') {
        index += 1;
        const escape = text[index];
        if ('"\\/bfnrt'.includes(escape ?? '')) {
          index += 1;
          continue;
        }
        if (escape === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
          index += 5;
          continue;
        }
        invalid();
      }
      index += 1;
    }
    invalid();
  };
  const readPrimitive = () => {
    const start = index;
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index += 1;
    if (start === index) invalid();
    try {
      JSON.parse(text.slice(start, index));
    } catch {
      invalid();
    }
  };
  const readValue = (depth) => {
    if (depth > maxJsonDepth) throw new Error(`${label} exceeds the nesting limit`);
    skipWhitespace();
    if (text[index] === '"') {
      readString();
      return;
    }
    if (text[index] === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        readValue(depth + 1);
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') invalid();
        index += 1;
      }
      invalid();
    }
    if (text[index] === '{') {
      index += 1;
      const keys = new Set();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) throw new Error(`${label} contains a duplicate JSON object key`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') invalid();
        index += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') invalid();
        index += 1;
      }
      invalid();
    }
    readPrimitive();
  };

  readValue(0);
  skipWhitespace();
  if (index !== text.length) invalid();
  return JSON.parse(text);
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

function ipv6Value(address) {
  let normalized = address.toLowerCase().split('%', 1)[0];
  const ipv4Tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (ipv4Tail !== null) {
    const octets = parseIpv4(ipv4Tail[1]);
    if (octets === null) return null;
    const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}`
      + `:${((octets[2] << 8) | octets[3]).toString(16)}`;
    normalized = normalized.slice(0, -ipv4Tail[1].length) + replacement;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isInIpv6Subnet(value, prefix, prefixLength) {
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (prefix >> shift);
}

function isNonPublicIpv6(address) {
  const value = ipv6Value(address);
  if (value === null) return true;
  const subnet = (prefix, prefixLength) => isInIpv6Subnet(
    value,
    ipv6Value(prefix),
    prefixLength,
  );
  if (!subnet('2000::', 3)) return true;
  return (
    subnet('2001::', 23)
    || subnet('2001:db8::', 32)
    || subnet('2002::', 16)
    || subnet('3ffe::', 16)
    || subnet('3fff::', 20)
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
  const value = parseStrictJson(text, 'release response');
  return assertReleaseSchema(value);
}

export function assertReleaseIdentity(release, currentSnapshot) {
  assertReleaseSchema(release);
  if (!isObject(currentSnapshot)) throw new Error('current snapshot must be an object');
  if (release.snapshotId !== currentSnapshot.snapshotId) {
    throw new Error('snapshotId does not match the current snapshot');
  }
  if (release.dataHash !== currentSnapshot.dataHash) {
    throw new Error('dataHash does not match the current snapshot');
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

export function readBoundCertificate(hostname, port, address, connectImpl = connectTls) {
  let signal;
  if (typeof connectImpl !== 'function') {
    signal = connectImpl;
    connectImpl = connectTls;
  }
  return new Promise((resolveCertificate, rejectCertificate) => {
    let settled = false;
    const options = {
      host: address.address,
      family: address.family,
      port,
      rejectUnauthorized: true,
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      checkServerIdentity: (_servername, certificate) => checkServerIdentity(hostname, certificate),
    };
    const socket = connectImpl(options, () => {
      const certificate = socket.getPeerCertificate(false);
      settled = true;
      socket.end();
      resolveCertificate(certificate);
    });
    const abort = () => {
      const reason = signal?.reason instanceof Error
        ? signal.reason
        : new Error('monitor response deadline exceeded');
      socket.destroy(reason);
    };
    if (signal?.aborted) abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    socket.setTimeout(requestTimeoutMs, () => {
      socket.destroy(new Error('TLS certificate check timed out'));
    });
    socket.on('error', (error) => {
      if (!settled) rejectCertificate(error);
    });
  });
}

export function requestBoundHttps(urlValue, options, requestImpl = httpsRequest) {
  const url = new URL(urlValue);
  const { address, headers, hostname, signal } = options;
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    let activeResponse;
    const request = requestImpl({
      protocol: 'https:',
      hostname: address.address,
      family: address.family,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      rejectUnauthorized: true,
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      checkServerIdentity: (_servername, certificate) => checkServerIdentity(hostname, certificate),
      headers: {
        ...headers,
        host: url.host,
      },
    }, (response) => {
      settled = true;
      activeResponse = response;
      resolveResponse({
        ok: response.statusCode !== undefined
          && response.statusCode >= 200
          && response.statusCode < 300,
        status: response.statusCode,
        headers: {
          get(name) {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value ?? null;
          },
        },
        body: response,
        destroy() {
          response.destroy();
        },
      });
    });
    const abort = () => {
      const reason = signal?.reason instanceof Error
        ? signal.reason
        : new Error('monitor response deadline exceeded');
      activeResponse?.destroy?.(reason);
      request.destroy(reason);
    };
    if (signal?.aborted) abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error('HTTPS request timed out'));
    });
    request.on('error', (error) => {
      if (!settled) rejectResponse(error);
    });
    request.end();
  });
}

async function readBoundedText(response, label, expectedContentType, byteLimit, signal) {
  const abort = () => response?.destroy?.();
  if (signal?.aborted) abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  try {
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
    const body = response.body;
    if (body === null || body === undefined || typeof body[Symbol.asyncIterator] !== 'function') {
      throw new Error(`${label} response body is not a readable stream`);
    }
    const chunks = [];
    let bytesRead = 0;
    for await (const chunk of body) {
      if (signal?.aborted) throw signal.reason;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.byteLength;
      if (bytesRead > byteLimit) throw new Error(`${label} response is too large`);
      chunks.push(buffer);
    }
    if (signal?.aborted) throw signal.reason;
    return Buffer.concat(chunks, bytesRead).toString('utf8');
  } catch (error) {
    response?.destroy?.();
    throw error;
  } finally {
    signal?.removeEventListener?.('abort', abort);
  }
}

async function atStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(stage, messageOf(error));
  }
}

function parseResponseDeadlineMs(value) {
  const deadline = value ?? defaultResponseDeadlineMs;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error('response deadline must be a positive safe integer number of milliseconds');
  }
  return deadline;
}

async function monitorPublicReleaseWithinDeadline(config, dependencies, signal) {
  const nowMs = config.nowMs ?? Date.now();
  const originUrl = await atStage('configuration', async () => parsePublicOrigin(config.publicBaseUrl));
  const warnAgeMs = await atStage(
    'configuration',
    async () => parseMaxSnapshotAgeHours(config.warnSnapshotAgeHours),
  );
  const maxAgeMs = await atStage(
    'configuration',
    async () => parseMaxSnapshotAgeHours(config.maxSnapshotAgeHours),
  );
  await atStage('configuration', async () => {
    if (warnAgeMs > maxAgeMs) {
      throw new Error('snapshot warning age must not exceed the maximum age');
    }
    if (!/^[0-9a-f]{40}$/.test(config.expectedSha)) {
      throw new Error('expected GITHUB_SHA must be exactly 40 lowercase hexadecimal characters');
    }
  });
  const minimumCertificateDays = config.minimumCertificateDays ?? 21;
  const warnings = [];

  const hostname = unbracket(originUrl.hostname);
  const addresses = await atStage(
    'dns',
    async () => (dependencies.resolveHost ?? resolveHost)(hostname),
  );
  await atStage('dns', async () => assertPublicAddresses(addresses));
  const firstAddress = typeof addresses[0] === 'string' ? addresses[0] : addresses[0].address;
  const selectedAddress = { address: firstAddress, family: isIP(firstAddress) };

  const certificate = await atStage(
    'tls',
    async () => (dependencies.readCertificate ?? readBoundCertificate)(
      hostname,
      Number(originUrl.port || '443'),
      selectedAddress,
      signal,
    ),
  );
  const certificateDaysRemaining = await atStage(
    'tls',
    async () => assertCertificate(certificate, hostname, nowMs, minimumCertificateDays),
  );

  const requestHttps = dependencies.requestHttps ?? requestBoundHttps;
  if (typeof requestHttps !== 'function') throw new MonitorError('http', 'HTTPS request is unavailable');
  const requestOptions = {
    address: selectedAddress,
    hostname,
    signal,
    headers: {
      accept: 'text/html,application/json;q=0.9',
      'user-agent': 'CS-BAOYAN-DDL-public-monitor/1',
    },
  };
  const homepageResponse = await atStage(
    'homepage',
    async () => requestHttps(`${originUrl.origin}/`, requestOptions),
  );
  const homepage = await atStage(
    'homepage',
    async () => readBoundedText(
      homepageResponse,
      'homepage',
      /^text\/html(?:\s*;|$)/i,
      homepageByteLimit,
      signal,
    ),
  );
  if (!/<(?:!doctype\s+html|html)\b/i.test(homepage)) {
    throw new MonitorError('homepage', 'homepage is not recognizable HTML');
  }

  const currentResponse = await atStage(
    'snapshot-read',
    async () => requestHttps(`${originUrl.origin}/data/current.json`, {
      ...requestOptions,
      headers: {
        ...requestOptions.headers,
        accept: 'application/json',
      },
    }),
  );
  const currentText = await atStage(
    'snapshot-read',
    async () => readBoundedText(
      currentResponse,
      'current snapshot response',
      /^application\/json(?:\s*;|$)/i,
      MAX_SNAPSHOT_JSON_BYTES,
      signal,
    ),
  );
  const approvedSnapshot = await atStage(
    'snapshot-integrity',
    async () => parseStrictJson(currentText, 'current snapshot response'),
  );
  await atStage('snapshot-integrity', async () => {
    const errors = validateStoredApprovedSnapshot(approvedSnapshot, nowMs);
    if (errors.length > 0) throw new Error(errors.join('; '));
    assertSnapshotFreshness(approvedSnapshot, nowMs, maxAgeMs);
  });
  if (checkSnapshotFreshness(approvedSnapshot, nowMs, warnAgeMs).length > 0) {
    warnings.push(
      `Snapshot is older than the ${warnAgeMs / hourMs}-hour daily scan target `
      + `but remains within the ${maxAgeMs / hourMs}-hour hard limit.`,
    );
  }

  const releaseResponse = await atStage(
    'release',
    async () => requestHttps(`${originUrl.origin}/data/release.json`, {
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
      signal,
    ),
  );
  const release = await atStage('release', async () => parseRelease(releaseText));
  await atStage(
    'release-identity',
    async () => assertReleaseIdentity(release, approvedSnapshot),
  );
  if (release.releaseSha !== config.expectedSha) {
    warnings.push(
      `Deployed release ${release.releaseSha} differs from main ${config.expectedSha}; `
      + 'public release integrity is valid but release parity needs review.',
    );
  }

  return {
    origin: originUrl.origin,
    release,
    certificateDaysRemaining,
    warnings,
    warnSnapshotAgeHours: warnAgeMs / hourMs,
    maxSnapshotAgeHours: maxAgeMs / hourMs,
  };
}

export async function monitorPublicRelease(config, dependencies = {}) {
  let deadlineMs;
  try {
    deadlineMs = parseResponseDeadlineMs(config.responseDeadlineMs);
  } catch (error) {
    throw new MonitorError('configuration', messageOf(error));
  }
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const error = new MonitorError('deadline', 'monitor response deadline exceeded');
    controller.abort(error);
    rejectDeadline(error);
  }, deadlineMs);
  try {
    return await Promise.race([
      monitorPublicReleaseWithinDeadline(config, dependencies, controller.signal),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error('monitor stopped'));
  }
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
      warnSnapshotAgeHours: process.env.WARN_SNAPSHOT_AGE_HOURS,
      maxSnapshotAgeHours: process.env.MAX_SNAPSHOT_AGE_HOURS,
      minimumCertificateDays: Number(process.env.CERT_MIN_VALID_DAYS ?? '21'),
    });
    console.log(
      `Public monitor passed: releaseSha=${result.release.releaseSha} `
      + `snapshotId=${result.release.snapshotId} `
      + `certificateDaysRemaining=${result.certificateDaysRemaining}`,
    );
    for (const warning of result.warnings) {
      console.warn(`::warning title=Public monitor::${messageOf(warning)}`);
    }
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
