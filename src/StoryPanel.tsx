/**
 * What a story is, for a reader standing inside it.
 *
 * Built because entering a story previously changed only a breadcrumb. For the
 * 1,265 stories with nothing beneath them — Soviet Union, Ottoman Empire, the
 * Mongol Empire — that meant a click led to a blank map and no explanation.
 * This panel is what those stories have instead of pins.
 *
 * Ordering is deliberate and follows the rule set in PLAN.md §23: **generated
 * prose sits above in reading order and below in visual weight**, so cited
 * material stays primary. The overview is what the reader wants first; the
 * label above it and the sources below it are what keep it honest.
 *
 * The coverage note is not a disclaimer to be skimmed past. It is the only
 * thing standing between a fluent paragraph and the impression that a story
 * with no events on the map is a story we have covered.
 */

import type { Narrative } from './lib/narratives.ts';
import type { SynthesisSource } from './lib/synthesis.ts';
import { useSynthesis } from './lib/useSynthesis.ts';

interface Props {
  story: Narrative;
  /** Route taken to get here, innermost last. A DAG has no single path. */
  trail: Narrative[];
  substories: Narrative[];
  /** Events beneath the whole subtree, already resolved by the caller. */
  eventCount: number;
  onEnter: (qid: number) => void;
  /** Truncate the trail to this depth; 0 leaves all stories. */
  onAscend: (depth: number) => void;
}

const year = (v: number): string => (v < 0 ? `${Math.abs(v)} BCE` : String(v));

function span(n: Narrative): string {
  if (n.o) return `${year(n.s)} – unknown`;
  return n.s === n.e ? year(n.s) : `${year(n.s)} – ${year(n.e)}`;
}

const SOURCE_LABEL: Record<SynthesisSource['via'], string> = {
  wikipedia: 'Wikipedia',
  britannica: 'Britannica',
  retrieved: '',
};

export function StoryPanel({
  story,
  trail,
  substories,
  eventCount,
  onEnter,
  onAscend,
}: Props): React.JSX.Element {
  const state = useSynthesis(story.q);

  return (
    <section className="story" aria-label={`Story: ${story.n}`}>
      <nav className="trail">
        <button onClick={() => onAscend(0)}>All stories</button>
        {trail.slice(0, -1).map((ancestor, i) => (
          <span key={ancestor.q}>
            <span className="trail-sep">›</span>
            <button onClick={() => onAscend(i + 1)}>{ancestor.n}</button>
          </span>
        ))}
      </nav>

      <h2>{story.n}</h2>
      <p className="story-span">{span(story)}</p>
      {story.d && <p className="story-desc">{story.d}</p>}

      {story.via && (
        <p className="muted small story-caveat">
          {story.via === 'coarse'
            ? 'Placed by country — Wikidata records no location for this story.'
            : 'Placed by its capital — Wikidata records no location for this story.'}
        </p>
      )}

      {state.status === 'loading' && (
        <div className="skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <p className="generated-label">
            Overview written by {state.synthesis.model} — not a source
          </p>
          {state.synthesis.overview.split('\n\n').map((para, i) => (
            <p className="generated" key={i}>
              {para}
            </p>
          ))}

          <h3>Why it mattered</h3>
          <p className="generated">{state.synthesis.significance}</p>

          <h3>What this is written from</h3>
          <p className="coverage">{state.synthesis.coverage}</p>

          <h3>Sources</h3>
          <ul className="sources">
            {state.synthesis.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.title}
                </a>
                {SOURCE_LABEL[s.via] && <span className="via"> · {SOURCE_LABEL[s.via]}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {state.status === 'none' && (
        <p className="muted small story-caveat">
          No overview has been written for this story yet.
        </p>
      )}

      <h3>On the map</h3>
      <p className="story-count">
        {eventCount === 0 ? (
          /* The honest form of the blank map. Saying nothing here would leave
             the reader to conclude the story itself is empty. */
          <>
            <strong>No events</strong> in this dataset sit beneath this story, so the map has
            nothing to show for it. That is a gap in our data, not in the history.
          </>
        ) : (
          <>
            <strong>{eventCount.toLocaleString()}</strong>{' '}
            {eventCount === 1 ? 'event' : 'events'} beneath this story
            {substories.length > 0 && `, across ${substories.length} sub-stories`}.
          </>
        )}
      </p>

      {substories.length > 0 && (
        <>
          <h3>Within it</h3>
          <ul className="substories">
            {substories
              .slice()
              .sort((a, b) => b.r - a.r)
              .slice(0, 12)
              .map((child) => (
                <li key={child.q}>
                  <button onClick={() => onEnter(child.q)}>
                    <span className="substory-name">{child.n}</span>
                    <span className="substory-meta">{span(child)}</span>
                  </button>
                </li>
              ))}
          </ul>
          {substories.length > 12 && (
            <p className="muted small">and {substories.length - 12} more</p>
          )}
        </>
      )}
    </section>
  );
}
