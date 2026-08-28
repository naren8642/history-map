/**
 * Turn raw SPARQL bindings into the compact event records the app ships.
 *
 * Field names are deliberately one character: at ~180k events, key names are a
 * meaningful fraction of the payload.
 */

import type { Binding } from './sparql.ts';

export interface EventRecord {
  /** QID as an integer; the "Q" prefix is implied. */
  q: number;
  /** Display name (Wikidata label). */
  n: string;
  /** en.wikipedia article title, for the summary fetch. Absent if no article. */
  w?: string;
  /**
   * Wikidata's one-line description ("1815 battle of the Waterloo campaign").
   * Present for ~85% of events, including most of the ~40% that have no English
   * Wikipedia article — so it is what keeps those detail panels from being empty.
   */
  d?: string;
  /** [lon, lat], rounded to 4dp (~11m). */
  c: [number, number];
  /** Start year, signed. Negative = BCE. */
  s: number;
  /** End year, signed. Equal to `s` for instant events. */
  e: number;
  /** Date precision — drives display ("c. 1200" vs "18 Jun 1815"). */
  p: Precision;
  /**
   * Every P31 "instance of" QID on the item.
   *
   * Deliberately a list. Items routinely carry several types, and the OPTIONAL
   * join returns one row per type; keeping only the first made the result
   * depend on row order, which is not stable. Adding an unrelated OPTIONAL to
   * the query once moved ~6,400 events between categories because a different
   * type happened to arrive first. Curation now decides over the whole set.
   */
  t?: number[];
  /** Sitelink count — the notability rank. */
  r: number;
  /**
   * QIDs this event is `part of` (P361) — the narratives it belongs to.
   *
   * Multi-valued and a DAG, not a tree: the Second Sino-Japanese War is part of
   * both World War II and the Pacific War. Anything consuming this must not
   * assume a single parent.
   */
  pa?: number[];
}

export type Precision = 'day' | 'month' | 'year' | 'decade' | 'century' | 'millennium' | 'coarse';

/** Wikidata numeric time precision -> our enum. */
const PRECISION: Record<number, Precision> = {
  11: 'day',
  10: 'month',
  9: 'year',
  8: 'decade',
  7: 'century',
  6: 'millennium',
};

const EARTH_GLOBE = 'http://www.wikidata.org/entity/Q2';

/** Point(lon lat) — note WKT is lon-first, the opposite of the usual lat/lng habit. */
const WKT_POINT = /^Point\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$/;

/**
 * XSD dateTime with an optional leading sign. Year may exceed 4 digits.
 * In XSD 1.1 year -0044 means 44 BCE, so the sign maps straight onto BCE.
 */
const XSD_YEAR = /^(-?)(\d{4,})-/;

const qidToInt = (uri: string): number | null => {
  const m = /Q(\d+)$/.exec(uri);
  return m ? Number(m[1]) : null;
};

function parsePoint(wkt: string): [number, number] | null {
  const m = WKT_POINT.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4];
}

function parseYear(iso: string): number | null {
  const m = XSD_YEAR.exec(iso);
  if (!m) return null;
  const year = Number(m[2]);
  if (!Number.isFinite(year)) return null;
  return m[1] === '-' ? -year : year;
}

/** Strip the "https://en.wikipedia.org/wiki/" prefix and percent-decode. */
function articleTitle(url: string): string | undefined {
  const m = /\/wiki\/(.+)$/.exec(url);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ');
  } catch {
    return m[1].replace(/_/g, ' ');
  }
}

export interface NormalizeStats {
  seen: number;
  kept: number;
  rejected: Record<string, number>;
}

export function emptyStats(): NormalizeStats {
  return { seen: 0, kept: 0, rejected: {} };
}

/**
 * Bindings arrive denormalized: OPTIONAL joins on P31/globe/article multiply
 * rows per item, so the same QID appears several times. The first complete
 * sighting establishes the record; subsequent rows are merged for P31 only,
 * which is genuinely multi-valued. Everything else is single-valued in
 * practice, so later rows add nothing.
 */
export function normalize(
  bindings: Binding[],
  stats: NormalizeStats,
  seen: Map<number, EventRecord>,
): void {
  const reject = (reason: string) => {
    stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
  };

  for (const b of bindings) {
    stats.seen++;

    const qid = b.i && qidToInt(b.i.value);
    if (!qid) {
      reject('bad-qid');
      continue;
    }
    const typeQid = b.type ? qidToInt(b.type.value) : null;
    const parentQid = b.parent ? qidToInt(b.parent.value) : null;

    // Repeat row for an item we already have: harvest any additional type or
    // parent off it, then move on. Both are genuinely multi-valued.
    const existing = seen.get(qid);
    if (existing) {
      if (typeQid) {
        existing.t ??= [];
        if (!existing.t.includes(typeQid)) existing.t.push(typeQid);
      }
      if (parentQid) {
        existing.pa ??= [];
        if (!existing.pa.includes(parentQid)) existing.pa.push(parentQid);
      }
      continue;
    }

    // Defensive: exclude extraterrestrial coordinates. Measured as zero for
    // P585 today, but a Moon landing would otherwise plot into the Pacific.
    if (b.globe && b.globe.value !== EARTH_GLOBE) {
      reject('non-earth');
      continue;
    }

    const coord = b.coord && parsePoint(b.coord.value);
    if (!coord) {
      reject('bad-coord');
      continue;
    }

    const year = b.t && parseYear(b.t.value);
    if (year === null || year === undefined) {
      reject('bad-date');
      continue;
    }

    // Span events carry an end; instants do not, and collapse to start === end.
    const endYear = b.endT ? parseYear(b.endT.value) : null;

    const label = b.iLabel?.value?.trim();
    // The label service falls back to the bare QID when no label exists;
    // such an item would render as an unreadable pin.
    if (!label || /^Q\d+$/.test(label)) {
      reject('no-label');
      continue;
    }

    const precision = PRECISION[Number(b.prec?.value)] ?? 'coarse';
    const rank = Number(b.sl?.value);
    const title = b.article ? articleTitle(b.article.value) : undefined;
    const description = b.desc?.value?.trim();

    const rec: EventRecord = {
      q: qid,
      n: label,
      c: coord,
      s: year,
      e: endYear !== null && endYear >= year ? endYear : year,
      p: precision,
      r: Number.isFinite(rank) ? rank : 0,
    };
    if (title) rec.w = title;
    // A description identical to the label carries no information.
    if (description && description !== label) rec.d = description;
    if (typeQid) rec.t = [typeQid];
    if (parentQid) rec.pa = [parentQid];

    seen.set(qid, rec);
    stats.kept++;
  }
}
