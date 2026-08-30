import { useEffect, useState } from 'react';
import type { HistoryEvent } from '../types.ts';

export interface EventsState {
  events: HistoryEvent[] | null;
  error: string | null;
}

/**
 * Load the baked dataset. One static file for now; §4 of the plan splits this
 * into time buckets once the timeline exists and the corpus grows.
 */
export function useEvents(url = `${import.meta.env.BASE_URL}data/events.json`): EventsState {
  const [state, setState] = useState<EventsState>({ events: null, error: null });

  useEffect(() => {
    let cancelled = false;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<HistoryEvent[]>;
      })
      .then((events) => {
        if (!cancelled) setState({ events, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ events: null, error: err instanceof Error ? err.message : String(err) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
