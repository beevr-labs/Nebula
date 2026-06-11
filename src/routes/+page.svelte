<script lang="ts">
  // Nebula workspace — the "Obsidian DNA" surfaces on the REAL RAG pipeline, now with
  // multi-format ingestion: drop PDF/CSV/TXT/MD → intake → Markdown Proxy Note (source
  // backlink, original untouched) → chunk → bge embed → SurrealDB HNSW (indxdb) → retrieve
  // → WebLLM grounded answer. 40/60 resizable split (FR-UI-001); Magic Jump scroll+highlight
  // (FR-CHAT-003); the Weaver auto-wikilinks (FR-LINK-001/002); Micro-Map (FR-GRAPH-001/002);
  // Export Vault → .zip of .md proxies + original binaries under sources/ (FR-DATA-006). In-browser.
  import '$lib/styles/tokens.css';
  import { onMount, tick } from 'svelte';
  import type { SearchHit } from '$lib/inference/provider';
  import type { NoteRecord, ExpandedHit } from '$lib/db/store';
  import { buildTitleIndex, notePreview } from '$lib/weave/weaver';
  import { buildMicroGraph, type MicroGraph } from '$lib/graph/micrograph';
  import { selectGraphRagContext } from '$lib/retrieval/graphrag';
  import { ingestDocGraph, seedDocGraph } from '$lib/graph/ingest-graph';
  import type { Extraction, ExtractedRelation } from '$lib/graph/entities';
  import { buildEntityIndex, type EntityEntry } from '$lib/graph/entity-index';
  import { buildEntityGraph, type EntityGraph, type GraphNeighbor } from '$lib/graph/entity-graph';
  import type { EntityRecord, MentionEdge, RelationEdge } from '$lib/graph/types';
  import type { TextGenerator } from '$lib/ingest/autotag';
  import { resolveCitationTarget, buildHighlightSegments, answerUsage } from '$lib/chat/citation';
  import { exportVaultZip } from '$lib/vault/export';
  import { intake } from '$lib/ingest/intake';
  import { csvToMarkdown } from '$lib/ingest/csv';
  import { buildProxyNote, proxyNotePath } from '$lib/ingest/proxy';
  import {
    CHAT_MODELS,
    formatSize,
    needsOomAck,
    modelById,
    recommendModel
  } from '$lib/inference/catalog';
  import { createNote, updateNote, renameNote, moveNotePath } from '$lib/vault/note-crud';
  import { serializeNote } from '$lib/vault/note';
  import { putSource, allSources, deleteSource } from '$lib/vault/sources-db';
  import {
    resolveTarget,
    buildBacklinks,
    findUnlinkedMentions,
    autocompleteWikilink,
    applyWikilinkChoice,
    rewriteWikilinkTitle,
    type AutocompleteState
  } from '$lib/weave/wikilink';
  import { renderMarkdown, linkifyCitations } from '$lib/render/markdown';
  import { splitReasoning } from '$lib/chat/reasoning';
  import { quickSwitch, type SwitchResult } from '$lib/nav/switcher';
  import {
    BUILTIN_TEMPLATES,
    expandTemplate,
    dailyNoteTitle,
    dailyNotePath,
    dailyNoteBody
  } from '$lib/vault/template';
  import { buildFileTree, type TreeNode } from '$lib/nav/tree';
  import { layoutEntityGraph, entityColor, type GraphLayout } from '$lib/graph/graph-layout';
  import {
    applyOverrides,
    zoomAt,
    panBy,
    toGraphPoint,
    pxToViewBoxScale,
    IDENTITY_VIEW,
    type ViewTransform
  } from '$lib/graph/graph-view';
  import {
    folderOf,
    isUnder,
    notesUnderFolder,
    repathUnderFolder,
    deriveChildFolder,
    renamedFolderPath,
    allFolders
  } from '$lib/nav/folders';
  import * as uiPrefs from '$lib/settings/ui-prefs';
  import { buildTagIndex, notesForTag, coerceTags, extractInlineTags } from '$lib/nav/tags';
  import { scopeDocIds, filterByScope, scopeLabel, type Scope } from '$lib/retrieval/scope';
  import {
    dedupeByDoc,
    entityAnchorDocs,
    hybridRerank,
    queryTerms,
    referencesFromHits,
    relevantHits,
    restrictToEntities,
    withLexicalChannel,
    type SourceRef
  } from '$lib/retrieval/search';
  import { sourcesFromNotes, sourcesFromHits, parseRedactions } from '$lib/context/sources';
  import { compile, countTokensFor } from '$lib/context/compiler';
  import { selectContext } from '$lib/context/select';
  import {
    redactionPreview,
    redactionsForEntity,
    piiRedactions,
    redactionSummary,
    toCompilerRedactions,
    buildAuditRecord,
    type Redaction,
    type PiiType,
    type AuditRecord
  } from '$lib/context/redact';
  import { resolvePastedAnswer } from '$lib/context/roundtrip';
  import { formatCost } from '$lib/context/cost';

  type Note = {
    docId: string;
    title: string;
    aliases: string[];
    text: string;
    kind?: string; // 'pdf' | 'csv' | 'txt' | 'md' for imports; undefined for seed
    sourcePath?: string; // backlink to the untouched original
    frontmatter?: Record<string, unknown>;
  };
  type Cite = { n: number; chunkId: string; docId: string };

  // Demo vault — a friendly, two-topic onboarding TOUR for a brand-new user. Two little notebooks with
  // NO shared entities ("Japan trip with friends" in trip/ and a "sleep research" notebook in
  // research/) so Scope isolates them cleanly; within each, notes share people/places/ideas but few
  // words, so GraphRAG + Reason connect them the way keyword search can't (e.g. "Sakura Inn" links the
  // Kyoto note to the budget note). `start-here` is the guided tour itself. Only seeds an empty vault;
  // real notes are never touched — the user can delete all of this and start their own.
  const TOUR_DOC = 'start-here.md'; // the onboarding tour note — visible/editable but NOT RAG-indexed
  const SEED: Note[] = [
    {
      docId: 'start-here.md',
      title: '👋 Start here',
      aliases: ['Welcome', 'Start', 'Tour'],
      text: `# 👋 Welcome to Nebula

Nebula turns your notes into something you can **ask** — and everything runs **on your device**, so nothing ever leaves your computer.

This demo has two little notebooks so you can see what it does: a **Japan trip** with friends (\`trip/\`) and a **sleep research** notebook (\`research/\`). Try the things below, then delete it all and make it your own.

## 1 · Ask your notes  (press ⌘J)
- **Synthesize across notes:** *"What does each friend want to do in Japan?"*
- **Add up the numbers:** *"What's the total budget per person for the trip?"*
- **Reason, don't just quote** (Reason mode): *"Based on my sleep notes, what should I change in my routine?"*
- **Follow up:** after an answer, ask *"and why?"* — it remembers the conversation.
- **Cited & verifiable:** answers show [#1] markers — click one to jump to the exact note.

## 2 · See the knowledge graph  (Graph tab → Build entity graph)
Nebula links your notes through shared **people, places and ideas**, even when they share no words.
- Open the **Graph** tab, click **Build entity graph**, then open an entity like **Maya** or **caffeine** — you'll see every note connected to it.
- In Ask, try *"What is Maya planning across the whole trip?"* — it gathers every note she appears in.

## 3 · Keep topics apart  (Scope)
Set **Scope → trip/** and ask *"Summarize our Japan trip"* — you'll only ever get trip notes, never your research.

## 4 · Make it yours
- **New note** to write; link notes with \`[[double brackets]]\`; tag with \`#hashtags\`.
- Drop in a **PDF or CSV** and it becomes searchable too.

#welcome`
    },

    // ── Japan trip with friends ───────────────────────────────────────────────
    {
      docId: 'trip/overview.md',
      title: 'Japan trip — overview',
      aliases: ['Japan trip', 'Japan'],
      text: 'Our 10-day Japan trip in April with Maya, Leo and Priya. The route is Tokyo → Kyoto → Osaka, plus a day trip to [[Hakone]]. Flights are booked and the budget target is about $1,900 each. #japan #trip'
    },
    {
      docId: 'trip/tokyo.md',
      title: 'Tokyo',
      aliases: ['Tokyo', 'Shinjuku'],
      text: 'In Tokyo (3 nights) we stay in Shinjuku. Maya wants teamLab Planets and Leo wants the Tsukiji fish market. From here we take a day trip to [[Hakone]]. #japan'
    },
    {
      docId: 'trip/kyoto.md',
      title: 'Kyoto',
      aliases: ['Kyoto', 'Sakura Inn', 'ryokan'],
      text: 'Kyoto (4 nights) is the temple leg: Fushimi Inari at dawn and the Arashiyama bamboo grove. Priya booked a traditional ryokan called Sakura Inn for two of the nights. #japan'
    },
    {
      docId: 'trip/osaka.md',
      title: 'Osaka',
      aliases: ['Osaka', 'Dotonbori'],
      text: 'Osaka (2 nights) is the food leg — Dotonbori street food and okonomiyaki. Leo is our foodie and is planning this part. #japan'
    },
    {
      docId: 'trip/hakone.md',
      title: 'Hakone day trip',
      aliases: ['Hakone'],
      text: 'A day trip to Hakone from Tokyo: Lake Ashi, the open-air museum and an onsen. Note: Maya is allergic to eggs, so we skip the famous black eggs. #japan'
    },
    {
      docId: 'trip/budget.md',
      title: 'Trip budget',
      aliases: ['budget', 'JR Pass'],
      text: 'Budget per person: flights $700, hotels $500, food $400, and a JR Pass for transport $300 — that comes to about $1,900 each. Maya already paid the Sakura Inn deposit of $150 on behalf of the group. #japan #money'
    },
    {
      docId: 'trip/preferences.md',
      title: 'What everyone wants',
      aliases: ['preferences'],
      text: 'Maya loves art and quiet temples. Leo lives for food and nightlife. Priya wants culture and shopping. We try to fit one thing for each person into every day. #japan'
    },

    // ── Sleep research notebook ───────────────────────────────────────────────
    {
      docId: 'research/overview.md',
      title: 'Sleep — overview',
      aliases: ['sleep', 'sleep research'],
      text: 'Notes on why sleep works the way it does. Two systems drive it: the circadian rhythm (a daily body clock) and sleep pressure (a chemical that builds up while you are awake). #sleep #research'
    },
    {
      docId: 'research/circadian.md',
      title: 'Circadian rhythm',
      aliases: ['circadian rhythm', 'circadian', 'SCN'],
      text: 'The circadian rhythm is a ~24-hour clock set mainly by light and run by the SCN in the hypothalamus. Morning light shifts it earlier; bright evening light shifts it later. #sleep'
    },
    {
      docId: 'research/adenosine.md',
      title: 'Sleep pressure & adenosine',
      aliases: ['adenosine', 'sleep pressure'],
      text: 'Sleep pressure comes from adenosine, which builds up in the brain the longer you stay awake and makes you drowsy. It clears out again while you sleep. #sleep'
    },
    {
      docId: 'research/caffeine.md',
      title: 'Caffeine',
      aliases: ['caffeine', 'coffee'],
      text: 'Caffeine works by blocking adenosine receptors, masking drowsiness. Its half-life is about 5–6 hours, so an afternoon coffee can still be active at bedtime. #sleep'
    },
    {
      docId: 'research/melatonin.md',
      title: 'Melatonin',
      aliases: ['melatonin', 'pineal gland'],
      text: 'Melatonin is released by the pineal gland when it gets dark and signals "night" to the body. Bright light in the evening suppresses it and pushes sleep later. #sleep'
    },
    {
      docId: 'research/why-we-sleep.md',
      title: 'Why We Sleep (notes)',
      aliases: ['Matthew Walker', 'Why We Sleep'],
      text: 'From "Why We Sleep" by Matthew Walker: deep NREM sleep helps consolidate memories, while REM sleep supports emotional regulation — both stages matter. #sleep #book'
    },
    {
      docId: 'research/takeaways.md',
      title: 'Sleep — what to actually do',
      aliases: ['sleep tips', 'takeaways'],
      text: 'Putting it together: get morning sunlight (it sets the circadian rhythm), stop caffeine after about 2 PM (its half-life is long), and dim the lights at night (to protect melatonin). #sleep'
    }
  ];

  // A HAND-AUTHORED knowledge graph for the seed notes (FR-GRAPH-001), keyed by docId. Seeding this
  // directly means a first-run user sees the full entity graph INSTANTLY — without loading the chat
  // model and running LLM extraction. Each entity name must appear (as a substring) in its note's
  // text so the chunk-level mention edges attach; entities sharing a name across notes merge into one
  // node (e.g. "Sakura Inn" links Kyoto↔budget; "Maya" is a hub; "adenosine" links the caffeine note
  // to the sleep-pressure note) — the same cross-note links GraphRAG rides on. The two topics share
  // NO entities, so the graph stays cleanly split between trip/ and research/.
  const r = (source: string, target: string, type: string): ExtractedRelation => ({
    source,
    target,
    type,
    confidence: 0.95
  });
  const SEED_GRAPH: Record<string, Extraction> = {
    'trip/overview.md': {
      entities: [
        { name: 'Maya', type: 'person' },
        { name: 'Leo', type: 'person' },
        { name: 'Priya', type: 'person' },
        { name: 'Tokyo', type: 'place' },
        { name: 'Kyoto', type: 'place' },
        { name: 'Osaka', type: 'place' },
        { name: 'Hakone', type: 'place' }
      ],
      relations: []
    },
    'trip/tokyo.md': {
      entities: [
        { name: 'Tokyo', type: 'place' },
        { name: 'Shinjuku', type: 'place' },
        { name: 'Maya', type: 'person' },
        { name: 'teamLab Planets', type: 'place' },
        { name: 'Leo', type: 'person' },
        { name: 'Tsukiji', type: 'place' },
        { name: 'Hakone', type: 'place' }
      ],
      relations: [
        r('Maya', 'teamLab Planets', 'wants_to_visit'),
        r('Leo', 'Tsukiji', 'wants_to_visit')
      ]
    },
    'trip/kyoto.md': {
      entities: [
        { name: 'Kyoto', type: 'place' },
        { name: 'Fushimi Inari', type: 'place' },
        { name: 'Arashiyama', type: 'place' },
        { name: 'Priya', type: 'person' },
        { name: 'Sakura Inn', type: 'org' }
      ],
      relations: [r('Priya', 'Sakura Inn', 'booked'), r('Sakura Inn', 'Kyoto', 'located_in')]
    },
    'trip/osaka.md': {
      entities: [
        { name: 'Osaka', type: 'place' },
        { name: 'Dotonbori', type: 'place' },
        { name: 'Leo', type: 'person' },
        { name: 'food', type: 'concept' }
      ],
      relations: [r('Leo', 'Osaka', 'plans'), r('Leo', 'food', 'likes')]
    },
    'trip/hakone.md': {
      entities: [
        { name: 'Hakone', type: 'place' },
        { name: 'Tokyo', type: 'place' },
        { name: 'Lake Ashi', type: 'place' },
        { name: 'Maya', type: 'person' }
      ],
      relations: [r('Hakone', 'Tokyo', 'day_trip_from')]
    },
    'trip/budget.md': {
      entities: [
        { name: 'Maya', type: 'person' },
        { name: 'Sakura Inn', type: 'org' },
        { name: 'JR Pass', type: 'other' }
      ],
      relations: [r('Maya', 'Sakura Inn', 'paid_deposit')]
    },
    'trip/preferences.md': {
      entities: [
        { name: 'Maya', type: 'person' },
        { name: 'Leo', type: 'person' },
        { name: 'Priya', type: 'person' },
        { name: 'art', type: 'concept' },
        { name: 'food', type: 'concept' },
        { name: 'shopping', type: 'concept' }
      ],
      relations: [
        r('Maya', 'art', 'likes'),
        r('Leo', 'food', 'likes'),
        r('Priya', 'shopping', 'likes')
      ]
    },
    'research/overview.md': {
      entities: [
        { name: 'circadian rhythm', type: 'concept' },
        { name: 'sleep pressure', type: 'concept' },
        { name: 'sleep', type: 'concept' }
      ],
      relations: [
        r('circadian rhythm', 'sleep', 'regulates'),
        r('sleep pressure', 'sleep', 'regulates')
      ]
    },
    'research/circadian.md': {
      entities: [
        { name: 'circadian rhythm', type: 'concept' },
        { name: 'SCN', type: 'concept' },
        { name: 'hypothalamus', type: 'place' },
        { name: 'light', type: 'concept' }
      ],
      relations: [r('SCN', 'circadian rhythm', 'controls'), r('light', 'circadian rhythm', 'sets')]
    },
    'research/adenosine.md': {
      entities: [
        { name: 'sleep pressure', type: 'concept' },
        { name: 'adenosine', type: 'concept' }
      ],
      relations: [r('adenosine', 'sleep pressure', 'causes')]
    },
    'research/caffeine.md': {
      entities: [
        { name: 'caffeine', type: 'concept' },
        { name: 'adenosine', type: 'concept' }
      ],
      relations: [r('caffeine', 'adenosine', 'blocks')]
    },
    'research/melatonin.md': {
      entities: [
        { name: 'melatonin', type: 'concept' },
        { name: 'pineal gland', type: 'concept' },
        { name: 'light', type: 'concept' }
      ],
      relations: [r('pineal gland', 'melatonin', 'releases'), r('light', 'melatonin', 'suppresses')]
    },
    'research/why-we-sleep.md': {
      entities: [
        { name: 'Why We Sleep', type: 'other' },
        { name: 'Matthew Walker', type: 'person' },
        { name: 'NREM', type: 'concept' },
        { name: 'REM', type: 'concept' }
      ],
      relations: [r('Matthew Walker', 'Why We Sleep', 'wrote')]
    },
    'research/takeaways.md': {
      entities: [
        { name: 'circadian rhythm', type: 'concept' },
        { name: 'caffeine', type: 'concept' },
        { name: 'melatonin', type: 'concept' }
      ],
      relations: []
    }
  };

  const MODELS = CHAT_MODELS; // curated tiny→large picker with VRAM labels + OOM guard (catalog.ts)

  let vault = $state<Note[]>(SEED.map((n) => ({ ...n })));
  let originals = $state<{ path: string; bytes: Uint8Array }[]>([]);

  // The Weaver's title index (FR-LINK-001) — rebuilds as the vault grows.
  const titleIndex = $derived(
    buildTitleIndex(
      vault.map((n) => ({ docId: n.docId, title: n.title, aliases: n.aliases, summary: n.text }))
    )
  );

  // Vault note bodies for backlink/mention scans (FR-LINK-004/005).
  const vaultBodies = $derived(
    vault.map((n) => ({ docId: n.docId, title: n.title, body: n.text, aliases: n.aliases }))
  );
  const backlinks = $derived(buildBacklinks(vaultBodies, titleIndex));

  let status = $state('starting…');
  let ready = $state(false);
  // Default to the fast 1B (good speed/quality for first load); larger, more accurate models are
  // one pick away in the catalog. `?? MODELS[0]` keeps it safe if the id is ever pruned.
  const DEFAULT_MODEL_ID = (
    MODELS.find((m) => m.id === 'Llama-3.2-1B-Instruct-q4f16_1-MLC') ?? MODELS[0]
  ).id;
  let modelId = $state(DEFAULT_MODEL_ID);
  let query = $state('');
  let answer = $state('');
  let busy = $state(false); // a generation is in flight (declared early — the answer deriveds read it)
  // Multi-turn Ask (FR-CHAT-006): `askedQuery` is the question that produced the CURRENT answer (the
  // composer is cleared on send so a follow-up can be typed); `history` holds the prior completed
  // Q→A turns — replayed into the prompt so a follow-up keeps the thread, and shown as a transcript.
  let askedQuery = $state('');
  let history = $state<{ query: string; answer: string }[]>([]);
  // The answer rendered as safe Markdown HTML (FR-CHAT-001) with clickable [#n] citations woven in —
  // headings, lists, bold, tables format properly instead of showing raw Markdown. Magic Jump on a
  // [#n] resolves via `references` (onRenderedClick). Empty until an answer streams in.
  let cites = $state<Cite[]>([]);
  let hits = $state<SearchHit[]>([]);
  let references = $state<SourceRef[]>([]); // distinct source docs behind the answer (FR-CHAT-002)
  // Only the citation numbers that map to a real retrieved source (the `references` panel) may render
  // as a live [#n] button. A small model often emits extra markers (e.g. [#5] when 2 sources exist,
  // or invents citations on an ungrounded answer); those are stripped so the user never sees a
  // citation that jumps to nothing (FR-CHAT-002/003).
  const citeNumbers = $derived(new Set(references.map((r) => r.n)));
  // Reasoning models emit a <think>…</think> block before the answer. Split it out so the reasoning
  // shows in its own collapsible panel and only the real answer is rendered as Markdown (FR-CHAT).
  const split = $derived(splitReasoning(answer));
  const hasAnswer = $derived(split.content.trim().length > 0);
  // Reasoning models (Qwen3, DeepSeek-R1) can spend their whole context thinking and stop before
  // writing an answer — leaving `content` empty. When generation has FINISHED with no answer, fall
  // back to showing the reasoning as the answer so the user never sees a blank reply (FR-CHAT).
  const answerFellBack = $derived(!busy && !hasAnswer && split.reasoning.length > 0);
  const answerSource = $derived(hasAnswer ? split.content : answerFellBack ? split.reasoning : '');
  // Show the "Thoughts" panel while still thinking, or beside a real answer — but NOT when we've had
  // to promote the reasoning into the answer slot (that would render it twice).
  const showThoughts = $derived(split.reasoning.length > 0 && (busy || hasAnswer));
  const reasoning = $derived(showThoughts ? split.reasoning : '');
  const reasoningHtml = $derived(
    reasoning ? renderMarkdown(reasoning, { resolveLink: resolveNoteLink }) : ''
  );
  const answerHtml = $derived(
    answerSource
      ? linkifyCitations(
          renderMarkdown(answerSource, { resolveLink: resolveNoteLink }),
          citeNumbers
        )
      : ''
  );
  // Past turns in the transcript keep their prose but DROP citation buttons: their retrieved `hits`
  // are no longer held, so Magic Jump couldn't resolve them — an empty valid set strips the markers.
  // Reasoning is stripped from past turns too (the transcript shows answers, not their scratchpads).
  const NO_CITES: ReadonlySet<number> = new Set();
  const pastAnswerHtml = (a: string): string =>
    linkifyCitations(
      renderMarkdown(splitReasoning(a).content, { resolveLink: resolveNoteLink }),
      NO_CITES
    );
  let graph = $state<MicroGraph | null>(null);
  let activeDoc = $state<string | null>(null);
  let activeSpan = $state<{ charStart: number; charEnd: number } | null>(null);
  // Open notes live in a center tab strip (FR-NOTE multi-tab): `openTabs` is the ordered list of
  // open docIds and `activeDoc` is the one shown. Opening a note (sidebar, citation, backlink…)
  // adds a tab; closing one falls back to a neighbour. `tabDrag` is the docId being reordered.
  let openTabs = $state<string[]>([]);
  let tabDrag = $state<string | null>(null);
  let ttft = $state(0);
  let tps = $state(0);
  let coi = $state(false);
  let modelCached = $state(false); // weights already on disk → fast load, no download (#4)
  let ackedModels = $state(new Set<string>()); // large models the user already OK'd (FR-CAP-003)
  let gpu = $state<{ ok: boolean; vendor: string; arch: string } | null>(null);
  let preloading = $state(false); // a background model preload is in flight
  let loadPhase = $state<'' | 'downloading' | 'loading' | 'compiling'>(''); // model-load stage
  let loadPct = $state(0); // 0–100 download/load progress for the gpu-bar bar
  let modelLoading = $state(false); // a chat-model load is in flight → locks the picker (no concurrent loads)

  // Ingestion UI.
  let importMsg = $state('');
  let dropActive = $state(false);
  let fileInput: HTMLInputElement;

  // Note editor (FR-NOTE-001/003, FR-UI-002). Notes are the PRIMARY action — the app lands in
  // Write mode with the subject pre-filled; Ask is the secondary tab.
  let mode = $state<'ask' | 'write'>('write');
  let draftTitle = $state(new Date().toISOString().slice(0, 10));
  let draftFolder = $state('notes'); // target folder for a NEW note (FR-NOTE-007)
  const EMBED_PROGRESS_MIN = 4; // only show per-chunk indexing progress past this many chunks
  let draftBody = $state('');
  let editingDocId = $state<string | null>(null); // null → creating a new note
  let editMsg = $state('');
  let savingNote = $state(false);

  // BACKGROUND indexing queue (ADR-024, the Obsidian model): saving a note is INSTANT — the note
  // lands in the vault and the editor frees immediately; embedding happens here, off the save path,
  // so a long note never locks the editor. The note is searchable once its job drains.
  type IndexJob = { docId: string; body: string; oldDocId?: string };
  let indexJobs: IndexJob[] = [];
  let indexRunning = false;
  let bgPending = $state(0); // notes waiting/being indexed (drives the unobtrusive header indicator)
  let bgProgress = $state(''); // e.g. "apollo 32/66" for the current job
  // Notes whose CHUNKS are written (searchable now) but whose entity GRAPH is still extracting. The
  // LLM extraction is the slow part of indexing on a long note; decoupling it from the embed pass
  // lets a note become searchable immediately while its graph fills in (non-blocking — see
  // drainIndexQueue's two passes). Drives a subtle, separate "building graph…" header hint.
  let graphBuilding = $state(0);
  // Transient "✓ indexed <note> · N entities" confirmation shown in the header when a background
  // index finishes, then auto-clears back to the plain "indexed" pill (FR-UI: visible feedback).
  let indexDone = $state('');
  let indexDoneTimer: ReturnType<typeof setTimeout> | null = null;
  // Set when a background index couldn't extract a note's entity graph because no model was loaded —
  // the embeddings (and plain RAG) still land, but the graph is now behind. Drives a non-blocking
  // "Build graph" hint in the Entities pane; cleared by a successful buildVaultGraph (FR-GRAPH-001).
  let graphStale = $state(false);
  let bodyEl = $state<HTMLTextAreaElement>();
  let wlState = $state<AutocompleteState | null>(null); // wikilink autocomplete (FR-LINK-003)

  // Quick switcher (FR-NAV-001).
  let switcherOpen = $state(false);
  let switcherQuery = $state('');

  // File tree + tag pane (FR-NAV-002/003).
  let collapsed = $state(new Set<string>());
  let activeTag = $state<string | null>(null);
  // Entities pane shows the top 6 by default; this expands it to the full list (scrollable).
  let showAllEntities = $state(false);

  // Live Markdown preview (FR-UI-002 · §5.10).
  let previewOn = $state(true);

  // Retrieval scope (FR-RET-004) — restrict Ask + Compile to one client (folder/tag).
  let scope = $state<Scope | null>(null);

  // Answer mode (FR-CHAT-005): 'reason' = apply knowledge + reason WITH the notes (default — what
  // makes it feel like an assistant, not a search box); 'grounded' = strict, notes-only, verifiable.
  let answerMode = $state<'grounded' | 'reason'>('reason');

  // Knowledge graph (Phases 1–4). GraphRAG fuses vector seeds with graph-connected siblings — the
  // lever for the local-LLM quality ceiling. The Entities pane + entity page navigate the persisted
  // graph; the entity graph view is the multi-hop "how is X connected to Y" map.
  let graphRagOn = $state(true); // use GraphRAG when the vault has a graph (degrades to plain RAG)
  let graphInfo = $state(''); // e.g. "+3 graph-connected" — shows GraphRAG actually expanded context
  let graphExpandedIds = $state(new Set<string>()); // chunkIds that entered via graph expansion (badge)
  // chunkId → which seed entities connect it: drives the source label + Micro-Map edge weight (ADR-029 follow-up)
  let graphShared = $state(new Map<string, { sharedCount: number; sharedEntities: string[] }>());
  let entityIndex = $state<EntityEntry[]>([]); // the Entities pane (built from persisted edges)
  let entityRelations = $state<RelationEdge[]>([]); // all relations, for the entity graph view
  let selectedEntity = $state<EntityEntry | null>(null); // open entity page
  let entityGraph = $state<EntityGraph | null>(null); // multi-hop sub-graph for the selected entity
  // Interactive graph view (Phase 4): per-node drag positions + pan/zoom. Reset when a new entity opens.
  let nodeOverrides = $state(new Map<string, { x: number; y: number }>());
  let graphView = $state<ViewTransform>(IDENTITY_VIEW);
  let svgEl = $state<SVGSVGElement | undefined>();
  let drag = $state<
    | { kind: 'node'; id: string; gx: number; gy: number; moved: boolean; px: number; py: number }
    | { kind: 'pan'; px: number; py: number }
    | null
  >(null);
  let entityNotes = $state<string[]>([]); // docIds mentioning the selected entity
  let graphBusy = $state(false);

  // Workspace view (FR-NAV-002): 'files' = folder tree + the open note SIDE BY SIDE (the tree is
  // always present — opening a note fills the doc panel beside it, never replaces the tree, the
  // Obsidian explorer model); 'graph' = the Entities section: an entity list + a node-link graph.
  let rightView = $state<'files' | 'graph'>('files');

  // "Clean Slate" design system: light/dark theme on the document root (data-theme).
  // Initialized from ui-prefs in onMount (client-only, avoids a hydration mismatch).
  let theme = $state<'light' | 'dark'>('light');
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    uiPrefs.setTheme(theme);
  }
  $effect(() => {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  });
  let entityQuery = $state(''); // filter box for the Graph-mode entity list

  // Empty folders the user created (folders are otherwise derived from note paths) — persisted in
  // localStorage so an EMPTY folder survives a refresh without touching the SurrealDB schema.
  let emptyFolders = $state<string[]>([]);

  // File-tree direct manipulation (FR-NAV-002): a right-click context menu (add/rename/move/delete,
  // new folder) + drag-a-note-onto-a-folder to move it. `dropFolder` highlights the hovered target.
  let ctxMenu = $state<{
    x: number;
    y: number;
    kind: 'file' | 'folder' | 'root';
    path: string;
  } | null>(null);
  let dragDocId = $state<string | null>(null);
  let dropFolder = $state<string | null>(null);

  // Startup model gate (FR-MDL-005): on first run, choose which chat model to warm up in the
  // BACKGROUND before any Ask / build-graph, so generation is ready the moment it's first needed.
  let modelGate = $state(false);
  let wantBackgroundLoad = false; // a model was chosen before `pipe` existed → load once it's ready
  let cachedModels = $state<Set<string>>(new Set()); // model ids already downloaded to this browser
  let deletingModel = $state(''); // id mid-deletion (disables its row)

  // Context Compiler UI (FR-CTX-*) — compact, token-counted share to another LLM.
  const COMPILE_MODELS = ['gpt-4o', 'gpt-4', 'claude-sonnet', 'claude-opus'];
  let compileOpen = $state(false);
  let compileModel = $state('claude-sonnet');
  let compileRedact = $state('');
  let compileSources = $state<ReturnType<typeof sourcesFromNotes>>([]);
  let compileFrom = $state<'scope' | 'answer'>('scope');
  // Context-Engine controls (CE2/CE3/CE1/CE4).
  let compileTask = $state(''); // CE2 — optional question → a paste-and-go payload (cite-by-path#seq)
  const PII_TYPES: PiiType[] = ['email', 'phone', 'ssn', 'credit_card', 'ip'];
  let compilePii = $state(new Set<PiiType>()); // CE3 — PII types to scrub before serialization
  let redactEntityId = $state(''); // CE3 — redact a chosen entity (all its aliases) by id
  let redactConnected = $state(false); // CE3 — also redact its connected people/projects
  let compileEntityRedactions = $state<Redaction[]>([]); // resolved patterns for the picked entity
  let compileBudget = $state(4000); // CE1 — token budget when compiling "this context"
  let pasteBack = $state(''); // CE4 — paste a frontier answer to resolve its citations back to the vault
  let exportAudit = $state<AuditRecord[]>([]); // CE3 — local export log (hashes + counts only, NFR-SEC-004)

  let preview = $state<{ text: string; x: number; y: number } | null>(null);

  let pipe: {
    embed: (t: string) => Promise<number[]>;
    search: (v: number[], k: number) => Promise<SearchHit[]>;
    lexical: (v: number[], terms: string[], k: number) => Promise<SearchHit[]>;
    relate: (qid: string, hs: SearchHit[]) => Promise<void>;
    ingest: (
      docId: string,
      text: string,
      onProgress?: (done: number, total: number) => void
    ) => Promise<void>;
    removeDoc: (docId: string) => Promise<void>;
    putNote: (note: NoteRecord) => Promise<void>;
    forgetNote: (docId: string) => Promise<void>;
    // Knowledge graph (entities + relations): GraphRAG retrieval, ingest-time extraction, and
    // navigation/traversal over the persisted graph (Phases 1–4).
    graphRag: (
      v: number[],
      opts: { seedK: number; expandK: number; k: number }
    ) => Promise<{
      seeds: SearchHit[];
      expanded: ExpandedHit[];
      fused: SearchHit[];
      entityIds: string[];
    }>;
    indexGraph: (docId: string, text: string) => Promise<number>;
    seedGraph: (docId: string, text: string, extraction: Extraction) => Promise<number>;
    clearGraph: (docId: string) => Promise<void>;
    entityData: () => Promise<{
      entities: EntityRecord[];
      mentions: MentionEdge[];
      relations: RelationEdge[];
    }>;
    entityNeighbors: (id: string, hops: number) => Promise<GraphNeighbor[]>;
    relationsAmong: (ids: string[]) => Promise<RelationEdge[]>;
    mentionsForEntity: (id: string) => Promise<{ docId: string; chunkId: string }[]>;
    provider: {
      isCached: (m: string) => Promise<boolean>;
      deleteModel: (m: string) => Promise<void>;
      loadModel: (m: string, cb: (p: number) => void) => Promise<void>;
      complete?: (p: string, o?: { maxTokens?: number }) => Promise<string>;
      generate: (
        req: {
          requestId: string;
          query: string;
          context: SearchHit[];
          modelId: string;
          maxTokens: number;
          answerMode: 'grounded' | 'reason';
          history?: { query: string; answer: string }[];
        },
        onTok: (t: string) => void,
        sig: AbortSignal
      ) => Promise<{
        text: string;
        citations: { chunkId: string; spanInAnswer: [number, number] }[];
        ttftMs: number;
        tokensPerSec: number;
      }>;
    };
  } | null = null;
  let loadedModel = $state('');
  // The embedder backend on THIS machine (GPU vs CPU) + measured speed — shown in the header so a
  // user can see whether indexing is GPU-accelerated or silently fell back to the ~15×-slower CPU path.
  let embedBackend = $state<{ device: '' | 'webgpu' | 'cpu'; chunksPerSec: number } | null>(null);

  onMount(async () => {
    coi = crossOriginIsolated;
    theme = uiPrefs.getTheme();
    // Probe WebGPU once at startup (FR-CAP-001, ADR-030): is chat possible and on what GPU? Drives the
    // GPU status line + the model recommendation. (We deliberately do NOT read maxBufferSize as a load
    // cap — WebLLM shards weights across buffers, so large models load fine on capable GPUs.)
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter) {
        gpu = {
          ok: true,
          vendor: adapter.info?.vendor || '',
          arch: adapter.info?.architecture || ''
        };
      }
    } catch {
      /* no WebGPU → chat unsupported; semantic search still works (FR-CAP-002) */
    }
    // Default to the GPU-recommended model (Qwen2.5-3B — multilingual, far better entity/relation
    // extraction than the tiny 1B) when WebGPU is present. Auto-preload only fires if it's already
    // cached, so this never triggers a surprise multi-GB download — the first Ask/build does.
    {
      const rec = recommendModel(!!gpu?.ok);
      if (rec) modelId = rec.id;
    }
    // Restore UI prefs + raise the startup model gate (FR-MDL-005). A saved pick overrides the GPU
    // recommendation; first run (never onboarded) shows the gate so the user picks what to warm up.
    emptyFolders = uiPrefs.getEmptyFolders();
    rightView = uiPrefs.getView();
    const savedModel = uiPrefs.getModelPref();
    if (savedModel && MODELS.some((m) => m.id === savedModel)) modelId = savedModel;
    modelGate = !uiPrefs.isOnboarded();

    const [{ createEmbedClient }, { VectorStore }, { WebLLMProvider }, { EMBEDDING_DIM }] =
      await Promise.all([
        import('$lib/embed/embed-client'),
        import('$lib/db/store'),
        import('$lib/inference/webllm'),
        import('$lib/inference/provider')
      ]);

    status = 'loading embedder…';
    // ALL chunking + embedding runs in a Worker (ADR-023) so a long note never freezes the UI; the
    // main thread only upserts the returned vectors into SurrealDB (a cheap, fast DB write).
    const embedClient = createEmbedClient();
    const store = new VectorStore();
    try {
      // -minilm namespace: the 384-dim MiniLM-L12 index must not collide with the old 1024-dim bge-m3
      // store (a fresh namespace re-seeds + re-indexes the demo vault with the new model on first load).
      await store.connect('indxdb://nebula-app-minilm', EMBEDDING_DIM);
    } catch (e) {
      // mem:// means NOTHING persists across refresh — surface it rather than silently losing notes.
      console.warn('Nebula: persistent store unavailable, falling back to in-memory:', e);
      await store.connect('mem://', EMBEDDING_DIM);
    }

    const indexNote = async (
      docId: string,
      text: string,
      onProgress?: (done: number, total: number) => void
    ) => {
      const embedded = await embedClient.indexText(text, { size: 60, overlap: 12 }, onProgress);
      await store.upsertChunks(
        embedded.map((e) => ({
          chunkId: `${docId}#${e.chunk.seq}`,
          docId,
          text: e.chunk.text,
          page: e.chunk.page,
          charStart: e.chunk.charStart,
          charEnd: e.chunk.charEnd,
          embedding: e.embedding
        }))
      );
    };

    // Rehydrate the vault from the persisted `note` table (FR-DATA-001). In the browser build there
    // are no `.md` files on disk, so this table IS the source of truth — without it every saved note
    // is lost on refresh. First run (empty table) → seed the demo notes, persist + index them once;
    // later runs → load the saved notes and DO NOT re-embed (their chunks already persist in indxdb).
    const saved = await store.allNotes();
    if (saved.length > 0) {
      status = 'loading notes…';
      vault = saved.map((n) => ({
        docId: n.docId,
        title: n.title,
        aliases: n.aliases ?? [],
        text: n.body,
        kind: n.kind,
        sourcePath: n.sourcePath,
        frontmatter: n.frontmatter
      }));
    } else {
      status = 'indexing vault…';
      for (const note of vault) {
        await store.upsertNote({
          docId: note.docId,
          title: note.title,
          body: note.text,
          aliases: note.aliases,
          kind: note.kind,
          sourcePath: note.sourcePath,
          frontmatter: note.frontmatter
        });
        // The onboarding tour note is META (it literally CONTAINS the example questions). Indexing it
        // would make every suggested question self-match the tour as its top hit — crowding out the
        // real notes AND raising the relevance floor so they get dropped. So persist it (it's visible
        // + editable) but never embed it into the RAG index. Same reason it's skipped in the graph.
        if (note.docId !== TOUR_DOC) await indexNote(note.docId, note.text);
        // Seed the PRE-BUILT graph for this note (entities + mentions + relations) with no LLM, so the
        // demo's knowledge graph is ready the instant the vault loads — the user never waits for the
        // chat model to load + extract. Runs after indexNote so the chunks exist for mention edges.
        const ex = SEED_GRAPH[note.docId];
        if (ex) await seedDocGraph(store, note.docId, note.text, ex);
      }
      // First run: greet the user with the guided "Start here" tour (read view) instead of a blank
      // editor, so they immediately see what the app can do and what to try.
      if (vault.some((n) => n.docId === TOUR_DOC)) {
        openInTab(TOUR_DOC);
        mode = 'ask';
        rightView = 'files';
      }
    }

    // Rehydrate proxy-note source binaries so Export Vault still ships the originals after a refresh.
    try {
      originals = await allSources();
    } catch (e) {
      console.warn('Nebula: could not load source binaries:', e);
    }

    const provider = new WebLLMProvider();

    // Ingest-time knowledge-graph extraction (Phase 1). Best-effort, exactly like auto-tagging: with
    // no chat model loaded there's nothing to extract WITH, so skip — chunks/embeddings (and thus
    // plain RAG) are unaffected. With a model loaded, skim → extract → resolve → persist with
    // chunk-level provenance so GraphRAG can later expand on shared entities.
    // Thin adapter over ingestDocGraph (graph/ingest-graph.ts) — keeps the legacy numeric contract the
    // callers below use: -2 = no model loaded (couldn't extract), -1 = skipped (unchanged),
    // >0 = entities extracted, 0 = ran but found nothing. The -2 case lets the background queue flag
    // the graph as stale so the user is told to build it, instead of the note silently never
    // appearing in the graph (the "I made a note but the graph didn't update" bug).
    const indexGraph = async (docId: string, text: string): Promise<number> => {
      const gen: TextGenerator | null =
        loadedModel && provider.complete ? (p, o) => provider.complete(p, o) : null;
      const r = await ingestDocGraph(store, docId, text, gen);
      return r.status === 'no_model'
        ? -2
        : r.status === 'skipped'
          ? -1
          : r.status === 'ingested'
            ? r.entityCount
            : 0;
    };

    pipe = {
      embed: (t) => embedClient.embedQuery(t),
      search: (v, k) => store.search(v, k),
      lexical: (v, terms, k) => store.lexicalSearch(v, terms, k),
      relate: (qid, hs) =>
        store.relateRetrieval(
          qid,
          hs.map((h) => ({ chunkId: h.chunkId, score: h.score }))
        ),
      ingest: indexNote,
      removeDoc: (docId) => store.deleteDoc(docId),
      putNote: (note) => store.upsertNote(note),
      forgetNote: (docId) => store.deleteNote(docId),
      graphRag: (v, opts) => store.graphRagSearch(v, opts),
      indexGraph,
      seedGraph: (docId, text, extraction) => seedDocGraph(store, docId, text, extraction),
      clearGraph: (docId) => store.clearDocGraph(docId),
      entityData: async () => ({
        entities: await store.allEntities(),
        mentions: await store.allMentions(),
        relations: await store.allRelations()
      }),
      entityNeighbors: (id, hops) => store.entityNeighbors(id, hops),
      relationsAmong: (ids) => store.relationsAmong(ids),
      mentionsForEntity: (id) => store.mentionsForEntity(id),
      provider
    };
    status = 'ready';
    ready = true;
    // Warm the embedder in the BACKGROUND now (idle startup), so the user's first save doesn't eat the
    // one-time WebGPU cold start (model session init + first-inference shader compile). By the time they
    // write a note it's hot, and indexing is fast from the first save.
    // backendInfo() both warms the model AND reports GPU-vs-CPU + measured speed for the header chip.
    void embedClient
      .backendInfo()
      .then((info) => {
        embedBackend = info;
      })
      .catch(() => {});
    // Populate the Entities pane from any graph persisted in a prior session — and if the user is
    // landing straight on the Graph tab (restored view) with a graph already present, open the top
    // entity so the node-link map shows immediately rather than an empty "pick an entity" canvas.
    void refreshEntities().then(() => {
      if (rightView === 'graph' && !selectedEntity && entityIndex.length)
        void openEntity(entityIndex[0]);
    });

    // Warm up in the background (FR-MDL-005 / ADR-030): load the chat model AND auto-build the entity
    // graph so the Graph tab shows a visualization on its own. If the user already has a saved pick
    // (chose at the gate in any session), honor it — downloading if needed, since picking IS the
    // consent — so a refresh re-warms automatically. With no pick we only warm when already cached
    // (instant, no surprise multi-GB download). While the gate is still open we wait: chooseModel()
    // kicks off the warm-up the moment the user picks.
    if (wantBackgroundLoad) void warmStartup();
    else if (!modelGate) {
      const hasPick = !!savedModel;
      if (hasPick || (await pipe.provider.isCached(modelId).catch(() => false))) void warmStartup();
    }
    if (modelGate) void refreshModelCacheStatus(); // first-run gate is open → show "on disk" badges
  });

  const today = (): string => new Date().toISOString().slice(0, 10);

  // Multi-format ingestion (FR-ING-001/012): drop/pick PDF/CSV/TXT/MD → Markdown Proxy Note.
  async function ingestFiles(list: FileList | null) {
    if (!pipe || !ready || !list || list.length === 0) return;
    let queued = 0; // files that parsed OK and were handed to the background index queue
    let firstDoc = ''; // open ONE tab (the first import) at the end, not one per file
    for (const file of Array.from(list)) {
      importMsg = `ingesting ${file.name}…`;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const res = intake({ name: file.name, bytes });
        if (!res.ok) {
          importMsg = `skipped ${file.name}: ${res.reason}`;
          continue;
        }
        let body = '';
        let sourcePath: string | undefined;
        if (res.type === 'pdf') {
          try {
            importMsg = `reading PDF ${file.name}…`;
            const { extractPdf } = await import('$lib/ingest/pdf');
            body = (await extractPdf(bytes)).text;
            if (!body.trim()) {
              importMsg = `${file.name} has no extractable text (scanned image PDF?) — skipped`;
              continue;
            }
          } catch (e) {
            importMsg = `couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`;
            continue;
          }
          sourcePath = `sources/${file.name}`;
        } else if (res.type === 'csv') {
          body = csvToMarkdown(res.text ?? '');
          sourcePath = `sources/${file.name}`;
        } else {
          body = res.text ?? '';
        }
        if (!body.trim()) {
          importMsg = `nothing to index in ${file.name}`;
          continue;
        }
        const stem = file.name.replace(/\.[^.]+$/, '');
        const docId = sourcePath ? proxyNotePath(sourcePath) : `notes/${stem}.md`;
        const note = buildProxyNote({
          sourcePath,
          body,
          now: today(),
          taggableLater: !!sourcePath
        });
        const isReimport = vault.some((n) => n.docId === docId);
        // INSTANT (the Obsidian model, ADR-024): the file joins the vault NOW — visible, linkable,
        // exportable — exactly like a single-note save. The heavy work (embedding + LLM entity graph)
        // runs in the BACKGROUND queue, so dropping 10 large files no longer blocks the import loop
        // file-by-file on each one's embed + graph extraction.
        await pipe.putNote({
          docId,
          title: stem,
          body,
          aliases: [],
          kind: res.type,
          sourcePath,
          frontmatter: note.frontmatter
        });
        vault = [
          ...vault.filter((n) => n.docId !== docId),
          {
            docId,
            title: stem,
            aliases: [],
            text: body,
            kind: res.type,
            sourcePath,
            frontmatter: note.frontmatter
          }
        ];
        if (sourcePath) {
          originals = [
            ...originals.filter((o) => o.path !== sourcePath),
            { path: sourcePath, bytes }
          ];
          await putSource(sourcePath, bytes); // persist the original so Export survives a refresh
        }
        // Queue PASS 1 (embed → searchable) + PASS 2 (entity graph, decoupled). On a re-import, pass
        // the old docId so the queue drops the stale chunks/graph before re-embedding.
        enqueueIndex(docId, body, isReimport ? docId : undefined);
        queued++;
        if (!firstDoc) firstDoc = docId;
        importMsg = `✓ added ${stem}`;
      } catch (e) {
        importMsg = `error on ${file.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // Indexing now runs in the BACKGROUND queue (the header shows "indexing…" → "building graph…" →
    // "indexed"), and that queue calls refreshEntities() once when it drains — so we DON'T refresh
    // here: a refresh inside/after this loop runs a READ that can overlap the queue's WRITES and wedge
    // the IndexedDB engine ("Can not open transaction") on large bulk ingests (FOUND via stress test).
    if (firstDoc) showSource(firstDoc);
    if (queued > 1) importMsg = `✓ added ${queued} files — indexing in the background`;
    if (fileInput) fileInput.value = '';
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dropActive = false;
    void ingestFiles(e.dataTransfer?.files ?? null);
  }

  // --- Note editor (FR-NOTE-001/003, FR-UI-002) ------------------------------
  // Author a note → write a portable `.md` (frontmatter + body) → index it immediately so it is
  // searchable, citable, weave-linkable, and exportable to any LLM (Export Vault / Context Compiler).
  function startNewNote() {
    editingDocId = null;
    draftTitle = today(); // subject pre-filled with today's date (overwrite if you want)
    draftBody = '';
    editMsg = '';
    activeTag = null; // so returning to the vault lands on the folder tree, not a stale filter
    mode = 'write';
  }

  function editNote(note: Note) {
    editingDocId = note.docId;
    draftTitle = String(note.frontmatter?.title ?? note.title ?? '');
    draftBody = note.text;
    editMsg = '';
    mode = 'write';
  }

  const shortName = (docId: string) => docId.slice(docId.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  /** Show a transient header confirmation (e.g. "indexed foo · 3 entities"), then clear it. */
  function flashIndexed(msg: string) {
    indexDone = msg;
    if (indexDoneTimer) clearTimeout(indexDoneTimer);
    indexDoneTimer = setTimeout(() => {
      indexDone = '';
      indexDoneTimer = null;
    }, 4000);
  }

  /** Queue a note for background indexing (drop old chunks first on an edit/rename, then embed). */
  function enqueueIndex(docId: string, body: string, oldDocId?: string) {
    indexJobs.push({ docId, body, oldDocId });
    bgPending = indexJobs.length;
    void drainIndexQueue();
  }

  /**
   * Drain the index queue off the save path in TWO passes (the worker does the heavy embedding —
   * ADR-023/024). The win for long notes: a note becomes SEARCHABLE the instant its chunks are
   * written, instead of waiting on the slow LLM entity-extraction. So:
   *   PASS 1 (embed): write chunks for every queued note — this is the "indexing" pill, and what
   *     plain RAG needs. Cleared as soon as it's done → the note answers questions immediately.
   *   PASS 2 (graph): extract + persist each note's entity graph (an LLM pass, the slow part) under
   *     a SEPARATE, non-blocking "building graph…" hint. The vault is already usable while it runs.
   */
  async function drainIndexQueue() {
    if (indexRunning || !pipe) return;
    indexRunning = true;
    let failed = 0; // notes whose embed threw (surfaced instead of silently swallowed)
    let firstErr = ''; // first failure's message → tell "embed model didn't load" apart from a bad note
    let doneCount = 0; // notes whose chunks landed this drain (for the completion pill)
    let lastName = ''; // last note's short name (the common single-note case)
    // PASS 1 — embed + persist chunks. Makes the note searchable; holds the "indexing" pill.
    const graphJobs: IndexJob[] = [];
    while (indexJobs.length) {
      const job = indexJobs[0];
      try {
        if (job.oldDocId) {
          await pipe.removeDoc(job.oldDocId);
          await pipe.clearGraph(job.oldDocId);
        }
        await pipe.ingest(job.docId, job.body, (done, total) => {
          bgProgress = total > EMBED_PROGRESS_MIN ? `${shortName(job.docId)} ${done}/${total}` : '';
        });
        graphJobs.push(job); // chunks exist → eligible for graph extraction in pass 2
        lastName = shortName(job.docId);
        doneCount++;
      } catch (e) {
        // A failed index shouldn't wedge the queue; the note stays in the vault, just unindexed —
        // but DON'T swallow it silently: count it + keep the reason so the header can say WHY.
        failed++;
        if (!firstErr) firstErr = e instanceof Error ? e.message : String(e);
      }
      indexJobs.shift();
      bgPending = indexJobs.length;
      bgProgress = '';
    }
    // The note(s) are searchable now — confirm immediately, don't wait on graph extraction.
    if (failed > 0) {
      // Usually it's not a bad note — it's the embedding model failing to load (offline, storage
      // quota, or no WebGPU). Name THAT so a user doesn't think their note is corrupt.
      const modelIssue = /model|pipeline|onnx|fetch|network|load|download|gpu|wasm/i.test(firstErr);
      flashIndexed(
        modelIssue
          ? "⚠ couldn't load the embedding model — check connection, then save again to retry"
          : `⚠ ${failed} note${failed > 1 ? 's' : ''} failed to index`
      );
    } else if (doneCount > 0)
      flashIndexed(`indexed ${doneCount === 1 ? truncate(lastName, 22) : `${doneCount} notes`}`);

    // PASS 2 — entity graph (LLM extraction): the slow step, run WITHOUT blocking the indexed state.
    let missedGraph = false; // a note whose entities couldn't be extracted (no model) → graph behind
    let entSum = 0;
    graphBuilding = graphJobs.length;
    for (const job of graphJobs) {
      try {
        const ents = await pipe.indexGraph(job.docId, job.body);
        if (ents === -2) missedGraph = true;
        if (ents > 0) entSum += ents;
      } catch {
        /* graph extraction is best-effort; the note stays searchable regardless */
      }
      graphBuilding = Math.max(0, graphBuilding - 1);
    }
    indexRunning = false;
    if (entSum > 0)
      flashIndexed(`graph updated · ${entSum} ${entSum === 1 ? 'entity' : 'entities'}`);
    await refreshEntities(); // once, after the queue drains — never per-job (avoids the read/write race)
    // If extraction ran (a model was loaded), the graph is current — clear any prior stale flag and
    // refresh the open entity canvas so a new note's entities show without a manual rebuild. If it
    // couldn't run (no model), flag the graph stale so the Entities pane prompts a build (FR-GRAPH-001).
    if (missedGraph) {
      graphStale = true;
    } else {
      graphStale = false;
      if (rightView === 'graph' && selectedEntity) await openEntity(selectedEntity);
    }
    // New saves can arrive during the (slow) graph pass — drain them now that we've released the lock.
    if (indexJobs.length) void drainIndexQueue();
  }

  /** Rebuild the Entities pane from the persisted graph (after ingest / index / delete). Phase 2. */
  async function refreshEntities() {
    if (!pipe) return;
    try {
      const data = await pipe.entityData();
      entityIndex = buildEntityIndex(data.entities, data.mentions);
      entityRelations = data.relations;
    } catch {
      /* graph is best-effort; an empty pane is fine */
    }
  }

  /** Open an entity page: its notes (mentions) + a multi-hop sub-graph over the persisted graph. */
  async function openEntity(e: EntityEntry) {
    if (!pipe) return;
    selectedEntity = e;
    rightView = 'graph'; // the entity opens in the Graph section's node-link canvas
    entityQuery = '';
    graphBusy = true;
    entityGraph = null;
    entityNotes = [];
    // Keep the open tabs intact — the graph lens just hides the read view; closing it (switchView
    // 'files') returns to whatever note was active.
    resetGraphView();
    try {
      entityNotes = [...new Set((await pipe.mentionsForEntity(e.id)).map((m) => m.docId))].sort();
      const neighbors = await pipe.entityNeighbors(e.id, 2); // 1–2 hops (Phase 4 traversal)
      const ids = [e.id, ...neighbors.map((n) => n.id)];
      const rels = await pipe.relationsAmong(ids);
      entityGraph = buildEntityGraph(
        { id: e.id, name: e.name, type: e.type },
        neighbors,
        rels.map((r) => ({ sourceId: r.sourceId, targetId: r.targetId, type: r.type }))
      );
    } finally {
      graphBusy = false;
    }
  }
  function closeEntity() {
    selectedEntity = null;
    entityGraph = null;
    entityNotes = [];
    resetGraphView();
  }

  // --- Interactive entity graph: drag nodes + pan/zoom (Phase 4 visual) --------------------------
  // Geometry is pure (graph-view.ts); these handlers only translate pointer/wheel events into it.
  function resetGraphView() {
    nodeOverrides = new Map();
    graphView = IDENTITY_VIEW;
    drag = null;
  }
  const DRAG_THRESHOLD = 4; // px the pointer must move before a node press counts as a drag, not a click

  function graphPointFromEvent(ev: PointerEvent): { x: number; y: number } {
    const rect = svgEl?.getBoundingClientRect();
    const vbW = entityLayout?.width ?? 1;
    const vbH = entityLayout?.height ?? 1;
    if (!rect) return { x: 0, y: 0 };
    return toGraphPoint(ev.clientX, ev.clientY, rect, vbW, vbH, graphView);
  }

  function onNodePointerDown(ev: PointerEvent, n: { id: string; x: number; y: number }) {
    ev.stopPropagation(); // don't also start a background pan
    const p = graphPointFromEvent(ev);
    drag = { kind: 'node', id: n.id, gx: n.x - p.x, gy: n.y - p.y, moved: false, px: ev.clientX, py: ev.clientY }; // prettier-ignore
    svgEl?.setPointerCapture(ev.pointerId);
  }
  function onGraphPointerDown(ev: PointerEvent) {
    drag = { kind: 'pan', px: ev.clientX, py: ev.clientY };
    svgEl?.setPointerCapture(ev.pointerId);
  }
  function onGraphPointerMove(ev: PointerEvent) {
    if (!drag) return;
    if (drag.kind === 'node') {
      if (Math.hypot(ev.clientX - drag.px, ev.clientY - drag.py) > DRAG_THRESHOLD)
        drag.moved = true;
      const p = graphPointFromEvent(ev);
      const next = new Map(nodeOverrides);
      next.set(drag.id, { x: p.x + drag.gx, y: p.y + drag.gy });
      nodeOverrides = next;
    } else {
      const rect = svgEl?.getBoundingClientRect();
      const k = pxToViewBoxScale(rect?.width ?? 1, entityLayout?.width ?? 1);
      graphView = panBy(graphView, (ev.clientX - drag.px) * k, (ev.clientY - drag.py) * k);
      drag.px = ev.clientX;
      drag.py = ev.clientY;
    }
  }
  function onGraphPointerUp(ev: PointerEvent) {
    // A node press that never moved is a click → open that entity (multi-hop browse).
    if (drag?.kind === 'node' && !drag.moved) {
      const id = drag.id;
      const node = entityLayout?.nodes.find((n) => n.id === id);
      if (node && node.hop !== 0) openEntityById(node.id);
    }
    svgEl?.releasePointerCapture?.(ev.pointerId);
    drag = null;
  }
  function onGraphWheel(ev: WheelEvent) {
    ev.preventDefault();
    const rect = svgEl?.getBoundingClientRect();
    const vbW = entityLayout?.width ?? 1;
    const vbH = entityLayout?.height ?? 1;
    if (!rect) return;
    // Anchor the zoom on the cursor, in viewBox space (the <g> transform lives in viewBox units).
    const vbX = ((ev.clientX - rect.left) / rect.width) * vbW;
    const vbY = ((ev.clientY - rect.top) / rect.height) * vbH;
    graphView = zoomAt(graphView, ev.deltaY < 0 ? 1.1 : 1 / 1.1, vbX, vbY);
  }

  /** Jump from a node in the entity graph to that entity's page (multi-hop browsing). */
  function openEntityById(id: string) {
    const e = entityIndex.find((x) => x.id === id);
    if (e) {
      void openEntity(e);
      return;
    }
    const node = entityGraph?.nodes.find((n) => n.id === id);
    if (node)
      void openEntity({ id, name: node.label, type: node.type ?? '', noteCount: 0, docIds: [] });
  }

  /** One-click: extract the entity graph across the whole vault (loads the model if needed). */
  async function buildVaultGraph() {
    if (!pipe || graphBusy) return;
    if (!loadedModel) {
      const ok = await ensureModelLoaded(modelId);
      if (!ok) return;
    }
    graphBusy = true;
    try {
      let extracted = 0;
      let skipped = 0;
      for (const n of vault) {
        if (n.docId === TOUR_DOC) continue; // the meta tour note never joins the graph (would bridge topics)
        status = `extracting entities: ${shortName(n.docId)}…`;
        const r = await pipe.indexGraph(n.docId, n.text).catch(() => 0);
        if (r === -1) skipped++;
        else if (r > 0) extracted++;
      }
      await refreshEntities();
      graphStale = false; // the whole vault was just (re)extracted — nothing is behind anymore
      status =
        `graph ready · ${entityIndex.length} entities · ${extracted} extracted` +
        (skipped ? `, ${skipped} unchanged (skipped)` : '');
      // If the user is looking at the Graph tab, open the top entity so the node-link map appears
      // right away rather than leaving an empty "pick an entity" canvas after a build.
      if (rightView === 'graph' && !selectedEntity && entityIndex.length)
        void openEntity(entityIndex[0]);
    } finally {
      graphBusy = false;
    }
  }

  async function saveNote() {
    if (!pipe || !ready || savingNote) return;
    // Never block a save on a missing subject — default it to today's date. Duplicates are
    // fine: createNote auto-suffixes the path (-2, -3…) so nothing is ever overwritten.
    draftTitle = draftTitle.trim() || today();
    savingNote = true;
    editMsg = 'saving…';
    try {
      const nowIso = new Date().toISOString();
      const body = draftBody;
      const oldDocId = editingDocId ?? undefined;
      let file;
      if (editingDocId) {
        const existing = vault.find((n) => n.docId === editingDocId);
        const currentMd = serializeNote({
          frontmatter: existing?.frontmatter ?? { title: existing?.title ?? draftTitle },
          body: existing?.text ?? ''
        });
        file = await updateNote({
          docId: editingDocId,
          markdown: currentMd,
          title: draftTitle,
          body,
          now: nowIso
        });
      } else {
        file = await createNote({
          title: draftTitle,
          body,
          now: nowIso,
          folder: draftFolder,
          existingPaths: vault.map((n) => n.docId)
        });
      }
      // INSTANT save (the Obsidian model, ADR-024): the note is in the vault NOW — visible,
      // linkable, editable — and the editor frees immediately. Embedding runs in the BACKGROUND
      // queue, so a long note never locks the editor; it becomes searchable when its job drains.
      const title = String(file.note.frontmatter.title ?? draftTitle);
      const noteRec: NoteRecord = {
        docId: file.docId,
        title,
        body,
        aliases: [],
        kind: 'note',
        frontmatter: file.note.frontmatter
      };
      vault = [
        ...vault.filter((n) => n.docId !== file.docId && n.docId !== editingDocId),
        {
          docId: file.docId,
          title,
          aliases: [],
          text: body,
          kind: 'note',
          frontmatter: file.note.frontmatter
        }
      ];
      // Persist the note doc durably FIRST (fast DB write) so it survives a refresh even before its
      // embeddings finish (FR-DATA-001). An edit that changed the path also forgets the old record.
      if (oldDocId && oldDocId !== file.docId) await pipe.forgetNote(oldDocId);
      await pipe.putNote(noteRec);
      enqueueIndex(file.docId, body, oldDocId);
      editMsg = `✓ saved ${file.docId}`;
      // Notes are primary: flow straight into a fresh note (date pre-filled), with the folder
      // tree visible on the right (clear any tag filter / open doc) so navigation isn't lost.
      editingDocId = null;
      draftTitle = today();
      draftBody = '';
      mode = 'write';
      activeTag = null;
      activeDoc = null;
      activeSpan = null;
    } catch (e) {
      editMsg = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      savingNote = false;
    }
  }

  /** Re-key a note's chunks from `oldDocId` → `newDocId` via the background queue (non-blocking). */
  function reindexAs(oldDocId: string, newDocId: string, body: string) {
    enqueueIndex(newDocId, body, oldDocId);
  }

  // Delete a note (FR-NOTE-009): remove it from the vault + drop its chunks from the index. Works
  // for hand-written notes AND proxy notes (the untouched original under sources/ is unaffected).
  /** Purge a note from the index, the persisted note doc, its graph edges, and any source binary —
   *  WITHOUT touching the in-memory `vault` array (the caller mutates that once, in bulk). Shared by
   *  single-note delete and folder delete so both stay consistent after a refresh. */
  async function removeNoteCompletely(docId: string) {
    if (!pipe) return;
    await pipe.removeDoc(docId);
    await pipe.forgetNote(docId); // drop the persisted note doc too, so it stays deleted after refresh
    await pipe.clearGraph(docId); // and its entity-graph edges (entity nodes stay if other docs use them)
    const gone = vault.find((n) => n.docId === docId);
    if (gone?.sourcePath) {
      originals = originals.filter((o) => o.path !== gone.sourcePath);
      await deleteSource(gone.sourcePath); // forget the persisted original binary too
    }
  }

  async function deleteNote(docId: string) {
    if (!pipe || !ready) return;
    if (!confirm(`Delete ${docId}?\nThis removes it from the vault and the search index.`)) return;
    await removeNoteCompletely(docId);
    void refreshEntities();
    vault = vault.filter((n) => n.docId !== docId);
    closeTab(docId); // drop its tab (and pick a neighbour if it was active)
    if (editingDocId === docId) {
      editingDocId = null;
      draftTitle = today();
      draftBody = '';
    }
    editMsg = `🗑 deleted ${docId}`;
  }

  // Rename a note (FR-NOTE-008): change its title + path, re-index under the new docId, AND rewrite
  // every inbound `[[OldTitle]]` wikilink in the rest of the vault so no link breaks (links resolve
  // by title). Each note whose body changes is re-embedded so retrieval stays consistent.
  async function renameNoteAction(note: Note) {
    if (!pipe || !ready) return;
    const oldTitle = note.title;
    const next = prompt('Rename note — new title:', oldTitle);
    if (next === null) return;
    const newTitle = next.trim();
    if (!newTitle || newTitle === oldTitle) return;
    const nowIso = new Date().toISOString();
    const md = serializeNote({
      frontmatter: note.frontmatter ?? { title: note.title },
      body: note.text
    });
    const file = await renameNote({
      docId: note.docId,
      markdown: md,
      newTitle,
      now: nowIso,
      existingPaths: vault.map((n) => n.docId)
    });
    const newTitleStr = String(file.note.frontmatter.title);
    reindexAs(note.docId, file.docId, note.text);

    // Rewrite inbound [[oldTitle]] links across every other note; re-index the ones that changed.
    const rewrites = new Map<string, string>();
    for (const other of vault) {
      if (other.docId === note.docId) continue;
      const r = rewriteWikilinkTitle(other.text, oldTitle, newTitleStr);
      if (r.changed) rewrites.set(other.docId, r.text);
    }
    for (const [docId, body] of rewrites) reindexAs(docId, docId, body);

    vault = vault
      .filter((n) => n.docId !== note.docId)
      .map((n) => (rewrites.has(n.docId) ? { ...n, text: rewrites.get(n.docId)! } : n))
      .concat([
        {
          docId: file.docId,
          title: newTitleStr,
          aliases: note.aliases ?? [],
          text: note.text,
          kind: note.kind,
          sourcePath: note.sourcePath,
          frontmatter: file.note.frontmatter
        }
      ]);
    // Persist: forget the old path, store the renamed note, and re-store every link-rewritten note.
    await pipe.forgetNote(note.docId);
    await pipe.putNote({
      docId: file.docId,
      title: newTitleStr,
      body: note.text,
      aliases: note.aliases ?? [],
      kind: note.kind,
      sourcePath: note.sourcePath,
      frontmatter: file.note.frontmatter
    });
    for (const n of vault) {
      if (rewrites.has(n.docId)) {
        await pipe.putNote({
          docId: n.docId,
          title: n.title,
          body: n.text,
          aliases: n.aliases,
          kind: n.kind,
          sourcePath: n.sourcePath,
          frontmatter: n.frontmatter
        });
      }
    }
    openTabs = openTabs.map((d) => (d === note.docId ? file.docId : d));
    if (activeDoc === note.docId) activeDoc = file.docId;
    if (editingDocId === note.docId) editingDocId = file.docId;
    editMsg = `✓ renamed → ${file.docId}${rewrites.size ? ` (rewrote ${rewrites.size} link${rewrites.size > 1 ? 's' : ''})` : ''}`;
  }

  // Move a note to another folder (FR-NOTE-008): the filename (slug) and title are unchanged, so
  // title-based wikilinks keep resolving — only the docId/path changes, re-keyed in the index.
  /** Move ONE note into `destFolder` (re-key its chunks + persist) — shared by the Move… prompt and
   *  by drag-dropping a note onto a folder. Filename/title are preserved so wikilinks still resolve. */
  async function moveNoteToFolder(docId: string, destFolder: string) {
    if (!pipe || !ready) return;
    const note = vault.find((n) => n.docId === docId);
    if (!note) return;
    const newDocId = moveNotePath(
      docId,
      destFolder || 'notes',
      vault.map((n) => n.docId)
    );
    if (newDocId === docId) return;
    reindexAs(docId, newDocId, note.text);
    await pipe.forgetNote(docId); // persist the path change so the move survives a refresh
    await pipe.putNote({
      docId: newDocId,
      title: note.title,
      body: note.text,
      aliases: note.aliases,
      kind: note.kind,
      sourcePath: note.sourcePath,
      frontmatter: note.frontmatter
    });
    vault = vault.filter((n) => n.docId !== docId).concat([{ ...note, docId: newDocId }]);
    openTabs = openTabs.map((d) => (d === docId ? newDocId : d));
    if (activeDoc === docId) activeDoc = newDocId;
    if (editingDocId === docId) editingDocId = newDocId;
    editMsg = `✓ moved → ${newDocId}`;
  }

  async function moveNoteAction(note: Note) {
    const currentFolder = folderOf(note.docId) || 'notes';
    const next = prompt('Move note — destination folder:', currentFolder);
    if (next === null) return;
    await moveNoteToFolder(note.docId, next);
  }

  // Insert a template into the editor body (FR-NOTE-006), expanding {{date}}/{{title}}/… for now.
  function applyTemplate(id: string) {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    draftBody = expandTemplate(t.body, { now: new Date().toISOString(), title: draftTitle });
    wlState = null;
  }

  // Open today's daily note, creating it from the daily template if it doesn't exist (FR-NOTE-005).
  async function openDailyNote() {
    if (!pipe || !ready) return;
    const nowIso = new Date().toISOString();
    const path = dailyNotePath(nowIso);
    if (vault.some((n) => n.docId === path)) {
      showSource(path);
      return;
    }
    const body = dailyNoteBody(nowIso);
    const file = await createNote({
      title: dailyNoteTitle(nowIso),
      body,
      now: nowIso,
      existingPaths: vault.map((n) => n.docId)
    });
    await pipe.ingest(file.docId, body);
    const dailyTitle = String(file.note.frontmatter.title ?? dailyNoteTitle(nowIso));
    await pipe.putNote({
      docId: file.docId,
      title: dailyTitle,
      body,
      aliases: [],
      kind: 'note',
      frontmatter: file.note.frontmatter
    });
    vault = [
      ...vault,
      {
        docId: file.docId,
        title: dailyTitle,
        aliases: [],
        text: body,
        kind: 'note',
        frontmatter: file.note.frontmatter
      }
    ];
    showSource(file.docId);
  }

  /**
   * Ensure `id` is the loaded chat model (FR-CAP-003/004): a one-time "large download" confirm for
   * the big models, cache-aware status, graceful failure. Returns true if it's loaded (or already
   * current), false if declined/failed. Shared by Ask + preload.
   */
  // Serialize chat-model loads so two never run at once: a second loadModel() on the same WebLLM
  // engine while one is in flight corrupts the cached weights (the "pick a model, then it never loads
  // / Ask returns nothing" bug). A load in flight DEDUPES same-model callers — Ask, build-graph, and
  // the gate all await the one promise — and REFUSES a request for a DIFFERENT model until it settles.
  let modelLoadPromise: Promise<boolean> | null = null;
  let modelLoadingId = '';

  async function ensureModelLoaded(id: string): Promise<boolean> {
    if (!pipe) return false;
    if (loadedModel === id) return true;
    // Already loading? Join the SAME model's in-flight promise; refuse a DIFFERENT model (no concurrent
    // loads — the UI also locks the picker, this is the synchronous backstop for direct callers).
    if (modelLoadPromise) return modelLoadingId === id ? modelLoadPromise : false;
    const conn = pipe; // capture non-null for the nested closure (narrowing doesn't cross it)
    modelLoadingId = id;
    modelLoading = true;
    modelLoadPromise = (async (): Promise<boolean> => {
      const cached = await conn.provider.isCached(id).catch(() => false);
      // The large-model confirm is about a big ONE-TIME DOWNLOAD — so only ask when there's actually a
      // download. A cached model loads instantly with no transfer, so never re-prompt for it (that's why
      // the dialog kept reappearing on every reload: ackedModels resets in memory, and the check ignored
      // the cache). Picking a large model in the gate still counts as the ack for the first download.
      if (!cached && needsOomAck(id) && !ackedModels.has(id)) {
        const m = modelById(id);
        const ok = confirm(
          `${m?.label} is a large model — about ${formatSize(m?.sizeMB ?? 0)} to download once ` +
            `(then cached) and more VRAM to run.\n\nDownload and load it now?`
        );
        if (!ok) {
          modelId = loadedModel || DEFAULT_MODEL_ID;
          status = 'ready';
          return false;
        }
        ackedModels = new Set(ackedModels).add(id);
      }
      modelCached = cached;
      loadPhase = modelCached ? 'loading' : 'downloading';
      loadPct = 0;
      status = `${modelCached ? 'loading cached model' : 'first run — downloading model once'}…`;
      try {
        await conn.provider.loadModel(id, (p) => {
          loadPct = Math.round(p * 100);
          // WebLLM reports 100% download well before the GPU finishes compiling shaders — name that
          // last stage so a few frozen seconds read as "compiling", not "stuck".
          loadPhase = loadPct >= 100 ? 'compiling' : modelCached ? 'loading' : 'downloading';
          status = `${loadPhase} model ${loadPct}%`;
        });
      } catch (err) {
        loadPhase = '';
        const m = modelById(id);
        const msg = err instanceof Error ? err.message : String(err);
        modelId = loadedModel || DEFAULT_MODEL_ID;
        // Classify the failure so the guidance is actionable. Blaming EVERY failure on model size
        // ("pick a smaller model") is wrong for a network hiccup or a browser-STORAGE limit (e.g.
        // "Failed to read large IndexedDB value" in a private window / quota-capped browser), where the
        // right move is "retry" or "free space", not "downgrade the model".
        const isStorage = /indexeddb|quota|storage|read large|disk|no ?space/i.test(msg);
        const isDownload =
          /cache|network|fetch|failed to execute 'add'|http|50\d|429|timeout|load/i.test(msg);
        if (isStorage) {
          status =
            `⚠ ${m?.label ?? 'model'} couldn't be cached — the browser's storage rejected the weights ` +
            `(often a private window or a low storage quota). Use a normal window, free disk space, then retry. [${msg}]`;
        } else if (isDownload) {
          status =
            `⚠ ${m?.label ?? 'model'} download didn't finish — the model host (HuggingFace) may be ` +
            `busy/rate-limiting. Wait a moment and retry; already-downloaded parts resume. [${msg}]`;
        } else {
          status = `⚠ ${m?.label ?? 'model'} couldn't load on this GPU. Try again, or pick a smaller model if it persists. [${msg}]`;
        }
        return false;
      }
      loadPhase = '';
      loadedModel = id;
      modelCached = true;
      cachedModels = new Set(cachedModels).add(id); // it's now on disk → keep the gate's badge current
      return true;
    })();
    try {
      return await modelLoadPromise;
    } finally {
      modelLoadPromise = null;
      modelLoadingId = '';
      modelLoading = false;
    }
  }

  /** Preload the selected model now (so the first Ask is instant). Non-blocking; safe to ignore. */
  async function preloadModel() {
    if (!pipe || !ready || busy || preloading || loadedModel === modelId) return;
    preloading = true;
    try {
      const ok = await ensureModelLoaded(modelId);
      if (ok) status = 'ready';
    } finally {
      preloading = false;
    }
  }

  /** Switch to the recommended model for this GPU and warm it up (load + auto-build the graph). */
  async function useRecommended() {
    const rec = recommendModel(!!gpu?.ok);
    if (!rec) return;
    modelId = rec.id;
    await warmStartup();
  }

  /**
   * After the chat model is ready, auto-extract the vault graph ONCE so the Graph tab shows a
   * visualization without a manual "build graph" click. The incremental hash guard (graphHash)
   * makes repeat startups cheap — only changed notes are re-read; note edits keep the graph fresh
   * on their own via the background index queue. No-op if a graph already exists or no model loaded.
   */
  async function autoBuildGraphIfNeeded() {
    if (!pipe || !ready || graphBusy) return;
    if (!loadedModel) return; // nothing to extract WITH yet
    if (vault.length === 0 || entityIndex.length > 0) return; // empty vault, or graph already built
    await buildVaultGraph();
  }

  /** Startup warm-up: load the chosen model in the background, THEN auto-build the entity graph. */
  async function warmStartup() {
    await preloadModel();
    await autoBuildGraphIfNeeded();
  }

  // --- Startup model gate (FR-MDL-005) -------------------------------------
  // The first-run "pick a model to warm up" overlay. Choosing one persists the choice and starts a
  // BACKGROUND warm-up immediately (download + load + build the graph), so the moment the user opens
  // the Graph tab or Asks, everything is ready.
  function startBackgroundLoad() {
    if (pipe && ready) void warmStartup();
    else wantBackgroundLoad = true; // onMount fires it once the pipeline finishes initializing
  }
  function closeModelGate() {
    modelGate = false;
    uiPrefs.setOnboarded(true);
  }
  function chooseModel(id: string) {
    if (modelLoading) return; // a load is already in flight — can't switch until it finishes
    modelId = id;
    uiPrefs.setModelPref(id);
    // Picking a large model in the gate IS the OOM acknowledgment — don't re-confirm at load time.
    if (needsOomAck(id)) ackedModels = new Set(ackedModels).add(id);
    closeModelGate();
    startBackgroundLoad();
  }
  function chooseAutoModel() {
    const rec = recommendModel(!!gpu?.ok);
    if (rec) chooseModel(rec.id);
    else closeModelGate(); // no WebGPU → no chat model to warm; semantic search still works
  }
  function reopenModelGate() {
    if (modelLoading) return; // don't let the picker open mid-load — you'd only be able to wait anyway
    modelGate = true;
    void refreshModelCacheStatus(); // so the gate shows which models are already on disk
  }

  /** Probe which catalog models are already downloaded to this browser → drives the "on disk" badge
   *  and the delete button in the gate (FR-MDL). Best-effort; an unknown status just shows the size. */
  async function refreshModelCacheStatus() {
    if (!pipe) return;
    const cached = new Set<string>();
    await Promise.all(
      MODELS.map(async (m) => {
        if (await pipe!.provider.isCached(m.id).catch(() => false)) cached.add(m.id);
      })
    );
    cachedModels = cached;
  }

  /** Delete a model's weights from this browser to free disk (FR-MDL). Re-downloadable anytime. */
  async function deleteModelFromCache(id: string) {
    if (!pipe || deletingModel) return;
    const m = modelById(id);
    if (
      !confirm(
        `Remove ${m?.label ?? id} from this browser? Frees ~${formatSize(m?.sizeMB ?? 0)} of disk; ` +
          `you can re-download it anytime.`
      )
    )
      return;
    deletingModel = id;
    try {
      await pipe.provider.deleteModel(id);
      const next = new Set(cachedModels);
      next.delete(id);
      cachedModels = next;
      if (loadedModel === id) loadedModel = ''; // it's gone from disk; the in-memory copy (if any) stays until reload
      status = `🗑 removed ${m?.label ?? id} from this browser`;
    } catch (e) {
      status = `could not remove ${m?.label ?? id}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      deletingModel = '';
    }
  }

  // --- File-tree mutations: context menu + folder CRUD + drag-drop (FR-NAV-002) ----
  function persistFolders() {
    emptyFolders = [...new Set(emptyFolders)].filter(Boolean).sort();
    uiPrefs.setEmptyFolders(emptyFolders);
  }
  function openCtxMenu(e: MouseEvent, kind: 'file' | 'folder' | 'root', path: string) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = { x: e.clientX, y: e.clientY, kind, path };
  }
  const closeCtxMenu = () => (ctxMenu = null);

  /** New note targeted at `folder` — opens the editor with that folder pre-filled (FR-NOTE-007). */
  function newNoteIn(folder: string) {
    closeCtxMenu();
    startNewNote();
    draftFolder = folder || 'notes';
  }

  /** Create a new EMPTY sub-folder under `parent`, tracked in ui-prefs so it persists while empty. */
  function newFolderIn(parent: string) {
    closeCtxMenu();
    const name = prompt('New folder name:', 'untitled');
    if (name === null || !name.trim()) return;
    const path = deriveChildFolder(
      parent,
      name,
      allFolders(
        vault.map((n) => n.docId),
        emptyFolders
      )
    );
    emptyFolders = [...emptyFolders, path];
    persistFolders();
    if (parent && collapsed.has(parent)) toggleFolder(parent); // reveal the new child
  }

  /** Append a numeric suffix to a colliding path (`a/b.md` → `a/b-2.md`, `a/b-2.md` → `a/b-3.md`). */
  function bumpPath(path: string): string {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const file = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = file.lastIndexOf('.');
    const base = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    const m = base.match(/^(.*)-(\d+)$/);
    const next = m ? `${m[1]}-${Number(m[2]) + 1}` : `${base}-2`;
    return `${dir ? dir + '/' : ''}${next}${ext}`;
  }

  /** Re-key every note under `oldFolder` to `newFolder` (a prefix swap) + fix empty-folder bookkeeping. */
  async function moveFolderContents(oldFolder: string, newFolder: string) {
    if (!pipe) return;
    const taken = new Set(vault.map((n) => n.docId));
    const moves: { from: string; to: string }[] = [];
    for (const note of vault) {
      if (!isUnder(note.docId, oldFolder)) continue;
      let dest = repathUnderFolder(note.docId, oldFolder, newFolder);
      taken.delete(note.docId);
      while (taken.has(dest)) dest = bumpPath(dest);
      taken.add(dest);
      if (dest !== note.docId) moves.push({ from: note.docId, to: dest });
    }
    for (const m of moves) {
      const note = vault.find((n) => n.docId === m.from);
      if (!note) continue;
      reindexAs(m.from, m.to, note.text);
      await pipe.forgetNote(m.from);
      await pipe.putNote({
        docId: m.to,
        title: note.title,
        body: note.text,
        aliases: note.aliases,
        kind: note.kind,
        sourcePath: note.sourcePath,
        frontmatter: note.frontmatter
      });
    }
    const moveMap = new Map(moves.map((m) => [m.from, m.to]));
    vault = vault.map((n) => (moveMap.has(n.docId) ? { ...n, docId: moveMap.get(n.docId)! } : n));
    for (const m of moves) {
      openTabs = openTabs.map((d) => (d === m.from ? m.to : d));
      if (activeDoc === m.from) activeDoc = m.to;
      if (editingDocId === m.from) editingDocId = m.to;
    }
    // Carry the folder's own (possibly empty) bookkeeping across, and ensure the destination exists.
    emptyFolders = emptyFolders.map((f) =>
      isUnder(f, oldFolder) ? repathUnderFolder(f, oldFolder, newFolder) : f
    );
    if (!emptyFolders.includes(newFolder) && moves.length === 0)
      emptyFolders = [...emptyFolders, newFolder];
    persistFolders();
  }

  async function renameFolder(folder: string) {
    closeCtxMenu();
    if (!pipe || !ready) return;
    const cur = folder.slice(folder.lastIndexOf('/') + 1);
    const next = prompt(`Rename folder "${folder}":`, cur);
    if (next === null || !next.trim()) return;
    const dest = renamedFolderPath(folder, next);
    if (dest === folder) return;
    await moveFolderContents(folder, dest);
    editMsg = `✓ renamed folder → ${dest}`;
  }

  async function deleteFolder(folder: string) {
    closeCtxMenu();
    if (!pipe || !ready) return;
    const inside = notesUnderFolder(
      vault.map((n) => n.docId),
      folder
    );
    if (
      inside.length &&
      !confirm(
        `Delete folder "${folder}" and its ${inside.length} note(s)?\nThis removes them from the vault and the search index.`
      )
    )
      return;
    for (const docId of inside) await removeNoteCompletely(docId);
    emptyFolders = emptyFolders.filter((f) => f !== folder && !f.startsWith(folder + '/'));
    persistFolders();
    vault = vault.filter((n) => !inside.includes(n.docId));
    for (const docId of inside) closeTab(docId); // drop tabs for every deleted note
    void refreshEntities();
    editMsg = `🗑 deleted folder ${folder}`;
  }

  // Drag a note from the tree onto a folder to move it (HTML5 drag-and-drop).
  function onTreeDragStart(e: DragEvent, docId: string) {
    dragDocId = docId;
    e.dataTransfer?.setData('text/plain', docId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function onTreeDragOverFolder(e: DragEvent, folder: string) {
    if (!dragDocId) return; // only react to an internal note drag, not a file-ingestion drop
    e.preventDefault();
    e.stopPropagation();
    dropFolder = folder;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function onTreeDropFolder(e: DragEvent, folder: string) {
    if (!dragDocId) return;
    e.preventDefault();
    e.stopPropagation();
    const docId = dragDocId;
    dragDocId = null;
    dropFolder = null;
    if (folderOf(docId) !== folder) void moveNoteToFolder(docId, folder);
  }
  function onTreeDragEnd() {
    dragDocId = null;
    dropFolder = null;
  }
  function switchView(v: 'files' | 'graph') {
    rightView = v;
    uiPrefs.setView(v);
    closeCtxMenu();
    // Entering the Graph tab with a built graph but nothing selected → open the top entity so a
    // node-link visualization shows immediately, instead of an empty "pick an entity" canvas.
    if (v === 'graph' && !selectedEntity && entityIndex.length) void openEntity(entityIndex[0]);
  }

  async function ask() {
    if (!pipe || busy || !query.trim()) return;
    const q = query.trim();
    // Roll the just-finished turn into the transcript so the model keeps the thread on this
    // follow-up (FR-CHAT-006), then free the composer so the follow-up can be typed.
    if (answer.trim() && askedQuery.trim()) history = [...history, { query: askedQuery, answer }];
    askedQuery = q;
    query = '';
    busy = true;
    answer = '';
    cites = [];
    references = [];
    graph = null;
    // Keep the note you're reading open while you ask — only a NEW citation (jumpTo) changes the
    // active tab. We just drop any stale Magic-Jump highlight so the note shows in full.
    activeSpan = null;
    try {
      status = 'embedding query…';
      const qv = await pipe.embed(q);
      status = scope ? `retrieving (scoped: ${scopeLabel(scope)})…` : 'retrieving…';
      graphInfo = '';
      // Scoped retrieval (FR-RET-004): over-fetch then keep only in-scope hits so a question
      // about one client never pulls another client's notes (no cross-client bleed).
      let relevant: SearchHit[] = [];
      const expandedIds = new Set<string>();
      let expandedForLabels: ExpandedHit[] = [];
      // Exact-term lexical recall channel (FR-RET-003, the recall half): retrieved INDEPENDENTLY of
      // the HNSW ranking, so a chunk that literally names the query's subject (an ID, a person, a
      // proper noun the embedding fragments) reaches the context even when cosine ranked it outside
      // top-K — hybridRerank alone can't recover those (it only re-orders what vector returned).
      // Best-effort: a lexical failure must never take down the ask.
      const qTerms = queryTerms(q);
      const lexical = qTerms.length
        ? filterByScope(await pipe.lexical(qv, qTerms, 8).catch(() => [] as SearchHit[]), scopeIds)
        : [];
      if (graphRagOn) {
        // GraphRAG (Phase 3): vector seeds + graph-connected siblings. The relevance floor still
        // gates the SEEDS (irrelevant notes must never anchor the answer — same precision as plain
        // RAG, and the no-results guard fires when nothing clears it). Graph-expanded siblings are
        // then KEPT even below the floor — they earn inclusion structurally (shared entities), which
        // is exactly the context plain cosine misses (the quality lever). Seeds keep their cosine
        // score for display; we don't surface the internal RRF fusion score to the user.
        const rag = await pipe.graphRag(qv, {
          seedK: scope ? 24 : 12,
          expandK: 10,
          k: scope ? 24 : 12
        });
        expandedForLabels = rag.expanded;
        const seedRelevant = relevantHits(filterByScope(rag.seeds, scopeIds));
        if (seedRelevant.length > 0) {
          const expandedScoped = filterByScope(rag.expanded, scopeIds);
          relevant = withLexicalChannel(
            selectGraphRagContext(seedRelevant, expandedScoped),
            lexical
          );
          const seedIds = new Set(seedRelevant.map((h) => h.chunkId));
          // Label only TRUE graph siblings as "+N graph-connected" — lexical top-ups are not.
          const graphIds = new Set(rag.expanded.map((h) => h.chunkId));
          for (const h of relevant)
            if (!seedIds.has(h.chunkId) && graphIds.has(h.chunkId)) expandedIds.add(h.chunkId);
        } else {
          // No vector seed cleared the relevance floor — the LEXICAL RESCUE: if a chunk literally
          // names the query's exact term, surface it rather than a silent no-results (embeddings
          // are weakest exactly where literal match is total, e.g. IDs / rare proper nouns).
          relevant = withLexicalChannel([], lexical);
        }
      } else {
        // Plain RAG: over-fetch → precision floor (ADR-018) drops the low-score tail so References,
        // Micro-Map, and the grounded context carry only genuinely relevant notes (FR-CHAT-002).
        // The lexical channel then tops up exact-term matches the vector pass missed (or rescues
        // an empty floor result — same rule as the GraphRAG branch).
        relevant = withLexicalChannel(
          relevantHits(filterByScope(await pipe.search(qv, scope ? 24 : 12), scopeIds)),
          lexical
        );
      }
      // Hybrid precision (FR-RET-003): re-rank the relevance-floor survivors by fusing their vector
      // rank with an exact-term lexical rank, so a note that's merely TOPICALLY similar (e.g. another
      // deal's invoice — dense with "budget/payment") but never NAMES the query's subject is demoted
      // beneath the notes that actually mention it, and falls past the per-doc cap instead of
      // polluting Sources + wasting a context slot. Pure cosine can't tell "Project Harmony's budget"
      // from an unrelated invoice; proper-noun overlap can. No-op when the query shares no lexical
      // term with any hit (recall preserved), and cosine scores are untouched (only the order shifts).
      const reranked = hybridRerank(relevant, qTerms);
      // …then EXCLUDE cross-subject noise outright (not just demote it): anchor on the KNOWLEDGE GRAPH
      // to the query's SUBJECT CLUSTER (notes mentioning a named entity + their co-occurring-entity
      // siblings, 2 hops). Another deal's invoice that merely shares a topic word ("budget") — or got
      // graph-expanded through a spurious shared node — names nothing in the cluster and is dropped
      // before the model ever sees it (precision must not depend on the LLM ignoring noise). A strong
      // standalone semantic match still survives; and it's a NO-OP when the query names no known
      // entity (or the graph isn't built yet), so recall is preserved.
      const anchorDocs = entityAnchorDocs(q, entityIndex);
      const denoised = restrictToEntities(reranked, anchorDocs);
      // Favor BREADTH across distinct documents (FR-CHAT-002): one best chunk per doc. GraphRAG gets
      // more room (8 docs) so the graph-connected siblings actually surface alongside the seeds.
      hits = dedupeByDoc(denoised, graphRagOn ? 8 : 5);
      graphExpandedIds = expandedIds;
      graphShared = new Map(
        expandedForLabels.map((h) => [
          h.chunkId,
          { sharedCount: h.sharedCount, sharedEntities: h.sharedEntities }
        ])
      );
      const graphAdded = hits.filter((h) => expandedIds.has(h.chunkId)).length;
      graphInfo = graphAdded > 0 ? `+${graphAdded} graph-connected` : '';
      references = referencesFromHits(hits);
      // Micro-Map (FR-GRAPH-001) + persist the retrieval sub-graph edges (FR-GRAPH-002).
      graph = buildMicroGraph(q, hits, { graphInfo: graphShared });
      try {
        await pipe.relate('current', hits);
      } catch {
        /* edge persistence is best-effort; the visual graph is built from hits */
      }

      if (loadedModel !== modelId) {
        const ok = await ensureModelLoaded(modelId);
        if (!ok) {
          busy = false;
          return;
        }
      }

      // REASON reads the FULL note(s), not just the best-matching chunk — so a question can pull
      // from ANY part of a note (the whole knowledge-base entry IS the context), not only the line
      // that matched (fixes "Ask can't see past the first line" on long notes). GROUNDED stays
      // chunk-precise for verifiable citations. Display (References, Micro-Map, Magic Jump) keeps
      // using the deduped chunk `hits`, so only what's fed to the model changes.
      const genContext: SearchHit[] =
        answerMode === 'reason'
          ? hits.map((h) => {
              const note = vault.find((n) => n.docId === h.docId);
              return note ? { ...h, text: note.text, charStart: 0, charEnd: note.text.length } : h;
            })
          : hits;

      status = 'generating…';
      const res = await pipe.provider.generate(
        // Reason mode elaborates over full notes, so give it more room than the terse grounded answer.
        {
          requestId: 'q',
          query: q,
          context: genContext,
          history,
          modelId,
          maxTokens: answerMode === 'reason' ? 512 : 256,
          answerMode
        },
        (t) => {
          answer += t;
        },
        new AbortController().signal
      );
      ttft = res.ttftMs;
      tps = Math.round(res.tokensPerSec);
      // Replace the streamed text with the provider's cleaned final answer (echo stripped).
      answer = res.text;
      const order = hits.map((h) => h.chunkId);
      cites = res.citations.map((c) => {
        const docId = order.find((id) => id === c.chunkId) ? c.chunkId.split('#')[0] : c.chunkId;
        const n = order.indexOf(c.chunkId) + 1;
        return { n, chunkId: c.chunkId, docId };
      });
      status = 'done';
      await tick();
    } catch (e) {
      status = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  /** Start a fresh Ask conversation: drop the transcript + the current answer and its panels. */
  function newConversation() {
    history = [];
    askedQuery = '';
    answer = '';
    cites = [];
    references = [];
    hits = [];
    graph = null;
    activeSpan = null;
    status = '';
  }

  // --- Center tabs (multi-tab read view) ---------------------------------------
  /** Open a note in the center tab strip (adds a tab if it isn't already open) and make it active. */
  function openInTab(docId: string) {
    if (!openTabs.includes(docId)) openTabs = [...openTabs, docId];
    activeDoc = docId;
  }
  /** Close a tab. If it was active, fall back to the tab that slid into its slot, else the one before. */
  function closeTab(docId: string) {
    const i = openTabs.indexOf(docId);
    if (i === -1) return;
    const next = openTabs.filter((d) => d !== docId);
    openTabs = next;
    if (activeDoc === docId) {
      activeDoc = next[i] ?? next[i - 1] ?? null;
      activeSpan = null;
    }
  }
  /** Activate an already-open tab without disturbing the others. */
  function selectTab(docId: string) {
    activeDoc = docId;
    activeSpan = null;
  }
  // Reorder tabs by dragging one over another (native HTML5 drag-and-drop).
  function onTabDragStart(e: DragEvent, docId: string) {
    tabDrag = docId;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function onTabDragOver(e: DragEvent, overId: string) {
    if (!tabDrag || tabDrag === overId) return;
    e.preventDefault();
    const from = openTabs.indexOf(tabDrag);
    const to = openTabs.indexOf(overId);
    if (from === -1 || to === -1) return;
    const next = [...openTabs];
    next.splice(from, 1);
    next.splice(to, 0, tabDrag);
    openTabs = next;
  }
  function onTabDragEnd() {
    tabDrag = null;
  }

  // Magic Jump (FR-CHAT-003): open the cited chunk's document and highlight its exact span.
  function jumpTo(chunkId: string) {
    const target = resolveCitationTarget(chunkId, hits);
    if (!target) return;
    openInTab(target.docId); // the cited note opens in (or focuses) its tab
    activeSpan = { charStart: target.charStart, charEnd: target.charEnd };
    rightView = 'files'; // Magic Jump lands on the cited note in the doc panel
    mode = 'ask'; // unified center: leave the editor so the cited note renders (read)
  }

  function showSource(docId: string) {
    openInTab(docId);
    activeSpan = null;
    rightView = 'files'; // ensure the note is visible (beside the tree), not hidden behind Graph view
    mode = 'ask'; // unified center: leave the editor so the opened note renders (read), not the draft
    closeCtxMenu();
  }

  function exportVault() {
    const zip = exportVaultZip({
      notes: vault.map((n) => ({
        path: n.docId,
        frontmatter: n.frontmatter ?? { title: n.title },
        body: n.text
      })),
      originals
    });
    const url = URL.createObjectURL(new Blob([new Uint8Array(zip)], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nebula-vault.zip';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Weaver popover (FR-LINK-002).
  function showPreview(e: MouseEvent, docId: string) {
    const ref = vault.find((r) => r.docId === docId);
    preview = {
      text: notePreview({ summary: ref?.text }),
      x: e.clientX + 12,
      y: e.clientY + 12
    };
  }
  const hidePreview = () => (preview = null);

  const activeNote = $derived(activeDoc ? vault.find((n) => n.docId === activeDoc) : undefined);
  const activeBacklinks = $derived(activeDoc ? (backlinks.get(activeDoc) ?? []) : []);
  // Entities extracted FROM the open note — so opening a note answers "what entities does this note
  // have?" directly, including a freshly-created note's entities that rank too low for the top-6
  // sidebar pane. Reactive on entityIndex: chips appear on their own once background extraction lands.
  const activeNoteEntities = $derived.by(() => {
    const d = activeDoc;
    return d ? entityIndex.filter((e) => e.docIds.includes(d)) : [];
  });
  const activeUnlinked = $derived(
    activeNote
      ? findUnlinkedMentions(
          { docId: activeNote.docId, title: activeNote.title, aliases: activeNote.aliases },
          vaultBodies
        )
      : []
  );

  // Markdown preview wiring (FR-UI-002 · §5.10): resolve [[ ]] + delegate wikilink clicks.
  function resolveNoteLink(target: string) {
    return resolveTarget(target, titleIndex);
  }
  function onRenderedClick(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    const a = el?.closest?.('a.wikilink') as HTMLElement | null;
    if (a?.dataset.doc) {
      e.preventDefault();
      showSource(a.dataset.doc);
      return;
    }
    // Magic Jump from an inline [#n] citation in a rendered answer → its source note.
    const cite = el?.closest?.('button.cite') as HTMLElement | null;
    if (cite?.dataset.cite) {
      e.preventDefault();
      const n = Number(cite.dataset.cite);
      const ref = references.find((r) => r.n === n);
      if (ref) jumpTo(ref.chunkId);
    }
  }

  // --- Wikilink autocomplete (FR-LINK-003) ---------------------------------
  function onBodyInput() {
    if (!bodyEl) return;
    wlState = autocompleteWikilink(
      draftBody,
      bodyEl.selectionStart ?? draftBody.length,
      titleIndex
    );
  }
  async function pickWikilink(title: string) {
    if (!wlState) return;
    const res = applyWikilinkChoice(draftBody, wlState, title);
    draftBody = res.text;
    wlState = null;
    await tick();
    if (bodyEl) {
      bodyEl.focus();
      bodyEl.setSelectionRange(res.caret, res.caret);
    }
  }

  // --- Quick switcher (FR-NAV-001) -----------------------------------------
  const switcherResults = $derived<SwitchResult[]>(
    switcherOpen
      ? quickSwitch(
          vault.map((n) => ({ docId: n.docId, title: n.title })),
          switcherQuery,
          10
        )
      : []
  );
  async function openSwitcher() {
    switcherQuery = '';
    switcherOpen = true;
    await tick();
    document.getElementById('switcher-input')?.focus();
  }
  function chooseSwitch(docId: string) {
    switcherOpen = false;
    showSource(docId);
  }

  // --- File tree + tag pane (FR-NAV-002/003) -------------------------------
  const fileTree = $derived<TreeNode[]>(
    buildFileTree(
      vault.map((n) => n.docId),
      emptyFolders
    )
  );
  // Graph view (Phase 4 visual): the selected entity's neighbourhood laid out as a node-link diagram,
  // and the entity list filtered by the search box.
  const entityLayout = $derived<GraphLayout | null>(
    entityGraph ? applyOverrides(layoutEntityGraph(entityGraph), nodeOverrides) : null
  );
  const filteredEntities = $derived(
    entityQuery.trim()
      ? entityIndex.filter((e) => e.name.toLowerCase().includes(entityQuery.trim().toLowerCase()))
      : entityIndex
  );
  const taggedVault = $derived(
    vault.map((n) => ({
      docId: n.docId,
      tags: [...coerceTags(n.frontmatter?.tags), ...extractInlineTags(n.text)]
    }))
  );
  const tagIndex = $derived(buildTagIndex(taggedVault));
  const taggedDocIds = $derived(activeTag ? new Set(notesForTag(taggedVault, activeTag)) : null);
  const filteredNotes = $derived(
    taggedDocIds ? vault.filter((n) => taggedDocIds.has(n.docId)) : []
  );
  function toggleFolder(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }
  function toggleTag(tag: string) {
    activeTag = activeTag === tag ? null : tag;
  }

  // --- Retrieval scope (FR-RET-004) ----------------------------------------
  const scopeNotes = $derived(taggedVault.map((n) => ({ docId: n.docId, tags: n.tags })));
  const scopeIds = $derived(scopeDocIds(scopeNotes, scope));
  // Distinct folder prefixes + tags, as selectable scopes.
  const folderScopes = $derived.by(() => {
    const set = new Set<string>();
    for (const n of vault) {
      const parts = n.docId.split('/');
      parts.pop();
      let p = '';
      for (const seg of parts) {
        p = p ? `${p}/${seg}` : seg;
        set.add(`${p}/`);
      }
    }
    return [...set].sort();
  });
  function setScope(value: string) {
    if (!value) scope = null;
    else if (value.startsWith('folder:')) scope = { kind: 'folder', value: value.slice(7) };
    else scope = { kind: 'tag', value: value.slice(4) };
  }

  // --- Context Compiler (FR-CTX-*) -----------------------------------------
  const hashOfDoc = (docId: string): string =>
    String(vault.find((n) => n.docId === docId)?.frontmatter?.nebula_hash ?? '');
  // Combined redactions (CE3): manual comma list + chosen PII types + the picked entity (and optionally
  // its connected people/projects), all labelled for the preview/audit.
  const compileRedactions = $derived<Redaction[]>([
    ...parseRedactions(compileRedact).map((r) => ({ pattern: r.pattern, label: 'manual' })),
    ...piiRedactions([...compilePii]),
    ...compileEntityRedactions
  ]);
  // CE3 — resolve the picked entity to redaction patterns: its own aliases, plus (optionally) the
  // aliases of its 1-hop connected entities from the graph. Async (a neighbour lookup) — uses the
  // pure `redactionsForEntity` core; the alias data comes from the persisted entity records.
  async function applyEntityRedaction() {
    if (!redactEntityId || !pipe) {
      compileEntityRedactions = [];
      return;
    }
    const all = (await pipe.entityData()).entities;
    const ent = all.find((e) => e.id === redactEntityId);
    if (!ent) {
      compileEntityRedactions = [];
      return;
    }
    let connected: { name: string; aliases?: string[] }[] = [];
    if (redactConnected) {
      const neighbors = await pipe.entityNeighbors(redactEntityId, 1);
      const byId = new Map(all.map((e) => [e.id, e]));
      connected = neighbors
        .map((n) => byId.get(n.id))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({ name: e.name, aliases: e.aliases }));
    }
    compileEntityRedactions = redactionsForEntity(
      { name: ent.name, aliases: ent.aliases },
      connected
    );
  }
  const compileResult = $derived(
    compileOpen && compileSources.length
      ? compile({
          sources: compileSources,
          targetModel: compileModel,
          redactions: toCompilerRedactions(compileRedactions),
          task: compileTask.trim() ? { question: compileTask.trim() } : undefined // CE2
        })
      : null
  );
  // CE3 — exactly what the redactions will remove, computed over the source text (same regex as compile()).
  const redactPreview = $derived(
    compileOpen && compileSources.length && compileRedactions.length
      ? redactionPreview(
          compileSources.flatMap((s) => s.chunks.map((c) => c.text)),
          compileRedactions
        ).filter((p) => p.count > 0)
      : []
  );
  // CE4 — resolve a pasted frontier answer's [path#seq] / [#n] citations back to vault chunkIds.
  const pasteResolved = $derived(
    pasteBack.trim()
      ? resolvePastedAnswer(
          pasteBack,
          vault.map((n) => n.docId),
          compileSources.flatMap((s) => s.chunks.map((c) => `${s.docId}#${c.seq}`))
        )
      : null
  );
  function openCompileFromScope() {
    const inScope = scopeIds ? vault.filter((n) => scopeIds.has(n.docId)) : vault;
    compileSources = sourcesFromNotes(
      inScope.map((n) => ({ docId: n.docId, text: n.text, hash: hashOfDoc(n.docId) }))
    );
    compileFrom = 'scope';
    compileOpen = true;
  }
  function openCompileFromHits() {
    if (!hits.length) return;
    // CE1 — budget the retrieved candidates (semantic seeds + graph-connected siblings) to compileBudget.
    const sel = selectContext(
      hits.map((h) => ({
        chunkId: h.chunkId,
        docId: h.docId,
        seq: Number(h.chunkId.split('#')[1] ?? 0),
        text: h.text,
        page: h.page,
        score: h.score,
        graphConnected: graphExpandedIds.has(h.chunkId),
        sharedCount: graphShared.get(h.chunkId)?.sharedCount
      })),
      { tokenBudget: compileBudget, countTokens: (t) => countTokensFor(t, compileModel) }
    );
    compileSources = sourcesFromHits(
      sel.selected.map((h) => ({ chunkId: h.chunkId, docId: h.docId, text: h.text, page: h.page })),
      hashOfDoc
    );
    compileFrom = 'answer';
    compileOpen = true;
  }
  async function copyCompiled() {
    if (!compileResult) return;
    await navigator.clipboard.writeText(compileResult.xml);
    // CE3 — on confirmed export, append a content-free audit record (hashes + counts only).
    exportAudit = [
      ...exportAudit,
      buildAuditRecord({
        sources: compileResult.manifest.sources,
        tokenCount: compileResult.manifest.tokenCount,
        targetModel: compileModel,
        redactionSummary: redactionSummary(redactPreview),
        exportedAt: new Date().toISOString()
      })
    ];
  }
  function downloadCompiled() {
    if (!compileResult) return;
    const url = URL.createObjectURL(new Blob([compileResult.xml], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nebula-context.xml';
    a.click();
    URL.revokeObjectURL(url);
  }
  function onGlobalKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'o')) {
      e.preventDefault();
      void openSwitcher();
    } else if (e.key === 'Escape') {
      switcherOpen = false;
      wlState = null;
      ctxMenu = null;
    }
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

{#snippet ic(name: string, sz = 16)}
  <svg
    width={sz}
    height={sz}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if name === 'search'}<circle cx="7" cy="7" r="5" /><line x1="11" y1="11" x2="15" y2="15" />
    {:else if name === 'chevdown'}<polyline points="4,6 8,10 12,6" />
    {:else if name === 'chevron'}<polyline points="6,4 10,8 6,12" />
    {:else if name === 'file'}<path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" />
    {:else if name === 'folder'}<path d="M2.5 4.5h3.5l1.2 1.5h6.3v7H2.5z" />
    {:else if name === 'link'}<path
        d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1"
      /><path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" />
    {:else if name === 'dots'}<g fill="currentColor" stroke="none"
        ><circle cx="4" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle
          cx="12"
          cy="8"
          r="1.3"
        /></g
      >
    {:else if name === 'download'}<path d="M8 3v7" /><polyline points="5,7.5 8,10.5 11,7.5" /><path
        d="M3.5 12.5h9"
      />
    {:else if name === 'arrow'}<line x1="3.5" y1="8" x2="12" y2="8" /><polyline
        points="8.5,4.5 12,8 8.5,11.5"
      />
    {:else if name === 'edit'}<path d="M3 13l1-3 6.5-6.5a1.5 1.5 0 0 1 2 2L6 12l-3 1z" />
    {:else if name === 'check'}<polyline points="3,8.5 6.5,12 13,4.5" />
    {:else if name === 'box'}<path d="M8 2l5 2.8v6.4L8 14l-5-2.8V4.8z" /><path
        d="M3 4.8L8 7.6l5-2.8"
      /><line x1="8" y1="7.6" x2="8" y2="14" />
    {:else if name === 'graph'}<circle cx="8" cy="4" r="1.8" /><circle
        cx="4"
        cy="12"
        r="1.8"
      /><circle cx="12" cy="12" r="1.8" /><line x1="8" y1="5.8" x2="4.6" y2="10.4" /><line
        x1="8"
        y1="5.8"
        x2="11.4"
        y2="10.4"
      />
    {:else if name === 'sun'}<circle cx="8" cy="8" r="3" /><path
        d="M8 1.5v1.5M8 13v1.5M2.4 2.4l1 1M12.6 12.6l1 1M1.5 8H3M13 8h1.5M2.4 13.6l1-1M12.6 3.4l1-1"
      />
    {:else if name === 'moon'}<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
    {:else if name === 'github'}<path
        fill="currentColor"
        stroke="none"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    {:else if name === 'close'}<line x1="4" y1="4" x2="12" y2="12" /><line
        x1="12"
        y1="4"
        x2="4"
        y2="12"
      />
    {:else if name === 'copy'}<rect x="5" y="5" width="8" height="8" rx="1.6" /><path
        d="M3 11V4a1 1 0 0 1 1-1h7"
      />
    {:else if name === 'eyeoff'}<path
        d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4a6.7 6.7 0 0 1-2.2-.4"
      /><line x1="3" y1="3" x2="13" y2="13" />
    {:else if name === 'plus'}<line x1="8" y1="3.5" x2="8" y2="12.5" /><line
        x1="3.5"
        y1="8"
        x2="12.5"
        y2="8"
      />
    {:else if name === 'send'}<path d="M3 8h8" /><polyline points="7.5,4.5 11,8 7.5,11.5" />
    {:else if name === 'bolt'}<path d="M9 2L4 9h3l-1 5 5-7H8z" />
    {:else if name === 'menu'}<line x1="2.5" y1="4.5" x2="13.5" y2="4.5" /><line
        x1="2.5"
        y1="8"
        x2="13.5"
        y2="8"
      /><line x1="2.5" y1="11.5" x2="13.5" y2="11.5" />
    {/if}
  </svg>
{/snippet}

{#snippet tree(nodes: TreeNode[])}
  {#each nodes as node (node.path)}
    {#if node.kind === 'folder'}
      <button
        class="tree-folder nb-hov"
        class:drop={dropFolder === node.path}
        onclick={() => toggleFolder(node.path)}
        oncontextmenu={(e) => openCtxMenu(e, 'folder', node.path)}
        ondragover={(e) => onTreeDragOverFolder(e, node.path)}
        ondragleave={() => {
          if (dropFolder === node.path) dropFolder = null;
        }}
        ondrop={(e) => onTreeDropFolder(e, node.path)}
      >
        <span class="caret" class:open={!collapsed.has(node.path)}>{@render ic('chevron', 13)}</span
        >
        {node.name}<span class="tree-count"
          >{node.children.filter((c) => c.kind !== 'folder').length}</span
        >
      </button>
      {#if !collapsed.has(node.path)}
        <div class="tree-children">{@render tree(node.children)}</div>
      {/if}
    {:else}
      {@const on = activeDoc === node.docId && rightView === 'files'}
      <button
        class="tree-file nb-hov"
        class:active={on}
        class:dragging={dragDocId === node.docId}
        draggable="true"
        onclick={() => node.docId && showSource(node.docId)}
        oncontextmenu={(e) => openCtxMenu(e, 'file', node.docId ?? '')}
        ondragstart={(e) => node.docId && onTreeDragStart(e, node.docId)}
        ondragend={onTreeDragEnd}
      >
        <span class="tf-ic">{@render ic('file', 13)}</span>
        <span class="tf-nm">{node.name}</span>
      </button>
    {/if}
  {/each}
{/snippet}

<main
  class="nb-app shell"
  class:drop={dropActive}
  ondragover={(e) => {
    e.preventDefault();
    dropActive = true;
  }}
  ondragleave={() => (dropActive = false)}
  ondrop={onDrop}
>
  <!-- ───────── TOPBAR ───────── -->
  <header class="topbar">
    <div class="tb-left">
      <svg class="brand-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="7" fill="none" stroke="var(--accent)" stroke-width="2" />
        <circle cx="9" cy="9" r="2.6" fill="var(--accent)" />
      </svg>
      <span class="brand-name">Nebula</span>
    </div>
    <div class="tb-center">
      <button class="omnibox nb-hov nb-focusable" onclick={openSwitcher} title="Search or ask (⌘K)">
        <span class="omni-ic">{@render ic('search', 15)}</span>
        <span class="omni-txt">Search or ask your vault…</span>
        <kbd>⌘K</kbd>
      </button>
    </div>
    <div class="tb-right">
      <button
        class="pill model-pill nb-hov nb-press"
        class:loading={modelLoading}
        onclick={reopenModelGate}
        disabled={modelLoading}
        title={modelLoading
          ? 'Model is loading — please wait until it finishes before switching'
          : 'On-device chat model'}
      >
        <span class="dot {modelLoading ? 'busy' : 'ok'}"></span>{modelById(modelId)?.label ??
          'Model'}{@render ic('chevdown', 12)}
      </button>
      {#if bgPending > 0}
        <span class="pill busy-pill"
          ><span class="spinner"></span>indexing{bgProgress ? ` ${bgProgress}` : ''}</span
        >
      {:else if graphBuilding > 0}
        <span
          class="pill busy-pill"
          title="Chunks are indexed and searchable; the entity graph is still extracting (background)"
          ><span class="spinner"></span>building graph…</span
        >
      {:else if indexDone}
        <span class="pill ok-pill" title="Background indexing finished">
          {@render ic('check', 13)}
          {indexDone}</span
        >
      {:else if ready}
        <span class="pill ok-pill">{@render ic('check', 13)} indexed</span>
      {/if}
      {#if embedBackend && embedBackend.device}
        <span
          class="pill {embedBackend.device === 'webgpu' ? 'ok-pill' : 'warn-pill'}"
          title={embedBackend.device === 'webgpu'
            ? `Embedding runs on the GPU (WebGPU) — ${embedBackend.chunksPerSec} chunks/sec`
            : `Embedding fell back to CPU (~${embedBackend.chunksPerSec} chunks/sec) — much slower than GPU. Check that WebGPU is enabled in your browser (e.g. chrome://flags, hardware acceleration).`}
        >
          {#if embedBackend.device === 'webgpu'}{@render ic('bolt', 12)}GPU{:else}CPU · slow{/if}
        </span>
      {/if}
      <a
        class="icon-btn nb-hov nb-press"
        href="https://github.com/thienzz/Nebula"
        target="_blank"
        rel="noopener noreferrer"
        title="View source on GitHub"
        aria-label="View source on GitHub">{@render ic('github', 16)}</a
      >
      <button class="icon-btn nb-hov nb-press" onclick={exportVault} title="Export vault"
        >{@render ic('download', 16)}</button
      >
      <button class="icon-btn nb-hov nb-press" onclick={toggleTheme} title="Toggle theme"
        >{@render ic(theme === 'dark' ? 'sun' : 'moon', 16)}</button
      >
    </div>
  </header>

  <!-- ───────── MODEL BANNER (non-blocking) ───────── -->
  {#if loadPhase}
    <div class="model-banner">
      <span class="spinner"></span>
      <span
        >Setting up on-device chat model · <strong>{modelById(modelId)?.label ?? 'model'}</strong
        ></span
      >
      <span class="mb-bar"><span class="mb-fill" style="width:{loadPct}%"></span></span>
      <span class="mb-pct">{loadPct}%</span>
      <span class="mb-div"></span>
      <span class="mb-note">Semantic search works now — no GPU needed</span>
    </div>
  {/if}

  <!-- ───────── BODY: sidebar · center · ask rail ───────── -->
  <div class="body">
    <!-- SIDEBAR -->
    <aside
      class="sidebar"
      class:drop={dropFolder === ''}
      ondragover={(e) => onTreeDragOverFolder(e, '')}
      ondragleave={() => {
        if (dropFolder === '') dropFolder = null;
      }}
      ondrop={(e) => onTreeDropFolder(e, '')}
    >
      <div class="side-scroll">
        <div class="side-head">
          <span class="label">Vault · {vault.length}</span>
          <button
            class="ghost-ic nb-hov nb-press"
            title="New note / folder"
            onclick={(e) => openCtxMenu(e, 'root', '')}>{@render ic('plus', 14)}</button
          >
        </div>

        {#if activeTag}
          <div class="side-head">
            <span class="label">#{activeTag} · {filteredNotes.length}</span><button
              class="link-btn"
              onclick={() => (activeTag = null)}>clear</button
            >
          </div>
          {#each filteredNotes as note (note.docId)}
            <button
              class="tree-file nb-hov"
              class:active={activeDoc === note.docId}
              onclick={() => showSource(note.docId)}
              oncontextmenu={(e) => openCtxMenu(e, 'file', note.docId)}
            >
              <span class="tf-ic">{@render ic('file', 13)}</span><span class="tf-nm"
                >{note.title}</span
              >
            </button>
          {/each}
        {:else}
          {@render tree(fileTree)}
        {/if}

        <div class="side-head mt">
          <span class="label">Entities</span><span class="tree-count">{entityIndex.length}</span>
        </div>
        {#if entityIndex.length}
          <div class="ent-list" class:scroll={showAllEntities}>
            {#each showAllEntities ? entityIndex : entityIndex.slice(0, 6) as e (e.id)}
              {@const on = rightView === 'graph' && selectedEntity?.id === e.id}
              <button
                class="ent-row nb-hov"
                class:active={on}
                onclick={() => openEntity(e)}
                title={e.type}
              >
                <span class="ent-dot" style="background:{entityColor(e.type)}"></span>
                <span class="ent-nm">{e.name}</span>
                <span class="tree-count">{e.noteCount}</span>
              </button>
            {/each}
          </div>
          {#if entityIndex.length > 6}
            <button
              class="ent-row more-ent nb-hov"
              onclick={() => (showAllEntities = !showAllEntities)}
            >
              {showAllEntities ? 'Show fewer' : `Show all ${entityIndex.length}`}
            </button>
          {/if}
          <button class="ent-row open-lens nb-hov" onclick={() => switchView('graph')}>
            <span class="lens-ic">{@render ic('graph', 14)}</span> Open graph lens
          </button>
        {:else}
          <button class="build-graph nb-press" onclick={buildVaultGraph} disabled={graphBusy}>
            {#if graphBusy}<span class="spinner"></span>extracting…{:else}{@render ic('graph', 14)} Build
              entity graph{/if}
          </button>
        {/if}
        {#if graphStale && entityIndex.length}
          <!-- New/edited notes were saved while no model was loaded, so their entities aren't in the
               graph yet. Clicking loads a model and re-extracts so the graph catches up (FR-GRAPH-001). -->
          <button
            class="graph-stale nb-hov"
            onclick={buildVaultGraph}
            disabled={graphBusy}
            title="New notes aren't in the graph yet — update to extract their entities"
          >
            {#if graphBusy}<span class="spinner"></span>updating…{:else}{@render ic('graph', 12)} Update
              graph — new notes pending{/if}
          </button>
        {/if}

        {#if tagIndex.length}
          <div class="side-head mt"><span class="label">Tags</span></div>
          <div class="tagwrap">
            {#each tagIndex as t (t.tag)}
              <button
                class="tagchip nb-hov"
                class:active={activeTag === t.tag}
                onclick={() => toggleTag(t.tag)}>#{t.tag}</button
              >
            {/each}
          </div>
        {/if}
      </div>

      <div class="side-foot">
        <div class="scope-pill">
          <span class="scope-ic">{@render ic('box', 15)}</span>
          <span class="scope-lbl">Scope</span>
          <select
            class="scope-select"
            value={scope
              ? scope.kind === 'folder'
                ? `folder:${scope.value}`
                : `tag:${scope.value}`
              : ''}
            onchange={(e) => setScope(e.currentTarget.value)}
            title="Limit Ask + Compile to one client (no cross-client bleed)"
          >
            <option value="">whole vault</option>
            {#if folderScopes.length}
              <optgroup label="Folders"
                >{#each folderScopes as f (f)}<option value={`folder:${f}`}>{f}/</option
                  >{/each}</optgroup
              >
            {/if}
            {#if tagIndex.length}
              <optgroup label="Tags"
                >{#each tagIndex as t (t.tag)}<option value={`tag:${t.tag}`}>#{t.tag}</option
                  >{/each}</optgroup
              >
            {/if}
          </select>
          {@render ic('chevdown', 13)}
        </div>
      </div>
    </aside>

    <!-- CENTER -->
    <section class="center">
      {#if rightView === 'graph'}
        <!-- GRAPH LENS -->
        <div class="lens-head">
          <span class="lens-ic accent">{@render ic('graph', 18)}</span>
          <span class="lens-title">Graph lens</span>
          <span class="lens-sub"
            >{entityIndex.length} entities · {entityRelations.length} relations</span
          >
          <span class="spacer"></span>
          {#if entityIndex.length}<span class="pill ok-pill"
              >{@render ic('check', 13)} graph built</span
            >{/if}
          <button
            class="icon-btn nb-hov nb-press"
            onclick={() => switchView('files')}
            title="Close lens">{@render ic('close', 15)}</button
          >
        </div>
        <div class="lens-body">
          {#if graphBusy}
            <div class="center-empty">
              <span class="spinner big"></span>
              <p>Extracting entities & relations…</p>
            </div>
          {:else if selectedEntity && entityLayout}
            {#if entityLayout.nodes.length > 1}
              <div class="lens-canvas">
                <svg
                  bind:this={svgEl}
                  class="entity-graph"
                  class:grabbing={drag !== null}
                  viewBox="0 0 {entityLayout.width} {entityLayout.height}"
                  onpointerdown={onGraphPointerDown}
                  onpointermove={onGraphPointerMove}
                  onpointerup={onGraphPointerUp}
                  onpointercancel={onGraphPointerUp}
                  onwheel={onGraphWheel}
                  role="img"
                  aria-label="Entity graph for {selectedEntity.name}"
                >
                  <g transform="translate({graphView.tx} {graphView.ty}) scale({graphView.scale})">
                    {#each entityLayout.edges as e (e.from + '|' + e.to + '|' + e.label)}
                      <line
                        x1={e.x1}
                        y1={e.y1}
                        x2={e.x2}
                        y2={e.y2}
                        stroke="var(--line-strong)"
                        stroke-width="1.5"
                      />
                      <rect
                        x={e.mx - e.label.replace(/_/g, ' ').length * 3.3 - 6}
                        y={e.my - 9}
                        width={e.label.replace(/_/g, ' ').length * 6.6 + 12}
                        height="18"
                        rx="9"
                        fill="var(--surface)"
                        stroke="var(--line)"
                      />
                      <text
                        x={e.mx}
                        y={e.my}
                        class="edge-label"
                        text-anchor="middle"
                        dominant-baseline="middle">{e.label.replace(/_/g, ' ')}</text
                      >
                    {/each}
                    {#each entityLayout.nodes as n (n.id)}
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <g
                        class="g-node"
                        class:center={n.hop === 0}
                        role="button"
                        tabindex="0"
                        onpointerdown={(ev) => onNodePointerDown(ev, n)}
                        onkeydown={(ev) =>
                          ev.key === 'Enter' && n.hop !== 0 && openEntityById(n.id)}
                      >
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={n.r}
                          fill="var(--surface)"
                          stroke={entityColor(n.type)}
                          stroke-width={n.hop === 0 ? 2.5 : 1.6}
                        />
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={n.r}
                          fill={entityColor(n.type)}
                          opacity={n.hop === 0 ? 0.14 : 0.07}
                        />
                        <text
                          x={n.x}
                          y={n.y}
                          class="node-label"
                          text-anchor="middle"
                          dominant-baseline="middle">{n.label}</text
                        >
                      </g>
                    {/each}
                  </g>
                </svg>
                <div class="lens-hint">
                  Click any node to re-center · drag to pan · scroll to zoom
                </div>
              </div>
            {:else}
              <div class="center-empty">
                <p>No relations extracted for <strong>{selectedEntity.name}</strong> yet.</p>
                <button class="ghost-btn" onclick={buildVaultGraph}
                  >↻ Rebuild with a stronger model</button
                >
              </div>
            {/if}
            {#if entityNotes.length}
              <div class="lens-mentions">
                <div class="label">
                  Notes mentioning {selectedEntity.name} · {entityNotes.length}
                </div>
                <div class="mention-grid">
                  {#each entityNotes as docId (docId)}
                    <button class="mention nb-hov" onclick={() => showSource(docId)}>
                      <span class="tf-ic">{@render ic('file', 15)}</span>
                      <span class="mention-nm">{docId}</span>
                      <span class="mention-go">{@render ic('arrow', 14)}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          {:else}
            <div class="center-empty">
              <span class="empty-ic">{@render ic('graph', 26)}</span>
              <p>Pick an entity to see how it connects across your vault.</p>
            </div>
          {/if}
        </div>
      {:else if mode === 'write'}
        <!-- NOTE — EDIT IN PLACE -->
        <div class="note-scroll">
          <div class="note-col">
            <div class="note-head">
              <div class="breadcrumb">
                <span>{draftFolder.trim() || 'vault root'}</span><span class="slash">/</span><span
                  class="mono">{(editingDocId ?? draftTitle) + (editingDocId ? '' : '.md')}</span
                >
              </div>
              <div class="note-actions">
                <button
                  class="act-btn primary nb-press"
                  onclick={saveNote}
                  disabled={!ready || savingNote}
                  >{@render ic('check', 14)} {savingNote ? 'Saving…' : 'Done'}</button
                >
              </div>
            </div>
            <input
              class="title-input"
              bind:value={draftTitle}
              placeholder="Note title"
              disabled={savingNote}
            />
            <div class="edit-toolbar">
              <select
                class="tpl-select"
                disabled={savingNote}
                title="Insert a template"
                onchange={(e) => {
                  applyTemplate(e.currentTarget.value);
                  e.currentTarget.selectedIndex = 0;
                }}
              >
                <option value="">Template ▾</option>
                {#each BUILTIN_TEMPLATES as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
              </select>
              {#if !editingDocId}<input
                  class="folder-input mono"
                  bind:value={draftFolder}
                  placeholder="folder — blank = vault root"
                  title="Folder, e.g. clients/acme — leave blank to keep the note at the vault root (no folder)"
                  disabled={savingNote}
                />{/if}
              <span class="md-tag">Markdown</span>
            </div>
            <div class="body-wrap">
              <textarea
                class="body-input mono"
                bind:this={bodyEl}
                bind:value={draftBody}
                placeholder="Write in Markdown… type [[ to link a note"
                disabled={savingNote}
                oninput={onBodyInput}
                onkeyup={onBodyInput}
                onclick={onBodyInput}
              ></textarea>
              {#if wlState && wlState.suggestions.length}
                <ul class="wl-menu">
                  {#each wlState.suggestions as s (s.docId)}
                    <li>
                      <button
                        class="wl-item nb-hov"
                        onmousedown={(e) => e.preventDefault()}
                        onclick={() => pickWikilink(s.title)}
                        ><span>{s.title}</span><span class="mono dim">{s.docId}</span></button
                      >
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
            <div class="edit-foot">
              Saved locally · <span class="mono">{editingDocId ?? `notes/${draftTitle}.md`}</span> ·
              re-embeds on Done{#if editMsg}
                · {editMsg}{/if}
            </div>
          </div>
        </div>
      {:else}
        <!-- NOTE — READ -->
        {#if openTabs.length}
          <div class="tab-strip" role="tablist">
            {#each openTabs as docId (docId)}
              {@const tab = vault.find((n) => n.docId === docId)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="tab"
                class:active={activeDoc === docId}
                class:dragging={tabDrag === docId}
                role="tab"
                tabindex="0"
                aria-selected={activeDoc === docId}
                draggable="true"
                title={docId}
                onclick={() => selectTab(docId)}
                onkeydown={(e) => e.key === 'Enter' && selectTab(docId)}
                ondragstart={(e) => onTabDragStart(e, docId)}
                ondragover={(e) => onTabDragOver(e, docId)}
                ondragend={onTabDragEnd}
              >
                <span class="tab-ic">{@render ic('file', 12)}</span>
                <span class="tab-nm">{tab?.title ?? shortName(docId)}</span>
                <button
                  class="tab-x nb-hov"
                  title="Close tab"
                  aria-label="Close tab"
                  onclick={(e) => {
                    e.stopPropagation();
                    closeTab(docId);
                  }}>{@render ic('close', 12)}</button
                >
              </div>
            {/each}
          </div>
        {/if}
        <div class="note-scroll">
          <div class="note-col">
            {#if activeNote}
              <div class="note-head">
                <div class="breadcrumb">
                  <span>{activeNote.docId.split('/').slice(0, -1).join('/') || 'vault root'}</span
                  ><span class="slash">/</span><span class="mono"
                    >{activeNote.docId.split('/').pop()}</span
                  >
                </div>
                <div class="note-actions">
                  {#if !activeNote.sourcePath}<button
                      class="act-btn nb-hov nb-press"
                      onclick={() => editNote(activeNote)}>{@render ic('edit', 14)} Edit</button
                    >{/if}
                  <button
                    class="icon-btn nb-hov nb-press"
                    onclick={() => renameNoteAction(activeNote)}
                    title="Rename">{@render ic('link', 15)}</button
                  >
                  <button
                    class="icon-btn nb-hov nb-press"
                    onclick={(e) => openCtxMenu(e, 'file', activeNote.docId)}
                    title="More">{@render ic('dots', 15)}</button
                  >
                </div>
              </div>
              {#if activeNote.sourcePath}<div class="source-link">
                  source: {activeNote.sourcePath} — original preserved, never edited
                </div>{/if}
              <h1 class="note-title">{activeNote.title}</h1>
              {#if activeNote.kind}<span class="kind-badge">{activeNote.kind}</span>{/if}
              {#if activeSpan}
                {@const seg = buildHighlightSegments(
                  activeNote.text,
                  activeSpan.charStart,
                  activeSpan.charEnd
                )}
                <article class="prose">{seg.pre}<mark>{seg.hit}</mark>{seg.post}</article>
              {:else}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <article
                  class="prose"
                  role="document"
                  onclick={onRenderedClick}
                  onkeydown={(e) =>
                    e.key === 'Enter' && onRenderedClick(e as unknown as MouseEvent)}
                >
                  {@html renderMarkdown(activeNote.text, { resolveLink: resolveNoteLink })}
                </article>
              {/if}
              {#if activeNoteEntities.length}
                <div class="note-entities">
                  <div class="label">Entities in this note · {activeNoteEntities.length}</div>
                  <div class="ent-chips">
                    {#each activeNoteEntities as e (e.id)}
                      <button class="ent-chip nb-hov" onclick={() => openEntity(e)} title={e.type}>
                        <span class="ent-dot" style="background:{entityColor(e.type)}"
                        ></span>{e.name}</button
                      >
                    {/each}
                  </div>
                </div>
              {/if}
              {#if activeBacklinks.length || activeUnlinked.length}
                <div class="mentions">
                  {#if activeBacklinks.length}
                    <div class="label">Linked mentions · {activeBacklinks.length}</div>
                    {#each activeBacklinks as bl (bl.docId)}
                      <button class="mention nb-hov" onclick={() => showSource(bl.docId)}
                        ><span class="mono accent">{bl.docId}</span><span class="mention-pv"
                          >{bl.title}{bl.count > 1 ? ` ×${bl.count}` : ''}</span
                        ></button
                      >
                    {/each}
                  {/if}
                  {#if activeUnlinked.length}
                    <div class="label mt">Unlinked mentions · {activeUnlinked.length}</div>
                    {#each activeUnlinked as um (um.docId)}
                      <button class="mention nb-hov" onclick={() => showSource(um.docId)}
                        ><span class="mono accent">{um.title}</span><span class="mention-pv"
                          >{um.snippet}</span
                        ></button
                      >
                    {/each}
                  {/if}
                </div>
              {/if}
            {:else}
              <div class="center-empty">
                <span class="empty-ic">{@render ic('file', 26)}</span>
                <p>
                  Select a note from the sidebar, or <button class="link-btn" onclick={startNewNote}
                    >write a new one</button
                  >.
                </p>
                <p class="dim sm">
                  Right-click the tree to add · rename · move · delete. Drag a note onto a folder to
                  move it.
                </p>
                <div class="empty-cta">
                  <button class="ghost-btn" onclick={startNewNote}
                    >{@render ic('plus', 14)} New note</button
                  >
                  <button class="ghost-btn" onclick={openDailyNote}>Today</button>
                  <button class="ghost-btn" onclick={() => fileInput?.click()}>Import files</button>
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <!-- ASK RAIL -->
    <aside class="rail">
      <div class="rail-head">
        <span class="rail-title">Ask</span>
        <span class="rail-scope"
          >scoped to <span class="mono">{scope ? scopeLabel(scope) : 'whole vault'}</span></span
        >
        <span class="spacer"></span>
        {#if history.length || answer || hits.length}
          <button
            class="rail-new nb-hov"
            onclick={newConversation}
            disabled={busy}
            title="Start a new conversation">{@render ic('plus', 13)} New</button
          >
        {/if}
        <kbd>⌘J</kbd>
      </div>

      <div class="rail-body">
        {#if history.length}
          <!-- Conversation transcript (FR-CHAT-006): prior turns above the live one. Past answers keep
               their prose but drop [#n] buttons (their retrieved hits are no longer held). -->
          {#each history as turn, i (i)}
            <div class="ask-bubble past">{turn.query}</div>
            <article class="prose answer past">{@html pastAnswerHtml(turn.answer)}</article>
          {/each}
        {/if}
        {#if busy || answer || hits.length}
          {#if askedQuery}<div class="ask-bubble">{askedQuery}</div>{/if}
          {#if busy && !reasoning && !answerHtml}<div class="rail-loading">
              <span class="spinner"></span><span>{status}</span>
            </div>{/if}
          {#if reasoning}
            <!-- Reasoning panel: auto-open while the model is still thinking (no answer text yet),
                 collapses once the real answer starts streaming. User can re-open it any time. -->
            <details class="think" open={busy && !answerHtml}>
              <summary>
                {@render ic('graph', 13)}
                <span>{busy && !answerHtml ? 'Thinking…' : 'Thoughts'}</span>
              </summary>
              <div class="think-body prose">{@html reasoningHtml}</div>
            </details>
          {/if}
          {#if answerFellBack}
            <div class="rail-note">
              The model kept its whole answer inside its private reasoning and didn't write a
              separate final answer, so its reasoning is shown below. If this keeps happening, a
              non-reasoning model (e.g. <strong>Qwen2.5-7B</strong>) answers more reliably.
            </div>
          {/if}
          {#if answerHtml}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <article
              class="prose answer"
              role="document"
              onclick={onRenderedClick}
              onkeydown={(e) => e.key === 'Enter' && onRenderedClick(e as unknown as MouseEvent)}
            >
              {@html answerHtml}{#if busy}<span class="nb-cursor"></span>{/if}
            </article>
          {/if}
          {#if hits.length}
            {@const usage = answerUsage(
              hits.map((h) => h.chunkId),
              cites.map((c) => c.chunkId)
            )}
            <div class="used-strip">
              {#if usage.count > 0}<span class="us-ok"
                  >{@render ic('check', 13)} used {usage.count}/{hits.length}</span
                >{/if}
              {#if graphInfo}<span class="us-div"></span><span class="us-graph">{graphInfo}</span
                >{/if}
            </div>
            <div class="label">Sources</div>
            <div class="src-list">
              {#each hits as h, i (h.chunkId)}
                {@const used = usage.used.has(h.chunkId)}
                {@const viaGraph = graphExpandedIds.has(h.chunkId)}
                <button class="src-row nb-hov" class:used onclick={() => jumpTo(h.chunkId)}>
                  <span class="src-n">#{i + 1}</span>
                  <span class="src-path mono">{h.docId}</span>
                  {#if viaGraph}<span class="src-graph"
                      >↳ {(graphShared.get(h.chunkId)?.sharedEntities ?? []).join(', ')}</span
                    >{:else}<span class="src-why">vector</span>{/if}
                  <span class="src-score mono">{h.score.toFixed(2)}</span>
                </button>
              {/each}
            </div>
            {#if graph}
              <div class="micromap">
                <div class="label sm">Retrieval sub-graph</div>
                <svg
                  width="100%"
                  height={32 + graph.nodes.filter((n) => n.kind === 'chunk').length * 26}
                  viewBox="0 0 300 {32 + graph.nodes.filter((n) => n.kind === 'chunk').length * 26}"
                >
                  {#each graph.edges as e, i (e.to)}
                    <line
                      x1="34"
                      y1="20"
                      x2="250"
                      y2={26 + i * 26}
                      stroke="var(--line-strong)"
                      stroke-width={e.width}
                      stroke-dasharray={e.viaGraph ? '4 3' : ''}
                    />
                  {/each}
                  <circle cx="34" cy="20" r="6" fill="var(--accent)" />
                  {#each graph.nodes.filter((n) => n.kind === 'chunk') as n, i (n.id)}
                    <circle
                      cx="250"
                      cy={26 + i * 26}
                      r="4.5"
                      fill={n.viaGraph ? 'var(--accent)' : 'var(--surface)'}
                      stroke={n.viaGraph ? 'var(--accent)' : 'var(--line-strong)'}
                      stroke-width="1.5"
                    />
                    <text x="240" y={29 + i * 26} class="mm-label" text-anchor="end">{n.label}</text
                    >
                  {/each}
                </svg>
              </div>
            {/if}
            <button class="compile-btn nb-press" onclick={openCompileFromHits}
              >{@render ic('box', 16)} Compile this context</button
            >
          {/if}
        {:else}
          <p class="rail-idle">
            Ask anything about your notes. Answers are grounded in your vault and cite their
            sources.
          </p>
          <div class="label">Try</div>
          <div class="try-list">
            {#each ['What did we decide and why?', 'Who owns what — and how does it connect?', 'Summarize the open risks'] as s}
              <button
                class="try nb-hov"
                onclick={() => {
                  query = s;
                  ask();
                }}
                disabled={!ready}>{s}</button
              >
            {/each}
          </div>
        {/if}
      </div>

      <div class="composer">
        <div class="composer-box">
          <textarea
            bind:value={query}
            rows="1"
            placeholder="Ask a question…"
            disabled={busy}
            onkeydown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
          ></textarea>
          <button
            class="send"
            class:on={query.trim()}
            onclick={ask}
            disabled={!ready || busy}
            aria-label="Ask">{@render ic('send', 16)}</button
          >
        </div>
        <div class="composer-foot">
          <div class="mode-chips">
            <button
              class="mchip nb-hov"
              class:on={answerMode === 'reason'}
              onclick={() => (answerMode = 'reason')}
              title="Reason with your notes">{@render ic('bolt', 12)} Reason</button
            >
            <button
              class="mchip nb-hov"
              class:on={answerMode === 'grounded'}
              onclick={() => (answerMode = 'grounded')}
              title="Strict, verifiable">Grounded</button
            >
            <button
              class="mchip nb-hov"
              class:on={graphRagOn}
              onclick={() => (graphRagOn = !graphRagOn)}
              title="Pull in chunks connected through shared entities"
              >{@render ic('graph', 12)} GraphRAG</button
            >
          </div>
          <span class="dim sm">Runs on your device</span>
        </div>
      </div>
    </aside>
  </div>

  <input
    class="hidden-input"
    type="file"
    multiple
    accept=".pdf,.csv,.txt,.md,.markdown,.text"
    bind:this={fileInput}
    onchange={(e) => ingestFiles(e.currentTarget.files)}
  />

  <!-- ───────── OVERLAYS ───────── -->
  {#if preview}<div class="popover" style="left:{preview.x}px; top:{preview.y}px">
      {preview.text}
    </div>{/if}

  {#if switcherOpen}
    <div
      class="overlay center-top"
      role="button"
      tabindex="-1"
      aria-label="Close"
      onclick={() => (switcherOpen = false)}
      onkeydown={(e) => e.key === 'Escape' && (switcherOpen = false)}
    >
      <div
        class="switcher nb-rise"
        role="dialog"
        tabindex="-1"
        aria-label="Quick switcher"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            if (switcherQuery.trim() && !switcherResults.length) {
              query = switcherQuery;
              switcherOpen = false;
              ask();
            } else if (switcherResults[0]) chooseSwitch(switcherResults[0].docId);
          }
        }}
      >
        <div class="sw-input">
          <span class="dim">{@render ic('search', 17)}</span>
          <input
            id="switcher-input"
            bind:value={switcherQuery}
            placeholder="Jump to a note, entity — or ask a question…"
            autocomplete="off"
          />
          <kbd>esc</kbd>
        </div>
        <ul class="sw-list">
          {#if switcherQuery.trim()}
            <li>
              <button
                class="sw-ask nb-hov"
                onclick={() => {
                  query = switcherQuery;
                  switcherOpen = false;
                  ask();
                }}
                >{@render ic('bolt', 16)}<span
                  >Ask your vault: <strong>“{switcherQuery}”</strong></span
                >{@render ic('arrow', 15)}</button
              >
            </li>
          {/if}
          {#each switcherResults as r (r.docId)}
            <li>
              <button class="sw-item nb-hov" onclick={() => chooseSwitch(r.docId)}
                ><span class="dim">{@render ic('file', 15)}</span><span>{r.title}</span><span
                  class="mono dim">{r.docId}</span
                ></button
              >
            </li>
          {:else}
            {#if !switcherQuery.trim()}<li class="sw-empty">No matching notes</li>{/if}
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if compileOpen}
    <div
      class="overlay to-right"
      role="button"
      tabindex="-1"
      aria-label="Close"
      onclick={() => (compileOpen = false)}
      onkeydown={(e) => e.key === 'Escape' && (compileOpen = false)}
    >
      <div
        class="sheet nb-sheet-in"
        role="dialog"
        tabindex="-1"
        aria-label="Context Compiler"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (compileOpen = false)}
      >
        <div class="sheet-head">
          <span class="accent">{@render ic('box', 18)}</span><strong>Compile context</strong><span
            class="spacer"
          ></span><button class="icon-btn nb-hov" onclick={() => (compileOpen = false)}
            >{@render ic('close', 15)}</button
          >
        </div>
        <div class="sheet-body">
          <div class="step">
            <div class="step-h"><span class="step-n">1</span> Share</div>
            <p class="dim sm">
              The most relevant ~5% of your vault — not the whole folder. {compileSources.length} source(s){scope
                ? ` · ${scopeLabel(scope)}`
                : ''}.
            </p>
            <label class="field"
              >Target model
              <select bind:value={compileModel}
                >{#each COMPILE_MODELS as m (m)}<option value={m}>{m}</option>{/each}</select
              >
            </label>
            {#if compileFrom === 'answer'}<label class="field"
                >Token budget<input
                  type="number"
                  min="200"
                  step="200"
                  bind:value={compileBudget}
                /></label
              >{/if}
            <label class="field"
              >Task (optional)<input
                bind:value={compileTask}
                placeholder="e.g. How do we de-risk this deal?"
              /></label
            >
          </div>
          <div class="step">
            <div class="step-h"><span class="step-n">2</span> Redact</div>
            <label class="field"
              >Redact text (comma-separated)<input
                bind:value={compileRedact}
                placeholder="Acme, John Doe, 555-…"
              /></label
            >
            <div class="pii-row">
              <span class="dim sm">Scrub PII:</span>
              {#each PII_TYPES as t (t)}
                <label class="pii-chip" class:on={compilePii.has(t)}
                  ><input
                    type="checkbox"
                    checked={compilePii.has(t)}
                    onchange={() => {
                      const n = new Set(compilePii);
                      n.has(t) ? n.delete(t) : n.add(t);
                      compilePii = n;
                    }}
                  />{t}</label
                >
              {/each}
            </div>
            {#if entityIndex.length}
              <div class="pii-row">
                <span class="dim sm">Redact entity:</span>
                <select bind:value={redactEntityId} onchange={applyEntityRedaction}
                  ><option value="">— none —</option>{#each entityIndex as e (e.id)}<option
                      value={e.id}>{e.name}</option
                    >{/each}</select
                >
                <label class="pii-chip" class:on={redactConnected}
                  ><input
                    type="checkbox"
                    checked={redactConnected}
                    onchange={(ev) => {
                      redactConnected = ev.currentTarget.checked;
                      void applyEntityRedaction();
                    }}
                  />+ connected</label
                >
              </div>
            {/if}
            {#if redactPreview.length}<div class="remove-box">
                {@render ic('eyeoff', 14)} Will remove: {#each redactPreview as p (p.label + p.pattern)}<span
                    class="remove-pill">{p.label} ×{p.count}</span
                  >{/each}
              </div>{/if}
          </div>
          <div class="step">
            <div class="step-h"><span class="step-n">3</span> Copy</div>
            {#if compileResult}
              <div class="stat-row">
                <div class="stat">
                  <span class="dim sm">Tokens</span><strong class="mono"
                    >{compileResult.manifest.tokenCount}</strong
                  >
                </div>
                <div class="stat">
                  <span class="dim sm">Est. cost</span><strong
                    class="mono ok"
                    class:over={!compileResult.manifest.cost.fitsWindow}
                    >{formatCost(compileResult.manifest.cost)}</strong
                  >
                </div>
              </div>
              <textarea class="payload mono" readonly rows="10" value={compileResult.xml}
              ></textarea>
              <div class="sheet-actions">
                <button class="act-btn primary nb-press" onclick={copyCompiled}
                  >{@render ic('copy', 15)} Copy</button
                >
                <button class="act-btn nb-hov" onclick={downloadCompiled}
                  >{@render ic('download', 15)} .xml</button
                >
                <span class="dim sm"
                  >⚠ {compileSources.length} source(s) leave the device on copy</span
                >
              </div>
              <details class="paste-back">
                <summary>↩ Paste the model's answer back to navigate its citations</summary>
                <textarea
                  class="mono"
                  bind:value={pasteBack}
                  rows="4"
                  placeholder="Paste GPT/Claude's answer — [path#seq] citations become clickable jumps."
                ></textarea>
                {#if pasteResolved}<div class="paste-refs">
                    {#each pasteResolved.refs as r, i (i)}{#if r.resolved && r.chunkId}{@const cid =
                          r.chunkId}<button
                          class="paste-ref nb-hov"
                          onclick={() => {
                            compileOpen = false;
                            jumpTo(cid);
                          }}>{r.raw} → open</button
                        >{:else}<span class="paste-ref broken">{r.raw} ✕</span>{/if}{/each}
                  </div>{/if}
              </details>
            {:else}<p class="dim">Nothing to compile.</p>{/if}
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if ctxMenu}
    <div
      class="ctx-backdrop"
      role="presentation"
      onclick={closeCtxMenu}
      oncontextmenu={(e) => {
        e.preventDefault();
        closeCtxMenu();
      }}
    ></div>
    <div class="ctx-menu" style="left:{ctxMenu.x}px; top:{ctxMenu.y}px" role="menu">
      {#if ctxMenu.kind === 'file'}
        {@const note = vault.find((n) => n.docId === ctxMenu?.path)}
        <button
          class="ctx-item nb-hov"
          role="menuitem"
          onclick={() => note && showSource(note.docId)}>Open</button
        >
        {#if note && !note.sourcePath}
          <button
            class="ctx-item nb-hov"
            role="menuitem"
            onclick={() => {
              const n = note;
              closeCtxMenu();
              if (n) editNote(n);
            }}>Edit</button
          >
          <button
            class="ctx-item nb-hov"
            role="menuitem"
            onclick={() => {
              const n = note;
              closeCtxMenu();
              if (n) renameNoteAction(n);
            }}>Rename</button
          >
        {/if}
        <button
          class="ctx-item nb-hov"
          role="menuitem"
          onclick={() => {
            const n = note;
            closeCtxMenu();
            if (n) moveNoteAction(n);
          }}>Move…</button
        >
        <button
          class="ctx-item danger nb-hov"
          role="menuitem"
          onclick={() => {
            const p = ctxMenu?.path;
            closeCtxMenu();
            if (p) deleteNote(p);
          }}>Delete</button
        >
      {:else if ctxMenu.kind === 'folder'}
        <button
          class="ctx-item nb-hov"
          role="menuitem"
          onclick={() => newNoteIn(ctxMenu?.path ?? 'notes')}>New note here</button
        >
        <button
          class="ctx-item nb-hov"
          role="menuitem"
          onclick={() => newFolderIn(ctxMenu?.path ?? '')}>New folder</button
        >
        <button
          class="ctx-item nb-hov"
          role="menuitem"
          onclick={() => renameFolder(ctxMenu?.path ?? '')}>Rename folder</button
        >
        <button
          class="ctx-item danger nb-hov"
          role="menuitem"
          onclick={() => deleteFolder(ctxMenu?.path ?? '')}>Delete folder</button
        >
      {:else}
        <button class="ctx-item nb-hov" role="menuitem" onclick={() => newNoteIn('notes')}
          >New note</button
        >
        <button class="ctx-item nb-hov" role="menuitem" onclick={() => newFolderIn('')}
          >New folder</button
        >
      {/if}
    </div>
  {/if}

  {#if modelGate}
    <div class="overlay center" role="presentation">
      <div class="gate nb-rise" role="dialog" aria-modal="true" aria-label="Choose a model">
        <div class="gate-head">
          <strong>On-device chat model</strong>
          <p class="dim sm">
            Runs on your GPU via WebGPU · downloaded once, then offline. No account, no upload.
          </p>
        </div>
        {#if gpu?.ok}
          {@const rec = recommendModel(true)}
          {#if rec}<button
              class="gate-auto nb-press"
              onclick={chooseAutoModel}
              disabled={modelLoading}
              ><span>★ Auto — {rec.label}</span><small class="dim"
                >recommended for your GPU · {formatSize(rec.sizeMB)}</small
              ></button
            >{/if}
          <div class="gate-list">
            {#each MODELS as m (m.id)}
              {@const cached = cachedModels.has(m.id)}
              <div class="gate-row" class:current={m.id === modelId}>
                <button
                  class="gate-pick nb-hov"
                  onclick={() => chooseModel(m.id)}
                  disabled={modelLoading || deletingModel === m.id}
                >
                  <span class="gate-nm"
                    >{m.label}{#if m.multilingual}<span class="mini-badge">multilingual</span
                      >{/if}</span
                  >
                  <span class="gate-sz mono"
                    >{#if cached}<span class="ok">✓ ready</span>{:else}{formatSize(
                        m.sizeMB
                      )}{#if needsOomAck(m.id)}
                        ↓{/if}{/if}</span
                  >
                </button>
                {#if cached}<button
                    class="gate-del nb-hov"
                    title="Remove from this browser"
                    onclick={() => deleteModelFromCache(m.id)}
                    disabled={!!deletingModel}>{deletingModel === m.id ? '…' : '🗑'}</button
                  >{/if}
              </div>
            {/each}
          </div>
          <button class="gate-skip" onclick={closeModelGate}
            >Skip — semantic search, notes & graph still work</button
          >
        {:else}
          <div class="gate-nowebgpu">
            ⚠ No WebGPU — on-device chat is unavailable here, but semantic search, notes, and the
            graph all work. Use Chrome/Edge on a GPU-capable device for chat.
          </div>
          <button class="gate-skip" onclick={closeModelGate}>Continue</button>
        {/if}
      </div>
    </div>
  {/if}
</main>

<style>
  /* ───────── Clean Slate workspace styles (tokens in $lib/styles/tokens.css) ───────── */
  .shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--ui);
  }
  .shell.drop {
    outline: 2px dashed var(--accent);
    outline-offset: -6px;
  }
  .spacer {
    flex: 1;
  }
  .mono {
    font-family: var(--mono);
  }
  .dim {
    color: var(--muted);
  }
  .accent {
    color: var(--accent);
  }
  .ok {
    color: var(--ok);
  }
  .sm {
    font-size: 12px;
  }
  .mt {
    margin-top: 18px;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  kbd {
    font-size: 11px;
    color: var(--muted);
    background: var(--surface-alt);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    padding: 2px 6px;
  }
  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: nbSpin 0.8s linear infinite;
    flex: 0 0 auto;
    display: inline-block;
  }
  .spinner.big {
    width: 22px;
    height: 22px;
    border-width: 3px;
  }

  /* topbar */
  .topbar {
    height: 53px;
    flex: 0 0 53px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }
  .tb-left {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 200px;
  }
  .brand-name {
    font-weight: 600;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .tb-center {
    flex: 1;
    display: flex;
    justify-content: center;
  }
  .omnibox {
    width: 100%;
    max-width: 540px;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 12px;
    border-radius: var(--r-md);
    background: var(--surface-alt);
    border: 1px solid var(--line);
    color: var(--faint);
  }
  .omni-ic {
    display: inline-flex;
    color: var(--faint);
  }
  .omni-txt {
    flex: 1;
    text-align: left;
    font-size: 13.5px;
  }
  .tb-right {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 232px;
    justify-content: flex-end;
  }
  .icon-btn {
    width: 32px;
    height: 32px;
    flex: 0 0 auto; /* don't shrink in the topbar flex row (keeps all icons a square 32px) */
    display: grid;
    place-items: center;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    text-decoration: none; /* also used as an <a> (the GitHub link) */
    cursor: pointer;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border-radius: var(--r-pill);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    border: 1px solid var(--line);
    background: var(--surface-alt);
    color: var(--ink-2);
  }
  .model-pill {
    cursor: pointer;
  }
  .model-pill:disabled {
    cursor: progress;
    opacity: 0.7;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    flex: 0 0 auto;
    background: var(--faint);
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.busy {
    background: var(--warn);
    animation: dotpulse 1s ease-in-out infinite;
  }
  @keyframes dotpulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  .ok-pill {
    background: var(--ok-soft);
    color: var(--ok);
    border: none;
  }
  .busy-pill {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border: none;
  }
  .warn-pill {
    background: var(--warn-soft);
    color: var(--warn);
    border: none;
    cursor: help;
  }

  /* model banner */
  .model-banner {
    height: 38px;
    flex: 0 0 38px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 12.5px;
    border-bottom: 1px solid var(--accent-rim);
  }
  .mb-bar {
    width: 120px;
    height: 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.4);
    overflow: hidden;
  }
  .mb-fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.3s;
  }
  .mb-pct {
    font-family: var(--mono);
    font-size: 12px;
  }
  .mb-div {
    width: 1px;
    height: 14px;
    background: var(--accent-rim);
  }
  .mb-note {
    color: var(--accent-ink);
    opacity: 0.8;
  }

  /* body grid */
  .body {
    flex: 1;
    display: grid;
    grid-template-columns: 232px 1fr 384px;
    min-height: 0;
  }

  /* sidebar */
  .sidebar {
    background: var(--sidebar);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sidebar.drop {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
  }
  .side-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 14px 10px 8px;
  }
  .side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 6px;
    margin-bottom: 6px;
  }
  .side-head.mt {
    margin-top: 18px;
  }
  .ghost-ic {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: var(--r-sm);
    border: none;
    background: transparent;
    color: var(--muted);
  }
  .link-btn {
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    padding: 0;
  }
  .tree-folder,
  .tree-file,
  .ent-row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    height: 28px;
    border-radius: var(--r-sm);
    cursor: pointer;
    font-size: 13px;
    border: none;
    background: transparent;
    color: var(--ink-2);
    text-align: left;
    padding: 0 8px;
  }
  .tree-folder {
    color: var(--ink);
    font-weight: 500;
  }
  .caret {
    display: inline-flex;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .tree-count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--faint);
    margin-left: auto;
  }
  .tree-children {
    display: contents;
  }
  .tree-file {
    padding-left: 24px;
  }
  .tf-ic {
    display: inline-flex;
    color: var(--muted);
    flex: 0 0 auto;
  }
  .tf-nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-file.active {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 600;
  }
  .tree-file.active .tf-ic {
    color: var(--accent-ink);
  }
  .tree-file.dragging {
    opacity: 0.5;
  }
  .ent-dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex: 0 0 auto;
  }
  .ent-nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ent-row.active {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .ent-list.scroll {
    max-height: 280px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .more-ent {
    color: var(--muted);
    font-weight: 500;
    font-size: 12px;
    padding-left: 10px;
  }
  .open-lens {
    color: var(--accent);
    font-weight: 500;
    margin-top: 2px;
  }
  .lens-ic {
    display: inline-flex;
    color: var(--accent);
  }
  .build-graph {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink-2);
    font-size: 12.5px;
    cursor: pointer;
  }
  .graph-stale {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin-top: 6px;
    padding: 7px 10px;
    border-radius: var(--r-md);
    border: 1px dashed var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 12px;
    cursor: pointer;
  }
  .graph-stale:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .tagwrap {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 4px;
  }
  .tagchip {
    font-size: 12px;
    color: var(--muted);
    padding: 3px 9px;
    border-radius: var(--r-pill);
    border: 1px solid var(--line);
    background: transparent;
    cursor: pointer;
  }
  .tagchip.active {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-color: var(--accent-rim);
  }
  .side-foot {
    padding: 8px 10px 12px;
    border-top: 1px solid var(--line);
  }
  .scope-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 11px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--surface);
    font-size: 12.5px;
    color: var(--muted);
  }
  .scope-ic {
    display: inline-flex;
    color: var(--accent);
  }
  .scope-lbl {
    color: var(--muted);
  }
  .scope-select {
    flex: 1;
    border: none;
    background: transparent;
    font: inherit;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    cursor: pointer;
    outline: none;
  }

  /* center */
  .center {
    background: var(--bg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .note-scroll {
    flex: 1;
    overflow-y: auto;
    display: flex;
    justify-content: center;
  }
  .tab-strip {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 6px 8px 0;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    scrollbar-width: thin;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 200px;
    height: 30px;
    padding: 0 6px 0 10px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
    background: transparent;
    color: var(--ink-2);
    font-size: 12.5px;
    cursor: pointer;
    user-select: none;
    flex: 0 0 auto;
  }
  .tab:hover {
    background: var(--surface);
  }
  .tab.active {
    background: var(--surface);
    border-color: var(--line);
    color: var(--ink);
    font-weight: 600;
  }
  .tab.dragging {
    opacity: 0.5;
  }
  .tab-ic {
    display: inline-flex;
    color: var(--muted);
    flex: 0 0 auto;
  }
  .tab.active .tab-ic {
    color: var(--accent-ink);
  }
  .tab-nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--faint);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .tab-x:hover {
    background: var(--line);
    color: var(--ink);
  }
  .note-col {
    width: 100%;
    max-width: 720px;
    padding: 26px 48px 60px;
  }
  .note-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
  }
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .breadcrumb .mono {
    font-size: 12px;
  }
  .slash {
    color: var(--faint);
  }
  .note-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .act-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--surface);
    font: inherit;
    font-size: 12.5px;
    color: var(--ink-2);
    cursor: pointer;
  }
  .act-btn.primary {
    background: var(--accent);
    color: #fff;
    border: none;
    font-weight: 600;
  }
  .act-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .note-title {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.02em;
    color: var(--ink);
    margin: 0 0 12px;
  }
  .kind-badge {
    display: inline-block;
    font-size: 11px;
    color: var(--muted);
    background: var(--surface-alt);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    padding: 1px 8px;
    margin-bottom: 12px;
  }
  .source-link {
    font-size: 12px;
    color: var(--muted);
    background: var(--surface-alt);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: 8px 11px;
    margin-bottom: 14px;
  }
  .title-input {
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    font-family: var(--ui);
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--ink);
    margin-bottom: 12px;
  }
  .edit-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .tpl-select,
  .folder-input {
    height: 30px;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--surface-alt);
    color: var(--ink-2);
    font: inherit;
    font-size: 12.5px;
    padding: 0 8px;
  }
  .md-tag {
    font-size: 11.5px;
    color: var(--faint);
    margin-left: auto;
  }
  .body-wrap {
    position: relative;
  }
  .body-input {
    width: 100%;
    min-height: 380px;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--surface);
    color: var(--ink-2);
    padding: 16px 18px;
    font-family: var(--mono);
    font-size: 14px;
    line-height: 1.65;
    resize: vertical;
    outline: none;
  }
  .wl-menu {
    position: absolute;
    left: 18px;
    top: 40px;
    z-index: 20;
    list-style: none;
    margin: 0;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-md);
    max-height: 220px;
    overflow: auto;
    min-width: 240px;
  }
  .wl-item {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    border: none;
    background: none;
    font: inherit;
    font-size: 13px;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    cursor: pointer;
    text-align: left;
    color: var(--ink);
  }
  .edit-foot {
    margin-top: 8px;
    font-size: 12px;
    color: var(--faint);
  }

  /* prose (rendered markdown via @html) */
  .prose {
    font-size: 15.5px;
    line-height: 1.62;
    color: var(--ink-2);
  }
  .prose mark {
    background: var(--mark);
    color: var(--mark-ink);
    border-radius: 4px;
    padding: 1px 4px;
  }
  .prose :global(h1) {
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
    margin: 0 0 12px;
  }
  .prose :global(h2) {
    font-size: 16.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 26px 0 12px;
  }
  .prose :global(h3) {
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    margin: 20px 0 10px;
  }
  .prose :global(p) {
    margin: 0 0 14px;
  }
  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 14px;
    padding-left: 22px;
  }
  .prose :global(li) {
    margin-bottom: 8px;
  }
  .prose :global(strong) {
    font-weight: 600;
    color: var(--ink);
  }
  .prose :global(a) {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid var(--accent-rim);
    cursor: pointer;
  }
  .prose :global(code) {
    font-family: var(--mono);
    font-size: 0.88em;
    background: var(--surface-alt);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .prose :global(mark) {
    background: var(--mark);
    color: var(--mark-ink);
    border-radius: 4px;
    padding: 1px 4px;
  }
  .prose :global(sup) {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 4px;
    padding: 1px 4px;
  }
  .prose :global(table) {
    border-collapse: collapse;
    font-size: 13.5px;
    margin: 0 0 14px;
  }
  .prose :global(td),
  .prose :global(th) {
    border: 1px solid var(--line);
    padding: 5px 9px;
  }

  .mentions {
    margin-top: 34px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
  .note-entities {
    margin-top: 22px;
  }
  .ent-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .ent-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-alt);
    color: var(--ink-2);
    font-size: 12.5px;
    cursor: pointer;
  }
  .mention {
    display: flex;
    gap: 12px;
    align-items: baseline;
    width: 100%;
    padding: 9px 12px;
    border-radius: var(--r-md);
    background: var(--surface-alt);
    border: 1px solid var(--line);
    margin-top: 8px;
    cursor: pointer;
    text-align: left;
  }
  .mention .mono {
    font-size: 12px;
    color: var(--accent-ink);
    flex: 0 0 auto;
  }
  .mention-pv {
    font-size: 12.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* empty */
  .center-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 60px 20px;
    text-align: center;
    color: var(--muted);
  }
  .empty-ic {
    color: var(--faint);
  }
  .empty-cta {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  /* graph lens */
  .lens-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 28px;
    border-bottom: 1px solid var(--line);
    flex: 0 0 auto;
  }
  .lens-ic.accent {
    color: var(--accent);
  }
  .lens-title {
    font-size: 16px;
    font-weight: 600;
  }
  .lens-sub {
    font-size: 12.5px;
    color: var(--muted);
  }
  .lens-body {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .lens-canvas {
    flex: 1;
    min-height: 420px;
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 16px;
  }
  .entity-graph {
    width: 100%;
    max-width: 920px;
    touch-action: none;
    cursor: grab;
  }
  .entity-graph.grabbing {
    cursor: grabbing;
  }
  .g-node {
    cursor: pointer;
  }
  .g-node.center {
    cursor: default;
  }
  .node-label {
    font-family: var(--ui);
    font-size: 12px;
    font-weight: 500;
    fill: var(--ink);
    pointer-events: none;
  }
  .g-node.center .node-label {
    font-size: 14px;
    font-weight: 600;
  }
  .edge-label {
    font-family: var(--mono);
    font-size: 10.5px;
    fill: var(--muted);
  }
  .lens-hint {
    position: absolute;
    left: 20px;
    bottom: 16px;
    font-size: 12px;
    color: var(--faint);
  }
  .lens-mentions {
    padding: 14px 28px 28px;
    border-top: 1px solid var(--line);
  }
  .mention-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 8px;
    margin-top: 10px;
  }
  .mention-grid .mention {
    margin-top: 0;
  }
  .mention-nm {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mention-go {
    color: var(--faint);
  }

  /* ask rail */
  .rail {
    background: var(--rail);
    border-left: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .rail-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 15px 16px 12px;
  }
  .rail-title {
    font-weight: 600;
    font-size: 15px;
  }
  .rail-scope {
    font-size: 11.5px;
    color: var(--muted);
  }
  .rail-scope .mono {
    font-size: 11.5px;
  }
  .rail-body {
    flex: 1;
    overflow-y: auto;
    padding: 0 16px 8px;
  }
  .rail-idle {
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--muted);
    margin: 8px 0 16px;
  }
  .try-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 8px;
  }
  .try {
    text-align: left;
    padding: 10px 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    line-height: 1.45;
    cursor: pointer;
  }
  .ask-bubble {
    max-width: 94%;
    margin: 4px 0 14px auto;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 13.5px;
    line-height: 1.5;
    padding: 9px 12px;
    border-radius: 10px 10px 4px 10px;
  }
  /* Prior turns in the transcript read as quieter than the live one. */
  .ask-bubble.past {
    opacity: 0.78;
    margin-bottom: 10px;
  }
  .prose.answer.past {
    color: var(--ink-2);
    padding-bottom: 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 14px;
  }
  .rail-new {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 9px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink-2);
    font-size: 12px;
    cursor: pointer;
  }
  .rail-new:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .rail-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
    padding: 6px 0 14px;
  }
  .prose.answer {
    font-size: 14px;
    margin-bottom: 14px;
  }
  .prose.answer :global(p) {
    margin: 0 0 10px;
  }
  /* Heads-up shown when a reasoning model produced no final answer and we fell back to its thoughts. */
  .rail-note {
    font-size: 12px;
    line-height: 1.45;
    color: var(--muted);
    background: var(--surface-alt);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: 8px 11px;
    margin-bottom: 12px;
  }
  /* Reasoning ("Thinking") panel — a subdued, collapsible scratchpad above the real answer. */
  .think {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--surface-alt);
    margin-bottom: 12px;
    overflow: hidden;
  }
  .think > summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 11px;
    font-size: 12px;
    font-weight: 500;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .think > summary::-webkit-details-marker {
    display: none;
  }
  .think > summary :global(svg) {
    color: var(--faint);
  }
  .think-body {
    padding: 0 11px 10px;
    font-size: 12.5px;
    color: var(--ink-2);
    border-top: 1px solid var(--line);
  }
  .think-body :global(p) {
    margin: 8px 0 0;
  }
  .used-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 11px;
    border-radius: var(--r-md);
    background: var(--ok-soft);
    margin-bottom: 14px;
    font-size: 12px;
  }
  .us-ok {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ok);
    font-weight: 600;
  }
  .us-div {
    width: 1px;
    height: 12px;
    background: var(--line-strong);
  }
  .us-graph {
    color: var(--ink-2);
  }
  .src-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 7px 0 0;
  }
  .src-row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .src-row.used {
    background: var(--ok-soft);
  }
  .src-n {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    width: 20px;
    flex: 0 0 20px;
  }
  .src-path {
    font-size: 11.5px;
    color: var(--ink-2);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .src-graph {
    font-size: 10.5px;
    color: var(--accent-ink);
    background: var(--accent-soft);
    padding: 2px 6px;
    border-radius: var(--r-pill);
    flex: 0 0 auto;
  }
  .src-why {
    font-size: 10.5px;
    color: var(--muted);
    flex: 0 0 auto;
  }
  .src-score {
    font-size: 10.5px;
    color: var(--faint);
    width: 30px;
    text-align: right;
    flex: 0 0 30px;
  }
  .micromap {
    margin-top: 14px;
    padding: 10px 12px 6px;
    border-radius: var(--r-md);
    background: var(--surface-alt);
    border: 1px solid var(--line);
  }
  .mm-label {
    font-family: var(--mono);
    font-size: 9.5px;
    fill: var(--muted);
  }
  .compile-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    height: 42px;
    border-radius: var(--r-md);
    border: none;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-size: 13.5px;
    font-weight: 600;
    margin: 14px 0 4px;
    cursor: pointer;
  }

  /* composer */
  .composer {
    padding: 10px 16px 14px;
    border-top: 1px solid var(--line);
    background: var(--rail);
    flex: 0 0 auto;
  }
  .composer-box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 8px 8px 12px;
    border-radius: var(--r-lg);
    border: 1px solid var(--line);
    background: var(--surface);
  }
  .composer-box textarea {
    flex: 1;
    border: none;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--ink);
    font-family: var(--ui);
    font-size: 13.5px;
    line-height: 1.5;
    max-height: 90px;
  }
  .send {
    width: 32px;
    height: 32px;
    flex: 0 0 32px;
    display: grid;
    place-items: center;
    border-radius: var(--r-md);
    border: none;
    background: var(--line);
    color: var(--muted);
    cursor: pointer;
    transition: background 0.15s;
  }
  .send.on {
    background: var(--accent);
    color: #fff;
  }
  .composer-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .mode-chips {
    display: flex;
    gap: 6px;
  }
  .mchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--muted);
    padding: 3px 9px;
    border-radius: var(--r-pill);
    border: 1px solid var(--line);
    background: transparent;
    cursor: pointer;
  }
  .mchip.on {
    color: var(--accent-ink);
    background: var(--accent-soft);
    border-color: transparent;
  }

  .hidden-input {
    display: none;
  }

  /* overlays */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(10, 12, 16, 0.32);
    display: flex;
  }
  .overlay.center-top {
    justify-content: center;
    padding-top: 12vh;
  }
  .overlay.center {
    align-items: center;
    justify-content: center;
  }
  .overlay.to-right {
    justify-content: flex-end;
  }
  .popover {
    position: fixed;
    z-index: 70;
    max-width: 280px;
    background: var(--ink);
    color: var(--bg);
    font-size: 12px;
    line-height: 1.4;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-lg);
    pointer-events: none;
  }

  .switcher {
    width: 600px;
    max-width: 92vw;
    max-height: 460px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .sw-input {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 0 16px;
    height: 54px;
    border-bottom: 1px solid var(--line);
  }
  .sw-input input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-size: 15.5px;
    color: var(--ink);
    font-family: var(--ui);
  }
  .sw-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    margin: 0;
    list-style: none;
  }
  .sw-ask,
  .sw-item {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    border: none;
    border-radius: var(--r-md);
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .sw-ask {
    padding: 11px 12px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 14px;
    margin-bottom: 6px;
  }
  .sw-ask span {
    flex: 1;
  }
  .sw-item {
    padding: 9px 12px;
    background: transparent;
    color: var(--ink);
    font-size: 14px;
  }
  .sw-item .mono {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--faint);
  }
  .sw-empty {
    padding: 20px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
  }

  /* compiler side-sheet */
  .sheet {
    width: 460px;
    max-width: 94vw;
    height: 100%;
    background: var(--surface);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
  }
  .sheet-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 20px 14px;
    border-bottom: 1px solid var(--line);
  }
  .sheet-head .accent {
    color: var(--accent);
    display: inline-flex;
  }
  .sheet-head strong {
    font-size: 16px;
  }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 18px 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .step {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .step-h {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 13px;
    font-weight: 700;
    color: var(--ink);
  }
  .step-n {
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--mono);
    font-size: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
  }
  .field input,
  .field select {
    height: 34px;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--surface-alt);
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    padding: 0 10px;
  }
  .pii-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
  }
  .pii-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 9px;
    border-radius: var(--r-pill);
    border: 1px solid var(--line);
    cursor: pointer;
  }
  .pii-chip.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-color: transparent;
  }
  .pii-chip input {
    accent-color: var(--accent);
  }
  .pii-row select {
    height: 30px;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--surface-alt);
    color: var(--ink-2);
    font: inherit;
    font-size: 12.5px;
    padding: 0 6px;
  }
  .remove-box {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 9px 11px;
    border-radius: var(--r-md);
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 12px;
  }
  .remove-pill {
    background: rgba(176, 106, 18, 0.14);
    border-radius: var(--r-pill);
    padding: 1px 8px;
    font-weight: 600;
  }
  .stat-row {
    display: flex;
    gap: 10px;
  }
  .stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--surface-alt);
  }
  .stat strong {
    font-size: 18px;
  }
  .stat strong.over {
    color: var(--warn);
  }
  .payload {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--surface-alt);
    color: var(--ink-2);
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.6;
    padding: 10px 12px;
    resize: vertical;
    outline: none;
  }
  .sheet-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .paste-back summary {
    font-size: 12.5px;
    color: var(--accent);
    cursor: pointer;
  }
  .paste-back textarea {
    width: 100%;
    margin-top: 8px;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--surface-alt);
    color: var(--ink-2);
    font-family: var(--mono);
    font-size: 12px;
    padding: 8px 10px;
    resize: vertical;
    outline: none;
  }
  .paste-refs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .paste-ref {
    font-size: 11.5px;
    border: 1px solid var(--line);
    background: var(--surface);
    border-radius: var(--r-sm);
    padding: 3px 8px;
    cursor: pointer;
    color: var(--accent-ink);
  }
  .paste-ref.broken {
    color: var(--muted);
    cursor: default;
  }

  /* context menu */
  .ctx-backdrop {
    position: fixed;
    inset: 0;
    z-index: 80;
  }
  .ctx-menu {
    position: fixed;
    z-index: 81;
    min-width: 168px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg);
    padding: 5px;
    display: flex;
    flex-direction: column;
  }
  .ctx-item {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    font: inherit;
    font-size: 13px;
    color: var(--ink-2);
    padding: 7px 10px;
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .ctx-item.danger {
    color: var(--error, #b3261e);
  }

  /* model gate */
  .gate {
    width: 460px;
    max-width: 94vw;
    max-height: 86vh;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .gate-head strong {
    font-size: 17px;
  }
  .gate-head p {
    margin: 6px 0 0;
  }
  .gate-auto {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    padding: 12px 14px;
    border-radius: var(--r-md);
    border: 1.5px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .gate-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .gate-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .gate-row.current .gate-pick {
    border-color: var(--accent);
  }
  .gate-pick {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--surface);
    font: inherit;
    cursor: pointer;
  }
  .gate-nm {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--ink);
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .mini-badge {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent-ink);
    background: var(--accent-soft);
    border-radius: var(--r-pill);
    padding: 1px 6px;
  }
  .gate-sz {
    font-size: 12px;
    color: var(--muted);
  }
  .gate-del {
    width: 30px;
    height: 30px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
    background: var(--surface);
    cursor: pointer;
    font-size: 13px;
  }
  .gate-skip {
    margin-top: 4px;
    border: none;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 6px;
  }
  .gate-nowebgpu {
    padding: 12px;
    border-radius: var(--r-md);
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
