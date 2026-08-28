import { CATEGORY_COLOR, type Category } from './types.ts';
import type { PointProps } from './lib/clustering.ts';

/** How many members the hover card lists before summarising the rest. */
export const PEEK_LIMIT = 8;

export interface PeekState {
  /** Cluster members, most notable first. */
  members: PointProps[];
  /** Position in map-container pixels. */
  x: number;
  y: number;
  total: number;
}

interface Props {
  peek: PeekState;
}

/**
 * Passive hover card listing what sits under a cluster.
 *
 * Deliberately not interactive. The first version made its titles clickable,
 * which meant the pointer had to travel an 18px gap of bare map between the
 * cluster and the card before a grace period expired — a race the user had to
 * win to click anything, and often lost. Clicking the cluster opens the same
 * list as a real panel, so the card only ever needed to answer "what is in
 * here?".
 *
 * `pointer-events: none` in CSS is what makes that robust: the card cannot
 * steal the hover it depends on, so there is no flicker and nothing to reach.
 */
export function ClusterPeek({ peek }: Props) {
  const shown = peek.members.slice(0, PEEK_LIMIT);
  const remaining = peek.total - shown.length;

  return (
    <div className="peek" style={{ left: peek.x, top: peek.y }} role="tooltip">
      <ul className="peek-list">
        {shown.map((m) => (
          <li key={m.q}>
            <span className="dot" style={{ background: CATEGORY_COLOR[m.g as Category] }} />
            <span className="peek-name">{m.n}</span>
          </li>
        ))}
      </ul>
      <p className="peek-more">
        {remaining > 0 ? `+${remaining.toLocaleString()} more · ` : ''}click to open
      </p>
    </div>
  );
}
