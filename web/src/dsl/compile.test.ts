import { describe, expect, it } from 'vitest';
import {
  compile,
  compileCount,
  compileFilter,
  compileOrderBy,
  describeFilter,
  DslCompileError,
  humanValue,
  sqlLiteral,
} from './compile';
import { PRESETS } from './presets';
import { parseQuery, type Filter, type PhaseQuery } from './schema';

const q = (partial: Partial<PhaseQuery>): PhaseQuery => {
  const r = parseQuery({ version: 1, filters: [], ...partial });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.query;
};

describe('sqlLiteral', () => {
  it('emits booleans and numbers bare', () => {
    expect(sqlLiteral(true)).toBe('TRUE');
    expect(sqlLiteral(false)).toBe('FALSE');
    expect(sqlLiteral(0.1)).toBe('0.1');
    expect(sqlLiteral(-20)).toBe('-20');
  });

  it('quotes strings and doubles embedded single quotes', () => {
    expect(sqlLiteral('Spain')).toBe("'Spain'");
    // No current team name contains an apostrophe, but the compiler must not
    // depend on that: a future dataset with Côte d'Ivoire must not break out.
    expect(sqlLiteral("Côte d'Ivoire")).toBe("'Côte d''Ivoire'");
    expect(sqlLiteral("'; DROP TABLE phases; --")).toBe("'''; DROP TABLE phases; --'");
  });

  it('refuses non-finite numbers', () => {
    expect(() => sqlLiteral(Number.NaN)).toThrow(DslCompileError);
    expect(() => sqlLiteral(Number.POSITIVE_INFINITY)).toThrow(DslCompileError);
  });
});

describe('compileFilter', () => {
  const cases: Array<[Filter, string]> = [
    [{ field: 'high_press_regain', op: 'eq', value: true }, '"high_press_regain" = TRUE'],
    [{ field: 'counterattack', op: 'neq', value: true }, '"counterattack" <> TRUE'],
    [{ field: 'xg', op: 'gte', value: 0.1 }, '"xg" >= 0.1'],
    [{ field: 'duration_s', op: 'lte', value: 15 }, '"duration_s" <= 15'],
    [{ field: 'duration_s', op: 'between', value: [0, 15] }, '"duration_s" BETWEEN 0 AND 15'],
    [{ field: 'team_name', op: 'eq', value: 'Spain' }, `"team_name" = 'Spain'`],
    [
      { field: 'outcome', op: 'in', value: ['goal', 'shot_on_target'] },
      `"outcome" IN ('goal', 'shot_on_target')`,
    ],
    [
      { field: 'start_zone', op: 'in', value: ['def_third_left', 'def_third_centre'] },
      `"start_zone" IN ('def_third_left', 'def_third_centre')`,
    ],
    [{ field: 'competition', op: 'eq', value: 'Euro 2024' }, `"competition" = 'Euro 2024'`],
  ];

  for (const [filter, sql] of cases) {
    it(`${filter.field} ${filter.op}`, () => {
      expect(compileFilter(filter)).toBe(sql);
    });
  }

  it('escapes a team name containing a single quote', () => {
    expect(compileFilter({ field: 'team_name', op: 'eq', value: "O'Brien FC" })).toBe(
      `"team_name" = 'O''Brien FC'`,
    );
  });

  it('refuses an operator the field does not allow', () => {
    expect(() => compileFilter({ field: 'competition', op: 'neq', value: 'Euro 2024' })).toThrow(
      DslCompileError,
    );
  });

  it('refuses an unknown field', () => {
    expect(() =>
      compileFilter({ field: 'player_name', op: 'eq', value: 'x' } as unknown as Filter),
    ).toThrow(DslCompileError);
  });
});

describe('compileOrderBy', () => {
  it('applies the composite default when order_by is null (CONTRACT §3b)', () => {
    expect(compileOrderBy(null)).toBe(
      'ORDER BY "xg" DESC, "progression_m" DESC, "phase_id" ASC',
    );
  });

  it('appends phase_id so ordering is total and reproducible', () => {
    expect(compileOrderBy({ field: 'duration_s', dir: 'desc' })).toBe(
      'ORDER BY "duration_s" DESC, "phase_id" ASC',
    );
    expect(compileOrderBy({ field: 'minute', dir: 'asc' })).toBe(
      'ORDER BY "minute" ASC, "phase_id" ASC',
    );
  });

  it('refuses a non-numeric sort key', () => {
    expect(() => compileOrderBy({ field: 'outcome', dir: 'desc' } as never)).toThrow(
      DslCompileError,
    );
  });
});

describe('compile', () => {
  it('produces the expected statement for a representative query', () => {
    const sql = compile(
      q({
        filters: [
          { field: 'high_press_regain', op: 'eq', value: true },
          { field: 'outcome', op: 'in', value: ['goal', 'shot_on_target', 'shot_off_target'] },
          { field: 'team_name', op: 'eq', value: 'Spain' },
        ],
        order_by: { field: 'xg', dir: 'desc' },
        limit: 24,
      }),
      { columns: ['phase_id', 'xg'] },
    );
    expect(sql).toBe(
      [
        'SELECT "phase_id", "xg"',
        'FROM phases',
        `WHERE "high_press_regain" = TRUE AND "outcome" IN ('goal', 'shot_on_target', 'shot_off_target') AND "team_name" = 'Spain'`,
        'ORDER BY "xg" DESC, "phase_id" ASC',
        'LIMIT 24',
      ].join('\n'),
    );
  });

  it('omits WHERE entirely when there are no filters', () => {
    expect(compile(q({}), { columns: ['phase_id'] })).not.toContain('WHERE');
  });

  it('clamps the limit defensively even if the DSL is bypassed', () => {
    const sql = compile({ version: 1, filters: [], order_by: null, limit: 5000 }, {
      columns: ['phase_id'],
    });
    expect(sql).toContain('LIMIT 96');
  });

  it('appends caller-supplied predicates for find-similar', () => {
    const sql = compile(q({}), {
      columns: ['phase_id'],
      extraWhere: [`"phase_id" <> '3788764-0034'`],
    });
    expect(sql).toContain(`WHERE "phase_id" <> '3788764-0034'`);
  });

  it('compiles every preset', () => {
    for (const preset of PRESETS) {
      const parsed = parseQuery(preset.query);
      expect(parsed.ok, preset.id).toBe(true);
      expect(() => compile(preset.query)).not.toThrow();
    }
  });
});

describe('compileCount', () => {
  it('counts with the same predicates and no ordering', () => {
    const sql = compileCount(q({ filters: [{ field: 'reached_box', op: 'eq', value: true }] }));
    expect(sql).toBe('SELECT count(*) AS n\nFROM phases\nWHERE "reached_box" = TRUE');
  });
});

describe('describeFilter', () => {
  it('renders booleans as plain feature names', () => {
    expect(describeFilter({ field: 'counterattack', op: 'eq', value: true })).toBe('Counterattack');
    expect(describeFilter({ field: 'counterattack', op: 'eq', value: false })).toBe(
      'not counterattack',
    );
  });

  it('renders enums in football English, not snake_case', () => {
    expect(describeFilter({ field: 'start_type', op: 'eq', value: 'goal_kick' })).toBe(
      'Start type is goal kick',
    );
    expect(
      describeFilter({ field: 'outcome', op: 'in', value: ['goal', 'shot_on_target'] }),
    ).toBe('Outcome: goal or shot on target');
    expect(describeFilter({ field: 'start_zone', op: 'eq', value: 'def_third_left' })).toBe(
      'Start zone is left defensive third',
    );
  });

  it('carries units on numeric chips', () => {
    expect(describeFilter({ field: 'duration_s', op: 'gte', value: 20 })).toBe('Duration ≥ 20s');
    expect(describeFilter({ field: 'direct_speed_m_s', op: 'gte', value: 3 })).toBe(
      'Direct speed ≥ 3m/s',
    );
    expect(describeFilter({ field: 'duration_s', op: 'between', value: [0, 15] })).toBe(
      'Duration 0s–15s',
    );
  });
});

describe('humanValue', () => {
  it('names every zone as "<channel> <third>"', () => {
    expect(humanValue('start_zone', 'final_third_centre')).toBe('centre final third');
    expect(humanValue('end_zone', 'mid_third_right')).toBe('right middle third');
  });

  it('leaves values with no mapping untouched', () => {
    expect(humanValue('team_name', 'Spain')).toBe('Spain');
  });
});
