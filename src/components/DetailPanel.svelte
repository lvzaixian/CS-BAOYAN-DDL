<script lang="ts">
  import {
    BedDouble,
    CalendarClock,
    CircleAlert,
    ExternalLink,
    Files,
    LetterText,
    Link,
    X,
  } from 'lucide-svelte';
  import { onMount, tick } from 'svelte';
  import type { DerivedSchool } from '$lib/types';
  import type { FactStatus } from '$lib/snapshot-types';
  import { formatDateTime } from '$lib/time';
  import { expiredDeadlineText, sourceLinkLabel } from '$lib/filter';
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
  const deadlineStatus = $derived(expiredDeadlineText(school));
  const normalizedDeadline = $derived(
    school.deadlineMs === null ? '未公布' : formatDateTime(school.deadlineMs),
  );
  const sourceLabel = $derived(sourceLinkLabel(school));
  const verifiedAtMs = $derived.by(() => {
    const parsed = Date.parse(school.verifiedAt);
    return Number.isFinite(parsed) ? parsed : null;
  });
  const officialSources = $derived(
    school.discoverySources.filter((source) => source.kind === 'official'),
  );
  const discoverySources = $derived(
    school.discoverySources.filter((source) => source.kind !== 'official'),
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
    aria-label="关闭项目详情"
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
        {#if province}
          <div class="text-fg-4 text-xs mt-1">{province}</div>
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
    <div class="detail-panel__body flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
      <section class="detail-section px-5 py-4 border-b border-line" aria-labelledby="deadline-heading">
        <h2 id="deadline-heading" class="detail-section__title text-fg-2 text-xs font-medium mb-3">
          <CalendarClock class="w-4 h-4" aria-hidden="true" />
          <span>截止信息</span>
        </h2>
        <dl class="detail-deadline-grid">
          <div class="detail-field detail-field--wide">
            <dt>原始文本</dt>
            <dd class="detail-wrap">{school.deadlineOriginal || '未提供'}</dd>
          </div>
          <div class="detail-field">
            <dt>标准化时间</dt>
            <dd class="detail-wrap tabular">
              {normalizedDeadline}{deadlineStatus ? ` · ${deadlineStatus}` : ''}
            </dd>
          </div>
          <div class="detail-field">
            <dt>核验时间</dt>
            <dd class="detail-wrap tabular">
              {verifiedAtMs === null ? '未记录' : formatDateTime(verifiedAtMs)}
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

      <section class="detail-section px-5 py-4" aria-labelledby="sources-heading">
        <h2 id="sources-heading" class="detail-section__title text-fg-2 text-xs font-medium mb-3">
          <Link class="w-4 h-4" aria-hidden="true" />
          <span>信息来源</span>
        </h2>

        {#if officialSources.length > 0}
          <div class="detail-source-list" aria-label="官方来源">
            {#each officialSources as source}
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                class="detail-source-link detail-source-link--official text-fg-1"
                aria-label="打开{sourceLabel}：{source.label}"
              >
                <span>{sourceLabel} · {source.label}</span>
                <ExternalLink class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              </a>
            {/each}
          </div>
        {/if}

        {#if discoverySources.length > 0}
          <div class="detail-source-list mt-2" aria-label="发现来源">
            {#each discoverySources as source}
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                class="detail-source-link detail-source-link--secondary text-fg-3 hover:text-fg-1"
                aria-label="打开发现来源：{source.label}"
              >
                <span>{source.label}</span>
                <ExternalLink class="w-3 h-3 shrink-0" aria-hidden="true" />
              </a>
            {/each}
          </div>
        {/if}

        {#if officialSources.length === 0 && discoverySources.length === 0}
          <p class="text-fg-3 text-sm">暂无可用来源</p>
        {/if}
      </section>
    </div>

    <!-- footer cta -->
    <div class="detail-panel__footer px-5 py-4 border-t border-line">
      {#if primaryOfficialSource}
        <a
          href={primaryOfficialSource.url}
          target="_blank"
          rel="noopener noreferrer"
          class="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg surface-3 hover:bg-emerald-500/15 hover:text-emerald-200 text-fg-0 text-sm font-medium border border-line-strong transition detail-wrap"
          aria-label="打开{sourceLabel}：{primaryOfficialSource.label}"
        >
          <span>查看{sourceLabel}</span>
          <ExternalLink class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        </a>
      {:else}
        <div class="w-full inline-flex items-center justify-center gap-2 py-2 text-fg-3 text-sm" role="status">
          <CircleAlert class="w-4 h-4 shrink-0" aria-hidden="true" />
          <span class="detail-wrap">暂无已核验官方来源</span>
        </div>
      {/if}
    </div>
  </div>
</div>
