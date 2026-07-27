/**
 * Builder ⇄ DSL, bijectively.
 *
 * The visual builder does not own a parallel truth: it *reads* a PhaseQuery and
 * *writes* a PhaseQuery. `toBuilderState(query)` projects the DSL onto the
 * controls, `fromBuilderState(state, query)` folds edits back, and a round trip
 * through both is the identity on anything the builder can express. That is why
 * a chip removed in the header instantly unchecks a box in the builder, and why
 * a query typed in English can be edited by hand without being re-parsed.
 */
import {
  DSL_VERSION,
  fieldSpec,
  LIMIT_DEFAULT,
  type Filter,
  type PhaseFieldName,
  type PhaseQuery,
} from '../dsl/schema';

/** Fields exposed as enum multi-selects. */
export const ENUM_FIELDS: PhaseFieldName[] = [
  'outcome',
  'start_type',
  'start_zone',
  'end_zone',
  'competition',
  'team_name',
];

/** Fields exposed as numeric min/max pairs. */
export const RANGE_FIELDS: PhaseFieldName[] = [
  'duration_s',
  'n_passes',
  'progression_m',
  'xg',
  'pressure_events',
  'direct_speed_m_s',
  'minute',
];

/** Fields exposed as tri-state toggles. */
export const BOOL_FIELDS: PhaseFieldName[] = [
  'high_press_regain',
  'counterattack',
  'switch_of_play',
  'reached_final_third',
  'reached_box',
  'has_360',
];

export interface BuilderState {
  /** field → selected values. Empty means "no constraint". */
  enums: Partial<Record<PhaseFieldName, string[]>>;
  /** field → [min, max]; either end may be null. */
  ranges: Partial<Record<PhaseFieldName, [number | null, number | null]>>;
  /** field → true / false / undefined (no constraint). */
  bools: Partial<Record<PhaseFieldName, boolean>>;
  orderField: PhaseFieldName | null;
  orderDir: 'asc' | 'desc';
  limit: number;
  /**
   * Filters the builder has no control for (phase_id, match_id, period …).
   * Carried through untouched so editing in the builder never silently drops a
   * predicate the natural-language path produced.
   */
  passthrough: Filter[];
}

const isEnumField = (f: PhaseFieldName) => ENUM_FIELDS.includes(f);
const isRangeField = (f: PhaseFieldName) => RANGE_FIELDS.includes(f);
const isBoolField = (f: PhaseFieldName) => BOOL_FIELDS.includes(f);

export function toBuilderState(query: PhaseQuery): BuilderState {
  const state: BuilderState = {
    enums: {},
    ranges: {},
    bools: {},
    orderField: query.order_by?.field ?? null,
    orderDir: query.order_by?.dir ?? 'desc',
    limit: query.limit,
    passthrough: [],
  };

  for (const filter of query.filters) {
    const field = filter.field as PhaseFieldName;

    if (isBoolField(field) && (filter.op === 'eq' || filter.op === 'neq')) {
      const raw = filter.value as boolean;
      state.bools[field] = filter.op === 'eq' ? raw : !raw;
      continue;
    }

    if (isEnumField(field)) {
      if (filter.op === 'eq') {
        state.enums[field] = [filter.value as string];
        continue;
      }
      if (filter.op === 'in') {
        state.enums[field] = [...(filter.value as string[])];
        continue;
      }
    }

    if (isRangeField(field)) {
      const current = state.ranges[field] ?? [null, null];
      if (filter.op === 'gte') {
        state.ranges[field] = [filter.value as number, current[1]];
        continue;
      }
      if (filter.op === 'lte') {
        state.ranges[field] = [current[0], filter.value as number];
        continue;
      }
      if (filter.op === 'between') {
        const [low, high] = filter.value as [number, number];
        state.ranges[field] = [low, high];
        continue;
      }
    }

    state.passthrough.push(filter);
  }

  return state;
}

export function fromBuilderState(state: BuilderState): PhaseQuery {
  const filters: Filter[] = [...state.passthrough];

  for (const field of BOOL_FIELDS) {
    const value = state.bools[field];
    if (value !== undefined) filters.push({ field, op: 'eq', value });
  }

  for (const field of ENUM_FIELDS) {
    const values = state.enums[field];
    if (!values || values.length === 0) continue;
    // One value uses `eq` so the chip reads "Outcome is goal" rather than
    // "Outcome: goal" — same predicate, better English.
    filters.push(
      values.length === 1
        ? { field, op: 'eq', value: values[0] }
        : { field, op: 'in', value: [...values] },
    );
  }

  for (const field of RANGE_FIELDS) {
    const range = state.ranges[field];
    if (!range) continue;
    const [low, high] = range;
    const isInt = fieldSpec(field).kind === 'int';
    const fix = (n: number) => (isInt ? Math.round(n) : n);
    if (low !== null && high !== null) {
      filters.push({ field, op: 'between', value: [fix(low), fix(high)] });
    } else if (low !== null) {
      filters.push({ field, op: 'gte', value: fix(low) });
    } else if (high !== null) {
      filters.push({ field, op: 'lte', value: fix(high) });
    }
  }

  return {
    version: DSL_VERSION,
    filters,
    order_by: state.orderField ? { field: state.orderField, dir: state.orderDir } : null,
    limit: state.limit || LIMIT_DEFAULT,
  };
}

/**
 * Remove one filter by identity, for the chip's × button. Filters are compared
 * structurally because they are plain data and there is no id to hang onto.
 */
export function removeFilter(query: PhaseQuery, index: number): PhaseQuery {
  return { ...query, filters: query.filters.filter((_, i) => i !== index) };
}
