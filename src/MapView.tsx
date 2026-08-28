import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSON } from 'geojson';
import {
  buildIndex,
  dominantCategory,
  indexDepthFor,
  isCluster,
  rankedMembers,
  type AnyFeature,
} from './lib/clustering.ts';
import { ClusterPeek, PEEK_LIMIT, type PeekState } from './ClusterPeek.tsx';
import { pointBudget } from './lib/rank.ts';
import { CATEGORY_COLOR, type Category, type HistoryEvent } from './types.ts';
import { hullRing, type Narrative } from './lib/narratives.ts';

/**
 * Keyless vector basemap, which keeps the static-deploy property intact.
 * Positron is deliberately desaturated so the pins carry all the colour.
 * Fallback if this ever changes terms: https://tiles.openfreemap.org/styles/positron
 */
const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

const SOURCE = 'events';
const NARRATIVE_SOURCE = 'narratives';

/** Muted slate — narratives are context, not another category of event. */
const NARRATIVE_COLOR = '#4a5f73';

const INITIAL_ZOOM = 1.6;

/** Delay before a hover opens the peek, so sweeping across clusters does not flash cards. */
const PEEK_OPEN_MS = 130;

/** Camera actions the surrounding UI needs; the map instance stays private. */
export interface MapApi {
  /** Frame a set of coordinates, e.g. the members of a group being listed. */
  fitTo: (points: [number, number][]) => void;
}

interface Props {
  events: HistoryEvent[];
  /** Story regions to draw beneath the events. */
  narratives?: Narrative[];
  /** Story whose extent should be drawn; others show only their label. */
  highlightNarrative?: number | null;
  onSelectNarrative?: (qid: number) => void;
  onMapApi?: (api: MapApi | null) => void;
  onSelect: (qid: number | null) => void;
  /** Co-located events that no zoom level can separate; opens a list instead. */
  onSelectGroup: (qids: number[]) => void;
  onViewportChange: (visible: number, zoom: number, floor: number) => void;
}

/** Build a MapLibre expression mapping the category property to its colour. */
function categoryColorExpression(prop: string): maplibregl.ExpressionSpecification {
  const cases = Object.entries(CATEGORY_COLOR).flatMap(([category, color]) => [category, color]);
  return ['match', ['get', prop], ...cases, CATEGORY_COLOR.other] as unknown as maplibregl.ExpressionSpecification;
}

export function MapView({
  events,
  narratives = [],
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

  /**
   * Indexed over every event in the window, deliberately including ones below
   * the display floor.
   *
   * Filtering by rank *before* indexing is ~13x cheaper at world zoom (600
   * events, 7ms, versus 19,668 events at 90ms) — but it makes cluster counts
   * report only notable events, which collapsed Europe's 1900-1950 bubble from
   * 472 to 16 and destroyed the density signal the map exists to convey.
   *
   * So the whole window is indexed and the floor is applied to individual
   * points afterwards, per §6: the floor hides *pins*, never clusters. The
   * scrub cost this reintroduces is absorbed by useDeferredValue in App.
   */
  // Index depth tracks the map's zoom band; see indexDepthFor. Mirrored in a
  // ref so the move handler can compare without being rebuilt each time.
  /** Story under the pointer, which reveals its extent without entering it. */
  const [hoveredNarrative, setHoveredNarrative] = useState<number | null>(null);

  const [peek, setPeek] = useState<PeekState | null>(null);
  const peekTimers = useRef<{ open?: number; close?: number }>({});
  /** Which cluster the peek is for, so re-hovering the same one is a no-op. */
  const peekCluster = useRef<number | null>(null);

  const [indexDepth, setIndexDepth] = useState(() => indexDepthFor(INITIAL_ZOOM));
  const depthRef = useRef(indexDepth);

  const index = useMemo(() => buildIndex(events, indexDepth), [events, indexDepth]);

  // Initialise the map exactly once; React state never drives the camera.
  useEffect(() => {
    if (map.current || !container.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      style: BASEMAP,
      center: [10, 30],
      zoom: INITIAL_ZOOM,
      minZoom: 1,
      maxZoom: 16,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.current = m;

    // MapLibre reports tile, sprite, and glyph failures through this event and
    // nowhere else. Without a listener they vanish silently and the map simply
    // never finishes loading, which is very hard to diagnose from the outside.
    m.on('error', (e) => {
      console.error('[maplibre]', e.error?.message ?? e);
    });

    // MapLibre measures the container once at construction. In a flex/absolute
    // layout that can happen before the browser has settled the final size,
    // leaving a small canvas inside a large div. Observing the container keeps
    // the canvas correct through both first paint and window resizes.
    const resizeObserver = new ResizeObserver(() => m.resize());
    resizeObserver.observe(container.current);

    if (import.meta.env.DEV) {
      (window as unknown as { __map?: maplibregl.Map }).__map = m;
    }

    m.on('load', () => {
      // Vite injects CSS asynchronously in dev, so the container can still be
      // 0x0 when the Map is constructed — MapLibre then falls back to a 400x300
      // canvas and keeps it. ResizeObserver cannot be relied on to correct this
      // (its callbacks are delivered through the rendering pipeline, which is
      // idle in a hidden tab), so resize explicitly once layout has settled.
      m.resize();

      // Narrative layers are added first so they sit *beneath* the event
      // circles. A story is context for the pins, not a competitor to them.
      m.addSource(NARRATIVE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      m.addLayer({
        id: 'narrative-fill',
        type: 'fill',
        source: NARRATIVE_SOURCE,
        // Hulls are drawn one at a time, never all at once. World War II's hull
        // spans most of the planet — it genuinely happened almost everywhere —
        // and eight such fills stacked at 7% opacity turn the whole map grey
        // while saying nothing. Labels advertise which stories exist; the
        // extent appears for the one you point at or enter.
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'q'], -1]],
        paint: { 'fill-color': NARRATIVE_COLOR, 'fill-opacity': 0.1 },
      });
      m.addLayer({
        id: 'narrative-outline',
        type: 'line',
        source: NARRATIVE_SOURCE,
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'q'], -1]],
        paint: {
          'line-color': NARRATIVE_COLOR,
          'line-opacity': 0.55,
          'line-width': 1.2,
          // Dashed, because a hull is inferred from where members happened —
          // not a border anyone drew.
          'line-dasharray': [3, 2],
        },
      });
      // A visible anchor for each story: it gives the label a real hit target
      // and marks the point the label belongs to.
      m.addLayer({
        id: 'narrative-anchor',
        type: 'circle',
        source: NARRATIVE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          // Comfortably clickable; a 5px anchor was easy to miss entirely.
          'circle-radius': 7,
          'circle-color': '#ffffff',
          'circle-stroke-color': NARRATIVE_COLOR,
          'circle-stroke-width': 2,
          'circle-opacity': 0.95,
        },
      });
      m.addLayer({
        id: 'narrative-label',
        type: 'symbol',
        source: NARRATIVE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['get', 'rank'], 40, 11, 300, 15],
          'text-max-width': 9,
          'text-offset': [0, 0.9],
          'text-anchor': 'top',
          /*
           * Always draw. With collision enabled MapLibre suppressed six of
           * eight story labels against event pins — including World War II,
           * the most important object on the map. Stories are the primary
           * navigation here, so they take precedence over the pins they
           * contain; the budget of 8 keeps that from becoming clutter.
           */
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': NARRATIVE_COLOR,
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
        },
      });

      m.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      m.addLayer({
        id: 'clusters',
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'cluster'], true],
        paint: {
          'circle-color': categoryColorExpression('dom'),
          'circle-opacity': 0.82,
          // Capped below the cluster radius (90) so bubbles cannot be drawn
          // wider than the spacing that separated them. The old ramp reached a
          // 76px diameter against a 55px radius, which guaranteed collisions
          // for any cluster above a couple of hundred points.
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'point_count'],
            2, 12, 25, 18, 200, 24, 2000, 30,
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      m.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: SOURCE,
        filter: ['==', ['get', 'cluster'], true],
        layout: {
          'text-field': ['to-string', ['get', 'point_count_abbreviated']],
          'text-font': ['Open Sans Semibold'],
          'text-size': 12,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#ffffff' },
      });

      m.addLayer({
        id: 'points',
        type: 'circle',
        source: SOURCE,
        filter: ['!=', ['get', 'cluster'], true],
        paint: {
          'circle-color': categoryColorExpression('g'),
          // Size by notability so the eye lands on what matters.
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'r'],
            0, 4, 10, 6, 40, 9, 100, 13,
          ],
          'circle-opacity': 0.9,
          'circle-stroke-width': 1.2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Label only the most notable points, so the map stays readable.
      m.addLayer({
        id: 'point-labels',
        type: 'symbol',
        source: SOURCE,
        filter: ['all', ['!=', ['get', 'cluster'], true], ['>=', ['get', 'r'], 25]],
        layout: {
          'text-field': ['get', 'n'],
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-max-width': 11,
        },
        paint: {
          'text-color': '#2a2a2a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      });

      setReady(true);
    });

    onMapApi?.({
      fitTo: (points) => {
        if (points.length === 0) return;
        const bounds = points.reduce(
          (acc, p) => acc.extend(p),
          new maplibregl.LngLatBounds(points[0]!, points[0]!),
        );
        // Co-located members produce a zero-area bounds, which fitBounds cannot
        // frame; ease to the point at a close zoom instead.
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

  // Recompute clusters for the current viewport. Supercluster is fast enough to
  // run synchronously on every move — the whole corpus is already in memory,
  // which is the payoff of the baked-dataset architecture.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const refresh = (): void => {
      const zoom = m.getZoom();
      const bounds = m.getBounds();
      const bbox: [number, number, number, number] = [
        Math.max(bounds.getWest(), -180),
        Math.max(bounds.getSouth(), -85),
        Math.min(bounds.getEast(), 180),
        Math.min(bounds.getNorth(), 85),
      ];

      const nextDepth = indexDepthFor(zoom);
      if (nextDepth !== depthRef.current) {
        depthRef.current = nextDepth;
        setIndexDepth(nextDepth);
      }

      const clustered = index.getClusters(bbox, Math.round(zoom)) as AnyFeature[];

      const clusters = clustered.filter(isCluster);
      const points = clustered
        .filter((f): f is Exclude<AnyFeature, typeof f & { properties: { cluster: true } }> => !isCluster(f))
        .sort((a, b) => (b.properties as { r: number }).r - (a.properties as { r: number }).r);

      // Spend the budget on clusters first, then the most notable loose points.
      const kept = points.slice(0, pointBudget(clusters.length));

      // Colour comes from the whole membership; the label still names the most
      // notable member. Rebuild properties rather than mutating supercluster's,
      // whose objects belong to the index and are reused between queries.
      const features = [
        ...clusters.map((c) => ({
          ...c,
          properties: {
            cluster: true,
            cluster_id: c.properties.cluster_id,
            point_count: c.properties.point_count,
            point_count_abbreviated: c.properties.point_count_abbreviated,
            topName: c.properties.topName,
            topRank: c.properties.topRank,
            dom: dominantCategory(c.properties.counts),
          },
        })),
        ...kept,
      ];

      // The floor is now an outcome rather than an input; surface it so the
      // header can still say how deep the map is currently reaching.
      const effectiveFloor =
        kept.length > 0 ? (kept[kept.length - 1]!.properties as { r: number }).r : 0;

      const source = m.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!source) return;
      source.setData({ type: 'FeatureCollection', features } as GeoJSON);

      onViewportChange(features.length, zoom, effectiveFloor);
    };

    refresh();
    m.on('move', refresh);
    return () => {
      m.off('move', refresh);
    };
  }, [ready, index, onViewportChange]);

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
      // The label rides on its own point feature. Placing it on the polygon
      // would let MapLibre put it anywhere inside a hull that may be enormous.
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: n.c },
        properties: { q: n.q, label: n.n, rank: n.r },
      });
    }
    source.setData({ type: 'FeatureCollection', features });
  }, [ready, narratives]);

  // Reveal exactly one hull: the story being entered, else the one hovered.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const shown = highlightNarrative ?? hoveredNarrative ?? -1;
    for (const layer of ['narrative-fill', 'narrative-outline'] as const) {
      if (m.getLayer(layer)) {
        m.setFilter(layer, ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'q'], shown]]);
      }
    }
  }, [ready, highlightNarrative, hoveredNarrative]);

  // Interaction: clusters zoom in, points select.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const clearPeekTimers = (): void => {
      window.clearTimeout(peekTimers.current.open);
      window.clearTimeout(peekTimers.current.close);
      peekTimers.current = {};
    };

    const closePeek = (): void => {
      clearPeekTimers();
      peekCluster.current = null;
      setPeek(null);
    };

    const openPeekFor = (feature: maplibregl.MapGeoJSONFeature): void => {
      const clusterId = feature.properties?.['cluster_id'] as number | undefined;
      if (clusterId === undefined || peekCluster.current === clusterId) return;

      clearPeekTimers();
      peekTimers.current.open = window.setTimeout(() => {
        const members = rankedMembers(index, clusterId);
        if (members.length === 0) return;
        const [lon, lat] = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
        const point = m.project([lon, lat]);
        peekCluster.current = clusterId;
        setPeek({ members: members.slice(0, PEEK_LIMIT), x: point.x, y: point.y, total: members.length });
      }, PEEK_OPEN_MS);
    };

    const onClusterHover = (e: maplibregl.MapMouseEvent): void => {
      const feature = m.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
      if (feature) openPeekFor(feature);
    };

    // The card is pointer-transparent, so leaving the cluster genuinely means
    // leaving — no grace period needed, and none wanted.
    const onClusterOut = closePeek;

    /*
     * One click handler with an explicit priority order, rather than several
     * layer handlers racing.
     *
     * Order matters and is not uniform across the narrative layers. A story's
     * anchor is a small, deliberate target and must win over the event pins it
     * often sits beneath — the World War II anchor sat under a 42-event cluster
     * and was simply unreachable. A story's *hull*, by contrast, covers much of
     * the map by design, so events must win over that.
     *
     *   1. narrative anchor / label   (small, intentional)
     *   2. event clusters and pins
     *   3. narrative hull             (vast background)
     */
    const onMapClick = (e: maplibregl.MapMouseEvent): void => {
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

      const cluster = m.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
      if (cluster) {
        onClusterClick(cluster);
        return;
      }

      const point = m.queryRenderedFeatures(e.point, { layers: ['points'] })[0];
      if (point) {
        onSelect(point.properties?.['q'] as number);
        return;
      }

      const hull = m.queryRenderedFeatures(e.point, { layers: ['narrative-fill'] })[0];
      const hullQ = hull?.properties?.['q'] as number | undefined;
      if (hullQ !== undefined) onSelectNarrative?.(hullQ);
    };

    const onClusterClick = (feature: maplibregl.MapGeoJSONFeature): void => {
      const clusterId = feature.properties?.['cluster_id'] as number;

      /*
       * Clicking a cluster opens its contents rather than zooming.
       *
       * Zoom-to-expand made reaching an article a multi-click descent, which is
       * the problem this change exists to remove. Zooming is still available —
       * double-click, scroll, and the "Zoom to these" action in the panel — but
       * it is no longer the toll for reading something.
       */
      closePeek();
      onSelectGroup(rankedMembers(index, clusterId).map((p) => p.q));
    };

    const pointer = () => { m.getCanvas().style.cursor = 'pointer'; };
    const reset = () => { m.getCanvas().style.cursor = ''; };

    m.on('click', onMapClick);
    const onNarrativeEnter = (e: maplibregl.MapMouseEvent): void => {
      const q = m.queryRenderedFeatures(e.point, {
        layers: ['narrative-anchor', 'narrative-label'],
      })[0]?.properties?.['q'];
      if (typeof q === 'number') setHoveredNarrative(q);
    };
    const onNarrativeLeave = (): void => setHoveredNarrative(null);

    m.on('mousemove', 'narrative-anchor', onNarrativeEnter);
    m.on('mouseleave', 'narrative-anchor', onNarrativeLeave);
    m.on('mouseenter', 'narrative-anchor', pointer);
    m.on('mouseleave', 'narrative-anchor', reset);
    m.on('mousemove', 'clusters', onClusterHover);
    m.on('mouseleave', 'clusters', onClusterOut);
    // Any camera movement invalidates the card's anchor position.
    m.on('movestart', closePeek);
    for (const layer of ['clusters', 'points'] as const) {
      m.on('mouseenter', layer, pointer);
      m.on('mouseleave', layer, reset);
    }

    return () => {
      clearPeekTimers();
      m.off('click', onMapClick);
      m.off('mousemove', 'narrative-anchor', onNarrativeEnter);
      m.off('mouseleave', 'narrative-anchor', onNarrativeLeave);
      m.off('mouseenter', 'narrative-anchor', pointer);
      m.off('mouseleave', 'narrative-anchor', reset);
      m.off('mousemove', 'clusters', onClusterHover);
      m.off('mouseleave', 'clusters', onClusterOut);
      m.off('movestart', closePeek);
      for (const layer of ['clusters', 'points'] as const) {
        m.off('mouseenter', layer, pointer);
        m.off('mouseleave', layer, reset);
      }
    };
  }, [ready, index, onSelect, onSelectGroup, onSelectNarrative]);

  // The peek sits outside the container MapLibre owns. React and MapLibre both
  // mutating one node's children is asking for trouble; the wrapper keeps each
  // to its own subtree.
  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      {peek && <ClusterPeek peek={peek} />}
    </div>
  );
}
