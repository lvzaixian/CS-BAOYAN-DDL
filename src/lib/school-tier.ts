import { SCHOOL_TAGS, type SchoolTag } from './types';

const TIER_PRIORITY: readonly SchoolTag[] = [
  'TOP2',
  '港三',
  '华五',
  'C9',
  '985',
  '211',
  '研究院',
  '联培',
  '双非',
  '四非',
];

const RESEARCH_INSTITUTE_PATTERN = /(?:中国科学院|中国农业科学院|研究所|研究院|实验室|科学中心|天文台|国家空间科学中心|空间技术研究院)/;

function preferredTier(tags: readonly string[]): SchoolTag | null {
  const values = new Set(tags);
  return TIER_PRIORITY.find((tag) => values.has(tag)) ?? null;
}

/** Resolve one mutually exclusive tier, matching the reference site's list hierarchy. */
export function resolveSchoolTierTags(
  schoolName: string,
  explicitTags: readonly string[],
  historicalTags: readonly string[],
): SchoolTag[] {
  const explicit = preferredTier(explicitTags);
  if (explicit) return [explicit];

  const historical = preferredTier(historicalTags);
  if (historical) return [historical];

  if (RESEARCH_INSTITUTE_PATTERN.test(schoolName)) return ['研究院'];
  return [];
}

export function isSchoolTier(value: string): value is SchoolTag {
  return SCHOOL_TAGS.includes(value as SchoolTag);
}
