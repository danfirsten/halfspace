import { describe, expect, it } from 'vitest';
import { fromBuilderState, toBuilderState, removeFilter } from './builderState';
import { PRESETS } from '../dsl/presets';
import { parseHeuristic } from '../dsl/heuristic';
import { parseQuery, type PhaseQuery } from '../dsl/schema';

/** Filter order is not semantic (the compiler ANDs them), so compare as sets. */
const canonical = (q: PhaseQuery) => ({
  version: q.version,
  order_by: q.order_by,
  limit: q.limit,
  filters: q.filters
    .map((f) => `${f.field}|${f.op}|${JSON.stringify(f.value)}`)
    .sort(),
});

const roundTrip = (q: PhaseQuery) => fromBuilderState(toBuilderState(q));

describe('builder ⇄ DSL bijectivity', () => {
  it('round-trips every preset unchanged', () => {
    for (const preset of PRESETS) {
      expect(canonical(roundTrip(preset.query)), preset.id).toEqual(canonical(preset.query));
    }
  });

  it('round-trips a query with every control type at once', () => {
    const query: PhaseQuery = {
      version: 1,
      filters: [
        { field: 'counterattack', op: 'eq', value: true },
        { field: 'has_360', op: 'eq', value: false },
        { field: 'outcome', op: 'in', value: ['goal', 'shot_on_target'] },
        { field: 'start_type', op: 'eq', value: 'corner' },
        { field: 'start_zone', op: 'in', value: ['def_third_left', 'def_third_centre'] },
        { field: 'competition', op: 'eq', value: 'Euro 2024' },
        { field: 'team_name', op: 'eq', value: 'Spain' },
        { field: 'duration_s', op: 'between', value: [2, 30] },
        { field: 'n_passes', op: 'gte', value: 8 },
        { field: 'xg', op: 'lte', value: 0.5 },
      ],
      order_by: { field: 'direct_speed_m_s', dir: 'asc' },
      limit: 32,
    };
    expect(canonical(roundTrip(query))).toEqual(canonical(query));
    expect(parseQuery(roundTrip(query)).ok).toBe(true);
  });

  it('round-trips the empty query', () => {
    const empty: PhaseQuery = { version: 1, filters: [], order_by: null, limit: 48 };
    expect(canonical(roundTrip(empty))).toEqual(canonical(empty));
  });

  it('round-trips everything the offline parser can produce', () => {
    const phrases = [
      'high turnovers leading to a shot',
      'counterattacks reaching the box by Spain',
      'goal-kick build-ups to the final third at Euro 2024',
      'switches of play that ended in a shot',
      'long patient possessions under pressure',
      'quick switches starting in the defensive third',
      'top 20 best chances from corners',
      'phases with 12+ passes under 40 seconds',
    ];
    for (const phrase of phrases) {
      const { query } = parseHeuristic(phrase, { teams: ['Spain', 'England'] });
      expect(canonical(roundTrip(query)), phrase).toEqual(canonical(query));
    }
  });

  it('carries filters the builder has no control for straight through', () => {
    const query: PhaseQuery = {
      version: 1,
      // phase_id and period have no widget; they must survive a builder edit.
      filters: [
        { field: 'phase_id', op: 'eq', value: '3788764-0034' },
        { field: 'period', op: 'eq', value: 2 },
        { field: 'reached_box', op: 'eq', value: true },
      ],
      order_by: null,
      limit: 48,
    };
    const state = toBuilderState(query);
    expect(state.passthrough).toHaveLength(2);
    expect(canonical(roundTrip(query))).toEqual(canonical(query));
  });

  it('normalizes a neq on a boolean into the equivalent eq', () => {
    const query: PhaseQuery = {
      version: 1,
      filters: [{ field: 'counterattack', op: 'neq', value: true }],
      order_by: null,
      limit: 48,
    };
    // Not byte-identical, but the same predicate: neq true ≡ eq false.
    expect(roundTrip(query).filters).toEqual([
      { field: 'counterattack', op: 'eq', value: false },
    ]);
  });

  it('projects ranges onto the right control ends', () => {
    const state = toBuilderState({
      version: 1,
      filters: [
        { field: 'duration_s', op: 'gte', value: 5 },
        { field: 'duration_s', op: 'lte', value: 25 },
      ],
      order_by: null,
      limit: 48,
    });
    expect(state.ranges.duration_s).toEqual([5, 25]);
    // Two one-sided filters collapse into one `between` — same rows, one chip.
    expect(fromBuilderState(state).filters).toEqual([
      { field: 'duration_s', op: 'between', value: [5, 25] },
    ]);
  });

  it('rounds values written into integer fields', () => {
    const state = toBuilderState({ version: 1, filters: [], order_by: null, limit: 48 });
    state.ranges.n_passes = [8.4, null];
    expect(fromBuilderState(state).filters).toEqual([
      { field: 'n_passes', op: 'gte', value: 8 },
    ]);
    expect(parseQuery(fromBuilderState(state)).ok).toBe(true);
  });

  it('every state it produces validates against the schema', () => {
    for (const preset of PRESETS) {
      expect(parseQuery(roundTrip(preset.query)).ok, preset.id).toBe(true);
    }
  });
});

describe('removeFilter', () => {
  it('removes exactly one filter by position', () => {
    const query = PRESETS[0].query;
    const next = removeFilter(query, 0);
    expect(next.filters).toHaveLength(query.filters.length - 1);
    expect(next.filters).toEqual(query.filters.slice(1));
  });
});
