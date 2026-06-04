import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  validateSettings,
  updateSettings,
  migrate,
  SETTINGS_SCHEMA_VERSION
} from '../../src/lib/settings/store';
import { EMBEDDING_MAX_TOKENS } from '../../src/lib/inference/provider';

// FR-SET-001/002 · TEST-CASES TC-SET-001.

describe('validateSettings — safe bounds (FR-SET-002)', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });

  it('rejects chunkTargetSize >= the embedding window (FR-ING-003 invariant)', () => {
    const bad = { ...DEFAULT_SETTINGS, chunkTargetSize: EMBEDDING_MAX_TOKENS };
    const errors = validateSettings(bad);
    expect(errors.some((e) => /strictly below the embedding window/.test(e))).toBe(true);
  });

  it('rejects overlap >= targetSize, out-of-range K, and bad theme', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, chunkOverlap: 500 }).length).toBeGreaterThan(0);
    expect(validateSettings({ ...DEFAULT_SETTINGS, topK: 0 }).length).toBeGreaterThan(0);
    expect(validateSettings({ ...DEFAULT_SETTINGS, topK: 999 }).length).toBeGreaterThan(0);
    // @ts-expect-error — intentionally invalid theme
    expect(validateSettings({ ...DEFAULT_SETTINGS, theme: 'neon' }).length).toBeGreaterThan(0);
  });
});

describe('updateSettings — reject-on-invalid (FR-SET-002)', () => {
  it('applies a valid patch', () => {
    const { settings, errors } = updateSettings(DEFAULT_SETTINGS, { topK: 12, theme: 'dark' });
    expect(errors).toEqual([]);
    expect(settings.topK).toBe(12);
    expect(settings.theme).toBe('dark');
  });

  it('rejects an invalid patch and leaves settings unchanged', () => {
    const { settings, errors } = updateSettings(DEFAULT_SETTINGS, { chunkTargetSize: 9999 });
    expect(errors.length).toBeGreaterThan(0);
    expect(settings).toBe(DEFAULT_SETTINGS); // unchanged reference
  });
});

describe('migrate — forward-only', () => {
  it('fills missing keys from defaults and stamps the schema version', () => {
    const migrated = migrate({ theme: 'dark', topK: 20 });
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(migrated.theme).toBe('dark');
    expect(migrated.topK).toBe(20);
    expect(migrated.chunkTargetSize).toBe(DEFAULT_SETTINGS.chunkTargetSize);
    expect(migrated.activeModel).toBe(DEFAULT_SETTINGS.activeModel);
  });

  it('ignores junk input and returns defaults', () => {
    expect(migrate(null).chunkTargetSize).toBe(DEFAULT_SETTINGS.chunkTargetSize);
    expect(migrate('garbage').topK).toBe(DEFAULT_SETTINGS.topK);
  });
});
