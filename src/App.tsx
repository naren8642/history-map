import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { MapView, type MapApi } from './MapView.tsx';
import { DetailPanel, GroupPanel } from './DetailPanel.tsx';
import { StoryPanel } from './StoryPanel.tsx';
import { Timeline, type TimeWindow } from './Timeline.tsx';
import { useEvents } from './lib/useEvents.ts';
import { useNarratives } from './lib/useNarratives.ts';
import {
  buildNarrativeIndex,
  eventsUnder,
  overlapsWindow,
  type Narrative,
} from './lib/narratives.ts';
import { buildTimeScale, formatYearShort } from './lib/timescale.ts';
import { SKINS, SKIN_ORDER, type SkinId } from './lib/skins.ts';
import { CATEGORY_LABEL, type Category, type HistoryEvent } from './types.ts';

/**
 * A click resolves to either one event or a stack of co-located ones. Keeping
 * them in a single value means the two panels can never both be open, and
 * "back" from an event to its group is just a state swap.
 */
type Selection =
  | { kind: 'event'; qid: number; from?: number[] }
  | { kind: 'group'; qids: number[] };

/** Opening view: the half-century with the densest, most recognisable coverage. */
const INITIAL_WINDOW: TimeWindow = { from: 1900, to: 1950 };

/** How many stories to draw at once; the rest are reachable by entering one. */
const NARRATIVE_BUDGET = 8;

/**
 * Where a playback sweep begins: the early modern era, not 3000 BCE. Starting
 * a replay at the domain's true edge means minutes of near-empty map before
 * anything ignites — dramatic exactly once, tedious every time after.
 */
const SWEEP_START = 1700;


export function App() {
  const { events, error } = useEvents();
  const narratives = useNarratives();

  const [skinId, setSkinId] = useState<SkinId>('embers');
  const skin = SKINS[skinId];

  // The skin scopes the UI's CSS tokens; see styles.css.
  useEffect(() => {
    document.documentElement.dataset['skin'] = skinId;
  }, [skinId]);

  /**
   * The route into the story layer, outermost first; empty at the top level.
   * A path, not a single id, because containment is a DAG.
   */
  const [trail, setTrail] = useState<number[]>([]);
  const story = trail.length > 0 ? trail[trail.length - 1]! : null;
  const enterStory = useCallback((qid: number | null) => {
    setTrail((current) => {
      if (qid === null) return [];
      const seen = current.indexOf(qid);
      return seen === -1 ? [...current, qid] : current.slice(0, seen + 1);
    });
  }, []);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [window_, setWindow] = useState<TimeWindow>(INITIAL_WINDOW);

  /**
   * Accretion playback. The window's `to` edge is the playhead; `from` trails
   * it as the burn span. During play the whole window advances each frame —
   * the map's paint expressions consume it directly, so this is the only state
   * that moves per frame.
   */
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(15);

  const years = useMemo(() => (events ?? []).map((e) => e.s), [events]);
  const scale = useMemo(() => buildTimeScale(years), [years]);

  const windowRef = useRef(window_);
  windowRef.current = window_;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const end = scale.domain[1];
    // Per-frame commits are affordable because the ember field takes time as
    // a shader uniform; only the debounced heat/label pass touches tiles.
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const w = windowRef.current;
      const span = w.to - w.from;
      const to = w.to + rate * dt;
      if (to >= end) {
        setWindow({ from: end - span, to: end });
        setPlaying(false);
        return;
      }
      setWindow({ from: to - span, to });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, scale]);

  /**
   * The opening: a beat after the data lands, the map starts burning forward
   * from the early modern era on its own. The app does not wait to be asked to
   * be interesting. Any hand on the scrubber (or the pause button) ends it.
   */
  const autoplayed = useRef(false);
  useEffect(() => {
    if (!events || autoplayed.current) return;
    autoplayed.current = true;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setWindow({ from: SWEEP_START, to: SWEEP_START + 50 });
    const t = setTimeout(() => setPlaying(true), 1200);
    return () => clearTimeout(t);
  }, [events]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (p) return false;
      // Playing from the end restarts the sweep rather than doing nothing.
      const w = windowRef.current;
      const end = scale.domain[1];
      if (w.to >= end - 1) {
        const span = w.to - w.from;
        setWindow({ from: SWEEP_START, to: SWEEP_START + span });
      }
      return true;
    });
  }, [scale]);

  // Space plays and pauses, unless focus is somewhere keystrokes mean something.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.getAttribute('role') === 'slider')) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  /** A hand on the scrubber always takes the clock back from the player. */
  const onWindowChange = useCallback((next: TimeWindow) => {
    setPlaying(false);
    setWindow(next);
  }, []);

  /**
   * The burning-set recomputations below are the expensive part of a scrub,
   * so they run against a deferred copy of the window. The timeline and the
   * year readout stay on the immediate value and remain responsive.
   */
  const deferredWindow = useDeferredValue(window_);

  const narrativeIndex = useMemo(
    () => buildNarrativeIndex(narratives ?? [], events ?? []),
    [narratives, events],
  );

  const activeStory: Narrative | null =
    story === null ? null : narrativeIndex.byQid.get(story) ?? null;

  const trailNarratives = useMemo(
    () => trail.map((q) => narrativeIndex.byQid.get(q)).filter((n): n is Narrative => Boolean(n)),
    [trail, narrativeIndex],
  );

  const storyEventCount = useMemo(
    () => (activeStory ? eventsUnder(narrativeIndex, activeStory.q).length : 0),
    [activeStory, narrativeIndex],
  );

  const visibleNarratives = useMemo(() => {
    const pool = activeStory
      ? narrativeIndex.childrenOf.get(activeStory.q) ?? []
      : narrativeIndex.roots;
    return pool
      .filter((n) => overlapsWindow(n, deferredWindow.from, deferredWindow.to))
      .sort((a, b) => b.r - a.r)
      .slice(0, NARRATIVE_BUDGET);
  }, [activeStory, narrativeIndex, deferredWindow]);

  const bandNarratives = useMemo(() => {
    const pool = activeStory
      ? narrativeIndex.childrenOf.get(activeStory.q) ?? []
      : narrativeIndex.roots;
    return pool
      .filter((n) => n.total > 0 || n.e > n.s)
      .sort((a, b) => b.r - a.r)
      .slice(0, 14);
  }, [activeStory, narrativeIndex]);

  /**
   * The map gets the whole story-scoped corpus, *unfiltered by time*. Under
   * the accretion model time is a paint property, not a data property: the
   * source is set once per story change and the clock never rebuilds it.
   */
  const scopedEvents = useMemo(() => {
    if (!activeStory) return events ?? [];
    const under = new Set(eventsUnder(narrativeIndex, activeStory.q).map((e) => e.q));
    return (events ?? []).filter((e) => under.has(e.q));
  }, [activeStory, narrativeIndex, events]);

  /** Events currently burning — inside the window. Drives the census and selection. */
  const burning = useMemo(
    () => scopedEvents.filter((e) => e.s < deferredWindow.to && e.e >= deferredWindow.from),
    [scopedEvents, deferredWindow],
  );

  /** Everything the playhead has passed: burning plus residue. */
  const accretedCount = useMemo(
    () => scopedEvents.reduce((n, e) => (e.s <= deferredWindow.to ? n + 1 : n), 0),
    [scopedEvents, deferredWindow],
  );

  const byQid = useMemo(() => new Map(burning.map((e) => [e.q, e])), [burning]);

  /** Story names by QID, for the peek card's "· World War II" suffix. */
  const storyNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const [q, n] of narrativeIndex.byQid) names.set(q, n.n);
    return names;
  }, [narrativeIndex]);

  const selectedEvent =
    selection?.kind === 'event' ? byQid.get(selection.qid) ?? null : null;
  const groupEvents = useMemo(() => {
    const qids = selection?.kind === 'group' ? selection.qids : selection?.from;
    if (!qids) return null;
    return qids.map((q) => byQid.get(q)).filter((e): e is HistoryEvent => Boolean(e));
  }, [selection, byQid]);

  const selectEvent = useCallback((qid: number | null) => {
    setSelection(qid === null ? null : { kind: 'event', qid });
  }, []);

  const selectGroup = useCallback((qids: number[]) => {
    setSelection({ kind: 'group', qids });
  }, []);

  const mapApi = useRef<MapApi | null>(null);
  const handleMapApi = useCallback((api: MapApi | null) => {
    mapApi.current = api;
  }, []);

  if (error) {
    return (
      <div className="fatal">
        <h1>Could not load events</h1>
        <p>{error}</p>
        <p className="hint">Run <code>npm run data</code> to build the dataset.</p>
      </div>
    );
  }

  if (!events) return <div className="fatal"><p>Loading events…</p></div>;

  return (
    <div className="app">
      {/* The map takes the immediate window: its per-frame cost is a handful of
          paint properties, and routing it through the deferred value let a
          60fps playback starve the deferral until the map ran decades behind
          the clock. The deferred copy still gates the expensive memos above. */}
      <MapView
        key={skinId}
        events={scopedEvents}
        window={window_}
        skin={skin}
        narratives={visibleNarratives}
        storyNames={storyNames}
        highlightNarrative={story}
        onSelectNarrative={enterStory}
        onMapApi={handleMapApi}
        onSelect={selectEvent}
        onSelectGroup={selectGroup}
      />

      <header className={`panel panel--top${activeStory ? ' panel--top--story' : ''}`}>
        <div className="masthead">
          <h1>History Map</h1>
          <span className="skin-switch" role="group" aria-label="Skin">
            {SKIN_ORDER.map((id) => (
              <button
                key={id}
                className={id === skinId ? 'skin-btn skin-btn--on' : 'skin-btn'}
                onClick={() => setSkinId(id)}
              >
                {SKINS[id].label}
              </button>
            ))}
          </span>
        </div>
        <p className="muted small statline">
          {burning.length.toLocaleString()}
          {activeStory ? ' burning in this story' : ' burning'} ·{' '}
          {accretedCount.toLocaleString()} ignited so far
        </p>

        {activeStory && (
          <StoryPanel
            story={activeStory}
            trail={trailNarratives}
            substories={narrativeIndex.childrenOf.get(activeStory.q) ?? []}
            eventCount={storyEventCount}
            onEnter={enterStory}
            onAscend={(depth) => setTrail((current) => current.slice(0, depth))}
          />
        )}
      </header>

      <Legend events={burning} colors={skin.glow} />

      <div className="year-readout" aria-hidden="true">
        <div className="year-big">{formatYearShort(Math.round(window_.to))}</div>
        <div className="year-sub">
          burning <b>{formatYearShort(Math.round(window_.from))} – {formatYearShort(Math.round(window_.to))}</b>
        </div>
      </div>

      {selection?.kind === 'group' && groupEvents && (
        <GroupPanel
          events={groupEvents}
          sameCoordinate={
            groupEvents.length > 1 &&
            groupEvents.every(
              (e) => e.c[0] === groupEvents[0]!.c[0] && e.c[1] === groupEvents[0]!.c[1],
            )
          }
          onPick={(qid) => setSelection({ kind: 'event', qid, from: selection.qids })}
          onZoom={() => mapApi.current?.fitTo(groupEvents.map((e) => e.c))}
          onClose={() => setSelection(null)}
        />
      )}

      {selectedEvent && (
        <DetailPanel
          event={selectedEvent}
          onBack={
            selection?.kind === 'event' && selection.from
              ? () => setSelection({ kind: 'group', qids: selection.from! })
              : undefined
          }
          onClose={() => setSelection(null)}
        />
      )}

      <Timeline
        scale={scale}
        years={years}
        window={window_}
        onChange={onWindowChange}
        playing={playing}
        onTogglePlay={togglePlay}
        rate={rate}
        onRateChange={setRate}
        bands={bandNarratives}
        activeBand={story}
        onSelectBand={(qid) => {
          enterStory(qid);
          const n = narrativeIndex.byQid.get(qid);
          // Bring the window to the story, otherwise selecting a band can
          // leave the map cold because the story lies outside the burn.
          if (n) onWindowChange({ from: n.s, to: Math.max(n.e, n.s + 1) });
        }}
      />
    </div>
  );
}

function Legend({ events, colors }: { events: HistoryEvent[]; colors: Record<Category, string> }) {
  const [open, setOpen] = useState(true);
  const counts = useMemo(() => {
    const map = new Map<Category, number>();
    for (const e of events) map.set(e.g, (map.get(e.g) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [events]);

  // Nothing to say, so say nothing.
  if (counts.length === 0) return null;

  return (
    <div className="panel panel--legend">
      <button
        className="legend-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Collapse the census' : 'Expand the census'}
      >
        Census <span className="legend-chevron">{open ? '−' : '+'}</span>
      </button>
      {open &&
        counts.map(([category, count]) => (
          <div key={category} className="legend-row">
            <span className="swatch" style={{ background: colors[category] }} />
            <span className="legend-label">{CATEGORY_LABEL[category]}</span>
            <span className="muted">{count.toLocaleString()}</span>
          </div>
        ))}
    </div>
  );
}
