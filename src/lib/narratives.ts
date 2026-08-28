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
