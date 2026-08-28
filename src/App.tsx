import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { MapView, type MapApi } from './MapView.tsx';
import { DetailPanel, GroupPanel } from './DetailPanel.tsx';
import { Timeline, type TimeWindow } from './Timeline.tsx';
import { useEvents } from './lib/useEvents.ts';
import { useNarratives } from './lib/useNarratives.ts';
import {
  buildNarrativeIndex,
  eventsUnder,
  overlapsWindow,
  type Narrative,
} from './lib/narratives.ts';
import { buildTimeScale } from './lib/timescale.ts';
import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  type Category,
  type HistoryEvent,
} from './types.ts';

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

/**
 * How many stories to draw at once.
 *
 * 159 root narratives overlap the default window; drawing them all would bury
 * the map in overlapping hulls. Showing the most notable handful matches how
 * the event layer already budgets features, and the rest are reachable by
 * entering the story that contains them.
 */
const NARRATIVE_BUDGET = 8;

export function App() {
  const { events, error } = useEvents();
  const narratives = useNarratives();
  /** The story currently entered, or null at the top level. */
  const [story, setStory] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [viewport, setViewport] = useState({ visible: 0, zoom: 1.6, floor: 0 });
  const [window, setWindow] = useState<TimeWindow>(INITIAL_WINDOW);

  const years = useMemo(() => (events ?? []).map((e) => e.s), [events]);
  const scale = useMemo(() => buildTimeScale(years), [years]);

  /**
   * The map's filter + re-index is the expensive part of a scrub, so it runs
   * against a deferred copy of the window. The timeline's own readout, window
   * box, and histogram stay on the immediate value and remain responsive while
   * the map catches up.
   */
  const deferredWindow = useDeferredValue(window);

  // A span event overlaps the window if it starts before the window ends and
  // ends after the window begins. For instant events s === e, so this reduces
  // to a plain containment test.
  const inWindow = useMemo(
    () => (events ?? []).filter((e) => e.s < deferredWindow.to && e.e >= deferredWindow.from),
    [events, deferredWindow],
  );

  const narrativeIndex = useMemo(
    () => buildNarrativeIndex(narratives ?? [], events ?? []),
    [narratives, events],
  );

  const activeStory: Narrative | null =
    story === null ? null : narrativeIndex.byQid.get(story) ?? null;

  /**
   * Stories to draw: the children of whatever we are inside, or the roots at
   * the top level — filtered to the window and capped by notability.
   */
  const visibleNarratives = useMemo(() => {
    const pool = activeStory
      ? narrativeIndex.childrenOf.get(activeStory.q) ?? []
      : narrativeIndex.roots;
    return pool
      .filter((n) => overlapsWindow(n, deferredWindow.from, deferredWindow.to))
      .sort((a, b) => b.r - a.r)
      .slice(0, NARRATIVE_BUDGET);
  }, [activeStory, narrativeIndex, deferredWindow]);

  /**
   * Entering a story narrows the map to its members. Its own events plus
   * everything beneath its sub-stories — the whole subtree, so entering "World
   * War II" shows the Pacific and Eastern Front battles too, not just the
   * events wired directly to the top node.
   */
  const visibleEvents = useMemo(() => {
    if (!activeStory) return inWindow;
    const under = new Set(eventsUnder(narrativeIndex, activeStory.q).map((e) => e.q));
    return inWindow.filter((e) => under.has(e.q));
  }, [activeStory, narrativeIndex, inWindow]);

  const byQid = useMemo(() => new Map(visibleEvents.map((e) => [e.q, e])), [visibleEvents]);

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

  const onViewportChange = useCallback((visible: number, zoom: number, floor: number) => {
    setViewport({ visible, zoom, floor });
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
      <MapView
        events={visibleEvents}
        narratives={visibleNarratives}
        highlightNarrative={story}
        onSelectNarrative={setStory}
        onMapApi={handleMapApi}
        onSelect={selectEvent}
        onSelectGroup={selectGroup}
        onViewportChange={onViewportChange}
      />

      <header className="panel panel--top">
        <h1>History Map</h1>
        {activeStory && (
          <div className="breadcrumb">
            <button onClick={() => setStory(null)}>‹ All stories</button>
            <span className="crumb-name">{activeStory.n}</span>
            {activeStory.d && <span className="muted small crumb-desc">{activeStory.d}</span>}
          </div>
        )}
        <p className="muted small">
          {visibleEvents.length.toLocaleString()}
          {activeStory ? ' events in this story · ' : ' events in window · '}
          {viewport.visible.toLocaleString()} shown · zoom {viewport.zoom.toFixed(1)} ·
          floor {viewport.floor}
        </p>
      </header>

      <Legend events={visibleEvents} />

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

      <Timeline scale={scale} years={years} window={window} onChange={setWindow} />
    </div>
  );
}

function Legend({ events }: { events: HistoryEvent[] }) {
  const counts = useMemo(() => {
    const map = new Map<Category, number>();
    for (const e of events) map.set(e.g, (map.get(e.g) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [events]);

  return (
    <div className="panel panel--legend">
      {counts.map(([category, count]) => (
        <div key={category} className="legend-row">
          <span className="swatch" style={{ background: CATEGORY_COLOR[category] }} />
          <span className="legend-label">{CATEGORY_LABEL[category]}</span>
          <span className="muted">{count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
