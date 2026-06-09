# Nebula

> **Notes that think. Nothing leaves your device.**

[![Deploy to GitHub Pages](https://github.com/thienzz/Nebula/actions/workflows/deploy.yml/badge.svg)](https://github.com/thienzz/Nebula/actions/workflows/deploy.yml)
[![Live demo](https://img.shields.io/badge/%E2%96%B6_live_demo-thienzz.github.io%2FNebula-7c5cff)](https://thienzz.github.io/Nebula/)
[![tests](https://img.shields.io/badge/tests-334_passing-3fb950)](#tests)
[![backend](https://img.shields.io/badge/backend-none-555)](#architecture)

**▶ Try it live — [thienzz.github.io/Nebula](https://thienzz.github.io/Nebula/)** · no install, no account, nothing leaves your browser. The first visit seeds a demo **"Aurora deal war-room"** vault (the [walkthrough below](#-a-deal-war-room--from-scattered-notes-to-a-winning-play)) you can build a knowledge graph over and query offline. *Chat needs a WebGPU browser (Chrome/Edge/Arc, Safari 18+); semantic search works everywhere.*

Nebula is a private AI knowledge base that runs **entirely in your browser**. Your notes,
the vector database, the embedding model, and the chat LLM all live in your browser's own storage and run on
**your** GPU — **zero servers, zero telemetry, zero external calls by default.** No account, no upload, no
cloud bill. And every note is just a plain `.md` file: one click exports the whole vault as portable
Markdown — yours to take anywhere — so nothing is ever held hostage.

**Two products in one browser tab:**

- 🧠 **The Vault** — write Markdown and hold a *grounded, cited* conversation with your own knowledge, fully
  offline: semantic search, an on-device chat LLM, an entity **knowledge graph + GraphRAG**, and a full
  note-taking layer (wikilinks, backlinks, ⌘K quick switcher, daily notes, templates).
- 🎯 **The Context Engine** — when you *do* want a frontier model, Nebula surfaces the most relevant ~5% of
  your notes and compiles it into a **token-counted, redactable** block to paste into Claude/GPT. The big
  model gets concentrated signal, not your whole folder — and you choose exactly what leaves the device.

> A working build — SvelteKit 5 + WASM (SurrealDB + Transformers.js) + WebGPU (WebLLM), **no
> backend** — verified end-to-end on real hardware.

## Status — verified on real hardware (not just mocks)

The full RAG pipeline runs end-to-end **in a real Chrome tab** on a real GPU — no backend involved:

- **Embeddings** — real **`bge-m3`** (1024-dim, multilingual incl. Vietnamese) via `@huggingface/transformers` (WASM/CPU, in a Web Worker — ADR-021/023).
- **Vector store** — real **SurrealDB HNSW** cosine index (`@surrealdb/wasm`); `mem://` in Node, **`indxdb://` persistence in the browser (GATE D)**.
- **PDF** — real text + per-page offsets via `pdfjs-dist`.
- **WebGPU chat** — real `@mlc-ai/web-llm`: a curated **14-model picker** (0.5B → a 70B flagship), tiny/fast to large/accurate, each with its VRAM footprint + a large-download guard; UI default **Llama-3.2-1B**, recommended **Qwen2.5-3B** (multilingual), with `crossOriginIsolated === true` (**GATE A**).
- **Entity graph + GraphRAG** — LLM-extracted entities/relations persisted as SurrealDB edges; retrieval fuses vector seeds with graph-connected sibling chunks (RRF), incremental via a content hash.
- **Answer modes** — **Grounded** (default — strict, notes-only, every claim cited and verifiable) and **Reason** (reason *with* the notes and apply general knowledge, still citing what came from the vault), each grounded + cited.
- **Grounded + cited** — e.g. *"The main risk to closing Aurora is that Priya, Northwind's CFO, hasn't approved the budget. [#1]"* with `[#1]` mapped (and click-through) to its source chunk.

## Screenshots

Every shot below is the same **Aurora deal war-room** vault the [live demo](https://thienzz.github.io/Nebula/) seeds — one consistent, real-world scenario end to end.

| | |
|:--|:--|
| <img src="screenshots/vault-tree.png" alt="The vault — five scattered Aurora deal notes in a file tree"><br>**The vault** — five scattered `.md` deal notes (status, budget, competition, POC, champion). | <img src="screenshots/deal-warroom-answer.png" alt="Grounded answer with inline citations to the deal notes"><br>**Ask + GraphRAG** — *"How do we win the Northwind deal?"* → a cited plan synthesised across notes a keyword search would miss. |
| <img src="screenshots/entity-graph.png" alt="Entity knowledge graph of the deal — people, company, competitor and how they connect"><br>**Knowledge graph** — entities + how they connect (*Priya controls Aurora's budget*, *Sam champions Aurora*, *Helix competes*). | <img src="screenshots/context-compiler.png" alt="Context Compiler dialog with token count, PII scrub and an XML payload"><br>**Context Engine** — compile the relevant slice into a token-counted, redactable block to paste into Claude/GPT. |

## What you can do with it

Drop a folder of notes and Nebula turns it into a **queryable knowledge graph** you can reason over — offline, in the browser.

### 🧠 A "company brain" your team can interrogate

Point it at your org's notes — people, projects, clients, incidents, decisions — and click **✨ build graph**. The on-device LLM reads every note and extracts the entities **and how they connect**. On a 16-note test vault it pulled out **29 entities** (people, projects, clients, products, teams), ranked by how many notes mention them, then let you click any one to see its 2-hop neighbourhood (e.g. *Marcus Chen → 22 connected entities*, with typed relations like *"Atlas Migration **caused** Atlas incident"*). Then ask a connected question:

> *"What happened in the Atlas incident, who was involved, and what was the follow-up?"*

Plain vector search returns the **2** notes whose wording matches. **GraphRAG adds 5 more** — the people in the escalation chain, the project that caused it, and the security work that followed — surfaced because they're *connected through shared entities*, even though their cosine score (0.21–0.26) sits **below** the relevance floor that plain RAG would drop them at. The answer then synthesises across **7 notes** and cites each. That's retrieval by **connection**, not just by **wording** — the structural context plain RAG misses.

Great for onboarding (*"who owns what?"*), incident response (*"who do I loop in?"*), and impact analysis (*"everything that touches Acme Corp"*).

### 🤝 A deal war-room — from scattered notes to a winning play

A reproducible walkthrough — and **exactly the vault the [live demo](https://thienzz.github.io/Nebula/) seeds on first visit**, so you can follow along click-for-click. You're closing **Project Aurora** with **Northwind**, and your notes are scattered the way they really are — a status note, a budget note, a competitor note, a POC note, an org-map note:

```
deals/aurora-status.md       Project Aurora with Northwind is in final negotiation; Dana (our AE) expects signature this quarter.
deals/aurora-budget.md       Priya, Northwind's CFO, hasn't approved the Aurora budget yet — the main risk to closing.
deals/aurora-competition.md  Helix Systems undercut us on price for the same Aurora scope.
deals/aurora-poc.md          Orion, a Northwind subsidiary, ran the POC and validated performance.
deals/aurora-champion.md     Sam, Northwind's VP of Procurement, champions Aurora and pushes it internally.
```

1. **Build the graph.** Click **✨ build graph**. The on-device LLM reads each note and extracts the entities — *Northwind, Project Aurora, Priya (CFO), Sam (VP), Helix Systems, Orion* — **and how they connect**: *Priya **controls_budget** Aurora*, *Sam **champions** Aurora*, *Helix **competes_with** us*, *Orion **evaluated** the product*.
2. **Ask** with **🕸 GraphRAG** and **💡 Reason** on:
   > *"How do we win the Northwind deal — what's blocking it and what should we do?"*
3. **What comes back.** Plain vector search returns only the *status* note — the budget and champion notes share **no words** with your question. GraphRAG pulls them in anyway, because they share the entities *Northwind* and *Project Aurora*; the model then reasons across them and answers with a **cited plan**:
   > *Two things block Aurora: CFO **Priya** hasn't cleared the budget [#1], and **Helix** undercut us on price [#3]. To close: (1) work Priya to unblock the budget; (2) neutralise Helix by leaning on **Orion's validated POC** [#4]; (3) mobilise champion **Sam** to push internally [#5].*

The blockers *and* the levers came from notes a keyword search would never surface — retrieval by **connection**, not wording. *(Verified live on a real on-device model — Qwen2.5-3B, WebGPU; the retrieval + reasoning path is covered by `tests/integration/graphrag-flow.test.ts`.)*

### 🔒 A private research vault

Thousands of PDFs and notes you can't or won't upload — contracts, papers, source code, journals. Ask in plain language, get cited answers offline, and when you want a frontier model, **Compile Context** hands Claude/GPT a token-counted, redactable slice instead of the raw files.

### 🧑‍💼 A multi-client consultant's vault

One vault, many clients. **Scope** a question to a folder or tag so answers never bleed across clients, then compile a per-client context block to share — with a provable no-cross-client-leak guarantee.

## Quick start — it runs in your browser

```bash
npm install
npm run dev              # open http://localhost:1420 — the full app, in a cross-origin-isolated tab
```

That's the whole setup. `npm run dev` serves the app with the COOP/COEP headers it needs for WebGPU, and
you're writing notes immediately. First run downloads the models **once** into your browser cache (≈570 MB
embedder + the chat model you pick); after that it works offline. **Semantic search needs no GPU** (WASM/CPU);
local **chat** wants a WebGPU browser (Chrome/Edge/Arc, Safari 18+, Firefox rolling out) — on any OS, macOS included.

## Deploy it (host the tab anywhere)

`npm run build` emits a static SvelteKit site in `build/`. It needs exactly two response headers to unlock
`crossOriginIsolated` (required for WebGPU + threaded WASM):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

- **GitHub Pages (included, zero-config):** push to `main` → [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  builds and publishes to `https://<user>.github.io/Nebula/`. Pages can't set headers, so a vendored
  [`coi-serviceworker`](static/coi-serviceworker.js) injects them client-side (ADR-039). **One-time setup:** repo
  **Settings → Pages → Source = "GitHub Actions"** (and keep the workflow's `BASE_PATH` matching the repo name).
- **Hosts with header config** (Cloudflare Pages / Netlify / Vercel) — drop a `_headers` file with those two
  lines and set `BASE_PATH=''` (root); the service worker becomes optional.
- **Your data lives in the browser origin** (IndexedDB + Cache Storage): it survives refreshes but is per-browser/per-profile — so **Export Vault** (a one-click `.zip` of your `.md` notes + original files) is both your backup and your exit. Your knowledge is never locked in.

## Tests

```bash
npm run lint && npm run check     # eslint + prettier + svelte-check
npm run test:unit                 # pure logic (fast, offline)
npm run test:int                  # integration incl. real pdfjs + real SurrealDB (offline)
npm run test:models               # real bge-m3 embeddings (downloads ~570 MB first run)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust: fs_scope, model hash verify
```

334+ automated tests across TypeScript and Rust. CI uses the `InferenceProvider` mock (no GPU);
WebGPU chat runs on a real GPU box or a driven browser.

Nebula ingests **PDF / CSV / TXT / MD**; every import becomes a portable **Markdown Proxy Note**
(`notes/<stem>.md` with a `source:` backlink) over the untouched original in `sources/`, so
Export Vault round-trips 1:1 to portable Markdown — open it in any editor.

The **note-taking layer** (Export Vault, the Weaver auto-wikilinks, the Micro-Map retrieval
sub-graph, lazy-YAML auto-tagging, Magic Jump) has its cores implemented, wired into the app, and
live-verified. Note authoring (create / edit / rename /
move / delete), daily notes + templates, a file tree + tag pane, backlinks + unlinked mentions, a Ctrl/⌘-K
quick switcher, and per-folder/tag scope for the Context Compiler all ship in the app.

## Architecture

`InferenceProvider` (ADR-001) is the seam: `WebLLMProvider` (WebGPU, Phase 1) and a deterministic mock
implement it identically, so product logic never depends on the GPU. The SurrealDB index is a rebuildable
**derived cache** — your note bodies are the source of truth, and **Export Vault** hands you the whole thing
as plain `.md` any time (nothing is locked inside a browser store).

> Stable identifiers (`FR-`, `US-`, `TC-`, `T-`, `ADR-`) thread through the code — grep them.
