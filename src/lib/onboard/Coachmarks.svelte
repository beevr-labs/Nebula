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

  const PAD = 8; // breathing room around the spotlight hole
  const step = $derived(steps[i] ?? null);
  const isLast = $derived(i >= steps.length - 1);

  function measure() {
    const sel = step?.selector;
    if (!sel) {
      rect = null;
      return;
    }
    const el = document.querySelector(sel);
    if (!el) {
      rect = null; // target missing (feature hidden in this state) → fall back to a centered card
      return;
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    rect = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
  }

  // Re-measure whenever the step changes (after the DOM settles) — and keep tracking on resize/scroll.
  $effect(() => {
    void i; // re-run on step change
    void tick().then(measure);
  });

  onMount(() => {
    const onMove = () => measure();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const id = setTimeout(measure, 60); // catch late-mounting targets (e.g. just after the gate closes)
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

  // ── Card placement: pick a side with room, fall back to centered ────────────────────────────────
  const CARD_W = 320;
  const GAP = 14;
  const card = $derived.by(() => {
    if (!rect) return null; // centered
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const want = step?.placement;
    const below = vh - (rect.y + rect.h);
    const above = rect.y;
    const rightRoom = vw - (rect.x + rect.w);
    const leftRoom = rect.x;

    // Default: below if there's room, else above; explicit left/right honored when feasible.
    let place: 'top' | 'bottom' | 'left' | 'right' = 'bottom';
    if (want === 'left' && leftRoom > CARD_W + GAP) place = 'left';
    else if (want === 'right' && rightRoom > CARD_W + GAP) place = 'right';
    else if (want === 'top' && above > 180) place = 'top';
    else if (below > 180) place = 'bottom';
    else if (above > 180) place = 'top';
    else if (rightRoom > CARD_W + GAP) place = 'right';
    else if (leftRoom > CARD_W + GAP) place = 'left';
    else return null; // nowhere good → center it

    let left: number, top: number;
    if (place === 'bottom') {
      left = rect.x + rect.w / 2 - CARD_W / 2;
      top = rect.y + rect.h + GAP;
    } else if (place === 'top') {
      left = rect.x + rect.w / 2 - CARD_W / 2;
      top = rect.y - GAP; // anchored by translateY(-100%) below
    } else if (place === 'right') {
      left = rect.x + rect.w + GAP;
      top = rect.y;
    } else {
      left = rect.x - GAP; // anchored by translateX(-100%)
      top = rect.y;
    }
    left = Math.max(GAP, Math.min(left, vw - CARD_W - GAP));
    return { left, top, place };
  });
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
    class="coach-card nb-rise"
    class:centered={!card}
    style={card
      ? `left:${card.left}px; top:${card.top}px;` +
        (card.place === 'top' ? 'transform:translateY(-100%);' : '') +
        (card.place === 'left' ? 'transform:translateX(-100%);' : '')
      : ''}
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
