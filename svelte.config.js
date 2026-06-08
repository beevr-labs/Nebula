import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Nebula is a browser-first app: build a static SPA (no SSR) served by any
// static host / PWA. adapter-static with a SPA fallback gives client-side routing.
/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html', // SPA mode — all routes resolve client-side
      precompress: false,
      strict: false
    }),
    // No server runtime; everything is client + Web Workers.
    alias: {
      $lib: 'src/lib'
    }
  }
};

export default config;
