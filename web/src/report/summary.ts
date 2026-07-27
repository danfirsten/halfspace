/**
 * The report's summary strip, in SQL.
 *
 * Every number on a report is queried from phases.parquet at read time, in the
 * reader's own browser — nothing is cached into the report and nothing travels
 * in the share link (CONTRACT §9: no fabricated numbers, and §0: no raw-data
 * export). That has a consequence worth stating on the page: a report opened
 * against a newer dataset shows that dataset's numbers, and a pinned phase the
 * index no longer contains is reported missing rather than quietly dropped.
 *
 * Same escaping discipline as `dsl/compile.ts`: ids reach the statement only
 * through `sqlLiteral`.
 */
import { PHASES_TABLE, RESULT_COLUMNS, sqlLiteral } from '../dsl/compile';

/** Shape of the single row `compileSummary` returns. */
export interface SummaryRow {
  n: number;
  goals: number;
  shots: number;
  matches: number;
  teams: number;
  avg_duration_s: number | null;
  /** Mean xG over the phases that actually produced a shot, or null if none. */
  avg_xg: number | null;
  n_with_xg: number;
}

function idList(phaseIds: readonly string[]): string {
  return phaseIds.map((id) => sqlLiteral(id)).join(', ');
}

/**
 * A predicate matching exactly the pinned ids. An empty report has no ids at
 * all, and `IN ()` is a syntax error, so it compiles to FALSE — zero rows,
 * which is the truthful answer.
 */
export function compileIdPredicate(phaseIds: readonly string[]): string {
  if (phaseIds.length === 0) return 'FALSE';
  return `"phase_id" IN (${idList(phaseIds)})`;
}

/**
 * The strip: how many, how many goals, how long on average, and the average xG
 * of the phases that produced a shot.
 *
 * `avg(xg) FILTER (WHERE xg > 0)` is not the same as `avg(xg)` and the
 * difference matters: xg is 0 for every phase without a shot, so the unfiltered
 * mean would read as "these phases average 0.03 xG", which describes the
 * padding rather than the chances. The filtered mean is reported next to the
 * count it was taken over, and is null — shown as "—" — when nothing shot.
 */
export function compileSummary(phaseIds: readonly string[]): string {
  return [
    'SELECT',
    '  count(*) AS n,',
    "  count(*) FILTER (WHERE \"outcome\" = 'goal') AS goals,",
    '  count(*) FILTER (WHERE "n_shots" > 0) AS shots,',
    '  count(DISTINCT "match_id") AS matches,',
    '  count(DISTINCT "team_name") AS teams,',
    '  avg("duration_s") AS avg_duration_s,',
    '  avg("xg") FILTER (WHERE "xg" > 0) AS avg_xg,',
    '  count(*) FILTER (WHERE "xg" > 0) AS n_with_xg',
    `FROM ${PHASES_TABLE}`,
    `WHERE ${compileIdPredicate(phaseIds)}`,
  ].join('\n');
}

/**
 * The rows behind the thumbnails. Same projection the results grid uses, so a
 * report card and a search card are the same card with the same data.
 * Ordering is left to the caller: a report's order is the analyst's order, not
 * the database's.
 */
export function compilePhaseLookup(phaseIds: readonly string[]): string {
  return [
    `SELECT ${RESULT_COLUMNS.map((c) => `"${c}"`).join(', ')}`,
    `FROM ${PHASES_TABLE}`,
    `WHERE ${compileIdPredicate(phaseIds)}`,
  ].join('\n');
}
