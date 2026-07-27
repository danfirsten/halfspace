/**
 * The visual filter builder.
 *
 * Every DSL field the contract exposes has a control here, and each control
 * writes back through `fromBuilderState`, so the builder is never a second
 * source of truth — it is a view of the query, exactly like the chips are.
 *
 * The composition is four explicit columns rather than `auto-fit`, because
 * auto-fit let a 29-item team list set the row height and left 200 px of dead
 * space in three neighbouring columns, and the panel's own `overflow-y` then
 * clipped the ranges and the zone legend below a fold with no scrollbar to say
 * so. Nothing is clipped now: the one genuinely unbounded list (teams) carries
 * its own scroll box and its own filter, and the columns are balanced by hand.
 */
import { Fragment, useMemo, useState } from 'react';
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
  fromBuilderState,
  RANGE_FIELDS,
  toBuilderState,
  type BuilderState,
} from '../lib/builderState';
import { Pitch } from '../pitch/Pitch';
import { InfoPopover } from './InfoPopover';

interface Props {
  query: PhaseQuery;
  onChange: (query: PhaseQuery) => void;
  teams: string[];
  /** Drop every predicate. The chips do this one at a time; this does it once. */
  onClear: () => void;
}

export function FilterBuilder({ query, onChange, teams, onClear }: Props) {
  const state = toBuilderState(query);
  const [teamFilter, setTeamFilter] = useState('');

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

  const selectedTeams = state.enums.team_name ?? [];
  const shownTeams = useMemo(() => {
    const needle = teamFilter.trim().toLowerCase();
    if (!needle) return teams;
    // A selected team stays visible while filtering, so narrowing the list
    // never hides something that is already in the query.
    return teams.filter((t) => t.toLowerCase().includes(needle) || selectedTeams.includes(t));
  }, [teams, teamFilter, selectedTeams]);

  const enumGroup = (field: PhaseFieldName) => (
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
  );

  return (
    <div className="builder" role="region" aria-label="Filter builder">
      <div className="builder-head">
        <h2>Filters</h2>
        <p>Combined with AND. The grid below updates as you change them.</p>
        <span className="grow" />
        <button
          type="button"
          className="ghost-btn"
          onClick={onClear}
          disabled={query.filters.length === 0}
        >
          Clear all
        </button>
      </div>

      <div className="builder-cols">
        {/* ---- features and ranking ---- */}
        <div className="builder-col">
          <div className="builder-group">
            <h3>Phase features</h3>
            <div className="check-list">
              {BOOL_FIELDS.map((field) => {
                const value = state.bools[field];
                const label = fieldSpec(field).label;
                return (
                  <span className="tri" key={field}>
                    <button
                      type="button"
                      className="check tri-btn"
                      data-state={value === true ? 'on' : value === false ? 'off' : 'any'}
                      aria-pressed={value !== undefined}
                      aria-label={
                        value === true
                          ? `${label}: required. Activate to exclude.`
                          : value === false
                            ? `${label}: excluded. Activate to clear.`
                            : `${label}: not filtered. Activate to require.`
                      }
                      onClick={() => cycleBool(field)}
                    >
                      <span className="tri-mark" aria-hidden="true">
                        {value === false ? '−' : value === true ? '✓' : ''}
                      </span>
                      {label}
                    </button>
                    <InfoPopover field={field} />
                  </span>
                );
              })}
            </div>
            <p className="builder-hint">Click to require, again to exclude, once more to clear.</p>
          </div>

          <div className="builder-group">
            <h3>Ranking</h3>
            <div className="field-row">
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
            <div className="field-row">
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
            <div className="field-row">
              <label htmlFor="limit">Results</label>
              <input
                id="limit"
                className="num-input"
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

          {enumGroup('competition')}
        </div>

        {/* ---- enums ---- */}
        <div className="builder-col">
          {(['outcome', 'start_type'] as PhaseFieldName[]).map(enumGroup)}
        </div>

        {/* ---- zones ---- */}
        <div className="builder-col">
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
        </div>

        {/* ---- ranges and teams ---- */}
        <div className="builder-col">
          <div className="builder-group">
            <h3>Ranges</h3>
            {RANGE_FIELDS.map((field) => {
              const spec = fieldSpec(field);
              const [low, high] = state.ranges[field] ?? [null, null];
              return (
                <div className="field-row range-row" key={field}>
                  <label htmlFor={`${field}-min`}>
                    {spec.label}
                    {spec.unit ? <span className="unit"> ({spec.unit})</span> : null}
                    <InfoPopover field={field} />
                  </label>
                  <input
                    id={`${field}-min`}
                    className="num-input"
                    type="number"
                    inputMode="decimal"
                    placeholder="min"
                    step={spec.range?.step ?? 1}
                    value={low ?? ''}
                    onChange={(e) => setRange(field, 0, e.target.value)}
                  />
                  <span className="dash" aria-hidden="true">
                    –
                  </span>
                  <input
                    className="num-input"
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

          <div className="builder-group">
            <h3>
              {fieldSpec('team_name').label}
              <InfoPopover field="team_name" />
              {selectedTeams.length ? (
                <span className="group-count num">{selectedTeams.length}</span>
              ) : null}
            </h3>
            <input
              type="search"
              className="team-filter"
              value={teamFilter}
              placeholder={`Filter ${teams.length} teams…`}
              aria-label="Filter the team list"
              onChange={(e) => setTeamFilter(e.target.value)}
            />
            <div className="check-list check-scroll">
              {shownTeams.map((team) => (
                <label className="check" key={team}>
                  <input
                    type="checkbox"
                    checked={selectedTeams.includes(team)}
                    onChange={() => toggleEnum('team_name', team)}
                  />
                  {team}
                </label>
              ))}
              {shownTeams.length === 0 ? (
                <span className="builder-hint">No team matches “{teamFilter}”.</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const THIRD_SHORT: Record<string, string> = {
  def_third: 'def',
  mid_third: 'mid',
  final_third: 'final',
};
const CHANNEL_SHORT: Record<string, string> = { left: 'L', centre: 'C', right: 'R' };

/**
 * The 3 × 3 zone picker, drawn on the real pitch.
 *
 * The nine cells used to be nine empty rectangles, which in an app whose whole
 * argument is "the pitch is the hero" made the one control about pitch geometry
 * the only place you could not see a pitch. It is the same `Pitch` component
 * the cards and the player draw, with the button grid inset to the touchlines:
 * the SVG carries 4 units of margin around a 120 × 80 field, so the overlay
 * sits at 4/128 and 4/88 and every cell lands exactly on the third and channel
 * boundaries the ingest used.
 */
function ZonePicker({
  selected,
  onToggle,
}: {
  selected: Zone[];
  onToggle: (zone: Zone) => void;
}) {
  return (
    <div className="zone-picker">
      <Pitch lineWidth={0.5} labelSize={3} labelled={false} className="zone-pitch" />
      <div className="zone-grid" role="group" aria-label="Pitch zones">
        {CHANNELS.map((channel) => (
          <Fragment key={channel}>
            {THIRDS.map((third) => {
              const zone = `${third}_${channel}` as Zone;
              return (
                <button
                  type="button"
                  key={zone}
                  className="zone-cell"
                  aria-pressed={selected.includes(zone)}
                  aria-label={humanValue('start_zone', zone)}
                  onClick={() => onToggle(zone)}
                >
                  <span aria-hidden="true">
                    {THIRD_SHORT[third]} {CHANNEL_SHORT[channel]}
                  </span>
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
