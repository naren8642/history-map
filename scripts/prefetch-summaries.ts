/**
 * Bake Wikipedia summaries for the highest-ranked events into a sharded store.
 *
 * Why prefetch at all, when the live REST API is CDN-backed and fast: it makes
 * the pins people actually click instant, it survives offline, and it gives the
 * planned LLM-synthesized narratives somewhere to live (see BakedSummary.syn).
 * The runtime still falls back to a live fetch for anything not baked, so this
 * store is an optimisation, never a requirement.
 *
 * Usage:
 *   npx tsx scripts/prefetch-summaries.ts              # top 2000 by rank
 *   npx tsx scripts/prefetch-summaries.ts --top 5000
 *   npx tsx scripts/prefetch-summaries.ts --all
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { SHARD_COUNT, shardFor, type BakedSummary, type SummaryManifest } from '../src/lib/summaries.ts';
import type { EventRecord } from './lib/normalize.ts';

const IN = 'data/raw/p585.curated.json';
const OUT_DIR = 'public/data/summaries';

const USER_AGENT = 'history-map-prefetch/0.1 (https://github.com/naren/history-map; naren.salem@gmail.com)';

/**
 * Wikimedia's REST guidance tolerates far more than this; the cap is set low
 * deliberately, since a build script has no reason to be aggressive.
 */
const CONCURRENCY = 6;
const DEFAULT_TOP = 2000;
const MAX_ATTEMPTS = 3;

/** Extracts run long; trimming keeps the store small without losing the gist. */
const MAX_EXTRACT_CHARS = 600;

interface SummaryResponse {
  type?: string;
  extract?: string;
  thumbnail?: { source?: string };
  revision?: number | string;
  wikibase_item?: string;
}

type Outcome = 'ok' | 'missing' | 'disambiguation' | 'mismatch' | 'empty' | 'failed';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSummary(
  event: EventRecord,
): Promise<{ outcome: Outcome; summary?: BakedSummary; detail?: string }> {
  const title = encodeURIComponent(event.w!.replace(/ /g, '_'));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });

      // A renamed page leaves the Wikidata sitelink pointing nowhere. Expected
      // at some rate; the count is the signal that the harvest needs refreshing.
      if (res.status === 404) return { outcome: 'missing' };

      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        return { outcome: 'failed', detail: `HTTP ${res.status}` };
      }
      if (!res.ok) return { outcome: 'failed', detail: `HTTP ${res.status}` };

      const data = (await res.json()) as SummaryResponse;

      if (data.type === 'disambiguation') return { outcome: 'disambiguation' };

      // The response names the entity it belongs to. If it disagrees with the
      // event we asked about, the sitelink is stale and we would be baking
      // someone else's article under this event's QID.
      if (data.wikibase_item && data.wikibase_item !== `Q${event.q}`) {
        return { outcome: 'mismatch', detail: `${data.wikibase_item} != Q${event.q}` };
      }

      const extract = data.extract?.trim();
      if (!extract) return { outcome: 'empty' };

      const summary: BakedSummary = {
        q: event.q,
        x: extract.length > MAX_EXTRACT_CHARS ? `${extract.slice(0, MAX_EXTRACT_CHARS).trimEnd()}…` : extract,
      };
      if (data.thumbnail?.source) summary.img = data.thumbnail.source;
      const rev = Number(data.revision);
      if (Number.isFinite(rev)) summary.rev = rev;

      return { outcome: 'ok', summary };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      return { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
  }
  return { outcome: 'failed', detail: 'exhausted retries' };
}

/** Fixed-size worker pool; simpler and more predictable than batching. */
async function pool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const topIdx = argv.indexOf('--top');
  const all = argv.includes('--all');
  const top = topIdx >= 0 ? Number(argv[topIdx + 1]) : DEFAULT_TOP;

  const events: EventRecord[] = JSON.parse(await readFile(IN, 'utf8'));

  // Only events with an article can have a summary at all.
  const candidates = events
    .filter((e) => e.w)
    .sort((a, b) => b.r - a.r)
    .slice(0, all ? undefined : top);

  console.log(
    `prefetch: ${candidates.length.toLocaleString()} of ${events.length.toLocaleString()} events ` +
      `(${events.filter((e) => e.w).length.toLocaleString()} have articles), concurrency ${CONCURRENCY}\n`,
  );

  const summaries: BakedSummary[] = [];
  const counts: Record<Outcome, number> = {
    ok: 0, missing: 0, disambiguation: 0, mismatch: 0, empty: 0, failed: 0,
  };
  const problems: string[] = [];
  const startedAt = Date.now();
  let done = 0;

  await pool(candidates, CONCURRENCY, async (event) => {
    const { outcome, summary, detail } = await fetchSummary(event);
    counts[outcome]++;
    if (summary) summaries.push(summary);
    if (outcome !== 'ok' && problems.length < 40) {
      problems.push(`${outcome.padEnd(15)} Q${event.q} ${event.n.slice(0, 40)}${detail ? ` (${detail})` : ''}`);
    }
    done++;
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - startedAt) / 1000);
      console.log(`  ${done}/${candidates.length}  ${rate.toFixed(1)}/s  ok=${counts.ok}`);
    }
  });

  // Rebuild the store from scratch so a shrunken run cannot leave stale shards.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const shards: BakedSummary[][] = Array.from({ length: SHARD_COUNT }, () => []);
  for (const s of summaries) shards[shardFor(s.q)]!.push(s);

  let rawBytes = 0;
  let gzipBytes = 0;
  for (let i = 0; i < SHARD_COUNT; i++) {
    const json = JSON.stringify(shards[i]);
    rawBytes += json.length;
    gzipBytes += gzipSync(Buffer.from(json)).length;
    await writeFile(`${OUT_DIR}/${i}.json`, json);
  }

  const manifest: SummaryManifest = {
    shardCount: SHARD_COUNT,
    count: summaries.length,
    generated: new Date().toISOString(),
  };
  await writeFile(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest));

  const shardSizes = shards.map((s) => s.length);
  console.log(`
--- prefetch complete ---
  elapsed        ${((Date.now() - startedAt) / 1000).toFixed(0)}s
  outcomes       ${JSON.stringify(counts)}
  baked          ${summaries.length.toLocaleString()} summaries across ${SHARD_COUNT} shards
  shard size     min ${Math.min(...shardSizes)}  max ${Math.max(...shardSizes)}
  raw            ${(rawBytes / 1024 / 1024).toFixed(2)} MB total, ${(rawBytes / SHARD_COUNT / 1024).toFixed(0)} KB/shard
  gzipped        ${(gzipBytes / 1024 / 1024).toFixed(2)} MB total, ${(gzipBytes / SHARD_COUNT / 1024).toFixed(0)} KB/shard`);

  if (problems.length > 0) {
    console.log(`\n  NON-OK OUTCOMES (first ${problems.length}):`);
    for (const p of problems) console.log(`    ${p}`);
  }
  const staleRate = ((counts.missing + counts.mismatch) / Math.max(candidates.length, 1)) * 100;
  console.log(`\n  sitelink staleness: ${staleRate.toFixed(2)}% (404 + QID mismatch)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
