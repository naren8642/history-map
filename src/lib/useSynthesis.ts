import { useEffect, useState } from 'react';
import { loadSynthesis, loadSynthesisIndex, type StorySynthesis } from './synthesis.ts';

export type SynthesisState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; synthesis: StorySynthesis };

/**
 * The index is consulted first so a story without an overview resolves to
 * `none` immediately, with no request and no loading flicker — the common case
 * while only the most notable stories have been synthesized.
 */
export function useSynthesis(qid: number | null): SynthesisState {
  const [state, setState] = useState<SynthesisState>({ status: 'none' });

  useEffect(() => {
    if (qid === null) {
      setState({ status: 'none' });
      return;
    }
    let live = true;
    void (async () => {
      const index = await loadSynthesisIndex();
      if (!live) return;
      if (!index.has(qid)) {
        setState({ status: 'none' });
        return;
      }
      setState({ status: 'loading' });
      const synthesis = await loadSynthesis(qid);
      if (!live) return;
      setState(synthesis ? { status: 'ready', synthesis } : { status: 'none' });
    })();
    return () => {
      live = false;
    };
  }, [qid]);

  return state;
}
