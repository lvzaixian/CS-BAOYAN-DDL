<script lang="ts">
  import { X } from 'lucide-svelte';
  import { onMount, tick } from 'svelte';

  let { onClose }: { onClose: () => void } = $props();

  let dialog = $state<HTMLElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);

  const items: { keys: string[]; desc: string }[] = [
    { keys: ['/'], desc: '聚焦搜索框' },
    { keys: ['j', '↓'], desc: '下一项' },
    { keys: ['k', '↑'], desc: '上一项' },
    { keys: ['Enter'], desc: '打开详情' },
    { keys: ['Esc'], desc: '关闭弹层 / 取消选中' },
    { keys: ['?'], desc: '显示 / 隐藏快捷键' },
  ];

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
    if (event.key !== 'Tab' || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
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

<div
  bind:this={dialog}
  class="fixed inset-0 z-50 fade grid place-items-center"
  role="dialog"
  aria-modal="true"
  aria-labelledby="kbd-hints-title"
  tabindex="-1"
  onkeydown={onDialogKeydown}
>
  <button
    class="absolute inset-0 bg-black/60 backdrop-blur-sm"
    onclick={onClose}
    aria-label="点击背景关闭键盘快捷键"
    tabindex="-1"
  ></button>
  <div class="relative surface-1 border border-line rounded-xl p-5 w-[min(320px,calc(100vw-2rem))] slide-up">
    <div class="flex items-center justify-between mb-4">
      <h2 id="kbd-hints-title" class="text-fg-0 font-medium">键盘快捷键</h2>
      <button
        bind:this={closeButton}
        onclick={onClose}
        class="p-1 rounded text-fg-3 hover:text-fg-1 hover:surface-3 transition"
        aria-label="关闭键盘快捷键"
      >
        <X class="w-4 h-4" />
      </button>
    </div>
    <div class="flex flex-col gap-2.5">
      {#each items as it}
        <div class="flex items-center justify-between text-sm">
          <span class="text-fg-1">{it.desc}</span>
          <span class="flex items-center gap-1">
            {#each it.keys as k, i}
              {#if i > 0}<span class="text-fg-4 text-xs mx-0.5">/</span>{/if}
              <kbd>{k}</kbd>
            {/each}
          </span>
        </div>
      {/each}
    </div>
  </div>
</div>
