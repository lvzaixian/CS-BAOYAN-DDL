<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { startClock, clock } from '$lib/clock.svelte';
  import { filters, initFilterSync } from '$lib/urlState.svelte';
  import { applyFilters, deriveSchool, rowKey } from '$lib/filter';
  import { getSchools } from '$lib/schools';
  import type { DerivedSchool } from '$lib/types';
  import Header from '$components/Header.svelte';
  import Toolbar from '$components/Toolbar.svelte';
  import FilterPanel from '$components/FilterPanel.svelte';
  import ListView from '$components/ListView.svelte';
  import CalendarView from '$components/CalendarView.svelte';
  import DetailPanel from '$components/DetailPanel.svelte';
  import KbdHints from '$components/KbdHints.svelte';

  let selectedKey = $state<string | null>(null);
  let selectedIndex = $state(0);
  let drawerOpen = $state(false);
  let helpOpen = $state(false);
  let previousFeedId = $state(filters.source);
  let drawerPanel = $state<HTMLElement | null>(null);
  let drawerReturnFocus: HTMLElement | null = null;

  // mount / unmount the shared 1Hz tick
  onMount(() => {
    initFilterSync();
    const stop = startClock();
    return stop;
  });

  // raw schools for the active source (does NOT change with filters)
  const sourceRows = $derived(getSchools(filters.source));

  // every 1Hz tick re-derives countdowns; expensive only in proportion to row count
  const allRows = $derived<DerivedSchool[]>(
    sourceRows.map((s) => deriveSchool(s, clock.now)),
  );

  const visible = $derived(
    applyFilters(allRows, {
      query: filters.query,
      tags: filters.tags,
      status: filters.status,
      provinces: filters.provinces,
    }),
  );

  const totalCount = $derived(allRows.length);
  const visibleCount = $derived(visible.length);

  const selected = $derived(
    selectedKey ? visible.find((r) => rowKey(r) === selectedKey) ?? null : null,
  );
  const backgroundInert = $derived(selected !== null || drawerOpen || helpOpen);

  $effect(() => {
    if (filters.source === previousFeedId) return;
    previousFeedId = filters.source;
    selectedKey = null;
    selectedIndex = 0;
  });

  $effect(() => {
    if (!drawerOpen) return;
    void tick().then(() => {
      const first = drawerPanel?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? drawerPanel)?.focus();
    });
  });

  function openDrawer(trigger: HTMLButtonElement) {
    drawerReturnFocus = trigger;
    drawerOpen = true;
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    const returnFocus = drawerReturnFocus;
    drawerOpen = false;
    queueMicrotask(() => returnFocus?.focus());
  }

  function onDrawerKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDrawer();
      return;
    }
    if (e.key !== 'Tab' || !drawerPanel) return;
    const focusable = Array.from(drawerPanel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) {
      e.preventDefault();
      drawerPanel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // global keyboard shortcuts
  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inField =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);

    if (e.key === 'Escape') {
      if (helpOpen) { helpOpen = false; e.preventDefault(); return; }
      if (selectedKey) { selectedKey = null; e.preventDefault(); return; }
      if (drawerOpen) { closeDrawer(); e.preventDefault(); return; }
      if (inField && target instanceof HTMLInputElement) {
        target.blur();
        e.preventDefault();
      }
      return;
    }

    if (helpOpen) {
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        helpOpen = false;
        e.preventDefault();
      }
      return;
    }

    if (inField) return;

    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      helpOpen = !helpOpen;
      e.preventDefault();
      return;
    }
    if (selected || drawerOpen) return;
    if (e.key === '/') {
      const el = document.getElementById('search-input') as HTMLInputElement | null;
      el?.focus();
      el?.select();
      e.preventDefault();
      return;
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      if (visible.length === 0) return;
      selectedIndex = Math.min(visible.length - 1, selectedIndex + 1);
      const r = visible[selectedIndex];
      ensureRowVisible(rowKey(r));
      e.preventDefault();
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      if (visible.length === 0) return;
      selectedIndex = Math.max(0, selectedIndex - 1);
      const r = visible[selectedIndex];
      ensureRowVisible(rowKey(r));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      if (target && target !== document.body) return;
      if (visible[selectedIndex]) {
        const r = visible[selectedIndex];
        selectedKey = rowKey(r);
        e.preventDefault();
      }
    }
  }

  function ensureRowVisible(key: string) {
    queueMicrotask(() => {
      document
        .querySelector(`[data-row-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function handleSelect(key: string) {
    selectedKey = key;
    const i = visible.findIndex((r) => rowKey(r) === key);
    if (i >= 0) selectedIndex = i;
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="bg-page min-h-dvh flex flex-col">
  <div class="contents" inert={backgroundInert}>
    <Header {drawerOpen} onOpenDrawer={openDrawer} onOpenHelp={() => (helpOpen = true)} />

    <div class="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 flex-1 flex flex-col gap-4 pb-24">
      <Toolbar {totalCount} {visibleCount} rows={allRows} />

      <div class="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 flex-1">
        <aside class="hidden lg:block">
          <FilterPanel rows={allRows} mode="sidebar" />
        </aside>

        <main class="min-w-0">
          {#if filters.view === 'list'}
            <ListView
              rows={visible}
              {selectedKey}
              onSelect={handleSelect}
            />
          {:else}
            <CalendarView rows={visible} feedId={filters.source} onSelect={handleSelect} />
          {/if}
        </main>
      </div>
    </div>
  </div>

  <div class="contents" data-layer="detail" inert={helpOpen}>
    {#if selected}
      <DetailPanel school={selected} onClose={() => (selectedKey = null)} />
    {/if}
  </div>

  {#if drawerOpen}
    <div class="lg:hidden fixed inset-0 z-40 fade" role="presentation" inert={helpOpen}>
      <button
        class="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-label="关闭筛选面板"
        onclick={closeDrawer}
      ></button>
      <div
        id="mobile-filter-drawer"
        bind:this={drawerPanel}
        role="dialog"
        aria-modal="true"
        aria-label="筛选条件"
        tabindex="-1"
        onkeydown={onDrawerKeydown}
        class="surface-1 absolute bottom-0 inset-x-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-line slide-up p-4"
      >
        <FilterPanel rows={allRows} mode="drawer" onDone={closeDrawer} />
      </div>
    </div>
  {/if}

  {#if helpOpen}
    <KbdHints onClose={() => (helpOpen = false)} />
  {/if}
</div>
