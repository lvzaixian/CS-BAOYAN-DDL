import { createHash } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  PublicSnapshot,
  SnapshotCandidate,
} from '../../src/lib/snapshot-types.js';
import {
  buildScanReleaseArtifacts,
  type ScanReleaseArtifacts,
} from '../../scripts/snapshot/build-scan-release.js';
import type { PendingLedger } from '../../scripts/snapshot/pending-ledger.js';
import type { ScanBundle } from '../../scripts/snapshot/scan-release-contract.js';

const scanStartedAt = '2026-07-16T01:36:00.000Z';
const scanFinishedAt = '2026-07-16T01:38:00.000Z';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function emptyPendingLedger(): PendingLedger {
  const payload = {
    schemaVersion: 1 as const,
    current: {
      generation: 0,
      previousSha256: null,
      entries: [],
    },
    history: [],
  };
  const sha256 = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  return {
    schemaVersion: 1,
    current: {
      generation: 0,
      sha256,
      previousSha256: null,
      entries: [],
    },
    history: [],
  };
}

export interface ReplayableReleaseFixture {
  releaseDir: string;
  pendingCurrentPath: string;
  candidate: SnapshotCandidate;
  artifacts: ScanReleaseArtifacts;
  bundle: ScanBundle;
}

export function writeReplayableReleaseFixture(
  root: string,
  parent: PublicSnapshot,
): ReplayableReleaseFixture {
  const releaseDir = join(root, 'release');
  const artifactRoot = join(releaseDir, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });

  const parentText = `${JSON.stringify(parent, null, 2)}\n`;
  const registry = [{ name: '测试大学' }];
  const registryText = `${JSON.stringify(registry, null, 2)}\n`;
  const pendingBase = emptyPendingLedger();
  const artifactText = 'official sentinel evidence\n';
  const artifactRelativePath = 'sentinel.txt';
  const artifactSha256 = createHash('sha256')
    .update(artifactText)
    .digest('hex');
  writeFileSync(join(artifactRoot, artifactRelativePath), artifactText, 'utf8');

  const runId = '20260716-secure-approval-fixture';
  const bundle: ScanBundle = {
    schemaVersion: 2,
    runId,
    scanMode: 'incremental',
    scanStartedAt,
    scanFinishedAt,
    candidateBase: {
      type: 'public-approved-snapshot',
      url: 'https://ddl.meta-mind.cn/data/current.json',
      sha256: createHash('sha256').update(parentText).digest('hex'),
      snapshotId: parent.snapshotId,
      dataHash: parent.dataHash,
      privateParentCandidateUsed: false,
    },
    registry: {
      sha256: createHash('sha256').update(registryText).digest('hex'),
      institutionCount: registry.length,
    },
    pendingLedger: {
      generation: pendingBase.current.generation,
      sha256: pendingBase.current.sha256,
    },
    errors: [],
    warnings: [],
    discoverySourceChecks: [
      {
        name: '保研通知网',
        url: 'https://baoyantongzhi.com/',
        status: 'blocked',
        pagesChecked: 0,
        checkedAt: scanStartedAt,
        error: 'fixture discovery source unavailable',
      },
      {
        name: 'CS-BAOYAN DDL',
        url: 'https://ddl.csbaoyan.top/',
        status: 'blocked',
        pagesChecked: 0,
        checkedAt: scanStartedAt,
        error: 'fixture discovery source unavailable',
      },
      {
        name: 'BoardCaster',
        url: 'https://boardcaster.net/',
        status: 'blocked',
        pagesChecked: 0,
        checkedAt: scanStartedAt,
        error: 'fixture discovery source unavailable',
      },
    ],
    scopeItems: [
      {
        scopeItemId: 'sentinel:test-university',
        kind: 'sentinel',
        school: '测试大学',
        targetId: '测试大学',
        status: 'no-current-notice',
        evidenceIds: ['evidence:sentinel'],
      },
    ],
    evidenceRecords: [
      {
        evidenceId: 'evidence:sentinel',
        scopeItemId: 'sentinel:test-university',
        school: '测试大学',
        region: '华北',
        kind: 'graduate-admissions',
        url: 'https://grad.example.edu.cn/admissions',
        result: 'no-current-notice',
        checkedAt: scanFinishedAt,
        artifactSha256,
        query: '测试大学 2027 推免',
        discoveredScopeItemIds: [],
      },
    ],
    projectObservations: [],
    pendingUpdates: [],
    exclusions: [],
  };
  const sentinels = {
    schemaVersion: 1 as const,
    cycle: '2027',
    institutions: [
      {
        school: '测试大学',
        minimumEvidenceRecords: 1,
        requiredOfficialKinds: ['graduate-admissions' as const],
      },
    ],
  };
  const identityRegistry = {
    schemaVersion: 2 as const,
    urlAliases: [],
    projectAliases: [],
    tombstones: [],
  };
  const submittedRegistry = {
    schemaVersion: 1 as const,
    source: 'test fixture',
    submittedProjectIds: [],
  };
  const artifactManifest = {
    schemaVersion: 1 as const,
    runId,
    artifacts: [
      {
        relativePath: artifactRelativePath,
        sha256: artifactSha256,
        sizeBytes: Buffer.byteLength(artifactText),
      },
    ],
  };
  const artifacts = buildScanReleaseArtifacts({
    bundle,
    parent,
    registryInstitutions: registry,
    sentinels,
    identityRegistry,
    submittedRegistry,
    pendingLedger: pendingBase,
    artifactManifest,
    removalReviews: [],
  });

  writeFileSync(join(releaseDir, 'universities.json'), registryText, 'utf8');
  writeJson(join(releaseDir, 'scan-bundle.json'), bundle);
  writeJson(join(releaseDir, 'priority-sentinels.json'), sentinels);
  writeJson(join(releaseDir, 'project-id-aliases.json'), identityRegistry);
  writeJson(join(releaseDir, 'submitted.json'), submittedRegistry);
  writeJson(join(releaseDir, 'pending-base.json'), pendingBase);
  writeJson(join(releaseDir, 'candidate.json'), artifacts.candidate);
  writeJson(join(releaseDir, 'diff.json'), artifacts.diff);
  writeJson(join(releaseDir, 'lifecycle.json'), artifacts.reduction.lifecycle);
  writeJson(
    join(releaseDir, 'evidence-dispositions.json'),
    artifacts.reduction.evidenceDispositions,
  );
  writeJson(join(releaseDir, 'pending-next.json'), artifacts.pendingNext);
  writeJson(join(releaseDir, 'release-audit.json'), artifacts.audit);
  writeJson(join(releaseDir, 'gate.json'), artifacts.gate);
  writeJson(join(releaseDir, 'artifact-manifest.json'), artifactManifest);
  writeJson(join(releaseDir, 'removal-reviews.json'), []);

  const pendingCurrentPath = join(root, 'persistent-pending.json');
  writeJson(pendingCurrentPath, artifacts.pendingNext);
  return {
    releaseDir,
    pendingCurrentPath,
    candidate: artifacts.candidate,
    artifacts,
    bundle,
  };
}
