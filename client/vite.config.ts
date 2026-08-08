import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    host: true,
    fs: {
      // /shared lives outside the Vite root and is imported as source.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  optimizeDeps: {
    // The Rapier compat build ships its WASM inline; let Vite pre-bundle it.
    include: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'es2022',
  },
});
