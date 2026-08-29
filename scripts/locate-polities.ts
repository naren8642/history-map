/**
 * Give a coordinate to the polities Wikidata never placed.
 *
 * 532 of 1,438 harvested polities carry no P625. That is not a rounding error:
 * a third of the narrative corpus reached `narratives.ts` and was discarded
 * there for want of geography — Tang dynasty, Maya civilization, Chola dynasty,
 * Qin, Zhou, the Delhi Sultanate. The loss fell hardest on exactly the
 * non-European record the polity pass was built to recover.
 *
 * Wikidata does know where these are; it just does not say so with P625. It
 * says so with the capital, or the location, or the country. This pass follows
 * those edges one hop to something that *does* carry a coordinate, and records
 * which edge was used so the result stays auditable.
 *
 * Measured against the 495 discarded coordinate-less polities: 437 resolve.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { sparql } from './lib/sparql.ts';
import type { PolityRecord } from './harvest-polities.ts';

const IN = 'data/raw/polities.json';
const OUT = 'data/raw/polity-locations.json';

/**
 * Location-bearing properties, best first. The first that resolves wins.
 *
 * `continent` (P30) is deliberately absent. It resolves 9 further polities and
 * places every one of them badly: the Maya civilization would sit at the
 * centroid of North America, in central Canada. A pin that wrong is worse than
 * no pin, because the map presents it with the same confidence as a real one.
 *
 * `country` (P17) is kept but flagged coarse. A country centroid for the House
 * of Tudor is imprecise rather than wrong, and the flag lets the UI say so.
 */
const PROPS: ReadonlyArray<readonly [string, string]> = [
  ['P36', 'capital'],
  ['P276', 'location'],
  ['P131', 'located in administrative entity'],
  ['P159', 'headquarters location'],
  ['P2341', 'indigenous to'],
  ['P1269', 'facet of'],
  ['P17', 'country'],
];

/** Properties whose coordinate is an approximation, not a location. */
const COARSE = new Set(['P17']);

/**
 * Properties that may only be used when the item has exactly one value.
 *
 * The distinction is whether the values sit *inside* the thing or *contain* it.
 * Several capitals are all within the polity, so their mean is inside it too —
 * Tang's Chang'an and Luoyang average to somewhere in Tang China. Several
 * countries mean the opposite: the Great Depression names nine, and both the
 * first of them and their mean are claims the source never made. Taking an
 * arbitrary first value put the Great Depression in Hungary.
 */
const SINGLE_VALUED_ONLY = new Set(['P17']);

export interface PolityLocation {
  /** Derived coordinate. */
  c: [number, number];
  /** Property it was derived through, e.g. "P36". */
  via: string;
  /** Set when the coordinate is a regional approximation rather than a place. */
  coarse?: true;
}

const BATCH = 120;

function parsePoint(wkt: string): [number, number] | null {
  const m = /^Point\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$/.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4];
}

/**
 * One query per property, over every still-unresolved polity.
 *
 * Property-at-a-time rather than all-at-once because precedence has to be
 * decided by us, not by SPARQL's result order — the ordering bug that moved
 * 6,400 events between categories came from exactly that mistake.
 */
async function resolveProp(prop: string, targets: number[]): Promise<Map<number, [number, number]>> {
  const all = new Map<number, [number, number][]>();
  for (let i = 0; i < targets.length; i += BATCH) {
    const values = targets.slice(i, i + BATCH).map((q) => `wd:Q${q}`).join(' ');
    const query = `
SELECT ?i ?c WHERE {
  VALUES ?i { ${values} }
  ?i wdt:${prop} ?v .
  ?v wdt:P625 ?c .
}`.trim();
    let bindings;
    try {
      bindings = await sparql(query);
    } catch (err) {
      console.log(`    batch ${i}–${i + BATCH} failed (${err instanceof Error ? err.message.slice(0, 50) : ''})`);
      continue;
    }
    for (const b of bindings) {
      const q = Number(b.i ? /Q(\d+)$/.exec(b.i.value)?.[1] : NaN);
      if (!Number.isFinite(q)) continue;
      const c = b.c ? parsePoint(b.c.value) : null;
      if (!c) continue;
      const list = all.get(q) ?? [];
      // Distinct points only: the same capital repeated across several
      // statements should not drag the mean toward itself.
      if (!list.some(([x, y]) => x === c[0] && y === c[1])) list.push(c);
      all.set(q, list);
    }
  }

  const found = new Map<number, [number, number]>();
  for (const [q, points] of all) {
    if (points.length === 0) continue;
    if (points.length > 1 && SINGLE_VALUED_ONLY.has(prop)) continue;
    const lon = points.reduce((a, [x]) => a + x, 0) / points.length;
    const lat = points.reduce((a, [, y]) => a + y, 0) / points.length;
    found.set(q, [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]);
  }
  return found;
}

async function main(): Promise<void> {
  const polities = JSON.parse(await readFile(IN, 'utf8')) as PolityRecord[];
  const byQid = new Map(polities.map((p) => [p.q, p]));
  let pending = polities.filter((p) => !p.c).map((p) => p.q);

  console.log(
    `locate polities: ${pending.length.toLocaleString()} of ${polities.length.toLocaleString()} ` +
      `carry no P625\n`,
  );

  const located = new Map<number, PolityLocation>();
  for (const [prop, label] of PROPS) {
    if (pending.length === 0) break;
    const found = await resolveProp(prop, pending);
    for (const [q, c] of found) {
      const loc: PolityLocation = { c, via: prop };
      if (COARSE.has(prop)) loc.coarse = true;
      located.set(q, loc);
    }
    pending = pending.filter((q) => !located.has(q));
    console.log(
      `  ${prop.padEnd(6)} ${label.padEnd(34)} ${String(found.size).padStart(4)} placed  ` +
        `(${pending.length} still unplaced)`,
    );
  }

  const out = Object.fromEntries([...located].sort((a, b) => a[0] - b[0]));
  await writeFile(OUT, JSON.stringify(out));

  const coarse = [...located.values()].filter((l) => l.coarse).length;
  const unplaced = pending.map((q) => byQid.get(q)!).sort((a, b) => b.r - a.r);

  console.log(`
--- locations complete ---
  placed         ${located.size.toLocaleString()} of ${(located.size + pending.length).toLocaleString()}
  of which coarse ${coarse.toLocaleString()} (country centroid)
  unplaced       ${pending.length.toLocaleString()}
  written        ${OUT}

  Most notable still unplaced — check these are genuinely non-geographic
  before treating the number as acceptable:`);
  for (const p of unplaced.slice(0, 20)) {
    console.log(`    ${String(p.r).padStart(4)}  ${p.n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
