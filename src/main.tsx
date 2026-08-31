// Must precede the maplibre-gl import: MapLibre captures the frame source when
// its module first evaluates, so a later override would not reach it.
import './lib/hidden-tab-raf.ts';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App.tsx';

/**
 * MapLibre resolves its worker script relative to its own module URL at
 * runtime. That works when Vite serves maplibre-gl.mjs as a standalone file
 * (dev, thanks to the optimizeDeps exclude in vite.config.ts), but a
 * production build inlines it into the single app bundle — so the computed
 * worker URL points at a file that was never emitted, the worker silently
 * fails to start, and the map never receives any tile data.
 *
 * The worker script itself imports a sibling `maplibre-gl-shared.mjs` by a
 * literal relative path, so it can't be pulled in through a hashed `?url`
 * import (the hash breaks that sibling reference). Instead both files are
 * copied verbatim into public/vendor/maplibre-gl — keep them in sync with
 * the installed maplibre-gl version (see package.json) if it's upgraded.
 */
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}vendor/maplibre-gl/maplibre-gl-worker.mjs`);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
