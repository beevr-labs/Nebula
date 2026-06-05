<script lang="ts">
  // Real WebGPU chat harness (GATE A + FR-CHAT-001..004) driving the PRODUCT provider
  // (WebLLMProvider) — not an inline demo. window.__nebula is polled by the Chrome driver.
  import { onMount } from 'svelte';
  import { WebLLMProvider } from '$lib/inference/webllm';
  import type { SearchHit } from '$lib/inference/provider';

  const CONTEXT: SearchHit[] = [
    {
      chunkId: 'apollo-1',
      docId: 'notes/apollo.md',
      text: 'The Apollo project will ship to customers in the third quarter of next year.',
      page: 1,
      charStart: 0,
      charEnd: 75,
      score: 0.94
    },
    {
      chunkId: 'cats-1',
      docId: 'notes/cats.md',
      text: 'Cats are small domesticated carnivores unrelated to the project.',
      page: 1,
      charStart: 0,
      charEnd: 63,
      score: 0.21
    }
  ];

  onMount(async () => {
    const provider = new WebLLMProvider();
    const state = {
      coi: crossOriginIsolated,
      backend: provider.capabilities().backend,
      status: 'ready',
      progress: '',
      answer: '',
      citations: [] as { chunkId: string; spanInAnswer: [number, number] }[],
      ttftMs: 0,
      tokensPerSec: 0,
      error: ''
    };
    // @ts-expect-error external driver hook
    window.__nebula = state;

    // @ts-expect-error external driver hook
    window.__nebulaRun = async (modelId: string, query: string) => {
      try {
        state.status = 'loading';
        state.answer = '';
        state.error = '';
        await provider.loadModel(modelId, (p) => {
          state.progress = `loading ${(p * 100).toFixed(0)}%`;
        });
        state.status = 'generating';
        const result = await provider.generate(
          { requestId: 'r1', query, context: CONTEXT, modelId, maxTokens: 256 },
          (tok) => {
            state.answer += tok;
          },
          new AbortController().signal
        );
        state.citations = result.citations;
        state.ttftMs = result.ttftMs;
        state.tokensPerSec = Math.round(result.tokensPerSec);
        state.status = 'done';
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        state.status = 'error';
      }
    };
  });
</script>

<h1>Nebula WebLLM provider harness</h1>
<p>Poll <code>window.__nebula</code>; call <code>window.__nebulaRun(modelId, query)</code>.</p>
