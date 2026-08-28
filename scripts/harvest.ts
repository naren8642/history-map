/**
 * Milestone 1 — harvest spike.
 *
 * Pulls P585 (point-in-time) events that carry coordinates, normalizes them,
 * and writes a flat JSON array. Deliberately narrow: P580/P582 spans and the
 * gated P571 inception slice come later, once this shape is proven.
 *
 * Usage:
 *   npm run harvest                       # full range
 *   npm run harvest -- --from 1800 --to 1850
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { sparql, SplittableError } from './lib/sparql.ts';
import { seedChunks, bisect, yearLiteral, describeChunk, type Chunk } from './lib/chunk.ts';
import { normalize, emptyStats, type EventRecord } from './lib/normalize.ts';

/** Earliest year we ask for. Wikidata has sparse but real coverage well into BCE. */
const DEFAULT_FROM = -4000;
const DEFAULT_TO = 2030;

/**
 * If a chunk returns at least this many rows, we split it anyway. A chunk that
 * large is suspicious: WDQS may be truncating, and we'd never know.
 */
const ROW_SUSPICION_THRESHOLD = 20_000;

const OUT_DIR = 'data/raw';

/**
 * Two harvest passes.
 *
 * `point` is the original P585 instant-event pass. `span` adds P580/P582
 * events — wars, sieges, campaigns, occupations — which were entirely absent
 * before. That absence mattered more than it looked: World War II itself is a
 * span, so the corpus contained hundreds of its battles and not the war.
 */
export type Mode = 'point' | 'span';

const OUT_FILE: Record<Mode, string> = {
  point: `${OUT_DIR}/p585.json`,
  span: `${OUT_DIR}/p580.json`,
};

function buildQuery(chunk: Chunk, mode: Mode): string {
  // The two passes differ only in which date property anchors the chunk, and
  // whether an end date is collected. Keeping the rest identical means
  // normalize.ts needs no knowledge of which pass produced a row.
  const anchor =
    mode === 'point'
      ? `?i p:P585/psv:P585 ?tv .`
      : `?i p:P580/psv:P580 ?tv .`;
  const endClause = mode === 'span' ? `  OPTIONAL { ?i wdt:P582 ?endT }` : '';

  return `
SELECT ?i ?iLabel ?coord ?t ?prec ?endT ?sl ?type ?article ?globe ?desc ?parent WHERE {
  ${anchor}
  ?tv wikibase:timeValue ?t ; wikibase:timePrecision ?prec .
  FILTER(?t >= "${yearLiteral(chunk.from)}"^^xsd:dateTime && ?t < "${yearLiteral(chunk.to)}"^^xsd:dateTime)
  ?i wdt:P625 ?coord ; wikibase:sitelinks ?sl .
${endClause}
  OPTIONAL { ?i p:P625/psv:P625/wikibase:geoGlobe ?globe }
  OPTIONAL { ?i wdt:P31 ?type }
  OPTIONAL { ?article schema:about ?i ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?i schema:description ?desc FILTER(lang(?desc) = "en") }
  OPTIONAL { ?i wdt:P361 ?parent }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}`.trim();
}

function parseArgs(argv: string[]): { from: number; to: number; out: string; mode: Mode } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : undefined;
  };
  const from = get('--from') ?? DEFAULT_FROM;
  const to = get('--to') ?? DEFAULT_TO;
  const mode: Mode = argv.includes('--span') ? 'span' : 'point';
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? (argv[outIdx + 1] ?? OUT_FILE[mode]) : OUT_FILE[mode];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error(`bad range: --from ${from} --to ${to}`);
  }
  return { from, to, out, mode };
}

async function main(): Promise<void> {
  const { from, to, out, mode } = parseArgs(process.argv.slice(2));

  const events = new Map<number, EventRecord>();
  const stats = emptyStats();

  // Work as a stack so bisected halves are processed immediately, keeping
  // progress output in rough chronological order.
  const queue: Chunk[] = seedChunks(from, to).reverse();
  const startedAt = Date.now();

  let queries = 0;
  let splits = 0;
  const problems: string[] = [];

  console.log(
    `harvest ${mode === 'point' ? 'P585 (instants)' : 'P580/P582 (spans)'}  ` +
      `range ${from}..${to}  seeded ${queue.length} chunks\n`,
  );

  while (queue.length > 0) {
    const chunk = queue.pop()!;
    const label = describeChunk(chunk);

    let bindings;
    try {
      queries++;
      bindings = await sparql(buildQuery(chunk, mode));
    } catch (err) {
      const halves = err instanceof SplittableError ? bisect(chunk) : null;

      if (halves) {
        splits++;
        const kind = err instanceof Error ? err.name : 'error';
        console.log(`  ${label.padEnd(20)} ${kind} -> split`);
        queue.push(halves[1], halves[0]);
        continue;
      }

      // Either not a timeout, or already at minimum width. Record and move on
      // rather than aborting a multi-minute run over one bad range.
      const reason = err instanceof Error ? err.message : String(err);
      problems.push(`${label}: ${reason}`);
      console.log(`  ${label.padEnd(20)} FAILED (${reason.slice(0, 60)})`);
      continue;
    }

    if (bindings.length >= ROW_SUSPICION_THRESHOLD) {
      const halves = bisect(chunk);
      if (halves) {
        splits++;
        console.log(`  ${label.padEnd(20)} ${bindings.length} rows -> split (possible truncation)`);
        queue.push(halves[1], halves[0]);
        continue;
      }
      problems.push(`${label}: ${bindings.length} rows at minimum chunk width`);
    }

    const before = events.size;
    normalize(bindings, stats, events);
    console.log(
      `  ${label.padEnd(20)} ${String(bindings.length).padStart(6)} rows  ` +
        `+${String(events.size - before).padStart(5)} events  (${events.size} total)`,
    );
  }

  const records = [...events.values()].sort((a, b) => b.r - a.r);
  const withParent = records.filter((r) => r.pa && r.pa.length > 0).length;
  const json = JSON.stringify(records);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(out, json);

  const gzipped = gzipSync(Buffer.from(json)).length;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

  console.log(`
--- harvest complete ---
  elapsed        ${elapsed}s over ${queries} queries (${splits} splits)
  rows seen      ${stats.seen}
  events kept    ${records.length}
  with parent    ${withParent} (${((withParent / Math.max(records.length, 1)) * 100).toFixed(1)}%)
  rejected       ${JSON.stringify(stats.rejected)}
  bytes/event    ${(json.length / Math.max(records.length, 1)).toFixed(0)}
  raw            ${(json.length / 1024 / 1024).toFixed(2)} MB
  gzipped        ${(gzipped / 1024 / 1024).toFixed(2)} MB
  written        ${out}`);

  if (problems.length > 0) {
    console.log(`\n  PROBLEMS (${problems.length}):`);
    for (const p of problems) console.log(`    ${p}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
