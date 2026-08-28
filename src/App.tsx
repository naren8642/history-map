import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { MapView } from './MapView.tsx';
import { DetailPanel, GroupPanel } from './DetailPanel.tsx';
import { Timeline, type TimeWindow } from './Timeline.tsx';
import { useEvents } from './lib/useEvents.ts';
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

export function App() {
  const { events, error } = useEvents();
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

  const byQid = useMemo(() => new Map(inWindow.map((e) => [e.q, e])), [inWindow]);

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
        events={inWindow}
        onSelect={selectEvent}
        onSelectGroup={selectGroup}
        onViewportChange={onViewportChange}
      />

      <header className="panel panel--top">
        <h1>History Map</h1>
        <p className="muted small">
          {inWindow.length.toLocaleString()} events in window ·{' '}
          {viewport.visible.toLocaleString()} shown · zoom {viewport.zoom.toFixed(1)} ·
          floor {viewport.floor}
        </p>
      </header>

      <Legend events={inWindow} />

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
