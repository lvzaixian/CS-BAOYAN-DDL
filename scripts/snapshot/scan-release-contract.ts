type JsonObject = Record<string, unknown>;

export type ScanMode = 'full' | 'incremental';
export type EvidenceResult = 'checked' | 'hit' | 'no-current-notice' | 'blocked';
export type OfficialSurfaceKind =
  | 'graduate-admissions'
  | 'college-notice'
  | 'application-system'
  | 'official-account'
  | 'attachment'
  | 'other-official';
export type RegistrationState = 'open' | 'closed' | 'unknown';
export type ScopeKind =
  | 'registry'
  | 'sentinel'
  | 'urgent-72h'
  | 'unknown-deadline'
  | 'new'
  | 'changed'
  | 'removed'
  | 'pending'
  | 'discovered-child';
export type ScopeStatus = 'checked' | 'no-current-notice' | 'blocked' | 'not-applicable';

export interface CandidateBase {
  type: 'public-approved-snapshot';
  url: 'https://ddl.meta-mind.cn/data/current.json';
  sha256: string;
  snapshotId: string;
  dataHash: string;
  privateParentCandidateUsed: false;
}

export interface RunMessage {
  code: string;
  message: string;
  evidenceIds: string[];
}

export interface DiscoverySourceCheck {
  name: '保研通知网' | 'CS-BAOYAN DDL' | 'BoardCaster';
  url: string;
  status: 'checked' | 'blocked';
  pagesChecked: number;
  checkedAt: string;
  artifactSha256?: string;
  error?: string;
}

export interface ScopeItem {
  scopeItemId: string;
  kind: ScopeKind;
  school: string;
  targetId: string;
  status: ScopeStatus;
  evidenceIds: string[];
  reason?: string;
}

export interface EvidenceRecord {
  evidenceId: string;
  scopeItemId: string;
  school: string;
  region: string;
  kind: OfficialSurfaceKind;
  url: string;
  result: EvidenceResult;
  checkedAt: string;
  artifactSha256?: string;
  error?: string;
  query: string;
  discoveredScopeItemIds: string[];
}

export interface ProjectObservation {
  observationId: string;
  sourceProjectId: string;
  cycle: string;
  school: string;
  project: string;
  eventType: string;
  registrationState: RegistrationState;
  deadline: string | null;
  deadlineOriginal: string;
  eventMode: 'online' | 'offline' | 'hybrid' | 'unknown';
  eventTime: string;
  formatLocation: string;
  accommodation: string;
  meals: string;
  transport: string;
  reimbursement: string;
  recommendationLetters: string;
  recommendationTemplate: string;
  materialComplexity: string;
  materialList: string;
  officialUrl: string;
  baoyanNoticeUrl?: string;
  evidenceIds: string[];
}

export interface PendingUpdate {
  ledgerId: string;
  outcome: 'pending' | 'promoted-active' | 'expired' | 'rejected' | 'hard-error';
  checkedAt: string;
  evidenceIds: string[];
  reason: string;
  scopeItemId: string;
  school: string;
  region: string;
  targetId: string;
  officialUrls: string[];
  nextAction: string;
  projectId?: string;
}

export interface ProjectExclusion {
  sourceProjectId: string;
  action:
    | 'submitted-excluded'
    | 'out-of-scope'
    | 'identity-merged'
    | 'official-closed'
    | 'data-correction';
  reason: string;
  evidenceIds: string[];
  targetProjectId?: string;
}

export interface ScanBundle {
  schemaVersion: 2;
  runId: string;
  scanMode: ScanMode;
  scanStartedAt: string;
  scanFinishedAt: string;
  candidateBase: CandidateBase;
  registry: {
    sha256: string;
    institutionCount: number;
  };
  pendingLedger: {
    generation: number;
    sha256: string;
  };
  errors: RunMessage[];
  warnings: RunMessage[];
  discoverySourceChecks: DiscoverySourceCheck[];
  scopeItems: ScopeItem[];
  evidenceRecords: EvidenceRecord[];
  projectObservations: ProjectObservation[];
  pendingUpdates: PendingUpdate[];
  exclusions: ProjectExclusion[];
}

export interface UrlAlias {
  url: string;
  canonicalProjectId: string;
  cycle: string;
  reason: string;
  introducedRunId: string;
}

export interface ProjectAlias {
  sourceProjectId: string;
  canonicalProjectId: string;
  cycle: string;
  reason: string;
  introducedRunId: string;
}

export interface ProjectTombstone {
  projectId: string;
  mergedInto: string;
  cycle: string;
  reason: string;
  introducedRunId: string;
}

export interface ProjectIdentityRegistry {
  schemaVersion: 2;
  urlAliases: UrlAlias[];
  projectAliases: ProjectAlias[];
  tombstones: ProjectTombstone[];
}

const sha256Pattern = /^[a-f0-9]{64}$/i;
const projectIdPattern = /^\d{4}\|[^|]+\|[^|]+\|[^|]+$/u;
const deniedOfficialHosts = [
  'baoyantongzhi.com',
  'csbaoyan.top',
  'boardcaster.net',
  'github.com',
  'bing.com',
  'baidu.com',
  'google.com',
];
const discoveryHosts = new Map([
  ['保研通知网', new Set(['baoyantongzhi.com', 'www.baoyantongzhi.com'])],
  [
    'CS-BAOYAN DDL',
    new Set(['ddl.csbaoyan.top', 'csbaoyan.top', 'www.csbaoyan.top']),
  ],
  ['BoardCaster', new Set(['boardcaster.net', 'www.boardcaster.net'])],
]);

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
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in object)) throw new Error(`${path}.${key} is required`);
  }
}

function stringAt(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function stringArrayAt(object: JsonObject, key: string, path: string): string[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${path}.${key} must be an array`);
  const strings = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${path}.${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${path}.${key} must not contain duplicates`);
  }
  return strings;
}

function integerAt(object: JsonObject, key: string, path: string, minimum = 0): number {
  const value = object[key];
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${path}.${key} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function enumAt<T extends string>(
  object: JsonObject,
  key: string,
  path: string,
  values: readonly T[],
): T {
  const value = object[key];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${path}.${key} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function timestampAt(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${path}.${key} must be a valid timestamp`);
  }
  return value;
}

function digestAt(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path);
  if (!sha256Pattern.test(value)) throw new Error(`${path}.${key} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function projectIdAt(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path);
  if (!projectIdPattern.test(value)) {
    throw new Error(`${path}.${key} must use cycle|school|institute|round`);
  }
  return value;
}

function urlAt(object: JsonObject, key: string, path: string): string {
  const value = stringAt(object, key, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path}.${key} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${path}.${key} must be a credential-free HTTP(S) URL`);
  }
  return value;
}

function isDeniedOfficialHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return deniedOfficialHosts.some(
    (host) => normalized === host || normalized.endsWith(`.${host}`),
  );
}

function arrayAt<T>(
  object: JsonObject,
  key: string,
  path: string,
  parser: (value: unknown, path: string) => T,
): T[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${path}.${key} must be an array`);
  return value.map((item, index) => parser(item, `${key}[${index}]`));
}

function parseRunMessage(value: unknown, path: string): RunMessage {
  const object = objectAt(value, path);
  exactKeys(object, path, ['code', 'message', 'evidenceIds']);
  return {
    code: stringAt(object, 'code', path),
    message: stringAt(object, 'message', path),
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
  };
}

function parseDiscoverySourceCheck(value: unknown, path: string): DiscoverySourceCheck {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    ['name', 'url', 'status', 'pagesChecked', 'checkedAt'],
    ['artifactSha256', 'error'],
  );
  const name = enumAt(
    object,
    'name',
    path,
    ['保研通知网', 'CS-BAOYAN DDL', 'BoardCaster'] as const,
  );
  const url = urlAt(object, 'url', path);
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/u, '');
  if (!discoveryHosts.get(name)?.has(hostname)) {
    throw new Error(`${path}.url does not match ${name}`);
  }
  const status = enumAt(object, 'status', path, ['checked', 'blocked'] as const);
  const pagesChecked = integerAt(object, 'pagesChecked', path);
  const checkedAt = timestampAt(object, 'checkedAt', path);
  const artifactSha256 =
    object.artifactSha256 === undefined ? undefined : digestAt(object, 'artifactSha256', path);
  const error = object.error === undefined ? undefined : stringAt(object, 'error', path);
  if (status === 'checked') {
    if (pagesChecked < 1) throw new Error(`${path}.pagesChecked must be >= 1 when checked`);
    if (artifactSha256 === undefined) {
      throw new Error(`${path}.artifactSha256 is required when checked`);
    }
    if (error !== undefined) throw new Error(`${path}.error is not allowed when checked`);
  } else if (error === undefined) {
    throw new Error(`${path}.error is required when blocked`);
  }
  return {
    name,
    url,
    status,
    pagesChecked,
    checkedAt,
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseScopeItem(value: unknown, path: string): ScopeItem {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    ['scopeItemId', 'kind', 'school', 'targetId', 'status', 'evidenceIds'],
    ['reason'],
  );
  const status = enumAt(
    object,
    'status',
    path,
    ['checked', 'no-current-notice', 'blocked', 'not-applicable'] as const,
  );
  const reason = object.reason === undefined ? undefined : stringAt(object, 'reason', path);
  if (status === 'not-applicable' && reason === undefined) {
    throw new Error(`${path}.reason is required when not-applicable`);
  }
  return {
    scopeItemId: stringAt(object, 'scopeItemId', path),
    kind: enumAt(
      object,
      'kind',
      path,
      [
        'registry',
        'sentinel',
        'urgent-72h',
        'unknown-deadline',
        'new',
        'changed',
        'removed',
        'pending',
        'discovered-child',
      ] as const,
    ),
    school: stringAt(object, 'school', path),
    targetId: stringAt(object, 'targetId', path),
    status,
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseEvidenceRecord(value: unknown, path: string): EvidenceRecord {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    [
      'evidenceId',
      'scopeItemId',
      'school',
      'region',
      'kind',
      'url',
      'result',
      'checkedAt',
      'query',
      'discoveredScopeItemIds',
    ],
    ['artifactSha256', 'error'],
  );
  const url = urlAt(object, 'url', path);
  if (isDeniedOfficialHost(new URL(url).hostname)) {
    throw new Error(`${path}.url must be an official source, not a discovery/search host`);
  }
  const result = enumAt(
    object,
    'result',
    path,
    ['checked', 'hit', 'no-current-notice', 'blocked'] as const,
  );
  const artifactSha256 =
    object.artifactSha256 === undefined ? undefined : digestAt(object, 'artifactSha256', path);
  const error = object.error === undefined ? undefined : stringAt(object, 'error', path);
  if (result === 'blocked') {
    if (error === undefined) {
      throw new Error(`${path}.error is required for blocked evidence`);
    }
    if (artifactSha256 !== undefined) {
      throw new Error(`${path}.artifactSha256 is not allowed for blocked evidence`);
    }
  } else {
    if (artifactSha256 === undefined) {
      throw new Error(`${path}.artifactSha256 is required for readable evidence`);
    }
    if (error !== undefined) throw new Error(`${path}.error is not allowed for readable evidence`);
  }
  return {
    evidenceId: stringAt(object, 'evidenceId', path),
    scopeItemId: stringAt(object, 'scopeItemId', path),
    school: stringAt(object, 'school', path),
    region: stringAt(object, 'region', path),
    kind: enumAt(
      object,
      'kind',
      path,
      [
        'graduate-admissions',
        'college-notice',
        'application-system',
        'official-account',
        'attachment',
        'other-official',
      ] as const,
    ),
    url,
    result,
    checkedAt: timestampAt(object, 'checkedAt', path),
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
    ...(error === undefined ? {} : { error }),
    query: stringAt(object, 'query', path),
    discoveredScopeItemIds: stringArrayAt(object, 'discoveredScopeItemIds', path),
  };
}

function nullableTimestampAt(object: JsonObject, key: string, path: string): string | null {
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${path}.${key} must be null or a valid timestamp`);
  }
  return value;
}

function normalizeComparableUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString();
}

function parseProjectObservation(value: unknown, path: string): ProjectObservation {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    [
      'observationId',
      'sourceProjectId',
      'cycle',
      'school',
      'project',
      'eventType',
      'registrationState',
      'deadline',
      'deadlineOriginal',
      'eventMode',
      'eventTime',
      'formatLocation',
      'accommodation',
      'meals',
      'transport',
      'reimbursement',
      'recommendationLetters',
      'recommendationTemplate',
      'materialComplexity',
      'materialList',
      'officialUrl',
      'evidenceIds',
    ],
    ['baoyanNoticeUrl'],
  );
  const sourceProjectId = projectIdAt(object, 'sourceProjectId', path);
  const cycle = stringAt(object, 'cycle', path);
  if (!/^\d{4}$/u.test(cycle) || !sourceProjectId.startsWith(`${cycle}|`)) {
    throw new Error(`${path}.cycle must match sourceProjectId`);
  }
  const officialUrl = urlAt(object, 'officialUrl', path);
  if (isDeniedOfficialHost(new URL(officialUrl).hostname)) {
    throw new Error(`${path}.officialUrl must be an official source`);
  }
  const baoyanNoticeUrl =
    object.baoyanNoticeUrl === undefined ? undefined : urlAt(object, 'baoyanNoticeUrl', path);
  const evidenceIds = stringArrayAt(object, 'evidenceIds', path);
  if (evidenceIds.length === 0) {
    throw new Error(`${path}.evidenceIds must not be empty`);
  }
  return {
    observationId: stringAt(object, 'observationId', path),
    sourceProjectId,
    cycle,
    school: stringAt(object, 'school', path),
    project: stringAt(object, 'project', path),
    eventType: stringAt(object, 'eventType', path),
    registrationState: enumAt(
      object,
      'registrationState',
      path,
      ['open', 'closed', 'unknown'] as const,
    ),
    deadline: nullableTimestampAt(object, 'deadline', path),
    deadlineOriginal: stringAt(object, 'deadlineOriginal', path),
    eventMode: enumAt(
      object,
      'eventMode',
      path,
      ['online', 'offline', 'hybrid', 'unknown'] as const,
    ),
    eventTime: stringAt(object, 'eventTime', path),
    formatLocation: stringAt(object, 'formatLocation', path),
    accommodation: stringAt(object, 'accommodation', path),
    meals: stringAt(object, 'meals', path),
    transport: stringAt(object, 'transport', path),
    reimbursement: stringAt(object, 'reimbursement', path),
    recommendationLetters: stringAt(object, 'recommendationLetters', path),
    recommendationTemplate: stringAt(object, 'recommendationTemplate', path),
    materialComplexity: stringAt(object, 'materialComplexity', path),
    materialList: stringAt(object, 'materialList', path),
    officialUrl,
    ...(baoyanNoticeUrl === undefined ? {} : { baoyanNoticeUrl }),
    evidenceIds,
  };
}

function parsePendingUpdate(value: unknown, path: string): PendingUpdate {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    [
      'ledgerId',
      'outcome',
      'checkedAt',
      'evidenceIds',
      'reason',
      'scopeItemId',
      'school',
      'region',
      'targetId',
      'officialUrls',
      'nextAction',
    ],
    ['projectId'],
  );
  const projectId =
    object.projectId === undefined ? undefined : projectIdAt(object, 'projectId', path);
  const officialUrls = stringArrayAt(object, 'officialUrls', path);
  if (officialUrls.length === 0) {
    throw new Error(`${path}.officialUrls must not be empty`);
  }
  for (const [index, value] of officialUrls.entries()) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${path}.officialUrls[${index}] must be a valid HTTP(S) URL`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error(`${path}.officialUrls[${index}] must be a credential-free HTTP(S) URL`);
    }
    if (isDeniedOfficialHost(url.hostname)) {
      throw new Error(`${path}.officialUrls[${index}] must be an official source`);
    }
  }
  return {
    ledgerId: stringAt(object, 'ledgerId', path),
    outcome: enumAt(
      object,
      'outcome',
      path,
      ['pending', 'promoted-active', 'expired', 'rejected', 'hard-error'] as const,
    ),
    checkedAt: timestampAt(object, 'checkedAt', path),
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
    reason: stringAt(object, 'reason', path),
    scopeItemId: stringAt(object, 'scopeItemId', path),
    school: stringAt(object, 'school', path),
    region: stringAt(object, 'region', path),
    targetId: stringAt(object, 'targetId', path),
    officialUrls,
    nextAction: stringAt(object, 'nextAction', path),
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function parseExclusion(value: unknown, path: string): ProjectExclusion {
  const object = objectAt(value, path);
  exactKeys(
    object,
    path,
    ['sourceProjectId', 'action', 'reason', 'evidenceIds'],
    ['targetProjectId'],
  );
  const action = enumAt(
    object,
    'action',
    path,
    [
      'submitted-excluded',
      'out-of-scope',
      'identity-merged',
      'official-closed',
      'data-correction',
    ] as const,
  );
  const targetProjectId =
    object.targetProjectId === undefined
      ? undefined
      : projectIdAt(object, 'targetProjectId', path);
  if (action === 'identity-merged' && targetProjectId === undefined) {
    throw new Error(`${path}.targetProjectId is required for identity-merged`);
  }
  if (action !== 'identity-merged' && targetProjectId !== undefined) {
    throw new Error(`${path}.targetProjectId is only allowed for identity-merged`);
  }
  return {
    sourceProjectId: projectIdAt(object, 'sourceProjectId', path),
    action,
    reason: stringAt(object, 'reason', path),
    evidenceIds: stringArrayAt(object, 'evidenceIds', path),
    ...(targetProjectId === undefined ? {} : { targetProjectId }),
  };
}

function uniqueBy<T>(values: T[], key: (value: T) => string, path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const current = key(value);
    if (seen.has(current)) throw new Error(`${path} contains duplicate ${current}`);
    seen.add(current);
  }
}

function withinRun(timestamp: string, startMs: number, finishMs: number, path: string): void {
  const value = Date.parse(timestamp);
  if (value < startMs || value > finishMs) {
    throw new Error(`${path} must belong to the scan run`);
  }
}

export function parseScanBundle(input: unknown): ScanBundle {
  const object = objectAt(input, 'scan bundle');
  exactKeys(object, 'scan bundle', [
    'schemaVersion',
    'runId',
    'scanMode',
    'scanStartedAt',
    'scanFinishedAt',
    'candidateBase',
    'registry',
    'pendingLedger',
    'errors',
    'warnings',
    'discoverySourceChecks',
    'scopeItems',
    'evidenceRecords',
    'projectObservations',
    'pendingUpdates',
    'exclusions',
  ]);
  if (object.schemaVersion !== 2) throw new Error('scan bundle.schemaVersion must be exactly 2');
  const scanStartedAt = timestampAt(object, 'scanStartedAt', 'scan bundle');
  const scanFinishedAt = timestampAt(object, 'scanFinishedAt', 'scan bundle');
  const startMs = Date.parse(scanStartedAt);
  const finishMs = Date.parse(scanFinishedAt);
  if (finishMs < startMs) throw new Error('scan bundle run window is invalid');

  const candidateObject = objectAt(object.candidateBase, 'candidateBase');
  exactKeys(candidateObject, 'candidateBase', [
    'type',
    'url',
    'sha256',
    'snapshotId',
    'dataHash',
    'privateParentCandidateUsed',
  ]);
  if (candidateObject.type !== 'public-approved-snapshot') {
    throw new Error('candidateBase.type must be public-approved-snapshot');
  }
  if (candidateObject.url !== 'https://ddl.meta-mind.cn/data/current.json') {
    throw new Error('candidateBase.url must be the public approved snapshot URL');
  }
  if (candidateObject.privateParentCandidateUsed !== false) {
    throw new Error('candidateBase.privateParentCandidateUsed must be false');
  }

  const registryObject = objectAt(object.registry, 'registry');
  exactKeys(registryObject, 'registry', ['sha256', 'institutionCount']);
  const pendingObject = objectAt(object.pendingLedger, 'pendingLedger');
  exactKeys(pendingObject, 'pendingLedger', ['generation', 'sha256']);

  const discoverySourceChecks = arrayAt(
    object,
    'discoverySourceChecks',
    'scan bundle',
    parseDiscoverySourceCheck,
  );
  const scopeItems = arrayAt(object, 'scopeItems', 'scan bundle', parseScopeItem);
  const evidenceRecords = arrayAt(
    object,
    'evidenceRecords',
    'scan bundle',
    parseEvidenceRecord,
  );
  const projectObservations = arrayAt(
    object,
    'projectObservations',
    'scan bundle',
    parseProjectObservation,
  );
  const pendingUpdates = arrayAt(
    object,
    'pendingUpdates',
    'scan bundle',
    parsePendingUpdate,
  );
  const exclusions = arrayAt(object, 'exclusions', 'scan bundle', parseExclusion);
  const errors = arrayAt(object, 'errors', 'scan bundle', parseRunMessage);
  const warnings = arrayAt(object, 'warnings', 'scan bundle', parseRunMessage);

  uniqueBy(discoverySourceChecks, (check) => check.name, 'discoverySourceChecks');
  for (const name of ['保研通知网', 'CS-BAOYAN DDL', 'BoardCaster'] as const) {
    if (!discoverySourceChecks.some((check) => check.name === name)) {
      throw new Error(`discoverySourceChecks is missing ${name}`);
    }
  }
  uniqueBy(scopeItems, (item) => item.scopeItemId, 'scopeItems');
  uniqueBy(evidenceRecords, (record) => record.evidenceId, 'evidenceRecords');
  uniqueBy(projectObservations, (item) => item.observationId, 'projectObservations');
  uniqueBy(pendingUpdates, (item) => item.ledgerId, 'pendingUpdates');
  uniqueBy(exclusions, (item) => item.sourceProjectId, 'exclusions');

  const scopeIndexById = new Map(
    scopeItems.map((item, index) => [item.scopeItemId, index]),
  );
  const evidenceIds = new Set(evidenceRecords.map((record) => record.evidenceId));
  const evidenceById = new Map(
    evidenceRecords.map((record) => [record.evidenceId, record]),
  );
  const scopeById = new Map(scopeItems.map((item) => [item.scopeItemId, item]));
  for (const check of discoverySourceChecks) {
    withinRun(check.checkedAt, startMs, finishMs, `discoverySourceChecks[${check.name}].checkedAt`);
  }
  evidenceRecords.forEach((record, index) => {
    withinRun(record.checkedAt, startMs, finishMs, `evidenceRecords[${index}].checkedAt`);
    const ownerIndex = scopeIndexById.get(record.scopeItemId);
    if (ownerIndex === undefined) {
      throw new Error(`evidenceRecords[${index}].scopeItemId does not exist`);
    }
    if (scopeItems[ownerIndex].school !== record.school) {
      throw new Error(
        `evidenceRecords[${index}].school must match owner scopeItems[${ownerIndex}].school (${record.scopeItemId})`,
      );
    }
    record.discoveredScopeItemIds.forEach((discovered, discoveredIndex) => {
      const discoveredScopeIndex = scopeIndexById.get(discovered);
      if (discoveredScopeIndex === undefined) {
        throw new Error(`evidenceRecords[${index}].discoveredScopeItemIds references ${discovered}`);
      }
      if (scopeItems[discoveredScopeIndex].school !== record.school) {
        throw new Error(
          `evidenceRecords[${index}].discoveredScopeItemIds[${discoveredIndex}] references scopeItems[${discoveredScopeIndex}] (${discovered}) whose school does not match evidenceRecords[${index}].school`,
        );
      }
    });
  });
  scopeItems.forEach((item, index) => {
    for (const evidenceId of item.evidenceIds) {
      const record = evidenceById.get(evidenceId);
      if (record === undefined) {
        throw new Error(`scopeItems[${index}].evidenceIds references ${evidenceId}`);
      }
      if (record.scopeItemId !== item.scopeItemId) {
        throw new Error(
          `scopeItems[${index}].evidenceIds ${evidenceId} is owned by ${record.scopeItemId}`,
        );
      }
    }
  });
  evidenceRecords.forEach((record, index) => {
    const owner = scopeById.get(record.scopeItemId);
    if (owner === undefined || !owner.evidenceIds.includes(record.evidenceId)) {
      throw new Error(
        `evidenceRecords[${index}] must be listed by owner scope ${record.scopeItemId}`,
      );
    }
  });
  projectObservations.forEach((observation, index) => {
    for (const evidenceId of observation.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`projectObservations[${index}].evidenceIds references ${evidenceId}`);
      }
    }
    const officialUrl = normalizeComparableUrl(observation.officialUrl);
    const hasMatchingHit = observation.evidenceIds.some((evidenceId) => {
      const record = evidenceById.get(evidenceId);
      return (
        record?.result === 'hit' &&
        record.school === observation.school &&
        normalizeComparableUrl(record.url) === officialUrl
      );
    });
    if (!hasMatchingHit) {
      throw new Error(
        `projectObservations[${index}] must have readable hit evidence matching officialUrl`,
      );
    }
  });
  pendingUpdates.forEach((update, index) => {
    withinRun(update.checkedAt, startMs, finishMs, `pendingUpdates[${index}].checkedAt`);
    const scopeItem = scopeItems.find((item) => item.scopeItemId === update.scopeItemId);
    if (scopeItem === undefined) {
      throw new Error(`pendingUpdates[${index}].scopeItemId does not exist`);
    }
    if (scopeItem.school !== update.school) {
      throw new Error(`pendingUpdates[${index}].school must match its scope item`);
    }
    for (const evidenceId of update.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`pendingUpdates[${index}].evidenceIds references ${evidenceId}`);
      }
    }
  });
  exclusions.forEach((exclusion, index) => {
    for (const evidenceId of exclusion.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`exclusions[${index}].evidenceIds references ${evidenceId}`);
      }
    }
  });

  return {
    schemaVersion: 2,
    runId: stringAt(object, 'runId', 'scan bundle'),
    scanMode: enumAt(object, 'scanMode', 'scan bundle', ['full', 'incremental'] as const),
    scanStartedAt,
    scanFinishedAt,
    candidateBase: {
      type: 'public-approved-snapshot',
      url: 'https://ddl.meta-mind.cn/data/current.json',
      sha256: digestAt(candidateObject, 'sha256', 'candidateBase'),
      snapshotId: stringAt(candidateObject, 'snapshotId', 'candidateBase'),
      dataHash: digestAt(candidateObject, 'dataHash', 'candidateBase'),
      privateParentCandidateUsed: false,
    },
    registry: {
      sha256: digestAt(registryObject, 'sha256', 'registry'),
      institutionCount: integerAt(registryObject, 'institutionCount', 'registry', 1),
    },
    pendingLedger: {
      generation: integerAt(pendingObject, 'generation', 'pendingLedger'),
      sha256: digestAt(pendingObject, 'sha256', 'pendingLedger'),
    },
    errors,
    warnings,
    discoverySourceChecks,
    scopeItems,
    evidenceRecords,
    projectObservations,
    pendingUpdates,
    exclusions,
  };
}

function cycleForProject(projectId: string): string {
  return projectId.slice(0, 4);
}

function parseUrlAlias(value: unknown, path: string): UrlAlias {
  const object = objectAt(value, path);
  exactKeys(object, path, [
    'url',
    'canonicalProjectId',
    'cycle',
    'reason',
    'introducedRunId',
  ]);
  const canonicalProjectId = projectIdAt(object, 'canonicalProjectId', path);
  const cycle = stringAt(object, 'cycle', path);
  if (cycle !== cycleForProject(canonicalProjectId)) {
    throw new Error(`${path}.cycle must match canonicalProjectId`);
  }
  return {
    url: urlAt(object, 'url', path),
    canonicalProjectId,
    cycle,
    reason: stringAt(object, 'reason', path),
    introducedRunId: stringAt(object, 'introducedRunId', path),
  };
}

function parseProjectAlias(value: unknown, path: string): ProjectAlias {
  const object = objectAt(value, path);
  exactKeys(object, path, [
    'sourceProjectId',
    'canonicalProjectId',
    'cycle',
    'reason',
    'introducedRunId',
  ]);
  const sourceProjectId = projectIdAt(object, 'sourceProjectId', path);
  const canonicalProjectId = projectIdAt(object, 'canonicalProjectId', path);
  const cycle = stringAt(object, 'cycle', path);
  if (cycle !== cycleForProject(sourceProjectId) || cycle !== cycleForProject(canonicalProjectId)) {
    throw new Error(`${path}.cycle must match both project IDs`);
  }
  return {
    sourceProjectId,
    canonicalProjectId,
    cycle,
    reason: stringAt(object, 'reason', path),
    introducedRunId: stringAt(object, 'introducedRunId', path),
  };
}

function parseTombstone(value: unknown, path: string): ProjectTombstone {
  const object = objectAt(value, path);
  exactKeys(object, path, ['projectId', 'mergedInto', 'cycle', 'reason', 'introducedRunId']);
  const projectId = projectIdAt(object, 'projectId', path);
  const mergedInto = projectIdAt(object, 'mergedInto', path);
  const cycle = stringAt(object, 'cycle', path);
  if (cycle !== cycleForProject(projectId) || cycle !== cycleForProject(mergedInto)) {
    throw new Error(`${path}.cycle must match both project IDs`);
  }
  if (projectId === mergedInto) throw new Error(`${path}.mergedInto must differ from projectId`);
  return {
    projectId,
    mergedInto,
    cycle,
    reason: stringAt(object, 'reason', path),
    introducedRunId: stringAt(object, 'introducedRunId', path),
  };
}

export function parseIdentityRegistry(input: unknown): ProjectIdentityRegistry {
  const object = objectAt(input, 'identity registry');
  exactKeys(object, 'identity registry', [
    'schemaVersion',
    'urlAliases',
    'projectAliases',
    'tombstones',
  ]);
  if (object.schemaVersion !== 2) {
    throw new Error('identity registry.schemaVersion must be exactly 2');
  }
  const urlAliases = arrayAt(object, 'urlAliases', 'identity registry', parseUrlAlias);
  const projectAliases = arrayAt(
    object,
    'projectAliases',
    'identity registry',
    parseProjectAlias,
  );
  const tombstones = arrayAt(object, 'tombstones', 'identity registry', parseTombstone);
  uniqueBy(urlAliases, (alias) => new URL(alias.url).toString(), 'identity registry.urlAliases');
  uniqueBy(
    projectAliases,
    (alias) => alias.sourceProjectId,
    'identity registry.projectAliases',
  );
  uniqueBy(tombstones, (item) => item.projectId, 'identity registry.tombstones');
  const tombstoneIds = new Set(tombstones.map((item) => item.projectId));
  for (const alias of projectAliases) {
    if (tombstoneIds.has(alias.canonicalProjectId)) {
      throw new Error('identity registry alias target must not be a tombstone');
    }
  }
  return { schemaVersion: 2, urlAliases, projectAliases, tombstones };
}
