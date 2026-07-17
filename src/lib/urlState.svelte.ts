import type { FilterState, ViewMode } from './types';
import { EVENT_MODES } from './snapshot-types';
import { defaultFeedId, isValidFeedId } from './schools';
import { parseStatusList } from './url-filter-values';

const DEFAULT: FilterState = {
  source: defaultFeedId,
  view: 'list',
  query: '',
  tags: [],
  status: [],
  modes: [],
  provinces: [],
};

const VALID_VIEWS = new Set<ViewMode>(['list', 'calendar']);

function readFromUrl(): FilterState {
  if (typeof window === 'undefined') return { ...DEFAULT };
  const p = new URLSearchParams(window.location.search);
  const src = p.get('src');
  const v = p.get('view') as ViewMode | null;
  return {
    source: src && isValidFeedId(src) ? src : DEFAULT.source,
    view: v && VALID_VIEWS.has(v) ? v : DEFAULT.view,
    query: p.get('q') ?? '',
    tags: parseList(p.get('tags')) as FilterState['tags'],
    status: parseStatusList(p.get('status')),
    modes: parseEnumList(p.get('modes'), EVENT_MODES),
    provinces: parseList(p.get('prov')),
  };
}

function parseList(v: string | null): string[] {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseEnumList<T extends string>(v: string | null, allowed: readonly T[]): T[] {
  const allowedValues = new Set(allowed);
  return [...new Set(parseList(v).filter((value): value is T => allowedValues.has(value as T)))];
}

function writeToUrl(s: FilterState, method: 'push' | 'replace') {
  if (typeof window === 'undefined') return;
  const p = new URLSearchParams();
  if (s.source !== DEFAULT.source) p.set('src', s.source);
  if (s.view !== DEFAULT.view) p.set('view', s.view);
  if (s.query) p.set('q', s.query);
  if (s.tags.length) p.set('tags', s.tags.join(','));
  if (s.status.length) p.set('status', s.status.join(','));
  if (s.modes.length) p.set('modes', s.modes.join(','));
  if (s.provinces.length) p.set('prov', s.provinces.join(','));
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  if (`${window.location.pathname}${window.location.search}` === url) return;
  if (method === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

function discreteStateKey(s: FilterState): string {
  return JSON.stringify([s.source, s.view, s.tags, s.status, s.modes, s.provinces]);
}

export const filters: FilterState = $state(readFromUrl());

let activeCleanup: (() => void) | null = null;
export function initFilterSync(): () => void {
  activeCleanup?.();
  let previousDiscreteState: string | null = null;

  const stopRoot = $effect.root(() => {
    $effect(() => {
      const next = {
        source: filters.source,
        view: filters.view,
        query: filters.query,
        tags: filters.tags,
        status: filters.status,
        modes: filters.modes,
        provinces: filters.provinces,
      };
      const discreteState = discreteStateKey(next);
      const method = previousDiscreteState === null || discreteState === previousDiscreteState
        ? 'replace'
        : 'push';
      writeToUrl(next, method);
      previousDiscreteState = discreteState;
    });
  });

  const onPopState = () => {
    const next = readFromUrl();
    writeToUrl(next, 'replace');
    filters.source = next.source;
    filters.view = next.view;
    filters.query = next.query;
    filters.tags = next.tags;
    filters.status = next.status;
    filters.modes = next.modes;
    filters.provinces = next.provinces;
  };
  window.addEventListener('popstate', onPopState);

  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    stopRoot();
    window.removeEventListener('popstate', onPopState);
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  return cleanup;
}

export function clearAllFilters() {
  filters.query = '';
  filters.tags = [];
  filters.status = [];
  filters.modes = [];
  filters.provinces = [];
}

export function toggle<T extends string>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}
