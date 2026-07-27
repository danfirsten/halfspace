import { describe, expect, it } from 'vitest';
import { compileIdPredicate, compilePhaseLookup, compileSummary } from './summary';
import { PHASES_TABLE, RESULT_COLUMNS } from '../dsl/compile';

const ids = ['3788764-0034', '3788764-0035', '3930162-0001'];

describe('report summary SQL', () => {
  it('compiles one statement over the pinned ids', () => {
    const sql = compileSummary(ids);
    expect(sql).toContain(`FROM ${PHASES_TABLE}`);
    expect(sql).toContain(
      `WHERE "phase_id" IN ('3788764-0034', '3788764-0035', '3930162-0001')`,
    );
    expect(sql.match(/SELECT/g)).toHaveLength(1);
  });

  it('asks for exactly the four headline numbers, plus their context', () => {
    const sql = compileSummary(ids);
    expect(sql).toContain('count(*) AS n');
    expect(sql).toContain(`count(*) FILTER (WHERE "outcome" = 'goal') AS goals`);
    expect(sql).toContain('avg("duration_s") AS avg_duration_s');
    expect(sql).toContain('avg("xg") FILTER (WHERE "xg" > 0) AS avg_xg');
    // The denominator is reported with the average, so the page can say what
    // the mean was taken over instead of implying it covers everything.
    expect(sql).toContain('count(*) FILTER (WHERE "xg" > 0) AS n_with_xg');
  });

  it('never averages xG over phases that produced no shot', () => {
    const sql = compileSummary(ids);
    expect(sql).not.toMatch(/avg\("xg"\)(?! FILTER)/);
  });

  it('escapes ids instead of trusting them', () => {
    const sql = compileSummary(["3788764-0001'; DROP TABLE phases; --"]);
    expect(sql).toContain(`'3788764-0001''; DROP TABLE phases; --'`);
    // One quoted literal, so nothing after the id is executable.
    expect(sql.match(/'/g)!.length % 2).toBe(0);
  });

  it('compiles an empty report to a predicate that matches nothing', () => {
    expect(compileIdPredicate([])).toBe('FALSE');
    expect(compileSummary([])).toContain('WHERE FALSE');
    expect(compilePhaseLookup([])).toContain('WHERE FALSE');
  });

  it('keeps id order out of the predicate — order is the analyst’s, not the database’s', () => {
    expect(compileIdPredicate(['b', 'a'])).toBe(`"phase_id" IN ('b', 'a')`);
    expect(compilePhaseLookup(ids)).not.toContain('ORDER BY');
  });
});

describe('report phase lookup SQL', () => {
  it('projects exactly the columns a result card renders', () => {
    const sql = compilePhaseLookup(ids);
    for (const column of RESULT_COLUMNS) expect(sql).toContain(`"${column}"`);
    expect(sql).toContain('"path_xy"');
    expect(sql).toContain(`FROM ${PHASES_TABLE}`);
  });

  it('has no LIMIT — a report shows every phase it pinned', () => {
    expect(compilePhaseLookup(ids)).not.toContain('LIMIT');
  });
});
