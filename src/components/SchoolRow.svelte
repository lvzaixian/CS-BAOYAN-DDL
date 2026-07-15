<script lang="ts">
  import { Archive, BadgeCheck, ExternalLink } from 'lucide-svelte';
  import type { DerivedSchool } from '$lib/types';
  import { formatRemainingShort, formatDateShort, progressAgainst } from '$lib/time';
  import { expiredDeadlineText, rowKey, sourceLinkLabel } from '$lib/filter';
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
  const expired = $derived(school.urgency === 'expired');
  const relativeDeadline = $derived(expiredDeadlineText(school));
  const sourceLabel = $derived(sourceLinkLabel(school));
  const verificationLabel = $derived(
    school.verificationStatus === 'expired' ? '已过期' : '已核验',
  );
  const displayTags = $derived(
    school.tags.filter((tag) => tag !== '已开营' && tag !== '已结营'),
  );

  let imgFailed = $state(false);
</script>

<div
  data-row-key={key}
  data-deadline-ms={school.deadlineMs ?? undefined}
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
    aria-pressed={selected}
    aria-label="查看项目详情：{school.name} {school.institute}"
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
        <span class="text-fg-0 font-medium text-sm truncate">{school.name}</span>
        <span class="text-fg-3 text-xs truncate">{school.institute}</span>
      </div>
      <div class="flex items-center gap-1.5 flex-wrap min-h-[18px]">
        <span
          class="inline-flex items-center gap-1 text-[10.5px] font-medium px-1.5 py-0.5 rounded ring-1
            {expired
              ? 'bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-500/15 dark:text-fg-3 dark:ring-zinc-500/30'
              : 'bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30'}"
          aria-label="核验状态：{verificationLabel}"
        >
          {#if expired}
            <Archive class="w-3 h-3" aria-hidden="true" />
          {:else}
            <BadgeCheck class="w-3 h-3" aria-hidden="true" />
          {/if}
          {verificationLabel}
        </span>
        {#each displayTags as t}
          <span
            class="inline-block text-[10.5px] tracking-tight font-medium px-1.5 py-0.5 rounded
              {t === 'TOP2' ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30'
              : t === '港三' || t === '华五' ? 'bg-fuchsia-100 text-fuchsia-700 ring-1 ring-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:ring-fuchsia-500/30'
              : t === 'C9' ? 'bg-violet-100 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30'
              : t === '985' ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30'
              : t === '211' ? 'bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-cyan-500/30'
              : 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-500/10 dark:text-fg-2 dark:ring-zinc-500/20'}"
          >{t}</span>
        {/each}
        {#if province}
          <span class="text-fg-4 text-[10.5px]">· {province}</span>
        {/if}
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
    aria-label="打开 {school.name} {sourceLabel}"
    title={sourceLabel}
  >
    <ExternalLink class="w-3.5 h-3.5" />
  </a>
</div>
