<script module lang="ts">
  // A step in the guided tour. Exported at module level so the host page can type its step list.
  export type Step = {
    selector?: string; // CSS selector of the element to spotlight; omit for a centered card
    title: string;
    body: string;
    /** Preferred side of the target to place the card; auto-flips if there's no room. */
    placement?: 'top' | 'bottom' | 'left' | 'right';
  };
</script>

<script lang="ts">
  // A self-contained, dependency-free guided tour ("coach-marks"). It dims the whole screen, cuts a
  // spotlight hole around a real UI element (located by CSS selector), and floats a small card with
  // step text + Back/Next/Skip + progress dots. Plain-language onboarding for users who don't know
  // (and shouldn't need to know) what an index, embedding or knowledge graph is.
  //
  // A step with no `selector`, or one whose element isn't on the page, renders as a centered card
  // (used for the welcome + done steps, and as a graceful fallback). The spotlight tracks layout via
  // resize/scroll listeners and a per-step settle tick, so it stays glued to its target.

  import { onMount, tick } from 'svelte';

  let { steps, onDone }: { steps: Step[]; onDone: () => void } = $props();

  let i = $state(0);
  // The live geometry of the current target (viewport coords). null → centered card, no spotlight.
  let rect = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  // The card's final on-screen corner. null → render centered (welcome/done steps, or before measure).
  let pos = $state<{ left: number; top: number } | null>(null);
  let cardEl = $state<HTMLDivElement | undefined>(undefined);

  const PAD = 8; // breathing room around the spotlight hole
  const GAP = 14; // gap between the spotlight and the card
  const step = $derived(steps[i] ?? null);
  const isLast = $derived(i >= steps.length - 1);

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

  /**
   * Measure the current target AND place the card so it is ALWAYS fully on-screen. The card corner is
   * computed from the preferred side, then HARD-CLAMPED into the viewport using the card's real
   * measured size — so a target near a screen edge (e.g. the Ask box at the bottom) can never push the
   * card off-screen where its Next/Skip buttons become unreachable (the bug this replaces).
   */
  function reposition() {
    // 1. Target geometry.
    const sel = step?.selector;
    const el = sel ? document.querySelector(sel) : null;
    if (!el) {
      rect = null; // no target (or hidden in this state) → centered card, no spotlight
      pos = null;
      return;
    }
    // Only scroll if the target isn't already fully in view (avoids needless jumps).
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    rect = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };

    // 2. Card placement — needs the card's real size, so this runs after it has rendered.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = cardEl?.offsetWidth ?? 320;
    const ch = cardEl?.offsetHeight ?? 200;
    const t = rect;
    const corner = (side: 'top' | 'bottom' | 'left' | 'right') => {
      if (side === 'bottom') return { left: t.x + t.w / 2 - cw / 2, top: t.y + t.h + GAP };
      if (side === 'top') return { left: t.x + t.w / 2 - cw / 2, top: t.y - ch - GAP };
      if (side === 'right') return { left: t.x + t.w + GAP, top: t.y + t.h / 2 - ch / 2 };
      return { left: t.x - cw - GAP, top: t.y + t.h / 2 - ch / 2 }; // left
    };
    // Prefer the requested side, else the one with the most room; clamping guarantees on-screen either way.
    const room = {
      bottom: vh - (t.y + t.h),
      top: t.y,
      right: vw - (t.x + t.w),
      left: t.x
    };
    const order: ('top' | 'bottom' | 'left' | 'right')[] = [
      step?.placement ?? 'bottom',
      'bottom',
      'right',
      'left',
      'top'
    ];
    const needed = (s: 'top' | 'bottom' | 'left' | 'right') =>
      s === 'top' || s === 'bottom' ? ch + GAP : cw + GAP;
    const side = order.find((s) => room[s] >= needed(s)) ?? order[0];
    const c = corner(side);
    pos = {
      left: clamp(c.left, GAP, vw - cw - GAP),
      top: clamp(c.top, GAP, vh - ch - GAP)
    };
  }

  // Re-place whenever the step changes (after the DOM + card content settle), and on resize/scroll.
  $effect(() => {
    void i; // re-run on step change
    void tick().then(reposition);
  });

  onMount(() => {
    const onMove = () => reposition();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const id = setTimeout(reposition, 60); // catch late-mounting targets (e.g. just after the gate closes)
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      clearTimeout(id);
    };
  });

  function next() {
    if (isLast) finish();
    else i += 1;
  }
  function back() {
    if (i > 0) i -= 1;
  }
  function finish() {
    onDone();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') finish();
    else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    }
  }

</script>

<svelte:window onkeydown={onKey} />

<!-- The dimming layer. When a target exists we use a transparent box with a giant box-shadow to dim
     everything BUT the spotlight hole; otherwise a flat scrim behind a centered card. -->
<div class="coach-root" role="dialog" aria-modal="true" aria-label="Guided tour">
  {#if rect}
    <div
      class="coach-hole"
      style="left:{rect.x}px; top:{rect.y}px; width:{rect.w}px; height:{rect.h}px;"
    ></div>
  {:else}
    <div class="coach-scrim"></div>
  {/if}

  <div
    bind:this={cardEl}
    class="coach-card nb-rise"
    class:centered={!pos}
    style={pos ? `left:${pos.left}px; top:${pos.top}px;` : ''}
  >
    <div class="coach-step">Step {i + 1} of {steps.length}</div>
    <strong class="coach-title">{step?.title}</strong>
    <p class="coach-body">{step?.body}</p>

    <div class="coach-foot">
      <div class="coach-dots">
        {#each steps as _, d (d)}
          <span class="coach-dot" class:on={d === i}></span>
        {/each}
      </div>
      <div class="coach-actions">
        <button class="coach-skip" onclick={finish}>Skip</button>
        {#if i > 0}<button class="coach-btn ghost" onclick={back}>Back</button>{/if}
        <button class="coach-btn primary" onclick={next}>{isLast ? 'Done' : 'Next'}</button>
      </div>
    </div>
  </div>
</div>

<style>
  .coach-root {
    position: fixed;
    inset: 0;
    z-index: 10000;
  }
  .coach-scrim {
    position: absolute;
    inset: 0;
    background: rgba(8, 10, 14, 0.55);
  }
  /* The spotlight: a transparent rounded box whose huge shadow dims the rest of the screen. */
  .coach-hole {
    position: absolute;
    border-radius: 10px;
    box-shadow:
      0 0 0 9999px rgba(8, 10, 14, 0.6),
      0 0 0 2px var(--accent, #2f6fdb);
    transition:
      left 0.18s ease,
      top 0.18s ease,
      width 0.18s ease,
      height 0.18s ease;
    pointer-events: none;
  }
  .coach-card {
    position: absolute;
    width: 320px;
    max-width: calc(100vw - 28px);
    box-sizing: border-box;
    background: var(--surface, #fff);
    color: var(--ink, #13161b);
    border: 1px solid var(--line, #ededf1);
    border-radius: var(--r-xl, 14px);
    padding: 16px;
    box-shadow: var(--shadow-lg, 0 12px 32px rgba(20, 24, 33, 0.12));
    font-family: var(--ui, system-ui, sans-serif);
  }
  .coach-card.centered {
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
  }
  .coach-step {
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted, #767d88);
    margin-bottom: 6px;
  }
  .coach-title {
    display: block;
    font-size: 16px;
    line-height: 1.3;
    margin-bottom: 6px;
  }
  .coach-body {
    margin: 0 0 14px;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--ink-2, #3a3f48);
  }
  .coach-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .coach-dots {
    display: flex;
    gap: 5px;
  }
  .coach-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--line-strong, #e0e2e8);
  }
  .coach-dot.on {
    background: var(--accent, #2f6fdb);
  }
  .coach-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .coach-btn {
    font: inherit;
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 8px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .coach-btn.primary {
    background: var(--accent, #2f6fdb);
    color: #fff;
  }
  .coach-btn.ghost {
    background: transparent;
    border-color: var(--line, #ededf1);
    color: var(--ink, #13161b);
  }
  .coach-skip {
    font: inherit;
    font-size: 12.5px;
    background: none;
    border: none;
    color: var(--muted, #767d88);
    cursor: pointer;
    padding: 6px 4px;
  }
  .coach-btn:hover,
  .coach-skip:hover {
    filter: brightness(0.97);
  }
</style>
