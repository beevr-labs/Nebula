<script lang="ts">
  // Nebula workspace — the "Obsidian DNA" surfaces on the REAL RAG pipeline, now with
  // multi-format ingestion: drop PDF/CSV/TXT/MD → intake → Markdown Proxy Note (source
  // backlink, original untouched) → chunk → bge embed → SurrealDB HNSW (indxdb) → retrieve
  // → WebLLM grounded answer. 40/60 resizable split (FR-UI-001); Magic Jump scroll+highlight
  // (FR-CHAT-003); the Weaver auto-wikilinks (FR-LINK-001/002); Micro-Map (FR-GRAPH-001/002);
  // Export Vault → .zip of .md proxies + original binaries under sources/ (FR-DATA-006). In-browser.
  import { onMount, tick } from 'svelte';
  import type { SearchHit } from '$lib/inference/provider';
  import { buildTitleIndex, weaveLinks, notePreview, type WovenSegment } from '$lib/weave/weaver';
  import { buildMicroGraph, type MicroGraph } from '$lib/graph/micrograph';
  import { resolveCitationTarget, buildHighlightSegments } from '$lib/chat/citation';
  import { exportVaultZip } from '$lib/vault/export';
  import { intake } from '$lib/ingest/intake';
  import { csvToMarkdown } from '$lib/ingest/csv';
  import { buildProxyNote, proxyNotePath } from '$lib/ingest/proxy';
  import { createNote, updateNote, validateDraft } from '$lib/vault/note-crud';
  import { serializeNote } from '$lib/vault/note';
  import {
    resolveTarget,
    buildBacklinks,
    findUnlinkedMentions,
    autocompleteWikilink,
    applyWikilinkChoice,
    type AutocompleteState
  } from '$lib/weave/wikilink';
  import { renderMarkdown } from '$lib/render/markdown';
  import { quickSwitch, type SwitchResult } from '$lib/nav/switcher';
  import {
    BUILTIN_TEMPLATES,
    expandTemplate,
    dailyNoteTitle,
    dailyNotePath,
    dailyNoteBody
  } from '$lib/vault/template';
  import { buildFileTree, type TreeNode } from '$lib/nav/tree';
  import { buildTagIndex, notesForTag, coerceTags, extractInlineTags } from '$lib/nav/tags';
  import { scopeDocIds, filterByScope, scopeLabel, type Scope } from '$lib/retrieval/scope';
  import { sourcesFromNotes, sourcesFromHits, parseRedactions } from '$lib/context/sources';
  import { compile } from '$lib/context/compiler';

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

  const SEED: Note[] = [
    {
      docId: 'notes/apollo.md',
      title: 'Apollo',
      aliases: ['Apollo project', 'dashboard', 'export API'],
      text: 'The Apollo project will ship to customers in the third quarter of next year. The release adds a new dashboard and an export API for power users.'
    },
    {
      docId: 'notes/refunds.md',
      title: 'refund policy',
      aliases: ['refund', 'refunds'],
      text: 'Our refund policy lets customers return any product within thirty days of purchase for a full refund, no questions asked.'
    },
    {
      docId: 'notes/security.md',
      title: 'security',
      aliases: ['vault data', 'Context Compiler'],
      text: 'All vault data stays on the local device. Nebula never uploads note content to any server; the Context Compiler is the only path that can export text, and only with consent.'
    },
    {
      docId: 'notes/cats.md',
      title: 'Cats',
      aliases: ['cat'],
      text: 'Cats are small domesticated carnivores. They are entirely unrelated to the product roadmap.'
    }
  ];

  const MODELS = [
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama-3.2-1B (fast)' },
    { id: 'Phi-3-mini-4k-instruct-q4f16_1-MLC', label: 'Phi-3-mini (default)' },
    { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5-0.5B (tiny)' }
  ];

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
  let modelId = $state(MODELS[0].id);
  let query = $state('Does Nebula upload my notes to a server?');
  let answer = $state('');
  let woven = $state<WovenSegment[]>([]);
  let cites = $state<Cite[]>([]);
  let hits = $state<SearchHit[]>([]);
  let graph = $state<MicroGraph | null>(null);
  let activeDoc = $state<string | null>(null);
  let activeSpan = $state<{ charStart: number; charEnd: number } | null>(null);
  let busy = $state(false);
  let ttft = $state(0);
  let tps = $state(0);
  let coi = $state(false);

  // Ingestion UI.
  let importMsg = $state('');
  let dropActive = $state(false);
  let fileInput: HTMLInputElement;

  // Note editor (FR-NOTE-001/003, FR-UI-002) — the left pane's "Write" mode.
  let mode = $state<'ask' | 'write'>('ask');
  let draftTitle = $state('');
  let draftBody = $state('');
  let editingDocId = $state<string | null>(null); // null → creating a new note
  let editMsg = $state('');
  let savingNote = $state(false);
  let bodyEl = $state<HTMLTextAreaElement>();
  let wlState = $state<AutocompleteState | null>(null); // wikilink autocomplete (FR-LINK-003)

  // Quick switcher (FR-NAV-001).
  let switcherOpen = $state(false);
  let switcherQuery = $state('');

  // File tree + tag pane (FR-NAV-002/003).
  let collapsed = $state(new Set<string>());
  let activeTag = $state<string | null>(null);

  // Live Markdown preview (FR-UI-002 · §5.10).
  let previewOn = $state(true);

  // Retrieval scope (FR-RET-004) — restrict Ask + Compile to one client (folder/tag).
  let scope = $state<Scope | null>(null);

  // Context Compiler UI (FR-CTX-*) — compact, token-counted share to another LLM.
  const COMPILE_MODELS = ['gpt-4o', 'gpt-4', 'claude-sonnet', 'claude-opus'];
  let compileOpen = $state(false);
  let compileModel = $state('claude-sonnet');
  let compileRedact = $state('');
  let compileSources = $state<ReturnType<typeof sourcesFromNotes>>([]);
  let compileFrom = $state<'scope' | 'answer'>('scope');

  // 40/60 resizable split (FR-UI-001).
  let leftPct = $state(40);
  let splitEl: HTMLDivElement;
  let dragging = $state(false);
  let preview = $state<{ text: string; x: number; y: number } | null>(null);

  let pipe: {
    embed: (t: string) => Promise<number[]>;
    search: (v: number[], k: number) => Promise<SearchHit[]>;
    relate: (qid: string, hs: SearchHit[]) => Promise<void>;
    ingest: (docId: string, text: string) => Promise<void>;
    removeDoc: (docId: string) => Promise<void>;
    provider: {
      loadModel: (m: string, cb: (p: number) => void) => Promise<void>;
      generate: (
        req: {
          requestId: string;
          query: string;
          context: SearchHit[];
          modelId: string;
          maxTokens: number;
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
  let loadedModel = '';

  onMount(async () => {
    coi = crossOriginIsolated;
    const [
      { chunk },
      { embedBatch, makeBgeTokenCounter, embed },
      { VectorStore },
      { WebLLMProvider },
      { EMBEDDING_DIM }
    ] = await Promise.all([
      import('$lib/ingest/chunker'),
      import('$lib/embed/embedder'),
      import('$lib/db/store'),
      import('$lib/inference/webllm'),
      import('$lib/inference/provider')
    ]);

    status = 'loading embedder…';
    const countTokens = await makeBgeTokenCounter();
    const store = new VectorStore();
    try {
      await store.connect('indxdb://nebula-app', EMBEDDING_DIM);
    } catch {
      await store.connect('mem://', EMBEDDING_DIM);
    }

    const indexNote = async (docId: string, text: string) => {
      const cs = chunk(text, { size: 60, overlap: 12, countTokens });
      const vecs = await embedBatch(cs.map((c) => c.text));
      await store.upsertChunks(
        cs.map((c, i) => ({
          chunkId: `${docId}#${c.seq}`,
          docId,
          text: c.text,
          page: c.page,
          charStart: c.charStart,
          charEnd: c.charEnd,
          embedding: vecs[i]
        }))
      );
    };

    status = 'indexing vault…';
    for (const note of vault) await indexNote(note.docId, note.text);

    const provider = new WebLLMProvider();
    pipe = {
      embed,
      search: (v, k) => store.search(v, k),
      relate: (qid, hs) =>
        store.relateRetrieval(
          qid,
          hs.map((h) => ({ chunkId: h.chunkId, score: h.score }))
        ),
      ingest: indexNote,
      removeDoc: (docId) => store.deleteDoc(docId),
      provider
    };
    status = 'ready';
    ready = true;
  });

  const today = (): string => new Date().toISOString().slice(0, 10);

  // Multi-format ingestion (FR-ING-001/012): drop/pick PDF/CSV/TXT/MD → Markdown Proxy Note.
  async function ingestFiles(list: FileList | null) {
    if (!pipe || !ready || !list || list.length === 0) return;
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
            const { extractPdf } = await import('$lib/ingest/pdf');
            body = (await extractPdf(bytes)).text;
          } catch {
            importMsg = `PDF parsing needs the desktop app — skipped ${file.name}`;
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
        await pipe.ingest(docId, body);
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
        }
        importMsg = `✓ ingested ${docId} (${res.type})`;
        showSource(docId);
      } catch (e) {
        importMsg = `error on ${file.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
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
    draftTitle = '';
    draftBody = '';
    editMsg = '';
    mode = 'write';
  }

  function editNote(note: Note) {
    editingDocId = note.docId;
    draftTitle = String(note.frontmatter?.title ?? note.title ?? '');
    draftBody = note.text;
    editMsg = '';
    mode = 'write';
  }

  async function saveNote() {
    if (!pipe || !ready || savingNote) return;
    const v = validateDraft({ title: draftTitle, body: draftBody });
    if (!v.ok) {
      editMsg = v.reason;
      return;
    }
    savingNote = true;
    editMsg = 'saving…';
    try {
      const nowIso = new Date().toISOString();
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
          body: draftBody,
          now: nowIso
        });
        await pipe.removeDoc(editingDocId); // drop stale chunks before re-indexing the new body
      } else {
        file = await createNote({
          title: draftTitle,
          body: draftBody,
          now: nowIso,
          existingPaths: vault.map((n) => n.docId)
        });
      }
      await pipe.ingest(file.docId, draftBody); // searchable + citable immediately
      const title = String(file.note.frontmatter.title ?? draftTitle);
      vault = [
        ...vault.filter((n) => n.docId !== file.docId && n.docId !== editingDocId),
        {
          docId: file.docId,
          title,
          aliases: [],
          text: draftBody,
          kind: 'note',
          frontmatter: file.note.frontmatter
        }
      ];
      editMsg = `✓ saved ${file.docId}`;
      editingDocId = file.docId;
      mode = 'ask';
      showSource(file.docId);
    } catch (e) {
      editMsg = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      savingNote = false;
    }
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
    vault = [
      ...vault,
      {
        docId: file.docId,
        title: String(file.note.frontmatter.title ?? dailyNoteTitle(nowIso)),
        aliases: [],
        text: body,
        kind: 'note',
        frontmatter: file.note.frontmatter
      }
    ];
    showSource(file.docId);
  }

  async function ask() {
    if (!pipe || busy || !query.trim()) return;
    busy = true;
    answer = '';
    woven = [];
    cites = [];
    graph = null;
    activeDoc = null;
    activeSpan = null;
    try {
      status = 'embedding query…';
      const qv = await pipe.embed(query);
      status = scope ? `retrieving (scoped: ${scopeLabel(scope)})…` : 'retrieving…';
      // Scoped retrieval (FR-RET-004): over-fetch then keep only in-scope hits so a question
      // about one client never pulls another client's notes (no cross-client bleed).
      const raw = await pipe.search(qv, scope ? 24 : 4);
      hits = filterByScope(raw, scopeIds).slice(0, 4);
      // Micro-Map (FR-GRAPH-001) + persist the retrieval sub-graph edges (FR-GRAPH-002).
      graph = buildMicroGraph(query, hits);
      try {
        await pipe.relate('current', hits);
      } catch {
        /* edge persistence is best-effort; the visual graph is built from hits */
      }

      if (loadedModel !== modelId) {
        status = 'loading model…';
        await pipe.provider.loadModel(
          modelId,
          (p) => (status = `loading model ${(p * 100).toFixed(0)}%`)
        );
        loadedModel = modelId;
      }

      status = 'generating…';
      const res = await pipe.provider.generate(
        { requestId: 'q', query, context: hits, modelId, maxTokens: 256 },
        (t) => {
          answer += t;
        },
        new AbortController().signal
      );
      ttft = res.ttftMs;
      tps = Math.round(res.tokensPerSec);
      const order = hits.map((h) => h.chunkId);
      cites = res.citations.map((c) => {
        const docId = order.find((id) => id === c.chunkId) ? c.chunkId.split('#')[0] : c.chunkId;
        const n = order.indexOf(c.chunkId) + 1;
        return { n, chunkId: c.chunkId, docId };
      });
      // The Weaver (FR-LINK-001): wrap note-title mentions in the finished answer as links.
      woven = weaveLinks(answer, titleIndex, { once: true });
      status = 'done';
      await tick();
    } catch (e) {
      status = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  // Magic Jump (FR-CHAT-003): open the cited chunk's document and highlight its exact span.
  function jumpTo(chunkId: string) {
    const target = resolveCitationTarget(chunkId, hits);
    if (!target) return;
    activeDoc = target.docId;
    activeSpan = { charStart: target.charStart, charEnd: target.charEnd };
  }

  function showSource(docId: string) {
    activeDoc = docId;
    activeSpan = null;
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

  // Resizable divider.
  function startDrag(e: PointerEvent) {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDrag(e: PointerEvent) {
    if (!dragging || !splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    leftPct = Math.min(70, Math.max(25, ((e.clientX - rect.left) / rect.width) * 100));
  }
  function endDrag() {
    dragging = false;
  }
  function dividerKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') leftPct = Math.max(25, leftPct - 2);
    if (e.key === 'ArrowRight') leftPct = Math.min(70, leftPct + 2);
  }

  const activeNote = $derived(activeDoc ? vault.find((n) => n.docId === activeDoc) : undefined);
  const activeBacklinks = $derived(activeDoc ? (backlinks.get(activeDoc) ?? []) : []);
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
    const a = (e.target as HTMLElement | null)?.closest?.('a.wikilink') as HTMLElement | null;
    if (a?.dataset.doc) {
      e.preventDefault();
      showSource(a.dataset.doc);
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
  const fileTree = $derived<TreeNode[]>(buildFileTree(vault.map((n) => n.docId)));
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
  const compileResult = $derived(
    compileOpen && compileSources.length
      ? compile({
          sources: compileSources,
          targetModel: compileModel,
          redactions: parseRedactions(compileRedact)
        })
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
    compileSources = sourcesFromHits(
      hits.map((h) => ({ chunkId: h.chunkId, docId: h.docId, text: h.text, page: h.page })),
      hashOfDoc
    );
    compileFrom = 'answer';
    compileOpen = true;
  }
  async function copyCompiled() {
    if (compileResult) await navigator.clipboard.writeText(compileResult.xml);
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
    }
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

<main class="shell">
  <header class="topbar">
    <span class="brand">✦ Nebula</span>
    <span class="tag">local-first RAG · Obsidian DNA</span>
    <button class="eject" onclick={openSwitcher} title="Quick switch to a note (Ctrl/⌘+K)">
      ⌘K Switch
    </button>
    <button
      class="eject"
      onclick={exportVault}
      title="Export the vault as a portable .zip — .md proxies + original binaries (FR-DATA-006)"
    >
      ⤓ Export Vault
    </button>
    <span class="status">{status}{ready && ttft ? ` · TTFT ${ttft}ms · ${tps} tok/s` : ''}</span>
    <span class="coi" class:ok={coi}>{coi ? 'isolated ✓' : 'not isolated'}</span>
  </header>

  <div class="split" bind:this={splitEl}>
    <!-- LEFT (40%) — the Active/Command zone: chat + Micro-Map -->
    <section class="pane chat" style="width: {leftPct}%" aria-label="Chat">
      <div class="modes" role="tablist" aria-label="Left pane mode">
        <button
          class="modetab"
          class:active={mode === 'ask'}
          role="tab"
          aria-selected={mode === 'ask'}
          onclick={() => (mode = 'ask')}>Ask</button
        >
        <button
          class="modetab"
          class:active={mode === 'write'}
          role="tab"
          aria-selected={mode === 'write'}
          onclick={() => (mode = 'write')}>✎ Write</button
        >
      </div>

      {#if mode === 'ask'}
        <div class="controls">
          <select bind:value={modelId} disabled={busy}>
            {#each MODELS as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
          </select>
          <select
            class="scope-select"
            value={scope
              ? scope.kind === 'folder'
                ? `folder:${scope.value}`
                : `tag:${scope.value}`
              : ''}
            disabled={busy}
            title="Restrict Ask + Compile to one client (folder or tag) — no cross-client bleed"
            onchange={(e) => setScope(e.currentTarget.value)}
          >
            <option value="">🎯 Whole vault</option>
            {#if folderScopes.length}
              <optgroup label="Folders">
                {#each folderScopes as f (f)}<option value={`folder:${f}`}>📁 {f}</option>{/each}
              </optgroup>
            {/if}
            {#if tagIndex.length}
              <optgroup label="Tags">
                {#each tagIndex as t (t.tag)}<option value={`tag:${t.tag}`}>#{t.tag}</option>{/each}
              </optgroup>
            {/if}
          </select>
        </div>

        <textarea bind:value={query} rows="2" placeholder="Ask a question…" disabled={busy}
        ></textarea>
        <div class="ask-row">
          <button class="ask" onclick={ask} disabled={!ready || busy}
            >{busy ? 'Working…' : 'Ask'}</button
          >
          <button
            class="ghost"
            onclick={openCompileFromScope}
            disabled={!ready}
            title="Compile {scope
              ? scopeLabel(scope)
              : 'the whole vault'} into a compact, token-counted payload for another LLM (GPT/Claude)"
            >📦 Compile {scope ? 'scope' : 'vault'}</button
          >
        </div>

        {#if hits.length}
          <div class="sources">
            <div class="block-h">Retrieved sources</div>
            {#each hits as h, i (h.chunkId)}
              <button class="src" onclick={() => jumpTo(h.chunkId)}>
                <span class="src-n">[#{i + 1}]</span>
                {h.docId} <span class="score">{h.score.toFixed(2)}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if graph}
          <div class="micromap">
            <div class="block-h">Micro-Map · how the AI answered</div>
            <svg
              width="100%"
              height={40 + graph.nodes.filter((n) => n.kind === 'chunk').length * 30}
              class="graph"
            >
              {#each graph.edges as e, i (e.to)}
                {@const cy = 30 + i * 30}
                <line
                  x1="78"
                  y1="24"
                  x2="76%"
                  y2={cy}
                  stroke="#6750a4"
                  stroke-width={e.width}
                  stroke-opacity="0.55"
                />
              {/each}
              <circle cx="40" cy="24" r="9" fill="#6750a4" />
              <text x="40" y="44" text-anchor="middle" class="g-label">query</text>
              {#each graph.nodes.filter((n) => n.kind === 'chunk') as n, i (n.id)}
                {@const cy = 30 + i * 30}
                <circle cx="76%" {cy} r="6" fill="#efeaf8" stroke="#6750a4" />
                <text x="80%" y={cy + 4} class="g-label">{n.label} · {n.score}</text>
              {/each}
            </svg>
          </div>
        {/if}

        {#if answer}
          <div class="answer">
            <div class="block-h">Answer</div>
            {#if woven.length}
              <p>
                {#each woven as seg, i (i)}
                  {@const link = seg.link}
                  {#if link}
                    <button
                      class="wikilink"
                      onclick={() => showSource(link.docId)}
                      onmouseenter={(e) => showPreview(e, link.docId)}
                      onmouseleave={hidePreview}>{seg.text}</button
                    >
                  {:else}{seg.text}{/if}
                {/each}
              </p>
            {:else}
              <p>{answer}</p>
            {/if}
            {#if cites.length}
              <div class="cites">
                cited:
                {#each cites as c (c.chunkId)}
                  <button class="chip" onclick={() => jumpTo(c.chunkId)}>[#{c.n}] {c.docId}</button>
                {/each}
              </div>
            {/if}
            {#if hits.length}
              <button
                class="ghost compile-ctx"
                onclick={openCompileFromHits}
                title="Compile just the retrieved context (the relevant ~5%) for another LLM"
                >📦 Compile this context →</button
              >
            {/if}
          </div>
        {/if}
      {:else}
        <div class="editor">
          <div class="editor-top">
            <input
              class="title-input"
              bind:value={draftTitle}
              placeholder="Note title"
              disabled={savingNote}
            />
            <select
              class="tpl-select"
              disabled={savingNote}
              title="Insert a template"
              onchange={(e) => {
                const el = e.currentTarget;
                applyTemplate(el.value);
                el.selectedIndex = 0;
              }}
            >
              <option value="">Template ▾</option>
              {#each BUILTIN_TEMPLATES as t (t.id)}
                <option value={t.id}>{t.label}</option>
              {/each}
            </select>
          </div>
          <div class="body-wrap">
            <textarea
              class="body-input"
              bind:this={bodyEl}
              bind:value={draftBody}
              rows="14"
              placeholder="Write your note in Markdown… type [[ to link a note"
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
                      class="wl-item"
                      onmousedown={(e) => e.preventDefault()}
                      onclick={() => pickWikilink(s.title)}
                    >
                      <span class="wl-title">{s.title}</span>
                      <span class="wl-doc">{s.docId}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          {#if previewOn && draftBody.trim()}
            <div class="block-h">Preview</div>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <article
              class="doc rendered editor-preview"
              onclick={onRenderedClick}
              onkeydown={(e) => e.key === 'Enter' && onRenderedClick(e as unknown as MouseEvent)}
              role="document"
            >
              {@html renderMarkdown(draftBody, { resolveLink: resolveNoteLink })}
            </article>
          {/if}
          <div class="editor-actions">
            <button class="ask" onclick={saveNote} disabled={!ready || savingNote}>
              {savingNote ? 'Saving…' : editingDocId ? 'Save changes' : 'Save note'}
            </button>
            <button class="ghost" onclick={startNewNote} disabled={savingNote}>＋ New</button>
            <button
              class="ghost"
              onclick={() => (previewOn = !previewOn)}
              title="Toggle live Markdown preview">👁 {previewOn ? 'Hide' : 'Preview'}</button
            >
            {#if editMsg}<span class="editmsg">{editMsg}</span>{/if}
          </div>
          <p class="editor-hint">
            Saved as a portable <code>.md</code> in <code>notes/</code> — instantly searchable, citable,
            and exportable to any LLM via Export Vault / the Context Compiler.
          </p>
        </div>
      {/if}
    </section>

    <!-- Window-splitter: an intentionally interactive separator (pointer drag + arrow keys). -->
    <button
      class="divider"
      class:dragging
      onpointerdown={startDrag}
      onpointermove={onDrag}
      onpointerup={endDrag}
      onkeydown={dividerKey}
      aria-label="Resize panes (arrow keys)"
    ></button>

    <!-- RIGHT (60%) — the Reference zone: document viewer / vault / drop target -->
    <section
      class="pane viewer"
      class:drop={dropActive}
      aria-label="Document viewer and ingestion drop zone"
      ondragover={(e) => {
        e.preventDefault();
        dropActive = true;
      }}
      ondragleave={() => (dropActive = false)}
      ondrop={onDrop}
    >
      <div class="toolbar">
        <button class="addfiles newnote" onclick={startNewNote} disabled={!ready}>
          ✎ New note
        </button>
        <button class="addfiles newnote" onclick={openDailyNote} disabled={!ready}>
          📅 Today
        </button>
        <button class="addfiles" onclick={() => fileInput?.click()} disabled={!ready}>
          ＋ Add files
        </button>
        <span class="hint">Write a note · or drop PDF · CSV · TXT · MD anywhere here</span>
        {#if importMsg}<span class="importmsg">{importMsg}</span>{/if}
      </div>
      <input
        class="hidden-input"
        type="file"
        multiple
        accept=".pdf,.csv,.txt,.md,.markdown,.text"
        bind:this={fileInput}
        onchange={(e) => ingestFiles((e.currentTarget as HTMLInputElement).files)}
      />

      {#if activeNote}
        <div class="block-h">
          {activeNote.docId}{activeSpan ? ' · cited span highlighted' : ''}
          {#if activeNote.kind}<span class="badge">{activeNote.kind}</span>{/if}
          {#if !activeNote.sourcePath}
            <button class="back edit" onclick={() => editNote(activeNote)}>✎ Edit</button>
          {/if}
          <button class="back" onclick={() => (activeDoc = null)}>✕ vault</button>
        </div>
        {#if activeNote.sourcePath}
          <div class="source-link">
            📎 source: {activeNote.sourcePath} — original preserved, never edited
          </div>
        {/if}
        {#if activeSpan}
          {@const seg = buildHighlightSegments(
            activeNote.text,
            activeSpan.charStart,
            activeSpan.charEnd
          )}
          <article class="doc">{seg.pre}<mark>{seg.hit}</mark>{seg.post}</article>
        {:else}
          <!-- Rendered Markdown preview (FR-UI-002). Output is escape-first/safe (ADR-016);
               wikilink clicks/keys are delegated to vault navigation. -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <article
            class="doc rendered"
            onclick={onRenderedClick}
            onkeydown={(e) => e.key === 'Enter' && onRenderedClick(e as unknown as MouseEvent)}
            role="document"
          >
            {@html renderMarkdown(activeNote.text, { resolveLink: resolveNoteLink })}
          </article>
        {/if}

        {#if activeBacklinks.length || activeUnlinked.length}
          <div class="links-panel">
            {#if activeBacklinks.length}
              <div class="block-h">🔗 Backlinks — {activeBacklinks.length}</div>
              {#each activeBacklinks as bl (bl.docId)}
                <button class="src" onclick={() => showSource(bl.docId)}>
                  {bl.title}
                  <span class="score">{bl.count > 1 ? `×${bl.count}` : ''} {bl.docId}</span>
                </button>
              {/each}
            {/if}
            {#if activeUnlinked.length}
              <div class="block-h">💭 Unlinked mentions — {activeUnlinked.length}</div>
              {#each activeUnlinked as um (um.docId)}
                <button class="src" onclick={() => showSource(um.docId)}>
                  <span class="src-n">{um.title}</span>
                  <span class="um-snippet">{um.snippet}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      {:else}
        {#if tagIndex.length}
          <div class="block-h">🏷 Tags</div>
          <div class="tagbar">
            {#each tagIndex as t (t.tag)}
              <button
                class="tagchip"
                class:active={activeTag === t.tag}
                onclick={() => toggleTag(t.tag)}
                >#{t.tag} <span class="tagcount">{t.count}</span></button
              >
            {/each}
          </div>
        {/if}

        {#if activeTag}
          <div class="block-h">
            Tagged #{activeTag} — {filteredNotes.length}
            <button class="back" onclick={() => (activeTag = null)}>✕ clear</button>
          </div>
          {#each filteredNotes as note (note.docId)}
            <button class="note" onclick={() => showSource(note.docId)}>
              <div class="note-title">
                {note.docId}
                {#if note.kind}<span class="badge">{note.kind}</span>{/if}
              </div>
              <div class="note-body">{note.text}</div>
            </button>
          {/each}
        {:else}
          <div class="block-h">📁 Vault — {vault.length} notes</div>
          {@render treeView(fileTree)}
        {/if}
      {/if}
    </section>
  </div>

  {#snippet treeView(nodes: TreeNode[])}
    {#each nodes as node (node.path)}
      {#if node.kind === 'folder'}
        <button class="tree-folder" onclick={() => toggleFolder(node.path)}>
          <span class="tree-caret">{collapsed.has(node.path) ? '▸' : '▾'}</span>📁 {node.name}
        </button>
        {#if !collapsed.has(node.path)}
          <div class="tree-children">{@render treeView(node.children)}</div>
        {/if}
      {:else}
        {@const kind = vault.find((n) => n.docId === node.docId)?.kind}
        <button class="tree-file" onclick={() => node.docId && showSource(node.docId)}>
          📄 {node.name}{#if kind}<span class="badge">{kind}</span>{/if}
        </button>
      {/if}
    {/each}
  {/snippet}

  {#if preview}
    <div class="popover" style="left: {preview.x}px; top: {preview.y}px">{preview.text}</div>
  {/if}

  {#if switcherOpen}
    <!-- Quick switcher (FR-NAV-001) -->
    <div
      class="switcher-overlay"
      role="button"
      tabindex="-1"
      aria-label="Close switcher"
      onclick={() => (switcherOpen = false)}
      onkeydown={(e) => e.key === 'Enter' && (switcherOpen = false)}
    >
      <div
        class="switcher"
        role="dialog"
        tabindex="-1"
        aria-label="Quick switcher"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          if (e.key === 'Enter' && switcherResults[0]) chooseSwitch(switcherResults[0].docId);
        }}
      >
        <input
          id="switcher-input"
          class="switcher-input"
          bind:value={switcherQuery}
          placeholder="Jump to a note…"
          autocomplete="off"
        />
        <ul class="switcher-list">
          {#each switcherResults as r (r.docId)}
            <li>
              <button class="switcher-item" onclick={() => chooseSwitch(r.docId)}>
                <span class="wl-title">{r.title}</span>
                <span class="wl-doc">{r.docId}</span>
              </button>
            </li>
          {:else}
            <li class="switcher-empty">No matching notes</li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if compileOpen}
    <!-- Context Compiler (FR-CTX-*): compact, token-counted share to another LLM. -->
    <div
      class="switcher-overlay"
      role="button"
      tabindex="-1"
      aria-label="Close compiler"
      onclick={() => (compileOpen = false)}
      onkeydown={(e) => e.key === 'Escape' && (compileOpen = false)}
    >
      <div
        class="compiler"
        role="dialog"
        tabindex="-1"
        aria-label="Context Compiler"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (compileOpen = false)}
      >
        <div class="compiler-head">
          <strong>📦 Share to another LLM</strong>
          <span class="compiler-sub"
            >{compileFrom === 'answer' ? 'retrieved context' : 'scope'}: {compileSources.length} source(s){scope
              ? ` · ${scopeLabel(scope)}`
              : ''}</span
          >
          <button class="back" onclick={() => (compileOpen = false)}>✕</button>
        </div>
        <div class="compiler-controls">
          <label>
            Target model
            <select bind:value={compileModel}>
              {#each COMPILE_MODELS as m (m)}<option value={m}>{m}</option>{/each}
            </select>
          </label>
          <label class="redact">
            Redact (comma-separated)
            <input bind:value={compileRedact} placeholder="Acme, John Doe, 555-…" />
          </label>
        </div>
        {#if compileResult}
          <div class="compiler-meta">
            ~<strong>{compileResult.manifest.tokenCount}</strong> tokens · tokenizer
            {compileResult.manifest.tokenizer} ·
            <span class="consent"
              >⚠ {compileSources.length} source(s) will leave the device when you copy/paste</span
            >
          </div>
          <textarea class="compiler-xml" readonly rows="14" value={compileResult.xml}></textarea>
          <div class="compiler-actions">
            <button class="ask" onclick={copyCompiled}>⧉ Copy</button>
            <button class="ghost" onclick={downloadCompiled}>⤓ Download .xml</button>
          </div>
        {:else}
          <div class="compiler-meta">Nothing to compile.</div>
        {/if}
      </div>
    </div>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
  }
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: system-ui, sans-serif;
    color: #1c1c22;
    background: #fafafb;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.55rem 1rem;
    border-bottom: 1px solid #e4e4ea;
    background: #fff;
  }
  .brand {
    font-weight: 700;
    color: #6750a4;
  }
  .tag {
    font-size: 0.75rem;
    color: #8a8a90;
  }
  .eject {
    font: inherit;
    font-size: 0.76rem;
    cursor: pointer;
    background: #efeaf8;
    color: #6750a4;
    border: 1px solid #d9cef2;
    border-radius: 7px;
    padding: 0.2rem 0.55rem;
  }
  .status {
    margin-left: auto;
    font-size: 0.8rem;
    color: #6a6a72;
  }
  .coi {
    font-size: 0.72rem;
    color: #b00020;
    border: 1px solid currentColor;
    border-radius: 6px;
    padding: 1px 6px;
  }
  .coi.ok {
    color: #1a7f37;
  }
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pane {
    overflow: auto;
    padding: 1rem 1.1rem;
  }
  .viewer {
    flex: 1;
    background: #fff;
  }
  .viewer.drop {
    outline: 2px dashed #6750a4;
    outline-offset: -8px;
    background: #faf8ff;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.7rem;
    flex-wrap: wrap;
  }
  .addfiles {
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    background: #6750a4;
    color: #fff;
    border: 0;
    border-radius: 7px;
    padding: 0.25rem 0.7rem;
  }
  .addfiles:disabled {
    opacity: 0.5;
  }
  .hint {
    font-size: 0.74rem;
    color: #9a9aa2;
  }
  .importmsg {
    font-size: 0.74rem;
    color: #1a7f37;
    margin-left: auto;
  }
  .hidden-input {
    display: none;
  }
  .source-link {
    font-size: 0.76rem;
    color: #6750a4;
    background: #f5f2fd;
    border: 1px solid #e7e0f8;
    border-radius: 7px;
    padding: 0.3rem 0.5rem;
    margin-bottom: 0.6rem;
  }
  .badge {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: #efeaf8;
    color: #6750a4;
    border-radius: 5px;
    padding: 0 5px;
    margin-left: 4px;
  }
  .divider {
    width: 6px;
    padding: 0;
    border: 0;
    cursor: col-resize;
    background: #e4e4ea;
    flex: 0 0 auto;
  }
  .divider.dragging,
  .divider:hover {
    background: #c9c2e6;
  }
  .divider:focus-visible {
    outline: 2px solid #6750a4;
  }
  .block-h {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9a9aa2;
    margin-bottom: 0.3rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .back {
    margin-left: auto;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
    border: 0;
    background: #f0f0f4;
    border-radius: 6px;
    padding: 0.1rem 0.4rem;
    color: #6a6a72;
  }
  .note {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border: 1px solid #e8e8ee;
    border-radius: 10px;
    padding: 0.6rem 0.7rem;
    margin-bottom: 0.6rem;
    background: #fff;
  }
  .note:hover {
    border-color: #6750a4;
  }
  .note-title {
    font-weight: 600;
    font-size: 0.82rem;
    color: #444;
  }
  .note-body {
    font-size: 0.82rem;
    color: #555;
    margin-top: 0.25rem;
    overflow: hidden;
    max-height: 3rem;
  }
  .doc {
    font-size: 0.9rem;
    line-height: 1.6;
    white-space: pre-wrap;
    color: #2a2a30;
  }
  mark {
    background: #fff3a3;
    border-radius: 3px;
    padding: 0 2px;
  }
  .doc.rendered {
    white-space: normal;
  }
  .doc.rendered :global(h1),
  .doc.rendered :global(h2),
  .doc.rendered :global(h3) {
    line-height: 1.25;
    margin: 0.8rem 0 0.4rem;
  }
  .doc.rendered :global(h1) {
    font-size: 1.4rem;
  }
  .doc.rendered :global(h2) {
    font-size: 1.2rem;
  }
  .doc.rendered :global(h3) {
    font-size: 1.05rem;
  }
  .doc.rendered :global(p) {
    margin: 0.5rem 0;
  }
  .doc.rendered :global(ul),
  .doc.rendered :global(ol) {
    margin: 0.4rem 0;
    padding-left: 1.4rem;
  }
  .doc.rendered :global(li) {
    margin: 0.15rem 0;
  }
  .doc.rendered :global(code) {
    background: #f2f2f6;
    border-radius: 4px;
    padding: 0 4px;
    font-size: 0.86em;
  }
  .doc.rendered :global(pre) {
    background: #1c1c22;
    color: #f3f3f6;
    border-radius: 8px;
    padding: 0.7rem 0.85rem;
    overflow: auto;
  }
  .doc.rendered :global(pre code) {
    background: none;
    color: inherit;
    padding: 0;
  }
  .doc.rendered :global(blockquote) {
    margin: 0.5rem 0;
    padding: 0.1rem 0.8rem;
    border-left: 3px solid #d9cef2;
    color: #5a5a62;
  }
  .doc.rendered :global(hr) {
    border: 0;
    border-top: 1px solid #e4e4ea;
    margin: 0.9rem 0;
  }
  .doc.rendered :global(table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
    font-size: 0.85rem;
  }
  .doc.rendered :global(th),
  .doc.rendered :global(td) {
    border: 1px solid #e4e4ea;
    padding: 0.3rem 0.55rem;
    text-align: left;
  }
  .doc.rendered :global(th) {
    background: #f6f4fc;
  }
  .doc.rendered :global(a.wikilink) {
    color: #6750a4;
    text-decoration: underline dotted;
    cursor: pointer;
  }
  .doc.rendered :global(a) {
    color: #6750a4;
  }
  .doc.rendered :global(.broken-link) {
    color: #b00020;
    text-decoration: underline dotted;
  }
  .doc.rendered :global(input[type='checkbox']) {
    margin-right: 0.3rem;
  }
  .editor-preview {
    border: 1px solid #ececf2;
    border-radius: 8px;
    padding: 0.4rem 0.7rem;
    background: #fcfcfe;
    max-height: 40vh;
    overflow: auto;
  }
  .controls {
    margin-bottom: 0.5rem;
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .scope-select {
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.3rem 0.4rem;
    font-size: 0.8rem;
    color: #6750a4;
    background: #fff;
    cursor: pointer;
    max-width: 100%;
  }
  .ask-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .compile-ctx {
    margin-top: 0.7rem;
  }
  .compiler {
    width: min(720px, 94vw);
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 12px 48px #0004;
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .compiler-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .compiler-sub {
    font-size: 0.76rem;
    color: #8a8a90;
  }
  .compiler-head .back {
    margin-left: auto;
  }
  .compiler-controls {
    display: flex;
    gap: 0.8rem;
    flex-wrap: wrap;
    font-size: 0.76rem;
    color: #6a6a72;
  }
  .compiler-controls label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .compiler-controls .redact {
    flex: 1;
    min-width: 180px;
  }
  .compiler-controls select,
  .compiler-controls input {
    border: 1px solid #d8d8e0;
    border-radius: 7px;
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.82rem;
  }
  .compiler-meta {
    font-size: 0.78rem;
    color: #5a5a62;
  }
  .consent {
    color: #9a5a00;
  }
  .compiler-xml {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #e4e4ea;
    border-radius: 8px;
    padding: 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.76rem;
    line-height: 1.45;
    background: #fbfbfd;
    resize: vertical;
  }
  .compiler-actions {
    display: flex;
    gap: 0.5rem;
  }
  select,
  textarea,
  button {
    font: inherit;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.5rem;
    resize: vertical;
  }
  .ask {
    margin-top: 0.5rem;
    cursor: pointer;
    background: #6750a4;
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 0.5rem 1rem;
  }
  .ask:disabled {
    opacity: 0.5;
  }
  .sources,
  .micromap,
  .answer {
    margin-top: 1rem;
  }
  .src {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 8px;
    padding: 0.35rem 0.5rem;
    margin-bottom: 0.3rem;
    font-size: 0.8rem;
  }
  .src:hover {
    border-color: #6750a4;
  }
  .src-n {
    color: #6750a4;
    font-weight: 600;
  }
  .score {
    float: right;
    color: #9a9aa2;
  }
  .graph {
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 10px;
  }
  .g-label {
    font-size: 9px;
    fill: #6a6a72;
  }
  .answer {
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 12px;
    padding: 0.8rem 0.9rem;
  }
  .answer p {
    margin: 0;
    line-height: 1.5;
  }
  .wikilink {
    cursor: pointer;
    border: 0;
    background: none;
    padding: 0;
    color: #6750a4;
    font: inherit;
    text-decoration: underline dotted;
  }
  .cites {
    margin-top: 0.6rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    font-size: 0.78rem;
    color: #8a8a90;
  }
  .chip {
    cursor: pointer;
    background: #efeaf8;
    color: #6750a4;
    border: 0;
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
    font-size: 0.76rem;
  }
  .modes {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 0.7rem;
  }
  .modetab {
    cursor: pointer;
    font-size: 0.78rem;
    border: 1px solid #e0e0e8;
    background: #fff;
    color: #6a6a72;
    border-radius: 7px;
    padding: 0.25rem 0.7rem;
  }
  .modetab.active {
    background: #efeaf8;
    color: #6750a4;
    border-color: #d9cef2;
    font-weight: 600;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .editor-top {
    display: flex;
    gap: 0.4rem;
  }
  .title-input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
    font-size: 1rem;
    font-weight: 600;
  }
  .tpl-select {
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0 0.4rem;
    font-size: 0.78rem;
    color: #6750a4;
    background: #fff;
    cursor: pointer;
  }
  .body-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.6rem;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.86rem;
    line-height: 1.5;
  }
  .editor-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .ghost {
    cursor: pointer;
    font-size: 0.8rem;
    background: #f0f0f4;
    color: #6a6a72;
    border: 0;
    border-radius: 8px;
    padding: 0.5rem 0.8rem;
  }
  .editmsg {
    font-size: 0.76rem;
    color: #1a7f37;
  }
  .editor-hint {
    margin: 0.2rem 0 0;
    font-size: 0.74rem;
    color: #9a9aa2;
    line-height: 1.4;
  }
  .editor-hint code {
    background: #f2f2f6;
    border-radius: 4px;
    padding: 0 4px;
  }
  .newnote {
    background: #efeaf8;
    color: #6750a4;
    border: 1px solid #d9cef2;
  }
  .back.edit {
    margin-left: auto;
    color: #6750a4;
    background: #efeaf8;
  }
  .back.edit + .back {
    margin-left: 0.4rem;
  }
  .body-wrap {
    position: relative;
  }
  .wl-menu {
    position: absolute;
    left: 0.6rem;
    right: 0.6rem;
    top: 100%;
    margin: -0.3rem 0 0;
    padding: 0.2rem;
    list-style: none;
    background: #fff;
    border: 1px solid #d9cef2;
    border-radius: 8px;
    box-shadow: 0 6px 20px #0002;
    z-index: 8;
    max-height: 220px;
    overflow: auto;
  }
  .wl-item,
  .switcher-item {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border: 0;
    background: none;
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
  .wl-item:hover,
  .switcher-item:hover {
    background: #efeaf8;
  }
  .wl-title {
    font-size: 0.84rem;
    font-weight: 600;
    color: #2a2a30;
  }
  .wl-doc {
    font-size: 0.7rem;
    color: #9a9aa2;
  }
  .tagbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.9rem;
  }
  .tagchip {
    cursor: pointer;
    font-size: 0.74rem;
    background: #f3f1fa;
    color: #6750a4;
    border: 1px solid #e7e0f8;
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
  }
  .tagchip.active {
    background: #6750a4;
    color: #fff;
    border-color: #6750a4;
  }
  .tagcount {
    opacity: 0.6;
    font-size: 0.68rem;
  }
  .tree-folder,
  .tree-file {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border: 0;
    background: none;
    border-radius: 6px;
    padding: 0.22rem 0.4rem;
    font-size: 0.82rem;
    color: #2a2a30;
  }
  .tree-folder {
    font-weight: 600;
  }
  .tree-folder:hover,
  .tree-file:hover {
    background: #efeaf8;
  }
  .tree-caret {
    display: inline-block;
    width: 0.9rem;
    color: #9a9aa2;
  }
  .tree-children {
    margin-left: 0.8rem;
    border-left: 1px solid #ececf2;
    padding-left: 0.3rem;
  }
  .links-panel {
    margin-top: 1rem;
    border-top: 1px solid #ececf2;
    padding-top: 0.7rem;
  }
  .um-snippet {
    display: block;
    font-size: 0.74rem;
    color: #8a8a90;
    margin-top: 0.1rem;
  }
  .switcher-overlay {
    position: fixed;
    inset: 0;
    background: #0006;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    z-index: 20;
  }
  .switcher {
    width: min(560px, 92vw);
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 12px 48px #0004;
    overflow: hidden;
  }
  .switcher-input {
    width: 100%;
    box-sizing: border-box;
    border: 0;
    border-bottom: 1px solid #ececf2;
    padding: 0.8rem 1rem;
    font-size: 1rem;
    outline: none;
  }
  .switcher-list {
    list-style: none;
    margin: 0;
    padding: 0.3rem;
    max-height: 50vh;
    overflow: auto;
  }
  .switcher-empty {
    padding: 0.7rem 1rem;
    color: #9a9aa2;
    font-size: 0.84rem;
  }
  .popover {
    position: fixed;
    max-width: 280px;
    background: #1c1c22;
    color: #f3f3f6;
    font-size: 0.76rem;
    line-height: 1.4;
    padding: 0.4rem 0.55rem;
    border-radius: 8px;
    pointer-events: none;
    z-index: 10;
    box-shadow: 0 4px 16px #0003;
  }
</style>
