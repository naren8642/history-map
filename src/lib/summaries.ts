/**
 * Shape of the baked summary store, shared by the prefetch script and the app.
 *
 * Sharded by QID so the client fetches ~1/64th of the store to answer a click,
 * and that one fetch then covers many later clicks. A manifest records the
 * shard count so the client never has to guess or probe for 404s.
 */

export interface BakedSummary {
  /** QID integer, matching HistoryEvent.q. */
  q: number;
  /** Wikipedia extract, verbatim. CC BY-SA — must be attributed wherever shown. */
  x?: string;
  /** Thumbnail URL on upload.wikimedia.org. */
  img?: string;
  /** Revision the extract came from. Provenance, and the basis for refreshing. */
  rev?: number;
  /**
   * Reserved for LLM-synthesized narrative (roadmap §12).
   *
   * Deliberately a *separate field* from `x` rather than something merged into
   * it. Sourced and generated prose must stay distinguishable all the way to
   * the renderer, so the UI can label the generated part and keep it
   * subordinate to the cited article. Merging them here would make that
   * distinction unrecoverable downstream.
   */
  syn?: string;
}

export interface SummaryManifest {
  shardCount: number;
  /** Number of summaries baked. */
  count: number;
  /** ISO timestamp of the run that produced this store. */
  generated: string;
}

export const SHARD_COUNT = 64;

/** Stable, cheap, and computable on both sides without a lookup table. */
export const shardFor = (qid: number): number => qid % SHARD_COUNT;
