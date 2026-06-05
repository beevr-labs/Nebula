// Templates + daily notes (FR-NOTE-005/006) · OBSIDIAN-DNA §5.8.
//
// Two A-tier Obsidian daily-drivers (COMPETITIVE-OBSIDIAN §1): templated note bodies and a
// one-click "today" note. Both are thin, pure helpers over the existing authoring core
// (`note-crud.ts`) — a template is just `{{placeholder}}` substitution, and a daily note is a
// note whose title is a date and whose body is a template. `now` is injected → deterministic,
// no clock here. ALGORITHMS §16.

export interface TemplateVars {
  /** ISO timestamp; `{{date}}` → YYYY-MM-DD, `{{time}}` → HH:MM, `{{datetime}}` → both. */
  now: string;
  /** `{{title}}` substitution. */
  title?: string;
  /** Any other `{{key}}` the caller wants to fill. */
  [key: string]: string | undefined;
}

/** `2026-06-06T09:30:00Z` → `2026-06-06`. */
export function isoDate(now: string): string {
  return now.slice(0, 10);
}

/** `2026-06-06T09:30:00Z` → `09:30`. */
export function isoTime(now: string): string {
  const m = /T(\d{2}:\d{2})/.exec(now);
  return m ? m[1] : '';
}

/**
 * Expand `{{placeholder}}` tokens in a template body (FR-NOTE-006). Built-ins: `date`, `time`,
 * `datetime`, `title`. Any other key present in `vars` is substituted too. Unknown placeholders
 * are left intact (so an unrecognized `{{foo}}` is never silently dropped). Pure.
 */
export function expandTemplate(body: string, vars: TemplateVars): string {
  const date = isoDate(vars.now);
  const time = isoTime(vars.now);
  const builtins: Record<string, string> = {
    date,
    time,
    datetime: time ? `${date} ${time}` : date,
    title: vars.title ?? ''
  };
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) => {
    if (key in builtins) return builtins[key];
    const v = vars[key];
    return v !== undefined ? v : whole; // unknown → keep the literal token
  });
}

/** A named template the user can apply in the editor (FR-NOTE-006). */
export interface NoteTemplate {
  id: string;
  label: string;
  body: string;
}

/** Built-in starter templates (deterministic, no clock — `{{date}}`/`{{time}}` fill at apply). */
export const BUILTIN_TEMPLATES: NoteTemplate[] = [
  {
    id: 'meeting',
    label: 'Meeting notes',
    body: '# {{title}}\n\n**Date:** {{date}}\n**Attendees:** \n\n## Agenda\n- \n\n## Notes\n- \n\n## Action items\n- [ ] '
  },
  {
    id: 'daily',
    label: 'Daily note',
    body: '# {{date}}\n\n## Today\n- \n\n## Notes\n- \n\n## Tomorrow\n- '
  },
  {
    id: 'idea',
    label: 'Idea',
    body: '# {{title}}\n\n**Captured:** {{datetime}}\n\n## Summary\n\n## Why it matters\n\n## Next step\n- [ ] '
  },
  {
    id: 'decision',
    label: 'Decision log',
    body: '# Decision: {{title}}\n\n**Date:** {{date}}\n**Owner:** \n**Status:** decided\n\n## Context\n\n## Decision\n\n## Alternatives considered\n- \n\n## Consequences\n- '
  }
];

/** Daily-note title is the ISO date (FR-NOTE-005), matching Obsidian's `YYYY-MM-DD` default. */
export function dailyNoteTitle(now: string): string {
  return isoDate(now);
}

/** Vault path for a daily note: `notes/<YYYY-MM-DD>.md` (FR-NOTE-005). */
export function dailyNotePath(now: string): string {
  return `notes/${isoDate(now)}.md`;
}

/** The default daily-note body, with `{{date}}` already expanded for `now`. */
export function dailyNoteBody(now: string): string {
  return expandTemplate(BUILTIN_TEMPLATES[1].body, { now });
}
