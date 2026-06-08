# Nebula

Local-first knowledge graph & context engine — a Tauri 2 + SvelteKit 5 + WASM + WebGPU desktop app.
Your notes stay as plain `.md` files on disk; semantic search, a grounded local-LLM chat (RAG), and a
deterministic Context Compiler run entirely on-device.

This repo contains the **spec set** (`docs/`) and a **working build**: a full local-first notes app
(authoring, multi-format ingestion, an entity knowledge graph + GraphRAG retrieval) on top of the real
embedding / vector-DB / WebGPU-chat integrations — all on-device.

## Status — verified on real hardware (not just mocks)

The full RAG pipeline has been run end-to-end on a real NVIDIA GPU:

- **Embeddings** — real **`bge-m3`** (1024-dim, multilingual incl. Vietnamese) via `@huggingface/transformers` (WASM/CPU, in a Web Worker — ADR-021/023).
- **Vector store** — real **SurrealDB HNSW** cosine index (`@surrealdb/wasm`); `mem://` in Node, **`indxdb://` persistence in the webview (GATE D)**.
- **PDF** — real text + per-page offsets via `pdfjs-dist`.
- **WebGPU chat** — real `@mlc-ai/web-llm`: a curated **10-model picker** (0.5B–8B); UI default **Llama-3.2-1B**, recommended **Qwen2.5-3B** (multilingual), with `crossOriginIsolated === true` (**GATE A**).
- **Entity graph + GraphRAG** — LLM-extracted entities/relations persisted as SurrealDB edges; retrieval fuses vector seeds with graph-connected sibling chunks (RRF), incremental via a content hash.
- **Answer modes** — **Reason** (apply the notes' knowledge) and **Grounded** (strict, verifiable RAG), each grounded + cited.
- **Grounded + cited** — e.g. *"No, Nebula does not send your note content to any server. [#1]"* with `[#1]` mapped to its source chunk.

See [`BUILD-PROGRESS.md`](BUILD-PROGRESS.md) for the slice-by-slice log and [`docs/`](docs/) for the full spec set.

## Quick start

```bash
npm install
npm run tauri:dev        # desktop app (first run compiles Rust)
# or the in-browser harnesses against the dev server (cross-origin-isolated):
npm run dev              # http://localhost:1420
#   /nebula-rag    — full RAG (embed → SurrealDB → WebLLM) on the GPU
#   /webllm-test   — WebLLM provider harness
```

## Tests

```bash
npm run lint && npm run check     # eslint + prettier + svelte-check
npm run test:unit                 # pure logic (fast, offline)
npm run test:int                  # integration incl. real pdfjs + real SurrealDB (offline)
npm run test:models               # real bge-m3 embeddings (downloads ~570 MB first run)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust: fs_scope, model hash verify
```

320+ automated tests across TypeScript and Rust. CI uses the `InferenceProvider` mock (no GPU);
WebGPU chat runs on a real GPU box or a driven browser.

Nebula ingests **PDF / CSV / TXT / MD**; every import becomes a portable **Markdown Proxy Note**
(`notes/<stem>.md` with a `source:` backlink) over the untouched original in `sources/`, so
Export Vault round-trips 1:1 into Obsidian.

The **"Obsidian DNA"** layer (Export Vault, the Weaver auto-wikilinks, the Micro-Map retrieval
sub-graph, lazy-YAML auto-tagging, Magic Jump) is specified in [`docs/01-product/OBSIDIAN-DNA.md`](docs/01-product/OBSIDIAN-DNA.md);
its cores are implemented, wired into the app, and live-verified. Note authoring (create / edit / rename /
move / delete), daily notes + templates, a file tree + tag pane, backlinks + unlinked mentions, a Ctrl/⌘-K
quick switcher, and per-folder/tag scope for the Context Compiler all ship in the app.

## Architecture

`InferenceProvider` (ADR-001) is the seam: `WebLLMProvider` (WebGPU, Phase 1) and a deterministic mock
implement it identically, so product logic never depends on the GPU. The SurrealDB index is a rebuildable
**derived cache** — the `.md` files are the source of truth (uninstall and your notes still open in Obsidian).

> Built from the `docs/` spec set. Identifiers (`FR-`, `US-`, `TC-`, `T-`, `ADR-`) are stable — grep them.
