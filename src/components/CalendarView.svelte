<script lang="ts">
  import { ChevronLeft, ChevronRight, CalendarRange } from 'lucide-svelte';
  import { tick } from 'svelte';
  import type { DerivedSchool } from '$lib/types';
  import { pickCalendarMonth, rowKey } from '$lib/filter';
  import { dateKey, startOfDay } from '$lib/time';
  import { clock } from '$lib/clock.svelte';

  let { rows, feedId, onSelect }: {
    rows: DerivedSchool[];
    feedId: string;
    onSelect: (key: string) => void;
  } = $props();

  // current visible month — initialise to the month of the earliest live deadline
  function pickInitialMonth(): { y: number; m: number } {
    return pickCalendarMonth(rows, clock.now);
  }

  let cursor = $state(pickInitialMonth());
  let visibleFeedId = $state<string>();
  let expandedDayKey = $state<string | null>(null);
  let expandedItemButtons = $state<HTMLButtonElement[]>([]);

  $effect(() => {
    if (visibleFeedId === undefined) {
      visibleFeedId = feedId;
      return;
    }
    if (feedId === visibleFeedId) return;
    clearExpandedDay();
    visibleFeedId = feedId;
    cursor = pickInitialMonth();
  });

  // Urgency changes every second, but date grouping only depends on identity + deadline.
  const groupingSignature = $derived(
    JSON.stringify(rows.map((r) => ({ key: rowKey(r), deadlineMs: r.deadlineMs }))),
  );
  const rowsByKey = $derived.by(() => new Map(rows.map((r) => [rowKey(r), r])));
  let cachedGrouping: { signature: string; groups: Map<string, string[]> } = {
    signature: '',
    groups: new Map(),
  };
  const groupedRowKeys = $derived.by(() => {
    if (cachedGrouping.signature === groupingSignature) return cachedGrouping.groups;
    const map = new Map<string, Array<{ key: string; deadlineMs: number }>>();
    const groupingRows = JSON.parse(groupingSignature) as Array<{
      key: string;
      deadlineMs: number | null;
    }>;
    for (const r of groupingRows) {
      const deadlineMs = r.deadlineMs;
      if (deadlineMs === null) continue;
      const entry = { key: r.key, deadlineMs };
      const k = dateKey(deadlineMs);
      const arr = map.get(k);
      if (arr) arr.push(entry);
      else map.set(k, [entry]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.deadlineMs - b.deadlineMs);
    }
    const groups = new Map(
      [...map].map(([key, entries]) => [key, entries.map((entry) => entry.key)]),
    );
    cachedGrouping = { signature: groupingSignature, groups };
    return groups;
  });

  function rowsForDay(key: string): DerivedSchool[] {
    return (groupedRowKeys.get(key) ?? [])
      .map((rowId) => rowsByKey.get(rowId))
      .filter((row): row is DerivedSchool => row !== undefined);
  }

  const expandedItems = $derived(expandedDayKey === null ? [] : rowsForDay(expandedDayKey));

  $effect(() => {
    if (expandedDayKey !== null && (groupedRowKeys.get(expandedDayKey)?.length ?? 0) === 0) {
      clearExpandedDay();
    }
  });

  const grid = $derived.by(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const startDow = first.getDay(); // 0=Sun
    // we want week starting on Monday for CN audience
    const offset = (startDow + 6) % 7;
    const start = new Date(cursor.y, cursor.m, 1 - offset);
    const cells: { ms: number; key: string; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const ms = d.getTime();
      cells.push({
        ms,
        key: dateKey(ms),
        inMonth: d.getMonth() === cursor.m,
      });
    }
    return cells;
  });

  const todayKey = $derived(dateKey(startOfDay(clock.now)));

  const monthLabel = $derived(`${cursor.y} 年 ${cursor.m + 1} 月`);

  function clearExpandedDay() {
    expandedDayKey = null;
  }

  async function toggleDay(key: string) {
    const opening = expandedDayKey !== key;
    expandedDayKey = expandedDayKey === key ? null : key;
    if (!opening) return;
    await tick();
    expandedItemButtons[0]?.focus();
  }

  function dayDetailsId(key: string) {
    return `deadline-calendar-day-${key}`;
  }

  function dayLabel(key: string) {
    const [year, month, day] = key.split('-').map(Number);
    return `${year}年${month}月${day}日`;
  }

  function prev() {
    clearExpandedDay();
    const m = cursor.m === 0 ? 11 : cursor.m - 1;
    const y = cursor.m === 0 ? cursor.y - 1 : cursor.y;
    cursor = { y, m };
  }
  function next() {
    clearExpandedDay();
    const m = cursor.m === 11 ? 0 : cursor.m + 1;
    const y = cursor.m === 11 ? cursor.y + 1 : cursor.y;
    cursor = { y, m };
  }
  function jumpToday() {
    clearExpandedDay();
    const d = new Date(clock.now);
    cursor = { y: d.getFullYear(), m: d.getMonth() };
  }

  const wd = ['一', '二', '三', '四', '五', '六', '日'];

  function pillClass(r: DerivedSchool): string {
    return `urge-${r.urgency}`;
  }
  function dotClass(r: DerivedSchool): string {
    return `bg-urge-${r.urgency}`;
  }
</script>

<section aria-label="截止日历" class="surface-1 border border-line rounded-xl overflow-hidden flex flex-col min-w-0">
  <!-- header -->
  <div class="px-4 py-2.5 border-b border-line flex items-center gap-3 surface-2">
    <CalendarRange class="w-4 h-4 text-fg-2" />
    <div class="text-fg-0 font-medium tabular">{monthLabel}</div>
    <div class="flex-1"></div>
    <button class="px-2.5 py-1 text-xs text-fg-1 hover:surface-3 rounded transition" onclick={jumpToday}>
      今日
    </button>
    <div class="flex items-center gap-0.5">
      <button class="p-1 rounded hover:surface-3 transition" onclick={prev} aria-label="上个月">
        <ChevronLeft class="w-4 h-4 text-fg-1" />
      </button>
      <button class="p-1 rounded hover:surface-3 transition" onclick={next} aria-label="下个月">
        <ChevronRight class="w-4 h-4 text-fg-1" />
      </button>
    </div>
  </div>

  <!-- weekday header -->
  <div class="grid grid-cols-7 border-b border-line">
    {#each wd as w}
      <div class="text-fg-3 text-[10.5px] uppercase tracking-[0.16em] text-center py-1.5">{w}</div>
    {/each}
  </div>

  <!-- grid -->
  <div class="grid grid-cols-7 grid-rows-6 flex-1 min-h-[640px]">
    {#each grid as cell, i}
      {@const items = rowsForDay(cell.key)}
      {@const isToday = cell.key === todayKey}
      <div
        class="relative border-r border-b border-line p-1.5 sm:p-2 flex flex-col gap-1 min-h-[88px] {cell.inMonth ? '' : 'surface-2'} {(i + 1) % 7 === 0 ? 'border-r-0' : ''} {i >= 35 ? 'border-b-0' : ''}"
      >
        <div class="flex items-center justify-between">
          <span data-calendar-date class="text-[11px] tabular {isToday ? 'urge-far font-semibold' : 'text-fg-2'}">
            {new Date(cell.ms).getDate()}
          </span>
          {#if items.length > 0}
            <button
              type="button"
              data-calendar-day-trigger
              class="inline-flex items-center justify-center min-w-6 min-h-6 px-1 text-[10px] text-fg-2 hover:text-fg-0 tabular rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 {items.length <= 3 ? 'sm:hidden' : ''}"
              onclick={() => toggleDay(cell.key)}
              aria-label="{expandedDayKey === cell.key ? '收起' : '展开'} {dayLabel(cell.key)}全部 {items.length} 个截止项目"
              aria-expanded={expandedDayKey === cell.key}
              aria-controls={dayDetailsId(cell.key)}
            >{items.length > 3 ? `+${items.length - 3}` : `${items.length}项`}</button>
          {/if}
        </div>
        <div class="hidden sm:flex flex-col gap-0.5 min-h-0">
          {#each items.slice(0, 3) as r (rowKey(r))}
            <button
              type="button"
              data-calendar-preview
              onclick={() => onSelect(rowKey(r))}
              aria-haspopup="dialog"
              aria-label="查看 {dayLabel(cell.key)}截止项目详情：{r.name} {r.institute} {r.project}"
              class="group min-w-0 text-left flex items-center gap-1.5 surface-2 hover:surface-3 transition rounded-md px-1.5 py-1 border border-transparent hover:border-line"
              title="{r.name} · {r.institute} · {r.project}"
            >
              <span class="w-1 h-1 rounded-full shrink-0 {dotClass(r)}"></span>
              <span class="text-[11px] {pillClass(r)} truncate">{r.name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>

  {#if expandedDayKey !== null}
    <section
      id={dayDetailsId(expandedDayKey)}
      aria-label="{dayLabel(expandedDayKey)}全部截止项目"
      class="min-w-0 border-t border-line"
    >
      <div class="px-3 sm:px-4 py-2.5 surface-2 flex items-baseline gap-2 min-w-0">
        <h2 class="text-sm font-medium text-fg-0 min-w-0">{dayLabel(expandedDayKey)}截止项目</h2>
        <span data-calendar-expanded-count class="text-xs text-fg-2 tabular shrink-0">{expandedItems.length} 项</span>
      </div>
      <ul class="min-w-0 divide-y divide-line">
        {#each expandedItems as r, index (rowKey(r))}
          <li class="min-w-0">
            <button
              bind:this={expandedItemButtons[index]}
              type="button"
              onclick={() => onSelect(rowKey(r))}
              aria-haspopup="dialog"
              aria-label="查看截止项目详情：{r.name} {r.project}"
              class="w-full min-w-0 px-3 sm:px-4 py-2.5 text-left hover:surface-2 focus-visible:surface-2 transition grid grid-cols-1 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-0.5 sm:gap-3"
            >
              <span class="min-w-0 text-sm text-fg-0 break-words">{r.name}<span class="text-fg-3"> · {r.institute}</span></span>
              <span class="min-w-0 text-xs sm:text-sm text-fg-1 break-words">{r.project}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>
