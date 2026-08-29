/**
 * Apply the curated type allowlist to a raw harvest.
 *
 * Kept separate from harvest.ts on purpose: harvesting takes ~6 minutes against
 * WDQS, while curating is a local pass over JSON. Splitting them means the
 * allowlist can be revised and re-applied in seconds, which is what makes
 * "start narrow and expand" actually workable.
 *
 * Usage: npx tsx scripts/curate.ts [in] [out]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import {
  ALLOWED,
  CATEGORIES,
  DELIBERATELY_EXCLUDED,
  EVENT_ONLY_EXCLUDED,
  TYPE_LABELS,
  categoryFor,
  type Category,
} from './lib/taxonomy.ts';
import type { EventRecord } from './lib/normalize.ts';

/**
 * Both harvest passes feed curation. The span pass was added later and, until
 * this was fixed, its 33,943 events were harvested and then silently dropped
 * because curation only ever read the instants file — which is why the Berlin
 * Conference stayed off the map even after its type was allowlisted.
 */
const INPUTS = ['data/raw/p585.json', 'data/raw/p580.json'];
const OUT = process.argv[2] ?? 'data/raw/p585.curated.json';
const OVERRIDES = 'data/manual/curation.json';
const SNAPSHOT = 'data/raw/curation-snapshot.json';

/** Notability at which losing an event between runs is worth reporting. */
const REGRESSION_RANK = 20;

/** How many unreviewed types to surface as expansion candidates. */
const CANDIDATE_LIMIT = 30;

/**
 * How many individually-notable dropped events to surface.
 *
 * Ranking candidates by type volume answers "which gap is widest?" but not
 * "what is the most important thing we are losing?". Those are different
 * questions, and only the second one catches a singleton type holding one
 * irreplaceable event: the Chernobyl disaster (rank 125, third in the whole
 * corpus) sat unnoticed under `nuclear disaster` while the volume-ranked list
 * was topped by Formula One seasons.
 */
const DROPPED_EVENT_LIMIT = 20;

/** A curated event carries its category, so the UI can filter and style by it. */
interface CuratedEvent extends EventRecord {
  g: Category;
  /** Present when this record came from, or was altered by, manual curation. */
  man?: true;
}

/**
 * Hand-maintained overrides, for judgements the type allowlist cannot express.
 *
 * The allowlist is a blunt instrument by design: it decides by *class*, which
 * is what makes it reviewable and keeps it from drifting into a list of
 * personal favourites. But some events matter for reasons their type does not
 * capture, and some are simply not reachable — Wikidata records plenty of
 * significant events with no coordinate at all.
 *
 * Preferring the taxonomy where a class fix exists keeps this file small, which
 * is the point: a large override file is a sign the allowlist is wrong.
 */
/**
 * Recorded each run so the next one can say what changed.
 *
 * Silent loss is this pipeline's characteristic failure. A truncated response
 * once dropped an entire decade and the run still exited 0; span events were
 * harvested for a whole milestone before anyone noticed curation never read
 * them. Both were found by accident. A diff against the previous run turns
 * "we lost 900 events" from something you happen to spot into something the
 * build says out loud.
 */
interface Snapshot {
  generated: string;
  total: number;
  byCategory: Record<string, number>;
  /** QIDs above REGRESSION_RANK, so losses among them can be named. */
  notable: number[];
}

interface Overrides {
  include?: { q: number; g?: Category; why: string }[];
  exclude?: { q: number; why: string }[];
  patch?: Record<string, Partial<CuratedEvent>>;
  add?: (Partial<CuratedEvent> & { q: number; n: string; c: [number, number]; s: number; why: string })[];
}

/** Look up labels for QIDs we have no local name for, so the report is readable. */
async function fetchLabels(qids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50).map((q) => `Q${q}`).join('|');
    const url =
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch}` +
      `&props=labels&languages=en&format=json`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'history-map-harvest/0.1 (naren.salem@gmail.com)' },
      });
      const data = (await res.json()) as {
        entities?: Record<string, { labels?: { en?: { value?: string } } }>;
      };
      for (const [k, v] of Object.entries(data.entities ?? {})) {
        const label = v.labels?.en?.value;
        if (label) out.set(Number(k.slice(1)), label);
      }
    } catch {
      // A missing label only degrades the report, never the output.
    }
  }
  return out;
}

async function main(): Promise<void> {
  /*
   * An item can appear in both passes (a P585 instant and a P580 start). Merge
   * rather than pick: union the multi-valued fields, and prefer the record that
   * carries a real span, since an end date is information the other lacks.
   */
  const merged = new Map<number, EventRecord>();
  let duplicates = 0;
  for (const file of INPUTS) {
    let list: EventRecord[];
    try {
      list = JSON.parse(await readFile(file, 'utf8')) as EventRecord[];
    } catch {
      console.log(`  (skipping ${file} — not present)`);
      continue;
    }
    for (const e of list) {
      const prior = merged.get(e.q);
      if (!prior) {
        merged.set(e.q, { ...e });
        continue;
      }
      duplicates++;
      const winner = e.e > e.s && prior.e === prior.s ? { ...e } : prior;
      winner.t = [...new Set([...(prior.t ?? []), ...(e.t ?? [])])];
      const parents = [...new Set([...(prior.pa ?? []), ...(e.pa ?? [])])];
      if (parents.length > 0) winner.pa = parents;
      winner.w ??= prior.w ?? e.w;
      winner.d ??= prior.d ?? e.d;
      merged.set(e.q, winner);
    }
  }
  const raw: EventRecord[] = [...merged.values()];

  let overrides: Overrides = {};
  try {
    overrides = JSON.parse(await readFile(OVERRIDES, 'utf8')) as Overrides;
  } catch {
    // Absent overrides file is normal.
  }
  const forceInclude = new Map((overrides.include ?? []).map((o) => [o.q, o]));
  const forceExclude = new Set((overrides.exclude ?? []).map((o) => o.q));
  const patches = new Map(Object.entries(overrides.patch ?? {}).map(([q, p]) => [Number(q), p]));
  let manualIncluded = 0;
  let manualExcluded = 0;
  let manualPatched = 0;

  const previous = await readFile(SNAPSHOT, 'utf8')
    .then((t) => JSON.parse(t) as Snapshot)
    .catch(() => null);

  const kept: CuratedEvent[] = [];
  /** Events dropped for carrying no recognised type — the actionable losses. */
  const droppedUnreviewed: EventRecord[] = [];
  const byCategory = new Map<Category, number>();
  /** Types not in the allowlist and not explicitly rejected — the to-do list. */
  const candidates = new Map<number, { count: number; notable: number; sample: string }>();
  let excludedKnown = 0;
  let untyped = 0;

  for (const e of raw) {
    if (forceExclude.has(e.q)) {
      manualExcluded++;
      continue;
    }
    const forced = forceInclude.get(e.q);
    if (forced) {
      const category = forced.g ?? categoryFor(e.t ?? []) ?? 'other';
      kept.push({ ...e, g: category, man: true });
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      manualIncluded++;
      continue;
    }

    const types = e.t ?? [];
    if (types.length === 0) {
      untyped++;
      continue;
    }

    /*
     * Decide over *all* of an item's types rather than one arbitrary type.
     *
     * Inclusion wins over exclusion: "2016 Munich shooting" is both a
     * `hate crime` (unreviewed) and a `mass shooting` (allowed), and dropping
     * it because one of its types is unrecognised would be wrong. A type on the
     * allowlist is positive evidence; the absence of one is not evidence of
     * anything.
     */
    const category = categoryFor(types);
    if (category !== undefined) {
      kept.push({ ...e, g: category });
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      continue;
    }

    // Events apply both lists; narratives apply only the shared one.
    if (types.some((t) => DELIBERATELY_EXCLUDED.has(t) || EVENT_ONLY_EXCLUDED.has(t))) {
      excludedKnown++;
      continue;
    }

    // Nothing recognised either way. Report every unreviewed type it carries,
    // so the expansion list reflects real coverage gaps.
    droppedUnreviewed.push(e);
    for (const t of types) {
      const c = candidates.get(t) ?? { count: 0, notable: 0, sample: e.n };
      c.count++;
      if (e.r >= 10) c.notable++;
      candidates.set(t, c);
    }
  }

  // Corrections and additions, applied after the allowlist has had its say.
  for (const rec of kept) {
    const patch = patches.get(rec.q);
    if (patch) {
      Object.assign(rec, patch, { man: true as const });
      manualPatched++;
    }
  }
  const present = new Set(kept.map((e) => e.q));
  for (const addition of overrides.add ?? []) {
    if (present.has(addition.q)) continue;
    kept.push({
      p: 'year',
      r: 0,
      e: addition.s,
      g: 'other',
      ...addition,
      man: true,
    } as CuratedEvent);
  }

  const unreviewedEvents =
    raw.length - kept.length - excludedKnown - untyped;

  kept.sort((a, b) => b.r - a.r);
  const json = JSON.stringify(kept);
  await writeFile(OUT, json);

  const snapshot: Snapshot = {
    generated: new Date().toISOString(),
    total: kept.length,
    byCategory: Object.fromEntries([...byCategory].map(([k, v]) => [k, v])),
    notable: kept.filter((e) => e.r >= REGRESSION_RANK).map((e) => e.q).sort((a, b) => a - b),
  };
  await writeFile(SNAPSHOT, JSON.stringify(snapshot));

  const pct = (n: number) => `${((n / raw.length) * 100).toFixed(1)}%`;

  console.log(`curate: ${INPUTS.join(' + ')} -> ${OUT}`);
  console.log(`
  input            ${raw.length.toLocaleString()} events (${duplicates.toLocaleString()} appeared in both passes)
  kept             ${kept.length.toLocaleString()} (${pct(kept.length)})
  excluded (known) ${excludedKnown.toLocaleString()} (${pct(excludedKnown)})
  unreviewed       ${unreviewedEvents.toLocaleString()} events across ${candidates.size} types
  untyped (no P31) ${untyped.toLocaleString()}
  manual           +${manualIncluded} included, -${manualExcluded} excluded, ${manualPatched} patched, +${(overrides.add ?? []).length} added
  raw              ${(json.length / 1024 / 1024).toFixed(2)} MB
  gzipped          ${(gzipSync(Buffer.from(json)).length / 1024 / 1024).toFixed(2)} MB`);

  console.log(`\n  by category\n  -----------`);
  for (const c of CATEGORIES) {
    const n = byCategory.get(c) ?? 0;
    console.log(`    ${c.padEnd(18)} ${String(n).padStart(6)}`);
  }

  // The whole point of the allowlist instrumentation: show what we are dropping
  // without having decided to, biggest first, so expansion is evidence-driven.
  if (previous) {
    const now = new Set(snapshot.notable);
    const lost = previous.notable.filter((q) => !now.has(q));
    const gained = snapshot.notable.filter((q) => !new Set(previous.notable).has(q));
    const delta = kept.length - previous.total;

    console.log(
      `\n  CHANGES SINCE ${previous.generated.slice(0, 16).replace('T', ' ')}` +
        `\n  ${'-'.repeat(66)}` +
        `\n    total        ${delta >= 0 ? '+' : ''}${delta.toLocaleString()} (${previous.total.toLocaleString()} -> ${kept.length.toLocaleString()})` +
        `\n    notable      +${gained.length} gained, -${lost.length} lost (rank >= ${REGRESSION_RANK})`,
    );
    if (lost.length > 0) {
      const byQid = new Map(kept.map((e) => [e.q, e]));
      console.log(`    LOST — verify these are intentional:`);
      for (const q of lost.slice(0, 15)) {
        console.log(`      Q${q}${byQid.has(q) ? '' : '  (npx tsx scripts/explain.ts Q' + q + ')'}`);
      }
    }
  } else {
    console.log(`\n  (no previous snapshot — this run establishes the baseline)`);
  }

  // The rank-weighted view: what are the most notable individual events we are
  // dropping, and which unrecognised type is responsible for each?
  const notableLosses = [...droppedUnreviewed]
    .sort((a, b) => b.r - a.r)
    .slice(0, DROPPED_EVENT_LIMIT);

  if (notableLosses.length > 0) {
    const typeQids = [...new Set(notableLosses.flatMap((e) => e.t ?? []))];
    const labels = await fetchLabels(typeQids);
    console.log(
      `\n  MOST NOTABLE DROPPED EVENTS — by sitelink rank` +
        `\n  (a singleton type holding one major event will not appear in the list below)` +
        `\n  ${'-'.repeat(66)}`,
    );
    console.log(`  ${'rank'.padStart(5)}  ${'year'.padStart(8)}  ${'event'.padEnd(38)} unrecognised type(s)`);
    for (const e of notableLosses) {
      const year = e.s < 0 ? `${Math.abs(e.s)} BCE` : String(e.s);
      const types = (e.t ?? []).map((t) => labels.get(t) ?? `Q${t}`).join(', ');
      console.log(
        `  ${String(e.r).padStart(5)}  ${year.padStart(8)}  ${e.n.slice(0, 38).padEnd(38)} ${types.slice(0, 52)}`,
      );
    }
  }

  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1].notable - a[1].notable || b[1].count - a[1].count)
    .slice(0, CANDIDATE_LIMIT);

  if (ranked.length > 0) {
    const labels = await fetchLabels(ranked.map(([q]) => q));
    console.log(
      `\n  EXPANSION CANDIDATES — unreviewed types, by notable-event count` +
        `\n  (add to taxonomy.ts GROUPS, or to DELIBERATELY_EXCLUDED to silence)` +
        `\n  ${'-'.repeat(66)}`,
    );
    console.log(`  ${'rank>=10'.padStart(8)} ${'total'.padStart(6)}  type`);
    for (const [qid, c] of ranked) {
      const name = labels.get(qid) ?? TYPE_LABELS.get(qid) ?? '?';
      console.log(
        `  ${String(c.notable).padStart(8)} ${String(c.count).padStart(6)}  ` +
          `Q${String(qid).padEnd(10)} ${name.slice(0, 34).padEnd(34)} e.g. ${c.sample.slice(0, 28)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
