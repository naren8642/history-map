/**
 * How many map features to aim for, and how to get there.
 *
 * The first design tied a notability floor to zoom alone. Measured against the
 * real corpus over central Europe (1900–1950), that produced ~100–150 features
 * from zoom 2.7 through 6 and then fell off a cliff:
 *
 *   zoom 2.7  floor 30  2,127 in view  110 drawn
 *   zoom 5    floor  7  1,078 in view  149 drawn   <- peak crowding
 *   zoom 7.5  floor  2     33 in view   18 drawn   <- cliff
 *   zoom 9    floor  0      9 in view    5 drawn
 *
 * Zoom is the wrong input. What governs legibility is how many events are
 * actually in view, which depends on zoom *and* the width of the time window
 * *and* how dense that region happens to be. So instead of deriving a floor
 * from zoom, we take the most notable points that fit a feature budget and let
 * the effective floor fall out of the data.
 *
 * This also self-tunes as the corpus grows: adding P580 spans and P571
 * structures in milestone 6 will not require retuning a threshold table.
 */

/**
 * Target number of rendered features. Chosen so bubbles have room to breathe on
 * a typical viewport: at cluster radius 90 a ~1200x700 map holds roughly 100
 * non-overlapping cells, so a budget near that keeps the map full without
 * forcing collisions.
 */
export const FEATURE_BUDGET = 90;

/**
 * Clusters are never dropped — a cluster is the only signal that something is
 * present at all, and hiding one would erase a whole region. So the budget is
 * spent on clusters first and individual points get whatever remains.
 */
export function pointBudget(clusterCount: number): number {
  return Math.max(0, FEATURE_BUDGET - clusterCount);
}
