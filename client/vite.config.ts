import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the same bundle works at a domain root and under a
  // GitHub Pages project subpath without knowing the deploy path at build time.
  base: './',
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
    rollupOptions: {
      output: {
        /**
         * Split the two big dependencies out of the app chunk.
         *
         * Three.js and Rapier are ~2.5 MB together and change only when their
         * versions do, while the game code changes every push. Separating them
         * means a returning player re-downloads the small chunk and keeps the
         * large ones cached, instead of the whole bundle every time.
         */
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
    // Rapier's compat build carries its WASM inline as base64, so its chunk is
    // ~2 MB no matter what and there is nothing left to split out of it. Set
    // just above that, so the warning still fires on a real regression.
    chunkSizeWarningLimit: 2200,
  },
});
