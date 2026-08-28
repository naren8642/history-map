/**
 * Supercluster wiring.
 *
 * The reason for supercluster rather than MapLibre's built-in clustering: we
 * want a cluster to advertise the *name* of its most notable member, not a bare
 * count. "Battle of Waterloo +47" tells the user what is under the bubble;
 * "48" does not. Carrying a string tied to the max needs a real reduce, which
 * is supercluster's map/reduce and not MapLibre's numeric cluster properties.
 */

import Supercluster from 'supercluster';
import { CATEGORY_TIEBREAK, type Category, type HistoryEvent } from '../types.ts';

/** Category tallies within a cluster, accumulated through the reduce. */
export type CategoryCounts = Partial<Record<Category, number>>;

/** Per-point properties carried into the index. */
export interface PointProps {
  q: number;
  n: string;
  g: Category;
  r: number;
  /** Seeds the reduce, so clusters and points share a shape. */
  topRank: number;
  topName: string;
  counts: CategoryCounts;
}

/** Accumulated cluster properties. */
export interface ClusterProps {
  topRank: number;
  topName: string;
  counts: CategoryCounts;
}

export type ClusterFeature = Supercluster.ClusterFeature<ClusterProps>;
export type PointFeature = Supercluster.PointFeature<PointProps>;
export type AnyFeature = ClusterFeature | PointFeature;

/**
 * Zoom depths the index is ever built to. Supercluster builds one KD-tree per
 * zoom level, so build cost scales with depth: the full corpus takes 88ms at
 * depth 15 but only 23ms at depth 4. At world zoom the deep trees are never
 * queried, so building them is pure waste — and that waste is what made
 * scrubbing a millennium-wide window stutter.
 *
 * Banded rather than continuous so that zooming crosses a rebuild boundary a
 * few times, not at every integer zoom level.
 */
const DEPTH_BANDS: readonly number[] = [4, 8, 12, 16];

/**
 * Smallest depth band that still exceeds the query zoom. It must never be
 * below it: querying above an index's maxZoom returns unclustered points, so
 * an under-built index would dump every raw point onto the map.
 */
export function indexDepthFor(zoom: number): number {
  const needed = Math.ceil(zoom) + 1;
  return DEPTH_BANDS.find((b) => b >= needed) ?? DEPTH_BANDS[DEPTH_BANDS.length - 1]!;
}

export function buildIndex(
  events: HistoryEvent[],
  maxZoom: number,
): Supercluster<PointProps, ClusterProps> {
  const index = new Supercluster<PointProps, ClusterProps>({
    /*
     * Must exceed the largest rendered bubble diameter (60px at the cap in
     * MapView), or clusters collide by construction: the previous 55px radius
     * against bubbles up to 76px across is exactly why mid-zoom Europe looked
     * like overlapping soup.
     */
    radius: 90,
    maxZoom,
    // Co-located events (160 State of the Union addresses on the US Capitol)
    // must still collapse into one bubble at every zoom, so clustering has to
    // stay active all the way in.
    minPoints: 2,
    map: (props): ClusterProps => ({
      topRank: props.r,
      topName: props.n,
      counts: { ...props.counts },
    }),
    reduce: (accumulated, props): void => {
      // Label still comes from the most notable member — "Waterloo +47" is far
      // more informative than a bare count.
      if (props.topRank > accumulated.topRank) {
        accumulated.topRank = props.topRank;
        accumulated.topName = props.topName;
      }
      // Colour, however, must come from the whole membership. Colouring by the
      // top-ranked member alone painted 52.8% of clusters a category that was
      // not their majority — one 25-event cluster read as "politics" when
      // politics was 12% of it and conflict 48%.
      for (const [category, n] of Object.entries(props.counts)) {
        const key = category as Category;
        accumulated.counts[key] = (accumulated.counts[key] ?? 0) + (n ?? 0);
      }
    },
  });

  index.load(
    events.map((e) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [e.c[0], e.c[1]] },
      properties: {
        q: e.q,
        n: e.n,
        g: e.g,
        r: e.r,
        topRank: e.r,
        topName: e.n,
        counts: { [e.g]: 1 },
      },
    })),
  );

  return index;
}

export const isCluster = (f: AnyFeature): f is ClusterFeature =>
  (f.properties as { cluster?: boolean }).cluster === true;

/** Most common category in a cluster; ties broken by CATEGORY_TIEBREAK. */
export function dominantCategory(counts: CategoryCounts): Category {
  let best: Category = 'other';
  let bestCount = -1;
  for (const category of CATEGORY_TIEBREAK) {
    const n = counts[category] ?? 0;
    if (n > bestCount) {
      best = category;
      bestCount = n;
    }
  }
  return best;
}

/** Cap on leaves pulled from one cluster; the US Capitol holds ~160. */
const MAX_LEAVES = 500;

export function clusterLeaves(
  index: Supercluster<PointProps, ClusterProps>,
  clusterId: number,
): PointFeature[] {
  return index.getLeaves(clusterId, MAX_LEAVES) as PointFeature[];
}

