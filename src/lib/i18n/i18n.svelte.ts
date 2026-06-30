// Lightweight, dependency-free i18n for the workspace UI. A single reactive `locale` ($state in a
// .svelte.ts module) drives a `t(key)` lookup; because `t` reads that $state, every `{t('…')}` in a
// template re-renders when the language changes — no store boilerplate, no library. Strings live in
// per-locale flat dictionaries (en.ts is the source of truth / fallback). Adding a language = add a
// dictionary + a SUPPORTED entry. Designed to grow incrementally: any key missing from a non-English
// dictionary transparently falls back to English, so a half-translated locale degrades gracefully.

import * as uiPrefs from '$lib/settings/ui-prefs';
import { en } from './en';
import { vi } from './vi';

export type Locale = 'en' | 'vi';
export type Dict = Record<string, string>;

export const SUPPORTED: { code: Locale; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' }
];

const DICTS: Record<Locale, Dict> = { en, vi };

/** Pick the startup language: a saved choice, else English. English is the default for a fresh
 *  install regardless of the browser's language — the user can switch to Vietnamese via the topbar
 *  globe, and that choice is then remembered (uiPrefs). */
function detectInitial(): Locale {
  const saved = uiPrefs.getLocale();
  if (saved === 'en' || saved === 'vi') return saved;
  return 'en';
}

let locale = $state<Locale>(detectInitial());

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (next !== 'en' && next !== 'vi') return;
  locale = next;
  uiPrefs.setLocale(next);
}

/** Toggle through the supported languages (EN ⇄ VI today). */
export function cycleLocale(): void {
  const idx = SUPPORTED.findIndex((l) => l.code === locale);
  setLocale(SUPPORTED[(idx + 1) % SUPPORTED.length].code);
}

/**
 * Translate `key` for the current locale. Falls back to English, then to the raw key (so a missing
 * string is visible, not blank). `vars` interpolates `{name}` placeholders. Reactive: reading the
 * `locale` $state here is what makes every call site update on a language switch.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[locale] ?? en;
  let s = dict[key] ?? en[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.replaceAll(`{${k}}`, String(vars[k]));
  return s;
}
