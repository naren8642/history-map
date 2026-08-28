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
  TYPE_LABELS,
  categoryFor,
  type Category,
} from './lib/taxonomy.ts';
import type { EventRecord } from './lib/normalize.ts';

const IN = process.argv[2] ?? 'data/raw/p585.json';
const OUT = process.argv[3] ?? 'data/raw/p585.curated.json';

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
  const raw: EventRecord[] = JSON.parse(await readFile(IN, 'utf8'));

  const kept: CuratedEvent[] = [];
  /** Events dropped for carrying no recognised type — the actionable losses. */
  const droppedUnreviewed: EventRecord[] = [];
  const byCategory = new Map<Category, number>();
  /** Types not in the allowlist and not explicitly rejected — the to-do list. */
  const candidates = new Map<number, { count: number; notable: number; sample: string }>();
  let excludedKnown = 0;
  let untyped = 0;

  for (const e of raw) {
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

    if (types.some((t) => DELIBERATELY_EXCLUDED.has(t))) {
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

  const unreviewedEvents =
    raw.length - kept.length - excludedKnown - untyped;

  kept.sort((a, b) => b.r - a.r);
  const json = JSON.stringify(kept);
  await writeFile(OUT, json);

  const pct = (n: number) => `${((n / raw.length) * 100).toFixed(1)}%`;

  console.log(`curate: ${IN} -> ${OUT}`);
  console.log(`
  input            ${raw.length.toLocaleString()} events
  kept             ${kept.length.toLocaleString()} (${pct(kept.length)})
  excluded (known) ${excludedKnown.toLocaleString()} (${pct(excludedKnown)})
  unreviewed       ${unreviewedEvents.toLocaleString()} events across ${candidates.size} types
  untyped (no P31) ${untyped.toLocaleString()}
  raw              ${(json.length / 1024 / 1024).toFixed(2)} MB
  gzipped          ${(gzipSync(Buffer.from(json)).length / 1024 / 1024).toFixed(2)} MB`);

  console.log(`\n  by category\n  -----------`);
  for (const c of CATEGORIES) {
    const n = byCategory.get(c) ?? 0;
    console.log(`    ${c.padEnd(18)} ${String(n).padStart(6)}`);
  }

  // The whole point of the allowlist instrumentation: show what we are dropping
  // without having decided to, biggest first, so expansion is evidence-driven.
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
