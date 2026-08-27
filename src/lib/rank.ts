/**
 * Zoom-dependent notability floor.
 *
 * §6 of the plan: density is the real problem, not sparsity. Clustering alone
 * is not enough — at world zoom a cluster bubble reading "4,812" tells the user
 * nothing. So below each zoom threshold we simply hide low-rank events, and
 * lower the bar as the user zooms in. "Zoom in for more" is the organizing idea.
 *
 * Thresholds are eyeballed against the measured rank distribution of the
 * curated corpus (rank>=20 is ~9% of events, rank>=10 ~21%, rank>=5 ~36%).
 */

const FLOORS: ReadonlyArray<readonly [minZoom: number, floor: number]> = [
  [0, 30],
  [3, 18],
  [4, 12],
  [5, 7],
  [6, 4],
  [7, 2],
  [8, 1],
  [9, 0],
];

export function rankFloor(zoom: number): number {
  let floor = 0;
  for (const [minZoom, value] of FLOORS) {
    if (zoom >= minZoom) floor = value;
  }
  return floor;
}
