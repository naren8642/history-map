/**
 * Skins: everything visual that distinguishes one rendering of the app from
 * another, gathered in data so a new look is an entry here plus a CSS token
 * block, never a fork of MapView.
 *
 * A skin owns three things:
 *   1. the basemap style URL,
 *   2. the colours the data layers paint with (glow hues, heat ramp, story ink),
 *   3. a `data-skin` attribute that scopes the UI's CSS tokens (styles.css).
 *
 * The map's *behaviour* — accretion time model, glow layer stack, peek,
 * stories — is shared. That separation is also what keeps the door open to
 * non-Wikidata sources later: nothing in a skin knows where an event came from.
 */

import type { Category } from '../types.ts';

export type SkinId = 'embers' | 'atlas';

export interface Skin {
  id: SkinId;
  label: string;
  /** Keyless vector style, preserving the static-deploy property. */
  basemap: string;
  /** Dark ground? Governs halo directions in map labels. */
  dark: boolean;
  /** Category hue for the glow body. Tuned per ground — luminous on dark, ink on paper. */
  glow: Record<Category, string>;
  /** The hot centre of a burning event. */
  core: string;
  /** Story layer ink: hulls, anchors, labels. */
  narrative: string;
  /** Heatmap ramp as [density, colour] stops; density 0 must be transparent. */
  heat: ReadonlyArray<readonly [number, string]>;
  /** Map label text + halo, and the muted year suffix after an event's name. */
  labelText: string;
  labelHalo: string;
  labelYear: string;
  /**
   * Post-load surgery on the basemap style. A stock basemap is a *dashboard*
   * ground — borders, place names, administrative grey. A skin that wants a
   * cinematic ground hides and recolors rather than forking the style JSON.
   */
  overrides?: {
    /** Hide every basemap symbol layer (labels, icons, shields). */
    hideSymbols?: boolean;
    /** Hide layers whose id contains any of these substrings. */
    hide?: string[];
    /** Recolor background/fill/line layers by id substring, first match wins. */
    recolor?: Array<readonly [string, string]>;
  };
}

/**
 * Luminous hues for the night map. Same family per category as the ink
 * palette (politics stays blue, conflict stays red) so switching skins never
 * re-teaches the legend — only re-lights it.
 */
const EMBERS_GLOW: Record<Category, string> = {
  conflict: '#ff4d42',
  atrocity: '#c73f6d',
  terrorism: '#ff7a3d',
  politics: '#59b0e6',
  'natural-disaster': '#35d6a4',
  accident: '#d9b13b',
  nuclear: '#a66bff',
  epidemic: '#3fc4d9',
  culture: '#7ed957',
  other: '#8f9bb0',
};

/** Ink weights of the same hues, for the paper ground. */
const ATLAS_GLOW: Record<Category, string> = {
  conflict: '#b5384d',
  atrocity: '#6b2440',
  terrorism: '#d1603d',
  politics: '#2f6f8f',
  'natural-disaster': '#2e8b74',
  accident: '#9a7b2f',
  nuclear: '#7a4fa3',
  epidemic: '#3f7d8c',
  culture: '#4a7c3f',
  other: '#7a7a7a',
};

export const SKINS: Record<SkinId, Skin> = {
  embers: {
    id: 'embers',
    label: 'Embers',
    basemap: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    dark: true,
    glow: EMBERS_GLOW,
    core: '#fff3e4',
    narrative: '#8fb6e0',
    // Deep and restrained: the wash is an under-glow beneath the fireflies,
    // never a milky spill over them.
    heat: [
      [0, 'rgba(8,12,26,0)'],
      [0.25, 'rgba(38,44,96,0.16)'],
      [0.5, 'rgba(116,48,84,0.26)'],
      [0.75, 'rgba(214,88,48,0.36)'],
      [1, 'rgba(255,178,118,0.48)'],
    ],
    labelText: '#f3ede2',
    labelHalo: 'rgba(5,8,14,0.9)',
    labelYear: 'rgba(255,176,128,0.85)',
    overrides: {
      // The night map carries its own words; the basemap contributes only a
      // silhouette. Land sits a shade lighter than the ocean, as in a long-
      // exposure photograph of the planet.
      hideSymbols: true,
      hide: ['boundary', 'admin'],
      recolor: [
        ['water', '#04070e'],
        ['background', '#0d1729'],
        ['landcover', '#0d1729'],
        ['land', '#0d1729'],
        ['park', '#0d1729'],
        ['building', '#101c30'],
        ['road', '#15233a'],
        ['bridge', '#15233a'],
        ['tunnel', '#15233a'],
      ],
    },
  },
  /**
   * First cut of the atlas skin: the existing Positron ground with a warm ink
   * density wash. The full parchment treatment (restyled tiles, engraved
   * chrome, serif cartography) is a later pass — this entry exists so the
   * switcher, and the skin contract itself, are real from day one.
   */
  atlas: {
    id: 'atlas',
    label: 'Atlas',
    basemap: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    dark: false,
    glow: ATLAS_GLOW,
    core: '#402e16',
    narrative: '#4a5f73',
    heat: [
      [0, 'rgba(224,203,152,0)'],
      [0.25, 'rgba(224,203,152,0.35)'],
      [0.5, 'rgba(186,120,72,0.45)'],
      [0.75, 'rgba(156,74,54,0.55)'],
      [1, 'rgba(82,38,44,0.65)'],
    ],
    labelText: '#2a2a2a',
    labelHalo: 'rgba(255,255,255,0.92)',
    labelYear: '#8a7a5e',
  },
};

export const SKIN_ORDER: readonly SkinId[] = ['embers', 'atlas'];
