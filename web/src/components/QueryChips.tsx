/**
 * "What it understood" — CONTRACT §3.
 *
 * The active query is always rendered back as chips, and the rendering is
 * identical whether the query came from a preset, the builder, or English. A
 * chip removed here removes the predicate itself, so there is never a gap
 * between what the user reads and what the SQL does.
 */
import { describeFilter, describeOrderBy } from '../dsl/compile';
import type { PhaseQuery } from '../dsl/schema';

interface Props {
  query: PhaseQuery;
  onRemoveFilter: (index: number) => void;
  onClearOrder: () => void;
  /** Set while results are pinned to a "similar to X" search. */
  similarTo?: { phaseId: string; label: string } | null;
  onClearSimilar?: () => void;
}

export function QueryChips({
  query,
  onRemoveFilter,
  onClearOrder,
  similarTo,
  onClearSimilar,
}: Props) {
  const empty = query.filters.length === 0 && !query.order_by && !similarTo;

  // A similarity search is not a filtered search: the vectors are ranked over
  // the whole dataset, so showing the query's chips next to the results would
  // claim a constraint that was not applied. They are held, not shown.
  if (similarTo) {
    return (
      <div className="chip-row">
        <span className="chip-label">Showing</span>
        <span className="chip chip-similar">
          phases similar to {similarTo.label}
          <button type="button" onClick={onClearSimilar} aria-label="Clear similarity search">
            ✕
          </button>
        </span>
        <span className="chip-empty">
          ranked over all 16,782 phases
          {query.filters.length
            ? ` — your ${query.filters.length} filter${query.filters.length === 1 ? ' is' : 's are'} paused until you clear this`
            : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="chip-row">
      <span className="chip-label">Understood as</span>

      {query.filters.map((filter, i) => (
        <span className="chip" key={`${filter.field}-${filter.op}-${i}`}>
          {describeFilter(filter)}
          <button
            type="button"
            onClick={() => onRemoveFilter(i)}
            aria-label={`Remove filter: ${describeFilter(filter)}`}
          >
            ✕
          </button>
        </span>
      ))}

      {query.order_by ? (
        <span className="chip chip-order">
          {describeOrderBy(query.order_by)}
          <button type="button" onClick={onClearOrder} aria-label="Clear sort order">
            ✕
          </button>
        </span>
      ) : null}

      {empty ? (
        <span className="chip-empty">
          no filters — every phase, {describeOrderBy(null)}
        </span>
      ) : null}
    </div>
  );
}
