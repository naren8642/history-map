/**
 * Narrative objects: the "bigger picture" layer.
 *
 * A narrative is something events belong to — World War II, the Pacific War,
 * The Holocaust — discovered from P361 ("part of") links on geolocated events.
 *
 * Two properties make narratives different in kind from events, and shape
 * everything downstream:
 *
 *  1. **They have no coordinates.** A war is not a point. Every story node
 *     measured (WWII, Pacific War, Eastern Front, Battle of the Atlantic,
 *     The Holocaust) returns no P625. Their geography has to be *derived* from
 *     where their members happened, which is why each carries a hull.
 *
 *  2. **Membership is a DAG, not a tree.** The Second Sino-Japanese War is part
 *     of both World War II and the Pacific War. Nothing here may assume a
 *     single parent or a unique path to the root.
 */

import type { HistoryEvent } from '../types.ts';

export interface Narrative {
  /** QID integer. */
  q: number;
  /** Display name. */
  n: string;
  /** Wikidata one-line description. */
  d?: string;
  /** en.wikipedia article title. */
  w?: string;
  /** Start year, signed. */
  s: number;
  /** End year, signed. */
  e: number;
  /** Sitelink count — notability rank. WWII is 291, above any single event. */
  r: number;
  /** Narratives this one is part of. Several are possible. */
  pa?: number[];
  /**
   * Convex hull of member coordinates, as [lon, lat] pairs in order.
   * Absent when too few distinct members to form a polygon.
   */
  hull?: [number, number][];
  /** Representative point for labelling — the centroid of members. */
  c: [number, number];
  /** Direct member count (events plus child narratives). */
  m: number;
  /** Total events beneath this narrative, following the DAG down. */
  total: number;
  /** Depth from a root narrative; 0 means nothing contains it. */
  depth: number;
  /** No end date recorded. Render as "1050 – unknown", not a zero-length span. */
  o?: boolean;
  /**
   * Set when `c` is not where Wikidata says this is, because Wikidata does not
   * say. `derived` followed the capital or the recorded location; `coarse` fell
   * back to a country centroid. Absent means the point is the item's own P625
   * or the centroid of real member events.
   *
   * The UI must distinguish these: a derived point carries the same visual
   * weight as a surveyed one, and silently equating them is how a map starts
   * asserting things the source never said.
   */
  via?: 'derived' | 'coarse';
}

/**
 * Membership resolved on the client.
 *
 * The baked file stores each narrative's own parents but not its members —
 * writing member lists would duplicate the whole event corpus inside the
 * narrative file. Events already name their parents, so the reverse index is
 * cheap to build once at load and cheaper to ship.
 */
export interface NarrativeIndex {
  byQid: Map<number, Narrative>;
  /** Narratives directly contained by a narrative. */
  childrenOf: Map<number, Narrative[]>;
  /** Events naming this narrative as a direct parent. */
  eventsOf: Map<number, HistoryEvent[]>;
  /** Narratives nothing else contains. */
  roots: Narrative[];
}

export function buildNarrativeIndex(
  narratives: readonly Narrative[],
  events: readonly HistoryEvent[],
): NarrativeIndex {
  const byQid = new Map(narratives.map((n) => [n.q, n]));
  const childrenOf = new Map<number, Narrative[]>();
  const eventsOf = new Map<number, HistoryEvent[]>();

  for (const n of narratives) {
    for (const parent of n.pa ?? []) {
      if (!byQid.has(parent)) continue;
      const list = childrenOf.get(parent) ?? [];
      list.push(n);
      childrenOf.set(parent, list);
    }
  }
  for (const e of events) {
    for (const parent of e.pa ?? []) {
      if (!byQid.has(parent)) continue;
      const list = eventsOf.get(parent) ?? [];
      list.push(e);
      eventsOf.set(parent, list);
    }
  }

  const roots = narratives.filter((n) => (n.pa ?? []).every((p) => !byQid.has(p)));
  return { byQid, childrenOf, eventsOf, roots };
}

/**
 * Every event beneath a narrative, following containment down.
 *
 * `visiting` is not defensive padding: containment is a DAG with genuine cycles
 * in Wikidata, and a narrative can be reached by more than one path, so results
 * are deduplicated by QID as well.
 */
export function eventsUnder(
  index: NarrativeIndex,
  qid: number,
  seen = new Map<number, HistoryEvent>(),
  visiting = new Set<number>(),
): HistoryEvent[] {
  if (visiting.has(qid)) return [...seen.values()];
  visiting.add(qid);

  for (const e of index.eventsOf.get(qid) ?? []) seen.set(e.q, e);
  for (const child of index.childrenOf.get(qid) ?? []) {
    eventsUnder(index, child.q, seen, visiting);
  }
  visiting.delete(qid);
  return [...seen.values()];
}

/** Does a narrative's span overlap the visible window? */
export const overlapsWindow = (n: Narrative, from: number, to: number): boolean =>
  n.s < to && n.e >= from;

/** Closed GeoJSON ring for a narrative's hull, or null when it has none. */
export function hullRing(n: Narrative): [number, number][] | null {
  if (!n.hull || n.hull.length < 3) return null;
  return [...n.hull, n.hull[0]!];
}

/**
 * Andrew's monotone chain convex hull. O(n log n), no dependencies.
 * Returns [] for fewer than 3 distinct points.
 */
export function convexHull(points: readonly [number, number][]): [number, number][] {
  const unique = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()];
  if (unique.length < 3) return [];

  const sorted = [...unique].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (pts: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of pts) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

/** Mean position of member points, used to anchor the narrative's label. */
export function centroid(points: readonly [number, number][]): [number, number] {
  if (points.length === 0) return [0, 0];
  let lon = 0;
  let lat = 0;
  for (const [x, y] of points) {
    lon += x;
    lat += y;
  }
  return [
    Math.round((lon / points.length) * 1e4) / 1e4,
    Math.round((lat / points.length) * 1e4) / 1e4,
  ];
}
