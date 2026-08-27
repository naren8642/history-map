/**
 * Eyeball a harvest output: size, distribution, and the things most likely to
 * be quietly wrong (bad coords, missing articles, absurd date clusters).
 *
 * Usage: npx tsx scripts/inspect.ts [data/raw/p585.json]
 */

import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import type { EventRecord } from './lib/normalize.ts';

const file = process.argv[2] ?? 'data/raw/p585.json';

const fmtYear = (y: number) => (y < 0 ? `${Math.abs(y)} BCE` : String(y));

/** Same era bands the app will bucket by, so this doubles as a bucket-size preview. */
const ERAS: ReadonlyArray<[string, number, number]> = [
  ['pre-1000 BCE', -10000, -1000],
  ['1000 BCE - 0', -1000, 0],
  ['0 - 500', 0, 500],
  ['500 - 1000', 500, 1000],
  ['1000 - 1500', 1000, 1500],
  ['1500 - 1800', 1500, 1800],
  ['1800 - 1900', 1800, 1900],
  ['1900 - 1950', 1900, 1950],
  ['1950 - 2000', 1950, 2000],
  ['2000 +', 2000, 3000],
];

function bar(n: number, max: number, width = 34): string {
  return '#'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / Math.max(max, 1)) * width)));
}

function section(title: string): void {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

async function main(): Promise<void> {
  const json = await readFile(file, 'utf8');
  const events: EventRecord[] = JSON.parse(json);

  console.log(`${file}: ${events.length.toLocaleString()} events`);
  console.log(
    `  raw ${(json.length / 1024 / 1024).toFixed(2)} MB` +
      `  gzip ${(gzipSync(Buffer.from(json)).length / 1024 / 1024).toFixed(2)} MB` +
      `  ${(json.length / events.length).toFixed(0)} bytes/event`,
  );

  section('distribution by era');
  const counts = ERAS.map(([, lo, hi]) => events.filter((e) => e.s >= lo && e.s < hi).length);
  const max = Math.max(...counts);
  ERAS.forEach(([name], i) => {
    const n = counts[i] ?? 0;
    console.log(`  ${name.padEnd(14)} ${String(n).padStart(6)}  ${bar(n, max)}`);
  });

  section('coverage');
  const withArticle = events.filter((e) => e.w).length;
  const withType = events.filter((e) => e.t).length;
  console.log(`  en.wikipedia article  ${withArticle} (${((withArticle / events.length) * 100).toFixed(1)}%)`);
  console.log(`  P31 type              ${withType} (${((withType / events.length) * 100).toFixed(1)}%)`);

  section('notability (sitelink rank)');
  for (const t of [0, 1, 5, 10, 20, 50]) {
    const n = events.filter((e) => e.r >= t).length;
    console.log(`  rank >= ${String(t).padStart(2)}   ${String(n).padStart(6)}  ${((n / events.length) * 100).toFixed(1)}%`);
  }

  section('date precision');
  const byPrec = new Map<string, number>();
  for (const e of events) byPrec.set(e.p, (byPrec.get(e.p) ?? 0) + 1);
  for (const [p, n] of [...byPrec].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(11)} ${String(n).padStart(6)}  ${((n / events.length) * 100).toFixed(1)}%`);
  }

  section('integrity checks');
  const badCoord = events.filter(
    (e) => !(e.c[0] >= -180 && e.c[0] <= 180 && e.c[1] >= -90 && e.c[1] <= 90),
  );
  const nullIsland = events.filter((e) => e.c[0] === 0 && e.c[1] === 0);
  const dupes = events.length - new Set(events.map((e) => e.q)).size;
  console.log(`  out-of-range coords   ${badCoord.length}`);
  console.log(`  null island (0,0)     ${nullIsland.length}`);
  console.log(`  duplicate QIDs        ${dupes}`);

  // A single coordinate shared by many events usually means a placeholder
  // (a country centroid, say) rather than a real site — those stack into one
  // useless pin on the map.
  const byCoord = new Map<string, EventRecord[]>();
  for (const e of events) {
    const k = `${e.c[0]},${e.c[1]}`;
    (byCoord.get(k) ?? byCoord.set(k, []).get(k)!).push(e);
  }
  const stacked = [...byCoord.entries()].filter(([, v]) => v.length >= 15).sort((a, b) => b[1].length - a[1].length);
  console.log(`  coords with >=15 events  ${stacked.length}`);
  for (const [k, v] of stacked.slice(0, 6)) {
    console.log(`     ${k.padEnd(22)} ${String(v.length).padStart(4)}  e.g. ${v[0]!.n.slice(0, 40)}`);
  }

  section('top 15 by rank');
  for (const e of [...events].sort((a, b) => b.r - a.r).slice(0, 15)) {
    console.log(`  ${String(e.r).padStart(3)}  ${fmtYear(e.s).padStart(9)}  ${e.n.slice(0, 52)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
