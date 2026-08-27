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
import type { HistoryEvent, Category } from '../types.ts';

/** Per-point properties carried into the index. */
export interface PointProps {
  q: number;
  n: string;
  g: Category;
  r: number;
  /** Seeds the reduce, so clusters and points share a shape. */
  topRank: number;
  topName: string;
  topCategory: Category;
}

/** Accumulated cluster properties. */
export interface ClusterProps {
  topRank: number;
  topName: string;
  topCategory: Category;
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
    radius: 55,
    maxZoom,
    // Co-located events (160 State of the Union addresses on the US Capitol)
    // must still collapse into one bubble at every zoom, so clustering has to
    // stay active all the way in.
    minPoints: 2,
    map: (props): ClusterProps => ({
      topRank: props.r,
      topName: props.n,
      topCategory: props.g,
    }),
    reduce: (accumulated, props): void => {
      if (props.topRank > accumulated.topRank) {
        accumulated.topRank = props.topRank;
        accumulated.topName = props.topName;
        accumulated.topCategory = props.topCategory;
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
        topCategory: e.g,
      },
    })),
  );

  return index;
}

export const isCluster = (f: AnyFeature): f is ClusterFeature =>
  (f.properties as { cluster?: boolean }).cluster === true;

/** Cap on leaves pulled from one cluster; the US Capitol holds ~160. */
const MAX_LEAVES = 500;

export function clusterLeaves(
  index: Supercluster<PointProps, ClusterProps>,
  clusterId: number,
): PointFeature[] {
  return index.getLeaves(clusterId, MAX_LEAVES) as PointFeature[];
}

/**
 * True when every leaf sits on the identical coordinate.
 *
 * This — not the expansion zoom — is the right test for "zooming will not help".
 * Coordinates are stored to 4dp, and 160 State of the Union addresses all carry
 * the US Capitol's exact position: no zoom level can ever separate points that
 * are not actually apart, so the click must open a list instead of zooming.
 *
 * Partial overlap resolves itself: a cluster mixing the Capitol stack with
 * nearby events is not co-located, so it zooms; the stack then forms its own
 * cluster further in, and that one opens the list.
 */
export function isCoLocated(leaves: readonly PointFeature[]): boolean {
  if (leaves.length < 2) return false;
  const [first] = leaves;
  if (!first) return false;
  const [lon, lat] = first.geometry.coordinates as [number, number];
  return leaves.every((l) => {
    const [a, b] = l.geometry.coordinates as [number, number];
    return a === lon && b === lat;
  });
}
