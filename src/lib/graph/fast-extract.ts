// Instant, model-free entity extraction — the tier-0 graph that appears the moment a note lands.
//
// LLM extraction (entities.ts) is the SLOW step of graph building: tens of seconds per generation
// even batched, and impossible without a loaded chat model. But most of a note's graph is visible
// without any model at all: proper nouns ARE capitalized (in English and Vietnamese alike),
// `[[wikilinks]]` are the user explicitly naming an entity, and two names sharing a sentence is a
// real, verifiable association. This module extracts exactly that — pure deterministic JS, no GPU,
// microseconds per note — so "Build graph" and every save shows entities IMMEDIATELY, and the LLM
// pass (when a model is available) only has to ENRICH: typed relations ("leads", "acquired") and
// non-capitalized concepts. Same philosophy as ADR-024 one level down: usable instantly, richer
// later.
//
// Correctness over recall: every emitted entity is a string that literally occurs in the note, and
// every relation only says "these two names share a sentence" (type `related_to`) — nothing here
// can hallucinate. The sentence-initial trap ("Hôm nay…", "The plan…") is handled by the classic
// rule: a SINGLE capitalized word only counts when it also appears capitalized mid-sentence
// somewhere in the note (multi-word runs and ALL-CAPS acronyms are kept outright).

import type { Extraction, ExtractedEntity, ExtractedRelation } from './entities';

/** Caps mirroring the LLM-side clamps — a heuristic pass on a long note shouldn't flood the graph. */
export const FAST_MAX_ENTITIES = 24;
export const FAST_MAX_RELATIONS = 48;

// A capitalized run: one or more capitalized words (letters incl. Vietnamese diacritics, digits,
// internal '’- as in "M-TP" or "O'Brien"), separated by single spaces ("Sơn Tùng M-TP", "Hà Nội").
const CAP_RUN = /\p{Lu}[\p{L}\p{N}'’-]*(?: \p{Lu}[\p{L}\p{N}'’-]*)*/gu;

const ACRONYM = /^[\p{Lu}\p{N}]{2,6}$/u;

// Diacritic-fold + lowercase (local copy of retrieval/search's, kept here so this tier-0 module stays
// self-contained). Lets the common-word filter match "Điểm" and a de-accented "Diem" alike.
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

// Vietnamese common / document-structure words that surface as FALSE single-word entities. A VN
// common-noun phrase capitalizes only its FIRST syllable ("Báo cáo", "Biên bản", "Điểm mạnh"), so
// CAP_RUN grabs that lone capitalized head ("Báo", "Biên", "Điểm") and the mid-sentence rule can't
// tell it from a name — on a vault of reports/minutes these dominated the graph ("Điểm"/"Tổng" alone
// hit ~88% of notes). Section labels ("Tổng:", "Mục", "STT") do the same. Stored diacritic-FOLDED;
// applied to single-word candidates and to multi-word runs only when EVERY word is one of these (a
// de-accented table header like "Doanh Thu"/"Loi Nhuan"). A run with any distinctive word ("Hà Nội",
// "Cảng Vĩnh Triều") is untouched, and wikilinks/acronyms always survive. prettier-ignore below keeps
// the word list dense and scannable.
const COMMON_WORDS = new Set([
  // section labels & structure
  'diem', 'tong', 'muc', 'bang', 'stt', 'ngay', 'thang', 'nam', 'ghi', 'ket', 'luan', 'noi', 'dung',
  'phan', 'chuong', 'tieu', 'hinh', 'anh', 'bieu', 'phu', 'luc', 'trang', 'loai', 'ten', 'gia', 'tri', 'so',
  // report / title heads & common business nouns (first syllable of 2-syllable terms)
  'bao', 'cao', 'bien', 'ban', 'nghien', 'cuu', 'thiet', 'huong', 'dan', 'quy', 'hoach', 'danh', 'sach',
  'thong', 'tin', 'cong', 'chinh', 'hien', 'thoi', 'gian', 'chuc', 'tich', 'tai', 'lieu', 'quan', 'hop',
  'doanh', 'thu', 'loi', 'nhuan', 'chi', 'nhanh', 'von', 'tang', 'truong', 'qua', 'mo', 'dau'
]); // prettier-ignore

/** True when a candidate is a FALSE proper noun by the VN-common-word rule: a lone single character
 *  ("C", "A"), or a run whose every word folds to a COMMON_WORDS entry. A run with any distinctive
 *  word returns false, so real multi-word names are never touched. */
function isCommonOnly(name: string): boolean {
  if (name.length === 1) return true; // a single letter is never a useful entity
  const words = name.split(/[- ]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => COMMON_WORDS.has(fold(w)));
}

// Sentence-case nibbler: when a capitalized run STARTS a sentence, its first word may be ordinary
// sentence case fused onto a real name ("Met Jane Smith…", "Gặp Thiên Nguyễn…"). These common
// English/Vietnamese sentence-openers are peeled off the FRONT of sentence-initial runs only —
// mid-sentence runs are never touched, so a genuine "The Beatles" mid-sentence survives. A name
// first word ("Jane", "Thiên") is not in the list, so name-initial sentences keep the full run.
const SENTENCE_STARTERS = new Set([
  // English — articles, pronouns, prepositions, conjunctions, auxiliaries, frequent verbs/adverbs
  'the', 'a', 'an', 'i', 'we', 'you', 'he', 'she', 'it', 'they', 'my', 'our', 'your', 'his',
  'her', 'its', 'their', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'by', 'for', 'to',
  'from', 'with', 'of', 'as', 'and', 'or', 'but', 'so', 'if', 'when', 'while', 'after', 'before',
  'during', 'then', 'now', 'here', 'there', 'what', 'who', 'how', 'why', 'where', 'is', 'are',
  'was', 'were', 'be', 'been', 'do', 'did', 'does', 'not', 'no', 'yes', 'met', 'see', 'saw',
  'today', 'yesterday', 'tomorrow', 'also', 'please', 'let',
  // Vietnamese — time words, pronouns, frequent verbs/connectives that open sentences
  'hôm', 'ngày', 'sáng', 'chiều', 'tối', 'trưa', 'năm', 'tháng', 'tuần', 'thứ', 'tôi', 'tớ',
  'mình', 'chúng', 'bạn', 'anh', 'chị', 'em', 'ông', 'bà', 'gặp', 'xem', 'đi', 'về', 'làm',
  'học', 'viết', 'đọc', 'nếu', 'khi', 'sau', 'trước', 'trong', 'ngoài', 'với', 'và', 'hoặc',
  'nhưng', 'vì', 'do', 'theo', 'từ', 'đến', 'tại', 'ở', 'có', 'không', 'đã', 'đang', 'sẽ',
  'rất', 'cần', 'phải', 'nên', 'hãy', 'xin'
]); // prettier-ignore

/** Peel common sentence-openers off the front of a SENTENCE-INITIAL run ("Met Jane Smith" →
 *  "Jane Smith"). Stops at the first word that isn't a known opener; may consume the whole run. */
function stripSentenceCase(run: string): string {
  const words = run.split(' ');
  let i = 0;
  while (i < words.length && SENTENCE_STARTERS.has(words[i].toLowerCase())) i++;
  return words.slice(i).join(' ');
}

/** Sentence split for the initial-word rule and co-occurrence pairing. Newlines end a "sentence"
 *  too — markdown lines (headings, list items) behave like sentences for both purposes. */
function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?…]+\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `[[target]]` / `[[target|alias]]` / `[[target#heading]]` → target. The user typing a wikilink
 *  is the strongest possible entity signal — kept unconditionally. */
function wikilinkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const inner = m[1].split('|')[0];
    const hash = inner.indexOf('#');
    const target = (hash >= 0 ? inner.slice(0, hash) : inner).trim();
    if (target) out.push(target);
  }
  return out;
}

/**
 * Extract the instant graph of one note: proper-noun + wikilink entities and sentence-level
 * co-occurrence relations. Pure and deterministic — feeds the SAME resolve → persist path as LLM
 * extraction, so dedup/junk-filtering/provenance behave identically. Entity type is always
 * 'other' (typing names correctly is the LLM tier's job); relation type is always 'related_to'
 * with confidence scaled by how often the pair shares a sentence (floor-clearing 0.5 base).
 */
export function extractHeuristic(text: string): Extraction {
  const sentences = sentencesOf(text);

  // Pass 1 — collect capitalized runs per sentence, tracking where they sit.
  interface Cand {
    name: string;
    count: number;
    midSentence: boolean; // seen at least once NOT as the sentence's first word
    multiWord: boolean;
  }
  const cands = new Map<string, Cand>(); // keyed by exact surface form
  const perSentence: string[][] = []; // candidate names appearing in each sentence
  for (const s of sentences) {
    const here: string[] = [];
    for (const m of s.matchAll(CAP_RUN)) {
      const initial = m.index === 0;
      const name = initial ? stripSentenceCase(m[0]) : m[0];
      if (!name) continue; // the whole run was sentence-case openers ("Hôm nay…", "The…")
      const c = cands.get(name) ?? {
        name,
        count: 0,
        midSentence: false,
        multiWord: name.includes(' ')
      };
      c.count++;
      if (!initial) c.midSentence = true;
      cands.set(name, c);
      here.push(name);
    }
    perSentence.push(here);
  }

  // Pass 2 — keep the trustworthy candidates. Multi-word runs and acronyms are proper nouns on
  // their face; a lone capitalized word must ALSO occur mid-sentence somewhere ("Hanoi is…" alone
  // is ambiguous, "…to Hanoi" proves it) so sentence-starters ("Hôm", "The") never become nodes.
  const kept = new Set<string>();
  for (const c of cands.values()) {
    if (ACRONYM.test(c.name)) {
      kept.add(c.name); // ALL-CAPS acronym — real even if it happens to fold to a common word
      continue;
    }
    if (!(c.multiWord || c.midSentence)) continue;
    if (isCommonOnly(c.name)) continue; // VN structural/common head ("Điểm", "Tổng", "Doanh Thu")
    kept.add(c.name);
  }
  for (const t of wikilinkTargets(text)) kept.add(t); // user-authored — always trusted

  // Rank by frequency (then first-seen via Map order) and clamp.
  const counted = [...kept].map((name) => ({ name, count: cands.get(name)?.count ?? 1 }));
  counted.sort((a, b) => b.count - a.count);
  const entities: ExtractedEntity[] = counted
    .slice(0, FAST_MAX_ENTITIES)
    .map(({ name }) => ({ name, type: 'other' as const }));
  const final = new Set(entities.map((e) => e.name));

  // Pass 3 — co-occurrence relations: two kept names sharing a sentence. Confidence grows with
  // repeat co-occurrence; the 0.5 base clears RELATION_CONFIDENCE_FLOOR so the edges persist.
  const pairCount = new Map<string, { a: string; b: string; n: number }>();
  for (const names of perSentence) {
    const present = [...new Set(names.filter((n) => final.has(n)))];
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const [a, b] = [present[i], present[j]].sort();
        const key = `${a}|${b}`;
        const p = pairCount.get(key) ?? { a, b, n: 0 };
        p.n++;
        pairCount.set(key, p);
      }
    }
  }
  const relations: ExtractedRelation[] = [...pairCount.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, FAST_MAX_RELATIONS)
    .map(({ a, b, n }) => ({
      source: a,
      target: b,
      type: 'related_to',
      confidence: Math.min(0.9, 0.5 + 0.1 * (n - 1))
    }));

  return { entities, relations };
}
