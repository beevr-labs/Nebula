import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// CRITICAL (DEPENDENCIES.lock §6): WebLLM + Transformers.js need a
// cross-origin-isolated context (SharedArrayBuffer / threaded WASM).
// These headers are required in DEV; the SAME two headers must also be
// emitted by the production web host (static deploy / PWA — set them at the
// CDN/server). Verify `self.crossOriginIsolated === true` at runtime (Phase 0 GATE A).
//
// COEP is `credentialless` (not `require-corp`): both give crossOriginIsolated on Chromium, but
// credentialless loads cross-origin resources credential-free without demanding a
// `Cross-Origin-Resource-Policy` header — safer for third-party model CDNs (HuggingFace serves
// shards via its xet CDN WITHOUT CORP). NOTE: the actual model-download fix lives in webllm.ts,
// which switches WebLLM to the IndexedDB cache backend — under COEP the Cache API refuses to STORE
// a cross-origin response lacking CORP (`Cache.put()` → NetworkError), even though the same bytes
// fetch+read fine. IndexedDB stores the ArrayBuffer directly and sidesteps that check.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: {
    middlewares: {
      use: (
        fn: (
          req: unknown,
          res: { setHeader: (k: string, v: string) => void },
          next: () => void
        ) => void
      ) => void;
    };
  }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      next();
    });
  }
};

export default defineConfig({
  plugins: [crossOriginIsolation, sveltekit()],

  // Fixed dev port (Claude Preview / live verification), no screen clearing.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    },
    // Some WASM/worker deps don't like being pre-bundled.
    fs: { allow: ['..'] }
  },

  // Web Workers (parser, embedder, db, webllm) — keep as ES modules.
  worker: { format: 'es' },

  // Large model/WASM assets shouldn't be inlined.
  build: {
    target: 'esnext',
    sourcemap: true
  },

  optimizeDeps: {
    // These ship their own WASM and dislike Vite's dep optimizer.
    exclude: ['@surrealdb/wasm', '@huggingface/transformers', '@mlc-ai/web-llm']
  }
});
