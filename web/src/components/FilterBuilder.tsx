/**
 * The visual filter builder.
 *
 * Every DSL field the contract exposes has a control here, and each control
 * writes back through `fromBuilderState`, so the builder is never a second
 * source of truth — it is a view of the query, exactly like the chips are.
 */
import { humanValue } from '../dsl/compile';
import {
  fieldSpec,
  LIMIT_MAX,
  LIMIT_MIN,
  SORTABLE_FIELDS,
  type PhaseFieldName,
  type PhaseQuery,
} from '../dsl/schema';
import { CHANNELS, THIRDS, type Zone } from '../dsl/zones';
import {
  BOOL_FIELDS,
  ENUM_FIELDS,
  fromBuilderState,
  RANGE_FIELDS,
  toBuilderState,
  type BuilderState,
} from '../lib/builderState';
import { InfoPopover } from './InfoPopover';

interface Props {
  query: PhaseQuery;
  onChange: (query: PhaseQuery) => void;
  teams: string[];
}

export function FilterBuilder({ query, onChange, teams }: Props) {
  const state = toBuilderState(query);
  const update = (mutate: (draft: BuilderState) => void) => {
    const draft: BuilderState = {
      ...state,
      enums: { ...state.enums },
      ranges: { ...state.ranges },
      bools: { ...state.bools },
    };
    mutate(draft);
    onChange(fromBuilderState(draft));
  };

  const enumValues = (field: PhaseFieldName): readonly string[] =>
    field === 'team_name' ? teams : (fieldSpec(field).values ?? []);

  const toggleEnum = (field: PhaseFieldName, value: string) =>
    update((draft) => {
      const current = draft.enums[field] ?? [];
      draft.enums[field] = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
    });

  const setRange = (field: PhaseFieldName, end: 0 | 1, raw: string) =>
    update((draft) => {
      const current = draft.ranges[field] ?? [null, null];
      const next: [number | null, number | null] = [current[0], current[1]];
      next[end] = raw === '' ? null : Number(raw);
      draft.ranges[field] = next[0] === null && next[1] === null ? undefined : next;
      if (draft.ranges[field] === undefined) delete draft.ranges[field];
    });

  const cycleBool = (field: PhaseFieldName) =>
    update((draft) => {
      // Three states: required → excluded → unconstrained.
      const current = draft.bools[field];
      if (current === undefined) draft.bools[field] = true;
      else if (current === true) draft.bools[field] = false;
      else delete draft.bools[field];
    });

  return (
    <div className="builder" role="region" aria-label="Filter builder">
      {/* ---- feature flags ---- */}
      <div className="builder-group">
        <h3>Phase features</h3>
        <div className="check-list">
          {BOOL_FIELDS.map((field) => {
            const value = state.bools[field];
            return (
              <span key={field} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <button
                  type="button"
                  className="check"
                  aria-pressed={value !== undefined}
                  onClick={() => cycleBool(field)}
                  style={
                    value === false
                      ? { borderColor: '#6b3a34', color: '#f0b3a6', background: 'rgba(160,70,55,0.1)' }
                      : value === true
                        ? { borderColor: 'var(--accent-dim)', color: 'var(--text)', background: 'rgba(63,182,168,0.1)' }
                        : undefined
                  }
                >
                  {value === false ? '−' : value === true ? '✓' : '·'} {fieldSpec(field).label}
                </button>
                <InfoPopover field={field} />
              </span>
            );
          })}
        </div>
        <p style={{ margin: 0, fontSize: 11, color: '#6d7681' }}>
          Click to require, click again to exclude, once more to clear.
        </p>
      </div>

      {/* ---- enums ---- */}
      {ENUM_FIELDS.filter((f) => f !== 'start_zone' && f !== 'end_zone').map((field) => (
        <div className="builder-group" key={field}>
          <h3>
            {fieldSpec(field).label}
            <InfoPopover field={field} />
          </h3>
          <div className="check-list">
            {enumValues(field).map((value) => (
              <label className="check" key={value}>
                <input
                  type="checkbox"
                  checked={(state.enums[field] ?? []).includes(value)}
                  onChange={() => toggleEnum(field, value)}
                />
                {humanValue(field, value)}
              </label>
            ))}
          </div>
        </div>
      ))}

      {/* ---- zones ---- */}
      {(['start_zone', 'end_zone'] as PhaseFieldName[]).map((field) => (
        <div className="builder-group" key={field}>
          <h3>
            {fieldSpec(field).label}
            <InfoPopover field={field} />
          </h3>
          <ZonePicker
            selected={(state.enums[field] ?? []) as Zone[]}
            onToggle={(zone) => toggleEnum(field, zone)}
          />
          <div className="zone-legend">
            <span>own goal</span>
            <span>attacking →</span>
          </div>
        </div>
      ))}

      {/* ---- numeric ranges ---- */}
      <div className="builder-group" style={{ gridColumn: 'span 2', minWidth: 0 }}>
        <h3>Ranges</h3>
        {RANGE_FIELDS.map((field) => {
          const spec = fieldSpec(field);
          const [low, high] = state.ranges[field] ?? [null, null];
          return (
            <div className="range-row" key={field}>
              <label htmlFor={`${field}-min`}>
                {spec.label}
                {spec.unit ? ` (${spec.unit})` : ''}
                <InfoPopover field={field} />
              </label>
              <input
                id={`${field}-min`}
                type="number"
                inputMode="decimal"
                placeholder="min"
                step={spec.range?.step ?? 1}
                value={low ?? ''}
                onChange={(e) => setRange(field, 0, e.target.value)}
              />
              <span className="dash">–</span>
              <input
                type="number"
                inputMode="decimal"
                placeholder="max"
                aria-label={`${spec.label} maximum`}
                step={spec.range?.step ?? 1}
                value={high ?? ''}
                onChange={(e) => setRange(field, 1, e.target.value)}
              />
            </div>
          );
        })}
      </div>

      {/* ---- ordering and limit ---- */}
      <div className="builder-group">
        <h3>Ranking</h3>
        <div className="range-row">
          <label htmlFor="order-field">Order by</label>
          <select
            id="order-field"
            value={state.orderField ?? ''}
            onChange={(e) =>
              update((draft) => {
                draft.orderField = (e.target.value || null) as PhaseFieldName | null;
              })
            }
          >
            <option value="">relevance (xG, then progression)</option>
            {SORTABLE_FIELDS.map((field) => (
              <option key={field} value={field}>
                {fieldSpec(field).label}
              </option>
            ))}
          </select>
        </div>
        <div className="range-row">
          <label htmlFor="order-dir">Direction</label>
          <select
            id="order-dir"
            value={state.orderDir}
            disabled={!state.orderField}
            onChange={(e) =>
              update((draft) => {
                draft.orderDir = e.target.value as 'asc' | 'desc';
              })
            }
          >
            <option value="desc">high → low</option>
            <option value="asc">low → high</option>
          </select>
        </div>
        <div className="range-row">
          <label htmlFor="limit">Results</label>
          <input
            id="limit"
            type="number"
            min={LIMIT_MIN}
            max={LIMIT_MAX}
            step={1}
            value={state.limit}
            onChange={(e) =>
              update((draft) => {
                const n = Number(e.target.value);
                draft.limit = Number.isFinite(n)
                  ? Math.min(Math.max(Math.trunc(n), LIMIT_MIN), LIMIT_MAX)
                  : draft.limit;
              })
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The 3 × 3 zone picker, laid out as the pitch is: defensive third on the left,
 * left channel on top. It is the same partition the ingest used, so what you
 * click is exactly what gets filtered.
 */
function ZonePicker({
  selected,
  onToggle,
}: {
  selected: Zone[];
  onToggle: (zone: Zone) => void;
}) {
  return (
    <div className="zone-grid" role="group" aria-label="Pitch zones">
      {CHANNELS.map((channel) =>
        THIRDS.map((third) => {
          const zone = `${third}_${channel}` as Zone;
          const on = selected.includes(zone);
          return (
            <button
              type="button"
              key={zone}
              className="zone-cell"
              aria-pressed={on}
              aria-label={humanValue('start_zone', zone)}
              onClick={() => onToggle(zone)}
            >
              {channel}
            </button>
          );
        }),
      )}
    </div>
  );
}
