import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSON } from 'geojson';
import { GlowPeek, PEEK_LIMIT, type PeekMember, type PeekState } from './ClusterPeek.tsx';
import { createEmberLayer, type EmberHandle } from './lib/emberLayer.ts';
import type { Category, HistoryEvent } from './types.ts';
import type { TimeWindow } from './Timeline.tsx';
import type { Skin } from './lib/skins.ts';
import { hullRing, type Narrative } from './lib/narratives.ts';

const SOURCE = 'events';
const NARRATIVE_SOURCE = 'narratives';

const INITIAL_ZOOM = 1.6;
const INITIAL_CENTER: [number, number] = [10, 30];

/**
 * The camera survives a skin change. Swapping basemap styles remounts the
 * whole MapView (rebuilding sources and layers from scratch is far simpler
 * than diffing them into a foreign style), and losing your place on the map
 * because you changed its clothes would be absurd.
 */
let savedCamera: { center: [number, number]; zoom: number } | null = null;

/**
 * Notability rank above which an event may carry a map label, by zoom. At
 * world view only the famous get words; zooming in is how the reader asks for
 * more, so the floor slides to zero by street level and collision becomes the
 * only gate.
 */
function labelRankFor(zoom: number): number {
  if (zoom <= 3.5) return 40;
  if (zoom >= 9) return 0;
  return Math.round(40 * (1 - (zoom - 3.5) / 5.5));
}

/** Pixel half-width of the hover/click probe around the cursor. */
const PROBE = 26;

/** Delay before a hover opens the peek, so sweeping the map does not flash cards. */
const PEEK_OPEN_MS = 130;

/** Camera actions the surrounding UI needs; the map instance stays private. */
export interface MapApi {
  fitTo: (points: [number, number][]) => void;
}

interface Props {
  /**
   * The full story-scoped corpus — NOT filtered by time. Time lives entirely
   * in paint expressions (see applyTime), so scrubbing and playback never
   * rebuild the GeoJSON source. That is what makes 60fps accretion affordable:
   * one setData per story change, a handful of setPaintProperty calls per frame.
   */
  events: HistoryEvent[];
  /** from = the cooled edge of the burn, to = the playhead. */
  window: TimeWindow;
  skin: Skin;
  narratives?: Narrative[];
  /** Story names by QID, for naming which story an event under the probe belongs to. */
  storyNames?: Map<number, string>;
  highlightNarrative?: number | null;
  onSelectNarrative?: (qid: number) => void;
  onMapApi?: (api: MapApi | null) => void;
  onSelect: (qid: number | null) => void;
  /** Several burning events under one probe; opens a list. */
  onSelectGroup: (qids: number[]) => void;
  onViewportChange?: (zoom: number) => void;
}

type Expr = maplibregl.ExpressionSpecification;

/**
 * The slow half of the clock. The embers themselves animate in the custom
 * layer (a shader uniform, free at any rate); the heatmap weight and the
 * label filter below are data-driven MapLibre properties, which re-bake tile
 * buffers on every change — so they follow the clock on a debounce, not per
 * frame. See emberLayer.ts for the fast half.
 */
function timeExpressions(window: TimeWindow, labelRank: number) {
  const to = window.to;
  const span = Math.max(4, window.to - window.from);
  const from = to - span;

  /** Residue still warms the heatmap a little; the past leaves a mark. */
  const heatWeight: Expr = [
    'case',
    ['>', ['get', 's'], to],
    0,
    ['<', ['get', 's'], from],
    ['*', 0.12, ['interpolate', ['linear'], ['get', 'r'], 0, 0.25, 50, 1]],
    ['interpolate', ['linear'], ['get', 'r'], 0, 0.25, 50, 1],
  ] as unknown as Expr;

  const labelFilter = [
    'all',
    ['>=', ['get', 'r'], labelRank],
    ['<=', ['get', 's'], to],
    ['>=', ['get', 's'], from],
  ] as maplibregl.FilterSpecification;

  return { heatWeight, labelFilter };
}

export function MapView({
  events,
  window: timeWindow,
  skin,
  narratives = [],
  storyNames,
  highlightNarrative = null,
  onSelectNarrative,
  onMapApi,
  onSelect,
  onSelectGroup,
  onViewportChange,
}: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);

  /** Story under the pointer, which reveals its extent without entering it. */
  const [hoveredNarrative, setHoveredNarrative] = useState<number | null>(null);

  const [peek, setPeek] = useState<PeekState | null>(null);
  const peekTimer = useRef<number | undefined>(undefined);

  /** Handlers need the live window without being rebuilt every frame. */
  const windowRef = useRef(timeWindow);
  windowRef.current = timeWindow;

  const emberRef = useRef<EmberHandle | null>(null);
  const slowClock = useRef<number | undefined>(undefined);
  const slowApplied = useRef(0);

  // Initialise the map exactly once per mount; React state never drives the camera.
  useEffect(() => {
    if (map.current || !container.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      style: skin.basemap,
      center: savedCamera?.center ?? INITIAL_CENTER,
      zoom: savedCamera?.zoom ?? INITIAL_ZOOM,
      minZoom: 1,
      maxZoom: 16,
      attributionControl: { compact: true },
      // Dev only: keep the drawing buffer so embedded panes and screenshot
      // tooling can capture the canvas between frames. Costs a buffer copy per
      // frame, so production keeps the default.
      canvasContextAttributes: { preserveDrawingBuffer: import.meta.env.DEV },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.current = m;

    // MapLibre reports tile, sprite, and glyph failures through this event and
    // nowhere else. Without a listener they vanish silently.
    m.on('error', (e) => {
      console.error('[maplibre]', e.error?.message ?? e);
    });

    // MapLibre measures the container once at construction; observe it so the
    // canvas stays correct through first paint and window resizes.
    const resizeObserver = new ResizeObserver(() => m.resize());
    resizeObserver.observe(container.current);

    if (import.meta.env.DEV) {
      (window as unknown as { __map?: maplibregl.Map }).__map = m;
    }

    m.on('load', () => {
      m.resize();

      // Skin surgery on the stock basemap: hide its words and borders,
      // recolor its ground. See Skin.overrides for why this lives in data.
      const o = skin.overrides;
      if (o) {
        for (const layer of m.getStyle().layers) {
          if (
            (o.hideSymbols && layer.type === 'symbol') ||
            o.hide?.some((s) => layer.id.includes(s))
          ) {
            m.setLayoutProperty(layer.id, 'visibility', 'none');
            continue;
          }
          const rc = o.recolor?.find(([s]) => layer.id.includes(s));
          if (!rc) continue;
          if (layer.type === 'fill') m.setPaintProperty(layer.id, 'fill-color', rc[1]);
          else if (layer.type === 'background') m.setPaintProperty(layer.id, 'background-color', rc[1]);
          else if (layer.type === 'line') m.setPaintProperty(layer.id, 'line-color', rc[1]);
        }
      }

      // Story layers first, so they sit beneath the glow.
      m.addSource(NARRATIVE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      m.addLayer({
        id: 'narrative-fill',
        type: 'fill',
        source: NARRATIVE_SOURCE,
        // One hull at a time — labels advertise which stories exist; the
        // extent appears for the one you point at or enter.
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'q'], -1]],
        paint: { 'fill-color': skin.narrative, 'fill-opacity': 0.08 },
      });
      // A soft bloom instead of the old dashed marquee: the hull is an
      // inference from member locations, and a glow asserts less than a border.
      m.addLayer({
        id: 'narrative-glowline',
        type: 'line',
        source: NARRATIVE_SOURCE,
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'q'], -1]],
        paint: {
          'line-color': skin.narrative,
          'line-opacity': 0.3,
          'line-width': 5,
          'line-blur': 4,
        },
      });
      m.addLayer({
        id: 'narrative-outline',
        type: 'line',
        source: NARRATIVE_SOURCE,
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'q'], -1]],
        paint: { 'line-color': skin.narrative, 'line-opacity': 0.55, 'line-width': 1.1 },
      });
      m.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      const t = timeExpressions(windowRef.current, labelRankFor(m.getZoom()));

      // Density as luminosity at world zoom, crossfading to individual embers
      // as the dots become separable. This replaces numbered cluster bubbles
      // entirely — density is something you see, not something you read.
      m.addLayer({
        id: 'heat',
        type: 'heatmap',
        source: SOURCE,
        paint: {
          'heatmap-weight': t.heatWeight,
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 6, 1.6],
          // The wash survives deeper zoom than before: fading it by z6.5 made
          // a region feel less significant the closer you looked at it.
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 14, 4, 22, 7, 34, 9, 46],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 5, 0.6, 8.5, 0],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            ...skin.heat.flatMap(([stop, color]) => [stop, color]),
          ] as unknown as Expr,
        },
      });

      // The firefly stack lives in a custom WebGL layer: the corpus uploads
      // once, time is a uniform, and on the night skin the passes blend
      // additively — overlap genuinely accumulates into light.
      const ember = createEmberLayer('embers', skin);
      emberRef.current = ember.handle;
      ember.handle.setTime(windowRef.current.to, windowRef.current.to - windowRef.current.from);
      m.addLayer(ember.layer);

      // An invisible twin of the ember field for hit-testing. Its paint is
      // static, so it never re-bakes; queryRenderedFeatures reads geometry,
      // not pixels, so zero opacity costs nothing.
      m.addLayer({
        id: 'probe',
        type: 'circle',
        source: SOURCE,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3, 9, 6] as unknown as Expr,
          'circle-opacity': 0,
        },
      });

      // Only currently-burning, notable events carry labels. MapLibre's
      // collision engine resolves overlap by hiding, so placement order is the
      // label budget: most notable first via the sort key.
      m.addLayer({
        id: 'ember-labels',
        type: 'symbol',
        source: SOURCE,
        filter: t.labelFilter,
        layout: {
          // Name, then the year in a quieter warm tone — the mockup's cadence.
          'text-field': [
            'format',
            ['get', 'n'], {},
            '  ', {},
            [
              'case',
              ['<', ['get', 's'], 0],
              ['concat', ['to-string', ['*', -1, ['get', 's']]], ' BCE'],
              ['to-string', ['get', 's']],
            ],
            { 'text-color': skin.labelYear, 'font-scale': 0.9 },
          ] as unknown as Expr,
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.15],
          'text-anchor': 'top',
          'text-max-width': 11,
          // Collision resolves by hiding; padding keeps the survivors from
          // reading as a solid bar of type over dense regions.
          'text-padding': 10,
          'symbol-sort-key': ['*', -1, ['get', 'r']] as unknown as Expr,
        },
        paint: {
          'text-color': skin.labelText,
          'text-halo-color': skin.labelHalo,
          'text-halo-width': 1.5,
        },
      });

      /*
       * Story anchors and names go in LAST, above the event labels. Symbol
       * placement gives topmost layers first claim, so with collision ON a
       * story name now displaces event labels instead of overprinting them
       * (the Artsakh/Khojaly pile-up). Stories may still yield to each other —
       * the anchor ring, which never collides, keeps every story findable.
       */
      m.addLayer({
        id: 'narrative-anchor',
        type: 'circle',
        source: NARRATIVE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 7,
          'circle-color': skin.dark ? '#0b1018' : '#ffffff',
          'circle-stroke-color': skin.narrative,
          // A derived point is drawn thinner and a country centroid fainter
          // still. Same hit target, visibly less assertion.
          'circle-stroke-width': ['match', ['get', 'via'], 'coarse', 1, 'derived', 1.5, 2],
          'circle-opacity': ['match', ['get', 'via'], 'coarse', 0.5, 'derived', 0.75, 0.95],
        },
      });
      m.addLayer({
        id: 'narrative-label',
        type: 'symbol',
        source: NARRATIVE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          // Set like an engraved sea name: capitals, air between the letters.
          // The glyph stack has no serif, but spacing carries the register.
          'text-field': skin.dark ? ['upcase', ['get', 'label']] : ['get', 'label'],
          'text-font': ['Open Sans Semibold'],
          'text-letter-spacing': skin.dark ? 0.28 : 0,
          'text-size': ['interpolate', ['linear'], ['get', 'rank'], 40, 11, 300, 15],
          'text-max-width': 12,
          'text-offset': [0, 0.9],
          'text-anchor': 'top',
          'text-padding': 6,
          'symbol-sort-key': ['*', -1, ['get', 'rank']] as unknown as Expr,
        },
        paint: {
          'text-color': skin.dark ? '#e8eef8' : skin.narrative,
          'text-halo-color': skin.labelHalo,
          'text-halo-width': skin.dark ? 1.4 : 2,
        },
      });

      setReady(true);
    });

    m.on('moveend', () => {
      const c = m.getCenter();
      savedCamera = { center: [c.lng, c.lat], zoom: m.getZoom() };
    });

    onMapApi?.({
      fitTo: (points) => {
        if (points.length === 0) return;
        const bounds = points.reduce(
          (acc, p) => acc.extend(p),
          new maplibregl.LngLatBounds(points[0]!, points[0]!),
        );
        // Co-located members produce a zero-area bounds, which fitBounds
        // cannot frame; ease to the point at a close zoom instead.
        const flat = bounds.getWest() === bounds.getEast() && bounds.getSouth() === bounds.getNorth();
        if (flat) m.easeTo({ center: points[0]!, zoom: 14, duration: 500 });
        else m.fitBounds(bounds, { padding: 90, maxZoom: 14, duration: 500 });
      },
    });

    return () => {
      resizeObserver.disconnect();
      onMapApi?.(null);
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  // Publish the corpus. Runs on story enter/exit and data load — never on scrub.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const source = m.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const features = events.map((e) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [e.c[0], e.c[1]] },
      // p1: the first P361 parent — enough to say which story a probed dot
      // belongs to, without shipping the whole DAG into the tile.
      properties: { q: e.q, n: e.n, g: e.g, r: e.r, s: e.s, p1: e.pa?.[0] ?? 0 },
    }));
    source.setData({ type: 'FeatureCollection', features } as GeoJSON);
    emberRef.current?.setEvents(events);
    // Embedded panes can throttle the frame source while data loads in the
    // worker, leaving a finished map un-composited. Asking for a frame after
    // every update is free when one was coming anyway.
    m.triggerRepaint();
  }, [ready, events]);

  // Advance the clock. The embers move instantly (uniform + repaint); the
  // heatmap and labels re-bake tile buffers, so they trail on a debounce —
  // during playback they update a few times a second, at rest immediately.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    emberRef.current?.setTime(timeWindow.to, timeWindow.to - timeWindow.from);
    m.triggerRepaint();

    const applySlow = (): void => {
      if (!map.current) return;
      slowApplied.current = performance.now();
      const t = timeExpressions(timeWindow, labelRankFor(map.current.getZoom()));
      map.current.setPaintProperty('heat', 'heatmap-weight', t.heatWeight);
      map.current.setFilter('ember-labels', t.labelFilter);
    };
    window.clearTimeout(slowClock.current);
    // A trailing debounce alone never fires under continuous playback — the
    // labels would stay frozen at the sweep's first frame. So: flush
    // periodically while the clock runs, and settle precisely once it stops.
    if (performance.now() - slowApplied.current > 700) applySlow();
    else slowClock.current = window.setTimeout(applySlow, 260);
    return () => window.clearTimeout(slowClock.current);
  }, [ready, timeWindow, skin]);

  // Zooming changes the label budget (labelRankFor), not just the camera, so
  // the filter is refreshed when a zoom settles.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const onZoomEnd = (): void => {
      slowApplied.current = performance.now();
      const t = timeExpressions(windowRef.current, labelRankFor(m.getZoom()));
      m.setFilter('ember-labels', t.labelFilter);
    };
    m.on('zoomend', onZoomEnd);
    return () => {
      m.off('zoomend', onZoomEnd);
    };
  }, [ready]);

  // Publish narrative geometry: a hull polygon plus a label anchor per story.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const source = m.getSource(NARRATIVE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    const features: GeoJSON.Feature[] = [];
    for (const n of narratives) {
      const ring = hullRing(n);
      if (ring) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { q: n.q, label: n.n, rank: n.r },
        });
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: n.c },
        properties: { q: n.q, label: n.n, rank: n.r, via: n.via ?? '' },
      });
    }
    source.setData({ type: 'FeatureCollection', features });
  }, [ready, narratives]);

  // Reveal exactly one hull: the story being entered, else the one hovered.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const shown = highlightNarrative ?? hoveredNarrative ?? -1;
    for (const layer of ['narrative-fill', 'narrative-glowline', 'narrative-outline'] as const) {
      if (m.getLayer(layer)) {
        m.setFilter(layer, ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'q'], shown]]);
      }
    }
  }, [ready, highlightNarrative, hoveredNarrative]);

  // Interaction. There are no cluster features any more; both hover and click
  // probe a small box around the cursor and rank what is burning inside it.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const probe = (point: { x: number; y: number }): PeekMember[] => {
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [point.x - PROBE, point.y - PROBE],
        [point.x + PROBE, point.y + PROBE],
      ];
      const { from, to } = windowRef.current;
      const seen = new Map<number, PeekMember>();
      for (const f of m.queryRenderedFeatures(box, { layers: ['probe'] })) {
        const p = f.properties as { q: number; n: string; g: Category; r: number; s: number; p1: number };
        if (p.s > to || p.s < from) continue; // residue is context, not content
        if (!seen.has(p.q)) seen.set(p.q, p);
      }
      return [...seen.values()].sort((a, b) => b.r - a.r);
    };

    const closePeek = (): void => {
      window.clearTimeout(peekTimer.current);
      setPeek(null);
    };

    const onMove = (e: maplibregl.MapMouseEvent): void => {
      const members = probe(e.point);
      m.getCanvas().style.cursor = members.length > 0 ? 'pointer' : '';
      window.clearTimeout(peekTimer.current);
      if (members.length < 2) {
        setPeek(null);
        return;
      }
      peekTimer.current = window.setTimeout(() => {
        setPeek({
          members: members.slice(0, PEEK_LIMIT),
          total: members.length,
          x: e.point.x,
          y: e.point.y,
        });
      }, PEEK_OPEN_MS);
    };

    /*
     * One click handler with an explicit priority order:
     *   1. narrative anchor / label   (small, intentional)
     *   2. burning events under the probe
     *   3. narrative hull             (vast background)
     */
    const onClick = (e: maplibregl.MapMouseEvent): void => {
      const anchor = m.queryRenderedFeatures(e.point, {
        layers: ['narrative-anchor', 'narrative-label'],
      })[0];
      if (anchor) {
        const q = anchor.properties?.['q'] as number | undefined;
        if (q !== undefined) {
          closePeek();
          onSelectNarrative?.(q);
        }
        return;
      }

      const members = probe(e.point);
      if (members.length === 1) {
        onSelect(members[0]!.q);
        return;
      }
      if (members.length > 1) {
        closePeek();
        onSelectGroup(members.map((p) => p.q));
        return;
      }

      const hull = m.queryRenderedFeatures(e.point, { layers: ['narrative-fill'] })[0];
      const hullQ = hull?.properties?.['q'] as number | undefined;
      if (hullQ !== undefined) onSelectNarrative?.(hullQ);
    };

    const onNarrativeEnter = (e: maplibregl.MapMouseEvent): void => {
      const q = m.queryRenderedFeatures(e.point, {
        layers: ['narrative-anchor', 'narrative-label'],
      })[0]?.properties?.['q'];
      if (typeof q === 'number') setHoveredNarrative(q);
    };
    const onNarrativeLeave = (): void => setHoveredNarrative(null);

    const onViewport = (): void => {
      onViewportChange?.(m.getZoom());
    };

    m.on('mousemove', onMove);
    m.on('mouseout', closePeek);
    m.on('click', onClick);
    m.on('movestart', closePeek);
    m.on('move', onViewport);
    m.on('mousemove', 'narrative-anchor', onNarrativeEnter);
    m.on('mouseleave', 'narrative-anchor', onNarrativeLeave);
    onViewport();

    return () => {
      window.clearTimeout(peekTimer.current);
      m.off('mousemove', onMove);
      m.off('mouseout', closePeek);
      m.off('click', onClick);
      m.off('movestart', closePeek);
      m.off('move', onViewport);
      m.off('mousemove', 'narrative-anchor', onNarrativeEnter);
      m.off('mouseleave', 'narrative-anchor', onNarrativeLeave);
    };
  }, [ready, onSelect, onSelectGroup, onSelectNarrative, onViewportChange]);

  // The peek sits outside the container MapLibre owns; each library keeps to
  // its own subtree.
  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      {/* Cinematic falloff over the night ground; inert and skin-scoped in CSS. */}
      <div className="map-veil" aria-hidden="true" />
      {peek && <GlowPeek peek={peek} colors={skin.glow} storyNames={storyNames} />}
    </div>
  );
}
