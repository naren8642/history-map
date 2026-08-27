/**
 * The on-the-wire event shape, produced by scripts/curate.ts.
 *
 * Keys are single characters because at ~20k events (and ~180k once P580 and
 * P571 land) key names are a meaningful share of the payload. This type is the
 * contract between the harvest pipeline and the app — keep it in sync with
 * scripts/lib/normalize.ts and scripts/lib/taxonomy.ts.
 */

export type Category =
  | 'conflict'
  | 'atrocity'
  | 'terrorism'
  | 'politics'
  | 'natural-disaster'
  | 'accident'
  | 'nuclear'
  | 'culture'
  | 'other';

export type Precision = 'day' | 'month' | 'year' | 'decade' | 'century' | 'millennium' | 'coarse';

export interface HistoryEvent {
  /** QID as an integer; the "Q" prefix is implied. */
  q: number;
  /** Display name. */
  n: string;
  /** en.wikipedia article title. Absent for ~40% of events — they have no article. */
  w?: string;
  /**
   * Wikidata one-line description. Present for ~85% of events and, crucially,
   * for most of those lacking an article — the fallback that keeps their detail
   * panel useful rather than blank.
   */
  d?: string;
  /** [lon, lat]. */
  c: [number, number];
  /** Start year, signed. Negative = BCE. */
  s: number;
  /** End year, signed. Equal to `s` for instant events. */
  e: number;
  /** Date precision — governs how the date may honestly be displayed. */
  p: Precision;
  /** Every P31 "instance of" QID on the item. Multi-valued; see normalize.ts. */
  t?: number[];
  /** Sitelink count, used as the notability rank. */
  r: number;
  /** Curated category. */
  g: Category;
}

/** Palette chosen to stay legible against the muted Positron basemap. */
export const CATEGORY_COLOR: Record<Category, string> = {
  conflict: '#b5384d',
  atrocity: '#6b2440',
  terrorism: '#d1603d',
  politics: '#2f6f8f',
  'natural-disaster': '#2e8b74',
  accident: '#9a7b2f',
  nuclear: '#7a4fa3',
  culture: '#4a7c3f',
  other: '#7a7a7a',
};

export const CATEGORY_LABEL: Record<Category, string> = {
  conflict: 'Conflict',
  atrocity: 'Atrocity',
  terrorism: 'Terrorism',
  politics: 'Politics',
  'natural-disaster': 'Natural disaster',
  accident: 'Accident',
  nuclear: 'Nuclear',
  culture: 'Culture',
  other: 'Other',
};

/**
 * Format a year for display. Wikidata's RDF uses XSD 1.1 signed years, where
 * year -44 means 44 BCE, so the sign maps straight onto the era.
 */
export function formatYear(year: number): string {
  return year < 0 ? `${Math.abs(year)} BCE` : String(year);
}

/**
 * Render a date at no more precision than the source claims. Roughly a fifth of
 * events carry year-or-coarser precision; showing them as exact dates would
 * invent confidence the data does not have.
 */
export function formatEventDate(event: HistoryEvent): string {
  const year = formatYear(event.s);
  switch (event.p) {
    case 'decade':
      return `${year}s`;
    case 'century':
    case 'millennium':
    case 'coarse':
      return `c. ${year}`;
    default:
      return year;
  }
}
