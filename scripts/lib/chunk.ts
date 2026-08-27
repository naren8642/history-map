/**
 * Adaptive date-range walker.
 *
 * WDQS query cost is wildly non-uniform across history: a century of P585
 * events returns in ~1s, while a century of P571 inceptions times out. So we
 * seed with hand-tuned chunk widths that roughly track event density, and
 * bisect only the chunks that actually fail. Seeding matters because every
 * timeout costs a full 55s before we learn anything.
 */

export interface Chunk {
  /** Inclusive start year, signed. */
  from: number;
  /** Exclusive end year, signed. */
  to: number;
}

/** Chunk widths by era, mirroring the density skew toward the present. */
const SEED_SCHEDULE: ReadonlyArray<{ until: number; width: number }> = [
  { until: -1000, width: 500 },
  { until: 0, width: 250 },
  { until: 1500, width: 100 },
  { until: 1800, width: 50 },
  { until: 1900, width: 25 },
  { until: 2100, width: 10 },
];

export function seedChunks(from: number, to: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cursor = from;

  while (cursor < to) {
    const width = SEED_SCHEDULE.find((s) => cursor < s.until)?.width ?? 10;
    const end = Math.min(cursor + width, to);
    chunks.push({ from: cursor, to: end });
    cursor = end;
  }
  return chunks;
}

/** Below this the range can't be bisected further; we accept whatever comes back. */
export const MIN_CHUNK_YEARS = 1;

export function bisect(chunk: Chunk): [Chunk, Chunk] | null {
  const width = chunk.to - chunk.from;
  if (width <= MIN_CHUNK_YEARS) return null;
  const mid = chunk.from + Math.floor(width / 2);
  return [
    { from: chunk.from, to: mid },
    { from: mid, to: chunk.to },
  ];
}

/**
 * Format a signed year as an xsd:dateTime literal.
 * XSD requires at least 4 year digits and zero-padding: year -500 is "-0500".
 */
export function yearLiteral(year: number): string {
  const sign = year < 0 ? '-' : '';
  const digits = String(Math.abs(year)).padStart(4, '0');
  return `${sign}${digits}-01-01T00:00:00Z`;
}

export const describeChunk = (c: Chunk): string => {
  const fmt = (y: number) => (y < 0 ? `${Math.abs(y)}BCE` : String(y));
  return `${fmt(c.from)}..${fmt(c.to)}`;
};
