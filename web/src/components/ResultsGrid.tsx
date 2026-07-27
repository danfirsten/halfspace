/**
 * The results grid: ranked cards, four across, each animating its own phase.
 *
 * No card fetches anything. Every value on it — the trajectory included — came
 * from the row the search already returned, which is what keeps first paint
 * inside the 300 ms budget for 48 results.
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

interface Props {
  rows: PhaseRow[];
  onOpen: (phaseId: string) => void;
  onSimilar: (phaseId: string) => void;
  /** Rank offset, so a "similar" result set still numbers from 1. */
  loading?: boolean;
}

export function ResultsGrid({ rows, onOpen, onSimilar, loading }: Props) {
  if (loading) return <SkeletonGrid />;

  if (rows.length === 0) {
    return (
      <div className="note-box" style={{ marginBottom: 24 }}>
        <strong>No phases match.</strong> Every filter is conjunctive — try removing a chip.
      </div>
    );
  }

  return (
    <div className="grid">
      {rows.map((row, i) => (
        <ResultCard key={row.phase_id} row={row} rank={i + 1} onOpen={onOpen} onSimilar={onSimilar} />
      ))}
    </div>
  );
}

const ResultCard = memo(function ResultCard({
  row,
  rank,
  onOpen,
  onSimilar,
}: {
  row: PhaseRow;
  rank: number;
  onOpen: (phaseId: string) => void;
  onSimilar: (phaseId: string) => void;
}) {
  return (
    <div className="card-wrap">
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
            startZoneLabel={`${startTypeLabel(row.start_type)} → ${outcomeLabel(row.outcome)}`}
          />
          <span className="card-rank num">{rank}</span>
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

          <div className="card-stats">
            <span className={outcomeBadgeClass(row.outcome)}>{outcomeLabel(row.outcome)}</span>
            {row.xg > 0 ? <span className="xg-pill num">{fmtXg(row.xg)} xG</span> : null}
            <span className="sep">·</span>
            <span className="num">{seconds(row.duration_s)}</span>
            <span className="sep">·</span>
            <span className="num">{row.n_passes} pass</span>
            <span className="sep">·</span>
            <span>{startTypeLabel(row.start_type)}</span>
          </div>
        </div>

        <div className="card-actions">
          <button
            type="button"
            className="mini-btn"
            onClick={(e) => {
              e.stopPropagation();
              onSimilar(row.phase_id);
            }}
          >
            Find similar
          </button>
        </div>
      </div>
    </div>
  );
});

/**
 * The landing skeleton. It draws the real pitch, not a grey box: the pitch is
 * the thing that has to be on screen before DuckDB-WASM is even parsed
 * (CONTRACT §6), so it may as well be the real one.
 */
export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-card" key={i}>
          <div style={{ background: 'var(--turf)', opacity: 0.7 }}>
            <Pitch lineWidth={0.22} labelled={false} />
          </div>
          <div className="skeleton-line shimmer" style={{ width: '58%' }} />
          <div className="skeleton-line shimmer" style={{ width: '38%', height: 7 }} />
          <div className="skeleton-line shimmer" style={{ width: '72%', height: 7, marginBottom: 14 }} />
        </div>
      ))}
    </div>
  );
}
