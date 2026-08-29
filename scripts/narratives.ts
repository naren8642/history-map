/**
 * Build the narrative layer from P361 links found during harvest.
 *
 * Events name their parents by QID but carry nothing about them, and the
 * parents themselves are not in the harvest at all — they have no coordinates,
 * so the geo-anchored harvest queries can never reach them. This pass resolves
 * that set, walks *up* the DAG until it reaches roots, and derives each
 * narrative's geography from the events beneath it.
 *
 * Resolution uses SPARQL VALUES batches rather than an aggregate query:
 * grouping over all of P361 times out on WDQS, while asking about 200 known
 * QIDs at a time is fast and predictable.
 *
 * Usage: npx tsx scripts/narratives.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { sparql, SplittableError } from './lib/sparql.ts';
import { DELIBERATELY_EXCLUDED } from './lib/taxonomy.ts';
import type { EventRecord } from './lib/normalize.ts';
import type { PolityRecord } from './harvest-polities.ts';
import { centroid, convexHull, type Narrative } from '../src/lib/narratives.ts';

const INPUTS = ['data/raw/p585.json', 'data/raw/p580.json'];
const POLITIES = 'data/raw/polities.json';
const OUT = 'data/raw/narratives.json';

/** QIDs per SPARQL VALUES batch. */
const BATCH = 200;
/** Below this a batch is too small to be worth halving again. */
const MIN_BATCH = 10;
/** Safety bound on walking up the DAG. */
const MAX_LEVELS = 6;

/**
 * Timeline domain, matching src/lib/timescale.ts.
 *
 * P361 and the polity types reach into deep time: Phanerozoic (538 million BCE)
 * and Cenozoic (66 million BCE) both arrive as "historical periods". A single
 * such record would flatten a 3000 BCE–2030 axis into nothing, so anything
 * ending before the domain starts is dropped, and anything merely beginning
 * earlier is clipped to the domain edge — the Neolithic is real history, it
 * just starts off the left of our chart.
 */
const DOMAIN_START = -3000;
const DOMAIN_END = 2030;

interface Resolved {
  q: number;
  n: string;
  d?: string;
  w?: string;
  s: number;
  e: number;
  r: number;
  parents: number[];
  types: number[];
}

const qidToInt = (uri: string): number | null => {
  const m = /Q(\d+)$/.exec(uri);
  return m ? Number(m[1]) : null;
};

const parseYear = (iso: string): number | null => {
  const m = /^(-?)(\d{4,})-/.exec(iso);
  if (!m) return null;
  const y = Number(m[2]);
  return Number.isFinite(y) ? (m[1] === '-' ? -y : y) : null;
};

const articleTitle = (url: string): string | undefined => {
  const m = /\/wiki\/(.+)$/.exec(url);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ');
  } catch {
    return m[1].replace(/_/g, ' ');
  }
};

/**
 * Resolve one batch of candidate narratives.
 *
 * The `NOT EXISTS ... wd:Q6256` filter excludes states that still exist today,
 * mirroring the polities harvest. It is needed in both places: events name
 * their country as a P361 parent, so Nigeria, Suriname and the Solomon Islands
 * re-entered through the event path even after the polity pass dropped them —
 * Nigeria at rank 350, above World War II, with one event beneath it.
 */
async function resolveBatch(qids: number[]): Promise<Map<number, Resolved>> {
  const values = qids.map((q) => `wd:Q${q}`).join(' ');
  const query = `
SELECT ?i ?iLabel ?desc ?article ?sl ?start ?end ?pit ?inception ?dissolved ?up ?type WHERE {
  VALUES ?i { ${values} }
  ?i wikibase:sitelinks ?sl .
  FILTER NOT EXISTS { ?i wdt:P31 wd:Q6256 }
  OPTIONAL { ?i wdt:P31 ?type }
  OPTIONAL { ?i wdt:P580 ?start }
  OPTIONAL { ?i wdt:P582 ?end }
  OPTIONAL { ?i wdt:P585 ?pit }
  OPTIONAL { ?i wdt:P571 ?inception }
  OPTIONAL { ?i wdt:P576 ?dissolved }
  OPTIONAL { ?i wdt:P361 ?up }
  OPTIONAL { ?i schema:description ?desc FILTER(lang(?desc) = "en") }
  OPTIONAL { ?article schema:about ?i ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}`.trim();

  const bindings = await sparql(query);
  const out = new Map<number, Resolved>();

  for (const b of bindings) {
    const q = b.i && qidToInt(b.i.value);
    if (!q) continue;

    const existing = out.get(q);
    const up = b.up ? qidToInt(b.up.value) : null;
    const type = b.type ? qidToInt(b.type.value) : null;
    if (existing) {
      if (up && !existing.parents.includes(up)) existing.parents.push(up);
      if (type && !existing.types.includes(type)) existing.types.push(type);
      continue;
    }

    const label = b.iLabel?.value?.trim();
    if (!label || /^Q\d+$/.test(label)) continue;

    // A narrative's span may come from P580/P582 or, for one-off happenings
    // used as parents, from a P585 instant.
    // Inception is how polities and long-lived institutions are dated; reading
    // only start/point-in-time was what lost most of the layer.
    const start = b.start
      ? parseYear(b.start.value)
      : b.pit
        ? parseYear(b.pit.value)
        : b.inception
          ? parseYear(b.inception.value)
          : null;
    const end = b.end
      ? parseYear(b.end.value)
      : b.dissolved
        ? parseYear(b.dissolved.value)
        : null;
    if (start === null) continue; // undated: cannot be placed on the timeline

    const rec: Resolved = {
      q,
      n: label,
      s: start,
      e: end !== null && end >= start ? end : start,
      r: Number(b.sl?.value) || 0,
      parents: up ? [up] : [],
      types: type ? [type] : [],
    };
    const desc = b.desc?.value?.trim();
    if (desc && desc !== label) rec.d = desc;
    const title = b.article ? articleTitle(b.article.value) : undefined;
    if (title) rec.w = title;

    out.set(q, rec);
  }
  return out;
}

/**
 * Halve a batch that times out, the same way the harvest chunker halves a date
 * range. Without this one slow batch of 200 aborted the entire pass — a whole
 * multi-minute run lost to a single unlucky query.
 */
async function resolveWithSplit(qids: number[]): Promise<Map<number, Resolved>> {
  try {
    return await resolveBatch(qids);
  } catch (err) {
    if (!(err instanceof SplittableError) || qids.length <= MIN_BATCH) {
      console.log(`    batch of ${qids.length} failed, skipping`);
      return new Map();
    }
    const mid = Math.floor(qids.length / 2);
    console.log(`    batch of ${qids.length} timed out -> splitting`);
    const left = await resolveWithSplit(qids.slice(0, mid));
    const right = await resolveWithSplit(qids.slice(mid));
    return new Map([...left, ...right]);
  }
}

async function resolveAll(
  seed: Set<number>,
  preResolved: Map<number, Resolved>,
): Promise<Map<number, Resolved>> {
  // Polities arrive already resolved by their own harvest pass. Re-querying
  // them was not merely wasteful, it was lossy: this resolver reads P580/P582
  // and P585 but never P571, and inception is how most historical polities are
  // dated. That silently discarded 1,364 of 1,446 of them as "undated" —
  // the Ottoman and Byzantine Empires, Ancient Egypt, the Holy Roman Empire,
  // the Soviet Union — 94% of the layer this pass exists to build.
  const resolved = new Map(preResolved);
  let frontier = [...seed].filter((q) => !resolved.has(q));

  // Ancestors of the pre-resolved set still need looking up.
  for (const r of preResolved.values()) {
    for (const up of r.parents) if (!resolved.has(up)) frontier.push(up);
  }

  for (let level = 0; level < MAX_LEVELS && frontier.length > 0; level++) {
    const pending = frontier.filter((q) => !resolved.has(q));
    if (pending.length === 0) break;

    console.log(`  level ${level}: resolving ${pending.length} candidates`);
    for (let i = 0; i < pending.length; i += BATCH) {
      const got = await resolveWithSplit(pending.slice(i, i + BATCH));
      for (const [q, r] of got) resolved.set(q, r);
    }

    // Walk up: this level's parents become the next frontier.
    const next = new Set<number>();
    for (const q of pending) {
      for (const up of resolved.get(q)?.parents ?? []) {
        if (!resolved.has(up)) next.add(up);
      }
    }
    frontier = [...next];
  }
  return resolved;
}

async function main(): Promise<void> {
  const events: EventRecord[] = [];
  for (const file of INPUTS) {
    try {
      events.push(...(JSON.parse(await readFile(file, 'utf8')) as EventRecord[]));
    } catch {
      console.log(`  (skipping ${file} — not present)`);
    }
  }
  console.log(`narratives: ${events.length.toLocaleString()} events loaded\n`);

  /*
   * Two independent sources of narratives, merged.
   *
   * Bottom-up: whatever events say they are part of (P361). Finds wars and
   * campaigns, but only where events happen to be linked.
   *
   * Top-down: the polities pass. This is what carries non-European history —
   * for 0-1500 CE, 81.8% of Wikidata's geolocated *events* are European, yet
   * Aksum, Kush, Mali, Songhai, Khmer, Srivijaya, Gupta and the Mongol Empire
   * all exist as dated polities. Relying on P361 alone would have reproduced
   * the event layer's bias in the story layer.
   */
  let polities: PolityRecord[] = [];
  try {
    polities = JSON.parse(await readFile(POLITIES, 'utf8')) as PolityRecord[];
  } catch {
    console.log('  (no polities file — run npm run harvest:polities)');
  }

  const seed = new Set<number>();
  for (const e of events) for (const p of e.pa ?? []) seed.add(p);
  const fromEvents = seed.size;

  // Polities carry everything a narrative needs — name, description, article,
  // span, rank, parents — so they seed the resolved set directly rather than
  // being looked up again.
  const preResolved = new Map<number, Resolved>();
  for (const p of polities) {
    preResolved.set(p.q, {
      q: p.q,
      n: p.n,
      s: p.s,
      e: p.e,
      r: p.r,
      parents: p.pa ?? [],
      types: p.t ?? [],
      ...(p.d ? { d: p.d } : {}),
      ...(p.w ? { w: p.w } : {}),
    });
  }

  console.log(
    `  ${fromEvents.toLocaleString()} P361 targets from events, ` +
      `${polities.length.toLocaleString()} polities pre-resolved\n`,
  );

  const resolved = await resolveAll(seed, preResolved);

  // A polity's own coordinate anchors it when too little sits beneath it to
  // form a hull — the common case in exactly the sparse regions this pass
  // exists to cover.
  const ownCoord = new Map<number, [number, number]>();
  const openEnded = new Set<number>();
  for (const p of polities) {
    if (p.c) ownCoord.set(p.q, p.c);
    if (p.o) openEnded.add(p.q);
  }
  console.log(`\n  ${resolved.size.toLocaleString()} narratives resolved\n`);

  // Direct membership: events and narratives that name this narrative as parent.
  const directEvents = new Map<number, EventRecord[]>();
  for (const e of events) {
    for (const p of e.pa ?? []) {
      if (!resolved.has(p)) continue;
      const list = directEvents.get(p) ?? [];
      list.push(e);
      directEvents.set(p, list);
    }
  }
  const childNarratives = new Map<number, number[]>();
  for (const [q, r] of resolved) {
    for (const up of r.parents) {
      if (!resolved.has(up)) continue;
      const list = childNarratives.get(up) ?? [];
      list.push(q);
      childNarratives.set(up, list);
    }
  }

  /**
   * All event coordinates beneath a narrative, following the DAG down.
   * `visiting` guards against cycles, which do occur in Wikidata.
   */
  const pointsCache = new Map<number, [number, number][]>();
  function pointsUnder(q: number, visiting = new Set<number>()): [number, number][] {
    const cached = pointsCache.get(q);
    if (cached) return cached;
    if (visiting.has(q)) return [];
    visiting.add(q);

    const points: [number, number][] = (directEvents.get(q) ?? []).map((e) => e.c);
    for (const child of childNarratives.get(q) ?? []) {
      points.push(...pointsUnder(child, visiting));
    }
    visiting.delete(q);
    pointsCache.set(q, points);
    return points;
  }

  // Depth from a root. A DAG node's depth is its shallowest path.
  function depthOf(q: number, visiting = new Set<number>()): number {
    const parents = (resolved.get(q)?.parents ?? []).filter((p) => resolved.has(p));
    if (parents.length === 0 || visiting.has(q)) return 0;
    visiting.add(q);
    const d = 1 + Math.min(...parents.map((p) => depthOf(p, visiting)));
    visiting.delete(q);
    return d;
  }

  const narratives: Narrative[] = [];
  let excludedByType = 0;
  let outOfDomain = 0;
  for (const [q, r] of resolved) {
    /*
     * Narratives need curating too.
     *
     * They are discovered from P361 links, which the event allowlist never
     * touches — so recurring sporting events, whose editions are "part of" the
     * series, arrived as top-ranked story nodes. The 2014 FIFA World Cup is not
     * a chapter of history alongside the Cold War.
     *
     * Any excluded type disqualifies, rather than the inclusion-wins rule used
     * for events: a World Cup that also carries a generic type is still a World
     * Cup, and there is no allowlist here to weigh against it.
     */
    if (r.types.some((t) => DELIBERATELY_EXCLUDED.has(t))) {
      excludedByType++;
      continue;
    }
    if (r.e < DOMAIN_START || r.s > DOMAIN_END) {
      outOfDomain++;
      continue;
    }
    const beneath = pointsUnder(q);
    const own = ownCoord.get(q);
    // Fall back to the polity's own coordinate when nothing geolocated sits
    // beneath it. Without this the Mongol Empire and Srivijaya would vanish for
    // want of linked child events, which is precisely the wrong outcome.
    const points = beneath.length > 0 ? beneath : own ? [own] : [];
    if (points.length === 0) continue;

    const narrative: Narrative = {
      q,
      n: r.n,
      s: Math.max(r.s, DOMAIN_START),
      e: Math.min(Math.max(r.e, r.s), DOMAIN_END),
      r: r.r,
      c: centroid(points),
      m: (directEvents.get(q)?.length ?? 0) + (childNarratives.get(q)?.length ?? 0),
      total: beneath.length,
      depth: depthOf(q),
    };
    if (openEnded.has(q)) narrative.o = true;
    if (r.d) narrative.d = r.d;
    if (r.w) narrative.w = r.w;
    const parents = r.parents.filter((p) => resolved.has(p));
    if (parents.length > 0) narrative.pa = parents;
    const hull = convexHull(points);
    if (hull.length >= 3) narrative.hull = hull;

    narratives.push(narrative);
  }

  narratives.sort((a, b) => b.r - a.r);
  const json = JSON.stringify(narratives);
  await writeFile(OUT, json);

  const roots = narratives.filter((n) => n.depth === 0);
  console.log(`--- narratives complete ---
  narratives     ${narratives.length.toLocaleString()}
  excluded       ${excludedByType.toLocaleString()} (sports/awards/eclipse types)
  out of domain  ${outOfDomain.toLocaleString()} (geological / deep prehistory)
  roots          ${roots.length.toLocaleString()}
  with hull      ${narratives.filter((n) => n.hull).length.toLocaleString()}
  max depth      ${Math.max(0, ...narratives.map((n) => n.depth))}
  raw            ${(json.length / 1024 / 1024).toFixed(2)} MB
  gzipped        ${(gzipSync(Buffer.from(json)).length / 1024 / 1024).toFixed(2)} MB
  written        ${OUT}

  top narratives by rank — REVIEW THIS LIST:
  (narratives are curated only by exclusion; anything that is not a chapter of
   history appearing here means a type still needs adding to taxonomy.ts)`);
  const yr = (v: number) => (v < 0 ? `${Math.abs(v)}BCE` : String(v));
  for (const n of narratives.slice(0, 40)) {
    const span = n.o ? `${yr(n.s)}–?` : `${yr(n.s)}–${yr(n.e)}`;
    console.log(
      `    rank ${String(n.r).padStart(3)}  ${span.padEnd(15)} ${String(n.total).padStart(4)} beneath  ` +
        `${n.n.slice(0, 40)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
