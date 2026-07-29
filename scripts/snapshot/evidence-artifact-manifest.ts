import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';

import type { ScanBundle } from './scan-release-contract.js';

type JsonObject = Record<string, unknown>;

export interface EvidenceArtifact {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface EvidenceArtifactManifest {
  schemaVersion: 1;
  runId: string;
  artifacts: EvidenceArtifact[];
}

export interface BuildEvidenceArtifactManifestOptions {
  artifactRoot: string;
  runId: string;
  relativePaths: readonly string[];
  ioHooks?: {
    afterPathValidation?: (relativePath: string) => void | Promise<void>;
    afterFileOpen?: (relativePath: string) => void | Promise<void>;
  };
}

export interface VerifyEvidenceArtifactManifestOptions {
  artifactRoot: string;
  manifest: unknown;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;

interface FileSystemIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
}

interface ResolvedArtifactRoot {
  originalPath: string;
  resolvedPath: string;
  identity: FileSystemIdentity;
}

interface BoundArtifactPathEntry {
  path: string;
  displayPath: string;
  type: 'directory' | 'file';
  identity: FileSystemIdentity;
}

interface BoundArtifactPath {
  path: string;
  entries: BoundArtifactPathEntry[];
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(
  object: JsonObject,
  path: string,
  required: readonly string[],
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in object)) throw new Error(`${path}.${key} is required`);
  }
}

function nonEmptyStringAt(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function relativePathAt(object: JsonObject, path: string): string {
  const relativePath = nonEmptyStringAt(object, 'relativePath', path);
  if (relativePath.includes('\0')) {
    throw new Error(`${path}.relativePath must not contain NUL bytes`);
  }
  if (posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new Error(`${path}.relativePath must be relative`);
  }

  const slashPath = relativePath.replaceAll('\\', '/');
  const segments = slashPath.split('/');
  if (segments.includes('..')) {
    throw new Error(`${path}.relativePath must not contain .. segments`);
  }
  if (segments.includes('')) {
    throw new Error(`${path}.relativePath must not contain empty segments`);
  }

  return relativePath;
}

function artifactAt(value: unknown, path: string): EvidenceArtifact {
  const object = objectAt(value, path);
  exactKeys(object, path, ['relativePath', 'sha256', 'sizeBytes']);

  const sha256 = nonEmptyStringAt(object, 'sha256', path);
  if (!sha256Pattern.test(sha256)) {
    throw new Error(`${path}.sha256 must be a lowercase SHA-256 digest`);
  }

  const sizeBytes = object.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) {
    throw new Error(`${path}.sizeBytes must be a non-negative safe integer`);
  }

  return {
    relativePath: relativePathAt(object, path),
    sha256,
    sizeBytes: sizeBytes as number,
  };
}

function assertUniqueArtifactPaths(artifacts: readonly EvidenceArtifact[]): void {
  const exactPaths = new Set<string>();
  const unicodePaths = new Map<string, string>();
  const normalizedPaths = new Map<string, string>();

  artifacts.forEach((artifact, index) => {
    const { relativePath } = artifact;
    if (exactPaths.has(relativePath)) {
      throw new Error(`artifacts[${index}].relativePath is a duplicate relativePath`);
    }
    exactPaths.add(relativePath);

    const unicodeKey = relativePath.normalize('NFC');
    const unicodeMatch = unicodePaths.get(unicodeKey);
    if (unicodeMatch !== undefined && unicodeMatch !== relativePath) {
      throw new Error(
        `artifacts[${index}].relativePath has a Unicode normalization collision with ${unicodeMatch}`,
      );
    }
    unicodePaths.set(unicodeKey, relativePath);

    const pathKey = posix
      .normalize(relativePath.replaceAll('\\', '/'))
      .normalize('NFC');
    const normalizedMatch = normalizedPaths.get(pathKey);
    if (normalizedMatch !== undefined && normalizedMatch !== relativePath) {
      throw new Error(
        `artifacts[${index}].relativePath has a path normalization collision with ${normalizedMatch}`,
      );
    }
    normalizedPaths.set(pathKey, relativePath);
  });
}

export function parseEvidenceArtifactManifest(
  input: unknown,
): EvidenceArtifactManifest {
  const object = objectAt(input, 'evidence artifact manifest');
  exactKeys(object, 'evidence artifact manifest', [
    'schemaVersion',
    'runId',
    'artifacts',
  ]);
  if (object.schemaVersion !== 1) {
    throw new Error('evidence artifact manifest.schemaVersion must be 1');
  }
  const runId = nonEmptyStringAt(object, 'runId', 'evidence artifact manifest');
  if (!Array.isArray(object.artifacts)) {
    throw new Error('evidence artifact manifest.artifacts must be an array');
  }
  const artifacts = object.artifacts.map((artifact, index) =>
    artifactAt(artifact, `artifacts[${index}]`),
  );
  assertUniqueArtifactPaths(artifacts);

  return {
    schemaVersion: 1,
    runId,
    artifacts,
  };
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireNonEmptyOption(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireRelativePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('relativePaths must be an array');
  }
  return value.map((relativePath, index) => {
    if (typeof relativePath !== 'string') {
      throw new Error(`relativePaths[${index}] must be a string`);
    }
    return relativePath;
  });
}

function identityOf(metadata: BigIntStats): FileSystemIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
  };
}

function hasIdentity(
  metadata: BigIntStats,
  identity: FileSystemIdentity,
): boolean {
  return (
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino &&
    metadata.size === identity.size
  );
}

async function lstatForRevalidation(
  path: string,
  changedMessage: string,
): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    throw new Error(changedMessage, { cause: error });
  }
}

async function assertArtifactRootUnchanged(
  artifactRoot: ResolvedArtifactRoot,
): Promise<void> {
  const changedMessage = 'artifactRoot changed during read';
  const originalMetadata = await lstatForRevalidation(
    artifactRoot.originalPath,
    changedMessage,
  );
  if (
    originalMetadata.isSymbolicLink() ||
    !originalMetadata.isDirectory() ||
    !hasIdentity(originalMetadata, artifactRoot.identity)
  ) {
    throw new Error(changedMessage);
  }

  const resolvedMetadata = await lstatForRevalidation(
    artifactRoot.resolvedPath,
    changedMessage,
  );
  if (
    resolvedMetadata.isSymbolicLink() ||
    !resolvedMetadata.isDirectory() ||
    !hasIdentity(resolvedMetadata, artifactRoot.identity)
  ) {
    throw new Error(changedMessage);
  }
}

async function resolveArtifactRoot(
  artifactRoot: string,
): Promise<ResolvedArtifactRoot> {
  const originalPath = resolve(artifactRoot);
  const metadata = await lstat(originalPath, { bigint: true });
  if (metadata.isSymbolicLink()) {
    throw new Error('artifactRoot must not be a symbolic link');
  }
  if (!metadata.isDirectory()) {
    throw new Error('artifactRoot must be a directory');
  }

  const resolvedPath = await realpath(originalPath);
  const resolvedRoot = {
    originalPath,
    resolvedPath,
    identity: identityOf(metadata),
  };
  await assertArtifactRootUnchanged(resolvedRoot);
  return resolvedRoot;
}

async function resolveRegularArtifactPath(
  artifactRoot: ResolvedArtifactRoot,
  relativePath: string,
): Promise<BoundArtifactPath> {
  const segments = relativePath.replaceAll('\\', '/').split('/');
  const entries: BoundArtifactPathEntry[] = [];
  let currentPath = artifactRoot.resolvedPath;

  await assertArtifactRootUnchanged(artifactRoot);

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = resolve(currentPath, segments[index]);
    const displayPath = segments.slice(0, index + 1).join('/');
    const metadata = await lstat(currentPath, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw new Error(`artifact ${displayPath} must not be a symbolic link`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error(`artifact path ${displayPath} must be a directory`);
    }
    if (index === segments.length - 1 && !metadata.isFile()) {
      throw new Error(`artifact ${relativePath} must be a regular file`);
    }
    entries.push({
      path: currentPath,
      displayPath,
      type: index < segments.length - 1 ? 'directory' : 'file',
      identity: identityOf(metadata),
    });
  }

  return {
    path: currentPath,
    entries,
  };
}

async function assertArtifactPathUnchanged(
  artifactRoot: ResolvedArtifactRoot,
  artifactPath: BoundArtifactPath,
  relativePath: string,
): Promise<void> {
  await assertArtifactRootUnchanged(artifactRoot);

  for (const entry of artifactPath.entries) {
    const changedMessage =
      entry.type === 'directory'
        ? `artifact path ${entry.displayPath} changed during read`
        : `artifact ${relativePath} changed during read`;
    const metadata = await lstatForRevalidation(entry.path, changedMessage);
    const hasExpectedType =
      entry.type === 'directory'
        ? metadata.isDirectory()
        : metadata.isFile();
    if (
      metadata.isSymbolicLink() ||
      !hasExpectedType ||
      !hasIdentity(metadata, entry.identity)
    ) {
      throw new Error(changedMessage);
    }
  }
}

async function readArtifact(
  artifactRoot: ResolvedArtifactRoot,
  relativePath: string,
  ioHooks?: BuildEvidenceArtifactManifestOptions['ioHooks'],
): Promise<EvidenceArtifact> {
  const artifactPath = await resolveRegularArtifactPath(
    artifactRoot,
    relativePath,
  );
  await ioHooks?.afterPathValidation?.(relativePath);
  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(artifactPath.path, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) {
      throw new Error(`artifact ${relativePath} must be a regular file`);
    }
    const pathIdentity =
      artifactPath.entries[artifactPath.entries.length - 1].identity;
    if (!hasIdentity(metadata, pathIdentity)) {
      throw new Error(`artifact ${relativePath} changed during read`);
    }
    const openedIdentity = identityOf(metadata);
    await ioHooks?.afterFileOpen?.(relativePath);
    const bytes = await handle.readFile();
    const metadataAfterRead = await handle.stat({ bigint: true });
    if (
      !metadataAfterRead.isFile() ||
      !hasIdentity(metadataAfterRead, openedIdentity) ||
      BigInt(bytes.byteLength) !== openedIdentity.size
    ) {
      throw new Error(`artifact ${relativePath} changed during read`);
    }
    await assertArtifactPathUnchanged(
      artifactRoot,
      artifactPath,
      relativePath,
    );
    return {
      relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
    };
  } finally {
    await handle.close();
  }
}

export async function buildEvidenceArtifactManifest(
  options: BuildEvidenceArtifactManifestOptions,
): Promise<EvidenceArtifactManifest> {
  const artifactRoot = requireNonEmptyOption(
    options?.artifactRoot,
    'artifactRoot',
  );
  const runId = requireNonEmptyOption(options?.runId, 'runId');
  const relativePaths = requireRelativePaths(options?.relativePaths);
  const requested = parseEvidenceArtifactManifest({
    schemaVersion: 1,
    runId,
    artifacts: relativePaths.map((relativePath) => ({
      relativePath,
      sha256: '0'.repeat(64),
      sizeBytes: 0,
    })),
  });
  const resolvedRoot = await resolveArtifactRoot(artifactRoot);
  const artifacts = await Promise.all(
    requested.artifacts.map(({ relativePath }) =>
      readArtifact(resolvedRoot, relativePath, options.ioHooks),
    ),
  );
  artifacts.sort((left, right) =>
    compareCodePoints(left.relativePath, right.relativePath),
  );

  return {
    schemaVersion: 1,
    runId: requested.runId,
    artifacts,
  };
}

export async function verifyEvidenceArtifactManifest(
  options: VerifyEvidenceArtifactManifestOptions,
): Promise<EvidenceArtifactManifest> {
  const artifactRoot = requireNonEmptyOption(
    options?.artifactRoot,
    'artifactRoot',
  );
  const manifest = parseEvidenceArtifactManifest(options?.manifest);
  const current = await buildEvidenceArtifactManifest({
    artifactRoot,
    runId: manifest.runId,
    relativePaths: manifest.artifacts.map(({ relativePath }) => relativePath),
  });
  const currentByPath = new Map(
    current.artifacts.map((artifact) => [artifact.relativePath, artifact]),
  );

  for (const declared of manifest.artifacts) {
    const actual = currentByPath.get(declared.relativePath);
    if (actual === undefined) {
      throw new Error(`artifact ${declared.relativePath} is missing`);
    }
    if (declared.sizeBytes !== actual.sizeBytes) {
      throw new Error(
        `artifact ${declared.relativePath} sizeBytes does not match the current file`,
      );
    }
    if (declared.sha256 !== actual.sha256) {
      throw new Error(
        `artifact ${declared.relativePath} sha256 does not match the current file`,
      );
    }
  }

  return manifest;
}

/**
 * The caller must pass a manifest returned by buildEvidenceArtifactManifest or
 * verifyEvidenceArtifactManifest when filesystem provenance matters.
 */
export function assertReadableEvidenceArtifactsCovered(
  bundle: ScanBundle,
  manifestInput: EvidenceArtifactManifest,
): void {
  const manifest = parseEvidenceArtifactManifest(manifestInput);
  if (manifest.runId !== bundle.runId) {
    throw new Error(
      `evidence artifact manifest runId ${manifest.runId} does not match scan bundle runId ${bundle.runId}`,
    );
  }

  const artifactHashes = new Set(
    manifest.artifacts.map(({ sha256 }) => sha256),
  );
  const missing: Array<{ label: string; sha256: string }> = [];

  bundle.discoverySourceChecks.forEach((source, index) => {
    if (
      source.status !== 'blocked' &&
      source.artifactSha256 !== undefined &&
      !artifactHashes.has(source.artifactSha256)
    ) {
      missing.push({
        label: `discoverySourceChecks[${index}] ${source.name}`,
        sha256: source.artifactSha256,
      });
    }
  });
  bundle.evidenceRecords.forEach((evidence) => {
    if (
      evidence.result !== 'blocked' &&
      evidence.artifactSha256 !== undefined &&
      !artifactHashes.has(evidence.artifactSha256)
    ) {
      missing.push({
        label: evidence.evidenceId,
        sha256: evidence.artifactSha256,
      });
    }
  });

  if (missing.length > 0) {
    throw new Error(
      `evidence artifact manifest does not cover readable evidence: ${missing
        .map(({ label, sha256 }) => `${label} (${sha256})`)
        .join(', ')}`,
    );
  }
}
