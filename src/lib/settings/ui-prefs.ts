// Lightweight, browser-native UI preferences (localStorage) — distinct from the vault Settings
// store (settings/store.ts), which holds retrieval/ingestion params persisted to the vault. These
// are pure UI affordances that should survive a refresh WITHOUT touching the SurrealDB schema:
//   • which chat model the user picked at the startup model gate (FR-MDL-005, the onboarding),
//   • whether that one-time model gate has been shown,
//   • explicit (possibly empty) folders the user created in the file tree (FR-NAV-002 / FR-NOTE-007),
//   • the last workspace view (Files vs Graph).
// Every accessor is guarded: no `window`/`localStorage` (SSR, locked-down webview) → safe defaults,
// never a throw. The app must work even when storage is unavailable — these are conveniences.

const NS = 'nebula.ui';
const K_MODEL = `${NS}.model`;
const K_ONBOARDED = `${NS}.onboarded`;
const K_TUTORIAL = `${NS}.tutorialDone`;
const K_FOLDERS = `${NS}.emptyFolders`;
const K_VIEW = `${NS}.view`;
const K_THEME = `${NS}.theme`;
const K_ADVANCED = `${NS}.advanced`;
const K_LOCALE = `${NS}.locale`;
const K_PANES = `${NS}.panes`;

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Some embeddings throw on access (privacy mode, sandboxed iframe) rather than returning null.
    return null;
  }
}

function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    /* storage full / denied — a lost UI pref is non-fatal */
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The chat model the user chose at the startup gate, or null if never chosen. */
export function getModelPref(): string | null {
  const v = read(K_MODEL);
  return v && v.trim() ? v : null;
}
export function setModelPref(modelId: string): void {
  if (modelId && modelId.trim()) write(K_MODEL, modelId);
}

/** Has the one-time startup model gate been completed (picked or skipped)? */
export function isOnboarded(): boolean {
  return read(K_ONBOARDED) === '1';
}
export function setOnboarded(done = true): void {
  if (done) write(K_ONBOARDED, '1');
  else remove(K_ONBOARDED);
}

/** Has the first-run guided tour (coach-marks) been seen or dismissed? Distinct from the model gate:
 *  the gate is "pick a model", the tour is the plain-language walkthrough that follows it. Resetting
 *  it (setTutorialDone(false)) is how the "Take a tour" button re-runs the walkthrough on demand. */
export function isTutorialDone(): boolean {
  return read(K_TUTORIAL) === '1';
}
export function setTutorialDone(done = true): void {
  if (done) write(K_TUTORIAL, '1');
  else remove(K_TUTORIAL);
}

/** Explicit folders the user created in the tree — kept so EMPTY folders survive a refresh. */
export function getEmptyFolders(): string[] {
  const raw = read(K_FOLDERS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function setEmptyFolders(folders: Iterable<string>): void {
  const uniq = [...new Set([...folders])].filter((f) => f && f.trim()).sort();
  write(K_FOLDERS, JSON.stringify(uniq));
}

export type WorkspaceView = 'files' | 'graph';
export function getView(): WorkspaceView {
  return read(K_VIEW) === 'graph' ? 'graph' : 'files';
}
export function setView(view: WorkspaceView): void {
  write(K_VIEW, view);
}

/** UI language (i18n). Persisted across sessions; read by the i18n store at startup. `null` → the
 *  store falls back to browser detection (navigator.language) then English. */
export function getLocale(): string | null {
  const v = read(K_LOCALE);
  return v && v.trim() ? v : null;
}
export function setLocale(locale: string): void {
  if (locale && locale.trim()) write(K_LOCALE, locale);
}

/** Resizable workspace panes (FR-UI-001): sidebar + ask-rail widths in px and ask-rail visibility.
 *  Persisted so the layout survives a refresh; `null` → use the built-in defaults. */
export type Panes = { sideW: number; askW: number; askOpen: boolean };
export function getPanes(): Panes | null {
  const raw = read(K_PANES);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return o as Panes;
  } catch {
    /* corrupt JSON → fall back to defaults */
  }
  return null;
}
export function setPanes(p: Panes): void {
  write(K_PANES, JSON.stringify(p));
}

/** Advanced mode — surfaces the technical metrics (GPU/CPU speed, answer latency & throughput,
 *  retrieval scores, raw graph counts) that are hidden by default for non-technical users. */
export function getAdvanced(): boolean {
  return read(K_ADVANCED) === '1';
}
export function setAdvanced(on: boolean): void {
  if (on) write(K_ADVANCED, '1');
  else remove(K_ADVANCED);
}

/** Light/dark theme for the "Clean Slate" design system (data-theme on the root). */
export type Theme = 'light' | 'dark';
export function getTheme(): Theme {
  return read(K_THEME) === 'dark' ? 'dark' : 'light';
}
export function setTheme(theme: Theme): void {
  write(K_THEME, theme);
}
