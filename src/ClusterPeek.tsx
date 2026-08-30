import { formatYear, type Category } from './types.ts';

/** How many events the hover card lists before summarising the rest. */
export const PEEK_LIMIT = 7;

/** The slice of an event the probe carries: enough to list, not to hydrate. */
export interface PeekMember {
  q: number;
  n: string;
  g: Category;
  r: number;
  s: number;
  /** First P361 parent story, 0 when the event belongs to none. */
  p1: number;
}

export interface PeekState {
  /** Burning events under the probe, most notable first. */
  members: PeekMember[];
  /** Position in map-container pixels. */
  x: number;
  y: number;
  total: number;
}

interface Props {
  peek: PeekState;
  /** Category hue per the active skin, so the dots match the glow they describe. */
  colors: Record<Category, string>;
  /** Story names by QID; names the thread a dot belongs to. */
  storyNames?: Map<number, string>;
}

/**
 * Passive hover card listing what is burning inside a glow.
 *
 * Deliberately not interactive — `pointer-events: none` in CSS means the card
 * cannot steal the hover it depends on, so there is no flicker and nothing to
 * reach. Clicking the same spot opens the same list as a real panel.
 *
 * The dated rows are the honesty mechanism: a bright blob stops being a
 * mystery number and becomes "what, when, and how much more".
 */
export function GlowPeek({ peek, colors, storyNames }: Props) {
  const shown = peek.members.slice(0, PEEK_LIMIT);
  const remaining = peek.total - shown.length;
  const years = peek.members.map((m) => m.s);
  const lo = Math.min(...years);
  const hi = Math.max(...years);

  return (
    <div className="peek" style={{ left: peek.x, top: peek.y }} role="tooltip">
      <p className="peek-head">
        {peek.total.toLocaleString()} events · {lo === hi ? formatYear(lo) : `${formatYear(lo)}–${formatYear(hi)}`}
      </p>
      <ul className="peek-list">
        {shown.map((m) => {
          const story = m.p1 ? storyNames?.get(m.p1) : undefined;
          return (
            <li key={m.q}>
              <span className="dot" style={{ background: colors[m.g] }} />
              <span className="peek-year">{formatYear(m.s)}</span>
              <span className="peek-name">
                {m.n}
                {story && <span className="peek-story"> · {story}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="peek-more">
        {remaining > 0 ? `+${remaining.toLocaleString()} more in this glow · ` : ''}click to open
      </p>
    </div>
  );
}
