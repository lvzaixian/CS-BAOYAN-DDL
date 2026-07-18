<script lang="ts">
  import {
    CircleHelp,
    ExternalLink,
    GitMerge,
    MapPin,
    Monitor,
  } from 'lucide-svelte';
  import type { DerivedSchool } from '$lib/types';
  import { formatRemainingShort, formatDateShort, progressAgainst } from '$lib/time';
  import {
    eventModeLabel,
    expiredDeadlineText,
    rowKey,
  } from '$lib/filter';
  import { getInitials, getLogoUrl } from '$lib/logos';
  import { resolveProvince } from '$data/provinces';

  let { school, selected, onSelect }: {
    school: DerivedSchool;
    selected: boolean;
    onSelect: (key: string) => void;
  } = $props();

  const key = $derived(rowKey(school));
  const logo = $derived(getLogoUrl(school.name));
  const province = $derived(resolveProvince(school.name, school.province));
  const progress = $derived(progressAgainst(school.remainingMs, 90));
  const urgeClass = $derived(`urge-${school.urgency}`);
  const urgeBgClass = $derived(`bg-urge-${school.urgency}`);
  const relativeDeadline = $derived(expiredDeadlineText(school));
  const modeLabel = $derived(eventModeLabel(school.eventArrangement.mode));
  const displayTags = $derived(
    school.tags.filter((tag) => tag !== '已开营' && tag !== '已结营'),
  );

  let imgFailed = $state(false);
</script>

<div
  data-row-key={key}
  data-deadline-ms={school.deadlineMs ?? undefined}
  data-layout="compact-two-line"
  class="group w-full grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:gap-4 px-3 sm:px-4 transition relative overflow-hidden
    {selected ? 'surface-3' : 'hover:surface-2'}"
>
  <!-- selected indicator -->
  <span
    class="absolute left-0 top-0 bottom-0 w-[3px] {selected ? urgeBgClass : 'bg-transparent'} transition"
    aria-hidden="true"
  ></span>

  <button
    type="button"
    onclick={() => onSelect(key)}
    aria-haspopup="dialog"
    aria-label="查看项目详情：{school.name} {school.institute} {school.project}"
    class="w-full min-w-0 text-left grid grid-cols-[40px_minmax(0,1fr)_auto] sm:grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 sm:gap-4 py-3"
  >
    <!-- logo -->
    <div class="w-10 h-10 sm:w-11 sm:h-11 shrink-0 rounded-lg surface-2 border border-line grid place-items-center overflow-hidden">
      {#if logo && !imgFailed}
        <img
          src={logo}
          alt=""
          class="w-full h-full object-contain"
          loading="lazy"
          onerror={() => (imgFailed = true)}
        />
      {:else}
        <span class="text-fg-2 text-[11px] font-medium tracking-tight">{getInitials(school.name)}</span>
      {/if}
    </div>

    <!-- main: name + meta -->
    <div class="min-w-0 flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2 min-w-0">
        <span class="text-fg-0 font-medium text-sm shrink-0 max-w-[68%] sm:max-w-[38%] truncate">{school.name}</span>
        <span class="text-fg-3 text-xs min-w-0 truncate">{school.institute}</span>
      </div>
      <div class="flex items-center gap-1.5 min-w-0 overflow-hidden min-h-[18px]">
        {#each displayTags as t}
          <span
            class="inline-block shrink-0 text-[10.5px] tracking-tight font-medium px-1.5 py-0.5 rounded
              {t === 'TOP2' ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30'
              : t === '港三' || t === '华五' ? 'bg-fuchsia-100 text-fuchsia-700 ring-1 ring-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:ring-fuchsia-500/30'
              : t === 'C9' ? 'bg-violet-100 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30'
              : t === '985' ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30'
              : t === '211' ? 'bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-cyan-500/30'
              : 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-500/10 dark:text-fg-2 dark:ring-zinc-500/20'}"
          >{t}</span>
        {/each}
        {#if province}
          <span class="shrink-0 text-fg-4 text-[10.5px]" aria-label="院校所在地：{province}">
            · {province}
          </span>
        {/if}
        <span
          class="inline-flex shrink-0 items-center gap-1 text-fg-3 text-[10.5px]"
          aria-label="活动形式：{modeLabel}"
        >
          ·
          {#if school.eventArrangement.mode === 'online'}
            <Monitor class="w-3 h-3" aria-hidden="true" />
          {:else if school.eventArrangement.mode === 'offline'}
            <MapPin class="w-3 h-3" aria-hidden="true" />
          {:else if school.eventArrangement.mode === 'hybrid'}
            <GitMerge class="w-3 h-3" aria-hidden="true" />
          {:else}
            <CircleHelp class="w-3 h-3" aria-hidden="true" />
          {/if}
          {modeLabel}
        </span>
        <span class="min-w-0 truncate text-fg-4 text-[10.5px]">· {school.eventType}</span>
      </div>
    </div>

    <!-- progress + countdown -->
    <div class="hidden sm:flex flex-col items-end gap-1.5 w-32 shrink-0">
      <div class="text-fg-0 text-sm font-medium tabular {urgeClass}">
        {relativeDeadline ?? formatRemainingShort(school.remainingMs)}
      </div>
      <div class="w-full h-1 surface-2 rounded-full overflow-hidden">
        <div
          class="h-full {urgeBgClass} transition-all"
          style="width: {progress * 100}%"
        ></div>
      </div>
      <div class="text-fg-4 text-[10px] tabular">{formatDateShort(school.deadlineMs)}</div>
    </div>

    <!-- mobile compact countdown -->
    <div class="sm:hidden flex flex-col items-end shrink-0">
      <div class="text-sm tabular font-medium {urgeClass}">
        {relativeDeadline ?? formatRemainingShort(school.remainingMs)}
      </div>
      <div class="text-fg-4 text-[10px] tabular">{formatDateShort(school.deadlineMs)}</div>
    </div>
  </button>

  <a
    href={school.website}
    target="_blank"
    rel="noopener noreferrer"
    class="hidden sm:inline-flex shrink-0 p-1.5 rounded text-fg-3 hover:text-fg-0 hover:surface-3 transition"
    aria-label="打开 {school.name} 官网"
    title="打开官网"
  >
    <ExternalLink class="w-3.5 h-3.5" />
  </a>
</div>
