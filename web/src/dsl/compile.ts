/**
 * PhaseQuery → SQL. Deterministic, total, and the only place SQL text is
 * produced in the app (CONTRACT §3: "the LLM never writes SQL").
 *
 * Literals are escaped rather than parameterized because DuckDB-WASM's prepared
 * statements are per-connection state and the query text is what we want to be
 * able to show a user verbatim. Every literal goes through `sqlLiteral`, which
 * only ever emits a number, TRUE/FALSE, or a single-quoted string with quotes
 * doubled — the field/op enums are closed, so nothing user-authored reaches the
 * statement uninspected.
 */
import {
  allowedOps,
  fieldSpec,
  FIELDS,
  isNumericField,
  LIMIT_MAX,
  LIMIT_MIN,
  type Filter,
  type PhaseQuery,
  type PhaseFieldName,
  type Scalar,
} from './schema';

/** The registered DuckDB view over phases.parquet. */
export const PHASES_TABLE = 'phases';

/** Columns the results grid needs; everything a card or the player header shows. */
export const RESULT_COLUMNS = [
  'phase_id',
  'match_id',
  'competition',
  'match_label',
  'team_name',
  'opponent_name',
  'period',
  'minute',
  'second',
  'duration_s',
  'n_events',
  'n_passes',
  'n_players',
  'n_shots',
  'start_type',
  'outcome',
  'start_zone',
  'end_zone',
  'progression_m',
  'direct_speed_m_s',
  'pressure_events',
  'high_press_regain',
  'counterattack',
  'switch_of_play',
  'reached_final_third',
  'reached_box',
  'xg',
  'goal_conceded',
  'has_360',
  'frame_coverage',
  'path_xy',
] as const;

export class DslCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DslCompileError';
  }
}

/** A SQL literal for a validated scalar. Strings get their quotes doubled. */
export function sqlLiteral(value: Scalar): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DslCompileError(`non-finite numeric literal: ${value}`);
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** One filter → one boolean SQL expression. */
export function compileFilter(filter: Filter): string {
  const spec = FIELDS[filter.field as PhaseFieldName];
  if (!spec) throw new DslCompileError(`unknown field '${filter.field}'`);
  if (!allowedOps(filter.field).includes(filter.op)) {
    throw new DslCompileError(`op '${filter.op}' is not supported for ${filter.field}`);
  }
  const col = quoteIdent(filter.field);

  switch (filter.op) {
    case 'eq':
      return `${col} = ${sqlLiteral(filter.value as Scalar)}`;
    case 'neq':
      return `${col} <> ${sqlLiteral(filter.value as Scalar)}`;
    case 'gte':
      return `${col} >= ${sqlLiteral(filter.value as Scalar)}`;
    case 'lte':
      return `${col} <= ${sqlLiteral(filter.value as Scalar)}`;
    case 'in': {
      const values = filter.value as Scalar[];
      if (!Array.isArray(values) || values.length === 0) {
        throw new DslCompileError(`op 'in' on ${filter.field} requires a non-empty list`);
      }
      return `${col} IN (${values.map(sqlLiteral).join(', ')})`;
    }
    case 'between': {
      const values = filter.value as Scalar[];
      if (!Array.isArray(values) || values.length !== 2) {
        throw new DslCompileError(`op 'between' on ${filter.field} requires two values`);
      }
      return `${col} BETWEEN ${sqlLiteral(values[0])} AND ${sqlLiteral(values[1])}`;
    }
    default:
      throw new DslCompileError(`unhandled op '${filter.op}'`);
  }
}

/**
 * CONTRACT §3b: `order_by: null` means the compiler applies the composite
 * default — best chance first, then the move that covered the most ground. The
 * DSL itself stays single-key so the builder and the API only ever emit one.
 * `phase_id` is appended everywhere so paging is stable and results are
 * reproducible run to run.
 */
export function compileOrderBy(orderBy: PhaseQuery['order_by']): string {
  if (!orderBy) return 'ORDER BY "xg" DESC, "progression_m" DESC, "phase_id" ASC';
  if (!isNumericField(orderBy.field)) {
    throw new DslCompileError(`cannot order by ${orderBy.field}; order_by must be numeric`);
  }
  const dir = orderBy.dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${quoteIdent(orderBy.field)} ${dir}, "phase_id" ASC`;
}

export interface CompileOptions {
  /** Table or subquery to read from. Defaults to the registered phases view. */
  table?: string;
  /** Columns to project. Defaults to RESULT_COLUMNS. */
  columns?: readonly string[];
  /** Extra WHERE terms, already valid SQL (used by "find similar"). */
  extraWhere?: readonly string[];
}

/** Compile a validated PhaseQuery to a single SELECT statement. */
export function compile(query: PhaseQuery, options: CompileOptions = {}): string {
  const table = options.table ?? PHASES_TABLE;
  const columns = options.columns ?? RESULT_COLUMNS;
  const where = [
    ...query.filters.map(compileFilter),
    ...(options.extraWhere ?? []),
  ];
  const limit = Math.min(Math.max(Math.trunc(query.limit), LIMIT_MIN), LIMIT_MAX);

  const parts = [
    `SELECT ${columns.map(quoteIdent).join(', ')}`,
    `FROM ${table}`,
    ...(where.length ? [`WHERE ${where.join(' AND ')}`] : []),
    compileOrderBy(query.order_by),
    `LIMIT ${limit}`,
  ];
  return parts.join('\n');
}

/** COUNT(*) for the same predicates — the "N phases match" line above the grid. */
export function compileCount(query: PhaseQuery, options: CompileOptions = {}): string {
  const table = options.table ?? PHASES_TABLE;
  const where = [...query.filters.map(compileFilter), ...(options.extraWhere ?? [])];
  return [
    'SELECT count(*) AS n',
    `FROM ${table}`,
    ...(where.length ? [`WHERE ${where.join(' AND ')}`] : []),
  ].join('\n');
}

/**
 * Human-readable rendering of one filter, identical whether the filter came
 * from natural language, a preset or the builder. This is the "what it
 * understood" surface the contract requires (§3), so it must never paraphrase
 * loosely — every chip states the column, the comparison and the value.
 */
export function describeFilter(filter: Filter): string {
  const spec = fieldSpec(filter.field);
  const unit = spec.unit ?? '';
  const fmt = (v: Scalar): string => {
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number') {
      const rounded = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
      return unit ? `${rounded}${unit}` : rounded;
    }
    return humanValue(filter.field, v);
  };

  if (spec.kind === 'bool') {
    const on = filter.op === 'eq' ? filter.value === true : filter.value === false;
    return on ? spec.label : `not ${spec.label.toLowerCase()}`;
  }

  switch (filter.op) {
    case 'eq':
      return `${spec.label} is ${fmt(filter.value as Scalar)}`;
    case 'neq':
      return `${spec.label} is not ${fmt(filter.value as Scalar)}`;
    case 'gte':
      return `${spec.label} ≥ ${fmt(filter.value as Scalar)}`;
    case 'lte':
      return `${spec.label} ≤ ${fmt(filter.value as Scalar)}`;
    case 'in': {
      const values = filter.value as Scalar[];
      return `${spec.label}: ${describeSet(filter.field, values, fmt)}`;
    }
    case 'between': {
      const [low, high] = filter.value as [Scalar, Scalar];
      return `${spec.label} ${fmt(low)}–${fmt(high)}`;
    }
    default:
      return `${spec.label} ${filter.op}`;
  }
}

/**
 * A set of values, written the way a person would say it.
 *
 * Enumerating every member is honest but unreadable: three zones spelled out in
 * full produced the chip "Start zone: left defensive third or centre defensive
 * third or right defensive third", which is 62 characters to say "the
 * defensive third". So a complete third or a complete channel collapses to its
 * own name, and any set beyond three members is counted rather than listed.
 * Nothing here changes what is selected: the builder's checkboxes remain the
 * full, exact list, and the compiled SQL is untouched.
 */
function describeSet(
  field: PhaseFieldName,
  values: Scalar[],
  fmt: (v: Scalar) => string,
): string {
  const parts: string[] = [];
  let rest = values.map(String);

  if (field === 'start_zone' || field === 'end_zone') {
    const take = (names: string[], label: string) => {
      if (names.every((n) => rest.includes(n))) {
        parts.push(label);
        rest = rest.filter((n) => !names.includes(n));
      }
    };
    for (const [third, label] of Object.entries(ZONE_THIRDS)) {
      take(CHANNEL_KEYS.map((c) => `${third}_${c}`), `the ${label}`);
    }
    for (const channel of CHANNEL_KEYS) {
      take(Object.keys(ZONE_THIRDS).map((t) => `${t}_${channel}`), `the ${channel} channel`);
    }
  }

  const listed = [...parts, ...rest.map((v) => fmt(v as Scalar))];
  if (listed.length <= 3) return listed.join(' or ');
  return `${listed.slice(0, 2).join(', ')} +${listed.length - 2} more`;
}

const CHANNEL_KEYS = ['left', 'centre', 'right'] as const;

const ZONE_THIRDS: Record<string, string> = {
  def_third: 'defensive third',
  mid_third: 'middle third',
  final_third: 'final third',
};

/** Enum values are snake_case in the data; nobody says "turnover_open_play". */
export function humanValue(field: PhaseFieldName, value: string): string {
  if (field === 'start_zone' || field === 'end_zone') {
    const cut = value.lastIndexOf('_');
    const third = ZONE_THIRDS[value.slice(0, cut)] ?? value.slice(0, cut);
    return `${value.slice(cut + 1)} ${third}`;
  }
  if (field === 'start_type') {
    return (
      {
        kick_off: 'kick-off',
        goal_kick: 'goal kick',
        corner: 'corner',
        free_kick: 'free kick',
        throw_in: 'throw-in',
        turnover_open_play: 'open-play turnover',
        regular: 'same-team restart',
      }[value] ?? value
    );
  }
  if (field === 'outcome') {
    return (
      {
        goal: 'goal',
        shot_on_target: 'shot on target',
        shot_off_target: 'shot off target',
        lost_ball: 'lost the ball',
        out_of_play: 'out of play',
        foul_won: 'foul won',
        end_of_period: 'end of period',
      }[value] ?? value
    );
  }
  return value;
}

export function describeOrderBy(orderBy: PhaseQuery['order_by']): string {
  if (!orderBy) return 'best chance first';
  const spec = fieldSpec(orderBy.field);
  return `${spec.label} ${orderBy.dir === 'desc' ? 'high → low' : 'low → high'}`;
}
