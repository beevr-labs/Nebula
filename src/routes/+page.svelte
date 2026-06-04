<script lang="ts">
  // FR-UI-001 — application shell: split-pane (Vault/editor | search/chat).
  // The Vault picker + scoped-FS wiring lands in golden-path slice 1 (T-001/T-002);
  // this is the static shell so the app builds and renders before features exist.
  let vaultPath = $state<string | null>(null);
</script>

<main class="shell">
  <header class="topbar">
    <span class="brand">Nebula</span>
    <span class="vault">{vaultPath ?? 'No vault selected'}</span>
  </header>

  <div class="split">
    <section class="pane editor" aria-label="Editor">
      <p class="placeholder">Editor pane — notes &amp; sources (FR-UI-001)</p>
    </section>
    <div class="divider" role="separator" aria-orientation="vertical"></div>
    <section class="pane assist" aria-label="Search and chat">
      <p class="placeholder">Search &amp; chat pane (FR-RET-001 / FR-CHAT-001)</p>
    </section>
  </div>
</main>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: system-ui, sans-serif;
    color: #1c1c1e;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 0.9rem;
    border-bottom: 1px solid #e2e2e6;
  }
  .brand {
    font-weight: 700;
  }
  .vault {
    color: #6a6a70;
    font-size: 0.85rem;
  }
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pane {
    flex: 1;
    overflow: auto;
    padding: 1rem;
  }
  .divider {
    width: 1px;
    background: #e2e2e6;
  }
  .placeholder {
    color: #8a8a90;
  }
</style>
