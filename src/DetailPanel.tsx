import { useEffect, useRef } from 'react';
import { useSummary } from './lib/useSummary.ts';
import { articleUrl, wikidataUrl } from './lib/summaryClient.ts';
import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  formatEventDate,
  type HistoryEvent,
} from './types.ts';

interface Props {
  event: HistoryEvent;
  /** Set when the panel was reached from a co-located group, enabling "back". */
  onBack?: (() => void) | undefined;
  onClose: () => void;
}

export function DetailPanel({ event, onBack, onClose }: Props) {
  const state = useSummary(event);
  const panel = useRef<HTMLElement | null>(null);

  // Move focus into the panel so keyboard users land on the new content, and
  // so Escape has somewhere to fire from.
  useEffect(() => {
    panel.current?.focus();
  }, [event.q]);

  const url = articleUrl(event);

  return (
    <aside
      ref={panel}
      className="panel panel--detail"
      role="dialog"
      aria-label={event.n}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          (onBack ?? onClose)();
        }
      }}
    >
      <div className="detail-head">
        {onBack && (
          <button className="back" onClick={onBack}>
            ‹ Back
          </button>
        )}
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <p className="eyebrow" style={{ color: CATEGORY_COLOR[event.g] }}>
        {CATEGORY_LABEL[event.g]} · {formatEventDate(event)}
      </p>
      <h2>{event.n}</h2>

      {/* Wikidata's one-line description. Shown for every event that has one,
          and the only prose available for most of the ~40% with no article. */}
      {event.d && <p className="description">{event.d}</p>}

      {state.status === 'loading' && (
        <div className="skeleton" aria-live="polite" aria-label="Loading summary">
          <span /><span /><span />
        </div>
      )}

      {state.status === 'ready' && (
        <>
          {state.summary.img && (
            <img className="thumb" src={state.summary.img} alt="" loading="lazy" />
          )}
          <p className="extract">{state.summary.x}</p>
          {/* Synthesized narrative will render here, visibly labelled and kept
              subordinate to the cited article (roadmap §12). */}
        </>
      )}

      {state.status === 'no-article' && (
        <p className="muted small note">No English Wikipedia article for this event.</p>
      )}

      {state.status === 'unavailable' && (
        <p className="muted small note">
          {state.reason === 'missing'
            ? 'The linked Wikipedia article could not be found — it may have been renamed.'
            : state.reason === 'disambiguation'
              ? 'The link points to a disambiguation page.'
              : 'Could not load the summary.'}
        </p>
      )}

      <div className="detail-links">
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            Read on Wikipedia →
          </a>
        )}
        <a className="secondary" href={wikidataUrl(event.q)} target="_blank" rel="noreferrer">
          Wikidata
        </a>
      </div>

      {/* Wikipedia prose is CC BY-SA; showing it obliges us to say so and link back. */}
      {state.status === 'ready' && url && (
        <p className="licence">
          Summary from <a href={url} target="_blank" rel="noreferrer">Wikipedia</a>, licensed{' '}
          <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">
            CC BY-SA 4.0
          </a>
          .
        </p>
      )}
    </aside>
  );
}

interface GroupProps {
  events: HistoryEvent[];
  /** True when every event shares one exact coordinate, rather than merely being close. */
  sameCoordinate: boolean;
  onPick: (qid: number) => void;
  onClose: () => void;
}

/**
 * Events the map cannot pull apart at any available zoom — either sharing one
 * exact coordinate (a venue or centroid standing in for many happenings) or
 * close enough that they cluster all the way in. Without this they are simply
 * unreachable.
 */
export function GroupPanel({ events, sameCoordinate, onPick, onClose }: GroupProps) {
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const sorted = [...events].sort((a, b) => b.r - a.r || a.s - b.s);

  return (
    <aside
      ref={panel}
      className="panel panel--detail panel--group"
      role="dialog"
      aria-label={`${events.length} events at this location`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="detail-head">
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className="eyebrow">{events.length} events at this location</p>
      <p className="muted small note">
        {sameCoordinate
          ? 'These share one coordinate, so the map cannot separate them.'
          : 'These are too close together for the map to separate at any zoom level.'}
      </p>
      <ul className="group-list">
        {sorted.map((e) => (
          <li key={e.q}>
            <button onClick={() => onPick(e.q)}>
              <span className="dot" style={{ background: CATEGORY_COLOR[e.g] }} />
              <span className="group-name">{e.n}</span>
              <span className="muted small">{formatEventDate(e)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
