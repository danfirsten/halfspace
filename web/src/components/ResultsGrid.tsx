/**
 * The results grid: ranked cards, four across, each animating its own phase.
 *
 * No card fetches anything. Every value on it — the trajectory included — came
 * from the row the search already returned, which is what keeps first paint
 * inside the 300 ms budget for 48 results.
 *
 * `PhaseCard` is exported because a report renders the same card: a phase
 * should look and behave identically whether you found it or saved it, so
 * there is one implementation and the actions along the bottom differ.
 */
import { memo } from 'react';
import type { PhaseRow } from '../duck/types';
import { PathThumbnail } from '../pitch/PathThumbnail';
import { Pitch } from '../pitch/Pitch';
import {
  clock,
  matchStage,
  outcomeBadgeClass,
  outcomeLabel,
  seconds,
  startTypeLabel,
  xg as fmtXg,
} from '../lib/format';

/** One button in a card's bottom row. `active` renders it as pressed. */
export interface CardAction {
  label: string;
  onClick: () => void;
  active?: boolean;
  title?: string;
}

interface Props {
  rows: PhaseRow[];
  onOpen: (phaseId: string) => void;
  onSimilar: (phaseId: string) => void;
  loading?: boolean;
  /** Pin state for the active report, when there is one to pin into. */
  pin?: { isPinned: (phaseId: string) => boolean; onToggle: (phaseId: string) => void };
  /** What the reader can do about an empty result, named for this query. */
  empty?: {
    /** Human text of the predicate most likely to be the culprit. */
    lastFilter: string | null;
    onDropLast: () => void;
    onClearAll: () => void;
  };
}

export function ResultsGrid({ rows, onOpen, onSimilar, loading, pin, empty }: Props) {
  if (loading) return <SkeletonGrid />;

  /**
   * Zero results is the moment an analyst is most likely to give up, so it is
   * the one state that gets a way out rather than a sentence. The filters are
   * ANDed, so the fix is always "ask for less" — and the two ways of asking for
   * less are one click each.
   */
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <h2>No phase in the index matches all of that</h2>
        <p>
          Filters are combined with AND, so every one you add can only ever
          remove phases. Drop one and the search widens.
        </p>
        {empty ? (
          <div className="empty-actions">
            {empty.lastFilter ? (
              <button type="button" className="ghost-btn" onClick={empty.onDropLast}>
                Drop “{empty.lastFilter}”
              </button>
            ) : null}
            <button type="button" className="ghost-btn" onClick={empty.onClearAll}>
              Clear all filters
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid">
      {rows.map((row, i) => {
        const pinned = pin?.isPinned(row.phase_id) ?? false;
        const actions: CardAction[] = [
          { label: 'Similar', onClick: () => onSimilar(row.phase_id), title: 'Find phases like this one' },
        ];
        if (pin) {
          actions.push({
            label: pinned ? 'Pinned' : 'Pin',
            onClick: () => pin.onToggle(row.phase_id),
            active: pinned,
            title: pinned ? 'Remove from the report' : 'Add to the report, with the query that found it',
          });
        }
        return (
          <PhaseCard key={row.phase_id} row={row} rank={i + 1} onOpen={onOpen} actions={actions} />
        );
      })}
    </div>
  );
}

export const PhaseCard = memo(function PhaseCard({
  row,
  rank,
  onOpen,
  actions,
  frozen,
}: {
  row: PhaseRow;
  rank: number;
  onOpen: (phaseId: string) => void;
  actions?: CardAction[];
  /** Print/PDF: draw the phase mid-trajectory instead of animating it. */
  frozen?: boolean;
}) {
  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row.phase_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(row.phase_id);
        }
      }}
      aria-label={`${row.team_name} versus ${row.opponent_name}, ${clock(row.minute, row.second)}, ${outcomeLabel(row.outcome)}`}
    >
      <div className="card-pitch">
        <PathThumbnail
          pathXy={row.path_xy}
          index={rank}
          frozen={frozen}
          startZoneLabel={`${startTypeLabel(row.start_type)} → ${outcomeLabel(row.outcome)}`}
        />
        <span className="card-rank num">{rank}</span>
        {/* Says what the click does. The card itself has always been the
            button; this only makes that visible on hover and focus. */}
        <span className="card-open" aria-hidden="true">
          Watch phase
        </span>
      </div>

      <div className="card-body">
        <div className="card-teams">
          <span>{row.team_name}</span>
          <span className="vs">v</span>
          <span className="opp">{row.opponent_name}</span>
        </div>

        <div className="card-meta">
          {matchStage(row.match_label)} · <span className="num">{clock(row.minute, row.second)}</span>
        </div>

        {/* Two fixed rows, so every card in the grid is exactly as tall as
            every other one whatever the phase happens to contain. */}
        <div className="card-stats">
          <span className={outcomeBadgeClass(row.outcome)}>{outcomeLabel(row.outcome)}</span>
          {row.xg > 0 ? <span className="xg-pill num">{fmtXg(row.xg)} xG</span> : null}
        </div>

        <div className="card-stats card-micro">
          <span className="num">{seconds(row.duration_s)}</span>
          <span className="sep">·</span>
          <span className="num">{row.n_passes} pass</span>
          <span className="sep">·</span>
          <span>{startTypeLabel(row.start_type)}</span>
          <span className="grow" />
          {(actions ?? []).map((action) => (
            <button
              key={action.label}
              type="button"
              className="mini-btn"
              aria-pressed={action.active}
              title={action.title}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});

/**
 * A pinned phase the index does not contain — a report shared from a different
 * build, or a dataset that has moved on. It gets a card of its own rather than
 * vanishing, because a report that silently loses a clip is worse than one that
 * admits it.
 */
export function MissingPhaseCard({
  phaseId,
  onRemove,
}: {
  phaseId: string;
  onRemove?: () => void;
}) {
  return (
    <div className="card card-missing">
      <div className="card-pitch">
        <Pitch lineWidth={0.34} labelSize={2.6} />
      </div>
      <div className="card-body">
        <div className="card-teams">Phase not found</div>
        <div className="card-meta num">{phaseId}</div>
        <div className="card-stats">
          <span className="badge badge-neutral">missing from this index</span>
        </div>
        <div className="card-stats card-micro">
          <span>Pinned against another dataset build.</span>
          <span className="grow" />
          {onRemove ? (
            <button type="button" className="mini-btn" onClick={onRemove}>
              Remove
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The landing skeleton. It draws the real pitch, not a grey box: the pitch is
 * the thing that has to be on screen before DuckDB-WASM is even parsed
 * (CONTRACT §6), so it may as well be the real one.
 *
 * It also reuses the card's own class names rather than approximating them.
 * That is not tidiness — a skeleton that is 54 px shorter than the card it
 * stands in for is a 0.05 layout shift the moment the index lands, and the
 * cheapest way to never have one is to make the placeholder the same shape.
 */
export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="card card-skeleton" aria-hidden="true">
      <div className="card-pitch">
        <Pitch lineWidth={0.34} labelSize={2.6} />
      </div>
      <div className="card-body">
        <div className="card-teams">
          <span className="sk-bar shimmer" style={{ width: '58%' }} />
        </div>
        <div className="card-meta">
          <span className="sk-bar shimmer" style={{ width: '74%' }} />
        </div>
        <div className="card-stats">
          <span className="sk-bar shimmer" style={{ width: '42%' }} />
        </div>
        <div className="card-stats card-micro">
          <span className="sk-bar shimmer" style={{ width: '52%' }} />
        </div>
      </div>
    </div>
  );
}
