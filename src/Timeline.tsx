import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { densityBins, formatYearShort, type TimeScale } from './lib/timescale.ts';
import type { Narrative } from './lib/narratives.ts';

export interface TimeWindow {
  from: number;
  to: number;
}

interface Props {
  scale: TimeScale;
  /** Every event year in the corpus, for the density histogram. */
  years: readonly number[];
  window: TimeWindow;
  onChange: (window: TimeWindow) => void;
  /** Major stories to draw as spans above the axis. */
  bands?: Narrative[];
  activeBand?: number | null;
  onSelectBand?: (qid: number) => void;
}

const BIN_COUNT = 240;
const MIN_WIDTH_YEARS = 1;
/** Never let the window collapse to an ungrabbable sliver of the axis. */
const MIN_SPAN_FRACTION = 0.004;

/**
 * Minimum axis fraction between two *labelled* ticks. The sqrt weighting makes
 * early eras narrow — 3000-1000 BCE occupies under 1% of the axis — so their
 * labels would overlap into illegibility. Tick lines are always drawn; only the
 * text is thinned.
 */
const MIN_LABEL_GAP = 0.05;

/** Stacked rows available for story bands before they would crowd the axis. */
const BAND_ROWS = 3;

/**
 * Minimum axis fraction before a band's label fits *inside* it.
 *
 * Below this the label sits outside, to the right. Duration and importance are
 * unrelated: World War II occupies six years and renders about 20px wide, while
 * the Middle Ages spans a thousand and renders ten times that. Clipping the
 * label to the band would leave the most significant stories showing a single
 * character, so the band keeps its honest width and the name moves out beside
 * it.
 */
const MIN_BAND_LABEL = 0.045;

/**
 * Width presets lock the window to a fixed span **in years**. Selecting one is
 * a deliberate departure from free mode, so each is togglable back off.
 */
const PRESETS: ReadonlyArray<{ label: string; years: number }> = [
  { label: 'Decade', years: 10 },
  { label: 'Century', years: 100 },
  { label: 'Millennium', years: 1000 },
];

type DragMode = 'move' | 'from' | 'to';

interface DragState {
  mode: DragMode;
  /** Axis fraction where the pointer went down. */
  originFraction: number;
  /** Window at drag start, so every frame is computed from the origin. */
  originWindow: TimeWindow;
  /** The window's axis span at drag start, for free-mode panning. */
  originFromFraction: number;
  originToFraction: number;
}

export function Timeline({
  scale,
  years,
  window: win,
  onChange,
  bands = [],
  activeBand = null,
  onSelectBand,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  /** Pending value for the next frame; scrubbing coalesces to one commit per frame. */
  const pending = useRef<TimeWindow | null>(null);
  const frame = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * null = free mode: the window keeps a constant width **on screen**, so its
   * span in years stretches as it moves into the compressed early eras. That is
   * the point of the sqrt axis — older history is sparser, so covering more
   * years there holds the number of events in view roughly steady.
   *
   * A number = that many years, held constant regardless of where the window
   * sits. Useful when you want strictly comparable slices.
   */
  const [presetYears, setPresetYears] = useState<number | null>(null);

  const bins = useMemo(() => densityBins(years, scale, BIN_COUNT), [years, scale]);
  const maxBin = useMemo(() => Math.max(1, ...bins), [bins]);

  // Decide which ticks get text. Always label the last one so the axis states
  // where it ends, even if that means dropping its neighbour.
  const labelled = useMemo(() => {
    const keep = new Set<number>();
    let last = -Infinity;
    scale.ticks.forEach((t, i) => {
      const isLast = i === scale.ticks.length - 1;
      if (isLast || t.fraction - last >= MIN_LABEL_GAP) {
        keep.add(t.year);
        last = t.fraction;
      }
    });
    const ticks = scale.ticks;
    const penultimate = ticks[ticks.length - 2];
    const final = ticks[ticks.length - 1];
    if (penultimate && final && final.fraction - penultimate.fraction < MIN_LABEL_GAP) {
      keep.delete(penultimate.year);
    }
    return keep;
  }, [scale]);

  const fromFraction = scale.yearToFraction(win.from);
  const toFraction = scale.yearToFraction(win.to);

  /** Clamp a year-space window into the domain, preserving its width. */
  const clampYears = useCallback(
    (w: TimeWindow): TimeWindow => {
      const [lo, hi] = scale.domain;
      let { from, to } = w;
      const width = Math.max(MIN_WIDTH_YEARS, to - from);
      if (from < lo) { from = lo; to = Math.min(hi, lo + width); }
      if (to > hi) { to = hi; from = Math.max(lo, hi - width); }
      return { from: Math.round(from), to: Math.round(to) };
    },
    [scale],
  );

  /** Clamp in axis space, preserving on-screen span, then convert to years. */
  const fromFractionSpan = useCallback(
    (start: number, span: number): TimeWindow => {
      const s = Math.max(MIN_SPAN_FRACTION, Math.min(1, span));
      let f0 = start;
      let f1 = f0 + s;
      if (f0 < 0) { f0 = 0; f1 = s; }
      if (f1 > 1) { f1 = 1; f0 = Math.max(0, 1 - s); }
      const from = scale.fractionToYear(f0);
      const to = scale.fractionToYear(f1);
      return { from, to: Math.max(to, from + MIN_WIDTH_YEARS) };
    },
    [scale],
  );

  /**
   * Commit at most once per animation frame. The map re-clusters on every
   * window change, so an uncoalesced pointermove stream would queue far more
   * work than the display can show.
   */
  const commit = useCallback(
    (next: TimeWindow) => {
      pending.current = next;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (pending.current) onChange(pending.current);
      });
    },
    [onChange],
  );

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const fractionAt = useCallback((clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const onPointerDown = useCallback(
    (mode: DragMode) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Capture keeps the drag alive when the cursor leaves the track, but it
      // throws for a pointer id the browser has no active record of. Losing
      // capture degrades the drag; letting it throw would abort it entirely.
      try {
        (e.target as Element).setPointerCapture(e.pointerId);
      } catch {
        /* proceed without capture */
      }
      // Dragging an edge defines a bespoke width, which is by definition no
      // longer a preset — so this doubles as the way to leave preset mode.
      if (mode !== 'move') setPresetYears(null);
      drag.current = {
        mode,
        originFraction: fractionAt(e.clientX),
        originWindow: win,
        originFromFraction: fromFraction,
        originToFraction: toFraction,
      };
      setDragging(true);
    },
    [fractionAt, win, fromFraction, toFraction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const fraction = fractionAt(e.clientX);
      const { originWindow: origin } = state;
      const delta = fraction - state.originFraction;

      if (state.mode === 'move') {
        if (presetYears === null) {
          // Free mode: pan in axis space, holding the on-screen span fixed. The
          // year span widens automatically as the window enters compressed eras.
          const span = state.originToFraction - state.originFromFraction;
          commit(fromFractionSpan(state.originFromFraction + delta, span));
        } else {
          // Preset mode: hold the span in years. Sliding a 100-year window from
          // 1900 back to 1600 must keep it 100 years, not silently widen.
          const width = origin.to - origin.from;
          const originCentre = scale.yearToFraction((origin.from + origin.to) / 2);
          const centre = scale.fractionToYear(originCentre + delta);
          commit(clampYears({ from: centre - width / 2, to: centre + width / 2 }));
        }
        return;
      }

      const year = scale.fractionToYear(fraction);
      if (state.mode === 'from') {
        commit(clampYears({ from: Math.min(year, origin.to - MIN_WIDTH_YEARS), to: origin.to }));
      } else {
        commit(clampYears({ from: origin.from, to: Math.max(year, origin.from + MIN_WIDTH_YEARS) }));
      }
    },
    [fractionAt, scale, commit, clampYears, fromFractionSpan, presetYears],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
    setDragging(false);
  }, []);

  /** Clicking empty track recentres the window there, keeping its current size. */
  const onTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (drag.current) return;
      const target = fractionAt(e.clientX);
      if (presetYears === null) {
        const span = toFraction - fromFraction;
        onChange(fromFractionSpan(target - span / 2, span));
      } else {
        const centre = scale.fractionToYear(target);
        onChange(clampYears({ from: centre - presetYears / 2, to: centre + presetYears / 2 }));
      }
    },
    [fractionAt, presetYears, toFraction, fromFraction, fromFractionSpan, scale, onChange, clampYears],
  );

  /** Toggle: clicking the active preset returns to free mode. */
  const togglePreset = useCallback(
    (width: number) => {
      if (presetYears === width) {
        setPresetYears(null);
        return;
      }
      setPresetYears(width);
      const centre = (win.from + win.to) / 2;
      onChange(clampYears({ from: centre - width / 2, to: centre + width / 2 }));
    },
    [presetYears, win, onChange, clampYears],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let direction = 0;
      if (e.key === 'ArrowLeft') direction = -1;
      else if (e.key === 'ArrowRight') direction = 1;
      else return;
      e.preventDefault();

      // A quarter-window nudge for fine work; shift jumps a whole window so
      // long sweeps do not need dozens of presses.
      const scaleFactor = e.shiftKey ? 1 : 0.25;

      if (presetYears === null) {
        const span = toFraction - fromFraction;
        onChange(fromFractionSpan(fromFraction + direction * span * scaleFactor, span));
      } else {
        const step = Math.max(1, Math.round(presetYears * scaleFactor)) * direction;
        onChange(clampYears({ from: win.from + step, to: win.to + step }));
      }
    },
    [presetYears, toFraction, fromFraction, fromFractionSpan, win, onChange, clampYears],
  );

  /**
   * Lay bands out in rows, greedily, so overlapping stories do not draw on top
   * of one another. Sorted by rank first, so the most significant story gets
   * the top row and the clearest read.
   */
  const laidOut = useMemo(() => {
    const rowEnds: number[] = [];
    const placed: { n: Narrative; row: number; from: number; to: number }[] = [];
    for (const n of [...bands].sort((a, b) => b.r - a.r)) {
      const from = scale.yearToFraction(n.s);
      const to = scale.yearToFraction(Math.max(n.e, n.s));
      // A band narrower than this is unreadable and unclickable; give it a floor.
      const end = Math.max(to, from + 0.012);
      let row = rowEnds.findIndex((edge) => from > edge + 0.01);
      if (row === -1) {
        if (rowEnds.length >= BAND_ROWS) continue;
        row = rowEnds.length;
      }
      rowEnds[row] = end;
      placed.push({ n, row, from, to: end });
    }
    return placed;
  }, [bands, scale]);

  const widthYears = win.to - win.from;

  return (
    <div className="timeline">
      <div className="timeline-head">
        <span className="timeline-range">
          {formatYearShort(win.from)} — {formatYearShort(win.to)}
        </span>
        <span className="muted small">
          {widthYears.toLocaleString()} years
          {presetYears === null && <span className="mode-hint"> · fixed width, adaptive span</span>}
        </span>
        <span className="timeline-presets">
          <button
            className={presetYears === null ? 'preset preset--on' : 'preset'}
            onClick={() => setPresetYears(null)}
            title="Window keeps a constant width on screen; its span in years adapts to the era"
          >
            Free
          </button>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className={presetYears === p.years ? 'preset preset--on' : 'preset'}
              onClick={() => togglePreset(p.years)}
              title={`Lock the window to ${p.years.toLocaleString()} years (click again to unlock)`}
            >
              {p.label}
            </button>
          ))}
        </span>
      </div>

      {laidOut.length > 0 && (
        <div className="timeline-bands" style={{ height: BAND_ROWS * 17 }}>
          {laidOut.map(({ n, row, from, to }) => (
            <button
              key={n.q}
              className={n.q === activeBand ? 'band band--on' : 'band'}
              style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%`, top: row * 17 }}
              onClick={() => onSelectBand?.(n.q)}
              title={`${formatYearShort(n.s)}–${n.o ? '?' : formatYearShort(n.e)} · ${n.n}`}
            >
              <span className={to - from >= MIN_BAND_LABEL ? 'band-label' : 'band-label band-label--out'}>
                {n.n}
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={trackRef}
        className="timeline-track"
        onClick={onTrackClick}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg className="timeline-density" viewBox={`0 0 ${BIN_COUNT} 100`} preserveAspectRatio="none">
          {bins.map((count, i) => {
            // sqrt again here: a few bins hold orders of magnitude more events
            // than the rest, and a linear bar chart would flatten everything else.
            const h = count === 0 ? 0 : Math.max(2, (Math.sqrt(count) / Math.sqrt(maxBin)) * 100);
            return <rect key={i} x={i} y={100 - h} width={1} height={h} className="density-bar" />;
          })}
        </svg>

        <div className="timeline-ticks">
          {scale.ticks.map((t) => (
            <span key={t.year} className="tick" style={{ left: `${t.fraction * 100}%` }}>
              <span className="tick-line" />
              {labelled.has(t.year) && <span className="tick-label">{t.label}</span>}
            </span>
          ))}
        </div>

        <div
          className={dragging ? 'timeline-window timeline-window--drag' : 'timeline-window'}
          style={{
            left: `${fromFraction * 100}%`,
            width: `${Math.max(0.4, (toFraction - fromFraction) * 100)}%`,
          }}
          onPointerDown={onPointerDown('move')}
          onKeyDown={onKeyDown}
          tabIndex={0}
          role="slider"
          aria-label="Time window"
          aria-valuemin={scale.domain[0]}
          aria-valuemax={scale.domain[1]}
          aria-valuenow={Math.round((win.from + win.to) / 2)}
          aria-valuetext={`${formatYearShort(win.from)} to ${formatYearShort(win.to)}`}
        >
          <span className="handle handle--from" onPointerDown={onPointerDown('from')} />
          <span className="handle handle--to" onPointerDown={onPointerDown('to')} />
        </div>
      </div>
    </div>
  );
}
