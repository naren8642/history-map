/**
 * Trace one item through every pipeline stage and report where it was lost.
 *
 * "Why isn't X on the map?" is the question that recurs. The Chernobyl
 * disaster — rank 125, third in the corpus — was silently absent for weeks,
 * and each such case was diagnosed by hand with throwaway scripts. This turns
 * that into one command.
 *
 * Usage:
 *   npx tsx scripts/explain.ts Q1379              # by QID
 *   npx tsx scripts/explain.ts "Battle of Stonne" # by name (searches Wikidata)
 */

import { readFile } from 'node:fs/promises';
import { sparql } from './lib/sparql.ts';
import { ALLOWED, DELIBERATELY_EXCLUDED, categoryFor } from './lib/taxonomy.ts';
import type { EventRecord } from './lib/normalize.ts';
import type { Narrative } from '../src/lib/narratives.ts';
import type { BakedSummary } from '../src/lib/summaries.ts';
import { SHARD_COUNT } from '../src/lib/summaries.ts';

const USER_AGENT = 'history-map-explain/0.1 (naren.salem@gmail.com)';

const ok = (s: string) => `  ✓ ${s}`;
const no = (s: string) => `  ✗ ${s}`;
const info = (s: string) => `    ${s}`;

async function resolveQid(arg: string): Promise<number | null> {
  const direct = /^Q?(\d+)$/i.exec(arg.trim());
  if (direct) return Number(direct[1]);

  const url =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities` +
    `&search=${encodeURIComponent(arg)}&language=en&format=json&limit=5`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const data = (await res.json()) as { search?: { id: string; label?: string; description?: string }[] };
  const hits = data.search ?? [];
  if (hits.length === 0) return null;

  if (hits.length > 1) {
    console.log(`  Wikidata search matched ${hits.length}; using the first:`);
    for (const h of hits) console.log(info(`${h.id.padEnd(10)} ${h.label ?? ''} — ${h.description ?? ''}`));
    console.log('');
  }
  return Number(hits[0]!.id.slice(1));
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).join(' ').trim();
  if (!arg) {
    console.error('usage: npx tsx scripts/explain.ts <QID | name>');
    process.exit(1);
  }

  const qid = await resolveQid(arg);
  if (!qid) {
    console.log(`No Wikidata item found for "${arg}".`);
    return;
  }
  console.log(`explain Q${qid}\n`);

  // ---- Stage 1: does Wikidata hold what the harvest requires? ----
  console.log('1. Wikidata source');
  const bindings = await sparql(`
SELECT ?label ?coord ?pit ?start ?end ?inception ?sl ?type ?parent ?article WHERE {
  BIND(wd:Q${qid} AS ?i)
  OPTIONAL { ?i rdfs:label ?label FILTER(lang(?label) = "en") }
  OPTIONAL { ?i wdt:P625 ?coord }
  OPTIONAL { ?i wdt:P585 ?pit }
  OPTIONAL { ?i wdt:P580 ?start }
  OPTIONAL { ?i wdt:P582 ?end }
  OPTIONAL { ?i wdt:P571 ?inception }
  OPTIONAL { ?i wikibase:sitelinks ?sl }
  OPTIONAL { ?i wdt:P31 ?type }
  OPTIONAL { ?i wdt:P361 ?parent }
  OPTIONAL { ?article schema:about ?i ; schema:isPartOf <https://en.wikipedia.org/> }
}`.trim());

  if (bindings.length === 0) {
    console.log(no('Wikidata returned nothing for this QID.'));
    return;
  }
  const first = bindings[0]!;
  const label = first.label?.value ?? '(no English label)';
  const rank = Number(first.sl?.value ?? 0);
  const types = [...new Set(bindings.flatMap((b) => (b.type ? [Number(/Q(\d+)$/.exec(b.type.value)?.[1])] : [])))];
  const parents = [...new Set(bindings.flatMap((b) => (b.parent ? [Number(/Q(\d+)$/.exec(b.parent.value)?.[1])] : [])))];

  console.log(info(`label: ${label}`));
  console.log(first.coord ? ok(`has coordinates — ${first.coord.value}`) : no('NO P625 coordinates — the harvest is anchored on these, so it can never be reached'));
  const hasDate = Boolean(first.pit || first.start || first.inception);
  console.log(hasDate ? ok(`dated — ${first.pit?.value ?? first.start?.value ?? first.inception?.value}`.slice(0, 60)) : no('NO date (P585/P580/P571)'));
  console.log(info(`sitelink rank: ${rank}`));
  console.log(info(`P31 types: ${types.length ? types.map((t) => `Q${t}`).join(', ') : '(none)'}`));
  console.log(info(`P361 parents: ${parents.length ? parents.map((t) => `Q${t}`).join(', ') : '(none)'}`));

  // ---- Stage 2: harvest ----
  console.log('\n2. Harvest');
  const raws: [string, EventRecord[] | null][] = [
    ['p585 (instants)', await loadJson<EventRecord[]>('data/raw/p585.json')],
    ['p580 (spans)', await loadJson<EventRecord[]>('data/raw/p580.json')],
  ];
  let harvested: EventRecord | undefined;
  for (const [name, list] of raws) {
    if (!list) {
      console.log(info(`${name}: file missing — run the harvest`));
      continue;
    }
    const hit = list.find((e) => e.q === qid);
    if (hit) {
      harvested = hit;
      console.log(ok(`present in ${name}`));
    } else {
      console.log(no(`absent from ${name}`));
    }
  }
  const polities = await loadJson<{ q: number; n: string }[]>('data/raw/polities.json');
  if (polities?.some((p) => p.q === qid)) console.log(ok('present in polities'));

  if (!harvested && !polities?.some((p) => p.q === qid)) {
    console.log(info('Not harvested. Most common causes, in order: no coordinates,'));
    console.log(info('no date, or no English label (the label service returns a bare QID).'));
  }

  // ---- Stage 3: curation ----
  console.log('\n3. Curation (type allowlist)');
  if (harvested) {
    const t = harvested.t ?? [];
    const category = categoryFor(t);
    const excluded = t.filter((x) => DELIBERATELY_EXCLUDED.has(x));
    const unreviewed = t.filter((x) => !ALLOWED.has(x) && !DELIBERATELY_EXCLUDED.has(x));
    if (category) {
      console.log(ok(`kept as "${category}"`));
    } else if (excluded.length > 0) {
      console.log(no(`excluded on purpose: ${excluded.map((x) => DELIBERATELY_EXCLUDED.get(x)).join('; ')}`));
    } else {
      console.log(no('dropped — no allowlisted type'));
      console.log(info(`unreviewed types: ${unreviewed.map((x) => `Q${x}`).join(', ') || '(none)'}`));
      console.log(info('Fix: add one to GROUPS in scripts/lib/taxonomy.ts, or force it in'));
      console.log(info('via data/manual/curation.json ("include").'));
    }
  } else {
    console.log(info('(nothing harvested to curate)'));
  }

  // ---- Stage 4: shipped artefacts ----
  console.log('\n4. Shipped to the app');
  const events = await loadJson<EventRecord[]>('public/data/events.json');
  const shipped = events?.find((e) => e.q === qid);
  console.log(shipped ? ok(`in events.json — "${shipped.n}"`) : no('not in public/data/events.json'));

  const narratives = await loadJson<Narrative[]>('public/data/narratives.json');
  const asNarrative = narratives?.find((n) => n.q === qid);
  if (asNarrative) {
    console.log(ok(`also a narrative — ${asNarrative.total} events beneath, depth ${asNarrative.depth}`));
  }

  const shard = await loadJson<BakedSummary[]>(`public/data/summaries/${qid % SHARD_COUNT}.json`);
  const summary = shard?.find((s) => s.q === qid);
  console.log(summary ? ok(`baked summary present (${summary.x?.length ?? 0} chars)`) : no('no baked summary'));
  if (!summary && shipped && !shipped.w) {
    console.log(info('— expected: this event has no English Wikipedia article.'));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
