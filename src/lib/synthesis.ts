/**
 * Client for the synthesized story overviews.
 *
 * Two rules the shape enforces rather than documents:
 *
 *  - **Generated prose stays separable from cited prose.** `overview` and
 *    `significance` are model-written and must be labelled as such wherever
 *    they appear; `sources` are checked URLs. The same reason `BakedSummary`
 *    keeps `syn` apart from `x`: merge them here and the renderer can no longer
 *    tell the reader which is which.
 *  - **A source carries how it was obtained.** `via` records whether a URL came
 *    from Wikidata's curated identifiers or from a retrieval the model actually
 *    performed. Nothing else is ever written — a citation the model produced
 *    from memory is dropped at synthesis time, not shipped and flagged.
 */

export interface SynthesisSource {
  url: string;
  title: string;
  via: 'wikipedia' | 'britannica' | 'retrieved';
}

export interface StorySynthesis {
  q: number;
  n: string;
  /** Model-written. Label it. */
  overview: string;
  /** Model-written. Label it. */
  significance: string;
  /** What it was written from, and what is thin or absent. */
  coverage: string;
  sources: SynthesisSource[];
  /** Which model wrote it, for the attribution line. */
  model: string;
}

const BASE = `${import.meta.env.BASE_URL}data/synthesis`;

let indexPromise: Promise<Set<number>> | null = null;
const storyPromises = new Map<number, Promise<StorySynthesis | null>>();

/**
 * Which stories have an overview. A missing index is a supported configuration
 * — the app then simply shows no overviews, rather than failing.
 */
export function loadSynthesisIndex(): Promise<Set<number>> {
  indexPromise ??= fetch(`${BASE}/index.json`)
    .then(async (res) => (res.ok ? new Set<number>(await res.json()) : new Set<number>()))
    .catch(() => new Set<number>());
  return indexPromise;
}

export function loadSynthesis(qid: number): Promise<StorySynthesis | null> {
  let promise = storyPromises.get(qid);
  if (!promise) {
    promise = fetch(`${BASE}/${qid}.json`)
      .then((res) => (res.ok ? (res.json() as Promise<StorySynthesis>) : null))
      .catch(() => null);
    storyPromises.set(qid, promise);
  }
  return promise;
}
