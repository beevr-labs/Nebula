# Nebula

Local-first knowledge graph & context engine — a Tauri 2 + SvelteKit 5 + WASM + WebGPU desktop app.
Your notes stay as plain `.md` files on disk; semantic search, a grounded local-LLM chat (RAG), and a
deterministic Context Compiler run entirely on-device.

This repo contains the **spec set** (`docs/`) and a **working build** of the deterministic core plus the
real embedding / vector-DB / WebGPU-chat integrations.

## Status — verified on real hardware (not just mocks)

The full RAG pipeline has been run end-to-end on a real NVIDIA GPU:

- **Embeddings** — real `bge-small-en-v1.5` (384-dim) via `@huggingface/transformers` (CPU/WASM/WebGPU).
- **Vector store** — real **SurrealDB HNSW** cosine index (`@surrealdb/wasm`); `mem://` in Node, **`indxdb://` persistence in the webview (GATE D)**.
- **PDF** — real text + per-page offsets via `pdfjs-dist`.
- **WebGPU chat** — real `@mlc-ai/web-llm` (Phi-3-mini) on WebGPU, with `crossOriginIsolated === true` (**GATE A**).
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
npm run test:models               # real bge embeddings (downloads ~130 MB first run)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust: fs_scope, model hash verify
```

105+ automated tests across TypeScript and Rust. CI uses the `InferenceProvider` mock (no GPU);
WebGPU chat runs on a real GPU box or a driven browser.

## Architecture

`InferenceProvider` (ADR-001) is the seam: `WebLLMProvider` (WebGPU, Phase 1) and a deterministic mock
implement it identically, so product logic never depends on the GPU. The SurrealDB index is a rebuildable
**derived cache** — the `.md` files are the source of truth (uninstall and your notes still open in Obsidian).

> Built from the `docs/` spec set. Identifiers (`FR-`, `US-`, `TC-`, `T-`, `ADR-`) are stable — grep them.
