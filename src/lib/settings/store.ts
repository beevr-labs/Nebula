// Settings store — persisted at `.nebula/settings.json` (FR-SET-001) with
// forward-only schema migration; retrieval/ingestion params validated against
// safe bounds, including the FR-ING-003 / ADR-006 embedding-window invariant (FR-SET-002).
//
// Pure core + injectable IO (SettingsIO) so persistence is testable without Tauri/disk.
// At runtime the IO adapter routes through fs_scope (NFR-SEC-003).

import { DEFAULT_CHAT_MODEL, EMBEDDING_MAX_TOKENS } from '$lib/inference/provider';

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_PATH = '.nebula/settings.json';

export type Theme = 'light' | 'dark' | 'system';

export interface Settings {
  schemaVersion: number;
  vaultPath: string | null;
  activeModel: string;
  theme: Theme;
  logging: boolean; // opt-in, metadata-only (FR-LOG-001)
  clearClipboard: boolean; // clear clipboard after Context export (M-7 threat)
  chunkTargetSize: number; // FR-ING-003
  chunkOverlap: number;
  topK: number; // FR-RET-001
  maxFileSizeMB: number; // FR-ING-010 ingestion size cap
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  vaultPath: null,
  activeModel: DEFAULT_CHAT_MODEL, // Phi-3-Mini (ADR-007 / FR-MDL-005)
  theme: 'system',
  logging: false,
  clearClipboard: false,
  chunkTargetSize: 500,
  chunkOverlap: 50,
  topK: 8,
  maxFileSizeMB: 100
};

const THEMES: Theme[] = ['light', 'dark', 'system'];
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** Validate a full Settings object against safe bounds. Returns a list of human-readable errors. */
export function validateSettings(s: Settings): string[] {
  const errors: string[] = [];

  if (!isInt(s.chunkTargetSize) || s.chunkTargetSize <= 0) {
    errors.push('chunkTargetSize must be a positive integer.');
  } else if (s.chunkTargetSize >= EMBEDDING_MAX_TOKENS) {
    // FR-ING-003 invariant — never allow silent truncation.
    errors.push(
      `chunkTargetSize must be strictly below the embedding window (${EMBEDDING_MAX_TOKENS}); got ${s.chunkTargetSize}.`
    );
  }

  if (!isInt(s.chunkOverlap) || s.chunkOverlap < 0) {
    errors.push('chunkOverlap must be a non-negative integer.');
  } else if (isInt(s.chunkTargetSize) && s.chunkOverlap >= s.chunkTargetSize) {
    errors.push('chunkOverlap must be smaller than chunkTargetSize.');
  }

  if (!isInt(s.topK) || s.topK < 1 || s.topK > 100) {
    errors.push('topK must be an integer in [1, 100].');
  }

  if (typeof s.maxFileSizeMB !== 'number' || s.maxFileSizeMB < 1 || s.maxFileSizeMB > 4096) {
    errors.push('maxFileSizeMB must be a number in [1, 4096].');
  }

  if (!THEMES.includes(s.theme)) {
    errors.push(`theme must be one of ${THEMES.join(', ')}.`);
  }

  if (typeof s.activeModel !== 'string' || s.activeModel.trim() === '') {
    errors.push('activeModel must be a non-empty string.');
  }

  return errors;
}

/** Forward-only migration: fill missing keys from defaults, stamp the current schema version. */
export function migrate(raw: unknown): Settings {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  // Newer-on-disk than this build: keep known values, don't downgrade data we understand.
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    vaultPath: typeof src.vaultPath === 'string' ? src.vaultPath : DEFAULT_SETTINGS.vaultPath,
    activeModel:
      typeof src.activeModel === 'string' ? src.activeModel : DEFAULT_SETTINGS.activeModel,
    theme: THEMES.includes(src.theme as Theme) ? (src.theme as Theme) : DEFAULT_SETTINGS.theme,
    logging: typeof src.logging === 'boolean' ? src.logging : DEFAULT_SETTINGS.logging,
    clearClipboard:
      typeof src.clearClipboard === 'boolean'
        ? src.clearClipboard
        : DEFAULT_SETTINGS.clearClipboard,
    chunkTargetSize: isInt(src.chunkTargetSize)
      ? src.chunkTargetSize
      : DEFAULT_SETTINGS.chunkTargetSize,
    chunkOverlap: isInt(src.chunkOverlap) ? src.chunkOverlap : DEFAULT_SETTINGS.chunkOverlap,
    topK: isInt(src.topK) ? src.topK : DEFAULT_SETTINGS.topK,
    maxFileSizeMB:
      typeof src.maxFileSizeMB === 'number' ? src.maxFileSizeMB : DEFAULT_SETTINGS.maxFileSizeMB
  };
}

/**
 * Apply a partial update to current settings. Validates the RESULT; on any error
 * the update is rejected (returns the unchanged settings + reasons) — FR-SET-002.
 */
export function updateSettings(
  current: Settings,
  patch: Partial<Settings>
): { settings: Settings; errors: string[] } {
  const next = { ...current, ...patch, schemaVersion: SETTINGS_SCHEMA_VERSION };
  const errors = validateSettings(next);
  return errors.length > 0 ? { settings: current, errors } : { settings: next, errors: [] };
}

export interface SettingsIO {
  read(path: string): Promise<string | null>; // null when the file does not exist
  write(path: string, content: string): Promise<void>;
}

/** Load settings, migrating + sanitizing invalid fields back to defaults (never bricks on a bad file). */
export async function loadSettings(io: SettingsIO): Promise<Settings> {
  const raw = await io.read(SETTINGS_PATH);
  if (raw == null) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const migrated = migrate(parsed);
  // Replace any out-of-bounds field with its default so a corrupt file is self-healing.
  if (validateSettings(migrated).length > 0) {
    const healed = { ...migrated };
    const probe = (key: keyof Settings) => {
      const trial = { ...DEFAULT_SETTINGS, [key]: migrated[key] } as Settings;
      return validateSettings(trial).length === 0;
    };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (!probe(key)) (healed[key] as Settings[keyof Settings]) = DEFAULT_SETTINGS[key];
    }
    return healed;
  }
  return migrated;
}

/** Persist settings as pretty JSON. Throws if the settings are invalid (caller validated first). */
export async function saveSettings(io: SettingsIO, settings: Settings): Promise<void> {
  const errors = validateSettings(settings);
  if (errors.length > 0) {
    throw new Error(`Refusing to persist invalid settings: ${errors.join(' ')}`);
  }
  await io.write(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}
