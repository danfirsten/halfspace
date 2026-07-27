/**
 * PhaseQuery DSL — Zod mirror of `api/dsl.py` (CONTRACT §3, §3b).
 *
 * This is the only thing that decides whether a query is legal. Presets, the
 * visual builder and both natural-language paths all produce a `PhaseQuery`
 * and it comes through here before it reaches the compiler. Nothing in this
 * file knows about SQL: a hallucinated field name yields a validation error,
 * never a query.
 */
import { z } from 'zod';

export const DSL_VERSION = 1;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 96;
export const LIMIT_DEFAULT = 48;

/** Pitch thirds × channels in the attacking team's frame (CONTRACT §4). */
export const ZONES = [
  'def_third_left',
  'def_third_centre',
  'def_third_right',
  'mid_third_left',
  'mid_third_centre',
  'mid_third_right',
  'final_third_left',
  'final_third_centre',
  'final_third_right',
] as const;

export const START_TYPES = [
  'kick_off',
  'goal_kick',
  'corner',
  'free_kick',
  'throw_in',
  'turnover_open_play',
  'regular',
] as const;

export const OUTCOMES = [
  'goal',
  'shot_on_target',
  'shot_off_target',
  'lost_ball',
  'out_of_play',
  'foul_won',
  'end_of_period',
] as const;

/** Denormalized onto phases.parquet so the index is self-sufficient (§3b). */
export const COMPETITIONS = ['Euro 2020', 'Euro 2024'] as const;

/** Outcomes that mean "the move produced a shot" — used by presets and NL. */
export const SHOT_OUTCOMES = ['goal', 'shot_on_target', 'shot_off_target'] as const;

export const OPS = ['eq', 'neq', 'in', 'gte', 'lte', 'between'] as const;
export type Op = (typeof OPS)[number];

export type FieldKind = 'int' | 'float' | 'bool' | 'enum' | 'text';

export interface FieldSpec {
  kind: FieldKind;
  /** Short label for chips and the builder. */
  label: string;
  /** The football meaning, in one sentence. */
  doc: string;
  values?: readonly string[];
  /** Narrows the kind's default operator set where the contract demands it. */
  ops?: readonly Op[];
  /** Display unit suffix for numeric chips. */
  unit?: string;
  /** Sensible slider/step bounds for the builder, measured from the dataset. */
  range?: { min: number; max: number; step: number };
}

/**
 * Closed enum of `phases.parquet` columns, byte-for-byte the same set as
 * `api/dsl.py::PhaseField`. Adding a column here without adding it there breaks
 * the two-way contract, so both lists are short and deliberate.
 */
export const FIELDS = {
  // identity
  phase_id: { kind: 'text', label: 'Phase id', doc: "Stable phase key, '{match_id}-{seq}'." },
  match_id: { kind: 'int', label: 'Match id', doc: 'StatsBomb match id.' },
  possession: {
    kind: 'int',
    label: 'Possession',
    doc: 'StatsBomb possession number within the match.',
  },
  team_id: { kind: 'int', label: 'Team id', doc: 'Id of the team in possession.' },
  team_name: {
    kind: 'text',
    label: 'Team',
    doc: 'The team in possession for this phase. Opponents are not filterable — the index has no opponent column in the DSL.',
  },
  period: { kind: 'int', label: 'Period', doc: '1 first half, 2 second half, 3/4 extra time.' },
  start_ts: { kind: 'float', label: 'Start (s into period)', doc: 'Seconds into the period when the phase starts.' },
  end_ts: { kind: 'float', label: 'End (s into period)', doc: 'Seconds into the period when the phase ends.' },
  minute: {
    kind: 'int',
    label: 'Minute',
    doc: 'Match minute the phase starts in.',
    range: { min: 0, max: 120, step: 1 },
  },
  competition: {
    kind: 'enum',
    label: 'Competition',
    doc: 'Which tournament the phase was played in.',
    values: COMPETITIONS,
    ops: ['eq', 'in'],
  },
  // features
  start_zone: {
    kind: 'enum',
    label: 'Start zone',
    doc: 'Pitch zone containing the first point of the ball path, in the attacking team’s frame.',
    values: ZONES,
  },
  end_zone: {
    kind: 'enum',
    label: 'End zone',
    doc: 'Pitch zone containing the last point of the ball path, same frame.',
    values: ZONES,
  },
  duration_s: {
    kind: 'float',
    label: 'Duration',
    doc: 'Phase length in seconds, first event to last ball event.',
    unit: 's',
    range: { min: 0, max: 120, step: 0.5 },
  },
  n_passes: {
    kind: 'int',
    label: 'Passes',
    doc: 'Passes attempted by the team in possession.',
    range: { min: 0, max: 65, step: 1 },
  },
  n_events: {
    kind: 'int',
    label: 'Events',
    doc: 'Every event in the chain, both teams.',
    range: { min: 0, max: 250, step: 1 },
  },
  n_players: {
    kind: 'int',
    label: 'Players involved',
    doc: 'Distinct players of the team in possession who touched the phase.',
    range: { min: 0, max: 11, step: 1 },
  },
  start_type: {
    kind: 'enum',
    label: 'Start type',
    doc: 'How the phase began — a restart type, an open-play turnover, or a same-team restart.',
    values: START_TYPES,
  },
  outcome: {
    kind: 'enum',
    label: 'Outcome',
    doc: 'How the phase ended, resolved by precedence.',
    values: OUTCOMES,
  },
  progression_m: {
    kind: 'float',
    label: 'Progression',
    doc: 'Net upfield ball progression in metres. Signed — a move that goes backwards is negative.',
    unit: 'm',
    range: { min: -105, max: 110, step: 1 },
  },
  direct_speed_m_s: {
    kind: 'float',
    label: 'Direct speed',
    doc: 'Upfield progression divided by duration, in metres per second.',
    unit: 'm/s',
    range: { min: -30, max: 40, step: 0.5 },
  },
  pressure_events: {
    kind: 'int',
    label: 'Pressure events',
    doc: 'Opponent Pressure events recorded during the phase.',
    range: { min: 0, max: 16, step: 1 },
  },
  high_press_regain: {
    kind: 'bool',
    label: 'High turnover',
    doc: 'The phase began by winning the ball in the final third, with evidence of pressing.',
  },
  counterattack: {
    kind: 'bool',
    label: 'Counterattack',
    doc: 'A fast, direct break from a turnover in the team’s own half that reached the final third.',
  },
  switch_of_play: {
    kind: 'bool',
    label: 'Switch of play',
    doc: 'The phase contains a pass that moved the ball 40+ yards across the pitch.',
  },
  reached_final_third: {
    kind: 'bool',
    label: 'Reached final third',
    doc: 'The ball path touched x ≥ 80.',
  },
  reached_box: {
    kind: 'bool',
    label: 'Reached the box',
    doc: 'The ball path entered the penalty area (x ≥ 102, 18 ≤ y ≤ 62).',
  },
  xg: {
    kind: 'float',
    label: 'xG',
    doc: 'The best shot in the phase, by StatsBomb expected goals. 0 when there was no shot.',
    range: { min: 0, max: 1, step: 0.01 },
  },
  has_360: {
    kind: 'bool',
    label: 'Has 360 data',
    doc: 'At least one event in the chain carries a 360 freeze frame.',
  },
  frame_coverage: {
    kind: 'float',
    label: '360 coverage',
    doc: 'Fraction of the phase’s events that carry a 360 freeze frame.',
    range: { min: 0, max: 1, step: 0.05 },
  },
} as const satisfies Record<string, FieldSpec>;

export type PhaseFieldName = keyof typeof FIELDS;

export const FIELD_NAMES = Object.keys(FIELDS) as PhaseFieldName[];

const NUMERIC_KINDS: FieldKind[] = ['int', 'float'];

/** Which operators make sense for which kind of column. */
const OPS_BY_KIND: Record<FieldKind, readonly Op[]> = {
  int: ['eq', 'neq', 'in', 'gte', 'lte', 'between'],
  float: ['eq', 'neq', 'in', 'gte', 'lte', 'between'],
  bool: ['eq', 'neq'],
  enum: ['eq', 'neq', 'in'],
  text: ['eq', 'neq', 'in'],
};

export function fieldSpec(field: PhaseFieldName): FieldSpec {
  return FIELDS[field] as FieldSpec;
}

export function allowedOps(field: PhaseFieldName): readonly Op[] {
  const spec = fieldSpec(field);
  return spec.ops ?? OPS_BY_KIND[spec.kind];
}

export function isNumericField(field: PhaseFieldName): boolean {
  return NUMERIC_KINDS.includes(fieldSpec(field).kind);
}

/** Fields the DSL will accept in `order_by` — numeric columns only. */
export const SORTABLE_FIELDS = FIELD_NAMES.filter(isNumericField);

const fieldEnum = z.enum(FIELD_NAMES as [PhaseFieldName, ...PhaseFieldName[]]);
const opEnum = z.enum(OPS);

const scalar = z.union([z.boolean(), z.number(), z.string()]);
export type Scalar = z.infer<typeof scalar>;

/**
 * Why a value is illegal for a field, or null. Mirrors `_scalar_error` in
 * api/dsl.py: booleans are never numbers, enums are closed, and "48" never
 * silently becomes 48 — loose coercion is how a wrong query looks right.
 */
function scalarError(field: PhaseFieldName, value: Scalar): string | null {
  const spec = fieldSpec(field);
  if (spec.kind === 'bool') {
    return typeof value === 'boolean' ? null : `${field} is a boolean field; got ${typeof value}`;
  }
  if (typeof value === 'boolean') return `${field} does not accept booleans`;
  if (spec.kind === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${field} is an integer field; got ${typeof value === 'number' ? value : typeof value}`;
    }
    return null;
  }
  if (spec.kind === 'float') {
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : `${field} is a numeric field; got ${typeof value}`;
  }
  if (typeof value !== 'string') return `${field} is a string field; got ${typeof value}`;
  if (spec.kind === 'enum' && !spec.values!.includes(value)) {
    return `'${value}' is not a valid value for ${field}; allowed: ${spec.values!.join(', ')}`;
  }
  return null;
}

export const filterSchema = z
  .object({
    field: fieldEnum,
    op: opEnum,
    value: z.union([scalar, z.array(scalar)]),
  })
  .strict()
  .superRefine((filter, ctx) => {
    const allowed = allowedOps(filter.field);
    if (!allowed.includes(filter.op)) {
      ctx.addIssue({
        code: 'custom',
        message: `op '${filter.op}' is not supported for ${filter.field} (${
          fieldSpec(filter.field).kind
        }); allowed: ${allowed.join(', ')}`,
      });
      return;
    }

    let items: Scalar[];
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        ctx.addIssue({ code: 'custom', message: "op 'in' requires a non-empty list of values" });
        return;
      }
      items = filter.value;
    } else if (filter.op === 'between') {
      if (!Array.isArray(filter.value) || filter.value.length !== 2) {
        ctx.addIssue({
          code: 'custom',
          message: "op 'between' requires exactly two values [low, high]",
        });
        return;
      }
      items = filter.value;
    } else {
      if (Array.isArray(filter.value)) {
        ctx.addIssue({
          code: 'custom',
          message: `op '${filter.op}' requires a single value, not a list`,
        });
        return;
      }
      items = [filter.value];
    }

    for (const item of items) {
      const err = scalarError(filter.field, item);
      if (err) {
        ctx.addIssue({ code: 'custom', message: err });
        return;
      }
    }

    if (filter.op === 'between') {
      const [low, high] = filter.value as [Scalar, Scalar];
      if (typeof low === 'number' && typeof high === 'number' && low > high) {
        ctx.addIssue({ code: 'custom', message: "op 'between' requires value[0] <= value[1]" });
      }
    }
  });

export type Filter = z.infer<typeof filterSchema>;

export const orderBySchema = z
  .object({
    field: fieldEnum,
    dir: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine((o) => isNumericField(o.field), {
    message: 'order_by must name a numeric field',
  });

export type OrderBy = z.infer<typeof orderBySchema>;

/**
 * Out-of-range limits are repaired, not rejected: a request for 500 results
 * means "lots", and 96 is the most the grid will ever render.
 */
const limitSchema = z
  .number()
  .int()
  .transform((n) => Math.min(Math.max(n, LIMIT_MIN), LIMIT_MAX));

export const phaseQuerySchema = z
  .object({
    version: z.literal(DSL_VERSION).default(DSL_VERSION),
    filters: z.array(filterSchema).default([]),
    order_by: orderBySchema.nullish().transform((v) => v ?? null),
    limit: limitSchema.default(LIMIT_DEFAULT),
  })
  .strict();

export type PhaseQuery = z.infer<typeof phaseQuerySchema>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; query: PhaseQuery }
  | { ok: false; issues: ValidationIssue[] };

/** Validate untrusted DSL (from the API, a deep link, or a preset). */
export function parseQuery(input: unknown): ParseResult {
  const result = phaseQuerySchema.safeParse(input);
  if (result.success) return { ok: true, query: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

export const EMPTY_QUERY: PhaseQuery = {
  version: DSL_VERSION,
  filters: [],
  order_by: null,
  limit: LIMIT_DEFAULT,
};
