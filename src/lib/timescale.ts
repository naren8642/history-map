/**
 * Non-linear time scale for the timeline axis.
 *
 * A linear year axis is unusable for this corpus. Measured against the curated
 * dataset, linear allocation hands 49.8% of the screen to 3000–1000 BCE (11
 * events) and 0.5% to 2000–2030 (4,772 events).
 *
 * So screen space is allocated per era in proportion to sqrt(event count).
 * Square root rather than linear, because linear allocation would still crush
 * antiquity into a sliver; and rather than equal-per-era, because that would
 * make the dense modern eras feel absurdly sparse. Sqrt is the compromise that
 * keeps every era reachable while still reflecting where history is recorded.
 *
 * Within an era the mapping is linear, so the whole scale is monotonic and
 * piecewise-linear — cheap to invert, which matters because dragging maps
 * pixels back to years on every frame.
 */

/** Era boundaries. Chosen to track the density skew, not for round numbers. */
const BOUNDARIES: readonly number[] = [
  -3000, -1000, 0, 500, 1000, 1500, 1800, 1900, 1950, 2000, 2030,
];

interface Segment {
  fromYear: number;
  toYear: number;
  /** Cumulative screen fraction at the segment's start and end. */
  fromFraction: number;
  toFraction: number;
}

export interface Tick {
  year: number;
  fraction: number;
  label: string;
}

export interface TimeScale {
  readonly domain: readonly [number, number];
  /** Year -> 0..1 across the axis. Clamped to the domain. */
  yearToFraction(year: number): number;
  /** 0..1 -> year. Clamped to the domain. */
  fractionToYear(fraction: number): number;
  readonly ticks: readonly Tick[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function formatYearShort(year: number): string {
  if (year < 0) return `${Math.abs(year)} BCE`;
  if (year === 0) return '1 BCE';
  return String(year);
}

export function buildTimeScale(years: readonly number[]): TimeScale {
  const domain: [number, number] = [BOUNDARIES[0]!, BOUNDARIES[BOUNDARIES.length - 1]!];

  // Weight each era by sqrt of its population. The +1 keeps an empty era from
  // collapsing to zero width, which would make it unreachable by dragging.
  const weights = BOUNDARIES.slice(0, -1).map((from, i) => {
    const to = BOUNDARIES[i + 1]!;
    const count = years.reduce((n, y) => (y >= from && y < to ? n + 1 : n), 0);
    return Math.sqrt(count + 1);
  });

  const total = weights.reduce((a, b) => a + b, 0);

  const segments: Segment[] = [];
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    const share = weights[i]! / total;
    segments.push({
      fromYear: BOUNDARIES[i]!,
      toYear: BOUNDARIES[i + 1]!,
      fromFraction: cumulative,
      toFraction: cumulative + share,
    });
    cumulative += share;
  }

  const yearToFraction = (year: number): number => {
    const y = clamp(year, domain[0], domain[1]);
    for (const s of segments) {
      if (y >= s.fromYear && y <= s.toYear) {
        const t = (y - s.fromYear) / (s.toYear - s.fromYear);
        return s.fromFraction + t * (s.toFraction - s.fromFraction);
      }
    }
    return y <= domain[0] ? 0 : 1;
  };

  const fractionToYear = (fraction: number): number => {
    const f = clamp(fraction, 0, 1);
    for (const s of segments) {
      if (f >= s.fromFraction && f <= s.toFraction) {
        const t = (f - s.fromFraction) / (s.toFraction - s.fromFraction);
        return Math.round(s.fromYear + t * (s.toYear - s.fromYear));
      }
    }
    return f <= 0 ? domain[0] : domain[1];
  };

  const ticks: Tick[] = BOUNDARIES.map((year) => ({
    year,
    fraction: yearToFraction(year),
    label: formatYearShort(year),
  }));

  return { domain, yearToFraction, fractionToYear, ticks };
}

/**
 * Event density measured in *screen* space rather than year space, so the
 * histogram lines up with the axis it sits behind. Each bin is an equal slice
 * of the axis, however many years that represents.
 */
export function densityBins(
  years: readonly number[],
  scale: TimeScale,
  binCount: number,
): number[] {
  const bins = new Array<number>(binCount).fill(0);
  for (const y of years) {
    const i = Math.min(binCount - 1, Math.floor(scale.yearToFraction(y) * binCount));
    bins[i] = (bins[i] ?? 0) + 1;
  }
  return bins;
}
