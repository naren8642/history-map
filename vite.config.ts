import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the build works when served from a GitHub Pages
  // project subpath (e.g. https://user.github.io/history-map/) as well
  // as from a custom domain or local preview.
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  optimizeDeps: {
    /**
     * MapLibre ships a web worker it loads by relative URL. Vite's dependency
     * pre-bundler rewrites the main entry into .vite/deps but does not emit the
     * worker alongside it, so the worker 404s. MapLibre needs it to parse
     * vector tiles, and without it the map never finishes loading its style —
     * with no thrown error, only a silent 404 in the network log.
     *
     * Excluding it from pre-bundling makes Vite serve the package as-is, worker
     * included.
     */
    exclude: ['maplibre-gl'],
  },
});
