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
  onSelect: (qid: number) => void;
  onOpenAll: () => void;
  /** Keeps the card alive while the pointer travels into it. */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * Hover card listing what sits under a cluster.
 *
 * Exists so reaching an article does not require zooming in through several
 * levels first. That cost only grows once narratives land, where a story hull
 * can sit three levels above the article you actually want — so this is the
 * peek affordance that layer will reuse.
 */
export function ClusterPeek({ peek, onSelect, onOpenAll, onPointerEnter, onPointerLeave }: Props) {
  const shown = peek.members.slice(0, PEEK_LIMIT);
  const remaining = peek.total - shown.length;

  return (
    <div
      className="peek"
      style={{ left: peek.x, top: peek.y }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      role="tooltip"
    >
      <ul className="peek-list">
        {shown.map((m) => (
          <li key={m.q}>
            <button onClick={() => onSelect(m.q)}>
              <span className="dot" style={{ background: CATEGORY_COLOR[m.g as Category] }} />
              <span className="peek-name">{m.n}</span>
            </button>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <button className="peek-more" onClick={onOpenAll}>
          +{remaining.toLocaleString()} more — show all
        </button>
      )}
    </div>
  );
}
