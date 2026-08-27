/**
 * Summary retrieval: baked store first, live Wikipedia second.
 *
 * The baked store (scripts/prefetch-summaries.ts) covers events that have an
 * article, sharded by QID. A miss is not an error — the store is an
 * optimisation, and the live REST API is the fallback for anything not baked
 * or baked before the article existed.
 */

import { type BakedSummary, type SummaryManifest } from './summaries.ts';
import type { HistoryEvent } from '../types.ts';

const STORE_BASE = '/data/summaries';
const REST_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary';

/**
 * Browsers forbid setting User-Agent, but Wikimedia accepts Api-User-Agent for
 * exactly this case and lists it in the endpoint's access-control-allow-headers.
 */
const API_USER_AGENT = 'history-map/0.1 (https://github.com/naren/history-map)';

export type SummaryFailure = 'missing' | 'disambiguation' | 'error';

export type LiveResult =
  | { ok: true; summary: BakedSummary }
  | { ok: false; reason: SummaryFailure };

interface SummaryResponse {
  type?: string;
  extract?: string;
  thumbnail?: { source?: string };
  revision?: number | string;
  wikibase_item?: string;
}

// ---------------------------------------------------------------- baked store

let manifestPromise: Promise<SummaryManifest | null> | null = null;
const shardPromises = new Map<number, Promise<Map<number, BakedSummary>>>();

function loadManifest(): Promise<SummaryManifest | null> {
  manifestPromise ??= fetch(`${STORE_BASE}/manifest.json`)
    .then((res) => (res.ok ? (res.json() as Promise<SummaryManifest>) : null))
    // No store is a supported configuration: the app then runs purely live.
    .catch(() => null);
  return manifestPromise;
}

function loadShard(shard: number): Promise<Map<number, BakedSummary>> {
  let promise = shardPromises.get(shard);
  if (!promise) {
    promise = fetch(`${STORE_BASE}/${shard}.json`)
      .then(async (res) => {
        if (!res.ok) return new Map<number, BakedSummary>();
        const list = (await res.json()) as BakedSummary[];
        return new Map(list.map((s) => [s.q, s]));
      })
      .catch(() => new Map<number, BakedSummary>());
    shardPromises.set(shard, promise);
  }
  return promise;
}

export async function getBakedSummary(qid: number): Promise<BakedSummary | null> {
  const manifest = await loadManifest();
  if (!manifest) return null;
  // Trust the manifest over the local constant: a store generated with a
  // different shard count would otherwise be read at the wrong offsets.
  const shard = await loadShard(qid % manifest.shardCount);
  return shard.get(qid) ?? null;
}

// ----------------------------------------------------------------- live fetch

/**
 * In-flight requests are shared by title so repeated clicks on one pin issue a
 * single request. Note that no AbortSignal is threaded in here on purpose: with
 * a shared promise, one caller aborting would cancel the request out from under
 * every other caller waiting on it. Staleness is handled at the call site,
 * which discards results it no longer wants.
 */
const inFlight = new Map<string, Promise<LiveResult>>();

export function fetchLiveSummary(event: HistoryEvent): Promise<LiveResult> {
  const title = event.w;
  if (!title) return Promise.resolve({ ok: false, reason: 'missing' });

  const existing = inFlight.get(title);
  if (existing) return existing;

  const request = (async (): Promise<LiveResult> => {
    try {
      const url = `${REST_BASE}/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      const res = await fetch(url, { headers: { 'Api-User-Agent': API_USER_AGENT } });

      // Wikidata sitelinks lag page renames, so this is expected at some rate
      // rather than exceptional.
      if (res.status === 404) return { ok: false, reason: 'missing' };
      if (!res.ok) return { ok: false, reason: 'error' };

      const data = (await res.json()) as SummaryResponse;
      if (data.type === 'disambiguation') return { ok: false, reason: 'disambiguation' };

      // The response names the entity it describes. A disagreement means the
      // sitelink is stale and this is some other subject's article.
      if (data.wikibase_item && data.wikibase_item !== `Q${event.q}`) {
        return { ok: false, reason: 'missing' };
      }

      const extract = data.extract?.trim();
      if (!extract) return { ok: false, reason: 'missing' };

      const summary: BakedSummary = { q: event.q, x: extract };
      if (data.thumbnail?.source) summary.img = data.thumbnail.source;
      const rev = Number(data.revision);
      if (Number.isFinite(rev)) summary.rev = rev;
      return { ok: true, summary };
    } catch {
      return { ok: false, reason: 'error' };
    } finally {
      inFlight.delete(title);
    }
  })();

  inFlight.set(title, request);
  return request;
}

/** Wikipedia URL for an event, or null when it has no article. */
export function articleUrl(event: HistoryEvent): string | null {
  if (!event.w) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(event.w.replace(/ /g, '_'))}`;
}

export const wikidataUrl = (qid: number): string => `https://www.wikidata.org/wiki/Q${qid}`;
