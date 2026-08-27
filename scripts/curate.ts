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
import { ALLOWED, DELIBERATELY_EXCLUDED, TYPE_LABELS, CATEGORIES, type Category } from './lib/taxonomy.ts';
import type { EventRecord } from './lib/normalize.ts';

const IN = process.argv[2] ?? 'data/raw/p585.json';
const OUT = process.argv[3] ?? 'data/raw/p585.curated.json';

/** How many unreviewed types to surface as expansion candidates. */
const CANDIDATE_LIMIT = 30;

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
  const byCategory = new Map<Category, number>();
  /** Types not in the allowlist and not explicitly rejected — the to-do list. */
  const candidates = new Map<number, { count: number; notable: number; sample: string }>();
  let excludedKnown = 0;
  let untyped = 0;

  for (const e of raw) {
    if (e.t === undefined) {
      untyped++;
      continue;
    }
    const category = ALLOWED.get(e.t);
    if (category) {
      kept.push({ ...e, g: category });
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      continue;
    }
    if (DELIBERATELY_EXCLUDED.has(e.t)) {
      excludedKnown++;
      continue;
    }
    const c = candidates.get(e.t) ?? { count: 0, notable: 0, sample: e.n };
    c.count++;
    if (e.r >= 10) c.notable++;
    candidates.set(e.t, c);
  }

  kept.sort((a, b) => b.r - a.r);
  const json = JSON.stringify(kept);
  await writeFile(OUT, json);

  const pct = (n: number) => `${((n / raw.length) * 100).toFixed(1)}%`;

  console.log(`curate: ${IN} -> ${OUT}`);
  console.log(`
  input            ${raw.length.toLocaleString()} events
  kept             ${kept.length.toLocaleString()} (${pct(kept.length)})
  excluded (known) ${excludedKnown.toLocaleString()} (${pct(excludedKnown)})
  unreviewed       ${[...candidates.values()].reduce((s, c) => s + c.count, 0).toLocaleString()} across ${candidates.size} types
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
