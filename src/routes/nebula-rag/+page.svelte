<script lang="ts">
  // FULL Nebula RAG, end-to-end in the browser on real components + real GPU:
  // ingest → chunk → embed (bge, transformers.js) → SurrealDB HNSW index →
  // query embed → KNN retrieve → grounded WebLLM answer with citations.
  // Driven/polled via window.__rag / window.__ragAsk by Claude-in-Chrome.
  import { onMount } from 'svelte';
  import { chunk } from '$lib/ingest/chunker';
  import { embed, embedBatch, makeBgeTokenCounter } from '$lib/embed/embedder';
  import { VectorStore } from '$lib/db/store';
  import { WebLLMProvider } from '$lib/inference/webllm';
  import { EMBEDDING_DIM } from '$lib/inference/provider';

  const CORPUS = [
    {
      docId: 'notes/apollo.md',
      text: 'The Apollo project will ship to customers in the third quarter of next year. The release adds a new dashboard and an export API for power users.'
    },
    {
      docId: 'notes/refunds.md',
      text: 'Our refund policy lets customers return any product within thirty days of purchase for a full refund, no questions asked.'
    },
    {
      docId: 'notes/security.md',
      text: 'All vault data stays on the local device. Nebula never uploads note content to any server; the Context Compiler is the only path that can export text, and only with consent.'
    },
    {
      docId: 'notes/cats.md',
      text: 'Cats are small domesticated carnivores. They are entirely unrelated to the product roadmap and exist here only as a retrieval distractor.'
    }
  ];

  onMount(async () => {
    const state: Record<string, unknown> = {
      coi: crossOriginIsolated,
      status: 'init',
      engine: '',
      chunkCount: 0,
      hits: [],
      answer: '',
      citations: [],
      ttftMs: 0,
      tokensPerSec: 0,
      error: ''
    };
    Object.assign(window, { __rag: state });

    try {
      state.status = 'loading-embedder';
      const countTokens = await makeBgeTokenCounter();

      const store = new VectorStore();
      try {
        await store.connect('indxdb://nebula-rag-demo-minilm', EMBEDDING_DIM);
        state.engine = 'indxdb'; // persistent webview store (GATE D)
      } catch {
        await store.connect('mem://', EMBEDDING_DIM);
        state.engine = 'mem';
      }

      state.status = 'ingesting';
      let total = 0;
      for (const doc of CORPUS) {
        const chunks = chunk(doc.text, { size: 60, overlap: 12, countTokens });
        const vectors = await embedBatch(chunks.map((c) => c.text));
        await store.upsertChunks(
          chunks.map((c, i) => ({
            chunkId: `${doc.docId}#${c.seq}`,
            docId: doc.docId,
            text: c.text,
            page: c.page,
            charStart: c.charStart,
            charEnd: c.charEnd,
            embedding: vectors[i]
          }))
        );
        total += chunks.length;
      }
      state.chunkCount = total;
      state.status = 'ready';

      Object.assign(window, {
        __ragAsk: async (modelId: string, query: string) => {
          state.status = 'embedding-query';
          state.answer = '';
          state.citations = [];
          state.error = '';

          const qv = await embed(query);
          state.status = 'retrieving';
          const hits = await store.search(qv, 4);
          state.hits = hits.map((h) => ({
            docId: h.docId,
            score: Number(h.score.toFixed(3)),
            text: h.text.slice(0, 60)
          }));

          state.status = 'loading-llm';
          const provider = new WebLLMProvider();
          await provider.loadModel(modelId, (p) => {
            state.status = `llm ${(p * 100).toFixed(0)}%`;
          });

          state.status = 'generating';
          const res = await provider.generate(
            { requestId: 'q1', query, context: hits, modelId, maxTokens: 256 },
            (tok) => {
              state.answer = (state.answer as string) + tok;
            },
            new AbortController().signal
          );
          state.citations = res.citations;
          state.ttftMs = res.ttftMs;
          state.tokensPerSec = Math.round(res.tokensPerSec);
          state.status = 'done';
        }
      });
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      state.status = 'error';
    }
  });
</script>

<h1>Nebula — full in-browser RAG</h1>
<p>Poll <code>window.__rag</code>; call <code>window.__ragAsk(modelId, query)</code>.</p>
