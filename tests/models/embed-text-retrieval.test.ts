import { describe, it, expect } from 'vitest';
import { embed } from '../../src/lib/embed/embedder';
import { cosineSimilarity } from '../../src/lib/retrieval/search';
import { buildEmbedText, headingIndex, docTitleOf, sectionAt } from '../../src/lib/ingest/embed-text';

// REAL-embedder proof for the worker's contextual embed (embed-text.ts) — what gets fed to the model
// instead of raw chunk text. Two guarantees that matter for shipping:
//   (a) the STARTER VAULT is preserved — the heading-less Japan-trip notes (seed.ts) the onboarding
//       tour question targets embed the SAME as before (no prefix to add), so the flagship demo never
//       regresses, and
//   (b) a STRUCTURED note genuinely improves — a markdown table embeds more findably once its bars +
//       separator rules are stripped and a "Title › Section" context is prepended.
// CPU, no GPU (like the other model-backed tests). This locks in the manual A/B done at ship time.

// Verbatim starter notes (src/lib/onboard/seed.ts) — the vault the tour question asks about.
const TRIP: Record<string, string> = {
  overview:
    'Our 10-day Japan trip in April with Maya, Leo and Priya. The route is Tokyo → Kyoto → Osaka, plus a day trip to [[Hakone]]. Flights are booked and the budget target is about $1,900 each. #japan #trip',
  tokyo:
    'In Tokyo (3 nights) we stay in Shinjuku. Maya wants teamLab Planets and Leo wants the Tsukiji fish market. From here we take a day trip to [[Hakone]]. #japan',
  kyoto:
    'Kyoto (4 nights) is the temple leg: Fushimi Inari at dawn and the Arashiyama bamboo grove. Priya booked a traditional ryokan called Sakura Inn for two of the nights. #japan',
  osaka:
    'Osaka (2 nights) is the food leg — Dotonbori street food and okonomiyaki. Leo is our foodie and is planning this part. #japan',
  preferences:
    'Maya loves art and quiet temples. Leo lives for food and nightlife. Priya wants culture and shopping. We try to fit one thing for each person into every day. #japan'
};
const OFF_TOPIC = 'Caffeine blocks adenosine receptors, reducing perceived fatigue. Half-life about 5-6 hours.';

/** The worker's transform for a whole-note chunk: derive title/section from the note's own headings. */
function embedTextOf(body: string): string {
  const hs = headingIndex(body);
  return buildEmbedText({ docTitle: docTitleOf(hs), section: sectionAt(hs, 0), body });
}

describe('embed-text — starter vault preserved, structured notes improve', () => {
  it('keeps the flagship tour question ranking the right trip note first (no regression)', async () => {
    const q = await embed('What do Maya, Leo and Priya each want to do in Japan?');
    const raw: [string, number][] = [];
    const ctx: [string, number][] = [];
    for (const [k, v] of Object.entries(TRIP)) {
      raw.push([k, cosineSimilarity(q, await embed(v))]);
      ctx.push([k, cosineSimilarity(q, await embed(embedTextOf(v)))]);
    }
    const offTopic = cosineSimilarity(q, await embed(embedTextOf(OFF_TOPIC)));
    raw.sort((a, b) => b[1] - a[1]);
    ctx.sort((a, b) => b[1] - a[1]);

    // Heading-less trip notes → empty contextual prefix → embed text ≈ raw → identical top match.
    expect(ctx[0][0]).toBe('preferences');
    expect(ctx[0][0]).toBe(raw[0][0]);
    // No bleed introduced: every trip note still outranks the off-topic note by a clear margin.
    for (const [, score] of ctx) expect(score).toBeGreaterThan(offTopic + 0.1);
  });

  it('makes a markdown table embed more findably than the raw piped table', async () => {
    const q = await embed('doanh thu Thiên Lộc A quý 4');
    const rawTable =
      '| Quý | Sản phẩm | Doanh thu |\n| --- | --- | --- |\n| Q4 | Thiên Lộc A | 1620 |\n| Q3 | Thiên Lộc B | 980 |';
    const titledNote = `# Báo cáo tài chính Q4\n\n## Doanh thu theo sản phẩm\n\n${rawTable}`;
    const hs = headingIndex(titledNote);
    const ctxText = buildEmbedText({
      docTitle: docTitleOf(hs),
      section: sectionAt(hs, titledNote.indexOf('| Q4')),
      body: rawTable
    });

    const rawCos = cosineSimilarity(q, await embed(rawTable));
    const ctxCos = cosineSimilarity(q, await embed(ctxText));
    // Direction is the robust guarantee; the measured lift was ~+0.12, so a 0.03 floor is safe of noise.
    expect(ctxCos).toBeGreaterThan(rawCos);
    expect(ctxCos - rawCos).toBeGreaterThan(0.03);
  });
});
