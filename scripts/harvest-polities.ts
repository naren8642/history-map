/**
 * Harvest polities, cultures and periods — the narrative objects that are not
 * conflicts.
 *
 * Motivated by a coverage measurement, not by taste. For 0–1500 CE, 81.8% of
 * Wikidata's geolocated *events* are European, and Africa has 55 in total. But
 * the non-European record is not missing from Wikidata — it is stored as
 * polities and cultures rather than as dated point events. Aksum, Kush, Mali,
 * Songhai, Benin, Great Zimbabwe, Cahokia, Srivijaya, Khmer, Gupta and the
 * Mongol Empire all exist, dated, and at ranks rivalling anything in the event
 * corpus (Mongol Empire 142 sitelinks; Chernobyl, for scale, is 125).
 *
 * Harvesting only events therefore fishes in the one pond where the imbalance
 * is worst. These items are also exactly the "bigger picture" objects the
 * story-first map wants, so one pass serves both goals.
 *
 * Anchored on type rather than date: the set is small enough (~1,900 above the
 * notability floor) that no chunking is needed.
 */

import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { sparql } from './lib/sparql.ts';

const OUT = 'data/raw/polities.json';

/**
 * Notability floor. Set at 25 sitelinks to keep the set to genuinely
 * significant polities rather than every recorded chiefdom — the same instinct
 * as the P571 gate, and tuned against the same measurements.
 */
const MIN_SITELINKS = 25;

/**
 * Types that denote a polity, culture, or historical period.
 *
 * Two obvious candidates are deliberately absent:
 *
 *   `country` (Q6256) admits present-day states. They are not historical
 *   narratives, their spans are degenerate (the United States as "1784–1784"),
 *   and their ranks would swamp everything real — the US at 427 sitelinks
 *   against the Mongol Empire's 142.
 *
 *   `city-state` (Q133442) admits modern administrative cities: Berlin,
 *   Vienna, Hong Kong, Macau. Genuine ancient city-states carry
 *   `historical country` instead, so nothing is lost.
 */
const TYPES: ReadonlyArray<readonly [number, string]> = [
  [3024240, 'historical country'],
  [417175, 'kingdom'],
  [48349, 'empire'],
  [164950, 'dynasty'],
  [8432, 'civilization'],
  [28171280, 'ancient civilization'],
  [465299, 'archaeological culture'],
  [11514315, 'historical period'],
  [839954, 'archaeological site'],
];

export interface PolityRecord {
  q: number;
  n: string;
  d?: string;
  w?: string;
  /** Start year, signed. From inception (P571) or start time (P580). */
  s: number;
  /** End year, signed. From dissolution (P576) or end time (P582). */
  e: number;
  r: number;
  /** Own coordinate, when Wikidata records one. Many polities have none. */
  c?: [number, number];
  /**
   * True when no end date is recorded — 27% of the set.
   *
   * The end is left equal to the start rather than extended to the present.
   * Extending would assert that Cahokia is still going; collapsing at least
   * says only what the source says, and the flag lets the UI render
   * "1050 – unknown" instead of a zero-length span.
   */
  o?: boolean;
  /** Narratives this polity is part of. */
  pa?: number[];
  t?: number[];
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

function parsePoint(wkt: string): [number, number] | null {
  const m = /^Point\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$/.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4];
}

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
 * One query per type.
 *
 * The `NOT EXISTS ... wd:Q6256` clause drops polities that are still countries
 * today. Removing `country` from the type list above was not enough on its own:
 * modern states also record their founding as a `historical country`, so
 * Nigeria, Saudi Arabia and Bhutan arrived at ranks 350, 349 and 303 —
 * outranking World War II at 291 — each with nothing beneath them.
 */
function buildQuery(typeQid: number): string {
  return `
SELECT ?i ?iLabel ?desc ?article ?coord ?inception ?dissolved ?start ?end ?sl ?parent WHERE {
  ?i wdt:P31 wd:Q${typeQid} ; wikibase:sitelinks ?sl .
  FILTER(?sl >= ${MIN_SITELINKS})
  FILTER NOT EXISTS { ?i wdt:P31 wd:Q6256 }
  { ?i wdt:P571 ?inception } UNION { ?i wdt:P580 ?start }
  OPTIONAL { ?i wdt:P576 ?dissolved }
  OPTIONAL { ?i wdt:P582 ?end }
  OPTIONAL { ?i wdt:P625 ?coord }
  OPTIONAL { ?i wdt:P361 ?parent }
  OPTIONAL { ?i schema:description ?desc FILTER(lang(?desc) = "en") }
  OPTIONAL { ?article schema:about ?i ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}`.trim();
}

async function main(): Promise<void> {
  const byQid = new Map<number, PolityRecord>();
  console.log(`harvest polities: ${TYPES.length} types, sitelinks >= ${MIN_SITELINKS}\n`);

  for (const [typeQid, label] of TYPES) {
    let bindings;
    try {
      bindings = await sparql(buildQuery(typeQid));
    } catch (err) {
      console.log(`  ${label.padEnd(24)} FAILED (${err instanceof Error ? err.message.slice(0, 40) : ''})`);
      continue;
    }

    let added = 0;
    for (const b of bindings) {
      const q = b.i && qidToInt(b.i.value);
      if (!q) continue;

      const parent = b.parent ? qidToInt(b.parent.value) : null;
      const existing = byQid.get(q);
      if (existing) {
        if (parent) {
          existing.pa ??= [];
          if (!existing.pa.includes(parent)) existing.pa.push(parent);
        }
        if (!existing.t?.includes(typeQid)) (existing.t ??= []).push(typeQid);
        continue;
      }

      const name = b.iLabel?.value?.trim();
      if (!name || /^Q\d+$/.test(name)) continue;

      const start = b.inception ? parseYear(b.inception.value) : b.start ? parseYear(b.start.value) : null;
      if (start === null) continue;
      const end = b.dissolved ? parseYear(b.dissolved.value) : b.end ? parseYear(b.end.value) : null;
      const openEnded = end === null || end < start;

      const rec: PolityRecord = {
        q,
        n: name,
        s: start,
        e: end !== null && end >= start ? end : start,
        r: Number(b.sl?.value) || 0,
        t: [typeQid],
      };
      if (openEnded) rec.o = true;
      const desc = b.desc?.value?.trim();
      if (desc && desc !== name) rec.d = desc;
      const title = b.article ? articleTitle(b.article.value) : undefined;
      if (title) rec.w = title;
      const coord = b.coord ? parsePoint(b.coord.value) : null;
      if (coord) rec.c = coord;
      if (parent) rec.pa = [parent];

      byQid.set(q, rec);
      added++;
    }
    console.log(`  ${label.padEnd(24)} ${String(added).padStart(5)} new  (${byQid.size} total)`);
  }

  const records = [...byQid.values()].sort((a, b) => b.r - a.r);
  const json = JSON.stringify(records);
  await writeFile(OUT, json);

  const withCoord = records.filter((r) => r.c).length;
  const openEnded = records.filter((r) => r.o).length;
  console.log(`
--- polities complete ---
  polities       ${records.length.toLocaleString()}
  with coord     ${withCoord.toLocaleString()} (${((withCoord / records.length) * 100).toFixed(1)}%)
  open-ended     ${openEnded.toLocaleString()} (no end date recorded)
  raw            ${(json.length / 1024 / 1024).toFixed(2)} MB
  gzipped        ${(gzipSync(Buffer.from(json)).length / 1024 / 1024).toFixed(2)} MB
  written        ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
