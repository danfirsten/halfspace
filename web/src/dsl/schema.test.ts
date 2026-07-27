import { describe, expect, it } from 'vitest';
import {
  allowedOps,
  LIMIT_DEFAULT,
  parseQuery,
  SORTABLE_FIELDS,
  ZONES,
} from './schema';

const ok = (input: unknown) => {
  const r = parseQuery(input);
  if (!r.ok) throw new Error(`expected valid, got: ${r.issues.map((i) => i.message).join('; ')}`);
  return r.query;
};
const bad = (input: unknown) => {
  const r = parseQuery(input);
  expect(r.ok, `expected invalid: ${JSON.stringify(input)}`).toBe(false);
  return r.ok ? [] : r.issues;
};

describe('PhaseQuery schema', () => {
  it('accepts a minimal query and fills defaults', () => {
    const q = ok({ version: 1, filters: [] });
    expect(q.limit).toBe(LIMIT_DEFAULT);
    expect(q.order_by).toBeNull();
  });

  it('rejects an unknown field', () => {
    const issues = bad({ version: 1, filters: [{ field: 'player_name', op: 'eq', value: 'Kane' }] });
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects an unknown operator', () => {
    bad({ version: 1, filters: [{ field: 'xg', op: 'like', value: 0.1 }] });
  });

  it('rejects extra keys on a filter', () => {
    bad({ version: 1, filters: [{ field: 'xg', op: 'gte', value: 0.1, extra: true }] });
  });

  it('rejects the wrong version', () => {
    bad({ version: 2, filters: [] });
  });

  describe('per-field operator restrictions', () => {
    it('competition allows only eq and in', () => {
      expect([...allowedOps('competition')]).toEqual(['eq', 'in']);
      ok({ version: 1, filters: [{ field: 'competition', op: 'eq', value: 'Euro 2024' }] });
      ok({ version: 1, filters: [{ field: 'competition', op: 'in', value: ['Euro 2020'] }] });
      bad({ version: 1, filters: [{ field: 'competition', op: 'neq', value: 'Euro 2024' }] });
    });

    it('booleans reject ordering operators', () => {
      ok({ version: 1, filters: [{ field: 'counterattack', op: 'eq', value: true }] });
      bad({ version: 1, filters: [{ field: 'counterattack', op: 'gte', value: true }] });
    });

    it('text fields reject range operators', () => {
      bad({ version: 1, filters: [{ field: 'team_name', op: 'between', value: ['A', 'B'] }] });
    });
  });

  describe('value typing', () => {
    it('rejects a string for a numeric field', () => {
      bad({ version: 1, filters: [{ field: 'xg', op: 'gte', value: '0.1' }] });
    });

    it('rejects a boolean for a numeric field', () => {
      bad({ version: 1, filters: [{ field: 'n_passes', op: 'gte', value: true }] });
    });

    it('rejects a float for an integer field', () => {
      bad({ version: 1, filters: [{ field: 'n_passes', op: 'gte', value: 8.5 }] });
      ok({ version: 1, filters: [{ field: 'n_passes', op: 'gte', value: 8 }] });
    });

    it('accepts an integer for a float field', () => {
      ok({ version: 1, filters: [{ field: 'duration_s', op: 'gte', value: 20 }] });
    });

    it('rejects a number for a boolean field', () => {
      bad({ version: 1, filters: [{ field: 'reached_box', op: 'eq', value: 1 }] });
    });

    it('closes the enum on outcome', () => {
      ok({ version: 1, filters: [{ field: 'outcome', op: 'eq', value: 'goal' }] });
      bad({ version: 1, filters: [{ field: 'outcome', op: 'eq', value: 'nearly_a_goal' }] });
    });

    it('closes the enum on zones and knows all nine', () => {
      expect(ZONES).toHaveLength(9);
      ok({ version: 1, filters: [{ field: 'start_zone', op: 'in', value: [...ZONES] }] });
      bad({ version: 1, filters: [{ field: 'start_zone', op: 'eq', value: 'def_third_middle' }] });
    });
  });

  describe('list operators', () => {
    it('in requires a non-empty list', () => {
      bad({ version: 1, filters: [{ field: 'outcome', op: 'in', value: [] }] });
      bad({ version: 1, filters: [{ field: 'outcome', op: 'in', value: 'goal' }] });
    });

    it('between requires exactly two ordered values', () => {
      ok({ version: 1, filters: [{ field: 'duration_s', op: 'between', value: [0, 15] }] });
      bad({ version: 1, filters: [{ field: 'duration_s', op: 'between', value: [0, 15, 30] }] });
      bad({ version: 1, filters: [{ field: 'duration_s', op: 'between', value: [15, 0] }] });
    });

    it('eq rejects a list', () => {
      bad({ version: 1, filters: [{ field: 'xg', op: 'eq', value: [0.1, 0.2] }] });
    });
  });

  describe('order_by', () => {
    it('accepts numeric fields only', () => {
      for (const field of SORTABLE_FIELDS.slice(0, 5)) {
        ok({ version: 1, filters: [], order_by: { field, dir: 'desc' } });
      }
      bad({ version: 1, filters: [], order_by: { field: 'outcome', dir: 'desc' } });
      bad({ version: 1, filters: [], order_by: { field: 'team_name', dir: 'asc' } });
    });

    it('defaults dir to desc and accepts null', () => {
      expect(ok({ version: 1, filters: [], order_by: { field: 'xg' } }).order_by?.dir).toBe('desc');
      expect(ok({ version: 1, filters: [], order_by: null }).order_by).toBeNull();
    });
  });

  describe('limit clamping', () => {
    it('repairs out-of-range limits rather than rejecting them', () => {
      expect(ok({ version: 1, filters: [], limit: 500 }).limit).toBe(96);
      expect(ok({ version: 1, filters: [], limit: 0 }).limit).toBe(1);
      expect(ok({ version: 1, filters: [], limit: -20 }).limit).toBe(1);
      expect(ok({ version: 1, filters: [], limit: 24 }).limit).toBe(24);
    });

    it('still rejects a non-integer limit', () => {
      bad({ version: 1, filters: [], limit: 12.5 });
      bad({ version: 1, filters: [], limit: '48' });
    });
  });
});
