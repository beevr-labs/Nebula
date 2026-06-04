import { describe, it, expect } from 'vitest';
import {
  loadSettings,
  saveSettings,
  updateSettings,
  SETTINGS_PATH,
  type SettingsIO
} from '../../src/lib/settings/store';

// TC-SET-001 — Settings persist & validate (FR-SET-001/002, FR-LOG-001).
// In-memory IO simulates `.nebula/settings.json`; reloading from it = "restart".

function memoryIO(): SettingsIO & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async read(path) {
      return store.has(path) ? (store.get(path) as string) : null;
    },
    async write(path, content) {
      store.set(path, content);
    }
  };
}

describe('TC-SET-001 — persistence across restart', () => {
  it('persists theme=dark, K=12, logging=on and reapplies them on reload', async () => {
    const io = memoryIO();

    // First run: defaults, then user changes settings.
    const initial = await loadSettings(io);
    const { settings, errors } = updateSettings(initial, {
      theme: 'dark',
      topK: 12,
      logging: true
    });
    expect(errors).toEqual([]);
    await saveSettings(io, settings);

    // It actually landed in `.nebula/settings.json`.
    expect(io.store.has(SETTINGS_PATH)).toBe(true);

    // "Restart": a fresh load from the same store.
    const reloaded = await loadSettings(io);
    expect(reloaded.theme).toBe('dark');
    expect(reloaded.topK).toBe(12);
    expect(reloaded.logging).toBe(true);
  });

  it('rejects an out-of-window chunkTargetSize with a clear reason', async () => {
    const io = memoryIO();
    const current = await loadSettings(io);
    const { settings, errors } = updateSettings(current, { chunkTargetSize: 1000 });
    expect(errors.some((e) => /embedding window/.test(e))).toBe(true);
    expect(settings.chunkTargetSize).toBe(current.chunkTargetSize); // unchanged
  });

  it('self-heals a corrupt settings file back to safe defaults on load', async () => {
    const io = memoryIO();
    io.store.set(
      SETTINGS_PATH,
      JSON.stringify({ theme: 'dark', topK: 99999, chunkTargetSize: 9000 })
    );
    const loaded = await loadSettings(io);
    expect(loaded.theme).toBe('dark'); // valid field kept
    expect(loaded.topK).toBe(8); // out-of-bounds healed to default
    expect(loaded.chunkTargetSize).toBe(500); // out-of-window healed to default
  });
});
