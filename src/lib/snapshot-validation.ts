import type {
  DiscoveryKind,
  FactStatus,
  VerificationStatus,
} from './snapshot-types.js';

type JsonObject = Record<string, unknown>;

const verificationStatuses: readonly VerificationStatus[] = [
  'confirmed-open',
  'confirmed-unknown-deadline',
  'expired',
];
const factStatuses: readonly FactStatus[] = [
  'confirmed',
  'not-published',
  'unverified',
  'not-applicable',
];
const discoveryKinds: readonly DiscoveryKind[] = [
  'official',
  'baoyan-notice',
  'cs-baoyan',
  'other-discovery',
];
const deniedOfficialHosts = new Set([
  'ddl.csbaoyan.top',
  'github.com',
  'www.baoyantongzhi.com',
  'baoyantongzhi.com',
]);
const privateFieldNames = [
  ['submitted', 'ProjectIds'].join(''),
  ['welfare', 'Score'].join(''),
  ['cityPlatform', 'Value'].join(''),
  ['social', 'Value'].join(''),
  ['recommendation', 'Tier'].join(''),
] as const;
const privateFieldNameSet = new Set(privateFieldNames.map((name) => name.toLowerCase()));
const privateMarkerPattern = new RegExp(
  [
    ...privateFieldNames.map(
      (name) => `(?:^|[^a-z0-9_$])${name}(?:[^a-z0-9_$]|$)`,
    ),
    'targets[\\\\/]submitted(?:[\\\\/]|$)',
    'profile_space[\\\\/]targets(?:[\\\\/]|$)',
  ].join('|'),
  'i',
);
const privateValuePatterns: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    pattern: /[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/i,
    label: 'email address',
  },
  {
    pattern:
      /(?:^|[^a-z0-9])(?:(?:\+|%2b)86[ -]?)?1[3-9][0-9][ -]?[0-9]{4}[ -]?[0-9]{4}(?:[^a-z0-9]|$)/i,
    label: 'Chinese mainland mobile number',
  },
  { pattern: /\bfile:\/+\S*/i, label: 'file URI' },
  {
    pattern:
      /(?:^|[^a-z0-9.])\/(?:Users|home)\/[a-z0-9_.-]+(?:[\\/]|$)|\b[a-z]:[\\/]+Users[\\/]+[^\\/\s]+|(?:^|[\s"'(])~[\\/]+/i,
    label: 'user-local path',
  },
  {
    pattern: privateMarkerPattern,
    label: 'private publication marker',
  },
];

const candidateKeys = [
  'schemaVersion',
  'scanAt',
  'defaultFeedId',
  'feeds',
  'counts',
  'opportunities',
] as const;
const approvalKeys = ['snapshotId', 'approvedAt', 'previousSnapshotId', 'dataHash'] as const;
const feedKeys = ['id', 'label', 'admissionCycle', 'eventYear'] as const;
const countKeys = [
  'confirmedOpen',
  'confirmedUnknownDeadline',
  'pendingExcluded',
  'expired',
] as const;
const opportunityKeys = [
  'projectId',
  'feedId',
  'name',
  'institute',
  'project',
  'eventType',
  'description',
  'verificationStatus',
  'deadline',
  'deadlineOriginal',
  'deadlineEpochMs',
  'website',
  'tags',
  'verifiedAt',
  'discoverySources',
  'logistics',
  'recommendation',
  'materials',
] as const;
const sourceKeys = ['kind', 'label', 'url'] as const;
const factKeys = ['status', 'summary'] as const;
const maxPrivacyScanNodes = 50_000;
const maxPrivacyScanDepth = 256;

interface PrivacyScanState {
  seen: WeakSet<object>;
  nodes: number;
  nodeBudgetExceeded: boolean;
  depthBudgetExceeded: boolean;
}

interface OpportunityOrderValue {
  path: string;
  projectId?: string;
  feedId?: string;
  status?: VerificationStatus;
  deadlineEpochMs?: number | null;
  verifiedAtMs?: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return /^[a-z_$][a-z0-9_$]*$/i.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function decodedTextVariants(value: string): string[] {
  const variants = [value];
  let current = value;

  for (let round = 0; round < 2; round += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      variants.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return variants;
}

function validatePrivateText(value: string, path: string, errors: string[]): void {
  for (const variant of decodedTextVariants(value)) {
    for (const { pattern, label } of privateValuePatterns) {
      if (pattern.test(variant)) {
        errors.push(`${path}: contains a ${label}`);
        return;
      }
    }
  }
}

function validatePrivateKey(key: string, path: string, errors: string[]): void {
  if (privateFieldNameSet.has(key.toLowerCase())) {
    errors.push(`${path}: contains a private publication marker`);
  }
}

function validateNoPrivateValues(
  value: unknown,
  path: string,
  errors: string[],
  state: PrivacyScanState = {
    seen: new WeakSet<object>(),
    nodes: 0,
    nodeBudgetExceeded: false,
    depthBudgetExceeded: false,
  },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > maxPrivacyScanNodes) {
    if (!state.nodeBudgetExceeded) {
      errors.push(`${path}: privacy scan exceeded node budget`);
      state.nodeBudgetExceeded = true;
    }
    return;
  }
  if (depth > maxPrivacyScanDepth) {
    if (!state.depthBudgetExceeded) {
      errors.push(`${path}: privacy scan exceeded depth budget`);
      state.depthBudgetExceeded = true;
    }
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    validatePrivateText(String(value), path, errors);
    return;
  }
  if (typeof value !== 'object' || value === null || state.seen.has(value)) return;
  state.seen.add(value);

  if (Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const pathToChild = /^(?:0|[1-9][0-9]*)$/.test(key)
        ? `${path}[${key}]`
        : childPath(path, key);
      validatePrivateKey(key, pathToChild, errors);
      validateNoPrivateValues(child, pathToChild, errors, state, depth + 1);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const pathToChild = childPath(path, key);
    validatePrivateKey(key, pathToChild, errors);
    validateNoPrivateValues(child, pathToChild, errors, state, depth + 1);
  }
}

function validateShape(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  errors: string[],
): JsonObject | undefined {
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key}: unknown property`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      errors.push(`${path}.${key}: missing property`);
    }
  }
  return value;
}

function stringValue(
  object: JsonObject,
  key: string,
  path: string,
  errors: string[],
  nonEmpty = false,
): string | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  if (typeof value !== 'string') {
    errors.push(`${path}.${key}: expected a string`);
    return undefined;
  }
  if (nonEmpty && value.length === 0) {
    errors.push(`${path}.${key}: expected a non-empty string`);
  }
  return value;
}

function nullableStringValue(
  object: JsonObject,
  key: string,
  path: string,
  errors: string[],
): string | null | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  if (value !== null && typeof value !== 'string') {
    errors.push(`${path}.${key}: expected a string or null`);
    return undefined;
  }
  return value;
}

function finiteNumberValue(
  object: JsonObject,
  key: string,
  path: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}.${key}: expected a finite number`);
    return undefined;
  }
  return value;
}

function nullableFiniteNumberValue(
  object: JsonObject,
  key: string,
  path: string,
  errors: string[],
): number | null | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    errors.push(`${path}.${key}: expected a finite number or null`);
    return undefined;
  }
  return value;
}

function enumValue<T extends string>(
  object: JsonObject,
  key: string,
  path: string,
  allowed: readonly T[],
  errors: string[],
): T | undefined {
  const value = stringValue(object, key, path, errors);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    errors.push(`${path}.${key}: expected an allowed value`);
    return undefined;
  }
  return value as T;
}

function isValidIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;

  return (
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (offsetHour === undefined || Number(offsetHour) <= 23) &&
    (offsetMinute === undefined || Number(offsetMinute) <= 59) &&
    Number.isFinite(Date.parse(value))
  );
}

function timestampValue(
  object: JsonObject,
  key: string,
  path: string,
  errors: string[],
): string | undefined {
  const value = stringValue(object, key, path, errors);
  if (value !== undefined && !isValidIsoTimestamp(value)) {
    errors.push(`${path}.${key}: expected a valid ISO timestamp`);
  }
  return value;
}

function parsePublicUrl(value: string, path: string, errors: string[]): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    if (url.username !== '' || url.password !== '') {
      errors.push(`${path}: URL credentials are not allowed`);
    }
    return url;
  } catch {
    errors.push(`${path}: expected a parseable HTTP(S) URL`);
    return undefined;
  }
}

function isDeniedOfficialHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return [...deniedOfficialHosts].some(
    (deniedHost) => hostname === deniedHost || hostname.endsWith(`.${deniedHost}`),
  );
}

function validateFeed(
  value: unknown,
  index: number,
  errors: string[],
): { id?: string; admissionCycle?: string } {
  const path = `snapshot.feeds[${index}]`;
  const feed = validateShape(value, path, feedKeys, [], errors);
  if (feed === undefined) return {};

  const id = stringValue(feed, 'id', path, errors, true);
  stringValue(feed, 'label', path, errors);
  const admissionCycle = stringValue(feed, 'admissionCycle', path, errors);
  if (admissionCycle !== undefined && !/^[0-9]{4}$/.test(admissionCycle)) {
    errors.push(`${path}.admissionCycle: expected exactly four digits`);
  }
  const eventYear = finiteNumberValue(feed, 'eventYear', path, errors);
  if (eventYear !== undefined && !Number.isInteger(eventYear)) {
    errors.push(`${path}.eventYear: expected an integer`);
  }
  return { id, admissionCycle };
}

function validateFact(value: unknown, path: string, errors: string[]): void {
  const fact = validateShape(value, path, factKeys, [], errors);
  if (fact === undefined) return;
  enumValue(fact, 'status', path, factStatuses, errors);
  stringValue(fact, 'summary', path, errors);
}

function validateSource(value: unknown, path: string, errors: string[]): DiscoveryKind | undefined {
  const source = validateShape(value, path, sourceKeys, [], errors);
  if (source === undefined) return undefined;

  const kind = enumValue(source, 'kind', path, discoveryKinds, errors);
  stringValue(source, 'label', path, errors);
  const url = stringValue(source, 'url', path, errors);
  if (url !== undefined) {
    const parsedUrl = parsePublicUrl(url, `${path}.url`, errors);
    if (kind === 'official' && parsedUrl !== undefined && isDeniedOfficialHost(parsedUrl)) {
      errors.push(`${path}.url: denied discovery host cannot be an official source`);
    }
  }
  return kind;
}

function validateOpportunity(
  value: unknown,
  index: number,
  knownFeedIds: Set<string>,
  nowMs: number,
  errors: string[],
): OpportunityOrderValue {
  const path = `snapshot.opportunities[${index}]`;
  const opportunity = validateShape(value, path, opportunityKeys, ['province'], errors);
  if (opportunity === undefined) return { path };

  const projectId = stringValue(opportunity, 'projectId', path, errors, true);
  const feedId = stringValue(opportunity, 'feedId', path, errors);
  if (feedId !== undefined && !knownFeedIds.has(feedId)) {
    errors.push(`${path}.feedId: expected a known feed ID`);
  }
  for (const key of ['name', 'institute', 'project', 'eventType', 'description']) {
    stringValue(opportunity, key, path, errors);
  }

  const status = enumValue(
    opportunity,
    'verificationStatus',
    path,
    verificationStatuses,
    errors,
  );
  const deadline = nullableStringValue(opportunity, 'deadline', path, errors);
  const deadlineIsValid = typeof deadline === 'string' && isValidIsoTimestamp(deadline);
  if (typeof deadline === 'string' && !deadlineIsValid) {
    errors.push(`${path}.deadline: expected a valid ISO timestamp or null`);
  }
  stringValue(opportunity, 'deadlineOriginal', path, errors);
  const deadlineEpochMs = nullableFiniteNumberValue(
    opportunity,
    'deadlineEpochMs',
    path,
    errors,
  );

  const website = stringValue(opportunity, 'website', path, errors);
  if (website !== undefined) {
    const parsedWebsite = parsePublicUrl(website, `${path}.website`, errors);
    if (parsedWebsite !== undefined && isDeniedOfficialHost(parsedWebsite)) {
      errors.push(`${path}.website: denied discovery host cannot be the official website`);
    }
  }

  if (Object.hasOwn(opportunity, 'tags')) {
    if (!Array.isArray(opportunity.tags)) {
      errors.push(`${path}.tags: expected an array`);
    } else {
      opportunity.tags.forEach((tag, tagIndex) => {
        if (typeof tag !== 'string') errors.push(`${path}.tags[${tagIndex}]: expected a string`);
      });
    }
  }
  if (Object.hasOwn(opportunity, 'province') && typeof opportunity.province !== 'string') {
    errors.push(`${path}.province: expected a string`);
  }
  const verifiedAt = timestampValue(opportunity, 'verifiedAt', path, errors);
  const verifiedAtMs =
    verifiedAt !== undefined && isValidIsoTimestamp(verifiedAt) ? Date.parse(verifiedAt) : undefined;

  let hasOfficialSource = false;
  if (Object.hasOwn(opportunity, 'discoverySources')) {
    if (!Array.isArray(opportunity.discoverySources)) {
      errors.push(`${path}.discoverySources: expected an array`);
    } else {
      opportunity.discoverySources.forEach((source, sourceIndex) => {
        const kind = validateSource(source, `${path}.discoverySources[${sourceIndex}]`, errors);
        if (kind === 'official') hasOfficialSource = true;
      });
    }
  }
  if (!hasOfficialSource) {
    errors.push(`${path}.discoverySources: expected an explicit official discovery source`);
  }

  validateFact(opportunity.logistics, `${path}.logistics`, errors);
  validateFact(opportunity.recommendation, `${path}.recommendation`, errors);
  validateFact(opportunity.materials, `${path}.materials`, errors);

  if (status === 'confirmed-open') {
    if (typeof deadline !== 'string' || typeof deadlineEpochMs !== 'number') {
      errors.push(`${path}: confirmed-open requires a finite future deadline and deadlineEpochMs`);
    } else if (deadlineIsValid) {
      const normalizedEpoch = Date.parse(deadline);
      if (deadlineEpochMs !== normalizedEpoch) {
        errors.push(`${path}.deadlineEpochMs: must match the normalized deadline timestamp`);
      }
      if (Number.isFinite(nowMs) && deadlineEpochMs <= nowMs) {
        errors.push(`${path}: confirmed-open deadline must be in the future`);
      }
    }
  } else if (status === 'confirmed-unknown-deadline') {
    if (deadline !== null || deadlineEpochMs !== null) {
      errors.push(`${path}: confirmed-unknown-deadline requires null deadline fields`);
    }
  } else if (status === 'expired') {
    if (deadline === null && deadlineEpochMs === null) {
      // An expired record may have had no published deadline.
    } else if (typeof deadline !== 'string' || typeof deadlineEpochMs !== 'number') {
      errors.push(`${path}: expired deadline fields must both be null or normalized`);
    } else if (deadlineIsValid) {
      const normalizedEpoch = Date.parse(deadline);
      if (deadlineEpochMs !== normalizedEpoch) {
        errors.push(`${path}.deadlineEpochMs: must match the normalized deadline timestamp`);
      }
      if (Number.isFinite(nowMs) && deadlineEpochMs > nowMs) {
        errors.push(`${path}: expired rows cannot carry a future active deadline`);
      }
    }
  }

  return { path, projectId, feedId, status, deadlineEpochMs, verifiedAtMs };
}

function validatePublicProjectId(
  opportunity: OpportunityOrderValue,
  feedAdmissionCycles: Map<string, string>,
  errors: string[],
): void {
  if (opportunity.projectId === undefined || opportunity.feedId === undefined) return;

  const parts = opportunity.projectId.split('|');
  if (parts.length !== 4 || parts.some((part) => part.trim() === '')) {
    errors.push(`${opportunity.path}.projectId: expected four non-empty parts`);
    return;
  }
  if (!/^[0-9]{4}$/.test(parts[0])) {
    errors.push(`${opportunity.path}.projectId: leading cycle must be exactly four digits`);
  }

  const admissionCycle = feedAdmissionCycles.get(opportunity.feedId);
  if (admissionCycle !== undefined && parts[0] !== admissionCycle) {
    errors.push(
      `${opportunity.path}.projectId: leading segment must match feed admissionCycle`,
    );
  }
}

function validateCounts(value: unknown, errors: string[]): JsonObject | undefined {
  const path = 'snapshot.counts';
  const counts = validateShape(value, path, countKeys, [], errors);
  if (counts === undefined) return undefined;

  for (const key of countKeys) {
    const count = counts[key];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      errors.push(`${path}.${key}: expected a nonnegative integer`);
    }
  }
  return counts;
}

function validateOrdering(values: OpportunityOrderValue[], errors: string[]): void {
  let previousDeadline = Number.NEGATIVE_INFINITY;
  let sawUnknownDeadline = false;
  let sawExpired = false;

  for (const value of values) {
    if (value.status === 'expired') {
      sawExpired = true;
      continue;
    }
    if (value.status !== 'confirmed-open' && value.status !== 'confirmed-unknown-deadline') continue;

    if (sawExpired) {
      errors.push(`${value.path}: expired rows must appear after active rows`);
    }
    if (value.status === 'confirmed-unknown-deadline') {
      sawUnknownDeadline = true;
      continue;
    }
    if (sawUnknownDeadline) {
      errors.push(`${value.path}: unknown-deadline active rows must appear after timed active rows`);
    }
    if (typeof value.deadlineEpochMs === 'number') {
      if (value.deadlineEpochMs < previousDeadline) {
        errors.push(`${value.path}: active rows must be ascending by deadline epoch`);
      }
      previousDeadline = value.deadlineEpochMs;
    }
  }
}

function validateInput(input: unknown, approved: boolean, nowMs: number): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(nowMs)) {
    errors.push('nowMs: expected a finite number');
  }
  validateNoPrivateValues(input, 'snapshot', errors);
  const requiredKeys = approved ? [...candidateKeys, ...approvalKeys] : candidateKeys;
  const snapshot = validateShape(input, 'snapshot', requiredKeys, [], errors);
  if (snapshot === undefined) return errors;

  if (snapshot.schemaVersion !== 1) {
    errors.push('snapshot.schemaVersion: expected exactly 1');
  }
  const scanAt = timestampValue(snapshot, 'scanAt', 'snapshot', errors);
  const scanAtMs = scanAt !== undefined && isValidIsoTimestamp(scanAt) ? Date.parse(scanAt) : undefined;
  const defaultFeedId = stringValue(snapshot, 'defaultFeedId', 'snapshot', errors);

  const knownFeedIds = new Set<string>();
  const feedAdmissionCycles = new Map<string, string>();
  if (Object.hasOwn(snapshot, 'feeds')) {
    if (!Array.isArray(snapshot.feeds)) {
      errors.push('snapshot.feeds: expected an array');
    } else {
      for (let index = 0; index < snapshot.feeds.length; index += 1) {
        if (!Object.hasOwn(snapshot.feeds, index)) {
          errors.push(`snapshot.feeds[${index}]: missing array element`);
          continue;
        }
        const { id, admissionCycle } = validateFeed(snapshot.feeds[index], index, errors);
        if (id !== undefined && id.length > 0) {
          if (knownFeedIds.has(id)) errors.push(`snapshot.feeds[${index}].id: duplicate feed ID`);
          knownFeedIds.add(id);
          if (admissionCycle !== undefined) feedAdmissionCycles.set(id, admissionCycle);
        }
      }
    }
  }
  if (defaultFeedId !== undefined && !knownFeedIds.has(defaultFeedId)) {
    errors.push('snapshot.defaultFeedId: expected a known feed ID');
  }

  const counts = validateCounts(snapshot.counts, errors);
  const opportunities: OpportunityOrderValue[] = [];
  if (Object.hasOwn(snapshot, 'opportunities')) {
    if (!Array.isArray(snapshot.opportunities)) {
      errors.push('snapshot.opportunities: expected an array');
    } else {
      for (let index = 0; index < snapshot.opportunities.length; index += 1) {
        if (!Object.hasOwn(snapshot.opportunities, index)) {
          errors.push(`snapshot.opportunities[${index}]: missing array element`);
          continue;
        }
        opportunities.push(
          validateOpportunity(snapshot.opportunities[index], index, knownFeedIds, nowMs, errors),
        );
      }
    }
  }

  const projectIds = new Set<string>();
  for (const opportunity of opportunities) {
    if (opportunity.projectId === undefined) continue;
    if (projectIds.has(opportunity.projectId)) {
      errors.push(`${opportunity.path}.projectId: duplicate projectId`);
    }
    projectIds.add(opportunity.projectId);
  }

  if (counts !== undefined) {
    const actualCounts = {
      confirmedOpen: opportunities.filter((value) => value.status === 'confirmed-open').length,
      confirmedUnknownDeadline: opportunities.filter(
        (value) => value.status === 'confirmed-unknown-deadline',
      ).length,
      expired: opportunities.filter((value) => value.status === 'expired').length,
    };
    for (const key of ['confirmedOpen', 'confirmedUnknownDeadline', 'expired'] as const) {
      if (counts[key] !== actualCounts[key]) {
        errors.push(`snapshot.counts.${key}: must match opportunity rows`);
      }
    }
  }
  validateOrdering(opportunities, errors);

  if (scanAtMs !== undefined) {
    for (const opportunity of opportunities) {
      if (opportunity.verifiedAtMs !== undefined && opportunity.verifiedAtMs > scanAtMs) {
        errors.push(`${opportunity.path}.verifiedAt: must not be after snapshot.scanAt`);
      }
    }
  }

  for (const opportunity of opportunities) {
    validatePublicProjectId(opportunity, feedAdmissionCycles, errors);
  }

  if (approved) {
    stringValue(snapshot, 'snapshotId', 'snapshot', errors, true);
    const approvedAt = timestampValue(snapshot, 'approvedAt', 'snapshot', errors);
    const approvedAtMs =
      approvedAt !== undefined && isValidIsoTimestamp(approvedAt)
        ? Date.parse(approvedAt)
        : undefined;
    if (scanAtMs !== undefined && approvedAtMs !== undefined && approvedAtMs < scanAtMs) {
      errors.push('snapshot.approvedAt: must not be before snapshot.scanAt');
    }
    if (approvedAtMs !== undefined) {
      for (const opportunity of opportunities) {
        if (opportunity.verifiedAtMs !== undefined && opportunity.verifiedAtMs > approvedAtMs) {
          errors.push(`${opportunity.path}.verifiedAt: must not be after snapshot.approvedAt`);
        }
      }
    }
    nullableStringValue(snapshot, 'previousSnapshotId', 'snapshot', errors);
    const dataHash = stringValue(snapshot, 'dataHash', 'snapshot', errors);
    if (dataHash !== undefined && !/^[0-9a-fA-F]{64}$/.test(dataHash)) {
      errors.push('snapshot.dataHash: expected exactly 64 hexadecimal characters');
    }
  }

  return errors;
}

export function validateCandidate(input: unknown, nowMs = Date.now()): string[] {
  try {
    return validateInput(input, false, nowMs);
  } catch {
    return ['snapshot: malformed input could not be validated'];
  }
}

export function validateSnapshot(input: unknown, nowMs = Date.now()): string[] {
  try {
    return validateInput(input, true, nowMs);
  } catch {
    return ['snapshot: malformed input could not be validated'];
  }
}
