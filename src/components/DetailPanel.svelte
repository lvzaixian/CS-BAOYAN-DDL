<script lang="ts">
  import {
    BedDouble,
    CalendarClock,
    CircleAlert,
    ExternalLink,
    Files,
    LetterText,
    MapPin,
    X,
  } from 'lucide-svelte';
  import { onMount, tick } from 'svelte';
  import type { DerivedSchool } from '$lib/types';
  import type { FactStatus } from '$lib/snapshot-types';
  import { formatDate } from '$lib/time';
  import { eventModeLabel } from '$lib/filter';
  import { getInitials, getLogoUrl } from '$lib/logos';
  import { resolveProvince } from '$data/provinces';

  const factStatusLabels: Record<FactStatus, string> = {
    confirmed: '已核验',
    'not-published': '未公布',
    unverified: '未核验',
    'not-applicable': '不适用',
  };
  let { school, onClose }: { school: DerivedSchool; onClose: () => void } = $props();

  const logo = $derived(getLogoUrl(school.name));
  const province = $derived(resolveProvince(school.name, school.province));
  const officialDeadline = $derived(
    school.deadlineOriginal.trim()
      || (school.deadlineMs === null ? '未公布' : formatDate(school.deadlineMs)),
  );
  const modeLabel = $derived(eventModeLabel(school.eventArrangement.mode));
  const officialSources = $derived(
    school.discoverySources.filter((source) => source.kind === 'official'),
  );
  const primaryOfficialSource = $derived(officialSources[0] ?? null);

  let imgFailed = $state(false);
  let panel = $state<HTMLElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);

  onMount(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    void tick().then(() => closeButton?.focus());
    return () => queueMicrotask(() => returnFocus?.focus());
  });

  function onDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div class="fixed inset-0 z-40 fade">
  <button
    class="absolute inset-0 bg-black/50 backdrop-blur-[3px]"
    onclick={onClose}
    aria-hidden="true"
    tabindex="-1"
  ></button>

  <div
    bind:this={panel}
    role="dialog"
    aria-modal="true"
    aria-label="项目详情"
    tabindex="-1"
    onkeydown={onDialogKeydown}
    class="detail-panel absolute right-0 top-0 bottom-0 w-full sm:w-[460px] min-w-0 max-w-full overflow-hidden surface-1 border-l border-line shadow-2xl slide-in-right flex flex-col"
  >
    <!-- header bar -->
    <div class="px-5 py-4 border-b border-line flex items-start gap-3 min-w-0">
      <div class="w-12 h-12 shrink-0 rounded-lg surface-2 border border-line grid place-items-center overflow-hidden">
        {#if logo && !imgFailed}
          <img
            src={logo}
            alt=""
            class="w-full h-full object-contain"
            loading="lazy"
            onerror={() => (imgFailed = true)}
          />
        {:else}
          <span class="text-fg-2 text-[12px] font-medium tracking-tight">{getInitials(school.name)}</span>
        {/if}
      </div>
      <div class="min-w-0 flex-1 detail-wrap">
        <div class="text-fg-0 font-semibold text-base leading-tight">{school.name}</div>
        <div class="text-fg-2 text-sm mt-0.5">{school.institute}</div>
        <div class="text-fg-1 text-sm mt-1">{school.project}</div>
        <div class="text-fg-3 text-xs mt-0.5">{school.eventType}</div>
        {#if province}
          <div class="text-fg-4 text-xs mt-1">院校所在地：{province}</div>
        {/if}
      </div>
      <button
        bind:this={closeButton}
        onclick={onClose}
        class="shrink-0 p-1.5 rounded text-fg-3 hover:text-fg-1 hover:surface-3 transition"
        aria-label="关闭项目详情"
        title="关闭 (Esc)"
      >
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- body -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="detail-panel__body flex-1 min-w-0 overflow-y-auto overflow-x-hidden"
      role="region"
      tabindex="0"
      aria-label="项目详情内容"
    >
      <section class="detail-section px-5 py-4 border-b border-line" aria-labelledby="deadline-heading">
        <h2 id="deadline-heading" class="detail-section__title text-fg-2 text-xs font-medium mb-3">
          <CalendarClock class="w-4 h-4" aria-hidden="true" />
          <span>截止与日期</span>
        </h2>
        <dl class="detail-deadline-grid">
          <div class="detail-field detail-field--wide">
            <dt>报名截止</dt>
            <dd class="detail-wrap tabular">{officialDeadline}</dd>
          </div>
          <div class="detail-field detail-field--wide">
            <dt>活动日期</dt>
            <dd class="detail-wrap">
              {school.eventArrangement.time.summary || '未公布'}
              <span class="ml-1 text-[10.5px] text-fg-3">
                · {factStatusLabels[school.eventArrangement.time.status]}
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section class="detail-section px-5 py-4 border-b border-line" aria-labelledby="arrangement-heading">
        <h2 id="arrangement-heading" class="detail-section__title text-fg-2 text-xs font-medium mb-3">
          <MapPin class="w-4 h-4" aria-hidden="true" />
          <span>活动安排</span>
        </h2>
        <dl class="detail-deadline-grid">
          <div class="detail-field">
            <dt>活动形式</dt>
            <dd>{modeLabel}</dd>
          </div>
          <div class="detail-field">
            <dt>活动地点</dt>
            <dd class="detail-wrap">
              {school.eventArrangement.formatLocation.summary || '未提供'}
              <span class="ml-1 text-[10.5px] text-fg-3">
                · {factStatusLabels[school.eventArrangement.formatLocation.status]}
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section class="detail-section px-5 py-4 border-b border-line" aria-labelledby="logistics-heading">
        <h2 id="logistics-heading" class="detail-section__title text-fg-2 text-xs font-medium mb-3">
          <BedDouble class="w-4 h-4" aria-hidden="true" />
          <span>食宿与交通</span>
        </h2>
        <div class="flex items-start justify-between gap-3 min-w-0">
          <p class="detail-wrap min-w-0 text-fg-1 text-sm leading-relaxed">
            {school.logistics.summary || '未提供'}
          </p>
          <span class="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-fg-3">
            {factStatusLabels[school.logistics.status]}
          </span>
        </div>
      </section>

      <section class="detail-section px-5 py-4 border-b border-line" aria-labelledby="recommendation-heading">
        <h2 id="recommendation-heading" class="detail-section__title text-fg-2 text-xs font-medium mb-3">
          <LetterText class="w-4 h-4" aria-hidden="true" />
          <span>推荐信</span>
        </h2>
        <p class="detail-wrap text-fg-1 text-sm leading-relaxed">
          {school.recommendation.summary || '未提供'}
        </p>
      </section>

      <section class="detail-section px-5 py-4 border-b border-line" aria-labelledby="materials-heading">
        <h2 id="materials-heading" class="detail-section__title text-fg-2 text-xs font-medium mb-3">
          <Files class="w-4 h-4" aria-hidden="true" />
          <span>材料</span>
        </h2>
        <p class="detail-wrap text-fg-1 text-sm leading-relaxed">
          {school.materials.summary || '未提供'}
        </p>
      </section>

    </div>

    <!-- footer cta -->
    <div class="detail-panel__footer px-5 py-4 border-t border-line">
      <p class="mb-3 text-center text-[11px] leading-relaxed text-fg-3">
        本站信息仅供参考，报名要求与时间请以院校官网最新通知为准。
      </p>
      {#if primaryOfficialSource}
        <a
          href={primaryOfficialSource.url}
          target="_blank"
          rel="noopener noreferrer"
          class="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg surface-3 hover:bg-emerald-500/15 hover:text-emerald-200 text-fg-0 text-sm font-medium border border-line-strong transition detail-wrap"
          aria-label="打开{school.name}官网"
        >
          <span>打开官网</span>
          <ExternalLink class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        </a>
      {:else}
        <div class="w-full inline-flex items-center justify-center gap-2 py-2 text-fg-3 text-sm" role="status">
          <CircleAlert class="w-4 h-4 shrink-0" aria-hidden="true" />
          <span class="detail-wrap">官网链接暂不可用</span>
        </div>
      {/if}
    </div>
  </div>
</div>
