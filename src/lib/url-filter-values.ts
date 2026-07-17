import { STATUS_TAGS, type StatusTag } from './types';

const LEGACY_STATUS_MAP: Record<string, StatusTag> = {
  已开营: '开放',
  已结营: '已结束',
};

export function parseStatusList(value: string | null): StatusTag[] {
  if (!value) return [];
  const allowed = new Set<string>(STATUS_TAGS);
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => LEGACY_STATUS_MAP[item] ?? item)
    .filter((item): item is StatusTag => allowed.has(item));
  return [...new Set(parsed)];
}
