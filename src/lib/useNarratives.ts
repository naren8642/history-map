import { useEffect, useState } from 'react';
import type { Narrative } from './narratives.ts';

/**
 * Load the baked narrative layer. Absence is not an error — the app runs as a
 * pure event map when the file is missing, which is what happens before the
 * narrative pass has ever been run.
 */
export function useNarratives(url = `${import.meta.env.BASE_URL}data/narratives.json`): Narrative[] | null {
  const [narratives, setNarratives] = useState<Narrative[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<Narrative[]>) : []))
      .then((list) => {
        if (!cancelled) setNarratives(list);
      })
      .catch(() => {
        if (!cancelled) setNarratives([]);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return narratives;
}
