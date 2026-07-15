import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  FieldFactGroup,
  PublicOpportunity,
  PublicSnapshot,
  SnapshotCandidate,
  VerificationStatus,
} from '../../src/lib/snapshot-types.js';
import { validateCandidate, validateSnapshot } from '../../src/lib/snapshot-validation.js';

type JsonObject = Record<string, unknown>;

export interface IdentityContext {
  previous: PublicSnapshot | null;
  aliases: Record<string, string>;
}

interface ParsedProjectId {
  cycle: string;
  institute: string;
}

interface MappedOpportunity {
  cycle: string;
  opportunity: PublicOpportunity;
}

interface NormalizedDeadline {
  value: string | null;
  original: string;
  epochMs: number | null;
}

interface CliOptions {
  input: string;
  aliases: string;
  output: string;
  approved?: string;
}

interface IdentityIndex {
  previousByUrl: Map<string, Set<string>>;
  simpleAliasesByUrl: Map<string, string>;
  compoundAliasesByUrlAndInput: Map<string, string>;
}

interface CurrentUrlIdentity {
  projectIds: Set<string>;
  rowCount: number;
}

const beijingOffsetMs = 8 * 60 * 60 * 1000;
const unverifiedPattern =
  /未核实|待核实|待系统核实|未确认|未明确|无法核实|不确定|疑似|传闻|可能|交流群|群聊|截图|(?:请)?以[^，。；\n]*系统[^，。；\n]*为准/;
const notPublishedPattern =
  /未公布|待公布|暂未公布|未提及|未在[^，。；\n]*(?:列出|提及|说明|要求)|暂无|待定|后续通知/;
const localPathPattern =
  /(?:^|[\s"'（【，。；：=])(?:\/(?!\/)[^\s"'，。；）】]+|[A-Za-z]:[\\/][^\s"'，。；）】]+|\\\\[^\\/\s"'，。；]+[\\/][^\s"'，。；）】]+)/;
const privateTextMarkerPattern =
  /file:\/\/|profile_space|(?:^|[\s"'（【，。；：=])targets[\\/]|submittedProjectIds?|submittedIds?|PENDING_PRIVATE(?:_[A-Z0-9_]*)?|PRIVATE_[A-Z0-9_]+/i;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requiredString(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function rowArray(dataset: JsonObject, key: string): JsonObject[] {
  const value = dataset[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value.map((row, index) => objectValue(row, `${key}[${index}]`));
}

function parseProjectId(projectId: string, path: string): ParsedProjectId {
  const segments = projectId.split('|').map((segment) => segment.trim());
  if (segments.length !== 4 || segments.some((segment) => segment === '')) {
    throw new Error(`${path}.projectId must use cycle|school|institute|round`);
  }
  if (!/^\d{4}$/.test(segments[0])) {
    throw new Error(`${path}.projectId must start with a four-digit cycle`);
  }
  return { cycle: segments[0], institute: segments[2] };
}

function parseCycle(
  value: unknown,
  path: string,
  expired: boolean,
  projectIdCycle: string,
): string {
  if (typeof value === 'string' && value.trim() !== '') {
    const matches = value.match(/(?<!\d)\d{4}(?!\d)/g) ?? [];
    const cycles = [...new Set(matches)];
    if (cycles.length !== 1) {
      throw new Error(`${path}.cycle must contain one unambiguous four-digit cycle`);
    }
    if (cycles[0] !== projectIdCycle) {
      throw new Error(`${path}.cycle must match the leading projectId cycle`);
    }
    return cycles[0];
  }
  if (expired) return projectIdCycle;
  throw new Error(`${path}.cycle must contain one unambiguous four-digit cycle`);
}

function normalizeUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${path} must be a valid HTTP(S) URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${path} must not contain URL credentials`);
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hash = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  url.searchParams.sort();
  return url.toString();
}

function addAlias(
  aliases: Map<string, string>,
  key: string,
  projectId: string,
  kind: 'simple' | 'compound',
): void {
  const existing = aliases.get(key);
  if (existing !== undefined && existing !== projectId) {
    throw new Error(`conflicting ${kind} alias entries after URL normalization`);
  }
  aliases.set(key, projectId);
}

function compoundAliasKey(normalizedUrl: string, inputProjectId: string): string {
  return `${normalizedUrl}::${inputProjectId}`;
}

function containsPrivateFreeText(value: string): boolean {
  return localPathPattern.test(value) || privateTextMarkerPattern.test(value);
}

function candidateContainsPrivateFreeText(value: unknown): boolean {
  if (typeof value === 'string') return containsPrivateFreeText(value);
  if (Array.isArray(value)) return value.some(candidateContainsPrivateFreeText);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    (key === 'website' || key === 'url')
      ? false
      : candidateContainsPrivateFreeText(child));
}

function identityMaps(identities: IdentityContext): IdentityIndex {
  if (identities.previous !== null) {
    const referenceTime = Date.parse(identities.previous.approvedAt);
    const errors = validateSnapshot(identities.previous, referenceTime);
    if (errors.length > 0) {
      throw new Error(`Approved snapshot validation failed:\n${errors.join('\n')}`);
    }
  }

  const previousByUrl = new Map<string, Set<string>>();
  const previousProjectIds = new Set<string>();
  for (const opportunity of identities.previous?.opportunities ?? []) {
    previousProjectIds.add(opportunity.projectId);
    const normalized = normalizeUrl(opportunity.website, 'previous opportunity website');
    const projectIds = previousByUrl.get(normalized) ?? new Set<string>();
    projectIds.add(opportunity.projectId);
    previousByUrl.set(normalized, projectIds);
  }

  const simpleAliasesByUrl = new Map<string, string>();
  const compoundAliasesByUrlAndInput = new Map<string, string>();
  if (!isObject(identities.aliases)) throw new Error('aliases must be an object');
  for (const [alias, projectIdValue] of Object.entries(identities.aliases)) {
    if (typeof projectIdValue !== 'string' || projectIdValue.trim() === '') {
      throw new Error(`alias for ${alias} must be a non-empty project ID`);
    }
    const projectId = projectIdValue.trim();
    const delimiterIndex = alias.indexOf('::');
    if (delimiterIndex === -1) {
      parseProjectId(projectId, 'simple alias target');
      const normalizedUrl = normalizeUrl(alias, 'simple alias URL');
      addAlias(simpleAliasesByUrl, normalizedUrl, projectId, 'simple');
      continue;
    }
    if (
      delimiterIndex === 0
      || delimiterIndex === alias.length - 2
      || alias.indexOf('::', delimiterIndex + 2) !== -1
    ) {
      throw new Error(`malformed compound alias: ${alias}`);
    }
    const url = alias.slice(0, delimiterIndex);
    const inputProjectId = alias.slice(delimiterIndex + 2).trim();
    if (inputProjectId === '') throw new Error(`malformed compound alias: ${alias}`);
    const inputCycle = parseProjectId(inputProjectId, 'compound alias input').cycle;
    const targetCycle = parseProjectId(projectId, 'compound alias target').cycle;
    if (inputCycle !== targetCycle) {
      throw new Error('compound alias target cycle must match the current input cycle');
    }
    const normalizedUrl = normalizeUrl(url, 'compound alias URL');
    addAlias(
      compoundAliasesByUrlAndInput,
      compoundAliasKey(normalizedUrl, inputProjectId),
      projectId,
      'compound',
    );
  }
  for (const projectId of simpleAliasesByUrl.values()) {
    if (!previousProjectIds.has(projectId)) {
      throw new Error(
        'simple alias target must be an approved ID in the validated previous snapshot',
      );
    }
  }
  for (const projectId of compoundAliasesByUrlAndInput.values()) {
    if (!previousProjectIds.has(projectId)) {
      throw new Error(
        'compound alias target must be an approved ID in the validated previous snapshot',
      );
    }
  }
  return {
    previousByUrl,
    simpleAliasesByUrl,
    compoundAliasesByUrlAndInput,
  };
}

function buildCurrentUrlIdentities(
  mainRows: JsonObject[],
  expiredRows: JsonObject[],
): Map<string, CurrentUrlIdentity> {
  const currentByUrl = new Map<string, CurrentUrlIdentity>();
  const addRows = (rows: JsonObject[], label: 'mainRows' | 'expiredRows'): void => {
    rows.forEach((row, index) => {
      const path = `${label}[${index}]`;
      const projectId = requiredString(row, 'projectId', path);
      const officialUrl = requiredString(row, 'officialUrl', path);
      const normalizedUrl = normalizeUrl(officialUrl, `${path}.officialUrl`);
      const current = currentByUrl.get(normalizedUrl) ?? {
        projectIds: new Set<string>(),
        rowCount: 0,
      };
      current.projectIds.add(projectId);
      current.rowCount += 1;
      currentByUrl.set(normalizedUrl, current);
    });
  };
  addRows(mainRows, 'mainRows');
  addRows(expiredRows, 'expiredRows');
  return currentByUrl;
}

function validateSharedUrlAliasCoverage(
  identityIndex: IdentityIndex,
  currentByUrl: Map<string, CurrentUrlIdentity>,
): void {
  for (const [normalizedUrl, current] of currentByUrl) {
    const previousIds = identityIndex.previousByUrl.get(normalizedUrl);
    if (previousIds === undefined) continue;
    const cycles = new Set(
      [...current.projectIds].map((projectId) =>
        parseProjectId(projectId, 'current URL identity').cycle),
    );

    for (const cycle of cycles) {
      const currentIds = new Set(
        [...current.projectIds].filter((projectId) =>
          parseProjectId(projectId, 'current URL identity').cycle === cycle),
      );
      const previousCycleIds = new Set(
        [...previousIds].filter((projectId) =>
          parseProjectId(projectId, 'previous URL identity').cycle === cycle),
      );
      const missingPreviousIds = [...previousCycleIds].filter(
        (projectId) => !currentIds.has(projectId),
      );
      if (missingPreviousIds.length === 0) continue;
      if (previousCycleIds.size === 1 && currentIds.size === 1) continue;

      const coverage = new Map(missingPreviousIds.map((projectId) => [projectId, 0]));
      for (const currentId of currentIds) {
        const aliasTarget = identityIndex.compoundAliasesByUrlAndInput.get(
          compoundAliasKey(normalizedUrl, currentId),
        );
        if (aliasTarget !== undefined && coverage.has(aliasTarget)) {
          coverage.set(aliasTarget, (coverage.get(aliasTarget) ?? 0) + 1);
        }
      }
      if ([...coverage.values()].some((count) => count !== 1)) {
        throw new Error(
          'shared URL has ambiguous previous IDs: compound aliases must cover every missing previous ID exactly once',
        );
      }
    }
  }
}

function resolveProjectId(
  identityIndex: IdentityIndex,
  currentByUrl: Map<string, CurrentUrlIdentity>,
  normalizedOfficialUrl: string,
  inputProjectId: string,
  currentCycle: string,
  path: string,
): string {
  const previousIds = identityIndex.previousByUrl.get(normalizedOfficialUrl);
  const reusablePreviousIds = new Set(
    [...(previousIds ?? [])].filter(
      (projectId) => parseProjectId(projectId, 'previous opportunity').cycle === currentCycle,
    ),
  );
  const current = currentByUrl.get(normalizedOfficialUrl);
  if (current === undefined) throw new Error(`${path}.officialUrl is missing from current URL index`);

  if (reusablePreviousIds.size > 0) {
    if (reusablePreviousIds.has(inputProjectId)) return inputProjectId;

    const compoundAlias = identityIndex.compoundAliasesByUrlAndInput.get(
      compoundAliasKey(normalizedOfficialUrl, inputProjectId),
    );
    const everyPreviousIdRemains = [...reusablePreviousIds].every((projectId) =>
      current.projectIds.has(projectId));

    if (current.rowCount > 1) {
      if (everyPreviousIdRemains) return inputProjectId;
      const hasCompoundAssignment = [...current.projectIds].some((projectId) =>
        identityIndex.compoundAliasesByUrlAndInput.has(
          compoundAliasKey(normalizedOfficialUrl, projectId),
        ));
      if (!hasCompoundAssignment) {
        throw new Error(
          `${path}.officialUrl has ambiguous previous IDs in a one-to-many rename; an explicit compound alias is required`,
        );
      }
      if (compoundAlias === undefined) return inputProjectId;
    } else if (compoundAlias === undefined && reusablePreviousIds.size === 1) {
      return reusablePreviousIds.values().next().value as string;
    } else if (compoundAlias === undefined) {
      throw new Error(
        `${path}.officialUrl has ambiguous previous IDs; an explicit compound alias is required`,
      );
    }

    if (compoundAlias !== undefined) {
      if (!reusablePreviousIds.has(compoundAlias)) {
        throw new Error(`${path} compound alias must resolve to an approved ID for the shared URL`);
      }
      return compoundAlias;
    }
  }

  const simpleAlias = identityIndex.simpleAliasesByUrl.get(normalizedOfficialUrl);
  if (simpleAlias !== undefined) {
    if (parseProjectId(simpleAlias, 'simple alias target').cycle !== currentCycle) {
      throw new Error('simple alias target cycle must match the current row cycle');
    }
    return simpleAlias;
  }
  return inputProjectId;
}

function daysInMonth(year: number, month: number): number {
  return month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
}

function validDateParts(year: number, month: number, day: number): boolean {
  return day >= 1 && day <= daysInMonth(year, month);
}

function formatBeijingTimestamp(epochMs: number): string {
  return `${new Date(epochMs + beijingOffsetMs).toISOString().slice(0, 19)}+08:00`;
}

function normalizeDeadline(
  deadline: unknown,
  deadlineOriginal: unknown,
  path: string,
): NormalizedDeadline {
  const original =
    typeof deadlineOriginal === 'string' && deadlineOriginal.trim() !== ''
      ? deadlineOriginal.trim()
      : '未公布';

  if (deadline === null || deadline === undefined || deadline === '') {
    return { value: null, original, epochMs: null };
  }
  if (typeof deadline !== 'string') {
    throw new Error(`${path}.deadline must be a string or null`);
  }

  const value = deadline.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly !== null) {
    const [, yearText, monthText, dayText] = dateOnly;
    if (!validDateParts(Number(yearText), Number(monthText), Number(dayText))) {
      throw new Error(`${path}.deadline must be a valid calendar date`);
    }
    const normalized = `${value}T23:59:00+08:00`;
    const note = original.includes('官方未公布具体时刻')
      ? original
      : `${original}；官方未公布具体时刻`;
    return { value: normalized, original: note, epochMs: Date.parse(normalized) };
  }

  const timestamp = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
    value,
  );
  if (timestamp === null) {
    throw new Error(`${path}.deadline must be an ISO timestamp, YYYY-MM-DD, or null`);
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText = '00',
    zone = '+08:00',
  ] = timestamp;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  if (
    !validDateParts(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    throw new Error(`${path}.deadline must be a valid calendar timestamp`);
  }
  if (zone !== 'Z') {
    const zoneParts = /^[+-](\d{2}):(\d{2})$/.exec(zone);
    if (zoneParts === null || Number(zoneParts[1]) > 23 || Number(zoneParts[2]) > 59) {
      throw new Error(`${path}.deadline has an invalid timezone offset`);
    }
  }
  const epochMs = Date.parse(
    `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone}`,
  );
  if (!Number.isFinite(epochMs)) throw new Error(`${path}.deadline must be a valid timestamp`);
  return { value: formatBeijingTimestamp(epochMs), original, epochMs };
}

function factText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
    return items.length > 0 ? items.join('、') : undefined;
  }
  return undefined;
}

function factGroup(
  row: JsonObject,
  fields: ReadonlyArray<{ key: string; label: string }>,
): FieldFactGroup {
  const values = fields.flatMap(({ key, label }) => {
    const value = factText(row[key]);
    return value === undefined ? [] : [{ label, value }];
  });
  if (values.some(({ value }) => containsPrivateFreeText(value))) {
    return { status: 'unverified', summary: '待官方公布' };
  }
  if (values.some(({ value }) => unverifiedPattern.test(value))) {
    return { status: 'unverified', summary: '待官方公布' };
  }
  const confirmed = values.filter(({ value }) => !notPublishedPattern.test(value));
  if (confirmed.length === 0) {
    return { status: 'not-published', summary: '未公布' };
  }
  return {
    status: 'confirmed',
    summary: confirmed.map(({ label, value }) => `${label}：${value}`).join('；'),
  };
}

function mapRow(
  row: JsonObject,
  path: string,
  expired: boolean,
  scanAt: string,
  identityIndex: IdentityIndex,
  currentByUrl: Map<string, CurrentUrlIdentity>,
): MappedOpportunity {
  const inputProjectId = requiredString(row, 'projectId', path);
  const parsedId = parseProjectId(inputProjectId, path);
  const cycle = parseCycle(row.cycle, path, expired, parsedId.cycle);
  const school = requiredString(row, 'school', path);
  const project = requiredString(row, 'project', path);
  const officialUrl = requiredString(row, 'officialUrl', path);
  const normalizedOfficialUrl = normalizeUrl(officialUrl, `${path}.officialUrl`);
  const resolvedProjectId = resolveProjectId(
    identityIndex,
    currentByUrl,
    normalizedOfficialUrl,
    inputProjectId,
    cycle,
    path,
  );

  let verificationStatus: VerificationStatus;
  if (expired) {
    if (row.verificationStatus !== 'expired') {
      throw new Error(`${path}.verificationStatus must be exactly expired`);
    }
    verificationStatus = 'expired';
  } else if (
    row.verificationStatus === 'confirmed-open'
    || row.verificationStatus === 'confirmed-unknown-deadline'
  ) {
    verificationStatus = row.verificationStatus;
  } else {
    throw new Error(
      `${path}.verificationStatus must be confirmed-open or confirmed-unknown-deadline`,
    );
  }

  const normalizedDeadline = normalizeDeadline(row.deadline, row.deadlineOriginal, path);
  if (!expired) requiredString(row, 'deadlineOriginal', path);

  const discoverySources: PublicOpportunity['discoverySources'] = [
    { kind: 'official', label: '官方链接', url: officialUrl },
  ];
  const baoyanNoticeUrl = optionalString(row, 'baoyanNoticeUrl');
  if (baoyanNoticeUrl !== undefined) {
    discoverySources.push({
      kind: 'baoyan-notice',
      label: '保研通知网',
      url: baoyanNoticeUrl,
    });
  }

  return {
    cycle,
    opportunity: {
      projectId: resolvedProjectId,
      feedId: `camp${cycle}`,
      name: school,
      institute: parsedId.institute,
      project,
      eventType: expired
        ? optionalString(row, 'eventType') ?? '已过期活动'
        : requiredString(row, 'eventType', path),
      description: project,
      verificationStatus,
      deadline: normalizedDeadline.value,
      deadlineOriginal: normalizedDeadline.original,
      deadlineEpochMs: normalizedDeadline.epochMs,
      website: officialUrl,
      tags: [],
      verifiedAt: expired
        ? optionalString(row, 'verifiedAt') ?? scanAt
        : requiredString(row, 'verifiedAt', path),
      discoverySources,
      logistics: factGroup(row, [
        { key: 'accommodation', label: '住宿' },
        { key: 'meals', label: '餐食' },
        { key: 'transport', label: '交通' },
        { key: 'reimbursement', label: '报销' },
      ]),
      recommendation: factGroup(row, [
        { key: 'recommendationLetters', label: '推荐信数量' },
        { key: 'recommendationTemplate', label: '推荐信模板' },
      ]),
      materials: factGroup(row, [
        { key: 'materialComplexity', label: '材料复杂度' },
        { key: 'materialList', label: '材料清单' },
      ]),
    },
  };
}

function opportunityOrder(left: PublicOpportunity, right: PublicOpportunity): number {
  const rank = (status: VerificationStatus): number => {
    if (status === 'confirmed-open') return 0;
    if (status === 'confirmed-unknown-deadline') return 1;
    return 2;
  };
  const rankDifference = rank(left.verificationStatus) - rank(right.verificationStatus);
  if (rankDifference !== 0) return rankDifference;
  if (
    left.verificationStatus === 'confirmed-open'
    && right.verificationStatus === 'confirmed-open'
  ) {
    const deadlineDifference = (left.deadlineEpochMs ?? 0) - (right.deadlineEpochMs ?? 0);
    if (deadlineDifference !== 0) return deadlineDifference;
  }
  if (left.projectId < right.projectId) return -1;
  if (left.projectId > right.projectId) return 1;
  return 0;
}

export function importScoutingData(
  input: unknown,
  identities: IdentityContext,
): SnapshotCandidate {
  const dataset = objectValue(input, 'scouting data');
  const scanAt = requiredString(dataset, 'scanAt', 'scouting data');
  const scanAtMs = Date.parse(scanAt);
  if (!Number.isFinite(scanAtMs)) throw new Error('scouting data.scanAt must be a valid timestamp');
  const eventYear = new Date(scanAtMs + beijingOffsetMs).getUTCFullYear();

  const mainRows = rowArray(dataset, 'mainRows');
  const expiredRows = rowArray(dataset, 'expiredRows');
  const pendingRows = rowArray(dataset, 'pendingRows');
  const currentByUrl = buildCurrentUrlIdentities(mainRows, expiredRows);
  const identityIndex = identityMaps(identities);
  validateSharedUrlAliasCoverage(identityIndex, currentByUrl);

  const active = mainRows.map((row, index) =>
    mapRow(row, `mainRows[${index}]`, false, scanAt, identityIndex, currentByUrl));
  const expired = expiredRows.map((row, index) =>
    mapRow(row, `expiredRows[${index}]`, true, scanAt, identityIndex, currentByUrl));
  if (active.length === 0) {
    throw new Error('mainRows must contain an active row to select the default feed');
  }

  const mapped = [...active, ...expired];
  const projectIds = new Set<string>();
  for (const { opportunity } of mapped) {
    if (projectIds.has(opportunity.projectId)) {
      throw new Error(`duplicate resolved projectId: ${opportunity.projectId}`);
    }
    projectIds.add(opportunity.projectId);
  }

  const cycles = [...new Set(mapped.map(({ cycle }) => cycle))]
    .sort((left, right) => Number(left) - Number(right));
  const newestActiveCycle = active
    .map(({ cycle }) => cycle)
    .sort((left, right) => Number(right) - Number(left))[0];
  const opportunities = mapped
    .map(({ opportunity }) => opportunity)
    .sort(opportunityOrder);
  const candidate: SnapshotCandidate = {
    schemaVersion: 1,
    scanAt,
    defaultFeedId: `camp${newestActiveCycle}`,
    feeds: cycles.map((cycle) => ({
      id: `camp${cycle}`,
      label: `推免活动 ${cycle}`,
      admissionCycle: cycle,
      eventYear,
    })),
    counts: {
      confirmedOpen: opportunities.filter(
        ({ verificationStatus }) => verificationStatus === 'confirmed-open',
      ).length,
      confirmedUnknownDeadline: opportunities.filter(
        ({ verificationStatus }) => verificationStatus === 'confirmed-unknown-deadline',
      ).length,
      pendingExcluded: pendingRows.length,
      expired: opportunities.filter(
        ({ verificationStatus }) => verificationStatus === 'expired',
      ).length,
    },
    opportunities,
  };

  if (candidateContainsPrivateFreeText(candidate)) {
    throw new Error('Candidate contains a private marker in a public field');
  }

  const validationErrors = validateCandidate(candidate, Date.parse(candidate.scanAt));
  if (validationErrors.length > 0) {
    throw new Error(`Candidate validation failed:\n${validationErrors.join('\n')}`);
  }
  return candidate;
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set(['--input', '--aliases', '--output', '--approved']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(
        'Usage: snapshot:import -- --input ABSOLUTE_PATH --aliases PATH --output PATH [--approved PATH]',
      );
    }
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  const input = values.get('--input');
  const aliases = values.get('--aliases');
  const output = values.get('--output');
  if (input === undefined || aliases === undefined || output === undefined) {
    throw new Error(
      'Usage: snapshot:import -- --input ABSOLUTE_PATH --aliases PATH --output PATH [--approved PATH]',
    );
  }
  if (!isAbsolute(input)) throw new Error('--input must be an absolute path');
  return { input, aliases, output, approved: values.get('--approved') };
}

async function readJson(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} could not be read at ${path}: ${String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${path}: ${String(error)}`);
  }
}

async function readOptionalApproved(path: string | undefined): Promise<PublicSnapshot | null> {
  if (path === undefined) return null;
  return await readJson(path, 'approved snapshot') as PublicSnapshot;
}

function aliasesFrom(input: unknown): Record<string, string> {
  const object = objectValue(input, 'aliases');
  const aliases: Record<string, string> = {};
  for (const [url, projectId] of Object.entries(object)) {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error(`aliases.${url} must be a non-empty project ID`);
    }
    aliases[url] = projectId;
  }
  return aliases;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

async function assertSafeOutputPaths(options: CliOptions): Promise<void> {
  const outputPath = resolve(options.output);
  const protectedPaths = [
    { flag: '--input', path: resolve(options.input) },
    { flag: '--aliases', path: resolve(options.aliases) },
    ...(options.approved === undefined
      ? []
      : [{ flag: '--approved', path: resolve(options.approved) }]),
  ];

  for (const protectedPath of protectedPaths) {
    if (outputPath === protectedPath.path) {
      throw new Error(`--output collides with ${protectedPath.flag}`);
    }
  }

  let outputInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    outputInfo = await lstat(outputPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  if (outputInfo.isSymbolicLink()) {
    throw new Error('--output must not be an existing symlink');
  }
  if (!outputInfo.isFile()) {
    throw new Error('--output must be absent or an existing regular file');
  }

  const outputStat = await stat(outputPath);
  for (const protectedPath of protectedPaths) {
    const protectedStat = await stat(protectedPath.path);
    if (outputStat.dev === protectedStat.dev && outputStat.ino === protectedStat.ino) {
      throw new Error(`--output collides with ${protectedPath.flag} by inode`);
    }
  }
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

export async function writeCandidateAtomically(
  path: string,
  candidate: SnapshotCandidate,
  signal?: AbortSignal,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Atomic candidate write aborted before rename');
    }
    await rename(tempPath, path);
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await removeTempFile(tempPath);
  }
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseCliOptions(argv);
  const [input, aliasInput, previous] = await Promise.all([
    readJson(options.input, 'scouting input'),
    readJson(options.aliases, 'project ID aliases'),
    readOptionalApproved(options.approved),
  ]);
  await assertSafeOutputPaths(options);
  const candidate = importScoutingData(input, {
    previous,
    aliases: aliasesFrom(aliasInput),
  });
  const freshnessErrors = validateCandidate(candidate, Date.now());
  if (freshnessErrors.length > 0) {
    throw new Error(`Candidate freshness validation failed:\n${freshnessErrors.join('\n')}`);
  }
  await writeCandidateAtomically(options.output, candidate);
  console.log(`Imported ${candidate.opportunities.length} opportunities to ${options.output}`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  runCli().catch((error: unknown) => {
    console.error(`snapshot import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
