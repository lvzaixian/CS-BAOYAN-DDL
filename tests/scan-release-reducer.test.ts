import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PublicOpportunity,
  PublicSnapshot,
} from '../src/lib/snapshot-types.js';
import {
  parseIdentityRegistry,
  parseScanBundle,
  type EvidenceRecord,
  type ProjectObservation,
  type ScopeItem,
} from '../scripts/snapshot/scan-release-contract.js';
import {
  reduceScanRelease,
  resolveProjectIdentity,
} from '../scripts/snapshot/scan-release-reducer.js';

const HASH = 'a'.repeat(64);
const START = '2026-07-29T00:00:00.000Z';
const FINISH = '2026-07-29T01:00:00.000Z';

function discoverySourceChecks() {
  return [
    {
      name: '保研通知网',
      url: 'https://baoyantongzhi.com/',
      status: 'checked',
      pagesChecked: 1,
      checkedAt: START,
      artifactSha256: '1'.repeat(64),
    },
    {
      name: 'CS-BAOYAN DDL',
      url: 'https://csbaoyan.top/',
      status: 'checked',
      pagesChecked: 1,
      checkedAt: START,
      artifactSha256: '2'.repeat(64),
    },
    {
      name: 'BoardCaster',
      url: 'https://boardcaster.net/',
      status: 'checked',
      pagesChecked: 1,
      checkedAt: START,
      artifactSha256: '3'.repeat(64),
    },
  ];
}

function bundle(input: {
  scopeItems: ScopeItem[];
  evidenceRecords: EvidenceRecord[];
  projectObservations?: ProjectObservation[];
  pendingUpdates?: unknown[];
  exclusions?: unknown[];
  scanMode?: 'full' | 'incremental';
}) {
  return parseScanBundle({
    schemaVersion: 2,
    runId: '20260729-reducer-test',
    scanMode: input.scanMode ?? 'full',
    scanStartedAt: START,
    scanFinishedAt: FINISH,
    candidateBase: {
      type: 'public-approved-snapshot',
      url: 'https://ddl.meta-mind.cn/data/current.json',
      sha256: HASH,
      snapshotId: 'snapshot-parent',
      dataHash: HASH,
      privateParentCandidateUsed: false,
    },
    registry: { sha256: HASH, institutionCount: 310 },
    pendingLedger: { generation: 7, sha256: HASH },
    errors: [],
    warnings: [],
    discoverySourceChecks: discoverySourceChecks(),
    scopeItems: input.scopeItems,
    evidenceRecords: input.evidenceRecords,
    projectObservations: input.projectObservations ?? [],
    pendingUpdates: input.pendingUpdates ?? [],
    exclusions: input.exclusions ?? [],
  });
}

function observation(
  overrides: Partial<ProjectObservation> & Pick<ProjectObservation, 'sourceProjectId' | 'school' | 'officialUrl' | 'evidenceIds'>,
): ProjectObservation {
  return {
    observationId: `obs:${overrides.sourceProjectId}`,
    sourceProjectId: overrides.sourceProjectId,
    cycle: '2027',
    school: overrides.school,
    project: '计算机学院推免预报名',
    eventType: '预推免',
    registrationState: 'open',
    deadline: '2026-08-03T15:59:59.000Z',
    deadlineOriginal: '2026-08-03 23:59（北京时间）',
    eventMode: 'unknown',
    eventTime: '待公布',
    formatLocation: '待公布',
    accommodation: '未公布',
    meals: '未公布',
    transport: '未公布',
    reimbursement: '未公布',
    recommendationLetters: '未公布',
    recommendationTemplate: '未公布',
    materialComplexity: 'unknown',
    materialList: '未公布',
    ...overrides,
  };
}

function evidence(
  overrides: Partial<EvidenceRecord> &
    Pick<EvidenceRecord, 'evidenceId' | 'scopeItemId' | 'school' | 'url' | 'result'>,
): EvidenceRecord {
  return {
    region: '华北',
    kind: 'college-notice',
    checkedAt: '2026-07-29T00:30:00.000Z',
    artifactSha256: 'b'.repeat(64),
    query: `${overrides.school} 2027 推免`,
    discoveredScopeItemIds: [],
    ...overrides,
    ...(overrides.result === 'blocked'
      ? { error: overrides.error ?? 'HTTP 412', artifactSha256: undefined }
      : {}),
  };
}

function scope(
  overrides: Partial<ScopeItem> &
    Pick<ScopeItem, 'scopeItemId' | 'school' | 'targetId' | 'status' | 'evidenceIds'>,
): ScopeItem {
  return { kind: 'sentinel', ...overrides };
}

function opportunity(
  projectId: string,
  website: string,
  status: PublicOpportunity['verificationStatus'] = 'confirmed-open',
): PublicOpportunity {
  const [, name, institute, project] = projectId.split('|');
  return {
    projectId,
    feedId: '2027',
    name,
    institute,
    project,
    eventType: '预推免',
    description: project,
    verificationStatus: status,
    deadline: status === 'expired' ? '2026-07-01T15:59:59.000Z' : '2026-08-03T15:59:59.000Z',
    deadlineOriginal: '官网时间',
    deadlineEpochMs:
      status === 'expired'
        ? Date.parse('2026-07-01T15:59:59.000Z')
        : Date.parse('2026-08-03T15:59:59.000Z'),
    website,
    tags: [],
    verifiedAt: START,
    discoverySources: [{ kind: 'official', label: '官网', url: website }],
    logistics: { status: 'not-published', summary: '未公布' },
    recommendation: { status: 'not-published', summary: '未公布' },
    materials: { status: 'not-published', summary: '未公布' },
    eventArrangement: {
      mode: 'unknown',
      time: { status: 'not-published', summary: '未公布' },
      formatLocation: { status: 'not-published', summary: '未公布' },
    },
  };
}

function parent(opportunities: PublicOpportunity[]): PublicSnapshot {
  return {
    schemaVersion: 2,
    scanAt: '2026-07-28T00:00:00.000Z',
    defaultFeedId: '2027',
    feeds: [{ id: '2027', label: '2027 推免', admissionCycle: '2027', eventYear: 2026 }],
    counts: {
      confirmedOpen: opportunities.filter((item) => item.verificationStatus === 'confirmed-open').length,
      confirmedUnknownDeadline: opportunities.filter(
        (item) => item.verificationStatus === 'confirmed-unknown-deadline',
      ).length,
      pendingExcluded: 0,
      expired: opportunities.filter((item) => item.verificationStatus === 'expired').length,
    },
    opportunities,
    snapshotId: 'snapshot-parent',
    approvedAt: '2026-07-28T01:00:00.000Z',
    previousSnapshotId: null,
    dataHash: HASH,
  };
}

const emptyRegistry = parseIdentityRegistry({
  schemaVersion: 2,
  urlAliases: [],
  projectAliases: [],
  tombstones: [],
});

test('BUPT blocked-first evidence still yields active system project plus pending college scope', () => {
  const projectId = '2027|北京邮电大学|研究生院|推免预报名';
  const records = [
    evidence({
      evidenceId: 'bupt-entry-412',
      scopeItemId: 'bupt-school',
      school: '北京邮电大学',
      url: 'https://yzfs.bupt.edu.cn/MasterTm/Default.aspx',
      result: 'blocked',
    }),
    evidence({
      evidenceId: 'bupt-system',
      scopeItemId: 'bupt-school',
      school: '北京邮电大学',
      kind: 'application-system',
      url: 'https://yzfs.bupt.edu.cn/MasterTm/ApplyBmxz.aspx',
      result: 'hit',
    }),
    evidence({
      evidenceId: 'bupt-cs-blocked',
      scopeItemId: 'bupt-cs',
      school: '北京邮电大学',
      url: 'https://scs.bupt.edu.cn/zsxx/sszs.htm',
      result: 'blocked',
    }),
  ];
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'bupt-school',
        school: '北京邮电大学',
        targetId: 'bupt-school-system',
        status: 'checked',
        evidenceIds: ['bupt-entry-412', 'bupt-system'],
      }),
      scope({
        scopeItemId: 'bupt-cs',
        kind: 'discovered-child',
        school: '北京邮电大学',
        targetId: 'bupt-cs-college',
        status: 'blocked',
        evidenceIds: ['bupt-cs-blocked'],
      }),
    ],
    evidenceRecords: records,
    projectObservations: [
      observation({
        sourceProjectId: projectId,
        school: '北京邮电大学',
        officialUrl: 'https://yzfs.bupt.edu.cn/MasterTm/ApplyBmxz.aspx',
        evidenceIds: ['bupt-system'],
      }),
    ],
    pendingUpdates: [
      {
        ledgerId: 'scope:bupt-cs',
        outcome: 'pending',
        checkedAt: '2026-07-29T00:30:00.000Z',
        evidenceIds: ['bupt-cs-blocked'],
        reason: '计算机学院通知页受 WAF 阻断',
        scopeItemId: 'bupt-cs',
        school: '北京邮电大学',
        region: '华北',
        targetId: 'bupt-cs-college',
        officialUrls: ['https://scs.bupt.edu.cn/zsxx/sszs.htm'],
        nextAction: '下一轮复核计算机学院通知和报名系统',
      },
    ],
  });

  const forward = reduceScanRelease(input, null, emptyRegistry, []);
  const reverse = reduceScanRelease(
    { ...input, evidenceRecords: [...input.evidenceRecords].reverse() },
    null,
    emptyRegistry,
    [],
  );

  assert.deepEqual(reverse, forward);
  assert.equal(forward.hardErrors.length, 0);
  assert.deepEqual(
    forward.lifecycle.map(({ canonicalProjectId, state }) => ({ canonicalProjectId, state })),
    [{ canonicalProjectId: projectId, state: 'confirmed-open' }],
  );
  assert.deepEqual(
    forward.pending.map(({ scopeItemId, reason }) => ({ scopeItemId, reason })),
    [{ scopeItemId: 'bupt-cs', reason: '计算机学院通知页受 WAF 阻断' }],
  );
  assert.equal(forward.evidenceDispositions.length, 3);
});

test('SUSTech path and round rename resolve to one canonical project', () => {
  const canonical = '2027|南方科技大学|计算机科学与工程系|优秀大学生夏令营';
  const source = '2027|南方科技大学|计算机科学与工程系|预推免';
  const previous = parent([
    opportunity(canonical, 'https://cse.sustech.edu.cn/graduate/3775.html'),
  ]);
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [
      {
        url: 'https://cse.sustech.edu.cn/notices/3775.html',
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '官网栏目迁移，通知编号不变',
        introducedRunId: '20260729-alias-review',
      },
    ],
    projectAliases: [],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'sustech-cse',
        school: '南方科技大学',
        targetId: canonical,
        status: 'checked',
        evidenceIds: ['sustech-notice'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'sustech-notice',
        scopeItemId: 'sustech-cse',
        school: '南方科技大学',
        region: '华南',
        url: 'https://cse.sustech.edu.cn/notices/3775.html',
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: source,
        school: '南方科技大学',
        project: '预推免',
        officialUrl: 'https://cse.sustech.edu.cn/notices/3775.html',
        evidenceIds: ['sustech-notice'],
      }),
    ],
  });

  assert.equal(resolveProjectIdentity(input.projectObservations[0], previous, registry).canonicalProjectId, canonical);
  const result = reduceScanRelease(input, previous, registry, []);
  assert.equal(result.hardErrors.length, 0);
  assert.equal(result.lifecycle.length, 1);
  assert.equal(result.lifecycle[0].canonicalProjectId, canonical);
  assert.equal(result.lifecycle[0].sourceProjectId, source);
});

test('a submitted project alias cannot re-enter through a renamed observation', () => {
  const source =
    '2027|北京信息科技大学|电子信息类|优秀大学生夏令营';
  const submitted =
    '2027|北京信息科技大学|电子信息类|2026暑期优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: source,
        canonicalProjectId: submitted,
        cycle: '2027',
        reason: '同一官方项目的标题简写',
        introducedRunId: '20260729-submitted-review',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'bistu-submitted',
        school: '北京信息科技大学',
        targetId: source,
        status: 'checked',
        evidenceIds: ['bistu-submitted-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'bistu-submitted-evidence',
        scopeItemId: 'bistu-submitted',
        school: '北京信息科技大学',
        url: 'https://computer.bistu.edu.cn/docs/2026-camp.pdf',
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: source,
        school: '北京信息科技大学',
        project: '优秀大学生夏令营',
        officialUrl: 'https://computer.bistu.edu.cn/docs/2026-camp.pdf',
        evidenceIds: ['bistu-submitted-evidence'],
      }),
    ],
  });

  const result = reduceScanRelease(input, null, registry, [], [submitted]);

  assert.ok(
    result.hardErrors.some(
      ({ code }) => code === 'SUBMITTED_PROJECT_NOT_EXCLUDED',
    ),
  );
});

test('a submitted exclusion resolves its renamed source to the submitted canonical ID', () => {
  const source =
    '2027|北京信息科技大学|电子信息类|优秀大学生夏令营';
  const submitted =
    '2027|北京信息科技大学|电子信息类|2026暑期优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: source,
        canonicalProjectId: submitted,
        cycle: '2027',
        reason: '同一官方项目的标题简写',
        introducedRunId: '20260729-submitted-review',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'bistu-submitted',
        school: '北京信息科技大学',
        targetId: source,
        status: 'checked',
        evidenceIds: ['bistu-submitted-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'bistu-submitted-evidence',
        scopeItemId: 'bistu-submitted',
        school: '北京信息科技大学',
        url: 'https://computer.bistu.edu.cn/docs/2026-camp.pdf',
        result: 'checked',
      }),
    ],
    exclusions: [
      {
        sourceProjectId: source,
        action: 'submitted-excluded',
        reason: '稳定身份复核后命中已投递清单',
        evidenceIds: ['bistu-submitted-evidence'],
      },
    ],
  });

  const result = reduceScanRelease(input, null, registry, [], [submitted]);

  assert.equal(result.hardErrors.length, 0);
  assert.deepEqual(result.lifecycle, [
    {
      sourceProjectId: source,
      canonicalProjectId: submitted,
      state: 'submitted-excluded',
      reason: '稳定身份复核后命中已投递清单',
      evidenceIds: ['bistu-submitted-evidence'],
      verifiedAt: '2026-07-29T00:30:00.000Z',
    },
  ]);
});

test('a submitted registry ID remains excluded when an alias redirects it', () => {
  const submitted =
    '2027|测试大学|计算机学院|优秀大学生夏令营';
  const renamed =
    '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: submitted,
        canonicalProjectId: renamed,
        cycle: '2027',
        reason: '同一官方项目的标题变更',
        introducedRunId: '20260729-submitted-closure',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'submitted-renamed',
        school: '测试大学',
        targetId: renamed,
        status: 'checked',
        evidenceIds: ['submitted-renamed-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'submitted-renamed-evidence',
        scopeItemId: 'submitted-renamed',
        school: '测试大学',
        url: 'https://cs.example.edu.cn/2026-camp',
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: renamed,
        school: '测试大学',
        project: '2026全国优秀大学生夏令营',
        officialUrl: 'https://cs.example.edu.cn/2026-camp',
        evidenceIds: ['submitted-renamed-evidence'],
      }),
    ],
  });

  const result = reduceScanRelease(input, null, registry, [], [submitted]);

  assert.ok(
    result.hardErrors.some(
      ({ code }) => code === 'SUBMITTED_PROJECT_NOT_EXCLUDED',
    ),
  );
});

test('submitted identity closure follows every alias hop for observations', () => {
  const submitted =
    '2027|测试大学|计算机学院|优秀大学生夏令营';
  const middle =
    '2027|测试大学|计算机学院|2026优秀大学生夏令营';
  const canonical =
    '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const observed =
    '2027|测试大学|计算机学院|全国优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: submitted,
        canonicalProjectId: middle,
        cycle: '2027',
        reason: '历史简称',
        introducedRunId: '20260729-submitted-multihop',
      },
      {
        sourceProjectId: middle,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '统一正式标题',
        introducedRunId: '20260729-submitted-multihop',
      },
      {
        sourceProjectId: observed,
        canonicalProjectId: middle,
        cycle: '2027',
        reason: '本轮标题漂移',
        introducedRunId: '20260729-submitted-multihop',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'submitted-multihop',
        school: '测试大学',
        targetId: observed,
        status: 'checked',
        evidenceIds: ['submitted-multihop-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'submitted-multihop-evidence',
        scopeItemId: 'submitted-multihop',
        school: '测试大学',
        url: 'https://cs.example.edu.cn/2026-camp',
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: observed,
        school: '测试大学',
        project: '全国优秀大学生夏令营',
        officialUrl: 'https://cs.example.edu.cn/2026-camp',
        evidenceIds: ['submitted-multihop-evidence'],
      }),
    ],
  });

  const result = reduceScanRelease(input, null, registry, [], [submitted]);

  assert.ok(
    result.hardErrors.some(
      ({ code }) => code === 'SUBMITTED_PROJECT_NOT_EXCLUDED',
    ),
  );
});

test('identity resolution follows a tombstone into an alias chain', () => {
  const source = '2027|测试大学|计算机学院|夏令营';
  const middle = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical =
    '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: middle,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '统一正式标题',
        introducedRunId: '20260729-identity-chain',
      },
    ],
    tombstones: [
      {
        projectId: source,
        mergedInto: middle,
        cycle: '2027',
        reason: '旧标题停止使用',
        introducedRunId: '20260729-identity-chain',
      },
    ],
  });
  const item = observation({
    sourceProjectId: source,
    school: '测试大学',
    officialUrl: 'https://cs.example.edu.cn/2026-camp',
    evidenceIds: ['identity-chain'],
  });

  assert.equal(
    resolveProjectIdentity(item, null, registry).canonicalProjectId,
    canonical,
  );
});

test('identity resolution rejects a transitive registry cycle', () => {
  const first = '2027|测试大学|计算机学院|夏令营';
  const second = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: first,
        canonicalProjectId: second,
        cycle: '2027',
        reason: '第一跳',
        introducedRunId: '20260729-identity-cycle',
      },
      {
        sourceProjectId: second,
        canonicalProjectId: first,
        cycle: '2027',
        reason: '错误回环',
        introducedRunId: '20260729-identity-cycle',
      },
    ],
    tombstones: [],
  });
  const item = observation({
    sourceProjectId: first,
    school: '测试大学',
    officialUrl: 'https://cs.example.edu.cn/2026-camp',
    evidenceIds: ['identity-cycle'],
  });

  assert.throws(
    () => resolveProjectIdentity(item, null, registry),
    /identity cycle/i,
  );
});

test('parent identity candidates use the same transitive resolver', () => {
  const source = '2027|测试大学|计算机学院|夏令营';
  const middle = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical =
    '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const url = 'https://cs.example.edu.cn/2026-camp';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: source,
        canonicalProjectId: middle,
        cycle: '2027',
        reason: '第一跳',
        introducedRunId: '20260729-parent-chain',
      },
      {
        sourceProjectId: middle,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '统一正式标题',
        introducedRunId: '20260729-parent-chain',
      },
    ],
    tombstones: [],
  });
  const item = observation({
    sourceProjectId: source,
    school: '测试大学',
    officialUrl: url,
    evidenceIds: ['parent-chain'],
  });

  assert.equal(
    resolveProjectIdentity(item, parent([opportunity(source, url)]), registry)
      .canonicalProjectId,
    canonical,
  );
});

test('identity-merged exclusions resolve their target transitively', () => {
  const source = '2027|测试大学|计算机学院|夏令营';
  const middle = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical =
    '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: middle,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '统一正式标题',
        introducedRunId: '20260729-exclusion-chain',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'identity-merged-chain',
        school: '测试大学',
        targetId: source,
        status: 'checked',
        evidenceIds: ['identity-merged-chain-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'identity-merged-chain-evidence',
        scopeItemId: 'identity-merged-chain',
        school: '测试大学',
        url: 'https://cs.example.edu.cn/2026-camp',
        result: 'checked',
      }),
    ],
    exclusions: [
      {
        sourceProjectId: source,
        action: 'identity-merged',
        targetProjectId: middle,
        reason: '旧标题并入正式项目',
        evidenceIds: ['identity-merged-chain-evidence'],
      },
    ],
  });

  const result = reduceScanRelease(input, null, registry, []);

  assert.equal(result.hardErrors.length, 0);
  assert.equal(result.lifecycle[0].canonicalProjectId, canonical);
});

test('an observation and exclusion converging on one canonical project fail closed', () => {
  const observed = '2027|测试大学|计算机学院|夏令营公告';
  const excluded = '2027|测试大学|计算机学院|已关闭夏令营公告';
  const middle = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical = '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: observed,
        canonicalProjectId: middle,
        cycle: '2027',
        reason: '当前标题简称',
        introducedRunId: '20260729-canonical-lifecycle',
      },
      {
        sourceProjectId: excluded,
        canonicalProjectId: middle,
        cycle: '2027',
        reason: '关闭公告标题简称',
        introducedRunId: '20260729-canonical-lifecycle',
      },
      {
        sourceProjectId: middle,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '统一正式标题',
        introducedRunId: '20260729-canonical-lifecycle',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'canonical-observation',
        school: '测试大学',
        targetId: observed,
        status: 'checked',
        evidenceIds: ['canonical-observation-evidence'],
      }),
      scope({
        scopeItemId: 'canonical-exclusion',
        school: '测试大学',
        targetId: excluded,
        status: 'checked',
        evidenceIds: ['canonical-exclusion-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'canonical-observation-evidence',
        scopeItemId: 'canonical-observation',
        school: '测试大学',
        url: 'https://cs.example.edu.cn/current-camp',
        result: 'hit',
      }),
      evidence({
        evidenceId: 'canonical-exclusion-evidence',
        scopeItemId: 'canonical-exclusion',
        school: '测试大学',
        url: 'https://cs.example.edu.cn/closed-camp',
        result: 'checked',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: observed,
        school: '测试大学',
        officialUrl: 'https://cs.example.edu.cn/current-camp',
        evidenceIds: ['canonical-observation-evidence'],
      }),
    ],
    exclusions: [
      {
        sourceProjectId: excluded,
        action: 'official-closed',
        reason: '官网明确活动已结束',
        evidenceIds: ['canonical-exclusion-evidence'],
      },
    ],
  });

  const result = reduceScanRelease(input, null, registry, []);

  assert.ok(
    result.hardErrors.some(
      ({ code }) => code === 'CANONICAL_PROJECT_LIFECYCLE_CONFLICT',
    ),
  );
});

test('two exclusions converging on one canonical project fail closed', () => {
  const first = '2027|测试大学|计算机学院|夏令营公告';
  const second = '2027|测试大学|计算机学院|关闭夏令营公告';
  const canonical = '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: first,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '标题一',
        introducedRunId: '20260729-canonical-exclusions',
      },
      {
        sourceProjectId: second,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '标题二',
        introducedRunId: '20260729-canonical-exclusions',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'first-exclusion',
        school: '测试大学',
        targetId: first,
        status: 'checked',
        evidenceIds: ['first-exclusion-evidence'],
      }),
      scope({
        scopeItemId: 'second-exclusion',
        school: '测试大学',
        targetId: second,
        status: 'checked',
        evidenceIds: ['second-exclusion-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'first-exclusion-evidence',
        scopeItemId: 'first-exclusion',
        school: '测试大学',
        url: 'https://cs.example.edu.cn/first-closed',
        result: 'checked',
      }),
      evidence({
        evidenceId: 'second-exclusion-evidence',
        scopeItemId: 'second-exclusion',
        school: '测试大学',
        url: 'https://cs.example.edu.cn/second-closed',
        result: 'checked',
      }),
    ],
    exclusions: [
      {
        sourceProjectId: first,
        action: 'official-closed',
        reason: '官网明确活动已结束',
        evidenceIds: ['first-exclusion-evidence'],
      },
      {
        sourceProjectId: second,
        action: 'official-closed',
        reason: '官网明确活动已结束',
        evidenceIds: ['second-exclusion-evidence'],
      },
    ],
  });

  const result = reduceScanRelease(input, null, registry, []);

  assert.ok(
    result.hardErrors.some(
      ({ code }) => code === 'CANONICAL_PROJECT_LIFECYCLE_CONFLICT',
    ),
  );
});

test('an exact parent project ID wins when multiple parent projects share one official URL', () => {
  const first = '2027|测试大学|计算机学院|推免预报名';
  const second = '2027|测试大学|人工智能学院|推免预报名';
  const sharedUrl = 'https://yz.example.edu.cn/2027-tuimian';
  const previous = parent([
    opportunity(first, sharedUrl),
    opportunity(second, sharedUrl),
  ]);
  const item = observation({
    sourceProjectId: second,
    school: '测试大学',
    officialUrl: sharedUrl,
    evidenceIds: ['shared-parent-url'],
  });

  assert.equal(
    resolveProjectIdentity(item, previous, emptyRegistry).canonicalProjectId,
    second,
  );
});

test('a new explicit project ID stays new when its official URL is shared by multiple parent projects', () => {
  const first = '2027|测试大学|计算机学院|推免预报名';
  const second = '2027|测试大学|人工智能学院|推免预报名';
  const newProject = '2027|测试大学|软件学院|推免预报名';
  const sharedUrl = 'https://yz.example.edu.cn/2027-tuimian';
  const previous = parent([
    opportunity(first, sharedUrl),
    opportunity(second, sharedUrl),
  ]);
  const item = observation({
    sourceProjectId: newProject,
    school: '测试大学',
    officialUrl: sharedUrl,
    evidenceIds: ['shared-new-project-url'],
  });

  assert.equal(
    resolveProjectIdentity(item, previous, emptyRegistry).canonicalProjectId,
    newProject,
  );
});

test('a unique parent URL cannot silently rename a different institute', () => {
  const parentProject = '2027|测试大学|计算机学院|推免预报名';
  const newProject = '2027|测试大学|软件学院|推免预报名';
  const sharedUrl = 'https://yz.example.edu.cn/2027-tuimian';
  const previous = parent([
    opportunity(parentProject, sharedUrl),
  ]);
  const item = observation({
    sourceProjectId: newProject,
    school: '测试大学',
    project: '软件学院推免预报名',
    officialUrl: sharedUrl,
    evidenceIds: ['unique-parent-url'],
  });

  assert.deepEqual(
    resolveProjectIdentity(item, previous, emptyRegistry),
    {
      sourceProjectId: newProject,
      canonicalProjectId: newProject,
      method: 'new-project-id',
    },
  );
});

test('an unreviewed new project sharing a parent institute URL is a hard error', () => {
  const parentProject = '2027|测试大学|计算机学院|推免预报名';
  const newProject = '2027|测试大学|计算机学院|2027推免预报名';
  const sharedUrl = 'https://cs.example.edu.cn/2027-tuimian';
  const previous = parent([
    opportunity(parentProject, sharedUrl),
  ]);
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'shared-url-project',
        school: '测试大学',
        targetId: newProject,
        status: 'checked',
        evidenceIds: ['shared-url-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'shared-url-evidence',
        scopeItemId: 'shared-url-project',
        school: '测试大学',
        url: sharedUrl,
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: newProject,
        school: '测试大学',
        officialUrl: sharedUrl,
        evidenceIds: ['shared-url-evidence'],
      }),
    ],
  });

  const result = reduceScanRelease(input, previous, emptyRegistry, []);

  assert.ok(
    result.hardErrors.some(
      ({ code }) => code === 'SHARED_OFFICIAL_URL_REQUIRES_IDENTITY_REVIEW',
    ),
  );
});

test('an explicit identity-registry alias may normalize an institution rename', () => {
  const source = '2027|测试学院|计算机学院|推免预报名';
  const canonical = '2027|测试大学|计算机学院|推免预报名';
  const officialUrl = 'https://yz.example.edu.cn/2027-tuimian';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [
      {
        url: officialUrl,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '教育部批准更名后的官方身份',
        introducedRunId: '20260729-alias-review',
      },
    ],
    projectAliases: [],
    tombstones: [],
  });
  const item = observation({
    sourceProjectId: source,
    school: '测试学院',
    officialUrl,
    evidenceIds: ['renamed-institution'],
  });

  assert.equal(
    resolveProjectIdentity(item, null, registry).canonicalProjectId,
    canonical,
  );
});

test('an identity merge disposes only its source and requires a target lifecycle', () => {
  const source =
    '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical =
    '2027|测试大学|计算机学院|2026优秀大学生夏令营';
  const url = 'https://cs.example.edu.cn/2026-camp';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: source,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '同一官方项目的标题差异',
        introducedRunId: '20260729-identity-target',
      },
    ],
    tombstones: [
      {
        projectId: source,
        mergedInto: canonical,
        cycle: '2027',
        reason: '同一官方项目的标题差异',
        introducedRunId: '20260729-identity-target',
      },
    ],
  });
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'identity-target',
        school: '测试大学',
        targetId: canonical,
        status: 'checked',
        evidenceIds: ['identity-target-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'identity-target-evidence',
        scopeItemId: 'identity-target',
        school: '测试大学',
        url,
        result: 'checked',
      }),
    ],
    exclusions: [
      {
        sourceProjectId: source,
        targetProjectId: canonical,
        action: 'identity-merged',
        reason: 'merge duplicate source identity',
        evidenceIds: ['identity-target-evidence'],
      },
    ],
  });

  const result = reduceScanRelease(
    input,
    parent([
      opportunity(source, url),
      opportunity(canonical, url),
    ]),
    registry,
    [],
  );

  assert.ok(
    result.hardErrors.some(
      ({ code, message }) => (
        code === 'UNACCOUNTED_PARENT_ACTIVE'
        && message.includes(canonical)
      ),
    ),
  );
});

test('blocked evidence for a previous active project becomes pending, never an unexplained removal', () => {
  const projectId = '2027|测试大学|计算机学院|推免预报名';
  const previous = parent([
    opportunity(projectId, 'https://cs.example.edu/admissions/2027'),
  ]);
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'parent-project',
        school: '测试大学',
        targetId: projectId,
        status: 'blocked',
        evidenceIds: ['parent-blocked'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'parent-blocked',
        scopeItemId: 'parent-project',
        school: '测试大学',
        url: 'https://cs.example.edu/admissions/2027',
        result: 'blocked',
      }),
    ],
    pendingUpdates: [
      {
        ledgerId: `project:${projectId}`,
        outcome: 'pending',
        checkedAt: '2026-07-29T00:30:00.000Z',
        evidenceIds: ['parent-blocked'],
        reason: '父项目官网本轮受阻',
        scopeItemId: 'parent-project',
        school: '测试大学',
        region: '华北',
        targetId: projectId,
        officialUrls: ['https://cs.example.edu/admissions/2027'],
        nextAction: '下一轮复核项目官网',
        projectId,
      },
    ],
  });

  const result = reduceScanRelease(input, previous, emptyRegistry, []);
  assert.equal(result.hardErrors.length, 0);
  assert.deepEqual(
    result.lifecycle.map(({ canonicalProjectId, state }) => ({ canonicalProjectId, state })),
    [{ canonicalProjectId: projectId, state: 'pending' }],
  );
  assert.equal(result.metrics.unaccountedParentActive, 0);
});

test('a blocked scope targeting an alias hop marks the canonical parent pending', () => {
  const source = '2027|测试大学|计算机学院|夏令营';
  const middle = '2027|测试大学|计算机学院|优秀大学生夏令营';
  const canonical = '2027|测试大学|计算机学院|2026全国优秀大学生夏令营';
  const url = 'https://cs.example.edu.cn/admissions/2027';
  const registry = parseIdentityRegistry({
    schemaVersion: 2,
    urlAliases: [],
    projectAliases: [
      {
        sourceProjectId: source,
        canonicalProjectId: middle,
        cycle: '2027',
        reason: '历史标题',
        introducedRunId: '20260729-parent-scope-chain',
      },
      {
        sourceProjectId: middle,
        canonicalProjectId: canonical,
        cycle: '2027',
        reason: '统一正式标题',
        introducedRunId: '20260729-parent-scope-chain',
      },
    ],
    tombstones: [],
  });
  const input = bundle({
    scanMode: 'incremental',
    scopeItems: [
      scope({
        scopeItemId: 'parent-middle-blocked',
        school: '测试大学',
        targetId: middle,
        status: 'blocked',
        evidenceIds: ['parent-middle-blocked-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'parent-middle-blocked-evidence',
        scopeItemId: 'parent-middle-blocked',
        school: '测试大学',
        url,
        result: 'blocked',
      }),
    ],
    pendingUpdates: [
      {
        ledgerId: `project:${middle}`,
        outcome: 'pending',
        checkedAt: '2026-07-29T00:30:00.000Z',
        evidenceIds: ['parent-middle-blocked-evidence'],
        reason: '项目官网入口受阻',
        scopeItemId: 'parent-middle-blocked',
        school: '测试大学',
        region: '华北',
        targetId: middle,
        officialUrls: [url],
        nextAction: '下一轮复核项目官网',
        projectId: middle,
      },
    ],
  });

  const result = reduceScanRelease(input, parent([opportunity(source, url)]), registry, []);

  assert.equal(result.hardErrors.length, 0);
  assert.deepEqual(
    result.lifecycle.map(({ canonicalProjectId, state }) => ({ canonicalProjectId, state })),
    [{ canonicalProjectId: canonical, state: 'pending' }],
  );
  assert.deepEqual(
    result.pending.map(({ ledgerId, targetId, projectId }) => ({ ledgerId, targetId, projectId })),
    [{ ledgerId: `project:${canonical}`, targetId: canonical, projectId: canonical }],
  );
  assert.equal(result.metrics.carriedParentActive, 0);
});

test('a pending scope without a matching current-run ledger update is a hard error', () => {
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'blocked-scope',
        school: '测试大学',
        targetId: 'blocked-college',
        status: 'blocked',
        evidenceIds: ['blocked-evidence'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'blocked-evidence',
        scopeItemId: 'blocked-scope',
        school: '测试大学',
        url: 'https://cs.example.edu/admissions',
        result: 'blocked',
      }),
    ],
  });
  const result = reduceScanRelease(input, null, emptyRegistry, []);
  assert.deepEqual(result.hardErrors, [
    {
      code: 'PENDING_SCOPE_WITHOUT_LEDGER_UPDATE',
      evidenceIds: ['blocked-evidence'],
      message: 'pending scope blocked-scope has no matching current-run ledger update',
    },
  ]);
});

test('duplicate pending ledger identities fail deterministically instead of choosing the first scope', () => {
  const projectId = '2027|测试大学|计算机学院|推免预报名';
  const scopeItems = [
    scope({
      scopeItemId: 'blocked-a',
      school: '测试大学',
      targetId: projectId,
      status: 'blocked',
      evidenceIds: ['blocked-a-evidence'],
    }),
    scope({
      scopeItemId: 'blocked-b',
      school: '测试大学',
      targetId: projectId,
      status: 'blocked',
      evidenceIds: ['blocked-b-evidence'],
    }),
  ];
  const evidenceRecords = [
    evidence({
      evidenceId: 'blocked-a-evidence',
      scopeItemId: 'blocked-a',
      school: '测试大学',
      url: 'https://cs.example.edu/admissions/a',
      result: 'blocked',
    }),
    evidence({
      evidenceId: 'blocked-b-evidence',
      scopeItemId: 'blocked-b',
      school: '测试大学',
      url: 'https://cs.example.edu/admissions/b',
      result: 'blocked',
    }),
  ];
  const pendingUpdates = [
    {
      ledgerId: `project:${projectId}`,
      outcome: 'pending',
      checkedAt: '2026-07-29T00:30:00.000Z',
      evidenceIds: ['blocked-a-evidence'],
      reason: '项目入口 A 受阻',
      scopeItemId: 'blocked-a',
      school: '测试大学',
      region: '华北',
      targetId: projectId,
      officialUrls: ['https://cs.example.edu/admissions/a'],
      nextAction: '下一轮复核',
      projectId,
    },
  ];
  const forward = reduceScanRelease(
    bundle({ scopeItems, evidenceRecords, pendingUpdates }),
    null,
    emptyRegistry,
    [],
  );
  const reverse = reduceScanRelease(
    bundle({
      scopeItems: [...scopeItems].reverse(),
      evidenceRecords: [...evidenceRecords].reverse(),
      pendingUpdates,
    }),
    null,
    emptyRegistry,
    [],
  );

  assert.deepEqual(reverse.hardErrors, forward.hardErrors);
  assert.ok(
    forward.hardErrors.some(
      ({ code }) => code === 'DUPLICATE_PENDING_LEDGER_IDENTITY',
    ),
  );
});

test('an unknown-registration project requires an exact project pending update', () => {
  const projectId = '2027|测试大学|计算机学院|推免预报名';
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'unknown-registration',
        school: '测试大学',
        targetId: projectId,
        status: 'checked',
        evidenceIds: ['unknown-registration-hit'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'unknown-registration-hit',
        scopeItemId: 'unknown-registration',
        school: '测试大学',
        url: 'https://cs.example.edu/admissions/2027',
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: projectId,
        school: '测试大学',
        officialUrl: 'https://cs.example.edu/admissions/2027',
        evidenceIds: ['unknown-registration-hit'],
        registrationState: 'unknown',
      }),
    ],
  });

  const result = reduceScanRelease(input, null, emptyRegistry, []);
  assert.deepEqual(result.hardErrors, [
    {
      code: 'PENDING_SCOPE_WITHOUT_LEDGER_UPDATE',
      evidenceIds: ['unknown-registration-hit'],
      message:
        'pending scope unknown-registration has no matching current-run ledger update',
    },
  ]);
});

test('an unknown-registration project is bound to its project pending identity', () => {
  const projectId = '2027|测试大学|计算机学院|推免预报名';
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'unknown-registration',
        school: '测试大学',
        targetId: projectId,
        status: 'checked',
        evidenceIds: ['unknown-registration-hit'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'unknown-registration-hit',
        scopeItemId: 'unknown-registration',
        school: '测试大学',
        url: 'https://cs.example.edu/admissions/2027',
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: projectId,
        school: '测试大学',
        officialUrl: 'https://cs.example.edu/admissions/2027',
        evidenceIds: ['unknown-registration-hit'],
        registrationState: 'unknown',
      }),
    ],
    pendingUpdates: [
      {
        ledgerId: `project:${projectId}`,
        outcome: 'pending',
        checkedAt: '2026-07-29T00:30:00.000Z',
        evidenceIds: ['unknown-registration-hit'],
        reason: '官网未明确报名是否已开放',
        scopeItemId: 'unknown-registration',
        school: '测试大学',
        region: '华北',
        targetId: projectId,
        officialUrls: ['https://cs.example.edu/admissions/2027'],
        nextAction: '下一轮复核官网报名状态',
        projectId,
      },
    ],
  });

  const result = reduceScanRelease(input, null, emptyRegistry, []);
  assert.equal(result.hardErrors.length, 0);
  assert.deepEqual(result.pending, [
    {
      ledgerId: `project:${projectId}`,
      scopeItemId: 'unknown-registration',
      school: '测试大学',
      region: '华北',
      targetId: projectId,
      officialUrls: ['https://cs.example.edu/admissions/2027'],
      nextAction: '下一轮复核官网报名状态',
      projectId,
      reason: '官网未明确报名是否已开放',
      evidenceIds: ['unknown-registration-hit'],
      checkedAt: '2026-07-29T00:30:00.000Z',
    },
  ]);
});

test('a previously pending identity remains in the projection after a pending recheck', () => {
  const ledgerId = 'legacy-clue:stable-id';
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'legacy-recheck',
        school: '测试大学',
        targetId: '测试大学|unknown',
        status: 'checked',
        evidenceIds: ['legacy-recheck-evidence'],
        kind: 'pending',
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'legacy-recheck-evidence',
        scopeItemId: 'legacy-recheck',
        school: '测试大学',
        url: 'https://yz.example.edu/recheck',
        result: 'checked',
      }),
    ],
    pendingUpdates: [
      {
        ledgerId,
        outcome: 'pending',
        checkedAt: '2026-07-29T00:30:00.000Z',
        evidenceIds: ['legacy-recheck-evidence'],
        reason: '官方入口仍无法唯一归属到具体项目',
        scopeItemId: 'legacy-recheck',
        school: '测试大学',
        region: '华北',
        targetId: '测试大学|unknown',
        officialUrls: ['https://yz.example.edu/recheck'],
        nextAction: '下一轮继续复核项目归属',
      },
    ],
  });

  const result = reduceScanRelease(
    input,
    null,
    emptyRegistry,
    [{ ledgerId, scopeItemId: 'previous-scope' }],
  );
  assert.equal(result.hardErrors.length, 0);
  assert.deepEqual(result.pending, [
    {
      ledgerId,
      scopeItemId: 'legacy-recheck',
      school: '测试大学',
      region: '华北',
      targetId: '测试大学|unknown',
      officialUrls: ['https://yz.example.edu/recheck'],
      nextAction: '下一轮继续复核项目归属',
      reason: '官方入口仍无法唯一归属到具体项目',
      evidenceIds: ['legacy-recheck-evidence'],
      checkedAt: '2026-07-29T00:30:00.000Z',
    },
  ]);
});

test('an unrelated same-school observation cannot cover an orphan hit', () => {
  const input = bundle({
    scopeItems: [
      scope({
        scopeItemId: 'target-project',
        school: '测试大学',
        targetId: '2027|测试大学|计算机学院|推免预报名',
        status: 'checked',
        evidenceIds: ['orphan-hit'],
      }),
      scope({
        scopeItemId: 'other-project',
        school: '测试大学',
        targetId: '2027|测试大学|软件学院|推免预报名',
        status: 'checked',
        evidenceIds: ['other-hit'],
      }),
    ],
    evidenceRecords: [
      evidence({
        evidenceId: 'orphan-hit',
        scopeItemId: 'target-project',
        school: '测试大学',
        url: 'https://cs.example.edu/admissions/2027',
        result: 'hit',
      }),
      evidence({
        evidenceId: 'other-hit',
        scopeItemId: 'other-project',
        school: '测试大学',
        url: 'https://se.example.edu/admissions/2027',
        result: 'hit',
      }),
    ],
    projectObservations: [
      observation({
        sourceProjectId: '2027|测试大学|软件学院|推免预报名',
        school: '测试大学',
        officialUrl: 'https://se.example.edu/admissions/2027',
        evidenceIds: ['other-hit'],
      }),
    ],
  });

  const result = reduceScanRelease(input, null, emptyRegistry, []);
  assert.deepEqual(result.hardErrors, [
    {
      code: 'HIT_WITHOUT_PROJECT_DISPOSITION',
      evidenceIds: ['orphan-hit'],
      message: 'readable hit orphan-hit is not bound to a project observation',
    },
  ]);
  assert.equal(
    result.evidenceDispositions.find((item) => item.evidenceId === 'orphan-hit')?.kind,
    'hard-error',
  );
});

test('incremental mode explicitly carries untouched parent active projects', () => {
  const projectId = '2027|测试大学|计算机学院|推免预报名';
  const previous = parent([
    opportunity(projectId, 'https://cs.example.edu/admissions/2027'),
  ]);
  const input = bundle({
    scanMode: 'incremental',
    scopeItems: [],
    evidenceRecords: [],
  });

  const result = reduceScanRelease(input, previous, emptyRegistry, []);
  assert.equal(result.hardErrors.length, 0);
  assert.deepEqual(
    result.lifecycle.map(({ canonicalProjectId, state }) => ({ canonicalProjectId, state })),
    [{ canonicalProjectId: projectId, state: 'carried-active' }],
  );
  assert.equal(result.metrics.carriedParentActive, 1);
  assert.equal(result.metrics.unaccountedParentActive, 0);
});
