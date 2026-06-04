import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// CRITICAL (DEPENDENCIES.lock §6): WebLLM + Transformers.js need a
// cross-origin-isolated context (SharedArrayBuffer / threaded WASM).
// These headers are required in DEV; the SAME two headers must also be
// emitted by the Tauri production webview (see src-tauri/tauri.conf.json).
// Verify `self.crossOriginIsolated === true` at runtime (Phase 0 GATE A).
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  }
};

export default defineConfig({
  plugins: [crossOriginIsolation, sveltekit()],

  // Tauri expects a fixed dev port and no clearing of the screen.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
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
