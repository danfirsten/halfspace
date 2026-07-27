/**
 * Everything the player needs for one phase: the row, its events, its 360
 * frames, and an honest error when a shard will not load.
 *
 * It was an effect inside App until the report page needed the same thing —
 * a phase opened from a report has to animate exactly as it does from the
 * results grid, including prev/next over the list it was opened from. Rather
 * than two copies of the loading rules, there is one hook and two callers.
 */
import { useEffect, useRef, useState } from 'react';
import type { HalfspaceData } from '../duck/data';
import type { PhaseEventRow, PhaseFrameRow, PhaseRow } from '../duck/types';

export interface PhaseDetail {
  phase: PhaseRow | null;
  events: PhaseEventRow[];
  frames: PhaseFrameRow[];
  loading: boolean;
  /** Set when the phase is unknown to the index, or its match shard failed. */
  error: string | null;
}

const EMPTY: PhaseDetail = { phase: null, events: [], frames: [], loading: false, error: null };

/**
 * @param known lookup for a row already on screen, so opening a card from a
 *        list that already has it costs no query. Read through a ref: the list
 *        changing must not reload an open player.
 */
export function usePhaseDetail(
  data: HalfspaceData | null,
  phaseId: string | null,
  known: (phaseId: string) => PhaseRow | undefined,
): PhaseDetail {
  const [detail, setDetail] = useState<PhaseDetail>(EMPTY);
  const knownRef = useRef(known);
  knownRef.current = known;

  useEffect(() => {
    if (!data || !phaseId) {
      setDetail(EMPTY);
      return;
    }
    let cancelled = false;
    setDetail({ ...EMPTY, loading: true });

    const row = knownRef.current(phaseId);
    (row ? Promise.resolve(row) : data.phaseById(phaseId))
      .then(async (phase) => {
        if (cancelled) return;
        if (!phase) {
          setDetail({
            ...EMPTY,
            error: `Phase ${phaseId} is not in this dataset. It may have been pinned from a different build of the index.`,
          });
          return;
        }
        setDetail({ phase, events: [], frames: [], loading: true, error: null });
        try {
          const [events, frames] = await Promise.all([data.eventsFor(phase), data.framesFor(phase)]);
          if (!cancelled) setDetail({ phase, events, frames, loading: false, error: null });
        } catch (error) {
          // The index knows this phase, but its match shard did not arrive.
          // The header and the ball path from `path_xy` still work, so the
          // player stays open and says what is missing.
          if (!cancelled) {
            setDetail({
              phase,
              events: [],
              frames: [],
              loading: false,
              error: `Could not load the event and 360 data for match ${phase.match_id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetail({
            ...EMPTY,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [data, phaseId]);

  return detail;
}
