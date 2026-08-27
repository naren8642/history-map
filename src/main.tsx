// Must precede the maplibre-gl import: MapLibre captures the frame source when
// its module first evaluates, so a later override would not reach it.
import './lib/hidden-tab-raf.ts';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
