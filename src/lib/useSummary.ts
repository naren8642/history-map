import { useEffect, useState } from 'react';
import { fetchLiveSummary, getBakedSummary, type SummaryFailure } from './summaryClient.ts';
import type { BakedSummary } from './summaries.ts';
import type { HistoryEvent } from '../types.ts';

/**
 * Five states, not two.
 *
 * `no-article` is the one that matters: ~40% of the corpus has no English
 * Wikipedia article at all. That is the normal condition for a large minority
 * of events, so it gets its own state and its own copy rather than being
 * rendered as a failure.
 */
export type SummaryState =
  | { status: 'no-article' }
  | { status: 'loading' }
  | { status: 'ready'; summary: BakedSummary; source: 'baked' | 'live' }
  | { status: 'unavailable'; reason: SummaryFailure };

const IDLE: SummaryState = { status: 'no-article' };

export function useSummary(event: HistoryEvent | null): SummaryState {
  const [state, setState] = useState<SummaryState>(IDLE);

  useEffect(() => {
    if (!event) {
      setState(IDLE);
      return;
    }
    if (!event.w) {
      setState({ status: 'no-article' });
      return;
    }

    // Guards against a slower request for a previously-selected pin landing
    // after a newer one and overwriting the panel.
    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      const baked = await getBakedSummary(event.q);
      if (cancelled) return;
      if (baked) {
        setState({ status: 'ready', summary: baked, source: 'baked' });
        return;
      }

      const live = await fetchLiveSummary(event);
      if (cancelled) return;
      setState(
        live.ok
          ? { status: 'ready', summary: live.summary, source: 'live' }
          : { status: 'unavailable', reason: live.reason },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [event]);

  return state;
}
